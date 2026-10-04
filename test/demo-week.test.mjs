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

test('twenty sessions on six days, six of them Codex, and one more outside the configured repos', () => {
  assert.equal(h.sessions.length, 20);
  const tools = h.sessions.map((s) => s.tool);
  assert.deepEqual([tools.filter((t) => t === 'claude-code').length, tools.filter((t) => t === 'codex').length], [14, 6]);
  assert.equal(h.skipped.outsideConfiguredRepos, 1);
  assert.equal(all.sessions.length, 21);
  assert.deepEqual(h.overview().days.map((x) => x.date), ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15']);
  for (const key of Object.values(k)) assert.ok(all.sessions.some((s) => s.key === key), `session ${key} is read`);
});

test('one person working: no two sessions overlap, Sunday is quiet, and there are quiet stretches inside sessions', () => {
  const spans = all.sessions.map((s) => [Date.parse(s.firstAt), Date.parse(s.lastAt)]).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let end = spans[0][1];
  for (const [start, last] of spans.slice(1)) {
    gaps.push(start - end);
    end = Math.max(end, last);
  }
  assert.ok(gaps.every((g) => g >= 5 * 60 * 1000), 'no two sessions overlap or run back to back');
  assert.ok(spans.every(([start, last]) => new Date(start).getUTCHours() >= 9 && new Date(last).getUTCHours() < 19), 'every session falls in working hours');
  assert.equal(h.overview().totals.quietIntervals.value, 10);
});

test('worktree sessions count for the project, and the resumed session joins the one it continues', () => {
  for (const key of [k.group, k.resumed, k.markdown, k.release, k.upload, k.json, k.node18]) assert.equal(sessionOf(key).repo, 'lantern');
  assert.match(d.repo.worktrees.groupByScope.replace(/\\/g, '/'), /\/lantern\/\.claude\/worktrees\/group-by-scope$/);
  assert.equal(h.threads.length, 18);
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
  assert.equal(totals.prompts.value, 50);
  assert.equal(totals.prompts.evidence, 'inferred', 'three prompts come from a Claude Code that records no origin');
  assert.equal(all.overview().totals.prompts.value, 52);
  const perSession = Object.fromEntries(all.sessions.map((s) => [s.key, of(all, s.key, 'prompt').length]));
  assert.deepEqual(perSession, {
    [k.since]: 4, [k.wide]: 2, [k.breaking]: 2, [k.group]: 5, [k.bare]: 3, [k.markdown]: 7, [k.contributing]: 2, [k.resumed]: 4, [k.windows]: 1, [k.release]: 2,
    [k.json]: 3, [k.node18]: 2, [k.unreleased]: 3, [k.upload]: 2, [k.summary]: 0, [k.site]: 2, [k.lookup]: 2, [k.width]: 2, [k.widthCommit]: 1, [k.scratch]: 2, [k.label]: 1,
  });
  const typed = Object.entries(perSession).filter(([key]) => key !== k.summary).map(([, n]) => n);
  assert.deepEqual([Math.min(...typed), Math.max(...typed)], [1, 7]);
  const queued = of(h, k.since, 'prompt').find((e) => e.facts.queuedAt);
  assert.match(queued.facts.text, /tag name/);
  assert.ok(queued.derived.queuedMs > 0);
  const absorbed = of(h, k.group, 'prompt').find((e) => e.facts.delivery === 'mid-turn');
  assert.match(absorbed.facts.text, /order they first appear/);
  assert.equal(totals.corrections.value, 3);
  assert.equal(totals.approvals.value, 2);
  // Who typed a prompt: recorded, or inferred from a missing origin. A codex exec run's
  // opening message is the agent's starting instruction, never a prompt (issue 62).
  const authorship = (e) => (e.inferred ?? []).find((x) => x && x.key === 'authorship')?.value ?? null;
  assert.deepEqual([k.width, k.widthCommit].map((key) => of(h, key, 'prompt').map(authorship)), [['person', 'person'], ['person']]);
  assert.deepEqual(of(h, k.summary, 'delegation-received').map((e) => [e.actor, e.agent === `${k.summary}:main`, e.facts.from]), [['agent', true, 'codex-exec']]);
  assert.ok(h.events.filter((e) => e.kind === 'prompt' && ![k.width, k.widthCommit, k.summary].includes(e.session)).every((e) => authorship(e) === null));
});

test('seven sub-agents: four Explore, two general-purpose, one Codex child thread, each tied to its starting call', () => {
  const subs = h.agents.filter((a) => a.kind !== 'main');
  assert.equal(subs.length, 7);
  assert.deepEqual(subs.map((a) => a.type ?? a.kind).sort(), ['Explore', 'Explore', 'Explore', 'Explore', 'child-thread', 'general-purpose', 'general-purpose']);
  for (const a of subs) {
    assert.ok(a.spawnedBy, `${a.key} has a recorded starting call`);
    assert.deepEqual(a.missing, a.session === k.release ? ['completion-notice'] : [], a.key);
    assert.equal(h.events.filter((e) => e.agent === a.key && e.kind === 'delegation-received').length, 1, 'started with instructions');
  }
  for (const a of subs.filter((x) => x.kind === 'subagent')) assert.ok(a.description);
  // The two Explore agents on Monday ran at the same time.
  const [p, q] = subs.filter((a) => a.session === k.since);
  assert.ok(Date.parse(p.spawnAt) < Date.parse(q.completion.at) && Date.parse(q.spawnAt) < Date.parse(p.completion.at));
  const reviewer = subs.find((a) => a.type === 'general-purpose' && a.session === k.group);
  assert.equal(reviewer.completion.via, 'notification');
  assert.equal(h.overview().totals.reviews.value, 1);
  // Friday's Explore agent stamped its first line before the call that started it, and the
  // engine moved that line to the call's time.
  const moved = h.events.filter((e) => e.clock);
  assert.deepEqual(moved.map((e) => [e.session, e.kind, e.clock.rule]), [[k.unreleased, 'delegation-received', 'agent-after-spawn']]);
  assert.equal(moved[0].clock.raisedTo - moved[0].clock.recordedT, 45);
});

test('tool calls: reads, searches, edits with patches, shell, delegation, and the git and gh commands', () => {
  const acts = h.events.filter((e) => e.kind === 'action');
  assert.equal(acts.length, 260);
  assert.equal(all.overview().totals.actions.value, 263);
  for (const cat of ['read', 'search', 'edit', 'shell', 'delegate', 'handoff', 'wait']) assert.ok(acts.some((e) => e.facts.category === cat), `a ${cat} call`);
  const cmds = acts.map((e) => e.facts.command ?? '');
  for (const re of [/^git add -A && git commit -m /, /^gh pr create /, /^gh pr view /, /^gh pr merge \d+ --squash$/, /^git push/, /^git reset --hard /, /^rm -rf /]) assert.ok(cmds.some((c) => re.test(c)), String(re));
  const patched = acts.filter((e) => e.derived.patch && e.derived.patch.added > 0);
  assert.ok(patched.some((e) => e.source.startsWith('cc-')) && patched.some((e) => e.source.startsWith('cx-')), 'Claude Code edits and Codex patches both carry line counts');
  assert.equal(h.overview().totals.edits.value, 59);
});

test('test runs: some pass, some fail, and the run cut off by the session ending is not counted', () => {
  const t = h.overview().totals;
  assert.deepEqual([t.testRuns.value, t.testRunsAllPassed.value, t.testRunsWithFailures.value, t.testRunsUnclear.value, t.testRunsWithoutSummary.value], [28, 21, 7, 0, 0]);
  const failed = h.events.filter((e) => e.kind === 'action' && e.derived.tests?.fail > 0);
  assert.deepEqual([...new Set(failed.map((e) => e.session))].sort(), [k.since, k.wide, k.bare, k.markdown, k.node18].sort());
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
  assert.deepEqual(open.map((e) => [e.session, e.facts.command]), [[k.json, 'gh pr checks 15 --watch']]);
  assert.equal(sessionOf(k.json).endState, 'last-record-is-a-call-without-result');
});

test('a task suggestion started a new session (an inferred hand-off)', () => {
  const handoff = h.links.find((l) => l.type === 'handoff');
  assert.equal(handoff.to, k.json);
  assert.equal(h.events.find((e) => e.id === handoff.from).session, k.resumed);
  assert.equal(handoff.evidence, 'inferred');
  assert.equal(sessionOf(k.json).startedFrom, handoff.from);
});

test('pull requests: five opened, three squash-merged into main by you, each Claude Code one linked by the harness', () => {
  const landed = h.events.filter((e) => e.kind === 'outcome' && e.facts.outcome === 'pr-landed');
  assert.deepEqual(landed.map((e) => e.facts.pr), [12, 13, 14]);
  assert.ok(landed.every((e) => /\(#\d+\)$/.test(e.facts.subject) && e.facts.numberFrom === 'commit-subject'));
  assert.equal(landed.find((e) => e.facts.pr === 13).session, k.wide, 'the Codex pull request is read from what gh printed');
  assert.ok(landed.find((e) => e.facts.pr === 13).inferred.some((x) => x.rule === 'shell.gh-pr-output'));
  assert.deepEqual(h.gitNotes.filter((n) => n.kind === 'pr-not-landed-by-configured-identity').map((n) => n.pr).sort(), [15, 16]);
  assert.deepEqual(h.events.filter((e) => e.kind === 'link').map((e) => e.facts.pr), [12, 14, 15, 16]);
  const t = h.overview().totals;
  assert.equal(t.prsLanded.value, 3);
  assert.equal(t.commitsByConfiguredIdentity.value, 17);
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
    if (pr) assert.ok([12, 13, 14, 15, 16].includes(Number(pr[1])), ref);
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

// The demo is where someone first sees the Problems page and the "Worth a look" strip, so
// this pins what it shows: which patterns are found, at which tier, and in which session.
test('the problem checks find a spread of patterns across the three tiers, each in the session that shows it', async () => {
  const ph = await buildWorkHistory({ config: d.config, from: WEEK.from, to: WEEK.to, roots: d.roots, usage: true, keepRaw: true, hiddenSessions: 'redacted' });
  const r = runProblems(ph, { builtT: Date.parse('2026-01-01T00:00:00Z') });
  const found = Object.fromEntries(r.patterns.filter((p) => p.status === 'found').map((p) => [p.id, [p.priority.tier, p.look, p.notesFound]]));
  // [tier, findings worth a look, routine notes]
  assert.deepEqual(found, {
    'claim-contradicts-evidence': ['high', 4, 0],
    'context-bloat': ['high', 1, 0],
    'secret-exposure': ['high', 4, 1],
    'unverified-done-claim': ['medium', 2, 0],
    'test-tampering': ['medium', 1, 0],
    'destructive-command': ['medium', 1, 1],
    'repeated-file-reads': ['low', 0, 1],
    'action-loop': ['low', 1, 0],
    'repeated-tool-error': ['low', 2, 0],
    'oversized-tool-output': ['low', 1, 0],
    'subagent-overuse': ['low', 0, 6],
    'subagent-handoff-loss': ['low', 1, 0],
    'scope-creep': ['low', 1, 0],
    'premature-stop': ['low', 1, 1],
    'needless-check-in': ['low', 0, 1],
  });
  const looks = r.patterns.flatMap((p) => p.findings.filter((f) => f.severity === 'look').map((f) => ({ ...f, tier: p.priority?.tier })));
  const where = (id) => [...new Set(looks.filter((f) => f.pattern === id).map((f) => f.session))].sort();
  assert.deepEqual(where('claim-contradicts-evidence'), [k.bare, k.markdown].sort());
  assert.deepEqual(where('context-bloat'), [k.markdown]);
  assert.deepEqual(where('secret-exposure'), [k.release, k.upload].sort());
  assert.deepEqual(where('unverified-done-claim'), [k.width, k.label].sort());
  assert.deepEqual(where('test-tampering'), [k.windows]);
  assert.deepEqual(where('destructive-command'), [k.unreleased]);
  // Saturday's three reads of one short file are a routine note: each repeat added about 250
  // tokens, under the 500 the check asks for before a repeat is worth a look. The call's own
  // thinking no longer counts as what the read added.
  assert.deepEqual(where('repeated-file-reads'), []);
  const reread = r.patterns.find((p) => p.id === 'repeated-file-reads').findings;
  assert.deepEqual(reread.map((f) => [f.severity, f.session, f.steps]), [['note', k.width, 3]]);
  assert.match(reread[0].note, /read 3 times .* 2 of the 2 repeats added under 500 tokens/);
  assert.deepEqual(where('action-loop'), [k.upload]);
  assert.deepEqual(where('repeated-tool-error'), [k.width, k.upload].sort());
  assert.deepEqual(where('oversized-tool-output'), [k.windows]);
  assert.deepEqual(where('subagent-handoff-loss'), [k.release]);
  assert.deepEqual(where('scope-creep'), [k.width]);
  assert.deepEqual(where('premature-stop'), [k.json]);
  // Most of the week is ordinary work: 9 of the 19 sessions the checks read (the display-only
  // one isn't checked) have anything worth a look.
  const flagged = new Set(looks.map((f) => f.session));
  assert.deepEqual([flagged.size, r.coverage.sessions.value], [9, 19]);
  // The token figures docs/demo-week.md states.
  assert.deepEqual([r.coverage.modelCalls.value, Math.round(r.coverage.tokens.value / 1e5)], [306, 125]);
  const bloat = r.patterns.find((p) => p.id === 'context-bloat');
  assert.match(bloat.findings[0].note, /at model call 44 of 77 .*largest context was 163k.*about 3\.8M tokens/);
  assert.equal(Math.round(bloat.priority.share * 100), 31);
  assert.match(r.patterns.find((p) => p.id === 'oversized-tool-output').findings[0].note, /by about 23k tokens/);
  // The routine look-alike: Wednesday's recursive delete of its own scratch folder is a note.
  assert.deepEqual(r.patterns.find((p) => p.id === 'destructive-command').findings.map((f) => [f.severity, f.kind, f.session]), [['look', 'hard-reset', k.unreleased], ['note', 'recursive-delete', k.markdown]]);
  // The strip's click-through follows the first high finding; in its session two findings
  // worth a look sit close enough to merge into a count, beside the context band.
  const rank = { high: 0, medium: 1, low: 2 };
  const first = looks.filter((f) => f.event).sort((a, b) => rank[a.tier] - rank[b.tier])[0];
  assert.equal(first.session, k.markdown);
  const near = looks.filter((f) => f.session === first.session && f.tier !== 'low' && !f.lastAt && Math.abs(Date.parse(f.at) - Date.parse(first.at)) <= 60e3);
  assert.ok(near.length >= 2, 'two findings close enough to merge on the strip');
  assert.ok(looks.some((f) => f.session === first.session && f.pattern === 'context-bloat' && f.lastAt), 'a stretch on the strip too');
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
  assert.deepEqual([...agentAddresses].sort(), ['/root', '/root/wide_fixtures']);
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
