// Tests of a fix (lib/problems/fix-tests.mjs): the tag a copied test prompt carries, the words
// each fix leaves in a log, reading those words from Claude Code's and Codex's record shapes (as
// checked on Claude Code 2.1.287 and Codex CLI 0.159), and a whole run through the checks, where
// each tagged session says whether the fix fired and whether the problem showed up anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DRAFTS } from '../lib/problems/drafts.mjs';
import { FIX_MARKS, firedOf, fixVersion, norm, scanLog, TAG_RE, testTag } from '../lib/problems/fix-tests.mjs';
import { loadCatalog, PATTERN_CHECKS, runProblems } from '../lib/problems/index.mjs';
import { createProblemsRoute } from '../lib/view/problems-route.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const T0 = Date.parse('2025-03-10T09:00:00.000Z');
const WINDOW = { from: '2025-03-10', to: '2025-03-16', timezone: 'UTC', startAt: '2025-03-10T00:00:00.000Z', endAt: '2025-03-17T00:00:00.000Z', startT: Date.parse('2025-03-10T00:00:00.000Z'), endT: Date.parse('2025-03-17T00:00:00.000Z') };
const BUILT = Date.parse('2025-03-20T00:00:00.000Z');
const min = (m) => T0 + m * 60e3;
const jsonl = (recs) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;

// ---- the tag, the version and the marks --------------------------------------------------------

test('the tag names the pattern and a four-digit version of the fix, which changes when the fix text does', () => {
  const d = DRAFTS['destructive-command'];
  const v = fixVersion(d);
  assert.match(v, /^[0-9a-f]{4}$/);
  assert.equal(fixVersion(d), v, 'the same text, the same version');
  assert.notEqual(fixVersion({ ...d, text: `${d.text} ` }), v, 'any change to the Claude Code text');
  assert.notEqual(fixVersion({ ...d, codex: { ...d.codex, text: 'other' } }), v, 'or to the Codex text');
  const tag = testTag('destructive-command', v);
  assert.equal(tag, `[honestweek check: destructive-command ${v}]`);
  assert.deepEqual(TAG_RE.exec(`Do the thing. ${tag}`).slice(1), ['destructive-command', v]);
  assert.equal(TAG_RE.exec('[honestweek check: destructive-command 7F3A]'), null, 'lowercase hex only');
  assert.doesNotMatch(tag, /—/);
});

test("each fix's marks are the start of a message its own text quotes, and every hook or instruction fix has one", () => {
  const ids = new Set(loadCatalog().patterns.map((p) => p.id));
  for (const [id, marks] of Object.entries(FIX_MARKS)) {
    assert.ok(ids.has(id), `${id} is a pattern`);
    const d = DRAFTS[id];
    const text = norm(`${d.text}\n${d.codex?.text ?? ''}`);
    for (const m of marks) {
      assert.ok(['hook', 'instructions'].includes(m.in), id);
      assert.ok(m.words.split(' ').length >= 6, `${id}: long enough not to turn up by chance`);
      assert.ok(text.includes(norm(m.words)), `${id}: "${m.words}" is in the fix's text`);
    }
  }
  for (const [id, d] of Object.entries(DRAFTS)) {
    const kinds = (FIX_MARKS[id] ?? []).map((m) => m.in);
    if (d.kind === 'hook') assert.ok(kinds.includes('hook'), `${id}: a hook fix has a hook mark`);
    if (d.kind === 'instruction') assert.ok(kinds.includes('instructions'), `${id}: an instruction fix has an instructions mark`);
  }
});

// ---- reading a log ------------------------------------------------------------------------------

const DESTRUCT = FIX_MARKS['destructive-command'];
const SAY = "This can't be undone. Say what it removes and why before running it.";
const DONE = FIX_MARKS['unverified-done-claim'];

test('Claude Code: a hook record after the prompt fires the fix; the same words before it, or in the agent\'s own reply, do not', () => {
  const at = (n) => `2025-03-10T09:0${n}:00.000Z`;
  const prompt = { type: 'user', timestamp: at(1), message: { role: 'user', content: 'Reset it. [honestweek check: destructive-command abcd]' } };
  const added = { type: 'attachment', timestamp: at(2), attachment: { type: 'hook_additional_context', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', content: [SAY] } };
  const echoed = { type: 'assistant', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: `The hook said: ${SAY}` }] } };
  assert.equal(scanLog(jsonl([prompt, added]), { tool: 'claude-code', afterLine: 1, marks: DESTRUCT }).hook, true);
  assert.equal(scanLog(jsonl([added, prompt]), { tool: 'claude-code', afterLine: 2, marks: DESTRUCT }).hook, false, 'before the prompt');
  assert.equal(scanLog(jsonl([prompt, echoed]), { tool: 'claude-code', afterLine: 1, marks: DESTRUCT }).hook, false, "the agent quoting it isn't the hook");
  // A refused step, a Stop hook's block and its feedback note all carry the hook's words.
  const refused = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: `PreToolUse:Bash hook error: ${SAY}` }] } };
  const words = "You changed code and haven't run a check since the last edit.";
  const blocked = { type: 'attachment', attachment: { type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop', blockingError: { blockingError: words, command: 'node stop.mjs' } } };
  const feedback = { type: 'user', isMeta: true, message: { role: 'user', content: `Stop hook feedback:\n${words}` } };
  assert.equal(scanLog(jsonl([prompt, refused]), { tool: 'claude-code', afterLine: 1, marks: DESTRUCT }).hook, true);
  assert.equal(scanLog(jsonl([prompt, blocked]), { tool: 'claude-code', afterLine: 1, marks: DONE }).hook, true);
  assert.equal(scanLog(jsonl([prompt, feedback]), { tool: 'claude-code', afterLine: 1, marks: DONE }).hook, true);
  // Instructions load at the start: found anywhere in the file, and a file without any says so.
  const instr = { type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/path/to/CLAUDE.md', type: 'User', content: '# Rules\n"Before you say done, fixed or working,\nrun a check."' }] } };
  const s = scanLog(jsonl([instr, prompt]), { tool: 'claude-code', afterLine: 2, marks: DONE });
  assert.deepEqual([s.instructions, s.sawInstructions, s.hook], [true, true, false], 'words wrapped over lines still match');
  assert.equal(scanLog(jsonl([prompt]), { tool: 'claude-code', afterLine: 1, marks: DONE }).sawInstructions, false);
});

test('Codex: added context is a developer message, a Stop block a <hook_prompt>, a refusal a blocked tool output, and AGENTS.md a user message', () => {
  const rec = (type, payload) => ({ timestamp: '2025-03-10T09:01:00.000Z', type, payload });
  const prompt = rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reset it. [honestweek check: destructive-command abcd]' }] });
  const dev = rec('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: SAY }] });
  const refused = rec('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script failed' }, { type: 'input_text', text: `Script error:\nCommand blocked by PreToolUse hook: ${SAY} Command: git reset --hard` }] });
  const words = "You changed code and haven't run a check since the last edit.";
  const hookPrompt = rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<hook_prompt hook_run_id="stop:1:/path/to/hooks.json">${words}</hook_prompt>` }] });
  const item = rec('event_msg', { type: 'item_completed', item: { type: 'HookPrompt', id: 'm1', fragments: [{ text: words, hookRunId: 'stop:1' }] } });
  const agents = rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n"Before you say done, fixed or working, run a check."\n</INSTRUCTIONS>' }] });
  const scan = (recs, marks, afterLine) => scanLog(jsonl(recs), { tool: 'codex', afterLine, marks });
  assert.equal(scan([prompt, dev], DESTRUCT, 1).hook, true);
  assert.equal(scan([dev, prompt], DESTRUCT, 2).hook, false, 'a developer message before the prompt is the session opening, not the hook');
  assert.equal(scan([prompt, refused], DESTRUCT, 1).hook, true);
  assert.equal(scan([prompt, hookPrompt], DONE, 1).hook, true);
  assert.equal(scan([prompt, item], DONE, 1).hook, true);
  const s = scan([agents, prompt], DONE, 2);
  assert.deepEqual([s.instructions, s.sawInstructions, s.hook], [true, true, false]);
  // A user message that only mentions the words isn't a hook's.
  const typed = rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: SAY }] });
  assert.equal(scan([prompt, typed], DESTRUCT, 1).hook, false);
  // A command whose own output quotes the phrase further in (printing a file that names it) isn't
  // a refusal, even with the fix's words in it too.
  const printed = rec('response_item', { type: 'function_call_output', call_id: 'c2', output: `Exit code: 0\nOutput:\n${'// a file\n'.repeat(40)}// a refused step reads "blocked by PreToolUse hook: ${SAY}"` });
  assert.equal(scan([prompt, printed], DESTRUCT, 1).hook, false);
});

test('what "fired" means by kind of fix, and what a log can\'t say', () => {
  const scan = (o) => ({ hook: false, instructions: false, sawInstructions: false, ...o });
  assert.deepEqual(firedOf('destructive-command', scan({ hook: true })), { state: 'fired', level: 'recorded' });
  assert.deepEqual(firedOf('destructive-command', scan({})), { state: 'none', level: 'inferred' }, 'no sign is inferred: the words may have been changed');
  assert.deepEqual(firedOf('sycophancy', scan({ instructions: true, sawInstructions: true })), { state: 'loaded', level: 'recorded' }, 'an instruction is loaded, never "fired"');
  assert.deepEqual(firedOf('sycophancy', scan({ sawInstructions: true })), { state: 'not-loaded', level: 'inferred' });
  assert.deepEqual(firedOf('sycophancy', scan({})), { state: 'unknown', level: 'missing', why: 'no-instructions-record' });
  // A hook fix that also adds an instruction: the hook firing wins; the instruction alone says loaded.
  assert.equal(firedOf('unverified-done-claim', scan({ hook: true, instructions: true })).state, 'fired');
  assert.equal(firedOf('unverified-done-claim', scan({ instructions: true })).state, 'loaded');
  assert.deepEqual(firedOf('approval-fatigue', scan({ hook: true })), { state: 'unknown', level: 'missing', why: 'no-trace' }, 'a setting leaves nothing');
  assert.deepEqual(firedOf('destructive-command', null), { state: 'unknown', level: 'missing', why: 'unread' });
});

// ---- a whole run --------------------------------------------------------------------------------

/** A history in the engine's shape with one tagged prompt per session and each session's log. */
function week(dir) {
  const sessions = [];
  const agents = [];
  const events = [];
  const files = new Map();
  let n = 0;
  const session = (key, { tool = 'claude-code', lastAt = '2025-03-10T12:00:00.000Z', priv = false } = {}) => {
    sessions.push({ key, tool, private: priv, repo: priv ? null : 'your-project', repoRole: priv ? 'display' : 'featured', endState: 'last-turn-ended', firstAt: '2025-03-10T09:00:00.000Z', lastAt, thread: `th-${key}` });
    agents.push({ key: `${key}:main`, session: key, kind: 'main' });
  };
  const ev = (kind, s, t, { line, facts = {}, raw = null, command = null, end = null } = {}) => {
    const e = { id: `${s}.${line ?? ++n}.0`, kind, t, at: new Date(t).toISOString(), source: s, session: s, agent: `${s}:main`, actor: kind === 'prompt' ? 'person' : 'agent', evidence: 'recorded', refs: [{ src: s, line: line ?? n }], facts, derived: {}, inferred: [], missing: [] };
    if (end) e.end = { t: end, at: new Date(end).toISOString(), ref: { src: s, line: (line ?? n) + 1 } };
    if (raw) Object.defineProperty(e, '_raw', { value: raw, enumerable: false });
    if (command) Object.defineProperty(e, '_command', { value: command, enumerable: false });
    events.push(e);
    return e;
  };
  const prompt = (s, t, text, line) => ev('prompt', s, t, { line, facts: { text }, raw: { text } });
  const shell = (s, t, cmd, line) => ev('action', s, t, { line, facts: { tool: 'Bash', category: 'shell', command: cmd, result: 'ok' }, end: t + 2000, raw: { input: { command: cmd }, tool: 'Bash' }, command: cmd });
  const log = (s, recs) => {
    const f = join(dir, `${s}.jsonl`);
    writeFileSync(f, jsonl(recs));
    files.set(s, f);
  };
  const build = () => {
    events.sort((a, b) => a.t - b.t);
    const h = { window: WINDOW, sessions, agents, events, lookup: () => ({ sessions: [] }) };
    Object.defineProperty(h, '_raw', { value: { cwdOfSource: new Map(sessions.map((s) => [s.key, '/work/your-project'])), fileOfSource: files }, enumerable: false });
    return h;
  };
  const exec = (s, t, text, line) => ev('delegation-received', s, t, { line, facts: { from: 'codex-exec', text }, raw: { text } });
  return { session, prompt, exec, shell, log, build };
}

test('a whole run: each tagged session says whether the fix fired and whether the problem showed up anyway', () => {
  const dir = makeTempDir('hw-fix-tests-');
  const w = week(dir);
  const v = fixVersion(DRAFTS['destructive-command']);
  const tag = testTag('destructive-command', v);
  const ask = `In a new empty folder: run git init, commit one file, then git reset --hard. ${tag}`;
  const hookRec = { type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', content: [SAY] } };
  // A: the hook fired, and a destructive command ran anyway: the problem is seen.
  w.session('cc-a');
  w.prompt('cc-a', min(0), ask, 2);
  w.shell('cc-a', min(1), 'git push --force origin main', 4);
  w.log('cc-a', [{ type: 'summary' }, { type: 'user', message: { role: 'user', content: ask } }, hookRec, { type: 'assistant' }]);
  // B: Codex, the hook's context arrived, nothing risky ran: not seen. The tag twice counts once.
  w.session('cx-b', { tool: 'codex' });
  w.prompt('cx-b', min(10), ask, 1);
  w.prompt('cx-b', min(12), ask, 3);
  w.log('cx-b', [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: ask }] } }, { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: SAY }] } }]);
  // C: no hook record, and the session wrote within the hour before the build: may still be running.
  w.session('cc-c', { lastAt: new Date(BUILT - 10 * 60e3).toISOString() });
  w.prompt('cc-c', min(20), ask, 1);
  w.log('cc-c', [{ type: 'user', message: { role: 'user', content: ask } }]);
  // D: an earlier version of the fix, and its log isn't on the list of files: unread.
  w.session('cc-d');
  w.prompt('cc-d', min(30), `Reset it. ${testTag('destructive-command', v === '0000' ? '1111' : '0000')}`, 1);
  // E: a tag for a pattern that doesn't exist, and one outside the window: neither counts.
  w.session('cc-e');
  w.prompt('cc-e', min(40), 'x [honestweek check: no-such-pattern abcd]', 1);
  w.prompt('cc-e', WINDOW.endT + 60e3, `late ${tag}`, 2);
  // F: a `codex exec` run started with the tagged prompt as its instruction: a test too.
  w.session('cx-f', { tool: 'codex' });
  w.exec('cx-f', min(50), ask, 1);
  w.log('cx-f', [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: ask }] } }, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: `Tool call blocked by PreToolUse hook: ${SAY}` } }]);
  const r = runProblems(w.build(), { builtT: BUILT });
  const p = r.patterns.find((x) => x.id === 'destructive-command');
  assert.equal(p.fixVersion, v);
  assert.equal(p.testTag, tag);
  const by = Object.fromEntries(p.fixTests.map((t) => [t.session, t]));
  assert.deepEqual(p.fixTests.map((t) => t.session), ['cc-a', 'cx-b', 'cc-c', 'cc-d', 'cx-f'], 'in time order, once per session');
  assert.deepEqual([by['cx-f'].fired, by['cx-f'].problem.state], [{ state: 'fired', level: 'recorded' }, 'not-seen'], 'a refused step in a codex exec run');
  assert.deepEqual([by['cc-a'].fired, by['cc-a'].problem.state], [{ state: 'fired', level: 'recorded' }, 'seen']);
  assert.equal(by['cc-a'].problem.count, 1);
  assert.deepEqual([by['cx-b'].tool, by['cx-b'].fired.state, by['cx-b'].problem], ['codex', 'fired', { state: 'not-seen', level: 'inferred' }]);
  assert.deepEqual([by['cc-c'].fired.state, by['cc-c'].problem], ['none', { state: 'unknown', level: 'missing', why: 'running' }]);
  assert.deepEqual([by['cc-d'].version === v, by['cc-d'].fired], [false, { state: 'unknown', level: 'missing', why: 'unread' }]);
  assert.equal(by['cc-a'].event, 'cc-a.2.0');
  assert.equal(by['cc-a'].thread, 'th-cc-a');
  // A pattern with a test prompt carries its tag even untested; one with no check has no prompt and no tag.
  const untested = r.patterns.find((x) => x.id === 'action-loop');
  assert.deepEqual([untested.fixTests, untested.testTag], [[], testTag('action-loop', fixVersion(DRAFTS['action-loop']))]);
  for (const x of r.patterns.filter((y) => !PATTERN_CHECKS[y.id])) assert.equal('testTag' in x, false, x.id);
  // What leaves the run is ids, times and fixed words: no text from the log.
  assert.doesNotMatch(JSON.stringify(p.fixTests), /git reset|can't be undone|new empty folder/);
});

test('the route sends each test by its shape: fixed words, ids and times, and drops anything else', () => {
  const good = { pattern: 'p1', version: 'ab12', session: 's1', thread: 'th-1', event: 's1.2.0', at: '2025-03-10T09:00:00.000Z', tool: 'codex', fired: { state: 'fired', level: 'recorded' }, problem: { state: 'not-seen', level: 'inferred' } };
  const result = { window: {}, catalog: {}, groups: [], priorityRule: null, statusCounts: {}, coverage: {}, rules: {}, checks: [], patterns: [{ id: 'p1', name: 'A pattern', group: 'g', looksLike: '', whyItMatters: '', strength: 'reported', strengthReason: '', sourceKinds: {}, sources: [], detection: { level: 'derived', summary: '', signals: [], falsePositives: [] }, mitigation: [], related: [], status: 'clear', findings: [], testPrompt: 'Try it.', fixVersion: 'ab12', testTag: '[honestweek check: p1 ab12]', fixTests: [good, { ...good, session: 'bad id with spaces' }, { ...good, version: 'zzzz' }, { ...good, event: 's1.3.0', fired: { state: 'secret words', level: 'recorded', why: 'whatever' }, problem: { state: 'seen', level: 'derived', count: 2, note: 'log text' } }] }] };
  const problems = createProblemsRoute({ run: () => result });
  const ctx = { mode: 'redacted', b: { eventsById: new Map() }, h: { threads: [] }, sessionByKey: new Map(), redact: (s) => s };
  const helpers = { redactedH: {}, builtT: 0, goalsOf: () => [], membersOfGoal: () => null, evidenceKey: {}, idOk: () => true };
  const p = problems(ctx, new URLSearchParams(), helpers).patterns[0];
  assert.equal(p.fixVersion, 'ab12');
  assert.equal(p.testTag, '[honestweek check: p1 ab12]');
  assert.equal(p.fixTests.length, 2, 'a bad id or version drops the test');
  assert.deepEqual(p.fixTests[0], { version: 'ab12', session: 's1', thread: 'th-1', event: 's1.2.0', at: '2025-03-10T09:00:00.000Z', tool: 'codex', fired: { state: 'fired', level: 'recorded' }, problem: { state: 'not-seen', level: 'inferred' } });
  assert.deepEqual([p.fixTests[1].fired, p.fixTests[1].problem], [{ level: 'recorded' }, { state: 'seen', level: 'derived', count: 2 }], 'only the fixed words go out');
});
