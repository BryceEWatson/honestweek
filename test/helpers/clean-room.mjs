// The clean-room scanner the fence tests share. It finds forbidden words in a file without
// the test naming them: each forbidden word is kept only as the SHA-256 hash of its
// canonical form (lowercased, letters and digits only, so "Lark-Board", "lark_board" and
// "LarkBoard" are all "larkboard"), and stretches of the text are hashed and looked up.
//
// For a forbidden word "larkboard", it catches:
//   - any case, with or without hyphens, dots or underscores inside it: LARK_BOARD,
//     lark-board, lark.board
//   - glued to other letters or digits: larkboards, useLarkBoardPanel, mylarkboardapp,
//     larkboard.example, a URL-encoded "%2Flarkboard", an escaped "\nlarkboard"
//   - two or three whole words in a row, with a plural: "Lark Board", "Lark Boards"
//     ("Lark Board's" is caught too, because the apostrophe ends the word). A target-site
//     field name doesn't match across spaces, since "work log" is ordinary prose where
//     "work-log" is a field.
//   - URL-encoded spaces: "Lark%20Board" is read as "Lark Board" as well
// A match reports the file and line, never the word.
//
// The scanner hashes every stretch of MIN_LEN to MAX_LEN letters and digits inside each
// word, so a forbidden word must be that long in canonical form, or it only matches as a
// whole word. Print a new word's hash with `node test/helpers/clean-room.mjs <word>`,
// which refuses a word outside those bounds.
//
// The owner's own name and GitHub handle are not hashed here: a short given name is easy
// to reverse from its hash, and package.json already publishes both (the author field
// and the repository URL). `ownerIdentity` reads them from package.json at run time.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Private project, repository and client names that must never appear anywhere in the
// repo. test/clean-room.test.mjs holds this fence over every tracked file.
export const PRIVATE_NAME_HASHES = [
  '93fbf825b24ef850162bbe52e83a0fbf3743926bdd679ec65581c71619ad89b7',
  'dd0203d8bf083d78258590e16f0852dc87d18eefc4533172c88e275a938da73d',
  'af8e15666cd7df43f293c583c405548dec84484e5ffedde3d678cd37160eba45',
  'd70829acb490fe758d854d7b1e2a6204b0394961edbfc79ff470ab646a08651d',
  'b1a31ad3b246d899b693546bd6a23057fffc5c7d3c89b521b5d0b89e180b5596',
];

// The first real integration target's own render-field and file names. Generic counting
// vocabulary (e.g. "byProject", "projectTotals") is honestweek's own and is intentionally
// NOT listed: convergent generic naming is not a leak; a site-only render field is. Some
// of these are fine in honestweek's own page code, so test/site-cleanroom.test.mjs fences
// them out of the generic subsystems only, not the whole repo.
export const SITE_FIELD_HASHES = [
  'adc9982af5a72f3bf5ad97faa58cc2178be35c285777dc61d3c0dea2f1e61924',
  '9a34a1fe18920a27921f5a76582c0195876c474f58fbf31791215d7d21ad0b01',
  'fb0272f25f8455c8af4c313a997d4ed0fbc53b0d185542eab779e6edbefe5342',
  '092b4394b86a41b4cb02ecf5aa8ba39dccbc16c51b6db9b1f7927cb74d6b4dd6',
  '35fd7737632fcd84bfff4631036f6128e50e0a76c58fc165e5d31551287c48f2',
  '0b32f13ac90081829e371a06b99f2436e416e398d218bcf16ae3552d01b2b677',
  '3f5dcb46d4381c493d386708b01a8d0a1a07e15a3ae635bf4c151fa1e2226361',
  'c7575274a20d035b5a72baa824b2b6f8fcc29ab184bd322947dd27b6168ab1aa',
  '42352f1431f673e1713a87c30201b354af09051804e717ba29a20fd84e31b7a4',
];

export const PRIVATE_NAME = 'a private project name';
export const OWNER_IDENTITY = "the owner's name or handle";
export const SITE_FIELD = 'a target-site field name';

export const MIN_LEN = 4;
export const MAX_LEN = 24;

// A word: letters and digits, joined by hyphens, dots or underscores.
const WORD_RE = /[A-Za-z0-9]+(?:[._-]+[A-Za-z0-9]+)*/g;
const MAX_WORDS = 3;

/** A word's canonical form: lowercased, letters and digits only. */
export function canonical(word) {
  return String(word).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** SHA-256 (hex) of a word's canonical form. */
export function sha256(word) {
  return createHash('sha256').update(canonical(word)).digest('hex');
}

/** The hash to list for a new forbidden word. Refuses a word the scanner can't find glued. */
export function hashName(word) {
  const c = canonical(word);
  if (c.length < MIN_LEN || c.length > MAX_LEN) {
    throw new RangeError(`a forbidden word must be ${MIN_LEN} to ${MAX_LEN} letters and digits long`);
  }
  return sha256(c);
}

/** Every candidate inside one word, canonical: the whole word and each stretch MIN_LEN..MAX_LEN long. */
export function candidatesOf(word) {
  const c = canonical(word);
  const out = new Set([c]);
  for (let len = MIN_LEN; len <= Math.min(MAX_LEN, c.length); len++) {
    for (let i = 0; i + len <= c.length; i++) out.add(c.slice(i, i + len));
  }
  return [...out];
}

// The kind (or null) of each candidate already looked up, per fence, so a stretch that
// recurs across thousands of lines is hashed once.
const looked = new WeakMap();
function kindOf(candidate, forbidden) {
  let memo = looked.get(forbidden);
  if (!memo) looked.set(forbidden, (memo = new Map()));
  let kind = memo.get(candidate);
  if (kind === undefined) {
    kind = forbidden.get(createHash('sha256').update(candidate).digest('hex')) ?? null;
    memo.set(candidate, kind);
  }
  return kind;
}

/** Adds the forbidden kinds in one line of text to `kinds`. */
function scanLine(line, forbidden, acrossSpaces, kinds) {
  const words = [];
  for (const m of line.matchAll(WORD_RE)) words.push({ c: canonical(m[0]), start: m.index, end: m.index + m[0].length });
  for (const { c } of words) {
    for (const cand of candidatesOf(c)) {
      const kind = kindOf(cand, forbidden);
      if (kind) kinds.add(kind);
    }
  }
  // Two or three whole words in a row, separated only by spaces, and their plural.
  for (let i = 0; i < words.length; i++) {
    let joined = words[i].c;
    for (let j = i + 1; j < words.length && j - i < MAX_WORDS; j++) {
      if (!/^[ \t]+$/.test(line.slice(words[j - 1].end, words[j].start))) break;
      joined += words[j].c;
      for (const cand of new Set([joined, joined.replace(/s$/, ''), joined.replace(/es$/, '')])) {
        const kind = kindOf(cand, forbidden);
        if (kind && acrossSpaces(kind)) kinds.add(kind);
      }
    }
  }
}

/**
 * Finds forbidden words in `text`. `forbidden` maps a SHA-256 hash to a short description
 * of the kind of word it is. `acrossSpaces(kind)` says whether that kind also matches as
 * separate words; by default a target-site field doesn't. Returns one { line, kind } per
 * offending line and kind.
 */
export function findForbidden(text, forbidden, { acrossSpaces = (kind) => kind !== SITE_FIELD } = {}) {
  const found = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kinds = new Set();
    scanLine(lines[i], forbidden, acrossSpaces, kinds);
    if (/%[0-9A-Fa-f]{2}/.test(lines[i])) {
      const decoded = lines[i].replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      scanLine(decoded, forbidden, acrossSpaces, kinds);
    }
    for (const kind of kinds) found.push({ line: i + 1, kind });
  }
  return found;
}

/**
 * The owner's identity as package.json states it: the author's name parts, the name run
 * together, and the GitHub handle from the repository URL, all lowercased.
 */
export function ownerIdentity(pkg) {
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? '';
  const parts = author
    .replace(/<[^>]*>|\([^)]*\)/g, '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  const handle = (url.match(/github(?:\.com[/:]|:)([^/]+)\//i) || [])[1]?.toLowerCase() ?? '';
  const tokens = new Set(parts);
  if (parts.length > 1) tokens.add(parts.join(''));
  if (handle) tokens.add(handle);
  return { tokens, handle };
}

/** The owner identity from the package.json in `root`. */
export function readOwner(root) {
  return ownerIdentity(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
}

/** Hash -> kind for the private names plus the given owner's tokens. */
export function privateForbidden(owner) {
  const m = new Map(PRIVATE_NAME_HASHES.map((h) => [h, PRIVATE_NAME]));
  for (const t of owner.tokens) m.set(sha256(t), OWNER_IDENTITY);
  return m;
}

/**
 * Every forbidden word in one file, as "path:line (kind)" strings, after the project's own
 * GitHub address is set aside. `rel` is the path to print.
 */
export function scanText(text, rel, forbidden, handle) {
  return findForbidden(stripOwnAddress(text, handle), forbidden).map(({ line, kind }) => `${rel}:${line} (${kind})`);
}

/**
 * Replaces the project's own GitHub address (github.com/HANDLE, github:HANDLE and
 * HANDLE/honestweek) with a neutral word, because the repository's URL is allowed anywhere.
 */
export function stripOwnAddress(text, handle) {
  if (!handle) return String(text);
  const h = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text)
    .replace(new RegExp(`github\\.com[/:]${h}\\b`, 'gi'), 'github.com/OWNER')
    .replace(new RegExp(`github:${h}\\b`, 'gi'), 'github:OWNER')
    .replace(new RegExp(`\\b${h}(\\\\?/honestweek)\\b`, 'gi'), 'OWNER$1');
}

// `node test/helpers/clean-room.mjs <word>...` prints the hash to list for each word.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const word of process.argv.slice(2)) console.log(hashName(word));
}
