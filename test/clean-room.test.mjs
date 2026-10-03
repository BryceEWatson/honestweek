// The repo-wide privacy fence, and proof that the hashed matcher works.
//
// No tracked file may name one of the owner's private projects, and the owner's own name
// and GitHub handle may appear only where the project is attributed to them (the author
// fields, the license's copyright line) or as part of the repository's own address. The
// forbidden names are kept as hashes in test/helpers/clean-room.mjs, so this file names
// none of them; the self-tests below plant a made-up word instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './helpers/temp-dir.mjs';
import {
  MAX_LEN,
  MIN_LEN,
  OWNER_IDENTITY,
  PRIVATE_NAME,
  SITE_FIELD,
  canonical,
  candidatesOf,
  findForbidden,
  findForbiddenPaths,
  hashName,
  ownerIdentity,
  privateForbidden,
  readOwner,
  scanText,
  sha256,
  stripOwnAddress,
} from './helpers/clean-room.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = readOwner(ROOT);

// The lines where the owner's name is the attribution itself.
const AUTHORSHIP_LINES = new Map([
  ['package.json', /^\s*"author"\s*:/],
  ['LICENSE', /^Copyright \(c\)/],
  ['.claude-plugin/plugin.json', /^\s*"author"\s*:/],
  ['.claude-plugin/marketplace.json', /^\s*"name"\s*:/],
]);

const MADE_UP = 'quixelmora';
const MADE_UP_FENCE = new Map([[sha256(MADE_UP), 'a made-up word']]);

test('the matcher catches a planted word in every spelling and never prints it', () => {
  const dir = makeTempDir('hw-clean-room-');
  const file = join(dir, 'fixture.txt');
  const caught = [
    'Quixelmora shipped on Tuesday.',
    'const useQuixelmoraPanel = true;',
    'see my-quixelmora-tool for details',
    'docs live at https://quixelmora.example/start',
    'QUIXELMORA_API_KEY=placeholder',
    "two Quixelmoras and the Quixelmora's roadmap",
    'myquixelmoraapp and quixelmora2 are glued on',
    'Quixel-Mora, quixel_mora and quixel.mora',
    'the Quixel Mora team, and two Quixel Moras',
    'https://example.com/?q=Quixel%20Mora and %2Fquixelmora',
    String.raw`"line one\nquixelmora"`,
    'the Quixel\u00a0Mora team, Quixel\u2013Mora and quix\u00adel\u200bmora',
    'search?q=Quixel+Mora, Quixel/Mora, **Quixel** Mora and `Quixel` `Mora`',
    'Quixel&nbsp;Mora, Quixel&#160;Mora, Quixel&#xA0;Mora and Quixel&ndash;Mora in pasted HTML',
  ];
  writeFileSync(file, ['nothing to see here', ...caught, 'quixelmor is one letter short and passes', 'a quixel and a mora pass too'].join('\n'));
  const text = readFileSync(file, 'utf8');
  const lines = caught.map((_, i) => i + 2);
  assert.deepEqual(findForbidden(text, MADE_UP_FENCE).map((f) => f.line), lines);

  const report = scanText(text, 'fixture.txt', MADE_UP_FENCE, '');
  assert.deepEqual(report, lines.map((n) => `fixture.txt:${n} (a made-up word)`));
  assert.doesNotMatch(report.join('\n'), /quixel/i, 'a finding names the file and line, not the word');
});

test('a multi-word name split by a line break is caught, on the line where it starts', () => {
  const text = [
    'nothing here',
    'a hard-wrapped paragraph about the Quixel',
    'Mora roadmap and more',
    '// a comment that names Quixel',
    '//   Moras at the start of the next line',
    'a list that ends with quixel',
    '- mora as the next bullet',
    'Quixel Mora wholly on one line',
    'the next line starts Mora, unrelated',
    'a comma after quixel,',
    'mora after a comma stays apart',
  ].join('\r\n');
  assert.deepEqual(findForbidden(text, MADE_UP_FENCE).map((f) => f.line), [2, 4, 6, 8]);
  const site = new Map([[sha256('work-item'), SITE_FIELD]]);
  assert.deepEqual(findForbidden('the work\nitem in prose', site), [], 'a target-site field still never matches across a gap');
});

test('a file path that names a forbidden word is found by its position', () => {
  const paths = ['lib/tool.mjs', 'docs/quixel-mora-notes.md', 'test/fixtures/Quixel Mora/a.json', 'lib/mora.mjs'];
  assert.deepEqual(findForbiddenPaths(paths, MADE_UP_FENCE, ''), [
    { index: 1, kind: 'a made-up word' },
    { index: 2, kind: 'a made-up word' },
  ]);
});

test('a target-site field matches inside a word but not as separate words of prose', () => {
  const site = new Map([[sha256('work-item'), SITE_FIELD]]);
  assert.deepEqual(findForbidden('see build-work-item-list\nthe workItems field\na work item in prose', site).map((f) => f.line), [1, 2]);
  const named = new Map([[sha256('work-item'), PRIVATE_NAME]]);
  assert.deepEqual(findForbidden('a work item in prose', named).map((f) => f.line), [1], 'a private name matches as separate words');
});

test('candidates cover every stretch inside a word, and a new word must be long enough to find glued', () => {
  assert.equal(canonical('Quixel-Mora_2'), 'quixelmora2');
  assert.equal(sha256('Quixel-Mora'), sha256('quixelmora'));
  const c = candidatesOf('nextUpItems');
  assert.ok(c.includes('nextupitems') && c.includes('upit') && c.includes('items'));
  assert.ok(!c.includes('ite'), `stretches shorter than ${MIN_LEN} are not hashed`);
  assert.ok(candidatesOf('x'.repeat(MAX_LEN + 5)).every((s) => s.length <= MAX_LEN || s.length === MAX_LEN + 5));
  assert.equal(hashName('Quixel Mora'), sha256('quixelmora'));
  assert.throws(() => hashName('abc'), RangeError);
  assert.throws(() => hashName('x'.repeat(MAX_LEN + 1)), RangeError);
});

test('the owner identity comes from the author field and the repository URL', () => {
  const id = ownerIdentity({ author: 'Ada Example <ada@example.com> (https://example.com)', repository: { url: 'git+https://github.com/ada-ex/thing.git' } });
  assert.deepEqual([...id.tokens].sort(), ['ada', 'ada-ex', 'adaexample', 'example']);
  assert.equal(id.handle, 'ada-ex');
  assert.equal(ownerIdentity({ author: { name: 'Solo' }, repository: 'github:solo-dev/thing' }).handle, 'solo-dev');
  assert.equal(ownerIdentity({}).tokens.size, 0);
});

test("the repository's own address is allowed, the handle anywhere else is not", () => {
  const id = ownerIdentity({ author: 'Ada Example', repository: { url: 'git+https://github.com/ada-ex/honestweek.git' } });
  const fence = new Map([...id.tokens].map((t) => [sha256(t), OWNER_IDENTITY]));
  const ok = 'git clone https://github.com/ada-ex/honestweek.git\nnpx github:ada-ex/honestweek\n/plugin marketplace add ada-ex/honestweek\nassert.match(x, /ada-ex\\/honestweek/)';
  assert.deepEqual(findForbidden(stripOwnAddress(ok, id.handle), fence), []);
  const bad = 'Thanks, Ada.\nsee ada-ex/other-repo\nC:\\Users\\ada\\notes';
  assert.deepEqual(findForbidden(stripOwnAddress(bad, id.handle), fence).map((f) => f.line), [1, 2, 3]);
});

test('no tracked file names a private project, and the owner appears only as the author', (t) => {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  } catch {
    t.skip('not a git checkout');
    return;
  }
  assert.ok(files.length > 100, 'expected the tracked files to be listed');
  const fence = privateForbidden(OWNER);
  const found = [];
  // The paths themselves are checked too, one per line. A path that names something
  // forbidden is reported by its position in `git ls-files`, never spelled out, and so are
  // the findings inside that file.
  const badPath = new Set();
  for (const { index, kind } of findForbiddenPaths(files, fence, OWNER.handle)) {
    badPath.add(index);
    found.push(`tracked file #${index + 1} in git ls-files: its path (${kind})`);
  }
  for (const [i, f] of files.entries()) {
    const shown = badPath.has(i) ? `tracked file #${i + 1}` : f;
    let text;
    try {
      text = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue; // deleted in this working tree and not yet committed
    }
    const lines = text.split(/\r?\n/);
    const allowed = AUTHORSHIP_LINES.get(f);
    for (const { line, kind } of findForbidden(stripOwnAddress(text, OWNER.handle), fence)) {
      if (kind === OWNER_IDENTITY && allowed && allowed.test(lines[line - 1])) continue;
      found.push(`${shown}:${line} (${kind})`);
    }
  }
  assert.deepEqual(found, []);
});
