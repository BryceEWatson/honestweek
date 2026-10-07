// The optional /insights group on the Problems page and its Run button (lib/view/insights.mjs).
// With the toggle off nothing honestweek already shows changes, byte for byte; on, the files
// Claude Code's /insights wrote are read for this window's configured sessions only, matched by
// session id, defensively (missing, malformed and unknown-shaped files), and every string passes
// the redactor with Show private text off and on. The Run button needs the run's key, takes POST
// only, refuses other hosts and sites, runs once at a time, stops on time, and says so when
// claude isn't on the PATH. Every run uses a fake claude written here, never the real one, and
// made-up /insights files in temporary folders.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { claudeEnv, createInsights, findOnPath, hasInsightsData, insightsDir, MAX_INSIGHTS_FILE, readInsights } from '../lib/view/insights.mjs';
import { saveInsightsFlag } from '../lib/view/settings.mjs';
import { CODE_HEADER, KEY_HEADER } from '../lib/view/server.mjs';
import { runView } from '../lib/view.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { buildViewWeek, IDS, NAME, OTHER_TERM, SECRETS, TERM, WEEK } from './fixtures/view/week.mjs';

const scratch = makeTempDir('hw-view-insights-');
const running = [];
// Each test's pages stop when it ends, and their builds with them, so a build a test is done
// with doesn't run git while a later test waits on its own.
afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});
after(async () => {
  for (const h of running) await h.stop();
  removeTempDir(scratch);
});

const w = buildViewWeek(join(scratch, 'week'));
const WINDOW = { from: WEEK.from, to: WEEK.to, timezone: 'UTC' };
const NOW = Date.parse(`${WEEK.to}T12:00:00Z`);
const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A made-up facets file. */
const facets = (id, more = {}) => ({ session_id: id, underlying_goal: 'Tidy the changelog', outcome: 'mostly_achieved', friction_counts: { wrong_approach: 2, buggy_code: 1 }, friction_detail: 'Went the wrong way first.', brief_summary: 'Tidied the changelog.', ...more });
function writeInsights(dir, folder, id, value) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, `${id}.json`), typeof value === 'string' ? value : JSON.stringify(value));
}

// The made-up /insights files and three builds of the fixture week, made before any test runs:
// a root after() hook fires as soon as the tests registered so far finish.
const usage = join(scratch, 'usage-match');
writeInsights(usage, 'facets', IDS.featured, facets(IDS.featured, { friction_counts: { [`${TERM} confusion`]: 3 }, friction_detail: `${NAME} pasted ${SECRETS.github} into the ${TERM} chat.`, brief_summary: `Worked on ${OTHER_TERM} with key ${SECRETS.apiKey}.` }));
writeInsights(usage, 'facets', IDS.display, facets(IDS.display, { friction_detail: 'displayonlyword' }));
writeInsights(usage, 'facets', IDS.outside, facets(IDS.outside, { friction_detail: 'outsideonlyword' }));
// A session outside this window, with its own file: never matched.
writeInsights(usage, 'facets', '99999999-9999-4999-8999-999999999999', facets('99999999-9999-4999-8999-999999999999', { friction_detail: 'otherweekword' }));

const make = (insights) => createViewData({ config: w.config, roots: w.roots, ...WINDOW, goalRecord: w.goalRecord, now: () => NOW, insights });
const plain = make(null);
const off = make(createInsights({ dir: usage, on: false }));
const on = make(createInsights({ dir: usage, on: true }));
for (const d of [plain, off, on]) await d.start();
await on.start('private');
const ask = (data, path, q = {}) => data.route(path, new URLSearchParams(q));

// ---- reading ------------------------------------------------------------------------------

test('reading tolerates missing, malformed and unknown-shaped files, and counts what it skipped', () => {
  const dir = join(scratch, 'parse');
  const ids = Array.from({ length: 9 }, (_, i) => `${String(i).repeat(8)}-0000-4000-8000-00000000000${i}`);
  // Nothing there at all: no data, nothing read, nothing skipped.
  assert.deepEqual(readInsights({ dir, sessions: ids.map((id, i) => ({ key: `k${i}`, id })) }), { exists: false, sessions: 9, matched: 0, skipped: 0, items: [] });
  assert.equal(hasInsightsData(dir), false);
  assert.deepEqual(readInsights({ dir: null, sessions: [{ key: 'k', id: ids[0] }] }).items, []);

  writeInsights(dir, 'facets', ids[0], facets(ids[0], { some_new_field: { nested: [1, 2] }, friction_counts: { wrong_approach: 2, buggy_code: 1, zero: 0, negative: -1, fraction: 1.5, text: '3', '': 4 } }));
  writeInsights(dir, 'session-meta', ids[0], { session_id: ids[0], duration_minutes: 41.6, first_prompt: 'never shown', project_path: '/path/to/your/repo' });
  writeInsights(dir, 'facets', ids[1], '{ not json');
  writeInsights(dir, 'facets', ids[2], JSON.stringify([facets(ids[2])]));
  writeInsights(dir, 'facets', ids[3], { ...facets(ids[3]), session_id: undefined });
  writeInsights(dir, 'facets', ids[4], facets(ids[5])); // its session_id names another session
  writeInsights(dir, 'facets', ids[5], { session_id: ids[5].toUpperCase(), friction_counts: 'lots', friction_detail: ['Part one.', 7, 'Part two.'] });
  writeInsights(dir, 'facets', ids[6], facets(ids[6], { friction_counts: {} }));
  writeInsights(dir, 'session-meta', ids[6], '');
  writeInsights(dir, 'facets', ids[7], `{"session_id":"${ids[7]}","pad":"${'x'.repeat(MAX_INSIGHTS_FILE)}"}`);
  // A file for a session not in the window is never counted.
  writeInsights(dir, 'facets', ids[8], facets(ids[8]));

  const sessions = ids.slice(0, 8).map((id, i) => ({ key: `k${i}`, id }));
  const r = readInsights({ dir, sessions: [...sessions, { key: 'bad', id: '../facets/x' }, { key: 'dup', id: ids[0] }] });
  assert.equal(r.exists, true);
  assert.equal(r.sessions, 8, 'a malformed id and a repeated id are passed over');
  assert.equal(r.matched, 3, 'ids 0, 5 and 6 have readable facets');
  assert.equal(r.skipped, 6, 'not JSON, a list, no session_id, the wrong session_id, too large, and one empty session-meta file');
  assert.deepEqual(r.items, [{ session: 'k0', frictions: [{ category: 'wrong_approach', count: 2 }, { category: 'buggy_code', count: 1 }], detail: 'Went the wrong way first.', summary: 'Tidied the changelog.', outcome: 'mostly_achieved', minutes: 42 }]);
  assert.ok(!JSON.stringify(r).includes('never shown') && !JSON.stringify(r).includes('/path/to'), 'session-meta fields other than the minutes are never carried');
});

test('claude is found only in absolute folders on the PATH, with PATHEXT on Windows', () => {
  const dir = join(scratch, 'pathfind');
  mkdirSync(dir, { recursive: true });
  // Named with PATHEXT's own case, so the Windows lookup also finds it on a case-sensitive disk.
  writeFileSync(join(dir, 'claude.CMD'), '@echo off\r\n');
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\n');
  chmodSync(join(dir, 'claude'), 0o755);
  assert.equal(findOnPath('claude', { Path: `relative;${dir}`, PATHEXT: '.EXE;.CMD' }, 'win32')?.toLowerCase(), join(dir, 'claude.cmd').toLowerCase());
  if (!WIN) assert.equal(findOnPath('claude', { PATH: `relative:${dir}` }, process.platform), join(dir, 'claude'));
  // Failing path: only relative entries, or none, find nothing.
  assert.equal(findOnPath('claude', { PATH: 'relative' }, 'win32'), null);
  assert.equal(findOnPath('claude', {}, 'win32'), null);
});

// ---- matching, redaction and byte-identical output ------------------------------------------


test('with the toggle off, and with it on, every Problems answer is byte-identical to one without /insights', async () => {
  for (const q of [{}, { summary: '1' }, { session: w.keys.featured }, { thread: (await ask(plain, '/api/replay', { session: w.keys.featured })).body.thread?.id ?? '' }]) {
    const base = JSON.stringify(await ask(plain, '/api/problems', q));
    assert.equal(JSON.stringify(await ask(off, '/api/problems', q)), base, `off: ${JSON.stringify(q)}`);
    // `on` has also built its private text (for the redaction test), which every answer's
    // view.privateState reports; that field aside, the answer is the same bytes.
    const r = await ask(on, '/api/problems', q);
    assert.equal(r.body.view.privateState, 'ready');
    assert.equal(JSON.stringify({ ...r, body: { ...r.body, view: { ...r.body.view, privateState: 'idle' } } }), base, `on: ${JSON.stringify(q)}`);
  }
  // The history serializes as before: the session ids it now holds aren't enumerable.
  const h = await buildWorkHistory({ config: w.config, roots: w.roots, ...WINDOW, scope: 'all' });
  assert.ok(h.claudeIds instanceof Map && h.claudeIds.get(w.keys.featured) === IDS.featured);
  assert.ok(!JSON.stringify(h).includes('claudeIds') && !Object.keys(h).includes('claudeIds'));
  // Off, the answer says so and reads no file.
  const a = (await ask(off, '/api/insights')).body;
  assert.equal(a.on, false);
  assert.equal(a.data, null);
  assert.equal(a.hasData, true);
  // No service at all: the route isn't there.
  assert.equal((await ask(plain, '/api/insights')).status, 404);
});

test('on, only this window\'s configured sessions are matched, by session id', async () => {
  const a = (await ask(on, '/api/insights')).body;
  assert.equal(a.on, true);
  assert.deepEqual(a.data.items.map((it) => it.session), [w.keys.featured]);
  assert.equal(a.data.matched, 1);
  const text = JSON.stringify(a);
  for (const word of ['displayonlyword', 'outsideonlyword', 'otherweekword']) assert.ok(!text.includes(word), `${word} must not appear`);
  assert.equal(a.data.items[0].frictions[0].count, 3);
  assert.equal(a.data.items[0].thread, (await ask(plain, '/api/replay', { session: w.keys.featured })).body.thread?.id ?? a.data.items[0].thread);
  // One session's view: that session, or nothing.
  assert.equal((await ask(on, '/api/insights', { session: w.keys.featured })).body.data.items.length, 1);
  assert.equal((await ask(on, '/api/insights', { session: w.keys.display })).body.data.items.length, 0);
  assert.equal((await ask(on, '/api/insights', { session: '../x' })).status, 400);
});

test('friction_detail, brief_summary and the category pass the redactor with Show private text off and on', async () => {
  const offText = JSON.stringify((await ask(on, '/api/insights')).body.data);
  for (const word of [TERM, OTHER_TERM, 'Whitfield', SECRETS.github, SECRETS.apiKey]) assert.ok(!offText.includes(word), `off: ${word} is hidden`);
  assert.match(offText, /\[redacted:/);
  const onAnswer = (await ask(on, '/api/insights', { private: '1' })).body;
  assert.equal(onAnswer.view.shown, 'private');
  const onText = JSON.stringify(onAnswer.data);
  assert.ok(onText.includes(TERM) && onText.includes(NAME) && onText.includes(OTHER_TERM), 'on: private words show on this screen');
  for (const secret of [SECRETS.github, SECRETS.apiKey]) assert.ok(!onText.includes(secret), 'on: secrets stay hidden');
});

test('the toggle is saved in the config, and off gives back the same bytes', () => {
  const dir = join(scratch, 'flag');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'honestweek.config.json');
  const before = `${JSON.stringify({ identity: { authorEmails: ['you@example.com'] }, repos: [{ path: '.', label: 'your-project', role: 'featured' }] }, null, '\t').replace(/\n/g, '\r\n')}\r\n`;
  writeFileSync(file, before);
  assert.deepEqual(saveInsightsFlag(dir, true), { remembered: true, changed: true });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).insights, true);
  assert.match(readFileSync(file, 'utf8'), /\r\n\t"insights": true\r\n/, 'written in the file\'s own indent and line endings');
  assert.equal(normalizeConfig(JSON.parse(readFileSync(file, 'utf8')), { configDir: dir }).insights, true);
  assert.deepEqual(saveInsightsFlag(dir, false), { remembered: true, changed: true });
  assert.equal(readFileSync(file, 'utf8'), before, 'the same bytes as before it was turned on');
  assert.deepEqual(saveInsightsFlag(dir, false), { remembered: true, changed: false });
  // Failing path: a value that isn't true or false is a config error.
  assert.throws(() => normalizeConfig({ ...JSON.parse(before), insights: 'yes' }, { configDir: dir }), /"insights" must be true or false/);
  assert.equal(normalizeConfig(JSON.parse(before), { configDir: dir }).insights, undefined, 'absent stays absent');
});

// ---- the Run button ------------------------------------------------------------------------

/** A fake claude: notes its arguments, then the names of its environment variables, waits
 *  FAKE_CLAUDE_MS, writes a made-up facets file for FAKE_SESSION under
 *  CLAUDE_CONFIG_DIR/usage-data, and exits with FAKE_CLAUDE_EXIT. Its settings sit in a file
 *  beside it, since claude's environment keeps only the variables it needs. */
function fakeClaude(name, settings = {}) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fake.json'), JSON.stringify(settings));
  writeFileSync(join(dir, 'fake-claude.mjs'), `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const e = JSON.parse(readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
appendFileSync(e.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
appendFileSync(e.FAKE_LOG, JSON.stringify({ env: Object.keys(process.env) }) + '\\n');
setTimeout(() => {
  if (e.FAKE_SESSION) {
    const dir = join(process.env.CLAUDE_CONFIG_DIR, 'usage-data', 'facets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, e.FAKE_SESSION + '.json'), JSON.stringify({ session_id: e.FAKE_SESSION, friction_counts: { fake_friction: 1 }, friction_detail: 'Made up by the fake claude.' }));
  }
  appendFileSync(e.FAKE_LOG, 'finished\\n');
  process.exit(Number(e.FAKE_CLAUDE_EXIT || 0));
}, Number(e.FAKE_CLAUDE_MS || 0));
`);
  if (WIN) writeFileSync(join(dir, 'claude.cmd'), `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
  else {
    // The script's own path is written in: the tests' PATH holds no dirname.
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-claude.mjs')}" "$@"\n`);
    chmodSync(join(dir, 'claude'), 0o755);
  }
  return dir;
}
/** The machine's env pieces a child process needs, and nothing that could find a real claude. */
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SystemRoot|SYSTEMROOT|ComSpec|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|HOME|USERPROFILE)$/i.test(k)));
const gitDir = (() => {
  const git = findOnPath('git', process.env);
  return git ? dirname(git) : null;
})();
const realClaudeBesideGit = gitDir ? !!findOnPath('claude', { ...process.env, PATH: gitDir }) : false;
const SEP = WIN ? ';' : ':';

test('with the toggle off a run is refused and claude never starts; turned on, it runs', async () => {
  const log = join(scratch, 'off.log');
  const bin = fakeClaude('bin-off', { FAKE_LOG: log });
  const env = { ...baseEnv(), PATH: bin, CLAUDE_CONFIG_DIR: join(scratch, 'off-home') };
  const ins = createInsights({ dir: join(env.CLAUDE_CONFIG_DIR, 'usage-data'), env, cwd: scratch });
  const r = await ins.run();
  assert.deepEqual([r.status, r.body.error, r.body.on, r.body.run.state], [409, 'off', false, 'idle']);
  assert.match(r.body.message, /Include \/insights is off/);
  assert.equal(existsSync(log), false, 'claude did not start');
  // The demo with the toggle off is refused as off too: the switch is checked first.
  assert.equal((await createInsights({ dir: null, demo: true, env, cwd: scratch }).run()).body.error, 'off');
  ins.setOn(true);
  assert.equal((await ins.run()).status, 200);
  for (let i = 0; i < 200 && ins.info().run.state === 'running'; i++) await sleep(50);
  assert.equal(ins.info().run.state, 'done');
  assert.ok(existsSync(log), 'claude ran once the toggle was on');
});

test('claude gets only the environment it needs to start and sign in, never other tokens', async () => {
  const log = join(scratch, 'env.log');
  const bin = fakeClaude('bin-env', { FAKE_LOG: log });
  const keep = { CLAUDE_CONFIG_DIR: join(scratch, 'env-home'), ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'p', DISABLE_TELEMETRY: '1', https_proxy: 'http://127.0.0.1:9' };
  const drop = { GITHUB_TOKEN: SECRETS.github, NPM_TOKEN: 'n', OPENAI_API_KEY: 'o', HW_SECRET_TOKEN: SECRETS.apiKey, CLAUDECODE: '1' };
  const env = { ...baseEnv(), PATH: bin, ...keep, ...drop };
  const ins = createInsights({ dir: join(keep.CLAUDE_CONFIG_DIR, 'usage-data'), on: true, env, cwd: scratch });
  assert.equal((await ins.run()).status, 200);
  for (let i = 0; i < 200 && ins.info().run.state === 'running'; i++) await sleep(50);
  assert.equal(ins.info().run.state, 'done');
  const seen = new Set(JSON.parse(readFileSync(log, 'utf8').split('\n')[1]).env.map((k) => k.toUpperCase()));
  for (const k of ['PATH', ...Object.keys(keep)]) assert.ok(seen.has(k.toUpperCase()), `${k} reaches claude`);
  for (const k of Object.keys(drop)) assert.ok(!seen.has(k), `${k} does not reach claude`);
  assert.deepEqual(Object.keys(claudeEnv({ Path: 'x', github_token: 'y', Anthropic_Auth_Token: 'z', HW_X: 1 })), ['Path', 'Anthropic_Auth_Token'], 'names match in any case; only strings pass');
});

test('a run stops on time, with everything it started, and a stale run never ends a new one', async () => {
  const log = join(scratch, 'timeout.log');
  const bin = fakeClaude('bin-timeout', { FAKE_LOG: log, FAKE_CLAUDE_MS: '4000' });
  const env = { ...baseEnv(), PATH: bin, CLAUDE_CONFIG_DIR: join(scratch, 'timeout-home') };
  const ins = createInsights({ dir: join(env.CLAUDE_CONFIG_DIR, 'usage-data'), on: true, env, cwd: scratch, timeoutMs: 600 });
  const started = await ins.run();
  assert.equal(started.status, 200);
  assert.equal(started.body.run.state, 'running');
  for (let i = 0; i < 100 && ins.info().run.state === 'running'; i++) await sleep(50);
  assert.equal(ins.info().run.state, 'timeout');
  await sleep(4500);
  assert.ok(existsSync(log), 'the fake claude started');
  assert.ok(!readFileSync(log, 'utf8').includes('finished'), 'it was stopped before it finished');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').split('\n')[0]), ['-p', '/insights'], 'the fixed arguments, nothing else');
});

test('a run that fails says so with its exit code; the demo refuses to run', async () => {
  const bin = fakeClaude('bin-fail', { FAKE_LOG: join(scratch, 'fail.log'), FAKE_CLAUDE_EXIT: '3' });
  const env = { ...baseEnv(), PATH: bin, CLAUDE_CONFIG_DIR: join(scratch, 'fail-home') };
  const ins = createInsights({ dir: join(env.CLAUDE_CONFIG_DIR, 'usage-data'), on: true, env, cwd: scratch });
  assert.equal((await ins.run()).status, 200);
  for (let i = 0; i < 200 && ins.info().run.state === 'running'; i++) await sleep(50);
  assert.deepEqual([ins.info().run.state, ins.info().run.code], ['failed', 3]);
  const demo = createInsights({ dir: null, on: true, demo: true, env, cwd: scratch });
  const r = await demo.run();
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'demo');
  assert.equal(existsSync(join(scratch, 'demo-ran.log')), false);
  assert.equal((await demo.toggle('{"on":true}')).body.on, true, 'the demo can still turn the group on, for this run');
});

// The server: a real `honestweek view` over the fixture week, with the fake claude first on the PATH.
function call(port, { method = 'GET', path, key, body = null, host = `127.0.0.1:${port}`, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, setHost: false, agent: false, headers: { host, ...(key ? { [KEY_HEADER]: key } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {}
        resolve({ status: res.statusCode, json, text: t });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
function project(name, more = {}) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const cfg = { identity: { authorEmails: ['you@example.com'] }, week: { startsOn: 'monday', timezone: 'UTC' }, repos: w.config.repos.map((r) => ({ path: r.resolvedPath ?? r.path, label: r.label, role: r.role })), redaction: { names: [NAME], terms: [TERM, OTHER_TERM] }, ...more };
  writeFileSync(join(dir, 'honestweek.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  return dir;
}
async function view(cwd, env) {
  let handle = null;
  const err = [];
  const code = await runView({ argv: ['--no-open', '--from', WEEK.from, '--to', WEEK.to], cwd, env, io: { out: () => {}, err: (s) => err.push(s) }, input: null, block: false, now: () => NOW, onServe: (h) => (handle = h) });
  assert.equal(code, 0, err.join(''));
  running.push(handle);
  const c = /#c=([0-9a-f]+)/.exec(handle.address('printed'))[1];
  const key = (await call(handle.port, { path: '/api/claim', headers: { [CODE_HEADER]: c } })).json.key;
  for (let i = 0; i < 600; i++) {
    // The whole week, not just its newest day, which loads first.
    const st = (await call(handle.port, { path: '/api/status', key })).json;
    if (st.state !== 'building' && !st.window?.partial) break;
    await sleep(50);
  }
  return { handle, port: handle.port, key };
}

test('the Run button needs the key, takes POST only, refuses other hosts and sites, and runs once at a time', async (t) => {
  if (!gitDir) return t.skip('git is not on the PATH');
  const home = dirname(w.roots.claude[0]);
  const log = join(scratch, 'server.log');
  const bin = fakeClaude('bin-server', { FAKE_LOG: log, FAKE_CLAUDE_MS: '1500', FAKE_SESSION: IDS.featured });
  const env = { ...baseEnv(), PATH: `${bin}${SEP}${gitDir}`, CLAUDE_CONFIG_DIR: home, CODEX_HOME: dirname(w.roots.codex[0]) };
  const cwd = project('server');
  const s = await view(cwd, env);
  const before = readFileSync(join(cwd, 'honestweek.config.json'), 'utf8');
  const post = (path, more = {}) => call(s.port, { method: 'POST', path, key: s.key, body: '{}', ...more });
  for (const path of ['/api/insights/run', '/api/insights/toggle']) {
    assert.equal((await post(path, { key: null })).status, 403, `${path}: no key`);
    assert.equal((await post(path, { key: 'f'.repeat(64) })).status, 403, `${path}: a wrong key`);
    assert.equal((await call(s.port, { path, key: s.key })).status, 405, `${path}: GET`);
    assert.equal((await post(path, { host: 'example.com' })).status, 403, `${path}: another host`);
    assert.equal((await post(path, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, `${path}: another site`);
    assert.equal((await post(path, { body: 'x'.repeat(8192) })).status, 413, `${path}: too large`);
  }
  assert.equal(existsSync(log), false, 'no refused request started claude');
  assert.equal(readFileSync(join(cwd, 'honestweek.config.json'), 'utf8'), before, 'no refused request wrote the config');

  // The toggle: a malformed body changes nothing; on is saved and shows the group.
  assert.equal((await post('/api/insights/toggle', { body: '{"on":"yes"}' })).status, 400);
  const info = (await call(s.port, { path: '/api/insights', key: s.key })).json;
  assert.deepEqual([info.on, info.claude, info.run.state], [false, true, 'idle']);
  // With the toggle off, a request with the key is still refused: the page's hidden button isn't the only guard.
  const offRun = await post('/api/insights/run');
  assert.deepEqual([offRun.status, offRun.json.error, offRun.json.on], [409, 'off', false]);
  assert.equal(existsSync(log), false, 'claude did not start while the toggle was off');
  const toggled = await post('/api/insights/toggle', { body: '{"on":true}' });
  assert.deepEqual([toggled.status, toggled.json.on, toggled.json.remembered], [200, true, true]);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'honestweek.config.json'), 'utf8')).insights, true);

  // One run at a time; the second is refused while the first goes on.
  const first = await post('/api/insights/run');
  assert.deepEqual([first.status, first.json.run.state], [200, 'running']);
  const second = await post('/api/insights/run');
  assert.deepEqual([second.status, second.json.error], [409, 'running']);
  let a;
  for (let i = 0; i < 200; i++) {
    a = (await call(s.port, { path: '/api/insights', key: s.key })).json;
    if (a.run.state !== 'running') break;
    await sleep(50);
  }
  assert.equal(a.run.state, 'done');
  assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('[')).length, 1, 'claude ran once');
  // Read again after the run: the made-up facets file it wrote now shows.
  assert.deepEqual(a.data.items.map((it) => [it.session, it.frictions[0].category]), [[w.keys.featured, 'fake_friction']]);
  // The page's own Problems answer didn't change.
  assert.equal((await call(s.port, { path: '/api/problems?summary=1', key: s.key })).status, 200);
});

test('with claude not on the PATH, the page still answers and the run says so', async (t) => {
  if (!gitDir) return t.skip('git is not on the PATH');
  if (realClaudeBesideGit) return t.skip('claude sits in the same folder as git here, so it cannot be left off the PATH');
  const env = { ...baseEnv(), PATH: gitDir, CLAUDE_CONFIG_DIR: dirname(w.roots.claude[0]), CODEX_HOME: dirname(w.roots.codex[0]) };
  const s = await view(project('no-claude'), env);
  const a = await call(s.port, { path: '/api/insights', key: s.key });
  assert.equal(a.status, 200);
  assert.equal(a.json.claude, false);
  assert.equal((await call(s.port, { method: 'POST', path: '/api/insights/toggle', key: s.key, body: '{"on":true}' })).status, 200);
  const r = await call(s.port, { method: 'POST', path: '/api/insights/run', key: s.key, body: '{}' });
  assert.deepEqual([r.status, r.json.error], [409, 'no-claude']);
  assert.equal((await call(s.port, { path: '/problems.html' })).status, 200);
});

test('the usage-data folder sits beside the projects folder', () => {
  assert.equal(insightsDir({ claude: [join(scratch, 'home', 'projects')] }), join(scratch, 'home', 'usage-data'));
  assert.equal(insightsDir({ claude: [] }), null);
});
