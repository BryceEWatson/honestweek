// Picking out one pull request's steps (lib/review/scope.mjs) in a session that worked on
// several. The shared fixture's author session works on pull requests 20 and 21 from the main
// checkout, reaching each worktree with `cd`, and records only `main`; the cases its shape
// can't show are built by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { resolvePr } from '../lib/review/resolve.mjs';
import { branchMade, branchSwitched, commandFolder, folderAt, quotedCommands, scopeSteps } from '../lib/review/scope.mjs';
import { BRIEF_RULES } from '../lib/review/rules.mjs';
import { writeReviewLogs, WINDOW } from './fixtures/replay/review-pr.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const fx = writeReviewLogs(makeTempDir('hw-scope-'));
const h = await buildWorkHistory({ config: fx.config, ...WINDOW, roots: fx.roots, keepRaw: true, usage: true, hiddenSessions: 'redacted' });
const scope = (query, extra = {}) => {
  const pr = resolvePr({ h, config: fx.config, query, ...extra });
  return { pr, sc: scopeSteps({ h, pr, repoPath: fx.repo }) };
};
const authorSteps = h.events.filter((e) => e.session === fx.key.author);
const stepBy = (text) => authorSteps.find((e) => String(e._command ?? e.facts?.text ?? '').includes(text));
const where = (sc, e) => (sc.inScope.has(e.id) ? 'in' : sc.ambiguous.has(e.id) ? 'ambiguous' : 'out');

test('the cd-between-worktrees split: each pull request gets its own steps, never the other\'s', () => {
  const a = scope('#20').sc;
  const b = scope('#21').sc;
  for (const e of authorSteps) assert.ok(!(a.inScope.has(e.id) && b.inScope.has(e.id)), `${e.id} is in both`);
  // Pull request 20's work, though every record says main.
  for (const t of ['git worktree add .claude/worktrees/pr-20', 'git commit -am "Stream the parser input"', 'git push -u origin feature/stream', 'gh pr checks 20', 'Done. Pull request 20 is open', 'gh pr merge 20']) {
    assert.equal(where(a, stepBy(t)), 'in', t);
    assert.equal(where(b, stepBy(t)), 'out', t);
  }
  // Pull request 21's, including its commit after the failed test run.
  for (const t of ['git worktree add .claude/worktrees/pr-21', 'node --test', 'git commit -am "Report parser errors']) {
    const e = t === 'node --test' ? authorSteps.filter((x) => String(x._command).includes('node --test')).at(-1) : stepBy(t);
    assert.equal(where(b, e), 'in', t);
    assert.equal(where(a, e), 'out', t);
  }
  // The edits are tied by the worktree their file is in.
  const edits = authorSteps.filter((e) => e.facts?.category === 'edit');
  assert.deepEqual(edits.map((e) => where(a, e)), ['in', 'in', 'in', 'out', 'out']);
  assert.deepEqual(edits.map((e) => where(b, e)), ['out', 'out', 'out', 'in', 'in']);
  // Excluded steps are counted by the lane they belong to.
  const row = a.sessions.find((s) => s.key === fx.key.author);
  assert.equal(row.role, 'author');
  assert.equal(row.in + row.ambiguous + row.excluded, row.steps);
  assert.equal(row.steps, authorSteps.length);
  assert.ok(row.lanes.some((l) => l.lane === 'pull request #21'));
  assert.equal(row.lanes.reduce((n, l) => n + l.steps, 0), row.excluded);
});

test('the closed issue\'s opening steps are in; an issue the pull request only names isn\'t', () => {
  const { sc } = scope('#20');
  assert.equal(where(sc, stepBy('Work on issue 19')), 'in');
  assert.equal(where(sc, stepBy('gh issue view 19')), 'in');
  // Pull request 21 closes nothing (it names #19 and #30): its prompt naming issue 30 ties nothing.
  const p21 = scope('#21').sc;
  assert.equal(where(p21, stepBy('gh issue view 19')), 'out');
  assert.equal(where(p21, stepBy('Merge it, then do issue 30')), 'out');
  // Told it closes #30, the prompt naming it is still out: it sits among pull request 20's steps,
  // and an issue anchor alone never puts a step in scope.
  assert.equal(where(scope('#21', { issue: 30 }).sc, stepBy('Merge it, then do issue 30')), 'out');
});

test('a final message after work on two pull requests is ambiguous, never counted as either\'s', () => {
  const b = scope('#21').sc;
  const last = stepBy('All done: tests pass');
  assert.equal(where(b, last), 'ambiguous');
  assert.equal(b.why.get(last.id).rule, 'brief.boundary');
  assert.equal(where(scope('#20').sc, last), 'out');
});

test('a review run started by a step in scope is in whole, and a reader only by its own pointer', () => {
  const { sc } = scope('#20');
  const rev = sc.sessions.find((s) => s.key === fx.key.review);
  assert.deepEqual({ role: rev.role, steps: rev.steps, in: rev.in, rule: rev.roleRule }, { role: 'review', steps: 5, in: 5, rule: 'brief.review-session' });
  assert.equal(rev.launchedBy.event, stepBy('claude -p --session-id').id);
  const reader = sc.sessions.find((s) => s.key === fx.key.reader);
  assert.equal(reader.role, 'mentioned');
  assert.equal(reader.in, 1);
  // The review run belongs to pull request 20: started by its step, on its branch. Not 21's.
  assert.ok(!scope('#21').sc.sessions.some((s) => s.key === fx.key.review));
  // The author is listed first, then reviews, then the rest.
  assert.deepEqual(sc.sessions.map((s) => s.role), ['author', 'review', 'mentioned']);
});

test('a Codex session is scoped by each command\'s workdir', () => {
  const { sc } = scope('#22');
  const row = sc.sessions.find((s) => s.key === fx.key.codex);
  assert.equal(row.role, 'author');
  const cx = h.events.filter((e) => e.session === fx.key.codex && e.kind === 'action');
  assert.ok(cx.length === 4 && cx.every((e) => sc.inScope.has(e.id)));
  // None of its steps are pull request 20's.
  const a = scope('#20').sc;
  assert.ok(!h.events.some((e) => e.session === fx.key.codex && a.inScope.has(e.id)));
});

test('every scope rule a step names is a brief rule', () => {
  for (const q of ['#20', '#21', '#22']) {
    const { sc } = scope(q);
    for (const w of sc.why.values()) {
      for (const r of w.rule.split(', ')) assert.ok(BRIEF_RULES.has(r), r);
      assert.equal(w.evidence, 'inferred', 'which pull request a step was is always a reading');
    }
  }
});

test('the command readers: a folder, a cd, a branch made', () => {
  assert.equal(folderAt('C:\\work\\repo', '.claude/worktrees/pr-1'), 'c:/work/repo/.claude/worktrees/pr-1');
  assert.equal(folderAt('/work/repo/sub', '../other'), '/work/repo/other');
  assert.equal(folderAt('/work/repo', '/abs/x'), '/abs/x');
  assert.equal(folderAt(null, 'rel'), null);
  assert.equal(commandFolder('cd "../a b" && git push'), '../a b');
  assert.equal(commandFolder('git -C wt/x log'), 'wt/x');
  assert.equal(commandFolder('git status && cd x'), null, 'only a leading cd moves the whole command');
  assert.deepEqual(branchMade('git worktree add ../wt -b feature/x'), { branch: 'feature/x', path: '../wt' });
  assert.deepEqual(branchMade('git worktree add ../wt existing'), { branch: 'existing', path: '../wt' });
  assert.deepEqual(branchMade('git switch -c feature/y'), { branch: 'feature/y', path: null });
  assert.equal(branchMade('git switch main'), null);
  // A quoted path or branch is read whole, as the shell reads it.
  assert.deepEqual(branchMade('git worktree add "C:/My Work/wt one" -b feature/x'), { branch: 'feature/x', path: 'C:/My Work/wt one' });
  assert.deepEqual(branchMade("cd repo && git worktree add '../wt two' -b 'feature/y'"), { branch: 'feature/y', path: '../wt two' });
  assert.deepEqual(branchMade('git -C "a b" worktree add wt -b feature/z'), { branch: 'feature/z', path: 'wt' });
  // A line with a heredoc is still read, the engine's way.
  assert.deepEqual(branchMade("git worktree add wt -b feature/h && cat <<'EOF'\nnotes\nEOF"), { branch: 'feature/h', path: 'wt' });
  assert.deepEqual(quotedCommands('a "b c" && d \'e\'; f|g'), [['a', 'b c'], ['d', 'e'], ['f'], ['g']]);
  assert.equal(branchMade('git worktree add ../wt origin/main'), null, 'a remote-tracking start point is no branch');
  assert.equal(branchMade('git worktree add --detach ../wt feature/x'), null);
  // A variable setting, an env word, a subshell or a redirection still leaves the command read.
  assert.deepEqual(branchMade('MSYS_NO_PATHCONV=1 git worktree add ../wt -b feature/x'), { branch: 'feature/x', path: '../wt' });
  assert.deepEqual(branchMade('A=1 env git switch -c feature/y'), { branch: 'feature/y', path: null });
  assert.deepEqual(branchMade('(cd /r && git switch -c feat)'), { branch: 'feat', path: null });
  assert.deepEqual(branchMade('git worktree add ../wt -b feature/x 2>&1 | tail -3'), { branch: 'feature/x', path: '../wt' });
  assert.deepEqual(branchMade('git worktree add ../wt 2>&1'), null);
  assert.deepEqual(branchMade('git -C "/my dir" switch -c feat'), { branch: 'feat', path: null });
  // Beside a command substitution, a quoted path is unread, never a path named "".
  assert.equal(branchMade('git worktree add "$(pwd)/wt" -b feature/x'), null);
});

// ---- by hand: what the fixture's shape can't show --------------------------------------------------

/** A history holding only what scopeSteps reads: one repository, sessions, events and pointers. */
function handHistory({ sessions, events, prRefs = [], commitRefs = [], branchRefs = [], links = [] }) {
  const hh = { sessions, events, links };
  Object.defineProperty(hh, '_refIndex', { value: () => ({ prRefs, commitRefs, branchRefs, fileRefs: [] }) });
  Object.defineProperty(hh, '_sessionRepo', { value: () => 'r' });
  Object.defineProperty(hh, '_repoRoots', { value: () => ['/w/r'] });
  return hh;
}
const pr9 = { number: 9, display: false, repo: { label: 'r' }, sessions: ['s'], branch: { name: 'feature/nine' }, issues: { closes: [{ number: 5 }] }, files: { list: [{ path: 'lib/a.mjs' }] }, commits: { list: [], evidence: 'missing' } };
let n = 0;
const ev = (kind, extra = {}) => {
  const e = { id: `s.${++n}.0`, session: 's', kind, t: n, turn: 't1', facts: extra.facts ?? {}, inferred: [] };
  if (extra.command) Object.defineProperty(e, '_command', { value: extra.command });
  if (extra.cwd) Object.defineProperty(e, '_lineCwd', { value: extra.cwd });
  if (extra.file) Object.defineProperty(e, '_raw', { value: { input: { file_path: extra.file } } });
  if (extra.branch) Object.defineProperty(e, '_lineBranch', { value: extra.branch });
  if (extra.turn) e.turn = extra.turn;
  return e;
};

test('a file anchor or an issue anchor alone never puts a step in scope', () => {
  const steps = [ev('prompt', { facts: { text: 'Look at issue 5.' } }), ev('action', { facts: { category: 'edit' }, file: '/w/r/lib/a.mjs', cwd: '/w/r' }), ev('message', { facts: { text: 'Edited it.' } })];
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: steps }), pr: pr9, git: false });
  assert.equal(sc.inScope.size, 0);
  // Failing-path partner: a push to its branch in the same stretch ties them all in.
  const push = ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine', cwd: '/w/r' });
  const sc2 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [...steps, push] }), pr: pr9, git: false });
  assert.deepEqual([...steps, push].map((e) => sc2.inScope.has(e.id)), [true, true, true, true]);
});

test('one command that pushes two pull requests\' branches is ambiguous', () => {
  const both = ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine && git push origin feature/ten', cwd: '/w/r' });
  // pushedBranch reads the first push only, so the second branch comes from a recorded push.
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [both], branchRefs: [] }), pr: pr9, git: false });
  assert.equal(sc.inScope.has(both.id), true, 'one push it can read');
  const made = ev('action', { facts: { category: 'shell' }, command: 'git worktree add /w/wt9 -b feature/nine', cwd: '/w/r' });
  const two = ev('action', { facts: { category: 'shell', git: { push: { branch: 'feature/ten' } } }, command: 'cd /w/wt9 && git push origin feature/ten', cwd: '/w/r' });
  const sc2 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [made, two] }), pr: pr9, git: false });
  assert.equal(sc2.ambiguous.has(two.id), true, "a push to another branch from this pull request's folder");
});

test('a saved session is scoped by its pointers only, and the brief says so', () => {
  const ask = ev('prompt', { facts: { text: 'Do issue 5.' }, turn: 'a' });
  const said = ev('message', { facts: { text: 'On it.' }, turn: 'b' });
  const commit = ev('message', { facts: { text: 'Committed.' }, turn: 'b' });
  const other = ev('message', { facts: { text: 'x' }, turn: 'c' });
  const events = [ask, said, commit, other];
  const pr = { ...pr9, commits: { list: [{ sha: 'abcdef1234567' }], evidence: 'recorded' } };
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's', saved: { at: '2024-06-11', log: 'gone' } }], events, commitRefs: [{ session: 's', event: commit, sha: 'abcdef1234567', via: 'harness-commit' }] }), pr, git: false });
  assert.equal(sc.sessions[0].saved, true);
  assert.equal(sc.sessions[0].role, 'author');
  assert.ok(sc.notes.some((x) => x.kind === 'saved-sessions'));
  // The commit's turn is in; the prompt naming its issue ties nothing in a saved session.
  assert.deepEqual(events.map((e) => where(sc, e)), ['out', 'in', 'in', 'out']);
});

test('a display-only pull request scopes nothing, and reads neither the history nor git', () => {
  const untouchable = new Proxy({}, { get: (_, k) => { throw new Error(`read ${String(k)}`); } });
  const sc = scopeSteps({ h: untouchable, pr: { ...pr9, display: true }, repoPath: makeTempDir('hw-scope-display-') });
  assert.deepEqual([sc.inScope.size, sc.sessions.length], [0, 0]);
});

test("the issue opening stops at another pull request's step, and never takes it", () => {
  const steps = [
    ev('prompt', { facts: { text: 'Look at issue 5.' } }),
    ev('action', { facts: { category: 'shell' }, command: 'gh issue view 5', cwd: '/w/r', branch: 'main' }),
    ev('action', { facts: { category: 'shell' }, command: 'gh pr view 21', cwd: '/w/r', branch: 'main' }),
    ev('message', { facts: { text: 'Now nine.' }, turn: 't2' }),
    ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine', cwd: '/w/r', branch: 'main', turn: 't2' }),
  ];
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: steps, prRefs: [{ session: 's', event: steps[2], number: 21 }] }), pr: pr9, git: false });
  assert.deepEqual(steps.map((e) => where(sc, e)), ['in', 'in', 'out', 'ambiguous', 'in']);
  assert.equal(sc.laneOf(steps[2].id), 'pull request #21');
});

test("a folder's branch isn't read back past the branch being made there, nor from a command that never ran", () => {
  const before = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt && npm test', cwd: '/w/r', turn: 't0' });
  const sw = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt && git switch -c feature/nine', cwd: '/w/r' });
  const after = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt && npm test', cwd: '/w/r' });
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [before, sw, after] }), pr: pr9, git: false });
  assert.deepEqual([before, sw, after].map((e) => where(sc, e)), ['out', 'in', 'in']);
  // A refused switch to this branch leaves the folder on the one it was made with.
  const made = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt2 && git switch -c feature/ten', cwd: '/w/r' });
  const refused = ev('action', { facts: { category: 'shell', result: 'rejected' }, command: 'cd /w/wt2 && git checkout -b feature/nine', cwd: '/w/r' });
  const later = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt2 && npm test', cwd: '/w/r' });
  const sc2 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [made, refused, later] }), pr: pr9, git: false });
  assert.equal(where(sc2, later), 'out');
  assert.equal(sc2.laneOf(later.id), 'folder on branch feature/ten');
  // A plain switch to a branch that already exists ends the backward read too.
  const early = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt3 && npm run build', cwd: '/w/r', turn: 't0' });
  const plain = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt3 && git switch feature/nine', cwd: '/w/r', turn: 't2' });
  const sent = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt3 && git push origin feature/nine', cwd: '/w/r', turn: 't3' });
  const sc3 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [early, plain, sent] }), pr: pr9, git: false });
  assert.deepEqual([early, plain, sent].map((e) => where(sc3, e)), ['out', 'in', 'in']);
  assert.equal(branchSwitched('git switch feature/nine'), 'feature/nine');
  assert.equal(branchSwitched('git checkout README.md'), null, "a file's name is no branch");
  assert.equal(branchSwitched('git switch -'), null);
  // A detached checkout is on no branch, and a quoted word is read whole or not at all.
  assert.equal(branchSwitched('git checkout abc1234'), null);
  assert.equal(branchSwitched('git checkout origin/main'), null);
  assert.equal(branchSwitched('git switch "feature/nine"'), 'feature/nine');
  assert.equal(branchSwitched("git checkout 'src/a b.js'"), null);
  assert.equal(branchSwitched('git checkout "$(git rev-parse --abbrev-ref HEAD)"'), null);
  // A switch that failed leaves the folder where it was.
  const pushed = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt4 && git push origin feature/ten', cwd: '/w/r', turn: 't0' });
  const failed = ev('action', { facts: { category: 'shell', result: 'error' }, command: 'cd /w/wt4 && git switch feature/nine', cwd: '/w/r', turn: 't1' });
  const work = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt4 && npm test', cwd: '/w/r', turn: 't2' });
  const sc4 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [pushed, failed, work] }), pr: pr9, git: false });
  assert.equal(where(sc4, work), 'out');
  assert.equal(sc4.laneOf(work.id), 'folder on branch feature/ten');
});

test("another repository's pull request with the same number is another lane", () => {
  const theirs = ev('action', { facts: { category: 'shell' }, command: 'gh pr view 9 -R someone/else', cwd: '/w/r', branch: 'main', turn: 'x' });
  const ours = ev('action', { facts: { category: 'shell' }, command: 'gh pr checks 9', cwd: '/w/r', branch: 'main', turn: 'y' });
  const pr = { ...pr9, repo: { label: 'r', slug: 'you/r' } };
  const prRefs = [{ session: 's', event: theirs, number: 9, owner: 'someone', repo: 'else' }, { session: 's', event: ours, number: 9, owner: null, repo: null }];
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [theirs, ours], prRefs }), pr, git: false });
  assert.deepEqual([theirs, ours].map((e) => where(sc, e)), ['out', 'in']);
  assert.equal(sc.laneOf(theirs.id), 'pull request someone/else#9');
  // Nor does reviewing it make a review of this one.
  const rev = ev('action', { facts: { category: 'shell' }, command: 'gh pr review 9 -R someone/else --approve', cwd: '/w/r', branch: 'main', turn: 'z' });
  const sc2 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [rev, ours], prRefs: [{ session: 's', event: rev, number: 9, owner: 'someone', repo: 'else' }, prRefs[1]] }), pr: { ...pr, sessions: ['s'] }, git: false });
  assert.notEqual(sc2.sessions[0].role, 'review');
});

test('the issue opening ends at the first step tied to the pull request at all', () => {
  const ask = ev('prompt', { facts: { text: 'Do issue 5.' }, turn: 'a' });
  const create = ev('action', { facts: { category: 'shell' }, command: 'gh pr create --body "Closes #5"', cwd: '/w/r', branch: 'main', turn: 'a' });
  const next = ev('prompt', { facts: { text: 'Now tidy the docs.' }, turn: 'b' });
  const docs = ev('action', { facts: { category: 'shell' }, command: 'npm run docs', cwd: '/w/r', branch: 'main', turn: 'b' });
  const events = [ask, create, next, docs];
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events, prRefs: [{ session: 's', event: create, number: 9 }] }), pr: pr9, git: false });
  assert.equal(sc.sessions[0].role, 'author');
  assert.deepEqual(events.map((e) => where(sc, e)), ['in', 'in', 'out', 'out']);
});

test('with its own commits unknown, another recorded commit ends the stretch', () => {
  const push1 = ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine', cwd: '/w/r', branch: 'main', turn: 'a' });
  const commit = ev('action', { facts: { category: 'shell' }, command: 'git commit -m other', cwd: '/w/r', branch: 'main', turn: 'b' });
  const push2 = ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine', cwd: '/w/r', branch: 'main', turn: 'c' });
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [push1, commit, push2], commitRefs: [{ session: 's', event: commit, sha: 'abcdef1234567', via: 'harness-commit' }] }), pr: pr9, git: false });
  assert.deepEqual([push1, commit, push2].map((e) => where(sc, e)), ['in', 'out', 'in']);
  assert.equal(sc.laneOf(commit.id), 'commit abcdef1 (its own commits unknown)');
});

test('a review run started by an ambiguous step is ambiguous whole, never in', () => {
  const both = ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine && claude -p "/review-loop"', cwd: '/w/r', branch: 'main' });
  const launch = both;
  const child = { id: 'c.1.0', session: 'c', kind: 'prompt', t: 99, turn: 'u', facts: { text: '/review-loop' }, inferred: [] };
  const h2 = handHistory({ sessions: [{ key: 's' }, { key: 'c' }], events: [both, child], prRefs: [{ session: 's', event: both, number: 10 }], links: [{ type: 'program-launch', from: launch.id, to: 'c', evidence: 'recorded', rule: 'x' }] });
  const sc = scopeSteps({ h: h2, pr: pr9, git: false });
  assert.equal(where(sc, both), 'ambiguous');
  const row = sc.sessions.find((r) => r.key === 'c');
  assert.deepEqual([row.role, row.in, row.ambiguous], ['review', 0, 1]);
  // Even when the run points at this pull request itself.
  const sc2 = scopeSteps({ h: h2, pr: { ...pr9, sessions: ['s', 'c'] }, git: false });
  const row2 = sc2.sessions.find((r) => r.key === 'c');
  assert.deepEqual([row2.role, row2.in, row2.ambiguous], ['review', 0, 1]);
});

test("a stacked pull request's base branch ties a folder to no pull request, like main", () => {
  const sent = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt5 && git push origin feature/parent', cwd: '/w/r', turn: 'a' });
  const work = ev('action', { facts: { category: 'shell' }, command: 'cd /w/wt5 && npm test', cwd: '/w/r', turn: 'b' });
  const h5 = handHistory({ sessions: [{ key: 's' }], events: [sent, work] });
  const plainSc = scopeSteps({ h: h5, pr: pr9, git: false });
  assert.equal(plainSc.laneOf(work.id), 'folder on branch feature/parent');
  for (const ref of ['origin/feature/parent', 'refs/heads/feature/parent']) {
    const sc = scopeSteps({ h: h5, pr: { ...pr9, base: { ref } }, git: false });
    assert.notEqual(sc.laneOf(work.id), 'folder on branch feature/parent', ref);
  }
});

test('a branch made from its branch, or one pushed to it by name, is read as on its branch', () => {
  // A review worktree made from the pull request's branch: a test there ran on its work.
  const made = ev('action', { facts: { category: 'shell' }, command: 'git worktree add /w/rev -b review/nine origin/feature/nine', cwd: '/w/r', turn: 'a' });
  const ran = ev('action', { facts: { category: 'shell' }, command: 'cd /w/rev && npm test', cwd: '/w/r', turn: 'a' });
  const sent = ev('action', { facts: { category: 'shell' }, command: 'cd /w/rev && git push origin HEAD:feature/nine', cwd: '/w/r', turn: 'a' });
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [made, ran, sent] }), pr: pr9, git: false });
  assert.deepEqual([sc.tracks('review/nine'), sc.branchOf(ran.id), where(sc, made), where(sc, ran)], [true, 'review/nine', 'in', 'in']);
  assert.match(sc.why.get(ran.id).rule, /brief\.tracks-branch/);
  assert.deepEqual(branchMade('git worktree add /w/rev -b review/nine origin/feature/nine'), { branch: 'review/nine', path: '/w/rev', from: 'feature/nine' });
  assert.deepEqual(branchMade('git switch -c review/nine feature/nine'), { branch: 'review/nine', path: null, from: 'feature/nine' });
  // A folder on its own branch that pushes HEAD to the pull request's branch.
  const work = ev('action', { facts: { category: 'shell' }, command: 'npm test', cwd: '/w/rv2', branch: 'review/x', turn: 'b' });
  const push = ev('action', { facts: { category: 'shell' }, command: 'git push origin HEAD:feature/nine', cwd: '/w/rv2', branch: 'review/x', turn: 'b' });
  const sc2 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [work, push] }), pr: pr9, git: false });
  assert.deepEqual([sc2.tracks('review/x'), where(sc2, work)], [true, 'in']);
  // Failing-path partners: made from main, or pushed to another branch, carries none of its work.
  const fromMain = ev('action', { facts: { category: 'shell' }, command: 'git worktree add /w/o -b review/y origin/main', cwd: '/w/r', turn: 'c' });
  const elsewhere = ev('action', { facts: { category: 'shell' }, command: 'git push origin HEAD:feature/ten', cwd: '/w/rv3', branch: 'review/z', turn: 'c' });
  const failed = ev('action', { facts: { category: 'shell', result: 'error' }, command: 'git push origin HEAD:feature/nine', cwd: '/w/rv4', branch: 'review/w', turn: 'c' });
  const sc3 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [fromMain, elsewhere, failed] }), pr: pr9, git: false });
  assert.deepEqual(['review/y', 'review/z', 'review/w', 'main', null].map((b) => sc3.tracks(b)), [false, false, false, false, false]);
  // A stacked pull request's branch is made from its branch too, but it's pushed under its own
  // name and opened as its own pull request: its work is never this one's.
  const stack = ev('action', { facts: { category: 'shell' }, command: 'git switch -c feature/two feature/nine', cwd: '/w/r', branch: 'feature/nine', turn: 'd' });
  const editTwo = ev('action', { facts: { category: 'edit' }, file: '/w/r/lib/b.mjs', cwd: '/w/r', branch: 'feature/two', turn: 'd' });
  const pushTwo = ev('action', { facts: { category: 'shell' }, command: 'git push -u origin feature/two', cwd: '/w/r', branch: 'feature/two', turn: 'e' });
  const openTwo = ev('action', { facts: { category: 'shell' }, command: 'gh pr create --base feature/nine --title two', cwd: '/w/r', branch: 'feature/two', turn: 'e' });
  const sc4 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [stack, editTwo, pushTwo, openTwo] }), pr: pr9, git: false });
  assert.deepEqual([sc4.tracks('feature/two'), where(sc4, editTwo), where(sc4, openTwo)], [false, 'out', 'out']);
  // Opened with --head and never pushed in the logs counts the same.
  const sc5 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [stack, editTwo, ev('action', { facts: { category: 'shell' }, command: 'gh pr create --head feature/two --base feature/nine', cwd: '/w/x', turn: 'e' })] }), pr: pr9, git: false });
  assert.equal(sc5.tracks('feature/two'), false);
});

test("a step after the pull request landed isn't its own; one that's another's keeps that lane", () => {
  // Run from the main checkout, which records main: no folder ties a step to a pull request.
  const push = ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine', cwd: '/w/r', branch: 'main', turn: 'a' });
  const merge = ev('action', { facts: { category: 'shell' }, command: 'gh pr merge 9 --squash', cwd: '/w/r', branch: 'main', turn: 'a' });
  const ask = ev('prompt', { facts: { text: 'Sum up what was done.' }, turn: 'b' });
  const look = ev('action', { facts: { category: 'shell' }, command: 'gh pr view 9', cwd: '/w/r', branch: 'main', turn: 'b' });
  const next = ev('action', { facts: { category: 'shell' }, command: 'gh pr view 21', cwd: '/w/r', branch: 'main', turn: 'c' });
  const events = [push, merge, ask, look, next];
  const prRefs = [{ session: 's', event: merge, number: 9 }, { session: 's', event: look, number: 9 }, { session: 's', event: next, number: 21 }];
  const hh = handHistory({ sessions: [{ key: 's' }], events, prRefs });
  // Landed between the merge command and the prompt (a step's t is its time in ms).
  const landed = { ...pr9, landed: { at: new Date(merge.t).toISOString() } };
  const sc = scopeSteps({ h: hh, pr: landed, git: false });
  assert.deepEqual(events.map((e) => where(sc, e)), ['in', 'in', 'out', 'out', 'out']);
  assert.deepEqual([sc.laneOf(ask.id), sc.laneOf(look.id), sc.laneOf(next.id)], ['after it landed', 'after it landed', 'pull request #21']);
  assert.ok(sc.sessions[0].lanes.some((l) => l.lane === 'after it landed' && l.steps === 2));
  // Failing-path partner: not landed, the later look is its own as before.
  const open = scopeSteps({ h: hh, pr: pr9, git: false });
  assert.equal(where(open, look), 'in');
});

test('a long prompt names its issue anywhere in it, not only in its shortened copy', () => {
  const ask = ev('prompt', { facts: { text: 'Here is the plan for today' }, turn: 'a' });
  Object.defineProperty(ask, '_raw', { value: { text: `Here is the plan for today. ${'Context. '.repeat(200)}It fixes issue 5.` } });
  const push = ev('action', { facts: { category: 'shell' }, command: 'git push origin feature/nine', cwd: '/w/r', turn: 'b' });
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [ask, push] }), pr: pr9, git: false });
  assert.equal(where(sc, ask), 'in');
  // Failing-path partner: a prompt that never names it stays out.
  const plain = ev('prompt', { facts: { text: 'Here is the plan for today' }, turn: 'a' });
  const sc2 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [plain, push] }), pr: pr9, git: false });
  assert.equal(where(sc2, plain), 'out');
});
