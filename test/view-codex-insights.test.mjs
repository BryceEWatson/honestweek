// What Claude Code's /insights gives Claude Code users, for Codex too.
//
// Session facts (lib/view/facts.mjs): honestweek works out the session-meta facts itself, the
// same way for both agents, each saying how it's known, and "not recorded" (never 0) where an
// agent's logs don't carry one. Run with Codex (lib/view/codex-judge.mjs): a fake codex on the
// PATH, never the real one, answers for each Codex session; the button needs the run's key,
// takes POST only, refuses other hosts and sites, runs once at a time, stops on time with
// everything it started, and passes nothing from the request on. What codex reads and what's
// kept are redacted, malformed answers are skipped and counted, and with the /insights toggle
// off every answer honestweek already gave is the same bytes. Made-up logs only.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { scanPromptSources } from '../lib/prompt-adapters.mjs';
import { coverage, DESTRUCTIVE_RULE, FACT_NAMES, GIT_RULE, sessionFacts, windowTotals } from '../lib/view/facts.mjs';
import { CODEX_ARGS, createCodexJudge, facetsOf, FACET_FIELDS, JUDGE_DIR, JUDGE_PROMPT, judgeInput, parseAnswer, readJudgments } from '../lib/view/codex-judge.mjs';
import { createInsights, findOnPath } from '../lib/view/insights.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { CODE_HEADER, KEY_HEADER } from '../lib/view/server.mjs';
import { runView } from '../lib/view.mjs';
import { buildViewWeek, IDS, NAME, OTHER_TERM, SECRETS, TERM, WEEK } from './fixtures/view/week.mjs';

const scratch = makeTempDir('hw-codex-insights-');
const running = [];
// Each test's pages stop when it ends, and their builds with them, so a build a test is done
// with doesn't run git while a later test waits on its own.
afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});
after(async () => {
  for (const h of running) await h.stop();
  removeTempDir(scratch);
});
const WIN = process.platform === 'win32';
const SEP = WIN ? ';' : ':';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'you@example.com';

// ---- a made-up week: one Claude Code and one Codex session doing the same work ---------------

const PRIVATE = 'Quillfeather';
const C0 = Date.parse('2024-06-12T10:00:00.000Z');
const T = (s) => new Date(C0 + s * 1000).toISOString();
const ID = { claude: '0b0b0b0b-1111-4222-8333-444444444444', codex: '0190d000-0000-7000-8000-0000000000c1', bare: '0190d000-0000-7000-8000-0000000000c2', judge: '0190d000-0000-7000-8000-0000000000c3' };
const FIRST = `Fix the ${PRIVATE} parser; the token is ${SECRETS.github}.`;
const COMMANDS = ['git commit -m "Fix the parser"', 'git push origin main', 'rm -rf build'];

function writeRows(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function claudeRows(cwd) {
  let u = 0;
  const base = (s, type, extra) => ({ type, sessionId: ID.claude, uuid: `u${++u}`, timestamp: T(s), cwd, ...extra });
  const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  // Only the two text replies carry token counts, like the Codex session's two token records.
  const tool = (s, id, name, input) => base(s, 'assistant', { message: { id: `m${s}`, role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 0, output_tokens: 0 } } });
  const result = (s, id, text, isError = false, extra = {}) => base(s, 'user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, toolUseResult: extra });
  return [
    base(0, 'user', { message: { role: 'user', content: FIRST } }),
    base(1, 'assistant', { message: { id: 'm1', role: 'assistant', model: 'model-a', content: [{ type: 'text', text: 'Looking at the parser.' }], usage } }),
    tool(2, 't1', 'Bash', { command: COMMANDS[0] }),
    result(3, 't1', 'done'),
    tool(4, 't2', 'Bash', { command: COMMANDS[1] }),
    result(5, 't2', 'done'),
    tool(6, 't3', 'Bash', { command: COMMANDS[2] }),
    result(7, 't3', 'done'),
    tool(8, 't4', 'Bash', { command: 'npm run lint' }),
    result(9, 't4', 'Exit code 1\nlint failed', true),
    tool(10, 't5', 'Edit', { file_path: `${cwd}/src/parse.mjs`, old_string: 'a', new_string: 'b' }),
    result(11, 't5', 'ok', false, { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ['-a', '+b', '+c', '+d'] }] }),
    base(12, 'assistant', { message: { id: 'm12', role: 'assistant', model: 'model-a', content: [{ type: 'text', text: 'Fixed.' }], usage } }),
    base(72, 'user', { message: { role: 'user', content: 'Thanks, that works.' } }),
  ];
}

const rec = (s, type, payload) => ({ timestamp: T(s), type, payload });
function codexRows(cwd, id = ID.codex, { tokens = true, first = FIRST, extraMeta = {} } = {}) {
  const call = (s, cid, cmd) => [rec(s, 'response_item', { type: 'function_call', name: 'exec_command', call_id: cid, arguments: JSON.stringify({ cmd, workdir: cwd }) })];
  const out = (s, cid, exit, text) => rec(s, 'response_item', { type: 'function_call_output', call_id: cid, output: `Wall time: 1.0 seconds\nProcess exited with code ${exit}\nOutput:\n${text}` });
  const tok = (s, total) => rec(s, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, total_tokens: 120 } } });
  return [
    rec(0, 'session_meta', { id, timestamp: T(0), cwd, originator: 'codex_vscode', cli_version: '0.159.2', source: 'vscode', ...extraMeta }),
    rec(0, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: first }] }),
    rec(1, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking at the parser.' }] }),
    ...(tokens ? [tok(1, 120)] : []),
    ...call(2, 'c1', COMMANDS[0]), out(3, 'c1', 0, 'done'),
    ...call(4, 'c2', COMMANDS[1]), out(5, 'c2', 0, 'done'),
    ...call(6, 'c3', COMMANDS[2]), out(7, 'c3', 0, 'done'),
    ...call(8, 'c4', 'npm run lint'), out(9, 'c4', 1, 'lint failed'),
    rec(10, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'c5', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/parse.mjs\n@@\n-a\n+b\n+c\n+d\n*** End Patch\n' }),
    rec(11, 'response_item', { type: 'custom_tool_call_output', call_id: 'c5', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/parse.mjs\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) }),
    rec(12, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] }),
    ...(tokens ? [tok(12, 240)] : []),
    rec(72, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks, that works.' }] }),
  ];
}

function madeUpWeek(name) {
  const root = join(scratch, name);
  const project = join(root, 'your-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeRows(join(root, 'claude', 'projects', '-your-project', `${ID.claude}.jsonl`), claudeRows(project));
  const day = join(root, 'codex', 'sessions', '2024', '06', '12');
  writeRows(join(day, `rollout-2024-06-12T10-00-00-${ID.codex}.jsonl`), codexRows(project));
  // A Codex session with no token records, and a run shaped like the button's own codex exec.
  writeRows(join(day, `rollout-2024-06-12T11-00-00-${ID.bare}.jsonl`), codexRows(project, ID.bare, { tokens: false, first: 'Look at the tests.' }));
  writeRows(join(day, `rollout-2024-06-12T12-00-00-${ID.judge}.jsonl`), codexRows(project, ID.judge, { first: judgeInput('Person: hello'), extraMeta: { originator: 'codex_exec', source: 'exec' } }));
  const config = normalizeConfig({ identity: { authorEmails: [ME] }, week: { timezone: 'UTC' }, redaction: { names: [], terms: [PRIVATE] }, repos: [{ path: project, label: 'your-project', role: 'featured' }] }, { configDir: root });
  return { root, project, config, roots: { claude: [join(root, 'claude', 'projects')], codex: [join(root, 'codex', 'sessions')] } };
}
const WINDOW = { from: '2024-06-10', to: '2024-06-16', timezone: 'UTC' };
const mw = madeUpWeek('week');
const h = await buildWorkHistory({ config: mw.config, roots: mw.roots, ...WINDOW, scope: 'all', hiddenSessions: 'redacted', usage: true, keepRaw: true, git: false });
const keyOf = (tool, id) => h.sessions.find((s) => s.tool === tool && (tool === 'codex' ? h.codexIds : h.claudeIds).get(s.key) === id)?.key;
const factsOf = (key) => {
  const s = h.sessions.find((x) => x.key === key);
  return sessionFacts(h, s, { usage: h.usage.calls, id: (s.tool === 'codex' ? h.codexIds : h.claudeIds).get(s.key), cwd: h._raw.cwdOfSource.get(s.key) ?? null, hidden: s.private });
};

// The fixture week the page tests read, built before any test is registered: the root after()
// hook runs as soon as the tests registered so far finish, and would remove the folder under
// setup still running.

/** A well-formed answer: exactly the facet fields. */
const GOOD = { underlying_goal: 'Fix the parser', goal_categories: { bug_fix: 1 }, outcome: 'fully_achieved', user_satisfaction_counts: { satisfied: 1 }, claude_helpfulness: 'very_helpful', session_type: 'single_task', friction_counts: { lint_failure: 1 }, friction_detail: 'Lint failed once.', primary_success: 'The fix landed.', brief_summary: 'Fixed the parser.' };
const vw = buildViewWeek(join(scratch, 'view-week'));
const VWIN = { from: WEEK.from, to: WEEK.to, timezone: 'UTC' };
const NOW = Date.parse(`${WEEK.to}T12:00:00Z`);
const judgedDir = join(scratch, 'cfg-view');
// Stored judgments for every Codex session the fixture week shows, holding private words.
const seedView = createViewData({ config: vw.config, roots: vw.roots, ...VWIN, goalRecord: vw.goalRecord, now: () => NOW });
await seedView.start();
const viewCodex = seedView.codexWork().sessions;
mkdirSync(join(judgedDir, JUDGE_DIR), { recursive: true });
for (const s of viewCodex) writeFileSync(join(judgedDir, JUDGE_DIR, `${s.id}.json`), JSON.stringify({ session_id: s.id, agent: 'codex', judgedAt: '2025-03-14T00:00:00.000Z', facets: { ...GOOD, brief_summary: `Worked on ${TERM} with ${SECRETS.apiKey}.` } }));
writeFileSync(join(judgedDir, JUDGE_DIR, `${IDS.exec}.json`), JSON.stringify({ session_id: IDS.exec, facets: GOOD }));
const makeView = (insights, codexJudge) => createViewData({ config: vw.config, roots: vw.roots, ...VWIN, goalRecord: vw.goalRecord, now: () => NOW, insights, codexJudge });
const plain = makeView(null, null);
const off = makeView(createInsights({ dir: null, on: false }), createCodexJudge({ configDir: judgedDir }));
const on = makeView(createInsights({ dir: null, on: true }), createCodexJudge({ configDir: judgedDir }));
for (const d of [plain, off, on]) await d.start();
await on.start('private');
const ask = (data, path, q = {}) => data.route(path, new URLSearchParams(q));

// ---- facts ---------------------------------------------------------------------------------

test('facts: the same work gives the same facts for a Claude Code session and a Codex session', () => {
  const cc = factsOf(keyOf('claude-code', ID.claude));
  const cx = factsOf(keyOf('codex', ID.codex));
  assert.equal(cc.agent, 'claude-code');
  assert.equal(cx.agent, 'codex');
  const value = (f, n) => f.facts[n].value;
  for (const n of ['user_message_count', 'assistant_message_count', 'git_commits', 'git_pushes', 'tool_errors', 'lines_added', 'lines_removed', 'files_modified', 'file_edit_tool_count', 'destructive_command_count', 'input_tokens', 'output_tokens', 'duration_minutes', 'uses_task_agent', 'uses_mcp', 'user_interruptions']) {
    assert.deepEqual(value(cx, n), value(cc, n), `${n} is the same for both agents`);
  }
  assert.deepEqual([value(cc, 'user_message_count'), value(cc, 'git_commits'), value(cc, 'git_pushes'), value(cc, 'tool_errors'), value(cc, 'lines_added'), value(cc, 'lines_removed'), value(cc, 'files_modified'), value(cc, 'destructive_command_count')], [2, 1, 1, 1, 3, 1, 1, 1]);
  assert.deepEqual(value(cc, 'input_tokens'), 200);
  assert.deepEqual(value(cc, 'languages'), value(cx, 'languages'));
  assert.deepEqual(value(cc, 'languages'), { JavaScript: 1 });
  // Reply time: from the agent's last step (12 s) to the next prompt (72 s), the same for both.
  assert.deepEqual(value(cc, 'user_response_times'), [60]);
  assert.deepEqual(value(cx, 'user_response_times'), [60]);
  assert.deepEqual(value(cc, 'message_hours'), { 10: 2 });
  assert.deepEqual(value(cx, 'user_message_timestamps'), [T(0), T(72)]);
  assert.equal(value(cc, 'session_id'), ID.claude);
  assert.equal(value(cx, 'session_id'), ID.codex);
  assert.equal(value(cx, 'first_prompt'), value(cc, 'first_prompt'));
  // How each is known: a start time is recorded, a count derived, the risky-command count inferred.
  for (const f of [cc, cx]) {
    assert.equal(f.facts.start_time.how, 'recorded');
    assert.equal(f.facts.tool_errors.how, 'derived');
    // A git or rm -rf count matches a pattern on the command's text, so it's inferred and names its rule.
    assert.deepEqual([f.facts.git_commits.how, f.facts.git_commits.rule], ['inferred', GIT_RULE]);
    assert.deepEqual([f.facts.destructive_command_count.how, f.facts.destructive_command_count.rule], ['inferred', DESTRUCTIVE_RULE]);
    assert.deepEqual(Object.keys(f.facts), FACT_NAMES);
    // A receipt on every fact: the steps it was read or counted from, each a real step of this
    // session, or for tokens the log lines; only a fact with nothing to point at has none.
    const steps = new Map(h.events.filter((e) => e.session === f.key).map((e) => [e.id, e]));
    for (const n of FACT_NAMES) {
      const x = f.facts[n];
      if (x.how === 'not-recorded') continue;
      if (n.endsWith('_tokens')) assert.ok(x.refs.length > 0 && x.refs.every((r) => typeof r.src === 'string' && r.lines.length), `${n} names its log lines`);
      else if (x.value !== 0 && x.value !== false && !(x.value && typeof x.value === 'object' && !Array.isArray(x.value) && !Object.keys(x.value).length)) assert.ok(x.basis.length > 0, `${n} has a receipt`);
      for (const id of x.basis) assert.ok(steps.has(id), `${n}: ${id} is a step of this session`);
    }
    assert.deepEqual(f.facts.git_commits.basis.map((id) => steps.get(id).facts.command), [COMMANDS[0]]);
  }
});

test('facts: what an agent\'s logs don\'t carry says "not recorded", never 0', () => {
  const cc = factsOf(keyOf('claude-code', ID.claude));
  const cx = factsOf(keyOf('codex', ID.codex));
  const bare = factsOf(keyOf('codex', ID.bare));
  const nr = (f) => FACT_NAMES.filter((n) => f.facts[n].how === 'not-recorded');
  assert.deepEqual(nr(cc), ['bash_would_prompt_count']);
  assert.deepEqual(nr(cx), ['uses_web_search', 'uses_web_fetch', 'bash_would_prompt_count']);
  assert.deepEqual(nr(bare), ['input_tokens', 'output_tokens', 'uses_web_search', 'uses_web_fetch', 'bash_would_prompt_count']);
  for (const f of [cc, cx, bare]) for (const n of nr(f)) assert.equal(f.facts[n].value, null, `${n} has no value`);
  // Totals: a fact no session records stays not recorded; a partly known one says for how many.
  const t = windowTotals([cc, cx, bare]);
  assert.deepEqual(t.codex.facts.bash_would_prompt_count, { value: null, how: 'not-recorded', known: 0, basis: [] });
  assert.deepEqual(t.codex.facts.input_tokens, { value: 200, how: 'derived', known: 1, basis: [cx.key] });
  assert.equal(t.all.facts.uses_web_search.known, 1);
  assert.equal(t.all.facts.git_commits.value, 3);
  assert.equal(t.all.facts.destructive_command_count.how, 'inferred');
  assert.equal(t.all.sessions, 3);
  const c = coverage([cc, cx, bare]);
  assert.deepEqual([c.codex.sessions, c.codex.facts.input_tokens, c.codex.facts.uses_web_fetch, c['claude-code'].facts.uses_web_fetch], [2, 1, 0, 1]);
});

test('a codex exec run, like the button\'s own, never counts as the person\'s prompts', async () => {
  const judge = h.sessions.find((s) => s.tool === 'codex' && h.codexIds.get(s.key) === ID.judge);
  assert.ok(judge, 'the exec run is read');
  assert.equal(h.events.filter((e) => e.session === judge.key && e.kind === 'prompt').length, 0, 'no prompt events');
  assert.equal(factsOf(judge.key).facts.user_message_count.value, 0);
  assert.equal(h.events.find((e) => e.session === judge.key && e.kind === 'session').facts.started, 'exec');
  // The prompt readers skip it too.
  const scanned = await scanPromptSources({ config: mw.config, weekStart: new Date('2024-06-10T00:00:00Z'), weekEnd: new Date('2024-06-17T00:00:00Z'), roots: { 'claude-code': join(mw.root, 'claude'), codex: join(mw.root, 'codex') }, now: new Date('2024-06-17T00:00:00Z') });
  assert.ok(scanned.prompts.length >= 4, "the person's own prompts are read");
  assert.ok(!scanned.prompts.some((p) => String(p.text ?? '').includes('You are reading one recorded Codex coding session')), "the exec run's prompt is not");
});

// ---- the judge's answer --------------------------------------------------------------------


test('an answer is the facet fields exactly; anything else is malformed', () => {
  assert.deepEqual(FACET_FIELDS.slice().sort(), Object.keys(GOOD).sort());
  assert.deepEqual(parseAnswer(JSON.stringify(GOOD)), GOOD);
  assert.deepEqual(parseAnswer(`\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``), GOOD);
  assert.deepEqual(parseAnswer(JSON.stringify({ ...GOOD, extra: 'dropped' })), GOOD, 'another key is dropped');
  for (const bad of ['', 'not json', '[1,2]', `Here you go: ${JSON.stringify(GOOD)}`, JSON.stringify({ ...GOOD, outcome: 3 }), JSON.stringify({ ...GOOD, outcome: 'maybe' }), JSON.stringify({ ...GOOD, claude_helpfulness: 'great' }), JSON.stringify({ ...GOOD, friction_counts: { x: -1 } }), JSON.stringify({ ...GOOD, goal_categories: { x: 1.5 } }), JSON.stringify((({ brief_summary, ...rest }) => rest)(GOOD)), `{${'"a":1,'.repeat(20000)}"b":2}`]) {
    assert.equal(parseAnswer(bad), null, bad.slice(0, 60));
  }
  assert.equal(facetsOf(null), null);
  // Every field the prompt asks for is one of the facet fields.
  for (const f of FACET_FIELDS) assert.match(JUDGE_PROMPT, new RegExp(`- ${f}:`));
});

// ---- the Run with Codex button: a fake codex -----------------------------------------------

/** A fake codex: logs its arguments, standard input and environment names, then answers by
 *  FAKE_MODES (one per call). Its settings sit in fake.json beside it: codex gets only a short
 *  list of environment variables, so the fake can't read them from there. */
function fakeCodex(name, settings) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fake.json'), JSON.stringify(settings));
  writeFileSync(join(dir, 'fake-codex.mjs'), `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const e = JSON.parse(readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const n = existsSync(e.FAKE_COUNT) ? Number(readFileSync(e.FAKE_COUNT, 'utf8')) : 0;
  writeFileSync(e.FAKE_COUNT, String(n + 1));
  appendFileSync(e.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input, env: Object.keys(process.env), pid: process.pid }) + '\\n');
  const modes = String(e.FAKE_MODES || 'good').split(',');
  const mode = modes[n % modes.length];
  const good = ${JSON.stringify(JSON.stringify({ ...GOOD, friction_detail: `${NAME} pasted ${SECRETS.github} into the ${TERM} chat.`, brief_summary: `Worked on ${PRIVATE} and ${OTHER_TERM}.`, friction_counts: { [`${TERM} confusion`]: 2 } }))};
  setTimeout(() => {
    if (mode === 'bad') process.stdout.write('I could not decide.');
    else if (mode === 'fail') process.exit(5);
    else process.stdout.write(good);
    appendFileSync(e.FAKE_LOG, 'finished\\n');
    process.exit(0);
  }, mode === 'slow' ? 20000 : 0);
});
`);
  if (WIN) writeFileSync(join(dir, 'codex.cmd'), `@"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
  else {
    writeFileSync(join(dir, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-codex.mjs')}" "$@"\n`);
    chmodSync(join(dir, 'codex'), 0o755);
  }
  return dir;
}
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SystemRoot|SYSTEMROOT|ComSpec|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|HOME|USERPROFILE)$/i.test(k)));
/** Include /insights, on: a run starts only while it is. */
const ON = () => true;
const logOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : []);
async function settle(judge) {
  for (let i = 0; i < 400 && judge.info().run.state === 'running'; i++) await sleep(50);
  return judge.info().run;
}
/** The window's Codex work, as the page hands it to a run. */
const work = (sessions) => {
  const redactor = createRedactor(mw.config);
  const redact = (s) => redactor.redact(String(s));
  return { redact, sessions };
};

test('a run judges each waiting Codex session once, sends redacted text on stdin with fixed arguments, and keeps redacted answers beside the config', async () => {
  const log = join(scratch, 'good.log');
  const bin = fakeCodex('bin-good', { FAKE_LOG: log, FAKE_COUNT: join(scratch, 'good.count'), FAKE_MODES: 'good,bad' });
  const cfgDir = join(scratch, 'cfg-good');
  mkdirSync(cfgDir, { recursive: true });
  // A token this process holds never reaches codex.
  const env = { ...baseEnv(), PATH: bin, HW_SECRET_TOKEN: SECRETS.apiKey };
  const d = createViewData({ config: mw.config, roots: mw.roots, ...WINDOW, buildHistory: async (o) => buildWorkHistory({ ...o, git: false }) });
  await d.start();
  const w2 = d.codexWork();
  // Only the person's own Codex sessions in configured repos: not the exec run, not Claude Code.
  assert.deepEqual(w2.sessions.map((s) => s.id).sort(), [ID.codex, ID.bare].sort());
  const sent = w2.sessions.find((s) => s.id === ID.codex).text;
  assert.ok(!sent.includes(PRIVATE) && !sent.includes(SECRETS.github), 'what codex reads is redacted');
  assert.match(sent, /^Person: Fix the \[redacted:/);
  const judge = createCodexJudge({ configDir: cfgDir, isOn: ON, env });
  const started = await judge.run(w2);
  assert.deepEqual([started.status, started.body.run.state, started.body.run.queued], [200, 'running', 2]);
  const r = await settle(judge);
  assert.deepEqual([r.state, r.judged, r.malformed, r.failed], ['done', 1, 1, 0], 'one judged, one malformed and skipped');
  const calls = logOf(log);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.deepEqual(c.argv, [...CODEX_ARGS, join(cfgDir, JUDGE_DIR, 'work'), '-'], 'the fixed arguments and the empty work folder');
    assert.ok(c.input.startsWith(JUDGE_PROMPT), 'the fixed prompt first');
    for (const word of [PRIVATE, SECRETS.github]) assert.ok(!c.input.includes(word), `${word} never reaches codex`);
    assert.ok(!c.env.includes('HW_SECRET_TOKEN'), 'only the environment codex needs');
    assert.ok(c.env.some((k) => k.toUpperCase() === 'PATH'), 'codex still gets its PATH');
  }
  // Kept beside the config, git-ignored, and redacted before it was written.
  const dir = join(cfgDir, JUDGE_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const kept = readFileSync(join(dir, files[0]), 'utf8');
  for (const word of [PRIVATE, SECRETS.github]) assert.ok(!kept.includes(word), `${word} is not on disk`);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '*\n');
  assert.match(readFileSync(join(cfgDir, '.gitignore'), 'utf8'), new RegExp(`^${JUDGE_DIR}/$`, 'm'));
  // The next run asks only about the one still waiting; once all are judged it says so.
  const again = await judge.run(w2);
  assert.equal(again.body.run.queued, 1);
  await settle(judge);
  const third = await judge.run(w2);
  assert.deepEqual([third.status, third.body.error], [409, 'nothing']);
  assert.equal(readJudgments(dir, w2.sessions).judged, 2);
});

test('a run judges at most its cap and says how many wait; a slow codex is stopped on time with everything it started', async () => {
  const bin = fakeCodex('bin-cap', { FAKE_LOG: join(scratch, 'cap.log'), FAKE_COUNT: join(scratch, 'cap.count') });
  const cfgDir = join(scratch, 'cfg-cap');
  const env = { ...baseEnv(), PATH: bin };
  const sessions = [ID.codex, ID.bare].map((id, i) => ({ key: `k${i}`, id, text: 'Person: hello' }));
  const judge = createCodexJudge({ configDir: cfgDir, isOn: ON, env, cap: 1 });
  assert.equal((await judge.run(work(sessions))).body.run.left, 1);
  const r = await settle(judge);
  assert.deepEqual([r.judged, r.left, r.cap], [1, 1, 1]);
  // Slow: the run's own limit stops it, and the codex it started never finishes. The limit, like
  // the one below, leaves the fake time to start on a busy Windows runner.
  const slowLog = join(scratch, 'slow.log');
  const slow = createCodexJudge({ configDir: join(scratch, 'cfg-slow'), isOn: ON, env: { ...env, PATH: fakeCodex('bin-slow', { FAKE_LOG: slowLog, FAKE_COUNT: join(scratch, 'slow.count'), FAKE_MODES: 'slow' }) }, timeoutMs: 3000 });
  assert.equal((await slow.run(work(sessions))).status, 200);
  assert.equal((await settle(slow)).state, 'timeout');
  assert.ok(existsSync(slowLog), 'the fake codex started');
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pid = logOf(slowLog)[0].pid;
  for (let i = 0; i < 300 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false, 'the fake codex was stopped');
  assert.ok(!readFileSync(slowLog, 'utf8').includes('finished'), 'it was stopped before it answered');
  // One session over its own limit fails, and the run goes on. On a busy Windows runner the quick
  // fake once took longer than 700 ms to start; 3 s is still far short of the slow one's 20.
  const one = createCodexJudge({ configDir: join(scratch, 'cfg-one'), isOn: ON, env: { ...env, PATH: fakeCodex('bin-one', { FAKE_LOG: join(scratch, 'one.log'), FAKE_COUNT: join(scratch, 'one.count'), FAKE_MODES: 'slow,good' }) }, sessionTimeoutMs: 3000 });
  await one.run(work(sessions));
  const o = await settle(one);
  assert.deepEqual([o.state, o.failed, o.judged], ['done', 1, 1]);
});

test('the run refuses the demo, a missing codex, a missing config and a week still loading; a failing codex counts as failed', async () => {
  const sessions = [{ key: 'k', id: ID.codex, text: 'Person: hello' }];
  const demo = createCodexJudge({ configDir: join(scratch, 'cfg-demo'), isOn: ON, demo: true, env: baseEnv() });
  assert.deepEqual([(await demo.run(work(sessions))).body.error, demo.info().codex], ['demo', null]);
  const none = createCodexJudge({ configDir: join(scratch, 'cfg-none'), isOn: ON, env: { ...baseEnv(), PATH: join(scratch, 'empty-bin') } });
  assert.deepEqual([(await none.run(work(sessions))).body.error, none.info().codex], ['no-codex', false]);
  const bin = fakeCodex('bin-refuse', { FAKE_LOG: join(scratch, 'refuse.log'), FAKE_COUNT: join(scratch, 'refuse.count'), FAKE_MODES: 'fail' });
  const env = { ...baseEnv(), PATH: bin };
  const noCfg = createCodexJudge({ configDir: () => null, isOn: ON, env });
  assert.equal((await noCfg.run(work(sessions))).body.error, 'no-config');
  const loading = createCodexJudge({ configDir: join(scratch, 'cfg-load'), isOn: ON, env });
  assert.equal((await loading.run(null)).status, 503);
  // Include /insights off, or no switch given at all: refused before anything else is looked at.
  for (const isOn of [() => false, undefined]) {
    const off = createCodexJudge({ configDir: join(scratch, 'cfg-off'), isOn, env });
    const r = await off.run(work(sessions));
    assert.deepEqual([r.status, r.body.error, r.body.run.state], [409, 'off', 'idle']);
    assert.match(r.body.message, /Include \/insights is off/);
  }
  assert.equal(existsSync(join(scratch, 'cfg-off')), false, 'an off run made no results folder');
  assert.equal(existsSync(join(scratch, 'refuse.log')), false, 'nothing refused started codex');
  // A relative PATH folder is passed over, so a codex in the current folder is never run.
  assert.equal(findOnPath('codex', { ...env, PATH: 'relative-bin' }), null);
  const failing = createCodexJudge({ configDir: join(scratch, 'cfg-fail'), isOn: ON, env });
  await failing.run(work(sessions));
  const r = await settle(failing);
  assert.deepEqual([r.state, r.failed, r.judged], ['done', 1, 0]);
  assert.equal(existsSync(join(scratch, 'cfg-fail', JUDGE_DIR, `${ID.codex}.json`)), false);
});

// ---- the page: byte-identical with the toggle off, redacted with the switch off and on ------

test('with the toggle off, every answer honestweek already gave is the same bytes, stored Codex judgments and all', async () => {
  // If this ever fails, the message says what the fixture week's build held at the time.
  assert.ok(viewCodex.length >= 2, `the fixture week has Codex sessions to judge (build ${seedView.status().state}, ${viewCodex.length} found)`);
  assert.ok(!viewCodex.some((s) => s.id === IDS.exec), 'the exec run is never judged');
  const thread = (await ask(plain, '/api/replay', { session: vw.keys.featured })).body.thread?.id ?? '';
  for (const [path, q] of [['/api/home', {}], ['/api/problems', {}], ['/api/problems', { summary: '1' }], ['/api/replay', { session: vw.keys.featured }], ['/api/replay', { thread }], ['/api/search', { q: 'lantern' }], ['/api/goal', {}]]) {
    // A search's id is random to each run, so it's the one field left out.
    const bytes = async (d) => JSON.stringify(await ask(d, path, q), (k, v) => (k === 'queryId' ? undefined : v));
    assert.equal(await bytes(off), await bytes(plain), `${path} ${JSON.stringify(q)}`);
  }
  const a = (await ask(off, '/api/insights')).body;
  assert.deepEqual([a.on, a.data, 'codex' in a], [false, null, false], 'off: no Codex part at all');
  // The history serializes as before: the Codex ids it now holds aren't enumerable.
  const hh = await buildWorkHistory({ config: vw.config, roots: vw.roots, ...VWIN, scope: 'all', git: false });
  assert.ok(hh.codexIds instanceof Map && hh.codexIds.size > 0);
  assert.ok(!JSON.stringify(hh).includes('codexIds'));
  // On: Problems is still the same bytes; the Codex group is its own part of /api/insights.
  const p = await ask(on, '/api/problems');
  assert.equal(JSON.stringify({ ...p, body: { ...p.body, view: { ...p.body.view, privateState: 'idle' } } }), JSON.stringify(await ask(plain, '/api/problems')));
});

test('on, the Codex group shows each judged session once, tied to the whole session, redacted with the switch off and on', async () => {
  const a = (await ask(on, '/api/insights')).body;
  assert.equal(a.codex.data.judged, viewCodex.length);
  assert.deepEqual(a.codex.data.items.map((it) => it.session).sort(), viewCodex.map((s) => s.key).sort());
  assert.equal(a.codex.data.items[0].outcome, 'fully_achieved');
  assert.ok(a.codex.data.items.every((it) => it.thread && !('steps' in it)), 'whole sessions, never steps');
  const offText = JSON.stringify(a.codex);
  for (const word of [TERM, SECRETS.apiKey]) assert.ok(!offText.includes(word), `off: ${word} hidden`);
  const onText = JSON.stringify((await ask(on, '/api/insights', { private: '1' })).body.codex);
  assert.ok(onText.includes(TERM), 'on: a private word shows on this screen');
  assert.ok(!onText.includes(SECRETS.apiKey), 'on: a secret stays hidden');
  assert.equal((await ask(on, '/api/insights', { session: vw.keys.featured })).body.codex.data.items.length, 0, 'a Claude Code session has none');
});

test('/api/facts: per session and for the window, strings redacted with the switch off, private words only with it on', async () => {
  const a = (await ask(on, '/api/facts')).body;
  assert.ok(a.sessions.length > 0 && a.totals.codex.sessions > 0 && a.totals['claude-code'].sessions > 0);
  const featured = a.sessions.find((s) => s.key === vw.keys.featured);
  assert.equal(featured.agent, 'claude-code');
  assert.equal(featured.facts.bash_would_prompt_count.how, 'not-recorded');
  const offText = JSON.stringify(a);
  for (const word of [TERM, NAME, SECRETS.github, SECRETS.apiKey]) assert.ok(!offText.includes(word), `off: ${word} hidden`);
  const onText = JSON.stringify((await ask(on, '/api/facts', { private: '1' })).body);
  assert.ok(onText.includes(TERM), 'on: the private term shows in a first prompt');
  for (const s of Object.values(SECRETS)) assert.ok(!onText.includes(s), 'on: secrets stay hidden');
  // One thread, and malformed ids.
  const thread = (await ask(plain, '/api/replay', { session: vw.keys.featured })).body.thread.id;
  assert.ok((await ask(on, '/api/facts', { thread })).body.sessions.every((s) => s.thread === thread));
  assert.equal((await ask(on, '/api/facts', { session: '../x' })).status, 400);
  // The facts never change the Problems answer: plain has the route too, and its answer is the same.
  assert.equal(JSON.stringify((await ask(plain, '/api/facts')).body.totals), JSON.stringify(a.totals));
});

// ---- the server: the button's safety ---------------------------------------------------------

function call(port, { method = 'GET', path, key, body = null, host = `127.0.0.1:${port}`, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, setHost: false, agent: false, headers: { host, ...(key ? { [KEY_HEADER]: key } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {}
        resolve({ status: res.statusCode, json, text: t });
      });
    });
    req.on('error', reject);
    // A request the server never answers fails the test instead of holding it open.
    req.setTimeout(30e3, () => req.destroy(new Error(`no answer to ${method} ${path} in 30 s`)));
    if (body !== null) req.write(body);
    req.end();
  });
}
const gitDir = (() => {
  const git = findOnPath('git', process.env);
  return git ? dirname(git) : null;
})();

test('Run with Codex needs the key, takes POST only, refuses other hosts and sites, runs once at a time, and passes nothing from the request on', async (t) => {
  if (!gitDir) return t.skip('git is not on the PATH');
  if (findOnPath('codex', { ...process.env, PATH: gitDir })) return t.skip('codex sits in the same folder as git here, so the fake one cannot stand alone');
  const log = join(scratch, 'server.log');
  const bin = fakeCodex('bin-server', { FAKE_LOG: log, FAKE_COUNT: join(scratch, 'server.count'), FAKE_MODES: 'good,bad' });
  const cwd = join(scratch, 'server');
  mkdirSync(cwd, { recursive: true });
  const cfg = { identity: { authorEmails: [ME] }, week: { startsOn: 'monday', timezone: 'UTC' }, repos: vw.config.repos.map((r) => ({ path: r.resolvedPath ?? r.path, label: r.label, role: r.role })), redaction: { names: [NAME], terms: [TERM, OTHER_TERM] }, insights: true };
  writeFileSync(join(cwd, 'honestweek.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  const env = { ...baseEnv(), PATH: `${bin}${SEP}${gitDir}`, CLAUDE_CONFIG_DIR: dirname(vw.roots.claude[0]), CODEX_HOME: dirname(vw.roots.codex[0]) };
  let handle = null;
  const err = [];
  const code = await runView({ argv: ['--no-open', '--from', WEEK.from, '--to', WEEK.to], cwd, env, io: { out: () => {}, err: (s) => err.push(s) }, input: null, block: false, now: () => NOW, onServe: (x) => (handle = x) });
  assert.equal(code, 0, err.join(''));
  running.push(handle);
  const port = handle.port;
  const c = /#c=([0-9a-f]+)/.exec(handle.address('printed'))[1];
  const key = (await call(port, { path: '/api/claim', headers: { [CODE_HEADER]: c } })).json.key;
  for (let i = 0; i < 600; i++) {
    // The whole week, not just its newest day, which loads first.
    const st = (await call(port, { path: '/api/status', key })).json;
    if (st.state !== 'building' && !st.window?.partial) break;
    await sleep(50);
  }
  const path = '/api/insights/codex-run';
  const post = (more = {}) => call(port, { method: 'POST', path, key, body: '{"args":["--dangerously-bypass-approvals-and-sandbox"],"env":{"HW_EVIL":"1"}}', ...more });
  assert.equal((await post({ key: null })).status, 403, 'no key');
  assert.equal((await post({ key: 'f'.repeat(64) })).status, 403, 'a wrong key');
  assert.equal((await call(port, { path, key })).status, 405, 'GET');
  assert.equal((await post({ host: 'example.com' })).status, 403, 'another host');
  assert.equal((await post({ headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'another site');
  assert.equal((await post({ body: 'x'.repeat(8192) })).status, 413, 'too large');
  assert.equal(existsSync(log), false, 'no refused request started codex');
  // With Include /insights off, a request with the key is refused too, then works once it's back on.
  const toggle = (on) => call(port, { method: 'POST', path: '/api/insights/toggle', key, body: JSON.stringify({ on }) });
  assert.equal((await toggle(false)).status, 200);
  const offRun = await post();
  assert.deepEqual([offRun.status, offRun.json.error], [409, 'off']);
  assert.equal(existsSync(log), false, 'codex did not start while the toggle was off');
  assert.equal((await toggle(true)).status, 200);

  const info = (await call(port, { path: '/api/insights', key })).json;
  assert.deepEqual([info.on, info.codex.codex, info.codex.run.state], [true, true, 'idle']);
  const first = await post();
  assert.deepEqual([first.status, first.json.run.state], [200, 'running']);
  const second = await post();
  assert.deepEqual([second.status, second.json.error], [409, 'running'], 'one run at a time');
  let a;
  for (let i = 0; i < 400; i++) {
    a = (await call(port, { path: '/api/insights', key })).json;
    if (a.codex.run.state !== 'running') break;
    await sleep(50);
  }
  assert.equal(a.codex.run.state, 'done');
  const calls = logOf(log);
  assert.ok(calls.length >= 2);
  for (const x of calls) {
    assert.deepEqual(x.argv, [...CODEX_ARGS, join(cwd, JUDGE_DIR, 'work'), '-'], 'nothing from the request on the command line');
    assert.ok(!x.env.some((k) => /^HW_EVIL$/i.test(k)), 'nothing from the request in the environment');
  }
  assert.equal(a.codex.run.malformed, Math.floor(calls.length / 2), 'every other answer is malformed, and skipped');
  assert.equal(a.codex.data.items.length, a.codex.run.judged);
  assert.ok(!JSON.stringify(a.codex).includes(TERM) && !JSON.stringify(a.codex).includes(SECRETS.github));
  // Nothing landed under the agents' own folders.
  for (const root of [dirname(vw.roots.claude[0]), dirname(vw.roots.codex[0])]) assert.ok(!readdirSync(root).includes(JUDGE_DIR));
  assert.equal((await call(port, { path: '/api/problems?summary=1', key })).status, 200);
});

test('Run with Codex judges only Codex sessions a person started, not a child or guardian thread standing alone', async () => {
  const week = madeUpWeek('agent-started');
  const day = join(week.root, 'codex', 'sessions', '2024', '06', '12');
  const more = { child: '0190d000-0000-7000-8000-0000000000d1', orphan: '0190d000-0000-7000-8000-0000000000d2', guardian: '0190d000-0000-7000-8000-0000000000d3' };
  const spawned = (parent) => ({ source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: 'helper', agent_nickname: 'helper' } } } });
  // A child of the person's session joins it; one whose parent isn't here, and a guardian, stand alone.
  writeRows(join(day, `rollout-2024-06-12T13-00-00-${more.child}.jsonl`), codexRows(week.project, more.child, { extraMeta: spawned(ID.codex) }));
  writeRows(join(day, `rollout-2024-06-12T14-00-00-${more.orphan}.jsonl`), codexRows(week.project, more.orphan, { extraMeta: spawned('0190d000-0000-7000-8000-0000000000ff') }));
  writeRows(join(day, `rollout-2024-06-12T15-00-00-${more.guardian}.jsonl`), codexRows(week.project, more.guardian, { extraMeta: { source: { subagent: { other: 'guardian' } } } }));
  const d = createViewData({ config: week.config, roots: week.roots, ...WINDOW, buildHistory: async (o) => buildWorkHistory({ ...o, git: false }) });
  await d.start();
  assert.deepEqual(d.codexWork().sessions.map((s) => s.id).sort(), [ID.codex, ID.bare].sort());
});
