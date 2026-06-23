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
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import { createRedactor } from './redact.mjs';
import { resolveWeek, localDateInTimezone, WeekResolutionError } from './resolve-week.mjs';
import { commitsInWindow } from './git.mjs';
import { adaptSessions } from './claude-adapter.mjs';

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

/** Append DRAFT_FILE to .gitignore idempotently; warn loudly if it is tracked. */
function ensureDraftGitignored(cwd, io) {
  const giPath = join(cwd, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  if (!existing.split(/\r?\n/).some((l) => l.trim() === DRAFT_FILE)) {
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(giPath, `${prefix}${DRAFT_FILE}\n`);
  }
  // Warn if the draft is already tracked in git (a privacy hazard).
  try {
    const tracked = execFileSync('git', ['-C', cwd, 'ls-files', DRAFT_FILE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (tracked) io.err(`discover: WARNING — ${DRAFT_FILE} is tracked in git. It must never be committed.\n`);
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
      const windowCommits = gitWindow(repo.resolvedPath ?? repo.path, config.identity.authorEmails, sinceISO, untilISO);
      entry.candidateCommits = mergeCandidateCommits(entry.candidateCommits, windowCommits);
    }
    candidateTotal += entry.candidateCommits.length;
  }

  const digest = {
    _README: DRAFT_README,
    week: { start: sinceISO.slice(0, 10), end: untilISO.slice(0, 10) },
    sessions,
  };

  // Total redaction before disk — the written draft is the redacted form.
  const redacted = redactor.deepRedact(digest);
  writeFileSync(join(cwd, DRAFT_FILE), `${JSON.stringify(redacted, null, 2)}\n`);
  ensureDraftGitignored(cwd, io);

  const publicCount = sessions.length - privateCount;
  io.out(
    `discover: ${sessions.length} interactive session(s) for ${digest.week.start}..${digest.week.end} ` +
      `(${publicCount} public, ${privateCount} private-redacted); ` +
      `${candidateTotal} candidate commit(s); ${redactor.count} redaction(s).\n` +
      `Wrote ${DRAFT_FILE} (gitignored). Distil it into honestweek.items.json next.\n`
  );
  return 0;
}

export default function run(argv) {
  return runDiscover({ argv });
}
