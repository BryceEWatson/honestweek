// The demo week (tools/demo-week.mjs): a synthetic week of Claude Code and Codex
// sessions on a made-up project. These tests build it and check the work-history
// engine reads it the way docs/demo-week.md promises.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { RULES } from '../lib/replay/classify.mjs';
import { assertEventContract } from '../lib/replay/evidence.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { buildDemoWeek, CODEX_IDS, main as demoMain, ME, SESSION_IDS, WEEK } from '../tools/demo-week.mjs';
import { main as inspect } from '../tools/replay-inspect.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { DEMO_TERM } from '../lib/view.mjs';

let d;
let h;
let all;
const k = {};
const scratch = [];

const tmp = (prefix) => {
  const dir = makeTempDir(prefix);
  scratch.push(dir);
  return dir;
};
const of = (history, session, kind) => history.events.filter((e) => e.session === session && (!kind || e.kind === kind));
const actions = (history, session) => of(history, session, 'action');
const sessionOf = (key) => h.sessions.find((s) => s.key === key);

before(async () => {
  d = buildDemoWeek({ root: join(tmp('hw-demo-test-'), 'week') });
  const dirs = d.ids.projectDirs;
  Object.assign(k, {
    since: claudeSessionKey(dirs.lantern, SESSION_IDS.sinceFlag),
    group: claudeSessionKey(dirs.groupWorktree, SESSION_IDS.groupByScope),
    resumed: claudeSessionKey(dirs.groupWorktree, SESSION_IDS.groupByScopeResumed),
    json: claudeSessionKey(dirs.jsonWorktree, SESSION_IDS.jsonOutput),
    site: claudeSessionKey(dirs.site, SESSION_IDS.sitePost),
    lookup: claudeSessionKey(dirs.lantern, SESSION_IDS.goalLookup),
    scratch: claudeSessionKey(dirs.scratch, SESSION_IDS.scratch),
    review: claudeSessionKey(dirs.lantern, SESSION_IDS.reviewRun),
    breaking: claudeSessionKey(dirs.lantern, SESSION_IDS.breakingQuestion),
    bare: claudeSessionKey(dirs.lantern, SESSION_IDS.bracketless),
    markdown: claudeSessionKey(dirs.markdownWorktree, SESSION_IDS.markdownOutput),
    windows: claudeSessionKey(dirs.lantern, SESSION_IDS.windowsCi),
    release: claudeSessionKey(dirs.releaseWorktree, SESSION_IDS.releaseScript),
    unreleased: claudeSessionKey(dirs.lantern, SESSION_IDS.unreleased),
    width: claudeSessionKey(dirs.lantern, SESSION_IDS.widthCheck),
    widthCommit: claudeSessionKey(dirs.lantern, SESSION_IDS.widthCommit),
    wide: sourceKey('cx', CODEX_IDS.wideChars),
    contributing: sourceKey('cx', CODEX_IDS.contributing),
    node18: sourceKey('cx', CODEX_IDS.node18),
    upload: sourceKey('cx', CODEX_IDS.uploadFix),
    summary: sourceKey('cx', CODEX_IDS.weekSummary),
    label: sourceKey('cx', CODEX_IDS.undatedLabel),
    why: sourceKey('cx', CODEX_IDS.windowsWhy),
    // The rest of the week (lib/demo/extra.mjs).
    slow: claudeSessionKey(dirs.lantern, SESSION_IDS.slowTest),
    sinceUnreleased: claudeSessionKey(dirs.sinceWorktree, SESSION_IDS.sinceUnreleased),
    examples: claudeSessionKey(dirs.lantern, SESSION_IDS.readmeExamples),
    lint: claudeSessionKey(dirs.lintWorktree, SESSION_IDS.lint),
    lintReview: claudeSessionKey(dirs.lintWorktree, SESSION_IDS.lintReview),
    longWord: claudeSessionKey(dirs.lantern, SESSION_IDS.longWord),
    plan: claudeSessionKey(dirs.lantern, SESSION_IDS.releasePlan),
    announce: claudeSessionKey(dirs.lantern, SESSION_IDS.announcement),
    review15: claudeSessionKey(dirs.lantern, SESSION_IDS.reviewPr15),
    releaseFlow: sourceKey('cx', CODEX_IDS.releaseFlow),
    triage: sourceKey('cx', CODEX_IDS.triage),
    bench: sourceKey('cx', CODEX_IDS.parseBench),
    edges: sourceKey('cx', CODEX_IDS.filterTests),
  });
  const options = { config: d.config, from: WEEK.from, to: WEEK.to, roots: d.roots };
  h = await buildWorkHistory(options);
  all = await buildWorkHistory({ ...options, scope: 'all' });
});
after(() => {
  for (const dir of scratch) {
    removeTempDir(dir);
  }
});

test('thirty-five sessions on six days, eleven of them Codex, and one more outside the configured repos', () => {
  // 35 with the two review runs a step started: 22 from the original week and 13 from the rest
  // of it (lib/demo/extra.mjs), 9 Claude Code and 4 Codex.
  assert.equal(h.sessions.length, 35);
  const tools = h.sessions.map((s) => s.tool);
  assert.deepEqual([tools.filter((t) => t === 'claude-code').length, tools.filter((t) => t === 'codex').length], [24, 11]);
  assert.equal(h.skipped.outsideConfiguredRepos, 1);
  assert.equal(all.sessions.length, 36);
  assert.deepEqual(h.overview().days.map((x) => x.date), ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15']);
  for (const key of Object.values(k)) assert.ok(all.sessions.some((s) => s.key === key), `session ${key} is read`);
});

test('one person working: no two of my sessions overlap, Sunday is quiet, and there are quiet stretches inside sessions', () => {
  // A run one of my sessions launched is a program's, not mine: it starts seconds after its
  // launch step and may run alongside the session that started it (Tuesday's review run does).
  // No two of my own sessions overlap or run back to back.
  const launched = all.sessions.filter((s) => s.launchedBy?.event);
  assert.deepEqual(launched.map((s) => s.key).sort(), [k.review, k.lintReview].sort());
  for (const run of launched) {
    const step = all.events.find((e) => e.id === run.launchedBy.event);
    assert.ok(Date.parse(run.firstAt) > Date.parse(step.at) && Date.parse(run.firstAt) - Date.parse(step.at) < 60e3, 'a run starts seconds after the step that launched it');
  }
  const mine = all.sessions.filter((s) => !s.launchedBy?.event);
  const spans = mine.map((s) => [Date.parse(s.firstAt), Date.parse(s.lastAt)]).sort((a, b) => a[0] - b[0]);
  let end = spans[0][1];
  for (const [start, last] of spans.slice(1)) {
    assert.ok(start - end >= 5 * 60 * 1000, `no two sessions overlap or run back to back (${new Date(start).toISOString()})`);
    end = Math.max(end, last);
  }
  assert.ok(all.sessions.every((s) => new Date(s.firstAt).getUTCHours() >= 9 && new Date(s.lastAt).getUTCHours() < 19), 'every session falls in working hours');
  // 12: the original week's 11, and the lint session's wait for the README sub-agent it started
  // in the background.
  assert.equal(h.overview().totals.quietIntervals.value, 12);
});

test('most days hold four to eight sessions, from both tools, some short and some long', () => {
  const byDay = {};
  for (const s of all.sessions) (byDay[s.firstAt.slice(0, 10)] ??= []).push(s);
  assert.deepEqual(Object.keys(byDay).sort(), ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15']);
  for (const [day, list] of Object.entries(byDay)) {
    assert.ok(list.length >= 4 && list.length <= 8, `${day} has ${list.length} sessions`);
    assert.ok(list.some((s) => s.tool === 'codex') && list.some((s) => s.tool === 'claude-code'), `${day} has both tools`);
  }
  const steps = (key) => of(all, key).length;
  assert.ok(all.sessions.filter((s) => steps(s.key) <= 10).length >= 5, 'some short sessions');
  // The showcase: one long session in several turns, with seven sub-agents doing the work.
  assert.ok(steps(k.lint) >= 400 && steps(k.lint) <= 550, `the lint session has ${steps(k.lint)} steps`);
  assert.ok(Date.parse(sessionOf(k.lint).lastAt) - Date.parse(sessionOf(k.lint).firstAt) >= 3 * 3600e3, 'it runs for over three hours');
  assert.equal(of(h, k.lint, 'prompt').length, 7);
  const lanes = h.agents.filter((a) => a.session === k.lint && a.kind !== 'main');
  assert.equal(lanes.length, 7);
  for (const a of lanes) assert.ok(h.events.filter((e) => e.agent === a.key && e.kind === 'action').length >= 6, `${a.key} does real work`);
  assert.ok(lanes.filter((a) => h.events.filter((e) => e.agent === a.key && e.kind === 'action').length >= 40).length >= 4, 'four lanes of 40 steps or more');
});

test('worktree sessions count for the project, and the resumed session joins the one it continues', () => {
  for (const key of [k.group, k.resumed, k.markdown, k.release, k.upload, k.json, k.node18, k.sinceUnreleased, k.lint, k.lintReview, k.bench, k.edges]) assert.equal(sessionOf(key).repo, 'lantern');
  assert.match(d.repo.worktrees.groupByScope.replace(/\\/g, '/'), /\/lantern\/\.claude\/worktrees\/group-by-scope$/);
  // Each review run a step started is a thread of its own: 20 in the original week, 13 more.
  assert.equal(h.threads.length, 33);
  assert.ok(h.threads.some((t) => t.sessions.includes(k.group) && t.sessions.includes(k.resumed)));
  const cont = h.links.filter((l) => l.type === 'continuation').map((l) => [l.from, l.to]);
  assert.deepEqual(cont.sort(), [[k.resumed, k.group], [k.widthCommit, k.width]].sort());
  assert.ok(h.threads.some((t) => t.sessions.includes(k.width) && t.sessions.includes(k.widthCommit)));
  const resume = of(h, k.resumed, 'prompt')[0];
  assert.equal(resume.facts.text, 'continue from where we stopped on Tuesday');
  assert.ok(resume.inferred.some((x) => x.value === 'resume-request'));
  // Tuesday's last call never got a result; Thursday's resumed copy recorded that it was cut off.
  const cut = of(h, k.resumed, 'interrupt')[0];
  assert.equal(cut.facts.by, 'session-end');
  const call = h.events.find((e) => e.id === cut.facts.action);
  assert.equal(call.session, k.group);
  assert.equal(call.facts.result, 'interrupted');
});

test('prompts: 1 to 7 typed per session, one queued until the next turn, one absorbed mid-turn', () => {
  const totals = h.overview().totals;
  // 55 in the original week and 21 in the rest of it, 7 of those in the lint session.
  assert.equal(totals.prompts.value, 76);
  assert.equal(totals.prompts.evidence, 'inferred', 'three prompts come from a Claude Code that records no origin');
  assert.equal(all.overview().totals.prompts.value, 78);
  const perSession = Object.fromEntries(all.sessions.map((s) => [s.key, of(all, s.key, 'prompt').length]));
  assert.deepEqual(perSession, {
    [k.since]: 4, [k.wide]: 2, [k.breaking]: 2, [k.group]: 5, [k.bare]: 3, [k.markdown]: 7, [k.contributing]: 2, [k.resumed]: 4, [k.windows]: 1, [k.release]: 2,
    [k.json]: 3, [k.node18]: 2, [k.unreleased]: 3, [k.upload]: 2, [k.summary]: 0, [k.site]: 2, [k.lookup]: 3, [k.width]: 2, [k.widthCommit]: 2, [k.scratch]: 2, [k.label]: 1, [k.why]: 3,
    [k.review]: 0,
    [k.releaseFlow]: 1, [k.slow]: 2, [k.sinceUnreleased]: 1, [k.triage]: 1, [k.examples]: 1, [k.lint]: 7, [k.lintReview]: 0, [k.bench]: 1, [k.longWord]: 1, [k.plan]: 1,
    [k.edges]: 2, [k.announce]: 2, [k.review15]: 1,
  });
  // Neither the codex exec run nor the review runs a step started has a prompt of yours.
  const typed = Object.entries(perSession).filter(([key]) => ![k.summary, k.review, k.lintReview].includes(key)).map(([, n]) => n);
  assert.deepEqual([Math.min(...typed), Math.max(...typed)], [1, 7]);
  const queued = of(h, k.since, 'prompt').find((e) => e.facts.queuedAt);
  assert.match(queued.facts.text, /tag name/);
  assert.ok(queued.derived.queuedMs > 0);
  const absorbed = of(h, k.group, 'prompt').find((e) => e.facts.delivery === 'mid-turn');
  assert.match(absorbed.facts.text, /order they first appear/);
  assert.equal(totals.corrections.value, 4);
  assert.equal(totals.approvals.value, 2);
  // Who typed a prompt: recorded, or inferred from a missing origin. A codex exec run's
  // opening message is the agent's starting instruction, never a prompt (issue 62).
  const authorship = (e) => (e.inferred ?? []).find((x) => x && x.key === 'authorship')?.value ?? null;
  assert.deepEqual([k.width, k.widthCommit].map((key) => of(h, key, 'prompt').map(authorship)), [['person', 'person'], ['person', 'person']]);
  assert.deepEqual(of(h, k.summary, 'delegation-received').map((e) => [e.actor, e.agent === `${k.summary}:main`, e.facts.from]), [['agent', true, 'codex-exec']]);
  assert.ok(h.events.filter((e) => e.kind === 'prompt' && ![k.width, k.widthCommit, k.summary].includes(e.session)).every((e) => authorship(e) === null));
});

test("Saturday's review run: a script sent its command and both replies, so none of them is yours", () => {
  // Every user record in it says `turnOrigin: "sdk"`: the command is the program's, and its two
  // later turns are messages from a program, never prompts.
  const steps = of(h, k.review).filter((e) => ['prompt', 'command', 'agent-message', 'delegation-received'].includes(e.kind));
  assert.deepEqual(steps.map((e) => [e.kind, e.actor, e.facts.from, e.evidence]), [
    ['command', 'program', 'program', 'recorded'],
    ['agent-message', 'program', 'program', 'recorded'],
    ['agent-message', 'program', 'program', 'recorded'],
  ]);
  assert.equal(steps[0].facts.name, '/review');
  // The person's slash commands this week: one, the /compact in Tuesday's lint session, which
  // the harness records with the compaction it made.
  const typedCommands = h.events.filter((e) => e.kind === 'command' && e.actor === 'person');
  assert.deepEqual(typedCommands.map((e) => [e.session, e.facts.name]), [[k.lint, '/compact']]);
  const compactions = h.events.filter((e) => e.kind === 'compaction');
  assert.deepEqual(compactions.map((e) => [e.session, e.facts.trigger]), [[k.lint, 'manual']]);
  assert.ok(compactions[0].facts.preTokens > 80e3 && Date.parse(compactions[0].at) - Date.parse(typedCommands[0].at) < 5e3);
});

test('sixteen sub-agents: seven Explore, seven general-purpose, two Codex child threads, each tied to its starting call', () => {
  // 8 in the original week; the rest of it adds one Explore agent on Monday and the lint
  // session's seven (two Explore, five general-purpose).
  const subs = h.agents.filter((a) => a.kind !== 'main');
  assert.equal(subs.length, 16);
  assert.deepEqual(subs.map((a) => a.type ?? a.kind).sort(), [...Array(7).fill('Explore'), 'child-thread', 'child-thread', ...Array(7).fill('general-purpose')]);
  for (const a of subs) {
    assert.ok(a.spawnedBy, `${a.key} has a recorded starting call`);
    assert.deepEqual(a.missing, a.session === k.release ? ['completion-notice'] : a.session === k.why ? ['hand-back'] : [], a.key);
    assert.equal(h.events.filter((e) => e.agent === a.key && e.kind === 'delegation-received').length, 1, 'started with instructions');
  }
  for (const a of subs.filter((x) => x.kind === 'subagent')) assert.ok(a.description);
  // The two Explore agents on Monday ran at the same time.
  const [p, q] = subs.filter((a) => a.session === k.since);
  assert.ok(Date.parse(p.spawnAt) < Date.parse(q.completion.at) && Date.parse(q.spawnAt) < Date.parse(p.completion.at));
  const reviewer = subs.find((a) => a.type === 'general-purpose' && a.session === k.group);
  assert.equal(reviewer.completion.via, 'notification');
  // Monday's Codex child thread finished, as its parent recorded; Saturday's never reported back.
  assert.equal(subs.find((a) => a.session === k.wide).completion.via, 'activity-record');
  assert.equal(subs.find((a) => a.session === k.why).completion, null);
  assert.equal(h.overview().totals.reviews.value, 1);
  // Friday's Explore agent stamped its first line before the call that started it, and the
  // engine moved that line to the call's time.
  const moved = h.events.filter((e) => e.clock);
  assert.deepEqual(moved.map((e) => [e.session, e.kind, e.clock.rule]), [[k.unreleased, 'delegation-received', 'agent-after-spawn']]);
  assert.equal(moved[0].clock.raisedTo - moved[0].clock.recordedT, 45);
});

test('tool calls: reads, searches, edits with patches, shell, delegation, and the git and gh commands', () => {
  const acts = h.events.filter((e) => e.kind === 'action');
  // 313 in the original week (3 of them in Saturday's review run, and 1 the claude -p call that
  // started it) and 408 in the rest of it, 342 of those in the lint session and its review run.
  assert.equal(acts.length, 721);
  assert.equal(all.overview().totals.actions.value, 724);
  assert.equal(acts.filter((e) => e.session === k.lint || e.session === k.lintReview).length, 342);
  for (const cat of ['read', 'search', 'edit', 'shell', 'delegate', 'handoff', 'wait']) assert.ok(acts.some((e) => e.facts.category === cat), `a ${cat} call`);
  const cmds = acts.map((e) => e.facts.command ?? '');
  for (const re of [/^git add -A && git commit -m /, /^gh pr create /, /^gh pr view /, /^gh pr merge \d+ --squash$/, /^git push/, /^git reset --hard /, /^rm -rf /]) assert.ok(cmds.some((c) => re.test(c)), String(re));
  const patched = acts.filter((e) => e.derived.patch && e.derived.patch.added > 0);
  assert.ok(patched.some((e) => e.source.startsWith('cc-')) && patched.some((e) => e.source.startsWith('cx-')), 'Claude Code edits and Codex patches both carry line counts');
  // 63 in the original week and 70 in the rest of it.
  assert.equal(h.overview().totals.edits.value, 133);
  // Claude Code records the folder each line ran in; a shell read's relative path resolves against it.
  const ccShell = acts.filter((e) => e.source.startsWith('cc-') && e.facts.category === 'shell' && !sessionOf(e.session)?.private);
  assert.ok(ccShell.length > 0 && ccShell.every((e) => typeof e._lineCwd === 'string'), 'every readable Claude Code shell step has the folder its line recorded');
});

test('test runs: some pass, some fail, and the run cut off by the session ending is not counted', () => {
  const t = h.overview().totals;
  // 30 in the original week (22 passed, 8 with failures) and 72 in the rest of it: the lint
  // session's 20 failing runs are its sub-agents' tests written before their rules, three
  // mistakes those tests caught, and the two runs of the main agent's that failed.
  assert.deepEqual([t.testRuns.value, t.testRunsAllPassed.value, t.testRunsWithFailures.value, t.testRunsUnclear.value, t.testRunsWithoutSummary.value], [102, 74, 28, 0, 0]);
  const failed = h.events.filter((e) => e.kind === 'action' && e.derived.tests?.fail > 0);
  assert.deepEqual([...new Set(failed.map((e) => e.session))].sort(), [k.since, k.wide, k.bare, k.markdown, k.node18, k.why, k.lint].sort());
});

test('an interruption by the person, a hook refusal, and a call that never got a result', () => {
  const person = h.events.filter((e) => e.kind === 'interrupt' && e.facts.by === 'person');
  assert.deepEqual(person.map((e) => e.session), [k.group]);
  const next = of(h, k.group, 'prompt').find((e) => e.t > person[0].t);
  assert.ok(next.inferred.some((x) => x.value === 'correction'), 'the prompt after it is read as a correction');
  const guards = h.events.filter((e) => e.kind === 'guard');
  assert.equal(guards.length, 1);
  assert.equal(guards[0].session, k.resumed);
  assert.equal(guards[0].facts.rule, 'hook');
  assert.equal(h.events.find((e) => e.id === guards[0].facts.action).facts.result, 'refused');
  const open = h.events.filter((e) => e.kind === 'action' && !e.end);
  assert.deepEqual(open.map((e) => [e.session, e.facts.command]), [[k.json, 'gh pr checks 15 --watch'], [k.why, 'node --test --watch']]);
  assert.equal(sessionOf(k.json).endState, 'last-record-is-a-call-without-result');
  // Saturday's Codex session is stopped while its watch run waits: Codex records the abort.
  assert.deepEqual(of(h, k.why, 'interrupt').map((e) => [e.facts.by, e.facts.reason]), [['harness-reported', 'interrupted']]);
  assert.equal(sessionOf(k.why).endState, 'last-record-is-an-interruption');
});

test('a task suggestion started a new session (an inferred hand-off)', () => {
  const handoff = h.links.find((l) => l.type === 'handoff');
  assert.equal(handoff.to, k.json);
  assert.equal(h.events.find((e) => e.id === handoff.from).session, k.resumed);
  assert.equal(handoff.evidence, 'inferred');
  assert.equal(sessionOf(k.json).startedFrom, handoff.from);
});

test('pull requests: six opened, three squash-merged into main by you, each Claude Code one linked by the harness', () => {
  const landed = h.events.filter((e) => e.kind === 'outcome' && e.facts.outcome === 'pr-landed');
  assert.deepEqual(landed.map((e) => e.facts.pr), [12, 13, 14]);
  assert.ok(landed.every((e) => /\(#\d+\)$/.test(e.facts.subject) && e.facts.numberFrom === 'commit-subject'));
  assert.equal(landed.find((e) => e.facts.pr === 13).session, k.wide, 'the Codex pull request is read from what gh printed');
  assert.ok(landed.find((e) => e.facts.pr === 13).inferred.some((x) => x.rule === 'shell.gh-pr-output'));
  // #17 is the lint session's, still open.
  assert.deepEqual(h.gitNotes.filter((n) => n.kind === 'pr-not-landed-by-configured-identity').map((n) => n.pr).sort(), [15, 16, 17]);
  assert.deepEqual(h.events.filter((e) => e.kind === 'link').map((e) => e.facts.pr).sort((a, b) => a - b), [12, 14, 15, 16, 17]);
  const t = h.overview().totals;
  assert.equal(t.prsLanded.value, 3);
  // 17 in the original week and 5 in the rest of it, all on branches: two on the lint branch,
  // one each for the Unreleased fix, the benchmark and the filter tests.
  assert.equal(t.commitsByConfiguredIdentity.value, 22);
  const commits = h.events.filter((e) => e.kind === 'outcome' && e.facts.outcome === 'commit-exists');
  assert.ok(commits.every((e) => e.facts.authoredByConfiguredIdentity === true));
  // Every commit is on a branch but one: Thursday's skipped test, pushed straight to main.
  assert.deepEqual(commits.filter((e) => e.facts.onDefaultBranch !== false).map((e) => e.session), [k.windows]);
  // A commit id the redactor mistook for an account number would read as redacted.
  assert.ok([...commits, ...landed].every((e) => /^[0-9a-f]{12}$/.test(e.facts.sha)));
  const log = execFileSync('git', ['-C', d.repo.dir, 'log', '-4', '--format=%ae %s', 'main'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(log[0], `${ME} Skip the wide-character width test for now`);
  assert.deepEqual(log.slice(1).map((l) => l.match(/^(\S+) .*\(#(\d+)\)$/)?.slice(1)), [[ME, '14'], [ME, '13'], [ME, '12']]);
});

test('the display-only and outside sessions are private skeletons that git never reads', () => {
  const site = sessionOf(k.site);
  assert.equal(site.private, true);
  assert.equal(site.repo, 'personal-site');
  assert.equal(site.title, null);
  const scratchSession = all.sessions.find((s) => s.key === k.scratch);
  assert.equal(scratchSession.private, true);
  assert.equal(scratchSession.repo, null);
  for (const [history, key, words] of [[h, k.site, ['lantern 1.4', 'posts', 'npm run build', 'emoji', d.displayRepo.commit.slice(0, 7)]], [all, k.scratch, ['screenshot', 'rename', 'dry-run']]]) {
    const evs = of(history, key);
    assert.ok(evs.length > 5);
    const text = JSON.stringify(evs).toLowerCase();
    for (const w of words) assert.ok(!text.includes(w.toLowerCase()), `"${w}" stays out of a private session`);
    assert.ok(of(history, key, 'prompt').every((e) => e.facts.text === undefined));
    assert.equal(of(history, key, 'outcome').length, 0);
  }
  assert.ok(!h.sources.some((s) => s.tool === 'git' && s.repo === 'personal-site'));
  assert.equal(h.overview().totals.eventsInPrivateSessions.value, of(h, k.site).length);
});

test('every event passes the event contract', () => {
  for (const history of [h, all]) for (const e of history.events) assertEventContract(e, RULES);
});

test('the goal record: each event id is carried by one goals.mjs apply call, in the right session, inside its span', () => {
  const g = d.goalRecord;
  assert.deepEqual(g.goals.map((x) => [x.id, x.state]), [['release-1-4', 'active'], ['wrap-every-script', 'done'], ['json-output', 'active'], ['publish-notes', 'active']]);
  const where = { 'gev-3k9a': k.since, 'gev-7m2q': k.wide, 'gev-d4h5': k.group, 'gev-9p4x': k.resumed, 'gev-b6t1': k.resumed, 'gev-r5k2': k.release, 'gev-c2w8': k.json, 'gev-h8n3': k.unreleased, 'gev-w3j7': k.upload };
  assert.deepEqual(g.events.map((e) => e.eventId), Object.keys(where));
  const acts = h.events.filter((e) => e.kind === 'action');
  for (const ev of g.events) {
    assert.ok(g.goals.some((x) => x.id === ev.goalId));
    const carriers = acts.filter((e) => /goals\.mjs apply /.test(e.facts.command ?? '') && (e.facts.command ?? '').includes(` --event ${ev.eventId} `));
    assert.equal(carriers.length, 1, `${ev.eventId} is written once`);
    const [call] = carriers;
    assert.equal(call.session, where[ev.eventId]);
    assert.ok(call.facts.command.includes(`--goal ${ev.goalId} `) && call.facts.command.includes(`--type ${ev.type}`));
    const at = Date.parse(ev.at);
    assert.ok(at >= Date.parse(call.at) && at <= Date.parse(call.end.at), `${ev.eventId} falls inside its call's recorded span`);
  }
  // Saturday's session only looks the ids up: its calls name them, none applies one.
  const lookups = actions(h, k.lookup);
  assert.ok(lookups.some((e) => /gev-9p4x/.test(e.facts.command ?? e.facts.pattern ?? '')));
  assert.ok(lookups.some((e) => e.facts.category === 'search' && /gev-/.test(e.facts.pattern)));
  assert.ok(!lookups.some((e) => /goals\.mjs apply/.test(e.facts.command ?? '')));
  // Every citation names a pull request of the week or a session the engine read.
  const refs = g.goals.flatMap((x) => [x.source.ref, ...x.observations.map((o) => o.source.ref)]);
  const keyOf = { [SESSION_IDS.sinceFlag]: k.since, [SESSION_IDS.groupByScope]: k.group, [SESSION_IDS.groupByScopeResumed]: k.resumed, [SESSION_IDS.jsonOutput]: k.json, [SESSION_IDS.releaseScript]: k.release };
  for (const ref of refs) {
    const pr = ref.match(/^lantern#(\d+)$/) ?? ref.match(/^https:\/\/github\.com\/example\/lantern\/pull\/(\d+)$/);
    const session = ref.match(/^session:(.+)$/);
    assert.ok(pr || session, ref);
    if (pr) assert.ok([12, 13, 14, 15, 16, 17].includes(Number(pr[1])), ref);
    if (session) assert.ok(sessionOf(keyOf[session[1]]), `${ref} names a session the engine read`);
  }
  assert.ok(refs.some((r) => r.startsWith('lantern#')) && refs.some((r) => r.startsWith('https://')) && refs.some((r) => r.startsWith('session:')));
});

test('the replay views work end to end on the demo week', async () => {
  let out = '';
  const io = { out: (s) => (out += s), err: (s) => (out += s) };
  const code = await inspect(['--config', d.configFile, '--from', WEEK.from, '--to', WEEK.to, '--claude-root', d.roots.claude[0], '--codex-root', d.roots.codex[0], 'walk', '--json'], io);
  const report = JSON.parse(out);
  assert.equal(code, 0, report.checks.filter((c) => !c.ok).map((c) => c.name).join('; '));
  assert.ok(report.checks.length >= 15);
});

test("Replay's sessions list on the demo week: six days, newest first, a few each, and the private ones labelled", async () => {
  // The data `view --demo` serves: the demo's config with its made-up project name as a private word.
  const redaction = d.config.redaction ?? {};
  const data = createViewData({ config: { ...d.config, redaction: { ...redaction, terms: [...(redaction.terms ?? []), DEMO_TERM] } }, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, demo: true });
  await data.start();
  const ask = async (q = {}) => (await data.route('/api/sessions', new URLSearchParams(q))).body;
  const list = await ask();
  // Every session of the week, on the six days it has work; Sunday is quiet, so it has no group.
  assert.equal(list.total.value, all.sessions.length);
  assert.equal(list.timezone, 'UTC');
  // Five to seven a day, each day five rows and the rest one "Show N more" away.
  assert.deepEqual(list.days.map((x) => [x.day, x.count.value, x.rows.length, x.more.value]), [
    ['2025-03-15', 6, 5, 1],
    ['2025-03-14', 7, 5, 2],
    ['2025-03-13', 6, 5, 1],
    ['2025-03-12', 5, 5, 0],
    ['2025-03-11', 6, 5, 1],
    ['2025-03-10', 6, 5, 1],
  ]);
  assert.equal(list.older, null);
  assert.deepEqual(list.days.map((x) => x.rows[0].firstAt), [...list.days.map((x) => x.rows[0].firstAt)].sort().reverse(), 'newest day first');
  const more = await Promise.all(list.days.filter((x) => x.more.value).map((x) => ask({ day: x.day, offset: '5' })));
  assert.deepEqual(more.map((x) => x.rows.length), [1, 2, 1, 1, 1]);
  const friday = more[1];
  const rows = new Map([...list.days.flatMap((x) => x.rows), ...more.flatMap((x) => x.rows)].map((r) => [r.session, r]));
  assert.equal(rows.size, all.sessions.length);
  // The display-only and outside sessions: listed, labelled, redacted, and never counted for problems.
  const site = rows.get(k.site);
  assert.deepEqual([site.group, site.repo, site.title, site.problems], ['display', 'personal-site', 'Draft a post about [redacted:term] 1.4', null]);
  const outside = rows.get(k.scratch);
  assert.deepEqual([outside.group, outside.repo, outside.title, outside.problems], ['outside', null, 'Rename screenshots by date', null]);
  assert.ok([...rows.values()].filter((r) => r.group === 'configured').every((r) => r.problems && Number.isInteger(r.problems.value)));
  assert.ok([...rows.values()].some((r) => r.problems?.value > 0), 'the demo week has sessions worth a look');
  // A codex exec run has no prompt: its row says what started it.
  assert.ok([...rows.values()].some((r) => r.tool === 'codex' && r.prompts.value === 0 && r.startedBy?.text === 'started by codex exec, no prompt'));
  // The review run a script started says so, and its command stands in for the missing title.
  const review = rows.get(k.review);
  const { launch, ...started } = review.startedBy;
  assert.deepEqual([review.title, review.label, review.prompts.value, started], [null, '/review, Mar 15, 10:41 AM', 0, { text: 'started by a program: /review', evidence: 'recorded' }]);
  // It names the goal-lookup step that ran claude -p with its session id, recorded.
  assert.deepEqual([launch.session, launch.title, launch.evidence, launch.thread], [k.lookup, "List this week's goal events", 'recorded', sessionOf(k.lookup).thread]);
  assert.match(h.events.find((e) => e.id === launch.event).facts.command, /^claude -p --session-id /);
  // Tuesday's review run, started by the lint session in the background, names its step too.
  const lintReview = rows.get(k.lintReview);
  assert.deepEqual([lintReview.label, lintReview.startedBy.text, lintReview.startedBy.launch.session, lintReview.startedBy.launch.evidence], ['/review, Mar 11, 4:14 PM', 'started by a program: /review', k.lint, 'recorded']);
  // The made-up project's name shows only with the switch on.
  assert.ok(!JSON.stringify([list, friday]).includes(DEMO_TERM));
  await data.start('private');
  const on = (await data.route('/api/sessions', new URLSearchParams({ private: '1' }))).body;
  assert.equal(on.view.shown, 'private');
  assert.equal(on.days.flatMap((x) => x.rows).find((r) => r.session === k.site).title, `Draft a post about ${DEMO_TERM} 1.4`);
});

// Wednesday's logs print what the Markdown renderer makes from lib/demo/content.mjs, and the
// branch commits a renderer written out as text in lib/demo/week.mjs, with golden files made
// from the first. Running the branch's own tests keeps the two copies in step.
test("the Markdown branch's own tests pass, so the renderer it commits matches what its logs print", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test-reporter=tap', '--test', 'test/markdown.test.mjs'], { cwd: d.repo.worktrees.markdown, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# pass 12$/m);
  assert.match(r.stdout, /^# fail 0$/m);
  for (const name of ['driftwood', 'emberline', 'harbor-config', 'mossbank', 'quillpen']) assert.match(r.stdout, new RegExp(`^ok \\d+ - renders ${name}\\.md the way its \\.expected\\.md says$`, 'm'), name);
});

// Tuesday's logs print what lint finds, worked out in lib/demo/extra.mjs from the same rule
// functions whose source the branch commits. Running the branch's own tests and its lint
// command keeps the two in step.
test("the lint branch's own tests pass, and its lint command prints what the session printed", () => {
  const wt = join(d.repo.dir, '.claude', 'worktrees', 'lint');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test-reporter=tap', '--test'], { cwd: wt, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# pass 37$/m);
  assert.match(r.stdout, /^# fail 0$/m);
  const cli = spawnSync(process.execPath, ['bin/lantern.mjs', 'lint', 'CHANGELOG.md'], { cwd: wt, encoding: 'utf8' });
  assert.equal(cli.status, 0, 'only warnings, so lint exits 0');
  assert.match(cli.stdout, /^CHANGELOG\.md:3 warning missing-compare-link /);
  const log = readFileSync(join(d.roots.claude[0], d.ids.projectDirs.lintWorktree, `${SESSION_IDS.lint}.jsonl`), 'utf8');
  assert.ok(log.includes(JSON.stringify(cli.stdout.trim()).slice(1, -1)), 'the session printed the same lint output');
});

// The demo is where someone first sees the Problems page and the "Worth a look" strip, so
// this pins what it shows: which patterns are found, at which tier, and in which session.
test('the problem checks find a spread of patterns across the three tiers, each in the session that shows it', async () => {
  const ph = await buildWorkHistory({ config: d.config, from: WEEK.from, to: WEEK.to, roots: d.roots, usage: true, keepRaw: true, hiddenSessions: 'redacted' });
  const r = runProblems(ph, { builtT: Date.parse('2026-01-01T00:00:00Z'), longSessionTokens: d.config.longSessionTokens });
  const found = Object.fromEntries(r.patterns.filter((p) => p.status === 'found').map((p) => [p.id, [p.priority.tier, p.look, p.notesFound]]));
  // [tier, findings worth a look, routine notes]
  assert.deepEqual(found, {
    // 6: the original week's 5, and the lint session's "All tests pass" after a failing run.
    'claim-contradicts-evidence': ['high', 6, 0],
    'context-bloat': ['high', 2, 0],
    // 4: the lint session's pause before its third prompt is the fourth. With the bigger week's
    // tokens the four are 4.7% of the window's, under the 5% that makes a cost pattern High.
    'cache-miss': ['medium', 4, 0],
    'secret-exposure': ['high', 4, 1],
    'unverified-done-claim': ['medium', 2, 0],
    'test-tampering': ['medium', 2, 0],
    'destructive-command': ['medium', 1, 3],
    'repeated-file-reads': ['low', 0, 2],
    'action-loop': ['low', 1, 0],
    'repeated-tool-error': ['low', 2, 0],
    'oversized-tool-output': ['medium', 2, 0],
    'subagent-overuse': ['low', 0, 7],
    'subagent-handoff-loss': ['low', 2, 0],
    'scope-creep': ['low', 2, 0],
    'edits-outside-folder': ['low', 2, 0],
    'premature-stop': ['low', 2, 4],
    // One note: the go-ahead after a question in Saturday's review run came from the script
    // that ran it, not from you, so it isn't a second one.
    'needless-check-in': ['low', 0, 1],
  });
  const looks = r.patterns.flatMap((p) => p.findings.filter((f) => f.severity === 'look').map((f) => ({ ...f, tier: p.priority?.tier })));
  const where = (id) => [...new Set(looks.filter((f) => f.pattern === id).map((f) => f.session))].sort();
  // Saturday's Codex session sets up on Codex the patterns the Claude Code sessions show.
  assert.deepEqual(where('claim-contradicts-evidence'), [k.bare, k.markdown, k.why, k.lint].sort());
  assert.deepEqual(where('context-bloat'), [k.markdown, k.why].sort());
  // The demo caches for five minutes, so a pause longer than that re-sends the conversation: the
  // resumed session coming back after a break, and pauses in Wednesday's and Saturday's long ones.
  // and the lint session coming back to its third prompt.
  assert.deepEqual(where('cache-miss'), [k.markdown, k.resumed, k.why, k.lint].sort());
  assert.deepEqual(where('secret-exposure'), [k.release, k.upload].sort());
  assert.deepEqual(where('unverified-done-claim'), [k.width, k.label].sort());
  assert.deepEqual(where('test-tampering'), [k.windows, k.why].sort());
  assert.deepEqual(where('destructive-command'), [k.unreleased]);
  // Saturday's three reads of one short file are a routine note: each repeat added about 250
  // tokens, under the 500 the check asks for before a repeat is worth a look. The call's own
  // thinking no longer counts as what the read added.
  assert.deepEqual(where('repeated-file-reads'), []);
  const reread = r.patterns.find((p) => p.id === 'repeated-file-reads').findings;
  // Saturday's Codex session reads one test file three ways (sed -n 1,40p, head -n 40, sed again):
  // shell reads of the same lines count as the same read.
  assert.deepEqual(reread.map((f) => [f.severity, f.session, f.steps]).sort(), [['note', k.width, 3], ['note', k.why, 3]].sort());
  for (const f of reread) assert.match(f.note, /read 3 times .* 2 of the 2 repeats added under 500 tokens/);
  assert.deepEqual(where('action-loop'), [k.upload]);
  assert.deepEqual(where('repeated-tool-error'), [k.width, k.upload].sort());
  assert.deepEqual(where('oversized-tool-output'), [k.windows, k.why].sort());
  assert.deepEqual(where('subagent-handoff-loss'), [k.release, k.why].sort());
  assert.deepEqual(where('scope-creep'), [k.width, k.why].sort());
  assert.deepEqual(where('premature-stop'), [k.json, k.why].sort());
  // Wednesday's to-do list is still open at three turn ends whose messages name no blocker. No
  // plain continue follows any of them, so each is a note: it reads the same as a list left
  // untidied after finished work. The fourth turn end names its failing tests, a blocker.
  const todoStops = r.patterns.find((p) => p.id === 'premature-stop').findings.filter((f) => f.check === 'open-todos-stop');
  assert.deepEqual(todoStops.map((f) => [f.severity, f.session]), [['note', k.markdown], ['note', k.markdown], ['note', k.markdown]]);
  // No model call in the week writes 5,000 output tokens for one tool call: checked and clear.
  assert.equal(r.patterns.find((p) => p.id === 'overthinking').status, 'clear');
  // An edit into the display-only site from each agent, both asked for: shown, and git never reads the site.
  assert.deepEqual(where('edits-outside-folder'), [k.widthCommit, k.why].sort());
  for (const f of r.patterns.find((p) => p.id === 'edits-outside-folder').findings) assert.match(f.note, /^1 edit outside the folder this session started in: 1 in a display-only repository\. Files: \*\.md\.$/);
  // Most of the week is ordinary work: 13 of the 34 sessions the checks read (the display-only
  // one isn't checked) have anything worth a look. Neither review run has anything, and of the
  // rest of the week only the lint session does.
  const flagged = new Set(looks.map((f) => f.session));
  assert.deepEqual([flagged.size, r.coverage.sessions.value], [13, 34]);
  assert.deepEqual(looks.filter((f) => f.session === k.lint).map((f) => [f.pattern, f.tier]).sort(), [['cache-miss', 'medium'], ['claim-contradicts-evidence', 'high']]);
  // The cache figures docs/demo-week.md states: each miss came after a pause longer than the
  // demo's five-minute cache, which Claude Code records and Codex doesn't.
  const miss = r.patterns.find((p) => p.id === 'cache-miss');
  const missIn = (key) => miss.findings.find((f) => f.session === key);
  assert.deepEqual([k.markdown, k.why, k.resumed, k.lint].map((key) => [missIn(key).steps, Math.round(missIn(key).estimate / 1e3)]), [[6, 865], [2, 336], [2, 42], [3, 174]]);
  for (const key of [k.markdown, k.resumed, k.lint]) assert.match(missIn(key).note, /pause, longer than its 5-minute cache\.$/);
  assert.match(missIn(k.why).note, /pause; Codex doesn't record how long it caches\.$/);
  // The token figures docs/demo-week.md states (6 of the calls are Saturday's review run's): 367
  // calls and 19.4 million tokens in the original week, 802 and 29.9 million with the rest.
  assert.deepEqual([r.coverage.modelCalls.value, Math.round(r.coverage.tokens.value / 1e5)], [802, 299]);
  const bloat = r.patterns.find((p) => p.id === 'context-bloat');
  const bloatIn = (key) => bloat.findings.find((f) => f.session === key).note;
  assert.match(bloatIn(k.markdown), /at model call 44 of 77 .*largest context was 163k.*about 3\.8M tokens/);
  assert.match(bloatIn(k.why), /at model call 16 of 50 .*largest context was 169k.*about 4\.7M tokens/);
  // 44% of the original week's tokens, 28% of the bigger week's.
  assert.equal(Math.round(bloat.priority.share * 100), 28);
  const oversized = r.patterns.find((p) => p.id === 'oversized-tool-output').findings;
  assert.deepEqual(oversized.map((f) => [f.session, f.note.match(/by about (\d+k) tokens/)?.[1]]).sort(), [[k.windows, '23k'], [k.why, '22k']].sort());
  // The routine look-alike: Wednesday's recursive delete of its own scratch folder is a note.
  assert.deepEqual(r.patterns.find((p) => p.id === 'destructive-command').findings.map((f) => [f.severity, f.kind, f.session]), [['look', 'hard-reset', k.unreleased], ['note', 'recursive-delete', k.why], ['note', 'revert', k.why], ['note', 'recursive-delete', k.markdown]]);
  // The first high finding is Saturday's Codex claim. On Wednesday's replay two findings worth a
  // look sit close enough to merge into a count on the strip, beside the context band.
  const rank = { high: 0, medium: 1, low: 2 };
  const first = looks.filter((f) => f.event).sort((a, b) => rank[a.tier] - rank[b.tier])[0];
  assert.equal(first.session, k.why);
  const wed = looks.filter((f) => f.event && f.session === k.markdown).sort((a, b) => rank[a.tier] - rank[b.tier])[0];
  const near = looks.filter((f) => f.session === k.markdown && f.tier !== 'low' && !f.lastAt && Math.abs(Date.parse(f.at) - Date.parse(wed.at)) <= 60e3);
  assert.ok(near.length >= 2, 'two findings close enough to merge on the strip');
  assert.ok(looks.some((f) => f.session === k.markdown && f.pattern === 'context-bloat' && f.lastAt), 'a stretch on the strip too');
});

test("the pasted keys never reach the history the pages show, and the click-through's cases sit in the sessions it opens", () => {
  for (const history of [h, all]) {
    const text = JSON.stringify(history.events);
    for (const secret of ['7Qx2Lk9pR3vT6nW8zB4f', 'sandbox-EXAMPLE']) assert.ok(!text.includes(secret), `${secret} is redacted`);
  }
  // The replay steps of the click-through open the threads of the twelve most recent
  // sessions with a prompt: the inferred author, the non-interactive run and the moved
  // sub-agent line must be among them, and so must both sessions of one resumed thread.
  const recent = all.sessions.filter((s) => of(all, s.key, 'prompt').length || of(all, s.key, 'delegation-received').some((e) => e.facts.from === 'codex-exec')).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)).slice(0, 12).map((s) => s.key);
  for (const key of [k.width, k.widthCommit, k.summary, k.unreleased]) assert.ok(recent.includes(key), `${key} is among the twelve most recent sessions`);
  assert.ok(h.events.some((e) => recent.includes(e.session) && e.timeFrom === 'next-record'), 'a step that borrows its time from the next line');
});

test('the script writes the same bytes on every run, apart from the folder path', () => {
  const second = join(tmp('hw-demo-test-'), 'again');
  let printed = '';
  assert.equal(demoMain([second], { out: (s) => (printed += s), err: (s) => (printed += s) }), 0);
  const info = JSON.parse(printed);
  assert.deepEqual([info.from, info.to, info.timezone], [WEEK.from, WEEK.to, WEEK.timezone]);
  const files = (root) => {
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    };
    for (const top of ['claude', 'codex']) walk(join(root, top));
    return [...out, join(root, 'goals.json'), join(root, 'honestweek.config.json')];
  };
  // The folder path appears as is, escaped once inside JSON, and escaped twice where a
  // record holds JSON inside a string (a Codex call's arguments).
  const normalized = (root, file) => {
    const once = JSON.stringify(root).slice(1, -1);
    let text = readFileSync(file, 'utf8');
    for (const form of [JSON.stringify(once).slice(1, -1), once, root]) text = text.split(form).join('<root>');
    return text;
  };
  const a = files(d.root);
  const b = files(info.root);
  assert.deepEqual(a.map((f) => relative(d.root, f)), b.map((f) => relative(info.root, f)));
  for (let i = 0; i < a.length; i++) assert.equal(normalized(d.root, a[i]), normalized(info.root, b[i]), relative(d.root, a[i]));
  const heads = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'main', 'feature/json-output', 'feature/group-by-scope'], { encoding: 'utf8' });
  assert.equal(heads(info.repo), heads(d.repo.dir));
  // The generated logs name no one: the only address is the placeholder author's, every
  // GitHub link is under the placeholder owner, and no path from the machine that built
  // them is left once the folder path is set aside.
  const text = a.map((f) => normalized(d.root, f)).join('\n');
  assert.deepEqual([...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g))], [ME]);
  assert.ok((text.match(/github\.com\/[\w.-]+/g) ?? []).every((m) => m === 'github.com/example'));
  // Codex addresses its agents with paths of its own (the root agent is "/root"). They
  // aren't file paths, and on a machine whose home is /root they'd look like one, so
  // they're set aside, read from the rollouts themselves, before looking for a home path.
  const agentAddresses = new Set();
  for (const f of a.filter((x) => relative(d.root, x).startsWith('codex'))) {
    for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const p = JSON.parse(line).payload ?? {};
      const named = [p.source?.subagent?.thread_spawn?.agent_path, ...(p.type === 'agent_message' ? [p.author, p.recipient] : [])];
      if (p.type === 'function_call_output' && p.output.startsWith('{')) named.push(JSON.parse(p.output).task_name);
      for (const v of named) if (typeof v === 'string') agentAddresses.add(v);
    }
  }
  assert.deepEqual([...agentAddresses].sort(), ['/root', '/root/ci_check', '/root/wide_fixtures']);
  let pathless = text;
  for (const address of agentAddresses) for (const form of [`"${address}"`, `\\"${address}\\"`]) pathless = pathless.split(form).join('"<agent>"');
  const home = homedir();
  for (const form of [home, JSON.stringify(home).slice(1, -1)]) assert.ok(!pathless.includes(form), 'no home-directory path');
});

// On Windows a folder can be written with either slash. The token counts read the folder's
// path as one stand-in, so a build from the other spelling writes the same logs.
test('a folder written with forward slashes on Windows gives the same logs and token counts', { skip: process.platform !== 'win32' }, () => {
  const e = buildDemoWeek({ root: join(tmp('hw-demo-test-'), 'slashed').replace(/\\/g, '/') });
  assert.ok(!e.root.includes('/'), e.root);
  const file = (w) => join(w.roots.claude[0], w.ids.projectDirs.markdownWorktree, `${SESSION_IDS.markdownOutput}.jsonl`);
  const normalized = (w) => {
    const once = JSON.stringify(w.root).slice(1, -1);
    let text = readFileSync(file(w), 'utf8');
    for (const form of [JSON.stringify(once).slice(1, -1), once, w.root]) text = text.split(form).join('<root>');
    return text;
  };
  assert.equal(normalized(e), normalized(d));
});

test('a build that fails partway leaves nothing behind and says so', () => {
  const fresh = join(tmp('hw-demo-test-'), 'fresh');
  const empty = tmp('hw-demo-test-');
  const path = process.env.PATH;
  let err = '';
  try {
    // With no PATH, the first git call fails after the build has started writing.
    process.env.PATH = '';
    assert.throws(() => buildDemoWeek({ root: fresh }), /git/);
    assert.equal(demoMain([empty], { out: () => {}, err: (s) => (err += s) }), 1);
  } finally {
    process.env.PATH = path;
  }
  assert.equal(existsSync(fresh), false, 'a folder the build created is removed');
  assert.deepEqual(readdirSync(empty), [], 'a folder that was empty is empty again');
  assert.match(err, /could not write the week into/);
  assert.match(err, /Nothing was left behind/);
  assert.doesNotMatch(err, /too long/);
});

test('on Windows, a folder path too long for git is cleaned up and named as the cause', { skip: process.platform !== 'win32' }, () => {
  const base = tmp('hw-demo-test-');
  const deep = join(base, 'long-'.padEnd(Math.max(20, 215 - base.length), 'x'));
  let err = '';
  const code = demoMain([deep], { out: () => {}, err: (s) => (err += s) });
  if (code === 0) {
    // A git that handles long paths writes the whole week.
    assert.ok(existsSync(join(deep, 'goals.json')));
    return;
  }
  assert.equal(existsSync(deep), false);
  assert.match(err, /too long for git\. Choose a shorter one/);
  assert.match(err, /Nothing was left behind/);
});

test('the script refuses a folder that is not empty, and explains itself', () => {
  const full = tmp('hw-demo-test-');
  writeFileSync(join(full, 'keep.txt'), 'x');
  let err = '';
  assert.equal(demoMain([full], { out: () => {}, err: (s) => (err += s) }), 1);
  assert.match(err, /not empty/);
  let usage = '';
  assert.equal(demoMain(['--help'], { out: (s) => (usage += s), err: () => {} }), 0);
  assert.match(usage, /node tools\/demo-week\.mjs <out-dir>/);
  assert.equal(demoMain([], { out: () => {}, err: () => {} }), 1);
});
