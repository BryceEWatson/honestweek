// The Setup page's routes (lib/view/setup.mjs behind lib/view/server.mjs): `honestweek view` in a
// folder with no config serves Setup, and saving writes the config with init's own functions,
// then goes on to the week on the same server. Every failure path writes nothing. Each run has
// its own temporary tree whose parent holds only that tree, so discovery's scan stays small,
// and the log folders are empty temporary ones, never the machine's own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { runView } from '../lib/view.mjs';
import { buildConfig, writeInitFiles } from '../lib/init.mjs';
import { CODE_HEADER, KEY_HEADER } from '../lib/view/server.mjs';
import { SETUP_MAX_BODY } from '../lib/view/setup.mjs';

const scratch = makeTempDir('hw-view-setup-');
const running = [];
after(async () => {
  for (const h of running) await h.stop();
  removeTempDir(scratch);
});

const ME = 'you@example.com';
const noLogs = join(scratch, 'no-logs');
mkdirSync(noLogs);
const ENV = { CLAUDE_CONFIG_DIR: noLogs, CODEX_HOME: noLogs };
const git = (dir, args) => execFileSync('git', ['-C', dir, '-c', `user.email=${ME}`, '-c', 'user.name=You', '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

/** <root>/{my project (a repo, where view runs), side (a repo), client (a repo)}: names with a space. */
function tree(name) {
  const root = join(scratch, name);
  const dirs = { project: join(root, 'my project'), side: join(root, 'side'), client: join(root, 'client') };
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, 'readme.txt'), 'made up');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'first']);
  }
  return { root, ...dirs };
}

/** Every file under `dir` but git's own, as relative paths: what a failure must leave alone. */
function files(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

function call(port, { method = 'GET', path, key, body = null, host = `127.0.0.1:${port}`, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, setHost: false, agent: false, headers: { host, ...(key ? { [KEY_HEADER]: key } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** `honestweek view` in the tree's project folder, with no config there yet, and this run's key. */
async function setupRun(name) {
  const t = tree(name);
  const out = [];
  const err = [];
  let handle = null;
  const code = await runView({ argv: ['--no-open'], cwd: t.project, env: ENV, io: { out: (s) => out.push(s), err: (s) => err.push(s) }, input: null, block: false, inferEmail: () => ME, onServe: (h) => (handle = h) });
  assert.equal(code, 0, err.join(''));
  running.push(handle);
  const code1 = /#c=([0-9a-f]+)/.exec(handle.address('printed'))[1];
  const key = (await call(handle.port, { path: '/api/claim', headers: { [CODE_HEADER]: code1 } })).json.key;
  return { ...t, handle, port: handle.port, key, out: () => out.join(''), err: () => err.join('') };
}

const answers = (t, more = {}) => ({
  authorEmails: [ME, 'you@work.example.com'],
  timezone: 'UTC',
  repos: [
    { path: t.project, label: 'my project', role: 'featured' },
    { path: t.side, label: 'side', role: 'reference' },
  ],
  names: 'Dana Doe, Sam Lee',
  terms: 'Acme',
  ...more,
});
const post = (s, route, body, more = {}) => call(s.port, { method: 'POST', path: `/api/setup/${route}`, key: s.key, body: typeof body === 'string' ? body : JSON.stringify(body), ...more });

test('a successful setup: the proposal, a preview, then Save writes the config with init and goes on to the week without a restart', async () => {
  const s = await setupRun('ok');
  const info = await call(s.port, { path: '/api/setup', key: s.key });
  assert.equal(info.status, 200);
  assert.equal(info.json.configured, false);
  assert.deepEqual(info.json.repos.map((r) => [r.label, r.role]), [['my project', 'featured'], ['client', 'featured'], ['side', 'featured']], "the project first, then the repos next to it, each featured because you've committed there");
  assert.deepEqual(info.json.authorEmails, [ME]);
  assert.deepEqual(info.json.roles.map((r) => r.role), ['featured', 'reference', 'display']);
  assert.match(info.json.privateWords.intro, /^Private words: honestweek hides these/);
  assert.doesNotMatch(info.json.privateWords.names, /Enter/, 'a label, not a terminal question');

  const status0 = await call(s.port, { path: '/api/status', key: s.key });
  assert.equal(status0.json.setup, true, 'every other page is sent to Setup');

  const prev = await post(s, 'preview', answers(s));
  assert.equal(prev.status, 200, prev.text);
  assert.deepEqual(files(s.project), ['readme.txt'], 'preview writes nothing');
  const saved = await post(s, 'save', answers(s));
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.saved, true);
  assert.equal(saved.json.next, 'search.html');
  assert.equal(saved.json.restart, undefined, 'no restart');

  const written = readFileSync(join(s.project, 'honestweek.config.json'), 'utf8');
  assert.equal(written, prev.json.text, 'the file is the preview, byte for byte');
  // The same bytes init's own functions write for these answers.
  const twin = makeTempDir('hw-view-setup-twin-');
  writeInitFiles(twin, buildConfig({ authorEmails: [ME, 'you@work.example.com'], timezone: 'UTC', repos: answers(s).repos, names: ['Dana Doe', 'Sam Lee'], terms: ['Acme'], history: { days: 7 } }), { force: true });
  assert.equal(written, readFileSync(join(twin, 'honestweek.config.json'), 'utf8'));
  assert.equal(readFileSync(join(s.project, '.gitignore'), 'utf8'), readFileSync(join(twin, '.gitignore'), 'utf8'));
  assert.match(readFileSync(join(s.project, '.gitignore'), 'utf8'), /^honestweek\.config\.json$/m, 'a config with private words stays out of git');

  // The same server, the same key, now the week.
  let st;
  for (let i = 0; i < 400; i++) {
    st = (await call(s.port, { path: '/api/status', key: s.key })).json;
    if (st.state !== 'building' && !st.setup) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(st.setup, undefined);
  assert.equal(st.state, 'ready', st.failed ?? '');
  assert.match(s.out(), /saved honestweek\.config\.json; now serving \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
  // Private words reach only the config file: never the terminal.
  for (const w of ['Dana Doe', 'Sam Lee', 'Acme']) assert.ok(!s.out().includes(w) && !s.err().includes(w), `${w} never reaches the terminal`);
  // After saving, setup is over: a second save changes nothing.
  const again = await post(s, 'save', answers(s, { names: 'Someone Else' }));
  assert.equal(again.status, 409);
  assert.equal(readFileSync(join(s.project, 'honestweek.config.json'), 'utf8'), written);
  assert.match(s.handle.address('printed'), /\/#c=/, 'a fresh address now opens the week, not Setup');
});

test('a wrong or missing key, another host and another site are each refused, and nothing is written', async () => {
  const s = await setupRun('refused');
  const before = files(s.root);
  const body = JSON.stringify(answers(s));
  for (const [what, opts] of [
    ['no key', { key: null }],
    ['a wrong key', { key: 'f'.repeat(64) }],
    ['another host', { host: 'example.com' }],
    ['a rebound name', { host: `attacker.example:${s.port}` }],
    ['another site', { headers: { 'sec-fetch-site': 'cross-site' } }],
    ['a sibling site', { headers: { 'sec-fetch-site': 'same-site' } }],
  ]) {
    for (const route of ['save', 'preview']) {
      const r = await post(s, route, body, opts);
      assert.equal(r.status, 403, `${what} on ${route}: ${r.text}`);
    }
    assert.equal((await call(s.port, { path: '/api/setup', key: s.key, ...opts })).status, 403, `${what} reading the proposal`);
  }
  assert.deepEqual(files(s.root), before);
  // Failing-path partner: the same answer with the key, from this host, is saved.
  assert.equal((await post(s, 'save', body)).status, 200);
});

test('GET instead of POST is refused, and nothing is written', async () => {
  const s = await setupRun('get');
  const before = files(s.root);
  for (const route of ['save', 'preview']) {
    const r = await call(s.port, { path: `/api/setup/${route}?names=Dana`, key: s.key });
    assert.equal(r.status, 405, r.text);
  }
  assert.equal((await call(s.port, { method: 'PUT', path: '/api/setup/save', key: s.key, body: JSON.stringify(answers(s)) })).status, 405);
  assert.deepEqual(files(s.root), before);
});

test('a config that appears after the page opened is never overwritten, and nothing else is written either', async () => {
  const s = await setupRun('appeared');
  const mine = '{ "someone": "else" }\n';
  writeFileSync(join(s.project, 'honestweek.config.json'), mine);
  const before = files(s.root);
  const r = await post(s, 'save', answers(s));
  assert.equal(r.status, 409, r.text);
  assert.match(r.json.message, /already in this folder.*nothing was written or changed/);
  assert.equal(readFileSync(join(s.project, 'honestweek.config.json'), 'utf8'), mine);
  assert.deepEqual(files(s.root), before, 'no .gitignore, no example');
  assert.equal((await post(s, 'preview', answers(s))).status, 409);
  // A config that lands between the check and the write: init's write refuses it too.
  const race = makeTempDir('hw-view-setup-race-');
  writeFileSync(join(race, 'honestweek.config.json'), mine);
  assert.deepEqual(writeInitFiles(race, { repos: [] }, { onlyNew: true }), { wrote: [], skipped: ['honestweek.config.json (already exists)'] });
  assert.deepEqual(readdirSync(race), ['honestweek.config.json']);
});

test('malformed JSON, an oversized body and answers that do not fit are refused with a clear message, and nothing is written', async () => {
  const s = await setupRun('malformed');
  const before = files(s.root);
  const cases = [
    ['not JSON', '{ "repos": [', 400, /isn't valid JSON/],
    ['a list', '[]', 400, /one JSON object/],
    ['no email', answers(s, { authorEmails: [] }), 400, /at least one email/],
    ['a bad email', answers(s, { authorEmails: ['not an email'] }), 400, /doesn't look like an email/],
    ['a bad timezone', answers(s, { timezone: 'Nowhere/Else' }), 400, /isn't a timezone/],
    ['no repositories', answers(s, { repos: [] }), 400, /at least one repository/],
    ['a bad role', answers(s, { repos: [{ path: s.project, role: 'owner' }] }), 400, /featured, reference or display/],
    ['a folder twice', answers(s, { repos: [{ path: s.project, role: 'featured' }, { path: `${s.project}/`, role: 'featured' }] }), 400, /listed twice/],
    ['words not text', answers(s, { names: ['Dana'] }), 400, /plain text/],
    ['a missing goal list', answers(s, { goalsFile: 'nope.json' }), 400, /no goal list at/],
  ];
  for (const [what, body, status, message] of cases) {
    for (const route of ['preview', 'save']) {
      const r = await post(s, route, body);
      assert.equal(r.status, status, `${what} on ${route}: ${r.text}`);
      assert.match(r.json.message, message, what);
    }
  }
  const big = JSON.stringify(answers(s, { terms: 'x'.repeat(SETUP_MAX_BODY) }));
  const r = await post(s, 'save', big);
  assert.equal(r.status, 413);
  assert.match(r.json.message, /larger than 64 KB, so nothing was written/);
  assert.deepEqual(files(s.root), before);
});

test('setup only ever writes in the folder it started in: a field naming another place, or a repository that is not a folder, is refused', async () => {
  const s = await setupRun('outside');
  const before = files(s.root);
  for (const extra of [{ configPath: join(s.root, 'elsewhere.json') }, { cwd: s.root }, { output: { file: '../out.md' } }]) {
    const r = await post(s, 'save', { ...answers(s), ...extra });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.message, /fields this page doesn't take/);
  }
  const notFolder = await post(s, 'save', answers(s, { repos: [{ path: join(s.root, 'nowhere'), role: 'featured' }] }));
  assert.equal(notFolder.status, 400);
  assert.match(notFolder.json.message, /There's no folder at/);
  const notRepo = join(s.root, 'plain folder');
  mkdirSync(notRepo);
  const plain = await post(s, 'save', answers(s, { repos: [{ path: notRepo, role: 'featured' }] }));
  assert.equal(plain.status, 400);
  assert.match(plain.json.message, /isn't a git repository/);
  assert.deepEqual(files(s.root), before);
  // Failing-path partner: a relative path, written with the other separator, resolves inside
  // the start folder's parent and is saved; the files land in the start folder only.
  const ok = await post(s, 'save', answers(s, { repos: [{ path: '.', role: 'featured' }, { path: `..${process.platform === 'win32' ? '\\' : '/'}side`, role: 'reference' }] }));
  assert.equal(ok.status, 200, ok.text);
  const added = files(s.root).filter((f) => !before.includes(f));
  assert.ok(added.length > 0 && added.every((f) => f.startsWith('my project/')), added.join(', '));
  assert.deepEqual(JSON.parse(readFileSync(join(s.project, 'honestweek.config.json'), 'utf8')).repos.map((r) => r.path), [s.project, s.side]);
});

test('a repository marked display is never passed to git: not when saving, and not when the week is built after', async () => {
  // Every git command any module runs, seen through node's own child_process.
  const cp = createRequire(import.meta.url)('node:child_process');
  const real = cp.execFileSync;
  const seen = [];
  cp.execFileSync = function (file, args, ...rest) {
    if (file === 'git') seen.push((args ?? []).join(' '));
    return real.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const s = await setupRun('display');
    // Failing-path partner: before the person marks it display, discovery asks git about it.
    assert.equal((await call(s.port, { path: '/api/setup', key: s.key })).status, 200);
    const touches = (p) => seen.filter((c) => c.toLowerCase().includes(p.toLowerCase()));
    assert.ok(touches(s.client).length > 0, 'the watch sees discovery ask git about the folder');
    seen.length = 0;
    const body = answers(s, { repos: [{ path: s.project, role: 'featured' }, { path: s.client, role: 'display' }] });
    assert.equal((await post(s, 'preview', body)).status, 200);
    assert.equal((await post(s, 'save', body)).status, 200);
    let st;
    for (let i = 0; i < 400; i++) {
      st = (await call(s.port, { path: '/api/status', key: s.key })).json;
      if (st.state === 'ready' || st.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(st.state, 'ready', st.failed ?? '');
    const cfg = JSON.parse(readFileSync(join(s.project, 'honestweek.config.json'), 'utf8'));
    assert.equal(cfg.repos.find((r) => r.path === s.client).role, 'display');
    assert.deepEqual(touches(s.client), [], 'git never ran against the display repository after it was marked display');
  } finally {
    cp.execFileSync = real;
    syncBuiltinESMExports();
  }
});
