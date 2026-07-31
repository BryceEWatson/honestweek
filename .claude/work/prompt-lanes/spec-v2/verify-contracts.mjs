#!/usr/bin/env node
// Semantic-readiness checks for the prompt-lanes planning corpus. Node 18, built-ins only.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const specDir = resolve(process.argv[2] ?? dirname(new URL(import.meta.url).pathname));
const repoRoot = resolve(specDir, '../../../..');
const failures = [];
const read = (path) => readFileSync(path, 'utf8');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function checkManifest(manifest) {
  if (manifest.version !== 1) failures.push('manifest version must be 1');
  for (const key of ['coverageInputs', 'artifacts']) {
    if (!Array.isArray(manifest[key]) || manifest[key].length === 0) {
      failures.push(`manifest ${key} must be a nonempty array`);
      continue;
    }
    const seen = new Set();
    for (const item of manifest[key]) {
      if (!item || typeof item.path !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256 ?? '')) {
        failures.push(`manifest ${key} has a malformed entry`);
        continue;
      }
      if (seen.has(item.path)) failures.push(`manifest ${key} repeats ${item.path}`);
      seen.add(item.path);
      const path = resolve(specDir, item.path);
      if (!existsSync(path)) failures.push(`manifest path is missing: ${item.path}`);
      else if (sha256(path) !== item.sha256) failures.push(`manifest checksum mismatch: ${item.path}`);
    }
  }
  const coverage = new Set((manifest.coverageInputs ?? []).map((x) => x.path));
  for (const required of ['../spec/revision-inputs.json', 'revision-inputs-round2.json', 'revision-inputs-round3.json']) {
    if (!coverage.has(required)) failures.push(`manifest omits required coverage input ${required}`);
  }
  const artifacts = new Set((manifest.artifacts ?? []).map((x) => x.path));
  for (const required of [
    'product-roadmap.md', 'slice-1-end-to-end-prompts.md',
    'decisions.md', 'implementation-control-plan.md', 'phase-assignment.md', 'phase-1.md',
    'phase-2.md', 'phase-3.md', 'phase-4.md',
    'producer-consumer-ledger.json', 'invariant-diff-tests.json', 'audit-closure.json',
    'audit-consistency.json', 'audit-defects.json'
  ]) {
    if (!artifacts.has(required)) failures.push(`manifest omits required artifact ${required}`);
  }
}

function checkLedger(ledger) {
  if (ledger.version !== 1 || !Array.isArray(ledger.entries) || ledger.entries.length === 0) {
    failures.push('producer-consumer ledger must be a nonempty version-1 ledger');
    return;
  }
  const ids = new Set();
  const required = ['id', 'producer', 'consumers', 'schema', 'privacy', 'validation', 'error',
    'positiveControl', 'negativeControl', 'sources', 'status'];
  for (const entry of ledger.entries) {
    for (const key of required) {
      const value = entry?.[key];
      if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
        failures.push(`ledger ${entry?.id ?? '<unknown>'} is missing ${key}`);
      }
    }
    if (ids.has(entry.id)) failures.push(`ledger repeats ${entry.id}`);
    ids.add(entry.id);
    if (entry.status !== 'resolved') failures.push(`ledger ${entry.id} is unresolved: ${entry.status}`);
    if (!entry.schema || typeof entry.schema !== 'object' || Array.isArray(entry.schema) ||
        Object.keys(entry.schema).length === 0) failures.push(`ledger ${entry.id} has no exact schema object`);
    for (const source of entry.sources ?? []) {
      const file = source.split(':')[0];
      const path = file === 'AGENTS.md' || file.startsWith('lib/')
        ? join(repoRoot, file)
        : join(specDir, file);
      if (!existsSync(path)) failures.push(`ledger ${entry.id} cites missing source ${file}`);
    }
  }
}

function checkInvariantTests(suite) {
  if (suite.version !== 1 || !Array.isArray(suite.tests) || suite.tests.length === 0) {
    failures.push('invariant diff tests must be a nonempty version-1 suite');
    return;
  }
  const specText = ['decisions.md', 'phase-1.md', 'phase-2.md', 'phase-3.md', 'phase-4.md']
    .map((f) => read(join(specDir, f))).join('\n');
  for (const test of suite.tests) {
    if (!test.id || !test.positive || !test.negative) {
      failures.push(`invariant test ${test.id ?? '<unknown>'} needs capable positive and negative controls`);
    }
    const sourceText = (test.sources ?? []).map((file) => {
      const path = join(repoRoot, file);
      if (!existsSync(path)) { failures.push(`invariant test ${test.id} cites missing ${file}`); return ''; }
      return read(path);
    }).join('\n');
    for (const token of test.mustContain ?? []) {
      if (!sourceText.includes(token)) failures.push(`invariant test ${test.id} source lacks ${JSON.stringify(token)}`);
    }
    for (const token of test.specMustContain ?? []) {
      if (!specText.includes(token)) failures.push(`invariant test ${test.id} spec lacks ${JSON.stringify(token)}`);
    }
    if (test.specOccurrenceLimit) {
      const { text, max } = test.specOccurrenceLimit;
      const count = specText.split(text).length - 1;
      if (!Number.isInteger(max) || count > max) {
        failures.push(`invariant test ${test.id} found ${count} occurrences of ${JSON.stringify(text)} (max ${max})`);
      }
    }
  }
}

const manifest = JSON.parse(read(join(specDir, 'verification-manifest.json')));
const ledger = JSON.parse(read(join(specDir, 'producer-consumer-ledger.json')));
const invariantTests = JSON.parse(read(join(specDir, 'invariant-diff-tests.json')));
checkManifest(manifest);
checkLedger(ledger);
checkInvariantTests(invariantTests);

for (const file of ['audit-closure.json', 'audit-consistency.json', 'audit-defects.json']) {
  JSON.parse(read(join(specDir, file)));
}
const closure = JSON.parse(read(join(specDir, 'audit-closure.json')));
const consistency = JSON.parse(read(join(specDir, 'audit-consistency.json')));
const defects = JSON.parse(read(join(specDir, 'audit-defects.json')));
if (closure.blockers !== 0 || closure.majorBoundaryGaps !== 0 || closure.status !== 'pass') {
  failures.push('closure audit is not a zero-blocker/zero-major pass');
}
const expectedReleaseGates = ['phase1And2', 'phase3', 'phase4'];
if (consistency.implementationOrderIsSound !== true ||
    Object.keys(consistency.releaseGates ?? {}).sort().join(',') !== expectedReleaseGates.sort().join(',') ||
    Object.values(consistency.releaseGates ?? {}).some((v) => v !== 'PASS')) {
  failures.push('consistency audit does not prove sound order and PASS for the combined Phase 1+2, Phase 3, and Phase 4 release gates');
}
if (defects.blockers !== 0 || defects.majorBoundaryGaps !== 0 || defects.status !== 'pass') {
  failures.push('defect audit is not a zero-blocker/zero-major pass');
}

if (process.argv.includes('--self-test')) {
  const before = failures.length;
  const badLedger = structuredClone(ledger);
  delete badLedger.entries[0].negativeControl;
  checkLedger(badLedger);
  const badManifest = structuredClone(manifest);
  badManifest.coverageInputs = badManifest.coverageInputs.filter((x) => x.path !== 'revision-inputs-round3.json');
  checkManifest(badManifest);
  if (failures.length < before + 2) failures.push('self-test negative controls did not fail');
  else failures.splice(before);
}

console.log(`verify-contracts: ${ledger.entries.length} boundaries, ${invariantTests.tests.length} invariant diffs, ` +
  `${manifest.coverageInputs.length} coverage inputs`);
if (failures.length) {
  console.error(`\nGAPS (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('verify-contracts: OK');
