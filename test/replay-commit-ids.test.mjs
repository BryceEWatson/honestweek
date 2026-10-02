// A commit id made only of digits is still a commit id. About 1 in 280 twelve-character ids
// is all digits, and the redactor reads a bare run of nine or more digits as an account
// number, so the engine keeps commit ids out of that rule. This builds a real repository
// whose commit id starts with twelve digits and checks every place the id comes back.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';

const ME = 'you@example.com';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MESSAGE = 'Add the date filter';
// Numbers a tool payload might file under commit-id key names.
const LOOKALIKE = { account: '987654321098', sha: '123456789012', card: '4111111111111111' };

let dir;
let sha;
let h;

/** The commit id git gives an empty-tree commit made at `t` (seconds), computed without git. */
function commitIdAt(t) {
  const body = `tree ${EMPTY_TREE}\nauthor You <${ME}> ${t} +0000\ncommitter You <${ME}> ${t} +0000\n\n${MESSAGE}\n`;
  return createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hw-digit-sha-'));
  const repo = join(dir, 'your-project');
  mkdirSync(repo);
  // A commit time whose id starts with twelve digits.
  let t = Date.parse('2025-03-11T09:00:00Z') / 1000;
  while (!/^\d{12}/.test(commitIdAt(t))) t += 1;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'You', GIT_AUTHOR_EMAIL: ME, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_NAME: 'You', GIT_COMMITTER_EMAIL: ME, GIT_COMMITTER_DATE: `${t} +0000` };
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  // SHA-1 object ids even where a global setting asks for SHA-256.
  git(['init', '-q', '--object-format=sha1']);
  sha = git(['commit-tree', '--no-gpg-sign', EMPTY_TREE, '-m', MESSAGE]);
  assert.equal(sha, commitIdAt(t), 'git made the commit the test computed');
  git(['update-ref', 'refs/heads/main', sha]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);

  // One session that records making that commit, and a prompt holding a long number.
  const id = '12121212-3434-4565-8787-909090909090';
  const at = (s) => new Date((t + s) * 1000).toISOString();
  const rec = (type, extra, when, uuid) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: repo, sessionId: id, version: '2.1.0', gitBranch: 'main', type, uuid, timestamp: when, ...extra });
  const lines = [
    rec('user', { message: { role: 'user', content: `Commit the date filter for invoice ${sha.slice(0, 12)} today.` }, origin: { kind: 'human' } }, at(-30), 'aaaaaaaa-0000-4000-8000-000000000001'),
    rec('assistant', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: 'toolu_commit', name: 'Bash', input: { command: `git commit -m "${MESSAGE}"` } }] } }, at(-5), 'aaaaaaaa-0000-4000-8000-000000000002'),
    rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_commit', content: '' }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha, kind: 'committed' } } } }, at(1), 'aaaaaaaa-0000-4000-8000-000000000003'),
    // A tool payload that only names its fields like commit ids: its numbers aren't commit ids.
    rec('assistant', { message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: 'toolu_pay', name: 'mcp__billing__charge', input: { account: LOOKALIKE.account, sha: LOOKALIKE.sha, nested: { headAtStart: LOOKALIKE.card } } }] } }, at(5), 'aaaaaaaa-0000-4000-8000-000000000004'),
    rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pay', content: 'ok' }] }, toolUseResult: { sha: LOOKALIKE.card, originalHead: LOOKALIKE.sha } }, at(6), 'aaaaaaaa-0000-4000-8000-000000000005'),
  ];
  const projects = join(dir, 'claude', 'projects', '-your-project');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${id}.jsonl`), `${lines.join('\n')}\n`);

  const config = normalizeConfig({ identity: { authorEmails: [ME] }, week: { startsOn: 'monday', timezone: 'UTC' }, repos: [{ path: repo, label: 'your-project', role: 'featured' }], redaction: { codenames: [], names: [], terms: [] } }, { configDir: dir });
  h = await buildWorkHistory({ config, from: '2025-03-10', to: '2025-03-16', timezone: 'UTC', roots: { claude: [join(dir, 'claude', 'projects')], codex: [] } });
});
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold a lock on .git briefly */
  }
});

test('an all-digit commit id stays a commit id in the outcome, the call, and a lookup', () => {
  assert.match(sha, /^\d{12}/);
  const outcome = h.events.find((e) => e.kind === 'outcome' && e.facts.outcome === 'commit-exists');
  assert.ok(outcome, 'git confirmed the commit');
  assert.equal(outcome.facts.sha, sha.slice(0, 12));
  const call = h.events.find((e) => e.kind === 'action' && e.facts.git?.commit);
  assert.equal(call.facts.git.commit.sha, sha);
  const found = h.lookup(sha.slice(0, 12));
  assert.deepEqual(found.sessions.map((s) => s.session), [call.session]);
  assert.doesNotMatch(JSON.stringify(found.sessions), /redacted:account/);
  // The query echoes what was asked, so it gets the plain redactor.
  assert.equal(found.query.sha, '[redacted:account]');
});

test('a raw record read back keeps every long number redacted, whatever its key is called', () => {
  for (const e of h.events.filter((x) => x.session === h.sessions[0].key)) {
    for (const r of h.record(e.id)) {
      const body = JSON.stringify(r.record ?? {});
      // (The full 40-character id, letters and all, is spared everywhere, as on main.)
      for (const n of [LOOKALIKE.account, LOOKALIKE.sha, LOOKALIKE.card]) assert.ok(!body.includes(n), `${e.id} shows ${n}`);
    }
  }
});

test('the same digits in free text are still redacted as an account number', () => {
  const prompt = h.events.find((e) => e.kind === 'prompt');
  assert.match(prompt.facts.text, /invoice \[redacted:account\]/);
  assert.ok(!prompt.facts.text.includes(sha.slice(0, 12)));
});
