// The session-end handoff source: bounded extraction (tagged claims, reversals,
// backtick SHAs), week-windowed by filename timestamp, display repos never read,
// and redaction applied to the pulled prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractHandoff, handoffTimestamp, discoverHandoffs } from '../lib/handoffs.mjs';
import { createRedactor } from '../lib/redact.mjs';

test('handoffTimestamp parses the filename timestamp, null otherwise', () => {
  assert.equal(handoffTimestamp('20260624T010817Z_slug.md'), Date.parse('2026-06-24T01:08:17Z'));
  assert.equal(handoffTimestamp('no-timestamp.md'), null);
});

test('extractHandoff pulls tagged claims, reversals, and backtick SHAs only', () => {
  const md = [
    '# Handoff',
    '- Built the verify engine [verified] against real commits in `5c2282f`.',
    'Retry queue designed [assumed] but not wired in.',
    'A loose hex token deadbeef1 that is NOT in backticks.',
    '',
    '## Reversals / corrections',
    "- Don't resurrect the NUL sentinel — use fromCharCode.",
  ].join('\n');
  const { claims, reversals, commits } = extractHandoff(md);

  assert.ok(claims.some((c) => c.tag === 'verified' && /verify engine/.test(c.text)));
  assert.ok(claims.some((c) => c.tag === 'assumed' && /Retry queue/.test(c.text)));
  assert.deepEqual(commits, ['5c2282f'], 'only the backtick-wrapped sha is a candidate');
  assert.ok(!commits.includes('deadbeef1'), 'a non-backtick hex token is not a candidate');
  assert.ok(reversals.some((r) => /NUL sentinel/.test(r)));
});

function repoWithHandoffs(role, files) {
  const dir = mkdtempSync(join(tmpdir(), 'hw-handoff-'));
  const hd = join(dir, '.claude', 'handoffs');
  mkdirSync(hd, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(hd, name), body);
  return { label: role === 'display' ? 'client' : 'app', path: dir, resolvedPath: dir, role };
}

const WEEK = { weekStart: new Date('2026-06-22T00:00:00Z'), weekEnd: new Date('2026-06-28T23:59:59Z') };

test('discoverHandoffs reads in-window handoffs from featured repos and redacts the prose', () => {
  const repo = repoWithHandoffs('featured', {
    '20260624T010817Z_in-window.md': 'Shipped the Falcon integration [verified] in `9713875`.',
    '20260601T090000Z_out-of-window.md': 'Old work [verified] in `aaaaaaa`.',
  });
  try {
    const redactor = createRedactor({ redaction: { codenames: ['Falcon'], names: [], terms: [] } });
    const got = discoverHandoffs({ config: { repos: [repo] }, ...WEEK, redactor });
    assert.equal(got.length, 1, 'only the in-window handoff is included');
    const e = got[0];
    assert.equal(e.repo, 'app');
    assert.equal(e.source, 'handoff');
    assert.deepEqual(e.candidateCommits, [{ sha: '9713875', date: null, subject: '' }]);
    assert.ok(e.claims[0].tag === 'verified');
    assert.doesNotMatch(e.claims[0].text, /Falcon/, 'the configured codename is redacted out of the claim');
    assert.match(e.id, /^\d{8}T\d{6}Z$/, 'id is the non-identifying timestamp token');
  } finally {
    rmSync(repo.resolvedPath, { recursive: true, force: true });
  }
});

test('discoverHandoffs NEVER reads a display-role repo', () => {
  const repo = repoWithHandoffs('display', {
    '20260624T010817Z_secret.md': 'Client work [verified] in `9713875`.',
  });
  try {
    const got = discoverHandoffs({ config: { repos: [repo] }, ...WEEK, redactor: createRedactor({}) });
    assert.deepEqual(got, [], 'a display repo contributes no handoff entries');
  } finally {
    rmSync(repo.resolvedPath, { recursive: true, force: true });
  }
});

test('discoverHandoffs falls back to mtime when the filename has no timestamp', () => {
  const repo = repoWithHandoffs('featured', { 'untimestamped.md': 'Work [verified] in `9713875`.' });
  try {
    const inWindow = new Date('2026-06-24T01:00:00Z');
    utimesSync(join(repo.resolvedPath, '.claude', 'handoffs', 'untimestamped.md'), inWindow, inWindow);
    const got = discoverHandoffs({ config: { repos: [repo] }, ...WEEK, redactor: createRedactor({}) });
    assert.equal(got.length, 1);
    assert.match(got[0].id, /^handoff-[0-9a-f]{8}$/, 'no-timestamp handoff gets a hashed id');
  } finally {
    rmSync(repo.resolvedPath, { recursive: true, force: true });
  }
});
