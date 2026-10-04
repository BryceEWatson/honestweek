// A display-only folder must never sit inside a repository git reads, nor the reverse
// (issue 103, AGENTS.md invariant 4): git reading the parent reads every folder in it.
// init, Setup's save and Settings' save refuse such a list with one line and write nothing;
// sibling folders, and a display folder outside every read repository, are still accepted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildConfig, checkNestedRoles, runInit, writeInitFiles } from '../lib/init.mjs';
import { createSetup } from '../lib/view/setup.mjs';
import { createSettings } from '../lib/view/settings.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const ME = 'you@example.com';
const git = (dir, args) => execFileSync('git', ['-C', dir, '-c', `user.email=${ME}`, '-c', 'user.name=You', '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const repo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'first']);
  return dir;
};
const folder = (dir) => (mkdirSync(dir, { recursive: true }), dir);
/** A link to `target` at `path`: a junction on Windows, which needs no extra rights. False when this machine can't make one. */
const link = (target, path) => {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
};
const fakeIo = () => {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), prompt: async () => '', close() {}, get stdout() { return out.join(''); }, get stderr() { return err.join(''); } };
};

test('the check: a display folder inside a read repository, or a read one inside a display folder, is refused; siblings and outside folders pass', () => {
  const root = makeTempDir('hw-nested-');
  try {
    const app = repo(join(root, 'app'));
    const inner = folder(join(app, 'client-notes'));
    const nestedRepo = repo(join(root, 'private', 'tool'));
    const sibling = folder(join(root, 'sibling'));
    const outside = repo(join(root, 'elsewhere'));
    assert.match(checkNestedRoles([{ path: app, label: 'app', role: 'featured' }, { path: inner, label: 'notes', role: 'display' }]), /^notes is display-only but sits inside app, which git reads/);
    assert.match(checkNestedRoles([{ path: app, label: 'app', role: 'reference' }, { path: inner, label: 'notes', role: 'display' }]), /sits inside app/);
    assert.match(checkNestedRoles([{ path: join(root, 'private'), label: 'private', role: 'display' }, { path: nestedRepo, label: 'tool', role: 'featured' }]), /^tool is read by git but sits inside private, which is display-only/);
    // A display folder inside another worktree of a read repository is read with it.
    const wt = join(root, 'app-wt');
    git(app, ['worktree', 'add', '-q', wt]);
    const wtNotes = folder(join(wt, 'client-notes'));
    assert.match(checkNestedRoles([{ path: app, label: 'app', role: 'featured' }, { path: wtNotes, label: 'wt-notes', role: 'display' }]), /sits inside app/);
    // Accepted: siblings, a display folder outside every read repository, and all-display nesting.
    assert.equal(checkNestedRoles([{ path: app, role: 'featured' }, { path: sibling, role: 'display' }, { path: outside, role: 'reference' }]), null);
    assert.equal(checkNestedRoles([{ path: join(root, 'private'), role: 'display' }, { path: nestedRepo, role: 'display' }]), null);
    // A folder whose name only starts like the repository's isn't inside it.
    assert.equal(checkNestedRoles([{ path: app, role: 'featured' }, { path: folder(join(root, 'app-notes')), role: 'display' }]), null);
  } finally {
    removeTempDir(root);
  }
});

test('the check follows a junction or symlink to the real folder', (t) => {
  const root = makeTempDir('hw-nested-link-');
  try {
    const app = repo(join(root, 'app'));
    const inner = folder(join(app, 'client-notes'));
    const via = join(root, 'notes-link');
    if (!link(inner, via)) return t.skip('this machine cannot make a folder link');
    assert.match(checkNestedRoles([{ path: app, label: 'app', role: 'featured' }, { path: via, label: 'notes-link', role: 'display' }]), /^notes-link is display-only but sits inside app/);
  } finally {
    removeTempDir(root);
  }
});

test('Setup refuses a display folder inside a read repository with one line and writes nothing, and saves a sibling one', async () => {
  const root = makeTempDir('hw-nested-setup-');
  try {
    const project = repo(join(root, 'project'));
    const inner = folder(join(project, 'client-notes'));
    const sibling = folder(join(root, 'client-notes'));
    const setup = createSetup({ cwd: project, inferEmail: () => ME });
    const answer = (display) => JSON.stringify({ authorEmails: [ME], timezone: 'UTC', repos: [{ path: project, role: 'featured' }, { path: display, role: 'display' }], names: '', terms: '' });
    const refused = await setup.save(answer(inner));
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.message, /^client-notes is display-only but sits inside project, which git reads/);
    assert.doesNotMatch(refused.body.message, /\n/, 'one line');
    assert.equal(existsSync(join(project, 'honestweek.config.json')), false, 'nothing written');
    const saved = await setup.save(answer(sibling));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(JSON.parse(readFileSync(join(project, 'honestweek.config.json'), 'utf8')).repos[1].role, 'display');
  } finally {
    removeTempDir(root);
  }
});

test('Settings refuses either nesting with one line and leaves the file as it was', async () => {
  const root = makeTempDir('hw-nested-settings-');
  try {
    const project = repo(join(root, 'project'));
    const priv = folder(join(root, 'private'));
    const tool = repo(join(priv, 'tool'));
    const config = buildConfig({ authorEmail: ME, timezone: 'UTC', repos: [{ path: project, label: 'project', role: 'featured' }, { path: priv, label: 'private', role: 'display' }] });
    writeInitFiles(project, config, { force: true });
    const file = join(project, 'honestweek.config.json');
    const before = readFileSync(file, 'utf8');
    const settings = createSettings({ cwd: project });
    const i = settings.info();
    const base = { version: i.version, history: i.history, repos: i.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: i.authorEmails, names: i.names, terms: i.terms, goalsFile: i.goalsFile };
    for (const [added, line] of [
      [{ path: tool, role: 'featured' }, /^tool is read by git but sits inside private, which is display-only/],
      [{ path: folder(join(project, 'client-notes')), role: 'display' }, /^client-notes is display-only but sits inside project/],
    ]) {
      const r = await settings.save(JSON.stringify({ ...base, repos: [...base.repos, added] }));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.message, line);
      assert.doesNotMatch(r.body.message, /\n/);
      assert.equal(readFileSync(file, 'utf8'), before, 'nothing written');
    }
    // A display folder outside every read repository is still accepted.
    const ok = await settings.save(JSON.stringify({ ...base, repos: [...base.repos, { path: folder(join(root, 'notes')), role: 'display' }] }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.saved, true);
  } finally {
    removeTempDir(root);
  }
});

test('init refuses a display repository inside the read one it finds, writes nothing, and accepts siblings', async () => {
  const root = makeTempDir('hw-nested-init-');
  try {
    // Started in a worktree kept inside its main checkout, init lists the main checkout and the
    // repository nested beside the worktree, which the config marks display-only.
    const app = repo(join(root, 'app'));
    const wt = join(app, 'wt');
    git(app, ['worktree', 'add', '-q', wt]);
    const vendored = repo(join(app, 'vendored'));
    const config = join(wt, 'honestweek.config.json');
    writeFileSync(config, JSON.stringify({ identity: { authorEmails: [ME] }, repos: [{ path: vendored, label: 'vendored', role: 'display' }] }));
    const before = readFileSync(config, 'utf8');
    const io = fakeIo();
    assert.equal(await runInit({ cwd: wt, argv: ['--yes', '--force'], io, inferEmail: () => ME }), 1, io.stdout);
    assert.match(io.stderr, /^vendored is display-only but sits inside app, which git reads/);
    assert.match(io.stderr, /Nothing was written\.\n$/);
    assert.equal(io.stderr.split('\n').length, 2, 'one line');
    assert.equal(readFileSync(config, 'utf8'), before, 'nothing written');

    // Siblings: a display repository beside the project is accepted.
    const code = folder(join(root, 'code'));
    const project = repo(join(code, 'project'));
    const beside = repo(join(code, 'client'));
    writeFileSync(join(project, 'honestweek.config.json'), JSON.stringify({ identity: { authorEmails: [ME] }, repos: [{ path: beside, label: 'client', role: 'display' }] }));
    const io2 = fakeIo();
    assert.equal(await runInit({ cwd: project, argv: ['--yes', '--force'], io: io2, inferEmail: () => ME }), 0, io2.stderr);
    const written = JSON.parse(readFileSync(join(project, 'honestweek.config.json'), 'utf8'));
    assert.deepEqual(written.repos.map((r) => r.role).sort(), ['display', 'featured']);
  } finally {
    removeTempDir(root);
  }
});
