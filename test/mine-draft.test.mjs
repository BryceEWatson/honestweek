// test/mine-draft.test.mjs — the drafter's honesty contract.
//
// The failure mode this guards against is subtle and severe: a draft that reads as
// though its claims were checked. Everything in a draft comes from a log written on
// some past day about some past build. If the drafter fills in a date, a description
// or a "last verified" field, it launders that into a present-tense claim, and the
// person publishing it has no way to see which parts were ever tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cannotCheckFromLog, renderDraft, slugFor, titleFor, verificationPlan } from '../lib/mine/draft.mjs';

const finding = (over = {}) => ({
  findingKey: 'k',
  corpus: 'claude-code',
  startedAt: '2026-06-25T10:00:00.000Z',
  score: 25,
  measuredScore: 18,
  sessionCount: 2,
  primaryError: 'VM service not running. The service failed to start.',
  alternateErrors: [],
  products: [{ name: 'Acme', sources: ['install-path'] }],
  versions: ['1.25927.0.0'],
  resolution: [{ kind: 'human-confirmed', detail: 'that worked', strength: 'strong' }],
  evidence: { probeCommands: ['Get-Service AcmeVMService'], foreignPaths: ['<drive>/Program Files/Acme'], externalIssues: ['acme/app#1'], searchAttempts: 5 },
  ...over,
});

test('a last-verified field is emitted EMPTY, never filled in', () => {
  const { body } = renderDraft(finding(), {
    config: { mine: { draft: { dir: 'drafts', frontmatter: { title: '', date: '', lastVerified: '' } } } },
  });
  assert.match(body, /^lastVerified: "" #/m, 'filling this in would assert something no log can establish');
});

test('every last-verified spelling a destination might use is recognised', () => {
  // Matched by pattern, not an exact list. An exact list of four spellings let
  // `lastVerifiedAt: "2026-01-01"` through with its value intact, into a document
  // whose whole premise is that nothing in it has been checked.
  for (const key of ['lastVerified', 'last_verified', 'verifiedOn', 'checked', 'lastVerifiedAt', 'verified', 'dateChecked', 'validatedOn']) {
    const { body } = renderDraft(finding(), { config: { mine: { draft: { frontmatter: { [key]: '2026-01-01' } } } } });
    assert.match(body, new RegExp(`^${key}: "" #`, 'm'), `${key} should have been emitted empty`);
  }
});

test('a publish-state key can never say the draft is live', () => {
  const { body } = renderDraft(finding(), {
    config: { mine: { draft: { frontmatter: { draft: false, published: true, public: true } } } },
  });
  assert.match(body, /^draft: true /m);
  assert.match(body, /^published: false /m);
  assert.match(body, /^public: false /m);
});

test('a destination with no publish-state field still gets an explicit draft marker', () => {
  const { body } = renderDraft(finding(), { config: { mine: { draft: { frontmatter: { title: '', date: '' } } } } });
  assert.match(body, /^draft: true /m, 'a mined file in a content directory must not read as publishable');
});

test('an unknown destination field is emitted EMPTY, never with its configured value', () => {
  // The config frontmatter block is a SCHEMA — which fields this destination has —
  // not content. Copying its placeholder values in would put unexamined assertions
  // into the draft, and the README promises they arrive empty.
  const { body } = renderDraft(finding(), {
    config: { mine: { draft: { frontmatter: { series: 'cowork', seriesOrder: 5, authors: ['someone'] } } } },
  });
  assert.match(body, /^series: "" /m);
  assert.match(body, /^seriesOrder: "" /m);
  assert.match(body, /^authors: \[\] /m);
  assert.doesNotMatch(body, /cowork|someone/);
});

test('the draft filename is scrubbed, because it becomes the published URL', () => {
  const redactor = { redact: (s) => String(s).replaceAll('Acme', '[redacted:term]') };
  const { path, slug } = renderDraft(finding(), { redactor });
  assert.ok(!/acme/i.test(path), `a redacted term survived into the filename: ${path}`);
  assert.ok(!/redacted/i.test(slug), `the redaction marker itself leaked into the slug: ${slug}`);
});

test('a slug never keeps a token that only survived a stripped redaction marker', () => {
  assert.equal(slugFor({ primaryError: '<home>/<project> is missing' }), 'is-missing');
});

test('the publish date is left for the day it is published', () => {
  const { body } = renderDraft(finding(), { config: { mine: { draft: { frontmatter: { date: '' } } } } });
  assert.match(body, /^date: "" #/m);
  assert.doesNotMatch(body, /^date: "2026-06-25"/m, 'the mining date is not the publication date');
});

test('every verification item starts UNVERIFIED', () => {
  const plan = verificationPlan(finding());
  assert.ok(plan.length >= 4);
  for (const p of plan) assert.equal(p.status, 'UNVERIFIED');
  assert.ok(plan.some((p) => /the fix still resolves the failure/.test(p.claim)), 'the fix itself must always be on the list');
});

test('the draft carries the checklist and the unpublished banner', () => {
  const { body } = renderDraft(finding());
  assert.match(body, /unpublished draft generated from session logs/i);
  assert.match(body, /## Verification checklist/);
  assert.match(body, /## What I could not check/);
  assert.ok((body.match(/\*\*UNVERIFIED\*\*/g) ?? []).length >= 4);
});

test('the two genuinely unknowable things are always disclosed', () => {
  const caveats = cannotCheckFromLog(finding());
  assert.ok(caveats.some((c) => /anyone actually searches/i.test(c)));
  assert.ok(caveats.some((c) => /still works on the current build/i.test(c)));
});

test('weak resolution evidence is disclosed as weak', () => {
  const caveats = cannotCheckFromLog(finding({ resolution: [{ kind: 'fail-then-pass', strength: 'moderate' }] }));
  assert.ok(caveats.some((c) => /not anyone saying so/i.test(c)));
});

test('a truncated session is disclosed rather than presented as the whole story', () => {
  const caveats = cannotCheckFromLog(finding({ truncated: true }));
  assert.ok(caveats.some((c) => /longer than the read limit/i.test(c)));
});

test('the draft never asserts what the fix was', () => {
  const { body } = renderDraft(finding());
  const section = body.slice(body.indexOf('## The fix'), body.indexOf('## Related bug reports'));
  assert.match(section, /a log cannot say what the fix WAS/i, 'inventing a fix from a log would be the worst possible output');
});

test('the redactor runs over everything the draft emits', () => {
  const redactor = { redact: (s) => String(s).replaceAll('Acme', '[redacted]') };
  const { body } = renderDraft(finding(), { redactor });
  assert.ok(!body.includes('Acme'), 'a configured private term must not survive into a draft');
});

test('a path the redactor gutted is dropped rather than shown', () => {
  const { body } = renderDraft(finding({ evidence: { foreignPaths: ['<home>/[redacted:secret].exe', '<drive>/Program Files/Acme'] } }));
  assert.ok(!body.includes('[redacted:secret]'), 'an unreadable path is not evidence');
  assert.ok(body.includes('<drive>/Program Files/Acme'));
});

test('the slug is deterministic so re-drafting overwrites rather than litters', () => {
  assert.equal(slugFor(finding()), slugFor(finding()));
  assert.match(slugFor(finding()), /^[a-z0-9-]+$/);
});

test('the title describes the failure, not the session', () => {
  assert.match(titleFor(finding()), /VM service not running/);
  assert.match(titleFor(finding()), /Acme/);
});

test('the footer states the provenance and splits measured from proxied', () => {
  const { body } = renderDraft(finding());
  assert.match(body, /session-derived/);
  assert.match(body, /18 of it from measured signals/);
});
