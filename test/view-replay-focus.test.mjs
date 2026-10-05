// The replay's problem focus (lib/view/assets/replay-model.js, replay.js): what a finding opens
// as. Its plan per kind from made-up findings (the facts, the cause step, what "The cause, drawn"
// shows and which lanes get a row), the steps list, the context per model call the replay answer
// now carries (checked against the demo week's long-session findings, call for call), the lanes
// filter on the demo week, and "See in the whole session": its address, and the replay selecting
// and showing that step out of the focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import '../lib/view/assets/replay-model.js';
import { buildDemoWeek } from '../lib/demo/week.mjs';
import { fmt } from '../lib/problems/checks.mjs';
import { THRESHOLDS } from '../lib/problems/context.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { contextCalls, exportThread } from '../lib/view/replay-export.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const M = globalThis.HWReplayModel;
const HERE = dirname(fileURLToPath(import.meta.url));
const page = (f) => readFileSync(join(HERE, '..', 'lib', 'view', 'assets', f), 'utf8');

// ---- a made-up session ---------------------------------------------------------------------------

const T = Date.parse('2025-03-10T09:00:00.000Z');
const at = (s) => T + s * 1000;
const S_KEY = 'cc-aaaaaaaa';
const MAIN = `${S_KEY}:main`;
const HELP = 'cc-bbbbbbbb';
const OTHER_HELP = 'cc-cccccccc';
const ev = (id, s, kind, extra = {}) => ({ id, t: at(s), kind, session: S_KEY, agent: MAIN, actor: kind === 'prompt' ? 'person' : 'agent', ev: 'recorded', facts: {}, ...extra });
const events = [
  ev('cc-aaaaaaaa.1.0', 0, 'prompt'),
  ev('cc-aaaaaaaa.2.0', 10, 'action', { patch: { added: 3, removed: 1 } }),
  ev('cc-aaaaaaaa.3.0', 20, 'action'),
  ev('cc-aaaaaaaa.4.0', 30, 'action', { tests: { pass: 12, fail: 1, evidence: 'derived' } }),
  ev('cc-aaaaaaaa.5.0', 40, 'message'),
  ev('cc-aaaaaaaa.6.0', 340, 'prompt'),
  ev('cc-aaaaaaaa.7.0', 350, 'action'),
  ev('cc-bbbbbbbb.1.0', 352, 'action', { agent: HELP }),
  ev('cc-aaaaaaaa.8.0', 380, 'action'),
  ev('cc-cccccccc.1.0', 390, 'action', { agent: OTHER_HELP }),
  ev('cc-aaaaaaaa.9.0', 400, 'compaction', { actor: 'harness' }),
];
const byIdMap = new Map(events.map((e) => [e.id, e]));
const byId = (id) => byIdMap.get(id) ?? null;
const id = (n) => `cc-aaaaaaaa.${n}.0`;
// Lanes as the page keys them (HW.laneOf): yours, each agent's, the harness's.
const laneOf = (x) => {
  const e = byId(x);
  return !e ? null : e.actor === 'person' ? 'person' : e.kind === 'compaction' ? 'harness' : e.agent;
};
const spawned = (x) => (x === id(7) ? HELP : null);
const scope = (s) => ({ steps: [], from: 0, to: 0, stretch: null, gap: null, anchor: s.steps?.[0] ?? null, caption: 'A caption', level: 'derived', prompt: null, next: null, message: null, helper: null, parent: null, ...s });
const plan = (f, S, opts = {}) => M.focusPlan(f, S, { byId, laneOf, spawned, span: M.spanText, ...opts });

// ---- the focus's plan, per kind -----------------------------------------------------------------

test('a moment: the prompt before it, outlined as context, then its steps; facts from the recorded run, the patches and its basis', () => {
  const f = { check: 'claim-contradicts-evidence', basis: [{ part: 'The failed run', level: 'derived', how: 'Its result is an error.' }, { part: 'The success claim', level: 'inferred', how: 'A rule reads it.' }] };
  const S = scope({ kind: 'moment', steps: [id(2), id(4), id(5)], anchor: id(5), prompt: id(1) });
  const p = plan(f, S);
  assert.equal(p.draw.draw, 'sequence');
  assert.deepEqual(p.draw.items, [{ id: id(1), role: 'prompt' }, { id: id(2), role: 'ring' }, { id: id(4), role: 'ring' }, { id: id(5), role: 'ring' }]);
  assert.deepEqual(p.facts.map((x) => [x.text, x.level]), [['1 failed, 12 passed', 'derived'], ['+3 −1 lines', 'derived'], ['The failed run', 'derived']], 'at most three, numbers first');
  assert.deepEqual(p.cause, { label: 'The key step', id: id(5), t: at(40), call: null });
  assert.deepEqual([...p.lanes].sort(), [MAIN, 'person'].sort());
  // A long moment is cut to its first and last steps, with how many are left out between.
  const many = scope({ kind: 'moment', steps: [1, 2, 3, 4, 5, 6, 7, 8].map(id).filter((x) => byId(x)) });
  assert.deepEqual(plan({}, many).draw.items.map((x) => x.more ?? x.id), [id(1), id(2), id(3), 3, id(7), id(8)]);
});

test('a stretch from the long-session check: the context per model call, the crossing and its facts; with no counts, its steps instead', () => {
  const answer = { threshold: 150_000, agents: [{ agent: MAIN, calls: [40e3, 90e3, 151e3, 152e3, 160e3, 156e3].map((context, i) => ({ t: at(5 + i * 10), context })) }] };
  const S = scope({ kind: 'stretch', steps: [id(3)], anchor: id(3), stretch: { from: at(25), to: at(400), agent: MAIN } });
  const f = { check: 'long-sessions', estimate: 4_687_512 };
  const p = plan(f, S, { context: answer, compactionsOf: (a) => events.filter((e) => e.kind === 'compaction' && e.agent === a).length });
  assert.equal(p.draw.draw, 'context');
  const c = p.draw.ctx;
  assert.deepEqual([c.cross, c.after, c.max, c.threshold, c.calls.length], [2, 3, 160e3, 150e3, 6]);
  assert.deepEqual(c.calls[2], { n: 3, t: at(25), context: 151e3 });
  assert.deepEqual(p.facts.map((x) => [x.text, x.level]), [['Largest context 160k', 'derived'], ['1 compaction recorded', 'derived'], ["About 4.7M tokens a fresh start wouldn't re-read", 'inferred']]);
  assert.deepEqual(p.cause, { label: 'Where it crossed', id: id(3), t: at(25), call: 3 }, 'the time is the crossing call\'s, the step only the nearest');
  assert.deepEqual([...p.lanes].sort(), [MAIN, 'person'].sort());
  // Without the counts (or for another stretch), the stretch's own steps; never a guessed chart.
  assert.equal(plan(f, S).draw.draw, 'sequence');
  assert.equal(plan({ check: 'another-stretch' }, S, { context: answer }).draw.draw, 'sequence');
  assert.equal(plan(f, S).cause.label, 'Where it started');
  // A malformed call drops the chart rather than renumbering the calls.
  assert.equal(M.contextPlan({ threshold: 150e3, agents: [{ agent: MAIN, calls: [{ t: 1, context: 5 }, { t: 2 }] }] }, MAIN), null);
  assert.equal(M.contextPlan({ threshold: 150e3, agents: [] }, MAIN), null);
  assert.equal(M.contextPlan(null, MAIN), null);
});

test('a repeat: the repeats numbered, with the count the check matched; its span as a fact', () => {
  const S = scope({ kind: 'repeat', steps: [id(2), id(3), id(4)] });
  const p = plan({ check: 'action-loop', steps: 60 }, S);
  assert.equal(p.draw.draw, 'repeat');
  assert.equal(p.draw.count, 60, 'the count is what the check matched, not only the ids it kept');
  assert.deepEqual(p.draw.items.map((x) => x.n), [1, 2, 3]);
  assert.deepEqual(p.facts[0], { text: 'Over 20 s', level: 'derived', title: 'From the first to the last, by their recorded times.' });
  assert.equal(p.cause.label, 'The first one');
  // Nine repeats: the first four and the last three, numbered as they ran, with one left out between.
  const long = scope({ kind: 'repeat', steps: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id) });
  assert.deepEqual(plan({}, long).draw.items.map((x) => (x.more ? `+${x.more}` : x.n)), [1, 2, 3, 4, '+2', 7, 8, 9]);
});

test('a hand-off: the helper starting, its last record, the gap, the parent carrying on; the helper gets its own lane', () => {
  const S = scope({ kind: 'hand-off', steps: [id(7)], anchor: id(7), helper: 'cc-bbbbbbbb.1.0', parent: id(8), gap: { from: at(352), to: at(380) }, level: 'missing' });
  const p = plan({ check: 'subagent-no-report' }, S);
  assert.equal(p.draw.draw, 'hand-off');
  assert.deepEqual(p.draw.items, [{ id: id(7), role: 'ring' }, { id: 'cc-bbbbbbbb.1.0', role: 'helper' }, { gap: { from: at(352), to: at(380) } }, { id: id(8), role: 'parent' }]);
  assert.deepEqual(p.facts.map((x) => x.text), ['28 s with no hand-back', '1 step marked']);
  assert.equal(p.cause.label, 'The helper started');
  assert.deepEqual([...p.lanes].sort(), [HELP, MAIN, 'person'].sort(), 'the helper it started, and not the other helper');
  // No parent after it: the gap runs on, and the end is said.
  const end = plan({}, scope({ ...S, parent: null }));
  assert.deepEqual(end.draw.items.at(-1), { end: true });
  assert.ok(end.facts.some((x) => x.text === 'Nothing after it in the session'));
  // Its helper is found by the call that started it even when the helper left no record here.
  assert.ok(plan({}, scope({ ...S, helper: null })).lanes.has(HELP));
});

test('a turn ending: the last message, the wait, the next prompt; with no prompt after it, the end', () => {
  const S = scope({ kind: 'turn-end', steps: [id(5), id(6)], anchor: id(5), next: id(6), gap: { from: at(40), to: at(340) } });
  const p = plan({ check: 'needless-check-in' }, S);
  assert.equal(p.draw.draw, 'turn-end');
  assert.deepEqual(p.draw.items, [{ id: id(5), role: 'ring' }, { gap: { from: at(40), to: at(340) } }, { id: id(6), role: 'ring' }], 'the wait between the two, in time order');
  assert.equal(p.facts[0].text, '5 min until your next prompt');
  assert.equal(p.cause.label, 'Where the turn ended');
  const last = plan({}, scope({ kind: 'turn-end', steps: [id(8)], anchor: id(8), message: id(5) }));
  assert.deepEqual(last.draw.items, [{ id: id(5), role: 'message' }, { id: id(8), role: 'ring' }, { end: true }]);
});

test('a check with no kind: its recorded steps as a moment, ringed, with nothing named beside them', () => {
  const p = plan({ check: 'a-check-added-later' }, null, { ids: [id(3), id(2)] });
  assert.equal(p.S.kind, 'moment');
  assert.deepEqual(p.S.steps, [id(3), id(2)]);
  assert.equal(p.S.caption, null);
  assert.deepEqual(p.draw.items.map((x) => x.role), ['ring', 'ring']);
  assert.equal(plan({}, null, { ids: [] }), null, 'no step here: no focus plan');
});

// ---- the lanes and the steps list -----------------------------------------------------------------

test('the lanes filter: yours and the agents the scope involves get rows, everything else folds into Other activity', () => {
  const LANES = [{ key: 'person' }, { key: MAIN }, { key: HELP, agent: {} }, { key: OTHER_HELP, agent: {} }, { key: 'harness' }, { key: 'git' }];
  const S = scope({ kind: 'hand-off', steps: [id(7)], anchor: id(7), helper: 'cc-bbbbbbbb.1.0', parent: id(8) });
  const { shown, other } = M.splitLanes(LANES, M.focusLanes(S, { laneOf, spawned }));
  assert.deepEqual(shown.map((l) => l.key), ['person', MAIN, HELP], 'in the page\'s order, the helper on its own');
  assert.deepEqual(other.map((l) => l.key), [OTHER_HELP, 'harness', 'git']);
  // A stretch involves its agent even where none of its steps is ringed.
  assert.deepEqual([...M.focusLanes(scope({ kind: 'stretch', steps: [], stretch: { from: 0, to: 1, agent: OTHER_HELP } }), { laneOf })].sort(), [OTHER_HELP, 'person'].sort());
  // A harness record the scope names brings the harness lane.
  assert.ok(M.focusLanes(scope({ kind: 'moment', steps: [id(9)] }), { laneOf }).has('harness'));
  assert.deepEqual([...M.focusLanes(null)], ['person']);
});

test('the steps list: only the scope\'s steps and the steps its frame holds, in order, each with its part', () => {
  const steps = events.filter(M.isStep);
  const S = scope({ kind: 'moment', steps: [id(2), id(4)], prompt: id(1) });
  assert.deepEqual(M.focusSteps(S, steps).map(({ e, role }) => [e.id, role]), [[id(1), 'prompt'], [id(2), 'ring'], [id(4), 'ring']], 'never the step between them the check did not match');
  // A stretch: its agent's steps inside it, and the step it rings.
  const st = scope({ kind: 'stretch', steps: [id(3)], stretch: { from: at(20), to: at(380), agent: MAIN } });
  assert.deepEqual(M.focusSteps(st, steps).map(({ e, role }) => [e.id, role]), [[id(3), 'ring'], [id(4), 'stretch'], [id(5), 'stretch'], [id(6), 'stretch'], [id(7), 'stretch'], [id(8), 'stretch']], "another agent's step in the same time isn't in it");
  // A turn ending: the message and the prompt it names, nothing else.
  const te = scope({ kind: 'turn-end', steps: [id(8)], message: id(5), next: id(6) });
  assert.deepEqual(M.focusSteps(te, steps).map(({ e, role }) => [e.id, role]), [[id(5), 'message'], [id(6), 'next'], [id(8), 'ring']]);
  assert.deepEqual(M.focusSteps(null, steps), []);
});

test('the page wires the plan: the focus rows, the steps list filter, the Other activity row and its faint marks', () => {
  const r = page('replay.js');
  for (const name of ['RM.focusPlan', 'RM.splitLanes', 'Z.lanes', 'focusWide', 'data-wholelink', 'RM.wholeHref', 'data-fleave', 'data-fsteps', 'data-fwide', 'contextCalls', 'Other activity', 'drawFocus', 'seeWhole', 'revealStep']) assert.ok(r.includes(name), `replay.js has ${name}`);
  // Only the problem's steps in the list until it's widened.
  assert.match(r, /if \(Z && !focusWide\) navSteps = navSteps\.filter\(\(e\) => zRole\(e\.id\)\);/);
  // The folded Other activity row draws no labels, and every mark outside the problem steps back.
  assert.match(r, /if \(!r\.other\) s \+= labelsSvg\(inView, geo\);/);
  const css = page('replay.css');
  for (const cls of ['.fcard', '.ffacts', '.fcause', '.cbar', '.cbar.cross', '.cbar.after', '.cline', '.fstep.ring', '.fstep.ctx', '.ftag', '.srow.hot', '.fwhole', '.row-label.helpers.other']) assert.ok(css.includes(cls), `replay.css styles ${cls}`);
  // Theme tokens only: no colour written into the page's styles.
  const focusCss = css.slice(css.indexOf('/* ---- the problem focus'), css.indexOf('/* ---- the selected step'));
  assert.doesNotMatch(focusCss, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  const html = page('replay.html');
  for (const want of ['id="focus"', 'id="focusWhat"', 'id="focusDraw"', 'id="focusStepsHead"']) assert.ok(html.includes(want), want);
});

// ---- the context per model call, on the demo week ---------------------------------------------

const demo = buildDemoWeek({ root: join(makeTempDir('hw-replay-focus-'), 'week') });
const data = createViewData({ config: demo.config, roots: demo.roots, from: demo.week.from, to: demo.week.to, timezone: demo.week.timezone, goalRecord: demo.goalRecord, demo: true });
await data.start();
const problems = (await data.route('/api/problems', new URLSearchParams())).body;
const findings = problems.patterns.flatMap((p) => p.findings ?? []);
const longOnes = findings.filter((f) => f.check === 'long-sessions');

test("the replay carries each agent's context per model call, and the demo's long sessions cross where their notes say", async () => {
  assert.equal(longOnes.length, 2);
  for (const f of longOnes) {
    const r = (await data.route('/api/replay', new URLSearchParams({ session: f.session }))).body;
    assert.ok(r.contextCalls, 'the replay answer has the context per call');
    assert.equal(r.contextCalls.threshold, THRESHOLDS.longCtx);
    const S = f.zoom.scope;
    const c = M.contextPlan(r.contextCalls, S.stretch.agent);
    assert.ok(c, `${f.session}: the calls of the agent that crossed`);
    // The note's own numbers: "at model call 16 of 50 (152k)" and "Its largest context was 169k".
    const [, k, n, x] = f.note.match(/at model call (\d+) of (\d+) \(([\d.]+[kMB]?)\)/);
    assert.equal(c.calls.length, Number(n), 'the same calls the check counted');
    assert.equal(c.cross + 1, Number(k), 'the crossing call is the one the note names');
    assert.equal(fmt(c.calls[c.cross].context), x);
    assert.ok(c.calls[c.cross].context >= 150_000 && c.calls.slice(0, c.cross).every((y) => y.context < 150_000), 'the first call at or past the threshold');
    assert.equal(c.calls[c.cross].t, Date.parse(f.at), 'at the time the finding starts');
    assert.equal(c.after, Number(f.note.match(/then made (\d+) more calls/)[1]));
    assert.equal(fmt(c.max), f.note.match(/largest context was ([\d.]+[kMB]?)/)[1]);
    assert.equal(M.tokensText(c.max), fmt(c.max), 'the page writes token counts as the checks do');
    // The focus draws the chart for it, and its facts carry the note's numbers.
    const p = M.focusPlan(f, M.readScope(S, { has: (x) => r.events.some((e) => e.id === x), tOf: (x) => r.events.find((e) => e.id === x).t }), { ids: f.zoom.events, byId: (x) => r.events.find((e) => e.id === x) ?? null, context: r.contextCalls, compactionsOf: () => 0, span: M.spanText });
    assert.equal(p.draw.draw, 'context');
    assert.equal(p.facts[0].text, `Largest context ${fmt(c.max)}`);
    assert.equal(p.cause.call, Number(k));
    // Numbers and ids only.
    for (const a of r.contextCalls.agents) {
      assert.match(a.agent, /^[a-z]{2,4}-[a-p]+(?::main)?$/);
      for (const y of a.calls) assert.deepEqual(Object.keys(y).sort(), ['context', 't']);
    }
  }
});

test('the context per call is additive: without token counts the replay answer is as it was', () => {
  const h = { window: { startT: 0, endT: 100 }, rules: {}, coverage: {}, events: [], agents: [], sessions: [{ key: 'cc-aaaa', private: false, thread: 'th-aaaa' }], thread: () => ({ id: 'th-aaaa', sessions: [{ key: 'cc-aaaa' }] }), threadTimeline: () => null, session: () => ({ turns: [] }) };
  const plain = exportThread(h, 'th-aaaa', {});
  assert.equal('contextCalls' in plain, false);
  const withCalls = exportThread(h, 'th-aaaa', { usage: [] });
  assert.deepEqual(withCalls.contextCalls, { threshold: THRESHOLDS.longCtx, agents: [] });
  const { contextCalls: _c, ...rest } = withCalls;
  assert.deepEqual(rest, plain, 'every other field unchanged');
  // The order and the window are the check's: by source file, then line; calls outside the window left out.
  const calls = [
    { agent: 'a', source: 'f2', lines: [1], t: 50, input: 1, cacheRead: 0, cacheWrite: 0 },
    { agent: 'a', source: 'f1', lines: [9], t: 40, input: 2, cacheRead: 10, cacheWrite: 1 },
    { agent: 'a', source: 'f1', lines: [3], t: 30, input: 3, cacheRead: 0, cacheWrite: 0 },
    { agent: 'a', source: 'f1', lines: [1], t: 500, input: 9, cacheRead: 0, cacheWrite: 0 },
    { agent: 'b', source: 'f1', lines: [2], t: 20, input: 7, cacheRead: 0, cacheWrite: 0 },
  ];
  assert.deepEqual(contextCalls(calls, { agents: ['a'], window: { startT: 0, endT: 100 } }), { threshold: THRESHOLDS.longCtx, agents: [{ agent: 'a', calls: [{ t: 30, context: 3 }, { t: 40, context: 13 }, { t: 50, context: 1 }] }] });
});

test('on the demo week the long session involves you and its main agent; its helper and the harness fold into Other activity', async () => {
  const f = longOnes.find((x) => x.session.startsWith('cx-'));
  const r = (await data.route('/api/replay', new URLSearchParams({ session: f.session }))).body;
  const S = M.readScope(f.zoom.scope, { has: (x) => r.events.some((e) => e.id === x), tOf: (x) => r.events.find((e) => e.id === x).t });
  const lanes = M.focusLanes(S, { laneOf: (x) => r.events.find((e) => e.id === x)?.agent ?? null });
  const all = [{ key: 'person' }, ...r.agents.map((a) => ({ key: a.key, agent: a.kind === 'main' ? null : a })), { key: 'harness' }, { key: 'git' }];
  const { shown, other } = M.splitLanes(all, lanes);
  assert.deepEqual(shown.map((l) => l.key), ['person', S.stretch.agent]);
  assert.ok(other.some((l) => l.agent), 'the helper folds');
  assert.ok(other.some((l) => l.key === 'harness'));
});

// ---- "See in the whole session" ----------------------------------------------------------------------

test('"See in the whole session" is the record-open address, from ids alone, and the replay reads its step back', () => {
  const e = { id: 'cx-abcdefgh.160.0', session: 'cx-abcdefgh' };
  const href = M.wholeHref(e, 'th-abcdefgh');
  assert.equal(href, 'replay.html?session=cx-abcdefgh#th-abcdefgh~cx-abcdefgh.160.0');
  for (const bad of [{ ...e, id: 'x y' }, { ...e, session: '../x' }]) assert.equal(M.wholeHref(bad, 'th-abcdefgh'), null);
  assert.equal(M.wholeHref(e, 'thread'), null);
  // The replay's own reading of the address: the step, never a zoom.
  const rjs = page('replay.js');
  const isIdSrc = page('common.js').match(/const ID = \{[\s\S]*?\};\n\s*const isId = [^\n]+/)[0];
  const u = new URL(href, 'http://127.0.0.1/');
  const read = runInNewContext(`(() => { ${isIdSrc}; ${rjs.match(/const hashParts = [^\n]+/)[0]} ${rjs.match(/const askedEvent = \(\) => \{[\s\S]*?\n {2}\};/)[0]} ${rjs.match(/const FINDING_KEY = [^\n]+/)[0]} ${rjs.match(/const zoomKey = [^\n]+/)[0]} return { step: askedEvent(), zoom: zoomKey() }; })()`, { location: { hash: u.hash } });
  assert.deepEqual({ ...read }, { step: e.id, zoom: null });
});

test('opening that step leaves the focus, selects it, frames the chart around it, opens its record and scrolls its row into view', () => {
  const rjs = page('replay.js');
  const fn = (name) => rjs.match(new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`))[0];
  const step = { id: 'cx-abcdefgh.160.0', t: 5_000_000, session: 'cx-abcdefgh' };
  const calls = [];
  const row = { scrollIntoView: (o) => calls.push(['scroll', o.block]) };
  const ctx = {
    Z: { key: 'pf-aaaaaaaaaaaa' },
    selId: 'cx-abcdefgh.1.0',
    playhead: 0,
    HW: { data: { byId: new Map([[step.id, step]]) }, openEvent: (x) => calls.push(['record', x]), announce: () => {}, describeStepPieces: () => [] },
    leaveFocus: () => calls.push(['leave']),
    zoomPanel: () => calls.push(['panel', ctx.Z]),
    refilter: () => calls.push(['refilter']),
    storySelect: (x) => calls.push(['row', x]),
    storyRow: (x) => (x === step.id ? row : null),
    setView: (a, b) => calls.push(['view', a, b]),
    select: () => false,
  };
  runInNewContext(`${fn('showAt')}${fn('seeWhole')}${fn('revealStep')} this.result = seeWhole('${step.id}');`, ctx);
  assert.equal(ctx.result, true);
  assert.equal(ctx.Z, null, 'out of the focus');
  assert.equal(ctx.selId, step.id, 'the step is selected');
  assert.equal(ctx.playhead, step.t);
  const view = calls.find((c) => c[0] === 'view');
  assert.ok(view[1] < step.t && view[2] > step.t, 'the chart frames it');
  assert.deepEqual(calls.filter((c) => ['leave', 'refilter', 'row', 'record', 'scroll'].includes(c[0])), [['leave'], ['refilter'], ['row', step.id], ['record', step.id], ['scroll', 'center']]);
  // A step this replay doesn't hold changes nothing.
  ctx.Z = { key: 'pf-aaaaaaaaaaaa' };
  calls.length = 0;
  runInNewContext(`this.result = seeWhole('cx-abcdefgh.999.0');`, ctx);
  assert.equal(ctx.result, false);
});
