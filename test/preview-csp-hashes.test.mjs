// preview's CSP for an HTML output allows only the inline scripts honestweek's own
// emitters write, each by its sha256 hash, never a blanket 'unsafe-inline'. It also
// forbids form submission and <base>. The test serves real rendered pages through
// runPreview and checks every inline script they contain is covered by a listed hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runPreview } from '../lib/preview.mjs';
import * as page from '../lib/emit/page.mjs';
import * as goalsPage from '../lib/emit/goals-page.mjs';
import * as client from '../lib/emit/client.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

function fakeIo() {
  return { out() {}, err() {}, exit(code) { return code; } };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

// Every <script> element without a src attribute, as the exact text a browser hashes.
function inlineScripts(html) {
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] && /\ssrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

const hashOf = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

function scriptSrc(csp) {
  const d = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
  return d ? d.split(/\s+/).slice(1) : [];
}

async function serve(dir, file) {
  let handle;
  const code = await runPreview({ cwd: dir, argv: ['--file', file, '--no-open'], io: fakeIo(), block: false, onServe: (h) => (handle = h) });
  assert.equal(code, 0);
  return handle;
}

test('HTML preview CSP: hashed scripts only, plus form-action and base-uri none', async () => {
  const dir = makeTempDir('hw-preview-csp-');
  let handle;
  try {
    const file = join(dir, 'honestweek.report.html');
    writeFileSync(file, page.render(page.buildPageModel({})));
    writeFileSync(join(dir, 'goals.html'), goalsPage.render({}));
    handle = await serve(dir, file);
    for (const path of ['', 'goals.html']) {
      const res = await httpGet(handle.url + path);
      assert.equal(res.status, 200);
      const csp = res.headers['content-security-policy'];
      const sources = scriptSrc(csp);
      assert.ok(sources.length > 0, 'script-src is present');
      assert.ok(!sources.includes("'unsafe-inline'"), 'script-src has no unsafe-inline');
      assert.ok(sources.every((s) => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(s)), 'script-src lists only sha256 hashes');
      assert.match(csp, /(^|;\s*)form-action 'none'(;|$)/);
      assert.match(csp, /(^|;\s*)base-uri 'none'(;|$)/);
      assert.match(csp, /default-src 'none'/);
      const scripts = inlineScripts(res.body);
      assert.ok(scripts.length > 0, `${path || 'report'} has an inline script to check`);
      for (const s of scripts) assert.ok(sources.includes(hashOf(s)), `inline script in ${path || 'report'} is covered by a listed hash`);
    }
  } finally {
    if (handle) await handle.close();
    removeTempDir(dir);
  }
});

test('HTML preview CSP covers the client report script and no injected one', async () => {
  const dir = makeTempDir('hw-preview-csp-');
  let handle;
  try {
    const file = join(dir, 'honestweek.client.html');
    const injected = '<script>alert(1)</script>';
    writeFileSync(file, client.render({}).replace('</body>', `${injected}</body>`));
    handle = await serve(dir, file);
    const res = await httpGet(handle.url);
    const sources = scriptSrc(res.headers['content-security-policy']);
    const scripts = inlineScripts(res.body);
    assert.ok(sources.includes(hashOf(client.SCRIPT)), 'the client report script is allowed');
    assert.ok(scripts.includes('alert(1)'), 'the injected script is in the served file');
    assert.ok(!sources.includes(hashOf('alert(1)')), 'a script honestweek did not write is not allowed');
  } finally {
    if (handle) await handle.close();
    removeTempDir(dir);
  }
});
