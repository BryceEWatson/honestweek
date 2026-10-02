// The prompt-privacy audit shares the redactor's path patterns, so it must keep an escaped
// quote intact the same way: a path inside JSON-encoded text leaves valid JSON behind. Its
// spans are code-point offsets, so they're checked against text that holds surrogate pairs,
// combining marks, and lone surrogates, and a long input with thousands of matches must stay fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePointOffsets, redactWithAudit, replayRedactions, assessPublicRendition } from '../lib/prompt-privacy.mjs';

test('a home path inside an escaped quote is redacted and the JSON still parses', () => {
  const raw = JSON.stringify({ cmd: 'git -C "C:\\Users\\user\\repo" status' });
  assert.ok(raw.includes('\\"C:\\\\Users'), 'the fixture really holds an escaped quote before the path');
  const out = redactWithAudit(raw).text;
  assert.doesNotMatch(out, /\\\\user\\\\/);
  assert.match(out, /\[redacted:path\]/);
  assert.doesNotThrow(() => JSON.parse(out));
});

test('the privacy audit stays fast on a long input with thousands of matches', () => {
  // Each match's position was once counted from the start of the text, so 100 KB of paths took seconds.
  const inputs = [
    '/home/alex/x '.repeat(8000),
    'C:\\Users\\alex\\x '.repeat(8000),
    'a.b@example.com '.repeat(7000),
    'é😀 /home/ålex/x n\u0303 a@b.co 🎉 C:\\Users\\bob\\y '.repeat(3000),
    // Every capitalized word follows a full stop, so the capitalized-word check scans all of them.
    'Done. Next. '.repeat(10000),
  ];
  for (const input of inputs) {
    assert.ok(input.length >= 100000, `the fixture is ${input.length} characters`);
    let started = Date.now();
    const audit = redactWithAudit(input, {});
    assert.ok(Date.now() - started < 1000, `redactWithAudit took ${Date.now() - started} ms on a ${input.length}-character input`);
    if (!input.startsWith('Done')) assert.ok(audit.redactionCount >= 6000, `only ${audit.redactionCount} matches`);
    started = Date.now();
    assessPublicRendition(input, {});
    assert.ok(Date.now() - started < 1000, `assessPublicRendition took ${Date.now() - started} ms on a ${input.length}-character input`);
  }
});

test('audit spans and output match a reference count around surrogate pairs and combining marks', () => {
  const nonWs = (s) => [...s].filter((c) => !/\s/u.test(c)).length;
  // Matches sit right against astral characters, combining marks, and lone surrogates, so a
  // UTF-16 offset and a code-point offset differ at every one of them.
  const pieces = [
    'é😀 (😀', { detector: 'email', token: 'a@b.co', placeholder: '[redacted:email]' }, '😀) n\u0303\u0301 ',
    { detector: 'home-path', token: '/home/å\u0301lex/😀x', placeholder: '[redacted:path]' }, ' \uD83D e\u0301',
    { detector: 'ip-address', token: '10.0.0.1', placeholder: '[redacted:secret]' }, '\u0301x \uDE00 "',
    { detector: 'home-path', token: 'C:\\Users\\zoë\\r😀', placeholder: '[redacted:path]' }, '" 🎉 token=',
    { detector: 'secret', token: '😀abc', placeholder: '[redacted:secret]' }, ' \uDE00\uD83D ',
  ];
  for (const repeat of [1, 80]) {
    let raw = ''; let expectedText = ''; const expectedOps = [];
    for (let r = 0; r < repeat; r += 1) {
      for (const piece of pieces) {
        if (typeof piece === 'string') { raw += piece; expectedText += piece; continue; }
        // The reference: count the code points before the match from the start, the slow, obvious way.
        const start = [...raw].length;
        expectedOps.push({ detector: piece.detector, start, end: start + [...piece.token].length, placeholder: piece.placeholder });
        raw += piece.token; expectedText += piece.placeholder;
      }
    }
    const got = redactWithAudit(raw, {});
    assert.deepEqual(got.redactionOps, expectedOps);
    const expectedChars = [...expectedText];
    assert.equal(got.text, expectedChars.slice(0, 4000).join(''));
    assert.equal(got.truncated, expectedChars.length > 4000);
    assert.equal(replayRedactions(raw, got.redactionOps), expectedText);
    assert.equal(got.redactionCount, 5 * repeat);
    assert.equal(got.sourceLength, nonWs(raw));
    const changed = pieces.filter((p) => typeof p !== 'string').reduce((n, p) => n + nonWs(p.token), 0) * repeat;
    assert.equal(got.changedPercent, Math.ceil(100 * changed / nonWs(raw)));
    assert.deepEqual(got.rawDetectors, ['email', 'home-path', 'secret', 'ip-address']);
  }
});

test('the code-point offset of every UTF-16 index matches counting the prefix', () => {
  // Lone surrogates, reversed pairs, and indexes that split a pair all count the way the
  // string iterator counts them.
  const text = 'a\uD83D\uDE00b\uD83D\uD83D\uDE00\uDE00\uDE00\uD83Dc\u0301😀\uDE00\uD83D';
  const toCp = codePointOffsets(text);
  for (let i = 0; i <= text.length; i += 1) assert.equal(toCp(i), [...text.slice(0, i)].length, `index ${i}`);
  assert.equal(codePointOffsets('')(0), 0);
});
