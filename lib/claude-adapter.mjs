// lib/claude-adapter.mjs — the Claude Code session-log adapter.
//
// honestweek's core bet: a session transcript carries more honest signal about a
// week of work than git does. This module is the first reader of that transcript
// and turns one tool's on-disk session logs into tool-neutral Digest entries.
// Because it is the first place raw session data enters the system, it is also
// the first place a private basename, secret, or non-allowlisted repo could
// leak — so leak-prone fields are reduced to their non-identifying shape BEFORE
// they ever reach a Digest entry, and every emitted string also passes through
// the redactor as a backstop.
//
// Adapter isolation: all Claude-Code-specific JSONL knowledge lives here, behind
// the tool-neutral Digest output, so a future Codex/Cursor adapter can implement
// the same contract without downstream changes.
//
// ============================================================================
// ON-DISK JSONL CONTRACT (what this module reads)
// ----------------------------------------------------------------------------
// One JSON object per line under:
//     <projectsRoot>/<encoded-cwd-dir>/<sessionId>.jsonl
// where projectsRoot is `$CLAUDE_CONFIG_DIR/projects` if set, else
// `~/.claude/projects`. Top-level <sessionId>.jsonl files only — `subagents/*`
// under a session directory are agent transcripts and are skipped.
//
// Lines are heterogeneous; only some are conversational. Conversational records
// carry: type ("user" | "assistant"), sessionId, timestamp (ISO-8601 UTC), cwd,
// gitBranch, version, entrypoint, userType, and a `message` object.
//   - A `user` record's message.content is EITHER a string (a human turn; may be
//     a slash-command turn wrapped in <command-message>/<command-name>/
//     <command-args>) OR an array containing a `tool_result` block (the
//     tool-result-wrapper turn — NOT a human turn; may carry a sibling
//     `toolUseResult` field and an `is_error` flag on the block).
//   - An `assistant` record's message.content is an array of blocks of type
//     `thinking` (.thinking), `text` (.text), and/or `tool_use` (.name + .input,
//     where input carries RAW absolute file paths and RAW search/query strings —
//     the leak surface).
// Non-conversational types observed (skip): file-history-snapshot, ai-title,
// last-prompt, queue-operation, attachment. Any unrecognized `type` is skippable.
// ============================================================================

import { openSync, readSync, closeSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { createRedactor } from './redact.mjs';

const HEAD_BYTES = 64 * 1024; // bounded prefix for classification + window/cwd probe
const MAX_STEER_LEN = 280;
const MAX_NOTE_LEN = 400;
const MAX_STEERS = 60;
const MAX_NOTES = 80;
const MAX_STATUS = 80;
const MAX_REDIRECTS = 30;
const MAX_CANDIDATES = 40;

const SKIP_TYPES = new Set(['file-history-snapshot', 'ai-title', 'last-prompt', 'queue-operation', 'attachment']);

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/** Resolve the projects root: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function resolveProjectsRoot(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
  return join(base, 'projects');
}

/** Top-level <sessionId>.jsonl files under each project dir (subagents/* excluded). */
export function enumerateSessionFiles(projectsRoot) {
  if (!projectsRoot || !existsSync(projectsRoot)) return [];
  const out = [];
  let projectDirs;
  try {
    projectDirs = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = join(projectsRoot, d.name);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Top-level files only — a `subagents` subdirectory (or any subdir) is skipped.
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
    }
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Bounded head read (classification + window + cwd, without a full read)
// ---------------------------------------------------------------------------

export function readHead(file, maxBytes = HEAD_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { lines: [], eof: true };
  }
  try {
    const size = statSync(file).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, 0);
    const text = buf.toString('utf8', 0, read);
    const eof = read >= size;
    const parts = text.split('\n');
    // Drop a trailing partial line unless we read to EOF.
    if (!eof && parts.length > 1) parts.pop();
    return { lines: parts.filter((l) => l.length > 0), eof };
  } finally {
    closeSync(fd);
  }
}

function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isHumanTurn(rec) {
  if (!rec || rec.type !== 'user' || !rec.message) return false;
  const content = rec.message.content;
  if (typeof content !== 'string') return false; // tool-result-array turns are not human
  const t = content.trim();
  if (t.length === 0) return false;
  if (t.startsWith('<command-')) return false; // slash-command-only turns are not human
  return true;
}

/** Probe the head: { startISO, cwd, sessionId, interactive }. */
function probeHead(file) {
  const { lines } = readHead(file);
  let startISO = null;
  let cwd = null;
  let sessionId = null;
  let interactive = false;
  for (const line of lines) {
    const rec = tryParse(line);
    if (!rec) continue;
    if (rec.type && SKIP_TYPES.has(rec.type)) continue;
    if (startISO === null && typeof rec.timestamp === 'string') startISO = rec.timestamp;
    if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (sessionId === null && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    if (!interactive && isHumanTurn(rec)) interactive = true;
  }
  return { startISO, cwd, sessionId, interactive };
}

// ---------------------------------------------------------------------------
// Repo mapping + leak-prone reductions
// ---------------------------------------------------------------------------

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Find the configured repo whose resolved path contains `cwd` (longest-prefix
 *  match), or null. Shared with the site session deriver so the cwd→repo rule has
 *  ONE implementation. */
export function matchRepo(cwd, config) {
  if (!cwd) return null;
  const c = normalizePath(cwd).toLowerCase();
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  let best = null;
  for (const r of repos) {
    const rp = normalizePath(r.resolvedPath ?? r.path ?? '').toLowerCase();
    if (!rp) continue;
    if (c === rp || c.startsWith(rp + '/')) {
      if (!best || rp.length > normalizePath(best.resolvedPath ?? best.path).length) best = r;
    }
  }
  return best;
}

/**
 * The non-identifying "*.<ext>" form of a basename — or a bare "*" when there is
 * no safe extension. This is the leak-critical reduction: it strips any query
 * string, fragment, :line:col, or trailing-args/prose, refuses to expose a
 * dotfile's post-dot segment (e.g. `.env.client-acme-prod`), and treats the
 * suffix as an extension ONLY when it is a short, alphanumeric token. Anything
 * else collapses to "*", so an "extension" can never carry an identifying name.
 */
function fileStar(name) {
  let b = name
    .replace(/[?#].*$/, '') // query string / fragment
    .replace(/:\d+(?::\d+)?$/, '') // :line or :line:col
    .replace(/\s.*$/, ''); // trailing args / prose
  if (b.startsWith('.')) return '*'; // dotfile — never expose the post-dot name
  const dot = b.lastIndexOf('.');
  if (dot <= 0) return '*';
  const ext = b.slice(dot);
  return /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? `*${ext}` : '*';
}

/**
 * Reduce a raw path to directory-depth + extension only — NEVER a raw basename.
 * Paths under `cwd` keep up to their last two project-relative directory levels;
 * paths outside `cwd` keep only their extension (their dirs could be anywhere).
 */
export function reducePath(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const norm = normalizePath(raw);
  const base = norm.split('/').pop() || '';
  const star = fileStar(base);

  const cwdNorm = cwd ? normalizePath(cwd) : '';
  if (cwdNorm && norm.toLowerCase().startsWith(cwdNorm.toLowerCase() + '/')) {
    const rel = norm.slice(cwdNorm.length + 1);
    const segs = rel.split('/').filter(Boolean);
    const dirs = segs.slice(0, -1).slice(-2); // up to last 2 dir levels, no basename
    return [...dirs, star].join('/');
  }
  // Outside cwd: extension only — never a foreign directory name or basename.
  return star;
}

function globExt(pattern) {
  if (typeof pattern !== 'string') return '*';
  const base = normalizePath(pattern).split('/').pop() || '';
  const m = base.match(/\.([A-Za-z0-9]{1,12})$/);
  return m ? `*.${m[1]}` : '*';
}

const TEST_PATTERNS = [
  [/\bnode\s+--test\b/, 'node --test'],
  [/\b(npm|pnpm|yarn)\s+(run\s+)?test\b/, 'npm test'],
  [/\bnpx\s+jest\b|\bjest\b/, 'jest'],
  [/\bvitest\b/, 'vitest'],
  [/\bpytest\b/, 'pytest'],
  [/\bgo\s+test\b/, 'go test'],
  [/\bcargo\s+test\b/, 'cargo test'],
  [/\bmocha\b/, 'mocha'],
];

function detectTest(cmd) {
  for (const [re, token] of TEST_PATTERNS) if (re.test(cmd)) return token;
  return null;
}

const GIT_INSPECT_RE = /\bgit\s+(commit|log|show|rev-parse)\b/;

// ---------------------------------------------------------------------------
// Status + candidate-commit extraction (from tool-result bodies, never stored)
// ---------------------------------------------------------------------------

function resultText(block) {
  // Gather text from a tool_result block FOR SCANNING ONLY — never emitted.
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) {
    return block.content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  }
  if (typeof block?.toolUseResult === 'string') return block.toolUseResult;
  return '';
}

function deriveStatus(isError, body) {
  if (isError) return 'fail';
  if (/build (failed|error|broke)|compilation failed|error TS\d+|tsc.*error/i.test(body)) return 'build-broke';
  if (/\d+\s+(passing|passed)|all tests passed|tests? passed|\bPASS\b|✓/i.test(body)) return 'pass';
  if (/\d+\s+(failing|failed)|tests? failed|\bFAIL\b|✗|assertion(?:error)?/i.test(body)) return 'fail';
  return null;
}

function extractCommits(body, dateISO) {
  // The adapter NOMINATES candidate SHAs only — it NEVER emits a subject derived
  // from the tool-result body (that body could carry diff content, PII, or a raw
  // basename the redactor cannot scrub). The real, redactable subject is
  // re-derived later from the user's own git (discover's commitsInWindow / the
  // build's lookupCommit). subject stays empty here.
  const shas = [];
  // `git commit` summary: [branch a1b2c3d] ...
  for (const m of body.matchAll(/\[[^\]\n]*?\b([0-9a-f]{7,40})\]/g)) shas.push(m[1]);
  // `git log --oneline`: line-leading short sha
  for (const m of body.matchAll(/^([0-9a-f]{7,40})\s+\S/gm)) shas.push(m[1]);
  // bare full sha line (rev-parse)
  for (const m of body.matchAll(/^([0-9a-f]{40})\s*$/gm)) shas.push(m[1]);
  return shas.map((sha) => ({ sha, date: dateISO, subject: '' }));
}

const REDIRECT_RE = /^\s*(no\b|wait\b|actually\b|stop\b|revert\b|undo\b|hold on\b|instead\b|that'?s (wrong|not)|don'?t\b)/i;
const REDIRECT_BODY_RE = /\b(instead of|revert|roll ?back|undo that|that'?s wrong|not what i)\b/i;

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

// ---------------------------------------------------------------------------
// Full extraction (streamed line-by-line — never loads the whole file)
// ---------------------------------------------------------------------------

async function extractEntry(file, { cwd }) {
  const acc = {
    steers: [],
    notes: [],
    counts: {},
    files: new Set(),
    tests: new Set(),
    searches: new Set(),
    statusSignals: [],
    redirects: [],
    candidateCommits: [],
  };
  const toolUseById = new Map();

  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const rec = tryParse(line);
    if (!rec || !rec.type || SKIP_TYPES.has(rec.type)) continue;

    if (rec.type === 'user') {
      const content = rec.message?.content;
      if (typeof content === 'string') {
        if (isHumanTurn(rec)) {
          if (acc.steers.length < MAX_STEERS) acc.steers.push(truncate(content, MAX_STEER_LEN));
          if (acc.redirects.length < MAX_REDIRECTS && (REDIRECT_RE.test(content) || REDIRECT_BODY_RE.test(content))) {
            acc.redirects.push(truncate(content, 160));
          }
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            const body = resultText(block);
            const status = deriveStatus(block.is_error === true, body);
            if (status && acc.statusSignals.length < MAX_STATUS) acc.statusSignals.push(status);
            const tu = toolUseById.get(block.tool_use_id);
            if (tu && tu.name === 'Bash' && GIT_INSPECT_RE.test(tu.command || '')) {
              for (const c of extractCommits(body, rec.timestamp?.slice(0, 10) ?? null)) {
                if (acc.candidateCommits.length < MAX_CANDIDATES) acc.candidateCommits.push(c);
              }
            }
          }
        }
      }
    } else if (rec.type === 'assistant') {
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'thinking' && typeof block.thinking === 'string') {
            if (acc.notes.length < MAX_NOTES) acc.notes.push(truncate(block.thinking, MAX_NOTE_LEN));
          } else if (block?.type === 'text' && typeof block.text === 'string') {
            if (acc.notes.length < MAX_NOTES) acc.notes.push(truncate(block.text, MAX_NOTE_LEN));
          } else if (block?.type === 'tool_use') {
            handleToolUse(block, acc, cwd, toolUseById);
          }
        }
      }
    }
  }

  return acc;
}

function handleToolUse(block, acc, cwd, toolUseById) {
  const name = typeof block.name === 'string' ? block.name : 'unknown';
  acc.counts[name] = (acc.counts[name] || 0) + 1;
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  if (block.id) toolUseById.set(block.id, { name, command: typeof input.command === 'string' ? input.command : '' });

  for (const key of ['file_path', 'notebook_path', 'filePath']) {
    if (typeof input[key] === 'string') {
      const f = reducePath(input[key], cwd);
      if (f) acc.files.add(f);
    }
  }

  if (name === 'Glob') {
    if (typeof input.pattern === 'string') acc.searches.add('glob:' + globExt(input.pattern));
  } else if (name === 'Grep') {
    let s = 'grep';
    if (typeof input.type === 'string') s += ':' + input.type;
    else if (typeof input.glob === 'string') s += ':' + globExt(input.glob);
    acc.searches.add(s);
    if (typeof input.path === 'string') {
      const f = reducePath(input.path, cwd);
      if (f) acc.files.add(f);
    }
  } else if (name === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    const t = detectTest(cmd);
    if (t) acc.tests.add(t);
    if (/\b(grep|rg|ag|find)\b/.test(cmd)) acc.searches.add('shell-search');
  }
}

// ---------------------------------------------------------------------------
// Per-session adaptation + public entry point
// ---------------------------------------------------------------------------

/** Deterministic FNV-1a -> 8 hex chars, used to derive a non-identifying id
 *  when the session id is not UUID/hex-shaped. */
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A short, NON-IDENTIFYING id for an entry. A real Claude Code session id is a
 * UUID, so its first hex segment is safe (and the redactor spares it). When the
 * id is not hex-shaped (an unusual / attacker-controlled session id or filename)
 * we never echo it back — we hash it, so a configured codename glued into the id
 * can never leak through this one un-reduced field.
 */
function shortId(sessionId, file) {
  const raw = (typeof sessionId === 'string' && sessionId) || (file ? file.split(/[\\/]/).pop().replace(/\.jsonl$/, '') : '');
  if (!raw) return 'session';
  const firstSeg = raw.split('-')[0];
  if (/^[0-9a-f]{6,40}$/i.test(firstSeg)) return firstSeg.toLowerCase().slice(0, 8);
  return `session-${shortHash(raw)}`;
}

function dedupeBySha(commits) {
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    out.push(c);
  }
  return out;
}

function privateEntry(id, date) {
  return {
    id,
    date,
    project: 'private',
    repo: null,
    isPrivate: true,
    steers: [],
    assistantNotes: [],
    toolSignal: { counts: {}, files: [], tests: [], searches: [] },
    statusSignals: [],
    redirects: [],
    candidateCommits: [],
  };
}

/** Adapt one session file to a Digest entry, or null if it should be skipped. */
export async function adaptOneSession(file, { config, weekStart, weekEnd, redactor }) {
  const { startISO, cwd, sessionId, interactive } = probeHead(file);
  if (!startISO) return null; // no conversational record with a timestamp

  const start = new Date(startISO);
  if (Number.isNaN(start.getTime()) || start < weekStart || start > weekEnd) return null; // out of window
  if (!interactive) return null; // automated / agent / tool-result-wrapper / slash-command-only

  const id = shortId(sessionId, file);
  const date = startISO.slice(0, 10);
  const repo = matchRepo(cwd, config);
  const isPrivate = !repo || repo.role === 'display';

  if (isPrivate) {
    // Never git-read, no candidate commits, no subject extraction; a minimal,
    // generic entry that downstream distillation reduces to one line.
    return redactor.deepRedact(privateEntry(id, date));
  }

  const acc = await extractEntry(file, { cwd });
  const entry = {
    id,
    date,
    project: repo.label,
    repo: repo.label,
    isPrivate: false,
    steers: acc.steers.map((s) => redactor.redact(s)),
    assistantNotes: acc.notes.map((s) => redactor.redact(s)),
    toolSignal: {
      counts: acc.counts,
      files: [...acc.files].sort().map((s) => redactor.redact(s)),
      tests: [...acc.tests].sort().map((s) => redactor.redact(s)),
      searches: [...acc.searches].sort().map((s) => redactor.redact(s)),
    },
    statusSignals: acc.statusSignals,
    redirects: acc.redirects.map((s) => redactor.redact(s)),
    candidateCommits: dedupeBySha(acc.candidateCommits).map((c) => ({
      sha: c.sha,
      date: c.date,
      subject: redactor.redact(c.subject || ''),
    })),
  };

  // Backstop: every string field passes through the redactor once more.
  return redactor.deepRedact(entry);
}

/**
 * adaptSessions({ config, weekStart, weekEnd, redactor?, projectsRoot? })
 *   -> Promise<Digest[]>
 * The single tool-neutral entry point. Enumerates Claude Code session logs for
 * the week, classifies + maps each, and emits one redacted Digest entry per
 * interactive session. A future adapter for another agent implements the same
 * contract and feeds the same downstream pipeline.
 */
export async function adaptSessions({ config, weekStart, weekEnd, redactor, projectsRoot } = {}) {
  const root = projectsRoot ?? resolveProjectsRoot();
  const red = redactor ?? createRedactor(config);
  const files = enumerateSessionFiles(root);

  const entries = [];
  for (const file of files) {
    let entry;
    try {
      entry = await adaptOneSession(file, { config, weekStart, weekEnd, redactor: red });
    } catch {
      entry = null; // a single malformed session never aborts the whole pass
    }
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => `${a.date}|${a.id}`.localeCompare(`${b.date}|${b.id}`));
  return entries;
}
