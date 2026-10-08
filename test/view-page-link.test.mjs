// pageLink (issue 198): which page, query and step a one-time address from view may open.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LINK_PAGES, pageLink } from '../lib/view/page-link.mjs';

test('a page, its query and a step come back as the part after the address', () => {
  assert.deepEqual(pageLink(''), { page: '' }, 'nothing means the Problems page');
  assert.deepEqual(pageLink('replay.html'), { page: 'replay.html' });
  assert.deepEqual(pageLink('/replay.html?session=abc12345'), { page: 'replay.html?session=abc12345' });
  assert.deepEqual(pageLink('replay.html?session=abc12345#t1~e2'), { page: 'replay.html?session=abc12345#t1~e2' });
  assert.deepEqual(pageLink('replay.html#t1~zoom~pf-abcdefghijkl~e2'), { page: 'replay.html#t1~zoom~pf-abcdefghijkl~e2' });
  assert.deepEqual(pageLink('search.html?q=a b&x'), { page: 'search.html?q=a+b&x=' }, 'the query is written back encoded');
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
