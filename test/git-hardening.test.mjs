// How honestweek runs git: a repository's own config can't make git start a program or
// fetch, a value from a log or a summary can't reach git as an option, a large history
// isn't read as an empty one, the parent's GIT_* variables can't point git elsewhere, and a
// display-only repository can't be listed as one git reads. Every repository here is made
// up, in a temp folder.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commitMessage,
  commitReachableFrom,
  commitsInWindow,
  gitEnv,
  landedCommitsInWindow,
  lookupCommit,
  repoMetricsInWindow,
  runGit,
  verifyItems,
} from '../lib/git.mjs';
import { findRepos, runInit } from '../lib/init.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createSettings } from '../lib/view/settings.mjs';
import { createInsights, stopTree } from '../lib/view/insights.mjs';
import { runBuild } from '../lib/build.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const ME = 'you@example.com';
const fwd = (p) => p.replace(/\\/g, '/');
const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
const commitEnv = (t = 1717200000) => ({ ...env0, GIT_AUTHOR_NAME: 'You', GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: 'You', GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` });
const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: commitEnv(), ...opts }).trim();

function newRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--template=']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, message = 'work', t = 1717200000) {
  git(dir, ['commit', '-q', '--allow-empty', '-m', message], { env: commitEnv(t) });
  return git(dir, ['rev-parse', 'HEAD']);
}

// ---- hostile neighbours ---------------------------------------------------------------------

let parent;
let home;
let marker;
let signedRepo;
let signedSha;

/** A program git would start: it notes that it ran, and fails. */
function hookProgram(dir) {
  const p = join(dir, 'hook.sh');
  writeFileSync(p, `#!/bin/sh\necho ran >> "${fwd(marker)}"\nexit 1\n`, { mode: 0o755 });
  return fwd(p);
}

before(() => {
  parent = makeTempDir('hw-harden-');
  marker = join(parent, 'marker.txt');
  const hook = hookProgram(parent);

  // My own repository, where init runs.
  home = newRepo(join(parent, 'home'));
  commit(home, 'mine');

  // A partial clone whose branch points at a commit it doesn't have: reading the branch makes
  // git fetch the commit from its promisor remote, over a transport that runs `hook`.
  const pc = newRepo(join(parent, 'partial'));
  git(pc, ['config', 'core.repositoryformatversion', '1']);
  git(pc, ['config', 'extensions.partialClone', 'origin']);
  git(pc, ['config', 'remote.origin.url', 'ssh://example.invalid/x']);
  git(pc, ['config', 'remote.origin.promisor', 'true']);
  git(pc, ['config', 'core.sshCommand', `"${hook}"`]);
  git(pc, ['config', 'protocol.allow', 'always']);
  mkdirSync(join(pc, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(pc, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`);

  // A repository with a signed commit by me, set to check signatures with `hook`.
  signedRepo = newRepo(join(parent, 'signed'));
  const tree = git(signedRepo, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
  const body = `tree ${tree}\nauthor You <${ME}> 1717200000 +0000\ncommitter You <${ME}> 1717200000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned work (#7)\n`;
  signedSha = git(signedRepo, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: body });
  git(signedRepo, ['update-ref', 'refs/heads/main', signedSha]);
  git(signedRepo, ['config', 'log.showSignature', 'true']);
  git(signedRepo, ['config', 'gpg.program', hook]);
  git(signedRepo, ['config', 'gpg.ssh.program', hook]);
  git(signedRepo, ['config', 'core.fsmonitor', hook]);
});

const ran = () => existsSync(marker);
const clearMarker = () => rmSync(marker, { force: true });

test('the hostile repositories do run their programs under plain git (the test can fail)', () => {
  clearMarker();
  try {
    execFileSync('git', ['-C', join(parent, 'partial'), 'for-each-ref', '--sort=-committerdate', 'refs/heads'], { stdio: 'ignore', env: env0 });
  } catch {
    /* the fetch fails; the program already ran */
  }
  assert.ok(ran(), 'the partial clone started its transport program');
  clearMarker();
  execFileSync('git', ['-C', signedRepo, 'show', '-s', '--format=%H', signedSha], { stdio: 'ignore', env: env0 });
  assert.ok(ran(), 'the signed commit started gpg.program');
  clearMarker();
});

test('findRepos, init and Settings\' "Find new repositories" start no program a neighbour\'s config names', async () => {
  clearMarker();
  const { repos } = findRepos(home, ME);
  assert.ok(repos.some((r) => r.label === 'signed' && r.role === 'featured'), 'my commit in the signed repository was still found');
  assert.ok(!ran(), 'findRepos started a program');

  const io = { outBuf: '', errBuf: '', out(s) { this.outBuf += s; }, err(s) { this.errBuf += s; }, exit: (c) => c, prompt: async () => '' };
  await runInit({ cwd: home, argv: ['--yes'], io, inferEmail: () => ME });
  assert.ok(existsSync(join(home, 'honestweek.config.json')), io.errBuf);
  assert.ok(!ran(), 'init started a program');

  const found = createSettings({ cwd: home }).found();
  assert.equal(found.editable, true);
  assert.ok(!ran(), 'Settings\' find started a program');
});

test('the commit lookups start no program a repository\'s config names', () => {
  clearMarker();
  assert.equal(lookupCommit(signedRepo, signedSha, [ME]).byAuthor, true);
  assert.match(commitMessage(signedRepo, signedSha), /signed work/);
  assert.equal(commitsInWindow(signedRepo, [ME], '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z').length, 1);
  assert.equal(repoMetricsInWindow(signedRepo, [ME], '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z').commits, 1);
  assert.equal(landedCommitsInWindow(signedRepo, [ME], '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z').commits[0].pr, 7);
  assert.equal(commitReachableFrom(signedRepo, signedSha, ['refs/heads/main']), true);
  assert.ok(!ran(), 'a commit lookup started a program');
  // The partial clone: its missing commit is never fetched, and reads as unreadable, not empty.
  assert.equal(lookupCommit(join(parent, 'partial'), '1'.repeat(40), [ME]).resolved, false);
  assert.equal(repoMetricsInWindow(join(parent, 'partial'), [ME], '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z'), null);
  assert.ok(!ran(), 'a lookup in the partial clone fetched');
});

// ---- commit ids that aren't commit ids ------------------------------------------------------

test('a commit id that is really an option never reaches git, and is never found', () => {
  const repo = newRepo(join(parent, 'ids'));
  const sha = commit(repo, 'real');
  const out = join(parent, 'written-by-git.txt');
  for (const bad of [`--output=${out}`, `--format=${sha}`, '-p', 'HEAD', 'main', `${sha.slice(0, 7)}..HEAD`, '', null, 12345, `${sha}\n--output=${out}`]) {
    const r = lookupCommit(repo, bad, [ME]);
    assert.equal(r.resolved, false, `${String(bad)} was looked up`);
    assert.equal(r.byAuthor, false);
    assert.equal(commitMessage(repo, bad), null);
    assert.equal(commitReachableFrom(repo, bad, ['refs/heads/main']), false);
  }
  assert.ok(!existsSync(out), 'git wrote a file');
  // Failing-path partner: a real id, full or short, still resolves.
  assert.equal(lookupCommit(repo, sha, [ME]).resolved, true);
  assert.equal(lookupCommit(repo, sha.slice(0, 7).toUpperCase(), [ME]).sha, sha);
  assert.equal(commitReachableFrom(repo, sha, ['refs/heads/main']), true);
});

test('verifyItems fails an item whose commit id is an option, and build exits 2 writing nothing', async () => {
  const repo = newRepo(join(parent, 'forged'));
  const sha = commit(repo, 'real', Date.parse('2024-06-12T10:00:00Z') / 1000);
  const out = join(parent, 'forged-written.txt');
  const config = { identity: { authorEmails: [ME] }, repos: [{ path: repo, label: 'r', role: 'featured' }] };
  for (const bad of [`--output=${out}`, `--format=${sha}`]) {
    const v = verifyItems([{ id: 'i1', repo: 'r', primaryCommit: bad }], config);
    assert.equal(v.ok, false, `${bad} verified`);
    assert.equal(v.verified.length, 0);
    assert.match(v.problems[0].reason, /does not resolve/);
  }
  assert.ok(verifyItems([{ id: 'i1', repo: 'r', primaryCommit: sha }], config).ok, 'a real commit still verifies');

  const work = join(parent, 'forged-work');
  mkdirSync(work);
  const outFile = join(work, 'out.md');
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({ ...config, week: { startsOn: 'monday', timezone: 'UTC' }, redaction: { codenames: [], names: [], terms: [] }, output: { mode: 'digest', file: outFile } }));
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({ week: { start: '2024-06-10', end: '2024-06-16' }, items: [{ id: 'i1', repo: 'r', summary: 'Shipped it.', primaryCommit: `--format=${sha}` }] }));
  const io = { buf: '', out(s) { this.buf += s; }, err(s) { this.buf += s; }, exit: (c) => c };
  const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
  assert.equal(code, 2, io.buf);
  assert.ok(!existsSync(outFile), 'build wrote output');
  assert.ok(!existsSync(out));
});

test('the replay engine records no outcome for a logged commit id that is an option, and git writes nothing', async () => {
  const dir = join(parent, 'replay');
  const repo = newRepo(join(dir, 'your-project'));
  const t = Date.parse('2025-03-11T09:00:00Z') / 1000;
  const sha = commit(repo, 'real', t);
  const out = join(dir, 'written-by-git.txt');
  const id = '12121212-3434-4565-8787-909090909091';
  const at = (s) => new Date((t + s) * 1000).toISOString();
  const rec = (type, extra, when, uuid) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: repo, sessionId: id, version: '2.1.0', gitBranch: 'main', type, uuid, timestamp: when, ...extra });
  const call = (n, sha) => [
    rec('assistant', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: { command: 'git commit -m "real"' } }] } }, at(n * 10), `aaaaaaaa-0000-4000-8000-00000000000${n}`),
    rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: '' }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha, kind: 'committed' } } } }, at(n * 10 + 1), `bbbbbbbb-0000-4000-8000-00000000000${n}`),
  ];
  const lines = [
    rec('user', { message: { role: 'user', content: 'Commit it.' }, origin: { kind: 'human' } }, at(0), 'aaaaaaaa-0000-4000-8000-000000000000'),
    ...call(1, `--output=${out}`),
    ...call(2, `--format=${sha}`),
    ...call(3, sha),
  ];
  const projects = join(dir, 'claude', 'projects', '-your-project');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${id}.jsonl`), `${lines.join('\n')}\n`);
  const config = normalizeConfig({ identity: { authorEmails: [ME] }, week: { startsOn: 'monday', timezone: 'UTC' }, repos: [{ path: repo, label: 'your-project', role: 'featured' }], redaction: { codenames: [], names: [], terms: [] } }, { configDir: dir });
  const h = await buildWorkHistory({ config, from: '2025-03-10', to: '2025-03-16', timezone: 'UTC', roots: { claude: [join(dir, 'claude', 'projects')], codex: [] } });
  assert.ok(!existsSync(out), 'git wrote a file');
  const exists = h.events.filter((e) => e.kind === 'outcome' && e.facts.outcome === 'commit-exists');
  assert.deepEqual(exists.map((e) => e.facts.sha), [sha.slice(0, 12)], 'only the real commit is a recorded outcome');
  const recorded = h.events.filter((e) => e.kind === 'action' && e.facts.git?.commit).map((e) => e.facts.git.commit.sha);
  assert.deepEqual(recorded, [sha]);
});

// ---- a large history ------------------------------------------------------------------------

test('a history larger than git\'s output limit reads as unreadable, never as zero commits', () => {
  const repo = newRepo(join(parent, 'big'));
  const N = 3000;
  const base = Date.parse('2024-06-12T00:00:00Z') / 1000;
  let stream = '';
  for (let i = 1; i <= N; i++) {
    const msg = `commit ${i}`;
    stream += `commit refs/heads/main\nmark :${i}\nauthor You <${ME}> ${base + i} +0000\ncommitter You <${ME}> ${base + i} +0000\ndata ${msg.length}\n${msg}\n${i > 1 ? `from :${i - 1}\n` : ''}\n`;
  }
  git(repo, ['fast-import', '--quiet'], { input: stream });
  const window = ['2024-06-10T00:00:00Z', '2024-06-16T23:59:59Z'];
  // Git's output for this history is far past 64 KiB.
  const small = { maxBuffer: 64 * 1024 };
  assert.equal(repoMetricsInWindow(repo, [ME], ...window, small), null);
  assert.equal(landedCommitsInWindow(repo, [ME], ...window, small), null);
  assert.throws(() => commitsInWindow(repo, [ME], ...window, small), /could not read/);
  assert.equal(runGit(repo, ['log', '--format=%H'], small).unreadable, true);
  // A call stopped for time is unreadable too.
  assert.equal(repoMetricsInWindow(repo, [ME], ...window, { timeout: 1 }), null);
  // Failing-path partner: with the default limit every commit counts.
  assert.deepEqual(repoMetricsInWindow(repo, [ME], ...window), { commits: N, activeDays: 1 });
  assert.equal(landedCommitsInWindow(repo, [ME], ...window).commits.length, N);
  // And a repository with no commits yet is still an empty week, not unreadable.
  const empty = newRepo(join(parent, 'empty'));
  assert.deepEqual(repoMetricsInWindow(empty, [ME], ...window), { commits: 0, activeDays: 0 });
});

// ---- the parent's GIT_* variables -----------------------------------------------------------

test('a GIT_* variable from the parent can\'t point git at another repository', () => {
  const a = newRepo(join(parent, 'env-a'));
  const shaA = commit(a, 'in a', 1717200001);
  const b = newRepo(join(parent, 'env-b'));
  const shaB = commit(b, 'in b', 1717200002);
  const saved = { ...process.env };
  try {
    process.env.GIT_DIR = join(b, '.git');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'log.showSignature';
    process.env.GIT_CONFIG_VALUE_0 = 'true';
    process.env.GIT_CONFIG_GLOBAL = join(parent, 'my.gitconfig');
    assert.equal(lookupCommit(a, shaA, [ME]).resolved, true);
    assert.equal(lookupCommit(a, shaB, [ME]).resolved, false, 'GIT_DIR sent the lookup to another repository');
    const env = gitEnv();
    for (const k of ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) assert.equal(env[k], undefined, `${k} reached git`);
    assert.equal(env.GIT_CONFIG_GLOBAL, join(parent, 'my.gitconfig'), 'where my own global config lives is kept');
    assert.equal(env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// ---- display-only repositories in a hand-written config -------------------------------------

test('a config listing one repository as both display and read is refused when it loads', () => {
  const repo = newRepo(join(parent, 'shown'));
  commit(repo, 'x');
  const wt = join(parent, 'shown-wt');
  git(repo, ['worktree', 'add', '-q', '-b', 'side', wt]);
  const base = { identity: { authorEmails: [ME] } };
  const load = (repos) => () => normalizeConfig({ ...base, repos }, { configDir: parent });
  // The same folder, featured and display.
  assert.throws(load([{ path: repo, label: 'a', role: 'featured' }, { path: repo, label: 'b', role: 'display' }]), /same repository, and one is marked display/);
  // A featured worktree of a display-only repository.
  assert.throws(load([{ path: repo, label: 'a', role: 'display' }, { path: wt, label: 'b', role: 'featured' }]), /same repository, and one is marked display/);
  // A display folder inside a read one.
  mkdirSync(join(repo, 'sub'), { recursive: true });
  assert.throws(load([{ path: repo, label: 'a', role: 'reference' }, { path: join(repo, 'sub'), label: 'b', role: 'display' }]), /display-only but sits inside/);
  // Failing-path partners: both display, or each on its own, load.
  assert.equal(load([{ path: repo, label: 'a', role: 'display' }, { path: wt, label: 'b', role: 'display' }])().repos.length, 2);
  assert.equal(load([{ path: wt, label: 'b', role: 'featured' }])().repos.length, 1);
});

// ---- Windows programs by full path ----------------------------------------------------------

test('on Windows, cmd.exe and taskkill.exe are named by their full path when ComSpec and SystemRoot are unset', async () => {
  const bin = join(parent, 'claude-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude.CMD'), '@echo off\r\n');
  const started = [];
  const spawnFn = (cmd, args) => {
    started.push(cmd);
    const c = new EventEmitter();
    c.pid = 4242;
    c.kill = () => {};
    return c;
  };
  const env = { PATH: bin, PATHEXT: '.CMD' };
  const ins = createInsights({ on: true, env, platform: 'win32', cwd: parent, spawnFn });
  assert.equal((await ins.run()).status, 200);
  assert.equal(started[0], 'C:\\Windows\\System32\\cmd.exe');
  stopTree({ pid: 4242, kill() {} }, { platform: 'win32', env: {}, spawnFn });
  assert.equal(started.at(-1), 'C:\\Windows\\System32\\taskkill.exe');
  stopTree({ pid: 4242, kill() {} }, { platform: 'win32', env: { SystemRoot: 'D:\\Win' }, spawnFn });
  assert.equal(started.at(-1), 'D:\\Win\\System32\\taskkill.exe');
  ins.stop?.();
});

test('no git call in lib/ or bin/ bypasses the hardened helper', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name)) {
        const src = readFileSync(p, 'utf8');
        // A git program started directly, by any child_process call.
        if (/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*['"`]git['"`]/.test(src) && !/lib[\\/]git\.mjs$/.test(p)) offenders.push(p);
      }
    }
  };
  for (const d of ['lib', 'bin']) walk(join(dirname(fileURLToPath(import.meta.url)), '..', d));
  assert.deepEqual(offenders, []);
});

