// The published redactor (createRedactor) and the prompt privacy audit (redactWithAudit)
// hide the secret-field forms the secrets-only scrubber hides: the value of a sensitive
// field in its other spellings, Authorization and Cookie headers, Bearer and Basic
// credentials, the password in a web address or after curl -u, a SecureString literal, and,
// in deepRedact, a value whose own key is sensitive. Ordinary text, and the keys
// honestweek's own models use, come out as they went in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { assessPublicRendition, createRedactor, createSecretsOnlyRedactor, redactWithAudit, replayRedactions } from '../lib/redact.mjs';
import { validateObjectives } from '../lib/goals.mjs';
import { REDACTION_SOURCES, emailSpans } from '../lib/redaction-patterns.mjs';

const H = 'hunter2';
// Random numbers from SHA-256 in counter mode: each seed is its own stream, unlike a linear
// generator whose nearby seeds give related inputs.
const stream = (seed) => {
  let pool = [];
  let counter = 0;
  return (n) => {
    if (!pool.length) {
      const h = createHash('sha256').update(`${seed}:${counter++}`).digest();
      pool = Array.from({ length: 8 }, (_, i) => h.readUInt32BE(i * 4));
    }
    return pool.pop() % n;
  };
};
const T = 'abcdefgh12345678';

// [input, the secret that must go, the published output]
const FORMS = [
  [`{"password": "${H}"}`, H, '{"password": "[redacted:secret]"}'],
  [`{"dbPassword": "${H}"}`, H, '{"dbPassword": "[redacted:secret]"}'],
  [JSON.stringify(JSON.stringify({ password: 'hunter 2', note: 'ok' })), 'hunter 2', JSON.stringify(JSON.stringify({ password: '[redacted:secret]', note: 'ok' }))],
  [`Authorization: bearer ${T}`, T, 'Authorization: [redacted:secret]'],
  [`AUTHORIZATION: BEARER ${T}`, T, 'AUTHORIZATION: [redacted:secret]'],
  [`curl -H "X-Foo: bearer ${T}"`, T, 'curl -H "X-Foo: bearer [redacted:secret]"'],
  ['use Basic dXNlcjpwYXNzd29yZA== here', 'dXNlcjpwYXNzd29yZA==', 'use Basic [redacted:secret] here'],
  ['x-api-key: shortkey99', 'shortkey99', 'x-api-key: [redacted:secret]'],
  ['client_secret: s3cr3t, then more', 's3cr3t', 'client_secret: [redacted:secret], then more'],
  ['export DB_PASS=xyz FOO=1', 'xyz', 'export DB_PASS=[redacted:secret] FOO=1'],
  [`PGPASSWORD=${H} psql -h localhost`, H, 'PGPASSWORD=[redacted:secret] psql -h localhost'],
  [`MYSQL_PWD=${H} mysql`, H, 'MYSQL_PWD=[redacted:secret] mysql'],
  ['password: correct horse battery staple', 'correct horse battery staple', 'password: [redacted:secret]'],
  [`docker login --password ${H}`, H, 'docker login --password [redacted:secret]'],
  [`Connect-Thing -Password ${H}`, H, 'Connect-Thing -Password [redacted:secret]'],
  [`curl -u admin:${H} https://example.com`, H, 'curl -u admin:[redacted:secret] https://example.com'],
  [`redis://:${H}@localhost:6379/0`, H, 'redis://:[redacted:secret]@localhost:6379/0'],
  [`ConvertTo-SecureString "${H}" -AsPlainText -Force`, H, 'ConvertTo-SecureString "[redacted:secret]" -AsPlainText -Force'],
  [`password := "${H}"`, H, 'password := "[redacted:secret]"'],
  [`const password: string = "${H}";`, H, 'const password: string = "[redacted:secret]";'],
  ['Cookie: sid=abc123; theme=dark', 'abc123', 'Cookie: [redacted:secret]'],
  // A value shaped like a commit id is still a value: the receipts rule doesn't spare it here.
  ['docker login --password deadbeef1', 'deadbeef1', 'docker login --password [redacted:secret]'],
  ['curl -H "Authorization: Bearer deadbeefcafe1234"', 'deadbeefcafe1234', 'curl -H "Authorization: [redacted:secret]"'],
  ['use Bearer deadbeefcafe1234 here', 'deadbeefcafe1234', 'use Bearer [redacted:secret] here'],
  // A header written with "=" inside quotes keeps its closing quote on a second pass.
  [`curl -H "Authorization=Bearer ${T}" https://example.com`, T, 'curl -H "Authorization=[redacted:secret]" https://example.com'],
  ['headers="Cookie=sid=abc123; theme=dark"', 'abc123', 'headers="Cookie=[redacted:secret]"'],
  // A quote inside a value (a letter or digit on both sides) doesn't end it; one after it does.
  ['password: Xk9"mP2qRz7abcd', 'mP2qRz7abcd', 'password: [redacted:secret]'],
  ["the db password: xk9'mp2qrz7abcd works again after the reset", 'mp2qrz7abcd', 'the db password: [redacted:secret]'],
  ['Authorization: Basic Xk9"mP2qRz7abcd', 'mP2qRz7abcd', 'Authorization: [redacted:secret]'],
  ["api_key: Xk9'mP2qRz7abcd, next", 'mP2qRz7abcd', 'api_key: [redacted:secret], next'],
  [`curl -H "Authorization: Bearer ${T}" -H "Accept: json"`, T, 'curl -H "Authorization: [redacted:secret]" -H "Accept: json"'],
  // The KEY=VALUE rule once took the second "=" of a comparison as the value and showed the rest.
  [`if password == "${H}":`, H, 'if password == "[redacted:secret]":'],
  [`if (password === "${H}") {`, H, 'if (password === "[redacted:secret]") {'],
];
// Forms the secrets-only scrubber writes differently (its own KEY=VALUE pass runs after the
// field rule), though it hides the same secret.
const SPELLED_DIFFERENTLY = new Set([`if password == "${H}":`, `if (password === "${H}") {`]);

// Every secret the secrets-only scrubber's review rounds found (test/private-text.test.mjs).
const U = '0a1b2c3d-1111-2222-3333-444455556666';
const HEX64 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const REVIEWED = [
  [`mysql -u root --password=${H} db`, H], [`deploy --token=${T}`, T], [`login --client-secret=${T}`, T], [`docker login --password ${H}`, H],
  [`tool --api-key ${U}`, U], [`Connect-Thing -Password ${H}`, H], [`password := "${H}"`, H], [`if password == "${H}":`, H],
  [`const password: string = "${H}";`, H], [`PASSWORD ?= ${H}`, H], [`{"dbPassword": "${H}"}`, H], [`accessToken = "${T}"`, T],
  [`PGPASSWORD=${H} psql -h localhost`, H], [`MYSQL_PWD=${H} mysql`, H], [`ENCRYPTION_KEY=${T}`, T], [`//registry.npmjs.org/:_authToken=${U}`, U],
  [`authorization: bearer ${T}`, T], [`AUTHORIZATION: BEARER ${T}`, T], [`Authorization: token ${T}`, T], [`curl -H "X-Foo: bearer ${T}"`, T],
  [`Cookie: a=1; session=${H}`, H], [`redis://:${H}@localhost:6379/0`, H], [`curl -u admin:${H} https://example.com`, H],
  [`password: ${H} horse battery staple`, 'horse battery staple'], [`password: ${H}`, H], [`ConvertTo-SecureString "${H}" -AsPlainText -Force`, H],
  ['MYSQL_ROOT_PASSWORD=Xk9;mP2,qRz', 'mP2,qRz'], ['DB_PASSWORD={Xk9mP2qRz}', 'Xk9mP2qRz'], ['API_TOKEN=ab]cd9xyz', 'cd9xyz'], ['password: Xk9,mP2qRz', 'mP2qRz'],
  [`https://files.example.com/x.zip?X-Amz-Signature=${T}&sig=${H}`, T], [`https://files.example.com/x.zip?sig=${H}`, H],
  [`curl https://api.example.com/hooks/${HEX64}`, HEX64], ['see .../k/abcd1234efgh5678ijkl9012mnop3456qrst', 'abcd1234efgh5678ijkl9012mnop3456qrst'],
  [`authtoken: ${H}`, H], [`clientsecret=${H}`, H], [`{"apitoken": "${H}"}`, H], [`secretkey=${H}`, H], [`api_keys: ${H}`, H],
  [`if (password === "${H}") {`, H], [`var password string = "${H}"`, H], [`password?: string = "${H}"`, H],
  ['{"password": "abc9xyz\\\\"}', 'abc9xyz'], [JSON.stringify(JSON.stringify({ password: 'abc9xyz\\' })), 'abc9xyz'],
  [JSON.stringify(JSON.stringify({ password: 'pa"ss9word' })), 'ss9word'], [`{\\"password\\": \\"${H} and the excerpt was cut`, H],
  ['services: db: environment: POSTGRES_PASSWORD: example STRIPE_WEBHOOK_SECRET: "Xk9mP2qRz7abcd" ports: 5432', 'Xk9mP2qRz7abcd'],
  ['Authorization: AWS AKIAIOSFODNN7EXAMPLE:frJIUN8DYpKDtOLCwo//yllqDzg=', 'frJIUN8DYpKDtOLCwo'], ['Authorization: HMAC alice:Xk9mP2qRz7abcd', 'Xk9mP2qRz7abcd'],
  ['Cookie: sid=1 token: "api_key: "Xk9mP2qRz7abcd"', 'Xk9mP2qRz7abcd'], ['Cookie: sid=1 token: "Ab3dEf, api_key: "Xk9mP2qRz7abcd"', 'Xk9mP2qRz7abcd'],
  ["dbPassword: M0)x api_key: 'Ab3dEf, api_key == 'Xk9mP2qRz7abcd'", 'Xk9mP2qRz7abcd'], ['client_secret: Xk9)mP2qRz7', 'mP2qRz7'], ['api_key: ab)cd9xyz', 'cd9xyz'],
];

// Ordinary text with no secret in it: published exactly as written.
const ORDINARY = [
  'added basic validation to the parser',
  'Bearer authentication flow, and basic end-to-end tests.',
  '**Auth:** users get logged out after five minutes',
  'fix(auth): handle expired tokens',
  'max_tokens: 4096, author: alex, secrets: 3',
  'passing: 12',
  'auth flow works',
  'tokens=5',
  'ran the suite: pass: 793, fail: 0, skipped: 2',
  'meta: { requiresAuth: true, layout: wide }',
  'AUTHOR=Jane Doe',
  'https://code.example.com:8080/repo',
  'password: ****',
  // A type annotation has no value to hide.
  'function login(password: string, remember: boolean) {}',
  'login(password: string, user: string): Promise<void>',
  'def connect(host: str, password: str, port: int):',
  'export function hash(passphrase: string, salt: Buffer) {',
  'constructor(private token: string, private http: HttpClient) {}',
  'fn new(api_key: Option<String>) -> Self',
];

test('createRedactor hides every secret-field form, keeps the key, and a second pass changes nothing', () => {
  for (const [input, secret, expected] of FORMS) {
    const r = createRedactor();
    const out = r.redact(input);
    assert.equal(out, expected, input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    const counted = r.count;
    assert.ok(counted > 0, input);
    assert.equal(r.redact(out), out, `idempotent: ${input}`);
    assert.equal(r.count, counted, `a second pass counts nothing: ${input}`);
  }
});

test('createRedactor and the secrets-only scrubber hide these forms alike (one shared rule set)', () => {
  for (const [input, secret] of FORMS) {
    const shown = createSecretsOnlyRedactor().redact(input);
    assert.ok(!shown.includes(secret), input);
    if (!SPELLED_DIFFERENTLY.has(input)) assert.equal(createRedactor().redact(input), shown, input);
  }
});

test('every secret the secrets-only scrubber\'s reviews found is hidden by the published redactor and the audit', () => {
  for (const [input, secret] of REVIEWED) {
    assert.ok(!createSecretsOnlyRedactor().redact(input).includes(secret), `secrets-only: ${input}`);
    const out = createRedactor().redact(input);
    assert.ok(!out.includes(secret), `published: ${input} -> ${out}`);
    const audit = redactWithAudit(input, {});
    assert.ok(!audit.text.includes(secret), `audit: ${input} -> ${audit.text}`);
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `replay: ${input}`);
    assert.equal(createRedactor().redact(audit.text), audit.text, `fixed point: ${input}`);
  }
});

test('redactWithAudit: each form is a secret span, the value is gone, the ops replay, and the scrubber agrees', () => {
  for (const [input, secret, expected] of FORMS) {
    const audit = redactWithAudit(input, {});
    assert.ok(audit.rawDetectors.includes('secret'), `${input}: ${audit.rawDetectors}`);
    assert.ok(audit.redactionOps.some((op) => op.detector === 'secret'), input);
    assert.ok(!audit.text.includes(secret), `${input} -> ${audit.text}`);
    assert.equal(audit.text, expected, input);
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `replay: ${input}`);
    // The canonical scrubber leaves the audited rendition as it is.
    assert.equal(createRedactor().redact(audit.text), audit.text, `fixed point: ${input}`);
  }
});

test('redactWithAudit: spans count code points, so text before the field may hold emoji', () => {
  const input = `\u{1F512}\u{1F511} PGPASSWORD=${H} then x-api-key: shortkey99 \u{1F600} done`;
  const audit = redactWithAudit(input, {});
  assert.equal(audit.text, '\u{1F512}\u{1F511} PGPASSWORD=[redacted:secret] then x-api-key: [redacted:secret] \u{1F600} done');
  assert.equal(replayRedactions(input, audit.redactionOps), audit.text);
  assert.equal(createRedactor().redact(input), audit.text);
});

test('ordinary text is published as written, and the audit finds no secret in it', () => {
  for (const input of ORDINARY) {
    const r = createRedactor();
    assert.equal(r.redact(input), input);
    assert.equal(r.count, 0, input);
    const audit = redactWithAudit(input, {});
    assert.ok(!audit.rawDetectors.includes('secret'), `${input}: ${audit.rawDetectors}`);
    assert.equal(audit.text, input);
  }
});

test('a password in a web address with a dotted host stays hidden with its host, as before', () => {
  // The email rule took `swordfish@code.example.com` before this change; it still does, and
  // the audit agrees. A host without a dot (`localhost`) was not an email, and is now covered.
  const input = 'Clone https://alex:swordfish@code.example.com/repo now';
  assert.equal(createRedactor().redact(input), 'Clone https://alex:[redacted:email]/repo now');
  assert.equal(redactWithAudit(input, {}).text, 'Clone https://alex:[redacted:email]/repo now');
});

test('deepRedact hides a value whose own key is sensitive, and keeps the redactor shape', () => {
  const r = createRedactor();
  assert.deepEqual(Object.keys(r).sort(), ['count', 'deepRedact', 'redact']);
  const out = r.deepRedact({ headers: { 'x-api-key': 'shortkey99', Accept: 'json' }, password: 'hunter2', dbPassword: 'hunter3', note: 'ok', count: 3, auth: true, list: [{ token: 'abc123' }], keys: { ENCRYPTION_KEY: T, signingKey: 'xyz' } });
  assert.deepEqual(out, { headers: { 'x-api-key': '[redacted:secret]', Accept: 'json' }, password: '[redacted:secret]', dbPassword: '[redacted:secret]', note: 'ok', count: 3, auth: true, list: [{ token: '[redacted:secret]' }], keys: { ENCRYPTION_KEY: '[redacted:secret]', signingKey: '[redacted:secret]' } });
  assert.equal(r.count, 6);
  // A flag value or a test count under a sensitive key isn't a secret, as in text.
  assert.deepEqual(r.deepRedact({ auth: 'true', token: 'none', pass: '12' }), { auth: 'true', token: 'none', pass: '12' });
  // An array under a sensitive key: each item is hidden.
  assert.deepEqual(r.deepRedact({ tokens: ['a'], apiKeys: ['abc', 'def'] }), { tokens: ['a'], apiKeys: ['[redacted:secret]', '[redacted:secret]'] });
  // A long number under a password-like key is hidden; ports, counts and short pins aren't.
  assert.deepEqual(r.deepRedact({ password: 12345678, pin: 4321, pass: 793, port: 8080, count: 3, secret: 12 }), { password: '[redacted:secret]', pin: '[redacted:secret]', pass: 793, port: 8080, count: 3, secret: 12 });
  // A value that is already only placeholders, or empty, is left as it is and not counted.
  const before = r.count;
  assert.deepEqual(r.deepRedact({ token: '[redacted:secret]', password: ' [redacted:email] [redacted:secret] ', secret: '' }), { token: '[redacted:secret]', password: ' [redacted:email] [redacted:secret] ', secret: '' });
  assert.equal(r.count, before);
});

test('deepRedact keeps the values of honestweek\'s own model keys and of free-text keys', () => {
  const model = {
    fileKey: 'k-abc', fileKeys: ['k-1', 'k-2'], sessionKey: 'cc-abc', sessionKeys: ['cc-1'], statusKey: 'progress',
    weekStartKey: '2025-03-10', weekEndKey: '2025-03-16', repoKey: 'r-1', findingKey: 'f-1', sidechainAgentKey: 'a:side', parentAgentKey: 'a:main',
    tokens: '1,200', max_tokens: '4096', inputTokens: '12', preTokens: '5', postTokens: '6', total_tokens: '17',
    pass: '12', fail: '0', passed: 'yes', testRunsAllPassed: '3', authorEmails: ['you@example.com'], author: 'You', authored: 'yes',
    signal: 'ok', statusSignals: ['done'], toolSignal: 'Bash',
  };
  const out = createRedactor().deepRedact(model);
  for (const key of Object.keys(model)) {
    if (key === 'authorEmails') assert.deepEqual(out[key], ['[redacted:email]'], key);
    else assert.deepEqual(out[key], model[key], key);
  }
  // Answers keyed by the question's text keep their answers.
  const answers = { 'Which auth method should we use?': 'OAuth with PKCE', 'Should I pass the failing tests through?': 'No, fix them first', 'token?': 'the refresh one' };
  assert.deepEqual(createRedactor().deepRedact({ answers }), { answers });
});

test('a second pass changes nothing, and the scrubber leaves the audited text as it is, on glued text', () => {
  // The field rules read the scrubber's text after every other placeholder is down; run
  // earlier, a placeholder set down after them split a word they had read whole, and the
  // second pass (or the scrubber run on the audit's rendition) found a new field.
  const glued = [
    '\n0a1b2c3d-1111-2222-3333-44445555666612--password you@example.com=basic 12 ',
    'admin:you@example.comx-api-keyBearer https://basic ==" ',
    '--password 0a1b2c3d-1111-2222-3333-444455556666 \'\'hunter2=DB_PASSauth',
    'basic [redacted:email][redacted:secret]passwordtrue',
    'deadbee = auth,Bearer [redacted:secret]basic /home/alex/x = ',
    // Typed parameters once lost a comma on the second pass; a quoted header its closing quote.
    'function login(password: string, remember: boolean) {}',
    'def connect(host: str, password: str, port: int):',
    `curl -H "Authorization=Bearer ${T}" https://example.com`,
    // A field read whole as another key's value until a hidden credential freed it.
    'basic QYnApA3xnf = --token=**',
  ];
  // A seeded mix of field pieces, placeholders, emails, ids, paths and numbers.
  const pieces = ['password', 'token', 'api_key', 'x-api-key', 'Authorization', 'Cookie', 'DB_PASS', 'auth', 'pass', ':', ': ', '=', ' = ', '==', ':=', '"', "'", '\\"', ' ', '\n', 'hunter2', 'abc', 'Bearer ', 'basic ', T, '--password ', '-u ', 'admin:', '@', 'localhost', 'redis://', 'https://', 'a.co', ',', ';', ')', '**', 'ConvertTo-SecureString ', '[redacted:secret]', '[redacted:email]', 'you@example.com', U, '/home/alex/x', 'deadbee', '123456789', 'true', '12', '\u{1F600}'];
  const next = stream('glued');
  const inputs = [...glued];
  for (let i = 0; i < 2500; i += 1) {
    let s = '';
    for (let j = 1 + next(12); j > 0; j -= 1) s += pieces[next(pieces.length)];
    if (s.trim()) inputs.push(s);
  }
  for (const input of inputs) {
    const r = createRedactor();
    const once = r.redact(input);
    const counted = r.count;
    assert.equal(r.redact(once), once, `idempotent: ${JSON.stringify(input)}`);
    assert.equal(r.count, counted, `a second pass counts nothing: ${JSON.stringify(input)}`);
    const audit = redactWithAudit(input, {});
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `replay: ${JSON.stringify(input)}`);
    assert.equal(createRedactor().redact(audit.text), audit.text, `fixed point: ${JSON.stringify(input)}`);
  }
  // With a configured name: a placeholder after a quote, or one that lets a hex run be read as
  // a commit id on the second pass, doesn't change what the field rules read.
  const config = { redaction: { names: ['Jane Doe'] } };
  for (const input of ['-Password Q7LHQSCYAcQxxwYG = --token="Jane Doe', 'TOKEN[redacted:email]str Jane Doe20240101deadbee--password a.co']) {
    const r = createRedactor(config);
    const once = r.redact(input);
    assert.equal(r.redact(once), once, `idempotent: ${JSON.stringify(input)}`);
    const audit = redactWithAudit(input, config);
    assert.equal(createRedactor(config).redact(audit.text), audit.text, `fixed point: ${JSON.stringify(input)}`);
  }
});

test('the operand of a comparison is hidden even when its key is glued to text a later step hides', () => {
  for (const [input, expected] of [
    ['C:\\Users\\alex\\x,-Password ==hunter2', '[redacted:path] ==[redacted:secret]'],
    ['Zx9QwErTyUiOp1234AsDfGhJkL5678ZxCvBnM--password ===hunter2', '[redacted:secret] ===[redacted:secret]'],
    ['TOKEN=\n=abc123', 'TOKEN=\n=[redacted:secret]'],
  ]) {
    const r = createRedactor();
    assert.equal(r.redact(input), expected, input);
    assert.equal(r.redact(expected), expected, `idempotent: ${input}`);
    assert.equal(redactWithAudit(input, {}).text, expected, `audit: ${input}`);
  }
});

test('a flag before a phone-shaped run still reads its value in the audit, and text without one keeps its spans', () => {
  for (const [input, expected] of [
    ['docker login --password 20240101Secret!', 'docker login --password [redacted:account]'],
    ['use Bearer 12345678abcdefXYZ here', 'use Bearer [redacted:account] here'],
  ]) {
    const audit = redactWithAudit(input, {});
    assert.equal(audit.text, expected, input);
    assert.equal(createRedactor().redact(audit.text), audit.text, `fixed point: ${input}`);
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text);
  }
  // A phone number with no secret field before it is rendered as it always was, so a kept
  // prompt's rendition (and its hash) doesn't change.
  assert.equal(redactWithAudit('call +1 (555) 123-4567 now', {}).text, 'call[redacted:account]now');
});

test('a rendition is assessed with its placeholders in place', () => {
  assert.equal(assessPublicRendition('the log now shows token: [redacted:secret] then retries once', {}), 'low');
  assert.equal(assessPublicRendition('PGPASSWORD=[redacted:secret] psql', {}), 'low');
  // A password line hides to its end, so words after its placeholder would still be hidden.
  assert.equal(assessPublicRendition('fixed so password: [redacted:secret] is all the page shows', {}), 'high');
});

test('goal text that reads like a field is reported as changed by the redactor, not as a configured term', () => {
  const registry = { groups: ['product'], objectives: { 'sign-in': { publicLabel: 'Stay signed in', publicGroup: 'product', how: 'Auth: refresh sessions quietly before they expire' } }, projectToObjective: {} };
  const { errors } = validateObjectives({ registry, redactor: createRedactor({}) });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /would be changed by the redactor/);
  assert.match(errors[0], /secret field/);
});

test('emailSpans finds exactly what a global search with the email pattern finds', () => {
  const global = new RegExp(REDACTION_SOURCES.email, 'g');
  const alphabet = ['a', 'B', '7', '_', '.', '%', '+', '-', '@', ' ', 'é', 'co', 'x.io', '(', '"', '\n', '..', '@@', 'ab'];
  const next = stream('email');
  for (let i = 0; i < 20000; i += 1) {
    let s = '';
    for (let j = 1 + next(30); j > 0; j -= 1) s += alphabet[next(alphabet.length)];
    // Two addresses back to back, the second starting at a "." right after the first.
    if (i === 0) s = 'a@a..ax.ioa.@x.io';
    const expected = [...s.matchAll(global)].map((m) => [m.index, m.index + m[0].length]);
    assert.deepEqual(emailSpans(s), expected, JSON.stringify(s));
  }
});

test('a date or phone-shaped number right before a flag doesn\'t let the audit publish the flag\'s value', () => {
  for (const raw of [
    'please rerun the importer with node import.js --since 2024-06-10 --token xk9mp2qrz7 and tell me whether the totals still match',
    'Get-Report -Day 2024-06-10 -Password xk9mp2qrz7 and send me the totals from the export',
    'the log shows 123456789--password xk9mp2qrz7 when the job retries after the timeout',
  ]) {
    const got = redactWithAudit(raw, {});
    assert.ok(!got.text.includes('xk9mp2qrz7'), got.text);
    assert.equal(replayRedactions(raw, got.redactionOps), got.text);
    assert.ok(!createRedactor({}).redact(raw).includes('xk9mp2qrz7'));
  }
});

test('deepRedact hides everything beneath a sensitive key, in both scrubbers', () => {
  const record = { token: { value: 'hunter2', kind: 'bearer' }, apiKeys: [{ value: 'hunter3' }, 'hunter4'], credentials: { db: { password: 'x', host: 'db.internal' } }, note: { value: 'kept' }, fileKey: 'k-abc' };
  const want = { token: { value: '[redacted:secret]', kind: '[redacted:secret]' }, apiKeys: [{ value: '[redacted:secret]' }, '[redacted:secret]'], credentials: { db: { password: '[redacted:secret]', host: '[redacted:secret]' } }, note: { value: 'kept' }, fileKey: 'k-abc' };
  assert.deepEqual(createRedactor({}).deepRedact(record), want);
  assert.deepEqual(createSecretsOnlyRedactor().deepRedact(record), want);
});

test('field values cut at a quote are stable under a second pass (the second review\'s inputs)', () => {
  const r = createRedactor({});
  for (const raw of [
    'please refactor Authorization: Basic x="token=""abc so it takes the header from the config',
    'Authorization: x="token="',
    'Cookie: prefs="token=""x; theme=dark',
    'Auth:r =token="',
  ]) {
    const once = r.redact(raw);
    assert.equal(r.redact(once), once, raw);
  }
});

test('the published redactor and the audit stay fast on long adversarial inputs', () => {
  const B = '\\';
  // The secrets-only scrubber's adversarial inputs (test/private-text.test.mjs), and a few for
  // the rules added here.
  const inputs = ['a:'.repeat(50000), 'password:"'.repeat(20000), `${'x-'.repeat(50000)}token`, `http://${'a'.repeat(100000)}`, 'a-token-'.repeat(20000), `https://a:${'b'.repeat(100000)}`, 'token: '.repeat(20000), `${'ab/'.repeat(40000)}1`, `token:"${B.repeat(100000)}`, `token:"${`${B}${B}"`.repeat(30000)}`, `token ${B}`.repeat(15000), `token:"${B}`.repeat(15000), '--password '.repeat(10000), `-u a:${'b'.repeat(100000)}`, '0a1b2c3d-'.repeat(11000), '.-u='.repeat(25000), '.--user='.repeat(12500), 'token:a)'.repeat(12500), 'token=a '.repeat(12500), `token:"${`${B}"`.repeat(50000)}`,
    `bearer ${'.'.repeat(100000)}x`, `basic ${'Aa-'.repeat(33000)}`, 'basic validation '.repeat(6000), '**Auth:** '.repeat(10000), `token: ${'[redacted:secret]          '.repeat(4000)}x`, `ConvertTo-SecureString "${'a'.repeat(100000)}`, `redis://:${'a@'.repeat(50000)}`, `${'x.'.repeat(50000)}@`,
    // A long run of the Private-Use character the scrubbers' tokens are made of.
    `${String.fromCharCode(0xe000).repeat(100000)} token: abc`, `${'--password 20240101x '.repeat(5000)}`];
  for (const input of inputs) {
    for (const [name, run] of [['redact', (s) => createRedactor().redact(s)], ['audit', (s) => redactWithAudit(s, {})]]) {
      const started = Date.now();
      const out = run(input);
      const ms = Date.now() - started;
      if (input.endsWith(' token: abc')) assert.ok(!(out.text ?? out).includes('token: abc'), `${name} hides the token after the run`);
      assert.ok(ms < 1000, `${name} took ${ms} ms on a ${input.length}-character input starting ${JSON.stringify(input.slice(0, 20))}`);
    }
  }
  // A value under a sensitive key that holds many placeholders apart from other text: the
  // check that it is only placeholders once backtracked exponentially here.
  const record = { token: `${'[redacted:secret]          '.repeat(4000)}x`, list: [{ password: `${'[redacted:secret] '.repeat(5000)}y` }] };
  for (const [name, r] of [['published', createRedactor()], ['secrets-only', createSecretsOnlyRedactor()]]) {
    const started = Date.now();
    const out = r.deepRedact(record);
    assert.ok(Date.now() - started < 1000, `${name} deepRedact took ${Date.now() - started} ms`);
    assert.deepEqual(out, { token: '[redacted:secret]', list: [{ password: '[redacted:secret]' }] });
  }
});
