// Which config a command reads, wherever it runs (issue 177): --config, then this folder's
// honestweek.config.json, then HONESTWEEK_CONFIG, then ~/.honestweek/honestweek.config.json. The
// lookup itself is checked directly, and through the real entry point the way a person types it,
// from a folder that has nothing to do with the config: each step finds the right file, names it
// on stderr, and a command that writes files writes them beside that config, never in the folder
// it ran in. Home folders, git and the log folders are all temporary ones of the test's own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { commandConfig, configAgain, configLine, findConfig, setConfigLookup, takeConfigFlag, userConfigPath } from '../lib/config-lookup.mjs';
import { createSetup } from '../lib/view/setup.mjs';
import { createSettings } from '../lib/view/settings.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'honestweek.mjs');
const scratch = makeTempDir('hw-config-lookup-');
after(() => setConfigLookup(null));

const gitconfig = join(scratch, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\temail = you@example.com\n\tname = You\n[commit]\n\tgpgsign = false\n');
const emptyLogs = join(scratch, 'no-logs');
mkdirSync(emptyLogs);
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });

/** A git repository with one commit, for a config to list. */
const repo = join(scratch, 'your-project');
mkdirSync(repo);
git(repo, ['init', '-q']);
writeFileSync(join(repo, 'readme.txt'), 'hi');
git(repo, ['add', '-A']);
git(repo, ['commit', '-q', '-m', 'first']);

const CONFIG = {
  identity: { authorEmails: ['you@example.com'] },
  week: { startsOn: 'monday', timezone: 'UTC' },
  repos: [{ path: repo, label: 'your-project', role: 'featured' }],
  redaction: { codenames: [], names: [], terms: [] },
  output: { mode: 'digest', file: 'honestweek.digest.md' },
};

let n = 0;
/** A fresh, empty folder under the scratch folder. */
function folder(name) {
  const dir = join(scratch, `${name}-${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** A folder holding a config, and that config's path. */
function configIn(name, at = folder(name)) {
  mkdirSync(at, { recursive: true });
  const path = join(at, 'honestweek.config.json');
  writeFileSync(path, `${JSON.stringify(CONFIG, null, 2)}\n`);
  return path;
}

/** Run the CLI from `cwd` with its own home folder and empty logs. */
function cli(args, { cwd, home, env = {} }) {
  const base = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CONFIG_DIR: emptyLogs, CODEX_HOME: emptyLogs };
  delete base.HONESTWEEK_CONFIG;
  for (const k of Object.keys(base)) if (/^npm_/i.test(k)) delete base[k];
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...base, ...env }, encoding: 'utf8', input: '', timeout: 60e3 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const userConfigUnder = (home) => configIn('user', join(home, '.honestweek'));

// ---- the lookup itself -----------------------------------------------------------------------

test('the lookup goes --config, this folder, HONESTWEEK_CONFIG, then the user-level file', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const named = configIn('named');
  const viaEnv = configIn('env');
  const here = folder('here');
  const lookup = { env: { HONESTWEEK_CONFIG: viaEnv }, home };

  // Nothing here: the environment variable answers, then the user-level file.
  assert.deepEqual(findConfig({ cwd: here, lookup }), { path: viaEnv, dir: dirname(viaEnv), source: 'env', exists: true });
  assert.deepEqual(findConfig({ cwd: here, lookup: { env: {}, home } }), { path: user, dir: dirname(user), source: 'user', exists: true });
  // A config here wins over both, and keeps the folder exactly as given.
  configIn('here', here);
  assert.deepEqual(findConfig({ cwd: here, lookup }), { path: join(here, 'honestweek.config.json'), dir: here, source: 'folder', exists: true });
  // --config wins over everything.
  assert.equal(findConfig({ cwd: here, flag: named, lookup }).path, named);
  assert.equal(findConfig({ cwd: here, flag: named, lookup }).source, 'flag');
  // A relative --config is read against the folder it runs in.
  assert.equal(findConfig({ cwd: dirname(named), flag: 'honestweek.config.json', lookup }).dir, dirname(named));
});

test('a named file that is missing stops the lookup rather than falling through to another config', () => {
  const home = folder('home');
  userConfigUnder(home);
  const here = folder('here');
  const gone = join(folder('gone'), 'honestweek.config.json');
  const viaEnv = findConfig({ cwd: here, lookup: { env: { HONESTWEEK_CONFIG: gone }, home } });
  assert.deepEqual([viaEnv.source, viaEnv.exists, viaEnv.path], ['env', false, gone]);
  const viaFlag = findConfig({ cwd: here, flag: gone, lookup: { env: {}, home } });
  assert.deepEqual([viaFlag.source, viaFlag.exists], ['flag', false]);
  // An empty variable counts as unset.
  assert.equal(findConfig({ cwd: here, lookup: { env: { HONESTWEEK_CONFIG: '  ' }, home } }).source, 'user');
});

test('with the lookup off (a library caller, a scheduled run) only this folder is read', () => {
  const home = folder('home');
  userConfigUnder(home);
  const here = folder('here');
  setConfigLookup(null);
  const found = findConfig({ cwd: here });
  assert.deepEqual(found, { path: join(here, 'honestweek.config.json'), dir: here, source: 'none', exists: false });
  // And it says nothing on stderr, so a library caller's output stays as it was.
  const said = [];
  const opened = commandConfig({ command: 'discover', cwd: here, argv: [], err: (s) => said.push(s) });
  assert.equal(opened.cwd, here);
  assert.deepEqual(said, []);
});

test('--config is taken out of the arguments in either spelling, and a missing value or a repeat is refused', () => {
  assert.deepEqual(takeConfigFlag(['prepare', '--config', 'a.json', '--week', '2026-W40']), { config: 'a.json', argv: ['prepare', '--week', '2026-W40'] });
  assert.deepEqual(takeConfigFlag(['--config=b.json']), { config: 'b.json', argv: [] });
  assert.equal(takeConfigFlag(['--config']).error, '--config needs a file.');
  assert.equal(takeConfigFlag(['--config', '--week']).error, '--config needs a file.');
  assert.equal(takeConfigFlag(['--config=a', '--config', 'b']).error, '--config is given twice.');
});

test('the stderr line names the config and why, and where files go when that is another folder', () => {
  const here = folder('here');
  const away = configIn('away');
  assert.equal(configLine('build', { path: join(here, 'honestweek.config.json'), dir: here, source: 'folder' }, { cwd: here, writes: true }), `honestweek build: config ${join(here, 'honestweek.config.json')} (in this folder).\n`);
  assert.equal(configLine('discover', { path: away, dir: dirname(away), source: 'user' }, { cwd: here, writes: true }), `honestweek discover: config ${away} (your user-level config). Files it writes go in ${dirname(away)}.\n`);
  assert.equal(configLine('preview', { path: away, dir: dirname(away), source: 'env' }, { cwd: here, writes: false }), `honestweek preview: config ${away} (named by HONESTWEEK_CONFIG).\n`);
  assert.equal(configLine('view', { path: here, dir: here, source: 'none' }, { cwd: here }), '');
});

test('the user-level file is ~/.honestweek/honestweek.config.json', () => {
  assert.equal(userConfigPath(join('h', 'me')), join('h', 'me', '.honestweek', 'honestweek.config.json'));
});

// ---- through the real entry point ------------------------------------------------------------

test('discover from an unrelated folder reads the user-level config and writes its draft beside it', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const unrelated = folder('unrelated');
  const r = cli(['discover'], { cwd: unrelated, home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`config .*\\.honestweek.honestweek\\.config\\.json \\(your user-level config\\)\\. Files it writes go in `));
  assert.equal(r.err.split('\n').filter((l) => l.startsWith('honestweek discover: config')).length, 1, 'one line');
  assert.ok(existsSync(join(dirname(user), 'honestweek.draft.json')), 'the draft is beside the config');
  assert.match(readFileSync(join(dirname(user), '.gitignore'), 'utf8'), /honestweek\.draft\.json/);
  assert.deepEqual(readdirSync(unrelated), [], 'nothing in the folder it ran in');
});

test('HONESTWEEK_CONFIG answers before the user-level file, and the draft goes beside the file it names', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const named = configIn('named');
  const unrelated = folder('unrelated');
  const r = cli(['discover'], { cwd: unrelated, home, env: { HONESTWEEK_CONFIG: named } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /\(named by HONESTWEEK_CONFIG\)/);
  assert.ok(existsSync(join(dirname(named), 'honestweek.draft.json')));
  assert.ok(!existsSync(join(dirname(user), 'honestweek.draft.json')), 'the user-level folder is untouched');
  assert.deepEqual(readdirSync(unrelated), []);
});

test('a config in the folder it runs in wins over HONESTWEEK_CONFIG and the user-level file, as it always has', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const named = configIn('named');
  const here = folder('here');
  configIn('here', here);
  const r = cli(['discover'], { cwd: here, home, env: { HONESTWEEK_CONFIG: named } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /\(in this folder\)\.\n/);
  assert.doesNotMatch(r.err, /Files it writes go in/);
  assert.ok(existsSync(join(here, 'honestweek.draft.json')));
  for (const other of [named, user]) assert.ok(!existsSync(join(dirname(other), 'honestweek.draft.json')));
});

test('--config wins over every other step, and its folder gets the files', () => {
  const home = folder('home');
  userConfigUnder(home);
  const named = configIn('named');
  const here = folder('here');
  configIn('here', here);
  const r = cli(['discover', '--config', named], { cwd: here, home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /\(named with --config\)/);
  assert.ok(existsSync(join(dirname(named), 'honestweek.draft.json')));
  assert.ok(!existsSync(join(here, 'honestweek.draft.json')));
});

test('a HONESTWEEK_CONFIG that names no file is an error that writes nothing, never a fall through', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const unrelated = folder('unrelated');
  const gone = join(folder('gone'), 'honestweek.config.json');
  const r = cli(['discover'], { cwd: unrelated, home, env: { HONESTWEEK_CONFIG: gone } });
  assert.equal(r.code, 1);
  assert.match(r.err, /named by HONESTWEEK_CONFIG/);
  assert.match(r.err, /file not found at/);
  assert.ok(!existsSync(join(dirname(user), 'honestweek.draft.json')));
  assert.deepEqual(readdirSync(unrelated), []);
});

test('with no config anywhere, discover fails as it always has and writes nothing', () => {
  const home = folder('home');
  const unrelated = folder('unrelated');
  const r = cli(['discover'], { cwd: unrelated, home });
  assert.equal(r.code, 1);
  assert.match(r.err, /file not found at/);
  assert.doesNotMatch(r.err, /: config /);
  assert.deepEqual(readdirSync(unrelated), []);
});

test('harvest and history follow the same config, reading and writing beside it', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const unrelated = folder('unrelated');
  assert.equal(cli(['discover'], { cwd: unrelated, home }).code, 0);
  const h = cli(['harvest'], { cwd: unrelated, home });
  assert.equal(h.code, 0, h.err);
  assert.ok(existsSync(join(dirname(user), 'honestweek.harvest.json')));
  const y = cli(['history', '--from', '2025-01-01', '--to', '2025-01-02'], { cwd: unrelated, home });
  assert.equal(y.code, 0, y.err);
  assert.ok(existsSync(join(dirname(user), 'honestweek.history.json')));
  assert.deepEqual(readdirSync(unrelated), []);
});

test('validate and build read the items beside the config, and say so when they are missing there', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const unrelated = folder('unrelated');
  for (const cmd of ['validate', 'build']) {
    const r = cli([cmd], { cwd: unrelated, home });
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, new RegExp(`honestweek ${cmd}: config `));
    assert.ok(r.err.includes(`not found in ${dirname(user)}`), r.err);
  }
  assert.deepEqual(readdirSync(unrelated), []);
});

test('mine keeps its ledger beside the config it read', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const unrelated = folder('unrelated');
  const r = cli(['mine', '--json', '--corpus', 'claude-code'], { cwd: unrelated, home });
  assert.match(r.err, /honestweek mine: config .*\(your user-level config\)/);
  assert.ok(existsSync(join(dirname(user), 'honestweek.findings.json')), r.err);
  assert.deepEqual(readdirSync(unrelated), []);
});

test('prompts keeps its private inbox beside the config it read', () => {
  const home = folder('home');
  const user = userConfigUnder(home);
  const unrelated = folder('unrelated');
  const r = cli(['prompts', 'sync'], { cwd: unrelated, home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /honestweek prompts: config .*\(your user-level config\)\. Files it writes go in /);
  assert.ok(existsSync(join(dirname(user), 'honestweek.prompts.json')), r.err);
  assert.match(readFileSync(join(dirname(user), '.gitignore'), 'utf8'), /honestweek\.prompts\.json/);
  assert.deepEqual(readdirSync(unrelated), []);
});

test('init --user writes the user-level config, with no example file, and other commands then find it', () => {
  const home = folder('home');
  const root = folder('init-user');
  const work = join(root, 'your-project');
  mkdirSync(work);
  git(work, ['init', '-q']);
  writeFileSync(join(work, 'a.txt'), 'a');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'first']);
  const r = cli(['init', '--user', '--yes'], { cwd: work, home });
  assert.equal(r.code, 0, r.err);
  const written = join(home, '.honestweek', 'honestweek.config.json');
  assert.ok(existsSync(written), r.out);
  assert.ok(!existsSync(join(home, '.honestweek', 'honestweek.config.example.json')));
  assert.deepEqual(readdirSync(work).sort(), ['.git', 'a.txt'], 'nothing in the folder init ran in');
  const unrelated = folder('unrelated');
  const d = cli(['discover'], { cwd: unrelated, home });
  assert.equal(d.code, 0, d.err);
  assert.match(d.err, /\(your user-level config\)/);
});

test('init --config writes the named file, and refuses one with another name or no folder', () => {
  const home = folder('home');
  const work = join(folder('init-named'), 'your-project');
  mkdirSync(work);
  git(work, ['init', '-q']);
  const there = folder('there');
  const ok = cli(['init', '--yes', '--config', join(there, 'honestweek.config.json')], { cwd: work, home });
  assert.equal(ok.code, 0, ok.err);
  assert.ok(existsSync(join(there, 'honestweek.config.json')));
  assert.ok(!existsSync(join(work, 'honestweek.config.json')));
  const badName = cli(['init', '--yes', '--config', join(there, 'team.json')], { cwd: work, home });
  assert.equal(badName.code, 1);
  assert.match(badName.err, /must name a file called honestweek\.config\.json/);
  const noFolder = cli(['init', '--yes', '--config', join(there, 'missing', 'honestweek.config.json')], { cwd: work, home });
  assert.equal(noFolder.code, 1);
  assert.match(noFolder.err, /there's no folder at/);
  const both = cli(['init', '--yes', '--user', '--config', join(there, 'honestweek.config.json')], { cwd: work, home });
  assert.equal(both.code, 1);
  assert.ok(!existsSync(join(home, '.honestweek')), 'nothing written for a refusal');
});

// ---- Setup ----------------------------------------------------------------------------------

test('Setup saves to the user-level folder when asked, and writes nothing in the folder view started in', async () => {
  const home = folder('home');
  const userConfig = join(home, '.honestweek', 'honestweek.config.json');
  const start = folder('setup-start');
  const s = createSetup({ cwd: start, userConfig, inferEmail: () => 'you@example.com', onSaved: async () => ({ next: 'problems.html' }) });
  assert.equal(s.info().userConfig, resolve(userConfig));
  const answers = { authorEmails: ['you@example.com'], timezone: 'UTC', repos: [{ path: repo, label: 'your-project', role: 'featured' }], names: '', terms: '', saveTo: 'user' };
  const p = s.preview(JSON.stringify(answers));
  assert.equal(p.status, 200);
  assert.ok(p.body.notes.some((x) => x.includes(userConfig)), p.body.notes.join(' | '));
  const saved = await s.save(JSON.stringify(answers));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(existsSync(userConfig));
  assert.ok(!existsSync(join(dirname(userConfig), 'honestweek.config.example.json')));
  assert.match(readFileSync(join(dirname(userConfig), '.gitignore'), 'utf8'), /honestweek\.config\.json/);
  assert.match(saved.body.written, new RegExp(`in ${dirname(userConfig).replace(/[\\.]/g, '\\$&')}\\.$`));
  assert.deepEqual(readdirSync(start), []);
});

test('Setup refuses the user-level choice when this run would never read that file', () => {
  const start = folder('setup-closed');
  const s = createSetup({ cwd: start, inferEmail: () => 'you@example.com' });
  assert.equal(s.info().userConfig, undefined);
  const r = s.preview(JSON.stringify({ authorEmails: ['you@example.com'], timezone: 'UTC', repos: [{ path: repo, role: 'featured' }], saveTo: 'user' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'saveTo');
  assert.deepEqual(readdirSync(start), []);
});

// ---- display-only folders across configs (AGENTS.md invariant 4) ------------------------------

/** A path as the file system names it (macOS keeps temporary folders behind a link), compared
 *  without case, so a written path and the one a test made match on every system. */
const real = (p) => realpathSync.native(p).toLowerCase();

/** A folder of two git repositories side by side, and a config marking one of them display-only. */
function besideAClientRepo(name) {
  const root = folder(name);
  const work = join(root, 'your-project');
  const client = join(root, 'a-client-repo');
  for (const dir of [work, client]) {
    mkdirSync(dir);
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, 'a.txt'), 'a');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'first']);
  }
  const marking = { ...CONFIG, repos: [{ path: client, label: 'a-private-project', role: 'display' }] };
  return { root, work, client, marking };
}

test('plain init keeps the display-only folders of the user-level config every command here reads', () => {
  const home = folder('home');
  const { work, client, marking } = besideAClientRepo('init-around');
  mkdirSync(join(home, '.honestweek'));
  writeFileSync(join(home, '.honestweek', 'honestweek.config.json'), `${JSON.stringify(marking, null, 2)}\n`);
  const r = cli(['init', '--yes'], { cwd: work, home });
  assert.equal(r.code, 0, r.err);
  const written = JSON.parse(readFileSync(join(work, 'honestweek.config.json'), 'utf8'));
  const entry = written.repos.find((x) => real(x.path) === real(client));
  assert.equal(entry?.role, 'display', JSON.stringify(written.repos));
});

test('plain init runs git nowhere when the user-level config can\'t be read', () => {
  const home = folder('home');
  const { work } = besideAClientRepo('init-unreadable');
  mkdirSync(join(home, '.honestweek'));
  writeFileSync(join(home, '.honestweek', 'honestweek.config.json'), '{ not json');
  const r = cli(['init', '--yes'], { cwd: work, home });
  assert.equal(r.code, 1);
  assert.match(r.err, /can't be read \(not valid JSON\)/);
  assert.ok(!existsSync(join(work, 'honestweek.config.json')));
});

test('Settings, editing a config in another folder, never asks git about a folder the config where view started marks display-only', () => {
  const { work, client, marking } = besideAClientRepo('settings-around');
  writeFileSync(join(work, 'honestweek.config.json'), `${JSON.stringify(marking, null, 2)}\n`);
  const elsewhere = configIn('settings-elsewhere');
  const asked = [];
  const spy = (path) => { asked.push(real(path)); return null; };
  const s = createSettings({ cwd: work, configDir: () => dirname(elsewhere), hasCommits: spy, lastCommitAt: spy });
  const f = s.found();
  assert.equal(f.editable, true, f.note);
  assert.ok(!asked.includes(real(client)), asked.join(', '));
  assert.ok(!f.repos.some((x) => real(x.path) === real(client)));
  assert.match(createSettings({ cwd: work, configDir: () => folder('settings-empty') }).info().note, /There's no honestweek\.config\.json in .*settings-empty/);
});

test('init writing elsewhere runs git nowhere when the config where it started can\'t be read', () => {
  const home = folder('home');
  const { work } = besideAClientRepo('init-start-unreadable');
  writeFileSync(join(work, 'honestweek.config.json'), '{ not json');
  const there = folder('there');
  for (const args of [['init', '--yes', '--user'], ['init', '--yes', '--config', join(there, 'honestweek.config.json')]]) {
    const r = cli(args, { cwd: work, home });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /can't be read \(not valid JSON\)/);
  }
  assert.ok(!existsSync(join(home, '.honestweek')));
  assert.deepEqual(readdirSync(there), []);
});

test('Settings asks git nothing when the config where view started can\'t be read', () => {
  const { work } = besideAClientRepo('settings-unreadable');
  writeFileSync(join(work, 'honestweek.config.json'), '{ not json');
  const elsewhere = configIn('settings-elsewhere');
  const asked = [];
  const spy = (path) => { asked.push(path); return null; };
  const f = createSettings({ cwd: work, configDir: () => dirname(elsewhere), hasCommits: spy, lastCommitAt: spy }).found();
  assert.equal(f.editable, false);
  assert.match(f.note, /can't be read/);
  assert.deepEqual(asked, []);
});

test('a printed next command repeats --config as it was given', () => {
  assert.deepEqual(configAgain(undefined), []);
  assert.deepEqual(configAgain('honestweek.config.json'), ['--config', 'honestweek.config.json']);
  assert.deepEqual(configAgain('my folder/honestweek.config.json'), ['--config', '"my folder/honestweek.config.json"']);
});
