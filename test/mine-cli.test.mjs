// test/mine-cli.test.mjs — the command, end to end, against a synthetic corpus.
//
// The exit-code contract is the point of this file. A miner that returns 0 while its
// sensor is blind teaches its operator to read "0 findings" as "a quiet week", which
// is precisely how a control loop dies quietly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CLI = new URL('../bin/honestweek.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const jsonl = (...r) => r.map((x) => JSON.stringify(x)).join('\n') + '\n';

/**
 * A synthetic corpus holding exactly one solved third-party failure.
 *
 * Modelled on what a genuinely publishable session looks like rather than on the
 * minimum that trips the classifier: repeated searching that did not resolve it, a
 * version worth naming, a bug filed upstream. A thinner fixture scored 16 against a
 * bar of 20 — correctly, since a thin session is not worth publishing. The fixture
 * was the thing that was wrong, not the bar.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-mine-cli-'));
  const projects = join(dir, 'projects', 'C--repo');
  mkdirSync(projects, { recursive: true });
  const search = (q) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: q } }] } });
  writeFileSync(
    join(projects, 'session.jsonl'),
    jsonl(
      { type: 'user', message: { role: 'user', content: 'Acme will not start on this machine, work out why' }, timestamp: '2026-06-01T10:00:00.000Z', cwd: 'C:/repo' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'Get-Service AcmeVMService' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'Get-WinEvent -LogName Application -MaxEvents 20' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:/Users/Someone/AppData/Roaming/Acme/logs/vm.log' } }] } },
      search('Acme VM service not running windows'),
      search('AcmeVMService failed to start'),
      search('Acme workspace will not start 1.25927.0.0'),
      search('Acme vm service event log 7024'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              // The two-line shape a real product prints: a headline and a cause.
              content: "Failed to start Acme's workspace 1.25927.0.0\nVM service not running. The service failed to start.",
            },
          ],
        },
        timestamp: '2026-06-01T10:05:00.000Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: 'I have filed a bug for this: https://github.com/acmeco/app/issues/4102' },
        timestamp: '2026-06-01T10:20:00.000Z',
      },
      { type: 'user', message: { role: 'user', content: 'that worked, it is running now' }, timestamp: '2026-06-01T10:30:00.000Z' },
    ),
  );

  const config = {
    identity: { authorEmails: ['a@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: dir, label: 'repo', role: 'featured' }],
    output: { mode: 'digest', file: 'out.md' },
    mine: { draft: { dir: join(dir, 'drafts'), frontmatter: { title: '', date: '', tags: [], lastVerified: '' } } },
  };
  const configPath = join(dir, 'honestweek.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { dir, projects: join(dir, 'projects'), configPath, ledger: join(dir, 'findings.json') };
}

function runMine(fx, extra = [], { env = {} } = {}) {
  const args = [CLI, 'mine', '--config', fx.configPath, '--ledger', fx.ledger, '--json', '--corpus', 'claude-code', ...extra];
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: fx.dir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.status, json: err.stdout ? JSON.parse(err.stdout) : null, stderr: err.stderr };
  }
}

test('mine is a registered subcommand with its own help', () => {
  const out = execFileSync(process.execPath, [CLI, 'mine', '--help'], { encoding: 'utf8' });
  assert.match(out, /honestweek mine/);
  assert.match(out, /--draft/);
  const root = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(root, /^\s+mine\s/m, 'mine must appear in the top-level command list');
});

test('finds a solved third-party failure and puts it in the backlog', () => {
  const fx = fixture();
  const { code, json } = runMine(fx);
  assert.equal(code, 0);
  assert.equal(json.sensorOk, true);
  assert.equal(json.signal.backlog, 1, JSON.stringify(json.publishable));
  // Which of the two error lines leads is the ranker's call — both are real, and it
  // picks the more searchable one. What matters is that the finding is about the
  // failure and not about something else in the session.
  assert.match(json.publishable[0].primaryError, /Failed to start Acme's workspace|VM service not running/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('--draft writes a real file and moves the finding to drafted', () => {
  const fx = fixture();
  const { json } = runMine(fx, ['--draft']);
  assert.ok(json.drafted, 'expected a draft');
  assert.ok(existsSync(json.drafted.path), `draft file missing at ${json.drafted.path}`);
  const body = readFileSync(json.drafted.path, 'utf8');
  assert.match(body, /Failed to start Acme.s workspace|VM service not running/);
  assert.match(body, /^lastVerified: "" #/m);
  assert.match(body, /\*\*UNVERIFIED\*\*/);

  const ledger = JSON.parse(readFileSync(fx.ledger, 'utf8'));
  assert.equal(ledger.findings[0].status, 'drafted');
  assert.equal(json.signal.backlog, 1, 'drafting does not decide anything, so the backlog holds');
  rmSync(fx.dir, { recursive: true, force: true });
});

test('--decide clears the backlog and the decision survives a re-run', () => {
  const fx = fixture();
  const first = runMine(fx, ['--draft']);
  const key = first.json.publishable[0].key;

  execFileSync(process.execPath, [CLI, 'mine', '--config', fx.configPath, '--ledger', fx.ledger, '--decide', `${key}=declined`], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: fx.dir },
  });

  const after = runMine(fx);
  assert.equal(after.json.signal.backlog, 0, 'a declined finding must not come back');
  assert.equal(after.json.merge.suppressed, 1);
  assert.equal(after.json.signal.counts.declined, 1);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('a blind sensor exits 2, so a zero can never be read as a quiet week', () => {
  const fx = fixture();
  rmSync(join(fx.projects, 'C--repo'), { recursive: true, force: true });
  mkdirSync(join(fx.projects, 'C--repo'), { recursive: true }); // root exists, no logs
  const { code, json } = runMine(fx);
  assert.equal(code, 2);
  assert.equal(json.sensorOk, false);
  assert.deepEqual(json.blindCorpora, ['claude-code']);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('the run record says what was seen, not just what was found', () => {
  const fx = fixture();
  runMine(fx);
  const ledger = JSON.parse(readFileSync(fx.ledger, 'utf8'));
  const run = ledger.runs.at(-1);
  assert.ok(run.at);
  assert.equal(run.sessionsScanned, 1);
  assert.ok(run.corpusFloor, 'the retention floor bounds what could ever be found');
  assert.ok(Array.isArray(run.corpora) && run.corpora[0].filesFound >= 1);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('an unknown option fails loudly instead of being ignored', () => {
  const fx = fixture();
  const r = runMine(fx, ['--not-a-flag']);
  assert.equal(r.code, 1);
  assert.match(String(r.stderr), /unknown option/);
  rmSync(fx.dir, { recursive: true, force: true });
});
