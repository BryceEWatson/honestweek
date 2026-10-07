// A display-only folder must never sit inside a repository git reads, nor the reverse
// (issue 103, AGENTS.md invariant 4): git reading the parent reads every folder in it.
// init, Setup's save and Settings' save refuse such a list with one line and write nothing;
// sibling folders, and a display folder outside every read repository, are still accepted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { buildConfig, checkNestedRoles, existingDisplayRepos, findRepos, inferIdentity, runInit, writeInitFiles } from '../lib/init.mjs';
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

/** A project whose config marks `../mono/private`, a folder inside the sibling repository mono,
 *  display-only, beside an ordinary sibling repository (issue 117). */
function monoLayout(prefix) {
  const root = makeTempDir(prefix);
  const project = repo(join(root, 'project'));
  const mono = repo(join(root, 'mono'));
  const priv = folder(join(mono, 'private'));
  const other = repo(join(root, 'other'));
  const config = join(project, 'honestweek.config.json');
  writeFileSync(config, JSON.stringify({ identity: { authorEmails: [ME] }, repos: [{ path: project, label: 'project', role: 'featured' }, { path: '../mono/private', label: 'private', role: 'display' }] }));
  return { root, project, mono, priv, other, config };
}

test('findRepos never asks git about a repository holding a display-only folder, or inside one, and still asks an ordinary one', () => {
  const t = monoLayout('hw-nested-find-');
  try {
    const asked = [];
    const spy = (kind, answer) => (p) => (asked.push(`${kind} ${basename(p)}`), answer);
    const { repos } = findRepos(t.project, ME, { displayPaths: existingDisplayRepos(t.project), hasCommits: spy('commits', true), lastCommitAt: spy('last', 1000) });
    assert.ok(!asked.some((a) => a.endsWith(' mono')), `git was asked about mono: ${asked.join(', ')}`);
    // The failing-path partner: an ordinary sibling repository is still asked both questions.
    assert.ok(asked.includes('commits other') && asked.includes('last other'), asked.join(', '));
    assert.equal(repos.find((r) => r.label === 'other').role, 'featured');
    // mono is still listed, with the role it gets without asking, and the nested-role check explains it.
    const mono = repos.find((r) => r.label === 'mono');
    assert.deepEqual({ role: mono.role, lastAt: mono.lastAt }, { role: 'reference', lastAt: null });
    assert.match(checkNestedRoles([...repos, { path: t.priv, label: 'private', role: 'display' }]), /^private is display-only but sits inside mono, which git reads, so its history would be read too\./);

    // The folder it runs in, holding a display-only folder, isn't asked when it was last committed to.
    const own = [];
    findRepos(t.project, ME, { displayPaths: [folder(join(t.project, 'notes'))], hasCommits: () => true, lastCommitAt: (p) => (own.push(basename(p)), 1) });
    assert.ok(!own.includes('project') && own.includes('mono'), own.join(', '));
    // Repositories inside a display-only folder aren't asked at all, nor is one whose main
    // checkout is elsewhere but whose worktree found here is inside it.
    const elsewhere = makeTempDir('hw-nested-away-');
    try {
      const away = repo(join(elsewhere, 'away'));
      git(away, ['worktree', 'add', '-q', join(t.root, 'away-wt')]);
      const inside = [];
      const { repos: within } = findRepos(t.project, ME, { displayPaths: [t.root], hasCommits: (p) => (inside.push(p), true), lastCommitAt: (p) => (inside.push(p), 1) });
      assert.ok(within.some((r) => r.label === 'away'), 'the worktree is folded into its main checkout');
      assert.deepEqual(inside, []);
    } finally {
      removeTempDir(elsewhere);
    }
  } finally {
    removeTempDir(t.root);
  }
});

test('init refuses to rewrite a config so git would read a repository holding a display-only folder, and accepts marking it display', async () => {
  const t = monoLayout('hw-nested-rerun-');
  try {
    const before = readFileSync(t.config, 'utf8');
    for (const argv of [['--yes', '--force'], []]) {
      const io = fakeIo();
      assert.equal(await runInit({ cwd: t.project, argv, io, inferEmail: () => ME }), 1, io.stdout);
      assert.match(io.stderr, /^private is display-only but sits inside mono, which git reads/, argv.join(' '));
      assert.match(io.stderr, /Nothing was written\.\n$/);
      assert.equal(readFileSync(t.config, 'utf8'), before, 'nothing written');
    }
    // Marking mono display, as the line suggests, is accepted.
    const n = findRepos(t.project, ME, { displayPaths: existingDisplayRepos(t.project) }).repos.findIndex((r) => r.label === 'mono') + 1;
    const edits = [`role ${n} display`];
    const io = fakeIo();
    io.prompt = async (q) => (q.startsWith('Press Enter to keep this list') ? edits.shift() ?? '' : /Write .* now\?/.test(q) ? 'y' : '');
    assert.equal(await runInit({ cwd: t.project, io, inferEmail: () => ME }), 0, io.stderr);
    const written = JSON.parse(readFileSync(t.config, 'utf8')).repos;
    assert.equal(written.find((r) => r.label === 'mono').role, 'display');
  } finally {
    removeTempDir(t.root);
  }
});

test('Setup makes no repository list where a config already is, the only place display-only folders come from', async () => {
  // Setup lists repositories only while its folder has no config, so it has no display-only
  // folder to pass to findRepos; any list it makes goes through the findRepos test above.
  const t = monoLayout('hw-nested-setup-list-');
  try {
    const setup = createSetup({ cwd: t.project, inferEmail: () => ME });
    const info = setup.info();
    assert.equal(info.configured, true);
    assert.equal(info.repos, undefined, 'no repository list was made');
    assert.equal((await setup.preview('{}')).status, 409);
  } finally {
    removeTempDir(t.root);
  }
});

test('init asks the global git config for my email, not the folder it runs in, where that folder holds a display-only folder or sits inside one', () => {
  const t = monoLayout('hw-nested-email-');
  try {
    const usesGlobal = (cwd) => {
      let global;
      inferIdentity(cwd, { inferEmail: (_, o) => ((global = o.isDisplay), ME) });
      return global;
    };
    // The failing-path partner: a config marking a folder elsewhere display-only changes nothing here.
    writeFileSync(join(t.other, 'honestweek.config.json'), JSON.stringify({ repos: [{ path: '../mono/private', role: 'display' }] }));
    assert.equal(usesGlobal(t.other), false);
    // Holds one: this project's config marks a folder inside it display-only.
    folder(join(t.project, 'notes'));
    writeFileSync(t.config, JSON.stringify({ repos: [{ path: 'notes', role: 'display' }] }));
    assert.equal(usesGlobal(t.project), true);
    // Sits inside one: a repository whose config marks the folder around it display-only.
    const tool = repo(join(t.root, 'area', 'tool'));
    writeFileSync(join(tool, 'honestweek.config.json'), JSON.stringify({ repos: [{ path: '..', role: 'display' }] }));
    assert.equal(usesGlobal(tool), true);
  } finally {
    removeTempDir(t.root);
  }
});
