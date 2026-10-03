// Tests leave nothing behind in the system temp folder, whether they pass or fail.
// The first checks run a test file in a child process with TEMP, TMP and TMPDIR pointed at
// a fresh, empty folder, then look in that folder after the child has exited.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TEMP_VARS = new Set(['TEMP', 'TMP', 'TMPDIR']);

// Runs one test file the way `node --test` does, with the temp folder redirected.
function runWithEmptyTemp(file, extraEnv = {}) {
  const temp = makeTempDir('hw-temp-guard-');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!TEMP_VARS.has(k.toUpperCase())) env[k] = v;
  // Without this the child would report to this run instead of running as its own.
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, { TEMP: temp, TMP: temp, TMPDIR: temp }, extraEnv);
  const r = spawnSync(process.execPath, ['--test', file], { cwd: ROOT, env, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}`, temp, left: readdirSync(temp) };
}

const inside = (p, dir) => p.toLowerCase().startsWith(`${dir}${sep}`.toLowerCase());

test('a real test file that used to leave a folder behind now leaves the temp folder empty', () => {
  const run = runWithEmptyTemp(join('test', 'config.test.mjs'));
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.left, []);
});

test('tests that fail part-way, including one with a git repository, still leave the temp folder empty', () => {
  const log = join(makeTempDir('hw-temp-guard-log-'), 'made.txt');
  writeFileSync(log, '');
  const run = runWithEmptyTemp(join('test', 'fixtures', 'temp-guard.mjs'), { HONESTWEEK_TEMP_GUARD_LOG: log });

  // The child failed for the planned reasons, not because it couldn't start.
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /this test fails on purpose/);
  assert.match(run.output, /this test throws on purpose/);

  // Every test made its folder inside the redirected temp folder, and none is left.
  const made = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(made.length, 4, made.join('\n'));
  for (const dir of made) {
    assert.ok(inside(dir, run.temp), `${dir} was made outside ${run.temp}`);
    assert.equal(existsSync(dir), false, `${dir} was left behind`);
  }
  assert.deepEqual(run.left, []);
});

test('every test makes its temp folders through the shared helper', () => {
  const helper = join(HERE, 'helpers', 'temp-dir.mjs');
  const offenders = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(name) && p !== helper && p !== fileURLToPath(import.meta.url)) {
        if (/\bmkdtemp(Sync)?\s*\(/.test(readFileSync(p, 'utf8'))) offenders.push(relative(ROOT, p));
      }
    }
  })(HERE);
  assert.deepEqual(offenders, [], 'use makeTempDir from test/helpers/temp-dir.mjs so the folder is removed even when a test fails');
});

// Windows refuses to delete a folder while a process has it as its working directory,
// the same EBUSY a git process can leave for a moment after it exits.
function holdFolder(dir, ms) {
  const child = spawn(process.execPath, ['-e', `process.stdout.write('held'); setTimeout(() => {}, ${ms})`], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const held = new Promise((resolve) => child.stdout.once('data', resolve));
  return { child, held, exited };
}

const windowsOnly = process.platform !== 'win32' && 'only Windows keeps a folder busy while a process is using it';

test('removing a folder Windows holds busy for a moment waits for it and succeeds', { skip: windowsOnly }, async () => {
  const dir = makeTempDir('hw-temp-guard-busy-');
  writeFileSync(join(dir, 'f.txt'), 'x');
  const hold = holdFolder(dir, 300);
  await hold.held;
  assert.equal(removeTempDir(dir), true);
  assert.equal(existsSync(dir), false);
  await hold.exited;
});

test('a folder held busy past the retries is reported, not thrown, and removed once released', { skip: windowsOnly }, async () => {
  const dir = makeTempDir('hw-temp-guard-stuck-');
  const hold = holdFolder(dir, 60_000);
  await hold.held;
  try {
    assert.equal(removeTempDir(dir), false);
    assert.equal(existsSync(dir), true);
  } finally {
    hold.child.kill();
    await hold.exited;
  }
  assert.equal(removeTempDir(dir), true);
  assert.equal(existsSync(dir), false);
});
