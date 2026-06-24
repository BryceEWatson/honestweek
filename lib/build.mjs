// lib/build.mjs — the `build` subcommand: verify-or-abort, redact, emit.
//
// build is where "honest by construction" is enforced. It reads the distilled
// items, re-derives EVERY git-checkable claim against the user's real commits,
// and ABORTS (exit 2) writing nothing if any cited commit is unresolved or not
// authored by the configured identity. Only after the whole verify pass passes
// does it assemble, redact, and hand the model to the configured emitter. It
// composes already-specified modules (git verify, redactor, badges, emitter)
// rather than reimplementing them.
//
// Zero runtime dependencies: Node built-ins + system git only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import { verifyItems, repoMetricsInWindow } from './git.mjs';
import { createRedactor } from './redact.mjs';
import { statusForTag, STATUSES } from './badges.mjs';
import { resolveWeek, localDateInTimezone } from './resolve-week.mjs';
import { emit } from './emit/index.mjs';

const CONFIG_FILE = 'honestweek.config.json';
const ITEMS_FILE = 'honestweek.items.json';

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
}

/** The primary cited commit SHA for an item, from any supported provenance. */
function pickPrimarySha(item) {
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

/** Build the receipt for a model item — commit data is ALWAYS the git-derived
 *  value, never what the items file carried. */
function resolveReceipt(item, verifiedIndex) {
  const sha = pickPrimarySha(item);
  if (sha && verifiedIndex.has(sha)) {
    const v = verifiedIndex.get(sha);
    return { kind: 'commit', sha, shortSha: v.shortSha, dateISO: v.dateISO };
  }
  const r = item.receipt;
  if (r && typeof r === 'object' && (r.sessionId || r.ref || r.turn)) {
    return { kind: 'session', sessionId: r.sessionId, ref: r.ref ?? r.sessionId ?? item.id };
  }
  if (typeof r === 'string' && r.trim()) return r;
  const sid = item.sessionId ?? item.session ?? item.id;
  if (sid) return { kind: 'session', sessionId: sid, ref: sid };
  return undefined; // the emitter will reject a receipt-less item
}

/**
 * assembleReportModel(items, config, verifiedIndex, week) -> reportModel
 * Groups items by repo (featured groups first, then reference, then others);
 * repo-less items go in a top-level list. Pure + testable.
 */
export function assembleReportModel(items, config, verifiedIndex, week, metricsByLabel = new Map()) {
  const roleByLabel = new Map((config.repos ?? []).map((r) => [r.label, r.role]));
  const groupsByLabel = new Map();
  const looseItems = [];

  for (const item of items) {
    const modelItem = {
      status: statusFor(item),
      text: item.text ?? item.summary ?? '',
      repo: item.repo ?? null,
      receipt: resolveReceipt(item, verifiedIndex),
    };
    const label = item.repo;
    if (label && roleByLabel.has(label)) {
      if (!groupsByLabel.has(label)) groupsByLabel.set(label, { label, role: roleByLabel.get(label), items: [] });
      groupsByLabel.get(label).items.push(modelItem);
    } else {
      looseItems.push(modelItem);
    }
  }

  const roleRank = { featured: 0, reference: 1, display: 2 };
  const groups = [...groupsByLabel.values()].sort(
    (a, b) => (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9) || a.label.localeCompare(b.label)
  );

  // Attach git-derived metrics to each non-display group. `entries` is always the
  // render-count; commits/activeDays come from metricsByLabel when the repo was
  // readable. DISPLAY repos are NEVER git-read, so they carry no metrics at all.
  for (const g of groups) {
    if (g.role === 'display') continue;
    const git = metricsByLabel.get(g.label) || null;
    g.metrics = { entries: g.items.length, ...(git || {}) };
  }

  return { week, groups, items: looseItems };
}

function normalizeWeek(week, now, config) {
  if (week && (week.start || week.weekStart)) {
    const norm = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    return { start: norm(week.start ?? week.weekStart), end: norm(week.end ?? week.weekEnd) };
  }
  // Fall back to the last completed week, tz-correct against the real now.
  const tz = config.week?.timezone || 'UTC';
  const today = localDateInTimezone(now, tz);
  const { weekStart, weekEnd } = resolveWeek({ today });
  return { start: weekStart.toISOString().slice(0, 10), end: weekEnd.toISOString().slice(0, 10) };
}

/**
 * runBuild({ cwd, argv, now, io }) -> exit code (0 success).
 * On a verification failure it calls io.exit(2) after a clear message and writes
 * nothing. io.exit defaults to process.exit; tests inject a throwing exit.
 */
export async function runBuild({ cwd = process.cwd(), argv = [], now = new Date(), io = defaultIo() } = {}) {
  const configPath = join(cwd, CONFIG_FILE);
  const itemsPath = join(cwd, ITEMS_FILE);

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    io.err(`build: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }

  if (!existsSync(itemsPath)) {
    io.err(`build: ${ITEMS_FILE} not found in ${cwd}. Run discover and distil first.\n`);
    return io.exit(1) ?? 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(itemsPath, 'utf8'));
  } catch (err) {
    io.err(`build: ${ITEMS_FILE} is not valid JSON (${err.message}).\n`);
    return io.exit(1) ?? 1;
  }

  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  const week = normalizeWeek(Array.isArray(parsed) ? null : parsed.week, now, config);

  // --- verify-or-abort (over ALL cited commits, before any assembly/emit) ---
  const { ok, problems, verified } = verifyItems(items, config);
  if (!ok) {
    const p = problems[0];
    io.err(
      `build: ABORTED — item ${p.item} (repo ${JSON.stringify(p.repo)}) cites commit ${p.sha}: ${p.reason}\n` +
        `No output was written.\n`
    );
    return io.exit(2) ?? 2;
  }

  // --- git-derived per-project metrics (numbers re-derived, never authored) ---
  // Featured/reference repos only; DISPLAY repos are never git-read. An unreadable
  // repo yields no metric (repoMetricsInWindow returns null) — never a fake 0.
  const sinceISO = `${week.start}T00:00:00.000Z`;
  const untilISO = `${week.end}T23:59:59.999Z`;
  const metricsByLabel = new Map();
  for (const repo of config.repos ?? []) {
    if (repo.role === 'display') continue;
    const m = repoMetricsInWindow(repo.resolvedPath ?? repo.path, config.identity.authorEmails, sinceISO, untilISO);
    if (m) metricsByLabel.set(repo.label, m);
  }

  // --- assemble -> redact -> emit ---
  const verifiedIndex = new Map(verified.map((v) => [v.sha, v]));
  const model = assembleReportModel(items, config, verifiedIndex, week, metricsByLabel);
  const redactor = createRedactor(config);
  const redacted = redactor.deepRedact(model);

  let result;
  try {
    result = emit(redacted, config);
  } catch (err) {
    io.err(`build: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }

  io.out(`build: wrote ${result.path} (${result.mode}, ${result.items} item(s), ${result.bytes} bytes).\n`);
  return 0;
}

export default function run(argv) {
  return runBuild({ argv });
}
