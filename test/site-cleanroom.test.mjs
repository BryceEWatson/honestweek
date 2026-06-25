// Clean-room guard: honestweek's site-integration code is GENERIC. The schema,
// field names, repo names, and labels of any one target site live ONLY in that
// site's committed adapter (honestweek.site.json), never in honestweek itself.
// This test fails if a known target-specific token leaks into lib/site/, so the
// generic capability can never quietly grow a dependency on one site's specifics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

test('lib/site contains no target-specific tokens (clean-room)', () => {
  const files = allFiles(SITE_DIR);
  assert.ok(files.length >= 6, 'expected the site modules to be present');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN) {
      assert.ok(
        !new RegExp(token, 'i').test(text),
        `clean-room violation: target-specific token "${token}" found in ${file.replace(/\\/g, '/').split('/lib/site/')[1]}`
      );
    }
  }
});
