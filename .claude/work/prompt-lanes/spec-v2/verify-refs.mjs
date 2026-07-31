#!/usr/bin/env node
// D33, as restated by D66: mechanically verify every code reference the spec makes.
//
// Three checks:
//   1. PATHS    - every backticked repo-relative path mentioned in a spec file exists.
//   2. CLAIMS   - every entry in claims.json resolves: the file exists, and (when a line is
//                 given) that line contains the quoted token; when no line is given, the token
//                 appears somewhere in the file.
//   3. CITATIONS - D66: every inline `path:line` citation in a spec file has a matching claims
//                 entry, so the claims table is the complete record. This tool does not verify a
//                 cited line semantically on its own; it verifies that every citation is in the
//                 table, and check 2 verifies the table. A citation with no entry is a defect,
//                 because it is a code reference nothing checks.
//
// Usage: node verify-refs.mjs <repoRoot> <specDir>
//        node verify-refs.mjs --self-test        (proves check 3 can fail)
// Exits 1 with a report if anything is stale.

import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---- self-test ------------------------------------------------------------
// A check nobody has seen fail is not evidence. This runs the real script against a synthetic spec
// dir whose only citation is uncatalogued, and asserts the command fails for that reason.
if (process.argv[2] === '--self-test') {
  const dir = mkdtempSync(join(tmpdir(), 'verify-refs-selftest-'));
  try {
    writeFileSync(join(dir, 'planned-paths.json'), '[]');
    writeFileSync(join(dir, 'claims.json'), '[]');
    writeFileSync(join(dir, 'phase-x.md'), 'Cites `lib/build.mjs:1` with no claims entry.\n');
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), repoRootArg(), dir], {
      encoding: 'utf8',
    });
    const out = (run.stdout ?? '') + (run.stderr ?? '');
    const sawFailure = run.status === 1 && out.includes('no matching claims entry (D66)');
    console.log(sawFailure
      ? 'verify-refs --self-test: OK (an uncatalogued citation fails the command)'
      : `verify-refs --self-test: FAILED - status ${run.status}, output:\n${out}`);
    process.exit(sawFailure ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function repoRootArg() {
  return resolve(process.argv[3] ?? '.');
}

const repoRoot = resolve(process.argv[2] ?? '.');
const specDir = resolve(process.argv[3] ?? '.');

const specFiles = readdirSync(specDir).filter((f) => f.endsWith('.md'));
const failures = [];
let pathChecks = 0;
let claimChecks = 0;

// ---- 1. PATHS -------------------------------------------------------------
// A backticked token is treated as a repo path when it has a known source extension
// and at least one slash, or is a known top-level doc.
const PATH_RE = /`([A-Za-z0-9_./-]+\.(?:mjs|json|md|jsonl))`/g;
const TOP_LEVEL_DOCS = new Set(['README.md', 'SKILL.md', 'AGENTS.md', 'package.json']);
// Paths the spec proposes creating. Absence is expected, not a failure.
const PLANNED = new Set(
  JSON.parse(readFileSync(join(specDir, 'planned-paths.json'), 'utf8')),
);

for (const f of specFiles) {
  const text = readFileSync(join(specDir, f), 'utf8');
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1];
    if (PLANNED.has(p)) continue;
    if (!p.includes('/') && !TOP_LEVEL_DOCS.has(p)) continue;
    pathChecks++;
    if (!existsSync(join(repoRoot, p))) {
      failures.push(`${f}: path does not exist and is not in planned-paths.json -> ${p}`);
    }
  }
}

// ---- 2. CLAIMS ------------------------------------------------------------
// Each authoring pass writes its own claims file so concurrent passes cannot collide.
const claimFiles = readdirSync(specDir)
  .filter((f) => f.startsWith('claims') && f.endsWith('.json'))
  .sort();
const claims = claimFiles.flatMap((f) => JSON.parse(readFileSync(join(specDir, f), 'utf8')));
for (const c of claims) {
  claimChecks++;
  const full = join(repoRoot, c.file);
  if (!existsSync(full)) {
    failures.push(`claim "${c.why}": file missing -> ${c.file}`);
    continue;
  }
  const lines = readFileSync(full, 'utf8').split('\n');
  if (c.line == null) {
    if (!lines.some((l) => l.includes(c.contains))) {
      failures.push(`claim "${c.why}": ${c.file} contains no ${JSON.stringify(c.contains)}`);
    }
    continue;
  }
  const idx = c.line - 1;
  const got = lines[idx];
  if (got === undefined) {
    failures.push(`claim "${c.why}": ${c.file}:${c.line} is past end of file (${lines.length} lines)`);
    continue;
  }
  if (!got.includes(c.contains)) {
    // Tolerate a small drift window so a one-line shift reports the true location.
    let found = null;
    for (let d = 1; d <= 12; d++) {
      if (lines[idx - d]?.includes(c.contains)) { found = c.line - d; break; }
      if (lines[idx + d]?.includes(c.contains)) { found = c.line + d; break; }
    }
    failures.push(
      `claim "${c.why}": ${c.file}:${c.line} does not contain ${JSON.stringify(c.contains)}` +
        (found ? ` (found at :${found} - update the reference)` : ' (not found nearby)'),
    );
  }
}

// ---- 3. CITATIONS (D66) ---------------------------------------------------
// Every inline `path:line` in a spec file must appear in the claims table. The table is then the
// complete record of what check 2 verifies, so no code reference escapes verification.
const CITE_RE = /`([A-Za-z0-9_./-]+\.(?:mjs|json|md|jsonl)):(\d+)`/g;
const catalogued = new Set(
  claims.filter((c) => c.line != null).map((c) => `${c.file}:${c.line}`),
);
let citationChecks = 0;
for (const f of specFiles) {
  const text = readFileSync(join(specDir, f), 'utf8');
  for (const m of text.matchAll(CITE_RE)) {
    const key = `${m[1]}:${m[2]}`;
    citationChecks++;
    if (!catalogued.has(key)) {
      failures.push(`${f}: cites ${key} with no matching claims entry (D66)`);
    }
  }
}

console.log(
  `verify-refs: ${pathChecks} path checks, ${claimChecks} claim checks, ` +
    `${citationChecks} citation checks`,
);
if (failures.length) {
  console.error(`\nSTALE (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('verify-refs: OK');
