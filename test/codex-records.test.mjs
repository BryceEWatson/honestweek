// Codex's current log shape: a person's turn arrives as a response_item message with
// role "user", mixed in with harness context and other agents' hand-offs, and often
// past the first 64 KB of the file. These tests pin the readers to that shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexAssistantText, codexUserText, createCodexTurnReader } from '../lib/codex-records.mjs';
import { enumerateSessions, probeSession, streamSession } from '../lib/mine/corpus.mjs';
import { scanPromptSources } from '../lib/prompt-adapters.mjs';
import { normalizeConfig } from '../lib/config.mjs';

const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const userMsg = (texts, timestamp = '2026-09-08T17:40:00.000Z') => ({
  timestamp,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) },
});
const asstMsg = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
// A session_meta line the size Codex writes today (the median first line is ~20 KB).
const bigMeta = (extra = {}) => ({
  timestamp: '2026-09-08T17:39:00.000Z',
  type: 'session_meta',
  payload: { id: 'sess-1', cwd: 'C:/repo', source: 'vscode', base_instructions: { text: 'x'.repeat(22_000) }, ...extra },
});

test('a current-shape user message is read as the person turn', () => {
  assert.equal(codexUserText(userMsg(['why does the service fail to start'])), 'why does the service fail to start');
});

test('context blocks are dropped and the person text beside them is kept', () => {
  const rec = userMsg(['<environment_context>\n<cwd>C:/repo</cwd>\n</environment_context>', 'fix the build', '<in-app-browser-context>tab</in-app-browser-context>']);
  assert.equal(codexUserText(rec), 'fix the build');
  assert.equal(codexUserText(userMsg(['# AGENTS.md instructions for C:/repo\n\nrules', '<recommended_plugins>list</recommended_plugins>'])), null);
});

test('the IDE extension wrapper keeps only the request, and a wrapper with no request is context', () => {
  const wrapped = '# Context from my IDE setup:\n\n## Active file: src/app.ts\n\n## Open tabs:\n- app.ts\n\n## My request for Codex:\nwhy does the build fail\n';
  assert.equal(codexUserText(userMsg([wrapped])), 'why does the build fail');
  const mentioned = '# Files mentioned by the user:\n\n## notes.md: /path/to/your/repo/notes.md\n\n## My request for Codex:\nsummarize these';
  assert.equal(codexUserText(userMsg([mentioned])), 'summarize these');
  assert.equal(codexUserText(userMsg(['# Context from my IDE setup:\n\n## Active file: src/app.ts'])), null);
  // A person's own markdown heading is not the IDE wrapper.
  assert.equal(codexUserText(userMsg(['# Plan\nship it'])), '# Plan\nship it');
});

test('a machine-authored block rejects the whole message', () => {
  for (const marker of [
    '<codex_delegation>\n<source_thread_id>t</source_thread_id>',
    '<realtime_delegation>go</realtime_delegation>',
    '<heartbeat>tick</heartbeat>',
    'Automation: Project task change monitor',
    '<!-- command:dispatched-packet -->',
    '>>> APPROVAL REQUEST START',
    'The following is the Codex agent history',
  ]) {
    assert.equal(codexUserText(userMsg([marker, 'text that rides along with it'])), null, marker);
  }
});

test('the legacy event_msg shape is still read', () => {
  const rec = { type: 'event_msg', payload: { type: 'user_message', message: 'legacy request' } };
  assert.equal(codexUserText(rec), 'legacy request');
  assert.equal(codexAssistantText({ type: 'event_msg', payload: { type: 'agent_message', message: 'legacy reply' } }), 'legacy reply');
});

test('assistant text comes from the assistant message, never from inter-agent messages', () => {
  assert.equal(codexAssistantText(asstMsg('here is the fix')), 'here is the fix');
  const interAgent = { type: 'response_item', payload: { type: 'agent_message', author: '/root/review', content: [{ type: 'input_text', text: 'FINAL_ANSWER' }] } };
  assert.equal(codexAssistantText(interAgent), null);
  assert.equal(codexUserText(interAgent), null);
});

test('a turn written in both shapes is counted once, a repeated turn in one shape twice', () => {
  const read = createCodexTurnReader();
  const legacy = { type: 'event_msg', payload: { type: 'user_message', message: 'same words' } };
  assert.equal(read(userMsg(['same words'])).user, 'same words');
  assert.equal(read(legacy).user, null);
  // The same words typed again later, in the same shape, are a new turn.
  assert.equal(read(userMsg(['same words'])).user, 'same words');
  assert.equal(read(userMsg(['same words'])).user, 'same words');
});

test('the miner probe finds a first human turn past 64 KB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'honestweek-codex-probe-'));
  try {
    const f = join(dir, 'rollout-a.jsonl');
    const plugins = userMsg(['<recommended_plugins>' + 'p'.repeat(40_000) + '</recommended_plugins>']);
    writeFileSync(f, jsonl(bigMeta(), plugins, userMsg(['<environment_context>e</environment_context>']), userMsg(['why does the installer crash'], '2026-09-08T17:41:00.000Z')));
    const probe = probeSession('codex', f);
    assert.ok(probe, 'probe found a session');
    assert.equal(probe.firstPrompt, 'why does the installer crash');
    assert.equal(probe.firstPromptISO, '2026-09-08T17:41:00.000Z');
    assert.equal(probe.cwd, 'C:/repo');
    assert.equal(probe.isSubagent, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session whose only user messages are machine-authored has no identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'honestweek-codex-delegated-'));
  try {
    const f = join(dir, 'rollout-a.jsonl');
    writeFileSync(f, jsonl(bigMeta(), userMsg(['<codex_delegation>do it</codex_delegation>', 'please check the repo']), asstMsg('done')));
    assert.equal(probeSession('codex', f), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the miner stream reads current-shape human and assistant turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'honestweek-codex-stream-'));
  try {
    const f = join(dir, 'rollout-a.jsonl');
    writeFileSync(
      f,
      jsonl(
        bigMeta(),
        userMsg(['<environment_context>e</environment_context>']),
        userMsg(['work out why the service fails']),
        asstMsg('checking the service'),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'Get-Service Acme' } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Script failed\nExit code: 1' } },
      ),
    );
    const { events } = await streamSession('codex', f);
    assert.deepEqual(events.map((e) => e.kind), ['human', 'assistant', 'tool_use', 'result']);
    assert.equal(events[0].text, 'work out why the service fails');
    assert.equal(events[3].isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the codex corpus is no longer blind on current-shape logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'honestweek-codex-corpus-'));
  try {
    mkdirSync(join(dir, 'sessions', '2026', '09', '08'), { recursive: true });
    writeFileSync(join(dir, 'sessions', '2026', '09', '08', 'rollout-a.jsonl'), jsonl(bigMeta(), userMsg(['why does the tool crash'])));
    const { sessions, diagnostics } = enumerateSessions({ corpora: ['codex'], env: { ...process.env, CODEX_HOME: dir } });
    assert.equal(sessions.length, 1);
    const row = diagnostics.corpora.find((d) => d.root.endsWith('sessions') && d.filesFound === 1);
    assert.ok(row, 'diagnostics row for the sessions root');
    assert.equal(row.probeFailed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt collector reads current-shape Codex turns and numbers them once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'honestweek-codex-prompts-'));
  try {
    const project = join(root, 'project');
    const codex = join(root, 'codex');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(codex, 'sessions'), { recursive: true });
    writeFileSync(
      join(codex, 'sessions', 's.jsonl'),
      jsonl(
        { type: 'session_meta', payload: { id: 'x', cwd: project } },
        userMsg(['# AGENTS.md instructions for the project'], '2024-06-11T00:00:00.000Z'),
        userMsg(['first real request'], '2024-06-11T00:01:00.000Z'),
        { type: 'event_msg', timestamp: '2024-06-11T00:01:00.000Z', payload: { type: 'user_message', message: 'first real request' } },
        userMsg(['<codex_delegation>x</codex_delegation>', 'riding along'], '2024-06-11T00:02:00.000Z'),
        userMsg(['second real request'], '2024-06-11T00:03:00.000Z'),
      ),
    );
    const config = normalizeConfig(
      { identity: { authorEmails: ['you@example.com'] }, week: { timezone: 'UTC' }, repos: [{ path: project, label: 'your-project', role: 'featured' }] },
      { configDir: root },
    );
    const got = await scanPromptSources({
      config,
      weekStart: new Date('2024-06-10T00:00:00Z'),
      weekEnd: new Date('2024-06-17T00:00:00Z'),
      roots: { 'claude-code': join(root, 'missing'), codex },
      now: new Date('2024-06-17T00:00:00Z'),
    });
    assert.deepEqual(got.prompts.map((p) => [p.text, p.turn]), [['first real request', 1], ['second real request', 2]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
