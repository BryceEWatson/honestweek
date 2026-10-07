// honestweek status (issue 183): read-only, always exits 0, and names the next step of the weekly
// flow from the files on disk. Each state is set up on the made-up demo week.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDemoWeek, WEEK } from '../lib/demo/week.mjs';
import run, { statusOf, statusText } from '../lib/status.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

// A day in the week after the demo week, so the demo week is the last completed one.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2025-03-19T12:00:00Z');
const LAST = { start: WEEK.from, end: WEEK.to };
// A home folder of its own with no user-level config, and no HONESTWEEK_CONFIG.
const NO_MACHINE = { env: {}, home: makeTempDir('hw-status-home-') };
const at = (ms) => new Date(ms);

/** A folder holding the demo week's config, ready for the step files. */
function project() {
  const root = makeTempDir('hw-status-');
  const d = buildDemoWeek({ root: join(root, 'week') });
  const dir = join(root, 'week');
  writeFileSync(join(dir, 'honestweek.config.json'), `${JSON.stringify({ ...d.config, output: { mode: 'post', file: 'post.md' } }, null, 2)}\n`);
  return dir;
}

const status = (dir, opts = {}) => statusOf({ cwd: dir, now: NOW, lookup: NO_MACHINE, command: 'honestweek', ...opts });
const goodItem = (sessionId) => ({ text: 'Lantern renders long lines without clipping.', repo: 'lantern', status: 'in progress', receipt: { sessionId } });

test('with no config anywhere, it says so and names init or view, and writes nothing', () => {
  const dir = makeTempDir('hw-status-empty-');
  const before = readdirSync(dir);
  const r = status(dir);
  assert.equal(r.config.found, false);
  assert.equal(r.next.step, 'init');
  assert.match(r.next.says, /honestweek init writes one here[\s\S]*honestweek view sets one up/);
  assert.deepEqual(readdirSync(dir), before, 'status wrote nothing');
});

test('a HONESTWEEK_CONFIG that names a missing file, or a config that cannot be read, is a line in the report', () => {
  const dir = makeTempDir('hw-status-bad-');
  const missing = status(dir, { lookup: { env: { HONESTWEEK_CONFIG: join(dir, 'nope.json') }, home: NO_MACHINE.home } });
  assert.equal(missing.config.found, false);
  assert.match(missing.config.error, /nope\.json isn't there/);
  assert.equal(missing.next.step, 'fix-config');
  writeFileSync(join(dir, 'honestweek.config.json'), '{ not json');
  const broken = status(dir);
  assert.equal(broken.config.readable, false);
  assert.equal(broken.next.step, 'fix-config');
  assert.doesNotMatch(statusText(broken), /not json/, 'the file\'s contents never reach the report');
});

test('with a config and no draft, the next step is discover, for the last completed week', () => {
  const dir = project();
  const r = status(dir);
  assert.equal(r.config.readable, true);
  assert.equal(r.config.source, 'folder');
  assert.deepEqual({ start: r.week.start, end: r.week.end }, LAST);
  assert.equal(r.draft.exists, false);
  assert.equal(r.next.step, 'discover');
  assert.equal(r.next.command, 'honestweek discover');
});

test('a draft for another week is a choice, never an overwrite; a current one with no items asks for DISTIL', () => {
  const dir = project();
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: { start: '2025-03-03', end: '2025-03-09' }, sessions: [{ id: 'a' }], handoffs: [] }));
  const old = status(dir);
  assert.equal(old.draft.current, false);
  assert.equal(old.next.step, 'choose-week');
  assert.equal(old.next.command, undefined, 'no command to run blindly over the draft');
  assert.match(old.next.says, /covers 2025-03-03 to 2025-03-09, not the last completed week \(2025-03-10 to 2025-03-16\)\. Ask which week the user means/);
  assert.match(old.next.says, /honestweek discover writes a new draft over this one; to carry on with 2025-03-03 to 2025-03-09, go on from DISTIL/);
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: LAST, sessions: [{ id: 'a' }, { id: 'b' }], handoffs: [] }));
  const current = status(dir);
  assert.equal(current.draft.current, true);
  assert.equal(current.draft.sessions, 2);
  assert.equal(current.next.step, 'distil');
});

test('items with a problem name validate; passing items with no output name build; a fresh build names review', () => {
  const dir = project();
  const t0 = Date.parse('2025-03-18T10:00:00Z');
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: LAST, sessions: [{ id: 'abc12345' }], handoffs: [] }));
  utimesSync(join(dir, 'honestweek.draft.json'), at(t0), at(t0));
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify([{ text: 'No badge here.', repo: 'lantern' }]));
  utimesSync(join(dir, 'honestweek.items.json'), at(t0 + 1000), at(t0 + 1000));
  const bad = status(dir);
  assert.equal(bad.items.passes, false);
  assert.ok(bad.items.problems > 0);
  assert.equal(bad.next.step, 'validate');
  assert.doesNotMatch(statusText(bad), /No badge here/, 'item text never reaches the report');

  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify([goodItem('abc12345')]));
  utimesSync(join(dir, 'honestweek.items.json'), at(t0 + 2000), at(t0 + 2000));
  const unbuilt = status(dir);
  assert.equal(unbuilt.items.passes, true);
  assert.equal(unbuilt.items.week, null, 'a plain list names no week');
  assert.equal(unbuilt.next.step, 'build');

  writeFileSync(join(dir, 'post.md'), '# built\n');
  utimesSync(join(dir, 'post.md'), at(t0 + 3000), at(t0 + 3000));
  const built = status(dir);
  assert.equal(built.output.exists, true);
  assert.equal(built.next.step, 'review');
  // Items that name no week were built for the last completed week on the build day: derived.
  assert.deepEqual(built.output.week, { ...LAST, from: 'build-day' });
  assert.match(statusText(built), /for 2025-03-10 to 2025-03-16 \(the last completed week on the day it was built\)/);

  utimesSync(join(dir, 'honestweek.items.json'), at(t0 + 4000), at(t0 + 4000));
  const stale = status(dir);
  assert.equal(stale.next.step, 'build', 'items changed after the build');
  assert.equal(stale.output.week, undefined, 'an output older than the items claims no week');
  utimesSync(join(dir, 'honestweek.draft.json'), at(t0 + 5000), at(t0 + 5000));
  assert.equal(status(dir).next.step, 'distil', 'a newer draft than the items');
});

test('it always exits 0, prints text or JSON, and holds no item or session text', () => {
  const dir = project();
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: LAST, sessions: [{ id: 'SESSIONMARK', title: 'SESSIONMARK title' }], handoffs: [] }));
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({ week: LAST, items: [{ ...goodItem('SESSIONMARK'), text: 'ITEMMARK text.' }] }));
  const lines = [];
  assert.equal(run([], { cwd: dir, now: NOW, out: (s) => lines.push(s), lookup: NO_MACHINE }), 0);
  assert.match(lines.join(''), /^honestweek status \(reads only, writes nothing\)\n {2}config: .*\(in this folder\)\n {2}week: the last completed week is 2025-03-10 to 2025-03-16 \(UTC\)/);
  const json = [];
  assert.equal(run(['--json'], { cwd: dir, now: NOW, out: (s) => json.push(s), lookup: NO_MACHINE }), 0);
  const report = JSON.parse(json.join(''));
  assert.deepEqual(report.items.week, LAST, 'the { week, items } form names its week');
  assert.equal(report.items.count, 1);
  for (const printed of [lines.join(''), json.join('')]) assert.doesNotMatch(printed, /SESSIONMARK|ITEMMARK/);
});

test('a broken config never puts its own text in the report, as text or JSON', () => {
  const dir = makeTempDir('hw-status-leak-');
  // V8 quotes the text around a parse fault; a field check quotes the value it rejected.
  for (const body of ['{"redaction":{"names":[SECRETMARK]}}', JSON.stringify({ identities: ['you@example.com'], repos: [{ path: '.', role: 'SECRETMARK' }] })]) {
    writeFileSync(join(dir, 'honestweek.config.json'), body);
    const r = status(dir);
    assert.equal(r.config.readable, false);
    assert.equal(r.next.step, 'fix-config');
    assert.doesNotMatch(statusText(r), /SECRETMARK/);
    assert.doesNotMatch(JSON.stringify(r), /SECRETMARK/);
  }
  // The demo config with one repo's role set to a value the check quotes back.
  const good = JSON.parse(readFileSync(join(project(), 'honestweek.config.json'), 'utf8'));
  good.repos[0].role = 'SECRETMARK';
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify(good));
  const r = status(dir);
  assert.equal(r.config.error, '"repos[0].role" isn\'t valid', 'a field check names the field, not its value');
  assert.doesNotMatch(JSON.stringify(r), /SECRETMARK/);
});

test('site output is the artifact its JSON adapter names; page and site without goals take digest prepare first', () => {
  const dir = project();
  const config = JSON.parse(readFileSync(join(dir, 'honestweek.config.json'), 'utf8'));
  writeFileSync(join(dir, 'honestweek.site.json'), JSON.stringify({ artifact: 'data/week.json' }));
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({ ...config, output: { mode: 'site', adapter: 'honestweek.site.json' } }));
  const t0 = Date.parse('2025-03-18T10:00:00Z');
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: LAST, sessions: [], handoffs: [] }));
  utimesSync(join(dir, 'honestweek.draft.json'), at(t0), at(t0));
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify([goodItem('abc12345')]));
  utimesSync(join(dir, 'honestweek.items.json'), at(t0 + 1000), at(t0 + 1000));
  const unbuilt = status(dir);
  assert.equal(unbuilt.output.file, 'data/week.json');
  assert.equal(unbuilt.next.step, 'build');
  assert.match(unbuilt.next.says, /honestweek digest prepare, then honestweek validate, then honestweek build/);
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'week.json'), '{}\n');
  utimesSync(join(dir, 'data', 'week.json'), at(t0 + 2000), at(t0 + 2000));
  assert.equal(status(dir).next.step, 'review', 'a built site is not sent back to build');
  writeFileSync(join(dir, 'honestweek.objectives.json'), '{}\n');
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify({ ...config, output: { mode: 'site', adapter: 'site.mjs' } }));
  const code = status(dir);
  assert.equal(code.output.unknown, true);
  assert.doesNotMatch(code.next.says, /digest prepare/, 'a goals registry skips the digest');
});

test('a flag error names fix-flag, and --config is repeated in the next command', () => {
  const dir = project();
  assert.equal(status(dir, { argv: ['--config'] }).next.step, 'fix-flag');
  const r = status(makeTempDir('hw-status-away-'), { argv: ['--config', join(dir, 'honestweek.config.json')] });
  assert.equal(r.config.source, 'flag');
  assert.equal(r.next.step, 'discover');
  assert.match(r.next.command, /^honestweek discover --config /);
});

test('run() catches anything statusOf throws and still exits 0', () => {
  const lines = [];
  const lookup = { get env() { throw new Error('boom'); }, home: NO_MACHINE.home };
  assert.equal(run([], { cwd: makeTempDir('hw-status-throw-'), now: NOW, out: (s) => lines.push(s), lookup }), 0);
  assert.match(lines.join(''), /status couldn't finish: boom/);
});

test('items the gate cannot read, or reserved digest fields, are problems, not a crash', () => {
  const dir = project();
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: LAST, sessions: [], handoffs: [] }));
  utimesSync(join(dir, 'honestweek.draft.json'), at(1e12), at(1e12));
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify([null]));
  const nulls = status(dir);
  assert.equal(nulls.items.passes, false);
  assert.equal(nulls.next.step, 'validate');
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify([{ ...goodItem('abc'), kind: 'prompt', publicDisposition: 'automatic-safe' }]));
  assert.equal(status(dir).items.passes, false);
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({ period: LAST, week: { start: '2025-01-06', end: '2025-01-12' }, items: [] }));
  assert.deepEqual(status(dir).items.week, LAST, 'build reads period before week');
});

test('an output built after items that name a week covers that week', () => {
  const dir = project();
  const t0 = Date.parse('2025-03-18T10:00:00Z');
  const week = { start: '2025-03-03', end: '2025-03-09' };
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: LAST, sessions: [{ id: 'abc12345' }], handoffs: [] }));
  utimesSync(join(dir, 'honestweek.draft.json'), at(t0), at(t0));
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({ week, items: [goodItem('abc12345')] }));
  utimesSync(join(dir, 'honestweek.items.json'), at(t0 + 1000), at(t0 + 1000));
  writeFileSync(join(dir, 'post.md'), '# built\n');
  utimesSync(join(dir, 'post.md'), at(t0 + 2000), at(t0 + 2000));
  assert.deepEqual(status(dir).output.week, { ...week, from: 'items' });
});

test('a client config gets the client flow: history, items with a period, then validate and build', () => {
  const root = makeTempDir('hw-status-client-');
  const d = buildDemoWeek({ root: join(root, 'week') });
  const dir = join(root, 'week');
  const client = { ...d.config, client: { name: 'Example Client' }, output: { mode: 'client', file: 'report.html' } };
  writeFileSync(join(dir, 'honestweek.config.json'), JSON.stringify(client, null, 2));
  const r0 = status(dir);
  if (r0.config.readable === false) assert.fail(`the client config didn't load: ${r0.config.error}`);
  assert.equal(r0.next.step, 'history', 'no items yet: the period history comes first, never discover');
  assert.match(r0.next.says, /honestweek history --from <YYYY-MM-DD> --to <YYYY-MM-DD>/);
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({ items: [goodItem('abc12345')] }));
  assert.equal(status(dir).next.step, 'distil', 'client items with no period');
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({ period: { start: '2025-03-01', end: '2025-03-31' }, items: [goodItem('abc12345')] }));
  const r2 = status(dir);
  assert.deepEqual(r2.items.week, { start: '2025-03-01', end: '2025-03-31' });
  assert.equal(r2.next.step, 'build', 'items that pass, not built yet: build, never discover');
});

test('the real command exits 0 and prints the report from a folder with no config', () => {
  const dir = makeTempDir('hw-status-cli-');
  const home = makeTempDir('hw-status-cli-home-');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.HONESTWEEK_CONFIG;
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'honestweek.mjs'), 'status'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^honestweek status \(reads only, writes nothing\)\n {2}config: none found/);
  assert.deepEqual(readdirSync(dir), [], 'it wrote nothing');
});

test('items that name a different week from the current draft go back to DISTIL, never to build', () => {
  const dir = project();
  const t0 = Date.parse('2025-03-18T10:00:00Z');
  writeFileSync(join(dir, 'honestweek.draft.json'), JSON.stringify({ week: LAST, sessions: [{ id: 'abc12345' }], handoffs: [] }));
  utimesSync(join(dir, 'honestweek.draft.json'), at(t0), at(t0));
  writeFileSync(join(dir, 'honestweek.items.json'), JSON.stringify({ week: { start: '2025-03-03', end: '2025-03-09' }, items: [goodItem('abc12345')] }));
  utimesSync(join(dir, 'honestweek.items.json'), at(t0 + 1000), at(t0 + 1000));
  const r = status(dir);
  assert.equal(r.next.step, 'distil');
  assert.match(r.next.says, /The items name 2025-03-03 to 2025-03-09, but the draft covers 2025-03-10 to 2025-03-16/);
});
