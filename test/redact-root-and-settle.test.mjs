// Three redactor fixes, each only hiding more than before:
// - issue 85: a `/root/…` home path is hidden like other home folders, while Codex's agent
//   addresses (`/root`, `/root/wide_fixtures`) stay readable where they come from its agent fields;
// - issue 80, first case: a header's value that is only a placeholder, glued to a quote and more
//   text (`Authorization=[redacted:secret]'xk9…`), is hidden whole;
// - issue 80, second case: JSON-escaped text with nested sensitive keys that a second pass used
//   to change is settled on the first. Made-up values.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { createRedactor, createSecretsOnlyRedactor, redactWithAudit, replayRedactions } from '../lib/redact.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { createLeakCounter } from '../lib/view/leaks.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

/** The published scrubber's, the secrets-only scrubber's and the audit's text for `input`, after
 *  checking that each is settled, that the audit's ops replay to its text, and that the published
 *  scrubber leaves the audit's text as it is (what digest prepare checks). */
function threeSettled(input) {
  const published = createRedactor().redact(input);
  const secretsOnly = createSecretsOnlyRedactor().redact(input);
  const audit = redactWithAudit(input, {});
  assert.equal(createRedactor().redact(published), published, `published, a second pass: ${JSON.stringify(input)}`);
  assert.equal(createSecretsOnlyRedactor().redact(secretsOnly), secretsOnly, `secrets-only, a second pass: ${JSON.stringify(input)}`);
  assert.equal(replayRedactions(input, audit.redactionOps), audit.text, `the audit's ops replay: ${JSON.stringify(input)}`);
  assert.equal(createRedactor().redact(audit.text), audit.text, `the audit's text is settled: ${JSON.stringify(input)}`);
  return { published, secretsOnly, audit };
}

test('a /root/… home path is hidden by the published scrubber and the audit, and shown on this machine\'s private screen', () => {
  for (const input of ['see /root/notes/client-plan.md now', 'cd /root/acme && ls', 'PATH=/usr/bin:/root/bin', '{"cwd":"/root/acme-site"}']) {
    const { published, secretsOnly, audit } = threeSettled(input);
    for (const out of [published, audit.text]) {
      assert.match(out, /\[redacted:path\]/, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
      assert.doesNotMatch(out, /client-plan|acme|\/root\/bin/, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    }
    assert.ok(audit.redactionOps.some((op) => op.detector === 'home-path'), 'the audit records it as a home path');
    assert.ok(audit.rawDetectors.includes('home-path'));
    assert.equal(secretsOnly, input, 'the secrets-only scrubber shows home paths');
  }
});

test('the root agent "/root", and text that only looks like a /root path, are left as written', () => {
  for (const input of ['the root agent is "/root"', 'cd /root', '/var/root/x and ./root/y', 'https://example.com/root/z', 'a2a/root/x']) {
    const { published, audit } = threeSettled(input);
    assert.equal(published, input);
    assert.equal(audit.text, input);
  }
});

test("the view's leak count finds a /root path, but not a value that is one whole Codex agent address", () => {
  const leaks = createLeakCounter({});
  assert.equal(leaks.redacted({ text: 'opened /root/notes/client-plan.md' }).paths, 1);
  assert.equal(leaks.redacted({ author: '/root/wide_fixtures', recipient: '/root' }).paths, 0);
});

test('a /root path in a prompt is hidden while the Codex agent addresses beside it stay readable', async () => {
  const root = makeTempDir('honestweek-root-path-');
  try {
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    const dir = join(root, 'codex', 'sessions', '2024', '06', '11');
    mkdirSync(dir, { recursive: true });
    const P = '0190a1b2-0000-7000-8000-0000000000a1';
    const K = '0190a1b2-0000-7000-8000-0000000000b2';
    const rec = (ts, type, payload) => JSON.stringify({ timestamp: `2024-06-11T10:${ts}.000Z`, type, payload });
    writeFileSync(join(dir, `rollout-2024-06-11T10-00-00-${P}.jsonl`), [
      rec('00:00', 'session_meta', { id: P, cwd: project, originator: 'codex_vscode', cli_version: '0.1.0', source: 'vscode' }),
      rec('00:01', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compare /root/notes/client-plan.md with the fixtures' }] }),
      rec('00:02', 'response_item', { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ message: 'Write fixtures', agent_type: 'worker' }), call_id: 'spawn' }),
      rec('00:03', 'response_item', { type: 'function_call_output', call_id: 'spawn', output: JSON.stringify({ task_name: '/root/wide_fixtures', nickname: 'Fixtures' }) }),
      rec('00:09', 'response_item', { type: 'agent_message', author: '/root/wide_fixtures', recipient: '/root', content: [{ type: 'input_text', text: 'Fixtures written.' }] }),
    ].join('\n') + '\n');
    writeFileSync(join(dir, `rollout-2024-06-11T10-00-04-${K}.jsonl`), [
      rec('00:04', 'session_meta', { id: K, cwd: project, originator: 'codex_vscode', cli_version: '0.1.0', source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_path: '/root/wide_fixtures', agent_nickname: 'Fixtures' } } } }),
      rec('00:05', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write fixtures.' }] }),
      rec('00:06', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixtures written.' }] }),
    ].join('\n') + '\n');
    const config = normalizeConfig({ identity: { authorEmails: ['you@example.com'] }, week: { timezone: 'UTC' }, repos: [{ path: project, label: 'your-project', role: 'featured' }] }, { configDir: root });
    const h = await buildWorkHistory({ config, from: '2024-06-10', to: '2024-06-16', timezone: 'UTC', roots: { claude: [join(root, 'claude')], codex: [join(root, 'codex')] }, git: false });
    const prompt = h.events.find((e) => e.kind === 'prompt');
    assert.equal(prompt.facts.text, 'compare [redacted:path] with the fixtures');
    const between = h.events.find((e) => e.kind === 'agent-message' && e.facts.direction === 'between-agents');
    assert.deepEqual([between.facts.author, between.facts.recipient], ['/root/wide_fixtures', '/root']);
    assert.ok(h.events.some((e) => e.kind === 'session' && e.facts.agentPath === '/root/wide_fixtures'), "the child thread's own address");
  } finally {
    removeTempDir(root);
  }
});

test("issue 80, first case: a header's placeholder glued to a quote and more text is hidden whole, by all three", () => {
  for (const input of ["Authorization=[redacted:secret]'xk9mp2qrz7", 'Authorization=[redacted:secret]"xk9mp2qrz7', "Cookie=[redacted:secret]'xk9mp2qrz7", "Authorization: [redacted:secret]'xk9mp2qrz7 and more", "x AcmeCookie: [redacted:secret]'a1b2\"c3d4 tail"]) {
    const { published, secretsOnly, audit } = threeSettled(input);
    for (const out of [published, secretsOnly, audit.text]) {
      assert.doesNotMatch(out, /xk9mp2qrz7|a1b2|c3d4|and more|tail/, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
      assert.match(out, /^(?:x )?(?:Authorization|Cookie|AcmeCookie)[:=]/, 'the header name stays');
    }
  }
  // A quote that ends the value, with a space or punctuation after it, still ends it.
  for (const input of ["Authorization: [redacted:secret]' then retries", 'Cookie: [redacted:secret]", next']) {
    const { published } = threeSettled(input);
    assert.match(published, /then retries|, next/);
  }
});

test('issue 80, second case: JSON-escaped text with nested sensitive keys is settled on the first pass', () => {
  // Each of these changed on main's second pass; the first two showed `Tokyo_pass` on the first.
  const inputs = [
    '{\nx-api-key\\": \\"y8z=API_KEY=Xk9mP2qRz7=client_secret==\\"Tokyo_pass Tokyo_pass\\"',
    '{\nx-api-key\\": \\"Tokyo_pass==\\"API_KEY=Xk9mP2qRz7=client_secret==\\"Xk9mP2qRz7 Tokyo_pass\\"',
    '{\nx-api-key\\": \\"abc=API_KEY=\\"client_secret==\\"Xk9mP2qRz7, \\"',
    'Cookie: \\"apiKey Xk9mP2qRz7Lm4Nq8Rt2Vw6Zb3Yc5Df7Gh9Jktoken: \\"Ab3d, api.key: \\"Y8zTokyo_pass',
  ];
  for (const input of inputs) {
    const { published, secretsOnly, audit } = threeSettled(input);
    for (const out of [published, secretsOnly, audit.text]) assert.doesNotMatch(out, /Tokyo_pass|Xk9mP2qRz7/, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(createRedactor().redact(inputs[0]), '{\nx-api-key\\": \\"[redacted:secret]\\"');
});

test('text the first pass leaves as it is costs one pass, and its count is unchanged', () => {
  const r = createRedactor();
  const input = 'Plain words with nothing to hide, and a commit deadbee.';
  assert.equal(r.redact(input), input);
  assert.equal(r.count, 0);
  const once = r.redact('token=Xk9mP2qRz7 at /root/notes/x.md');
  assert.equal(once, 'token=[redacted:secret] at [redacted:path]');
  assert.equal(r.count, 2);
});
