// The flagship "refuses to lie" demo, exercised through the REAL CLI
// (bin/honestweek.mjs) at the process level. honestweek's whole promise is that
// it re-derives every git-checkable claim from real commits and ABORTS rather
// than ship a half-true summary. If `build` ever produces output while citing an
// unprovable commit, honestweek is broken regardless of any other green test.
//
// Hermetic + deterministic: a throwaway git repo per case in a temp dir, no
// network, no personal data, no read of the developer's real working tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'honestweek.mjs');

const ME = 'me@example.com';
const OTHER = 'someone@else.test';
const FABRICATED_SHA = '0123456789abcdef0123456789abcdef01234567'; // 40-hex, never committed

let n = 0;
function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-demo-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, email, message) {
  n += 1;
  writeFileSync(join(dir, `f${n}.txt`), `x${n}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: '2024-06-12T10:00:00Z', GIT_COMMITTER_DATE: '2024-06-12T10:00:00Z' };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Run `node bin/honestweek.mjs build` in workDir; return { code, stderr }.
 *  spawnSync (not execFileSync) so stderr is captured on success too — the
 *  landed-gate downgrade note arrives on stderr of an exit-0 build. */
function runBuildCli(workDir) {
  const res = spawnSync(process.execPath, [BIN, 'build'], { cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: res.status ?? 1, stderr: res.stderr ?? '' };
}

function scenario({ repoDir, citedSha }) {
  const work = mkdtempSync(join(tmpdir(), 'hw-demo-work-'));
  const outFile = join(work, 'weekly.md');
  writeFileSync(
    join(work, 'honestweek.config.json'),
    JSON.stringify({
      identity: { authorEmails: [ME] },
      week: { startsOn: 'monday', timezone: 'UTC' },
      repos: [{ path: repoDir, label: 'app', role: 'featured' }],
      redaction: { codenames: [], names: [], terms: [] },
      output: { mode: 'digest', file: outFile },
    })
  );
  writeFileSync(
    join(work, 'honestweek.items.json'),
    JSON.stringify({
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [{ id: 'i1', repo: 'app', text: 'Shipped the weekly summary build.', tag: 'verified', primaryCommit: citedSha }],
    })
  );
  return { work, outFile };
}

function cleanup(...dirs) {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('DEMO: build ABORTS (exit 2) and writes NOTHING when an item cites a fabricated commit', () => {
  const repoDir = initRepo();
  commit(repoDir, ME, 'a real authored commit'); // repo has history, just not the cited sha
  const { work, outFile } = scenario({ repoDir, citedSha: FABRICATED_SHA });
  try {
    const { code, stderr } = runBuildCli(work);
    assert.equal(code, 2, 'process exits with code 2');
    assert.ok(!existsSync(outFile), 'no output file is written on abort');
    assert.match(stderr, /ABORTED/);
    assert.match(stderr, /does not resolve|unresolved/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('DEMO: build ABORTS (exit 2) and writes NOTHING when an item cites a real but NON-AUTHORED commit', () => {
  const repoDir = initRepo();
  const foreignSha = commit(repoDir, OTHER, 'someone else authored this'); // resolves, but not by ME
  const { work, outFile } = scenario({ repoDir, citedSha: foreignSha });
  try {
    const { code, stderr } = runBuildCli(work);
    assert.equal(code, 2, 'process exits with code 2');
    assert.ok(!existsSync(outFile), 'no output file is written on abort');
    assert.match(stderr, /not authored/);
    assert.match(stderr, /identity\.authorEmails/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('CONTROL: build SUCCEEDS (exit 0) and writes output when the cited commit resolves and is authored', () => {
  const repoDir = initRepo();
  const mySha = commit(repoDir, ME, 'fix the weekly summary');
  const { work, outFile } = scenario({ repoDir, citedSha: mySha });
  try {
    const { code } = runBuildCli(work);
    assert.equal(code, 0, 'a fully-provable build succeeds');
    assert.ok(existsSync(outFile), 'output file is written on success');
    const out = readFileSync(outFile, 'utf8');
    assert.match(out, /\*\*shipped\*\*/, 'item carries its status badge');
    assert.match(out, new RegExp(mySha.slice(0, 7)), 'receipt carries the git-derived short sha');
  } finally {
    cleanup(repoDir, work);
  }
});

test('DEMO: a real authored commit stranded on an unmerged branch NEVER renders `shipped` — build downgrades it to `in progress`', () => {
  // The landed gate: `shipped` claims the work is on the default branch. A
  // commit that only exists on an unmerged feature branch is real work (it
  // resolves, it is yours) but it has NOT landed — so the build reports it
  // honestly instead of aborting, and refuses the `shipped` badge. Verified
  // offline from local refs; no fetch, no network.
  const repoDir = initRepo();
  commit(repoDir, ME, 'landed base work'); // the default branch has history
  const defaultBranch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(repoDir, ['checkout', '-q', '-b', 'feat']);
  const strandedSha = commit(repoDir, ME, 'real work, never merged');
  git(repoDir, ['checkout', '-q', defaultBranch]);
  const { work, outFile } = scenario({ repoDir, citedSha: strandedSha });
  try {
    const { code, stderr } = runBuildCli(work);
    assert.equal(code, 0, 'real-but-unlanded work reports honestly; only fabricated claims abort');
    assert.ok(existsSync(outFile), 'output is written (with the honest badge)');
    const out = readFileSync(outFile, 'utf8');
    const line = out.split('\n').find((l) => l.includes('Shipped the weekly summary build.'));
    assert.match(line, /\*\*in progress\*\*/, 'the stranded item carries the honest badge');
    assert.doesNotMatch(line, /shipped/, 'the stranded item never reads `shipped`');
    assert.match(out, new RegExp(strandedSha.slice(0, 7)), 'the real receipt survives the downgrade');
    assert.match(stderr, /not landed on the default branch/, 'the downgrade is announced, never silent');
  } finally {
    cleanup(repoDir, work);
  }
});

test('the committed synthetic adapter fixtures contain no real personal data (clean-room)', () => {
  const root = resolve(HERE, 'fixtures', 'claude-projects');
  function walk(dir) {
    let blob = '';
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      blob += e.isDirectory() ? walk(p) : readFileSync(p, 'utf8');
    }
    return blob;
  }
  const blob = walk(root);
  assert.doesNotMatch(blob, /@(?:gmail|outlook|yahoo|proton|icloud)\.com/i, 'no real email addresses');
  assert.doesNotMatch(blob, /C:\\Users\\[A-Za-z]+\\/i, 'no real Windows home paths');
});
