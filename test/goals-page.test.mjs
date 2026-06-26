// test/goals-page.test.mjs — the optional MULTI-PAGE goals build (page mode's
// second page, goals.html). Mirrors page.test.mjs: aggregation/resolution,
// escaping/no-injection, zero external resources, and the no-registry ->
// single-page-unchanged guard that protects the standalone report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateGoals,
  resolveGoal,
  validateObjectives,
  validateChangelog,
  buildReportsFromSnapshots,
} from '../lib/goals.mjs';
import { buildGoalsModel, render } from '../lib/emit/goals-page.mjs';
import { startServer } from '../lib/preview.mjs';
import { runBuild } from '../lib/build.mjs';

// --- fixtures ---------------------------------------------------------------

const registry = {
  schemaVersion: 1,
  groups: ['ops', 'site'],
  groupDescriptions: { ops: { teaser: 'The operator.', what: 'Run everything.', why: 'It compounds.' } },
  objectives: {
    'g-ops': { publicLabel: 'Run the operator', publicGroup: 'ops', kind: 'continuous', what: 'Drive goals.', why: 'Multiplier.', how: 'Real sessions.', howType: 'sessions' },
    'g-site': { publicLabel: 'Keep the site honest', publicGroup: 'site', kind: 'finite' },
  },
  projectToObjective: { 'proj-a': 'g-ops', 'proj-b': 'g-site' },
};

function latestReports() {
  return [
    {
      weekStart: '2024-06-10',
      weekLabel: 'jun 10 - 16',
      latest: true,
      items: [
        { id: 'i1', project: 'proj-a', status: 'shipped', date: '2024-06-12', dateLabel: 'jun 12', tier: 'headline', title: 'Did a thing', summary: 'A verified change.' },
        { id: 'i2', project: 'proj-a', status: 'in progress', date: '2024-06-11', dateLabel: 'jun 11', tier: 'routine', title: 'WIP', summary: 'Still going.' },
        { id: 'i3', project: 'unmapped', status: 'shipped', date: '2024-06-13', dateLabel: 'jun 13', tier: 'headline', title: 'Orphan', summary: 'No goal.' },
      ],
    },
  ];
}

// --- resolution + aggregation -----------------------------------------------

test('resolveGoal: objectiveId wins, else projectToObjective, else null (unmapped omitted)', () => {
  assert.equal(resolveGoal({ id: 'x', project: 'proj-a' }, registry).id, 'g-ops');
  assert.equal(resolveGoal({ id: 'y', project: 'proj-b' }, registry).id, 'g-site');
  assert.equal(resolveGoal({ id: 'z', objectiveId: 'g-site', project: 'proj-a' }, registry).id, 'g-site');
  assert.equal(resolveGoal({ id: 'q', project: 'unmapped' }, registry), null);
});

test('aggregateGoals: groups -> goal cards with own counts; unresolved omitted; latest-week href', () => {
  const agg = aggregateGoals(latestReports(), registry, null, { reportHref: 'report.html' });
  assert.equal(agg.groups.length, 2);
  const ops = agg.groups.find((g) => g.group === 'ops').goals.find((g) => g.objectiveId === 'g-ops');
  assert.equal(ops.entries, 2);
  assert.equal(ops.weeksActive, 1);
  assert.deepEqual(ops.statusCounts, { shipped: 1, 'in progress': 1 });
  // items most-recent-first; the latest week's rows deep-link into report.html
  assert.equal(ops.items[0].id, 'i1');
  assert.equal(ops.items[0].href, 'report.html#i1');
  // a registered goal with no resolved work still appears, at zero
  const site = agg.groups.find((g) => g.group === 'site').goals.find((g) => g.objectiveId === 'g-site');
  assert.equal(site.entries, 0);
  assert.equal(site.perWeek[0].count, 0);
  // the orphan is counted as unresolved, never invented into a goal
  assert.equal(agg.unresolvedByProject.unmapped, 1);
  assert.deepEqual(agg.totals, { goals: 2, activeGoals: 1, entries: 2, weeksTracked: 1 });
});

test('aggregateGoals: older weeks render UNLINKED (no per-week archive page standalone)', () => {
  const reports = [
    { weekStart: '2024-06-03', weekLabel: 'jun 3 - 9', latest: false, items: [{ id: 'old1', project: 'proj-a', status: 'shipped', date: '2024-06-05', dateLabel: 'jun 5', tier: 'headline', title: 'Older', summary: '' }] },
    ...latestReports(),
  ];
  const agg = aggregateGoals(reports, registry, null, { reportHref: 'report.html' });
  const ops = agg.groups[0].goals.find((g) => g.objectiveId === 'g-ops');
  const older = ops.items.find((it) => it.id === 'old1');
  assert.equal(older.href, null);
  assert.equal(ops.weeksActive, 2);
});

test('aggregateGoals: a custom reportHref is honored in item rows', () => {
  const agg = aggregateGoals(latestReports(), registry, null, { reportHref: 'honestweek.report.html' });
  const ops = agg.groups[0].goals.find((g) => g.objectiveId === 'g-ops');
  assert.equal(ops.items[0].href, 'honestweek.report.html#i1');
});

test('aggregateGoals: change-log produces a newest-first band + per-goal provenance', () => {
  const changelog = {
    changes: [
      { id: 'add-site', week: '2024-06-09', type: 'add', note: 'Added the site goal', from: [], to: [{ id: 'g-site' }], published: [] },
      { id: 'add-ops', week: '2024-06-12', type: 'add', note: 'Added the operator goal', from: [], to: [{ id: 'g-ops' }], published: [] },
    ],
  };
  const agg = aggregateGoals(latestReports(), registry, changelog, { reportHref: 'report.html' });
  assert.equal(agg.changes.length, 2);
  // append order is oldest-first; the band renders newest-first
  assert.equal(agg.changes[0].id, 'add-ops');
  assert.equal(agg.changes[0].to[0].label, 'Run the operator');
  assert.equal(agg.changes[0].to[0].href, '#goal-g-ops');
  const ops = agg.groups[0].goals.find((g) => g.objectiveId === 'g-ops');
  assert.equal(ops.provenance.state, 'added');
  assert.equal(ops.provenance.changeId, 'add-ops');
});

// --- validators (fail-closed publish gate) ----------------------------------

test('validateObjectives: a well-formed registry passes', () => {
  const { errors } = validateObjectives({ registry, projectLabels: ['proj-a', 'proj-b'] });
  assert.deepEqual(errors, []);
});

test('validateObjectives: structural problems fail closed', () => {
  const bad = {
    groups: ['ops'],
    objectives: {
      'g-1': { publicLabel: 'ok', publicGroup: 'nope' }, // group not in groups
      'g-2': { publicLabel: 'bad kind', publicGroup: 'ops', kind: 'weird' }, // bad kind
      'bad id!': { publicLabel: 'x', publicGroup: 'ops' }, // non-anchor-safe id
    },
    projectToObjective: { 'proj-a': 'does-not-exist' }, // dangling value
  };
  const { errors } = validateObjectives({ registry: bad, projectLabels: ['proj-a'] });
  assert.ok(errors.some((e) => /publicGroup/.test(e)));
  assert.ok(errors.some((e) => /kind/.test(e)));
  assert.ok(errors.some((e) => /anchor-safe slug/.test(e)));
  assert.ok(errors.some((e) => /does not resolve/.test(e)));
});

test('validateObjectives: a label carrying a configured private term fails (redactor-stable)', () => {
  const reg = { groups: ['ops'], objectives: { 'g-1': { publicLabel: 'SECRET plan', publicGroup: 'ops' } }, projectToObjective: {} };
  const redactor = { redact: (s) => s.replace(/SECRET/g, '[redacted:term]') };
  const { errors } = validateObjectives({ registry: reg, redactor });
  assert.ok(errors.some((e) => /configured private term/.test(e)));
});

test('validateChangelog: dangling live ref + retired-parent-still-present fail closed', () => {
  const reg = { groups: ['ops'], objectives: { 'g-1': { publicLabel: 'live', publicGroup: 'ops' } }, projectToObjective: {} };
  const dangling = { changes: [{ id: 'c1', week: '2024-06-10', type: 'add', note: 'n', from: [], to: [{ id: 'ghost' }], published: [] }] };
  assert.ok(validateChangelog({ changelog: dangling, registry: reg }).errors.some((e) => /does not resolve to a live/.test(e)));
  const stillPresent = { changes: [{ id: 'c2', week: '2024-06-10', type: 'retire', note: 'n', from: [{ id: 'g-1', label: 'live' }], to: [], published: [] }] };
  assert.ok(validateChangelog({ changelog: stillPresent, registry: reg }).errors.some((e) => /must be absent/.test(e)));
});

// --- cross-week snapshot shaping --------------------------------------------

test('buildReportsFromSnapshots: current model is authoritative for its own week; project = repo label', () => {
  const currentModel = { groups: [{ label: 'proj-a', items: [{ id: 'i1', status: 'shipped', date: '2024-06-12', dateLabel: 'jun 12', tier: 'headline', title: 'Fresh', summary: '' }] }] };
  const archived = [
    { week: { start: '2024-06-03', end: '2024-06-09' }, report: { groups: [{ label: 'proj-a', items: [{ id: 'h1', status: 'shipped', date: '2024-06-05', title: 'Old' }] }] } },
    { week: { start: '2024-06-10', end: '2024-06-16' }, report: { groups: [{ label: 'proj-a', items: [{ id: 'STALE', status: 'shipped', title: 'Stale' }] }] } },
  ];
  const reports = buildReportsFromSnapshots({ currentWeek: { start: '2024-06-10', end: '2024-06-16' }, currentModel, archived });
  assert.equal(reports.length, 2); // stale 06-10 snapshot dropped; current 06-10 + 06-03
  const cur = reports.find((r) => r.weekStart === '2024-06-10');
  assert.equal(cur.latest, true);
  assert.equal(cur.items[0].id, 'i1'); // from currentModel, not the stale snapshot
  assert.equal(cur.items[0].project, 'proj-a');
  const old = reports.find((r) => r.weekStart === '2024-06-03');
  assert.equal(old.latest, false);
  assert.equal(old.items[0].project, 'proj-a');
});

test('a per-item objectiveId overrides the repo->goal mapping through aggregation', () => {
  // proj-a maps to g-ops, but this item's explicit objectiveId routes it to g-site.
  const currentModel = { groups: [{ label: 'proj-a', items: [{ id: 'i1', objectiveId: 'g-site', status: 'shipped', date: '2024-06-12', dateLabel: 'jun 12', tier: 'headline', title: 'Cross-goal', summary: '' }] }] };
  const reports = buildReportsFromSnapshots({ currentWeek: { start: '2024-06-10', end: '2024-06-16' }, currentModel, archived: [] });
  assert.equal(reports[0].items[0].objectiveId, 'g-site');
  const agg = aggregateGoals(reports, registry, null, { reportHref: 'report.html' });
  assert.equal(agg.groups.find((g) => g.group === 'site').goals.find((g) => g.objectiveId === 'g-site').entries, 1);
  assert.equal(agg.groups.find((g) => g.group === 'ops').goals.find((g) => g.objectiveId === 'g-ops').entries, 0);
});

// --- render -----------------------------------------------------------------

function fullModel() {
  const changelog = { changes: [{ id: 'add-ops', week: '2024-06-12', type: 'add', note: 'Added the operator goal', from: [], to: [{ id: 'g-ops' }], published: [] }] };
  const agg = aggregateGoals(latestReports(), registry, changelog, { reportHref: 'report.html' });
  return buildGoalsModel({ agg, registry, generatedAt: '2024-06-16T00:00:00Z', reportHref: 'report.html' });
}

test('render produces a self-contained goals document with cards, chips, what/why/how, band, cross-link', () => {
  const html = render(fullModel());
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('g-shell'));
  assert.ok(html.includes('id="goal-g-ops"'));
  assert.ok(html.includes('Run the operator'));
  assert.ok(html.includes('ongoing')); // kind chip for a continuous goal
  assert.ok(html.includes('Drive goals.')); // what
  assert.ok(html.includes('Multiplier.')); // why
  assert.ok(html.includes('What changed')); // the change band
  assert.ok(html.includes('id="changed-add-ops"'));
  assert.ok(html.includes('2 goals across 2 areas')); // honest counts
  assert.ok(html.includes('href="report.html"')); // footer cross-link back to the report
  assert.ok(html.includes('<script>'));
});

test('curated goals prose is HTML-escaped (no markup injection)', () => {
  const reg = {
    groups: ['ops'],
    objectives: { 'g-1': { publicLabel: '<img src=x onerror=alert(1)>', publicGroup: 'ops', what: 'a < b && c > d' } },
    projectToObjective: {},
  };
  const changelog = { changes: [{ id: 'c1', week: '2024-06-10', type: 'add', note: '<script>alert(2)</script>', from: [], to: [{ id: 'g-1' }], published: [] }] };
  const agg = aggregateGoals([], reg, changelog, { reportHref: 'report.html' });
  const html = render(buildGoalsModel({ agg, registry: reg, generatedAt: '2024-06-16T00:00:00Z' }));
  assert.ok(!html.includes('<img src=x onerror'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('a &lt; b &amp;&amp; c &gt; d'));
  assert.ok(!html.includes('<script>alert(2)'));
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
});

test('the goals page has NO external resources (zero-egress promise)', () => {
  const html = render(fullModel());
  assert.ok(!/<link\b/i.test(html));
  assert.ok(!/src\s*=\s*["']https?:/i.test(html));
  assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(html));
});

// --- preview serves BOTH pages ----------------------------------------------

test('startServer serves a multi-page routes map; cross-link paths resolve, others 404', async () => {
  const routes = { '/': 'REPORT', '/honestweek.report.html': 'REPORT', '/goals.html': 'GOALS' };
  const handle = await startServer({ port: 0, routes, csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  try {
    const get = async (p) => {
      const res = await fetch(`http://127.0.0.1:${handle.port}${p}`);
      return { status: res.status, body: await res.text() };
    };
    assert.equal((await get('/')).body, 'REPORT');
    assert.equal((await get('/goals.html')).body, 'GOALS');
    assert.equal((await get('/honestweek.report.html')).body, 'REPORT');
    assert.equal((await get('/nope.html')).status, 404);
  } finally {
    await handle.close();
  }
});

// --- build integration (git-grounded) ---------------------------------------

const ME = 'me@example.com';
let counter = 0;
function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-goals-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commit(dir, { message = 'work', dateISO = '2024-06-12T10:00:00Z' } = {}) {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
class ExitError extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}
function makeIo() {
  const io = { outBuf: '', errBuf: '', exitCode: null, out(s) { io.outBuf += s; }, err(s) { io.errBuf += s; }, exit(c) { io.exitCode = c; throw new ExitError(c); } };
  return io;
}
function cleanup(...dirs) {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}
function setupPage(work, repoDir, { withRegistry = true, registryJson } = {}) {
  const reportFile = join(work, 'honestweek.report.html');
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repoDir, label: 'r', role: 'featured' }],
    output: { mode: 'page', file: reportFile },
  }));
  return reportFile;
}

test('page mode WITH a registry writes report.html + goals.html, cross-linked', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'fix the thing' });
  const work = mkdtempSync(join(tmpdir(), 'hw-goals-work-'));
  const reportFile = setupPage(work, repoDir);
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    week: { start: '2024-06-10', end: '2024-06-16' },
    content: { headline: 'My week.' },
    items: [{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: sha, title: 'Fixed the thing', summary: 'A real change.' }],
  }));
  writeFileSync(join(work, 'honestweek.objectives.json'), JSON.stringify({
    schemaVersion: 1,
    groups: ['tooling'],
    objectives: { 'g-r': { publicLabel: 'Ship the tool', publicGroup: 'tooling', kind: 'continuous', what: 'Build it.', why: 'It helps.', how: 'Sessions.', howType: 'sessions' } },
    projectToObjective: { r: 'g-r' },
  }));
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    assert.equal(io.exitCode, null);
    const goalsFile = join(work, 'goals.html');
    assert.ok(existsSync(reportFile));
    assert.ok(existsSync(goalsFile));
    const report = readFileSync(reportFile, 'utf8');
    const goals = readFileSync(goalsFile, 'utf8');
    // report cross-links to goals + carries the item anchor
    assert.ok(report.includes('href="goals.html"'));
    assert.ok(report.includes('id="i1"'));
    // goals shows the goal + deep-links the item back into the report's filename
    assert.ok(goals.includes('Ship the tool'));
    assert.ok(goals.includes('id="goal-g-r"'));
    assert.ok(goals.includes('honestweek.report.html#i1'));
    assert.ok(goals.includes('Fixed the thing'));
    // zero external resources on the second page too
    assert.ok(!/<link\b/i.test(goals));
    assert.ok(!/src\s*=\s*["']https?:/i.test(goals));
  } finally {
    cleanup(repoDir, work);
  }
});

test('page mode WITHOUT a registry stays single-page (no goals.html, no cross-link) — guards PR #42', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'plain change' });
  const work = mkdtempSync(join(tmpdir(), 'hw-goals-nored-'));
  const reportFile = setupPage(work, repoDir);
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    week: { start: '2024-06-10', end: '2024-06-16' },
    items: [{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: sha, title: 'Plain', summary: 'No goals here.' }],
  }));
  const io = makeIo();
  try {
    const code = await runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io });
    assert.equal(code, 0);
    assert.ok(existsSync(reportFile));
    assert.ok(!existsSync(join(work, 'goals.html')));
    assert.ok(!readFileSync(reportFile, 'utf8').includes('href="goals.html"'));
  } finally {
    cleanup(repoDir, work);
  }
});

test('page mode with an INVALID registry aborts (exit 2) and writes NOTHING', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir, { message: 'change' });
  const work = mkdtempSync(join(tmpdir(), 'hw-goals-bad-'));
  const reportFile = setupPage(work, repoDir);
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    week: { start: '2024-06-10', end: '2024-06-16' },
    items: [{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: sha, title: 'X', summary: 'Y.' }],
  }));
  // publicGroup not in groups -> invalid
  writeFileSync(join(work, 'honestweek.objectives.json'), JSON.stringify({
    groups: ['tooling'],
    objectives: { 'g-r': { publicLabel: 'Ship', publicGroup: 'WRONG' } },
    projectToObjective: { r: 'g-r' },
  }));
  const io = makeIo();
  try {
    await assert.rejects(() => runBuild({ cwd: work, now: new Date('2024-06-19T12:00:00Z'), io }), /exit 2/);
    assert.equal(io.exitCode, 2);
    assert.ok(/ABORTED/.test(io.errBuf));
    // atomic: neither page is written when the registry is invalid
    assert.ok(!existsSync(reportFile));
    assert.ok(!existsSync(join(work, 'goals.html')));
  } finally {
    cleanup(repoDir, work);
  }
});
