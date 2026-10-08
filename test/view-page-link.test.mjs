// pageLink (issue 198): which page, query and step a one-time address from view may open.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { goalPage, LINK_PAGES, PAGE_IDS, pageLink, replayPage } from '../lib/view/page-link.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('a session, a step and a goal get the link the page builds for them, which view --page takes as it is', () => {
  const session = 'cc-hccfcndehggh';
  const thread = 'th-dojflncnnk';
  assert.equal(replayPage({ session }), `replay.html?session=${session}`);
  assert.equal(replayPage({ session, thread }), `replay.html?session=${session}#${thread}`);
  assert.equal(replayPage({ session, thread, event: `${session}.54.0` }), `replay.html?session=${session}#${thread}~${session}.54.0`);
  assert.equal(replayPage({ session, event: 'git-mfccaldmecgg.pr.12' }), `replay.html?session=${session}#~git-mfccaldmecgg.pr.12`, 'a step with no thread, as Problems links one');
  assert.equal(goalPage('giidnmknfnknioim'), 'goal.html#giidnmknfnknioim');
  for (const page of [replayPage({ session, thread, event: `${session}.54.0` }), goalPage('giidnmknfnknioim')]) assert.deepEqual(pageLink(page), { page });
  // Anything that isn't one of the page's ids gets no link, and a bad thread or step is left off.
  assert.equal(replayPage({ session: '../x' }), null);
  assert.equal(replayPage({ session: 'Some Title' }), null);
  assert.equal(replayPage({}), null);
  assert.equal(replayPage({ session, thread: 'th-x&c=1', event: 'a b' }), `replay.html?session=${session}`);
  assert.equal(goalPage('goal one'), null);
});

test('the ids a link may hold are the ones the page itself reads', () => {
  const common = readFileSync(join(ROOT, 'lib', 'view', 'assets', 'common.js'), 'utf8');
  // Its patterns hold braces of their own ({4,64}), so the block ends at the line that closes it.
  const block = /const ID = \{\n([\s\S]*?)\n\s*\};/.exec(common)?.[1];
  assert.ok(block, 'common.js names its ids');
  const page = Object.fromEntries([...block.matchAll(/(\w+): \/(.+)\/,/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.fromEntries(Object.entries(PAGE_IDS).map(([k, re]) => [k, re.source])), page);
});

test('a page, its query and a step come back as the part after the address', () => {
  assert.deepEqual(pageLink(''), { page: '' }, 'nothing means the Problems page');
  assert.deepEqual(pageLink('replay.html'), { page: 'replay.html' });
  assert.deepEqual(pageLink('/replay.html?session=abc12345'), { page: 'replay.html?session=abc12345' });
  assert.deepEqual(pageLink('replay.html?session=abc12345#t1~e2'), { page: 'replay.html?session=abc12345#t1~e2' });
  assert.deepEqual(pageLink('replay.html#t1~zoom~pf-abcdefghijkl~e2'), { page: 'replay.html#t1~zoom~pf-abcdefghijkl~e2' });
  assert.deepEqual(pageLink('goal.html?q=a b&x'), { page: 'goal.html?q=a+b&x=' }, 'the query is written back encoded');
  for (const p of LINK_PAGES) assert.equal(pageLink(p).page, p);
});

test('anything but view\'s own pages, an odd key or a # part that is not ids is refused', () => {
  for (const bad of ['../package.json', '..\\package.json', 'C:/x/problems.html', 'assets/app.js', 'setup.html', 'selftest/clickthrough.html', 'https://example.com/', 'replay.html/../x']) {
    assert.ok(pageLink(bad).error, bad);
  }
  assert.ok(pageLink('replay.html?x-y=1').error, 'a key view\'s pages do not read');
  assert.ok(pageLink('replay.html#a&c=1234567890').error, 'an &c= in the step part would pose as the code');
  assert.ok(pageLink('replay.html#<script>').error);
});

test('Search takes only its own address: a search id this run gave out, and no query', () => {
  assert.deepEqual(pageLink('search.html'), { page: 'search.html' });
  assert.deepEqual(pageLink('search.html#q=qabcdefghijklmnop~w'), { page: 'search.html#q=qabcdefghijklmnop~w' });
  assert.deepEqual(pageLink('search.html#q=qabcdefghijklmnop~l'), { page: 'search.html#q=qabcdefghijklmnop~l' });
  assert.deepEqual(pageLink('search.html#q=qabcdefghijklmnop'), { page: 'search.html#q=qabcdefghijklmnop' });
  for (const bad of ['search.html?q=my words', 'search.html#t1~e2', 'search.html#q=qabcdefghijklmnop~w&c=1234', 'search.html#q=qzzzzzzzzzzzzzzzz~w', 'search.html#q=qabc~w', 'search.html#q=qabcdefghijklmnop~x']) {
    assert.match(pageLink(bad).error ?? '', /^Search/, bad);
  }
  // The # rule that lets Search's = through applies to Search alone.
  assert.ok(pageLink('replay.html#q=qabcdefghijklmnop~w').error);
});
