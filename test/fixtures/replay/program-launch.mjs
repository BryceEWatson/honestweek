// Made-up Claude Code and Codex logs for finding the step that started a session a program
// opened: a `claude -p` or `codex exec` command in another session's shell call, or a Stop hook's
// record, that names the session's id or holds its opening instruction, or that ran in the same
// folder shortly before it. Nothing here comes from a real log.
//
// `writeLaunchLogs(root, { launches })` writes the same sessions either way. With
// `launches: false` it leaves out every step that would start a link, and keeps the shapes that
// must not start one (a launch in another folder, a `--resume` after the session started, a
// Stop hook that names nothing, an older log with no turnOrigin), so that build must read
// exactly as it did before the launch join existed.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeConfig } from '../../../lib/config.mjs';
import { sourceKey } from '../../../lib/replay/ids.mjs';
import { claudeSessionKey } from '../../../lib/replay/sources.mjs';

export const ME = 'you@example.com';
const PROJECT = 'proj-launch';
const OTHER = 'proj-launch-other';
export const WINDOW = Object.freeze({ from: '2024-06-10', to: '2024-06-16', timezone: 'UTC' });
const T0 = Date.parse('2024-06-11T15:00:00.000Z');
export const at = (min, ms = 0) => new Date(T0 + min * 60000 + ms).toISOString();

export const IDS = Object.freeze({
  launcher: 'a0000000-0000-4000-8000-00000000000a',
  second: 'b0000000-0000-4000-8000-00000000000b',
  legacyParent: 'c0000000-0000-4000-8000-00000000000c',
  byId: 'd1000000-0000-4000-8000-0000000000d1',
  byText: 'd2000000-0000-4000-8000-0000000000d2',
  byTime: 'd3000000-0000-4000-8000-0000000000d3',
  ambiguous: 'd4000000-0000-4000-8000-0000000000d4',
  farAway: 'd5000000-0000-4000-8000-0000000000d5',
  hookNamed: 'd6000000-0000-4000-8000-0000000000d6',
  hookSilent: 'd7000000-0000-4000-8000-0000000000d7',
  legacyChild: 'd8000000-0000-4000-8000-0000000000d8',
  pairA: 'd9000000-0000-4000-8000-0000000000d9',
  pairB: 'da000000-0000-4000-8000-0000000000da',
  fromCodex: 'db000000-0000-4000-8000-0000000000db',
});
export const CODEX_IDS = Object.freeze({
  parent: 'e1000000-0000-7000-8000-0000000000e1',
  byText: 'e2000000-0000-7000-8000-0000000000e2',
  plain: 'e3000000-0000-7000-8000-0000000000e3',
});

export const TEXT = Object.freeze({
  byText: 'Summarize the open issues in the tracker and label each one by area, then report back.',
  codexByText: 'Write release notes for the changes merged since Monday, one line each.',
});

const command = (name, args) => `<command-message>${name} is running…</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;

function cc(sessionId, cwd, { legacy = false } = {}) {
  const lines = [];
  let n = 0;
  const base = (type, ts, extra = {}) => ({ type, sessionId, cwd, version: legacy ? '1.0.71' : '2.1.0', uuid: `${sessionId}-r${++n}`, timestamp: ts, ...extra });
  const add = (o) => lines.push(JSON.stringify(o));
  const user = (ts, content, extra = {}) => add(base('user', ts, { message: { role: 'user', content }, ...extra }));
  return {
    lines,
    user,
    typed: (ts, content) => user(ts, content, legacy ? {} : { origin: { kind: 'human' }, turnOrigin: 'human' }),
    program: (ts, content) => user(ts, content, { turnOrigin: 'sdk' }),
    title: (text) => add({ type: 'custom-title', customTitle: text, sessionId }),
    say: (ts, text) => add(base('assistant', ts, { message: { id: `m-${sessionId}-${n}`, model: 'model-a', role: 'assistant', content: [{ type: 'text', text }] } })),
    run: (ts, id, cmd, out) => {
      add(base('assistant', ts, { message: { id: `m-${sessionId}-${n}`, model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } }));
      add(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] }, toolUseResult: { stdout: out, stderr: '', interrupted: false } }));
    },
    /** A Stop hook's own record, and the harness's summary of the stop hooks that ran. */
    stopHook: (ts, { command: cmd, stdout }) => {
      add(base('attachment', ts, { attachment: { type: 'hook_success', hookName: 'Stop', toolUseID: `h-${n}`, hookEvent: 'Stop', content: '', stdout, stderr: '', command: cmd } }));
      add(base('system', ts, { subtype: 'stop_hook_summary', hookInfos: [{ command: cmd }], hookErrors: [], stopReason: '', level: 'suggestion' }));
    },
  };
}

function cx(id, cwd, { exec = false } = {}) {
  const rows = [{ timestamp: null, type: 'session_meta', payload: { id, cwd, cli_version: '0.1.0', ...(exec ? { originator: 'codex_exec', source: 'exec' } : { originator: 'codex_cli_rs', source: 'cli' }) } }];
  return {
    rows,
    meta: (ts) => {
      rows[0].timestamp = ts;
    },
    user: (ts, text) => rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
    say: (ts, text) => rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    shell: (ts, callId, cmd, out) => {
      rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd }) } });
      rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: `Exit code: 0\n${out}` } });
    },
  };
}

function write(file, lines) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

/** Writes the logs and a config under `root`; returns what a build and a test need. `role` is
 *  the main folder's repository role, `terms` the config's private words. */
export function writeLaunchLogs(root, { launches = true, role = 'featured', terms = [] } = {}) {
  const repo = join(root, 'your-project');
  const other = join(root, 'other-project');
  for (const r of [repo, other]) {
    mkdirSync(r, { recursive: true });
    execFileSync('git', ['-C', r, 'init', '-q'], { stdio: 'ignore' });
  }
  const claudeRoot = join(root, 'claude');
  const codexRoot = join(root, 'codex');
  const save = (s, id, dir = PROJECT) => write(join(claudeRoot, dir, `${id}.jsonl`), s.lines);
  const saveCx = (s, id, ts) => write(join(codexRoot, 'sessions', '2024', '06', '11', `rollout-2024-06-11T${ts}-${id}.jsonl`), s.rows.map((r) => JSON.stringify(r)));
  const L = (fn) => launches && fn();

  // A person's session that starts the runs below.
  const p1 = cc(IDS.launcher, repo);
  p1.title('Start the review runs');
  p1.typed(at(0), 'Start the review runs.');
  // Names the run's id: recorded.
  L(() => p1.run(at(1), 't-p1', `claude -p --session-id ${IDS.byId} "/review the changes since Monday"`, 'started'));
  // A later turn of that run, sent after it started: never its start.
  p1.run(at(2), 't-p2', `claude -p --resume ${IDS.byId} "And run the tests."`, 'done');
  // Holds the run's opening instruction: derived.
  L(() => p1.run(at(5), 't-p3', `claude -p "${TEXT.byText}"`, 'done'));
  // Names only its own session (passed to the run as context), the only launch in this folder
  // in the 2 minutes before the run: inferred.
  L(() => p1.run(at(10), 't-p4', `PARENT_SESSION=${IDS.launcher} cat notes/plan.md | claude -p --output-format json`, '{}'));
  // One of two launches in this folder before one run: ambiguous.
  L(() => p1.run(at(20), 't-p5', 'claude -p < tasks/one.md', 'done'));
  // A launch in this folder before a run in another folder: timing across folders is never a link.
  p1.run(at(30), 't-p6', 'claude -p < far.md', 'done');
  // A codex exec run whose instruction is in the command: derived, for a Codex session.
  L(() => p1.run(at(60), 't-p7', `codex exec "${TEXT.codexByText}"`, 'done'));
  p1.say(at(61), 'Started them.');
  save(p1, IDS.launcher);

  // Another person's session in the same folder.
  const p2 = cc(IDS.second, repo);
  p2.title('Night checks');
  p2.typed(at(19, 48000), 'Kick off the second task.');
  L(() => p2.run(at(20, 30000), 't-q1', 'claude -p < tasks/two.md', 'done'));
  p2.say(at(39), 'Done for now.');
  // A Stop hook whose record names the run it started: recorded.
  L(() => p2.stopHook(at(40), { command: 'node hooks/after-turn.mjs', stdout: `Started review session ${IDS.hookNamed}.` }));
  p2.typed(at(49), 'One more pass.');
  p2.say(at(49, 30000), 'Done.');
  // A Stop hook that names nothing: a run right after it isn't linked by timing.
  p2.stopHook(at(50), { command: 'node hooks/after-turn.mjs', stdout: 'Review queued.' });
  p2.typed(at(89), 'Run the batch.');
  // One launch, then two runs in this folder within 2 minutes: neither is linked.
  L(() => p2.run(at(90), 't-q2', 'claude -p < tasks/batch.md', 'done'));
  p2.say(at(91), 'Batch started.');
  save(p2, IDS.second);

  // An older Claude Code that writes no turnOrigin: its run reads as it always did.
  const p3 = cc(IDS.legacyParent, repo, { legacy: true });
  p3.typed(at(80), 'start the legacy run');
  p3.run(at(80, 30000), 't-r1', `claude -p --session-id ${IDS.legacyChild} "Tidy the README."`, 'done');
  save(p3, IDS.legacyParent);
  const lc = cc(IDS.legacyChild, repo, { legacy: true });
  lc.user(at(80, 40000), 'Tidy the README.');
  lc.say(at(81), 'Tidied it.');
  save(lc, IDS.legacyChild);

  // The runs a program started (turnOrigin "sdk").
  const run = (id, ts, opening, { cwd = repo, dir = PROJECT, slash = null } = {}) => {
    const s = cc(id, cwd);
    s.program(ts, slash ? command(slash[0], slash[1]) : opening);
    s.say(new Date(Date.parse(ts) + 20000).toISOString(), 'Done.');
    save(s, id, dir);
  };
  run(IDS.byId, at(1, 3000), null, { slash: ['review', 'the changes since Monday'] });
  run(IDS.byText, at(5, 2000), TEXT.byText);
  run(IDS.byTime, at(10, 30000), 'Plan: tidy the changelog headings and fix the two broken links.');
  run(IDS.ambiguous, at(21), 'Rename the config loader and update its tests.');
  run(IDS.farAway, at(30, 20000), "Check the other project's build.", { cwd: other, dir: OTHER });
  run(IDS.hookNamed, at(40, 12000), 'Review the last turn for anything left unfinished.');
  run(IDS.hookSilent, at(50, 10000), 'Review the last turn again.');
  run(IDS.pairA, at(90, 20000), 'Check the first half of the batch.');
  run(IDS.pairB, at(90, 40000), 'Check the second half of the batch.');
  run(IDS.fromCodex, at(70, 35000), null, { slash: ['review', 'the release branch'] });

  // A person's Codex session that starts a Claude Code run by its id.
  const c1 = cx(CODEX_IDS.parent, repo);
  c1.meta(at(69, 50000));
  c1.user(at(70), 'Start a review run from here.');
  L(() => c1.shell(at(70, 30000), 'c-1', `claude -p --session-id ${IDS.fromCodex} "/review the release branch"`, 'started'));
  c1.say(at(71), 'Started it.');
  saveCx(c1, CODEX_IDS.parent, '15-09-50');

  // codex exec runs: one a launch above names by its instruction, one nothing launched.
  const c2 = cx(CODEX_IDS.byText, repo, { exec: true });
  c2.meta(at(60, 4000));
  c2.user(at(60, 5000), TEXT.codexByText);
  c2.say(at(60, 30000), 'Wrote them.');
  saveCx(c2, CODEX_IDS.byText, '16-00-04');
  const c3 = cx(CODEX_IDS.plain, repo, { exec: true });
  c3.meta(at(100));
  c3.user(at(100, 1000), 'Count the TODO comments in src.');
  c3.say(at(100, 20000), 'There are 4.');
  saveCx(c3, CODEX_IDS.plain, '16-40-00');

  const rawConfig = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [
      { path: repo, label: 'your-project', role },
      { path: other, label: 'other-project', role: 'featured' },
    ],
    redaction: { codenames: [], names: [], terms },
    output: { mode: 'digest', file: 'honestweek.digest.md' },
  };
  const config = normalizeConfig(rawConfig, { configDir: root });
  const key = {
    ...Object.fromEntries(Object.entries(IDS).map(([name, id]) => [name, claudeSessionKey(name === 'farAway' ? OTHER : PROJECT, id)])),
    ...Object.fromEntries(Object.entries(CODEX_IDS).map(([name, id]) => [`codex${name[0].toUpperCase()}${name.slice(1)}`, sourceKey('cx', id)])),
  };
  return { root, repo, other, roots: { claude: [claudeRoot], codex: [codexRoot] }, config, key };
}
