// lib/codex-records.mjs — who said what in a Codex session log.
//
// Codex has written a person's turn in two shapes, and honestweek's three Codex
// readers (the miner's corpus, the digest's evidence, the prompt collector) must
// understand both or they go blind without erroring:
//
//   legacy : {type:"event_msg", payload:{type:"user_message", message: string}}
//            {type:"event_msg", payload:{type:"agent_message", message: string}}
//   current: {type:"response_item", payload:{type:"message", role:"user",
//                                            content:[{type:"input_text", text}]}}
//            {type:"response_item", payload:{type:"message", role:"assistant",
//                                            content:[{type:"output_text", text}]}}
//
// MEASURED on this machine, 2026-09-23: 3,633 rollout files, none containing a
// legacy `user_message` record. 11,589 current-shape user messages, and most of
// them are not a person: the harness sends its context (environment, AGENTS.md,
// plugin lists) and other agents' hand-offs through the same `role:"user"` slot.
// The first person-typed block ended past byte 76,000 in half the files, past
// 106,000 in 90%, and past 247,000 in 99%, which is why a 64 KB head probe can't
// see it (see CODEX_HEAD_MAX_BYTES).
//
// Two rules, both under-claiming when unsure:
//   - A block that is harness CONTEXT is dropped, and the rest of the message is
//     still read. A person's text can share a message with an injected context block.
//   - A block that marks the whole message as MACHINE-AUTHORED (another agent's
//     delegation, a heartbeat, an automation, the approval reviewer's packet)
//     rejects the message, because the text around it was written by that machine.
//
// Older Codex builds wrote BOTH shapes for one turn. `createCodexTurnReader`
// drops the second copy so a turn is never counted twice.
//
// `response_item` records of type `agent_message` are messages BETWEEN agents
// (a subagent reporting to its root), not the assistant talking to the person,
// so they are deliberately not read as assistant text.
//
// Zero runtime dependencies: Node built-ins only.

/** Largest head a Codex probe reads while looking for the first human turn. Covers
 *  the measured 99th percentile (≈247 KB) with room; a file whose first person-typed
 *  turn sits past this is treated as having none, which under-claims. */
export const CODEX_HEAD_MAX_BYTES = 1024 * 1024;

/** A block that makes the WHOLE message machine-authored. */
const MACHINE_AUTHORED_RE = new RegExp(
  '^(?:' +
    [
      '<(?:codex_delegation|realtime_delegation|heartbeat)\\b',
      '<!--\\s*command:',
      'Automation:',
      '>>> (?:APPROVAL REQUEST|TRANSCRIPT)',
      'The following is the Codex agent history',
      'The Codex agent has requested',
      'Reviewed Codex session id:',
    ].join('|') +
    ')',
  'i',
);

/** A block that is injected context: any leading tag or HTML comment, or the
 *  AGENTS.md preamble. Open-ended on purpose, because a closed list of tag names is
 *  exactly what went stale when Codex added new ones. */
const CONTEXT_BLOCK_RE = /^(?:<[A-Za-z_][\w-]*(?:[\s>/]|$)|<!--|# AGENTS\.md\b)/;

function blockTexts(content, blockType) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === blockType && typeof b.text === 'string').map((b) => b.text);
}

/** The person-typed part of a list of blocks, or null when there is none. */
function personText(blocks) {
  const kept = [];
  for (const raw of blocks) {
    const t = raw.trim();
    if (!t) continue;
    if (MACHINE_AUTHORED_RE.test(t)) return null;
    if (CONTEXT_BLOCK_RE.test(t)) continue;
    kept.push(raw);
  }
  return kept.length ? kept.join('\n') : null;
}

/** The human text of one Codex record, in either shape, or null. Stateless: a
 *  caller reading a whole file wants `createCodexTurnReader` instead. */
export function codexUserText(rec) {
  const p = rec?.payload;
  if (!p || typeof p !== 'object') return null;
  if (rec.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') return personText([p.message]);
  if (rec.type === 'response_item' && p.type === 'message' && p.role === 'user') return personText(blockTexts(p.content, 'input_text'));
  return null;
}

/** The assistant's text to the person in one Codex record, in either shape, or null. */
export function codexAssistantText(rec) {
  const p = rec?.payload;
  if (!p || typeof p !== 'object') return null;
  let text = null;
  if (rec.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') text = p.message;
  else if (rec.type === 'response_item' && p.type === 'message' && p.role === 'assistant') text = blockTexts(p.content, 'output_text').join('\n');
  return text && text.trim() ? text : null;
}

/**
 * A per-file reader that returns { user, assistant } text for each record, with the
 * second copy of a dual-written turn dropped: a record whose text equals the
 * previous accepted one of the same role, written in the OTHER shape, is the same
 * turn. Two identical turns written in the same shape are both kept.
 */
export function createCodexTurnReader() {
  const last = { user: null, assistant: null };
  const shape = (rec) => (rec.type === 'event_msg' ? 'legacy' : 'current');
  const take = (role, rec, text) => {
    if (text == null) return null;
    const prev = last[role];
    const key = text.trim();
    if (prev && prev.key === key && prev.shape !== shape(rec)) {
      last[role] = null;
      return null;
    }
    last[role] = { key, shape: shape(rec) };
    return text;
  };
  return (rec) => ({
    user: take('user', rec, codexUserText(rec)),
    assistant: take('assistant', rec, codexAssistantText(rec)),
  });
}
