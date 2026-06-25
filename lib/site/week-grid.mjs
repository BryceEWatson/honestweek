// lib/site/week-grid.mjs — the 7-day Monday→Sunday grid shared by the site derivers.
//
// Both the commit chart (derive.mjs) and the session hero (sessions.mjs) bucket
// their counts into the SAME seven calendar days, so the day stubs (date,
// weekday, isWeekend, isToday) must be computed identically. This is the single
// source of truth for that grid, so a chart day and a session day can never
// disagree about which date a bar represents.
//
// honestweek's week window is always a completed Monday→Sunday range (see
// resolve-week.mjs), so each day's weekday + weekend flag is fixed by its index
// (0 = Monday … 6 = Sunday) — deterministic and timezone-independent. Only the
// volatile `isToday` flag depends on the clock, and the parity gate masks it.
//
// Zero runtime dependencies: Node built-ins only.

const DAY_MS = 86400000;

/** Monday-first weekday abbreviations — index 0..6 over the completed week. */
export const WEEKDAYS_FROM_MONDAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** The number of days in honestweek's reporting window. */
export const WEEK_DAYS = 7;

/** The YYYY-MM-DD calendar date `i` days after the (UTC-midnight) Monday. */
export function dayKey(weekStartISO, i) {
  const monday = new Date(`${weekStartISO}T00:00:00.000Z`);
  return new Date(monday.getTime() + i * DAY_MS).toISOString().slice(0, 10);
}

/**
 * weekGrid(weekStartISO, todayKey) -> [{ date, weekday, isWeekend, isToday }, ...]
 *
 * The seven day stubs, Monday→Sunday. `weekStartISO` is the Monday (YYYY-MM-DD);
 * `todayKey` is the YYYY-MM-DD the caller considers "today" (already resolved in
 * the report's timezone) — only used to set the volatile `isToday` flag.
 */
export function weekGrid(weekStartISO, todayKey) {
  const grid = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    const date = dayKey(weekStartISO, i);
    grid.push({
      date,
      weekday: WEEKDAYS_FROM_MONDAY[i],
      isWeekend: i >= 5, // Saturday (5) and Sunday (6)
      isToday: date === todayKey,
    });
  }
  return grid;
}
