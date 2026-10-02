// lib/replay/metrics.mjs — one definition per counted thing.
//
// The overview's summaries and the timeline's running state count the same things.
// Each is defined once here, as a test on one event, and both call it, so the two
// can never drift apart.

/** A step that was asked for but never ran: the person rejected it, a rule refused
 *  it, or the run was interrupted before a result was written. */
const DID_NOT_RUN = new Set(['rejected', 'refused', 'interrupted']);

/** The test run an event records, if it ran: 'passed', 'failed', 'no-summary', or null
 *  (not a test run, no result yet, or it never ran). */
export function testRunResult(e) {
  if (e.kind !== 'action' || !e.facts.testRunner || !e.end || DID_NOT_RUN.has(e.facts.result)) return null;
  const s = e.derived.tests;
  if (!s) return 'no-summary';
  return s.fail > 0 ? 'failed' : 'passed';
}

/** An edit whose recorded result is a success. */
export function isSuccessfulEdit(e) {
  return e.kind === 'action' && e.facts.category === 'edit' && e.facts.result === 'ok';
}

/** The labels a named rule put on a person's prompt. */
export function promptLabels(e) {
  return e.kind === 'prompt' ? e.inferred.filter((x) => x.key === 'intent').map((x) => x.value) : [];
}

export const isCommitFound = (e) => e.kind === 'outcome' && e.facts.outcome === 'commit-exists';
export const isCommitByConfiguredIdentity = (e) => isCommitFound(e) && e.facts.authoredByConfiguredIdentity === true;
export const isPrLanded = (e) => e.kind === 'outcome' && e.facts.outcome === 'pr-landed';
export const isDelegation = (e) => e.kind === 'action' && e.facts.category === 'delegate';
