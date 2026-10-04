// The stated priority rule (lib/problems/index.mjs) and the classifiers the checks rest on
// (lib/problems/classify.mjs), each case with a partner on the other side of its line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAgentText, classifyPrompt, checkClass, endsWithQuestion, errorClass, errorLine, riskyKinds, secretShapes, statusOfShell, testEditCounts } from '../lib/problems/classify.mjs';
import { loadCatalog, PATTERN_CHECKS, priorityOf, PRIORITY, PRIORITY_RULE } from '../lib/problems/index.mjs';
import { CHECKS, fmt } from '../lib/problems/checks.mjs';
import { THRESHOLDS } from '../lib/problems/context.mjs';
import { DRAFTS } from '../lib/problems/drafts.mjs';

const found = (group, { look = 0, notes = 0, derived = 0, tokens = null, lookTokens = tokens, waste = true, strength = 'reported' } = {}) => ({ status: 'found', group, look, notesFound: notes, derivedFound: derived, tokens: tokens == null ? null : { tokens, lookTokens, waste }, strength });

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
  assert.match(none.reason, /with no token estimate/);
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
  // --force-with-lease refuses to overwrite work it hasn't seen: a routine note, not worth a look.
  assert.deepEqual(riskyKinds('git push --force-with-lease origin x', false).map((k) => [k.kind, k.look]), [['force-with-lease', false]]);
  assert.deepEqual(riskyKinds('git push --force origin main', false).map((k) => [k.kind, k.look]), [['force-push', true]]);
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

test('cost: only the findings worth a look set the tier, and tokens spent rather than wasted never do', () => {
  // 20% of the window in all, but only 3% in findings worth a look: medium, not high.
  const p = priorityOf(found('efficiency-cost', { look: 1, notes: 30, tokens: 200, lookTokens: 30 }), 'Efficiency and cost', 1000);
  assert.equal(p.tier, 'medium');
  assert.match(p.reason, /estimated for the findings worth a look, 3\.0% of the window's/);
  assert.equal(priorityOf(found('efficiency-cost', { look: 0, notes: 30, tokens: 900, lookTokens: 0 }), 'Efficiency and cost', 1000).tier, 'low');
  // Spending (small sub-agents): the count sets the tier, as for a friction pattern.
  const spent = priorityOf(found('efficiency-cost', { look: 2, tokens: 900, waste: false }), 'Efficiency and cost', 1000);
  assert.equal(spent.tier, 'low');
  assert.match(spent.reason, /tokens spent, not an estimate of waste/);
  assert.equal(priorityOf(found('efficiency-cost', { look: 5, tokens: 900, waste: false }), 'Efficiency and cost', 1000).tier, 'medium');
});

test("an estimate past the window's total says the estimates overlap, never a share over 100%", () => {
  const over = priorityOf(found('efficiency-cost', { look: 40, tokens: 1480 }), 'Efficiency and cost', 1000);
  assert.equal(over.tier, 'high');
  assert.match(over.reason, /more than all the window's tokens, since estimates for neighbouring steps overlap/);
  assert.doesNotMatch(over.reason, /\d{3}%/);
});

test('a share just under a line prints rounded down, never as the line itself', () => {
  const under = priorityOf(found('efficiency-cost', { look: 1, tokens: 496 }), 'Efficiency and cost', 10_000);
  assert.equal(under.tier, 'medium');
  assert.match(under.reason, /4\.9% of the window's/);
  assert.equal(priorityOf(found('efficiency-cost', { look: 1, tokens: 500 }), 'Efficiency and cost', 10_000).tier, 'high');
  const low = priorityOf(found('efficiency-cost', { look: 1, tokens: 996 }), 'Efficiency and cost', 100_000);
  assert.equal(low.tier, 'low');
  assert.match(low.reason, /0\.9% of the window's/);
});

test('the stated rule and the checks state the numbers the code applies', () => {
  const tiers = PRIORITY_RULE.tiers.map((t) => t.text).join(' ');
  assert.ok(tiers.includes(`${PRIORITY.harmHighCount} or more worth a look`));
  assert.ok(tiers.includes(`${PRIORITY.highShare * 100}% or more`));
  assert.ok(tiers.includes(`${PRIORITY.mediumShare * 100}% to ${PRIORITY.highShare * 100}%`));
  assert.ok(tiers.includes(`${PRIORITY.frictionMediumCount} or more worth a look`));
  assert.match(PRIORITY_RULE.classes.find((c) => c.id === 'cost').text, /estimate/);
  assert.doesNotMatch(JSON.stringify(PRIORITY_RULE), /measured/, 'token figures are estimates, never called measured');
  const how = (id) => { const c = CHECKS.find((x) => x.id === id); return `${c.title} ${c.how}`; };
  const relation = (id) => PATTERN_CHECKS[id].map((m) => m.relation).join(' ');
  const minutes = (ms) => `${ms / 60_000} minutes`;
  assert.ok(how('long-sessions').includes(fmt(THRESHOLDS.longCtx)));
  assert.ok(relation('context-bloat').includes(fmt(THRESHOLDS.longCtx)) && relation('context-bloat').includes(`${THRESHOLDS.longAfterCalls} or more calls`));
  assert.ok(relation('repeated-file-reads').includes(`${THRESHOLDS.rereadMin} or more times`));
  assert.ok(relation('action-loop').includes(`${THRESHOLDS.loopMin} or more identical calls`));
  assert.ok(relation('busy-polling').includes(`${THRESHOLDS.pollMin} or more times, each within ${minutes(THRESHOLDS.pollGapMs)}`));
  assert.ok(relation('repeated-tool-error').includes(`${THRESHOLDS.errorRunMin} or more times`));
  assert.ok(relation('oversized-tool-output').includes(`${fmt(THRESHOLDS.bigAdd)} tokens or more`));
  assert.ok(relation('subagent-overuse').includes(`${THRESHOLDS.smallSubagentCalls} or fewer tool calls`));
});

test('risky commands: only a git command that runs with the flag counts, never a mention in quoted text', () => {
  const kinds = (c) => riskyKinds(c, false).map((k) => k.kind + (k.look ? '*' : ''));
  for (const quiet of ['grep -rn -- "--no-verify" docs/', 'git log --grep="--no-verify"', 'git commit -m "docs: never use --no-verify"', 'gh pr create --body "Never skip hooks (--no-verify)."', 'git -c core.hooksPath=.githooks commit -m x', 'git clean -fdn', 'git clean -f --dry-run', 'git commit -m "push --force fix"', 'echo "rm -rf /"']) {
    assert.deepEqual(kinds(quiet), [], quiet);
  }
  assert.deepEqual(kinds('git commit --no-verify -m x'), ['skip-checks*']);
  assert.deepEqual(kinds('git -C /path/to/your/repo push --no-verify'), ['skip-checks*']);
  assert.deepEqual(kinds('git -c core.hooksPath=/dev/null commit -m x'), ['skip-checks*']);
  assert.deepEqual(kinds('git push -f'), ['force-push*']);
  assert.deepEqual(kinds('git push --force-with-lease && git push -f'), ['force-push*'], 'one plain force-push among them is worth a look');
  assert.deepEqual(kinds('git clean -fd'), ['git-clean*']);
  assert.deepEqual(kinds('rm -fr dist && npm i'), ['recursive-delete']);
  assert.deepEqual(kinds('git branch -D old'), ['branch-delete']);
});

test('risky commands: a wrapper, a prefix or a short-flag group still runs the command', () => {
  const kinds = (c) => riskyKinds(c, false).map((k) => k.kind + (k.look ? '*' : ''));
  for (const c of ['bash -lc git push -f origin main', 'bash -c "git push -f" 2>&1', 'nohup bash -c "git push -f" > log 2>&1 &', 'bash -c -- "git push -f"', 'bash -c "git push -f"', "sh -c 'cd /path/to/your/repo && git push --force'", 'pwsh -NoProfile -Command "git push -f"', 'eval "git push -f"', 'sudo git push -f', 'git --no-pager push -f', 'git.exe push --force', '/usr/bin/git push --force', 'echo hi | xargs git push -f', 'echo `git push -f`', 'git push -fu origin main', 'git push origin +main']) {
    assert.deepEqual(kinds(c), ['force-push*'], c);
  }
  for (const c of ["sh -c 'git commit --no-verify -m x'", 'bash -lc git commit --no-verify -m x', 'git commit -n -m x', 'git commit -nm x', 'git -c core.hooksPath="" commit -m x', 'git config core.hooksPath /dev/null']) {
    assert.deepEqual(kinds(c), ['skip-checks*'], c);
  }
  for (const c of ['bash -lc git clean -fdx', 'pwsh -Command "git clean -fdx"', 'git clean -fd -e -n', 'git clean -f -- -n']) assert.deepEqual(kinds(c), ['git-clean*'], c);
  for (const quiet of ['git push --force-if-includes', 'git commit -m -n', 'git commit -F -n', 'bash -c "echo git push -f" 2>&1', 'git push -n -f', 'git push --dry-run --force', 'git commit -m n', 'git commit -mn', 'git merge -n main', 'git branch -d old', `rg "bash -c 'git push -f'" docs`, "bash -lc git commit -m 'x --no-verify'", 'cat <<EOF\ngit push -f\nEOF']) {
    assert.deepEqual(kinds(quiet), [], quiet);
  }
});

test("risky commands: a long unclosed quote full of escaped quotes reads in one pass", () => {
  const s = `bash -c "${'a\\"'.repeat(70_000)}`;
  const t = Date.now();
  assert.deepEqual(riskyKinds(s, false), []);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test("completion claims: a hand-off to you or work still to do isn't a flat claim", () => {
  const hand = classifyAgentText("I've added debug logging around the retry path. Can you run it again and paste the output?");
  assert.equal(hand.admitsNoCheck, true, 'asking you to run it is the honest hand-off');
  for (const s of ["I've added the new option, but I haven't wired the UI yet. Want me to continue?", "Let me know when you are ready and I'll run the suite.", "Run the tests once you're all set on the config."]) {
    assert.equal(classifyAgentText(s).flat, false, s);
  }
  for (const s of ['The fix is in place.', 'Done. All tests pass.', "I've implemented the parser.", 'Everything is ready.']) assert.equal(classifyAgentText(s).flat, true, s);
});

test('completion claims: work left in another sentence, a readiness clause or an unrelated question keeps the claim', () => {
  const pushed = classifyAgentText("I've implemented the change and all tests pass. I haven't pushed yet.");
  assert.equal(pushed.flat, true);
  assert.equal(pushed.testsPass, true, 'the tests claim stands in its own sentence');
  for (const s of ["The bug is fixed. I haven't changed the docs.", "I've implemented the feature. You still need to restart the server.", "It's fixed. Let me know when you've deployed it, it works now.", "Done.\nWhen you're back: the fix is complete."]) {
    assert.equal(classifyAgentText(s).flat, true, s);
  }
  for (const s of ['The bug is fixed and works now. Could you confirm which branch you want the PR against?', "Done. Everything is working. Can you check whether you'd like a changelog entry?", 'Fixed. Please verify the copy reads well to you.']) {
    const r = classifyAgentText(s);
    assert.equal(r.flat, true, s);
    assert.equal(r.admitsNoCheck, false, `a question about something else isn't a hand-off: ${s}`);
  }
  // A dot in a file name or version isn't a sentence end, so work left later in the sentence still counts.
  for (const s of ["The bug is fixed in lib/foo.mjs but I haven't wired the UI yet.", 'All tests pass on the parser.mjs module, but I still need to update the CLI.', "Fixed in v1.2, but I haven't released it yet.", "I've added the hook, e.g. for retries, but haven't wired the UI yet.", "I've implemented the parser\nbut haven't wired the UI yet."]) {
    const r = classifyAgentText(s);
    assert.equal(r.flat || r.testsPass, false, s);
  }
  for (const s of ["I've fixed the parser. Can you run npm test to confirm?", 'The fix is in place. Please re-run CI.', 'The fix is in place. Can you try now?', "I've fixed it. Can you test on your machine?"]) assert.equal(classifyAgentText(s).admitsNoCheck, true, s);
  for (const s of ['Could you run the tests on your machine?', 'Can you try it again?', 'Please verify the fix on staging.', 'Could you confirm it works?']) assert.equal(classifyAgentText(s).admitsNoCheck, true, s);
});

test("secret-shaped fields use the redactor's own list of sensitive names", () => {
  for (const s of ['MYSQL_PWD=Xk9fQ2mL7pR4sT8vB3', 'LICENSE_KEY=Xk9fQ2mL7pR4sT8vB3', 'GPG_KEY: Xk9fQ2mL7pR4sT8vB3']) assert.equal(secretShapes(s).field, 1, s);
  assert.deepEqual(secretShapes('name=Xk9fQ2mL7pR4sT8vB3'), {});
});

test('risky commands: wrappers with their own options, lower-case config keys and rm read word by word', () => {
  const kinds = (c) => riskyKinds(c, false).map((k) => k.kind);
  assert.deepEqual(kinds('sudo -u me git push -f'), ['force-push']);
  assert.deepEqual(kinds('env X=1 git push -f'), ['force-push']);
  assert.deepEqual(kinds('GIT_TRACE=1 git push --force origin main'), ['force-push']);
  assert.deepEqual(kinds('xargs -n 1 git push -f'), ['force-push']);
  assert.deepEqual(kinds('git -c core.hookspath=/dev/null commit -m x'), ['skip-checks']);
  assert.deepEqual(kinds('git config core.HOOKSPATH /dev/null'), ['skip-checks']);
  assert.deepEqual(kinds('rm dist -rf'), ['recursive-delete']);
  assert.deepEqual(kinds('rm --recursive --force build'), ['recursive-delete']);
  assert.deepEqual(kinds('/bin/rm -R -f build'), ['recursive-delete']);
  // Partners that must stay quiet.
  assert.deepEqual(kinds('rm -r build'), []);
  assert.deepEqual(kinds('rm -f a.txt'), []);
  assert.deepEqual(kinds('rm -- -rf'), [], 'after a bare -- it is a file name');
  assert.deepEqual(kinds('sudo -u me git push'), []);
  assert.deepEqual(kinds('env X=1 git commit -m x'), []);
});

test('risky commands: a leading env, time or exec keeps its options set aside, and lookups run nothing', () => {
  const kinds = (c) => riskyKinds(c, false).map((k) => k.kind);
  // The shared splitter drops a leading env, time or exec but not its options; these read as run.
  for (const c of ['env -i git push -f', 'env - git push -f', 'env -u HOME git push -f', 'env -C /tmp git push -f', 'env --unset HOME git push -f', 'ls && env -i rm -rf build', 'time -p git push -f', 'exec -a name git push -f', 'env -i bash -c "git push -f"']) {
    assert.deepEqual(kinds(c), c.includes('rm') ? ['recursive-delete'] : ['force-push'], c);
  }
  // Long options whose value is the next word, and a Windows rm.
  assert.deepEqual(kinds('sudo --user root git push -f'), ['force-push']);
  assert.deepEqual(kinds('xargs --max-args 1 rm -rf'), ['recursive-delete']);
  assert.deepEqual(kinds('rm.exe -rf build'), ['recursive-delete']);
  assert.deepEqual(kinds('C:/tools/rm.exe -rf build'), ['recursive-delete']);
  assert.deepEqual(kinds('git -c core.hooksPath=nul commit -m x'), ['skip-checks']);
  // command -v and sudo -l only look a command up.
  assert.deepEqual(kinds('command -v git push -f'), []);
  assert.deepEqual(kinds('sudo -l rm -rf /'), []);
  assert.deepEqual(kinds('command -V git'), []);
  assert.deepEqual(kinds('env -i git push'), []);
  assert.deepEqual(kinds('env -u X git commit -m x'), []);
  assert.deepEqual(kinds('git config core.hooksPath .githooks'), []);
});

test('risky commands: a long run of rm flags reads in one pass', () => {
  const t = Date.now();
  assert.deepEqual(riskyKinds(`rm ${'-r '.repeat(50_000)}x`, false), []);
  assert.deepEqual(riskyKinds(`sudo ${'-u me '.repeat(20_000)}git push`, false), []);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});
