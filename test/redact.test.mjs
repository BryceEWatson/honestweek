import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRedactor, SECRET_PATTERNS } from '../lib/redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA40 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'; // lowercase hex, has letters
const SHA7 = 'deadbee'; // short SHA with letters

function r(config = {}) {
  return createRedactor(config);
}

test('shape: returns exactly { redact, deepRedact, count }, count starts at 0', () => {
  const red = r();
  assert.deepEqual(Object.keys(red).sort(), ['count', 'deepRedact', 'redact']);
  assert.equal(typeof red.redact, 'function');
  assert.equal(typeof red.deepRedact, 'function');
  assert.equal(red.count, 0);
});

test('redacts api-key prefixes and JWTs', () => {
  const red = r();
  for (const key of [
    'sk-abcdefghijklmnop1234567890',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-123456789012-abcdefghijkl',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
  ]) {
    const out = red.redact(`prefix ${key} suffix`);
    assert.match(out, /\[redacted:secret\]/, `should redact ${key}`);
    assert.doesNotMatch(out, new RegExp(key.slice(0, 12)), `raw key should be gone: ${key}`);
  }
});

test('KEY=VALUE: redacts the value, keeps the key text', () => {
  const red = r();
  const out = red.redact('export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa more');
  assert.match(out, /GITHUB_TOKEN=/);
  assert.match(out, /GITHUB_TOKEN=\[redacted:secret\]/);
  assert.doesNotMatch(out, /ghp_a/);
});

test('AUTHOR=... is NOT redacted (word-boundaried sensitive-key match)', () => {
  const red = r();
  const out = red.redact('AUTHOR=Jane Doe');
  assert.equal(out, 'AUTHOR=Jane Doe');
});

test('AUTH_TOKEN and AUTHORIZATION values ARE redacted', () => {
  const red = r();
  assert.match(red.redact('AUTH_TOKEN=supersecretvalue123'), /AUTH_TOKEN=\[redacted:secret\]/);
  assert.match(red.redact('AUTHORIZATION=Bearerabcxyz'), /AUTHORIZATION=\[redacted:secret\]/);
});

test('emails, UUIDs, and 9+ digit account numbers are redacted', () => {
  const red = r();
  assert.match(red.redact('mail dev.user@example.com here'), /\[redacted:email\]/);
  assert.match(red.redact('id 550e8400-e29b-41d4-a716-446655440000'), /\[redacted:secret\]/);
  assert.match(red.redact('acct 123456789'), /\[redacted:account\]/);
  assert.match(red.redact('acct 1234567890123456'), /\[redacted:account\]/);
});

test('currency is redacted only when $/keyword-gated; bare numbers are not', () => {
  const red = r();
  assert.match(red.redact('price $1,200'), /\[redacted:account\]/);
  assert.match(red.redact('price USD 1200'), /\[redacted:account\]/);
  assert.match(red.redact('price 1200 dollars'), /\[redacted:account\]/);
  assert.equal(red.redact('bare 1200 count'), 'bare 1200 count');
});

test('home paths are redacted for POSIX, macOS, Windows, and git-bash forms', () => {
  const red = r();
  assert.match(red.redact('at /home/alice/project/file'), /\[redacted:path\]/);
  assert.match(red.redact('at /Users/carol/project/file'), /\[redacted:path\]/);
  const win = red.redact('at C:\\Users\\bob\\secret-client.txt rest');
  assert.match(win, /\[redacted:path\]/);
  assert.doesNotMatch(win, /bob/);
  assert.doesNotMatch(win, /secret-client/);
  assert.match(red.redact('at /c/Users/dave/proj/x'), /\[redacted:path\]/);
});

test('SPARE: a lowercase 40-hex git SHA passes through unchanged', () => {
  const red = r();
  assert.equal(red.redact(`commit ${SHA40} landed`), `commit ${SHA40} landed`);
  assert.equal(red.count, 0, 'no redaction should have occurred');
});

test('SPARE: a short 7-12 char lowercase-hex SHA passes through unchanged', () => {
  const red = r();
  assert.equal(red.redact(`see ${SHA7}`), `see ${SHA7}`);
  assert.equal(red.redact('see deadbeefcafe'), 'see deadbeefcafe'); // 12 hex chars
});

test('SPARE: plain counts and percentages pass through unchanged', () => {
  const red = r();
  for (const s of ['8 of 13', '22 tests', '31.3%', 'standalone 1200', '87%', 'fixed 12 bugs']) {
    assert.equal(red.redact(s), s, `should spare: ${s}`);
  }
  assert.equal(red.count, 0);
});

test('default-empty term-lists redact nothing of their own', () => {
  const red = r({});
  const s = 'Project Falcon shipped at acme corp';
  assert.equal(red.redact(s), s);
  assert.equal(red.count, 0);
});

test('configured term-lists redact those tokens case-insensitively, sparing unrelated text', () => {
  const red = r({ redaction: { codenames: ['Falcon'], names: ['Jane'], terms: ['acme'] } });
  const out = red.redact('Falcon and falcon and ACME, but Falconry and academy are fine. Jane too.');
  assert.match(out, /\[redacted:term\]/);
  assert.doesNotMatch(out, /Falcon\b/i);
  assert.doesNotMatch(out, /\bacme\b/i);
  assert.match(out, /Falconry/, 'whole-token boundary: Falconry survives');
  assert.match(out, /academy/, 'whole-token boundary: academy survives');
});

test('deepRedact recurses, returns a NEW non-mutated structure, increments count', () => {
  const red = r();
  const input = {
    steers: ['contact dev@example.com', 'use 22 tests'],
    nested: { token: 'sk-abcdefghijklmnop1234567890', n: 42, ok: true },
    list: [{ sha: SHA40, subject: 'fix for jane@example.org' }],
    nullv: null,
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = red.deepRedact(input);

  assert.deepEqual(input, snapshot, 'input must not be mutated');
  assert.notEqual(out, input);
  assert.match(out.steers[0], /\[redacted:email\]/);
  assert.equal(out.steers[1], 'use 22 tests'); // count spared
  assert.match(out.nested.token, /\[redacted:secret\]/);
  assert.equal(out.nested.n, 42); // non-string preserved
  assert.equal(out.nested.ok, true);
  assert.equal(out.nullv, null);
  assert.ok(red.count > 0);
});

test('candidateCommits[].sha survives deepRedact (receipt-survival)', () => {
  const red = r({ redaction: { terms: ['client'] } });
  const digest = {
    candidateCommits: [{ sha: SHA40, date: '2024-01-01', subject: 'client login fix' }],
  };
  const out = red.deepRedact(digest);
  assert.equal(out.candidateCommits[0].sha, SHA40, 'SHA must survive verbatim');
  assert.match(out.candidateCommits[0].subject, /\[redacted:term\]/, 'subject term redacted');
});

test('count reflects the cumulative number of redactions across multiple calls', () => {
  const red = r();
  assert.equal(red.count, 0);
  red.redact('a@b.com'); // +1
  const after1 = red.count;
  assert.ok(after1 >= 1);
  red.redact('c@d.com and e@f.com'); // +2
  assert.equal(red.count, after1 + 2);
});

test('redaction is idempotent and the second pass adds no new redactions', () => {
  const red = r({ redaction: { terms: ['acme'] } });
  const s = `acme at dev@example.com paid $1,200 token sk-abcdefghijklmnop1234567890 commit ${SHA40}`;
  const once = red.redact(s);
  const countAfterFirst = red.count;
  const twice = red.redact(once);
  assert.equal(twice, once, 'redact(redact(s)) must equal redact(s)');
  assert.equal(red.count - countAfterFirst, 0, 'second pass must add no redactions');
  // SHA still present after both passes
  assert.match(twice, new RegExp(SHA40));
});

test('only the five normative placeholder kinds ever appear', () => {
  const red = r({ redaction: { terms: ['acme'] } });
  const out = red.redact(
    'acme dev@example.com /home/x/y 123456789 $5 sk-abcdefghijklmnop1234567890 550e8400-e29b-41d4-a716-446655440000'
  );
  const kinds = [...out.matchAll(/\[redacted:([a-z]+)\]/g)].map((m) => m[1]);
  const allowed = new Set(['email', 'secret', 'path', 'term', 'account']);
  for (const k of kinds) assert.ok(allowed.has(k), `unexpected placeholder kind: ${k}`);
});

test('clean-room: module source contains no obvious personal data and an empty config is inert', () => {
  const src = readFileSync(resolve(HERE, '..', 'lib', 'redact.mjs'), 'utf8');
  // No hardcoded emails or home paths baked into the scrubber itself.
  assert.doesNotMatch(src, /@(?:gmail|outlook|yahoo|proton)\./i);
  assert.doesNotMatch(src, /\/home\/[a-z]+\/|C:\\Users\\[A-Za-z]+\\/);
  const red = r({});
  assert.equal(red.redact('a perfectly ordinary sentence with 3 items'), 'a perfectly ordinary sentence with 3 items');
});

// --- adversarial regressions (found by the redactor red-team) ---------------

test('REGRESSION: multi-word terms redact across any whitespace separator', () => {
  const red = r({ redaction: { names: ['Jane Doe'], terms: ['acme corp'] } });
  for (const sep of [' ', '  ', '\t', '\n', ' ']) {
    const out = red.redact(`report by Jane${sep}Doe today`);
    assert.match(out, /\[redacted:term\]/, `separator ${JSON.stringify(sep)} should still match`);
    assert.doesNotMatch(out, /Doe/, `surname must not leak for separator ${JSON.stringify(sep)}`);
  }
  assert.match(red.redact('signed acme  corp deal'), /\[redacted:term\]/);
  // whole-token boundary still holds: "Janet Doe" is not "Jane Doe"
  assert.match(red.redact('Janet Doe was here'), /Janet Doe/);
});

test('REGRESSION: large percentages and decimals are spared (not mangled as account)', () => {
  const red = r();
  assert.equal(red.redact('coverage 123456789%'), 'coverage 123456789%');
  assert.equal(red.redact('ratio 123456789.5 done'), 'ratio 123456789.5 done');
  assert.equal(red.redact('frac 0.123456789'), 'frac 0.123456789');
  assert.equal(red.count, 0);
  // a bare large integer is still treated as an account number (over-redaction OK)
  assert.match(red.redact('acct 123456789'), /\[redacted:account\]/);
});

test('REGRESSION: a space-containing home username does not leak the surname', () => {
  const red = r();
  const posix = red.redact('saved to /home/alex jordan/notes/file.txt now');
  assert.doesNotMatch(posix, /jordan/, 'surname must be redacted');
  const win = red.redact('opened C:\\Users\\Alex Jordan\\report.docx today');
  assert.doesNotMatch(win, /Jordan/, 'surname must be redacted on Windows');
  // a bare "/home/user" followed by prose must NOT swallow the trailing words
  assert.match(red.redact('I work in /home/bob mostly'), /mostly/);
});

test('SECRET_PATTERNS is exported and frozen for transparency', () => {
  assert.ok(Array.isArray(SECRET_PATTERNS));
  assert.ok(Object.isFrozen(SECRET_PATTERNS));
  assert.ok(SECRET_PATTERNS.some((p) => p.name === 'email'));
});
