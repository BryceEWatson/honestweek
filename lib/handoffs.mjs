// lib/handoffs.mjs — the session-end handoff source for discover.
//
// discover mines interactive session TRANSCRIPTS; handoffs are the other half of
// the record — the session-end summaries under <repo>/.claude/handoffs/*.md where
// work is TAGGED ([verified] / [assumed] / [unverified] / ...) and reversals are
// written down. This reads each FEATURED/REFERENCE repo's handoffs for the week
// (DISPLAY repos are NEVER read), and pulls bounded STRUCTURE — the tagged claim
// lines, the reversal lines, and backtick-wrapped commit SHAs — never a raw dump
// of handoff prose. Like the adapter, it only PROPOSES; build still verifies every
// cited commit. discover redacts the result before it touches disk.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HANDOFF_SUBDIR = join('.claude', 'handoffs');
const MAX_CLAIMS = 40;
const MAX_REVERSALS = 20;
const MAX_COMMITS = 40;
const MAX_TEXT = 280;

// Evidence tags honestweek's badge taxonomy recognizes (statusForTag maps them).
const TAG_RE = /\[(verified|measured|in[- ]progress|wip|assumed|unverified|handoff-claimed|derived|designed)\]/i;
// Commit SHAs are taken ONLY from backtick-wrapped 7-40 hex tokens (`9713875`) —
// the convention handoffs use — which avoids false positives from arbitrary hex
// in prose. Any that don't resolve are dropped by build's verify-or-abort anyway.
const BACKTICK_SHA_RE = /`([0-9a-f]{7,40})`/gi;
const HEADING_RE = /^#{1,6}\s/;
const REVERSAL_HEADING_RE = /^#{1,6}\s.*(revers|correction|don'?t resurrect)/i;
const REVERSAL_LINE_RE = /\b(revers|reverted|rolled back|don'?t resurrect|corrected)\b/i;
const BULLET_RE = /^\s*[-*]\s/;

function truncate(s, max = MAX_TEXT) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

/** FNV-1a -> 8 hex; used for a non-identifying id when no timestamp is present. */
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Parse a leading 20260624T010817Z-style timestamp from a name -> ms | null. */
export function handoffTimestamp(name) {
  const m = String(name).match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(t) ? null : t;
}

/** A non-identifying id for a handoff: its timestamp token, else a hash of the
 *  filename (so a private basename in the name can never leak through the id). */
function handoffId(name) {
  const ts = String(name).match(/\d{8}T\d{6}Z/);
  return ts ? ts[0] : `handoff-${shortHash(name)}`;
}

/** Extract bounded structure (tagged claims, reversals, commit SHAs) from one
 *  handoff's markdown text. Pure — no I/O, no redaction (the caller redacts). */
export function extractHandoff(text) {
  const lines = String(text).split(/\r?\n/);
  const claims = [];
  const reversals = [];
  const shaSet = new Set();
  let inReversalSection = false;

  for (const line of lines) {
    for (const m of line.matchAll(BACKTICK_SHA_RE)) {
      if (shaSet.size < MAX_COMMITS) shaSet.add(m[1].toLowerCase());
    }

    const tag = line.match(TAG_RE);
    if (tag && claims.length < MAX_CLAIMS) {
      const cleaned = line.replace(/^[\s>*\-\d.]+/, '').replace(TAG_RE, '').trim();
      if (cleaned) claims.push({ tag: tag[1].toLowerCase().replace(/\s+/g, '-'), text: truncate(cleaned) });
    }

    if (HEADING_RE.test(line)) inReversalSection = REVERSAL_HEADING_RE.test(line);
    if (reversals.length < MAX_REVERSALS) {
      const isBullet = BULLET_RE.test(line);
      if ((inReversalSection && isBullet) || REVERSAL_LINE_RE.test(line)) {
        const cleaned = line.replace(/^[\s>*\-]+/, '').trim();
        if (cleaned) reversals.push(truncate(cleaned));
      }
    }
  }
  return { claims, reversals, commits: [...shaSet] };
}

/**
 * discoverHandoffs({ config, weekStart, weekEnd, redactor }) -> entry[].
 * Reads <repo>/.claude/handoffs/*.md for FEATURED/REFERENCE repos whose handoff
 * timestamp (from the filename, else file mtime) falls in [weekStart, weekEnd].
 * DISPLAY repos are NEVER read. Returns redacted, bounded entries for the digest.
 */
export function discoverHandoffs({ config, weekStart, weekEnd, redactor } = {}) {
  const sinceMs = weekStart instanceof Date ? weekStart.getTime() : new Date(weekStart).getTime();
  const untilMs = weekEnd instanceof Date ? weekEnd.getTime() : new Date(weekEnd).getTime();
  const red = redactor;
  const out = [];

  for (const repo of config?.repos ?? []) {
    if (repo.role === 'display') continue; // display repos are NEVER read
    const dir = join(repo.resolvedPath ?? repo.path, HANDOFF_SUBDIR);
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      let ms = handoffTimestamp(name);
      if (ms == null) {
        try {
          ms = statSync(full).mtimeMs;
        } catch {
          continue;
        }
      }
      if (ms < sinceMs || ms > untilMs) continue;
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const { claims, reversals, commits } = extractHandoff(text);
      if (claims.length === 0 && reversals.length === 0 && commits.length === 0) continue;
      out.push({
        id: handoffId(name),
        date: new Date(ms).toISOString().slice(0, 10),
        repo: repo.label,
        source: 'handoff',
        claims: claims.map((c) => ({ tag: c.tag, text: red ? red.redact(c.text) : c.text })),
        reversals: reversals.map((t) => (red ? red.redact(t) : t)),
        candidateCommits: commits.map((sha) => ({ sha, date: null, subject: '' })),
      });
    }
  }
  out.sort((a, b) => `${a.date}|${a.id}`.localeCompare(`${b.date}|${b.id}`));
  return out;
}
