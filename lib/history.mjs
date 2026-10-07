// lib/history.mjs — the `history` subcommand: the raw material for a client report.
//
// A client report covers a period (a sprint, a month, a contract to date), and its
// source is what reached the default branch in that period, not a week of session
// logs. history lists every pull request (and every commit that landed without one)
// you authored on each featured/reference repo's default branch between --from and
// --to, and writes it to the GITIGNORED sidecar honestweek.history.json. You (or the
// skill) group those into items for honestweek.items.json, citing their commits, and
// build verifies every one again.
//
// PRIVACY: subjects go only to the gitignored sidecar, after redaction; stdout gets
// counts. 'display'-role repos are never git-read. Deterministic: no model call.

import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import { commandConfig } from './config-lookup.mjs';
import { landedCommitsInWindow } from './git.mjs';
import { createRedactor } from './redact.mjs';
import { ensureGitignore } from './init.mjs';
import { atomicWriteText } from './atomic-json.mjs';

export const HISTORY_FILE = 'honestweek.history.json';
export const HISTORY_GITIGNORE = [HISTORY_FILE];

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

function isYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * collectHistory({ config, from, to }) -> { period, repos: [...], unreadable: [...] }
 * Per repo: `prs` (one entry per pull request, its earliest commit in the period)
 * and `direct` (commits that landed without a pull request), oldest first.
 */
export function collectHistory({ config, from, to }) {
  const repos = [];
  const unreadable = [];
  for (const repo of config.repos ?? []) {
    if (repo.role === 'display') continue;
    const got = landedCommitsInWindow(repo.resolvedPath ?? repo.path, config.identity.authorEmails, `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`);
    if (!got) {
      unreadable.push(repo.label);
      continue;
    }
    const byPr = new Map();
    const direct = [];
    for (const c of [...got.commits].reverse()) {
      if (c.isMerge) continue; // merging a pull request is not authoring it
      const entry = { sha: c.sha, shortSha: c.shortSha, date: String(c.landedISO).slice(0, 10), subject: c.subject };
      if (c.pr == null) {
        direct.push(entry);
        continue;
      }
      const prev = byPr.get(c.pr);
      if (!prev) byPr.set(c.pr, { pr: c.pr, ...entry, commits: [c.sha] });
      else prev.commits.push(c.sha);
    }
    repos.push({ label: repo.label, role: repo.role, prs: [...byPr.values()], direct });
  }
  return { period: { start: from, end: to }, repos, unreadable };
}

export async function runHistory({ cwd = process.cwd(), argv = [], io = defaultIo() } = {}) {
  const from = flag(argv, 'from');
  const to = flag(argv, 'to');
  if (!isYmd(from) || !isYmd(to) || from > to) {
    io.err('history: needs --from YYYY-MM-DD and --to YYYY-MM-DD, with --from on or before --to.\n');
    return io.exit(1) ?? 1;
  }
  // The config can sit elsewhere (--config, HONESTWEEK_CONFIG, the user-level file); history's
  // files then sit beside it, never in an unrelated folder this ran in.
  const opened = commandConfig({ command: 'history', cwd, argv, err: io.err });
  if (opened.error) {
    io.err(`history: ${opened.error}\n`);
    return io.exit(1) ?? 1;
  }
  ({ cwd, argv } = opened);
  let config;
  try {
    config = loadConfig(opened.found.path);
  } catch (err) {
    io.err(`history: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }
  const history = collectHistory({ config, from, to });
  const redactor = createRedactor(config);
  const safe = redactor.deepRedact(history);
  ensureGitignore(cwd, HISTORY_FILE);
  atomicWriteText(join(cwd, HISTORY_FILE), `${JSON.stringify(safe, null, 2)}\n`);
  const prs = history.repos.reduce((n, r) => n + r.prs.length, 0);
  const direct = history.repos.reduce((n, r) => n + r.direct.length, 0);
  io.out(
    `history: ${prs} pull request(s) and ${direct} direct commit(s) from ${history.repos.length} repo(s), ${from} to ${to}, written to ${HISTORY_FILE} (gitignored).\n` +
      (history.unreadable.length ? `history: WARNING: could not read ${history.unreadable.length} repo(s) (no repo or no default branch); they are missing from the list.\n` : '')
  );
  return 0;
}

export default function run(argv) {
  return runHistory({ argv });
}
