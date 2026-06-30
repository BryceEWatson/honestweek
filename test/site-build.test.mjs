// End-to-end `site` output mode: build verifies the items against real git,
// augments the model with the git/session-derived sections, redacts, resolves a
// (synthetic, clean-room) adapter, and fact-fences the result. A clean adapter
// writes a deterministic artifact; an adapter whose authored prose states an
// unverified number aborts with exit 2 and writes nothing. The sessions root is a
// synthetic empty CLAUDE_CONFIG_DIR so the hero count is deterministic (0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.mjs';

const ME = 'me@example.com';
let counter = 0;

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-site-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, dateISO, message) {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
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
  const io = { outBuf: '', errBuf: '', exitCode: null, out(s) { io.outBuf += s; }, err(s) { io.errBuf += s; }, exit(code) { io.exitCode = code; throw new ExitError(code); } };
  return io;
}

/** A synthetic, clean-room adapter over a TOY artifact (no target field names). */
function toyAdapter(headline = 'a steady week') {
  return {
    artifact: 'data.json',
    clockFields: ['meta.updatedLabel'],
    volatileFields: ['days[].isToday'],
    tree: {
      type: 'object',
      props: {
        title: { source: 'const', value: 'Toy Report' },
        itemsTotal: { source: 'derived', key: 'provenance.itemsTotal' },
        commitsVerified: { source: 'derived', key: 'provenance.commitsVerified' },
        sessions: { source: 'derived', key: 'sessions.total' },
        chartMax: { source: 'derived', key: 'chart.max' },
        days: {
          type: 'array',
          over: 'chart.days',
          item: {
            type: 'object',
            props: {
              date: { source: 'derived', key: 'date' },
              total: { source: 'derived', key: 'total' },
              byRepo: { source: 'derivedTree', key: 'byRepo' },
            },
          },
        },
        headline: { source: 'freetext', value: headline },
      },
    },
  };
}

function setup({ headline } = {}) {
  const repoDir = initRepo();
  const sha = commit(repoDir, '2024-06-12T10:00:00Z', 'fix the login redirect');
  const work = mkdtempSync(join(tmpdir(), 'hw-site-work-'));
  // Synthetic, empty sessions root -> deterministic hero count of 0.
  const cfgDir = mkdtempSync(join(tmpdir(), 'hw-site-claude-'));
  mkdirSync(join(cfgDir, 'projects'));

  writeFileSync(join(work, 'honestweek.site.json'), JSON.stringify(toyAdapter(headline)));
  const config = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'site', adapter: 'honestweek.site.json' },
  };
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify(config));
  writeFileSync(
    join(work, 'honestweek.items.json'),
    JSON.stringify({
      week: { start: '2024-06-10', end: '2024-06-16' },
      items: [{ id: 'i1', repo: 'r', text: 'Shipped the login fix', tag: 'verified', primaryCommit: sha }],
    })
  );
  return { repoDir, work, cfgDir, sha, artifact: join(work, 'data.json') };
}

function cleanup(...dirs) {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

function withSessionsRoot(cfgDir, fn) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });
}

test('site mode writes a deterministic, fact-fenced artifact from the verified model', async () => {
  const { repoDir, work, cfgDir, artifact } = setup();
  const io = makeIo();
  try {
    await withSessionsRoot(cfgDir, async () => {
      const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
      assert.equal(code, 0);
      assert.equal(io.exitCode, null);
    });
    assert.ok(existsSync(artifact), 'the adapter artifact was written');
    const out = JSON.parse(readFileSync(artifact, 'utf8'));

    assert.equal(out.title, 'Toy Report');
    assert.equal(out.itemsTotal, 1);
    assert.equal(out.commitsVerified, 1);
    assert.equal(out.sessions, 0, 'empty synthetic sessions root -> hero of 0');
    assert.match(io.errBuf, /no Claude session logs found/, 'empty session root -> the no-logs diagnostic fires on stderr (build still succeeds)');
    assert.equal(out.chartMax, 1);
    assert.equal(out.days.length, 7);
    const day12 = out.days.find((d) => d.date === '2024-06-12');
    assert.deepEqual(day12, { date: '2024-06-12', total: 1, byRepo: { r: 1 } });
    assert.ok(out.days.filter((d) => d.date !== '2024-06-12').every((d) => d.total === 0));
    assert.equal(out.headline, 'a steady week');
  } finally {
    cleanup(repoDir, work, cfgDir);
  }
});

test('site mode is SILENT (no no-logs warning) when the session root has logs', async () => {
  // The no-false-alarm failure path: a populated root must NOT trip the diagnostic. Seed one interactive,
  // in-window session whose cwd is the configured repo 'r' (so it buckets under 'r', not 'other'); the
  // parent dir name 'proj' is non-ephemeral so the file is actually enumerated + scanned.
  const { repoDir, work, cfgDir, artifact } = setup();
  const sdir = join(cfgDir, 'projects', 'proj');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(
    join(sdir, 's1.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2024-06-12T09:00:00Z', cwd: repoDir, sessionId: 's1', message: { role: 'user', content: 'Help me ship the thing today.' } }) + '\n'
  );
  const io = makeIo();
  try {
    await withSessionsRoot(cfgDir, async () => {
      const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
      assert.equal(code, 0);
    });
    const out = JSON.parse(readFileSync(artifact, 'utf8'));
    assert.ok(out.sessions > 0, 'the seeded session is counted (root recognized)');
    assert.doesNotMatch(io.errBuf, /no Claude session logs found/, 'with logs present, the no-logs warning does NOT fire');
  } finally {
    cleanup(repoDir, work, cfgDir);
  }
});

test('site mode ABORTS (exit 2) and writes nothing when authored prose states an unverified number', async () => {
  const { repoDir, work, cfgDir, artifact } = setup({ headline: 'we shipped 42 things this week' });
  const io = makeIo();
  try {
    await withSessionsRoot(cfgDir, async () => {
      await assert.rejects(
        runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io }),
        (e) => e instanceof ExitError && e.code === 2
      );
    });
    assert.match(io.errBuf, /ABORTED/);
    assert.match(io.errBuf, /No output was written/);
    assert.ok(!existsSync(artifact), 'no artifact on a fact-fence abort');
  } finally {
    cleanup(repoDir, work, cfgDir);
  }
});

test('site mode requires output.adapter (config validation)', () => {
  const work = mkdtempSync(join(tmpdir(), 'hw-site-noadapter-'));
  try {
    const config = { identity: { authorEmails: [ME] }, repos: [{ path: '/x', label: 'r', role: 'featured' }], output: { mode: 'site' } };
    writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify(config));
    // loadConfig is exercised through runBuild; the missing adapter fails config (exit 1).
    const io = makeIo();
    return assert.rejects(runBuild({ cwd: work, io }), (e) => e instanceof ExitError && e.code === 1).then(() => {
      assert.match(io.errBuf, /output\.adapter.*required|required.*adapter/i);
    });
  } finally {
    cleanup(work);
  }
});
