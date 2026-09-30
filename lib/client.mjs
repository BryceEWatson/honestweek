// lib/client.mjs — the model behind the `client` output mode: a report of the work
// done for one client over any period (a sprint, a month, a contract to date), meant
// to be handed to that client.
//
// Honesty model, the same posture as every other mode:
//   - build has already verify-or-aborted every cited commit (resolves, authored by
//     a configured identity) and run the landed gate before this runs;
//   - every NUMBER here is honestweek's own git derivation: pull requests and commits
//     that reached the default branch, authored by you, dated inside the period. A
//     repo that cannot be read yields a null, never a 0;
//   - PR numbers are parsed from the verified commit subjects, never authored;
//   - a cited commit dated outside the period aborts the build (ClientReportError):
//     a report must not credit work to a period it did not happen in;
//   - curated strings (titles, summaries, the headline) are trusted, redacted by the
//     build, and HTML-escaped at render.
// Pure apart from the git reads in deriveClientStats.

import { landedCommitsInWindow, prNumberFromSubject } from './git.mjs';
import { STATUSES } from './badges.mjs';

export class ClientReportError extends Error {}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_WEEK_BUCKETS = 40;

/** What each badge means in a client's words. `shipped` says exactly what the
 *  landed gate proves (on the default branch), not that it is live in production. */
export const CLIENT_STATUS = Object.freeze({
  shipped: { label: 'Merged', key: 'merged', meaning: 'on the main branch; every cited commit checked against git' },
  'in progress': { label: 'In progress', key: 'progress', meaning: 'real work, not on the main branch yet' },
  'designed, not proven': { label: 'Designed', key: 'designed', meaning: 'the approach exists; no real result yet' },
});

function ymd(date) {
  return date.toISOString().slice(0, 10);
}
function parseYmd(s) {
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ClientReportError(`"${s}" is not a YYYY-MM-DD date.`);
  return d;
}
function addDays(s, n) {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
/** The Monday on or before a YYYY-MM-DD date. */
function mondayOf(s) {
  const d = parseYmd(s);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return ymd(d);
}
export function dayLabel(s) {
  if (!s) return '';
  const d = parseYmd(s);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function periodLabel(start, end) {
  const a = parseYmd(start);
  const b = parseYmd(end);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const left = `${MONTHS_LONG[a.getUTCMonth()]} ${a.getUTCDate()}${sameYear ? '' : `, ${a.getUTCFullYear()}`}`;
  return `${left} to ${MONTHS_LONG[b.getUTCMonth()]} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}
/** A commit's calendar date as its author saw it (the offset git recorded). */
function authorDay(dateISO) {
  return String(dateISO ?? '').slice(0, 10);
}

/** Buckets for the activity chart: weeks (Monday start) while they fit, else months. */
function buildSeries(start, end, days) {
  const weekCount = Math.floor((parseYmd(mondayOf(end)) - parseYmd(mondayOf(start))) / (7 * 86400000)) + 1;
  const unit = weekCount <= MAX_WEEK_BUCKETS ? 'week' : 'month';
  const buckets = [];
  if (unit === 'week') {
    for (let w = mondayOf(start); w <= end; w = addDays(w, 7)) {
      const d = parseYmd(w);
      buckets.push({ key: w, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`, month: d.getUTCMonth(), count: 0 });
    }
  } else {
    const a = parseYmd(start);
    const b = parseYmd(end);
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth()); m === 11 ? (y++, (m = 0)) : m++) {
      buckets.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTHS[m]} ${y}`, month: m, count: 0 });
    }
  }
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  for (const day of days) {
    const key = unit === 'week' ? mondayOf(day) : day.slice(0, 7);
    const i = index.get(key);
    if (i !== undefined) buckets[i].count += 1;
  }
  return { unit, buckets, max: buckets.reduce((m, b) => Math.max(m, b.count), 0) };
}

/**
 * deriveClientStats({ config, period }) -> git-derived numbers for the period.
 * Reads every featured/reference repo (display repos are never git-read). A repo
 * that cannot be read, or has no determinable default branch, is listed in
 * `unreadable` and makes the totals null rather than silently smaller.
 */
export function deriveClientStats({ config, period }) {
  const sinceISO = `${period.start}T00:00:00.000Z`;
  const untilISO = `${period.end}T23:59:59.999Z`;
  const unreadable = [];
  const commits = [];
  for (const repo of config.repos ?? []) {
    if (repo.role === 'display') continue;
    const got = landedCommitsInWindow(repo.resolvedPath ?? repo.path, config.identity.authorEmails, sinceISO, untilISO);
    if (!got) {
      unreadable.push(repo.label);
      continue;
    }
    for (const c of got.commits) commits.push({ ...c, repo: repo.label });
  }
  const nonMerge = commits.filter((c) => !c.isMerge);
  // A merge commit is never credit: merging a teammate's pull request is not writing it.
  const prMap = new Map();
  const prBySha = new Map();
  for (const c of nonMerge) {
    if (c.pr != null) prBySha.set(c.sha, c.pr);
    if (c.pr == null) continue;
    const key = `${c.repo}#${c.pr}`;
    const prev = prMap.get(key);
    if (!prev || c.dateISO < prev.dateISO) prMap.set(key, { repo: c.repo, pr: c.pr, sha: c.sha, shortSha: c.shortSha, subject: c.subject, dateISO: c.dateISO });
  }
  const days = new Set(nonMerge.map((c) => authorDay(c.dateISO)).filter(Boolean));
  const complete = unreadable.length === 0;
  return {
    complete,
    unreadable,
    prBySha,
    prs: [...prMap.values()].sort((a, b) => String(a.dateISO).localeCompare(String(b.dateISO)) || a.pr - b.pr),
    totals: {
      prs: complete ? prMap.size : null,
      commits: complete ? nonMerge.length : null,
      activeDays: complete ? days.size : null,
      directCommits: complete ? nonMerge.filter((c) => c.pr == null).length : null,
    },
    series: buildSeries(period.start, period.end, nonMerge.map((c) => authorDay(c.dateISO))),
  };
}

function prLinkFor(config, repo, n) {
  const base = config.client?.prLinks?.[repo];
  return base ? `${base}${n}` : null;
}

/**
 * buildClientModel({ items, config, verified, period, content, stats, now }) -> the client page model.
 * `verified` is build's verify-or-abort result (each { sha, shortSha, subject,
 * dateISO, repoLabel, landed }). Throws ClientReportError on a cited commit dated
 * outside the period.
 */
export function buildClientModel({ items = [], config, verified = [], period, content = null, stats, now = new Date() }) {
  if (!period?.start || !period?.end || period.start > period.end) {
    throw new ClientReportError('the report period needs a start on or before its end.');
  }
  const bySha = new Map();
  for (const v of verified) bySha.set(v.sha, v);
  const c = content && typeof content === 'object' ? content : {};

  const declared = Array.isArray(c.themes) ? c.themes.filter((t) => t && t.id) : [];
  const themeById = new Map(declared.map((t) => [String(t.id), { id: String(t.id), title: String(t.title || t.id), summary: t.summary ?? '', items: [] }]));
  const other = { id: 'other', title: 'Other work', summary: '', items: [] };

  const citedPrs = new Set();
  const views = items.map((item, i) => {
    const shas = [...new Set([item.primaryCommit, item.commit, item.receipt?.primaryCommit, ...(Array.isArray(item.commits) ? item.commits : [])].filter((s) => typeof s === 'string' && s))];
    const commits = [];
    for (const sha of shas) {
      const v = bySha.get(sha) || [...bySha.values()].find((x) => x.sha.startsWith(sha));
      if (!v) continue;
      const day = authorDay(v.dateISO);
      if (day < period.start || day > period.end) {
        throw new ClientReportError(`item ${item.id ?? `item[${i}]`} cites commit ${v.shortSha} dated ${day}, outside the report period ${period.start} to ${period.end}.`);
      }
      const landedPr = [...(stats.prBySha ?? new Map())].find(([full]) => full.startsWith(v.sha))?.[1];
      commits.push({ sha: v.sha, shortSha: v.shortSha, subject: v.subject, date: day, repo: v.repoLabel ?? item.repo ?? null, pr: prNumberFromSubject(v.subject) ?? landedPr ?? null });
    }
    commits.sort((a, b) => a.date.localeCompare(b.date));
    const prs = [];
    for (const cm of commits) {
      if (cm.pr == null || prs.some((p) => p.n === cm.pr && p.repo === cm.repo)) continue;
      prs.push({ n: cm.pr, repo: cm.repo, url: prLinkFor(config, cm.repo, cm.pr) });
      citedPrs.add(`${cm.repo}#${cm.pr}`);
    }
    const status = STATUSES.includes(item.status) ? item.status : 'designed, not proven';
    const date = commits.length ? commits[commits.length - 1].date : item.date ?? null;
    const view = {
      id: item.id != null && String(item.id).trim() ? String(item.id) : `w${i}`,
      title: String(item.title || item.summary || item.text || 'Untitled').trim(),
      summary: item.summary ?? item.text ?? '',
      status,
      statusLabel: CLIENT_STATUS[status].label,
      statusKey: CLIENT_STATUS[status].key,
      date,
      dateLabel: date ? dayLabel(date) : '',
      highlight: item.highlight === true,
      prs,
      commits,
      theme: themeById.has(String(item.theme)) ? String(item.theme) : 'other',
    };
    (themeById.get(view.theme) || other).items.push(view);
    return view;
  });

  const themes = [...themeById.values(), other]
    .filter((t) => t.items.length)
    .map((t) => {
      t.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const prKeys = new Set(t.items.flatMap((it) => it.prs.map((p) => `${p.repo}#${p.n}`)));
      return { ...t, anchor: `area-${t.id}`, counts: { items: t.items.length, prs: prKeys.size } };
    });

  const appendix = stats.prs.map((p) => ({
    repo: p.repo,
    n: p.pr,
    url: prLinkFor(config, p.repo, p.pr),
    date: authorDay(p.dateISO),
    dateLabel: dayLabel(authorDay(p.dateISO)),
    title: String(p.subject).replace(/\s*\(#\d+\)\s*$/, '').replace(/^Merge pull request #\d+ from \S+\s*/, ''),
    cited: citedPrs.has(`${p.repo}#${p.pr}`),
  }));

  const statusCounts = {};
  for (const v of views) statusCounts[v.statusKey] = (statusCounts[v.statusKey] || 0) + 1;
  const present = new Set(views.map((v) => v.status));
  const tz = config.week?.timezone || 'UTC';
  const generatedOn = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const cl = config.client || {};
  const paragraphs = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((s) => s.trim());

  return {
    kind: 'client',
    client: {
      name: cl.name ?? '',
      preparedFor: cl.preparedFor ?? '',
      preparedBy: cl.preparedBy ?? '',
      organization: cl.organization ?? '',
    },
    period: { start: period.start, end: period.end, label: periodLabel(period.start, period.end) },
    generatedOn,
    generatedLabel: periodLabel(generatedOn, generatedOn).replace(/^.* to /, ''),
    title: c.title || `${cl.name || 'Client'} work report`,
    headline: c.headline || '',
    summary: paragraphs(c.summary),
    next: paragraphs(c.next),
    stats: {
      complete: stats.complete,
      unreadable: stats.unreadable,
      prs: stats.totals.prs,
      commits: stats.totals.commits,
      activeDays: stats.totals.activeDays,
      directCommits: stats.totals.directCommits,
      areas: themes.length,
      itemsTotal: views.length,
      statusCounts,
      prsCited: appendix.filter((a) => a.cited).length,
    },
    series: stats.series,
    legend: Object.entries(CLIENT_STATUS).filter(([k]) => present.has(k)).map(([, v]) => v),
    highlights: views.filter((v) => v.highlight),
    themes,
    appendix,
    provenance: { commitsVerified: new Set(views.flatMap((v) => v.commits.map((x) => x.sha))).size },
  };
}
