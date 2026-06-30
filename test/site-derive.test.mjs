// The git-derived site sections. deriveChart buckets the user's OWN commits per
// day per readable repo (a display-role repo is never git-read); deriveProvenance
// counts items/commits; augmentSiteModel stitches chart + sessions + provenance
// onto the model and places each day's items by their git-derived date. Synthetic
// git repos + an empty sessions root — no target field names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveChart, deriveProvenance, deriveProjectStats, augmentSiteModel } from '../lib/site/derive.mjs';

const ME = 'me@example.com';
let counter = 0;

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-derive-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, dateISO, message = 'work') {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const WEEK = { start: '2024-06-10', end: '2024-06-16' };
const sinceISO = '2024-06-10T00:00:00.000Z';
const untilISO = '2024-06-16T23:59:59.999Z';

test('deriveChart buckets own commits per day; display repos are never git-read', () => {
  const featured = initRepo();
  const display = initRepo();
  try {
    // Commit in chronological order (real histories are): git log --since/--until
    // prunes traversal at the first commit older than --since, so an out-of-window
    // commit must be the OLDEST, not committed last. This mirrors the live tool's
    // exact git flags (and its same assumption).
    commit(featured, '2024-06-01T09:00:00Z'); // out of window -> ignored
    commit(featured, '2024-06-12T10:00:00Z');
    commit(featured, '2024-06-12T15:00:00Z');
    commit(featured, '2024-06-13T09:00:00Z');
    commit(display, '2024-06-12T11:00:00Z'); // display role -> must NOT be read

    const config = {
      identity: { authorEmails: [ME] },
      repos: [
        { label: 'feat', path: featured, resolvedPath: featured, role: 'featured' },
        { label: 'disp', path: display, resolvedPath: display, role: 'display' },
      ],
    };
    const chart = deriveChart({ config, weekStartKey: WEEK.start, weekEndKey: WEEK.end, todayKey: '2024-06-19', sinceISO, untilISO });

    assert.equal(chart.metric, 'commits');
    assert.equal(chart.days.length, 7);
    const byDate = Object.fromEntries(chart.days.map((d) => [d.date, d]));
    assert.equal(byDate['2024-06-12'].total, 2);
    assert.deepEqual(byDate['2024-06-12'].byRepo, { feat: 2 });
    assert.equal(byDate['2024-06-13'].total, 1);
    assert.equal(chart.max, 2);
    assert.equal(chart.repoTotals.feat, 3);
    assert.equal('disp' in chart.repoTotals, false, 'a display repo is never charted');
    // No display commit leaked into any day.
    assert.ok(chart.days.every((d) => !('disp' in d.byRepo)));
  } finally {
    rmSync(featured, { recursive: true, force: true });
    rmSync(display, { recursive: true, force: true });
  }
});

test('deriveChart contributes nothing for an unreadable repo (never a fake zero-for-real)', () => {
  const config = {
    identity: { authorEmails: [ME] },
    repos: [{ label: 'gone', path: '/nope/not/a/repo', resolvedPath: '/nope/not/a/repo', role: 'featured' }],
  };
  const chart = deriveChart({ config, weekStartKey: WEEK.start, weekEndKey: WEEK.end, todayKey: '2024-06-19', sinceISO, untilISO });
  assert.equal(chart.repoTotals.gone, 0);
  assert.equal(chart.max, 0);
});

test('deriveProvenance counts items + verified commits (redactions filled later)', () => {
  const p = deriveProvenance({ items: [{ id: '1' }, { id: '2' }], verified: [{ sha: 'a' }] });
  assert.deepEqual(p, { itemsTotal: 2, itemsVerified: 2, commitsVerified: 1, redactions: 0 });
});

test('deriveChart charts FEATURED repos only (reference repos are verify-only, not charted)', () => {
  const featured = initRepo();
  const reference = initRepo();
  try {
    commit(featured, '2024-06-12T10:00:00Z');
    commit(reference, '2024-06-12T11:00:00Z'); // reference role -> NOT charted
    const config = {
      identity: { authorEmails: [ME] },
      repos: [
        { label: 'feat', path: featured, resolvedPath: featured, role: 'featured' },
        { label: 'ref', path: reference, resolvedPath: reference, role: 'reference' },
      ],
    };
    const chart = deriveChart({ config, weekStartKey: WEEK.start, weekEndKey: WEEK.end, todayKey: '2024-06-19' });
    assert.equal(chart.repoTotals.feat, 1);
    assert.equal('ref' in chart.repoTotals, false, 'a reference repo is not charted');
  } finally {
    rmSync(featured, { recursive: true, force: true });
    rmSync(reference, { recursive: true, force: true });
  }
});

test('deriveProjectStats tallies IN-WEEK items only, grouped by project', () => {
  const chart = { days: [{ date: '2024-06-12', byRepo: { r: 2 } }, { date: '2024-06-13', byRepo: { r: 1 } }] };
  const richItems = [
    { project: 'P', repo: 'r', status: 'shipped', date: '2024-06-12' },
    { project: 'P', repo: 'r', status: 'shipped', date: '2024-06-13' },
    { project: 'P', repo: 'r', status: 'in progress', date: '2024-06-13' },
    { project: 'P', repo: 'r', status: 'shipped', date: '2024-06-01' }, // out of week -> not counted
  ];
  const stats = deriveProjectStats(richItems, chart, WEEK.start, WEEK.end);
  assert.deepEqual(stats.P, { entries: 3, statusCounts: { shipped: 2, 'in progress': 1 }, daysActive: 2 });
});

test('deriveProjectStats counts session-active days for a session-only (display) project', () => {
  // A display-role / session-only project: never charted (no byRepo entry), but it had interactive
  // sessions on 2 distinct days -> daysActive must be 2, not 0 (the issue #43 contradiction).
  const chart = { days: [{ date: '2024-06-12', byRepo: {} }, { date: '2024-06-13', byRepo: {} }] };
  const sessions = {
    days: [
      { date: '2024-06-11', byProject: {} },
      { date: '2024-06-12', byProject: { disp: 1 } },
      { date: '2024-06-13', byProject: { disp: 2 } },
    ],
  };
  const richItems = [
    { project: 'Client X', repo: 'disp', status: 'shipped', date: '2024-06-12' },
    { project: 'Client X', repo: 'disp', status: 'in progress', date: '2024-06-13' },
  ];
  const stats = deriveProjectStats(richItems, chart, WEEK.start, WEEK.end, sessions);
  // Resolved by the bucket's _repo (the display config-label 'disp'), not the bucket key 'Client X'.
  assert.equal(stats['Client X'].daysActive, 2, 'session-only project counts its 2 session-active days, not 0');
  assert.ok(stats['Client X'].daysActive > 0, 'no project shows activity with daysActive === 0 for an active week');
});

test('deriveProjectStats uses max(commit-days, session-days) for a git-backed project', () => {
  // Git-backed 'r': commits on 2 days, sessions on 3 days -> daysActive = max(2, 3) = 3.
  const chart = {
    days: [
      { date: '2024-06-11', byRepo: {} },
      { date: '2024-06-12', byRepo: { r: 2 } },
      { date: '2024-06-13', byRepo: { r: 1 } },
    ],
  };
  const sessions = {
    days: [
      { date: '2024-06-11', byProject: { r: 1 } },
      { date: '2024-06-12', byProject: { r: 1 } },
      { date: '2024-06-13', byProject: { r: 2 } },
    ],
  };
  const richItems = [{ project: 'P', repo: 'r', status: 'shipped', date: '2024-06-12' }];
  const stats = deriveProjectStats(richItems, chart, WEEK.start, WEEK.end, sessions);
  assert.equal(stats.P.daysActive, 3, 'max(2 commit-days, 3 session-days) = 3');
});

test('deriveProjectStats keeps the commit-day count when session-days are fewer (no regression)', () => {
  // 2 commit-days, 1 session-day -> max(2, 1) = 2: the commit-day count is never regressed.
  const chart = {
    days: [
      { date: '2024-06-11', byRepo: { r: 1 } },
      { date: '2024-06-12', byRepo: { r: 1 } },
    ],
  };
  const sessions = { days: [{ date: '2024-06-12', byProject: { r: 1 } }] };
  const richItems = [{ project: 'P', repo: 'r', status: 'shipped', date: '2024-06-12' }];
  const stats = deriveProjectStats(richItems, chart, WEEK.start, WEEK.end, sessions);
  assert.equal(stats.P.daysActive, 2, 'commit-day count (2) retained; max(2, 1) = 2');
});

test('deriveProjectStats never credits the catch-all "other" session pool to a named project', () => {
  // A repo-less named bucket ('Loose'): its only sessions live under the catch-all 'other' (every
  // unconfigured-cwd session). That pool must NOT be attributed to 'Loose' -> daysActive stays 0.
  const chart = { days: [{ date: '2024-06-12', byRepo: {} }] };
  const sessions = {
    days: [
      { date: '2024-06-12', byProject: { other: 5 } },
      { date: '2024-06-13', byProject: { other: 3 } },
    ],
  };
  const richItems = [{ project: 'Loose', repo: null, status: 'shipped', date: '2024-06-12' }];
  const stats = deriveProjectStats(richItems, chart, WEEK.start, WEEK.end, sessions);
  assert.equal(stats.Loose.daysActive, 0, "the 'other' pool is never attributed to a named project");
});

test('augmentSiteModel attaches chart/sessions/provenance and places day items by date', () => {
  const featured = initRepo();
  const emptySessions = mkdtempSync(join(tmpdir(), 'hw-derive-sess-'));
  try {
    const sha = commit(featured, '2024-06-12T10:00:00Z', 'ship it');
    const config = {
      identity: { authorEmails: [ME] },
      week: { timezone: 'UTC' },
      repos: [{ label: 'feat', path: featured, resolvedPath: featured, role: 'featured' }],
    };
    const items = [{ id: 'i1', repo: 'feat', text: 'Shipped the thing', tag: 'verified', primaryCommit: sha }];
    const verified = [{ sha, shortSha: sha.slice(0, 7), dateISO: '2024-06-12T10:00:00Z' }];
    const verifiedIndex = new Map(verified.map((v) => [v.sha, v]));
    const model = { week: WEEK, groups: [], items: [] };

    const out = augmentSiteModel(model, { config, items, verified, verifiedIndex, week: WEEK, now: new Date('2024-06-19T12:00:00Z'), projectsRoot: emptySessions });

    assert.ok(out.chart && out.sessions && out.provenance, 'all three derived sections attached');
    assert.equal(out.provenance.itemsTotal, 1);
    assert.equal(out.provenance.commitsVerified, 1);
    assert.equal(out.sessions.total, 0, 'no sessions in the empty root');
    // The item lands on its git-derived commit date (06-12), nowhere else.
    const day12 = out.chart.days.find((d) => d.date === '2024-06-12');
    assert.deepEqual(day12.items, [{ id: 'i1', title: 'Shipped the thing', status: 'shipped', project: 'feat' }]);
    assert.ok(out.chart.days.filter((d) => d.date !== '2024-06-12').every((d) => d.items.length === 0));
    // The same per-day items also reconnect the session hero.
    assert.deepEqual(out.sessions.days.find((d) => d.date === '2024-06-12').items, day12.items);
  } finally {
    rmSync(featured, { recursive: true, force: true });
    rmSync(emptySessions, { recursive: true, force: true });
  }
});
