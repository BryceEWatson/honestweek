// The setup commands never run git against a display-role repo (AGENTS.md invariant 4),
// including when the folder they run in is itself display-only, or the config names the
// repo with a `~` path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { existingDisplayRepos, inferAuthorEmail } from '../lib/init.mjs';
import { CANT_CHECK_DRAFT, ensureDraftGitignored } from '../lib/discover.mjs';

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
/**
 * A fresh git repo whose PARENT is also scratch. `init` scans the parent's children and
 * runs git in each repo it finds, so a repo sitting directly in the system temp folder
 * makes the test walk every entry there: slow, and it reads repos the test doesn't own.
 */
function tempRepo(t) {
  const root = makeTempDir('hw-display-');
  t.after(() => removeTempDir(root));
  const dir = join(root, 'repo');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
const silentIo = () => {
  const err = [];
  return { err: (s) => err.push(s), out: () => {}, errors: err };
};

test('a display path written with ~ resolves under the home folder', () => {
  const dir = makeTempDir('hw-display-cfg-');
  try {
    writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({ repos: [{ path: '~/code/client-repo', role: 'display' }] }));
    assert.deepEqual(existingDisplayRepos(dir), [resolve(homedir(), 'code/client-repo')]);
  } finally {
    removeTempDir(dir);
  }
});

test('inferAuthorEmail never reads a display-only folder\'s own git config', (t) => {
  const dir = tempRepo(t);
  git(dir, ['config', 'user.email', 'repo-local@example.com']);
  // Failing-path partner: an ordinary folder reports its own setting.
  assert.equal(inferAuthorEmail(dir), 'repo-local@example.com');
  assert.notEqual(inferAuthorEmail(dir, { isDisplay: true }), 'repo-local@example.com');
});

test('discover never asks git about a display-only folder, even when its draft is tracked', (t) => {
  const dir = tempRepo(t);
  writeFileSync(join(dir, 'honestweek.draft.json'), '{}\n');
  git(dir, ['add', 'honestweek.draft.json']);
  // Failing-path partner: in an ordinary folder, git is asked and the tracked draft is flagged.
  const plain = silentIo();
  ensureDraftGitignored(dir, plain);
  assert.ok(plain.errors.some((s) => s.includes('is tracked in git')));
  // Display-only: git isn't asked, and the one line says how to check by hand instead.
  const display = silentIo();
  ensureDraftGitignored(dir, display, { isDisplay: true });
  assert.deepEqual(display.errors, [CANT_CHECK_DRAFT]);
  assert.match(CANT_CHECK_DRAFT, /^discover: check that honestweek\.draft\.json, your private draft, was never committed to git\. .* Run git ls-files honestweek\.draft\.json\. If it prints the file name, run git rm --cached honestweek\.draft\.json\.\n$/);
  assert.doesNotMatch(CANT_CHECK_DRAFT, /—|–/);
});

// The wiring: runInit and runDiscover decide from the real config that the folder they
// run in is display-only, and pass that to the guards above.
import { runInit } from '../lib/init.mjs';
import { runDiscover } from '../lib/discover.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

function folderWithConfig(t, role) {
  const dir = tempRepo(t);
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: '.', label: 'here', role }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  }));
  return dir;
}

test('runInit treats the folder it runs in as display-only when the config says so', async (t) => {
  for (const [role, expected] of [['display', true], ['featured', false]]) {
    const dir = folderWithConfig(t, role);
    // init scans this folder's parent, so it must hold nothing but the folder itself.
    const scanned = readdirSync(dirname(dir));
    assert.ok(scanned.length === 1 && scanned[0] === basename(dir), `init would scan ${scanned.length} entries beside the test folder`);
    const seen = [];
    await runInit({ cwd: dir, argv: ['--yes'], io: silentIo(), inferEmail: (cwd, opts) => (seen.push(opts?.isDisplay === true), 'you@example.com') });
    assert.deepEqual(seen, [expected], `role ${role}`);
  }
});

test('runDiscover skips the tracked-draft git check only when the folder is display-only', async (t) => {
  for (const [role, flagged] of [['display', false], ['featured', true]]) {
    const dir = folderWithConfig(t, role);
    writeFileSync(join(dir, 'honestweek.draft.json'), '{}\n');
    git(dir, ['add', 'honestweek.draft.json']);
    const io = silentIo();
    io.exit = (c) => c;
    await runDiscover({ cwd: dir, now: new Date('2024-06-19T12:00:00Z'), io, adapter: async () => [], gitWindow: () => [] });
    assert.equal(io.errors.some((s) => s.includes('is tracked in git')), flagged, `role ${role}`);
  }
});

test('runDiscover says how to check by hand, and asks git nothing, where its folder holds a display-only one (issue 161)', async (t) => {
  const dir = tempRepo(t);
  const other = join(dirname(dir), 'other');
  execFileSync('git', ['init', '-q', other]);
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: '../other', label: 'other', role: 'featured' }, { path: 'notes', label: 'notes', role: 'display' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  }));
  writeFileSync(join(dir, 'honestweek.draft.json'), '{}\n');
  git(dir, ['add', 'honestweek.draft.json']);
  const io = silentIo();
  io.exit = (c) => c;
  await runDiscover({ cwd: dir, now: new Date('2024-06-19T12:00:00Z'), io, adapter: async () => [], gitWindow: () => [] });
  assert.ok(io.errors.includes(CANT_CHECK_DRAFT), io.errors.join(''));
  assert.ok(!io.errors.some((s) => s.includes('is tracked in git')), 'git was not asked');
});

test('runDiscover asks git nothing in a worktree of a display-only repository, as Settings does (issue 161)', async (t) => {
  const root = makeTempDir('hw-discover-display-worktree-');
  t.after(() => removeTempDir(root));
  const notes = join(root, 'notes');
  execFileSync('git', ['init', '-q', notes]);
  git(notes, ['-c', 'user.email=you@example.com', '-c', 'user.name=You', 'commit', '-q', '--allow-empty', '-m', 'start']);
  const wt = join(root, 'notes-wt');
  git(notes, ['worktree', 'add', '-q', wt]);
  writeFileSync(join(wt, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: '../notes', label: 'notes', role: 'display' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  }));
  writeFileSync(join(wt, 'honestweek.draft.json'), '{}\n');
  git(wt, ['add', 'honestweek.draft.json']);
  const io = silentIo();
  io.exit = (c) => c;
  await runDiscover({ cwd: wt, now: new Date('2024-06-19T12:00:00Z'), io, adapter: async () => [], gitWindow: () => [] });
  assert.ok(io.errors.includes(CANT_CHECK_DRAFT), io.errors.join(''));
  assert.ok(!io.errors.some((s) => s.includes('is tracked in git')), 'git was not asked');
});

test('runDiscover says nothing about tracking outside any checkout, even beside a display-only folder', async (t) => {
  const root = makeTempDir('hw-discover-no-checkout-');
  t.after(() => removeTempDir(root));
  const dir = join(root, 'plain');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: 'notes', label: 'notes', role: 'display' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  }));
  const io = silentIo();
  io.exit = (c) => c;
  await runDiscover({ cwd: dir, now: new Date('2024-06-19T12:00:00Z'), io, adapter: async () => [], gitWindow: () => [] });
  assert.ok(!io.errors.includes(CANT_CHECK_DRAFT), io.errors.join(''));
});
