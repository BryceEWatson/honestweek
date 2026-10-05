// The replay page's pure logic (lib/view/assets/replay-model.js): the time axis with long
// stretches with no new step squeezed into labelled breaks, the steps the agent waited on, the
// story's groups of repeated steps, the Problems row's dots, and the two-way link between a row
// in the story and the step at the playhead. The last test runs it over the made-up demo week's
// "Why the width test is skipped on Windows" session, the session the page's design was drawn from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import '../lib/view/assets/replay-model.js';
import { buildDemoWeek, CODEX_IDS } from '../lib/demo/week.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const M = globalThis.HWReplayModel;
const HERE = dirname(fileURLToPath(import.meta.url));
const page = (f) => readFileSync(join(HERE, '..', 'lib', 'view', 'assets', f), 'utf8');
const MIN = 60e3;
// The page's tick spacing (common.js niceStep): at least ~95 px per label.
const niceStep = (msPerPx) => [10e3, 30e3, 60e3, 5 * MIN, 10 * MIN, 30 * MIN, 3600e3].find((s) => s >= msPerPx * 95) ?? 3600e3;
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);

// ---- idle stretches and the axis ---------------------------------------------------------------

test('a break is a stretch with no new step longer than two minutes or a tenth of the span, whichever is longer', () => {
  // A 60-minute span: the limit is 6 minutes. Steps start at 0, 1, 2 min, then 20, 23 and 60.
  const { gaps, limit } = M.idleGaps([0, MIN, 2 * MIN, 20 * MIN, 23 * MIN, 60 * MIN], 0, 60 * MIN);
  assert.equal(limit, 6 * MIN);
  assert.deepEqual(gaps, [[2 * MIN, 20 * MIN], [23 * MIN, 60 * MIN]], 'the 3-minute stretch stays');
  // A short session: two minutes is the floor.
  assert.equal(M.idleLimit(0, 10 * MIN), 2 * MIN);
  // Starts are what count: a call that ran across the stretch doesn't hide it (its label says so).
  assert.deepEqual(M.idleGaps(M.starts([{ kind: 'action', t: 0, endT: 30 * MIN }, { kind: 'prompt', t: 31 * MIN }]), 0, 31 * MIN).gaps, [[0, 31 * MIN]]);
  // The engine's own "no records" mark never counts as a step starting.
  assert.deepEqual(M.starts([{ kind: 'action', t: 5, endT: 9 }, { kind: 'quiet', t: 10, endT: 500 }, { kind: 'prompt', t: 20 }]), [5, 20]);
});

test('a break is labelled by what filled it: a step in flight, an open helper, a turn with no records, or the wait for your next prompt', () => {
  const gap = [10 * MIN, 30 * MIN];
  const prompt = { id: 'p2', t: 30 * MIN, kind: 'prompt' };
  const cmd = (endT, command = 'node --test') => ({ id: 'c1', t: 10 * MIN, endT, kind: 'action', tool: 'exec_command', facts: { command } });
  // A test run in flight across it: its command and its own recorded span.
  const wait = M.breakLabel(gap, { steps: [cmd(29.5 * MIN), prompt] });
  assert.equal(wait.kind, 'wait');
  assert.equal(wait.text, 'waiting on node --test, 20 min');
  assert.equal(wait.level, 'derived');
  assert.deepEqual(wait.pieces.map(([, logged]) => logged), [false, true, false], "the command is the log's own piece");
  // A long command is cut between words.
  assert.match(M.breakLabel(gap, { steps: [cmd(29 * MIN, 'npm run test:integration -- --runInBand --coverage')] }).text, /^waiting on npm run test:integration --…, 19 min$/);
  // A call whose result came early isn't in flight across it.
  assert.notEqual(M.breakLabel(gap, { steps: [cmd(12 * MIN), prompt] }).kind, 'wait');
  // A helper open across it: started before, no completion until after.
  const helper = { key: 'h1', kind: 'subagent', spawnAt: new Date(5 * MIN).toISOString(), completion: { at: new Date(29 * MIN).toISOString() } };
  assert.equal(M.breakLabel(gap, { steps: [prompt], agents: [helper] }).text, 'helper still open, 20 min');
  // With no completion recorded, its last record decides; one that stopped before the break isn't open.
  assert.equal(M.breakLabel(gap, { steps: [prompt], agents: [{ ...helper, completion: null, lastAt: new Date(28 * MIN).toISOString() }] }).kind, 'helper');
  assert.notEqual(M.breakLabel(gap, { steps: [prompt], agents: [{ ...helper, completion: null, lastAt: new Date(9 * MIN).toISOString() }] }).kind, 'helper');
  // A main agent is never "a helper still open".
  assert.notEqual(M.breakLabel(gap, { steps: [prompt], agents: [{ ...helper, kind: 'main' }] }).kind, 'helper');
  // Inside a turn with nothing in flight: no records, said honestly.
  const turn = { startAt: new Date(5 * MIN).toISOString(), lastRecordAt: new Date(40 * MIN).toISOString() };
  const quiet = M.breakLabel(gap, { steps: [{ id: 'm', t: 30 * MIN, kind: 'message' }], turns: [turn] });
  assert.equal(quiet.text, 'no records, 20 min (not idle, just unrecorded)');
  // After a turn ended, before your next prompt.
  const between = M.breakLabel(gap, { steps: [{ id: 'end', t: 10 * MIN, kind: 'turn-end' }, prompt], turns: [{ startAt: new Date(0).toISOString(), lastRecordAt: new Date(10 * MIN).toISOString() }] });
  assert.equal(between.text, '20 min before your next prompt');
  // Nothing to say what filled it, and no prompt next: no records.
  assert.equal(M.breakLabel(gap, { steps: [{ id: 's', t: 30 * MIN, kind: 'session' }] }).kind, 'unrecorded');
  // A resumed session's start, or a hook, just before your prompt: still the wait for your prompt.
  assert.equal(M.breakLabel(gap, { steps: [{ id: 's', t: 30 * MIN, kind: 'session' }, { id: 'h', t: 30 * MIN + 100, kind: 'hook' }, { id: 'p', t: 30 * MIN + 500, kind: 'prompt' }] }).kind, 'between');
  // First match wins: a step in flight inside a turn is a wait.
  assert.equal(M.breakLabel(gap, { steps: [cmd(29 * MIN), prompt], turns: [turn], agents: [helper] }).kind, 'wait');
  // None of them says "idle" on its own.
  for (const l of [wait, quiet, between]) assert.doesNotMatch(l.text.replace('not idle', ''), /\bidle\b/);
});

test('a step the agent waited on is one with a recorded span of 30 seconds or more', () => {
  const at = (ms) => ({ kind: 'action', t: 1000, endT: 1000 + ms });
  assert.equal(M.isLongWait(at(29999)), false);
  assert.equal(M.isLongWait(at(30000)), true);
  assert.equal(M.isLongWait({ kind: 'action', t: 1000, endT: null }), false, 'no recorded result, no span');
  assert.equal(M.spanOf(at(500)), 500);
  assert.equal(M.spanText(252e3), '4 min 12 s');
  assert.equal(M.spanText(240e3), '4 min');
  assert.equal(M.spanText(12.4e3), '12 s');
  assert.equal(M.spanText(450), '450 ms');
  assert.equal(M.spanText(3900e3), '1 h 5 min');
  assert.equal(M.minText(18.8 * MIN), '19 min');
  // A cut never lands inside a hidden part.
  assert.equal(M.cutWords('curl -H Authorization: [redacted:secret] https://example.com/a/long/path', 30), 'curl -H Authorization:…');
});

test('the axis squeezes each break to a fixed width and maps times true on both sides of it', () => {
  // A busy 10 minutes, 40 idle, a busy 10. 1000 px, breaks 40 px wide.
  const gaps = [[10 * MIN, 50 * MIN]];
  const s = M.makeScale({ v0: 0, v1: 60 * MIN, p0: 100, p1: 1100, gaps, limit: 6 * MIN, breakW: 40 });
  assert.equal(s.compressed, true);
  assert.equal(s.breaks.length, 1);
  const b = s.breaks[0];
  near(b.x1 - b.x0, 40, 'the break is its fixed width');
  // The busy stretches share the other 960 px: 48 px a minute on both sides.
  near(s.k * MIN, 48, 'pixels a minute');
  near(s.x(0), 100, 'the start');
  near(s.x(5 * MIN), 100 + 5 * 48, 'before the break');
  near(s.x(10 * MIN), b.x0, 'the break starts where the stretch before it ends');
  near(s.x(50 * MIN), b.x1, 'the stretch after it starts where the break ends');
  near(s.x(55 * MIN), b.x1 + 5 * 48, 'after the break');
  near(s.x(60 * MIN), 1100, 'the end');
  // Back from pixels to times, either side.
  for (const t of [0, 3 * MIN, 9.5 * MIN, 50.5 * MIN, 58 * MIN]) near(s.t(s.x(t)), t, `t(x(${t}))`);
  // Increasing everywhere, inside the break too.
  let last = -Infinity;
  for (let t = 0; t <= 60 * MIN; t += 15e3) {
    assert.ok(s.x(t) > last, `x grows at ${t}`);
    last = s.x(t);
  }
  // The ticks: round times at their true place, none inside the break, and the first moment
  // after the break labelled.
  const ticks = M.axisTicks(s, niceStep);
  for (const tk of ticks) {
    near(tk.x, s.x(tk.t), `tick at ${tk.t}`);
    assert.ok(!(tk.t > 10 * MIN && tk.t < 50 * MIN), `no tick inside the break: ${tk.t}`);
  }
  assert.ok(ticks.some((tk) => tk.edge && tk.t === 50 * MIN), 'the first moment after the break is a tick');
  assert.ok(ticks.some((tk) => tk.t < 10 * MIN) && ticks.some((tk) => tk.t > 50 * MIN), 'ticks on both sides');
});

test('with no stretch past the limit, or zoomed to a span without one, the axis is linear', () => {
  const lin = M.makeScale({ v0: 0, v1: 10 * MIN, p0: 0, p1: 600, gaps: [], limit: 2 * MIN });
  assert.equal(lin.compressed, false);
  near(lin.x(5 * MIN), 300, 'linear');
  // Zoomed to the first busy stretch of a session with a long gap: the gap is outside the view.
  const gaps = [[10 * MIN, 50 * MIN]];
  const zoomed = M.makeScale({ v0: 2 * MIN, v1: 8 * MIN, p0: 0, p1: 600, gaps, limit: 6 * MIN });
  assert.equal(zoomed.compressed, false);
  near(zoomed.x(5 * MIN), 300, 'linear when zoomed');
  // Zoomed so only 2 minutes of the gap show: shorter than the limit, so no break either.
  const edge = M.makeScale({ v0: 4 * MIN, v1: 12 * MIN, p0: 0, p1: 800, gaps, limit: 6 * MIN });
  assert.equal(edge.compressed, false);
  // Zoomed across the whole gap: still squeezed.
  assert.equal(M.makeScale({ v0: 5 * MIN, v1: 55 * MIN, p0: 0, p1: 800, gaps, limit: 6 * MIN }).compressed, true);
});

// ---- the story's groups -------------------------------------------------------------------------

const step = (id, t, extra = {}) => ({ id, t, kind: 'action', cat: 'shell', agent: 'a:main', ...extra });

test('three or more steps of one kind by one agent, with no finding, become a group', () => {
  const two = M.groupRuns([step('s1', 1), step('s2', 2)]);
  assert.deepEqual(two.map((r) => r.step?.id ?? r.group), ['s1', 's2'], 'two stay apart');
  const three = M.groupRuns([step('s1', 1), step('s2', 2), step('s3', 3)]);
  assert.equal(three.length, 1);
  assert.equal(three[0].group, 's1', "a group's key is its first step");
  assert.deepEqual(three[0].steps.map((e) => e.id), ['s1', 's2', 's3']);
  assert.equal(three[0].kind, 'cat:shell');
});

test('a finding, another kind or another agent breaks a run', () => {
  const ids = (rows) => rows.map((r) => (r.group ? `[${r.steps.map((e) => e.id).join(' ')}]` : r.step.id)).join(' ');
  const run = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => step(id, i));
  // A finding on d: a b c group, d alone, e f g group.
  assert.equal(ids(M.groupRuns(run, { flagged: (e) => e.id === 'd' })), '[a b c] d [e f g]');
  // A finding on c: a b too short, c alone, d e f g group.
  assert.equal(ids(M.groupRuns(run, { flagged: (e) => e.id === 'c' })), 'a b c [d e f g]');
  // Another kind in the middle: a file edit at d.
  const kinds = run.map((e) => (e.id === 'd' ? { ...e, cat: 'edit' } : e));
  assert.equal(ids(M.groupRuns(kinds)), '[a b c] d [e f g]');
  // A test run with a recorded summary is a kind of its own.
  const test2 = run.map((e) => (e.id === 'e' ? { ...e, tests: { pass: 1, fail: 0 } } : e));
  assert.equal(ids(M.groupRuns(test2)), '[a b c d] e f g');
  // A helper's step between the main agent's.
  const agents = run.map((e) => (e.id === 'b' ? { ...e, agent: 'helper-1' } : e));
  assert.equal(ids(M.groupRuns(agents)), 'a b [c d e f g]');
});

test('the story: a card per prompt, a lead card before the first, and idle gaps kept between', () => {
  const p = (id, t) => ({ id, t, kind: 'prompt', agent: 'a:main' });
  const steps = [
    { id: 'start', t: 0, kind: 'session', agent: 'a:main' },
    p('p1', 10), step('c1', 11), step('c2', 12), step('c3', 13), step('c4', 14),
    p('p2', 1000), step('c5', 1001), step('c6', 2000),
  ];
  const story = M.buildStory(steps, { gaps: [[14, 1000], [1001, 2000]] });
  assert.equal(story.cards.length, 3);
  assert.equal(story.cards[0].prompt, null, 'a lead card holds what came before the first prompt');
  assert.deepEqual(story.cards.map((c) => c.prompt?.id ?? null), [null, 'p1', 'p2']);
  assert.deepEqual(story.order.map((o) => (o.gap ? 'gap' : o.prompt?.id ?? 'lead')), ['lead', 'p1', 'gap', 'p2'], 'a gap before a prompt sits between cards');
  assert.equal(story.cards[1].rows[0].group, 'c1');
  // A gap inside a card splits it and never sits inside a group.
  assert.deepEqual(story.cards[2].rows.map((r) => (r.gap ? 'gap' : r.step.id)), ['c5', 'gap', 'c6']);
});

// ---- selection, both ways ------------------------------------------------------------------------

test('a row selects the step at the playhead, and the playhead selects the row and opens its group', () => {
  const p = (id, t) => ({ id, t, kind: 'prompt', agent: 'a:main' });
  const steps = [p('p1', 10), step('c1', 20), step('c2', 30), step('c3', 40), { id: 'm1', t: 50, kind: 'message', agent: 'a:main' }];
  const story = M.buildStory(steps);
  // From the story: a step inside a group puts the playhead at its moment, and names its group.
  const fromRow = M.selectStep(story, steps, { id: 'c2' });
  assert.deepEqual(fromRow, { id: 'c2', t: 30, card: 0, group: 'c1' });
  // From the timeline: that moment selects the same step, so the row and the playhead agree.
  assert.deepEqual(M.selectStep(story, steps, { t: fromRow.t }), fromRow);
  // A moment between steps selects the last step at or before it; before the first, the first.
  assert.equal(M.selectStep(story, steps, { t: 35 }).id, 'c2');
  assert.equal(M.selectStep(story, steps, { t: 0 }).id, 'p1');
  assert.deepEqual(M.selectStep(story, steps, { t: 55 }), { id: 'm1', t: 50, card: 0, group: null });
  // A card's prompt is in no group.
  assert.equal(M.locate(story, 'p1').prompt, true);
  assert.equal(M.selectStep(story, steps, { id: 'nope' }), null);
});

// ---- findings ------------------------------------------------------------------------------------

test('the Problems row: one dot per finding worth a look, never a dismissed pattern; a ring takes the top tier', () => {
  const answer = {
    patterns: [{ id: 'pat-high', priority: { tier: 'high' } }, { id: 'pat-low', priority: { tier: 'low' } }, { id: 'pat-gone', priority: { tier: 'medium' } }],
    findings: [
      { pattern: 'pat-high', severity: 'look', session: 's1', event: 'e1', at: '2025-03-15T14:00:00Z', verdictEvidence: 'inferred' },
      { pattern: 'pat-low', severity: 'look', session: 's1', event: 'e1', at: '2025-03-15T14:00:00Z', verdictEvidence: 'derived' },
      { pattern: 'pat-low', severity: 'note', session: 's1', event: 'e2', at: '2025-03-15T14:01:00Z', verdictEvidence: 'derived' },
      { pattern: 'pat-gone', severity: 'look', session: 's1', event: 'e3', at: '2025-03-15T14:02:00Z', verdictEvidence: 'derived' },
      { pattern: 'pat-high', severity: 'look', session: 'other', event: 'e9', at: '2025-03-15T14:03:00Z', verdictEvidence: 'derived' },
    ],
  };
  const tierOf = (p) => (p.id === 'pat-gone' ? { tier: 'dismissed', mine: true } : { tier: p.priority.tier, mine: false });
  const items = M.findingItems(answer, { tierOf, sessions: ['s1'], eventT: (id) => ({ e1: 100, e2: 200, e3: 300 })[id] ?? null });
  assert.equal(items.length, 4, 'only the sessions on screen');
  assert.equal(M.problemDots(items).length, 2);
  assert.equal(M.problemDots(items, { routine: true }).length, 3, 'routine notes only when asked');
  // The inferred one is counted as possible, the way the Problems page keeps it apart.
  assert.deepEqual(M.tierCounts(items), { high: 1, medium: 0, low: 1, look: 2, possible: 1, levels: ['inferred', 'derived'], routine: 1, dismissed: 1 });
  const flags = M.flagsByEvent(items);
  assert.deepEqual(flags.get('e1').map((i) => i.tier), ['high', 'low']);
  assert.equal(M.ringTier(flags.get('e1')), 'high');
  assert.equal(M.ringTier(flags.get('e2')), null, 'a routine note gets no ring');
  assert.equal(flags.has('e3'), false, 'a dismissed pattern marks no step');
  // Previous and Next problem walk the dots' steps in time order.
  const dots = M.problemDots(items);
  assert.equal(M.problemStep(dots, { t: 0, dir: 1 }), 'e1');
  assert.equal(M.problemStep(dots, { t: 100, id: 'e1', dir: 1 }), null);
  assert.equal(M.problemStep(dots, { t: 500, dir: -1 }), 'e1');
});

test('the replay builds the same zoom link as the Problems page', () => {
  const src = page('problems.js').match(/function zoomHref\(f\) \{[\s\S]*?\n {2}\}/)[0];
  const isIdSrc = page('common.js').match(/const ID = \{[\s\S]*?\};\n\s*const isId = [^\n]+/)[0];
  const fromProblems = runInNewContext(`(() => { ${isIdSrc}; const FINDING_KEY = /^pf-[a-p]{12}$/; ${src} return zoomHref; })()`, { encodeURIComponent });
  const f = { key: 'pf-abcdefghijkl', thread: 'th-bbbbbbbb', zoom: { lanes: [{ thread: 'th-aaaaaaaa', session: 'cx-aaaaaaaa' }, { thread: 'th-bbbbbbbb', session: 'cx-bbbbbbbb' }] } };
  assert.equal(M.zoomHref(f), fromProblems(f));
  assert.equal(M.zoomHref(f), 'replay.html?session=cx-bbbbbbbb#th-bbbbbbbb~zoom~pf-abcdefghijkl');
  assert.equal(M.zoomHref({ ...f, key: 'nope' }), null);
});

// ---- a finding's scope: how its zoom frames it -------------------------------------------------------

test("a served scope is read only when its shape holds, keeping only this replay's steps in time order", () => {
  const t = { e1: 10, e2: 20, e3: 30, p0: 0 };
  const opts = { has: (id) => id in t, tOf: (id) => t[id] };
  const s = { kind: 'repeat', steps: ['e3', 'e1', 'gone', 'e2'], from: 10, to: 31, anchor: 'e1', prompt: 'p0', next: 'gone', caption: 'The same call ran 3 times', level: 'derived', stretch: null, gap: { from: 5, to: 1 } };
  const S = M.readScope(s, opts);
  assert.deepEqual(S.steps, ['e1', 'e2', 'e3'], 'in time order, a step this replay lacks dropped');
  assert.deepEqual([S.anchor, S.prompt, S.next, S.gap, S.stretch], ['e1', 'p0', null, null, null], 'a backwards gap is dropped');
  assert.deepEqual([S.caption, S.level], ['The same call ran 3 times', 'derived']);
  assert.equal(M.readScope({ ...s, level: 'certain' }, opts).level, null, 'only the five evidence words');
  assert.equal(M.readScope({ ...s, anchor: 'gone' }, opts).anchor, 'e1', 'an anchor it lacks falls back to the first step');
  // Anything malformed reads as no scope: the zoom then frames the recorded steps as before.
  for (const bad of [null, 'moment', { ...s, kind: 'blob' }, { ...s, from: 'x' }, { ...s, to: 5 }, { ...s, steps: ['gone'] }, { ...s, steps: 'e1' }]) assert.equal(M.readScope(bad, opts), null, JSON.stringify(bad));
  const st = M.readScope({ ...s, kind: 'stretch', stretch: { from: 12, to: 30, agent: 'a:main' } }, opts);
  assert.deepEqual(st.stretch, { from: 12, to: 30, agent: 'a:main' });
});

test("a scope's frame has a small margin, and its marks: the ringed steps, the steps it names, and in a stretch that agent's steps inside it", () => {
  assert.deepEqual(M.scopeFrame({ from: 0, to: 1000e3 }), [-40e3, 1040e3], 'four percent of a long frame');
  assert.deepEqual(M.scopeFrame({ from: 0, to: 5e3 }), [-10e3, 15e3], 'at least ten seconds');
  assert.deepEqual(M.scopeFrame({ from: 0, to: 1000e3 }, { within: [-5e3, 1010e3] }), [-5e3, 1010e3], "never past the replay's first and last record");
  const S = { kind: 'stretch', steps: ['e1'], stretch: { from: 100, to: 200, agent: 'a:main' }, prompt: 'p0', next: null, message: null, helper: null, parent: 'e1' };
  const marks = M.scopeMarks(S);
  assert.deepEqual([...marks], [['p0', 'prompt']], 'a named step that is also ringed stays only ringed');
  const role = (e) => M.scopeRole(S, e, { set: new Set(S.steps), marks });
  assert.equal(role({ id: 'e1', t: 90, agent: 'a:main' }), 'ring');
  assert.equal(role({ id: 'p0', t: 0, agent: 'a:main' }), 'prompt');
  assert.equal(role({ id: 'x', t: 150, agent: 'a:main' }), 'stretch');
  assert.equal(role({ id: 'x', t: 150, agent: 'b:sub' }), null, "another agent's step in the same time steps back");
  assert.equal(role({ id: 'x', t: 250, agent: 'a:main' }), null, 'after the stretch');
  assert.equal(M.scopeRole({ kind: 'moment', steps: ['e1'] }, { id: 'e1' }), 'ring');
  assert.equal(M.scopeRole(null, null), null);
  // A repeat's numbers: none closer than 14 pixels to the last one drawn.
  assert.deepEqual(M.repeatNumbers([10, 20, 30, 31, 60]), [0, 2, 4]);
  assert.deepEqual(M.repeatNumbers([]), []);
});

// ---- the demo session -----------------------------------------------------------------------------

test('the demo session: 9 dots worth a look, two breaks of 19 and 5 minutes, and its groups', async () => {
  const d = buildDemoWeek({ root: join(makeTempDir('hw-replay-model-'), 'week') });
  const data = createViewData({ config: d.config, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, demo: true });
  await data.start();
  const session = sourceKey('cx', CODEX_IDS.windowsWhy);
  const r = (await data.route('/api/replay', new URLSearchParams({ session }))).body;
  assert.equal(r.thread.title, 'Why the width test is skipped on Windows');
  const events = r.events;
  const steps = events.filter(M.isStep).sort((a, b) => a.t - b.t);
  assert.equal(steps.length, 60);
  assert.equal(steps.filter((e) => e.kind === 'prompt').length, 3);
  // The breaks: the 19-minute and the 5-minute stretch, nothing shorter, each after a turn ended
  // and before the next prompt.
  const T0 = Date.parse(r.thread.firstAt);
  const T1 = Date.parse(r.thread.lastAt);
  const { gaps } = M.idleGaps(M.starts(events), T0, T1);
  assert.deepEqual(gaps.map(([a, b]) => Math.round((b - a) / MIN)), [19, 5]);
  const labels = gaps.map((g) => M.breakLabel(g, { steps: events.filter((e) => e.kind !== 'quiet'), agents: r.agents, turns: r.session.turns.filter((t) => t.agent.endsWith(':main')) }));
  assert.deepEqual(labels.map((l) => l.text), ['19 min before your next prompt', '5 min before your next prompt']);
  // The findings: 9 worth a look (3 high, counting the cache it re-sent after a pause, 2 medium,
  // 4 low) and 4 routine notes.
  const p = (await data.route('/api/problems', new URLSearchParams({ thread: r.thread.id }))).body;
  const byId = new Map(events.map((e) => [e.id, e]));
  const items = M.findingItems(p, { sessions: [session], eventT: (id) => byId.get(id)?.t ?? null });
  const dots = M.problemDots(items);
  assert.equal(dots.length, 9);
  // Of the 9 worth a look, 6 rest on a rule's reading or a missing record: the summary says so.
  const counts = M.tierCounts(items);
  assert.deepEqual({ ...counts, levels: undefined }, { high: 3, medium: 2, low: 4, look: 9, possible: 6, levels: undefined, routine: 4, dismissed: 0 });
  assert.equal(counts.levels.length, 9);
  assert.ok(dots.every((i) => i.known), 'every dot sits on a step of this replay');
  // The story: three prompt cards and a lead card, with the two breaks between them, and the
  // runs of shell commands grouped wherever no finding breaks them.
  const flags = M.flagsByEvent(items);
  const story = M.buildStory(steps, { gaps, flagged: (e) => flags.has(e.id) });
  assert.deepEqual(story.order.map((o) => (o.gap ? 'gap' : o.prompt ? 'prompt' : 'lead')), ['lead', 'prompt', 'gap', 'prompt', 'gap', 'prompt']);
  const groups = story.cards.flatMap((c) => c.rows.filter((r2) => r2.group));
  assert.ok(groups.length >= 3, `${groups.length} groups`);
  for (const g of groups) {
    assert.ok(g.steps.length >= 3);
    assert.ok(g.steps.every((e) => !flags.has(e.id)), 'no step with a finding inside a group');
    assert.ok(g.steps.every((e) => M.storyKind(e) === g.kind && e.agent === g.agent));
  }
  // Every step is in the story once.
  const placed = story.cards.flatMap((c) => [c.prompt, ...c.rows.flatMap((r2) => (r2.group ? r2.steps : r2.step ? [r2.step] : []))]).filter(Boolean);
  assert.deepEqual(placed.map((e) => e.id).sort(), steps.map((e) => e.id).sort());
  // The claim the output doesn't show: a high finding on the agent's last message of the first turn.
  const claim = items.find((i) => i.p.id === 'claim-contradicts-evidence');
  assert.equal(claim.tier, 'high');
  assert.equal(byId.get(claim.event).kind, 'message');
  assert.equal(M.ringTier(flags.get(claim.event)), 'high');
});
