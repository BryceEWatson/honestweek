// The noun-harvester: propose redaction-denylist candidates from the redacted
// draft to a gitignored sidecar, surfacing ONLY the count (never the raw nouns).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { harvestNouns, harvestFromDigest, runHarvest } from '../lib/harvest.mjs';

test('harvestNouns proposes CamelCase / ALLCAPS / capitalized tokens and counts them', () => {
  const counts = harvestNouns('ShopForge shipped. ShopForge again. ACME and Zephyr. The Monday build.');
  assert.equal(counts.get('ShopForge'), 2);
  assert.equal(counts.get('ACME'), 1);
  assert.equal(counts.get('Zephyr'), 1);
  assert.ok(!counts.has('The'), 'common word excluded');
  assert.ok(!counts.has('Monday'), 'day name excluded');
  assert.ok(!counts.has('build'), 'lowercase / stoplisted excluded');
});

test('harvestNouns honors an exclude set', () => {
  const counts = harvestNouns('Falcon and Zephyr', { exclude: new Set(['falcon']) });
  assert.ok(!counts.has('Falcon'), 'excluded term dropped');
  assert.ok(counts.has('Zephyr'));
});

test('harvestFromDigest walks nested strings and excludes listed terms + repo labels', () => {
  const config = {
    repos: [{ label: 'App', role: 'featured' }],
    redaction: { codenames: ['Falcon'], names: [], terms: [] },
  };
  const digest = {
    sessions: [{ steers: ['Falcon work on App with Zephyr'], notes: ['ShopForge and Zephyr again'] }],
    handoffs: [{ claims: [{ text: 'Zephyr integration' }] }],
  };
  const got = harvestFromDigest(digest, config);
  const terms = got.map((c) => c.term);
  assert.ok(!terms.includes('Falcon'), 'configured codename excluded');
  assert.ok(!terms.includes('App'), 'repo label excluded');
  assert.equal(got[0].term, 'Zephyr', 'most-frequent candidate first');
  assert.equal(got[0].count, 3);
  assert.ok(terms.includes('ShopForge'));
});

test('runHarvest writes a gitignored sidecar with candidates and prints only the count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-harvest-'));
  try {
    writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({
      identity: { authorEmails: ['me@example.com'] },
      repos: [{ label: 'app', path: '.', role: 'featured' }],
      redaction: { codenames: [], names: [], terms: [] },
    }));
    writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({
      sessions: [{ steers: ['Worked with Zephyr on the ShopForge migration'] }],
    }));

    const out = [];
    const code = await runHarvest({ cwd: dir, now: new Date('2024-06-17T00:00:00Z'), io: { out: (s) => out.push(s), err: (s) => out.push(s), exit: (c) => c } });
    assert.equal(code, 0);

    const sidecar = JSON.parse(readFileSync(join(dir, 'honestweek.harvest.json'), 'utf8'));
    const terms = sidecar.candidates.map((c) => c.term);
    assert.ok(terms.includes('Zephyr') && terms.includes('ShopForge'), 'candidates captured in the sidecar');

    const stdout = out.join('');
    assert.match(stdout, /candidate noun\(s\)/);
    assert.doesNotMatch(stdout, /Zephyr|ShopForge/, 'raw candidate nouns must NEVER reach stdout');

    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /honestweek\.harvest\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
