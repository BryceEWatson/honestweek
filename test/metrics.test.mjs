// Git-derived per-project metrics: derived (never authored), display repos never
// git-read, and an unreadable repo yields no metric (never a fabricated 0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoMetricsInWindow } from '../lib/git.mjs';
import { assembleReportModel } from '../lib/build.mjs';
import { formatMetrics } from '../lib/emit/_shared.mjs';
import { render as renderDigest } from '../lib/emit/digest.mjs';

const ME = 'me@example.com';
const OTHER = 'someone@else.test';

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-metrics-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
let n = 0;
function commit(dir, { email, message, dateISO }) {
  n += 1;
  writeFileSync(join(dir, `f${n}.txt`), `${message} ${n}`);
  git(dir, ['add', '-A']);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  git(dir, ['commit', '-q', '-m', message], env);
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows lock */ }
}

const WIN = ['2024-06-10T00:00:00Z', '2024-06-16T23:59:59Z'];

test('repoMetricsInWindow counts my in-window commits and distinct active days', () => {
  const dir = initRepo();
  try {
    commit(dir, { email: ME, message: 'a', dateISO: '2024-06-11T09:00:00Z' });
    commit(dir, { email: ME, message: 'b', dateISO: '2024-06-11T17:00:00Z' }); // same day
    commit(dir, { email: ME, message: 'c', dateISO: '2024-06-13T10:00:00Z' }); // 2nd day
    commit(dir, { email: OTHER, message: 'd', dateISO: '2024-06-12T10:00:00Z' }); // not mine
    commit(dir, { email: ME, message: 'e', dateISO: '2024-06-20T10:00:00Z' }); // out of window
    const m = repoMetricsInWindow(dir, [ME], ...WIN);
    assert.deepEqual(m, { commits: 3, activeDays: 2 });
  } finally { cleanup(dir); }
});

test('repoMetricsInWindow returns null for an unreadable repo (never a fabricated 0)', () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'hw-metrics-norepo-'));
  try {
    assert.equal(repoMetricsInWindow(notRepo, [ME], ...WIN), null);
  } finally { cleanup(notRepo); }
});

test('repoMetricsInWindow is empty-but-not-null for a readable repo with no in-window commits', () => {
  const dir = initRepo();
  try {
    commit(dir, { email: ME, message: 'old', dateISO: '2020-01-01T10:00:00Z' });
    assert.deepEqual(repoMetricsInWindow(dir, [ME], ...WIN), { commits: 0, activeDays: 0 });
  } finally { cleanup(dir); }
});

test('assembleReportModel attaches metrics to non-display groups; display groups carry none', () => {
  const config = {
    repos: [
      { label: 'app', role: 'featured' },
      { label: 'client', role: 'display' },
    ],
  };
  const items = [
    { status: 'shipped', text: 'x', repo: 'app', receipt: { sessionId: 's1' } },
    { status: 'shipped', text: 'y', repo: 'app', receipt: { sessionId: 's2' } },
    { status: 'designed, not proven', text: 'z', repo: 'client', receipt: { sessionId: 's3' } },
  ];
  const metricsByLabel = new Map([['app', { commits: 7, activeDays: 4 }]]);
  const model = assembleReportModel(items, config, new Map(), { start: '2024-06-10', end: '2024-06-16' }, metricsByLabel);

  const app = model.groups.find((g) => g.label === 'app');
  const client = model.groups.find((g) => g.label === 'client');
  assert.deepEqual(app.metrics, { entries: 2, commits: 7, activeDays: 4 });
  assert.equal(client.metrics, undefined, 'display group must carry no metrics');
});

test('assembleReportModel gives an entries-only metric when git metrics are absent', () => {
  const config = { repos: [{ label: 'app', role: 'featured' }] };
  const items = [{ status: 'shipped', text: 'x', repo: 'app', receipt: { sessionId: 's1' } }];
  const model = assembleReportModel(items, config, new Map(), { start: '2024-06-10', end: '2024-06-16' });
  assert.deepEqual(model.groups[0].metrics, { entries: 1 });
});

test('formatMetrics renders a compact line and pluralizes', () => {
  assert.equal(formatMetrics({ commits: 4, activeDays: 3, entries: 5 }), '4 commits · 3 active days · 5 entries');
  assert.equal(formatMetrics({ commits: 1, activeDays: 1, entries: 1 }), '1 commit · 1 active day · 1 entry');
  assert.equal(formatMetrics({ entries: 2 }), '2 entries');
  assert.equal(formatMetrics(null), '');
});

test('digest renders an Activity section only when git-derived numbers are present', () => {
  const week = { start: '2024-06-10', end: '2024-06-16' };
  const config = { repos: [{ label: 'app', role: 'featured' }] };
  const items = [{ status: 'shipped', text: 'Shipped a thing', repo: 'app', receipt: { sessionId: 'abc' } }];

  const withGit = assembleReportModel(items, config, new Map(), week, new Map([['app', { commits: 4, activeDays: 3 }]]));
  const out = renderDigest(withGit, config);
  assert.match(out, /## Activity/);
  assert.match(out, /- \*\*app\*\* — 4 commits · 3 active days · 1 entry/);

  const noGit = assembleReportModel(items, config, new Map(), week); // entries-only
  assert.doesNotMatch(renderDigest(noGit, config), /## Activity/);
});
