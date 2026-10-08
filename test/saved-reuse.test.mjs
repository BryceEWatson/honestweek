// Reading only what changed (issue 151, third part): with saved results on, a run takes back each
// saved session whose logs haven't changed since it was saved, unread, and reads only the rest.
// What the page answers is what reading every log would answer. A grown or new log, a new
// honestweek version, other private words, or a session that ended within a day is read again.
// Everything runs on the made-up demo week in lib/demo/.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { buildDemoWeek, SESSION_IDS } from '../lib/demo/week.mjs';
import { DEMO_TERM } from '../lib/view.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { createSaver } from '../lib/saved/saver.mjs';
import { DAYS_SUB, loadSaved, RECENT_MS } from '../lib/saved/history.mjs';
import { SAVED_DIR } from '../lib/saved/store.mjs';
import { pathKey } from '../lib/replay/ids.mjs';
import { fileFingerprint } from '../lib/replay/saved-sessions.mjs';
import { countsFromSaved } from '../lib/saved/checks.mjs';
import { runProblems, trendCounts } from '../lib/problems/index.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const CONFIG_OF = (d) => ({ ...d.config, redaction: { ...d.config.redaction, terms: [DEMO_TERM] }, saveResults: { on: true, keepDays: 36500 } });
const NOW = Date.parse('2025-03-20T12:00:00Z');

/** A fresh demo week (its own folder, since tests here change its logs), saved through view. */
async function savedWeek() {
  const d = buildDemoWeek();
  after(() => rmSync(d.root, { recursive: true, force: true }));
  const config = CONFIG_OF(d);
  const dir = makeTempDir('hw-saved-reuse-');
  const saver = createSaver({ configDir: () => dir, config: () => config, now: () => NOW });
  const view = (more = {}) => createViewData({ config, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, onChecked: saver.onChecked, savedLoad: (w) => saver.load({ ...w, roots: d.roots }), now: () => NOW, ...more });
  const first = view();
  await first.start();
  for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  first.stop();
  const load = (more = {}) => loadSaved({ dir: join(dir, SAVED_DIR), from: d.week.from, to: d.week.to, timezone: d.week.timezone, roots: d.roots, config, now: NOW, ...more });
  return { d, config, dir, saver, view, load };
}

/** Every answer a page reads for the week, as JSON, to compare two builds by. */
async function answers(data) {
  await data.start();
  const ask = async (path, params = {}) => (await data.route(path, new URLSearchParams(params))).body;
  const out = {};
  const strip = (o) => {
    const { view: _v, ...rest } = o ?? {};
    return rest;
  };
  out.home = strip(await ask('/api/home'));
  out.sessions = strip(await ask('/api/sessions'));
  // What each check says it read counts only the sessions read this run, and says so; the rest of
  // the answer is compared whole.
  const p = strip(await ask('/api/problems'));
  const { checks: _c, coverage: { rawText: _r, saved: _s, ...coverage } = {}, ...rest } = p;
  out.problems = { ...rest, coverage };
  out.savedCount = p.coverage?.saved ?? null;
  const rows = out.sessions.days.flatMap((x) => x.rows);
  out.replays = {};
  for (const r of rows) out.replays[r.session] = strip(await ask('/api/replay', { session: r.session }));
  // A typed query's id is made up fresh each run.
  const { queryId: _q, ...lookup } = strip(await ask('/api/lookup', { q: '#12' }));
  out.lookup = lookup;
  data.stop();
  return out;
}

test('a run after a save reads no log that did not change, and answers as if it read every one', async () => {
  const w = await savedWeek();
  const loaded = w.load();
  const fresh = await buildWorkHistory({ config: w.config, roots: w.d.roots, from: w.d.week.from, to: w.d.week.to, timezone: w.d.week.timezone, scope: 'all', updates: true, hiddenSessions: 'redacted', usage: true, keepRaw: true, goals: w.d.goalRecord });
  // Only configured repositories' history is saved (no otherSessions), so the rest are read.
  const others = fresh.sessions.filter((s) => s.private);
  assert.ok(others.length > 0);
  assert.equal(loaded.reuse.size, fresh.sessions.length - others.length, 'every configured session is unchanged and comes back unread');
  assert.equal(loaded.sessions.every((x) => x.log === 'on-disk'), true);
  let progress = null;
  const reused = await answers(w.view({ onProgress: (p) => (progress = p) }));
  const otherFiles = [...fresh.sourceFiles].filter(([src]) => others.some((s) => s.key === fresh.sourceSession.get(src))).length;
  assert.deepEqual(progress, { read: otherFiles, total: otherFiles }, "only the display-only and outside sessions' logs were read");
  const plain = await answers(createViewData({ config: { ...w.config, saveResults: undefined }, roots: w.d.roots, from: w.d.week.from, to: w.d.week.to, timezone: w.d.week.timezone, goalRecord: w.d.goalRecord, now: () => NOW }));
  // Compared as text, part by part: a difference names its part without printing every answer.
  assert.deepEqual(reused.savedCount, { value: plain.problems.coverage.sessions.value, evidence: 'derived' }, 'every session checked came back from saved results');
  assert.equal(plain.savedCount, null);
  for (const k of Object.keys(plain).filter((x) => x !== 'savedCount')) {
    const a = JSON.stringify(reused[k]);
    const b = JSON.stringify(plain[k]);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i += 1;
    assert.ok(a === b, `${k} differs at ${i}: ${a.slice(Math.max(0, i - 150), i + 150)} | ${b.slice(Math.max(0, i - 150), i + 150)}`);
  }
});

test('a step of a session taken back unread is still checked against its log line', async () => {
  const w = await savedWeek();
  const loaded = w.load();
  const h = await buildWorkHistory({ config: w.config, roots: w.d.roots, from: w.d.week.from, to: w.d.week.to, timezone: w.d.week.timezone, scope: 'all', updates: true, hiddenSessions: 'redacted', usage: true, saved: loaded.sessions, reuse: loaded.reuse });
  const e = h.events.find((x) => x.refs?.length && !x.refs[0].sha);
  assert.ok(h.record(e.id).every((r) => r.verified === true), 'the bytes at its place still match its fingerprint');
  assert.equal(h.sessions.some((s) => s.saved), false, 'a session whose log is on disk carries no saved label');
});

test('a grown log, a replaced one, other private words, a new version or a session that just ended is read again', async () => {
  const w = await savedWeek();
  const all = w.load().reuse.size;
  // Grown: one line added to one session's log.
  const claudeRoot = w.d.roots.claude[0];
  const walk = (dir, hit = []) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, hit);
      else if (name === `${SESSION_IDS.windowsCi}.jsonl`) hit.push(p);
    }
    return hit;
  };
  const [log] = walk(claudeRoot);
  assert.ok(log);
  const before = readFileSync(log);
  appendFileSync(log, '\n');
  assert.equal(w.load().reuse.size, all - 1, 'the grown session is read again');
  // Written again with the same bytes: its last change moved, so it's read again.
  writeFileSync(log, before);
  assert.equal(w.load().reuse.size, all - 1, 'a log written again is read again');
  // Replaced by another of the same size and time (the saved fingerprint is moved to the file's new
  // size and time, as if they matched): its first bytes differ, so it's still read again.
  const swapped = Buffer.from(before);
  swapped[1] = swapped[1] === 0x41 ? 0x42 : 0x41;
  writeFileSync(log, swapped);
  const now = statSync(log);
  const key = pathKey(log);
  const daysDir = join(w.dir, SAVED_DIR, DAYS_SUB);
  const editSaved = (fn) => {
    for (const name of readdirSync(daysDir)) {
      const p = join(daysDir, name);
      const v = JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
      for (const x of v.sessions) fn(x);
      writeFileSync(p, gzipSync(Buffer.from(JSON.stringify(v))));
    }
  };
  editSaved((x) => {
    for (const s of x.sources) if (s.file === key) Object.assign(s, { size: now.size, mtimeMs: now.mtimeMs });
  });
  assert.equal(w.load().reuse.size, all - 1, 'the replaced log is read again');
  editSaved((x) => {
    for (const s of x.sources) if (s.file === key) s.head = fileFingerprint(log).head;
  });
  assert.equal(w.load().reuse.size, all, 'with all three the same, it is taken back unread');
  // Other private words.
  assert.equal(w.load({ config: { ...w.config, redaction: { ...w.config.redaction, terms: [DEMO_TERM, 'changelog'] } } }).reuse.size, 0);
  // A session that ended within a day of now.
  const last = Math.max(...w.load().sessions.map((x) => Date.parse(x.record.lastAt)));
  assert.ok(w.load({ now: last + RECENT_MS - 1000 }).reuse.size < all);
  // Saved by another version: a day whose logs are on disk is read again; one whose log is gone
  // keeps the version that saved it.
  editSaved((x) => {
    x.version = '0.0.1';
  });
  assert.equal(w.load().reuse.size, 0, 'nothing saved by another version is taken back unread');
  renameSync(log, `${log}.away`);
  try {
    const gone = w.load().sessions.filter((x) => x.log === 'gone');
    assert.equal(gone.length, 1);
    assert.equal(gone[0].version, '0.0.1', 'a session whose log is gone keeps the version that saved it');
  } finally {
    renameSync(`${log}.away`, log);
  }
});

test('a session with a log file its saved copy does not name is read again', async () => {
  const w = await savedWeek();
  const loaded = w.load();
  const x = loaded.sessions.find((s) => s.sources.length > 1);
  assert.ok(x, 'the demo week has a session with a sub-agent');
  // Its saved copy forgets one of its sources: as if that file came later.
  const trimmed = loaded.sessions.map((s) => (s.key === x.key ? { ...s, sources: s.sources.slice(0, 1) } : s));
  const h = await buildWorkHistory({ config: w.config, roots: w.d.roots, from: w.d.week.from, to: w.d.week.to, timezone: w.d.week.timezone, scope: 'all', updates: true, hiddenSessions: 'redacted', usage: true, saved: trimmed, reuse: loaded.reuse, saving: true });
  assert.ok(h.exportSession(x.key), 'it was read from its logs, so it can be saved again');
  assert.equal(h.exportSession(loaded.sessions.find((s) => s.key !== x.key).key), null, 'one taken back unread is kept as it was saved');
});


test('the trend counts a saved window as reading its logs would, and reads it when it can not', async () => {
  const w = await savedWeek();
  const saved = join(w.dir, SAVED_DIR);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const args = { dir: saved, from: w.d.week.from, to: w.d.week.to, timezone: w.d.week.timezone, roots: w.d.roots, version };
  const h = await buildWorkHistory({ config: w.config, roots: w.d.roots, from: w.d.week.from, to: w.d.week.to, timezone: w.d.week.timezone, scope: 'all', updates: true, hiddenSessions: 'redacted', usage: true, keepRaw: true });
  const rr = runProblems(h, { builtT: NOW, longSessionTokens: w.config.longSessionTokens ?? null });
  assert.deepEqual(countsFromSaved(args), trendCounts(rr));
  assert.equal(countsFromSaved({ ...args, from: '2025-03-09' }), null, 'a day never saved: read the logs');
  assert.equal(countsFromSaved({ ...args, version: '9.9.9' }), null, 'saved by another version with its logs on disk: read them');
  // With every log gone, another version's counts stand.
  const files = readdirSync(w.d.roots.claude[0], { recursive: true }).filter((f) => f.endsWith('.jsonl')).map((f) => join(w.d.roots.claude[0], f));
  const codex = readdirSync(w.d.roots.codex[0], { recursive: true }).filter((f) => f.endsWith('.jsonl')).map((f) => join(w.d.roots.codex[0], f));
  for (const f of [...files, ...codex]) renameSync(f, `${f}.away`);
  try {
    assert.deepEqual(countsFromSaved({ ...args, version: '9.9.9' }), countsFromSaved(args));
  } finally {
    for (const f of [...files, ...codex]) renameSync(`${f}.away`, f);
  }
});
