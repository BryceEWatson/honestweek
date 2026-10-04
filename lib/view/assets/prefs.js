// Preferences about the shipped catalog of known agent problems, kept in this browser's local
// storage under one key, hw.prefs: "My priority" for a pattern, and whether the "Worth a look"
// strip is on and shows low-priority findings. Nothing else.
//
// The value is { v: 1, priority: { <pattern id>: "high" | "medium" | "low" | "dismissed" },
// strip: true | false, low: true | false }. Pattern ids are the catalog's, shipped in the
// package and the same on every machine; the tiers are four fixed words. Nothing from a log,
// nothing typed and no session, step or goal id is ever stored. Every read and write passes
// clean(), which drops any pattern id the page didn't get from the server's catalog list, any
// tier outside the four, and any other field; a value someone else left under the key is
// cleaned on the first read. Session storage still holds only the run key and the switch
// (key.js).
//
// A plain script: the pages load it with a script tag, and the node tests run it with their
// own storage (see test/view-prefs.test.mjs).
(function (root) {
  'use strict';
  const SLOT = 'hw.prefs';
  const TIERS = Object.freeze(['high', 'medium', 'low', 'dismissed']);
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
        const empty = !Object.keys(c.priority).length && !c.strip && !c.low;
        if (empty) storage.removeItem(SLOT);
        else storage.setItem(SLOT, JSON.stringify(c));
      } catch {}
      return c;
    }
    const changed = () => listeners.forEach((fn) => fn());
    // Another tab changed the preferences: let this page redraw.
    if (typeof root.addEventListener === 'function' && !env.noEvents) {
      root.addEventListener('storage', (ev) => {
        if (ev.key === SLOT) changed();
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

  root.HWPrefs = { createPrefs, effective, order, byRule, SLOT, TIERS };
})(typeof globalThis !== 'undefined' ? globalThis : window);
