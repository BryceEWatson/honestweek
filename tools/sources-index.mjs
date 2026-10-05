#!/usr/bin/env node
// tools/sources-index.mjs: writes docs/sources.md, the index of every published source behind
// the problem catalog (lib/problems/catalog.json), each listed once.
//
//   node tools/sources-index.mjs            write docs/sources.md
//   node tools/sources-index.mjs --check    exit 1 when docs/sources.md is out of date
//   node tools/sources-index.mjs <file>     write the index to <file> instead
//
// A source is known by its address. The page groups sources by kind, sorts each group by title
// and lists the problems that cite each one by headline, so the same catalog always writes the
// same page, whatever order its patterns and sources are in. It reads one local file and writes
// one; it makes no network call.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CATALOG_FILE = fileURLToPath(new URL('../lib/problems/catalog.json', import.meta.url));
export const INDEX_FILE = fileURLToPath(new URL('../docs/sources.md', import.meta.url));

/** The page's groups, in order. A kind not named here goes under Other. */
export const KIND_GROUPS = Object.freeze([
  { kinds: ['docs'], heading: 'Vendor docs' },
  { kinds: ['user-report'], heading: 'Bug reports' },
  { kinds: ['paper'], heading: 'Research papers' },
  { kinds: null, heading: 'Other' },
]);

const USAGE = `sources-index: write docs/sources.md from lib/problems/catalog.json.

Usage:
  node tools/sources-index.mjs            write docs/sources.md
  node tools/sources-index.mjs --check    exit 1 when docs/sources.md is out of date
  node tools/sources-index.mjs <file>     write the index to <file> instead
`;

/** Plain code-unit order, so the sort is the same on every machine and Node version. */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every source in the catalog once, by address, with the headlines of the problems citing it.
 * A source must keep one title, date and kind wherever it's cited; a mismatch is an error, so
 * the index can't quietly pick one.
 */
export function collectSources(catalog) {
  const byUrl = new Map();
  for (const p of catalog?.patterns ?? []) {
    for (const s of p.sources ?? []) {
      const have = byUrl.get(s.url);
      if (!have) {
        byUrl.set(s.url, { title: s.title, url: s.url, date: s.date, kind: s.kind, problems: new Set([p.headline]) });
        continue;
      }
      for (const k of ['title', 'date', 'kind']) {
        if (have[k] !== s[k]) throw new Error(`sources-index: ${s.url} has two ${k}s in the catalog: "${have[k]}" and "${s[k]}"`);
      }
      have.problems.add(p.headline);
    }
  }
  const order = (a, b) => byText(a.title.toLowerCase(), b.title.toLowerCase()) || byText(a.title, b.title) || byText(a.url, b.url);
  return [...byUrl.values()]
    .map((s) => ({ ...s, problems: [...s.problems].sort((a, b) => byText(a.toLowerCase(), b.toLowerCase()) || byText(a, b)) }))
    .sort(order);
}

/** Text that Markdown would otherwise read as formatting or a link. */
export function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
}

/** A link target with the characters that would end it early encoded. */
function linkTarget(url) {
  return String(url).replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function groupOf(kind) {
  return KIND_GROUPS.find((g) => g.kinds?.includes(kind)) ?? KIND_GROUPS[KIND_GROUPS.length - 1];
}

/** The whole page, as the tool writes it. */
export function renderSourcesIndex(catalog) {
  const sources = collectSources(catalog);
  const problems = (catalog?.patterns ?? []).length;
  const checked = [...(catalog?.checkedOn ?? [])].sort(byText);
  const lines = [
    '# Sources behind the known problems',
    '',
    '## In plain terms',
    '',
    `This page lists every published source behind honestweek's ${problems} known problems, each one once: vendor docs, bug reports, research papers and a few others. Each entry gives the source's title, linked to where it's published, its date, and the problems that cite it, so you can check the evidence for any problem in one place. I generate it from the problem catalog, so it changes only when the catalog does.`,
    '',
    `${sources.length} sources.${checked.length ? ` The catalog was checked on ${checked.join(' and ')}.` : ''}`,
  ];
  for (const g of KIND_GROUPS) {
    const inGroup = sources.filter((s) => groupOf(s.kind) === g);
    if (!inGroup.length) continue;
    lines.push('', `## ${g.heading} (${inGroup.length})`, '');
    for (const s of inGroup) {
      lines.push(`- [${escapeMarkdown(s.title)}](${linkTarget(s.url)}) (${escapeMarkdown(s.date)})`);
      lines.push(`  Cited by: ${s.problems.map(escapeMarkdown).join('; ')}.`);
    }
  }
  lines.push(
    '',
    '## Implementation detail',
    '',
    '`node tools/sources-index.mjs` writes this file from `lib/problems/catalog.json`, and `test/sources-index.test.mjs` fails when the two disagree, so edit the catalog and run the tool rather than editing this file. A source is known by its address; the tool stops if one address carries two titles, dates or kinds.',
    '',
  );
  return lines.join('\n');
}

function readCatalog() {
  return JSON.parse(readFileSync(CATALOG_FILE, 'utf8'));
}

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [arg, ...rest] = argv;
  if (rest.length || arg === '-h' || arg === '--help') {
    (rest.length ? io.err : io.out)(USAGE);
    return rest.length ? 1 : 0;
  }
  const page = renderSourcesIndex(readCatalog());
  if (arg === '--check') {
    let now = null;
    try {
      now = readFileSync(INDEX_FILE, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // A missing file is out of date too.
    }
    if (now === page) {
      io.out('sources-index: docs/sources.md is up to date.\n');
      return 0;
    }
    io.err('sources-index: docs/sources.md is out of date. Run: node tools/sources-index.mjs\n');
    return 1;
  }
  const file = arg ? resolve(arg) : INDEX_FILE;
  writeFileSync(file, page);
  io.out(`sources-index: wrote ${file}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
