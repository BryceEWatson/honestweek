// Unit tests for the work-history engine's reader, ids, and rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readBytesAt, readJsonlRecords } from '../lib/replay/jsonl.mjs';
import { eventId, letterHash, pathKey, recordDigest, sourceKey } from '../lib/replay/ids.mjs';
import { commitSummaryShas, isGitCommitCommand, isRevertCommand, parseTestSummary, plainOutput, prUrlsInOutput, SUMMARY_LINE, promptInferences, simpleCommands, testRunner, toolCategory } from '../lib/replay/classify.mjs';
import { outputNominations } from '../lib/replay/parse-common.mjs';
import { enumerateClaudeSources } from '../lib/replay/sources.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

async function collect(file, opts) {
  const out = [];
  for await (const r of readJsonlRecords(file, opts)) out.push(r);
  return out;
}

test('the reader addresses each line by byte offset, across CRLF, multi-byte text, and no final newline', async () => {
  const dir = makeTempDir('hw-jsonl-');
  try {
    const file = join(dir, 'a.jsonl');
    const lines = ['{"a":1}', '{"b":"héllo – 日本"}', '', '{"c":3}'];
    writeFileSync(file, `${lines[0]}\r\n${lines[1]}\n${lines[2]}\n${lines[3]}`);
    const recs = await collect(file);
    assert.deepEqual(recs.map((r) => [r.line, r.text]), [[1, lines[0]], [2, lines[1]], [4, lines[3]]], 'blank lines keep their line number');
    for (const r of recs) assert.equal(readBytesAt(file, r.offset, r.length).toString('utf8'), r.text);
    assert.equal(recordDigest(readBytesAt(file, recs[1].offset, recs[1].length)), recordDigest(recs[1].bytes));
  } finally {
    removeTempDir(dir);
  }
});

test('a record over the size cap is skipped and reported, and the lines after it still read', async () => {
  const dir = makeTempDir('hw-jsonl-');
  try {
    const file = join(dir, 'b.jsonl');
    writeFileSync(file, `{"x":1}\n{"big":"${'z'.repeat(5000)}"}\n{"y":2}\n`);
    const recs = await collect(file, { maxBytes: 1000 });
    assert.deepEqual(recs.map((r) => (r.oversized ? `L${r.line}:oversized` : `L${r.line}:${r.text}`)), ['L1:{"x":1}', 'L2:oversized', 'L3:{"y":2}']);
    assert.equal(readBytesAt(file, recs[2].offset, recs[2].length).toString(), '{"y":2}');
  } finally {
    removeTempDir(dir);
  }
});

test('ids are stable, short, and survive the redactor untouched', () => {
  assert.equal(sourceKey('cc', 'x'), sourceKey('cc', 'x'));
  assert.notEqual(sourceKey('cc', 'x'), sourceKey('cc', 'y'));
  assert.match(letterHash('anything'), /^[a-p]{12}$/);
  const red = createRedactor({ redaction: { codenames: ['abc'], names: [], terms: [] } });
  for (let i = 0; i < 3000; i++) {
    const key = sourceKey('cc', `session-${i}`);
    const id = eventId(key, i * 7, i % 3);
    const digest = recordDigest(Buffer.from(String(i)));
    const pk = pathKey(`C:\\Users\\someone\\repo\\file${i}.mjs`);
    for (const s of [key, id, digest, pk, `${key}:main`, `th-${letterHash(key, 10)}`]) assert.equal(red.redact(s), s, s);
  }
  assert.equal(pathKey('C:\\Repo\\A.mjs'), pathKey('c:/repo/a.mjs'), 'Windows paths compare case-insensitively');
  assert.notEqual(pathKey('/repo/A.mjs'), pathKey('/repo/a.mjs'), 'POSIX paths do not');
});

test('a test runner counts only where a command starts, never inside quoted text or a heredoc', () => {
  const cases = [
    ['node --test', 'node --test'],
    ['cd /x && node --test 2>&1 | tail -5', 'node --test'],
    ['FOO=1 npm run test', 'npm test'],
    ['python -m pytest -q', 'pytest'],
    ['(cd a && npx jest)', 'jest'],
    ['node --test-name-pattern=x --test t.mjs', 'node --test'],
    ['gh pr create --body "ran node --test"', null],
    ["git commit -m 'npm test passes'", null],
    ['echo "node --test"', null],
    ["cat > f <<'EOF'\nnode --test\nEOF\necho done", null],
    ['nodejs-test-helper', null],
  ];
  for (const [cmd, want] of cases) assert.equal(testRunner(cmd), want, cmd);
  assert.deepEqual(simpleCommands('a && b | c; d'), ['a', 'b', 'c', 'd']);
  assert.equal(isRevertCommand('git -C r reset --hard HEAD~1'), true);
  assert.equal(isRevertCommand('echo git revert'), false);
  assert.equal(isGitCommitCommand('git add -A && git commit -qm "x"'), true);
  assert.equal(isGitCommitCommand('echo "git commit"'), false);
});

test('test summaries are read only from exact runner formats', () => {
  assert.deepEqual(parseTestSummary('# tests 4\n# pass 3\n# fail 1\n'), { tests: 4, pass: 3, fail: 1, parser: 'node-tap' });
  assert.deepEqual(parseTestSummary('ℹ tests 5\nℹ pass 5\nℹ fail 0'), { tests: 5, pass: 5, fail: 0, parser: 'node-spec' });
  assert.deepEqual(parseTestSummary('Tests:       1 failed, 11 passed, 12 total'), { tests: 12, pass: 11, fail: 1, parser: 'jest' });
  assert.deepEqual(parseTestSummary('===== 2 failed, 8 passed in 0.31s ====='), { tests: 10, pass: 8, fail: 2, parser: 'pytest' });
  assert.deepEqual(parseTestSummary('===== 8 passed in 0.31s ====='), { tests: 8, pass: 8, fail: 0, parser: 'pytest' });
  assert.equal(parseTestSummary('all good, 3 tests passed'), null, 'prose is not a summary');
  assert.equal(parseTestSummary(''), null);
  // Every test failing, errors, other reporters, and an empty run.
  assert.deepEqual(parseTestSummary('Tests:       2 failed, 2 total'), { tests: 2, pass: 0, fail: 2, parser: 'jest' });
  assert.deepEqual(parseTestSummary('===== 2 failed in 0.10s ====='), { tests: 2, pass: 0, fail: 2, parser: 'pytest' });
  assert.deepEqual(parseTestSummary('===== 3 passed, 2 errors in 0.40s ====='), { tests: 5, pass: 3, fail: 2, parser: 'pytest' }, 'an error is not a pass');
  assert.deepEqual(parseTestSummary('12 passed in 0.10s'), { tests: 12, pass: 12, fail: 0, parser: 'pytest' }, 'pytest -q');
  assert.deepEqual(parseTestSummary('      Tests  1 failed | 11 passed (12)'), { tests: 12, pass: 11, fail: 1, parser: 'vitest' });
  assert.equal(parseTestSummary('# tests 0\n# pass 0\n# fail 0'), null, 'a run of zero tests is no summary, not a pass');
});

test('output nominates only what a git commit or gh pr create printed about itself', () => {
  const out = '[main 1a2b3c4] Add parser\n 1 file changed\n9f8e7d6 An older commit\n0a1b2c3 A teammate\'s commit';
  assert.deepEqual(commitSummaryShas(out), ['1a2b3c4'], 'git log lines after the commit are not nominated');
  const event = { inferred: [] };
  const n = outputNominations('git commit -qm "x" && git log --oneline -3', out, event);
  assert.deepEqual(n.commits.map((c) => [c.sha, c.evidence, c.rule]), [['1a2b3c4', 'inferred', 'shell.git-commit-output']]);
  assert.deepEqual(outputNominations('git log --oneline -3', out, { inferred: [] }).commits, [], 'without a commit command, nothing');
  // A quiet commit prints no summary: the first line a following log prints is HEAD.
  const quiet = outputNominations('git commit -qm "x" && git log --oneline -3', '9f8e7d6 Newest\n0a1b2c3 Older\n1b2c3d4 Oldest', { inferred: [] });
  assert.deepEqual(quiet.commits.map((c) => c.sha), ['9f8e7d6'], 'only HEAD, never the older commits listed after it');
  assert.deepEqual(outputNominations('git commit -qm "x" && git log -3', 'commit 9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f901\nAuthor: x', { inferred: [] }).commits.map((c) => c.sha), ['9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f901']);
  assert.deepEqual(outputNominations('git commit -qm "x" && git log --oneline -1', '9f8e7d6 x', { inferred: [], facts: { result: 'error' } }).commits, [], 'a failed commit nominates nothing');
  assert.deepEqual(prUrlsInOutput('gh pr create --fill', 'https://github.com/example/your-project/pull/12\n'), [{ repo: 'example/your-project', number: 12 }]);
  assert.deepEqual(prUrlsInOutput('gh pr view 12', 'https://github.com/example/your-project/pull/12'), [], 'viewing a pull request is not creating one');
});

test('a file is found by the timestamps inside it, even past a single huge record', async () => {
  const dir = makeTempDir('hw-probe-');
  try {
    const proj = join(dir, 'p');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(proj, { recursive: true });
    const big = 'x'.repeat(200 * 1024);
    const rec = (ts, extra = {}) => JSON.stringify({ type: 'user', timestamp: ts, cwd: '/w', message: { role: 'user', content: 'hi' }, ...extra });
    // First record has no timestamp and is larger than any fixed head window; the last
    // record is too, so a fixed tail window would see nothing.
    writeFileSync(join(proj, 'a.jsonl'), [JSON.stringify({ type: 'file-history-snapshot', snapshot: big }), rec('2024-06-09T10:00:00.000Z'), rec('2024-06-12T10:00:00.000Z'), JSON.stringify({ type: 'user', timestamp: '2024-06-12T11:00:00.000Z', message: { role: 'user', content: big } })].join('\n') + '\n');
    const from = Date.parse('2024-06-11T00:00:00.000Z');
    const to = Date.parse('2024-06-13T00:00:00.000Z');
    const { sources, skipped } = await enumerateClaudeSources([dir], from, to);
    assert.equal(sources.length, 1, JSON.stringify(skipped));
    assert.equal(sources[0].firstAt, '2024-06-09T10:00:00.000Z');
    assert.equal(sources[0].lastAt, '2024-06-12T11:00:00.000Z', 'the started-before-the-window session that worked inside it is kept');
  } finally {
    removeTempDir(dir);
  }
});

test('prompt labels are narrow: a label is better left off than wrong', () => {
  const v = (t) => promptInferences(t).map((x) => x.value);
  assert.deepEqual(v('no, use the other file'), ['correction']);
  assert.deepEqual(v('merge 65'), ['approval']);
  assert.deepEqual(v('The PC crashed, please continue'), ['resume-request']);
  assert.deepEqual(v('What is the status?'), ['question']);
  assert.deepEqual(v('Notice how the parser handles it'), [], '"no" inside a word is not a redirect');
  assert.deepEqual(v(`merge ${'x'.repeat(200)}`), [], 'a long message is not a one-word approval');
  for (const inf of promptInferences('stop, revert that? go')) assert.ok(inf.rule);
});

test('commit ids come only from git output shapes; tool names map to categories', () => {
  assert.deepEqual(commitSummaryShas('[main (root-commit) 1a2b3c4] Add parser\n 1 file changed'), ['1a2b3c4']);
  assert.deepEqual(commitSummaryShas('nothing to commit'), []);
  assert.equal(toolCategory('Bash'), 'shell');
  assert.equal(toolCategory('apply_patch'), 'edit');
  assert.equal(toolCategory('spawn_agent'), 'delegate');
  assert.equal(toolCategory('mcp__ccd_session__spawn_task'), 'handoff');
  assert.equal(toolCategory('mcp__some-browser__click'), 'browser');
  assert.equal(toolCategory('mcp__mail__send'), 'external');
  assert.equal(toolCategory('SomethingNew'), 'other');
});

test('a test summary printed in colour reads as the plain one does', () => {
  const ESC = String.fromCharCode(27);
  // vitest with colour forced on, as it prints into a pipe: codes sit inside the summary line.
  const line = (label, count, total, colour) => `${ESC}[2m ${label} ${ESC}[22m ${ESC}[1m${ESC}[${colour}m${count}${ESC}[39m${ESC}[22m${ESC}[90m (${total})${ESC}[39m`;
  const passed = `${line('Test Files', '1 passed', 1, 32)}\n${line('     Tests', '26 passed', 26, 32)}\n${ESC}[2m   Start at ${ESC}[22m 14:02:07`;
  assert.deepEqual(parseTestSummary(passed), { tests: 26, pass: 26, fail: 0, parser: 'vitest' });
  assert.deepEqual(parseTestSummary(passed), parseTestSummary(plainOutput(passed)));
  const failed = `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m${ESC}[2m | ${ESC}[22m${ESC}[1m${ESC}[32m51 passed${ESC}[39m${ESC}[22m${ESC}[90m (52)${ESC}[39m\n${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m${ESC}[2m | ${ESC}[22m${ESC}[1m${ESC}[32m1873 passed${ESC}[39m${ESC}[22m${ESC}[90m (1874)${ESC}[39m`;
  assert.deepEqual(parseTestSummary(failed), { tests: 1874, pass: 1873, fail: 1, parser: 'vitest', suitesFailed: 1 });
  // The other runners' summaries, coloured the same way.
  assert.deepEqual(parseTestSummary(`${ESC}[32m# pass 3${ESC}[39m\n${ESC}[31m# fail 1${ESC}[39m`), { tests: 4, pass: 3, fail: 1, parser: 'node-tap' });
  assert.deepEqual(parseTestSummary(`${ESC}[1mTests:${ESC}[22m       ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m, 11 passed, 12 total`), { tests: 12, pass: 11, fail: 1, parser: 'jest' });
  // Two coloured summaries in one output are still counted as two.
  assert.equal((plainOutput(`${passed}\n${passed}`).match(SUMMARY_LINE) ?? []).length, 2);
  // Text with no codes comes back as it was, and prose in colour is still not a summary.
  assert.equal(plainOutput('Tests  4 passed (4)'), 'Tests  4 passed (4)');
  assert.equal(parseTestSummary(`${ESC}[32mall good, 3 tests passed${ESC}[39m`), null);
});

test('vitest saying a test file failed to load, with no tests run, is a failed run', () => {
  const out = ' FAIL  scripts/a.test.mjs [ scripts/a.test.mjs ]\nError: Expression expected\n Test Files  1 failed (1)\n      Tests  no tests\n   Start at  19:23:04';
  assert.deepEqual(parseTestSummary(out), { tests: 0, pass: 0, fail: 0, parser: 'vitest', suitesFailed: 1 });
  assert.equal((out.match(SUMMARY_LINE) ?? []).length, 1);
  // Failing partners: no tests and no failed file is no summary, and so is "no tests" alone.
  assert.equal(parseTestSummary(' Test Files  no test files\n      Tests  no tests'), null);
  assert.equal(parseTestSummary('      Tests  no tests'), null);
});
