// The contract between honestweek view's data routes (lib/view/data.mjs) and the pages that
// read them (lib/view/assets/*.js and the click-through test in lib/view/selftest/). The two
// sides were built separately from one plan, and several field names drifted apart. These
// tests pin each field a page reads to the answer that carries it: the data side over the
// made-up view week, the page side by reading the page code for the same names.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { createViewData, goalKey } from '../lib/view/data.mjs';
import { EXEMPT_FIELDS } from '../lib/view/leaks.mjs';
import { REPLAY_EVENT_FIELDS } from '../lib/view/replay-export.mjs';
import { buildViewWeek, WEEK } from './fixtures/view/week.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = (f) => readFileSync(join(HERE, '..', 'lib', 'view', f), 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'hw-view-contract-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const w = buildViewWeek(join(scratch, 'week'));
const WINDOW = { from: WEEK.from, to: WEEK.to, timezone: 'UTC' };
const data = createViewData({ config: w.config, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, selfTest: true });
await data.start();
for (let i = 0; i < 400 && data.status().search.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 25));
const reference = await buildWorkHistory({ config: w.config, roots: w.roots, ...WINDOW, scope: 'all', goals: w.goalRecord, hiddenSessions: 'redacted' });

const params = (q = {}) => new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined));
const body = async (path, q = {}) => {
  const r = await data.route(path, params(q));
  assert.equal(r.status, 200, `${path} ${JSON.stringify(q)} answered ${r.status}`);
  return r.body;
};
const LEVELS = new Set(['recorded', 'derived', 'inferred', 'missing']);
const isCount = (c) => !!c && Number.isFinite(c.value) && LEVELS.has(c.evidence);

test('every data answer carries view: which build was asked for and which answered, the window, the demo notice', async () => {
  for (const [path, q] of [['/api/home'], ['/api/lookup', { q: '#12' }], ['/api/words', { q: 'release' }], ['/api/search', { q: 'release' }], ['/api/replay'], ['/api/goal', { key: goalKey(w.goalRecord.goals[0].id) }]]) {
    const v = (await body(path, q)).view;
    assert.deepEqual(Object.keys(v).sort(), ['asked', 'demo', 'note', 'privateState', 'shown', 'window'], path);
    assert.equal(v.asked, 'redacted');
    assert.equal(v.shown, 'redacted');
    assert.deepEqual(v.window, WINDOW);
    assert.equal(v.demo, null, 'no demo notice outside demo mode');
  }
  // The pages read view.window, view.note, view.shown and view.demo, never a bare `mode`.
  const common = page('assets/common.js');
  for (const name of ['answer.view', 'v.window', 'v.note', "v.shown === 'redacted'", 'showDemo(v.demo)']) assert.ok(common.includes(name), `common.js reads ${name}`);
  assert.doesNotMatch(common, /answer\.mode\b|answer\.private\b/);
});

test('status: one slot per build, each with its state and time; asking with private=1 starts the private build', async () => {
  const fresh = createViewData({ config: w.config, roots: w.roots, ...WINDOW, buildHistory: async () => reference });
  await fresh.start();
  let s = fresh.status();
  for (const mode of ['redacted', 'private']) {
    const slot = s.builds[mode];
    for (const k of ['state', 'elapsedMs', 'failed']) assert.ok(k in slot, `builds.${mode}.${k}`);
    assert.ok(Number.isFinite(slot.elapsedMs));
  }
  assert.equal(s.builds.redacted.state, 'ready');
  assert.equal(typeof s.builds.redacted.reading, 'string');
  assert.equal(s.builds.private.state, 'idle');
  assert.equal(s.demo, null);
  assert.equal(s.selfTest, false);
  const r = await fresh.route('/api/status', params({ private: '1' }));
  assert.equal(r.status, 200);
  s = fresh.status();
  assert.ok(['building', 'ready'].includes(s.builds.private.state), 'a status request with private=1 starts the private build');
  assert.ok(!JSON.stringify(r.body).includes('"key"'), 'the status never carries a key');
  // key.js waits on builds.redacted, and on builds.private while the switch is on.
  assert.match(page('assets/key.js'), /s\.builds/);
});

test('home: recent sessions keyed by `session`, with their goals; the goal-list flag; coverage counts; examples', async () => {
  const h = await body('/api/home');
  assert.ok(Array.isArray(h.recent) && h.recent.length > 0);
  assert.ok(!('sessions' in h), 'one name for the recent sessions: recent');
  for (const s of h.recent) {
    for (const k of ['session', 'thread', 'tool', 'title', 'firstAt', 'lastAt', 'evidence', 'goals']) assert.ok(k in s, `recent[].${k}`);
    assert.ok(isCount(s.prompts));
    for (const g of s.goals) for (const k of ['key', 'title', 'evidence', 'ambiguous', 'assigned']) assert.ok(k in g, `recent[].goals[].${k}`);
  }
  assert.ok(h.recent.some((s) => s.goals.length > 0), 'a recent session lists the goals it belongs to');
  assert.deepEqual(Object.keys(h.goalList).sort(), ['given', 'note']);
  assert.equal(h.goalList.given, true);
  for (const k of ['sessionsRead', 'configured', 'display', 'outside', 'filesUnnamed']) assert.ok(isCount(h.coverage[k]), `coverage.${k}`);
  for (const g of h.goals) {
    assert.ok(isCount(g.members) && typeof g.key === 'string');
    // The home goal card's split, and its count's level: the weakest of its sessions.
    for (const k of ['recorded', 'inferred', 'ambiguous', 'assigned']) assert.ok(Number.isInteger(g[k]), `goals[].${k}`);
    assert.equal(g.recorded + g.inferred + g.ambiguous, g.members.value);
  }
  assert.match(page('assets/search.js'), /num\(g\.recorded\)[\s\S]*num\(g\.inferred\)[\s\S]*num\(g\.ambiguous\)[\s\S]*g\.assigned/);
  // A goal's session count reads the same level on every page that shows it.
  assert.match(page('assets/goal.js'), /chip\(HW\.memberLevel\(goal\.members\)\)/);
  assert.match(page('assets/search.js'), /chip\(members \? HW\.memberLevel\(members\)/);
  for (const t of h.try) assert.equal(typeof t.text, 'string');
  const search = page('assets/search.js');
  assert.match(search, /h\?\.recent/);
  assert.match(search, /goalList\?\.given === false/);
  assert.match(search, /c\.filesUnnamed/);
  assert.match(page('assets/goal.js'), /goalList\?\.given === false/);
  assert.match(page('selftest/clickthrough.js'), /env\.home\?\.recent/);
});

test('lookup: kind and the engine\'s reading in `parsed`; a query id; the typed text in `query` only on a restore by id', async () => {
  const typed = '#12';
  const a = await body('/api/lookup', { q: typed });
  assert.equal(a.kind, 'pr');
  assert.equal(a.parsed.kind, 'pr');
  assert.equal(a.parsed.number, 12);
  assert.match(a.queryId, /^q[a-p]{16}$/);
  assert.ok(!('query' in a), 'an answer to typed text never echoes it');
  assert.ok(a.sessions.length > 0);
  for (const s of a.sessions) for (const k of ['session', 'thread', 'title', 'evidence', 'refs', 'goals']) assert.ok(k in s, `sessions[].${k}`);
  for (const g of a.goals) {
    assert.ok(Array.isArray(g.sessions) && g.sessions.length > 0, 'a goal beside a lookup lists the sessions it found');
    for (const m of g.sessions) for (const k of ['session', 'evidence', 'ambiguous', 'assigned']) assert.ok(k in m, `goals[].sessions[].${k}`);
  }
  const again = await body('/api/lookup', { id: a.queryId });
  assert.equal(again.query, typed, 'a restore by id echoes the typed text in `query`');
  assert.deepEqual(EXEMPT_FIELDS, ['query'], 'that echo is the one field the leak counter exempts');
  // A file's lookup groups its sessions by repository, each row with its details and goals.
  const file = await body('/api/lookup', { q: 'lib/format.mjs' });
  for (const g of file.repositories ?? []) for (const s of g.sessions) for (const k of ['session', 'thread', 'title', 'goals']) assert.ok(k in s, `repositories[].sessions[].${k}`);
  const search = page('assets/search.js');
  assert.match(search, /a\.parsed/);
  assert.doesNotMatch(search, /a\.query\?\.|queryText:|a\?\.queryText/, 'the page reads the parsed reference from `parsed`, the typed text from `query`');
  assert.match(search, /a\?\.queryId/);
  assert.match(search, /g\.sessions/);
});

test('words: goals, titled sessions, branches and prompts; a prompt row is recorded and its score inferred; similar= answers in `similar`', async () => {
  const a = await body('/api/words', { q: 'release notes changelog' });
  for (const k of ['goals', 'sessions', 'branches', 'prompts', 'similar', 'rules', 'queryId']) assert.ok(k in a, k);
  for (const g of a.goals) assert.ok(['title', 'id'].includes(g.matchedIn) && isCount(g.members));
  assert.ok(a.prompts.length > 0);
  for (const p of a.prompts) {
    for (const k of ['event', 'session', 'thread', 't', 'text', 'goals']) assert.ok(k in p, `prompts[].${k}`);
    assert.equal(p.evidence, 'recorded', 'the words are in the prompt, so the row is recorded');
    assert.equal(p.score.evidence, 'inferred', 'the shared-word score is a named rule\'s reading');
    assert.equal(p.score.rule, 'view.shared-words');
    assert.ok(Number.isFinite(p.score.value) && Number.isFinite(p.score.of));
  }
  const prompt = reference.events.find((e) => e.session === w.keys.featured && e.kind === 'prompt');
  const sim = await body('/api/words', { similar: prompt.id });
  assert.ok(Array.isArray(sim.similar));
  for (const p of sim.similar) assert.ok(p.score.value >= 0 && p.score.value <= 1 && p.score.evidence === 'inferred');
  const search = page('assets/search.js');
  assert.match(search, /g\.matchedIn/);
  assert.match(search, /Array\.isArray\(a\.similar\) \? a\.similar/);
  assert.match(search, /p\.score\?\.evidence/);
});

test('search everywhere: ready false with a state and a note while the index is read, then counts and results', async () => {
  const fresh = createViewData({ config: w.config, roots: w.roots, ...WINDOW, buildHistory: async () => reference });
  await fresh.start();
  const waiting = await fresh.route('/api/search', params({ q: 'release' }));
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.ready, false);
  assert.ok(['waiting', 'building'].includes(waiting.body.state));
  assert.equal(typeof waiting.body.note, 'string');
  const a = await body('/api/search', { q: 'release' });
  assert.equal(a.ready, true);
  for (const k of ['indexed', 'sessions', 'total']) assert.ok(isCount(a[k]), k);
  assert.ok(a.results.length > 0);
  for (const r of a.results) {
    for (const k of ['session', 'thread', 'group', 'inWindow', 'name', 'named', 'firstAt', 'lastAt', 'evidence', 'titleMatched']) assert.ok(k in r, `results[].${k}`);
    assert.ok(isCount(r.matches));
    for (const s of r.snippets) assert.ok(typeof s.text === 'string' && LEVELS.has(s.evidence));
  }
  const search = page('assets/search.js');
  assert.match(search, /a\.ready !== false/);
  assert.match(search, /a\.state === 'failed'/);
  assert.match(search, /a\.indexed/);
});

test('goal and replay: members, unmatched citations, frames with each count\'s level under its frame name', async () => {
  const g = await body('/api/goal', { key: goalKey(w.goalRecord.goals[0].id) });
  for (const k of ['key', 'title', 'members', 'unmatched', 'sessions', 'agents', 'events', 'frames', 'rules', 'coverage']) assert.ok(k in g, k);
  for (const m of g.members) for (const k of ['session', 'evidence', 'ambiguous', 'assigned', 'joins']) assert.ok(k in m, `members[].${k}`);
  for (const u of g.unmatched) for (const k of ['ref', 'why', 'evidence']) assert.ok(k in u, `unmatched[].${k}`);
  for (const s of g.sessions) for (const k of ['key', 'thread', 'title', 'tool', 'firstAt', 'lastAt']) assert.ok(k in s, `sessions[].${k}`);
  assert.ok(g.frames && !Array.isArray(g.frames), 'frames are keyed by session');
  for (const e of g.events) for (const k of REPLAY_EVENT_FIELDS) assert.ok(k in e, `events[].${k}`);
  const r = await body('/api/replay');
  for (const k of ['thread', 'session', 'sessions', 'agents', 'events', 'frames', 'rules']) assert.ok(k in r, k);
  for (const k of ['id', 'title', 'firstAt', 'lastAt']) assert.ok(k in r.thread, `thread.${k}`);
  assert.ok(Array.isArray(r.session.turns));
  const f = r.frames[0];
  for (const k of ['t', 'prompts', 'actions', 'edits', 'testRuns', 'testsPassed', 'testsFailed', 'commits', 'prsLanded', 'evidence']) assert.ok(k in f, `frames[].${k}`);
  for (const k of ['testsPassed', 'testsFailed', 'commits']) assert.ok(LEVELS.has(f.evidence[k]), `frames[].evidence.${k}`);
  // The pages read a count's level by the frame's name too, so it keeps the engine's level.
  assert.match(page('assets/common.js'), /testRunsAllPassed: 'testsPassed'/);
});

test('record: each read names its part, and a command step carries its output', async () => {
  const action = reference.events.find((e) => e.kind === 'action' && e.facts?.category === 'shell' && e.end && reference.sessions.find((s) => s.key === e.session)?.private === false);
  assert.ok(action, 'the view week has a command step');
  const a = await body('/api/record', { event: action.id });
  for (const r of a.records) {
    assert.ok(['step', 'result', 'copy'].includes(r.part));
    for (const k of ['line', 'git', 'verified', 'note', 'record']) assert.ok(k in r, `records[].${k}`);
  }
  assert.ok(a.records.some((r) => r.part === 'result'), "a call's result is one of its reads");
  assert.equal(typeof a.output.text, 'string');
  assert.equal(typeof a.output.cut, 'boolean');
  const common = page('assets/common.js');
  assert.match(common, /r\?\.part === 'result'/);
  assert.match(common, /a\.output\?\.text/);
});

test('self-test: the search words come from /api/selftest, which exists only with --self-test', async () => {
  const info = await body('/api/selftest');
  assert.ok(Array.isArray(info.words) && info.words.length > 0);
  assert.equal(info.words[0], info.word);
  const plain = createViewData({ config: w.config, roots: w.roots, ...WINDOW, buildHistory: async () => reference });
  await plain.start();
  assert.equal((await plain.route('/api/selftest', params())).status, 404);
  const ct = page('selftest/clickthrough.js');
  assert.match(ct, /api\('selftest'\)/);
  assert.match(ct, /info\.words/);
  assert.doesNotMatch(ct, /selfTest\?\.words|s\.demo === true/);
});

test('self-test references: a squash-merged commit and a file a prompt names, each found by its lookup', async () => {
  const info = await body('/api/selftest');
  assert.deepEqual(info.examples.map((x) => x.kind), ['commit', 'file'], 'the view week has both');
  for (const x of info.examples) {
    assert.ok(['commit', 'file'].includes(x.kind));
    const a = await body('/api/lookup', { q: x.text });
    assert.equal(a.kind, x.kind);
    if (x.kind === 'commit') assert.ok(a.notes.some((n) => n.kind === 'squash-subject'), 'the commit is a squash merge');
    else assert.ok(a.sessions.length > 0, 'the file has a session');
  }
  assert.match(page('selftest/clickthrough.js'), /info\.examples/);
});

test('replay: an id this window doesn\'t hold is an empty result naming the window, not an error', async () => {
  for (const q of [{ thread: 'th-pppppppppp' }, { session: 'cc-pppppppppp' }]) {
    const a = await body('/api/replay', q);
    assert.equal(a.thread, null);
    assert.match(a.empty, new RegExp(`between ${WEEK.from} and ${WEEK.to}`));
  }
  assert.equal((await data.route('/api/replay', params({ thread: 'not an id!' }))).status, 400, 'a malformed id is still refused');
  // The replay page shows the window's empty state for it, with a way back to search.
  assert.match(page('assets/replay.js'), /if \(!D \|\| !D\.thread\)/);
});

test('status: the command a page names and the private-word note, and the pages read both', async () => {
  const s = data.status();
  assert.equal(s.command, 'honestweek', 'the plain command when none is given');
  assert.ok(s.privateWords.count > 0, 'the seeded week lists private words');
  assert.equal(s.privateWords.note, null);
  const bare = createViewData({ config: { ...w.config, redaction: { codenames: [], names: [], terms: [] } }, roots: w.roots, ...WINDOW, command: 'npx github:your-org/honestweek' });
  const b = bare.status();
  assert.equal(b.command, 'npx github:your-org/honestweek');
  assert.equal(b.privateWords.count, 0);
  assert.ok(b.privateWords.note.includes('npx github:your-org/honestweek view again'), b.privateWords.note);
  // The demo always lists its made-up word, so it never shows the note.
  const demo = createViewData({ config: { ...w.config, redaction: { codenames: [], names: [], terms: [] } }, roots: w.roots, ...WINDOW, demo: true });
  assert.equal(demo.status().privateWords.note, null);
  const common = page('assets/common.js');
  for (const name of ['showPrivateWords(s.privateWords)', 'shell.status?.command']) assert.ok(common.includes(name), `common.js reads ${name}`);
  // No page names a bare `honestweek view` command any more; each reads the command.
  for (const f of ['assets/common.js', 'assets/goal.js', 'assets/search.js', 'assets/replay.js']) assert.doesNotMatch(page(f), /<code>honestweek view/, f);
});
