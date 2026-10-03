// A test file for the temp-folder guard in test/temp-cleanup.test.mjs, which runs it in a
// child process. In the normal suite it defines no tests. Under the guard it makes temp
// folders the ways the real tests do, including a git repository, and then two of its
// tests fail before their own cleanup, so the guard can check nothing is left behind.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTempDir, removeTempDir } from '../helpers/temp-dir.mjs';

// The guard passes a file to list each folder made here, so it can check they were made
// inside the empty temp folder it set up and are gone afterwards.
const LOG = process.env.HONESTWEEK_TEMP_GUARD_LOG;

function made(prefix) {
  const dir = makeTempDir(prefix);
  appendFileSync(LOG, `${dir}\n`);
  return dir;
}

function repoWithCommit() {
  const dir = made('hw-guard-repo-');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'you@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'a file\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return dir;
}

if (LOG) {
  test('cleans up in finally and passes', () => {
    const dir = made('hw-guard-finally-');
    try {
      writeFileSync(join(dir, 'a.txt'), 'a');
    } finally {
      removeTempDir(dir);
    }
  });

  test('cleans up only at the end, and passes', () => {
    const dir = repoWithCommit();
    removeTempDir(dir);
  });

  test('fails before reaching its cleanup', () => {
    const dir = made('hw-guard-fails-');
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'deeper', 'half-written.txt'), 'x');
    assert.fail('this test fails on purpose');
  });

  test('a git repository from a test that throws', () => {
    repoWithCommit();
    throw new Error('this test throws on purpose');
  });
}
