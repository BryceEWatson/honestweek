// Click-through test for the search page, the goal page and the replay page of `honestweek view`.
// It opens each page in a frame on this same server, drives it with real DOM events (clicks,
// typing, keys, focus), and lists every step as PASS, FAIL or SKIP with a short detail.
//
// A step may skip only for a reason on the named list below (SKIPS); a skip for any other
// reason counts as a failure. Each frame's errors, console errors and content-policy
// violations fail the step that caused them. The search words come from the server, and the
// test checks that no typed word, reference text, goal id or title ever reaches the address.
// Text the pages show is checked by the server's leak counter (/api/leak-check), which answers
// with counts only. "Show private text" is put back the way it was when the run ends.
(function () {
  'use strict';
  // ---- the steps allowed to skip: each can't apply to some data, never to the demo week's
  // core pages. The pull request quotes this list. -----------------------------------------
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
  };
  const params = new URLSearchParams(location.search);
  const ONLY = params.get('only');
  const WANT = params.get('private');
  const DESKTOP = { width: 1280, height: 900 };
  const PHONE = { width: 375, height: 740 };
  const BUILD_MS = 300e3;
  const PAGES = ['search.html', 'goal.html', 'replay.html'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const secs = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const env = { demo: false, privateOn: false, words: [], examples: [], home: null, startSwitch: null };
  // Words typed or clicked in this run: none may ever reach a frame's address.
  const typed = new Set();

  // ---- the list of steps -----------------------------------------------------------------
  const results = [];
  const listEl = document.getElementById('steps');
  const summaryEl = document.getElementById('summary');
  const started = Date.now();
  document.getElementById('skips').innerHTML = Object.entries(SKIPS).map(([k, v]) => `<li><code>${esc(k)}</code>: ${esc(v)}</li>`).join('');
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
        status = SKIPS[err.id] ? 'SKIP' : 'FAIL';
        detail = SKIPS[err.id] ? `${err.id}: ${err.message}` : `skipped for a reason that isn't on the named list: ${err.id}`;
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
    if (!/^Window: \w{3}, \w{3} \d+/.test(win2)) throw new Error(`the header's window reads "${win2}"`);
    const sw = d.getElementById('privateSwitch');
    if (!sw) throw new Error('the header has no "Show private text" switch');
    if (sw.checked !== env.privateOn) throw new Error(`the switch reads ${sw.checked ? 'on' : 'off'} but this run has it ${env.privateOn ? 'on' : 'off'}`);
    const demo = d.getElementById('demo');
    const shown = demo && !demo.hidden;
    if (shown !== env.demo) throw new Error(env.demo ? 'the demo notice is missing' : 'a demo notice shows outside demo mode');
    if (shown && !(/install/i.test(text(demo)) && /honestweek init/.test(text(demo)) && /honestweek view/.test(text(demo)) && /made[ -]up/.test(text(demo)))) throw new Error(`the demo notice reads "${text(demo).slice(0, 120)}"`);
    return `${current} current; the key's five words; "${win2}"; switch ${sw.checked ? 'on' : 'off'}${env.demo ? '; demo notice with the install, init and view commands' : ''}`;
  }
  // The address holds only ids: never a typed word, a clicked reference, a goal id or title.
  const ADDRESS = {
    'search.html': /^(#q=[A-Za-z0-9_-]{4,64}(~[lw])?)?$/,
    'goal.html': /^(#(?:[a-z]{1,4}-)?[a-p]{4,64}(~[a-z]{2,4}-[a-p]{4,64})*)?$/,
    'replay.html': /^(#(th-[a-p]{4,64})?(~[a-z]{2,4}-[a-p]{4,64}([.:][A-Za-z0-9_-]{1,80}){0,6})?)?$/,
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
  /** sessionStorage holds the key and the switch only; localStorage holds nothing. */
  function storageCheck() {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i));
    const extra = keys.filter((k) => k !== window.HWKey.KEY_SLOT && k !== window.HWKey.SWITCH_SLOT);
    if (extra.length) throw new Error(`sessionStorage holds ${plural(extra.length, 'other item')} besides the key and the switch`);
    if (localStorage.length) throw new Error(`localStorage holds ${plural(localStorage.length, 'item')}`);
    // The switch is saved as {"run": <key>, "on": <bool>}: those words aren't typed text.
    const all = keys.map((k) => sessionStorage.getItem(k) ?? '').join('\n').replace(/"(run|on)":/g, '');
    if (holdsTyped(all)) throw new Error('a typed word reached sessionStorage');
    return `sessionStorage holds ${keys.length === 2 ? 'the key and the switch' : keys.join(' and ') || 'nothing'}; localStorage is empty`;
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
  const countIn = (o, re) => Number([...o.querySelectorAll('h2')].map(text).find((t) => re.test(t))?.match(/\((\d+)\)|: (\d+) session/)?.slice(1).find(Boolean) ?? 0);
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
      const c = text(d.getElementById('coverage'));
      if (!/^Pull request, commit, file and word lookups cover your configured repos only: \d+ sessions? \w+, \w{3}, \w{3} \d+/.test(c)) throw new Error(`the coverage line reads "${c.slice(0, 140)}"`);
      if (!d.querySelector('#coverage .chip')) throw new Error("the coverage line's counts carry no evidence level");
      return c.slice(0, 160);
    });
    await step(P, 'Home lists goals and recent sessions', async () => {
      await need();
      const o = await typeQuery('');
      const recent = countIn(o, /^Recent sessions \(/);
      if (!recent) throw new Error('the home view lists no recent sessions');
      if (windowCards(o).length < recent) throw new Error(`"Recent sessions (${recent})" but only ${windowCards(o).length} cards`);
      const goals = countIn(o, /^Goals \(/);
      return `${plural(goals, 'goal')}, ${plural(recent, 'recent session')}`;
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
      const a = [...o.querySelectorAll('.card li a')].find((x) => /^replay\.html\?session=/.test(x.getAttribute('href')));
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
        const a = doc().querySelector(`#everywhere .card[data-group="${g}"] a.t`);
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
      const lane = lanes().find((t) => Number(text(t.nextElementSibling)) > 0) ?? lanes()[0];
      click(lane);
      if (!doc().querySelectorAll('#chart text.row-label:not(.head):not(.lane)').length) throw new Error('clicking a lane opened no tool rows');
      click(doc().querySelector(`#chart text.head[data-session="${CSS.escape(k)}"]`));
      if (lanes().length) throw new Error("clicking the session row again didn't fold it");
      click(doc().getElementById('openAll'));
      click(doc().getElementById('closeAll'));
      if (doc().querySelectorAll('#chart text[data-lane]').length) throw new Error('"Fold sessions" left lanes open');
      return `Enter opened ${plural(n, 'lane')}; a lane opened into tool rows; "Open" and "Fold sessions" work`;
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

  // ---- first run: what someone sees on their first `view` after `init` -----------------------
  // The while-it-builds check runs before the data is ready, from run() below; the rest run
  // here. Each skips, with a named reason, when its case doesn't apply to this run's config.
  const READING_LINE = /into this program's memory: \d+ s so far\. The page fills in when it's ready\./;
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
        return `${env.demo ? 'the demo week' : 'your own logs'}; "Show private text" is ${env.privateOn ? 'on' : 'off'} for this run${WANT ? ' (from ?private=)' : ''}`;
      });
      if (ok) {
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
        if (!ONLY || ONLY === 'first-run') await firstRunSteps();
        if (ONLY && !['search', 'goal', 'replay', 'first-run'].includes(ONLY)) await step('setup', `?only=${ONLY}`, async () => {
          throw new Error('use ?only=search, goal, replay or first-run');
        });
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
