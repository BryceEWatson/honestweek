// A timeline view per problem (lib/problems/scope.mjs): each check's kind, the scope each kind
// works out from a made-up finding and its history, the fallback, captions built only from numbers
// the finding or the log records, and on the demo week the long-session finding framed from the
// crossing to the session's end with the stretch shaded, and a claim framed with the prompt before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import '../lib/view/assets/replay-model.js';
import { buildDemoWeek } from '../lib/demo/week.mjs';
import { CHECKS, fmtDur, UPDATE_PLACE } from '../lib/problems/checks.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { historyIndex, SCOPE_KINDS, scopeHeld, scopeOf } from '../lib/problems/scope.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const M = globalThis.HWReplayModel;
const KINDS = ['moment', 'stretch', 'repeat', 'hand-off', 'turn-end'];

// ---- a made-up history -------------------------------------------------------------------------

const T = Date.parse('2025-03-10T09:00:00.000Z');
const at = (s) => T + s * 1000;
const iso = (s) => new Date(at(s)).toISOString();
const S = 'cc-aaaaaaaa';
const MAIN = `${S}:main`;
const HELP = 'cc-bbbbbbbb';
const ev = (id, s, kind, extra = {}) => ({ id, t: at(s), kind, session: S, agent: MAIN, actor: kind === 'prompt' ? 'person' : kind === 'turn-end' ? 'harness' : 'agent', facts: {}, ...extra });
const done = (s) => ({ end: { t: at(s) } });
const events = [
  ev('p1', 0, 'prompt'),
  ev('a1', 10, 'action', done(12)),
  ev('a2', 20, 'action', done(21)),
  ev('a3', 30, 'action', done(31)),
  ev('run', 40, 'action', { ...done(50), derived: { tests: { pass: 12, fail: 1 } } }),
  ev('m1', 60, 'message'),
  ev('te', 61, 'turn-end'),
  ev('p2', 360, 'prompt'),
  ev('spawn', 370, 'action', done(371)),
  ev('h1', 372, 'delegation-received', { agent: HELP }),
  ev('h2', 380, 'action', { agent: HELP, ...done(381) }),
  ev('a4', 400, 'action', done(401)),
  ev('m2', 410, 'message'),
  ev('p3', 420, 'prompt'),
  ev('a5', 425, 'action'),
];
// The main agent's model calls: the third passes 150k tokens of context, and three follow it.
const call = (s, line, ctx) => ({ session: S, agent: MAIN, source: S, tool: 'claude-code', lines: [line], t: at(s), input: 0, cacheWrite: 0, cacheRead: ctx, output: 10 });
const history = {
  window: { startT: T - 1000, endT: T + 86400e3 },
  sessions: [{ key: S, lastAt: iso(425) }],
  agents: [{ key: MAIN, kind: 'main', session: S }, { key: HELP, kind: 'subagent', session: S, spawnedBy: 'spawn' }],
  events,
  usage: { calls: [call(5, 1, 40e3), call(15, 2, 90e3), call(32, 3, 151e3), call(41, 4, 152e3), call(55, 5, 155e3), call(62, 6, 156e3)] },
};
const idx = historyIndex(history);
const scope = (f) => scopeOf({ verdictEvidence: 'inferred', ...f }, idx);

// ---- the table ------------------------------------------------------------------------------------

test("every check today has one of the five kinds and a reason, and the table names only real checks", () => {
  const ids = new Set(CHECKS.map((c) => c.id));
  for (const [id, row] of Object.entries(SCOPE_KINDS)) {
    assert.ok(ids.has(id), `${id} is a check`);
    assert.ok(KINDS.includes(row.kind), `${id}: ${row.kind}`);
    assert.ok(typeof row.why === 'string' && row.why.length > 20, `${id} says why`);
    assert.doesNotMatch(row.why, /—/, `${id}: no em dash`);
  }
  // The twenty checks this table was written for are all placed; a check added later and not yet
  // placed keeps the plain zoom (the fallback test below).
  const placed = ['unverified-done-claim', 'pr-landed-without-tests', 'claim-contradicts-evidence', 'commit-after-failed-test', 'test-tampering', 'action-loop', 'repeated-tool-error', 'subagent-overuse', 'subagent-no-report', 'long-sessions', 're-reads', 'polling', 'context-additions', 'scope-creep', 'outside-edits', 'plan-mode-edit', 'session-ended-mid-step', 'needless-check-in', 'risky-command', 'secret-in-log'];
  for (const id of placed) assert.ok(SCOPE_KINDS[id], `${id} is placed`);
  assert.deepEqual(KINDS.filter((k) => Object.values(SCOPE_KINDS).some((r) => r.kind === k)), KINDS, 'each kind is used');
});

test("docs/local-page.md's table of kinds says what the code does, row for row", () => {
  const doc = readFileSync(new URL('../docs/local-page.md', import.meta.url), 'utf8');
  const rows = [...doc.matchAll(/^\| `([a-z-]+)` \| ([a-z-]+) \| (.+) \|$/gm)].filter((m) => m[1] in SCOPE_KINDS);
  assert.deepEqual(rows.map((m) => m[1]).sort(), Object.keys(SCOPE_KINDS).sort(), 'a row for each placed check');
  for (const [, id, kind, why] of rows) assert.deepEqual([kind, why], [SCOPE_KINDS[id].kind, SCOPE_KINDS[id].why], id);
});

// ---- each kind, from made-up findings -------------------------------------------------------------

test('a moment: the evidence steps, first to last, and the prompt before them', () => {
  const s = scope({ check: 'risky-command', event: 'a2', kind: 'hard-reset' });
  assert.equal(s.kind, 'moment');
  assert.deepEqual(s.steps, ['a2']);
  assert.equal(s.prompt, 'p1', "the prompt that opened the turn, so you can see whether it was asked for");
  assert.deepEqual([s.from, s.to, s.anchor], [at(0), at(21), 'a2']);
  assert.equal(s.caption, 'A command that reads as a hard reset ran');
  assert.equal(s.level, 'inferred');
  assert.equal(s.stretch, null);
  // A claim after a failed check: the run and the claim, in time order, with the turn's prompt.
  const c = scope({ check: 'claim-contradicts-evidence', event: 'm1', related: 'run', kind: 'claims success' });
  assert.deepEqual(c.steps, ['run', 'm1']);
  assert.deepEqual([c.prompt, c.from, c.to, c.anchor], ['p1', at(0), at(60), 'm1']);
  assert.equal(c.caption, 'A check failed (1 failed, 12 passed), then the last message claims success');
  // When the question is itself one of the steps, it's the prompt before them.
  const q = scope({ check: 'scope-creep', event: 'a1', related: 'p1', events: ['a2', 'a1'], steps: 2 });
  assert.deepEqual(q.steps, ['p1', 'a1', 'a2']);
  assert.equal(q.prompt, 'p1');
  assert.equal(q.caption, 'Your prompt read as a question, and 2 edits followed');
  // The prompt is the one before the steps, never a later one.
  assert.equal(scope({ check: 'risky-command', event: 'a4', kind: 'force-push' }).prompt, 'p2');
});

test('a stretch: from where it started to where it ended, shaded, with its start marked', () => {
  const s = scopeOf({ check: 'long-sessions', verdictEvidence: 'derived', event: 'a3', at: iso(32), lastAt: iso(425), stepsNear: true, kind: 'context past the threshold' }, idx);
  assert.equal(s.kind, 'stretch');
  assert.deepEqual(s.steps, ['a3']);
  assert.equal(s.anchor, 'a3', 'the step nearest where it crossed is the start');
  assert.deepEqual(s.stretch, { from: at(32), to: at(425), agent: MAIN });
  assert.deepEqual([s.from, s.to], [at(30), at(425)]);
  // The count comes from the recorded model calls: three after the one that crossed.
  assert.equal(s.caption, 'Passed 150k tokens of context here, then 3 more model calls');
  assert.equal(s.level, 'derived');
});

test('a repeat: first to last repetition, the steps in order; the caption counts what the check matched', () => {
  const s = scope({ check: 'action-loop', verdictEvidence: 'derived', event: 'a1', events: ['a3', 'a1', 'a2'], steps: 3, kind: 'same call repeated', at: iso(10), lastAt: iso(30) });
  assert.equal(s.kind, 'repeat');
  assert.deepEqual(s.steps, ['a1', 'a2', 'a3']);
  assert.deepEqual([s.from, s.to, s.prompt], [at(10), at(31), null]);
  assert.equal(s.caption, 'The same call ran 3 times, with nothing changed between');
  assert.equal(s.level, 'derived');
  // A check that matched more than it recorded: the caption says what it matched.
  assert.equal(scope({ check: 're-reads', event: 'a1', events: ['a1', 'a2'], steps: 60 }).caption, 'The same file and range read 60 times, with no recorded edit between');
});

test('output per call: the caption counts model calls, not the tool calls they issued', () => {
  // One model call that issued three tool calls is one model call.
  assert.equal(scope({ check: 'output-per-call', event: 'a1', events: ['a1', 'a2', 'a3'], steps: 3, calls: 1 }).caption, 'A model call that wrote far more per tool call than this session usually does');
  assert.equal(scope({ check: 'output-per-call', event: 'a1', events: ['a1', 'a2', 'a3'], steps: 3, calls: 2 }).caption, '2 model calls that wrote far more per tool call than this session usually does');
  assert.equal(scope({ check: 'output-per-call', event: 'a1', events: ['a1', 'a2'], steps: 2 }).caption, 'Model calls that wrote far more per tool call than this session usually does', 'no count recorded, none stated');
});

test('secret-shaped text in a progress update: the caption names the place and that it is inferred', () => {
  assert.equal(scope({ check: 'secret-in-log', event: 'a1', events: ['a1'], steps: 1, kind: UPDATE_PLACE }).caption, 'Secret-shaped text in an agent progress update (inferred from position)');
});

test('a hand-off: from the helper starting to the parent carrying on, with the gap marked', () => {
  const s = scope({ check: 'subagent-no-report', verdictEvidence: 'missing', event: 'spawn' });
  assert.equal(s.kind, 'hand-off');
  assert.deepEqual(s.steps, ['spawn']);
  assert.deepEqual([s.helper, s.parent], ['h2', 'a4'], "the helper's last record and the parent's next one");
  assert.deepEqual(s.gap, { from: at(381), to: at(400) });
  assert.deepEqual([s.from, s.to], [at(370), at(400)]);
  assert.equal(s.caption, 'A helper started here; its last record came 10 s later, and no hand-back is recorded');
  assert.equal(s.level, 'missing', 'a missing record stays missing');
});

test("a turn ending: the turn's last message and your next prompt, with the wait between", () => {
  const s = scope({ check: 'needless-check-in', event: 'm1', related: 'p2' });
  assert.equal(s.kind, 'turn-end');
  assert.deepEqual(s.steps, ['m1', 'p2']);
  assert.deepEqual([s.anchor, s.next], ['m1', 'p2']);
  assert.deepEqual(s.gap, { from: at(60), to: at(360) });
  assert.equal(s.caption, 'The turn ended on a question, and your go-ahead came 5 min later');
  // The other two forms say what the turn ended on, not a question.
  assert.equal(scope({ check: 'needless-check-in', event: 'm1', related: 'p2', kind: 'ended on an offer to carry on' }).caption, 'The turn ended on an offer to carry on, and your go-ahead came 5 min later');
  assert.equal(scope({ check: 'needless-check-in', event: 'm1', related: 'p2', kind: 'ended on a list of options' }).caption, 'The turn ended on a list of options, and your go-ahead came 5 min later');
  // A session's last record: from the turn's last message to the session's last record.
  const e = scope({ check: 'session-ended-mid-step', event: 'a5', kind: 'last-record-is-action' });
  assert.equal(e.kind, 'turn-end');
  assert.deepEqual([e.anchor, e.message, e.next], ['a5', null, null]);
  assert.equal(e.prompt, 'p3', "with no message in the turn, it opens at the turn's prompt");
  assert.deepEqual([e.from, e.to], [at(420), at(425)]);
  assert.equal(e.caption, "The session's last work record is a step with a result, and no turn end after it");
  const m = scope({ check: 'session-ended-mid-step', event: 'te', kind: 'last-record-is-message' });
  assert.equal(m.message, 'm1', "the turn's last message, when the last record isn't it");
  assert.equal(m.from, at(60));
});

test('the fallback: a check with no kind, or steps the history lacks, keep the plain zoom', () => {
  assert.equal(scope({ check: 'a-check-added-later', event: 'a1' }), null);
  assert.equal(scope({ check: 'risky-command', event: 'nowhere' }), null);
  assert.equal(scopeOf({ check: 'risky-command', event: 'a1' }, historyIndex({})), null, 'an empty history');
  assert.equal(scopeOf({ check: 'risky-command', event: 'a1' }, null), null);
  assert.equal(scope({ check: 'long-sessions', event: 'a3', at: 'not a time', lastAt: iso(425) }), null, 'a stretch with no start');
  // A build that lacks some steps: they drop, and a named step it lacks is null.
  const s = scope({ check: 'claim-contradicts-evidence', event: 'm1', related: 'run', kind: 'claims success' });
  const held = scopeHeld(s, (id) => id !== 'run' && id !== 'p1');
  assert.deepEqual([held.steps, held.prompt, held.anchor], [['m1'], null, 'm1']);
  assert.equal(scopeHeld(s, () => false), null);
  assert.equal(scopeHeld(null, () => true), null);
});

test('a caption carries only numbers the finding or the log records', () => {
  // The note's own numbers (an estimate, a count) never leak into a caption that doesn't use them.
  const s = scope({ check: 'outside-edits', event: 'a1', events: ['a1', 'a2'], steps: 2, note: '2 edits outside the folder: 9,999 bytes and 42k tokens.' });
  assert.equal(s.caption, '2 edits outside the folder the session started in');
  // A claim with no test counts recorded says none.
  assert.equal(scope({ check: 'claim-contradicts-evidence', event: 'm1', related: 'a3', kind: 'claims success' }).caption, 'A check failed, then the last message claims success');
  // A long session with no model calls recorded gives no count.
  const bare = historyIndex({ ...history, usage: null });
  assert.equal(scopeOf({ check: 'long-sessions', event: 'a3', at: iso(32), lastAt: iso(425) }, bare).caption, 'Passed 150k tokens of context here');
});

// ---- the demo week ------------------------------------------------------------------------------

const demo = buildDemoWeek({ root: join(makeTempDir('hw-scope-'), 'week') });
const h = await buildWorkHistory({ config: demo.config, from: demo.week.from, to: demo.week.to, timezone: demo.week.timezone, roots: demo.roots, usage: true, keepRaw: true, hiddenSessions: 'redacted' });
const result = runProblems(h, { builtT: Date.parse('2026-01-01T00:00:00Z') });
const didx = historyIndex(h);
const all = result.patterns.flatMap((p) => p.findings);
const byId = new Map(h.events.map((e) => [e.id, e]));

test('on the demo week every finding of a placed check gets a scope of its kind, ringing only its own steps', () => {
  assert.ok(all.length > 20);
  for (const f of all) {
    const s = scopeOf(f, didx);
    assert.ok(s, `${f.check}: a scope`);
    assert.equal(s.kind, SCOPE_KINDS[f.check].kind);
    const own = new Set([f.event, f.related, ...(f.events ?? [])].filter(Boolean));
    assert.ok(s.steps.every((id) => own.has(id)), `${f.check}: only steps the check recorded are ringed`);
    assert.ok(s.from <= s.to && s.from <= Math.min(...s.steps.map((id) => byId.get(id).t)), `${f.check}: the frame holds its steps`);
    assert.ok(s.caption && !/\bundefined\b|NaN/.test(s.caption), `${f.check}: "${s.caption}"`);
  }
  assert.deepEqual([...new Set(all.map((f) => SCOPE_KINDS[f.check].kind))].sort(), [...KINDS].sort(), 'every kind shows up in the demo');
});

test('the long-session finding frames from the crossing to the session\'s end, with the stretch shaded', () => {
  const bloat = result.patterns.find((p) => p.id === 'context-bloat').findings;
  assert.equal(bloat.length, 2);
  for (const f of bloat) {
    const s = scopeOf(f, didx);
    const session = h.sessions.find((x) => x.key === f.session);
    assert.equal(s.kind, 'stretch');
    assert.equal(s.stretch.from, Date.parse(f.at), 'the stretch starts where the context passed 150k tokens');
    assert.equal(s.stretch.to, Date.parse(session.lastAt), "and runs to the session's last record");
    assert.equal(s.to, Date.parse(session.lastAt));
    assert.deepEqual(s.steps, [f.event], 'only the step nearest the crossing is ringed');
    // The count is the check's own: the note says the same number.
    const after = Number(f.note.match(/then made (\d+) more calls/)[1]);
    assert.equal(s.caption, `Passed 150k tokens of context here, then ${after} more model calls`);
    // The old zoom framed about half a minute around that one step; the stretch runs on.
    assert.ok(s.to - s.from > 20 * 60e3, `${Math.round((s.to - s.from) / 60e3)} min`);
    // Replay's model: the view covers the whole stretch, and the agent's steps inside it stand out.
    const S = M.readScope(s, { has: (id) => byId.has(id), tOf: (id) => byId.get(id).t });
    const [v0, v1] = M.scopeFrame(S);
    assert.ok(v0 < s.stretch.from && v1 > s.stretch.to);
    const inside = h.events.filter((e) => e.session === f.session && M.scopeRole(S, e) === 'stretch');
    assert.ok(inside.length >= 30, `${inside.length} steps of the agent inside the stretch`);
    assert.ok(inside.every((e) => e.agent === s.stretch.agent && e.t >= s.stretch.from && e.t <= s.stretch.to));
  }
});

test('a claim after a failed check frames the moment with the prompt that opened its turn', () => {
  const claims = all.filter((f) => f.check === 'claim-contradicts-evidence');
  assert.ok(claims.length >= 3);
  for (const f of claims) {
    const s = scopeOf(f, didx);
    assert.equal(s.kind, 'moment');
    assert.deepEqual(s.steps, [f.related, f.event], 'the failed check, then the claim');
    const p = byId.get(s.prompt);
    assert.ok(p && p.kind === 'prompt' && p.session === f.session, 'a prompt of the same session');
    assert.ok(p.t <= byId.get(f.related).t);
    const between = h.events.filter((e) => e.session === f.session && e.kind === 'prompt' && e.actor === 'person' && e.t > p.t && e.t <= byId.get(f.event).t);
    assert.deepEqual(between, [], 'no other prompt of yours between it and the claim: it opened the turn');
    assert.equal(s.from, p.t);
    assert.ok(s.to >= byId.get(f.event).t);
  }
});

test("on the demo week each caption's numbers are the finding's, its note's, a recorded test count or a time between its named steps", () => {
  const nums = (t) => (String(t ?? '').match(/\d[\d,.]*[kMB]?/g) ?? []).map((x) => x.replace(/[.,]$/, ''));
  for (const f of all) {
    const s = scopeOf(f, didx);
    const allowed = new Set([...nums(f.note), String(f.steps ?? ''), String((f.events ?? []).length)]);
    const run = byId.get(f.related)?.derived?.tests;
    if (run) for (const k of ['pass', 'fail']) allowed.add(String(run[k] ?? 0));
    // A duration only between two steps the scope names, from their recorded times.
    const named = [s.anchor, s.prompt, s.next, s.message, s.helper, s.parent, ...s.steps].filter(Boolean).map((id) => byId.get(id));
    for (const a of named) for (const b of named) for (const x of [b.t, b.end?.t].filter(Number.isFinite)) for (const n of nums(fmtDur(x - a.t))) allowed.add(n);
    for (const n of nums(s.caption)) assert.ok(allowed.has(n), `${f.check}: "${n}" in "${s.caption}" isn't a recorded number`);
  }
});
