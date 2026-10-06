// lib/replay/evidence.mjs — the four evidence levels and the event contract.
//
// The engine's one promise: every statement it can make about past work says how it
// knows. A field is one of
//
//   recorded  a record on disk says this directly (a timestamp, a tool name, an exit
//             flag, a git commit), and the event carries a reference to that record;
//   derived   computed only from recorded values, with no interpretation (the time
//             between two recorded timestamps, lines added in a recorded patch, a
//             test count parsed from recorded output);
//   inferred  an interpretation a named rule produced and could get wrong (calling a
//             prompt a correction, a command a test run, two sessions a hand-off);
//   missing   evidence the engine expected and did not find (a tool call with no
//             recorded result, a sub-agent with no transcript).
//
// An event keeps those apart structurally: `facts`, `derived`, `inferred` (each with
// its rule id), and `missing`. Nothing reaches a view by any other path.

export const EVIDENCE = Object.freeze({
  RECORDED: 'recorded',
  DERIVED: 'derived',
  INFERRED: 'inferred',
  MISSING: 'missing',
});

/** Every event kind the engine emits. A new kind is added here first. */
export const EVENT_KINDS = Object.freeze([
  'session', // a session's first recorded record (span bounds live on the session)
  'prompt', // a person's message to an agent
  'notice', // a harness note attached to a person's action, with no typed text
  'command', // a slash command: a person's, or a program's when its record says a program sent it
  'interrupt', // a run stopped early: by the person, by a session ending, or aborted
  'queue', // a message typed while the agent was busy: queued, delivered, absorbed
  'message', // an agent's text to the person (or, in a sub-agent, to its parent)
  'update', // an agent's progress update between tool calls, read from a thinking block by its position (inferred; only with the `updates` option)
  'action', // a recorded tool call, with its recorded result when there is one
  'delegation-received', // the instruction a sub-agent, a child thread, or a run a program started was started with
  'agent-message', // a message between agents or sessions
  'notification', // the harness reporting a background task or agent finished
  'decision', // a person answered a recorded question or ruled on a plan
  'guard', // a policy, hook, or permission rule refused or annotated an action
  'hook', // a hook ran
  'turn-end', // the harness recorded the end of a turn
  'error', // an API or harness error was recorded
  'compaction', // the context was compacted
  'mode', // a recorded mode, cwd, worktree, or permission change
  'link', // a recorded association with a pull request
  'external-edit', // the harness noticed a file change it did not make
  'outcome', // git's own record: a commit exists, landed, or a pull request merged
  'quiet', // no record in this session for an interval (derived, never "idle")
]);

const KIND_SET = new Set(EVENT_KINDS);
const LEVELS = new Set(Object.values(EVIDENCE));

/**
 * Throw if an event breaks the contract. Run on every event before a history is
 * returned, so a parser bug surfaces as a failure instead of an unsupported claim.
 */
export function assertEventContract(e, rules) {
  const where = `event ${e?.id ?? '(no id)'}`;
  if (!e || typeof e.id !== 'string' || !e.id) throw new Error(`${where}: no id`);
  if (!KIND_SET.has(e.kind)) throw new Error(`${where}: unknown kind "${e.kind}"`);
  if (!LEVELS.has(e.evidence)) throw new Error(`${where}: unknown evidence level "${e.evidence}"`);
  if (!Array.isArray(e.refs) || (e.refs.length === 0 && e.evidence !== EVIDENCE.DERIVED)) {
    throw new Error(`${where}: no evidence reference`);
  }
  if (e.evidence === EVIDENCE.DERIVED && e.refs.length === 0 && !(Array.isArray(e.basis) && e.basis.length)) {
    throw new Error(`${where}: a derived event must name the events it was derived from`);
  }
  if (!Number.isFinite(e.t)) throw new Error(`${where}: no position on the time axis`);
  for (const inf of e.inferred ?? []) {
    if (!inf || typeof inf.rule !== 'string' || !rules.has(inf.rule)) {
      throw new Error(`${where}: inference "${inf?.key}" names no registered rule`);
    }
  }
  if (!Array.isArray(e.missing)) throw new Error(`${where}: missing must be a list`);
}
