// A brand-new user's first commands, run through the real entry point (bin/honestweek.mjs) the
// way a person types them: `honestweek` with no arguments, `view` before any setup, `init` with
// its answers piped in, then `view --no-open` until its data is ready. No browser and no
// network. Each tree lives in its own temporary folder whose parent holds only that tree, so
// init's scan of the folders next to it stays small, and git and the log folders are pointed at
// temporary files, never the machine's own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDemoWeek, WEEK } from '../lib/demo/week.mjs';
import { NAMES_QUESTION, TERMS_QUESTION } from '../lib/init.mjs';
import { privateWordsNote } from '../lib/private-words.mjs';
import { pageCommand } from '../lib/invocation.mjs';
import { CODE_HEADER, KEY_HEADER } from '../lib/view/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'honestweek.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'hw-first-run-'));
const children = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  rmSync(scratch, { recursive: true, force: true });
});

// Every run here starts outside the repository, so the entry point prints its own path whole.
const slashed = BIN.replace(/\\/g, '/');
const FORM = `node ${/\s/.test(slashed) ? `"${slashed}"` : slashed}`;
const NO_PRIVATE_WORDS = privateWordsNote(FORM, { restart: false });

// A git identity of our own, and log folders with nothing in them.
const gitconfig = join(scratch, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\temail = you@example.com\n\tname = You\n[commit]\n\tgpgsign = false\n');
const emptyLogs = join(scratch, 'no-logs');
mkdirSync(emptyLogs);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CONFIG_DIR: emptyLogs, CODEX_HOME: emptyLogs };
for (const k of Object.keys(ENV)) if (/^npm_/i.test(k)) delete ENV[k];

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });

/** <root>/{workspace (empty, not a repo), alpha (a repo), alpha-wt (alpha's worktree), beta (a repo)}. */
function tree(name) {
  const root = join(scratch, name);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  for (const repo of ['alpha', 'beta']) {
    const dir = join(root, repo);
    mkdirSync(dir);
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, 'readme.txt'), repo);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'first']);
  }
  git(join(root, 'alpha'), ['worktree', 'add', '-q', join(root, 'alpha-wt'), '-b', 'side']);
  return { root, workspace };
}

/** Run the CLI to the end, with `input` piped to it in one chunk. */
function cli(args, { cwd, input = '' } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: ENV, input, encoding: 'utf8', timeout: 60e3 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

test('honestweek with no arguments starts with the three first commands, in the form it was run', () => {
  const { workspace } = tree('help');
  const none = cli([], { cwd: workspace });
  assert.equal(none.code, 0);
  assert.equal(cli(['--help'], { cwd: workspace }).out, none.out);
  const start = none.out.slice(none.out.indexOf('Start here:'), none.out.indexOf('Usage:'));
  for (const c of [`${FORM} view --demo`, `${FORM} init`, `${FORM} view`]) assert.ok(start.includes(`\n       ${c}\n`), `Start here names ${c}`);
  assert.ok(start.indexOf(' view --demo\n') < start.indexOf(' init\n') && start.indexOf(' init\n') < start.lastIndexOf(' view\n'), 'demo, then init, then view');
  assert.ok(none.out.includes(`Usage:\n  ${FORM} <command> [options]`));
  assert.doesNotMatch(none.out, /—|–| -- /, 'no em or en dashes');
});

test('view before any setup names init and the demo in the form it was run, and writes nothing', () => {
  const { workspace } = tree('no-config');
  const r = cli(['view'], { cwd: workspace });
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`Run ${FORM} init to set one up, or ${FORM} view --demo to look around a made-up week first.`), r.err);
  assert.deepEqual(readdirSync(workspace), []);
});

test('init with answers piped in: each question, the repositories with the worktree folded in, the private words, and view as the next step', () => {
  const { workspace } = tree('init-words');
  // Keep the list, use it, two names and a client word, then write.
  const r = cli(['init'], { cwd: workspace, input: '\ny\nDana Doe, Sam Lee\nAcme\n\n' });
  assert.equal(r.code, 0, r.err);
  const order = [
    'Nothing is written until you say yes.',
    'Found 2 git repositories. 1 more folder was an extra working copy (a git worktree) of one of them, so it\'s folded into its main repository',
    'Repositories honestweek may read (featured: read from git and shown first; reference: read from git; display: named only, never read from git):',
    "Press Enter to keep this list, or change it: 'keep 1-5 9' keeps only those, 'drop 3 7-9' removes those, 'role 2 display' changes a role: ",
    'Use these 2 repositories? [Y/n] ',
    'Private words: honestweek hides these in everything it shows and writes',
    NAMES_QUESTION,
    TERMS_QUESTION,
    'Private words: 2 names, 1 client or project word.',
    'Write honestweek.config.json now? [Y/n] ',
    `Next, find, check and replay your sessions in your browser:\n  ${FORM} view\n`,
    `For a weekly summary of last week, start with:\n  ${FORM} discover\n`,
  ];
  let at = 0;
  for (const line of order) {
    const i = r.out.indexOf(line, at);
    assert.ok(i >= at, `init shows, in order: ${line.slice(0, 70)}`);
    at = i + line.length;
  }
  const cfg = JSON.parse(readFileSync(join(workspace, 'honestweek.config.json'), 'utf8'));
  assert.deepEqual(cfg.repos.map((x) => x.label), ['alpha', 'beta'], 'the worktree is not a repository of its own');
  assert.deepEqual(cfg.redaction, { codenames: [], names: ['Dana Doe', 'Sam Lee'], terms: ['Acme'] });
  assert.ok(!r.out.includes(NO_PRIVATE_WORDS));
});

let skipped = null;
test('init with every question skipped says no private words are set, and still points to view', () => {
  const t = tree('init-skip');
  const r = cli(['init'], { cwd: t.workspace, input: '\n\n\n\n\n' });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(NO_PRIVATE_WORDS));
  assert.ok(r.out.includes(`\n  ${FORM} view\n`));
  const cfg = JSON.parse(readFileSync(join(t.workspace, 'honestweek.config.json'), 'utf8'));
  assert.deepEqual(cfg.redaction, { codenames: [], names: [], terms: [] });
  // Failing path: stdin that ends before the last question writes nothing and says why.
  const cut = tree('init-cut');
  const c = cli(['init'], { cwd: cut.workspace, input: '\ny\n' });
  assert.equal(c.code, 2);
  assert.ok(c.err.includes(`${FORM} init --yes`), c.err);
  assert.deepEqual(readdirSync(cut.workspace), []);
  skipped = t;
});

test("the note's way to get candidate private words works from a fresh setup: discover, then harvest", () => {
  assert.ok(skipped, 'the init test above wrote the config');
  const early = cli(['harvest'], { cwd: skipped.workspace });
  assert.equal(early.code, 1);
  assert.ok(early.err.includes(`Run ${FORM} discover first.`), early.err);
  const d = cli(['discover'], { cwd: skipped.workspace });
  assert.equal(d.code, 0, d.err);
  const h = cli(['harvest'], { cwd: skipped.workspace });
  assert.equal(h.code, 0, h.err);
  assert.match(h.out, /candidate noun\(s\) written to honestweek\.harvest\.json/);
  assert.match(h.out, /"names" for people, "terms" for clients and projects/);
  assert.ok(Array.isArray(JSON.parse(readFileSync(join(skipped.workspace, 'honestweek.harvest.json'), 'utf8')).candidates));
});

function get(port, path, headers = {}) {
  return new Promise((res, rej) => {
    const req = request({ host: '127.0.0.1', port, path, headers, agent: false }, (r) => {
      let text = '';
      r.on('data', (c) => (text += c));
      r.on('end', () => res({ status: r.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', rej);
    req.end();
  });
}

test('view --no-open after init: prints an address and the private-word notice, its code claims the key, the data gets ready, and it stops', async () => {
  assert.ok(skipped, 'the init test above wrote the config');
  const week = buildDemoWeek({ root: join(scratch, 'logs') });
  const env = { ...ENV, CLAUDE_CONFIG_DIR: dirname(week.roots.claude[0]), CODEX_HOME: dirname(week.roots.codex[0]) };
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--from', WEEK.from, '--to', WEEK.to], { cwd: skipped.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  for (let i = 0; i < 600 && !/#c=[0-9a-f]+/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]+)/.exec(out);
  assert.ok(m, `view printed an address: ${out}${err}`);
  assert.ok(out.includes(`then start ${FORM} view again.`), 'the terminal notice names how to start it again');
  const port = Number(m[1]);
  const claimed = await get(port, '/api/claim', { [CODE_HEADER]: m[2] });
  assert.equal(claimed.status, 200);
  const key = claimed.json.key;
  let s;
  for (let i = 0; i < 600; i++) {
    s = (await get(port, '/api/status', { [KEY_HEADER]: key })).json;
    if (s.state !== 'building') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(s.state, 'ready', s.failed ?? '');
  assert.equal(s.command, pageCommand(FORM), 'a page names the command without the folder it lives in');
  assert.match(s.privateWords.note, /^No private words are set up/);
  // Failing path: a code works once.
  assert.equal((await get(port, '/api/claim', { [CODE_HEADER]: m[2] })).status === 200, false);
  child.kill('SIGINT');
  const end = await exited;
  if (process.platform !== 'win32') {
    // Windows ends a process on SIGINT without running its handler; elsewhere view stops itself.
    assert.equal(end.code, 0);
    assert.match(out, /honestweek view: stopped\./);
  }
  await assert.rejects(get(port, '/api/status', { [KEY_HEADER]: key }), 'nothing answers once it has stopped');
});

test('the package an install would get holds the entry point and the pages', (t) => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let listed;
  try {
    listed = execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', timeout: 60e3 });
  } catch (e) {
    if (e.code === 'ENOENT') return t.skip('npm is not on the PATH');
    throw e;
  }
  const files = JSON.parse(listed.slice(listed.indexOf('[')))[0].files.map((f) => f.path.replace(/\\/g, '/'));
  for (const f of ['bin/honestweek.mjs', 'lib/invocation.mjs', 'lib/view.mjs', 'lib/view/assets/search.html', 'lib/view/assets/goal.html', 'lib/view/assets/replay.html', 'lib/view/assets/common.js', 'lib/view/assets/common.css', 'lib/view/selftest/clickthrough.html', 'lib/demo/week.mjs']) {
    assert.ok(files.includes(f), `the package holds ${f}`);
  }
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('.claude/')), 'no tests or local work in the package');
});
