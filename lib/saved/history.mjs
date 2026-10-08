// lib/saved/history.mjs: each day's history, saved day by day (issue 151, second part).
//
// With "saveResults" on and its "history" not turned off, `honestweek view` saves, beside the
// check results (lib/saved/checks.mjs), what the engine built for each session that started that
// day: its steps, agents, links, token counts, and the joins that tie it to other sessions, goals
// and git (lib/replay/saved-sessions.mjs says exactly what, and what's left out). One gzipped file
// per day, days/<day>.json.gz in the saved folder, compressed with Node's own zlib.
//
// A later run gives the engine back each saved session whose log is gone, so it stays replayable,
// on the sessions list, in Replay, on Problems with the findings saved with it, in goals and in
// pull-request and commit lookups. Each one says when it was saved, by which honestweek version,
// and that its log is gone. A session whose log is still on disk is read from the log, as always.
//
// What's written is the redacted build's output, never the private build's, and it's redacted
// again with the reading run's settings when it comes back (in the engine). A later run replaces
// each day it read, keeping any saved session it didn't read.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { localDateRangeInstants } from '../resolve-week.mjs';
import { localDay } from '../replay/views.mjs';
import { fileFingerprint, SAVED_SESSION_SCHEMA } from '../replay/saved-sessions.mjs';
import { CHECKS_SUB } from './checks.mjs';
import { honestweekVersion, keptFrom, logPaths, MAX_SAVED_FILE, pruneSaved, readSaved, redactionPrint, SAVED_SCHEMA, savedDays, writeSavedBytes } from './store.mjs';

/** The sub-folder of the saved folder that holds each day's history. */
export const DAYS_SUB = 'days';
/** The largest a saved day may be once unzipped; a larger one is read as missing. */
export const MAX_DAY_BYTES = 512 * 1024 * 1024;
/** How many days before a window a session that runs into it may have started, and still be
 *  found in its start day's file. */
export const LOOKBACK_DAYS = 7;
/** A session that wrote a record this recently is read again even when its log hasn't changed:
 *  the checks say a finding near the end of one that may still be running is only a note. */
export const RECENT_MS = 24 * 60 * 60 * 1000;

const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayFile = (day) => `${day}.json.gz`;

/** One saved day's history, or null when it's missing, too big, unreadable or of another shape. */
export function readHistoryDay(dir, day) {
  const path = join(dir, DAYS_SUB, dayFile(day));
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_SAVED_FILE) return null;
    const text = gunzipSync(readFileSync(path), { maxOutputLength: MAX_DAY_BYTES }).toString('utf8');
    const value = JSON.parse(text);
    return value && value.schema === SAVED_SCHEMA && Array.isArray(value.sessions) ? value : null;
  } catch {
    return null;
  }
}

/**
 * saveHistory({ dir, config, h, keepDays, others, now }) -> { days, sessions }
 * Each day of h's window, from its first day to its last: the sessions h read from logs that
 * started that day, as the engine exports them, and any saved session of that day h didn't read.
 * A day already past keepDays isn't written. h must be the redacted build, made with `saving`.
 */
export function saveHistory({ dir, config, h, keepDays, others = false, now = Date.now() }) {
  if (typeof h.exportSession !== 'function') return { days: [], sessions: 0 };
  const tz = h.window.timezone;
  const { from, to } = h.window;
  const savedAt = new Date(now).toISOString();
  const version = honestweekVersion();
  const redaction = redactionPrint(config);
  const today = localDay(now, tz);
  const oldest = keptFrom(today, keepDays);
  const byDay = new Map();
  for (const s of h.sessions) {
    if (!s.firstAt || s.saved) continue;
    // A session from a display-only repository or a folder outside the config is saved only when
    // the config says so ("otherSessions"): by default only configured repositories' history is.
    if (s.private && !others) continue;
    const day = localDay(Date.parse(s.firstAt), tz);
    if (day < from || day > to || (oldest && day < oldest)) continue;
    const x = h.exportSession(s.key);
    if (!x) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ ...x, savedAt, version });
  }
  const days = [];
  let sessions = 0;
  for (let day = from; day <= to; day = shift(day, 1)) {
    if (oldest && day < oldest) continue;
    const fresh = byDay.get(day) ?? [];
    const had = readHistoryDay(dir, day);
    // A day file that's there but can't be read (damaged, too big, or of a newer shape) may hold
    // the only copy of sessions whose logs are gone: it's left as it is, not written over.
    if (!had && existsSync(join(dir, DAYS_SUB, dayFile(day)))) continue;
    // A saved session that named a log file this run didn't read (a sub-agent's log deleted before
    // the session's own) keeps its fuller saved copy rather than the part read now.
    const fuller = new Map((had?.sessions ?? []).filter((x) => x && typeof x.key === 'string').map((x) => [x.key, x]));
    const keepsOld = (x) => {
      const old = fuller.get(x.key);
      if (!old) return false;
      const now = new Set((x.sources ?? []).map((s) => s.key));
      return (old.sources ?? []).some((s) => !now.has(s.key));
    };
    const freshUsed = fresh.filter((x) => !keepsOld(x));
    const freshKeys = new Set(freshUsed.map((x) => x.key));
    const kept = (had?.sessions ?? []).filter((x) => x && typeof x.key === 'string' && !freshKeys.has(x.key));
    const all = [...freshUsed, ...kept].sort((a, b) => String(a.record?.firstAt).localeCompare(String(b.record?.firstAt)) || (a.key < b.key ? -1 : 1));
    const value = { schema: SAVED_SCHEMA, day, timezone: tz, savedAt, version, redaction, sessions: all };
    writeSavedBytes(dir, [DAYS_SUB, dayFile(day)], gzipSync(Buffer.from(JSON.stringify(value), 'utf8')));
    days.push(day);
    sessions += all.length;
  }
  const pruned = pruneSaved(dir, DAYS_SUB, { keepDays, today });
  return { days, sessions, pruned };
}

/** With history off, the days saved while it was on are still deleted once past keepDays. */
export function pruneHistory({ dir, h, keepDays, now = Date.now() }) {
  return pruneSaved(dir, DAYS_SUB, { keepDays, today: localDay(now, h.window.timezone) });
}

/**
 * loadSaved({ dir, from, to, timezone, roots, now }) -> { sessions, findings, reuse }
 * The saved sessions whose span overlaps from..to (read in `timezone`) that a build can take back
 * instead of reading a log, for buildWorkHistory's `saved` and `reuse`:
 *   - each one none of whose log files is on disk any more, marked log: 'gone';
 *   - each one whose log files are all on disk, unchanged since it was saved (size, last change
 *     and a hash of their first bytes), saved by this honestweek version with these private-word
 *     settings, that ended more than RECENT_MS before `now`, and whose check results were saved
 *     too, marked log: 'on-disk' and named in `reuse`.
 * Any other saved session is left to the log, read again. `findings` holds the findings the checks
 * saved with each session taken back (an empty list for one with none), for runProblems' `saved`,
 * and `statuses` each one's pattern states when it was checked, for its `savedStatus`.
 */
export function loadSaved({ dir, from, to, timezone, roots, config = null, now = Date.now() }) {
  const { start, endExclusive } = localDateRangeInstants(from, to, timezone);
  const startT = start.getTime();
  const endT = endExclusive.getTime();
  const version = honestweekVersion();
  const print = config ? redactionPrint(config) : null;
  const sessions = [];
  const findings = new Map();
  const statuses = new Map();
  const reuse = new Set();
  let onDisk = null;
  const seen = new Set();
  const checksOf = new Map();
  const checksDay = (day) => {
    if (!checksOf.has(day)) {
      const c = readSaved(dir, [CHECKS_SUB, `${day}.json`]);
      checksOf.set(day, c && Array.isArray(c.sessions) && Array.isArray(c.findings) ? c : null);
    }
    return checksOf.get(day);
  };
  // A finding counts only when its moment is in the window, as the checks would find it now.
  const inWindow = (y) => {
    const t = Date.parse(y?.at ?? '');
    return !Number.isFinite(t) || (t >= startT && t < endT);
  };
  for (let day = shift(from, -LOOKBACK_DAYS); day <= to; day = shift(day, 1)) {
    const f = readHistoryDay(dir, day);
    if (!f) continue;
    for (const x of f.sessions) {
      if (!x || x.schema !== SAVED_SESSION_SCHEMA || typeof x.key !== 'string' || seen.has(x.key)) continue;
      const first = Date.parse(x.record?.firstAt ?? '');
      const last = Date.parse(x.record?.lastAt ?? x.record?.firstAt ?? '');
      if (!Number.isFinite(first) || first >= endT || (Number.isFinite(last) ? last : first) < startT) continue;
      const files = (x.sources ?? []).map((s) => s.file).filter(Boolean);
      onDisk ??= logPaths(roots);
      const present = (x.sources ?? []).filter((s) => s.file && onDisk.has(s.file));
      // The day it was saved under holds its check results, whatever the timezone is now.
      const c = checksDay(f.day);
      const checked = c?.sessions.find((s) => s?.key === x.key) ?? null;
      const own = c ? c.findings.filter((y) => y?.session === x.key && inWindow(y)) : [];
      if (files.length && !present.length) {
        seen.add(x.key);
        sessions.push({ ...x, log: 'gone' });
        findings.set(x.key, own);
        if (Array.isArray(checked?.status)) statuses.set(x.key, checked.status);
        continue;
      }
      const unchanged = present.length === (x.sources ?? []).length && present.every((s) => {
        const fp = fileFingerprint(onDisk.get(s.file));
        return fp && fp.size === s.size && fp.mtimeMs === s.mtimeMs && fp.head === s.head;
      });
      const settled = Number.isFinite(last) && now - last > RECENT_MS;
      if (!unchanged || !settled || !checked || x.version !== version || (print && f.redaction !== print)) continue;
      seen.add(x.key);
      sessions.push({ ...x, log: 'on-disk' });
      findings.set(x.key, own);
      if (Array.isArray(checked.status)) statuses.set(x.key, checked.status);
      reuse.add(x.key);
    }
  }
  return { sessions, findings, statuses, reuse };
}

/** How many bytes of logs a byte of a saved day stands for, in memory once it's loaded: on the
 *  made-up demo week, 6.1 MB of logs saved as 194 KB of gzipped days (about 31 to 1). An estimate. */
export const SAVED_LOG_RATIO = 30;

/**
 * savedDayFiles(dir, logs) -> [{ day, size }]
 * The saved days with no log file of their own (in `logs`, as logFiles lists them), each sized as
 * the logs it stands for (SAVED_LOG_RATIO), so the window's plan and its memory check count the
 * sessions a saved day brings back. Empty when nothing's saved.
 */
export function savedDayFiles(dir, logs = []) {
  const withLogs = new Set(logs.map((f) => f.day));
  const out = [];
  for (const day of savedDays(dir, DAYS_SUB)) {
    if (withLogs.has(day)) continue;
    try {
      out.push({ day, size: statSync(join(dir, DAYS_SUB, dayFile(day))).size * SAVED_LOG_RATIO });
    } catch {
      /* gone since the listing */
    }
  }
  return out;
}

/** The log files and the saved days with no log of their own, as one list (savedDayFiles). */
export const withSavedDays = (logs, dir) => [...logs, ...savedDayFiles(dir, logs)];
