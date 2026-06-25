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

import { deriveChart, deriveProvenance, augmentSiteModel } from '../lib/site/derive.mjs';

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
    commit(featured, '2024-06-12T10:00:00Z');
    commit(featured, '2024-06-12T15:00:00Z');
    commit(featured, '2024-06-13T09:00:00Z');
    commit(featured, '2024-06-01T09:00:00Z'); // out of window -> ignored
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
