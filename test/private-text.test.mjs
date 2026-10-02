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
import { parseClaudeSource } from '../lib/replay/claude.mjs';
import { createWatch } from '../lib/replay/parse-common.mjs';
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
    ['client_secret: s3cr3t, then more', 'client_secret: [redacted:secret], then more'],
    [JSON.stringify(JSON.stringify({ password: 'hunter 2', note: 'ok' })), JSON.stringify(JSON.stringify({ password: '[redacted:secret]', note: 'ok' }))],
    [JSON.stringify({ password: 'hun"ter2', note: 'ok' }), JSON.stringify({ password: '[redacted:secret]', note: 'ok' })],
    ['Cookie: sid=abc123; theme=dark', 'Cookie: [redacted:secret]'],
    ['{"token":12345,"x":1}', '{"token":[redacted:secret],"x":1}'],
  ];
  for (const [input, expected] of cases) assert.equal(r.redact(input), expected);
});

test('secrets-only: hides what the independent review found shown, and what the full redactor hides', () => {
  const H = 'hunter2';
  const T = 'abcdefgh12345678';
  const U = '0a1b2c3d-1111-2222-3333-444455556666';
  const cases = [
    [`mysql -u root --password=${H} db`, H],
    [`deploy --token=${T}`, T],
    [`login --client-secret=${T}`, T],
    [`docker login --password ${H}`, H],
    [`tool --api-key ${U}`, U],
    [`Connect-Thing -Password ${H}`, H],
    [`password := "${H}"`, H],
    [`if password == "${H}":`, H],
    [`const password: string = "${H}";`, H],
    [`PASSWORD ?= ${H}`, H],
    [`{"dbPassword": "${H}"}`, H],
    [`accessToken = "${T}"`, T],
    [`PGPASSWORD=${H} psql -h localhost`, H],
    [`MYSQL_PWD=${H} mysql`, H],
    [`ENCRYPTION_KEY=${T}`, T],
    [`//registry.npmjs.org/:_authToken=${U}`, U],
    [`authorization: bearer ${T}`, T],
    [`AUTHORIZATION: BEARER ${T}`, T],
    [`Authorization: token ${T}`, T],
    [`curl -H "X-Foo: bearer ${T}"`, T],
    [`Cookie: a=1; session=${H}`, H],
    [`redis://:${H}@localhost:6379/0`, H],
    [`curl -u admin:${H} https://example.com`, H],
    [`password: ${H} horse battery staple`, 'horse battery staple'],
    [`password:\u00a0${H}`, H],
    [`ConvertTo-SecureString "${H}" -AsPlainText -Force`, H],
    [`MYSQL_ROOT_PASSWORD=Xk9;mP2,qRz`, 'mP2,qRz'],
    [`DB_PASSWORD={Xk9mP2qRz}`, 'Xk9mP2qRz'],
    [`API_TOKEN=ab]cd9xyz`, 'cd9xyz'],
    [`password: Xk9,mP2qRz`, 'mP2qRz'],
    [`https://files.example.com/x.zip?X-Amz-Signature=${T}&sig=${H}`, T],
    [`https://files.example.com/x.zip?sig=${H}`, H],
    [`curl https://api.example.com/hooks/${SECRETS.hex64}`, SECRETS.hex64],
    ['see .../k/abcd1234efgh5678ijkl9012mnop3456qrst', 'abcd1234efgh5678ijkl9012mnop3456qrst'],
  ];
  const so = createSecretsOnlyRedactor();
  for (const [input, secret] of cases) assert.ok(!so.redact(input).includes(secret), `${input} -> ${so.redact(input)}`);
  // Every secret form the full redactor hides stays hidden here too.
  const full = createRedactor({});
  for (const input of [`mysql --password=${H}`, `deploy --token=${T}`, `MYSQL_ROOT_PASSWORD=Xk9;mP2,qRz`, `x ${SECRETS.opaque} ${SECRETS.jwt}`]) {
    const hiddenByFull = input.split(/\s+/).filter((w) => w && !full.redact(w).includes(w));
    for (const w of hiddenByFull) assert.ok(!so.redact(input).includes(w), `${w} is hidden by the full redactor but shown here`);
  }
});

test('secrets-only: a record read back as JSON hides values whose own key is sensitive', () => {
  const r = createSecretsOnlyRedactor();
  const out = r.deepRedact({ headers: { 'x-api-key': 'shortkey99', Accept: 'json' }, password: 'hunter2', dbPassword: 'hunter3', note: 'ok', count: 3, auth: true, list: [{ token: 'abc123' }] });
  assert.deepEqual(out, { headers: { 'x-api-key': '[redacted:secret]', Accept: 'json' }, password: '[redacted:secret]', dbPassword: '[redacted:secret]', note: 'ok', count: 3, auth: true, list: [{ token: '[redacted:secret]' }] });
  // The engine's own id fields end in "Key" and must survive; a named key kind doesn't.
  const ids = { fileKey: 'k-abc', sessionKey: 'cc-abc', statusKey: 'progress', weekStartKey: '2025-03-10', ENCRYPTION_KEY: 'abcdefgh12345678', signingKey: 'xyz' };
  assert.deepEqual(r.deepRedact(ids), { ...ids, ENCRYPTION_KEY: '[redacted:secret]', signingKey: '[redacted:secret]' });
});

test('engine: privateText keeps every fact the full build keeps that isn\'t text (file keys, ids, commit ids)', () => {
  const structural = (h) => h.events.map((e) => JSON.stringify({ id: e.id, fileKey: e.facts.fileKey ?? null, fileKeys: e.facts.fileKeys ?? null, sha: e.facts.sha ?? null, pr: e.facts.pr ?? null, action: e.facts.action ?? null }));
  const readable = new Set(plain.sessions.filter((s) => !s.private).map((s) => s.key));
  const pick = (h) => structural({ events: h.events.filter((e) => readable.has(e.session)) });
  assert.deepEqual(pick(shown), pick(plain));
  assert.ok(plain.events.some((e) => e.facts.fileKey), 'the demo week has file keys to compare');
});

test('secrets-only: long runs made of words show, random tokens of the same length stay hidden', () => {
  const r = createSecretsOnlyRedactor();
  for (const s of ['C--Users-alex-Projects-your-project--claude-worktrees-quiet-river-20c28a', 'https://github.com/AlexJordan/your-project/pull/73', 'C:/Users/alex/AppData/Local/Temp/claude/C--Users-alex-Projects', '.claude/handoffs/20261002T212500Z_find-and-check-continue.md']) {
    assert.equal(r.redact(s), s);
  }
  for (const s of [SECRETS.awsStyle, SECRETS.opaque, 'Ab3dEf9hIj-Kl2nOp5rSt_Uv8xYz1bCd4fGh7jKl', `dop_v1_${SECRETS.hex64}`]) assert.ok(!r.redact(s).includes(s), s);
});

test('secrets-only: ordinary prose and code around a sensitive word stay readable', () => {
  const r = createSecretsOnlyRedactor();
  const kept = [
    ['Fix the login bug. Auth: users get logged out after five minutes when they refresh.', 'get logged out after five minutes when they refresh'],
    ['I updated the token refresh. Token: it now refreshes a minute before expiry.', 'now refreshes a minute before expiry'],
    ['function login(user: string, password: string): Promise<Session> { return api(user) }', '): Promise<Session> { return api(user) }'],
    ['ran the suite: pass: 793, fail: 0, skipped: 2', 'pass: 793, fail: 0, skipped: 2'],
    ['meta: { requiresAuth: true, layout: wide }', 'requiresAuth: true, layout: wide'],
    ['edited deploy/k8s/overlays/production2/kustomization and src/i18n/locales/en/messages2', 'deploy/k8s/overlays/production2/kustomization and src/i18n/locales/en/messages2'],
  ];
  for (const [input, part] of kept) assert.ok(r.redact(input).includes(part), `${input} -> ${r.redact(input)}`);
  // Free-text keys (answers keyed by the question) keep their answers in a re-read record.
  const answers = { 'Which auth method should we use?': 'OAuth with PKCE', 'Should I pass the failing tests through?': 'No, fix them first' };
  assert.deepEqual(r.deepRedact({ answers }), { answers });
});

test('secrets-only: the second review round: run-together keys, ===, typed values, quotes and numbers', () => {
  const r = createSecretsOnlyRedactor();
  const H = 'hunter2';
  for (const [input, secret] of [
    [`authtoken: ${H}`, H],
    [`clientsecret=${H}`, H],
    [`{"apitoken": "${H}"}`, H],
    [`secretkey=${H}`, H],
    [`api_keys: ${H}`, H],
    [`if (password === "${H}") {`, H],
    [`var password string = "${H}"`, H],
    [`password?: string = "${H}"`, H],
    ['{"password": "abc9xyz\\\\"}', 'abc9xyz'],
    [JSON.stringify(JSON.stringify({ password: 'abc9xyz\\' })), 'abc9xyz'],
    [JSON.stringify(JSON.stringify({ password: 'pa"ss9word' })), 'ss9word'],
    [`{\\"password\\": \\"${H} and the excerpt was cut`, H],
  ]) assert.ok(!r.redact(input).includes(secret), `${input} -> ${r.redact(input)}`);
  assert.deepEqual(r.deepRedact({ password: 12345678, pin: 4321, port: 8080, count: 3 }), { password: '[redacted:secret]', pin: '[redacted:secret]', port: 8080, count: 3 });
  // Lines the engine joined into one excerpt: a password line stops at the next key, so the
  // secret after it is read on its own.
  const joined = 'services: db: environment: POSTGRES_PASSWORD: example STRIPE_WEBHOOK_SECRET: "Xk9mP2qRz7abcd" ports: 5432';
  assert.equal(r.redact(joined), 'services: db: environment: POSTGRES_PASSWORD: [redacted:secret] STRIPE_WEBHOOK_SECRET: "[redacted:secret]" ports: 5432');
  assert.equal(r.redact("password: hunter2 token: 'Xk9mP2qRz7abcd'"), "password: [redacted:secret] token: '[redacted:secret]'");
  assert.equal(r.redact('Authorization: Bearer abcdefgh12345678 Accept: application/json'), 'Authorization: [redacted:secret] Accept: application/json');
  for (const h of ['Authorization: AWS AKIAIOSFODNN7EXAMPLE:frJIUN8DYpKDtOLCwo//yllqDzg=', 'Authorization: HMAC alice:Xk9mP2qRz7abcd']) assert.equal(r.redact(h), 'Authorization: [redacted:secret]');
  // An unclosed quote earlier on a joined line doesn't pair with the next secret's quote.
  for (const q of ['"', "'"]) assert.ok(!r.redact(`Cookie: sid=1 token: ${q}api_key: ${q}Xk9mP2qRz7abcd${q}`).includes('Xk9mP2qRz7abcd'), q);
  assert.ok(!r.redact('Cookie: sid=1 token: "Ab3dEf, api_key: "Xk9mP2qRz7abcd"').includes('Xk9mP2qRz7abcd'));
  assert.ok(!r.redact("dbPassword: M0)x api_key: 'Ab3dEf, api_key == 'Xk9mP2qRz7abcd'").includes('Xk9mP2qRz7abcd'));
  assert.ok(r.redact('await repo.SaveAsync(order, cancellationToken: ct).ConfigureAwait(false);').includes(').ConfigureAwait(false);'));
  for (const p of ['tools/scripts/build-release-notes-2024', 'feature/branch-protection-rules-v2']) assert.equal(r.redact(p), p);
  assert.ok(!r.redact('id 3395-5191-8521-3ff0-5460-db45-9207-3574').includes('db45'));
  // A ")" inside a value doesn't end it; one that closes the code around it does.
  for (const [input, secret] of [['client_secret: Xk9)mP2qRz7', 'mP2qRz7'], ['api_key: ab)cd9xyz', 'cd9xyz']]) assert.ok(!r.redact(input).includes(secret), input);
  assert.ok(r.redact('await repo.SaveAsync(order, cancellationToken: ct); return Ok(order);').includes('); return Ok(order);'));
  // Random dash-grouped lowercase tokens stay hidden; real folder paths with k8s or i18n show.
  for (const tok of ['q7xk2m-zp4vtr-8wnc3j-hf6b2d-tq9xvw', 'x8kq2vzt-3mpw7nhc-r4tz9qkx-v2nb8wqp']) assert.ok(!r.redact(`id ${tok}`).includes(tok), tok);
  for (const p of ['deploy/k8s/overlays/production2/kustomization', 'src/i18n/locales/en/messages2', 'apis/apps/v1beta1/deployments']) assert.equal(r.redact(p), p);
  // A dash-grouped random token stays hidden although each group is short. (Lowercase hex
  // groups show in both redactors: hex up to 40 characters is kept as a possible commit id.)
  const grouped = 'Ab3dEf9h-Kl2nOp5r-St8xYz1b-Cd4fGh7j';
  assert.ok(!r.redact(`id ${grouped}`).includes(grouped));
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
  const B = '\\';
  const inputs = ['a:'.repeat(50000), 'password:"'.repeat(20000), `${'x-'.repeat(50000)}token`, `http://${'a'.repeat(100000)}`, 'a-token-'.repeat(20000), `https://a:${'b'.repeat(100000)}`, 'token: '.repeat(20000), `${'ab/'.repeat(40000)}1`, `token:"${B.repeat(100000)}`, `token:"${`${B}${B}"`.repeat(30000)}`, `token ${B}`.repeat(15000), `token:"${B}`.repeat(15000), '--password '.repeat(10000), `-u a:${'b'.repeat(100000)}`, '0a1b2c3d-'.repeat(11000), '.-u='.repeat(25000), '.--user='.repeat(12500), 'token:a)'.repeat(12500), 'token=a '.repeat(12500), `token:"${`${B}"`.repeat(50000)}`];
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

test('parser: a private session adds no links, commits, branches, hand-offs or goal-id hits, with or without private text', async () => {
  // Later filters would hide these anyway; the parser's own guard is checked here directly.
  const file = join(scratch[0], 'guard.jsonl');
  const at = (s) => `2025-03-12T11:00:${String(s).padStart(2, '0')}.000Z`;
  const rec = (type, extra, t, n) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/path/to/your/repo', sessionId: 'guard', type, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: at(t), ...extra });
  const say = (content, t, n) => rec('assistant', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'model-a', content } }, t, n);
  const result = (id, tur, t, n) => rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] }, toolUseResult: tur }, t, n);
  writeFileSync(file, `${[
    rec('user', { message: { role: 'user', content: 'Carry on with g-widget.' }, origin: { kind: 'human' } }, 0, 1),
    JSON.stringify({ type: 'pr-link', prNumber: 7, prRepository: 'example/your-project', timestamp: at(1), sessionId: 'guard' }),
    JSON.stringify({ type: 'worktree-state', worktreeSession: { worktreeBranch: 'feature/x', originalBranch: 'main' }, timestamp: at(2), sessionId: 'guard' }),
    say([{ type: 'tool_use', id: 'tu_commit', name: 'Bash', input: { command: 'git commit -m x && git push && gh pr create' } }], 3, 2),
    result('tu_commit', { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', kind: 'committed' }, push: { branch: 'feature/x' }, pr: { number: 8, url: 'https://github.com/example/your-project/pull/8', action: 'created' }, branch: { ref: 'feature/y', action: 'created' } } }, 4, 3),
    say([{ type: 'tool_use', id: 'tu_out', name: 'Bash', input: { command: 'git commit -m y' } }], 5, 4),
    result('tu_out', { stdout: '[main 1a2b3c4] y\n 1 file changed', stderr: '', interrupted: false }, 6, 5),
    say([{ type: 'tool_use', id: 'tu_chip', name: 'mcp__ccd_session__spawn_task', input: { title: 'Next', prompt: 'Pick up g-widget.' } }], 7, 6),
    result('tu_chip', { ok: true }, 8, 7),
  ].join('\n')}\n`);
  const source = { key: 'cc-guard', sessionKey: 'cc-guard', file, role: 'session', tool: 'claude-code' };
  const parse = (isPrivate, privateText) => parseClaudeSource(source, { redact: (s) => s, isPrivate, privateText, cwd: '/path/to/your/repo', agentKey: 'cc-guard:main', sidechainAgentKey: 'cc-guard:sidechain', watch: isPrivate ? null : createWatch({ goalIds: ['g-widget'] }) });
  const kinds = ['prs', 'commits', 'branches', 'chips', 'watched'];
  const open = (await parse(false, false)).joins;
  for (const k of kinds) assert.ok(open[k].length > 0, `the readable parse finds ${k}`);
  for (const privateText of [false, true]) {
    const { joins, events } = await parse(true, privateText);
    for (const k of kinds) assert.deepEqual(joins[k], [], `private (privateText ${privateText}) adds no ${k}`);
    const prompt = events.find((e) => e.kind === 'prompt');
    assert.equal(prompt.facts.text ?? null, privateText ? 'Carry on with g-widget.' : null);
  }
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
