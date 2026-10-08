// Saved history (issue 151, second part): with "saveResults" on, view saves each day's history,
// and a later run gives the engine back each saved session whose log is gone, so it stays
// replayable and says it's saved. The engine's round trip is the promise under it: a week built
// with some or all of its sessions given back from saved results is the week built from the logs,
// but for what's labelled and one link a saved session can't make again. Everything runs on the
// made-up demo week in lib/demo/.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { buildDemoWeek, CODEX_IDS, SESSION_IDS } from '../lib/demo/week.mjs';
import { DEMO_TERM } from '../lib/view.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { createSaver } from '../lib/saved/saver.mjs';
import { DAYS_SUB, loadSaved, readHistoryDay } from '../lib/saved/history.mjs';
import { SAVED_DIR, savedDays } from '../lib/saved/store.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const d = buildDemoWeek();
after(() => rmSync(d.root, { recursive: true, force: true }));
const CONFIG = { ...d.config, redaction: { ...d.config.redaction, terms: [DEMO_TERM] }, saveResults: { on: true, keepDays: 36500 } };
const NOW = Date.parse('2025-03-17T12:00:00Z');
const OPTS = { config: CONFIG, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, scope: 'all', updates: true, hiddenSessions: 'redacted', usage: true, keepRaw: true, goals: d.goalRecord };

const fresh = await buildWorkHistory({ ...OPTS, saving: true });
const keyOfLog = (id) => [...fresh.claudeIds, ...fresh.codexIds].find(([, x]) => x === id.toLowerCase())?.[0];
const filesOf = (keys) => [...fresh.sourceFiles].filter(([src]) => keys.includes(fresh.sourceSession.get(src))).map(([, f]) => f);

/** Moves the logs of `keys` away while `fn` runs, then back. */
async function withoutLogs(keys, fn) {
  const files = filesOf(keys);
  for (const f of files) renameSync(f, `${f}.away`);
  try {
    return await fn();
  } finally {
    for (const f of files) renameSync(`${f}.away`, f);
  }
}
const exported = (keys) => keys.map((k) => ({ ...fresh.exportSession(k), savedAt: '2025-03-17T00:00:00.000Z', version: '0.2.0', log: 'gone' }));
const strip = ({ saved: _s, ...rest }) => rest;
const noGit = (list) => list.filter((e) => !String(e.source).startsWith('git-'));
const body = (list) => noGit(list).map(({ _raw, _command, _workdir, _lineCwd, ...e }) => e);
const sorted = (list) => [...list].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

test('a week given back whole from saved sessions is the week built from its logs', async () => {
  const keys = fresh.sessions.map((s) => s.key);
  const back = await withoutLogs(keys, () => buildWorkHistory({ ...OPTS, saved: exported(keys) }));
  assert.deepEqual(back.sessions.map(strip), fresh.sessions);
  assert.ok(back.sessions.every((s) => s.saved?.log === 'gone' && s.saved.by === '0.2.0' && s.saved.at === '2025-03-17T00:00:00.000Z'));
  assert.deepEqual(back.threads, fresh.threads);
  assert.deepEqual(body(back.events), body(fresh.events));
  assert.deepEqual(back.events.filter((e) => String(e.source).startsWith('git-')).map((e) => e.id), fresh.events.filter((e) => String(e.source).startsWith('git-')).map((e) => e.id), 'git outcomes are read again, live');
  assert.deepEqual(back.agents, fresh.agents);
  assert.deepEqual(sorted(back.links), sorted(fresh.links));
  assert.deepEqual(back.goals, fresh.goals);
  assert.deepEqual(back.usage.calls, fresh.usage.calls);
  assert.deepEqual([...back.turnsById.values()], [...fresh.turnsById.values()]);
  // A pull request and a commit still find the sessions behind them.
  for (const q of ['#12', `commit:${fresh.events.find((e) => e.refs?.[0]?.sha)?.refs[0].sha}`]) {
    assert.deepEqual(JSON.stringify(back.lookup(q)), JSON.stringify(fresh.lookup(q)), q);
  }
});

test('some sessions given back sit beside the rest as if read, but for a launch from a saved session', async () => {
  const keys = fresh.sessions.filter((_, i) => i % 3 === 0).map((s) => s.key);
  const back = await withoutLogs(keys, () => buildWorkHistory({ ...OPTS, saved: exported(keys) }));
  // A session a saved session launched can't be matched to the launch: the command's text isn't
  // saved. The launched session says nothing rather than something wrong.
  const lost = new Set(fresh.sessions.filter((s) => s.launchedBy && keys.includes(s.launchedBy.session) && !keys.includes(s.key)).map((s) => s.key));
  const unlaunched = (s) => (lost.has(s.key) ? (({ launchedBy: _l, ...rest }) => rest)(s) : s);
  assert.deepEqual(back.sessions.map(strip), fresh.sessions.map(unlaunched));
  assert.deepEqual(back.threads, fresh.threads);
  assert.deepEqual(body(back.events), body(fresh.events));
  assert.deepEqual(back.agents, fresh.agents);
  assert.deepEqual(sorted(back.links.filter((l) => l.type !== 'program-launch' || !lost.has(l.to))), sorted(fresh.links.filter((l) => l.type !== 'program-launch' || !lost.has(l.to))));
  assert.deepEqual(back.goals, fresh.goals);
  assert.equal(back.sessions.filter((s) => s.saved).length, keys.length);
});

test('a saved session read from its log again is the log, and without saved sessions nothing changes', async () => {
  const keys = fresh.sessions.map((s) => s.key);
  const both = await buildWorkHistory({ ...OPTS, saved: exported(keys) });
  assert.deepEqual(both.sessions, fresh.sessions, 'every log is on disk: none comes back as saved');
  const plain = await buildWorkHistory(OPTS);
  assert.deepEqual(JSON.stringify(plain), JSON.stringify(await buildWorkHistory({ ...OPTS, saved: [] })));
  assert.equal('exportSession' in plain, false);
  assert.equal(Object.keys(fresh).includes('exportSession'), false, 'not enumerable');
});

test('a saved step says its log is gone instead of checking a line it can no longer read', async () => {
  const key = keyOfLog(SESSION_IDS.windowsCi);
  const back = await withoutLogs([key], () => buildWorkHistory({ ...OPTS, saved: exported([key]) }));
  const e = back.events.find((x) => x.session === key && x.refs.length);
  const r = back.record(e.id);
  assert.ok(r.length);
  for (const x of r) {
    assert.equal(x.verified, null);
    assert.equal(x.record, null);
    assert.match(x.note, /^saved from a log that's no longer on disk/);
    assert.equal(x.saved, true);
  }
});

/** A config folder with the demo week saved through view's saver, as view saves it. */
async function savedWeek(config = CONFIG) {
  const dir = makeTempDir('hw-saved-history-');
  const saver = createSaver({ configDir: () => dir, config: () => config, now: () => NOW });
  const data = createViewData({ config, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, onChecked: saver.onChecked, savedLoad: (w) => saver.load({ ...w, roots: d.roots }), now: () => NOW });
  await data.start();
  for (let i = 0; i < 100 && !existsSync(join(dir, SAVED_DIR, DAYS_SUB, `${d.week.to}.json.gz`)); i++) await new Promise((r) => setTimeout(r, 20));
  data.stop();
  return { dir, saved: join(dir, SAVED_DIR), saver };
}
const viewOf = (saver, config = CONFIG) => createViewData({ config, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, onChecked: saver.onChecked, savedLoad: (w) => saver.load({ ...w, roots: d.roots }), now: () => NOW });

test('each day is saved gzipped, owner-only, with no raw id, path or private word', async () => {
  const { saved } = await savedWeek();
  assert.deepEqual(savedDays(saved, DAYS_SUB), ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15', '2025-03-16']);
  const text = readdirSync(join(saved, DAYS_SUB)).map((f) => gunzipSync(readFileSync(join(saved, DAYS_SUB, f))).toString('utf8')).join('\n');
  if (process.platform !== 'win32') for (const f of readdirSync(join(saved, DAYS_SUB))) assert.equal(statSync(join(saved, DAYS_SUB, f)).mode & 0o777, 0o600, f);
  for (const id of [...Object.values(SESSION_IDS), ...Object.values(CODEX_IDS)]) assert.equal(text.toLowerCase().includes(String(id).toLowerCase()), false, `raw id ${id}`);
  assert.equal(text.toLowerCase().includes(DEMO_TERM), false, 'the private word');
  for (const form of [d.root, d.root.replace(/\\/g, '/'), JSON.stringify(d.root).slice(1, -1)]) assert.equal(text.includes(form), false, 'a log path');
  for (const k of ['"_raw"', '"_command"', '"_workdir"', '"_lineCwd"']) assert.equal(text.includes(k), false, k);
  const day = readHistoryDay(saved, '2025-03-13');
  assert.ok(day.sessions.length > 0);
  assert.ok(day.sessions.every((x) => x.savedAt === new Date(NOW).toISOString() && typeof x.version === 'string'));
});

test('with history off only check results are saved, and nothing comes back', async () => {
  const config = { ...CONFIG, saveResults: { on: true, keepDays: 36500, history: false } };
  const { saved, saver } = await savedWeek(config);
  assert.ok(existsSync(join(saved, 'checks')));
  assert.equal(existsSync(join(saved, DAYS_SUB)), false);
  assert.equal(saver.load({ from: d.week.from, to: d.week.to, timezone: d.week.timezone, roots: d.roots }), null);
});

test('a session whose log is gone stays on the page: listed, replayable, its findings as saved, and labelled', async () => {
  const { saver } = await savedWeek();
  const key = keyOfLog(SESSION_IDS.windowsCi);
  await withoutLogs([key], async () => {
    const loaded = saver.load({ from: d.week.from, to: d.week.to, timezone: d.week.timezone, roots: d.roots });
    assert.deepEqual(loaded.sessions.map((x) => x.key), [key], 'only the session whose log is gone comes back');
    const data = viewOf(saver);
    await data.start();
    const ask = async (path, params = {}) => (await data.route(path, new URLSearchParams(params))).body;
    const list = await ask('/api/sessions');
    const row = list.days.flatMap((x) => x.rows).find((r) => r.session === key);
    assert.deepEqual(row.saved, { at: new Date(NOW).toISOString(), by: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, log: 'gone' });
    const replay = await ask('/api/replay', { session: key });
    assert.ok(replay.events.length > 0);
    assert.equal(replay.sessions.find((s) => s.key === key).saved.log, 'gone');
    const rec = await ask('/api/record', { event: replay.events.find((e) => e.session === key).id });
    assert.ok(rec.records.every((r) => r.verified === null && r.saved === true && /no longer on disk/.test(r.note)));
    const p = await ask('/api/problems', { session: key });
    assert.equal(p.focus.saved.log, 'gone');
    assert.equal(p.focus.findings, 2, 'the two findings the checks saved for it');
    // Another session, read from its log, isn't labelled.
    const other = list.days.flatMap((x) => x.rows).find((r) => r.session !== key);
    assert.equal('saved' in other, false);
    data.stop();
  });
});

test('Show private text shows a saved session redacted, since private text is never saved', async () => {
  const { saver } = await savedWeek();
  const key = keyOfLog(SESSION_IDS.sinceFlag);
  await withoutLogs([key], async () => {
    const data = viewOf(saver);
    await data.start();
    await data.start('private');
    const priv = (await data.route('/api/replay', new URLSearchParams({ session: key, private: '1' }))).body;
    assert.equal(priv.view.shown, 'private');
    const s = priv.sessions.find((x) => x.key === key);
    assert.equal(s.saved.log, 'gone');
    assert.match(JSON.stringify(priv.events.filter((e) => e.session === key)), /\[redacted:term\]/, 'the private word stays hidden in a saved session');
    data.stop();
  });
});

test('a word added to the private words later is hidden in saved history too', async () => {
  const { saver } = await savedWeek();
  const key = keyOfLog(SESSION_IDS.windowsCi);
  const title = fresh.sessions.find((s) => s.key === key).title;
  const word = title.split(/\s+/).find((w) => /^[A-Za-z]{5,}$/.test(w));
  const config = { ...CONFIG, redaction: { ...CONFIG.redaction, terms: [...CONFIG.redaction.terms, word] } };
  await withoutLogs([key], async () => {
    const data = viewOf(saver, config);
    await data.start();
    const replay = (await data.route('/api/replay', new URLSearchParams({ session: key }))).body;
    assert.equal(JSON.stringify(replay).includes(word), false, word);
    data.stop();
  });
});

test('a later run keeps a saved day it reads again, and a session whose log is gone in it', async () => {
  const { saved, saver } = await savedWeek();
  const key = keyOfLog(SESSION_IDS.windowsCi);
  const day = '2025-03-13';
  await withoutLogs([key], async () => {
    const data = viewOf(saver);
    await data.start();
    for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 10));
    data.stop();
  });
  const f = readHistoryDay(saved, day);
  const kept = f.sessions.find((x) => x.key === key);
  assert.ok(kept, 'the gone session is still saved');
  assert.equal(kept.savedAt, new Date(NOW).toISOString());
  assert.deepEqual(loadSaved({ dir: saved, from: d.week.from, to: d.week.to, timezone: d.week.timezone, roots: d.roots }).sessions, [], 'every log is back on disk: nothing comes back as saved');
});
