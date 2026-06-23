import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDiscover } from '../lib/discover.mjs';

const NOW = new Date('2024-06-19T12:00:00Z'); // completed week is 2024-06-10..16
const SHA_NOTE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const SHA_WINDOW = 'abc1234def5678abc1234def5678abc1234def56';

function makeIo() {
  const io = { outBuf: '', errBuf: '', exitCode: null, out: (s) => (io.outBuf += s), err: (s) => (io.errBuf += s), exit: (c) => { io.exitCode = c; return c; } };
  return io;
}

function workdir(config) {
  const dir = mkdtempSync(join(tmpdir(), 'hw-disc-'));
  if (config) writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify(config));
  return dir;
}

function validConfig() {
  return {
    identity: { authorEmails: ['dev@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: '/work/r', label: 'r', resolvedPath: '/work/r', role: 'featured' }],
    redaction: { codenames: ['Falcon'], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  };
}

function mockAdapter() {
  return async () => [
    {
      id: 'aaaa', date: '2024-06-12', project: 'r', repo: 'r', isPrivate: false,
      steers: ['contact dev@example.com about Falcon, 87% done'],
      assistantNotes: [`sha ${SHA_NOTE} landed`],
      toolSignal: { counts: { Edit: 1 }, files: ['src/api/*.ts'], tests: [], searches: [] },
      statusSignals: ['pass'], redirects: [], candidateCommits: [],
    },
    {
      id: 'bbbb', date: '2024-06-12', project: 'private', repo: null, isPrivate: true,
      steers: [], assistantNotes: [], toolSignal: { counts: {}, files: [], tests: [], searches: [] },
      statusSignals: [], redirects: [], candidateCommits: [],
    },
  ];
}

function mockGit(calls) {
  return (repoPath) => {
    calls.push(repoPath);
    return [{ sha: SHA_WINDOW, dateISO: '2024-06-12T10:00:00Z', subject: 'window commit for Falcon' }];
  };
}

test('writes a redacted draft with header + week + sessions; attaches candidate commits for featured only', async () => {
  const dir = workdir(validConfig());
  const calls = [];
  const io = makeIo();
  try {
    const code = await runDiscover({ cwd: dir, now: NOW, io, adapter: mockAdapter(), gitWindow: mockGit(calls) });
    assert.equal(code, 0);
    const draft = JSON.parse(readFileSync(join(dir, 'honestweek.draft.json'), 'utf8'));
    assert.ok(typeof draft._README === 'string' && draft._README.length > 0);
    assert.deepEqual(draft.week, { start: '2024-06-10', end: '2024-06-16' });
    assert.equal(draft.sessions.length, 2);

    const featured = draft.sessions.find((s) => s.id === 'aaaa');
    assert.equal(featured.candidateCommits.length, 1);
    assert.equal(featured.candidateCommits[0].sha, SHA_WINDOW);
    assert.deepEqual(Object.keys(featured.candidateCommits[0]).sort(), ['date', 'sha', 'subject']);

    const priv = draft.sessions.find((s) => s.id === 'bbbb');
    assert.deepEqual(priv.candidateCommits, [], 'private session gets no candidate commits');

    // git is invoked ONLY for the featured repo, never for the private session
    assert.deepEqual(calls, ['/work/r']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the whole digest is redacted before disk; SHAs and percentages are preserved', async () => {
  const dir = workdir(validConfig());
  const io = makeIo();
  try {
    await runDiscover({ cwd: dir, now: NOW, io, adapter: mockAdapter(), gitWindow: mockGit([]) });
    const text = readFileSync(join(dir, 'honestweek.draft.json'), 'utf8');
    assert.ok(!text.includes('Falcon'), 'configured codename scrubbed (incl. the git subject)');
    assert.ok(!text.includes('dev@example.com'), 'email scrubbed');
    assert.ok(text.includes(SHA_NOTE), 'git SHA spared');
    assert.ok(text.includes('87%'), 'plain percentage spared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prints a summary: sessions, public/private split, candidate total, redaction count', async () => {
  const dir = workdir(validConfig());
  const io = makeIo();
  try {
    await runDiscover({ cwd: dir, now: NOW, io, adapter: mockAdapter(), gitWindow: mockGit([]) });
    assert.match(io.outBuf, /2 interactive session/);
    assert.match(io.outBuf, /1 public, 1 private-redacted/);
    assert.match(io.outBuf, /1 candidate commit/);
    assert.match(io.outBuf, /redaction/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('honestweek.draft.json is added to .gitignore', async () => {
  const dir = workdir(validConfig());
  try {
    await runDiscover({ cwd: dir, now: NOW, io: makeIo(), adapter: mockAdapter(), gitWindow: mockGit([]) });
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.ok(gi.split(/\r?\n/).some((l) => l.trim() === 'honestweek.draft.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-running discover is deterministic (byte-identical draft for the same inputs)', async () => {
  const dir = workdir(validConfig());
  try {
    await runDiscover({ cwd: dir, now: NOW, io: makeIo(), adapter: mockAdapter(), gitWindow: mockGit([]) });
    const a = readFileSync(join(dir, 'honestweek.draft.json'), 'utf8');
    await runDiscover({ cwd: dir, now: NOW, io: makeIo(), adapter: mockAdapter(), gitWindow: mockGit([]) });
    const b = readFileSync(join(dir, 'honestweek.draft.json'), 'utf8');
    assert.equal(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--week pointing at a future/in-progress week is rejected with a non-zero exit', async () => {
  const dir = workdir(validConfig());
  const io = makeIo();
  try {
    const code = await runDiscover({ cwd: dir, argv: ['--week', '2024-W30'], now: NOW, io, adapter: mockAdapter(), gitWindow: mockGit([]) });
    assert.equal(code, 1);
    assert.equal(io.exitCode, 1);
    assert.match(io.errBuf, /future|in-progress/);
    assert.ok(!existsSync(join(dir, 'honestweek.draft.json')), 'no draft written on a rejected week');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing config exits non-zero with a clear message (not a stack trace)', async () => {
  const dir = workdir(null);
  const io = makeIo();
  try {
    const code = await runDiscover({ cwd: dir, now: NOW, io, adapter: mockAdapter(), gitWindow: mockGit([]) });
    assert.equal(code, 1);
    assert.match(io.errBuf, /honestweek config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
