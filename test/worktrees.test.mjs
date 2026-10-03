import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkTrees, clearWorkTreeCache } from '../lib/worktrees.mjs';
import { matchConfiguredRepo, matchRepo } from '../lib/claude-adapter.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

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
  const dir = makeTempDir('hw-wt-plain-');
  try {
    assert.deepEqual(resolveWorkTrees(dir), [dir]);
  } finally {
    removeTempDir(dir);
  }
});

test('resolveWorkTrees: primary and sibling worktrees resolve to the same set', () => {
  clearWorkTreeCache();
  const base = makeTempDir('hw-wt-');
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
    removeTempDir(base);
  }
});

test('resolveWorkTrees: a separate clone at a sibling path is NOT a worktree', () => {
  clearWorkTreeCache();
  const base = makeTempDir('hw-wt-clone-');
  const primary = join(base, 'alpha');
  const other = join(base, 'alpha-parity');
  try {
    makeRepo(primary);
    makeRepo(other); // independent git database, same name prefix
    assert.ok(!has(resolveWorkTrees(primary), other), 'an independent repo never joins the set');
  } finally {
    removeTempDir(base);
  }
});

test('matchRepo: a session in a sibling worktree credits the configured repo', () => {
  clearWorkTreeCache();
  const base = makeTempDir('hw-wt-match-');
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
    removeTempDir(base);
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

test('matchConfiguredRepo resolves dot segments before containment',()=>{
  const base=join(tmpdir(),'honestweek-configured-root');
  const config={repos:[{resolvedPath:join(base,'repo'),path:join(base,'repo'),label:'your-project',role:'featured'}]};
  assert.equal(matchConfiguredRepo(`${join(base,'repo')}/../private`,config),null);
});

// git writes a worktree's path with symlinks resolved, but the configured path (and a
// session's working folder) can reach the same folder through a symlink: macOS's temp
// folder is /var -> /private/var, and a projects folder can be a link too. Both spellings
// must land in the same set, or a session in the other checkout falls into "other".
test('resolveWorkTrees: a repository reached through a symlinked folder keeps both spellings', () => {
  clearWorkTreeCache();
  const base = makeTempDir('hw-wt-link-');
  const link = join(base, 'link');
  try {
    makeRepo(join(base, 'real', 'alpha'));
    // Where the folder really is: the temp folder itself can be a symlink (macOS) or a
    // Windows short name, which git writes out in full.
    const real = realpathSync.native(join(base, 'real'));
    git(join(real, 'alpha'), 'worktree', 'add', '-q', '--detach', join(real, 'alpha-weekly'));
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');

    const set = resolveWorkTrees(join(link, 'alpha-weekly'));
    assert.ok(has(set, join(link, 'alpha')), 'the primary checkout, spelled through the link');
    assert.ok(has(set, join(real, 'alpha')), 'the primary checkout where it really is');
    assert.ok(has(set, join(real, 'alpha-weekly')), 'the configured worktree where it really is');

    const config = { repos: [{ label: 'alpha', path: join(link, 'alpha-weekly'), resolvedPath: join(link, 'alpha-weekly'), role: 'featured' }] };
    assert.equal(matchRepo(join(link, 'alpha', 'src'), config)?.label, 'alpha');
    assert.equal(matchRepo(join(real, 'alpha'), config)?.label, 'alpha');
    assert.equal(matchRepo(join(base, 'elsewhere'), config), null, 'an unrelated folder stays unattributed');
  } finally {
    clearWorkTreeCache();
    removeTempDir(base);
  }
});

// A week's summary often runs after its worktrees are cleaned up. A removed worktree's
// folder is gone, but sessions recorded it through the link, so that spelling must stay.
test('resolveWorkTrees: a removed worktree keeps its spelling through the symlink', () => {
  clearWorkTreeCache();
  const base = makeTempDir('hw-wt-gone-');
  const link = join(base, 'link');
  try {
    makeRepo(join(base, 'real', 'alpha'));
    const real = realpathSync.native(join(base, 'real'));
    git(join(real, 'alpha'), 'worktree', 'add', '-q', '--detach', join(real, 'alpha-gone'));
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    rmSync(join(real, 'alpha-gone'), { recursive: true, force: true });

    const set = resolveWorkTrees(join(link, 'alpha'));
    assert.ok(has(set, join(real, 'alpha-gone')), 'where git recorded it');
    assert.ok(has(set, join(link, 'alpha-gone')), 'through the link the sessions used');
  } finally {
    clearWorkTreeCache();
    removeTempDir(base);
  }
});

// When the symlink's name matches its target's last folder (u/work -> disk/work), the
// spellings agree on more than the link, and the leftover prefixes (u and disk) are wider
// than the link. A worktree outside the linked folder must not be re-spelled into an
// unrelated folder that happens to exist under u.
test('resolveWorkTrees: a worktree outside the symlinked folder is not re-spelled into an unrelated folder', () => {
  clearWorkTreeCache();
  const base = makeTempDir('hw-wt-wide-');
  try {
    const disk = realpathSync.native(join(base));
    makeRepo(join(disk, 'disk', 'work', 'alpha'));
    git(join(disk, 'disk', 'work', 'alpha'), 'worktree', 'add', '-q', '--detach', join(disk, 'disk', 'tmp', 'wt'));
    mkdirSync(join(disk, 'u', 'tmp', 'wt'), { recursive: true }); // unrelated, same tail
    symlinkSync(join(disk, 'disk', 'work'), join(disk, 'u', 'work'), process.platform === 'win32' ? 'junction' : 'dir');

    const set = resolveWorkTrees(join(disk, 'u', 'work', 'alpha'));
    assert.ok(has(set, join(disk, 'disk', 'tmp', 'wt')), 'the worktree where it really is');
    assert.ok(!has(set, join(disk, 'u', 'tmp', 'wt')), 'not the unrelated folder with the same tail');
    const config = { repos: [{ label: 'alpha', path: join(disk, 'u', 'work', 'alpha'), resolvedPath: join(disk, 'u', 'work', 'alpha'), role: 'featured' }] };
    assert.equal(matchRepo(join(disk, 'u', 'tmp', 'wt'), config), null, 'a session there stays unattributed');
  } finally {
    clearWorkTreeCache();
    removeTempDir(base);
  }
});
