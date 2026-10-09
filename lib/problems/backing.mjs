// lib/problems/backing.mjs: which check, if any, backs a claim an agent made.
//
// The review brief pairs each claim ("done", "tests pass") with the check its log records
// behind it, or names the gap. It must decide that the same way the Problems checks do, so
// this reuses their pieces: a check step is what problems.check-step reads as one, and the
// gap is split by afterStep exactly as the done-claim check splits "No check after it" (only
// reads and searches with no hook record, the same in a Codex session where hooks aren't
// logged, or other steps). test/review-backing.test.mjs holds the two to the same answer on
// every turn the done-claim and claim-against-evidence checks look at.

import { BUILD_CHECKS } from './classify.mjs';
import { afterStep, HOOKS_UNLOGGED, isCheckStep, runnableEdit } from './checks.mjs';

/** A check with a clear result: a test run that passed or failed, or a build, lint or type
 *  check that finished or recorded an error (the claim-against-evidence check's reading). */
export const isClearCheck = (s) => s.result !== 'refused' && (s.test === 'passed' || s.test === 'failed' || (BUILD_CHECKS.has(s.check) && (s.result === 'ok' || s.result === 'error')));
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

/** The wording of "No check after it" for each gap, as the done-claim check writes it. */
const GAP_BASIS = {
  quiet: { level: 'derived', how: 'After the last edit the log records only file reads and searches, and no hook.' },
  'hooks-unlogged': { level: 'inferred', how: `After the last edit the log records only file reads and searches. ${HOOKS_UNLOGGED}` },
  'other-steps': { level: 'inferred', how: 'Other steps ran after the last edit; a rule (problems.check-step) reads none of them as a check.' },
  'other-folder': { level: 'inferred', how: "A check ran after the last edit, but in a folder that isn't on this change's branch, so it didn't test this change." },
};

/**
 * backingCheck(c, { steps, events, session, after, before, folderOk }) ->
 *   { status: 'checked', check, result, failed, level, how }
 *   { status: 'delegated', step, level, how }
 *   { status: 'gap', gap: 'quiet' | 'hooks-unlogged' | 'other-steps' | 'other-folder', check?, level, how }
 *
 * c: the problems context (context.mjs). steps: the steps to look through, in order (a turn's,
 * or a pull request's in-scope steps). events: the events they sit among, for the hook records
 * afterStep reads (a turn's events). session: their session's key. after: the step the check
 * has to follow (the last edit; null for the first step on). before: the claim's place (a
 * `seq`, exclusive), or null for the end. folderOk(step): whether a check ran in a folder on
 * the right branch; a check it refuses is a named gap, never backing.
 *
 * The order of the answers is the done-claim check's: a sub-agent started after the edit comes
 * first (it may have checked), then the latest check, then the gap. `result` is the check's
 * own: 'passed' or 'failed' for a test run, 'ok' or 'error' for anything else, null when the
 * log didn't say. `failed` is the latest clear check's verdict (a later unclear check, a review
 * skill say, doesn't hide an earlier failed test run), and `clear` that check; both are null
 * when no check was clear. Every answer carries them, so a caller can ask both questions.
 */
export function backingCheck(c, { steps, events = [], session, after = null, before = null, folderOk = null }) {
  const list = Array.isArray(steps) ? steps : [];
  const start = after ? list.indexOf(after) + 1 : 0;
  const rest = list.slice(start).filter((s) => before == null || s.seq < before);
  const checks = rest.filter(isCheckStep);
  const here = folderOk ? checks.filter((s) => folderOk(s)) : checks;
  const clear = here.filter(isClearCheck).at(-1) ?? null;
  const verdict = { clear, failed: clear ? failedOf(clear) : null };
  const delegated = rest.find((s) => s.cat === 'delegate');
  if (delegated) return { status: 'delegated', step: delegated, ...verdict, level: 'inferred', how: 'A sub-agent started after the last edit, and it may have run a check this log shows only in its own steps.' };
  if (here.length) return { status: 'checked', check: here.at(-1), result: resultOf(here.at(-1)), ...verdict, level: 'recorded', how: 'The log records this check after the last edit.' };
  if (checks.length) return { status: 'gap', gap: 'other-folder', check: checks.at(-1), ...verdict, ...GAP_BASIS['other-folder'] };
  // With no edit to start from, the quiet test reads every event given, from the first on.
  const turn = after ? { prompt: { session }, events } : { prompt: { session }, events: [{ id: FROM_START }, ...events] };
  const kind = afterStep(c, turn, after ?? { ev: FROM_START }, rest);
  const gap = kind === 'quiet' ? 'quiet' : kind === 'hooks-unlogged' ? 'hooks-unlogged' : 'other-steps';
  return { status: 'gap', gap, ...verdict, ...GAP_BASIS[gap] };
}
const FROM_START = Symbol('from-start');
