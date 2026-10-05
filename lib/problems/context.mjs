// lib/problems/context.mjs: what the problem checks share, built once over an engine history.
//
// It reads only the history: its sessions, agents, events, the token counts the engine's
// `usage` option records, and the raw inputs and text its `keepRaw` option keeps in memory.
// Only sessions in configured repositories that aren't display-only are read; display-only and
// outside sessions stay out, as they do from lookups and goals. Nothing here reads a file, runs
// git or writes anything, and no raw text leaves this module: a step keeps fixed words,
// booleans, counts and one-way fingerprints.

import { testRunResult } from '../replay/metrics.mjs';
import { absoluteIn, briefWords, checkClass, errorClass, errorLine, fileKind, fingerprint, GIT_BASE_CMD, isStateChange, normPath, PLAN_FILE_RE, parsePatch, readOnlyShell, shellFileRead, stable, statusOfShell, statusOfTool, TEST_CONFIG_RE, TEST_EXCLUSION, TEST_FILE_RE, testEditCounts, underFolder } from './classify.mjs';
import { testRunner } from '../replay/classify.mjs';
import { pathKey } from '../replay/ids.mjs';

/** Tunable cut-offs. Each check's description states the ones it uses, and a test pins those
 *  words to these numbers (test/problems-priority.test.mjs). */
export const THRESHOLDS = Object.freeze({
  loopMin: 3, // identical calls in a run before it counts as a loop
  loopGapMs: 10 * 60e3, // each identical call within this long of the last
  retryMin: 2, // failures of one unchanged command
  errorRunMin: 2, // the same error in a row
  errorGapMs: 10 * 60e3,
  editChainMin: 2, // failed edits to one file in a row
  smallSubagentCalls: 3, // a sub-agent with this many tool calls or fewer counts as small
  briefSimilarity: 0.8, // word overlap between two sub-agent briefs that counts as near-identical
  longCtx: 150_000, // context tokens past which an agent counts as large
  longAfterCalls: 30, // model calls after crossing that count as heavy work continuing
  freshBrief: 5_000, // tokens assumed for a hand-off brief in a fresh session
  rereadMin: 3, // reads of the same file and range, no change between
  rereadSmall: 500, // a repeat read that added fewer tokens than this is routine
  pollMin: 3, // the same status call, repeated
  pollGapMs: 10 * 60e3, // each repeat within this long of the last
  bigAdd: 20_000, // a single step that grew the context by this much
  waitLookMs: 30 * 60e3, // a gap after a question this long is worth a look
  outputRatio: 5, // a call's output per tool call this many times its session's median for the same model
  outputMin: 5_000, // and at least this many output tokens per tool call
  outputBaseline: 10, // calls one model needs in a session before their median is a baseline
  outputWrittenMax: 2_000, // a call that wrote more characters than this (tool inputs and its message) is left out
  stillRunningMs: 60 * 60e3, // a session that wrote a record this close to the build may still be running
});

const AGENT_WORD = { main: 'main agent', subagent: 'sub-agent', 'inline-sidechain': 'inline sub-agent', 'child-thread': 'Codex child thread', guardian: 'Codex guardian thread' };
const NEUTRAL_CATS = new Set(['wait', 'plan', 'meta', 'question', 'plan-approval', 'mode', 'deliver', 'stop', 'agent-message', 'handoff', 'read']);
const READ_TOOL = /__(?:screenshot|take_screenshot|browser_take_screenshot|preview_screenshot|zoom|read_page|get_page_text|find|browser_snapshot|preview_snapshot|snapshot|cursor_position)$|__(?:list|get|read|search|query)_/;
/** Records that aren't work by an agent: a turn's last work record is never one of these. */
export const NOT_WORK = new Set(['link', 'mode', 'quiet', 'queue', 'hook', 'outcome', 'turn-end', 'notice', 'compaction', 'external-edit', 'error', 'decision', 'interrupt', 'guard']);

export const isPersonPrompt = (e) => e.kind === 'prompt' && (e.actor === 'person' || e.actor === 'person-or-script');
/** What a `codex exec` run was told, at its start or later: the agent's, not a person's prompt
 *  (issue 62), but it still opens a turn, so the run's steps and problems show. */
export const isExecInstruction = (e) => (e.kind === 'delegation-received' || e.kind === 'agent-message') && e.facts?.from === 'codex-exec';
/** A file's identity when the engine gave none: the engine's own key for the absolute path
 *  (lib/replay/ids.mjs pathKey), so a read and an edit of one file always share a key. */
const pathId = (abs) => pathKey(abs) ?? normPath(abs);

/**
 * createContext(h, { builtT }) -> the shared context every check reads.
 * h: an engine history, best built with `usage: true` and `keepRaw: true`. Without usage the
 * token checks say so; without keepRaw the checks that read text or inputs find nothing to read.
 */
export function createContext(h, { builtT = Date.now() } = {}) {
  const sessionsByKey = new Map(h.sessions.map((s) => [s.key, s]));
  const configured = new Set(h.sessions.filter((s) => s.private === false).map((s) => s.key));
  const agentsByKey = new Map(h.agents.map((a) => [a.key, a]));
  const byId = new Map(h.events.map((e) => [e.id, e]));
  const cwdOf = h._raw?.cwdOfSource ?? new Map();
  const { startT, endT } = h.window;
  const inWin = (t) => Number.isFinite(t) && t >= startT && t < endT;
  const stillRunning = (key) => {
    const t = Date.parse(sessionsByKey.get(key)?.lastAt ?? '');
    return Number.isFinite(t) && builtT - t < THRESHOLDS.stillRunningMs;
  };
  const agentKind = (key) => agentsByKey.get(key)?.kind ?? (String(key).endsWith(':sidechain') ? 'inline-sidechain' : 'main');
  const agentWord = (key) => AGENT_WORD[agentKind(key)] ?? 'agent';

  // Events of configured sessions, in the engine's order, by session and by agent.
  const events = [];
  const eventsBySession = new Map();
  const eventsByAgent = new Map();
  const seqOf = new Map();
  h.events.forEach((e, i) => {
    if (!configured.has(e.session)) return;
    seqOf.set(e.id, i);
    events.push(e);
    (eventsBySession.get(e.session) ?? eventsBySession.set(e.session, []).get(e.session)).push(e);
    if (e.agent) (eventsByAgent.get(e.agent) ?? eventsByAgent.set(e.agent, []).get(e.agent)).push(e);
  });

  // Steps: every tool call, with the fields the checks compare.
  const steps = new Map();
  const stepsByAgent = new Map();
  let rawSteps = 0;
  for (const e of events) {
    if (e.kind !== 'action') continue;
    const s = deriveStep(e, seqOf.get(e.id), cwdOf.get(e.source) ?? null);
    if (s.raw) rawSteps++;
    steps.set(e.id, s);
    (stepsByAgent.get(e.agent) ?? stepsByAgent.set(e.agent, []).get(e.agent)).push(s);
  }

  // Model calls: each agent's recorded token counts, joined to the steps they issued and read.
  const usage = joinUsage(h, { configured, eventsByAgent, stepsByAgent, inWin });

  const turnCache = new Map();
  /** A session's turns: from each prompt a person typed to the next one. Every agent's events in
   *  between belong to the turn, so a sub-agent's work counts in its parent's turn. */
  function turnsOf(key) {
    if (turnCache.has(key)) return turnCache.get(key);
    const turns = [];
    let cur = null;
    for (const e of eventsBySession.get(key) ?? []) {
      if (isPersonPrompt(e) || isExecInstruction(e)) {
        cur = { prompt: e, events: [] };
        turns.push(cur);
        continue;
      }
      if (cur) cur.events.push(e);
    }
    for (const t of turns) t.steps = t.events.map((e) => steps.get(e.id)).filter(Boolean);
    turnCache.set(key, turns);
    return turns;
  }
  /** The turn's last main-agent message, when it is the main agent's last work record. */
  function finalMessage(turn) {
    const main = `${turn.prompt.session}:main`;
    const work = turn.events.filter((e) => e.agent === main && !NOT_WORK.has(e.kind) && (e.kind === 'message' || e.kind === 'action'));
    const last = work.at(-1);
    return last?.kind === 'message' ? last : null;
  }

  return {
    h,
    builtT,
    window: h.window,
    sessions: h.sessions.filter((s) => configured.has(s.key)),
    sessionsByKey,
    configured,
    agentsByKey,
    byId,
    events,
    eventsBySession,
    eventsByAgent,
    steps,
    stepsByAgent,
    cwdOf,
    usage,
    rawSteps,
    hasRaw: rawSteps > 0 || events.some((e) => e._raw),
    inWin,
    stillRunning,
    agentKind,
    agentWord,
    turnsOf,
    finalMessage,
  };
}

// ---- steps ------------------------------------------------------------------------------

function deriveStep(e, seq, cwd) {
  const raw = e._raw ?? null;
  const input = raw?.input && typeof raw.input === 'object' ? raw.input : null;
  const name = typeof raw?.tool === 'string' ? raw.tool : typeof e.facts?.tool === 'string' ? e.facts.tool : 'unknown';
  const cat = e.facts?.category ?? 'other';
  const s = { ev: e.id, seq, t: e.t, endT: Number.isFinite(e.end?.t) ? e.end.t : null, agent: e.agent, session: e.session, name, cat, result: e.facts?.result ?? null, raw: !!input, ref: e.refs?.[0] ?? null, endRef: e.end?.ref ?? null };
  if (e.facts?.background) s.background = true;
  // A step read from a Codex program's text rather than a record of it running.
  if (e.evidence === 'derived') s.derivedStep = true;
  const test = testRunResult(e);
  if (test) {
    s.test = test;
    if (e.derived?.tests) s.summary = { pass: e.derived.tests.pass ?? 0, fail: e.derived.tests.fail ?? 0 };
    // The engine counted failures in the command's recorded output (derived), not a rule's reading.
    if ((e.derived?.tests?.fail ?? 0) > 0 || (e.derived?.tests?.suitesFailed ?? 0) > 0) s.failuresInOutput = true;
  }
  if ((e.inferred ?? []).some((x) => x.rule === 'review.skill')) s.check = 'review skill';
  if (cat === 'browser' || /computer-use/i.test(name)) s.check = 'browser step';
  s.toolKey = name;
  if (raw?.error && s.result === 'error') {
    s.errClass = errorClass(cat, raw.error, e.facts?.exitCode);
    s.errSig = fingerprint(`${cat === 'edit' ? `edit|${e.facts?.fileKey ?? ''}` : cat === 'shell' ? 'shell' : name}|${s.errClass}|${errorLine(raw.error)}`);
  }
  if (cat === 'shell') {
    s.toolKey = 'shell';
    shellFields(s, typeof e._command === 'string' ? e._command : typeof input?.command === 'string' ? input.command : null, typeof e._workdir === 'string' && e._workdir ? e._workdir : typeof e._lineCwd === 'string' && e._lineCwd ? e._lineCwd : cwd);
    return s;
  }
  if (!input) {
    s.neutral = true;
    return s;
  }
  if (name === 'Read' || name === 'NotebookRead' || name === 'view_image' || cat === 'read') {
    s.neutral = true;
    const f = input.file_path ?? input.notebook_path ?? input.filePath ?? input.path;
    if (typeof f === 'string') {
      s.readFile = e.facts?.fileKey ?? pathId(absoluteIn(f, cwd));
      s.readFp = fingerprint(`rd|${s.readFile}|${input.offset ?? ''}|${input.limit ?? ''}|${input.pages ?? ''}`);
      s.readWhole = input.offset == null && input.limit == null && input.pages == null;
    }
    return s;
  }
  if (cat === 'edit') return editFields(s, e, name, input, cwd);
  if (cat === 'delegate') {
    s.fp = fingerprint(`dg|${name}|${stable(input)}`);
    const brief = typeof input.description === 'string' && input.description ? input.description : String(input.message ?? input.task ?? input.prompt ?? '').slice(0, 300);
    s.brief = briefWords(brief);
    return s;
  }
  if (cat === 'skill') {
    s.neutral = true;
    return s;
  }
  const status = statusOfTool(name);
  if (status) {
    s.neutral = true;
    s.status = status;
    s.pollFp = fingerprint(`tool|${name}|${stable(input)}`);
    return s;
  }
  if (/^mcp__/.test(name) || cat === 'browser' || cat === 'external') {
    let readOnly = READ_TOOL.test(name);
    if (/__computer$/.test(name)) readOnly = ['screenshot', 'zoom', 'wait', 'cursor_position'].includes(input.action);
    else if (/__browser_batch$/.test(name)) readOnly = Array.isArray(input.actions) && input.actions.every((a) => (a?.name === 'computer' && ['screenshot', 'zoom', 'wait'].includes(a?.input?.action)) || /^(?:read_page|get_page_text|find|read_console_messages|read_network_requests|tabs_context)$/.test(String(a?.name ?? '')));
    if (readOnly) s.neutral = true;
    else s.fp = fingerprint(`${name}|${stable(input)}`);
    return s;
  }
  if (NEUTRAL_CATS.has(cat)) {
    s.neutral = true;
    return s;
  }
  s.fp = fingerprint(`${name}|${stable(input)}`);
  return s;
}

function shellFields(s, cmd, cwd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    s.neutral = true;
    return;
  }
  const norm = cmd.trim().replace(/\s+/g, ' ');
  if (readOnlyShell(cmd)) s.neutral = true;
  else s.fp = fingerprint(`sh|${norm}`);
  // A line that is one read of one file is a file read (problems.shell-read). A whole-file read
  // has the read tool's whole-file fingerprint, so the two ways of reading a file compare equal.
  const rd = shellFileRead(cmd);
  if (rd) {
    s.readFile = pathId(absoluteIn(rd.file, cwd));
    s.readFp = fingerprint(rd.whole ? `rd|${s.readFile}|||` : `rd|${s.readFile}|sh:${rd.range}`);
    s.readWhole = rd.whole;
    s.shellRead = true;
  }
  const cls = checkClass(cmd);
  if (cls) s.check = cls;
  const runner = testRunner(cmd);
  if (runner) {
    s.runner = runner;
    s.testExcl = TEST_EXCLUSION.test(norm);
  }
  if (GIT_BASE_CMD.test(norm)) s.gitBase = true;
  const st = statusOfShell(norm);
  if (st) {
    s.status = st.cls;
    s.pollFp = fingerprint(`poll|${st.part}`);
  }
  if (isStateChange(norm)) s.stateChange = true;
  // The command text, for the checks that read it (risky commands, commits). It's never
  // enumerable, and no finding carries it.
  Object.defineProperty(s, 'cmd', { value: cmd, enumerable: false });
}

function editPart(abs, pairs, { whole, op, cwd, key }) {
  const n = normPath(abs);
  const p = { key: key ?? pathId(abs), kind: fileKind(n), test: TEST_FILE_RE.test(n), testConfig: TEST_CONFIG_RE.test(n), whole, planFile: PLAN_FILE_RE.test(n), inRepo: underFolder(n, cwd), deleted: op === 'delete' };
  if ((p.test || p.testConfig) && !whole && op !== 'delete') {
    const t = { assertNet: 0, testsNet: 0, skipAdded: 0, exitAdded: 0, commentedAdded: 0 };
    for (const [o, nw] of pairs) {
      const x = testEditCounts(o, nw);
      for (const k of Object.keys(t)) t[k] += x[k];
    }
    p.tests = t;
  }
  return p;
}

function editFields(s, e, name, input, cwd) {
  const patch = typeof input.input === 'string' ? input.input : typeof input.patch === 'string' ? input.patch : null;
  if (patch != null && (name === 'apply_patch' || /\*\*\* Begin Patch/.test(patch))) {
    s.fp = fingerprint(`ed|${stable(patch)}`);
    const files = parsePatch(patch);
    if (!files.length) return s;
    const parts = files.map((f) => editPart(absoluteIn(f.path, cwd), [[f.del.join('\n'), f.add.join('\n')]], { whole: f.op === 'add', op: f.op, cwd }));
    const first = parts[0];
    const keys = e.facts?.fileKeys ?? parts.map((p) => p.key);
    s.edit = { key: keys[0] ?? first.key, keys, kind: parts.some((p) => p.kind === 'code') ? 'code' : parts.some((p) => p.kind === 'test') ? 'test' : first.kind, test: parts.some((p) => p.test), testConfig: parts.some((p) => p.testConfig), whole: parts.every((p) => p.whole), planFile: false, inRepo: parts.some((p) => p.inRepo), deleted: parts.some((p) => p.deleted && p.test) };
    // A patch to one existing file has its removed and added lines, as an Edit has its old and new
    // text, so an edit undone and redone reads the same on Codex.
    if (files.length === 1 && files[0].op === 'update' && (files[0].del.length || files[0].add.length)) s.edit.flip = { file: s.edit.key, from: fingerprint(files[0].del.join('\n')), to: fingerprint(files[0].add.join('\n')) };
    Object.defineProperty(s.edit, 'paths', { value: files.map((f) => absoluteIn(f.path, cwd)), enumerable: false });
    const withTests = parts.filter((p) => p.tests);
    if (withTests.length) {
      s.edit.tests = { assertNet: 0, testsNet: 0, skipAdded: 0, exitAdded: 0, commentedAdded: 0 };
      for (const p of withTests) for (const k of Object.keys(s.edit.tests)) s.edit.tests[k] += p.tests[k];
    }
    s.toolKey = `edit|${s.edit.key}`;
    return s;
  }
  const f = input.file_path ?? input.notebook_path ?? input.filePath;
  if (typeof f !== 'string') {
    s.fp = fingerprint(`${name}|${stable(input)}`);
    return s;
  }
  const pairs = name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.map((x) => [x?.old_string, x?.new_string]) : name === 'Write' ? [[null, input.content]] : name === 'NotebookEdit' ? [[null, input.new_source]] : [[input.old_string, input.new_string]];
  const whole = name === 'Write' || name === 'NotebookEdit';
  const key = e.facts?.fileKey ?? null;
  s.edit = editPart(absoluteIn(f, cwd), pairs, { whole, op: null, cwd, key });
  s.edit.keys = [s.edit.key];
  // The edited file's path, for the checks that ask where it is. Never enumerable: no finding carries it.
  Object.defineProperty(s.edit, 'paths', { value: [absoluteIn(f, cwd)], enumerable: false });
  s.fp = fingerprint(`ed|${s.edit.key}|${stable(pairs)}`);
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') s.edit.flip = { file: s.edit.key, from: fingerprint(input.old_string), to: fingerprint(input.new_string) };
  s.toolKey = `edit|${s.edit.key}`;
  return s;
}

// ---- token counts joined to steps ---------------------------------------------------------

/**
 * Each agent's model calls in file order, with each step's issuing and reading call and its
 * estimated cost (cost.step). A Claude Code step is issued by the call whose records hold its
 * line and read by the first call after its result's line; a Codex step is issued by the first
 * token count after its line and read by the first one after its result's line.
 */
function joinUsage(h, { configured, eventsByAgent, stepsByAgent, inWin }) {
  const calls = Array.isArray(h.usage?.calls) ? h.usage.calls : null;
  const out = { recorded: !!calls, agents: new Map(), allTokens: 0, liveCalls: 0 };
  if (!calls) return out;
  for (const c of calls) {
    if (!configured.has(c.session)) continue;
    const a = out.agents.get(c.agent) ?? out.agents.set(c.agent, { key: c.agent, session: c.session, tool: c.tool, calls: [] }).get(c.agent);
    const ctx = c.input + c.cacheWrite + c.cacheRead;
    a.calls.push({ ...c, ctx, total: ctx + c.output, live: inWin(c.t), consumed: 0 });
  }
  for (const a of out.agents.values()) {
    a.calls.sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : x.lines[0] - y.lines[0]));
    a.liveCalls = a.calls.filter((x) => x.live);
    for (const x of a.liveCalls) out.allTokens += x.total;
    out.liveCalls += a.liveCalls.length;
    // Compactions this agent recorded: a call after one starts a fresh context.
    const compT = (eventsByAgent.get(a.key) ?? []).filter((e) => e.kind === 'compaction').map((e) => e.t);
    const bounds = [...new Set(compT.map((t) => a.calls.findIndex((x) => Number.isFinite(x.t) && x.t > t)).filter((i) => i >= 0))].sort((x, y) => x - y);
    a.compactions = compT;
    const lineIdx = new Map();
    a.calls.forEach((x, i) => x.lines.forEach((l) => lineIdx.set(`${x.source}|${l}`, i)));
    const steps = stepsByAgent.get(a.key) ?? [];
    const firstAfter = (src, line, from = 0) => {
      for (let i = from; i < a.calls.length; i++) if (a.calls[i].source === src && a.calls[i].lines[0] > line) return i;
      return -1;
    };
    for (const s of steps) {
      const ownRef = s.ref;
      const endRef = s.endRef;
      if (!ownRef) continue;
      const issued = a.tool === 'codex' ? firstAfter(ownRef.src, ownRef.line) : lineIdx.get(`${ownRef.src}|${ownRef.line}`) ?? -1;
      s.issuedBy = issued >= 0 ? issued : null;
      if (!endRef) continue;
      const read = firstAfter(endRef.src, endRef.line, issued >= 0 ? issued + 1 : 0);
      if (read < 0) continue;
      s.consumedBy = read;
      a.calls[read].consumed += 1;
    }
    const liveBefore = new Array(a.calls.length + 1).fill(0);
    for (let i = 0; i < a.calls.length; i++) liveBefore[i + 1] = liveBefore[i] + (a.calls[i].live ? 1 : 0);
    const nextBound = (k) => bounds.find((b) => b > k) ?? a.calls.length;
    for (const s of steps) {
      s.cost = { rt: 0, added: 0, carry: 0, later: 0, total: 0, compactedAfter: false };
      const k = s.consumedBy;
      if (k == null) continue;
      const cons = a.calls[k];
      if (cons.live) s.cost.rt = cons.ctx / Math.max(1, cons.consumed);
      const i = s.issuedBy;
      const crossed = i != null && bounds.some((b) => b > i && b <= k);
      if (i != null && k > i && !crossed) {
        // The issuing call's own output (its text, thinking and the input it wrote) is in the
        // growth too, and it isn't the result's, so it comes off. The rest is split evenly among the
        // results that call read, and anything else the harness added between the calls stays in,
        // so this is an estimate either way.
        const grow = cons.ctx - a.calls[i].ctx - (a.calls[i].output ?? 0);
        if (grow > 0) s.cost.added = grow / Math.max(1, cons.consumed);
      }
      const nb = nextBound(k);
      s.cost.later = liveBefore[Math.min(nb, a.calls.length)] - liveBefore[k + 1];
      s.cost.compactedAfter = nb < a.calls.length;
      s.cost.carry = s.cost.added * s.cost.later;
      s.cost.total = s.cost.rt + s.cost.carry;
    }
  }
  return out;
}
