import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.mjs';
import { runHistory } from '../lib/history.mjs';
import { landedCommitsInWindow, prNumberFromSubject } from '../lib/git.mjs';
import { buildClientModel, deriveClientStats, periodLabel } from '../lib/client.mjs';
import { render } from '../lib/emit/client.mjs';
import { normalizeConfig, OUTPUT_MODES, DEFAULT_OUTPUT_FILES } from '../lib/config.mjs';

const ME = 'me@example.com';
const OTHER = 'someone@else.test';
let counter = 0;
const dirs = [];

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function initRepo() {
  const dir = tmp('hw-client-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, { email = ME, message = 'work', dateISO = '2024-05-08T10:00:00Z' } = {}) {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
class ExitError extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}
function makeIo() {
  const io = { outBuf: '', errBuf: '', exitCode: null,
    out(s) { io.outBuf += s; }, err(s) { io.errBuf += s; },
    exit(code) { io.exitCode = code; throw new ExitError(code); } };
  return io;
}
async function build(work) {
  const io = makeIo();
  let code;
  try { code = await runBuild({ cwd: work, io, now: new Date('2024-07-01T12:00:00Z') }); } catch (e) { if (!(e instanceof ExitError)) throw e; code = e.code; }
  return { code, io };
}

// A client repo with a realistic history: three squash-merged pull requests of mine,
// one direct commit of mine, one pull request by someone else, a commit of mine
// outside the period, and a branch of mine that never merged.
function clientRepo() {
  const repo = initRepo();
  const shas = {};
  shas.before = commit(repo, { message: 'Early setup (#1)', dateISO: '2024-03-20T10:00:00Z' });
  shas.a = commit(repo, { message: 'Let people sign in with their school account (#12)', dateISO: '2024-04-03T10:00:00Z' });
  shas.other = commit(repo, { email: OTHER, message: 'Teammate change (#13)', dateISO: '2024-04-04T10:00:00Z' });
  shas.b = commit(repo, { message: 'Answers cite their sources (#15)', dateISO: '2024-04-17T09:00:00Z' });
  shas.direct = commit(repo, { message: 'Tidy the release notes', dateISO: '2024-04-17T15:00:00Z' });
  shas.c = commit(repo, { message: 'Show a clear message when the library is empty (#18)', dateISO: '2024-05-02T10:00:00Z' });
  git(repo, ['checkout', '-q', '-b', 'side']);
  shas.unmerged = commit(repo, { message: 'Half-finished idea (#20)', dateISO: '2024-05-06T10:00:00Z' });
  git(repo, ['checkout', '-q', 'main']);
  return { repo, shas };
}

function clientWorkspace({ repo, items, config = {} }) {
  const work = tmp('hw-client-work-');
  const cfg = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repo, label: 'app', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'client', file: join(work, 'report.html') },
    client: { name: 'Example Co', preparedFor: 'A. Reader', preparedBy: 'Dev', organization: 'Dev Studio', prLinks: { app: 'https://example.com/app/pull/' } },
    ...config,
  };
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify(cfg));
  if (items !== undefined) writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify(items));
  return { work, out: join(work, 'report.html') };
}

function goodItems(shas, overrides = {}) {
  return {
    period: { start: '2024-04-01', end: '2024-05-31' },
    content: {
      title: 'Example Co engineering report',
      headline: 'Sign-in and answers got more trustworthy.',
      summary: ['First paragraph.', 'Second paragraph.'],
      themes: [
        { id: 'access', title: 'Access', summary: 'Who can get in.' },
        { id: 'answers', title: 'Answers', summary: 'What people get back.' },
      ],
      next: ['Release the next build.'],
    },
    items: [
      { id: 'sso', repo: 'app', theme: 'access', title: 'School sign-in', summary: 'People sign in with the account they already have.', status: 'shipped', highlight: true, commits: [shas.a], receipt: { primaryCommit: shas.a } },
      { id: 'cite', repo: 'app', theme: 'answers', title: 'Answers <b>cite</b> sources', summary: 'Every answer names its sources.', status: 'shipped', commits: [shas.b], receipt: { primaryCommit: shas.b } },
    ],
    ...overrides,
  };
}

test.after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

test('prNumberFromSubject reads squash and merge-commit subjects, and nothing else', () => {
  assert.equal(prNumberFromSubject('Fix the thing (#42)'), 42);
  assert.equal(prNumberFromSubject('Merge pull request #7 from someone/branch'), 7);
  assert.equal(prNumberFromSubject('Mentions #9 in the middle'), null);
  assert.equal(prNumberFromSubject('Fix (#12) then more'), null);
  assert.equal(prNumberFromSubject(undefined), null);
});

test('landedCommitsInWindow counts only my commits that reached the default branch inside the window', () => {
  const { repo, shas } = clientRepo();
  const got = landedCommitsInWindow(repo, [ME], '2024-04-01T00:00:00.000Z', '2024-05-31T23:59:59.999Z');
  const listed = got.commits.map((c) => c.sha).sort();
  assert.deepEqual(listed, [shas.a, shas.b, shas.direct, shas.c].sort());
  assert.deepEqual(got.commits.map((c) => c.pr).sort(), [12, 15, 18, null].sort());
  assert.ok(!listed.includes(shas.unmerged), 'an unmerged branch never counts');
  assert.ok(!listed.includes(shas.other), 'someone else\'s pull request never counts');
  assert.ok(!listed.includes(shas.before), 'a commit before the period never counts');
});

test('failure path: an unreadable repo is null, never an empty list', () => {
  assert.equal(landedCommitsInWindow(join(tmpdir(), 'hw-no-such-repo-xyz'), [ME], '2024-01-01T00:00:00Z', '2024-12-31T00:00:00Z'), null);
});

test('client mode builds a report whose numbers all come from git', async () => {
  const { repo, shas } = clientRepo();
  const { work, out } = clientWorkspace({ repo, items: goodItems(shas) });
  const { code, io } = await build(work);
  assert.equal(code, 0, io.errBuf);
  const html = readFileSync(out, 'utf8');
  // 3 PRs of mine landed in the period; 4 non-merge commits (3 squash + 1 direct); 3 distinct days.
  assert.match(html, /<b>3<\/b><span>pull requests merged<\/span>/);
  assert.match(html, /<b>4<\/b><span>commits on the main branch<\/span>/);
  assert.match(html, /<b>3<\/b><span>days with work landed<\/span>/);
  assert.match(html, /<b>2<\/b><span>areas of work<\/span>/);
  // PR links are derived from the verified subject, not authored.
  assert.match(html, /href="https:\/\/example\.com\/app\/pull\/12">PR #12</);
  // The appendix lists every PR in the period, including the one no item describes.
  assert.match(html, /Show a clear message when the library is empty/);
  assert.match(html, /2 of them are described in the areas above/);
  assert.match(html, /1 commit landed without a pull request/);
  assert.doesNotMatch(html, /Half-finished idea|Teammate change|Early setup/);
  // Header, highlights, next steps, legend wording.
  assert.match(html, /April 1 to May 31, 2024/);
  assert.match(html, /A\. Reader/);
  assert.match(html, /class="hl"[^>]*href="#sso"|href="#sso"/);
  assert.match(html, /Planned, not done/);
  assert.match(html, />Merged</);
  assert.match(html, /doesn&#39;t by itself mean it has been released/);
});

test('curated strings are escaped and the page loads nothing from anywhere', async () => {
  const { repo, shas } = clientRepo();
  const items = goodItems(shas);
  items.content.headline = '<script>alert(1)</script>';
  const { work, out } = clientWorkspace({ repo, items });
  assert.equal((await build(work)).code, 0);
  const html = readFileSync(out, 'utf8');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Answers &lt;b&gt;cite&lt;\/b&gt; sources/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|<img|@import|url\(/i);
});

test('failure path: a cited commit outside the period aborts and writes nothing', async () => {
  const { repo, shas } = clientRepo();
  const items = goodItems(shas);
  items.items[0].commits = [shas.before];
  items.items[0].receipt = { primaryCommit: shas.before };
  const { work, out } = clientWorkspace({ repo, items });
  const { code, io } = await build(work);
  assert.equal(code, 2);
  assert.match(io.errBuf, /outside the report period/);
  assert.equal(existsSync(out), false);
});

test('failure path: a commit someone else authored aborts, as in every mode', async () => {
  const { repo, shas } = clientRepo();
  const items = goodItems(shas);
  items.items[1].commits = [shas.other];
  items.items[1].receipt = { primaryCommit: shas.other };
  const { work, out } = clientWorkspace({ repo, items });
  assert.equal((await build(work)).code, 2);
  assert.equal(existsSync(out), false);
});

test('an unmerged commit claimed as shipped is downgraded to In progress, never shown as Merged', async () => {
  const { repo, shas } = clientRepo();
  const items = goodItems(shas);
  items.items[1].commits = [shas.unmerged];
  items.items[1].receipt = { primaryCommit: shas.unmerged };
  const { work, out } = clientWorkspace({ repo, items });
  const { code, io } = await build(work);
  assert.equal(code, 0, io.errBuf);
  assert.match(io.errBuf, /downgraded to "in progress"/);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /<h4>Answers &lt;b&gt;cite&lt;\/b&gt; sources<\/h4><span class="pill progress">In progress<\/span>/);
});

test('failure path: client mode never guesses the period', async () => {
  const { repo, shas } = clientRepo();
  const items = goodItems(shas);
  delete items.period;
  const { work, out } = clientWorkspace({ repo, items });
  const { code, io } = await build(work);
  assert.equal(code, 1);
  assert.match(io.errBuf, /needs a "period"/);
  assert.equal(existsSync(out), false);
});

test('an unreadable second repo blanks the totals instead of shrinking them', () => {
  const { repo } = clientRepo();
  const config = normalizeConfig({
    identity: { authorEmails: [ME] },
    repos: [{ path: repo, label: 'app', role: 'featured' }, { path: join(tmpdir(), 'hw-missing-repo-abc'), label: 'gone', role: 'reference' }, { path: join(tmpdir(), 'hw-display-xyz'), label: 'secret', role: 'display' }],
    output: { mode: 'client' },
    client: { name: 'Example Co' },
  });
  const stats = deriveClientStats({ config, period: { start: '2024-04-01', end: '2024-05-31' } });
  assert.equal(stats.complete, false);
  assert.deepEqual(stats.unreadable, ['gone'], 'the display repo is never read, so it is not reported unreadable either');
  assert.equal(stats.totals.prs, null);
  const model = buildClientModel({ items: [], config, verified: [], period: { start: '2024-04-01', end: '2024-05-31' }, stats });
  const html = render(model);
  assert.match(html, /<b>—<\/b><span>pull requests merged<\/span>/);
  assert.match(html, /could not be read \(gone\)/);
});

test('long periods chart by month and short ones by week', () => {
  const { repo } = clientRepo();
  const config = normalizeConfig({ identity: { authorEmails: [ME] }, repos: [{ path: repo, label: 'app', role: 'featured' }], output: { mode: 'client' }, client: { name: 'X' } });
  const short = deriveClientStats({ config, period: { start: '2024-04-01', end: '2024-05-31' } });
  assert.equal(short.series.unit, 'week');
  assert.equal(short.series.buckets.reduce((n, b) => n + b.count, 0), 4);
  const long = deriveClientStats({ config, period: { start: '2023-01-01', end: '2024-12-31' } });
  assert.equal(long.series.unit, 'month');
  assert.equal(long.series.buckets.length, 24);
  assert.equal(long.series.buckets.reduce((n, b) => n + b.count, 0), 5);
  assert.equal(periodLabel('2023-12-15', '2024-01-10'), 'December 15, 2023 to January 10, 2024');
});

test('config: the client block is required for client mode and its links are checked', () => {
  const base = { identity: { authorEmails: [ME] }, repos: [{ path: '/path/to/your/repo', label: 'app', role: 'featured' }] };
  assert.ok(OUTPUT_MODES.includes('client'));
  assert.equal(DEFAULT_OUTPUT_FILES.client, 'honestweek.client.html');
  assert.throws(() => normalizeConfig({ ...base, output: { mode: 'client' } }), /"client" is required/);
  assert.throws(() => normalizeConfig({ ...base, output: { mode: 'client' }, client: {} }), /client\.name/);
  assert.throws(() => normalizeConfig({ ...base, output: { mode: 'client' }, client: { name: 'X', prLinks: { nope: 'https://example.com/' } } }), /not a configured repo label/);
  assert.throws(() => normalizeConfig({ ...base, output: { mode: 'client' }, client: { name: 'X', prLinks: { app: 'javascript:alert(1)' } } }), /https URL prefix/);
  const ok = normalizeConfig({ ...base, output: { mode: 'client' }, client: { name: 'X' } });
  assert.equal(ok.output.file, 'honestweek.client.html');
  // Absent from every other config, so existing configs normalize exactly as before.
  assert.equal('client' in normalizeConfig(base), false);
});

test('history lists what landed in the period into a gitignored sidecar, and prints only counts', async () => {
  const { repo } = clientRepo();
  const { work } = clientWorkspace({ repo, config: { repos: [{ path: repo, label: 'app', role: 'featured' }, { path: join(tmpdir(), 'hw-display-q'), label: 'secret', role: 'display' }] } });
  const io = makeIo();
  const code = await runHistory({ cwd: work, argv: ['--from', '2024-04-01', '--to', '2024-05-31'], io });
  assert.equal(code, 0, io.errBuf);
  assert.match(io.outBuf, /3 pull request\(s\) and 1 direct commit\(s\) from 1 repo\(s\)/);
  assert.doesNotMatch(io.outBuf, /school account/, 'no subject reaches stdout');
  const h = JSON.parse(readFileSync(join(work, 'honestweek.history.json'), 'utf8'));
  assert.deepEqual(h.repos.map((r) => r.label), ['app'], 'display repos are never read');
  assert.deepEqual(h.repos[0].prs.map((p) => p.pr), [12, 15, 18]);
  assert.match(readFileSync(join(work, '.gitignore'), 'utf8'), /^honestweek\.history\.json$/m);
});

test('failure path: history refuses a missing or backwards period', async () => {
  const { repo } = clientRepo();
  const { work } = clientWorkspace({ repo });
  for (const argv of [[], ['--from', '2024-05-01'], ['--from', '2024-05-01', '--to', '2024-04-01'], ['--from', '2024-02-30', '--to', '2024-03-01']]) {
    const io = makeIo();
    let code;
    try { code = await runHistory({ cwd: work, argv, io }); } catch (e) { code = e.code; }
    assert.equal(code, 1, argv.join(' '));
    assert.equal(existsSync(join(work, 'honestweek.history.json')), false);
  }
});

test('commits brought in by a merge commit count under that pull request, and merging is not authoring', () => {
  const repo = initRepo();
  commit(repo, { message: 'Start (#1)', dateISO: '2024-04-02T10:00:00Z' });
  // My pull request, merged by a teammate with a merge commit.
  git(repo, ['checkout', '-q', '-b', 'mine']);
  const m1 = commit(repo, { message: 'First part', dateISO: '2024-04-05T10:00:00Z' });
  const m2 = commit(repo, { message: 'Second part', dateISO: '2024-04-06T10:00:00Z' });
  git(repo, ['checkout', '-q', 'main']);
  const envOther = { ...process.env, GIT_AUTHOR_EMAIL: OTHER, GIT_COMMITTER_EMAIL: OTHER, GIT_AUTHOR_NAME: 'T', GIT_COMMITTER_NAME: 'T', GIT_AUTHOR_DATE: '2024-04-07T10:00:00Z', GIT_COMMITTER_DATE: '2024-04-07T10:00:00Z' };
  git(repo, ['merge', '--no-ff', '-q', '-m', 'Merge pull request #30 from team/mine', 'mine'], envOther);
  // A teammate's pull request that I merged: the merge commit is mine, the work is not.
  git(repo, ['checkout', '-q', '-b', 'theirs']);
  commit(repo, { email: OTHER, message: 'Their work', dateISO: '2024-04-08T10:00:00Z' });
  git(repo, ['checkout', '-q', 'main']);
  const envMe = { ...process.env, GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: '2024-04-09T10:00:00Z', GIT_COMMITTER_DATE: '2024-04-09T10:00:00Z' };
  git(repo, ['merge', '--no-ff', '-q', '-m', 'Merge pull request #31 from team/theirs', 'theirs'], envMe);

  const got = landedCommitsInWindow(repo, [ME], '2024-04-03T00:00:00Z', '2024-04-30T23:59:59Z');
  const byPr = Object.fromEntries(got.commits.filter((c) => !c.isMerge).map((c) => [c.sha, c.pr]));
  assert.equal(byPr[m1], 30);
  assert.equal(byPr[m2], 30);

  const config = normalizeConfig({ identity: { authorEmails: [ME] }, repos: [{ path: repo, label: 'app', role: 'featured' }], output: { mode: 'client' }, client: { name: 'X' } });
  const stats = deriveClientStats({ config, period: { start: '2024-04-03', end: '2024-04-30' } });
  assert.deepEqual(stats.prs.map((p) => p.pr), [30], 'the PR I only merged is not credited to me');
  assert.equal(stats.totals.commits, 2);
  assert.equal(stats.totals.directCommits, 0, 'merged-in commits are not "without a pull request"');
  const model = buildClientModel({
    items: [{ id: 'x', repo: 'app', title: 'Two-part change', status: 'shipped', commits: [m1, m2] }],
    config, verified: [m1, m2].map((sha) => ({ sha, shortSha: sha.slice(0, 7), subject: 'part', dateISO: '2024-04-05T10:00:00Z', repoLabel: 'app', landed: true })),
    period: { start: '2024-04-03', end: '2024-04-30' }, stats,
  });
  assert.deepEqual(model.themes[0].items[0].prs.map((p) => p.n), [30], 'a cited merged-in commit links to its pull request');
});
