// Rewriting a config with `init` keeps what the old one protected (issue 159): its display-only
// folders the new list doesn't show, and its private words. Otherwise a rewrite would let git read
// a folder the person marked display-only, or stop hiding words they listed. Only counts are
// printed, since a label or a word can be a client's name.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runInit } from '../lib/init.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const ME = 'you@example.com';
const git = (dir, args) => execFileSync('git', ['-C', dir, '-c', `user.email=${ME}`, '-c', 'user.name=You', '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const repo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'first']);
  return dir;
};
/** A terminal that answers each question with `reply(question)`. */
const terminal = (reply = () => '') => {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), prompt: async (q) => reply(q), close() {}, get stdout() { return out.join(''); }, get stderr() { return err.join(''); } };
};
const configOf = (dir) => JSON.parse(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'));
const writeConfig = (dir, config) => writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({ identity: { authorEmails: [ME] }, ...config }));
const EDIT = 'Press Enter to keep this list';

test('init --yes --force keeps a display-only folder it does not list, and the private words, printing only counts', async () => {
  const root = makeTempDir('hw-rewrite-yes-');
  try {
    const project = repo(join(root, 'code', 'project'));
    repo(join(root, 'code', 'other'));
    mkdirSync(join(root, 'far', 'client-x'), { recursive: true });
    const far = { path: '../../far/client-x', label: 'client-x', role: 'display' };
    writeConfig(project, { repos: [far], redaction: { names: ['Dana Doe', ' '], terms: ['Acme', 'Acme'], codenames: ['Bluebird'] }, privacy: { publicRenditions: { neverPublicTerms: ['Orchard'] } } });
    const io = terminal();
    assert.equal(await runInit({ cwd: project, argv: ['--yes', '--force'], io, inferEmail: () => ME }), 0, io.stderr);
    const written = configOf(project);
    assert.deepEqual(written.repos.find((r) => r.role === 'display'), far, 'kept as written');
    assert.deepEqual(written.redaction, { codenames: ['Bluebird'], names: ['Dana Doe'], terms: ['Acme'] }, 'a blank entry hides nothing and a repeat adds nothing, so neither is kept');
    assert.deepEqual(written.privacy.publicRenditions.neverPublicTerms, ['Orchard']);
    assert.match(io.stdout, /Keeping 1 display-only folder from your old config that this search didn't list\.\n/);
    assert.match(io.stdout, /Keeping the 4 private words your old config lists\.\n/);
    for (const secret of ['Dana Doe', 'Acme', 'Bluebird', 'Orchard', 'client-x']) assert.ok(!io.stdout.includes(secret) && !io.stderr.includes(secret), `${secret} is never printed`);
  } finally {
    removeTempDir(root);
  }
});

test('init keeps the display-only folder inside a repository the person drops, and adds new private words to the old ones', async () => {
  const root = makeTempDir('hw-rewrite-drop-');
  try {
    const project = repo(join(root, 'project'));
    const mono = repo(join(root, 'mono'));
    mkdirSync(join(mono, 'private'));
    writeConfig(project, { repos: [{ path: project, label: 'project', role: 'featured' }, { path: '../mono/private', label: 'private', role: 'display' }], redaction: { names: ['Dana Doe'], terms: [], codenames: ['Bluebird'] } });
    // The list is project, then mono; dropping mono leaves the display-only folder inside it unread.
    const edits = ['drop 2'];
    const io = terminal((q) => (q.startsWith(EDIT) ? edits.shift() ?? '' : q.startsWith("People's names") ? 'Sam Lee' : /Write .* now\?/.test(q) ? 'y' : ''));
    assert.equal(await runInit({ cwd: project, io, inferEmail: () => ME }), 0, io.stderr);
    const written = configOf(project);
    assert.deepEqual(written.repos.map((r) => [r.label, r.role]), [['project', 'featured'], ['private', 'display']]);
    assert.deepEqual(written.redaction.names, ['Dana Doe', 'Sam Lee']);
    assert.deepEqual(written.redaction.codenames, ['Bluebird']);
    assert.match(io.stdout, /Keeping 1 display-only folder from your old config that this search didn't list\.\n/);
    assert.match(io.stdout, /Your old config already lists 2 private words\. They stay; add any others below\./);
  } finally {
    removeTempDir(root);
  }
});

test('failing-path partner: a display-only repository the list shows follows the person\'s edit, and a first run keeps nothing', async () => {
  const root = makeTempDir('hw-rewrite-shown-');
  try {
    const project = repo(join(root, 'project'));
    const client = repo(join(root, 'client'));
    writeConfig(project, { repos: [{ path: client, label: 'client', role: 'display' }] });
    // The list is project, then client (display); making client featured is the person's call.
    const edits = ['role 2 featured'];
    const io = terminal((q) => (q.startsWith(EDIT) ? edits.shift() ?? '' : /Write .* now\?/.test(q) ? 'y' : ''));
    assert.equal(await runInit({ cwd: project, io, inferEmail: () => ME }), 0, io.stderr);
    assert.deepEqual(configOf(project).repos.map((r) => [r.label, r.role]), [['project', 'featured'], ['client', 'featured']]);
    assert.doesNotMatch(io.stdout, /Keeping/);

    const fresh = repo(join(root, 'fresh', 'project'));
    const first = terminal();
    assert.equal(await runInit({ cwd: fresh, argv: ['--yes'], io: first, inferEmail: () => ME }), 0, first.stderr);
    assert.doesNotMatch(first.stdout, /Keeping|old config/);
  } finally {
    removeTempDir(root);
  }
});

test('init keeps a display-only worktree the list does not show, though the list shows its repository', async () => {
  const root = makeTempDir('hw-rewrite-wt-');
  try {
    const project = repo(join(root, 'code', 'project'));
    const client = repo(join(root, 'code', 'client'));
    const tree = join(root, 'far', 'client-wt');
    git(client, ['worktree', 'add', '-q', '--detach', tree]);
    const wt = { path: tree, label: 'client-wt', role: 'display' };
    writeConfig(project, { repos: [{ path: client, label: 'client', role: 'display' }, wt] });
    const io = terminal();
    assert.equal(await runInit({ cwd: project, argv: ['--yes', '--force'], io, inferEmail: () => ME }), 0, io.stderr);
    const written = configOf(project);
    assert.deepEqual(written.repos.find((r) => r.label === 'client-wt'), wt, 'kept as written');
    assert.equal(written.repos.find((r) => r.label === 'client').role, 'display');
    assert.match(io.stdout, /Keeping 1 display-only folder from your old config/);
  } finally {
    removeTempDir(root);
  }
});

test('init stops before running git anywhere when the config there cannot be read (issue 171)', async () => {
  const root = makeTempDir('hw-rewrite-broken-');
  try {
    // The broken config marked the sibling repository display-only; init can't know that.
    const project = repo(join(root, 'project'));
    repo(join(root, 'client'));
    const broken = '{ "repos": [{ "path": "../client", "role": "display" }], "redaction": { "names": ["Dana Doe"], } }';
    const file = join(project, 'honestweek.config.json');
    writeFileSync(file, broken);
    for (const argv of [['--yes'], ['--yes', '--force'], []]) {
      let asked = false;
      const io = terminal(() => 'y');
      assert.equal(await runInit({ cwd: project, argv, io, inferEmail: () => ((asked = true), ME) }), 1, argv.join(' '));
      assert.match(io.stderr, /^honestweek\.config\.json is here but can't be read \(not valid JSON\), so init can't tell which folders you marked display-only, and it runs git nowhere until it can\. Fix the file, or move it away to start fresh, then run init again\. Nothing was written\.\n$/);
      assert.ok(!asked, 'git was never asked for the email');
      assert.doesNotMatch(io.stdout, /Looking for git repositories/, 'the search never started');
      assert.equal(readFileSync(file, 'utf8'), broken, 'nothing written');
      assert.ok(!existsSync(join(project, '.gitignore')) && !existsSync(join(project, 'honestweek.config.example.json')), 'no other file written');
      assert.ok(!io.stderr.includes('Dana Doe') && !io.stdout.includes('Dana Doe'));
    }
  } finally {
    removeTempDir(root);
  }
});

test('init counts kept neverPublicTerms as private words and ignores the config, but still warns they show in its own pages', async () => {
  const root = makeTempDir('hw-rewrite-never-');
  try {
    const project = repo(join(root, 'project'));
    writeConfig(project, { repos: [], privacy: { publicRenditions: { neverPublicTerms: ['Orchard'] } } });
    const io = terminal((q) => (/Write .* now\?/.test(q) ? 'y' : ''));
    assert.equal(await runInit({ cwd: project, io, inferEmail: () => ME }), 0, io.stderr);
    assert.deepEqual(configOf(project).privacy.publicRenditions.neverPublicTerms, ['Orchard']);
    assert.match(io.stdout, /Your old config already lists 1 private word\./);
    assert.match(io.stdout, /Private words: 0 names, 1 client or project word\./);
    assert.doesNotMatch(io.stdout, /No private words are set up/, 'it does not say none are set up after counting one');
    assert.match(io.stdout, /Your config keeps 1 word out of public versions only, so names and client words in your logs, that one included, show as written in your own pages/, 'it still warns that nothing hides words in its own pages');
    assert.match(readFileSync(join(project, '.gitignore'), 'utf8'), /^honestweek\.config\.json$/m, 'a config holding a never-public word stays out of git');
    assert.ok(!io.stdout.includes('Orchard'));
  } finally {
    removeTempDir(root);
  }
});
