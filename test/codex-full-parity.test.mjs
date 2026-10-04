// Codex parity: the problem checks that run on Claude Code run on Codex too, where Codex logs the
// thing the check reads. Shell commands that only read a file count as file reads for both agents;
// a Codex child thread's hand-back is read from its parent's log; Codex's plan mode is read from
// each turn's settings; and Codex sessions get their titles and branch links. Made-up logs only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { shellFileRead } from '../lib/problems/classify.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { pathKey, sourceKey } from '../lib/replay/ids.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

// ---- shell reads: recognised exactly ------------------------------------------------------

test('a shell command that only reads one file is a file read, with the lines it reads', () => {
  const read = (cmd) => {
    const r = shellFileRead(cmd);
    return r && [r.file, r.range];
  };
  assert.deepEqual(read('cat src/app.mjs'), ['src/app.mjs', '']);
  assert.deepEqual(read('cat -n ./src/app.mjs'), ['src/app.mjs', '']);
  assert.deepEqual(read("sed -n '1,40p' src/app.mjs"), ['src/app.mjs', '1-40']);
  assert.deepEqual(read('sed -n "12p" src/app.mjs'), ['src/app.mjs', '12-12']);
  assert.deepEqual(read("sed -n '1,$p' src/app.mjs"), ['src/app.mjs', '']);
  assert.deepEqual(read('head -n 40 src/app.mjs'), ['src/app.mjs', '1-40']);
  assert.deepEqual(read('head -40 src/app.mjs'), ['src/app.mjs', '1-40']);
  assert.deepEqual(read('head src/app.mjs'), ['src/app.mjs', '1-10']);
  assert.deepEqual(read('tail -n 20 logs/run.log'), ['logs/run.log', 'last:20']);
  assert.deepEqual(read('Get-Content src/app.mjs'), ['src/app.mjs', '']);
  assert.deepEqual(read('Get-Content -Raw -LiteralPath "C:\\work\\your-project\\src\\app.mjs"'), ['C:\\work\\your-project\\src\\app.mjs', '']);
  assert.deepEqual(read('Get-Content -LiteralPath src/[id].mjs -TotalCount 40'), ['src/[id].mjs', '1-40']);
  assert.deepEqual(read('gc src/app.mjs -Tail 5'), ['src/app.mjs', 'last:5']);
  assert.deepEqual(read('Get-Content src/app.mjs | Select-Object -Skip 40 -First 20'), ['src/app.mjs', '41-60']);
  assert.deepEqual(read('Get-Content src/app.mjs | Select-Object -Last 5'), ['src/app.mjs', 'last:5']);
  // The same lines read three ways are one read.
  assert.equal(new Set(["sed -n '1,40p' a.mjs", 'head -n 40 a.mjs', 'Get-Content a.mjs -TotalCount 40'].map((c) => shellFileRead(c).range)).size, 1);
});

test('near misses: a command that mentions a file but does more than read it is not a read', () => {
  for (const cmd of [
    'cat a.mjs b.mjs', // two files
    'cat src/app.mjs > copy.mjs', // writes a file
    'cat src/app.mjs | grep export', // shows only part of it
    'cat src/app.mjs && npm test', // runs something else too
    'cat src/app.mjs; rm src/app.mjs',
    'cat', // no file
    'cat -', // standard input
    'cat <<EOF\nhello\nEOF',
    'cat *.md', // a wildcard
    'cat ~/notes.txt', // the home folder, not this one
    'cat $FILE', // a variable
    'cat "$HOME/notes.txt"',
    'echo cat src/app.mjs', // only mentions it
    'catalog src/app.mjs', // another program
    'sed -i s/a/b/ src/app.mjs', // an in-place edit
    "sed 's/a/b/' src/app.mjs", // prints a changed copy
    "sed -n '1,40p' a.mjs b.mjs",
    "sed -n '40,1p' src/app.mjs", // a backwards range
    'head -c 100 src/app.mjs', // bytes, not lines
    'tail -f logs/run.log', // follows the file
    'tail -n +5 logs/run.log',
    'git show HEAD:src/app.mjs', // reads git, not the file
    'Get-Content src/app.mjs | Set-Content copy.mjs',
    'Get-Content src/app.mjs -Wait',
    'Get-Content src/[id].mjs', // brackets are wildcards without -LiteralPath
    'Get-Content src/app.mjs | Select-Object -First 5 | Select-Object -Last 1',
    'Get-Content src/app.mjs | Measure-Object',
    'Get-Content -Raw src/app.mjs | Select-Object -First 5', // -Raw makes the file one item, not lines
    'type src/app.mjs', // bash's type describes a command
    'bash -lc "cat src/app.mjs"', // a wrapper: not read as itself
  ]) assert.equal(shellFileRead(cmd), null, cmd);
});

// ---- Claude Code: shell reads count as reads ---------------------------------------------

const CWD = '/work/your-project';
const T0 = Date.parse('2025-03-10T09:00:00.000Z');
const min = (m) => T0 + m * 60e3;
const WINDOW = { from: '2025-03-10', to: '2025-03-16', timezone: 'UTC', startAt: '2025-03-10T00:00:00.000Z', endAt: '2025-03-17T00:00:00.000Z', startT: Date.parse('2025-03-10T00:00:00.000Z'), endT: Date.parse('2025-03-17T00:00:00.000Z') };

/** A Claude Code history in the engine's shape, with raw inputs as keepRaw leaves them. */
function claudeHistory() {
  const events = [];
  let line = 0;
  const ev = (kind, t, facts, { raw = null, command = null, actor = kind === 'prompt' ? 'person' : 'agent', end = true } = {}) => {
    line += 1;
    const e = { id: `s1.${line}.0`, kind, t, at: new Date(t).toISOString(), source: 's1', session: 's1', agent: 's1:main', actor, evidence: 'recorded', refs: [{ src: 's1', line }], facts, derived: {}, inferred: [], missing: [] };
    if (kind === 'action' && end) e.end = { t: t + 500, at: new Date(t + 500).toISOString(), ref: { src: 's1', line: (line += 1) } };
    if (raw) Object.defineProperty(e, '_raw', { value: raw, enumerable: false });
    if (command != null) Object.defineProperty(e, '_command', { value: command, enumerable: false });
    events.push(e);
    return e;
  };
  const api = {
    prompt: (t, text) => ev('prompt', t, { text }, { raw: { text } }),
    say: (t, text) => ev('message', t, { text }, { raw: { text } }),
    bash: (t, command) => ev('action', t, { tool: 'Bash', category: 'shell', command, result: 'ok' }, { raw: { input: { command }, tool: 'Bash' }, command }),
    read: (t, file) => ev('action', t, { tool: 'Read', category: 'read', result: 'ok', fileKey: pathKey(`${CWD}/${file}`) }, { raw: { input: { file_path: `${CWD}/${file}` }, tool: 'Read' } }),
    edit: (t, file) => ev('action', t, { tool: 'Edit', category: 'edit', result: 'ok', fileKey: pathKey(`${CWD}/${file}`) }, { raw: { input: { file_path: `${CWD}/${file}`, old_string: 'a', new_string: 'b' }, tool: 'Edit' } }),
    build() {
      const h = { window: WINDOW, sessions: [{ key: 's1', tool: 'claude-code', private: false, repo: 'your-project', repoRole: 'featured', endState: 'last-turn-ended', firstAt: WINDOW.startAt, lastAt: '2025-03-10T12:00:00.000Z', thread: 'th-s1' }], agents: [{ key: 's1:main', session: 's1', kind: 'main' }], events, lookup: () => ({ sessions: [] }) };
      Object.defineProperty(h, '_raw', { value: { cwdOfSource: new Map([['s1', CWD]]) }, enumerable: false });
      return h;
    },
  };
  return api;
}
const problems = (h) => runProblems(h, { builtT: Date.parse('2025-03-20T00:00:00.000Z') });
const findings = (r, id) => r.patterns.find((p) => p.id === id).findings;

test('Claude Code: the same file read three times through the shell, with no edit between, is a re-read', () => {
  const make = (between) => {
    const h = claudeHistory();
    h.prompt(min(0), 'Look at the parser.');
    h.bash(min(1), "sed -n '1,40p' src/parse.mjs");
    h.bash(min(2), 'head -n 40 src/parse.mjs');
    between(h);
    h.bash(min(4), "sed -n '1,40p' src/parse.mjs");
    return findings(problems(h.build()), 'repeated-file-reads');
  };
  assert.deepEqual(make(() => {}).map((f) => f.steps), [3]);
  // An edit to that file between reads starts the count over.
  assert.deepEqual(make((h) => h.edit(min(3), 'src/parse.mjs')), []);
  // A command that only mentions the file isn't a read.
  assert.deepEqual(make((h) => h.bash(min(3), 'cat src/parse.mjs | grep export')).map((f) => f.steps), [3]);
  // A whole-file read through the shell and through the Read tool are the same read.
  const h = claudeHistory();
  h.prompt(min(0), 'Look at the parser.');
  h.read(min(1), 'src/parse.mjs');
  h.bash(min(2), 'cat src/parse.mjs');
  h.read(min(3), 'src/parse.mjs');
  assert.deepEqual(findings(problems(h.build()), 'repeated-file-reads').map((f) => f.steps), [3]);
});

test('Claude Code: a done claim after an edit with only a shell read after it is worked out, as with the Read tool', () => {
  const make = (after) => {
    const h = claudeHistory();
    h.prompt(min(0), 'Make the parser handle tabs.');
    h.edit(min(1), 'src/parse.js');
    after(h);
    h.say(min(3), 'Done.');
    return findings(problems(h.build()), 'unverified-done-claim').map((f) => f.verdictEvidence);
  };
  assert.deepEqual(make((h) => h.read(min(2), 'src/parse.js')), ['derived']);
  assert.deepEqual(make((h) => h.bash(min(2), 'cat src/parse.js')), ['derived']);
  // Before shell reads counted, this read as "other steps ran after the last edit": inferred.
  assert.deepEqual(make((h) => h.bash(min(2), 'cat src/parse.js | grep tab')), ['inferred']);
});

// ---- Codex: made-up rollouts --------------------------------------------------------------

const ME = 'you@example.com';
const C0 = Date.parse('2024-06-12T10:00:00.000Z');
const T = (s) => new Date(C0 + s * 1000).toISOString();
const ID = {
  plan: '0190c000-0000-7000-8000-0000000000b1',
  parent: '0190c000-0000-7000-8000-0000000000b2',
  done: '0190c000-0000-7000-8000-0000000000b3',
  told: '0190c000-0000-7000-8000-0000000000b4',
  silent: '0190c000-0000-7000-8000-0000000000b5',
  stopped: '0190c000-0000-7000-8000-0000000000b6',
  oldParent: '0190c000-0000-7000-8000-0000000000b7',
  oldChild: '0190c000-0000-7000-8000-0000000000b8',
  shown: '0190c000-0000-7000-8000-0000000000b9',
  reads: '0190c000-0000-7000-8000-0000000000ba',
  flip: '0190c000-0000-7000-8000-0000000000bb',
};
const rec = (s, type, payload) => ({ timestamp: T(s), type, payload });
const meta = (s, id, cwd, extra = {}) => rec(s, 'session_meta', { id, timestamp: T(s), cwd, originator: 'codex_vscode', cli_version: '0.159.2', source: 'vscode', ...extra });
const child = (s, id, cwd, parent, path) => meta(s, id, cwd, { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: path, agent_nickname: 'Helper' } } } });
const turn = (s, mode) => rec(s, 'turn_context', { turn_id: `t${s}`, cwd: '/x', approval_policy: 'on-request', model: 'model-b', ...(mode ? { collaboration_mode: { mode, settings: {} } } : {}) });
const prompt = (s, text) => rec(s, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const say = (s, text) => rec(s, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const turnEnd = (s) => rec(s, 'event_msg', { type: 'task_complete', duration_ms: 1000 });
const program = (s, id, input) => rec(s, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: id, name: 'exec', input });
const out = (s, id, ...printed) => rec(s, 'response_item', { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, ...printed.map((text) => ({ type: 'input_text', text }))] });
let n = 0;
const cmdItem = (s, cwd, cmd, output = '') => rec(s, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: `exec-${++n}`, command: ['/bin/bash', '-lc', cmd], cwd, parsed_cmd: [{ type: 'unknown', cmd }], status: 'completed', exit_code: 0, aggregated_output: output }, started_at_ms: C0 + s * 1000 - 200, completed_at_ms: C0 + s * 1000 });
const fileItem = (s, file) => rec(s, 'event_msg', { type: 'item_completed', item: { type: 'FileChange', id: `exec-${++n}`, changes: { [file]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null } }, status: 'completed', stdout: '', stderr: '' }, started_at_ms: C0 + s * 1000 - 50, completed_at_ms: C0 + s * 1000 });
const run = (cmd, cwd) => `text((await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, workdir: ${JSON.stringify(cwd)} })).output);`;
const patch = (file) => `text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n`)}));`;
const spawn = (s, id, path) => [rec(s, 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: id, arguments: JSON.stringify({ message: `Check ${path.slice(6)}.`, agent_type: 'worker' }) }), rec(s + 0.5, 'response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify({ task_name: path, nickname: 'Helper' }) })];
const activity = (s, kind, path, thread) => rec(s, 'event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: `call_${kind}${s}`, agent_path: path, agent_thread_id: thread, kind }, started_at_ms: C0 + s * 1000, completed_at_ms: C0 + s * 1000 });
const toParent = (s, path) => rec(s, 'response_item', { type: 'agent_message', author: path, recipient: '/root', content: [{ type: 'input_text', text: 'Checked it.' }] });

function write(root, id, day, rows) {
  const dir = join(root, 'codex', 'sessions', '2024', '06', day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2024-06-${day}T10-00-00-${id}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function rollouts(root) {
  const project = join(root, 'your-project');
  const shown = join(root, 'display-repo');
  for (const d of [project, shown]) mkdirSync(join(d, 'src'), { recursive: true });
  const abs = (f) => `${project}/${f}`;
  const git = { git: { commit_hash: 'a'.repeat(40), branch: 'feature/tabs', repository_url: 'https://github.com/example/your-project.git' } };

  // Plan mode: an edit while the turn's settings say plan, then a turn in the default mode.
  write(root, ID.plan, '12', [
    meta(0, ID.plan, project, git),
    turn(1, 'plan'),
    prompt(2, 'Plan how the parser should handle tabs.'),
    program(3, 'p1', patch('src/parse.mjs')),
    fileItem(4, abs('src/parse.mjs')),
    out(5, 'p1', '{}'),
    say(6, 'Here is the plan.'),
    turnEnd(7),
    turn(10, 'default'),
    prompt(11, 'Go ahead.'),
    program(12, 'p2', patch('src/parse.mjs')),
    fileItem(13, abs('src/parse.mjs')),
    out(14, 'p2', '{}'),
    say(15, 'Changed the parser; the tests are next.'),
    turnEnd(16),
  ]);

  // A parent with four child threads: one its log records completing, one that messaged it, one it
  // records starting and nothing else, and one it records interrupted. Its own turn ends before
  // the last completion record, which says nothing about how its own work ended.
  write(root, ID.parent, '13', [
    meta(0, ID.parent, project),
    turn(1, 'default'),
    prompt(2, 'Check the four modules with helpers.'),
    ...spawn(3, 's1', '/root/done'), activity(3.6, 'started', '/root/done', ID.done),
    ...spawn(4, 's2', '/root/told'),
    ...spawn(5, 's3', '/root/silent'), activity(5.6, 'started', '/root/silent', ID.silent),
    ...spawn(6, 's4', '/root/stopped'), activity(6.6, 'started', '/root/stopped', ID.stopped),
    toParent(20, '/root/told'),
    activity(21, 'interrupted', '/root/stopped', ID.stopped),
    say(22, 'Two helpers reported back.'),
    turnEnd(23),
    activity(24, 'completed', '/root/done', ID.done),
  ]);
  for (const [id, path] of [[ID.done, '/root/done'], [ID.told, '/root/told'], [ID.silent, '/root/silent'], [ID.stopped, '/root/stopped']]) {
    write(root, id, '13', [child(7, id, project, ID.parent, path), prompt(7.5, 'Check one thing.'), program(8, `c-${path}`, run('ls src', project)), cmdItem(9, project, 'ls src', 'parse.mjs\n'), out(10, `c-${path}`, 'parse.mjs\n')]);
  }

  // An older parent that records nothing about its child: whether the child handed back is unknown.
  write(root, ID.oldParent, '14', [meta(0, ID.oldParent, project), prompt(1, 'Check it with a helper.'), ...spawn(2, 'o1', '/root/old'), say(30, 'Started a helper.'), turnEnd(31)]);
  write(root, ID.oldChild, '14', [child(3, ID.oldChild, project, ID.oldParent, '/root/old'), prompt(3.5, 'Check one thing.'), say(4, 'Looked.')]);

  // Shell reads in Codex: one file's first 40 lines, read three ways with nothing changed between.
  write(root, ID.reads, '15', [
    meta(0, ID.reads, project),
    prompt(1, 'Why does the parser drop tabs?'),
    program(2, 'r1', run('Get-Content src/parse.mjs -TotalCount 40', project)), cmdItem(3, project, 'Get-Content src/parse.mjs -TotalCount 40', 'a\n'), out(4, 'r1', 'a\n'),
    program(5, 'r2', run('head -n 40 src/parse.mjs', project)), cmdItem(6, project, 'head -n 40 src/parse.mjs', 'a\n'), out(7, 'r2', 'a\n'),
    program(8, 'r3', run("sed -n '1,40p' src/parse.mjs", project)), cmdItem(9, project, "sed -n '1,40p' src/parse.mjs", 'a\n'), out(10, 'r3', 'a\n'),
    say(11, 'It splits on spaces only.'),
    turnEnd(12),
  ]);

  // An edit undone and redone in Codex patches: x to y, y back to x, x to y again.
  const swap = (s, id, from, to) => [
    program(s, id, `text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: src/flip.mjs\n@@\n-${from}\n+${to}\n*** End Patch\n`)}));`),
    rec(s + 0.5, 'event_msg', { type: 'item_completed', item: { type: 'FileChange', id: `exec-${++n}`, changes: { [abs('src/flip.mjs')]: { type: 'update', unified_diff: `@@ -1 +1 @@\n-${from}\n+${to}\n`, move_path: null } }, status: 'completed', stdout: '', stderr: '' }, started_at_ms: C0 + s * 1000, completed_at_ms: C0 + s * 1000 + 400 }),
    out(s + 0.8, id, '{}'),
  ];
  write(root, ID.flip, '15', [meta(30, ID.flip, project), prompt(31, 'Pick a name for the flag.'), ...swap(32, 'f1', 'const x = 1;', 'const y = 1;'), ...swap(34, 'f2', 'const y = 1;', 'const x = 1;'), ...swap(36, 'f3', 'const x = 1;', 'const y = 1;'), say(38, 'Settled on y.'), turnEnd(39)]);

  // A display-only repository: no title, no branch link, nothing read.
  write(root, ID.shown, '16', [meta(0, ID.shown, shown, git), turn(1, 'plan'), prompt(2, 'Edit it.'), program(3, 'd1', patch('src/a.mjs')), fileItem(4, `${shown}/src/a.mjs`), out(5, 'd1', '{}')]);

  // Thread names, as Codex keeps them beside its sessions folder: a rename later in the file wins,
  // and a private word in a name is redacted.
  writeFileSync(join(root, 'codex', 'session_index.jsonl'), `${[
    { id: ID.plan, thread_name: 'Tabs plan', updated_at: '2024-06-12T10:00:30Z' },
    { id: ID.plan, thread_name: 'Handle tabs for Zephyrine', updated_at: '2024-06-12T10:01:00Z' },
    { id: ID.parent, thread_name: 'Check the modules', updated_at: '2024-06-13T10:00:30Z' },
    { id: ID.shown, thread_name: 'Display-only work', updated_at: '2024-06-16T10:00:30Z' },
    { id: ID.done, thread_name: 'A child thread', updated_at: '2024-06-13T10:00:30Z' },
  ].map((x) => JSON.stringify(x)).join('\n')}\n`);

  const config = normalizeConfig({ identity: { authorEmails: [ME] }, week: { timezone: 'UTC' }, redaction: { names: ['Zephyrine'] }, repos: [{ path: project, label: 'your-project', role: 'featured' }, { path: shown, label: 'shown-only', role: 'display' }] }, { configDir: root });
  return { config };
}

async function readWeek(t) {
  const root = makeTempDir('hw-codex-parity-');
  t.after(() => removeTempDir(root));
  const { config } = rollouts(root);
  const h = await buildWorkHistory({ config, from: '2024-06-10', to: '2024-06-16', timezone: 'UTC', roots: { claude: [join(root, 'claude')], codex: [join(root, 'codex', 'sessions')] }, git: false, usage: true, keepRaw: true });
  return { h, r: runProblems(h, { builtT: Date.parse('2024-06-20T00:00:00.000Z') }) };
}
const cx = (id) => sourceKey('cx', id);

test("Codex plan mode is read from each turn's settings, and an edit in plan mode is found", async (t) => {
  const { h, r } = await readWeek(t);
  const modes = h.events.filter((e) => e.session === cx(ID.plan) && e.kind === 'mode');
  assert.deepEqual(modes.map((e) => [e.facts.change, e.facts.value, e.evidence]), [['collaboration-mode', 'plan', 'recorded'], ['collaboration-mode', 'default', 'recorded']]);
  const found = findings(r, 'instruction-violation');
  assert.deepEqual(found.map((f) => [f.session, f.steps, f.verdictEvidence]), [[cx(ID.plan), 1, 'derived']]);
  // A session whose turns all record the default mode has no mode events at all.
  assert.equal(h.events.filter((e) => e.session === cx(ID.reads) && e.kind === 'mode').length, 0);
});

test("a Codex child thread's hand-back: its parent's completion record or a message to the parent; none is a finding", async (t) => {
  const { h, r } = await readWeek(t);
  const agentOf = (id) => h.agents.find((a) => a.source === cx(id));
  assert.deepEqual(agentOf(ID.done).completion.via, 'activity-record');
  assert.deepEqual(agentOf(ID.told).completion.via, 'message-to-parent');
  assert.deepEqual([agentOf(ID.silent).completion, agentOf(ID.silent).missing], [null, ['hand-back']]);
  assert.deepEqual([agentOf(ID.stopped).completion, agentOf(ID.stopped).missing], [null, ['hand-back']]);
  // An older parent that records nothing about its children: unknown, not missing.
  assert.deepEqual(agentOf(ID.oldChild).missing, ['hand-back-record']);
  assert.ok(h.links.some((l) => l.type === 'completion-notice' && l.to === agentOf(ID.done).key));
  assert.ok(h.links.some((l) => l.type === 'handback' && l.to === agentOf(ID.told).key));
  const lost = findings(r, 'subagent-handoff-loss');
  assert.deepEqual(lost.map((f) => [f.event, f.verdictEvidence]).sort(), [[agentOf(ID.silent).spawnedBy, 'missing'], [agentOf(ID.stopped).spawnedBy, 'missing']].sort());
  assert.match(lost.find((f) => f.event === agentOf(ID.stopped).spawnedBy).note, /recorded it interrupted/);
  assert.match(r.checks.find((c) => c.id === 'subagent-no-report').checked, /5 Codex child threads.*1 of the child threads have no record/);
  // The completion record after the parent's turn ended doesn't change how its own work ended.
  assert.equal(h.sessions.find((s) => s.key === cx(ID.parent)).endState, 'last-turn-ended');
});

test('Codex shell reads of the same lines, read three ways, are a re-read', async (t) => {
  const { r } = await readWeek(t);
  assert.deepEqual(findings(r, 'repeated-file-reads').map((f) => [f.session, f.steps]), [[cx(ID.reads), 3]]);
});

test('an edit undone and redone in Codex patches is an action loop, as with Claude Code edits', async (t) => {
  const { r } = await readWeek(t);
  assert.deepEqual(findings(r, 'action-loop').map((f) => [f.session, f.kind]), [[cx(ID.flip), 'edit undone and redone']]);
});

test('Codex sessions get their thread names and branch links; a display-only session gets neither', async (t) => {
  const { h } = await readWeek(t);
  const title = (id) => h.sessions.find((s) => s.key === cx(id))?.title ?? null;
  assert.match(title(ID.plan), /^Handle tabs for \[redacted:/);
  assert.ok(!JSON.stringify(h).includes('Zephyrine'));
  assert.equal(title(ID.parent), 'Check the modules');
  assert.equal(title(ID.reads), null, 'no name in the index');
  assert.equal(title(ID.shown), null, 'display-only');
  const found = h.lookup('branch:feature/tabs');
  assert.deepEqual(found.sessions.map((s) => s.session), [cx(ID.plan)]);
  assert.deepEqual(found.sessions[0].refs.map((x) => [x.via, x.evidence]), [['session-start', 'recorded']]);
});
