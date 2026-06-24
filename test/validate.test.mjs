// The `validate` gate: a pre-build honesty/leak check on the AUTHORED items —
// valid badge + receipt, no display-repo leak, no configured private term in
// prose. Mirrors build's abort discipline at the authoring layer (exit 2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateItems, runValidate } from '../lib/validate.mjs';

const CONFIG = {
  identity: { authorEmails: ['me@example.com'] },
  repos: [
    { label: 'app', path: 'app', role: 'featured' },
    { label: 'client', path: 'client', role: 'display' },
  ],
  redaction: { codenames: ['Bluejay'], names: [], terms: [] },
};

function good() {
  return [
    { status: 'shipped', text: 'Login redirect keeps the session cookie.', repo: 'app', receipt: { primaryCommit: 'abc1234' } },
    { status: 'designed, not proven', text: 'Worked through some private planning.', receipt: { sessionId: 's1' } },
  ];
}

test('validateItems passes a clean set', () => {
  const { ok, problems } = validateItems(good(), CONFIG);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
});

test('validateItems flags an invalid status badge', () => {
  const items = [{ status: 'done', text: 'x', repo: 'app', receipt: { primaryCommit: 'abc1234' } }];
  const { ok, problems } = validateItems(items, CONFIG);
  assert.equal(ok, false);
  assert.match(problems[0].reason, /invalid status/);
});

test('validateItems flags a missing receipt', () => {
  const items = [{ status: 'shipped', text: 'no receipt here', repo: 'app' }];
  const { ok, problems } = validateItems(items, CONFIG);
  assert.equal(ok, false);
  assert.match(problems[0].reason, /no receipt/);
});

test('validateItems flags missing text', () => {
  const items = [{ status: 'shipped', text: '   ', repo: 'app', receipt: { primaryCommit: 'abc1234' } }];
  const { ok, problems } = validateItems(items, CONFIG);
  assert.ok(problems.some((p) => /missing text/.test(p.reason)));
  assert.equal(ok, false);
});

test('validateItems flags naming a display-role repo, and a commit cited against one', () => {
  const items = [{ status: 'shipped', text: 'leaks the client repo name', repo: 'client', receipt: { primaryCommit: 'abc1234' } }];
  const { ok, problems } = validateItems(items, CONFIG);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /names display-role repo/.test(p.reason)));
  assert.ok(problems.some((p) => /cites a commit against display-role/.test(p.reason)));
});

test('validateItems flags a leaked configured private term WITHOUT echoing it', () => {
  const items = [{ status: 'shipped', text: 'Shipped the Bluejay integration.', repo: 'app', receipt: { primaryCommit: 'abc1234' } }];
  const { ok, problems } = validateItems(items, CONFIG);
  assert.equal(ok, false);
  assert.match(problems[0].reason, /configured private term/);
  assert.doesNotMatch(problems[0].reason, /Bluejay/, 'the leaked term must not be echoed in the problem text');
});

test('validateItems voice rule (--no-dashes) is opt-in', () => {
  const items = [{ status: 'shipped', text: 'A — dash here', repo: 'app', receipt: { primaryCommit: 'abc1234' } }];
  assert.equal(validateItems(items, CONFIG).ok, true, 'em dash allowed by default (clean-room)');
  const strict = validateItems(items, CONFIG, { noDashes: true });
  assert.equal(strict.ok, false);
  assert.match(strict.problems[0].reason, /dash/);
});

// --- runValidate end-to-end (exit codes via injected io) ---

function tmpProject(items) {
  const dir = mkdtempSync(join(tmpdir(), 'hw-validate-'));
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify(CONFIG));
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({ items }));
  return dir;
}
function captureIo() {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), exit: (c) => c, _out: out, _err: err };
}

test('runValidate exits 0 and reports OK on a clean items file', async () => {
  const dir = tmpProject(good());
  try {
    const io = captureIo();
    const code = await runValidate({ cwd: dir, argv: [], io });
    assert.equal(code, 0);
    assert.match(io._out.join(''), /validate: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidate exits 2 and lists problems on a leaky items file', async () => {
  const dir = tmpProject([{ status: 'shipped', text: 'names the client', repo: 'client', receipt: { sessionId: 's1' } }]);
  try {
    const io = captureIo();
    const code = await runValidate({ cwd: dir, argv: [], io });
    assert.equal(code, 2);
    assert.match(io._err.join(''), /display-role repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
