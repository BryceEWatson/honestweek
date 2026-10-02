// "Show private text": the secrets-only scrubber and the engine's privateText option.
// On a person's own screen, names, folders, addresses, ids and numbers show as written
// while secrets stay hidden; which sessions are linked, scanned for goal ids, or sent to
// git doesn't change; and nothing built this way can be serialized whole or reached from
// a command that writes files.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRedactor, createSecretsOnlyRedactor } from '../lib/redact.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { buildDemoWeek, SESSION_IDS, WEEK } from '../tools/demo-week.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Secrets, each of which must stay hidden in every mode.
const SECRETS = {
  apiKey: 'sk-abcdefghijklmnop1234567890',
  github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
  password: 'hunter2',
  bearer: 'abcdefgh12345678',
  urlPassword: 'swordfish',
  shortKey: 'shortkey99',
  opaque: 'Zx9QwErTyUiOp1234AsDfGhJkL5678ZxCvBnM',
  awsStyle: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1',
  hex64: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
};
// Private text the full redactor hides and the secrets-only scrubber shows.
const PRIVATE = {
  term: 'Northwind',
  email: 'alex@example.org',
  path: '/home/alex/code/northwind-app',
  uuid: '0a1b2c3d-1111-2222-3333-444455556666',
  number: '123456789012',
  sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  folder: 'claude/worktrees/quiet-river-20c28a/lib/replay/index',
};

const SEEDED = [
  `Ship the ${PRIVATE.term} report from ${PRIVATE.path} and mail ${PRIVATE.email}.`,
  `Session ${PRIVATE.uuid}, invoice ${PRIVATE.number}, commit ${PRIVATE.sha}, folder .${PRIVATE.folder}.mjs.`,
  `Use API_KEY=${SECRETS.apiKey} and token ${SECRETS.github} and ${SECRETS.jwt}.`,
  `The config says {"password": "${SECRETS.password}"} and the header is Authorization: Bearer ${SECRETS.bearer}.`,
  `Clone https://alex:${SECRETS.urlPassword}@git.example.com/repo with x-api-key: ${SECRETS.shortKey}.`,
  `Opaque ${SECRETS.opaque}, aws ${SECRETS.awsStyle}, hex ${SECRETS.hex64}.`,
].join('\n');

const assertNoSecrets = (text, where) => {
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!text.includes(value), `${where}: the ${name} secret leaked`);
};

// ---- the scrubber ---------------------------------------------------------------------

test('secrets-only: hides every secret and shows names, folders, addresses, ids and numbers', () => {
  const out = createSecretsOnlyRedactor().redact(SEEDED);
  assertNoSecrets(out, 'secrets-only');
  for (const [name, value] of Object.entries(PRIVATE)) assert.ok(out.includes(value), `the ${name} should show: ${out}`);
  assert.match(out, /API_KEY=\[redacted:secret\]/);
  assert.match(out, /"password": "\[redacted:secret\]"/);
  assert.match(out, /Authorization: \[redacted:secret\]/);
  assert.match(out, /https:\/\/alex:\[redacted:secret\]@git\.example\.com/);
});

test('the full redactor still hides all of it (unchanged)', () => {
  const out = createRedactor({ redaction: { terms: [PRIVATE.term] } }).redact(SEEDED);
  for (const name of ['term', 'email', 'path', 'uuid', 'number']) assert.ok(!out.includes(PRIVATE[name]), `full redactor shows the ${name}`);
});

test('secrets-only: sensitive fields in their common spellings', () => {
  const r = createSecretsOnlyRedactor();
  const cases = [
    ['export DB_PASS=xyz FOO=1', 'export DB_PASS=[redacted:secret] FOO=1'],
    ['$env:API_KEY = "abc"', '$env:API_KEY = "[redacted:secret]"'],
    ["password='a b'", "password='[redacted:secret]'"],
    ['client_secret: s3cr3t,', 'client_secret: [redacted:secret],'],
    [JSON.stringify(JSON.stringify({ password: 'hunter 2', note: 'ok' })), JSON.stringify(JSON.stringify({ password: '[redacted:secret]', note: 'ok' }))],
    ['Cookie: sid=abc123', 'Cookie: [redacted:secret]'],
  ];
  for (const [input, expected] of cases) assert.equal(r.redact(input), expected);
});

test('secrets-only: ordinary keys and words are left alone', () => {
  const r = createSecretsOnlyRedactor();
  for (const s of ['max_tokens: 4096, author: alex, secrets: 3', 'passing: 12', 'auth flow works', 'tokens=5', 'https://git.example.com:8080/repo']) {
    assert.equal(r.redact(s), s);
  }
});

test('secrets-only: idempotent, keeps placeholders, counts, and has the redactor shape', () => {
  const r = createSecretsOnlyRedactor();
  assert.deepEqual(Object.keys(r).sort(), ['count', 'deepRedact', 'redact']);
  const once = r.redact(SEEDED);
  assert.equal(r.redact(once), once);
  assert.equal(r.redact('token: [redacted:secret]'), 'token: [redacted:secret]');
  assert.ok(r.count > 0);
  assert.deepEqual(r.deepRedact({ a: [`API_KEY=${SECRETS.apiKey}`], n: 3 }), { a: ['API_KEY=[redacted:secret]'], n: 3 });
});

test('secrets-only: stays fast on long adversarial inputs', () => {
  const r = createSecretsOnlyRedactor();
  const inputs = ['a:'.repeat(50000), 'password:"'.repeat(20000), `${'x-'.repeat(50000)}token`, `http://${'a'.repeat(100000)}`, 'a-token-'.repeat(20000), `https://a:${'b'.repeat(100000)}`, 'token: '.repeat(20000), `${'ab/'.repeat(40000)}1`];
  for (const input of inputs) {
    const started = Date.now();
    r.redact(input);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms on a ${input.length}-character input`);
  }
});

// ---- the engine, over the synthetic demo week ------------------------------------------

let d;
const scratch = [];
const key = {};
let plain;
let shown;

// A task suggestion the display-role session makes, and a later session started from it.
const HANDOFF = 'Pick up the site follow-up from the earlier session.';

/** A Claude Code session with one seeded prompt, in a demo project folder. With
 *  `suggest`, it also makes a task suggestion (a hand-off chip) with that prompt. */
function seedSession(projectDir, cwd, id, { prompt = SEEDED, start = '10:00', suggest = null } = {}) {
  const at = (s) => `2025-03-12T${start}:${String(s).padStart(2, '0')}.000Z`;
  const rec = (type, extra, t) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.0', gitBranch: 'main', type, uuid: `${id.slice(0, 8)}-0000-4000-8000-${t.replace(/\D/g, '').slice(-12)}`, timestamp: t, ...extra });
  const say = (content, t) => rec('assistant', { message: { id: `msg_${t.replace(/\D/g, '')}`, type: 'message', role: 'assistant', model: 'model-a', content } }, t);
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: `${PRIVATE.term} follow-up`, sessionId: id }),
    rec('user', { message: { role: 'user', content: prompt }, origin: { kind: 'human' } }, at(0)),
    say([{ type: 'text', text: `Done for ${PRIVATE.term}.` }], at(5)),
  ];
  if (suggest) {
    lines.push(say([{ type: 'tool_use', id: 'toolu_seed_chip', name: 'mcp__ccd_session__spawn_task', input: { title: 'Site follow-up', prompt: suggest } }], at(10)));
    lines.push(rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_seed_chip', content: 'Suggested.' }] }, toolUseResult: { ok: true } }, at(11)));
  }
  writeFileSync(join(d.roots.claude[0], projectDir, `${id}.jsonl`), `${lines.join('\n')}\n`);
  return claudeSessionKey(projectDir, id);
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-private-text-'));
  scratch.push(dir);
  d = buildDemoWeek({ root: join(dir, 'week') });
  const cwdOf = (projectDir, sessionId) => JSON.parse(readFileSync(join(d.roots.claude[0], projectDir, `${sessionId}.jsonl`), 'utf8').split('\n').find((l) => l.includes('"cwd"'))).cwd;
  const dirs = d.ids.projectDirs;
  key.featured = seedSession(dirs.lantern, cwdOf(dirs.lantern, SESSION_IDS.sinceFlag), '11111111-2222-4333-8444-555555555555');
  key.display = seedSession(dirs.site, cwdOf(dirs.site, SESSION_IDS.sitePost), '66666666-7777-4888-8999-aaaaaaaaaaaa', { suggest: HANDOFF });
  key.started = seedSession(dirs.lantern, cwdOf(dirs.lantern, SESSION_IDS.sinceFlag), 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', { prompt: HANDOFF, start: '10:30' });
  const config = { ...d.config, redaction: { codenames: [], names: [], terms: [PRIVATE.term] } };
  const options = { config, from: WEEK.from, to: WEEK.to, roots: d.roots, scope: 'all', goals: d.goalRecord };
  plain = await buildWorkHistory(options);
  shown = await buildWorkHistory({ ...options, privateText: true });
});
after(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold a lock on .git briefly */
    }
  }
});

const promptOf = (h, session) => h.events.find((e) => e.session === session && e.kind === 'prompt');

test('engine: the default build redacts the seeded session as before', () => {
  const text = promptOf(plain, key.featured).facts.text;
  // The full redactor's own secret rules (KEY=VALUE only, no "key": "value" or Bearer form).
  for (const name of ['apiKey', 'github', 'jwt', 'urlPassword', 'opaque', 'awsStyle', 'hex64']) assert.ok(!text.includes(SECRETS[name]), `default build: the ${name} secret leaked`);
  for (const name of ['term', 'email', 'path', 'uuid', 'number']) assert.ok(!text.includes(PRIVATE[name]), `default build shows the ${name}`);
  assert.equal(promptOf(plain, key.display).facts.text ?? null, null, 'a display-role session is a content-free skeleton by default');
  assert.equal(plain.sessions.find((s) => s.key === key.display).title, null);
  assert.equal('privateText' in plain, false);
});

test('engine: privateText shows private text and hides secrets, in readable and display-role sessions alike', () => {
  for (const session of [key.featured, key.display]) {
    const text = promptOf(shown, session).facts.text;
    assertNoSecrets(text, session);
    for (const name of ['term', 'email', 'path', 'uuid', 'number', 'sha']) assert.ok(text.includes(PRIVATE[name]), `${session} should show the ${name}`);
    assert.equal(shown.sessions.find((s) => s.key === session).title, `${PRIVATE.term} follow-up`);
  }
  assert.equal(shown.privateText, true);
});

test('engine: privateText re-reads a display-role record with its content, secrets hidden', () => {
  const e = promptOf(shown, key.display);
  const [r] = shown.record(e.id);
  assert.equal(r.verified, true);
  const body = JSON.stringify(r.record);
  assert.ok(!('private' in r.record), 'not the shape-only stand-in');
  assert.ok(body.includes(PRIVATE.term));
  assertNoSecrets(body, 'record');
  const [hidden] = plain.record(promptOf(plain, key.display).id);
  assert.match(hidden.record.private, /only the record shape is shown/);
});

test('engine: privateText leaves every link, lookup, goal and git read as it was', () => {
  const ids = (h) => h.events.map((e) => `${e.id}:${e.kind}:${e.session}`);
  assert.deepEqual(ids(shown), ids(plain));
  assert.deepEqual(shown.links, plain.links);
  assert.deepEqual(shown.threads, plain.threads);
  assert.deepEqual(shown.sessions.map((s) => [s.key, s.private, s.repoRole, s.thread]), plain.sessions.map((s) => [s.key, s.private, s.repoRole, s.thread]));
  assert.deepEqual(shown.sources, plain.sources, 'the same repositories were read by git');
  assert.deepEqual(shown.gitNotes, plain.gitNotes);
  const outcomes = (h) => h.events.filter((e) => e.kind === 'outcome').map((e) => [e.id, e.facts.outcome, e.facts.sha ?? null]);
  assert.deepEqual(outcomes(shown), outcomes(plain));
  const members = (h) => h.goals.map((g) => [g.id, g.members.map((m) => [m.session, m.evidence, m.joins.map((j) => [j.type, j.evidence, j.rule ?? null, j.event])])]);
  assert.deepEqual(members(shown), members(plain));
  for (const q of ['#7', '#12', 'src/format.js']) {
    const keys = (h) => h.lookup(q).sessions.map((s) => s.session ?? s.key);
    assert.deepEqual(keys(shown), keys(plain), `lookup ${q}`);
  }
  // The display-role session is still never readable for links: its task suggestion
  // shows, but the session started from it isn't linked to it.
  assert.equal(shown.sessions.find((s) => s.key === key.display).private, true);
  const chip = shown.events.find((e) => e.session === key.display && e.facts.category === 'handoff');
  assert.equal(chip.facts.title, 'Site follow-up');
  assert.equal(shown.sessions.find((s) => s.key === key.started).startedFrom, null);
});

test('engine: a privateText history refuses to serialize whole', () => {
  assert.throws(() => JSON.stringify(shown), /local screen only/);
  assert.doesNotThrow(() => JSON.stringify(plain));
});

test('engine: privateText false or absent is byte-identical', async () => {
  const options = { config: d.config, from: WEEK.from, to: WEEK.to, roots: d.roots, goals: d.goalRecord };
  const a = JSON.stringify(await buildWorkHistory(options));
  const b = JSON.stringify(await buildWorkHistory({ ...options, privateText: false }));
  assert.equal(a, b);
});

// ---- no command that writes or publishes can reach it -----------------------------------

test('only the redactor and the work-history engine name privateText or the secrets-only scrubber', () => {
  const allowed = new Set(['lib/redact.mjs', 'lib/replay/index.mjs', 'lib/replay/claude.mjs', 'lib/replay/codex.mjs', 'lib/replay/assemble.mjs']);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js|cjs)$/.test(name) && /privateText|createSecretsOnlyRedactor/.test(readFileSync(p, 'utf8'))) found.push(relative(ROOT, p).split(/[\\/]/).join('/'));
    }
  };
  for (const dir of ['bin', 'lib', 'tools']) walk(join(ROOT, dir));
  assert.deepEqual(found.filter((f) => !allowed.has(f)), [], 'a new caller of the local-only mode needs a review that it never writes or publishes');
});
