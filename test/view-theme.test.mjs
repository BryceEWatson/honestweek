// The light/dark button in every page's header. prefs.js puts a stored theme on <html> as soon
// as it runs (it's in each page's head) and draws the button; common.js mounts it beside the
// "Show private text" switch on the data pages, form.js at the header's end on Setup and
// Settings. With no choice stored the page follows the system. These are plain browser scripts;
// here they run in a sandbox with a made-up storage and a stand-in for the few DOM calls they make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'view', 'assets');
const source = (f) => readFileSync(join(ASSETS, f), 'utf8');
const SLOT = 'hw.prefs';

class El {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.dataset = {};
    this.innerHTML = '';
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  append(...kids) {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
  }
  after(node) {
    node.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node);
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn({ target: this });
  }
}
const find = (el, id) => (el.id === id ? el : el.children.reduce((hit, c) => hit ?? find(c, id), null));

/** A page's header (with or without the switch), a storage holding `stored`, and a system
 *  setting, in a sandbox the scripts see as their window. */
function page({ privacy = true, stored, systemDark = false, blocked = false } = {}) {
  const html = new El('html');
  const header = new El('header');
  header.append(new El('a'), new El('nav'), new El('span'));
  if (privacy) header.append(new El('span', 'privacy'), new El('button', 'keyBtn'));
  const mq = {
    matches: systemDark,
    listeners: [],
    addEventListener(type, fn) {
      if (type === 'change') this.listeners.push(fn);
    },
  };
  const store = new Map(stored === undefined ? [] : [[SLOT, stored]]);
  const document = {
    documentElement: html,
    body: { dataset: {} },
    querySelector: (sel) => (sel === 'header.topbar' ? header : null),
    getElementById: (id) => find(header, id),
    createElement: (tag) => new El(tag),
    addEventListener() {},
  };
  const sb = { document, matchMedia: () => mq };
  if (blocked) {
    Object.defineProperty(sb, 'localStorage', {
      get() {
        throw new Error('storage is blocked in this window');
      },
    });
  } else {
    sb.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  }
  sb.window = sb;
  document.defaultView = sb;
  createContext(sb);
  return { sb, html, header, store, mq, run: (f) => runInContext(source(f), sb) };
}
const order = (header) => header.children.map((c) => c.id || c.tagName.toLowerCase());
const isMoon = (btn) => /^<svg[^>]*stroke="currentColor"[^>]*aria-hidden="true"/.test(btn.innerHTML) && btn.innerHTML.includes('M21 12.8') && !btn.innerHTML.includes('<circle');
const isSun = (btn) => /^<svg[^>]*stroke="currentColor"[^>]*aria-hidden="true"/.test(btn.innerHTML) && btn.innerHTML.includes('<circle') && !btn.innerHTML.includes('M21 12.8');

test('common.js puts the button right after the switch; a click sets data-theme on <html> and remembers it', async () => {
  const p = page();
  p.run('prefs.js');
  assert.equal(p.html.getAttribute('data-theme'), null, 'no choice stored: the page follows the system');
  p.sb.HWE = { chips: () => '' };
  p.sb.HWP = { ready: Promise.resolve('no-key'), notice: () => '' };
  p.run('common.js');
  await p.sb.HW.start(async () => {});
  assert.deepEqual(order(p.header), ['a', 'nav', 'span', 'privacy', 'themeBtn', 'keyBtn'], 'beside the switch, even when the page has no key');
  const btn = find(p.header, 'themeBtn');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.type, 'button');
  assert.equal(btn.className, 'themebtn');
  assert.equal(btn.getAttribute('aria-label'), 'Switch to dark');
  assert.equal(btn.getAttribute('title'), 'Switch to dark');
  assert.ok(isMoon(btn), 'a light page shows the moon');
  assert.equal(p.store.size, 0, 'drawing the button stores nothing');

  btn.click();
  assert.equal(p.html.getAttribute('data-theme'), 'dark');
  assert.deepEqual(JSON.parse(p.store.get(SLOT)), { v: 1, priority: {}, strip: false, low: false, theme: 'dark' });
  assert.equal(btn.getAttribute('aria-label'), 'Switch to light');
  assert.equal(btn.getAttribute('title'), 'Switch to light');
  assert.ok(isSun(btn), 'a dark page shows the sun');

  btn.click();
  assert.equal(p.html.getAttribute('data-theme'), 'light');
  assert.equal(JSON.parse(p.store.get(SLOT)).theme, 'light');
  assert.equal(btn.getAttribute('aria-label'), 'Switch to dark');
  assert.ok(isMoon(btn));

  // The next page this browser opens starts in the choice, before any page script runs.
  const next = page({ stored: p.store.get(SLOT), systemDark: true });
  next.run('prefs.js');
  assert.equal(next.html.getAttribute('data-theme'), 'light', 'the stored choice beats a dark system');
});

test('a stored theme is on <html> as soon as prefs.js runs; one outside the two words is dropped', () => {
  const dark = page({ stored: JSON.stringify({ v: 1, priority: {}, strip: false, low: false, theme: 'dark' }) });
  dark.run('prefs.js');
  assert.equal(dark.html.getAttribute('data-theme'), 'dark');
  const odd = page({ stored: JSON.stringify({ theme: 'midnight' }), systemDark: true });
  odd.run('prefs.js');
  assert.equal(odd.html.getAttribute('data-theme'), null, 'an unknown word sets nothing');
  assert.equal(odd.store.size, 0, 'and is cleaned away on that first read');
  const broken = page({ stored: 'not json' });
  broken.run('prefs.js');
  assert.equal(broken.html.getAttribute('data-theme'), null);
});

test('with no choice the button follows the system: a dark system offers light, and a change redraws it', () => {
  const p = page({ systemDark: true });
  p.run('prefs.js');
  const btn = p.sb.HWPrefs.mountTheme(p.sb.document);
  assert.equal(p.html.getAttribute('data-theme'), null);
  assert.equal(btn.getAttribute('aria-label'), 'Switch to light');
  assert.ok(isSun(btn));
  p.mq.matches = false;
  for (const fn of p.mq.listeners) fn();
  assert.equal(btn.getAttribute('aria-label'), 'Switch to dark', 'the system turned light');
  assert.ok(isMoon(btn));
  p.mq.matches = true;
  for (const fn of p.mq.listeners) fn();
  btn.click();
  assert.equal(p.html.getAttribute('data-theme'), 'light', 'from a dark system, a click chooses light');
  assert.equal(JSON.parse(p.store.get(SLOT)).theme, 'light');
  // Once chosen, the system no longer moves the page or the button.
  p.mq.matches = false;
  for (const fn of p.mq.listeners) fn();
  assert.equal(btn.getAttribute('aria-label'), 'Switch to dark');
  assert.equal(p.html.getAttribute('data-theme'), 'light');
});

test('Setup and Settings get the same button from form.js, at the end of a header with no switch', () => {
  const p = page({ privacy: false, stored: JSON.stringify({ theme: 'dark' }) });
  p.run('prefs.js');
  p.sb.HWP = {};
  p.run('form.js');
  assert.deepEqual(order(p.header), ['a', 'nav', 'span', 'themeBtn']);
  const btn = find(p.header, 'themeBtn');
  assert.equal(btn.getAttribute('aria-label'), 'Switch to light', 'the stored dark choice is shown');
  btn.click();
  assert.equal(p.html.getAttribute('data-theme'), 'light');
});

test('mounting twice keeps one button; a page without the header gets none', () => {
  const p = page();
  p.run('prefs.js');
  const first = p.sb.HWPrefs.mountTheme(p.sb.document);
  const again = p.sb.HWPrefs.mountTheme(p.sb.document);
  assert.equal(first, again);
  assert.equal(order(p.header).filter((id) => id === 'themeBtn').length, 1);
  assert.equal(first.listeners.click.length, 1, 'one click handler, so one click is one switch');
  assert.equal(p.mq.listeners.length, 1);
  assert.equal(p.sb.HWPrefs.mountTheme({ querySelector: () => null }), null);
});

test('storage blocked (a private window): the click still switches this page, and nothing is kept (failing partner)', () => {
  const p = page({ blocked: true });
  p.run('prefs.js');
  assert.equal(p.html.getAttribute('data-theme'), null);
  const btn = p.sb.HWPrefs.mountTheme(p.sb.document);
  btn.click();
  assert.equal(p.html.getAttribute('data-theme'), 'dark');
  assert.equal(btn.getAttribute('aria-label'), 'Switch to light');
  assert.equal(p.store.size, 0);
});

test('a theme picked in another tab shows here too, and the button redraws', () => {
  const p = page();
  const heard = [];
  p.sb.addEventListener = (type, fn) => type === 'storage' && heard.push(fn);
  p.run('prefs.js');
  const btn = p.sb.HWPrefs.mountTheme(p.sb.document);
  assert.ok(isMoon(btn));
  // The other tab writes the store; this one hears the storage event.
  p.store.set(SLOT, JSON.stringify({ v: 1, priority: {}, strip: false, low: false, theme: 'dark' }));
  for (const fn of heard) fn({ key: SLOT });
  assert.equal(p.html.getAttribute('data-theme'), 'dark');
  assert.ok(isSun(btn), 'the button offers light now');
  // Another key changing leaves the page alone (failing partner).
  p.store.set(SLOT, JSON.stringify({ v: 1, priority: {}, strip: false, low: false, theme: 'light' }));
  for (const fn of heard) fn({ key: 'something-else' });
  assert.equal(p.html.getAttribute('data-theme'), 'dark');
});
