// lib/view/own-week.mjs: the person's own week, as `honestweek view` reads it and the find,
// replay, problems and goals commands (lib/ask.mjs) read it too: the config the lookup finds,
// the window the options or the config's "history" name, the log folders, and the goal list.
// Read-only: it opens the config and the goal list, and sizes the logs by their files alone.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { HISTORY_LIMIT_MB, loadConfig } from '../config.mjs';
import { findConfig } from '../config-lookup.mjs';
import { currentCommand } from '../invocation.mjs';
import { normalizeGoalRecord } from '../replay/goals.mjs';
import { defaultRoots } from '../replay/sources.mjs';
import { localDateInTimezone } from '../resolve-week.mjs';
import { planWindow } from './window.mjs';

const DEFAULT_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A plain message for a setting that can't be read: `view` prints it and stops. */
export class SetupError extends Error {}
export const setup = (message) => new SetupError(message);

export const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const spanDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
export const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The window to read: --from/--to, or the last --days days (default 7) ending today. */
export function resolveViewWindow(values, timezone, now = Date.now()) {
  const hasRange = '--from' in values || '--to' in values;
  if (hasRange && '--days' in values) throw setup('view: use --days, or --from with --to, not both.');
  if (hasRange) {
    const from = values['--from'];
    const to = values['--to'];
    if (from === undefined || to === undefined) throw setup('view: --from and --to go together. Give both, or use --days.');
    for (const [name, v] of [['--from', from], ['--to', to]]) if (!validDate(v)) throw setup(`view: ${name} must be a date written YYYY-MM-DD (got ${JSON.stringify(v)}).`);
    if (from > to) throw setup(`view: --from (${from}) is after --to (${to}).`);
    return { from, to };
  }
  let days = DEFAULT_DAYS;
  if ('--days' in values) {
    const v = values['--days'];
    if (!/^\d{1,4}$/.test(v) || Number(v) < 1 || Number(v) > 3660) throw setup(`view: --days must be a whole number from 1 to 3660 (got ${JSON.stringify(v)}).`);
    days = Number(v);
  }
  const today = localDateInTimezone(new Date(now), timezone).toISOString().slice(0, 10);
  return { from: shiftDay(today, -(days - 1)), to: today };
}

/**
 * readGoalList(path) -> the parsed goal list. Throws a setup error with a plain message
 * when the file is missing, can't be read as JSON, is the goals page's registry, or doesn't fit.
 */
export function readGoalList(path) {
  if (!existsSync(path)) throw setup(`view: no goal list at ${path}. Fix the path, or leave the goal list out; search and replay work without one.`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never the parser's message: it quotes the file's first characters, and this check takes
    // any path. A folder or an unreadable file reads the same as a file that isn't JSON.
    throw setup(`view: ${path} isn't a goal list (not valid JSON).`);
  }
  const looksLikeRegistry = parsed && typeof parsed === 'object' && !Array.isArray(parsed.goals) && (parsed.objectives !== undefined || parsed.projectToObjective !== undefined);
  if (looksLikeRegistry) {
    throw setup(`view: ${path} looks like the goals page's list (its "objectives"), which honestweek build reads. view reads a different file, a goal list: { "goals": [{ "id": "g-1", "title": "Ship the parser" }], "events": [] }. The README's goal list section shows the format.`);
  }
  try {
    normalizeGoalRecord(parsed);
  } catch (err) {
    throw setup(`view: ${path} isn't a goal list: ${String(err?.message ?? err).replace(/^replay: /, '')}`);
  }
  return parsed;
}

/** The config's limit on log data a saved choice loads, in MB. */
export const limitOf = (config) => config?.historyLimitMB ?? HISTORY_LIMIT_MB.default;

export const absolute = (cwd, p) => (isAbsolute(p) ? p : resolve(cwd, p));

/** The person's own week: the config, the window and the goal list the options and the config
 *  name. Throws a setup error with a plain message when one of them can't be read. The find,
 *  replay, problems and goals commands (lib/ask.mjs) read the same week. */
export function ownWeek({ values, cwd, env, now }) {
  const configPath = findConfig({ cwd, flag: values['--config'] }).path;
  if (!existsSync(configPath)) throw setup(`view: no config at ${configPath}. Run ${currentCommand()} view in a folder with no config to set one up in your browser (or ${currentCommand()} init in a terminal), or ${currentCommand()} view --demo to look around a made-up week first.`);
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    throw setup(`view: ${err.message}`);
  }
  const timezone = values['--timezone'] ?? config.week?.timezone;
  if (!validTimezone(timezone)) throw setup(`view: ${JSON.stringify(timezone)} isn't a timezone this machine knows. Use an IANA name such as Europe/Paris or UTC.`);
  const roots = defaultRoots(env);
  // The flags win for one run. With none, a saved choice is sized to fit (the last week, or up to
  // 7 days, always whole); with no saved choice either, it's the last 7 days, as it always was.
  // Either way a window of more than one day loads its newest day first.
  const flagged = ['--days', '--from', '--to'].some((f) => f in values);
  const plan = !flagged && config.history ? planWindow(config.history, { roots, timezone, now: now(), maxBytes: limitOf(config) * 1024 * 1024 }) : null;
  const { from, to } = plan ?? resolveViewWindow(values, timezone, now());
  const goalsPath = values['--goals'] ? absolute(cwd, values['--goals']) : config.goalsFile ?? null;
  const goalRecord = goalsPath ? readGoalList(goalsPath) : null;
  return { config, configPath, roots, from, to, timezone, goalRecord, windowNote: plan?.note ?? null };
}
