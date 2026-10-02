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

export function clip(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
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

/** Record types whose timestamps are written out of band: they never set a source's
 *  clock or span (measured: stamped minutes to days after the records around them). */
export const OUT_OF_BAND_TYPES = new Set(['pr-link', 'queue-operation', 'file-history-snapshot', 'file-history-delta']);
