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

import { commitDatesInWindow } from '../git.mjs';
import { statusForTag, STATUSES } from '../badges.mjs';
import { localDateInTimezone } from '../resolve-week.mjs';
import { weekGrid } from './week-grid.mjs';
import { deriveSessions } from './sessions.mjs';
import { deriveArchive, repoLastActivity } from './archive.mjs';

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
  return typeof iso === 'string' ? iso.slice(0, 10) : null;
}

/**
 * deriveChart({ config, weekStartKey, weekEndKey, todayKey }) -> chart
 *
 * commits/day across the readable (featured/reference) repos for the week, keyed
 * by author-date (the chart's day buckets and `repoTotals` use ONE git query so
 * the site's per-repo "commits this week" can't disagree with the chart). A
 * display-role repo is NEVER git-read; an unreadable repo contributes nothing
 * (never a fabricated zero-for-real). Mirrors the integrated tool's git flags
 * (author-filtered, `--no-merges`) so the numbers byte-match.
 *
 * Shared git derivation: used by both the `site` mode (augmentSiteModel) and the
 * standalone `page` mode (lib/emit/page.mjs) — it is the one chart derivation, not
 * site-only, so the two report styles can't disagree on commits/day.
 */
export function deriveChart({ config, weekStartKey, weekEndKey, todayKey }) {
  const authorEmails = config?.identity?.authorEmails ?? [];
  // Only FEATURED repos are charted: featured = git-read + headlined; reference is
  // git-read for verification only (not headlined, so not charted); display is
  // never git-read. (Mirrors the integrated tool's featured-only chart.)
  const repos = (Array.isArray(config?.repos) ? config.repos : []).filter((r) => r.role === 'featured');

  const days = weekGrid(weekStartKey, todayKey).map((stub) => ({ ...stub, total: 0, byRepo: {}, items: [] }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const repoTotals = {};

  for (const repo of repos) {
    repoTotals[repo.label] = 0;
    for (const key of commitDatesInWindow(repo.resolvedPath ?? repo.path, authorEmails, weekStartKey, weekEndKey)) {
      const bucket = byDate.get(key);
      if (!bucket) continue; // outside the 7-day grid — never invented
      bucket.total += 1;
      bucket.byRepo[repo.label] = (bucket.byRepo[repo.label] || 0) + 1;
      repoTotals[repo.label] += 1;
    }
  }

  const max = days.reduce((m, d) => Math.max(m, d.total), 0);
  return { metric: 'commits', windowDays: days.length, weekStart: weekStartKey, weekEnd: weekEndKey, max, days, repoTotals };
}

/**
 * deriveProjectStats(richItems, chart, weekStartKey, weekEndKey, sessions?) ->
 *   { [project]: { entries, statusCounts, daysActive } }
 *
 * Per-project aggregate COUNTS over the IN-WEEK items + chart + sessions. These are
 * the numbers a grouped site card shows that are not already in chart/sessions
 * (entries, status tallies, active-day count). Only items whose derived date falls
 * in the reported week are counted (the feed never overclaims earlier-week work).
 *
 * `daysActive` is max(commit-active days, session-active days): a git-backed project
 * counts the days it committed (chart.byRepo); a display-role / session-only project
 * (never git-read, so 0 commit-days) counts the days it had interactive sessions
 * (sessions.days[].byProject), so it no longer reads `0` active-days for a week it was
 * genuinely active. Session-active days are attributed by the key the session bundle
 * buckets under: a project's CONFIG REPO-LABEL (`_repo`) when it has one, else — for a
 * REPO-LESS display / session-only project — its STATS KEY (the project name), which is
 * the same key the bundle buckets under and the key a consumer joins `sessionsThisWeek`
 * by, so a repo-less project's `daysActive` can never disagree with its shown session
 * count. The catch-all `'other'` is never credited to a named project. Both inputs are
 * deterministic counts (git / on-disk session logs), never authored, so the fact-fence
 * can still trace every number. `sessions` is optional: absent, `daysActive` is the
 * commit-only count (unchanged).
 */
export function deriveProjectStats(richItems, chart, weekStartKey, weekEndKey, sessions) {
  const days = chart?.days ?? [];
  const inWeek = (Array.isArray(richItems) ? richItems : []).filter(
    (it) => it.date && it.date >= weekStartKey && it.date <= weekEndKey
  );
  const stats = {};
  for (const item of inWeek) {
    const project = item.project ?? item.repo ?? null;
    if (project == null) continue;
    if (!stats[project]) stats[project] = { entries: 0, statusCounts: {}, daysActive: 0, _repo: item.repo ?? null };
    const s = stats[project];
    s.entries += 1;
    const status = item.status ?? statusFor(item);
    s.statusCounts[status] = (s.statusCounts[status] || 0) + 1;
  }
  // Session-active days are attributed by the key the session bundle buckets under
  // (sessions.days[].byProject / projectTotals). The catch-all 'other' (and a null key) get no
  // credit: that pool belongs to no single named project, so crediting it would mis-attribute
  // unconfigured-cwd (or another project's) sessions to a named one.
  const sessionDays = (label) =>
    label == null || label === 'other' ? 0 : (sessions?.days ?? []).filter((d) => (d.byProject?.[label] || 0) > 0).length;
  for (const project of Object.keys(stats)) {
    const repo = stats[project]._repo;
    const commitDays = repo ? days.filter((d) => (d.byRepo[repo] || 0) > 0).length : 0;
    // Session-day key: a git-backed project uses its config repo-label (_repo); a repo-less display /
    // session-only project (_repo null) falls back to its STATS KEY (the project name) — the same key
    // the bundle buckets under (sessions.days[].byProject) and that the consumer joins sessionsThisWeek
    // by. So a repo-less project counts the days it actually had sessions instead of reading 0, and its
    // daysActive can never disagree with the (name-keyed) session count shown beside it.
    const sessionKey = repo ?? project;
    // max(commit-days, session-days): a git-backed project keeps (and may exceed) its commit-day
    // count; a display/session-only repo (never charted -> commitDays 0) gets its session-day count.
    stats[project].daysActive = Math.max(commitDays, sessionDays(sessionKey));
    delete stats[project]._repo;
  }
  return stats;
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

/** featured-role repo labels whose repo is readable (for meta.featuredRepos). */
function featuredRepoLabels(config) {
  return (Array.isArray(config?.repos) ? config.repos : [])
    .filter((r) => r.role === 'featured')
    .map((r) => r.label);
}

/**
 * augmentSiteModel(model, ctx) -> rich site BUNDLE
 *
 * `ctx = { config, items, verified, verifiedIndex, week, now, projectsRoot?,
 * content?, projects? }`. Returns the assembled model PLUS every derived section a
 * site artifact needs: chart, sessions, provenance, per-project stat counts,
 * per-repo git history (archive + lastActivity), derived meta, the verified
 * full-field items (with re-derived dates), and the curated `content`/`projects`
 * passthrough. A static adapter maps the subset it references; a transform
 * consumes the whole bundle. Every NUMBER here is git/session-derived or a
 * deterministic count — never authored — so the fact-fence can trace all of them.
 */
export function augmentSiteModel(model, { config, items, verified, verifiedIndex, week, now, projectsRoot, content, projects } = {}) {
  const tz = config?.week?.timezone || 'UTC';
  const weekStart = new Date(`${week.start}T00:00:00.000Z`);
  const weekEnd = new Date(`${week.end}T23:59:59.999Z`);
  const weekStartKey = week.start;
  const weekEndKey = week.end;

  // tz-correct "today" for the volatile isToday flag (masked by the parity gate).
  const instant = now instanceof Date ? now : new Date(weekEnd.getTime());
  const todayKey = localDateInTimezone(instant, tz).toISOString().slice(0, 10);

  const chart = deriveChart({ config, weekStartKey, weekEndKey, todayKey });
  const sessions = deriveSessions({ config, weekStart, weekEnd, now, projectsRoot });
  const provenance = deriveProvenance({ items, verified });

  // Per-repo git history (readable repos only; display repos are never git-read).
  const authorEmails = config?.identity?.authorEmails ?? [];
  const repos = (Array.isArray(config?.repos) ? config.repos : [])
    .filter((r) => r.role !== 'display')
    .map((r) => {
      const path = r.resolvedPath ?? r.path;
      return { label: r.label, role: r.role, archive: deriveArchive(path, authorEmails, instant), lastActivity: repoLastActivity(path, authorEmails) };
    });

  // Verified, full-field items: the authored fields pass through (redacted later by
  // build), with the git-derived date attached and verified=true (build aborts
  // before this runs unless every cited commit resolved).
  const richItems = (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    status: item.status ?? statusFor(item),
    // The git-derived commit date wins; an item that cites no commit (e.g. a
    // display-repo, session-dated item) keeps its authored date.
    date: itemDate(item, verifiedIndex) ?? item.date ?? null,
    verified: true,
  }));

  const projectStats = deriveProjectStats(richItems, chart, weekStartKey, weekEndKey, sessions);

  // Reconnect the chart/hero to the feed: each day carries that day's items.
  const itemsByDate = new Map();
  for (const it of richItems) {
    if (!it.date) continue;
    if (!itemsByDate.has(it.date)) itemsByDate.set(it.date, []);
    itemsByDate.get(it.date).push({ id: it.id ?? null, title: it.title ?? it.text ?? it.summary ?? '', status: it.status, project: it.project ?? it.repo ?? null });
  }
  for (const day of chart.days) day.items = itemsByDate.get(day.date) || [];
  for (const day of sessions.days) day.items = itemsByDate.get(day.date) || [];

  const meta = {
    weekStart: weekStartKey,
    weekEnd: weekEndKey,
    weekOf: weekStartKey,
    windowDays: chart.windowDays,
    featuredRepos: featuredRepoLabels(config),
    authorEmails: authorEmails.slice(),
    generatedAt: instant.toISOString(),
  };

  return {
    ...model,
    meta,
    chart,
    sessions,
    provenance,
    projectStats,
    repos,
    items: richItems,
    content: content ?? null,
    projects: projects ?? null,
  };
}
