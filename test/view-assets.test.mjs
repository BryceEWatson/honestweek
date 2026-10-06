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

import { createRedactor } from '../lib/redact.mjs';
import { createLeakCounter } from '../lib/view/leaks.mjs';
import { memberCount } from '../lib/view/data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'lib', 'view', 'assets');
const SELFTEST = join(HERE, '..', 'lib', 'view', 'selftest');
const PAGES = ['search.html', 'goal.html', 'replay.html', 'problems.html'];
// The scripts each page loads after the shared ones, in order. prefs.js comes first of all, in
// the head, so a stored light/dark choice is on the page before anything is drawn.
const PAGE_SCRIPTS = { 'search.html': ['search.js'], 'goal.html': ['strip.js', 'goal.js'], 'replay.html': ['facts.js', 'replay-model.js', 'sessions.js', 'replay.js'], 'problems.html': ['insights.js', 'facts.js', 'problems.js'] };
const IN_HEAD = /<head>[^]*<script src="prefs\.js"><\/script>\s*<link rel="stylesheet" href="common\.css">[^]*<\/head>/;
// The package author's name, read from package.json so this test doesn't spell out a real name.
const OWNER_WORDS = String(JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).author ?? '')
  .split(/\s+/)
  .filter((w) => /^[A-Za-z]{3,}$/.test(w));
const SCRIPTS = ['evidence.js', 'key.js', 'private-text.js', 'common.js', 'search.js', 'goal.js', 'replay.js', 'replay-model.js', 'problems.js', 'insights.js', 'facts.js', 'prefs.js', 'strip.js', 'sessions.js'];
const files = () => [...readdirSync(ASSETS).map((f) => ({ name: f, path: join(ASSETS, f) })), ...readdirSync(SELFTEST).map((f) => ({ name: `selftest/${f}`, path: join(SELFTEST, f) }))].map((f) => ({ ...f, text: readFileSync(f.path, 'utf8') }));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

test('assets: the shipped page files are all there, and nothing else', () => {
  assert.deepEqual(readdirSync(ASSETS).sort(), [...PAGES, 'setup.html', 'settings.html', ...SCRIPTS, 'form.js', 'setup.js', 'settings.js', 'common.css', 'problems.css', 'replay.css'].sort());
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
  // The stylesheets are the only place styles live, and they import nothing.
  for (const name of ['common.css', 'problems.css', 'replay.css']) assert.doesNotMatch(readFileSync(join(ASSETS, name), 'utf8'), /@import|url\((?!#)/i, name);
});

test('assets: every page loads the same files in the same order, and has the shared header', () => {
  for (const p of PAGES) {
    const t = readFileSync(join(ASSETS, p), 'utf8');
    const srcs = [...t.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ['prefs.js', 'evidence.js', 'key.js', 'private-text.js', 'common.js', ...PAGE_SCRIPTS[p]], p);
    assert.match(t, IN_HEAD, `${p}: prefs.js in the head, before the stylesheet`);
    // The Problems and Replay pages add their own stylesheet after the shared one, which stays as it is.
    const own = { 'problems.html': 'problems.css', 'replay.html': 'replay.css' }[p];
    assert.deepEqual([...t.matchAll(/<link [^>]*href="([^"]+)"/g)].map((m) => m[1]), own ? ['common.css', own] : ['common.css'], p);
    for (const id of ['window', 'privacy', 'demo', 'status', 'content', 'quiet', 'privnote', 'navHigh']) assert.match(t, new RegExp(`id="${id}"`), `${p}: #${id}`);
    assert.match(t, /data-evkey/, `${p}: the evidence key`);
    // The key is one click away: a "?" button in the header opens it, named for a screen reader.
    assert.match(t, /<button type="button" class="keybtn" id="keyBtn" aria-expanded="false" aria-controls="evkeyPanel" aria-label="How each link is known"[^>]*>\?<\/button>/, `${p}: the "?" button`);
    assert.match(t, /<div class="evkey-pop" id="evkeyPanel" role="region" aria-label="How each link is known" hidden><p class="evkey" data-evkey><\/p><\/div>/, `${p}: the key's panel, closed`);
    // The Problems link carries the High count, filled in by script.
    assert.match(t, /<a href="problems\.html"[^>]*>Problems<span class="navcount" id="navHigh" hidden><\/span><\/a>/, `${p}: the Problems count`);
    for (const link of PAGES) assert.match(t, new RegExp(`<nav[^]*href="${link}"[^]*</nav>`), `${p}: a link to ${link}`);
    assert.match(t, new RegExp(`href="${p}" aria-current="page"`), `${p}: marks itself current`);
  }
  // The Setup page has the same header and quiet footer, and only the preferences (for the
  // light/dark choice, in its head) and the key client before its own script.
  const st = readFileSync(join(ASSETS, 'setup.html'), 'utf8');
  assert.deepEqual([...st.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]), ['prefs.js', 'key.js', 'private-text.js', 'form.js', 'setup.js']);
  assert.match(st, IN_HEAD, 'setup.html: prefs.js in the head');
  assert.deepEqual([...st.matchAll(/<link [^>]*href="([^"]+)"/g)].map((m) => m[1]), ['common.css']);
  for (const id of ['status', 'content', 'repos', 'addPath', 'emails', 'timezone', 'names', 'terms', 'goals', 'previewBtn', 'saveBtn']) assert.match(st, new RegExp(`id="${id}"`), `setup.html: #${id}`);
  assert.match(st, /<header class="topbar">[^]*href="setup\.html" aria-current="page"/);
  // Nothing typed there can reach an address: no form to submit, and no field a browser remembers.
  assert.doesNotMatch(st, /<form\b|<(input|select|textarea)\b[^>]*\sname="/);
  for (const m of st.matchAll(/<input\b[^>]*>/g)) assert.match(m[0], /autocomplete="off"/, m[0]);
  // Settings: the same rules, and every page's header links to it.
  const sg = readFileSync(join(ASSETS, 'settings.html'), 'utf8');
  assert.deepEqual([...sg.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]), ['prefs.js', 'key.js', 'private-text.js', 'form.js', 'settings.js']);
  assert.match(sg, IN_HEAD, 'settings.html: prefs.js in the head');
  assert.match(sg, /href="settings\.html" aria-current="page"/);
  assert.doesNotMatch(sg, /<form\b|<(input|select|textarea)\b[^>]*\sname="/);
  for (const m of sg.matchAll(/<input\b[^>]*>/g)) assert.match(m[0], /autocomplete="off"/, m[0]);
  for (const p of PAGES) assert.match(readFileSync(join(ASSETS, p), 'utf8'), /<nav[^]*href="settings\.html"[^]*<\/nav>/, `${p}: a link to Settings`);
  const ct = readFileSync(join(SELFTEST, 'clickthrough.html'), 'utf8');
  assert.deepEqual([...ct.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]), ['/evidence.js', '/key.js', '/private-text.js', 'clickthrough.js']);
});

test('evidence: four levels have a small inline symbol, "ambiguous" stays a word, and the word is always there', () => {
  const sandbox = { window: {}, document: { querySelectorAll: () => [], readyState: 'complete', addEventListener: () => {} } };
  runInNewContext(readFileSync(join(ASSETS, 'evidence.js'), 'utf8'), sandbox);
  const { chip, sym, symbol, keyHtml, sideKeyHtml, WORDS } = sandbox.window.HWE;
  const words = (html) => html.replace(/<[^>]+>/g, '');
  const shapes = { recorded: /<circle[^>]*fill="currentColor"/, derived: /<path d="M6 1\.5 A4\.5 4\.5 0 0 1 6 10\.5 Z" fill="currentColor"/, inferred: /<circle[^>]*fill="none"[^>]*stroke-width="1\.5"\/>/, missing: /stroke-dasharray="2 2"/ };
  for (const [level, shape] of Object.entries(shapes)) {
    const c = chip(level);
    assert.match(c, shape, `${level}: its shape`);
    assert.match(c, /<svg class="evsym"[^>]* aria-hidden="true" focusable="false">/, `${level}: the symbol is hidden from a screen reader`);
    assert.equal(words(c), level, `${level}: the word follows the symbol`);
    // The symbol alone keeps the word for a screen reader.
    const s = sym(level);
    assert.match(s, new RegExp(`<span class="sr">${level}</span>`), `${level}: sym keeps the word`);
    assert.equal(words(s), level);
    assert.doesNotMatch(c + s, /\sstyle=/, 'no style attribute');
  }
  // "ambiguous" has no symbol: it shows its word, also where other levels show only a symbol.
  assert.equal(symbol('ambiguous'), '');
  assert.doesNotMatch(chip('ambiguous') + sym('ambiguous'), /<svg/);
  assert.equal(words(sym('ambiguous')), 'ambiguous');
  assert.equal(words(chip('inferred', 'rule x')), 'inferred · rule x');
  // The header's key and the key beside results both name all five words, each with its symbol.
  for (const html of [keyHtml(), sideKeyHtml()]) for (const w of WORDS) assert.ok(html.includes(chip(w)), `the key holds ${w}`);
  assert.equal((keyHtml().match(/class="evkey-item"/g) ?? []).length, 5);
  assert.doesNotMatch(sideKeyHtml(), /evkey-item|data-evkey/, 'the side key is not a second header key');
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

test('assets: session storage holds only the run key and the switch; local storage only the catalog preferences and the theme, in prefs.js', () => {
  for (const f of files()) {
    const isKey = f.name === 'key.js';
    if (f.name === 'selftest/clickthrough.js') {
      // The test reads storage to check it, and writes nothing to it.
      assert.doesNotMatch(f.text, /(sessionStorage|localStorage)\.(setItem|removeItem|clear)/, f.name);
      continue;
    }
    if (f.name !== 'prefs.js') assert.doesNotMatch(f.text, /localStorage/, `${f.name}: localStorage outside prefs.js`);
    if (!isKey) assert.doesNotMatch(f.text, /sessionStorage/, `${f.name}: sessionStorage outside key.js`);
  }
  // prefs.js writes one key, and only a value its clean() made (test/view-prefs.test.mjs runs it).
  const prefs = readFileSync(join(ASSETS, 'prefs.js'), 'utf8');
  assert.deepEqual([...prefs.matchAll(/storage\.(setItem|removeItem)\(\s*([A-Z_]+)/g)].map((m) => m[2]), ['SLOT', 'SLOT']);
  assert.match(prefs, /const SLOT = 'hw\.prefs';/);
  assert.match(prefs, /storage\.setItem\(SLOT, JSON\.stringify\(c\)\)/);
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
    // A page may go to another page by its fixed file name, which carries nothing typed.
    assert.doesNotMatch(f.text, /location\.(hash|search|href)\s*=(?!\s*'[a-z]+\.html';)[^=]/, `${f.name}: sets the address directly`);
    assert.doesNotMatch(f.text, /location\.assign|location\.replace\((?!'[a-z]+\.html'\))/, `${f.name}: navigates by script`);
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

test("the pages say a prompt from a non-interactive run is a person's or a script's, inferred, never the agent's", () => {
  const sandbox = { window: { HWE: { chips: () => '' }, HWP: {} }, document: { getElementById: () => null } };
  runInNewContext(readFileSync(join(ASSETS, 'common.js'), 'utf8'), sandbox);
  const HW = sandbox.window.HW;
  const exec = { id: 'cx-abcdefghijkl.3.0', kind: 'prompt', actor: 'person-or-script', inferred: [{ key: 'authorship', value: 'person-or-script', rule: 'prompt.authorship.exec-session' }] };
  for (const e of [exec, { ...exec, inferred: [] }]) {
    const w = HW.who(e);
    assert.equal(w.short, 'A person or a script', JSON.stringify(e.inferred));
    assert.equal(w.level, 'inferred');
  }
  assert.deepEqual([HW.who(exec).rule], ['prompt.authorship.exec-session']);
  const typed = HW.who({ id: 'cc-abcdefghijkl.1.0', kind: 'prompt', actor: 'person', inferred: [] });
  assert.equal(typed.short, 'You');
  assert.equal(typed.level, 'recorded');
});

test("the pages put a program's command and instructions in the agent's lane, never yours", () => {
  const sandbox = { window: { HWE: { chips: () => '' }, HWP: {} }, document: { getElementById: () => null } };
  runInNewContext(readFileSync(join(ASSETS, 'common.js'), 'utf8'), sandbox);
  const HW = sandbox.window.HW;
  const agent = 'cc-abcdefghijkl:main';
  const sent = [{ kind: 'command', facts: { name: '/review', from: 'program' } }, { kind: 'delegation-received', facts: { from: 'program' } }, { kind: 'agent-message', facts: { from: 'program', direction: 'inbound' } }];
  for (const e of sent.map((x, i) => ({ id: `cc-abcdefghijkl.${i}.0`, actor: 'program', agent, inferred: [], ...x }))) {
    assert.deepEqual([HW.who(e).short, HW.who(e).level], ['A program', 'recorded'], e.kind);
    assert.equal(HW.laneOf(e), agent, e.kind);
  }
  // The same command typed by you stays in your lane.
  assert.equal(HW.laneOf({ id: 'cc-abcdefghijkl.9.0', kind: 'command', actor: 'person', agent, inferred: [] }), 'person');
  // Replay's show-or-hide list counts a program's turns apart from your slash commands.
  const replay = readFileSync(join(ASSETS, 'replay.js'), 'utf8');
  assert.match(replay, /p\.e\.actor === 'program' \? 'kind:program'/);
  assert.match(replay, /\['kind:program', 'Sent by a program/);
});

test("a goal's session count on a page is no stronger than its weakest session", () => {
  const sandbox = { window: { HWE: { chips: () => '' }, HWP: {} }, document: { getElementById: () => null } };
  runInNewContext(readFileSync(join(ASSETS, 'common.js'), 'utf8'), sandbox);
  const { memberLevel } = sandbox.window.HW;
  assert.equal(memberLevel([{ evidence: 'recorded' }, { evidence: 'derived' }]), 'derived');
  assert.equal(memberLevel([{ evidence: 'recorded' }, { evidence: 'inferred' }]), 'inferred');
  assert.equal(memberLevel([{ evidence: 'recorded', ambiguous: true }]), 'inferred');
  assert.equal(memberLevel([{ evidence: 'missing' }]), 'inferred');
  // The server's count for the home page reads the same level over the same sessions.
  const sets = [[], [{ evidence: 'recorded' }], [{ evidence: 'derived' }], [{ evidence: 'inferred' }], [{ evidence: 'missing' }], [{ evidence: 'recorded', ambiguous: true }], [{ evidence: 'recorded' }, { evidence: 'derived' }], [{ evidence: 'derived' }, { evidence: 'inferred' }]];
  for (const s of sets) assert.equal(memberCount(s.map((m) => ({ ...m, joins: [] }))).evidence, memberLevel(s), JSON.stringify(s));
});

test("the step list keeps each piece read from the logs in its own element, and cuts one only where the scrubber reads it the same", () => {
  // common.js, loaded the way a page loads it, over made-up answers.
  const sandbox = { window: { HWE: { chips: () => '' }, HWP: {} }, document: { getElementById: () => null } };
  runInNewContext(readFileSync(join(ASSETS, 'common.js'), 'utf8'), sandbox);
  const HW = sandbox.window.HW;
  const config = { redaction: { codenames: [], names: [], terms: ['Northwind'] } };
  const full = createRedactor(config).redact;
  const leaks = createLeakCounter(config);
  // What the server sends: a sub-agent whose description ends in a word that names a
  // credential, a command that ends in a hidden header, and a command with a long id that
  // the scrubber leaves whole (its hex tail is set aside as a commit id).
  const header = full('curl -s https://api.example.com/v1/items -H Authorization: Bearer abcdEFGH12345678');
  const longId = full(`Set-Location app; $runner = 'build'; ${'x'.repeat(63)} run worker7f3e2026-b12c-34d5-abcd-2026e45f67a8:1 again`);
  assert.equal(header, 'curl -s https://api.example.com/v1/items -H Authorization: [redacted:secret]');
  assert.ok(longId.includes('worker7f3e2026-b12c-34d5-abcd-2026e45f67a8'), 'the scrubber leaves the long id');
  const at = Date.UTC(2025, 2, 12, 10, 9);
  HW.useData({
    events: [
      { id: 'cc-abcdefghijkl.40.0', t: at, kind: 'action', group: 'run', actor: 'agent', agent: 'ag-1', ev: 'recorded', facts: { command: header } },
      { id: 'cc-abcdefghijkl.41.0', t: at + 1000, kind: 'action', group: 'run', actor: 'agent', agent: 'ag-1', ev: 'recorded', facts: { command: longId } },
    ],
    agents: [{ key: 'ag-1', session: 'cc-abcdefghijkl', kind: 'subagent', type: 'general-purpose', description: 'Review the session auth' }],
  });
  for (const s of [header, longId, 'Review the session auth']) assert.equal(leaks.redacted(s).total, 0, 'each served string reads clean on its own');
  // Before: one line in one text node, and a hard cut at 140 characters, five into the id's hex tail.
  assert.equal(leaks.redacted(longId.slice(0, 140)).secrets, 1, 'a cut inside the id reads as a token');
  const el = { innerHTML: '' };
  const drawn = [...HW.data.byId.values()].map((e) => {
    const pieces = HW.describeStepPieces(e);
    return { id: e.id, text: pieces.map(([t]) => t).join(''), pieces };
  });
  for (const d of drawn) {
    assert.equal(d.text, HW.describeStep(HW.data.byId.get(d.id)), 'a screen reader hears the same line');
    assert.equal(leaks.redacted(d.text).secrets, 1, 'joined, the page\'s own words read as a field\'s value');
  }
  HW.stepList(el, drawn);
  const nodes = el.innerHTML.split(/<[^>]+>/).map((t) => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).filter((t) => t.trim());
  assert.deepEqual(nodes.join('').replace(/\s+/g, ' '), drawn.map((d) => d.text).join('').replace(/\s+/g, ' '));
  for (const t of nodes) assert.equal(leaks.redacted(t).total, 0, `a text node reads as a leak: ${JSON.stringify(t)}`);
  assert.ok(nodes.includes('Sub-agent general-purpose: Review the session auth') && nodes.includes(header), 'the pieces from the logs stand alone');
  // The cut: never inside a run of token characters or a placeholder; a run longer than half
  // the room is shown whole.
  const cut = HW.clip(longId, 140);
  assert.ok(longId.startsWith(cut) && cut.length < longId.length);
  assert.equal(leaks.redacted(cut).total, 0);
  assert.ok(!cut.includes('worker7f3e'), 'the cut stops before the id');
  assert.equal(HW.clip('see password: [redacted:secret] then more', 22), 'see password:');
  // A cut that falls inside a quoted hidden value drops the quote it would leave open.
  const quoted = 'curl -s https://api.example.com -H "Authorization: [redacted:secret]" -d token="[redacted:secret]"';
  assert.equal(full(quoted), quoted, 'the scrubber leaves it as it is');
  assert.equal(leaks.redacted(quoted.slice(0, quoted.lastIndexOf('[redacted'))).secrets, 1, 'token=" reads as a field whose value is the quote');
  assert.equal(HW.clip(quoted, quoted.length - 5), 'curl -s https://api.example.com -H "Authorization: [redacted:secret]" -d token=');
  assert.equal(leaks.redacted(HW.clip(quoted, quoted.length - 5)).total, 0);
  assert.equal(HW.clip('a'.repeat(200), 50), 'a'.repeat(200));
  assert.equal(HW.clip('short', 50), 'short');
  // A chart label's cut keeps a placeholder whole, and its "…" stands apart.
  assert.equal(HW.fitText('Review the session auth: [redacted:secret] and more words here', 36, 1), 'Review the session auth:<tspan>…</tspan>');
  assert.equal(HW.fitText('Plain & short', 36, 1), 'Plain &amp; short');
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

test('assets: on the demo week the click-through allows only the skips that cannot apply to it', () => {
  const ct = readFileSync(join(SELFTEST, 'clickthrough.js'), 'utf8');
  const keys = (name) => [...ct.match(new RegExp(`const ${name} = \\{([^]*?)\\n  \\};`))[1].matchAll(/^\s+'([\w-]+)':/gm)].map((m) => m[1]);
  const all = keys('SKIPS');
  const demo = keys('DEMO_SKIPS');
  // The demo week holds every other case on purpose (docs/demo-week.md), so a skip for one
  // of them on the demo fails the step.
  assert.deepEqual(demo, ['built-before-test', 'already-set-up', 'no-settings', 'private-words-set', 'goal-list-set']);
  for (const id of demo) assert.ok(all.includes(id), `${id} is on the named list`);
  for (const id of ['no-inferred-author', 'no-script-prompt', 'no-moved-time', 'no-borrowed-time', 'no-crowded-marks', 'no-routine-note', 'no-strip-finding', 'no-problem-found']) assert.ok(all.includes(id) && !demo.includes(id), id);
  assert.match(ct, /const demoAllows = !env\.demo \|\| !!DEMO_SKIPS\[err\.id\];/);
  assert.match(ct, /status = named && demoAllows \? 'SKIP' : 'FAIL';/);
});

// No real data in these files. The named tokens of the clean-room fence are checked over them by
// test/site-cleanroom.test.mjs, which keeps that list in one place; this checks the shapes.
test('assets: no real data: names, home folders, addresses or codenames', () => {
  for (const f of files()) {
    for (const word of OWNER_WORDS) assert.doesNotMatch(f.text, new RegExp(`\\b${word}\\b`, 'i'), `${f.name}: the package author's name`);
    assert.doesNotMatch(f.text, /[A-Za-z]:\\\\?Users\\\\?|\/Users\/[A-Za-z]|\/home\/[a-z]/, `${f.name}: a home folder`);
    for (const m of f.text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) assert.match(m[0], /@example\.(com|org)$/, `${f.name}: an email address`);
    assert.doesNotMatch(f.text, /\bprivateText\b|createSecretsOnlyRedactor/, `${f.name}: the engine's private-text names stay on the server`);
    assert.doesNotMatch(f.text, /\u2014/, `${f.name}: an em dash (the published voice bar)`);
  }
});

// What the header and the Find cards say has to hold when the answer behind them is missing,
// capped or wider than the label.
test("the header says the problem checks couldn't load instead of looking like none were found", () => {
  const common = readFileSync(join(ASSETS, 'common.js'), 'utf8');
  const nav = common.match(/function navCount\(patterns\) \{[^]*?\n  \}/)[0];
  assert.match(nav, /if \(!Array\.isArray\(patterns\)\) \{\s+el\.hidden = false;/, 'no patterns shows a mark');
  assert.match(nav, /the problem checks could not load/, 'and says why, to a screen reader too');
  assert.match(common, /problemsSummary\(\)\.then\(\(a\) => navCount\(a\?\.patterns\), \(\) => navCount\(null\)\);/, 'a failed summary reaches the header');
  assert.match(readFileSync(join(ASSETS, 'search.js'), 'utf8'), /HW\.navCount\(null\);\s+if \(\$\('lookBody'\)\)/, "and so does the Find card's failure");
});

test('a share of the window tokens reads the same on Find as on Problems, to one decimal under 10%', () => {
  const common = readFileSync(join(ASSETS, 'common.js'), 'utf8');
  const pct = runInNewContext(`(${common.match(/const pct = (\(x\) => [^\n]+);/)[1]})`);
  assert.equal(pct(0.046), '4.6%', '4.6% no longer shows as 5%');
  assert.equal(pct(0.006), '0.6%', 'one decimal under 10%');
  assert.equal(pct(0.0004), 'under 0.1%');
  assert.equal(pct(0.25), '25%');
  assert.match(readFileSync(join(ASSETS, 'problems.js'), 'utf8'), /const \{ pct \} = HW;/, 'Problems uses the shared one');
  const search = readFileSync(join(ASSETS, 'search.js'), 'utf8');
  assert.match(search, /HW\.pct\(share\)/, 'Find uses the shared one');
  assert.doesNotMatch(search, /Math\.round\(share/, 'and no rounding of its own');
});

test('the Find cards claim no more than their lists hold', () => {
  const search = readFileSync(join(ASSETS, 'search.js'), 'utf8');
  // The server's recent list is every session in the window, so the heading can't say "in your repos".
  assert.doesNotMatch(search, /Recent in your repos/);
  assert.match(search, /Recent sessions<\/h2>/);
  assert.match(search, /const GROUP_NOTE = \{ display: 'display-only repo', outside: 'outside your config' \};/);
  const row = search.match(/function recentRow\(s, hidden\) \{[^]*?\n  \}/)[0];
  assert.match(row, /info\.repo \? esc\(info\.repo\) : '', GROUP_NOTE\[info\.group\] \?\? ''/, 'a recent session says its repo and its group');
  assert.match(row, /isMine\(g\) \? ` \$\{mineTag\}` : ''/, 'and keeps the tag on a goal I cited it in');
  // A closed result row still says a folded reason is ambiguous.
  assert.match(search, /refs\.slice\(1\)\.some\(\(r\) => r\.ambiguous\) \? ` \$\{chip\('ambiguous', 'one of the other reasons'\)\}`/);
  // The folded word search counts every kind of match, not prompts alone.
  assert.match(search, /<h2>Also mentioned in words<\/h2> <span class="hcount">\$\{plural\(wordsFound\(words\), 'match', 'matches'\)\}/);
  // The window isn't always a week.
  const problems = readFileSync(join(ASSETS, 'problems.js'), 'utf8');
  assert.doesNotMatch(problems, /this week/);
  assert.match(problems, /\['clear', `Not found in \$\{inWin\(\)\}`\]/);
  // While the rest of the window loads, the page speaks of the days in so far.
  assert.match(problems, /const inWin = \(\) => \(partial\(\) \? 'the days loaded so far' : 'this window'\);/);
});

test("a share rounds down on every page, and an estimate past the window's total never prints as a share", () => {
  const common = readFileSync(join(ASSETS, 'common.js'), 'utf8');
  const pct = runInNewContext(`(${common.match(/const pct = (\(x\) => [^\n]+);/)[1]})`);
  // Each of these would print as the line above it if the helper rounded to nearest.
  assert.equal(pct(0.0496), '4.9%', 'just under the 5% line');
  assert.equal(pct(0.00996), '0.9%', 'just under the 1% line');
  assert.equal(pct(0.0999), '9.9%');
  assert.equal(pct(0.249), '24%');
  assert.equal(pct(0.999), '99%', 'never 100% for less than all of it');
  // The two places the calmer pages added say so in words instead of printing a share over 100%.
  const search = readFileSync(join(ASSETS, 'search.js'), 'utf8');
  assert.match(search, /share > 1 \? "more than all the window's tokens" : `\$\{HW\.pct\(share\)\} of the window's tokens`/, 'the Find card');
  const problems = readFileSync(join(ASSETS, 'problems.js'), 'utf8');
  assert.match(problems, /const OVER = "more than all the window's tokens, since estimates for neighbouring steps overlap";/);
  const cost = problems.match(/function costHtml\(p\) \{[^]*?\n  \}/)[0];
  assert.match(cost, /const all = D\.coverage\?\.tokens\?\.value;/);
  assert.match(cost, /p\.tokens\.tokens > all \? `, \$\{OVER\}` : `, \$\{pct\(/, "a card's estimated cost");
});

// ---- before the first release: focus, wording that never over-claims, and the leak counter ----
test('closing the record panel never drops focus to the page: with no step or opener left, the nearest thing drawn', () => {
  const common = readFileSync(join(ASSETS, 'common.js'), 'utf8');
  const closeTarget = runInNewContext(`(${common.match(/const closeTarget = (\(back, byId, onPage, nearby\) => \{[^]*?\n  \});/)[1]})`);
  const marks = { a: { mark: 'a' }, c: { mark: 'c' } };
  const byId = (k) => marks[k] ?? null;
  const opener = { mark: 'opener' };
  const near = { mark: 'nearest' };
  const nearby = () => near;
  // After Next step: the step last shown, when it's drawn.
  assert.equal(closeTarget({ el: opener, id: 'c', preferId: true }, byId, () => true, nearby), marks.c);
  // Not drawn (a hidden kind), but the opener is still on the page.
  assert.equal(closeTarget({ el: opener, id: 'hidden', preferId: true }, byId, () => true, nearby), opener);
  // Opened from a mark, chart redrawn: the same step's new mark.
  assert.equal(closeTarget({ el: opener, id: 'a' }, byId, () => false, nearby), marks.a);
  // The case that dropped focus: the last step shown isn't drawn and the opener was redrawn away.
  assert.equal(closeTarget({ el: opener, id: 'hidden', preferId: true }, byId, () => false, nearby), near);
  assert.equal(closeTarget({ el: null, id: null }, byId, () => false, nearby), near);
  assert.equal(closeTarget(null, byId, () => false, () => null), null);
  // The panel uses it, and the fallback is the drawn step closest in time, then the chart, then the heading.
  assert.match(common, /const target = closeTarget\(back, byId, \(el\) => document\.contains\(el\), nearbyStep\);\s+if \(target && target !== document\.body\) target\.focus\(\);/);
  const nearbyStep = common.match(/function nearbyStep\(id\) \{[^]*?\n  \}/)[0];
  assert.match(nearbyStep, /#chart \.mark\[data-id\]/);
  assert.match(nearbyStep, /#chart \[tabindex="0"\]/);
  assert.match(nearbyStep, /h\.setAttribute\('tabindex', '-1'\)/);
});

test('"Show routine notes" is one quiet switch under the list, and it shows the routine rows the cards already hold', () => {
  const problems = readFileSync(join(ASSETS, 'problems.js'), 'utf8');
  assert.doesNotMatch(problems, /data-routine[^-]/, 'no second switch inside each card');
  // The switch redraws the cards, so "Show all N" counts only the rows in view.
  assert.match(problems, /routineShown = ev\.target\.checked;\s+renderLanding\(\);/);
  assert.match(problems, /cards\.classList\.toggle\('show-routine', routineShown\);/);
  // A routine note is a row of its own kind, hidden until the switch is on.
  assert.match(problems, /<li class="frow s-\$\{f\.severity === 'look' \? 'look' : 'note'\}"/);
  const css = readFileSync(join(ASSETS, 'problems.css'), 'utf8');
  assert.match(css, /\.frow\.s-note \{ display: none; \}/);
  assert.match(css, /\.show-routine \.frow\.s-note \{ display: flex; \}/);
  // The count beside the switch is of the routine notes found for the cards' rows.
  assert.match(problems, /Show routine notes \(\$\{full\(routine\)\} found\)/);
});

test('the Find cards: a capped list never says "all", and "Worth a look" lists only patterns with a finding worth a look', () => {
  const search = readFileSync(join(ASSETS, 'search.js'), 'utf8');
  assert.doesNotMatch(search, /See all \$\{recent\.length\}/, 'the server caps the recent list, so "all" could be untrue');
  assert.match(search, /`See the \$\{recent\.length\} most recent`/);
  assert.match(readFileSync(join(HERE, '..', 'lib', 'view', 'data.mjs'), 'utf8'), /\.slice\(0, 12\)\s+\.map\(\(s\) => \(\{ \.\.\.sessionRow/, 'the cap this wording answers');
  assert.match(search, /const top = live\.filter\(\(p\) => Number\(p\.look\) > 0\)\.sort\(cmp\)\.slice\(0, 3\);/);
  assert.match(search, /The checks found only routine notes in this window, nothing worth a look\./);
  // "My priority" set in another tab reaches this card and the header's count.
  assert.match(search, /prefs\.onChange\(fillLook\);/);
  assert.match(readFileSync(join(ASSETS, 'common.js'), 'utf8'), /navPrefs\.onChange\(\(\) => navPatterns && navCount\(navPatterns\)\);/);
});

test('with no session to check, the Problems page and the Find card say nothing was checked', () => {
  const problems = readFileSync(join(ASSETS, 'problems.js'), 'utf8');
  assert.match(problems, /const nothing = Number\(num\(cov\.sessions\)\) === 0 && n === 0;/);
  assert.match(problems, /No session with a record in \$\{inWin\(\)\} \$\{lvl\}, so nothing was checked/);
  assert.match(problems, /unchecked: \{ icon: '○', word: 'Not checked' \}/);
  assert.match(problems, /\(p\.measures \?\? \[\]\)\.length \? 'not checked' : 'no check here yet'/, 'a pattern whose check did not run is not "no check here yet"');
  const search = readFileSync(join(ASSETS, 'search.js'), 'utf8');
  assert.match(search, /const nothing = Number\(num\(a\.coverage\?\.sessions\)\) === 0 && !found\.length;/);
  assert.match(search, /No session in this window to check, so this says nothing about problems\./);
});

test("the leak counter: a cut mark with a closing quote glued to it is the page's own mark; a secret in that spot still counts", () => {
  const leaks = createLeakCounter({});
  const total = (s) => [leaks.redacted(s).total, leaks.secrets(s).total];
  for (const s of ['add a --token-file …', 'add a --token-file …"', '"add a --token-file …"', 'add a --token-file ..."', 'password=…")', 'add a --token-file …" ']) assert.deepEqual(total(s), [0, 0], s);
  // Failing partners: a value glued to the mark on either side, or after it, is still a leak.
  for (const s of ['add a --token-file 7Qx2mK9pLw4ZtR8vN3bY…"', 'add a --token-file …7Qx2mK9pLw4ZtR8vN3bY"', 'password=hunter2hunter2…"', 'token: …" 7Qx2mK9pLw4ZtR8vN3bY', 'password=…" password=hunter2hunter2']) assert.deepEqual(total(s), [1, 1], s);
});

test('the README names the first page Find, as the page does, and counts four pages', () => {
  const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /\*Search\.\*|three parts: Search/);
  assert.match(readme, /four parts: Find \(/);
  assert.match(readme, /- \*Find\.\* Type a pull request/);
  for (const p of PAGES) assert.match(readFileSync(join(ASSETS, p), 'utf8'), />Find<\/a>/, `${p}: the header calls it Find`);
});

test("Replay's story never hides a failed test run in a group, and every grouped step keeps its mark", () => {
  const replay = readFileSync(join(ASSETS, 'replay.js'), 'utf8');
  // A failed run stands alone, the way a step with a finding does.
  assert.match(replay, /const standsAlone = \(e\) => F\.flags\.has\(e\.id\) \|\| RM\.isLongWait\(e\) \|\| !!resultOf\(e\)\?\.fail;/);
  // An opened group's rows show each step's result and how it's known (in the problem focus's
  // list, "See in the whole session" follows the row's button).
  assert.match(replay, /<\/code>\$\{kidRes\(e\)\} \$\{sym\(e\.ev\)\}<\/button>\$\{wholeLink\(e\)\}<\/li>/);
  // The count worth a look carries its weakest mark and says how many of them are only possible.
  assert.match(replay, /worth a look \$\{sym\(window\.HWE\.weakest\(c\.levels\)\)\}/);
  assert.match(replay, /\$\{c\.possible\} of them possible/);
});

test('a page with no working key offers no link back into the pages, since each would only lead to the same notice', () => {
  const common = readFileSync(join(ASSETS, 'common.js'), 'utf8');
  assert.doesNotMatch(common, /Back to search/);
  // Every key notice (no key, a refused key, a stopped server) is drawn keyless; other errors keep a link home.
  const calls = [...common.matchAll(/fatal\(noticeHtml\([^)]*\)([^;]*);/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4 && calls.every((rest) => /\{ keyless: true \}/.test(rest)), 'every key notice is keyless');
  assert.match(common, /keyless \? '' : ' <p><a href="problems\.html">Back to Problems<\/a><\/p>'/);
});

test('the goals page says goal discovery is coming, beside its title, on the page and not in a script', () => {
  const html = readFileSync(join(ASSETS, 'goal.html'), 'utf8');
  assert.match(html, /<div class="pagehead">\s*<h1 class="ph-title">[^]*?<\/h1>\s*<span class="tag" id="soon">Coming soon: Goal discovery<\/span>/);
});

test("Settings reads the long-session limit as typed: empty is off, 150k and 150,000 are numbers, the rest goes to the server", () => {
  const js = readFileSync(join(ASSETS, 'settings.js'), 'utf8');
  const src = /function tokensOf\(text\) \{[^]*?\n {2}\}/.exec(js)?.[0];
  assert.ok(src, 'settings.js: tokensOf');
  const tokensOf = runInNewContext(`(${src})`);
  assert.equal(tokensOf(''), null);
  assert.equal(tokensOf('   '), null);
  for (const t of ['150000', '150,000', '150k', '150K', ' 150_000 ']) assert.equal(tokensOf(t), 150000, t);
  // The page shows a saved limit as 150,000, so saving another field sends the same number back.
  assert.equal(tokensOf((150000).toLocaleString('en-US')), 150000);
  for (const t of ['lots', '1.5e5', '-5']) assert.equal(tokensOf(t), t, t);
});

test("Replay's story draws a few prompt cards around the selected step, never a long session whole", () => {
  const js = readFileSync(join(ASSETS, 'replay.js'), 'utf8');
  const consts = js.match(/ {2}const CARDS_ALL = [^]*?let storyWin = null;[^\n]*\n/)[0];
  const fn = js.match(/ {2}function windowFor\(c\) \{[^]*?\n {2}\}/)[0];
  const box = {};
  runInNewContext(`let story;\n${consts}${fn}\nthis.win = (n, c, prev = null) => { story = { cards: new Array(n).fill(0) }; storyWin = prev; return windowFor(c); };`, box);
  const w = (n, c, prev) => ({ ...box.win(n, c, prev) });
  assert.deepEqual(w(5, 2), { from: 0, to: 4 }, 'a few prompts: all of them');
  assert.deepEqual(w(72, 0), { from: 0, to: 1 });
  assert.deepEqual(w(72, 71), { from: 70, to: 71 });
  assert.deepEqual(w(72, 30), { from: 29, to: 31 }, 'one card on each side');
  assert.deepEqual(w(72, undefined), { from: 70, to: 71 }, 'no selection: the latest');
  assert.deepEqual(w(72, 33, { from: 29, to: 37 }), { from: 29, to: 37 }, 'cards the reader asked for stay while the selection is among them');
  assert.deepEqual(w(72, 50, { from: 29, to: 37 }), { from: 49, to: 51 }, 'a selection elsewhere moves the window');
  // A long card draws its first rows and asks before the rest; the selected row is always drawn.
  assert.match(js, /const cut = c\.rows\.length > ROWS_ALL && !openCards\.has\(i\);/);
  assert.match(js, /if \(!row && at && storyWin && !focusList\(\)\) \{/);
});

test('Replay names what came just before the selected step: its lane\'s step before, or the call that started a helper', () => {
  const js = readFileSync(join(ASSETS, 'replay.js'), 'utf8');
  const prior = js.match(/ {2}function priorOf\(e\) \{[^]*?\n {2}\}/)[0];
  const starter = js.match(/ {2}const starterOf = \(agent\) => \{[^]*?\n {2}\};/)[0];
  const ev = (id, agent, t) => ({ id, agent, t });
  const call = ev('call', 'main', 5);
  const steps = [ev('p', 'main', 1), call, ev('i', 'helper', 6), ev('a', 'helper', 8), ev('m', 'main', 9), ev('b', 'helper', 10)];
  const HW = { data: { byId: new Map([...steps, call].map((s) => [s.id, s])), agentByKey: new Map([['helper', { spawnedBy: 'call' }], ['lonely', { spawnedBy: null }]]) } };
  const box = { steps, HW };
  runInNewContext(`${starter}\n${prior}\nthis.prior = (id) => { const e = HW.data.byId.get(id) ?? { id, agent: id.split(':')[0], t: 99 }; const p = priorOf(e); return p ? [p.step.id, p.how].join(' ') : null; };`, box);
  assert.equal(box.prior('b'), 'a before', "the step before in the helper's own lane, past the parent's step between");
  assert.equal(box.prior('a'), 'i before', "the helper's opening record");
  assert.equal(box.prior('i'), 'call started', 'its first record: the call that started it');
  assert.equal(box.prior('p'), null, 'the first step of the main lane has nothing before it');
  assert.equal(box.prior('lonely:x'), null, 'a helper the logs never say started has none');
  // Clicking one widens the zoom just enough to hold it, and ◀ Step goes on past a focus's first step.
  assert.match(js, /if \(s\.t < view\[0\] \|\| s\.t > view\[1\]\) \{/);
  assert.match(js, /const e = dir < 0 && Z && list === navSteps \? HW\.data\.byId\.get\(selId\) : null;/);
  assert.match(readFileSync(join(ASSETS, 'replay.html'), 'utf8'), /<span class="rp-now-before" id="nowBefore"><\/span>/);
});

// ---- Replay's starting list ------------------------------------------------------------------

/** A stand-in for anything the pages touch that these tests don't read: every property and call
 *  gives it back, so a script runs to the part under test. */
const ANY = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator] : k === 'then' ? undefined : ANY), apply: () => ANY, construct: () => ANY, set: () => true });

/** The replay page's scripts run at `href` with a stand-in document: evidence.js, common.js,
 *  sessions.js and replay.js as replay.html loads them. `answers(route, q)` answers HW.load; the
 *  page's elements by id are plain objects, kept in `els`. */
function replayPage(href, answers = () => ({})) {
  const url = new URL(href, 'http://127.0.0.1:1/');
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', hidden: false, dataset: {}, removed: false, listeners: [], remove() { this.removed = true; }, addEventListener(type, fn) { this.listeners.push([type, fn]); }, querySelector: () => null, querySelectorAll: () => [], classList: ANY, setAttribute() {}, closest: () => null, insertAdjacentHTML() {} });
    return els.get(id);
  };
  const document = new Proxy({ getElementById: el, querySelector: (sel) => (sel === '[data-fatal]' ? el('fatal') : ANY), querySelectorAll: () => [], body: { dataset: {} }, readyState: 'complete', addEventListener() {}, createElement: () => ANY, documentElement: ANY }, { get: (t, k) => (k in t ? t[k] : ANY) });
  const box = { document, location: { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash }, history: ANY, URLSearchParams, CSS: { escape: (s) => s }, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0, matchMedia: () => ANY, getComputedStyle: () => ANY, ResizeObserver: function () { return ANY; }, navigator: ANY, console };
  box.window = box;
  box.HWP = ANY;
  box.addEventListener = () => {};
  for (const f of ['evidence.js', 'common.js', 'sessions.js']) runInNewContext(readFileSync(join(ASSETS, f), 'utf8'), box);
  const calls = { load: [], shown: 0, run: null };
  box.HW.load = async (route, q = {}) => {
    calls.load.push([route, { ...q }]);
    return answers(route, q);
  };
  box.HW.start = (fn) => {
    calls.run = fn;
  };
  const show = box.HWSessions.show;
  box.HWSessions = { show: () => ((calls.shown += 1), show()) };
  runInNewContext(readFileSync(join(ASSETS, 'replay.js'), 'utf8'), box);
  return { box, els, calls };
}

test("Replay with nothing chosen opens the list of the window's sessions; a chosen thread or session, or an old #thread address, opens its replay", async () => {
  const stop = () => {
    throw Object.assign(new Error('the test stops here'), { code: 'stop' });
  };
  for (const href of ['replay.html', 'replay.html#', 'replay.html#not-an-id', 'replay.html?session=../x']) {
    const p = replayPage(href, (route) => (route === 'sessions' ? { days: [], empty: 'Nothing here.' } : stop()));
    await p.calls.run();
    assert.equal(p.calls.shown, 1, `${href}: the list`);
    assert.deepEqual(p.calls.load, [['sessions', {}]], `${href}: asks only for the list, never the most recent thread`);
  }
  const opened = {
    'replay.html#th-abcd': { thread: 'th-abcd' },
    'replay.html#th-abcd~zoom~pf-abcdabcdabcd': { thread: 'th-abcd' },
    'replay.html#th-abcd~cc-abcd.1.0': { thread: 'th-abcd' },
    'replay.html?session=cc-abcdabcd': { session: 'cc-abcdabcd' },
    'replay.html?session=cc-abcdabcd#th-abcd': { thread: 'th-abcd' },
  };
  for (const [href, q] of Object.entries(opened)) {
    const p = replayPage(href, stop);
    await assert.rejects(p.calls.run(), /the test stops here/);
    assert.equal(p.calls.shown, 0, `${href}: no list`);
    assert.deepEqual(p.calls.load, [['replay', q]], `${href}: loads its replay directly`);
  }
  // Every replay has the way back, in the page head and in a problem's focus.
  const html = readFileSync(join(ASSETS, 'replay.html'), 'utf8');
  assert.match(html, /<p class="rp-meta"><a class="rp-back" id="allSessions" href="replay\.html">← All sessions<\/a>/);
  assert.match(readFileSync(join(ASSETS, 'replay.js'), 'utf8'), /<a class="fall" href="replay\.html">All sessions<\/a><button type="button" class="fleave"/);
  // Find's Recent card links to the whole list, and stays five rows long.
  const search = readFileSync(join(ASSETS, 'search.js'), 'utf8');
  assert.match(search, /<a href="replay\.html" id="allSessions">All sessions<\/a>/);
  assert.match(search, /const SHOW_RECENT = 5;/);
});

test('the sessions list draws each day with a few rows, says when a session is display-only or outside, and offers a page more at a time', async () => {
  const row = (session, extra = {}) => ({ session, thread: 'th-abcd', tool: 'claude-code', repo: 'your-project', group: 'configured', title: `Title ${session}`, firstAt: '2025-03-15T14:20:05.000Z', lastAt: '2025-03-15T14:47:48.000Z', startedBy: null, evidence: 'recorded', length: { value: 1663000, evidence: 'derived' }, prompts: { value: 3, evidence: 'derived' }, problems: { value: 2, evidence: 'inferred' }, ...extra });
  const list = {
    timezone: 'UTC',
    total: { value: 30, evidence: 'derived' },
    page: 20,
    days: [
      { day: '2025-03-15', evidence: 'derived', count: { value: 27, evidence: 'derived' }, more: { value: 25, evidence: 'derived' }, rows: [row('cc-aaaa'), row('cc-bbbb', { group: 'display', repo: 'your-site', problems: null, title: 'Draft a post about [redacted:term]' })] },
      { day: '2025-03-14', evidence: 'derived', count: { value: 3, evidence: 'derived' }, more: { value: 0, evidence: 'derived' }, rows: [row('cx-cccc', { tool: 'codex', group: 'outside', repo: null, problems: null, prompts: { value: 0, evidence: 'derived' }, startedBy: { text: 'started by codex exec, no prompt', evidence: 'recorded' } })] },
    ],
    older: { before: '2025-03-14', days: { value: 2, evidence: 'derived' } },
  };
  const p = replayPage('replay.html', (route) => (route === 'sessions' ? list : {}));
  await p.calls.run();
  const content = p.els.get('content').innerHTML;
  assert.equal(p.els.get('title').textContent, 'Sessions');
  assert.ok(p.els.get('allSessions').removed, 'the list has no link to itself');
  assert.match(content, /<h2 id="day-2025-03-15">Sat, Mar 15<\/h2>/);
  assert.match(content, /<a class="t" href="replay\.html\?session=cc-aaaa#th-abcd">Title cc-aaaa<\/a>/);
  assert.match(content, /2:20 PM[^]*28 min[^]*Claude Code · your-project · 3 prompts[^]*<a href="problems\.html\?session=cc-aaaa">2 problems worth a look<\/a>/);
  assert.match(content, /Draft a post about \[redacted:term\][^]*your-site · display-only repo/, 'a display-only session says so, as Find does');
  assert.match(content, /Codex · outside your config · started by codex exec, no prompt/, 'an outside session says so; no prompt says what opened it');
  assert.equal((content.match(/worth a look/g) ?? []).length, 1, 'no count for a session the checks never read');
  assert.match(content, /<button type="button" class="linklike" data-more="2025-03-15" data-shown="2">Show 20 more<\/button>/, 'a page more, never the whole rest');
  assert.doesNotMatch(content, /data-more="2025-03-14"/, 'a day all shown offers nothing more');
  assert.match(content, /data-older="2025-03-14">Show earlier days \(2 more days\)<\/button>/);
  // Ids only, never a title, in every address the list builds.
  for (const m of content.matchAll(/href="([^"]+)"/g)) assert.match(m[1], /^(replay|problems)\.html(\?session=[a-z]{2,4}-[a-p]+)?(#th-[a-p]+)?$/, m[1]);
  // An empty window: the page says so and points to search, as Replay always has.
  const none = replayPage('replay.html', () => ({ days: [], empty: 'Nothing.' }));
  await none.calls.run();
  assert.match(none.els.get('content').innerHTML, /data-fatal="1">Nothing [^]*<a href="search\.html">Search<\/a> for a session to replay/);
  assert.equal(none.els.get('fatal').dataset.fatal, 'no-thread');
  assert.ok(none.els.get('allSessions').removed, 'an empty list has no link to itself either');
});

test('the sessions list names the year on each day when the window spans more than one calendar year', async () => {
  const day = (d) => ({ day: d, evidence: 'derived', count: { value: 1, evidence: 'derived' }, more: { value: 0, evidence: 'derived' }, rows: [] });
  const draw = async (extra) => {
    const p = replayPage('replay.html', (route) => (route === 'sessions' ? { timezone: 'UTC', total: { value: 2, evidence: 'derived' }, page: 20, days: [day('2026-01-05'), day('2025-01-06')], older: null, ...extra } : {}));
    await p.calls.run();
    return p.els.get('content').innerHTML;
  };
  const spanning = await draw({ spansYears: true });
  assert.match(spanning, /<h2 id="day-2026-01-05">Mon, Jan 5, 2026<\/h2>/);
  assert.match(spanning, /<h2 id="day-2025-01-06">Mon, Jan 6, 2025<\/h2>/);
  // Without the flag, as before: no year.
  assert.match(await draw({}), /<h2 id="day-2026-01-05">Mon, Jan 5<\/h2>/);
});
