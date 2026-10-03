// The clean-room scanner the fence tests share. It finds forbidden words in a file without
// the test naming them: each forbidden word is kept only as the SHA-256 hash of its
// lowercased form, and every candidate in the text is hashed and looked up.
//
// What counts as a candidate:
//   - every word (letters, digits, underscores)
//   - every run of words joined by hyphens or dots, and each stretch of up to four of its
//     parts ("a-b-c" also yields "a-b" and "b-c"; "name.example" also yields "name")
//   - every stretch of up to four camelCase or snake_case pieces inside a word, glued back
//     together ("useNameTool" also yields "name", "usename" and "nametool")
// A forbidden word glued to other lowercase letters with no boundary ("nameish") is not
// split out. A match reports the file and line, never the word.
//
// The owner's own name and GitHub handle are not hashed here: a short given name is easy
// to reverse from its hash, and package.json already publishes both (the author field
// and the repository URL). `ownerIdentity` reads them from package.json at run time.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Private project, repository and client names that must never appear anywhere in the
// repo. test/clean-room.test.mjs holds this fence over every tracked file.
export const PRIVATE_NAME_HASHES = [
  '93fbf825b24ef850162bbe52e83a0fbf3743926bdd679ec65581c71619ad89b7',
  'd2120f5bbcab07282e76e6df71d47a4e444c1119556bda60a657bac582446863',
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
  'a20a97aae8c1acaa081b46a90a889ffe04a41ca1df195fa66768abb0b81d7553',
  '9a34a1fe18920a27921f5a76582c0195876c474f58fbf31791215d7d21ad0b01',
  'bbf796e19929c23308fb8d0b18dd754a021000e725a5bd471187eacca81d027b',
  '6a2dea1ac8ffca6ba47dbf0541a6c3b9e256be7c7d382d8adc1a589afbf37f1b',
  '35fd7737632fcd84bfff4631036f6128e50e0a76c58fc165e5d31551287c48f2',
  '0b32f13ac90081829e371a06b99f2436e416e398d218bcf16ae3552d01b2b677',
  '3f5dcb46d4381c493d386708b01a8d0a1a07e15a3ae635bf4c151fa1e2226361',
  'c7575274a20d035b5a72baa824b2b6f8fcc29ab184bd322947dd27b6168ab1aa',
  '42352f1431f673e1713a87c30201b354af09051804e717ba29a20fd84e31b7a4',
];

export const PRIVATE_NAME = 'a private project name';
export const OWNER_IDENTITY = "the owner's name or handle";
export const SITE_FIELD = 'a target-site field name';

const MAX_PARTS = 4;
const RUN_RE = /[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*/g;
const PIECE_SPLIT_RE = /_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

const digests = new Map();

/** SHA-256 (hex) of a word's lowercased form. */
export function sha256(word) {
  const key = String(word).toLowerCase();
  let d = digests.get(key);
  if (!d) {
    d = createHash('sha256').update(key).digest('hex');
    digests.set(key, d);
  }
  return d;
}

/** Every candidate string in one hyphen- or dot-joined run, lowercased. */
export function candidatesOf(run) {
  const out = new Set();
  const parts = run.split(/[.-]/);
  const seps = run.match(/[.-]/g) || [];
  for (let i = 0; i < parts.length; i++) {
    let joined = parts[i];
    out.add(joined);
    for (let j = i + 1; j < parts.length && j - i < MAX_PARTS; j++) {
      joined += seps[j - 1] + parts[j];
      out.add(joined);
      out.add(joined.replace(/[._]/g, '-'));
    }
    const pieces = parts[i].split(PIECE_SPLIT_RE).filter(Boolean);
    for (let a = 0; a < pieces.length; a++) {
      let glued = '';
      for (let b = a; b < pieces.length && b - a < MAX_PARTS; b++) {
        glued += pieces[b];
        out.add(glued);
      }
    }
  }
  return [...out].map((c) => c.toLowerCase());
}

/**
 * Finds forbidden words in `text`. `forbidden` maps a SHA-256 hash to a short description
 * of the kind of word it is. Returns one { line, kind } per offending line and kind.
 */
export function findForbidden(text, forbidden) {
  const found = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kinds = new Set();
    for (const [run] of lines[i].matchAll(RUN_RE)) {
      for (const c of candidatesOf(run)) {
        const kind = forbidden.get(sha256(c));
        if (kind) kinds.add(kind);
      }
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
