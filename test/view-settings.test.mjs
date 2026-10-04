// Settings and the saved "how far back" choice (lib/view/settings.mjs, lib/view/window.mjs):
// the window a config saves is the one the next run reads, the flags still win for one run,
// and an older config reads the last 7 days as before. Settings rewrites only what was
// changed, refuses everything the Setup routes refuse and writes nothing then, stops git
// reading a repository switched to display at once, and new private words hide text on the
// next page load. Every run reads only temporary folders: the seeded week's logs, never the
// machine's own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { runView } from '../lib/view.mjs';
import { CODE_HEADER, KEY_HEADER } from '../lib/view/server.mjs';
import { SETUP_MAX_BODY } from '../lib/view/setup.mjs';
import { MAX_LOG_BYTES, planWindow } from '../lib/view/window.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { buildViewWeek, NAME, OTHER_TERM, TERM, WEEK } from './fixtures/view/week.mjs';

const scratch = makeTempDir('hw-view-settings-');
const running = [];
after(async () => {
  for (const h of running) await h.stop();
  removeTempDir(scratch);
});

const w = buildViewWeek(join(scratch, 'week'));
const ENV = { CLAUDE_CONFIG_DIR: dirname(w.roots.claude[0]), CODEX_HOME: dirname(w.roots.codex[0]) };
const NOW = Date.parse(`${WEEK.to}T12:00:00Z`);
const day = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);

/** A config the way a person might have it: fields Settings doesn't show, a hand-ordered list. */
function baseConfig(more = {}) {
  return {
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: w.config.repos.map((r) => ({ path: r.resolvedPath ?? r.path, label: r.label, role: r.role })),
    redaction: { codenames: ['zeta', 'alpha'], names: [NAME], terms: [OTHER_TERM] },
    curation: { maxItems: 9, automaticMinScore: 3, retentionWeeks: 10, automaticCarryWeeks: 1, categoryCaps: { prompts: 1, ideas: 2, techniques: 3, decisions: 2, reversals: 1, nextSteps: 2 } },
    privacy: { publicRenditions: { enabled: false, maxAutomaticChangedPercent: 15, generalizationMappings: {}, neverPublicTerms: ['beta'] } },
    output: { mode: 'digest', file: 'my.digest.md' },
    ...more,
  };
}
const text = (cfg) => `${JSON.stringify(cfg, null, 2)}\n`;
function project(name, cfg = baseConfig()) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'honestweek.config.json'), text(cfg));
  return dir;
}

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

async function view(cwd, argv = []) {
  const out = [];
  const err = [];
  let handle = null;
  const code = await runView({ argv: ['--no-open', ...argv], cwd, env: ENV, io: { out: (s) => out.push(s), err: (s) => err.push(s) }, input: null, block: false, now: () => NOW, onServe: (h) => (handle = h) });
  assert.equal(code, 0, err.join(''));
  running.push(handle);
  const c = /#c=([0-9a-f]+)/.exec(handle.address('printed'))[1];
  const key = (await call(handle.port, { path: '/api/claim', headers: { [CODE_HEADER]: c } })).json.key;
  return { handle, port: handle.port, key, out: () => out.join('') };
}
async function ready(s) {
  let st;
  for (let i = 0; i < 600; i++) {
    st = (await call(s.port, { path: '/api/status', key: s.key })).json;
    if (st.state === 'ready' || st.state === 'failed') return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  return st;
}
/** What the page sends when nothing is touched: the file's values as Settings shows them. */
async function untouched(s) {
  const i = (await call(s.port, { path: '/api/settings', key: s.key })).json;
  assert.equal(i.editable, true, JSON.stringify(i));
  return { version: i.version, history: i.history, repos: i.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: i.authorEmails, names: i.names, terms: i.terms, goalsFile: i.goalsFile };
}
const post = (s, route, body, more = {}) => call(s.port, { method: 'POST', path: `/api/settings/${route}`, key: s.key, body: typeof body === 'string' ? body : JSON.stringify(body), ...more });

// ---- the saved window --------------------------------------------------------------------

test('the window a config saves is the one the next run reads; the flags win for one run; an old config reads the last 7 days', async () => {
  const saved = await view(project('saved-days', baseConfig({ history: { days: 30 } })));
  assert.deepEqual(saved.handle.window, { from: day(-29), to: WEEK.to, timezone: 'UTC' });
  const flagged = await view(project('saved-flag', baseConfig({ history: { days: 30 } })), ['--days', '3']);
  assert.deepEqual(flagged.handle.window, { from: day(-2), to: WEEK.to, timezone: 'UTC' });
  const ranged = await view(project('saved-range', baseConfig({ history: { all: true } })), ['--from', WEEK.from, '--to', WEEK.to]);
  assert.deepEqual(ranged.handle.window, { from: WEEK.from, to: WEEK.to, timezone: 'UTC' });
  const old = await view(project('old'));
  assert.deepEqual(old.handle.window, { from: day(-6), to: WEEK.to, timezone: 'UTC' });
  assert.equal((await ready(old)).window.note, undefined, 'no note when nothing was cut');
  const from = await view(project('saved-from', baseConfig({ history: { from: WEEK.from } })));
  assert.deepEqual(from.handle.window, { from: WEEK.from, to: WEEK.to, timezone: 'UTC' });
  // Failing path: a saved choice that isn't one of the four is a config error, as any other field.
  assert.throws(() => normalizeConfig(baseConfig({ history: { days: 0 } })), /"history" must be/);
  assert.throws(() => normalizeConfig(baseConfig({ history: { from: '2025-02-30' } })), /"history" must be/);
});

test('all history loads the newest days first up to the limit, and says which days it loaded', async () => {
  const files = [
    { day: day(0), size: 100 },
    { day: day(-2), size: 300 },
    { day: day(-40), size: 300 },
    { day: day(-300), size: 5 },
  ];
  const all = planWindow({ all: true }, { files, timezone: 'UTC', now: NOW, maxBytes: 450 });
  assert.equal(all.asked, day(-300));
  assert.equal(all.from, day(-39), 'from the day after the newest one left out');
  assert.equal(all.capped, true);
  assert.match(all.note, new RegExp(`^Loaded ${day(-39)} to ${WEEK.to}: the newest 0 MB of logs\\. Older days, back to ${day(-300)}, aren't loaded\\.$`));
  // Failing-path partner: with room for everything, it reaches the oldest log and says nothing.
  const room = planWindow({ all: true }, { files, timezone: 'UTC', now: NOW, maxBytes: 10000 });
  assert.deepEqual([room.from, room.capped, room.note], [day(-300), false, null]);
  // A shorter choice is held to the same limit, and today always loads.
  assert.deepEqual(planWindow({ days: 7 }, { files, timezone: 'UTC', now: NOW, maxBytes: 150 }).from, day(-1), 'the day left out is the 300-byte one; the empty day after it loads');
  assert.equal(planWindow({ days: 7 }, { files, timezone: 'UTC', now: NOW, maxBytes: 50 }).from, day(-1), 'today always loads, even over the limit');
  assert.equal(MAX_LOG_BYTES, 500 * 1024 * 1024);
  // Through view: all history starts on the oldest log's day, read from file times only.
  const dir = project('all', baseConfig({ history: { all: true } }));
  const old = join(w.roots.claude[0], 'old-project');
  mkdirSync(old, { recursive: true });
  const f = join(old, 'old-session.jsonl');
  writeFileSync(f, '\n');
  const t = new Date(NOW - 90 * 86400000);
  utimesSync(f, t, t);
  const r = await view(dir);
  assert.equal(r.handle.window.from, day(-90));
});

// ---- Settings ------------------------------------------------------------------------------

test('Settings rewrites only what was changed: everything else stays byte for byte', async () => {
  const cfg = baseConfig();
  const dir = project('edit', cfg);
  const s = await view(dir);
  const base = await untouched(s);
  // Nothing touched: nothing to save, nothing written.
  assert.deepEqual((await post(s, 'preview', base)).json.changes, []);
  assert.equal((await post(s, 'save', base)).json.saved, false);
  assert.equal(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'), text(cfg));

  // How far back and one role: the preview names both, and the file changes in exactly those.
  const changed = { ...base, history: { days: 30 }, repos: base.repos.map((r, i) => (i === 1 ? { ...r, role: 'reference' } : r)) };
  const prev = await post(s, 'preview', changed);
  assert.equal(prev.status, 200, prev.text);
  assert.deepEqual(prev.json.changes, ['How far back: the last 7 days to the last 30 days.', `${cfg.repos[1].label}: ${cfg.repos[1].role} to reference.`]);
  const saved = await post(s, 'save', changed);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.saved, true);
  const want = { ...cfg, repos: cfg.repos.map((r, i) => (i === 1 ? { ...r, role: 'reference' } : r)), history: { days: 30 } };
  const now = readFileSync(join(dir, 'honestweek.config.json'), 'utf8');
  assert.equal(now, text(want));
  for (const k of ['identity', 'week', 'redaction', 'curation', 'privacy', 'output']) assert.ok(now.includes(JSON.stringify({ [k]: cfg[k] }, null, 2).slice(2, -2)), `${k} is byte for byte as it was`);
  assert.deepEqual(JSON.parse(now).redaction.codenames, ['zeta', 'alpha'], 'a list keeps its order');
  // The same server reloads with the new window.
  const st = await ready(s);
  assert.equal(st.window.from, day(-29));
  assert.match(s.out(), /saved honestweek\.config\.json; now serving/);
  // A second change starts from the new file: its version moved on.
  const again = await untouched(s);
  assert.notEqual(again.version, base.version);
  const more = await post(s, 'save', { ...again, authorEmails: ['you@example.com', 'you@work.example.com'] });
  assert.equal(more.status, 200, more.text);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'honestweek.config.json'), 'utf8')).identity, { authorEmails: ['you@example.com', 'you@work.example.com'] });
});

test('every failure path is refused and writes nothing', async () => {
  const dir = project('refuse');
  const s = await view(dir);
  const base = await untouched(s);
  const before = readFileSync(join(dir, 'honestweek.config.json'), 'utf8');
  const listing = readdirSync(dir).sort();
  const good = JSON.stringify({ ...base, history: { days: 30 } });
  for (const [what, opts, status] of [
    ['no key', { key: null }, 403],
    ['a wrong key', { key: 'f'.repeat(64) }, 403],
    ['another host', { host: 'example.com' }, 403],
    ['another site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
  ]) {
    for (const route of ['preview', 'save']) assert.equal((await post(s, route, good, opts)).status, status, `${what} on ${route}`);
  }
  assert.equal((await call(s.port, { path: '/api/settings', key: s.key, host: 'example.com' })).status, 403);
  assert.equal((await call(s.port, { path: '/api/settings/save', key: s.key })).status, 405, 'GET instead of POST');
  for (const [what, body, status, message] of [
    ['not JSON', '{ "repos": [', 400, /isn't valid JSON/],
    ['an unknown field', { ...base, configPath: join(scratch, 'elsewhere.json') }, 400, /fields this page doesn't take/],
    ['an old version', { ...base, version: 'x'.repeat(32), history: { days: 30 } }, 409, /changed since this page opened/],
    ['a bad window', { ...base, history: { days: 0 } }, 400, /How far back/],
    ['a bad index', { ...base, repos: [{ index: 99, role: 'featured' }] }, 400, /doesn't name one of the listed/],
    ['an index twice', { ...base, repos: [base.repos[0], base.repos[0]] }, 400, /doesn't name one of the listed/],
    ['no repositories', { ...base, repos: [] }, 400, /at least one repository/],
    ['a new folder that is not there', { ...base, repos: [...base.repos, { path: join(scratch, 'nowhere'), role: 'featured' }] }, 400, /There's no folder/],
    ['a bad email', { ...base, authorEmails: ['nope'] }, 400, /doesn't look like an email/],
    ['a missing goal list', { ...base, goalsFile: 'nope.json' }, 400, /no goal list at/],
  ]) {
    const r = await post(s, 'save', body);
    assert.equal(r.status, status, `${what}: ${r.text}`);
    assert.match(r.json.message, message, what);
  }
  const big = await post(s, 'save', JSON.stringify({ ...base, terms: 'x'.repeat(SETUP_MAX_BODY) }));
  assert.equal(big.status, 413);
  // A file changed on disk after the page opened is never overwritten.
  const edited = `${before.trimEnd()}\n`.replace('"my.digest.md"', '"edited.md"');
  writeFileSync(join(dir, 'honestweek.config.json'), edited);
  const stale = await post(s, 'save', JSON.parse(good));
  assert.equal(stale.status, 409);
  assert.equal(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'), edited);
  writeFileSync(join(dir, 'honestweek.config.json'), before);
  assert.equal(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(dir).sort(), listing, 'no other file written');
  // A config named with --config may sit outside the start folder, so Settings won't change it.
  const elsewhere = project('elsewhere');
  const named = await view(join(scratch, 'refuse'), ['--config', join(elsewhere, 'honestweek.config.json')]);
  const ni = (await call(named.port, { path: '/api/settings', key: named.key })).json;
  assert.equal(ni.editable, false);
  assert.match(ni.note, /--config/);
  assert.equal((await post(named, 'save', good)).status, 409);
});

test('new private words hide text on the next page load with the switch off, cached answers included', async () => {
  const dir = project('words');
  const s = await view(dir, ['--from', WEEK.from, '--to', WEEK.to]);
  await ready(s);
  const paths = ['/api/home', '/api/replay', `/api/words?q=report`];
  const shown = async () => {
    const all = [];
    for (const p of paths) all.push(JSON.stringify((await call(s.port, { path: p, key: s.key })).json));
    return all.join('\n');
  };
  assert.ok((await shown()).includes(TERM), `${TERM} shows while it isn't a private word`);
  const base = await untouched(s);
  const r = await post(s, 'save', { ...base, terms: `${base.terms}, ${TERM}` });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.changes, ['Client or project words: 1 added.']);
  assert.equal((await ready(s)).state, 'ready');
  assert.ok(!(await shown()).includes(TERM), `${TERM} is hidden on every answer after the save`);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^honestweek\.config\.json$/m);
});

test('a repository switched to display stops being read by git at once, and the old build runs no more git', async () => {
  const cp = createRequire(import.meta.url)('node:child_process');
  const real = cp.execFileSync;
  const seen = [];
  cp.execFileSync = function (file, args, ...rest) {
    if (file === 'git') seen.push((args ?? []).join(' ').toLowerCase());
    return real.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const cfg = baseConfig();
    const target = cfg.repos.findIndex((r) => r.role !== 'display');
    const repoPath = cfg.repos[target].path.toLowerCase();
    const s = await view(project('to-display', cfg), ['--from', WEEK.from, '--to', WEEK.to]);
    await ready(s);
    // Failing-path partner: while it's featured, the build asks git about it.
    assert.ok(seen.some((c) => c.includes(repoPath)), 'git read the repository while it was featured');
    const base = await untouched(s);
    seen.length = 0;
    const r = await post(s, 'save', { ...base, repos: base.repos.map((x, i) => (i === target ? { ...x, role: 'display' } : x)) });
    assert.equal(r.status, 200, r.text);
    assert.equal((await ready(s)).state, 'ready');
    await call(s.port, { path: '/api/lookup?q=%2312', key: s.key });
    assert.deepEqual(seen.filter((c) => c.includes(repoPath)), [], 'no git read of it after the switch');

    // The engine's stop: a build stopped before its git step throws and runs no git.
    seen.length = 0;
    const signal = { aborted: false };
    const build = buildWorkHistory({ config: normalizeConfig(cfg), roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', scope: 'all', signal });
    signal.aborted = true;
    await assert.rejects(build, /the build was stopped/);
    assert.deepEqual(seen, [], 'a stopped build runs no git');
  } finally {
    cp.execFileSync = real;
    syncBuiltinESMExports();
  }
});
