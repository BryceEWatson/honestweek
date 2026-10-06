// Made-up Claude Code logs for who sent each user record. Current Claude Code writes
// `turnOrigin` on a user record: "human" when a person typed it, "sdk" when a program sent it
// (a script, the Agent SDK, a headless `claude -p` run, or another session through one),
// "task_notification" for a background task's notice. Older logs carry neither it nor an
// `origin` object. Nothing here comes from a real log.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeConfig } from '../../../lib/config.mjs';
import { claudeSessionKey } from '../../../lib/replay/sources.mjs';

export const ME = 'you@example.com';
const PROJECT = 'proj-turn-origin';
export const WINDOW = Object.freeze({ from: '2024-06-10', to: '2024-06-16', timezone: 'UTC' });
const T0 = Date.parse('2024-06-11T15:00:00.000Z');
export const at = (min, ms = 0) => new Date(T0 + min * 60000 + ms).toISOString();

export const IDS = Object.freeze({
  typed: '11111111-0000-4000-8000-111111111111',
  programText: '22222222-0000-4000-8000-222222222222',
  programCommand: '33333333-0000-4000-8000-333333333333',
  typedCommand: '44444444-0000-4000-8000-444444444444',
  otherValues: '55555555-0000-4000-8000-555555555555',
  typedCheckIn: '66666666-0000-4000-8000-666666666666',
  legacy: '77777777-0000-4000-8000-777777777777',
  legacyCommand: '88888888-0000-4000-8000-888888888888',
});
/** The sessions whose records carry no `turnOrigin`: they read exactly as before it existed. */
export const LEGACY = Object.freeze([IDS.legacy, IDS.legacyCommand]);

const command = (name, args) => `<command-message>${name} is running…</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;

function cc(sessionId, cwd) {
  const lines = [];
  let n = 0;
  const base = (type, ts, extra = {}) => ({ type, sessionId, cwd, version: '2.1.0', uuid: `${sessionId}-r${++n}`, timestamp: ts, ...extra });
  const add = (o) => lines.push(JSON.stringify(o));
  const user = (ts, content, extra = {}) => add(base('user', ts, { message: { role: 'user', content }, ...extra }));
  return {
    lines,
    user,
    /** A turn a person typed in the desktop app, as current Claude Code records it. */
    typed: (ts, content) => user(ts, content, { origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human' }),
    /** A turn a program sent: no origin object, no promptSource. */
    program: (ts, content) => user(ts, content, { turnOrigin: 'sdk' }),
    say: (ts, text) => add(base('assistant', ts, { message: { id: `m-${sessionId}-${n}`, model: 'model-a', role: 'assistant', content: [{ type: 'text', text }] } })),
    run: (ts, id, cmd, out) => {
      add(base('assistant', ts, { message: { id: `m-${sessionId}-${n}`, model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } }));
      add(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] }, toolUseResult: { stdout: out, stderr: '', interrupted: false } }));
    },
  };
}

function write(file, lines) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

/** Writes the logs and a config under `root`; returns what a build and a test need. */
export function writeTurnOriginLogs(root) {
  const repo = join(root, 'your-project');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
  const claudeRoot = join(root, 'claude');
  const projectDir = join(claudeRoot, PROJECT);
  const save = (s, id) => write(join(projectDir, `${id}.jsonl`), s.lines);

  // A person typed both turns: one record with the origin object, one with only turnOrigin.
  const a = cc(IDS.typed, repo);
  a.typed(at(0), 'Add a --dry-run flag to the release script.');
  a.say(at(1), 'Added the flag.');
  a.user(at(3), 'Now document it in the README.', { turnOrigin: 'human' });
  a.say(at(4), 'Documented it.');
  save(a, IDS.typed);

  // A program started this one with text, and later answered the agent's question itself.
  const b = cc(IDS.programText, repo);
  b.program(at(10), 'Summarize the open issues in the tracker.');
  b.run(at(11), 't-b1', 'gh issue list --state open', '3 open issues');
  b.say(at(12), 'There are 3 open issues. Want me to label them by area?');
  b.program(at(13), 'Yes, go ahead.');
  b.run(at(14), 't-b2', 'gh issue edit 1 --add-label docs', 'ok');
  b.say(at(15), 'Labelled them.');
  save(b, IDS.programText);

  // A headless run started with a slash command.
  const c = cc(IDS.programCommand, repo);
  c.program(at(20), command('review', 'the changes on this branch'));
  c.run(at(21), 't-c1', 'git status --short', '');
  c.say(at(22), 'Nothing uncommitted; the branch looks fine.');
  save(c, IDS.programCommand);

  // A person typed a slash command.
  const d = cc(IDS.typedCommand, repo);
  d.typed(at(30), command('deploy', 'staging'));
  d.say(at(31), 'Deployed to staging.');
  save(d, IDS.typedCommand);

  // A notice with only turnOrigin, and a value this engine doesn't know.
  const e = cc(IDS.otherValues, repo);
  e.typed(at(40), 'Start the test watcher in the background.');
  e.say(at(41), 'Started it.');
  e.user(at(42), 'Background command "npm test -- --watch" completed (exit code 0)', { turnOrigin: 'task_notification' });
  e.user(at(43), 'Run the linter on the changed files.', { turnOrigin: 'system' });
  e.say(at(44), 'The linter passed.');
  save(e, IDS.otherValues);

  // The same shape as the program's session, with a person typing both turns.
  const f = cc(IDS.typedCheckIn, repo);
  f.typed(at(50), 'Summarize the open issues in the tracker.');
  f.run(at(51), 't-f1', 'gh issue list --state open', '3 open issues');
  f.say(at(52), 'There are 3 open issues. Want me to label them by area?');
  f.typed(at(53), 'Yes, go ahead.');
  f.run(at(54), 't-f2', 'gh issue edit 1 --add-label docs', 'ok');
  f.say(at(55), 'Labelled them.');
  save(f, IDS.typedCheckIn);

  // Older Claude Code: no turnOrigin anywhere, and on the first record no origin either.
  const g = cc(IDS.legacy, repo);
  g.user(at(60), 'fix the flaky test');
  g.say(at(61), 'Fixed it.');
  g.user(at(62), 'and the docs too', { origin: { kind: 'human' } });
  g.user(at(63), command('review', 'the docs'));
  g.user(at(64), 'the docs folder moved', { origin: { kind: 'peer', name: 'helper' } });
  g.user(at(65), '<task-notification>\n<status>completed</status>\n<summary>Background build finished</summary>\n</task-notification>', { origin: { kind: 'task-notification' } });
  g.say(at(66), 'Updated the docs.');
  save(g, IDS.legacy);

  const h = cc(IDS.legacyCommand, repo);
  h.user(at(70), command('deploy', 'production'));
  h.say(at(71), 'Deployed.');
  save(h, IDS.legacyCommand);

  const rawConfig = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repo, label: 'your-project', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'honestweek.digest.md' },
  };
  const config = normalizeConfig(rawConfig, { configDir: root });
  const key = Object.fromEntries(Object.entries(IDS).map(([name, id]) => [name, claudeSessionKey(PROJECT, id)]));
  return { root, repo, roots: { claude: [claudeRoot], codex: [] }, config, key };
}

/** A history's events and sessions with what depends on the folder's path left out: byte
 *  offsets, record digests and file keys, and the folder itself. */
export function normalizeReading(x, root) {
  const drop = new Set(['off', 'len', 'digest', 'fileKey', 'fileKeys']);
  const s = JSON.stringify(x, (k, v) => (drop.has(k) ? undefined : v));
  return JSON.parse([root, root.replace(/\\/g, '/'), JSON.stringify(root).slice(1, -1)].reduce((out, r) => out.split(r).join('<root>'), s));
}
