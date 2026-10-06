// `view --demo` deletes its temp folder when it stops, but a hard kill can't, so on
// start it clears the demo's own leftovers older than a day. Only folders named exactly
// as mkdtemp names them, that are real folders (not links), and are old enough go.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sweepStaleDemoDirs, DEMO_DIR_PREFIX } from '../lib/demo/week.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const DAY = 24 * 60 * 60 * 1000;

function age(path, now, ms) {
  const t = new Date(now - ms);
  utimesSync(path, t, t);
}

test('the demo sweep removes only old folders named the way mkdtemp names demo folders', () => {
  const tmp = makeTempDir('hw-sweep-');
  const elsewhere = makeTempDir('hw-sweep-target-');
  const now = Date.now();

  const old1 = join(tmp, `${DEMO_DIR_PREFIX}aB3dE9`);
  const old2 = join(tmp, `${DEMO_DIR_PREFIX}000000`);
  for (const d of [old1, old2]) {
    mkdirSync(join(d, 'claude', 'projects'), { recursive: true });
    writeFileSync(join(d, 'claude', 'projects', 'log.jsonl'), '{}\n');
    age(d, now, 2 * DAY);
  }
  const fresh = join(tmp, `${DEMO_DIR_PREFIX}fResh1`);
  mkdirSync(fresh);
  age(fresh, now, 23 * 60 * 60 * 1000);
  const longer = join(tmp, `${DEMO_DIR_PREFIX}aB3dE9x`);
  const shorter = join(tmp, `${DEMO_DIR_PREFIX}aB3dE`);
  const other = join(tmp, 'hw-demo-weekX-aB3dE9');
  const punct = join(tmp, `${DEMO_DIR_PREFIX}ab-d_9`);
  for (const d of [longer, shorter, other, punct]) {
    mkdirSync(d);
    age(d, now, 3 * DAY);
  }
  const file = join(tmp, `${DEMO_DIR_PREFIX}fiLe12`);
  writeFileSync(file, 'not a folder');
  age(file, now, 3 * DAY);
  const nested = join(tmp, 'parent');
  mkdirSync(join(nested, `${DEMO_DIR_PREFIX}nEst01`), { recursive: true });
  age(join(nested, `${DEMO_DIR_PREFIX}nEst01`), now, 3 * DAY);

  // A link named like a demo folder, pointing at a real old folder outside: neither goes.
  const target = join(elsewhere, 'keep');
  mkdirSync(target);
  writeFileSync(join(target, 'precious.txt'), 'keep me');
  age(target, now, 3 * DAY);
  const link = join(tmp, `${DEMO_DIR_PREFIX}LiNk01`);
  let linked = true;
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false;
  }

  const removed = sweepStaleDemoDirs(tmp, now);

  assert.equal(existsSync(old1), false, 'an old demo folder is removed');
  assert.equal(existsSync(old2), false, 'every old demo folder is removed');
  assert.deepEqual(removed.sort(), [old1, old2].sort(), 'and nothing else is reported removed');
  for (const keep of [fresh, longer, shorter, other, punct, file, join(nested, `${DEMO_DIR_PREFIX}nEst01`)]) {
    assert.equal(existsSync(keep), true, `${keep} is left`);
  }
  if (linked) {
    assert.equal(existsSync(link), true, 'a link named like a demo folder is left');
    assert.equal(existsSync(join(target, 'precious.txt')), true, "the link's target is untouched");
  }
});

test('the demo sweep ignores a missing temp folder', () => {
  const tmp = makeTempDir('hw-sweep-');
  assert.deepEqual(sweepStaleDemoDirs(join(tmp, 'missing'), Date.now()), []);
});
