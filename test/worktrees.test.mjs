import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkTrees, clearWorkTreeCache } from '../lib/worktrees.mjs';
import { matchRepo } from '../lib/claude-adapter.mjs';

function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
function has(list, p) {
  return list.map(norm).includes(norm(p));
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** A real git repo with one commit, so `git worktree add` works. */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'dev@example.com');
  git(dir, 'config', 'user.name', 'Dev');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
}

test('resolveWorkTrees: a non-git path degrades to just that path', () => {
  clearWorkTreeCache();
  const dir = mkdtempSync(join(tmpdir(), 'hw-wt-plain-'));
  try {
    assert.deepEqual(resolveWorkTrees(dir), [dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWorkTrees: primary and sibling worktrees resolve to the same set', () => {
  clearWorkTreeCache();
  const base = mkdtempSync(join(tmpdir(), 'hw-wt-'));
  const primary = join(base, 'alpha');
  const sibling = join(base, 'alpha-task');
  const nested = join(primary, 'sub', 'wt');
  try {
    makeRepo(primary);
    git(primary, 'worktree', 'add', '-q', '--detach', sibling);
    git(primary, 'worktree', 'add', '-q', '--detach', nested);

    const fromPrimary = resolveWorkTrees(primary);
    assert.ok(has(fromPrimary, primary), 'primary includes itself');
    assert.ok(has(fromPrimary, sibling), 'primary discovers the sibling worktree');
    assert.ok(has(fromPrimary, nested), 'primary discovers the nested worktree');

    // The crux: asking from a LINKED worktree must yield the same repository-wide
    // set — that is what lets a build run from a sibling worktree still attribute
    // sessions started in the primary checkout.
    const fromSibling = resolveWorkTrees(sibling);
    assert.deepEqual(
      new Set(fromSibling.map(norm)),
      new Set(fromPrimary.map(norm)),
      'a linked worktree resolves the same working-tree set as the primary'
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolveWorkTrees: a separate clone at a sibling path is NOT a worktree', () => {
  clearWorkTreeCache();
  const base = mkdtempSync(join(tmpdir(), 'hw-wt-clone-'));
  const primary = join(base, 'alpha');
  const other = join(base, 'alpha-parity');
  try {
    makeRepo(primary);
    makeRepo(other); // independent git database, same name prefix
    assert.ok(!has(resolveWorkTrees(primary), other), 'an independent repo never joins the set');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('matchRepo: a session in a sibling worktree credits the configured repo', () => {
  clearWorkTreeCache();
  const base = mkdtempSync(join(tmpdir(), 'hw-wt-match-'));
  const primary = join(base, 'alpha');
  const sibling = join(base, 'alpha-weekly');
  const foreign = join(base, 'alpha-parity');
  try {
    makeRepo(primary);
    git(primary, 'worktree', 'add', '-q', '--detach', sibling);
    makeRepo(foreign);

    // Configured at the SIBLING worktree (what a build launched from a dedicated
    // worktree sees), yet a session run in the primary checkout must still credit it.
    const config = { repos: [{ label: 'alpha', path: sibling, resolvedPath: sibling, role: 'featured' }] };
    assert.equal(matchRepo(primary, config)?.label, 'alpha');
    assert.equal(matchRepo(join(primary, 'src'), config)?.label, 'alpha');
    assert.equal(matchRepo(sibling, config)?.label, 'alpha');
    assert.equal(matchRepo(foreign, config), null, 'a separate clone stays unattributed');
  } finally {
    clearWorkTreeCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test('matchRepo: longest matched root still wins across repos', () => {
  clearWorkTreeCache();
  const config = {
    repos: [
      { label: 'outer', path: '/work/outer', resolvedPath: '/work/outer', role: 'featured' },
      { label: 'inner', path: '/work/outer/packages/inner', resolvedPath: '/work/outer/packages/inner', role: 'featured' },
    ],
  };
  assert.equal(matchRepo('/work/outer/packages/inner/src', config)?.label, 'inner');
  assert.equal(matchRepo('/work/outer/src', config)?.label, 'outer');
  assert.equal(matchRepo('/work/outer-parity/src', config), null);
});
