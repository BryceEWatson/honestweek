// Atomic writes keep private files private on POSIX: a new file is created 0600, and a rewrite
// keeps the file's own mode (a user's chmod 600, or anything else) instead of resetting it.
// Files the user commits or publishes (an output page, a .gitignore) get the system default.
// Windows doesn't use POSIX mode bits, so the mode checks skip there; the content checks run
// everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson, atomicWriteText } from '../lib/atomic-json.mjs';
import { ensureGitignore } from '../lib/init.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX mode bits only' : false };
const modeOf = (p) => statSync(p).mode & 0o777;

function scratch(t) {
  const dir = makeTempDir('hw-atomic-mode-');
  t.after(() => removeTempDir(dir));
  return dir;
}

test('a new file is created owner-only (0600), whatever the umask allows', posixOnly, (t) => {
  const dir = scratch(t);
  const old = process.umask(0o022);
  try {
    atomicWriteText(join(dir, 'store.json'), 'one\n');
    atomicWriteJson(join(dir, 'other.json'), { a: 1 });
  } finally {
    process.umask(old);
  }
  assert.equal(modeOf(join(dir, 'store.json')).toString(8), '600');
  assert.equal(modeOf(join(dir, 'other.json')).toString(8), '600');
});

test('a rewrite keeps the file\'s own mode: a chmod 600 survives, and so does a looser one', posixOnly, (t) => {
  const dir = scratch(t);
  for (const mode of [0o600, 0o640, 0o644]) {
    const file = join(dir, `store-${mode.toString(8)}.json`);
    atomicWriteText(file, 'first\n');
    chmodSync(file, mode);
    atomicWriteText(file, 'second\n');
    assert.equal(modeOf(file).toString(8), mode.toString(8));
    assert.equal(readFileSync(file, 'utf8'), 'second\n');
  }
});

test('the content lands and no temp file is left behind, on every platform', (t) => {
  const dir = scratch(t);
  const file = join(dir, 'store.json');
  atomicWriteJson(file, { n: 1 });
  atomicWriteJson(file, { n: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 2 });
  assert.deepEqual(readdirSync(dir), ['store.json']);
});

test('an output file the user will publish gets the system default mode when new, and keeps its own after', posixOnly, (t) => {
  const dir = scratch(t);
  const file = join(dir, 'report.html');
  const old = process.umask(0o022);
  try {
    atomicWriteText(file, 'one\n', undefined, { newMode: null });
  } finally {
    process.umask(old);
  }
  assert.equal(modeOf(file).toString(8), '644');
  chmodSync(file, 0o600);
  atomicWriteText(file, 'two\n', undefined, { newMode: null });
  assert.equal(modeOf(file).toString(8), '600');
});

test('a new .gitignore gets the system default mode, not owner-only, and an existing one keeps its own', posixOnly, (t) => {
  const dir = scratch(t);
  const file = join(dir, '.gitignore');
  const old = process.umask(0o022);
  try {
    assert.equal(ensureGitignore(dir, 'honestweek.draft.json'), true);
  } finally {
    process.umask(old);
  }
  assert.equal(modeOf(file).toString(8), '644');
  chmodSync(file, 0o640);
  assert.equal(ensureGitignore(dir, 'honestweek.history.json'), true);
  assert.equal(modeOf(file).toString(8), '640');
  assert.equal(readFileSync(file, 'utf8'), 'honestweek.draft.json\nhonestweek.history.json\n');
});
