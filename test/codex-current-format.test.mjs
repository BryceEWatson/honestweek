// Codex's log format since August 2026: each step is a small program run through the `exec`
// tool, and the harness records each command it ran and each file it changed. These tests
// build small made-up rollouts in that format and check the engine reads commands, edits and
// results from them, with each step saying how it's known; that the older format still reads
// exactly as before; and that "no hook record" no longer helps a Codex finding reach derived.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { fileChangePatch, itemCommand, programOutcome, readExecProgram } from '../lib/replay/codex-program.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { buildDemoWeek, WEEK } from '../tools/demo-week.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const ME = 'you@example.com';
const T0 = Date.parse('2024-06-12T10:00:00.000Z');
const T = (s) => new Date(T0 + s * 1000).toISOString();
const BUILT = Date.parse('2024-06-20T00:00:00.000Z');
const SECRET = 'DOCS_TOKEN=sandbox-EXAMPLE-4Hq8Zt2Wm6Ry9Kp3Vn5c';
const ID = {
  main: '0190b000-0000-7000-8000-0000000000a1',
  child: '0190b000-0000-7000-8000-0000000000a2',
  exec: '0190b000-0000-7000-8000-0000000000a3',
  busy: '0190b000-0000-7000-8000-0000000000a4',
  fork: '0190b000-0000-7000-8000-0000000000a5',
  old: '0190b000-0000-7000-8000-0000000000a6',
  shown: '0190b000-0000-7000-8000-0000000000a7',
};

const rec = (s, type, payload) => ({ timestamp: T(s), type, payload });
const meta = (s, id, cwd, extra = {}) => rec(s, 'session_meta', { id, timestamp: T(s), cwd, originator: 'codex_vscode', cli_version: '0.159.2', source: 'vscode', ...extra });
const prompt = (s, text) => rec(s, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const say = (s, text) => rec(s, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const turnEnd = (s) => rec(s, 'event_msg', { type: 'task_complete', duration_ms: 1000 });
const program = (s, id, input) => rec(s, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: id, name: 'exec', input });
const out = (s, id, status, ...printed) => rec(s, 'response_item', { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: `Script ${status}\nWall time 0.4 seconds\nOutput:\n` }, ...printed.map((text) => ({ type: 'input_text', text }))] });
const fn = (s, id, name, args) => rec(s, 'response_item', { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) });
const fnOut = (s, id, output) => rec(s, 'response_item', { type: 'function_call_output', call_id: id, output });
let n = 0;
const cmdItem = (s, cwd, cmd, exit, output = '') => rec(s, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: `exec-${++n}`, command: ['/bin/bash', '-lc', cmd], cwd, parsed_cmd: [{ type: 'unknown', cmd }], source: 'unified_exec_startup', status: exit === 0 ? 'completed' : 'failed', exit_code: exit, aggregated_output: output }, started_at_ms: T0 + s * 1000 - 300, completed_at_ms: T0 + s * 1000 });
const fileItem = (s, changes, status = 'completed') => rec(s, 'event_msg', { type: 'item_completed', item: { type: 'FileChange', id: `exec-${++n}`, changes, status, stdout: '', stderr: '' }, started_at_ms: T0 + s * 1000 - 50, completed_at_ms: T0 + s * 1000 });
const patchText = (file, from, to) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-${from}\n+${to}\n*** End Patch\n`;
const tap = (pass, fail) => `TAP version 13\n# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n`;
const run = (cmd, cwd) => `await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, workdir: ${JSON.stringify(cwd)} })`;

function write(root, id, day, rows) {
  const dir = join(root, 'codex', 'sessions', '2024', '06', day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2024-06-${day}T10-00-00-${id}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** The made-up week: an interactive session, its child thread, a `codex exec` run with no
 *  item records (as the 0.144 command line writes), a session with programs running at once
 *  and a command left running in the background, a fork, an older-format session, and one in
 *  a display-only repository. */
function rollouts(root) {
  const project = join(root, 'your-project');
  const shown = join(root, 'display-repo');
  for (const d of [project, shown]) mkdirSync(join(d, 'src'), { recursive: true });
  const abs = (f) => `${project}/${f}`;

  write(root, ID.main, '12', [
    meta(0, ID.main, project),
    // Turn 1: an edit inside a program, then a done claim with nothing after it.
    prompt(1, 'Make src/app.mjs export 2 instead of 1.'),
    program(2, 'p1', `const patch = ${JSON.stringify(patchText('src/app.mjs', 'export const a = 1;', 'export const a = 2;'))};\ntext(await tools.apply_patch(patch));`),
    fileItem(3, { [abs('src/app.mjs')]: { type: 'update', unified_diff: '@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n', move_path: null } }),
    out(4, 'p1', 'completed', '{}'),
    say(5, 'Done.'),
    turnEnd(6),
    // Turn 2: three commands in one program, the second failing its tests; a patch that fails.
    prompt(10, 'Run lint, the tests and the build.'),
    program(11, 'p2', `const a = ${run('npm run lint', project)};\ntext(a.output);\nconst b = ${run('node --test', project)};\ntext(b.output);\nconst c = ${run(`${SECRET} npm run build`, project)};\ntext(c.output);`),
    cmdItem(12, project, 'npm run lint', 0, 'clean\n'),
    cmdItem(13, project, 'node --test', 1, tap(3, 1)),
    cmdItem(14, project, `${SECRET} npm run build`, 2, 'build failed\n'),
    out(15, 'p2', 'completed', 'clean\n', tap(3, 1), 'build failed\n'),
    program(16, 'p3', `text(await tools.apply_patch(${JSON.stringify(patchText('src/missing.mjs', 'x', 'y'))}));`),
    out(17, 'p3', 'failed', 'Script error: apply_patch verification failed: Failed to find expected lines in src/missing.mjs'),
    fn(18, 's1', 'spawn_agent', { message: 'Write one fixture file.', agent_type: 'worker' }),
    fnOut(19, 's1', JSON.stringify({ task_name: '/root/helper', nickname: 'Helper' })),
    say(25, 'The tests fail in one case and the build fails.'),
    turnEnd(26),
    // Turn 3: an edit, then a passing test run, then a done claim: checked, so no finding.
    prompt(30, 'Fix the failing test.'),
    program(31, 'p4', `const patch = ${JSON.stringify(patchText('test/app.test.mjs', 'assert.equal(a, 1);', 'assert.equal(a, 2);'))};\ntext(await tools.apply_patch(patch));`),
    fileItem(32, { [abs('test/app.test.mjs')]: { type: 'update', unified_diff: '@@ -3,1 +3,1 @@\n-assert.equal(a, 1);\n+assert.equal(a, 2);\n', move_path: null } }),
    out(33, 'p4', 'completed', '{}'),
    program(34, 'p5', `text((${run('node --test', project)}).output);`),
    cmdItem(35, project, 'node --test', 0, tap(4, 0)),
    out(36, 'p5', 'completed', tap(4, 0)),
    say(37, 'Done.'),
    turnEnd(38),
    // Turn 4: a program with no recorded result (the file ends first).
    prompt(40, 'Start the dev server.'),
    program(41, 'p6', `const r = ${run('npm run dev', project)};\ntext(r.output);`),
  ]);

  write(root, ID.child, '12', [
    meta(20, ID.child, project, { source: { subagent: { thread_spawn: { parent_thread_id: ID.main, depth: 1, agent_path: '/root/helper', agent_nickname: 'Helper' } } } }),
    prompt(20.5, 'Write one fixture file.'),
    program(21, 'c1', `text((${run('ls test/fixtures', project)}).output);`),
    cmdItem(22, project, 'ls test/fixtures', 0, 'a.txt\n'),
    out(23, 'c1', 'completed', 'a.txt\n'),
    say(24, 'Wrote test/fixtures/b.txt.'),
  ]);

  // A `codex exec` run on the 0.144 command line: no item records, so every step is read from
  // the programs' text, with exit codes only where the program printed them.
  write(root, ID.exec, '13', [
    meta(0, ID.exec, project, { originator: 'codex_exec', source: 'exec', cli_version: '0.144.6' }),
    prompt(1, 'Check the suite and summarize what changed.'),
    program(2, 'q1', `text(${run('node --test', project)});`),
    out(3, 'q1', 'completed', JSON.stringify({ chunk_id: 'a1', wall_time_seconds: 0.5, exit_code: 1, original_token_count: 9, output: tap(2, 1) })),
    program(4, 'q2', `const r1 = ${run('git status --short', project)};\nconst r2 = ${run('git diff --stat', project)};\ntext(JSON.stringify([{ cmd: "git status --short", result: r1 }, { cmd: "git diff --stat", result: r2 }]));`),
    out(5, 'q2', 'completed', JSON.stringify([{ cmd: 'git status --short', result: { exit_code: 0, output: ' M src/app.mjs\n' } }, { cmd: 'git diff --stat', result: { exit_code: 0, output: ' 1 file changed\n' } }])),
    program(6, 'q3', `for (const c of ["npm run a", "npm run b"]) text((${run('npm run x', project).replace('"npm run x"', 'c')}).output);`),
    out(7, 'q3', 'completed', 'a\n', 'b\n'),
    program(8, 'q4', `const patch = ${JSON.stringify(patchText('src/notes.mjs', 'old', 'new'))};\ntext(await tools.apply_patch(patch));`),
    out(9, 'q4', 'completed', '{}'),
    program(9.2, 'q5', `const r = ${run('cat report.json', project)};
text(r.output);`),
    out(9.4, 'q5', 'completed', JSON.stringify({ exit_code: 3, wall_time_seconds: 1, chunk_id: 'x' })),
    program(9.6, 'q6', `text(${run('cat report.json', project)});`),
    out(9.8, 'q6', 'completed', JSON.stringify({ chunk_id: 'q6', wall_time_seconds: 0.1, exit_code: 0, original_token_count: 9, output: JSON.stringify({ exit_code: 3 }) })),
    say(10, 'One test fails; two files changed.'),
  ]);

  // Two programs at once, an item neither names, and a command left running in the background.
  write(root, ID.busy, '14', [
    meta(0, ID.busy, project),
    prompt(1, 'Run the tests and lint together, then start the server.'),
    program(2, 'b1', `text((${run('npm test', project)}).output);`),
    program(3, 'b2', `text((${run('npm run lint', project)}).output);`),
    cmdItem(4, project, 'npm run lint', 0, 'clean\n'),
    cmdItem(5, project, 'echo hi', 0, 'hi\n'),
    out(6, 'b2', 'completed', 'clean\n'),
    out(7, 'b1', 'completed', 'ok\n'),
    program(8, 'b3', `const r = await tools.exec_command({ cmd: "npm run serve", workdir: ${JSON.stringify(project)}, yield_time_ms: 1000 });\ntext(JSON.stringify(r));`),
    out(9, 'b3', 'completed', JSON.stringify({ chunk_id: 'b3', wall_time_seconds: 1, session_id: 7, output: 'listening\n' })),
    // A later program only checks in on it, and is the one open when its record arrives.
    program(29, 'b4', 'text(JSON.stringify(await tools.write_stdin({ session_id: 7, chars: "" })));'),
    cmdItem(30, project, 'npm run serve', 0, 'listening\nstopped\n'),
    out(30.5, 'b4', 'completed', '{"session_id":7,"output":"stopped\\n"}'),
    say(31, 'Tests and lint pass; the server ran and stopped.'),
  ]);

  // A fork: its file opens with a restamped copy of a parent's file change.
  write(root, ID.fork, '15', [
    meta(0, ID.fork, project, { forked_from_id: ID.main }),
    fileItem(0.5, { [abs('src/app.mjs')]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null } }),
    prompt(5, 'Carry on.'),
    say(6, 'Nothing left to do.'),
  ]);

  // The older format: a top-level apply_patch and nothing after it but "Done.".
  write(root, ID.old, '16', [
    meta(0, ID.old, project, { cli_version: '0.1.0' }),
    prompt(1, 'Rename the constant.'),
    rec(2, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'o1', name: 'apply_patch', input: patchText('src/app.mjs', 'export const a = 2;', 'export const b = 2;') }),
    rec(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'o1', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/app.mjs\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) }),
    say(4, 'Done.'),
    turnEnd(5),
  ]);

  // A display-only repository: never read by git, shown as a skeleton.
  write(root, ID.shown, '17', [
    meta(0, ID.shown, shown),
    prompt(1, 'Commit it.'),
    program(2, 'd1', `text((${run('git commit -m "Update notes"', shown)}).output);`),
    cmdItem(3, shown, 'git commit -m "Update notes"', 0, '[main 1a2b3c4] Update notes\n 1 file changed, 1 insertion(+)\n'),
    out(4, 'd1', 'completed', '[main 1a2b3c4] Update notes\n'),
  ]);

  const config = normalizeConfig({ identity: { authorEmails: [ME] }, week: { timezone: 'UTC' }, repos: [{ path: project, label: 'your-project', role: 'featured' }, { path: shown, label: 'shown-only', role: 'display' }] }, { configDir: root });
  return { project, shown, config };
}

async function readWeek(t) {
  const root = makeTempDir('hw-codex-current-');
  t.after(() => removeTempDir(root));
  const { config, project } = rollouts(root);
  const h = await buildWorkHistory({ config, from: '2024-06-10', to: '2024-06-16', timezone: 'UTC', roots: { claude: [join(root, 'claude')], codex: [join(root, 'codex')] }, git: false, usage: true, keepRaw: true });
  const all = await buildWorkHistory({ config, from: '2024-06-10', to: '2024-06-17', timezone: 'UTC', roots: { claude: [join(root, 'claude')], codex: [join(root, 'codex')] }, git: false, scope: 'all' });
  const acts = (history, id) => history.events.filter((e) => e.kind === 'action' && e.source === sourceKey('cx', id));
  return { h, all, acts, project };
}

test('an edit inside a program is a recorded edit with its file and line counts', async (t) => {
  const { h, acts } = await readWeek(t);
  const edit = acts(h, ID.main)[0];
  assert.deepEqual([edit.facts.tool, edit.facts.category, edit.facts.result, edit.evidence], ['apply_patch', 'edit', 'ok', 'recorded']);
  assert.equal(edit.facts.file, 'src/*.mjs');
  assert.deepEqual(edit.derived.patch, { added: 1, removed: 1 });
  // Issued by the program's call, recorded by the harness's file-change record.
  assert.equal(edit.refs.length, 2);
  assert.ok(edit.refs[0].line < edit.refs[1].line);
});

test('several commands in one program: each is a recorded step with its exit code, and a failed one is an error', async (t) => {
  const { h, acts } = await readWeek(t);
  const cmds = acts(h, ID.main).filter((e) => e.facts.category === 'shell');
  assert.deepEqual(cmds.slice(0, 3).map((e) => [e.facts.exitCode, e.facts.result, e.evidence]), [[0, 'ok', 'recorded'], [1, 'error', 'recorded'], [2, 'error', 'recorded']]);
  assert.deepEqual(cmds.slice(0, 2).map((e) => e.facts.command), ['npm run lint', 'node --test']);
  assert.deepEqual([cmds[1].derived.tests.pass, cmds[1].derived.tests.fail], [3, 1]);
  // The pasted token passes the redactor before it reaches the history.
  assert.ok(!JSON.stringify(h.events).includes('4Hq8Zt2Wm6Ry9Kp3Vn5c'));
  assert.match(cmds[2].facts.command, /\[redacted:/);
  // No program is left behind as a step of its own: each was read whole.
  assert.ok(!acts(h, ID.main).some((e) => e.facts.tool === 'exec'));
});

test('a patch the harness refused to apply is a derived edit with an error, and nothing after it in the program ran', async (t) => {
  const { h, acts } = await readWeek(t);
  const failed = acts(h, ID.main).find((e) => e.facts.category === 'edit' && e.facts.result === 'error');
  assert.equal(failed.evidence, 'derived');
  assert.equal(failed.facts.file, 'src/*.mjs');
  assert.equal(failed.derived.patch, undefined, 'a patch that failed adds no lines');
  assert.match(failed._raw.error, /verification failed/);
});

test('a program with no recorded result keeps its step, with the result missing, never guessed', async (t) => {
  const { h, acts } = await readWeek(t);
  const last = acts(h, ID.main).at(-1);
  assert.deepEqual([last.facts.command, last.evidence, last.facts.result, last.end], ['npm run dev', 'derived', undefined, undefined]);
  assert.ok(last.missing.includes('result'));
});

test("a child thread's program steps are its own, and its parent's spawn call is tied to it", async (t) => {
  const { h, acts } = await readWeek(t);
  const step = acts(h, ID.child).find((e) => e.facts.category === 'shell');
  assert.ok(step, 'the child thread is read');
  assert.deepEqual([step.facts.command, step.facts.result, step.evidence], ['ls test/fixtures', 'ok', 'recorded']);
  const spawn = acts(h, ID.main).find((e) => e.facts.category === 'delegate');
  assert.ok(h.links.some((l) => l.type === 'spawned' && l.from === spawn.id && l.to === step.agent), 'the spawn call is tied to the agent that ran the step');
});

test('with no item records, commands and patches are read from the program text as derived steps', async (t) => {
  const { h, acts } = await readWeek(t);
  const steps = acts(h, ID.exec);
  const shell = steps.filter((e) => e.facts.category === 'shell');
  // q1: the program printed the whole result, so the exit code is the command's own.
  assert.deepEqual([shell[0].facts.command, shell[0].facts.exitCode, shell[0].facts.result, shell[0].evidence], ['node --test', 1, 'error', 'derived']);
  assert.equal(shell[0].derived.tests.fail, 1);
  // q2: the program built its own JSON of the results, so its exit codes are its text, not
  // Codex's records: both commands ran (the program completed), and their results stay unknown.
  assert.deepEqual(shell.slice(1, 3).map((e) => [e.facts.command, e.facts.exitCode, e.facts.result]), [['git status --short', undefined, 'recorded'], ['git diff --stat', undefined, 'recorded']]);
  // q5 and q6: a JSON file holding exit_code is never the command's exit code; Codex's own result is.
  const cat = shell.filter((e) => e.facts.command === 'cat report.json');
  assert.deepEqual(cat.map((e) => [e.facts.exitCode, e.facts.result]), [[undefined, 'recorded'], [0, 'ok']]);
  // q3: a loop runs its call an unknown number of times, so the program is shown, not read.
  const loop = steps.find((e) => e.facts.tool === 'exec');
  assert.equal(loop.evidence, 'recorded');
  assert.match(loop.facts.command, /^for \(const c of/);
  assert.ok(!shell.some((e) => e.facts.command === 'npm run x'));
  // q4: a straight program that ran to the end applied its patch.
  const edit = steps.find((e) => e.facts.category === 'edit');
  assert.deepEqual([edit.facts.result, edit.evidence, edit.derived.patch], ['ok', 'derived', { added: 1, removed: 1 }]);
});

test('programs running at once: a record goes to the program that names it; one neither names stands alone', async (t) => {
  const { h, acts } = await readWeek(t);
  const steps = acts(h, ID.busy);
  const lint = steps.find((e) => e.facts.command === 'npm run lint');
  assert.equal(lint.evidence, 'recorded');
  assert.equal(lint.refs.length, 2, 'tied to the program that names it');
  const echo = steps.find((e) => e.facts.command === 'echo hi');
  assert.equal(echo.refs.length, 1, 'tied to no program');
  // The test program can't say which record was its own, so it's kept whole, not read.
  assert.ok(steps.some((e) => e.facts.tool === 'exec' && /npm test/.test(e.facts.command)));
  assert.ok(!steps.some((e) => e.facts.command === 'npm test'));
  // The background command: one step, the harness's record of it, issued by its program.
  const serve = steps.filter((e) => e.facts.command === 'npm run serve');
  assert.deepEqual(serve.map((e) => [e.evidence, e.facts.result, e.refs.length]), [['recorded', 'ok', 2]]);
  // It belongs to the program that started it, not the check-in open when it was recorded.
  const poll = steps.find((e) => e.facts.tool === 'write_stdin');
  assert.equal(poll.evidence, 'derived');
  assert.ok(serve[0].refs[0].line < poll.refs[0].line, 'issued by the program that ran it');
});

test("a fork's copied records aren't its work, and the older format reads as before", async (t) => {
  const { h, acts } = await readWeek(t);
  assert.equal(acts(h, ID.fork).length, 0);
  const old = acts(h, ID.old);
  assert.deepEqual(old.map((e) => [e.facts.tool, e.evidence, e.facts.result, e.facts.exitCode]), [['apply_patch', 'recorded', 'ok', 0]]);
});

test('a display-only session keeps its steps as a skeleton and nominates no commit for git', async (t) => {
  const { all, acts } = await readWeek(t);
  const steps = acts(all, ID.shown);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].facts.command, undefined);
  assert.ok(!steps[0].inferred.some((x) => x.key === 'commitNominated'));
  assert.ok(!JSON.stringify(all.events).includes('Update notes'));
});

test('a done claim with no check after the last edit is found on Codex; one with a passing run after it is not', async (t) => {
  const { h } = await readWeek(t);
  const r = runProblems(h, { builtT: BUILT });
  const found = r.patterns.find((p) => p.id === 'unverified-done-claim').findings.filter((f) => !/pull request/.test(f.note));
  const mainKey = sourceKey('cx', ID.main);
  const inMain = found.filter((f) => f.session === mainKey);
  assert.equal(inMain.length, 1, 'turn 1 is found; turn 3 ran the tests after its edit');
  assert.ok(Date.parse(inMain[0].at) < T0 + 10_000);
  assert.equal(inMain[0].severity, 'look');
});

test('"no hook record" no longer promotes a Codex finding to derived, in either format', async (t) => {
  const { h } = await readWeek(t);
  const r = runProblems(h, { builtT: BUILT });
  const found = r.patterns.find((p) => p.id === 'unverified-done-claim').findings.filter((f) => !/pull request/.test(f.note));
  for (const id of [ID.main, ID.old]) {
    const f = found.find((x) => x.session === sourceKey('cx', id));
    assert.ok(f, `a finding in ${id}`);
    // Nothing ran after the edit and the claim is a flat "Done.", which on Claude Code is derived.
    assert.equal(f.verdictEvidence, 'inferred');
    const leg = f.basis.find((b) => b.part === 'No check after it');
    assert.equal(leg.level, 'inferred');
    assert.match(leg.how, /only file reads and searches\. Codex runs hooks without recording them/);
    assert.equal(f.basis.find((b) => b.part === 'The done claim').level, 'derived');
  }
});

test('the program reader: literals only, straight runs only, and outputs read as recorded', () => {
  const plan = readExecProgram('const p = "x";\nconst r = await tools.exec_command({cmd: \'npm test\', workdir: "/path/to/your/repo"});\ntext(r.output);\ntext(await tools.apply_patch(p));');
  assert.equal(plan.straight, true);
  assert.deepEqual(plan.calls.map((c) => [c.tool, c.arg]), [['exec_command', { cmd: 'npm test', workdir: '/path/to/your/repo' }], ['apply_patch', 'x']]);
  // A name assigned twice, a template with a placeholder, and a spread are not literals.
  assert.equal(readExecProgram('let p = "a"; p = "b"; await tools.apply_patch(p);').calls[0].arg, null);
  assert.equal(readExecProgram('await tools.exec_command({cmd: `npm ${x}`});').calls[0].arg, null);
  assert.equal(readExecProgram('await tools.exec_command({...o, cmd: "a"});').calls[0].arg, null);
  // A name whose literal is only the start of its value, or an object changed after it's declared.
  for (const p of ['const c = "rm -rf " + dir; await tools.exec_command({cmd: c});', 'const c = "npm test".replace("test", "run build"); await tools.exec_command({cmd: c});', 'const o = {cmd: "echo a"}; o.cmd = "echo b"; await tools.exec_command(o);', 'const o = {cmd: "echo a"}; Object.assign(o, x); await tools.exec_command(o);']) {
    assert.equal(readExecProgram(p).calls[0].arg?.cmd, undefined, p);
  }
  assert.equal(readExecProgram('const c = "npm test"\nconst o = {cmd: c}\nawait tools.exec_command(o)').calls[0].arg.cmd, 'npm test');
  for (const p of ['if (x) await tools.exec_command({cmd: "a"});', 'exit(); await tools.exec_command({cmd: "a"});', 'process.exit(0); await tools.exec_command({cmd: "a"});', 'const o = { async f() { await tools.exec_command({cmd: "a"}); } };','b: { await tools.exec_command({cmd: "a"}); break b; await tools.exec_command({cmd: "c"}); }','await Promise.all([tools.exec_command({cmd: "a"})]);', 'try { await tools.exec_command({cmd: "a"}); } catch {}', '[1].map(async () => await tools.exec_command({cmd: "a"}));', 'tools.exec_command({cmd: "a"});']) {
    assert.equal(readExecProgram(p).straight, false, p);
  }
  // A regular expression with a quote in it doesn't throw the reader off.
  assert.equal(readExecProgram('const s = "a".replace(/"/g, ""); await tools.exec_command({cmd: "b"});').calls[0].arg.cmd, 'b');
  assert.equal(readExecProgram('text("no tools here")'), null);
  assert.equal(readExecProgram('await tools.exec_command({cmd: "unclosed'), null);

  const o = programOutcome([{ type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'Script error: exec_command failed: CreateProcess { message: "Rejected(\\"x\\")" }' }]);
  assert.deepEqual([o.status, /^exec_command failed/.test(o.error)], ['failed', true]);
  assert.deepEqual(programOutcome('Script running with cell ID 12\nWall time 10.0 seconds\nOutput:\n').cellId, '12');
  assert.deepEqual(programOutcome([{ text: 'Script completed\nOutput:\n' }, { text: '{"chunk_id":"a","exit_code":3,"output":"x"}' }]).results, [{ exit: 3, output: 'x' }]);
  // JSON the program built, or nested deeper, isn't Codex's result.
  assert.deepEqual(programOutcome([{ text: 'Script completed\nOutput:\n' }, { text: '[{"cmd":"a","result":{"exit_code":3}}]' }, { text: '{"exit_code":3}' }]).results, []);

  assert.equal(itemCommand({ command: ['/bin/bash', '-lc', 'ls -la'], parsed_cmd: [] }), 'ls -la');
  assert.equal(itemCommand({ command: ['pwsh.exe', '-Command', 'Get-ChildItem'], parsed_cmd: [{ type: 'unknown', cmd: 'Get-ChildItem' }] }), 'Get-ChildItem');
  const fc = fileChangePatch({ '/path/to/your/repo/a.txt': { type: 'add', content: 'one\ntwo\n' }, '/path/to/your/repo/b.txt': { type: 'delete', content: 'gone\n' } });
  assert.deepEqual([fc.added, fc.removed, fc.files.map((f) => f.op)], [2, 1, ['add', 'delete']]);
});

test("the demo's file-change records name each file by a native absolute path, as Codex does", (t) => {
  const root = makeTempDir('hw-codex-paths-');
  t.after(() => removeTempDir(root));
  const d = buildDemoWeek({ root: join(root, 'week') });
  const keys = d.files.codex.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"FileChange"')).flatMap((l) => Object.keys(JSON.parse(l).payload.item.changes)));
  assert.ok(keys.length >= 6);
  for (const k of keys) assert.ok(isAbsolute(k) && k === normalize(k), k);
});

// Invariant 6: absent today's format, existing output stays byte-identical. The fixture was
// taken from the engine before it read today's format, on the demo week as it was written then.
test("the demo week's older-format Codex sessions read exactly as before", async (t) => {
  const root = makeTempDir('hw-codex-legacy-');
  t.after(() => removeTempDir(root));
  const d = buildDemoWeek({ root: join(root, 'week'), codexFormat: 'legacy' });
  const h = await buildWorkHistory({ config: d.config, from: WEEK.from, to: WEEK.to, roots: d.roots, usage: true, keepRaw: true, hiddenSessions: 'redacted' });
  const cx = (s) => String(s).startsWith('cx-');
  // Byte offsets, record digests and file keys depend on the folder's path, so they're left out.
  const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (['off', 'len', 'digest', 'fileKey', 'fileKeys'].includes(k) ? undefined : v)).split(d.root).join('<root>').split(d.root.replace(/\\/g, '/')).join('<root>').split(JSON.stringify(d.root).slice(1, -1)).join('<root>'));
  const r = runProblems(h, { builtT: Date.parse('2026-01-01T00:00:00Z') });
  const got = {
    events: norm(h.events.filter((e) => cx(e.source))),
    sessions: h.sessions.filter((s) => cx(s.key)).map(({ key, endState, firstAt, lastAt, tool, agents }) => ({ key, endState, firstAt, lastAt, tool, agents })),
    findings: norm(r.patterns.flatMap((p) => p.findings.filter((f) => cx(f.session)).map((f) => ({ p: p.id, ...f })))),
  };
  const want = JSON.parse(readFileSync(new URL('./fixtures/codex-legacy-demo-reading.json', import.meta.url), 'utf8'));
  assert.equal(got.events.length, 81);
  assert.deepEqual(got, want);
});
