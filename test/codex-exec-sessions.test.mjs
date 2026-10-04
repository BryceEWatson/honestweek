// A session started with `codex exec` is agent-started (issue 62): no reader counts its
// messages as something the person typed, and the work-history engine credits them to
// the agent. A hand-typed session that only looks like exec is still the person's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexTurnReader, isCodexExecSession } from '../lib/codex-records.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { probeSession } from '../lib/mine/corpus.mjs';
import { scanPromptSources } from '../lib/prompt-adapters.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const EXEC_ID = '0190a1b2-0000-7000-8000-00000000e0e0';
const TYPED_ID = '0190a1b2-0000-7000-8000-00000000a1a1';

const meta = (id, cwd, extra) => ({ timestamp: '2024-06-11T10:00:00.000Z', type: 'session_meta', payload: { id, cwd, cli_version: '0.1.0', ...extra } });
const user = (at, text) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const said = (at, text) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const shell = (at, id, command) => ({ timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: id, arguments: JSON.stringify({ command }) } });
const output = (at, id, text) => ({ timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: text } });

function rollouts(root, project) {
  const dir = join(root, 'codex', 'sessions', '2024', '06', '11');
  mkdirSync(dir, { recursive: true });
  const write = (name, rows) => {
    const file = join(dir, name);
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  const exec = write(`rollout-2024-06-11T10-00-00-${EXEC_ID}.jsonl`, [
    meta(EXEC_ID, project, { originator: 'codex_exec', source: 'exec' }),
    user('2024-06-11T10:00:01.000Z', 'READ-ONLY review: summarize the changes on main since Monday'),
    shell('2024-06-11T10:00:02.000Z', 'c1', 'git log --oneline'),
    output('2024-06-11T10:00:03.000Z', 'c1', 'Exit code: 0\nabc1234 Add a flag'),
    said('2024-06-11T10:00:04.000Z', 'One commit since Monday.'),
    user('2024-06-11T10:00:05.000Z', 'now list the files it touched'),
    said('2024-06-11T10:00:06.000Z', 'One file.'),
  ]);
  // Hand-typed in the terminal: it names `codex exec` and opens like a hand-off, but its
  // session_meta says an interactive run started it.
  const typed = write(`rollout-2024-06-11T11-00-00-${TYPED_ID}.jsonl`, [
    meta(TYPED_ID, project, { originator: 'codex_cli_rs', source: 'cli' }),
    user('2024-06-11T11:00:01.000Z', 'codex exec READ-ONLY: why does the exec source fail on main'),
    said('2024-06-11T11:00:02.000Z', 'It reads the wrong field.'),
    user('2024-06-11T11:00:03.000Z', 'fix it please'),
  ]);
  return { exec, typed };
}

test('the shared check: only an exact exec source or originator marks a session', () => {
  assert.equal(isCodexExecSession({ source: 'exec' }), true);
  assert.equal(isCodexExecSession({ originator: 'codex_exec' }), true);
  for (const m of [null, {}, { source: 'cli' }, { source: 'Exec' }, { source: 'exec ' }, { originator: 'codex_exec_wrapper' }, { source: { subagent: 'exec' } }]) {
    assert.equal(isCodexExecSession(m), false, JSON.stringify(m));
  }
  const read = createCodexTurnReader();
  read(meta('x', '/path/to/your/repo', { source: 'exec' }));
  assert.deepEqual(read(user(null, 'do the thing')), { user: null, assistant: null, instruction: 'do the thing' });
  // A later session_meta (a fork's copied history) never changes what the first one decided.
  const typed = createCodexTurnReader();
  typed(meta('y', '/path/to/your/repo', { source: 'cli' }));
  typed(meta('z', '/path/to/your/repo', { source: 'exec' }));
  assert.deepEqual(typed(user(null, 'codex exec the tests')), { user: 'codex exec the tests', assistant: null, instruction: null });
});

test('codex exec sessions count no typed prompt in the miner, the prompt reader or the work history', async () => {
  const root = makeTempDir('honestweek-codex-exec-');
  try {
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    const { exec, typed } = rollouts(root, project);

    // The miner: an exec session has no human turn, the look-alike keeps its first one.
    assert.equal(probeSession('codex', exec), null);
    assert.equal(probeSession('codex', typed).firstPrompt, 'codex exec READ-ONLY: why does the exec source fail on main');

    // The prompt reader: only the hand-typed session's turns, numbered from 1.
    const config = normalizeConfig({ identity: { authorEmails: ['you@example.com'] }, week: { timezone: 'UTC' }, repos: [{ path: project, label: 'your-project', role: 'featured' }] }, { configDir: root });
    const got = await scanPromptSources({ config, weekStart: new Date('2024-06-10T00:00:00Z'), weekEnd: new Date('2024-06-17T00:00:00Z'), roots: { 'claude-code': join(root, 'claude'), codex: join(root, 'codex') }, now: new Date('2024-06-17T00:00:00Z') });
    assert.deepEqual(got.prompts.map((p) => [p.turn, p.text]), [[1, 'codex exec READ-ONLY: why does the exec source fail on main'], [2, 'fix it please']]);

    // The work history: the exec run's messages are the agent's instruction and follow-up,
    // its steps still show, and the look-alike's prompts stay yours.
    const h = await buildWorkHistory({ config, from: '2024-06-10', to: '2024-06-16', timezone: 'UTC', roots: { claude: [join(root, 'claude')], codex: [join(root, 'codex')] }, git: false });
    const execKey = h.sessions.find((s) => h.events.some((e) => e.session === s.key && e.kind === 'action')).key;
    const of = (key) => h.events.filter((e) => e.session === key);
    assert.deepEqual(of(execKey).filter((e) => ['prompt', 'delegation-received', 'agent-message'].includes(e.kind)).map((e) => [e.kind, e.actor, e.facts.from]), [
      ['delegation-received', 'agent', 'codex-exec'],
      ['agent-message', 'agent', 'codex-exec'],
    ]);
    assert.equal(of(execKey).filter((e) => e.kind === 'action').length, 1, 'its shell step still shows');
    const typedKey = h.sessions.find((s) => s.key !== execKey).key;
    assert.deepEqual(of(typedKey).filter((e) => e.kind === 'prompt').map((e) => e.actor), ['person', 'person']);
    assert.equal(h.overview().totals.prompts.value, 2);
  } finally {
    removeTempDir(root);
  }
});
