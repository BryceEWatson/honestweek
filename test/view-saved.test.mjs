// Saved results through `honestweek view` (issue 151): with "saveResults" on, the whole window's
// check results land in honestweek.saved/ beside the config once it has loaded; Settings turns
// saving on and off, sets how long days are kept, and shows what's saved; Forget deletes it all.
// With the field absent, nothing is written. Every run reads only temporary folders: the seeded
// week's logs, never the machine's own.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { runView } from '../lib/view.mjs';
import { CODE_HEADER, KEY_HEADER } from '../lib/view/server.mjs';
import { buildViewWeek, NAME, OTHER_TERM, WEEK } from './fixtures/view/week.mjs';

const scratch = makeTempDir('hw-view-saved-');
const running = [];
afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});
after(async () => {
  for (const h of running) await h.stop();
  removeTempDir(scratch);
});

const w = buildViewWeek(join(scratch, 'week'));
const ENV = { CLAUDE_CONFIG_DIR: dirname(w.roots.claude[0]), CODEX_HOME: dirname(w.roots.codex[0]) };
const NOW = Date.parse(`${WEEK.to}T12:00:00Z`);

function baseConfig(more = {}) {
  return {
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: w.config.repos.map((r) => ({ path: r.resolvedPath ?? r.path, label: r.label, role: r.role })),
    redaction: { names: [NAME], terms: [OTHER_TERM] },
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

function call(port, { method = 'GET', path, key, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, setHost: false, agent: false, headers: { host: `127.0.0.1:${port}`, ...(key ? { [KEY_HEADER]: key } : {}), ...headers } }, (res) => {
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
  const err = [];
  let handle = null;
  const code = await runView({ argv: ['--no-open', ...argv], cwd, env: ENV, io: { out: () => {}, err: (s) => err.push(s) }, input: null, block: false, now: () => NOW, onServe: (h) => (handle = h) });
  assert.equal(code, 0, err.join(''));
  running.push(handle);
  const c = /#c=([0-9a-f]+)/.exec(handle.address('printed'))[1];
  const key = (await call(handle.port, { path: '/api/claim', headers: { [CODE_HEADER]: c } })).json.key;
  return { handle, port: handle.port, key };
}
async function ready(s) {
  let st;
  for (let i = 0; i < 600; i++) {
    st = (await call(s.port, { path: '/api/status', key: s.key })).json;
    if ((st.state === 'ready' && !st.window?.partial) || st.state === 'failed') return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  return st;
}
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
const settings = async (s) => (await call(s.port, { path: '/api/settings', key: s.key })).json;
async function untouched(s) {
  const i = await settings(s);
  return { version: i.version, history: i.history, repos: i.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: i.authorEmails, names: i.names, terms: i.terms, goalsFile: i.goalsFile };
}
const post = (s, path, body) => call(s.port, { method: 'POST', path, key: s.key, body: JSON.stringify(body) });

test('with saving on, the whole window is saved once it loads, Settings shows it, and Forget deletes it', async () => {
  const dir = project('on', baseConfig({ saveResults: { on: true, keepDays: 30 } }));
  const s = await view(dir);
  assert.equal((await ready(s)).state, 'ready');
  const checks = join(dir, 'honestweek.saved', 'checks');
  assert.ok(await until(() => existsSync(checks) && readdirSync(checks).length >= 7), 'the window is saved');
  assert.ok(readdirSync(checks).every((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)));
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^honestweek\.saved\/$/m);
  const i = await settings(s);
  assert.deepEqual(i.saveResults, { on: true, keepDays: 30, history: true, defaultDays: 365, min: 1, max: 36500 });
  assert.equal(i.saved.available, true);
  assert.ok(i.saved.days >= 7 && i.saved.bytes > 0, JSON.stringify(i.saved));
  assert.equal(i.saved.error, null);
  const f = await post(s, '/api/saved/forget', {});
  assert.equal(f.status, 200, f.text);
  assert.equal(f.json.forgotten, true);
  assert.equal(existsSync(join(dir, 'honestweek.saved')), false);
  assert.deepEqual([(await settings(s)).saved.days, (await settings(s)).saved.bytes], [0, 0]);
});

test('with saveResults absent, view writes nothing beside the config', async () => {
  const cfg = baseConfig();
  const dir = project('off', cfg);
  const s = await view(dir);
  assert.equal((await ready(s)).state, 'ready');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(join(dir, 'honestweek.saved')), false);
  assert.equal(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'), text(cfg));
  const i = await settings(s);
  assert.deepEqual(i.saveResults, { on: false, keepDays: null, history: true, defaultDays: 365, min: 1, max: 36500 });
  assert.deepEqual(i.saved, { available: true, days: 0, bytes: 0, lastSavedAt: null, error: null });
});

test('Settings turns saving on with a number of days, adds the .gitignore line, and off removes the field', async () => {
  const cfg = baseConfig();
  const dir = project('toggle', cfg);
  const s = await view(dir);
  await ready(s);
  const base = await untouched(s);
  // Off and untouched is no change at all.
  assert.deepEqual((await post(s, '/api/settings/preview', { ...base, saveResults: { on: false, keepDays: null } })).json.changes, []);
  for (const bad of [{ on: true, keepDays: 0 }, { on: true, keepDays: 'soon' }, { on: 'yes' }, { on: true, keepDays: 40000 }]) {
    const r = await post(s, '/api/settings/preview', { ...base, saveResults: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const prev = await post(s, '/api/settings/preview', { ...base, saveResults: { on: true, keepDays: 90 } });
  assert.deepEqual(prev.json.changes, ["Save results between runs: on, with each day's history, kept 90 days."]);
  assert.ok(prev.json.notes.includes('Saving also adds honestweek.saved/ to .gitignore.'), JSON.stringify(prev.json.notes));
  const saved = await post(s, '/api/settings/save', { ...base, saveResults: { on: true, keepDays: 90 } });
  assert.equal(saved.json.saved, true, saved.text);
  assert.equal(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'), text({ ...cfg, saveResults: { on: true, keepDays: 90 } }));
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^honestweek\.saved\/$/m);
  // The reloaded week saves.
  await ready(s);
  assert.ok(await until(() => existsSync(join(dir, 'honestweek.saved', 'checks'))), 'the reloaded week is saved');
  // Off removes the field, so the file is what it was; what's saved stays until Forget.
  const again = await untouched(s);
  const off = await post(s, '/api/settings/save', { ...again, saveResults: { on: false, keepDays: 90 } });
  assert.deepEqual(off.json.changes, ['Save results between runs: off. What was saved stays until you press Forget saved results.']);
  assert.equal(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'), text(cfg));
  assert.ok(existsSync(join(dir, 'honestweek.saved')));
});
