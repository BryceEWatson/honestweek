// "Zoom to these steps": each finding's key and zoom on /api/problems, ?finding=<key>, the
// zoom's rules (one step, several, more than it recorded, only the nearest, two agents, two
// threads), and the link from the Problems page through the replay's address and back to the
// same finding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { createViewData } from '../lib/view/data.mjs';
import { createLeakCounter } from '../lib/view/leaks.mjs';
import { createProblemsRoute, FINDING_KEY, zoomOf } from '../lib/view/problems-route.mjs';
import { buildViewWeek, WEEK } from './fixtures/view/week.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = (f) => readFileSync(join(HERE, '..', 'lib', 'view', 'assets', f), 'utf8');

const scratch = makeTempDir('hw-view-zoom-');
const w = buildViewWeek(join(scratch, 'week'));
const data = createViewData({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', goalRecord: w.goalRecord, selfTest: true });
await data.start();
const leaks = createLeakCounter(w.config);
const ask = (q) => data.route('/api/problems', new URLSearchParams(q));
const whole = (await ask({})).body;
const findings = whole.patterns.flatMap((p) => p.findings ?? []);

// ---- the zoom's rules, on hand-made findings -------------------------------------------------

const ev = (id, t, session = 's1', agent = `${session}:main`) => [id, { id, t, session, agent }];
const events = new Map([ev('e1', 10), ev('e2', 20), ev('e3', 30), ev('e4', 40, 's1', 'sub-a'), ev('e5', 50, 's2'), ev('e6', 60, 's2')]);
const threadOf = (s) => ({ s1: 'th-one', s2: 'th-two' })[s];

test('one step: the step the check matched, and a total of one', () => {
  const z = zoomOf({ event: 'e2' }, events, threadOf);
  assert.deepEqual(z.events, ['e2']);
  assert.equal(z.total, 1);
  assert.equal(z.near, false);
  assert.deepEqual(z.lanes, [{ thread: 'th-one', session: 's1', agent: 's1:main', events: ['e2'] }]);
});

test('several steps: the listed steps with the related one, in time order, and nothing between them', () => {
  // A scope-creep shape: the edits listed, the question that came before them as `related`.
  const z = zoomOf({ event: 'e2', related: 'e1', events: ['e3', 'e2'], steps: 2 }, events, threadOf);
  assert.deepEqual(z.events, ['e1', 'e2', 'e3']);
  assert.equal(z.total, 3);
  // A pair with no list (a claim after a failed check) is exactly the two.
  assert.deepEqual(zoomOf({ event: 'e3', related: 'e1' }, events, threadOf).events, ['e1', 'e3']);
});

test('more matched than recorded: the total says so, and only the recorded steps are listed', () => {
  const z = zoomOf({ event: 'e1', events: ['e1', 'e2', 'e3'], steps: 60 }, events, threadOf);
  assert.deepEqual(z.events, ['e1', 'e2', 'e3']);
  assert.equal(z.total, 60);
  const gone = zoomOf({ event: 'e1', events: ['e1', 'e9'], steps: 2 }, events, threadOf);
  assert.deepEqual(gone.events, ['e1']);
  assert.equal(gone.unread, 1, 'a recorded id this build lacks is counted, never dropped silently');
});

test('only the nearest step: no total, marked as near', () => {
  const z = zoomOf({ event: 'e2', stepsNear: true }, events, threadOf);
  assert.deepEqual(z.events, ['e2']);
  assert.equal(z.total, null);
  assert.equal(z.near, true);
});

test('two agents and two threads: a lane each, counted', () => {
  const agents = zoomOf({ event: 'e3', events: ['e3', 'e4'], steps: 2 }, events, threadOf);
  assert.equal(agents.agents, 2);
  assert.equal(agents.threads, 1);
  assert.deepEqual(agents.lanes.map((l) => l.events), [['e3'], ['e4']]);
  const threads = zoomOf({ event: 'e2', events: ['e2', 'e5', 'e6'], steps: 3 }, events, threadOf);
  assert.equal(threads.threads, 2);
  assert.deepEqual(threads.lanes.map((l) => [l.thread, l.events]), [['th-one', ['e2']], ['th-two', ['e5', 'e6']]]);
  assert.equal(zoomOf({ event: 'e9' }, events, threadOf), null, 'no step this build holds: nothing to zoom to');
});

test('the route answers a finding that spans two threads, with each lane, through ?finding=', () => {
  const finding = { pattern: 'p1', check: 'c1', checkTitle: 'A check', severity: 'look', verdictEvidence: 'derived', session: 's1', event: 'e2', events: ['e2', 'e5'], steps: 2, at: '2025-03-10T09:00:00.000Z', note: 'Two threads.' };
  const result = { window: {}, catalog: {}, groups: [], priorityRule: null, statusCounts: {}, coverage: {}, rules: {}, checks: [], patterns: [{ id: 'p1', name: 'A pattern', group: 'g', looksLike: '', whyItMatters: '', strength: 'reported', strengthReason: '', sourceKinds: {}, sources: [], detection: { level: 'derived', summary: '', signals: [], falsePositives: [] }, mitigation: [], related: [], status: 'found', findings: [finding] }] };
  const problems = createProblemsRoute({ run: () => result });
  const ctx = { mode: 'redacted', b: { eventsById: events }, h: { threads: [] }, sessionByKey: new Map([['s1', { thread: 'th-one' }], ['s2', { thread: 'th-two' }]]), redact: (s) => s };
  const helpers = { redactedH: {}, builtT: 0, goalsOf: () => [], membersOfGoal: () => null, evidenceKey: {}, idOk: () => true };
  const all = problems(ctx, new URLSearchParams(), helpers);
  const f = all.patterns[0].findings[0];
  assert.match(f.key, FINDING_KEY);
  const one = problems(ctx, new URLSearchParams({ finding: f.key }), helpers);
  assert.equal(one.finding.key, f.key);
  assert.equal(one.pattern.name, 'A pattern');
  assert.equal(one.finding.zoom.threads, 2);
  assert.deepEqual(one.finding.zoom.lanes.map((l) => l.thread), ['th-one', 'th-two']);
});

// ---- the route on the made-up week ----------------------------------------------------------

test('every finding has a key and its steps, in time order, with how many the check matched', () => {
  assert.ok(findings.length > 5);
  assert.equal(new Set(findings.map((f) => f.key)).size, findings.length, 'keys are unique');
  for (const f of findings) {
    assert.match(f.key, FINDING_KEY);
    const z = f.zoom;
    assert.ok(z, `${f.check}: a zoom`);
    // Only steps the check named: its event, its related step and its list.
    const named = new Set([f.event, f.related, ...(f.events ?? [])].filter(Boolean));
    assert.ok(z.events.every((id) => named.has(id)), `${f.check}: no step the check didn't record`);
    assert.deepEqual(z.lanes.flatMap((l) => l.events).sort(), [...z.events].sort(), `${f.check}: the lanes hold every step once`);
    if (z.near) assert.equal(z.total, null);
    else assert.ok(z.total >= z.events.length, `${f.check}: total ${z.total} of ${z.events.length}`);
  }
  // Both kinds show up in the week: a one-step check and a check with several steps.
  assert.ok(findings.some((f) => f.zoom.total === 1));
  assert.ok(findings.some((f) => f.zoom.events.length > 1));
  assert.ok(findings.some((f) => f.zoom.near), 'the long-session finding marks its one step as only the nearest');
});

test('?finding= answers the same finding, refuses a malformed key, and says when the key is unknown', async () => {
  const f = findings.find((x) => x.zoom.events.length > 1);
  const r = await ask({ finding: f.key });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.finding, f);
  assert.ok(r.body.pattern.name);
  assert.equal(leaks.redacted(r.body).total, 0);
  assert.equal((await ask({ finding: '../x' })).status, 400);
  assert.equal((await ask({ finding: 'pf-aaaaaaaaaaaa' })).status, 404);
});

test('the link round-trips: the page builds it, the replay reads the key back, and the route answers that finding', async () => {
  const isIdSrc = page('common.js').match(/const ID = \{[\s\S]*?\};\n\s*const isId = [^\n]+/)[0];
  const env = runInNewContext(`${isIdSrc}; ({ isId })`);
  const zoomHrefP = runInNewContext(`(() => { const isId = env.isId; const FINDING_KEY = /^pf-[a-p]{12}$/; ${page('problems.js').match(/function zoomHref\(f\) \{[\s\S]*?\n {2}\}/)[0]} return zoomHref; })()`, { env, encodeURIComponent });
  const zoomHrefS = runInNewContext(`(() => { const HW = { isId: env.isId }; const FINDING_KEY = /^pf-[a-p]{12}$/; ${page('strip.js').match(/function zoomHref\(f\) \{[\s\S]*?\n {2}\}/)[0]} return zoomHref; })()`, { env, encodeURIComponent });
  const rjs = page('replay.js');
  const zoomKey = runInNewContext(`(() => { ${rjs.match(/const FINDING_KEY = [^\n]+/)[0]} ${rjs.match(/const zoomKey = [^\n]+/)[0]} return zoomKey; })()`);
  const f = findings.find((x) => x.zoom.events.length > 1 && x.thread);
  const href = zoomHrefP(f);
  assert.equal(href, zoomHrefS(f), 'the Problems page and the strip build the same link');
  const u = new URL(href, 'http://127.0.0.1/');
  assert.equal(u.pathname, '/replay.html');
  assert.equal(u.searchParams.get('session'), f.session);
  const parts = u.hash.slice(1).split('~');
  assert.equal(parts[0], f.thread);
  assert.equal(zoomKey(parts), f.key);
  // With a record open the address gains the step, and the key still reads back.
  assert.equal(zoomKey(`${u.hash.slice(1)}~${f.event}`.split('~')), f.key);
  assert.equal(zoomKey([f.thread, f.event]), null, 'a plain step address is not a zoom');
  const again = await ask({ finding: zoomKey(parts) });
  assert.equal(again.body.finding.event, f.event);
  assert.equal(zoomHrefP({ ...f, key: 'not-a-key' }), null, 'only a key with its shape reaches a link');
});

test('the pages read the names the answer carries, and leaving the zoom clears it', () => {
  const r = page('replay.js');
  for (const name of ["load('problems', { finding: key })", 'z.near', 'z.total', 'z.unread', 'z.lanes', 'f.verdictEvidence', 'zoomhalo']) assert.ok(r.includes(name), `replay.js reads ${name}`);
  // The fit control, Esc, double-click and the whole-session choice all leave through fitAll.
  assert.match(r, /\$\('fit'\)\.addEventListener\('click', fitAll\)/);
  assert.match(r, /ev\.key === 'Escape' && !document\.querySelector\('\.drawer\.open'\)\) fitAll\(\)/);
  assert.match(r, /function fitAll\(\) \{\s*if \(Z\) clearZoom\(\);/);
  assert.match(page('replay.html'), /id="zoomFinding" role="region"/);
  const p = page('problems.js');
  for (const name of ['f.zoom', 'f.key', 'data-zoomlink', 'Zoom to these steps']) assert.ok(p.includes(name), `problems.js has ${name}`);
  assert.ok(page('strip.js').includes('zoomLink(i.f)'), "the record panel's finding box offers the zoom");
});
