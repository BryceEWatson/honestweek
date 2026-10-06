// The demo week's repository writer (lib/demo/repo.mjs) hashes and stores commits itself
// instead of running git for each one. These tests check that git reads what it wrote as its
// own: the same commit ids, the same stat lines, a clean status, and a repository fsck accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createRepo } from '../lib/demo/repo.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const NAME = 'You';
const EMAIL = 'you@example.com';
const CONFIG = [['user.name', NAME], ['user.email', EMAIL], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', '.git/no-hooks'], ['color.ui', 'false'], ['log.showSignature', 'false']];
const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, args, extra = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env(), ...extra } }).trim();

const lines = (n, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n');

test('a commit has the id git gives the same files, time and message', () => {
  const root = makeTempDir('hw-demo-repo-');
  const message = '  Edit a, add c  \n\n\nwith a body  \n';
  const steps = [[{ 'a.txt': 'one\n', 'src/b.mjs': 'b\n' }, 'Start', '2025-01-02T10:00:00Z'], [{ 'a.txt': 'one\ntwo', 'src/deep/c.mjs': 'c\n' }, message, '2025-01-02T11:00:00.750Z']];
  const real = join(root, 'real');
  git(root, ['init', '-q', '--template=', 'real'], { GIT_DEFAULT_HASH: 'sha1' });
  for (const [k, v] of CONFIG) git(real, ['config', k, v]);
  git(real, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const r = createRepo(join(root, 'mine'), { name: NAME, email: EMAIL, config: CONFIG });
  for (const [files, msg, at] of steps) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(real, path)), { recursive: true });
      writeFileSync(join(real, path), text);
    }
    git(real, ['add', '-A']);
    const date = `${at.slice(0, 10)} ${at.slice(11, 19)} +0000`;
    git(real, ['commit', '-q', '-m', msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    assert.equal(r.commit(files, msg, at).sha, git(real, ['rev-parse', 'HEAD']), msg);
  }
});

test("the writer's stats, branches and checkouts are the ones git shows and reads", () => {
  const root = makeTempDir('hw-demo-repo-');
  const dir = join(root, 'repo');
  const r = createRepo(dir, { remote: 'https://github.com/example/demo.git', name: NAME, email: EMAIL, config: CONFIG });
  const made = [];
  const keep = (c) => (made.push(c), c);
  keep(r.commit({ '.gitignore': '.claude/\n', 'a.txt': `${lines(40)}\n`, 'src/b.mjs': 'export const b = 1;\n', 'README.md': '# demo\n' }, 'Start', '2025-01-02T10:00:00Z'));
  // Several hunks in one file, a last line that loses its newline, and a new nested file.
  const edited = lines(40).replace('line 3\n', 'line three\n').replace('line 20\n', 'line 20\nline 20b\n').replace('\nline 40', '');
  keep(r.commit({ 'a.txt': edited, 'src/deep/c.mjs': 'export const c = 3;\n' }, '  Edit a, add c  \n\n\nwith a body  \n', '2025-01-02T11:00:00.750Z'));
  r.checkout('feature/x', { create: true });
  keep(r.commit({ 'src/b.mjs': 'export const b = 2;\n', 'src/x.mjs': 'x\n' }, 'Change b on a branch', '2025-01-03T09:00:00Z'));
  r.checkout('main');
  assert.equal(readFileSync(join(dir, 'src', 'b.mjs'), 'utf8'), 'export const b = 1;\n');
  assert.equal(existsSync(join(dir, 'src', 'x.mjs')), false, 'a switch removes what the branch does not hold');
  keep(r.commit({ 'README.md': '# demo\n\nMore.\n', 'src/deep/c.mjs': null }, 'Edit the README and drop c', '2025-01-03T10:00:00Z'));
  // main moved on since feature/x parted from it, in other files: the squash takes both sides.
  const sq = keep(r.squash('feature/x', 'Change b (#1)', '2025-01-04T08:00:00Z'));
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# demo\n\nMore.\n');
  assert.equal(readFileSync(join(dir, 'src', 'x.mjs'), 'utf8'), 'x\n');
  // An uncommitted edit: a hard reset drops it, and a later commit takes one in as add -A would.
  r.edit({ 'README.md': 'scribbles\n' });
  r.resetHard();
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# demo\n\nMore.\n');
  r.edit({ 'notes.md': 'kept\n' });
  keep(r.commit({ 'a.txt': `${lines(40)}\n` }, 'Restore a', '2025-01-04T09:00:00Z'));
  const wt = r.worktree(join(dir, '.claude', 'worktrees', 'side'), 'feature/side', 'main');
  keep(r.commit({ 'side.txt': 'side\n' }, 'Work in a worktree', '2025-01-05T09:00:00Z', wt));
  r.finish();

  // The stat line and summary each commit reports are the ones git shows.
  const stats = r.stats();
  for (const c of made) {
    assert.equal(` ${git(dir, ['show', '--format=', '--shortstat', c.sha])}`, c.stat, c.sha);
    const summary = git(dir, ['show', '--format=', '--summary', c.sha]);
    assert.equal(summary ? summary.split('\n').map((l) => ` ${l.trim()}`).join('\n') : '', c.summary, c.sha);
    assert.deepEqual(stats[c.sha], c);
  }
  assert.equal(made[1].stat, ' 2 files changed, 4 insertions(+), 3 deletions(-)');
  assert.equal(made[3].summary, ' delete mode 100644 src/deep/c.mjs');
  assert.equal(r.diffStat(made[0].sha, sq.sha), ` ${git(dir, ['diff', '--shortstat', made[0].sha, sq.sha])}`);
  assert.equal(r.head().sha, made[made.length - 2].sha);
  assert.equal(r.head(wt).sha, made[made.length - 1].sha);

  // Branches, the remote, a clean status in each checkout, and nothing fsck objects to.
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/side');
  assert.equal(git(dir, ['remote', 'get-url', 'origin']), 'https://github.com/example/demo.git');
  assert.equal(git(dir, ['config', 'user.email']), EMAIL);
  assert.equal(git(dir, ['status', '--porcelain']), '');
  assert.equal(git(wt, ['status', '--porcelain']), '');
  git(dir, ['fsck', '--strict', '--no-progress']);
  assert.match(git(dir, ['worktree', 'list', '--porcelain']), /branch refs\/heads\/feature\/side/);
  // The log questions the writer answers itself read the same as git's answers.
  for (const args of [['log', '--oneline', '-3', 'main'], ['log', '--format=%h %ad %s', '--date=short', '--since=2025-01-03T00:00:00Z', 'main'], ['log', '--format=%h %s', '-2', '--', 'a.txt'], ['log', '--oneline', '-1'], ['log', '--format=%H %ae', 'feature/x']]) assert.equal(r.git(args), git(dir, args), args.join(' '));
  assert.equal(r.git(['log', '--oneline', '-1'], wt), git(wt, ['log', '--oneline', '-1']));
  assert.equal(git(dir, ['log', '--format=%s', 'main']).split('\n')[0], 'Restore a');
  assert.ok(git(dir, ['ls-files']).split('\n').includes('notes.md'), 'the uncommitted file went in with the next commit');
});

test('the writer refuses what it would get wrong: a write command, a two-sided change, a switch over an edit', () => {
  const dir = join(makeTempDir('hw-demo-repo-'), 'repo');
  const r = createRepo(dir, { name: NAME, email: EMAIL, config: CONFIG });
  r.commit({ 'a.txt': 'a\n' }, 'Start', '2025-01-02T10:00:00Z');
  assert.throws(() => r.git(['commit', '-m', 'x']), /would change the repository/);
  assert.equal(r.git(['log', '--format=%s']), 'Start');
  r.checkout('b', { create: true });
  r.commit({ 'a.txt': 'b\n' }, 'On b', '2025-01-02T11:00:00Z');
  r.checkout('main');
  r.commit({ 'a.txt': 'c\n' }, 'On main', '2025-01-02T12:00:00Z');
  assert.throws(() => r.squash('b', 'Squash', '2025-01-02T13:00:00Z'), /both sides changed a\.txt/);
  r.edit({ 'a.txt': 'dirty\n' });
  assert.throws(() => r.checkout('b'), /uncommitted edits/);
  assert.throws(() => r.checkout('b', { create: true }), /already exists/);
});
