// The whole week, loaded newest day first (lib/view/progressive.mjs): while the rest loads, every
// answer says it covers only the days in so far, the trend waits, and once every day is in the
// answers are the whole window's. Also what keeps a large window from running out of memory, the
// trend's "not loaded" notes, and the labels for sessions with no title.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { createViewData, partialState, PRIVATE_WORDS_SHORT } from '../lib/view/data.mjs';
import { createProgressiveData, fitWindow, REST_GAP_MS } from '../lib/view/progressive.mjs';
import { trendOf } from '../lib/problems/index.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { SESSION_IDS } from '../lib/demo/week.mjs';
import { buildViewWeek, SECRETS, TERM, WEEK } from './fixtures/view/week.mjs';

const scratch = makeTempDir('hw-view-full-week-');
after(() => removeTempDir(scratch));

const w = buildViewWeek(join(scratch, 'week'));
const params = (q = {}) => new URLSearchParams(q);
const MB = 1024 * 1024;

// Two sessions with no title on the week's last day: one started by `claude -p` (its records say
// "sdk-cli"), one typed at a terminal. Their first prompts hold a private word and a secret.
const HEADLESS_ID = '12121212-3434-4565-8787-909090909090';
const UNTITLED_ID = '23232323-4545-4676-8989-010101010101';
const lanternDir = w.d.ids.projectDirs.lantern;
const lanternCwd = JSON.parse(readFileSync(join(w.roots.claude[0], lanternDir, `${SESSION_IDS.sinceFlag}.jsonl`), 'utf8').split('\n').find((l) => l.includes('"cwd"'))).cwd;
function writeSession(id, entrypoint, prompt) {
  const at = (mm) => `${WEEK.to}T09:${String(mm).padStart(2, '0')}:00.000Z`;
  const base = (type, ts, extra) => ({ parentUuid: null, isSidechain: false, userType: 'external', entrypoint, cwd: lanternCwd, sessionId: id, version: '2.1.0', type, uuid: `${id.slice(0, 8)}-0000-4000-8000-00000000000${type === 'user' ? 1 : 2}`, timestamp: ts, ...extra });
  const lines = [
    base('user', at(5), { message: { role: 'user', content: prompt }, origin: { kind: 'human' } }),
    base('assistant', at(6), { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'model-a', content: [{ type: 'text', text: 'Done.' }] } }),
  ];
  writeFileSync(join(w.roots.claude[0], lanternDir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
writeSession(HEADLESS_ID, 'sdk-cli', `Review the ${TERM} pull request with token ${SECRETS.github} and report back on every failing check`);
writeSession(UNTITLED_ID, 'cli', 'Tidy the release notes');
const KEYS = { headless: claudeSessionKey(lanternDir, HEADLESS_ID), untitled: claudeSessionKey(lanternDir, UNTITLED_ID) };

/** A buildHistory that holds every build over more than one day until `release()`. */
function gated({ failWhole = false } = {}) {
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const build = async (o) => {
    calls.push({ from: o.from, to: o.to, onProgress: typeof o.onProgress === 'function' });
    if (o.from !== o.to) {
      await gate;
      if (failWhole) throw new Error('replay: the disk went away');
    }
    return buildWorkHistory(o);
  };
  return { build, release: () => release(), calls };
}

const waitFor = async (f, what) => {
  for (let i = 0; i < 2000; i++) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const progressive = (g, more = {}) =>
  createProgressiveData({ from: WEEK.from, to: WEEK.to, timezone: 'UTC', roots: w.roots, room: () => 64 * 1024 * MB, files: [], gapMs: 5, make: (o) => createViewData({ config: w.config, roots: w.roots, timezone: 'UTC', goalRecord: w.goalRecord, buildHistory: g.build, ...o }), ...more });

test('once the first day is in, the server stays free a moment before the rest starts, so a page hears first', async () => {
  assert.ok(REST_GAP_MS > 1000, 'longer than a page waits between its questions');
  const g = gated();
  const data = progressive(g, { gapMs: 200 });
  const t0 = Date.now();
  data.start();
  await waitFor(() => data.status().state === 'ready', 'the first day');
  // During the gap: the page's answer is the first day, and the rest hasn't begun.
  assert.equal(g.calls.length, 1);
  const st = data.status();
  assert.deepEqual([st.window.partial.elapsedMs, st.window.partial.rest.from], [null, WEEK.from]);
  await waitFor(() => g.calls.length === 2, 'the rest to start');
  assert.ok(Date.now() - t0 >= 200, 'not before the gap');
  g.release();
  await data.whenWhole();
  assert.equal(data.loaded(), 'whole');
  data.stop();
});

test('stopped during the gap, the rest never starts', async () => {
  const g = gated();
  const data = progressive(g, { gapMs: 50 });
  data.start();
  await waitFor(() => data.status().state === 'ready', 'the first day');
  data.stop();
  await data.whenWhole();
  assert.equal(g.calls.length, 1);
});

test('a week loads its newest day first: until every day is in, every count, trend and "nothing" says so; then the answers are the whole week', async () => {
  const g = gated();
  const data = progressive(g);
  data.start();
  await waitFor(() => data.status().state === 'ready', 'the first day');
  assert.equal(data.loaded(), 'first');

  // The window and the header's span: only the newest day so far. The page's one loading line
  // reads the rest's days from the window; there's no separate "only this day" note.
  const st = data.status();
  assert.deepEqual([st.window.from, st.window.to], [WEEK.to, WEEK.to]);
  assert.deepEqual([st.window.partial.from, st.window.partial.to], [WEEK.from, WEEK.to]);
  assert.equal(st.window.note, undefined);
  assert.deepEqual(st.window.partial.rest, { from: WEEK.from, to: '2025-03-15' });

  // Every answer carries the partial window, and its counts are the first day's alone.
  const home = (await data.route('/api/home', params())).body;
  assert.ok(home.view.window.partial, 'every answer says the window is partial');
  const firstDay = await buildWorkHistory({ config: w.config, roots: w.roots, from: WEEK.to, to: WEEK.to, timezone: 'UTC', scope: 'all' });
  assert.equal(home.coverage.sessionsRead.value, firstDay.sessions.length);
  assert.match(home.coverage.text, /so far \(the rest is still loading\)/);
  // "Nothing found" covers only the loaded days, and doesn't send anyone to --days 30.
  const none = (await data.route('/api/lookup', params({ q: 'no-such-branch-zzz' }))).body;
  assert.match(none.empty, /so far \(the rest is still loading\)/);
  assert.doesNotMatch(none.empty, /--days 30/);
  const missing = (await data.route('/api/replay', params({ session: 'cc-aaaaaaaaaaaaaaaa' }))).body;
  assert.match(missing.empty, /so far/);
  // The trend waits: part of a week against the whole week before would mislead.
  const trend = (await data.route('/api/problems', params({ trend: '1' }))).body;
  assert.deepEqual([trend.waiting, trend.trend, trend.earlier], ['loading', [], null]);

  // The whole week is one build, given a progress callback; the first day had none.
  await waitFor(() => g.calls.length === 2, 'the whole week to start');
  assert.deepEqual(g.calls.map((c) => [c.from, c.to, c.onProgress]), [[WEEK.to, WEEK.to, false], [WEEK.from, WEEK.to, true]]);
  // How long the rest has been loading, for the line's seconds.
  const ms = data.status().window.partial.elapsedMs;
  assert.ok(Number.isFinite(ms) && ms >= 0, String(ms));

  g.release();
  await data.whenWhole();
  assert.equal(data.loaded(), 'whole');
  const done = data.status();
  assert.deepEqual([done.window.from, done.window.to, done.window.partial], [WEEK.from, WEEK.to, undefined]);
  assert.equal(done.window.note, undefined, 'nothing was cut, so no note');
  const whole = await buildWorkHistory({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', scope: 'all' });
  const after = (await data.route('/api/home', params())).body;
  assert.equal(after.coverage.sessionsRead.value, whole.sessions.length, 'the complete answer counts the whole week');
  assert.ok(whole.sessions.length > firstDay.sessions.length, 'the made-up week has sessions before its last day');
  assert.doesNotMatch(after.coverage.text, /so far/);
  const t2 = (await data.route('/api/problems', params({ trend: '1' }))).body;
  assert.equal(t2.waiting, undefined);
  assert.ok(Array.isArray(t2.trend) && t2.trend.length > 0, 'the trend answers once every day is in');
  data.stop();
});

test('when the rest of the week fails to load, the page keeps the first day and says the rest couldn\'t be loaded', async () => {
  const g = gated({ failWhole: true });
  const data = progressive(g);
  data.start();
  await waitFor(() => data.status().state === 'ready', 'the first day');
  g.release();
  await data.whenWhole();
  assert.equal(data.loaded(), 'first');
  const st = data.status();
  assert.ok(st.window.partial, 'still marked partial: never shown as complete');
  assert.deepEqual([st.window.partial.rest.from, st.window.partial.failed], [WEEK.from, 'replay: the disk went away']);
  assert.equal((await data.route('/api/problems', params({ trend: '1' }))).body.waiting, 'loading');
  data.stop();
});

test('a search typed while the first day shows is still found by its id once the whole week takes over', async () => {
  const g = gated();
  const data = progressive(g);
  data.start();
  await waitFor(() => data.status().state === 'ready', 'the first day');
  const typed = (await data.route('/api/words', params({ q: 'parser' }))).body;
  const onlyPrivate = (await data.route('/api/words', params({ q: 'lantern notes', private: '1' }))).body;
  g.release();
  await data.whenWhole();
  assert.equal(data.loaded(), 'whole');
  // The page's address names the search by id and the page reloads: the words come back.
  const again = (await data.route('/api/words', params({ id: typed.queryId }))).body;
  assert.equal(again.query, 'parser');
  assert.doesNotMatch(String(again.empty ?? ''), /isn't kept/);
  // One typed only with Show private text on still isn't echoed with it off.
  const off = (await data.route('/api/words', params({ id: onlyPrivate.queryId }))).body;
  assert.equal(off.query, null);
  assert.match(off.empty, /Show private text on/);
  data.stop();
});

test('a stop while the rest loads swaps nothing in; a one-day window loads once, never partial', async () => {
  const g = gated();
  const data = progressive(g);
  data.start();
  await waitFor(() => g.calls.length === 2, 'the whole week to start');
  data.stop();
  g.release();
  await data.whenWhole();
  assert.equal(data.loaded(), 'first');

  const one = createProgressiveData({ from: WEEK.to, to: WEEK.to, timezone: 'UTC', roots: w.roots, make: (o) => createViewData({ config: w.config, roots: w.roots, timezone: 'UTC', ...o }) });
  await one.start();
  assert.equal(one.status().window.partial, undefined);
  assert.equal(typeof one.loaded, 'undefined', 'a single day is plain view data');
});

test('memory: a window that needs more than the process has loads the newest days that fit and says which', async () => {
  const files = [{ day: WEEK.to, size: 100 * MB }, { day: '2025-03-15', size: 100 * MB }, { day: '2025-03-12', size: 400 * MB }];
  // Room for all of it: nothing cut.
  assert.deepEqual([fitWindow({ from: WEEK.from, to: WEEK.to, files, room: 2000 * MB }).cut, fitWindow({ from: WEEK.from, to: WEEK.to, files, room: 2000 * MB }).note], [false, null]);
  // Room for the two newest days only.
  const fit = fitWindow({ from: WEEK.from, to: WEEK.to, files, room: 300 * MB });
  assert.equal(fit.cut, true);
  assert.equal(fit.from, '2025-03-13', 'the 400 MB day is left out; the empty days after it fit');
  assert.match(fit.note, new RegExp(`^Loaded 2025-03-13 to ${WEEK.to}: all of ${WEEK.from} to ${WEEK.to} \\(600 MB of logs\\) needs more memory than this process has left`));
  // Through the loader: the whole-window build starts on that day, and the page says why.
  const g = gated();
  const data = progressive(g, { room: () => 300 * MB, files });
  data.start();
  await waitFor(() => g.calls.length === 2, 'the narrowed window to start');
  assert.deepEqual([g.calls[1].from, g.calls[1].to], ['2025-03-13', WEEK.to]);
  g.release();
  await data.whenWhole();
  assert.match(data.status().window.note, /needs more memory than this process has left/);
  data.stop();
});

test('the trend: past the limit or past memory, the week before isn\'t read and the answer says so in a few words', async () => {
  const seen = [];
  const counting = async (o) => {
    seen.push(o.from);
    return buildWorkHistory(o);
  };
  const skip = createViewData({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', buildHistory: counting, earlierCheck: (win) => ({ why: 'limit', note: `The ${win.days} days before hold 900 MB of logs, past the 500 MB limit, so they aren't compared.` }) });
  await skip.start();
  const t = (await skip.route('/api/problems', params({ trend: '1' }))).body;
  assert.equal(t.earlier.skipped, 'limit');
  assert.equal(t.earlier.note, "The 7 days before hold 900 MB of logs, past the 500 MB limit, so they aren't compared.");
  assert.ok(t.trend.every((x) => x.why === 'not-loaded' && x.sure.before === null), 'no "before" count when it was never read');
  assert.ok(!seen.includes('2025-03-03'), 'the week before was never built');
  // Failing-path partner: with no check, the week before is read as before.
  const plain = createViewData({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', buildHistory: counting });
  await plain.start();
  const p = (await plain.route('/api/problems', params({ trend: '1' }))).body;
  assert.equal(p.earlier.skipped, undefined);
  assert.ok(seen.includes('2025-03-03'));
  // trendOf names the skipped case apart from a failure.
  const now = { sessions: 1, patterns: { x: { ran: true, sure: { value: 1, evidence: 'derived' }, possible: { value: 0, evidence: 'derived' } } } };
  assert.equal(trendOf(now, { window: {}, error: 'skipped', skipped: 'memory' }).x.why, 'not-loaded');
  assert.equal(trendOf(now, { window: {}, error: 'boom' }).x.why, 'failed');
});

test('Show private text that would not fit beside the week isn\'t built; the page gets the redacted answer and the reason', async () => {
  const data = createViewData({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', privateCheck: () => 'Show private text needs a second copy of these 2.0 GB of logs in memory, more than this process has left.' });
  await data.start();
  await data.start('private');
  const r = (await data.route('/api/home', params({ private: '1' }))).body;
  assert.equal(r.view.shown, 'redacted');
  assert.match(r.view.note, /more than this process has left/);
});

test('a session with no title gets a label from its log: headless run or untitled, when it started, and its first words, redacted', async () => {
  const data = createViewData({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC' });
  await data.start();
  await data.start('private');
  const rowOf = (body, key) => body.recent.find((r) => r.session === key);
  const red = (await data.route('/api/home', params())).body;
  const hl = rowOf(red, KEYS.headless);
  assert.ok(hl, 'the headless session is listed');
  assert.equal(hl.title, null, 'no title is invented');
  assert.match(hl.label, /^headless run, Mar 16, 9:05 AM: “Review the \[redacted:[a-z]+\] pull request with token(?: \[redacted:[a-z]+\])?…”$/, 'eight words at most, cut at the edge of a marker');
  assert.ok(!hl.label.includes(TERM) && !hl.label.includes(SECRETS.github));
  const un = rowOf(red, KEYS.untitled);
  assert.equal(un.label, 'untitled, Mar 16, 9:05 AM: “Tidy the release notes”', 'a short prompt is whole, with no "…"');
  // With Show private text on, the private word shows; the secret never does.
  const priv = (await data.route('/api/home', params({ private: '1' }))).body;
  const hp = rowOf(priv, KEYS.headless);
  assert.ok(hp.label.includes(TERM), hp.label);
  assert.ok(!hp.label.includes(SECRETS.github), hp.label);
  // A session with a title keeps it and gets no label; the codex exec run is headless too.
  const titled = red.recent.find((r) => r.title);
  assert.equal(titled.label, undefined);
  const exec = (await data.route('/api/home', params())).body.recent.find((r) => r.session === w.keys.exec);
  if (exec && !exec.title) assert.match(exec.label, /^headless run, /);
  // The replay and the Problems page's sessions carry the same label.
  const rp = (await data.route('/api/replay', params({ session: KEYS.headless }))).body;
  assert.equal(rp.labels[KEYS.headless], hl.label);
  // A display-only or outside session's words stay out: its label, if any, is the start alone.
  const hidden = red.recent.filter((r) => r.group !== 'configured' && r.label);
  for (const r of hidden) assert.doesNotMatch(r.label, /“/, r.label);
});

test('the engine marks a claude -p session headless only when its log says so, and reports files read as it goes', async () => {
  const seen = [];
  const h = await buildWorkHistory({ config: w.config, roots: w.roots, from: WEEK.to, to: WEEK.to, timezone: 'UTC', scope: 'all', onProgress: (p) => seen.push(p) });
  assert.equal(h.sessions.find((s) => s.key === KEYS.headless).headless, true);
  assert.equal('headless' in h.sessions.find((s) => s.key === KEYS.untitled), false, 'absent, not false, for a terminal session');
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen[0], { read: 0, total: seen[0].total });
  assert.equal(seen.at(-1).read, seen.at(-1).total, 'the last report is every file');
  // A listener that throws never stops the build.
  await buildWorkHistory({ config: w.config, roots: w.roots, from: WEEK.to, to: WEEK.to, timezone: 'UTC', onProgress: () => {
    throw new Error('listener');
  } });
});

test("partialState: the rest's days, how far and how long, a window cut to fit, a failure, and no progress yet", () => {
  const p = partialState({ from: WEEK.from, to: WEEK.to, progress: () => ({ read: 3, total: 9 }), failed: () => null, start: () => WEEK.from, startedAt: () => 1000 }, { from: WEEK.to, now: () => 42_000 });
  assert.deepEqual(p, { from: WEEK.from, to: WEEK.to, rest: { from: WEEK.from, to: '2025-03-15' }, read: 3, total: 9, elapsedMs: 41_000, failed: null });
  // Cut to fit memory: the rest reads from where the cut starts.
  const cut = partialState({ from: WEEK.from, to: WEEK.to, progress: () => null, failed: () => null, start: () => '2025-03-13', startedAt: () => null }, { from: WEEK.to });
  assert.deepEqual([cut.rest, cut.read, cut.total, cut.elapsedMs], [{ from: '2025-03-13', to: '2025-03-15' }, null, null, null]);
  // Cut to just the shown day: the rest never claims the days the cut dropped.
  const one = partialState({ from: WEEK.from, to: WEEK.to, progress: () => null, failed: () => null, start: () => WEEK.to }, { from: WEEK.to });
  assert.deepEqual(one.rest, { from: WEEK.to, to: WEEK.to });
  const two = partialState({ from: WEEK.from, to: WEEK.to, progress: () => null, failed: () => 'no room' }, { from: '2025-03-15' });
  assert.deepEqual([two.rest, two.failed], [{ from: WEEK.from, to: '2025-03-14' }, 'no room']);
  assert.equal(PRIVATE_WORDS_SHORT.split(' ').length <= 10, true, 'the private-words line is short');
});

test('the pages: Setup and Settings land on Problems; the private-words line links to Settings; the trend line has its words', () => {
  const asset = (name) => readFileSync(new URL(`../lib/view/assets/${name}`, import.meta.url), 'utf8');
  const setup = asset('setup.js');
  assert.match(setup, /location\.href = 'problems\.html';/);
  assert.doesNotMatch(setup, /search\.html/, 'Setup never sends anyone to Find');
  assert.match(asset('settings.js'), /location\.href = 'problems\.html';/);
  const common = asset('common.js');
  assert.match(common, /href="settings\.html#names"/);
  assert.match(common, /<details class="help inline"><summary aria-label="About private words">\?<\/summary>/);
  assert.match(asset('settings.html'), /id="names"/, 'the link lands on the private words');
  const problems = asset('problems.js');
  for (const words of ['Comparing with the week before…', 'Compared with the week before once every day is in.', 'before not loaded']) assert.ok(problems.includes(words), words);
  // The trend note sits in the landing's lead line, which problems.js draws.
  assert.match(problems, /id="trendNote"/);
});

const TOOL = fileURLToPath(new URL('../tools/synthetic-week.mjs', import.meta.url));
test('tools/synthetic-week.mjs writes copies of the demo week into the 7 days it names, each with its own ids', async () => {
  const { execFileSync } = await import('node:child_process');
  // A folder with an id-shaped name: the copies must still point at the demo's repositories.
  const out = join(scratch, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'synthetic');
  const r = JSON.parse(execFileSync(process.execPath, [TOOL, out, '2', '--to', '2026-01-11'], { encoding: 'utf8' }));
  assert.deepEqual([r.from, r.to, r.copies], ['2026-01-05', '2026-01-11', 2]);
  const { loadConfig } = await import('../lib/config.mjs');
  const config = loadConfig(r.config);
  const h = await buildWorkHistory({ config, roots: r.roots, from: r.from, to: r.to, timezone: 'UTC', scope: 'all', git: false });
  const demo = await buildWorkHistory({ config, roots: r.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', scope: 'all', git: false });
  assert.equal(h.sessions.length, 2 * demo.sessions.length, 'two copies, each its own sessions');
  const configured = (x) => x.sessions.filter((s) => !s.private).length;
  assert.ok(configured(demo) > 0);
  assert.equal(configured(h), 2 * configured(demo), 'each copy reads as being in the configured repositories');
  // --weeks 2: a second week before the first, its copies with their own ids too.
  const two = JSON.parse(execFileSync(process.execPath, [TOOL, join(scratch, 'synthetic-two'), '1', '--to', '2026-01-11', '--weeks', '2'], { encoding: 'utf8' }));
  assert.deepEqual([two.from, two.to, two.weeks], ['2025-12-29', '2026-01-11', 2]);
  const before = await buildWorkHistory({ config: loadConfig(two.config), roots: two.roots, from: '2025-12-29', to: '2026-01-04', timezone: 'UTC', scope: 'all', git: false });
  assert.ok(configured(before) > 0, 'the week before has sessions of its own');
  // Failing path: no copies asked for is refused.
  assert.throws(() => execFileSync(process.execPath, [TOOL, join(scratch, 'none'), '0'], { stdio: 'pipe' }));
});

test('the week before loads the way this week did: newest day first, "before so far" until all of it is in, one build at a time', async () => {
  // The demo week's own days stand in for "the week before": a window of the 7 days after it.
  const after = { from: '2025-03-17', to: '2025-03-23' };
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  let live = 0;
  let most = 0;
  const build = async (o) => {
    calls.push([o.from, o.to]);
    live += 1;
    most = Math.max(most, live);
    try {
      if (o.from === WEEK.from && o.to === WEEK.to) await gate;
      return await buildWorkHistory(o);
    } finally {
      live -= 1;
    }
  };
  const data = createViewData({ config: w.config, roots: w.roots, ...after, timezone: 'UTC', buildHistory: build, earlierProgressive: true });
  await data.start();
  const first = (await data.route('/api/problems', params({ trend: '1' }))).body;
  assert.deepEqual(first.earlier.partial, { from: WEEK.to, to: WEEK.to }, 'the newest day of the week before is in first');
  assert.equal(first.earlier.note, `The 7 days before: only ${WEEK.to} so far, so "before" covers just that day. The rest is loading.`);
  const firstDay = await buildWorkHistory({ config: w.config, roots: w.roots, from: WEEK.to, to: WEEK.to, timezone: 'UTC', scope: 'all' });
  assert.equal(first.earlier.sessions, firstDay.sessions.filter((x) => !x.private).length, 'its counts are the first day\'s alone');
  // Still partial while the rest loads; the whole week before starts only after the first day's build.
  await waitFor(() => calls.some(([a, b]) => a === WEEK.from && b === WEEK.to), 'the whole week before to start');
  assert.ok((await data.route('/api/problems', params({ trend: '1' }))).body.earlier.partial);
  release();
  await waitFor(async () => !(await data.route('/api/problems', params({ trend: '1' }))).body.earlier.partial, 'the whole week before');
  const done = (await data.route('/api/problems', params({ trend: '1' }))).body;
  const whole = await buildWorkHistory({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', scope: 'all' });
  assert.equal(done.earlier.sessions, whole.sessions.filter((x) => !x.private).length, 'then the whole week before');
  assert.equal(done.earlier.note, undefined);
  assert.ok(done.trend.some((t) => t.sure.before !== null), 'rows have a before count');
  const earlierCalls = calls.filter(([a]) => a < after.from);
  assert.deepEqual(earlierCalls, [[WEEK.to, WEEK.to], [WEEK.from, WEEK.to]]);
  assert.equal(most, 1, 'never two builds of the week before at once, nor beside this window\'s own build');
});

test('the week before, cut to what memory holds: only its newest days, and the note says so', async () => {
  const after = { from: '2025-03-17', to: '2025-03-23' };
  const seen = [];
  const build = (o) => (seen.push([o.from, o.to]), buildWorkHistory(o));
  const data = createViewData({ config: w.config, roots: w.roots, ...after, timezone: 'UTC', buildHistory: build, earlierProgressive: true, earlierCheck: () => ({ from: '2025-03-14', note: 'Compared with 2025-03-14 to 2025-03-16 only: all 7 days before need more memory than this process has left.' }) });
  await data.start();
  await data.route('/api/problems', params({ trend: '1' }));
  await waitFor(async () => !(await data.route('/api/problems', params({ trend: '1' }))).body.earlier.partial, 'the cut week before');
  const t = (await data.route('/api/problems', params({ trend: '1' }))).body;
  assert.deepEqual(t.earlier.loaded, { from: '2025-03-14', to: WEEK.to });
  assert.match(t.earlier.note, /^Compared with 2025-03-14 to 2025-03-16 only/);
  assert.ok(seen.some(([a, b]) => a === '2025-03-14' && b === WEEK.to));
  assert.ok(!seen.some(([a]) => a === WEEK.from), 'the days that did not fit were never read');
});
