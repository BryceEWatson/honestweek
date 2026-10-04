// The engine's two opt-in extras for checks that run in the same process: `usage` (each
// model call's token counts, numbers and ids only) and `keepRaw` (raw inputs and full text,
// in memory only, on a non-enumerable field). Both are additive: with them off, a history is
// what it was, and with them on, it serializes the same apart from `usage`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { RAW_ERROR_MAX } from '../lib/replay/parse-common.mjs';
import { removeTempDir } from './helpers/temp-dir.mjs';
import { at, buildCorpus } from './fixtures/replay/corpus.mjs';

const U = 'aaaaaaaa-9999-4999-8999-0000000000a1';
const V = 'aaaaaaaa-9999-4999-8999-0000000000a2';
const W = 'aaaaaaaa-9999-4999-8999-0000000000a3';
const X = '01900000-0000-7000-8000-0000000000c1';
const Y = 'aaaaaaaa-9999-4999-8999-0000000000a4';
const Z = 'aaaaaaaa-9999-4999-8999-0000000000a5';
const X2 = '01900000-0000-7000-8000-0000000000c2';
const X3 = '01900000-0000-7000-8000-0000000000c3';
const X4 = '01900000-0000-7000-8000-0000000000c4';
const X5 = '01900000-0000-7000-8000-0000000000c5';
const X6 = '01900000-0000-7000-8000-0000000000c6';
const X7 = '01900000-0000-7000-8000-0000000000c7';
const X8 = '01900000-0000-7000-8000-0000000000c8';
const X9 = '01900000-0000-7000-8000-0000000000c9';
const UNREAD_PARENT = '01900000-0000-7000-8000-0000000000cf';
const LONG_SENTINEL = 'RAW-ONLY-TAIL-SENTINEL';
const ERROR_SENTINEL = 'RAW-ERROR-SENTINEL';
const RESUMED_SENTINEL = 'RAW-RESUMED-ERROR-SENTINEL';
const CAP_SENTINEL = 'RAW-PAST-THE-CAP-SENTINEL';

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
    queue: (ts, operation, content, reason) => lines.push(JSON.stringify({ type: 'queue-operation', operation, timestamp: ts, sessionId, content, ...(reason ? { reason } : {}) })),
    queuedCommand: (ts, prompt) => lines.push(JSON.stringify(base('attachment', ts, { attachment: { type: 'queued_command', prompt, origin: { kind: 'human' }, commandMode: 'prompt' } }))),
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
  u.result(at(302), 'tu-u1', `lint failed: ${ERROR_SENTINEL} ${'y'.repeat(RAW_ERROR_MAX)} ${CAP_SENTINEL}`, true);
  u.say(at(303), 'msg-u2', [{ type: 'text', text: 'Fixed it.' }], { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 9 });
  u.lines.push(JSON.stringify({ type: 'assistant', sessionId: U, cwd: fx.repo.dir, version: '2.1.0', uuid: `${U}-synthetic`, timestamp: at(303, 500), message: { id: 'msg-synthetic', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } }));
  // Then a call the person rejects (an error result that isn't a failure), a typed message
  // the agent absorbs mid-turn with an attachment record, and one with only the queue record.
  u.say(at(304), 'msg-u3', [{ type: 'tool_use', id: 'tu-u3', name: 'Bash', input: { command: 'git push --force' } }]);
  u.result(at(304, 30), 'tu-u3', "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said: keep the branch", true);
  u.queue(at(305), 'enqueue', 'and keep the old flag working');
  u.queue(at(305, 400), 'remove', 'and keep the old flag working', 'absorbed_mid_turn');
  u.queuedCommand(at(305, 401), 'and keep the old flag working');
  u.queue(at(306), 'enqueue', 'also update the changelog');
  u.queue(at(306, 400), 'remove', 'also update the changelog', 'absorbed_mid_turn');
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
    cx(at(1505), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The parser test fails on empty input.' }] }),
    cx(at(1506), 'response_item', { type: 'local_shell_call', call_id: 'call-x2', status: 'completed', action: { type: 'exec', command: ['ls', '-la'] } }),
    cx(at(1507), 'response_item', { type: 'function_call', name: 'shell', call_id: 'call-x3', arguments: '{not json' }),
  ]);
  // A Codex fork family. X2 starts its running total again at a turn (the total drops), has
  // one record whose own total doesn't count reasoning on top, and ends after its sub-agent X3,
  // as a parent waiting on a sub-agent does.
  const rollout = (id, name, recs) => write(join(fx.codexRoot, '2024', '06', '12', `rollout-2024-06-12T${name}-${id}.jsonl`), recs);
  const meta = (ts, id, extra = {}) => cx(ts, 'session_meta', { id, timestamp: ts, cwd: fx.repo.dir, cli_version: '0.1.0', source: 'vscode', ...extra });
  const spawned = (ts, id, parent) => meta(ts, id, { forked_from_id: parent, subagent_history_start_ordinal: 40, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } });
  rollout(X2, '11-00-00', [
    meta(at(1600), X2),
    tc(at(1601), 5000, { input_tokens: 4000, cached_input_tokens: 0, output_tokens: 1000, total_tokens: 5000 }),
    tc(at(1601, 10), 5000, { input_tokens: 4000, cached_input_tokens: 0, output_tokens: 1000, total_tokens: 5000 }),
    tc(at(1602), 300, { input_tokens: 290, cached_input_tokens: 0, output_tokens: 10, total_tokens: 300 }),
    tc(at(1603), 600, { input_tokens: 200, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 300 }),
    tc(at(1700), 900, { input_tokens: 250, cached_input_tokens: 0, cache_write_input_tokens: 50, output_tokens: 50, total_tokens: 300 }),
  ]);
  // X3, a sub-agent of X2 in the shape most real ones have: the line its own history is said to
  // start on lies past the file's end. It opens, in its first instant, with a copy of X2's
  // history (one count X2's file holds, one it doesn't), makes a call, then holds a later copy
  // of an X2 call as written.
  rollout(X3, '11-10-00', [
    spawned(at(1610), X3, X2),
    tc(at(1610), 5000, { input_tokens: 4000, cached_input_tokens: 0, output_tokens: 1000, total_tokens: 5000 }),
    tc(at(1610, 900), 7000, { input_tokens: 1900, cached_input_tokens: 0, output_tokens: 100, total_tokens: 2000 }),
    tc(at(1611), 820, { input_tokens: 500, cached_input_tokens: 100, output_tokens: 20, total_tokens: 520 }),
    tc(at(1612), 600, { input_tokens: 200, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 300 }),
  ]);
  // X4, a sub-agent of X3: a later copy of X3's own call, then a call of its own.
  rollout(X4, '11-20-00', [
    spawned(at(1620), X4, X3),
    tc(at(1621), 820, { input_tokens: 500, cached_input_tokens: 100, output_tokens: 20, total_tokens: 520 }),
    tc(at(1622), 870, { input_tokens: 40, cached_input_tokens: 0, output_tokens: 10, total_tokens: 50 }),
  ]);
  // X5 and X6, sub-agents of a thread this history doesn't read: each holds the same later
  // copy of the parent's call, then makes its own.
  for (const [id, name, own] of [[X5, '11-30-00', 31], [X6, '11-40-00', 32]]) {
    rollout(id, name, [
      spawned(at(own === 31 ? 1630 : 1640), id, UNREAD_PARENT),
      tc(at(own === 31 ? 1631 : 1641), 3000, { input_tokens: 2500, cached_input_tokens: 0, output_tokens: 500, total_tokens: 3000 }),
      tc(at(own === 31 ? 1632 : 1642), 3000 + own, { input_tokens: own - 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: own }),
    ]);
  }
  // X7 and X8, unrelated sessions whose first calls have the same counts. X8 opens with the
  // estimate Codex writes after a compaction: no input, no output.
  rollout(X7, '12-00-00', [meta(at(1650), X7), tc(at(1651), 777, { input_tokens: 700, cached_input_tokens: 0, output_tokens: 77, total_tokens: 777 })]);
  rollout(X8, '12-10-00', [
    meta(at(1660), X8),
    tc(at(1661), 6000, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 6000 }),
    tc(at(1662), 777, { input_tokens: 700, cached_input_tokens: 0, output_tokens: 77, total_tokens: 777 }),
  ]);
  // X9, a sub-agent of X2 whose records all carry one time (its start), so time can't separate
  // its copy of X2's call from its own two calls.
  rollout(X9, '12-20-00', [
    spawned(at(1670), X9, X2),
    tc(at(1670), 5000, { input_tokens: 4000, cached_input_tokens: 0, output_tokens: 1000, total_tokens: 5000 }),
    tc(at(1670), 5400, { input_tokens: 350, cached_input_tokens: 0, output_tokens: 50, total_tokens: 400 }),
    tc(at(1670), 5700, { input_tokens: 280, cached_input_tokens: 0, output_tokens: 20, total_tokens: 300 }),
  ]);
  // Y stops mid-call. Z resumes it, copying Y's records, and records that call's failed result.
  const y = claude(Y, fx.repo.dir);
  y.prompt(at(600), 'Run the slow suite.');
  y.say(at(601), 'msg-y1', [{ type: 'tool_use', id: 'tu-y1', name: 'Bash', input: { command: 'npm run slow-suite' } }]);
  write(join(fx.claudeRoot, 'proj-u', `${Y}.jsonl`), y.lines);
  const z = claude(Z, fx.repo.dir);
  z.lines.push(...y.lines.map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: Z })));
  z.result(at(700), 'tu-y1', `suite failed: ${RESUMED_SENTINEL}`, true);
  z.prompt(at(701), 'continue');
  write(join(fx.claudeRoot, 'proj-u', `${Z}.jsonl`), z.lines);
});
after(() => removeTempDir(fx.root));

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
  assert.equal(mine.length, 2, 'the two records of msg-u1 are one call, msg-u2 another, and a message the harness wrote none');
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

test('usage: a Codex call is a token count with its own counts whose running total changed; reasoning counted on top joins output', async () => {
  const h = await build({ usage: true });
  const codex = h.usage.calls.filter((c) => c.tool === 'codex' && c.t >= Date.parse(at(1500)) && c.t < Date.parse(at(1600)));
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
  const shown = [h.overview(), ...h.sessions.map((s) => h.session(s.key)), ...h.threads.map((t) => h.thread(t.id)), ...[...h.turnsById.keys()].map((id) => h.turn(id)), ...[lint, msg, prompt, codexCall].flatMap((e) => [h.event(e.id), h.stateAt(e.t)]), h.lookup('#1')];
  const viewText = JSON.stringify(shown);
  for (const s of [LONG_SENTINEL, ERROR_SENTINEL, '"_raw"']) assert.ok(!viewText.includes(s), `no view, moment or lookup holds ${s}`);
  // record() re-reads the log line itself, redacted, as it does without the option.
  const without = await build();
  for (const e of [lint, msg, prompt, codexCall]) assert.equal(JSON.stringify(h.record(e.id)), JSON.stringify(without.record(e.id)));
  // Each readable file's working folder sits on the history's own _raw, out of JSON too.
  assert.ok(!Object.keys(h).includes('_raw'));
  assert.equal(h._raw.cwdOfSource.get(lint.source), fx.repo.dir);
  const hidden = h.sources.filter((s) => s.private).map((s) => s.key);
  assert.ok(hidden.length && hidden.every((k) => !h._raw.cwdOfSource.has(k)), 'skeleton files keep no folder');
  // Skeleton sessions never get raw text, and a history without the option has none.
  for (const e of h.events.filter((x) => h.sessions.find((s) => s.key === x.session)?.private)) assert.equal(e._raw, undefined);
  const plain = await build();
  assert.ok(plain.events.every((e) => e._raw === undefined));
  assert.equal(plain._raw, undefined);
});

test('keepRaw: display-only and outside sessions never get raw text or a folder, in any mode', async () => {
  for (const mode of [{}, { hiddenSessions: 'redacted' }, { privateText: true }]) {
    const label = JSON.stringify(mode);
    const h = await build({ scope: 'all', usage: true, keepRaw: true, ...mode });
    const priv = new Set(h.sessions.filter((s) => s.private).map((s) => s.key));
    assert.ok(h.sessions.some((s) => s.private && s.repoRole === 'display'), `${label}: a display-only session is in the history`);
    assert.ok(h.sessions.some((s) => s.private && s.repoRole !== 'display'), `${label}: an outside session is in the history`);
    if (Object.keys(mode).length) assert.ok(h.events.some((e) => priv.has(e.session) && e.kind === 'prompt' && typeof e.facts.text === 'string'), `${label}: these sessions keep their other content`);
    assert.ok(h.events.some((e) => !priv.has(e.session) && e._raw), `${label}: readable sessions keep raw text`);
    assert.equal(h.events.filter((e) => priv.has(e.session) && e._raw !== undefined).length, 0, `${label}: no private event keeps raw text`);
    assert.ok(h.sources.some((s) => s.private), label);
    for (const s of h.sources) if (s.private) assert.equal(h._raw.cwdOfSource.has(s.key), false, `${label}: no private folder is kept`);
    assert.ok(h.sources.some((s) => !s.private && h._raw.cwdOfSource.has(s.key)), `${label}: readable folders are kept`);
  }
});

test("keepRaw: a resumed copy's failed result brings its raw error text to the kept call", async () => {
  const h = await build({ keepRaw: true });
  const calls = h.events.filter((e) => e.kind === 'action' && e._raw?.input?.command === 'npm run slow-suite');
  assert.equal(calls.length, 1, 'the copied call is one event');
  assert.equal(calls[0].facts.result, 'error', "the copy's result moved to the kept call");
  assert.match(calls[0]._raw.error ?? '', new RegExp(RESUMED_SENTINEL));
  assert.ok(!JSON.stringify(h).includes(RESUMED_SENTINEL));
});

test("usage: a Codex total that starts again still counts each call; a sub-agent's copies are its parent's", async () => {
  const h = await build({ usage: true });
  const cxCalls = h.usage.calls.filter((c) => c.tool === 'codex' && c.t >= Date.parse(at(1600)));
  const sourceOf = (id) => h.sources.find((s) => s.tool === 'codex' && cxCalls.some((c) => c.source === s.key) && h.events.some((e) => e.source === s.key && e.kind === 'session' && e.t === Date.parse(at({ [X2]: 1600, [X3]: 1610, [X4]: 1620, [X5]: 1630, [X6]: 1640, [X7]: 1650, [X8]: 1660, [X9]: 1670 }[id]))))?.key;
  const of = (id) => cxCalls.filter((c) => c.source === sourceOf(id)).map((c) => [c.input, c.cacheWrite, c.cacheRead, c.output]);
  assert.deepEqual(of(X2), [[4000, 0, 0, 1000], [290, 0, 0, 10], [200, 0, 0, 100], [200, 50, 0, 50]], 'a repeat is no call; after the total drops each call counts; reasoning inside the total is not added again; a cache-write count is read');
  assert.deepEqual(of(X3), [[400, 0, 100, 20]], "the sub-agent's opening copy and a later copy of its parent's call are not its calls, even though the parent ends later");
  assert.deepEqual(of(X4), [[40, 0, 0, 10]], "a grandchild's copy of its parent's call counts in the parent");
  assert.deepEqual([...of(X5), ...of(X6)].sort(), [[2500, 0, 0, 500], [30, 0, 0, 1], [31, 0, 0, 1]], 'siblings whose parent is not read count their shared copy once');
  assert.deepEqual([of(X7), of(X8)], [[[700, 0, 0, 77]], [[700, 0, 0, 77]]], 'unrelated sessions with the same counts both count; a record with no input and no output is no call');
  assert.deepEqual(of(X9), [[350, 0, 0, 50], [280, 0, 0, 20]], 'in a file whose records carry one time, own calls count and a copy its parent holds does not');
  const x3 = cxCalls.find((c) => c.source === sourceOf(X3));
  assert.equal(x3.session, cxCalls.find((c) => c.source === sourceOf(X2)).session, "a spawned sub-agent's calls belong to its parent's session");
  assert.equal(x3.agent, sourceOf(X3));
});

test('keepRaw: every prompt and agent message keeps its text; a Codex call keeps its whole input', async () => {
  const h = await build({ keepRaw: true });
  const withText = (kind, t) => h.events.find((e) => e.kind === kind && e._raw?.text === t);
  assert.ok(withText('prompt', 'Run the tests.'), 'a Codex prompt');
  assert.ok(withText('message', 'The parser test fails on empty input.'), 'a Codex agent message');
  assert.ok(withText('prompt', 'and keep the old flag working'), 'a Claude Code prompt delivered mid-turn');
  assert.ok(withText('prompt', 'also update the changelog'), 'a Claude Code prompt only the queue record carries');
  const shell = h.events.find((e) => e.kind === 'action' && e._raw?.tool === 'local_shell');
  assert.deepEqual(shell?._raw.input.action, { type: 'exec', command: ['ls', '-la'] }, "a local shell call's action");
  const bad = h.events.find((e) => e.kind === 'action' && e._raw?.tool === 'shell' && e._raw.input.arguments === '{not json');
  assert.ok(bad, 'arguments that are not valid JSON are kept as written');
});

test("keepRaw: a failed call's error text is cut at RAW_ERROR_MAX; a rejected call keeps none", async () => {
  const h = await build({ keepRaw: true });
  const lint = h.events.find((e) => e.kind === 'action' && e._raw?.input?.command === 'npm run lint');
  assert.equal(lint._raw.error.length, RAW_ERROR_MAX);
  assert.ok(!lint._raw.error.includes(CAP_SENTINEL));
  const push = h.events.find((e) => e.kind === 'action' && e._raw?.input?.command === 'git push --force');
  assert.equal(push.facts.result, 'rejected');
  assert.equal('error' in push._raw, false, "the person's feedback is not an error text");
});
