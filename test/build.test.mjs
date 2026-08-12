import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild, assembleReportModel } from '../lib/build.mjs';

const ME = 'me@example.com';
const OTHER = 'someone@else.test';

let counter = 0;
function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-build-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, { email = ME, message = 'work', dateISO = '2024-06-12T10:00:00Z' } = {}) {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}
function makeIo() {
  const io = {
    outBuf: '',
    errBuf: '',
    exitCode: null,
    out(s) { io.outBuf += s; },
    err(s) { io.errBuf += s; },
    exit(code) { io.exitCode = code; throw new ExitError(code); },
  };
  return io;
}

function setup({ repos, items, output, voice } = {}) {
  const repoDir = initRepo();
  const work = mkdtempSync(join(tmpdir(), 'hw-build-work-'));
  const outFile = join(work, 'out.md');
  const config = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: repos ?? [{ path: repoDir, label: 'r', role: 'featured' }],
    redaction: { codenames: ['Falcon'], names: [], terms: [] },
    output: output ?? { mode: 'digest', file: outFile },
    ...(voice !== undefined ? { voice } : {}),
  };
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify(config));
  if (items !== undefined) writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify(items));
  return { repoDir, work, outFile };
}

function cleanup(...dirs) {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('happy path: verifies, redacts, and emits; git-derived data overrides the items file', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'fix login redirect' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: {
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [
        { id: 'i1', repo: 'r', text: 'Fixed the login redirect for Falcon at 87% coverage.', tag: 'verified', primaryCommit: sha, subject: 'TAMPERED SUBJECT' },
      ],
    },
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    assert.equal(io.exitCode, null, 'no abort on the happy path');
    assert.ok(existsSync(outFile));
    const out = readFileSync(outFile, 'utf8');
    const shortSha = sha.slice(0, 7);
    assert.ok(out.includes(shortSha), 'git-derived short sha appears in the receipt');
    assert.ok(!out.includes('TAMPERED SUBJECT'), 'items-file commit metadata is never trusted');
    // redaction applied; spare preserved
    assert.ok(!out.includes('Falcon'), 'configured codename scrubbed');
    assert.ok(out.includes('87%'), 'plain percentage spared');
    // badge + receipt present
    assert.match(out, /\*\*shipped\*\*/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('aborts (exit 2) and writes nothing when a cited commit does not resolve', async () => {
  const { repoDir, work, outFile } = setup({
    items: { week: { start: '2024-06-10', end: '2024-06-16' }, items: [{ id: 'i1', repo: 'r', text: 'x', tag: 'verified', primaryCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }] },
  });
  commit(repoDir); // repo has commits, but not the cited one
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e instanceof ExitError && e.code === 2);
    assert.match(io.errBuf, /ABORTED/);
    assert.match(io.errBuf, /does not resolve|unresolved/);
    assert.match(io.errBuf, /No output was written/);
    assert.ok(!existsSync(outFile), 'no output file on abort');
  } finally {
    cleanup(repoDir, work);
  }
});

test('aborts (exit 2) when a cited commit was not authored by the configured identity', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { email: OTHER, message: 'third-party change' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: { week: { start: '2024-06-10', end: '2024-06-16' }, items: [{ id: 'i1', repo: 'r', text: 'x', tag: 'verified', primaryCommit: sha }] },
  });
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 2);
    assert.match(io.errBuf, /not authored/);
    assert.match(io.errBuf, /identity\.authorEmails/);
    assert.ok(!existsSync(outFile));
  } finally {
    cleanup(repoDir, work);
  }
});

test('aborts when an item cites a commit against a display-role repo (never git-read)', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'disp', role: 'display' }],
    items: { week: { start: '2024-06-10', end: '2024-06-16' }, items: [{ id: 'i1', repo: 'disp', text: 'x', tag: 'verified', primaryCommit: sha }] },
  });
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 2);
    assert.match(io.errBuf, /display/);
    assert.ok(!existsSync(outFile));
  } finally {
    cleanup(repoDir, work);
  }
});

test('a missing items file exits non-zero with a message naming the file', async () => {
  const { repoDir, work } = setup({ items: undefined });
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 1);
    assert.match(io.errBuf, /honestweek\.items\.json/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('a malformed items file exits non-zero with a clear parse error', async () => {
  const { repoDir, work } = setup({ items: { items: [] } });
  writeFileSync(join(work, 'honestweek.items.json'), '{ not json');
  const io = makeIo();
  try {
    await assert.rejects(runBuild({ cwd: work, io }), (e) => e.code === 1);
    assert.match(io.errBuf, /not valid JSON/);
  } finally {
    cleanup(repoDir, work);
  }
});

test('assembleReportModel groups by repo, featured before reference, badges + receipts attached', () => {
  const config = { repos: [{ label: 'a', role: 'reference' }, { label: 'b', role: 'featured' }] };
  const verified = new Map([['sha1', { shortSha: 'sha1abc', dateISO: '2024-06-12T00:00:00Z' }]]);
  const items = [
    { id: '1', repo: 'a', text: 'ref work', tag: 'measured', receipt: { sessionId: 'sess-a' } },
    { id: '2', repo: 'b', text: 'feat work', tag: 'verified', primaryCommit: 'sha1' },
    { id: '3', text: 'loose private line', tag: 'assumed', receipt: { sessionId: 'sess-c' } },
  ];
  const model = assembleReportModel(items, config, verified, { start: '2024-06-10', end: '2024-06-16' });
  assert.deepEqual(model.groups.map((g) => g.label), ['b', 'a'], 'featured group first');
  assert.equal(model.groups[0].items[0].status, 'shipped');
  assert.equal(model.groups[0].items[0].receipt.shortSha, 'sha1abc');
  assert.equal(model.groups[1].items[0].status, 'shipped'); // measured -> shipped
  assert.equal(model.items[0].status, 'designed, not proven'); // assumed -> under-claim
  assert.equal(model.items[0].receipt.sessionId, 'sess-c');
});

test('page mode: build writes a self-contained interactive HTML report with git-verified receipts', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'add the feature' });
  const work = mkdtempSync(join(tmpdir(), 'hw-build-work-'));
  const outFile = join(work, 'honestweek.report.html');
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    redaction: { codenames: ['Falcon'], names: [], terms: [] },
    output: { mode: 'page', file: outFile },
  }));
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    week: { start: '2024-06-10', end: '2024-06-16' },
    content: { headline: 'My week.' },
    items: [{ id: 'i1', repo: 'r', status: 'shipped', title: 'Added the feature for Falcon', summary: 'A real, verified change.', primaryCommit: sha }],
  }));
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    assert.ok(existsSync(outFile));
    const html = readFileSync(outFile, 'utf8');
    assert.match(html, /^<!DOCTYPE html>/);
    assert.ok(html.includes('wl-panel') && html.includes('wl-chart'), 'the console panel + chart render');
    assert.ok(html.includes(sha.slice(0, 7)), 'the git-derived short sha is the receipt');
    assert.ok(html.includes('is-shipped'), 'status badge rendered');
    assert.ok(html.includes('<script>'), 'interactive (inline script)');
    assert.ok(!html.includes('Falcon'), 'redaction still runs on page mode');
    assert.ok(!/src\s*=\s*["']https?:/i.test(html) && !/<link\b/i.test(html), 'zero external resources');
  } finally {
    cleanup(repoDir, work);
  }
});

test('page mode: an empty week writes the honest no-sessions report, not a crash', async () => {
  const repoDir = initRepo(); // no commits in the window
  const work = mkdtempSync(join(tmpdir(), 'hw-build-work-'));
  const outFile = join(work, 'honestweek.report.html');
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'page', file: outFile },
  }));
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({ week: { start: '2024-06-10', end: '2024-06-16' }, items: [] }));
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    const html = readFileSync(outFile, 'utf8');
    assert.ok(html.includes('No interactive coding sessions were found'), 'honest empty-state, not a fake panel of zeros');
  } finally {
    cleanup(repoDir, work);
  }
});

// --- voice-fence (opt-in authored-prose honesty lint) ---

test('voice-fence (opt-in): an offending ITEM summary aborts exit 2 and writes nothing', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'real work' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: {
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [{ id: 'i1', repo: 'r', summary: 'Built the core; keeping the specifics sealed for now.', primaryCommit: sha }],
    },
    voice: { denyMeta: true },
  });
  const io = makeIo();
  try {
    await assert.rejects(() => runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io }));
    assert.equal(io.exitCode, 2, 'voice violation aborts with exit 2');
    assert.ok(/voice:/.test(io.errBuf) && /i1/.test(io.errBuf) && /withholding:sealed/.test(io.errBuf), 'names the item + the rule');
    assert.equal(existsSync(outFile), false, 'no output written on a voice abort');
  } finally {
    cleanup(repoDir, work);
  }
});

test('voice-fence (opt-in): an offending PROJECT mission aborts exit 2 (not just items)', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'real work' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: {
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [{ id: 'i1', repo: 'r', summary: 'Shipped the verifier.', primaryCommit: sha }],
      projects: { alpha: { mission: 'This belongs in an honest log.' } },
    },
    voice: { denyMeta: true },
  });
  const io = makeIo();
  try {
    await assert.rejects(() => runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io }));
    assert.equal(io.exitCode, 2);
    assert.ok(/projects\.alpha\.mission/.test(io.errBuf) && /meta:honest-log/.test(io.errBuf), 'names the project mission + rule');
    assert.equal(existsSync(outFile), false);
  } finally {
    cleanup(repoDir, work);
  }
});

test('voice-fence: the SAME offending prose builds normally when voice is OFF (default)', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'real work' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: {
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [{ id: 'i1', repo: 'r', summary: 'Built the core; keeping the specifics sealed for now.', primaryCommit: sha }],
    },
    // no `voice` block -> lint never runs (today's behavior, unchanged)
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0, 'off-by-default: the same prose is not gated');
    assert.equal(io.exitCode, null);
    assert.ok(existsSync(outFile));
  } finally {
    cleanup(repoDir, work);
  }
});

test('voice-fence (opt-in): clean prose builds normally, and a snippet word does not abort', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'real work' });
  const { work, outFile } = setup({
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    items: {
      week: { start: '2024-06-10', end: '2024-06-16' },
      // clean authored summary; a banned word lives only in an item's evidence (never scanned)
      items: [{ id: 'i1', repo: 'r', summary: 'Built the core authentication flow.', snippet: 'the pre-registration was kept sealed', primaryCommit: sha }],
      projects: { alpha: { mission: 'Make verification cheap to run on every build.' } },
    },
    voice: { denyMeta: true },
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0, 'clean prose passes; evidence "sealed" is never scanned');
    assert.equal(io.exitCode, null);
    assert.ok(existsSync(outFile));
  } finally {
    cleanup(repoDir, work);
  }
});

// --- the landed gate: `shipped` requires default-branch reachability ---------

/** A repo whose default branch (`main`) holds `landedSha` and whose unmerged
 *  `feat` branch holds `strandedSha`; HEAD is left on main. */
function landedAndStrandedRepo() {
  const dir = initRepo();
  const landedSha = commit(dir, { message: 'landed work' });
  const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== 'main') git(dir, ['branch', '-m', 'main']);
  git(dir, ['checkout', '-q', '-b', 'feat']);
  const strandedSha = commit(dir, { message: 'real work, not merged', dateISO: '2024-06-12T11:00:00Z' });
  git(dir, ['checkout', '-q', 'main']);
  return { dir, landedSha, strandedSha };
}

/** Write a minimal config + items pair for the landed-gate scenarios. */
function landedGateSetup({ dir, mode, outFile, items, adapter }) {
  const work = mkdtempSync(join(tmpdir(), 'hw-build-work-'));
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: dir, label: 'r', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: adapter ? { mode, adapter } : { mode, file: join(work, outFile) },
  }));
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    week: { start: '2024-06-10', end: '2024-06-16' },
    items,
  }));
  return { work, outPath: join(work, outFile) };
}

test('landed gate: every markdown mode downgrades an unlanded "shipped" to "in progress" (landed sibling keeps shipped)', async () => {
  for (const mode of ['post', 'changelog', 'digest', 'report']) {
    const { dir, landedSha, strandedSha } = landedAndStrandedRepo();
    const { work, outPath } = landedGateSetup({
      dir, mode, outFile: mode === 'changelog' ? 'CHANGELOG.md' : 'out.md',
      items: [
        { id: 'iu', repo: 'r', text: 'Stranded-branch work item.', status: 'shipped', primaryCommit: strandedSha },
        { id: 'il', repo: 'r', text: 'Landed work item.', status: 'shipped', primaryCommit: landedSha },
      ],
    });
    const io = makeIo();
    try {
      const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
      assert.equal(code, 0, `${mode}: real-but-unlanded work reports honestly, never aborts`);
      const out = readFileSync(outPath, 'utf8');
      const strandedLine = out.split('\n').find((l) => l.includes('Stranded-branch work item.'));
      const landedLine = out.split('\n').find((l) => l.includes('Landed work item.'));
      assert.ok(strandedLine, `${mode}: the unlanded item still renders (with its real receipt)`);
      assert.match(strandedLine, /\*\*in progress\*\*/, `${mode}: unlanded item is downgraded`);
      assert.doesNotMatch(strandedLine, /shipped/, `${mode}: unlanded item never reads shipped`);
      assert.match(landedLine, /\*\*shipped\*\*/, `${mode}: landed item keeps shipped`);
      assert.match(io.errBuf, /not landed on the default branch/, `${mode}: the downgrade is loud`);
      assert.ok(io.errBuf.includes(strandedSha.slice(0, 7)), `${mode}: the note names the commit`);
    } finally {
      cleanup(dir, work);
    }
  }
});

test('landed gate: page mode renders the unlanded item as in-progress and the legend claims landing, not merging', async () => {
  const { dir, landedSha, strandedSha } = landedAndStrandedRepo();
  const { work, outPath } = landedGateSetup({
    dir, mode: 'page', outFile: 'honestweek.report.html',
    items: [
      { id: 'iu', repo: 'r', status: 'shipped', title: 'Stranded entry', summary: 'Real work on an unmerged branch.', primaryCommit: strandedSha },
      { id: 'il', repo: 'r', status: 'shipped', title: 'Landed entry', summary: 'Work on the default branch.', primaryCommit: landedSha },
    ],
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    const html = readFileSync(outPath, 'utf8');
    const stranded = html.slice(Math.max(0, html.indexOf('Stranded entry') - 600), html.indexOf('Stranded entry'));
    const landed = html.slice(Math.max(0, html.indexOf('Landed entry') - 600), html.indexOf('Landed entry'));
    assert.match(stranded, /is-progress/, 'unlanded item carries the in-progress badge class');
    assert.doesNotMatch(stranded, /is-shipped/, 'unlanded item never carries the shipped class');
    assert.match(landed, /is-shipped/, 'landed item keeps the shipped class');
    assert.ok(!html.includes('built, merged, verified'), 'the legend no longer claims "merged" ambiguously');
    assert.ok(html.includes('landed on the default branch'), 'the legend states the enforced landing gate');
  } finally {
    cleanup(dir, work);
  }
});

test('landed gate: site mode artifact carries the downgraded status (same items chokepoint)', async () => {
  const { dir, landedSha, strandedSha } = landedAndStrandedRepo();
  const work = mkdtempSync(join(tmpdir(), 'hw-build-work-'));
  const artifact = join(work, 'artifact.json');
  writeFileSync(join(work, 'adapter.json'), JSON.stringify({
    artifact,
    tree: {
      type: 'object',
      props: {
        groups: {
          type: 'array', over: 'groups',
          item: {
            type: 'object',
            props: {
              items: {
                type: 'array', over: 'items',
                item: { type: 'object', props: {
                  status: { source: 'model', key: 'status' },
                  text: { source: 'model', key: 'text' },
                } },
              },
            },
          },
        },
      },
    },
  }));
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: dir, label: 'r', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'site', adapter: join(work, 'adapter.json') },
  }));
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    week: { start: '2024-06-10', end: '2024-06-16' },
    items: [
      { id: 'iu', repo: 'r', text: 'Stranded-branch work item.', status: 'shipped', primaryCommit: strandedSha },
      { id: 'il', repo: 'r', text: 'Landed work item.', status: 'shipped', primaryCommit: landedSha },
    ],
  }));
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    const art = JSON.parse(readFileSync(artifact, 'utf8'));
    const flat = (art.groups ?? []).flatMap((g) => g.items ?? []);
    assert.equal(flat.find((it) => it.text.includes('Stranded')).status, 'in progress');
    assert.equal(flat.find((it) => it.text.includes('Landed')).status, 'shipped');
  } finally {
    cleanup(dir, work);
  }
});

test('landed gate: the SAME sha in two repos is judged per repo, not last-verdict-wins', async () => {
  // A fork and its upstream (or a stale second clone) hold the same commit object,
  // landed in one and stranded in the other. Keyed by sha alone, the landed repo's
  // verdict overwrites the stranded one and the unlanded item keeps `shipped` — the
  // exact lie the gate exists to stop. The unlanded item is listed FIRST so the
  // overwrite would happen if the key were not per repo.
  const stranded = landedAndStrandedRepo();  // `shared` lives only on `feat` here
  const shared = stranded.strandedSha;
  const clone = mkdtempSync(join(tmpdir(), 'hw-build-clone-'));
  const work = mkdtempSync(join(tmpdir(), 'hw-build-work-'));
  const outPath = join(work, 'out.md');
  try {
    execFileSync('git', ['clone', '-q', stranded.dir, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
    git(clone, ['fetch', '-q', 'origin', 'feat:refs/heads/feat']);
    git(clone, ['merge', '-q', '--ff-only', shared]);  // same object, landed on main here
    assert.equal(git(clone, ['rev-parse', shared]).trim(), shared, 'precondition: one shared commit object');

    writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
      identity: { authorEmails: [ME] },
      week: { startsOn: 'monday', timezone: 'UTC' },
      repos: [
        { path: stranded.dir, label: 'a', role: 'featured' },
        { path: clone, label: 'b', role: 'featured' },
      ],
      redaction: { codenames: [], names: [], terms: [] },
      output: { mode: 'post', file: outPath },
    }));
    writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [
        { id: 'iu', repo: 'a', text: 'Stranded in repo A.', status: 'shipped', primaryCommit: shared },
        { id: 'il', repo: 'b', text: 'Landed in repo B.', status: 'shipped', primaryCommit: shared },
      ],
    }));
    const io = makeIo();
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    const lines = readFileSync(outPath, 'utf8').split('\n');
    const unlanded = lines.find((l) => l.includes('Stranded in repo A.'));
    const landed = lines.find((l) => l.includes('Landed in repo B.'));
    assert.match(unlanded, /\*\*in progress\*\*/, 'the repo where it never landed is downgraded');
    assert.doesNotMatch(unlanded, /shipped/, 'a sibling repo\'s landing never launders this claim');
    assert.match(landed, /\*\*shipped\*\*/, 'the repo where it did land keeps shipped');
    assert.match(io.errBuf, /repo "a"/, 'the downgrade names the repo it applies to');
  } finally {
    cleanup(stranded.dir, clone, work);
  }
});

test('landed gate: the tag-mapped path (`tag: verified`, no explicit status) is downgraded too', async () => {
  const { dir, strandedSha } = landedAndStrandedRepo();
  const { work, outPath } = landedGateSetup({
    dir, mode: 'digest', outFile: 'out.md',
    items: [{ id: 'iu', repo: 'r', text: 'Tag-verified stranded item.', tag: 'verified', primaryCommit: strandedSha }],
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    const line = readFileSync(outPath, 'utf8').split('\n').find((l) => l.includes('Tag-verified stranded item.'));
    assert.match(line, /\*\*in progress\*\*/);
  } finally {
    cleanup(dir, work);
  }
});

test('landed gate: ANY unlanded cited commit (candidateCommits included) breaks the shipped claim', async () => {
  const { dir, landedSha, strandedSha } = landedAndStrandedRepo();
  const { work, outPath } = landedGateSetup({
    dir, mode: 'digest', outFile: 'out.md',
    items: [{ id: 'iu', repo: 'r', text: 'Mixed-receipt item.', status: 'shipped', candidateCommits: [landedSha, strandedSha] }],
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    const line = readFileSync(outPath, 'utf8').split('\n').find((l) => l.includes('Mixed-receipt item.'));
    assert.match(line, /\*\*in progress\*\*/, 'shipped requires EVERY cited commit landed');
  } finally {
    cleanup(dir, work);
  }
});

test('landed gate: a non-shipped item citing an unlanded commit is untouched (the gate guards only shipped)', async () => {
  const { dir, strandedSha } = landedAndStrandedRepo();
  const { work, outPath } = landedGateSetup({
    dir, mode: 'digest', outFile: 'out.md',
    items: [{ id: 'ip', repo: 'r', text: 'Openly in-flight item.', status: 'in progress', primaryCommit: strandedSha }],
  });
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    const line = readFileSync(outPath, 'utf8').split('\n').find((l) => l.includes('Openly in-flight item.'));
    assert.match(line, /\*\*in progress\*\*/);
    assert.doesNotMatch(io.errBuf, /downgraded/, 'no downgrade note for an already-honest badge');
  } finally {
    cleanup(dir, work);
  }
});

test('landed gate: a shipped claim is UNVERIFIABLE (abort exit 2, write nothing) when no default branch is determinable', async () => {
  const dir = initRepo();
  const sha = commit(dir, { message: 'work' });
  const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== 'trunk') git(dir, ['branch', '-m', 'trunk']);
  git(dir, ['branch', 'scratch']); // two non-conventional branches, no origin
  const { work, outPath } = landedGateSetup({
    dir, mode: 'digest', outFile: 'out.md',
    items: [{ id: 'iu', repo: 'r', text: 'Unverifiable shipped claim.', status: 'shipped', primaryCommit: sha }],
  });
  const io = makeIo();
  try {
    await assert.rejects(
      () => runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io }),
      (err) => err.code === 2
    );
    assert.equal(io.exitCode, 2);
    assert.ok(!existsSync(outPath), 'nothing is written on the unverifiable-claim abort');
    assert.match(io.errBuf, /no determinable default branch/);
  } finally {
    cleanup(dir, work);
  }
});
