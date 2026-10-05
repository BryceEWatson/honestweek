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
import { blocks, drawProblems, words } from './helpers/problems-page.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { earlierWindow, loadCatalog, PATTERN_CHECKS } from '../lib/problems/index.mjs';
import { DRAFTS } from '../lib/problems/drafts.mjs';

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

test('the whole page: forty-one patterns with the fields the page reads, and the checks, coverage and rule', () => {
  for (const k of ['window', 'catalog', 'groups', 'priorityRule', 'statusCounts', 'coverage', 'rules', 'checks', 'patterns', 'sessions', 'focus', 'view']) assert.ok(k in whole, k);
  assert.equal(whole.patterns.length, 41);
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
  for (const name of ['D.priorityRule', 'D.statusCounts', 'D.focus', 'D.checks', 'D.coverage', 'D.catalog', 'D.rules', 'D.sessions', 'p.headline', 'p.name', 'p.looksLike', 'p.whyItMatters', 'p.strengthReason', 'p.sourceKinds', 'p.detection', 'p.mitigation', 'p.sure', 'p.possible', 'p.claim', 'p.testPrompt', 'f.basis', 'f.note', 'f.text', 'f.kind', 'p.notesFound', 'p.draft', 'p.coverage', 'f.verdictEvidence', 'f.checkTitle', 'f.relatedLabel', 'f.stillRunning', 's.link', 's.says', '.tool]']) assert.ok(js.includes(name), `problems.js reads ${name}`);
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
  assert.deepEqual(strip.catalogIds.length, 41, 'every catalog id, so overrides for other patterns stay');
  assert.ok(strip.patterns.every((p) => strip.findings.some((x) => x.pattern === p.id)));
  for (const p of strip.patterns) for (const k of ['id', 'name', 'group', 'status', 'priority', 'fix']) assert.ok(k in p, `strip pattern.${k}`);
  const goal = await body({ goal: goalKey(w.goalRecord.goals[0].id) });
  assert.ok(Array.isArray(goal.findings) && Array.isArray(goal.sessions));
  for (const b of [one, strip, goal]) assert.equal(leaks.redacted(b).total, 0);
});

test('the summary every header reads: each pattern\'s tier and counts, no findings, clean of leaks', async () => {
  const sum = await body({ summary: '1' });
  assert.equal(sum.summary, true);
  assert.equal(sum.patterns.length, 41);
  assert.equal(sum.catalogIds.length, 41, 'every catalog id, so "My priority" for any pattern stays');
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

test("a session's repository label with a private word in it goes out hidden, even in an id's shape", () => {
  // The sessions map as the route sends it: the label is text from the config, never an id, so
  // the full redactor runs on it even when it looks like one.
  const full = createRedactor(w.config).redact;
  const out = redactAnswer({ 'cc-abcd': { title: null, thread: 'cc-abcd', tool: 'codex', repo: `${PRIVATE_WORDS[0]}-site` } }, full);
  assert.ok(!out['cc-abcd'].repo.includes(PRIVATE_WORDS[0]), out['cc-abcd'].repo);
  assert.match(out['cc-abcd'].repo, /\[redacted:/);
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

// ---- a private word that is also in a published source title ----------------------------

// A word some catalog source titles use, configured here as a private word.
const SHARED_WORD = 'harnesses';
const sharedHits = (text) => text.toLowerCase().split(SHARED_WORD).length - 1;
const usesShared = (s) => sharedHits(s.title) > 0;
const sharedConfig = { ...w.config, redaction: { ...w.config.redaction, terms: [...(w.config.redaction.terms ?? []), SHARED_WORD] } };
const shared = createLeakCounter(sharedConfig);

test('a private word that is also in a published source title is not counted as a leak', async () => {
  const catalog = JSON.parse(readFileSync(join(HERE, '..', 'lib', 'problems', 'catalog.json'), 'utf8'));
  const sources = catalog.patterns.flatMap((p) => p.sources);
  const titled = sources.filter(usesShared);
  assert.ok(titled.length > 0, `a catalog source title still uses "${SHARED_WORD}"`);

  // The answer a person with that private word gets: the titles go out whole, everything else redacted.
  const view = createViewData({ config: sharedConfig, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, selfTest: true });
  await view.start();
  const r = await view.route('/api/problems', params());
  assert.equal(r.status, 200);
  const shown = r.body.patterns.flatMap((p) => p.sources).filter(usesShared);
  assert.equal(shown.length, titled.length, 'the titles are shown as published, the word included');
  // Without the catalog set aside, the counter reads the word in each title and address as a leak.
  const before = createLeakCounter(sharedConfig, { catalog: { patterns: [] } }).redacted(r.body);
  const published = sources.reduce((n, s) => n + sharedHits(s.title) + sharedHits(s.url), 0);
  assert.ok(published >= titled.length);
  assert.deepEqual([before.terms, before.total], [published, published]);
  assert.deepEqual(shared.redacted(r.body), { terms: 0, paths: 0, emails: 0, secrets: 0, total: 0 });

  // The page's side: each title is one text node and each address one href, checked on its own.
  const parts = sources.flatMap((s) => [s.title, s.url]);
  assert.equal(shared.redacted(parts).total, 0);
  assert.equal(shared.redacted(titled[0].title).total, 0);
  assert.equal(shared.redacted([`  ${titled[0].title.replace(/ /g, '  ')} `.replace(/\s+/g, ' ').trim()]).total, 0, 'a text node has its whitespace collapsed');
  // A private word in an address: the whole address on the page, and its parts in the answer.
  const host = createLeakCounter({ redaction: { terms: ['examplehost'] } }, { catalog: { patterns: [{ sources: [{ title: 'A study', url: 'https://examplehost.test/a/b' }] }] } });
  assert.equal(host.redacted(['A study', 'https://examplehost.test/a/b']).total, 0);
  assert.equal(host.redacted({ patterns: [{ sources: [{ title: 'A study', link: splitUrl('https://examplehost.test/a/b') }] }] }).total, 0);
});

test('the same private word still counts everywhere but a published title or address', async () => {
  const catalog = JSON.parse(readFileSync(join(HERE, '..', 'lib', 'problems', 'catalog.json'), 'utf8'));
  const src = catalog.patterns.flatMap((p) => p.sources).find(usesShared);
  const link = splitUrl(src.url);
  const terms = (value) => shared.redacted(value).terms;
  const occurrences = sharedHits(src.title);

  // Text from logs, config, goals or repositories, on the page and in an answer.
  assert.equal(terms(`a session about ${SHARED_WORD}`), 1);
  assert.equal(terms(['Problems', `${SHARED_WORD} repo`, src.title]), 1);
  assert.equal(terms({ sessions: { k: { title: `Fix ${SHARED_WORD}` } } }), 1);
  assert.equal(terms({ goals: [{ key: 'g', title: SHARED_WORD }] }), 1);
  // A title with anything added to it, or one that isn't checked on its own, is not the published text.
  assert.equal(terms([`${src.title} (draft)`]), occurrences);
  assert.equal(terms({ note: src.title }), occurrences, 'a log field holding the same words');
  assert.equal(terms([[src.title]]), occurrences, 'a value nested inside a part');
  assert.equal(terms({ text: src.title, facts: {} }), occurrences);
  // A source's title and link are set aside only together, as the catalog publishes them.
  assert.equal(terms({ title: src.title, link: splitUrl('https://example.com/other') }), occurrences, 'another address');
  assert.equal(terms({ title: src.title }), occurrences, 'no link');
  assert.equal(terms({ title: `${src.title}!`, link }), occurrences + sharedHits(src.url), 'a changed title: neither field is set aside');
  assert.equal(terms({ title: src.title, link, says: `It says ${SHARED_WORD}.`, date: '2025-01-01', kind: 'docs' }), 1, "a source's other fields still count");
  const host = createLeakCounter({ redaction: { terms: ['examplehost'] } }, { catalog: { patterns: [{ sources: [{ title: 'A study', url: 'https://examplehost.test/a/b' }] }] } });
  assert.ok(host.redacted(['https://examplehost.test']).terms > 0, 'part of an address on its own');
  assert.ok(host.redacted(['https://examplehost.test/a/b?x=1']).terms > 0, 'an address with anything added');

  // On the Problems answer itself: the word in a finding, a session title or a pattern's own text counts.
  const view = createViewData({ config: sharedConfig, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, selfTest: true });
  await view.start();
  const answered = (await view.route('/api/problems', params())).body;
  assert.equal(terms(answered), 0);
  const withFinding = structuredClone(answered);
  const found = withFinding.patterns.find((p) => p.findings?.length);
  found.findings[0].note = `seen near ${SHARED_WORD}`;
  assert.equal(terms(withFinding), 1);
  const withSays = structuredClone(answered);
  withSays.patterns.find((p) => p.sources.length).sources[0].says = `It says ${SHARED_WORD}.`;
  assert.equal(terms(withSays), 1);
  const withSession = structuredClone(answered);
  withSession.sessions = { ...withSession.sessions, made: { title: `About ${SHARED_WORD}`, thread: null, tool: null } };
  assert.equal(terms(withSession), 1);
  // A secret is still found with the switch on, where nothing is set aside.
  assert.equal(shared.secrets([src.title, `token=${SECRETS.token ?? Object.values(SECRETS)[0]}`]).total, 1);
});

// ---- Problems first: the fix to copy, worked out against possible, and the trend ----------------

test("each pattern's fix is the catalog's draft, word for word, and its test prompt rides along", () => {
  for (const p of whole.patterns) {
    assert.deepEqual(p.draft, DRAFTS[p.id] ?? null, `${p.id}: the draft the Copy button copies`);
    const cat = loadCatalog().patterns.find((x) => x.id === p.id);
    assert.equal(p.testPrompt, PATTERN_CHECKS[p.id] ? cat.testPrompt : null, `${p.id}: its test prompt`);
  }
});

// ---- where each check and fix works: Claude Code and Codex ------------------------------------
const COVER_STATUS = ['runs', 'partial', 'not yet'];

test('every catalog pattern says whether its check runs on Claude Code and on Codex, and the answer carries it', () => {
  for (const p of loadCatalog().patterns) {
    assert.deepEqual(Object.keys(p.coverage ?? {}).sort(), ['claudeCode', 'codex'], `${p.id}: both coverage fields`);
    for (const [agent, c] of Object.entries(p.coverage)) {
      assert.ok(COVER_STATUS.includes(c.status), `${p.id}.${agent}: ${c.status}`);
      if (c.status !== 'runs') assert.ok(typeof c.why === 'string' && c.why.length > 10, `${p.id}.${agent}: a ${c.status} says why`);
    }
    // A pattern with no check runs on neither; one with a check runs on Claude Code, the agent it was built on.
    if (!PATTERN_CHECKS[p.id]) assert.deepEqual([p.coverage.claudeCode.status, p.coverage.codex.status], ['not yet', 'not yet'], p.id);
    else assert.equal(p.coverage.claudeCode.status, 'runs', p.id);
  }
  for (const p of whole.patterns) assert.deepEqual(p.coverage, loadCatalog().patterns.find((x) => x.id === p.id).coverage, `${p.id}: coverage as the catalog has it`);
});

test('every fix says where it goes in Codex, and no Codex form names a Claude-only file or tool', () => {
  // Claude Code's settings and instructions files, and its tool names as a hook matcher sees them.
  const CLAUDE_ONLY = /settings\.json|CLAUDE\.md|\.claude\b|user settings|\b(?:Read|Edit|Write|MultiEdit|Bash|PowerShell|TodoWrite|NotebookEdit|Agent|Task|WebFetch)\b/;
  for (const [id, d] of Object.entries(DRAFTS)) {
    assert.ok(d.codex && typeof d.codex.where === 'string', `${id}: a Codex line`);
    assert.match(d.codex.where, /^(?:In Codex: |No Codex equivalent yet)/, `${id}: the line says it's about Codex`);
    assert.deepEqual(Object.keys(d.codex).filter((k) => !['where', 'text'].includes(k)), [], id);
    for (const t of [d.codex.where, d.codex.text ?? '']) {
      assert.doesNotMatch(t, CLAUDE_ONLY, `${id}: the Codex form names a Claude-only file or tool`);
      // A path starting with ~ reads as a home folder and the redactor hides it, so Copy would refuse it.
      assert.doesNotMatch(t, /~[\\/]/, `${id}: a ~ path`);
    }
  }
  // The answer carries the Codex form unredacted, so its Copy button works.
  const withText = whole.patterns.filter((p) => p.draft?.codex?.text);
  assert.ok(withText.length >= 5, 'some fixes have a Codex version to copy');
  for (const p of withText) assert.doesNotMatch(p.draft.codex.text, /\[redacted:/, p.id);
});

test('a private word that is a coverage status leaves the status whole, and the reason is still redacted', async () => {
  // "measured" is in every partial Codex reason, so it shows the reason still goes through the redactor.
  const config = { ...w.config, redaction: { ...w.config.redaction, terms: [...(w.config.redaction?.terms ?? []), 'runs', 'partial', 'not yet', 'measured'] } };
  const own = createViewData({ config, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord });
  await own.start();
  const r = await own.route('/api/problems', params());
  assert.equal(r.status, 200);
  const catalog = loadCatalog().patterns;
  for (const p of r.body.patterns) {
    const cat = catalog.find((x) => x.id === p.id).coverage;
    for (const agent of ['claudeCode', 'codex']) assert.equal(p.coverage[agent].status, cat[agent].status, `${p.id}.${agent}: the status the catalog gives`);
  }
  const partial = r.body.patterns.find((p) => p.coverage.codex.status === 'partial');
  assert.match(catalog.find((x) => x.id === partial.id).coverage.codex.why, /measured/);
  assert.doesNotMatch(partial.coverage.codex.why, /measured/, 'the reason is redacted');
  assert.match(partial.coverage.codex.why, /\[redacted:/);
  await own.stop?.();
});

test('the Problems answer is otherwise unchanged: coverage, the Codex form and the headline are the only new fields', () => {
  const BEFORE = ['claim', 'count', 'countEvidence', 'derivedFound', 'detection', 'draft', 'findings', 'findingsListed', 'group', 'id', 'look', 'looksLike', 'measures', 'mitigation', 'name', 'notRun', 'notesFound', 'possible', 'priority', 'related', 'sourceKinds', 'sources', 'status', 'strength', 'strengthReason', 'sure', 'testPrompt', 'tokens', 'whyItMatters'];
  for (const p of whole.patterns) {
    assert.deepEqual(Object.keys(p).filter((k) => k !== 'coverage' && k !== 'headline').sort(), BEFORE, p.id);
    if (p.draft) assert.deepEqual(Object.keys(p.draft).filter((k) => k !== 'codex').sort(), ['kind', 'text', 'title', 'where'], p.id);
  }
});

test("each pattern carries the catalog's headline beside its unchanged name, and the summary and strip keep the name alone", async () => {
  const catalog = loadCatalog().patterns;
  for (const p of whole.patterns) {
    const cat = catalog.find((x) => x.id === p.id);
    assert.equal(p.headline, cat.headline, `${p.id}: the headline as the catalog has it`);
    assert.equal(p.name, cat.name, `${p.id}: the name as before`);
  }
  // The answers other pages read stay as they were: no headline in the summary or the strip.
  const sum = await body({ summary: '1' });
  assert.ok(sum.patterns.every((p) => !('headline' in p)));
  const f = allFindings(whole).find((x) => x.thread);
  const strip = await body({ thread: f.thread });
  assert.ok(strip.patterns.every((p) => !('headline' in p)));
});

test("the page draws this week's answer: every found pattern on the landing by its headline, every finding row naming its session's agent", async () => {
  const trend = (await answer({ trend: '1' })).body;
  const { el } = await drawProblems(whole, { trend });
  const landing = `${el('cards').innerHTML}${el('possible').innerHTML}`;
  const found = whole.patterns.filter((p) => p.status === 'found');
  for (const p of found) assert.ok(landing.includes(`<a class="ptitle" href="#${p.id}">`), `${p.id} is on the landing`);
  assert.match(el('headline').textContent, /^(\d+ problems? to fix|No problem to fix)(, \d+ smaller)?(, \d+ to check)?$/);
  const AGENT = { 'claude-code': 'Claude Code', codex: 'Codex' };
  const rows = blocks(el('cards').innerHTML, 'li', 'frow');
  assert.ok(rows.length > 0, 'some finding rows');
  for (const r of rows) {
    const s = r.match(/data-session="([^"]*)"/)[1];
    const name = AGENT[whole.sessions[s]?.tool];
    if (name) assert.ok(r.includes(`<span class="agent">${name}</span>`), `${s}: ${name}`);
    else assert.doesNotMatch(r, /class="agent"/);
  }
  // Every session behind a finding names its configured repository, and the row shows it.
  const keys = [...new Set(found.flatMap((p) => p.findings.map((f) => f.session)).filter(Boolean))];
  assert.ok(keys.length > 0 && keys.every((k) => typeof whole.sessions[k]?.repo === 'string' && whole.sessions[k].repo.length > 0), 'each session carries its repository');
  for (const r of rows) {
    const s = r.match(/data-session="([^"]*)"/)[1];
    assert.ok(r.includes(`<span class="repotag" title="Repository">${whole.sessions[s].repo}</span>`), `${s}: its repository`);
  }
  // The drawn landing holds no private word and no secret.
  const shown = words(landing);
  for (const word of PRIVATE_WORDS) assert.ok(!shown.includes(word), `no "${word}"`);
  for (const s of Object.values(SECRETS)) assert.ok(!shown.includes(s));
  assert.equal(leaks.redacted(shown).total, 0);
  // Each found pattern opens on its own, by its id.
  for (const p of found) {
    const { el: d } = await drawProblems(whole, { hash: `#${p.id}`, trend });
    assert.ok(d('detail').innerHTML.includes(`>${p.headline.replace(/'/g, '&#39;')}</h1>`), p.id);
  }
});

test('each pattern says how many findings are worked out and how many are possible, and lists the worked-out ones first', () => {
  const sure = (f) => f.verdictEvidence === 'recorded' || f.verdictEvidence === 'derived';
  for (const p of whole.patterns) {
    assert.equal(p.sure.count + p.possible.count, p.count, `${p.id}: every finding is one or the other`);
    assert.equal(p.sure.look + p.possible.look, p.look, p.id);
    const f = p.findings;
    const firstPossible = f.findIndex((x) => !sure(x));
    if (firstPossible >= 0) assert.ok(f.slice(firstPossible).every((x) => !sure(x)), `${p.id}: worked out first, then possible`);
    assert.equal(f.filter(sure).length, Math.min(p.sure.count, 25), `${p.id}: up to 25 of each kind listed`);
    assert.equal(f.filter((x) => !sure(x)).length, Math.min(p.possible.count, 25), p.id);
  }
});

test('the trend answers for every pattern, reads the earlier window once, and says when it has no logs', async () => {
  let builds = 0;
  const d = createViewData({ config: w.config, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, buildHistory: (o) => {
    builds += 1;
    return buildWorkHistory(o);
  } });
  await d.start();
  const before = builds;
  const a = await d.route('/api/problems', params({ trend: '1' }));
  assert.equal(a.status, 200);
  const t = a.body;
  assert.equal(builds, before + 1, 'one more build, for the earlier window');
  await d.route('/api/problems', params({ trend: '1' }));
  assert.equal(builds, before + 1, 'and only once');
  assert.deepEqual(t.earlier, { ...earlierWindow(WINDOW), sessions: 0 });
  assert.deepEqual(t.trend.map((x) => x.id).sort(), whole.patterns.map((p) => p.id).sort(), 'a list, so no pattern id is an object key');
  for (const p of whole.patterns.filter((x) => x.status === 'found')) {
    const row = t.trend.find((x) => x.id === p.id);
    assert.equal(row.why, 'no-logs', `${p.id}: the fixture's earlier week has no logs`);
    assert.equal(row.sure.before, null, `${p.id}: never a zero for a window with nothing to read`);
    assert.equal(row.sure.now.value, p.sure.look, `${p.id}: now is the main list's count`);
    assert.equal(row.possible.now.value, p.possible.look, p.id);
  }
  assert.equal(leaks.redacted(t).total, 0);
});
