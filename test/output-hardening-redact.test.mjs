// Redactor gaps found in a security review, each with made-up secrets and terms: a slow
// currency pattern, the term fast path turned off by three special letters, the `=>`
// separator, bare hex keys spared as commit ids, encoded email addresses, and smaller gaps
// (SecureString, ODBC, XML, encoded home folders, NFD spellings, GitLab tokens).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor, createSecretsOnlyRedactor, redactWithAudit } from '../lib/redact.mjs';

const full = (terms = []) => createRedactor({ redaction: { codenames: [], names: [], terms } });

// Growth between a quarter and a full length input, as in test/redact-secret-fields.test.mjs:
// time in step with length is about 4 times, time that grows with the square about 16.
const MAX_GROWTH = 10;
const FLOOR_MS = 50;
const CEILING_MS = 3000;
function assertGrowsInStep(label, build, run) {
  const timed = (input) => {
    const started = performance.now();
    run(input);
    return performance.now() - started;
  };
  const quarter = build(0.25);
  let quarterMs = Infinity;
  for (let i = 0; i < 3; i += 1) quarterMs = Math.min(quarterMs, timed(quarter));
  const whole = build(1);
  let fullMs = Infinity;
  for (let i = 0; i < 3; i += 1) {
    fullMs = Math.min(fullMs, timed(whole));
    if (fullMs < CEILING_MS && (fullMs < FLOOR_MS || fullMs / quarterMs < MAX_GROWTH)) break;
  }
  const said = `${label}: ${fullMs.toFixed(1)} ms at full length, ${quarterMs.toFixed(1)} ms at a quarter`;
  assert.ok(fullMs < CEILING_MS, `${said}, over the ${CEILING_MS} ms limit`);
  assert.ok(fullMs < FLOOR_MS || fullMs / quarterMs < MAX_GROWTH, `${said}, ${(fullMs / quarterMs).toFixed(1)} times as long`);
}

// --- 4. speed ---------------------------------------------------------------------------

test('a long run of digits and commas is scanned in linear time, by the redactor and the audit', () => {
  const build = (scale) => '1,'.repeat(Math.round(100000 * scale));
  const r = full();
  assertGrowsInStep('redact', build, (s) => r.redact(s));
  assertGrowsInStep('redactWithAudit', build, (s) => redactWithAudit(s, {}));
  // Amounts are still hidden.
  assert.equal(r.redact('it cost 1,200 dollars'), 'it cost [redacted:account]');
  assert.equal(r.redact('paid 1,250.50 USD today'), 'paid [redacted:account] today');
});

test('a long run of URL-encoded slashes with no user folder after it is scanned in linear time', () => {
  for (const sep of ['%2F', '%5C']) {
    const build = (scale) => `${sep.repeat(Math.round(50000 * scale))}Users`;
    const r = full();
    assertGrowsInStep(`redact ${sep}`, build, (s) => r.redact(s));
    assertGrowsInStep(`redactWithAudit ${sep}`, build, (s) => redactWithAudit(s, {}));
  }
  // A path after a run of separators is still hidden whole.
  assert.equal(full().redact('see %2F%2F%2FUsers%2Fjdoe%2Frepo now'), 'see [redacted:path] now');
});

test('the term fast path stays on when the text holds a dotted capital I, a long s or a Kelvin sign', () => {
  const terms = Array.from({ length: 100 }, (_, i) => `Wexlor${String.fromCharCode(97 + (i % 26))}${i}`);
  const r = full(terms);
  const body = 'the build ran and the tests passed after the fix '.repeat(4000);
  for (const c of [0x130, 0x17f, 0x212a]) {
    const odd = String.fromCharCode(c);
    const build = (scale) => body.slice(0, Math.round(body.length * scale)) + odd;
    assertGrowsInStep(`U+${c.toString(16)}`, build, (s) => r.redact(s));
    // Comparable with the plain text, not many times slower.
    const t0 = performance.now(); r.redact(body); const plain = performance.now() - t0;
    const t1 = performance.now(); r.redact(body + odd); const withOdd = performance.now() - t1;
    assert.ok(withOdd < Math.max(FLOOR_MS * 4, plain * 8), `U+${c.toString(16)}: ${withOdd.toFixed(1)} ms against ${plain.toFixed(1)} ms`);
  }
  // A term is still found next to one of them.
  assert.equal(full(['Wexlor']).redact(`${String.fromCharCode(0x212a)} wexlor`), `${String.fromCharCode(0x212a)} [redacted:term]`);
});

// --- 5. bypasses ------------------------------------------------------------------------

test('the => separator hides the value, not the ">"', () => {
  for (const r of [full(), createSecretsOnlyRedactor()]) {
    for (const [input, gone] of [
      ["'password' => 'tulipMango42'", 'tulipMango42'],
      ['"api_key" => "orchidPebble77"', 'orchidPebble77'],
      ['token => mapleEmber19', 'mapleEmber19'],
    ]) {
      const out = r.redact(input);
      assert.ok(!out.includes(gone), `${input} -> ${out}`);
      assert.ok(out.includes('=>'), `${input} -> ${out}`);
    }
  }
});

test('a bare 32 to 39 character hex key is hidden; short and full commit ids stay', () => {
  const key32 = 'f3a9c1e07b5d42a8c6e1f0b9d3a7c5e2';
  const key36 = `${key32}a1b2`;
  const sha40 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  for (const r of [full(), createSecretsOnlyRedactor()]) {
    assert.equal(r.redact(`key ${key32} here`), 'key [redacted:secret] here');
    assert.equal(r.redact(`key ${key36} here`), 'key [redacted:secret] here');
    assert.equal(r.redact(`commit ${sha40} and a1b2c3d`), `commit ${sha40} and a1b2c3d`);
    assert.equal(r.redact('short a1b2c3d4e5f6'), 'short a1b2c3d4e5f6');
  }
  assert.equal(redactWithAudit(`key ${key32}`, {}).text, 'key [redacted:secret]');
  assert.equal(redactWithAudit(`commit ${sha40}`, {}).text, `commit ${sha40}`);
});

test('an email address with an encoded "@" is hidden', () => {
  const r = full();
  for (const input of ['mail name%40example.com now', 'mail name\\u0040example.com now', 'mail name&#64;example.com now', 'mail Name%40Example.COM now']) {
    assert.equal(r.redact(input), 'mail [redacted:email] now', input);
    assert.equal(redactWithAudit(input, {}).text, 'mail [redacted:email] now', input);
  }
  // Text with no address stays.
  assert.equal(r.redact('100%40 of it'), '100%40 of it');
});

// --- 7. smaller gaps ----------------------------------------------------------------------

test('SecureString literals after -AsPlainText or piped in are hidden', () => {
  for (const r of [full(), createSecretsOnlyRedactor()]) {
    for (const input of [
      'ConvertTo-SecureString -AsPlainText "tulipMango42" -Force',
      'ConvertTo-SecureString -String "tulipMango42" -AsPlainText -Force',
      "ConvertTo-SecureString -AsPlainText -Force 'tulipMango42'",
      '$p = "tulipMango42" | ConvertTo-SecureString -AsPlainText -Force',
    ]) {
      assert.ok(!r.redact(input).includes('tulipMango42'), input);
    }
  }
});

test('ODBC PWD and XML password elements are hidden', () => {
  for (const r of [full(), createSecretsOnlyRedactor()]) {
    for (const input of ['Driver={x};Server=db;UID=sa;PWD=tulipMango42;', 'Server=db;Pwd=tulipMango42;', '<password>tulipMango42</password>', '<ns:apiKey>tulipMango42</ns:apiKey>']) {
      assert.ok(!r.redact(input).includes('tulipMango42'), `${input} -> ${r.redact(input)}`);
    }
  }
  // A plain XML element and a cwd are left.
  assert.equal(full().redact('<name>report</name>'), '<name>report</name>');
  assert.equal(full().redact('run pwd to see the folder'), 'run pwd to see the folder');
});

test("user names in Claude Code's encoded folder names and in URL-encoded paths are hidden", () => {
  const r = full();
  for (const input of [
    'see C--Users-jdoe-Projects-your-project now',
    'see -home-jdoe-work-your-project now',
    'see -Users-jdoe-dev now',
    'see C%3A%5CUsers%5Cjdoe%5Crepo now',
    'see file%3A%2F%2F%2FUsers%2Fjdoe%2Frepo now',
    'see %2Fhome%2Fjdoe%2Frepo now',
  ]) {
    assert.ok(!r.redact(input).includes('jdoe'), `${input} -> ${r.redact(input)}`);
  }
  // Ordinary hyphenated words stay.
  assert.equal(r.redact('my-home-page and --users-only'), 'my-home-page and --users-only');
});

test('a listed term matches in both its NFC and NFD spellings', () => {
  const nfc = 'Caf' + String.fromCharCode(0xe9) + 'lorn';
  const nfd = 'Caf' + 'e' + String.fromCharCode(0x301) + 'lorn';
  for (const [listed, text] of [[nfc, nfd], [nfd, nfc], [nfc, nfc]]) {
    assert.equal(full([listed]).redact(`at ${text} today`), 'at [redacted:term] today');
  }
});

test('a 26-character GitLab token is hidden', () => {
  const tok = 'glpat-' + 'Xk9mP2qRz7Lm4Nq8Rt2a';
  assert.equal(tok.length, 26);
  for (const r of [full(), createSecretsOnlyRedactor()]) assert.equal(r.redact(`token ${tok} here`), 'token [redacted:secret] here');
});
