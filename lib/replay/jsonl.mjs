// lib/replay/jsonl.mjs — byte-addressed JSONL reading for the work-history engine.
//
// The engine keeps a reference to every record it turns into an event: the file,
// the byte offset and length of the line, and a digest of those bytes. Drill-down
// later re-reads exactly that line and refuses to show it if the digest no longer
// matches. So this reader yields each line together with where it sits.
//
// A line larger than the record cap is skipped and reported, never buffered whole,
// so one runaway record cannot exhaust memory or abort a whole history.

import { closeSync, createReadStream, openSync, readSync } from 'node:fs';

import { MAX_JSONL_RECORD_BYTES } from '../bounded-jsonl.mjs';

/**
 * readJsonlRecords(path, { maxBytes }) -> async iterator of
 *   { line, offset, length, text, bytes }     a complete line (CR/LF excluded)
 *   { line, offset, length, oversized: true } a line past the cap (text omitted)
 * `line` is 1-based. `offset`/`length` address the line's bytes, CR/LF excluded.
 */
export async function* readJsonlRecords(path, { maxBytes = MAX_JSONL_RECORD_BYTES } = {}) {
  let parts = [];
  let pending = 0;
  let total = 0; // bytes of the current line seen so far, kept or not
  let oversized = false;
  let lineStart = 0;
  let pos = 0;
  let line = 0;

  const finish = function* () {
    line += 1;
    let length = total;
    if (oversized) {
      yield { line, offset: lineStart, length, oversized: true };
    } else {
      let buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, pending);
      if (buf.length && buf[buf.length - 1] === 0x0d) {
        buf = buf.subarray(0, buf.length - 1);
        length -= 1;
      }
      if (buf.length) yield { line, offset: lineStart, length, text: buf.toString('utf8'), bytes: buf };
    }
    parts = [];
    pending = 0;
    total = 0;
    oversized = false;
  };

  const append = (chunk) => {
    total += chunk.length;
    if (oversized) return;
    if (pending + chunk.length > maxBytes + 1) {
      oversized = true;
      parts = [];
      pending = 0;
      return;
    }
    if (chunk.length) {
      parts.push(chunk);
      pending += chunk.length;
    }
  };

  for await (const chunk of createReadStream(path)) {
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      append(chunk.subarray(start, nl));
      yield* finish();
      pos += nl - start + 1;
      lineStart = pos;
      start = nl + 1;
    }
    append(chunk.subarray(start));
    pos += chunk.length - start;
  }
  if (total > 0) yield* finish();
}

/** The raw bytes at [offset, offset + length) of `path`, or null if unreadable. */
export function readBytesAt(path, offset, length) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(length);
    const got = readSync(fd, buf, 0, length, offset);
    return got === length ? buf : null;
  } finally {
    closeSync(fd);
  }
}

export function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
