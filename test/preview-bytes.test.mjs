// Byte identity for `honestweek preview`: adding `honestweek view` beside it must not
// change one byte of what preview renders or the headers it serves. view imports only
// preview's browser opener; these hashes pin the page preview builds and serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';

import { browserOpenCommand, mdToHtml, renderPage, startServer, titleFromMarkdown } from '../lib/preview.mjs';

const MD = [
  '# Weekly digest: 2024-06-10 to 2024-06-16',
  '',
  '## Shipped',
  '',
  '- **Widget parser** reads _every_ field (`abc1234`)',
  '- Faster `build` with a [link](https://example.com) and <tags> & ampersands',
  '',
  '> A quoted note.',
  '',
  '<!-- honestweek:week 2024-W24 -->',
  '',
  '```',
  'code block',
  '```',
  '',
  '## Designed, not proven',
  '',
  '- A thing (`def5678`)',
  '',
].join('\n');

const sha = (s) => createHash('sha256').update(s).digest('hex');

test('preview renders the same bytes as before', () => {
  const html = renderPage(mdToHtml(MD), { title: titleFromMarkdown(MD) });
  assert.equal(sha(html), PINNED.page, 'the rendered page changed');
});

test('preview serves the same bytes and headers as before', async () => {
  const html = renderPage(mdToHtml(MD), { title: titleFromMarkdown(MD) });
  const handle = await startServer({ html });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: handle.port, path: '/', agent: false }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(sha(res.body), PINNED.page);
    const { date: _date, connection: _c, 'keep-alive': _k, ...headers } = res.headers;
    assert.deepEqual(headers, PINNED.headers);
  } finally {
    await handle.close();
  }
});

test('preview\'s browser opener never goes through cmd, and names rundll32 by its full path on Windows', () => {
  // A URL or path with &, ^ or % and no space: cmd would have read those as its own syntax.
  const odd = 'C:\\x\\a&b^c%PATH%.html';
  assert.deepEqual(browserOpenCommand('win32', odd, { env: { SystemRoot: 'D:\\Win' } }), { cmd: 'D:\\Win\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', odd] });
  assert.equal(browserOpenCommand('win32', 'u', { env: {} }).cmd, 'C:\\Windows\\System32\\rundll32.exe');
  assert.deepEqual(browserOpenCommand('darwin', 'u'), { cmd: 'open', args: ['u'] });
  assert.deepEqual(browserOpenCommand('linux', 'u'), { cmd: 'xdg-open', args: ['u'] });
  assert.deepEqual(browserOpenCommand('linux', 'u', { isWsl: true }), { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'u'] });
});

const PINNED = {
  page: 'e2ad95c28a46cef9410b97f2bf8903ee1a35318728a68f458d512c754518687b',
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'transfer-encoding': 'chunked',
  },
};
