// lib/replay/metrics.mjs — one definition per counted thing.
//
// The overview's summaries and the timeline's running state count the same things.
// Each is defined once here, as a test on one event, and both call it, so the two
// can never drift apart.

/** A step that was asked for but never ran: the person rejected it, a rule refused
 *  it, or the run was interrupted before a result was written. */
const DID_NOT_RUN = new Set(['rejected', 'refused', 'interrupted']);

/** The test run an event records, if it ran: 'passed', 'failed', 'unclear',
 *  'no-summary', or null (not a test run, no result yet, or it never ran). 'failed'
 *  means the summary shows a failed test or a test file or suite that failed to load.
 *  'unclear' is a clean summary from a command that failed: the failure may be the
 *  runner's own (a coverage gate, a crash after the summary) or another command's,
 *  and the record doesn't say which. 'passed' is a clean summary from a command that
 *  succeeded. */
export function testRunResult(e) {
  if (e.kind !== 'action' || !e.facts.testRunner || !e.end || DID_NOT_RUN.has(e.facts.result)) return null;
  const s = e.derived.tests;
  if (!s) return 'no-summary';
  if (s.fail > 0 || s.suitesFailed > 0) return 'failed';
  return e.facts.result === 'error' ? 'unclear' : 'passed';
}

/** An edit whose recorded result is a success. */
export function isSuccessfulEdit(e) {
  return e.kind === 'action' && e.facts.category === 'edit' && e.facts.result === 'ok';
}

/** The files an edit touched, as path join keys: one for a Claude Code edit, every
 *  file a Codex patch names. */
export function editedFileKeys(e) {
  return e.facts.fileKeys ?? (e.facts.fileKey ? [e.facts.fileKey] : []);
}

/** The rules that say a prompt's author is a person, when that is an inference. */
export function authorshipRules(e) {
  return e.kind === 'prompt' ? e.inferred.filter((x) => x.key === 'authorship').map((x) => x.rule) : [];
}

/** The labels a named rule put on a person's prompt. */
export function promptLabels(e) {
  return e.kind === 'prompt' ? e.inferred.filter((x) => x.key === 'intent').map((x) => x.value) : [];
}

export const isCommitFound = (e) => e.kind === 'outcome' && e.facts.outcome === 'commit-exists';
export const isCommitByConfiguredIdentity = (e) => isCommitFound(e) && e.facts.authoredByConfiguredIdentity === true;
export const isPrLanded = (e) => e.kind === 'outcome' && e.facts.outcome === 'pr-landed';
export const isDelegation = (e) => e.kind === 'action' && e.facts.category === 'delegate';
