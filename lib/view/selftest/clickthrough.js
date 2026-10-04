// Click-through test for the search, goal, replay and problems pages of `honestweek view`, and the
// "Worth a look" strip. It opens each page in a frame on this same server, drives it with real DOM
// events (clicks, typing, keys, focus), and lists every step as PASS, FAIL or SKIP with a short detail.
//
// A step may skip only for a reason on the named list below (SKIPS); a skip for any other
// reason counts as a failure. Each frame's errors, console errors and content-policy
// violations fail the step that caused them. The search words come from the server, and the
// test checks that no typed word, reference text, goal id or title ever reaches the address.
// Text the pages show is checked by the server's leak counter (/api/leak-check), which answers
// with counts only. "Show private text" is put back the way it was when the run ends.
(function () {
  'use strict';
  // ---- the steps allowed to skip: each can't apply to some data. On the demo week only the
  // ones in DEMO_SKIPS may skip: the demo holds every other case on purpose, so a skip there
  // means the step broke, and it fails. The pull request quotes both lists. ------------------
  const SKIPS = {
    'no-goal-list': "this run has no goal list, so the goal page shows its empty state instead of goals",
    'no-pr': 'no session in this window links a pull request',
    'no-commit': 'no example commit in this window',
    'no-squash': 'no example commit is a squash merge of a pull request',
    'no-file': 'no example file in this window',
    'no-branch': 'no branch is recorded in this window',
    'no-word': 'the server offered no search word',
    'no-display-session': 'no display-only session in this window matches the search words',
    'no-outside-session': 'no session outside the configured repos in this window matches the search words',
    'single-session': 'no thread in this window holds more than one session',
    'no-gaps': 'no goal in this window has a gap of over 30 minutes',
    'nothing-in-progress': 'nothing is ever in progress in this replay, so the side panel lists no record',
    'short-span': 'the whole span is shorter than the smallest zoom, so no zoom narrows it',
    'no-turns': 'this replay has no turns',
    'no-inferred-author': 'no prompt in these replays has an author only inferred by rule',
    'no-script-prompt': 'no prompt in these replays comes from a non-interactive run',
    'no-borrowed-time': 'no step in these replays borrows its time from a neighbouring line',
    'no-moved-time': 'no sub-agent step in these replays was moved after the call that started it',
    'no-command-step': 'no replay here has a command step',
    'no-prompt': 'no replay here has a prompt',
    'built-before-test': 'the data was already built when the test started, so no page had to wait for it',
    'private-words-set': 'the config lists private words (the demo week always has one), so no page needs the notice',
    'goal-list-set': 'this run has a goal list, so the goals page shows goals instead of its empty state',
    'no-problem-found': 'no known problem was found in this window, so no card lists a finding',
    'no-routine-note': 'no pattern found in this window has a routine note beside its findings',
    'no-strip-finding': 'no replayable session in this window has a finding for the strip',
    'no-crowded-marks': 'no two findings in these replays sit close enough to merge into a count',
    'already-set-up': 'this folder already had its config when honestweek view started, so there was nothing to set up',
    'no-settings': 'the demo week has no config of its own to change',
  };
  /** The only skips the demo week allows, each with why its case can't occur there. */
  const DEMO_SKIPS = {
    'built-before-test': 'a timing case, not a data one: the demo can finish building before the test page opens',
    'already-set-up': 'the demo week comes with its own config, so it never needs setup',
    'no-settings': 'the demo week has no config of its own to change',
    'private-words-set': 'the demo always lists one private word, so no page needs the notice',
    'goal-list-set': 'the demo always comes with its goal list, so the goals page never shows its empty state',
  };
  const params = new URLSearchParams(location.search);
  const ONLY = params.get('only');
  const WANT = params.get('private');
  const DESKTOP = { width: 1280, height: 900 };
  const PHONE = { width: 375, height: 740 };
  const BUILD_MS = 300e3;
  const PAGES = ['search.html', 'goal.html', 'replay.html', 'problems.html'];
  const PREFS_SLOT = 'hw.prefs';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const secs = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const env = { demo: false, privateOn: false, command: 'honestweek', words: [], examples: [], home: null, startSwitch: null };
  // Words typed or clicked in this run: none may ever reach a frame's address.
  const typed = new Set();

  // ---- the list of steps -----------------------------------------------------------------
  const results = [];
  const listEl = document.getElementById('steps');
  const summaryEl = document.getElementById('summary');
  const started = Date.now();
  document.getElementById('skips').innerHTML = Object.entries(SKIPS).map(([k, v]) => `<li><code>${esc(k)}</code>: ${esc(v)}${DEMO_SKIPS[k] ? ` (on the demo week too: ${esc(DEMO_SKIPS[k])})` : ''}</li>`).join('');
  const tally = () => ({ pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length, skip: results.filter((r) => r.status === 'SKIP').length });
  function showTotals(done) {
    const c = tally();
    const t = `${c.pass} passed, ${c.fail} failed, ${c.skip} skipped`;
    summaryEl.textContent = done ? `Done in ${secs(started)}: ${t}.` : `Running, ${plural(results.length, 'step')} so far: ${t}.`;
    document.title = `Click-through test · honestweek · ${done ? '' : 'running · '}${t}`;
  }
  class Skip extends Error {
    constructor(id) {
      super(SKIPS[id] ?? id);
      this.id = id;
    }
  }
  class Fatal extends Error {}
  const skip = (id) => {
    throw new Skip(id);
  };
  const pageErrors = [];
  async function step(page, name, fn) {
    const li = document.createElement('li');
    li.className = 'run';
    li.innerHTML = `<span class="st">RUN</span><span class="pg">${esc(page)}</span><span>${esc(name)}</span><span class="detail"></span>`;
    listEl.appendChild(li);
    const t0 = Date.now();
    const errorsBefore = pageErrors.length;
    let status = 'PASS';
    let detail = '';
    let skipId = null;
    try {
      detail = (await fn()) ?? '';
      addressCheck();
    } catch (err) {
      if (err instanceof Skip) {
        skipId = err.id;
        const named = !!SKIPS[err.id];
        const demoAllows = !env.demo || !!DEMO_SKIPS[err.id];
        status = named && demoAllows ? 'SKIP' : 'FAIL';
        detail = !named ? `skipped for a reason that isn't on the named list: ${err.id}` : !demoAllows ? `the demo week holds this case on purpose, so this step can't skip there: ${err.id}` : `${err.id}: ${err.message}`;
      } else {
        status = 'FAIL';
        detail = err?.message ?? String(err);
        if (err && err.name && err.name !== 'Error') detail = `${err.name}: ${detail}`;
      }
    }
    const fresh = pageErrors.slice(errorsBefore);
    if (fresh.length) {
      status = 'FAIL';
      detail = `page error: ${fresh.join(' | ')}${detail ? ` · ${detail}` : ''}`;
    }
    const r = { page, name, status, detail: String(detail), skip: skipId, ms: Date.now() - t0 };
    results.push(r);
    li.className = status.toLowerCase();
    li.querySelector('.st').textContent = status;
    li.querySelector('.detail').textContent = r.detail;
    showTotals(false);
    return status === 'PASS';
  }
  async function waitFor(fn, { timeout = 10e3, interval = 40, what = 'the page' } = {}) {
    const end = Date.now() + timeout;
    let last = null;
    for (;;) {
      try {
        const v = fn();
        if (v) return v;
        last = null;
      } catch (err) {
        if (err instanceof Fatal) throw err;
        last = err;
      }
      if (Date.now() > end) throw new Error(`Gave up after ${Math.round(timeout / 1000)} s waiting for ${what}${last ? ` (${last.message})` : ''}`);
      await sleep(interval);
    }
  }

  // ---- the frame: a fresh one per page, with its errors and policy violations captured ----
  const holder = document.getElementById('frameHolder');
  let frame = null;
  const win = () => frame.contentWindow;
  const doc = () => frame.contentDocument;
  const where = () => {
    try {
      const u = new URL(doc().URL);
      return u.pathname.split('/').pop();
    } catch {
      return 'frame';
    }
  };
  const policy = (ev) => `content policy blocked ${ev.violatedDirective || ev.effectiveDirective} (${String(ev.blockedURI || 'inline').slice(0, 60)}${ev.sourceFile ? ` in ${ev.sourceFile.split('/').pop()}:${ev.lineNumber}` : ''})`;
  // Every content-policy violation is a failure, here and in each frame.
  document.addEventListener('securitypolicyviolation', (ev) => pageErrors.push(`click-through page: ${policy(ev)}`));
  function attach() {
    if (!frame) return;
    let w;
    let d;
    try {
      w = frame.contentWindow;
      d = frame.contentDocument;
    } catch {
      return;
    }
    if (!w || !d || d.__ctSeen) return;
    d.__ctSeen = true;
    d.addEventListener('securitypolicyviolation', (ev) => pageErrors.push(`${where()}: ${policy(ev)}`));
    if (w.__ctListening) return;
    w.__ctListening = true;
    w.addEventListener('error', (ev) => {
      const t = ev.target;
      if (t && t.nodeType === 1) return pageErrors.push(`${where()}: a file didn't load (${t.getAttribute?.('src') ?? t.getAttribute?.('href') ?? t.tagName})`);
      pageErrors.push(`${where()}: ${ev.message}${ev.filename ? ` (${ev.filename.split('/').pop()}:${ev.lineno})` : ''}`);
    }, true);
    w.addEventListener('unhandledrejection', (ev) => pageErrors.push(`${where()}: unhandled rejection: ${ev.reason?.message ?? ev.reason}`));
    try {
      const orig = w.console.error;
      w.console.error = function (...a) {
        pageErrors.push(`${where()}: console.error: ${a.map(String).join(' ').slice(0, 300)}`);
        return orig.apply(this, a);
      };
    } catch {}
  }
  setInterval(attach, 5);
  function newFrame({ width, height }) {
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.title = 'Page under test';
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    holder.appendChild(frame);
    attach();
  }
  const onPage = (d, path) => {
    try {
      return !!d && d.readyState === 'complete' && new URL(d.URL).pathname.endsWith(`/${path}`);
    } catch {
      return false;
    }
  };
  async function openPage(url, { size = DESKTOP, ready = () => true, timeout = 60e3, what } = {}) {
    newFrame(size);
    const path = url.split(/[?#]/)[0];
    frame.src = `/${url}`;
    await waitFor(() => onPage(doc(), path), { timeout, what: `${path} to load` });
    await waitFor(() => ready(win(), doc()), { timeout, what: what ?? `${path} to draw` });
    return { w: win(), d: doc() };
  }
  async function ensure(url, ready, opts = {}) {
    const path = url.split(/[?#]/)[0];
    const size = opts.size ?? DESKTOP;
    try {
      if (frame && frame.offsetWidth === size.width && onPage(doc(), path) && (!url.includes('#') || doc().URL.endsWith(url.slice(url.indexOf('#')))) && ready(win(), doc())) return { w: win(), d: doc() };
    } catch {}
    return openPage(url, { ...opts, ready });
  }
  async function navigated(oldDoc, path, ready, { timeout = 60e3, what } = {}) {
    await waitFor(() => doc() !== oldDoc && onPage(doc(), path), { timeout, what: `${path} to open` });
    await waitFor(() => ready(win(), doc()), { timeout, what: what ?? `${path} to draw` });
    return { w: win(), d: doc() };
  }

  // ---- real DOM events ---------------------------------------------------------------------
  function click(el) {
    const w = el.ownerDocument.defaultView;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: w, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new w.MouseEvent('mousedown', { ...o, buttons: 1 }));
    if (el.matches?.('button, a[href], input, select, summary, [tabindex]')) el.focus();
    el.dispatchEvent(new w.MouseEvent('mouseup', o));
    el.dispatchEvent(new w.MouseEvent('click', o));
  }
  function key(el, k, code, more = {}) {
    const w = el.ownerDocument.defaultView;
    const o = { key: k, code, bubbles: true, cancelable: true, composed: true, view: w, ...more };
    const down = new w.KeyboardEvent('keydown', o);
    el.dispatchEvent(down);
    el.dispatchEvent(new w.KeyboardEvent('keyup', o));
    return down;
  }
  function typeInto(input, value) {
    const w = input.ownerDocument.defaultView;
    if (value) typed.add(value);
    input.focus();
    input.value = '';
    input.dispatchEvent(new w.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    for (const ch of value) {
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      input.value += ch;
      input.dispatchEvent(new w.InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      input.dispatchEvent(new w.KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
  }
  function choose(select, value) {
    const w = select.ownerDocument.defaultView;
    select.focus();
    select.value = value;
    select.dispatchEvent(new w.Event('input', { bubbles: true }));
    select.dispatchEvent(new w.Event('change', { bubbles: true }));
  }
  function slide(range, value) {
    const w = range.ownerDocument.defaultView;
    range.focus();
    range.value = String(value);
    range.dispatchEvent(new w.Event('input', { bubbles: true }));
    range.dispatchEvent(new w.Event('change', { bubbles: true }));
  }
  const describeEl = (el) => (!el ? 'nothing' : el === el.ownerDocument.body ? 'the page body' : `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.dataset?.id ? ` data-id` : ''}> "${text(el).slice(0, 30)}"`);

  // ---- the server ----------------------------------------------------------------------------
  const api = (route, q = {}, opts = {}) => window.HWP.api(route, q, { private: env.privateOn, ...opts });
  const leakTotal = (r) => (Number.isFinite(r.total) ? r.total : ['terms', 'names', 'codenames', 'paths', 'emails', 'secrets'].reduce((n, k) => n + (Number(r[k]) || 0), 0));
  // `chars` is how much text was checked, not a count of anything found.
  const leakText = (r) => Object.entries(r).filter(([k, v]) => Number.isFinite(v) && v > 0 && k !== 'total' && k !== 'chars').map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  /** The server's leak counter over what a page shows: with the switch off, private words, home
   *  folders, emails and secrets; with it on, secrets. It answers with counts only. `parts` is a
   *  list, each string as it stands on the page (one text node, or one address) and each value
   *  as the page got it from the server, and each is checked on its own: joined into one text,
   *  the end of one piece and the start of the next read as a field and its value
   *  (`… Authorization: [redacted:secret]`, then `recorded`). */
  async function leaks(parts) {
    const r = await api('leak-check', { parts: 1 }, { method: 'POST', body: JSON.stringify(parts) });
    if (r.ready === false) throw new Error("the server isn't ready to check text yet");
    return r;
  }
  /** Every piece of text under `el` as the page shows it: one string per text node, with its
   *  whitespace collapsed. */
  function shownText(el) {
    const out = [];
    if (!el) return out;
    const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.data.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  }
  /** Replay events as the page got them: each one's description and its fields. */
  const eventParts = (events) => events.map((e) => ({ text: e.text, facts: e.facts ?? {} }));
  async function noLeaks(parts, what) {
    const r = await leaks(parts);
    if (leakTotal(r) > 0) throw new Error(`the leak counter found ${leakText(r)} in ${what} with the switch ${env.privateOn ? 'on (secrets)' : 'off'}`);
    return `the leak counter found nothing in ${what} (switch ${env.privateOn ? 'on: no secrets' : 'off: no private word, home folder or email'})`;
  }

  // ---- checks every page shares ----------------------------------------------------------------
  const marks = (d) => d.querySelectorAll('#chart .mark[data-id]').length;
  const LEVELS = ['recorded', 'derived', 'inferred', 'missing', 'ambiguous'];
  function headerCheck(d, current) {
    const links = [...d.querySelectorAll('.topbar nav a')].map((a) => a.getAttribute('href'));
    for (const want of PAGES) if (!links.includes(want)) throw new Error(`the header has no link to ${want}`);
    const cur = d.querySelector('.topbar nav a[aria-current="page"]')?.getAttribute('href');
    if (cur !== current) throw new Error(`the header marks ${cur ?? 'no page'} as current, not ${current}`);
    const chips = [...d.querySelectorAll('[data-evkey] .evkey-item .chip')];
    const words = chips.map((c) => text(c));
    if (words.join(' ') !== LEVELS.join(' ')) throw new Error(`the evidence key reads "${words.join(', ')}", not the five words ${LEVELS.join(', ')}`);
    // Every chip on the page uses one of the five words.
    const odd = [...d.querySelectorAll('.chip')].map((c) => text(c).split(' · ')[0]).filter((w) => !LEVELS.includes(w));
    if (odd.length) throw new Error(`${plural(odd.length, 'chip')} use a word outside the five: "${[...new Set(odd)].slice(0, 3).join('", "')}"`);
    const win2 = text(d.getElementById('window'));
    if (!/^Window: \w{3} \d+(, \d{4})? to (\w{3} )?\d+, \d{4}$/.test(win2)) throw new Error(`the header's window reads "${win2}"`);
    // The key is one click away: the "?" button opens it, Escape closes it and focus goes back.
    const kb = d.getElementById('keyBtn');
    const pop = d.getElementById('evkeyPanel');
    if (!kb || !pop) throw new Error('the header has no "?" button for the evidence key');
    if (!pop.hidden) throw new Error('the evidence key is open before anyone asked for it');
    click(kb);
    if (pop.hidden || kb.getAttribute('aria-expanded') !== 'true') throw new Error('the "?" button didn\'t open the evidence key');
    if (!pop.getBoundingClientRect().width) throw new Error('the evidence key opened but shows nothing');
    key(kb, 'Escape', 'Escape');
    if (!pop.hidden || kb.getAttribute('aria-expanded') !== 'false') throw new Error("Escape didn't close the evidence key");
    if (d.activeElement !== kb) throw new Error(`after Escape, focus is on ${describeEl(d.activeElement)}, not the "?" button`);
    const sw = d.getElementById('privateSwitch');
    if (!sw) throw new Error('the header has no "Show private text" switch');
    if (sw.checked !== env.privateOn) throw new Error(`the switch reads ${sw.checked ? 'on' : 'off'} but this run has it ${env.privateOn ? 'on' : 'off'}`);
    const demo = d.getElementById('demo');
    const shown = demo && !demo.hidden;
    if (shown !== env.demo) throw new Error(env.demo ? 'the demo notice is missing' : 'a demo notice shows outside demo mode');
    if (shown && !(/install/i.test(text(demo)) && text(demo).includes(`${env.command} init`) && text(demo).includes(`${env.command} view`) && /made[ -]up/.test(text(demo)))) throw new Error(`the demo notice reads "${text(demo).slice(0, 120)}"`);
    return `${current} current; the key's five words, opened by "?" and closed by Escape; "${win2}"; switch ${sw.checked ? 'on' : 'off'}${env.demo ? '; demo notice with the install, init and view commands' : ''}`;
  }
  // The address holds only ids: never a typed word, a clicked reference, a goal id or title.
  const ADDRESS = {
    'search.html': /^(#q=[A-Za-z0-9_-]{4,64}(~[lw])?)?$/,
    'goal.html': /^(#(?:[a-z]{1,4}-)?[a-p]{4,64}(~[a-z]{2,4}-[a-p]{4,64})*)?$/,
    'replay.html': /^(#(th-[a-p]{4,64})?(~zoom~pf-[a-p]{12})?(~[a-z]{2,4}-[a-p]{4,64}([.:][A-Za-z0-9_-]{1,80}){0,6})?)?$/,
    'problems.html': /^(#[a-z][a-z0-9-]{1,60})?$/,
  };
  function addressCheck() {
    if (!frame) return;
    let u;
    try {
      u = new URL(doc().URL);
    } catch {
      return;
    }
    const page = u.pathname.split('/').pop();
    if (!ADDRESS[page]) return;
    const search = u.search;
    if (search && !/^\?session=[a-z]{2,4}-[a-p]{4,64}$/.test(search)) throw new Error(`the address holds "${search.slice(0, 40)}"`);
    if (!ADDRESS[page].test(u.hash)) throw new Error(`${page}'s address holds "${u.hash.slice(0, 40)}", not only ids`);
    if (typedInAddress(u.search, u.hash, typed)) throw new Error('a typed word reached the address');
    let st = '';
    try {
      st = JSON.stringify(win().history.state ?? null);
    } catch {}
    if (holdsTyped(st)) throw new Error('a typed word reached history.state');
  }
  // ---- a typed word in an address (no page state: test/view-assets.test.mjs runs this part) ----
  // Whether some text holds a word typed or clicked in this run, as a whole word (an id made of
  // letters can contain a short word by chance; it never is one).
  const wordsIn = (s) => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 2);
  /** The parts of an address that carry ids: the value of each search parameter, and each piece
   *  of the fragment between "~" (a query id after "q="; a thread, goal or step id). Each is
   *  listed whole and again without its kind prefix ("th-", "cc-"), lowercased. */
  function addressParts(search, hash) {
    const parts = [];
    for (const [, v] of new URLSearchParams(String(search ?? ''))) parts.push(v);
    let h = String(hash ?? '').replace(/^#/, '');
    try {
      h = decodeURIComponent(h);
    } catch {}
    for (const p of h.split('~')) parts.push(p.replace(/^q=/, ''));
    return parts.filter(Boolean).flatMap((p) => [p, p.replace(/^[a-z]{1,4}-/, '')]).map((p) => p.toLowerCase());
  }
  /** Whether a typed text, or one of its words, is a whole id-carrying part of the address. A
   *  parameter's own name ("session") and the numbers inside a step id (cc-abcd.123.0) belong to
   *  the address, so they never count: matched as loose words, a search word that is also a
   *  parameter's name, or a pull request number that is also a line number, looked like a leak. */
  function typedInAddress(search, hash, typedList) {
    const parts = new Set(addressParts(search, hash));
    for (const t of typedList) for (const w of [String(t ?? '').trim().toLowerCase(), ...wordsIn(t)]) if (w.length > 2 && parts.has(w)) return true;
    return false;
  }
  // ---- end of a typed word in an address ----
  function holdsTyped(s) {
    const have = new Set(wordsIn(s));
    for (const t of typed) if (wordsIn(t).some((w) => have.has(w))) return true;
    return false;
  }
  /** What local storage may hold: under hw.prefs only, catalog pattern ids with one of four
   *  tiers, and two switches. Returns a problem, or null. */
  function prefsProblem() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    const extra = keys.filter((k) => k !== PREFS_SLOT);
    if (extra.length) return `localStorage holds ${plural(extra.length, 'item')} besides ${PREFS_SLOT}`;
    const raw = localStorage.getItem(PREFS_SLOT);
    if (raw == null) return null;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      return `${PREFS_SLOT} isn't JSON`;
    }
    const fields = Object.keys(v ?? {}).filter((k) => !['v', 'priority', 'strip', 'low'].includes(k));
    if (fields.length) return `${PREFS_SLOT} holds ${plural(fields.length, 'field')} besides the overrides and the two switches`;
    for (const [id, tier] of Object.entries(v.priority ?? {})) if (!/^[a-z][a-z0-9-]{1,60}$/.test(id) || !['high', 'medium', 'low', 'dismissed'].includes(tier)) return `${PREFS_SLOT} holds an entry that isn't a pattern id and a tier`;
    if (typeof v.strip !== 'boolean' || typeof v.low !== 'boolean') return `${PREFS_SLOT}'s switches aren't true or false`;
    if (holdsTyped(Object.keys(v.priority ?? {}).join(' '))) return `a typed word reached ${PREFS_SLOT}`;
    return null;
  }
  /** sessionStorage holds the key and the switch only; localStorage only the catalog preferences. */
  function storageCheck() {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i));
    const extra = keys.filter((k) => k !== window.HWKey.KEY_SLOT && k !== window.HWKey.SWITCH_SLOT);
    if (extra.length) throw new Error(`sessionStorage holds ${plural(extra.length, 'other item')} besides the key and the switch`);
    const p = prefsProblem();
    if (p) throw new Error(p);
    // The switch is saved as {"run": <key>, "on": <bool>}: those words aren't typed text.
    const all = keys.map((k) => sessionStorage.getItem(k) ?? '').join('\n').replace(/"(run|on)":/g, '');
    if (holdsTyped(all)) throw new Error('a typed word reached sessionStorage');
    const prefs = localStorage.getItem(PREFS_SLOT);
    return `sessionStorage holds ${keys.length === 2 ? 'the key and the switch' : keys.join(' and ') || 'nothing'}; localStorage ${prefs ? `holds only ${PREFS_SLOT}: catalog pattern ids, their tiers and two switches` : 'is empty'}`;
  }
  function culprit(d, cw) {
    for (const el of d.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right <= cw + 1 || !r.width) continue;
      const p = el.parentElement.getBoundingClientRect();
      if (p.right <= cw + 1) return `${describeEl(el)}${el.className && typeof el.className === 'string' ? ` .${el.className.trim().split(/\s+/).join('.')}` : ''} reaches ${Math.round(r.right)}px`;
    }
    return 'no single element found';
  }
  function phoneCheck(d, controls) {
    const de = d.documentElement;
    const cw = de.clientWidth;
    const problems = [];
    if (de.scrollWidth > cw + 1) problems.push(`the page scrolls sideways: ${de.scrollWidth}px of content in ${cw}px (${culprit(d, cw)})`);
    for (const el of d.querySelectorAll('.topbar > *, .topbar nav a, .topbar .privacy > *')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > cw + 1 || r.left < -1)) problems.push(`header item ${describeEl(el)} runs off the screen (${Math.round(r.left)} to ${Math.round(r.right)} of ${cw}px)`);
    }
    for (const sel of controls) {
      const el = d.querySelector(sel);
      if (!el) {
        problems.push(`${sel} is missing`);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || d.defaultView.getComputedStyle(el).visibility === 'hidden') problems.push(`${sel} isn't visible`);
      else if (r.right > cw + 1 || r.left < -1) problems.push(`${sel} is off the screen (${Math.round(r.left)} to ${Math.round(r.right)}px)`);
    }
    if (problems.length) throw new Error(problems.join('; '));
    return `${de.scrollWidth}px of content in ${cw}px; the header and ${controls.length} main controls fit`;
  }
  // A page that couldn't be drawn, or whose build failed, stops the wait at once.
  function stopIfBroken(w, d, { allow = [] } = {}) {
    const f = d.querySelector('[data-fatal]');
    if (f && !allow.includes(f.dataset.fatal)) throw new Fatal(`the page shows "${text(f).slice(0, 160)}"`);
    const st = d.getElementById('status');
    if (st && !st.hidden && st.classList.contains('bad') && /couldn't be built/.test(st.textContent)) throw new Fatal(text(st));
  }
  const switched = (w, to) => !!w.HWP && w.HWP.on === to;

  // ---- the chart pages share these -----------------------------------------------------------
  const playState = (d) => ({ readout: text(d.getElementById('readout')), x: d.querySelector('#chart line.playhead')?.getAttribute('x1') ?? null, say: text(d.getElementById('announce')) });
  const moved = (a, b) => a.readout !== b.readout || a.x !== b.x || a.say !== b.say;
  async function stepButtons(promptsAfterStart) {
    const $ = (id) => doc().getElementById(id);
    slide($('slider'), 0);
    const start = playState(doc());
    click($('nextStep'));
    const one = playState(doc());
    if (!moved(start, one)) throw new Error('"Step ▶" didn\'t move the playhead');
    if (!one.say) throw new Error('"Step ▶" announced nothing for a screen reader');
    click($('nextStep'));
    const two = playState(doc());
    if (!moved(one, two)) throw new Error('a second "Step ▶" didn\'t move the playhead');
    click($('prevStep'));
    const back = playState(doc());
    if (!moved(two, back)) throw new Error('"◀ Step" didn\'t move the playhead back');
    let promptNote;
    if (promptsAfterStart === 0) promptNote = 'no prompts to step to';
    else {
      slide($('slider'), 0);
      const p0 = playState(doc());
      click($('nextPrompt'));
      const p1 = playState(doc());
      if (!moved(p0, p1)) throw new Error('"Prompt ⏭" didn\'t move the playhead');
      if (promptsAfterStart > 1) {
        click($('nextPrompt'));
        const p2 = playState(doc());
        if (!moved(p1, p2)) throw new Error('a second "Prompt ⏭" didn\'t move the playhead');
        click($('prevPrompt'));
        if (!moved(p2, playState(doc()))) throw new Error('"⏮ Prompt" didn\'t move the playhead back');
        promptNote = 'Prompt ⏭ twice and ⏮ Prompt once moved it';
      } else promptNote = 'Prompt ⏭ moved it (one prompt, so ⏮ Prompt has nowhere to go)';
    }
    return `Step ▶ twice and ◀ Step once moved the playhead; ${promptNote}; it announces each step for a screen reader`;
  }
  async function spaceAndPlay() {
    const $ = (id) => doc().getElementById(id);
    slide($('slider'), 0);
    const btn = $('nextStep');
    btn.focus();
    const before = playState(doc());
    const down = key(btn, ' ', 'Space');
    if (down.defaultPrevented) throw new Error("the page cancelled Space on a focused button, so the browser wouldn't press it");
    await sleep(250);
    if (/Pause/.test(text($('play')))) {
      click($('play'));
      throw new Error('Space on a focused button started playback');
    }
    click(btn);
    if (!moved(before, playState(doc()))) throw new Error('the focused button did nothing when pressed');
    doc().activeElement?.blur?.();
    key(doc().body, ' ', 'Space');
    if (!/Pause/.test(text($('play')))) throw new Error("Space with nothing focused didn't start playback");
    key(doc().body, ' ', 'Space');
    if (!/Play/.test(text($('play')))) throw new Error("a second Space didn't pause");
    return 'Space on a focused "Step ▶" is left to the browser; Space with nothing focused plays and pauses';
  }
  async function playPause() {
    const $ = (id) => doc().getElementById(id);
    slide($('slider'), 0);
    const a = playState(doc());
    click($('play'));
    if (!/Pause/.test(text($('play')))) throw new Error(`Play didn't turn into Pause (it reads "${text($('play'))}")`);
    await sleep(700);
    const b = playState(doc());
    if (!moved(a, b)) throw new Error("the playhead didn't move while playing");
    if (/Pause/.test(text($('play')))) {
      click($('play'));
      if (!/Play/.test(text($('play')))) throw new Error("Pause didn't stop playback");
      const c = playState(doc());
      await sleep(300);
      if (moved(c, playState(doc()))) throw new Error('the playhead kept moving after Pause');
      if (!/^Paused at/.test(text($('announce')))) throw new Error(`Pause announced "${text($('announce'))}"`);
      return 'played, then paused, and said so for a screen reader';
    }
    return 'played to the end and stopped by itself';
  }
  function sliderCheck() {
    const $ = (id) => doc().getElementById(id);
    slide($('slider'), 0);
    const a = text($('readout'));
    slide($('slider'), 500);
    const s = $('slider');
    const vt = s.getAttribute('aria-valuetext');
    if (!s.getAttribute('aria-label')) throw new Error('the slider has no aria-label');
    if (!vt) throw new Error('the slider has no aria-valuetext');
    if (vt !== text($('readout'))) throw new Error("aria-valuetext doesn't match the readout");
    if (vt === a) throw new Error("moving the slider to the middle didn't change the time");
    return 'aria-valuetext follows the slider and matches the readout';
  }
  async function zoomCheck() {
    const $ = (id) => doc().getElementById(id);
    const options = [...$('zoom').options].filter((o) => !o.disabled && Number(o.value) > 0).sort((a, b) => Number(a.value) - Number(b.value));
    slide($('slider'), 500);
    let used = null;
    for (const o of options) {
      choose($('zoom'), o.value);
      if (!$('zoombar').hidden) {
        used = o;
        break;
      }
    }
    if (!used) skip('short-span');
    if ($('fit').disabled) throw new Error('zoomed in, but the zoom-out button stays disabled');
    if (!/Zoomed in/.test(text($('zoombar')))) throw new Error(`the zoom bar reads "${text($('zoombar')).slice(0, 80)}"`);
    click($('zoombar').querySelector('[data-fit]'));
    if (!$('zoombar').hidden || $('zoom').value !== '0') throw new Error('"Back to the whole" didn\'t zoom back out');
    choose($('zoom'), used.value);
    doc().activeElement?.blur?.();
    key(doc().body, 'Escape', 'Escape');
    if (!$('zoombar').hidden) throw new Error("Esc didn't zoom back out");
    choose($('zoom'), used.value);
    click($('fit'));
    if (!$('zoombar').hidden) throw new Error("the zoom-out button didn't zoom back out");
    return `"${used.textContent}" zoomed in; its button, Esc and the zoom-out button each zoomed back out`;
  }
  /** Click a step, check its record panel is a dialog with focus on Close and its original record
   *  read from the server, then close it with Escape and check focus goes back to the step (a
   *  click focuses it, since every step is focusable). */
  async function drawerCheck(mark, { hashBase } = {}) {
    const id = mark.dataset.id;
    click(mark);
    const dr = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: 'the record panel to open' });
    if (dr.getAttribute('role') !== 'dialog') throw new Error("the panel isn't a dialog");
    const title = doc().getElementById(dr.getAttribute('aria-labelledby') ?? '');
    if (!title || !text(title)) throw new Error('the panel has no title for a screen reader');
    const close = dr.querySelector('[data-close]');
    if (doc().activeElement !== close) throw new Error(`focus is on ${describeEl(doc().activeElement)}, not Close`);
    await waitFor(() => !/Reading the log line/.test(text(dr.querySelector('[data-record]'))), { timeout: 10e3, what: 'the original record to be read' });
    const rec = dr.querySelector('[data-record]');
    if (!/Original record|no record of its own|git object/.test(text(rec))) throw new Error(`the record section reads "${text(rec).slice(0, 100)}"`);
    if (/couldn't be read/.test(text(rec))) throw new Error(text(rec).slice(0, 140));
    if (!dr.textContent.includes(id)) throw new Error('the panel shows a different record');
    if (hashBase && !doc().URL.endsWith(`#${hashBase}~${id}`)) throw new Error("the address didn't name the open record");
    key(close, 'Escape', 'Escape');
    await waitFor(() => !doc().querySelector('.drawer.open'), { timeout: 3000, what: 'Escape to close the panel' });
    const back = doc().activeElement;
    if (back?.dataset?.id !== id) throw new Error(`after Escape, focus is on ${describeEl(back)}, not back on the step`);
    if (hashBase && !doc().URL.endsWith(`#${hashBase}`)) throw new Error('the address still names the closed record');
    return `opened "${text(title)}" as a dialog with focus on Close and its record read from disk; Escape closed it and focus went back`;
  }
  /** Every step on the chart takes keyboard focus and opens with Enter, and the screen-reader
   *  list has one item per drawn step, in the same order. */
  async function chartKeyboard() {
    const d = doc();
    const all = [...d.querySelectorAll('#chart .mark[data-id]')];
    if (!all.length) throw new Error('the chart draws no step');
    const bad = all.filter((m) => m.getAttribute('tabindex') !== '0' || m.getAttribute('role') !== 'button' || !m.getAttribute('aria-label'));
    if (bad.length) throw new Error(`${plural(bad.length, 'step')} of ${all.length} can't be reached with Tab or have no name for a screen reader`);
    const items = [...d.querySelectorAll('#chartSteps li')];
    if (items.length !== all.length) throw new Error(`the screen-reader list has ${plural(items.length, 'item')} for ${plural(all.length, 'drawn step')}`);
    const off = items.findIndex((li, i) => li.dataset.id !== all[i].dataset.id);
    if (off >= 0) throw new Error(`the screen-reader list's item ${off + 1} isn't the chart's step ${off + 1}`);
    // Enter on a spread of steps: the first, the last, and one of each kind in between.
    const seen = new Set();
    const sample = [all[0], all[all.length - 1], ...all.filter((m) => {
      const k = `${m.tagName}|${m.getAttribute('class')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })].slice(0, 12);
    let opened = 0;
    for (const m0 of sample) {
      const m = doc().querySelector(`#chart .mark[data-id="${CSS.escape(m0.dataset.id)}"]`);
      if (!m) continue;
      m.focus();
      if (doc().activeElement !== m) throw new Error(`a step (${describeEl(m)}) can't take keyboard focus`);
      key(m, 'Enter', 'Enter');
      const dr = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: 'Enter on a step to open its record' });
      if (!dr.textContent.includes(m.dataset.id)) throw new Error('Enter on a step opened a different record');
      key(dr.querySelector('[data-close]'), 'Escape', 'Escape');
      await waitFor(() => !doc().querySelector('.drawer.open'), { timeout: 3000, what: 'Escape to close the panel' });
      opened++;
    }
    return `${plural(all.length, 'step')}, each focusable and named; the screen-reader list has one item per step in order; Enter opened ${plural(opened, 'record')} of ${opened} tried`;
  }
  async function keyboardRecord(link) {
    link.focus();
    if (doc().activeElement !== link) throw new Error(`the side panel's record link (${describeEl(link)}) can't take keyboard focus`);
    if (link.matches('a[href], button')) click(link);
    else key(link, 'Enter', 'Enter');
    await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 2000, what: 'Enter on the record link to open the panel' });
    const dr = doc().querySelector('.drawer.open');
    if (doc().activeElement !== dr.querySelector('[data-close]')) throw new Error("focus didn't move to Close");
    key(doc().activeElement, 'Escape', 'Escape');
    await waitFor(() => !doc().querySelector('.drawer.open'), { timeout: 2000, what: 'Escape to close the panel' });
    if (doc().activeElement !== link) throw new Error(`after Escape, focus is on ${describeEl(doc().activeElement)}, not the record link`);
    return `${describeEl(link)} takes focus, Enter opens the record, Escape returns focus to it`;
  }
  /** Flip the header switch, wait for the page to reload in that mode, then flip it back. */
  async function headerSwitch(path, ready) {
    const flip = async (to) => {
      const box = doc().getElementById('privateSwitch');
      if (!box) throw new Error('no "Show private text" switch in the header');
      const old = doc();
      const t0 = Date.now();
      click(box);
      await navigated(old, path, (w, d) => (stopIfBroken(w, d), switched(w, to) && ready(w, d)), { timeout: BUILD_MS, what: `the page to reload with private text ${to ? 'on' : 'off'}` });
      if (doc().getElementById('privateSwitch')?.checked !== to) throw new Error(`after the reload the switch reads ${to ? 'off' : 'on'}`);
      return secs(t0);
    };
    const a = await flip(!env.privateOn);
    const b = await flip(env.privateOn);
    return `turned ${env.privateOn ? 'off' : 'on'} (${a}) and back (${b}); each time the page reloaded in that mode`;
  }

  // ---- the search page -----------------------------------------------------------------------
  const searchReady = (w, d) => (stopIfBroken(w, d), d.body.dataset.ready === '1' && d.getElementById('out')?.dataset.state === 'done' && switched(w, env.privateOn));
  const openSearch = (size = DESKTOP) => ensure('search.html', searchReady, { size, timeout: BUILD_MS, what: 'the search page' });
  /** Run a query and wait until the results (and the search of every session, for words) are drawn. */
  async function settle(action, { everywhere = 'auto' } = {}) {
    const out = doc().getElementById('out');
    const before = Number(out.dataset.seq);
    await action();
    await waitFor(() => Number(doc().getElementById('out').dataset.seq) > before && doc().getElementById('out').dataset.state === 'done', { timeout: 20e3, what: 'the results to update' });
    if (everywhere !== false) await sleep(30);
    const box = doc().getElementById('everywhere');
    if (box) await waitFor(() => doc().getElementById('everywhere')?.dataset.state === 'done', { timeout: 30e3, what: 'the search of every session to answer' });
    return doc().getElementById('out');
  }
  const typeQuery = (q) => settle(() => {
    const input = doc().getElementById('q');
    typeInto(input, q);
    key(input, 'Enter', 'Enter');
  });
  const windowCards = (o) => [...o.querySelectorAll('.card')].filter((c) => !c.closest('#everywhere'));
  /** A section's count: its heading (matched by its words) carries it in data-count. */
  const countIn = (o, re) => Number([...o.querySelectorAll('h2')].find((h) => re.test(text(h).replace(/\s*\d+$/, '')))?.dataset.count ?? 0);
  /** What a person clicks to see a hidden link: "More" on its result, or the fold it sits in. */
  function reveal(el) {
    const box = el.closest('.rmore');
    if (box?.hidden) {
      const more = el.ownerDocument.querySelector(`[data-more][aria-controls="${CSS.escape(box.id)}"]`);
      if (!more) throw new Error("a result's reasons are hidden with no More button");
      click(more);
      if (box.hidden) throw new Error('"More" didn\'t show the result\'s reasons');
    }
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) if (!d.open) click(d.querySelector('summary'));
    return el;
  }
  const kindOf = (x) => (/^#\d+$|^[\w.-]*#\d+$|\/pull\/\d+/.test(x) ? 'pr' : /^[0-9a-f]{7,40}$/i.test(x) ? 'commit' : /[\\/]/.test(x) && /\.[a-z0-9]{1,6}$/i.test(x) ? 'file' : /^[\w.-]+\.[a-z0-9]{1,6}$/i.test(x) ? 'file' : /\//.test(x) && !/\s/.test(x) ? 'branch' : 'words');
  const example = (kind) => env.examples.find((x) => kindOf(x) === kind) ?? null;
  // A branch the logs recorded, read from the replays' own events when no example names one.
  async function findBranch() {
    const b = example('branch');
    if (b) return b;
    const threads = [...new Set((env.home?.recent ?? []).map((s) => s.thread).filter(Boolean))].slice(0, 6);
    for (const th of threads) {
      let a;
      try {
        a = await api('replay', { thread: th });
      } catch {
        continue;
      }
      for (const e of a.events ?? []) {
        const v = e.facts?.branch ?? e.facts?.git?.push?.branch ?? null;
        if (typeof v === 'string' && /^[\w./-]+$/.test(v) && v !== 'main' && v !== 'master') return v;
      }
    }
    return null;
  }

  async function searchSteps() {
    const P = 'search';
    let loaded = false;
    await step(P, 'Loads without errors', async () => {
      const t0 = Date.now();
      await openSearch();
      loaded = true;
      return `ready in ${secs(t0)}${env.privateOn ? ', private text shown' : ''}`;
    });
    const need = (size) => (loaded ? openSearch(size) : skip('page-did-not-load'));
    await step(P, 'Header: pages, window, switch, the five-word key, the demo notice', async () => headerCheck((await need()).d, 'search.html'));
    await step(P, 'Coverage line', async () => {
      const { d } = await need();
      const c = text(d.querySelector('#coverage [data-cover="head"]'));
      if (!/^Pull request, commit, file and word lookups cover \d+ sessions? \w+ in your configured repos, \w{3}, \w{3} \d+/.test(c)) throw new Error(`the coverage line reads "${c.slice(0, 140)}"`);
      if (c.length > 160) throw new Error(`the coverage line is ${c.length} characters, not one short sentence`);
      const more = d.querySelector('#coverage details[data-cover="more"]');
      if (more && (more.open || !more.querySelector('summary') || !more.querySelector('.chip'))) throw new Error('the coverage details are open, untitled, or carry no evidence level');
      if (!d.querySelector('#coverage .chip')) throw new Error("the coverage line's counts carry no evidence level");
      return c.slice(0, 160);
    });
    await step(P, 'Home lists goals and recent sessions', async () => {
      await need();
      const o = await typeQuery('');
      const recent = countIn(o, /^Recent sessions$/);
      if (!recent) throw new Error('the home view lists no recent sessions');
      const rows = [...o.querySelectorAll('.card.row[data-session]')];
      if (rows.length < recent) throw new Error(`"Recent sessions" counts ${recent} but lists only ${rows.length}`);
      const goals = countIn(o, /^Your goals$/);
      const goalRows = o.querySelectorAll('.card[data-goal]').length;
      if (goalRows !== goals) throw new Error(`"Your goals" counts ${goals} but lists ${goalRows}`);
      return `${plural(goals, 'goal')}, ${plural(recent, 'recent session')}`;
    });
    await step(P, 'Home: three cards, each short, with the rest one click away', async () => {
      await need();
      const o = await typeQuery('');
      const cards = [...o.querySelectorAll('.homecards > .hcard')];
      if (cards.length !== 3) throw new Error(`the home view has ${plural(cards.length, 'card')}, not three`);
      // Worth a look: the top three by priority, or why there are none, and the way to Problems.
      const look = await waitFor(() => (doc().querySelector('#lookBody .spin') ? null : doc().getElementById('lookBody')), { timeout: 60e3, what: 'the "Worth a look" card to fill' });
      const items = [...look.querySelectorAll('a.hitem')];
      if (items.length > 3) throw new Error(`"Worth a look" lists ${items.length} problems, not three at most`);
      if (items.some((a) => !/^problems\.html#[a-z][a-z0-9-]+$/.test(a.getAttribute('href')) || !a.querySelector('.prio') || !a.querySelector('.chip'))) throw new Error('a "Worth a look" item has no priority, no level, or doesn\'t link to its pattern');
      if (!look.querySelector('a[href="problems.html"]')) throw new Error('"Worth a look" has no link to the Problems page');
      const A = await api('problems', { summary: 1 });
      const found = A.patterns.filter((p) => p.status === 'found' && p.priority?.tier !== 'dismissed');
      // Only a pattern with a finding worth a look is listed; routine notes alone don't put one here.
      if (found.some((p) => Number(p.look) > 0) && !items.length) throw new Error('problems worth a look were found, but "Worth a look" lists none');
      if (items.length > found.filter((p) => Number(p.look) > 0).length) throw new Error('"Worth a look" lists a pattern with no finding worth a look');
      // Recent: five, then "See all" shows the rest.
      const rows = () => [...doc().querySelectorAll('.card.row[data-session]')];
      const shownRows = () => rows().filter((r) => !r.hidden).length;
      if (shownRows() > 5) throw new Error(`"Recent sessions" shows ${shownRows()} sessions before "See all"`);
      const all = doc().querySelector('#recentH')?.closest('.hcard').querySelector('[data-showall]');
      if (rows().length > 5) {
        if (!all) throw new Error('more than five recent sessions, and no "See all"');
        click(all);
        if (shownRows() !== rows().length) throw new Error('"See all" left recent sessions hidden');
        click(all);
      }
      const goals = [...doc().querySelectorAll('.card[data-goal]')];
      if (goals.filter((g) => !g.hidden).length > 3) throw new Error('"Your goals" shows more than three goals before "See all"');
      // The header counts the High patterns, the rule's or yours.
      const nav = doc().getElementById('navHigh');
      const high = A.patterns.filter((p) => p.status === 'found' && (JSON.parse(localStorage.getItem(PREFS_SLOT) ?? '{}')?.priority?.[p.id] ?? p.priority?.tier) === 'high').length;
      await waitFor(() => (high ? !nav.hidden && text(nav).startsWith(', ') : nav.hidden), { timeout: 10e3, what: "the header's Problems count" });
      if (high && Number(text(nav).match(/\d+/)?.[0]) !== high) throw new Error(`the header counts ${text(nav)}, not ${high} high`);
      return `${plural(items.length, 'problem')} worth a look; ${shownRows()} of ${plural(rows().length, 'recent session')} until "See all"; ${plural(goals.length, 'goal')}; the header counts ${high} high`;
    });
    await step(P, '"Try" buttons each run a search, and the address holds only a query id', async () => {
      const { d } = await need();
      const n = d.querySelectorAll('#hint [data-try]').length;
      if (!n) throw new Error('there are no "Try" buttons');
      const done = [];
      for (let i = 0; i < n; i++) {
        const b = doc().querySelectorAll('#hint [data-try]')[i];
        const q = b.dataset.try;
        typed.add(q);
        const o = await settle(() => click(b));
        if (doc().getElementById('q').value !== q) throw new Error(`"Try" put "${doc().getElementById('q').value}" in the box, not its own text`);
        if (!/^#q=[A-Za-z0-9_-]{4,64}~[lw]$/.test(new URL(doc().URL).hash)) throw new Error("the address doesn't carry the search's query id");
        const cards = windowCards(o).length + o.querySelectorAll('#everywhere .card').length;
        if (!cards) throw new Error(`Try button ${i + 1} of ${n} showed no result: "${text(o.querySelector('.lead') ?? o).slice(0, 140)}"`);
        done.push(cards);
      }
      return `${n} buttons, result cards: ${done.join(', ')}; the address held only a query id each time`;
    });
    await step(P, 'Reload and Back restore the search from its query id', async () => {
      await need();
      const q = example('pr') ?? env.words[0];
      if (!q) skip('no-word');
      const o = await typeQuery(q);
      const before = { box: doc().getElementById('q').value, lead: text(o.querySelector('.lead')), cards: windowCards(o).length };
      const old = doc();
      win().location.reload();
      await navigated(old, 'search.html', searchReady, { timeout: 30e3, what: 'the page to reload' });
      const o2 = doc().getElementById('out');
      if (doc().getElementById('q').value !== before.box) throw new Error(`after a reload the box reads "${doc().getElementById('q').value}"`);
      if (text(o2.querySelector('.lead')) !== before.lead || windowCards(o2).length !== before.cards) throw new Error('after a reload the results differ');
      // Open a result's replay, then Back.
      const a = o2.querySelector('.card a.t[href^="replay.html"]');
      if (!a) throw new Error('no result links to a replay');
      const old2 = doc();
      click(a);
      await navigated(old2, 'replay.html', (w, d) => (stopIfBroken(w, d), d.body.dataset.ready === '1'), { timeout: 60e3, what: 'the replay to open' });
      const old3 = doc();
      win().history.back();
      await navigated(old3, 'search.html', searchReady, { timeout: 30e3, what: 'Back to the search' });
      const o3 = doc().getElementById('out');
      if (doc().getElementById('q').value !== before.box) throw new Error(`after Back the box reads "${doc().getElementById('q').value}"`);
      if (text(o3.querySelector('.lead')) !== before.lead || windowCards(o3).length !== before.cards) throw new Error('after Back the results differ');
      return `"${before.lead.slice(0, 40)}" with ${plural(before.cards, 'card')} came back after a reload, and after opening a replay and pressing Back`;
    });
    let prDone = false;
    await step(P, 'Pull request lookup: sessions with evidence chips, each reason linked to its record', async () => {
      await need();
      const q = example('pr');
      if (!q) skip('no-pr');
      const o = await typeQuery(q);
      const lead = text(o.querySelector('.lead'));
      if (!/^Pull request \d+/.test(lead)) throw new Error(`the lookup reads "${lead.slice(0, 100)}"`);
      const k = countIn(o, /^Sessions that worked on it/);
      if (!k) throw new Error(`"Sessions that worked on it" is empty for ${q}`);
      const cards = windowCards(o);
      if (!cards.every((c) => c.querySelector('.chip'))) throw new Error('a session card carries no evidence chip');
      // Each result is one line, its level as a symbol with the word for a screen reader, and a
      // short reason that names the level; "More" shows every reason.
      const rrows = cards.filter((c) => c.matches('.rrow'));
      if (rrows.some((c) => !c.querySelector(':scope > .chip.sym svg.evsym') || !LEVELS.includes(text(c.querySelector(':scope > .chip.sym .sr'))))) throw new Error("a result's symbol has no word for a screen reader");
      if (rrows.some((c) => !/^(Recorded|Derived|Inferred|Missing): /.test(text(c.querySelector('.rwhy'))))) throw new Error("a result's short reason doesn't name its level");
      const more = rrows[0].querySelector('[data-more]');
      click(more);
      if (doc().getElementById(more.getAttribute('aria-controls')).hidden || more.getAttribute('aria-expanded') !== 'true') throw new Error('"More" didn\'t open the result');
      const acts = [...doc().getElementById(more.getAttribute('aria-controls')).querySelectorAll('.actions a')].map(text);
      if (!acts.includes('Replay from here')) throw new Error(`the opened result offers ${acts.join(', ')}, not "Replay from here"`);
      click(more);
      const reasons = o.querySelectorAll('.card li').length;
      const links = [...o.querySelectorAll('.card li a')].filter((a) => /^replay\.html\?session=[a-z]{2,4}-[a-p]+#th-[a-p]+~\S+$/.test(a.getAttribute('href'))).length;
      if (!reasons || links !== reasons) throw new Error(`${links} of ${plural(reasons, 'reason')} link to their record in the replay`);
      prDone = true;
      return `${lead}: ${plural(k, 'session')}; each of ${plural(reasons, 'reason')} has its level and links to its record`;
    });
    await step(P, '"See the record" opens the replay at that record', async () => {
      if (!prDone) skip('no-pr');
      await need();
      const o = await typeQuery(example('pr'));
      const a = reveal([...o.querySelectorAll('.card li a')].find((x) => /^replay\.html\?session=/.test(x.getAttribute('href'))));
      const id = a.getAttribute('href').split('~')[1];
      const old = doc();
      const t0 = Date.now();
      click(a);
      await navigated(old, 'replay.html', (w, d) => (stopIfBroken(w, d), d.body.dataset.ready === '1' && marks(d) > 0), { timeout: 60e3, what: 'the replay to open' });
      const dr = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: "the record's panel to open" });
      if (!dr.textContent.includes(id)) throw new Error('the panel shows a different record');
      return `the replay opened with that record's panel, in ${secs(t0)}`;
    });
    await step(P, 'Commit lookup, and a squash merge links to its pull request', async () => {
      await need();
      const c = example('commit');
      if (!c) skip('no-commit');
      const o = await typeQuery(c);
      if (!text(o.querySelector('.lead')).startsWith('Commit')) throw new Error(`the lookup reads "${text(o.querySelector('.lead')).slice(0, 100)}"`);
      const go = o.querySelector('.go[data-try]');
      if (!go) skip('no-squash');
      const pr = go.dataset.try;
      typed.add(pr);
      const o2 = await settle(() => click(go));
      if (!text(o2.querySelector('.lead')).startsWith(`Pull request ${pr.slice(1)}`)) throw new Error(`following the link shows "${text(o2.querySelector('.lead')).slice(0, 80)}"`);
      return `the commit names ${pr}; its link opened that pull request's lookup`;
    });
    await step(P, 'File lookup', async () => {
      await need();
      const f = example('file');
      if (!f) skip('no-file');
      const o = await typeQuery(f);
      const cards = windowCards(o).length;
      if (!cards) throw new Error(`no session listed for "${f.split(/[\\/]/).pop()}": "${text(o.querySelector('.lead')).slice(0, 100)}"`);
      return `a file: ${plural(cards, 'session card')}`;
    });
    await step(P, 'Branch lookup', async () => {
      await need();
      const b = await findBranch();
      if (!b) skip('no-branch');
      const o = await typeQuery(b);
      if (!windowCards(o).length) throw new Error(`typing a branch name found no session: "${text(o.querySelector('.lead') ?? o).slice(0, 90)}"`);
      return `a branch: ${plural(windowCards(o).length, 'session card')}`;
    });
    await step(P, 'Nothing found: one message that names the window and how to look further back', async () => {
      await need();
      const o = await typeQuery('qzxjv wkpfh');
      const leads = [...o.querySelectorAll('.lead')].filter((l) => !l.closest('#everywhere'));
      if (leads.length !== 1 || !/^Nothing between \w{3}, \w{3} \d+ and \w{3}, \w{3} \d+, \d{4} matches/.test(text(leads[0]))) throw new Error(`expected one "Nothing between … matches" line, got ${leads.length}: "${text(leads[0]).slice(0, 90)}"`);
      if (!env.demo && !/--days/.test(text(leads[0]))) throw new Error("the message doesn't suggest --days");
      const heads = [...o.querySelectorAll('h2')].filter((h) => !h.closest('#everywhere'));
      if (heads.length || windowCards(o).length) throw new Error(`it also shows ${plural(heads.length, 'empty section')} and ${plural(windowCards(o).length, 'card')}`);
      const box = doc().getElementById('everywhere');
      if (box?.querySelector('.card')) throw new Error('the search of every session found a nonsense word');
      return `"${text(leads[0]).replace(/"[^"]*"/, '"…"').slice(0, 110)}"`;
    });
    await step(P, 'Words show prompts with their levels, and "Similar prompts" opens', async () => {
      await need();
      const w = env.words[0];
      if (!w) skip('no-word');
      const o = await typeQuery(w);
      const k = countIn(o, /^Your prompts that use these words/);
      if (!k) throw new Error('no prompt matched the server\'s search word');
      const card = o.querySelector('[data-prompt]');
      if (!card.querySelector('.chip.inferred') || !card.querySelector('.chip.recorded')) throw new Error("a prompt's text and its shared-word score don't both carry a level");
      const sim = card.querySelector('[data-similar]');
      click(sim);
      await waitFor(() => doc().querySelector(`[data-simout="${CSS.escape(sim.dataset.similar)}"] .sim`), { timeout: 5000, what: '"Similar prompts" to open' });
      return `${plural(k, 'prompt')}, each with its text recorded and its score inferred; "Similar prompts" opened`;
    });
    // Every session on this machine: find a configured, a display-only and an outside result.
    const groups = {};
    await step(P, 'The search of every session labels each result by group, redacted or private as the switch says', async () => {
      await need();
      if (!env.words.length) skip('no-word');
      for (const w of env.words) {
        await typeQuery(w);
        const box = doc().getElementById('everywhere');
        if (!box) throw new Error('words gave no search of every session');
        const hint = text(box.querySelector('.hint'));
        if (env.privateOn !== /Private text is shown/.test(hint)) throw new Error(`with the switch ${env.privateOn ? 'on' : 'off'}, the section says "${hint.slice(0, 100)}"`);
        if (!/display-only repos \(a repository you marked display-only/.test(hint)) throw new Error('"display-only" isn\'t defined where the section first uses it');
        for (const c of box.querySelectorAll('.card[data-group]')) {
          const g = c.dataset.group;
          if (!['configured', 'display', 'outside'].includes(g)) throw new Error(`a result's group is "${g}"`);
          if (!/· in (your configured repos|a display-only repo|a folder outside your config)/.test(text(c.querySelector('.meta')))) throw new Error("a result doesn't say which group it belongs to");
          if (!c.querySelector('.chip')) throw new Error('a result carries no evidence level');
          if (!groups[g] && c.querySelector('a.t')) groups[g] = w;
        }
        if (groups.display && groups.outside && groups.configured) break;
      }
      return `groups found: ${Object.keys(groups).join(', ') || 'none'}`;
    });
    for (const [g, id] of [['display', 'no-display-session'], ['outside', 'no-outside-session']]) {
      await step(P, `A ${g === 'display' ? 'display-only' : 'outside'} session opens from the search of every session, with the switch ${env.privateOn ? 'on' : 'off'}`, async () => {
        if (!groups[g]) skip(id);
        await need();
        await typeQuery(groups[g]);
        const a = reveal(doc().querySelector(`#everywhere .card[data-group="${g}"] a.t`));
        const old = doc();
        const t0 = Date.now();
        click(a);
        const { w, d } = await navigated(old, 'replay.html', (w2, d2) => (stopIfBroken(w2, d2), d2.body.dataset.ready === '1' && marks(d2) > 0), { timeout: 120e3, what: 'the replay to draw' });
        if (w.HWP.on !== env.privateOn) throw new Error('the replay opened in the other mode');
        const leak = await noLeaks([...shownText(d.body), d.URL, ...eventParts([...w.HW.data.byId.values()])], 'its replay');
        return `drew ${plural(marks(d), 'step')} in ${secs(t0)}; ${leak}`;
      });
    }
    await step(P, 'Results hold no private word with the switch off, and no secret with it on', async () => {
      await need();
      const parts = [];
      for (const q of ['', ...env.words.slice(0, 2), example('pr')].filter((x) => x != null)) {
        const o = await typeQuery(q);
        parts.push(...shownText(o));
        parts.push(...[...o.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
      }
      return noLeaks(parts, `${plural(parts.length, 'result text and link')}`);
    });
    await step(P, 'Switch on: the search stays; storage holds only the key and the switch; the address no typed word', async () => {
      await need();
      const q = env.words[0] ?? example('pr');
      if (!q) skip('no-word');
      await typeQuery(q);
      const want = doc().getElementById('q').value;
      const flip = async (to) => {
        const old = doc();
        click(old.getElementById('privateSwitch'));
        await navigated(old, 'search.html', (w, d) => (stopIfBroken(w, d), d.body.dataset.ready === '1' && switched(w, to) && d.getElementById('out')?.dataset.state === 'done'), { timeout: BUILD_MS, what: `the page to reload with private text ${to ? 'on' : 'off'}` });
      };
      if (!env.privateOn) await flip(true);
      if (doc().getElementById('q').value !== want) throw new Error(`with the switch on, the box reads "${doc().getElementById('q').value}", not the search`);
      // A reference click with the switch on, then the storage and the address.
      const pr = example('pr');
      if (pr) {
        typeInto(doc().getElementById('q'), '');
        const b = [...doc().querySelectorAll('#hint [data-try]')].find((x) => x.dataset.try === pr);
        if (b) await settle(() => click(b));
      }
      const store = storageCheck();
      addressCheck();
      // Turning it off clears the box and the address.
      await flip(false);
      const box = doc().getElementById('q').value;
      const hash = new URL(doc().URL).hash;
      const problem = box || /q=/.test(hash) ? `after turning it off, the box reads "${box}" and the address "${hash}"` : null;
      if (env.privateOn) await flip(true);
      if (problem) throw new Error(problem);
      return `the search stayed when the switch went on; ${store}; turning it off emptied the box and the address`;
    });
    await step(P, 'Phone width (375 px)', async () => {
      if (!loaded) skip('page-did-not-load');
      const { d } = await openSearch(PHONE);
      const home = phoneCheck(d, ['#q', '#coverage', '#out']);
      const q = example('pr');
      if (q) {
        await typeQuery(q);
        phoneCheck(doc(), ['#q', '#out']);
      }
      return `home view: ${home}${q ? '; a pull request lookup fits too' : ''}`;
    });
  }

  // ---- the goal page --------------------------------------------------------------------------
  const goalReady = (w, d) => {
    stopIfBroken(w, d, { allow: ['no-goal-list'] });
    if (d.querySelector('[data-fatal="no-goal-list"]')) return switched(w, env.privateOn);
    return d.body.dataset.ready === '1' && switched(w, env.privateOn) && text(d.getElementById('goalMeta')) !== 'Loading…' && !!d.querySelector('#panel h2');
  };
  const openGoal = (size = DESKTOP) => ensure('goal.html', goalReady, { size, timeout: BUILD_MS, what: 'the goal page' });
  const goalLoaded = () => waitFor(() => text(doc().getElementById('goalMeta')) !== 'Loading…' && doc().querySelector('#panel h2'), { timeout: 30e3, what: 'the goal to load' });
  async function goalSteps() {
    const P = 'goal';
    let loaded = false;
    let noList = false;
    await step(P, 'Loads without errors', async () => {
      const t0 = Date.now();
      const { d } = await openGoal();
      loaded = true;
      noList = !!d.querySelector('[data-fatal="no-goal-list"]');
      return noList ? 'no goal list: the page explains what one is' : `ready in ${secs(t0)}`;
    });
    const need = (size) => (loaded ? openGoal(size) : skip('page-did-not-load'));
    await step(P, 'Header: pages, window, switch, the five-word key, the demo notice', async () => headerCheck((await need()).d, 'goal.html'));
    await step(P, 'With no goal list, the page says what one is and how to give one', async () => {
      const { d } = await need();
      const f = d.querySelector('[data-fatal="no-goal-list"]');
      if (!f) {
        if (env.home && env.home.goalList?.given === false) throw new Error('the server has no goal list, but the page shows goals');
        return 'a goal list is set, so the page shows goals (its empty state is checked by a node test)';
      }
      if (!/goal list is a JSON file/.test(text(f)) || !/--goals/.test(text(f)) || !/--demo/.test(text(f))) throw new Error(`the empty state reads "${text(f).slice(0, 120)}"`);
      return 'explains the goal list, --goals, and the demo';
    });
    const needGoals = async (size) => {
      const r = await need(size);
      if (noList) skip('no-goal-list');
      return r;
    };
    await step(P, "Every goal: chart, panel, each member's level equal to the engine's, your assignments, unmatched citations", async () => {
      const { d } = await needGoals();
      const keys = [...d.getElementById('goal').options].map((o) => o.value);
      if (!keys.length) throw new Error('the goal selector is empty');
      const problems = [];
      const notes = [];
      for (const [i, k] of keys.entries()) {
        choose(doc().getElementById('goal'), k);
        await goalLoaded();
        const dd = doc();
        const a = await api('goal', { key: k });
        const g = a.goal && typeof a.goal === 'object' ? a.goal : a;
        const members = g.members ?? [];
        const shown = [...dd.querySelectorAll('#panel .member')];
        if (shown.length !== members.length) problems.push(`goal ${i + 1}: ${shown.length} of ${members.length} sessions in the panel`);
        if (members.length && !marks(dd)) problems.push(`goal ${i + 1}: no steps drawn`);
        if (dd.querySelectorAll('#chart text.head[data-session]').length !== members.length) problems.push(`goal ${i + 1}: the chart's session rows don't match`);
        for (const m of members) {
          const el = shown.find((x) => x.dataset.member === m.session);
          if (!el) continue;
          const lv = [...el.querySelectorAll(':scope > div:first-child .chip')].map((c) => text(c));
          if (lv[0] !== m.evidence) problems.push(`goal ${i + 1}: a member shows "${lv[0]}", the engine says "${m.evidence}"`);
          if (!!m.ambiguous !== lv.includes('ambiguous')) problems.push(`goal ${i + 1}: a member's ambiguity differs from the engine's`);
          const mine = m.assigned === true || (m.joins ?? []).some((j) => j.type === 'cited-session');
          if (mine !== !!el.querySelector(':scope > div:first-child .tag.mine')) problems.push(`goal ${i + 1}: a member's "your assignment" label differs from the goal list`);
        }
        const um = dd.querySelectorAll('#panel [data-unmatched]').length;
        if (um !== (g.unmatched ?? []).length) problems.push(`goal ${i + 1}: ${um} of ${(g.unmatched ?? []).length} unmatched citations listed`);
        if (um && ![...dd.querySelectorAll('#panel [data-unmatched]')].every((li) => li.querySelector('.chip.missing') && li.querySelector('.tag.mine'))) problems.push(`goal ${i + 1}: an unmatched citation isn't shown as missing and yours`);
        if (!new RegExp(`^#${k}(~|$)`).test(new URL(dd.URL).hash)) problems.push(`goal ${i + 1}: the address doesn't name its key`);
        notes.push(`${members.length}/${um}`);
      }
      if (problems.length) throw new Error(problems.join('; '));
      return `${plural(keys.length, 'goal')} (sessions/unmatched: ${notes.join(', ')}); every level, ambiguity and assignment matches the engine`;
    });
    await step(P, 'Unfolding a session shows its lanes, and a lane its tools', async () => {
      const { d } = await needGoals();
      click(d.getElementById('closeAll'));
      const head = doc().querySelector('#chart text.head[data-session]');
      if (!head) throw new Error('no session row');
      const k = head.dataset.session;
      const lanes = () => [...doc().querySelectorAll('#chart text[data-lane]')].filter((t) => t.dataset.lane.startsWith(`${k}|`));
      if (lanes().length) throw new Error('"Fold sessions" left lanes open');
      head.focus();
      key(head, 'Enter', 'Enter');
      if (!lanes().length) throw new Error('Enter on the session row opened no lanes');
      const n = lanes().length;
      const lane = lanes().filter((t) => !t.classList.contains('helpers')).find((t) => Number(text(t.nextElementSibling)) > 0) ?? lanes()[0];
      click(lane);
      if (!doc().querySelectorAll('#chart text.row-label:not(.head):not(.lane)').length) throw new Error('clicking a lane opened no tool rows');
      // Helpers share one row until it's opened into a lane each.
      const helpers = lanes().find((t) => t.classList.contains('helpers'));
      let helperNote = 'no helpers in this session';
      if (helpers) {
        const before = lanes().length;
        click(helpers);
        const opened = lanes().length - before;
        if (opened < 1) throw new Error('opening the helpers row showed no helper lane');
        click(doc().querySelector(`#chart text.helpers[data-lane="${CSS.escape(helpers.dataset.lane)}"]`));
        if (lanes().length !== before) throw new Error('clicking the helpers row again didn\'t fold them');
        helperNote = `the helpers row opened ${plural(opened, 'helper lane')} and folded them again`;
      }
      click(doc().querySelector(`#chart text.head[data-session="${CSS.escape(k)}"]`));
      if (lanes().length) throw new Error("clicking the session row again didn't fold it");
      click(doc().getElementById('openAll'));
      click(doc().getElementById('closeAll'));
      if (doc().querySelectorAll('#chart text[data-lane]').length) throw new Error('"Fold sessions" left lanes open');
      return `Enter opened ${plural(n, 'lane')}; a lane opened into tool rows; ${helperNote}; "Open" and "Fold sessions" work`;
    });
    await step(P, 'Every step can be focused and opened with Enter; the screen-reader list matches the chart', async () => {
      await needGoals();
      click(doc().getElementById('openAll'));
      const r = await chartKeyboard();
      click(doc().getElementById('closeAll'));
      return r;
    });
    await step(P, 'Clicking a step opens its record; Escape closes it', async () => {
      const { d } = await needGoals();
      const mark = d.querySelector('#chart .mark[data-id]');
      if (!mark) throw new Error('no step drawn');
      return drawerCheck(mark);
    });
    await step(P, 'A side-panel record opens from the keyboard', async () => {
      const { d } = await needGoals();
      const link = d.querySelector('#panel [data-id]');
      if (!link) throw new Error('the side panel has no record link');
      return keyboardRecord(link);
    });
    await step(P, 'Step and prompt buttons move the playhead', async () => (await needGoals(), stepButtons(doc().querySelectorAll('#chart .mark').length > 2 ? 2 : 0)));
    await step(P, 'Space presses a focused button; with nothing focused it plays', async () => (await needGoals(), spaceAndPlay()));
    await step(P, 'Play, then Pause', async () => (await needGoals(), playPause()));
    await step(P, 'The slider has aria-valuetext', async () => (await needGoals(), sliderCheck()));
    await step(P, 'Zoom changes the view and zooms back out', async () => (await needGoals(), zoomCheck()));
    await step(P, 'Folded gaps: a click unfolds one; the checkbox shows them all', async () => {
      const { d } = await needGoals();
      click(d.getElementById('fit'));
      let found = false;
      for (const o of [...d.getElementById('goal').options]) {
        choose(doc().getElementById('goal'), o.value);
        await goalLoaded();
        if (doc().querySelector('#chart .brk')) {
          found = true;
          break;
        }
      }
      if (!found) skip('no-gaps');
      const n = doc().querySelectorAll('#chart .brk').length;
      click(doc().querySelector('#chart .brk rect'));
      if (doc().querySelectorAll('#chart .brk').length !== n - 1) throw new Error('clicking a gap didn\'t unfold it');
      click(doc().getElementById('collapse'));
      if (doc().querySelectorAll('#chart .brk').length) throw new Error('unticking "Fold gaps" left gaps folded');
      click(doc().getElementById('collapse'));
      return `${plural(n, 'folded gap')}; a click unfolded one; the checkbox unfolds and folds them`;
    });
    await step(P, 'The goal page holds no private word with the switch off, and no secret with it on', async () => {
      const { d } = await needGoals();
      const seen = [];
      for (const o of [...d.getElementById('goal').options]) {
        choose(doc().getElementById('goal'), o.value);
        await goalLoaded();
        seen.push(doc().URL, ...shownText(doc().getElementById('panel')), ...[...doc().querySelectorAll('#chart text')].flatMap(shownText), ...shownText(doc().getElementById('chartSteps')));
      }
      return noLeaks(seen, "every goal's panel, chart labels, step list and address");
    });
    await step(P, 'The header switch flips private text and back', async () => {
      await needGoals();
      return headerSwitch('goal.html', (w, d) => d.body.dataset.ready === '1' && text(d.getElementById('goalMeta')) !== 'Loading…');
    });
    await step(P, 'Phone width (375 px)', async () => {
      const { d } = await needGoals(PHONE);
      const a = phoneCheck(d, ['#goal', '#play', '#nextStep', '#slider', '#chart', '#panel']);
      click(doc().getElementById('openAll'));
      phoneCheck(doc(), ['#goal', '#play', '#chart']);
      return `${a}; with every session open too`;
    });
  }

  // ---- the replay page --------------------------------------------------------------------------
  const replayReady = (w, d) => (stopIfBroken(w, d, { allow: ['no-thread'] }), switched(w, env.privateOn) && (d.body.dataset.ready === '1' && marks(d) > 0 || !!d.querySelector('[data-fatal="no-thread"]')));
  const openReplay = (addr = '', size = DESKTOP) => ensure(`replay.html${addr}`, replayReady, { size, timeout: 120e3, what: 'the replay to draw' });
  const allEvents = () => [...win().HW.data.byId.values()];
  /** Open the record of the first event a test picks, in any of these replays. */
  async function findAndOpen(threads, pick) {
    for (const th of threads) {
      await openReplay(`#${th}`);
      const e = allEvents().find(pick);
      if (!e) continue;
      const m = doc().querySelector(`#chart .mark[data-id="${CSS.escape(e.id)}"]`);
      if (m) {
        click(m);
      } else win().HW.openEvent(e.id);
      const dr = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: 'the record panel to open' });
      await waitFor(() => !/Reading the log line/.test(text(dr.querySelector('[data-record]'))), { timeout: 10e3, what: 'the record to be read' });
      return { e, dr, m };
    }
    return null;
  }
  const rowOf = (dr, label) => [...dr.querySelectorAll('dt')].filter((dt) => text(dt) === label).map((dt) => dt.nextElementSibling);
  async function replaySteps() {
    const P = 'replay';
    const threads = [...new Set((env.home?.recent ?? []).map((s) => s.thread).filter(Boolean))];
    const multi = threads.filter((t) => (env.home?.recent ?? []).filter((s) => s.thread === t).length > 1);
    const pick = [...new Set([...multi, ...threads])].slice(0, 4);
    let loaded = false;
    await step(P, 'With no thread chosen, it opens the most recent thread, or says there is none', async () => {
      const t0 = Date.now();
      const { d } = await openPage('replay.html', { ready: replayReady, timeout: 120e3, what: 'the replay to draw' });
      loaded = true;
      if (d.querySelector('[data-fatal="no-thread"]')) {
        if (!/^Nothing between/.test(text(d.querySelector('[data-fatal]'))) || !d.querySelector('[data-fatal] a[href="search.html"]')) throw new Error(`the empty state reads "${text(d.querySelector('[data-fatal]')).slice(0, 100)}"`);
        return 'no thread in this window: the page names the window and points to search';
      }
      if (!/^#th-[a-p]+$/.test(new URL(d.URL).hash)) throw new Error("the address doesn't name the thread it shows");
      const a = await api('replay');
      if (a.thread && new URL(d.URL).hash !== `#${a.thread.id}`) throw new Error("it opened a thread other than the server's most recent");
      return `the most recent thread, ${plural(marks(d), 'step')}, ready in ${secs(t0)}`;
    });
    for (const th of pick) {
      await step(P, `A thread loads (${pick.indexOf(th) + 1} of ${pick.length})`, async () => {
        const t0 = Date.now();
        const { d } = await openReplay(`#${th}`);
        if (!d.getElementById('undrawn').hidden) throw new Error(`the page warns "${text(d.getElementById('undrawn'))}"`);
        if (!text(d.getElementById('title'))) throw new Error('no title');
        if (!text(d.getElementById('catalogSummary'))) throw new Error('no catalog summary');
        return `${plural(marks(d), 'step')}, ${plural(d.querySelectorAll('#chart .turnseg').length, 'turn')}; ready in ${secs(t0)}`;
      });
    }
    await step(P, 'A thread of several sessions: one main lane each, a session-start rule, the panel follows', async () => {
      if (!multi.length) skip('single-session');
      const { w, d } = await openReplay(`#${multi[0]}`);
      const n = [...w.HW.data.agentByKey.values()].filter((a) => a.kind === 'main').length;
      if (!text(d.getElementById('title')).endsWith(`· ${n} sessions`)) throw new Error(`the title doesn't end "· ${n} sessions"`);
      if (d.querySelectorAll('#chart line.sessrule').length < n - 1) throw new Error('no session-start rule');
      if (d.getElementById('legendSession').hidden) throw new Error('the legend leaves out the session-start rule');
      slide(d.getElementById('slider'), 1000);
      if (!text(doc().getElementById('panel')).includes(`Session ${n} of ${n}`)) throw new Error(`at the end, the panel doesn't say "Session ${n} of ${n}"`);
      return `${n} sessions, ${n} main lanes, a session-start rule; the panel follows the playhead into session ${n}`;
    });
    const need = () => (loaded && pick.length ? openReplay(`#${pick[0]}`) : skip('page-did-not-load'));
    await step(P, 'Header: pages, window, switch, the five-word key, the demo notice', async () => headerCheck((await need()).d, 'replay.html'));
    await step(P, 'Every step can be focused and opened with Enter; the screen-reader list matches the chart', async () => {
      await need();
      click(doc().getElementById('expandAll'));
      const r = await chartKeyboard();
      click(doc().getElementById('collapseAll'));
      return r;
    });
    await step(P, 'Clicking a step opens its record; Escape and Back close it', async () => {
      const { d } = await need();
      const base = new URL(d.URL).hash.slice(1).split('~')[0];
      const mark = d.querySelector('#chart .mark[data-id]:not([data-gitop])');
      const out = await drawerCheck(mark, { hashBase: base });
      click(doc().querySelector(`#chart .mark[data-id="${CSS.escape(mark.dataset.id)}"]`));
      await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 2000, what: 'the panel to open again' });
      win().history.back();
      await waitFor(() => !doc().querySelector('.drawer.open'), { timeout: 3000, what: 'Back to close the panel' });
      return `${out}; Back closed it too`;
    });
    await step(P, "A command step's record shows its output, redacted and shortened", async () => {
      const r = await findAndOpen(pick, (e) => e.kind === 'action' && (e.cat === 'shell' || e.facts?.category === 'shell'));
      if (!r) skip('no-command-step');
      const out = r.dr.querySelector('.output pre');
      if (!out) throw new Error("the record panel shows no output for a command step");
      const leak = await noLeaks(shownText(r.dr), "the command step's panel");
      return `the panel shows ${text(out).length} characters of output; ${leak}`;
    });
    await step(P, 'A prompt with a recorded human origin says "You"', async () => {
      const r = await findAndOpen(pick, (e) => e.kind === 'prompt' && e.actor === 'person' && !win().HW.authorship(e));
      if (!r) skip('no-prompt');
      const who = rowOf(r.dr, 'Who')[0];
      if (!/^You\b/.test(text(who)) || !who.querySelector('.chip.recorded')) throw new Error(`the Who row reads "${text(who)}"`);
      return `"${text(who).slice(0, 60)}"`;
    });
    await step(P, 'A prompt whose author is only inferred says "You", marked inferred with its rule', async () => {
      const r = await findAndOpen(threads, (e) => e.kind === 'prompt' && win().HW.authorship(e)?.value === 'person');
      if (!r) skip('no-inferred-author');
      const who = rowOf(r.dr, 'Who')[0];
      if (!/^You\b/.test(text(who)) || !who.querySelector('.chip.inferred') || !/because/.test(text(who))) throw new Error(`the Who row reads "${text(who)}"`);
      return `"${text(who).slice(0, 80)}"`;
    });
    await step(P, 'A prompt from a non-interactive run says "a person or a script"', async () => {
      const r = await findAndOpen(threads, (e) => e.kind === 'prompt' && win().HW.authorship(e)?.value === 'person-or-script');
      if (!r) skip('no-script-prompt');
      const who = rowOf(r.dr, 'Who')[0];
      if (!/^A person or a script/.test(text(who)) || !who.querySelector('.chip.inferred')) throw new Error(`the Who row reads "${text(who)}"`);
      return `"${text(who).slice(0, 80)}"`;
    });
    await step(P, 'A step whose time was borrowed from a neighbouring line says so, on the chart and in its record', async () => {
      const r = await findAndOpen(threads, (e) => e.timeFrom === 'previous-record' || e.timeFrom === 'next-record');
      if (!r) skip('no-borrowed-time');
      if (!rowOf(r.dr, 'How the time is known').some((dd) => /borrowed from the line (before|after)/.test(text(dd)))) throw new Error("the record doesn't say its time was borrowed");
      if (r.m && !r.m.classList.contains('timeby')) throw new Error("the chart doesn't mark the step's borrowed time");
      return 'the record and the chart both say the time was borrowed';
    });
    await step(P, 'A sub-agent step moved after the call that started it says so', async () => {
      const r = await findAndOpen(threads, (e) => !!e.clock);
      if (!r) skip('no-moved-time');
      if (!rowOf(r.dr, 'How the time is known').some((dd) => /moved it to just after that call/.test(text(dd)))) throw new Error("the record doesn't say its time was moved");
      if (r.m && !r.m.classList.contains('timeby')) throw new Error("the chart doesn't mark the moved step");
      return 'the record and the chart both say the step was moved after its starting call';
    });
    await step(P, 'A side-panel record opens from the keyboard', async () => {
      await need();
      slide(doc().getElementById('slider'), 1000);
      let li = doc().querySelector('#panel [data-id]');
      if (!li) skip('nothing-in-progress');
      return keyboardRecord(li);
    });
    await step(P, 'Zoom changes the view and zooms back out', async () => (await need(), zoomCheck()));
    await step(P, 'Clicking a turn zooms to it', async () => {
      const { d } = await need();
      click(d.getElementById('fit'));
      const seg = doc().querySelector('#chart .turnseg rect');
      if (!seg) skip('no-turns');
      click(seg);
      if (doc().getElementById('zoombar').hidden && doc().querySelectorAll('#chart .turnseg').length > 1) throw new Error("clicking a turn didn't zoom in");
      click(doc().getElementById('fit'));
      return 'the turn filled the view; the zoom-out button returned to the whole replay';
    });
    await step(P, 'Step and prompt buttons move the playhead', async () => {
      await need();
      const T0 = Math.min(...allEvents().map((e) => e.t));
      return stepButtons(allEvents().filter((e) => e.kind === 'prompt' && e.t > T0).length);
    });
    await step(P, 'Space presses a focused button; with nothing focused it plays', async () => (await need(), spaceAndPlay()));
    await step(P, 'Play, then Pause', async () => (await need(), playPause()));
    await step(P, 'The slider has aria-valuetext', async () => (await need(), sliderCheck()));
    await step(P, 'Lanes open one row per tool; Expand all and Collapse all', async () => {
      const { d } = await need();
      const subs = () => doc().querySelectorAll('#chart text.row-label:not(.head)').length;
      click(d.getElementById('collapseAll'));
      if (subs()) throw new Error('"Collapse all" left tool rows open');
      let one = 0;
      for (const k of [...doc().querySelectorAll('#chart text.head[data-lane]')].map((t) => t.dataset.lane)) {
        const t = doc().querySelector(`#chart text.head[data-lane="${CSS.escape(k)}"]`);
        t.focus();
        key(t, 'Enter', 'Enter');
        one = subs();
        if (one) break;
        key(doc().querySelector(`#chart text.head[data-lane="${CSS.escape(k)}"]`), 'Enter', 'Enter');
      }
      if (!one) throw new Error('Enter on a lane name opened no rows');
      click(doc().getElementById('expandAll'));
      const all = subs();
      if (all < one) throw new Error('"Expand all" showed fewer rows than one lane');
      click(doc().getElementById('collapseAll'));
      if (subs()) throw new Error('"Collapse all" left tool rows open');
      if (!doc().getElementById('undrawn').hidden) throw new Error(`the page warns "${text(doc().getElementById('undrawn'))}"`);
      return `Enter on a lane opened ${plural(one, 'row')}; "Expand all" ${plural(all, 'row')}; "Collapse all" closed them`;
    });
    await step(P, 'Helpers share one row until it opens; every helper lane is in it', async () => {
      let found = null;
      for (const th of threads) {
        const { w } = await openReplay(`#${th}`);
        const subs = [...w.HW.data.agentByKey.values()].filter((a) => a.kind !== 'main');
        if (subs.length) {
          found = { th, subs };
          break;
        }
      }
      if (!found) {
        // The demo week has sub-agents on purpose; on other logs a replay may have none.
        if (env.demo) throw new Error('no replay opened here has a helper (sub-agent)');
        return 'no replay opened here has a helper, so there is no helpers row';
      }
      click(doc().getElementById('collapseAll'));
      const row = doc().querySelector('#chart text.helpers[data-lane="helpers"]');
      if (!row) throw new Error('a replay with helpers has no helpers row');
      if (row.getAttribute('aria-expanded') !== 'false' || row.getAttribute('role') !== 'button') throw new Error('the helpers row is not a folded button');
      const laneKeys = () => [...doc().querySelectorAll('#chart text.head[data-lane]')].map((t) => t.dataset.lane);
      if (found.subs.some((a) => laneKeys().includes(a.key))) throw new Error('a helper has its own lane while the helpers row is folded');
      row.focus();
      key(row, 'Enter', 'Enter');
      const missing = found.subs.filter((a) => !laneKeys().includes(a.key));
      if (missing.length) throw new Error(`opening the helpers row left ${plural(missing.length, 'helper')} without a lane`);
      if (!doc().getElementById('undrawn').hidden) throw new Error(`the page warns "${text(doc().getElementById('undrawn'))}"`);
      click(doc().getElementById('collapseAll'));
      if (!doc().querySelector('#chart text.helpers[aria-expanded="false"]')) throw new Error('"Collapse all" left the helpers open');
      return `${plural(found.subs.length, 'helper')} folded into one row; Enter opened a lane for each; "Collapse all" folded them again`;
    });
    await step(P, "The record panel sits beside the timeline, and Previous and Next step move through the steps", async () => {
      const { d } = await need();
      const mark = d.querySelector('#chart .mark[data-id]:not([data-gitop])');
      click(mark);
      const dr = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: 'the record panel to open' });
      if (!dr.closest('#side')) throw new Error('the record panel is not in the side column beside the timeline');
      const first = text(doc().getElementById('drawerTitle')) + dr.textContent.match(/[a-z]{2,4}-[a-p]{4,64}\.[\w.:-]+/)?.[0];
      const next = dr.querySelector('[data-nav="1"]');
      if (!next) throw new Error('the record panel has no Next step');
      if (next.disabled) throw new Error('Next step is disabled on an early step');
      const was = doc().getElementById('readout').textContent;
      click(next);
      const dr2 = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: 'the next record' });
      const second = text(doc().getElementById('drawerTitle')) + dr2.textContent.match(/[a-z]{2,4}-[a-p]{4,64}\.[\w.:-]+/)?.[0];
      if (second === first) throw new Error('Next step showed the same record');
      if (doc().activeElement !== dr2.querySelector('[data-nav="1"]') && doc().activeElement !== dr2.querySelector('[data-nav="-1"]')) throw new Error(`after Next step, focus is on ${describeEl(doc().activeElement)}`);
      click(dr2.querySelector('[data-nav="-1"]'));
      await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: 'the previous record' });
      key(doc().activeElement ?? doc().body, 'Escape', 'Escape');
      await waitFor(() => !doc().querySelector('.drawer.open'), { timeout: 3000, what: 'Escape to close the panel' });
      return `Next step moved from the record at ${was} and Previous step came back; the panel sits in the side column`;
    });
    await step(P, 'The catalog hides and shows a kind of record', async () => {
      const { d } = await need();
      const det = d.getElementById('catalog');
      if (!det.open) click(det.querySelector('summary'));
      const box = [...doc().querySelectorAll('[data-fam]')].find((b) => !b.disabled && b.checked);
      if (!box) throw new Error('the catalog lists no kind to hide');
      const before = marks(doc());
      click(box);
      const after = marks(doc());
      if (after >= before) throw new Error('hiding a kind left every step drawn');
      click(doc().querySelector(`[data-fam="${CSS.escape(box.dataset.fam)}"]`));
      if (marks(doc()) !== before) throw new Error("showing the kind again didn't bring its steps back");
      click(doc().querySelector('#catalog summary'));
      return `hiding a kind took ${before - after} steps away, and showing it brought them back`;
    });
    await step(P, 'The replays hold no private word with the switch off, and no secret with it on', async () => {
      const parts = [];
      for (const th of pick) {
        await openReplay(`#${th}`);
        parts.push(...shownText(doc().body), doc().URL, ...eventParts(allEvents()));
      }
      return noLeaks(parts, `${plural(pick.length, 'replay')}: titles, labels, steps and addresses`);
    });
    await step(P, 'The header switch flips private text and back', async () => {
      await need();
      return headerSwitch('replay.html', (w, d) => d.body.dataset.ready === '1' && marks(d) > 0);
    });
    await step(P, 'A thread that isn\'t there shows a message with a way back', async () => {
      const { d } = await openPage('replay.html#th-pppppppppp', { ready: (w, dd) => !!dd.querySelector('[data-fatal]'), timeout: 30e3, what: 'the failure message' });
      const msg = text(d.querySelector('[data-fatal]'));
      if (!/couldn't be loaded|Nothing between/.test(msg)) throw new Error(`the page shows "${msg.slice(0, 120)}"`);
      if (!d.querySelector('.topbar nav a[href="search.html"]') || !d.querySelector('[data-fatal] a[href="search.html"]')) throw new Error('the message leaves no way back');
      return `"${msg.slice(0, 110)}"`;
    });
    await step(P, 'Phone width (375 px)', async () => {
      if (!loaded || !pick.length) skip('page-did-not-load');
      const { d } = await openReplay(`#${pick[0]}`, PHONE);
      const a = phoneCheck(d, ['#play', '#nextStep', '#zoom', '#slider', '#chart', '#panel']);
      if (multi.length) {
        await openReplay(`#${multi[0]}`, PHONE);
        phoneCheck(doc(), ['#play', '#zoom', '#chart']);
      }
      return `${a}${multi.length ? '; a thread of several sessions fits too' : ''}`;
    });
  }

  // ---- the problems page -------------------------------------------------------------------------
  const problemsReady = (w, d) => (stopIfBroken(w, d), switched(w, env.privateOn) && d.body.dataset.ready === '1' && d.querySelectorAll('#cards details.pcard').length > 0);
  /** The problems page at exactly this address: ?session= changes what it lists, so a frame on
   *  another address is never reused. */
  async function openProblems(addr = '', size = DESKTOP) {
    try {
      const u = new URL(doc().URL);
      if (frame.offsetWidth === size.width && u.pathname.endsWith('/problems.html') && u.search === addr.split('#')[0] && problemsReady(win(), doc())) return { w: win(), d: doc() };
    } catch {}
    return openPage(`problems.html${addr}`, { size, ready: problemsReady, timeout: BUILD_MS, what: 'the problems page' });
  }
  const cardIds = (d) => [...d.querySelectorAll('#cards details.pcard')].map((c) => c.dataset.pattern);
  /** Open a pattern's card and wait for its body. */
  async function openCard(id) {
    let c = doc().getElementById(id);
    if (!c) throw new Error(`no card for ${id}`);
    // A low-priority row is one click away, and a list of patterns not found is a fold.
    if (c.closest('section.tier[hidden]')) {
      const low = doc().querySelector('#cards [data-low]');
      if (!low) throw new Error(`${id} is hidden with no "Show low-priority problems"`);
      click(low);
      c = doc().getElementById(id);
      if (c.closest('section.tier[hidden]')) throw new Error('"Show low-priority problems" left the low tier hidden');
    }
    for (let d = c.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) if (!d.open) click(d.querySelector('summary'));
    if (!c.open) click(c.querySelector('summary'));
    if (!c.open) c.open = true;
    return waitFor(() => (c.querySelector('[data-body]')?.dataset.filled === '1' ? c : null), { timeout: 3000, what: "the card's body" });
  }
  const tierOfCard = (id) => doc().getElementById(id)?.closest('section.tier')?.dataset.tier ?? null;
  async function problemsSteps() {
    const P = 'problems';
    let loaded = false;
    let A = null;
    await step(P, 'The page lists every pattern, grouped by priority, with the stated rule', async () => {
      const t0 = Date.now();
      const { d } = await openProblems();
      loaded = true;
      A = await api('problems');
      const n = cardIds(d).length;
      if (n !== A.patterns.length) throw new Error(`${n} cards for ${A.patterns.length} patterns`);
      if (!/How priority is set/.test(text(d.getElementById('priRule')))) throw new Error('the stated rule is missing');
      const found = A.patterns.filter((p) => p.status === 'found');
      for (const p of found) if (!['t-high', 't-medium', 't-low', 't-dismissed'].includes(tierOfCard(p.id)) && !doc().getElementById(p.id)?.closest('details.dismissed')) throw new Error(`the found pattern ${p.id} sits outside the High, Medium and Low groups`);
      for (const p of A.patterns.filter((x) => x.status !== 'found')) if (tierOfCard(p.id) !== `t-${p.status}`) throw new Error(`${p.id} (${p.status}) sits in ${tierOfCard(p.id)}`);
      const order = [...d.querySelectorAll('#cards section.tier')].map((s) => s.dataset.tier);
      const want = ['t-high', 't-medium', 't-low', 't-clear', 't-unchecked', 't-undetectable'].filter((t) => order.includes(t));
      if (order.join() !== want.join()) throw new Error(`the groups come in the order ${order.join(', ')}`);
      return `${plural(n, 'card')}: ${found.length} found (in ${order.filter((t) => /high|medium|low/.test(t)).join(', ') || 'no tier'}), then ${order.filter((t) => !/high|medium|low/.test(t)).join(', ')}; ready in ${secs(t0)}`;
    });
    const need = (addr = '') => (loaded ? openProblems(addr) : skip('page-did-not-load'));
    await step(P, 'Header: pages, window, switch, the five-word key, the demo notice', async () => headerCheck((await need()).d, 'problems.html'));
    await step(P, 'Start with these: the top three High, each with a fix idea and a way to see it happen', async () => {
      const { d } = await need();
      const mine = JSON.parse(localStorage.getItem(PREFS_SLOT) ?? '{}')?.priority ?? {};
      const high = A.patterns.filter((p) => p.status === 'found' && (mine[p.id] ?? p.priority?.tier) === 'high');
      const box = d.getElementById('startWith');
      if (!high.length) {
        if (!box.hidden) throw new Error('"Start with these" shows with no High pattern');
        if (!d.getElementById('navHigh').hidden) throw new Error('the header counts High patterns when there are none');
        return 'no High pattern in this window: "Start with these" stays hidden, and so does the header count';
      }
      const cards = [...box.querySelectorAll('.scard')];
      if (box.hidden || cards.length !== Math.min(3, high.length)) throw new Error(`"Start with these" shows ${cards.length} of ${Math.min(3, high.length)}`);
      if (cards.some((c) => !c.querySelector('.prio.t-high'))) throw new Error('a "Start with these" card isn\'t High');
      const see = cards.filter((c) => c.querySelector('a.btn.primary[href^="replay.html?session="]')).length;
      if (!see) throw new Error('no "Start with these" card links to its step in the replay');
      const det = cards[0].querySelector('a[data-open]');
      click(det);
      const id = det.dataset.open;
      await waitFor(() => (doc().getElementById(id)?.open ? true : null), { timeout: 3000, what: 'Details to open the row' });
      const nav = doc().getElementById('navHigh');
      if (Number(text(nav).match(/\d+/)?.[0] ?? 0) !== high.length) throw new Error(`the header counts "${text(nav)}", not ${high.length} high`);
      return `${plural(cards.length, 'card')}, ${see} with "See it happen"; Details opened the row; the header counts ${text(nav).match(/\d+/)?.[0]} high`;
    });
    await step(P, 'Low priority, routine notes and the lists of patterns not found are each one click away', async () => {
      const { d } = await need();
      const low = d.getElementById('tier-low');
      const lowBtn = d.querySelector('#cards [data-low]');
      let note = 'no low-priority pattern';
      if (low && lowBtn) {
        if (!low.hidden) throw new Error('the low tier shows before anyone asked');
        click(lowBtn);
        if (doc().getElementById('tier-low').hidden) throw new Error('"Show low-priority problems" left them hidden');
        click(doc().querySelector('#cards [data-low]'));
        if (!doc().getElementById('tier-low').hidden) throw new Error('"Hide low-priority problems" left them showing');
        note = 'the low tier opened and closed';
      }
      const lists = [...doc().querySelectorAll('#cards details.restlist')];
      if (lists.some((l) => l.open)) throw new Error('a list of patterns not found is open before anyone asked');
      const routine = doc().querySelector('#cards [data-routine-all]');
      if (routine) {
        click(routine);
        if (!doc().getElementById('cards').classList.contains('show-routine')) throw new Error('"Show routine notes" showed none');
        click(doc().querySelector('#cards [data-routine-all]'));
      }
      if (!doc().getElementById('priRule').matches('details') || doc().getElementById('priRule').open) throw new Error('"How priority is set" isn\'t one click away');
      return `${note}; ${plural(lists.length, 'folded list')}${routine ? '; the routine notes switch works' : ''}; "How priority is set" is folded`;
    });
    await step(P, 'Group and status filters narrow the list and say so', async () => {
      const { d } = await need();
      const groups = [...d.querySelectorAll('#groups [data-group]')].filter((b) => b.dataset.group);
      if (groups.length !== A.groups.length) throw new Error(`${groups.length} group buttons for ${A.groups.length} groups`);
      const g = A.groups[1] ?? A.groups[0];
      click(doc().querySelector(`#groups [data-group="${CSS.escape(g.id)}"]`));
      const inGroup = A.patterns.filter((p) => p.group === g.id).map((p) => p.id).sort();
      if (cardIds(doc()).sort().join() !== inGroup.join()) throw new Error(`the ${g.name} filter shows other cards`);
      if (!text(doc().getElementById('filterNote')).includes(g.name)) throw new Error("the note doesn't name the group");
      if (doc().querySelector(`#groups [data-group="${CSS.escape(g.id)}"]`).getAttribute('aria-pressed') !== 'true') throw new Error("the group button isn't marked pressed");
      click(doc().querySelector('#groups [data-group=""]'));
      click(doc().querySelector('#statusFilter [data-status="unchecked"]'));
      const un = A.patterns.filter((p) => p.status === 'unchecked').length;
      if (cardIds(doc()).length !== un) throw new Error(`"No check here yet" shows ${cardIds(doc()).length} cards, not ${un}`);
      click(doc().querySelector('#statusFilter [data-status=""]'));
      if (cardIds(doc()).length !== A.patterns.length) throw new Error('"Any status" left cards out');
      return `"${g.name}" showed its ${inGroup.length} patterns; "No check here yet" showed ${un}; both reset`;
    });
    const firstFound = () => A?.patterns.find((p) => p.status === 'found' && (p.findings ?? []).some((f) => f.thread && f.event)) ?? A?.patterns.find((p) => p.status === 'found');
    await step(P, "A found pattern's card: what it looks like, why it matters, how it's detected, the findings, fix ideas and sources", async () => {
      await need();
      const p = firstFound();
      if (!p) skip('no-problem-found');
      const c = await openCard(p.id);
      const heads = [...c.querySelectorAll('h3')].map(text);
      for (const h of ['What it looks like', 'Why it matters', "How strong the evidence is that it's common", "How it's detected here", 'This window', 'Fix ideas', 'Sources']) if (!heads.includes(h)) throw new Error(`the card has no "${h}"`);
      const items = c.querySelectorAll('ol.findings li.finding');
      if (!items.length) throw new Error('the card lists no finding');
      if (!c.querySelector('ol.findings a[href^="replay.html?session="]') && p.findings.some((f) => f.thread)) throw new Error('no finding links to its replay');
      const src = c.querySelectorAll('ol.srcs li').length;
      const links = [...c.querySelectorAll('ol.srcs a')];
      if (links.some((a) => a.target !== '_blank' || !/noreferrer/.test(a.rel))) throw new Error('a source link opens in this tab or sends a referrer');
      if (!c.querySelector('.draft pre')) throw new Error('no draft fix');
      if (!c.querySelector('.pwhy')) throw new Error('no priority reason in the summary');
      return `"${text(c.querySelector('.ptitle'))}": ${plural(items.length, 'finding')}, a draft fix, ${plural(src, 'source')} (${links.length} with a link)`;
    });
    await step(P, '"plus N routine": routine notes are counted apart from findings worth a look', async () => {
      const { d } = await need();
      const p = A.patterns.find((x) => x.status === 'found' && x.notesFound > 0);
      if (!p) skip('no-routine-note');
      const tally = text(d.getElementById(p.id).querySelector('.tally'));
      if (!tally.includes(`${p.look} worth a look`) || !tally.includes(`plus ${p.notesFound} routine`)) throw new Error(`the card reads "${tally}"`);
      return `"${tally}"`;
    });
    await step(P, '"My priority" moves a card and keeps only the pattern id and the tier; the rule\'s own tier clears it', async () => {
      await need();
      const p = firstFound();
      if (!p) skip('no-problem-found');
      const before = localStorage.getItem(PREFS_SLOT);
      const rule = p.priority.tier;
      const to = rule === 'high' ? 'low' : 'high';
      choose(doc().querySelector(`[data-pri="${CSS.escape(p.id)}"]`), to);
      await waitFor(() => tierOfCard(p.id) === `t-${to}`, { timeout: 3000, what: `the card to move to ${to}` });
      const stored = JSON.parse(localStorage.getItem(PREFS_SLOT) ?? 'null');
      if (stored?.priority?.[p.id] !== to) throw new Error(`${PREFS_SLOT} doesn't hold the override`);
      const bad = prefsProblem();
      if (bad) throw new Error(bad);
      if (!/you set this/.test(text(doc().getElementById(p.id).querySelector('.pwhy')))) throw new Error('the card doesn\'t say "you set this"');
      choose(doc().querySelector(`[data-pri="${CSS.escape(p.id)}"]`), rule);
      await waitFor(() => tierOfCard(p.id) === `t-${rule}`, { timeout: 3000, what: 'the card to move back' });
      const after = JSON.parse(localStorage.getItem(PREFS_SLOT) ?? '{}');
      if (after?.priority?.[p.id]) throw new Error("the rule's own tier didn't clear the override");
      return `moved to ${to} and back to the rule's ${rule}; ${PREFS_SLOT} held the pattern id and the tier, nothing else${before == null ? '' : ' (other overrides untouched)'}`;
    });
    await step(P, "A finding's replay link opens the replay at that step, its record open", async () => {
      await need();
      const p = firstFound();
      if (!p) skip('no-problem-found');
      const c = await openCard(p.id);
      const a = c.querySelector('ol.findings a[href^="replay.html?session="][href*="~"]:not([data-zoomlink])');
      if (!a) skip('no-strip-finding');
      const id = decodeURIComponent(a.getAttribute('href').split('~')[1] ?? '');
      const old = doc();
      click(a);
      await navigated(old, 'replay.html', replayReady, { timeout: 120e3, what: 'the replay at the step' });
      const dr = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 5000, what: "the step's record to open" });
      if (!dr.textContent.includes(id)) throw new Error('the replay opened a different record');
      return 'the replay opened at the finding\'s step with its record';
    });
    await step(P, '"Zoom to these steps" marks only the finding\'s steps, steps through them, and Esc and Back undo it', async () => {
      await need();
      // The finding with the most recorded steps among the ones the cards list.
      let pick = null;
      for (const p of A.patterns.filter((x) => x.status === 'found')) {
        const c = await openCard(p.id);
        for (const a of c.querySelectorAll('ol.findings a[data-zoomlink]')) {
          const f = (p.findings ?? []).find((x) => x.key === a.getAttribute('href').split('~zoom~')[1]);
          if (f && (!pick || f.zoom.events.length > pick.f.zoom.events.length)) pick = { a, f, p };
        }
        if (pick && pick.f.zoom.events.length > 1) break;
      }
      if (!pick) skip('no-strip-finding');
      const { f, p } = pick;
      // Words this change shows with every fold closed: the cards' zoom buttons on the Problems
      // page's first load, then the replay's zoom bar.
      const words = (t) => String(t ?? '').split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length;
      const cardWords = [...doc().querySelectorAll('#startWith [data-zoomlink]')].filter((a) => a.offsetParent).reduce((n, a) => n + words(a.innerText), 0);
      const y = Math.round(win().scrollY);
      const old = doc();
      click(pick.a);
      const { d } = await navigated(old, 'replay.html', (w, dd) => replayReady(w, dd) && !dd.getElementById('zoomFinding').hidden, { timeout: 120e3, what: 'the replay zoomed to the finding' });
      const thread = new URL(d.URL).hash.slice(1).split('~')[0];
      const want = new Set(f.zoom.lanes.filter((l) => l.thread === thread).flatMap((l) => l.events));
      const bar = d.getElementById('zoomFinding');
      const barWords = words(bar.innerText);
      if (!new URL(d.URL).hash.includes(`~zoom~${f.key}`)) throw new Error('the address lost the finding');
      const why = bar.querySelector('details.zwhy');
      if (!text(bar).includes(f.verdictEvidence) || !why || why.open || !text(why.querySelector('p'))) throw new Error(`the bar doesn't show the finding's level with how the steps are known in a closed "?": "${text(bar).slice(0, 120)}"`);
      const lit = [...d.querySelectorAll('#chart .mark[data-id]')].filter((m) => m.getAttribute('opacity') !== '0.3').map((m) => m.dataset.id);
      const extra = lit.filter((id) => !want.has(id));
      if (extra.length) throw new Error(`${extra.length} step${extra.length === 1 ? '' : 's'} the finding doesn't include stand out too`);
      if (!lit.length || d.querySelectorAll('#chart .zoomhalo').length !== lit.length) throw new Error(`${lit.length} marks stand out and ${d.querySelectorAll('#chart .zoomhalo').length} are ringed`);
      if (!/Zoomed to/.test(text(d.getElementById('announce')))) throw new Error('nothing was announced');
      // Step through: Next goes to the first step, opens its record and says "step 1 of N".
      const ids = [...want].sort((a2, b2) => lit.indexOf(a2) - lit.indexOf(b2));
      click(bar.querySelector('[data-zdir="1"]'));
      const dr = await waitFor(() => d.querySelector('.drawer.open'), { timeout: 5000, what: "the first step's record" });
      if (!/^1 of/.test(text(bar.querySelector('.zpos')))) throw new Error(`the position reads "${text(bar.querySelector('.zpos'))}"`);
      if (!ids.some((id) => dr.textContent.includes(id))) throw new Error("the record open isn't one of the finding's steps");
      if (d.activeElement?.closest('#zoomFinding') == null) throw new Error('focus left the step-through control');
      if (want.size > 1) {
        click(bar.querySelector('[data-zdir="1"]'));
        await waitFor(() => /^2 of/.test(text(bar.querySelector('.zpos'))), { timeout: 3000, what: 'step 2' });
      }
      // Esc closes the record, then leaves the zoom and clears the marks.
      key(d.body, 'Escape', 'Escape');
      if (d.querySelector('.drawer.open')) key(d.body, 'Escape', 'Escape');
      key(d.body, 'Escape', 'Escape');
      await waitFor(() => bar.hidden, { timeout: 3000, what: 'Esc to leave the zoom' });
      if (d.querySelector('#chart .zoomhalo') || d.querySelector('#chart .mark[opacity="0.3"]')) throw new Error('marks are left after leaving the zoom');
      if (new URL(d.URL).hash.includes('~zoom~')) throw new Error('the address still names the finding');
      // Back returns to the Problems page, with the pattern open where the reader was.
      const oldR = doc();
      win().history.back();
      const back = await navigated(oldR, 'problems.html', problemsReady, { timeout: BUILD_MS, what: 'Back to the problems page' });
      await waitFor(() => back.d.getElementById(p.id)?.open, { timeout: 3000, what: 'the pattern to be open again' });
      const dy = Math.abs(Math.round(back.w.scrollY) - y);
      if (dy > 80) throw new Error(`Back came to a different place: ${dy}px from where the link was clicked`);
      // At phone width the zoom bar fits.
      const ph = await openPage(new URL(pick.a.href).pathname.split('/').pop() + new URL(pick.a.href).search + new URL(pick.a.href).hash, { size: PHONE, ready: (w, dd) => replayReady(w, dd) && !dd.getElementById('zoomFinding').hidden, timeout: 120e3, what: 'the zoom at phone width' });
      phoneCheck(ph.d, ['#zoomFinding', '#zoomFinding [data-zleave]', '#chart']);
      return `${plural(lit.length, 'step')} marked of ${f.zoom.total ?? '?'} the check matched (${f.verdictEvidence}), stepped through, Esc cleared them, Back returned ${dy}px from the click, and the bar fits at 375 px; visible words added: ${cardWords} on the Problems page's cards, ${barWords} in the zoom bar`;
    });
    await step(P, "One session's findings: ?session= narrows the page and says so", async () => {
      const p = firstFound();
      if (!p) skip('no-problem-found');
      const f = p.findings.find((x) => x.session);
      const { d } = await need(`?session=${encodeURIComponent(f.session)}`);
      const note = d.getElementById('sessFilter');
      if (note.hidden || !/Showing one session/.test(text(note))) throw new Error(`the note reads "${text(note).slice(0, 100)}"`);
      for (const id of cardIds(d)) await openCard(id);
      const all = [...doc().querySelectorAll('li.finding')];
      if (!all.length || all.some((li) => li.dataset.session !== f.session)) throw new Error('a finding from another session shows');
      return `"${text(note).slice(0, 90)}"; ${plural(all.length, 'finding')}, all from that session`;
    });
    await step(P, 'The page holds no private word with the switch off, and no secret with it on', async () => {
      const { d } = await need();
      for (const id of cardIds(d)) await openCard(id);
      const findings = A.patterns.flatMap((p) => p.findings ?? []).map((f) => ({ note: f.note, text: f.text, rule: f.rule }));
      const parts = [...shownText(doc().body), doc().URL, ...[...doc().querySelectorAll('a[href]')].map((a) => a.getAttribute('href')), ...findings];
      return noLeaks(parts, `${plural(cardIds(doc()).length, 'card')} opened, their findings and links`);
    });
    await step(P, 'The header switch flips private text and back', async () => {
      await need();
      return headerSwitch('problems.html', (w, d) => d.body.dataset.ready === '1' && d.querySelectorAll('#cards details.pcard').length > 0);
    });
    await step(P, 'Phone width (375 px)', async () => {
      if (!loaded) skip('page-did-not-load');
      const { d } = await openProblems('', PHONE);
      const p = firstFound();
      if (p) await openCard(p.id);
      return phoneCheck(d, ['#groups', '#statusFilter', '#cards']);
    });
  }

  // ---- the "Worth a look" strip on the replay and goal pages -----------------------------------
  const stripLoaded = (d) => {
    const b = d.getElementById('wlBadgeBtn');
    return !!b && !/^Checking/.test(text(b));
  };
  async function stripOn() {
    const t = doc().getElementById('wlToggle');
    if (t.getAttribute('aria-pressed') !== 'true') click(t);
    await waitFor(() => doc().getElementById('wlToggle').getAttribute('aria-pressed') === 'true', { timeout: 3000, what: 'the strip to show' });
  }
  const stripMarks = () => [...doc().querySelectorAll('#wlSvg [data-k], #wlSvg [data-c]')];
  async function stripSteps() {
    const P = 'strip';
    const A = await api('problems');
    const finding = A.patterns.flatMap((p) => (p.findings ?? []).map((f) => ({ ...f, tier: p.priority?.tier }))).filter((f) => f.thread && f.event && f.severity === 'look').sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.tier] - ({ high: 0, medium: 1, low: 2 })[b.tier])[0] ?? null;
    const wasOn = JSON.parse(localStorage.getItem(PREFS_SLOT) ?? '{}')?.strip === true;
    const wasLow = JSON.parse(localStorage.getItem(PREFS_SLOT) ?? '{}')?.low === true;
    const addr = finding ? `?session=${encodeURIComponent(finding.session)}#${finding.thread}` : '';
    const open = (size) => (finding ? ensure(`replay.html${addr}`, (w, d) => replayReady(w, d) && stripLoaded(d), { size, timeout: 120e3, what: 'the replay and its strip' }) : skip('no-strip-finding'));
    /** Show the strip, with low-priority findings too when the one this test follows is low. */
    async function shown() {
      await open();
      await stripOn();
      const low = doc().querySelector('#wlFoot [data-low]');
      if (finding.tier === 'low' && low && !low.checked) click(low);
      return waitFor(() => (stripMarks().length ? stripMarks() : null), { timeout: 3000, what: 'a mark on the strip' });
    }
    await step(P, 'The replay header counts findings worth a look for the sessions on screen', async () => {
      const { d } = await open();
      const b = text(d.getElementById('wlBadgeBtn'));
      if (!/^(\d+ (high|medium|low)(, )?)+ worth a look$|^Nothing worth a look$/.test(b)) throw new Error(`the badge reads "${b}"`);
      return `"${b}"`;
    });
    await step(P, 'The switch shows the strip: each finding a named button, filled for facts and hollow for a rule', async () => {
      const marks = await shown();
      const bad = marks.filter((m) => m.getAttribute('role') !== 'button' || m.getAttribute('tabindex') !== '0' || !/^Worth a look|findings worth a look/.test(m.getAttribute('aria-label') ?? ''));
      if (bad.length) throw new Error(`${plural(bad.length, 'mark')} aren't named buttons`);
      for (const m of doc().querySelectorAll('#wlSvg .wl-dot')) {
        const fill = m.querySelector('.wl-mark').getAttribute('fill');
        const fact = /worked out from the log's facts/.test(m.getAttribute('aria-label'));
        if (fact === (fill === 'var(--surface)')) throw new Error('a mark is filled for a rule\'s guess, or hollow for a fact');
      }
      if (doc().getElementById('wlToggle').getAttribute('aria-pressed') !== 'true') throw new Error("the switch isn't marked pressed");
      return `${plural(marks.length, 'mark')}, each a named button; fill matches how each is known`;
    });
    await step(P, "A mark's card opens from the keyboard: pattern, what the log shows, how it's known, a fix idea; Escape closes it", async () => {
      await shown();
      const m = doc().querySelector('#wlSvg [data-k]');
      if (!m) skip('no-strip-finding');
      m.focus();
      key(m, 'Enter', 'Enter');
      const card = await waitFor(() => doc().querySelector('.wl-card'), { timeout: 3000, what: 'the card to open' });
      if (card.getAttribute('role') !== 'dialog' || !text(card.querySelector('h3'))) throw new Error('the card is no named dialog');
      const dts = [...card.querySelectorAll('dt')].map(text);
      for (const want of ['What the log shows here', "How it's known"]) if (!dts.includes(want)) throw new Error(`the card has no "${want}"`);
      if (!card.querySelector('[data-jump]') || !card.querySelector('a[href^="problems.html"]')) throw new Error('the card has no Jump to step or pattern link');
      const leak = await noLeaks(shownText(card), "a strip card");
      key(doc().activeElement ?? doc().body, 'Escape', 'Escape');
      await waitFor(() => !doc().querySelector('.wl-card'), { timeout: 2000, what: 'Escape to close the card' });
      if (!doc().activeElement?.closest?.('#wlSvg')) throw new Error(`after Escape, focus is on ${describeEl(doc().activeElement)}`);
      return `"${text(card.querySelector('h3'))}": ${dts.join(', ')}; ${leak}; Escape closed it and focus went back to the mark`;
    });
    await step(P, 'Jump to step moves the playhead to the step and opens its record', async () => {
      await shown();
      const m = doc().querySelector('#wlSvg [data-k]');
      if (!m) skip('no-strip-finding');
      click(m);
      const card = await waitFor(() => doc().querySelector('.wl-card'), { timeout: 3000, what: 'the card to open' });
      const jump = card.querySelector('[data-jump]');
      if (jump.disabled) skip('no-strip-finding');
      click(jump);
      const dr = await waitFor(() => doc().querySelector('.drawer.open'), { timeout: 3000, what: "the step's record to open" });
      const t = text(dr.querySelector('#drawerTitle'));
      key(dr.querySelector('[data-close]'), 'Escape', 'Escape');
      return `the record "${t}" opened`;
    });
    await step(P, "The card links to the pattern's card on the Problems page", async () => {
      await shown();
      const m = doc().querySelector('#wlSvg [data-k]');
      if (!m) skip('no-strip-finding');
      click(m);
      const card = await waitFor(() => doc().querySelector('.wl-card'), { timeout: 3000, what: 'the card to open' });
      const a = card.querySelector('a[href^="problems.html#"]');
      const id = a.getAttribute('href').split('#')[1];
      const old = doc();
      click(a);
      await navigated(old, 'problems.html', problemsReady, { timeout: BUILD_MS, what: 'the problems page' });
      const c = await waitFor(() => (doc().getElementById(id)?.open ? doc().getElementById(id) : null), { timeout: 3000, what: 'the pattern card to open' });
      return `opened "${text(c.querySelector('.ptitle'))}" on the Problems page`;
    });
    await step(P, 'Crowded marks merge into a count that zooms in or lists them', async () => {
      await shown();
      const c = doc().querySelector('#wlSvg [data-c]');
      if (!c) skip('no-crowded-marks');
      const before = doc().getElementById('zoombar').hidden;
      click(c);
      await waitFor(() => doc().querySelector('.wl-card') || doc().getElementById('zoombar').hidden !== before, { timeout: 3000, what: 'the count to zoom in or list its findings' });
      key(doc().activeElement ?? doc().body, 'Escape', 'Escape');
      click(doc().getElementById('fit'));
      return 'the count zoomed in or listed its findings';
    });
    await step(P, 'The strip holds no private word with the switch off, and no secret with it on', async () => {
      await shown();
      const labels = stripMarks().map((m) => m.getAttribute('aria-label'));
      return noLeaks([...shownText(doc().getElementById('wl')), ...labels, ...shownText(doc().getElementById('wlBadge'))], 'the strip, its labels and its badge');
    });
    await step(P, 'The goal page shows the strip for its sessions', async () => {
      const { d } = await openGoal();
      if (d.querySelector('[data-fatal="no-goal-list"]')) skip('no-goal-list');
      await goalLoaded();
      await waitFor(() => stripLoaded(doc()), { timeout: 30e3, what: "the goal page's strip" });
      const b = text(doc().getElementById('wlBadgeBtn'));
      if (!/worth a look/i.test(b)) throw new Error(`the badge reads "${b}"`);
      return `"${b}"`;
    });
    await step(P, 'Phone width (375 px), then the strip set back the way it was', async () => {
      if (!finding) skip('no-strip-finding');
      const { d } = await open(PHONE);
      const r = phoneCheck(d, ['#wlToggle', '#wlBadgeBtn']);
      // Put the switches back as this browser had them.
      const t = doc().getElementById('wlToggle');
      const low = doc().querySelector('#wlFoot [data-low]');
      if (low && low.checked !== wasLow) click(low);
      if ((t.getAttribute('aria-pressed') === 'true') !== wasOn) click(t);
      const bad = prefsProblem();
      if (bad) throw new Error(bad);
      return `${r}; the strip is ${wasOn ? 'on' : 'off'} again, as it was`;
    });
  }

  // ---- first run: what someone sees on their first `view` after `init` -----------------------
  // The while-it-builds check runs before the data is ready, from run() below; the rest run
  // here. Each skips, with a named reason, when its case doesn't apply to this run's config.
  const READING_LINE = /into this program's memory: \d+ s so far\. The page fills in when it's ready\./;
  /** The words a page shows with every fold closed, as a person reads them on first load. */
  const wordsShown = (d) => (d.body.innerText.match(/\S+/g) ?? []).length;

  /** Settings: the header reaches it; it shows the config and names a change before saving.
   *  It saves only a config this run wrote itself (the setup step's), so a run on someone's
   *  own config changes nothing; then the week reloads with the new window, no restart. */
  async function settingsSteps() {
    await step('settings', 'Settings: reached from the header; names the change; saves; the week reloads with it', async () => {
      if (env.demo) skip('no-settings');
      const { d: find } = await openSearch();
      const link = find.querySelector('nav a[href="settings.html"]');
      if (!link) throw new Error('the header has no Settings link');
      click(link);
      await waitFor(() => onPage(doc(), 'settings.html') && ['1', 'closed'].includes(doc().body.dataset.ready), { timeout: 60e3, what: 'Settings to draw' });
      const d = doc();
      const $ = (id) => d.getElementById(id);
      if (d.body.dataset.ready !== '1') throw new Error(`Settings is closed: "${text($('lead')).slice(0, 160)}"`);
      const words = wordsShown(d);
      if (!d.querySelectorAll('#repos .reporow select').length) throw new Error('no repository with a role menu');
      if (!/@/.test($('emails').value)) throw new Error('the emails are not shown');
      if (d.getElementById('wordsFold').open) throw new Error('the private words are not folded away');
      choose($('histKind'), 'days');
      typeInto($('histDays'), '14');
      click($('previewBtn'));
      await waitFor(() => !$('changes').hidden || !$('problem').hidden, { what: 'the list of changes' });
      if (!$('problem').hidden) throw new Error(`review was refused: "${text($('problem')).slice(0, 160)}"`);
      const listed = text($('changes'));
      if (!/How far back: .* to the last 14 days\./.test(listed)) throw new Error(`the changes read "${listed.slice(0, 160)}"`);
      if (!env.setupDone) return `${words} words on first load; named "${listed.slice(0, 80)}"; not saved, since this config was here before the test`;
      click($('saveBtn'));
      await waitFor(() => onPage(doc(), 'search.html') && doc().body.dataset.ready === '1', { timeout: BUILD_MS, what: 'Find to open on the reloaded week' });
      const st = await api('status');
      const days = Math.round((Date.parse(`${st.window.to}T00:00:00Z`) - Date.parse(`${st.window.from}T00:00:00Z`)) / 86400000) + 1;
      if (days !== 14 && !st.window.note) throw new Error(`the reloaded window is ${st.window.from} to ${st.window.to}`);
      return `${words} words on first load; saved "${listed.slice(0, 80)}"; reloaded ${st.window.from} to ${st.window.to} with no restart`;
    });
  }

  /** A folder with no config: another page sends you to Setup, which proposes the repositories,
   *  the email and the timezone, previews the file with the private words typed, saves, and lands
   *  on Find on the same server. Nothing typed reaches an address (the step's address check). */
  async function setupSteps() {
    await step('setup', 'Setup: another page sends you here; preview, save, and you land on your week', async () => {
      if (!env.setupPending) skip('already-set-up');
      newFrame(DESKTOP);
      frame.src = '/search.html';
      await waitFor(() => onPage(doc(), 'setup.html') && doc().body.dataset.ready === '1', { timeout: 60e3, what: 'Find to send the page to Setup' });
      const d = doc();
      const $ = (id) => d.getElementById(id);
      const rows = d.querySelectorAll('#repos .reporow');
      if (!rows.length) throw new Error(`no repository is proposed: "${text($('found')).slice(0, 120)}"`);
      for (const r of rows) if (!r.querySelector('select[aria-label]') || !r.querySelector('button[aria-label]')) throw new Error('a repository row has no labelled role or Remove');
      const words = wordsShown(d);
      // The roles and the private words are explained behind a closed "?", one click away.
      const roles = d.querySelector('#rolesHelp details.help:not([open])');
      if (!roles || !/featured: .*reference: .*display: /s.test(roles.textContent)) throw new Error('the three roles are not one click away');
      if (!/@/.test($('emails').value)) typeInto($('emails'), 'you@example.com');
      if (!$('timezone').value) throw new Error('the timezone is not prefilled');
      if (!/hides these/.test(d.querySelector('#wordsHelp details.help')?.textContent ?? '')) throw new Error('the private-words explanation is not one click away');
      if ($('histKind').value !== 'week') throw new Error(`how far back starts on "${$('histKind').value}", not the last week`);
      // Phone width: nothing runs off the side.
      frame.style.width = `${PHONE.width}px`;
      await sleep(100);
      const wide = d.documentElement.scrollWidth;
      frame.style.width = `${DESKTOP.width}px`;
      if (wide > PHONE.width + 1) throw new Error(`at ${PHONE.width} px the page is ${wide} px wide`);
      typeInto($('names'), 'Dana Doe');
      typeInto($('terms'), 'Acme');
      if (!$('saveBtn').disabled) throw new Error('Save is on before a preview');
      click($('previewBtn'));
      await waitFor(() => !$('preview').hidden || !$('problem').hidden, { what: 'the preview' });
      if (!$('problem').hidden) throw new Error(`the preview was refused: "${text($('problem')).slice(0, 160)}"`);
      const shown = $('previewText').textContent;
      if (!shown.includes('"Dana Doe"') || !shown.includes('"authorEmails"')) throw new Error('the preview does not show the file it will write');
      if ($('saveBtn').disabled) throw new Error('Save stays off after the preview');
      click($('saveBtn'));
      await waitFor(() => onPage(doc(), 'search.html') && doc().body.dataset.ready === '1', { timeout: BUILD_MS, what: 'Find to open on your week after Save' });
      const after = await api('status');
      if (after.setup) throw new Error('the server still says setup is pending');
      env.setupPending = false;
      env.setupDone = true;
      return `${words} words on first load; ${rows.length} ${rows.length === 1 ? 'repository' : 'repositories'} proposed; the preview showed the file; saved, and Find opened on your week with no restart`;
    });
  }
  async function watchTheWait() {
    const P = 'first run';
    await step(P, "While the data builds, the page says what it's reading and for how long", async () => {
      const s = await api('status');
      const red = s.builds?.redacted ?? s;
      if (red.state === 'ready' || red.state === 'failed') skip('built-before-test');
      const reading = typeof red.reading === 'string' ? red.reading : '';
      if (!/^Reading /.test(reading) || !/\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/.test(reading)) throw new Error(`the server's reading line is "${reading.slice(0, 120)}"`);
      newFrame(DESKTOP);
      frame.src = '/search.html';
      let seen = '';
      await waitFor(() => {
        const d = doc();
        const t = text(d?.getElementById('status'));
        if (READING_LINE.test(t)) seen = t;
        return !!seen || d?.body?.dataset.ready === '1';
      }, { timeout: BUILD_MS, what: 'the page to show its wait or its data' });
      if (!seen) skip('built-before-test');
      if (!seen.includes(reading.replace(/\.$/, ''))) throw new Error(`the wait line reads "${seen.slice(0, 160)}"`);
      return `"${seen.slice(0, 150)}"`;
    });
  }
  async function firstRunSteps() {
    const P = 'first run';
    const s = await api('status');
    const cmd = typeof s.command === 'string' && s.command ? s.command : 'honestweek';
    await step(P, 'The home page says what to type, and offers a first search or says why it has none', async () => {
      const { d } = await openSearch();
      const ph = d.getElementById('q')?.getAttribute('placeholder') ?? '';
      if (!/pull request/i.test(ph) || !/words/i.test(ph)) throw new Error(`the search box's hint reads "${ph}"`);
      const o = await typeQuery('');
      const tries = doc().querySelectorAll('#hint [data-try]').length;
      if (tries) return `the box asks for "${ph}"; ${plural(tries, '"Try" button')} offer a first search`;
      const empty = [...o.querySelectorAll('.empty')].map(text).find((t) => /^Nothing between/.test(t));
      if (!empty || !empty.includes(`${cmd} view --days 30`)) throw new Error(`no "Try" buttons, and the home view doesn't say why: "${text(o).slice(0, 160)}"`);
      return `no "Try" buttons; the home view says "${empty.slice(0, 120)}"`;
    });
    await step(P, 'Every session card says when it ran, and one with no prompt says what opened it', async () => {
      await openSearch();
      const cards = [];
      const o = await typeQuery('');
      cards.push(...windowCards(o));
      const b = doc().querySelector('#hint [data-try]');
      if (b) {
        typed.add(b.dataset.try);
        cards.push(...windowCards(await settle(() => click(b))));
      }
      const sessions = cards.filter((c) => c.dataset.session);
      if (!sessions.length) throw new Error('no session card to check');
      for (const c of sessions) {
        const meta = text(c.querySelector('.meta'));
        if (!/\d{1,2}:\d{2}\s?[AP]M/.test(meta) || /·\s*$|·\s*·/.test(meta)) throw new Error(`a session card's line reads "${meta.slice(0, 120)}"`);
        if (/(^|· )0 prompts\b/.test(meta)) throw new Error(`a session card says "0 prompts" instead of what opened it: "${meta.slice(0, 120)}"`);
      }
      const opened = sessions.filter((c) => /started (with|by) |no prompt between/.test(text(c.querySelector('.meta')))).length;
      return `${plural(sessions.length, 'card')} each say when; ${opened} say what opened a session with no prompt`;
    });
    await step(P, 'With no private words set up, every page says so and how to add them', async () => {
      const pw = s.privateWords;
      if (env.demo || !pw || pw.count > 0) skip('private-words-set');
      if (typeof pw.note !== 'string' || !/redaction/.test(pw.note) || !/honestweek\.config\.json/.test(pw.note)) throw new Error(`the server's note reads "${String(pw.note).slice(0, 160)}"`);
      const seen = [];
      for (const [page, open] of [['search.html', () => openSearch()], ['goal.html', () => openGoal()], ['replay.html', () => openReplay()]]) {
        const { d } = await open();
        const el = d.getElementById('privatewords');
        if (!el || el.hidden || text(el) !== pw.note) throw new Error(`${page} doesn't show the note${el ? `: "${text(el).slice(0, 120)}"` : ''}`);
        seen.push(page);
      }
      return `${seen.join(', ')}: "${pw.note.slice(0, 110)}…"`;
    });
    await step(P, 'With no goal list, the goals page says what one is and the command that gives one', async () => {
      if (s.goalList?.given) skip('goal-list-set');
      const { d } = await openGoal();
      const f = d.querySelector('[data-fatal="no-goal-list"]');
      if (!f) throw new Error('the server has no goal list, but the page shows no empty state');
      const t = text(f);
      if (!/goal list is a JSON file/.test(t) || !t.includes(`${cmd} view --goals`) || !t.includes(`${cmd} view --demo`) || !/honestweek\.config\.json/.test(t)) throw new Error(`the empty state reads "${t.slice(0, 160)}"`);
      return `names ${cmd} view --goals, goalsFile in honestweek.config.json, and the demo`;
    });
  }

  // ---- the run --------------------------------------------------------------------------------
  async function run() {
    window.CLICKTHROUGH_RESULT = { done: false };
    let ok = false;
    try {
      ok = await step('setup', 'This tab has the run key, and the server answers', async () => {
        const state = await window.HWP.ready;
        if (state !== 'ready') throw new Error(window.HWP.notice(state));
        env.startSwitch = window.HWP.read();
        if (WANT === '1' || WANT === '0') window.HWP.store(WANT === '1');
        env.privateOn = window.HWP.read();
        const s = await api('status');
        // In demo mode the status carries the demo notice; outside it, null.
        env.demo = !!s.demo && typeof s.demo === 'object';
        // The commands a page names are written the way honestweek was run.
        env.command = typeof s.command === 'string' && s.command ? s.command : 'honestweek';
        env.setupPending = s.setup === true;
        return `${env.demo ? 'the demo week' : 'your own logs'}; "Show private text" is ${env.privateOn ? 'on' : 'off'} for this run${WANT ? ' (from ?private=)' : ''}`;
      });
      if (ok) {
        // Setup comes first when the folder has no config: every other page waits on it.
        if (!ONLY || ONLY === 'setup' || env.setupPending) await setupSteps();
        if (!ONLY || ONLY === 'first-run') await watchTheWait();
        await step('setup', 'The data is built', async () => {
          const t0 = Date.now();
          for (;;) {
            const s = await api('status');
            const red = s.redacted && typeof s.redacted === 'object' ? s.redacted : s;
            const prv = s.private && typeof s.private === 'object' ? s.private : null;
            const want = env.privateOn && prv ? prv : red;
            if (want.state === 'ready' || want.ready === true) break;
            if (want.state === 'failed') throw new Error(`the ${env.privateOn ? 'private' : 'redacted'} build failed: ${want.failed ?? ''}`);
            if (Date.now() - t0 > BUILD_MS) throw new Error(`still building after ${secs(t0)}`);
            await sleep(1000);
          }
          env.home = await api('home');
          // The search words and references come from the server, never from the address: the
          // self-test route's own references (a squash-merged commit, a file a prompt names)
          // first, then the home page's examples.
          const info = await api('selftest');
          const textOf = (x) => (typeof x === 'string' ? x : x?.text ?? '');
          env.examples = [...new Set([...(Array.isArray(info.examples) ? info.examples : []), ...(env.home.try ?? [])].map(textOf).filter(Boolean))];
          const fromServer = [...(Array.isArray(info.words) ? info.words : []), info.word].filter((w) => typeof w === 'string' && w.trim());
          env.words = [...new Set([...fromServer, ...env.examples.filter((x) => kindOf(x) === 'words')])];
          for (const w of [...env.words, ...env.examples]) typed.add(w);
          return `ready after ${secs(t0)}; ${plural(env.examples.length, 'example')} and ${plural(env.words.length, 'search word')} from the server`;
        });
        if (!ONLY || ONLY === 'search') await searchSteps();
        if (!ONLY || ONLY === 'goal') await goalSteps();
        if (!ONLY || ONLY === 'replay') await replaySteps();
        if (!ONLY || ONLY === 'problems') await problemsSteps();
        if (!ONLY || ONLY === 'strip') await stripSteps();
        if (!ONLY || ONLY === 'first-run') await firstRunSteps();
        if (ONLY && !['setup', 'settings', 'search', 'goal', 'replay', 'problems', 'strip', 'first-run'].includes(ONLY)) await step('setup', `?only=${ONLY}`, async () => {
          throw new Error('use ?only=setup, settings, search, goal, replay, problems, strip or first-run');
        });
        if (!ONLY || ONLY === 'setup' || ONLY === 'settings') await settingsSteps();
        await step('setup', 'Storage holds only the key and the switch, and no address holds a typed word', async () => storageCheck());
      }
    } catch (err) {
      await step('setup', 'The test itself', async () => {
        throw err;
      });
    } finally {
      if (env.startSwitch != null) window.HWP.store(env.startSwitch);
      const c = tally();
      window.CLICKTHROUGH_RESULT = { done: true, ...c, demo: env.demo, privateShown: env.privateOn, only: ONLY ?? null, skips: results.filter((r) => r.status === 'SKIP').map((r) => r.skip), startedAt: new Date(started).toISOString(), ms: Date.now() - started, steps: results.slice(), errors: pageErrors.slice() };
      showTotals(true);
    }
  }
  document.getElementById('again').addEventListener('click', () => location.reload());
  run();
})();
