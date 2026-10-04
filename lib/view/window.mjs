// lib/view/window.mjs: how far back `honestweek view` looks when the config saves a choice.
//
// A saved choice is the last n days, everything from a date, or all the history on this
// machine. Loading is held to MAX_LOG_BYTES of log files, newest first: the engine reads
// every file written in the window, and its memory grows with what it reads (measured on a
// synthetic history: about 1.3 MB of memory and half a second per MB of logs with Show private
// text off, about 2 MB and a second with it on). So the window starts on the oldest day whose files still fit,
// and when that's later than the day asked for, the note says which days are loaded.
//
// Sizing reads file sizes and last-write times only: no file is opened and git never runs.
// The --days, --from and --to flags skip all of this, exactly as before.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { localDateInTimezone } from '../resolve-week.mjs';

/** The most log data a saved choice loads at once. */
export const MAX_LOG_BYTES = 500 * 1024 * 1024;
/** What loading cost per MB of logs on the synthetic history (see docs/local-page.md). */
export const COST_PER_MB = Object.freeze({ seconds: 0.5, memoryMB: 1.3, baseMemoryMB: 110 });

const DAY = 86400000;
const dayOf = (ms, tz) => localDateInTimezone(new Date(ms), tz).toISOString().slice(0, 10);
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Every .jsonl log file under the roots, as { day, size } by its last write. */
export function logFiles(roots, timezone) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 8) walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = statSync(p);
          out.push({ day: dayOf(st.mtimeMs, timezone), size: st.size });
        } catch {
          /* gone since the listing */
        }
      }
    }
  };
  for (const r of [...(roots?.claude ?? []), ...(roots?.codex ?? [])]) if (r) walk(r, 0);
  return out;
}

/** "about 4 min and 760 MB of memory" for this much log data. */
export function costOf(bytes) {
  const mb = bytes / (1024 * 1024);
  const secs = Math.max(1, Math.round(mb * COST_PER_MB.seconds));
  const time = secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`;
  return { mb: Math.round(mb), seconds: secs, memoryMB: Math.round(COST_PER_MB.baseMemoryMB + mb * COST_PER_MB.memoryMB), text: `about ${time} and ${Math.round(COST_PER_MB.baseMemoryMB + mb * COST_PER_MB.memoryMB)} MB of memory` };
}

/** What the "how far back" choice shows: the logs on this machine, and what all of it loads. */
export function historyInfo({ roots, timezone, now = Date.now(), maxBytes = MAX_LOG_BYTES } = {}) {
  const files = logFiles(roots, timezone);
  const total = files.reduce((n, f) => n + f.size, 0);
  const all = planWindow({ all: true }, { files, timezone, now, maxBytes });
  return {
    logsMB: Math.round(total / (1024 * 1024)),
    earliest: files.length ? all.earliest : null,
    maxMB: Math.round(maxBytes / (1024 * 1024)),
    all: { from: all.from, to: all.to, capped: all.capped, cost: costOf(all.bytes).text, note: all.note },
  };
}

/**
 * planWindow(history, { roots, timezone, now, maxBytes }) -> { from, to, asked, earliest, capped, bytes, note }
 * `asked` is the first day the choice names (for all history, the oldest log's day).
 */
export function planWindow(history, { roots, timezone, now = Date.now(), maxBytes = MAX_LOG_BYTES, files } = {}) {
  const to = dayOf(now, timezone);
  const list = files ?? logFiles(roots, timezone);
  const earliest = list.reduce((m, f) => (f.day < m ? f.day : m), to);
  const asked = history.all ? earliest : history.from ?? shift(to, -(history.days - 1));
  const byDay = new Map();
  for (const f of list) if (f.day >= asked && f.day <= to) byDay.set(f.day, (byDay.get(f.day) ?? 0) + f.size);
  // Newest first: a day joins only when all of it still fits. Today always loads.
  let from = to;
  let bytes = byDay.get(to) ?? 0;
  for (const day of [...byDay.keys()].filter((d) => d < to).sort().reverse()) {
    if (bytes + byDay.get(day) > maxBytes) break;
    bytes += byDay.get(day);
    from = day;
  }
  // No files between the day asked for and the oldest one loaded: those days are loaded too.
  const older = [...byDay.keys()].filter((d) => d < from);
  if (!older.length && asked < from) from = asked;
  else if (older.length) {
    const newestLeftOut = older.sort().pop();
    from = shift(newestLeftOut, 1);
  }
  const capped = from > asked;
  const limit = `${Math.round(maxBytes / (1024 * 1024))} MB`;
  const note = capped ? `Loaded ${from} to ${to}: the newest ${limit} of logs. Older days, back to ${asked}, aren't loaded.` : null;
  return { from, to, asked, earliest, capped, bytes, note };
}
