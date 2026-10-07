// A display-only folder must never sit inside a repository git reads, nor the reverse
// (issue 103, AGENTS.md invariant 4): git reading the parent reads every folder in it.
// init, Setup's save and Settings' save refuse such a list with one line and write nothing;
// sibling folders, and a display folder outside every read repository, are still accepted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../lib/config.mjs';
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

/** `away` (a repository) beside `private` (a display-only repository), with a worktree of `away`
 *  at `wt` under `dir`, and away's honestweek.config.json listing both. */
const worktreeLayout = (dir, wt) => {
  const away = repo(join(dir, 'away'));
  const priv = repo(join(dir, 'private'));
  git(away, ['worktree', 'add', '-q', join(dir, wt)]);
  const file = join(away, 'honestweek.config.json');
  writeFileSync(file, JSON.stringify({ identity: { authorEmails: [ME] }, repos: [{ path: away, label: 'away', role: 'featured' }, { path: priv, label: 'private', role: 'display' }] }));
  return { away, priv, file };
};

test('a display-only folder holding a worktree of a repository git reads is refused at load, by Setup, by Settings and by init; a worktree beside it is accepted (issue 157)', async () => {
  const root = makeTempDir('hw-nested-wt-');
  try {
    const line = /^away is read by git but has a worktree, away-wt, inside private, which is display-only, so the work done there would be read too\. Move that worktree out of private, or mark away display as well\.$/;
    for (const [where, inside] of [['in', true], ['beside', false]]) {
      const { away, priv, file } = worktreeLayout(join(root, where), inside ? join('private', 'away-wt') : 'away-wt');
      const before = readFileSync(file, 'utf8');

      // Loading the config.
      if (inside) assert.throws(() => loadConfig(file), (err) => line.test(err.message.replace(/^honestweek config: "repos": /, '')));
      else assert.equal(loadConfig(file).repos.length, 2);

      // Setup's save, in a folder with no config yet.
      const fresh = folder(join(root, where, 'fresh'));
      const setup = createSetup({ cwd: fresh, inferEmail: () => ME });
      const s = await setup.save(JSON.stringify({ authorEmails: [ME], timezone: 'UTC', repos: [{ path: away, role: 'featured' }, { path: priv, role: 'display' }], names: '', terms: '' }));
      if (inside) {
        assert.equal(s.status, 400, JSON.stringify(s.body));
        assert.match(s.body.message, line);
        assert.equal(existsSync(join(fresh, 'honestweek.config.json')), false, 'nothing written');
      } else assert.equal(s.status, 200, JSON.stringify(s.body));

      // Settings' save, adding the display-only folder to a config that reads away.
      const own = folder(join(root, where, 'own'));
      writeInitFiles(own, buildConfig({ authorEmail: ME, timezone: 'UTC', repos: [{ path: away, label: 'away', role: 'featured' }] }), { force: true });
      const ownFile = join(own, 'honestweek.config.json');
      const ownBefore = readFileSync(ownFile, 'utf8');
      const settings = createSettings({ cwd: own });
      const i = settings.info();
      const base = { version: i.version, history: i.history, repos: i.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: i.authorEmails, names: i.names, terms: i.terms, goalsFile: i.goalsFile };
      const r = await settings.save(JSON.stringify({ ...base, repos: [...base.repos, { path: priv, label: 'private', role: 'display' }] }));
      if (inside) {
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.match(r.body.message, line);
        assert.equal(readFileSync(ownFile, 'utf8'), ownBefore, 'nothing written');
      } else assert.equal(r.status, 200, JSON.stringify(r.body));

      // init in away, which finds away and the display-only repository beside it.
      const io = fakeIo();
      const code = await runInit({ cwd: away, argv: ['--yes', '--force'], io, inferEmail: () => ME });
      if (inside) {
        assert.equal(code, 1, io.stdout);
        assert.match(io.stderr, /^away is read by git but has a worktree, away-wt, inside private, .* Nothing was written\.\n$/);
        assert.equal(io.stderr.split('\n').length, 2, 'one line');
        assert.equal(readFileSync(file, 'utf8'), before, 'nothing written');
      } else {
        assert.equal(code, 0, io.stderr);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).repos.map((x) => x.role).sort(), ['display', 'featured']);
      }
    }
  } finally {
    removeTempDir(root);
  }
});

test('the check finds a worktree inside a plain display-only folder, one whose folder is gone until git prunes it, and a main checkout inside one when a worktree is read', () => {
  const root = makeTempDir('hw-nested-wt-check-');
  try {
    // The layout issue 157 names: a plain folder, not a repository, holds the worktree.
    const away = repo(join(root, 'away'));
    const priv = folder(join(root, 'private'));
    assert.equal(checkNestedRoles([{ path: away, label: 'away', role: 'featured' }, { path: priv, label: 'private', role: 'display' }]), null);
    git(away, ['worktree', 'add', '-q', join(priv, 'away-wt')]);
    assert.match(checkNestedRoles([{ path: away, label: 'away', role: 'reference' }, { path: priv, label: 'private', role: 'display' }]), /^away is read by git but has a worktree, away-wt, inside private/);
    // A worktree whose folder is gone still counts until git prunes it.
    rmSync(join(priv, 'away-wt'), { recursive: true, force: true });
    assert.match(checkNestedRoles([{ path: away, label: 'away', role: 'featured' }, { path: priv, label: 'private', role: 'display' }]), /^away is read by git, which still lists a worktree of it, away-wt, inside private, .*Run git worktree prune in away/);
    git(away, ['worktree', 'prune']);
    assert.equal(checkNestedRoles([{ path: away, role: 'featured' }, { path: priv, role: 'display' }]), null);
    // Read through a worktree, a repository whose main checkout sits in a display-only folder.
    const main = repo(join(root, 'vault', 'main'));
    const wt = join(root, 'main-wt');
    git(main, ['worktree', 'add', '-q', wt]);
    assert.match(checkNestedRoles([{ path: wt, label: 'main-wt', role: 'featured' }, { path: join(root, 'vault'), label: 'vault', role: 'display' }]), /^main-wt is read by git but its main checkout, main, sits inside vault, which is display-only/);
    // A folder named only like the display folder isn't inside it.
    const near = repo(join(root, 'near'));
    git(near, ['worktree', 'add', '-q', join(root, 'private-wt')]);
    assert.equal(checkNestedRoles([{ path: near, role: 'featured' }, { path: priv, role: 'display' }]), null);
  } finally {
    removeTempDir(root);
  }
});
