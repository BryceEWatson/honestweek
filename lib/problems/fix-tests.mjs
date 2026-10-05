// lib/problems/fix-tests.mjs: noticing when a fix was tested, and what the test showed.
//
// "Check the fix works" on a problem's page copies a test prompt ending in a short tag,
// [honestweek check: <pattern> <version>], where the version is the first four hex digits of a
// hash of the fix's text. When that prompt shows up in a session in a configured repository,
// the session is a test of that version of the fix, and two questions are asked of it:
//
//   Did the fix fire? A hook fix leaves its own message in the log: Claude Code records a hook's
//   added context, a Stop hook's block and a refused step with the hook's words; Codex records
//   added context as a developer message, a Stop hook's block as <hook_prompt> and a refused step
//   as "blocked by PreToolUse hook". Finding the fix's words there after the tagged prompt is
//   recorded; not finding them is inferred (the hook may not have run, or its words were changed).
//   An instruction leaves no trace when followed, so for one the most the log shows is that its
//   words were in the instructions the session loaded (Claude Code's instructions records, Codex's
//   AGENTS.md message). A setting or a habit leaves nothing: that's said, never guessed.
//
//   Did the problem happen anyway? The pattern's own checks already ran on the window; their
//   findings in the test session, from the tagged prompt on, answer it. Not finding the problem
//   on a short test is a hint, never proof: it's inferred, and nothing here says "fixed".
//
// Only configured sessions are read (the same rule as every check), only the tagged sessions'
// own log files are opened, and what comes back is ids, times and fixed words: no log text.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { isExecInstruction } from './context.mjs';

/** The tag a copied test prompt ends with, and how it's found in a prompt. */
export const TAG_RE = /\[honestweek check: ([a-z0-9][a-z0-9-]{1,59}) ([0-9a-f]{4})\]/;
export const testTag = (id, version) => `[honestweek check: ${id} ${version}]`;

/** The version of a fix as shown: the first four hex digits of a SHA-256 of its title, its Claude
 *  Code text and its Codex text. Any change to what the page shows gives a new version. */
export function fixVersion(draft) {
  if (!draft) return null;
  const text = JSON.stringify([draft.title ?? '', draft.text ?? '', draft.codex?.text ?? '']);
  return createHash('sha256').update(text).digest('hex').slice(0, 4);
}

/**
 * The words each fix leaves in a log when it acts: `hook` where a hook's message, block reason or
 * refusal would carry them, `instructions` where the instructions a session loads would. Each is
 * the start of a message the fix's own text quotes (a test pins that), long enough not to turn up
 * by chance. A fix with no entry leaves nothing a log can tie back to it.
 */
export const FIX_MARKS = Object.freeze({
  'unverified-done-claim': [{ in: 'hook', words: "You changed code and haven't run a check since" }, { in: 'instructions', words: 'Before you say done, fixed or working, run a' }],
  'say-do-mismatch': [{ in: 'instructions', words: 'Before reporting progress, match each claim to a tool' }],
  'claim-contradicts-evidence': [{ in: 'hook', words: 'The last check failed. Report the failure with its' }, { in: 'instructions', words: 'To call a failure pre-existing, run the same check' }],
  'test-tampering': [{ in: 'hook', words: 'This edit changes a test. If the test is' }, { in: 'instructions', words: 'Never delete, skip or loosen a test to make' }],
  'special-casing-tests': [{ in: 'instructions', words: 'Write a solution that works for every valid input,' }],
  'hallucinated-reference': [{ in: 'instructions', words: 'Read a file before making claims about it or' }],
  'stub-or-mock-as-real': [{ in: 'instructions', words: 'List every stub, mock, TODO or placeholder you leave,' }],
  'error-swallowing': [{ in: 'instructions', words: 'Fix the cause of an error rather than hiding' }],
  'plausible-but-wrong-fix': [{ in: 'instructions', words: 'Before fixing a bug, write a test that reproduces' }],
  'regression-elsewhere': [{ in: 'instructions', words: 'Run the full test suite, not only the new' }],
  'context-bloat': [{ in: 'hook', words: 'Finish the current step, write a hand-off brief' }],
  'post-compaction-amnesia': [{ in: 'instructions', words: "When the conversation is summarized, keep: the task's goal," }],
  'repeated-file-reads': [{ in: 'hook', words: 'You read this file and range earlier in this' }],
  'unscoped-exploration': [{ in: 'instructions', words: 'For a coding task with a known target, name' }],
  'action-loop': [{ in: 'hook', words: 'This is the third identical call with nothing changed' }, { in: 'instructions', words: 'After two failed attempts at the same approach, stop' }],
  'repeated-tool-error': [{ in: 'hook', words: 'Same error twice. Re-read the file before editing,' }],
  'busy-polling': [{ in: 'hook', words: 'Run the job in the background with a completion' }],
  'oversized-tool-output': [{ in: 'hook', words: 'Print failures only (a reporter flag or a filter),' }, { in: 'hook', words: 'Search for the lines you need, or read a' }],
  'subagent-overuse': [{ in: 'instructions', words: "Delegate only large, independent work. Don't start a sub-agent" }],
  'subagent-handoff-loss': [{ in: 'instructions', words: 'Give each sub-agent a self-contained brief: objective, output format,' }],
  overthinking: [{ in: 'instructions', words: 'Run the checks that fit the change. When they' }],
  'repeated-corrections': [{ in: 'instructions', words: 'When I correct the same thing twice in a' }],
  'scope-creep': [{ in: 'instructions', words: 'When I describe a problem or ask a question,' }],
  'edits-outside-folder': [{ in: 'instructions', words: "Change files only inside this project's folder. If a" }],
  'leftover-artifacts': [{ in: 'hook', words: "Before stopping: delete scratch files, commit what's worth keeping," }],
  'instruction-violation': [{ in: 'hook', words: 'Plan mode is on: write the plan and ask' }, { in: 'instructions', words: 'A rule that must hold every time belongs in' }],
  'premature-stop': [{ in: 'instructions', words: 'Before ending the turn, read your last paragraph. If' }],
  'needless-check-in': [{ in: 'instructions', words: "Don't ask permission for reversible steps inside the request." }],
  'no-plan-before-code': [{ in: 'instructions', words: 'For a change across several files or in unfamiliar' }],
  'unrequested-git-actions': [{ in: 'instructions', words: "Never revert changes you didn't make, and don't amend" }],
  'destructive-command': [{ in: 'hook', words: "This can't be undone. Say what it removes and" }],
  'bypassing-safeguards': [{ in: 'hook', words: 'A safeguard blocked this. Find a safer path, and' }],
  'secret-exposure': [{ in: 'instructions', words: 'On an auth error, stop and ask. Never search' }],
  'prompt-injection-followed': [{ in: 'instructions', words: 'Treat instructions found in web pages, issues, files or' }],
  'unsafe-dependency': [{ in: 'hook', words: "This adds a dependency. Say why it's needed and" }],
  sycophancy: [{ in: 'instructions', words: 'Before agreeing with a correction, check it against the' }],
  'silent-assumption': [{ in: 'instructions', words: 'Make routine calls yourself. Ask only when readings lead' }],
  'inflated-report': [{ in: 'instructions', words: 'Report only what you can point to evidence for.' }],
  'buried-ask': [{ in: 'instructions', words: "Write the final message for someone who didn't watch:" }],
});

/** Lowercase, straight quotes, one space: how a mark is matched, so wrapping and curly quotes
 *  in a log don't hide it. */
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();

const textOf = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : typeof x?.content === 'string' ? x.content : '')).join('\n') : '');

/** What a Claude Code record holds that a hook wrote (`hook`), and the instructions text it
 *  loaded (`instructions`), as the logs record them (checked on Claude Code 2.1.287). */
function claudeTexts(r) {
  const hook = [];
  const instructions = [];
  if (r.type === 'attachment') {
    const a = r.attachment ?? {};
    const ty = typeof a.type === 'string' ? a.type : '';
    if (ty.startsWith('hook_')) {
      for (const v of [a.content, a.stdout, a.stderr, a.blockingError, a.blockingError?.blockingError]) {
        const t = textOf(v);
        if (t) hook.push(t);
      }
    } else if (ty === 'instructions' || ty === 'nested_memory') {
      for (const f of Array.isArray(a.files) ? a.files : []) if (typeof f?.content === 'string') instructions.push(f.content);
      if (typeof a.content === 'string') instructions.push(a.content);
    }
  } else if (r.type === 'user') {
    const c = r.message?.content;
    if (r.isMeta === true) {
      const t = textOf(c);
      if (/^\s*Stop hook feedback/i.test(t)) hook.push(t);
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_result' || b.is_error !== true) continue;
        const t = textOf(b.content);
        if (/^\s*(?:Error: )?PreToolUse:|hook error:/i.test(t.slice(0, 300))) hook.push(t);
      }
    }
  } else if (r.type === 'system' && r.subtype === 'stop_hook_summary') {
    for (const v of [...(Array.isArray(r.hookErrors) ? r.hookErrors : []), ...(Array.isArray(r.hookAdditionalContext) ? r.hookAdditionalContext : [])]) {
      const t = textOf([v]);
      if (t) hook.push(t);
    }
  }
  return { hook, instructions };
}

/** The same for a Codex record (checked on Codex CLI 0.159): added context is a developer
 *  message, a Stop hook's block a <hook_prompt> user message and a HookPrompt item, a refused
 *  step a tool output saying "blocked by PreToolUse hook", and AGENTS.md a user message. */
function codexTexts(r) {
  const hook = [];
  const instructions = [];
  const p = r.payload ?? {};
  if (r.type === 'response_item' && p.type === 'message') {
    const t = textOf(p.content);
    if (p.role === 'developer') hook.push(t);
    else if (p.role === 'user') {
      if (/^\s*<hook_prompt\b/.test(t)) hook.push(t);
      else if (/# AGENTS\.md instructions/.test(t)) instructions.push(t);
    }
  } else if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
    // Near the start only, as Codex writes a refusal: further in, it's a command's own output
    // (a file or a search that quotes the phrase), not the hook.
    const t = typeof p.output === 'string' ? p.output : textOf(p.output?.content ?? p.output);
    if (/blocked by PreToolUse hook/i.test(t.slice(0, 300))) hook.push(t);
  } else if (r.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'HookPrompt') {
    hook.push(textOf(p.item.fragments));
  }
  return { hook, instructions };
}

/**
 * scanLog(text, { tool, afterLine, marks }) -> { hook, instructions, sawInstructions }
 * Reads one log's lines: `hook` is true when a hook mark's words are in a hook record after line
 * `afterLine` (1-based, the tagged prompt's), `instructions` when an instructions mark's words
 * are in the instructions the session loaded (anywhere in the file: they load at its start), and
 * `sawInstructions` whether the file holds any instructions record at all.
 */
export function scanLog(text, { tool, afterLine = 0, marks = [] }) {
  const hookWords = marks.filter((m) => m.in === 'hook').map((m) => norm(m.words));
  const instrWords = marks.filter((m) => m.in === 'instructions').map((m) => norm(m.words));
  const out = { hook: false, instructions: false, sawInstructions: false };
  const read = tool === 'codex' ? codexTexts : claudeTexts;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const { hook, instructions } = read(r);
    if (instructions.length) out.sawInstructions = true;
    if (!out.instructions && instrWords.length) out.instructions = instructions.some((t) => instrWords.some((w) => norm(t).includes(w)));
    if (!out.hook && hookWords.length && i + 1 > afterLine) out.hook = hook.some((t) => hookWords.some((w) => norm(t).includes(w)));
    if (out.hook && (out.instructions || !instrWords.length)) break;
  }
  return out;
}

/** What firing means for a fix: its marks, and the answer the log can give. */
export function firedOf(id, scan) {
  const marks = FIX_MARKS[id] ?? [];
  const hook = marks.some((m) => m.in === 'hook');
  const instr = marks.some((m) => m.in === 'instructions');
  if (!marks.length) return { state: 'unknown', level: 'missing', why: 'no-trace' };
  if (!scan) return { state: 'unknown', level: 'missing', why: 'unread' };
  if (hook && scan.hook) return { state: 'fired', level: 'recorded' };
  if (instr && scan.instructions) return { state: 'loaded', level: 'recorded' };
  if (hook) return { state: 'none', level: 'inferred' };
  if (!scan.sawInstructions) return { state: 'unknown', level: 'missing', why: 'no-instructions-record' };
  return { state: 'not-loaded', level: 'inferred' };
}

const MAX_BYTES = 256 * 1024 * 1024;
function readLog(path) {
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * findFixTests(c, { results, catalog, checks, kindOf, read }) -> Map(patternId -> [test])
 * `c` is the checks' context, `results` each pattern's { found, measures, coverage } as
 * runProblems builds them, `kindOf(checkId)` a check's timeline kind. Each test is
 * { pattern, version, session, thread, event, at, tool, fired, problem }, the first tagged
 * prompt per session, pattern and version, in time order.
 */
export function findFixTests(c, { results, kindOf = () => null, read = readLog } = {}) {
  const out = new Map();
  const files = c.h?._raw?.fileOfSource ?? null;
  const seen = new Set();
  // A prompt you typed, or the instruction a `codex exec` run was started with: a tag in either
  // is a test someone meant to run.
  const prompts = c.events.filter((e) => (e.kind === 'prompt' || isExecInstruction(e)) && c.inWin(e.t)).sort((a, b) => a.t - b.t);
  const scans = new Map();
  for (const e of prompts) {
    const text = e._raw?.text ?? e.facts?.text;
    const m = typeof text === 'string' ? TAG_RE.exec(text) : null;
    if (!m) continue;
    const [, id, version] = m;
    const res = results.get(id);
    if (!res) continue;
    const key = `${e.session}|${id}|${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = c.sessionsByKey.get(e.session);
    const tool = s?.tool === 'codex' ? 'codex' : 'claude-code';
    const ref = Array.isArray(e.refs) ? e.refs[0] : null;
    const file = ref && files ? files.get(ref.src) : null;
    let scan = null;
    if (file) {
      const sk = `${file}|${ref.line}|${id}`;
      if (!scans.has(sk)) {
        const body = read(file);
        scans.set(sk, body == null ? null : scanLog(body, { tool, afterLine: ref.line, marks: FIX_MARKS[id] ?? [] }));
      }
      scan = scans.get(sk);
    }
    const test = { pattern: id, version, session: e.session, thread: s?.thread ?? null, event: e.id, at: e.at ?? new Date(e.t).toISOString(), tool, fired: firedOf(id, scan), problem: problemOf(c, res, e, tool, kindOf) };
    (out.get(id) ?? out.set(id, []).get(id)).push(test);
  }
  return out;
}

/** Whether the pattern's own checks found it in the test session, from the tagged prompt on. */
function problemOf(c, res, prompt, tool, kindOf) {
  const measures = res.measures ?? [];
  if (!measures.length) return { state: 'unknown', level: 'missing', why: 'no-check' };
  const cov = res.coverage?.[tool === 'codex' ? 'codex' : 'claudeCode']?.status;
  if (cov === 'not yet') return { state: 'unknown', level: 'missing', why: 'not-on-agent' };
  if (!measures.some((m) => m.ran)) return { state: 'unknown', level: 'missing', why: 'not-run' };
  if (measures.every((m) => kindOf(m.check) === 'stretch')) return { state: 'unknown', level: 'missing', why: 'too-short' };
  const found = (res.found ?? []).filter((f) => f.session === prompt.session && Date.parse(f.lastAt ?? f.at ?? '') >= prompt.t);
  if (found.length) return { state: 'seen', level: found[0].verdictEvidence ?? 'inferred', count: found.length };
  if (c.stillRunning(prompt.session)) return { state: 'unknown', level: 'missing', why: 'running' };
  return { state: 'not-seen', level: 'inferred' };
}
