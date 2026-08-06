// test/mine-detect.test.mjs — the detector's discrimination and privacy contracts.
//
// The cases below are not invented. Each false-positive test names a shape that
// actually reached the top of a full-corpus ranking during development, and each
// true-positive test is modelled on a session that is known to have produced a
// published post. A detector that cannot tell these apart is not doing its job.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classify,
  deidentify,
  extractFeatures,
  inferProducts,
  quotableErrors,
  resolutionEvidence,
} from '../lib/mine/detect.mjs';

// ---------------------------------------------------------------------------
// De-identification — a privacy contract, not a formatting nicety
// ---------------------------------------------------------------------------

test('deidentify strips a home directory in every path spelling', () => {
  const cases = [
    'C:\\Users\\Bryce\\Projects\\x',
    "Error: ENOENT: open 'C:\\c\\Users\\Bryce\\.claude\\projects\\a.jsonl'",
    '/c/Users/Bryce/.claude/settings.json',
    '/home/bryce/.config/app',
    'C:/Users/Bryce/AppData/Roaming/Acme/logs/x.log',
    '/Users/bryce/Library/Application Support/Acme',
  ];
  for (const c of cases) {
    const out = deidentify(c);
    assert.doesNotMatch(out, /bryce/i, `username survived de-identification: ${c} -> ${out}`);
    assert.match(out, /<home>/, `home marker missing: ${c} -> ${out}`);
  }
});

test('deidentify strips a UNC share', () => {
  assert.doesNotMatch(deidentify('\\\\fileserver\\share\\secret.txt'), /fileserver/);
});

test('deidentify survives a spaced account name and doubled separators', () => {
  // Both of these reached output with the account name intact during review.
  // A "First Last" Windows account published the surname, because the segment
  // pattern stopped at the space; and the ordinary JSON-escaped `C://Users//name//`
  // form skipped the home rule entirely, because separator collapsing ran after it.
  const spaced = deidentify('C:/Users/Alex Jordan/AppData/Local/Foo/bar.log');
  assert.doesNotMatch(spaced, /Jordan/, `surname survived: ${spaced}`);
  assert.match(spaced, /^<home>\//);

  const doubled = deidentify('C://Users//alice//Projects//AcmeClient//app.js');
  assert.doesNotMatch(doubled, /alice/, `username survived: ${doubled}`);
  assert.match(doubled, /^<home>\//);
});

test('deidentify leaves an ordinary sentence mentioning a directory alone', () => {
  const s = 'The service reads its config from the Users directory at startup';
  assert.equal(deidentify(s), s);
});

test('deidentify does not mangle a URL', () => {
  // The separator-collapsing pass has to tell a one-letter drive from the tail of a
  // scheme. Issue URLs are quoted in drafts, so `https:/host` would be a visible bug.
  const s = 'see https://github.com/acmeco/app/issues/12 for details';
  assert.equal(deidentify(s), s);
});

test('deidentify keeps a non-home absolute path readable', () => {
  assert.equal(deidentify('C:\\Program Files\\Acme\\app.exe'), '<drive>/Program Files/Acme/app.exe');
});

// ---------------------------------------------------------------------------
// Quotable errors — the single most load-bearing extraction in the pipeline
// ---------------------------------------------------------------------------

test('quotableErrors keeps a third-party product error', () => {
  const body = 'VM service not running. The service failed to start.';
  assert.deepEqual(quotableErrors(body, 'C:/repo'), ['VM service not running. The service failed to start.']);
});

test('quotableErrors rejects your own toolchain and your own VCS', () => {
  const rejected = [
    'error TS2345: Argument of type string is not assignable',
    '  ✕ renders the header (12 ms) — AssertionError: expected true',
    'npm ERR! code ELIFECYCLE',
    "fatal: invalid upstream 'feature/some-branch'",
    'hint: Updates were rejected because the tip of your current branch',
    "error: branch 'feature/x' not found",
  ];
  for (const line of rejected) {
    assert.deepEqual(quotableErrors(line, 'C:/repo'), [], `should have rejected: ${line}`);
  }
});

test('quotableErrors rejects tool framing that merely looks error-shaped', () => {
  // Every one of these reached a top-15 ranking slot before it was filtered out.
  const rejected = [
    '   42→  const failed = true; // error handling',
    '- **Security model inconsistency**: content scripts cannot execute',
    '2. **Universal failure pattern**: the identical error across every origin',
    '=== was a PR EVER opened for the stalled branches? ===',
    '"lastToolSummary": "No original content post has EVER been published",',
    'docs/WIKI-EXPORT-DESIGN.md',
    'Every call fails with a CDP-level error:',
    'src/lib/eval.ts:1:105: ERROR: Syntax error "c"',
    "Here's a summary of what I found regarding the error code",
  ];
  for (const line of rejected) {
    assert.deepEqual(quotableErrors(line, 'C:/repo'), [], `should have rejected: ${line}`);
  }
});

test('quotableErrors rejects a line naming the session working tree', () => {
  const body = 'Error: cannot open C:/repo/src/index.ts for writing';
  assert.deepEqual(quotableErrors(body, 'C:/repo'), []);
});

test('quotableErrors never emits a home directory', () => {
  const body = "Error: ENOENT: no such file or directory, open 'C:\\Users\\Bryce\\AppData\\Roaming\\Acme\\state.json'";
  const out = quotableErrors(body, 'C:/repo');
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0], /bryce/i);
});

// ---------------------------------------------------------------------------
// Product inference
// ---------------------------------------------------------------------------

test('inferProducts reads the product out of an install path, skipping generic folders', () => {
  const products = inferProducts(
    ['<home>/AppData/Roaming/Acme/logs/a.log', '<home>/AppData/Local/Temp/x', '<drive>/Program Files/Acme/app.exe'],
    ['Get-Service AcmeVMService'],
  );
  const names = products.map((p) => p.name);
  assert.ok(names.includes('Acme'), `expected Acme in ${JSON.stringify(names)}`);
  assert.ok(!names.includes('Temp'), 'Temp is a folder, not a product');
});

test('inferProducts ignores a flag the path regex swept up', () => {
  assert.deepEqual(inferProducts([], ['Get-Process -Id 4821']).map((p) => p.name), []);
});

// ---------------------------------------------------------------------------
// Resolution evidence
// ---------------------------------------------------------------------------

test('reading someone else issue is not a resolution; filing one is', () => {
  const read = extractFeatures([
    { kind: 'human', text: 'look at https://github.com/acmeco/app/issues/12 for context' },
  ]);
  assert.deepEqual(resolutionEvidence(read), []);

  const filed = extractFeatures([
    { kind: 'human', text: 'we have filed a bug for this here: https://github.com/acmeco/app/issues/12' },
  ]);
  assert.deepEqual(resolutionEvidence(filed).map((r) => r.kind), ['issue-filed']);
});

test('an issue on your own repo is never foreign evidence', () => {
  const f = extractFeatures([{ kind: 'human', text: 'I opened an issue: https://github.com/me/mine/issues/3' }], {
    ownRepos: ['me/mine'],
  });
  assert.deepEqual(f.externalIssues, []);
  assert.deepEqual(f.filedIssues, []);
  assert.deepEqual(f.ownIssues, ['me/mine#3']);
});

// ---------------------------------------------------------------------------
// Classification — the whole point
// ---------------------------------------------------------------------------

const foreignFailure = {
  kind: 'result',
  text: 'VM service not running. The service failed to start.',
  isError: true,
};

test('classifies a solved third-party failure as a candidate', () => {
  const f = extractFeatures([
    { kind: 'human', text: 'Cowork will not start on this machine, can you work out why' },
    { kind: 'tool_use', name: 'Bash', text: 'Get-Service AcmeVMService' },
    { kind: 'tool_use', name: 'Bash', text: 'Get-WinEvent -LogName Application -MaxEvents 20' },
    foreignFailure,
    { kind: 'human', text: 'that worked, it is running now' },
  ]);
  const v = classify(f);
  assert.equal(v.isCandidate, true, JSON.stringify(v.rejectedFor));
  assert.ok(v.diagnosisKinds.includes('state'));
});

test('research alone counts as out-of-tree diagnosis', () => {
  // The known-good file-upload session probed no services at all: it ran a controlled
  // experiment against a vendor tool, researched it, and filed bugs. Requiring a
  // service probe rejected it.
  const f = extractFeatures([
    { kind: 'human', text: 'work out whether the upload tool is functional' },
    { kind: 'tool_use', name: 'WebSearch', text: 'CDP error Not allowed setFileInputFiles' },
    { kind: 'tool_use', name: 'WebSearch', text: 'chrome devtools protocol -32000' },
    { kind: 'result', text: 'Error capturing screenshot: Frame with ID 0 is showing error page', isError: true },
    { kind: 'human', text: 'we have filed a bug for this here: https://github.com/acmeco/app/issues/32561' },
  ]);
  const v = classify(f);
  assert.equal(v.isCandidate, true, JSON.stringify(v.rejectedFor));
  assert.deepEqual(v.diagnosisKinds, ['research']);
});

test('rejects ordinary work: your code broke and you fixed your code', () => {
  const events = [{ kind: 'human', text: 'the build is failing, fix it' }];
  for (let i = 0; i < 12; i++) events.push({ kind: 'tool_use', name: 'Edit', text: 'C:/repo/src/thing.ts' });
  events.push({ kind: 'result', text: 'Error: cannot resolve import in module graph', isError: true });
  events.push({ kind: 'tool_use', name: 'WebSearch', text: 'how to fix import' });
  events.push({ kind: 'human', text: 'that worked, it is fixed.' });
  const v = classify(extractFeatures(events, { cwd: 'C:/repo' }));
  assert.equal(v.isCandidate, false);
  assert.ok(v.rejectedFor.includes('own-repo edits dominate out-of-tree investigation'));
});

test('rejects an unresolved failure — a bug report is not a guide', () => {
  const f = extractFeatures([
    { kind: 'human', text: 'why will this not start' },
    { kind: 'tool_use', name: 'Bash', text: 'Get-Service AcmeVMService' },
    { kind: 'tool_use', name: 'Bash', text: 'Get-WinEvent -LogName Application' },
    foreignFailure,
  ]);
  const v = classify(f);
  assert.equal(v.isCandidate, false);
  assert.ok(v.rejectedFor.includes('no resolution evidence'));
});

test('an edit outside the working tree is part of the fix, not own-repo work', () => {
  const f = extractFeatures(
    [
      { kind: 'tool_use', name: 'Edit', text: 'C:/ProgramData/Acme/config.json' },
      { kind: 'tool_use', name: 'Bash', text: 'Get-Service AcmeVMService' },
      { kind: 'tool_use', name: 'Bash', text: 'Get-WinEvent -LogName Application' },
      foreignFailure,
      { kind: 'human', text: 'works now' },
    ],
    { cwd: 'C:/repo' },
  );
  assert.equal(f.ownRepoEdits, 0);
  assert.equal(classify(f).isCandidate, true);
});
