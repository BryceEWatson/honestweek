// Clean-room guard: honestweek's site-integration code is GENERIC. The schema,
// field names, repo names, and labels of any one target site live ONLY in that
// site's committed adapter (honestweek.site.json), never in honestweek itself.
// This test fails if a known target-specific token leaks into lib/site/, so the
// generic capability can never quietly grow a dependency on one site's specifics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(HERE, '..', 'lib', 'site');

// Tokens specific to the first real integration target (brycewatson.com) and to
// no generic concept: its proper nouns / repo names, and its site-only artifact
// field names. Generic counting vocabulary (e.g. "byProject", "projectTotals")
// is honestweek's own and is intentionally NOT listed — convergent generic naming
// is not a leak; a target proper noun or a site-only render field is.
const FORBIDDEN = [
  'brycewatson',
  'DemandForge',
  'claude-global-skills',
  'dropKnowledge',
  'Akaya',
  'ShopForge',
  'wl-panel',
  'ReportPanel',
  'build-work-log',
  'work-log',
  'nextUp',
  'infoTerms',
  'glossary',
  'frontier',
  'weekLabel',
  'bryceewatson',
];

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
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = file.replace(/\\/g, '/').split('/lib/')[1] ?? file;
    for (const token of FORBIDDEN) {
      assert.ok(!new RegExp(token, 'i').test(text), `clean-room violation in ${label}: token "${token}" found in ${rel}`);
    }
    // The operator's own account name. Path examples in comments are the way this
    // slips in: two of them carried a real Windows account name before review.
    assert.ok(!/\bBryce\b/i.test(text), `clean-room violation in ${label}: an operator account name appears in ${rel}`);
  }
}

test('lib/site contains no target-specific tokens (clean-room)', () => {
  const files = allFiles(SITE_DIR);
  assert.ok(files.length >= 6, 'expected the site modules to be present');
  assertCleanRoom(files, 'lib/site');
});

// The same fence over the mining subsystem. It was NOT covered when `mine` landed,
// which is exactly why a real account name reached two of its comments — the guard
// existed but was scoped to one directory, so a new generic subsystem grew outside it.
test('lib/mine contains no target-specific tokens (clean-room)', () => {
  const files = [...allFiles(join(HERE, '..', 'lib', 'mine')), join(HERE, '..', 'lib', 'mine.mjs')];
  assert.ok(files.length >= 6, 'expected the mine modules to be present');
  assertCleanRoom(files, 'lib/mine');
});

// The work-history engine, its developer tool, its fixtures and its doc: the same fence.
test('lib/replay, its harness, fixtures and doc are clean-room', () => {
  const files = [...allFiles(join(HERE, '..', 'lib', 'replay')), join(HERE, '..', 'tools', 'replay-inspect.mjs'), ...allFiles(join(HERE, 'fixtures', 'replay')), join(HERE, '..', 'docs', 'work-history-engine.md')];
  assert.ok(files.length >= 12, 'expected the replay modules to be present');
  assertCleanRoom(files, 'lib/replay');
});

// The demo week is invented end to end, so the same fence holds over it.
test('the demo week, its test and its doc are clean-room', () => {
  const files = [...allFiles(join(HERE, '..', 'lib', 'demo')), join(HERE, '..', 'tools', 'demo-week.mjs'), join(HERE, 'demo-week.test.mjs'), join(HERE, '..', 'docs', 'demo-week.md')];
  assert.ok(files.length >= 4, 'expected the demo week builder to be present');
  assertCleanRoom(files, 'demo week');
});

// The local page: the command, its server and data, every page and script it serves
// (assets/ and selftest/), its tests, and its doc once the plan has become one.
test('honestweek view, its pages, its tests and its doc are clean-room', () => {
  const doc = ['local-page.md', 'local-page-plan.md'].map((f) => join(HERE, '..', 'docs', f)).filter((f) => existsSync(f));
  const tests = readdirSync(HERE).filter((f) => /^view-.*\.test\.mjs$/.test(f)).map((f) => join(HERE, f));
  const files = [...allFiles(join(HERE, '..', 'lib', 'view')), join(HERE, '..', 'lib', 'view.mjs'), ...allFiles(join(HERE, 'fixtures', 'view')), ...tests, ...doc];
  assert.ok(files.length >= 8, 'expected the view modules to be present');
  assertCleanRoom(files, 'honestweek view');
});

test('the shipped docs and example config are clean-room too', () => {
  assertCleanRoom([join(HERE, '..', 'docs', 'mining.md'), join(HERE, '..', 'docs', 'reader-profiles.md'), join(HERE, '..', 'honestweek.config.example.json')], 'docs + example config');
});

// The client report is generic too: it must not carry any real client, product or
// person, because every client's name comes from their own config.
test('the client report modules are clean-room (clean-room)', () => {
  const files = ['client.mjs', 'history.mjs', 'reader.mjs', join('emit', 'client.mjs'), join('readers', 'default.json'), join('readers', 'client.json')].map((f) => join(HERE, '..', 'lib', f));
  assertCleanRoom(files, 'client report');
});

// The problem checks, their shipped catalog of known agent problems, and their tests.
test('lib/problems, its catalog and its tests are clean-room', () => {
  const tests = readdirSync(HERE).filter((f) => /^problems-.*\.test\.mjs$/.test(f)).map((f) => join(HERE, f));
  const files = [...allFiles(join(HERE, '..', 'lib', 'problems')), ...tests];
  assert.ok(files.length >= 1, 'expected the problem checks to be present');
  assertCleanRoom(files, 'lib/problems');
});
