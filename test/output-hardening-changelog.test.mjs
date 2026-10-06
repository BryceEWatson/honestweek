// Replacing a same-week changelog block keeps an item's `$&`, `$'` and `` $` `` as written:
// they're text, not replacement patterns, so nothing around the block is copied into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { emit } from '../lib/emit/index.mjs';
import { mergeIntoChangelog } from '../lib/emit/changelog.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const WEEK = { start: '2024-06-10', end: '2024-06-16' };
const DOLLARS = "Priced at $& then $' and $` too";
const HEAD = '# Changelog\n\nHEAD-MARKER notes before.\n\n';
const TAIL = '\nTAIL-MARKER notes after.\n';
const count = (s, sub) => s.split(sub).length - 1;

test('mergeIntoChangelog puts the block in literally, dollar sequences included', () => {
  const old = `${HEAD}<!-- honestweek:week:2024-06-10/2024-06-16 -->\nold\n<!-- /honestweek:week:2024-06-10/2024-06-16 -->${TAIL}`;
  const block = `<!-- honestweek:week:2024-06-10/2024-06-16 -->\n- ${DOLLARS}\n<!-- /honestweek:week:2024-06-10/2024-06-16 -->`;
  assert.equal(mergeIntoChangelog(old, block, WEEK), `${HEAD}${block}${TAIL}`);
});

test('a re-emitted week with dollar sequences in an item leaves the rest of the changelog alone', () => {
  const dir = makeTempDir('hw-changelog-dollar-');
  try {
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, `${HEAD}${TAIL}`);
    const model = { week: WEEK, items: [{ status: 'shipped', text: DOLLARS, repo: 'api', receipt: { shortSha: 'a1b2c3d' } }] };
    const cfg = { output: { mode: 'changelog', file } };
    emit(model, cfg); // appends the block
    emit(model, cfg); // replaces it in place: the path that expanded `$&` and friends
    const after = readFileSync(file, 'utf8');
    // `$` itself is never escaped; the character after it may be, if the emitter escapes Markdown.
    for (const re of [/\$\\?(?:&|&amp;)/, /\$\\?'/, /\$\\?`/]) assert.match(after, re, `${re} kept literally`);
    assert.match(after, /Priced at \$\\?(?:&|&amp;) then \$\\?' and \$\\?` too/, 'the item reads as written');
    assert.equal(count(after, 'HEAD-MARKER'), 1, 'text before the block is not copied');
    assert.equal(count(after, 'TAIL-MARKER'), 1, 'text after the block is not copied');
    assert.equal(count(after, '<!-- honestweek:week:2024-06-10/2024-06-16 -->'), 1, 'one opening marker');
    assert.equal(count(after, '<!-- /honestweek:week:2024-06-10/2024-06-16 -->'), 1, 'one closing marker');
    assert.ok(after.startsWith(HEAD), 'the head is untouched');
  } finally {
    removeTempDir(dir);
  }
});
