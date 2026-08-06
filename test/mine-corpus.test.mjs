// test/mine-corpus.test.mjs — reading three on-disk dialects without miscounting.
//
// Every case here is a shape that was observed in the real corpora. The array-shaped
// user turn matters most: 1,106 of 2,606 Claude Code session files on the machine this
// was built against carry their first human turn that way, and a reader that only
// accepts string content drops 42% of the corpus while reporting a confident number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enumerateSessions, humanText, isHumanText, probeSession, sessionKey, streamSession } from '../lib/mine/corpus.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'hw-corpus-'));
}
const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const userString = (text, ts = '2026-06-01T10:00:00.000Z') => ({ type: 'user', message: { role: 'user', content: text }, timestamp: ts, cwd: 'C:/repo' });
const userArray = (text, ts = '2026-06-01T10:00:00.000Z') => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  timestamp: ts,
  cwd: 'C:/repo',
});

// ---------------------------------------------------------------------------
// Human-turn recognition
// ---------------------------------------------------------------------------

test('humanText reads both the string and the array shape', () => {
  assert.equal(humanText('hello'), 'hello');
  assert.equal(humanText([{ type: 'text', text: 'hello' }]), 'hello');
});

test('humanText refuses a tool result wrapped as a user record', () => {
  assert.equal(humanText([{ type: 'tool_result', tool_use_id: 'x', content: 'output' }]), '');
  assert.equal(humanText([{ type: 'text', text: 'hi' }, { type: 'tool_result', tool_use_id: 'x' }]), '');
});

test('isHumanText rejects every injected pseudo-prompt shape', () => {
  const injected = [
    '<system-reminder>do a thing</system-reminder>',
    '<command-name>/loop</command-name>',
    '<task-notification><task-id>1</task-id></task-notification>',
    '<codex_delegation><input>build this</input></codex_delegation>',
    'Project: some-project (code)\nGit: branch master, 3 uncommitted',
    'You are a helpful reviewing agent. Your task is to find bugs.',
    '   ',
  ];
  for (const t of injected) assert.equal(isHumanText(t), false, `should have rejected: ${t.slice(0, 40)}`);
});

test('isHumanText keeps a real prompt that merely opens with a reminder', () => {
  assert.equal(isHumanText('<system-reminder>context</system-reminder>\nfix the failing build'), true);
});

// ---------------------------------------------------------------------------
// Probing and dedupe
// ---------------------------------------------------------------------------

test('probeSession finds the first human turn in the array shape', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, jsonl({ type: 'ai-title', title: 'x' }, userArray('why will this not start')));
  const p = probeSession('claude-code', f);
  assert.equal(p.firstPrompt, 'why will this not start');
  assert.equal(p.cwd, 'C:/repo');
  rmSync(dir, { recursive: true, force: true });
});

test('probeSession skips past an automated probe to the real first prompt', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, jsonl(userString('Project: thing (code)\nGit: branch main'), userString('now fix the service', '2026-06-01T10:05:00.000Z')));
  assert.equal(probeSession('claude-code', f).firstPrompt, 'now fix the service');
  rmSync(dir, { recursive: true, force: true });
});

test('a session with no human turn is not a session', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, jsonl({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
  assert.equal(probeSession('claude-code', f), null);
  rmSync(dir, { recursive: true, force: true });
});

test('the same session written twice is counted once', () => {
  const dir = tmp();
  const projects = join(dir, 'projects', 'C--repo');
  mkdirSync(projects, { recursive: true });
  const body = jsonl(userString('diagnose the service'));
  writeFileSync(join(projects, 'a.jsonl'), body);
  writeFileSync(join(projects, 'b.jsonl'), body); // a re-write of the same session

  const { sessions, diagnostics } = enumerateSessions({ corpora: ['claude-code'], roots: { 'claude-code': join(dir, 'projects') } });
  assert.equal(sessions.length, 1);
  assert.equal(diagnostics.deduped, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('sessionKey is stable across two spellings of one session', () => {
  const p = { firstPromptISO: '2026-06-01T10:00:00.000Z', startISO: null, firstPrompt: 'diagnose the service' };
  assert.equal(sessionKey(p), sessionKey({ ...p }));
});

test('diagnostics separate "looked and found nothing" from "did not look"', () => {
  const dir = tmp();
  const empty = join(dir, 'projects');
  mkdirSync(empty, { recursive: true });
  const { sessions, diagnostics } = enumerateSessions({ corpora: ['claude-code'], roots: { 'claude-code': empty } });
  assert.equal(sessions.length, 0);
  const d = diagnostics.corpora[0];
  assert.equal(d.present, true, 'the root exists');
  assert.equal(d.filesFound, 0, 'and yielded nothing — which the caller must be able to see');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Streaming, per dialect
// ---------------------------------------------------------------------------

test('streams a Claude Code session into normalized events', async () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(
    f,
    jsonl(
      userString('why is it broken'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'Get-Service Acme' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Acme not running', is_error: true }] } },
    ),
  );
  const { events } = await streamSession('claude-code', f);
  assert.deepEqual(events.map((e) => e.kind), ['human', 'tool_use', 'result']);
  assert.equal(events[1].text, 'Get-Service Acme');
  assert.equal(events[2].isError, true);
  rmSync(dir, { recursive: true, force: true });
});

test('streams a Codex rollout, including its shell wrapper failure banner', async () => {
  const dir = tmp();
  const f = join(dir, 'rollout-x.jsonl');
  writeFileSync(
    f,
    jsonl(
      { timestamp: '2026-08-01T00:00:00.000Z', type: 'session_meta', payload: { cwd: 'C:/repo', cli_version: '0.144.6', source: 'exec' } },
      { timestamp: '2026-08-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'work out why the service fails' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'tools.shell_command({command:"Get-Service Acme"})' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script failed\nExit code: 1\nAcme not running' }] } },
    ),
  );
  const p = probeSession('codex', f);
  assert.equal(p.firstPrompt, 'work out why the service fails');
  assert.equal(p.cwd, 'C:/repo');
  const { events } = await streamSession('codex', f);
  assert.deepEqual(events.map((e) => e.kind), ['human', 'tool_use', 'result']);
  assert.equal(events[2].isError, true, 'Codex has no is_error flag; its banner is the signal');
  rmSync(dir, { recursive: true, force: true });
});

test('a Codex subagent fork is not counted as a session', () => {
  const dir = tmp();
  const f = join(dir, 'rollout-sub.jsonl');
  writeFileSync(
    f,
    jsonl(
      { timestamp: '2026-08-01T00:00:00.000Z', type: 'session_meta', payload: { cwd: 'C:/repo', forked_from_id: 'parent', source: { subagent: { thread_spawn: {} } } } },
      { timestamp: '2026-08-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'do the delegated thing' } },
    ),
  );
  assert.equal(probeSession('codex', f).isSubagent, true);
  rmSync(dir, { recursive: true, force: true });
});

test('a Cowork enqueue event is a human turn', async () => {
  const dir = tmp();
  const f = join(dir, 'audit.jsonl');
  writeFileSync(f, jsonl({ type: 'queue-operation', operation: 'enqueue', content: 'fix the workspace', timestamp: '2026-03-01T00:00:00.000Z' }));
  assert.equal(probeSession('cowork', f).firstPrompt, 'fix the workspace');
  const { events } = await streamSession('cowork', f);
  assert.deepEqual(events, [{ kind: 'human', text: 'fix the workspace' }]);
  rmSync(dir, { recursive: true, force: true });
});

test('subagent transcripts are never enumerated as sessions', () => {
  const dir = tmp();
  const proj = join(dir, 'projects', 'C--repo');
  mkdirSync(join(proj, 'sess', 'subagents'), { recursive: true });
  writeFileSync(join(proj, 'main.jsonl'), jsonl(userString('the real prompt')));
  writeFileSync(join(proj, 'sess', 'subagents', 'agent-1.jsonl'), jsonl(userString('a task given to an agent', '2026-06-02T10:00:00.000Z')));
  const { sessions } = enumerateSessions({ corpora: ['claude-code'], roots: { 'claude-code': join(dir, 'projects') } });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].firstPrompt, 'the real prompt');
  rmSync(dir, { recursive: true, force: true });
});
