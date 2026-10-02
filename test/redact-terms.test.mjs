// A configured private term hidden inside a longer word: after an underscore or a digit,
// as one part of a camel-case name, or inside a web address or file name. The canonical
// redactor and the prompt-privacy audit share these patterns, so both are checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor } from '../lib/redact.mjs';
import { redactWithAudit, replayRedactions } from '../lib/prompt-privacy.mjs';
import { termMatchers } from '../lib/redaction-patterns.mjs';

const config = { redaction: { codenames: ['Falcon'], names: ['Jane Doe'], terms: ['acme', 'Project 7'] } };

const HIDDEN = [
  ['acme_report.md', '[redacted:term].md'],
  ['report_acme', 'report_[redacted:term]'],
  ['acme2 and 2acme', '[redacted:term]2 and 2[redacted:term]'],
  ['AcmeReport and myAcme and ACMEReport', '[redacted:term]Report and my[redacted:term] and [redacted:term]Report'],
  ['see www.acmehq.com/pricing', 'see www.[redacted:term].com/pricing'],
  ['https://api.acme-corp.example.org/v1', 'https://api.[redacted:term].example.org/v1'],
  ['acmereport.pdf', '[redacted:term].pdf'],
  ['FalconOps', '[redacted:term]Ops'],
  ['jane_doe, JaneDoe, jane.doe, jane-doe and Jane  Doe', '[redacted:term], [redacted:term], [redacted:term], [redacted:term] and [redacted:term]'],
  ['janedoe.example.com', '[redacted:term].example.com'],
  ['Project7 and Project 7', '[redacted:term] and [redacted:term]'],
  ['XMLAcmeThing, IAcmeClient and HTTPAcmeAdapter', 'XML[redacted:term]Thing, I[redacted:term]Client and HTTP[redacted:term]Adapter'],
  ['http://acmehq:3000/status and http://user@acmebox/', 'http://[redacted:term]:3000/status and http://user@[redacted:term]/'],
  ['acmelogo.3f9a2b1c.png and acmelogo.mp4', '[redacted:term].3f9a2b1c.png and [redacted:term].mp4'],
  ['Falconry.pdf', '[redacted:term].pdf'],
];
const KEPT = ['Falconry', 'academy', 'acmes', 'Janet Doe', 'Project 70', 'We met acmecorp. Then we left.'];

test('the redactor finds a term inside underscores, digits, camel case, web addresses and file names', () => {
  const red = createRedactor(config);
  for (const [input, expected] of HIDDEN) assert.equal(red.redact(input), expected, input);
});

test('words that only share letters with a term are kept', () => {
  const red = createRedactor(config);
  for (const input of KEPT) assert.equal(red.redact(input), input, input);
});

test('a short name never takes ordinary file names or code with it', () => {
  const short = { redaction: { names: ['Ion', 'Eve', 'Ada', 'Al'] } };
  const red = createRedactor(short);
  const prose = 'Updated session.ts, version.json, events.ts, metadata.json and local.json; read window.location.href.';
  assert.equal(red.redact(prose), prose);
  assert.equal(redactWithAudit(`Please check: ${prose}`, short).text, `Please check: ${prose}`);
  assert.equal(red.redact('Ion and Eve met Ada and Al.'), '[redacted:term] and [redacted:term] met [redacted:term] and [redacted:term].');
});

test('a person\'s name is found in web addresses but leaves ordinary file names alone', () => {
  const people = { redaction: { names: ['Bill', 'Mark', 'John'] } };
  const red = createRedactor(people);
  const files = 'Edited billing.ts, BillingService.java, markdown.ts, marked.min.js and johnson.pdf today.';
  assert.equal(red.redact(files), files);
  assert.equal(redactWithAudit(`Please check: ${files}`, people).text, `Please check: ${files}`);
  assert.equal(red.redact('see billhq.com, http://markbox/x and www.johnco.net'), 'see [redacted:term].com, http://[redacted:term]/x and www.[redacted:term].net');
  // A codename or term still takes a file name that starts with it.
  assert.equal(createRedactor({ redaction: { codenames: ['Bill'] } }).redact('billing.ts'), '[redacted:term].ts');
});

test('a web address with no dots is found in brackets, quotes and at a sentence end', () => {
  const red = createRedactor(config);
  for (const wrap of ['(x)', '<x>', '"x"', "'x'", 'x.', 'x,', '[docs](x)', 'x]']) {
    const input = `see ${wrap.replace('x', 'http://acmehq')} today`;
    assert.ok(!/acmehq/i.test(red.redact(input)), `${input} -> ${red.redact(input)}`);
    assert.equal(`Note: ${red.redact(input)} ok`, redactWithAudit(`Note: ${input} ok`, config).text, input);
  }
  for (const kept of ['http://xacmehq/', 'http://academy/', 'http://localhost:3000']) assert.equal(red.redact(kept), kept);
});

test('overlapping terms and odd letters: the redactor and the audit agree', () => {
  const both = { redaction: { terms: ['acme', 'acme.io', 'Doe Industries', 'Acme Cloud'], names: ['ǅemal', 'Jane Doe'] } };
  for (const input of ['see www.acme.io/path today', 'mail ǅemal and DŽEMAL', 'Jane Doe Industries signed', 'mail jane.doe_janedoe.com', 'see xyz-acme.Cloud now']) {
    assert.equal(`Note: ${createRedactor(both).redact(input)} ok`, redactWithAudit(`Note: ${input} ok`, both).text, input);
  }
  assert.doesNotMatch(createRedactor(both).redact('mail ǅemal today'), /ǅemal/);
});

test('the prompt-privacy audit flags and replaces the same spans', () => {
  for (const [input, expected] of HIDDEN) {
    const raw = `Please tidy ${input} before the review on Friday.`;
    const got = redactWithAudit(raw, config);
    assert.ok(got.rawDetectors.includes('configured-term'), input);
    assert.equal(got.text, `Please tidy ${expected} before the review on Friday.`, input);
    assert.equal(replayRedactions(raw, got.redactionOps), got.text);
  }
  const never = redactWithAudit('Ship the acme_report today, then rest.', { privacy: { publicRenditions: { neverPublicTerms: ['acme'] } } });
  assert.ok(never.rawDetectors.includes('never-public-term'));
  assert.doesNotMatch(never.text, /acme/i);
});

test('term matching stays fast on long adversarial inputs', () => {
  const inputs = ['acme-'.repeat(20000), 'acme.'.repeat(20000), `${'a'.repeat(100000)}acme`, 'aA'.repeat(50000), `${'x.'.repeat(50000)}acme`, 'acmeacme'.repeat(12500), `${'Acme'.repeat(25000)}.com`, `${'jane'.repeat(20000)}doe`];
  for (const re of termMatchers(['acme', 'Jane Doe'])) {
    for (const input of inputs) {
      const started = Date.now();
      re.lastIndex = 0;
      [...input.matchAll(re)];
      assert.ok(Date.now() - started < 1000, `${re.source.slice(0, 40)}… took ${Date.now() - started} ms on a ${input.length}-character input`);
    }
  }
});
