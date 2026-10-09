// The git helpers the review brief reads one pull request's shape with: its head, where it
// starts, its commits and files, the commit it landed as, and a test file's diff. Every
// repository here is made up, in a temp folder: a main checkout with two worktrees (one per
// open pull request), a pull request merged with a merge commit, and one squash-merged.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { branchTip, changedFiles, commitRange, diffText, filesOfCommit, isRefName, landedPr, mergeBase, revParse, worktreeBranches } from '../lib/git.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const ME = 'you@example.com';
const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
let clock = 1717200000;
const commitEnv = () => {
  clock += 60;
  return { ...env0, GIT_AUTHOR_NAME: 'You', GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: 'You', GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` };
};
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: commitEnv() }).trim();
const fwd = (p) => p.replace(/\\/g, '/');
const same = (a, b) => fwd(realpathSync(a)).toLowerCase() === fwd(realpathSync(b)).toLowerCase();

function write(dir, file, text) {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
}
function commitFiles(dir, message, files) {
  for (const [file, text] of Object.entries(files)) write(dir, file, text);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

let parent;
let repo;
let wtA;
let wtB;
let root;
let baseA;
let aCommits;
let bTip;
let merge;
let squash;
let squashParent;

before(() => {
  parent = makeTempDir('hw-review-git-');
  repo = join(parent, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '--template=']);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  root = commitFiles(repo, 'Start', { 'README.md': 'hello\n', 'test/a.test.mjs': "test('a', () => { assert.ok(1); });\n" });

  // Pull request 3 is merged with a merge commit.
  git(repo, ['switch', '-q', '-c', 'feature/merged']);
  commitFiles(repo, 'Merged work', { 'lib/m.mjs': 'export const m = 1;\n' });
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #3 from you/feature/merged', 'feature/merged']);
  merge = git(repo, ['rev-parse', 'HEAD']);

  // Pull request 12 is squash-merged; pull request 120's number contains 12.
  squashParent = merge;
  squash = commitFiles(repo, 'Squashed work (#12)', { 'lib/s.mjs': 'export const s = 1;\n' });
  commitFiles(repo, 'Bigger number (#120)', { 'lib/t.mjs': 'export const t = 1;\n' });
  baseA = git(repo, ['rev-parse', 'HEAD']);

  // Two open pull requests, each in its own worktree.
  wtA = join(parent, 'wt-a');
  wtB = join(parent, 'wt-b');
  git(repo, ['worktree', 'add', '-q', '-b', 'feature/a', wtA]);
  git(repo, ['worktree', 'add', '-q', '-b', 'feature/b', wtB]);
  aCommits = [
    commitFiles(wtA, 'A one', { 'lib/a.mjs': 'export const a = 1;\n', 'test/a.test.mjs': "test('a', () => { assert.ok(2); });\n" }),
    commitFiles(wtA, 'A two', { 'lib/a2.mjs': 'export const a2 = 1;\n' }),
  ];
  git(wtA, ['rm', '-q', 'README.md']);
  git(wtA, ['commit', '-q', '-m', 'A three']);
  aCommits.push(git(wtA, ['rev-parse', 'HEAD']));
  bTip = commitFiles(wtB, 'B one', { 'lib/b.mjs': 'export const b = 1;\n' });
});

test('isRefName follows git\'s naming rules: any letters, but no option, range or reflog lookup', () => {
  for (const ok of ['main', 'feature/a', 'refs/heads/feature/b', 'v1.2.3', 'you+x_y-z', 'feature/café', 'feature/日本語', 'a@b', `feature/${'x'.repeat(300)}`]) assert.ok(isRefName(ok), ok);
  for (const bad of ['', '@', '-p', '--output=x', 'a..b', 'HEAD@{1}', 'a//b', 'a/', 'a.', 'a.lock', 'x/a.lock/y', '.hidden', 'x/.hidden', '/a', 'a b', 'a\nb', 'a\tb', 'a\u007fb', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[b', 'a\\b', 'x'.repeat(1025), null, 7]) assert.ok(!isRefName(bad), JSON.stringify(bad));
  // The names it takes are ones git takes too.
  for (const ok of ['feature/café', 'a@b', 'you+x_y-z']) assert.equal(execFileSync('git', ['check-ref-format', '--branch', ok], { encoding: 'utf8' }).trim(), ok);
});

test('a branch with a non-ASCII name resolves', () => {
  git(repo, ['branch', 'feature/café', baseA]);
  assert.equal(revParse(repo, 'feature/café'), baseA);
  assert.deepEqual(branchTip(repo, 'feature/café'), { sha: baseA, ref: 'refs/heads/feature/café' });
  git(repo, ['branch', '-D', 'feature/café']);
});

test('revParse resolves a commit id or branch name to its full id, else null', () => {
  assert.equal(revParse(repo, 'feature/a'), aCommits[2]);
  assert.equal(revParse(repo, aCommits[0].slice(0, 8)), aCommits[0]);
  assert.equal(revParse(repo, 'refs/heads/feature/b'), bTip);
  assert.equal(revParse(repo, 'no-such-branch'), null);
  assert.equal(revParse(repo, 'f'.repeat(40)), null);
  assert.equal(revParse(join(parent, 'not-a-repo'), 'main'), null);
});

test('branchTip prefers the local branch and says which ref it read', () => {
  assert.deepEqual(branchTip(repo, 'feature/b'), { sha: bTip, ref: 'refs/heads/feature/b' });
  git(repo, ['update-ref', 'refs/remotes/origin/only-remote', root]);
  assert.deepEqual(branchTip(repo, 'only-remote'), { sha: root, ref: 'refs/remotes/origin/only-remote' });
  assert.equal(branchTip(repo, 'missing'), null);
  assert.equal(branchTip(repo, '--all'), null);
});

test('mergeBase finds where an open pull request starts', () => {
  assert.equal(mergeBase(repo, 'feature/a', 'main'), baseA);
  assert.equal(mergeBase(repo, aCommits[2], bTip), baseA);
  assert.equal(mergeBase(repo, 'feature/a', '--all'), null);
});

test('commitRange lists base..head oldest first, and caps with a truncated flag', () => {
  const all = commitRange(repo, baseA, 'feature/a');
  assert.deepEqual(all.commits.map((c) => c.sha), aCommits);
  assert.equal(all.truncated, false);
  assert.equal(all.commits[0].subject, 'A one');
  assert.equal(all.commits[0].authorEmail, ME);
  assert.deepEqual(all.commits[0].parents, [baseA]);
  const capped = commitRange(repo, baseA, 'feature/a', { max: 2 });
  assert.deepEqual(capped.commits.map((c) => c.sha), aCommits.slice(1));
  assert.equal(capped.truncated, true);
  assert.deepEqual(commitRange(repo, 'feature/a', 'feature/a'), { commits: [], truncated: false });
  // A merge commit lists both parents.
  assert.equal(commitRange(repo, root, merge).commits.at(-1).parents.length, 2);
  assert.equal(commitRange(repo, baseA, 'no-such-branch'), null);
});

test('changedFiles lists each changed path with its status', () => {
  const files = changedFiles(repo, baseA, 'feature/a');
  assert.deepEqual(files.sort((x, y) => (x.path < y.path ? -1 : 1)), [
    { status: 'D', path: 'README.md' },
    { status: 'A', path: 'lib/a.mjs' },
    { status: 'A', path: 'lib/a2.mjs' },
    { status: 'M', path: 'test/a.test.mjs' },
  ]);
  assert.deepEqual(changedFiles(repo, baseA, baseA), []);
});

test('filesOfCommit lists one commit\'s files, a root commit and a merge commit included', () => {
  assert.deepEqual(filesOfCommit(repo, aCommits[1]), [{ status: 'A', path: 'lib/a2.mjs' }]);
  assert.deepEqual(filesOfCommit(repo, root).map((f) => f.path).sort(), ['README.md', 'test/a.test.mjs']);
  assert.deepEqual(filesOfCommit(repo, merge), [{ status: 'A', path: 'lib/m.mjs' }]);
  assert.deepEqual(filesOfCommit(repo, squash), [{ status: 'A', path: 'lib/s.mjs' }]);
  assert.equal(filesOfCommit(repo, 'main'), null, 'a branch name is not a commit id');
});

test('worktreeBranches names each checkout\'s branch and head', () => {
  const wts = worktreeBranches(repo);
  assert.equal(wts.length, 3);
  assert.ok(same(wts[0].path, repo));
  assert.equal(wts[0].branch, 'main');
  const a = wts.find((w) => same(w.path, wtA));
  assert.deepEqual({ branch: a.branch, head: a.head, detached: a.detached }, { branch: 'feature/a', head: aCommits[2], detached: false });
  assert.equal(wts.find((w) => same(w.path, wtB)).branch, 'feature/b');
  git(wtB, ['switch', '-q', '--detach']);
  assert.equal(worktreeBranches(repo).find((w) => same(w.path, wtB)).detached, true);
  assert.equal(worktreeBranches(repo).find((w) => same(w.path, wtB)).branch, null);
  git(wtB, ['switch', '-q', 'feature/b']);
  assert.equal(wts.find((w) => same(w.path, wtB)).prunable, false);
  // A worktree whose folder was deleted without `git worktree remove` keeps its record, marked.
  const gone = join(parent, 'wt-gone');
  git(repo, ['worktree', 'add', '-q', '-b', 'feature/gone', gone]);
  rmSync(gone, { recursive: true, force: true });
  const g = worktreeBranches(repo).find((w) => fwd(w.path).toLowerCase().endsWith('/wt-gone'));
  assert.deepEqual({ branch: g.branch, prunable: g.prunable }, { branch: 'feature/gone', prunable: true });
  git(repo, ['worktree', 'prune']);
  assert.deepEqual(worktreeBranches(join(parent, 'not-a-repo')), []);
});

test('landedPr finds a squash merge and a merge commit by number, and nothing for an open one', () => {
  const sq = landedPr(repo, 12, [ME]);
  assert.equal(sq.sha, squash);
  assert.equal(sq.isMerge, false);
  assert.deepEqual(sq.parents, [squashParent]);
  assert.equal(sq.byAuthor, true);
  assert.match(sq.landedISO, /^2024-/);
  const mg = landedPr(repo, 3);
  assert.equal(mg.sha, merge);
  assert.equal(mg.isMerge, true);
  assert.equal(mg.byAuthor, false, 'no identity given');
  assert.equal(landedPr(repo, 120).subject, 'Bigger number (#120)');
  assert.equal(landedPr(repo, 1), null, '#1 only appears inside #12 and #120');
  assert.equal(landedPr(repo, 999), null);
  // "Couldn't tell" is never "not landed".
  for (const bad of ['--all', -1, 0, 1.5, '12; rm', null]) assert.deepEqual(landedPr(repo, bad), { unreadable: true }, String(bad));
  assert.deepEqual(landedPr(join(parent, 'not-a-repo'), 12), { unreadable: true });
  const bare = join(parent, 'no-default');
  mkdirSync(bare);
  git(bare, ['init', '-q', '--template=']);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/topic']);
  assert.deepEqual(landedPr(bare, 12), { unreadable: true }, 'no default branch to read');
});

test('diffText reads a capped diff for literal paths only', () => {
  const d = diffText(repo, baseA, 'feature/a', ['test/a.test.mjs']);
  assert.equal(d.truncated, false);
  assert.match(d.text, /^-test\('a', \(\) => \{ assert\.ok\(1\); \}\);$/m);
  assert.match(d.text, /^\+test\('a', \(\) => \{ assert\.ok\(2\); \}\);$/m);
  assert.doesNotMatch(d.text, /lib\/a\.mjs/);
  const cut = diffText(repo, baseA, 'feature/a', ['test/a.test.mjs'], { maxBytes: 20 });
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text) <= 20);
  // A pathspec pattern is read as a literal file name, so it matches nothing.
  assert.equal(diffText(repo, baseA, 'feature/a', ['*.mjs']).text, '');
  assert.equal(diffText(repo, baseA, 'feature/a', []), null);
});

test('no helper hands an option-shaped value to git, and git writes nothing', () => {
  const out = join(parent, 'written-by-git.txt');
  const bad = [`--output=${out}`, '-p', `${baseA}..HEAD`, `HEAD@{0}`, '', null, 12, `main\n--output=${out}`];
  for (const b of bad) {
    assert.equal(revParse(repo, b), null, String(b));
    assert.equal(branchTip(repo, b), null, String(b));
    assert.equal(mergeBase(repo, b, 'main'), null, String(b));
    assert.equal(mergeBase(repo, 'main', b), null, String(b));
    assert.equal(commitRange(repo, b, 'main'), null, String(b));
    assert.equal(commitRange(repo, 'main', b), null, String(b));
    assert.equal(changedFiles(repo, b, 'main'), null, String(b));
    assert.equal(filesOfCommit(repo, b), null, String(b));
    assert.equal(diffText(repo, b, 'main', ['README.md']), null, String(b));
  }
  // A path that looks like an option is a literal path after `--`.
  assert.equal(diffText(repo, baseA, 'feature/a', [`--output=${out}`]).text, '');
  assert.ok(!existsSync(out), 'git wrote a file');
});
