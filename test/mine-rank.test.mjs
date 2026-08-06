// test/mine-rank.test.mjs — ranking, and the labels that keep the score honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_PRIMARY_QUOTABILITY, dedupeFindings, findingKey, primaryError, publishable, quotability, rankFindings, scoreFinding } from '../lib/mine/rank.mjs';

const base = (over = {}) => ({
  sessionKey: 'k1',
  corpus: 'claude-code',
  startedAt: '2026-06-01T00:00:00.000Z',
  errorStrings: ['VM service not running. The service failed to start.'],
  products: [{ name: 'Acme', sources: ['install-path'] }],
  versions: ['1.25927.0.0'],
  resolution: [{ kind: 'human-confirmed', detail: 'that worked', strength: 'strong' }],
  publishIntent: [],
  evidence: { diagnosisKinds: ['state'], probeKinds: ['service-state'], externalIssues: [], searchAttempts: 6, humanTurns: 20 },
  ...over,
});

test('quotability prefers program output over prose about it', () => {
  assert.ok(quotability('Error capturing screenshot: Frame with ID 0 is showing error page') >= 2);
  assert.ok(quotability("[Errno 10048] error while attempting to bind on address ('127.0.0.1', 8765)") >= 3);
  // What matters is the contract, not the exact number: too generic to lead a post.
  assert.ok(quotability('{"error":"not found"}') < MIN_PRIMARY_QUOTABILITY, 'too generic to lead a post with');
  assert.ok(
    quotability('The tool is completely non-functional. Every call fails with an error.') <
      quotability('Failed to start service. The service failed to start.'),
  );
});

test('every score component declares whether it is measured, a proxy, or unknown', () => {
  const s = scoreFinding(base());
  const bases = new Set(s.scoreComponents.map((c) => c.basis));
  assert.deepEqual([...bases].sort(), ['measured', 'proxy', 'unknown']);
  for (const c of s.scoreComponents) {
    assert.ok(['measured', 'proxy', 'unknown'].includes(c.basis), `bad basis on ${c.name}`);
    if (c.basis !== 'measured') assert.ok(c.proxyFor, `${c.name} must name what it stands in for`);
  }
});

test('the unknowable components score zero and are never quietly dropped', () => {
  const s = scoreFinding(base());
  const unknown = s.scoreComponents.filter((c) => c.basis === 'unknown');
  assert.deepEqual(unknown.map((c) => c.name).sort(), ['search-demand', 'still-true']);
  for (const c of unknown) assert.equal(c.points, 0);
});

test('measuredScore never exceeds the total', () => {
  const s = scoreFinding(base());
  assert.ok(s.measuredScore <= s.score);
  assert.ok(s.measuredScore > 0);
});

test('a finding the destination already covered is kept but never publishable', () => {
  const s = scoreFinding(base(), { publishedErrorStrings: ['VM service not running. The service failed to start.'] });
  assert.ok(s.alreadyCovered, 'should be flagged as covered');
  assert.deepEqual(publishable([s]), [], 'covered ground must not be offered again');
});

test('covered findings sort last rather than disappearing from the count', () => {
  const covered = scoreFinding(base({ errorStrings: ['Already written up. The service failed to start.'] }), {
    publishedErrorStrings: ['Already written up. The service failed to start.'],
  });
  const fresh = scoreFinding(base());
  const ranked = dedupeFindings([covered, fresh]);
  assert.equal(ranked.length, 2, 'dropping covered findings would understate what was found');
  assert.equal(ranked[0].alreadyCovered, null);
});

test('two sessions hitting the same problem are one finding', () => {
  const a = { ...base(), sessionKey: 'k1' };
  const b = { ...base(), sessionKey: 'k2', startedAt: '2026-06-09T00:00:00.000Z' };
  const ranked = rankFindings([a, b]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sessionCount, 2, 'a repeat is evidence of durability, not a second draft');
});

test('findingKey normalizes the numbers that vary between runs', () => {
  const one = findingKey({ primaryError: "bind on address ('127.0.0.1', 8765) failed" });
  const two = findingKey({ primaryError: "bind on address ('127.0.0.1', 9911) failed" });
  assert.equal(one, two, 'a changing port is the same problem');
});

test('a weak primary error blocks publishability however high the score', () => {
  const weak = scoreFinding(base({ errorStrings: ['{"error":"not found"}'], publishIntent: ['worth a post'] }));
  assert.ok(weak.score >= 20, 'this fixture is meant to clear the score bar');
  assert.deepEqual(publishable([weak]), []);
});

test('primaryError picks the most quotable line and drops weak alternates', () => {
  const noise = 'some log noise that mentions an error somewhere';
  const { primary, alternates } = primaryError([noise, "[Errno 10048] error while attempting to bind on address ('127.0.0.1', 8765)", 'a line that is missing something']);
  assert.match(primary, /Errno 10048/);
  assert.ok(!alternates.includes(noise), 'a line no one would search for is not evidence');
});

test('an errno code scores as a code however it is capitalised', () => {
  // A case-sensitive pattern here scored this at 1 and excluded it from publishing.
  for (const s of ['[Errno 10048] error while attempting to bind on address', '[errno 10048] error while attempting to bind on address', 'bind failed: WinError 10048 in the socket handler']) {
    assert.ok(quotability(s) >= 3, `expected >=3 for ${JSON.stringify(s)}, got ${quotability(s)}`);
  }
});
