// lib/git.mjs — the git verify-or-abort engine.
//
// honestweek's central honesty guarantee: every git-checkable claim is
// re-derived from the user's real commits at build time, or the build aborts.
// This module is the verification chokepoint. It shells out to the system `git`
// CLI (never process.chdir — always `-C <repoPath>`) and:
//   1. lookupCommit      — resolve one commit's derived metadata (or not-found).
//   2. commitsInWindow   — list a user's authored commits in a time window.
//   3. defaultBranchRefs — resolve the repo's default branch from LOCAL refs.
//   4. verifyItems       — re-derive every cited commit and collect problems,
//                          marking each verified commit `landed` (reachable from
//                          the default branch) or not — offline, local refs only.
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

// --- the one way honestweek runs git ----------------------------------------
//
// Every git call in lib/ and bin/ goes through gitExec (or runGit, its non-throwing form).
// A repository's own .git/config is not honestweek's to trust: a folder next to the one
// `init` runs in, or a repository in the config, can name programs git would start. So
// each call turns off, on its command line (which wins over every config file):
//   protocol.allow=never      no transport at all, so nothing is ever fetched, and a
//                             remote URL or core.sshCommand never runs a program
//   protocol.<name>.allow=never  the same for each built-in transport by name, since a
//                             repository's own protocol.ssh.allow=always (say) beats
//                             protocol.allow; on a git older than 2.44, which doesn't know
//                             GIT_NO_LAZY_FETCH, this is what stops a partial clone's fetch
//   log.showSignature=false   `log` and `show` never start gpg.program to check a signature
//   core.fsmonitor=false      no file-system monitor program
//   core.hooksPath=           no hooks folder
// and its environment drops every GIT_* variable the parent had (GIT_DIR, GIT_WORK_TREE,
// GIT_CONFIG_COUNT and GIT_CONFIG_KEY_n, GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH and the rest can
// point git at another repository, add settings, or swap in another git) except the three
// that only say where the person's own global and system config files are (KEPT_GIT_ENV), so
// the identity init reads is still theirs; the settings above win over those files too. Then
// it sets GIT_NO_LAZY_FETCH=1 (a partial clone never fetches a missing object) and
// GIT_TERMINAL_PROMPT=0 (never wait on a prompt). A call that takes longer than
// GIT_TIMEOUT_MS is stopped, and its output can be as large as GIT_MAX_BUFFER.

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const TRANSPORTS = ['ext', 'file', 'git', 'ssh', 'http', 'https', 'ftp', 'ftps'];
export const GIT_HARDENING = Object.freeze(['--no-pager', '-c', 'protocol.allow=never', ...TRANSPORTS.flatMap((t) => ['-c', `protocol.${t}.allow=never`]), '-c', 'log.showSignature=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=']);

const KEPT_GIT_ENV = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);

/** The environment git runs with: the parent's, minus every GIT_* variable but KEPT_GIT_ENV,
 *  plus the two honestweek sets, plus `extra` (the demo's fixed commit dates, for example). */
export function gitEnv(extra = {}, env = process.env) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/i.test(k) || KEPT_GIT_ENV.has(k.toUpperCase())));
  return { ...out, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
}

/** Run git, hardened as above; return its stdout, or throw as execFileSync does (a non-zero
 *  exit, a timeout, output past maxBuffer, or no git to start). `repo` adds `-C <repo>`. */
export function gitExec(args, { repo = null, cwd, env = {}, maxBuffer = GIT_MAX_BUFFER, timeout = GIT_TIMEOUT_MS, stdio = ['ignore', 'pipe', 'pipe'], encoding = 'utf8' } = {}) {
  return execFileSync('git', [...GIT_HARDENING, ...(repo != null ? ['-C', repo] : []), ...args], {
    cwd,
    encoding,
    stdio,
    env: gitEnv(env),
    maxBuffer,
    timeout,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
}

/** Run a git command in `repoPath`; return { ok, stdout, stderr, code, unreadable }. Never
 *  throws. `unreadable` is true when git didn't answer at all: it couldn't start, was
 *  stopped for time, or printed more than maxBuffer. That's never the same as an empty
 *  answer, so callers report it as unreadable rather than as no commits. */
export function runGit(repoPath, args, opts = {}) {
  try {
    return { ok: true, stdout: gitExec(args, { ...opts, repo: repoPath }), stderr: '', unreadable: false };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      code: err.status,
      unreadable: !Number.isInteger(err.status) || err.code === 'ENOBUFS' || err.code === 'ETIMEDOUT' || err.signal != null,
    };
  }
}

/** A commit id honestweek passes to git: 4 to 64 hex digits, nothing else. A value from a
 *  log or a summary item that isn't one (an option such as `--output=...`, a ref name, a
 *  range) is never handed to git; it reads as a commit that wasn't found. */
export const COMMIT_ID = /^[0-9a-f]{4,64}$/i;
export const isCommitId = (v) => typeof v === 'string' && COMMIT_ID.test(v);

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
 *   resolved: { resolved: true, sha, shortSha, subject, dateISO, authorEmail, byAuthor }
 *             (`sha` is the full commit id the input resolved to)
 *   not found: { resolved: false, sha, byAuthor: false }
 *
 * `byAuthor` is true iff the commit's authorEmail is in `authorEmails`
 * (case-insensitive); when `authorEmails` is omitted it is false (the caller
 * supplies identity). Throws only when `repoPath` is not a usable git repo —
 * a normal missing commit is a detectable not-found result, not a throw.
 */
export function lookupCommit(repoPath, sha, authorEmails) {
  if (!isCommitId(sha)) return { resolved: false, sha, byAuthor: false };
  if (!isGitRepo(repoPath)) {
    throw new Error(`git: "${repoPath}" is not a git repository (cannot verify commit ${sha}).`);
  }
  const res = runGit(repoPath, ['show', '-s', `--format=${COMMIT_FORMAT}`, '--end-of-options', `${sha}^{commit}`]);
  if (res.unreadable) throw new Error(`git: could not read "${repoPath}" (cannot verify commit ${sha}).`);
  if (!res.ok) {
    // The repo is valid (checked above) so a non-zero exit here means the sha
    // does not resolve to a commit — a detectable not-found, not an error.
    return { resolved: false, sha, byAuthor: false };
  }
  const line = res.stdout.split('\n')[0];
  const c = parseCommitLine(line);
  return {
    resolved: true,
    sha: c.sha,
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
 * [] (not an error) when there are none, including an empty repo. Throws when
 * `repoPath` is not a usable git repo, or when git couldn't list its history (it
 * was stopped for time, its output was too large, or it failed on a repo that has
 * commits): "couldn't read" is never reported as "no commits". `opts` reaches git
 * (maxBuffer, timeout).
 */
export function commitsInWindow(repoPath, authorEmails, sinceISO, untilISO, opts = {}) {
  if (!isGitRepo(repoPath)) {
    throw new Error(`git: "${repoPath}" is not a git repository.`);
  }
  const since = new Date(sinceISO).getTime();
  const until = new Date(untilISO).getTime();
  const res = runGit(repoPath, ['log', `--format=${COMMIT_FORMAT}`], opts);
  if (res.unreadable) throw new Error(`git: could not read the history of "${repoPath}".`);
  if (!res.ok) {
    // No commits yet (an unborn HEAD) -> empty, not an error. Any other failure is unreadable.
    if (!runGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) return [];
    throw new Error(`git: could not read the history of "${repoPath}".`);
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
export function repoMetricsInWindow(repoPath, authorEmails, sinceISO, untilISO, opts = {}) {
  let commits;
  try {
    commits = commitsInWindow(repoPath, authorEmails, sinceISO, untilISO, opts);
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

/** A commit's full message (subject and body), or null when it can't be read. Used to
 *  find the issues a commit names, so a reader's "your requests" section is picked by
 *  git rather than by hand. */
export function commitMessage(repoPath, sha) {
  if (!isCommitId(sha)) return null;
  const res = runGit(repoPath, ['show', '-s', '--format=%B', '--end-of-options', `${sha}^{commit}`]);
  return res.ok ? res.stdout : null;
}

/** The pull-request number a commit subject names, or null. Reads the two shapes
 *  GitHub writes on the default branch: a squash merge ("Title (#123)") and a merge
 *  commit ("Merge pull request #123 from ..."). Derived from the verified subject,
 *  never authored. */
export function prNumberFromSubject(subject) {
  const s = String(subject ?? '');
  const squash = s.match(/\(#(\d+)\)\s*$/);
  if (squash) return Number(squash[1]);
  const merge = s.match(/^Merge pull request #(\d+)\b/);
  return merge ? Number(merge[1]) : null;
}

/**
 * landedCommitsInWindow(repoPath, authorEmails, sinceISO, untilISO) ->
 *   { commits: [{ sha, shortSha, subject, dateISO, landedISO, authorEmail, isMerge, pr }], refs } | null
 *
 * The user's OWN commits (author email in the allowlist) that reached the repo's
 * default branch (reachable from defaultBranchRefs) and LANDED inside the inclusive
 * window. "Landed" is when the commit arrived on the default branch: the committer
 * date of the first-parent commit that carried it there (the commit itself for a
 * squash merge or a direct push, the merge commit for a pull request merged with
 * one). Filtering by author date instead would drop a pull request written before
 * the window but merged inside it, and count one written inside but merged after.
 * `pr` is the commit's own subject's PR number (a squash merge) or the PR whose
 * merge commit brought it in. A merge commit is flagged `isMerge`: merging someone
 * else's pull request is not authoring it, so callers skip merges.
 * Returns null when the repo cannot be read (git stopped for time or printed more than
 * maxBuffer included) or has no determinable default branch: honestweek never turns
 * "could not tell" into a count of 0. `opts` reaches git (maxBuffer, timeout).
 */
export function landedCommitsInWindow(repoPath, authorEmails, sinceISO, untilISO, opts = {}) {
  if (!isGitRepo(repoPath)) return null;
  const refs = defaultBranchRefs(repoPath);
  if (refs.length === 0) return null;
  const since = new Date(sinceISO).getTime();
  const until = new Date(untilISO).getTime();
  const res = runGit(repoPath, ['log', `--format=${COMMIT_FORMAT}${US}%P`, '--end-of-options', ...refs], opts);
  if (!res.ok) return null;
  // Walk each default ref's first-parent line: every reachable commit either sits on
  // it or was brought in by one of its merges (merge^1..merge^2, nested merges
  // included). That gives each commit its landing time and, for a merged pull
  // request, its PR number.
  const landing = new Map(); // sha -> { landedISO, pr }
  for (const ref of refs) {
    const line = runGit(repoPath, ['log', '--first-parent', `--format=%H${US}%cI${US}%P${US}%s`, '--end-of-options', ref], opts);
    if (line.unreadable) return null;
    if (!line.ok) continue;
    for (const row of line.stdout.split('\n')) {
      const [sha, landedISO, parentList, subject] = row.split(US);
      if (!sha) continue;
      if (!landing.has(sha)) landing.set(sha, { landedISO, pr: null });
      const parents = String(parentList ?? '').trim().split(/\s+/).filter(Boolean);
      if (parents.length < 2) continue;
      const brought = runGit(repoPath, ['rev-list', '--end-of-options', `${sha}^1..${sha}^2`], opts);
      if (brought.unreadable) return null;
      if (!brought.ok) continue;
      const pr = prNumberFromSubject(subject);
      for (const b of brought.stdout.split('\n').filter(Boolean)) if (!landing.has(b)) landing.set(b, { landedISO, pr });
    }
  }
  const seen = new Set();
  const commits = [];
  for (const row of res.stdout.split('\n')) {
    if (!row) continue;
    const parts = row.split(US);
    const c = parseCommitLine(parts.slice(0, 5).join(US));
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    if (!emailInList(c.authorEmail, authorEmails)) continue;
    const land = landing.get(c.sha);
    const landedISO = land?.landedISO || c.dateISO;
    const t = new Date(landedISO).getTime();
    if (Number.isNaN(t) || t < since || t > until) continue;
    const parents = String(parts[5] ?? '').trim().split(/\s+/).filter(Boolean);
    commits.push({ ...c, landedISO, isMerge: parents.length > 1, pr: prNumberFromSubject(c.subject) ?? land?.pr ?? null });
  }
  return { commits, refs };
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
 *  (inclusive, local-time window). Returns [] for a folder that isn't a repo or has no
 *  such commits; throws when git couldn't answer (stopped for time, or too much output). */
export function commitDatesInWindow(repoPath, authorEmails, sinceYmd, untilYmd, { noMerges = true } = {}) {
  if (!isGitRepo(repoPath)) return [];
  const args = ['log', `--since=${sinceYmd} 00:00:00`, `--until=${untilYmd} 23:59:59`, ...authorArgs(authorEmails), '--date=short', '--format=%ad'];
  if (noMerges) args.push('--no-merges');
  const res = runGit(repoPath, args);
  if (res.unreadable) throw new Error(`git: could not read the history of "${repoPath}".`);
  return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
}

/** Author-month (YYYY-MM) of each authored, non-merge commit since `sinceYmd`. Throws, as
 *  commitDatesInWindow does, when git couldn't answer. */
export function commitMonthsSince(repoPath, authorEmails, sinceYmd, { noMerges = true } = {}) {
  if (!isGitRepo(repoPath)) return [];
  const args = ['log', `--since=${sinceYmd} 00:00:00`, ...authorArgs(authorEmails), '--date=format:%Y-%m', '--format=%ad'];
  if (noMerges) args.push('--no-merges');
  const res = runGit(repoPath, args);
  if (res.unreadable) throw new Error(`git: could not read the history of "${repoPath}".`);
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

// --- default-branch reachability (the landed gate) ---------------------------

/** True iff `ref` resolves to a commit in `repoPath` (local refs only). */
function refResolves(repoPath, ref) {
  return runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
}

/**
 * defaultBranchRefs(repoPath) -> string[] of fully-qualified refs
 *
 * The repo's default ("landing") branch, resolved OFFLINE — local refs only,
 * never a fetch or any network call:
 *   1. the branch origin/HEAD points at (recorded locally at clone time);
 *   2. else the conventional `main`, then `master`;
 *   3. else, when the repo has exactly ONE local branch, that branch.
 * Each level is tried in turn and used only if at least one of its refs still
 * resolves. origin/HEAD survives a remote default-branch rename as a DANGLING
 * symbolic ref — `symbolic-ref` still reports the old, now-pruned target — so
 * accepting its name without resolving it would skip the fallbacks and strand a
 * repo whose `main` is sitting right there.
 * Returns BOTH the remote-tracking and local head refs of that branch when both
 * exist — offline, either may be ahead of the other (a merge fetched but not
 * fast-forwarded lives only on the remote-tracking ref; an unpushed local merge
 * only on the local head), and work on either has landed. Returns [] when no
 * default branch is determinable; the caller owns what that means for a claim.
 * Throws only when `repoPath` is not a usable git repo.
 */
export function defaultBranchRefs(repoPath) {
  if (!isGitRepo(repoPath)) {
    throw new Error(`git: "${repoPath}" is not a git repository.`);
  }
  const names = [];
  const sym = runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym.ok) {
    const m = sym.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) names.push(m[1]);
  }
  for (const conventional of ['main', 'master']) {
    if (!names.includes(conventional)) names.push(conventional);
  }
  for (const name of names) {
    const pair = [`refs/remotes/origin/${name}`, `refs/heads/${name}`]
      .filter((ref) => refResolves(repoPath, ref));
    if (pair.length > 0) return pair;
  }
  const heads = runGit(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
  const local = heads.ok ? heads.stdout.split('\n').filter(Boolean) : [];
  if (local.length === 1 && refResolves(repoPath, local[0])) return [local[0]];
  return [];
}

/** `owner/name` of a repo's GitHub origin remote, or null when there is none. */
export function originSlug(repoPath) {
  const res = runGit(repoPath, ['config', '--get', 'remote.origin.url']);
  if (!res.ok) return null;
  const m = res.stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : null;
}

/** The working-tree paths `git worktree list --porcelain` names for a repository (the
 *  primary one first), as git prints them. [] when git can't read the repository. */
export function worktreeList(repoPath) {
  const res = runGit(repoPath, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  return res.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

/** True iff `sha` is an ancestor of ANY of `refs` (git merge-base --is-ancestor). */
export function commitReachableFrom(repoPath, sha, refs) {
  if (!isCommitId(sha)) return false;
  return (Array.isArray(refs) ? refs : []).some(
    (ref) => runGit(repoPath, ['merge-base', '--is-ancestor', '--end-of-options', sha, ref]).ok
  );
}

// --- verifyItems ------------------------------------------------------------

/** Gather the SHAs an item cites, from any of the supported provenance fields. */
export function citedShas(item) {
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
export function itemRepoLabel(item) {
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
 * authorEmail, landed }. `landed` is the offline default-branch reachability
 * verdict: true/false when the repo's default branch is determinable from local
 * refs (defaultBranchRefs), null when it is not — a landed claim on a null is
 * unverifiable, and the caller owns that abort. NEVER calls process.exit — the
 * build owns the abort.
 */
export function verifyItems(items, config) {
  const problems = [];
  const verified = [];
  const authorEmails = config?.identity?.authorEmails ?? [];
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const repoByLabel = new Map(repos.map((r) => [r.label, r]));
  const defaultRefsByPath = new Map(); // repoPath -> defaultBranchRefs(repoPath), resolved once

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
      // Landed verdict (offline, local refs). The repo is known-usable here —
      // lookupCommit above succeeded — so defaultBranchRefs cannot throw.
      let defaultRefs = defaultRefsByPath.get(repoPath);
      if (defaultRefs === undefined) {
        defaultRefs = defaultBranchRefs(repoPath);
        defaultRefsByPath.set(repoPath, defaultRefs);
      }
      verified.push({
        item: ref,
        repoLabel: label,
        sha,
        shortSha: result.shortSha,
        subject: result.subject,
        dateISO: result.dateISO,
        authorEmail: result.authorEmail,
        landed: defaultRefs.length > 0 ? commitReachableFrom(repoPath, sha, defaultRefs) : null,
      });
    }
  });

  return { ok: problems.length === 0, problems, verified };
}
