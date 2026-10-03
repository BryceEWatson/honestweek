// The engine's two opt-in extras for checks that run in the same process: `usage` (each
// model call's token counts, numbers and ids only) and `keepRaw` (raw inputs and full text,
// in memory only, on a non-enumerable field). Both are additive: with them off, a history is
// what it was, and with them on, it serializes the same apart from `usage`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { at, buildCorpus } from './fixtures/replay/corpus.mjs';

const U = 'aaaaaaaa-9999-4999-8999-0000000000a1';
const V = 'aaaaaaaa-9999-4999-8999-0000000000a2';
const W = 'aaaaaaaa-9999-4999-8999-0000000000a3';
const X = '01900000-0000-7000-8000-0000000000c1';
const LONG_SENTINEL = 'RAW-ONLY-TAIL-SENTINEL';
const ERROR_SENTINEL = 'RAW-ERROR-SENTINEL';

let fx;
const WINDOW = { from: '2024-06-10', to: '2024-06-16' };

function claude(sessionId, cwd) {
  const lines = [];
  let n = 0;
  const base = (type, ts, extra) => ({ type, sessionId, cwd, version: '2.1.0', uuid: `${sessionId}-u${++n}`, timestamp: ts, ...extra });
  return {
    lines,
    prompt: (ts, text) => lines.push(JSON.stringify(base('user', ts, { message: { role: 'user', content: text }, origin: { kind: 'human' } }))),
    say: (ts, id, blocks, usage) => lines.push(JSON.stringify(base('assistant', ts, { requestId: `req-${id}`, message: { id, model: 'model-a', role: 'assistant', content: blocks, ...(usage ? { usage } : {}) } }))),
    result: (ts, toolUseId, content, isError = false) => lines.push(JSON.stringify(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } }))),
  };
}
const write = (file, lines) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
};

before(() => {
  fx = buildCorpus();
  // U: one message split over two records (the counts repeat; the largest of each wins), then a
  // second message after a failed tool call.
  const u = claude(U, fx.repo.dir);
  u.prompt(at(300), 'Tidy the widget parser.');
  u.say(at(301), 'msg-u1', [{ type: 'text', text: `Looking now. ${'x'.repeat(900)} ${LONG_SENTINEL}` }], { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 5 });
  u.say(at(301, 50), 'msg-u1', [{ type: 'tool_use', id: 'tu-u1', name: 'Bash', input: { command: 'npm run lint', description: 'Lint' } }], { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 40 });
  u.result(at(302), 'tu-u1', `lint failed: ${ERROR_SENTINEL}`, true);
  u.say(at(303), 'msg-u2', [{ type: 'text', text: 'Fixed it.' }], { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 9 });
  write(join(fx.claudeRoot, 'proj-u', `${U}.jsonl`), u.lines);
  // V: a resumed session that copies U's first records (same record ids and message ids),
  // then makes one call of its own.
  const v = claude(V, fx.repo.dir);
  v.lines.push(...u.lines.slice(0, 3).map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: V })));
  v.prompt(at(400), 'continue');
  v.say(at(401), 'msg-v1', [{ type: 'text', text: 'Carrying on.' }], { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 2100, output_tokens: 3 });
  write(join(fx.claudeRoot, 'proj-u', `${V}.jsonl`), v.lines);
  // W: in the display-role repository.
  const w = claude(W, join(fx.root, 'a-private-project'));
  w.prompt(at(500), 'private work');
  w.say(at(501), 'msg-w1', [{ type: 'tool_use', id: 'tu-w1', name: 'Bash', input: { command: 'ls' } }], { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 });
  write(join(fx.claudeRoot, 'proj-w', `${W}.jsonl`), w.lines);
  // X: a Codex rollout. The second token count repeats the running total (no call); the third
  // has no last_token_usage (the total moves on, no call); the fourth counts reasoning on top.
  const cx = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
  const tc = (ts, total, last) => cx(ts, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total }, ...(last ? { last_token_usage: last } : {}) } });
  write(join(fx.codexRoot, '2024', '06', '12', `rollout-2024-06-12T10-00-00-${X}.jsonl`), [
    cx(at(1500), 'session_meta', { id: X, timestamp: at(1500), cwd: fx.repo.dir, cli_version: '0.1.0', source: 'vscode' }),
    cx(at(1500, 10), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the tests.' }] }),
    cx(at(1501), 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call-x1', input: 'pytest -q' }),
    tc(at(1501, 10), 1000, { input_tokens: 900, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1000 }),
    cx(at(1502), 'response_item', { type: 'custom_tool_call_output', call_id: 'call-x1', output: [{ type: 'input_text', text: 'Exit code: 1\n1 failed' }] }),
    tc(at(1502, 10), 1000, { input_tokens: 900, cached_input_tokens: 600, output_tokens: 100, total_tokens: 1000 }),
    tc(at(1503), 1500, null),
    tc(at(1504), 2700, { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 150, reasoning_output_tokens: 50, total_tokens: 1200 }),
  ]);
});
after(() => rmSync(fx.root, { recursive: true, force: true }));

const build = (opts = {}) => buildWorkHistory({ config: fx.config, roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, ...WINDOW, git: false, ...opts });

test('usage and keepRaw are additive: off, nothing changes; on, only `usage` is new in the JSON', async () => {
  const plain = await build();
  const both = await build({ usage: true, keepRaw: true });
  assert.equal('usage' in plain, false);
  assert.ok(both.usage && Array.isArray(both.usage.calls));
  // The history serializes through its own toJSON; drop `usage` from that and compare.
  const without = (h) => {
    const j = JSON.parse(JSON.stringify(h));
    delete j.usage;
    return JSON.stringify(j);
  };
  assert.equal(without(both), JSON.stringify(plain), 'every other field serializes byte for byte the same');
  // The redacted view of hidden sessions is additive the same way.
  const red = await build({ hiddenSessions: 'redacted' });
  const redBoth = await build({ hiddenSessions: 'redacted', usage: true, keepRaw: true });
  assert.equal(without(redBoth), JSON.stringify(red));
});

test('usage: one call per message, counted once across a resumed copy, numbers and ids only', async () => {
  const h = await build({ usage: true });
  const uKey = h.sessions.find((s) => s.sources.some((k) => h.sources.find((x) => x.key === k && x.records > 0)) && h.events.some((e) => e.session === s.key && e.facts?.text === 'Tidy the widget parser.'))?.key;
  assert.ok(uKey, 'session U is in the history');
  const mine = h.usage.calls.filter((c) => c.session === uKey);
  assert.equal(mine.length, 2, 'the two records of msg-u1 are one call, and msg-u2 another');
  const [first, second] = mine;
  assert.deepEqual([first.input, first.cacheWrite, first.cacheRead, first.output], [10, 2000, 0, 40], 'the largest value of each count wins');
  assert.equal(first.lines.length, 2, 'both records of the message are its lines');
  assert.deepEqual([second.input, second.cacheWrite, second.cacheRead, second.output], [3, 100, 2000, 9]);
  assert.equal(first.agent, `${first.source}:main`);
  // V copied msg-u1: it stays counted once, in U's file, which ends first.
  const vCalls = h.usage.calls.filter((c) => c.session !== uKey && c.tool === 'claude-code' && c.cacheRead === 2100);
  assert.equal(vCalls.length, 1, "V's own call is counted");
  assert.equal(h.usage.calls.filter((c) => c.cacheWrite === 2000).length, 1, 'the copied message is counted once');
  for (const c of h.usage.calls) {
    assert.deepEqual(Object.keys(c).sort(), ['agent', 'cacheRead', 'cacheWrite', 'input', 'lines', 'output', 'session', 'source', 't', 'tool']);
    for (const k of ['input', 'cacheWrite', 'cacheRead', 'output', 't']) assert.ok(Number.isFinite(c[k]), k);
    assert.ok(c.lines.every(Number.isInteger));
  }
  assert.doesNotMatch(JSON.stringify(h.usage), /msg-|req-/, "the harness's message ids never leave the engine");
});

test('usage: a Codex call is a token count whose running total went up; reasoning counted on top joins output', async () => {
  const h = await build({ usage: true });
  const codex = h.usage.calls.filter((c) => c.tool === 'codex' && c.t >= Date.parse(at(1500)));
  assert.equal(codex.length, 2, 'a repeated total and a count with no last_token_usage are not calls');
  assert.deepEqual([codex[0].input, codex[0].cacheRead, codex[0].cacheWrite, codex[0].output], [300, 600, 0, 100]);
  assert.deepEqual([codex[1].input, codex[1].cacheRead, codex[1].output], [100, 900, 200]);
});

test('usage: a skeleton session records none; the redacted view of hidden sessions records them, numbers only', async () => {
  const skeleton = await build({ usage: true });
  const display = (h) => h.sessions.filter((s) => s.repoRole === 'display').map((s) => s.key);
  assert.ok(display(skeleton).length >= 1);
  assert.equal(skeleton.usage.calls.filter((c) => display(skeleton).includes(c.session)).length, 0);
  const shown = await build({ usage: true, hiddenSessions: 'redacted' });
  assert.ok(shown.usage.calls.some((c) => display(shown).includes(c.session)));
});

test('keepRaw: raw inputs, full text and error text sit on a non-enumerable field, never in JSON', async () => {
  const h = await build({ keepRaw: true });
  const lint = h.events.find((e) => e.kind === 'action' && e._raw?.input?.command === 'npm run lint');
  assert.ok(lint, 'the call keeps its raw input');
  assert.equal(lint._raw.tool, 'Bash');
  assert.match(lint._raw.error, new RegExp(ERROR_SENTINEL), 'a failed call keeps the start of its error text');
  assert.ok(!Object.keys(lint).includes('_raw'));
  assert.equal({ ...lint }._raw, undefined, 'a spread leaves it out');
  const msg = h.events.find((e) => e.kind === 'message' && e._raw?.text?.endsWith(LONG_SENTINEL));
  assert.ok(msg, 'a message keeps its full text');
  assert.ok(!String(msg.facts.text).includes(LONG_SENTINEL), 'the kept copy is cut short');
  const prompt = h.events.find((e) => e.kind === 'prompt' && e._raw?.text === 'Tidy the widget parser.');
  assert.ok(prompt);
  const codexCall = h.events.find((e) => e.kind === 'action' && e._raw?.input?.input === 'pytest -q');
  assert.ok(codexCall, "a Codex custom tool's raw input is kept");
  assert.match(codexCall._raw.error ?? '', /1 failed/);
  const text = JSON.stringify(h);
  for (const s of [LONG_SENTINEL, ERROR_SENTINEL, '"_raw"']) assert.ok(!text.includes(s), `JSON holds no ${s}`);
  // Skeleton sessions never get raw text, and a history without the option has none.
  for (const e of h.events.filter((x) => h.sessions.find((s) => s.key === x.session)?.private)) assert.equal(e._raw, undefined);
  const plain = await build();
  assert.ok(plain.events.every((e) => e._raw === undefined));
});
