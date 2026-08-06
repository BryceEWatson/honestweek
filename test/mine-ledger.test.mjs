// test/mine-ledger.test.mjs — the error signal, and the properties that make it one.
//
// The ledger's whole job is to stop the pipeline from reporting activity ("found 3
// things this run") when the question is whether anything reached a reader. These
// tests pin the properties that difference depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backlog, errorSignal, loadLedger, mergeFindings, nextToDraft, recordRun, saveLedger, setStatus } from '../lib/mine/ledger.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'hw-ledger-'));
}

const finding = (key, score = 20) => ({
  findingKey: key,
  score,
  measuredScore: score - 4,
  primaryError: key,
  startedAt: '2026-06-01T00:00:00.000Z',
  corpus: 'claude-code',
  sessionCount: 1,
  products: [],
  versions: [],
  resolution: [],
  evidence: {},
  scoreComponents: [],
});

test('a fresh ledger has an empty backlog and a zero error signal', () => {
  const l = loadLedger(null);
  assert.deepEqual(backlog(l), []);
  assert.equal(errorSignal(l).backlog, 0);
  assert.equal(errorSignal(l).discovered, 0);
});

test('merging findings raises the backlog; deciding is the only thing that lowers it', () => {
  const l = loadLedger(null);
  mergeFindings(l, [finding('a'), finding('b')]);
  assert.equal(errorSignal(l).backlog, 2);

  // Drafting does NOT lower it — a draft nobody looked at is still undecided.
  setStatus(l, 'a', 'drafted');
  assert.equal(errorSignal(l).backlog, 2, 'drafting must not count as deciding');

  setStatus(l, 'a', 'published');
  assert.equal(errorSignal(l).backlog, 1);
  setStatus(l, 'b', 'declined');
  assert.equal(errorSignal(l).backlog, 0);
  assert.equal(errorSignal(l).decided, 2);
});

test('a declined finding is never resurrected by seeing it again', () => {
  const l = loadLedger(null);
  mergeFindings(l, [finding('a')]);
  setStatus(l, 'a', 'declined');

  const res = mergeFindings(l, [finding('a', 99)]);
  assert.equal(res.suppressed, 1);
  assert.equal(l.findings[0].status, 'declined');
  assert.equal(l.findings[0].score, 20, 'a decided finding must not be re-scored back into contention');
  assert.equal(errorSignal(l).backlog, 0);
});

test('re-detecting an open finding refreshes it without duplicating it', () => {
  const l = loadLedger(null);
  mergeFindings(l, [finding('a', 20)]);
  const res = mergeFindings(l, [{ ...finding('a', 26), sessionCount: 3 }]);
  assert.equal(res.added, 0);
  assert.equal(res.refreshed, 1);
  assert.equal(l.findings.length, 1);
  assert.equal(l.findings[0].score, 26);
  assert.equal(l.findings[0].sessionCount, 3);
});

test('oldestOpenDays distinguishes a stale backlog from a fresh one', () => {
  const l = loadLedger(null);
  const longAgo = new Date(Date.now() - 45 * 86400000);
  mergeFindings(l, [finding('old')], { now: longAgo });
  mergeFindings(l, [finding('new')], { now: new Date() });
  const sig = errorSignal(l);
  assert.equal(sig.backlog, 2);
  assert.ok(sig.oldestOpenDays >= 44, `expected ~45 days, got ${sig.oldestOpenDays}`);
});

test('nextToDraft picks the top undrafted finding and skips covered ground', () => {
  const l = loadLedger(null);
  mergeFindings(l, [finding('low', 21), finding('high', 30), finding('covered', 40)]);
  l.findings.find((f) => f.key === 'covered').alreadyCovered = { matched: 'covered' };
  assert.equal(nextToDraft(l).key, 'high');
  setStatus(l, 'high', 'drafted');
  assert.equal(nextToDraft(l).key, 'low');
  setStatus(l, 'low', 'drafted');
  assert.equal(nextToDraft(l), null, 'a covered finding must never be offered for drafting');
});

test('a malformed ledger is an error, never silently replaced', () => {
  const dir = tmp();
  const p = join(dir, 'findings.json');
  writeFileSync(p, '{ not json', 'utf8');
  assert.throws(() => loadLedger(p), /not valid JSON/);
  writeFileSync(p, '{"version":1}', 'utf8');
  assert.throws(() => loadLedger(p), /missing its "findings" array/);
  rmSync(dir, { recursive: true, force: true });
});

test('an empty ledger file reads as empty rather than throwing', () => {
  const dir = tmp();
  const p = join(dir, 'findings.json');
  writeFileSync(p, '   \n', 'utf8');
  assert.deepEqual(loadLedger(p).findings, []);
  rmSync(dir, { recursive: true, force: true });
});

test('a saved ledger round-trips, decisions intact', () => {
  const dir = tmp();
  const p = join(dir, 'findings.json');
  const l = loadLedger(null);
  mergeFindings(l, [finding('a'), finding('b')]);
  setStatus(l, 'b', 'declined');
  recordRun(l, { at: '2026-06-01T00:00:00.000Z', sessionsScanned: 10 });
  saveLedger(p, l);

  const back = loadLedger(p);
  assert.equal(back.findings.length, 2);
  assert.equal(back.findings.find((f) => f.key === 'b').status, 'declined');
  assert.equal(back.runs.length, 1);
  assert.equal(errorSignal(back).backlog, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('run records are capped so the ledger stays a decision record', () => {
  const l = loadLedger(null);
  for (let i = 0; i < 80; i++) recordRun(l, { at: `run-${i}` }, { keep: 60 });
  assert.equal(l.runs.length, 60);
  assert.equal(l.runs[0].at, 'run-20', 'the oldest runs should be dropped, not the newest');
});

test('setStatus rejects a status that is not part of the lifecycle', () => {
  const l = loadLedger(null);
  mergeFindings(l, [finding('a')]);
  assert.throws(() => setStatus(l, 'a', 'maybe'), /unknown finding status/);
});
