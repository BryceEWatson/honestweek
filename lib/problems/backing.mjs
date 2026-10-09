// lib/problems/backing.mjs: which check, if any, backs a claim an agent made.
//
// The review brief pairs each claim ("done", "tests pass") with the check its log records
// behind it, or names the gap. It must decide that the same way the Problems checks do, so
// this reuses their pieces: a check step is what problems.check-step reads as one, and the
// gap is split by afterStep and worded exactly as the done-claim check's "No check after it"
// (NO_CHECK_BASIS: only reads and searches with no hook record, the same in a Codex session
// where hooks aren't logged, or other steps), and a clear check is the claim-against-evidence
// check's isClearCheck. test/review-backing.test.mjs holds the two to the same answer on
// every turn the done-claim and claim-against-evidence checks look at.

import { afterStep, HOOKS_UNLOGGED, isCheckStep, isClearCheck, NO_CHECK_BASIS, runnableEdit } from './checks.mjs';

export { isClearCheck };
const resultOf = (s) => s.test ?? (s.result === 'ok' || s.result === 'error' ? s.result : null);
const failedOf = (s) => (s.test ? s.test === 'failed' : s.result === 'error');

/** The last successful edit to a code or test file among `steps` that came before `before`
 *  (a step's `seq`, exclusive; all of them when it's null), or null. */
export function lastEditBefore(steps, before = null) {
  let last = null;
  for (const s of steps) {
    if (before != null && !(s.seq < before)) break;
    if (runnableEdit(s)) last = s;
  }
  return last;
}

/** The wording of each answer. After an edit, a gap is the done-claim check's "No check after
 *  it" word for word (NO_CHECK_BASIS); with no edit to start from, nothing names one. */
const WORDS = {
  edit: {
    delegated: 'A sub-agent started after the last edit, and it may have run a check this log shows only in its own steps.',
    checked: 'The log records this step after the last edit, and a rule (problems.check-step) reads it as a check.',
    gaps: { ...NO_CHECK_BASIS, 'other-folder': { level: 'inferred', how: "A check ran after the last edit, but in a folder that isn't on this change's branch, so the log doesn't show it tested this change." } },
  },
  start: {
    delegated: 'A sub-agent started, and it may have run a check this log shows only in its own steps.',
    checked: 'The log records this step, and a rule (problems.check-step) reads it as a check.',
    gaps: {
      quiet: { level: 'derived', how: 'The log records only file reads and searches, and no hook.' },
      'hooks-unlogged': { level: 'inferred', how: `The log records only file reads and searches. ${HOOKS_UNLOGGED}` },
      'other-steps': { level: 'inferred', how: 'Steps ran; a rule (problems.check-step) reads none of them as a check.' },
      'other-folder': { level: 'inferred', how: "A check ran, but in a folder that isn't on this change's branch, so the log doesn't show it tested this change." },
    },
  },
};

/**
 * backingCheck(c, { steps, events, session, after, before, folderOk }) ->
 *   { status: 'checked', check, result, clear, failed, level, how }
 *   { status: 'delegated', step, clear, failed, level, how }
 *   { status: 'gap', gap: 'quiet' | 'hooks-unlogged' | 'other-steps' | 'other-folder', check?, clear, failed, level, how }
 *
 * c: the problems context (context.mjs). steps: the steps to look through, in order (a turn's,
 * or a pull request's in-scope steps). events: the events they sit among, for the hook records
 * afterStep reads (a turn's events); left out, no hook record can be ruled out, so a gap is
 * never 'quiet'. session: their session's key. after: the step the check has to follow (the
 * last edit, one of `steps`; null for the first step on). before: the claim's place (a `seq`,
 * exclusive), or null for the end; `after` must come before it. folderOk(step): whether a check
 * ran in a folder on the right branch; a check it refuses is a named gap, never backing.
 *
 * The order of the answers is the done-claim check's: a sub-agent started after the edit comes
 * first (it may have checked), then the latest check, then the gap. `result` is the check's
 * own: 'passed' or 'failed' for a test run, 'ok' or 'error' for anything else, null when the
 * log didn't say. `clear` and `failed` are the claim-against-evidence check's reading: the
 * latest check with a clear result anywhere in `steps` before the claim (not only after the
 * edit, and a later unclear check, a review skill say, doesn't hide an earlier failed test
 * run), and its verdict; both are null when no check was clear. Every answer carries them, so
 * one call answers both questions.
 */
export function backingCheck(c, { steps, events = null, session, after = null, before = null, folderOk = null }) {
  const list = Array.isArray(steps) ? steps : [];
  const start = after ? list.indexOf(after) + 1 : 0;
  if (after && start === 0) throw new Error('backingCheck: `after` is not one of `steps`');
  if (after && before != null && !(after.seq < before)) throw new Error('backingCheck: `after` comes after the claim');
  const inScope = (s) => before == null || s.seq < before;
  const inFolder = (s) => !folderOk || folderOk(s);
  const rest = list.slice(start).filter(inScope);
  const checks = rest.filter(isCheckStep);
  const here = checks.filter(inFolder);
  const clear = list.filter((s) => inScope(s) && isClearCheck(s) && inFolder(s)).at(-1) ?? null;
  const verdict = { clear, failed: clear ? failedOf(clear) : null };
  const words = WORDS[after ? 'edit' : 'start'];
  const delegated = rest.find((s) => s.cat === 'delegate');
  if (delegated) return { status: 'delegated', step: delegated, ...verdict, level: 'inferred', how: words.delegated };
  if (here.length) return { status: 'checked', check: here.at(-1), result: resultOf(here.at(-1)), ...verdict, level: 'inferred', how: words.checked };
  if (checks.length) return { status: 'gap', gap: 'other-folder', check: checks.at(-1), ...verdict, ...words.gaps['other-folder'] };
  // With no edit to start from, the quiet test reads every event given, from the first on.
  const evs = Array.isArray(events) ? events : [];
  const turn = { prompt: { session }, events: after || !Array.isArray(events) ? evs : [{ id: FROM_START }, ...evs] };
  const kind = afterStep(c, turn, after ?? { ev: FROM_START }, rest);
  const gap = kind === 'quiet' ? 'quiet' : kind === 'hooks-unlogged' ? 'hooks-unlogged' : 'other-steps';
  return { status: 'gap', gap, ...verdict, ...words.gaps[gap] };
}
const FROM_START = Symbol('from-start');
