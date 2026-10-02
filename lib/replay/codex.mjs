// lib/replay/codex.mjs — Codex rollout records -> engine events.
//
// A rollout is one thread. Its first record (session_meta) says what started it:
// a person in an editor or the desktop app, a non-interactive `codex exec` run, or
// another thread (a child spawned with spawn_agent, or the approval "guardian"). The
// parent link is recorded on the CHILD side (parent_thread_id plus its agent path),
// and the spawn call's recorded output names the same path, so both ends agree.
//
// Not read: `reasoning` items (private model reasoning, often encrypted), developer
// and system instructions, token accounting, and `item_completed` (a timing echo of
// items already read from response_item records). Each is tallied in the coverage.

import { codexAssistantText, createCodexTurnReader } from '../codex-records.mjs';
import { EVIDENCE } from './evidence.mjs';
import { reducePath } from '../claude-adapter.mjs';
import { eventId, pathKey, recordDigest } from './ids.mjs';
import { readJsonlRecords, tryParse } from './jsonl.mjs';
import { exitStatusIsAmbiguous, parseTestSummary, promptInferences, toolCategory } from './classify.mjs';
import { clip, finishSource, LIMITS, outputNominations, promptDigest, shellInterpretation } from './parse-common.mjs';

// An `exec` program the engine reads: one shell call whose arguments are all literals,
// printed as it returned, and nothing else. Loops, string building, spreads, or
// anything printed besides the call's own result make the program unreadable.
const JS_STRING = String.raw`"(?:\\.|[^"\\\r\n])*"`;
const JS_VALUE = String.raw`(?:${JS_STRING}|-?\d+|true|false|null)`;
const JS_KEY = String.raw`(?:"[A-Za-z_]\w*"|[A-Za-z_]\w*)`;
const JS_PAIR = String.raw`${JS_KEY}\s*:\s*${JS_VALUE}`;
const EXEC_ARGS = String.raw`\{\s*${JS_PAIR}(?:\s*,\s*${JS_PAIR})*\s*,?\s*\}`;
const EXEC_CALL = String.raw`await\s+tools\.(?:exec_command|shell_command)\s*\(\s*(?<args>${EXEC_ARGS})\s*\)`;
const EXEC_PROGRAMS = [
  new RegExp(String.raw`^\s*text\s*\(\s*${EXEC_CALL}\s*\)\s*;?\s*$`),
  new RegExp(String.raw`^\s*const\s+(?<v>[A-Za-z_$][\w$]*)\s*=\s*${EXEC_CALL}\s*;\s*text\s*\(\s*\k<v>\s*\)\s*;?\s*$`),
];
const EXEC_PAIR = new RegExp(String.raw`\s*,?\s*(?<key>${JS_KEY})\s*:\s*(?<value>${JS_VALUE})`, 'y');

/**
 * The one shell command a Codex `exec` program runs, when the program is nothing but
 * that call (`text(await tools.exec_command({cmd: "..."}))`, or the older
 * `const r = await tools.shell_command({command: "..."}); text(r);`). Any other
 * program gives null: it is shown, never interpreted. Input with no `tools.` call is
 * a bare command line.
 */
export function execProgramCommand(input) {
  if (typeof input !== 'string') return null;
  if (!/\btools\./.test(input)) return input;
  const body = input.replace(/^\s*\/\/ @exec:[^\r\n]*(?:\r?\n|$)/, '');
  const args = EXEC_PROGRAMS.map((re) => body.match(re)?.groups.args).find(Boolean);
  if (!args) return null;
  const pairs = new Map();
  EXEC_PAIR.lastIndex = 1;
  for (let m = EXEC_PAIR.exec(args); m; m = EXEC_PAIR.exec(args)) {
    const key = m.groups.key.replace(/^"|"$/g, '');
    // JavaScript keeps the last of two equal keys; a program that relies on that is not read.
    if (pairs.has(key)) return null;
    pairs.set(key, m.groups.value);
  }
  if (pairs.has('cmd') === pairs.has('command')) return null;
  const literal = pairs.get('cmd') ?? pairs.get('command');
  if (!literal.startsWith('"')) return null;
  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
}

/** The files an apply_patch names ("*** Update File:", "*** Add File:", "*** Delete
 *  File:", "*** Move to:"), and the lines it adds and removes. */
export function patchSummary(patch) {
  if (typeof patch !== 'string' || !/^\*\*\* Begin Patch/m.test(patch)) return null;
  const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$/gm)].map((m) => m[1] ?? m[2]);
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('***')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { files: [...new Set(files)], added, removed };
}

const absoluteIn = (file, cwd) => (/^([A-Za-z]:[\\/]|[\\/])/.test(file) || !cwd ? file : `${cwd.replace(/[\\/]+$/, '')}/${file}`);

const PROMPT_MAX = LIMITS.prompt;
const TEXT_MAX = LIMITS.text;
const CMD_MAX = LIMITS.command;
const SHORT = LIMITS.short;

const IGNORED = new Map([
  ['response_item:reasoning', 'excluded: private model reasoning is never read'],
  ['event_msg:token_count', 'ignored: token accounting, not work'],
  ['token_usage_record:', 'ignored: token accounting, not work'],
  ['world_state:', 'ignored: harness internal state'],
  ['event_msg:thread_settings_applied', 'ignored: harness settings echo'],
  ['inter_agent_communication_metadata:', 'ignored: delivery flags for the agent message beside it'],
  ['event_msg:item_completed', 'ignored: timing echo of an item already read'],
  ['event_msg:agent_reasoning', 'excluded: private model reasoning is never read'],
  ['event_msg:agent_reasoning_raw_content', 'excluded: private model reasoning is never read'],
]);

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  if (output && typeof output === 'object' && typeof output.content === 'string') return output.content;
  return '';
}

function parseArgs(p) {
  if (typeof p.arguments === 'string') return tryParse(p.arguments) ?? {};
  if (p.arguments && typeof p.arguments === 'object') return p.arguments;
  return {};
}

/** What started this thread, from its recorded session_meta. */
export function codexOrigin(meta) {
  const src = meta?.source;
  const spawn = src && typeof src === 'object' ? src.subagent?.thread_spawn : null;
  if (spawn && typeof spawn === 'object') {
    return { kind: 'child-thread', parentThreadId: typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : null, agentPath: typeof spawn.agent_path === 'string' ? spawn.agent_path : null, nickname: typeof spawn.agent_nickname === 'string' ? spawn.agent_nickname : null, depth: Number.isFinite(spawn.depth) ? spawn.depth : null };
  }
  if (src && typeof src === 'object' && src.subagent) return { kind: 'guardian', other: typeof src.subagent.other === 'string' ? src.subagent.other : null };
  if (typeof src === 'string') return { kind: src === 'exec' ? 'exec' : 'interactive', surface: src };
  return { kind: 'unknown' };
}

/**
 * parseCodexSource(source, ctx) -> Promise<{ events, joins, coverage, anomalies, stats }>
 * ctx as for parseClaudeSource. A child thread's "user" messages come from its
 * parent agent, never from a person.
 */
export async function parseCodexSource(source, ctx) {
  const red = (s) => (s == null ? null : ctx.redact(s));
  const priv = ctx.isPrivate === true;
  const text = (s, max) => (priv ? null : red(clip(s, max)));
  const origin = codexOrigin(source.meta);
  const fromAgent = origin.kind === 'child-thread' || origin.kind === 'guardian';

  const events = [];
  const coverage = new Map();
  const anomalies = [];
  const tally = (key, handling) => {
    const c = coverage.get(key) ?? { count: 0, handling };
    c.count += 1;
    coverage.set(key, c);
  };
  const joins = { calls: new Map(), spawns: [], prs: [], commits: [], firstPromptDigest: null, firstPromptEvent: null, uuids: [] };
  const stats = { records: 0, unparsable: 0, oversized: 0, firstAt: null, lastAt: null, models: new Set(), titles: [] };
  const turnReader = createCodexTurnReader();
  let lastT = null;
  let turn = null;
  let prompts = 0;
  let delegationSeen = false;

  const ref = (r) => ({ src: source.key, line: r.line, off: r.offset, len: r.length, digest: recordDigest(r.bytes) });
  function make(kind, r, sub, { at, actor, facts = {}, inferred = [], missing = [], opensTurn = false } = {}) {
    const t = at ? Date.parse(at) : lastT;
    const e = { id: eventId(source.key, r.line, sub), kind, at: at ?? null, t: Number.isFinite(t) ? t : 0, timeFrom: at ? 'record' : lastT == null ? 'none' : 'previous-record', source: source.key, session: source.sessionKey, agent: ctx.agentKey, actor, evidence: EVIDENCE.RECORDED, refs: [ref(r)], facts, derived: {}, inferred, missing, turn: null };
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
    const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
    const key = `${rec.type ?? '(no type)'}:${p.type ?? ''}`;
    const at = typeof rec.timestamp === 'string' && Number.isFinite(Date.parse(rec.timestamp)) ? rec.timestamp : null;

    if (IGNORED.has(key)) {
      tally(key, IGNORED.get(key));
    } else if (rec.type === 'session_meta') {
      tally(key, 'event: session (what started this thread)');
      make('session', r, 0, { at, actor: 'harness', facts: { tool: 'codex', started: origin.kind, surface: origin.surface ? red(clip(origin.surface, 40)) : null, agentPath: text(origin.agentPath, 80), nickname: text(origin.nickname, 60), branch: text(p.git?.branch, 80), headAtStart: priv ? null : (typeof p.git?.commit_hash === 'string' ? p.git.commit_hash : null), cliVersion: red(clip(String(p.cli_version ?? ''), 20)) } });
    } else if (rec.type === 'turn_context') {
      tally(key, 'fact: model and approval policy for the turn');
      if (typeof p.model === 'string') stats.models.add(p.model);
    } else if (rec.type === 'compacted') {
      tally(key, 'event: compaction');
      make('compaction', r, 0, { at, actor: 'harness', facts: { trigger: 'compacted' } });
    } else if (key === 'event_msg:task_started') {
      tally(key, 'fact: a turn started (no event; the prompt opens the turn)');
    } else if (key === 'event_msg:task_complete') {
      tally(key, 'event: turn-end (harness-recorded turn duration)');
      make('turn-end', r, 0, { at, actor: 'harness', facts: { marker: 'task-complete', harnessDurationMs: Number.isFinite(p.duration_ms) ? p.duration_ms : null } });
    } else if (key === 'event_msg:turn_aborted') {
      tally(key, 'event: interrupt');
      // Codex records that the turn was aborted and its own reason word, not who did it.
      make('interrupt', r, 0, { at, actor: 'harness', facts: { by: 'harness-reported', reason: red(clip(String(p.reason ?? ''), 40)), harnessDurationMs: Number.isFinite(p.duration_ms) ? p.duration_ms : null } });
      turn = null;
    } else if (key === 'response_item:message' || key === 'event_msg:user_message' || key === 'event_msg:agent_message') {
      message(rec, p, r, at, key);
    } else if (key === 'response_item:function_call' || key === 'response_item:custom_tool_call' || key === 'response_item:local_shell_call') {
      tally(key, 'event: action');
      call(p, r, at);
    } else if (key === 'response_item:function_call_output' || key === 'response_item:custom_tool_call_output') {
      tally(key, 'event: completes the matching action');
      result(p, r, at);
    } else if (key === 'response_item:agent_message') {
      tally(key, 'event: agent-message');
      const body = outputText(p.content);
      make('agent-message', r, 0, { at, actor: 'agent', facts: { direction: 'between-agents', author: text(p.author, 80), recipient: text(p.recipient, 80), text: text(body, TEXT_MAX) } });
    } else {
      tally(key, 'unrecognized: no handler for this record type yet');
    }

    if (at) {
      if (!stats.firstAt || at < stats.firstAt) stats.firstAt = at;
      if (!stats.lastAt || at > stats.lastAt) stats.lastAt = at;
      lastT = Date.parse(at);
    }
  }

  finishSource(events, joins.calls, stats.firstAt);
  return { events, joins, coverage, anomalies, stats: { ...stats, models: [...stats.models].sort(), origin } };

  // -------------------------------------------------------------------------
  function message(rec, p, r, at, key) {
    if (p.role === 'developer' || p.role === 'system') {
      tally(`${key}:${p.role}`, 'ignored: instructions to the model');
      return;
    }
    const { user, assistant } = turnReader(rec);
    if (user != null) {
      if (fromAgent && !delegationSeen) {
        delegationSeen = true;
        tally(`${key}:user`, 'event: delegation-received');
        make('delegation-received', r, 0, { at, actor: 'agent', opensTurn: true, facts: { from: 'parent-agent', text: text(user, PROMPT_MAX) } });
        return;
      }
      if (fromAgent) {
        tally(`${key}:user`, 'event: agent-message (from the parent agent)');
        make('agent-message', r, 0, { at, actor: 'agent', opensTurn: true, facts: { direction: 'inbound', from: 'parent-agent', text: text(user, TEXT_MAX) } });
        return;
      }
      tally(`${key}:user`, 'event: prompt');
      prompts += 1;
      const digest = promptDigest(user);
      if (prompts === 1) joins.firstPromptDigest = digest;
      const inferred = priv ? [] : promptInferences(user);
      if (origin.kind === 'exec') inferred.unshift({ key: 'authorship', value: 'person-or-script', rule: 'prompt.authorship.exec-session' });
      const e = make('prompt', r, 0, { at, actor: origin.kind === 'exec' ? 'person-or-script' : 'person', opensTurn: true, facts: { text: text(user, PROMPT_MAX), chars: user.length, index: prompts }, inferred });
      if (prompts === 1) joins.firstPromptEvent = e.id;
      return;
    }
    if (assistant != null) {
      tally(`${key}:assistant`, 'event: message');
      make('message', r, 0, { at, actor: 'agent', facts: { text: text(assistant, TEXT_MAX), chars: assistant.length, to: fromAgent ? 'parent-agent' : 'person' } });
      return;
    }
    if (p.role === 'user' || key === 'event_msg:user_message') tally(`${key}:user`, 'ignored: harness context or a duplicate copy of a turn');
    else if (codexAssistantText(rec) != null) tally(`${key}:assistant`, 'ignored: duplicate copy of a turn');
    else tally(`${key}:${p.role ?? 'unknown'}`, 'ignored: no person or assistant text');
  }

  function call(p, r, at) {
    const name = typeof p.name === 'string' ? p.name : p.type === 'local_shell_call' ? 'local_shell' : 'unknown';
    const category = toolCategory(name);
    const args = parseArgs(p);
    const facts = { tool: name, category };
    const inferred = [];
    let command = null;
    if (!priv) {
      if (category === 'shell') {
        const program = typeof p.input === 'string' ? p.input : null;
        command = program != null ? execProgramCommand(program) : Array.isArray(args.command) ? args.command.join(' ') : typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : null;
        // A program the engine cannot reduce to one command is shown, never interpreted.
        facts.command = text(command ?? program, CMD_MAX);
        const shell = shellInterpretation(command);
        if (shell.testRunner) facts.testRunner = shell.testRunner;
        inferred.push(...shell.inferred);
      } else if (category === 'edit') {
        const patch = patchSummary(typeof p.input === 'string' ? p.input : typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : null);
        if (patch?.files.length) {
          facts.file = reducePath(absoluteIn(patch.files[0], ctx.cwd), ctx.cwd);
          facts.fileKeys = patch.files.map((x) => pathKey(absoluteIn(x, ctx.cwd))).sort();
          if (patch.files.length > 1) facts.filesInPatch = patch.files.length;
        }
        if (patch) Object.defineProperty(facts, '_patch', { value: { added: patch.added, removed: patch.removed }, enumerable: false });
      } else if (category === 'delegate') {
        facts.description = text(args.message ?? args.task ?? args.prompt, SHORT);
        facts.agentType = text(args.agent_type ?? args.role ?? null, 60);
      } else if (category === 'agent-message') {
        facts.to = text(args.recipient ?? args.to ?? args.task_name, 80);
      } else if (category === 'wait') {
        if (Number.isFinite(args.timeout_ms)) facts.timeoutMs = args.timeout_ms;
        if (Number.isFinite(args.duration_ms)) facts.durationMs = args.duration_ms;
      } else if (category === 'question') {
        facts.question = text(args.question ?? args.prompt ?? args.message, SHORT);
      }
    }
    const e = make('action', r, 0, { at, actor: 'agent', facts, inferred });
    Object.defineProperty(e, '_command', { value: command, enumerable: false });
    if (typeof p.call_id === 'string') joins.calls.set(p.call_id, e);
  }

  function result(p, r, at) {
    const e = joins.calls.get(p.call_id);
    if (!e) {
      anomalies.push({ kind: 'result-without-call', source: source.key, line: r.line });
      return;
    }
    const t = at ? Date.parse(at) : lastT;
    e.end = { at, t: Number.isFinite(t) ? t : e.t, ref: ref(r) };
    e.refs.push(e.end.ref);
    if (Number.isFinite(e.end.t - e.t)) e.derived.recordedSpanMs = e.end.t - e.t;
    const body = outputText(p.output);
    const parsed = typeof p.output === 'string' ? tryParse(p.output) : null;
    const exit = parsed?.metadata?.exit_code ?? (body.match(/(?:Exit code|Process exited with code):?\s*(-?\d+)/i)?.[1] ?? null);
    e.facts.result = exit == null ? 'recorded' : Number(exit) === 0 ? 'ok' : 'error';
    if (exit != null) e.facts.exitCode = Number(exit);
    // The lines a patch adds and removes are its own; they count once it applied.
    if (e.facts.result === 'ok' && e.facts._patch) e.derived.patch = e.facts._patch;
    if (e.facts.testRunner) {
      const s = parseTestSummary(parsed?.output ?? body);
      if (s) e.derived.tests = s;
      else e.missing.push('test-summary');
      e.facts.exitStatusBelongsToRunner = exit != null && !exitStatusIsAmbiguous(e._command);
    }
    // Codex records no git operations of its own; only printed output can nominate one.
    if (e.facts.category === 'shell' && !priv) {
      const n = outputNominations(e._command, parsed?.output ?? body, e);
      joins.commits.push(...n.commits);
      joins.prs.push(...n.prs);
    }
    if (e.facts.category === 'delegate') {
      const out = parsed ?? tryParse(body) ?? {};
      if (typeof out.task_name === 'string') joins.spawns.push({ agentPath: out.task_name, event: e });
      else e.missing.push('spawned-thread-name');
    }
    if (e.facts.category === 'wait' && parsed && typeof parsed.timed_out === 'boolean') e.facts.timedOut = parsed.timed_out;
    if (e.facts.category === 'question' && parsed && typeof parsed.accepted === 'boolean') {
      make('decision', r, 10, { at, actor: 'person', facts: { decision: parsed.accepted ? 'accepted-request' : 'declined-request', action: e.id } }).turn = e.turn;
    }
  }
}
