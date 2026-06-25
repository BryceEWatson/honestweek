// lib/site/derive.mjs — the git-derived site sections + model augmentation.
//
// The site emitter resolves an adapter against a VERIFIED, derived-augmented
// model. This module computes the derived sections that an integrated site needs
// and that honestweek can stand behind because every number in them is
// re-derived from git (or deterministically counted from sessions), never
// authored:
//   - chart       — commits/day across the readable repos, with per-repo counts
//                   and the day's items (the git-grounded activity signal).
//   - provenance  — itemsTotal / itemsVerified / commitsVerified / redactions.
//   - sessions    — the interactive-session hero (see sessions.mjs; session-derived).
//
// `augmentSiteModel` returns a NEW model = the assembled report model plus these
// sections. The value context (values.mjs) seeds its verified-number set from
// EXACTLY these trusted sections, so a number can reach the artifact only if it
// is one of these re-derived facts.
//
// Zero runtime dependencies: Node built-ins + system git (via lib/git.mjs).

import { commitsInWindow } from '../git.mjs';
import { statusForTag, STATUSES } from '../badges.mjs';
import { localDateInTimezone } from '../resolve-week.mjs';
import { weekGrid } from './week-grid.mjs';
import { deriveSessions } from './sessions.mjs';

/** The primary cited commit SHA for an item, from any supported provenance.
 *  (A local copy of build's picker so derive stays free of a build→derive cycle.) */
function primarySha(item) {
  return (
    item.primaryCommit ||
    item.receipt?.primaryCommit ||
    item.commit ||
    (Array.isArray(item.commits) ? item.commits[0] : undefined) ||
    (Array.isArray(item.candidateCommits)
      ? typeof item.candidateCommits[0] === 'string'
        ? item.candidateCommits[0]
        : item.candidateCommits[0]?.sha
      : undefined) ||
    null
  );
}

/** The public status badge for an item (explicit status wins; else map its tag). */
function statusFor(item) {
  if (STATUSES.includes(item.status)) return item.status;
  return statusForTag(item.tag ?? item.status);
}

/** Map each item to its git-derived date (YYYY-MM-DD) via its verified primary
 *  commit, or null when it cites no resolved commit (then it has no chart day). */
function itemDate(item, verifiedIndex) {
  const sha = primarySha(item);
  const v = sha ? verifiedIndex.get(sha) : null;
  const iso = v?.dateISO;
  // UTC calendar date of the commit instant — same basis as the chart day buckets,
  // so an item lands on the same grid day its commit is charted under.
  return typeof iso === 'string' ? new Date(iso).toISOString().slice(0, 10) : null;
}

/**
 * deriveChart({ config, weekStartKey, weekEndKey, todayKey, sinceISO, untilISO }) -> chart
 *
 * commits/day across the readable (featured/reference) repos for the week. A
 * display-role repo is NEVER git-read. Numbers are re-derived from git; an
 * unreadable repo simply contributes nothing (never a fabricated zero-for-real).
 */
export function deriveChart({ config, weekStartKey, weekEndKey, todayKey, sinceISO, untilISO }) {
  const authorEmails = config?.identity?.authorEmails ?? [];
  const repos = (Array.isArray(config?.repos) ? config.repos : []).filter((r) => r.role !== 'display');

  const days = weekGrid(weekStartKey, todayKey).map((stub) => ({ ...stub, total: 0, byRepo: {}, items: [] }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const repoTotals = {};

  for (const repo of repos) {
    repoTotals[repo.label] = 0;
    let commits;
    try {
      commits = commitsInWindow(repo.resolvedPath ?? repo.path, authorEmails, sinceISO, untilISO);
    } catch {
      continue; // unreadable repo -> no fabricated metric (mirrors repoMetricsInWindow)
    }
    for (const c of commits) {
      // Bucket by the UTC calendar date of the commit instant — the SAME basis
      // commitsInWindow filters on and weekGrid is built on. Using the author-tz
      // date slice instead would drop a tz-boundary commit from the chart that
      // commitsInWindow (and thus group.metrics.commits) still counts, putting two
      // disagreeing "commits this week" numbers in one artifact. With the UTC basis,
      // every in-window commit lands in a grid day, so repoTotals == metrics.commits.
      const key = c.dateISO ? new Date(c.dateISO).toISOString().slice(0, 10) : '';
      const bucket = byDate.get(key);
      if (!bucket) continue; // defensive — an in-window commit always has a grid day
      bucket.total += 1;
      bucket.byRepo[repo.label] = (bucket.byRepo[repo.label] || 0) + 1;
      repoTotals[repo.label] += 1;
    }
  }

  const max = days.reduce((m, d) => Math.max(m, d.total), 0);
  return { metric: 'commits', windowDays: days.length, weekStart: weekStartKey, weekEnd: weekEndKey, max, days, repoTotals };
}

/**
 * deriveProvenance({ items, verified }) -> { itemsTotal, itemsVerified, commitsVerified, redactions }
 *
 * Counts only. `redactions` is left 0 here and filled by the build AFTER the
 * redaction pass (its true value is the redactor's hit count). `itemsVerified`
 * equals `itemsTotal` because the build aborts before this runs unless every
 * cited commit resolved; `commitsVerified` is the number of re-derived commits.
 */
export function deriveProvenance({ items, verified }) {
  const itemsTotal = Array.isArray(items) ? items.length : 0;
  return {
    itemsTotal,
    itemsVerified: itemsTotal,
    commitsVerified: Array.isArray(verified) ? verified.length : 0,
    redactions: 0,
  };
}

/**
 * augmentSiteModel(model, ctx) -> { ...model, chart, sessions, provenance }
 *
 * `ctx = { config, items, verified, verifiedIndex, week, now, projectsRoot? }`.
 * `model` is the assembled report model; `items` are the raw distilled items
 * (for per-day item placement + counts); `verified`/`verifiedIndex` are the git
 * verify-pass results; `week` is { start, end } ISO strings. Pure given its
 * inputs except for the session-log + git reads the derivers perform.
 */
export function augmentSiteModel(model, { config, items, verified, verifiedIndex, week, now, projectsRoot } = {}) {
  const tz = config?.week?.timezone || 'UTC';
  const weekStart = new Date(`${week.start}T00:00:00.000Z`);
  const weekEnd = new Date(`${week.end}T23:59:59.999Z`);
  const weekStartKey = week.start;
  const weekEndKey = week.end;

  // tz-correct "today" for the volatile isToday flag (masked by the parity gate).
  const instant = now instanceof Date ? now : new Date(weekEnd.getTime());
  const todayKey = localDateInTimezone(instant, tz).toISOString().slice(0, 10);

  const sinceISO = `${weekStartKey}T00:00:00.000Z`;
  const untilISO = `${weekEndKey}T23:59:59.999Z`;

  const chart = deriveChart({ config, weekStartKey, weekEndKey, todayKey, sinceISO, untilISO });
  const sessions = deriveSessions({ config, weekStart, weekEnd, now, projectsRoot });
  const provenance = deriveProvenance({ items, verified });

  // Reconnect the chart/hero to the feed: each day carries that day's items
  // (id + title + status + project), placed by the item's git-derived date.
  const itemsByDate = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const date = itemDate(item, verifiedIndex);
    if (!date) continue;
    if (!itemsByDate.has(date)) itemsByDate.set(date, []);
    itemsByDate.get(date).push({
      id: item.id ?? null,
      title: item.text ?? item.summary ?? '',
      status: statusFor(item),
      project: item.repo ?? null,
    });
  }
  for (const day of chart.days) day.items = itemsByDate.get(day.date) || [];
  for (const day of sessions.days) day.items = itemsByDate.get(day.date) || [];

  return { ...model, chart, sessions, provenance };
}
