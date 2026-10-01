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
  'in progress': { label: 'In progress', key: 'progress', meaning: "real work that isn't finished, or isn't on the main branch yet" },
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
  // Every date here is when the commit LANDED on the default branch (landedISO), the
  // same clock that decided it belongs to the period.
  const prMap = new Map();
  const landed = new Map(); // repoShaKey(repo, full sha) -> { landedISO, pr }
  for (const c of nonMerge) {
    landed.set(repoShaKey(c.repo, c.sha), { landedISO: c.landedISO, pr: c.pr });
    if (c.pr == null) continue;
    const key = `${c.repo}#${c.pr}`;
    const prev = prMap.get(key);
    if (!prev || c.landedISO < prev.dateISO) prMap.set(key, { repo: c.repo, pr: c.pr, sha: c.sha, shortSha: c.shortSha, subject: c.subject, dateISO: c.landedISO });
  }
  const days = new Set(nonMerge.map((c) => authorDay(c.landedISO)).filter(Boolean));
  const complete = unreadable.length === 0;
  return {
    complete,
    unreadable,
    landed,
    prs: [...prMap.values()].sort((a, b) => String(a.dateISO).localeCompare(String(b.dateISO)) || a.pr - b.pr),
    totals: {
      prs: complete ? prMap.size : null,
      commits: complete ? nonMerge.length : null,
      activeDays: complete ? days.size : null,
      directCommits: complete ? nonMerge.filter((c) => c.pr == null).length : null,
    },
    series: buildSeries(period.start, period.end, nonMerge.map((c) => authorDay(c.landedISO))),
  };
}

/** Commit evidence is keyed by repo AND sha: the same commit can sit in two configured
 *  repos (a fork and its upstream), and a sha-only key would let one overwrite the other. */
function repoShaKey(repo, sha) {
  return `${JSON.stringify(repo ?? null)}\u0000${sha}`;
}
/** The entry for (repo, sha) in a repoShaKey map, accepting an abbreviated sha. */
function lookupByRepoSha(map, repo, sha) {
  const exact = map.get(repoShaKey(repo, sha));
  if (exact) return exact;
  const prefix = repoShaKey(repo, sha);
  for (const [k, v] of map) if (k.startsWith(prefix)) return v;
  return null;
}

/** A PR subject as a reader would say it: no "(#12)", no "feat(scope): " prefix. */
export function readableTitle(subject) {
  const t = String(subject ?? '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/^[a-z]+(\([^)]*\))?!?:\s+/, '')
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : String(subject ?? '');
}

/** Issue numbers a commit message names ("#519", "Fixes #504"), minus its own PR number. */
export function issueRefs(message, ownPr = null) {
  const out = new Set();
  for (const m of String(message ?? '').matchAll(/(?:^|[^\w/&])#(\d{1,6})\b/g)) {
    const n = Number(m[1]);
    if (n !== ownPr) out.add(n);
  }
  return [...out];
}

function compact(v, matched = []) {
  return { id: v.id, title: v.title, statusLabel: v.statusLabel, statusKey: v.statusKey, dateLabel: v.dateLabel, matched };
}

/**
 * applyView({ profile, themes, views, content }) -> { themes, shownIds, model }
 * The reader's view over the finished items. Rules it keeps (docs/reader-profiles.md):
 * items are never edited; an excluded area is counted, never silently dropped; the
 * record and the method are always in the order; a tag that no section picks, or an
 * exclusion naming no area, is refused as a likely typo.
 */
export function applyView({ profile, themes, views, content }) {
  // A report states what was done, with evidence. An ask ("what I need from you") has
  // none and turns the report into a negotiation; it belongs in the message you send
  // with the report, so the items file can't carry one.
  if (content && content.needs !== undefined) {
    throw new ClientReportError('content.needs isn\'t supported: a report says what was done, with evidence. Put asks in the message you send with it.');
  }
  const p = profile ?? { order: ['highlights', 'activity', 'done', 'not-finished', 'next', 'record', 'how'], sections: [], exclude: { themes: [] }, format: { note: false }, guidance: [], unconfirmed: false };
  const themeIds = new Set(themes.map((t) => t.id));
  for (const id of p.exclude.themes) {
    if (!themeIds.has(id)) throw new ClientReportError(`the reader profile excludes area ${JSON.stringify(id)}, but no change in this report is in that area.`);
  }
  const pickedTags = new Set(p.sections.flatMap((s) => s.select.tags ?? []));
  for (const v of views) {
    const stray = v.tags.find((t) => !pickedTags.has(t));
    if (stray) throw new ClientReportError(`item ${v.id} is tagged ${JSON.stringify(stray)}, but no section of the reader profile picks that tag.`);
  }
  const excluded = new Set(p.exclude.themes);
  const shownThemes = themes.filter((t) => !excluded.has(t.id));
  const hiddenThemes = themes.filter((t) => excluded.has(t.id));
  const sections = p.sections.map((s) => {
    const byIssues = Array.isArray(s.select.issues);
    const wanted = new Set(byIssues ? s.select.issues : s.select.tags);
    const rows = views
      .map((v) => ({ v, hits: byIssues ? v.issues.filter((n) => wanted.has(n)) : v.tags.filter((t) => wanted.has(t)) }))
      .filter((x) => x.hits.length)
      .sort((a, b) => String(b.v.date || '').localeCompare(String(a.v.date || '')))
      .map((x) => compact(x.v, x.hits));
    return { id: s.id, title: s.title, summary: s.summary, pickedBy: byIssues ? 'git' : 'hand', wanted: [...wanted], rows };
  });
  const notFinished = views.filter((v) => v.status !== 'shipped').map((v) => compact(v));
  const shownIds = new Set([
    ...shownThemes.flatMap((t) => t.items.map((v) => v.id)),
    ...sections.flatMap((s) => s.rows.map((r) => r.id)),
    ...notFinished.map((r) => r.id),
  ]);
  const hiddenItems = hiddenThemes.reduce((n, t) => n + t.items.length, 0);
  const paragraphs = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((x) => x.trim());
  return {
    themes: shownThemes,
    shownIds,
    model: {
      order: p.order,
      sections,
      notFinished,
      hidden: { items: hiddenItems, areas: hiddenThemes.map((t) => t.title) },
      note: p.format.note === true,
    },
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
export function buildClientModel({ items = [], config, verified = [], period, content = null, stats, now = new Date(), profile = null, messageFor = null }) {
  if (!period?.start || !period?.end || period.start > period.end) {
    throw new ClientReportError('the report period needs a start on or before its end.');
  }
  const byRepoSha = new Map();
  for (const v of verified) byRepoSha.set(repoShaKey(v.repoLabel, v.sha), v);
  const landedMap = stats.landed ?? new Map();
  const c = content && typeof content === 'object' ? content : {};

  const declared = Array.isArray(c.themes) ? c.themes.filter((t) => t && t.id) : [];
  const themeById = new Map(declared.map((t) => [String(t.id), { id: String(t.id), title: String(t.title || t.id), summary: t.summary ?? '', items: [] }]));
  const other = { id: 'other', title: 'Other work', summary: '', items: [] };

  const citedPrs = new Set();
  const views = items.map((item, i) => {
    const shas = [...new Set([item.primaryCommit, item.commit, item.receipt?.primaryCommit, ...(Array.isArray(item.commits) ? item.commits : [])].filter((s) => typeof s === 'string' && s))];
    const commits = [];
    const issues = new Set();
    const repo = item.repo ?? item.repoLabel ?? item.label ?? null;
    for (const sha of shas) {
      const v = lookupByRepoSha(byRepoSha, repo, sha);
      if (!v) continue;
      // A landed commit is dated by when it landed, the same clock the period uses. One
      // that is on the default branch but not in this period's landed set landed outside
      // it. Unlanded work (build downgraded it to in progress) is dated by its author date.
      const land = lookupByRepoSha(landedMap, repo, v.sha);
      const day = authorDay(land ? land.landedISO : v.dateISO);
      if (!land && v.landed === true) {
        throw new ClientReportError(`item ${item.id ?? `item[${i}]`} cites commit ${v.shortSha}, which landed on the default branch outside the report period ${period.start} to ${period.end}.`);
      }
      if (day < period.start || day > period.end) {
        throw new ClientReportError(`item ${item.id ?? `item[${i}]`} cites commit ${v.shortSha} dated ${day}, outside the report period ${period.start} to ${period.end}.`);
      }
      const pr = prNumberFromSubject(v.subject) ?? land?.pr ?? null;
      if (messageFor) for (const n of issueRefs(messageFor(repo, v.sha), pr)) issues.add(n);
      commits.push({ sha: v.sha, shortSha: v.shortSha, subject: v.subject, date: day, repo, pr });
    }
    commits.sort((a, b) => a.date.localeCompare(b.date));
    const prs = [];
    for (const cm of commits) {
      if (cm.pr == null || prs.some((p) => p.n === cm.pr && p.repo === cm.repo)) continue;
      prs.push({ n: cm.pr, repo: cm.repo, url: prLinkFor(config, cm.repo, cm.pr), shortSha: cm.shortSha });
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
      issues: [...issues].sort((a, b) => a - b),
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
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

  // --- the reader's view (lib/reader.mjs). It selects and orders; it never edits an item.
  const view = applyView({ profile, themes, views, content: c });
  for (const v of views) if (view.shownIds.has(v.id)) for (const p of v.prs) citedPrs.add(`${p.repo}#${p.n}`);

  const appendix = stats.prs.map((p) => ({
    repo: p.repo,
    n: p.pr,
    url: prLinkFor(config, p.repo, p.pr),
    date: authorDay(p.dateISO),
    dateLabel: dayLabel(authorDay(p.dateISO)),
    title: readableTitle(p.subject),
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
    highlights: views.filter((v) => v.highlight && view.shownIds.has(v.id)),
    themes: view.themes,
    view: view.model,
    appendix,
    provenance: { commitsVerified: new Set(views.flatMap((v) => v.commits.map((x) => x.sha))).size },
  };
}
