// honestweek view's data layer (lib/view/data.mjs) over the made-up demo week, seeded
// with made-up private terms, a name, secrets, and the ids the switch is meant to show.
// It checks the plan's named tests that don't need a browser: privacy in every answer,
// the switch, the replay cache, a failed build, search and goals, the replay fields,
// and the record panel.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRedactor, createSecretsOnlyRedactor } from '../lib/redact.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { createLeakCounter, EXEMPT_FIELDS, setAsideAllowed, stringsIn, unglue } from '../lib/view/leaks.mjs';
import { createLru, createViewData, goalKey, memberCount } from '../lib/view/data.mjs';
import { REPLAY_EVENT_FIELDS } from '../lib/view/replay-export.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { buildCorpus } from './fixtures/replay/corpus.mjs';
import { buildViewWeek, EMAIL, LONG_WORD, NOT_PROMPT_WORDS, OTHER_TERM, PRIVATE_WORDS, QUEUED_WORD, SECRETS, SEEDED, STRADDLE_WORD, SUMMARY_WORD, TERM, WEEK } from './fixtures/view/week.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'hw-view-data-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const w = buildViewWeek(join(scratch, 'week'));
const WINDOW = { from: WEEK.from, to: WEEK.to, timezone: 'UTC' };
let recordReads = 0;
const counting = async (options) => {
  const h = await buildWorkHistory(options);
  const read = h.record;
  h.record = (...args) => {
    recordReads += 1;
    return read(...args);
  };
  return h;
};
const data = createViewData({ config: w.config, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, buildHistory: counting });
await data.start();
await data.start('private');
for (let i = 0; i < 400 && data.status().search.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 25));
const reference = await buildWorkHistory({ config: w.config, roots: w.roots, ...WINDOW, scope: 'all', goals: w.goalRecord, hiddenSessions: 'redacted' });
const leaks = createLeakCounter(w.config);

const params = (q = {}) => new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined));
const ask = async (path, q = {}, priv = false) => {
  const r = await data.route(path, params({ ...q, ...(priv ? { private: '1' } : {}) }));
  return r;
};
const body = async (path, q, priv) => {
  const r = await ask(path, q, priv);
  assert.equal(r.status, 200, `${path} ${JSON.stringify(q)} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
};

// The display-only session's prompt: with an engine that shows display-only and outside
// sessions as redacted text (hiddenSessions: 'redacted'), it carries text; an engine
// without that option ignores it and shows a skeleton.
const engineSupportsHiddenSessions = (await body('/api/replay', { session: w.keys.display })).events.some((e) => e.kind === 'prompt' && typeof e.facts?.text === 'string');
const HIDDEN_SKIP = engineSupportsHiddenSessions ? false : "the engine here doesn't take hiddenSessions: 'redacted' yet";

/** Every answer the command can give, one mode at a time. */
async function everyAnswer(priv) {
  const out = [];
  const add = async (path, q = {}) => {
    const r = await ask(path, q, priv);
    out.push({ path, q, status: r.status, body: r.body });
    return r.body;
  };
  await add('/api/status');
  const home = await add('/api/home');
  for (const q of ['#12', '#13', '#15', 'feature/group-by-scope', 'lib/format.mjs', TERM, 'zz-nothing-here', ...home.try.map((t) => t.text)]) await add('/api/lookup', { q });
  for (const q of [TERM, 'release', 'machine-readable', 'suite', 'Password', 'dates']) await add('/api/words', { q });
  const prompt = reference.events.find((e) => e.session === w.keys.featured && e.kind === 'prompt');
  await add('/api/words', { similar: prompt.id });
  for (const k of w.goalRecord.goals.map((g) => goalKey(g.id))) await add('/api/goal', { key: k });
  for (const q of [TERM, STRADDLE_WORD, 'suite', 'Password', 'release', SECRETS.nextLine]) await add('/api/search', { q });
  await add('/api/replay');
  const events = new Set();
  for (const t of reference.threads) for (const e of (await add('/api/replay', { thread: t.id })).events) events.add(e.id);
  for (const key of Object.values(w.keys)) await add('/api/replay', { session: key });
  for (const id of events) await add('/api/record', { event: id });
  return out;
}

const redactedAnswers = await everyAnswer(false);
const privateAnswers = await everyAnswer(true);

const literalHits = (answer, values) => {
  const hits = [];
  for (const s of stringsIn(answer)) for (const v of values) if (s.toLowerCase().includes(String(v).toLowerCase())) hits.push(v);
  return hits;
};

// ---- privacy everywhere -----------------------------------------------------------------

test('every redacted answer has zero leaks and holds no planted value', () => {
  assert.ok(redactedAnswers.length > 100, `checked ${redactedAnswers.length} answers`);
  for (const a of redactedAnswers) {
    assert.equal(a.body.view?.shown ?? 'redacted', 'redacted');
    const n = leaks.redacted(a.body);
    assert.equal(n.total, 0, `${a.path} ${JSON.stringify(a.q)} leaks ${JSON.stringify(n)}`);
    assert.deepEqual(literalHits(a.body, [...PRIVATE_WORDS, ...Object.values(SECRETS), 'Dana']), [], `${a.path} ${JSON.stringify(a.q)}`);
  }
});

test('every private answer hides every secret, and shows the private words', () => {
  for (const a of privateAnswers) {
    if (a.path !== '/api/status') assert.equal(a.body.view.shown, 'private', `${a.path} was served private`);
    const n = leaks.secrets(a.body);
    assert.equal(n.total, 0, `${a.path} ${JSON.stringify(a.q)} still holds a secret`);
    assert.deepEqual(literalHits(a.body, Object.values(SECRETS)), [], `${a.path} ${JSON.stringify(a.q)}`);
  }
  const all = JSON.stringify(privateAnswers.map((a) => a.body));
  assert.ok(all.includes(TERM) && all.includes(EMAIL), 'the switch shows the private words');
});

// A step description quotes its prompt, so a token pasted at the very end of a prompt comes
// out as `DOCS_TOKEN=[redacted:secret]"`: the closing quote right after the placeholder. The
// leak counter read that as a field value that wasn't only a placeholder and counted a leak.
test('a token hidden at the very end of a prompt counts as hidden, and one shown there is still a leak', async () => {
  const release = claudeSessionKey(w.d.ids.projectDirs.releaseWorktree, w.d.ids.claude.releaseScript);
  const glued = /=\[redacted:secret\]"$/;
  for (const priv of [false, true]) {
    const count = (answer) => (priv ? leaks.secrets(answer) : leaks.redacted(answer));
    for (const [path, q] of [['/api/goal', { key: goalKey('publish-notes') }], ['/api/replay', { session: release }]]) {
      const answer = await body(path, q, priv);
      assert.ok(stringsIn(answer).some((s) => glued.test(s)), `${path} ${priv ? 'private' : 'redacted'}: a placeholder right before a closing quote`);
      assert.equal(count(answer).total, 0, `${path} ${priv ? 'private' : 'redacted'}: no leak counted`);
    }
  }
  // The same place on a made-up string, hidden and shown.
  const hidden = 'prompt "To try it, use the sandbox one, DOCS_TOKEN=[redacted:secret]"';
  const shown = 'prompt "To try it, use the sandbox one, DOCS_TOKEN=sandbox-7Qx2Lk9pR3vT6nW8zB4f"';
  assert.deepEqual([leaks.redacted(hidden).total, leaks.secrets(hidden).total], [0, 0]);
  assert.deepEqual([leaks.redacted(shown).secrets, leaks.secrets(shown).total], [1, 1]);
  // Only closing punctuation that ends the text is set apart: a value glued on after it is
  // still read, and still a leak.
  const gluedOn = 'prompt "DOCS_TOKEN=[redacted:secret]"7Qx2Lk9pR3vT6nW8zB4f';
  assert.deepEqual([leaks.redacted(gluedOn).secrets, leaks.secrets(gluedOn).total], [1, 1]);
  for (const s of ['TOKEN=[redacted:secret])', "password: '[redacted:secret]'.", 'API_KEY=[redacted:secret]",']) assert.equal(leaks.secrets(s).total, 0, s);
  // An excerpt cut right after a sensitive flag ends in the page's own mark, which isn't a
  // value; a real value in the same place still is.
  for (const s of ['Yes: add a --token-file …', 'Yes: add a --token-file ...', 'Yes: add a --token-file … ']) assert.deepEqual([leaks.redacted(s).total, leaks.secrets(s).total], [0, 0], s);
  assert.deepEqual([leaks.redacted('Yes: add a --token-file 7Qx2Lk9pR3vT6nW8zB4f').secrets, leaks.secrets('Yes: add a --token-file 7Qx2Lk9pR3vT6nW8zB4f').total], [1, 1]);
});

// Neither relaxation may hide a real value that sits near a placeholder or a cut mark. Each of
// these counted as a leak before the two were added, and still does.
test('a value shown next to a placeholder or a cut mark still counts as a leak', () => {
  const near = [
    'password: [redacted:secret]. hunter2xyz',
    'TOKEN=[redacted:secret]" Xk9mQ2pL7vR4Zq7mK2pX9wAbCdEfGh12',
    'API_KEY=[redacted:secret]. SECRET=7Qx2Lk9pR3vT6nW8zB4f',
    'password: "[redacted:secret]" and token: "7Qx2Lk9pR3vT6nW8zB4f"',
    'Authorization: Bearer [redacted:secret]) Xk9mQ2pL7vR4Zq7m',
    // A cut mark that doesn't end the text isn't the end of an excerpt.
    'token: … Xk9mQ2pL7vR4Zq7mK2pX9w',
    'token: ...;Xk9mQ2pL7vR4Zq7mK2pX9wAbCdEfGh12',
    'password=…Xk9mQ2pL7vR4',
    '--token … --password hunter2xyz',
    'add a --token-file … then --token 7Qx2Lk9pR3vT6nW8zB4f',
  ];
  for (const s of near) assert.deepEqual([leaks.redacted(s).secrets, leaks.secrets(s).total], [1, 1], s);
});

test('private text is served only when a request asks with private=1', async () => {
  for (const value of [undefined, '0', 'true', 'yes', '2', '', ' 1', '1 ']) {
    const r = await data.route('/api/replay', params({ session: w.keys.featured, private: value }));
    assert.equal(r.body.view.shown, 'redacted', `private=${JSON.stringify(value)}`);
    assert.ok(!JSON.stringify(r.body).includes(TERM));
  }
  const r = await data.route('/api/replay', params({ session: w.keys.featured, private: '1' }));
  assert.equal(r.body.view.shown, 'private');
  assert.ok(JSON.stringify(r.body).includes(TERM));
});

test('a display-only or outside session shows redacted text with the switch off', { skip: HIDDEN_SKIP }, async () => {
  for (const key of [w.keys.display, w.keys.outside]) {
    const replay = await body('/api/replay', { session: key });
    const prompt = replay.events.find((e) => e.session === key && e.kind === 'prompt');
    assert.match(prompt.facts.text, /\[redacted:term\] report/);
    const record = await body('/api/record', { event: prompt.id });
    assert.ok(record.records.some((x) => x.record && JSON.stringify(x.record).includes('[redacted:term]')));
    assert.equal(leaks.redacted([replay, record]).total, 0);
  }
  const replay = await body('/api/replay', { session: w.keys.display });
  const run = replay.events.find((e) => e.session === w.keys.display && e.kind === 'action');
  const record = await body('/api/record', { event: run.id });
  assert.match(record.output.text, /not ok 3/);
});

test('a display-only or outside session carries its text with the switch on', async () => {
  for (const key of [w.keys.display, w.keys.outside]) {
    const replay = await body('/api/replay', { session: key }, true);
    const prompt = replay.events.find((e) => e.session === key && e.kind === 'prompt');
    assert.ok(prompt.facts.text.includes(TERM), 'the prompt text shows');
    const record = await body('/api/record', { event: prompt.id }, true);
    assert.ok(JSON.stringify(record.records).includes(TERM), 'its record shows');
  }
  const replay = await body('/api/replay', { session: w.keys.display }, true);
  const run = replay.events.find((e) => e.session === w.keys.display && e.kind === 'action');
  const record = await body('/api/record', { event: run.id }, true);
  assert.ok(record.output.text.includes(TERM), 'its command output shows');
  assert.ok(!record.output.text.includes(SECRETS.github));
});

test('a private term placed where an excerpt is cut leaves no part of itself', async () => {
  const found = await body('/api/search', { q: STRADDLE_WORD });
  const snippets = found.results.flatMap((r) => r.snippets.map((s) => s.text));
  assert.ok(snippets.length >= 1, 'the long prompt is found');
  const low = TERM.toLowerCase();
  for (const text of snippets) {
    for (let n = 4; n <= low.length; n++) for (let i = 0; i + n <= low.length; i++) assert.ok(!text.toLowerCase().includes(low.slice(i, i + n)), `"${low.slice(i, i + n)}" in ${text}`);
  }
});

test('search everywhere redacts a long prompt whole before cutting it, and leaves out compaction summaries', async () => {
  for (const priv of [false, true]) {
    const found = await body('/api/search', { q: LONG_WORD }, priv);
    const snippets = found.results.flatMap((r) => r.snippets.map((s) => s.text));
    assert.ok(snippets.some((t) => t.includes(LONG_WORD)), 'the long prompt is found by a word near its end');
    for (const text of snippets) for (let i = 0; i + 8 <= SECRETS.github.length; i++) assert.ok(!text.includes(SECRETS.github.slice(i, i + 8)), `part of the token in ${text}`);
    assert.equal((await body('/api/search', { q: SUMMARY_WORD }, priv)).results.length, 0, 'a compaction summary is not a prompt');
    const busy = await body('/api/search', { q: QUEUED_WORD }, priv);
    assert.equal(busy.results.length, 1, 'a prompt typed while the agent was busy is searched');
    assert.equal(busy.results[0].session, w.keys.outside);
    for (const [why, word] of Object.entries(NOT_PROMPT_WORDS)) assert.equal((await body('/api/search', { q: word }, priv)).results.length, 0, `a busy-time record that isn't a prompt in the week (${why}) is not searched`);
  }
});

test('goal and replay answers carry no original log lines; none is read until a record is asked for', async () => {
  const before = recordReads;
  for (const a of [await body('/api/home'), await body('/api/goal', { key: goalKey('release-1-4') }), await body('/api/replay', { session: w.keys.featured }), await body('/api/lookup', { q: '#12' }), await body('/api/words', { q: 'release' }), await body('/api/search', { q: 'release' })]) {
    const text = JSON.stringify(a);
    for (const raw of ['"parentUuid"', '"sessionId"', '"toolUseResult"', '"tool_use_id"', '"isSidechain"', '"records"']) assert.ok(!text.includes(raw), `an answer holds ${raw}`);
  }
  assert.equal(recordReads, before, 'no record was read');
  const replay = await body('/api/replay', { session: w.keys.featured });
  await body('/api/record', { event: replay.events.find((e) => e.kind === 'prompt').id });
  assert.equal(recordReads, before + 1);
});

test('a password on the line after its label is hidden in a record and in search', async () => {
  const replay = await body('/api/replay', { session: w.keys.featured });
  for (const e of replay.events.filter((x) => x.kind === 'prompt' || x.kind === 'action')) {
    for (const priv of [false, true]) {
      const r = await body('/api/record', { event: e.id }, priv);
      assert.ok(!JSON.stringify(r).includes(SECRETS.nextLine), `${e.kind} record (private ${priv})`);
    }
  }
  for (const priv of [false, true]) assert.ok(!JSON.stringify(await body('/api/search', { q: 'Password' }, priv)).includes(SECRETS.nextLine));
});

test("a step's description is scrubbed as the whole it becomes: a hidden header value at the end of a command doesn't run on into \" -> ok\"", async () => {
  // The engine describes a step from fields it already redacted, then adds its own words
  // after them. Read whole, `Authorization: [redacted:secret] -> ok` is a header whose value
  // runs to the end of the line, so the description is scrubbed again as that text.
  const contoso = goalKey('client-contoso');
  for (const priv of [false, true]) {
    const count = (s) => (priv ? leaks.secrets(s) : leaks.redacted(s)).total;
    const replay = await body('/api/replay', { session: w.keys.featured }, priv);
    const step = replay.events.find((e) => e.kind === 'action' && /Authorization/.test(e.facts?.command ?? ''));
    assert.ok(step, 'the header command is a step');
    const seen = [step.text, (await body('/api/record', { event: step.id }, priv)).event.text, (await body('/api/goal', { key: contoso }, priv)).events.find((e) => e.id === step.id).text];
    for (const text of seen) {
      assert.match(text, /^Bash \(shell\) curl -s https:\/\/api\.example\.com\/v1\/items -H Authorization: \[redacted:secret\]/);
      assert.ok(!text.includes(SECRETS.bearer));
      assert.equal(count(text), 0, `with the switch ${priv ? 'on' : 'off'}, the leak counter reads ${JSON.stringify(text)} as a secret`);
    }
  }
});

// ---- the leak counter -------------------------------------------------------------------

test('the leak counter: the only expected switch-off differences are plain-word credentials and markup-only values', () => {
  const full = createRedactor(w.config).redact;
  const scrub = createSecretsOnlyRedactor().redact;
  const samples = [SEEDED, 'Bearer authentication works', 'basic validation runs first', '**Auth:** users get logged out', 'password: ****', 'token: __', 'Plain prose with nothing in it.', `Bearer ${SECRETS.bearer}`, `token=${SECRETS.github}`, 'Password:\nhunter2go', 'session 0a1b2c3d-1111-2222-3333-444455556666'];
  const differs = samples.filter((s) => {
    const x = full(s);
    return scrub(x) !== x;
  });
  assert.deepEqual(differs, ['Bearer authentication works', 'basic validation runs first', '**Auth:** users get logged out', 'password: ****', 'token: __']);
  for (const s of samples) {
    const x = full(s);
    const set = setAsideAllowed(x);
    assert.equal(scrub(set), set, `nothing but an allowance differs in ${JSON.stringify(x)}`);
    assert.equal(set !== x, differs.includes(s), `only the allowance cases are set aside: ${JSON.stringify(x)}`);
  }
  // A password on the line after its label is not an allowance: its one-line copy counts.
  assert.equal(leaks.redacted('Password:\nhunter2go').secrets, 1);
  assert.equal(leaks.secrets('Password:\nhunter2go').secrets, 1);
});

test('the self-test\'s leak check reads each shown string and value on its own, and still finds a secret, a private word or a sensitive key in any one', () => {
  const full = createRedactor(w.config).redact;
  const check = (parts, priv = false) => data.leakCheck(JSON.stringify(parts), params({ parts: '1', ...(priv ? { private: '1' } : {}) }));
  // Two pieces a page shows apart: a step whose command ends in a hidden header, then a chip.
  const step = full(`Bash (shell) curl -s https://api.example.com -H Authorization: Bearer ${SECRETS.bearer}`);
  assert.equal(step, 'Bash (shell) curl -s https://api.example.com -H Authorization: [redacted:secret]');
  // Joined into one text, the chip reads as the rest of the header's value.
  assert.equal(leaks.redacted(`${step}\nrecorded`).secrets, 1);
  // A step's fields, as JSON text: a value glued to the next field, and an escaped quote.
  const facts = { command: full(`deploy AUTH=${SECRETS.password}`), description: 'Ship it', note: full(`say "Authorization: Bearer ${SECRETS.bearer}"`) };
  assert.equal(leaks.redacted(JSON.stringify(facts)).secrets, 1, 'the JSON text reads as a leak');
  for (const priv of [false, true]) {
    assert.equal(check([step, 'recorded', { text: step, facts }], priv).total, 0, `each piece is clean on its own (switch ${priv ? 'on' : 'off'})`);
    // Any one piece that shows a secret still counts, and so does a value under a sensitive key.
    assert.equal(check([step, 'recorded', `token=${SECRETS.github}`], priv).secrets, 1);
    assert.equal(check([{ text: step, facts: { ...facts, token: SECRETS.password } }], priv).secrets, 1);
    assert.equal(check([{ facts: { auth: { value: SECRETS.password } } }], priv).secrets, 1, "inside a sensitive key's object");
    assert.equal(check([{ facts: { password: 12345678 } }], priv).secrets, 1, 'a long number under a password key');
  }
  // What the redacted view's own key rule leaves: a placeholder, a flag word, an empty value.
  assert.equal(check([{ facts: { token: '[redacted:secret]', auth: 'true', password: '' } }]).total, 0);
  assert.equal(check([`Ship the ${TERM} report`]).terms, 1);
  assert.equal(check([EMAIL]).emails, 1);
  // The top-level query exemption is an answer's, never a list item's.
  assert.equal(check([{ query: TERM }]).terms, 1);
  assert.ok(check({ not: 'a list' }).error);
  assert.ok(data.leakCheck('[not json', params({ parts: '1' })).error);
});

test('the leak counter exempts only an answer\'s top-level query field', async () => {
  const keys = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) keys.add(k), walk(x);
  };
  for (const a of redactedAnswers) walk(a.body);
  assert.ok(keys.size > 50);
  for (const k of keys) {
    const n = leaks.redacted({ [k]: TERM }).terms;
    assert.equal(n, EXEMPT_FIELDS.includes(k) ? 0 : 1, `field ${k}`);
    assert.equal(leaks.redacted({ nested: { [k]: TERM } }).terms, 1, `nested field ${k} is never exempt`);
  }
  assert.deepEqual(EXEMPT_FIELDS, ['query']);
});

// ---- typed queries are kept under ids, never in the address --------------------------

test('a typed query is answered with an id, and the id answers with the query', async () => {
  for (const path of ['/api/lookup', '/api/words', '/api/search']) {
    const first = await body(path, { q: TERM });
    assert.match(first.queryId, /^q[a-p]{16}$/);
    assert.ok(!('query' in first), 'a q= answer does not echo the words');
    const again = await body(path, { id: first.queryId });
    assert.equal(again.query, TERM);
    assert.equal(again.queryId, first.queryId);
    assert.equal(leaks.redacted(again).total, 0, 'the echoed query is exempt, nothing else is');
    const unknown = await body(path, { id: 'qaaaaaaaaaaaaaaaa' });
    assert.equal(unknown.query, null);
    for (const k of ['sessions', 'results', 'prompts', 'goals']) if (Array.isArray(unknown[k])) assert.equal(unknown[k].length, 0);
    assert.equal((await ask(path, { id: 'not-an-id' })).status, 400);
  }
  assert.equal((await body('/api/lookup', { q: '#12' })).queryId, (await body('/api/lookup', { q: '#12' })).queryId, 'the same words get the same id within a run');
});

test('words typed only with the switch on are never echoed to a request with it off', async () => {
  for (const path of ['/api/lookup', '/api/words', '/api/search']) {
    const typed = `${OTHER_TERM} plans ${path.slice(5)}`;
    const on = await body(path, { q: typed }, true);
    const off = await body(path, { id: on.queryId });
    assert.equal(off.query, null, path);
    assert.match(off.empty, /typed with Show private text on/, path);
    assert.ok(!JSON.stringify(off).includes(OTHER_TERM), `${path} holds the typed word`);
    assert.equal((await body(path, { id: on.queryId }, true)).query, typed, 'with the switch on it comes back');
    await body(path, { q: typed });
    assert.equal((await body(path, { id: on.queryId })).query, typed, 'once typed with the switch off too, it echoes with it off');
  }
});

// ---- the switch and the cache ----------------------------------------------------------

const shape = {
  home: (b) => ({ coverage: Object.fromEntries(Object.entries(b.coverage).filter(([, v]) => typeof v === 'object').map(([k, v]) => [k, v.value])), goals: b.goals.map((g) => [g.key, g.members.value, g.unmatched.value]), recent: b.recent.map((s) => s.session) }),
  lookup: (b) => ({ sessions: b.sessions.map((s) => [s.session, s.evidence, !!s.ambiguous, s.goals.map((g) => [g.key, g.evidence, g.ambiguous, g.assigned])]), goals: b.goals.map((g) => g.key) }),
  goal: (b) => ({ members: b.members.map((m) => [m.session, m.evidence, m.ambiguous, m.assigned, m.joins.map((j) => j.type)]), unmatched: b.unmatched.map((u) => u.kind), events: b.events.map((e) => e.id) }),
  replay: (b) => ({ thread: b.thread?.id, events: b.events.map((e) => [e.id, e.kind, e.ev, e.session]), sessions: b.sessions.map((s) => s.key), links: b.thread.links.length }),
  words: (b) => ({ goals: b.goals.map((g) => g.key), sessions: b.sessions.map((s) => s.session), prompts: b.prompts.map((p) => p.event), similar: b.similar.map((p) => p.event) }),
};

test('the switch changes no session, link or goal', async () => {
  for (const priv of [false, true]) assert.ok((await body('/api/home', {}, priv)).goals.length >= 5);
  assert.deepEqual(shape.home(await body('/api/home', {}, true)), shape.home(await body('/api/home')));
  for (const q of ['#12', '#13', '#15', 'feature/group-by-scope']) assert.deepEqual(shape.lookup(await body('/api/lookup', { q }, true)), shape.lookup(await body('/api/lookup', { q })), q);
  for (const g of w.goalRecord.goals) assert.deepEqual(shape.goal(await body('/api/goal', { key: goalKey(g.id) }, true)), shape.goal(await body('/api/goal', { key: goalKey(g.id) })), g.id);
  for (const t of reference.threads) assert.deepEqual(shape.replay(await body('/api/replay', { thread: t.id }, true)), shape.replay(await body('/api/replay', { thread: t.id })), t.id);
  // A private word finds its match only where the text shows it, so these words are plain ones.
  for (const q of ['report', 'release']) assert.deepEqual(shape.words(await body('/api/words', { q }, true)), shape.words(await body('/api/words', { q })), q);
});

test('word lookups list only configured sessions, with the switch off or on', async () => {
  let rows = 0;
  for (const priv of [false, true]) {
    for (const q of ['report', 'release', TERM]) {
      const a = await body('/api/words', { q }, priv);
      for (const r of [...a.prompts, ...a.sessions]) assert.equal(r.group, 'configured', `${q} (switch ${priv ? 'on' : 'off'}) lists a ${r.group} session`);
      rows += a.prompts.length + a.sessions.length;
      for (const p of a.prompts) for (const s of (await body('/api/words', { similar: p.event }, priv)).similar) assert.equal(s.group, 'configured', `similar to ${p.event}`);
    }
  }
  assert.ok(rows > 0, 'the words find something');
  const display = reference.events.find((e) => e.session === w.keys.display && e.kind === 'prompt');
  assert.equal((await ask('/api/words', { similar: display.id }, true)).status, 404, "a display-only session's prompt isn't a base for similar prompts");
});

test("a goal member's counts are its own session's, never its whole thread's", async () => {
  let checked = 0;
  let shared = 0;
  for (const g of w.goalRecord.goals) {
    const a = await body('/api/goal', { key: goalKey(g.id) });
    for (const s of a.sessions) {
      const fr = a.frames[s.key];
      if (!fr?.length) continue;
      const own = reference.events.filter((e) => e.session === s.key && e.kind === 'prompt').length;
      assert.equal(fr[fr.length - 1].prompts, own, `${g.id}: ${s.key}`);
      checked += 1;
      if ((reference.threads.find((t) => t.id === s.thread)?.sessions.length ?? 1) > 1) shared += 1;
    }
  }
  assert.ok(checked > 0);
  assert.ok(shared > 0, 'some member shares its thread with another session, the case this guards');
});

test("a count is no stronger than the weakest thing it counts", async () => {
  const home = await body('/api/home');
  let weak = 0;
  for (const [i, { id }] of w.goalRecord.goals.entries()) {
    const g = reference.goals[i];
    const shown = home.goals.find((x) => x.key === goalKey(id));
    const expectWeak = g.members.some((m) => m.evidence === 'inferred' || m.ambiguous === true);
    assert.equal(shown.members.evidence, expectWeak ? 'inferred' : 'derived', id);
    assert.equal(shown.recorded + shown.inferred + shown.ambiguous, shown.members.value, id);
    if (expectWeak) weak += 1;
  }
  // The fixture's members each have a recorded or derived join, so the weaker case is
  // checked on made-up members.
  assert.equal(weak, 0);
  const rule = { session: 'a', evidence: 'inferred', joins: [{ type: 'command-on-pr' }] };
  const amb = { session: 'b', evidence: 'recorded', ambiguous: true, joins: [{ type: 'cited-pr' }] };
  const mine = { session: 'c', evidence: 'recorded', joins: [{ type: 'cited-session' }] };
  assert.deepEqual(memberCount([mine]), { value: 1, evidence: 'derived', recorded: 1, inferred: 0, ambiguous: 0, assigned: 1 });
  assert.deepEqual(memberCount([mine, rule]), { value: 2, evidence: 'inferred', recorded: 1, inferred: 1, ambiguous: 0, assigned: 1 });
  assert.deepEqual(memberCount([mine, amb]), { value: 2, evidence: 'inferred', recorded: 1, inferred: 0, ambiguous: 1, assigned: 1 });
  const levels = new Map(home.recent.map((r) => [r.session, r.prompts.evidence]));
  // Home lists the twelve most recent sessions. The demo week's Saturday session, from an older
  // Claude Code that records no prompt origin, is one of them.
  const older = claudeSessionKey(w.d.ids.projectDirs.lantern, w.d.ids.claude.widthCheck);
  assert.equal(levels.get(older), 'inferred', 'a prompt whose author is only inferred makes the count inferred');
  assert.ok([...levels.values()].includes('derived'), 'a session whose prompts all say who typed them stays derived');
});

test('a thread, record and goal opened with the switch on, then off, come back with zero private words', async () => {
  const thread = reference.sessions.find((s) => s.key === w.keys.featured).thread;
  const on = await body('/api/replay', { thread }, true);
  assert.ok(JSON.stringify(on).includes(TERM));
  const off = await body('/api/replay', { thread });
  assert.equal(leaks.redacted(off).total, 0);
  const prompt = on.events.find((e) => e.kind === 'prompt');
  assert.ok(JSON.stringify(await body('/api/record', { event: prompt.id }, true)).includes(TERM));
  assert.equal(leaks.redacted(await body('/api/record', { event: prompt.id })).total, 0);
  const key = goalKey('client-contoso');
  assert.ok(JSON.stringify(await body('/api/goal', { key }, true)).includes(OTHER_TERM));
  assert.equal(leaks.redacted(await body('/api/goal', { key })).total, 0);
});

test('the replay cache drops its least recently opened thread when full', () => {
  const lru = createLru(3);
  for (const k of ['a', 'b', 'c']) lru.set(k, k);
  lru.get('a');
  lru.set('d', 'd');
  assert.deepEqual(lru.keys(), ['c', 'a', 'd']);
  assert.equal(lru.has('b'), false);
  lru.set('c', 'c2');
  lru.set('e', 'e');
  assert.deepEqual(lru.keys(), ['d', 'c', 'e']);
  assert.equal(lru.size, 3);
});

test('a failed private build still serves the redacted answer, with a note, never an error or a hang', async () => {
  const failing = createViewData({
    config: w.config,
    roots: w.roots,
    ...WINDOW,
    goalRecord: w.goalRecord,
    buildHistory: (o) => (o.privateText ? Promise.reject(new Error(`could not read ${'/home/dana/secret'} for ${TERM}`)) : buildWorkHistory(o)),
  });
  await failing.start();
  const started = Date.now();
  const first = await failing.route('/api/replay', params({ session: w.keys.featured, private: '1' }));
  assert.equal(first.status, 200);
  assert.equal(first.body.view.shown, 'redacted');
  await failing.start('private');
  const r = await failing.route('/api/replay', params({ session: w.keys.featured, private: '1' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.view.shown, 'redacted');
  assert.match(r.body.view.note, /couldn't be built/);
  assert.ok(Date.now() - started < 10000);
  const status = failing.status();
  assert.equal(status.builds.private.state, 'failed');
  assert.ok(!status.builds.private.failed.includes(TERM) && !status.builds.private.failed.includes('/home/dana'), 'the reason is redacted');
  assert.equal(leaks.redacted(r.body).total, 0);
});

test('a failed redacted build reports failed, with a redacted reason, and data waits', async () => {
  const failing = createViewData({ config: w.config, roots: w.roots, ...WINDOW, buildHistory: () => Promise.reject(new Error(`broke on ${EMAIL}`)) });
  await failing.start();
  const s = failing.status();
  assert.equal(s.state, 'failed');
  assert.ok(s.failed && !s.failed.includes(EMAIL));
  const r = await failing.route('/api/home', params());
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'failed');
});

// ---- search and goals ------------------------------------------------------------------

test('a word from a demo goal\'s title returns that goal', async () => {
  const r = await body('/api/words', { q: 'machine-readable' });
  assert.deepEqual(r.goals.map((g) => g.title), ['Offer machine-readable output']);
  assert.equal(r.goals[0].evidence, 'recorded');
  assert.equal(r.goals[0].key, goalKey('json-output'));
});

test('every goal member\'s shown level and ambiguity equal the engine\'s', async () => {
  for (const [i, g] of w.goalRecord.goals.entries()) {
    const shown = await body('/api/goal', { key: goalKey(g.id) });
    const engine = reference.goals[i];
    assert.deepEqual(shown.members.map((m) => [m.session, m.evidence, m.ambiguous]), engine.members.map((m) => [m.session, m.evidence, m.ambiguous === true]), g.id);
  }
});

test('a goal you assigned shows as yours, and an unbacked citation shows as missing with its reason', async () => {
  const contoso = await body('/api/goal', { key: goalKey('client-contoso') });
  assert.deepEqual(contoso.members.map((m) => [m.session, m.assigned]), [[w.keys.featured, true]]);
  const release = await body('/api/goal', { key: goalKey('release-1-4') });
  for (const m of release.members) assert.equal(m.assigned, m.joins.some((j) => j.type === 'cited-session'));
  assert.ok(release.members.some((m) => !m.assigned), 'a member joined only by its work is not marked yours');
  const northwind = await body('/api/goal', { key: goalKey('client-northwind') });
  assert.equal(northwind.members.length, 0);
  const session = northwind.unmatched.find((u) => u.kind === 'session');
  assert.ok(session, 'a session cited by id that is not readable in this window');
  assert.match(session.why, /no readable session with that id/);
  const entry = northwind.unmatched.find((u) => u.kind === 'entry');
  assert.ok(entry, 'a goal entry whose time no call covers');
  assert.match(entry.why, /none has a recorded result spanning the time/);
  for (const u of northwind.unmatched) assert.deepEqual([u.evidence, u.assigned], ['missing', true]);
});

test('goals whose ids hold a private term open in both modes, and two that redact alike stay apart', async () => {
  const keys = ['client-northwind', 'client-contoso'].map(goalKey);
  assert.notEqual(keys[0], keys[1]);
  for (const k of keys) assert.match(k, /^g[a-p]+$/);
  const home = await body('/api/home');
  const listed = home.goals.filter((g) => keys.includes(g.key));
  assert.deepEqual(listed.map((g) => g.title), ['[redacted:term] launch', '[redacted:term] launch']);
  for (const priv of [false, true]) {
    const [a, b] = [await body('/api/goal', { key: keys[0] }, priv), await body('/api/goal', { key: keys[1] }, priv)];
    assert.equal(a.key, keys[0]);
    assert.equal(b.key, keys[1]);
    assert.notDeepEqual(a.members.map((m) => m.session), b.members.map((m) => m.session));
    if (priv) assert.deepEqual([a.title, b.title], [`${TERM} launch`, `${OTHER_TERM} launch`]);
  }
});

test('every row and count in the word, search-everywhere and home answers carries an evidence word', async () => {
  const WORDS = new Set(['recorded', 'derived', 'inferred', 'missing', 'ambiguous']);
  const check = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => check(x, `${where}[${i}]`));
    if (!v || typeof v !== 'object') return;
    if ('value' in v && typeof v.value === 'number') assert.ok(WORDS.has(v.evidence), `${where} count has evidence`);
    for (const [k, x] of Object.entries(v)) {
      if (k === 'view' || k === 'evidenceKey' || k === 'rules' || k === 'window') continue;
      if (Array.isArray(x)) for (const [i, row] of x.entries()) if (row && typeof row === 'object' && !Array.isArray(row) && !['joins', 'goals', 'refs'].includes(k)) assert.ok(WORDS.has(row.evidence), `${where}.${k}[${i}] has evidence`);
      check(x, `${where}.${k}`);
    }
  };
  check(await body('/api/home'), 'home');
  for (const q of ['release', 'suite', 'dates', 'feature']) check(await body('/api/words', { q }), `words ${q}`);
  check(await body('/api/words', { similar: reference.events.find((e) => e.session === w.keys.featured && e.kind === 'prompt').id }), 'similar');
  for (const q of ['release', TERM, 'suite']) check(await body('/api/search', { q }), `search ${q}`);
  const words = await body('/api/words', { q: 'release notes changelog' });
  assert.ok(words.prompts.some((p) => p.matched === 'some of your words'), 'a partial match is listed');
  assert.ok(words.prompts.every((p) => p.evidence === 'recorded' && p.score.evidence === 'inferred' && p.score.rule === 'view.shared-words'), 'the words are recorded in the prompt; its shared-word score is inferred by a named rule');
  assert.ok(words.rules['view.shared-words']);
});

test('search everywhere labels each hit configured, display or outside', async () => {
  const r = await body('/api/search', { q: 'report' });
  const groups = new Map(r.results.map((x) => [x.session, x.group]));
  assert.equal(groups.get(w.keys.featured), 'configured');
  assert.equal(groups.get(w.keys.display), 'display');
  assert.equal(groups.get(w.keys.outside), 'outside');
  for (const x of r.results) assert.ok(x.thread, 'each hit can open its replay');
});

// ---- replay ---------------------------------------------------------------------------

test('a step whose time was borrowed, or moved after the call that started it, says so', async () => {
  const r = await body('/api/replay', { session: w.keys.featured });
  const borrowed = r.events.find((e) => e.timeFrom === 'previous-record');
  assert.equal(borrowed?.timeNote?.kind, 'borrowed-previous');
  const moved = r.events.find((e) => e.clock?.rule === 'agent-after-spawn');
  assert.equal(moved?.timeNote?.kind, 'moved-after-spawn');
  assert.match(moved.timeNote.text, /30 s before the call that started it/);
  for (const e of r.events.filter((x) => x.timeFrom === 'record' && !x.clock && !x.endT)) assert.equal(e.timeNote, null);
});

test('with no thread chosen, the replay opens the most recent thread, or says there is none', async () => {
  const r = await body('/api/replay');
  const latest = [...reference.sessions].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))[0];
  assert.equal(r.thread.id, latest.thread);
  const empty = createViewData({ config: w.config, roots: w.roots, from: '2020-01-01', to: '2020-01-02', timezone: 'UTC' });
  await empty.start();
  const none = await empty.route('/api/replay', params());
  assert.equal(none.status, 200);
  assert.equal(none.body.thread, null);
  assert.match(none.body.empty, /2020-01-01 and 2020-01-02/);
});

test('every replay event carries each field the pages read', async () => {
  for (const t of reference.threads) {
    for (const priv of [false, true]) {
      const r = await body('/api/replay', { thread: t.id }, priv);
      for (const e of r.events) for (const f of REPLAY_EVENT_FIELDS) assert.ok(f in e, `${e.kind} event lacks ${f}`);
      for (const k of ['thread', 'session', 'sessions', 'agents', 'events', 'frames', 'rules', 'timezone', 'coverage', 'window']) assert.ok(k in r, `replay lacks ${k}`);
      for (const k of ['id', 'title', 'firstAt', 'lastAt', 'metrics', 'outcomes', 'missing', 'links']) assert.ok(k in r.thread, `thread lacks ${k}`);
      assert.ok(r.frames.length >= 1 && r.frames.every((f) => f.evidence && f.evidence.prompts), 'each frame carries its counts\' levels');
      assert.ok(!('records' in r));
    }
  }
});

test('an empty result names the window', async () => {
  const r = await body('/api/lookup', { q: '#999' });
  assert.deepEqual(r.sessions, []);
  assert.match(r.empty, new RegExp(`${WEEK.from} and ${WEEK.to}`));
  const s = await body('/api/search', { q: 'nothing-like-this-anywhere' });
  assert.match(s.empty, new RegExp(`${WEEK.from} and ${WEEK.to}`));
});

test('with no goal list, the goal page shows its empty state', async () => {
  const none = createViewData({ config: w.config, roots: w.roots, ...WINDOW });
  await none.start();
  const home = await none.route('/api/home', params());
  assert.deepEqual(home.body.goals, []);
  assert.equal(home.body.goalList.given, false);
  assert.match(home.body.goalList.note, /goal list/);
  const g = await none.route('/api/goal', params({ key: goalKey('release-1-4') }));
  assert.equal(g.status, 404);
  assert.equal(g.body.error, 'no-goal-list');
});

// ---- the record panel ------------------------------------------------------------------

test('a record for a command step includes its shortened, redacted output, and its counts\' levels', async () => {
  const r = await body('/api/replay', { session: w.keys.featured });
  const run = r.events.find((e) => e.kind === 'action' && e.tests);
  const rec = await body('/api/record', { event: run.id });
  assert.match(rec.output.text, /not ok 3 - parses dates/);
  assert.match(rec.output.text, /\[redacted:term\] build/);
  assert.ok(rec.output.text.length <= 1500);
  assert.equal(rec.output.evidence, 'recorded');
  assert.deepEqual(rec.records.map((x) => x.part), ['step', 'result']);
  const engine = reference.events.find((e) => e.id === run.id);
  assert.deepEqual({ ...rec.tests, evidence: undefined }, { ...engine.derived.tests, evidence: undefined });
  assert.equal(rec.tests.evidence, 'derived', 'the engine keeps parsed counts as derived');
  assert.deepEqual(rec.event.testRun, { evidence: 'inferred', rule: 'shell.test' });
  const frames = (await body('/api/replay', { session: w.keys.featured })).frames;
  const tl = reference.threadTimeline(engine.session && reference.sessions.find((s) => s.key === w.keys.featured).thread);
  for (const f of frames) assert.deepEqual(f.evidence.testRuns, tl.stateAt(f.t).countEvidence.testRuns);
});

test('who wrote a prompt: You, recorded or inferred, or a person or a script', async () => {
  const r = await body('/api/replay', { session: w.keys.featured });
  const prompts = r.events.filter((e) => e.kind === 'prompt');
  const typed = await body('/api/record', { event: prompts[0].id });
  assert.deepEqual(typed.who, { label: 'You', evidence: 'recorded', rule: null });
  const noOrigin = await body('/api/record', { event: prompts.find((e) => e.text.includes('tidy the changelog')).id });
  assert.deepEqual(noOrigin.who, { label: 'You', evidence: 'inferred', rule: 'prompt.authorship.no-origin' });
  const exec = (await body('/api/replay', { session: w.keys.exec })).events.find((e) => e.kind === 'prompt');
  assert.deepEqual(exec.who, { label: 'a person or a script', evidence: 'inferred', rule: 'prompt.authorship.exec-session' });
  const agent = r.events.find((e) => e.actor === 'agent' && e.agent && !e.agent.endsWith(':main'));
  assert.match(agent.who.label, /sub-agent "Check the dates"/);
  assert.equal(r.events.find((e) => e.actor === 'agent' && e.agent?.endsWith(':main')).who.label, 'the main agent');
});

// ---- ambiguity, over the engine's goal corpus -------------------------------------------

test('a lookup\'s and a goal member\'s ambiguous flags reach the page', async () => {
  const fx = buildCorpus({ root: join(scratch, 'corpus'), goals: true });
  const corpus = createViewData({ config: fx.config, roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, from: '2024-06-10', to: '2024-06-16', timezone: 'UTC', goalRecord: fx.goalRecord });
  await corpus.start();
  const r = (await corpus.route('/api/lookup', params({ q: 'your-project#11' }))).body;
  assert.equal(r.sessions.length, 2);
  for (const s of r.sessions) {
    assert.equal(s.ambiguous, true);
    const g = s.goals.find((x) => x.key === goalKey('g-owners'));
    assert.ok(g, 'the goal is listed beside the lookup result');
    assert.deepEqual([g.evidence, g.ambiguous], ['recorded', true]);
  }
  assert.ok(r.notes.some((n) => n.kind === 'owners-disagree'));
  const goal = (await corpus.route('/api/goal', params({ key: goalKey('g-owners') }))).body;
  assert.ok(goal.members.length === 2 && goal.members.every((m) => m.ambiguous === true));
  assert.ok(goal.members.every((m) => m.joins.every((j) => j.ambiguous?.owners === 2)));
});

test('no data answer names the engine\'s private-text option', () => {
  const text = JSON.stringify([...redactedAnswers, ...privateAnswers].map((a) => a.body));
  assert.ok(!text.includes('privateText'));
});

test('the leak counter reads a JSON line break as a break, so a commit id after one is not a token, and a secret after one is still found', () => {
  const counter = createLeakCounter({ redaction: {} });
  const sha = '3f9a1c0b7e2d4f6a8b0c1d2e3f4a5b6c7d8e9f01';
  // A tool result shown as JSON, as the record panel shows it: `\n` glues an n onto the id.
  const record = JSON.stringify({ type: 'user', content: [{ type: 'tool_result', content: `exit=0\n${sha}\nlib/x.mjs` }] }, null, 2);
  assert.ok(record.includes(`\\n${sha}`), 'the shown record writes the line break as an escape');
  assert.equal(counter.redacted(record).secrets, 0);
  assert.equal(counter.secrets(record).secrets, 0);
  // Failing-path partners: a real secret after the same break still counts, with the switch off and on.
  for (const secret of ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'sk-abcdefghijklmnop1234567890']) {
    for (const sep of ['\n', '\t']) {
      const shown = JSON.stringify({ content: `exit=0${sep}${secret}` });
      assert.equal(counter.redacted(shown).secrets, 1, `${secret.slice(0, 4)} after ${JSON.stringify(sep)}`);
      assert.equal(counter.secrets(shown).secrets, 1);
    }
  }
  // An escaped backslash before an n (a Windows folder in JSON) isn't a line break.
  assert.equal(unglue('C:\\\\new\\\\x'), 'C:\\\\new\\\\x');
  assert.equal(unglue('a\\nb'), 'a\\ b');
  assert.equal(unglue('a\\\\\\nb'), 'a\\\\\\ b', 'an odd run of backslashes ends in an escape');
});

test('a session with no prompt says what opened it, from its records, and sessions with a prompt come first', async () => {
  // The fixture's history, with three made-up configured sessions added that have no prompt:
  // one a person opened with a command, one a schedule opened, and one with no opening record.
  const base = reference.sessions.find((s) => s.private === false);
  const late = '2099-01-01T00:00:00.000Z';
  const extra = ['cmd', 'sched', 'bare'].map((k, i) => ({ ...base, key: `cc-zz${k}`, thread: null, title: null, firstAt: late, lastAt: `2099-01-01T00:0${i + 1}:00.000Z` }));
  const ev = (session, kind, actor, facts) => ({ id: `${session}.1.0`, kind, at: late, t: Date.parse(late), timeFrom: 'record', source: session, session, agent: null, actor, evidence: 'recorded', refs: [], facts, derived: {}, inferred: [], missing: [], turn: null });
  // Two configured sessions with prompts, so all five fit in the list of twelve.
  const kept = new Set(reference.sessions.filter((s) => s.private === false).slice(0, 2).map((s) => s.key));
  const own = (list) => list.filter((e) => kept.has(e.session));
  const h = { ...reference, sessions: [...reference.sessions.filter((s) => kept.has(s.key)), ...extra], events: [...own(reference.events), ev('cc-zzcmd', 'command', 'person', { name: '/review' }), ev('cc-zzsched', 'agent-message', 'harness', { direction: 'inbound', from: 'scheduled-task' })] };
  const d = createViewData({ config: w.config, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, buildHistory: async () => h });
  await d.start();
  const home = (await d.route('/api/home', params())).body;
  const recent = home.recent;
  const firstEmpty = recent.findIndex((r) => r.prompts.value === 0);
  assert.ok(firstEmpty > 0, 'the newest sessions have no prompt, yet a session with one comes first');
  assert.ok(recent.slice(firstEmpty).every((r) => r.prompts.value === 0), 'every session with a prompt comes before every one without');
  const by = Object.fromEntries(recent.filter((r) => r.session.startsWith('cc-zz')).map((r) => [r.session, r.startedBy]));
  assert.deepEqual(by['cc-zzcmd'], { text: 'started with a command you typed (/review), no prompt', evidence: 'recorded' });
  assert.deepEqual(by['cc-zzsched'], { text: 'started by a schedule, no prompt', evidence: 'recorded' });
  assert.deepEqual(by['cc-zzbare'], { text: `no prompt between ${WINDOW.from} and ${WINDOW.to}`, evidence: 'derived' });
  for (const r of recent.filter((x) => x.session.startsWith('cc-zz'))) assert.equal(r.title, null, 'no title is made up');
  // Failing-path partner: a session with a prompt has no startedBy label.
  assert.ok(recent.filter((r) => r.prompts.value > 0).every((r) => r.startedBy === null));
  // A command name that isn't a plain slash command, such as one redaction changed, isn't shown.
  const h2 = { ...h, events: [...own(reference.events), ev('cc-zzcmd', 'command', 'person', { name: '[redacted:term]' })] };
  const d2 = createViewData({ config: w.config, roots: w.roots, ...WINDOW, buildHistory: async () => h2 });
  await d2.start();
  const r2 = (await d2.route('/api/home', params())).body.recent.find((r) => r.session === 'cc-zzcmd');
  assert.equal(r2.startedBy.text, 'started with a command you typed, no prompt');
});
