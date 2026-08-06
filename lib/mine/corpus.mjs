// lib/mine/corpus.mjs — the multi-agent session corpus reader.
//
// `honestweek mine` needs to read WHOLE sessions across MORE THAN ONE agent tool,
// which is a different job from lib/claude-adapter.mjs (one tool, one week, digest
// entries). This module is the tool-neutral reader: it enumerates every session log
// a configured corpus root yields, streams each one, and normalizes the three
// on-disk dialects into a single event shape the detector can score.
//
// It reuses claude-adapter's enumeration and bounded-head reader rather than
// re-deriving them, so "where do Claude Code logs live" has one implementation.
//
// ============================================================================
// THE THREE DIALECTS
// ----------------------------------------------------------------------------
// claude-code  <root>/<encoded-cwd>/<sessionId>.jsonl
//     user   : {type:"user", message:{role:"user", content: string | Block[]}}
//     asst   : {type:"assistant", message:{content:[{type:"text"|"thinking"|"tool_use"}]}}
//     result : a user record whose content array holds {type:"tool_result"}
// cowork      <root>/<org>/<user>/<sessionId>/local_<cwd>/audit.jsonl (+ nested
//             .claude/projects/**) — same records as claude-code, PLUS
//     enqueue: {type:"queue-operation", operation:"enqueue", content: string}
// codex       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//     meta   : {type:"session_meta", payload:{cwd, cli_version, source, ...}}
//     user   : {type:"event_msg", payload:{type:"user_message", message: string}}
//     asst   : {type:"event_msg", payload:{type:"agent_message", message: string}}
//     call   : {type:"response_item", payload:{type:"function_call"|"custom_tool_call",
//                                              name, arguments|input, call_id}}
//     output : {type:"response_item", payload:{type:"..._call_output", output}}
// ============================================================================
//
// MEASURED CORPUS FACTS (this machine, 2026-08-06) — recorded because they bound
// what the sensor can ever see, and a reader who assumes otherwise will overclaim:
//   - claude-code carries 2,606 files whose oldest is 2026-05-07. Claude Code
//     deletes transcripts older than `cleanupPeriodDays` (default 30) at startup,
//     so everything before that floor is GONE and raising the setting cannot bring
//     it back. `corpusFloor` reports the floor so a caller never reads "no findings
//     before May" as "nothing happened before May".
//   - 1,106 of those files carry the first human turn as an ARRAY of text blocks,
//     not a string. A reader that only accepts string content silently drops 42%
//     of the corpus. `humanText()` accepts both.
//   - Redundant copies of one logical session: 7.8% of keyed claude-code files and
//     0.3% of keyed cowork files, keyed on (first-prompt timestamp + first 200
//     chars). Deduped by that key in `enumerateSessions`.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { enumerateSessionFiles, readHead, resolveProjectsRoot } from '../claude-adapter.mjs';

/** Cap on bytes streamed per session. A runaway 18MB transcript must not stall a
 *  scan; the detector's signals all appear in ordinary-sized sessions. Sessions
 *  truncated by this cap are counted in `truncated` so the cost is visible. */
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;

/** Wrapper prefixes that look like a human turn but are harness scaffolding.
 *  Every one of these was observed in the corpora; dropping them is what keeps a
 *  count of "sessions where a human asked for something" honest. */
// `command-[\w-]*` is open-ended on purpose. A closed list of the three command
// wrappers seen most often (`-message`, `-name`, `-args`) let every other one —
// `<command-stdout>`, `<command-contents>` — count as a human turn, which broke the
// superset relationship this predicate documents below and inflated the human-turn
// count that the ranker uses as an effort proxy.
const PSEUDO_PROMPT_RE =
  /^\s*<(system-reminder|command-[\w-]*|task-notification|local-command|codex_delegation|user-prompt-submit-hook)\b/i;

/** An automated operator probe: a status block a scheduler pastes in, not a human. */
const OPERATOR_PROBE_RE = /^\s*(Project(\s+state)?\s*:|Git\s*:\s*branch\b)/i;

/** An agent system-prompt handed to a subagent, not a human turn. */
const AGENT_PROMPT_RE = /^\s*(You are|Your task|<task>|You will be|ROLE:)\b/i;

/**
 * Is `text` a real human-typed turn?
 *
 * Deliberately NOT shared with lib/site/sessions.mjs's `isInteractiveFirstPrompt`,
 * which answers a narrower question (is this session's FIRST turn interactive) and
 * whose output is a published weekly number. This predicate is a superset — it adds
 * the codex delegation wrapper and the mid-session cases — and changing the site
 * deriver to match would move a published count, which is not this feature's call
 * to make. The overlap is intentional and documented rather than silently forked.
 */
export function isHumanText(text) {
  if (typeof text !== 'string') return false;
  // Look past a leading injected reminder before judging the rest.
  const t = text.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/i, '').trim();
  if (!t) return false;
  if (PSEUDO_PROMPT_RE.test(t)) return false;
  if (OPERATOR_PROBE_RE.test(t)) return false;
  if (AGENT_PROMPT_RE.test(t)) return false;
  return true;
}

/** Flatten a message content field (string, or an array of blocks) to text. */
export function humanText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // A tool_result block anywhere means this is the assistant's tool output wrapped
  // as a user record — never a human turn.
  if (content.some((b) => b && b.type === 'tool_result')) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/** ~/.codex/sessions, or $CODEX_HOME/sessions. */
export function resolveCodexRoot(env = process.env) {
  const base = env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(homedir(), '.codex');
  return join(base, 'sessions');
}

/** The Cowork / Claude Desktop local-agent-mode root. Both the current and the
 *  rename-target directory names are checked; the rename has been in progress
 *  since ~2026-05 and either may hold the data. */
export function resolveCoworkRoots(env = process.env) {
  const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return [join(appData, 'Claude', 'local-agent-mode-sessions'), join(appData, 'Claude', 'claude-code-sessions')];
}

// ---------------------------------------------------------------------------
// Enumeration, per corpus
// ---------------------------------------------------------------------------

function walkJsonl(dir, out, opts = {}) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // Subagent transcripts hold the assistant's instruction to a subagent, never a
      // human turn. Counting them would inflate every per-session number.
      if (e.name === 'subagents') continue;
      walkJsonl(p, out, opts);
    } else if (e.name.endsWith('.jsonl')) {
      if (opts.namePrefix && !e.name.startsWith(opts.namePrefix)) continue;
      out.push(p);
    }
  }
  return out;
}

/** Every session-log path a corpus root yields, subagent transcripts excluded. */
export function enumerateCorpusFiles(kind, root) {
  if (!root || !existsSync(root)) return [];
  if (kind === 'claude-code') return enumerateSessionFiles(root);
  if (kind === 'codex') return walkJsonl(root, [], { namePrefix: 'rollout-' });
  if (kind === 'cowork') return walkJsonl(root, []);
  return [];
}

// ---------------------------------------------------------------------------
// Head probe — identity, dedupe key, and cheap rejection
// ---------------------------------------------------------------------------

function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Probe a session's head for { startISO, cwd, firstPrompt, isSubagent }.
 *
 * `firstPrompt` is the first HUMAN turn (pseudo-prompts skipped). It is both the
 * "was a person here" test and half the dedupe key. Returns null when the head
 * yields no usable identity.
 */
export function probeSession(kind, file) {
  const { lines } = readHead(file);
  let startISO = null;
  let cwd = null;
  let firstPrompt = null;
  let firstPromptISO = null;
  let isSubagent = false;

  for (const line of lines) {
    const rec = tryParse(line);
    if (!rec) continue;

    if (kind === 'codex') {
      if (rec.type === 'session_meta') {
        const p = rec.payload || {};
        if (cwd == null && typeof p.cwd === 'string') cwd = p.cwd;
        if (startISO == null && typeof rec.timestamp === 'string') startISO = rec.timestamp;
        // A forked thread with a subagent source is an agent transcript, not a session.
        if (p.forked_from_id || (p.source && typeof p.source === 'object' && p.source.subagent)) isSubagent = true;
      } else if (rec.type === 'event_msg' && rec.payload?.type === 'user_message') {
        const text = typeof rec.payload.message === 'string' ? rec.payload.message : '';
        if (firstPrompt == null && isHumanText(text)) {
          firstPrompt = text;
          firstPromptISO = typeof rec.timestamp === 'string' ? rec.timestamp : startISO;
        }
      }
      continue;
    }

    // claude-code + cowork share the record vocabulary.
    if (rec.isSidechain === true) isSubagent = true;
    if (startISO == null && typeof rec.timestamp === 'string') startISO = rec.timestamp;
    if (cwd == null && typeof rec.cwd === 'string') cwd = rec.cwd;

    if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
      if (firstPrompt == null && isHumanText(rec.content)) {
        firstPrompt = rec.content;
        firstPromptISO = typeof rec.timestamp === 'string' ? rec.timestamp : startISO;
      }
    } else if (rec.type === 'user' && rec.message?.role === 'user') {
      const text = humanText(rec.message.content);
      if (firstPrompt == null && isHumanText(text)) {
        firstPrompt = text;
        firstPromptISO =
          typeof rec.timestamp === 'string' ? rec.timestamp : typeof rec._audit_timestamp === 'string' ? rec._audit_timestamp : startISO;
      }
    }
  }

  if (!firstPrompt) return null;
  return { startISO: firstPromptISO ?? startISO, cwd, firstPrompt, firstPromptISO, isSubagent };
}

/** The dedupe key for one logical session: when the first human turn happened, and
 *  what it said. A resumed or re-written session replays both. */
export function sessionKey(probe) {
  return `${probe.firstPromptISO ?? probe.startISO ?? ''}|${probe.firstPrompt.slice(0, 200)}`;
}

// ---------------------------------------------------------------------------
// Streaming event normalization
// ---------------------------------------------------------------------------

function codexToolCall(payload) {
  const name = typeof payload.name === 'string' ? payload.name : 'unknown';
  // custom_tool_call carries a JS snippet in `input`; function_call carries JSON
  // in `arguments`. Both are scanned as text — the detector wants the command line,
  // not a parsed structure.
  const raw = typeof payload.input === 'string' ? payload.input : typeof payload.arguments === 'string' ? payload.arguments : '';
  return { name, text: raw };
}

function codexOutputText(payload) {
  const o = payload.output;
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return o.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  return '';
}

function claudeResultText(block) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) return block.content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  return '';
}

/**
 * Stream one session file, yielding normalized events:
 *   { kind: 'human',    text }
 *   { kind: 'assistant',text }
 *   { kind: 'tool_use', name, text }     text = the command / raw input, scanned only
 *   { kind: 'result',   text, isError, tool }
 *
 * `tool` on a result is the name of the call it answers, resolved through the
 * tool-use id. It is what lets a consumer tell PROGRAM OUTPUT from FILE CONTENT: the
 * body of a Read is a file someone wrote, and mining it for error messages produces
 * confident findings about sentences in a document.
 *
 * Bounded by MAX_SESSION_BYTES. Returns { events, truncated, lines }.
 */
export async function streamSession(kind, file, { maxBytes = MAX_SESSION_BYTES } = {}) {
  const events = [];
  const toolById = new Map(); // tool_use id / call_id -> tool name
  let bytes = 0;
  let lines = 0;
  let truncated = false;

  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      bytes += line.length + 1;
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
      lines += 1;
      const rec = tryParse(line);
      if (!rec) continue;

      if (kind === 'codex') {
        const p = rec.payload;
        if (!p || typeof p !== 'object') continue;
        if (rec.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
          if (isHumanText(p.message)) events.push({ kind: 'human', text: p.message });
        } else if (rec.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') {
          events.push({ kind: 'assistant', text: p.message });
        } else if (rec.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
          const { name, text } = codexToolCall(p);
          if (p.call_id) toolById.set(p.call_id, name);
          events.push({ kind: 'tool_use', name, text });
        } else if (rec.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
          const text = codexOutputText(p);
          // Codex has no is_error flag; the shell wrapper prints its own failure banner.
          events.push({
            kind: 'result',
            text,
            isError: /^\s*Script (failed|error)|\bExit code:\s*[1-9]/m.test(text),
            tool: toolById.get(p.call_id) ?? null,
          });
        }
        continue;
      }

      if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
        if (isHumanText(rec.content)) events.push({ kind: 'human', text: rec.content });
      } else if (rec.type === 'user' && rec.message?.role === 'user') {
        const content = rec.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              events.push({
                kind: 'result',
                text: claudeResultText(block),
                isError: block.is_error === true,
                tool: toolById.get(block.tool_use_id) ?? null,
              });
            }
          }
        }
        const text = humanText(content);
        if (text && isHumanText(text)) events.push({ kind: 'human', text });
      } else if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content) {
          if (block?.type === 'text' && typeof block.text === 'string') events.push({ kind: 'assistant', text: block.text });
          else if (block?.type === 'thinking' && typeof block.thinking === 'string') events.push({ kind: 'assistant', text: block.thinking });
          else if (block?.type === 'tool_use') {
            const input = block.input && typeof block.input === 'object' ? block.input : {};
            const parts = [];
            for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
              if (typeof input[k] === 'string') parts.push(input[k]);
            }
            const name = typeof block.name === 'string' ? block.name : 'unknown';
            if (block.id) toolById.set(block.id, name);
            events.push({ kind: 'tool_use', name, text: parts.join(' ') });
          }
        }
      }
    }
  } finally {
    rl.close();
  }

  return { events, truncated, lines };
}

// ---------------------------------------------------------------------------
// The public sweep
// ---------------------------------------------------------------------------

/** The corpus kinds this reader understands. Anything else is a caller error. */
export const CORPUS_KINDS = ['claude-code', 'codex', 'cowork'];

/**
 * Resolve which corpora to scan. `corpora` is a list of kinds; a root may be
 * overridden (tests, or a non-default CODEX_HOME).
 *
 * Throws on a kind outside CORPUS_KINDS. An unknown kind used to fall out of the
 * chain below producing NO row, so `--corpus claud-code` resolved to zero corpora,
 * zero diagnostics, sensorOk true, exit 0 — a sensor that never looked, reporting
 * success. That is the exact silent failure the diagnostics exist to prevent.
 */
export function resolveCorpora({ corpora, roots = {}, env = process.env } = {}) {
  const wanted = Array.isArray(corpora) && corpora.length ? corpora : CORPUS_KINDS;
  const out = [];
  for (const kind of wanted) {
    if (!CORPUS_KINDS.includes(kind)) {
      throw new Error(`unknown corpus ${JSON.stringify(kind)}; valid: ${CORPUS_KINDS.join(', ')}`);
    }
    if (kind === 'claude-code') out.push({ kind, root: roots['claude-code'] ?? resolveProjectsRoot(env) });
    else if (kind === 'codex') out.push({ kind, root: roots.codex ?? resolveCodexRoot(env) });
    else if (kind === 'cowork') {
      const explicit = roots.cowork;
      if (explicit) out.push({ kind, root: explicit });
      else {
        const candidates = resolveCoworkRoots(env);
        const found = candidates.filter((r) => existsSync(r));
        // Always emit at least one row, even when no root exists. A kind that produced
        // NO row was invisible to the caller's blind-sensor check, so `--corpus cowork`
        // on a machine with no cowork directory printed an empty table and exited 0 —
        // a zero from a sensor that never looked, which is exactly what that check is
        // for. An absent root is reported as `present: false` and judged there.
        if (found.length === 0) out.push({ kind, root: candidates[0] });
        else for (const root of found) out.push({ kind, root });
      }
    }
  }
  return out;
}

/**
 * enumerateSessions({ corpora, roots, since, env }) -> { sessions, diagnostics }
 *
 * One entry per DEDUPED logical session, newest first. `diagnostics` is the
 * silent-failure guard: it separates "looked and found nothing" from "did not
 * look". A corpus that was configured but yielded zero files reports
 * `filesFound: 0`, which the caller must treat as an error, not an empty week.
 */
export function enumerateSessions({ corpora, roots, since = null, env = process.env } = {}) {
  const resolved = resolveCorpora({ corpora, roots, env });
  const diagnostics = { corpora: [], deduped: 0, subagentsSkipped: 0, unprobeable: 0 };
  const byKey = new Map();

  for (const { kind, root } of resolved) {
    const files = enumerateCorpusFiles(kind, root);
    const diag = { kind, root, present: existsSync(root), filesFound: files.length, filesProbed: 0, accepted: 0, oldest: null, newest: null };

    for (const file of files) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      // mtime is a coarse pre-filter only; the authoritative date is the first
      // prompt's own timestamp, checked below.
      if (since && st.mtimeMs < since.getTime() - 36 * 3600 * 1000) continue;
      diag.filesProbed += 1;

      const probe = probeSession(kind, file);
      if (!probe) {
        diagnostics.unprobeable += 1;
        continue;
      }
      if (probe.isSubagent) {
        diagnostics.subagentsSkipped += 1;
        continue;
      }
      const startedAt = probe.startISO ? new Date(probe.startISO) : null;
      if (!startedAt || Number.isNaN(startedAt.getTime())) {
        diagnostics.unprobeable += 1;
        continue;
      }
      if (since && startedAt < since) continue;

      const key = sessionKey(probe);
      if (byKey.has(key)) {
        diagnostics.deduped += 1;
        // Prefer the larger file: the same session written twice is often a
        // truncated copy plus a complete one.
        const prev = byKey.get(key);
        if (st.size > prev.size) byKey.set(key, { ...prev, file, kind, size: st.size });
        continue;
      }
      byKey.set(key, { key, kind, file, size: st.size, cwd: probe.cwd, startedAt: probe.startISO, firstPrompt: probe.firstPrompt });
      diag.accepted += 1;
      const d = probe.startISO.slice(0, 10);
      if (!diag.oldest || d < diag.oldest) diag.oldest = d;
      if (!diag.newest || d > diag.newest) diag.newest = d;
    }
    diagnostics.corpora.push(diag);
  }

  const sessions = [...byKey.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  // The retention floor: the oldest session any corpus still holds. Anything before
  // it was deleted by the agent's own log cleanup and can never be mined.
  diagnostics.corpusFloor = diagnostics.corpora.reduce((min, c) => (c.oldest && (!min || c.oldest < min) ? c.oldest : min), null);
  return { sessions, diagnostics };
}
