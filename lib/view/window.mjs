// lib/view/window.mjs: how far back `honestweek view` looks when the config saves a choice.
//
// A saved choice is the last n days, everything from a date, a range of past days, or all the
// history on this machine. The last week, or the last n days up to 7, always loads whole,
// whatever its size: the page loads its newest day first and the rest after it
// (lib/view/progressive.mjs). A longer choice is held to a limit of log data (500 MB unless the
// config's historyLimitMB raises it), newest first, because memory grows with what's read. So
// its window starts on the oldest day whose files still fit, and when that's later than the day
// asked for, the note says which days are loaded.
//
// Sizing reads file sizes and last-write times only: no file is opened and git never runs.
// Setup's and Settings' preview line and the load itself come from planWindow with the same
// inputs, so the line states what the server loads. The --days, --from and --to flags skip the
// limit, exactly as before.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';

import { HISTORY_LIMIT_MB, normalizeHistory, normalizeHistoryLimit } from '../config.mjs';
import { localDateInTimezone } from '../resolve-week.mjs';

const MB = 1024 * 1024;
/** The most log data a saved choice loads at once, unless the config raises it. */
export const MAX_LOG_BYTES = HISTORY_LIMIT_MB.default * MB;
/** What loading cost per MB of logs on the synthetic week (see docs/local-page.md): its time the
 *  slower of the two runs measured, its memory above what either measured. That week repeats a few
 *  commits, so git cost almost nothing there; a real week citing many commits takes longer, so the
 *  time is shown as a minimum. */
export const COST_PER_MB = Object.freeze({ seconds: 0.04, memoryMB: 1.3, privateSeconds: 0.06, privateMemoryMB: 2.0, baseMemoryMB: 110 });
/** The longest "last n days" that always loads whole, past any limit. */
export const WHOLE_DAYS = 7;
/** Whether a saved choice is one that always loads whole: the last week, or up to 7 days. */
export const loadsWhole = (history) => !!history && !history.all && !history.from && Number.isInteger(history.days) && history.days <= WHOLE_DAYS;

const DAY = 86400000;
const dayOf = (ms, tz) => localDateInTimezone(new Date(ms), tz).toISOString().slice(0, 10);
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const sizeText = (bytes) => (bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${Math.max(bytes ? 1 : 0, Math.round(bytes / MB))} MB`);

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

/** How much log data the files written between `from` and `to`, inclusive, hold. */
export function bytesIn({ roots, timezone, from, to, files }) {
  return (files ?? logFiles(roots, timezone)).filter((f) => f.day >= from && f.day <= to).reduce((n, f) => n + f.size, 0);
}

/** Memory one build needs per MB of logs, at its peak, in MB: the most measured on the synthetic
 *  weeks (see docs/local-page.md), Show private text's build counted on its own. */
export const HEAP_PER_MB = 1.0;
/** How much more this process can hold before it runs out of memory, in bytes. */
export function memoryRoom() {
  const h = getHeapStatistics();
  return Math.max(0, h.heap_size_limit - h.used_heap_size);
}
/** Whether one more build over this much log data fits in `room`, with a tenth kept spare. */
export const fitsInMemory = (bytes, room = memoryRoom()) => bytes * HEAP_PER_MB <= room * 0.9;

/** An estimate, from the measured straight line, of loading this much log data. */
export function costOf(bytes) {
  const mb = bytes / MB;
  const time = (s) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
  const mem = (m) => sizeText((COST_PER_MB.baseMemoryMB + mb * m) * MB);
  return {
    mb: Math.round(mb),
    seconds: Math.round(mb * COST_PER_MB.seconds),
    memoryMB: Math.round(COST_PER_MB.baseMemoryMB + mb * COST_PER_MB.memoryMB),
    text: `at least ${time(mb * COST_PER_MB.seconds)} and about ${mem(COST_PER_MB.memoryMB)} of memory`,
    switchOnText: `at least ${time(mb * COST_PER_MB.privateSeconds)} and about ${mem(COST_PER_MB.privateMemoryMB)} with Show private text on`,
  };
}

/**
 * planWindow(history, { roots, timezone, now, maxBytes, files }) -> { from, to, asked, earliest, capped, bytes, note }
 * `asked` is the first day the choice names (for all history, the oldest log's day). A range
 * in the past ends on its own last day; anything else ends today.
 */
export function planWindow(history, { roots, timezone, now = Date.now(), maxBytes = MAX_LOG_BYTES, files } = {}) {
  const today = dayOf(now, timezone);
  const to = history.to && history.to < today ? history.to : today;
  const list = files ?? logFiles(roots, timezone);
  const earliest = list.reduce((m, f) => (f.day < m ? f.day : m), today);
  let asked = history.all ? earliest : history.from ?? shift(to, -(history.days - 1));
  if (asked > to) asked = to;
  const byDay = new Map();
  for (const f of list) if (f.day >= asked && f.day <= to) byDay.set(f.day, (byDay.get(f.day) ?? 0) + f.size);
  // The last week, or fewer days: every day, whatever its size, newest first.
  if (loadsWhole(history)) {
    const bytes = [...byDay.values()].reduce((n, b) => n + b, 0);
    return { from: asked, to, asked, earliest, capped: false, whole: true, bytes, note: null };
  }
  // Newest first: a day joins only when all of it still fits. The last day always loads.
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
  else if (older.length) from = shift(older.sort().pop(), 1);
  const capped = from > asked;
  const note = capped ? `Loaded ${from} to ${to}: the newest ${sizeText(maxBytes)} of logs. Older days, back to ${asked}, aren't loaded.` : null;
  return { from, to, asked, earliest, capped, whole: false, bytes, note };
}

/** How far back the logs go, and roughly how much log data each span holds, from file sizes. */
export function historyInfo({ roots, timezone, now = Date.now(), maxBytes = MAX_LOG_BYTES } = {}) {
  const files = logFiles(roots, timezone);
  const today = dayOf(now, timezone);
  const total = files.reduce((n, f) => n + f.size, 0);
  const since = (days) => files.filter((f) => f.day >= shift(today, -(days - 1))).reduce((n, f) => n + f.size, 0);
  const all = planWindow({ all: true }, { files, timezone, now, maxBytes });
  const days = files.map((f) => f.day).sort();
  return {
    logsMB: Math.round(total / MB),
    logs: sizeText(total),
    earliest: days[0] ?? null,
    latest: days[days.length - 1] ?? null,
    spans: [['Last week', 7], ['Last 30 days', 30], ['Last 90 days', 90], ['Last year', 365]].map(([label, n]) => ({ label, size: sizeText(since(n)) })).concat([{ label: 'All', size: sizeText(total) }]),
    maxMB: Math.round(maxBytes / MB),
    limits: HISTORY_LIMIT_MB,
    all: { from: all.from, to: all.to, capped: all.capped, cost: costOf(all.bytes).text, note: all.note },
  };
}

/** A saved choice and a limit as the /api/window query, so both ask the same question. */
export function paramsOfHistory(history, limitMB) {
  const h = history ?? { days: 7 };
  const q = new URLSearchParams();
  if (h.all) q.set('kind', 'all');
  else if (h.from && h.to) Object.entries({ kind: 'range', from: h.from, to: h.to }).forEach(([k, v]) => q.set(k, v));
  else if (h.from) Object.entries({ kind: 'from', from: h.from }).forEach(([k, v]) => q.set(k, v));
  else Object.entries({ kind: 'days', days: String(h.days) }).forEach(([k, v]) => q.set(k, v));
  if (limitMB != null) q.set('limit', String(limitMB));
  return q;
}

/**
 * The /api/window answer: which days a choice would load, whether that's partial, and an
 * estimate of the cost. Its query holds only a kind, a number of days, dates and a limit.
 */
export function windowAnswer(params, { roots, timezone, now = Date.now(), limitMB = HISTORY_LIMIT_MB.default, zoneOk = () => true }) {
  const kind = params.get('kind');
  const raw = kind === 'days' ? { days: Number(params.get('days')) } : kind === 'from' ? { from: params.get('from') } : kind === 'range' ? { from: params.get('from'), to: params.get('to') } : kind === 'all' ? { all: true } : kind === 'week' ? { days: 7 } : null;
  let history;
  let limit;
  try {
    if (!raw) throw new Error('kind');
    history = normalizeHistory(raw);
    limit = params.has('limit') ? normalizeHistoryLimit(Number(params.get('limit'))) : limitMB;
    // Setup sends the timezone its form holds, which the saved config will read the days in.
    if (params.has('tz') && !zoneOk(params.get('tz'))) throw new Error('tz');
  } catch {
    return { status: 400, body: { error: 'invalid', message: 'Pick how far back: a number of days, a date, two dates in order, or all history, and a limit in MB.' } };
  }
  const zone = params.get('tz') ?? timezone;
  const plan = planWindow(history, { roots, timezone: zone, now, maxBytes: limit * MB });
  const cost = costOf(plan.bytes);
  const span = `${plan.from} to ${plan.to}`;
  return {
    status: 200,
    body: {
      from: plan.from,
      to: plan.to,
      asked: plan.asked,
      capped: plan.capped,
      size: sizeText(plan.bytes),
      limitMB: limit,
      whole: plan.whole,
      timezone: zone,
      line: plan.capped ? `Loads ${span}: partial, the newest ${sizeText(limit * MB)}. Back to ${plan.asked} isn't loaded.` : plan.whole && plan.from < plan.to ? `Loads ${span} (${sizeText(plan.bytes)}), newest day first.` : `Loads ${span} (${sizeText(plan.bytes)}).`,
      estimate: `Estimate: ${cost.text}; ${cost.switchOnText}.`,
    },
  };
}
