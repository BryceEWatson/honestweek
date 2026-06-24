// lib/harvest.mjs — the `harvest` subcommand: propose redaction denylist additions.
//
// The redaction lists start empty (clean-room); honestweek can't know YOUR private
// codenames, client names, or vendors. harvest scans the already-redacted draft for
// proper-noun-shaped tokens that SURVIVED redaction (CamelCase, ALLCAPS, or a
// capitalized word that isn't common English), excludes anything already in your
// redaction lists or repo labels, and writes the candidates to the GITIGNORED
// sidecar honestweek.harvest.json for you to review. It is advisory: you decide
// which candidates are actually private and add them to config.redaction.
//
// PRIVACY: only the COUNT is printed to stdout — the raw candidate nouns go ONLY
// to the gitignored sidecar, never to a log/transcript that could itself leak.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';

const CONFIG_FILE = 'honestweek.config.json';
const DRAFT_FILE = 'honestweek.draft.json';
const HARVEST_FILE = 'honestweek.harvest.json';

// Common capitalized English words / sentence-starters to ignore — high-noise,
// low-signal. The harvester is advisory, so over-inclusion here only trims noise.
const STOP = new Set(
  (
    'the this that these those and but for with from into onto over under when then than they their there here ' +
    'what which while will would should could shall might must have has had been being does did done make made ' +
    'after before also each every some any all not new use run add fix set get now one two three first next last ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august ' +
    'september october november december node git build test docs json yes no ok done todo wip'
  ).split(/\s+/)
);

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
}

/** True iff a token is shaped like a proper noun / codename worth proposing. */
function isCandidate(w) {
  if (w.length < 3) return false;
  if (/^[A-Z]{3,}$/.test(w)) return true; // ALLCAPS codename (e.g. ACME)
  if (/[a-z][A-Z]/.test(w)) return true; // CamelCase (e.g. ShopForge)
  if (/^[A-Z][a-z]+$/.test(w)) return true; // a single Capitalized word
  return false;
}

/** Count proper-noun-shaped tokens in a string, minus an exclude set + STOP. */
export function harvestNouns(text, { exclude = new Set() } = {}) {
  const counts = new Map();
  const words = String(text).match(/[A-Za-z][A-Za-z0-9]+/g) || [];
  for (const w of words) {
    if (!isCandidate(w)) continue;
    const lower = w.toLowerCase();
    if (STOP.has(lower) || exclude.has(lower)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
}

/** The exclude set: everything already redaction-listed, plus the repo labels. */
function excludeSet(config) {
  const ex = new Set();
  const lists = [config?.redaction?.codenames, config?.redaction?.names, config?.redaction?.terms];
  for (const list of lists) {
    for (const t of Array.isArray(list) ? list : []) if (typeof t === 'string') ex.add(t.toLowerCase());
  }
  for (const r of Array.isArray(config?.repos) ? config.repos : []) {
    if (typeof r?.label === 'string') ex.add(r.label.toLowerCase());
  }
  return ex;
}

/**
 * harvestFromDigest(digest, config) -> [{ term, count }, ...]
 * Pure: walks every string in the (redacted) digest and proposes candidate
 * private nouns, most-frequent first. Already-listed terms and repo labels are
 * excluded.
 */
export function harvestFromDigest(digest, config) {
  const exclude = excludeSet(config);
  const strings = [];
  collectStrings(digest, strings);
  const counts = new Map();
  for (const s of strings) {
    for (const [w, n] of harvestNouns(s, { exclude })) counts.set(w, (counts.get(w) || 0) + n);
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

/** Append HARVEST_FILE to .gitignore idempotently (the sidecar holds raw nouns). */
function ensureHarvestGitignored(cwd) {
  const giPath = join(cwd, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  if (!existing.split(/\r?\n/).some((l) => l.trim() === HARVEST_FILE)) {
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(giPath, `${prefix}${HARVEST_FILE}\n`);
  }
}

/**
 * runHarvest({ cwd, argv, now, io }) -> exit code.
 * Reads the redacted draft, proposes denylist candidates, writes the gitignored
 * sidecar, and prints ONLY the count.
 */
export async function runHarvest({ cwd = process.cwd(), argv = [], now = new Date(), io = defaultIo() } = {}) {
  let config;
  try {
    config = loadConfig(join(cwd, CONFIG_FILE));
  } catch (err) {
    io.err(`harvest: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }

  const draftPath = join(cwd, DRAFT_FILE);
  if (!existsSync(draftPath)) {
    io.err(`harvest: ${DRAFT_FILE} not found in ${cwd}. Run discover first.\n`);
    return io.exit(1) ?? 1;
  }
  let digest;
  try {
    digest = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch (err) {
    io.err(`harvest: ${DRAFT_FILE} is not valid JSON (${err.message}).\n`);
    return io.exit(1) ?? 1;
  }

  const candidates = harvestFromDigest(digest, config);
  writeFileSync(
    join(cwd, HARVEST_FILE),
    `${JSON.stringify({ generatedAt: now.toISOString(), candidates }, null, 2)}\n`
  );
  ensureHarvestGitignored(cwd);

  // Count only — the raw candidate nouns stay in the gitignored sidecar.
  io.out(
    `harvest: ${candidates.length} candidate noun(s) written to ${HARVEST_FILE} (gitignored). ` +
      `Review it and add any private ones to config.redaction.\n`
  );
  return 0;
}

export default function run(argv) {
  return runHarvest({ argv });
}
