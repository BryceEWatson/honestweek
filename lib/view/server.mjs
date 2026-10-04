// lib/view/server.mjs: the loopback server behind `honestweek view`.
//
// It binds 127.0.0.1 only and answers only reads (GET and HEAD); the one POST route,
// the self-test's leak counter, exists only with --self-test. Every response carries a
// strict content policy, so each page loads scripts, styles and data only from this
// server, plus nosniff, no-referrer and no-store.
//
// Other programs and other websites must not read the data, so:
//   - a request whose Host isn't 127.0.0.1:<port> or localhost:<port> is refused (a
//     website can't rebind its own name to this address and read it);
//   - a data request a browser marks as coming from another site is refused;
//   - every data request must carry this run's key in a header. The key is 32 random
//     bytes made at start. It's never put in an address or a process argument: the
//     address the command opens or prints carries a one-time code instead, which the
//     page trades once, through /api/claim, for the key. A code works once and lives in
//     memory only; one given a lifetime (the opener file's) stops working when it ends.
//     The key is compared in constant time and no other answer holds it.
//
// Routes come from a fixed table, and the pages from a fixed list of files read once at
// start. Nothing joins a path from the address.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url));
export const SELFTEST_DIR = fileURLToPath(new URL('./selftest/', import.meta.url));

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const CSP_SELF_TEST = `${CSP}; frame-src 'self'`;

export const KEY_HEADER = 'x-honestweek-key';
export const CODE_HEADER = 'x-honestweek-code';

/** What a page without this run's key is told. */
export const NO_KEY_NOTE = "This page doesn't have the key for this run of honestweek view. In the terminal where it's running, press Enter to print a fresh address, then open that address.";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_URL = 8192;
const MAX_BODY = 16 * 1024 * 1024;
/** Unclaimed codes kept at once; asking for more drops the oldest. */
const MAX_CODES = 64;

const digest = (s) => createHash('sha256').update(String(s)).digest();
const sameDigest = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * readAssets(dir) -> Map('/<name>' -> { type, body })
 * The page files in one folder, read once: plain files whose names and extensions are
 * on the list. A missing folder gives an empty map.
 */
export function readAssets(dir) {
  const out = new Map();
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const type = TYPES[extname(e.name).toLowerCase()];
    if (!e.isFile() || !type || !NAME_RE.test(e.name)) continue;
    out.set(`/${e.name}`, { type, body: readFileSync(join(dir, e.name)) });
  }
  return out;
}

/**
 * startViewServer({ data, port, selfTest, assetsDir, selftestDir, onClaim })
 *   -> Promise<{ url, port, issueCode(purpose, { ttlMs }), address(purpose, page, { ttlMs }), pendingCodes(), close() }>
 * `data` answers the data routes (lib/view/data.mjs). `onClaim(purpose)` runs when a
 * code is traded for the key, with the purpose it was issued for. `address(purpose, page)`
 * is this server's address for one page (the Problems page by default) with a fresh code.
 */
export function startViewServer({ data, port = 0, selfTest = false, assetsDir = ASSETS_DIR, selftestDir = SELFTEST_DIR, onClaim = () => {} } = {}) {
  const keyText = randomBytes(32).toString('hex');
  const keyDigest = digest(keyText);
  const codes = new Map(); // code digest (hex) -> { purpose, expires }
  const assets = readAssets(assetsDir);
  // The self-test's own files sit under /selftest/, beside the pages it drives.
  if (selfTest) for (const [path, file] of readAssets(selftestDir)) assets.set(`/selftest${path}`, file);
  // The bare address opens on Problems; search.html and every other page keep their own address.
  const home = assets.get('/problems.html') ?? assets.get('/search.html') ?? assets.get('/index.html') ?? null;
  if (home && !assets.has('/')) assets.set('/', home);
  const csp = selfTest ? CSP_SELF_TEST : CSP;
  let boundPort = port;

  const headers = (type, length) => ({
    'Content-Type': type,
    'Content-Length': length,
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  const send = (req, res, status, type, body, extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(status, { ...headers(type, buf.length), ...extra });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  const sendJson = (req, res, status, body) => send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(body));
  const text = (req, res, status, msg, extra) => send(req, res, status, 'text/plain; charset=utf-8', `${msg}\n`, extra);

  /** A fresh code for `purpose`; with `ttlMs`, it stops working that long after now. */
  function issueCode(purpose = 'address', { ttlMs = null } = {}) {
    const code = randomBytes(24).toString('hex');
    codes.set(digest(code).toString('hex'), { purpose, expires: Number.isFinite(ttlMs) ? Date.now() + ttlMs : Infinity });
    while (codes.size > MAX_CODES) codes.delete(codes.keys().next().value);
    return code;
  }

  /** Trade a code for the key: every pending code is compared, in constant time each. */
  function claim(code) {
    if (typeof code !== 'string' || !code) return null;
    const d = digest(code);
    let hit = null;
    for (const k of codes.keys()) if (sameDigest(Buffer.from(k, 'hex'), d)) hit = k;
    if (hit === null) return null;
    const { purpose, expires } = codes.get(hit);
    codes.delete(hit);
    return Date.now() <= expires ? purpose : null;
  }

  const hasKey = (req) => {
    const given = req.headers[KEY_HEADER];
    return typeof given === 'string' && given.length > 0 && sameDigest(digest(given), keyDigest);
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return null;
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handle(req, res) {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';
    const leakCheck = selfTest && method === 'POST' && rawUrl.split('?')[0] === '/api/leak-check';
    if (method !== 'GET' && method !== 'HEAD' && !leakCheck) return text(req, res, 405, '405 method not allowed', { Allow: 'GET, HEAD' });

    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return text(req, res, 403, '403 this server answers only 127.0.0.1 and localhost');

    if (rawUrl.length > MAX_URL || !rawUrl.startsWith('/')) return text(req, res, 400, '400 malformed address');
    let url;
    try {
      url = new URL(rawUrl, `http://127.0.0.1:${boundPort}`);
      decodeURIComponent(url.pathname);
      decodeURIComponent(url.search.replace(/\+/g, ' '));
    } catch {
      return text(req, res, 400, '400 malformed address');
    }
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
      if (site === 'cross-site' || site === 'same-site') return sendJson(req, res, 403, { error: 'other-site', note: 'Requests from other sites are refused.' });
      if (path === '/api/claim') {
        if (method !== 'GET') return text(req, res, 405, '405 method not allowed', { Allow: 'GET' });
        const purpose = claim(req.headers[CODE_HEADER]);
        if (purpose === null) return sendJson(req, res, 403, { error: 'no-key', note: NO_KEY_NOTE });
        try {
          onClaim(purpose);
        } catch {
          /* a cleanup that fails never blocks the page */
        }
        return sendJson(req, res, 200, { key: keyText });
      }
      if (!hasKey(req)) return sendJson(req, res, 403, { error: 'no-key', note: NO_KEY_NOTE });
      if (leakCheck) {
        const body = await readBody(req);
        if (body === null) return sendJson(req, res, 413, { error: 'That text is larger than 16 MB.' });
        const counted = data.leakCheck(body, url.searchParams);
        return sendJson(req, res, counted?.error ? 400 : 200, counted);
      }
      if (method === 'POST') return text(req, res, 405, '405 method not allowed', { Allow: 'GET, HEAD' });
      const answer = await data.route(path, url.searchParams);
      return sendJson(req, res, answer.status, answer.body);
    }

    const asset = assets.get(path);
    if (!asset) return text(req, res, 404, '404 not found');
    return send(req, res, 200, asset.type, asset.body);
  }

  const sockets = new Set();
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) return res.destroy();
      try {
        sendJson(req, res, 500, { error: 'Something went wrong answering that request.' });
      } catch {
        res.destroy();
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  // A request line the HTTP parser can't read gets a plain 400, not a crash.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject);
      boundPort = server.address().port;
      const url = `http://127.0.0.1:${boundPort}/`;
      resolve({
        url,
        port: boundPort,
        issueCode,
        address: (purpose = 'address', page = '', opts) => `${url}${page}#c=${issueCode(purpose, opts)}`,
        pendingCodes: () => codes.size,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            for (const s of sockets) s.destroy();
          }),
      });
    });
  });
}
