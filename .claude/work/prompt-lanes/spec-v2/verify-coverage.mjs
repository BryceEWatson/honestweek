#!/usr/bin/env node
// Mechanical coverage checks over the revised spec set. Model-free.
//
//   1. Every revision item in every inputs file appears in its own coverage map in decisions.md.
//      Maps are section-scoped and matched to an inputs file by the count in their heading, so two
//      maps whose item numbers overlap cannot silently validate each other's rows.
//   2. Every decision id D1..Dn defined in decisions.md is assigned to at least one phase in
//      phase-assignment.md, unless phase-assignment.md's "Decisions that bind no phase" table
//      exempts it with a stated reason. Exemptions are printed, never silent.
//   3. Every decision assigned to phase N (a "build"/"mint"/"author"/"apply"/"consume" cell)
//      is cited by at least one requirement in phase-<N>.md.
//   4. No phase spec cites a decision id that does not exist.
//   5. Every phase spec has the required section headings, and every R<n> cites a decision.
//
// Usage: node verify-coverage.mjs <specDir>
//
// The checked-in verification-manifest.json is authoritative. Callers cannot choose a subset of
// audit inputs. Supplying explicit inputs is retained only as a negative-control surface: the list
// must exactly equal the manifest list or verification fails.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const specDir = resolve(process.argv[2] ?? '.');
const failures = [];
const manifestPath = join(specDir, 'verification-manifest.json');
if (!existsSync(manifestPath)) {
  console.error('GAPS (1):\n  - verification-manifest.json is missing');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.coverageInputs) || manifest.coverageInputs.length === 0) {
  console.error('GAPS (1):\n  - verification-manifest.json has no version-1 coverageInputs');
  process.exit(1);
}
const inputPaths = manifest.coverageInputs.map(({ path, sha256 }) => {
  const absolute = resolve(specDir, path);
  if (!existsSync(absolute)) failures.push(`manifest coverage input is missing: ${path}`);
  else {
    const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (actual !== sha256) failures.push(`manifest checksum mismatch for coverage input: ${path}`);
  }
  return absolute;
});
const explicitInputs = process.argv.slice(3).map((p) => resolve(p));
if (explicitInputs.length > 0 &&
    (explicitInputs.length !== inputPaths.length || explicitInputs.some((p, i) => p !== inputPaths[i]))) {
  failures.push('explicit coverage inputs do not exactly match the manifest; audit inputs cannot be omitted or reordered');
}

const decisions = readFileSync(join(specDir, 'decisions.md'), 'utf8');
const assignment = readFileSync(join(specDir, 'phase-assignment.md'), 'utf8');

// ---- defined decision ids -------------------------------------------------
const defined = new Set(
  [...decisions.matchAll(/^#{2,3} (D\d+)\b/gm)].map((m) => m[1]),
);
if (defined.size === 0) failures.push('decisions.md defines no "## D<n>" headings');

// ---- 1. item coverage, section-scoped -------------------------------------
// Split decisions.md at every "## Coverage map: all <n> ..." heading and parse rows only inside
// the section that heading opens. Each section is then matched to the inputs file with that many
// items. A map with no inputs file, or an inputs file with no map, is a failure.
const ROW_RE = /^\| (\d+) \| (?:blocker|major|minor|medium) \| (D\d+.*?) \|$/gm;
const mapSections = [];
const mapHeads = [...decisions.matchAll(/^## Coverage map: all (\d+) [^\n]*$/gm)];
for (let i = 0; i < mapHeads.length; i++) {
  const start = mapHeads[i].index + mapHeads[i][0].length;
  const end = i + 1 < mapHeads.length ? mapHeads[i + 1].index : decisions.length;
  const body = decisions.slice(start, end);
  const rows = new Map([...body.matchAll(ROW_RE)].map((m) => [Number(m[1]), m[2]]));
  mapSections.push({ declared: Number(mapHeads[i][1]), heading: mapHeads[i][0].trim(), rows });
}

const usedSections = new Set();
for (const p of inputPaths) {
  const itemCount = JSON.parse(readFileSync(p, 'utf8')).items.length;
  const idx = mapSections.findIndex((s, i) => !usedSections.has(i) && s.declared === itemCount);
  if (idx === -1) {
    failures.push(`no coverage map in decisions.md declares ${itemCount} items (for ${p})`);
    continue;
  }
  usedSections.add(idx);
  const { rows, heading } = mapSections[idx];
  for (let i = 1; i <= itemCount; i++) {
    if (!rows.has(i)) failures.push(`"${heading}" is missing revision item ${i}`);
  }
  for (const [item, cell] of rows) {
    if (item > itemCount) failures.push(`"${heading}" has a row ${item} beyond its ${itemCount} items`);
    for (const d of cell.match(/D\d+/g) ?? []) {
      if (!defined.has(d)) failures.push(`"${heading}": item ${item} cites undefined ${d}`);
    }
  }
}
mapSections.forEach((s, i) => {
  if (!usedSections.has(i)) failures.push(`"${s.heading}" has no inputs file on the command line`);
});

// ---- exemptions, read from phase-assignment.md rather than hardcoded ------
const exemptSection = /## Decisions that bind no phase([\s\S]*?)(?=\n## |$)/.exec(assignment);
const exempt = new Map();
if (!exemptSection) {
  failures.push('phase-assignment.md has no "## Decisions that bind no phase" section');
} else {
  for (const m of exemptSection[1].matchAll(/^\| (D\d+) \| (.+?) \|$/gm)) {
    if (!m[2].trim()) failures.push(`${m[1]} is exempted with no stated reason`);
    exempt.set(m[1], m[2].trim());
  }
}

// ---- 2/3. phase assignment ------------------------------------------------
const VERBS = /\b(build|mint|author|apply|consume|emit|instantiate|extend|strip|provide|fill|define|restatement|re-apply)\b/i;
const assigned = new Map(); // D-id -> Set(phase)
for (const line of assignment.split('\n')) {
  const m = /^\| (D\d+)[^|]*\|(.*)\|\s*$/.exec(line);
  if (!m) continue;
  const id = m[1];
  if (exempt.has(id)) continue; // its row lives in the exemption table, not the phase table
  if (!defined.has(id)) { failures.push(`phase-assignment.md assigns undefined ${id}`); continue; }
  if (assigned.has(id)) { failures.push(`phase-assignment.md has two rows for ${id}`); continue; }
  const cells = m[2].split('|');
  const set = new Set();
  cells.forEach((c, i) => { if (VERBS.test(c)) set.add(i + 1); });
  assigned.set(id, set);
}
for (const d of exempt.keys()) {
  if (!defined.has(d)) failures.push(`the exemption table names undefined ${d}`);
  if (assigned.has(d)) failures.push(`${d} is both exempted and assigned to a phase`);
}
for (const d of defined) {
  if (exempt.has(d)) continue;
  if (!assigned.has(d)) failures.push(`${d} is defined but has no row in phase-assignment.md`);
  else if (assigned.get(d).size === 0) failures.push(`${d} is assigned to no phase`);
}

// ---- 3/4/5. phase specs ---------------------------------------------------
const REQUIRED_HEADINGS = [
  '## In plain terms', '## Scope', '## Out of scope', '## Requirements',
  '## Acceptance criteria', '## Files touched', '## Test plan', '## Risks',
];
for (let n = 1; n <= 4; n++) {
  const p = join(specDir, `phase-${n}.md`);
  if (!existsSync(p)) { failures.push(`phase-${n}.md is missing`); continue; }
  const text = readFileSync(p, 'utf8');
  for (const h of REQUIRED_HEADINGS) {
    if (!text.includes(h)) failures.push(`phase-${n}.md is missing the "${h}" heading`);
  }
  const cited = new Set([...text.matchAll(/\bD(\d+)\b/g)].map((m) => 'D' + m[1]));
  for (const d of cited) {
    if (!defined.has(d)) failures.push(`phase-${n}.md cites undefined ${d}`);
  }
  for (const [d, phases] of assigned) {
    if (phases.has(n) && !cited.has(d)) {
      failures.push(`phase-${n}.md never cites ${d}, which phase-assignment.md assigns to it`);
    }
  }
  // Every requirement must cite a decision.
  const reqs = [...text.matchAll(/^(?:[-*]\s*)?\*{0,2}(R\d+)\*{0,2}[.:) ]([\s\S]*?)(?=\n(?:[-*]\s*)?\*{0,2}R\d+\*{0,2}[.:) ]|\n## )/gm)];
  for (const r of reqs) {
    if (!/\bD\d+\b/.test(r[2])) failures.push(`phase-${n}.md ${r[1]} cites no decision id`);
  }
  if (reqs.length === 0) failures.push(`phase-${n}.md has no parseable R<n> requirements`);
}

console.log(
  `verify-coverage: ${defined.size} decisions, ${mapSections.map((s) => s.declared).join('+')} items, ` +
    `${assigned.size} assignment rows, ${exempt.size} exempt (${[...exempt.keys()].join(', ')})`,
);
if (failures.length) {
  console.error(`\nGAPS (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('verify-coverage: OK');
