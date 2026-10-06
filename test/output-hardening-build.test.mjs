// What honestweek writes, checked against made-up private words and secrets: keys of
// data-keyed maps (a chart's repo labels, a project's stats, a tool name's count) go through
// the redactor like values do; archived weeks are redacted again with the current config on
// the goals page; a derived title is cut after redaction; Markdown item text can't forge a
// line, a link, raw HTML or a code span; the week's dates must be plain dates; and the goals
// page links its report as a relative, encoded path when the file name isn't plain.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBuild } from '../lib/build.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { augmentSiteModel } from '../lib/site/derive.mjs';
import { adaptSessions } from '../lib/claude-adapter.mjs';
import { validateItems } from '../lib/validate.mjs';
import { render as renderDigest } from '../lib/emit/digest.mjs';
import { render as renderPost } from '../lib/emit/post.mjs';
import { render as renderReport } from '../lib/emit/report.mjs';
import { render as renderChangelog } from '../lib/emit/changelog.mjs';
import { mdText, mdCode } from '../lib/emit/_shared.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ME = 'me@example.com';
const TERM = 'Zentrova';
const TOKEN = 'ghp_Qx7Lm2Rz9Kd4Vn8Tw1Yp5Hs3Jf6Bc0';
const NOW = new Date('2024-06-19T12:00:00Z');
const WEEK = { start: '2024-06-10', end: '2024-06-16' };

// Session logs come from an empty folder, never this machine's own.
let emptyHome;
const saved = {};
before(() => {
  emptyHome = makeTempDir('hw-oh-home-');
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    saved[k] = process.env[k];
    process.env[k] = emptyHome;
  }
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeTempDir(emptyHome);
});

let counter = 0;
function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo() {
  const dir = makeTempDir('hw-oh-repo-');
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
async function build(work) {
  const io = makeIo();
  let code;
  try {
    code = await runBuild({ cwd: work, now: NOW, io });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    code = e.code;
  }
  return { code, io };
}
function writeConfig(work, repoDir, { label = 'r', mode = 'page', file = join(work, 'report.html'), terms = [TERM], archive } = {}) {
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repoDir, label, role: 'featured' }],
    redaction: { codenames: [], names: [], terms },
    output: { mode, file, ...(archive ? { archive: true } : {}) },
  }));
}

// --- 1. keys -------------------------------------------------------------------------

test('page mode: a listed term in a repo label stays out of the chart labels and everywhere else', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  const work = makeTempDir('hw-oh-page-');
  try {
    writeConfig(work, repoDir, { label: `${TERM}-app` });
    writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
      week: WEEK,
      items: [{ id: 'i1', repo: `${TERM}-app`, status: 'shipped', primaryCommit: sha, title: 'Fixed the thing', summary: 'A real change.' }],
    }));
    const { code, io } = await build(work);
    assert.equal(code, 0, io.errBuf);
    const html = readFileSync(join(work, 'report.html'), 'utf8');
    assert.ok(!/zentrova/i.test(html), 'the term reached report.html');
    assert.match(html, /data-label="[^"]*\[redacted:term\]/, 'the chart label shows the placeholder');
  } finally {
    removeTempDir(repoDir);
    removeTempDir(work);
  }
});

test('site mode: the bundle written as data keeps no listed term in its keys', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  try {
    const config = {
      identity: { authorEmails: [ME] },
      week: { startsOn: 'monday', timezone: 'UTC' },
      repos: [{ path: repoDir, resolvedPath: repoDir, label: `${TERM}-app`, role: 'featured' }],
      redaction: { codenames: [], names: [], terms: [TERM] },
      output: { mode: 'site' },
    };
    const items = [{ id: 'i1', repo: `${TERM}-app`, project: `${TERM}-app`, status: 'shipped', primaryCommit: sha, text: 'A real change.', date: '2024-06-12' }];
    const verified = new Map([[sha, { sha, dateISO: '2024-06-12T10:00:00Z', subject: 'work' }]]);
    const bundle = augmentSiteModel({ week: WEEK, groups: [], items }, { config, items, verified, verifiedIndex: verified, week: WEEK, now: NOW, projectsRoot: emptyHome });
    assert.ok(/zentrova/i.test(JSON.stringify(bundle)), 'the made-up term is in the bundle before redaction');
    const out = JSON.stringify(createRedactor(config).deepRedact(bundle));
    assert.ok(!/zentrova/i.test(out), 'the term reached the written data');
  } finally {
    removeTempDir(repoDir);
  }
});

test('draft: a tool name holding a token is redacted as a key, and its count is kept', async () => {
  const root = makeTempDir('hw-oh-projects-');
  try {
    mkdirSync(join(root, 'proj-x'));
    const src = readFileSync(join(HERE, 'fixtures', 'claude-projects', 'proj-featured', 'sessA.jsonl'), 'utf8');
    const swapped = src.replace('"name":"Bash","input":{"command":"node --test"}', `"name":"${TOKEN}","input":{}`);
    assert.notEqual(swapped, src);
    writeFileSync(join(root, 'proj-x', 'sessA.jsonl'), swapped);
    const config = {
      identity: { authorEmails: ['dev@example.com'] },
      redaction: { codenames: [], names: [], terms: [] },
      repos: [{ label: 'featured-repo', path: '/work/featured-repo', resolvedPath: '/work/featured-repo', role: 'featured' }],
    };
    const entries = await adaptSessions({ config, weekStart: new Date('2024-06-10T00:00:00Z'), weekEnd: new Date('2024-06-16T23:59:59.999Z'), redactor: createRedactor(config), projectsRoot: root });
    assert.equal(entries.length, 1);
    assert.ok(!JSON.stringify(entries).includes('Qx7Lm2Rz9'), 'the token reached the draft');
    assert.equal(entries[0].toolSignal.counts['[redacted:secret]'], 1);
  } finally {
    removeTempDir(root);
  }
});

test('deepRedact merges keys that redact to the same text: counts add up, a day count keeps the larger', () => {
  const r = createRedactor({ redaction: { terms: [TERM] } });
  assert.deepEqual(r.deepRedact({ byRepo: { [TERM]: 2, [TERM.toUpperCase()]: 3, other: 1 } }), { byRepo: { '[redacted:term]': 5, other: 1 } });
  assert.deepEqual(
    r.deepRedact({ stats: { [TERM]: { entries: 2, daysActive: 3, statusCounts: { shipped: 2 } }, [TERM.toLowerCase()]: { entries: 1, daysActive: 2, statusCounts: { shipped: 1 } } } }),
    { stats: { '[redacted:term]': { entries: 3, daysActive: 3, statusCounts: { shipped: 3 } } } },
  );
  // Keys with nothing to hide are left as they are.
  const clean = { byRepo: { 'your-project': 1, '2024-06-12': 2, a1b2c3d: 3 } };
  assert.deepEqual(r.deepRedact(clean), clean);
});

test('validate reads every field that reaches the output, not just the text', () => {
  const config = { repos: [{ label: 'r', role: 'featured' }], redaction: { terms: [TERM] } };
  const base = { id: 'i1', repo: 'r', status: 'shipped', primaryCommit: 'a1b2c3d', text: 'A real change.' };
  assert.equal(validateItems([base], config).ok, true);
  for (const extra of [{ project: `${TERM}-app` }, { title: `The ${TERM} work` }, { area: TERM.toLowerCase() }]) {
    const res = validateItems([{ ...base, ...extra }], config);
    assert.equal(res.ok, false, JSON.stringify(Object.keys(extra)));
    assert.ok(res.problems.every((p) => !p.reason.includes(TERM)), 'validate never echoes the term');
  }
});

// --- 2. archived weeks on the goals page ---------------------------------------------

test('goals page: an archived week is redacted again with the current config', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  const work = makeTempDir('hw-oh-goals-');
  try {
    writeConfig(work, repoDir, { archive: true });
    writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
      week: WEEK,
      items: [{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: sha, title: 'Fixed the thing', summary: 'A real change.' }],
    }));
    writeFileSync(join(work, 'honestweek.objectives.json'), JSON.stringify({
      schemaVersion: 1,
      groups: ['tooling'],
      objectives: { 'g-r': { publicLabel: 'Ship the tool', publicGroup: 'tooling', kind: 'continuous', what: 'Build it.', why: 'It helps.', how: 'Sessions.', howType: 'sessions' } },
      projectToObjective: { r: 'g-r' },
    }));
    // A week archived before the term was added to the config.
    mkdirSync(join(work, 'honestweek.archive'));
    writeFileSync(join(work, 'honestweek.archive', '2024-06-03.json'), JSON.stringify({
      week: { start: '2024-06-03', end: '2024-06-09' },
      mode: 'page',
      report: { groups: [{ label: 'r', items: [{ id: 'old1', status: 'shipped', date: '2024-06-05', title: `Wired up ${TERM} sync`, summary: `Moved ${TERM} to the queue. Quietbrook marker.` }] }] },
    }));
    const { code, io } = await build(work);
    assert.equal(code, 0, io.errBuf);
    const goals = readFileSync(join(work, 'goals.html'), 'utf8');
    assert.ok(goals.includes('Wired up'), 'the archived item is on the goals page');
    assert.ok(!/zentrova/i.test(goals), 'the archived week showed the term');
  } finally {
    removeTempDir(repoDir);
    removeTempDir(work);
  }
});

// --- 3. derived title ------------------------------------------------------------------

test('page title: a secret across the cut is redacted before the title is cut', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  const work = makeTempDir('hw-oh-title-');
  try {
    writeConfig(work, repoDir, { terms: [] });
    // The token starts before the 69th character and ends after it.
    const summary = `${'Reworked the importer and the queue so that the '.slice(0, 60)}${TOKEN} landed`;
    writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
      week: WEEK,
      items: [{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: sha, summary }],
    }));
    const { code, io } = await build(work);
    assert.equal(code, 0, io.errBuf);
    const html = readFileSync(join(work, 'report.html'), 'utf8');
    assert.ok(!html.includes('ghp_'), 'a piece of the token reached the title');
  } finally {
    removeTempDir(repoDir);
    removeTempDir(work);
  }
});

// --- 6. Markdown -----------------------------------------------------------------------

const EVIL = 'Fixed it\n- **shipped** — forged line <img src=x onerror=alert(1)> [x](javascript:alert(1)) *loud*';
const model = (text, receipt = 'a1b2c3d') => ({ week: WEEK, groups: [{ label: 'r', items: [{ status: 'shipped', text, receipt, repo: 'r' }] }] });

test('Markdown outputs: item text stays on one line with links, HTML and emphasis escaped', () => {
  for (const [name, render] of [['digest', renderDigest], ['post', renderPost], ['report', renderReport], ['changelog', renderChangelog]]) {
    const out = render(model(EVIL), {});
    assert.ok(!out.includes('\n- **shipped** — forged'), `${name}: a newline forged a list line`);
    assert.ok(!out.includes('<img'), `${name}: raw HTML passed through`);
    assert.ok(!out.includes('[x](javascript:'), `${name}: a javascript link passed through`);
    assert.ok(out.includes('\\[x\\](javascript:alert(1))'), `${name}: the link text is kept, escaped`);
  }
});

test('Markdown outputs: a backtick in a receipt can not close its code span', () => {
  const out = renderPost(model('A change.', 'abc`def'), {});
  assert.ok(out.includes('(``abc`def``)'), out);
  assert.equal(mdCode('`x'), '`` `x ``');
  assert.equal(mdCode('a1b2c3d'), '`a1b2c3d`');
});

test('Markdown escaping leaves ordinary text as it was', () => {
  for (const s of ['Fixed the login redirect (22 tests).', 'Renamed parse_args to read_args.', 'Shipped v1.2 - see notes!', 'A & B > C']) {
    assert.equal(mdText(s), s);
  }
});

test('validate rejects item text that runs over more than one line, in plain words', () => {
  const res = validateItems([{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: 'a1b2c3d', text: 'one\ntwo' }], { repos: [{ label: 'r', role: 'featured' }] });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /more than one line/.test(p.reason)));
});

// --- 8. the week's dates ---------------------------------------------------------------

test('build: a week start that is not a plain date exits 2 and writes nothing', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  for (const start of ['../../x/a', '2024-06-1:x', '..\\..\\evil']) {
    const work = makeTempDir('hw-oh-week-');
    try {
      writeConfig(work, repoDir, { mode: 'digest', file: join(work, 'out.md'), archive: true });
      writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
        week: { start, end: '2024-06-16' },
        items: [{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: sha, text: 'A real change.' }],
      }));
      const before = readdirSync(work).sort();
      const { code, io } = await build(work);
      assert.equal(code, 2, `${start}: ${io.errBuf}`);
      assert.match(io.errBuf, /YYYY-MM-DD/);
      assert.deepEqual(readdirSync(work).sort(), before, `${start}: something was written`);
      assert.ok(!existsSync(join(work, 'out.md')));
    } finally {
      removeTempDir(work);
    }
  }
  removeTempDir(repoDir);
});

// --- 12. the goals page's report link --------------------------------------------------

test('goals page: a report file name that is not plain is linked as a relative, encoded path', async () => {
  const repoDir = initRepo();
  const sha = commit(repoDir);
  const work = makeTempDir('hw-oh-href-');
  try {
    writeConfig(work, repoDir, { terms: [], file: join(work, 'week #1.html') });
    writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
      week: WEEK,
      items: [{ id: 'i1', repo: 'r', status: 'shipped', primaryCommit: sha, title: 'Fixed the thing', summary: 'A real change.' }],
    }));
    writeFileSync(join(work, 'honestweek.objectives.json'), JSON.stringify({
      schemaVersion: 1,
      groups: ['tooling'],
      objectives: { 'g-r': { publicLabel: 'Ship the tool', publicGroup: 'tooling', kind: 'continuous', what: 'Build it.', why: 'It helps.', how: 'Sessions.', howType: 'sessions' } },
      projectToObjective: { r: 'g-r' },
    }));
    const { code, io } = await build(work);
    assert.equal(code, 0, io.errBuf);
    const goals = readFileSync(join(work, 'goals.html'), 'utf8');
    assert.ok(goals.includes('href="./week%20%231.html"'), 'the link is relative and encoded');
    assert.ok(!goals.includes('href="week #1.html'), 'the raw name was linked');
  } finally {
    removeTempDir(repoDir);
    removeTempDir(work);
  }
});
