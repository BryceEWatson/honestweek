// lib/replay/parse-common.mjs — what the Claude Code and Codex adapters share.
//
// Both adapters read one file in order and build events the same way; only the
// record shapes differ. The shared parts live here so the event contract (time
// backfill, the missing-result rule, how a shell command is interpreted, what a
// command's printed output can nominate) has one definition.

import { letterHash } from './ids.mjs';
import { EVIDENCE } from './evidence.mjs';
import { commitSummaryShas, headShaAfterCommit, isGitCommitCommand, isRevertCommand, prUrlsInOutput, testRunner } from './classify.mjs';

/** Longest excerpt kept, by field. */
export const LIMITS = Object.freeze({ prompt: 600, text: 400, command: 300, short: 160 });

/** Whitespace runs made one space, ends trimmed: how the engine reads a value's words. */
export function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// A placeholder the redactor sets down, such as [redacted:term].
const PLACEHOLDER_G = /\[redacted:[a-z]+\]/g;

/** Where to cut text the redactor has already read: at `max`, or, when `max` falls
 *  inside a placeholder, at the placeholder's start, so a cut never splits one. */
export function placeholderSafeEnd(s, max) {
  if (s.length <= max) return s.length;
  for (const m of s.matchAll(PLACEHOLDER_G)) {
    if (m.index >= max) break;
    if (m.index + m[0].length > max) return m.index;
  }
  return max;
}

/**
 * redactThenCut(text, max, redact, { trim, ending, whole }) -> string
 *
 * Text cut first and redacted after loses the end of a private word that straddles the
 * cut, so the redactor no longer knows it and its start shows. Here the whole text is
 * redacted first (`whole`, by default `redact(text)`), and what's returned is never more
 * than a start of that redaction:
 *   - text no longer than `max` is the whole redaction;
 *   - longer text keeps the piece the engine always showed (cut, then redacted) when the
 *     whole redaction reads the same up to the cut, so text with nothing hidden across
 *     the cut shows exactly as before;
 *   - and when it doesn't, the whole redaction is cut at `max`, stepped back to before any
 *     placeholder the cut would split.
 * `trim` drops spaces before the cut; `ending(n)` marks the cut, given how many characters
 * are left out.
 */
export function redactThenCut(text, max, redact, { trim = false, ending = () => '…', whole = redact(text) } = {}) {
  if (text.length <= max) return whole;
  const head = (s, n) => (trim ? s.slice(0, n).trimEnd() : s.slice(0, n));
  const end = ending(text.length - max);
  const piece = redact(`${head(text, max)}${end}`);
  const shown = piece.endsWith(end) ? piece.slice(0, piece.length - end.length) : piece;
  if (whole.startsWith(shown)) return piece;
  if (whole.length <= max) return whole;
  const at = placeholderSafeEnd(whole, max);
  return `${head(whole, at)}${ending(whole.length - at)}`;
}

/** An excerpt of a record's text as the engine keeps it: whitespace collapsed (so a
 *  value on the line after its label reads as one line, where the redactor's field
 *  rules see it), then redacted, then cut to `max` (redactThenCut). Null for no text. */
export function redactClip(s, max, redact) {
  if (typeof s !== 'string') return null;
  const t = collapse(s);
  if (!t) return null;
  return redactThenCut(t, max, redact, { trim: true, ending: () => '…' });
}

/** The first line of a text, as an excerpt: the whole text is redacted before its first
 *  line is taken, so a name broken across the line break is still found and hidden. */
export function redactClipFirstLine(s, max, redact) {
  if (typeof s !== 'string') return null;
  return redactClip(redact(s).split(/\r?\n/)[0], max, redact);
}

/** A join key for a prompt's text (whitespace-insensitive), never the text itself. */
export function promptDigest(text) {
  return letterHash(String(text ?? '').replace(/\s+/g, ' ').trim(), 16);
}

/** What a shell command line is, by the named rules: its test runner, and whether it
 *  reverses work. Returns { testRunner, inferred }. */
export function shellInterpretation(command) {
  const inferred = [];
  const runner = testRunner(command);
  if (runner) inferred.push({ key: 'step', value: 'test-run', rule: 'shell.test' });
  if (isRevertCommand(command)) inferred.push({ key: 'step', value: 'revert-or-discard', rule: 'shell.revert' });
  return { testRunner: runner, inferred };
}

/**
 * Commits and pull requests a shell command's printed output names, for git to check.
 * Used only when the harness recorded no git operation itself, so each is inferred,
 * and only when the command's recorded result was a success.
 */
export function outputNominations(command, output, event) {
  const commits = [];
  const prs = [];
  if (event.facts?.result === 'error') return { commits, prs };
  if (isGitCommitCommand(command)) {
    const summary = commitSummaryShas(output);
    const head = summary.length ? null : headShaAfterCommit(command, output);
    for (const sha of head ? [head] : summary) {
      event.inferred.push({ key: 'commitNominated', value: sha, rule: 'shell.git-commit-output' });
      commits.push({ sha, kind: 'nominated', event, evidence: EVIDENCE.INFERRED, rule: 'shell.git-commit-output' });
    }
  }
  for (const pr of prUrlsInOutput(command, output)) {
    event.inferred.push({ key: 'prNominated', value: pr.number, rule: 'shell.gh-pr-output' });
    prs.push({ repo: pr.repo, number: pr.number, action: 'created', event, evidence: EVIDENCE.INFERRED, rule: 'shell.gh-pr-output' });
  }
  return { commits, prs };
}

/**
 * Close out one parsed file: a call with no recorded result says so, and records that
 * came before the file's first timestamp sit at that timestamp rather than time zero.
 */
export function finishSource(events, calls, firstAt) {
  for (const e of calls.values()) if (!e.end && !e.missing.includes('result')) e.missing.push('result');
  const firstT = firstAt ? Date.parse(firstAt) : null;
  for (const e of events) {
    if (e.timeFrom === 'none' && firstT != null) {
      e.t = firstT;
      e.timeFrom = 'next-record';
    }
  }
}

// ---------------------------------------------------------------------------
// Goal membership watch list
// ---------------------------------------------------------------------------

const ID_CHAR = 'A-Za-z0-9_-';
// A run of id characters, where a dot followed by a letter or digit is part of the run:
// "g.1.2" and "x.g-1" are each one id, while the dot ending "see g-1." is not.
const ID_RUN_RE = new RegExp(`[${ID_CHAR}]+(?:\\.[A-Za-z0-9][${ID_CHAR}]*)*`, 'g');
const SIMPLE_ID_RE = new RegExp(`^[${ID_CHAR}]+$`);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher for whole ids: an id counts only when the characters on each side can't
 *  be part of an id, so "g-1" is not found inside "g-12", "xg-1" or "g-1.2", and "g.1"
 *  is not found inside "g.1.2". */
function idMatcher(ids) {
  const list = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x.length > 0))];
  if (!list.length) return null;
  const simple = new Set(list.filter((x) => SIMPLE_ID_RE.test(x)));
  const other = list.filter((x) => !SIMPLE_ID_RE.test(x)).map((id) => [id, new RegExp(`(?<![${ID_CHAR}])(?<![${ID_CHAR}]\\.)${escapeRe(id)}(?![${ID_CHAR}])(?!\\.[A-Za-z0-9])`)]);
  return (text, hits) => {
    if (typeof text !== 'string' || !text) return;
    if (simple.size) for (const m of text.matchAll(ID_RUN_RE)) if (simple.has(m[0])) hits.add(m[0]);
    for (const [id, re] of other) if (text.includes(id) && re.test(text)) hits.add(id);
  };
}

/** Every string inside a value (object keys too), depth-limited. Matching runs on each
 *  string itself rather than on JSON text, where an escape such as \n would glue a
 *  letter to the front of an id. */
function eachString(value, fn, depth = 0) {
  if (depth > 20 || value == null) return;
  if (typeof value === 'string') fn(value);
  else if (Array.isArray(value)) for (const v of value) eachString(v, fn, depth + 1);
  else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      fn(k);
      eachString(v, fn, depth + 1);
    }
  }
}

/**
 * createWatch({ entryIds, goalIds }) -> { inCall(input) -> [id], inPrompt(text) -> [id] } | null
 *
 * The parse-time scan for goal membership. The engine keeps only a clipped copy of a
 * prompt or a command, so ids are looked for here, in the full text, while the record
 * is parsed: goal-record entry ids in a tool call's full input (never its result), and
 * goal ids in a prompt's full text. Null when nothing is watched, so no scan runs.
 */
export function createWatch({ entryIds = [], goalIds = [] } = {}) {
  const entries = idMatcher(entryIds);
  const goals = idMatcher(goalIds);
  if (!entries && !goals) return null;
  const sorted = (set) => [...set].sort();
  return {
    inCall(input) {
      if (!entries) return [];
      const hits = new Set();
      eachString(input, (s) => entries(s, hits));
      return sorted(hits);
    },
    inPrompt(text) {
      if (!goals) return [];
      const hits = new Set();
      goals(text, hits);
      return sorted(hits);
    },
  };
}

/** Record types whose timestamps are written out of band: they never set a source's
 *  clock or span (measured: stamped minutes to days after the records around them). */
export const OUT_OF_BAND_TYPES = new Set(['pr-link', 'queue-operation', 'file-history-snapshot', 'file-history-delta']);
