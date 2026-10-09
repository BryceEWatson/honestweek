// Picking out one pull request's steps (lib/review/scope.mjs) in a session that worked on
// several. The shared fixture's author session works on pull requests 20 and 21 from the main
// checkout, reaching each worktree with `cd`, and records only `main`; the cases its shape
// can't show are built by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { resolvePr } from '../lib/review/resolve.mjs';
import { branchMade, commandFolder, folderAt, scopeSteps } from '../lib/review/scope.mjs';
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
  assert.equal(branchMade('git worktree add ../wt origin/main'), null, 'a remote-tracking start point is no branch');
  assert.equal(branchMade('git worktree add --detach ../wt feature/x'), null);
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
  const two = ev('action', { facts: { category: 'shell', git: { push: { branch: 'feature/ten' } } }, command: 'cd /w/wt9 && git push origin feature/ten', cwd: '/w/r' });
  const made = ev('action', { facts: { category: 'shell' }, command: 'git worktree add /w/wt9 -b feature/nine', cwd: '/w/r' });
  const sc2 = scopeSteps({ h: handHistory({ sessions: [{ key: 's' }], events: [made, two] }), pr: pr9, git: false });
  assert.equal(sc2.ambiguous.has(two.id), true, "a push to another branch from this pull request's folder");
});

test('a saved session is scoped by its pointers only, and the brief says so', () => {
  const link = ev('link');
  const other = ev('message', { facts: { text: 'x' } });
  const sc = scopeSteps({ h: handHistory({ sessions: [{ key: 's', saved: { at: '2024-06-11', log: 'gone' } }], events: [link, other], prRefs: [{ session: 's', event: link, number: 9 }] }), pr: pr9, git: false });
  assert.equal(sc.sessions[0].saved, true);
  assert.ok(sc.notes.some((x) => x.kind === 'saved-sessions'));
});

test('a display-only pull request scopes nothing', () => {
  const sc = scopeSteps({ h: handHistory({ sessions: [], events: [] }), pr: { ...pr9, display: true } });
  assert.deepEqual([sc.inScope.size, sc.sessions.length], [0, 0]);
});
