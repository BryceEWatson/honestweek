// Temp folders for tests. Every folder made here is removed when the test process exits,
// whether its tests passed or failed, so a run never leaves anything in the system temp
// folder. Removal retries briefly because Windows can keep a folder busy for a moment
// after a process that used it (often git) has exited.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const RETRIES = 10;
const PAUSE_MS = 50;

// Folders still to remove when the process exits. 'exit' runs after the last test,
// including when a test failed or threw, and only allows synchronous work.
const pending = new Set();
let sweepOnExit = false;

function track(dir) {
  pending.add(dir);
  if (!sweepOnExit) {
    sweepOnExit = true;
    process.on('exit', () => {
      for (const d of [...pending]) {
        if (!removeTempDir(d)) process.stderr.write(`test cleanup: could not remove ${d}\n`);
      }
    });
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Makes a new, empty folder in the system temp folder, named `prefix` plus six random
 * characters, and returns its path. It's removed when the process exits.
 */
export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  track(dir);
  return dir;
}

/**
 * Removes a folder and everything in it. On a Windows lock it waits a little longer before
 * each of up to ten retries (2.75 seconds of waiting in all). It never throws: a folder it
 * can't remove yet stays on the list and is tried again when the process exits. Returns
 * whether the folder is gone.
 */
export function removeTempDir(dir) {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      pending.delete(dir);
      return true;
    } catch (err) {
      if (!RETRY_CODES.has(err?.code) || attempt > RETRIES) {
        if (!existsSync(dir)) { pending.delete(dir); return true; }
        track(dir);
        return false;
      }
      pause(attempt * PAUSE_MS);
    }
  }
}
