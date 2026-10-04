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
import { keyedSecrets } from '../lib/view/leaks.mjs';

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

// A credential written after a label (`here's the sandbox one: DOCS_TOKEN=…`). The label reads
// like a field of its own, `one: …`, but each key is read from its own start and only a
// sensitive key's value is taken, so the label never swallows the field after it. Made-up
// values throughout.
const LV = 'qv7Lm2Rz9Xk4';
const LW = 'mN3pQ8sT';
// [input, the published output]
const AFTER_A_LABEL = [
  [`here's the sandbox one: DOCS_TOKEN=${LV}`, "here's the sandbox one: DOCS_TOKEN=[redacted:secret]"],
  [`label: DOCS_TOKEN=${LV}`, 'label: DOCS_TOKEN=[redacted:secret]'],
  [`label - DOCS_TOKEN: ${LV}`, 'label - DOCS_TOKEN: [redacted:secret]'],
  [`note=DOCS_TOKEN=${LV}`, 'note=DOCS_TOKEN=[redacted:secret]'],
  [`label: "DOCS_TOKEN": "${LV}"`, 'label: "DOCS_TOKEN": "[redacted:secret]"'],
  [`see: Authorization: Bearer ${LV}`, 'see: Authorization: [redacted:secret]'],
  [`a: API_KEY=${LV} b: DB_PASSWORD=${LW} c: notes here`, 'a: API_KEY=[redacted:secret] b: DB_PASSWORD=[redacted:secret] c: notes here'],
  [`Setup: users get logged out. Use the sandbox one: DOCS_TOKEN=${LV}`, 'Setup: users get logged out. Use the sandbox one: DOCS_TOKEN=[redacted:secret]'],
];
// The same inside JSON text, one and two levels of escaping deep.
const AFTER_A_LABEL_JSON = [
  JSON.stringify({ msg: `here's the sandbox one: DOCS_TOKEN=${LV}` }),
  JSON.stringify({ msg: `label: "DOCS_TOKEN": "${LV}"` }),
  JSON.stringify(JSON.stringify({ msg: `label: "DOCS_TOKEN": "${LV}"` })),
  JSON.stringify({ msg: `see: Authorization: Bearer ${LV}` }),
  JSON.stringify({ msg: `step 1: DOCS_TOKEN=${LV}, step 2: client_secret=${LW}` }),
];

test('a credential after a label is hidden by both scrubbers and the audit, and the label stays', () => {
  for (const [input, expected] of AFTER_A_LABEL) {
    const r = createRedactor();
    const out = r.redact(input);
    assert.equal(out, expected, input);
    assert.equal(r.redact(out), out, `idempotent: ${input}`);
    assert.equal(createSecretsOnlyRedactor().redact(input), expected, `secrets-only: ${input}`);
    const audit = redactWithAudit(input, {});
    assert.equal(audit.text, expected, `audit: ${input}`);
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `replay: ${input}`);
  }
  for (const input of AFTER_A_LABEL_JSON) {
    const out = createRedactor().redact(input);
    for (const value of [LV, LW]) assert.ok(!out.includes(value), `published: ${input} -> ${out}`);
    assert.equal(createSecretsOnlyRedactor().redact(input), out, `secrets-only: ${input}`);
    assert.equal(redactWithAudit(input, {}).text, out, `audit: ${input}`);
    assert.equal(createRedactor().redact(out), out, `idempotent: ${input}`);
  }
  // Read back as a record, the same strings stay hidden in both scrubbers.
  for (const r of [createRedactor(), createSecretsOnlyRedactor()]) {
    const out = JSON.stringify(r.deepRedact({ notes: AFTER_A_LABEL.map(([input]) => input) }));
    for (const value of [LV, LW]) assert.ok(!out.includes(value), out);
  }
});

// A flag whose name has dots (`--docs.token value`, `-Docs.Token value`) is read as one name,
// each dot standing for "_", the way `--docs-token` and `-DocsToken` are read. Made-up values.
// [input, the published output]
const DOTTED_FLAGS = [
  [`--docs.token ${LV}`, '--docs.token [redacted:secret]'],
  [`--docs.token=${LV}`, '--docs.token=[redacted:secret]'],
  [`--api.key "${LV}"`, '--api.key "[redacted:secret]"'],
  [`--api.key=${LV}`, '--api.key=[redacted:secret]'],
  [`-Docs.Token ${LV}`, '-Docs.Token [redacted:secret]'],
  [`-Api.Key '${LV}'`, "-Api.Key '[redacted:secret]'"],
  [`--docs_site.auth_token ${LV}`, '--docs_site.auth_token [redacted:secret]'],
  [`--docs-site.auth-token ${LV}`, '--docs-site.auth-token [redacted:secret]'],
  [`--my_app.client.secret ${LV}`, '--my_app.client.secret [redacted:secret]'],
  [`--db.password ${LV} --log.level debug`, '--db.password [redacted:secret] --log.level debug'],
  [`deploy --docs.token ${LV} --dry-run`, 'deploy --docs.token [redacted:secret] --dry-run'],
];
// Dotted words and flags that name nothing secret.
const DOTTED_ORDINARY = [
  '--config.file path/to/x.json',
  'node.js',
  '--max-old-space-size=4096',
  'run node.js --config.file ./a.json --log.level debug',
  'the docs.token value',
  'see config.token for it',
  '--tokenizer.path models/x',
  'npm run build -- --mode.production true',
];

test('a sensitive flag with a dotted name has its value hidden by both scrubbers and the audit', () => {
  for (const [input, expected] of DOTTED_FLAGS) {
    const r = createRedactor();
    const out = r.redact(input);
    assert.equal(out, expected, input);
    assert.equal(r.redact(out), out, `idempotent: ${input}`);
    const shown = createSecretsOnlyRedactor();
    assert.equal(shown.redact(input), expected, `secrets-only: ${input}`);
    assert.equal(shown.redact(expected), expected, `secrets-only idempotent: ${input}`);
    const audit = redactWithAudit(input, {});
    assert.equal(audit.text, expected, `audit: ${input}`);
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `replay: ${input}`);
  }
  for (const input of DOTTED_ORDINARY) {
    assert.equal(createRedactor().redact(input), input, input);
    assert.equal(createSecretsOnlyRedactor().redact(input), input, `secrets-only: ${input}`);
    assert.equal(redactWithAudit(input, {}).text, input, `audit: ${input}`);
  }
});

/** Each [input, published output, secrets-only output] row: the published redactor and the audit
 *  write the published output, the secrets-only scrubber its own (the published one unless
 *  given), the value is gone from all three, the audit's ops replay, and a second pass of either
 *  scrubber changes nothing. Each ordinary input comes out of all three as it went in. */
function agreeOn(rows, ordinary, value) {
  for (const [input, expected, shownExpected = expected] of rows) {
    const r = createRedactor();
    const out = r.redact(input);
    assert.equal(out, expected, input);
    assert.ok(!out.includes(value), `published: ${input} -> ${out}`);
    assert.equal(r.redact(out), out, `idempotent: ${input}`);
    const shown = createSecretsOnlyRedactor();
    const seen = shown.redact(input);
    assert.equal(seen, shownExpected, `secrets-only: ${input}`);
    assert.ok(!seen.includes(value), `secrets-only: ${input} -> ${seen}`);
    assert.equal(shown.redact(seen), seen, `secrets-only idempotent: ${input}`);
    const audit = redactWithAudit(input, {});
    assert.equal(audit.text, expected, `audit: ${input}`);
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `replay: ${input}`);
    assert.equal(createRedactor().redact(audit.text), audit.text, `fixed point: ${input}`);
  }
  for (const input of ordinary) {
    assert.equal(createRedactor().redact(input), input, input);
    assert.equal(createSecretsOnlyRedactor().redact(input), input, `secrets-only: ${input}`);
    assert.equal(redactWithAudit(input, {}).text, input, `audit: ${input}`);
  }
}

// A Java system property or a Gradle project property (`-Dapi.key=…`, `-Psigning.password=…`) is
// read by its own name, the part after -D or -P, each dot standing for "_". Made-up values.
// [input, the published output, the secrets-only output when it differs]
const JAVA_PROPERTIES = [
  [`-Dapi.key=${LV}`, '-Dapi.key=[redacted:secret]'],
  [`-Ddb.password=${LV}`, '-Ddb.password=[redacted:secret]'],
  [`-Dspring.datasource.password=${LV}`, '-Dspring.datasource.password=[redacted:secret]'],
  [`-Psigning.password=${LV}`, '-Psigning.password=[redacted:secret]'],
  [`-Dapi_key=${LV}`, '-Dapi_key=[redacted:secret]'],
  [`-Dapi-key=${LV}`, '-Dapi-key=[redacted:secret]'],
  [`-DapiKey=${LV}`, '-DapiKey=[redacted:secret]'],
  [`-DAPI_KEY=${LV}`, '-DAPI_KEY=[redacted:secret]'],
  [`-Dstripe.api.key=${LV}`, '-Dstripe.api.key=[redacted:secret]'],
  [`-Daws.secret.access.key=${LV}`, '-Daws.secret.access.key=[redacted:secret]'],
  [`java -Dapi.key="${LV}" -jar app.jar`, 'java -Dapi.key="[redacted:secret]" -jar app.jar'],
  // The published redactor's KEY=VALUE rule reads `token="…"` and hides the quotes with the
  // value; the secrets-only scrubber keeps them. Both hide the value.
  [`java -Dauth.token="${LV}" -jar app.jar`, 'java -Dauth.token=[redacted:secret] -jar app.jar', 'java -Dauth.token="[redacted:secret]" -jar app.jar'],
  [`java -Dfile.encoding=UTF-8 -Dapi.key=${LV} -Xmx2g -jar app.jar`, 'java -Dfile.encoding=UTF-8 -Dapi.key=[redacted:secret] -Xmx2g -jar app.jar'],
  [`./gradlew publish -Psigning.password=${LV} -Pversion=1.2.3`, './gradlew publish -Psigning.password=[redacted:secret] -Pversion=1.2.3'],
  [`mvn deploy -Dgpg.passphrase=${LV} -DskipTests`, 'mvn deploy -Dgpg.passphrase=[redacted:secret] -DskipTests'],
];
// Properties and options that name nothing secret, and PowerShell parameters that start with D
// or P, which are read as before.
const JAVA_ORDINARY = [
  'java -Dfile.encoding=UTF-8 -Dlog.level=debug -Xmx2g -DskipTests -jar app.jar',
  'mvn -DskipTests=true -Dspring.profiles.active=dev package',
  './gradlew build -Pversion=1.2.3 -Dorg.gradle.jvmargs=-Xmx2g',
  'java -Duser.timezone=UTC -Dauth.required=true -jar app.jar',
  'Get-ChildItem -Path ./src -Depth 2',
];

test('a Java or Gradle property named for a secret has its value hidden by both scrubbers and the audit', () => {
  agreeOn(JAVA_PROPERTIES, JAVA_ORDINARY, LV);
});

// A dotted key whose name is a secret only when it's read whole (`api.key`, `secret.key`: `key`
// alone names nothing), wherever it sits: on its own, in a quoted note whose closing quote is
// missing, or where a sensitive field's unclosed quoted value runs into it. Made-up values.
// [input, the published output, the secrets-only output when it differs]
const DOTTED_KEYS = [
  [`note: "see config api.key=${LV}`, 'note: "see config api.key=[redacted:secret]'],
  [`note: "see config api.key=${LV} and restart`, 'note: "see config api.key=[redacted:secret] and restart'],
  [`note: 'see config api.key=${LV}`, "note: 'see config api.key=[redacted:secret]"],
  [`{"note": "see config api.key=${LV}`, '{"note": "see config api.key=[redacted:secret]'],
  [`see config api.key=${LV}`, 'see config api.key=[redacted:secret]'],
  [`token: "Ab3d, api.key: "${LV}"`, 'token: "[redacted:secret]"[redacted:secret]"'],
  [`token: 'Ab3d, api.key: '${LV}'`, "token: '[redacted:secret]'[redacted:secret]'"],
  [`token: "Ab3d, secret.key: "${LV}"`, 'token: "[redacted:secret]"[redacted:secret]"'],
  [`token: "Ab3d, aws.secret.access.key: "${LV}"`, 'token: "[redacted:secret]"[redacted:secret]"'],
  [`api.key: ${LV}`, 'api.key: [redacted:secret]'],
  [`{"api.key": "${LV}"}`, '{"api.key": "[redacted:secret]"}'],
  [`secret.key=${LV}`, 'secret.key=[redacted:secret]'],
  [`aws.secret.access.key = ${LV}`, 'aws.secret.access.key = [redacted:secret]'],
  [`stripe.api.key: ${LV}, region: eu`, 'stripe.api.key: [redacted:secret], region: eu'],
];
// A dotted word whose secret-sounding part is a file or an object, not a key: read as before.
const DOTTED_KEYS_ORDINARY = [
  'src/auth.ts:42',
  'lib/auth.mjs: add retry',
  'token.ts: fix expiry',
  'apiKey.ts:12',
  'api.key.ts:12',
  'if (password.length === 0) return;',
  'password.length: 8',
  'the api.key file',
];

test('a dotted key named for a secret has its value hidden, in or out of a quoted value that never closes', () => {
  agreeOn(DOTTED_KEYS, DOTTED_KEYS_ORDINARY, LV);
  // JSON text, one and two levels deep, and a quoted value whose would-be close opens a flag's.
  for (const input of [
    JSON.stringify({ note: `see config api.key=${LV}` }),
    JSON.stringify(JSON.stringify({ note: `see config api.key=${LV}` })),
    JSON.stringify({ msg: `token: "Ab3d, api.key: "${LV}"` }),
    `token: "Ab3d --api.key="${LV}"`,
    `token: "Ab3d --api_key="${LV}"`,
  ]) {
    const out = createRedactor().redact(input);
    assert.ok(!out.includes(LV), `published: ${input} -> ${out}`);
    assert.equal(createRedactor().redact(out), out, `idempotent: ${input}`);
    const seen = createSecretsOnlyRedactor().redact(input);
    assert.ok(!seen.includes(LV), `secrets-only: ${input} -> ${seen}`);
    assert.equal(createSecretsOnlyRedactor().redact(seen), seen, `secrets-only idempotent: ${input}`);
    const audit = redactWithAudit(input, {});
    assert.equal(audit.text, out, `audit: ${input}`);
    assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `replay: ${input}`);
  }
  // Read back as a record, a dotted key named for a secret hides its value in both scrubbers.
  for (const r of [createRedactor(), createSecretsOnlyRedactor()]) {
    assert.deepEqual(r.deepRedact({ 'api.key': LV, 'secret.key': LV, 'log.level': 'debug' }), { 'api.key': '[redacted:secret]', 'secret.key': '[redacted:secret]', 'log.level': 'debug' });
  }
});

// A sensitive field's value opened by a single quote that never closes on its line: the value
// after the quote is hidden, read the way it would be without the quote. After "=", a value
// runs to the next space and the quote goes with it, as before. Made-up values.
// [input, the published output]
const UNCLOSED_SINGLE_QUOTE = [
  [`password: '${LV}`, "password: '[redacted:secret]"],
  [`db.password: 'correct horse ${LV}`, "db.password: '[redacted:secret]"],
  [`api_key: '${LV}, region: eu`, "api_key: '[redacted:secret], region: eu"],
  [`api.key: '${LV}`, "api.key: '[redacted:secret]"],
  [`{"token": '${LV}`, `{"token": '[redacted:secret]`],
  [`note: "see api.key: '${LV}`, `note: "see api.key: '[redacted:secret]`],
];
// A flag word or a test count after the quote is still not a secret, and a quote that closes
// the text the key sits in (a label in code) opens no value.
const UNCLOSED_SINGLE_QUOTE_ORDINARY = ["auth: 'none", "pass: '793", "token: '", "  'Password:',", "label: 'Enter your password:' + hint", "t('Token:').trim()", "const p = 'Password:'.length;"];

test('a sensitive value opened by a single quote that never closes is hidden by both scrubbers and the audit', () => {
  agreeOn(UNCLOSED_SINGLE_QUOTE, UNCLOSED_SINGLE_QUOTE_ORDINARY, LV);
});

// The rule for a sensitive field nested in another one's value: every name is read, also inside
// a value that is being hidden, and each sensitive name hides its own value. Values that don't
// touch are hidden one by one and the text between them stays; a value that overlaps the one
// being hidden, or takes the quote that ended it, is hidden with it as one. A quoted word after
// a key is always hidden, and when a separator follows it, what it names is hidden too. A value
// that ends on a Bearer or Basic scheme takes the credential after it. Made-up values.
// [input, the published output]
const NESTED_AFTER_QUOTE = [
  [`password: 'token: "${LV}"`, `password: '[redacted:secret] "[redacted:secret]"`],
  [`api_key: 'token: "${LV}"`, `api_key: '[redacted:secret] "[redacted:secret]"`],
  [`password: 'token: ${LV}`, `password: '[redacted:secret]`],
  [`api_key: 'token: ${LV}, region: eu`, `api_key: '[redacted:secret] [redacted:secret], region: eu`],
  [`token: "password: '${LV}`, 'token: "[redacted:secret]'],
  [`password: 'token=${LV}`, `password: '[redacted:secret]`],
  [`api_key: 'token=${LV}`, `api_key: '[redacted:secret]`],
  [`password: 'Authorization: Bearer ${LV}`, `password: '[redacted:secret]`],
  [`api_key: 'Authorization: Bearer ${LV}`, `api_key: '[redacted:secret] [redacted:secret]`],
  [`api_key: '--token ${LV}`, `api_key: '[redacted:secret] [redacted:secret]`],
  [`password: 'api.key: "${LV}"`, `password: '[redacted:secret] "[redacted:secret]"`],
  [`password: 'abc token: "${LV}"`, `password: '[redacted:secret] token: "[redacted:secret]"`],
  [`password: 'x"token": "${LV}"`, `password: '[redacted:secret]": "[redacted:secret]"`],
  [`api_key: 'x:basic ${LV}`, `api_key: '[redacted:secret]`],
  [`api.key: token: "${LV}"`, 'api.key: [redacted:secret] "[redacted:secret]"'],
  [`api_key: token: "${LV}"`, 'api_key: [redacted:secret] "[redacted:secret]"'],
  [`password: token: "${LV}"`, 'password: [redacted:secret] "[redacted:secret]"'],
  [`api.key: --token ${LV}`, 'api.key: [redacted:secret] [redacted:secret]'],
  // A quoted word with a separator after it is hidden as a value, and what it names is hidden too.
  [`api.key: "token": "${LV}"`, 'api.key: "[redacted:secret]": "[redacted:secret]"'],
  [`api_key: "token": "${LV}"`, 'api_key: "[redacted:secret]": "[redacted:secret]"'],
  [`api.key: 'token': '${LV}'`, `api.key: '[redacted:secret]': '[redacted:secret]'`],
  [`-Dapi.key=user:basic ${LV}`, '-Dapi.key=[redacted:secret]'],
  [`api.key: x:bearer ${LV}`, 'api.key: [redacted:secret]'],
];

test("a field nested in another field's value keeps its own value hidden", () => {
  agreeOn(NESTED_AFTER_QUOTE, [], LV);
  // A closed single-quoted value whose closing quote opened a field's value reads the same on a
  // second pass, when that quote is gone.
  for (const r of [createRedactor(), createSecretsOnlyRedactor()]) {
    const once = r.redact(`@${LV}=Cookie = 'secret.keyapi.key--password  = '`);
    assert.equal(r.redact(once), once);
  }
  // A hidden value may hold another field's name in turn, whose value is hidden too. In the
  // inputs marked false the published redactor's KEY=VALUE rule (its step 2, before the field
  // rules) takes the nested name as its key's value (`"token":`, `AcmeCookie:Authorization:`)
  // and shows what follows, as it does on main: that rule is left as it is here. The
  // secrets-only scrubber, which reads the field rules first, hides it.
  for (const [input, publishedToo] of [
    [`'TOKEN=abc','TOKEN = abc','TOKEN  =  "${LV} def"'`, true],
    [`client_secret: token=  AcmeCookie:Authorization: ${LV}`, false],
    [`password="token": "${LV}"`, false],
    [`api_key: token=password=secret=${LV} more`, true],
  ]) {
    for (const [name, r, hides] of [['published', createRedactor(), publishedToo], ['secrets-only', createSecretsOnlyRedactor(), true]]) {
      const once = r.redact(input);
      if (hides) assert.ok(!once.includes(LV), `${name}: ${input} -> ${once}`);
      assert.equal(r.redact(once), once, `${name} idempotent: ${input}`);
    }
    const audit = redactWithAudit(input, {});
    if (publishedToo) assert.ok(!audit.text.includes(LV), `audit: ${input} -> ${audit.text}`);
    assert.equal(createRedactor().redact(audit.text), audit.text, `fixed point: ${input}`);
  }
  for (const input of [JSON.stringify({ msg: `password: 'token: "${LV}"` }), JSON.stringify(JSON.stringify({ msg: `api_key: 'token: "${LV}"` }))]) {
    const out = createRedactor().redact(input);
    assert.ok(!out.includes(LV), `published: ${input} -> ${out}`);
    assert.ok(!createSecretsOnlyRedactor().redact(input).includes(LV), `secrets-only: ${input}`);
    assert.equal(redactWithAudit(input, {}).text, out, `audit: ${input}`);
  }
});

// A closed quoted value whose last word is a field with its separator after it (`"hello token":`)
// is hidden, and so is that field's value, each in its own quotes: the text between them stays.
// A dotted key such as `api.key` is a field now, so without this it showed values main hid.
// When the field's value takes the closing quote itself (`'token='…`), the two are hidden as
// one. A field whose value starts inside the quotes ends with them. Made-up values.
// [input, the published output]
const CLOSED_QUOTE_THEN_FIELD = [
  [`api.key: "hello token": "${LV}"`, 'api.key: "[redacted:secret]": "[redacted:secret]"'],
  [`api.key: 'hello token': '${LV}'`, `api.key: '[redacted:secret]': '[redacted:secret]'`],
  [`api.key="hello token"="${LV}"`, 'api.key="[redacted:secret]"="[redacted:secret]"'],
  [`api_key: "hello token": "${LV}"`, 'api_key: "[redacted:secret]": "[redacted:secret]"'],
  [`-Dapi.key='token='${LV}`, '-Dapi.key=[redacted:secret]'],
  [`api.key='token='${LV}`, 'api.key=[redacted:secret]'],
  [`api.key='token: '${LV}`, `api.key='[redacted:secret]'[redacted:secret]`],
  [`{\\"api.key\\": \\"my token\\": \\"${LV}\\"}`, '{\\"api.key\\": \\"[redacted:secret]\\": \\"[redacted:secret]\\"}'],
  [`password: 'api.key=${LV}' ok`, `password: '[redacted:secret]' ok`],
];

test('a closed quoted value ending on a field has that field\'s value hidden too', () => {
  agreeOn(CLOSED_QUOTE_THEN_FIELD, [], LV);
  // A word in the value that isn't followed by a separator leaves the value as it was.
  assert.equal(createRedactor().redact('api_key: "my token", region: eu'), 'api_key: "[redacted:secret]", region: eu');
});

// A quoted value that reads like a key (`"Secret2024":`) may be the password itself, so it is
// hidden, and so is the value after it. Hiding a value never stops a name inside it from being
// read: `auth`, hidden as pass's value, still hides what follows its "=" on the next line.
// Made-up values.
test('a quoted value that reads like a key, or holds one, stays hidden', () => {
  // Each password here is itself a word naming a secret, the shape that used to be shown.
  for (const [password, rows] of [
    ['Secret2024', [[`password: "Secret2024":`, 'password: "[redacted:secret]":'], [`password: 'Secret2024': 'x'`, `password: '[redacted:secret]': '[redacted:secret]'`]]],
    ['MySecret123', [[`password: "MySecret123": " ok"`, 'password: "[redacted:secret]": "[redacted:secret]"'], [`{"password": "MySecret123": "x"}`, '{"password": "[redacted:secret]": "[redacted:secret]"}']]],
    ['Tokyo_pass', [[`password: "Tokyo_pass": ok`, 'password: "[redacted:secret]": [redacted:secret]']]],
  ]) agreeOn(rows, [], password);
  agreeOn([[`auth: 'pass='auth\n= ${LV}`, 'auth: [redacted:secret]\n= [redacted:secret]']], [], LV);
});

// The three redactors on one input: [published, secrets-only, audit] outputs, and a second pass
// of each over its own output, which must change nothing.
function threeWays(input) {
  const out = [createRedactor().redact(input), createSecretsOnlyRedactor().redact(input), redactWithAudit(input, {}).text];
  const again = [createRedactor().redact(out[0]), createSecretsOnlyRedactor().redact(out[1]), redactWithAudit(out[2], {}).text];
  return { out, again };
}

// A value that holds a secret-sounding word (pass, secret, token), after a quoted word: the
// reader used to refuse to go on past any such word, the value included, and showed the value.
// Made-up values. [input, the value, the published output, the secrets-only output]
test('a value holding a secret-sounding word is hidden after a quoted word', () => {
  for (const [input, value, published, shown = published] of [
    ['secret="pass":Tokyo_pass', 'Tokyo_pass', 'secret=[redacted:secret]', 'secret="[redacted:secret]":[redacted:secret]'],
    ['api.key: "hello token": "MyPassword123"', 'MyPassword123', 'api.key: "[redacted:secret]": "[redacted:secret]"'],
    ["api.key='token='pass_Xk9mP2qRz7", 'pass_Xk9mP2qRz7', 'api.key=[redacted:secret]'],
    ["-Dapi.key='token='pass_Xk9mP2qRz7", 'pass_Xk9mP2qRz7', '-Dapi.key=[redacted:secret]'],
  ]) {
    const { out, again } = threeWays(input);
    assert.deepEqual(out, [published, shown, published], input);
    for (const o of out) assert.ok(!o.includes(value), `${input} -> ${o}`);
    assert.deepEqual(again, out, `a second pass: ${input}`);
  }
});

// A key and its "=" on different lines, with a quoted value that reads like a key: the
// KEY=VALUE rule hides it, as it does on main, whatever follows its closing quote. Made-up values.
// [input, the published output, the secrets-only output, the audit's]
test('a quoted secret-sounding word on the line after its "=" is hidden', () => {
  for (const [input, published, shown, audited] of [
    ['token\n="Secret2024":', 'token=[redacted:secret]', 'token\n=[redacted:secret]', 'token\n=[redacted:secret]'],
    ["passwd=\n'Secret2024'=", 'passwd=[redacted:secret]', 'passwd=\n[redacted:secret]', 'passwd=\n[redacted:secret]'],
    ['token\r\n= "Secret2024": x', 'token=[redacted:secret] x', 'token\r\n= [redacted:secret] [redacted:secret]', 'token\r\n= [redacted:secret] x'],
  ]) {
    const { out, again } = threeWays(input);
    assert.deepEqual(out, [published, shown, audited], input);
    for (const o of out) assert.ok(!o.includes('Secret2024'), `${input} -> ${o}`);
    assert.deepEqual(again, out, `a second pass: ${input}`);
  }
});

// A quoted word that names a secret, right after "=": every redactor reads it as the value, as
// on main, so a second pass finds what the first left. [input, published and audit, secrets-only]
test('a second pass changes nothing after a quoted word that names a secret', () => {
  for (const [input, published, shown] of [
    ['passwd="token":', 'passwd=[redacted:secret]', 'passwd="[redacted:secret]":'],
    ['password="auth": ', 'password=[redacted:secret] ', 'password="[redacted:secret]": '],
    ["secret='token'=", 'secret=[redacted:secret]', "secret='[redacted:secret]'="],
  ]) {
    const { out, again } = threeWays(input);
    assert.deepEqual(out, [published, shown, published], input);
    assert.deepEqual(again, out, `a second pass: ${input}`);
  }
});

// Values hidden one after another keep the text between them: closing brackets and commas stay.
test('hiding a value after a quoted word leaves the brackets and commas around it', () => {
  agreeOn([
    ['x = {password: "Secret2024": "v"}, user: "bob"', 'x = {password: "[redacted:secret]": "[redacted:secret]"}, user: "bob"'],
    ['{"api.key": "my token": "v"}, [1]', '{"api.key": "[redacted:secret]": "[redacted:secret]"}, [1]'],
  ], [], 'Secret2024');
  // A quoted value that doesn't name a secret hides only itself, as before.
  agreeOn([['password: "hunter2": "nextval"', 'password: "[redacted:secret]": "nextval"']], [], 'hunter2');
});

// Generated inputs over the shapes that have leaked before: a made-up value planted under a
// sensitive key (plain, dotted, quoted, an option, a Java property), after "=" or ":" on its
// line or with the "=" split onto another line, with or without quotes, in front of text that
// closes or goes on, and behind text that holds other fields, quoted keys and unclosed quotes.
// Some values hold a secret-sounding word. Each stream is seeded, so the set never changes.
const PLANTED = {
  values: ['Xk9mP2qRz7', 'Tokyo_pass', 'MyPassword123', 'pass_Xk9mP2qRz7', 'Secret2024', 'tokenQ7x', 'auth9Zq'],
  // Keys the KEY=VALUE rule reads too, so their "=" may sit on another line; then the others.
  assigned: ['password', 'passwd', 'token', 'secret', 'api_key', 'auth', 'TOKEN', 'client_secret'],
  named: ['api.key', 'db.password', 'secret.key', 'x-api-key', '--token', '--api.key', '"password"', "'token'", '"api.key"'],
  sameLine: ['=', ': ', ':', ' = ', ':=', '="', ': "', "='", ": '", '=\\"'],
  split: ['\n=', '=\n', ' \n = ', '\r\n=', '=\r\n', '\n="', "\n='"],
  // A Java or Gradle property takes "=" right after its name.
  property: ['-Dapi.key', '-Psigning.password', '-Dapi_key'],
  propertySep: ['=', '="', "='"],
  before: ['', 'note: see ', 'user: "bob", ', '{', 'run ', 'api_key: "hello token": ', 'secret="pass":', "auth: 'pass='", 'password: "Secret2024": ', "api.key: 'token: ", 'token: "Ab3d, ', 'x = {', 'passwd="token":', 'token\n="Secret2024": ', '-Dlog.level=debug ', 'api_key: token: '],
  after: ['', ' ok', ', region: eu', '"', "'", '": "v"', "': 'v'", '}', '"}, user: "bob"', '\nnote: fine', ' token: x', '\n= x', '":', "'=", ' --flag', '\\"'],
};
function plantedInput(seed) {
  const next = stream(seed);
  const pick = (a) => a[next(a.length)];
  const value = pick(PLANTED.values);
  const kind = next(8);
  const [keys, seps] = kind < 2 ? [PLANTED.assigned, PLANTED.split] : kind === 2 ? [PLANTED.property, PLANTED.propertySep] : [[...PLANTED.assigned, ...PLANTED.named], PLANTED.sameLine];
  return [pick(PLANTED.before) + pick(keys) + pick(seps) + value + pick(PLANTED.after), value];
}

test('2,000 generated inputs: the planted value never shows, and a second pass changes nothing', () => {
  for (let i = 0; i < 2000; i += 1) {
    const [input, value] = plantedInput(`planted-${i}`);
    const { out, again } = threeWays(input);
    for (const o of out) assert.ok(!o.includes(value), `${JSON.stringify(input)} -> ${JSON.stringify(o)}`);
    assert.deepEqual(again, out, `a second pass: ${JSON.stringify(input)}`);
  }
});

// A value whose nested fields reach the end of its line's text stops reading them there, and
// the fields on the next line are still read on their own. Made-up values.
test('a value that reaches its line\'s end leaves the next line\'s fields to be read', () => {
  agreeOn([
    [`api_key: token: token: ${LV}   \npassword: ${LV} ok`, 'api_key: [redacted:secret] [redacted:secret] [redacted:secret]   \npassword: [redacted:secret]'],
    [`password:password: ${LV}  \nnote: fine\ntoken: "${LV}" done`, 'password:[redacted:secret]  \nnote: fine\ntoken: "[redacted:secret]" done'],
    [`${'token:'.repeat(40)}${LV}\napi.key=${LV} x`, 'token:[redacted:secret]\napi.key=[redacted:secret] x'],
  ], [], LV);
});

test('a record key that is a code file or a length keeps its value; a dotted key named for a credential hides it', () => {
  const shown = { 'auth.ts': 'ordinary contents', 'token.js': 'ordinary contents', 'password.length': '8', 'auth.test.mjs': 'ordinary contents' };
  // A data file named for a secret may hold the secret itself, so its value stays hidden.
  const hidden = { 'api.key': LV, 'db.password': LV, 'auth.token': LV, 'token.value': LV, 'secret.key': LV, 'password.txt': LV, 'token.json': LV };
  for (const r of [createRedactor(), createSecretsOnlyRedactor()]) {
    assert.deepEqual(r.deepRedact(shown), shown);
    assert.deepEqual(r.deepRedact(hidden), Object.fromEntries(Object.keys(hidden).map((k) => [k, '[redacted:secret]'])));
  }
  // The view's leak count reads keys the same way: a shown value under such a key isn't a leak.
  assert.equal(keyedSecrets(shown), 0);
  assert.equal(keyedSecrets(hidden), Object.keys(hidden).length);
});

test('Java properties and dotted keys stay fast on 200,000-character inputs', () => {
  const inputs = [
    'a.'.repeat(100000),
    `${'api.'.repeat(50000)}key=x`,
    '-Da.'.repeat(50000),
    '-Dapi.key='.repeat(20000),
    '-D'.repeat(100000),
    `token: "${'a.'.repeat(100000)}`,
    `token: "${'api.key: "'.repeat(20000)}`,
    `token: "${'x --api.key="'.repeat(15400)}`,
    `note: "${'see api.key=x '.repeat(14300)}`,
    `password: '${'a b '.repeat(50000)}`,
    "token: '".repeat(25000),
    `${'-Pa.b.c.d.'.repeat(20000)}=x`,
    'password.length '.repeat(12500),
    `${'token:'.repeat(33400)}x`,
    'password:password: '.repeat(10600),
    'api_key: token=x '.repeat(11800),
    // A value that reaches its line's text, with spaces after it, and many such lines. The limit
    // catches time that grows faster than the input; a slower constant (each value re-reading
    // the rest of its line, about 10 times main's time) passed here and failed only on a slow
    // runner, so these inputs are timed as well, not proof that the constant stays down.
    `${'token:'.repeat(33400)}x${' '.repeat(1000)}`,
    `${'token:'.repeat(40)}x  \n`.repeat(820),
    `${'password:password: '.repeat(40)}\n`.repeat(270),
    // Names repeated in one unspaced stretch, each with a quote or a line break after its "=":
    // the reader that looks past a hidden name for its "=" scans each stretch once.
    "token='".repeat(28600),
    'token="'.repeat(28600),
    'auth=="'.repeat(28600),
    'secret="pass":'.repeat(14300),
    'passwd="token":'.repeat(13400),
    "api.key='token='".repeat(12500),
    'token\n='.repeat(28600),
    "'pass='auth\n= x ".repeat(12500),
    'api.key: "hello token": '.repeat(8400),
    // Many fields inside one closed quoted value: none is read past the quote.
    `password: "${'token='.repeat(33400)}x"`,
    `password: '${'token='.repeat(33400)}x'`,
    `api.key: "${'hello token: '.repeat(15400)}": x`,
  ];
  for (const input of inputs) {
    assert.ok(input.length >= 200000, `${input.length} characters`);
    for (const [name, run] of [['published', (s) => createRedactor().redact(s)], ['secrets-only', (s) => createSecretsOnlyRedactor().redact(s)], ['audit', (s) => redactWithAudit(s, {})]]) {
      const started = Date.now();
      run(input);
      const ms = Date.now() - started;
      assert.ok(ms < 1000, `${name} took ${ms} ms on a ${input.length}-character input starting ${JSON.stringify(input.slice(0, 20))}`);
    }
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
  const record = { token: { value: 'hunter2', kind: 'bearer', otp: 123456789012, ttl: 30 }, apiKeys: [{ value: 'hunter3' }, 'hunter4'], credentials: { db: { password: 'x', host: 'db.internal' } }, note: { value: 'kept' }, fileKey: 'k-abc' };
  const want = { token: { value: '[redacted:secret]', kind: '[redacted:secret]', otp: '[redacted:secret]', ttl: 30 }, apiKeys: [{ value: '[redacted:secret]' }, '[redacted:secret]'], credentials: { db: { password: '[redacted:secret]', host: '[redacted:secret]' } }, note: { value: 'kept' }, fileKey: 'k-abc' };
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
    "Auth:r =user=''Password===''qk9mp2qrz7 more",
  ]) {
    const once = r.redact(raw);
    assert.equal(r.redact(once), once, raw);
    assert.ok(!once.includes('qk9mp2qrz7'), once);
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
