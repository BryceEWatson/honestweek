// The engine's hiddenSessions option. Sessions outside the configured repos and in
// display-role ones are skeletons by default; with hiddenSessions 'redacted' they keep
// their content, every string through the full redactor, and still stay out of every
// link, goal-id scan, lookup and git read.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createRedactor } from '../lib/redact.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { buildCorpus, CODENAME, ME, PRIVATE_TEXT, at } from './fixtures/replay/corpus.mjs';
import { buildDemoWeek, SESSION_IDS, WEEK } from '../tools/demo-week.mjs';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

// Made up for this test: a client name, a person, their address, and a file in a home
// folder. The folder is a fixed one rather than the home of whoever runs the suite, whose
// shape (such as /root) the redactor may not know as a home folder.
const CLIENT = 'Quillon Labs';
const PERSON = 'Pat Vexmoor';
const ADDRESS = 'pat.vexmoor@example.net';
const HOME_FILE = '/home/alex/notes/quillon-plan.md';
const OUTSIDE_ID = '12121212-3434-4565-8787-909090909090';

let fx;
let demoDir;
let k;
let base;
let queries;
let plain;
let shown;
let gitPlain;
let gitShown;

/** Every child process the engine starts while `fn` runs, through the module's own exports. */
async function recordProcesses(fn) {
  const calls = [];
  const names = ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'execSync', 'exec'];
  const original = Object.fromEntries(names.map((n) => [n, childProcess[n]]));
  for (const n of names) {
    childProcess[n] = function recorded(...args) {
      const opts = args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a)) ?? {};
      calls.push({ name: n, file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [], cwd: opts.cwd ? String(opts.cwd) : null });
      return original[n].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try {
    return { result: await fn(), calls };
  } finally {
    Object.assign(childProcess, original);
    syncBuiltinESMExports();
  }
}

const norm = (p) => {
  const r = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (p, dir) => norm(p) === norm(dir) || norm(p).startsWith(`${norm(dir)}/`);
/** The folder a recorded git call worked in: its -C argument, else its cwd. */
const gitDirOf = (c) => {
  const i = c.args.indexOf('-C');
  return i !== -1 ? c.args[i + 1] : c.cwd;
};

/** A session outside every configured repo whose prompt holds everything private. */
function writeOutsideSession() {
  const cwd = join(fx.root, 'outside-extra');
  mkdirSync(cwd, { recursive: true });
  const rec = (type, extra, t, n) => JSON.stringify({ type, sessionId: OUTSIDE_ID, cwd, version: '2.1.0', gitBranch: '', uuid: `${OUTSIDE_ID.slice(0, 24)}${String(n).padStart(12, '0')}`, timestamp: t, ...extra });
  const prompt = `Plan the ${CLIENT} rollout with ${PERSON} (${ADDRESS}); the notes are in ${HOME_FILE}. ${'Keep the checklist short. '.repeat(30)}${CLIENT} signs off on ${CODENAME}.`;
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: `${CLIENT} rollout`, sessionId: OUTSIDE_ID }),
    rec('user', { message: { role: 'user', content: prompt }, origin: { kind: 'human' } }, at(60), 1),
    rec('assistant', { message: { id: 'msg-outside-1', model: 'model-a', role: 'assistant', content: [{ type: 'text', text: `Drafted the plan for ${CLIENT}; mailed ${ADDRESS}.` }, { type: 'tool_use', id: 'tu-outside-1', name: 'Bash', input: { command: `cat ${HOME_FILE} && gh pr view 7`, description: `Read ${PERSON}'s notes` } }] } }, at(61), 2),
    rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-outside-1', content: 'ok' }] }, toolUseResult: { stdout: 'ok', stderr: '', interrupted: false } }, at(62), 3),
    rec('assistant', { message: { id: 'msg-outside-2', model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-outside-2', name: 'Read', input: { file_path: HOME_FILE } }] } }, at(63), 4),
    rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-outside-2', content: 'notes' }] } }, at(64), 5),
  ];
  mkdirSync(join(fx.claudeRoot, 'proj-outside'), { recursive: true });
  writeFileSync(join(fx.claudeRoot, 'proj-outside', `${OUTSIDE_ID}.jsonl`), `${lines.join('\n')}\n`);
  return claudeSessionKey('proj-outside', OUTSIDE_ID);
}

before(async () => {
  fx = buildCorpus({ goals: true });
  k = Object.fromEntries(['C', 'D', 'Q', 'O'].map((n) => [n, claudeSessionKey(fx.dirs[n], fx.ids[n])]));
  k.outside = writeOutsideSession();
  const config = { ...fx.config, redaction: { codenames: [CODENAME], names: [PERSON], terms: [CLIENT] } };
  base = { config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, scope: 'all', goals: fx.goalRecord };
  // Lookups for pull requests, commits (the display-role repo's own among them), a file
  // and a branch: each can make the engine ask git.
  queries = ['#7', '#8', '#9', '#11', '#31', 'your-project#7', 'your-project#8', 'example/your-project#7', fx.repo.squashSha.slice(0, 10), fx.displaySha.slice(0, 10), fx.displaySquashSha.slice(0, 10), 'lib/widget.mjs', 'feature/widget'];
  // Everything a page could ask of a history, run while child processes are recorded.
  const exercise = async (opts) => {
    const h = await buildWorkHistory(opts);
    const lookups = Object.fromEntries(queries.map((q) => [q, h.lookup(q)]));
    const goals = Object.fromEntries(h.goals.map((g) => [g.id, h.goal(g.id)]));
    const records = Object.fromEntries(h.events.map((e) => [e.id, h.record(e.id)]));
    const sessions = Object.fromEntries(h.sessions.map((s) => [s.key, h.session(s.key)]));
    return Object.assign(h, { run: { lookups, goals, records, sessions } });
  };
  ({ result: plain, calls: gitPlain } = await recordProcesses(() => exercise(base)));
  ({ result: shown, calls: gitShown } = await recordProcesses(() => exercise({ ...base, hiddenSessions: 'redacted' })));
});
after(() => {
  for (const dir of [fx?.root, demoDir]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold a lock on .git briefly */
    }
  }
});

const PRIVATE_SESSIONS = () => [k.C, k.D, k.Q, k.O, k.outside];
const promptOf = (h, session) => h.events.find((e) => e.session === session && e.kind === 'prompt');

/** Every way the private values could show: configured words in any case, the address,
 *  and the home folder in either slash direction. */
function assertNothingPrivate(text, where) {
  const lower = text.toLowerCase();
  for (const word of [CODENAME, 'Quillon', 'Vexmoor', ADDRESS, ME, '/home/alex']) assert.ok(!lower.includes(word.toLowerCase()), `${where} shows ${word}`);
  if (!SUITE_HOME) return;
  for (const h of [SUITE_HOME, SUITE_HOME.replace(/\\/g, '/'), SUITE_HOME.replace(/\\/g, '\\\\'), JSON.stringify(SUITE_HOME).slice(1, -1)]) assert.ok(!lower.includes(h.toLowerCase()), `${where} shows the home folder`);
}
// The suite's own home folder, which fixture folders can sit under, checked when the
// redactor knows its shape as a home folder.
const SUITE_HOME = createRedactor({}).redact(homedir()) === homedir() ? null : homedir();

test('hiddenSessions absent or "skeleton" builds the same history, byte for byte', async () => {
  assert.equal(JSON.stringify(await buildWorkHistory({ ...base, hiddenSessions: 'skeleton' })), JSON.stringify(plain));
  assert.equal('hiddenSessions' in plain, false);
});

test('hiddenSessions takes only "skeleton" or "redacted"', async () => {
  for (const bad of ['shown', true, 'Redacted', null]) await assert.rejects(buildWorkHistory({ ...base, hiddenSessions: bad }), /hiddenSessions is 'skeleton' or 'redacted'/, String(bad));
});

test('"redacted": display-role and outside sessions keep their text and titles, redacted', () => {
  assert.equal(shown.hiddenSessions, 'redacted');
  for (const key of PRIVATE_SESSIONS()) {
    assert.equal(shown.sessions.find((s) => s.key === key)?.private, true, `${key} is still a private session`);
    assert.equal(promptOf(plain, key).facts.text ?? null, null, 'a skeleton by default');
    assert.equal(typeof promptOf(shown, key).facts.text, 'string', `${key} keeps its prompt`);
  }
  assert.match(promptOf(shown, k.C).facts.text, new RegExp(`${PRIVATE_TEXT} please fix the invoice export`), 'unconfigured words show');
  assert.equal(promptOf(shown, k.D).facts.text, 'unrelated work');
  const outside = promptOf(shown, k.outside).facts.text;
  assert.match(outside, /^Plan the \[redacted:term\] rollout with \[redacted:term\] \(\[redacted:email\]\); the notes are in \[redacted:path\]/);
  assert.ok(outside.endsWith('…'), 'the long prompt is cut');
  assert.equal(shown.sessions.find((s) => s.key === k.outside).title, '[redacted:term] rollout');
  assert.equal(plain.sessions.find((s) => s.key === k.outside).title, null);
  // A re-read record of a private session is the record itself, redacted, not its shape.
  const [r] = shown.record(promptOf(shown, k.outside).id);
  assert.equal(r.verified, true);
  assert.ok(!('private' in r.record));
  assert.match(JSON.stringify(r.record), /Plan the \[redacted:term\] rollout/);
});

test('"redacted": no configured word, address or home folder in any string the history holds', () => {
  assertNothingPrivate(JSON.stringify(shown), 'the history');
  for (const [part, values] of Object.entries(shown.run)) for (const [id, v] of Object.entries(values)) assertNothingPrivate(JSON.stringify(v), `${part} ${id}`);
  assert.equal(Object.keys(shown.run.records).length, shown.events.length);
  // Failing-path partner: the logs hold every one of those values, so the check can fail.
  const raw = readFileSync(join(fx.claudeRoot, 'proj-outside', `${OUTSIDE_ID}.jsonl`), 'utf8');
  for (const value of [CLIENT, PERSON, ADDRESS, CODENAME]) assert.ok(raw.includes(value), value);
  assert.ok(raw.includes(JSON.stringify(HOME_FILE).slice(1, -1)));
  assert.throws(() => assertNothingPrivate(raw, 'the raw log'));
});

test('"redacted": a hidden session keeps no hash of a raw path or prompt', () => {
  const hashes = (h, keys) => h.events.filter((e) => keys.includes(e.session) && ['fileKey', 'fileKeys', 'promptDigest'].some((x) => x in e.facts));
  const read = shown.events.find((e) => e.session === k.outside && e.facts.tool === 'Read');
  assert.equal(typeof read?.facts.file, 'string', 'the outside session shows its read, path cut to its shape');
  assert.deepEqual(hashes(shown, PRIVATE_SESSIONS()), []);
  // Failing-path partner: a configured session keeps them, since lookup by file reads them.
  const configured = shown.sessions.filter((s) => !s.private).map((s) => s.key);
  assert.ok(hashes(shown, configured).length > 0);
});

test('"redacted": the sessions, links, threads, goal members and lookups are the default build\'s', () => {
  const sessionShape = (h) => h.sessions.map(({ title: _t, ...rest }) => rest);
  assert.deepEqual(sessionShape(shown), sessionShape(plain));
  assert.deepEqual(shown.links, plain.links);
  assert.deepEqual(shown.threads, plain.threads);
  assert.deepEqual(shown.sources, plain.sources, 'the same repositories were read by git');
  assert.deepEqual(shown.gitNotes, plain.gitNotes);
  assert.deepEqual(shown.skipped, plain.skipped);
  assert.deepEqual(shown.goals, plain.goals);
  assert.deepEqual(shown.run.goals, plain.run.goals);
  for (const q of queries) assert.deepEqual(shown.run.lookups[q], plain.run.lookups[q], `lookup ${q}`);
  assert.ok(plain.run.lookups['#7'].sessions.length > 0, 'the lookups find sessions');
  const outcomes = (h) => h.events.filter((e) => e.kind === 'outcome').map((e) => [e.id, e.facts.outcome, e.facts.sha ?? null]);
  assert.deepEqual(outcomes(shown), outcomes(plain));
  // No private session is any goal's member, and none is linked to the others.
  for (const g of shown.goals) for (const m of g.members) assert.ok(!PRIVATE_SESSIONS().includes(m.session), `${m.session} joined ${g.id}`);
  for (const l of shown.links) for (const end of [l.from, l.to]) assert.ok(!PRIVATE_SESSIONS().some((key) => String(end).startsWith(key)), `a link touches ${end}`);
});

test('"redacted": git is never run against a display-role repo, and runs exactly as by default', () => {
  const display = fx.config.repos.find((r) => r.role === 'display');
  const displayDir = display.resolvedPath ?? display.path;
  const gitCalls = gitShown.filter((c) => /(^|[\\/])git(\.exe)?$/i.test(c.file));
  // Failing-path partner: the recorder sees the git calls made for the featured repo.
  assert.ok(gitCalls.some((c) => gitDirOf(c) && inside(gitDirOf(c), fx.repo.dir)), 'git calls for the featured repository were recorded');
  for (const c of gitCalls) assert.ok(!(gitDirOf(c) && inside(gitDirOf(c), displayDir)), `git ran in the display-role repo: ${c.args.join(' ')}`);
  for (const c of gitShown) assert.ok(!c.cwd || !inside(c.cwd, displayDir), 'a process started in the display-role repo');
  const shape = (calls) => calls.map((c) => [c.name, c.file, c.args, c.cwd]);
  assert.deepEqual(shape(gitShown), shape(gitPlain));
});

test('"redacted": the history serializes; with privateText too it still refuses', async () => {
  const json = JSON.parse(JSON.stringify(shown));
  assert.equal(json.hiddenSessions, 'redacted');
  assert.equal(json.sessions.length, plain.sessions.length);
  const both = await buildWorkHistory({ ...base, hiddenSessions: 'redacted', privateText: true });
  assert.throws(() => JSON.stringify(both), /local screen only/);
  // privateText already shows private content; hiddenSessions doesn't change what it shows.
  const local = await buildWorkHistory({ ...base, privateText: true });
  assert.deepEqual(both.events.map((e) => e.facts), local.events.map((e) => e.facts));
});

test('"redacted" over the demo week: the display-only site session and the outside session show, redacted', async () => {
  demoDir = mkdtempSync(join(tmpdir(), 'hw-hidden-sessions-'));
  const d = buildDemoWeek({ root: join(demoDir, 'week') });
  const config = { ...d.config, redaction: { codenames: [], names: [], terms: ['personal-site', 'screenshots'] } };
  const opts = { config, from: WEEK.from, to: WEEK.to, roots: d.roots, scope: 'all', goals: d.goalRecord };
  const def = await buildWorkHistory(opts);
  const red = await buildWorkHistory({ ...opts, hiddenSessions: 'redacted' });
  const site = claudeSessionKey(d.ids.projectDirs.site, SESSION_IDS.sitePost);
  const scratch = claudeSessionKey(d.ids.projectDirs.scratch, SESSION_IDS.scratch);
  for (const key of [site, scratch]) {
    assert.equal(def.sessions.find((s) => s.key === key).title, null);
    assert.equal(typeof red.sessions.find((s) => s.key === key).title, 'string');
    assert.equal(typeof promptOf(red, key).facts.text, 'string');
  }
  assert.match(promptOf(red, scratch).facts.text, /renames the \[redacted:term\] in this folder/);
  const json = JSON.stringify(red).toLowerCase();
  for (const word of ['personal-site', 'screenshots']) assert.ok(!json.includes(word), `the demo history shows ${word}`);
  for (const e of red.events) assert.ok(!/personal-site|screenshots/i.test(JSON.stringify(red.record(e.id))), `record ${e.id}`);
  assert.deepEqual(red.links, def.links);
  assert.deepEqual(red.goals, def.goals);
  for (const q of ['#12', '#13', '#14', '#15', 'src/format.js']) assert.deepEqual(red.lookup(q), def.lookup(q), `lookup ${q}`);
});
