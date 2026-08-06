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
  const corpus = extra.includes('--corpus') ? [] : ['--corpus', 'claude-code'];
  const args = [CLI, 'mine', '--config', fx.configPath, '--ledger', fx.ledger, '--json', ...corpus, ...extra];
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

test('the ledger is written through the configured redactor, not just de-identified', () => {
  // The redactor was built inside the --draft branch at first, so a plain run wrote the
  // ledger with de-identification alone. de-identify handles paths and this machine's
  // account name; it knows nothing about the user's own denylist. Three places tell the
  // user to COMMIT this file because it was redacted, so the gap was a published leak.
  const fx = fixture();
  const cfg = JSON.parse(readFileSync(fx.configPath, 'utf8'));
  cfg.redaction = { codenames: ['Acme'], names: [], terms: [] };
  writeFileSync(fx.configPath, JSON.stringify(cfg, null, 2));

  runMine(fx);
  const raw = readFileSync(fx.ledger, 'utf8');
  // honestweek's redactor matches whole words, by design — a longer identifier that
  // merely contains the term (`AcmeVMService`) is not a leak of the configured term
  // and is left alone. What must not survive is the term itself.
  assert.ok(!/\bAcme\b/.test(raw), 'a configured codename reached the ledger unredacted');
  assert.match(raw, /\[redacted/, 'expected the redactor to have visibly run');
  rmSync(fx.dir, { recursive: true, force: true });
});

test('--decide works on a key containing an equals sign', () => {
  // Finding keys are normalized error strings and routinely contain "=". Splitting on
  // the FIRST "=" made those findings undecidable, which disables the only mechanism
  // that can lower the backlog.
  const fx = fixture();
  runMine(fx);
  const ledger = JSON.parse(readFileSync(fx.ledger, 'utf8'));
  ledger.findings[0].key = 'error: bind failed code=#';
  writeFileSync(fx.ledger, JSON.stringify(ledger, null, 2));

  execFileSync(process.execPath, [CLI, 'mine', '--config', fx.configPath, '--ledger', fx.ledger, '--decide', 'error: bind failed code=#=declined'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: fx.dir },
  });
  const after = JSON.parse(readFileSync(fx.ledger, 'utf8'));
  assert.equal(after.findings[0].status, 'declined');
  rmSync(fx.dir, { recursive: true, force: true });
});

test('--decide rejects a bad status by name instead of throwing', () => {
  const fx = fixture();
  runMine(fx);
  const key = JSON.parse(readFileSync(fx.ledger, 'utf8')).findings[0].key;
  let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'mine', '--config', fx.configPath, '--ledger', fx.ledger, '--decide', `${key}=maybe`], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: fx.dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('should have exited non-zero');
  } catch (err) {
    stderr = String(err.stderr);
  }
  assert.match(stderr, /unknown finding status/);
  assert.match(stderr, /published/, 'the error should name the valid statuses');
  rmSync(fx.dir, { recursive: true, force: true });
});

test('an explicitly requested corpus with no root at all is blind, not quiet', () => {
  // A corpus whose roots do not exist used to produce NO diagnostics row, so the
  // blind check could not see it: `--corpus cowork` on a machine without cowork
  // printed an empty table and exited 0 — a zero from a sensor that never looked.
  const fx = fixture();
  const args = [CLI, 'mine', '--config', fx.configPath, '--ledger', fx.ledger, '--json', '--corpus', 'cowork'];
  let out;
  let code = 0;
  try {
    out = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: fx.dir, APPDATA: join(fx.dir, 'no-such-appdata') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    code = err.status;
    out = err.stdout;
  }
  const json = JSON.parse(out);
  assert.equal(code, 2, 'asking for a corpus and getting nothing back is a fault');
  assert.deepEqual(json.blindCorpora, ['cowork']);
  assert.ok(json.diagnostics.corpora.length >= 1, 'a requested corpus must always appear in diagnostics');
  rmSync(fx.dir, { recursive: true, force: true });
});

test('a corpus merely absent from the default sweep is not a fault', () => {
  // The inverse of the case above: not having a tool installed is normal.
  const fx = fixture();
  const { code, json } = runMine(fx, [], { env: { APPDATA: join(fx.dir, 'no-such-appdata'), CODEX_HOME: join(fx.dir, 'no-such-codex') } });
  assert.equal(code, 0);
  assert.equal(json.sensorOk, true);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('an unknown option fails loudly instead of being ignored', () => {
  const fx = fixture();
  const r = runMine(fx, ['--not-a-flag']);
  assert.equal(r.code, 1);
  assert.match(String(r.stderr), /unknown option/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('a mistyped --corpus fails loudly instead of scanning nothing', () => {
  // `--corpus claud-code` used to resolve to zero corpora and zero diagnostics rows,
  // so sensorOk stayed true and the command exited 0 — a sensor that never looked,
  // reporting a quiet week.
  const fx = fixture();
  const r = runMine(fx, ['--corpus', 'claud-code']);
  assert.equal(r.code, 1);
  assert.match(String(r.stderr), /unknown corpus "claud-code"/);
  assert.match(String(r.stderr), /claude-code, codex, cowork/, 'the error must name the valid list');
  const empty = runMine(fx, ['--corpus', '']);
  assert.equal(empty.code, 1, 'an empty --corpus value is a mistake, not "all"');
  rmSync(fx.dir, { recursive: true, force: true });
});

test('garbage values for value-taking flags fail loudly instead of degrading', () => {
  // --threshold abc became NaN, so every finding failed `score >= NaN` and the run
  // exited 0 reporting a quiet week; --since abc became an Invalid Date whose
  // comparisons are all false, silently disabling the filter. Same class as an
  // unknown option: bad invocation, exit 1.
  const fx = fixture();
  const th = runMine(fx, ['--threshold', 'abc']);
  assert.equal(th.code, 1);
  assert.match(String(th.stderr), /--threshold expects a number/);
  const since = runMine(fx, ['--since', 'not-a-date']);
  assert.equal(since.code, 1);
  assert.match(String(since.stderr), /--since expects an ISO date/);
  const bare = runMine(fx, ['--decide']);
  assert.equal(bare.code, 1, 'a value-taking flag with no value is a mistake, not a default');
  assert.match(String(bare.stderr), /--decide expects a value/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('a corpus whose files cannot be probed is blind, not quiet', () => {
  // An upstream log-format change makes every probe fail while filesFound stays
  // high. That used to exit 0 with zero sessions — a sensor that no longer
  // understands the dialect, reporting a quiet week.
  const fx = fixture();
  writeFileSync(join(fx.projects, 'C--repo', 'session.jsonl'), 'not json at all\n');
  const { code, json } = runMine(fx);
  assert.equal(code, 2);
  assert.deepEqual(json.blindCorpora, ['claude-code']);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('a probed-but-date-filtered window is quiet, not blind', () => {
  // The inverse guard: files probed fine but skipped by --since must stay exit 0.
  // Only probe FAILURES mean blindness; a filtered window is a legitimate zero.
  const fx = fixture();
  const since = new Date(Date.now() + 3600 * 1000).toISOString();
  const { code, json } = runMine(fx, ['--since', since]);
  assert.equal(code, 0, JSON.stringify(json?.blindCorpora));
  assert.equal(json.sensorOk, true);
  assert.equal(json.diagnostics.corpora[0].filesProbed, 1, 'the file must actually have been probed');
  rmSync(fx.dir, { recursive: true, force: true });
});

test('an explicit --config that is unusable fails loudly, never a silent downgrade', () => {
  // Continuing without the named config would disable mine.ownRepos (own-repo issues
  // would rank as third-party evidence) and the redaction denylist — in a run whose
  // ledger the docs say to commit BECAUSE it was redacted.
  const fx = fixture();
  writeFileSync(fx.configPath, '{ not json');
  const malformed = runMine(fx);
  assert.equal(malformed.code, 1);
  assert.match(String(malformed.stderr), /unusable config/);

  writeFileSync(fx.configPath, JSON.stringify({ identity: {} }));
  const invalid = runMine(fx);
  assert.equal(invalid.code, 1, 'schema-invalid is as unusable as malformed');
  assert.match(String(invalid.stderr), /unusable config/);

  rmSync(fx.configPath);
  const missing = runMine(fx);
  assert.equal(missing.code, 1, 'a --config that names a missing file is a fault');
  assert.match(String(missing.stderr), /unusable config/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test('an absent DEFAULT config downgrades with a note; a broken one fails', () => {
  const fx = fixture();
  const cwd = join(fx.dir, 'elsewhere');
  mkdirSync(cwd, { recursive: true });
  const args = [CLI, 'mine', '--ledger', fx.ledger, '--json', '--corpus', 'claude-code'];
  const opts = { encoding: 'utf8', cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: fx.dir }, stdio: ['ignore', 'pipe', 'pipe'] };

  // No file at the default path: mining still runs, and says what it lost.
  const out = execFileSync(process.execPath, args, opts);
  assert.equal(JSON.parse(out).sensorOk, true);

  // A file that EXISTS at the default path but cannot be loaded is a fault: the user
  // wrote a config and this run would silently ignore it.
  writeFileSync(join(cwd, 'honestweek.config.json'), '{ not json');
  try {
    execFileSync(process.execPath, args, opts);
    assert.fail('should have exited non-zero');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /unusable config/);
  }
  rmSync(fx.dir, { recursive: true, force: true });
});
