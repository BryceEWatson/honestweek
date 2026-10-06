// discover never asks git about a display-only repository (AGENTS.md invariant 4), including
// when it runs from a subfolder of one: the tracked-draft check compares by containment, not
// by an exact path match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { isSameOrInside, runDiscover } from '../lib/discover.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const norm = (s) => s.replace(/\\/g, '/').toLowerCase();

/** A git repo with a subfolder holding the config, which names the repo (`..`) with `role`,
 *  and a tracked draft in the subfolder. */
function repoWithSubfolder(t, role) {
  const root = makeTempDir('hw-discover-sub-');
  t.after(() => removeTempDir(root));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const sub = join(repo, 'notes');
  mkdirSync(sub);
  writeFileSync(join(sub, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: '..', label: 'here', role }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  }));
  writeFileSync(join(sub, 'honestweek.draft.json'), '{}\n');
  git(repo, ['add', join('notes', 'honestweek.draft.json')]);
  return { repo, sub };
}

async function discoverWatchingGit(cwd) {
  const cp = createRequire(import.meta.url)('node:child_process');
  const real = cp.execFileSync;
  const seen = [];
  cp.execFileSync = function (file, args, ...rest) {
    if (file === 'git') seen.push(norm((args ?? []).join(' ')));
    return real.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  const errors = [];
  const io = { err: (s) => errors.push(s), out: () => {}, exit: (c) => c };
  try {
    await runDiscover({ cwd, now: new Date('2024-06-19T12:00:00Z'), io, adapter: async () => [], gitWindow: () => [] });
  } finally {
    cp.execFileSync = real;
    syncBuiltinESMExports();
  }
  return { seen, errors };
}

test('discover run from a subfolder of a display-only repo runs no git there', async (t) => {
  const { repo, sub } = repoWithSubfolder(t, 'display');
  const { seen, errors } = await discoverWatchingGit(sub);
  assert.deepEqual(seen.filter((c) => c.includes(norm(repo))), [], 'no git command names the display repo or its subfolder');
  assert.equal(errors.some((s) => s.includes('is tracked in git')), false);
});

test('failing-path partner: from a subfolder of a featured repo, the tracked draft is still flagged', async (t) => {
  const { sub } = repoWithSubfolder(t, 'featured');
  const { seen, errors } = await discoverWatchingGit(sub);
  assert.ok(seen.some((c) => c.includes('ls-files') && c.includes(norm(sub))), 'git was asked about the subfolder');
  assert.equal(errors.some((s) => s.includes('is tracked in git')), true);
});

test('isSameOrInside compares by containment, ignoring trailing separators', () => {
  const base = makeTempDir('hw-discover-path-');
  try {
    const repo = join(base, 'repo');
    assert.equal(isSameOrInside(repo, repo), true);
    assert.equal(isSameOrInside(`${repo}${sep}`, repo), true);
    assert.equal(isSameOrInside(repo, `${repo}${sep}`), true);
    assert.equal(isSameOrInside(join(repo, 'a', 'b'), repo), true);
    assert.equal(isSameOrInside(`${repo}2`, repo), false, 'a sibling sharing the prefix is not inside');
    assert.equal(isSameOrInside(base, repo), false, 'the parent is not inside');
    assert.equal(isSameOrInside(join(repo, 'x'), join(repo, 'x', '..')), true, 'dot segments resolve');
    if (process.platform === 'win32') assert.equal(isSameOrInside(join(repo, 'Sub').toUpperCase(), repo), true, 'case-insensitive on Windows');
  } finally {
    removeTempDir(base);
  }
});
