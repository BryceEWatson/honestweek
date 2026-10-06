// Who sent a Claude Code user record, by its `turnOrigin` field: "human" is a person (recorded),
// "sdk" a program (a script, the Agent SDK, a headless `claude -p` run, or another session
// through one) and never the person's prompt, "task_notification" a notice. A value this engine
// doesn't know keeps the unknown-origin rule, and a log with no such field reads as before.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { parseClaudeSource } from '../lib/replay/claude.mjs';
import { describe } from '../lib/replay/views.mjs';
import { createContext, isExecInstruction, isPersonPrompt } from '../lib/problems/context.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { whoOf } from '../lib/view/replay-export.mjs';
import { buildWordIndex } from '../lib/view/word-index.mjs';
import { LEGACY, IDS, WINDOW, normalizeReading, writeTurnOriginLogs } from './fixtures/replay/turn-origin.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

let root;
let w;
let h;
const of = (key, kind) => h.events.filter((e) => e.session === key && (!kind || e.kind === kind));
const turns = (key) => of(key).filter((e) => ['prompt', 'command', 'notice', 'notification', 'agent-message', 'delegation-received'].includes(e.kind));
const authorship = (e) => (e.inferred ?? []).find((x) => x.key === 'authorship') ?? null;

before(async () => {
  root = makeTempDir('hw-turn-origin-');
  w = writeTurnOriginLogs(root);
  h = await buildWorkHistory({ config: w.config, from: WINDOW.from, to: WINDOW.to, roots: w.roots, git: false, usage: true, keepRaw: true });
});
after(() => removeTempDir(root));

test('turnOrigin "human": the person typed it, recorded, with or without the origin object', () => {
  const prompts = of(w.key.typed, 'prompt');
  assert.deepEqual(prompts.map((e) => [e.actor, e.facts.origin, authorship(e)]), [['person', 'human', null], ['person', 'human', null]]);
  assert.equal(h.session(w.key.typed).metrics.prompts.value, 2);
  assert.equal(h.session(w.key.typed).metrics.prompts.evidence, 'recorded');
  // A slash command typed by a person stays the person's.
  assert.deepEqual(turns(w.key.typedCommand).map((e) => [e.kind, e.actor, e.facts.name]), [['command', 'person', '/deploy']]);
});

test('turnOrigin "sdk": a program sent it, so it is never a prompt and never the person\'s', () => {
  const steps = turns(w.key.programText);
  assert.deepEqual(steps.map((e) => [e.kind, e.actor, e.facts.from, e.evidence, e.inferred.length]), [
    ['delegation-received', 'program', 'program', 'recorded', 0],
    ['agent-message', 'program', 'program', 'recorded', 0],
  ]);
  assert.equal(steps[0].facts.text, 'Summarize the open issues in the tracker.');
  assert.equal(steps[1].facts.direction, 'inbound');
  assert.equal(h.session(w.key.programText).metrics.prompts.value, 0);
  assert.match(describe(steps[0]), /^started by a program with instructions "Summarize/);
  assert.match(describe(steps[1]), /^agent message inbound from a program "Yes, go ahead\."/);
  // Both open a turn, the way a codex exec run's instructions do, and neither is a person's prompt.
  assert.ok(steps.every((e) => isExecInstruction(e) && !isPersonPrompt(e)));
  assert.deepEqual(whoOf(steps[0], new Map()), { label: 'a program', evidence: 'recorded', rule: null });
  // A slash command a program sent is the program's.
  const cmd = turns(w.key.programCommand);
  assert.deepEqual(cmd.map((e) => [e.kind, e.actor, e.facts.from, e.facts.name]), [['command', 'program', 'program', '/review']]);
  assert.match(describe(cmd[0]), /^slash command sent by a program \/review/);
  // The agent's replies in a turn a program opened go to the program, not to the person.
  const replies = (key) => of(key, 'message').map((e) => e.facts.to);
  assert.deepEqual([replies(w.key.programText), replies(w.key.programCommand)], [['program', 'program'], ['program']]);
  assert.match(describe(of(w.key.programCommand, 'message')[0]), /^reply to the program that sent the turn "Nothing uncommitted/);
  assert.deepEqual(replies(w.key.typedCheckIn), ['person', 'person']);
});

test('turnOrigin "task_notification" is a notice, and a value this engine does not know keeps the unknown-origin rule', () => {
  const steps = turns(w.key.otherValues);
  assert.deepEqual(steps.map((e) => e.kind), ['prompt', 'notification', 'prompt']);
  const unknown = steps[2];
  assert.equal(unknown.actor, 'person');
  assert.equal(unknown.facts.origin, 'system');
  assert.equal(authorship(unknown)?.rule, 'prompt.authorship.unknown-origin');
  assert.equal(h.session(w.key.otherValues).metrics.prompts.evidence, 'inferred');
});

// Invariant 6: a log with no turnOrigin reads exactly as it did before the engine read the
// field. The fixture was taken from the engine before this change, on these same records.
test('a log with no turnOrigin reads byte for byte as before', () => {
  const keys = LEGACY.map((id) => w.key[Object.keys(IDS).find((n) => IDS[n] === id)]);
  const mine = (k) => keys.includes(k);
  const got = {
    events: normalizeReading(h.events.filter((e) => mine(e.session)), root),
    sessions: h.sessions.filter((s) => mine(s.key)).map(({ key, endState, firstAt, lastAt, tool, agents, title }) => ({ key, endState, firstAt, lastAt, tool, agents, title: title ?? null })),
    metrics: keys.map((k) => normalizeReading(h.session(k).metrics, root)),
  };
  const want = JSON.parse(readFileSync(new URL('./fixtures/turn-origin-legacy-reading.json', import.meta.url), 'utf8'));
  assert.equal(got.events.length, 9);
  assert.deepEqual(got, want);
  // Read without turnOrigin, a command and a prompt with no origin are still the person's.
  assert.deepEqual(of(w.key.legacy, 'prompt').map((e) => authorship(e)?.rule ?? null), ['prompt.authorship.no-origin', null]);
  assert.deepEqual(of(w.key.legacy, 'command').map((e) => e.actor), ['person']);
});

test("a program's go-ahead after the agent's question is not the person's check-in; the same go-ahead typed is", () => {
  const r = runProblems(h, { builtT: Date.parse('2024-07-01T00:00:00Z') });
  const checkIns = r.patterns.find((p) => p.id === 'needless-check-in')?.findings ?? [];
  assert.deepEqual(checkIns.map((f) => f.session), [w.key.typedCheckIn]);
});

test("the sessions list says a program started a session, and a program's command stands in for the title", async () => {
  const data = createViewData({ config: w.config, roots: w.roots, from: WINDOW.from, to: WINDOW.to, timezone: WINDOW.timezone });
  await data.start();
  const ask = async (q = {}) => (await data.route('/api/sessions', new URLSearchParams(q))).body;
  const list = await ask();
  // All eight sessions are on one day, which shows five before "Show 3 more".
  const more = await ask({ day: '2024-06-11', offset: '5' });
  const rows = new Map([...list.days.flatMap((d) => d.rows), ...more.rows].map((r) => [r.session, r]));
  assert.equal(rows.size, 8);
  const row = (k) => rows.get(k);
  assert.deepEqual([row(w.key.programCommand).label, row(w.key.programCommand).startedBy], ['/review, Jun 11, 3:20 PM', { text: 'started by a program: /review', evidence: 'recorded' }]);
  assert.deepEqual([row(w.key.programText).label, row(w.key.programText).startedBy], ['program run, Jun 11, 3:10 PM: “Summarize the open issues in the tracker.”', { text: 'started by a program', evidence: 'recorded' }]);
  // A command typed by a person, with or without turnOrigin, keeps its label.
  for (const k of [w.key.typedCommand, w.key.legacyCommand]) assert.match(row(k).startedBy.text, /^started with a command \(\/deploy\), no prompt$/);
  assert.equal(row(w.key.typed).startedBy, null);
  assert.equal(row(w.key.typed).prompts.value, 2);
});

test("word search reads a program's turn as nobody's words", async () => {
  const index = await buildWordIndex({ roots: w.roots, startT: Date.parse(`${WINDOW.from}T00:00:00Z`), endT: Date.parse('2024-06-17T00:00:00Z') });
  const texts = index.sessions.flatMap((s) => s.prompts.map((p) => p.text));
  assert.ok(texts.includes('Add a --dry-run flag to the release script.'));
  assert.ok(texts.includes('Yes, go ahead.'), 'the go-ahead a person typed is found');
  assert.equal(texts.filter((t) => t === 'Yes, go ahead.').length, 1, "the program's go-ahead is not");
  assert.ok(!texts.some((t) => /^Background command/.test(t)), 'a notice is not');
});

test('an older log whose first prompt was typed mid-turn joins no hand-off, as before', async () => {
  // A command opens it, a message typed while the agent was busy is prompt 1, and the next
  // prompt is prompt 2: the first-prompt join stays empty, as it was before turnOrigin was read.
  const file = join(root, 'midturn.jsonl');
  const at = (s) => `2024-06-11T09:00:${String(s).padStart(2, '0')}.000Z`;
  const rec = (type, extra, t, n) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/path/to/your/repo', sessionId: 'midturn', type, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: at(t), ...extra });
  const say = (t, n) => rec('assistant', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'model-a', content: [{ type: 'text', text: 'Working on it.' }] } }, t, n);
  writeFileSync(file, `${[
    rec('user', { message: { role: 'user', content: '<command-name>/review</command-name>' } }, 0, 1),
    say(1, 2),
    rec('attachment', { attachment: { type: 'queued_command', prompt: 'also check the docs' } }, 2, 3),
    say(3, 4),
    rec('user', { message: { role: 'user', content: 'Now open the pull request.' } }, 4, 5),
  ].join('\n')}\n`);
  const source = { key: 'cc-midturn', sessionKey: 'cc-midturn', file, role: 'session', tool: 'claude-code' };
  const out = await parseClaudeSource(source, { redact: (x) => x, cwd: '/path/to/your/repo', agentKey: 'cc-midturn:main', sidechainAgentKey: 'cc-midturn:sidechain' });
  assert.deepEqual(out.events.filter((e) => e.kind === 'prompt').map((e) => e.facts.index), [1, 2]);
  assert.equal(out.joins.firstPromptDigest, null);
  assert.equal(out.joins.firstPromptEvent, null);
});

test("a program's slash command opens a turn for the Problems checks, as a codex exec run's instruction does", () => {
  const c = createContext(h, { builtT: Date.parse('2024-07-01T00:00:00Z') });
  const turns = c.turnsOf(w.key.programCommand);
  assert.deepEqual(turns.map((t) => [t.prompt.kind, t.prompt.actor, t.steps.length > 0]), [['command', 'program', true]]);
  assert.ok(isExecInstruction(turns[0].prompt) && !isPersonPrompt(turns[0].prompt));
  // A command you typed opens no turn there, as before.
  assert.equal(c.turnsOf(w.key.typedCommand).length, 0);
});

/** Reads made-up Claude Code records, one session, straight through the parser. */
async function parseRecords(name, records) {
  const file = join(root, `${name}.jsonl`);
  const at = (s) => `2024-06-11T10:00:${String(s).padStart(2, '0')}.000Z`;
  let n = 0;
  const lines = records.map(([type, t, extra]) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/path/to/your/repo', sessionId: name, version: '2.1.0', type, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, timestamp: at(t), ...extra }));
  writeFileSync(file, `${lines.join('\n')}\n`);
  const source = { key: `cc-${name}`, sessionKey: `cc-${name}`, file, role: 'session', tool: 'claude-code' };
  return parseClaudeSource(source, { redact: (x) => x, cwd: '/path/to/your/repo', agentKey: `cc-${name}:main`, sidechainAgentKey: `cc-${name}:sidechain` });
}
const said = (id, text) => ['assistant', 0, { message: { id, type: 'message', role: 'assistant', model: 'model-a', content: [{ type: 'text', text }] } }];
const timed = (rec, t) => [rec[0], t, rec[2]];

test("a background task's notice in a run a program started keeps the program as the turn's party", async () => {
  // The shape of a headless review run: a program's first turn, a background task, its notice
  // delivered as a turn of its own, and the agent's report after it.
  const out = await parseRecords('program-notice', [
    ['user', 0, { turnOrigin: 'sdk', message: { role: 'user', content: 'Review the changes on this branch.' } }],
    timed(said('m1', 'Started the tests in the background.'), 1),
    ['user', 2, { turnOrigin: 'task_notification', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n<summary>Tests finished</summary>\n</task-notification>' } }],
    timed(said('m2', 'The tests pass; the review is clean.'), 3),
  ]);
  assert.deepEqual(out.events.filter((e) => ['delegation-received', 'notification'].includes(e.kind)).map((e) => e.kind), ['delegation-received', 'notification']);
  assert.deepEqual(out.events.filter((e) => e.kind === 'message').map((e) => e.facts.to), ['program', 'program']);
  // In a person's session the reply after a notice is still to the person.
  const mine = await parseRecords('person-notice', [
    ['user', 0, { turnOrigin: 'human', origin: { kind: 'human' }, message: { role: 'user', content: 'Run the tests in the background.' } }],
    ['user', 2, { turnOrigin: 'task_notification', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' } }],
    timed(said('m2', 'They pass.'), 3),
  ]);
  assert.deepEqual(mine.events.filter((e) => e.kind === 'message').map((e) => e.facts.to), ['person']);
});

test("a message a program sent while the agent was busy is queued as the program's, not the person's", async () => {
  const body = 'Also check the changelog.';
  const out = await parseRecords('program-queued', [
    ['user', 0, { turnOrigin: 'sdk', message: { role: 'user', content: 'Review the changes on this branch.' } }],
    ['queue-operation', 1, { operation: 'enqueue', content: body }],
    timed(said('m1', 'Reviewed the code.'), 2),
    ['queue-operation', 3, { operation: 'dequeue' }],
    ['user', 3, { turnOrigin: 'sdk', message: { role: 'user', content: body } }],
    timed(said('m2', 'The changelog is current.'), 4),
  ]);
  const queued = out.events.filter((e) => e.kind === 'queue');
  assert.deepEqual(queued.map((e) => [e.facts.state, e.actor]), [['delivered', 'program'], ['delivered', 'harness']]);
  const msg = out.events.find((e) => e.kind === 'agent-message');
  assert.deepEqual([msg.actor, msg.facts.from, msg.facts.queuedAt], ['program', 'program', '2024-06-11T10:00:01.000Z']);
  assert.equal(out.events.filter((e) => e.kind === 'prompt').length, 0);
  assert.deepEqual(out.events.filter((e) => e.kind === 'message').map((e) => e.facts.to), ['program', 'program']);
});

test('an empty record with turnOrigin "human" and no origin object is a person\'s notice, as one with the origin object is', async () => {
  // The harness writes a record with no text for an action a person took (starting a suggested
  // task, say). With only turnOrigin to say who, it reads as the origin object's version does;
  // an empty record that says neither stays ignored, as before turnOrigin was read.
  const out = await parseRecords('empty-human', [
    ['user', 0, { turnOrigin: 'human', message: { role: 'user', content: '' } }],
    ['user', 1, { turnOrigin: 'human', origin: { kind: 'human' }, message: { role: 'user', content: '' } }],
    ['user', 2, { message: { role: 'user', content: '' } }],
    ['user', 3, { turnOrigin: 'sdk', message: { role: 'user', content: '' } }],
  ]);
  assert.deepEqual(out.events.filter((e) => e.kind !== 'session').map((e) => [e.kind, e.actor, e.facts.origin]), [['notice', 'person', 'human'], ['notice', 'person', 'human']]);
  assert.equal(out.coverage.get('user:empty')?.count, 2);
});
