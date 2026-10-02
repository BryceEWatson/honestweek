// Regressions found by the independent review of the work-history engine: private
// skeletons that kept names, labels stronger than their evidence, copied records that
// doubled links, and a commit nomination that could name an older commit. Each test
// builds the smallest log that showed the problem.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { commandChain, headShaAfterCommit, parseTestSummary } from '../lib/replay/classify.mjs';
import { execProgramCommand, patchSummary } from '../lib/replay/codex.mjs';
import { testRunResult } from '../lib/replay/metrics.mjs';
import { gitOutcomes } from '../lib/replay/outcomes.mjs';
import { outputNominations } from '../lib/replay/parse-common.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { describe } from '../lib/replay/views.mjs';
import { main as inspect } from '../tools/replay-inspect.mjs';

const ME = 'you@example.com';
const T0 = Date.parse('2024-06-11T15:00:00.000Z');
const at = (min, ms = 0) => new Date(T0 + min * 60000 + ms).toISOString();

function git(dir, args, env = {}) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
}
function commit(dir, file, message, iso) {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  return git(dir, ['rev-parse', 'HEAD']);
}
function repo(dir, origin) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
}

let n = 0;
function cc(sessionId, cwd) {
  const lines = [];
  const base = (type, ts, extra = {}) => ({ type, sessionId, cwd, version: '2.1.0', uuid: `${sessionId}-r${++n}`, timestamp: ts, ...extra });
  const add = (o) => lines.push(JSON.stringify(o));
  return {
    lines,
    add,
    base,
    prompt: (ts, text, extra = {}) => add(base('user', ts, { message: { role: 'user', content: text }, origin: { kind: 'human' }, ...extra })),
    say: (ts, blocks, extra = {}) => add(base('assistant', ts, { message: { id: `m${n}`, model: 'model-a', role: 'assistant', content: blocks }, ...extra })),
    result: (ts, id, content, tur, { isError = false } = {}) => add(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...(tur !== undefined ? { toolUseResult: tur } : {}) })),
    attach: (ts, attachment) => add(base('attachment', ts, { attachment })),
  };
}
function write(file, lines) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

let root;
let fx;
let h;
let key;
const of = (session, kind) => h.events.filter((e) => e.session === session && (!kind || e.kind === kind));

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'hw-replay-reg-'));
  const site = join(root, 'site');
  repo(site, 'https://github.com/example/your-project.git');
  const shaA = commit(site, 'a.txt', 'Add the parser', at(5));
  const pr12 = commit(site, 'b.txt', 'Add the reader (#12)', at(10));
  const followUp = commit(site, 'c.txt', 'Follow-up to the reader (#12)', at(20));
  const display = join(root, 'a-private-project');
  repo(display);
  const displaySha = commit(display, 'invoice.txt', 'Fix the invoice export', at(1));
  const plain = join(root, 'not-a-repo');
  mkdirSync(plain, { recursive: true });

  const claudeRoot = join(root, 'claude');
  const codexRoot = join(root, 'codex');
  const ids = {};
  const sid = (name, i) => (ids[name] = `${String(i).repeat(8)}-0000-4000-8000-${String(i).repeat(12)}`);

  // S1: a display-role session naming an MCP server, a custom tool, a custom agent type.
  const s1 = cc(sid('S1', 1), display);
  s1.prompt(at(30), 'fix the invoices');
  s1.say(at(31), [{ type: 'tool_use', id: 't1', name: 'mcp__clientcrm__get_deal', input: { id: 1 } }, { type: 'tool_use', id: 't2', name: 'ClientExport', input: {} }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } }]);
  s1.result(at(32), 't1', 'deal', { content: 'deal' });
  s1.result(at(32, 1), 't2', 'ok', { ok: true });
  s1.result(at(32, 2), 't3', 'x', { stdout: 'x', stderr: '', interrupted: false });
  s1.say(at(33), [{ type: 'tool_use', id: 't4', name: 'Agent', input: { description: 'Audit invoices', subagent_type: 'client-invoice-auditor', prompt: 'Audit.' } }]);
  s1.result(at(35), 't4', 'done', { status: 'completed', agentId: 'aud1' });
  s1.add({ type: 'pr-link', sessionId: ids.S1, prNumber: 11, prUrl: 'https://github.com/client/invoices/pull/11', prRepository: 'client/invoices', timestamp: at(36) });
  write(join(claudeRoot, 'proj-c', `${ids.S1}.jsonl`), s1.lines);
  const aud = cc(ids.S1, display);
  aud.add(aud.base('user', at(33, 500), { isSidechain: true, agentId: 'aud1', message: { role: 'user', content: 'Audit.' } }));
  aud.say(at(34), [{ type: 'text', text: 'Audited.' }], { isSidechain: true, agentId: 'aud1' });
  write(join(claudeRoot, 'proj-c', ids.S1, 'subagents', 'agent-aud1.jsonl'), aud.lines);
  writeFileSync(join(claudeRoot, 'proj-c', ids.S1, 'subagents', 'agent-aud1.meta.json'), JSON.stringify({ agentType: 'client-invoice-auditor', description: 'Audit invoices', toolUseId: 't4' }));

  // S2: another display-role session linking a different pull request.
  const s2 = cc(sid('S2', 2), display);
  s2.prompt(at(40), 'fix billing');
  s2.add({ type: 'pr-link', sessionId: ids.S2, prNumber: 98, prUrl: 'https://github.com/client/billing/pull/98', prRepository: 'client/billing', timestamp: at(41) });
  write(join(claudeRoot, 'proj-c', `${ids.S2}.jsonl`), s2.lines);

  // S3 suggests a task; S4 starts from it and finishes a background task; S5 is a resumed copy of S4.
  const s3 = cc(sid('S3', 3), site);
  s3.prompt(at(50), 'plan the docs');
  s3.say(at(51), [{ type: 'tool_use', id: 'chip1', name: 'mcp__ccd_session__spawn_task', input: { title: 'Docs', prompt: 'Document the parser.', tldr: 'docs' } }]);
  s3.result(at(51, 100), 'chip1', 'Noted.', [{ type: 'text', text: 'ok' }]);
  write(join(claudeRoot, 'proj-s', `${ids.S3}.jsonl`), s3.lines);
  const s4 = cc(sid('S4', 4), site);
  s4.prompt(at(60), 'Document the parser.');
  s4.say(at(61), [{ type: 'tool_use', id: 'bg', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }]);
  s4.result(at(61, 100), 'bg', 'started', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' });
  s4.prompt(at(63), '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>', { origin: { kind: 'task-notification' } });
  write(join(claudeRoot, 'proj-s', `${ids.S4}.jsonl`), s4.lines);
  const s5 = cc(sid('S5', 5), site);
  for (const l of s4.lines) s5.add({ ...JSON.parse(l), sessionId: ids.S5 });
  s5.prompt(at(90), 'carry on with the docs');
  write(join(claudeRoot, 'proj-s', `${ids.S5}.jsonl`), s5.lines);

  // S6: messages from another session and a schedule, delivered while the agent was busy.
  const s6 = cc(sid('S6', 6), site);
  s6.prompt(at(100), 'start');
  s6.attach(at(101), { type: 'queued_command', prompt: 'No, stop and revert your change', origin: { kind: 'peer', msg_id: 'pm1', name: 'helper' } });
  s6.add({ type: 'queue-operation', operation: 'enqueue', timestamp: at(102), sessionId: ids.S6, content: '<cross-session-message from="helper">hello</cross-session-message>' });
  s6.attach(at(103), { type: 'queued_command', prompt: 'also check the docs' });
  s6.add({ type: 'queue-operation', operation: 'enqueue', timestamp: at(104), sessionId: ids.S6, content: 'first message' });
  s6.add({ type: 'queue-operation', operation: 'enqueue', timestamp: at(105), sessionId: ids.S6, content: 'second message' });
  s6.add({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: at(106), sessionId: ids.S6, content: 'second message, edited' });
  s6.say(at(107), [{ type: 'text', text: 'ok' }]);
  write(join(claudeRoot, 'proj-s', `${ids.S6}.jsonl`), s6.lines);

  // S7: an older log with an inline sub-agent; S8: a jest run whose suite failed to load.
  const s7 = cc(sid('S7', 7), site);
  s7.prompt(at(110), 'check the build');
  s7.add(s7.base('user', at(111), { isSidechain: true, message: { role: 'user', content: 'Check the build.' } }));
  s7.say(at(112), [{ type: 'text', text: 'The build is fine.' }], { isSidechain: true });
  write(join(claudeRoot, 'proj-s', `${ids.S7}.jsonl`), s7.lines);
  const s8 = cc(sid('S8', 8), site);
  const jest = 'Test Suites: 1 failed, 1 passed, 2 total\nTests:       5 passed, 5 total';
  s8.prompt(at(120), 'run jest');
  s8.say(at(121), [{ type: 'tool_use', id: 'j1', name: 'Bash', input: { command: 'npx jest' } }]);
  s8.result(at(122), 'j1', jest, { stdout: jest, stderr: '', interrupted: false }, { isError: true });
  write(join(claudeRoot, 'proj-s', `${ids.S8}.jsonl`), s8.lines);

  // X: a Codex thread whose exec calls are wrapped in a program, and a two-file patch.
  const X = '01900000-0000-7000-8000-0000000000c1';
  const cx = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
  const patch = '*** Begin Patch\n*** Update File: lib/a.mjs\n@@\n-old\n+new\n*** Add File: docs/b.md\n+hello\n*** End Patch';
  write(join(codexRoot, '2024', '06', '11', `rollout-2024-06-11T17-10-00-${X}.jsonl`), [
    cx(at(130), 'session_meta', { id: X, timestamp: at(130), cwd: site, originator: 'Codex Desktop', cli_version: '0.1.0', source: 'vscode' }),
    cx(at(130, 10), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the tests and patch.' }] }),
    cx(at(131), 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(await tools.exec_command({cmd:"node --test",max_output_tokens:2000}));' }),
    cx(at(132), 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Exit code: 0\n# tests 2\n# pass 2\n# fail 0' }] }),
    cx(at(133), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: patch }),
    cx(at(134), 'response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: 'Exit code: 0\nSuccess.' }),
  ]);

  const rawConfig = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [
      { path: site, label: 'Bluebird-site', role: 'featured' },
      { path: display, label: 'a-private-project', role: 'display' },
    ],
    redaction: { codenames: ['Bluebird'], names: [], terms: [] },
    output: { mode: 'digest', file: 'honestweek.digest.md' },
  };
  const config = normalizeConfig(rawConfig, { configDir: root });
  const configFile = join(root, 'honestweek.config.json');
  writeFileSync(configFile, JSON.stringify(rawConfig));
  fx = { site, display, plain, shaA, pr12, followUp, displaySha, claudeRoot, codexRoot, config, configFile };
  key = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, claudeSessionKey(name === 'S1' || name === 'S2' ? 'proj-c' : 'proj-s', id)]));
  key.X = sourceKey('cx', X);
  h = await buildWorkHistory({ config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [claudeRoot], codex: [codexRoot] } });
});
after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows can hold a lock on .git briefly */
  }
});

test('a private skeleton keeps no MCP server, custom tool, or custom agent type name', () => {
  const json = JSON.stringify(h.toJSON());
  for (const name of ['clientcrm', 'ClientExport', 'client-invoice-auditor', 'Audit invoices']) assert.ok(!json.includes(name), `${name} reached the history`);
  const tools = of(key.S1, 'action').map((e) => e.facts.tool);
  assert.ok(tools.includes('Bash'), "the harness's own tool names stay");
  assert.ok(tools.includes(null), 'a person-named tool is blanked');
  const agent = h.agents.find((a) => a.session === key.S1 && a.kind === 'subagent');
  assert.equal(agent.type, null);
  const th = h.thread(h.session(key.S1).thread);
  assert.ok(!JSON.stringify(th).includes('client-invoice-auditor'));
  for (const e of of(key.S1, 'action')) assert.ok(!JSON.stringify(h.record(e.id)).includes('clientcrm'));
});

test('two private sessions are never related through pull requests neither one names', () => {
  for (const s of [key.S1, key.S2]) assert.deepEqual(h.thread(h.session(s).thread).related.sessionsSharingAPullRequest, []);
});

test('a configured repository label is redacted wherever the history names it', () => {
  const json = JSON.stringify(h.toJSON());
  assert.ok(!json.includes('Bluebird'), 'the codename in the label reached the history');
  const s = h.sessions.find((x) => x.key === key.S4);
  assert.match(s.repo, /\[redacted:term\]/);
  for (const src of h.sources.filter((x) => x.tool === 'git')) assert.match(src.repo, /\[redacted:term\]/);
});

test('a resumed copy adds no second link, inference, or hand-off target', () => {
  const handoffs = h.links.filter((l) => l.type === 'handoff');
  assert.deepEqual(handoffs.map((l) => l.to), [key.S4], 'only the session the suggestion started');
  assert.equal(h.session(key.S5).startedFrom, null);
  const chip = of(key.S3, 'action').find((e) => e.facts.category === 'handoff');
  assert.equal(chip.inferred.filter((x) => x.key === 'startedSession').length, 1);
  assert.equal(h.links.filter((l) => l.type === 'completion-notice').length, 1);
  const linkKeys = h.links.map((l) => `${l.type}|${l.from}|${l.to}`);
  assert.equal(new Set(linkKeys).size, linkKeys.length, 'no link appears twice');
  // The shared records stay with the original, and each says a rule chose it.
  const first = of(key.S4, 'prompt')[0];
  assert.ok(first.copies.length > 0);
  assert.ok(first.inferred.some((x) => x.key === 'sessionAttribution' && x.rule === 'canonical.earliest-ending-copy'));
});

test('a message from another session or a schedule is never a prompt typed by a person', () => {
  const prompts = of(key.S6, 'prompt');
  assert.ok(!prompts.some((e) => /revert/.test(e.facts.text ?? '')), 'the peer message is not a prompt');
  const inbound = of(key.S6, 'agent-message').find((e) => e.facts.from === 'peer');
  assert.equal(inbound.actor, 'peer');
  assert.ok(!inbound.inferred.some((x) => x.value === 'correction'));
  const relayed = of(key.S6, 'queue').find((e) => e.facts.carries === 'relayed-message');
  assert.equal(relayed.actor, 'peer');
  // A queued prompt with no origin field is a person's only by the named rule.
  const noOrigin = prompts.find((e) => e.facts.text === 'also check the docs');
  assert.ok(noOrigin.inferred.some((x) => x.rule === 'prompt.authorship.no-origin'));
  const m = h.session(key.S6).metrics.prompts;
  assert.equal(m.evidence, 'inferred');
  assert.equal(m.promptsWithInferredAuthor, 1);
});

test('a queue removal that matches no waiting message pairs with nothing', () => {
  const remove = of(key.S6, 'queue').find((e) => e.facts.state === 'removed' && e.facts.reason === 'absorbed_mid_turn');
  assert.ok(remove.missing.includes('matching-enqueue'));
  assert.ok(!of(key.S6, 'prompt').some((e) => e.facts.text === 'first message'), 'no prompt is built from a guessed pairing');
  const first = of(key.S6, 'queue').find((e) => e.facts.state === 'enqueued' && e.derived.waitedMs != null);
  assert.equal(first, undefined);
});

test("an inline sub-agent's reply goes to its parent agent, not the person", () => {
  const msg = of(key.S7, 'message').find((e) => e.agent.endsWith(':sidechain'));
  assert.equal(msg.facts.to, 'parent-agent');
  assert.match(describe(msg), /^reply to parent agent/);
});

test('a test run whose suite failed to load, or whose own exit status failed, is not a pass', () => {
  const run = of(key.S8, 'action')[0];
  assert.equal(run.derived.tests.suitesFailed, 1);
  assert.equal(testRunResult(run), 'failed');
  const m = h.session(key.S8).metrics;
  assert.deepEqual([m.testRunsWithFailures.value, m.testRunsWithFailures.evidence], [1, 'inferred']);
  assert.equal(m.testRunsAllPassed.evidence, 'inferred');
  const ownExit = { kind: 'action', end: {}, facts: { testRunner: 'node --test', result: 'error', exitStatusBelongsToRunner: true }, derived: { tests: { tests: 2, pass: 2, fail: 0 } } };
  assert.equal(testRunResult(ownExit), 'failed');
  assert.equal(testRunResult({ ...ownExit, facts: { ...ownExit.facts, exitStatusBelongsToRunner: false } }), 'passed', 'a pipeline exit status says nothing about the runner');
  assert.equal(parseTestSummary('Test Files  1 failed | 2 passed (3)\nTests  4 passed (4)').suitesFailed, 1);
});

test('Codex: a wrapped exec program is read as its command, and a patch counts every file it names', () => {
  const [exec, patch] = of(key.X, 'action');
  assert.equal(exec.facts.testRunner, 'node --test');
  assert.equal(testRunResult(exec), 'passed');
  assert.equal(patch.facts.fileKeys.length, 2);
  assert.deepEqual(patch.derived.patch, { added: 2, removed: 1 });
  const m = h.session(key.X).metrics;
  assert.deepEqual([m.edits.value, m.filesEdited.value], [1, 2]);
  assert.equal(execProgramCommand('const r = await tools.shell_command({command: "git status"}); text(r);'), 'git status');
  assert.equal(execProgramCommand('text(await tools.exec_command({cmd:"a"})); text(await tools.wait({}));'), null, 'two tools mix their output');
  assert.equal(execProgramCommand('pytest -q'), 'pytest -q');
  assert.equal(patchSummary('Done'), null);
});

test('the commit after a quiet commit is HEAD only when nothing else could have printed first', () => {
  const sha = '9f8e7d6a1b2c';
  assert.equal(headShaAfterCommit('git add -A && git commit -qm "x" && git log --oneline -1', `${sha} x`), sha);
  assert.equal(headShaAfterCommit('git commit -q -m "x" && git log -1', `commit ${sha}`), sha);
  assert.equal(headShaAfterCommit('git commit -qm "x"; git log --oneline -1', `${sha} older`), null, 'a ; runs the log even when the commit failed');
  assert.equal(headShaAfterCommit('git commit -qm "x" && git log --oneline -1', `nothing to commit, working tree clean\n${sha} older`), null);
  assert.equal(headShaAfterCommit('git rev-parse HEAD && git commit -qm "x" && git log -1', `${sha}\ncommit 1234567abc`), null, 'a command before the commit printed first');
  assert.equal(headShaAfterCommit('git commit -m "x" && git log -1', `commit ${sha}`), null, 'a commit that is not quiet prints its own summary; none means it did not happen');
  assert.equal(headShaAfterCommit('git commit -qm "x" && npm test && git log -1', `${sha} x`), null, 'the log must come right after the commit');
  assert.deepEqual(outputNominations('git commit -qm "x"; git log --oneline -1', `On branch main\nnothing to commit\n${sha} older`, { inferred: [], facts: {} }).commits, []);
  assert.deepEqual(commandChain('a && b; c | d'), [{ cmd: 'a', op: '&&' }, { cmd: 'b', op: ';' }, { cmd: 'c', op: '|' }, { cmd: 'd', op: null }]);
});

const nomination = (session, sha, evidence, t = T0) => ({ sha, kind: evidence === 'recorded' ? 'committed' : 'nominated', evidence, rule: evidence === 'recorded' ? undefined : 'shell.git-commit-output', event: { id: `${session}.1.0`, session, t, missing: [], turn: null } });
const redact = (s) => s;

test("git: the harness's own record of a commit outranks an inference from printed output", () => {
  const repoCfg = { label: 'your-project', role: 'featured', path: fx.site };
  const sessionsByKey = new Map([['x', { repo: repoCfg, isPrivate: false }], ['y', { repo: repoCfg, isPrivate: false }]]);
  const commits = [nomination('y', fx.shaA, 'inferred', T0 - 1000), nomination('x', fx.shaA, 'recorded', T0)];
  const out = gitOutcomes({ config: fx.config, sessionsByKey, commits, prs: [], redact });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].session, 'x');
  assert.deepEqual(out.events[0].inferred, []);
  assert.match(out.events[0].at, /\.000Z$/, 'one spelling of the instant, whatever git printed');
});

test('git: a display-role repository is never read, even when the nomination reaches the outcome step', () => {
  for (const isPrivate of [true, false]) {
    const sessionsByKey = new Map([['d', { repo: { label: 'a-private-project', role: 'display', path: fx.display }, isPrivate }]]);
    const out = gitOutcomes({ config: fx.config, sessionsByKey, commits: [nomination('d', fx.displaySha, 'recorded')], prs: [{ repo: 'example/your-project', number: 12, evidence: 'recorded', event: nomination('d', '', 'recorded').event }], redact });
    assert.deepEqual(out, { events: [], sources: [], notes: [] });
  }
});

test('git: a repository git cannot read says so, never "no such commit" or "not landed"', () => {
  const sessionsByKey = new Map([['x', { repo: { label: 'gone', role: 'featured', path: fx.plain }, isPrivate: false }]]);
  const c = nomination('x', fx.shaA, 'recorded');
  const p = { repo: 'example/your-project', number: 12, evidence: 'recorded', event: nomination('x', '', 'recorded').event };
  const out = gitOutcomes({ config: fx.config, sessionsByKey, commits: [c], prs: [p], redact });
  assert.deepEqual(out.events, []);
  assert.ok(c.event.missing.includes('readable-session-repository'));
  assert.ok(!c.event.missing.includes('commit-in-session-repository'));
  assert.deepEqual(out.notes.map((x) => x.kind), ['repository-unreadable']);
});

test('git: a pull request landed with the first default-branch commit naming it, and that match is an inference', () => {
  const sessionsByKey = new Map([['x', { repo: { label: 'your-project', role: 'featured', path: fx.site }, isPrivate: false }]]);
  const out = gitOutcomes({ config: fx.config, sessionsByKey, commits: [], prs: [{ repo: 'example/your-project', number: 12, evidence: 'recorded', event: nomination('x', '', 'recorded').event }], redact });
  const [pr] = out.events;
  assert.equal(pr.refs[0].sha, fx.pr12, 'not the later follow-up that also names it');
  assert.equal(pr.evidence, 'inferred');
  assert.equal(pr.inferred[0].rule, 'git.pr-number-from-subject');
  assert.match(describe(pr), /names pull request 12/);
});

test('an outcome whose default branch was not checked never reads as "not on the default branch"', () => {
  const e = { kind: 'outcome', facts: { outcome: 'commit-exists', sha: 'abc1234', subject: 's', onDefaultBranch: null } };
  assert.match(describe(e), /default branch not checked/);
});

test('the walk stops cleanly on a readable thread with no turns', async () => {
  const quietRoot = join(root, 'claude-quiet');
  const q = cc('77777777-0000-4000-8000-777777777777', fx.site);
  q.say(at(140), [{ type: 'text', text: 'hello' }]);
  q.add(q.base('system', at(141), { subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }));
  write(join(quietRoot, 'proj-q', '77777777-0000-4000-8000-777777777777.jsonl'), q.lines);
  let out = '';
  const code = await inspect(['--config', fx.configFile, '--from', '2024-06-10', '--to', '2024-06-16', '--claude-root', quietRoot, '--no-git', 'walk', '--json'], { out: (s) => (out += s), err: () => {} });
  assert.equal(code, 1);
  assert.ok(JSON.parse(out).checks.some((c) => !c.ok));
});
