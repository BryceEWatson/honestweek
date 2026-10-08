// lib/saved/store.mjs: the folder `honestweek view` keeps its results in between runs, when the
// config's "saveResults" is on (issue 151).
//
// It sits beside the config as honestweek.saved/, readable only by its owner: the folder is made
// 0700 and every file 0600 where the system has those modes. It's git-ignored twice over, by a
// "*" .gitignore of its own and by a line in the config folder's .gitignore, the way
// honestweek.codex-judgments/ is. Every file is written whole, through a temporary file and a
// rename (lib/atomic-json.mjs), so a stopped run never leaves half a file.
//
// What's written has already passed the full redactor; what's read passes it again, with the
// settings of the run reading it (lib/saved/checks.mjs). Nothing here reads a log.
//
// With "saveResults" absent or off, nothing calls this module: no folder is made, read or
// changed, and every output stays as it was.
//
// Zero runtime dependencies: Node built-ins only.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson, atomicWriteText } from '../atomic-json.mjs';
import { SAVE_KEEP_DAYS } from '../config.mjs';
import { letterHash, pathKey } from '../replay/ids.mjs';

/** The folder, beside the config, that holds saved results. */
export const SAVED_DIR = 'honestweek.saved';
/** The line `init` and Settings add to the config folder's .gitignore. */
export const SAVED_GITIGNORE = Object.freeze([`${SAVED_DIR}/`]);
/** The shape of every saved file; a file with another is read as missing. */
export const SAVED_SCHEMA = 1;
/** How long a saved day is kept, in days (the config's own limits). */
export const KEEP_DAYS = SAVE_KEEP_DAYS;
/** The largest saved file read back; a larger one is left alone and read as missing. */
export const MAX_SAVED_FILE = 64 * 1024 * 1024;

/** A saved day's file name: the day, then .json (check results) or .json.gz (history). */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json(\.gz)?$/;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The saving settings from a normalized config: { keepDays, history }, or null when saving is
 *  off. `history` is whether each day's history is saved too, not only the check results. */
export function savedOptions(config) {
  const s = config?.saveResults;
  if (!s || s.on !== true) return null;
  return { keepDays: Number.isInteger(s.keepDays) ? s.keepDays : KEEP_DAYS.default, history: s.history !== false };
}

/** The saved folder for a config folder. */
export const savedDirOf = (configDir) => join(configDir, SAVED_DIR);

let VERSION = null;
/** honestweek's own version, from its package.json, which says which version saved a day. */
export function honestweekVersion() {
  if (VERSION === null) {
    try {
      VERSION = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? 'unknown');
    } catch {
      VERSION = 'unknown';
    }
  }
  return VERSION;
}

/** A fingerprint of the private-word settings a day was saved with: a hash, never the words. */
export function redactionPrint(config) {
  return letterHash(`redaction\u0000${JSON.stringify(config?.redaction ?? null)}`, 16);
}

/** A log's own session id (a Claude Code file id, a Codex thread id) as it's saved: a hash only. */
export const idHashOf = (id) => (typeof id === 'string' && id ? letterHash(`log-id\u0000${id.toLowerCase()}`, 24) : null);

/** Make the folder, owner-only and ignored by its own .gitignore. The caller adds the config
 *  folder's line (lib/saved/saver.mjs), since init.mjs imports this file. */
export function ensureSavedDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const own = join(dir, '.gitignore');
  if (!existsSync(own)) writeFileSync(own, '*\n', { mode: 0o600 });
}

/** Write one saved file's bytes (a gzipped day), making its folder (owner-only) first. */
export function writeSavedBytes(dir, parts, bytes) {
  const folder = join(dir, ...parts.slice(0, -1));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(folder, 0o700);
  atomicWriteText(join(folder, parts.at(-1)), bytes);
}

/** Write one saved file, making its folder (owner-only) first. */
export function writeSaved(dir, parts, value) {
  const folder = join(dir, ...parts.slice(0, -1));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(folder, 0o700);
  atomicWriteJson(join(folder, parts.at(-1)), value);
}

/** One saved file, or null when it's missing, too big, unreadable, or of another shape. */
export function readSaved(dir, parts) {
  const path = join(dir, ...parts);
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_SAVED_FILE) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && value.schema === SAVED_SCHEMA ? value : null;
  } catch {
    return null;
  }
}

/** The days a saved sub-folder holds, oldest first. */
export function savedDays(dir, sub) {
  let names = [];
  try {
    names = readdirSync(join(dir, sub));
  } catch {
    return [];
  }
  return [...new Set(names.map((n) => DAY_FILE.exec(n)?.[1]).filter(Boolean))].sort();
}

/** The oldest day `keepDays` keeps on `today`, or null when either is malformed. */
export function keptFrom(today, keepDays) {
  if (!DAY_SHAPE.test(today ?? '') || !Number.isInteger(keepDays) || keepDays < 1) return null;
  return shift(today, -(keepDays - 1));
}

/**
 * pruneSaved(dir, sub, { keepDays, today }) -> the days deleted
 * Deletes the days of `sub` older than `keepDays` days before `today`: a day `keepDays - 1`
 * days back is the oldest kept.
 */
export function pruneSaved(dir, sub, { keepDays, today }) {
  const oldest = keptFrom(today, keepDays);
  if (!oldest) return [];
  const gone = [];
  for (const day of savedDays(dir, sub)) {
    if (day >= oldest) continue;
    for (const name of [`${day}.json`, `${day}.json.gz`]) rmSync(join(dir, sub, name), { force: true });
    gone.push(day);
  }
  return gone;
}

/** How much the folder holds: { days, bytes, files }, with days counted in `sub`. */
export function savedSize(dir, sub) {
  let bytes = 0;
  let files = 0;
  const walk = (p, depth) => {
    let entries = [];
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const q = join(p, e.name);
      if (e.isDirectory() && depth < 3) walk(q, depth + 1);
      else if (e.isFile() && e.name !== '.gitignore') {
        try {
          bytes += statSync(q).size;
          files += 1;
        } catch {
          /* gone since the listing */
        }
      }
    }
  };
  walk(dir, 0);
  return { days: savedDays(dir, sub).length, bytes, files };
}

/**
 * forgetSaved(dir) -> { forgotten: boolean }
 * Deletes the whole saved folder. Only a real folder named SAVED_DIR is deleted: a link, a file,
 * or a folder of another name is left as it is.
 */
export function forgetSaved(dir) {
  if (!dir || !dir.replace(/[\\/]+$/, '').endsWith(SAVED_DIR)) return { forgotten: false };
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return { forgotten: false };
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return { forgotten: false };
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  return { forgotten: !existsSync(dir) };
}

/**
 * logKeys(roots) -> Set of pathKey
 * Every .jsonl log file under the roots, as the hash a saved session names its files by, so a
 * saved session can tell whether its log is still on disk without the path being saved.
 */
export function logKeys(roots) {
  const out = new Set();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 8) walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) out.add(pathKey(p));
    }
  };
  for (const r of [...(roots?.claude ?? []), ...(roots?.codex ?? [])]) if (r) walk(r, 0);
  return out;
}
