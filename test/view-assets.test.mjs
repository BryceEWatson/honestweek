// The browser pages of `honestweek view` (lib/view/assets) and its click-through test
// (lib/view/selftest), read as files. The server sends a strict content policy (scripts and
// styles from its own files only), so no page may carry an inline script, an inline style, an
// inline event handler or document.write. The pages hold no real data, never reach the network,
// keep only the run key and the switch in storage, and put only ids in the address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'lib', 'view', 'assets');
const SELFTEST = join(HERE, '..', 'lib', 'view', 'selftest');
const PAGES = ['search.html', 'goal.html', 'replay.html'];
const SCRIPTS = ['evidence.js', 'key.js', 'private-text.js', 'common.js', 'search.js', 'goal.js', 'replay.js'];
const files = () => [...readdirSync(ASSETS).map((f) => ({ name: f, path: join(ASSETS, f) })), ...readdirSync(SELFTEST).map((f) => ({ name: `selftest/${f}`, path: join(SELFTEST, f) }))].map((f) => ({ ...f, text: readFileSync(f.path, 'utf8') }));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

test('assets: the shipped page files are all there, and nothing else', () => {
  assert.deepEqual(readdirSync(ASSETS).sort(), [...PAGES, ...SCRIPTS, 'common.css'].sort());
  assert.deepEqual(readdirSync(SELFTEST).sort(), ['clickthrough.html', 'clickthrough.js']);
});

test('assets: no inline script, inline style, style attribute or inline event handler in any page', () => {
  for (const f of files().filter((x) => x.name.endsWith('.html'))) {
    assert.doesNotMatch(f.text, /<style[\s>]/i, `${f.name}: a <style> block`);
    for (const m of f.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc="[^"]+"/, `${f.name}:${lineOf(f.text, m.index)}: a script without src`);
      assert.equal(m[2].trim(), '', `${f.name}:${lineOf(f.text, m.index)}: an inline script`);
    }
    for (const m of f.text.matchAll(/<[a-zA-Z][^<>]*>/g)) {
      assert.doesNotMatch(m[0], /\sstyle\s*=/i, `${f.name}:${lineOf(f.text, m.index)}: a style attribute`);
      assert.doesNotMatch(m[0], /\son[a-z]+\s*=/i, `${f.name}:${lineOf(f.text, m.index)}: an inline event handler`);
      assert.doesNotMatch(m[0], /javascript:/i, `${f.name}:${lineOf(f.text, m.index)}: a javascript: address`);
    }
  }
});

test('assets: no script writes an inline style, a handler attribute, an inline script or document.write', () => {
  for (const f of files().filter((x) => x.name.endsWith('.js'))) {
    const t = f.text;
    assert.doesNotMatch(t, /document\.write/, `${f.name}: document.write`);
    assert.doesNotMatch(t, /\beval\s*\(|new\s+Function\s*\(/, `${f.name}: eval or new Function`);
    assert.doesNotMatch(t, /setAttribute\(\s*['"`](style|on[a-z]+)['"`]/, `${f.name}: sets a style or handler attribute`);
    assert.doesNotMatch(t, /<script/i, `${f.name}: markup with a script element`);
    assert.doesNotMatch(t, /<style/i, `${f.name}: markup with a style element`);
    assert.doesNotMatch(t, /javascript:/i, `${f.name}: a javascript: address`);
    // Markup built in strings: a tag with a style attribute or an on...= handler.
    for (const m of t.matchAll(/<[a-zA-Z][^<>\n]*>/g)) {
      assert.doesNotMatch(m[0], /\sstyle\s*=/i, `${f.name}:${lineOf(t, m.index)}: markup with a style attribute`);
      assert.doesNotMatch(m[0], /\son[a-z]+\s*=\s*["'`$\\]/i, `${f.name}:${lineOf(t, m.index)}: markup with an inline handler`);
    }
  }
  // The stylesheet is the only place styles live, and it imports nothing.
  const css = readFileSync(join(ASSETS, 'common.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\((?!#)/i);
});

test('assets: every page loads the same files in the same order, and has the shared header', () => {
  for (const p of PAGES) {
    const t = readFileSync(join(ASSETS, p), 'utf8');
    const srcs = [...t.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ['evidence.js', 'key.js', 'private-text.js', 'common.js', p.replace('.html', '.js')], p);
    assert.deepEqual([...t.matchAll(/<link [^>]*href="([^"]+)"/g)].map((m) => m[1]), ['common.css'], p);
    for (const id of ['window', 'privacy', 'demo', 'status', 'content']) assert.match(t, new RegExp(`id="${id}"`), `${p}: #${id}`);
    assert.match(t, /data-evkey/, `${p}: the evidence key`);
    for (const link of PAGES) assert.match(t, new RegExp(`<nav[^]*href="${link}"[^]*</nav>`), `${p}: a link to ${link}`);
    assert.match(t, new RegExp(`href="${p}" aria-current="page"`), `${p}: marks itself current`);
  }
  const ct = readFileSync(join(SELFTEST, 'clickthrough.html'), 'utf8');
  assert.deepEqual([...ct.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]), ['/evidence.js', '/key.js', '/private-text.js', 'clickthrough.js']);
});

test('assets: one evidence vocabulary of five words', () => {
  const t = readFileSync(join(ASSETS, 'evidence.js'), 'utf8');
  const block = t.match(/const LEVELS = \{([^}]+)\}/)[1];
  assert.deepEqual([...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]), ['recorded', 'derived', 'inferred', 'missing', 'ambiguous']);
  // The prototype's other words for the same levels are gone from every page.
  for (const f of files().filter((x) => /\.(js|html)$/.test(x.name))) assert.doesNotMatch(f.text, /['"`>](computed|by rule|not found)['"`<]/, `${f.name}: an old evidence word`);
});

test('assets: no network: data comes only from this server, through the key client', () => {
  for (const f of files()) {
    // The SVG namespace is a name, not an address anything fetches.
    assert.doesNotMatch(f.text.replaceAll('http://www.w3.org/2000/svg', ''), /https?:\/\//, `${f.name}: an absolute address`);
    assert.doesNotMatch(f.text, /\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/, `${f.name}: another way to the network`);
    if (f.name !== 'key.js') assert.doesNotMatch(f.text, /\bfetch\s*\(/, `${f.name}: calls fetch itself instead of the key client`);
  }
  const key = readFileSync(join(ASSETS, 'key.js'), 'utf8');
  for (const m of key.matchAll(/fetchFn\(\s*([^,]+),/g)) assert.match(m[1], /^['`]\/api\//, `key.js asks only /api routes: ${m[1]}`);
});

test('assets: storage holds only the run key and the switch; localStorage is never used', () => {
  for (const f of files()) {
    const isKey = f.name === 'key.js';
    if (f.name === 'selftest/clickthrough.js') {
      // The test reads storage to check it, and writes nothing to it.
      assert.doesNotMatch(f.text, /(sessionStorage|localStorage)\.(setItem|removeItem|clear)/, f.name);
      continue;
    }
    assert.doesNotMatch(f.text, /localStorage/, `${f.name}: localStorage`);
    if (!isKey) assert.doesNotMatch(f.text, /sessionStorage/, `${f.name}: sessionStorage outside key.js`);
  }
  const key = readFileSync(join(ASSETS, 'key.js'), 'utf8');
  const writes = [...key.matchAll(/write\(\s*([A-Z_]+)\s*,/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)].sort(), ['KEY_SLOT', 'SWITCH_SLOT']);
});

test('assets: the address only ever gets ids, never typed or clicked text', () => {
  // Every place a page changes its own address, with the names it may build that address from.
  const allowed = new Set(['location', 'pathname', 'search', 'want', 'base', 'id', 'key', 'kept', 'join', 'length', 'loc', 'hist', 'state', 'null', 'qid', 'route', 'l', 'w']);
  let sites = 0;
  for (const f of files().filter((x) => x.name.endsWith('.js'))) {
    for (const m of f.text.matchAll(/(?:history|hist)\.(?:pushState|replaceState)\(([^;]*)\);?/g)) {
      sites++;
      const words = (m[1].replace(/'[^']*'/g, '').match(/[A-Za-z_]\w*/g) ?? []).filter((w) => !/^(c|q)$/.test(w));
      for (const w of words) assert.ok(allowed.has(w), `${f.name}:${lineOf(f.text, m.index)}: the address is built from "${w}"`);
    }
    assert.doesNotMatch(f.text, /location\.(hash|search|href)\s*=[^=]/, `${f.name}: sets the address directly`);
    assert.doesNotMatch(f.text, /location\.assign|location\.replace\(/, `${f.name}: navigates by script`);
  }
  assert.ok(sites >= 6, 'the address-changing calls were found');
  // Ids are checked before they reach an address or a link.
  const common = readFileSync(join(ASSETS, 'common.js'), 'utf8');
  assert.match(common, /thread: \/\^th-\[a-p\]/);
  // The search's address is its query id, and turning the switch off clears it.
  const search = readFileSync(join(ASSETS, 'search.js'), 'utf8');
  assert.match(search, /#q=\$\{qid\}~/);
  assert.match(search, /beforeOff = \(\) => \{\s*input\.value = '';\s*history\.replaceState\(null, '', `\$\{location\.pathname\}\$\{location\.search\}`\);/);
  // The click-through never takes a search word from its own address.
  const ct = readFileSync(join(SELFTEST, 'clickthrough.js'), 'utf8');
  assert.doesNotMatch(ct, /params\.get\('(term|q|word)'\)/);
});

test("the click-through's address check: a typed word counts only as a whole id-carrying part, never as a parameter's name or a number inside a step id", () => {
  const ct = readFileSync(join(SELFTEST, 'clickthrough.js'), 'utf8');
  const from = ct.indexOf('// ---- a typed word in an address');
  const to = ct.indexOf('// ---- end of a typed word in an address');
  assert.ok(from > 0 && to > from, 'the address check is marked off in clickthrough.js');
  const sandbox = { URLSearchParams };
  runInNewContext(`${ct.slice(from, to)}\nthis.typedInAddress = typedInAddress;`, sandbox);
  const holds = (address, typed) => {
    const u = new URL(address, 'http://127.0.0.1:1/');
    return sandbox.typedInAddress(u.search, u.hash, typed);
  };
  // Made-up search words and references, as the self-test types them.
  const typed = ['session', 'parser', '#123', 'feature/group-by-scope'];
  // The replay a search result opens: its parameter is named "session", its step id holds line 123.
  assert.equal(holds('replay.html?session=cc-abcdefghijkl#th-abcdefghijkl~cc-abcdefghijkl.123.0', typed), false);
  assert.equal(holds('replay.html#th-abcdefghijkl~git-abcdefghijkl.pr.123', typed), false);
  assert.equal(holds('search.html#q=qabcdefghijklmnop~w', typed), false);
  assert.equal(holds('goal.html#gabcd~cc-abcdefghijkl', typed), false);
  // A typed word put where an id goes is still found, whole or behind a kind prefix.
  assert.equal(holds('search.html#q=parser~w', typed), true);
  assert.equal(holds('goal.html#parser', typed), true);
  assert.equal(holds('replay.html#th-parser', typed), true);
  assert.equal(holds('replay.html?session=cc-parser', typed), true);
  assert.equal(holds('replay.html?session=session', typed), true, 'a typed word as a value counts, even when it is also a name');
});

test('the click-through sends the leak check each shown string and value on its own, never one joined text', () => {
  const ct = readFileSync(join(SELFTEST, 'clickthrough.js'), 'utf8');
  assert.match(ct, /api\('leak-check', \{ parts: 1 \}, \{ method: 'POST', body: JSON\.stringify\(parts\) \}\)/);
  const calls = [...ct.matchAll(/noLeaks\(([^\n]*)\);?\n/g)].map((m) => m[1]);
  assert.ok(calls.length >= 5, 'the leak checks were found');
  for (const c of calls) {
    assert.doesNotMatch(c, /\.join\(|text\((?:d|doc\(\)|r)\.|JSON\.stringify/, `a leak check joins its text: noLeaks(${c})`);
  }
  assert.doesNotMatch(ct, /JSON\.stringify\(e\.facts/, "a step's fields are sent as they are, not as JSON text");
});

test('assets: the click-through counts policy violations as failures and keeps its named skip list', () => {
  const ct = readFileSync(join(SELFTEST, 'clickthrough.js'), 'utf8');
  assert.match(ct, /addEventListener\('securitypolicyviolation'/);
  assert.match(ct, /const SKIPS = \{/);
  assert.match(ct, /skipped for a reason that isn't on the named list/);
  for (const m of ct.matchAll(/skip\('([\w-]+)'\)/g)) assert.ok(new RegExp(`'${m[1]}':|${m[1].replace(/-/g, '\\-')}:`).test(ct.match(/const SKIPS = \{([^]*?)\n  \};/)[1]) || m[1] === 'page-did-not-load', `skip "${m[1]}" isn't on the named list`);
});

// No real data in these files. The named tokens of the clean-room fence are checked over them by
// test/site-cleanroom.test.mjs, which keeps that list in one place; this checks the shapes.
test('assets: no real data: names, home folders, addresses or codenames', () => {
  for (const f of files()) {
    assert.doesNotMatch(f.text, /\bBryce\b/i, `${f.name}: an operator account name`);
    assert.doesNotMatch(f.text, /[A-Za-z]:\\\\?Users\\\\?|\/Users\/[A-Za-z]|\/home\/[a-z]/, `${f.name}: a home folder`);
    for (const m of f.text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) assert.match(m[0], /@example\.(com|org)$/, `${f.name}: an email address`);
    assert.doesNotMatch(f.text, /\bprivateText\b|createSecretsOnlyRedactor/, `${f.name}: the engine's private-text names stay on the server`);
    assert.doesNotMatch(f.text, /\u2014/, `${f.name}: an em dash (the published voice bar)`);
  }
});
