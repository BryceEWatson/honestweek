// lib/replay/ids.mjs — stable, redaction-proof identifiers for the work-history engine.
//
// Every source, event, and evidence reference needs an id that is (a) the same on
// every run over the same files, (b) short, and (c) left untouched by the redactor,
// because the "redact before disk" rule passes every emitted string through it. A
// raw session UUID fails (c): the redactor treats UUIDs as secrets. A hex hash fails
// (c) one time in a few hundred, when it happens to be all digits and reads as an
// account number. So ids are SHA-256 digests spelled in the letters a..p only: no
// digit runs, no UUID shape, nothing the scrubber matches.

import { createHash } from 'node:crypto';

const LETTERS = 'abcdefghijklmnop';

/** SHA-256 of `input` spelled as `n` letters from a..p (4 bits per letter). */
export function letterHash(input, n = 12) {
  const hex = createHash('sha256').update(input).digest('hex');
  let out = '';
  for (let i = 0; i < n; i++) out += LETTERS[parseInt(hex[i], 16)];
  return out;
}

/** The key of one source file: `cc-…` (Claude Code), `cx-…` (Codex), `git-…`. */
export function sourceKey(tool, ...parts) {
  return `${tool}-${letterHash(parts.map(String).join('\u0000'))}`;
}

/** Digest of one raw record's bytes, used to prove a reference still points at the
 *  same record. 16 letters = 64 bits. */
export function recordDigest(bytes) {
  return letterHash(bytes, 16);
}

/** An event id: the source it came from, its 1-based line, and its position among
 *  the events that one record produced. */
export function eventId(srcKey, line, sub = 0) {
  return `${srcKey}.${line}.${sub}`;
}

/** A join key for a file path that never exposes the path itself. Paths are compared
 *  case-insensitively on Windows-shaped input, with separators normalized. */
export function pathKey(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  let p = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(p) || /^\/[a-z]\//.test(p)) p = p.toLowerCase().replace(/^\/([a-z])\//, '$1:/');
  return `f-${letterHash(p, 12)}`;
}
