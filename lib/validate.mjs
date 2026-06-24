// lib/validate.mjs — the `validate` subcommand: a pre-build honesty/leak gate on
// the AUTHORED items file.
//
// build's verify-or-abort guards the git CLAIMS (a cited commit must resolve and
// be yours). validate guards the AUTHORING — the one place a model put words into
// the output — BEFORE build runs:
//   1. every item carries a valid status badge (a typo'd badge would otherwise
//      silently downgrade at build);
//   2. every item carries a receipt (a commit or a session pointer);
//   3. no display-role repo is NAMED or git-cited (private-by-default: display
//      items must be generic — no repo name, no commit);
//   4. no configured redaction term survived into the authored prose (distil it
//      out; never rely on build-time scrubbing to hide an authored leak).
//
// It writes NOTHING and makes no network/git call — it reads config + items and
// reports. Optional `--no-dashes` adds a voice rule (no em/en dash, no " -- ");
// OFF by default to stay clean-room (em dashes are fine generically). On any
// problem it exits 2, mirroring build's abort discipline at the authoring layer.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import { STATUSES } from './badges.mjs';

const CONFIG_FILE = 'honestweek.config.json';
const ITEMS_FILE = 'honestweek.items.json';

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
}

/** Every SHA an item cites, from any supported provenance field. */
function citedShas(item) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  add(item.primaryCommit);
  add(item.commit);
  add(item.receipt?.primaryCommit);
  if (Array.isArray(item.commits)) item.commits.forEach(add);
  if (Array.isArray(item.candidateCommits)) {
    item.candidateCommits.forEach((c) => add(typeof c === 'string' ? c : c?.sha));
  }
  return out;
}

/** True iff the item points to a source (a cited commit or a session pointer). */
function hasReceipt(item) {
  if (citedShas(item).length > 0) return true;
  const r = item.receipt;
  if (typeof r === 'string' && r.trim()) return true;
  if (r && typeof r === 'object' && (r.sessionId || r.ref || r.turn)) return true;
  return Boolean(item.sessionId ?? item.session ?? item.id);
}

function itemText(item) {
  const t = item?.text ?? item?.summary;
  return typeof t === 'string' ? t : '';
}

function itemRef(item, index) {
  return item?.id ?? `item[${index}]`;
}

function itemRepoLabel(item) {
  return item?.repo ?? item?.repoLabel ?? item?.label ?? null;
}

/**
 * validateItems(items, config, { noDashes }) -> { ok, problems }
 *
 * Pure: collects every authoring problem; NEVER throws on a bad item and NEVER
 * calls process.exit. The runner owns the exit-2 abort. Note: a leaked private
 * term is reported by ITEM, never echoed, so validate output can't itself leak.
 */
export function validateItems(items, config, { noDashes = false } = {}) {
  const problems = [];
  const roleByLabel = new Map((config?.repos ?? []).map((r) => [r.label, r.role]));
  const terms = [
    ...(config?.redaction?.codenames ?? []),
    ...(config?.redaction?.names ?? []),
    ...(config?.redaction?.terms ?? []),
  ].filter((t) => typeof t === 'string' && t.trim());

  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const ref = itemRef(item, index);
    const text = itemText(item);
    const label = itemRepoLabel(item);
    const isDisplay = label != null && roleByLabel.get(label) === 'display';

    // 1. badge: an explicit status must be one of the canonical ones.
    if (item.status != null && !STATUSES.includes(item.status)) {
      problems.push({ item: ref, reason: `invalid status ${JSON.stringify(item.status)} (must be one of ${JSON.stringify(STATUSES)}).` });
    }

    // 2. receipt: every item must point to a source.
    if (!hasReceipt(item)) {
      problems.push({ item: ref, reason: 'no receipt — every item must cite a commit or carry a session pointer.' });
    }

    // 3. text present.
    if (!text.trim()) {
      problems.push({ item: ref, reason: 'missing text/summary.' });
    }

    // 4. display discipline: a display-role repo must never be named or git-cited.
    if (isDisplay) {
      problems.push({ item: ref, reason: `names display-role repo ${JSON.stringify(label)} — display items must be generic (no repo name).` });
      if (citedShas(item).length > 0) {
        problems.push({ item: ref, reason: `cites a commit against display-role repo ${JSON.stringify(label)} — display repos are NEVER git-read.` });
      }
    }

    // 5. redaction-term leak: a configured private term surviving authored prose.
    //    Reported by item only — the term itself is never echoed.
    const lower = text.toLowerCase();
    if (terms.some((term) => lower.includes(term.toLowerCase()))) {
      problems.push({ item: ref, reason: 'authored text contains a configured private term (a redaction.* entry). Distil it out — do not rely on build-time scrubbing.' });
    }

    // 6. voice (opt-in): no em/en dash, no " -- ".
    if (noDashes && (/[—–]/.test(text) || / -- /.test(text))) {
      problems.push({ item: ref, reason: 'contains an em/en dash or " -- " (voice rule, enabled by --no-dashes).' });
    }
  });

  return { ok: problems.length === 0, problems };
}

/**
 * runValidate({ cwd, argv, io }) -> exit code (0 clean, 2 problems, 1 setup error).
 */
export async function runValidate({ cwd = process.cwd(), argv = [], io = defaultIo() } = {}) {
  const noDashes = argv.includes('--no-dashes');

  let config;
  try {
    config = loadConfig(join(cwd, CONFIG_FILE));
  } catch (err) {
    io.err(`validate: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }

  const itemsPath = join(cwd, ITEMS_FILE);
  if (!existsSync(itemsPath)) {
    io.err(`validate: ${ITEMS_FILE} not found in ${cwd}. Run discover and distil first.\n`);
    return io.exit(1) ?? 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(itemsPath, 'utf8'));
  } catch (err) {
    io.err(`validate: ${ITEMS_FILE} is not valid JSON (${err.message}).\n`);
    return io.exit(1) ?? 1;
  }

  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  const { ok, problems } = validateItems(items, config, { noDashes });
  if (!ok) {
    io.err(`validate: ${problems.length} problem(s) found in ${ITEMS_FILE}:\n`);
    for (const p of problems) io.err(`  - ${p.item}: ${p.reason}\n`);
    io.err('Fix these before running build.\n');
    return io.exit(2) ?? 2;
  }
  io.out(`validate: OK — ${items.length} item(s) pass the badge / receipt / display / leak gate.\n`);
  return 0;
}

export default function run(argv) {
  return runValidate({ argv });
}
