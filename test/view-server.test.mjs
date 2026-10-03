// honestweek view's loopback server (lib/view/server.mjs): who may ask, what it answers,
// the one-time codes and the run key, and the pages it serves. Most tests put a stub
// behind it, so they check the server alone; one runs the real data over the demo week.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ASSETS_DIR, CODE_HEADER, CSP, CSP_SELF_TEST, KEY_HEADER, readAssets, SELFTEST_DIR, startViewServer } from '../lib/view/server.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { buildViewWeek, TERM, WEEK } from './fixtures/view/week.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'hw-view-server-'));
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
  rmSync(scratch, { recursive: true, force: true });
});

const assets = join(scratch, 'assets');
mkdirSync(assets, { recursive: true });
writeFileSync(join(assets, 'search.html'), '<!doctype html><title>search</title><script src="search.js"></script>');
writeFileSync(join(assets, 'search.js'), 'export {};\n');
writeFileSync(join(assets, 'common.css'), 'body { margin: 0; }\n');
writeFileSync(join(assets, 'notes.txt'), 'not a page type');
mkdirSync(join(assets, 'nested'));
writeFileSync(join(assets, 'nested', 'inner.js'), 'export {};\n');
const selftest = join(scratch, 'selftest');
mkdirSync(selftest, { recursive: true });
writeFileSync(join(selftest, 'clickthrough.html'), '<!doctype html><title>click-through</title>');

const calls = [];
const stub = {
  route: async (path, params) => {
    calls.push({ path, params: Object.fromEntries(params) });
    if (path === '/api/boom') throw new Error(`boom in /home/dana/secret for ${TERM}`);
    return { status: 200, body: { path, asked: params.get('private') === '1' ? 'private' : 'redacted' } };
  },
  leakCheck: (text) => (text === 'not a list' ? { error: 'With parts=1 the text must be a JSON list.' } : { chars: text.length, mode: 'redacted', total: 0 }),
};

async function start(options = {}) {
  const s = await startViewServer({ data: stub, assetsDir: assets, selftestDir: selftest, ...options });
  servers.push(s);
  return s;
}

/** A raw HTTP request, so tests control every header, the method and the request line. */
function raw(port, { method = 'GET', path = '/', headers = {}, body = null, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(host === null ? {} : { host }), ...headers }, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Send bytes the HTTP client wouldn't, and read the reply's status line. */
function rawLine(port, line) {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(line));
    let got = '';
    sock.on('data', (c) => (got += c.toString('utf8')));
    sock.on('close', () => resolve(got.split('\r\n')[0]));
    sock.on('error', () => resolve(got.split('\r\n')[0]));
    setTimeout(() => sock.destroy(), 2000);
  });
}

async function keyOf(s) {
  const code = s.issueCode('test');
  const r = await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: code } });
  assert.equal(r.status, 200);
  return r.json.key;
}

// ---- headers ---------------------------------------------------------------------------

test('every response carries the content policy, nosniff, no-referrer and no-store', async () => {
  const s = await start();
  const key = await keyOf(s);
  for (const [path, headers, status] of [['/', {}, 200], ['/search.html', {}, 200], ['/nope', {}, 404], ['/api/home', { [KEY_HEADER]: key }, 200], ['/api/home', {}, 403], ['/api/claim', {}, 403]]) {
    const r = await raw(s.port, { path, headers });
    assert.equal(r.status, status, path);
    assert.equal(r.headers['content-security-policy'], CSP, path);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.equal(CSP, "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  const t = await start({ selfTest: true });
  assert.equal((await raw(t.port, { path: '/' })).headers['content-security-policy'], `${CSP}; frame-src 'self'`);
  assert.equal(CSP_SELF_TEST, `${CSP}; frame-src 'self'`);
});

test('data answers are JSON, fetched with a header, never served as a script', async () => {
  const s = await start();
  const r = await raw(s.port, { path: '/api/home', headers: { [KEY_HEADER]: await keyOf(s) } });
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(r.json, { path: '/api/home', asked: 'redacted' });
});

// ---- who may ask ------------------------------------------------------------------------

test('another site\'s request is refused', async () => {
  const s = await start();
  const key = await keyOf(s);
  for (const site of ['cross-site', 'same-site', 'CROSS-SITE']) {
    assert.equal((await raw(s.port, { path: '/api/home', headers: { [KEY_HEADER]: key, 'sec-fetch-site': site } })).status, 403, site);
    assert.equal((await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: s.issueCode(), 'sec-fetch-site': site } })).status, 403, `claim ${site}`);
  }
  for (const site of ['same-origin', 'none']) assert.equal((await raw(s.port, { path: '/api/home', headers: { [KEY_HEADER]: key, 'sec-fetch-site': site } })).status, 200, site);
});

test('another address\'s request is refused', async () => {
  const s = await start();
  const key = await keyOf(s);
  for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, `localhost.evil.example:${s.port}`, `127.0.0.2:${s.port}`, `[::1]:${s.port}`]) {
    assert.equal((await raw(s.port, { path: '/api/home', host, headers: { [KEY_HEADER]: key } })).status, 403, `host ${host}`);
    assert.equal((await raw(s.port, { path: '/', host })).status, 403, `page with host ${host}`);
  }
  // With no Host at all, newer Node refuses the request itself (400); either way it's refused.
  for (const host of ['', null]) assert.ok([400, 403].includes((await raw(s.port, { path: '/api/home', host, headers: { [KEY_HEADER]: key } })).status), `host ${host}`);
  for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `LOCALHOST:${s.port}`]) assert.equal((await raw(s.port, { path: '/api/home', host, headers: { [KEY_HEADER]: key } })).status, 200, host);
});

test('a request type other than reading is refused', async () => {
  const s = await start();
  const key = await keyOf(s);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    for (const path of ['/', '/api/home', '/api/leak-check', '/api/claim']) {
      const r = await raw(s.port, { method, path, headers: { [KEY_HEADER]: key, 'content-length': '0' } });
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.ok(!('access-control-allow-origin' in r.headers));
    }
  }
  const head = await raw(s.port, { method: 'HEAD', path: '/search.html' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('a malformed address gets an error, not a crash', async () => {
  const s = await start();
  const key = await keyOf(s);
  for (const path of ['/%zz', '/api/lookup?q=%E0%A4%A', '/api/home?x=%', `/${'a'.repeat(9000)}`]) assert.equal((await raw(s.port, { path, headers: { [KEY_HEADER]: key } })).status, 400, path.slice(0, 40));
  assert.match(await rawLine(s.port, `GET http://evil.example/ HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`), / 400 /);
  assert.match(await rawLine(s.port, 'NOT A REQUEST\r\n\r\n'), / 400 /);
  assert.equal((await raw(s.port, { path: '/api/home', headers: { [KEY_HEADER]: key } })).status, 200, 'still serving');
});

test('a path outside the page is refused', async () => {
  const s = await start();
  for (const path of ['/../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/lib/view.mjs', '/assets/search.html', '/nested/inner.js', '/notes.txt', '/search.html/..%2fsearch.js', '/SEARCH.HTML', '/search.html%00', '/clickthrough.html', '/selftest/clickthrough.html']) {
    assert.equal((await raw(s.port, { path })).status, 404, path);
  }
  assert.equal((await raw(s.port, { path: '/search.js' })).status, 200);
  assert.equal((await raw(s.port, { path: '/search.js' })).headers['content-type'], 'text/javascript; charset=utf-8');
  const t = await start({ selfTest: true });
  assert.equal((await raw(t.port, { path: '/selftest/clickthrough.html' })).status, 200, 'the self-test page is served only with --self-test');
  assert.equal((await raw(t.port, { path: '/clickthrough.html' })).status, 404, 'under /selftest/, beside the pages it drives');
});

test('pages are read once at start, from a fixed list', async () => {
  const s = await start();
  writeFileSync(join(assets, 'late.js'), 'export {};\n');
  assert.equal((await raw(s.port, { path: '/late.js' })).status, 404);
  rmSync(join(assets, 'late.js'));
  assert.deepEqual([...readAssets(assets).keys()], ['/common.css', '/search.html', '/search.js']);
  assert.equal(readAssets(join(scratch, 'missing')).size, 0);
});

// ---- the one-time code and the run key ---------------------------------------------------

test('a code is traded for the key once', async () => {
  const s = await start();
  const code = s.issueCode('test');
  const first = await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: code } });
  assert.equal(first.status, 200);
  assert.match(first.json.key, /^[0-9a-f]{64}$/);
  assert.equal((await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: code } })).status, 403, 'a code works once');
  for (const bad of ['', 'nope', code.toUpperCase(), `${code}0`]) assert.equal((await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: bad } })).status, 403);
  assert.equal((await raw(s.port, { path: `/api/claim?c=${s.issueCode()}` })).status, 403, 'a code in the address is not read');
  const claimed = [];
  const t = await start({ onClaim: (p) => claimed.push(p) });
  await raw(t.port, { path: '/api/claim', headers: { [CODE_HEADER]: t.issueCode('opener') } });
  assert.deepEqual(claimed, ['opener']);
  assert.equal(t.pendingCodes(), 0);
  assert.match(t.address(), new RegExp(`^http://127\\.0\\.0\\.1:${t.port}/#c=[0-9a-f]{48}$`));
});

test('a code given a lifetime stops working when it ends, and is still used up', async () => {
  const s = await start();
  const late = s.issueCode('opener', { ttlMs: 50 });
  const soon = s.issueCode('opener', { ttlMs: 60000 });
  assert.equal((await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: soon } })).status, 200, 'within its lifetime it works');
  await new Promise((done) => setTimeout(done, 120));
  assert.equal((await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: late } })).status, 403, 'past it, it is refused');
  assert.equal(s.pendingCodes(), 0, 'and the expired code is gone');
  const fresh = new URL(s.address('opener', '', { ttlMs: 60000 })).hash.slice(3);
  assert.equal((await raw(s.port, { path: '/api/claim', headers: { [CODE_HEADER]: fresh } })).status, 200);
});

test('a data request without the run key, or with a stale one, is refused even with a correct Host', async () => {
  const s = await start();
  const key = await keyOf(s);
  const other = await start();
  const stale = await keyOf(other);
  for (const path of ['/api/status', '/api/home', '/api/replay', '/api/anything']) {
    for (const headers of [{}, { [KEY_HEADER]: '' }, { [KEY_HEADER]: stale }, { [KEY_HEADER]: key.slice(0, -1) }, { [KEY_HEADER]: `${key}0` }]) {
      const r = await raw(s.port, { path, headers });
      assert.equal(r.status, 403, `${path} ${JSON.stringify(headers).slice(0, 30)}`);
      assert.equal(r.json.error, 'no-key');
      assert.match(r.json.note, /press Enter/);
    }
  }
  assert.equal((await raw(s.port, { path: '/api/home', headers: { [KEY_HEADER]: key } })).status, 200);
  assert.equal((await raw(s.port, { path: `/api/home?k=${key}` })).status, 403, 'a key in the address is not read');
});

test('the status answer does not reveal the key', async () => {
  const w = buildViewWeek(join(scratch, 'week-status'));
  const data = createViewData({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC' });
  data.start();
  const s = await start({ data });
  const key = await keyOf(s);
  for (let i = 0; i < 2; i++) {
    const r = await raw(s.port, { path: '/api/status', headers: { [KEY_HEADER]: key } });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(key));
    assert.ok(['building', 'ready'].includes(r.json.state));
    await new Promise((res) => setTimeout(res, 200));
  }
});

test('a handler error gets 500 with no stack trace or message', async () => {
  const s = await start();
  const r = await raw(s.port, { path: '/api/boom', headers: { [KEY_HEADER]: await keyOf(s) } });
  assert.equal(r.status, 500);
  assert.ok(!r.text.includes('boom') && !r.text.includes('/home/dana') && !r.text.includes(TERM) && !r.text.includes(' at '));
});

test('the leak check exists only with --self-test, needs the key, and answers counts', async () => {
  const s = await start();
  assert.equal((await raw(s.port, { method: 'POST', path: '/api/leak-check', headers: { [KEY_HEADER]: await keyOf(s) }, body: 'x' })).status, 405);
  const t = await start({ selfTest: true });
  assert.equal((await raw(t.port, { method: 'POST', path: '/api/leak-check', body: 'abc' })).status, 403);
  const r = await raw(t.port, { method: 'POST', path: '/api/leak-check', headers: { [KEY_HEADER]: await keyOf(t) }, body: 'abc' });
  assert.deepEqual(r.json, { chars: 3, mode: 'redacted', total: 0 });
  // Text the counter can't read as asked is refused, never counted as nothing found.
  const bad = await raw(t.port, { method: 'POST', path: '/api/leak-check?parts=1', headers: { [KEY_HEADER]: await keyOf(t) }, body: 'not a list' });
  assert.equal(bad.status, 400);
});

test('private text is asked for only by the private=1 parameter', async () => {
  const s = await start();
  const key = await keyOf(s);
  calls.length = 0;
  for (const q of ['', '?private=0', '?private=true', '?private=1', '?Private=1']) await raw(s.port, { path: `/api/home${q}`, headers: { [KEY_HEADER]: key } });
  assert.deepEqual(calls.map((c) => c.params.private ?? null), [null, '0', 'true', '1', null]);
});

// ---- the shipped pages --------------------------------------------------------------------

const pageFiles = () => [ASSETS_DIR, SELFTEST_DIR].flatMap((dir) => {
  try {
    return readdirSync(dir).map((f) => join(dir, f));
  } catch {
    return [];
  }
});
const PAGES_SKIP = pageFiles().some((f) => f.endsWith('.html')) ? false : 'no pages are in lib/view/assets yet';

test('no shipped page or script holds an inline style, an inline script, or an inline event handler', { skip: PAGES_SKIP }, () => {
  for (const f of pageFiles().filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    assert.ok(!/<style[\s>]/i.test(html), `${f} has a <style> block`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${f} has a style= attribute`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${f} has an inline event handler`);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc\s*=/i, `${f} has an inline script`);
      assert.equal(m[2].trim(), '', `${f} has script text inside a script tag`);
    }
  }
});

test('the page code never puts typed words, a goal\'s id or title, or a reference\'s text in the address', { skip: PAGES_SKIP }, () => {
  for (const f of pageFiles().filter((x) => /\.m?js$/.test(x))) {
    const js = readFileSync(f, 'utf8');
    // The search page's address holds its query id (#q=<id>), never typed text: every #q= in
    // page code is built from the id the server gave, or reads one back with a pattern.
    for (const m of js.matchAll(/#q=(.{0,14})/g)) assert.match(m[1], /^(\$\{qid\}|\(\[A-Za-z0-9_-\]|\[A-Za-z0-9_-\]|<query id>)/, `${f} builds a #q= address from something other than a query id: #q=${m[1]}`);
    for (const line of js.split('\n')) {
      if (!/(location\.(hash|search|href)\s*=|history\.(push|replace)State\(|location\.(assign|replace)\()/.test(line)) continue;
      assert.ok(!/\b(query|words|title|text|value|ref)\b/.test(line), `${f} may put text in the address: ${line.trim()}`);
    }
  }
});
