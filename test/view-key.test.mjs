// The run key in the browser pages of `honestweek view` (lib/view/assets/key.js): a one-time code
// in the address is claimed once for the key, a tab with no key asks this run's other tabs,
// a missing, refused or stopped server makes no further data requests, and the switch counts
// only under the run key it was saved with. key.js is a plain browser script; here it runs with
// made-up stand-ins for fetch, sessionStorage, BroadcastChannel, location and history, since
// tabs in one browser can't be told apart from a same-tab frame (both share storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/view/assets/key.js';

const { createKeyClient, NOTICE, KEY_SLOT, SWITCH_SLOT } = globalThis.HWKey;
const KEY = 'k'.repeat(43);
const OLD_KEY = 'o'.repeat(43);
const CODE = 'one-time-code-1234';

function storage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    keys: () => [...m.keys()].sort(),
  };
}
/** A BroadcastChannel for several made-up tabs in one process. */
function channelHub() {
  const open = new Set();
  return class FakeChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      open.add(this);
    }
    postMessage(data) {
      for (const c of open) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data: structuredClone(data) }));
    }
    close() {
      open.delete(this);
    }
  };
}
/** The server: claims each code once, answers /api with the run key only, and logs every call. */
function server({ key = KEY, codes = [CODE], status = () => ({ state: 'ready' }) } = {}) {
  const left = new Set(codes);
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const h = opts.headers ?? {};
    calls.push({ url, key: h['X-Honestweek-Key'] ?? null, code: h['X-Honestweek-Code'] ?? null });
    const json = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });
    if (url === '/api/claim') {
      if (!left.has(h['X-Honestweek-Code'])) return json(403, { error: 'refused' });
      left.delete(h['X-Honestweek-Code']);
      return json(200, { key });
    }
    if (h['X-Honestweek-Key'] !== key) return json(403, { error: 'refused' });
    if (url.startsWith('/api/status')) return json(200, status(calls.length));
    return json(200, { ok: true, url });
  };
  return { fetch, calls, data: () => calls.filter((c) => c.url !== '/api/claim') };
}
function tab({ hash = '', store = storage(), BroadcastChannel = null, fetch } = {}) {
  const location = { hash, pathname: '/search.html', search: '' };
  const history = {
    state: null,
    urls: [],
    replaceState(_s, _t, url) {
      this.urls.push(url);
      const u = new URL(url, 'http://127.0.0.1');
      location.hash = u.hash;
      location.search = u.search;
    },
  };
  const client = createKeyClient({ fetch, sessionStorage: store, BroadcastChannel, location, history, askMs: 60, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  return { client, location, history, store };
}

test('key: the address code is claimed once, taken out of the address, and the key kept for this tab', async () => {
  const s = server();
  const a = tab({ hash: `#c=${CODE}`, fetch: s.fetch });
  assert.equal(await a.client.init(), 'ready');
  assert.equal(a.client.key, KEY);
  assert.equal(a.location.hash, '', 'the code leaves the address');
  assert.deepEqual(a.history.urls, ['/search.html']);
  assert.equal(a.store.getItem(KEY_SLOT), KEY);
  // A reload of the same tab finds the key in its storage and claims nothing.
  const again = tab({ store: a.store, fetch: s.fetch });
  assert.equal(await again.client.init(), 'ready');
  assert.equal(s.calls.filter((c) => c.url === '/api/claim').length, 1);
  // Every data request carries the key.
  await again.client.api('home');
  assert.deepEqual(s.data().map((c) => c.key), [KEY]);
  // An address that keeps other parts loses only the code.
  const b = tab({ hash: '#q=abcdabcd~w&c=spent-code-0000', fetch: s.fetch, store: storage() });
  assert.equal(await b.client.init(), 'stale', 'a used or unknown code is refused');
  assert.equal(b.location.hash, '#q=abcdabcd~w');
});

test('key: a second tab gets the key from a tab of this run over the channel', async () => {
  const s = server();
  const BroadcastChannel = channelHub();
  const first = tab({ hash: `#c=${CODE}`, fetch: s.fetch, BroadcastChannel });
  assert.equal(await first.client.init(), 'ready');
  const second = tab({ fetch: s.fetch, BroadcastChannel });
  assert.equal(await second.client.init(), 'ready');
  assert.equal(second.client.key, KEY);
  assert.equal(second.store.getItem(KEY_SLOT), KEY);
  await second.client.api('status');
  assert.equal(s.calls.filter((c) => c.url === '/api/claim').length, 1, 'the second tab claims nothing');
  first.client.close();
  second.client.close();
});

test('key: with no code, no saved key and no other tab, the page says so and asks for no data', async () => {
  const s = server();
  const lone = tab({ fetch: s.fetch, BroadcastChannel: channelHub() });
  assert.equal(await lone.client.init(), 'no-key');
  await assert.rejects(lone.client.api('home'), (err) => err.code === 'no-key' && err.message === NOTICE['no-key']);
  const r = await lone.client.waitForBuild({ intervalMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-key');
  assert.equal(s.calls.length, 0, 'not one request reached the server');
  assert.match(NOTICE['no-key'], /Open the address the command printed, or press Enter in the terminal/);
  lone.client.close();
});

test('key: a key the server refuses shows the notice, is dropped with its switch, never shared, and stops requests', async () => {
  const s = server();
  const store = storage();
  store.setItem(KEY_SLOT, OLD_KEY);
  store.setItem(SWITCH_SLOT, JSON.stringify({ run: OLD_KEY, on: true }));
  const BroadcastChannel = channelHub();
  const stale = tab({ store, fetch: s.fetch, BroadcastChannel });
  const states = [];
  stale.client.onState((x) => states.push(x));
  assert.equal(await stale.client.init(), 'ready');
  await assert.rejects(stale.client.api('home'), (err) => err.code === 'stale' && err.message === NOTICE.stale);
  assert.deepEqual(states, ['ready', 'stale']);
  assert.equal(store.getItem(KEY_SLOT), null);
  assert.equal(store.getItem(SWITCH_SLOT), null);
  const before = s.calls.length;
  await assert.rejects(stale.client.api('home'), (err) => err.code === 'stale');
  assert.equal((await stale.client.waitForBuild({ intervalMs: 1 })).reason, 'stale');
  assert.equal(s.calls.length, before, 'no request after the refusal');
  // A tab asking now gets nothing from the refused one.
  const asker = tab({ fetch: s.fetch, BroadcastChannel });
  assert.equal(await asker.client.init(), 'no-key');
  stale.client.close();
  asker.client.close();
});

test('key: a server that has gone says the run stopped, and the build polling ends', async () => {
  let up = true;
  const s = server({ status: () => ({ state: 'building', elapsedMs: 1000 }) });
  let fetches = 0;
  const fetch = async (url, opts) => {
    fetches++;
    if (!up) throw new TypeError('Failed to fetch');
    return s.fetch(url, opts);
  };
  const t = tab({ hash: `#c=${CODE}`, fetch });
  assert.equal(await t.client.init(), 'ready');
  const progress = [];
  const r = await t.client.waitForBuild({
    intervalMs: 1,
    onProgress(p) {
      progress.push(p.phase);
      if (progress.length === 3) up = false;
    },
  });
  assert.deepEqual(r, { ok: false, reason: 'stopped', message: NOTICE.stopped });
  assert.deepEqual(progress, ['redacted', 'redacted', 'redacted']);
  assert.equal(t.client.state, 'stopped');
  const after = fetches;
  await assert.rejects(t.client.api('status'), (err) => err.code === 'stopped');
  assert.equal(fetches, after, 'polling ended: no request after the server went');
  assert.match(NOTICE.stopped, /has stopped/);
});

test('key: a claim to a server that has gone says the run stopped', async () => {
  const t = tab({ hash: `#c=${CODE}`, fetch: async () => {
    throw new TypeError('Failed to fetch');
  } });
  assert.equal(await t.client.init(), 'stopped');
});

test("key: the switch counts only under the run key it was saved with; private=1 only when it's on", async () => {
  const s = server();
  const store = storage();
  // Saved on by an earlier run, then the tab gets this run's key from a new address.
  store.setItem(KEY_SLOT, OLD_KEY);
  store.setItem(SWITCH_SLOT, JSON.stringify({ run: OLD_KEY, on: true }));
  const t = tab({ hash: `#c=${CODE}`, store, fetch: s.fetch });
  assert.equal(await t.client.init(), 'ready');
  assert.equal(t.client.key, KEY);
  assert.equal(t.client.on, false, "an earlier run's switch reads off");
  assert.equal(t.client.readSwitch(), false);
  await t.client.api('home');
  assert.doesNotMatch(s.data().at(-1).url, /private=/);
  // Saved on under this run, it reads on, and requests ask for private text.
  t.client.storeSwitch(true);
  const reload = tab({ store, fetch: s.fetch });
  assert.equal(await reload.client.init(), 'ready');
  assert.equal(reload.client.on, true);
  await reload.client.api('home', { q: 'x' });
  assert.match(s.data().at(-1).url, /[?&]private=1(&|$)/);
  // sessionStorage holds the key and the switch, nothing else.
  assert.deepEqual(store.keys(), [KEY_SLOT, SWITCH_SLOT].sort());
});

test('key: waiting for the build reports progress, then a failed private build as a note', async () => {
  let n = 0;
  const s = server({ status: () => (++n < 3 ? { redacted: { state: 'ready' }, private: { state: 'building', elapsedMs: n * 1000 } } : { redacted: { state: 'ready' }, private: { state: 'failed', failed: 'made-up reason' } }) });
  const store = storage();
  store.setItem(KEY_SLOT, KEY);
  store.setItem(SWITCH_SLOT, JSON.stringify({ run: KEY, on: true }));
  const t = tab({ store, fetch: s.fetch });
  await t.client.init();
  const seen = [];
  const r = await t.client.waitForBuild({ intervalMs: 1, onProgress: (p) => seen.push(`${p.phase} ${p.secs}`) });
  assert.equal(r.ok, true);
  assert.match(r.note, /Private text couldn't be built \(made-up reason\), so this page shows the redacted version\./);
  assert.deepEqual(seen, ['private 1', 'private 2']);
  // A failed redacted build ends the wait with the reason.
  const bad = server({ status: () => ({ state: 'failed', failed: 'made-up' }) });
  const t2 = tab({ store: storage(), hash: `#c=${CODE}`, fetch: bad.fetch });
  await t2.client.init();
  assert.deepEqual(await t2.client.waitForBuild({ intervalMs: 1 }), { ok: false, reason: 'failed', message: 'made-up', status: { state: 'failed', failed: 'made-up' } });
});
