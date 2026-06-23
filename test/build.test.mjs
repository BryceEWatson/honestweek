import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild, assembleReportModel } from '../lib/build.mjs';

const ME = 'me@example.com';
const OTHER = 'someone@else.test';

let counter = 0;
function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-build-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, { email = ME, message = 'work', dateISO = '2024-06-12T10:00:00Z' } = {}) {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}
function makeIo() {
  const io = {
    outBuf: '',
    errBuf: '',
    exitCode: null,
    out(s) { io.outBuf += s; },
    err(s) { io.errBuf += s; },
    exit(code) { io.exitCode = code; throw new ExitError(code); },
  };
  return io;
}

function setup({ repos, items, output } = {}) {
  const repoDir = initRepo();
  const work = mkdtempSync(join(tmpdir(), 'hw-build-work-'));
  const outFile = join(work, 'out.md');
  const config = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: repos ?? [{ path: repoDir, label: 'r', role: 'featured' }],
    redaction: { codenames: ['Falcon'], names: [], terms: [] },
    output: output ?? { mode: 'digest', file: outFile },
  };
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify(config));
  if (items !== undefined) writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify(items));
  return { repoDir, work, outFile };
}

function cleanup(...dirs) {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('happy path: verifies, redacts, and emits; git-derived data overrides the items file', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'fix login redirect' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: {
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [
        { id: 'i1', repo: 'r', text: 'Fixed the login redirect for Falcon at 87% coverage.', tag: 'verified', primaryCommit: sha, subject: 'TAMPERED SUBJECT' },
      ],
    },
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    assert.equal(io.exitCode, null, 'no abort on the happy path');
    assert.ok(existsSync(outFile));
    const out = readFileSync(outFile, 'utf8');
    const shortSha = sha.slice(0, 7);
    assert.ok(out.includes(shortSha), 'git-derived short sha appears in the receipt');
    assert.ok(!out.includes('TAMPERED SUBJECT'), 'items-file commit metadata is never trusted');
    // redaction applied; spare preserved
    assert.ok(!out.includes('Falcon'), 'configured codename scrubbed');
    assert.ok(out.includes('87%'), 'plain percentage spared');
    // badge + receipt present
    assert.match(out, /\*\*shipped\*\*/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('aborts (exit 2) and writes nothing when a cited commit does not resolve', async () => {
  const { repoDir, work, outFile } = setup({
    items: { week: { start: '2024-06-10', end: '2024-06-16' }, items: [{ id: 'i1', repo: 'r', text: 'x', tag: 'verified', primaryCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }] },
  });
  commit(repoDir); // repo has commits, but not the cited one
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e instanceof ExitError && e.code === 2);
    assert.match(io.errBuf, /ABORTED/);
    assert.match(io.errBuf, /does not resolve|unresolved/);
    assert.match(io.errBuf, /No output was written/);
    assert.ok(!existsSync(outFile), 'no output file on abort');
  } finally {
    cleanup(repoDir, work);
  }
});

test('aborts (exit 2) when a cited commit was not authored by the configured identity', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { email: OTHER, message: 'third-party change' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: { week: { start: '2024-06-10', end: '2024-06-16' }, items: [{ id: 'i1', repo: 'r', text: 'x', tag: 'verified', primaryCommit: sha }] },
  });
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 2);
    assert.match(io.errBuf, /not authored/);
    assert.match(io.errBuf, /identity\.authorEmails/);
    assert.ok(!existsSync(outFile));
  } finally {
    cleanup(repoDir, work);
  }
});

test('aborts when an item cites a commit against a display-role repo (never git-read)', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'disp', role: 'display' }],
    items: { week: { start: '2024-06-10', end: '2024-06-16' }, items: [{ id: 'i1', repo: 'disp', text: 'x', tag: 'verified', primaryCommit: sha }] },
  });
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 2);
    assert.match(io.errBuf, /display/);
    assert.ok(!existsSync(outFile));
  } finally {
    cleanup(repoDir, work);
  }
});

test('a missing items file exits non-zero with a message naming the file', async () => {
  const { repoDir, work } = setup({ items: undefined });
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 1);
    assert.match(io.errBuf, /honestweek\.items\.json/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('a malformed items file exits non-zero with a clear parse error', async () => {
  const { repoDir, work } = setup({ items: { items: [] } });
  writeFileSync(join(work, 'honestweek.items.json'), '{ not json');
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 1);
    assert.match(io.errBuf, /not valid JSON/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('assembleReportModel groups by repo, featured before reference, badges + receipts attached', () => {
  const config = { repos: [{ label: 'a', role: 'reference' }, { label: 'b', role: 'featured' }] };
  const verified = new Map([['sha1', { shortSha: 'sha1abc', dateISO: '2024-06-12T00:00:00Z' }]]);
  const items = [
    { id: '1', repo: 'a', text: 'ref work', tag: 'measured', receipt: { sessionId: 'sess-a' } },
    { id: '2', repo: 'b', text: 'feat work', tag: 'verified', primaryCommit: 'sha1' },
    { id: '3', text: 'loose private line', tag: 'assumed', receipt: { sessionId: 'sess-c' } },
  ];
  const model = assembleReportModel(items, config, verified, { start: '2024-06-10', end: '2024-06-16' });
  assert.deepEqual(model.groups.map((g) => g.label), ['b', 'a'], 'featured group first');
  assert.equal(model.groups[0].items[0].status, 'shipped');
  assert.equal(model.groups[0].items[0].receipt.shortSha, 'sha1abc');
  assert.equal(model.groups[1].items[0].status, 'shipped'); // measured -> shipped
  assert.equal(model.items[0].status, 'designed, not proven'); // assumed -> under-claim
  assert.equal(model.items[0].receipt.sessionId, 'sess-c');
});
