// view's pages build HTML from engine data. A few values (test and patch counts, a
// join's evidence word and rule, a reason's evidence word) are engine-made numbers or
// words today, but they reach innerHTML, so each goes through the page's esc() anyway.
// This reads the asset sources and checks those interpolations are wrapped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'view', 'assets');
const src = (name) => readFileSync(join(ASSETS, name), 'utf8');

test('common.js escapes the test and patch counts in a step tooltip', () => {
  const all = src('common.js');
  const start = all.indexOf('function tipHtml(');
  assert.ok(start > 0, 'tipHtml is present');
  const t = all.slice(start, all.indexOf('\n  }\n', start));
  for (const field of ['e.tests.pass', 'e.tests.fail', 'e.patch.added', 'e.patch.removed']) {
    const re = new RegExp(`\\$\\{\\s*${field.replace(/\./g, '\\.')}\\b`);
    assert.doesNotMatch(t, re, `${field} is never interpolated raw`);
    assert.match(t, new RegExp(`\\$\\{esc\\(${field.replace(/\./g, '\\.')} \\?\\? 0\\)\\}`), `${field} goes through esc()`);
  }
});

test("goal.js escapes a join's evidence and rule in the flag's title", () => {
  const t = src('goal.js');
  const title = t.match(/<title>\$\{esc\(joinText\(j\)\)\}[^\n]*?Enter or click for the record\.<\/title>/);
  assert.ok(title, 'the join flag title is present');
  assert.match(title[0], /\$\{esc\(j\.evidence\)\}/);
  assert.match(title[0], /\$\{esc\(j\.rule\)\}/);
  assert.doesNotMatch(title[0], /\$\{j\.(evidence|rule)\}/, 'no raw evidence or rule');
});

test("search.js escapes the first reason's evidence word", () => {
  const t = src('search.js');
  assert.match(t, /\$\{esc\(cap\(refs\[0\]\.evidence \?\? best \?\? 'recorded'\)\)\}/);
  assert.doesNotMatch(t, /\$\{cap\(refs\[0\]\.evidence/, 'never interpolated raw');
});

test('a step tooltip with markup in its test and patch counts shows it as text', () => {
  const sandbox = { window: { HWE: { chips: () => '', chip: () => '' }, HWP: {} }, document: { getElementById: () => null } };
  runInNewContext(src('common.js'), sandbox);
  const HW = sandbox.window.HW;
  const bad = '<img src=x onerror=alert(1)>';
  const html = HW.tipHtml({ id: 'cc-abcdefghijkl.1.0', kind: 'tool', actor: 'agent', t: Date.UTC(2026, 0, 5), text: 'ran the tests', ev: 'recorded', inferred: [], missing: [], tests: { pass: bad, fail: bad }, patch: { added: bad, removed: bad } });
  assert.ok(!html.includes('<img'), 'no live markup');
  assert.equal(html.split('&lt;img src=x onerror=alert(1)&gt;').length - 1, 4, 'all four counts come out escaped');
  const plain = HW.tipHtml({ id: 'cc-abcdefghijkl.1.0', kind: 'tool', actor: 'agent', t: Date.UTC(2026, 0, 5), text: 'x', ev: 'recorded', inferred: [], missing: [], tests: { pass: 3, fail: 0 }, patch: { added: 12, removed: 4 } });
  assert.match(plain, /tests 3 passed, 0 failed/);
  assert.ok(plain.includes('+12 −4 lines'), 'plain numbers read the same as before');
});
