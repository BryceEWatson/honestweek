// test/preview.test.mjs — the `preview` subcommand.
//
// preview is a long-lived server command, so the tests NEVER enter runPreview's
// blocking serve loop (block: true). They either (a) test the pure functions
// (mdToHtml / renderPage / browserOpenCommand / titleFromMarkdown), or (b) drive
// the server via startServer / runPreview({ block: false }) and close() the
// handle in a finally{} so node:test exits with no dangling handles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  escapeHtml,
  mdToHtml,
  renderPage,
  titleFromMarkdown,
  browserOpenCommand,
  startServer,
  runPreview,
} from '../lib/preview.mjs';
import * as digest from '../lib/emit/digest.mjs';
import * as post from '../lib/emit/post.mjs';
import * as report from '../lib/emit/report.mjs';
import * as changelog from '../lib/emit/changelog.mjs';

// --- fixtures ---------------------------------------------------------------

function model(overrides = {}) {
  return {
    week: { start: '2024-06-10', end: '2024-06-16' },
    items: [
      { status: 'designed, not proven', text: 'Sketched a retry queue.', repo: 'api', receipt: { ref: 'session-abc' } },
      { status: 'shipped', text: 'Fixed the login redirect.', repo: 'api', receipt: { shortSha: 'a1b2c3d' } },
      { status: 'in progress', text: 'Migrating the config loader.', repo: 'web', receipt: { ref: 'b2c3d4e' } },
    ],
    ...overrides,
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'hw-preview-'));
}

function fakeIo() {
  const io = {
    outBuf: '',
    errBuf: '',
    exitCode: null,
    out(s) { io.outBuf += s; },
    err(s) { io.errBuf += s; },
    exit(code) { io.exitCode = code; return code; },
  };
  return io;
}

/** GET a URL, resolving { status, headers, body }. */
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

// --- escapeHtml / mdToHtml --------------------------------------------------

test('escapeHtml neutralizes &, <, > and nothing else', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('mdToHtml renders the honestweek subset: headings, bullets, bold, italic, code', () => {
  const out = mdToHtml('# Title\n\n## Section\n\n- **shipped** — Fixed it _(api)_  (`a1b2c3d`)');
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<h2>Section<\/h2>/);
  assert.match(out, /<ul>/);
  assert.match(out, /<li><strong>shipped<\/strong> — Fixed it <em>\(api\)<\/em>  \(<code>a1b2c3d<\/code>\)<\/li>/);
  assert.match(out, /<\/ul>/);
});

test('mdToHtml renders a blockquote (the digest privacy banner)', () => {
  const out = mdToHtml('> Private, local-only working draft.');
  assert.match(out, /<blockquote>\s*<p>Private, local-only working draft\.<\/p>\s*<\/blockquote>/);
});

test('mdToHtml passes em and en dashes through literally', () => {
  const out = mdToHtml('# Weekly digest — 2024-06-10 to 2024-06-16\n\n**This week** (2024-06-10 – 2024-06-16)');
  assert.ok(out.includes('—'), 'em dash preserved');
  assert.ok(out.includes('–'), 'en dash preserved');
});

test('mdToHtml is escape-first: a <script> in item text cannot inject markup (XSS guard)', () => {
  const out = mdToHtml('- **shipped** — Fixed login & <script>alert(1)</script>  (`x`)');
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'script tag is escaped');
  assert.ok(!/<script>/i.test(out), 'no live <script> tag in output');
  assert.ok(out.includes('Fixed login &amp;'), 'ampersand escaped');
});

test('mdToHtml does not italicize intraword underscores', () => {
  const out = mdToHtml('- **shipped** — touched lib/some_snake_case_name here  (`x`)');
  assert.ok(!out.includes('<em>'), 'snake_case must not become emphasis');
  assert.ok(out.includes('some_snake_case_name'), 'underscores left literal');
});

test('mdToHtml drops changelog HTML-comment marker lines', () => {
  const out = mdToHtml('<!-- honestweek:week:2024-06-10/2024-06-16 -->\n## This week (2024-06-10 – 2024-06-16)\n\n- **shipped** — x  (`y`)\n<!-- /honestweek:week:2024-06-10/2024-06-16 -->');
  assert.ok(!out.includes('<!--'), 'comment markers are not rendered');
  assert.ok(!out.includes('honestweek:week'), 'marker text is not rendered');
  assert.match(out, /<h2>This week/);
});

test('mdToHtml keeps a backticked code span literal even with ** or _ inside', () => {
  const out = mdToHtml('- **shipped** — see `a**b_c` token  (`r`)');
  assert.match(out, /<code>a\*\*b_c<\/code>/, 'code span content is not emphasized');
});

// --- mdToHtml against REAL emitter output (golden coupling) ------------------

test('mdToHtml renders real digest output to well-formed HTML', () => {
  const md = digest.render(model(), {});
  const html = mdToHtml(md);
  assert.match(html, /<h1>Weekly digest/);
  assert.match(html, /<h2>Shipped<\/h2>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<li><strong>shipped<\/strong>/);
  assert.match(html, /<code>a1b2c3d<\/code>/);
  assert.ok(!html.includes('- **'), 'raw markdown bullets are converted, not passed through');
});

test('mdToHtml renders real post and report output', () => {
  const p = mdToHtml(post.render(model(), {}));
  assert.match(p, /<strong>This week<\/strong>/);
  assert.match(p, /<li><strong>shipped<\/strong>/);

  const reportModel = {
    week: { start: '2024-06-10', end: '2024-06-16' },
    groups: [
      {
        label: 'api',
        role: 'featured',
        metrics: { commits: 4, activeDays: 3 },
        items: [{ status: 'shipped', text: 'Fixed the login redirect.', receipt: { shortSha: 'a1b2c3d' } }],
      },
    ],
    items: [],
  };
  const r = mdToHtml(report.render(reportModel, {}));
  assert.match(r, /<h1>Weekly report/);
  assert.match(r, /<h2>api<\/h2>/);
  assert.match(r, /<em>4 commits · 3 active days<\/em>/);
});

test('mdToHtml renders a real changelog file, preserving foreign prose and dropping markers', () => {
  const block = changelog.render(model(), {});
  const file =
    '# Changelog\n\nSome unrelated notes.\n\n' +
    changelog.mergeIntoChangelog('', block, model().week);
  const html = mdToHtml(file);
  assert.match(html, /<h1>Changelog<\/h1>/);
  assert.match(html, /Some unrelated notes\./, 'foreign content preserved');
  assert.match(html, /<h2>This week/);
  assert.ok(!html.includes('honestweek:week'), 'managed markers stripped');
});

// --- titleFromMarkdown ------------------------------------------------------

test('titleFromMarkdown uses the H1, else the week range, else a default', () => {
  assert.equal(titleFromMarkdown('# Weekly digest — 2024-06-10 to 2024-06-16\n\nbody'), 'Weekly digest — 2024-06-10 to 2024-06-16');
  assert.equal(titleFromMarkdown('**This week** (2024-06-10 – 2024-06-16)'), 'honestweek: 2024-06-10 to 2024-06-16');
  assert.equal(titleFromMarkdown('no heading, no range'), 'honestweek preview');
});

// --- renderPage: self-contained, zero external resources --------------------

test('renderPage produces a self-contained document with NO external resources', () => {
  const page = renderPage(mdToHtml(digest.render(model(), {})), { title: 'T' });
  assert.match(page, /^<!DOCTYPE html>/);
  assert.match(page, /<meta charset="utf-8">/);
  assert.match(page, /<title>T<\/title>/);
  // the load-bearing invariant: nothing the browser would fetch off-box
  assert.ok(!/https?:\/\//.test(page), 'no absolute http(s) URL');
  assert.ok(!/<script/i.test(page), 'no script element at all');
  assert.ok(!/<link\b/i.test(page), 'no <link> (stylesheet/font/icon)');
  assert.ok(!/\bsrc=/i.test(page), 'no src= attribute');
  assert.ok(!/@import/i.test(page), 'no CSS @import');
  assert.ok(!/url\(/i.test(page), 'no CSS url()');
});

test('renderPage escapes the title', () => {
  const page = renderPage('<p>x</p>', { title: '<script>bad</script>' });
  assert.ok(page.includes('<title>&lt;script&gt;bad&lt;/script&gt;</title>'));
  assert.ok(!/<title><script>/.test(page));
});

// --- browserOpenCommand (pure, per platform) --------------------------------

test('browserOpenCommand picks the right opener per platform, incl. WSL', () => {
  assert.deepEqual(browserOpenCommand('win32', 'http://127.0.0.1:9/'), { cmd: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:9/'] });
  assert.deepEqual(browserOpenCommand('darwin', 'http://127.0.0.1:9/'), { cmd: 'open', args: ['http://127.0.0.1:9/'] });
  assert.deepEqual(browserOpenCommand('linux', 'http://127.0.0.1:9/'), { cmd: 'xdg-open', args: ['http://127.0.0.1:9/'] });
  assert.deepEqual(browserOpenCommand('linux', 'http://127.0.0.1:9/', { isWsl: true }), { cmd: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:9/'] });
  // the win32 'start' empty-title placeholder must be present (URL with & gotcha)
  assert.equal(browserOpenCommand('win32', 'http://127.0.0.1:9/?a=1&b=2').args[2], '');
});

// --- startServer: loopback bind, correct headers, 404 -----------------------

test('startServer binds loopback only and serves the HTML at / with hardened headers', async () => {
  const handle = await startServer({ port: 0, html: '<!DOCTYPE html><title>hi</title>' });
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'url is loopback');
    assert.equal(handle.server.address().address, '127.0.0.1', 'bind address is loopback, never 0.0.0.0');
    const res = await httpGet(handle.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.ok(res.body.includes('<title>hi</title>'));
  } finally {
    await handle.close();
  }
});

test('startServer 404s any path other than /', async () => {
  const handle = await startServer({ port: 0, html: '<x>' });
  try {
    const res = await httpGet(`http://127.0.0.1:${handle.port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await handle.close();
  }
});

// --- runPreview orchestration -----------------------------------------------

test('runPreview --help prints usage and exits 0 without starting a server', async () => {
  const io = fakeIo();
  const code = await runPreview({ argv: ['--help'], io });
  assert.equal(code, 0);
  assert.match(io.outBuf, /honestweek preview:/);
  assert.match(io.outBuf, /--no-open/);
});

test('runPreview exits 1 when there is no config and no --file', async () => {
  const dir = tmp();
  try {
    const io = fakeIo();
    const code = await runPreview({ cwd: dir, argv: ['--no-open'], io, block: false });
    assert.equal(code, 1);
    assert.equal(io.exitCode, 1);
    assert.match(io.errBuf, /no honestweek\.config\.json|--file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreview exits 1 when the output file is absent', async () => {
  const dir = tmp();
  try {
    const io = fakeIo();
    const code = await runPreview({ cwd: dir, argv: ['--file', join(dir, 'nope.md'), '--no-open'], io, block: false });
    assert.equal(code, 1);
    assert.match(io.errBuf, /not found/);
    assert.match(io.errBuf, /build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreview rejects a bad --port (both spellings) before serving', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'out.md');
    writeFileSync(file, '# Hi\n');
    for (const argv of [['--file', file, '--port', 'abc', '--no-open'], ['--file', file, '--port=70000', '--no-open']]) {
      const io = fakeIo();
      const code = await runPreview({ cwd: dir, argv, io, block: false });
      assert.equal(code, 1, `bad port via ${argv.join(' ')}`);
      assert.match(io.errBuf, /--port must be an integer/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreview reports a clear error when the requested --port is already in use', async () => {
  const dir = tmp();
  let blocker;
  try {
    const file = join(dir, 'out.md');
    writeFileSync(file, '# Hi\n');
    blocker = await startServer({ port: 0, html: '<x>' }); // claim a free port
    const io = fakeIo();
    const code = await runPreview({
      cwd: dir,
      argv: ['--file', file, '--port', String(blocker.port), '--no-open'],
      io,
      block: false,
    });
    assert.equal(code, 1);
    assert.match(io.errBuf, /already in use/);
  } finally {
    if (blocker) await blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreview serves the rendered file on loopback and honors --no-open', async () => {
  const dir = tmp();
  let handle;
  try {
    const file = join(dir, 'out.md');
    writeFileSync(file, '# Weekly digest — 2024-06-10 to 2024-06-16\n\n- **shipped** — Did a thing  (`a1b2c3d`)\n');
    const io = fakeIo();
    const opened = [];
    const code = await runPreview({
      cwd: dir,
      argv: ['--file', file, '--no-open'],
      io,
      block: false,
      opener: (url) => opened.push(url),
      onServe: (h) => (handle = h),
    });
    assert.equal(code, 0);
    assert.deepEqual(opened, [], '--no-open must not launch a browser');
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await httpGet(handle.url);
    assert.equal(res.status, 200);
    assert.match(res.body, /<h1>Weekly digest/);
    assert.match(res.body, /<code>a1b2c3d<\/code>/);
    assert.ok(!/https?:\/\//.test(res.body), 'served page references no external URL');
  } finally {
    if (handle) await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreview opens the browser with the loopback URL when --no-open is absent', async () => {
  const dir = tmp();
  let handle;
  try {
    const file = join(dir, 'out.md');
    writeFileSync(file, '# Hi\n');
    const io = fakeIo();
    const opened = [];
    await runPreview({
      cwd: dir,
      argv: ['--file', file],
      io,
      block: false,
      opener: (url) => opened.push(url),
      onServe: (h) => (handle = h),
    });
    assert.equal(opened.length, 1, 'opener called once');
    assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    if (handle) await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview.mjs default-exports a run() that delegates to runPreview', async () => {
  const mod = await import('../lib/preview.mjs');
  assert.equal(typeof mod.default, 'function');
});

test('runPreview serves a `page` (.html) output VERBATIM under a script-permitting, no-egress CSP', async () => {
  const dir = tmp();
  let handle;
  try {
    const file = join(dir, 'honestweek.report.html');
    const doc = '<!DOCTYPE html><title>t</title><div class="wl-panel">hi</div><script>window.__ok=1;</script>';
    writeFileSync(file, doc);
    const io = fakeIo();
    const code = await runPreview({ cwd: dir, argv: ['--file', file, '--no-open'], io, block: false, onServe: (h) => (handle = h) });
    assert.equal(code, 0);
    const res = await httpGet(handle.url);
    assert.equal(res.status, 200);
    assert.equal(res.body, doc, 'the standalone HTML is served byte-for-byte (no markdown conversion)');
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/, 'still zero external egress');
    assert.match(csp, /script-src 'unsafe-inline'/, 'inline interactivity is allowed for the page output');
    assert.ok(!/https?:\/\//.test(csp), 'no external source is whitelisted in the CSP');
  } finally {
    if (handle) await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreview keeps the locked-down (no-script) CSP for a Markdown output', async () => {
  const dir = tmp();
  let handle;
  try {
    const file = join(dir, 'out.md');
    writeFileSync(file, '# Hi\n\n- **shipped** — x  (`a1b2c3d`)\n');
    const io = fakeIo();
    const code = await runPreview({ cwd: dir, argv: ['--file', file, '--no-open'], io, block: false, onServe: (h) => (handle = h) });
    assert.equal(code, 0);
    const res = await httpGet(handle.url);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/script-src/.test(csp), 'a Markdown preview never permits inline script');
  } finally {
    if (handle) await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
