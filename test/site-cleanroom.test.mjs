// Clean-room guard: honestweek's site-integration code is GENERIC. The schema,
// field names, repo names, and labels of any one target site live ONLY in that
// site's committed adapter (honestweek.site.json), never in honestweek itself.
// This test fails if a known target-specific word leaks into lib/site (and the
// other generic subsystems below), so the generic capability can never quietly
// grow a dependency on one site's specifics.
//
// The forbidden words are kept only as SHA-256 hashes (test/helpers/clean-room.mjs),
// so this fence doesn't publish the names it keeps out. test/clean-room.test.mjs
// proves the matcher catches a planted word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_NAME_HASHES, SITE_FIELD, SITE_FIELD_HASHES, privateForbidden, readOwner, scanText } from './helpers/clean-room.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SITE_DIR = join(ROOT, 'lib', 'site');
const OWNER = readOwner(ROOT);
const FENCE = new Map([...privateForbidden(OWNER), ...SITE_FIELD_HASHES.map((h) => [h, SITE_FIELD])]);

function allFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

function assertCleanRoom(files, label) {
  const found = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    found.push(...scanText(readFileSync(file, 'utf8'), rel, FENCE, OWNER.handle));
  }
  assert.deepEqual(found, [], `clean-room violation in ${label}`);
}

test('the hashed fence lists are well formed and the owner identity is present', () => {
  const all = [...PRIVATE_NAME_HASHES, ...SITE_FIELD_HASHES];
  for (const h of all) assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(new Set(all).size, all.length, 'no duplicate hashes');
  // A package.json without an author or a GitHub repository URL would quietly switch the
  // owner half of the fence off.
  assert.ok(OWNER.tokens.size >= 3, 'package.json names an author (two or more words) and a GitHub repository');
  assert.ok(OWNER.handle, 'the repository URL carries a GitHub handle');
});

test('lib/site contains no target-specific tokens (clean-room)', () => {
  const files = allFiles(SITE_DIR);
  assert.ok(files.length >= 6, 'expected the site modules to be present');
  assertCleanRoom(files, 'lib/site');
});

// The same fence over the mining subsystem. It was NOT covered when `mine` landed,
// which is exactly why a real account name reached two of its comments — the guard
// existed but was scoped to one directory, so a new generic subsystem grew outside it.
test('lib/mine contains no target-specific tokens (clean-room)', () => {
  const files = [...allFiles(join(ROOT, 'lib', 'mine')), join(ROOT, 'lib', 'mine.mjs')];
  assert.ok(files.length >= 6, 'expected the mine modules to be present');
  assertCleanRoom(files, 'lib/mine');
});

// The work-history engine, its developer tool, its fixtures and its doc: the same fence.
test('lib/replay, its harness, fixtures and doc are clean-room', () => {
  const files = [...allFiles(join(ROOT, 'lib', 'replay')), join(ROOT, 'tools', 'replay-inspect.mjs'), ...allFiles(join(HERE, 'fixtures', 'replay')), join(ROOT, 'docs', 'work-history-engine.md')];
  assert.ok(files.length >= 12, 'expected the replay modules to be present');
  assertCleanRoom(files, 'lib/replay');
});

// The demo week is invented end to end, so the same fence holds over it.
test('the demo week, its test and its doc are clean-room', () => {
  const files = [...allFiles(join(ROOT, 'lib', 'demo')), join(ROOT, 'tools', 'demo-week.mjs'), join(HERE, 'demo-week.test.mjs'), join(ROOT, 'docs', 'demo-week.md')];
  assert.ok(files.length >= 4, 'expected the demo week builder to be present');
  assertCleanRoom(files, 'demo week');
});

// The local page: the command, its server and data, every page and script it serves
// (assets/ and selftest/), its tests, and its doc once the plan has become one.
test('honestweek view, its pages, its tests and its doc are clean-room', () => {
  const doc = ['local-page.md', 'local-page-plan.md'].map((f) => join(ROOT, 'docs', f)).filter((f) => existsSync(f));
  const tests = readdirSync(HERE).filter((f) => /^view-.*\.test\.mjs$/.test(f)).map((f) => join(HERE, f));
  const files = [...allFiles(join(ROOT, 'lib', 'view')), join(ROOT, 'lib', 'view.mjs'), ...allFiles(join(HERE, 'fixtures', 'view')), ...tests, ...doc];
  assert.ok(files.length >= 8, 'expected the view modules to be present');
  assertCleanRoom(files, 'honestweek view');
});

test('the shipped docs and example config are clean-room too', () => {
  assertCleanRoom([join(ROOT, 'docs', 'mining.md'), join(ROOT, 'docs', 'reader-profiles.md'), join(ROOT, 'honestweek.config.example.json')], 'docs + example config');
});

// The client report is generic too: it must not carry any real client, product or
// person, because every client's name comes from their own config.
test('the client report modules are clean-room (clean-room)', () => {
  const files = ['client.mjs', 'history.mjs', 'reader.mjs', join('emit', 'client.mjs'), join('readers', 'default.json'), join('readers', 'client.json')].map((f) => join(ROOT, 'lib', f));
  assertCleanRoom(files, 'client report');
});

// The problem checks, their shipped catalog of known agent problems, and their tests.
test('lib/problems, its catalog and its tests are clean-room', () => {
  const tests = readdirSync(HERE).filter((f) => /^problems-.*\.test\.mjs$/.test(f)).map((f) => join(HERE, f));
  const files = [...allFiles(join(HERE, '..', 'lib', 'problems')), ...tests];
  assert.ok(files.length >= 1, 'expected the problem checks to be present');
  assertCleanRoom(files, 'lib/problems');
});
