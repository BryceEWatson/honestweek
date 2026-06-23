// lib/resolve-week.mjs — resolve the reporting window.
//
// honestweek only ever reports on a FULLY COMPLETED Monday-Sunday week, so the
// output can never make claims about work that has not settled. This module is
// pure and clock-free: the caller always injects `today` (the build passes the
// real now; tests pass a fixed instant). No I/O, no git, no network.
//
// --- Output shape -----------------------------------------------------------
// resolveWeek(...) -> { weekStart, weekEnd } where both are `Date` objects:
//   weekStart = Monday   00:00:00.000 UTC of the completed week
//   weekEnd   = Sunday   23:59:59.999 UTC of that same week
// The window is the inclusive 7-calendar-day Monday-Sunday range. Callers use
// weekStart.toISOString() / weekEnd.toISOString() as the [since, until] bounds.
//
// --- Timezone handling ------------------------------------------------------
// The window boundary is computed from the CALENDAR DATE of `today` read in UTC.
// Timezone-correctness is the caller's responsibility: to report on the week as
// it falls in `config.week.timezone`, the caller converts the real instant to
// that zone's local date first (see `localDateInTimezone`) and passes the
// result as `today`. That keeps this function deterministic and tz-param-free
// while still yielding tz-correct windows (asserted in tests under two zones).
//
// --- weekArg form -----------------------------------------------------------
// Optional. An ISO week-date string "YYYY-Www" (e.g. "2024-W05") selecting a
// specific earlier completed Monday-Sunday week. A malformed string throws; a
// week that is the current in-progress week or in the future (relative to
// `today`) is rejected (throws) rather than silently clamped. Absent weekArg,
// the most recent completed week is returned.

const DAY_MS = 86400000;
const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;

/** A typed-enough error so callers/tests can distinguish week-resolution faults. */
export class WeekResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WeekResolutionError';
  }
}

/** UTC midnight Date for a given y/m/d (month is 1-based here). */
function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/** ISO weekday of a Date in UTC: Monday=1 ... Sunday=7. */
function isoWeekday(date) {
  const d = date.getUTCDay(); // Sunday=0..Saturday=6
  return d === 0 ? 7 : d;
}

/** Monday 00:00:00.000 UTC of the week containing `date` (read in UTC). */
function mondayOfWeek(date) {
  const base = utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  base.setUTCDate(base.getUTCDate() - (isoWeekday(base) - 1));
  return base;
}

/** Build the { weekStart(Mon 00:00), weekEnd(Sun 23:59:59.999) } for a Monday. */
function windowFromMonday(monday) {
  const weekStart = new Date(monday.getTime());
  const weekEnd = new Date(monday.getTime() + 6 * DAY_MS);
  weekEnd.setUTCHours(23, 59, 59, 999);
  return { weekStart, weekEnd };
}

/**
 * Convert an instant to the UTC-midnight Date of its LOCAL calendar date in the
 * given IANA timezone. Pure + deterministic (uses Intl, no clock/I-O). Callers
 * use this to feed a tz-correct `today` into resolveWeek.
 */
export function localDateInTimezone(instant, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return utcDate(get('year'), get('month'), get('day'));
}

/** Monday of ISO week W in ISO-week-year Y (both numbers). */
function mondayOfIsoWeek(year, week) {
  // ISO week 1 is the week containing Jan 4th.
  const jan4 = utcDate(year, 1, 4);
  const week1Monday = new Date(jan4.getTime() - (isoWeekday(jan4) - 1) * DAY_MS);
  return new Date(week1Monday.getTime() + (week - 1) * 7 * DAY_MS);
}

/** The ISO week-year + week number for a Date (read in UTC). */
function isoWeekOf(date) {
  // Thursday of this week decides the ISO week-year.
  const thursday = new Date(mondayOfWeek(date).getTime() + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const week1Monday = mondayOfIsoWeek(isoYear, 1);
  const week = Math.round((mondayOfWeek(date).getTime() - week1Monday.getTime()) / (7 * DAY_MS)) + 1;
  return { isoYear, week };
}

function parseWeekArg(weekArg) {
  if (typeof weekArg !== 'string') {
    throw new WeekResolutionError(`weekArg must be an ISO week string "YYYY-Www" (got ${typeof weekArg}).`);
  }
  const m = ISO_WEEK_RE.exec(weekArg.trim());
  if (!m) {
    throw new WeekResolutionError(`weekArg "${weekArg}" is malformed; expected "YYYY-Www" (e.g. "2024-W05").`);
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) {
    throw new WeekResolutionError(`weekArg "${weekArg}" has an out-of-range week number (must be 01-53).`);
  }
  const monday = mondayOfIsoWeek(year, week);
  // Reject e.g. "2024-W53" in a year with only 52 ISO weeks (it would roll into
  // the next year's week 1).
  const check = isoWeekOf(monday);
  if (check.isoYear !== year || check.week !== week) {
    throw new WeekResolutionError(`weekArg "${weekArg}" is not a valid ISO week for that year.`);
  }
  return monday;
}

/**
 * resolveWeek({ today, weekArg? }) -> { weekStart, weekEnd }
 * The last fully completed Monday-Sunday window relative to `today` (read in
 * UTC), or the specific completed week named by `weekArg`. Throws a
 * WeekResolutionError for a malformed weekArg or any future / in-progress week.
 */
export function resolveWeek({ today, weekArg } = {}) {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) {
    throw new WeekResolutionError('resolveWeek requires a valid `today` Date.');
  }

  const currentWeekMonday = mondayOfWeek(today);

  let monday;
  if (weekArg === undefined || weekArg === null) {
    // Most recent completed week = the week before today's current week.
    monday = new Date(currentWeekMonday.getTime() - 7 * DAY_MS);
  } else {
    monday = parseWeekArg(weekArg);
  }

  const { weekStart, weekEnd } = windowFromMonday(monday);

  // Verify-or-reject: the entire window must lie strictly before the current
  // (in-progress) week. This catches a weekArg naming the current or a future
  // week, and is a defensive backstop for the default path.
  if (weekEnd.getTime() >= currentWeekMonday.getTime()) {
    throw new WeekResolutionError(
      'resolved week is the current in-progress week or in the future; only completed weeks are reportable.'
    );
  }

  return { weekStart, weekEnd };
}
