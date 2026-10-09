// Made-up logs and a made-up repository for the review brief (lib/review/): one author session
// that works on three pull requests from the main checkout, reaching each pull request's
// worktree with `cd`, the way a real session did. Nothing here comes from a real log.
//
// writeReviewLogs(root) builds, under `root`:
//   your-project/                     the main checkout (main), origin example/your-project
//     .claude/worktrees/pr-20         removed after pull request 20 was squash-merged
//     .claude/worktrees/pr-21         feature/parser-errors, pull request 21, open
//     .claude/worktrees/pr-22         feature/docs, pull request 22, open
//   a-private-project/                a display-only repository
// and these sessions:
//   author    Claude Code, rooted in the main checkout, records `main` on every line. It opens
//             with `gh issue view 19`, makes pull request 20 (closes #19, mentions #12) in the
//             pr-20 worktree, starts a review run, merges 20, then makes pull request 21 (part
//             of #30, mentions #19) after a test run that failed.
//   review    Claude Code, started by the author with `claude -p --session-id`, in the pr-20
//             worktree, recording feature/stream on every line; it reviews pull request 20.
//   codex     Codex, rooted in the main checkout, makes pull request 22 (fixes #31) with
//             every command run in the pr-22 worktree.
//   reader    Claude Code, in the main checkout, only looks pull request 20 up.
//   hidden    Claude Code, in the display-only repository, names pull request 20.
//   author2   Claude Code, rooted in the main checkout, makes pull request 23 (fixes #40): it
//             runs a check in the main checkout, claims tests pass mid-turn and in the pull
//             request's body, edits after its last check, is corrected, and skips a hook.
//             A later commit on its branch was made by no session.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeConfig } from '../../../lib/config.mjs';
import { sourceKey } from '../../../lib/replay/ids.mjs';
import { claudeSessionKey } from '../../../lib/replay/sources.mjs';

export const ME = 'you@example.com';
export const WINDOW = Object.freeze({ from: '2024-06-10', to: '2024-06-16', timezone: 'UTC' });
const T0 = Date.parse('2024-06-11T15:00:00.000Z');
export const at = (min, s = 0) => new Date(T0 + min * 60000 + s * 1000).toISOString();
const PROJECT = 'proj-review';
const HIDDEN = 'proj-hidden';

export const IDS = Object.freeze({
  author: 'a1000000-0000-4000-8000-0000000000a1',
  review: 'b2000000-0000-4000-8000-0000000000b2',
  reader: 'c3000000-0000-4000-8000-0000000000c3',
  hidden: 'd4000000-0000-4000-8000-0000000000d4',
  author2: 'f6000000-0000-4000-8000-0000000000f6',
});
export const CODEX_ID = 'e5000000-0000-7000-8000-0000000000e5';

/** The issue text the author session's `gh issue view 19` printed. */
export const ISSUE_19 = 'title:\tParser should stream its input\nstate:\tOPEN\nnumber:\t19\n--\nReading a large file loads it whole. Stream it instead, and keep the parser tests passing.';

function gitIn(dir, args, minute = 0, input) {
  const iso = at(minute);
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    input,
    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  }).trim();
}

function put(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}
function commitIn(dir, message, files, minute) {
  put(dir, files);
  gitIn(dir, ['add', '-A'], minute);
  gitIn(dir, ['commit', '-q', '-m', message], minute);
  return gitIn(dir, ['rev-parse', 'HEAD'], minute);
}

/** The repository and its history; returns every commit id a log names. */
function makeRepo(root) {
  const repo = join(root, 'your-project');
  mkdirSync(repo, { recursive: true });
  gitIn(repo, ['init', '-q', '--template=']);
  gitIn(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  gitIn(repo, ['config', 'commit.gpgsign', 'false']);
  gitIn(repo, ['config', 'remote.origin.url', 'https://github.com/example/your-project.git']);
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
  const start = commitIn(repo, 'Start', { 'README.md': 'A parser.\n', 'lib/parser.mjs': 'export const parse = (s) => s.split("\\n");\n', 'test/parser.test.mjs': "test('parse', () => {});\n" }, -60);
  gitIn(repo, ['update-ref', 'refs/remotes/origin/main', start]);

  // Pull request 20, squash-merged, in a worktree removed after the merge.
  const wt = (n) => join(repo, '.claude', 'worktrees', `pr-${n}`);
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'feature/stream', wt(20)], 2);
  const s1 = commitIn(wt(20), 'Stream the parser input', { 'lib/parser.mjs': 'export async function* parse(stream) {}\n', 'test/parser.test.mjs': "test('parse', async () => {});\n" }, 7);
  const s2 = commitIn(wt(20), 'Handle an empty stream', { 'lib/parser.mjs': 'export async function* parse(stream) { if (!stream) return; }\n' }, 9);
  gitIn(repo, ['update-ref', 'refs/remotes/origin/feature/stream', s2]);
  const tree = gitIn(repo, ['rev-parse', `${s2}^{tree}`]);
  const squash = gitIn(repo, ['commit-tree', tree, '-p', start, '-F', '-'], 40, 'Stream the parser input (#20)\n\n* Stream the parser input\n\n* Handle an empty stream (issue 19)\n');
  gitIn(repo, ['update-ref', 'refs/heads/main', squash]);
  gitIn(repo, ['update-ref', 'refs/remotes/origin/main', squash]);
  gitIn(repo, ['reset', '-q', '--hard', 'main']);
  gitIn(repo, ['worktree', 'remove', '--force', wt(20)]);
  gitIn(repo, ['branch', '-q', '-D', 'feature/stream']);
  gitIn(repo, ['update-ref', '-d', 'refs/remotes/origin/feature/stream']);

  // Pull request 21, open. A second commit was pushed from elsewhere (no session here made it).
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'feature/parser-errors', wt(21)], 42);
  const e1 = commitIn(wt(21), 'Report parser errors with line numbers', { 'lib/errors.mjs': 'export const where = (n) => `line ${n}`;\n', 'test/errors.test.mjs': "test('where', () => {});\n" }, 47);
  const e2 = gitIn(repo, ['commit-tree', gitIn(repo, ['rev-parse', `${e1}^{tree}`]), '-p', e1, '-m', 'Tidy the error wording'], 90);
  gitIn(repo, ['update-ref', 'refs/remotes/origin/feature/parser-errors', e2]);

  // Pull request 22, open, made by the Codex session.
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'feature/docs', wt(22)], 70);
  const d1 = commitIn(wt(22), 'Document the stream option', { 'docs/stream.md': 'Pass a stream.\n' }, 74);
  gitIn(repo, ['update-ref', 'refs/remotes/origin/feature/docs', d1]);

  // Pull request 23, open, made by the second author session; a later commit no session made.
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'feature/fix-40', wt(23)], 120);
  const f1 = commitIn(wt(23), 'Trim the error text. Tests pass.', { 'lib/errors.mjs': 'export const where = (n) => `at line ${n}`;\n', 'test/errors.test.mjs': "test('where', () => { assert.ok(1); });\ntest.skip('later', () => {});\n" }, 126);
  const f2 = commitIn(wt(23), 'Reword the error text', { 'lib/errors.mjs': 'export const where = (n) => `on line ${n}`;\n' }, 140);
  gitIn(repo, ['update-ref', 'refs/remotes/origin/feature/fix-40', f2]);

  return { repo, wt, start, s1, s2, squash, e1, e2, d1, f1, f2 };
}

function cc(sessionId, cwd, branch) {
  const lines = [];
  let n = 0;
  const base = (type, ts, extra = {}) => ({ type, sessionId, cwd, version: '2.1.0', gitBranch: branch, uuid: `${sessionId}-r${++n}`, timestamp: ts, ...extra });
  const add = (o) => lines.push(JSON.stringify(o));
  const s = {
    lines,
    title: (text) => add({ type: 'custom-title', customTitle: text, sessionId }),
    typed: (ts, content) => add(base('user', ts, { message: { role: 'user', content }, origin: { kind: 'human' }, turnOrigin: 'human' })),
    program: (ts, content) => add(base('user', ts, { message: { role: 'user', content }, turnOrigin: 'sdk', entrypoint: 'sdk-cli' })),
    say: (ts, text) => add(base('assistant', ts, { message: { id: `m-${sessionId}-${n}`, model: 'model-a', role: 'assistant', content: [{ type: 'text', text }] } })),
    /** A Bash call and its result; `git` is the harness's gitOperation, `error` marks a failed run. */
    run: (ts, id, command, out, { git, error = false } = {}) => {
      add(base('assistant', ts, { message: { id: `m-${sessionId}-${n}`, model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }));
      add(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, ...(error ? { is_error: true } : {}) }] }, toolUseResult: { stdout: out, stderr: '', interrupted: false, ...(git ? { gitOperation: git } : {}) } }));
    },
    edit: (ts, id, file) => {
      add(base('assistant', ts, { message: { id: `m-${sessionId}-${n}`, model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } }));
      add(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { filePath: file, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }], userModified: false } }));
    },
  };
  return s;
}

function cx(id, cwd) {
  const rows = [{ timestamp: null, type: 'session_meta', payload: { id, cwd, cli_version: '0.1.0', originator: 'codex_cli_rs', source: 'cli' } }];
  return {
    rows,
    meta: (ts) => {
      rows[0].timestamp = ts;
    },
    user: (ts, text) => rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
    say: (ts, text) => rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    shell: (ts, callId, cmd, workdir, out, code = 0) => {
      rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd, workdir }) } });
      rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: `Exit code: ${code}\n${out}` } });
    },
  };
}

function write(file, lines) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

/** Writes the repository, the logs and a config under `root`; returns what a build and a test need. */
export function writeReviewLogs(root) {
  const g = makeRepo(root);
  const hiddenRepo = join(root, 'a-private-project');
  mkdirSync(hiddenRepo, { recursive: true });
  execFileSync('git', ['-C', hiddenRepo, 'init', '-q'], { stdio: 'ignore' });
  const claudeRoot = join(root, 'claude');
  const codexRoot = join(root, 'codex');
  const save = (s, id, dir = PROJECT) => write(join(claudeRoot, dir, `${id}.jsonl`), s.lines);
  const w20 = '.claude/worktrees/pr-20';
  const w21 = '.claude/worktrees/pr-21';
  const short = (sha) => sha.slice(0, 7);
  const prUrl = (n) => `https://github.com/example/your-project/pull/${n}`;

  // The author: every command for a pull request runs after `cd` into its worktree.
  const a = cc(IDS.author, g.repo, 'main');
  a.title('Stream the parser, then parser errors');
  a.typed(at(0), 'Work on issue 19: the parser should stream its input.');
  a.run(at(1), 'a-1', 'gh issue view 19', ISSUE_19);
  a.run(at(2), 'a-2', `git worktree add ${w20} -b feature/stream`, "Preparing worktree (new branch 'feature/stream')", { git: { branch: { action: 'created', ref: 'feature/stream' } } });
  a.edit(at(3), 'a-3', join(g.wt(20), 'lib', 'parser.mjs'));
  a.edit(at(4), 'a-4', join(g.wt(20), 'test', 'parser.test.mjs'));
  a.run(at(5), 'a-5', `cd ${w20} && node --test`, '# tests 4\n# pass 4\n# fail 0');
  a.run(at(7), 'a-6', `cd ${w20} && git commit -am "Stream the parser input"`, `[feature/stream ${short(g.s1)}] Stream the parser input`, { git: { commit: { sha: g.s1, kind: 'committed' } } });
  a.edit(at(8), 'a-7', join(g.wt(20), 'lib', 'parser.mjs'));
  a.run(at(9), 'a-8', `cd ${w20} && git commit -am "Handle an empty stream"`, `[feature/stream ${short(g.s2)}] Handle an empty stream`, { git: { commit: { sha: g.s2, kind: 'committed' } } });
  a.run(at(10), 'a-9', `cd ${w20} && git push -u origin feature/stream`, "branch 'feature/stream' set up to track 'origin/feature/stream'.", { git: { push: { branch: 'feature/stream' } } });
  a.run(at(11), 'a-10', `cd ${w20} && gh pr create --title "Stream the parser input" --body "Closes #19. Also see #12."`, `Creating pull request for feature/stream into main in example/your-project\n\n${prUrl(20)}`, { git: { pr: { number: 20, url: prUrl(20), action: 'created' } } });
  a.run(at(12), 'a-11', `claude -p --session-id ${IDS.review} "/review-loop PR 20"`, 'started');
  a.run(at(30), 'a-12', 'gh pr checks 20', `test (20)\tpass\t1m\t${prUrl(20)}/checks`);
  a.say(at(31), 'Done. Pull request 20 is open and all tests pass.');
  a.typed(at(38), 'Merge it, then do issue 30: parser errors should name the line.');
  a.run(at(40), 'a-13', 'gh pr merge 20 --squash --delete-branch', '✓ Squashed and merged pull request #20 (Stream the parser input)');
  a.run(at(42), 'a-14', `git worktree add ${w21} -b feature/parser-errors`, "Preparing worktree (new branch 'feature/parser-errors')", { git: { branch: { action: 'created', ref: 'feature/parser-errors' } } });
  a.edit(at(43), 'a-15', join(g.wt(21), 'lib', 'errors.mjs'));
  a.edit(at(44), 'a-16', join(g.wt(21), 'test', 'errors.test.mjs'));
  a.run(at(45), 'a-17', `cd ${w21} && node --test`, '# tests 5\n# pass 4\n# fail 1', { error: true });
  a.run(at(47), 'a-18', `cd ${w21} && git commit -am "Report parser errors with line numbers"`, `[feature/parser-errors ${short(g.e1)}] Report parser errors with line numbers`, { git: { commit: { sha: g.e1, kind: 'committed' } } });
  a.run(at(48), 'a-19', `cd ${w21} && git push -u origin feature/parser-errors`, "branch 'feature/parser-errors' set up to track 'origin/feature/parser-errors'.", { git: { push: { branch: 'feature/parser-errors' } } });
  a.run(at(49), 'a-20', `cd ${w21} && gh pr create --head feature/parser-errors --title "Name the line in parser errors" --body "Part of #30. Related: #19."`, `Creating pull request for feature/parser-errors into main in example/your-project\n\n${prUrl(21)}`, { git: { pr: { number: 21, url: prUrl(21), action: 'created' } } });
  a.say(at(50), 'All done: tests pass and pull request 21 is up.');
  save(a, IDS.author);

  // The review run the author started, in pull request 20's worktree.
  const r = cc(IDS.review, g.wt(20), 'feature/stream');
  r.program(at(13), '/review-loop PR 20');
  r.run(at(14), 'r-1', 'git diff main...HEAD --stat', ' lib/parser.mjs | 2 +-\n 1 file changed');
  r.run(at(16), 'r-2', 'node --test', '# tests 4\n# pass 4\n# fail 0');
  r.run(at(18), 'r-3', `gh pr review 20 --comment --body "Verdict pinned to ${short(g.s2)}: clean."`, '');
  r.say(at(19), `Reviewed pull request 20 at ${short(g.s2)}: clean.`);
  save(r, IDS.review);

  // A session that only looks pull request 20 up.
  const rd = cc(IDS.reader, g.repo, 'main');
  rd.typed(at(100), 'What did pull request 20 change?');
  rd.run(at(101), 'rd-1', 'gh pr view 20', 'title:\tStream the parser input\nstate:\tMERGED');
  rd.say(at(102), 'It made the parser stream.');
  save(rd, IDS.reader);

  // A session in the display-only repository that names pull request 20.
  const h = cc(IDS.hidden, hiddenRepo, 'main');
  h.typed(at(110), 'Is pull request 20 merged?');
  h.run(at(111), 'h-1', 'gh pr view 20 -R example/your-project', 'state:\tMERGED');
  save(h, IDS.hidden, HIDDEN);

  // A second author, for pull request 23: a check run in the main checkout, claims mid-turn and in
  // the pull request's body, edits after its last check, a correction, and a skipped hook.
  const w23 = '.claude/worktrees/pr-23';
  const b = cc(IDS.author2, g.repo, 'main');
  b.typed(at(120), 'Fix issue 40: shorter error text.');
  b.run(at(120, 30), 'b-1', `git worktree add ${w23} -b feature/fix-40`, "Preparing worktree (new branch 'feature/fix-40')", { git: { branch: { action: 'created', ref: 'feature/fix-40' } } });
  b.edit(at(121), 'b-2', join(g.wt(23), 'lib', 'errors.mjs'));
  b.run(at(122), 'b-3', 'node --test', '# tests 5\n# pass 5\n# fail 0');
  b.say(at(123), 'Tests pass.');
  b.run(at(124), 'b-4', `cd ${w23} && node --test`, '# tests 5\n# pass 5\n# fail 0');
  b.say(at(125), 'Tests pass now in the worktree.');
  b.run(at(126), 'b-5', `cd ${w23} && git commit -am "Trim the error text. Tests pass."`, `[feature/fix-40 ${short(g.f1)}] Trim the error text. Tests pass.`, { git: { commit: { sha: g.f1, kind: 'committed' } } });
  b.edit(at(127), 'b-6', join(g.wt(23), 'test', 'errors.test.mjs'));
  b.run(at(128), 'b-7', `cd ${w23} && git push -u origin feature/fix-40`, "branch 'feature/fix-40' set up to track 'origin/feature/fix-40'.", { git: { push: { branch: 'feature/fix-40' } } });
  b.run(at(129), 'b-8', `cd ${w23} && gh pr create --title "Shorter error text" --body "Fixes #40. All tests pass and CI is green."`, `Creating pull request for feature/fix-40 into main in example/your-project\n\n${prUrl(23)}`, { git: { pr: { number: 23, url: prUrl(23), action: 'created' } } });
  b.say(at(130), 'Done: pull request 23 is open.');
  b.typed(at(131), "No, that's wrong: keep the word line.");
  b.edit(at(132), 'b-9', join(g.wt(23), 'lib', 'errors.mjs'));
  b.run(at(133), 'b-10', `cd ${w23} && git commit --no-verify -am "wip"`, 'nothing to commit, working tree clean');
  b.say(at(134), 'Fixed.');
  save(b, IDS.author2);

  // The Codex session: every command runs in pull request 22's worktree.
  const c = cx(CODEX_ID, g.repo);
  const w22 = g.wt(22);
  c.meta(at(70));
  c.user(at(70, 5), 'Write the docs for the stream option and open a pull request.');
  c.shell(at(72), 'c-1', 'node --test', w22, '# tests 4\n# pass 4\n# fail 0');
  c.shell(at(74), 'c-2', 'git commit -am "Document the stream option"', w22, `[feature/docs ${short(g.d1)}] Document the stream option\n 1 file changed`);
  c.shell(at(75), 'c-3', 'git push -u origin feature/docs', w22, "branch 'feature/docs' set up to track 'origin/feature/docs'.");
  c.shell(at(76), 'c-4', 'gh pr create --title "Document the stream option" --body "Fixes #31"', w22, `Creating pull request for feature/docs into main in example/your-project\n\n${prUrl(22)}`);
  c.say(at(77), 'Opened pull request 22.');
  write(join(codexRoot, 'sessions', '2024', '06', '11', `rollout-2024-06-11T16-10-00-${CODEX_ID}.jsonl`), c.rows.map((x) => JSON.stringify(x)));

  const config = normalizeConfig({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [
      { path: g.repo, label: 'your-project', role: 'featured' },
      { path: hiddenRepo, label: 'a-private-project', role: 'display' },
    ],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'honestweek.digest.md' },
  }, { configDir: root });
  const key = {
    author: claudeSessionKey(PROJECT, IDS.author),
    review: claudeSessionKey(PROJECT, IDS.review),
    reader: claudeSessionKey(PROJECT, IDS.reader),
    hidden: claudeSessionKey(HIDDEN, IDS.hidden),
    author2: claudeSessionKey(PROJECT, IDS.author2),
    codex: sourceKey('cx', CODEX_ID),
  };
  return { root, repo: g.repo, hiddenRepo, git: g, roots: { claude: [claudeRoot], codex: [codexRoot] }, config, key };
}
