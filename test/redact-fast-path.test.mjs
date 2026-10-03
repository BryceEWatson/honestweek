// The redactor's faster term matching (lib/redact.mjs step 10). It finds a term's matches
// with an exec loop instead of matchAll, and skips a term's patterns when the text doesn't
// hold every one of its words in some mix of cases. These tests check that the skip is safe
// (the facts it rests on), that the new step gives the same output and the same count as the
// old one over many generated texts, and that the demo week and the replay corpus build the
// same work history either way.
//
// The old step 10 is kept below, word for word. The tests copy lib/ into a scratch folder,
// put the old step back into the copy's redact.mjs, and run the copy beside the real one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRedactor } from '../lib/redact.mjs';
import { FOLDS_ONTO_ASCII, termMatchers, termWords } from '../lib/redaction-patterns.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { buildDemoWeek, WEEK } from '../tools/demo-week.mjs';
import { buildCorpus, CODENAME } from './fixtures/replay/corpus.mjs';

// ---- the old step 10, word for word -------------------------------------------------

const OLD_SETUP = String.raw`  const configuredTermMatchers = termMatchers(terms, Array.isArray(redaction.names) ? redaction.names : []);
`;

const OLD_STEP_10 = String.raw`    // 10. User term-lists (whole-token, case-insensitive).
    // Every term pattern's matches are gathered on the same text and overlapping ones merged,
    // so each private span is replaced once whichever pattern found it, as the audit does. A
    // web-address pattern may look past a placeholder to a part's ending; no match may
    // overlap one.
    if (configuredTermMatchers.length) {
      // heldBefore[i]: how many characters before i sit inside a placeholder.
      const heldBefore = new Uint32Array(s.length + 1);
      let inside = new Uint8Array(s.length);
      for (const m of s.matchAll(new RegExp(sentinelRe.source, 'g'))) inside.fill(1, m.index, m.index + m[0].length);
      for (let i = 0; i < s.length; i += 1) heldBefore[i + 1] = heldBefore[i] + inside[i];
      inside = null;
      const spans = [];
      for (const re of configuredTermMatchers) {
        re.lastIndex = 0;
        for (const m of s.matchAll(re)) {
          const from = m.index;
          const to = from + m[0].length;
          if (to > from && heldBefore[to] === heldBefore[from]) spans.push([from, to]);
        }
      }
      spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
      let out = '';
      let at = 0;
      for (let i = 0; i < spans.length; ) {
        let [from, to] = spans[i];
        for (i += 1; i < spans.length && spans[i][0] < to; i += 1) to = Math.max(to, spans[i][1]);
        out += s.slice(at, from) + redactTo('term')();
        at = to;
      }
      s = out + s.slice(at);
    }

`;

const once = (text, needle, what) => {
  const at = text.indexOf(needle);
  assert.ok(at >= 0 && text.indexOf(needle, at + 1) < 0, `redact.mjs should hold ${what} exactly once`);
  return at;
};

/** redact.mjs with the old step 10 (and the flat pattern list it reads) put back. */
function withOldStep10(source) {
  const src = source.replace(/\r\n/g, '\n');
  const fnAt = once(src, 'export function createRedactor(', 'createRedactor');
  const countAt = src.indexOf('  let count = 0;\n', fnAt);
  assert.ok(countAt > fnAt && countAt < once(src, 'export function createSecretsOnlyRedactor(', 'createSecretsOnlyRedactor'), 'createRedactor should set up its count');
  const from = once(src, '    // 10. User term-lists', 'the step 10 heading');
  const to = once(src, '    // 10b. ', 'the step 10b heading');
  assert.ok(countAt < from && from < to);
  return src.slice(0, countAt) + OLD_SETUP + src.slice(countAt, from) + OLD_STEP_10 + src.slice(to);
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const scratch = [];
let old = null;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-fast-path-'));
  scratch.push(dir);
  const lib = join(dir, 'lib');
  copyTree(LIB, lib);
  const redactFile = join(lib, 'redact.mjs');
  writeFileSync(redactFile, withOldStep10(readFileSync(redactFile, 'utf8')));
  old = {
    createRedactor: (await import(pathToFileURL(redactFile).href)).createRedactor,
    buildWorkHistory: (await import(pathToFileURL(join(lib, 'replay', 'index.mjs')).href)).buildWorkHistory,
  };
});
after(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold a lock on .git briefly */
    }
  }
});

// ---- the term lists the tests use ---------------------------------------------------

const CONFIGS = [
  // Plain English terms: one word, short, multi-word, a tab inside, a person's name.
  { codenames: ['Falcon', 'kestrel'], names: ['Jane Doe', 'Mark', 'Ion'], terms: ['acme', 'Project 7', 'Ada\tKing', 'mosswood'] },
  // Symbols, digits, a dot, doubled and edge spaces.
  { codenames: ['Iris', 'skyline'], names: ['Bill', 'Kim  Lee'], terms: ['acme.io', 'C#', 'K8s', 'q&a team', ' Lead  Space ', 'R2D2', 'x(y)', 'a+b', '[x]'] },
  // Terms with other characters, which always run their patterns.
  { codenames: ['Zo\u00eb', 'Stra\u00dfe'], names: ['J\u00fcrgen Wei\u00df', '\u0130lker'], terms: ['caf\u00e9', '\u03a3\u039f\u03a6\u0399\u0391', '\u01c5emal', '\u017Ftar', 'Kelvin\u212Aline', 'Jane\u00a0Doe'] },
  // Terms inside other terms, and short ones.
  { codenames: ['acme', 'Acme Cloud'], names: ['Ada King', 'Ada'], terms: ['kit', 'si', 'dot.net', 'foo-bar', 'foo_bar', 'Iris Iris'] },
  // A mix of both kinds.
  { codenames: ['kestrel', 'Zo\u00eb'], names: ['Jane Doe', '\u0130lker'], terms: ['mosswood', 'caf\u00e9 society', 'sis', 'Ada\tKing'] },
];
const allTerms = (c) => [...c.codenames, ...c.names, ...c.terms];
const isAscii = (t) => /^[\x00-\x7f]*$/.test(t);

// ---- a seeded text generator --------------------------------------------------------

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLACEHOLDERS = ['[redacted:term]', '[redacted:email]', '[redacted:path]', '[redacted:secret]', '[redacted:account]', '[redacted:other]'];
const WORD_SEPARATORS = [' ', '  ', '\t', '\n', '-', '_', '.', '', '\u00a0', ' - ', '/', '\r\n'];
const PREFIXES = ['', '', '', 'my', 'XML', 'I', '2', '_', 'x-', 'the', 'pre', 'Http', '[redacted:term]'];
const SUFFIXES = ['', '', '', 'Report', 's', '2', '_v2', 'hq', 'ing', '.pdf', '.3f9a2b1c.png', 'sake', '.com', 'Ops', '[redacted:term]'];
const SCHEMES = ['https://', 'http://user@', 'http://u:p@', 'www.', 'api.', 'me@', 'file:///', ''];
const ENDINGS = ['.com', '.io/path', ':3000/status', '.example.org/v1', '', '/x', '.dev', '.md', '.acmelogo.png'];
const NOISE = [
  'the', 'and', 'report', 'session', 'window.location.href', 'billing.ts', 'markdown.ts', 'academy', 'Falconry',
  'Janet Doe', 'kestrels', "skyline's", 'Project 70', 'acmes', 'you@example.com', 'jane.doe@acme.io', '/home/user/acme/notes.md',
  'C:\\Users\\Ada King\\acme', '~/acme/x', '6f1c0a52-9d2e-4b7a-8f31-2c4d5e6f7a8b', 'deadbeef1234', '123456789012', 'password=hunter2',
  'Bearer abcdefgh12345678', '\ue000', '\ue0001\ue000', '\ud83d\ude00', 'e\u0301', '\u039f\u0394\u039f\u03a3', '\u0131i', '\u212A',
  '\u017F', '\u0130', '\u00a0', '\t', '\n', '"', "'", '\\', '$5', '31.3%', 'x'.repeat(40),
];
const SOUP = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_./:@#&()[]';
const FOLDS = { k: '\u212A', K: '\u212A', s: '\u017F', S: '\u017F', i: '\u0130', I: '\u0130' };

function generator(seed, terms) {
  const r = seeded(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const recase = (t) => {
    const how = r();
    if (how < 0.2) return t.toLowerCase();
    if (how < 0.4) return t.toUpperCase();
    if (how < 0.5) return t;
    return [...t].map((c) => (r() < 0.5 ? c.toLowerCase() : c.toUpperCase())).join('');
  };
  const variant = (term) => {
    let words = termWords(term).map(recase);
    const how = r();
    if (how < 0.08) {
      // A character that lowercases or case-folds onto a plain letter in place of one.
      words = words.map((w) => [...w].map((c) => (FOLDS[c] && r() < 0.5 ? FOLDS[c] : c)).join(''));
    } else if (how < 0.14) {
      // Dotless i in place of i.
      words = words.map((w) => w.replace(/[iI]/g, () => (r() < 0.5 ? '\u0131' : 'i')));
    } else if (how < 0.22) {
      // A near miss: a dropped, doubled or added letter.
      const w = words.length - 1;
      const at = Math.floor(r() * words[w].length);
      const cut = pick(['drop', 'double', 'add']);
      words[w] = cut === 'drop' ? words[w].slice(0, at) + words[w].slice(at + 1) : cut === 'double' ? words[w].slice(0, at + 1) + words[w].slice(at) : words[w].slice(0, at) + pick([...SOUP]) + words[w].slice(at);
    }
    const joined = words.join(pick(WORD_SEPARATORS));
    const shape = r();
    if (shape < 0.25) return `${pick(SCHEMES)}${pick(PREFIXES)}${words.join(pick(['', '-', '_']))}${pick(SUFFIXES)}${pick(ENDINGS)}`;
    if (shape < 0.6) return `${pick(PREFIXES)}${joined}${pick(SUFFIXES)}`;
    return joined;
  };
  const soup = () => Array.from({ length: Math.floor(r() * 12) }, () => pick([...SOUP])).join('');
  return () => {
    const parts = [];
    const n = 1 + Math.floor(r() * 8);
    for (let i = 0; i < n; i += 1) {
      const kind = r();
      if (kind < 0.45) parts.push(variant(pick(terms)));
      else if (kind < 0.6) parts.push(pick(PLACEHOLDERS));
      else if (kind < 0.85) parts.push(pick(NOISE));
      else parts.push(soup());
      parts.push(pick(['', ' ', ' ', '  ', '\t', '\n', '-', '_', '.', '/', ':', '@', '"', "'", ',', '(', ')']));
    }
    return parts.join('');
  };
}

// ---- the facts the skip rests on ----------------------------------------------------

/** The character classes written in a pattern's source, as their insides. */
function classesOf(source) {
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] !== '[') continue;
    let j = i + 1;
    while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
    out.push(source.slice(i + 1, j));
    i = j;
  }
  return out;
}

// The classes the patterns hold whatever the term: letters and digits at a word's edges, a
// web-address part, a placeholder token, the separators between a term's words.
const FIXED_CLASSES = new Set(['^\\s/@', '\\p{L}\\p{N}_-', '\\p{L}\\p{N}', '\\p{L}\\p{N}_', '\\uE000-\\uF8FF', '-_.', '-_']);

const everyTerm = [...new Set(CONFIGS.flatMap(allTerms))];
const everyName = [...new Set(CONFIGS.flatMap((c) => c.names))];

test('every term pattern is built with the flags g and u and nothing else', () => {
  let n = 0;
  for (const names of [[], everyName]) {
    for (const re of termMatchers(everyTerm, names)) {
      assert.equal(re.flags, 'gu', re.source);
      n += 1;
    }
  }
  assert.ok(n > everyTerm.length * 2);
});

test('a plain English term spells each letter as a class of its two cases, and nothing else', () => {
  const ascii = everyTerm.filter(isAscii);
  assert.ok(ascii.length >= 20);
  for (const names of [[], everyName]) {
    for (const re of termMatchers(ascii, names)) {
      assert.ok(isAscii(re.source), `${re.source} should be written in plain characters`);
      for (const body of classesOf(re.source)) {
        if (FIXED_CLASSES.has(body)) continue;
        assert.match(body, /^[a-z][A-Z]$/, `a class built for a plain English term: [${body}]`);
        assert.equal(body[0].toUpperCase(), body[1], `[${body}] should hold one letter's two cases`);
      }
    }
  }
});

test("a term's word pattern is made of exactly the words termWords gives", () => {
  const spell = (w) => [...w].map((c) => (/[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
  assert.deepEqual(termWords(' Ada\tKing '), ['Ada', 'King']);
  assert.deepEqual(termWords('Kim  Lee'), ['Kim', 'Lee']);
  for (const t of everyTerm.filter(isAscii)) {
    const patterns = termMatchers([t]);
    const word = patterns.at(-1);
    assert.ok(word.source.includes(termWords(t).map(spell).join('(?:\\s+|[-_.]?)')), `${JSON.stringify(t)}: ${word.source}`);
  }
});

test('FOLDS_ONTO_ASCII holds exactly the characters that lowercase or case-fold onto a plain letter', () => {
  const folds = /^[a-z]$/iu;
  const found = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    if (folds.test(c) || /[A-Za-z]/.test(c.toLowerCase())) found.push(cp);
  }
  assert.ok(found.length >= 3, 'the scan should find the Kelvin sign, long s and dotted capital I');
  for (const cp of found) assert.ok(FOLDS_ONTO_ASCII.test(String.fromCodePoint(cp)), `U+${cp.toString(16)} should be in FOLDS_ONTO_ASCII`);
  const listed = FOLDS_ONTO_ASCII.source.match(/\\u[0-9A-Fa-f]{4}/g).map((u) => parseInt(u.slice(2), 16));
  assert.deepEqual(listed.sort((x, y) => x - y), found);
});

// ---- the old and new step 10, side by side ------------------------------------------

test('the old and new term matching give the same text and the same count over generated texts', () => {
  let compared = 0;
  CONFIGS.forEach((config, i) => {
    const oldR = old.createRedactor({ redaction: config });
    const newR = createRedactor({ redaction: config });
    const next = generator(0x5eed + i, allTerms(config));
    for (let n = 0; n < 2500; n += 1) {
      const text = next();
      const was = oldR.redact(text);
      const now = newR.redact(text);
      assert.equal(now, was, JSON.stringify(text));
      assert.equal(newR.count, oldR.count, JSON.stringify(text));
      // Once more on the output: placeholders already in place.
      assert.equal(newR.redact(now), oldR.redact(was), JSON.stringify(now));
      assert.equal(newR.count, oldR.count, JSON.stringify(now));
      compared += 2;
    }
    assert.ok(oldR.count > 1000, `config ${i} should hide plenty of terms (${oldR.count})`);
  });
  assert.equal(compared, CONFIGS.length * 5000);
});

test('the old and new term matching agree on hand-picked edge cases', () => {
  const config = { codenames: ['kestrel', 'mosswood'], names: ['Iris', 'Jane Doe'], terms: ['Ada\tKing', 'Zo\u00eb', '\u017Ftar'] };
  const cases = [
    'kestrel', '\u212Aestrel', 'KESTREL \u212A', 'mo\u017F\u017Fwood', 'MOSSWOOD', '\u0130ris', 'iris \u0130', 'IRIS',
    'ada king', 'ADA\tKING', 'AdaKing', 'ada-king', 'ada\u00a0king', 'Star', 'STAR', '\u017Ftar', 'zo\u00eb', 'ZO\u00cb',
    'www.kestrelhq.com', 'https://jane-doe.example.org', 'jane@janedoe.dev', '[redacted:term]kestrel[redacted:term]',
    'kestrel\ue000kestrel', '\ud83d\ude00kestrel\ud83d\ude00', 'x'.repeat(5000) + 'kestrel', '', ' ', 'nothing here',
  ];
  const oldR = old.createRedactor({ redaction: config });
  const newR = createRedactor({ redaction: config });
  for (const text of cases) {
    assert.equal(newR.redact(text), oldR.redact(text), JSON.stringify(text));
    assert.equal(newR.count, oldR.count, JSON.stringify(text));
  }
  // The skip still lets a term through when its words are there.
  assert.equal(newR.redact('Kestrel and ADA KING at www.mosswoodhq.com'), '[redacted:term] and [redacted:term] at www.[redacted:term].com');
});

// ---- the same work history, byte for byte -------------------------------------------

/** Where two strings first differ, with a little of each around it. */
function sameText(now, was, what) {
  if (now === was) return;
  let i = 0;
  while (i < now.length && now[i] === was[i]) i += 1;
  assert.fail(`${what} differs at ${i}: new ${JSON.stringify(now.slice(i - 40, i + 80))} old ${JSON.stringify(was.slice(i - 40, i + 80))}`);
}

/** Builds the history with the new and old libraries, and checks record() against a scan. */
async function sameHistory(options, what) {
  const now = await buildWorkHistory(options);
  const was = await old.buildWorkHistory(options);
  sameText(JSON.stringify(now), JSON.stringify(was), what);
  // record(id) finds the first event with that id, as a scan from the front did.
  for (const e of now.events) {
    const first = now.events.find((x) => x.id === e.id);
    assert.deepEqual(now.record(e.id), first.refs.map((ref) => now.record(ref)[0]), `${what}: record(${e.id})`);
  }
  assert.deepEqual(now.record('no-such-event'), []);
  return now;
}

const withTerms = (config, redaction) => ({ ...config, redaction: { ...config.redaction, ...redaction } });

test('the demo week builds the same work history with the old and new term matching', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'hw-fast-path-demo-')), 'week');
  scratch.push(join(root, '..'));
  const d = buildDemoWeek({ root });
  const options = { config: d.config, from: WEEK.from, to: WEEK.to, roots: d.roots };
  await sameHistory(options, 'demo week');
  const config = withTerms(d.config, { codenames: ['lantern'], names: ['Jane Doe', 'Mark'], terms: ['release notes', 'changelog', 'scope', 'Wrap', 'Zo\u00eb', 'node18'] });
  const h = await sameHistory({ ...options, config, scope: 'all', goals: d.goalRecord }, 'demo week with terms');
  assert.ok(JSON.stringify(h).split('[redacted:term]').length > 50, 'the terms should be hidden many times');
});

test('the replay corpus builds the same work history with the old and new term matching', async () => {
  const fx = buildCorpus({ root: mkdtempSync(join(tmpdir(), 'hw-fast-path-corpus-')), goals: true });
  scratch.push(fx.root);
  const options = { config: fx.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] } };
  const plain = await sameHistory({ ...options, goals: fx.goalRecord }, 'replay corpus');
  assert.ok(JSON.stringify(plain).includes('[redacted:term]'), `${CODENAME} should be hidden`);
  const config = withTerms(fx.config, { names: ['Ada King'], terms: ['your-project', 'fixtures', `${CODENAME} Ops`, 'caf\u00e9'] });
  await sameHistory({ ...options, config, scope: 'all' }, 'replay corpus with terms');
});
