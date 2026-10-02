// lib/replay/sources.mjs — find the session files whose recorded span overlaps a window.
//
// Two tools write the logs this engine reads:
//
//   Claude Code  <projects>/<encoded-cwd>/<sessionId>.jsonl            one session
//                <projects>/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
//                <projects>/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.meta.json
//   Codex        ~/.codex/{sessions,archived_sessions}/YYYY/MM/DD/rollout-*.jsonl
//                (a child thread is its own rollout whose session_meta names its parent)
//
// A file is selected by the timestamps INSIDE it (first and last recorded record),
// never by its modification time: on the machine this was built on, 937 session files
// share one modification date from a bulk copy, so mtime says nothing about when the
// work happened.
//
// mtime is used for one thing only: skipping, without opening, a file last written
// more than two days before the window starts. A log is appended as work happens, so
// a file not written since then cannot hold a record inside the window (the two days
// absorb a wrong system clock). It is never used as evidence of when work happened.
//
// The first timestamp is found by streaming from the start, and the last by reading
// ever-larger tails, because a single record (a long tool result) can be larger than
// any fixed window: measured on the build machine in one survey run, 20 of 3,897 session files had their
// first timestamp past their first 64 KB.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { enumerateSessionFiles, resolveProjectsRoot } from '../claude-adapter.mjs';
import { enumerateCorpusFiles, resolveCodexRoots } from '../mine/corpus.mjs';
import { readBytesAt, readJsonlRecords, tryParse } from './jsonl.mjs';
import { sourceKey } from './ids.mjs';
import { OUT_OF_BAND_TYPES } from './parse-common.mjs';

/** The key of a Claude Code session file: its project directory name and file id.
 *  The directory is part of the key so two files can never share one, even though no
 *  session id appeared in two project directories on the machine this was built on. */
export function claudeSessionKey(dirName, fileId, agentId) {
  return agentId == null ? sourceKey('cc', dirName, fileId) : sourceKey('cc', dirName, fileId, agentId);
}

/** Default roots: Claude Code's projects directory and Codex's two session trees. */
export function defaultRoots(env = process.env) {
  return { claude: [resolveProjectsRoot(env)], codex: resolveCodexRoots(env) };
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const MTIME_TOLERANCE_MS = 2 * 24 * 60 * 60 * 1000;
function writtenBefore(path, ms) {
  try {
    return statSync(path).mtimeMs < ms - MTIME_TOLERANCE_MS;
  } catch {
    return false;
  }
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const timed = (r) => r && typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) && !OUT_OF_BAND_TYPES.has(r.type);

/** Stream from the start until the first in-band timestamped record, collecting the
 *  fields `pick` asks for on the way. */
async function head(file, pick) {
  const found = {};
  let after = 0; // records read since the first timestamp; the identity fields come early
  for await (const r of readJsonlRecords(file)) {
    if (found.firstAt && ++after > 500) break;
    if (r.oversized) continue;
    const rec = tryParse(r.text);
    if (!rec) continue;
    pick(rec, found);
    if (timed(rec)) found.firstAt ??= rec.timestamp;
    if (found.firstAt && (found.done?.(found) ?? true)) break;
  }
  return found;
}

/** The latest in-band timestamp in a file, reading larger tails until one is found. */
function lastTimestamp(file) {
  const size = sizeOf(file);
  for (let n = 64 * 1024; ; n *= 16) {
    const len = Math.min(n, size);
    const buf = readBytesAt(file, size - len, len);
    if (!buf) return null;
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // a partial first line
    let last = null;
    for (const line of lines) {
      const rec = tryParse(line.replace(/\r$/, ''));
      if (timed(rec) && (!last || rec.timestamp > last)) last = rec.timestamp;
    }
    if (last || len >= size) return last;
  }
}

async function probeClaude(file) {
  const h = await head(file, (rec, f) => {
    if (!f.cwd && typeof rec.cwd === 'string') f.cwd = rec.cwd;
    f.done = (x) => x.cwd != null;
  });
  return { firstAt: h.firstAt ?? null, lastAt: h.firstAt ? lastTimestamp(file) ?? h.firstAt : null, cwd: h.cwd ?? null };
}

function overlaps(firstAt, lastAt, fromMs, toMs) {
  const a = Date.parse(firstAt);
  const b = Date.parse(lastAt ?? firstAt);
  return Number.isFinite(a) && Number.isFinite(b) && a <= toMs && b >= fromMs;
}

/**
 * Claude Code sources overlapping [fromMs, toMs]: each session file plus its
 * sub-agent transcripts and their metadata. Returns { sources, skipped } where
 * `skipped` counts files passed over, by reason.
 */
export async function enumerateClaudeSources(roots, fromMs, toMs) {
  const sources = [];
  const skipped = { outsideWindow: 0, noTimestamps: 0, notWrittenSinceBeforeWindow: 0 };
  for (const root of roots ?? []) {
    if (!root || !existsSync(root)) continue;
    for (const file of enumerateSessionFiles(root)) {
      const dirName = basename(dirname(file));
      const fileId = basename(file, '.jsonl');
      if (writtenBefore(file, fromMs)) {
        skipped.notWrittenSinceBeforeWindow += 1;
        continue;
      }
      const probe = await probeClaude(file);
      if (!probe.firstAt) {
        skipped.noTimestamps += 1;
        continue;
      }
      if (!overlaps(probe.firstAt, probe.lastAt, fromMs, toMs)) {
        skipped.outsideWindow += 1;
        continue;
      }
      const key = claudeSessionKey(dirName, fileId);
      sources.push({ key, tool: 'claude-code', role: 'session', file, fileId, sessionKey: key, cwd: probe.cwd, firstAt: probe.firstAt, lastAt: probe.lastAt, size: sizeOf(file) });
      const subdir = join(dirname(file), fileId, 'subagents');
      for (const s of listDir(subdir).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!s.isFile() || !/^agent-.+\.jsonl$/.test(s.name)) continue;
        const agentId = s.name.slice('agent-'.length, -'.jsonl'.length);
        const subFile = join(subdir, s.name);
        const metaFile = join(subdir, `agent-${agentId}.meta.json`);
        let meta = null;
        if (existsSync(metaFile)) {
          try {
            meta = JSON.parse(readFileSync(metaFile, 'utf8'));
          } catch {
            meta = { unreadable: true };
          }
        }
        const sp = await probeClaude(subFile);
        sources.push({ key: claudeSessionKey(dirName, fileId, agentId), tool: 'claude-code', role: 'subagent', file: subFile, fileId, agentId, meta, sessionKey: key, cwd: sp.cwd ?? probe.cwd, firstAt: sp.firstAt, lastAt: sp.lastAt, size: sizeOf(subFile) });
      }
    }
  }
  return { sources, skipped };
}

/** Codex rollouts overlapping [fromMs, toMs]. A rollout is one thread: a session or a
 *  child thread whose session_meta names the parent thread. */
export async function enumerateCodexSources(roots, fromMs, toMs) {
  const sources = [];
  const skipped = { outsideWindow: 0, noTimestamps: 0, notWrittenSinceBeforeWindow: 0 };
  const files = [];
  for (const root of roots ?? []) if (root && existsSync(root)) files.push(...enumerateCorpusFiles('codex', root));
  files.sort();
  for (const file of files) {
    if (writtenBefore(file, fromMs)) {
      skipped.notWrittenSinceBeforeWindow += 1;
      continue;
    }
    const h = await head(file, (rec, f) => {
      if (!f.meta && rec.type === 'session_meta' && rec.payload && typeof rec.payload === 'object') f.meta = rec.payload;
      f.done = (x) => x.meta != null;
    });
    if (!h.firstAt) {
      skipped.noTimestamps += 1;
      continue;
    }
    const lastAt = lastTimestamp(file) ?? h.firstAt;
    if (!overlaps(h.firstAt, lastAt, fromMs, toMs)) {
      skipped.outsideWindow += 1;
      continue;
    }
    const meta = h.meta ?? null;
    const threadId = typeof meta?.id === 'string' ? meta.id : basename(file);
    const key = sourceKey('cx', threadId);
    sources.push({ key, tool: 'codex', role: 'session', file, threadId, meta, sessionKey: key, cwd: meta?.cwd ?? null, firstAt: h.firstAt, lastAt, size: sizeOf(file) });
  }
  return { sources, skipped };
}
