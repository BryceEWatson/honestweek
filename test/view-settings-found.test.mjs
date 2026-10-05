// Settings' "Find new repositories" and its newest-first list: the repositories next to the
// config's folder that the config doesn't list yet, and when each listed one was last committed
// to, without ever passing a display-only repository to git (AGENTS.md invariant 4).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { createSettings } from '../lib/view/settings.mjs';

const ME = 'you@example.com';
const parent = makeTempDir('hw-settings-found-');
after(() => removeTempDir(parent));

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
function repo(name) {
  const dir = join(parent, name);
  mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['-c', `user.email=${ME}`, '-c', 'user.name=You', 'commit', '-q', '--allow-empty', '-m', 'first']);
  return dir;
}

const listed = repo('listed');
repo('fresh-old');
repo('fresh-new');
repo('disp');
git(listed, ['worktree', 'add', '-q', join(parent, 'listed-wt'), '-b', 'side']);
const folder = join(parent, 'myweek');
mkdirSync(folder);
writeFileSync(join(folder, 'honestweek.config.json'), `${JSON.stringify({ identity: { authorEmails: [ME] }, repos: [{ path: '../listed', label: 'listed', role: 'featured' }, { path: '../disp', label: 'disp', role: 'display' }] }, null, 2)}\n`);

const WHEN = { listed: 3000, 'fresh-old': 1000, 'fresh-new': 5000, disp: 9000 };

test('Find new repositories lists only the ones the config lacks, newest first, and never asks git about a display-only one', () => {
  const asked = [];
  const s = createSettings({ cwd: folder, lastCommitAt: (p) => (asked.push(basename(p)), WHEN[basename(p)] ?? null) });
  const r = s.found();
  assert.equal(r.editable, true);
  assert.deepEqual(r.repos.map((x) => x.label), ['fresh-new', 'fresh-old'], 'a listed repository, its worktree and the display-only one are left out');
  assert.deepEqual(r.repos.map((x) => x.lastAt), [5000, 1000]);
  assert.ok(r.repos.every((x) => x.role === 'featured'), 'a repository with my commits is suggested as featured');
  assert.ok(!asked.includes('disp'), 'git was asked about a display-only repository');
  // The other git question, whose commits these are, is never asked about it either.
  const authored = [];
  const quiet = createSettings({ cwd: folder, lastCommitAt: () => null, hasCommits: (p) => (authored.push(basename(p)), false) }).found();
  assert.ok(quiet.repos.every((x) => x.role === 'reference'), 'a repository without my commits is suggested as reference');
  assert.ok(authored.length > 0 && !authored.includes('disp'), 'git was asked about a display-only repository');
});

test("Settings' list carries each read repository's last commit, and none for a display-only one", () => {
  const asked = [];
  const s = createSettings({ cwd: folder, lastCommitAt: (p) => (asked.push(basename(p)), WHEN[basename(p)] ?? null) });
  const info = s.info();
  assert.deepEqual(info.repos.map((x) => [x.label, x.lastAt]), [['listed', 3000], ['disp', null]]);
  assert.ok(!asked.includes('disp'), 'git was asked about a display-only repository');
  // Failing-path partner: with no config, nothing is searched and the page says why.
  const none = createSettings({ cwd: parent }).found();
  assert.equal(none.editable, false);
  assert.match(none.note, /no honestweek\.config\.json/);
});

test('Find new repositories never asks git about a repository holding a display-only folder, nor offers it', () => {
  const top = join(parent, 'nested');
  mkdirSync(top);
  const mono = join(top, 'mono');
  mkdirSync(mono);
  git(mono, ['init', '-q']);
  mkdirSync(join(mono, 'private'));
  const other = join(top, 'other');
  mkdirSync(other);
  git(other, ['init', '-q']);
  const here = join(top, 'myweek');
  mkdirSync(here);
  writeFileSync(join(here, 'honestweek.config.json'), `${JSON.stringify({ identity: { authorEmails: [ME] }, repos: [{ path: '../other', label: 'other', role: 'featured' }, { path: '../mono/private', label: 'private', role: 'display' }] }, null, 2)}
`);
  const asked = [];
  const spy = (p) => (asked.push(basename(p)), null);
  const r = createSettings({ cwd: here, lastCommitAt: spy, hasCommits: (p) => spy(p) ?? false }).found();
  assert.equal(r.editable, true);
  assert.deepEqual(r.repos, [], 'mono holds a display-only folder, so it is not offered');
  assert.ok(!asked.includes('mono'), 'git was asked about a repository holding a display-only folder');
});
