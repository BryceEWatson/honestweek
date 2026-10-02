// mine's own-repo detection reads each configured repo's GitHub remote, and must never
// run git against a display-role repo (AGENTS.md invariant 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownRepoSlugs } from '../lib/mine.mjs';

function repoWithRemote(slug) {
  const dir = mkdtempSync(join(tmpdir(), 'hw-own-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${slug}.git`]);
  return dir;
}

test('a featured repo contributes its GitHub slug', async () => {
  const dir = repoWithRemote('acme/widget');
  try {
    assert.deepEqual(await ownRepoSlugs({ repos: [{ path: dir, role: 'featured' }] }), ['acme/widget']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a display-role repo is never read by git, so it contributes nothing', async () => {
  const dir = repoWithRemote('acme/private-client');
  try {
    assert.deepEqual(await ownRepoSlugs({ repos: [{ path: dir, role: 'display' }] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a display-role repo still counts as yours when listed in mine.ownRepos', async () => {
  const dir = repoWithRemote('acme/private-client');
  try {
    const slugs = await ownRepoSlugs({ repos: [{ path: dir, role: 'display' }], mine: { ownRepos: ['acme/private-client'] } });
    assert.deepEqual(slugs, ['acme/private-client']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
