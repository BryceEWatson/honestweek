// The failed-run claim check's four measured weaknesses (issue 248), on made-up histories and
// logs: a failing run on purpose, a claim or count mid-message, a claim written into a pull
// request or a commit, and a run's result read back from a file or a background job. Each has its
// flagged case and the unflagged partner that keeps the check quiet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { countClaims, deliberateRun, filesPutBy, rewritesPost, testsPassAnywhere, writtenClaims, writtenFiles } from '../lib/problems/classify.mjs';
import { runProblems } from '../lib/problems/index.mjs';
import { READ_BACK_RULES, runOutputFiles, sameRunFile, testRunner } from '../lib/replay/classify.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { testRunResult } from '../lib/replay/metrics.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const T0 = Date.parse('2025-03-10T09:00:00.000Z');
const WINDOW = { from: '2025-03-10', to: '2025-03-16', timezone: 'UTC', startAt: '2025-03-10T00:00:00.000Z', endAt: '2025-03-17T00:00:00.000Z', startT: Date.parse('2025-03-10T00:00:00.000Z'), endT: Date.parse('2025-03-17T00:00:00.000Z') };
const CWD = '/work/your-project';
const BUILT = Date.parse('2025-03-20T00:00:00.000Z');
const min = (m) => T0 + m * 60e3;
const FAILED = { tests: 12, pass: 11, fail: 1, parser: 'node-tap' };
const PASSED = { tests: 12, pass: 12, fail: 0, parser: 'node-tap' };

/** A turn in the engine's event shape: a prompt, then the steps given. */
function turn(steps) {
  const key = 's1';
  const events = [];
  const ev = (kind, t, facts, { derived = {}, raw, command } = {}) => {
    const line = events.length + 1;
    const e = { id: `${key}.${line}.0`, kind, t, at: new Date(t).toISOString(), source: key, session: key, agent: `${key}:main`, actor: kind === 'prompt' ? 'person' : 'agent', evidence: 'recorded', refs: [{ src: key, line }], facts, derived, inferred: [], missing: [], ...(kind === 'action' ? { end: { t: t + 2000, at: new Date(t + 2000).toISOString(), ref: { src: key, line } } } : {}) };
    if (raw) Object.defineProperty(e, '_raw', { value: raw, enumerable: false });
    if (command != null) Object.defineProperty(e, '_command', { value: command, enumerable: false });
    events.push(e);
  };
  ev('prompt', min(0), { text: 'Fix the parser.' }, { raw: { text: 'Fix the parser.' } });
  steps.forEach((s, i) => {
    const t = min(i + 1);
    if (s.say != null) ev('message', t, { text: s.say }, { raw: { text: s.say } });
    else if (s.write) ev('action', t, { tool: 'Write', category: 'edit', result: 'ok', fileKey: `fk-${s.write}` }, { raw: { input: { file_path: s.write, content: s.content }, tool: 'Write' } });
    else if (s.edit) ev('action', t, { tool: 'Edit', category: 'edit', result: 'ok', fileKey: `fk-${s.edit}` }, { raw: { input: { file_path: s.edit, old_string: 'a', new_string: 'b' }, tool: 'Edit' } });
    else {
      const runner = testRunner(s.run);
      ev('action', t, { tool: 'Bash', category: 'shell', command: s.run, result: s.result ?? (s.tests?.fail ? 'error' : 'ok'), ...(runner ? { testRunner: runner } : {}) }, { derived: s.tests ? { tests: s.tests } : {}, raw: { input: { command: s.run }, tool: 'Bash' }, command: s.run });
    }
  });
  const h = { window: WINDOW, sessions: [{ key, tool: 'claude-code', private: false, repo: 'your-project', repoRole: 'featured', endState: 'last-turn-ended', firstAt: '2025-03-10T09:00:00.000Z', lastAt: '2025-03-10T12:00:00.000Z' }], agents: [{ key: `${key}:main`, session: key, kind: 'main' }], events, lookup: () => ({ sessions: [] }) };
  Object.defineProperty(h, '_raw', { value: { cwdOfSource: new Map([[key, CWD]]) }, enumerable: false });
  return h;
}
const answer = (steps) => runProblems(turn(steps), { builtT: BUILT });
const claims = (steps) => answer(steps).patterns.find((p) => p.id === 'claim-contradicts-evidence').findings.filter((f) => f.check === 'claim-contradicts-evidence');
const statsOf = (steps) => answer(steps).checks.find((c) => c.id === 'claim-contradicts-evidence').stats;

// ---- a run that fails on purpose ------------------------------------------------------------

test('a run between putting a file in and restoring it reads as failing on purpose', () => {
  for (const cmd of [
    'cp lib/parse.mjs "$S/keep"; sed -i "s/a/b/" lib/parse.mjs; node --test test/parse.test.mjs | grep fail; cp "$S/keep" lib/parse.mjs',
    'f=lib/parse.mjs; for m in x y; do sed -i "$m" $f; node --test test/parse.test.mjs | grep fail; git checkout -- $f; done',
    'git show origin/main:lib/parse.mjs > "$S/old"; cp lib/parse.mjs "$S/new"; cp "$S/old" lib/parse.mjs; node --test | grep fail; cp "$S/new" lib/parse.mjs',
    'git checkout origin/main -- lib/parse.mjs && node --test | grep fail; git checkout HEAD -- lib/parse.mjs && git status',
    'git diff lib/parse.mjs > "$S/fix" && git checkout lib/parse.mjs && node --test; git apply "$S/fix"',
    'for f in lib/a.mjs lib/b.mjs; do git show HEAD~1:$f > $f; done && node --test | grep fail; git checkout HEAD -- lib/ && git status',
    'git stash; node --test; git stash pop',
    'S=x; rm -rf $S && git archive HEAD~1 | tar -x -C $S && cd $S && node --test',
  ]) assert.equal(deliberateRun(cmd), true, cmd);
});

test('a run with nothing put back is a real failure', () => {
  for (const cmd of [
    'node --test | tail -3',
    'npm test > "$S/log.txt" 2>&1; echo done > "$S/log.txt"', // a log file isn't the code
    'echo a > log.txt; node --test; echo b > log.txt',
    'T=$(mktemp -d) && git archive main | tar -x -C $T && cd $T && node --test', // today's code, exported
    'git checkout -- lib/parse.mjs; node --test', // put back, then run: the run tests what's left
    'node --test; git checkout -- lib/parse.mjs', // run, then restore: nothing was swapped in first
    'cp lib/parse.mjs lib/other.mjs; node --test; cp lib/other.mjs lib/third.mjs', // no one file both ways
  ]) assert.equal(deliberateRun(cmd), false, cmd);
});

test('a restore in the next step, after the edit that broke it, is the same swap', () => {
  const run = 'node --test';
  const broke = filesPutBy('sed -i "s/a/b/" lib/parse.mjs');
  assert.deepEqual(broke, ['lib/parse.mjs']);
  assert.equal(deliberateRun(run, { before: broke, nextCmd: 'git checkout -- lib/parse.mjs' }), true);
  assert.equal(deliberateRun(run, { before: broke, nextCmd: 'git checkout -- lib/other.mjs' }), false, 'another file');
  assert.equal(deliberateRun(run, { before: [], nextCmd: 'git checkout -- lib/parse.mjs' }), false, 'nothing put in before it');
  assert.equal(deliberateRun(run, { before: broke, nextCmd: null }), false, 'nothing put back after it');
  assert.equal(deliberateRun(run, { before: ['test/parse.test.mjs'], nextCmd: 'sed -i "s/a/b/" test/parse.test.mjs' }), false, 'a sed after a failure can be the fix');
  assert.equal(deliberateRun(`${run}; sed -i "s/b/a/" lib/parse.mjs`, { before: broke }), false, 'in the same line too');
  assert.equal(deliberateRun(run, { before: ['notes.txt'], nextCmd: "cat > notes.txt <<'EOF'\nnew\nEOF" }), false, 'a heredoc writes something new');
});

const BREAK_AND_RESTORE = 'cp lib/parse.mjs "$S/keep"; sed -i "s/a/b/" lib/parse.mjs; node --test | grep fail; cp "$S/keep" lib/parse.mjs';

test('the check sets a deliberate last run aside, and reads the run before it', () => {
  const flagged = claims([{ run: 'node --test', tests: FAILED }, { run: BREAK_AND_RESTORE, tests: FAILED }, { say: 'Done, all tests pass.' }]);
  assert.equal(flagged.length, 1, 'the real failure before it still counts');
  assert.equal(claims([{ run: 'node --test', tests: PASSED }, { run: BREAK_AND_RESTORE, tests: FAILED }, { say: 'Done, all tests pass.' }]).length, 0);
  assert.equal(claims([{ run: BREAK_AND_RESTORE, tests: FAILED }, { say: 'Done, all tests pass.' }]).length, 0);
  assert.equal(claims([{ run: 'node --test', tests: FAILED }, { say: 'Done, all tests pass.' }]).length, 1, 'the same run with no swap');
  const set = statsOf([{ run: BREAK_AND_RESTORE, tests: FAILED }, { say: 'Done, all tests pass.' }]);
  assert.equal(set.find((s) => /on purpose/.test(s.label))?.value, 1);
});

// ---- a claim in the middle, and a count ------------------------------------------------------

const padding = (n) => 'This part says what changed and why it changed. '.repeat(n);

test('a tests-pass claim anywhere in a long message is read, and only tests-pass claims are', () => {
  assert.equal(testsPassAnywhere(`${padding(30)}\nThe full test suite passes.\n${padding(30)}`), true);
  assert.equal(testsPassAnywhere('- **Tests:** `parser` and `reader` pass on an exported copy.'), true);
  for (const text of [
    'The parser tests pass apart from the wrap test.',
    'All tests pass except the wrap test.',
    'It lands once the tests pass.',
    'Run it, then "all tests pass" should print.',
    '```\nall tests pass\n```',
    'Tests are not passing yet.',
    '12 tests pass but 1 fails.',
  ]) assert.equal(testsPassAnywhere(text), false, text);
  assert.equal(testsPassAnywhere('The full test suite passes (12 tests, 0 failed).'), true, 'no failures is no exception');

  const fail = { run: 'node --test', tests: FAILED };
  assert.equal(claims([fail, { say: `${padding(30)}\nThe full test suite passes.\n${padding(30)}` }]).length, 1);
  assert.equal(claims([fail, { say: `${padding(30)}\nThe parser tests pass apart from the wrap test.\n${padding(30)}` }]).length, 0);
  assert.equal(claims([fail, { say: `${padding(30)}\nDone with this part.\n${padding(30)}` }]).length, 0, 'done wording mid-message stays unread');
});

test('wording that waits on a check is no claim', () => {
  const fail = { run: 'node --test', tests: FAILED };
  assert.equal(claims([fail, { say: 'It lands once CI is green.' }]).length, 0);
  assert.equal(claims([fail, { say: 'I merge it when the checks pass.' }]).length, 0);
});

test('counts stated with no failures are found, and partial ones are not', () => {
  assert.deepEqual(countClaims('the suite passes (1,843 tests, 0 failed)'), [1843]);
  assert.deepEqual(countClaims('1,021 pass, 0 fail'), [1021]);
  assert.deepEqual(countClaims('836 of 836 pass'), [836]);
  assert.deepEqual(countClaims('All 865 tests pass'), [865]);
  assert.deepEqual(countClaims('197 of 198 passed'), []);
  assert.deepEqual(countClaims('12 tests, 2 failed'), []);
  assert.deepEqual(countClaims('nothing to count'), []);
});

test('a count only a failing run shows is flagged, on any last state', () => {
  const said = { say: `${padding(30)}\nThe suite passes (12 tests, 0 failed).\n${padding(30)}` };
  const fail = { run: 'node --test', tests: FAILED };
  // The last check passed, on a smaller run: the failed branch alone never reads this message.
  const small = { run: 'node --test test/one.test.mjs', tests: { tests: 3, pass: 3, fail: 0, parser: 'node-tap' } };
  const [f] = claims([fail, small, said]);
  assert.equal(f.kind, 'states a count no run shows');
  assert.equal(f.severity, 'look');
  assert.equal(f.verdictEvidence, 'inferred');
  assert.ok(f.related, 'it links the failing run');
  assert.ok(statsOf([fail, small, said]).some((s) => /count that only a failing run shows/.test(s.label)));
});

test('a count stays quiet when a run backs it, or none was against it', () => {
  const said = { say: 'The suite passes (12 tests, 0 failed).' };
  const fail = { run: 'node --test', tests: FAILED };
  // A clean run with that count came before the message, and a later check failed on something else.
  const r = claims([{ run: 'node --test', tests: PASSED }, { run: 'npm run lint', result: 'error' }, said]);
  assert.equal(r.length, 0, 'the count is backed');
  assert.equal(statsOf([{ run: 'node --test', tests: PASSED }, { run: 'npm run lint', result: 'error' }, said]).find((s) => /backs/.test(s.label))?.value, 1);
  assert.equal(claims([{ run: 'node --test', tests: PASSED }, said]).length, 0);
  assert.equal(claims([{ run: 'node --test test/one.test.mjs', tests: { tests: 3, pass: 2, fail: 1, parser: 'node-tap' } }, { run: 'node --test test/one.test.mjs', tests: { tests: 3, pass: 3, fail: 0, parser: 'node-tap' } }, said]).length, 0, 'another count, and the last run passed');
  // The same command ran again and printed no summary: that run could back it, and can't be read.
  assert.equal(claims([fail, { run: 'node --test', result: 'ok' }, said]).filter((f) => f.kind === 'states a count no run shows').length, 0);
  // Evidence from a run failing on purpose isn't against a count.
  assert.equal(claims([{ run: BREAK_AND_RESTORE, tests: FAILED }, said]).length, 0);
});

// ---- claims written into a pull request or a commit -------------------------------------------

test('what a command writes into a pull request or a commit is read from the command', () => {
  const texts = (cmd, files) => writtenClaims(cmd, files).map((w) => [w.where, w.text]);
  assert.deepEqual(texts("gh pr create --title t --body-file - <<'EOF'\nTests pass\nEOF\n"), [['pull request body', 'Tests pass']]);
  assert.deepEqual(texts('gh pr comment 1 --body "All tests pass"'), [['pull request comment', 'All tests pass']]);
  assert.deepEqual(texts('gh pr review 1 --comment --body "Tests pass"'), [['pull request comment', 'Tests pass']]);
  assert.deepEqual(texts('git commit -q -m "Fix it\n\nAll tests pass"'), [['commit message', 'Fix it\n\nAll tests pass']]);
  assert.deepEqual(texts("git commit -F - <<'EOF'\nA body\nEOF"), [['commit message', 'A body']]);
  assert.deepEqual(texts('echo gh pr comment'), []);
  assert.deepEqual(texts('gh pr view 1'), []);
});

test('a body kept in a file is read from what this turn wrote there, and an edit drops it', () => {
  const cmd = "cat > v.md <<'EOF'\nTests: parser pass\nEOF\ngh pr comment 1 --body-file v.md";
  const files = new Map();
  writtenFiles(files, { cmd });
  assert.deepEqual(writtenClaims(cmd, files).map((w) => w.text), ['Tests: parser pass']);

  const viaTool = new Map();
  writtenFiles(viaTool, { writePath: 'body.md', writeText: 'All tests pass' });
  assert.deepEqual(writtenClaims('gh pr create --body-file body.md', viaTool).map((w) => w.text), ['All tests pass']);
  writtenFiles(viaTool, { editPath: 'body.md' });
  assert.deepEqual(writtenClaims('gh pr create --body-file body.md', viaTool), [], 'changed after it was written: unknown');
  writtenFiles(viaTool, { writePath: 'body.md', writeText: 'All tests pass' });
  writtenFiles(viaTool, { cmd: 'sed -i "s/pass/fail/" body.md' });
  assert.deepEqual(writtenClaims('gh pr create --body-file body.md', viaTool), []);
});

test('rewriting a post is told from writing one', () => {
  assert.equal(rewritesPost('gh pr comment 1 --edit-last --body-file v.md'), true);
  assert.equal(rewritesPost('gh pr edit 1 --body-file v.md'), true);
  assert.equal(rewritesPost('gh api -X PATCH repos/o/r/issues/comments/5 -f body=x'), true);
  assert.equal(rewritesPost('gh pr comment 1 --body x'), false);
  assert.equal(rewritesPost('node --test'), false);
});

test('a pull request or commit saying tests pass after a failed check is flagged', () => {
  const fail = { run: 'node --test', tests: FAILED };
  const cases = [
    ['gh pr create --title t --body "All tests pass"', 'pull request body'],
    ['gh pr comment 1 --body "All tests pass"', 'pull request comment'],
    ['git commit -m "Fix it\n\nAll tests pass"', 'commit message'],
  ];
  for (const [run, where] of cases) {
    const [f] = claims([fail, { run }]).filter((x) => x.kind === 'claims success in writing');
    assert.ok(f, run);
    assert.equal(f.severity, 'look');
    assert.equal(f.verdictEvidence, 'inferred');
    assert.ok(f.related);
    assert.ok(f.note.includes(where), f.note);
    assert.ok(!f.note.includes('All tests pass'), 'a finding keeps fixed words, not log text');
  }
});

test('written claims stay quiet with a passing check, a pass that came first, or no claim', () => {
  const written = { run: 'gh pr comment 1 --body "All tests pass"' };
  assert.equal(claims([{ run: 'node --test', tests: PASSED }, written]).length, 0, 'the last check passed');
  assert.equal(claims([{ run: 'node --test', tests: FAILED }, { run: 'node --test', tests: PASSED }, written]).length, 0, 'fixed first');
  assert.equal(claims([{ run: 'node --test', tests: FAILED }, { run: 'gh pr comment 1 --body "1 test still fails"' }]).length, 0, 'it reports the failure');
  assert.equal(claims([written]).length, 0, 'no check at all');
  assert.equal(claims([{ run: BREAK_AND_RESTORE, tests: FAILED }, written]).length, 0, 'the failure was on purpose');
  assert.equal(claims([{ run: 'node --test', tests: FAILED }, { run: 'git commit -m "Done"' }]).filter((f) => f.kind === 'claims success in writing').length, 0, 'done wording in a commit subject is no tests claim');
});

test('a claim written before the run in the same line comes before it, and one written after follows it', () => {
  const after = { run: 'node --test; gh pr comment 1 --body "All tests pass"', tests: FAILED };
  assert.equal(claims([after]).filter((f) => f.kind === 'claims success in writing').length, 1);
  const before = { run: 'gh pr comment 1 --body "All tests pass"; node --test', tests: FAILED };
  assert.equal(claims([before]).filter((f) => f.kind === 'claims success in writing').length, 0);
});

test('a written claim corrected later in the turn, or followed by a pass, drops to a note', () => {
  const fail = { run: 'node --test', tests: FAILED };
  const written = { run: 'gh pr comment 1 --body "All tests pass"' };
  const fixed = claims([fail, written, { run: 'gh pr comment 1 --edit-last --body "1 fails"' }]).filter((f) => f.kind === 'claims success in writing');
  assert.equal(fixed[0].severity, 'note');
  assert.match(fixed[0].note, /rewrote/);
  const passed = claims([fail, written, { run: 'node --test', tests: PASSED }]).filter((f) => f.kind === 'claims success in writing');
  assert.equal(passed[0].severity, 'note');
  assert.match(passed[0].note, /later check/);
});

// ---- a run's result read back -----------------------------------------------------------------

test('a failure read back from a file is a guess, where the same failure in the run itself is worked out', () => {
  const said = { say: 'All tests pass.' };
  assert.equal(claims([{ run: 'node --test', tests: FAILED }, said])[0].verdictEvidence, 'derived');
  assert.equal(claims([{ run: 'node --test > out.txt', tests: { ...FAILED, readBack: true } }, said])[0].verdictEvidence, 'inferred');
});

test('a runner behind a wrapper is still a runner', () => {
  for (const cmd of ['timeout 590 node --test', 'timeout -k 5 590 node --test', 'for i in 1 2; do node --test; done', '{ node --test; }', 'nohup node --test', 'env node --test']) assert.ok(testRunner(cmd), cmd);
  assert.equal(testRunner('timeout 5 sleep 1'), null);
});

test('the file a run writes to is the one on the runner, and never a null device', () => {
  assert.deepEqual(runOutputFiles('node --test > out.txt 2>&1'), ['out.txt']);
  assert.deepEqual(runOutputFiles('node --test 2>&1 | tee out.txt | tail -3'), ['out.txt']);
  assert.deepEqual(runOutputFiles('node --test > /dev/null'), []);
  assert.deepEqual(runOutputFiles('node --test 2>&1'), []);
  assert.deepEqual(runOutputFiles('echo hi > note.txt; node --test'), []);
  assert.equal(sameRunFile('a/out.txt', 'a\\out.txt'), true);
  assert.equal(sameRunFile('/w/a/out.txt', 'a/out.txt'), true, 'one path ends in the other');
  assert.equal(sameRunFile('a/out.txt', 'b/out.txt'), false);
});

const TAP = (pass, fail) => `# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n`;
let serial = 0;
function claudeLog(id, cwd) {
  const lines = [];
  const base = (type, min2, extra) => ({ type, sessionId: id, cwd, version: '2.1.0', uuid: `${id}-${++serial}`, timestamp: new Date(T0 + min2 * 60e3).toISOString(), ...extra });
  const add = (o) => lines.push(JSON.stringify(o));
  const api = {
    lines,
    prompt: (m, text) => add(base('user', m, { message: { role: 'user', content: text }, origin: { kind: 'human' } })),
    tool: (m, callId, name, input) => add(base('assistant', m, { message: { id: `m${serial}`, model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input }] } })),
    result: (m, callId, content, tur, isError = false) => add(base('user', m, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content, ...(isError ? { is_error: true } : {}) }] }, toolUseResult: tur })),
    say: (m, text) => add(base('assistant', m, { message: { id: `m${serial}`, model: 'model-a', role: 'assistant', content: [{ type: 'text', text }] } })),
  };
  return api;
}
async function historyOf(fill, { codex } = {}) {
  const root = makeTempDir('hw-claim-check-');
  try {
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    const claudeDir = join(root, 'claude', 'p');
    const codexDir = join(root, 'codex', 'sessions', '2025', '03', '10');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    if (codex) writeFileSync(join(codexDir, 'rollout-2025-03-10T09-00-00-0190b000-0000-7000-8000-0000000000c1.jsonl'), `${codex(project).map((r) => JSON.stringify(r)).join('\n')}\n`);
    else {
      const log = claudeLog('11111111-1111-4111-8111-111111111111', project);
      log.prompt(0, 'Run the tests.');
      fill(log);
      writeFileSync(join(claudeDir, '11111111-1111-4111-8111-111111111111.jsonl'), `${log.lines.join('\n')}\n`);
    }
    const config = normalizeConfig({ identity: { authorEmails: ['you@example.com'] }, week: { timezone: 'UTC' }, repos: [{ path: project, label: 'your-project', role: 'featured' }] }, { configDir: root });
    return await buildWorkHistory({ config, from: '2025-03-10', to: '2025-03-16', timezone: 'UTC', roots: { claude: [join(root, 'claude')], codex: [join(root, 'codex')] }, git: false, keepRaw: true });
  } finally {
    removeTempDir(root);
  }
}
const runsOf = (h) => h.events.filter((e) => e.facts?.testRunner);
const shellDone = (stdout) => ({ stdout, stderr: '', interrupted: false });

test('a run written to a file takes its result from a later read of that file', async () => {
  const h = await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test > out.txt 2>&1' });
    log.result(2, 'c1', '', shellDone(''));
    log.tool(3, 'c2', 'Bash', { command: 'tail -5 out.txt' });
    log.result(4, 'c2', TAP(4, 1), shellDone(TAP(4, 1)));
  });
  const [r] = runsOf(h);
  assert.equal(r.derived.tests.fail, 1);
  assert.equal(r.derived.tests.readBack, true);
  assert.equal(testRunResult(r), 'failed');
  assert.ok(!r.missing.includes('test-summary'), 'the summary is no longer missing');
  assert.ok(r.inferred.some((i) => i.key === 'test-summary' && i.rule === 'shell.test-read-back'), 'the step says how it is known');
  for (const id of READ_BACK_RULES.keys()) assert.ok(id in h.rules, id);
});

test('the Read tool reads a run file back too', async () => {
  const h = await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test 2>&1 | tee out.txt | tail -1' });
    log.result(2, 'c1', 'ok', shellDone('ok'));
    log.tool(3, 'c2', 'Read', { file_path: 'out.txt' });
    log.result(4, 'c2', `     1\t${TAP(5, 0)}`, { type: 'text', file: { filePath: 'out.txt', content: TAP(5, 0) } });
  });
  const [r] = runsOf(h);
  assert.equal(r.derived.tests.pass, 5);
  assert.equal(testRunResult(r), 'passed');
});

test('a background run takes its result from the wait that reads it', async () => {
  const h = await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test', run_in_background: true });
    log.result(2, 'c1', 'Command running in background with ID: job-1.', { ...shellDone(''), backgroundTaskId: 'job-1' });
    log.tool(3, 'c2', 'TaskOutput', { task_id: 'job-1', block: true });
    log.result(4, 'c2', TAP(3, 2), { task: { output: TAP(3, 2) } });
  });
  const [r] = runsOf(h);
  assert.equal(r.derived.tests.fail, 2);
  assert.equal(testRunResult(r), 'failed');
});

const STARTED = (id, file) => `Command running in background with ID: ${id}. Output is being written to: ${file}. You will be notified when it completes. To check interim output, use Read on that file path.\nSession cwd remains the same.`;

test('a background run takes its result from a shell read of the output file its start named', async () => {
  const h = await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test', run_in_background: true });
    log.result(2, 'c1', STARTED('job-1', 'C:\\work\\tasks\\job-1.output'), { ...shellDone(''), backgroundTaskId: 'job-1' });
    log.tool(3, 'c2', 'Bash', { command: 'cat "C:/work/tasks/job-1.output"; gh pr view 1' });
    log.result(4, 'c2', TAP(7, 0), shellDone(TAP(7, 0)));
  });
  const [r] = runsOf(h);
  assert.equal(r.derived.tests.pass, 7);
  assert.equal(testRunResult(r), 'passed');
});

test('output holding two runs\' summaries is pinned on neither', async () => {
  const [r] = runsOf(await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test', run_in_background: true });
    log.result(2, 'c1', STARTED('job-1', '/work/tasks/job-1.output'), { ...shellDone(''), backgroundTaskId: 'job-1' });
    log.tool(3, 'c2', 'Bash', { command: 'cat /work/tasks/job-1.output' });
    log.result(4, 'c2', `${TAP(4, 1)}${TAP(5, 0)}`, shellDone(`${TAP(4, 1)}${TAP(5, 0)}`));
  }));
  assert.equal(r.derived.tests, undefined);
});

test('a failed run followed by a run whose result is unclear is mixed evidence, not a finding', async () => {
  const log = (second) => historyOf((l) => {
    l.tool(1, 'c1', 'Bash', { command: 'node --test', result: 'error' });
    l.result(2, 'c1', TAP(4, 1), shellDone(TAP(4, 1)), true);
    l.tool(3, 'c2', 'Bash', { command: 'node --test', run_in_background: true });
    l.result(4, 'c2', STARTED('job-1', '/work/tasks/job-1.output'), { ...shellDone(''), backgroundTaskId: 'job-1' });
    l.tool(5, 'c3', 'Bash', { command: 'cat /work/tasks/job-1.output' });
    l.result(6, 'c3', second, shellDone(second));
    l.say(7, 'All tests pass.');
  });
  const flags = (h) => runProblems(h, { builtT: BUILT }).patterns.find((p) => p.id === 'claim-contradicts-evidence').findings.filter((f) => f.check === 'claim-contradicts-evidence');
  assert.equal(flags(await log(`${TAP(4, 1)}${TAP(5, 0)}`)).length, 0);
  assert.equal(flags(await log(TAP(4, 1))).length, 1, 'read back as one failure, it is one');
  assert.equal(flags(await log(TAP(5, 0))).length, 0, 'read back as a pass, it answers the failure');
});

test('a run in a line that reads another run\'s output takes no summary from that line', async () => {
  const runs = runsOf(await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test', run_in_background: true });
    log.result(2, 'c1', STARTED('job-1', '/work/tasks/job-1.output'), { ...shellDone(''), backgroundTaskId: 'job-1' });
    log.tool(3, 'c2', 'Bash', { command: 'cat /work/tasks/job-1.output; for i in 1 2; do node --test test/one.test.mjs | tail -1; done' });
    log.result(4, 'c2', TAP(4, 1), shellDone(TAP(4, 1)));
  }));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].derived.tests.fail, 1, 'the read goes to the run it names');
  assert.equal(runs[1].derived.tests, undefined, 'not to the loop');
});

test('a later read of a run replaces an earlier one, and two summaries take it back', async () => {
  const start = (log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test', run_in_background: true });
    log.result(2, 'c1', STARTED('job-1', '/work/tasks/job-1.output'), { ...shellDone(''), backgroundTaskId: 'job-1' });
  };
  const read = (log, m, text) => {
    log.tool(m, `r${m}`, 'Bash', { command: 'cat /work/tasks/job-1.output' });
    log.result(m + 1, `r${m}`, text, shellDone(text));
  };
  const [replaced] = runsOf(await historyOf((log) => {
    start(log);
    read(log, 3, TAP(4, 1));
    read(log, 5, TAP(5, 0));
  }));
  assert.equal(replaced.derived.tests.pass, 5);
  assert.equal(replaced.inferred.filter((i) => i.rule === 'shell.test-read-back').length, 1);
  const [taken] = runsOf(await historyOf((log) => {
    start(log);
    read(log, 3, TAP(4, 1));
    read(log, 5, `${TAP(4, 1)}${TAP(5, 0)}`);
  }));
  assert.equal(taken.derived.tests, undefined);
  assert.ok(taken.missing.includes('test-summary'));
  assert.ok(!taken.inferred.some((i) => i.rule === 'shell.test-read-back'));
});

test('a run stays without a result when the read could be of something else', async () => {
  const none = (r) => assert.equal(r.derived.tests, undefined);
  // Another file.
  none(runsOf(await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test > out.txt 2>&1' });
    log.result(2, 'c1', '', shellDone(''));
    log.tool(3, 'c2', 'Bash', { command: 'tail -5 other.txt' });
    log.result(4, 'c2', TAP(4, 1), shellDone(TAP(4, 1)));
  }))[0]);
  // Output with no summary in it.
  none(runsOf(await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test > out.txt 2>&1' });
    log.result(2, 'c1', '', shellDone(''));
    log.tool(3, 'c2', 'Bash', { command: 'tail -5 out.txt' });
    log.result(4, 'c2', 'still running', shellDone('still running'));
  }))[0]);
  // Another background job.
  none(runsOf(await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test', run_in_background: true });
    log.result(2, 'c1', 'Command running in background with ID: job-1.', { ...shellDone(''), backgroundTaskId: 'job-1' });
    log.tool(3, 'c2', 'TaskOutput', { task_id: 'job-2', block: true });
    log.result(4, 'c2', TAP(3, 2), { task: { output: TAP(3, 2) } });
  }))[0]);
});

test('a newer run writing the same file takes it over, so an old run never takes a new result', async () => {
  const h = await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test > out.txt 2>&1' });
    log.result(2, 'c1', '', shellDone(''));
    log.tool(3, 'c2', 'Bash', { command: 'node --test > out.txt 2>&1' });
    log.result(4, 'c2', '', shellDone(''));
    log.tool(5, 'c3', 'Bash', { command: 'tail -5 out.txt' });
    log.result(6, 'c3', TAP(5, 0), shellDone(TAP(5, 0)));
  });
  const [older, newer] = runsOf(h);
  assert.equal(older.derived.tests, undefined);
  assert.equal(newer.derived.tests.pass, 5);
});

test('a run with its own summary keeps it, and a log with no read-back keeps its old rules table', async () => {
  const h = await historyOf((log) => {
    log.tool(1, 'c1', 'Bash', { command: 'node --test | tee out.txt' });
    log.result(2, 'c1', TAP(2, 0), shellDone(TAP(2, 0)));
    log.tool(3, 'c2', 'Bash', { command: 'tail -5 out.txt' });
    log.result(4, 'c2', TAP(9, 9), shellDone(TAP(9, 9)));
  });
  const [r] = runsOf(h);
  assert.equal(r.derived.tests.pass, 2);
  assert.equal(r.derived.tests.readBack, undefined);
  for (const id of READ_BACK_RULES.keys()) assert.ok(!(id in h.rules), `${id} joins only when a run was read back`);
});

test('a Codex run written to a file reads back the same way', async () => {
  const rec = (m, type, payload) => ({ timestamp: new Date(T0 + m * 60e3).toISOString(), type, payload });
  const h = await historyOf(null, {
    codex: (cwd) => [
      rec(0, 'session_meta', { id: '0190b000-0000-7000-8000-0000000000c1', timestamp: new Date(T0).toISOString(), cwd, originator: 'codex_vscode', cli_version: '0.1.0', source: 'vscode' }),
      rec(0.5, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the tests.' }] }),
      rec(1, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: 'node --test > out.txt 2>&1', workdir: cwd }) }),
      rec(2, 'response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '', metadata: { exit_code: 0 } }) }),
      rec(3, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c2', arguments: JSON.stringify({ command: 'tail -5 out.txt', workdir: cwd }) }),
      rec(4, 'response_item', { type: 'function_call_output', call_id: 'c2', output: JSON.stringify({ output: TAP(4, 1), metadata: { exit_code: 0 } }) }),
    ],
  });
  const [r] = runsOf(h);
  assert.equal(r.derived.tests?.fail, 1);
  assert.equal(testRunResult(r), 'failed');
});
