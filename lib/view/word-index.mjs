// lib/view/word-index.mjs: "search everywhere" for `honestweek view`.
//
// It reads the prompts and titles of every session in the window, from the same log
// folders and window the history was built from, display-only repositories and folders
// outside the config included. The text stays in this process's memory only; nothing
// here writes a file. A query matches the real words in memory (the `local-full`
// choice). Every excerpt it returns is collapsed onto one line, redacted whole, and only
// then cut, so a cut can never leave half of a private word on screen.
//
// Which group a hit belongs to (configured, display or outside) and which session it
// is come from the history's own session list, never from a second folder matcher.
//
// A Codex session is read through the engine's own turn reader (lib/codex-records.mjs),
// so only what the person typed is indexed: the AGENTS.md text, environment and
// instruction blocks Codex injects as user messages are left out, and so is a `codex exec`
// run's starting instruction. A child thread is skipped whole: its user messages are its
// parent agent's hand-offs.

import { readJsonlRecords, tryParse } from '../replay/jsonl.mjs';
import { enumerateClaudeSources, enumerateCodexSources } from '../replay/sources.mjs';
import { createCodexTurnReader, isCodexExecSession } from '../codex-records.mjs';

/** Harness text that arrives as a user record but isn't something a person typed. */
const PSEUDO = /^\s*<(command-[\w-]*|task-notification|local-command[\w-]*|user-prompt-submit-hook|bash-(input|stdout|stderr)|system-reminder|environment_context|user_instructions)\b/i;
// The engine's own readings of a Claude Code user record (lib/replay/claude.mjs): a
// reminder block inside a prompt isn't the person's, an interruption marker isn't a
// prompt, and a body another session, an agent or a schedule sent is relayed, not typed.
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const INTERRUPT_RE = /^\[Request interrupted by user( for tool use)?\]/;
const RELAYED_RE = /^\s*<(cross-session-message|agent-message|scheduled-task)\b/i;
/** Record origins the engine reads as something other than a person's prompt. */
const NOT_TYPED_ORIGINS = new Set(['peer', 'coordinator', 'task-notification']);

/** The most results one search returns. A prompt is kept whole: cutting it before it's
 *  redacted could leave half a secret that no rule still recognizes. */
export const MAX_RESULTS = 30;

function promptOf(rec) {
  if (rec?.type === 'user' && !rec.toolUseResult && !rec.isMeta && !rec.isSidechain) {
    // A compaction summary is the model's own account of earlier context, not a prompt.
    // Nor is a turn a program sent (`turnOrigin: "sdk"`), or one whose turnOrigin names a
    // sender other than a person.
    if (rec.isCompactSummary || NOT_TYPED_ORIGINS.has(rec.origin?.kind) || rec.turnOrigin === 'sdk' || NOT_TYPED_ORIGINS.has(rec.turnOrigin === 'task_notification' ? 'task-notification' : rec.turnOrigin)) return null;
    const c = rec.message?.content;
    const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ') : null;
    if (raw === null) return null;
    const visible = raw.replace(SYSTEM_REMINDER_RE, '').trim();
    if (INTERRUPT_RE.test(visible) || RELAYED_RE.test(visible)) return null;
    return visible;
  }
  // A prompt typed while the agent was busy arrives as a queued command attachment.
  const a = rec?.attachment;
  if (rec?.type === 'attachment' && !rec.isSidechain && a?.type === 'queued_command' && typeof a.prompt === 'string') {
    if (NOT_TYPED_ORIGINS.has(a.origin?.kind) || /^\s*<task-notification>/.test(a.prompt)) return null;
    const visible = a.prompt.replace(SYSTEM_REMINDER_RE, '').trim();
    return RELAYED_RE.test(visible) ? null : visible;
  }
  return null;
}

/** True when a Codex rollout's session_meta says another agent started it (a child thread). */
const isCodexChild = (meta) => !!(meta?.source && typeof meta.source === 'object' && meta.source.subagent);

/**
 * buildWordIndex({ roots, startT, endT, sessionOfSource }) -> Promise<{ sessions, ms }>
 * `sessionOfSource(sourceKey)` names the history session a file belongs to (a Codex
 * child thread belongs to its parent's), so only a session's own file is read for its
 * prompts. Each session is { key, tool, title, prompts: [{ t, text }] }.
 */
export async function buildWordIndex({ roots, startT, endT, sessionOfSource = () => null }) {
  const started = Date.now();
  const claude = await enumerateClaudeSources(roots?.claude ?? [], startT, endT - 1);
  const codex = await enumerateCodexSources(roots?.codex ?? [], startT, endT - 1);
  const sessions = [];
  const seen = new Set();
  for (const s of [...claude.sources, ...codex.sources]) {
    if (s.role !== 'session' || seen.has(s.key)) continue;
    seen.add(s.key);
    const owner = sessionOfSource(s.key);
    if (owner && owner !== s.key) continue;
    const codex = s.tool === 'codex';
    // Nothing in a child thread or a `codex exec` run was typed by the person.
    if (codex && (isCodexChild(s.meta) || isCodexExecSession(s.meta))) continue;
    const entry = { key: s.sessionKey, tool: s.tool, title: null, prompts: [] };
    const codexTurn = codex ? createCodexTurnReader() : null;
    try {
      for await (const r of readJsonlRecords(s.file)) {
        if (r.oversized || !r.text) continue;
        if (!r.text.includes('"user"') && !r.text.includes('"user_message"') && !r.text.includes('-title"') && !r.text.includes('"queued_command"')) continue;
        const rec = tryParse(r.text);
        if (!rec || typeof rec !== 'object') continue;
        if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') entry.title = rec.customTitle;
        else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && entry.title === null) entry.title = rec.aiTitle;
        const text = codex ? codexTurn(rec).user : promptOf(rec);
        if (!text || !text.trim() || PSEUDO.test(text)) continue;
        const t = Date.parse(rec.timestamp ?? rec.attachment?.timestamp ?? '');
        if (Number.isFinite(t) && (t < startT || t >= endT)) continue;
        entry.prompts.push({ t: Number.isFinite(t) ? t : null, text });
      }
    } catch {
      continue;
    }
    if (entry.prompts.length || entry.title) sessions.push(entry);
  }
  return { sessions, ms: Date.now() - started };
}

/** Cut `text` to at most `max` characters, stepping back so the cut never splits a
 *  [redacted:…] marker. The text must already be redacted whole. */
export function cutRedacted(text, max) {
  if (text.length <= max) return text;
  let end = max;
  const open = text.lastIndexOf('[redacted:', end);
  if (open !== -1 && open < end && text.indexOf(']', open) >= end) end = open;
  return text.slice(0, end).trimEnd();
}

/** Up to `before` characters before the first query word in `text` and `after` from
 *  it, widened to whole words and never splitting a marker, with "…" where it goes on. */
export function excerpt(text, words, before, after) {
  const low = text.toLowerCase();
  const at = Math.max(0, words.map((w) => low.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0);
  let a = Math.max(0, at - before);
  let b = Math.min(text.length, at + after);
  if (a > 0) {
    const sp = text.indexOf(' ', a);
    if (sp >= 0 && sp < at) a = sp + 1;
    const open = text.lastIndexOf('[redacted:', a);
    if (open !== -1 && text.indexOf(']', open) >= a) a = open;
  }
  if (b < text.length) {
    const sp = text.lastIndexOf(' ', b);
    if (sp > at) b = sp;
    const open = text.lastIndexOf('[redacted:', b);
    if (open !== -1 && open < b && text.indexOf(']', open) >= b) b = open;
  }
  return `${a > 0 ? '… ' : ''}${text.slice(a, b).trim()}${b < text.length ? ' …' : ''}`;
}

/**
 * createWordSearch(index) -> search(q, { redact, mode, sessionInfo })
 *   redact       the mode's redactor: the full one with the switch off, secrets-only on
 *   mode         'redacted' or 'private', so each mode's cleaned text is cached apart
 *   sessionInfo  (key) -> { thread, group, title, repo } from the history, or null
 * Returns { total, sessions, results } where every row and count carries its evidence.
 */
export function createWordSearch(index) {
  const cleaned = { redacted: new WeakMap(), private: new WeakMap() };
  const clean = (p, mode, redact) => {
    const cache = cleaned[mode] ?? cleaned.redacted;
    // Collapse, then redact the whole text, then cut (in excerpt): the order the engine
    // uses, so a password on the line after its label is read on one line and hidden.
    if (!cache.has(p)) cache.set(p, String(redact(p.text.replace(/\s+/g, ' ').trim())));
    return cache.get(p);
  };
  return function search(q, { redact, mode = 'redacted', sessionInfo = () => null } = {}) {
    const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { total: { value: 0, evidence: 'derived' }, sessions: { value: 0, evidence: 'derived' }, results: [] };
    const matched = [];
    let total = 0;
    for (const s of index.sessions) {
      const hits = s.prompts.filter((p) => words.every((w) => p.text.toLowerCase().includes(w)));
      const inTitle = !!s.title && words.every((w) => s.title.toLowerCase().includes(w));
      if (!hits.length && !inTitle) continue;
      total += hits.length;
      const times = s.prompts.map((p) => p.t).filter(Number.isFinite);
      matched.push({ s, hits, inTitle, firstAt: times.length ? Math.min(...times) : null, lastAt: times.length ? Math.max(...times) : null });
    }
    matched.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || (a.s.key < b.s.key ? -1 : 1));
    const results = matched.slice(0, MAX_RESULTS).map(({ s, hits, inTitle, firstAt, lastAt }) => {
      const info = sessionInfo(s.key);
      const name = s.title ? cutRedacted(String(redact(s.title.replace(/\s+/g, ' ').trim())), 160) : s.prompts[0] ? excerpt(clean(s.prompts[0], mode, redact), [], 0, 90) : 'Untitled session';
      return {
        session: s.key,
        thread: info?.thread ?? null,
        group: info?.group ?? null,
        inWindow: !!info,
        note: info ? null : 'not in this window',
        tool: s.tool,
        name,
        named: s.title ? 'title' : s.prompts[0] ? 'first prompt' : null,
        firstAt: firstAt != null ? new Date(firstAt).toISOString() : null,
        lastAt: lastAt != null ? new Date(lastAt).toISOString() : null,
        evidence: 'recorded',
        matches: { value: hits.length, evidence: 'derived' },
        titleMatched: inTitle,
        snippets: hits.slice(0, 3).map((p) => ({ t: p.t, at: p.t != null ? new Date(p.t).toISOString() : null, text: excerpt(clean(p, mode, redact), words, 90, 160), evidence: 'recorded' })),
      };
    });
    return { total: { value: total, evidence: 'derived' }, sessions: { value: matched.length, evidence: 'derived' }, results };
  };
}
