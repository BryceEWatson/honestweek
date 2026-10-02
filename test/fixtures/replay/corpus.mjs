// test/fixtures/replay/corpus.mjs — a synthetic, clean-room session corpus for the
// work-history engine tests.
//
// Every record shape here was observed in real Claude Code and Codex logs (see
// docs/work-history-engine.md for the measured coverage), but every value is made
// up: generic names, example.com addresses, fixed timestamps. buildCorpus() writes
// the logs and a small git repository into a temp directory and returns the paths
// and the config to read them with.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig } from '../../../lib/config.mjs';

export const ME = 'you@example.com';
export const SECRET_REASONING = 'PRIVATE-REASONING-SENTINEL';
export const CODEX_SECRET_REASONING = 'PRIVATE-CODEX-REASONING-SENTINEL';
export const CODENAME = 'Bluebird';
export const PRIVATE_TEXT = 'PRIVATE-SESSION-TEXT-SENTINEL';

const T0 = Date.parse('2024-06-11T15:00:00.000Z');
export const at = (minutes, ms = 0) => new Date(T0 + minutes * 60000 + ms).toISOString();

function git(dir, args, env = {}) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
}

function commit(dir, file, message, iso) {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  return git(dir, ['rev-parse', 'HEAD']);
}

/** A repo with main, a feature-branch commit that never landed, and a squash merge (#7). */
function makeRepo(root) {
  const dir = join(root, 'your-project');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['remote', 'add', 'origin', 'https://github.com/example/your-project.git']);
  commit(dir, 'README.md', 'Initial commit', at(-600));
  git(dir, ['checkout', '-q', '-b', 'feature/widget']);
  const featureSha = commit(dir, 'widget.mjs', 'Add a widget parser', at(20));
  git(dir, ['checkout', '-q', 'main']);
  const squashSha = commit(dir, 'widget.mjs', 'Add a widget parser (#7)', at(60));
  git(dir, ['checkout', '-q', 'feature/widget']);
  const resumeSha = commit(dir, 'resume.mjs', 'Finish the widget after a resume', at(305));
  git(dir, ['checkout', '-q', 'main']);
  return { dir, featureSha, squashSha, resumeSha };
}

/** A display-role repo that IS a git repository holding the commit a private session
 *  cites, so a git read against it would be noticed. */
function makeDisplayRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return commit(dir, 'invoice.txt', 'Fix the invoice export', at(41));
}

let uuidN = 0;
function claudeRecords(sessionId, cwd) {
  const lines = [];
  const base = (type, ts, extra = {}) => ({ type, sessionId, cwd, version: '2.1.0', gitBranch: 'feature/widget', uuid: `${sessionId}-u${++uuidN}`, timestamp: ts, ...extra });
  return {
    lines,
    push: (obj) => lines.push(JSON.stringify(obj)),
    raw: (text) => lines.push(text),
    prompt: (ts, text, extra = {}) => lines.push(JSON.stringify(base('user', ts, { message: { role: 'user', content: text }, origin: { kind: 'human' }, promptSource: 'sdk', ...extra }))),
    say: (ts, blocks, extra = {}) => lines.push(JSON.stringify(base('assistant', ts, { message: { id: `msg-${uuidN}`, model: 'model-a', role: 'assistant', content: blocks }, ...extra }))),
    result: (ts, toolUseId, content, extra = {}) => lines.push(JSON.stringify(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(extra.isError ? { is_error: true } : {}) }] }, ...(extra.tur !== undefined ? { toolUseResult: extra.tur } : {}), ...(extra.denial ? { toolDenialKind: extra.denial } : {}) }))),
    base,
  };
}

function write(file, lines, { trailingPartial = null } = {}) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n' + (trailingPartial ?? ''));
}

/**
 * buildCorpus() -> { root, claudeRoot, codexRoot, repo, config, ids }
 * `ids` names the files' session ids so tests can find their keys.
 */
export function buildCorpus({ root = mkdtempSync(join(tmpdir(), 'hw-replay-')) } = {}) {
  const repo = makeRepo(root);
  const displayDir = join(root, 'a-private-project');
  const displaySha = makeDisplayRepo(displayDir);
  const elsewhere = join(root, 'not-configured');
  mkdirSync(elsewhere, { recursive: true });
  const claudeRoot = join(root, 'claude-projects');
  const codexRoot = join(root, 'codex-sessions');

  // ---- session A: the main thread --------------------------------------------
  const A = 'aaaaaaaa-1111-4111-8111-000000000001';
  const a = claudeRecords(A, repo.dir);
  a.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(0), sessionId: A, content: 'Please add a widget parser and run the tests.' });
  a.push({ type: 'queue-operation', operation: 'dequeue', timestamp: at(0, 2), sessionId: A });
  a.prompt(at(0, 10), `Please add a widget parser and run the tests. Contact ${ME} or look in C:\\Users\\Alex Example\\notes\\${CODENAME}.md`);
  a.push({ type: 'custom-title', customTitle: `Widget parser for ${CODENAME}`, sessionId: A });
  a.say(at(1), [{ type: 'thinking', thinking: `${SECRET_REASONING} weighing options`, signature: 'sig' }, { type: 'text', text: 'Starting with the tests.' }, { type: 'tool_use', id: 'tu-test1', name: 'Bash', input: { command: 'node --test', description: 'Run the suite' } }]);
  a.result(at(2), 'tu-test1', '# tests 3\n# pass 2\n# fail 1', { isError: true, tur: { stdout: '# tests 3\n# pass 2\n# fail 1', stderr: '', interrupted: false } });
  a.say(at(3), [{ type: 'tool_use', id: 'tu-edit1', name: 'Edit', input: { file_path: join(repo.dir, 'lib', 'widget.mjs'), old_string: 'a', new_string: 'b' } }]);
  a.result(at(3, 500), 'tu-edit1', 'ok', { tur: { filePath: join(repo.dir, 'lib', 'widget.mjs'), structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' x', '-old', '+new', '+more'] }], userModified: false } });
  a.say(at(4), [{ type: 'tool_use', id: 'tu-test2', name: 'Bash', input: { command: 'cd /work && node --test 2>&1 | tail -5' } }]);
  a.result(at(5), 'tu-test2', '# tests 3\n# pass 3\n# fail 0', { tur: { stdout: '# tests 3\n# pass 3\n# fail 0', stderr: '', interrupted: false } });
  // A pull-request body that names a test runner is not a test run.
  a.say(at(5, 100), [{ type: 'tool_use', id: 'tu-gh', name: 'Bash', input: { command: 'gh pr create --title "Widget" --body "Ran node --test, all green"' } }]);
  a.result(at(5, 900), 'tu-gh', 'https://github.com/example/your-project/pull/7', { tur: { stdout: '', stderr: '', interrupted: false, gitOperation: { pr: { number: 7, url: 'https://github.com/example/your-project/pull/7', action: 'created' } } } });
  // A background reviewer, linked by its metadata and finished by a notification.
  a.say(at(6), [{ type: 'tool_use', id: 'tu-agent1', name: 'Agent', input: { description: 'Review the widget parser', subagent_type: 'general-purpose', prompt: 'Review it.', run_in_background: true } }]);
  a.result(at(6, 200), 'tu-agent1', 'Async agent launched successfully. agentId: rev1', { tur: { isAsync: true, status: 'async_launched', agentId: 'rev1', description: 'Review the widget parser' } });
  // A message typed while the agent was busy, absorbed mid-turn.
  a.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(7), sessionId: A, content: 'wait, use the streaming reader instead' });
  a.push({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: at(7, 400), sessionId: A, content: 'wait, use the streaming reader instead' });
  a.push(a.base('attachment', at(7, 401), { attachment: { type: 'queued_command', prompt: 'wait, use the streaming reader instead', origin: { kind: 'human' }, commandMode: 'prompt' } }));
  a.push(a.base('attachment', at(7, 402), { attachment: { type: 'total_tokens_reminder', content: 'context' } }));
  a.push(a.base('attachment', at(7, 403), { attachment: { type: 'edited_text_file', filename: join(repo.dir, 'docs', 'notes.md'), snippet: '' } }));
  a.prompt(at(9), '<task-notification>\n<task-id>rev1</task-id>\n<tool-use-id>tu-agent1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Review the widget parser" finished</summary>\n</task-notification>', { origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system' });
  // The harness recorded the commit itself.
  a.say(at(10), [{ type: 'tool_use', id: 'tu-commit', name: 'Bash', input: { command: 'git add -A && git commit -qm "Add a widget parser"' } }]);
  a.result(at(10, 300), 'tu-commit', '', { tur: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: repo.featureSha, kind: 'committed' } } } });
  // An out-of-band record stamped far later than the records written after it.
  a.push({ type: 'pr-link', sessionId: A, prNumber: 7, prUrl: 'https://github.com/example/your-project/pull/7', prRepository: 'example/your-project', timestamp: at(600) });
  a.push(a.base('system', at(11), { subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'hook', durationMs: 40 }], hookErrors: [], preventedContinuation: false }));
  // A question and its recorded answer; a plan the person rejected.
  a.prompt(at(20), 'merge 7');
  a.say(at(20, 100), [{ type: 'tool_use', id: 'tu-merge', name: 'Bash', input: { command: 'gh pr merge 7 --squash' } }]);
  a.result(at(20, 200), 'tu-merge', 'PreToolUse:Bash hook error: Refused: merge without a pinned head', { isError: true, denial: 'permission-rule', tur: 'Error: refused' });
  a.say(at(21), [{ type: 'tool_use', id: 'tu-ask', name: 'AskUserQuestion', input: { questions: [{ question: `Which reader for ${CODENAME}?`, header: 'Reader', options: [{ label: 'Streaming' }, { label: 'Buffered' }] }] } }]);
  a.result(at(22), 'tu-ask', 'answered', { tur: { questions: [], answers: { [`Which reader for ${CODENAME}?`]: 'Streaming' } } });
  a.say(at(23), [{ type: 'tool_use', id: 'tu-plan', name: 'ExitPlanMode', input: { plan: 'the plan' } }]);
  a.result(at(24), 'tu-plan', "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said: no, keep the old reader", { isError: true });
  // A suggested task chip and a message to another session.
  a.say(at(25), [{ type: 'tool_use', id: 'tu-chip', name: 'mcp__ccd_session__spawn_task', input: { title: 'Write the widget docs', prompt: 'Document the widget parser in the README.', tldr: 'docs' } }]);
  a.result(at(25, 100), 'tu-chip', 'Noted (position 1, task_id: task_x1).', { tur: [{ type: 'text', text: 'ok' }] });
  a.say(at(26), [{ type: 'tool_use', id: 'tu-send', name: 'SendMessage', input: { to: 'helper', summary: 'heads up', message: 'The parser landed.' } }]);
  a.result(at(26, 100), 'tu-send', '{"success":true}', { tur: { success: true, msg_id: 'msg-peer-1' } });
  // A result stamped before its call (a clock difference) and a compaction.
  a.say(at(27), [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: join(repo.dir, 'README.md') } }]);
  a.result(at(26, 500), 'tu-read', 'contents', { tur: { type: 'text', file: {} } });
  a.push(a.base('system', at(28), { subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 100 } }));
  a.prompt(at(29), '[Request interrupted by user]');
  // The session ends mid-call: no result, then a cut-off last line.
  a.say(at(30), [{ type: 'tool_use', id: 'tu-last', name: 'Bash', input: { command: 'npm run build' } }]);
  write(join(claudeRoot, 'proj-a', `${A}.jsonl`), a.lines, { trailingPartial: '{"type":"user","message":{"role":"us' });

  // The reviewer's own transcript.
  const sub = claudeRecords(A, repo.dir);
  sub.push(sub.base('user', at(6, 300), { isSidechain: true, agentId: 'rev1', message: { role: 'user', content: 'Review the widget parser for edge cases.' } }));
  sub.say(at(7), [{ type: 'tool_use', id: 'tu-sub-read', name: 'Read', input: { file_path: join(repo.dir, 'lib', 'widget.mjs') } }], { isSidechain: true, agentId: 'rev1' });
  sub.result(at(7, 200), 'tu-sub-read', 'code', { tur: { type: 'text' } });
  sub.say(at(8), [{ type: 'text', text: 'Two edge cases need tests.' }], { isSidechain: true, agentId: 'rev1' });
  write(join(claudeRoot, 'proj-a', A, 'subagents', 'agent-rev1.jsonl'), sub.lines);
  writeFileSync(join(claudeRoot, 'proj-a', A, 'subagents', 'agent-rev1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Review the widget parser', toolUseId: 'tu-agent1', spawnDepth: 1, requestShape: 'background' }));
  // A transcript whose starting call is not in any log.
  const orphan = claudeRecords(A, repo.dir);
  orphan.push(orphan.base('user', at(12), { isSidechain: true, agentId: 'lost1', message: { role: 'user', content: 'Check the build.' } }));
  write(join(claudeRoot, 'proj-a', A, 'subagents', 'agent-lost1.jsonl'), orphan.lines);

  // ---- session B: a resumed copy of A's first records, then its own work -------
  const B = 'bbbbbbbb-2222-4222-8222-000000000002';
  const copied = a.lines.slice(2, 6).map((l) => JSON.parse(l)).map((r) => JSON.stringify({ ...r, sessionId: B }));
  const b = claudeRecords(B, repo.dir);
  b.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(200), sessionId: B, content: 'continue' });
  for (const l of copied) b.raw(l);
  b.prompt(at(201), 'continue from where we stopped');
  b.say(at(202), [{ type: 'text', text: 'Resuming.' }]);
  write(join(claudeRoot, 'proj-a', `${B}.jsonl`), b.lines);

  // ---- session C: in a display-role repo (private skeleton) -------------------
  const C = 'cccccccc-3333-4333-8333-000000000003';
  const c = claudeRecords(C, displayDir);
  c.prompt(at(40), `${PRIVATE_TEXT} please fix the invoice export`);
  c.say(at(41), [{ type: 'tool_use', id: 'tu-c1', name: 'Bash', input: { command: `echo ${PRIVATE_TEXT} && node --test` } }]);
  c.result(at(42), 'tu-c1', PRIVATE_TEXT, { tur: { stdout: PRIVATE_TEXT, stderr: '', interrupted: false, gitOperation: { commit: { sha: displaySha, kind: 'committed' } } } });
  c.say(at(43), [{ type: 'tool_use', id: 'tu-c2', name: 'AskUserQuestion', input: { questions: [{ question: `Ship ${CODENAME}?` }] } }]);
  c.result(at(44), 'tu-c2', 'answered', { tur: { answers: { [`Ship ${CODENAME}?`]: 'yes' } } });
  write(join(claudeRoot, 'proj-c', `${C}.jsonl`), c.lines);

  // ---- session D: outside every configured repo -------------------------------
  const D = 'dddddddd-4444-4444-8444-000000000004';
  const d = claudeRecords(D, elsewhere);
  d.prompt(at(50), 'unrelated work');
  write(join(claudeRoot, 'proj-d', `${D}.jsonl`), d.lines);

  // ---- session E: started from A's task suggestion (inferred hand-off) ---------
  const E = 'eeeeeeee-5555-4555-8555-000000000005';
  const e = claudeRecords(E, repo.dir);
  e.prompt(at(30), 'Document the widget parser in the README.');
  e.say(at(31), [{ type: 'text', text: 'Writing the docs.' }]);
  // A test command the person rejected and one a rule refused: neither ran.
  e.say(at(32), [{ type: 'tool_use', id: 'tu-e1', name: 'Bash', input: { command: 'npm test' } }]);
  e.result(at(32, 500), 'tu-e1', "The user doesn't want to proceed with this tool use. The tool use was rejected.", { isError: true, denial: 'user-rejected' });
  e.say(at(33), [{ type: 'tool_use', id: 'tu-e2', name: 'Bash', input: { command: 'node --test' } }]);
  e.result(at(33, 500), 'tu-e2', 'PreToolUse:Bash hook error: Refused: tests are blocked here', { isError: true, denial: 'permission-rule' });
  write(join(claudeRoot, 'proj-a', `${E}.jsonl`), e.lines);

  // ---- session F: receives A's message (recorded link) -------------------------
  const F = 'ffffffff-6666-4666-8666-000000000006';
  const f = claudeRecords(F, repo.dir);
  f.push(f.base('user', at(26, 300), { isMeta: true, message: { role: 'user', content: 'The parser landed.' }, origin: { kind: 'peer', from: 'session-a', msg_id: 'msg-peer-1', name: 'main' }, promptSource: 'system' }));
  f.say(at(27), [{ type: 'text', text: 'Noted.' }]);
  // Nothing recorded for 53 minutes: a quiet interval, never "idle".
  f.prompt(at(80), 'Any news?');
  f.say(at(80, 500), [{ type: 'text', text: 'None yet.' }]);
  // A queue record stamped hours later, as out-of-band records are: it must not stretch the span.
  f.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(1000), sessionId: F, content: 'later' });
  write(join(claudeRoot, 'proj-a', `${F}.jsonl`), f.lines);

  // ---- sessions G and H: a run that stopped mid-call, and its resumed copy ------
  // G recorded the call; only the resumed copy H recorded its result.
  const G = '99999999-7777-4777-8777-000000000007';
  const H = '88888888-8888-4888-8888-000000000008';
  const g = claudeRecords(G, repo.dir);
  g.prompt(at(300), 'Finish the widget');
  g.say(at(301), [{ type: 'tool_use', id: 'tu-g1', name: 'Bash', input: { command: 'git commit -qm "Finish the widget after a resume"' } }]);
  write(join(claudeRoot, 'proj-a', `${G}.jsonl`), g.lines);
  const hh = claudeRecords(H, repo.dir);
  for (const l of g.lines) hh.raw(JSON.stringify({ ...JSON.parse(l), sessionId: H }));
  hh.result(at(310), 'tu-g1', '', { tur: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: repo.resumeSha, kind: 'committed' } } } });
  hh.say(at(311), [{ type: 'text', text: 'Committed.' }]);
  write(join(claudeRoot, 'proj-a', `${H}.jsonl`), hh.lines);

  // ---- Codex: a parent thread and the child it spawned -------------------------
  const P = '01900000-0000-7000-8000-00000000000a';
  const K = '01900000-0000-7000-8000-00000000000b';
  const cx = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
  const parent = [
    cx(at(100), 'session_meta', { id: P, timestamp: at(100), cwd: repo.dir, originator: 'Codex Desktop', cli_version: '0.1.0', source: 'vscode', git: { commit_hash: repo.squashSha, branch: 'main' } }),
    cx(at(100, 10), 'turn_context', { turn_id: 't1', model: 'model-b', approval_policy: 'never' }),
    cx(at(100, 20), 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] }),
    cx(at(100, 30), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }, { type: 'input_text', text: 'Port the widget parser and test it.' }] }),
    cx(at(101), 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: CODEX_SECRET_REASONING }], encrypted_content: 'xxx' }),
    cx(at(102), 'response_item', { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ message: 'Write fixtures', agent_type: 'worker' }), call_id: 'call-spawn' }),
    cx(at(102, 500), 'response_item', { type: 'function_call_output', call_id: 'call-spawn', output: JSON.stringify({ task_name: '/root/fixtures' }) }),
    cx(at(103), 'response_item', { type: 'function_call', name: 'wait_agent', namespace: 'collaboration', arguments: JSON.stringify({ timeout_ms: 60000 }), call_id: 'call-wait' }),
    cx(at(105), 'response_item', { type: 'function_call_output', call_id: 'call-wait', output: JSON.stringify({ message: 'Wait completed.', timed_out: false }) }),
    cx(at(105, 100), 'response_item', { type: 'agent_message', author: '/root/fixtures', recipient: '/root', content: [{ type: 'input_text', text: 'Fixtures written.' }] }),
    cx(at(105, 200), 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call-commit', input: 'git commit -qm "Port the widget parser"' }),
    cx(at(105, 300), 'response_item', { type: 'custom_tool_call_output', call_id: 'call-commit', output: [{ type: 'input_text', text: `Exit code: 0
[main ${repo.squashSha.slice(0, 7)}] Port the widget parser
 1 file changed
${repo.featureSha.slice(0, 7)} Add a widget parser` }] }),
    cx(at(106), 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call-exec', input: 'pytest -q tests' }),
    cx(at(107), 'response_item', { type: 'custom_tool_call_output', call_id: 'call-exec', output: [{ type: 'input_text', text: 'Exit code: 1\n==== 1 failed, 2 passed in 0.12s ====' }] }),
    cx(at(108), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One test still fails.' }] }),
    cx(at(108, 10), 'event_msg', { type: 'agent_message', message: 'One test still fails.' }),
    cx(at(109), 'event_msg', { type: 'task_complete', turn_id: 't1', duration_ms: 540000 }),
    cx(at(110), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stop, that is the wrong file' }] }),
    cx(at(110, 500), 'event_msg', { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted', duration_ms: 500 }),
    cx(at(111), 'event_msg', { type: 'token_count', info: {} }),
  ];
  write(join(codexRoot, '2024', '06', '11', `rollout-2024-06-11T16-40-00-${P}.jsonl`), parent);
  const child = [
    cx(at(102, 600), 'session_meta', { id: K, timestamp: at(102, 600), cwd: repo.dir, source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_path: '/root/fixtures', agent_nickname: 'Fixer' } } } }),
    cx(at(102, 700), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write fixtures for the widget parser.' }] }),
    cx(at(103, 500), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call-patch', input: '*** Begin Patch' }),
    cx(at(104), 'response_item', { type: 'custom_tool_call_output', call_id: 'call-patch', output: 'Done' }),
    cx(at(104, 500), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixtures written.' }] }),
  ];
  write(join(codexRoot, '2024', '06', '11', `rollout-2024-06-11T16-42-00-${K}.jsonl`), child);

  const rawConfig = {
      identity: { authorEmails: [ME] },
      week: { startsOn: 'monday', timezone: 'UTC' },
      repos: [
        { path: repo.dir, label: 'your-project', role: 'featured' },
        { path: displayDir, label: 'a-private-project', role: 'display' },
      ],
      redaction: { codenames: [CODENAME], names: [], terms: [] },
      output: { mode: 'digest', file: 'honestweek.digest.md' },
  };
  const config = normalizeConfig(rawConfig, { configDir: root });
  const configFile = join(root, 'honestweek.config.json');
  writeFileSync(configFile, JSON.stringify(rawConfig, null, 2));
  return { root, claudeRoot, codexRoot, repo, config, configFile, displaySha, ids: { A, B, C, D, E, F, G, H, P, K }, dirs: { A: 'proj-a', B: 'proj-a', C: 'proj-c', D: 'proj-d', E: 'proj-a', F: 'proj-a', G: 'proj-a', H: 'proj-a' } };
}
