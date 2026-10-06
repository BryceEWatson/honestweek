// The `honestweek view` command (lib/view.mjs): its options and setup errors, the demo,
// the addresses it opens and prints, and a restart on the same port. Every run here
// reads only temporary folders: the made-up demo week, or the seeded week with the log
// folders pointed at it, never the logs of the machine running the tests.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { HELP, parseViewPort, resolveViewWindow, runView } from '../lib/view.mjs';
import { setCommandForm } from '../lib/invocation.mjs';
import { CODE_HEADER, CODE_TTL_MS, KEY_HEADER } from '../lib/view/server.mjs';
import { createLeakCounter } from '../lib/view/leaks.mjs';
import { buildViewWeek, PRIVATE_WORDS, TERM, WEEK } from './fixtures/view/week.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = makeTempDir('hw-view-cli-');
const running = [];
after(async () => {
  for (const h of running) await h.stop();
  removeTempDir(scratch);
});

// The seeded week, with a project folder whose config names its repositories, and the
// default log folders pointed at its logs.
const w = buildViewWeek(join(scratch, 'week'));
const project = join(scratch, 'project');
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'honestweek.config.json'), JSON.stringify({ identity: { authorEmails: ['you@example.com'] }, week: { timezone: 'UTC' }, repos: w.config.repos.map((r) => ({ path: r.resolvedPath ?? r.path, label: r.label, role: r.role })), redaction: w.config.redaction }));
writeFileSync(join(project, 'goals.json'), JSON.stringify(w.goalRecord));
const ENV = { CLAUDE_CONFIG_DIR: dirname(w.roots.claude[0]), CODEX_HOME: dirname(w.roots.codex[0]) };
const RANGE = ['--from', WEEK.from, '--to', WEEK.to, '--goals', 'goals.json'];

function capture() {
  const out = [];
  const err = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out: () => out.join(''), err: () => err.join('') };
}

async function view(argv, { cwd = project, env = ENV, input = null, opener, openerTtlMs, printedTtlMs, codeClock } = {}) {
  const c = capture();
  const opened = [];
  let handle = null;
  const code = await runView({ argv, cwd, env, io: c.io, input, opener: opener ?? ((file, o) => opened.push({ file, o })), block: false, onServe: (h) => (handle = h), ...(openerTtlMs ? { openerTtlMs } : {}), ...(printedTtlMs ? { printedTtlMs } : {}), ...(codeClock ? { codeClock } : {}) });
  if (handle) running.push(handle);
  return { code, handle, out: c.out, err: c.err, opened };
}

function get(port, path, headers = {}) {
  return new Promise((res, rej) => {
    const req = request({ host: '127.0.0.1', port, path, headers, agent: false }, (r) => {
      let text = '';
      r.on('data', (c) => (text += c));
      r.on('end', () => res({ status: r.statusCode, json: text ? JSON.parse(text) : null, text }));
    });
    req.on('error', rej);
    req.end();
  });
}

const codesIn = (text) => [...text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]+)/g)].map((m) => ({ port: Number(m[1]), code: m[2] }));
async function claim(port, code) {
  const r = await get(port, '/api/claim', { [CODE_HEADER]: code });
  return r.status === 200 ? r.json.key : null;
}
async function ready(port, key) {
  for (let i = 0; i < 600; i++) {
    const s = await get(port, '/api/status', { [KEY_HEADER]: key });
    if (s.json.state !== 'building') return s.json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the build never finished');
}

// ---- help and setup errors ---------------------------------------------------------------

test('--help prints the help in the published voice and exits 0', async () => {
  const r = await view(['--help']);
  assert.equal(r.code, 0);
  assert.equal(r.out(), HELP);
  assert.match(HELP, /^Usage:/m);
  assert.match(HELP.replace(/\s+/g, ' '), /listed under "redaction" in your config, so until you list some, they show as written/, 'it says redaction hides only the words you list');
  for (const flag of ['--days', '--from', '--to', '--timezone', '--goals', '--config', '--port', '--no-open', '--demo', '--self-test']) assert.ok(HELP.includes(flag), flag);
  assert.doesNotMatch(HELP, /[—–]| -- /, 'no em or en dashes');
  assert.match(HELP, /n't|it's|you're/, 'contractions');
  assert.doesNotMatch(HELP, /\b(seamless|powerful|blazing|effortless|revolutionary|supercharge)\b/i, 'no marketing words');
});

test('with no config file, view serves the Setup page and writes nothing; a missing --config file is still an error', async () => {
  const empty = makeTempDir('hw-view-cli-empty-');
  const r = await view(['--no-open'], { cwd: empty });
  assert.equal(r.code, 0, r.err());
  assert.ok(r.handle.setup, 'setup mode');
  assert.match(r.out(), /there's no honestweek\.config\.json in .*, so setup is open in your browser/);
  assert.match(r.out(), /For scripts and CI, honestweek init still works\./);
  assert.match(r.out(), /http:\/\/127\.0\.0\.1:\d+\/setup\.html#c=/, 'the printed address opens the Setup page');
  assert.deepEqual(readdirSync(empty), []);
  // Failing path: an option that doesn't need a config is still checked before setup opens.
  const bad = await view(['--no-open', '--timezone', 'Nowhere/Else'], { cwd: makeTempDir('hw-view-cli-empty-') });
  assert.equal(bad.code, 1);
  assert.match(bad.err(), /isn't a timezone this machine knows/);
  const named = await view(['--config', 'nope.json'], { cwd: empty });
  assert.equal(named.code, 1);
  assert.match(named.err(), /no config at .*nope\.json.*honestweek view in a folder with no config.*honestweek init.*--demo/s);
});

test('the setup line names init the way the person ran honestweek', async () => {
  const empty = makeTempDir('hw-view-cli-empty-');
  setCommandForm('node bin/honestweek.mjs');
  try {
    const r = await view(['--no-open'], { cwd: empty });
    assert.equal(r.code, 0);
    assert.ok(r.out().includes('For scripts and CI, node bin/honestweek.mjs init still works.'), r.out());
    const bad = await view(['--nope'], { cwd: empty });
    assert.ok(bad.err().includes('Run node bin/honestweek.mjs view --help'), bad.err());
  } finally {
    setCommandForm('honestweek');
  }
});

test('a config with no private words gets a notice in the terminal and on every page; one with words gets none', async () => {
  const bare = join(scratch, 'bare-project');
  mkdirSync(bare, { recursive: true });
  const cfg = JSON.parse(readFileSync(join(project, 'honestweek.config.json'), 'utf8'));
  writeFileSync(join(bare, 'honestweek.config.json'), JSON.stringify({ ...cfg, redaction: { codenames: [], names: [], terms: [] } }));
  const r = await view(['--no-open', '--from', WEEK.from, '--to', WEEK.to], { cwd: bare });
  assert.equal(r.code, 0, r.err());
  assert.match(r.out(), /No private words are set up, so names and client words in your logs show as written/);
  const [at] = codesIn(r.out());
  const s = await ready(at.port, await claim(at.port, at.code));
  assert.equal(s.command, 'honestweek');
  assert.equal(s.privateWords.count, 0);
  assert.equal(s.privateWords.note, 'No private words set, so names show as written.', 'one short line');
  assert.ok(s.privateWords.more.includes('"redaction" in honestweek.config.json'), s.privateWords.more);
  await r.handle.stop();
  // Failing-path partner: the seeded config lists private words, so no notice anywhere.
  const withWords = await view(['--no-open', ...RANGE]);
  assert.doesNotMatch(withWords.out(), /No private words/);
  const [at2] = codesIn(withWords.out());
  const s2 = await ready(at2.port, await claim(at2.port, at2.code));
  assert.ok(s2.privateWords.count > 0);
  assert.equal(s2.privateWords.note, null);
  assert.equal(s2.privateWords.more, null);
  await withWords.handle.stop();
});

test('--demo refuses the options that would pick other data or another week', async () => {
  for (const extra of [['--goals', 'goals.json'], ['--config', 'honestweek.config.json'], ['--days', '3'], ['--from', '2025-03-10', '--to', '2025-03-16'], ['--from', '2025-03-10'], ['--to', '2025-03-16'], ['--timezone', 'UTC']]) {
    const r = await view(['--demo', ...extra]);
    assert.equal(r.code, 1, extra.join(' '));
    assert.match(r.err(), new RegExp(`can't be combined with ${extra[0]}`));
    assert.equal(r.handle, null);
  }
});

test('setup errors exit 1 with a plain message', async () => {
  const cases = [
    [['--frobnicate'], /unknown option/],
    [['--port', 'abc'], /--port must be a whole number from 0 to 65535/],
    [['--port', '70000'], /--port must be/],
    [['--port', '-1'], /--port needs a value|--port must be/],
    [['--days', '0'], /--days must be a whole number/],
    [['--days', 'week'], /--days must be a whole number/],
    [['--from', '2025-03-10'], /--from and --to go together/],
    [['--from', '2025-03-16', '--to', '2025-03-10'], /is after --to/],
    [['--from', '2025-02-30', '--to', '2025-03-10'], /--from must be a date/],
    [['--days', '3', '--from', '2025-03-10', '--to', '2025-03-16'], /not both/],
    [['--timezone', 'Mars/Olympus'], /isn't a timezone/],
    [['--goals'], /--goals needs a value/],
    [['--days', '3', '--days', '4'], /given twice/],
  ];
  for (const [argv, message] of cases) {
    const r = await view(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err(), message, argv.join(' '));
    assert.equal(r.handle, null);
  }
});

test('a wrong goal list file gets a message that names the problem', async () => {
  const dir = makeTempDir('hw-view-cli-goals-');
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ objectives: { 'obj-1': { publicLabel: 'Ship it' } }, projectToObjective: {} }));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  writeFileSync(join(dir, 'list.json'), JSON.stringify([{ id: 'g-1' }]));
  for (const [file, message] of [['registry.json', /goals page's list.*honestweek build.*goal list/], ['broken.json', /broken\.json isn't a goal list \(not valid JSON\)\./], ['list.json', /isn't a goal list: a goal record must be an object with a "goals" list/], ['missing.json', /no goal list at/]]) {
    const r = await view(['--goals', join(dir, file), '--from', WEEK.from, '--to', WEEK.to]);
    assert.equal(r.code, 1, file);
    assert.match(r.err(), message, file);
  }
});

test('the window: the last n days ending today in the timezone, or --from and --to', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.deepEqual(resolveViewWindow({}, 'UTC', now), { from: '2026-09-27', to: '2026-10-03' });
  assert.deepEqual(resolveViewWindow({ '--days': '1' }, 'UTC', now), { from: '2026-10-03', to: '2026-10-03' });
  assert.deepEqual(resolveViewWindow({}, 'Pacific/Auckland', now), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(resolveViewWindow({ '--from': '2025-03-10', '--to': '2025-03-16' }, 'UTC', now), { from: '2025-03-10', to: '2025-03-16' });
  assert.equal(parseViewPort(undefined), 0);
  assert.equal(parseViewPort('0'), 0);
  assert.equal(parseViewPort('8080'), 8080);
  assert.throws(() => parseViewPort('65536'), /--port must be/);
  assert.throws(() => parseViewPort('80'), /--port 80 won't work/);
  assert.throws(() => parseViewPort('8080.5'), /--port must be/);
});

// ---- addresses, codes and the opener --------------------------------------------------------

test('the opened page is a private redirect file, removed once its code is claimed; nothing printed or passed holds the key', async () => {
  const r = await view([...RANGE]);
  assert.equal(r.code, 0);
  assert.equal(r.opened.length, 1);
  const file = r.opened[0].file;
  assert.ok(file.startsWith(tmpdir()) || file.includes('honestweek-view-'), 'a file in a fresh temporary folder');
  assert.match(file, /honestweek-view-[^\\/]+[\\/]open\.html$/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const page = readFileSync(file, 'utf8');
  assert.match(page, /http-equiv="refresh"/);
  const [fromFile] = codesIn(page);
  assert.equal(fromFile.port, r.handle.port);
  const key = await claim(fromFile.port, fromFile.code);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(file), false, 'the file is removed after its code is claimed');
  assert.equal(existsSync(dirname(file)), false, 'and so is its folder');
  assert.ok(!file.includes(key) && !JSON.stringify(r.opened).includes(key), 'the opener never sees the key');
  assert.ok(!r.out().includes(key), 'the printed text never holds the key');
  assert.ok(!page.includes(key));
  // The printed address has its own code, which also works, once.
  const printed = codesIn(r.out());
  assert.equal(printed.length, 1);
  assert.notEqual(printed[0].code, fromFile.code);
  assert.equal(await claim(printed[0].port, printed[0].code), key);
  assert.equal(await claim(printed[0].port, printed[0].code), null);
  assert.equal(await claim(fromFile.port, fromFile.code), null);
  const s = await ready(r.handle.port, key);
  assert.equal(s.demo, null, 'no made-up-data notice outside the demo');
  assert.equal(s.goalList.given, true);
  await r.handle.stop();
});

test("the redirect file and its code last only a short while when the browser doesn't use them", async () => {
  const r = await view([...RANGE], { openerTtlMs: 150 });
  const file = r.opened[0].file;
  const [fromFile] = codesIn(readFileSync(file, 'utf8'));
  const printed = codesIn(r.out());
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(existsSync(dirname(file)), false, 'the file and its folder are gone');
  assert.equal(await claim(fromFile.port, fromFile.code), null, "the file's code no longer works");
  assert.match(await claim(printed[0].port, printed[0].code), /^[0-9a-f]{64}$/, 'the printed address still works');
  await r.handle.stop();
});

test('the redirect file is removed on stop even when its code was never claimed', async () => {
  const r = await view([...RANGE]);
  const file = r.opened[0].file;
  assert.ok(existsSync(file));
  await r.handle.stop();
  assert.equal(existsSync(dirname(file)), false);
});

test('with --no-open nothing is opened, and the printed address works; Enter prints a fresh one', async () => {
  const input = new PassThrough();
  const r = await view(['--no-open', ...RANGE], { input });
  assert.equal(r.opened.length, 0);
  const [first] = codesIn(r.out());
  const key = await claim(first.port, first.code);
  assert.ok(key);
  assert.equal(await claim(first.port, first.code), null, 'used once');
  input.write('\n');
  await new Promise((res) => setTimeout(res, 50));
  const all = codesIn(r.out());
  assert.equal(all.length, 2);
  assert.match(r.out(), /Fresh address: http/);
  assert.equal(await claim(all[1].port, all[1].code), key, 'the fresh address works');
  assert.ok(!r.out().includes(key));
  await r.handle.stop();
});

test('a printed address stops working when its lifetime ends, and Enter still prints a fresh one that works', async () => {
  // A clock the test moves, so nothing depends on how fast the machine answers.
  let clock = Date.now();
  const codeClock = () => clock;
  const fresh = async (r, n) => {
    for (let i = 0; i < 200 && codesIn(r.out()).length < n; i++) await new Promise((done) => setTimeout(done, 10));
    return codesIn(r.out())[n - 1];
  };
  const input = new PassThrough();
  const r = await view(['--no-open', ...RANGE], { input, codeClock });
  assert.match(r.out(), /Each address works once, within 15 minutes\. Press Enter here to print a fresh one\./);
  const [old] = codesIn(r.out());
  clock += CODE_TTL_MS + 1;
  assert.equal(await claim(old.port, old.code), null, 'a printed address left in scrollback no longer works');
  input.write('\n');
  const next = await fresh(r, 2);
  assert.ok(next, 'Enter printed a fresh address');
  assert.match(await claim(next.port, next.code), /^[0-9a-f]{64}$/, 'the fresh address works');
  await r.handle.stop();
  // A lifetime the caller names is the one printed codes get, and the terminal says it.
  const input2 = new PassThrough();
  const s = await view(['--no-open', ...RANGE], { input: input2, codeClock, printedTtlMs: 60_000 });
  assert.match(s.out(), /Each address works once, within 1 minute\. Press Enter/);
  const [short] = codesIn(s.out());
  input2.write('\n');
  const kept = await fresh(s, 2);
  clock += 60_000;
  assert.match(await claim(kept.port, kept.code), /^[0-9a-f]{64}$/, 'it works to the end of its lifetime');
  clock += 1;
  assert.equal(await claim(short.port, short.code), null, 'and not a moment past it');
  await s.handle.stop();
});

test('with --self-test it also prints the click-through page\'s address, with its own code, and a fresh one on Enter', async () => {
  const input = new PassThrough();
  const r = await view(['--no-open', '--self-test', ...RANGE], { input });
  const selfTestCodes = (text) => [...text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/selftest\/clickthrough\.html#c=([0-9a-f]+)/g)].map((m) => ({ port: Number(m[1]), code: m[2] }));
  const [page] = selfTestCodes(r.out());
  assert.ok(page, 'the click-through address is printed');
  assert.equal(codesIn(r.out()).length, 1, 'beside the one search-page address');
  const key = await claim(page.port, page.code);
  assert.ok(key);
  assert.equal(await claim(page.port, page.code), null, 'used once');
  input.write('\n');
  await new Promise((res) => setTimeout(res, 50));
  const fresh = selfTestCodes(r.out());
  assert.equal(fresh.length, 2);
  assert.equal(await claim(fresh[1].port, fresh[1].code), key, 'the fresh click-through address works');
  await r.handle.stop();
});

test('restarted on the same port, a switch saved under the old run\'s key counts as off', async () => {
  const first = await view(['--no-open', ...RANGE]);
  const port = first.handle.port;
  const key1 = await claim(port, codesIn(first.out())[0].code);
  await ready(port, key1);
  // The page keeps the switch in sessionStorage under the run key it holds.
  const sessionStorage = new Map([[`hw-private:${key1}`, 'on']]);
  const on = (await get(port, `/api/replay?session=${w.keys.featured}&private=1`, { [KEY_HEADER]: key1 })).json;
  assert.equal(on.view.asked, 'private');
  await first.handle.stop();

  const second = await view(['--no-open', '--port', String(port), ...RANGE]);
  assert.equal(second.code, 0);
  assert.equal(second.handle.port, port);
  const old = await get(port, '/api/home', { [KEY_HEADER]: key1 });
  assert.equal(old.status, 403, 'the earlier run\'s key opens nothing');
  assert.equal(old.json.error, 'no-key');
  const key2 = await claim(port, codesIn(second.out())[0].code);
  assert.notEqual(key2, key1);
  await ready(port, key2);
  const switchOn = sessionStorage.get(`hw-private:${key2}`) === 'on';
  assert.equal(switchOn, false);
  const answer = (await get(port, `/api/replay?session=${w.keys.featured}${switchOn ? '&private=1' : ''}`, { [KEY_HEADER]: key2 })).json;
  assert.equal(answer.view.shown, 'redacted');
  assert.equal(createLeakCounter(w.config).redacted(answer).total, 0);
  assert.ok(!JSON.stringify(answer).includes(TERM));
  await second.handle.stop();
});

test('a port already in use is a setup error', async () => {
  const first = await view(['--no-open', ...RANGE]);
  const again = await view(['--no-open', '--port', String(first.handle.port), ...RANGE]);
  assert.equal(again.code, 1);
  assert.match(again.err(), /already in use/);
  await first.handle.stop();
});

// ---- the demo -------------------------------------------------------------------------------

test('a demo run reads only the made-up week, carries the notice, and deletes its folder on stop', async () => {
  // A realistic session in the default log folders, which the demo must never read.
  const home = makeTempDir('hw-view-cli-home-');
  const projects = join(home, 'claude', 'projects', '-work-real-project');
  mkdirSync(projects, { recursive: true });
  const id = '22222222-3333-4444-8555-666666666666';
  const t = new Date(Date.parse(`${WEEK.from}T10:00:00Z`)).toISOString();
  writeFileSync(join(projects, `${id}.jsonl`), `${[
    JSON.stringify({ type: 'ai-title', aiTitle: 'zebracrossing migration', sessionId: id }),
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/work/real-project', uuid: `${id}-1`, timestamp: t, message: { role: 'user', content: 'Plan the zebracrossing migration for #12 and lib/format.mjs' }, origin: { kind: 'human' } }),
  ].join('\n')}\n`);
  const env = { CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') };
  const r = await view(['--demo', '--no-open'], { cwd: makeTempDir('hw-view-cli-nowhere-'), env });
  assert.equal(r.code, 0);
  assert.ok(r.handle.demoRoot && existsSync(r.handle.demoRoot));
  const key = await claim(r.handle.port, codesIn(r.out())[0].code);
  const status = await ready(r.handle.port, key);
  assert.equal(status.state, 'ready');
  assert.match(status.demo.notice, /made-up week/);
  const commands = status.demo.commands.map((c) => c.command).join('\n');
  assert.match(commands, / init$/m);
  assert.match(commands, / view$/m);
  assert.match(commands, /plugin install honestweek/);
  assert.deepEqual(status.window, { from: WEEK.from, to: WEEK.to, timezone: 'UTC' });
  for (let i = 0; i < 200 && status.search.state !== 'ready'; i++) {
    await new Promise((res) => setTimeout(res, 50));
    Object.assign(status, (await get(r.handle.port, '/api/status', { [KEY_HEADER]: key })).json);
  }
  const search = (await get(r.handle.port, '/api/search?q=zebracrossing', { [KEY_HEADER]: key })).json;
  assert.deepEqual(search.results, []);
  assert.ok(search.view.demo.notice, 'every data answer carries the notice in demo mode');
  const words = (await get(r.handle.port, '/api/words?q=zebracrossing', { [KEY_HEADER]: key })).json;
  assert.deepEqual([words.goals, words.sessions, words.prompts], [[], [], []]);
  const home2 = (await get(r.handle.port, '/api/home', { [KEY_HEADER]: key })).json;
  assert.ok(home2.recent.every((s) => !String(s.title ?? '').includes('zebracrossing')));
  // 23 since the demo week gained Saturday's review run, which a script started.
  assert.equal(home2.coverage.sessionsRead.value, 23, 'only the demo week\'s twenty-three sessions');
  // The made-up project name is hidden with the switch off and shown with it on.
  const lookup = (await get(r.handle.port, '/api/lookup?q=%2312', { [KEY_HEADER]: key })).json;
  assert.ok(lookup.sessions.length >= 1);
  assert.ok(!JSON.stringify(lookup).toLowerCase().includes('lantern'));
  const root = r.handle.demoRoot;
  await r.handle.stop();
  assert.equal(existsSync(root), false, 'the demo folder is deleted');
});

test('Ctrl+C stops the command with exit code 0', { skip: process.platform === 'win32' ? 'Windows has no catchable SIGINT for a child process' : false }, async () => {
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'honestweek.mjs'), 'view', '--demo', '--no-open'], { cwd: scratch, env: { ...process.env, ...ENV }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  // Ctrl+C as early as a person could press it: at the first line that says it stops the page.
  // The handler has to be in place by then, or the signal ends the process with no exit code.
  for (let i = 0; i < 4000 && !/Ctrl\+C stops it/.test(out); i++) await new Promise((res) => setTimeout(res, 5));
  assert.match(out, /Ctrl\+C stops it/);
  // 'close' fires once the process has exited and its output has all been read, so the last line is in.
  const closed = new Promise((res) => child.on('close', (code, signal) => res({ code, signal })));
  child.kill('SIGINT');
  const { code, signal } = await closed;
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  assert.match(out, /stopped/);
});

test('no answer in a seeded run leaks a private word with the switch off', async () => {
  const r = await view(['--no-open', ...RANGE]);
  const key = await claim(r.handle.port, codesIn(r.out())[0].code);
  await ready(r.handle.port, key);
  const counter = createLeakCounter(w.config);
  for (const path of ['/api/status', '/api/home', '/api/sessions', '/api/replay', `/api/replay?session=${w.keys.display}`, `/api/replay?session=${w.keys.outside}`, '/api/lookup?q=%2312', `/api/words?q=${TERM}`]) {
    const a = (await get(r.handle.port, path, { [KEY_HEADER]: key })).json;
    assert.equal(counter.redacted(a).total, 0, path);
    for (const word of PRIVATE_WORDS) assert.ok(!JSON.stringify(a).includes(word), `${path} holds ${word}`);
  }
  await r.handle.stop();
});

test('the bare address opens Setup when no config exists, and Problems when one does', async () => {
  // No config: the address printed is Setup's, and the bare address, which serves the Problems
  // page's file, gets setup from the status answer, which every page turns into a move to Setup.
  const r = await view(['--no-open'], { cwd: makeTempDir('hw-view-cli-empty-') });
  assert.equal(r.code, 0, r.err());
  const printed = r.out().match(/http:\/\/127\.0\.0\.1:(\d+)\/setup\.html#c=([0-9a-f]+)/);
  assert.ok(printed, 'the printed address opens Setup');
  const port = Number(printed[1]);
  const key = await claim(port, printed[2]);
  const page = (p, path) => new Promise((res, rej) => {
    const req = request({ host: '127.0.0.1', port: p, path, agent: false }, (r) => {
      let text = '';
      r.on('data', (x) => (text += x));
      r.on('end', () => res({ status: r.statusCode, text }));
    });
    req.on('error', rej);
    req.end();
  });
  const home = await page(port, '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<body data-page="problems">/);
  const status = await get(port, '/api/status', { [KEY_HEADER]: key });
  assert.equal(status.json.setup, true, 'the status says setup is pending');
  assert.match(readFileSync(join(ROOT, 'lib', 'view', 'assets', 'common.js'), 'utf8'), /if \(s\.setup === true\) return location\.replace\('setup\.html'\);/, 'and a page moves to Setup when it does');
  // With a config: the bare address is printed, it serves Problems, and nothing sends it to Setup.
  const c = await view(['--no-open', ...RANGE]);
  assert.equal(c.code, 0, c.err());
  const [{ port: p2, code }] = codesIn(c.out());
  const k2 = await claim(p2, code);
  assert.match((await page(p2, '/')).text, /<body data-page="problems">/);
  assert.notEqual((await ready(p2, k2)).setup, true);
});
