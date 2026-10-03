// The stated priority rule (lib/problems/index.mjs) and the classifiers the checks rest on
// (lib/problems/classify.mjs), each case with a partner on the other side of its line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAgentText, classifyPrompt, checkClass, endsWithQuestion, errorClass, errorLine, riskyKinds, secretShapes, statusOfShell, testEditCounts } from '../lib/problems/classify.mjs';
import { loadCatalog, PATTERN_CHECKS, priorityOf, PRIORITY_RULE } from '../lib/problems/index.mjs';
import { CHECKS } from '../lib/problems/checks.mjs';
import { DRAFTS } from '../lib/problems/drafts.mjs';

const found = (group, { look = 0, notes = 0, derived = 0, tokens = null, strength = 'reported' } = {}) => ({ status: 'found', group, look, notesFound: notes, derivedFound: derived, tokens: tokens == null ? null : { tokens }, strength });

test('harm: one finding worked out from the facts is high; one or two by a rule are medium; three by a rule are high', () => {
  assert.equal(priorityOf(found('safety', { look: 1, derived: 1 }), 'Safety', 0).tier, 'high');
  assert.equal(priorityOf(found('correctness-honesty', { look: 2 }), 'Correctness and honesty', 0).tier, 'medium');
  assert.equal(priorityOf(found('correctness-honesty', { look: 3 }), 'Correctness and honesty', 0).tier, 'high');
  assert.match(priorityOf(found('safety', { look: 2, derived: 1 }), 'Safety', 0).reason, /1 of them worked out from the log's facts; a safety pattern/);
});

test('cost: by share of the window tokens, 5% high, 1% medium, under 1% low, no token measure low', () => {
  assert.equal(priorityOf(found('efficiency-cost', { look: 1, tokens: 60 }), 'Efficiency and cost', 1000).tier, 'high');
  assert.equal(priorityOf(found('efficiency-cost', { look: 1, tokens: 20 }), 'Efficiency and cost', 1000).tier, 'medium');
  assert.equal(priorityOf(found('efficiency-cost', { look: 1, tokens: 5 }), 'Efficiency and cost', 1000).tier, 'low');
  const none = priorityOf(found('efficiency-cost', { look: 4 }), 'Efficiency and cost', 1000);
  assert.equal(none.tier, 'low');
  assert.match(none.reason, /with no token measure/);
  assert.match(priorityOf(found('efficiency-cost', { look: 1, tokens: 1_200_000 }), 'Efficiency and cost', 10_000_000).reason, /^1\.2M tokens/);
});

test('friction: five worth a look is medium, four is low; routine notes alone never raise a tier', () => {
  assert.equal(priorityOf(found('process', { look: 5 }), 'Process', 0).tier, 'medium');
  assert.equal(priorityOf(found('collaboration', { look: 4 }), 'Collaboration', 0).tier, 'low');
  const notes = priorityOf(found('safety', { look: 0, notes: 9 }), 'Safety', 0);
  assert.equal(notes.tier, 'low');
  assert.match(notes.reason, /only routine notes/);
  assert.equal(priorityOf({ ...found('safety', { look: 3 }), status: 'clear' }, 'Safety', 0), null, 'a pattern not found gets no tier');
});

test('the rule is stated in the words the page shows, with three tiers and a line for what gets none', () => {
  assert.deepEqual(PRIORITY_RULE.tiers.map((t) => t.id), ['high', 'medium', 'low']);
  assert.match(PRIORITY_RULE.counts, /Only findings worth a look count/);
  assert.match(PRIORITY_RULE.rest, /get no priority/);
});

test('the catalog, the map and the drafts agree: every mapped pattern and check exists, every pattern has a draft', () => {
  const catalog = loadCatalog();
  const ids = new Set(catalog.patterns.map((p) => p.id));
  assert.equal(catalog.patterns.length, 40);
  const checkIds = new Set(CHECKS.map((c) => c.id));
  for (const [pattern, measures] of Object.entries(PATTERN_CHECKS)) {
    assert.ok(ids.has(pattern), pattern);
    for (const m of measures) assert.ok(checkIds.has(m.check), `${pattern}: ${m.check}`);
  }
  for (const c of CHECKS) assert.ok(Object.values(PATTERN_CHECKS).some((ms) => ms.some((m) => m.check === c.id)), `${c.id} measures a pattern`);
  for (const p of catalog.patterns) {
    assert.ok(DRAFTS[p.id], `${p.id} has a draft`);
    assert.ok(p.sources.length >= 1, `${p.id} has a source`);
    for (const s of p.sources) {
      assert.deepEqual(Object.keys(s).sort(), ['date', 'kind', 'says', 'title', 'url'], `${p.id}: a source keeps only its title, address, date, kind and paraphrase`);
      assert.match(s.url, /^https:\/\//);
    }
  }
  assert.ok(!JSON.stringify(catalog).includes('"publisher"'), 'no publisher (author) field');
});

test('classifiers: a completion claim and its negated partner', () => {
  assert.equal(classifyAgentText('Done. Fixed the parser.').flat, true);
  assert.equal(classifyAgentText('The parser is not fixed yet.').flat, false);
  assert.equal(classifyAgentText('This should work now.').hedged, true);
  assert.equal(classifyAgentText("I haven't run the tests.").admitsNoCheck, true);
  assert.equal(classifyAgentText('All 12 tests pass.').testsPass, true);
  assert.equal(classifyAgentText('That failure is pre-existing.').dismisses, true);
  assert.equal(endsWithQuestion('Plan ready.\nShall I go ahead?'), true);
  assert.equal(endsWithQuestion('Done.\nNothing else to do.'), false);
});

test('classifiers: a question-only prompt and a request worded as a question', () => {
  assert.equal(classifyPrompt('Why does the parser drop tabs?').pureQuestion, true);
  assert.equal(classifyPrompt('Can you fix the parser so it keeps tabs?').pureQuestion, false);
  assert.equal(classifyPrompt('Update the tests').mentionsTests, true);
});

test('classifiers: check steps, status calls and risky commands, each with a partner', () => {
  assert.equal(checkClass('npm run build'), 'build or check script');
  assert.equal(checkClass('node --test'), 'test');
  assert.equal(checkClass('git status'), null);
  assert.equal(statusOfShell('gh pr checks 12 | head -3')?.cls, 'CI or pull request status');
  assert.equal(statusOfShell('npm run build && gh pr checks 12'), null);
  assert.deepEqual(riskyKinds('git push --force-with-lease origin x', false).map((k) => k.kind), ['force-push']);
  assert.deepEqual(riskyKinds('git push origin x', false), []);
  assert.deepEqual(riskyKinds('rm -rf build', false).map((k) => [k.kind, k.look]), [['recursive-delete', false]]);
});

test('classifiers: test-weakening counts, error signatures and secret shapes', () => {
  assert.deepEqual(testEditCounts('assert.equal(a, 1);\nassert.equal(b, 2);', 'assert.equal(a, 1);'), { assertNet: 1, testsNet: 0, skipAdded: 0, exitAdded: 0, commentedAdded: 0 });
  assert.equal(testEditCounts("test('a', () => {});", "test.skip('a', () => {});").skipAdded, 1);
  assert.equal(errorClass('edit', 'String to replace not found in file.'), 'text to replace not found');
  assert.equal(errorClass('shell', 'bash: foo: command not found'), 'command not found');
  assert.equal(errorClass('shell', 'boom', 2), 'non-zero exit');
  assert.equal(errorLine('Error: cannot open /tmp/a1/b.txt at line 42'), errorLine('Error: cannot open /var/x/y.txt at line 7'), 'paths and numbers are taken out');
  assert.equal(secretShapes(`token: ${'ghp_'}${'A1b2C3d4E5f6G7h8I9j0K1l2'}`).keyShape, 1);
  assert.deepEqual(secretShapes({ password: 'q7Zx2LmP9vR4tY8wK3' }), { field: 1 });
  assert.deepEqual(secretShapes({ password: '${PASSWORD}' }), {});
  assert.deepEqual(secretShapes('const token = readToken(file);'), {});
});
