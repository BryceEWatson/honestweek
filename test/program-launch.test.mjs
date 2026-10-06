// The step that launched a session a program opened: a `claude -p` or `codex exec` call, or a
// Stop hook's record, in another session. Recorded when it names the session's id, derived when
// its command holds the session's opening instruction, inferred when it's the only launch in the
// same folder in the 2 minutes before. Ambiguous launches, hooks that name nothing, timing across
// folders, older logs and Codex runs nothing launched link nothing, and a build without launch
// steps reads exactly as it did before the join existed. All logs here are made up.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { launchKind, matchLaunches } from '../lib/replay/launch.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { IDS, TEXT, WINDOW, writeLaunchLogs } from './fixtures/replay/program-launch.mjs';
import { readLaunchWeek } from './fixtures/replay/program-launch-reading.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const roots = [];
const dir = (prefix) => {
  const d = makeTempDir(prefix);
  roots.push(d);
  return d;
};
let w;
let h;
before(async () => {
  w = writeLaunchLogs(dir('hw-launch-'));
  h = await buildWorkHistory({ config: w.config, from: WINDOW.from, to: WINDOW.to, roots: w.roots, git: false });
});
after(() => roots.forEach(removeTempDir));

const session = (k) => h.sessions.find((s) => s.key === k);
const by = (k) => session(k).launchedBy ?? null;
const step = (id) => h.events.find((e) => e.id === id);
const shell = (k, needle) => h.events.find((e) => e.session === k && e.kind === 'action' && String(e.facts.command ?? '').includes(needle));

test('launchKind: claude with -p or --print, or codex exec, outside quoted text', () => {
  for (const c of [
    'claude -p "review it"',
    `claude --session-id ${IDS.byId} -p "/review"`,
    'cat notes.md | claude -p --output-format json',
    'claude --print < task.md',
    'cd /path/to/your/repo && claude --model opus -p "x"',
    '& "C:/tools/claude.exe" -p "x"',
    '/usr/local/bin/claude -p hi',
    'nohup claude -p --resume abc &',
  ]) assert.equal(launchKind(c), 'claude', c);
  for (const c of ['codex exec "write notes"', 'codex exec resume 0190a1b2-0000-7000-8000-00000000e0e0', '"/opt/codex/codex" exec -']) assert.equal(launchKind(c), 'codex', c);
  for (const c of [
    'git add -p',
    'node ~/.claude/skills/review-loop/run.cjs -p',
    'echo "claude -p is how" > notes.md',
    'claude --help',
    'claudette -p x',
    'codex review',
    'grep -r "codex exec" docs',
    null,
  ]) assert.equal(launchKind(c), null, String(c));
});

test('recorded: the call that names the session id, the latest one before the session started', () => {
  const l = by(w.key.byId);
  assert.deepEqual(l, { event: l.event, session: w.key.launcher, evidence: 'recorded', rule: 'launch.session-id' });
  // The --session-id call at 15:01, not the --resume call at 15:02, which ran after the run started.
  assert.match(step(l.event).facts.command, /--session-id/);
  assert.equal(step(l.event).at, '2024-06-11T15:01:00.000Z');
  // A Codex session's call names a Claude Code run's id the same way.
  const c = by(w.key.fromCodex);
  assert.equal(c.session, w.key.codexParent);
  assert.equal(c.evidence, 'recorded');
  assert.equal(step(c.event).facts.tool, 'exec_command');
});

test('derived: the call whose command holds the opening instruction, for Claude Code and codex exec runs', () => {
  assert.deepEqual(by(w.key.byText), { event: shell(w.key.launcher, 'Summarize the open issues').id, session: w.key.launcher, evidence: 'derived', rule: 'launch.opening-text' });
  assert.deepEqual(by(w.key.codexByText), { event: shell(w.key.launcher, 'codex exec').id, session: w.key.launcher, evidence: 'derived', rule: 'launch.opening-text' });
});

test('inferred: the only launch in the same folder in the 2 minutes before, and never across folders', () => {
  assert.deepEqual(by(w.key.byTime), { event: shell(w.key.launcher, 'notes/plan.md').id, session: w.key.launcher, evidence: 'inferred', rule: 'launch.same-folder' });
  // A launch 20 seconds before a run in another folder isn't its launcher.
  assert.equal(by(w.key.farAway), null);
});

test('ambiguous: two launches that fit, or one launch two runs fit, link none and say how many', () => {
  assert.deepEqual(by(w.key.ambiguous), { ambiguous: true, evidence: 'inferred', rule: 'launch.same-folder', launches: 2 });
  for (const k of [w.key.pairA, w.key.pairB]) assert.deepEqual(by(k), { ambiguous: true, evidence: 'inferred', rule: 'launch.same-folder', launches: 1, sessions: 2 });
  assert.ok(!h.links.some((l) => l.type === 'program-launch' && [w.key.ambiguous, w.key.pairA, w.key.pairB].includes(l.to)));
});

test("a Stop hook counts only when its record names the run, never by its timing", () => {
  const l = by(w.key.hookNamed);
  assert.equal(l.session, w.key.second);
  assert.equal(l.evidence, 'recorded');
  assert.ok(['hook', 'turn-end'].includes(step(l.event).kind));
  // A hook 10 seconds before a run, whose record names nothing, links nothing.
  assert.equal(by(w.key.hookSilent), null);
});

test('older logs, and a codex exec run nothing launched, read as before', () => {
  // A legacy run whose id the legacy parent's call names: its log doesn't say a program sent it.
  assert.equal(by(w.key.legacyChild), null);
  assert.equal(by(w.key.codexPlain), null);
  for (const k of [w.key.launcher, w.key.second, w.key.legacyParent, w.key.codexParent]) assert.equal(by(k), null);
});

test('a launch link joins no threads, and the rules table explains it', () => {
  const links = h.links.filter((l) => l.type === 'program-launch');
  assert.equal(links.length, 6);
  for (const l of links) {
    assert.equal(step(l.from).session, l.sessions[0]);
    assert.notEqual(session(l.sessions[0]).thread, session(l.to).thread);
  }
  for (const r of ['launch.session-id', 'launch.opening-text', 'launch.same-folder']) assert.match(h.rules[r], /program started/);
});

test('logs without launch steps read byte for byte as before the launch join existed', async () => {
  const plain = writeLaunchLogs(dir('hw-launch-plain-'), { launches: false });
  const want = JSON.parse(readFileSync(new URL('./fixtures/program-launch-before.json', import.meta.url), 'utf8'));
  assert.deepEqual(await readLaunchWeek(plain), want);
});

test('a session in a display-only repo is never linked, either way round', async () => {
  const d = writeLaunchLogs(dir('hw-launch-display-'), { role: 'display' });
  const hd = await buildWorkHistory({ config: d.config, from: WINDOW.from, to: WINDOW.to, roots: d.roots, git: false });
  assert.ok(hd.sessions.every((s) => !s.launchedBy));
  assert.ok(!hd.links.some((l) => l.type === 'program-launch'));
  assert.ok(!Object.keys(hd.rules).some((r) => r.startsWith('launch.')));
});

test('matchLaunches: hooks never count by timing, and a launch naming a known session is no timing candidate', () => {
  const ev = (id) => ({ id });
  const child = { session: 'c', kind: 'claude', id: 'x', opening: null, cwd: 'c:/repo', startT: 100000 };
  const hook = { event: ev('h'), session: 'p', kind: 'hook', text: 'Review queued.', cwd: 'c:/repo', t: 90000 };
  assert.equal(matchLaunches({ launches: [hook], children: [child] }).size, 0);
  const resume = { event: ev('r'), session: 'p', kind: 'claude', text: `claude -p --resume ${IDS.byId} "more"`, cwd: 'c:/repo', t: 90000 };
  assert.equal(matchLaunches({ launches: [resume], children: [child], knownIds: new Set([IDS.byId]) }).size, 0);
  // Named in two sessions: none.
  const a = { event: ev('a'), session: 'p', kind: 'claude', text: 'claude -p --session-id x-1', cwd: null, t: 10 };
  const named = (s, id) => ({ event: ev(id), session: s, kind: 'claude', text: `claude -p --session-id ${IDS.byText}`, cwd: null, t: 50 });
  const two = matchLaunches({ launches: [a, named('p', 'n1'), named('q', 'n2')], children: [{ ...child, id: IDS.byText }] });
  assert.deepEqual(two.get('c'), { ambiguous: true, evidence: 'recorded', rule: 'launch.session-id', launches: 2 });
  // One step holding the same opening as two runs days apart (a rerun the logs don't show)
  // links neither; one command holding two different openings (a loop) links both.
  const P = 'Check the release notes against the merged pull requests and list any gaps.';
  const Q = 'Check the README examples against the current flags and list any that fail.';
  const run = (session, opening, startT) => ({ session, kind: 'claude', id: `id-${session}`, opening, cwd: null, startT });
  const once = { event: ev('m'), session: 'p', kind: 'claude', text: `claude -p "${P}"`, cwd: null, t: 1000 };
  const rerun = matchLaunches({ launches: [once], children: [run('mon', P, 2000), run('sat', P, 2000 + 5 * 86400e3)] });
  for (const k of ['mon', 'sat']) assert.deepEqual(rerun.get(k), { ambiguous: true, evidence: 'derived', rule: 'launch.opening-text', launches: 1, sessions: 2 });
  const loop = { event: ev('l'), session: 'p', kind: 'claude', text: `for p in "${P}" "${Q}"; do claude -p "$p"; done`, cwd: null, t: 1000 };
  const both = matchLaunches({ launches: [loop], children: [run('a', P, 2000), run('b', Q, 3000)] });
  assert.deepEqual([both.get('a').event, both.get('b').event, both.get('a').evidence], ['l', 'l', 'derived']);
  // A step that names run A's id is A's: run B with the same opening isn't matched to it by text.
  const idStep = { event: ev('n'), session: 'p', kind: 'claude', text: `claude -p --session-id ${IDS.byId} "${P}"`, cwd: 'c:/repo', t: 1000 };
  const claimed = matchLaunches({ launches: [idStep], children: [{ ...run('A', P, 2000), id: IDS.byId }, { ...run('B', P, 2000), cwd: 'c:/repo' }], knownIds: new Set([IDS.byId]) });
  assert.equal(claimed.get('A').evidence, 'recorded');
  assert.equal(claimed.has('B'), false);
  // An opening shorter than 40 characters is never matched by its text.
  const short = matchLaunches({ launches: [{ event: ev('s'), session: 'p', kind: 'claude', text: 'claude -p "Fix it."', cwd: 'c:/elsewhere', t: 50 }], children: [{ ...child, opening: 'Fix it.' }] });
  assert.equal(short.size, 0);
  assert.ok(TEXT.byText.length >= 40);
});

test("the pages: a launched run names its launcher's step, the step names the run, and none is named for the rest", async () => {
  const d = writeLaunchLogs(dir('hw-launch-view-'), { terms: ['Night checks'] });
  const data = createViewData({ config: d.config, roots: d.roots, from: WINDOW.from, to: WINDOW.to, timezone: WINDOW.timezone });
  await data.start();
  try {
    const ask = async (path, q = {}) => (await data.route(path, new URLSearchParams(q))).body;
    const list = await ask('/api/sessions');
    const rows = new Map();
    for (const day of list.days) {
      const more = day.more.value ? await ask('/api/sessions', { day: day.day, offset: String(day.rows.length) }) : { rows: [] };
      for (const r of [...day.rows, ...more.rows]) rows.set(r.session, r);
    }
    const hd = await buildWorkHistory({ config: d.config, from: WINDOW.from, to: WINDOW.to, roots: d.roots, git: false });
    const launcherThread = hd.sessions.find((s) => s.key === d.key.launcher).thread;
    const l = rows.get(d.key.byId).startedBy;
    assert.equal(l.text, 'started by a program: /review');
    assert.deepEqual({ ...l.launch, event: null }, { session: d.key.launcher, thread: launcherThread, event: null, at: '2024-06-11T15:01:00.000Z', title: 'Start the review runs', label: null, evidence: 'recorded', rule: 'launch.session-id' });
    // The launching session's title passes the redactor like any title.
    const hook = rows.get(d.key.hookNamed).startedBy.launch;
    assert.ok(!JSON.stringify(hook).includes('Night checks'));
    assert.match(hook.title, /\[redacted/);
    // An ambiguous run says how many fit; one nothing launched keeps its words and nothing more.
    assert.deepEqual(rows.get(d.key.ambiguous).startedBy, { text: 'started by a program', evidence: 'recorded', launch: { ambiguous: true, launches: { value: 2, evidence: 'inferred' }, evidence: 'inferred', rule: 'launch.same-folder' } });
    assert.deepEqual(rows.get(d.key.hookSilent).startedBy, { text: 'started by a program', evidence: 'recorded' });
    assert.deepEqual(rows.get(d.key.codexPlain).startedBy, { text: 'started by codex exec, no prompt', evidence: 'recorded' });
    assert.equal(rows.get(d.key.codexByText).startedBy.launch.evidence, 'derived');
    // Find's Recent card carries the same.
    const home = await ask('/api/home');
    const recent = home.recent.filter((r) => r.startedBy?.launch?.session);
    assert.ok(recent.length && recent.every((r) => rows.get(r.session).startedBy.launch.event === r.startedBy.launch.event));
    // Replay: the launching session's steps name the runs they started; a run names its launcher.
    const parent = await ask('/api/replay', { session: d.key.launcher });
    const started = Object.values(parent.launch.started).flat();
    assert.deepEqual(started.map((s) => s.session).sort(), [d.key.byId, d.key.byText, d.key.byTime, d.key.codexByText].sort());
    assert.ok(Object.keys(parent.launch.started).every((id) => parent.events.some((e) => e.id === id)));
    assert.equal(started.find((s) => s.session === d.key.byId).label, '/review, Jun 11, 3:01 PM');
    const child = await ask('/api/replay', { session: d.key.byId });
    assert.equal(child.launch.by[d.key.byId].event, l.launch.event);
    assert.deepEqual(child.launch.started, {});
    // A replay with no launch link in it has no launch field at all.
    assert.equal('launch' in (await ask('/api/replay', { session: d.key.codexPlain })), false);
  } finally {
    data.stop();
  }
});
