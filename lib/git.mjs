// lib/git.mjs — the git verify-or-abort engine.
//
// honestweek's central honesty guarantee: every git-checkable claim is
// re-derived from the user's real commits at build time, or the build aborts.
// This module is the verification chokepoint. It shells out to the system `git`
// CLI (never process.chdir — always `-C <repoPath>`) and:
//   1. lookupCommit     — resolve one commit's derived metadata (or not-found).
//   2. commitsInWindow  — list a user's authored commits in a time window.
//   3. verifyItems      — re-derive every cited commit and collect problems.
//
// verifyItems ONLY reports a verdict; it NEVER calls process.exit. The build
// subcommand owns the `exit 2` abort. A `display`-role repo is NEVER git-read:
// any citation against it is a problem, guarded BEFORE any `git` invocation.
//
// Zero runtime dependencies: Node built-ins (node:child_process) + system git.

import { execFileSync } from 'node:child_process';

const US = '\x1f'; // unit separator — delimits fields in our git format strings.
const COMMIT_FORMAT = ['%H', '%h', '%s', '%aI', '%ae'].join(US);

/** Case-insensitive membership test of an email against an allowlist. */
export function emailInList(email, authorEmails) {
  if (typeof email !== 'string') return false;
  const lower = email.toLowerCase();
  return (Array.isArray(authorEmails) ? authorEmails : []).some(
    (e) => typeof e === 'string' && e.toLowerCase() === lower
  );
}

/** Run a git command in `repoPath`; return { ok, stdout, stderr }. Never throws
 *  for a non-zero git exit — only for an inability to spawn git at all. */
function runGit(repoPath, args) {
  try {
    const stdout = execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      code: err.status,
    };
  }
}

/** True iff `repoPath` is inside a real git repository. */
function isGitRepo(repoPath) {
  return runGit(repoPath, ['rev-parse', '--git-dir']).ok;
}

function parseCommitLine(line) {
  const [sha, shortSha, subject, dateISO, authorEmail] = line.split(US);
  return { sha, shortSha, subject, dateISO, authorEmail };
}

/**
 * lookupCommit(repoPath, sha, authorEmails?) ->
 *   resolved: { resolved: true, shortSha, subject, dateISO, authorEmail, byAuthor }
 *   not found: { resolved: false, sha, byAuthor: false }
 *
 * `byAuthor` is true iff the commit's authorEmail is in `authorEmails`
 * (case-insensitive); when `authorEmails` is omitted it is false (the caller
 * supplies identity). Throws only when `repoPath` is not a usable git repo —
 * a normal missing commit is a detectable not-found result, not a throw.
 */
export function lookupCommit(repoPath, sha, authorEmails) {
  if (!isGitRepo(repoPath)) {
    throw new Error(`git: "${repoPath}" is not a git repository (cannot verify commit ${sha}).`);
  }
  const res = runGit(repoPath, ['show', '-s', `--format=${COMMIT_FORMAT}`, `${sha}^{commit}`]);
  if (!res.ok) {
    // The repo is valid (checked above) so a non-zero exit here means the sha
    // does not resolve to a commit — a detectable not-found, not an error.
    return { resolved: false, sha, byAuthor: false };
  }
  const line = res.stdout.split('\n')[0];
  const c = parseCommitLine(line);
  return {
    resolved: true,
    shortSha: c.shortSha,
    subject: c.subject,
    dateISO: c.dateISO,
    authorEmail: c.authorEmail,
    byAuthor: authorEmails ? emailInList(c.authorEmail, authorEmails) : false,
  };
}

/**
 * commitsInWindow(repoPath, authorEmails, sinceISO, untilISO) ->
 *   [ { sha, shortSha, subject, dateISO, authorEmail }, ... ]
 *
 * Commits whose AUTHOR email is in `authorEmails` AND whose AUTHOR date is in
 * the inclusive window [sinceISO, untilISO]. Author filtering and date filtering
 * are both done here (precisely, in JS) rather than left to the caller. Returns
 * [] (not an error) when there are none, including an empty repo. Throws only
 * when `repoPath` is not a usable git repo.
 */
export function commitsInWindow(repoPath, authorEmails, sinceISO, untilISO) {
  if (!isGitRepo(repoPath)) {
    throw new Error(`git: "${repoPath}" is not a git repository.`);
  }
  const since = new Date(sinceISO).getTime();
  const until = new Date(untilISO).getTime();
  const res = runGit(repoPath, ['log', `--format=${COMMIT_FORMAT}`]);
  if (!res.ok) {
    // No commits yet (or an unborn HEAD) -> empty, not an error.
    return [];
  }
  const out = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const c = parseCommitLine(line);
    if (!emailInList(c.authorEmail, authorEmails)) continue;
    const t = new Date(c.dateISO).getTime();
    if (Number.isNaN(t) || t < since || t > until) continue;
    out.push(c);
  }
  return out;
}

/**
 * repoMetricsInWindow(repoPath, authorEmails, sinceISO, untilISO) ->
 *   { commits, activeDays } | null
 *
 * Git-DERIVED activity for the window, computed from the user's OWN authored
 * commits (the same author + date filter as commitsInWindow). `commits` is the
 * count; `activeDays` is the number of distinct calendar dates carrying at least
 * one such commit. Returns null when the repo cannot be read — honestweek never
 * fabricates a number, so an unreadable repo yields NO metric rather than a 0.
 * Numbers, like commits, are re-derived from git here; they are never authored.
 */
export function repoMetricsInWindow(repoPath, authorEmails, sinceISO, untilISO) {
  let commits;
  try {
    commits = commitsInWindow(repoPath, authorEmails, sinceISO, untilISO);
  } catch {
    return null; // unreadable repo -> no fabricated metric
  }
  const days = new Set();
  for (const c of commits) {
    const day = typeof c.dateISO === 'string' ? c.dateISO.slice(0, 10) : '';
    if (day) days.add(day);
  }
  return { commits: commits.length, activeDays: days.size };
}

// --- site-mode commit counting (exact git-flag parity) ----------------------
//
// The site integration reproduces an existing tool's per-day / per-month commit
// chart, so these helpers mirror that tool's git query EXACTLY (author-filtered,
// `--no-merges`, author-date buckets, local-time window) — a different query would
// count a different set and break byte-parity. They return raw date strings (git
// does the filtering); the derivers bucket them. Author identity stays in config.

function authorArgs(authorEmails) {
  return (Array.isArray(authorEmails) ? authorEmails : []).map((e) => `--author=${e}`);
}

/** Author-date (YYYY-MM-DD) of each authored, non-merge commit in [sinceYmd,untilYmd]
 *  (inclusive, local-time window). Returns [] for an unreadable/empty repo. */
export function commitDatesInWindow(repoPath, authorEmails, sinceYmd, untilYmd, { noMerges = true } = {}) {
  if (!isGitRepo(repoPath)) return [];
  const args = ['log', `--since=${sinceYmd} 00:00:00`, `--until=${untilYmd} 23:59:59`, ...authorArgs(authorEmails), '--date=short', '--format=%ad'];
  if (noMerges) args.push('--no-merges');
  const res = runGit(repoPath, args);
  return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
}

/** Author-month (YYYY-MM) of each authored, non-merge commit since `sinceYmd`. */
export function commitMonthsSince(repoPath, authorEmails, sinceYmd, { noMerges = true } = {}) {
  if (!isGitRepo(repoPath)) return [];
  const args = ['log', `--since=${sinceYmd} 00:00:00`, ...authorArgs(authorEmails), '--date=format:%Y-%m', '--format=%ad'];
  if (noMerges) args.push('--no-merges');
  const res = runGit(repoPath, args);
  return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
}

/** Author-date (YYYY-MM-DD) of the most recent authored, non-merge commit, or null. */
export function lastCommitDate(repoPath, authorEmails, { noMerges = true } = {}) {
  if (!isGitRepo(repoPath)) return null;
  const args = ['log', '-1', ...authorArgs(authorEmails), '--date=short', '--format=%ad'];
  if (noMerges) args.push('--no-merges');
  const res = runGit(repoPath, args);
  if (!res.ok) return null;
  const d = res.stdout.split('\n')[0]?.trim();
  return d || null;
}

// --- verifyItems ------------------------------------------------------------

/** Gather the SHAs an item cites, from any of the supported provenance fields. */
function citedShas(item) {
  const shas = [];
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) shas.push(v.trim());
  };
  add(item.primaryCommit);
  add(item.commit);
  add(item.receipt?.primaryCommit);
  if (Array.isArray(item.commits)) item.commits.forEach(add);
  if (Array.isArray(item.candidateCommits)) {
    item.candidateCommits.forEach((c) => add(typeof c === 'string' ? c : c?.sha));
  }
  return [...new Set(shas)];
}

/** The repo label an item references (digest entries carry `repo`/`label`). */
function itemRepoLabel(item) {
  return item.repo ?? item.repoLabel ?? item.label ?? null;
}

/** A short, non-sensitive identifier for an item in problem records. */
function itemRef(item, index) {
  return item.id ?? `item[${index}]`;
}

/**
 * verifyItems(items, config) -> { ok, problems, verified }
 *
 * For every item that cites one or more commits, re-derive each cited commit
 * against the item's repo and collect a `problems` array. A problem is recorded
 * when:
 *   (a) the cited commit does not resolve;
 *   (b) the commit resolves but its authorEmail is not in identity.authorEmails;
 *   (c) the item cites a commit in a repo whose role is "display" (NEVER git-read);
 *   (d) the item cites a repo not present in config.repos.
 *
 * Returns { ok, problems, verified } with ok === (problems.length === 0).
 * `verified` is an array of the freshly derived metadata for each resolved,
 * authored commit: { itemRef, repoLabel, sha, shortSha, subject, dateISO,
 * authorEmail }. NEVER calls process.exit — the build owns the abort.
 */
export function verifyItems(items, config) {
  const problems = [];
  const verified = [];
  const authorEmails = config?.identity?.authorEmails ?? [];
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const repoByLabel = new Map(repos.map((r) => [r.label, r]));

  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const shas = citedShas(item);
    if (shas.length === 0) return; // nothing to verify (e.g. a generic private line)

    const ref = itemRef(item, index);
    const label = itemRepoLabel(item);
    const repo = label != null ? repoByLabel.get(label) : undefined;

    // (d) unknown repo
    if (!repo) {
      problems.push({
        item: ref,
        repo: label,
        sha: shas[0],
        reason: `item cites commit(s) but its repo ${JSON.stringify(label)} is not in config.repos.`,
      });
      return;
    }

    // (c) display-role repo — guarded BEFORE any git invocation.
    if (repo.role === 'display') {
      problems.push({
        item: ref,
        repo: label,
        sha: shas[0],
        reason: `display-role repo ${JSON.stringify(label)} is summarized generically and must never be git-read or cite a commit.`,
      });
      return;
    }

    const repoPath = repo.resolvedPath ?? repo.path;
    for (const sha of shas) {
      let result;
      try {
        result = lookupCommit(repoPath, sha, authorEmails);
      } catch (err) {
        problems.push({ item: ref, repo: label, sha, reason: err.message });
        continue;
      }
      if (!result.resolved) {
        problems.push({
          item: ref,
          repo: label,
          sha,
          reason: `commit ${sha} does not resolve in repo ${JSON.stringify(label)} (check repos[].path).`,
        });
        continue;
      }
      if (!result.byAuthor) {
        problems.push({
          item: ref,
          repo: label,
          sha,
          reason: `commit ${sha} was not authored by the configured identity (check identity.authorEmails).`,
        });
        continue;
      }
      verified.push({
        item: ref,
        repoLabel: label,
        sha,
        shortSha: result.shortSha,
        subject: result.subject,
        dateISO: result.dateISO,
        authorEmail: result.authorEmail,
      });
    }
  });

  return { ok: problems.length === 0, problems, verified };
}
