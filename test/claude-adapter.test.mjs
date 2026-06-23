import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adaptSessions,
  enumerateSessionFiles,
  resolveProjectsRoot,
  reducePath,
} from '../lib/claude-adapter.mjs';
import { createRedactor } from '../lib/redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'claude-projects');

const WEEK_START = new Date('2024-06-10T00:00:00.000Z');
const WEEK_END = new Date('2024-06-16T23:59:59.999Z');

function config() {
  return {
    identity: { authorEmails: ['dev@example.com'] },
    redaction: { codenames: ['Falcon'], names: [], terms: [] },
    repos: [
      { label: 'featured-repo', path: '/work/featured-repo', resolvedPath: '/work/featured-repo', role: 'featured' },
      { label: 'display-repo', path: '/work/display-repo', resolvedPath: '/work/display-repo', role: 'display' },
    ],
  };
}

async function run(projectsRoot = FIXTURES) {
  const cfg = config();
  const redactor = createRedactor(cfg);
  const entries = await adaptSessions({ config: cfg, weekStart: WEEK_START, weekEnd: WEEK_END, redactor, projectsRoot });
  return { entries, byId: Object.fromEntries(entries.map((e) => [e.id, e])) };
}

const REQUIRED_FIELDS = ['id', 'date', 'project', 'repo', 'isPrivate', 'steers', 'assistantNotes', 'toolSignal', 'statusSignals', 'redirects', 'candidateCommits'];

test('enumeration uses CLAUDE_CONFIG_DIR/projects when set, else ~/.claude/projects', () => {
  assert.match(resolveProjectsRoot({ CLAUDE_CONFIG_DIR: '/custom/cfg' }).replace(/\\/g, '/'), /\/custom\/cfg\/projects$/);
  assert.match(resolveProjectsRoot({}).replace(/\\/g, '/'), /\.claude\/projects$/);
});

test('enumeration excludes subagents/* and returns only top-level session files', () => {
  const files = enumerateSessionFiles(FIXTURES);
  assert.ok(files.length >= 6);
  assert.ok(!files.some((f) => f.replace(/\\/g, '/').includes('/subagents/')), 'subagent transcripts must be excluded');
});

test('enumeration of an absent root returns [] (no throw)', () => {
  assert.deepEqual(enumerateSessionFiles(join(tmpdir(), 'definitely-not-here-zzz')), []);
});

test('adaptSessions emits one entry per interactive, in-window session (3): featured, private, display', async () => {
  const { entries, byId } = await run();
  assert.equal(entries.length, 3);
  assert.ok(byId.aaaaaaaa && byId.bbbbbbbb && byId.cccccccc);
  // automated (dddd), slash-command-only (eeee), out-of-window (ffff), subagent (9999) are absent
  assert.ok(!byId.dddddddd && !byId.eeeeeeee && !byId.ffffffff && !byId['99999999']);
});

test('every emitted entry conforms to the Digest schema', async () => {
  const { entries } = await run();
  for (const e of entries) {
    for (const f of REQUIRED_FIELDS) assert.ok(f in e, `missing field ${f}`);
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.isPrivate, 'boolean');
    assert.ok(Array.isArray(e.steers) && Array.isArray(e.assistantNotes));
    assert.ok(e.toolSignal && typeof e.toolSignal.counts === 'object');
    assert.ok(Array.isArray(e.toolSignal.files) && Array.isArray(e.candidateCommits));
  }
});

test('featured entry: fidelity extracted; repo/project/date correct', async () => {
  const { byId } = await run();
  const a = byId.aaaaaaaa;
  assert.equal(a.isPrivate, false);
  assert.equal(a.repo, 'featured-repo');
  assert.equal(a.project, 'featured-repo');
  assert.equal(a.date, '2024-06-12');
  assert.deepEqual(a.toolSignal.counts, { Edit: 1, Bash: 2, Grep: 1 });
  assert.deepEqual(a.toolSignal.tests, ['node --test']);
  assert.deepEqual(a.toolSignal.searches, ['grep:ts']);
  assert.deepEqual(a.toolSignal.files, ['src/api/*.ts']);
  assert.ok(a.statusSignals.includes('pass'));
  assert.ok(a.steers.length >= 1 && a.assistantNotes.length >= 1);
  assert.ok(a.redirects.length >= 1, 'the "Actually, revert..." turn is a redirect');
});

test('NO raw basename appears anywhere in a featured entry (path reduced to dir+ext)', async () => {
  const { byId } = await run();
  const blob = JSON.stringify(byId.aaaaaaaa);
  assert.ok(!blob.includes('secret-client-name'), 'basename must not leak');
  assert.ok(!blob.includes('secret-internal-query'), 'raw search query must not leak');
});

test('NO tool-result body appears; statusSignals carry status tokens only', async () => {
  const { byId } = await run();
  const blob = JSON.stringify(byId.aaaaaaaa);
  assert.ok(byId.aaaaaaaa.statusSignals.includes('pass'));
  assert.ok(!blob.includes('passed cleanly'), 'test-output body must not leak');
  assert.ok(!blob.includes('1 file changed'), 'commit body must not leak');
  assert.ok(!blob.includes('insertions'), 'commit body must not leak');
});

test('every string field is redacted; configured term + generic secrets scrubbed; SHAs + counts spared', async () => {
  const { byId } = await run();
  const blob = JSON.stringify(byId.aaaaaaaa);
  // scrubbed
  assert.ok(!blob.includes('Falcon'), 'configured codename scrubbed');
  assert.ok(!blob.includes('dev@example.com'), 'email scrubbed');
  assert.ok(!blob.includes('ghp_AAAA'), 'api token scrubbed');
  assert.ok(!blob.includes('/home/alice'), 'home path scrubbed');
  // spared
  assert.ok(blob.includes('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'), 'git SHA spared');
  assert.ok(blob.includes('22 tests'), 'plain count spared');
});

test('candidateCommits: { sha, date, empty subject }; sha preserved; NO body-derived subject', async () => {
  const { byId } = await run();
  const a = byId.aaaaaaaa;
  assert.equal(a.candidateCommits.length, 1);
  const c = a.candidateCommits[0];
  assert.equal(c.sha, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  assert.equal(c.date, '2024-06-12');
  // The adapter NOMINATES the sha only — it never emits a subject mined from the
  // tool-result body (which could carry arbitrary diff/PII/basename prose). The
  // real subject is re-derived later from the user's own git.
  assert.equal(c.subject, '');
});

test('REGRESSION (leak-hunt): reducePath bounds the extension and strips trailers/dotfiles', () => {
  const cwd = '/work/r';
  assert.equal(reducePath('/work/r/config/.env.client-acme-prod', cwd), 'config/*', 'dotfile post-dot name never exposed');
  assert.equal(reducePath('/work/r/data/leak.csv arg2 arg3', cwd), 'data/*.csv', 'trailing args stripped');
  assert.equal(reducePath('/work/r/data/board-deck.pdf#page=3-confidential', cwd), 'data/*.pdf', 'fragment stripped');
  assert.equal(reducePath('/work/r/src/leak-basename.ts:42:10', cwd), 'src/*.ts', ':line:col stripped');
  assert.equal(reducePath('/work/r/data/leak.csv?token=abc123', cwd), 'data/*.csv', 'query string stripped');
});

test('REGRESSION (leak-hunt): a non-hex session id is hashed, never echoing a configured term', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hw-id-'));
  try {
    const dir = join(root, 'p');
    mkdirSync(dir);
    const sid = 'Falcon99SECRET-credentials';
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', timestamp: '2024-06-12T09:00:00Z', cwd: '/work/featured-repo', sessionId: sid, message: { content: 'Do some featured work.' } }) + '\n'
    );
    const cfg = config();
    const entries = await adaptSessions({ config: cfg, weekStart: WEEK_START, weekEnd: WEEK_END, redactor: createRedactor(cfg), projectsRoot: root });
    assert.equal(entries.length, 1);
    assert.ok(!entries[0].id.includes('Falcon'), 'configured codename must not leak through the id');
    assert.match(entries[0].id, /^session-[0-9a-f]{8}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session whose cwd matches NO configured repo is private: empty candidateCommits, no git read', async () => {
  const { byId } = await run();
  const b = byId.bbbbbbbb;
  assert.equal(b.isPrivate, true);
  assert.equal(b.repo, null);
  assert.deepEqual(b.candidateCommits, []);
  const blob = JSON.stringify(b);
  assert.ok(!blob.includes('deadbeef'), 'no git read / no commit extraction for a private session');
  assert.ok(!blob.includes('BigClient'), 'private session content is not emitted');
});

test('a session whose cwd matches a display-role repo is private and never git-read', async () => {
  const { byId } = await run();
  const c = byId.cccccccc;
  assert.equal(c.isPrivate, true);
  assert.deepEqual(c.candidateCommits, []);
  assert.ok(!JSON.stringify(c).includes('cafef00d'), 'display repo is never git-read');
});

test('malformed JSON lines and unknown types are skipped without throwing (featured entry still complete)', async () => {
  // sessA contains a malformed line, a queue-operation, and a truncated final line.
  const { byId } = await run();
  assert.ok(byId.aaaaaaaa, 'entry produced despite malformed/partial lines');
  assert.equal(byId.aaaaaaaa.toolSignal.counts.Edit, 1);
});

test('classification reads only a bounded head: a human turn beyond the head is not seen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hw-head-'));
  try {
    const dir = join(root, 'proj');
    mkdirSync(dir);
    const lines = [];
    // first record carries an in-window timestamp + matching cwd, but NO human turn
    lines.push(JSON.stringify({ type: 'file-history-snapshot', timestamp: '2024-06-12T08:00:00Z', cwd: '/work/featured-repo', sessionId: 'headtest-0000' }));
    // ~120KB of tool-result padding so the human turn lands beyond the 64KB head
    const pad = 'x'.repeat(300);
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({ type: 'user', timestamp: '2024-06-12T08:00:01Z', cwd: '/work/featured-repo', sessionId: 'headtest-0000', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: pad, is_error: false }] } }));
    }
    // the ONLY human turn is here, beyond the head
    lines.push(JSON.stringify({ type: 'user', timestamp: '2024-06-12T08:30:00Z', cwd: '/work/featured-repo', sessionId: 'headtest-0000', message: { content: 'A late human turn the head read must not reach.' } }));
    writeFileSync(join(dir, 'late.jsonl'), lines.join('\n') + '\n');

    const cfg = config();
    const entries = await adaptSessions({ config: cfg, weekStart: WEEK_START, weekEnd: WEEK_END, redactor: createRedactor(cfg), projectsRoot: root });
    assert.equal(entries.length, 0, 'a human turn beyond the bounded head is not classified interactive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reducePath: under-cwd keeps last-2 dirs + ext; outside-cwd keeps only the extension', () => {
  assert.equal(reducePath('/work/featured-repo/src/api/x.ts', '/work/featured-repo'), 'src/api/*.ts');
  assert.equal(reducePath('/home/alice/secret.md', '/work/featured-repo'), '*.md', 'foreign dirs never leak');
  assert.equal(reducePath('C:\\work\\repo\\src\\a.ts', 'C:/work/repo'), 'src/*.ts');
});

test('fixtures are clean-room: no real personal email/home leaks in committed fixtures', () => {
  function walk(dir) {
    let blob = '';
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      blob += e.isDirectory() ? walk(p) : readFileSync(p, 'utf8');
    }
    return blob;
  }
  const all = walk(FIXTURES);
  assert.doesNotMatch(all, /@(?:gmail|outlook|yahoo|proton|icloud)\.com/i, 'only synthetic example.com emails');
});
