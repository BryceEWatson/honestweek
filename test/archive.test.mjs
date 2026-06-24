// The opt-in local weekly archive: build snapshots each week + upserts a local
// index. Local file writes only — never pushed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeArchive } from '../lib/archive.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { runBuild } from '../lib/build.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'hw-archive-'));
}
function readIndex(dir, sub = 'honestweek.archive') {
  return JSON.parse(readFileSync(join(dir, sub, 'index.json'), 'utf8'));
}

test('writeArchive writes a per-week snapshot and an index entry', () => {
  const dir = tmp();
  try {
    const model = { week: { start: '2024-06-10', end: '2024-06-16' }, groups: [{ label: 'app', items: [{}, {}] }], items: [] };
    const res = writeArchive({ cwd: dir, dir: 'honestweek.archive', week: model.week, mode: 'report', model, nowISO: '2024-06-17T00:00:00.000Z' });
    assert.ok(existsSync(join(dir, 'honestweek.archive', '2024-06-10.json')));
    assert.equal(res.weeks, 1);
    const idx = readIndex(dir);
    assert.equal(idx.weeks[0].week.start, '2024-06-10');
    assert.equal(idx.weeks[0].items, 2);
    assert.equal(idx.weeks[0].mode, 'report');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeArchive upserts the same week and sorts newest-first', () => {
  const dir = tmp();
  try {
    const mk = (start, end, n) => ({ week: { start, end }, groups: [{ label: 'a', items: Array(n).fill({}) }], items: [] });
    writeArchive({ cwd: dir, dir: 'honestweek.archive', week: mk('2024-06-03', '2024-06-09', 1).week, mode: 'digest', model: mk('2024-06-03', '2024-06-09', 1), nowISO: 'x' });
    writeArchive({ cwd: dir, dir: 'honestweek.archive', week: mk('2024-06-10', '2024-06-16', 3).week, mode: 'digest', model: mk('2024-06-10', '2024-06-16', 3), nowISO: 'x' });
    // re-run the older week with a NEW count -> upsert, not duplicate
    const res = writeArchive({ cwd: dir, dir: 'honestweek.archive', week: mk('2024-06-03', '2024-06-09', 5).week, mode: 'digest', model: mk('2024-06-03', '2024-06-09', 5), nowISO: 'x' });
    const idx = readIndex(dir);
    assert.equal(res.weeks, 2, 'two distinct weeks, not three');
    assert.deepEqual(idx.weeks.map((w) => w.week.start), ['2024-06-10', '2024-06-03'], 'newest first');
    assert.equal(idx.weeks[1].items, 5, 'the re-run updated the older week');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: archive is off by default with a default dir, and validates overrides', () => {
  const base = { identity: { authorEmails: ['me@example.com'] }, repos: [{ label: 'a', path: '.', role: 'featured' }] };
  const off = normalizeConfig(base);
  assert.equal(off.output.archive, false);
  assert.equal(off.output.archiveDir, 'honestweek.archive');

  const on = normalizeConfig({ ...base, output: { archive: true, archiveDir: 'weeks' } });
  assert.equal(on.output.archive, true);
  assert.equal(on.output.archiveDir, 'weeks');

  assert.throws(() => normalizeConfig({ ...base, output: { archiveDir: '' } }), /archiveDir/);
});

// --- build end-to-end with archive enabled ---

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('build writes a snapshot + index when output.archive is enabled', async () => {
  const dir = tmp();
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'me@example.com']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'a.txt'), 'x');
    git(dir, ['add', '-A']);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'D', GIT_AUTHOR_EMAIL: 'me@example.com', GIT_COMMITTER_NAME: 'D', GIT_COMMITTER_EMAIL: 'me@example.com', GIT_AUTHOR_DATE: '2024-06-12T10:00:00Z', GIT_COMMITTER_DATE: '2024-06-12T10:00:00Z' };
    git(dir, ['commit', '-q', '-m', 'ship it'], env);
    const sha = git(dir, ['rev-parse', 'HEAD']).trim();

    writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({
      identity: { authorEmails: ['me@example.com'] },
      repos: [{ label: 'self', path: '.', role: 'featured' }],
      output: { mode: 'report', archive: true },
    }));
    writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [{ status: 'shipped', text: 'Shipped it', repo: 'self', receipt: { primaryCommit: sha } }],
    }));

    const out = [];
    const code = await runBuild({ cwd: dir, now: new Date('2024-06-17T12:00:00Z'), io: { out: (s) => out.push(s), err: (s) => out.push(s), exit: (c) => c } });
    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, 'honestweek.archive', '2024-06-10.json')), 'snapshot written');
    assert.equal(readIndex(dir).weeks[0].week.start, '2024-06-10');
    assert.match(out.join(''), /Archived/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
