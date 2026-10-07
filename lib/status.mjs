// lib/status.mjs: `honestweek status`, where the weekly summary stands, read-only (issue 183).
//
// The weekly skill loads this before its first step, so it can start from where things are
// instead of from init. It reports which config it found and where (the lookup from #177), the
// last completed week, whether the draft and items exist and which week each covers, whether the
// items pass validate's item gate, whether the output is built and when (not which week: the
// output carries no week status can read), and the next step as a command in the form the user
// ran honestweek.
//
// It always exits 0: a missing or broken file is a line in the report, never a failure, since a
// failing command aborts a skill that loads it. It writes nothing and runs no git. It prints names,
// weeks, counts and states only: never an item's text or anything from a session.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { loadConfig } from './config.mjs';
import { configAgain, configSourceWords, findConfig, takeConfigFlag } from './config-lookup.mjs';
import { isReservedDigestItem } from './digest-schema.mjs';
import { currentCommand } from './invocation.mjs';
import { localDateInTimezone, resolveWeek } from './resolve-week.mjs';
import { validateItems } from './validate.mjs';

const DRAFT_FILE = 'honestweek.draft.json';
const ITEMS_FILE = 'honestweek.items.json';

const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const weekOf = (w) => {
  const start = day(w?.start ?? w?.weekStart);
  const end = day(w?.end ?? w?.weekEnd);
  return start && end ? { start, end } : null;
};
const sameWeek = (a, b) => !!a && !!b && a.start === b.start && a.end === b.end;
const span = (w) => `${w.start} to ${w.end}`;
/** The first line of an error, so a report never carries a file's contents. */
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 200);
const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Why a config can't be loaded, without anything from the file: a JSON parser's message quotes
 * the text around the fault, and some field checks quote the value they rejected.
 */
function configProblem(err) {
  const msg = firstLine(err);
  if (/is not valid JSON/.test(msg)) return 'not valid JSON';
  if (/file not found at|could not read/.test(msg)) return "it can't be read";
  const field = /"([A-Za-z][\w.[\]]*)"/.exec(msg);
  return field ? `"${field[1]}" isn't valid` : "it doesn't pass the config checks";
}

/** A JSON file's parsed value, or { error } with a one-line reason. */
function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { error: err instanceof SyntaxError ? 'not valid JSON' : firstLine(err) };
  }
}

/**
 * statusOf({ cwd, argv, now, lookup, command }) -> the report as a plain object.
 * `lookup` is the config lookup's machine context ({ env, home }); the entry point sets it.
 */
export function statusOf({ cwd = process.cwd(), argv = [], now = new Date(), lookup, command = currentCommand() } = {}) {
  const report = { config: null, week: null, draft: null, items: null, output: null, next: null };

  const flag = takeConfigFlag(argv);
  // A next command repeats --config, so it reads the same config this report did.
  const run = (step) => [command, step, ...configAgain(flag.config)].join(' ');
  if (flag.error) {
    report.config = { found: false, error: flag.error };
    report.next = { step: 'fix-flag', says: flag.error };
    return report;
  }
  const found = findConfig({ cwd, flag: flag.config, ...(lookup ? { lookup } : {}) });
  report.config = { found: found.exists, path: found.path, source: found.source, where: configSourceWords(found.source) };
  if (!found.exists) {
    if (found.source === 'env' || found.source === 'flag') {
      report.config.error = `${found.path} isn't there`;
      report.next = { step: 'fix-config', says: `Fix the path ${found.source === 'env' ? 'HONESTWEEK_CONFIG' : '--config'} names, or remove it.` };
    } else {
      report.next = { step: 'init', command: run('init'), says: `No config yet. ${run('init')} writes one here from your git settings, or ${run('view')} sets one up in your browser.` };
    }
    return report;
  }

  let config;
  try {
    config = loadConfig(found.path);
  } catch (err) {
    report.config.readable = false;
    report.config.error = configProblem(err);
    report.next = { step: 'fix-config', says: `Fix ${found.path} (${run('validate')} says what's wrong), or move it away to start fresh.` };
    return report;
  }
  report.config.readable = true;
  const dir = found.dir;

  const timezone = config.week?.timezone || 'UTC';
  try {
    const { weekStart, weekEnd } = resolveWeek({ today: localDateInTimezone(now, timezone) });
    report.week = { start: weekStart.toISOString().slice(0, 10), end: weekEnd.toISOString().slice(0, 10), timezone };
  } catch (err) {
    report.week = { error: firstLine(err), timezone };
  }

  // The draft discover writes, and the week it covers.
  const draftPath = resolve(dir, DRAFT_FILE);
  report.draft = { file: DRAFT_FILE, exists: existsSync(draftPath) };
  if (report.draft.exists) {
    const d = readJson(draftPath);
    if (d.error) report.draft.error = d.error;
    else {
      report.draft.week = weekOf(d.value?.week);
      report.draft.sessions = Array.isArray(d.value?.sessions) ? d.value.sessions.length : null;
      report.draft.current = sameWeek(report.draft.week, report.week);
    }
  }

  // The items the skill writes, which week they name, and whether they pass the item gate.
  const itemsPath = resolve(dir, ITEMS_FILE);
  report.items = { file: ITEMS_FILE, exists: existsSync(itemsPath) };
  if (report.items.exists) {
    const it = readJson(itemsPath);
    if (it.error) report.items.error = it.error;
    else {
      const parsed = it.value;
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
      report.items.count = items.length;
      // build's order: a client report's `period`, else `week`.
      report.items.week = Array.isArray(parsed) ? null : weekOf(parsed?.period ?? parsed?.week);
      try {
        const gate = validateItems(items, config);
        const reserved = items.filter(isReservedDigestItem).length;
        report.items.passes = gate.ok && reserved === 0;
        report.items.problems = gate.problems.length + reserved;
      } catch {
        // An entry the gate can't even read (a null, a string) is still a problem, not a crash.
        report.items.passes = false;
        report.items.problems = items.filter((i) => !i || typeof i !== 'object').length || 1;
      }
      const draftAt = mtime(draftPath);
      const itemsAt = mtime(itemsPath);
      report.items.olderThanDraft = draftAt !== null && itemsAt !== null && itemsAt < draftAt;
    }
  }

  // The output build writes. A site build writes the artifact its JSON adapter names, beside the
  // config; a transform adapter is code, which status doesn't run, so that output stays unknown.
  const mode = config.output?.mode ?? null;
  let outFile = config.output?.file ?? null;
  if (mode === 'site') outFile = siteArtifact(config.output?.adapter);
  const outPath = outFile ? (isAbsolute(outFile) ? outFile : resolve(dir, outFile)) : null;
  report.output = { file: outFile, mode, exists: !!outPath && existsSync(outPath) };
  if (mode === 'site' && !outFile) report.output.unknown = true;
  // page and site output with no goals registry take the balanced digest too (flows/weekly.md).
  report.output.digest = (mode === 'page' || mode === 'site') && !existsSync(join(dir, 'honestweek.objectives.json'));
  if (report.output.exists) {
    const outAt = mtime(outPath);
    report.output.builtAt = outAt ? new Date(outAt).toISOString() : null;
    const itemsAt = report.items.exists ? mtime(itemsPath) : null;
    report.output.olderThanItems = outAt !== null && itemsAt !== null && outAt < itemsAt;
  }

  report.next = nextStep(report, run);
  return report;
}

/** The artifact path a JSON site adapter names, or null when it can't be read without running code. */
function siteArtifact(adapter) {
  if (typeof adapter !== 'string' || /\.(?:mjs|cjs|js)$/.test(adapter)) return null;
  const a = readJson(adapter);
  return typeof a.value?.artifact === 'string' && a.value.artifact ? a.value.artifact : null;
}

/** The next step of the weekly flow, from the report. */
function nextStep(r, run) {
  if (!r.draft.exists || r.draft.error || !r.draft.current) {
    const why = !r.draft.exists ? 'No draft yet.' : r.draft.error ? `The draft can't be read (${r.draft.error}).` : `The draft covers ${r.draft.week ? span(r.draft.week) : 'no week'}, not the last completed week.`;
    return { step: 'discover', command: run('discover'), says: `${why} ${run('discover')} writes the last completed week's draft.` };
  }
  if (!r.items.exists || r.items.error || r.items.olderThanDraft) {
    const why = !r.items.exists ? 'No items yet.' : r.items.error ? `The items file can't be read (${r.items.error}).` : 'The items are older than the draft.';
    return { step: 'distil', says: `${why} Distil the draft into ${ITEMS_FILE}, the skill's DISTIL step.` };
  }
  if (!r.items.passes) {
    return { step: 'validate', command: run('validate'), says: `${r.items.problems} item problem(s). Run ${run('validate')} to see them, fix ${ITEMS_FILE}, then build.` };
  }
  const digest = r.output.digest ? `${run('digest prepare')}, then ` : '';
  if (r.output.unknown) {
    return { step: 'build', command: run('build'), says: `The site adapter is code, so status can't see the output. If you haven't built since the items changed, run ${digest}${run('validate')}, then ${run('build')}.` };
  }
  if (!r.output.exists || r.output.olderThanItems) {
    return { step: 'build', command: run('build'), says: `${!r.output.exists ? 'Not built yet.' : 'The output is older than the items.'} Run ${digest}${run('validate')}, then ${run('build')}.` };
  }
  return { step: 'review', command: run('preview'), says: `Built. Review it with the user; ${run('preview')} opens it in their browser.` };
}

/** The report as lines of text. */
export function statusText(r) {
  const out = ['honestweek status (reads only, writes nothing)'];
  const c = r.config;
  if (!c?.found) out.push(`  config: ${c?.error ?? 'none found (this folder, HONESTWEEK_CONFIG, ~/.honestweek/honestweek.config.json)'}`);
  else if (c.readable === false) out.push(`  config: ${c.path} (${c.where}) can't be read: ${c.error}`);
  else out.push(`  config: ${c.path} (${c.where})`);
  if (r.week) out.push(r.week.error ? `  week: can't work out the last completed week: ${r.week.error}` : `  week: the last completed week is ${span(r.week)} (${r.week.timezone})`);
  if (r.draft) {
    const d = r.draft;
    out.push(`  draft: ${!d.exists ? `${d.file} not written yet` : d.error ? `${d.file} can't be read: ${d.error}` : `${d.file} covers ${d.week ? span(d.week) : 'no week'}${d.sessions !== null ? `, ${d.sessions} session(s)` : ''}${d.current ? '' : ' (not the last completed week)'}`}`);
  }
  if (r.items) {
    const i = r.items;
    let line;
    if (!i.exists) line = `${i.file} not written yet`;
    else if (i.error) line = `${i.file} can't be read: ${i.error}`;
    else {
      line = `${i.file}, ${i.count} item(s), ${i.week ? `week ${span(i.week)}` : 'no week named (build uses the last completed week)'}, ${i.passes ? 'pass the item gate' : `${i.problems} problem(s)`}`;
      if (i.olderThanDraft) line += ', older than the draft';
    }
    out.push(`  items: ${line}`);
  }
  if (r.output) {
    const o = r.output;
    out.push(`  output: ${o.unknown ? "set by the site adapter, which status doesn't run" : !o.file ? 'no output file configured' : !o.exists ? `${o.file} not built yet` : `${o.file}, built ${o.builtAt}${o.olderThanItems ? ', older than the items' : ''}`}`);
  }
  if (r.next) out.push(`  next: ${r.next.says}`);
  return `${out.join('\n')}\n`;
}

/** Entry point: prints the report and always exits 0. */
export default function run(argv = [], { cwd = process.cwd(), now = new Date(), out = (s) => process.stdout.write(s), lookup } = {}) {
  let report;
  try {
    report = statusOf({ cwd, argv: argv.filter((a) => a !== '--json'), now, lookup });
  } catch (err) {
    report = { error: firstLine(err), next: { step: 'unknown', says: `status couldn't finish: ${firstLine(err)}` } };
  }
  out(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : report.error ? `honestweek status: ${report.next.says}\n` : statusText(report));
  return 0;
}
