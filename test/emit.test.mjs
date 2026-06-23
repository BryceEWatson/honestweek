import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emit, renderFor } from '../lib/emit/index.mjs';
import * as digest from '../lib/emit/digest.mjs';
import * as post from '../lib/emit/post.mjs';
import * as changelog from '../lib/emit/changelog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT_DIR = resolve(HERE, '..', 'lib', 'emit');

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
  return mkdtempSync(join(tmpdir(), 'hw-emit-'));
}

test('renderFor / emit dispatch strictly by mode; unknown mode throws naming the value and valid set', () => {
  assert.throws(() => renderFor('tweet', model(), {}), /unknown output mode.*tweet[\s\S]*post[\s\S]*changelog[\s\S]*digest/);
  assert.throws(() => emit(model(), { output: { mode: 'tweet', file: 'x.md' } }), /unknown output mode.*tweet/);
});

test('each render() is pure (returns a string, writes nothing)', () => {
  const before = readdirSync(EMIT_DIR).length;
  for (const r of [digest.render, post.render, changelog.render]) {
    const out = r(model(), {});
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  }
  assert.equal(readdirSync(EMIT_DIR).length, before, 'render() must not create files');
});

test('every rendered item carries its exact status badge string (all three appear)', () => {
  const out = digest.render(model(), {});
  assert.match(out, /\bshipped\b/);
  assert.match(out, /in progress/);
  assert.match(out, /designed, not proven/);
});

test('an item missing a receipt is a clear error, not a receipt-less line', () => {
  const bad = model({ items: [{ status: 'shipped', text: 'No receipt here.' }] });
  assert.throws(() => digest.render(bad, {}), /receipt/);
  assert.throws(() => post.render(bad, {}), /receipt/);
});

test('an item missing/invalid status is a clear error', () => {
  const bad = model({ items: [{ status: 'maybe', text: 'x', receipt: { ref: 'r' } }] });
  assert.throws(() => digest.render(bad, {}), /status/);
});

test('post mode orders items most-shippable-first, each with badge + receipt', () => {
  const out = post.render(model(), {});
  const iShipped = out.indexOf('shipped');
  const iProgress = out.indexOf('in progress');
  const iDesigned = out.indexOf('designed, not proven');
  assert.ok(iShipped < iProgress && iProgress < iDesigned, 'shipped < in progress < designed');
  // every item line carries its receipt pointer
  assert.match(out, /a1b2c3d/);
  assert.match(out, /b2c3d4e/);
  assert.match(out, /session-abc/);
});

test('changelog appends a dated section, replaces same-week in place, preserves the rest', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'CHANGELOG.md');
    const prior =
      '# Changelog\n\nSome unrelated notes.\n\n' +
      '<!-- honestweek:week:2024-06-03/2024-06-09 -->\n' +
      '## This week (2024-06-03 – 2024-06-09)\n\n- old item  (`zzz`)\n' +
      '<!-- /honestweek:week:2024-06-03/2024-06-09 -->\n';
    writeFileSync(file, prior);

    const cfg = { output: { mode: 'changelog', file } };
    emit(model(), cfg);
    let after = readFileSync(file, 'utf8');
    assert.match(after, /Some unrelated notes\./, 'unrelated content preserved');
    assert.match(after, /2024-06-03 – 2024-06-09/, 'prior week section preserved');
    assert.match(after, /2024-06-10 – 2024-06-16/, 'new week section added');

    // Re-emit the same week: section is replaced in place, not duplicated.
    emit(model(), cfg);
    after = readFileSync(file, 'utf8');
    const occurrences = after.split('<!-- honestweek:week:2024-06-10/2024-06-16 -->').length - 1;
    assert.equal(occurrences, 1, 'same-week section must not duplicate');
    assert.match(after, /Some unrelated notes\./);
    assert.match(after, /2024-06-03 – 2024-06-09/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('digest is the default mode and writes to the default path when file is unset', () => {
  const dir = tmp();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const res = emit(model(), { output: {} }); // no mode, no file
    assert.equal(res.mode, 'digest');
    assert.equal(res.path, 'honestweek.digest.md');
    assert.ok(existsSync(join(dir, 'honestweek.digest.md')));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('output.file when set wins over the default path', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'custom.md');
    const res = emit(model(), { output: { mode: 'post', file } });
    assert.equal(res.path, file);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rendering is deterministic — byte-identical for a fixed model + config', () => {
  assert.equal(digest.render(model(), {}), digest.render(model(), {}));
  assert.equal(post.render(model(), {}), post.render(model(), {}));
  const dir = tmp();
  try {
    const file = join(dir, 'd.md');
    emit(model(), { output: { mode: 'digest', file } });
    const a = readFileSync(file, 'utf8');
    emit(model(), { output: { mode: 'digest', file } });
    const b = readFileSync(file, 'utf8');
    assert.equal(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitters perform no network/publish action and import only Node built-ins + project lib', () => {
  for (const f of readdirSync(EMIT_DIR)) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(join(EMIT_DIR, f), 'utf8');
    // no network / process spawning / publish surfaces
    assert.doesNotMatch(src, /child_process|node:http|node:https|node:net|\bfetch\s*\(|git\s+push|\bgh\b|curl/, `${f} must not reach the network`);
    // every import is a node: builtin or a relative project path
    for (const m of src.matchAll(/import[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `${f} imports a non-builtin: ${spec}`);
    }
  }
});

test('output is well-formed Markdown for each mode', () => {
  const d = digest.render(model(), {});
  assert.match(d, /^# Weekly digest/m);
  assert.match(d, /^- \*\*/m);
  const p = post.render(model(), {});
  assert.match(p, /^\*\*This week\*\*/m);
  const c = changelog.render(model(), {});
  assert.match(c, /^## This week/m);
  assert.match(c, /^<!-- honestweek:week:/m);
});

test('empty report model still renders a valid, honest digest', () => {
  const out = digest.render({ week: { start: '2024-06-10', end: '2024-06-16' }, items: [] }, {});
  assert.match(out, /# Weekly digest/);
  assert.match(out, /No interactive coding sessions/);
});
