// The session hero deriver: it counts INTERACTIVE sessions per day, excludes
// automated/agent/system turns, dedupes a resumed session, windows by the first
// prompt's local date, and labels itself session-derived. Counts must match the
// way a target site counts (a different rule -> a different hero number), so this
// pins the classification + dedup + windowing on SYNTHETIC session logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveSessions, isInteractiveFirstPrompt } from '../lib/site/sessions.mjs';

const WEEK_START = new Date('2024-06-10T00:00:00.000Z'); // Monday
const WEEK_END = new Date('2024-06-16T23:59:59.999Z'); // Sunday
const NOW = new Date('2024-06-19T12:00:00Z');

function config() {
  return {
    week: { timezone: 'UTC' },
    repos: [
      { label: 'alpha', path: '/work/alpha', resolvedPath: '/work/alpha', role: 'featured' },
      { label: 'beta', path: '/work/beta', resolvedPath: '/work/beta', role: 'reference' },
    ],
  };
}

/** Write a one-line session log whose first user record carries cwd + timestamp. */
function session(dir, name, { cwd, ts, content }) {
  const rec = { type: 'user', timestamp: ts, cwd, sessionId: name, message: { role: 'user', content } };
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, JSON.stringify(rec) + '\n');
  return file;
}

function buildFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'hw-sessions-'));
  const d = join(root, 'proj');
  mkdirSync(d);
  // 1+2: interactive, same day (Wed 06-12), two different project labels.
  session(d, 's1', { cwd: '/work/alpha', ts: '2024-06-12T09:00:00Z', content: 'Help me build the thing.' });
  session(d, 's2', { cwd: '/work/beta', ts: '2024-06-12T14:00:00Z', content: 'Fix the bug please.' });
  // 3: interactive, Thu 06-13, an unconfigured cwd -> label "other".
  session(d, 's3', { cwd: '/work/gamma', ts: '2024-06-13T10:00:00Z', content: 'Do some unrelated work.' });
  // 4-6: automated / agent / system wrapper -> excluded.
  session(d, 's4', { cwd: '/work/alpha', ts: '2024-06-12T08:00:00Z', content: 'Project: status check for the operator' });
  session(d, 's5', { cwd: '/work/alpha', ts: '2024-06-12T08:05:00Z', content: 'You are a helpful coding agent.' });
  session(d, 's6', { cwd: '/work/alpha', ts: '2024-06-12T08:10:00Z', content: '<command-name>weekly</command-name>' });
  // 7: a RESUME of s1 (same first-prompt timestamp, new file) -> deduped.
  session(d, 's7', { cwd: '/work/alpha', ts: '2024-06-12T09:00:00Z', content: 'Help me build the thing.' });
  // 8: interactive but OUT of the week window -> not counted.
  session(d, 's8', { cwd: '/work/alpha', ts: '2024-06-01T10:00:00Z', content: 'Old work from a prior week.' });
  return root;
}

test('isInteractiveFirstPrompt: real prompts pass; automated/agent/system turns fail', () => {
  assert.equal(isInteractiveFirstPrompt('Help me build the thing.'), true);
  assert.equal(isInteractiveFirstPrompt('<system-reminder>ctx</system-reminder>\nNow do real work.'), true);
  assert.equal(isInteractiveFirstPrompt('Project: status'), false);
  assert.equal(isInteractiveFirstPrompt('Project state: idle'), false);
  assert.equal(isInteractiveFirstPrompt('You are an agent.'), false);
  assert.equal(isInteractiveFirstPrompt('<command-name>x</command-name>'), false);
  assert.equal(isInteractiveFirstPrompt('<task-notification>done</task-notification>'), false);
  assert.equal(isInteractiveFirstPrompt(''), false);
  assert.equal(isInteractiveFirstPrompt('   '), false);
});

test('deriveSessions counts interactive sessions/day, dedupes resumes, windows, labels', () => {
  const root = buildFixtures();
  try {
    const s = deriveSessions({ config: config(), weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW, projectsRoot: root });

    assert.equal(s.metric, 'interactive-sessions');
    assert.equal(s.provenance, 'session-derived', 'labeled NOT git-commit-verified');
    assert.equal(s.total, 3, 's1, s2, s3 are the interactive in-window sessions');
    assert.equal(s.interactiveTotal, 3);
    assert.equal(s.automatedExcluded, 3, 's4/s5/s6 are automated/agent/system');
    assert.equal(s.duplicatesSkipped, 1, 's7 resumes s1');
    assert.equal(s.filesScanned, 8);
    assert.equal(s.filesFound, 8, 'all 8 logs enumerated under the root');
    assert.equal(s.undetermined, 0);

    assert.equal(s.days.length, 7);
    const byDate = Object.fromEntries(s.days.map((d) => [d.date, d]));
    assert.equal(byDate['2024-06-12'].total, 2);
    assert.deepEqual(byDate['2024-06-12'].byProject, { alpha: 1, beta: 1 });
    assert.equal(byDate['2024-06-12'].weekday, 'wed');
    assert.equal(byDate['2024-06-13'].total, 1);
    assert.deepEqual(byDate['2024-06-13'].byProject, { other: 1 });
    assert.equal(byDate['2024-06-10'].total, 0, 'a quiet day renders as zero');
    assert.equal(s.max, 2);
    assert.deepEqual(s.projectTotals, { alpha: 1, beta: 1, other: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deriveSessions: an mtime older than the week is pre-filtered out (never read)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hw-sessions-old-'));
  try {
    const d = join(root, 'proj');
    mkdirSync(d);
    const f = session(d, 'old', { cwd: '/work/alpha', ts: '2024-06-12T09:00:00Z', content: 'Real work.' });
    // Stamp the file's mtime well before the week — the coarse pre-filter drops it.
    const ancient = new Date('2024-01-01T00:00:00Z');
    utimesSync(f, ancient, ancient);
    const s = deriveSessions({ config: config(), weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW, projectsRoot: root });
    assert.equal(s.filesScanned, 0, 'an ancient file is never opened');
    assert.equal(s.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a subdir-cwd session attributes to "other", not the parent repo (exact attribution)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hw-sessions-sub-'));
  try {
    const d = join(root, 'proj');
    mkdirSync(d);
    // cwd is a SUBDIRECTORY of the configured repo — the project is ambiguous, so
    // the hero attributes it to "other" rather than over-crediting alpha.
    session(d, 'sub', { cwd: '/work/alpha/packages/x', ts: '2024-06-12T09:00:00Z', content: 'Work in a subdir.' });
    session(d, 'root', { cwd: '/work/alpha', ts: '2024-06-12T10:00:00Z', content: 'Work at the repo root.' });
    const s = deriveSessions({ config: config(), weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW, projectsRoot: root });
    assert.equal(s.total, 2);
    assert.deepEqual(s.days.find((x) => x.date === '2024-06-12').byProject, { alpha: 1, other: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session whose encoded project-dir is an ephemeral temp location is excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'hw-sessions-eph-'));
  try {
    // The encoded project-dir name embeds a temp cwd (capability/tooling probe).
    const d = join(root, 'C--Users-Dev-AppData-Local-Temp-probe123');
    mkdirSync(d);
    session(d, 'probe', { cwd: 'C:/Users/Dev/AppData/Local/Temp/probe123', ts: '2024-06-12T09:00:00Z', content: 'A real-looking prompt in a probe session.' });
    const s = deriveSessions({ config: config(), weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW, projectsRoot: root });
    assert.equal(s.filesScanned, 0, 'an ephemeral temp-dir session is never scanned');
    assert.equal(s.filesFound, 1, 'filesFound counts the enumerated log (pre-ephemeral-filter), so an all-ephemeral root does NOT trip the no-logs warning');
    assert.equal(s.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deriveSessions on an absent projects root yields a clean empty hero', () => {
  const s = deriveSessions({ config: config(), weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW, projectsRoot: join(tmpdir(), 'hw-no-such-root-zzz') });
  assert.equal(s.total, 0);
  assert.equal(s.max, 0);
  assert.equal(s.filesFound, 0, 'an absent root yields zero logs found — the build-warning trigger');
  assert.equal(s.days.length, 7);
  assert.equal(s.provenance, 'session-derived');
});
