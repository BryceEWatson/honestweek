// Deterministic reconstruction, seeking, and scale for the work-history engine.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { buildCorpus, ME } from './fixtures/replay/corpus.mjs';

let fx;
let h;
const opts = (roots, extra = {}) => ({ config: fx.config, from: '2024-06-10', to: '2024-06-16', roots, ...extra });

before(async () => {
  fx = buildCorpus();
  h = await buildWorkHistory(opts({ claude: [fx.claudeRoot], codex: [fx.codexRoot] }));
});
after(() => {
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('the same inputs build the same history, byte for byte', async () => {
  const again = await buildWorkHistory(opts({ claude: [fx.claudeRoot], codex: [fx.codexRoot] }));
  assert.equal(JSON.stringify(again), JSON.stringify(h));
});

test('root order and a repeated root do not change the history', async () => {
  const split = mkdtempSync(join(tmpdir(), 'hw-replay-split-'));
  try {
    const second = join(split, 'second');
    mkdirSync(second, { recursive: true });
    cpSync(fx.claudeRoot, join(split, 'first'), { recursive: true });
    renameSync(join(split, 'first', 'proj-c'), join(second, 'proj-c'));
    renameSync(join(split, 'first', 'proj-d'), join(second, 'proj-d'));
    const ab = await buildWorkHistory(opts({ claude: [join(split, 'first'), second], codex: [fx.codexRoot] }));
    const ba = await buildWorkHistory(opts({ claude: [second, join(split, 'first')], codex: [fx.codexRoot] }));
    const twice = await buildWorkHistory(opts({ claude: [fx.claudeRoot, fx.claudeRoot], codex: [fx.codexRoot, fx.codexRoot] }));
    assert.equal(JSON.stringify(ab.events), JSON.stringify(ba.events));
    assert.equal(JSON.stringify(twice.events), JSON.stringify(h.events));
    assert.equal(twice.sessions.length, h.sessions.length);
  } finally {
    rmSync(split, { recursive: true, force: true });
  }
});

test('state at any moment is the same from a snapshot as from scratch', () => {
  const n = h.timeline.points;
  for (let c = -1; c < n; c++) {
    assert.deepEqual(h.timeline.stateAtCursor(c), h.timeline.stateAtCursor(c, { fromScratch: true }), `cursor ${c}`);
  }
});

test('seeking: before the first record nothing has happened; after the last everything has', () => {
  const start = h.stateAt('2024-06-01T00:00:00.000Z');
  assert.equal(start.cursor, -1);
  assert.equal(start.counts.events, 0);
  const end = h.stateAt('2030-01-01T00:00:00.000Z');
  assert.equal(end.counts.events, h.events.length);
  assert.equal(end.counts.prompts, h.events.filter((e) => e.kind === 'prompt').length);
});

test('a moment inside a tool call shows the call awaiting its recorded result', () => {
  const s = h.stateAt('2024-06-11T15:01:30.000Z');
  const waiting = s.callsAwaitingRecordedResult.map((x) => h.event(x.event).facts.command);
  assert.deepEqual(waiting, ['node --test']);
  const after = h.stateAt('2024-06-11T15:02:00.000Z');
  assert.equal(after.callsAwaitingRecordedResult.length, 0);
  assert.equal(after.counts.testRuns, 1);
  assert.equal(after.counts.testRunsWithFailures, 1);
  // The final call never got a result: it stays open, and says so.
  const late = h.stateAt('2024-06-11T23:00:00.000Z');
  const open = late.callsAwaitingRecordedResult.find((x) => x.resultNeverRecorded);
  assert.equal(h.event(open.event).facts.command, 'npm run build');
});

test('a moment inside a background agent shows its open recorded span, labelled as such', () => {
  const s = h.stateAt('2024-06-11T15:07:30.000Z');
  assert.equal(s.agentsWithOpenRecordedSpan.length, 1);
  const before = h.stateAt('2024-06-11T15:05:59.000Z');
  assert.equal(before.agentsWithOpenRecordedSpan.length, 0);
  const done = h.stateAt('2024-06-11T15:09:30.000Z');
  assert.equal(done.agentsWithOpenRecordedSpan.length, 0, 'closed by the recorded completion notice');
});

test('a queued message is visible from typing to delivery', () => {
  const s = h.stateAt('2024-06-11T15:07:00.200Z');
  assert.equal(s.messagesQueued.length, 1);
  assert.equal(h.stateAt('2024-06-11T15:07:00.500Z').messagesQueued.length, 0);
  const never = h.stateAt('2024-06-12T00:00:00.000Z').messagesQueued;
  assert.equal(never.length, 1);
  assert.equal(never[0].deliveryNeverRecorded, true);
});

test('stepping forward and back is exact, and seekWhere finds the next and previous match', () => {
  const tl = h.timeline;
  for (const start of [-1, 0, 5, Math.floor(tl.points / 2), tl.points - 1]) {
    for (const n of [1, 3, 17]) {
      const fwd = tl.step(start, n);
      const back = tl.step(fwd.cursor, -(fwd.cursor - start));
      assert.equal(back.cursor, start);
    }
  }
  assert.equal(tl.step(tl.points - 1, 10).cursor, tl.points - 1, 'clamped at the end');
  assert.equal(tl.step(0, -10).cursor, -1, 'clamped before the start');
  const mid = tl.cursorAt(Date.parse('2024-06-11T15:10:00.000Z'));
  const next = tl.seekWhere(mid, 1, (e, phase) => e.kind === 'prompt' && phase === 'start');
  assert.equal(h.event(next.event).facts.text, 'merge 7');
  const prev = tl.seekWhere(mid, -1, (e, phase) => e.kind === 'prompt' && phase === 'start');
  assert.match(h.event(prev.event).facts.text, /streaming reader/);
});

test('cumulative counts never decrease as time moves forward', () => {
  let prev = null;
  for (let c = -1; c < h.timeline.points; c++) {
    const s = h.timeline.stateAtCursor(c);
    if (prev) for (const k of ['events', 'prompts', 'actions', 'edits', 'testRuns', 'prsLanded', 'commitsFoundInGit']) assert.ok(s.counts[k] >= prev.counts[k], `${k} at ${c}`);
    prev = s;
  }
});

test('a thread timeline holds only that thread, and its final state matches the thread totals', () => {
  const thread = h.threads.find((t) => t.sessions.length === 3);
  const tl = h.threadTimeline(thread.id);
  const end = tl.stateAt(Date.parse('2030-01-01T00:00:00.000Z'));
  const totals = h.thread(thread.id).metrics;
  assert.equal(end.counts.prompts, totals.prompts.value);
  assert.equal(end.counts.actions, totals.actions.value);
  assert.ok(end.counts.events < h.timeline.stateAt(Date.parse('2030-01-01T00:00:00.000Z')).counts.events);
});

test('a large history builds, seeks consistently, and stays bounded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hw-replay-large-'));
  try {
    const repoDir = join(root, 'repo');
    mkdirSync(repoDir);
    const sid = '12121212-aaaa-4aaa-8aaa-000000000099';
    const lines = [];
    const t0 = Date.parse('2024-06-12T00:00:00.000Z');
    const ts = (i) => new Date(t0 + i * 1000).toISOString();
    let u = 0;
    const base = (type, i, extra) => JSON.stringify({ type, sessionId: sid, cwd: repoDir, uuid: `u${++u}`, timestamp: ts(i), ...extra });
    const CALLS = 12000;
    for (let i = 0; i < CALLS; i++) {
      if (i % 400 === 0) lines.push(base('user', i * 3, { message: { role: 'user', content: `step ${i}` }, origin: { kind: 'human' } }));
      lines.push(base('assistant', i * 3 + 1, { message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: i % 5 === 0 ? 'Edit' : 'Bash', input: i % 5 === 0 ? { file_path: join(repoDir, `f${i % 40}.mjs`) } : { command: i % 50 === 1 ? 'node --test' : `echo ${i}` } }] } }));
      lines.push(base('user', i * 3 + 2, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: i % 50 === 1 ? '# pass 9\n# fail 0' : 'ok' }] }, toolUseResult: i % 5 === 0 ? { structuredPatch: [{ lines: ['+a', '-b'] }] } : { stdout: i % 50 === 1 ? '# pass 9\n# fail 0' : 'ok', stderr: '' } }));
    }
    mkdirSync(join(root, 'claude', 'p'), { recursive: true });
    writeFileSync(join(root, 'claude', 'p', `${sid}.jsonl`), lines.join('\n') + '\n');
    const config = normalizeConfig({ identity: { authorEmails: [ME] }, week: { timezone: 'UTC' }, repos: [{ path: repoDir, label: 'big', role: 'featured' }], output: { mode: 'digest', file: 'x.md' } }, { configDir: root });
    const started = Date.now();
    const big = await buildWorkHistory({ config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [join(root, 'claude')], codex: [] }, git: false });
    const buildMs = Date.now() - started;
    assert.equal(big.events.filter((e) => e.kind === 'action').length, CALLS);
    assert.ok(buildMs < 60000, `built ${big.events.length} events in ${buildMs} ms`);
    // Seeks across checkpoints agree with a full fold, and are fast.
    const tl = big.timeline;
    const cursors = [0, 511, 512, 513, 1023, 1024, tl.points - 1, ...Array.from({ length: 20 }, (_, i) => Math.floor(((i + 1) * tl.points) / 23))];
    for (const c of cursors) assert.deepEqual(tl.stateAtCursor(c), tl.stateAtCursor(c, { fromScratch: true }), `cursor ${c}`);
    const seekStart = Date.now();
    for (let i = 0; i < 2000; i++) tl.stateAt(t0 + ((i * 7919) % (CALLS * 3)) * 1000);
    assert.ok(Date.now() - seekStart < 20000, '2,000 seeks stay fast');
    const end = tl.stateAtCursor(tl.points - 1);
    assert.equal(end.counts.testRuns, CALLS / 50);
    assert.equal(end.counts.edits, CALLS / 5);
    assert.equal(end.filesEdited, 8, 'every fifth call edits one of f0, f5, … f35');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
