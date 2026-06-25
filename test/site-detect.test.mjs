// detectSite recognizes a website by its framework dependency / config / data
// conventions, and reports false for a non-site directory. inferSchema derives an
// artifact's STRUCTURE from real sample bytes without echoing any value. Both use
// SYNTHETIC fixtures (a toy framework + a toy artifact) — no target field names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectSite } from '../lib/site/detect.mjs';
import { inferSchema } from '../lib/site/inspect.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'hw-detect-'));
}

test('detectSite finds a framework by dependency + lists data artifacts', () => {
  const root = tmp();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'toy-site', dependencies: { astro: '^4.0.0' } })
    );
    writeFileSync(join(root, 'astro.config.mjs'), 'export default {}');
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    writeFileSync(join(root, 'src', 'data', 'toy.json'), '{"a":1}');

    const r = detectSite(root);
    assert.equal(r.isSite, true);
    assert.ok(r.frameworks.includes('astro'));
    assert.ok(r.signals.includes('dependency:astro'));
    assert.ok(r.signals.includes('config:astro'));
    assert.deepEqual(r.dataArtifacts, ['src/data/toy.json']);
    assert.equal(r.packageName, 'toy-site');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectSite returns isSite=false for a non-site directory', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'a-library', dependencies: { lodash: '^4' } }));
    writeFileSync(join(root, 'index.js'), 'module.exports = {}');
    const r = detectSite(root);
    assert.equal(r.isSite, false);
    assert.deepEqual(r.frameworks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectSite never throws on an unreadable / empty directory', () => {
  const r = detectSite(join(tmpdir(), 'hw-detect-does-not-exist-zzz'));
  assert.equal(r.isSite, false);
  assert.deepEqual(r.dataArtifacts, []);
});

test('inferSchema reports STRUCTURE (types, keys, formats) without echoing values', () => {
  const sample = JSON.stringify({
    meta: { generatedAt: '2024-06-19T00:00:00Z', total: 12 },
    days: [
      { date: '2024-06-10', total: 4, byRepo: { a: 1, b: 3 } },
      { date: '2024-06-11', total: 0, byRepo: {}, note: 'quiet' },
    ],
  });
  const schema = inferSchema(sample);

  assert.equal(schema.type, 'object');
  assert.equal(schema.keys.meta.type, 'object');
  assert.equal(schema.keys.meta.keys.generatedAt.format, 'datetime');
  assert.equal(schema.keys.meta.keys.total.type, 'number');
  assert.equal(schema.keys.days.type, 'array');
  assert.equal(schema.keys.days.items.type, 'object');
  assert.equal(schema.keys.days.items.keys.date.format, 'date');
  // `note` appears on only one element -> merged as optional.
  assert.ok(schema.keys.days.items.optional.includes('note'));
  // byRepo is a dynamic-keyed numeric map -> flagged for derivedTree.
  assert.equal(schema.keys.days.items.keys.byRepo.dynamicKeyed, true);

  // No scalar VALUE is echoed anywhere in the schema (privacy).
  const blob = JSON.stringify(schema);
  assert.ok(!blob.includes('2024-06-19'), 'a date value must not leak into the schema');
  assert.ok(!blob.includes('quiet'), 'a prose value must not leak into the schema');
  assert.ok(!/[:,]12[,}]/.test(blob), 'a numeric value must not leak into the schema');
});

test('inferSchema throws a value-free error on non-JSON input', () => {
  assert.throws(() => inferSchema('{ not json'), /not valid JSON/);
});
