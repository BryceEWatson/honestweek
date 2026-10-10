// `honestweek brief` (lib/ask-brief.mjs, lib/review/make.mjs): the honestweek.brief/1 JSON, the
// text, which options it takes, and the window it reads by default. It runs in-process on the
// shared fixture and on the made-up demo week, the way find and replay are tested.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsk } from '../lib/ask.mjs';
import { briefText, prWindow, startUnknownNote } from '../lib/ask-brief.mjs';
import { buildDemoWeek, DEMO_TERM } from '../lib/demo/week.mjs';
import { BRIEF_SCHEMA } from '../lib/review/make.mjs';
import { issueViewedAlone } from '../lib/review/brief.mjs';
import { at, writeReviewLogs, WINDOW } from './fixtures/replay/review-pr.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';
import { withoutUserConfig } from './helpers/no-user-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'honestweek.mjs');
const fx = writeReviewLogs(makeTempDir('hw-brief-'));
const FX_WEEK = { config: fx.config, roots: fx.roots, ...WINDOW, goalRecord: null, demo: false };
const d = buildDemoWeek();
after(() => rmSync(d.root, { recursive: true, force: true }));
const DEMO_WEEK = { config: { ...d.config, redaction: { ...d.config.redaction, terms: [...(d.config.redaction?.terms ?? []), DEMO_TERM] } }, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: null, demo: true };

async function asked(argv, week = FX_WEEK, command = 'brief') {
  const out = [];
  const err = [];
  const code = await runAsk({ command, argv, week, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, out: out.join(''), err: err.join('') };
}
const json = async (argv, week) => {
  const r = await asked([...argv, '--json'], week);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

/** Every string in `v` outside a {quoted} that isn't one of honestweek's ids, as [path, text]. */
function ownStrings(v, path = '', out = []) {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => ownStrings(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'quoted') ownStrings(x, `${path}.${k}`, out);
  return out;
}

test('the JSON names its schema, says it is no verdict, and gives every list a total', async () => {
  const o = await json(['#20']);
  assert.equal(o.schema, BRIEF_SCHEMA);
  assert.equal(o.command, 'brief');
  assert.match(o.notice, /isn't a review and gives no verdict/);
  assert.match(o.about, /\{"quoted": \.\.\.\}/);
  const lists = [o.change.commits, o.change.files, o.asked.issues, o.asked.related, o.asked.prompts, o.sessions, o.checks, o.rerun, o.readFirst, o.claims, o.tests.tampering, o.tests.files, o.tests.noVerify, o.tests.forcePush, o.problems.listed, o.problems.leftOut, o.steppedIn, o.unexplained.commits, o.unexplained.files, o.cantKnow, o.notes];
  for (const l of lists) assert.equal(l.total, l.items.length);
  assert.equal(o.change.commits.list, undefined);
  assert.equal(o.change.files.list, undefined);
  assert.ok(o.sessions.total >= 3 && o.checks.total >= 2 && o.claims.total >= 1);
});

test('every row carries an evidence word, and every inferred one names a rule', async () => {
  const o = await json(['#23']);
  const rows = [o.change.head, o.change.base, ...o.change.commits.items, ...o.asked.issues.items, ...o.asked.prompts.items, ...o.checks.items, ...o.claims.items, ...o.steppedIn.items, ...o.unexplained.commits.items, ...o.unexplained.files.items];
  const WORDS = ['recorded', 'derived', 'inferred', 'missing'];
  for (const r of rows) assert.ok(WORDS.includes(r.evidence), JSON.stringify(r).slice(0, 200));
  for (const s of o.sessions.items) assert.ok(WORDS.includes(s.roleEvidence) && s.roleRule);
  for (const c of o.claims.items) assert.ok(WORDS.includes(c.backing.level) && c.rule);
  for (const r of [o.change.head, ...o.change.branch.sources, ...o.asked.issues.items]) if (r.evidence === 'inferred') assert.ok(r.rule, JSON.stringify(r));
  for (const [id, text] of Object.entries(o.rules)) assert.ok(id.startsWith('brief.') && text, id);
});

test('log text appears only quoted, with no control characters', async () => {
  const o = await json(['#20']);
  const own = ownStrings(o).map(([, s]) => s).join('\n');
  // The issue's printed text, the prompts and the claims are quoted, never loose.
  assert.ok(!own.includes('Stream it instead'), 'the issue text sits only inside {quoted}');
  assert.ok(!own.includes('Work on issue 19'), 'a prompt sits only inside {quoted}');
  assert.ok(!own.includes('all tests pass'), 'a claim sits only inside {quoted}');
  const quoted = JSON.stringify(o).match(/"quoted":"((?:[^"\\]|\\.)*)"/g) ?? [];
  assert.ok(quoted.length > 5);
  for (const q of quoted) assert.doesNotMatch(JSON.parse(`{${q}}`).quoted, /[\u0000-\u0008\u000b-\u001f\u007f]/);
});

test('no private text: a private word never reaches the answer', async () => {
  for (const argv of [['#14'], ['#14', '--json']]) {
    const r = await asked(argv, DEMO_WEEK);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.toLowerCase().includes(DEMO_TERM), `${argv.join(' ')} shows the private word`);
    assert.match(r.out, /\[redacted:term\]/, 'the failing-path partner: the private word was there to hide');
  }
});

const VERDICT = /\b(?:looks good|looks fine|safe to merge|ready to merge|approved?|ready|lgtm|ship it)\b/i;
test("honestweek's own words carry no verdict", async () => {
  for (const [q, week] of [['#20', FX_WEEK], ['#21', FX_WEEK], ['#23', FX_WEEK], ['#14', DEMO_WEEK]]) {
    const text = (await asked([q], week)).out;
    for (const line of text.split('\n')) {
      if (/^\s*>/.test(line)) continue;
      assert.doesNotMatch(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'), VERDICT, `${q}: ${line}`);
    }
    const o = await json([q], week);
    for (const [path, s] of ownStrings(o)) if (!/\.(title|subject|command|text|name|lane)$/.test(path)) assert.doesNotMatch(s, VERDICT, `${q} ${path}`);
  }
});

test('the text stays near 80 lines, ends capped lists with a pointer to --json, and prints no raw step', async () => {
  for (const q of ['#20', '#21', '#23']) {
    const t = (await asked([q])).out;
    const lines = t.trimEnd().split('\n');
    assert.ok(lines.length <= 85, `${q}: ${lines.length} lines`);
    for (const l of lines) assert.ok(l.length <= 400, `${q}: a line of ${l.length} characters`);
    for (const s of ['The change', 'What was asked', 'Sessions behind it', 'Checks its steps ran', 'Claims to check', 'Tests and hooks', 'Other problems in its steps', 'Where you stepped in', 'Changes no session explains', "What this brief can't know"]) assert.ok(t.includes(s), `${q}: ${s}`);
  }
  const t20 = (await asked(['#20'])).out;
  assert.match(t20, /Run these yourself, at its latest commit: "node --test"/);
  assert.match(t20, /Issue #19, which it closes \(inferred, brief\.issue-closes\)/);
  assert.match(t20, /Named but not closed, so only related: #12/);
  assert.match(t20, /Open it on the page: .* view --from 2024-06-10 --to 2024-06-16 --timezone UTC --page "replay\.html\?session=/);
  assert.match(t20, /Next: .* replay cc-/);
});

test('--evidence-only drops the author\'s words, and says so', async () => {
  const o = await json(['#23', '--evidence-only']);
  assert.equal(o.claims, null);
  assert.equal(o.evidenceOnly, true);
  const t = (await asked(['#23', '--evidence-only'])).out;
  assert.match(t, /Claims to check: left out \(--evidence-only\)/);
  assert.doesNotMatch(t, /Tests pass now in the worktree/);
});

test('--head, --base, --issue and --repo reach the brief; other commands refuse them', async () => {
  const o = await json(['#21', '--head', fx.git.e2, '--issue', '30']);
  assert.equal(o.change.head.sha, fx.git.e2);
  assert.equal(o.change.head.evidence, 'recorded');
  assert.deepEqual(o.asked.issues.items.map((x) => [x.number, x.evidence]), [[30, 'recorded']]);
  assert.ok(o.notes.items.some((n) => n.kind === 'head-differs'));
  for (const opt of [['--head', 'abc1234'], ['--evidence-only'], ['--repo', 'x']]) {
    const r = await asked(['#20', ...opt], FX_WEEK, 'find');
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown option/);
  }
});

test('a question it can\'t answer as asked gets a reason and exit 1', async () => {
  for (const [argv, re] of [[[], /brief needs a pull request/], [['#999'], /more than one configured repository/], [['hello'], /doesn't name a pull request/], [['#20', '--head', '--bad'], /--head needs a value|--head takes/], [['#20', '#21'], /one pull request/]]) {
    const r = await asked(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, re, argv.join(' '));
  }
  // A display-only repository's pull request answers, with nothing from git.
  const r = await asked(['#20', '--repo', 'a-private-project']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /display-only/);
});

test('by default it reads the pull request\'s own dates', () => {
  const dir = makeTempDir('hw-brief-cfg-');
  const file = join(dir, 'honestweek.config.json');
  writeFileSync(file, JSON.stringify({ identity: { authorEmails: ['you@example.com'] }, week: { startsOn: 'monday', timezone: 'UTC' }, repos: [{ path: fx.repo, label: 'your-project', role: 'featured' }], redaction: { codenames: [], names: [], terms: [] }, output: { mode: 'digest', file: 'x.md' } }));
  const now = Date.parse('2024-07-01T00:00:00Z');
  // Squash-merged on 11 June: a squash keeps no first commit, so 3 days before it landed to 2 days
  // after, marked so the command can read further back.
  assert.deepEqual(prWindow({ configFile: file, query: '#20', values: {}, now }), { from: '2024-06-08', to: '2024-06-13', startUnknown: true, landedAt: Date.parse(at(40)) });
  // Open, with the head given: from its first commit, to today.
  assert.deepEqual(prWindow({ configFile: file, query: '#21', values: { '--head': fx.git.e2 }, now }), { from: '2024-06-08', to: '2024-07-01' });
  // Open with nothing to go on: the usual window.
  assert.equal(prWindow({ configFile: file, query: '#21', values: {}, now }), null);
  assert.equal(prWindow({ configFile: file, query: 'branch:x', values: {}, now }), null);
});

test('a squash with no log near its landing reads further back, then says what it could not find', async () => {
  const dir = makeTempDir('hw-brief-squash-');
  const file = join(dir, 'honestweek.config.json');
  writeFileSync(file, JSON.stringify({ identity: { authorEmails: ['you@example.com'] }, week: { startsOn: 'monday', timezone: 'UTC' }, repos: [{ path: fx.repo, label: 'your-project', role: 'featured' }], redaction: { codenames: [], names: [], terms: [] }, output: { mode: 'digest', file: 'x.md' } }));
  // No logs at all: nothing names pull request 20's commits, near its landing or before.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
  const run = async (argv) => {
    const out = [];
    const err = [];
    const code = await runAsk({ command: 'brief', argv: [...argv, '--config', file], cwd: dir, env, now: () => Date.parse('2024-07-01T00:00:00Z'), io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
    return { code, out: out.join(''), err: err.join('') };
  };
  const r = await run(['#20', '--json']);
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  // 14 days before it landed on 11 June, to 2 days after.
  assert.deepEqual([o.window.from, o.window.to], ['2024-05-28', '2024-06-13']);
  const note = o.notes.items.find((n) => n.kind === 'squash-start-unknown');
  assert.match(note.text, /landed as a squash, so git can't say when its work started, and no log from 2024-05-28 on names its commits/);
  assert.equal(o.notes.total, o.notes.items.length);
  // Its commits aren't known, so none being unexplained says nothing; its files come from the
  // landing commit, so they are.
  assert.deepEqual([o.change.commits.evidence, o.unexplained.commits.known, o.unexplained.files.known], ['missing', false, true]);
  const t = (await run(['#20'])).out;
  assert.match(t, /commits unknown \(missing\), [1-9]\d* file\(s\) \(/, t);
  assert.match(t, /Commits no session made or printed: unknown, since its commits aren't known\./, t);
  assert.match(t, /Files no edit in its steps touched: [1-9]/, t);
  assert.match(t, /no log from 2024-05-28 on names its commits/, t);
  // With its commits unknown, no message of theirs was read, so the no-issue line says so.
  assert.equal(o.asked.issues.total, 0);
  assert.match(t, /named in its pull-request body or landing commit; its commits aren't known\./, t);
  // The files case: a list git couldn't read is unknown in the text too.
  const noFiles = { ...o, change: { ...o.change, files: { ...o.change.files, evidence: 'missing', total: 0, items: [] } } };
  const tf = briefText(noFiles, 'honestweek');
  assert.match(tf, /commits unknown \(missing\), files unknown \(missing\)\./, tf);
  assert.match(tf, /Files no edit in its steps touched: unknown, since its files aren't known\./, tf);
  // A log names a commit git here can't read: its message wasn't read either.
  const notInGit = { ...o, change: { ...o.change, commits: { ...o.change.commits, total: 1, items: [{ sha: 'abc1234def', subject: null, at: null, inGit: false, evidence: 'missing', via: 'pushed', loggedBy: [] }] } } };
  const tg = briefText(notInGit, 'honestweek');
  assert.match(tg, /named in its pull-request body or landing commit; none of its commits is in git here to read\./, tg);
});

test('the start-unknown note says only what it read: a merge is not called a squash, and named commits git cannot date are not "none"', () => {
  const merge = startUnknownNote({ kind: 'merge', named: false, from: '2024-05-28', widened: true });
  assert.doesNotMatch(merge, /squash/);
  assert.match(merge, /^Git can't list the commits it brought in, so it can't say when its work started, and no log from 2024-05-28 on names its commits\./);
  const named = startUnknownNote({ kind: 'squash', named: true, from: '2024-05-28', widened: false });
  assert.doesNotMatch(named, /names its commits/);
  assert.match(named, /no log from 2024-05-28 on names a commit of it that git here can date \(no earlier log fits in memory\)\./);
});

test('with not every commit message read, no issue found is said as such', async () => {
  const o = await json(['#21']);
  assert.equal(o.unexplained.commits.known, true);
  const cut = { ...o, asked: { ...o.asked, issues: { total: 0, items: [] } }, notes: { total: 1, items: [{ kind: 'messages-cut', text: 'Only the first 50 of its 60 commit messages were read for the issue it closes.' }] } };
  assert.match(briefText(cut, 'honestweek'), /No issue it closes is named in its pull-request body, its landing commit or the commit messages read, and not all of them were read\./);
  const whole = { ...cut, notes: { total: 0, items: [] } };
  assert.match(briefText(whole, 'honestweek'), /No issue it closes is named in its pull-request body, commits or landing commit\./);
});

test("an issue's text comes only from a line that printed it alone", () => {
  assert.equal(issueViewedAlone('gh issue view 19'), 19);
  assert.equal(issueViewedAlone('cd /path/to/your/repo && gh issue view #19 --comments'), 19);
  // Failing-path partners: another command's output, or a pipe that changes the text.
  assert.equal(issueViewedAlone('git log --oneline -3 && gh issue view 19'), null);
  assert.equal(issueViewedAlone('gh issue view 19 --json body -q .body | sed -n 1,20p'), null);
});

test('the text says how many steps came after it landed, and when a check ran on a branch made from its own', async () => {
  const o = await json(['#20']);
  const s = o.sessions.items[0];
  const later = { ...o, sessions: { ...o.sessions, items: [{ ...s, lanes: [...s.lanes, { lane: 'after it landed', steps: 4 }] }, ...o.sessions.items.slice(1)] } };
  assert.match(briefText(later, 'honestweek'), /; 4 came after it landed\./);
  const k = o.checks.items.at(-1);
  const tracked = { ...o, checks: { ...o.checks, items: [...o.checks.items.slice(0, -1), { ...k, folder: 'tracking-branch' }] } };
  const t = briefText(tracked, 'honestweek');
  assert.match(t, /on a branch made from or pushed to its branch \(inferred, brief\.tracks-branch\)/);
  for (const line of t.split('\n').filter((l) => !/^\s*>/.test(l))) assert.doesNotMatch(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'), VERDICT, line);
});

test('brief --help keeps its options to itself, and the command runs from the package', () => {
  const r = spawnSync(process.execPath, [BIN, 'brief', '--help'], { encoding: 'utf8', env: withoutUserConfig() });
  assert.equal(r.status, 0);
  for (const s of ['--head', '--base', '--issue', '--repo', '--evidence-only', 'gh pr view N --json headRefOid,baseRefOid,closingIssuesReferences', "It isn't a review and gives no verdict", '"Open it on the page", at the end of the text answer']) assert.ok(r.stdout.includes(s), s);
  // The brief's rows carry no page of their own, so its help doesn't say they do.
  assert.doesNotMatch(r.stdout, /names its page/);
  const demo = spawnSync(process.execPath, [BIN, 'brief', '#14', '--demo', '--json'], { encoding: 'utf8', env: withoutUserConfig(), timeout: 120e3 });
  assert.equal(demo.status, 0, demo.stderr);
  assert.equal(JSON.parse(demo.stdout).schema, BRIEF_SCHEMA);
});
