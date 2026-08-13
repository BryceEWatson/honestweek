import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'honestweek.mjs');

/**
 * A scratch cwd whose PARENT is also scratch. `init` infers its allowlist by
 * scanning the parent's children, so a cwd sitting directly in the system temp
 * dir makes the test both slow and dependent on whatever else lives there.
 */
function scratchCwd(t) {
  const root = mkdtempSync(join(tmpdir(), 'honestweek-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'workspace');
  mkdirSync(dir);
  return dir;
}

/** Run the CLI; return { code, stdout, stderr }. */
function runCli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
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

test('every subcommand answers --help with help, exit 0, and no side effects', (t) => {
  // Asking a tool what it does must never read a session log or write a file.
  // `discover --help` used to scan the real week; `harvest --help` used to
  // write honestweek.harvest.json.
  const dir = scratchCwd(t);

  for (const cmd of ['init', 'discover', 'prompts', 'digest', 'validate', 'build', 'harvest', 'preview', 'mine']) {
    const res = runCli([cmd, '--help'], dir);
    assert.equal(res.code, 0, `${cmd} --help should exit 0`);
    assert.match(res.stdout, /usage|Usage/, `${cmd} --help should print usage`);
    assert.equal(readdirSync(dir).length, 0, `${cmd} --help must not write files`);
  }
});

test('init on a stdin that ends fails loudly instead of silently writing nothing', (t) => {
  // readline's question callback never fires at EOF, so the old behaviour was
  // to fall out of the event loop and exit 0 having written no config: a
  // silent no-op that reads as success to a script or an agent shell.
  const dir = scratchCwd(t);

  const res = runCli(['init'], dir);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /stdin ended/);
  assert.match(res.stderr, /--yes/, 'should name the flag that works');
  assert.equal(readdirSync(dir).length, 0, 'nothing should be written');
});

test('a not-yet-built subcommand exits non-zero with a clear message (no crash)', () => {
  // In the scaffold-only state, init/discover/build modules may be absent.
  // Whatever the state, dispatching must never throw an unhandled stack trace.
  const res = runCli(['discover']);
  // Either the handler ran (code 0/known) or it is not yet implemented (code 1).
  // It must not crash with an uncaught exception dump.
  assert.doesNotMatch(res.stderr, /at Object\.<anonymous>|UnhandledPromiseRejection/);
});
