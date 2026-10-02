// Goal membership (which sessions did one goal's work, and how each link is known) and
// reverse lookup (which sessions worked on a pull request, commit, file, or branch),
// over the synthetic corpus's goal sessions (test/fixtures/replay/corpus.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkHistory, parseLookup } from '../lib/replay/index.mjs';
import { LOOKUP_RULES, RULES, prRefsInCommand } from '../lib/replay/classify.mjs';
import { goalCitations } from '../lib/replay/goals.mjs';
import { createWatch } from '../lib/replay/parse-common.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { at, buildCorpus, CODENAME, ME } from './fixtures/replay/corpus.mjs';
import { main as inspect } from '../tools/replay-inspect.mjs';

let fx;
let h;
let k;
const build = (extra = {}) => buildWorkHistory({ config: fx.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, ...extra });
const goalOf = (id) => h.goals.find((g) => g.id === id);
const memberOf = (goal, session) => goal.members.find((m) => m.session === session);
const joinsOf = (goal, session) => memberOf(goal, session)?.joins ?? [];
const sessionsOf = (result) => result.sessions.map((s) => s.session);

before(async () => {
  fx = buildCorpus({ goals: true });
  h = await build({ goals: fx.goalRecord });
  k = Object.fromEntries(Object.entries(fx.ids).map(([n, id]) => [n, n === 'P' || n === 'K' || n === 'R' ? sourceKey('cx', id) : claudeSessionKey(fx.dirs[n], id)]));
});
const allEntries = (g) => g.members.flatMap((m) => m.joins).filter((j) => j.type === 'wrote-entry' || j.type === 'created-goal').map((j) => j.detail.entry);
after(() => {
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    /* Windows can hold a lock on .git briefly */
  }
});

// ---- goal membership --------------------------------------------------------

const NEW_RULES = ['pr.gh-command', 'pr.squash-subject', 'goal.prompt-names-id'];
/** The event rules the engine shipped with before goals and lookup, in their order. */
const BASE_EVENT_RULES = ['prompt.authorship.no-origin', 'prompt.authorship.unknown-origin', 'prompt.authorship.exec-session', 'prompt.correction', 'prompt.approval', 'prompt.resume', 'prompt.question', 'shell.test', 'shell.revert', 'shell.git-commit-output', 'shell.gh-pr-output', 'git.pr-number-from-subject', 'review.delegation', 'review.skill', 'handoff.chip-start', 'canonical.earliest-ending-copy'];

test('every new rule has a plain description, kept apart from the event rules', () => {
  for (const id of NEW_RULES) {
    assert.ok(LOOKUP_RULES.has(id), id);
    assert.ok(!RULES.has(id), `${id} labels no event, so it isn't an event rule`);
    assert.ok(LOOKUP_RULES.get(id).length > 40, `${id} says what it reads`);
  }
  for (const g of h.goals) for (const m of g.members) for (const j of m.joins) if (j.rule) assert.ok(RULES.has(j.rule) || LOOKUP_RULES.has(j.rule), j.rule);
  // With a goal record, the history's rules table names them; a lookup result always does.
  for (const id of NEW_RULES) assert.equal(h.rules[id], LOOKUP_RULES.get(id));
  assert.equal(h.lookup('#7').rules['pr.gh-command'], LOOKUP_RULES.get('pr.gh-command'));
});

test('an entry id a call carried while the record accepted it is a derived write; goal.create is its own type', () => {
  const g = goalOf('g-widget');
  const w = joinsOf(g, k.W);
  const created = w.find((j) => j.type === 'created-goal');
  assert.equal(created.evidence, 'derived');
  assert.equal(created.detail.entry, 'ev-0001');
  const wrote = w.find((j) => j.type === 'wrote-entry' && !j.ambiguous);
  assert.equal(wrote.evidence, 'derived');
  assert.equal(wrote.detail.entry, 'ev-0002', 'the id after a newline in the command is still found');
  assert.equal(wrote.count, 1);
  const call = h.events.find((e) => e.id === wrote.event);
  assert.equal(call.kind, 'action');
  assert.ok(Date.parse(call.at) <= Date.parse(wrote.detail.at) && Date.parse(wrote.detail.at) <= Date.parse(call.end.at));
});

test('a later search of the record, and a call with no recorded result, write nothing', () => {
  const g = goalOf('g-widget');
  const entries = g.members.flatMap((m) => m.joins).filter((j) => j.type === 'wrote-entry' || j.type === 'created-goal').map((j) => j.detail.entry);
  assert.ok(!entries.includes('ev-0007'), 'carried only by a grep long after the record accepted it');
  assert.ok(!entries.includes('ev-0004'), 'carried by a call whose result was never recorded');
  const why = (ref) => g.unmatched.find((u) => u.kind === 'entry' && u.ref === ref)?.why ?? '';
  assert.match(why('ev-0007'), /1 call\(s\) carried this id, but none has a recorded result spanning/);
  assert.match(why('ev-0004'), /1 call\(s\) carried this id/);
  // The grep carried ev-0001 and ev-0002 too, yet each still joins exactly once.
  const w = joinsOf(g, k.W);
  assert.equal(w.filter((j) => j.type === 'created-goal').reduce((n, j) => n + j.count, 0), 1);
});

test('a call whose result came before the record accepted the entry wrote nothing (the window has an end)', () => {
  const g = goalOf('g-widget');
  assert.ok(!allEntries(g).includes('ev-0008'), 'carried by a dry run whose result was recorded before the entry was accepted');
  assert.equal(memberOf(g, k.U), undefined);
  assert.match(g.unmatched.find((u) => u.ref === 'ev-0008').why, /1 call\(s\) carried this id, but none/);
});

test('an interrupted call never writes an entry or acts on a pull request', () => {
  const g = goalOf('g-widget');
  assert.ok(!allEntries(g).includes('ev-0010'), 'the record accepted ev-0010 while the interrupted call ran');
  assert.match(g.unmatched.find((u) => u.ref === 'ev-0010').why, /1 call\(s\) carried this id, but none/);
  assert.deepEqual(h.lookup('your-project#33').sessions, [], 'an interrupted gh pr view 33');
});

test('a refused call never writes an entry, even when the record accepted it during the call', () => {
  const g = goalOf('g-widget');
  assert.ok(!allEntries(g).includes('ev-0009'));
  assert.match(g.unmatched.find((u) => u.ref === 'ev-0009').why, /1 call\(s\) carried this id, but none/);
});

test('one entry id carried inside its window by calls in two sessions is ambiguous, never picked', () => {
  const g = goalOf('g-widget');
  for (const s of [k.W, k.Z]) {
    const j = joinsOf(g, s).find((x) => x.detail?.entry === 'ev-0003');
    assert.ok(j, `the candidate ${s} is listed`);
    assert.deepEqual(j.ambiguous, { candidates: 2 });
    assert.equal(j.evidence, 'derived');
  }
  const unambiguous = joinsOf(g, k.W).find((j) => j.type === 'wrote-entry' && !j.ambiguous);
  assert.ok(unambiguous, 'an unambiguous write is kept apart from the ambiguous one');
});

test('a goal record citing a session id joins it as recorded; session: in words is unmatched with a reason', () => {
  const g = goalOf('g-widget');
  const cited = joinsOf(g, k.W).find((j) => j.type === 'cited-session');
  assert.equal(cited.evidence, 'recorded');
  assert.equal(cited.event, null);
  assert.match(cited.detail.where, /^observations\[0\]/);
  assert.equal(memberOf(g, k.W).evidence, 'recorded');
  const words = g.unmatched.find((u) => u.kind === 'session' && /long debugging/.test(u.ref));
  assert.match(words.why, /in words, not by its harness id/);
  // A display-role session cited by id is not matched, and the reason doesn't say it exists.
  const hidden = g.unmatched.filter((u) => u.kind === 'session' && u.where === 'observations[2].text');
  assert.equal(hidden.length, 1);
  assert.match(hidden[0].why, /no readable session with that id/);
});

test('a pull-request link record is a recorded cited-pr; gh pr view is an inferred command-on-pr; a mention is nothing', () => {
  const g = goalOf('g-widget');
  const a = joinsOf(g, k.A);
  const link = a.find((j) => j.type === 'cited-pr' && j.detail.via === 'pr-link');
  assert.equal(link.evidence, 'recorded');
  assert.equal(h.events.find((e) => e.id === link.event).kind, 'link');
  assert.ok(a.some((j) => j.type === 'cited-pr' && j.detail.via === 'harness-git-pr' && j.evidence === 'recorded'));
  assert.ok(!a.some((j) => j.type === 'command-on-pr'), 'gh pr merge 7 was refused by a hook, so it never ran');
  const y = joinsOf(g, k.Y);
  assert.deepEqual(y.map((j) => [j.type, j.evidence, j.rule, j.count]), [['command-on-pr', 'inferred', 'pr.gh-command', 1]], 'gh pr list --limit 7 and a comment body naming #7 add nothing');
  assert.equal(memberOf(g, k.X), undefined, 'a prompt that mentions the number, the link, a commit and a longer id joins nothing');
  const follow = g.unmatched.find((u) => u.kind === 'pr' && /#8$/.test(u.ref));
  assert.match(follow.why, /no readable session/);
});

test('a cited commit joins as recorded when the harness recorded it, inferred when read from printed output', () => {
  const g = goalOf('g-widget');
  const a = joinsOf(g, k.A).find((j) => j.type === 'cited-commit');
  assert.equal(a.evidence, 'recorded');
  assert.equal(a.detail.ref, fx.repo.featureSha.slice(0, 12));
  const p = joinsOf(g, k.P).find((j) => j.type === 'cited-commit');
  assert.equal(p.evidence, 'inferred');
  assert.equal(p.rule, 'shell.git-commit-output');
});

test('a prompt naming the goal id after character 600 joins; a longer id that contains it does not', () => {
  const g = goalOf('g-widget');
  const z = joinsOf(g, k.Z).find((j) => j.type === 'prompt-names-goal');
  assert.equal(z.evidence, 'inferred');
  assert.equal(z.rule, 'goal.prompt-names-id');
  const prompt = h.events.find((e) => e.id === z.event);
  assert.ok(prompt.facts.chars > 600);
  assert.ok(!prompt.facts.text.includes('g-widget'), 'the stored copy is clipped before the id');
  assert.equal(memberOf(g, k.X), undefined);
  // Codex: a user message names the goal, and an exec_command call writes ev-0005.
  const r = joinsOf(g, k.R);
  assert.deepEqual(r.map((j) => j.type), ['wrote-entry', 'prompt-names-goal']);
  assert.equal(r[0].detail.entry, 'ev-0005');
});

test('private and display-role sessions holding every id never join and are never git-read', async () => {
  const members = h.goals.flatMap((g) => g.members.map((m) => m.session));
  assert.ok(!members.includes(k.Q), 'display-role session');
  assert.equal(h.sessions.find((s) => s.key === k.O), undefined, 'outside the configured repos: left out');
  assert.ok(!h.sources.some((s) => s.tool === 'git' && s.repo === 'a-private-project'));
  // ev-0006 was carried only by the private sessions, inside its window.
  assert.match(goalOf('g-widget').unmatched.find((u) => u.ref === 'ev-0006').why, /no tool call in a readable session/);
  const all = await build({ goals: fx.goalRecord, scope: 'all' });
  assert.equal(all.sessions.find((s) => s.key === k.O).private, true);
  const allMembers = all.goals.flatMap((g) => g.members.map((m) => m.session));
  assert.ok(!allMembers.includes(k.O) && !allMembers.includes(k.Q));
  for (const q of ['#7', fx.displaySquashSha, 'lib/widget.mjs', 'feature/wt']) {
    assert.ok(!sessionsOf(all.lookup(q)).some((s) => s === k.O || s === k.Q), `lookup ${q} leaves private sessions out`);
  }
});

test('members are ordered by first record; an ambiguous join ranks below an inferred one', () => {
  const g = goalOf('g-widget');
  const order = g.members.map((m) => m.session);
  assert.deepEqual(order, [k.A, k.P, k.W, k.Z, k.Y, k.R]);
  for (const m of g.members) assert.equal(m.evidence, m.joins[0].evidence);
  // Z's derived write is ambiguous (W carried the same entry), so its plain inferred
  // prompt is its strongest join, and the member isn't marked ambiguous.
  const z = memberOf(g, k.Z);
  assert.equal(z.evidence, 'inferred');
  assert.equal(z.ambiguous, undefined);
  assert.deepEqual(z.joins.map((j) => [j.type, Boolean(j.ambiguous)]), [['prompt-names-goal', false], ['wrote-entry', true]]);
  assert.equal(goalOf('g-docs').members.length, 0);
  assert.match(goalOf('g-docs').unmatched[0].why, /no tool call/);
});

test('goal titles and refs pass the redactor, and nothing private reaches the output', () => {
  const g = goalOf('g-widget');
  assert.ok(!g.title.includes(CODENAME));
  assert.match(g.title, /\[redacted:term\]/);
  const json = JSON.stringify(h);
  for (const banned of [CODENAME, ME]) assert.ok(!json.includes(banned), `leaks ${banned}`);
  const view = h.goal('g-widget');
  assert.equal(view.members.length, g.members.length);
  assert.ok(view.members.every((m) => m.thread && m.firstAt));
  assert.ok(view.members.flatMap((m) => m.joins).filter((j) => j.rule).every((j) => j.ruleText === (RULES.get(j.rule) ?? LOOKUP_RULES.get(j.rule))));
  assert.equal(h.goal('g-nope'), null);
});

test('additive: without a goal record the history is unchanged, with no goals key', async () => {
  const without = await build();
  const undef = await build({ goals: undefined });
  assert.equal(JSON.stringify(without), JSON.stringify(undef));
  assert.ok(!('goals' in without.toJSON()));
  assert.equal(without.goal('g-widget'), null);
  // The parse-time scan adds side notes, never facts: everything but `goals` and the
  // rules table it extends is identical.
  const { goals, rules, ...rest } = h.toJSON();
  const { rules: plainRules, ...plainRest } = without.toJSON();
  assert.ok(goals.length === 3);
  assert.equal(JSON.stringify(rest), JSON.stringify(plainRest));
  assert.deepEqual(Object.keys(rules).filter((id) => !(id in plainRules)), NEW_RULES);
});

test('additive: without a goal record the rules table is the engine\'s event rules, unchanged', async () => {
  // The default corpus, read by the engine exactly as before this addition: the table
  // names the same rules, in the same order, with the same text, and nothing else.
  const plain = buildCorpus();
  try {
    const json = (await buildWorkHistory({ config: plain.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [plain.claudeRoot], codex: [plain.codexRoot] } })).toJSON();
    assert.equal(JSON.stringify(json.rules), JSON.stringify(Object.fromEntries(RULES)));
    assert.deepEqual(Object.keys(json.rules), BASE_EVENT_RULES);
    for (const id of NEW_RULES) assert.ok(!(id in json.rules), `${id} stays out`);
    assert.ok(!('goals' in json));
    assert.ok(!JSON.stringify(json).includes('pr.gh-command'));
  } finally {
    try {
      rmSync(plain.root, { recursive: true, force: true });
    } catch {
      /* Windows can hold a lock on .git briefly */
    }
  }
});


test('a goal record of the wrong shape is refused with a message that says what is expected', async () => {
  await assert.rejects(build({ goals: { items: [] } }), /must be an object with a "goals" list/);
  await assert.rejects(build({ goals: { goals: [], events: {} } }), /"events" must be a list/);
});

// ---- the parse-time scan and the citation reader, in isolation --------------

test('the watch list matches whole ids only, in strings rather than JSON text', () => {
  const watch = createWatch({ entryIds: ['ev-1', 'ev.v2'], goalIds: ['g-1'] });
  assert.deepEqual(watch.inCall({ command: 'run --event ev-1' }), ['ev-1']);
  assert.deepEqual(watch.inCall({ command: 'run --event ev-12 xev-1' }), []);
  assert.deepEqual(watch.inCall({ command: 'first line\nev-1' }), ['ev-1'], 'a newline before the id is a boundary');
  assert.deepEqual(watch.inCall({ nested: [{ deep: 'see ev.v2.' }] }), ['ev.v2']);
  assert.deepEqual(watch.inPrompt('work on g-1 today'), ['g-1']);
  assert.deepEqual(watch.inPrompt('work on g-12 or g-1-old'), []);
  assert.equal(createWatch({}), null, 'no watch list, no scan');
});

test('a dot followed by a letter or digit is part of an id', () => {
  const watch = createWatch({ entryIds: ['g.1', 'ev-3'], goalIds: ['g-widget'] });
  assert.deepEqual(watch.inCall({ c: 'see g.1.2' }), [], 'g.1 is not inside g.1.2');
  assert.deepEqual(watch.inCall({ c: 'see x.g.1' }), []);
  assert.deepEqual(watch.inCall({ c: 'see g.1.' }), ['g.1'], 'a dot ending a sentence is not part of it');
  assert.deepEqual(watch.inCall({ c: 'ev-3.4 and ev-3.x' }), []);
  assert.deepEqual(watch.inCall({ c: 'wrote ev-3.' }), ['ev-3']);
  assert.deepEqual(watch.inPrompt('leave g-widget.2 alone'), []);
  assert.deepEqual(watch.inPrompt('carry on with g-widget.'), ['g-widget']);
});

test('goal citations: links, repo#N, session and commit markers, bare commit ids; words are kept apart', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const cites = goalCitations({
    source: 'https://github.com/example/your-project/pull/64',
    observations: ['see your-project#64 again', 'and owner/other#3', { note: `in session:aaaaaaaa-1111-4111-8111-000000000001.` }, 'a session: in prose is not a marker', 'session:yesterday afternoon'],
    results: [`commit:${sha.slice(0, 9)}`, sha, 'commit:the big one', 'issue#5x', '#12 alone'],
  });
  assert.deepEqual(cites.map((c) => c.kind), ['pr', 'pr', 'pr', 'session', 'session-words', 'commit', 'commit', 'commit-words']);
  assert.equal(cites[0].where, 'source');
  assert.deepEqual([cites[0].owner, cites[0].repo], ['example', 'your-project']);
  assert.deepEqual([cites[1].owner, cites[1].repo], [null, 'your-project'], 'a name with no owner names none');
  assert.deepEqual([cites[2].owner, cites[2].repo], ['owner', 'other']);
  assert.equal(cites[3].where, 'observations[2].note');
  assert.equal(cites[3].id, 'aaaaaaaa-1111-4111-8111-000000000001');
});

test('pr.gh-command reads a pull request only where a command acts on it', () => {
  const refs = (c) => prRefsInCommand(c).map((r) => `${r.repo ?? '-'}#${r.number}${r.repoKnown ? '' : '?'}`);
  assert.deepEqual(refs('gh pr view 7 --json reviews'), ['-#7']);
  assert.deepEqual(refs('gh pr merge #12 --squash -R example/your-project'), ['example/your-project#12']);
  assert.deepEqual(refs('gh pr list --limit 7'), []);
  assert.deepEqual(refs('gh pr create --title "Fix #7" --body "closes #7"'), []);
  assert.deepEqual(refs('gh pr comment 9 --body "see #7 and https://github.com/o/r/pull/7"'), ['-#9']);
  assert.deepEqual(refs('gh pr checkout "https://github.com/o/r/pull/5"'), ['o/r#5']);
  assert.deepEqual(refs('cd ../other && gh pr view 3'), ['-#3?'], 'a directory change before the call names no repository');
  assert.deepEqual(refs('git commit -m "follow-up to https://github.com/o/r/pull/5"'), [], 'quoted free text is not read');
});

test("pr.gh-command honors PowerShell's $env:GH_REPO the way it honors GH_REPO=", () => {
  const refs = (c) => prRefsInCommand(c).map((r) => `${r.repo ?? '-'}#${r.number}${r.repoKnown ? '' : '?'}`);
  assert.deepEqual(refs('$env:GH_REPO="a/b"; gh pr view 7'), ['a/b#7']);
  assert.deepEqual(refs("$env:GH_REPO = 'a/b'; gh pr view 7"), ['a/b#7']);
  assert.deepEqual(refs('$Env:gh_repo=a/b; gh pr checks 8'), ['a/b#8'], 'PowerShell variable names ignore case');
  assert.deepEqual(refs('$env:GH_REPO=""; gh pr view 7'), ['-#7?'], 'a blank repository names none');
});

test('the pr.gh-command rule says a cd in an earlier call is not followed', () => {
  assert.match(LOOKUP_RULES.get('pr.gh-command'), /cd in an earlier, separate call isn't followed/);
  assert.match(h.lookup('#7').rules['pr.gh-command'], /earlier, separate call/);
});

test('pr.gh-command honors GH_REPO and --repo, and reads a link only as a gh argument', () => {
  const refs = (c) => prRefsInCommand(c).map((r) => `${r.repo ?? '-'}#${r.number}${r.repoKnown ? '' : '?'}`);
  assert.deepEqual(refs('GH_REPO=o/r gh pr view 7'), ['o/r#7']);
  assert.deepEqual(refs('GH_REPO="o/r" gh pr view 7'), ['o/r#7'], 'a quoted repository is still that repository');
  assert.deepEqual(refs('export GH_REPO=o/r && gh pr view 7'), ['o/r#7']);
  assert.deepEqual(refs('env GH_REPO=o/r gh pr checks 7'), ['o/r#7']);
  assert.deepEqual(refs('GH_REPO=a/b gh pr view 7 --repo c/d'), ['c/d#7'], '--repo wins over GH_REPO');
  assert.deepEqual(refs('gh pr view 7 -R "o/r"'), ['o/r#7']);
  assert.deepEqual(refs('GH_REPO= gh pr view 7'), ['-#7?'], 'a blank repository names none');
  assert.deepEqual(refs('echo see https://github.com/o/r/pull/5'), [], 'a link after echo acts on nothing');
  assert.deepEqual(refs('open https://github.com/o/r/pull/5 && gh pr list'), []);
  assert.deepEqual(refs('gh pr view https://github.com/o/r/pull/5/files'), ['o/r#5']);
  assert.deepEqual(refs('gh pr comment 9 --body https://github.com/o/r/pull/5'), ['-#9'], "a link as an option's value isn't the pull request acted on");
});

test('parseLookup reads what a person types', () => {
  assert.deepEqual(parseLookup('#64'), { kind: 'pr', owner: null, repo: null, number: 64 });
  assert.deepEqual(parseLookup('your-project#64'), { kind: 'pr', owner: null, repo: 'your-project', number: 64 });
  assert.deepEqual(parseLookup('Example/your-project#64'), { kind: 'pr', owner: 'example', repo: 'your-project', number: 64 });
  assert.deepEqual(parseLookup('https://github.com/example/Your-Project/pull/64/files'), { kind: 'pr', owner: 'example', repo: 'your-project', number: 64 });
  assert.deepEqual(parseLookup('ABCDEF1'), { kind: 'commit', sha: 'abcdef1' });
  assert.deepEqual(parseLookup('lib/replay/index.mjs'), { kind: 'file', path: 'lib/replay/index.mjs' });
  assert.deepEqual(parseLookup('C:\\work\\repo\\a.mjs'), { kind: 'file', path: 'C:\\work\\repo\\a.mjs' });
  assert.deepEqual(parseLookup('feature/widget'), { kind: 'branch', branch: 'feature/widget' });
  assert.deepEqual(parseLookup('branch:release/v1.2'), { kind: 'branch', branch: 'release/v1.2' });
  assert.deepEqual(parseLookup('file:Makefile'), { kind: 'file', path: 'Makefile' });
  assert.equal(parseLookup('what is this?').kind, 'unknown');
});

// ---- reverse lookup -----------------------------------------------------------

test('lookup of a pull request: link and git facts are recorded, its landing and gh commands are inferred', () => {
  const r = h.lookup('#7');
  assert.equal(r.kind, 'pr');
  assert.deepEqual(sessionsOf(r), [k.A, k.Y], 'strongest evidence first; a mention, a refused merge, and private sessions are not included');
  const a = r.sessions[0];
  assert.equal(a.evidence, 'recorded');
  assert.deepEqual(a.refs.map((x) => `${x.via}/${x.evidence}`), ['harness-git-pr/recorded', 'pr-link/recorded', 'pr-landed/inferred']);
  assert.match(a.refs.find((x) => x.via === 'pr-landed').rule, /git\.pr-number-from-subject/);
  assert.deepEqual(r.sessions[1].refs.map((x) => [x.via, x.rule ?? null]), [['pr-link', null], ['gh-pr-command', 'pr.gh-command']]);
  assert.deepEqual(r.goals, ['g-widget']);
  assert.ok(r.notes.some((n) => n.kind === 'any-repository'));
  assert.deepEqual(sessionsOf(h.lookup('your-project#7')), [k.A, k.Y]);
  assert.deepEqual(sessionsOf(h.lookup('https://github.com/example/your-project/pull/7')), [k.A, k.Y]);
  assert.deepEqual(sessionsOf(h.lookup('another-repo#7')), []);
});

test("a pull request's owner is compared when both sides name one", () => {
  // The goal cites a-different-owner/your-project#7 and another-repo#7: neither is the
  // pull request A linked (example/your-project#7) or Y acted on.
  const g = goalOf('g-owners');
  const members = g.members.map((m) => m.session);
  assert.ok(!members.includes(k.A) && !members.includes(k.Y), 'another owner, or another repository, is another pull request');
  const unmatched = g.unmatched.filter((u) => u.kind === 'pr').map((u) => u.ref).sort();
  assert.deepEqual(unmatched, ['a-different-owner/your-project#7', 'another-repo#7']);
  assert.deepEqual(sessionsOf(h.lookup('a-different-owner/your-project#7')), []);
  assert.deepEqual(sessionsOf(h.lookup('example/your-project#7')), [k.A, k.Y]);
});

test('a name with no owner whose matches disagree on the owner is ambiguous, in goals and in lookup', () => {
  const g = goalOf('g-owners');
  assert.deepEqual(g.members.map((m) => m.session), [k.T1, k.T2]);
  for (const m of g.members) {
    assert.equal(m.ambiguous, true, 'its strongest join is ambiguous');
    assert.equal(m.evidence, 'recorded');
    assert.deepEqual(m.joins.map((j) => [j.type, j.ambiguous]), [['cited-pr', { owners: 2 }]]);
  }
  const r = h.lookup('your-project#11');
  assert.deepEqual(sessionsOf(r), [k.T1, k.T2]);
  assert.ok(r.sessions.every((s) => s.ambiguous && s.refs.every((x) => x.ambiguous?.owners === 2)));
  assert.match(r.notes.find((n) => n.kind === 'owners-disagree').text, /2 different owners/);
  const exact = h.lookup('example/your-project#11');
  assert.deepEqual(sessionsOf(exact), [k.T1]);
  assert.equal(exact.sessions[0].ambiguous, undefined);
  assert.ok(!exact.notes.some((n) => n.kind === 'owners-disagree'));
});

test('every pull-request pointer names its repository, so two pull requests 7 are told apart', async () => {
  const r = h.lookup('#7');
  const rows = r.sessions.flatMap((s) => s.refs.map((x) => ({ session: s.session, ...x })));
  assert.ok(rows.length > 0 && rows.every((x) => x.repository && 'owner' in x.repository && 'name' in x.repository), 'every row names a repository, or says which part is unknown');
  const y = rows.filter((x) => x.session === k.Y).map((x) => `${x.via}:${x.repository.owner}/${x.repository.name}`).sort();
  assert.deepEqual(y, ['gh-pr-command:example/your-project', 'pr-link:acme/widget']);
  assert.ok(rows.filter((x) => x.session === k.A).every((x) => x.repository.owner === 'example' && x.repository.name === 'your-project'));
  const text = (await tool(...corpusArgs(), 'lookup', '#7')).out;
  assert.match(text, /pr-link \(recorded\) in acme\/widget/);
  assert.match(text, /gh-pr-command \(inferred, pr\.gh-command\) in example\/your-project/);
  // A pull request found through a commit names its repository too.
  const landed = h.lookup(fx.repo.squashSha.slice(0, 12)).sessions.flatMap((s) => s.refs).filter((x) => x.pr != null);
  assert.ok(landed.length && landed.every((x) => x.repository?.name === 'your-project'));
});

test('a pointer that names no owner is ambiguous for a citation or query that names one', async () => {
  // Without git, a session's repository is named by its configured label, with no owner.
  const noGit = await build({ goals: fx.goalRecord, git: false });
  const r = noGit.lookup('example/your-project#7');
  const by = Object.fromEntries(r.sessions.map((s) => [s.session, s]));
  assert.equal(by[k.A].ambiguous, undefined, "A's own link names the owner");
  assert.deepEqual(by[k.Y].refs.map((x) => x.ambiguous), [{ ownerUnknown: true }]);
  assert.equal(by[k.Y].ambiguous, true);
  assert.ok(r.notes.some((n) => n.kind === 'owner-unknown'));
  const y = noGit.goals.find((g) => g.id === 'g-widget').members.find((m) => m.session === k.Y);
  assert.deepEqual(y.joins.map((j) => [j.type, j.ambiguous]), [['command-on-pr', { ownerUnknown: true }]]);
  assert.equal(y.ambiguous, true);
});

test("worktrees are read from the repository's own files when git isn't run", async () => {
  const noGit = await build({ git: false });
  const group = noGit.lookup('lib/widget.mjs').repositories.find((g) => g.repo === 'your-project');
  assert.ok(group.roots >= 2, 'the configured folder and the worktree');
  assert.ok(group.sessions.some((s) => s.session === k.V), 'the edit made in the worktree is found');
});

test('commands that never ran, ran after a cd, or only echo a link never point at a pull request', () => {
  const r = h.lookup('your-project#7');
  assert.ok(!sessionsOf(r).includes(k.U), 'a rejected gh pr view 7, gh pr view 7 after a cd, and echo of the link');
  assert.deepEqual(sessionsOf(r), [k.A, k.Y]);
});

test("a Codex call's working folder outside the repository names no repository; inside it, it does", () => {
  assert.ok(!sessionsOf(h.lookup('your-project#7')).includes(k.R), 'gh pr view 7 ran in a folder outside the repository');
  assert.deepEqual(sessionsOf(h.lookup('your-project#32')), [k.R], "gh pr checks 32 ran in the repository's own folder");
});

test('GH_REPO names the repository a gh command acts on', () => {
  assert.deepEqual(sessionsOf(h.lookup('other-tool#31')), [k.U]);
  assert.deepEqual(sessionsOf(h.lookup('your-project#31')), [], "GH_REPO named another repository, not the session's");
});

test('commit lookup counts a commit id read from printed output only once git confirmed it', () => {
  const r = h.lookup('dead0be');
  assert.deepEqual(r.sessions, [], "the commit command printed it, but git can't find it");
});

test('lookup of a commit: harness records, git outcomes, a 12-character prefix, and a squash subject', () => {
  const full = h.lookup(fx.repo.featureSha);
  assert.deepEqual(sessionsOf(full), [k.A]);
  assert.deepEqual(full.sessions[0].refs.map((x) => `${x.via}/${x.evidence}`), ['commit-exists/recorded', 'harness-commit/recorded']);

  const squash = h.lookup(fx.repo.squashSha.slice(0, 12));
  const by = Object.fromEntries(squash.sessions.map((s) => [s.session, s]));
  assert.deepEqual(Object.keys(by).sort(), [k.A, k.P, k.Y].sort());
  const p = by[k.P].refs.find((x) => x.via === 'commit-exists');
  assert.equal(p.evidence, 'inferred', 'the Codex commit was read from printed output');
  assert.equal(p.rule, 'shell.git-commit-output');
  assert.ok(by[k.A].refs.some((x) => x.via === 'pr-landed' && x.pr === 7));
  const viaSquash = by[k.Y].refs.find((x) => x.via === 'squash-subject');
  assert.equal(viaSquash.evidence, 'inferred');
  assert.match(viaSquash.rule, /^pr\.squash-subject/);
  assert.equal(viaSquash.pr, 7);
  assert.ok(squash.notes.some((n) => n.kind === 'squash-subject' && n.pr === 7));
});

test('lookup never reads a display-role repository, even for a commit whose subject names a pull request', () => {
  const r = h.lookup(fx.displaySquashSha);
  assert.deepEqual(r.sessions, []);
  assert.ok(!r.notes.some((n) => n.kind === 'squash-subject'), 'the (#9) subject was never read');
  assert.deepEqual(sessionsOf(h.lookup('#9')), []);
});

test('lookup of a relative file path searches each repository and lists the results per repository', () => {
  const r = h.lookup('lib/widget.mjs');
  assert.equal(r.kind, 'file');
  const groups = Object.fromEntries(r.repositories.map((g) => [g.repo, g]));
  assert.deepEqual(Object.keys(groups).sort(), ['your-project', 'your-project-fork']);
  assert.deepEqual(groups['your-project'].sessions.map((s) => s.session).sort(), [k.A, k.V].sort(), 'the main checkout and its worktree');
  assert.deepEqual(groups['your-project-fork'].sessions.map((s) => s.session), [k.T2], 'the same path in another repository is its own group');
  assert.ok(groups['your-project'].roots >= 2);
  assert.deepEqual(r.sessions.map((s) => `${s.repo}:${s.session}`).sort(), [`your-project:${k.A}`, `your-project:${k.V}`, `your-project-fork:${k.T2}`].sort(), 'each row names its repository');
  const a = groups['your-project'].sessions.find((s) => s.session === k.A);
  assert.deepEqual(a.refs.map((x) => x.via).sort(), ['edit', 'read'], 'the edit, and the reviewer sub-agent reading it');
  assert.ok(r.sessions.every((s) => s.evidence === 'recorded'));
  assert.ok(!JSON.stringify(r).includes(fx.root.replace(/\\/g, '/')) && !JSON.stringify(r).includes(fx.root), 'no folder path in the output');
});

test("an absolute file path resolves to the one repository holding it, and a session's subfolder is never a root", () => {
  const abs = h.lookup(join(fx.worktreeDir, 'lib', 'widget.mjs'));
  assert.deepEqual(abs.repositories.map((g) => g.repo), ['your-project']);
  assert.deepEqual(sessionsOf(abs).sort(), [k.A, k.V].sort(), 'an absolute path in one worktree finds the other too, and nothing in the other repository');
  const fork = h.lookup(join(fx.forkDir, 'lib', 'widget.mjs'));
  assert.deepEqual(fork.repositories.map((g) => g.repo), ['your-project-fork']);
  assert.deepEqual(sessionsOf(fork), [k.T2]);
  // T1 worked from the repository's lib/ folder; that folder is not a root, so a bare
  // file name doesn't reach lib/widget.mjs.
  assert.deepEqual(h.lookup('widget.mjs').sessions, []);
  const outside = h.lookup(join(fx.root, 'nowhere', 'widget.mjs'));
  assert.deepEqual(outside.sessions, []);
  assert.ok(outside.notes.some((n) => n.kind === 'outside-every-repository'));
});

test('lookup of a file: an external edit, and a path no session touched', () => {
  assert.deepEqual(sessionsOf(h.lookup('docs/notes.md')), [k.A]);
  assert.equal(h.lookup('docs/notes.md').sessions[0].refs[0].via, 'external-edit');
  const none = h.lookup('lib/never.mjs');
  assert.deepEqual(none.sessions, []);
  assert.ok(none.notes.some((n) => n.kind === 'file-not-found' && /deleted/.test(n.text)));
});

test('lookup of a branch: the harness recorded the push and the worktree branch', () => {
  const r = h.lookup('feature/wt');
  assert.deepEqual(sessionsOf(r), [k.V]);
  assert.deepEqual(r.sessions[0].refs.map((x) => `${x.via}/${x.evidence}`), ['push/recorded', 'worktree/recorded']);
  assert.deepEqual(h.lookup('branch:feature/nothing').sessions, []);
});

// ---- one pull-request number in two repositories that share a name -------------
//
// One session links pull request 7 in alice/your-project and in bob/your-project, then
// runs gh pr view 7 against each. Those are two pull requests, so the lookup gives each
// repository its own row and the goal gives each its own join, never one row or one
// join counted twice. The session is its own small log, read with the shared corpus's
// config (its folder is the configured your-project) and without git, so nothing else
// joins in.

let twoOwnersBuilt = null;
function twoOwners() {
  twoOwnersBuilt ??= (async () => {
    const id = '3a3a3a3a-1111-4111-8111-0000000000c1';
    const dirName = 'proj-owners';
    let n = 0;
    const rec = (type, ts, extra) => JSON.stringify({ type, sessionId: id, cwd: fx.repo.dir, version: '2.1.0', uuid: `${id}-o${++n}`, timestamp: ts, ...extra });
    const link = (owner, minute) => JSON.stringify({ type: 'pr-link', sessionId: id, prNumber: 7, prUrl: `https://github.com/${owner}/your-project/pull/7`, prRepository: `${owner}/your-project`, timestamp: at(minute) });
    const ghView = (owner, minute) => [
      rec('assistant', at(minute), { message: { id: `m-${owner}`, model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id: `tu-${owner}`, name: 'Bash', input: { command: `gh pr view 7 -R ${owner}/your-project` } }] } }),
      rec('user', at(minute, 500), { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${owner}`, content: 'open' }] }, toolUseResult: { stdout: 'open', stderr: '', interrupted: false } }),
    ];
    const lines = [
      rec('user', at(500), { message: { role: 'user', content: 'Open pull request 7 upstream and on the fork.' }, origin: { kind: 'human' } }),
      link('alice', 501),
      link('bob', 502),
      ...ghView('alice', 503),
      ...ghView('bob', 504),
    ];
    const claudeRoot = join(fx.root, 'claude-two-owners');
    mkdirSync(join(claudeRoot, dirName), { recursive: true });
    writeFileSync(join(claudeRoot, dirName, `${id}.jsonl`), `${lines.join('\n')}\n`);
    const goals = { goals: [{ id: 'g-both', title: 'Land pull request 7 on both', state: 'active', source: 'your-project#7' }] };
    const history = await buildWorkHistory({ config: fx.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [claudeRoot], codex: [] }, git: false, goals });
    return { history, key: claudeSessionKey(dirName, id) };
  })();
  return twoOwnersBuilt;
}
const repositoryOf = (x) => `${x.owner}/${x.name}`;

test('lookup: one session pointing at pull request 7 in two repositories the same way gets one row per repository', async () => {
  const { history, key } = await twoOwners();
  const r = history.lookup('#7');
  assert.deepEqual(sessionsOf(r), [key]);
  assert.deepEqual(r.sessions[0].refs.map((x) => [x.via, x.evidence, repositoryOf(x.repository), x.count]), [
    ['pr-link', 'recorded', 'alice/your-project', 1],
    ['pr-link', 'recorded', 'bob/your-project', 1],
    ['gh-pr-command', 'inferred', 'alice/your-project', 1],
    ['gh-pr-command', 'inferred', 'bob/your-project', 1],
  ]);
  // Named without its owner, every pointer is ambiguous, and still one row per repository.
  const named = history.lookup('your-project#7');
  assert.deepEqual(sessionsOf(named), [key]);
  assert.equal(named.sessions[0].ambiguous, true);
  assert.deepEqual(named.sessions[0].refs.map((x) => [x.via, repositoryOf(x.repository), x.count, x.ambiguous]), [
    ['pr-link', 'alice/your-project', 1, { owners: 2 }],
    ['pr-link', 'bob/your-project', 1, { owners: 2 }],
    ['gh-pr-command', 'alice/your-project', 1, { owners: 2 }],
    ['gh-pr-command', 'bob/your-project', 1, { owners: 2 }],
  ]);
});

test('goals: a citation with no owner that matches two owners from one session gets one join per owner', async () => {
  const { history, key } = await twoOwners();
  const g = history.goals.find((x) => x.id === 'g-both');
  assert.deepEqual(g.members.map((m) => m.session), [key]);
  assert.deepEqual(g.unmatched, []);
  const m = g.members[0];
  assert.equal(m.ambiguous, true, 'which owner the goal meant is open');
  assert.deepEqual(m.joins.map((j) => [j.type, j.evidence, repositoryOf(j.detail.repository), j.count, j.ambiguous]), [
    ['cited-pr', 'recorded', 'alice/your-project', 1, { owners: 2 }],
    ['cited-pr', 'recorded', 'bob/your-project', 1, { owners: 2 }],
    ['command-on-pr', 'inferred', 'alice/your-project', 1, { owners: 2 }],
    ['command-on-pr', 'inferred', 'bob/your-project', 1, { owners: 2 }],
  ]);
});

// ---- the developer tool ---------------------------------------------------------

async function tool(...args) {
  let out = '';
  let err = '';
  const code = await inspect(args, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}
const corpusArgs = () => ['--config', fx.configFile, '--from', '2024-06-10', '--to', '2024-06-16', '--claude-root', fx.claudeRoot, '--codex-root', fx.codexRoot];

test('the tool prints goals, one goal, and lookups, in text and JSON, without leaking', async () => {
  const goals = await tool(...corpusArgs(), '--goals', fx.goalsFile, 'goals', '--json');
  assert.equal(goals.code, 0);
  assert.deepEqual(JSON.parse(goals.out).map((g) => g.id), ['g-widget', 'g-docs', 'g-owners']);
  const one = JSON.parse((await tool(...corpusArgs(), '--goals', fx.goalsFile, 'goal', 'g-widget', '--json')).out);
  assert.ok(one.members.length >= 5 && one.unmatched.length >= 3);
  const look = JSON.parse((await tool(...corpusArgs(), '--goals', fx.goalsFile, 'lookup', 'your-project#7', '--json')).out);
  assert.deepEqual(look.goals, ['g-widget']);
  const texts = [];
  for (const args of [['goals'], ['goal', 'g-widget'], ['lookup', '#7'], ['lookup', 'lib/widget.mjs'], ['lookup', fx.repo.squashSha.slice(0, 12)]]) {
    const r = await tool(...corpusArgs(), '--goals', fx.goalsFile, ...args);
    assert.equal(r.code, 0, args.join(' '));
    assert.ok(r.out.trim(), args.join(' '));
    texts.push(r.out);
  }
  assert.match(texts[1], /rule: A prompt, typed or delivered mid-turn/);
  for (const text of texts) for (const banned of [CODENAME, ME, fx.root]) assert.ok(!text.includes(banned), `output leaks ${banned}`);
});

test('the tool says what to do next when something is missing or wrong', async () => {
  const noGoals = await tool(...corpusArgs(), 'goals');
  assert.equal(noGoals.code, 1);
  assert.match(noGoals.err, /needs a goal record\. Pass --goals <file>/);
  assert.match(noGoals.err, /--demo/);
  const unknownGoal = await tool(...corpusArgs(), '--goals', fx.goalsFile, 'goal', 'g-nope');
  assert.equal(unknownGoal.code, 1);
  assert.match(unknownGoal.err, /Run "goals" to list the ids/);
  const empty = await tool(...corpusArgs(), 'lookup');
  assert.equal(empty.code, 1);
  assert.match(empty.err, /such as #64/);
  const vague = await tool(...corpusArgs(), 'lookup', 'what is this?');
  assert.equal(vague.code, 1);
  assert.match(vague.out, /Try #64/);
  const badFile = join(fx.root, 'not-json.json');
  (await import('node:fs')).writeFileSync(badFile, '{ not json');
  const bad = await tool(...corpusArgs(), '--goals', badFile, 'goals');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /isn't valid JSON\. It should hold a goal record shaped like/);
  const missing = await tool(...corpusArgs(), '--goals', join(fx.root, 'nowhere.json'), 'goals');
  assert.match(missing.err, /couldn't read the --goals file \(ENOENT\)\. Check the path/);
  const noLogs = await tool('goals');
  assert.equal(noLogs.code, 1);
  assert.match(noLogs.err, /--demo to try it on made-up logs/);
  let help = '';
  await inspect(['--help'], { out: (s) => (help += s), err: () => {} });
  for (const word of ['goals', 'goal <id>', 'lookup <text>', '--goals <file>', '--demo']) assert.ok(help.includes(word), `help names ${word}`);
});

test('--demo runs the goal and lookup commands on made-up logs with no config', async () => {
  const goals = await tool('--demo', 'goals', '--json');
  assert.equal(goals.code, 0);
  assert.deepEqual(JSON.parse(goals.out).map((g) => g.id), ['g-widget', 'g-docs', 'g-owners']);
  const look = await tool('--demo', 'lookup', '#7');
  assert.equal(look.code, 0);
  assert.match(look.out, /2 readable session\(s\)/);
});

test('lookup without a goal record leaves goals empty; an unreadable query says what to try', async () => {
  const plain = await build();
  assert.deepEqual(plain.lookup('#7').goals, []);
  assert.deepEqual(sessionsOf(plain.lookup('#7')), [k.A, k.Y]);
  const bad = h.lookup('what is this?');
  assert.equal(bad.kind, 'unknown');
  assert.match(bad.notes[0].text, /Try #64/);
  const noGit = await build({ git: false });
  assert.ok(noGit.lookup(fx.repo.squashSha.slice(0, 12)).notes.some((n) => n.kind === 'git-not-read'));
});
