// The work-history engine's event model, built over a synthetic corpus that carries
// every record shape the engine reads (see test/fixtures/replay/corpus.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { RULES } from '../lib/replay/classify.mjs';
import { assertEventContract, EVENT_KINDS } from '../lib/replay/evidence.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { buildCorpus, CODENAME, CODEX_SECRET_REASONING, ME, PRIVATE_TEXT, SECRET_REASONING } from './fixtures/replay/corpus.mjs';

let fx;
let h;
let k;
const build = (extra = {}) => buildWorkHistory({ config: fx.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, ...extra });
const of = (session, kind) => h.events.filter((e) => e.session === session && (!kind || e.kind === kind));

before(async () => {
  fx = buildCorpus();
  h = await build();
  k = Object.fromEntries(Object.entries(fx.ids).map(([n, id]) => [n, n === 'P' || n === 'K' ? sourceKey('cx', id) : claudeSessionKey(fx.dirs[n], id)]));
});
after(() => {
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    /* Windows can hold a lock on .git briefly */
  }
});

test('every event keeps the contract: a kind, an evidence level, a reference, a position, named rules', () => {
  assert.ok(h.events.length > 40);
  for (const e of h.events) assertEventContract(e, RULES);
  for (const e of h.events) assert.ok(EVENT_KINDS.includes(e.kind));
  const derivedWithoutRefs = h.events.filter((e) => e.refs.length === 0);
  assert.ok(derivedWithoutRefs.every((e) => e.evidence === 'derived' && e.basis.length === 2), 'only derived quiet intervals lack a record of their own');
});

test('a contract violation is a build error, not a silent claim', () => {
  const e = { ...h.events.find((x) => x.kind === 'prompt') };
  assert.throws(() => assertEventContract({ ...e, refs: [] }, RULES), /no evidence reference/);
  assert.throws(() => assertEventContract({ ...e, inferred: [{ key: 'intent', value: 'x', rule: 'made.up' }] }, RULES), /names no registered rule/);
  assert.throws(() => assertEventContract({ ...e, kind: 'feeling' }, RULES), /unknown kind/);
});

test('person prompts: typed, delivered mid-turn, and labelled only by named rules', () => {
  const prompts = of(k.A, 'prompt');
  assert.equal(prompts.length, 3, 'the first prompt, the absorbed mid-turn message, and "merge 7"');
  const mid = prompts.find((e) => e.facts.delivery === 'mid-turn');
  assert.match(mid.facts.text, /streaming reader/);
  assert.deepEqual(mid.inferred.map((x) => [x.value, x.rule]), [['correction', 'prompt.correction']]);
  const merge = prompts.find((e) => e.facts.text === 'merge 7');
  assert.deepEqual(merge.inferred.map((x) => x.value), ['approval']);
  // The task notice in the user slot is the harness, not a person.
  assert.equal(of(k.A, 'notification').length, 1);
  assert.equal(of(k.A, 'notification')[0].actor, 'harness');
});

test('queued messages: waiting time between typing and delivery is derived from two records', () => {
  const q = of(k.A, 'queue').filter((e) => e.facts.carries === 'message');
  assert.equal(q.length, 2);
  const first = q.find((e) => e.facts.state === 'delivered');
  assert.equal(first.derived.waitedMs, 2);
  const absorbed = q.find((e) => e.facts.state === 'removed');
  assert.ok(absorbed.end, 'the withdrawal closes the queued span');
  const never = of(k.B, 'queue').find((e) => e.facts.carries === 'message');
  assert.equal(never.facts.state, 'enqueued');
  assert.ok(!never.end, 'no delivery was recorded, so none is claimed');
});

test('actions pair a call with its recorded result; a call with none says so', () => {
  const acts = of(k.A, 'action');
  const test1 = acts.find((e) => e.facts.command === 'node --test');
  assert.equal(test1.facts.result, 'error');
  assert.deepEqual(test1.derived.tests, { tests: 3, pass: 2, fail: 1, parser: 'node-tap' });
  assert.equal(test1.derived.recordedSpanMs, 60000);
  const piped = acts.find((e) => /tail -5/.test(e.facts.command ?? ''));
  assert.equal(piped.facts.exitStatusBelongsToRunner, false, 'a pipeline exit status is not the runner\'s');
  const prBody = acts.find((e) => /gh pr create/.test(e.facts.command ?? ''));
  assert.equal(prBody.facts.testRunner, undefined, 'a runner named inside a PR body is not a test run');
  const edit = acts.find((e) => e.facts.category === 'edit');
  assert.deepEqual(edit.derived.patch, { added: 2, removed: 1, hunks: 1 });
  assert.equal(edit.facts.file, 'lib/*.mjs', 'paths keep directory shape, never a basename');
  const last = acts.find((e) => e.facts.command === 'npm run build');
  assert.equal(last.end, undefined);
  assert.deepEqual(last.missing, ['result']);
  assert.equal(h.session(k.A).endState, 'last-record-is-a-call-without-result');
});

test('refusals, rejections, answers and interruptions are their own recorded events', () => {
  const guard = of(k.A, 'guard')[0];
  assert.equal(guard.facts.rule, 'permission-rule');
  assert.equal(guard.actor, 'harness');
  const decisions = of(k.A, 'decision').map((e) => e.facts.decision).sort();
  assert.deepEqual(decisions, ['answered-question', 'rejected-plan']);
  const rejected = of(k.A, 'decision').find((e) => e.facts.decision === 'rejected-plan');
  assert.match(rejected.facts.feedback, /keep the old reader/);
  const interrupts = h.events.filter((e) => e.kind === 'interrupt');
  // Claude Code writes that the person interrupted; Codex writes only that the turn was
  // aborted and its own reason word, so that is all the engine says.
  assert.deepEqual(interrupts.map((e) => `${e.session === k.A ? 'A' : 'P'}:${e.facts.by}`).sort(), ['A:person', 'P:harness-reported']);
});

test('sub-agents: linked to the call that started them, finished by a recorded notice', () => {
  const thread = h.thread(h.session(k.A).thread);
  const main = thread.agentTree.find((a) => a.session === k.A);
  const reviewer = main.children.find((a) => a.type === 'general-purpose');
  assert.ok(reviewer, 'the reviewer hangs under the main agent');
  assert.equal(reviewer.description, 'Review the widget parser');
  assert.equal(reviewer.completion.via, 'notification');
  assert.equal(reviewer.completion.status, 'completed');
  const spawn = h.events.find((e) => e.id === reviewer.spawnedBy);
  assert.equal(spawn.facts.category, 'delegate');
  assert.deepEqual(spawn.inferred.map((x) => x.rule), ['review.delegation']);
  const orphan = thread.agentsWithoutRecordedParent;
  assert.equal(orphan.length, 1, 'a transcript whose starting call is in no log');
  assert.deepEqual(orphan[0].missing.sort(), ['agent-metadata', 'spawn-call']);
  const handBack = of(k.A, 'message').find((e) => e.agent === reviewer.key);
  assert.equal(handBack.facts.to, 'parent-agent');
});

test('Codex: a child thread joins its parent session, linked from both ends', () => {
  assert.equal(h.sessions.filter((s) => s.tool === 'codex').length, 1, 'the child is not a separate session');
  const child = h.agents.find((a) => a.kind === 'child-thread');
  assert.equal(child.session, k.P);
  const spawn = h.events.find((e) => e.id === child.spawnedBy);
  assert.equal(spawn.facts.tool, 'spawn_agent');
  assert.equal(h.links.find((l) => l.to === child.key).evidence, 'recorded');
  const wait = of(k.P, 'action').find((e) => e.facts.tool === 'wait_agent');
  assert.equal(wait.facts.timedOut, false);
  assert.equal(wait.derived.recordedSpanMs, 120000);
  const exec = of(k.P, 'action').find((e) => e.facts.tool === 'exec' && e.facts.testRunner);
  assert.equal(exec.facts.exitCode, 1);
  assert.deepEqual(exec.derived.tests, { tests: 3, pass: 2, fail: 1, parser: 'pytest' });
  const assistant = of(k.P, 'message').filter((e) => e.facts.to === 'person');
  assert.equal(assistant.length, 1, 'a turn written in both Codex shapes counts once');
  assert.equal(of(k.P, 'prompt').length, 2, 'injected environment context is not a prompt');
  assert.equal(of(k.P, 'turn-end')[0].facts.harnessDurationMs, 540000);
});

test('copied history in a resumed session is counted once, and the copy is linked', () => {
  const copies = h.events.filter((e) => e.copies?.length);
  assert.ok(copies.length >= 3);
  assert.ok(!of(k.B, 'prompt').some((e) => /widget parser and run/.test(e.facts.text)), 'the copied prompt belongs to the original');
  const link = h.links.find((l) => l.type === 'continuation');
  assert.equal(link.from, k.B);
  assert.equal(link.to, k.A);
  assert.equal(link.evidence, 'derived');
  assert.equal(link.inferred[0].rule, 'canonical.earliest-ending-copy');
  assert.equal(h.session(k.B).thread, h.session(k.A).thread, 'a continuation joins the thread');
});

test('sessions join a thread only through recorded or derived links; inferred hand-offs stay separate', () => {
  assert.equal(h.session(k.F).thread, h.session(k.A).thread, 'a delivered message is a recorded link');
  assert.notEqual(h.session(k.E).thread, h.session(k.A).thread, 'a task suggestion matching a first prompt is only an inference');
  const handoff = h.links.find((l) => l.type === 'handoff');
  assert.equal(handoff.evidence, 'inferred');
  assert.equal(handoff.to, k.E);
  assert.ok(h.thread(h.session(k.A).thread).related.handoffs.some((l) => l.to === k.E));
});

test('clock rules: out-of-band stamps do not move work; causality raises only the effect', () => {
  const link = of(k.A, 'link')[0];
  assert.equal(link.at, '2024-06-12T01:00:00.000Z', 'the pull-request link keeps its own late stamp');
  assert.equal(h.session(k.A).lastAt, '2024-06-11T15:30:00.000Z', '…and does not stretch the session span');
  const read = of(k.A, 'action').find((e) => e.facts.category === 'read' && e.agent.endsWith(':main'));
  assert.equal(read.end.adjusted, true);
  assert.ok(read.end.t >= read.t);
  assert.ok(h.anomalies.some((a) => a.kind === 'result-before-call' && a.ms === 59500));
});

test('git outcomes: what git recorded, never a claim that a session commit is the landed one', () => {
  const outcomes = h.events.filter((e) => e.kind === 'outcome');
  const bySha = (sha) => outcomes.find((e) => e.facts.outcome === 'commit-exists' && e.refs[0].sha === sha);
  const commit = bySha(fx.repo.featureSha);
  assert.equal(commit.facts.onDefaultBranch, false, 'the feature-branch commit never landed itself');
  assert.equal(commit.facts.authoredByConfiguredIdentity, true);
  assert.deepEqual(commit.inferred, [], 'the harness recorded this commit itself');
  const pr = outcomes.find((e) => e.facts.outcome === 'pr-landed');
  assert.equal(pr.facts.pr, 7);
  assert.equal(pr.at, '2024-06-11T16:00:00.000Z', "git's committer time, not the session's, spelled one way whatever git version printed it");
  assert.equal(pr.evidence, 'inferred', 'git records the commit; that it is pull request 7 is read from its subject');
  assert.equal(pr.inferred[0].rule, 'git.pr-number-from-subject');
  assert.equal(pr.refs[0].sha, fx.repo.squashSha);
  // Codex records no git operations: its commit is nominated from printed output, an
  // inference that stays visible on the outcome. A git log line after it nominates nothing.
  const codexCommit = bySha(fx.repo.squashSha);
  assert.equal(codexCommit.session, k.P);
  assert.equal(codexCommit.inferred[0].rule, 'shell.git-commit-output');
  assert.equal(outcomes.filter((e) => e.session === k.P).length, 1);
  assert.deepEqual(outcomes.map((e) => e.facts.outcome).sort(), ['commit-exists', 'commit-exists', 'commit-exists', 'pr-landed']);
});

test('a display-role repo is never read by git, even when it is a real repository holding the cited commit', () => {
  assert.ok(!h.sources.some((s) => s.tool === 'git' && s.repo === 'a-private-project'));
  assert.ok(!h.events.some((e) => e.kind === 'outcome' && (e.facts.repo === 'a-private-project' || e.refs[0].sha === fx.displaySha)));
  assert.ok(!h.gitNotes.some((n) => h.events.find((e) => e.id === n.event)?.session === k.C));
});

test("a resumed copy that holds a call's result completes the original call, links and all", () => {
  const call = of(k.G, 'action')[0];
  assert.ok(call.end, 'the result recorded only in the resumed copy completes the kept call');
  assert.ok(!call.missing.includes('result'));
  assert.equal(call.facts.git.commit.sha, fx.repo.resumeSha);
  const outcome = h.events.find((e) => e.kind === 'outcome' && e.refs[0].sha === fx.repo.resumeSha);
  assert.equal(outcome.facts.nominatedBy, call.id, 'the outcome hangs from the kept event, not the dropped copy');
  assert.equal(of(k.H, 'action').length, 0, 'the copied call is not counted twice');
  assert.equal(h.session(k.H).thread, h.session(k.G).thread);
});

test('a test command that never ran is not a test run', () => {
  const m = h.session(k.E).metrics;
  assert.equal(m.testRuns.value, 0);
  assert.equal(m.decisions.value, 1, "the rejection is the person's recorded decision");
  assert.equal(m.guards.value, 1, 'the refusal is a recorded guard');
  const end = h.threadTimeline(h.session(k.E).thread).stateAt(Date.parse('2030-01-01T00:00:00.000Z'));
  assert.equal(end.counts.testRuns, 0);
});

test('a late-stamped queue record does not stretch a session span', () => {
  assert.equal(h.session(k.F).lastAt, '2024-06-11T16:20:00.500Z');
  assert.equal(of(k.F, 'quiet').length, 1);
});

test('the timeline and the summaries count every shared metric the same way', () => {
  const pairs = [['prompts', 'prompts'], ['decisions', 'decisions'], ['interrupts', 'interrupts'], ['actions', 'actions'], ['delegations', 'delegations'], ['edits', 'edits'], ['testRuns', 'testRuns'], ['testRunsAllPassed', 'testRunsAllPassed'], ['testRunsWithFailures', 'testRunsWithFailures'], ['testRunsWithoutSummary', 'testRunsNoSummary'], ['guards', 'guards'], ['errors', 'errors'], ['commitsFoundInGit', 'commitsFoundInGit'], ['commitsByConfiguredIdentity', 'commitsByConfiguredIdentity'], ['prsLanded', 'prsLanded']];
  const readable = h.threads.filter((t) => !h.thread(t.id).private);
  assert.ok(readable.length >= 3);
  for (const th of readable) {
    const m = h.thread(th.id).metrics;
    const state = h.threadTimeline(th.id).stateAt(Date.parse('2030-01-01T00:00:00.000Z'));
    const end = state.counts;
    for (const [view, tl] of pairs) {
      assert.equal(end[tl], m[view].value, `${th.id} ${view}`);
      assert.equal(state.countEvidence[tl], m[view].evidence, `${th.id} ${view} is known the same way in both`);
    }
    assert.equal(state.filesEdited, m.filesEdited.value);
    assert.equal(end.promptsLabelled.correction, m.corrections.value);
    assert.equal(end.promptsLabelled.approval, m.approvals.value);
  }
});

test('a display-role session is a content-free skeleton; outside sessions are left out by default', async () => {
  const c = h.session(k.C);
  assert.equal(c.private, true);
  const allowed = new Set(['tool', 'category', 'result', 'by', 'during', 'delivery', 'state', 'carries', 'marker', 'decision', 'direction', 'from', 'index', 'origin', 'change', 'started', 'action', 'resolvedBy', 'about', 'spawnedAgent', 'completionNotice', 'stoppedBy', 'deliveredTo', 'sentBy', 'status', 'preventedContinuation', 'harnessDurationMs', 'exitCode']);
  for (const e of of(k.C)) {
    for (const key of Object.keys(e.facts)) assert.ok(allowed.has(key), `private event keeps "${key}"`);
    assert.deepEqual(e.inferred, []);
    assert.equal(e.derived.patch, undefined);
  }
  const json = JSON.stringify(of(k.C));
  for (const banned of [fx.displaySha, fx.displaySha.slice(0, 12), PRIVATE_TEXT, CODENAME]) assert.ok(!json.includes(banned), `private skeleton leaks ${banned}`);
  for (const e of of(k.C)) {
    const recs = JSON.stringify(h.record(e.id));
    for (const banned of [PRIVATE_TEXT, CODENAME, fx.displaySha.slice(0, 12)]) assert.ok(!recs.includes(banned), `drill-down into a private record leaks ${banned}`);
  }
  const rec = h.record(of(k.C, 'prompt')[0].id)[0];
  assert.equal(rec.verified, true);
  assert.equal(h.sessions.find((s) => s.key === k.D), undefined);
  assert.equal(h.skipped.outsideConfiguredRepos, 1);
  const all = await build({ scope: 'all' });
  const d = all.sessions.find((s) => s.key === k.D);
  assert.equal(d.private, true);
  assert.ok(!JSON.stringify(all).includes('unrelated work'));
});

test('nothing private is emitted: no reasoning, no email, no home path, no configured term', () => {
  const json = JSON.stringify(h);
  for (const banned of [SECRET_REASONING, CODEX_SECRET_REASONING, ME, CODENAME, 'Alex Example', PRIVATE_TEXT]) {
    assert.ok(!json.includes(banned), `history JSON leaks ${banned}`);
  }
  assert.ok(json.includes('[redacted:email]') && json.includes('[redacted:term]') && json.includes('[redacted:path]'));
  // The drill-down to the raw record removes reasoning and redacts the rest.
  const firstSay = of(k.A, 'message')[0];
  const rec = JSON.stringify(h.record(firstSay.id));
  assert.ok(!rec.includes(SECRET_REASONING));
  assert.ok(rec.includes('private model reasoning is not shown'));
  const codexRecords = JSON.stringify(of(k.P).flatMap((e) => h.record(e.id)));
  assert.ok(!codexRecords.includes(CODEX_SECRET_REASONING));
  // A record keyed by free text (answers are keyed by the question) is redacted by key too.
  const answered = of(k.A, 'decision').find((e) => e.facts.decision === 'answered-question');
  const answerRecords = JSON.stringify(h.record(answered.id));
  assert.ok(!answerRecords.includes(CODENAME), 'a configured term in an object key is redacted');
  assert.ok(answerRecords.includes('[redacted:term]'));
});

test('record drill-down re-reads the exact line and detects a changed file', async () => {
  const e = of(k.A, 'prompt')[0];
  const [r] = h.record(e.id);
  assert.equal(r.verified, true);
  assert.equal(r.record.type, 'user');
  assert.equal(r.ref.line, 3);
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const file = join(fx.claudeRoot, 'proj-a', `${fx.ids.A}.jsonl`);
  const original = readFileSync(file);
  try {
    writeFileSync(file, original.toString('utf8').replaceAll('Please add', 'Please ADD'));
    const [changed] = h.record(e.id);
    assert.equal(changed.verified, false);
    assert.equal(changed.record, null, 'a record that no longer matches is never shown');
  } finally {
    writeFileSync(file, original);
  }
});

test('coverage names every record type seen and how it was handled', () => {
  const cc = h.coverage['claude-code'];
  assert.equal(cc['assistant:thinking'].handling.startsWith('excluded'), true);
  assert.equal(cc['attachment:total_tokens_reminder'].handling, 'ignored: harness context');
  assert.equal(cc['(unparsable line)'].count, 1);
  const cx = h.coverage.codex;
  assert.ok(cx['response_item:reasoning'].handling.startsWith('excluded'));
  for (const table of Object.values(h.coverage)) for (const v of Object.values(table)) assert.ok(v.count > 0 && v.handling);
});

test('quiet intervals are derived from two recorded neighbours and never called idle', () => {
  const quiet = of(k.F, 'quiet');
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].derived.ms, 53 * 60000);
  assert.equal(quiet[0].evidence, 'derived');
  assert.equal(h.describe(quiet[0]), 'no records in this session for 53 min');
});

test('the overview tags each metric with its evidence level, and scopes content metrics', () => {
  const ov = h.overview();
  const day = ov.days.find((d) => d.date === '2024-06-11');
  assert.equal(day.metrics.prompts.evidence, 'recorded');
  assert.equal(day.metrics.corrections.evidence, 'inferred');
  assert.equal(day.metrics.filesEdited.evidence, 'derived');
  assert.equal(day.metrics.testRunsWithoutSummary.evidence, 'missing');
  assert.ok(day.metrics.testRuns.excludesPrivateEvents > 0, 'a test run in a private session is "not read", not "zero"');
  assert.equal(day.metrics.prsLanded.value, 1);
  assert.ok(day.metrics.eventsInPrivateSessions.value > 0);
});
