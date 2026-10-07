// Guards the public docs a newcomer reads before the release: the README, the skill, the
// changelog, the community files and everything under docs/. Their relative links and
// #anchors resolve, their prose keeps the published voice (no em or en dashes), and the
// counts they state about the problem catalog match the catalog and the checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from '../lib/problems/checks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const CATALOG = JSON.parse(read('lib/problems/catalog.json'));
const PKG = JSON.parse(read('package.json'));

const DOCS = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
const FLOWS = readdirSync(join(ROOT, 'flows')).filter((f) => f.endsWith('.md')).map((f) => `flows/${f}`);
const PUBLIC = ['README.md', 'SKILL.md', ...FLOWS, 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', ...DOCS];
const DASH = /[\u2014\u2013]| -- /;

/** The lines of a Markdown file outside fenced code blocks, with their line numbers. */
function proseLines(text) {
  const out = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) out.push([i + 1, line]);
  });
  return out;
}

/** GitHub's anchor for a heading: lowercased, punctuation but hyphens and underscores dropped, spaces to hyphens. */
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*~]/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    for (const [, line] of proseLines(readFileSync(file, 'utf8'))) {
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) {
        const base = slug(h[1]);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        set.add(n ? `${base}-${n}` : base);
      }
      for (const a of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(a[1]);
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

test('every relative link and #anchor in the public docs resolves', () => {
  const broken = [];
  for (const f of PUBLIC) {
    const from = resolve(ROOT, f);
    for (const [, line] of proseLines(read(f))) {
      for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1];
        if (/^(?:[a-z]+:|<)/i.test(target)) continue;
        const [path, frag] = target.split('#');
        const to = path ? resolve(dirname(from), decodeURIComponent(path)) : from;
        if (!existsSync(to)) broken.push(`${f} links to ${target}, which doesn't exist`);
        else if (frag && to.endsWith('.md') && statSync(to).isFile() && !anchorsOf(to).has(frag.toLowerCase())) {
          broken.push(`${f} links to ${target}, but ${rel(to)} has no heading with that anchor`);
        }
      }
    }
  }
  assert.deepEqual(broken, []);
});

// The README shows screenshots with <picture> (a light and a dark version) and <img>, which the
// Markdown link check above doesn't see. Each image resolves, says what it shows, and stays small.
test('every image in the public docs resolves, has alt text, and stays under 300 KB', () => {
  const problems = [];
  const used = new Set();
  for (const f of PUBLIC) {
    const from = resolve(ROOT, f);
    for (const [n, line] of proseLines(read(f))) {
      const targets = [...line.matchAll(/<(?:img|source)\b[^>]*?\b(?:src|srcset)="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0]));
      for (const t of [...targets, ...[...line.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1])]) {
        if (/^[a-z]+:/i.test(t)) continue;
        const to = resolve(dirname(from), decodeURIComponent(t));
        used.add(to);
        if (!existsSync(to)) problems.push(`${f}:${n} shows ${t}, which doesn't exist`);
        else if (statSync(to).size > 300 * 1024) problems.push(`${f}:${n} shows ${t}, over 300 KB`);
      }
      for (const img of line.matchAll(/<img\b[^>]*>/g)) if (!/\balt="[^"]{20,}"/.test(img[0])) problems.push(`${f}:${n} has an image without alt text that says what it shows`);
    }
  }
  const images = join(ROOT, 'docs', 'images');
  if (existsSync(images)) for (const name of readdirSync(images)) if (!used.has(join(images, name))) problems.push(`docs/images/${name} isn't shown anywhere`);
  assert.ok(used.size > 0, 'the README shows its screenshots');
  assert.deepEqual(problems, []);
});

test('the public docs keep the voice bar: no em or en dash in prose', () => {
  const found = [];
  for (const f of PUBLIC) {
    for (const [n, line] of proseLines(read(f))) {
      if (!DASH.test(line)) continue;
      // docs/sources.md lists third-party sources by their own titles, quoted as written.
      // A dash may sit inside a title (a link's text), never in the page's own words.
      if (f === 'docs/sources.md' && !DASH.test(line.replace(/\[(?:\\.|[^\]\\])*\]\(https?:[^)]+\)/g, ''))) continue;
      found.push(`${f}:${n}`);
    }
  }
  assert.deepEqual(found, [], 'a dash in public prose; README code blocks that reproduce program output are exempt');
});

test('the --help text of every command keeps the voice bar', () => {
  const commands = ['', 'init', 'discover', 'prompts', 'digest', 'validate', 'build', 'harvest', 'preview', 'mine', 'history', 'view', 'status', 'find', 'replay', 'problems', 'goals'];
  for (const c of commands) {
    const r = spawnSync(process.execPath, [join(ROOT, PKG.bin.honestweek), ...(c ? [c] : []), '--help'], { encoding: 'utf8' });
    const text = `${r.stdout}${r.stderr}`;
    assert.ok(text.length > 0, `honestweek ${c} --help prints something`);
    assert.doesNotMatch(text, DASH, `honestweek ${c || ''} --help uses a dash`.replace('  ', ' '));
  }
});

test("every file the README's Sidecars table calls gitignored is ignored by the checked-in .gitignore", () => {
  const README = read('README.md');
  const table = README.slice(README.indexOf('## Sidecars'), README.indexOf('\n## ', README.indexOf('## Sidecars') + 1));
  const named = [...table.matchAll(/^\| `([^`]+)`[^|]*\|(.*)\|\s*$/gm)].filter(([, , status]) => /\*\*Gitignored[.*:]/.test(status)).map(([, file]) => file);
  assert.ok(named.length >= 8, `the table's gitignored rows were found (${named.length})`);
  // Only the repository's own .gitignore counts, not a global excludes file on this machine.
  const r = spawnSync('git', ['-c', 'core.excludesFile=', 'check-ignore', '--no-index', ...named], { cwd: ROOT, encoding: 'utf8' });
  const ignored = new Set(r.stdout.split(/\r?\n/).filter(Boolean));
  assert.deepEqual(named.filter((f) => !ignored.has(f)), [], 'a sidecar the README calls gitignored is missing from .gitignore');
});

const WORDS = { twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27 };
const num = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

test('the catalog counts the docs state match the catalog and the checks', () => {
  const total = CATALOG.patterns.length;
  const checked = CATALOG.patterns.filter((p) => p.coverage.claudeCode.status !== 'not yet' || p.coverage.codex.status !== 'not yet');
  const onBoth = checked.filter((p) => p.coverage.claudeCode.status === 'runs' && p.coverage.codex.status === 'runs').length;
  const changelog = read('CHANGELOG.md');
  const current = changelog.slice(changelog.indexOf(`## ${PKG.version} `), changelog.indexOf('\n## ', changelog.indexOf(`## ${PKG.version} `) + 1));
  const sources = [...['README.md', 'SKILL.md', ...FLOWS, ...DOCS].map((f) => [f, read(f)]), ['CHANGELOG.md', current]];
  const wrong = [];
  let seen = 0;
  const expect = (f, what, stated, actual) => {
    seen++;
    if (stated !== actual) wrong.push(`${f} says ${stated} ${what}; the code has ${actual}`);
  };
  for (const [f, text] of sources) {
    for (const m of text.matchAll(/\b(\d+) known ways\b/g)) expect(f, 'known ways (catalog patterns)', Number(m[1]), total);
    for (const m of text.matchAll(/\b(?:catalog's|list of|all|the) (\d+) patterns\b/g)) expect(f, 'catalog patterns', Number(m[1]), total);
    for (const m of text.matchAll(/\b(\d+) of the (\d+) checked (?:problems|patterns) run\b/g)) {
      expect(f, 'checked patterns', Number(m[2]), checked.length);
      expect(f, 'checked patterns that run on both agents', Number(m[1]), onBoth);
    }
    for (const m of text.matchAll(/\b(\d+) of the (\d+) patterns have no check\b/g)) {
      expect(f, 'catalog patterns', Number(m[2]), total);
      expect(f, 'patterns with no check', Number(m[1]), total - checked.length);
    }
    for (const m of text.matchAll(/\b([A-Za-z-]+|\d+) checks cover (\d+) of the (\d+) patterns\b/g)) {
      expect(f, 'checks', num(m[1]), CHECKS.length);
      expect(f, 'checked patterns', Number(m[2]), checked.length);
      expect(f, 'catalog patterns', Number(m[3]), total);
    }
  }
  assert.ok(seen >= 10, `the count claims were found (${seen}); a rewording may have hidden them from this test`);
  assert.deepEqual(wrong, []);
});
