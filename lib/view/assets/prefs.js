// Preferences kept in this browser's local storage under one key, hw.prefs: "My priority" for a
// pattern in the shipped catalog of known agent problems, whether the "Worth a look" strip is on
// and shows low-priority findings, and the page theme (light or dark). Nothing else.
//
// The value is { v: 1, priority: { <pattern id>: "high" | "medium" | "low" | "dismissed" },
// strip: true | false, low: true | false, theme?: "light" | "dark" }. Pattern ids are the
// catalog's, shipped in the package and the same on every machine; the tiers and the themes are
// fixed words, and no theme means the page follows the system setting. Nothing from a log,
// nothing typed and no session, step or goal id is ever stored. Every read and write passes
// clean(), which drops any pattern id the page didn't get from the server's catalog list, any
// tier or theme outside its words, and any other field; a value someone else left under the key
// is cleaned on the first read. Session storage still holds only the run key and the switch
// (key.js).
//
// Every page loads this file in its head, so the stored theme is on <html> before anything is
// drawn and a dark page never shows light first. mountTheme() draws the header's light/dark
// button; common.js calls it on the data pages, form.js on Setup and Settings.
//
// A plain script: the pages load it with a script tag, and the node tests run it with their
// own storage (see test/view-prefs.test.mjs and test/view-theme.test.mjs).
(function (root) {
  'use strict';
  const SLOT = 'hw.prefs';
  const TIERS = Object.freeze(['high', 'medium', 'low', 'dismissed']);
  const THEMES = Object.freeze(['light', 'dark']);
  const ID_RE = /^[a-z][a-z0-9-]{1,60}$/;
  const MAX = 100;

  function createPrefs(env = {}) {
    let storage = env.localStorage;
    if (!Object.prototype.hasOwnProperty.call(env, 'localStorage')) {
      try {
        storage = root.localStorage;
      } catch {
        storage = null;
      }
    }
    let known = null;
    const listeners = [];

    /** The stored value with nothing in it but what this file allows. */
    function clean(v) {
      const out = { v: 1, priority: {}, strip: false, low: false };
      if (!v || typeof v !== 'object') return out;
      const pri = v.priority && typeof v.priority === 'object' && !Array.isArray(v.priority) ? v.priority : {};
      let n = 0;
      for (const [id, tier] of Object.entries(pri)) {
        if (n >= MAX) break;
        if (!ID_RE.test(id) || !TIERS.includes(tier) || (known && !known.has(id))) continue;
        out.priority[id] = tier;
        n += 1;
      }
      out.strip = v.strip === true;
      out.low = v.low === true;
      if (THEMES.includes(v.theme)) out.theme = v.theme;
      return out;
    }
    function readRaw() {
      try {
        return storage ? storage.getItem(SLOT) : null;
      } catch {
        return null;
      }
    }
    function read() {
      const raw = readRaw();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      const v = clean(parsed);
      // Anything the store doesn't allow, left by another page or an older copy, goes now.
      if (raw != null && raw !== JSON.stringify(v)) write(v);
      return v;
    }
    function write(v) {
      const c = clean(v);
      try {
        if (!storage) return c;
        const empty = !Object.keys(c.priority).length && !c.strip && !c.low && !c.theme;
        if (empty) storage.removeItem(SLOT);
        else storage.setItem(SLOT, JSON.stringify(c));
      } catch {}
      return c;
    }
    const changed = () => listeners.forEach((fn) => fn());
    // Another tab changed the preferences: let this page redraw, unless only the theme changed,
    // which the theme button follows on its own.
    const sansTheme = (raw) => {
      let v = null;
      try {
        v = JSON.parse(raw);
      } catch {}
      const c = clean(v);
      delete c.theme;
      return JSON.stringify(c);
    };
    if (typeof root.addEventListener === 'function' && !env.noEvents) {
      root.addEventListener('storage', (ev) => {
        if (ev.key === SLOT && sansTheme(ev.oldValue) !== sansTheme(ev.newValue)) changed();
      });
    }

    return {
      SLOT,
      TIERS,
      /** The pattern ids the server's catalog lists; ids outside it are never kept. */
      setKnown(ids) {
        known = new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && ID_RE.test(x)));
        read();
      },
      /** My priority for a pattern, or null when the rule's tier stands. */
      tierOf(id) {
        return read().priority[id] ?? null;
      },
      /** Set my priority; the rule's own tier, or an empty value, clears it. */
      setTier(id, tier, ruleTier) {
        const v = read();
        if (!tier || tier === ruleTier) delete v.priority[id];
        else v.priority[id] = tier;
        write(v);
        changed();
      },
      get strip() {
        return read().strip;
      },
      set strip(on) {
        write({ ...read(), strip: on === true });
        changed();
      },
      get low() {
        return read().low;
      },
      set low(on) {
        write({ ...read(), low: on === true });
        changed();
      },
      /** "light" or "dark" when I chose one, or null when the page follows the system. */
      get theme() {
        return read().theme ?? null;
      },
      /** Remember a theme; anything but the two words forgets it. The catalog's listeners
       *  aren't told: nothing they draw depends on it. */
      set theme(t) {
        const v = read();
        if (THEMES.includes(t)) v.theme = t;
        else delete v.theme;
        write(v);
      },
      onChange: (fn) => listeners.push(fn),
      /** For the tests: what the store holds now. */
      peek: () => readRaw(),
    };
  }

  /** A pattern's tier: mine when I set one, else the rule's; null for a pattern not found. */
  function effective(prefs, p) {
    if (!p?.priority?.tier) return null;
    const mine = prefs.tierOf(p.id);
    if (mine) return { tier: mine, mine: true, rule: p.priority.tier };
    return { tier: p.priority.tier, mine: false, rule: p.priority.tier };
  }

  const RANK = { high: 0, medium: 1, low: 2, dismissed: 3 };
  /** The stated rule's order within a tier: estimated tokens, then findings worth a look, then
   *  how well established the pattern is. */
  const byRule = (a, b) => (b.priority?.tokens ?? 0) - (a.priority?.tokens ?? 0) || (b.priority?.look ?? 0) - (a.priority?.look ?? 0) || (a.priority?.strength ?? 9) - (b.priority?.strength ?? 9);
  /** The Problems page's order: claims not backed first (`claim`, from the server), then by tier,
   *  then the rule's order. "My priority" on a claim pattern takes it out of that first place and
   *  puts it where its tier says, like any other. */
  function order(prefs, patterns) {
    const key = (p) => {
      const e = effective(prefs, p);
      return [p.claim === true && e && !e.mine ? 0 : 1, RANK[e?.tier] ?? 9];
    };
    return [...patterns].map((p) => [p, key(p)]).sort(([a, x], [b, y]) => x[0] - y[0] || x[1] - y[1] || byRule(a, b)).map(([p]) => p);
  }

  /** Put a chosen theme on <html>, or take it off so the page follows the system setting. */
  function applyTheme(doc, theme) {
    const el = doc?.documentElement;
    if (!el) return;
    if (THEMES.includes(theme)) el.setAttribute('data-theme', theme);
    else el.removeAttribute('data-theme');
  }
  const systemDark = (doc) => {
    try {
      return (doc.defaultView || root).matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return null;
    }
  };
  /** The theme the page shows now: the chosen one, else the system's. */
  function shownTheme(doc) {
    const set = doc?.documentElement?.getAttribute('data-theme');
    if (THEMES.includes(set)) return set;
    return systemDark(doc)?.matches ? 'dark' : 'light';
  }
  // Stroke icons in the button's own colour: the moon offers dark, the sun offers light.
  const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>';
  const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>';
  /** The header's light/dark button, right after the "Show private text" switch where the page
   *  has one, else at the header's end. A click puts the other theme on <html> and remembers it
   *  in this browser. Drawn once per page; a second call only redraws it. */
  function mountTheme(doc) {
    const header = doc?.querySelector?.('header.topbar');
    if (!header) return null;
    let btn = doc.getElementById('themeBtn');
    const draw = () => {
      const label = shownTheme(doc) === 'dark' ? 'Switch to light' : 'Switch to dark';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.innerHTML = label === 'Switch to light' ? SUN : MOON;
    };
    if (!btn) {
      btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'themebtn';
      btn.id = 'themeBtn';
      const privacy = doc.getElementById('privacy');
      if (privacy) privacy.after(btn);
      else header.append(btn);
      const prefs = createPrefs({ noEvents: true });
      btn.addEventListener('click', () => {
        const next = shownTheme(doc) === 'dark' ? 'light' : 'dark';
        applyTheme(doc, next);
        prefs.theme = next;
        draw();
      });
      // With no choice made, the page follows the system, and so does the button's icon.
      systemDark(doc)?.addEventListener?.('change', draw);
      // A theme picked in another tab of this browser shows here too.
      (doc.defaultView || root).addEventListener?.('storage', (ev) => {
        if (ev.key !== SLOT) return;
        applyTheme(doc, prefs.theme);
        draw();
      });
    }
    draw();
    return btn;
  }

  // In a page, the stored theme goes on <html> now, before the body is drawn. The node tests'
  // import has no document, so nothing happens there.
  if (root.document) applyTheme(root.document, createPrefs({ noEvents: true }).theme);

  root.HWPrefs = { createPrefs, effective, order, byRule, SLOT, TIERS, THEMES, applyTheme, mountTheme };
})(typeof globalThis !== 'undefined' ? globalThis : window);
