// lib/replay/claude.mjs — Claude Code session and sub-agent records -> engine events.
//
// One call parses one file (a session, or one sub-agent transcript) in file order and
// returns its events plus the raw join keys the assembler needs to connect it to other
// files (tool-call ids, sub-agent ids, message ids). Raw ids never enter an event:
// they are UUID- or token-shaped, so the redactor would mangle them, and they are
// joins, not facts a reader needs.
//
// What is deliberately NOT read: `thinking` blocks (private model reasoning), the
// model-written compaction and away summaries, and the harness's context injections
// (reminders, tool listings, instructions). The coverage tally records each one as
// excluded or ignored, so the omission is visible rather than silent.

import { reducePath } from '../claude-adapter.mjs';
import { EVIDENCE } from './evidence.mjs';
import { eventId, pathKey, recordDigest } from './ids.mjs';
import { readJsonlRecords, tryParse } from './jsonl.mjs';
import { exitStatusIsAmbiguous, looksLikeReview, mcpServer, parseTestSummary, promptInferences, toolCategory } from './classify.mjs';
import { clip, finishSource, LIMITS, OUT_OF_BAND_TYPES, outputNominations, promptDigest, shellInterpretation } from './parse-common.mjs';

const PROMPT_MAX = LIMITS.prompt;
const TEXT_MAX = LIMITS.text;
const CMD_MAX = LIMITS.command;
const SHORT = LIMITS.short;

/** Record types that carry no work evidence, with the reason they are skipped. */
export const CLAUDE_IGNORED_TYPES = new Map([
  ['file-history-snapshot', 'editor backup bookkeeping; edits are read from the tool calls'],
  ['file-history-delta', 'editor backup bookkeeping; edits are read from the tool calls'],
  ['last-prompt', 'a pointer to the latest prompt, duplicated by the prompt record itself'],
  ['atis-latch', 'harness internal state'],
  ['bridge-session', 'remote-control connection bookkeeping; carries account identifiers'],
  ['cost-state', 'spend bookkeeping, not work'],
  ['frame-link', 'a desktop pane link, not work'],
  ['artifact-autoreact-ledger', 'artifact comment bookkeeping'],
  ['artifact-comment-monitor', 'artifact comment bookkeeping'],
]);

/** Attachment types that are harness context, not evidence of work. */
const CONTEXT_ATTACHMENTS = new Set([
  'total_tokens_reminder', 'output_style', 'task_reminder', 'deferred_tools_delta', 'skill_listing',
  'batching_reminder_sent', 'deferred_tools_record', 'mcp_instructions_delta', 'agent_listing_delta',
  'todo_reminder', 'prompt_snapshot', 'silent_turn_reminder', 'environment', 'command_permissions',
  'auto_mode', 'date', 'instructions', 'session_context', 'model', 'budget_usd', 'bash_output_audience_note',
  'nested_memory', 'output_style_instructions', 'credential_org', 'ultra_effort_enter', 'ultra_effort_exit',
  'read_truncation_notice', 'date_change', 'file', 'compact_file_reference', 'workflow_keyword_request',
  'invoked_skills', 'thinking_drop', 'structured_output', 'task_status', 'goal_status', 'pdf_reference',
  'inlined_image_paths', 'dynamic_skill', 'directory', 'plan_file_reference', 'remote_session_change',
  'auto_mode_exit',
]);
const HOOK_ATTACHMENTS = new Set(['hook_success', 'hook_non_blocking_error', 'hook_additional_context', 'hook_system_message', 'hook_cancelled']);
const MODE_ATTACHMENTS = new Set(['plan_mode', 'plan_mode_exit', 'plan_mode_reentry']);

/** Text of a message content: a string, or the text blocks of an array. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function resultText(block) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) return block.content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  return '';
}

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
function stripReminders(text) {
  return text.replace(SYSTEM_REMINDER_RE, '').trim();
}

// Wrappers that look like a typed message but are harness scaffolding.
/** A body the harness wrapped because another session, an agent, or a schedule sent
 *  it: never text a person typed into this session. */
const RELAYED_RE = /^\s*<(cross-session-message|agent-message|scheduled-task)\b/i;
const relayedFrom = (body) => body.match(RELAYED_RE)?.[1].toLowerCase() ?? null;

/** How a prompt's author is known: recorded when the origin says a person, else the
 *  named rule that reads it as a person's (no origin field, or one this engine doesn't
 *  recognize). */
function authorshipOf(origin) {
  if (origin === 'human') return null;
  return { key: 'authorship', value: 'person', rule: origin == null ? 'prompt.authorship.no-origin' : 'prompt.authorship.unknown-origin' };
}
const PSEUDO_PROMPT_RE =/^\s*<(command-[\w-]*|task-notification|local-command[\w-]*|user-prompt-submit-hook|bash-(input|stdout|stderr))\b/i;
const INTERRUPT_RE = /^\[Request interrupted by user( for tool use)?\]/;
const TOOL_INTERRUPTED_RE = /^\[Tool call interrupted/;

function tag(text, name) {
  const m = typeof text === 'string' ? text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) : null;
  return m ? m[1].trim() : null;
}

/** Lines added and removed in a recorded structured patch. */
function patchCounts(patch) {
  if (!Array.isArray(patch)) return null;
  let added = 0;
  let removed = 0;
  for (const h of patch) {
    for (const l of Array.isArray(h?.lines) ? h.lines : []) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added += 1;
      else if (l.startsWith('-')) removed += 1;
    }
  }
  return { added, removed, hunks: patch.length };
}

function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * parseClaudeSource(source, ctx) -> Promise<{ events, joins, coverage, anomalies, stats }>
 *
 * ctx: { redact(string)->string, isPrivate: boolean, cwd: string|null, mainAgent, agentKey }
 * In a private source (a session outside the configured repos, or in a display-role
 * repo) events keep their kind, time and tool category and lose every text, path and
 * command: the skeleton shows that work happened, never what it was.
 */
export async function parseClaudeSource(source, ctx) {
  const red = (s) => (s == null ? null : ctx.redact(s));
  const priv = ctx.isPrivate === true;
  const text = (s, max) => (priv ? null : red(clip(s, max)));
  const isSub = source.role === 'subagent';
  const agentKey = ctx.agentKey;

  const events = [];
  const coverage = new Map();
  const anomalies = [];
  const tally = (key, handling) => {
    const c = coverage.get(key) ?? { count: 0, handling };
    c.count += 1;
    coverage.set(key, c);
  };
  const joins = {
    calls: new Map(), // raw tool_use id -> action event
    agentLaunches: [], // { agentId, event } from a delegation's recorded result
    notifications: [], // { taskId, toolUseId, status, event }
    backgroundTasks: new Map(), // raw background task id -> action event
    stoppedTasks: [], // { taskId, event }
    sentMessages: [], // { msgId, event }
    receivedMessages: [], // { msgId, event }
    chips: [], // { digest, event }
    firstPromptDigest: null,
    firstPromptEvent: null, // the event the digest came from; a dropped copy is no session's start
    uuids: [], // { uuid, eventIds }
    prs: [], // { repo, number, action, event }
    commits: [], // { sha, kind, event, evidence }
  };
  const stats = { records: 0, unparsable: 0, oversized: 0, firstAt: null, lastAt: null, models: new Set(), titles: [] };

  let lastT = null;
  let lastAt = null;
  let side = false; // the current record is an inline sidechain (older logs kept sub-agents in the session file)
  let sideSeen = false;
  let turn = null;
  let promptsSeen = 0;
  let firstUserSeen = false;
  const queue = []; // FIFO of enqueue events awaiting delivery
  const absorbed = []; // { event, digest } delivered mid-turn per the queue record
  const midTurnDigests = new Set();

  const ref = (r) => ({ src: source.key, line: r.line, off: r.offset, len: r.length, digest: recordDigest(r.bytes) });

  function make(kind, r, sub, { at, actor, evidence = EVIDENCE.RECORDED, facts = {}, inferred = [], missing = [], opensTurn = false } = {}) {
    const t = at ? Date.parse(at) : lastT;
    const e = {
      id: eventId(source.key, r.line, sub),
      kind,
      at: at ?? null,
      t: Number.isFinite(t) ? t : 0,
      timeFrom: at ? 'record' : lastT == null ? 'none' : 'previous-record',
      source: source.key,
      session: source.sessionKey,
      agent: side ? ctx.sidechainAgentKey : agentKey,
      actor,
      evidence,
      refs: [ref(r)],
      facts,
      derived: {},
      inferred,
      missing,
      turn: null,
    };
    if (opensTurn) turn = e.id;
    e.turn = turn;
    events.push(e);
    return e;
  }

  for await (const r of readJsonlRecords(source.file)) {
    if (r.oversized) {
      stats.oversized += 1;
      tally('(record over size cap)', 'skipped: too large to read safely');
      anomalies.push({ kind: 'oversized-record', source: source.key, line: r.line });
      continue;
    }
    const rec = tryParse(r.text);
    if (!rec || typeof rec !== 'object') {
      stats.unparsable += 1;
      tally('(unparsable line)', 'skipped: not valid JSON (often a cut-off last line)');
      anomalies.push({ kind: 'unparsable-line', source: source.key, line: r.line });
      continue;
    }
    stats.records += 1;
    const type = typeof rec.type === 'string' ? rec.type : '(no type)';
    const at = typeof rec.timestamp === 'string' && Number.isFinite(Date.parse(rec.timestamp)) ? rec.timestamp : null;
    const before = events.length;
    side = rec.isSidechain === true && !isSub;

    if (CLAUDE_IGNORED_TYPES.has(type)) {
      tally(type, `ignored: ${CLAUDE_IGNORED_TYPES.get(type)}`);
    } else if (type === 'user') {
      handleUser(rec, r, at);
    } else if (type === 'assistant') {
      handleAssistant(rec, r, at);
    } else if (type === 'system') {
      handleSystem(rec, r, at);
    } else if (type === 'attachment') {
      handleAttachment(rec, r, at);
    } else if (type === 'queue-operation') {
      handleQueue(rec, r, at);
    } else if (type === 'pr-link') {
      tally(type, 'event: link (time is when the harness recorded the link)');
      const number = Number.isInteger(rec.prNumber) ? rec.prNumber : null;
      const repo = typeof rec.prRepository === 'string' ? rec.prRepository : null;
      // In a private session the link is kept only as "a link was recorded".
      if (number != null) {
        const e = make('link', r, 0, { at, actor: 'harness', facts: priv ? {} : { pr: number, repo: red(repo) } });
        if (!priv) joins.prs.push({ repo, number, action: 'linked', event: e, evidence: EVIDENCE.RECORDED });
      }
    } else if (type === 'custom-title' || type === 'ai-title') {
      tally(type, 'fact: session title');
      const title = type === 'custom-title' ? rec.customTitle : rec.aiTitle;
      if (typeof title === 'string') stats.titles.push({ kind: type, text: text(title, SHORT) });
    } else if (type === 'agent-name') {
      tally(type, 'fact: agent name');
      if (typeof rec.agentName === 'string') stats.agentName = text(rec.agentName, 80);
    } else if (type === 'mode' || type === 'permission-mode') {
      tally(type, 'event: mode');
      const mode = type === 'mode' ? rec.mode : rec.permissionMode;
      make('mode', r, 0, { at, actor: 'harness', facts: { change: type, value: typeof mode === 'string' && !priv ? red(clip(mode, 40)) : null } });
    } else if (type === 'worktree-state') {
      tally(type, 'event: mode (entered a worktree)');
      const w = rec.worktreeSession ?? {};
      make('mode', r, 0, { at, actor: 'harness', facts: { change: 'worktree', branch: text(w.worktreeBranch, 80), originalBranch: text(w.originalBranch, 80), originalHead: priv ? null : (typeof w.originalHeadCommit === 'string' ? w.originalHeadCommit : null) } });
    } else if (type === 'relocated') {
      tally(type, 'event: mode (working directory moved)');
      make('mode', r, 0, { at, actor: 'harness', facts: { change: 'cwd', cwd: priv ? null : reducePath(rec.relocatedCwd ?? '', ctx.cwd) } });
    } else {
      tally(type, 'unrecognized: no handler for this record type yet');
    }

    if (rec.uuid && events.length > before) joins.uuids.push({ uuid: rec.uuid, eventIds: events.slice(before).map((e) => e.id) });
    // Pull-request links and queue records are stamped out of band, up to days from
    // the records around them, so they never move the source's own clock or span.
    if (at && !OUT_OF_BAND_TYPES.has(type)) {
      const t = Date.parse(at);
      if (!stats.firstAt || at < stats.firstAt) stats.firstAt = at;
      if (!stats.lastAt || at > stats.lastAt) stats.lastAt = at;
      lastT = t;
      lastAt = at;
    }
  }

  // A queued message the queue says was absorbed mid-turn, with no attachment record
  // carrying it, exists only in the queue record: that record becomes the prompt.
  for (const a of absorbed) {
    if (midTurnDigests.has(a.digest)) continue;
    const q = a.event;
    promptsSeen += 1;
    events.push({
      ...q,
      id: q.id.replace(/\.0$/, '.1'),
      kind: 'prompt',
      actor: 'person',
      refs: [...q.refs, ...a.removedBy.refs],
      facts: { text: priv ? null : red(clip(a.body, PROMPT_MAX)), chars: a.body.length, origin: null, index: promptsSeen, delivery: 'mid-turn', evidencedBy: 'queue-record' },
      derived: {},
      inferred: priv ? [] : promptInferences(a.body),
      missing: [],
      turn: a.removedBy.turn,
    });
  }

  finishSource(events, joins.calls, stats.firstAt);

  return { events, joins, coverage, anomalies, stats: { ...stats, models: [...stats.models].sort(), lastAt: stats.lastAt ?? lastAt } };

  // -------------------------------------------------------------------------
  function handleUser(rec, r, at) {
    const content = rec.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((b) => b && b.type === 'tool_result');
    if (results.length) {
      tally('user:tool_result', 'event: completes the matching action');
      results.forEach((b, i) => handleResult(rec, r, at, b, i));
      return;
    }
    const raw = contentText(content);
    if (!raw.trim() && !rec.origin) {
      tally('user:empty', 'ignored: no text');
      return;
    }
    if (rec.isCompactSummary) {
      tally('user:compact-summary', 'excluded: model-written summary of earlier context');
      return;
    }
    const origin = rec.origin?.kind ?? null;
    const visible = stripReminders(raw);

    if (INTERRUPT_RE.test(visible)) {
      tally('user:interrupt-marker', 'event: interrupt');
      make('interrupt', r, 0, { at, actor: 'person', facts: { by: 'person', during: /for tool use/.test(visible) ? 'tool-call' : 'response' } });
      turn = null;
      return;
    }
    if (origin === 'task-notification' || /^\s*<task-notification>/.test(visible)) {
      tally('user:task-notification', 'event: notification');
      notification(r, at, visible, 0);
      return;
    }
    if (origin === 'peer' || origin === 'coordinator') {
      tally(`user:${origin}`, 'event: agent-message (inbound)');
      const e = make('agent-message', r, 0, { at, actor: 'peer', opensTurn: true, facts: { direction: 'inbound', from: origin, name: text(rec.origin?.name, 80), text: text(visible, TEXT_MAX) } });
      if (typeof rec.origin?.msg_id === 'string') joins.receivedMessages.push({ msgId: rec.origin.msg_id, event: e });
      return;
    }
    // Another session, an agent, or a schedule sent this, whatever origin the record
    // carries (a scheduled task arrives marked as a person's): never a typed prompt.
    const relayed = relayedFrom(visible);
    if (relayed) {
      tally(`user:relayed-${relayed}`, 'event: agent-message (inbound, relayed)');
      const e = make('agent-message', r, 0, { at, actor: relayed === 'scheduled-task' ? 'harness' : 'peer', opensTurn: true, facts: { direction: 'inbound', from: relayed, name: text(rec.origin?.name, 80), text: text(visible, TEXT_MAX) } });
      if (typeof rec.origin?.msg_id === 'string') joins.receivedMessages.push({ msgId: rec.origin.msg_id, event: e });
      return;
    }
    if (/^\s*<command-name>/.test(visible) || /^\s*<command-message>/.test(visible)) {
      tally('user:slash-command', 'event: command');
      const name = tag(visible, 'command-name');
      make('command', r, 0, { at, actor: 'person', opensTurn: true, facts: { name: text(name, 60), args: text(tag(visible, 'command-args'), SHORT) } });
      return;
    }
    if (rec.isMeta || PSEUDO_PROMPT_RE.test(visible)) {
      tally('user:harness-text', 'ignored: harness scaffolding sent in the user slot');
      return;
    }

    const asSub = isSub || side;
    if (asSub && !(side ? sideSeen : firstUserSeen)) {
      if (side) sideSeen = true;
      else firstUserSeen = true;
      tally('user:delegation-prompt', 'event: delegation-received');
      make('delegation-received', r, 0, { at, actor: 'agent', opensTurn: true, facts: { from: 'parent-agent', text: text(visible, PROMPT_MAX) } });
      return;
    }
    if (asSub) {
      tally('user:parent-follow-up', 'event: agent-message (from the parent agent)');
      make('agent-message', r, 0, { at, actor: 'agent', opensTurn: true, facts: { direction: 'inbound', from: 'parent-agent', text: text(visible, TEXT_MAX) } });
      return;
    }

    if (!visible) {
      // A record the harness wrote for a person's action (for example, starting a
      // suggested task) that carries only harness text.
      tally('user:harness-notice', 'event: notice');
      make('notice', r, 0, { at, actor: origin === 'human' ? 'person' : 'harness', opensTurn: true, facts: { origin } });
      return;
    }

    tally('user:prompt', 'event: prompt');
    const authorship = authorshipOf(origin);
    promptsSeen += 1;
    const digest = promptDigest(visible);
    if (promptsSeen === 1) joins.firstPromptDigest = digest;
    const e = make('prompt', r, 0, {
      at,
      actor: 'person',
      opensTurn: true,
      facts: { text: text(visible, PROMPT_MAX), chars: visible.length, origin, index: promptsSeen },
      inferred: [...(authorship ? [authorship] : []), ...(priv ? [] : promptInferences(visible))],
    });
    if (promptsSeen === 1) joins.firstPromptEvent = e.id;
    // A message typed while the agent was busy and later delivered at a turn boundary.
    const q = queue.findIndex((x) => x.digest === digest && x.event.facts.state === 'delivered');
    if (q !== -1) {
      e.facts.queuedAt = queue[q].event.at;
      e.derived.queuedMs = Number.isFinite(e.t - queue[q].event.t) ? e.t - queue[q].event.t : null;
      queue.splice(q, 1);
    }
  }

  function notification(r, at, body, sub, { delivery = 'turn' } = {}) {
    const status = tag(body, 'status');
    const taskId = tag(body, 'task-id');
    const toolUseId = tag(body, 'tool-use-id');
    const e = make('notification', r, sub, { at, actor: 'harness', opensTurn: delivery === 'turn', facts: { status: status ? clip(status, 40) : null, summary: text(tag(body, 'summary'), SHORT), delivery } });
    joins.notifications.push({ taskId, toolUseId, status, event: e });
    return e;
  }

  function handleResult(rec, r, at, block, i) {
    const call = joins.calls.get(block.tool_use_id);
    const body = resultText(block);
    const tur = rec.toolUseResult;
    if (!call) {
      anomalies.push({ kind: 'result-without-call', source: source.key, line: r.line });
      return;
    }
    const t = at ? Date.parse(at) : lastT;
    call.end = { at, t: Number.isFinite(t) ? t : call.t, ref: ref(r) };
    call.refs.push(call.end.ref);
    const f = call.facts;
    f.result = block.is_error === true ? 'error' : 'ok';
    if (rec.toolDenialKind && !priv) f.denial = red(clip(String(rec.toolDenialKind), 40));
    if (Number.isFinite(call.end.t - call.t)) call.derived.recordedSpanMs = call.end.t - call.t;
    const turnId = call.turn;
    const cat = f.category;

    // Joins first: they are raw ids kept in memory to connect files, never facts, so
    // a private session's sub-agents and background tasks still link up.
    if (tur && typeof tur === 'object') {
      if (cat === 'delegate' && typeof tur.agentId === 'string') joins.agentLaunches.push({ agentId: tur.agentId, event: call });
      if (cat === 'shell' && typeof tur.backgroundTaskId === 'string') joins.backgroundTasks.set(tur.backgroundTaskId, call);
      if (cat === 'agent-message' && typeof tur.msg_id === 'string') joins.sentMessages.push({ msgId: tur.msg_id, event: call });
      if (cat === 'stop' && typeof (tur.task_id ?? call._taskId) === 'string') joins.stoppedTasks.push({ taskId: tur.task_id ?? call._taskId, event: call });
    }

    if (rec.toolDenialKind === 'interrupted' || TOOL_INTERRUPTED_RE.test(body)) {
      f.result = 'interrupted';
      // "session-end" is the harness's own wording ("the session ended before this
      // call's result was recorded"); any other interrupted marker says only that.
      make('interrupt', r, 10 + i, { at, actor: 'harness', facts: { by: TOOL_INTERRUPTED_RE.test(body) ? 'session-end' : 'harness', during: 'tool-call', action: call.id } }).turn = turnId;
      return;
    }
    if (rec.toolDenialKind === 'user-rejected' || /^The user doesn't want to proceed with this tool use/.test(body)) {
      f.result = 'rejected';
      const said = body.match(/the user said:\s*([\s\S]*)$/i);
      make('decision', r, 10 + i, { at, actor: 'person', facts: { decision: f.category === 'plan-approval' ? 'rejected-plan' : 'rejected-tool-call', action: call.id, tool: f.tool, feedback: text(said ? said[1] : null, PROMPT_MAX) }, inferred: said && !priv ? promptInferences(said[1]) : [] }).turn = turnId;
      return;
    }
    if (rec.toolDenialKind || /^(Error: )?(PreToolUse|PostToolUse)[:\w]* hook error/.test(body) || /hook error: Refused/.test(body)) {
      f.result = 'refused';
      make('guard', r, 10 + i, { at, actor: 'harness', facts: { rule: priv ? null : rec.toolDenialKind ? red(clip(String(rec.toolDenialKind), 40)) : 'hook', action: call.id, reason: text(body.split('\n')[0], SHORT) } }).turn = turnId;
      return;
    }

    // A private session keeps that the step ran and whether it succeeded, nothing else:
    // no commit ids, pull requests, line counts, plan states or answers.
    if (priv) {
      if (cat === 'question' || cat === 'plan-approval') make('decision', r, 10 + i, { at, actor: 'person', facts: { decision: cat === 'question' ? 'answered-question' : 'plan-result-recorded', action: call.id } }).turn = turnId;
      return;
    }

    if (cat === 'shell' && tur && typeof tur === 'object') {
      if (tur.interrupted === true) f.interruptedFlag = true;
      const out = `${tur.stdout ?? ''}\n${tur.stderr ?? ''}`;
      if (f.testRunner) {
        const s = parseTestSummary(out) ?? parseTestSummary(body);
        if (s) call.derived.tests = s;
        else call.missing.push('test-summary');
        f.exitStatusBelongsToRunner = !exitStatusIsAmbiguous(call._command);
      }
      const g = tur.gitOperation;
      if (g && typeof g === 'object') {
        f.git = {};
        if (g.commit?.sha) {
          f.git.commit = { sha: String(g.commit.sha), kind: red(clip(String(g.commit.kind ?? 'committed'), 20)) };
          joins.commits.push({ sha: String(g.commit.sha), kind: g.commit.kind ?? 'committed', event: call, evidence: EVIDENCE.RECORDED });
        }
        if (g.push) f.git.push = { branch: text(g.push.branch, 80) };
        if (g.pr?.number) {
          f.git.pr = { number: g.pr.number, action: red(clip(String(g.pr.action ?? ''), 20)) };
          joins.prs.push({ repo: typeof g.pr.url === 'string' ? (g.pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? null) : null, number: g.pr.number, action: g.pr.action, event: call, evidence: EVIDENCE.RECORDED });
        }
        if (g.branch) f.git.branch = { action: red(clip(String(g.branch.action ?? ''), 20)), ref: text(g.branch.ref, 80) };
      } else {
        const n = outputNominations(call._command, out, call);
        joins.commits.push(...n.commits);
        joins.prs.push(...n.prs);
      }
    } else if (cat === 'edit' && tur && typeof tur === 'object') {
      const pc = patchCounts(tur.structuredPatch);
      if (pc) call.derived.patch = pc;
      if (tur.type === 'create' && typeof tur.content === 'string') call.derived.linesWritten = tur.content.split('\n').length;
      if (tur.userModified === true) f.userModified = true;
    } else if (cat === 'delegate' && tur && typeof tur === 'object') {
      f.handback = {
        status: typeof tur.status === 'string' ? clip(tur.status, 30) : null,
        async: tur.isAsync === true,
        harnessDurationMs: Number.isFinite(tur.totalDurationMs) ? tur.totalDurationMs : null,
        toolUses: Number.isFinite(tur.totalToolUseCount) ? tur.totalToolUseCount : null,
      };
    } else if (cat === 'plan' && tur && typeof tur === 'object') {
      if (tur.statusChange && typeof tur.statusChange === 'object') f.statusChange = { from: red(clip(String(tur.statusChange.from ?? ''), 20)), to: red(clip(String(tur.statusChange.to ?? ''), 20)) };
      if (Array.isArray(tur.newTodos)) {
        const by = {};
        for (const td of tur.newTodos) by[td?.status ?? 'unknown'] = (by[td?.status ?? 'unknown'] ?? 0) + 1;
        f.todos = by;
        f.todosRemoved = Array.isArray(tur.oldTodos) ? Math.max(0, tur.oldTodos.length - tur.newTodos.length) : null;
      }
    } else if (cat === 'question' && tur && typeof tur === 'object' && tur.answers && typeof tur.answers === 'object') {
      const answers = Object.values(tur.answers).filter((v) => typeof v === 'string');
      make('decision', r, 10 + i, { at, actor: 'person', facts: { decision: 'answered-question', action: call.id, answers: priv ? null : answers.map((a) => red(clip(a, SHORT))) } }).turn = turnId;
    } else if (cat === 'plan-approval') {
      const approved = /approved/i.test(body) && block.is_error !== true;
      make('decision', r, 10 + i, { at, actor: 'person', facts: { decision: approved ? 'approved-plan' : 'plan-result-recorded', action: call.id } }).turn = turnId;
    } else if (cat === 'handoff') {
      if (/task_id:\s*[\w-]+/.test(body)) f.suggestion = 'recorded';
    }
  }

  function handleAssistant(rec, r, at) {
    const msg = rec.message ?? {};
    if (typeof msg.model === 'string' && msg.model !== '<synthetic>') stats.models.add(msg.model);
    if (rec.isApiErrorMessage) {
      tally('assistant:api-error', 'event: error');
      make('error', r, 0, { at, actor: 'harness', facts: { kind: 'api-error', text: text(contentText(msg.content), SHORT) } });
      return;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    blocks.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        tally('assistant:thinking', 'excluded: private model reasoning is never read');
        return;
      }
      if (b.type === 'text') {
        tally('assistant:text', 'event: message');
        if (typeof b.text === 'string' && b.text.trim()) make('message', r, i, { at, actor: 'agent', facts: { text: text(b.text, TEXT_MAX), chars: b.text.length, to: isSub || side ? 'parent-agent' : 'person' } });
        return;
      }
      if (b.type === 'tool_use') {
        tally('assistant:tool_use', 'event: action');
        toolUse(rec, r, at, b, i);
        return;
      }
      tally(`assistant:${b.type ?? '(block)'}`, 'unrecognized: no handler for this content block yet');
    });
  }

  function toolUse(rec, r, at, b, i) {
    const name = typeof b.name === 'string' ? b.name : 'unknown';
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    const category = toolCategory(name);
    const server = mcpServer(name);
    const serverLabel = server && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server) ? 'connector' : server;
    const facts = { tool: category === 'external' || category === 'browser' ? (serverLabel ? `mcp:${red(serverLabel)}` : 'mcp') : name, category };
    const inferred = [];
    let command = null;
    if (!priv) {
      if (category === 'shell') {
        command = typeof input.command === 'string' ? input.command : null;
        facts.command = text(command, CMD_MAX);
        facts.description = text(input.description, SHORT);
        if (input.run_in_background === true) facts.background = true;
        const shell = shellInterpretation(command);
        if (shell.testRunner) facts.testRunner = shell.testRunner;
        inferred.push(...shell.inferred);
      } else if (category === 'edit' || category === 'read') {
        const fp = input.file_path ?? input.notebook_path ?? input.filePath;
        if (typeof fp === 'string') {
          facts.file = reducePath(fp, ctx.cwd);
          facts.fileKey = pathKey(fp);
        }
      } else if (category === 'search') {
        facts.pattern = text(input.pattern ?? input.query, 80);
      } else if (category === 'web') {
        if (typeof input.query === 'string') facts.query = text(input.query, 120);
        if (typeof input.url === 'string') facts.host = red(hostOf(input.url));
      } else if (category === 'delegate') {
        facts.agentType = text(input.subagent_type ?? null, 60);
        facts.description = text(input.description, SHORT);
        if (input.run_in_background === true) facts.background = true;
        if (looksLikeReview(input.description, input.subagent_type)) inferred.push({ key: 'step', value: 'review', rule: 'review.delegation' });
      } else if (category === 'agent-message') {
        facts.to = text(input.to ?? input.recipient, 80);
        facts.summary = text(input.summary ?? input.content, SHORT);
      } else if (category === 'plan') {
        if (typeof input.subject === 'string') facts.subject = text(input.subject, SHORT);
        if (typeof input.taskId === 'string') facts.taskId = clip(input.taskId, 20);
        if (typeof input.status === 'string') facts.status = clip(input.status, 20);
        if (Array.isArray(input.todos)) facts.items = input.todos.length;
      } else if (category === 'question') {
        const qs = Array.isArray(input.questions) ? input.questions : [];
        facts.questions = qs.map((q) => text(q?.question, SHORT)).filter(Boolean);
      } else if (category === 'skill') {
        facts.skill = text(input.skill ?? input.command, 60);
        if (looksLikeReview(input.skill)) inferred.push({ key: 'step', value: 'review', rule: 'review.skill' });
      } else if (category === 'wait') {
        facts.description = text(input.description ?? input.reason, SHORT);
        if (Number.isFinite(input.delaySeconds)) facts.delaySeconds = input.delaySeconds;
        if (Number.isFinite(input.timeout_ms)) facts.timeoutMs = input.timeout_ms;
      } else if (category === 'handoff') {
        facts.title = text(input.title, SHORT);
        if (typeof input.prompt === 'string') facts.promptDigest = promptDigest(input.prompt);
      } else if (category === 'stop') {
        if (typeof input.task_id === 'string') facts.stopsTask = 'recorded';
      }
    }
    const e = make('action', r, i, { at, actor: 'agent', facts, inferred });
    Object.defineProperty(e, '_command', { value: command, enumerable: false });
    if (category === 'stop' && typeof input.task_id === 'string') Object.defineProperty(e, '_taskId', { value: input.task_id, enumerable: false });
    if (typeof b.id === 'string') joins.calls.set(b.id, e);
    if (category === 'handoff' && facts.promptDigest) joins.chips.push({ digest: facts.promptDigest, event: e });
  }

  function handleSystem(rec, r, at) {
    const st = rec.subtype ?? '(none)';
    const key = `system:${st}`;
    if (st === 'stop_hook_summary') {
      tally(key, 'event: turn-end (stop hooks ran)');
      const e = make('turn-end', r, 0, { at, actor: 'harness', facts: { marker: 'stop-hooks', hooks: Array.isArray(rec.hookInfos) ? rec.hookInfos.length : null, hookErrors: Array.isArray(rec.hookErrors) ? rec.hookErrors.length : null, preventedContinuation: rec.preventedContinuation === true } });
      if (Array.isArray(rec.hookInfos)) e.derived.hookMs = rec.hookInfos.reduce((n, h) => n + (Number.isFinite(h?.durationMs) ? h.durationMs : 0), 0);
    } else if (st === 'turn_duration') {
      tally(key, 'event: turn-end (harness-recorded turn duration)');
      make('turn-end', r, 0, { at, actor: 'harness', facts: { marker: 'turn-duration', harnessDurationMs: Number.isFinite(rec.durationMs) ? rec.durationMs : null, messageCount: Number.isFinite(rec.messageCount) ? rec.messageCount : null } });
    } else if (st === 'api_error') {
      tally(key, 'event: error');
      make('error', r, 0, { at, actor: 'harness', facts: { kind: 'api-error', status: rec.error?.status ?? null, retryAttempt: rec.retryAttempt ?? null, maxRetries: rec.maxRetries ?? null } });
    } else if (st === 'compact_boundary') {
      tally(key, 'event: compaction');
      const m = rec.compactMetadata ?? {};
      make('compaction', r, 0, { at, actor: 'harness', facts: { trigger: clip(String(m.trigger ?? ''), 20), preTokens: m.preTokens ?? null, postTokens: m.postTokens ?? null } });
    } else if (st === 'away_summary') {
      tally(key, 'excluded: model-written recap');
    } else if (st === 'local_command') {
      tally(key, 'event: command (output not read)');
      make('command', r, 0, { at, actor: 'harness', facts: { name: 'local-command-output' } });
    } else {
      tally(key, 'event: error/notice recorded by the harness');
      make('error', r, 0, { at, actor: 'harness', facts: { kind: clip(st, 40), level: clip(String(rec.level ?? ''), 20) } });
    }
  }

  function handleAttachment(rec, r, at) {
    const a = rec.attachment ?? {};
    const at2 = at ?? (typeof a.timestamp === 'string' ? a.timestamp : null);
    const ty = typeof a.type === 'string' ? a.type : '(none)';
    const key = `attachment:${ty}`;
    if (CONTEXT_ATTACHMENTS.has(ty)) {
      tally(key, 'ignored: harness context');
    } else if (ty === 'edited_text_file') {
      tally(key, 'event: external-edit (who changed the file is not recorded)');
      make('external-edit', r, 0, { at: at2, actor: 'harness', facts: { file: priv ? null : reducePath(a.filename ?? '', ctx.cwd), fileKey: priv ? null : pathKey(a.filename) } });
    } else if (ty === 'queued_command') {
      const kind = a.origin?.kind ?? null;
      const prompt = typeof a.prompt === 'string' ? a.prompt : '';
      if (kind === 'task-notification' || /^\s*<task-notification>/.test(prompt)) {
        tally(`${key}:notification`, 'event: notification (delivered mid-turn)');
        const e = notification(r, at2, prompt, 0, { delivery: 'mid-turn' });
        if (a.usage && typeof a.usage === 'object') {
          e.facts.harnessDurationMs = Number.isFinite(a.usage.durationMs) ? a.usage.durationMs : null;
          e.facts.toolUses = Number.isFinite(a.usage.toolUses) ? a.usage.toolUses : null;
        }
      } else {
        const visible = stripReminders(prompt);
        const digest = promptDigest(visible);
        midTurnDigests.add(digest);
        const relayed = kind === 'peer' || kind === 'coordinator' ? kind : relayedFrom(visible);
        if (relayed) {
          // Another session, an agent, or a schedule sent it, the same as a peer or
          // coordinator record in the user slot: an inbound message, not a prompt.
          tally(`${key}:relayed`, 'event: agent-message (inbound, delivered mid-turn)');
          const e = make('agent-message', r, 0, { at: at2, actor: relayed === 'scheduled-task' ? 'harness' : 'peer', facts: { direction: 'inbound', from: relayed, name: text(a.origin?.name, 80), text: text(visible, TEXT_MAX), delivery: 'mid-turn' } });
          if (typeof a.origin?.msg_id === 'string') joins.receivedMessages.push({ msgId: a.origin.msg_id, event: e });
        } else {
          tally(`${key}:typed`, 'event: prompt (typed while the agent was busy, delivered mid-turn)');
          promptsSeen += 1;
          const authorship = authorshipOf(kind);
          make('prompt', r, 0, { at: at2, actor: 'person', facts: { text: text(visible, PROMPT_MAX), chars: visible.length, origin: kind, index: promptsSeen, delivery: 'mid-turn' }, inferred: [...(authorship ? [authorship] : []), ...(priv ? [] : promptInferences(visible))] });
        }
      }
    } else if (HOOK_ATTACHMENTS.has(ty) || ty === 'hook_blocking_error') {
      const blocking = ty === 'hook_blocking_error';
      tally(key, blocking ? 'event: guard (a hook blocked a step)' : 'event: hook');
      make(blocking ? 'guard' : 'hook', r, 0, { at: at2, actor: 'harness', facts: { hook: text(a.hookName, 60), hookEvent: clip(String(a.hookEvent ?? ''), 30), exitCode: Number.isFinite(a.exitCode) ? a.exitCode : null, harnessDurationMs: Number.isFinite(a.durationMs) ? a.durationMs : null, result: ty } });
    } else if (MODE_ATTACHMENTS.has(ty)) {
      tally(key, 'event: mode');
      make('mode', r, 0, { at: at2, actor: 'harness', facts: { change: ty } });
    } else if (ty === 'max_turns_reached') {
      tally(key, 'event: interrupt (turn limit)');
      make('interrupt', r, 0, { at: at2, actor: 'harness', facts: { by: 'turn-limit' } });
    } else {
      tally(key, 'unrecognized: no handler for this attachment type yet');
    }
  }

  function handleQueue(rec, r, at) {
    const op = typeof rec.operation === 'string' ? rec.operation : '(none)';
    const key = `queue-operation:${op}`;
    if (op === 'enqueue') {
      const body = typeof rec.content === 'string' ? rec.content : '';
      const isNote = /^\s*<task-notification>/.test(body);
      const visible = stripReminders(body);
      const relayed = isNote ? null : relayedFrom(visible);
      tally(`${key}:${isNote ? 'notification' : relayed ? 'relayed' : 'typed'}`, `event: queue (${isNote ? 'a notice' : relayed ? 'a message another session, an agent, or a schedule sent' : 'a message'} waiting for the agent)`);
      const actor = isNote || !body || relayed === 'scheduled-task' ? 'harness' : relayed ? 'peer' : 'person';
      const e = make('queue', r, 0, { at, actor, facts: { state: 'enqueued', carries: isNote ? 'notification' : relayed ? 'relayed-message' : body ? 'message' : 'unknown' } });
      queue.push({ event: e, digest: promptDigest(visible), body: visible });
    } else if (op === 'dequeue' || op === 'remove' || op === 'popAll') {
      tally(key, 'event: queue (message delivered or withdrawn)');
      // A remove that names its content resolves only the item with that content; when
      // none matches, the pairing is missing rather than guessed from queue position.
      const head = op === 'remove' && typeof rec.content === 'string'
        ? queue.find((x) => x.body === stripReminders(rec.content) && x.event.facts.state === 'enqueued')
        : queue.find((x) => x.event.facts.state === 'enqueued');
      const reason = typeof rec.reason === 'string' ? clip(rec.reason, 40) : null;
      const e = make('queue', r, 0, { at, actor: 'harness', facts: { state: op === 'dequeue' ? 'delivered' : 'removed', reason } });
      if (head) {
        head.event.facts.state = op === 'dequeue' ? 'delivered' : 'removed';
        head.event.facts.resolvedBy = e.id;
        if (Number.isFinite(e.t - head.event.t)) head.event.derived.waitedMs = e.t - head.event.t;
        if (reason === 'absorbed_mid_turn' && head.event.facts.carries === 'message') absorbed.push({ event: head.event, digest: head.digest, body: head.body, removedBy: e });
        if (op !== 'dequeue') queue.splice(queue.indexOf(head), 1);
      } else {
        e.missing.push('matching-enqueue');
      }
    } else {
      tally(key, 'unrecognized: queue operation not handled yet');
    }
  }
}
