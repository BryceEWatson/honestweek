// /api/problems (lib/view/problems-route.mjs, served by lib/view/data.mjs) over the made-up view
// week, which is seeded with private words, a name and secrets: the fields the Problems page and
// the "Worth a look" strip read, the leak counter in both modes, the switch changing only text,
// and the refusals.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createViewData, goalKey } from '../lib/view/data.mjs';
import { createLeakCounter } from '../lib/view/leaks.mjs';
import { redactAnswer, splitUrl } from '../lib/view/problems-route.mjs';
import { buildViewWeek, PRIVATE_WORDS, SECRETS, WEEK } from './fixtures/view/week.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = (f) => readFileSync(join(HERE, '..', 'lib', 'view', 'assets', f), 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'hw-view-problems-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const w = buildViewWeek(join(scratch, 'week'));
const WINDOW = { from: WEEK.from, to: WEEK.to, timezone: 'UTC' };
const data = createViewData({ config: w.config, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, selfTest: true });
await data.start();
const leaks = createLeakCounter(w.config);
const params = (q = {}) => new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined));
const answer = (q = {}) => data.route('/api/problems', params(q));
const body = async (q) => {
  const r = await answer(q);
  assert.equal(r.status, 200, `/api/problems ${JSON.stringify(q)} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
};
const whole = await body();
const allFindings = (b) => b.patterns.flatMap((p) => p.findings ?? []);

test('the whole page: forty patterns with the fields the page reads, and the checks, coverage and rule', () => {
  for (const k of ['window', 'catalog', 'groups', 'priorityRule', 'statusCounts', 'coverage', 'rules', 'checks', 'patterns', 'sessions', 'focus', 'view']) assert.ok(k in whole, k);
  assert.equal(whole.patterns.length, 40);
  assert.equal(whole.focus, null);
  for (const p of whole.patterns) {
    for (const k of ['id', 'name', 'group', 'looksLike', 'whyItMatters', 'strength', 'strengthReason', 'sourceKinds', 'sources', 'detection', 'mitigation', 'related', 'status', 'measures', 'count', 'look', 'notesFound', 'tokens', 'priority', 'draft', 'findings', 'findingsListed']) assert.ok(k in p, `${p.id}.${k}`);
    assert.ok(['found', 'clear', 'unchecked', 'undetectable'].includes(p.status));
    assert.equal(p.priority == null, p.status !== 'found', `${p.id}: a tier only when found`);
    for (const s of p.sources) assert.deepEqual(Object.keys(s).sort(), ['date', 'kind', 'link', 'says', 'title']);
  }
  const found = whole.patterns.filter((p) => p.status === 'found');
  assert.ok(found.length >= 2, 'the seeded week shows some problems');
  for (const f of allFindings(whole)) {
    for (const k of ['pattern', 'check', 'checkTitle', 'severity', 'verdictEvidence', 'rule', 'session', 'thread', 'event', 'related', 'at', 'note', 'text', 'events', 'estimate', 'goals']) assert.ok(k in f, `finding.${k}`);
    assert.ok(['look', 'note'].includes(f.severity));
    assert.ok(['recorded', 'derived', 'inferred'].includes(f.verdictEvidence));
  }
  // The seeded secrets are found, counted, and never shown.
  assert.equal(whole.patterns.find((p) => p.id === 'secret-exposure').status, 'found');
  const text = JSON.stringify(whole);
  for (const s of Object.values(SECRETS)) assert.ok(!text.includes(s), 'no secret in the answer');
});

test('the page reads the names the answer carries (the page side of the contract)', () => {
  const js = page('problems.js');
  for (const name of ['D.priorityRule', 'D.statusCounts', 'D.focus', 'D.checks', 'D.coverage', 'D.catalog', 'D.rules', 'p.looksLike', 'p.whyItMatters', 'p.strengthReason', 'p.sourceKinds', 'p.detection', 'p.mitigation', 'p.findingsListed', 'p.notesFound', 'p.draft', 'f.verdictEvidence', 'f.checkTitle', 'f.relatedLabel', 'f.stillRunning', 's.link', 's.says']) assert.ok(js.includes(name), `problems.js reads ${name}`);
  const strip = page('strip.js');
  for (const name of ['A?.findings', 'A.catalogIds', 'A?.patterns', 'f.lastAt', 'f.verdictEvidence', 'f.checkTitle', 'p.fix', 'p.priority']) assert.ok(strip.includes(name), `strip.js reads ${name}`);
});

test('redacted by default: the leak counter finds nothing, and no private word shows', () => {
  for (const b of [whole]) {
    const n = leaks.redacted(b);
    assert.equal(n.total, 0, `leaks ${JSON.stringify(n)}`);
    const t = JSON.stringify(b);
    for (const word of PRIVATE_WORDS) assert.ok(!t.includes(word), `no "${word}"`);
  }
});

test('one session, the strip for a thread and for a goal, each clean of leaks', async () => {
  const f = allFindings(whole).find((x) => x.thread && x.severity === 'look') ?? allFindings(whole).find((x) => x.thread);
  assert.ok(f, 'a finding in a replayable session');
  const one = await body({ session: f.session });
  assert.equal(one.focus.session, f.session);
  assert.ok(one.focus.findings >= 1);
  assert.ok(allFindings(one).every((x) => x.session === f.session), 'only that session');
  const strip = await body({ thread: f.thread });
  assert.ok(strip.findings.some((x) => x.event === f.event));
  assert.deepEqual(strip.catalogIds.length, 40, 'every catalog id, so overrides for other patterns stay');
  assert.ok(strip.patterns.every((p) => strip.findings.some((x) => x.pattern === p.id)));
  for (const p of strip.patterns) for (const k of ['id', 'name', 'group', 'status', 'priority', 'fix']) assert.ok(k in p, `strip pattern.${k}`);
  const goal = await body({ goal: goalKey(w.goalRecord.goals[0].id) });
  assert.ok(Array.isArray(goal.findings) && Array.isArray(goal.sessions));
  for (const b of [one, strip, goal]) assert.equal(leaks.redacted(b).total, 0);
});

test('with the switch on: the same findings, private words in their text, secrets still hidden', async () => {
  await data.start('private');
  const priv = await body({ private: '1' });
  assert.equal(priv.view.shown, 'private');
  const ids = (b) => allFindings(b).map((f) => `${f.pattern}|${f.session}|${f.event}|${f.severity}`).sort();
  assert.deepEqual(ids(priv), ids(whole), 'the switch changes only text');
  assert.deepEqual(priv.statusCounts, whole.statusCounts);
  assert.equal(leaks.secrets(priv).total, 0);
  const t = JSON.stringify(priv);
  for (const s of Object.values(SECRETS)) assert.ok(!t.includes(s));
});

test('refusals: a malformed id, an unknown goal; a well-formed session the window lacks is an empty view', async () => {
  assert.equal((await answer({ session: '../etc' })).status, 400);
  assert.equal((await answer({ thread: 'th-<x>' })).status, 400);
  assert.equal((await answer({ goal: 'gnope' })).status, 404);
  const none = await body({ session: 'cc-aaaaaaaaaaaa' });
  assert.equal(none.focus.known, false);
  assert.equal(allFindings(none).length, 0);
});

test('redactAnswer keeps ids, times and dates by key and shape, and redacts everything else', () => {
  const red = (s) => s.replace(/Northwind/g, '[redacted:term]');
  const out = redactAnswer({ session: 'cc-abcd', event: 'cc-abcd.12.0', at: '2025-03-10T09:00:00.000Z', from: '2025-03-10', note: 'Northwind', title: 'cc-abcd Northwind', events: ['cc-abcd.1.0'], timezone: 'America/Los_Angeles', id: 'Northwind report' }, red);
  assert.deepEqual(out, { session: 'cc-abcd', event: 'cc-abcd.12.0', at: '2025-03-10T09:00:00.000Z', from: '2025-03-10', note: '[redacted:term]', title: 'cc-abcd [redacted:term]', events: ['cc-abcd.1.0'], timezone: 'America/Los_Angeles', id: '[redacted:term] report' });
  assert.deepEqual(splitUrl('https://example.com/a/b?c=1#d'), ['https://example.com', '/a', '/b', '?c=1', '#d']);
});
