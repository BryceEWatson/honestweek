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
  OWNER_IDENTITY,
  candidatesOf,
  findForbidden,
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
  writeFileSync(
    file,
    [
      'nothing to see here',
      'Quixelmora shipped on Tuesday.',
      'const useQuixelmoraPanel = true;',
      'see my-quixelmora-tool for details',
      'docs live at https://quixelmora.example/start',
      'QUIXELMORA_API_KEY=placeholder',
      'quixelmor is one letter short and passes',
    ].join('\n'),
  );
  const text = readFileSync(file, 'utf8');
  assert.deepEqual(findForbidden(text, MADE_UP_FENCE).map((f) => f.line), [2, 3, 4, 5, 6]);

  const report = scanText(text, 'fixture.txt', MADE_UP_FENCE, '');
  assert.deepEqual(report, [2, 3, 4, 5, 6].map((n) => `fixture.txt:${n} (a made-up word)`));
  assert.doesNotMatch(report.join('\n'), new RegExp(MADE_UP, 'i'), 'a finding names the file and line, not the word');
});

test('a file without the word passes, and joined spellings are found', () => {
  assert.deepEqual(findForbidden('plain prose with a quixel and a mora', MADE_UP_FENCE), []);
  const hyphenFence = new Map([[sha256('work-item'), 'a made-up compound']]);
  assert.deepEqual(findForbidden('see build-work-item-list\nwork item', hyphenFence).map((f) => f.line), [1]);
  assert.ok(candidatesOf('a.b-c').includes('b-c'));
  assert.ok(candidatesOf('nextUpItems').includes('nextup'));
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
  for (const f of files) {
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
      found.push(`${f}:${line} (${kind})`);
    }
  }
  assert.deepEqual(found, []);
});
