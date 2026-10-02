// Goal membership (which sessions did one goal's work, and how each link is known) and
// reverse lookup (which sessions worked on a pull request, commit, file, or branch),
// over the synthetic corpus's goal sessions (test/fixtures/replay/corpus.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkHistory, parseLookup } from '../lib/replay/index.mjs';
import { RULES, prRefsInCommand } from '../lib/replay/classify.mjs';
import { goalCitations } from '../lib/replay/goals.mjs';
import { createWatch } from '../lib/replay/parse-common.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { buildCorpus, CODENAME, ME } from './fixtures/replay/corpus.mjs';
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
after(() => {
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    /* Windows can hold a lock on .git briefly */
  }
});

// ---- goal membership --------------------------------------------------------

test('every new rule is registered with a plain description', () => {
  for (const id of ['pr.gh-command', 'pr.squash-subject', 'goal.prompt-names-id']) {
    assert.ok(RULES.has(id), id);
    assert.ok(RULES.get(id).length > 40, `${id} says what it reads`);
  }
  for (const g of h.goals) for (const m of g.members) for (const j of m.joins) if (j.rule) assert.ok(RULES.has(j.rule), j.rule);
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

test('members are ordered by first record, each with its strongest join first', () => {
  const g = goalOf('g-widget');
  const order = g.members.map((m) => m.session);
  assert.deepEqual(order, [k.A, k.P, k.W, k.Z, k.Y, k.R]);
  for (const m of g.members) assert.equal(m.evidence, m.joins[0].evidence);
  assert.equal(memberOf(g, k.Z).evidence, 'derived');
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
  assert.ok(view.members.flatMap((m) => m.joins).filter((j) => j.rule).every((j) => j.ruleText === RULES.get(j.rule)));
  assert.equal(h.goal('g-nope'), null);
});

test('additive: without a goal record the history is unchanged, with no goals key', async () => {
  const without = await build();
  const undef = await build({ goals: undefined });
  assert.equal(JSON.stringify(without), JSON.stringify(undef));
  assert.ok(!('goals' in without.toJSON()));
  assert.equal(without.goal('g-widget'), null);
  // The parse-time scan adds side notes, never facts: everything but `goals` is identical.
  const { goals, ...rest } = h.toJSON();
  assert.ok(goals.length === 2);
  assert.equal(JSON.stringify(rest), JSON.stringify(without.toJSON()));
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

test('goal citations: links, repo#N, session and commit markers, bare commit ids; words are kept apart', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const cites = goalCitations({
    source: 'https://github.com/example/your-project/pull/64',
    observations: ['see your-project#64 again', 'and owner/other#3', { note: `in session:aaaaaaaa-1111-4111-8111-000000000001.` }, 'a session: in prose is not a marker', 'session:yesterday afternoon'],
    results: [`commit:${sha.slice(0, 9)}`, sha, 'commit:the big one', 'issue#5x', '#12 alone'],
  });
  assert.deepEqual(cites.map((c) => c.kind), ['pr', 'pr', 'session', 'session-words', 'commit', 'commit', 'commit-words']);
  assert.equal(cites[0].where, 'source');
  assert.equal(cites[1].repo, 'other');
  assert.equal(cites[2].where, 'observations[2].note');
  assert.equal(cites[2].id, 'aaaaaaaa-1111-4111-8111-000000000001');
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

test('parseLookup reads what a person types', () => {
  assert.deepEqual(parseLookup('#64'), { kind: 'pr', repo: null, number: 64 });
  assert.deepEqual(parseLookup('your-project#64'), { kind: 'pr', repo: 'your-project', number: 64 });
  assert.deepEqual(parseLookup('https://github.com/example/Your-Project/pull/64/files'), { kind: 'pr', repo: 'your-project', number: 64 });
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
  assert.deepEqual(r.sessions[1].refs.map((x) => [x.via, x.rule]), [['gh-pr-command', 'pr.gh-command']]);
  assert.deepEqual(r.goals, ['g-widget']);
  assert.ok(r.notes.some((n) => n.kind === 'any-repository'));
  assert.deepEqual(sessionsOf(h.lookup('your-project#7')), [k.A, k.Y]);
  assert.deepEqual(sessionsOf(h.lookup('https://github.com/example/your-project/pull/7')), [k.A, k.Y]);
  assert.deepEqual(sessionsOf(h.lookup('another-repo#7')), []);
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

test('lookup of a file resolves one repo-relative path across every worktree it was edited from', () => {
  const r = h.lookup('lib/widget.mjs');
  assert.equal(r.kind, 'file');
  assert.deepEqual(sessionsOf(r).sort(), [k.A, k.V].sort());
  const a = r.sessions.find((s) => s.session === k.A);
  assert.deepEqual(a.refs.map((x) => x.via).sort(), ['edit', 'read'], 'the edit, and the reviewer sub-agent reading it');
  assert.ok(r.sessions.every((s) => s.evidence === 'recorded'));
  const tried = r.notes.find((n) => n.kind === 'roots-tried');
  assert.ok(tried.count >= 2, 'the main checkout and the worktree');
  assert.ok(!JSON.stringify(r).includes(fx.root.replace(/\\/g, '/')) && !JSON.stringify(r).includes(fx.root), 'no folder path in the output');
  const abs = h.lookup(join(fx.worktreeDir, 'lib', 'widget.mjs'));
  assert.deepEqual(sessionsOf(abs).sort(), [k.A, k.V].sort(), 'an absolute path in one worktree finds the other too');
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
  assert.deepEqual(JSON.parse(goals.out).map((g) => g.id), ['g-widget', 'g-docs']);
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
  assert.deepEqual(JSON.parse(goals.out).map((g) => g.id), ['g-widget', 'g-docs']);
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
