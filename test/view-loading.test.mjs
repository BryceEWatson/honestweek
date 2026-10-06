// What a page shows while `honestweek view` loads: the header's date box ("Oct 6 so far", never
// "Oct 6 to 6"), one loading line with friendly dates (this page's build, then the rest of the
// window), the details behind its "?", and a quiet "Checking…" where a section is still being
// checked, never an empty heading that reads as "nothing found".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ASSETS = fileURLToPath(new URL('../lib/view/assets/', import.meta.url));
const asset = (name) => readFileSync(join(ASSETS, name), 'utf8');
const ISO = /\d{4}-\d{2}-\d{2}/;
// A day's number followed by "to" and a bare number: "Oct 6 to 6".
const REPEAT = /\b[A-Z][a-z]{2} \d+ to \d+\b/;

// ---- a small DOM: enough for the page shell's loading lines --------------------------------
class Node {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.dataset = {};
    this.raw = null;
    const self = this;
    this.classList = {
      toggle(c, on) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        if (on) set.add(c);
        else set.delete(c);
        self.className = [...set].join(' ');
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  get id() {
    return this.attrs.get('id') ?? '';
  }
  set id(v) {
    this.attrs.set('id', v);
  }
  get className() {
    return this.attrs.get('class') ?? '';
  }
  set className(v) {
    this.attrs.set('class', v);
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  get textContent() {
    return this.raw !== null ? this.raw.replace(/<[^>]*>/g, '') : this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    this.children = v ? [String(v)] : [];
    this.raw = null;
  }
  get innerHTML() {
    return this.raw ?? this.textContent;
  }
  set innerHTML(v) {
    this.children = [];
    this.raw = String(v);
  }
  append(...nodes) {
    this.raw = null;
    for (const n of nodes) {
      if (typeof n !== 'string') n.parent = this;
      this.children.push(n);
    }
  }
  after(n) {
    const sib = this.parent.children;
    n.parent = this.parent;
    sib.splice(sib.indexOf(this) + 1, 0, n);
  }
  *walk() {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      yield c;
      yield* c.walk();
    }
  }
  matches(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    const m = sel.match(/^\[([\w-]+)\]$/);
    return !!m && this.attrs.has(m[1]);
  }
  querySelector(sel) {
    for (const n of this.walk()) if (n.matches(sel)) return n;
    return null;
  }
}

/** The page shell's top: the date box, the demo line and the status line, with common.js loaded. */
function page({ timezone = 'UTC' } = {}) {
  const doc = { createElement: (t) => new Node(t, doc) };
  const body = new Node('body', doc);
  for (const id of ['window', 'demo', 'status']) {
    const n = new Node(id === 'window' ? 'span' : 'p', doc);
    n.id = id;
    body.append(n);
  }
  doc.body = body;
  doc.getElementById = (id) => body.querySelector(`#${id}`);
  const reloads = [];
  const sandbox = {
    window: { HWE: { chips: () => '' }, HWP: { api: () => new Promise(() => {}) } },
    document: doc,
    location: { reload: () => reloads.push(1) },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  runInNewContext(asset('common.js'), sandbox);
  const HW = sandbox.window.HW;
  HW.setTimezone(timezone);
  const $ = (id) => doc.getElementById(id);
  // The lines under the header someone reads: shown, with words in them.
  const lines = () => body.children.filter((n) => typeof n !== 'string' && n.id !== 'window' && !n.hidden && n.textContent.trim()).map((n) => n.id);
  return { HW, $, lines, reloads };
}

const TODAY = '2026-10-06';
const WEEK = { from: '2026-09-30', to: TODAY };
const partial = (extra = {}) => ({ from: TODAY, to: TODAY, timezone: 'UTC', partial: { from: WEEK.from, to: WEEK.to, rest: { from: WEEK.from, to: '2026-10-05' }, read: null, total: null, elapsedMs: null, failed: null, ...extra } });

test('the date box: one day reads "Oct 6", a range "Sep 30 to Oct 6"; "so far" while the rest loads, "only" when it couldn\'t', () => {
  const { HW } = page();
  const at = { today: TODAY };
  const box = (w) => HW.windowShort(w, at);
  // One day, complete and partial.
  assert.equal(box({ from: TODAY, to: TODAY }), 'Oct 6');
  assert.equal(box(partial()), 'Oct 6 so far');
  assert.equal(box(partial({ failed: 'the disk went away' })), 'Oct 6 only');
  // A range, complete and partial (the newest days in).
  assert.equal(box(WEEK), 'Sep 30 to Oct 6');
  assert.equal(box({ from: '2026-10-01', to: TODAY }), 'Oct 1 to Oct 6');
  assert.equal(box({ ...partial(), from: '2026-10-04' }), 'Oct 4 to Oct 6 so far');
  // The year shows only when the days aren't in this one.
  assert.equal(box({ from: '2025-03-10', to: '2025-03-16' }), 'Mar 10 to Mar 16, 2025');
  assert.equal(box({ from: '2025-03-16', to: '2025-03-16' }), 'Mar 16, 2025');
  assert.equal(box({ from: '2025-12-29', to: '2026-01-04' }), 'Dec 29, 2025 to Jan 4, 2026');
  for (const w of [{ from: TODAY, to: TODAY }, partial(), WEEK, { from: '2026-10-01', to: TODAY }, { from: '2025-03-10', to: '2025-03-16' }]) {
    assert.doesNotMatch(box(w), REPEAT, JSON.stringify(w));
    assert.doesNotMatch(box(w), ISO, JSON.stringify(w));
  }
  // The long form, for a one-day window, names the day once.
  assert.equal(HW.windowText({ from: TODAY, to: TODAY }), 'Tue, Oct 6, 2026');
  assert.equal(HW.windowText(WEEK), 'Wed, Sep 30 to Tue, Oct 6, 2026');
  // A server note's dates read the same way.
  assert.equal(HW.friendlyDates('Loaded 2026-10-03 to 2026-10-06: all of 2026-09-30 to 2026-10-06 needs more memory.', at), 'Loaded Oct 3 to Oct 6: all of Sep 30 to Oct 6 needs more memory.');
  assert.equal(HW.friendlyDates('The 7 days before: only 2026-09-29 so far.', at), 'The 7 days before: only Sep 29 so far.');
});

test('the loading line\'s words: short, friendly dates, the details behind its "?"', () => {
  const { HW } = page();
  const say = (s) => HW.loadText({ today: TODAY, ...s });
  // The page's own build: today's first, any other day or range by its dates, the demo by name.
  assert.deepEqual([say({ phase: 'reading', window: partial(), secs: 16 }).text, say({ phase: 'reading', window: partial(), secs: 16 }).secs], ["Reading today's sessions…", 16]);
  assert.equal(say({ phase: 'reading', window: { from: '2026-10-05', to: '2026-10-05' } }).text, 'Reading Oct 5…');
  assert.equal(say({ phase: 'reading', window: WEEK }).text, 'Reading Sep 30 to Oct 6…');
  assert.equal(say({ phase: 'reading', window: { from: '2025-03-10', to: '2025-03-16' }, demo: true }).text, 'Reading the demo week…');
  assert.equal(say({ phase: 'reading' }).text, 'Reading your sessions…');
  assert.match(say({ phase: 'reading', window: partial() }).more, /into this program's memory and saves nothing.*Then the rest of Sep 30 to Oct 6 loads behind it\./);
  // The rest of the window, behind a page that's already drawn: its days, and how long so far.
  const rest = say({ phase: 'rest', window: partial({ elapsedMs: 41_400, read: 120, total: 900 }) });
  assert.deepEqual([rest.text, rest.secs], ['Reading Sep 30 to Oct 5…', 41]);
  assert.equal(rest.more, '120 of 900 log files read. Until every day is in, each count here covers Oct 6 only. The page updates by itself when the rest is in.');
  // A window cut to fit memory: the rest reads only the days that fit.
  assert.equal(say({ phase: 'rest', window: partial({ rest: { from: '2026-10-03', to: '2026-10-05' } }) }).text, 'Reading Oct 3 to Oct 5…');
  // The rest couldn't be loaded: said once, the reason behind the "?".
  const failed = say({ phase: 'rest', window: partial({ failed: 'the disk went away' }) });
  assert.deepEqual([failed.text, failed.failed, failed.secs], ["Sep 30 to Oct 5 couldn't be loaded.", true, null]);
  assert.match(failed.more, /^the disk went away\. Every count here covers Oct 6 only\./);
  assert.equal(say({ phase: 'private', secs: 5 }).text, 'Building private text…');
  assert.equal(say({ phase: 'connecting' }).text, 'Connecting…');
  // Nothing loading: no line.
  assert.equal(say({ phase: 'rest', window: WEEK }), null);
  // Short enough to read at a glance, with no ISO date anywhere a person reads.
  for (const s of [{ phase: 'reading', window: partial() }, { phase: 'reading', window: WEEK }, { phase: 'rest', window: partial({ elapsedMs: 1000 }) }, { phase: 'rest', window: partial({ failed: 'no room' }) }, { phase: 'private' }, { phase: 'connecting' }]) {
    const l = say(s);
    assert.ok(l.text.split(' ').length <= 8, `"${l.text}" is short`);
    assert.doesNotMatch(`${l.text} ${l.more}`, ISO, s.phase);
    assert.doesNotMatch(`${l.text} ${l.more}`, REPEAT, s.phase);
  }
});

test('one loading line: the page\'s build, then the rest of the window, in the same place; no "only this day" bar', () => {
  const { HW, $, lines } = page();
  HW.shell.waiting = true;
  HW.showLoad({ phase: 'connecting' });
  assert.deepEqual(lines(), ['loadline']);
  const line = $('loadline');
  const words = () => line.querySelector('[data-load-text]').textContent;
  const secs = () => line.querySelector('[data-load-secs]').textContent;
  assert.equal(words(), 'Connecting…');

  // Waiting on its own build: the status answer's window doesn't add a second line.
  HW.showWindow(partial());
  HW.showLoad({ phase: 'reading', window: HW.shell.window, secs: 16 });
  assert.deepEqual(lines(), ['loadline'], 'one line while the first day is read');
  assert.equal($('loadline'), line, 'the same line, changed in place');
  assert.match(words(), /^Reading (today's sessions|Oct 6)…$/);
  assert.equal(secs(), '16 s');
  assert.match($('window').textContent, /Oct 6 so far$/);
  assert.doesNotMatch($('window').textContent, REPEAT);

  // The page is drawn: the same line now says how the rest is going; still one line.
  HW.shell.waiting = false;
  HW.showLoad(null);
  HW.showWindow(partial({ elapsedMs: 41_000, read: 3, total: 9 }));
  assert.deepEqual(lines(), ['loadline']);
  assert.equal($('loadline'), line);
  assert.equal(words(), 'Reading Sep 30 to Oct 5…');
  assert.equal(secs(), '41 s');
  assert.equal($('windownote'), null, 'no "Only Oct 6 so far" bar while the rest loads');
  assert.equal(line.querySelector('[data-load-more]').textContent.startsWith('3 of 9 log files read.'), true);

  // A page that stops on a message (no goal list, say) keeps the rest's line; one that stops
  // while it waits for its own build drops the wait.
  HW.fatal('No goal list is set.');
  assert.deepEqual(lines(), ['loadline']);
  const stopped = page();
  stopped.HW.showLoad({ phase: 'connecting' });
  stopped.HW.fatal("This page can't get data from honestweek view.");
  assert.deepEqual(stopped.lines(), []);

  // The rest couldn't be loaded: the same line says so, no spinner.
  HW.showWindow(partial({ failed: 'no room' }));
  assert.equal(words(), "Sep 30 to Oct 5 couldn't be loaded.");
  assert.equal(line.querySelector('.spin').hidden, true);
  assert.equal(line.classList.contains('bad'), true);
});

test('a window cut to fit is one quiet line with friendly dates, the why behind its "?"; a whole window has no line', () => {
  const { HW, $, lines } = page();
  HW.showWindow({ from: '2026-10-03', to: TODAY, timezone: 'UTC', note: 'Loaded 2026-10-03 to 2026-10-06: all of 2026-09-30 to 2026-10-06 (1.2 GB of logs) needs more memory than this process has left (900 MB).' });
  assert.deepEqual(lines(), ['windownote']);
  const note = $('windownote').innerHTML;
  assert.match(note, /^Only Oct 3 to Oct 6 loaded\. <details class="help inline">/);
  assert.match(note, /Loaded Oct 3 to Oct 6: all of Sep 30 to Oct 6 \(1\.2 GB of logs\)/);
  assert.doesNotMatch(note, ISO);
  const { HW: HW2, lines: lines2 } = page();
  HW2.showWindow({ ...WEEK, timezone: 'UTC' });
  assert.deepEqual(lines2(), []);
});

test('a section still being checked says "Checking…" in place, never an empty heading', () => {
  // Problems: "Found in the log" holds a "Checking…" line until its cards are drawn; "Possible"
  // and the filter stay hidden until there's something to show.
  const html = asset('problems.html');
  const sure = html.match(/<section class="psec" id="sureSec"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(sure && !/\bhidden\b/.test(sure[0].split('>')[0]), 'Found in the log shows from the start');
  assert.match(sure[1], /<div id="cards"><p class="checking"><span class="spin" aria-hidden="true"><\/span>Checking…<\/p><\/div>/);
  assert.match(sure[1], /<details class="pfilter" id="filterBox" hidden>/);
  assert.match(html, /<section class="psec" id="possSec" aria-labelledby="possH" hidden>/);
  // Every section heading the landing shows at once has its "Checking…" line or is hidden.
  for (const m of html.matchAll(/<section class="psec"[^>]*>[\s\S]*?<\/section>/g)) {
    assert.ok(/^<section[^>]*\bhidden\b/.test(m[0]) || m[0].includes('class="checking"'), m[0].slice(0, 80));
  }
  const problems = asset('problems.js');
  assert.match(problems, /\$\('filterBox'\)\.hidden = false;/);
  assert.match(problems, /\$\('possSec'\)\.hidden = !possible\.length;/);
  // Replay with nothing chosen is the sessions list: its heading and "Checking…", not an empty replay.
  const replay = asset('replay.js');
  assert.ok(replay.indexOf('window.HWSessions.waiting?.()') < replay.indexOf('HW.start('), 'the list says so before the wait');
  const sessions = asset('sessions.js');
  assert.match(sessions, /function waiting\(\) \{[\s\S]*?\$\('title'\)\.textContent = 'Sessions';[\s\S]*?class="checking"><span class="spin" aria-hidden="true"><\/span>Checking…/);
  // Goals: the picker and its line say "Checking…" until the goals are read.
  const goal = asset('goal.html');
  assert.match(goal, /<select id="goal"><option value="">Checking…<\/option><\/select>/);
  assert.match(goal, /<span class="meta" id="goalMeta"><span class="spin" aria-hidden="true"><\/span>Checking…<\/span>/);
  // No page keeps the old bars' words.
  const common = asset('common.js');
  assert.doesNotMatch(common, /into this program's memory: \$\{p\.secs\} s so far/);
  assert.doesNotMatch(common, /Connecting to honestweek view\. If it's still reading/);
});
