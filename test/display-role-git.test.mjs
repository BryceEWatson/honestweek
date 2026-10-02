// The setup commands never run git against a display-role repo (AGENTS.md invariant 4),
// including when the folder they run in is itself display-only, or the config names the
// repo with a `~` path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existingDisplayRepos, inferAuthorEmail } from '../lib/init.mjs';
import { ensureDraftGitignored } from '../lib/discover.mjs';

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-display-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
const silentIo = () => {
  const err = [];
  return { err: (s) => err.push(s), out: () => {}, errors: err };
};

test('a display path written with ~ resolves under the home folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-display-cfg-'));
  try {
    writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({ repos: [{ path: '~/code/client-repo', role: 'display' }] }));
    assert.deepEqual(existingDisplayRepos(dir), [resolve(homedir(), 'code/client-repo')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inferAuthorEmail never reads a display-only folder\'s own git config', () => {
  const dir = tempRepo();
  try {
    git(dir, ['config', 'user.email', 'repo-local@example.com']);
    // Failing-path partner: an ordinary folder reports its own setting.
    assert.equal(inferAuthorEmail(dir), 'repo-local@example.com');
    assert.notEqual(inferAuthorEmail(dir, { isDisplay: true }), 'repo-local@example.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discover never asks git about a display-only folder, even when its draft is tracked', () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, 'honestweek.draft.json'), '{}\n');
    git(dir, ['add', 'honestweek.draft.json']);
    // Failing-path partner: in an ordinary folder, git is asked and the tracked draft is flagged.
    const plain = silentIo();
    ensureDraftGitignored(dir, plain);
    assert.ok(plain.errors.some((s) => s.includes('is tracked in git')));
    const display = silentIo();
    ensureDraftGitignored(dir, display, { isDisplay: true });
    assert.equal(display.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The wiring: runInit and runDiscover decide from the real config that the folder they
// run in is display-only, and pass that to the guards above.
import { runInit } from '../lib/init.mjs';
import { runDiscover } from '../lib/discover.mjs';

function folderWithConfig(role) {
  const dir = tempRepo();
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: '.', label: 'here', role }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  }));
  return dir;
}

test('runInit treats the folder it runs in as display-only when the config says so', async () => {
  for (const [role, expected] of [['display', true], ['featured', false]]) {
    const dir = folderWithConfig(role);
    try {
      const seen = [];
      await runInit({ cwd: dir, argv: ['--yes'], io: silentIo(), inferEmail: (cwd, opts) => (seen.push(opts?.isDisplay === true), 'you@example.com') });
      assert.deepEqual(seen, [expected], `role ${role}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('runDiscover skips the tracked-draft git check only when the folder is display-only', async () => {
  for (const [role, flagged] of [['display', false], ['featured', true]]) {
    const dir = folderWithConfig(role);
    try {
      writeFileSync(join(dir, 'honestweek.draft.json'), '{}\n');
      git(dir, ['add', 'honestweek.draft.json']);
      const io = silentIo();
      io.exit = (c) => c;
      await runDiscover({ cwd: dir, now: new Date('2024-06-19T12:00:00Z'), io, adapter: async () => [], gitWindow: () => [] });
      assert.equal(io.errors.some((s) => s.includes('is tracked in git')), flagged, `role ${role}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
