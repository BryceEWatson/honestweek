import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runInit,
  discoverRepos,
  buildConfig,
  ensureGitignore,
  inferAuthorEmail,
} from '../lib/init.mjs';
import { loadConfig } from '../lib/config.mjs';

const ME = 'me@example.com';
const OTHER = 'other@example.test';

let counter = 0;
function git(dir, args, env) {
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepoWithCommit(dir, email) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', email]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev' };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'init'], env);
}

function setupTree() {
  const parent = mkdtempSync(join(tmpdir(), 'hw-init-'));
  const cwd = join(parent, 'myproj');
  const sibA = join(parent, 'sibA');
  const plain = join(parent, 'plaindir');
  mkdirSync(cwd);
  mkdirSync(sibA);
  mkdirSync(plain);
  initRepoWithCommit(cwd, ME);
  initRepoWithCommit(sibA, OTHER);
  writeFileSync(join(plain, 'readme.txt'), 'not a repo');
  return { parent, cwd, sibA, plain };
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore Windows lock on teardown */
  }
}

function fakeIo(answers = []) {
  const queue = [...answers];
  const io = {
    outBuf: '',
    errBuf: '',
    out(s) { io.outBuf += s; },
    err(s) { io.errBuf += s; },
    async prompt() { return queue.length ? queue.shift() : ''; },
  };
  return io;
}

test('discoverRepos finds parent-sibling + current git repos, not non-git dirs, no recursion', () => {
  const t = setupTree();
  try {
    const repos = discoverRepos(t.cwd, ME);
    const labels = repos.map((r) => r.label).sort();
    assert.deepEqual(labels, ['myproj', 'sibA']);
    const byLabel = Object.fromEntries(repos.map((r) => [r.label, r]));
    assert.equal(byLabel.myproj.role, 'featured', 'cwd defaults to featured');
    assert.equal(byLabel.sibA.role, 'reference', 'a repo with no commit by the author defaults to reference');
    assert.ok(!labels.includes('plaindir'), 'non-git dir is not discovered');
  } finally {
    cleanup(t.parent);
  }
});

test('--yes writes a schema-valid config, the example, and the gitignore entry', async () => {
  const t = setupTree();
  try {
    const io = fakeIo();
    const c = await runInit({ cwd: t.cwd, argv: ['--yes'], io });
    assert.equal(c, 0);
    const cfgPath = join(t.cwd, 'honestweek.config.json');
    assert.ok(existsSync(cfgPath));
    const cfg = loadConfig(cfgPath); // must validate without error
    assert.deepEqual(cfg.identity.authorEmails, [ME]);
    assert.equal(cfg.week.startsOn, 'monday');
    assert.ok(cfg.week.timezone.length > 0);
    assert.equal(cfg.output.mode, 'post');
    assert.equal(cfg.repos.find((r) => r.label === 'myproj').role, 'featured');

    // example written, clean-room (empty term-lists, placeholder paths)
    const example = JSON.parse(readFileSync(join(t.cwd, 'honestweek.config.example.json'), 'utf8'));
    assert.deepEqual(example.redaction, { codenames: [], names: [], terms: [] });
    assert.ok(!JSON.stringify(example).includes(ME), 'example must not contain the real email');

    // .gitignore has the draft sidecar exactly once
    const gi = readFileSync(join(t.cwd, '.gitignore'), 'utf8');
    assert.equal(gi.split(/\r?\n/).filter((l) => l.trim() === 'honestweek.draft.json').length, 1);
    assert.ok(!gi.includes('honestweek.items.json'), 'init must not gitignore items.json');
  } finally {
    cleanup(t.parent);
  }
});

test('--yes is a no-op when a config exists; --force overwrites; gitignore stays idempotent', async () => {
  const t = setupTree();
  try {
    await runInit({ cwd: t.cwd, argv: ['--yes'], io: fakeIo() });
    const cfgPath = join(t.cwd, 'honestweek.config.json');
    const first = readFileSync(cfgPath, 'utf8');

    // tamper, then re-run without --force: must be left unchanged
    writeFileSync(cfgPath, first.replace('myproj', 'TAMPERED'));
    const io2 = fakeIo();
    await runInit({ cwd: t.cwd, argv: ['--yes'], io: io2 });
    assert.match(io2.outBuf, /already exists/);
    assert.match(readFileSync(cfgPath, 'utf8'), /TAMPERED/, 'no-op left the file unchanged');

    // re-run with --force: overwrites back to the inferred config
    await runInit({ cwd: t.cwd, argv: ['--yes', '--force'], io: fakeIo() });
    assert.doesNotMatch(readFileSync(cfgPath, 'utf8'), /TAMPERED/);

    // gitignore not duplicated across runs
    const gi = readFileSync(join(t.cwd, '.gitignore'), 'utf8');
    assert.equal(gi.split(/\r?\n/).filter((l) => l.trim() === 'honestweek.draft.json').length, 1);
  } finally {
    cleanup(t.parent);
  }
});

test('interactive: declining the FIRST confirmation writes nothing', async () => {
  const t = setupTree();
  try {
    // edit prompt: accept (''), first confirmation: 'n'
    const io = fakeIo(['', 'n']);
    const code = await runInit({ cwd: t.cwd, argv: [], io });
    assert.equal(code, 1);
    assert.match(io.outBuf, /Aborted/);
    assert.ok(!existsSync(join(t.cwd, 'honestweek.config.json')), 'nothing written on abort');
  } finally {
    cleanup(t.parent);
  }
});

test('interactive: declining the SECOND confirmation writes nothing', async () => {
  const t = setupTree();
  try {
    // edit: accept (''), confirm1: 'y', confirm2: 'n'
    const io = fakeIo(['', 'y', 'n']);
    const code = await runInit({ cwd: t.cwd, argv: [], io });
    assert.equal(code, 1);
    assert.ok(!existsSync(join(t.cwd, 'honestweek.config.json')));
  } finally {
    cleanup(t.parent);
  }
});

test('interactive: pressing through both confirmations (defaults) yields a valid config', async () => {
  const t = setupTree();
  try {
    // edit: accept (''), confirm1: '' (default yes), confirm2: '' (default yes when fresh)
    const io = fakeIo(['', '', '']);
    const code = await runInit({ cwd: t.cwd, argv: [], io });
    assert.equal(code, 0);
    const cfg = loadConfig(join(t.cwd, 'honestweek.config.json'));
    assert.deepEqual(cfg.identity.authorEmails, [ME]);
  } finally {
    cleanup(t.parent);
  }
});

test('ensureGitignore creates, appends idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-gi-'));
  try {
    assert.equal(ensureGitignore(dir, 'honestweek.draft.json'), true, 'creates and adds');
    assert.equal(ensureGitignore(dir, 'honestweek.draft.json'), false, 'idempotent on second call');
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.equal(gi.split(/\r?\n/).filter((l) => l.trim() === 'honestweek.draft.json').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('buildConfig with no inferred email yields empty authorEmails (and stays clean-room)', () => {
  const cfg = buildConfig({ authorEmail: null, repos: [{ path: '/p', label: 'p', role: 'featured' }], timezone: 'UTC' });
  assert.deepEqual(cfg.identity.authorEmails, []);
  assert.deepEqual(cfg.redaction, { codenames: [], names: [], terms: [] });
  assert.equal(cfg.output.mode, 'post');
});

test('no-email case: inferAuthorEmail returns null and runInit warns (config authorEmails empty)', async () => {
  const t = setupTree();
  // suppress global/system git identity; remove the local one too
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const emptyCfg = join(t.parent, 'empty.gitconfig');
  writeFileSync(emptyCfg, '');
  const noEmailRepo = join(t.parent, 'noemail');
  mkdirSync(noEmailRepo);
  git(noEmailRepo, ['init', '-q']);
  try {
    process.env.GIT_CONFIG_GLOBAL = emptyCfg;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    assert.equal(inferAuthorEmail(noEmailRepo), null);
    const io = fakeIo();
    await runInit({ cwd: noEmailRepo, argv: ['--yes'], io });
    assert.match(io.errBuf, /could not infer/i);
    const cfg = JSON.parse(readFileSync(join(noEmailRepo, 'honestweek.config.json'), 'utf8'));
    assert.deepEqual(cfg.identity.authorEmails, []);
  } finally {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    cleanup(t.parent);
  }
});
