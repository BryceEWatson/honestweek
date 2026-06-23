import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lookupCommit, commitsInWindow, verifyItems, emailInList } from '../lib/git.mjs';

const ME = 'me@example.com';
const OTHER = 'someone@else.test';

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-git-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

let counter = 0;
function commit(dir, { email, message, dateISO }) {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `${message} ${counter}`);
  git(dir, ['add', '-A']);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: 'Dev',
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: dateISO,
    GIT_COMMITTER_DATE: dateISO,
  };
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may transiently lock .git; ignore teardown errors */
  }
}

function featuredConfig(dir, label = 'r') {
  return {
    identity: { authorEmails: [ME] },
    repos: [{ label, path: dir, resolvedPath: dir, role: 'featured' }],
  };
}

test('emailInList is case-insensitive', () => {
  assert.ok(emailInList('Me@Example.com', [ME]));
  assert.ok(!emailInList('x@y.z', [ME]));
});

test('lookupCommit returns derived metadata for a real commit; byAuthor honors the allowlist', () => {
  const dir = initRepo();
  try {
    const sha = commit(dir, { email: ME, message: 'add login', dateISO: '2024-06-12T10:00:00Z' });
    const res = lookupCommit(dir, sha, [ME]);
    assert.equal(res.resolved, true);
    assert.equal(res.authorEmail, ME);
    assert.equal(res.byAuthor, true);
    assert.equal(res.subject, 'add login');
    assert.ok(/^[0-9a-f]+$/.test(res.shortSha), 'shortSha is lowercase hex');
    assert.ok(!Number.isNaN(new Date(res.dateISO).getTime()), 'dateISO is a valid ISO date');
    // byAuthor is false when the email is not in the list (or list omitted)
    assert.equal(lookupCommit(dir, sha, [OTHER]).byAuthor, false);
    assert.equal(lookupCommit(dir, sha).byAuthor, false);
  } finally {
    cleanup(dir);
  }
});

test('lookupCommit reports a non-authored commit as byAuthor=false', () => {
  const dir = initRepo();
  try {
    const sha = commit(dir, { email: OTHER, message: 'third-party fix', dateISO: '2024-06-12T10:00:00Z' });
    const res = lookupCommit(dir, sha, [ME]);
    assert.equal(res.resolved, true);
    assert.equal(res.authorEmail, OTHER);
    assert.equal(res.byAuthor, false);
  } finally {
    cleanup(dir);
  }
});

test('lookupCommit returns a detectable not-found result for an unresolved sha (no throw)', () => {
  const dir = initRepo();
  try {
    commit(dir, { email: ME, message: 'init', dateISO: '2024-06-12T10:00:00Z' });
    const res = lookupCommit(dir, '0000000000000000000000000000000000000000', [ME]);
    assert.equal(res.resolved, false);
    assert.equal(res.byAuthor, false);
  } finally {
    cleanup(dir);
  }
});

test('lookupCommit throws when the path is not a git repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-notrepo-'));
  try {
    assert.throws(() => lookupCommit(dir, 'abcdef0', [ME]), /not a git repository/);
  } finally {
    cleanup(dir);
  }
});

test('commitsInWindow returns only in-window commits authored by the allowlist', () => {
  const dir = initRepo();
  try {
    const inMe = commit(dir, { email: ME, message: 'in window mine', dateISO: '2024-06-12T10:00:00Z' });
    commit(dir, { email: OTHER, message: 'in window theirs', dateISO: '2024-06-13T10:00:00Z' });
    commit(dir, { email: ME, message: 'out of window mine', dateISO: '2024-06-20T10:00:00Z' });

    const got = commitsInWindow(dir, [ME], '2024-06-10T00:00:00Z', '2024-06-16T23:59:59Z');
    assert.equal(got.length, 1);
    assert.equal(got[0].sha, inMe);
    assert.equal(got[0].authorEmail, ME);
  } finally {
    cleanup(dir);
  }
});

test('commitsInWindow returns [] when there are none in range', () => {
  const dir = initRepo();
  try {
    commit(dir, { email: ME, message: 'recent', dateISO: '2024-06-12T10:00:00Z' });
    assert.deepEqual(commitsInWindow(dir, [ME], '2020-01-01T00:00:00Z', '2020-01-07T23:59:59Z'), []);
  } finally {
    cleanup(dir);
  }
});

test('verifyItems — happy path: resolving, authored commits verify with no problems', () => {
  const dir = initRepo();
  try {
    const sha = commit(dir, { email: ME, message: 'ship feature', dateISO: '2024-06-12T10:00:00Z' });
    const config = featuredConfig(dir);
    const items = [{ id: 'i1', repo: 'r', primaryCommit: sha }];
    const { ok, problems, verified } = verifyItems(items, config);
    assert.equal(ok, true);
    assert.equal(problems.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].sha, sha);
    assert.equal(verified[0].subject, 'ship feature');
  } finally {
    cleanup(dir);
  }
});

test('verifyItems — a non-authored cited commit is a problem (author gate)', () => {
  const dir = initRepo();
  try {
    const sha = commit(dir, { email: OTHER, message: 'not mine', dateISO: '2024-06-12T10:00:00Z' });
    const { ok, problems } = verifyItems([{ id: 'i1', repo: 'r', commits: [sha] }], featuredConfig(dir));
    assert.equal(ok, false);
    assert.equal(problems.length, 1);
    assert.match(problems[0].reason, /not authored/);
    assert.equal(problems[0].sha, sha);
  } finally {
    cleanup(dir);
  }
});

test('verifyItems — an unresolved cited commit is a problem', () => {
  const dir = initRepo();
  try {
    commit(dir, { email: ME, message: 'init', dateISO: '2024-06-12T10:00:00Z' });
    const fakeSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const { ok, problems } = verifyItems([{ id: 'i1', repo: 'r', primaryCommit: fakeSha }], featuredConfig(dir));
    assert.equal(ok, false);
    assert.match(problems[0].reason, /does not resolve/);
  } finally {
    cleanup(dir);
  }
});

test('verifyItems — a display-role citation is a problem and NO git read is attempted', () => {
  // The display repo path is NOT a git repo: if verifyItems shelled out to git
  // against it, the recorded reason would be "not a git repository". Because it
  // is guarded BEFORE any git call, the reason names the display violation.
  const nonRepo = mkdtempSync(join(tmpdir(), 'hw-display-'));
  try {
    const config = {
      identity: { authorEmails: [ME] },
      repos: [{ label: 'priv', path: nonRepo, resolvedPath: nonRepo, role: 'display' }],
    };
    const { ok, problems } = verifyItems(
      [{ id: 'i1', repo: 'priv', primaryCommit: 'abcdef0' }],
      config
    );
    assert.equal(ok, false);
    assert.match(problems[0].reason, /display/);
    assert.doesNotMatch(problems[0].reason, /not a git repository/);
  } finally {
    cleanup(nonRepo);
  }
});

test('verifyItems — a citation against an unknown repo is a problem', () => {
  const dir = initRepo();
  try {
    const { ok, problems } = verifyItems(
      [{ id: 'i1', repo: 'no-such-repo', primaryCommit: 'abcdef0' }],
      featuredConfig(dir)
    );
    assert.equal(ok, false);
    assert.match(problems[0].reason, /not in config\.repos/);
  } finally {
    cleanup(dir);
  }
});

test('verifyItems — items with no cited commits are skipped, not flagged', () => {
  const dir = initRepo();
  try {
    const { ok, problems, verified } = verifyItems(
      [{ id: 'generic', repo: 'r' }],
      featuredConfig(dir)
    );
    assert.equal(ok, true);
    assert.equal(problems.length, 0);
    assert.equal(verified.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('verifyItems never calls process.exit (returns a verdict object)', () => {
  const dir = initRepo();
  try {
    const result = verifyItems([{ id: 'i1', repo: 'r', primaryCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }], featuredConfig(dir));
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.problems));
    assert.ok(Array.isArray(result.verified));
  } finally {
    cleanup(dir);
  }
});
