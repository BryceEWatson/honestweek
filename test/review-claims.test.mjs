// Claims against checks, and the rest of what the brief gathers (lib/review/claims.mjs,
// lib/review/brief.mjs). Pull request 23 in the shared fixture holds the shapes: a check run in
// the main checkout, a mid-turn claim, a claim in the pull request's body and one in a commit
// message, edits after the last check, a commit no session made, a correction and a skipped
// hook. A sub-agent's check is built by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { resolvePr } from '../lib/review/resolve.mjs';
import { scopeSteps } from '../lib/review/scope.mjs';
import { claimKinds, pairClaims, plainCheck, prBodyOf } from '../lib/review/claims.mjs';
import { buildBrief, CANT_KNOW, quoter } from '../lib/review/brief.mjs';
import { BRIEF_RULES } from '../lib/review/rules.mjs';
import { writeReviewLogs, WINDOW } from './fixtures/replay/review-pr.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const fx = writeReviewLogs(makeTempDir('hw-claims-'));
const h = await buildWorkHistory({ config: fx.config, ...WINDOW, roots: fx.roots, keepRaw: true, usage: true, hiddenSessions: 'redacted' });
const checked = runProblems(h, { builtT: Date.parse('2024-07-01T00:00:00Z') });
const redactor = createRedactor(fx.config);
const brief = (query, extra = {}) => {
  const pr = resolvePr({ h, config: fx.config, query, ...extra });
  const scope = scopeSteps({ h, pr, repoPath: fx.repo });
  return buildBrief({ h, config: fx.config, pr, scope, checked, redact: (s) => redactor.redact(s), repoPath: fx.repo, ...extra });
};
const b23 = brief('#23');
const textOf = (x) => x.text?.quoted ?? '';

test('a check run in the main checkout is a named gap, never backing', () => {
  const c = b23.claims.find((x) => textOf(x) === 'Tests pass.');
  assert.equal(c.source, 'message');
  assert.deepEqual([c.backing.status, c.backing.gap], ['gap', 'other-folder']);
  assert.match(c.backing.how, /folder that isn't on this change's branch/);
  assert.equal(b23.checks[0].folder, 'default-branch');
});

test('a mid-turn claim pairs with the check before it, in a folder on the branch', () => {
  const c = b23.claims.find((x) => textOf(x) === 'Tests pass now in the worktree.');
  assert.deepEqual([c.backing.status, c.backing.result, c.backing.failed], ['checked', 'passed', false]);
  assert.equal(c.backing.check, b23.checks[1].event);
  assert.equal(b23.checks[1].folder, 'on-branch');
});

test('the pull request body\'s claims are quoted and paired, the CI one with a CI read', () => {
  const body = b23.claims.filter((x) => x.source === 'pull-request body');
  assert.deepEqual(body.map((x) => x.kind).sort(), ['ci-green', 'tests-pass']);
  assert.equal(body.find((x) => x.kind === 'tests-pass').backing.gap, 'other-steps', 'an edit came after the last check');
  assert.equal(body.find((x) => x.kind === 'ci-green').backing.gap, 'no-ci-read');
  assert.equal(textOf(body[0]), 'Fixes #40. All tests pass and CI is green.');
});

test('a commit message\'s claim is weaker, and paired with the step that made the commit', () => {
  const c = b23.claims.find((x) => x.source === 'commit message');
  assert.equal(c.strength, 'weaker');
  assert.equal(c.sha, fx.git.f1);
  assert.equal(c.backing.status, 'checked');
});

test('unbacked claims come first', () => {
  const firstBacked = b23.claims.findIndex((x) => x.backing.status !== 'gap');
  assert.ok(firstBacked > 0);
  assert.ok(b23.claims.slice(firstBacked).every((x) => x.backing.status !== 'gap'));
});

test('a check is stale when an edit to the pull request\'s files came after it, or a commit nobody tested', () => {
  for (const c of b23.checks) assert.deepEqual([c.currency.state, c.currency.why, c.currency.evidence], ['stale', 'edit', 'derived']);
  // Pull request 20: the author's run had an edit after it; the review run's is current as logged.
  const b20 = brief('#20');
  assert.deepEqual(b20.checks.map((c) => [c.session, c.currency.state]), [[fx.key.author, 'stale'], [fx.key.review, 'current']]);
  assert.equal(b20.checks[1].currency.rule, 'brief.current-as-logged');
  // Pull request 21 at the head the reviewer gave: a commit no session made came after its run.
  const b21 = brief('#21', { head: fx.git.e2 });
  assert.deepEqual([b21.checks[0].currency.state, b21.checks[0].currency.why, b21.checks[0].currency.evidence], ['stale', 'commit', 'inferred']);
});

test('run these yourself lists only plain check commands', () => {
  assert.deepEqual(b23.rerun.map((r) => r.command.quoted), ['node --test']);
  assert.equal(plainCheck('cd .claude/worktrees/pr-23 && node --test'), 'node --test');
  assert.equal(plainCheck('npm test'), 'npm test');
  assert.equal(plainCheck('npx tsc --noEmit'), 'npx tsc --noEmit');
  for (const risky of ['npm test & del /q x', 'node --test & calc', 'node --test > out.log', 'node --test | tail', 'node --test; rm -rf x', 'npm test && git push', 'curl https://example.com', 'node script.mjs', 'node --test $(cat files)', 'rm -rf dist && npm run build', 'echo hi']) assert.equal(plainCheck(risky), null, risky);
});

test('a session that only looked the pull request up adds no check and no claim', () => {
  const b20 = brief('#20');
  assert.ok(!b20.checks.some((c) => c.session === fx.key.reader));
  assert.ok(!(b20.claims ?? []).some((c) => c.session === fx.key.reader));
  assert.ok(b20.sessions.some((s) => s.session === fx.key.reader && s.role === 'mentioned'), 'it is still listed');
});

test('what was asked: the closed issue, its printed text when a session printed it, and prompts in scope', () => {
  const b20 = brief('#20');
  assert.deepEqual(b20.asked.issues.map((x) => [x.number, x.textEvidence, x.textRule]), [[19, 'inferred', 'brief.issue-printed']]);
  assert.match(b20.asked.issues[0].text.quoted, /Stream it instead, and keep the parser tests passing\./);
  assert.ok(!/\t/.test(b20.asked.issues[0].text.quoted), 'tabs are taken out');
  assert.deepEqual(b20.asked.related.map((x) => x.number), [12]);
  assert.ok(b20.asked.prompts.some((p) => textOf(p) === 'Work on issue 19: the parser should stream its input.' && p.evidence === 'recorded'));
  // Pull request 23's issue was never printed: its text is missing, not guessed.
  assert.deepEqual(b23.asked.issues.map((x) => [x.number, x.text, x.textEvidence]), [[40, null, 'missing']]);
});

test('tests and hooks: test files, net assertions and skips, a skipped hook', () => {
  assert.deepEqual(b23.tests.files.map((f) => [f.path, f.status]), [['test/errors.test.mjs', 'A']]);
  assert.deepEqual([b23.tests.assertions, b23.tests.skips], [{ added: 1, removed: 0 }, { added: 1, removed: 0 }]);
  assert.equal(b23.tests.noVerify.length, 1);
  assert.deepEqual([b23.tests.noVerify[0].evidence, b23.tests.noVerify[0].rule], ['inferred', 'problems.risky-command']);
  assert.deepEqual([b23.tests.diffEvidence, b23.tests.diffRule], ['inferred', 'brief.test-diff']);
  assert.ok(b23.rules['brief.test-diff']);
  assert.deepEqual(b23.tests.forcePush, []);
});

test('where the person stepped in, and changes no session explains', () => {
  assert.deepEqual(b23.steppedIn.map((x) => [x.kind, x.evidence, x.rule]), [['correction', 'inferred', 'prompt.correction']]);
  assert.deepEqual(b23.unexplained.commits.map((c) => [c.sha, c.evidence]), [[fx.git.f2, 'missing']]);
  assert.match(b23.unexplained.note, /shell command/);
});

test('problems: a review pattern in scope is listed; another pull request\'s finding is left out, with its lane', () => {
  const b20 = brief('#20');
  assert.ok(b20.problems.listed.some((f) => f.pattern === 'unverified-done-claim' && f.session === fx.key.author));
  // Pull request 21's commit after its failed test run belongs to 21: under 20 it's left out.
  const after = (b) => b.problems.leftOut.list.concat(b.problems.listed).filter((f) => f.pattern === 'claim-contradicts-evidence' && f.event === h.events.find((e) => String(e._command).includes('Report parser errors')).id);
  const in20 = after(b20);
  assert.equal(in20.length, 1);
  assert.equal(in20[0].why, 'otherWork');
  assert.match(in20[0].lane, new RegExp(`parser-errors|#21|commit ${fx.git.e1.slice(0, 7)}`));
  assert.ok(b20.problems.leftOut.otherWork >= 1);
  const in21 = after(brief('#21'));
  assert.equal(in21[0].why, undefined, 'listed under 21');
  assert.equal(in21[0].related.inScope, true, 'its failed run is 21\'s too');
});

test('--evidence-only leaves the author\'s words out', () => {
  const b = brief('#23', { evidenceOnly: true });
  assert.equal(b.claims, null);
  assert.equal(b.evidenceOnly, true);
  assert.ok(b.checks.length, 'the evidence stays');
});

test('what it can\'t know is always there, and every rule it names is described', () => {
  for (const b of [b23, brief('#20'), brief('#20', { repo: 'a-private-project' })]) {
    for (const k of CANT_KNOW) assert.ok(b.cantKnow.some((x) => x.kind === k.kind), k.kind);
    for (const [id, text] of Object.entries(b.rules)) assert.ok(BRIEF_RULES.has(id) && text, id);
  }
});

test('quoted text is redacted and has no control characters', () => {
  const q = quoter((s) => s.replace(/secret/g, '[redacted]'));
  assert.deepEqual(q('a secret\u0007 here‮\r\nnext\ttab'), { quoted: 'a [redacted] here\nnext tab' });
  assert.equal(q(null), null);
  assert.equal(q('x'.repeat(50), 10).quoted, `${'x'.repeat(10)}…`);
});

test('claimKinds and prBodyOf', () => {
  const ci = (t) => claimKinds(t).kinds.some((k) => k.kind === 'ci-green');
  assert.equal(ci('CI is green.'), true);
  assert.equal(ci('All checks passed on the head.'), true);
  assert.equal(ci('Waiting until CI is green.'), false);
  assert.equal(ci("CI isn't green yet."), false);
  assert.equal(ci('Once the checks pass, I will merge.'), false);
  assert.equal(ci('CI is green, no failures.'), true);
  assert.equal(ci("CI isn't green yet. Now CI is green."), true, 'a later sentence counts');
  for (const local of ['The build passes locally.', 'Lint checks pass.', 'Type checks pass locally.', 'Two checks are passing, one failed.']) assert.equal(ci(local), false, local);
  assert.deepEqual(claimKinds('Done. All tests pass.').kinds.map((k) => k.kind), ['done', 'tests-pass']);
  assert.equal(prBodyOf('gh pr create --title x --body "Fixes #1. Tests pass."'), 'Fixes #1. Tests pass.');
  assert.equal(prBodyOf("gh pr create --body-file - <<'EOF'\nAll tests pass.\nEOF"), 'All tests pass.');
  assert.equal(prBodyOf('gh pr create --title x'), null);
});

/** By hand: steps in one session 's', in order; `ambiguous` holds the indexes on the boundary. */
function handPair(spec, { ambiguous = [], files = ['lib/a.mjs'] } = {}) {
  const events = [];
  const steps = new Map();
  let seq = 0;
  for (const x of spec) {
    const agent = x.agent ?? 's:main';
    const e = { id: `s.${++seq}.0`, session: 's', agent, kind: x.kind, t: seq, at: null, facts: x.facts ?? {}, inferred: [] };
    if (x.text || x.input) Object.defineProperty(e, '_raw', { value: { text: x.text, input: x.input } });
    if (x.cmd) Object.defineProperty(e, '_command', { value: x.cmd });
    events.push(e);
    if (x.step) {
      const s = { ev: e.id, seq, t: seq, session: 's', agent, ...x.step };
      if (x.paths) Object.defineProperty(s.edit, 'paths', { value: x.paths, enumerable: false });
      steps.set(e.id, s);
    }
  }
  const ctx = { steps, byId: new Map(events.map((e) => [e.id, e])), seqOf: new Map(events.map((e, i) => [e.id, i + 1])), sessionsByKey: new Map([['s', { key: 's', tool: 'claude-code' }]]) };
  const amb = new Set(ambiguous.map((i) => events[i].id));
  const scope = { inScope: new Set(events.filter((e) => !amb.has(e.id)).map((e) => e.id)), ambiguous: amb, branchOf: () => null, sessions: [{ key: 's', role: 'author' }] };
  const pr = { branch: { name: 'feature/x' }, files: { list: files.map((path) => ({ path })) }, commits: { list: [] }, events: { creates: [] } };
  return pairClaims({ h: { events }, ctx, pr, scope });
}
const EDIT = (path = '/r/lib/a.mjs') => ({ kind: 'action', step: { cat: 'edit', result: 'ok', edit: { kind: 'code', key: 'k' } }, input: { file_path: path } });
const TEST_RUN = { kind: 'action', cmd: 'npm test', step: { cat: 'shell', result: 'ok', check: 'test', test: 'passed' } };

test('a sub-agent\'s check backs its parent session\'s later claim, and a sub-agent\'s own claim is marked as one', () => {
  const out = handPair([EDIT(), { ...TEST_RUN, agent: 's:sub' }, { kind: 'message', text: 'Tests pass.' }, { kind: 'message', agent: 's:sub', text: 'All tests pass.' }]);
  assert.deepEqual(out.claims.map((c) => [c.source, c.backing.status, c.backing.result]), [['message', 'checked', 'passed'], ['sub-agent message', 'checked', 'passed']]);
});

test('an ambiguous edit between a check and a claim leaves the claim unbacked and the check stale', () => {
  const out = handPair([EDIT(), TEST_RUN, EDIT(), { kind: 'message', text: 'Tests pass.' }], { ambiguous: [2] });
  assert.deepEqual([out.claims[0].backing.status, out.claims[0].backing.gap], ['gap', 'ambiguous-edit']);
  assert.deepEqual([out.checks[0].currency.state, out.checks[0].currency.why], ['stale', 'edit']);
});

test('a Codex patch to the pull request\'s files makes an earlier check stale', () => {
  const out = handPair([TEST_RUN, { kind: 'action', step: { cat: 'edit', result: 'ok', edit: { kind: 'code', key: 'k' } }, input: { input: '*** Begin Patch' }, paths: ['/r/README.md', '/r/lib/a.mjs'] }]);
  assert.deepEqual([out.checks[0].currency.state, out.checks[0].currency.why], ['stale', 'edit']);
});

test('a CI claim after a failed CI read is failed, and after a later push it is a gap', () => {
  const read = (result) => ({ kind: 'action', cmd: 'gh pr checks 5', facts: { result }, step: { cat: 'shell', result } });
  const failed = handPair([read('error'), { kind: 'message', text: 'CI is green.' }]).claims.find((c) => c.kind === 'ci-green');
  assert.deepEqual([failed.backing.status, failed.backing.failed], ['ci-read', true]);
  const stale = handPair([read('ok'), EDIT(), { kind: 'action', cmd: 'git push', step: { cat: 'shell', result: 'ok' } }, { kind: 'message', text: 'CI is green.' }]).claims.find((c) => c.kind === 'ci-green');
  assert.deepEqual([stale.backing.status, stale.backing.gap], ['gap', 'ci-read-stale']);
  const fresh = handPair([read('ok'), { kind: 'message', text: 'CI is green.' }]).claims.find((c) => c.kind === 'ci-green');
  assert.deepEqual([fresh.backing.status, fresh.backing.failed ?? null], ['ci-read', null]);
});

test('branch names, file paths and lanes pass the redactor', () => {
  const b = brief('#21', { redact: (s) => redactor.redact(s).replace(/parser-errors|errors\.test/g, '[hidden]') });
  const out = JSON.stringify({ change: b.change.branch, files: b.change.files, sessions: b.sessions.map((s) => s.lanes), tests: b.tests.files, unexplained: b.unexplained.files, notes: [b.cantKnow, b.notes] });
  assert.ok(!/parser-errors|errors\.test/.test(out), out);
  assert.match(out, /\[hidden\]/);
});

test('the landing commit keeps its own evidence word and rule in the brief', () => {
  const b20 = brief('#20');
  assert.deepEqual([b20.change.landed.evidence, b20.change.landed.rule], ['inferred', 'brief.landed-subject']);
  assert.equal(b20.change.files.rule, 'brief.landed-subject');
  assert.ok(b20.rules['brief.landed-subject']);
});
