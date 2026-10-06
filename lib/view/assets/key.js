// The run key for pages served by `honestweek view`, and the "Show private text" switch.
//
// Each run of the command makes a fresh random key. The address it opens carries a one-time
// code in its fragment (#c=...), which the browser never sends to a server or puts in a
// Referer. On load this file takes the code out of the address, trades it once for the key at
// /api/claim, keeps the key in this tab's sessionStorage, and sends it as the X-Honestweek-Key
// header on every other /api request. A tab with no key asks this run's other open tabs for it
// over a BroadcastChannel (same origin, memory only) and waits briefly. A page the server marks
// as reached from another site (its <meta name="honestweek-opened" content="other-site">)
// never asks: another website may have opened it, so it takes the key only from the address's
// code or this tab's own storage, which a tab another site opens starts without.
//
// sessionStorage holds two things only: the key, and the switch saved together with the key it
// was set under, so a switch from an earlier run reads off. Nothing a person types or clicks is
// ever stored. When there's no key, the server refuses it, or the server is gone, the page says
// so and makes no further /api requests.
//
// A plain script: the pages load it with a script tag, and the node tests import it with
// their own fetch, storage, channel, location and history (see test/view-key.test.mjs).
(function (root) {
  'use strict';
  const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
  const CODE_RE = /^[A-Za-z0-9_-]{8,128}$/;
  const KEY_SLOT = 'hw.key';
  const SWITCH_SLOT = 'hw.switch';
  const CHANNEL = 'honestweek-view';
  const NOTICE = {
    'no-key': "This tab can't read your data: it wasn't opened from the address honestweek view printed. In the terminal where honestweek view runs, press Enter, then open the new address it prints.",
    stale: "This tab's key no longer works: it's from an earlier run, or its address was already used. In the terminal where honestweek view runs, press Enter, then open the new address it prints.",
    stopped: 'honestweek view has stopped, so this page can\'t get new data. Start it again and open the address it prints.',
  };

  function createKeyClient(env = {}) {
    // A stand-in given as null means "none": the browser's own is used only when none is given.
    const given = (k) => Object.prototype.hasOwnProperty.call(env, k);
    const fetchFn = given('fetch') ? env.fetch : typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    const loc = (given('location') ? env.location : root.location) ?? { hash: '', pathname: '/', search: '' };
    const hist = given('history') ? env.history : root.history ?? null;
    const BC = given('BroadcastChannel') ? env.BroadcastChannel : root.BroadcastChannel ?? null;
    const sleep = env.sleep ?? ((ms) => new Promise((r) => (env.setTimeout ?? root.setTimeout)(r, ms)));
    const now = env.now ?? (() => Date.now());
    const askMs = env.askMs ?? 400;
    const doc = given('document') ? env.document : root.document ?? null;
    let otherSite = false;
    try {
      otherSite = !!doc?.querySelector?.('meta[name="honestweek-opened"][content="other-site"]');
    } catch {
      otherSite = false;
    }
    let storage = env.sessionStorage;
    if (!given('sessionStorage')) {
      try {
        storage = root.sessionStorage;
      } catch {
        storage = null;
      }
    }
    const read = (k) => {
      try {
        return storage ? storage.getItem(k) : null;
      } catch {
        return null;
      }
    };
    const write = (k, v) => {
      try {
        if (!storage) return;
        if (v == null) storage.removeItem(k);
        else storage.setItem(k, v);
      } catch {}
    };

    let key = null;
    let state = 'starting';
    let on = false;
    let channel = null;
    let initPromise = null;
    const listeners = new Set();
    const asks = new Set();
    const setState = (s) => {
      if (s === state) return state;
      state = s;
      for (const fn of [...listeners]) {
        try {
          fn(s);
        } catch {}
      }
      return state;
    };
    const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

    // ---- sharing the key with this run's other tabs ------------------------------------
    function openChannel() {
      if (!BC || channel) return;
      try {
        channel = new BC(CHANNEL);
      } catch {
        channel = null;
        return;
      }
      channel.onmessage = (ev) => {
        const m = ev?.data;
        if (!m || typeof m !== 'object') return;
        // Only a key this tab still holds as good is shared; a refused one never is.
        if (m.type === 'ask' && state === 'ready' && key) channel.postMessage({ type: 'key', key });
        else if (m.type === 'key' && typeof m.key === 'string' && KEY_RE.test(m.key)) for (const fn of [...asks]) fn(m.key);
      };
    }
    async function askTabs() {
      if (!channel) return null;
      let got = null;
      const take = (k) => {
        if (!got) got = k;
      };
      asks.add(take);
      try {
        channel.postMessage({ type: 'ask' });
      } catch {}
      const end = now() + askMs;
      while (!got && now() < end) await sleep(Math.min(25, askMs));
      asks.delete(take);
      return got;
    }

    // ---- the one-time code in the address ------------------------------------------------
    function takeCode() {
      const raw = String(loc.hash ?? '').replace(/^#/, '');
      if (!raw) return null;
      const parts = raw.split('&');
      let code = null;
      const kept = [];
      for (const p of parts) {
        const m = p.match(/^c=(.*)$/);
        if (!m) {
          kept.push(p);
          continue;
        }
        let v = m[1];
        try {
          v = decodeURIComponent(v);
        } catch {}
        if (CODE_RE.test(v)) code = v;
      }
      if (kept.length !== parts.length && hist && typeof hist.replaceState === 'function') {
        try {
          hist.replaceState(hist.state ?? null, '', `${loc.pathname ?? ''}${loc.search ?? ''}${kept.length ? `#${kept.join('&')}` : ''}`);
        } catch {}
      }
      return code;
    }
    async function claim(code) {
      if (!fetchFn) return 'stopped';
      let res;
      try {
        res = await fetchFn('/api/claim', { headers: { 'X-Honestweek-Code': code }, cache: 'no-store', credentials: 'same-origin' });
      } catch {
        return 'stopped';
      }
      if (!res.ok) return 'refused';
      let j = null;
      try {
        j = await res.json();
      } catch {}
      const k = j?.key ?? j?.runKey;
      if (typeof k !== 'string' || !KEY_RE.test(k)) return 'refused';
      key = k;
      write(KEY_SLOT, k);
      return 'ok';
    }

    /** Find this tab's key: claim the address's code, else the saved key, else ask the other tabs. */
    function init() {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        openChannel();
        const code = takeCode();
        if (code) {
          const r = await claim(code);
          if (r === 'stopped') return setState('stopped');
          if (r === 'ok') return ready();
        }
        const saved = read(KEY_SLOT);
        if (saved && KEY_RE.test(saved)) {
          key = saved;
          return ready();
        }
        const shared = otherSite ? null : await askTabs();
        if (shared) {
          key = shared;
          write(KEY_SLOT, key);
          return ready();
        }
        return setState(code ? 'stale' : 'no-key');
      })();
      return initPromise;
    }
    function ready() {
      on = readSwitch();
      return setState('ready');
    }

    // ---- the switch, saved under the run key -----------------------------------------------
    function readSwitch() {
      if (!key) return false;
      try {
        const s = JSON.parse(read(SWITCH_SLOT) ?? 'null');
        return !!s && s.run === key && s.on === true;
      } catch {
        return false;
      }
    }
    function storeSwitch(value) {
      if (!key) return;
      write(SWITCH_SLOT, JSON.stringify({ run: key, on: value === true }));
    }

    // ---- data requests ----------------------------------------------------------------------
    /**
     * Ask for one /api route. `params` become the query string; private=1 is added when the
     * switch is on (or when `private: true` is passed). Answers JSON, or throws an error whose
     * `code` is "no-key", "stale" or "stopped" (each with its notice, and no request is made
     * after it), "building" (the data isn't ready yet), or "http".
     */
    async function api(route, params = {}, opts = {}) {
      await init();
      if (state !== 'ready') throw fail(state, NOTICE[state] ?? 'This page has no key.');
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== '') q.set(k, String(v));
      const priv = typeof opts.private === 'boolean' ? opts.private : on;
      if (priv) q.set('private', '1');
      const qs = q.toString();
      const headers = { 'X-Honestweek-Key': key };
      if (opts.body != null) headers['content-type'] = 'text/plain; charset=utf-8';
      let res;
      try {
        res = await fetchFn(`/api/${route}${qs ? `?${qs}` : ''}`, { method: opts.method ?? 'GET', headers, body: opts.body ?? null, cache: 'no-store', credentials: 'same-origin' });
      } catch (err) {
        setState('stopped');
        throw fail('stopped', NOTICE.stopped, { cause: err });
      }
      if (res.status === 401 || res.status === 403) {
        // A refused key is dropped with its switch, so nothing from that run lingers.
        write(KEY_SLOT, null);
        write(SWITCH_SLOT, null);
        setState('stale');
        throw fail('stale', NOTICE.stale);
      }
      let json = null;
      try {
        json = await res.json();
      } catch {}
      // /api/status answers about a build that's still running; every other route waits for one.
      if (route !== 'status' && (res.status === 202 || res.status === 503 || json?.building === true)) throw fail('building', 'The data is still being built.', { body: json });
      if (!res.ok) throw fail('http', json?.error ? String(json.error) : `The server answered ${res.status}.`, { status: res.status, body: json });
      if (json == null) throw fail('http', "The server sent an answer that isn't JSON.");
      return json;
    }

    // ---- waiting for the build --------------------------------------------------------------
    // /api/status answers with one slot per build, { builds: { redacted: {...}, private: {...} } },
    // each { state, elapsedMs, reading, failed }. A bare { state, ... } or top-level slots also read.
    const slots = (s) => {
      const b = s && typeof s.builds === 'object' && s.builds ? s.builds : s ?? {};
      const obj = (x) => (x && typeof x === 'object' ? x : null);
      return { red: obj(b.redacted) ?? s ?? {}, prv: obj(b.private) };
    };
    const isReady = (slot) => slot?.state === 'ready' || slot?.ready === true;
    const isFailed = (slot) => slot?.state === 'failed' || (typeof slot?.failed === 'string' && !!slot.failed && !isReady(slot));
    /**
     * Poll /api/status until the build this page needs is ready. `onProgress` hears each wait
     * ({ phase: 'redacted' | 'private', secs, reading }). Answers { ok: true, status, note } or
     * { ok: false, reason, message }; a stopped server, a refused key or no key ends the polling.
     */
    async function waitForBuild({ onProgress = () => {}, intervalMs = 1000, tickMs = 1000 } = {}) {
      const t0 = now();
      const secs = (slot) => Math.round((Number.isFinite(slot?.elapsedMs) ? slot.elapsedMs : now() - t0) / 1000);
      // Reading the logs keeps the server busy, so a status answer can take a while. Between
      // answers the count goes on from the last one, so the wait never looks stuck.
      let last = null;
      const progress = (p) => {
        last = { ...p, at: now(), shown: p.secs };
        onProgress(p);
      };
      const setT = env.setInterval ?? root.setInterval;
      const clearT = env.clearInterval ?? root.clearInterval;
      const tick = typeof setT === 'function' ? setT(() => {
        if (!last) return;
        const n = last.secs + Math.floor((now() - last.at) / 1000);
        if (n <= last.shown) return;
        last.shown = n;
        onProgress({ phase: last.phase, secs: n, reading: last.reading, status: last.status });
      }, tickMs) : null;
      try {
        return await waitLoop(progress, intervalMs, secs);
      } finally {
        if (tick != null && typeof clearT === 'function') clearT(tick);
      }
    }
    async function waitLoop(onProgress, intervalMs, secs) {
      for (;;) {
        let s;
        try {
          s = await api('status');
        } catch (err) {
          return { ok: false, reason: err.code ?? 'http', message: err.message };
        }
        const { red, prv } = slots(s);
        if (isFailed(red) && !(on && prv && isReady(prv))) return { ok: false, reason: 'failed', message: typeof red.failed === 'string' ? red.failed : null, status: s };
        if (!isReady(red)) {
          onProgress({ phase: 'redacted', secs: secs(red), reading: typeof red.reading === 'string' ? red.reading : null, status: s });
          await sleep(intervalMs);
          continue;
        }
        if (on && prv) {
          if (isFailed(prv)) return { ok: true, status: s, note: `Private text couldn't be built${typeof prv.failed === 'string' && prv.failed ? ` (${prv.failed})` : ''}, so this page shows the redacted version.` };
          if (!isReady(prv)) {
            onProgress({ phase: 'private', secs: secs(prv), reading: null, status: s });
            await sleep(intervalMs);
            continue;
          }
        }
        return { ok: true, status: s, note: typeof s.note === 'string' && s.note ? s.note : null };
      }
    }

    return {
      init,
      api,
      waitForBuild,
      readSwitch,
      storeSwitch,
      get key() {
        return key;
      },
      get state() {
        return state;
      },
      get on() {
        return on;
      },
      onState(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close() {
        try {
          channel?.close();
        } catch {}
        channel = null;
      },
    };
  }

  root.HWKey = { createKeyClient, NOTICE, KEY_SLOT, SWITCH_SLOT, CHANNEL };
})(typeof globalThis !== 'undefined' ? globalThis : window);
