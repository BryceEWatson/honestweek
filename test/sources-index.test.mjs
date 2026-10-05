// The sources index: docs/sources.md lists every source in the problem catalog once, grouped by
// kind, with the problems that cite it, and it stays exactly what tools/sources-index.mjs writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from './helpers/temp-dir.mjs';
import { KIND_GROUPS, collectSources, escapeMarkdown, main, renderSourcesIndex } from '../tools/sources-index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOOL = join(ROOT, 'tools', 'sources-index.mjs');
const lf = (s) => s.replace(/\r\n/g, '\n');
const loadCatalog = () => JSON.parse(readFileSync(join(ROOT, 'lib', 'problems', 'catalog.json'), 'utf8'));
const readIndex = () => lf(readFileSync(join(ROOT, 'docs', 'sources.md'), 'utf8'));
const quiet = { out: () => {}, err: () => {} };

test('docs/sources.md is exactly what the tool writes from the catalog', () => {
  assert.equal(readIndex(), renderSourcesIndex(loadCatalog()), 'docs/sources.md is out of date: run node tools/sources-index.mjs');
  // The command line writes the same page, and its check agrees.
  const dir = makeTempDir('hw-sources-');
  const out = join(dir, 'sources.md');
  assert.equal(main([out], quiet), 0);
  assert.equal(readFileSync(out, 'utf8'), readIndex());
  assert.match(execFileSync(process.execPath, [TOOL, '--check'], { encoding: 'utf8' }), /up to date/);
});

test('every catalog source is listed once, under its kind, with each problem that cites it', () => {
  const catalog = loadCatalog();
  const page = readIndex();
  // Each entry is a link line, then a "Cited by" line, under the heading for its group.
  const entries = new Map();
  let heading = null;
  const lines = page.split('\n');
  lines.forEach((line, i) => {
    const h = line.match(/^## (.+?)(?: \((\d+)\))?$/);
    if (h) heading = h[1];
    const m = line.match(/^- \[(.+)\]\((https:\/\/[^)\s]+)\) \((.+)\)$/);
    if (!m) return;
    assert.ok(!entries.has(m[2]), `${m[2]} is listed once`);
    assert.match(lines[i + 1], /^ {2}Cited by: .+\.$/, `${m[2]} says what cites it`);
    entries.set(m[2], { heading, cited: lines[i + 1] });
  });
  const urls = new Set(catalog.patterns.flatMap((p) => p.sources.map((s) => s.url)));
  assert.deepEqual([...entries.keys()].sort(), [...urls].sort(), 'the page and the catalog list the same sources');
  for (const p of catalog.patterns) {
    for (const s of p.sources) {
      const e = entries.get(s.url);
      const group = KIND_GROUPS.find((g) => g.kinds?.includes(s.kind)) ?? KIND_GROUPS.at(-1);
      assert.equal(e.heading, group.heading, `${s.url} sits under ${group.heading}`);
      assert.ok(e.cited.includes(escapeMarkdown(p.headline)), `${s.url} names "${p.headline}"`);
    }
  }
  // Each group's count is the number of entries under it.
  for (const g of KIND_GROUPS) {
    const shown = page.match(new RegExp(`^## ${g.heading} \\((\\d+)\\)$`, 'm'));
    if (shown) assert.equal(Number(shown[1]), [...entries.values()].filter((e) => e.heading === g.heading).length, g.heading);
  }
  // Every link leaves for the web; nothing links to a local file.
  for (const m of page.matchAll(/\]\(([^)]*)\)/g)) assert.match(m[1], /^https:\/\//);
});

test('a source keeps one title, date and kind wherever the catalog cites it', () => {
  const seen = new Map();
  for (const p of loadCatalog().patterns) {
    for (const s of p.sources) {
      const key = JSON.stringify([s.title, s.date, s.kind]);
      if (seen.has(s.url)) assert.equal(key, seen.get(s.url), `${s.url} (${p.id})`);
      seen.set(s.url, key);
    }
  }
  // The tool refuses a catalog where one address carries two titles, rather than picking one.
  const clash = { patterns: [
    { headline: 'One', sources: [{ title: 'A', url: 'https://example.com/a', date: '2025-01', kind: 'docs' }] },
    { headline: 'Two', sources: [{ title: 'B', url: 'https://example.com/a', date: '2025-01', kind: 'docs' }] },
  ] };
  assert.throws(() => collectSources(clash), /two titles/);
});

test('the same catalog in another order writes the same page', () => {
  const catalog = loadCatalog();
  const page = renderSourcesIndex(catalog);
  assert.equal(renderSourcesIndex(catalog), page, 'twice, the same');
  const turned = structuredClone(catalog);
  turned.patterns.reverse();
  for (const p of turned.patterns) p.sources.reverse();
  turned.checkedOn = [...turned.checkedOn].reverse();
  assert.equal(renderSourcesIndex(turned), page, 'patterns, sources and dates in reverse');
});

test('titles are escaped, unknown kinds go under Other, and an empty group is left out', () => {
  const catalog = { checkedOn: ['2025-01-02'], patterns: [
    { headline: 'A problem with *stars*', sources: [
      { title: 'A [bracketed] `code` title', url: 'https://example.com/a (b)', date: '2025-01', kind: 'docs' },
      { title: 'A talk', url: 'https://example.com/talk', date: '2024-06', kind: 'video' },
    ] },
  ] };
  const page = renderSourcesIndex(catalog);
  assert.match(page, /^- \[A \\\[bracketed\\\] \\`code\\` title\]\(https:\/\/example\.com\/a%20%28b%29\) \(2025-01\)$/m);
  assert.match(page, /^## Other \(1\)\n\n- \[A talk\]\(https:\/\/example\.com\/talk\) \(2024-06\)$/m);
  assert.match(page, /Cited by: A problem with \\\*stars\\\*\./);
  assert.doesNotMatch(page, /## Bug reports|## Research papers/);
  assert.match(page, /1 known problems/);
  assert.match(page, /The catalog was checked on 2025-01-02\./);
});

test("the page's own words open in plain terms and clear the voice bar", () => {
  const page = readIndex();
  const own = page.split('\n').filter((l) => !/^- \[|^ {2}Cited by: /.test(l)).join('\n');
  assert.match(own, /^# .+\n\n## In plain terms\n\n[^\n]+\n/);
  const plain = own.split('## In plain terms\n\n')[1].split('\n')[0];
  const sentences = plain.split(/(?<=\.)\s+/).filter(Boolean).length;
  assert.ok(sentences >= 2 && sentences <= 3, `two or three sentences (${sentences})`);
  assert.doesNotMatch(own, /[–—]| -- /, 'no em or en dash in the page\'s own words');
  assert.ok(own.indexOf('## Implementation detail') > own.indexOf('## Vendor docs'), 'file names sit at the bottom');
});
