// lib/site/sessions.mjs — the interactive-session hero deriver (session-derived).
//
// honestweek's git verify-or-abort proves what was COMMITTED. The session hero —
// "interactive coding sessions per day" — is a different, weaker evidence class:
// it is counted from the local agent session logs, NOT git-commit-verified. This
// module derives that count deterministically and labels it `session-derived` so
// the provenance never overstates it as a git fact.
//
// To make honestweek a faithful generator of an existing site's hero, the
// interactive-vs-automated classification + resume-dedup MUST match the target's
// own counting (a different rule would yield a different number than the live
// page). The rules below are GENERIC heuristics about what an interactive human
// prompt looks like — they name no target site, repo, or field, so the module
// stays clean-room:
//   - a session is INTERACTIVE iff its first human prompt is a real prompt, not
//     an automated operator probe, a system/command wrapper, or an agent
//     system-prompt;
//   - a RESUMED session (a new log file replaying the same first prompt at the
//     same instant) is counted once, deduped by that first-prompt timestamp;
//   - a session is counted on the local calendar day its first prompt was sent.
//
// Counts are deterministic (reproducible from the on-disk logs, not authored), so
// they are eligible to be verified numbers — but the section is tagged
// `session-derived`, never git-commit-verified. Be honest about WHAT is counted:
// a session-LOG-FILE classified interactive is a PROXY for a human work session,
// not an exact count of one. The classifier + exact-timestamp dedup have known
// two-sided error (a false-positive classification or a fresh-timestamp resume
// overcounts; a timestamp collision or an unreadable head undercounts). The error
// is surfaced, not hidden, in the emitted filesFound/filesScanned/automatedExcluded/
// undetermined/duplicatesSkipped diagnostics — an adapter should not render the
// headline total as an exact, verified session count. `filesFound` (the raw count of
// logs enumerated under the resolved root, before any filter) is the "did the root
// yield anything at all" signal: 0 means no logs were found (e.g. building off the
// local machine / a wrong CLAUDE_CONFIG_DIR), which the build surfaces as a warning.
//
// Zero runtime dependencies: Node built-ins only.

import { statSync } from 'node:fs';

import { enumerateSessionFiles, resolveProjectsRoot, readHead } from '../claude-adapter.mjs';
import { localDateInTimezone } from '../resolve-week.mjs';
import { weekGrid } from './week-grid.mjs';

const MTIME_SLACK_MS = 36 * 3600 * 1000; // coarse pre-filter slack for tz skew

// Sessions whose CWD is under the OS temp location are ephemeral capability/tooling
// probes, not interactive coding work — exclude them so the hero counts real
// sessions. The ENCODED project-dir name embeds the cwd (path separators -> "-"),
// so a temp cwd shows as "...-AppData-Local-Temp-..." here. Matched against the
// encoded-dir NAME only (not the session file's own location, which may itself sit
// under a temp dir in tests).
const EPHEMERAL_DIR_RE = /AppData-Local-Temp|(?:^|-)te?mp-/i;

/** The encoded project-dir name a session file lives under (its parent dir). */
function projectDirName(file) {
  const parts = file.replace(/\\/g, '/').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/**
 * Is `text` a real interactive human prompt (vs. an automated/agent/system turn)?
 * Generic, target-agnostic heuristics; errs toward EXCLUDING a turn that looks
 * machine-generated, so an automated run is never counted as interactive work.
 */
export function isInteractiveFirstPrompt(text) {
  if (!text) return false;
  let t = String(text).trim();
  // A leading injected system-reminder is harness scaffolding — look past it.
  t = t.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/i, '').trim();
  if (!t) return false;
  if (/^Project(\s+state)?\s*:/i.test(t)) return false; // automated operator probe
  if (/^<(system-reminder|command-|task-notification|local-command)/i.test(t)) return false; // wrapper turn
  if (/^(You are|Your task|<task>|You will be|ROLE:)/i.test(t)) return false; // agent system-prompt
  return true;
}

/** Stringify a user record's message content (string, or an array of text parts). */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((x) => (typeof x === 'string' ? x : x && typeof x.text === 'string' ? x.text : '')).join(' ');
  }
  return '';
}

/**
 * Read ONLY the head of a session log and return the first human turn's
 * { text, timestamp } plus the session cwd — never any deeper content. Returns
 * null when no first user record is found in the head. Reuses the main adapter's
 * bounded-head reader (readHead), so the head discipline has one implementation
 * (a late prompt beyond the head is not seen).
 */
export function firstUserMessage(file, maxBytes) {
  const { lines } = readHead(file, maxBytes);
  let cwd = null;
  for (const ln of lines) {
    let o;
    try {
      o = JSON.parse(ln);
    } catch {
      continue; // a malformed or head-truncated line is skipped
    }
    if (cwd == null && typeof o.cwd === 'string') cwd = o.cwd;
    if (o.type === 'user' && o.message && o.message.role === 'user') {
      return { text: contentText(o.message.content), timestamp: typeof o.timestamp === 'string' ? o.timestamp : null, cwd };
    }
  }
  return null;
}

/** Build a cwd→label resolver from config.repos (clean-room: labels come from the
 *  TARGET's config, never hardcoded here). Returns 'other' for an unconfigured cwd.
 *
 *  Attribution is EXACT: a session counts for the repo it was STARTED IN (its cwd
 *  equals the repo root), not a parent repo of a subdirectory cwd. This is the
 *  honest answer to "which project is this session" for the hero count, and it
 *  deliberately differs from the digest adapter's matchRepo (which prefix-matches a
 *  subdir session to its repo) — a subdir session's project is ambiguous, so the
 *  hero attributes it to 'other' rather than over-crediting the parent repo. */
function labelResolver(config) {
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const byPath = new Map(repos.map((r) => [norm(r.resolvedPath ?? r.path), r.label]).filter(([p]) => p));
  return (cwd) => byPath.get(norm(cwd)) ?? 'other';
}

/**
 * deriveSessions({ config, weekStart, weekEnd, now, projectsRoot? }) -> sessions section
 *
 * Enumerates the local interactive sessions that STARTED within the completed
 * week, deduped by first-prompt timestamp, bucketed per day + per project label.
 * `weekStart`/`weekEnd` are Date objects (from resolveWeek); `now` is the build
 * instant. Returns a generic `sessions` section a target adapter maps onto its
 * own field names. Tagged `provenance: 'session-derived'`.
 */
export function deriveSessions({ config, weekStart, weekEnd, now, projectsRoot } = {}) {
  const tz = config?.week?.timezone || 'UTC';
  const weekStartKey = weekStart.toISOString().slice(0, 10);
  const weekEndKey = weekEnd.toISOString().slice(0, 10);
  const todayKey = localDateInTimezone(now ?? new Date(weekEnd.getTime()), tz).toISOString().slice(0, 10);
  const lowerBoundMs = weekStart.getTime() - MTIME_SLACK_MS;
  const labelFor = labelResolver(config);

  const root = projectsRoot ?? resolveProjectsRoot();
  const files = enumerateSessionFiles(root);

  const seenFirstTs = new Set();
  const perDay = new Map(); // dateKey -> { total, byProject }
  const projectTotals = {};
  let interactiveTotal = 0;
  let automatedExcluded = 0;
  let filesScanned = 0;
  let undetermined = 0;
  let duplicatesSkipped = 0;

  for (const file of files) {
    if (EPHEMERAL_DIR_RE.test(projectDirName(file))) continue; // ephemeral temp/probe session — not real work
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < lowerBoundMs) continue; // too old to start in-window
    filesScanned += 1;

    const fu = firstUserMessage(file);
    if (!fu) {
      undetermined += 1;
      continue;
    }
    if (!isInteractiveFirstPrompt(fu.text)) {
      automatedExcluded += 1;
      continue;
    }
    if (!fu.timestamp) {
      undetermined += 1;
      continue;
    }
    if (seenFirstTs.has(fu.timestamp)) {
      duplicatesSkipped += 1; // resumed session replaying the same first prompt
      continue;
    }
    seenFirstTs.add(fu.timestamp);

    const started = new Date(fu.timestamp);
    if (Number.isNaN(started.getTime())) continue;
    const dateKey = localDateInTimezone(started, tz).toISOString().slice(0, 10);
    if (dateKey < weekStartKey || dateKey > weekEndKey) continue; // started outside the week

    const label = labelFor(fu.cwd);
    if (!perDay.has(dateKey)) perDay.set(dateKey, { total: 0, byProject: {} });
    const bucket = perDay.get(dateKey);
    bucket.total += 1;
    bucket.byProject[label] = (bucket.byProject[label] || 0) + 1;
    projectTotals[label] = (projectTotals[label] || 0) + 1;
    interactiveTotal += 1;
  }

  const days = weekGrid(weekStartKey, todayKey).map((stub) => {
    const b = perDay.get(stub.date) || { total: 0, byProject: {} };
    return { ...stub, total: b.total, byProject: b.byProject };
  });
  const max = days.reduce((m, d) => Math.max(m, d.total), 0);

  return {
    metric: 'interactive-sessions',
    provenance: 'session-derived', // counted from local session logs, NOT git-commit-verified
    windowDays: days.length,
    weekStart: weekStartKey,
    weekEnd: weekEndKey,
    max,
    total: interactiveTotal,
    days,
    projectTotals,
    interactiveTotal,
    automatedExcluded,
    // Raw count of session logs ENUMERATED under the resolved root, before the ephemeral/mtime/interactive
    // filters. The "did the root yield any logs at all" signal: 0 means the root was empty/absent (e.g. a
    // build run off the local machine, or a wrong CLAUDE_CONFIG_DIR), which is distinct from a quiet week
    // (filesScanned/interactiveTotal can be 0 while filesFound > 0). The build warns when this is 0.
    filesFound: files.length,
    filesScanned,
    undetermined,
    duplicatesSkipped,
  };
}
