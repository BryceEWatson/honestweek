// lib/site/archive.mjs — the per-repo commit-history archive deriver (site mode).
//
// A site's per-project card can show activity OUTSIDE the current week (a longer
// horizon than the chart's 7 days). This re-derives that history from git, monthly,
// counts only (no subjects -> leak-safe). It mirrors the established convention an
// integrated site already uses (author-filtered, non-merge commits, bucketed by
// author-month) so the numbers byte-match. Git-derived, never authored.
//
// Zero runtime dependencies: Node built-ins + system git (via lib/git.mjs).

import { commitMonthsSince, lastCommitDate } from '../git.mjs';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * deriveArchive(repoPath, authorEmails, now, monthsBack = 6) ->
 *   { monthsBack, months: [{ month, label, year, commits }], totalCommits, maxMonth }
 *
 * `now` is the build instant (a Date). The horizon is the `monthsBack` calendar
 * months ending in `now`'s month, pre-seeded so a quiet month renders as zero.
 * Month buckets use local calendar arithmetic (matching the integrated tool's
 * convention). An unreadable repo yields all-zero months (never a fabricated count).
 */
export function deriveArchive(repoPath, authorEmails, now, monthsBack = 6) {
  const start = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1);
  const sinceYmd = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;

  const byMonth = new Map();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, { month: key, label: MONTHS[d.getMonth()], year: d.getFullYear(), commits: 0 });
  }

  for (const m of commitMonthsSince(repoPath, authorEmails, sinceYmd)) {
    if (byMonth.has(m)) byMonth.get(m).commits += 1;
  }

  const months = [...byMonth.values()];
  const totalCommits = months.reduce((s, m) => s + m.commits, 0);
  const maxMonth = months.reduce((mx, m) => Math.max(mx, m.commits), 0);
  return { monthsBack, months, totalCommits, maxMonth };
}

/** The most recent authored, non-merge commit date (YYYY-MM-DD) in the repo, or null. */
export function repoLastActivity(repoPath, authorEmails) {
  return lastCommitDate(repoPath, authorEmails);
}
