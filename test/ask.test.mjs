// find, replay, problems and goals (issue 178): the questions the view page answers, as text or
// JSON, on the made-up demo week that ships in lib/demo/. Each answer is checked for what it
// promises: every row keeps its evidence word, text from the logs or the goal list is marked as
// quoted, nothing private shows, there's no flag that shows private text, hints name the command
// the way it was run, and the existing commands' help is byte-identical in the `honestweek` form.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { askHelp, parseAskArgs, runAsk, TEXT_NOTE, QUOTED_NOTE } from '../lib/ask.mjs';
import { pageLink } from '../lib/view/page-link.mjs';
import { setConfigLookup } from '../lib/config-lookup.mjs';
import { buildDemoWeek } from '../lib/demo/week.mjs';
import { setCommandForm } from '../lib/invocation.mjs';
import { isReference } from '../lib/replay/words.mjs';
import { DEMO_TERM } from '../lib/view.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';
import { withoutUserConfig } from './helpers/no-user-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'honestweek.mjs');

// One demo week for every in-process question, built the way --demo builds it.
const d = buildDemoWeek();
after(() => rmSync(d.root, { recursive: true, force: true }));
const redaction = d.config.redaction ?? {};
const WEEK = { config: { ...d.config, redaction: { ...redaction, terms: [...(redaction.terms ?? []), DEMO_TERM] } }, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, demo: true };

async function asked(command, argv = []) {
  const out = [];
  const err = [];
  const code = await runAsk({ command, argv, week: WEEK, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, out: out.join(''), err: err.join('') };
}
async function json(command, argv = []) {
  const r = await asked(command, [...argv, '--json']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

const EVIDENCE = new Set(['recorded', 'derived', 'inferred', 'missing', 'ambiguous']);
/** Keys whose value is text from a log or the goal list, wherever they sit in an answer. */
const LOG_TEXT = new Set(['title', 'label', 'text', 'name', 'branch', 'ref', 'where']);
/** Places those keys hold honestweek's own words, not log text. */
const OWN_TEXT_PARENTS = new Set(['notes', 'evidenceKey', 'rules', 'parsed']);

/** Every object in `value`, with the key path it sits at. */
function* walk(value, path = []) {
  if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* walk(v, [...path, i]);
  else if (value && typeof value === 'object') {
    yield [value, path];
    for (const [k, v] of Object.entries(value)) yield* walk(v, [...path, k]);
  }
}

/** The promises every JSON answer keeps. */
function checkAnswer(o, command) {
  assert.equal(o.command, command);
  assert.equal(o.about, QUOTED_NOTE);
  assert.equal(o.demo, true);
  assert.deepEqual(o.window, { from: WEEK.from, to: WEEK.to, timezone: WEEK.timezone });
  let rows = 0;
  let quoted = 0;
  for (const [obj, path] of walk(o)) {
    if (path.some((p) => OWN_TEXT_PARENTS.has(p))) continue;
    if ('evidence' in obj && path.at(-1) !== 'evidenceKey') {
      rows += 1;
      if (obj.evidence !== null) assert.ok(EVIDENCE.has(obj.evidence), `${path.join('.')}: evidence ${JSON.stringify(obj.evidence)}`);
    }
    for (const k of LOG_TEXT) {
      if (!(k in obj) || obj[k] === null) continue;
      // A step's who label and a pattern's name are honestweek's words; a finding's checkTitle too.
      if (k === 'name' && path.includes('patterns') && path.at(-1) !== 'findings') continue;
      if (k === 'label' && path.at(-1) === 'who' && typeof obj[k] === 'string') continue;
      assert.equal(typeof obj[k], 'object', `${path.join('.')}.${k} is log text, so it's marked quoted`);
      assert.equal(typeof obj[k].quoted, 'string', `${path.join('.')}.${k}`);
      quoted += 1;
    }
  }
  assert.ok(rows > 0, 'rows carry evidence words');
  assert.ok(quoted > 0, 'log text is marked quoted');
  // Redacted as the page's default view: the demo's private word never shows.
  assert.doesNotMatch(JSON.stringify(o), new RegExp(DEMO_TERM, 'i'));
}

// ---- find ---------------------------------------------------------------------------------------

test('find reads a pull request as a reference: sessions, how each link is known, its goals, and a next step', async () => {
  const o = await json('find', ['#12']);
  checkAnswer(o, 'find');
  assert.equal(o.reference.kind, 'pr');
  assert.equal(o.words, null, 'a pull request is not also searched as words');
  const s = o.reference.sessions[0];
  assert.equal(s.session, 'cc-hccfcndehggh');
  assert.equal(s.title.quoted, 'Add a --since flag to filter releases');
  assert.ok(s.refs.some((r) => r.evidence === 'inferred' && r.rule === 'git.pr-number-from-subject'));
  assert.ok(s.refs.every((r) => EVIDENCE.has(r.evidence)));
  assert.ok(o.reference.goals.length === 1 && o.reference.goals[0].title.quoted.includes('[redacted:term]'));
  assert.ok(o.reference.rules['pr.gh-command']);

  const t = await asked('find', ['#12']);
  assert.equal(t.code, 0);
  const lines = t.out.split('\n');
  assert.equal(lines[0], `honestweek find: pull request #12 in any repository, ${WEEK.from} to ${WEEK.to} (UTC), the made-up demo week.`);
  assert.equal(lines[1], TEXT_NOTE);
  assert.ok(lines.some((l) => l.startsWith('  cc-hccfcndehggh  recorded  "Add a --since flag to filter releases"')), t.out);
  assert.match(t.out, /pr-landed \(inferred, git\.pr-number-from-subject\)/);
  assert.match(t.out, /\nNext: honestweek replay cc-hccfcndehggh\n$/);
});

test('find reads words as a phrase search: goals, titles, branches and prompts here, then every session on the machine', async () => {
  const o = await json('find', ['date', 'filter']);
  checkAnswer(o, 'find');
  assert.equal(o.reference, null);
  assert.equal(o.query, 'date filter');
  assert.ok(o.words.goals.some((g) => g.matchedIn === 'title'));
  assert.ok(o.words.prompts.length > 0);
  for (const p of o.words.prompts) {
    assert.equal(p.evidence, 'recorded');
    assert.deepEqual([p.score.evidence, p.score.rule], ['inferred', 'view.shared-words']);
    assert.equal(typeof p.text.quoted, 'string');
  }
  assert.equal(o.elsewhere.ready, true);
  assert.ok(o.elsewhere.results.some((r) => r.group === 'display'), 'search everywhere covers display-only sessions');

  const t = await asked('find', ['date', 'filter']);
  // Log text sits on lines of its own, after ">", collapsed onto one line.
  const quotedLines = t.out.split('\n').filter((l) => /^\s+> /.test(l));
  assert.ok(quotedLines.length >= o.words.prompts.length, t.out);
  // The full count of sessions elsewhere, at its level, and how many are shown when that's fewer.
  const e = o.elsewhere;
  assert.ok(Number.isFinite(e.sessions.value));
  const shown = e.results.length < e.sessions.value ? `, the first ${e.results.length} shown` : '';
  assert.ok(t.out.includes(`: ${e.sessions.value} session(s) (${e.sessions.evidence})${shown}.`), t.out);
  for (const r of e.results) assert.ok(t.out.includes(`${r.matches.value} matching prompt(s) (${r.matches.evidence})`), r.session);
});

test('find with a file or a branch also looks for it in words, as the page does', async () => {
  const o = await json('find', ['branch:feature/since-flag']);
  assert.equal(o.reference.kind, 'branch');
  assert.ok(o.words, 'a branch is also searched as words');
  assert.ok(o.elsewhere);
});

test('find needs something to look for, and refuses an option it does not know', async () => {
  const none = await asked('find', []);
  assert.equal(none.code, 1);
  assert.match(none.err, /^honestweek find: find needs something to look up/);
  const bad = await asked('find', ['--private', 'x']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown option "--private"/);
});

// ---- replay -------------------------------------------------------------------------------------

test('replay lists a session thread step by step, with who did each step and how it is known', async () => {
  const o = await json('replay', ['cc-hccfcndehggh']);
  checkAnswer(o, 'replay');
  assert.equal(o.session, 'cc-hccfcndehggh');
  assert.equal(o.at, null);
  assert.ok(o.steps.length > 20);
  for (const e of o.steps) assert.ok(EVIDENCE.has(e.evidence), `${e.id} ${e.evidence}`);
  const prompt = o.steps.find((e) => e.kind === 'prompt');
  assert.deepEqual(prompt.who, { label: 'You', evidence: 'recorded', rule: null });
  assert.match(prompt.text.quoted, /^prompt "/);
  assert.ok(o.steps.some((e) => e.inferred.length && e.inferred.every((x) => x.rule)), 'inferred steps name their rule');

  const t = await asked('replay', ['cc-hccfcndehggh']);
  assert.match(t.out, /^honestweek replay: session cc-hccfcndehggh, "Add a --since flag to filter releases", thread th-/);
  assert.match(t.out, /\n2025-03-10 09:02:11  cc-hccfcndehggh\.\d+\.0  You, prompt, recorded\n    > prompt "Add a --since flag/);
  assert.match(t.out, /\nNext: honestweek replay cc-hccfcndehggh --at 2025-03-10T09:02:11\.000Z\n$/);
});

test('replay --at says what had happened by that moment, and marks the last step by then', async () => {
  const o = await json('replay', ['cc-hccfcndehggh', '--at', '2025-03-10T09:30:00Z']);
  assert.equal(o.at.time, '2025-03-10T09:30:00.000Z');
  assert.equal(o.at.before, false);
  assert.ok(o.at.counts.prompts.value >= 1);
  for (const c of Object.values(o.at.counts)) assert.ok(EVIDENCE.has(c.evidence));
  assert.ok(o.steps.some((e) => e.id === o.at.step));
  const t = await asked('replay', ['cc-hccfcndehggh', '--at', '2025-03-10T09:30:00Z']);
  assert.match(t.out, /\nAt 2025-03-10 09:30:00: \d+ prompt\(s\)/);
  assert.match(t.out, /<- the last step by this moment/);
  const early = await json('replay', ['cc-hccfcndehggh', '--at', '2025-03-01T00:00:00Z']);
  assert.equal(early.at.before, true);
  const bad = await asked('replay', ['cc-hccfcndehggh', '--at', 'soon']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--at must be a time/);
});

test('replay of a session the window does not hold says so in one line', async () => {
  const r = await asked('replay', ['cc-aaaaaaaaaaaa']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^honestweek replay: No session with that id between 2025-03-10 and 2025-03-16\.\n$/);
  const none = await asked('replay', []);
  assert.equal(none.code, 1);
  const two = await asked('replay', ['cc-hccfcndehggh', 'cc-aaaaaaaaaaaa']);
  assert.equal(two.code, 1);
  assert.match(two.err, /replay needs one session id/);
});

test('replay --at before the first step keeps each count at the level the page gives it', async () => {
  const early = await json('replay', ['cc-hccfcndehggh', '--at', '2025-03-01T00:00:00Z']);
  for (const k of ['testRuns', 'testsPassed', 'testsFailed', 'prsLanded']) assert.equal(early.at.counts[k].evidence, 'inferred', k);
  for (const k of ['prompts', 'actions', 'edits', 'commits']) assert.equal(early.at.counts[k].evidence, 'recorded', k);
  const t = await asked('replay', ['cc-hccfcndehggh', '--at', '2025-03-10T09:30:00Z']);
  assert.match(t.out, /\nAt 2025-03-10 09:30:00: \d+ prompt\(s\) \(recorded\), \d+ action\(s\) \(recorded\), \d+ edit\(s\) \(recorded\), \d+ test run\(s\) \(inferred\), \d+ agent\(s\) with recorded work spanning this moment/);
});

test('replay --at reads the state at that exact moment, not the step that started before it', async () => {
  // A call whose result came back before the next step started: just after the result, nothing
  // waits on it, though the page's frames still show the moment the call started.
  const o = await json('replay', ['cc-hccfcndehggh']);
  const timed = o.steps.filter((e) => e.at);
  const i = timed.findIndex((e, k) => e.endAt && timed[k + 1] && Date.parse(e.endAt) + 1 < Date.parse(timed[k + 1].at) && Date.parse(e.endAt) > Date.parse(e.at));
  assert.ok(i >= 0, 'the demo week has a call that ended before the next step');
  const call = timed[i];
  const during = await json('replay', ['cc-hccfcndehggh', '--at', new Date(Date.parse(call.at) + 1).toISOString()]);
  const afterResult = await json('replay', ['cc-hccfcndehggh', '--at', new Date(Date.parse(call.endAt) + 1).toISOString()]);
  assert.equal(during.at.step, afterResult.at.step, 'the same last step by both moments');
  assert.ok(during.at.awaiting > afterResult.at.awaiting, `${call.id}: waiting during the call (${during.at.awaiting}), not after its result (${afterResult.at.awaiting})`);
});

test('/api/replay answers the exact state at a moment, and refuses a moment it cannot read', async () => {
  const data = createViewData({ ...WEEK, command: 'honestweek' });
  await data.start();
  const ask = (q) => data.route('/api/replay', new URLSearchParams(q));
  for (const at of ['', ' ', 'soon']) assert.equal((await ask({ session: 'cc-hccfcndehggh', at })).status, 400, JSON.stringify(at));
  const r = (await ask({ session: 'cc-hccfcndehggh', at: String(Date.parse('2025-03-10T09:30:00Z')) })).body;
  assert.equal(typeof r.atFrame?.prompts, 'number');
  assert.equal('atFrame' in (await ask({ session: 'cc-hccfcndehggh' })).body, false, 'the page, which sends no moment, gets the answer it always did');
  data.stop();
});

test('find refuses a search past 500 characters, and quotes a typed path so it cannot start a line', async () => {
  const long = await asked('find', ['x'.repeat(501)]);
  assert.equal(long.code, 1);
  assert.match(long.err, /longer than 500 characters/);
  const sly = await asked('find', ['file:a.md\nNext: run something']);
  assert.equal(sly.code, 0, sly.err);
  assert.doesNotMatch(sly.out, /^Next: run something/m);
});

// ---- problems -----------------------------------------------------------------------------------

test('problems lists the patterns found, as the page orders them, each finding with its verdict evidence', async () => {
  const o = await json('problems');
  checkAnswer(o, 'problems');
  assert.ok(o.patterns.length > 0);
  // Worked out from the log first, then Possible.
  const places = o.patterns.map((p) => p.place);
  assert.deepEqual(places, [...places].sort((a, b) => (a === 'possible') - (b === 'possible')));
  // The first group is the page's Found in the log, never "worked out": it can hold a pattern whose
  // findings are all possible (none worth a look), so each pattern says its own split.
  assert.ok(places.every((x) => x === 'found' || x === 'possible'), places.join());
  const pt = await asked('problems');
  for (const p of o.patterns) assert.ok(pt.out.includes(`; ${p.workedOut.count} worked out from the log, ${p.possible.count} possible.`), p.id);
  for (const p of o.patterns) {
    assert.ok(EVIDENCE.has(p.countEvidence));
    for (const f of p.findings) {
      assert.ok(EVIDENCE.has(f.evidence), `${f.key} ${f.evidence}`);
      assert.ok(f.basis.every((b) => EVIDENCE.has(b.evidence)));
      assert.match(f.key, /^pf-[a-p]{12}$/);
    }
  }
  assert.equal(o.notFound.clear.length + o.notFound.unchecked.length + o.notFound.undetectable.length + o.patterns.length, Object.values(o.statusCounts).reduce((a, b) => a + b, 0));
  const t = await asked('problems');
  // A finding's note can name files from the log, so it's quoted like the rest of the log's text.
  assert.ok(o.patterns.some((p) => p.findings.some((f) => f.note)));
  for (const p of o.patterns) for (const f of p.findings) assert.ok(f.note === null || typeof f.note.quoted === 'string', f.key);
  assert.match(t.out, /^honestweek problems: \d+ pattern\(s\) found; \d+ session\(s\) checked \(derived\)/);
  assert.match(t.out, /\nFound in the log \(each pattern says how many/);
  // A pattern listed first with no finding worked out from the log says so, rather than borrowing the heading's level.
  for (const p of o.patterns) assert.ok(t.out.includes(`${p.count} finding(s), ${p.countEvidence}; ${p.workedOut.count} worked out from the log, ${p.possible.count} possible.`), p.id);
  assert.match(t.out, /\nNot found: \d+ checked with nothing found, /);
  assert.doesNotMatch(t.out, /\n {4}[^> ]/, 'every indented line under a finding is quoted log text');
  assert.match(t.out, /\nNext: honestweek replay \S+ --at \S+\n$/);
  const words = await asked('problems', ['everything']);
  assert.equal(words.code, 1);
});

// ---- goals --------------------------------------------------------------------------------------

test('goals lists each goal with its member sessions and how each joins it; one goal shows its joins', async () => {
  const o = await json('goals');
  checkAnswer(o, 'goals');
  assert.equal(o.goals.length, 4);
  for (const g of o.goals) {
    assert.equal(typeof g.title.quoted, 'string');
    for (const m of g.members) {
      assert.ok(EVIDENCE.has(m.evidence));
      assert.ok(m.joins.every((j) => EVIDENCE.has(j.evidence) && (j.evidence !== 'inferred' || j.rule)));
    }
  }
  const key = o.goals[0].key;
  const one = await json('goals', [key]);
  assert.equal(one.goal.key, key);
  assert.ok(one.goal.members.length > 0);
  const byId = await json('goals', [d.goalRecord.goals[0].id]);
  assert.equal(byId.goal.key, goalKeyOfFirst(o));
  const t = await asked('goals');
  assert.match(t.out, /^honestweek goals: 4 goal\(s\)/);
  // Each join in text carries its count and its level, with "ambiguous" kept when the JSON has it.
  for (const g of o.goals) {
    for (const m of g.members) {
      for (const j of m.joins) assert.ok(t.out.includes(`${j.type}${j.count > 1 ? ` x${j.count}` : ''} (${j.ambiguous ? `${j.evidence}, ambiguous` : j.evidence}${j.rule ? `, ${j.rule}` : ''})`), `${m.session} ${j.type}`);
    }
  }
  assert.match(t.out, new RegExp(`\\nNext: honestweek goals ${key}\\n$`));
  const missing = await asked('goals', ['no-such-goal']);
  assert.equal(missing.code, 1);
  // `unmatched` is the same list in both forms; the list form adds its count beside it.
  for (const g of o.goals) {
    assert.ok(Array.isArray(g.unmatched));
    assert.equal(typeof g.unmatchedCount, 'number');
  }
  assert.ok(Array.isArray(one.goal.unmatched));
  const detail = await asked('goals', [key]);
  assert.match(detail.out, /^honestweek goals: goal /);
  assert.match(detail.out, /\nNot matched: \d+/);
});
const goalKeyOfFirst = (o) => o.goals.find((g) => g.title.quoted === d.goalRecord.goals[0].title.replace(new RegExp(DEMO_TERM, 'gi'), '[redacted:term]'))?.key;

// ---- links to the page (issue 198) --------------------------------------------------------------

test('every session, step, finding and goal names its page on view, one view --page takes as it is', async () => {
  const answers = { find: await json('find', ['#12']), words: await json('find', ['date', 'filter']), replay: await json('replay', ['cc-hccfcndehggh']), problems: await json('problems'), goals: await json('goals') };
  let pages = 0;
  for (const [name, o] of Object.entries(answers)) {
    for (const [obj, path] of walk(o)) {
      if (!('page' in obj)) continue;
      const at = `${name}: ${path.join('.')}`;
      if (obj.page === null) {
        // Only a session outside the window, which the page can't open, goes without one.
        assert.equal(obj.inWindow, false, at);
        continue;
      }
      pages += 1;
      assert.deepEqual(pageLink(obj.page), { page: obj.page }, at);
      if (typeof obj.session === 'string') assert.ok(obj.page.startsWith(`replay.html?session=${obj.session}`), `${at}: ${obj.page}`);
    }
  }
  assert.ok(pages > 50, `pages were found (${pages})`);
  const r = answers.replay;
  assert.equal(r.page, `replay.html?session=cc-hccfcndehggh#${r.thread.id}`);
  for (const e of r.steps) if (e.session) assert.equal(e.page, `replay.html?session=${e.session}#${r.thread.id}~${e.id}`);
  for (const p of answers.problems.patterns) for (const f of p.findings) assert.ok(f.page?.includes(`#${f.thread}~${f.event}`), f.key);
  for (const g of answers.goals.goals) {
    assert.equal(g.page, `goal.html#${g.key}`);
    // A member opens on its own thread, as the goal page's replay link does.
    for (const m of g.members) assert.match(m.page, /^replay\.html\?session=[a-z]{2,4}-[a-p]+#th-[a-p]+$/, m.session);
  }

  // In text, each row ends with its page, and the line before Next opens it on the same week.
  const t = await asked('replay', ['cc-hccfcndehggh']);
  assert.ok(t.out.includes(`\nIts page: ${r.page}. For one step, add ~ and the step's id, such as ${r.page}~${r.steps[0].id}.\n`), t.out.slice(0, 600));
  assert.match(t.out, new RegExp(`\\nOpen it on the page: honestweek view --demo --page "${r.page.replace(/[.?]/g, '\\$&')}"\\nNext: `));
  const f = await asked('find', ['#12']);
  assert.ok(f.out.includes(`10:25  page ${answers.find.reference.sessions[0].page}\n`), f.out);
  const pr = await asked('problems');
  const first = answers.problems.patterns[0].findings[0];
  assert.ok(pr.out.includes(`  page ${first.page}\n`), pr.out.slice(0, 800));
  assert.ok(pr.out.includes(`\nOpen it on the page: honestweek view --demo --page "${first.page}"\nNext: honestweek replay ${first.session}`));
});

test('goals without a goal list says how to give one', async () => {
  const out = [];
  const err = [];
  const code = await runAsk({ command: 'goals', argv: [], week: { ...WEEK, goalRecord: null }, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  assert.equal(code, 1);
  assert.match(err.join(''), /goal list/i);
});

// ---- how it's run -------------------------------------------------------------------------------

test('there is no option that shows private text, and the commands never ask the page for it', () => {
  for (const flag of ['--private', '--show-private', '--private-text', '--unredacted']) assert.throws(() => parseAskArgs('find', [flag]), /unknown option/);
  const src = readFileSync(join(ROOT, 'lib', 'ask.mjs'), 'utf8');
  assert.doesNotMatch(src, /private['"]?\s*:\s*['"]1|privateText|createSecretsOnlyRedactor/);
  assert.throws(() => parseAskArgs('find', ['--at', 'x']), /unknown option "--at"/, '--at is replay\'s alone');
});

test('help names each command the way honestweek was run', () => {
  setCommandForm('npx honestweek');
  try {
    for (const c of ['find', 'replay', 'problems', 'goals']) assert.match(askHelp(c), new RegExp(`\\n  npx honestweek ${c} `));
  } finally {
    setCommandForm('honestweek');
  }
});

test('with no config anywhere, a question says so in one line and names the fix', async () => {
  const home = makeTempDir('hw-ask-home-');
  const here = makeTempDir('hw-ask-here-');
  setConfigLookup({ env: {}, home });
  try {
    const err = [];
    const code = await runAsk({ command: 'find', argv: ['#1'], cwd: here, io: { out: () => {}, err: (s) => err.push(s) } });
    assert.equal(code, 1);
    const text = err.join('');
    assert.equal(text.split('\n').filter(Boolean).length, 1, text);
    assert.match(text, /no honestweek\.config\.json here, no HONESTWEEK_CONFIG, and no user-level config\. Run honestweek init/);
    assert.match(text, /--demo/);
  } finally {
    setConfigLookup(null);
  }
});

test('with your own config, the commands read the window and goal list the way view does', async () => {
  const project = makeTempDir('hw-ask-own-');
  const home = makeTempDir('hw-ask-own-home-');
  writeFileSync(join(project, 'honestweek.config.json'), JSON.stringify({ identity: { authorEmails: ['you@example.com'] }, week: { timezone: 'UTC' }, repos: d.config.repos.map((r) => ({ path: r.resolvedPath ?? r.path, label: r.label, role: r.role })), redaction: WEEK.config.redaction }));
  writeFileSync(join(project, 'goals.json'), JSON.stringify(d.goalRecord));
  const env = { CLAUDE_CONFIG_DIR: dirname(d.roots.claude[0]), CODEX_HOME: dirname(d.roots.codex[0]) };
  setConfigLookup({ env: {}, home });
  const run = async (command, argv) => {
    const out = [];
    const err = [];
    const code = await runAsk({ command, argv, cwd: project, env, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
    return { code, out: out.join(''), err: err.join('') };
  };
  try {
    const g = await run('goals', ['--from', '2025-03-10', '--to', '2025-03-16', '--goals', 'goals.json', '--json']);
    assert.equal(g.code, 0, g.err);
    const o = JSON.parse(g.out);
    assert.equal(o.demo, false);
    assert.deepEqual(o.window, { from: '2025-03-10', to: '2025-03-16', timezone: 'UTC' });
    assert.equal(o.goals.length, 4);
    assert.match(g.err, /honestweek\.config\.json/, 'it says which config it read');
    const r = await run('replay', ['cc-hccfcndehggh', '--from', '2025-03-10', '--to', '2025-03-16']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^honestweek replay: session cc-hccfcndehggh/);
    // A thread's id can change with the window, so the page is opened on the same dates, not view's default.
    assert.match(r.out, /\nOpen it on the page: honestweek view --from 2025-03-10 --to 2025-03-16 --timezone UTC --page "replay\.html\?session=cc-hccfcndehggh#th-[a-p]+"\n/);
    for (const bad of [['--days', 'many'], ['--timezone', 'Mars/Olympus'], ['--goals', 'nope.json']]) {
      const b = await run('problems', bad);
      assert.equal(b.code, 1, bad.join(' '));
      assert.match(b.err, /^honestweek problems: /m);
      assert.doesNotMatch(b.err, /view: /, 'the error names this command, not view');
    }
  } finally {
    setConfigLookup(null);
  }
});

test('the commands run from the package entry point with --demo alone, and refuse --demo with your own config', () => {
  const env = withoutUserConfig();
  const r = spawnSync(process.execPath, [BIN, 'goals', '--demo', '--json'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120e3 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).goals.length, 4);
  for (const c of ['find', 'replay', 'problems', 'goals']) {
    const h = spawnSync(process.execPath, [BIN, c, '--help'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(h.status, 0);
    assert.match(h.stdout, new RegExp(`^honestweek ${c}: `));
  }
  const clash = spawnSync(process.execPath, [BIN, 'problems', '--demo', '--config', 'x.json'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /can't be combined with --config/);
});

// ---- what stays the same ------------------------------------------------------------------------

test('every existing command\'s help is byte-identical when run as honestweek', () => {
  // sha256 of each command's --help as it was before the form was printed (main after PR 188), with
  // this run's form put back to `honestweek`. view's was pinned again when it gained --page and
  // the typed link command (issue 198).
  const PINNED = { init: 'ab19e2612ef4f30d', discover: '2f8a956d47782695', validate: '89aae3507378c98d', build: '98c962f4eae39b1a', history: '4ea17a3d41f0650c', harvest: '7ef53b3059eaccb3', prompts: '722a9ce168f5fa1c', digest: 'abed4b6419559f18', preview: 'f612271257e1dba6', mine: '677f622dcb6493c0', view: '0fa7b4f9fc3679cf', status: 'c264bc08328fb0b2' };
  const env = withoutUserConfig();
  // From a folder outside the repository, the form names the entry point by its whole path.
  const outside = makeTempDir('hw-ask-help-');
  const slashed = BIN.replace(/\\/g, '/');
  const form = `node ${/\s/.test(slashed) ? `"${slashed}"` : slashed}`;
  for (const [c, hash] of Object.entries(PINNED)) {
    const r = spawnSync(process.execPath, [BIN, c, '--help'], { cwd: outside, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`${form} ${c}`), `${c}'s usage names the form it was run with`);
    const back = r.stdout.split(form).join('honestweek');
    assert.equal(createHash('sha256').update(back).digest('hex').slice(0, 16), hash, `${c} --help`);
  }
});

test('phrase search in the engine reads exactly as the page did before it moved there', async () => {
  // A projection of /api/words and /api/search on the demo week (no locale-dependent label or
  // time text), pinned from the page's own implementation before the move.
  const data = createViewData({ ...WEEK, command: 'honestweek' });
  await data.start();
  await data.searchReady();
  const ask = async (path, q) => (await data.route(path, new URLSearchParams(q))).body;
  const words = async (q) => {
    const a = await ask('/api/words', q);
    return { goals: a.goals.map((g) => [g.key, g.matchedIn, g.evidence]), sessions: a.sessions.map((s) => [s.session, s.evidence]), branches: a.branches.map((b) => [b.branch, b.sessions.map((s) => [s.session, s.event])]), prompts: a.prompts.map((p) => [p.event, p.session, p.evidence, p.matched, p.score.value, p.score.of, p.text]), similar: a.similar.map((p) => [p.event, p.score.value]), empty: a.empty };
  };
  const first = (await ask('/api/words', { q: 'release' })).prompts[0].event;
  const everywhere = async (q) => (await ask('/api/search', { q })).results.map((r) => [r.session, r.group, r.name, r.matches.value, r.snippets.map((x) => x.text)]);
  const got = {
    dateFilter: await words({ q: 'date filter' }),
    release: await words({ q: 'release' }),
    branch: await words({ q: 'since-flag' }),
    similar: await words({ similar: first }),
    nothing: await words({ q: 'zzzqqq' }),
    searchRelease: await everywhere('release'),
    searchWidth: await everywhere('width'),
  };
  data.stop();
  const hashes = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)]));
  assert.deepEqual(hashes, PHRASE_SEARCH);
});
const PHRASE_SEARCH = { dateFilter: 'f80cf325753d8fc4', release: 'c7fcb237a0eeaa25', branch: '773f14f64cca828f', similar: '3324c306b18c0632', nothing: 'acbf88822c7344ae', searchRelease: 'e594a7293a4c638e', searchWidth: '0b515fa4264b6bdd' };

test('a reference reads the same way the Find page reads it, plus the prefixes find names', () => {
  for (const q of ['#12', 'your-project#12', 'pr #3', 'https://github.com/example/your-project/pull/7', 'c035f759a2ae', 'file:src/cli.js', 'branch:main', 'src/cli.js', 'cli.js']) assert.equal(isReference(q), true, q);
  for (const q of ['pr:12', 'commit:abc1234', 'path:docs/a.md']) assert.equal(isReference(q), true, q);
  for (const q of ['date filter', 'parser', 'release notes']) assert.equal(isReference(q), false, q);
  // The page keeps its own copy of the rule (search.js), read here as written; the two agree,
  // prefixes included, so the page and find send the same text to the same answer.
  const src = readFileSync(join(ROOT, 'lib', 'view', 'assets', 'search.js'), 'utf8');
  const pr = new RegExp(src.match(/const PR_RE = \/(.+)\/i;/)[1], 'i');
  const url = new RegExp(src.match(/const PR_URL = \/(.+)\/i;/)[1], 'i');
  const isRef = new Function('PR_RE', 'PR_URL', `return (q) => ${src.match(/const isRef = \(q\) => (.+);\r?\n/)[1]};`)(pr, url);
  for (const q of ['#12', 'your-project#12', 'c035f759a2ae', 'file:src/cli.js', 'branch:main', 'src/cli.js', 'cli.js', 'date filter', 'parser', 'pr:12', 'pull:12', 'commit:abc1234', 'path:docs/a.md', 'Commit:abc1234']) assert.equal(isReference(q), isRef(q), q);
});
