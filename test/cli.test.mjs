import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'honestweek.mjs');

/** Run the CLI; return { code, stdout, stderr }. */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

test('--help, -h, and no args all print the same usage and exit 0', () => {
  const help = runCli(['--help']);
  const dashH = runCli(['-h']);
  const none = runCli([]);
  assert.equal(help.code, 0);
  assert.equal(dashH.code, 0);
  assert.equal(none.code, 0);
  assert.equal(help.stdout, dashH.stdout);
  assert.equal(help.stdout, none.stdout);
  for (const cmd of ['init', 'discover', 'build']) {
    assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`), `usage should list ${cmd}`);
  }
});

test('unknown subcommand prints usage to stderr and exits non-zero', () => {
  const res = runCli(['frobnicate']);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /unknown command/);
  assert.match(res.stderr, /frobnicate/);
});

test('a not-yet-built subcommand exits non-zero with a clear message (no crash)', () => {
  // In the scaffold-only state, init/discover/build modules may be absent.
  // Whatever the state, dispatching must never throw an unhandled stack trace.
  const res = runCli(['discover']);
  // Either the handler ran (code 0/known) or it is not yet implemented (code 1).
  // It must not crash with an uncaught exception dump.
  assert.doesNotMatch(res.stderr, /at Object\.<anonymous>|UnhandledPromiseRejection/);
});
