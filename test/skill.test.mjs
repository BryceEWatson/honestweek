import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = readFileSync(resolve(HERE, '..', 'SKILL.md'), 'utf8');

test('SKILL.md has valid front-matter naming the honestweek skill', () => {
  const fm = SKILL.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'front-matter block present');
  assert.match(fm[1], /^name:\s*honestweek\s*$/m);
  assert.match(fm[1], /^description:\s*.+/m);
  assert.match(fm[1], /honestweek/i, 'description triggers on /honestweek');
});

test('documents the five-stage flow in order with each artifact named', () => {
  const order = ['init', 'discover', 'DISTIL', 'build', 'review'];
  let last = -1;
  for (const stage of order) {
    const i = SKILL.indexOf(stage, last + 1);
    assert.ok(i > last, `stage ${stage} appears after the previous one`);
    last = i;
  }
  assert.match(SKILL, /honestweek\.config\.json/);
  assert.match(SKILL, /honestweek\.draft\.json/);
  assert.match(SKILL, /honestweek\.items\.json/);
  assert.match(SKILL, /output\.file/);
});

test('init scaffolds from the example only when absent and never overwrites', () => {
  assert.match(SKILL, /only when the config is absent[\s\S]*?never overwrites|never overwrites[\s\S]*?absent/i);
});

test('names the exact read/write artifacts per stage', () => {
  assert.match(SKILL, /discover[\s\S]*?honestweek\.draft\.json/i);
  assert.match(SKILL, /DISTIL[\s\S]*?honestweek\.draft\.json[\s\S]*?honestweek\.items\.json/i);
  assert.match(SKILL, /build[\s\S]*?honestweek\.items\.json[\s\S]*?output\.file/i);
});

test('states all six distillation-contract rules', () => {
  assert.match(SKILL, /never lift verbatim|do not paste/i);
  assert.match(SKILL, /subject-led/i);
  assert.match(SKILL, /statusForTag/);
  assert.match(SKILL, /receipt on every item|No item ships without/i);
  assert.match(SKILL, /under-?claim/i);
  assert.match(SKILL, /private\/display sessions get a generalized one-line|at most one[\s\S]*?generic/i);
});

test('requires status from STATUSES and a receipt on every item', () => {
  assert.match(SKILL, /\['shipped', 'in progress', 'designed, not proven'\]/);
  assert.match(SKILL, /receipt/);
  assert.match(SKILL, /sessionId/);
  assert.match(SKILL, /primaryCommit/);
});

test('private/display items carry no commit, repo, or file paths and are never git-verified', () => {
  assert.match(SKILL, /no commit SHA, no repo name, and no file paths|no commit[\s\S]*?no repo[\s\S]*?no file path/i);
  assert.match(SKILL, /never git-read or git-verified|never git-read/i);
});

test('states the three safety invariants including never-auto-publish', () => {
  assert.match(SKILL, /Private by default/i);
  assert.match(SKILL, /Verify or abort/i);
  assert.match(SKILL, /Human gate/i);
  assert.match(SKILL, /never auto-publish/i);
  assert.match(SKILL, /the USER is the publisher|user is the publisher/i);
});

test('the review step performs no publish action and sends nothing off the machine', () => {
  // Wording is deliberately "no publish action and sends nothing off the machine"
  // rather than a blanket "no network action": the optional preview binds a
  // loopback (127.0.0.1) socket, which is local and must not be caught by an
  // over-broad no-network claim.
  assert.match(SKILL, /review[\s\S]*?(no publish action and sends nothing off the machine|no network or publish action)/i);
});

test('mentions the exit-2 abort behavior', () => {
  assert.match(SKILL, /exit code `?2`?|aborts? .*\b2\b/i);
});

test('clean-room: SKILL.md contains no real personal data', () => {
  assert.doesNotMatch(SKILL, /@(?:gmail|outlook|yahoo|proton|icloud)\.com/i);
  assert.doesNotMatch(SKILL, /\/home\/[a-z]+\/|C:\\Users\\[A-Za-z]+\\/);
});
