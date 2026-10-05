// The pages' preferences (lib/view/assets/prefs.js): "My priority" for a catalog pattern, the
// "Worth a look" strip's two switches and the light/dark theme, kept in local storage under one
// key. The store holds nothing else: no pattern id the server's catalog doesn't list, no tier or
// theme outside its words, no other field, and nothing from a log. prefs.js is a plain browser
// script; here it runs with a made-up storage. (The theme button: test/view-theme.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/view/assets/prefs.js';

const { createPrefs, effective, SLOT, TIERS, THEMES } = globalThis.HWPrefs;

function storage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()].sort(),
  };
}
const KNOWN = ['unverified-done-claim', 'action-loop', 'secret-exposure'];
const make = (seed) => {
  const s = storage(seed);
  const prefs = createPrefs({ localStorage: s, noEvents: true });
  prefs.setKnown(KNOWN);
  return { s, prefs };
};

test('one key, holding pattern ids from the catalog and one of four tiers, and two switches', () => {
  const { s, prefs } = make();
  assert.equal(SLOT, 'hw.prefs');
  assert.deepEqual(TIERS, ['high', 'medium', 'low', 'dismissed']);
  assert.deepEqual(s.keys(), [], 'nothing is written until something is set');
  prefs.setTier('action-loop', 'high', 'low');
  prefs.strip = true;
  assert.deepEqual(s.keys(), [SLOT]);
  assert.deepEqual(JSON.parse(s.getItem(SLOT)), { v: 1, priority: { 'action-loop': 'high' }, strip: true, low: false });
  assert.equal(prefs.tierOf('action-loop'), 'high');
  assert.equal(prefs.strip, true);
  assert.equal(prefs.low, false);
});

test("setting the rule's own tier clears the override, and an empty store removes the key", () => {
  const { s, prefs } = make();
  prefs.setTier('action-loop', 'dismissed', 'low');
  prefs.setTier('action-loop', 'low', 'low');
  assert.equal(prefs.tierOf('action-loop'), null);
  assert.deepEqual(s.keys(), []);
});

test('anything the store does not allow is dropped, on write and on the first read (failing partners)', () => {
  const { s, prefs } = make();
  prefs.setTier('not-in-the-catalog', 'high', 'low');
  prefs.setTier('action-loop', 'urgent', 'low');
  prefs.setTier('Client Name', 'high', 'low');
  assert.deepEqual(s.keys(), [], 'an unknown id, an unknown tier and a non-id are never kept');
  // A value someone else left under the key: extra fields, text, a session id, a non-boolean.
  const planted = { v: 1, priority: { 'secret-exposure': 'medium', 'cc-abcdefghijkl': 'high', 'action-loop': 'a typed note' }, strip: 'yes', low: true, query: 'words I typed', session: 'cc-abcdefghijkl' };
  const again = make({ [SLOT]: JSON.stringify(planted) });
  assert.equal(again.prefs.tierOf('secret-exposure'), 'medium');
  assert.deepEqual(JSON.parse(again.s.getItem(SLOT)), { v: 1, priority: { 'secret-exposure': 'medium' }, strip: false, low: true }, 'the first read cleans the stored value');
  // Not JSON at all.
  const broken = make({ [SLOT]: 'not json' });
  assert.equal(broken.prefs.strip, false);
  assert.deepEqual(broken.s.keys(), []);
});

test('at most a hundred overrides are kept', () => {
  const ids = Array.from({ length: 150 }, (_, i) => `pattern-${String(i).padStart(3, '0')}`);
  const s = storage({ [SLOT]: JSON.stringify({ priority: Object.fromEntries(ids.map((id) => [id, 'low'])) }) });
  const prefs = createPrefs({ localStorage: s, noEvents: true });
  prefs.setKnown(ids);
  assert.equal(Object.keys(JSON.parse(s.getItem(SLOT)).priority).length, 100);
});

test("a pattern's tier: mine when set, else the rule's; none for a pattern not found", () => {
  const { prefs } = make();
  const p = { id: 'action-loop', priority: { tier: 'low' } };
  assert.deepEqual(effective(prefs, p), { tier: 'low', mine: false, rule: 'low' });
  prefs.setTier('action-loop', 'high', 'low');
  assert.deepEqual(effective(prefs, p), { tier: 'high', mine: true, rule: 'low' });
  assert.equal(effective(prefs, { id: 'action-loop', priority: null }), null);
});

test('no storage at all (a blocked or private window): the page still works, keeping nothing', () => {
  const prefs = createPrefs({ localStorage: null, noEvents: true });
  prefs.setKnown(KNOWN);
  prefs.setTier('action-loop', 'high', 'low');
  prefs.strip = true;
  prefs.theme = 'dark';
  assert.equal(prefs.tierOf('action-loop'), null);
  assert.equal(prefs.strip, false);
  assert.equal(prefs.theme, null);
});

test('the theme: absent by default, kept when "light" or "dark", and nothing else', () => {
  const { s, prefs } = make();
  assert.deepEqual(THEMES, ['light', 'dark']);
  assert.equal(prefs.theme, null, 'no choice: the page follows the system');
  assert.deepEqual(s.keys(), [], 'nothing is written until a theme is chosen');
  prefs.theme = 'dark';
  assert.equal(prefs.theme, 'dark');
  assert.deepEqual(JSON.parse(s.getItem(SLOT)), { v: 1, priority: {}, strip: false, low: false, theme: 'dark' });
  prefs.theme = 'light';
  assert.deepEqual(JSON.parse(s.getItem(SLOT)), { v: 1, priority: {}, strip: false, low: false, theme: 'light' });
  // Anything but the two words forgets the choice; with nothing else kept, the key goes.
  for (const other of ['sepia', 'Dark', ' dark', '', 1, true, null, undefined, ['dark'], { dark: true }]) {
    prefs.theme = 'dark';
    prefs.theme = other;
    assert.equal(prefs.theme, null, JSON.stringify(other));
    assert.deepEqual(s.keys(), [], JSON.stringify(other));
  }
});

test('the theme lives beside the catalog choices without changing them, and their listeners are not told', () => {
  const { s, prefs } = make();
  let told = 0;
  prefs.onChange(() => (told += 1));
  prefs.setTier('action-loop', 'high', 'low');
  prefs.strip = true;
  told = 0;
  prefs.theme = 'dark';
  assert.equal(told, 0, 'a theme change redraws no catalog list');
  assert.deepEqual(JSON.parse(s.getItem(SLOT)), { v: 1, priority: { 'action-loop': 'high' }, strip: true, low: false, theme: 'dark' });
  prefs.setTier('action-loop', 'low', 'low');
  prefs.strip = false;
  assert.equal(prefs.theme, 'dark', 'clearing the catalog choices keeps the theme');
  prefs.theme = null;
  assert.deepEqual(s.keys(), [], 'and forgetting it then leaves nothing');
});

test('a stored theme outside the two words is dropped on the first read (failing partner)', () => {
  const planted = make({ [SLOT]: JSON.stringify({ v: 1, priority: {}, strip: true, low: false, theme: 'midnight' }) });
  assert.equal(planted.prefs.theme, null);
  assert.deepEqual(JSON.parse(planted.s.getItem(SLOT)), { v: 1, priority: {}, strip: true, low: false });
  const alone = make({ [SLOT]: JSON.stringify({ theme: '<b>dark</b>' }) });
  assert.equal(alone.prefs.theme, null);
  assert.deepEqual(alone.s.keys(), [], 'an invalid theme alone leaves nothing to keep');
  const kept = make({ [SLOT]: JSON.stringify({ theme: 'dark', note: 'typed words' }) });
  assert.equal(kept.prefs.theme, 'dark');
  assert.deepEqual(JSON.parse(kept.s.getItem(SLOT)), { v: 1, priority: {}, strip: false, low: false, theme: 'dark' });
});

test("another tab's theme change doesn't redraw the catalog lists; a priority change does", () => {
  const s = storage();
  const heard = [];
  const saved = globalThis.addEventListener;
  globalThis.addEventListener = (type, fn) => type === 'storage' && heard.push(fn);
  try {
    const prefs = createPrefs({ localStorage: s });
    let told = 0;
    prefs.onChange(() => (told += 1));
    const fire = (oldValue, newValue) => heard.forEach((fn) => fn({ key: SLOT, oldValue, newValue }));
    const base = { v: 1, priority: {}, strip: false, low: false };
    fire(JSON.stringify(base), JSON.stringify({ ...base, theme: 'dark' }));
    assert.equal(told, 0, 'only the theme changed');
    fire(JSON.stringify({ ...base, theme: 'dark' }), JSON.stringify({ ...base, strip: true, theme: 'dark' }));
    assert.equal(told, 1, 'a switch changed');
  } finally {
    if (saved === undefined) delete globalThis.addEventListener;
    else globalThis.addEventListener = saved;
  }
});
