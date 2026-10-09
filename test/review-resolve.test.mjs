// Finding one pull request offline (lib/review/resolve.mjs): its head, base, branch, commits,
// files and the issue it closes, each with how it's known. Most cases read the shared fixture
// (test/fixtures/replay/review-pr.mjs); a merge commit and branch names that disagree are built
// by hand on a small repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { BriefError, issueRefs, prBodyOf, pushedBranch, resolvePr } from '../lib/review/resolve.mjs';
import { BRIEF_RULES, BRIEF_RULE_SOURCES } from '../lib/review/rules.mjs';
import { writeReviewLogs, WINDOW } from './fixtures/replay/review-pr.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const fx = writeReviewLogs(makeTempDir('hw-resolve-'));
const h = await buildWorkHistory({ config: fx.config, ...WINDOW, roots: fx.roots, keepRaw: true, usage: true, hiddenSessions: 'redacted' });
const G = fx.git;
const ask = (query, extra = {}) => resolvePr({ h, config: fx.config, query, ...extra });

test("a squash-merged pull request: head the logged commit with the squash's files, base the squash parent, files from the landing commit", () => {
  const pr = ask('#20');
  assert.equal(pr.number, 20);
  assert.deepEqual(pr.repo, { label: 'your-project', slug: 'example/your-project', role: 'featured', chosenBy: 'sessions' });
  assert.equal(pr.landed.sha, G.squash);
  assert.equal(pr.landed.kind, 'squash');
  assert.deepEqual({ sha: pr.head.sha, evidence: pr.head.evidence, via: pr.head.via, rule: pr.head.rule }, { sha: G.s2, evidence: 'inferred', via: 'same-tree', rule: 'brief.head-same-tree' });
  assert.deepEqual({ sha: pr.base.sha, evidence: pr.base.evidence, via: pr.base.via }, { sha: G.start, evidence: 'inferred', via: 'squash-parent' }, 'the landing is read from its subject, so what rests on it is too');
  assert.deepEqual([pr.landed.evidence, pr.landed.rule, pr.base.rule], ['inferred', 'brief.landed-subject', 'brief.landed-subject']);
  assert.deepEqual(pr.commits.list.map((c) => c.sha), [G.s1, G.s2]);
  assert.ok(pr.commits.list.every((c) => c.evidence === 'inferred' && c.loggedBy.includes(fx.key.author)), 'the weakest of head and base');
  assert.deepEqual(pr.files, { list: [{ status: 'M', path: 'lib/parser.mjs' }, { status: 'M', path: 'test/parser.test.mjs' }], evidence: 'inferred', via: 'landing-commit', rule: 'brief.landed-subject' });
  assert.equal(pr.branch.name, 'feature/stream');
  assert.equal(pr.branch.ambiguous, false);
  assert.deepEqual(pr.branch.sources.map((s) => s.via).sort(), ['printed', 'push-before-create']);
  assert.ok(pr.branch.sources.every((s) => s.evidence === 'inferred' && BRIEF_RULES.has(s.rule)));
  // The author, the review run (gh pr review 20) and the reader all point at it.
  assert.deepEqual(pr.sessions, [fx.key.author, fx.key.review, fx.key.reader].sort());
});

test('the issue it closes comes from the recorded pr create body; a mention is only related', () => {
  const pr = ask('#20');
  assert.deepEqual(pr.issues.closes.map((x) => [x.number, x.evidence, x.rule]), [[19, 'inferred', 'brief.issue-closes']]);
  assert.equal(pr.issues.closes[0].sources[0].via, 'pr-body');
  // "Also see #12" and the squash body's "(issue 19)" are no closing words.
  assert.deepEqual(pr.issues.related.map((x) => x.number), [12]);
  // Pull request 21 says "Part of #30. Related: #19.": both related, none closed.
  const p21 = ask('#21');
  assert.deepEqual(p21.issues.closes, []);
  assert.deepEqual(p21.issues.related.map((x) => x.number), [19, 30]);
  // --issue is recorded, beside what the logs say.
  const given = ask('#21', { issue: '#30' });
  assert.deepEqual(given.issues.closes.map((x) => [x.number, x.evidence, x.via]), [[30, 'recorded', 'given']]);
  assert.deepEqual(given.issues.related.map((x) => x.number), [19]);
});

test('issueRefs reads closing words, a list after one, and other repositories', () => {
  const slug = { owner: 'example', name: 'your-project' };
  assert.deepEqual(issueRefs('Closes #19, #20 and #21. See #4.', slug), { closes: [19, 20, 21], named: [4] });
  assert.deepEqual(issueRefs('fixes: example/your-project#7; resolved #8', slug), { closes: [7, 8], named: [] });
  assert.deepEqual(issueRefs('Fixes other/thing#9, issue 10', slug), { closes: [], named: [10] });
  assert.deepEqual(issueRefs('Title (#20)', slug, 20), { closes: [], named: [] }, "a pull request's own number is neither");
  assert.deepEqual(issueRefs('a&#39;b x#12', slug), { closes: [], named: [] }, 'an entity or a word glued to # is no reference');
  assert.deepEqual(issueRefs('see issue 2026-10-09, issue 3.', slug), { closes: [], named: [3] }, 'a date after "issue" is no issue');
});

test('pushedBranch reads a push command\'s branch', () => {
  assert.equal(pushedBranch('git push -u origin feature/docs'), 'feature/docs');
  assert.equal(pushedBranch('cd x && git push origin HEAD:feature/a'), 'feature/a');
  assert.equal(pushedBranch('git -C wt push origin +refs/heads/b'), 'b');
  assert.equal(pushedBranch('git push -o ci.skip origin feature/x'), 'feature/x', "an option's value isn't the remote");
  for (const none of ['git push', 'git push origin', 'git push origin v1:refs/tags/v1', 'git push origin HEAD', 'echo git push origin x', 'git push origin --delete feature/old', 'git push -d origin feature/old', 'git push origin :feature/old']) assert.equal(pushedBranch(none), null, none);
});

test('an open pull request: head from the local branch, base its merge-base', () => {
  const pr = ask('#21');
  assert.equal(pr.landed, null);
  assert.deepEqual({ sha: pr.head.sha, evidence: pr.head.evidence, via: pr.head.via, ref: pr.head.ref }, { sha: G.e1, evidence: 'inferred', via: 'local-branch', ref: 'refs/heads/feature/parser-errors' });
  assert.deepEqual({ sha: pr.base.sha, evidence: pr.base.evidence, via: pr.base.via }, { sha: G.squash, evidence: 'inferred', via: 'merge-base' });
  assert.equal(pr.base.rule, 'brief.head-local-branch | brief.base-default-branch');
  assert.deepEqual(pr.commits.list.map((c) => c.sha), [G.e1]);
  assert.deepEqual(pr.files.list.map((f) => f.path), ['lib/errors.mjs', 'test/errors.test.mjs']);
  assert.deepEqual(pr.branch.sources.map((s) => s.via).sort(), ['head-option', 'printed', 'push-before-create']);
});

test('a head the reviewer gives is recorded, and a newer one than the logs\' is counted', () => {
  const pr = ask('#21', { head: G.e2 });
  assert.deepEqual({ sha: pr.head.sha, evidence: pr.head.evidence, via: pr.head.via }, { sha: G.e2, evidence: 'recorded', via: 'given' });
  assert.deepEqual(pr.headCheck, { given: G.e2, derived: G.e1, derivedVia: 'local-branch', same: false, relation: 'newer', newer: 1, older: 0, unlogged: 1, truncated: false });
  assert.ok(pr.notes.some((n) => n.kind === 'head-differs'));
  assert.deepEqual(pr.commits.list.map((c) => [c.sha, c.loggedBy.length]), [[G.e1, 1], [G.e2, 0]]);
  // The same head as the logs': no difference to report.
  assert.equal(ask('#21', { head: G.e1 }).headCheck.same, true);
  // --base is recorded too.
  assert.deepEqual(ask('#21', { head: G.e2, base: G.squash }).base, { sha: G.squash, evidence: 'recorded', via: 'given' });
});

test('a head that isn\'t in local git is missing, with the fetch to run', () => {
  const pr = ask('#21', { head: 'f'.repeat(40) });
  assert.deepEqual(pr.head, { sha: null, given: 'f'.repeat(40), evidence: 'missing', via: 'given', hint: 'git fetch origin pull/21/head' });
  assert.deepEqual(pr.commits.list.map((c) => [c.sha, c.via]), [[G.e1, 'pushed']], 'no range without a head: only the commit a push sent');
  assert.ok(pr.notes.some((n) => n.kind === 'head-not-in-git' && n.text.includes('git fetch origin pull/21/head')));
});

test('a Codex session\'s pull request, and one named by its branch', () => {
  for (const q of ['#22', 'branch:feature/docs', 'your-project#22']) {
    const pr = ask(q);
    assert.equal(pr.number, 22, q);
    assert.deepEqual(pr.sessions, [fx.key.codex], q);
    assert.equal(pr.branch.name, 'feature/docs', q);
    assert.deepEqual(pr.issues.closes.map((x) => x.number), [31], q);
    assert.deepEqual(pr.commits.list.map((c) => [c.sha, c.loggedBy.join()]), [[G.d1, fx.key.codex]], q);
  }
  assert.equal(ask('your-project#22').repo.chosenBy, 'query');
  assert.equal(ask('example/your-project#22').repo.chosenBy, 'query');
  // Named by its branch, the number is a reading, and so is everything that rests on it.
  const byBranch = ask('branch:feature/docs');
  assert.deepEqual(byBranch.numberFrom, { evidence: 'inferred', rule: 'brief.number-create-after-push' });
  assert.equal(ask('#22').numberFrom, null);
  // A push command the harness didn't record is read by a named rule.
  assert.ok(ask('#22').events.pushes.some((p) => p.branch === 'feature/docs' && p.rule === 'brief.push-command'));
});

test('what it can\'t read is refused with a reason, never guessed', () => {
  for (const [opts, re] of [
    [{ query: 'hello world' }, /doesn't name a pull request/],
    [{ query: 'feature/docs' }, /doesn't name a pull request/],
    [{ query: '#20', head: '--output=x' }, /--head takes/],
    [{ query: '#20', base: 'a..b' }, /--base takes/],
    [{ query: '#20', issue: 'nineteen' }, /--issue takes/],
    [{ query: '#20', repo: 'nope' }, /no configured repository is called/],
    [{ query: 'someone/else#20' }, /no configured repository is someone\/else/],
  ]) assert.throws(() => resolvePr({ h, config: fx.config, ...opts }), (e) => e instanceof BriefError && re.test(e.message), JSON.stringify(opts));
  // Two configured repositories and nothing to choose by: it asks.
  assert.throws(() => resolvePr({ h, config: fx.config, query: '#999' }), (e) => e instanceof BriefError && /more than one configured repository/.test(e.message));
  // Named, it answers.
  assert.equal(resolvePr({ h, config: fx.config, query: '#999', repo: 'example/your-project' }).repo.chosenBy, 'given');
});

/** Every child process started while `fn` runs. */
function recordProcesses(fn) {
  const calls = [];
  const names = ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'execSync', 'exec'];
  const original = Object.fromEntries(names.map((n) => [n, childProcess[n]]));
  for (const n of names) {
    childProcess[n] = function recorded(...args) {
      calls.push({ name: n, file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] });
      return original[n].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try {
    return { result: fn(), calls };
  } finally {
    Object.assign(childProcess, original);
    syncBuiltinESMExports();
  }
}
const norm = (p) => {
  const r = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

test('a display-only repository gets no git call at all', () => {
  h._refIndex(); // built once, as any lookup builds it
  const { result, calls } = recordProcesses(() => ask('#20', { repo: 'a-private-project' }));
  assert.equal(result.display, true);
  assert.equal(result.head.sha, null);
  assert.deepEqual(result.sessions, []);
  assert.ok(result.notes.some((n) => n.kind === 'display-only'));
  assert.equal(calls.length, 0, `started: ${JSON.stringify(calls)}`);
  // Failing-path partner: the readable repository's pull request does run git, never in the display-only one.
  const live = recordProcesses(() => ask('#20'));
  assert.ok(live.calls.some((c) => c.file === 'git'), 'the recorder sees git (the test can fail)');
  for (const c of live.calls) {
    const i = c.args.indexOf('-C');
    if (i !== -1) assert.ok(!norm(c.args[i + 1]).startsWith(norm(fx.hiddenRepo)), 'git ran in the display-only repository');
  }
});

test('git: false reads no git and says so', () => {
  const { result, calls } = recordProcesses(() => resolvePr({ h, config: fx.config, query: '#20', git: false }));
  assert.equal(calls.length, 0);
  assert.equal(result.landed, null);
  assert.equal(result.head.evidence, 'missing');
  assert.equal(result.branch.name, 'feature/stream', 'the logs still name the branch');
  assert.ok(result.notes.some((n) => n.kind === 'git-not-read'));
  const withHead = resolvePr({ h, config: fx.config, query: '#20', git: false, head: 'f'.repeat(40) });
  assert.ok(!withHead.notes.some((n) => n.kind === 'head-not-in-git'), "git wasn't asked, so it isn't said to lack the head");
});

// ---- by hand: a merge commit, and branch names that disagree ------------------------------------

function handRepo() {
  const dir = join(makeTempDir('hw-resolve-merge-'), 'r');
  mkdirSync(dir, { recursive: true });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'you@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'you@example.com', GIT_AUTHOR_DATE: '2024-06-11T15:00:00Z', GIT_COMMITTER_DATE: '2024-06-11T15:00:00Z' };
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--template=');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  git('switch', '-q', '-c', 'feature/merged');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add b. Fixes #4');
  const tip = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'c.txt'), 'c\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Unrelated on main');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #5 from you/feature/merged', 'feature/merged');
  return { dir, tip, merge: git('rev-parse', 'HEAD'), first: git('rev-parse', 'HEAD^1') };
}

/** A history with only what resolvePr reads, for one session in the repository. */
function handHistory(events, prRefs, branchRefs = [], commitRefs = []) {
  const hh = { events, record: () => [] };
  Object.defineProperty(hh, '_refIndex', { value: () => ({ prRefs, commitRefs, branchRefs, fileRefs: [] }) });
  Object.defineProperty(hh, '_sessionRepo', { value: () => 'r' });
  return hh;
}

test('a merge commit: head its second parent, files the pull request\'s own, the closing commit read', () => {
  const r = handRepo();
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  const e = { id: 's.1.0', session: 's', kind: 'action', t: 1, facts: {} };
  const pr = resolvePr({ h: handHistory([e], [{ session: 's', event: e, number: 5, owner: null, repo: null, via: 'gh-pr-command' }]), config, query: '#5' });
  assert.equal(pr.landed.kind, 'merge');
  assert.deepEqual({ sha: pr.head.sha, evidence: pr.head.evidence, rule: pr.head.rule }, { sha: r.tip, evidence: 'inferred', rule: 'brief.head-merge-parent' });
  assert.deepEqual({ sha: pr.base.sha, via: pr.base.via }, { sha: r.first, via: 'merge-first-parent' });
  assert.deepEqual(pr.files.list.map((f) => f.path), ['b.txt'], "main's own change isn't the pull request's");
  assert.deepEqual(pr.commits.list.map((c) => c.sha), [r.tip]);
  assert.deepEqual([pr.branch.name, pr.branch.sources.map((s) => s.via)], ['feature/merged', ['merge-subject']]);
  assert.deepEqual(pr.issues.closes.map((x) => [x.number, x.sources[0].via]), [[4, 'commit-message']]);
});

test('branch names that disagree are all listed, and none is picked', () => {
  const r = handRepo();
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  const push = { id: 's.1.0', session: 's', kind: 'action', t: 1, facts: { git: { push: { branch: 'feature/one' } } } };
  const create = { id: 's.2.0', session: 's', kind: 'action', t: 2, facts: {}, _command: 'gh pr create --head feature/two --title x --body y' };
  const hh = handHistory([push, create], [{ session: 's', event: create, number: 9, owner: null, repo: null, via: 'harness-git-pr' }], [{ session: 's', event: push, branch: 'feature/one', via: 'push' }]);
  const pr = resolvePr({ h: hh, config, query: '#9' });
  assert.equal(pr.branch.name, null);
  assert.equal(pr.branch.ambiguous, true);
  assert.deepEqual(pr.branch.sources.map((s) => [s.name, s.via]).sort(), [['feature/one', 'push-before-create'], ['feature/two', 'head-option']]);
  assert.equal(pr.head.evidence, 'missing', 'no branch, so no local branch to read');
  assert.ok(pr.notes.some((n) => n.kind === 'branch-ambiguous'));
});

test('every brief rule says what it reads and where', () => {
  for (const [id, text] of BRIEF_RULES) {
    assert.match(id, /^brief\.[a-z-]+$/);
    assert.ok(text.length > 30, id);
    assert.ok(BRIEF_RULE_SOURCES[id], `${id} names where it reads`);
  }
  assert.deepEqual(Object.keys(BRIEF_RULE_SOURCES).sort(), [...BRIEF_RULES.keys()].sort());
});

/** Every inferred value in a result, outside the engine's own events, by where it sits. */
function inferredNodes(v, at = '', out = []) {
  if (!v || typeof v !== 'object') return out;
  if (v.evidence === 'inferred') out.push({ at, rule: v.rule });
  for (const [k, x] of Object.entries(v)) if (k !== 'events') inferredNodes(x, `${at}.${k}`, out);
  return out;
}

test('every inferred value names the brief rules it rests on', () => {
  const results = [ask('#20'), ask('#21'), ask('#21', { head: G.e2 }), ask('#22'), ask('branch:feature/docs')];
  let n = 0;
  for (const r of results) {
    for (const { at, rule } of inferredNodes(r)) {
      n++;
      assert.ok(rule, `${at} is inferred with no rule`);
      for (const id of String(rule).split(' | ')) assert.ok(BRIEF_RULES.has(id), `${at}: ${id}`);
    }
  }
  assert.ok(n > 10, 'the walk found inferred values (the test can fail)');
});

/** A squash-merged pull request whose landing has a file its branch never had: main moved first. */
function squashRepo({ extra = false } = {}) {
  const dir = join(makeTempDir('hw-resolve-squash-'), 'r');
  mkdirSync(dir, { recursive: true });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'you@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'you@example.com', GIT_AUTHOR_DATE: '2024-06-11T15:00:00Z', GIT_COMMITTER_DATE: '2024-06-11T15:00:00Z' };
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--template=');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  git('switch', '-q', '-c', 'feature/x');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add b');
  const tip = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'c.txt'), 'c\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Unrelated on main');
  const parent = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'b.txt'), extra ? 'b, fixed up on GitHub\n' : 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add b (#6)');
  git('branch', '-q', '-D', 'feature/x');
  return { dir, tip, parent, squash: git('rev-parse', 'HEAD') };
}

/** The squash repository's one session: a commit (one git lacks by default), the branch's tip, a push, the create. */
function squashSession(r, shas = [null, r.tip]) {
  const c0 = { id: 's.0.0', session: 's', kind: 'action', t: 1, facts: {} };
  const c1 = { id: 's.1.0', session: 's', kind: 'action', t: 2, facts: {} };
  const push = { id: 's.2.0', session: 's', kind: 'action', t: 3, facts: { git: { push: { branch: 'feature/x' } } } };
  const create = { id: 's.3.0', session: 's', kind: 'action', t: 4, facts: {}, _command: 'gh pr create --title x --body y' };
  const commits = [{ session: 's', event: c0, sha: shas[0] ?? 'a'.repeat(40), via: 'harness-commit' }, ...(shas[1] ? [{ session: 's', event: c1, sha: shas[1], via: 'harness-commit' }] : [])];
  return handHistory([c0, c1, push, create], [{ session: 's', event: create, number: 6, owner: null, repo: null, via: 'gh-pr-command' }], [{ session: 's', event: push, branch: 'feature/x', via: 'push' }], commits);
}

test('a squash landed after the default branch moved on: the logged commit with the same change is its head', () => {
  const r = squashRepo();
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  const pr = resolvePr({ h: squashSession(r), config, query: '#6' });
  assert.equal(pr.landed.sha, r.squash);
  assert.deepEqual({ sha: pr.head.sha, via: pr.head.via, rule: pr.head.rule }, { sha: r.tip, via: 'same-tree', rule: 'brief.head-same-tree' });
  // Git read the range, so a logged commit outside it (one git lacks) isn't added to it.
  assert.deepEqual(pr.commits.list.map((c) => c.sha), [r.tip]);
});

test('a squash whose change no logged commit has: head the last commit before the last push', () => {
  const r = squashRepo({ extra: true });
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  const pr = resolvePr({ h: squashSession(r), config, query: '#6' });
  assert.deepEqual({ sha: pr.head.sha, evidence: pr.head.evidence, via: pr.head.via, rule: pr.head.rule }, { sha: r.tip, evidence: 'inferred', via: 'last-push', rule: 'brief.head-last-push' });
  assert.equal(pr.base.sha, r.parent);
  assert.ok(!pr.commits.list.some((c) => !c.inGit));
});

test('with no head to read a range from, the commits pushed are listed, and one git lacks is missing', () => {
  const r = squashRepo({ extra: true });
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  const gone = 'a'.repeat(40);
  const pr = resolvePr({ h: squashSession(r, [gone, null]), config, query: '#6' });
  assert.equal(pr.head.sha, null);
  const missing = pr.commits.list.find((c) => c.sha === gone);
  assert.deepEqual({ inGit: missing.inGit, evidence: missing.evidence, via: missing.via }, { inGit: false, evidence: 'missing', via: 'pushed' });
  assert.equal(pr.commits.evidence, 'missing', 'the list reads no stronger than its weakest row');
});

test('a head older than the logs\' says so, and one on another line says neither is past the other', () => {
  const older = ask('#21', { head: G.squash });
  assert.deepEqual([older.headCheck.relation, older.headCheck.newer, older.headCheck.older], ['older', 0, 1]);
  assert.ok(older.notes.some((n) => n.kind === 'head-differs' && /The logs' head is 1 commit\(s\) past the one you gave/.test(n.text)));
  const other = ask('#21', { head: G.d1 });
  assert.equal(other.headCheck.relation, 'diverged');
  assert.ok(other.notes.some((n) => n.kind === 'head-differs' && /Neither is past the other/.test(n.text)));
});

test('only the pull request body names the issue it closes, never its title', () => {
  const r = handRepo();
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  const create = { id: 's.1.0', session: 's', kind: 'action', t: 1, facts: {}, _command: "gh pr create --title 'Fixes #19' --body 'Closes #20, see #21' && echo 'Resolves #22'" };
  const pr = resolvePr({ h: handHistory([create], [{ session: 's', event: create, number: 9, owner: null, repo: null, via: 'harness-git-pr' }]), config, query: '#9' });
  assert.deepEqual(pr.issues.closes.map((x) => x.number), [20]);
  assert.deepEqual(pr.issues.related.map((x) => x.number), [21]);
  assert.equal(prBodyOf('gh pr create --title x --body-file -  <<\'EOF\'\nFixes #3.\nEOF'), 'Fixes #3.');
  assert.equal(prBodyOf('gh pr create --title x --body-file notes.md'), null, 'a body on disk is not in the log');
});

test("an open pull request with no branch to read: head the last headRefOid gh printed for it, never another one's", () => {
  const r = handRepo();
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  const view = { id: 's.1.0', session: 's', kind: 'action', t: 1, facts: {}, end: { ref: 'v7' }, _command: 'gh pr view 7 --json headRefOid,number' };
  const other = { id: 's.2.0', session: 's', kind: 'action', t: 2, facts: {}, end: { ref: 'v8' }, _command: 'gh pr view 8 --json headRefOid,number' };
  const printed = { v7: `{"headRefOid":"${r.tip}","number":7}`, v8: `{"headRefOid":"${r.merge}","number":8}` };
  const hh = handHistory([view, other], [{ session: 's', event: view, number: 7, owner: null, repo: null, via: 'gh-pr-command' }]);
  hh.record = (ref) => [{ record: { message: { content: [{ type: 'tool_result', content: printed[ref] }] } } }];
  const pr = resolvePr({ h: hh, config, query: '#7' });
  assert.equal(pr.landed, null);
  assert.deepEqual({ sha: pr.head.sha, evidence: pr.head.evidence, via: pr.head.via, rule: pr.head.rule }, { sha: r.tip, evidence: 'inferred', via: 'printed', rule: 'brief.head-printed' });
});

test('one configured repository is the one', () => {
  const r = handRepo();
  const config = { identity: { authorEmails: ['you@example.com'] }, repos: [{ label: 'r', path: r.dir, role: 'featured' }] };
  assert.equal(resolvePr({ h: handHistory([], []), config, query: '#5' }).repo.chosenBy, 'only');
});
