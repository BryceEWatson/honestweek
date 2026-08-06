// lib/mine/ledger.mjs — the findings ledger: durable state, and the error signal.
//
// WHY A LEDGER AND NOT A REPORT
// ----------------------------------------------------------------------------
// A miner that printed its findings and exited would measure the WORKER: "this run
// found 3 things". That number goes up when the tool runs more often and tells you
// nothing about whether any problem ever reached a reader. It is the metric that
// lets a pipeline look healthy for seven weeks while producing nothing.
//
// The number that measures the WORLD is the BACKLOG: findings discovered and not yet
// decided. It can only fall when a human accepts or declines one. If the miner runs
// every week and the backlog climbs, the finding half works and the deciding half
// does not — which is exactly the failure that has to be visible early rather than
// at the post-mortem.
//
//   backlog = |{ finding : status in (new, drafted) }|
//
// A finding leaves the backlog by being PUBLISHED or DECLINED. Both are human acts.
// Nothing this tool does can lower the backlog on its own, and that is the point.
//
// STATUSES
//   new        detected, no draft written yet
//   drafted    a draft exists and is waiting on a person
//   published  the human shipped it            (terminal, leaves the backlog)
//   declined   the human said no               (terminal, leaves the backlog)
//   stale      re-verification failed: the fix no longer holds (terminal)
//
// The file is append-mostly and safe to commit: everything in it has been through
// de-identification and the configured redactor before it arrives.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteJson } from '../atomic-json.mjs';

export const OPEN_STATUSES = Object.freeze(['new', 'drafted']);
export const TERMINAL_STATUSES = Object.freeze(['published', 'declined', 'stale']);
export const ALL_STATUSES = Object.freeze([...OPEN_STATUSES, ...TERMINAL_STATUSES]);

const EMPTY = Object.freeze({ version: 1, findings: [], runs: [] });

/** Read the ledger, or an empty one. A malformed ledger is an ERROR, never silently
 *  replaced: overwriting it would destroy the decision history that is the only
 *  record of what a human already said no to. */
export function loadLedger(path) {
  if (!path || !existsSync(path)) return structuredClone(EMPTY);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read findings ledger at ${path}: ${err.message}`);
  }
  if (raw.trim().length === 0) return structuredClone(EMPTY);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`findings ledger at ${path} is not valid JSON (${err.message}). Fix or move it; it holds your decisions.`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) {
    throw new Error(`findings ledger at ${path} is missing its "findings" array.`);
  }
  return { version: parsed.version ?? 1, findings: parsed.findings, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
}

/** Write via the repo's atomic-write helper (unique temp name + fsync + rename), so an
 *  interrupted run cannot truncate the ledger and two overlapping runs cannot publish
 *  each other's half-written temp file. */
export function saveLedger(path, ledger) {
  atomicWriteJson(path, ledger);
}

/**
 * Fold this run's ranked findings into the ledger.
 *
 * A finding already recorded is UPDATED, never duplicated and never resurrected: if a
 * human declined it, seeing the same error again does not reopen it. Re-detection
 * only refreshes the evidence and bumps `lastSeen`/`sessionCount`, so "you already
 * said no to this" survives every future run.
 */
export function mergeFindings(ledger, ranked, { now = new Date() } = {}) {
  const iso = now.toISOString();
  const byKey = new Map(ledger.findings.map((f) => [f.key, f]));
  let added = 0;
  let refreshed = 0;
  let suppressed = 0;

  for (const r of ranked) {
    const key = r.findingKey;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        status: 'new',
        firstSeen: iso,
        lastSeen: iso,
        startedAt: r.startedAt ?? null,
        corpus: r.corpus ?? null,
        sessionCount: r.sessionCount ?? 1,
        score: r.score,
        measuredScore: r.measuredScore,
        primaryError: r.primaryError,
        alternateErrors: r.alternateErrors ?? [],
        products: r.products ?? [],
        versions: r.versions ?? [],
        resolution: r.resolution ?? [],
        evidence: r.evidence ?? {},
        scoreComponents: r.scoreComponents ?? [],
        alreadyCovered: r.alreadyCovered ?? null,
        draftPath: null,
        decidedAt: null,
      });
      added += 1;
      continue;
    }
    existing.lastSeen = iso;
    existing.sessionCount = Math.max(existing.sessionCount ?? 1, r.sessionCount ?? 1);
    if (TERMINAL_STATUSES.includes(existing.status)) {
      suppressed += 1; // a decided finding stays decided
      continue;
    }
    existing.score = r.score;
    existing.measuredScore = r.measuredScore;
    existing.evidence = r.evidence ?? existing.evidence;
    existing.scoreComponents = r.scoreComponents ?? existing.scoreComponents;
    existing.alreadyCovered = r.alreadyCovered ?? existing.alreadyCovered;
    refreshed += 1;
  }

  ledger.findings = [...byKey.values()].sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)));
  return { added, refreshed, suppressed };
}

/** Findings awaiting a human decision — the error signal. */
export function backlog(ledger) {
  return ledger.findings.filter((f) => OPEN_STATUSES.includes(f.status));
}

/** The counts a run should report, and a scheduled job should alarm on. */
export function errorSignal(ledger) {
  const open = backlog(ledger);
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, ledger.findings.filter((f) => f.status === s).length]));
  const oldestOpen = open.reduce((min, f) => (!min || f.firstSeen < min ? f.firstSeen : min), null);
  const ageDays = oldestOpen ? Math.floor((Date.now() - new Date(oldestOpen).getTime()) / 86400000) : 0;
  return {
    // Undecided findings. Rises when discovery works and deciding does not.
    backlog: open.length,
    // How long the longest-waiting finding has been waiting. A backlog of 1 sitting
    // for 60 days is a different failure from a backlog of 12 opened this morning,
    // and reporting only the count hides the difference.
    oldestOpenDays: ageDays,
    counts,
    // Discovered-to-decided, all time. The ratio the whole capability exists to move.
    decided: counts.published + counts.declined + counts.stale,
    discovered: ledger.findings.length,
  };
}

/** Record what a run SAW, so "found nothing" can never be confused with "did not look".
 *  Kept as a rolling window: the ledger is a decision record, not a log file. */
export function recordRun(ledger, run, { keep = 60 } = {}) {
  ledger.runs = [...(ledger.runs ?? []), run].slice(-keep);
  return ledger;
}

/** Set a finding's status. Returns the finding, or null when the key is unknown. */
export function setStatus(ledger, key, status, { now = new Date(), draftPath } = {}) {
  if (!ALL_STATUSES.includes(status)) throw new Error(`unknown finding status "${status}"`);
  const f = ledger.findings.find((x) => x.key === key);
  if (!f) return null;
  f.status = status;
  if (draftPath !== undefined) f.draftPath = draftPath;
  if (TERMINAL_STATUSES.includes(status)) f.decidedAt = now.toISOString();
  return f;
}

/** The next finding a human should be asked about: highest-scoring, undecided, and
 *  not yet drafted. Returns null when the backlog holds nothing new to draft. */
export function nextToDraft(ledger) {
  return ledger.findings.filter((f) => f.status === 'new' && !f.alreadyCovered).sort((a, b) => b.score - a.score)[0] ?? null;
}
