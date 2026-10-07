// lib/discover.mjs — the `discover` subcommand: assemble the weekly digest.
//
// discover is the only stage that touches raw session transcripts and the
// user's repos. It is DETERMINISTIC — there is NO LLM/model call here.
// Distillation (turning the digest into narrative items) is a separate stage.
// discover: resolves the week, invokes the Claude adapter to enumerate that
// week's interactive sessions, attaches candidate commits per session via git
// (featured/reference repos only — display repos are NEVER git-read), redacts
// the whole structure, writes the gitignored honestweek.draft.json, and prints
// a summary.
//
// discover only PROPOSES candidate commits; it makes no honesty/authorship
// claim. The abort-on-unresolved/non-authored guarantee belongs to `build`.
//
// Zero runtime dependencies: Node built-ins + system git only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import { createRedactor } from './redact.mjs';
import { resolveWeek, localDateInTimezone, WeekResolutionError } from './resolve-week.mjs';
import { commitsInWindow, gitExec } from './git.mjs';
import { checkoutOf, reachesDisplay } from './repo-identity.mjs';
import { adaptSessions } from './claude-adapter.mjs';
import { discoverHandoffs } from './handoffs.mjs';

const DRAFT_FILE = 'honestweek.draft.json';

const DRAFT_README =
  'This file is gitignored and is an intermediate working artifact — it is never published. ' +
  'Every string here has already passed through the redactor. Any distillation of this digest ' +
  'must GENERALIZE, never echo specifics: no raw basenames, no quoting redacted prose verbatim, ' +
  'and never re-introduce anything the redactor stripped.';

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
}

function parseWeekArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--week') return argv[i + 1];
    if (argv[i].startsWith('--week=')) return argv[i].slice('--week='.length);
  }
  return undefined;
}

/** What discover says when it can't ask git whether the draft is committed (issue 161). */
export const CANT_CHECK_DRAFT = `discover: check that ${DRAFT_FILE}, your private draft, was never committed to git. Listing it in .gitignore doesn't remove it from git if it was committed before, and honestweek can't check for you here because of your display-only setting. Run git ls-files ${DRAFT_FILE}. If it prints the file name, run git rm --cached ${DRAFT_FILE}.\n`;

/** Append DRAFT_FILE to .gitignore idempotently; warn loudly if it is tracked.
 *  When git running in `cwd` would reach a display-only folder, git is never asked (AGENTS.md
 *  invariant 4), and it says how to check by hand instead. Outside any checkout (`inRepo`
 *  false) there's nothing to check, so it asks git nothing and says nothing. */
export function ensureDraftGitignored(cwd, io, { isDisplay = false, inRepo = true } = {}) {
  const giPath = join(cwd, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  if (!existing.split(/\r?\n/).some((l) => l.trim() === DRAFT_FILE)) {
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(giPath, `${prefix}${DRAFT_FILE}\n`);
  }
  // Warn if the draft is already tracked in git (a privacy hazard).
  if (!inRepo) return;
  if (isDisplay) {
    io.err(CANT_CHECK_DRAFT);
    return;
  }
  try {
    const tracked = gitExec(['ls-files', '--', DRAFT_FILE], { repo: cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (tracked) io.err(`discover: WARNING: ${DRAFT_FILE} is tracked in git. It must never be committed.\n`);
  } catch {
    /* not a git repo / git unavailable — nothing to warn about */
  }
}

function mergeCandidateCommits(existing, windowCommits) {
  // The adapter nominates SHAs from the transcript (subject intentionally empty,
  // to avoid leaking tool-result body text). git's window query supplies the
  // real, redactable subject for the user's OWN commits — so it OVERRIDES.
  const map = new Map();
  for (const c of existing ?? []) map.set(c.sha, { sha: c.sha, date: c.date ?? null, subject: c.subject ?? '' });
  for (const c of windowCommits) map.set(c.sha, { sha: c.sha, date: c.dateISO ?? c.date ?? null, subject: c.subject ?? '' });
  return [...map.values()].sort((a, b) => a.sha.localeCompare(b.sha));
}

/**
 * runDiscover({ cwd, argv, now, io, adapter, gitWindow }) -> exit code.
 * `adapter` and `gitWindow` are injectable so the orchestration is mockable in
 * tests (and to prove discover makes no model call of its own).
 */
export async function runDiscover({
  cwd = process.cwd(),
  argv = [],
  now = new Date(),
  io = defaultIo(),
  adapter = adaptSessions,
  gitWindow = commitsInWindow,
} = {}) {
  let config;
  try {
    config = loadConfig(join(cwd, 'honestweek.config.json'));
  } catch (err) {
    io.err(`discover: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }

  const weekArg = parseWeekArg(argv);
  let weekStart;
  let weekEnd;
  try {
    const today = localDateInTimezone(now, config.week?.timezone || 'UTC');
    ({ weekStart, weekEnd } = resolveWeek({ today, weekArg }));
  } catch (err) {
    const msg = err instanceof WeekResolutionError ? err.message : String(err?.message ?? err);
    io.err(`discover: ${msg}\n`);
    return io.exit(1) ?? 1;
  }

  const redactor = createRedactor(config);
  const reposByLabel = new Map((config.repos ?? []).map((r) => [r.label, r]));

  // The adapter owns transcript reading + extraction; discover consumes its output.
  const sessions = await adapter({ config, weekStart, weekEnd, redactor });

  const sinceISO = weekStart.toISOString();
  const untilISO = weekEnd.toISOString();
  let candidateTotal = 0;
  let privateCount = 0;

  for (const entry of sessions) {
    if (entry.isPrivate) {
      privateCount += 1;
      entry.candidateCommits = []; // display/private repos are NEVER git-read
      continue;
    }
    const repo = reposByLabel.get(entry.repo);
    // Only featured/reference repos are git-read; display never reaches here
    // (those sessions are isPrivate), but guard anyway.
    if (repo && repo.role !== 'display') {
      let windowCommits;
      try {
        windowCommits = gitWindow(repo.resolvedPath ?? repo.path, config.identity.authorEmails, sinceISO, untilISO);
      } catch (err) {
        // Couldn't read it: say so and add nothing, rather than read it as a week with no commits.
        io.err(`discover: ${err.message} No commits from it were added.\n`);
        windowCommits = [];
      }
      entry.candidateCommits = mergeCandidateCommits(entry.candidateCommits, windowCommits);
    }
    candidateTotal += entry.candidateCommits.length;
  }

  // The other half of the record: session-end handoffs (.claude/handoffs/*.md)
  // for featured/reference repos — tagged claims, reversals, cited SHAs. Display
  // repos are never read; build still verifies any SHA the model goes on to cite.
  const handoffs = discoverHandoffs({ config, weekStart, weekEnd, redactor });

  const digest = {
    _README: DRAFT_README,
    week: { start: sinceISO.slice(0, 10), end: untilISO.slice(0, 10) },
    sessions,
    handoffs,
  };

  // Total redaction before disk — the written draft is the redacted form.
  const redacted = redactor.deepRedact(digest);
  // A new draft is readable only by its owner on POSIX; a rewrite keeps the mode it has.
  writeFileSync(join(cwd, DRAFT_FILE), `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 });
  // Git isn't asked where it would reach a display-only folder, the same test Settings'
  // configTrackState makes, nor outside any checkout, where there's nothing to track.
  const displayPaths = (config.repos ?? []).filter((r) => r.role === 'display').map((r) => r.resolvedPath ?? r.path);
  ensureDraftGitignored(cwd, io, { isDisplay: reachesDisplay(displayPaths)(cwd), inRepo: checkoutOf(cwd) !== null });

  const publicCount = sessions.length - privateCount;
  io.out(
    `discover: ${sessions.length} interactive session(s) for ${digest.week.start}..${digest.week.end} ` +
      `(${publicCount} public, ${privateCount} private-redacted); ` +
      `${handoffs.length} handoff(s); ${candidateTotal} candidate commit(s); ${redactor.count} redaction(s).\n` +
      `Wrote ${DRAFT_FILE} (gitignored). Distil it into honestweek.items.json next.\n`
  );
  return 0;
}

export default function run(argv) {
  return runDiscover({ argv });
}
