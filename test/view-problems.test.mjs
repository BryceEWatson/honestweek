// /api/problems (lib/view/problems-route.mjs, served by lib/view/data.mjs) over the made-up view
// week, which is seeded with private words, a name and secrets: the fields the Problems page and
// the "Worth a look" strip read, the leak counter in both modes, the switch changing only text,
// and the refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { createRedactor } from '../lib/redact.mjs';
import { createViewData, goalKey } from '../lib/view/data.mjs';
import { createLeakCounter } from '../lib/view/leaks.mjs';
import { createProblemsRoute, redactAnswer, splitUrl } from '../lib/view/problems-route.mjs';
import { buildViewWeek, PRIVATE_WORDS, SECRETS, WEEK } from './fixtures/view/week.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = (f) => readFileSync(join(HERE, '..', 'lib', 'view', 'assets', f), 'utf8');

const scratch = makeTempDir('hw-view-problems-');

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
    assert.ok(['recorded', 'derived', 'inferred', 'missing'].includes(f.verdictEvidence), f.verdictEvidence);
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

test('the summary every header reads: each pattern\'s tier and counts, no findings, clean of leaks', async () => {
  const sum = await body({ summary: '1' });
  assert.equal(sum.summary, true);
  assert.equal(sum.patterns.length, 40);
  assert.equal(sum.catalogIds.length, 40, 'every catalog id, so "My priority" for any pattern stays');
  for (const p of sum.patterns) {
    assert.deepEqual(Object.keys(p).sort(), ['count', 'countEvidence', 'fix', 'group', 'id', 'look', 'lookSessions', 'name', 'notesFound', 'priority', 'status', 'strength', 'tokens']);
    const full = whole.patterns.find((x) => x.id === p.id);
    for (const k of ['name', 'status', 'priority', 'count', 'look', 'notesFound', 'countEvidence']) assert.deepEqual(p[k], full[k], `${p.id}.${k} matches the whole page`);
    // The sessions with a finding worth a look, worked out from the same findings.
    const sessions = new Set((full.findings ?? []).filter((f) => f.severity === 'look').map((f) => f.session));
    if (full.findingsListed === (full.findings ?? []).length) assert.equal(p.lookSessions, sessions.size, `${p.id}.lookSessions`);
    assert.ok(p.lookSessions <= p.look, `${p.id}: no more sessions than findings worth a look`);
  }
  assert.ok(!('findings' in sum) && sum.patterns.every((p) => !('findings' in p)), 'no finding in the summary');
  assert.equal(leaks.redacted(sum).total, 0);
  const t = JSON.stringify(sum);
  for (const word of PRIVATE_WORDS) assert.ok(!t.includes(word), `no "${word}"`);
  // The pages read the names the summary carries.
  const common = page('common.js');
  for (const name of ["load('problems', { summary: 1 })", "p.status === 'found'", 'p?.priority?.tier']) assert.ok(common.includes(name), `common.js reads ${name}`);
  const search = page('search.js');
  for (const name of ['p.lookSessions', 'p.countEvidence', 'p.tokens?.tokens', 'a.coverage?.tokens']) assert.ok(search.includes(name), `search.js reads ${name}`);
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

test("every rule a check or a finding names is defined in the answer, the engine's included", () => {
  const ids = new Set(whole.rules.map((r) => r.id));
  for (const id of ['shell.test', 'prompt.approval', 'problems.risky-command', 'cost.step']) assert.ok(ids.has(id), id);
  for (const f of allFindings(whole)) {
    for (const id of String(f.rule ?? '').match(/\b[a-z]+\.[a-z][a-z-]*\b/g) ?? []) assert.ok(ids.has(id), `${id} (named by ${f.check})`);
  }
});

test('the checks run as of when the build read the logs, and a failure answers 500 with its message redacted', () => {
  let seen = null;
  const word = PRIVATE_WORDS[0];
  const route = createProblemsRoute({
    now: () => 9e12,
    run: (h, { builtT }) => {
      seen = builtT;
      throw new Error(`stopped near ${word}`);
    },
  });
  const ctx = { mode: 'redacted', redact: (s) => String(s).split(word).join('[redacted:term]') };
  const r = route(ctx, new URLSearchParams(), { redactedH: { rules: {} }, builtT: 1234, goalsOf: () => [], membersOfGoal: () => null, evidenceKey: {}, idOk: () => true });
  assert.equal(seen, 1234, "the build's own time, not the first request's");
  assert.equal(r.status, 500);
  assert.ok(!r.body.error.includes(word));
  assert.match(r.body.error, /couldn't run/);
});

test("a catalog source's title and address go out whole, as published; everything from the logs stays redacted", () => {
  const catalog = JSON.parse(readFileSync(join(HERE, '..', 'lib', 'problems', 'catalog.json'), 'utf8'));
  const full = createRedactor(w.config).redact;
  let hidden = 0;
  for (const p of catalog.patterns) {
    const sent = whole.patterns.find((x) => x.id === p.id).sources;
    assert.equal(sent.length, p.sources.length);
    p.sources.forEach((s, i) => {
      assert.equal(sent[i].title, s.title, `${p.id}: the title as published`);
      assert.deepEqual(sent[i].link, splitUrl(s.url), `${p.id}: the address as published, in parts`);
      assert.equal(sent[i].link.join(''), s.url);
      // What the redactor would have done to it: the reason for the exception.
      if (full(s.title) !== s.title || splitUrl(s.url).map(full).join('') !== s.url) hidden += 1;
    });
  }
  assert.ok(hidden > 0, 'the redactor would hide part of at least one published title or address');
  assert.ok(!JSON.stringify(whole.patterns.map((p) => p.sources.map((s) => [s.title, s.link]))).includes('[redacted:'));
  // The page's own rule for a link it can open holds for every source.
  const linkOf = runInNewContext(`(${page('problems.js').match(/const linkOf = (\(parts\) => [^\n]+);/)[1]})`);
  for (const p of whole.patterns) for (const s of p.sources) assert.ok(linkOf(s.link), `${p.id}: ${s.title} has a working link`);
  // The exception is the two catalog fields only: the whole answer still counts no leak, and
  // no private word or secret from the logs shows.
  assert.equal(leaks.redacted(whole).total, 0);
  const t = JSON.stringify(whole);
  for (const word of PRIVATE_WORDS) assert.ok(!t.includes(word), `no "${word}"`);
  for (const s of Object.values(SECRETS)) assert.ok(!t.includes(s));
});

test('a private word from the logs is still hidden everywhere else when a catalog source goes out whole', () => {
  const word = PRIVATE_WORDS[0];
  const url = 'https://example.com/pdf/ac7c37ae-7f4c-4442-b741-2eabdeaf77e0/report.pdf';
  const route = createProblemsRoute({
    run: () => ({
      window: {}, catalog: {}, groups: [], priorityRule: null, statusCounts: {}, coverage: {}, rules: {}, checks: [],
      patterns: [{ id: 'made-up', name: `About ${word}`, group: 'g', sources: [{ title: `A report that cost $51 and names ${word}`, url, date: '2025-01-01', kind: 'docs', says: `It says ${word}.` }], detection: { level: 'derived', summary: '', signals: [], falsePositives: [] }, mitigation: [], related: [], findings: [{ pattern: 'made-up', check: 'c', severity: 'look', verdictEvidence: 'derived', note: `seen near ${word}` }] }],
    }),
  });
  const redact = (s) => String(s).split(word).join('[redacted:term]').replace(/\$\d+/g, '[redacted:account]').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '[redacted:secret]');
  const ctx = { mode: 'redacted', redact, b: {}, sessionByKey: new Map() };
  const r = route(ctx, new URLSearchParams(), { redactedH: { rules: {} }, builtT: 1, goalsOf: () => [], membersOfGoal: () => null, evidenceKey: {}, idOk: () => true });
  const p = r.patterns[0];
  assert.equal(p.sources[0].title, `A report that cost $51 and names ${word}`, 'the published title, whole');
  assert.equal(p.sources[0].link.join(''), url);
  assert.equal(p.sources[0].says, 'It says [redacted:term].', "the catalog's other text still passes the redactor");
  assert.equal(p.name, 'About [redacted:term]');
  assert.equal(p.findings[0].note, 'seen near [redacted:term]', 'and so does everything from a log');
});
