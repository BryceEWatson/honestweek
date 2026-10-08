// The agent's progress updates between tool calls (the engine's `updates` option). On Claude
// Opus 5.5 and Fable 5.1 those updates arrive as thinking blocks, and the log has no field
// that marks one, so a block is read as an update only by its position: text that isn't
// empty, the last thinking block of its model response, a tool call as the very next block,
// on one of those two models. Every case here is made up: generic text, example.com
// addresses, fixed times. Each shown case has partners that change the one fact that should
// keep the block unread.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.mjs';
import { adaptSessions } from '../lib/claude-adapter.mjs';
import { runDiscover } from '../lib/discover.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { describeRules, RULES, UPDATE_RULES, updatesByPosition } from '../lib/replay/classify.mjs';
import { parseClaudeSource } from '../lib/replay/claude.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { sessionText } from '../lib/view/codex-judge.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ME = 'you@example.com';
const CODENAME = 'Bluebird';
const OPUS = 'claude-opus-5-5';
const UPDATE = 'Checking the config next.';
const T0 = Date.parse('2024-06-12T10:00:00.000Z');
const at = (s) => new Date(T0 + Math.round(s * 1000)).toISOString();
const WINDOW = { from: '2024-06-10', to: '2024-06-16', timezone: 'UTC' };

const think = (text) => ({ type: 'thinking', thinking: text, signature: 'c2lnbmF0dXJl' });
const hidden = () => ({ type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' });
const say = (text) => ({ type: 'text', text });
const tool = (id, command = 'node --test') => ({ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Run the suite' } });

let uuidN = 0;
/** One Claude Code session file, written the way the harness writes it: one record per content
 *  block, every block of one model response sharing its message id. */
function sessionLog(sessionId, cwd) {
  const lines = [];
  const base = (type, t, extra) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.287', gitBranch: 'main', type, uuid: `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`, timestamp: at(t), ...extra });
  const s = {
    lines,
    prompt(t, text) {
      lines.push(base('user', t, { message: { role: 'user', content: text }, origin: { kind: 'human' } }));
      return s;
    },
    /** A model response: each block a record of its own, a hundredth of a second apart. */
    response(t, id, blocks, { model = OPUS } = {}) {
      blocks.forEach((b, i) => lines.push(base('assistant', t + i / 100, { message: { id, type: 'message', role: 'assistant', model, content: [b] }, requestId: `req_${id}` })));
      return s;
    },
    result(t, toolUseId) {
      lines.push(base('user', t, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }, toolUseResult: { stdout: 'ok', stderr: '', interrupted: false } }));
      return s;
    },
    turnEnd(t) {
      lines.push(base('system', t, { subtype: 'turn_duration', durationMs: 4000, messageCount: 4 }));
      return s;
    },
    text: () => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  };
  return s;
}

/** A temp folder with a configured repository folder and a Claude projects root. */
function workspace() {
  const root = makeTempDir('hw-updates-');
  const repo = join(root, 'your-project');
  mkdirSync(repo, { recursive: true });
  const claudeRoot = join(root, 'claude-projects');
  const raw = { identity: { authorEmails: [ME] }, week: { startsOn: 'monday', timezone: 'UTC' }, repos: [{ path: repo, label: 'your-project', role: 'featured' }], redaction: { codenames: [CODENAME], names: [], terms: [] }, output: { mode: 'digest', file: 'honestweek.digest.md' } };
  return { root, repo, claudeRoot, raw, config: normalizeConfig(raw, { configDir: root }) };
}

function writeSession(ws, sessionId, log, dir = 'proj-a') {
  const file = join(ws.claudeRoot, dir, `${sessionId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, log.text());
  return file;
}

/** Parse one made-up session with the updates option on (or as given). */
async function parse(build, { updates = true, keepRaw = false, isPrivate = false, hiddenSessions } = {}) {
  const ws = workspace();
  const log = sessionLog('11111111-1111-4111-8111-000000000001', ws.repo);
  build(log);
  const file = writeSession(ws, 'one', log);
  const source = { key: 'cc-one', sessionKey: 'cc-one', file, role: 'session', tool: 'claude-code' };
  return parseClaudeSource(source, { redact: (s) => s.replaceAll(CODENAME, '[redacted:codename]'), isPrivate, hiddenSessions, updates, keepRaw, cwd: ws.repo, agentKey: 'cc-one:main', sidechainAgentKey: 'cc-one:sidechain' });
}
const updatesOf = (r) => r.events.filter((e) => e.kind === 'update');

test('a thinking block with text right before a tool call on Opus 5.5 is shown as an update, inferred', async () => {
  const r = await parse((s) => s.prompt(0, 'Run the tests.').response(1, 'msg_a', [think(UPDATE), tool('tu_1')]).result(3, 'tu_1').response(4, 'msg_b', [say('All passed.')]).turnEnd(5));
  const [u] = updatesOf(r);
  assert.ok(u, 'the block is read as an update');
  assert.equal(u.facts.text, UPDATE);
  assert.equal(u.facts.chars, UPDATE.length);
  assert.equal(u.evidence, 'inferred');
  assert.deepEqual(u.inferred, [{ key: 'reads-as', value: 'progress-update', rule: 'updates.position' }]);
  assert.equal(u.actor, 'agent');
  // It sits on its own record, before the tool call it introduces, in the prompt's turn.
  const call = r.events.find((e) => e.kind === 'action');
  assert.equal(u.refs[0].line, call.refs[0].line - 1);
  assert.ok(u.t < call.t);
  assert.equal(u.turn, call.turn);
  // Never a message: nothing that reads the agent's messages sees it.
  assert.equal(r.events.filter((e) => e.kind === 'message').length, 1);
  // The signature is never kept.
  assert.ok(!JSON.stringify(r.events).includes('c2lnbmF0dXJl'));
  // Fable 5.1, and a model id with a dated or bracketed suffix, count the same.
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5-20261001', 'claude-opus-5-5[1m]']) {
    const other = await parse((s) => s.prompt(0, 'Run the tests.').response(1, 'msg_a', [think(UPDATE), tool('tu_1')], { model }).result(3, 'tu_1'));
    assert.equal(updatesOf(other).length, 1, model);
  }
});

test('the same block is not shown before a text block, after the last tool call, on another model, empty, or encrypted', async () => {
  const cases = {
    'before a text block': (s) => s.response(1, 'msg_a', [think(UPDATE), say('Running the suite.'), tool('tu_1')]).result(3, 'tu_1'),
    'after the last tool call': (s) => s.response(1, 'msg_a', [tool('tu_1'), think(UPDATE)]).result(3, 'tu_1').response(4, 'msg_b', [say('Done.')]),
    'the last block of the file': (s) => s.response(1, 'msg_a', [think(UPDATE)]),
    'on Opus 5': (s) => s.response(1, 'msg_a', [think(UPDATE), tool('tu_1')], { model: 'claude-opus-5' }).result(3, 'tu_1'),
    'on Fable 5': (s) => s.response(1, 'msg_a', [think(UPDATE), tool('tu_1')], { model: 'claude-fable-5' }).result(3, 'tu_1'),
    'on a model whose id only starts alike': (s) => s.response(1, 'msg_a', [think(UPDATE), tool('tu_1')], { model: 'claude-opus-5-50' }).result(3, 'tu_1'),
    'empty': (s) => s.response(1, 'msg_a', [think(''), tool('tu_1')]).result(3, 'tu_1'),
    'only spaces': (s) => s.response(1, 'msg_a', [think('  \n '), tool('tu_1')]).result(3, 'tu_1'),
    'encrypted': (s) => s.response(1, 'msg_a', [hidden(), tool('tu_1')]).result(3, 'tu_1'),
    'followed by an encrypted one': (s) => s.response(1, 'msg_a', [think(UPDATE), hidden(), tool('tu_1')]).result(3, 'tu_1'),
    'a tool call in the next model response': (s) => s.response(1, 'msg_a', [think(UPDATE)]).response(2, 'msg_b', [tool('tu_1')]).result(3, 'tu_1'),
  };
  for (const [name, build] of Object.entries(cases)) {
    const r = await parse((s) => build(s.prompt(0, 'Run the tests.')));
    assert.equal(updatesOf(r).length, 0, name);
    assert.ok(!JSON.stringify(r.events).includes(UPDATE), `${name}: the text is in no event`);
    // Every thinking block is still counted, as excluded.
    assert.equal(r.coverage.get('assistant:thinking:update'), undefined, name);
    assert.ok(r.coverage.get('assistant:thinking').handling.startsWith('excluded'), name);
  }
});

test('two thinking blocks before one tool call show only the last; a block before an earlier call in the same response stays unread', async () => {
  const r = await parse((s) => s.prompt(0, 'Go.').response(1, 'msg_a', [think('First pass over the options.'), think(UPDATE), tool('tu_1')]).result(3, 'tu_1'));
  assert.deepEqual(updatesOf(r).map((e) => e.facts.text), [UPDATE]);
  assert.ok(!JSON.stringify(r.events).includes('First pass'));
  assert.deepEqual({ shown: r.coverage.get('assistant:thinking:update').count, excluded: r.coverage.get('assistant:thinking').count }, { shown: 1, excluded: 1 });
  // The rule takes the last thinking block of the whole response, so the first of two calls gets none.
  const two = await parse((s) => s.prompt(0, 'Go.').response(1, 'msg_a', [think('Looking at the parser.'), tool('tu_1'), think(UPDATE), tool('tu_2')]).result(3, 'tu_1').result(4, 'tu_2'));
  assert.deepEqual(updatesOf(two).map((e) => e.facts.text), [UPDATE]);
});

test("a tool result recorded between a response's blocks doesn't end the response", async () => {
  // Claude Code records a call's result before the next block of the same response.
  const r = await parse((s) => s.prompt(0, 'Go.').response(1, 'msg_a', [tool('tu_1')]).result(2, 'tu_1').response(3, 'msg_a', [think(UPDATE), tool('tu_2')]).result(5, 'tu_2'));
  assert.deepEqual(updatesOf(r).map((e) => e.facts.text), [UPDATE]);
});

test('without the option, and in a skeleton session, nothing is read from a thinking block', async () => {
  const build = (s) => s.prompt(0, 'Go.').response(1, 'msg_a', [think(UPDATE), tool('tu_1')]).result(3, 'tu_1');
  const off = await parse(build, { updates: false });
  assert.equal(updatesOf(off).length, 0);
  assert.deepEqual({ ...off.coverage.get('assistant:thinking') }, { count: 1, handling: 'excluded: private model reasoning is never read' });
  const skeleton = await parse(build, { isPrivate: true });
  assert.equal(updatesOf(skeleton).length, 0);
  // A hidden session shown redacted keeps its text, so its update shows too, redacted.
  const shownRedacted = await parse((s) => s.prompt(0, 'Go.').response(1, 'msg_a', [think(`Checking ${CODENAME} next.`), tool('tu_1')]).result(3, 'tu_1'), { isPrivate: true, hiddenSessions: 'redacted' });
  assert.deepEqual(updatesOf(shownRedacted).map((e) => e.facts.text), ['Checking [redacted:codename] next.']);
});

// ---- through the engine ---------------------------------------------------------------------

/** The same made-up week twice over: once as written, once with every thinking block's text
 *  replaced, so whatever a history holds of a thinking block shows as a difference. */
async function week({ text = `Checking ${ME} and ${CODENAME} next.`, model = OPUS } = {}) {
  const ws = workspace();
  const log = sessionLog('22222222-2222-4222-8222-000000000002', ws.repo)
    .prompt(0, 'Please run the tests and fix the parser.')
    .response(1, 'msg_a', [think(text), tool('tu_1')], { model })
    .result(3, 'tu_1')
    .response(1500, 'msg_b', [think('Weighing two fixes.'), think('Editing the parser now.'), tool('tu_2', 'node --test test/parser.test.mjs')], { model })
    .result(1502, 'tu_2')
    .response(1503, 'msg_c', [think('All green.'), say('Fixed and tested.')], { model })
    .turnEnd(1504);
  writeSession(ws, '22222222-2222-4222-8222-000000000002', log);
  return ws;
}
const history = (ws, extra = {}) => buildWorkHistory({ config: ws.config, ...WINDOW, roots: { claude: [ws.claudeRoot], codex: [] }, git: false, ...extra });

test('engine: updates are redacted, inferred, named in the rules table, and leave spans, quiet intervals and end states alone', async () => {
  const ws = await week();
  const off = await history(ws);
  const on = await history(ws, { updates: true });
  const ups = on.events.filter((e) => e.kind === 'update');
  assert.equal(ups.length, 2);
  assert.match(ups[0].facts.text, /^Checking \S+ and \S+ next\.$/);
  assert.equal(ups[1].facts.text, 'Editing the parser now.');
  for (const e of ups) {
    assert.ok(!e.facts.text.includes(ME) && !e.facts.text.includes(CODENAME), 'redacted before it reaches the event');
    assert.equal(e.evidence, 'inferred');
    assert.equal(on.event(e.id).inferred[0].ruleText, UPDATE_RULES.get('updates.position'));
    assert.match(on.event(e.id).description, /^update \(inferred from position\) "/);
  }
  assert.equal(on.rules['updates.position'], UPDATE_RULES.get('updates.position'));
  assert.equal(off.rules['updates.position'], undefined, 'the rule is in the table only with the option');
  assert.deepEqual(describeRules('updates.position'), { 'updates.position': UPDATE_RULES.get('updates.position') });
  assert.ok(!RULES.has('updates.position'));
  // Coverage: two updates shown, the other two thinking blocks still excluded.
  assert.deepEqual([on.coverage['claude-code']['assistant:thinking:update'].count, on.coverage['claude-code']['assistant:thinking'].count], [2, 2]);
  assert.equal(off.coverage['claude-code']['assistant:thinking'].count, 4);
  assert.equal(off.coverage['claude-code']['assistant:thinking:update'], undefined);
  // Everything that isn't an update reads as without the option.
  const strip = (h) => JSON.stringify({ sessions: h.sessions, agents: h.agents, threads: h.threads, events: h.events.filter((e) => e.kind !== 'update'), links: h.links });
  assert.equal(strip(on), strip(off));
  assert.ok(off.events.some((e) => e.kind === 'quiet'), 'the made-up week has a quiet interval, so the comparison covers one');
});

/** Rewrite every thinking block's text in a week's session file to as many x's: the same bytes
 *  long, so every other record keeps its place, and nothing of the old text left. */
function blankThinking(ws) {
  const dir = join(ws.claudeRoot, 'proj-a');
  for (const f of readdirSync(dir)) {
    const file = join(dir, f);
    const lines = readFileSync(file, 'utf8').split('\n').map((l) => {
      if (!l) return l;
      const rec = JSON.parse(l);
      for (const b of rec.message?.content ?? []) if (b?.type === 'thinking') b.thinking = 'x'.repeat(b.thinking.length);
      return JSON.stringify(rec);
    });
    writeFileSync(file, lines.join('\n'));
  }
}

test("engine: an update stamped after its tool call doesn't become the session's last record", async () => {
  // The session ends on a call with no result, and the response's records are stamped out of order.
  const ws = workspace();
  const log = sessionLog('55555555-5555-4555-8555-000000000005', ws.repo).prompt(0, 'Go.');
  log.response(1, 'msg_a', [think(UPDATE), tool('tu_1')]);
  log.lines[1].timestamp = at(2);
  writeSession(ws, '55555555-5555-4555-8555-000000000005', log);
  const [off, on] = [await history(ws), await history(ws, { updates: true })];
  assert.equal(on.events.filter((e) => e.kind === 'update').length, 1);
  assert.equal(off.sessions[0].endState, 'last-record-is-a-call-without-result');
  assert.equal(on.sessions[0].endState, off.sessions[0].endState);
  assert.equal(on.sessions[0].lastAt, off.sessions[0].lastAt);
});

test('engine: without the option a history is byte for byte the same whatever the thinking blocks say', async () => {
  const ws = await week();
  const a = JSON.stringify(await history(ws));
  blankThinking(ws);
  const b = JSON.stringify(await history(ws));
  assert.equal(a, b);
  // With the option the text is read, so the same change shows.
  const ws2 = await week();
  const c = JSON.stringify(await history(ws2, { updates: true }));
  blankThinking(ws2);
  assert.notEqual(JSON.stringify(await history(ws2, { updates: true })), c);
});

test('engine: a record copied into a resumed session file gives one update, not two', async () => {
  const ws = workspace();
  const original = sessionLog('33333333-3333-4333-8333-000000000003', ws.repo).prompt(0, 'Go.').response(1, 'msg_a', [think(UPDATE), tool('tu_1')]).result(3, 'tu_1').turnEnd(4);
  writeSession(ws, '33333333-3333-4333-8333-000000000003', original);
  // The resumed file opens with a copy of the original's records, uuids and all, then goes on.
  const copy = { text: () => `${original.lines.map((l) => JSON.stringify({ ...l, sessionId: '44444444-4444-4444-8444-000000000004' })).join('\n')}\n${JSON.stringify({ ...original.lines[0], uuid: '00000000-0000-4000-8000-999999999999', timestamp: at(60), sessionId: '44444444-4444-4444-8444-000000000004', message: { role: 'user', content: 'Carry on.' } })}\n` };
  writeSession(ws, '44444444-4444-4444-8444-000000000004', copy);
  const h = await history(ws, { updates: true });
  const ups = h.events.filter((e) => e.kind === 'update');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].copies?.length, 1, 'the copy is folded into the original');
});

test('secret-in-log reads an update in memory, says it is inferred from position, and keeps no value', async () => {
  const KEY = `sk-${'a1B2c3D4e5F6g7H8i9J0'}`;
  const ws = await week({ text: `Trying the key ${KEY} against the staging API next.` });
  const h = await history(ws, { updates: true, keepRaw: true, usage: true });
  const r = runProblems(h, { builtT: Date.parse('2024-06-20T00:00:00.000Z') });
  const found = r.patterns.find((p) => p.id === 'secret-exposure').findings;
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'agent progress update (inferred from position)');
  assert.equal(found[0].rule, 'problems.secret-shape, updates.position');
  assert.equal(found[0].verdictEvidence, 'inferred');
  assert.equal(found[0].severity, 'note');
  assert.match(found[0].note, /read as updates by where they sit/);
  assert.equal(found[0].event, h.events.find((e) => e.kind === 'update').id);
  assert.ok(!JSON.stringify(r).includes(KEY), 'the key is in no field of the result');
  assert.match(r.checks.find((c) => c.id === 'secret-in-log').checked, /and 2 agent progress updates \(inferred from position\)/);
  // Without the option the same week has nothing to find there.
  const plain = runProblems(await history(ws, { keepRaw: true, usage: true }), { builtT: Date.parse('2024-06-20T00:00:00.000Z') });
  assert.equal(plain.patterns.find((p) => p.id === 'secret-exposure').findings.length, 0);
});

// ---- nothing written changes -----------------------------------------------------------------

test('written outputs: the text sent to Codex for a judgment is the same with or without updates', async () => {
  const ws = await week();
  const redact = (s) => s;
  const text = async (updates) => {
    const h = await history(ws, { updates });
    return sessionText(h.events.filter((e) => e.session === h.sessions[0].key), redact);
  };
  const [off, on] = [await text(false), await text(true)];
  assert.equal(on, off);
  assert.ok(!on.includes('Checking'));
});

test('written outputs: the discover draft keeps exactly the thinking notes Replay shows as updates', async () => {
  // One week, written on Opus 5.5 (the engine shows two updates), then rewritten on Opus 5 (it
  // shows none); the draft is written into the same folder both times.
  const ws = await week();
  const work = makeTempDir('hw-updates-draft-');
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify(ws.raw));
  const draft = async () => {
    const engine = await history(ws, { updates: true });
    const io = { out: () => {}, err: () => {}, exit: (c) => c };
    const code = await runDiscover({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io, adapter: (o) => adaptSessions({ ...o, projectsRoot: ws.claudeRoot }), gitWindow: () => [] });
    assert.equal(code, 0);
    return { shown: engine.events.filter((e) => e.kind === 'update').length, bytes: readFileSync(join(work, 'honestweek.draft.json'), 'utf8') };
  };
  const opus55 = await draft();
  const file = join(ws.claudeRoot, 'proj-a', '22222222-2222-4222-8222-000000000002.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll(`"model":"${OPUS}"`, '"model":"claude-opus-5"'));
  const opus5 = await draft();
  assert.deepEqual([opus55.shown, opus5.shown], [2, 0]);
  assert.ok(JSON.parse(opus55.bytes).sessions.length === 1, 'the draft holds the session');
  // The draft follows the same rule (updates.position): the two notes that read as updates are in
  // the Opus 5.5 draft and in neither form in the Opus 5 one; every other note is the same.
  const notes = (bytes) => JSON.parse(bytes).sessions[0].assistantNotes ?? [];
  const [kept, dropped] = [notes(opus55.bytes), notes(opus5.bytes)];
  assert.equal(kept.length - dropped.length, 2);
  assert.deepEqual(kept.filter((n) => !dropped.includes(n)).length, 2);
  assert.ok(dropped.every((n) => kept.includes(n)), 'nothing else differs');
});

test('written outputs: no command but view and the questions it answers can reach the code that reads updates', () => {
  // Every subcommand's module and everything it imports, statically or by a literal import().
  // A quoted path that names no file is text in a module (the demo week writes code), not an
  // import: a real one would fail to load. find, replay, problems and goals (lib/ask.mjs) print
  // what the view page shows and write no file, so they may reach it; nothing else may.
  const bin = readFileSync(join(ROOT, 'bin', 'honestweek.mjs'), 'utf8');
  const commands = JSON.parse(bin.match(/const SUBCOMMANDS = (\[[^\]]*\])/)[1].replaceAll("'", '"'));
  const moduleOf = JSON.parse(bin.match(/const MODULE = (\{[^}]*\})/)[1].replace(/(\w+):/g, '"$1":').replaceAll("'", '"'));
  const SHOWS_VIEW = new Set(['view', 'find', 'replay', 'problems', 'goals']);
  assert.doesNotMatch(readFileSync(join(ROOT, 'lib', 'ask.mjs'), 'utf8'), /writeFileSync|appendFileSync|atomicWrite|createWriteStream|mkdirSync/, 'the question commands write no file');
  assert.ok(commands.includes('discover') && commands.includes('view'));
  const reach = (start) => {
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) {
        const target = resolve(dirname(file), m[1]);
        if (existsSync(target)) walk(target);
      }
    };
    walk(start);
    return seen;
  };
  const engine = resolve(ROOT, 'lib', 'replay', 'claude.mjs');
  for (const c of commands) {
    const reached = reach(resolve(ROOT, 'lib', `${moduleOf[c] ?? c}.mjs`)).has(engine);
    assert.equal(reached, SHOWS_VIEW.has(c), `${c} ${SHOWS_VIEW.has(c) ? "doesn't reach" : 'reaches'} the engine's Claude Code parser`);
  }
  // The guard is real: the parser is a file this test can see.
  assert.ok(readdirSync(join(ROOT, 'lib', 'replay')).includes('claude.mjs'));
});

test('updatesByPosition matches Opus 5.5 and Fable 5.1 by the id prefix only', () => {
  for (const m of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5-5-20261001', 'claude-fable-5-1[1m]']) assert.equal(updatesByPosition(m), true, m);
  for (const m of ['claude-opus-5', 'claude-fable-5', 'claude-opus-5-50', 'claude-sonnet-5-5', 'model-a', '<synthetic>', null, 5]) assert.equal(updatesByPosition(m), false, String(m));
});
