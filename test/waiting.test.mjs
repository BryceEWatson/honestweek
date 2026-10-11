// honestweek waiting: what's waiting on you, from every session's log (lib/waiting.mjs), its
// command (lib/ask-waiting.mjs) and the desktop app's titles (lib/app-sessions.mjs).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { askOf, findWaiting, promiseOf, readPrsFile, WAITING_RULES, WAITING_SCHEMA } from '../lib/waiting.mjs';
import { appSessionsRoot, readAppSessions } from '../lib/app-sessions.mjs';
import { runAsk } from '../lib/ask.mjs';
import { buildDemoWeek } from '../lib/demo/week.mjs';
import { DEMO_TERM } from '../lib/view.mjs';
import { refsContaining, hasRemoteBranch } from '../lib/git.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'honestweek.mjs');
const HOUR = 3600000;
const NOW = Date.parse('2026-03-20T12:00:00Z');
const iso = (t) => new Date(t).toISOString();

// ---- a made-up history, shaped as lib/replay/index.mjs builds one -----------------------------

function session(key, o = {}) {
  return { key, thread: `th-${key.slice(3)}`, tool: 'claude-code', repo: 'your-project', repoRole: 'featured', private: false, title: `Session ${key}`, endState: 'last-turn-ended', lastAt: iso(NOW - 10 * HOUR), ...o };
}
let n = 0;
function ev(s, kind, t, o = {}) {
  n += 1;
  return { id: `${s}.${n}.0`, kind, at: iso(t), t, session: s, agent: `${s}:main`, actor: kind === 'prompt' ? 'person' : 'agent', facts: {}, ...o };
}
const say = (s, t, text) => ev(s, 'message', t, { facts: { text: text.slice(0, 500) }, _raw: { text } });
const prompt = (s, t, text = 'go') => ev(s, 'prompt', t, { facts: { text } });
const history = (sessions, events, claudeIds = new Map()) => {
  const h = { sessions, events: events.sort((a, b) => a.t - b.t) };
  Object.defineProperty(h, 'claudeIds', { value: claudeIds, enumerable: false });
  return h;
};
const waiting = (h, o = {}) => findWaiting({ h, config: { repos: [], identity: { authorEmails: ['you@example.com'] } }, now: NOW, git: false, ...o });

// ---- the plain-text ask rule ---------------------------------------------------------------------

test('askOf reads a reply word, a lead that says something waits on you, and a closing question', () => {
  assert.deepEqual(askOf('Done with the fix.\n\nReply `merge` to land it, or `hold`.').words, ['merge', 'hold']);
  assert.deepEqual(askOf('It works.\n\nWhen you say `ship`, I will cut the release.').words, ['ship']);
  assert.deepEqual(askOf('Summary here.\n\nStill open, ranked:\n- `daily`: refresh each morning.\n- `build wake`: name what woke it.').words, ['daily', 'build wake']);
  assert.equal(askOf('Waiting on you: three steps.\n1. Quit the app.\n2. Run the script.').form, 'waiting-on-you');
  assert.equal(askOf('I found two ways to do it.\n\nWhich one do you want?').form, 'question');
  assert.equal(askOf('Start the **Finish the trial** chip. It needs a fresh session.').form, 'waiting-on-you');
});

test('askOf leaves alone a report, a "Nothing needs you" message, and backticks that are not replies', () => {
  assert.equal(askOf('Nothing needs you. The fix is live.\n\nSay `drop that too` if you want it gone.'), null);
  assert.equal(askOf("The verdict doesn't say `review-clean` because I wrote `abc1234` myself."), null);
  assert.equal(askOf('Changed files:\n- `lib/foo.mjs`: new rule.\n- `--json`: new flag.'), null);
  assert.equal(askOf('Merged and deployed. CI is green on main.'), null);
  // A question inside a code block isn't the message's question.
  assert.equal(askOf('Ran it:\n\n```\nproceed? [y/N]\n```\n\nIt finished.'), null);
});

test('promiseOf reads a next step in the last paragraph only', () => {
  assert.ok(promiseOf('Pushed.\n\nI\'ll merge once CI is green.'));
  assert.equal(promiseOf("I'll merge once CI is green.\n\nMerged."), null);
});

// ---- each kind of row, and what keeps one off the list -------------------------------------------

test('an unanswered ask is listed with its words, title, age, page and rule; an answered one is not', () => {
  const a = session('cc-aaaaaaaaaaaa');
  const b = session('cc-bbbbbbbbbbbb');
  const h = history([a, b], [
    prompt(a.key, NOW - 12 * HOUR), say(a.key, NOW - 10 * HOUR, 'Ready.\n\nReply `merge` to land PR 12.'),
    prompt(b.key, NOW - 12 * HOUR), say(b.key, NOW - 11 * HOUR, 'Reply `merge` to land it.'), prompt(b.key, NOW - 10 * HOUR, 'merge'), say(b.key, NOW - 9 * HOUR, 'Merged.'),
  ]);
  const w = waiting(h);
  assert.equal(w.rows.length, 1);
  const r = w.rows[0];
  assert.equal(r.kind, 'ask');
  assert.equal(r.session, a.key);
  assert.deepEqual(r.asked, ['merge']);
  assert.equal(r.rule, 'waiting.plain-ask');
  assert.equal(r.evidence, 'inferred');
  assert.equal(r.ageHours, 10);
  assert.equal(r.title, `Session ${a.key}`);
  assert.match(r.page, /^replay\.html\?session=cc-aaaaaaaaaaaa#th-aaaaaaaaaaaa~cc-aaaaaaaaaaaa\./);
  assert.match(r.quote, /Reply `merge`/);
});

test('an ask answered in a later session of the same thread is not listed', () => {
  const a = session('cc-aaaaaaaaaaaa', { thread: 'th-shared', lastAt: iso(NOW - 10 * HOUR) });
  const b = session('cc-cccccccccccc', { thread: 'th-shared', lastAt: iso(NOW - 2 * HOUR) });
  const h = history([a, b], [say(a.key, NOW - 10 * HOUR, 'Reply `go`.'), prompt(b.key, NOW - 3 * HOUR, 'go'), say(b.key, NOW - 2 * HOUR, 'Done, all landed.')]);
  assert.equal(waiting(h).rows.length, 0);
});

test('a session still running, one a program started, and one answering a program are not listed', () => {
  const running = session('cc-dddddddddddd', { endState: 'last-record-is-a-call-without-result', lastAt: iso(NOW - HOUR) });
  const headless = session('cc-eeeeeeeeeeee', { headless: true });
  const fromProgram = session('cc-ffffffffffff');
  const h = history([running, headless, fromProgram], [
    say(running.key, NOW - 2 * HOUR, 'Reply `go`.'), ev(running.key, 'action', NOW - HOUR, { facts: { category: 'shell' } }),
    say(headless.key, NOW - 10 * HOUR, 'Reply `go`.'),
    ev(fromProgram.key, 'agent-message', NOW - 11 * HOUR, { actor: 'program', facts: { from: 'program', text: 'review this' } }), say(fromProgram.key, NOW - 10 * HOUR, 'Reply `tighten` to apply it.'),
  ]);
  assert.deepEqual(waiting(h).rows, []);
});

test('a question asked through the question tool and never answered is a recorded ask', () => {
  const s = session('cc-gggggggggggg', { endState: 'last-record-is-a-call-without-result', lastAt: iso(NOW - 8 * HOUR) });
  const h = history([s], [prompt(s.key, NOW - 9 * HOUR), ev(s.key, 'action', NOW - 8 * HOUR, { facts: { category: 'question', tool: 'AskUserQuestion' } })]);
  const [r] = waiting(h).rows;
  assert.equal(r.kind, 'ask');
  assert.equal(r.rule, 'waiting.question-tool');
  assert.equal(r.evidence, 'recorded');
});

test('a session cut off mid-step or that never answered you is stalled once quiet long enough', () => {
  const cut = session('cc-hhhhhhhhhhhh', { endState: 'last-record-is-a-call-without-result', lastAt: iso(NOW - 8 * HOUR) });
  const unanswered = session('cc-iiiiiiiiiiii', { endState: 'last-record-is-an-unanswered-prompt', lastAt: iso(NOW - 30 * HOUR) });
  const interrupted = session('cc-jjjjjjjjjjjj', { endState: 'last-record-is-an-interruption', lastAt: iso(NOW - 30 * HOUR) });
  const h = history([cut, unanswered, interrupted], [
    ev(cut.key, 'action', NOW - 8 * HOUR, { facts: { category: 'shell' } }),
    prompt(unanswered.key, NOW - 30 * HOUR, 'are you there?'),
    ev(interrupted.key, 'interrupt', NOW - 30 * HOUR),
  ]);
  const rows = waiting(h).rows;
  assert.deepEqual(rows.map((r) => [r.session, r.rule]), [[cut.key, 'waiting.cut-off'], [unanswered.key, 'waiting.unanswered-prompt']]);
  assert.equal(waiting(h, { staleMs: 9 * HOUR }).rows.length, 1);
});

test('a kept promise is not stalled, a broken one is listed only with promises on', () => {
  const broken = session('cc-kkkkkkkkkkkk');
  const kept = session('cc-llllllllllll');
  const h = history([broken, kept], [
    say(broken.key, NOW - 10 * HOUR, "Pushed the branch.\n\nI'll merge once CI is green."),
    say(kept.key, NOW - 12 * HOUR, "I'll merge once CI is green."), ev(kept.key, 'action', NOW - 11 * HOUR, { facts: { category: 'shell' } }), say(kept.key, NOW - 10 * HOUR, 'Merged.'),
  ]);
  assert.equal(waiting(h).rows.length, 0);
  const rows = waiting(h, { promises: true }).rows;
  assert.deepEqual(rows.map((r) => [r.session, r.rule]), [[broken.key, 'waiting.stalled-promise']]);
});

test('the desktop app titles a session, and an archived or unlisted session is left out and counted', () => {
  const titled = session('cc-mmmmmmmmmmmm', { title: null });
  const archived = session('cc-nnnnnnnnnnnn');
  const unlisted = session('cc-oooooooooooo');
  const codex = session('cx-pppppppppppp', { tool: 'codex' });
  const ids = new Map([[titled.key, 'id-titled'], [archived.key, 'id-archived'], [unlisted.key, 'id-unlisted']]);
  const app = new Map([['id-titled', { title: 'Fix the parser', archived: false }], ['id-archived', { title: 'Old work', archived: true }]]);
  const h = history([titled, archived, unlisted, codex], [titled, archived, unlisted, codex].map((s) => say(s.key, NOW - 10 * HOUR, 'Reply `go`.')), ids);
  const w = waiting(h, { app });
  assert.deepEqual(w.rows.map((r) => [r.session, r.title, r.titleFrom, r.sidebar]), [[codex.key, `Session ${codex.key}`, 'log', null], [titled.key, 'Fix the parser', 'app', true]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.deepEqual(w.notes, [{ kind: 'archived-sessions-left-out', count: 1 }, { kind: 'sessions-not-in-sidebar-left-out', count: 1 }]);
  assert.equal(waiting(h, { app, all: true }).rows.length, 3);
});

test('a session with no title anywhere is named by its first prompt', () => {
  const s = session('cc-qqqqqqqqqqqq', { title: null });
  const h = history([s], [prompt(s.key, NOW - 11 * HOUR, 'Fix the flaky test\nmore detail'), say(s.key, NOW - 10 * HOUR, 'Reply `go`.')]);
  const [r] = waiting(h).rows;
  assert.equal(r.title, 'Fix the flaky test');
  assert.equal(r.titleFrom, 'first-prompt');
});

test('every quote passes the redactor', () => {
  const s = session('cc-rrrrrrrrrrrr');
  const h = history([s], [say(s.key, NOW - 10 * HOUR, 'Reply `go` to send it to Acme.')]);
  const [r] = waiting(h, { redact: (x) => String(x).replace(/Acme/g, '[redacted:term]') }).rows;
  assert.doesNotMatch(r.quote, /Acme/);
  assert.match(r.quote, /\[redacted:term\]/);
  // A reply word is copied from the raw message too, so it's redacted as the quote is.
  const t = session('cc-rrrrrrrrrrrs');
  const [w] = waiting(history([t], [say(t.key, NOW - 10 * HOUR, 'Reply `Acme-go` to send it.')]), { redact: (x) => String(x).replace(/Acme/g, '[redacted:term]') }).rows;
  assert.deepEqual(w.asked, ['[redacted:term]-go']);
});

test('a question or a plan put to you with no answer is an ask at any age; a cut-off call waits for the quiet time', () => {
  const pending = (key, category) => {
    const s = session(key, { endState: 'last-record-is-a-call-without-result', lastAt: iso(NOW - HOUR) });
    return [s, [prompt(s.key, NOW - 2 * HOUR), ev(s.key, 'action', NOW - HOUR, { facts: { category } })]];
  };
  const [q, qe] = pending('cc-q1q1q1q1q1q1', 'question');
  const [p, pe] = pending('cc-p1p1p1p1p1p1', 'plan-approval');
  const [c, ce] = pending('cc-c1c1c1c1c1c1', 'shell');
  const rows = waiting(history([q, p, c], [...qe, ...pe, ...ce])).rows;
  assert.deepEqual(rows.map((r) => [r.session, r.kind, r.rule, r.form, r.evidence]).sort(), [[p.key, 'ask', 'waiting.question-tool', 'plan-approval', 'recorded'], [q.key, 'ask', 'waiting.question-tool', 'question-tool', 'recorded']]);
  // A question already answered, in a session a helper's step left without a result, isn't one.
  const [a, ae] = pending('cc-a1a1a1a1a1a1', 'question');
  ae[1].end = { at: iso(NOW - HOUR), t: NOW - HOUR };
  assert.deepEqual(waiting(history([a], ae)).rows, []);
});

// ---- pull requests ---------------------------------------------------------------------------------

const link = (s, t, pr, repo = 'you/your-project') => ev(s, 'link', t, { actor: 'harness', facts: { pr, repo } });

test('an orphan pull request is open from a --prs file, and one merged or closed there is not listed', () => {
  const s = session('cc-ssssssssssss');
  const h = history([s], [link(s.key, NOW - 20 * HOUR, 7), link(s.key, NOW - 20 * HOUR, 8), link(s.key, NOW - 20 * HOUR, 9), say(s.key, NOW - 19 * HOUR, 'Opened them.')]);
  const prs = readPrsFile(JSON.stringify([
    { number: 7, state: 'OPEN', headRefName: 'feature/a', url: 'https://github.com/you/your-project/pull/7' },
    { number: 8, state: 'MERGED', headRefName: 'feature/b', url: 'https://github.com/you/your-project/pull/8' },
    { number: 9, state: 'CLOSED', headRefName: 'feature/c' },
  ]), '2026-03-20T11:00:00.000Z');
  const rows = waiting(h, { prs }).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].pr, { repo: 'you/your-project', number: 7, state: 'open', stateFrom: 'prs-file', fileAt: '2026-03-20T11:00:00.000Z' });
  assert.equal(rows[0].evidence, 'recorded');
});

test('a pull request a later session touched, merged, or one named recently is not an orphan', () => {
  const a = session('cc-tttttttttttt');
  const b = session('cc-uuuuuuuuuuuu', { lastAt: iso(NOW - HOUR) });
  const prs = { at: null, rows: [{ number: 7, state: 'OPEN', repo: 'you/your-project' }, { number: 8, state: 'OPEN', repo: 'you/your-project' }] };
  const h = history([a, b], [
    link(a.key, NOW - 20 * HOUR, 7), link(b.key, NOW - HOUR, 7),
    link(a.key, NOW - 20 * HOUR, 8), ev(b.key, 'action', NOW - 2 * HOUR, { facts: { category: 'shell', git: { pr: { number: 8, action: 'merged' } } } }),
  ]);
  assert.deepEqual(waiting(h, { prs }).rows, []);
});

test('without a --prs file a pull request git cannot check is counted, never listed as open', () => {
  const s = session('cc-vvvvvvvvvvvv');
  const h = history([s], [link(s.key, NOW - 20 * HOUR, 7)]);
  const w = waiting(h);
  assert.deepEqual(w.rows, []);
  assert.deepEqual(w.notes, [{ kind: 'prs-not-checked', count: 1 }]);
});

test('readPrsFile refuses a file that is not a gh list', () => {
  assert.throws(() => readPrsFile('not json', null), /isn't JSON/);
  assert.throws(() => readPrsFile('{"number":1}', null), /should hold a list/);
  assert.deepEqual(readPrsFile('[{"number":3,"state":"OPEN","repository":{"nameWithOwner":"you/x"}},{"nope":1}]', 'T').rows, [{ number: 3, state: 'OPEN', headRefName: null, repo: 'you/x' }]);
});

// ---- git: landed pull requests and unpushed commits, on a made-up repository with a remote -----

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'You', GIT_AUTHOR_EMAIL: 'you@example.com', GIT_COMMITTER_NAME: 'You', GIT_COMMITTER_EMAIL: 'you@example.com' } }).trim();

function repoWithRemote() {
  const dir = makeTempDir('hw-waiting-git-');
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'Start (#1)');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/you/your-project.git');
  return { dir, work, remote };
}

test('a commit on a local branch no remote holds is unpushed; a pushed or local-only one is not', () => {
  const { work, remote } = repoWithRemote();
  git(work, 'remote', 'set-url', 'origin', remote);
  git(work, 'checkout', '-q', '-b', 'feature/a');
  writeFileSync(join(work, 'b.txt'), 'b\n');
  git(work, 'add', 'b.txt');
  git(work, 'commit', '-q', '-m', 'Unpushed work');
  const unpushedSha = git(work, 'rev-parse', 'HEAD');
  const pushedSha = git(work, 'rev-parse', 'main');
  assert.deepEqual(refsContaining(work, unpushedSha), { remote: false, heads: [{ name: 'feature/a', gone: false }] });
  assert.equal(refsContaining(work, pushedSha).remote, true);
  assert.equal(hasRemoteBranch(work), true);
  assert.equal(refsContaining(work, '--all'), null);

  const s = session('cc-wwwwwwwwwwww');
  const outcome = (sha) => ev(s.key, 'outcome', NOW - 20 * HOUR, { actor: 'git', agent: null, refs: [{ sha }], facts: { outcome: 'commit-exists', repo: 'your-project', sha: sha.slice(0, 12), subject: 'x', authoredByConfiguredIdentity: true, onDefaultBranch: false, nominatedBy: 'e1' } });
  const h = history([s], [outcome(unpushedSha), outcome(pushedSha)]);
  const config = { repos: [{ label: 'your-project', role: 'featured', path: work }], identity: { authorEmails: ['you@example.com'] } };
  const rows = findWaiting({ h, config, now: NOW });
  assert.deepEqual(rows.rows.map((r) => [r.kind, r.commit.sha, r.commit.branches]), [['unpushed', unpushedSha.slice(0, 12), ['feature/a']]]);
  // A label the redactor changes is still matched, and printed redacted.
  const named = history([s], [ev(s.key, 'outcome', NOW - 20 * HOUR, { actor: 'git', agent: null, refs: [{ sha: unpushedSha }], facts: { outcome: 'commit-exists', repo: 'Acme-project', sha: unpushedSha.slice(0, 12), subject: 'x', authoredByConfiguredIdentity: true, onDefaultBranch: false, nominatedBy: 'e1' } })]);
  const acme = { ...config, repos: [{ ...config.repos[0], label: 'Acme-project' }] };
  assert.deepEqual(findWaiting({ h: named, config: acme, now: NOW, redact: (x) => String(x).replace(/Acme/g, '[redacted:term]') }).rows.map((r) => r.commit.repo), ['[redacted:term]-project']);
  // A display-only repository is never read by git, so nothing is listed from it.
  assert.deepEqual(findWaiting({ h, config: { ...config, repos: [{ ...config.repos[0], role: 'display' }] }, now: NOW }).rows, []);
  // A repository with no remote at all is local by design.
  git(work, 'remote', 'remove', 'origin');
  assert.equal(hasRemoteBranch(work), false);
  assert.deepEqual(findWaiting({ h, config, now: NOW }).rows, []);
});

test('a pull request git shows landed on the default branch is not an orphan, one it does not is last seen open', () => {
  const { work } = repoWithRemote();
  git(work, 'update-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const s = session('cc-xxxxxxxxxxxx');
  const h = history([s], [link(s.key, NOW - 20 * HOUR, 1), link(s.key, NOW - 20 * HOUR, 2)]);
  const config = { repos: [{ label: 'your-project', role: 'featured', path: work }], identity: { authorEmails: ['you@example.com'] } };
  const rows = findWaiting({ h, config, now: NOW }).rows;
  assert.deepEqual(rows.map((r) => [r.pr.number, r.pr.state, r.pr.stateFrom, r.evidence]), [[2, 'last-seen-open', 'git', 'derived']]);
  // The logs carry the redacted GitHub name: git's and the --prs file's are compared redacted,
  // and no raw name reaches a row.
  const redact = (x) => String(x).replace(/your-project/g, '[redacted:term]');
  const hidden = 'you/[redacted:term]';
  const asks = session('cc-xxxxxxxxxxxy', { repo: '[redacted:term]' });
  const h2 = history([s, asks], [link(s.key, NOW - 20 * HOUR, 1, hidden), link(s.key, NOW - 20 * HOUR, 2, hidden), link(s.key, NOW - 20 * HOUR, 3, hidden), say(asks.key, NOW - 10 * HOUR, 'Reply `go` once PR 1 is in.')]);
  const prs = readPrsFile(JSON.stringify([{ number: 3, state: 'OPEN', url: 'https://github.com/you/your-project/pull/3' }]), 'T');
  const w = findWaiting({ h: h2, config, now: NOW, redact, prs });
  assert.deepEqual(w.rows.map((r) => [r.kind, r.pr?.number ?? null, r.pr?.stateFrom ?? null, r.settled?.pr.repo ?? null]), [['ask', null, null, hidden], ['pr', 2, 'git', null], ['pr', 3, 'prs-file', null]]);
  assert.doesNotMatch(JSON.stringify(w.rows.map((r) => [r.pr, r.settled])), /your-project/);
});

// ---- the desktop app's session files -------------------------------------------------------------

test('readAppSessions reads only the id, the title and the archive flag, and skips a broken file', () => {
  const root = makeTempDir('hw-app-sessions-');
  const dir = join(root, 'account', 'workspace');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local_one.json'), JSON.stringify({ cliSessionId: 'ABC-1', title: ' Fix the parser ', isArchived: false, cwd: '/path/to/your/repo' }));
  writeFileSync(join(dir, 'local_two.json'), JSON.stringify({ cliSessionId: 'def-2', isArchived: true }));
  writeFileSync(join(dir, 'local_three.json'), '{ half written');
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ cliSessionId: 'ghi-3', title: 'not a session file' }));
  const app = readAppSessions(root);
  assert.deepEqual([...app], [['abc-1', { title: 'Fix the parser', archived: false }], ['def-2', { title: null, archived: true }]]);
  assert.deepEqual([...readAppSessions(join(root, 'missing'))], []);
  assert.deepEqual([...readAppSessions(null)], []);
  assert.equal(appSessionsRoot({ HONESTWEEK_APP_SESSIONS: root }), root);
  assert.equal(appSessionsRoot({ APPDATA: 'C:/x' }, 'win32'), join('C:/x', 'Claude', 'claude-code-sessions'));
});

// ---- the command ---------------------------------------------------------------------------------

const d = buildDemoWeek();
after(() => rmSync(d.root, { recursive: true, force: true }));
const redaction = d.config.redaction ?? {};
const WEEK = { config: { ...d.config, redaction: { ...redaction, terms: [...(redaction.terms ?? []), DEMO_TERM] } }, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, demo: true };

async function asked(argv = []) {
  const out = [];
  const err = [];
  const code = await runAsk({ command: 'waiting', argv, week: WEEK, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, out: out.join(''), err: err.join('') };
}

test('waiting --json on the demo week prints the honestweek.waiting/1 shape', async () => {
  const r = await asked(['--json']);
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.equal(o.schema, WAITING_SCHEMA);
  assert.equal(o.command, 'waiting');
  assert.deepEqual(Object.keys(o.counts), ['ask', 'stalled', 'pr', 'unpushed']);
  assert.equal(o.rows.length, Object.values(o.counts).reduce((a, b) => a + b, 0));
  assert.ok(o.rows.length > 0);
  for (const row of o.rows) {
    assert.ok(WAITING_RULES[row.rule], row.rule);
    assert.ok(['recorded', 'derived', 'inferred'].includes(row.evidence));
    assert.ok(row.title === null || typeof row.title.quoted === 'string');
    assert.ok(Array.isArray(row.asked));
    assert.match(row.page, /^replay\.html\?session=/);
    assert.equal(typeof row.ageHours, 'number');
    assert.ok(o.rules[row.rule]);
  }
  assert.ok(Array.isArray(o.limits) && o.limits.length);
  // The demo never reads this machine's desktop app files.
  assert.equal(o.rows.some((row) => row.titleFrom === 'app'), false);
});

test('waiting text stays under 60 lines and ends on the page to open', async () => {
  const r = await asked([]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  assert.ok(lines.length < 60, `${lines.length} lines`);
  assert.match(lines[0], /^honestweek waiting: /);
  assert.match(r.out, /Open it on the page: .* view --demo --page "replay\.html/);
});

test('waiting refuses words, a bad --quiet-hours and an unreadable --prs file', async () => {
  assert.match((await asked(['stuff'])).err, /takes no words/);
  assert.match((await asked(['--quiet-hours', '0'])).err, /--quiet-hours must be/);
  assert.match((await asked(['--prs', join(ROOT, 'no-such-prs.json')])).err, /couldn't be read/);
  // Options that belong to another command are refused here.
  assert.match((await asked(['--session', 'x'])).err, /unknown option/);
});

test('honestweek waiting --help prints without reading a log', () => {
  const r = spawnSync(process.execPath, [BIN, 'waiting', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^honestweek waiting: /);
  assert.match(r.stdout, /--prs <file>/);
  assert.match(r.stdout, /gh pr list --state all --json number,headRefName,state,url/);
});
