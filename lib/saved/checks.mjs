// lib/saved/checks.mjs: the Problems checks' results, saved day by day (issue 151, first part).
//
// When "saveResults" is on, `honestweek view` saves what the checks found once the whole window
// has loaded: one file per day, checks/<day>.json in the saved folder (lib/saved/store.mjs),
// holding the sessions that started that day in the config's timezone. A session belongs to the
// day it started, whole, even when it runs past midnight. Each session says whether the checks
// read it (only sessions in configured repositories are), and each finding keeps the evidence
// word it had. A session in a display-only repository or a folder outside the config keeps only
// its id, its times and that it wasn't checked: no title, no repository, no finding.
//
// A later run replaces each day it covers, keeping any saved session it didn't read: that
// session's log is gone, or was moved, and what was saved is all there is of it. Days older than
// "keepDays" are deleted as it saves.
//
// Nothing saved is raw: every string passed the full redactor before it was written, and passes
// it again, with the reading run's settings, every time it's read, so a private word added later
// is hidden in old days too. A log's own session id is kept only as a hash (idHashOf), and a log
// file only as the hash of its path (pathKey), which is enough to tell whether it's still on disk.
//
// `honestweek problems --session <id>` reads these for a session that isn't in its window,
// through findSaved and savedSessionAnswer.
//
// Zero runtime dependencies: Node built-ins only.

import { createRedactor } from '../redact.mjs';
import { pathKey as pathKeyOf } from '../replay/ids.mjs';
import { localDay } from '../replay/views.mjs';
import { RULES as ENGINE_RULES } from '../replay/classify.mjs';
import { LAUNCH_RULES } from '../replay/launch.mjs';
import { isSure, RULES as CHECK_RULES, weakest } from '../problems/index.mjs';
import { redactAnswer } from '../view/problems-route.mjs';
import { sessionGroup } from '../view/replay-export.mjs';
import { honestweekVersion, idHashOf, keptFrom, logKeys, pruneSaved, readSaved, redactionPrint, savedDays, SAVED_SCHEMA, writeSaved } from './store.mjs';

/** The sub-folder of the saved folder that holds the check results. */
export const CHECKS_SUB = 'checks';
/** The shortest start of a session's key a saved lookup reads as that key (as in view's data). */
export const SAVED_PREFIX_MIN = 8;

/** Saved fields whose value is honestweek's own id, hash, time, date or word: kept when it has
 *  that shape, and redacted like any other string when it doesn't. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHAPES = {
  idHash: /^[a-p]{24}$/,
  files: /^f-[a-p]{12}$/,
  redaction: /^[a-p]{16}$/,
  days: DAY,
  day: DAY,
  savedAt: ISO,
  firstAt: ISO,
  version: /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/,
  tool: /^(?:claude-code|codex)$/,
  group: /^(?:configured|display|outside)$/,
  status: /^(?:found|clear|unchecked|undetectable)$/,
  severity: /^(?:look|note)$/,
  verdictEvidence: /^(?:recorded|derived|inferred|missing|ambiguous)$/,
  level: /^(?:recorded|derived|inferred|missing|ambiguous)$/,
};

/**
 * Every string in a saved value through `redact`, except one under a key above with that key's
 * shape, and the ids, times and dates redactAnswer keeps (lib/view/problems-route.mjs). Keys are
 * this file's own names, never log text, so they stay as they are.
 */
export function redactSaved(value, redact, key = null, depth = 0) {
  if (depth > 40) return null;
  if (typeof value === 'string' && SHAPES[key]?.test(value)) return value;
  if (Array.isArray(value)) return value.map((v) => redactSaved(v, redact, key, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSaved(v, redact, k, depth + 1);
    return out;
  }
  return redactAnswer(value, redact, key, depth);
}

const ALL_RULES = new Map([...ENGINE_RULES, ...LAUNCH_RULES, ...Object.entries(CHECK_RULES)]);
const ruleIdsIn = (text) => (typeof text === 'string' ? text.split(/[^A-Za-z0-9._-]+/).filter((id) => ALL_RULES.has(id)) : []);

/** A finding as it's saved: every field its check recorded, its step described from this build. */
function savedFinding(f, key, describeStep) {
  // Every field the check recorded, so a saved finding answers as the live one did, plus its key and
  // its step as this build described it.
  const out = {};
  for (const [k, v] of Object.entries(f)) if (!k.startsWith('_') && v !== undefined) out[k] = v;
  return { ...out, key: key ?? null, text: f.event ? describeStep(f.event) : null };
}

/**
 * saveChecks({ dir, configDir, config, h, result, keys, describeStep, keepDays, now }) ->
 *   { days, sessions, findings, pruned }
 *   h             the window's redacted history (the build the checks read)
 *   result, keys  runProblems(h) and each finding's key (lib/view/problems-route.mjs)
 *   describeStep  event id -> the step's description in this build, or null
 * Saves each day of h's window, from its first day to its last. Throws only when the folder
 * can't be written; the caller says so and the page goes on.
 */
export function saveChecks({ dir, config, h, result, keys = new Map(), describeStep = () => null, keepDays, now = Date.now() }) {
  const tz = h.window.timezone;
  const { from, to } = h.window;
  const redactor = createRedactor(config);
  const redact = (s) => redactor.redact(String(s));
  const savedAt = new Date(now).toISOString();
  const version = honestweekVersion();
  const redaction = redactionPrint(config);
  const ownIds = new Map([...(h.claudeIds ?? new Map()), ...(h.codexIds ?? new Map())]);
  const filesOf = new Map();
  for (const [src, file] of h.sourceFiles ?? new Map()) {
    const s = h.sourceSession?.get(src);
    if (!s) continue;
    if (!filesOf.has(s)) filesOf.set(s, new Set());
    filesOf.get(s).add(file);
  }
  // The days each session has a step on, for the per-day counts a later trend reads.
  const daysOf = new Map();
  for (const e of h.events) {
    if (!e.session || !Number.isFinite(e.t) || e.t < h.window.startT || e.t >= h.window.endT) continue;
    if (!daysOf.has(e.session)) daysOf.set(e.session, new Set());
    daysOf.get(e.session).add(localDay(e.t, tz));
  }
  // Each pattern's state in this window: found, clear, unchecked or undetectable.
  // Each pattern's state in this window, and for one whose check counts tokens, how it counts them,
  // so a later run that takes these sessions back unread can say the same.
  const status = result.patterns.map((p) => ({ id: p.id, status: p.status, level: weakest(p.measures.filter((m) => m.ran).map((m) => m.evidence)), ...(p.tokens ? { tokens: { waste: p.tokens.waste, label: p.tokens.label, evidence: p.tokens.evidence } } : {}) }));
  const findingsOf = new Map();
  for (const p of result.patterns) {
    for (const f of p.findings) {
      if (!f.session) continue;
      if (!findingsOf.has(f.session)) findingsOf.set(f.session, []);
      findingsOf.get(f.session).push(savedFinding(f, keys.get(f) ?? null, describeStep));
    }
  }

  const byDay = new Map();
  for (const s of h.sessions) {
    // A session that came back as saved keeps the entry it was saved with.
    if (!s.firstAt || s.saved) continue;
    const day = localDay(Date.parse(s.firstAt), tz);
    if (day < from || day > to) continue;
    const group = sessionGroup(s);
    const checked = group === 'configured';
    const id = ownIds.get(s.key);
    const findings = checked ? findingsOf.get(s.key) ?? [] : [];
    const entry = {
      key: s.key,
      idHash: idHashOf(id),
      tool: s.tool ?? null,
      group,
      checked,
      ...(checked ? { title: s.title ?? null, repo: typeof s.repo === 'string' ? s.repo : null } : {}),
      firstAt: s.firstAt,
      lastAt: s.lastAt ?? null,
      days: [...(daysOf.get(s.key) ?? [])].sort(),
      files: [...(filesOf.get(s.key) ?? [])].map((f) => pathKeyOf(f)).filter(Boolean).sort(),
      findings: findings.length,
      look: findings.filter((f) => f.severity === 'look').length,
    };
    if (!byDay.has(day)) byDay.set(day, { sessions: [], findings: [] });
    byDay.get(day).sessions.push(entry);
    byDay.get(day).findings.push(...findings);
  }

  let sessions = 0;
  let findings = 0;
  const days = [];
  // A day already past keepDays isn't written: it would be deleted as soon as it was saved.
  const today = localDay(now, tz);
  const oldest = keptFrom(today, keepDays);
  for (let day = from; day <= to; day = nextDay(day)) {
    if (oldest && day < oldest) continue;
    const fresh = byDay.get(day) ?? { sessions: [], findings: [] };
    const had = readDay(dir, day);
    // A session saved with a log file this run didn't read keeps its fuller saved entry (as in
    // lib/saved/history.mjs), findings and all.
    const oldFiles = new Map((had?.sessions ?? []).filter((s) => s && typeof s.key === 'string').map((s) => [s.key, Array.isArray(s.files) ? s.files : []]));
    const partial = new Set(fresh.sessions.filter((s) => oldFiles.has(s.key) && oldFiles.get(s.key).some((k) => !s.files.includes(k))).map((s) => s.key));
    if (partial.size) {
      fresh.sessions = fresh.sessions.filter((s) => !partial.has(s.key));
      fresh.findings = fresh.findings.filter((f) => !partial.has(f.session));
    }
    const freshKeys = new Set(fresh.sessions.map((s) => s.key));
    // A session saved before that this run didn't read stays, with its findings, as it was saved.
    const keptSessions = (had?.sessions ?? []).filter((s) => s && typeof s.key === 'string' && !freshKeys.has(s.key));
    const keptKeys = new Set(keptSessions.map((s) => s.key));
    const keptFindings = (had?.findings ?? []).filter((f) => keptKeys.has(f?.session));
    const all = [...fresh.sessions.map((s) => ({ ...s, savedAt, version, ...(s.checked ? { status } : {}) })), ...keptSessions].sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)) || (a.key < b.key ? -1 : 1));
    const allFindings = [...fresh.findings, ...keptFindings];
    // The text of each rule a finding names, as this version states it; a rule a kept finding names
    // that this version no longer has keeps the text it was saved with.
    const named = new Set(allFindings.flatMap((f) => ruleIdsIn(f.rule)));
    const rules = [...named].sort().map((id) => ({ id, text: ALL_RULES.get(id) }));
    for (const r of had?.rules ?? []) if (r && typeof r.id === 'string' && !ALL_RULES.has(r.id) && keptFindings.some((f) => String(f.rule ?? '').split(/[^A-Za-z0-9._-]+/).includes(r.id))) rules.push({ id: r.id, text: r.text });
    const value = redactSaved({ schema: SAVED_SCHEMA, day, timezone: tz, savedAt, version, redaction, window: { from, to }, status, rules, sessions: all, findings: allFindings }, redact);
    writeSaved(dir, [CHECKS_SUB, `${day}.json`], value);
    days.push(day);
    sessions += all.length;
    findings += allFindings.length;
  }
  const pruned = pruneSaved(dir, CHECKS_SUB, { keepDays, today });
  return { days, sessions, findings, pruned };
}

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);


/** One saved day, or null when it's missing or not the shape this file writes: a day that isn't
 *  is replaced whole by the next save rather than stopping it. */
function readDay(dir, day) {
  const f = readSaved(dir, [CHECKS_SUB, `${day}.json`]);
  return f && Array.isArray(f.sessions) && Array.isArray(f.findings) ? f : null;
}

/** Every saved session, newest day first: [{ day, session }]. */
function savedSessions(dir) {
  const out = [];
  for (const day of savedDays(dir, CHECKS_SUB).reverse()) {
    const f = readDay(dir, day);
    for (const s of f?.sessions ?? []) if (s && typeof s.key === 'string') out.push({ day, session: s });
  }
  return out;
}

/**
 * findSaved(dir, text) -> { key, day } | { matches: [key...] } | { none: true }
 * A saved session by its key, the start of its key (SAVED_PREFIX_MIN characters or more), or
 * its log's own full id (matched by hash, since the id itself is never saved).
 */
export function findSaved(dir, text) {
  const want = String(text ?? '').trim().toLowerCase();
  if (!want || want.length > 200) return { none: true };
  const all = savedSessions(dir);
  const byKey = new Map();
  for (const x of all) if (!byKey.has(x.session.key)) byKey.set(x.session.key, x.day);
  if (byKey.has(want)) return { key: want, day: byKey.get(want) };
  const hash = idHashOf(want);
  const byId = all.find((x) => x.session.idHash === hash);
  if (byId) return { key: byId.session.key, day: byId.day };
  if (want.length < SAVED_PREFIX_MIN) return { none: true };
  const keys = [...byKey.keys()].filter((k) => k.startsWith(want)).sort();
  if (keys.length === 1) return { key: keys[0], day: byKey.get(keys[0]) };
  return keys.length ? { matches: keys } : { none: true };
}

/**
 * savedSessionAnswer({ dir, config, roots, key, day }) -> the saved session and its findings,
 * every string redacted again with `config`'s settings, or null when it's no longer saved:
 *   { session, findings, rules, status, savedAt, version, logOnDisk }
 * `status` is each pattern's state in the run that checked this session, or null when that run
 * saved none (a session the checks didn't read).
 * `logOnDisk` is true when one of its log files is still under `roots`, false when none is, and
 * null when it named none.
 */
export function savedSessionAnswer({ dir, config, roots, key, day, onDisk: given = null }) {
  const f = readDay(dir, day);
  const s = f?.sessions.find((x) => x?.key === key);
  if (!s) return null;
  const redactor = createRedactor(config);
  const redact = (x) => redactor.redact(String(x));
  const files = Array.isArray(s.files) ? s.files : [];
  const onDisk = given ?? (files.length ? logKeys(roots) : null);
  const answer = redactSaved({
    session: s,
    findings: (f.findings ?? []).filter((x) => x?.session === key),
    rules: Array.isArray(f.rules) ? f.rules : [],
    status: Array.isArray(s.status) ? s.status : null,
    savedAt: s.savedAt ?? f.savedAt ?? null,
    version: s.version ?? f.version ?? null,
  }, redact);
  return { ...answer, logOnDisk: files.length ? files.some((k) => onDisk.has(k)) : null };
}


/**
 * countsFromSaved({ dir, from, to, timezone, roots, version }) -> trend counts, or null
 * What trendCounts (lib/problems/index.mjs) gives for a window, worked out from the check results
 * saved for it instead of reading its logs again: the sessions the checks read with a step in it,
 * and each pattern's findings worth a look whose moment is in it, split into worked out from the
 * log and possible, each with its weakest evidence word. Null, so the window is read instead, when
 * a day of it was never saved, or a session in it whose log is still on disk was saved by another
 * honestweek version (its log is read with this one's rules).
 */
export function countsFromSaved({ dir, from, to, timezone, roots, version }) {
  const days = [];
  for (let day = from; day <= to; day = nextDay(day)) days.push(day);
  if (!days.every((day) => readDay(dir, day))) return null;
  const inRange = (day) => day >= from && day <= to;
  const sessions = new Map();
  const findings = [];
  // A session that started up to a week before can still have steps in the window.
  for (let day = nextDayBy(from, -7); day <= to; day = nextDay(day)) {
    const f = readDay(dir, day);
    if (!f) continue;
    for (const s of f.sessions) {
      if (!s?.checked || sessions.has(s.key) || !(Array.isArray(s.days) && s.days.some(inRange))) continue;
      sessions.set(s.key, s);
    }
    for (const x of f.findings) if (x && sessions.has(x.session)) findings.push(x);
  }
  let onDisk = null;
  for (const s of sessions.values()) {
    if (s.version === version) continue;
    onDisk ??= logKeys(roots);
    if ((s.files ?? []).some((k) => onDisk.has(k))) return null;
  }
  const ranOf = new Map();
  for (const s of sessions.values()) {
    for (const x of Array.isArray(s.status) ? s.status : []) {
      const r = ranOf.get(x.id) ?? { ran: false, levels: [] };
      if (x.status === 'found' || x.status === 'clear') r.ran = true;
      if (x.level) r.levels.push(x.level);
      ranOf.set(x.id, r);
    }
  }
  const looks = findings.filter((x) => x.severity === 'look' && x.at && inRange(localDay(Date.parse(x.at), timezone)));
  const patterns = {};
  for (const [id, r] of ranOf) {
    const mine = looks.filter((x) => x.pattern === id);
    const sure = mine.filter(isSure);
    const possible = mine.filter((x) => !isSure(x));
    patterns[id] = {
      ran: r.ran,
      sure: { value: sure.length, evidence: sure.length ? weakest(sure.map((x) => x.verdictEvidence)) : 'derived' },
      possible: { value: possible.length, evidence: possible.length ? weakest(possible.map((x) => x.verdictEvidence)) : weakest(r.levels) },
    };
  }
  return { sessions: sessions.size, patterns };
}

const nextDayBy = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
