// The made-up demo week, seeded for the honestweek view tests with made-up private
// terms, a made-up name, secrets, and the ids the switch is meant to show, so a zero
// from the leak counter means something. Every value here is invented.
//
// On top of the demo week it writes, on the quiet Wednesday:
//   featured  a Claude Code session in lantern: a title and prompt holding the private
//             term, a name, an email, a home folder and secrets (a password on the line
//             after its label among them); a test run whose output holds them too; a
//             call that carries a goal entry id at a time the entry wasn't written; a
//             prompt with no recorded origin; a line with no time of its own; a
//             sub-agent whose first line is stamped before the call that started it; and a
//             command that ends in a header's value.
//   display   the same seeded prompt and output in the display-only site repository.
//   outside   the seeded prompt in a folder outside the config, plus a long prompt that
//             puts the private term right where a search excerpt is cut.
//   exec      a non-interactive Codex run in lantern, whose prompt a script may have written.
// The goal list adds two goals whose ids hold private terms and redact to the same text.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDemoWeek, SESSION_IDS, WEEK } from '../../../lib/demo/week.mjs';
import { claudeSessionKey } from '../../../lib/replay/sources.mjs';
import { sourceKey } from '../../../lib/replay/ids.mjs';

export { WEEK };

export const TERM = 'Northwind';
export const OTHER_TERM = 'Contoso';
export const NAME = 'Dana Whitfield';
export const EMAIL = 'dana.whitfield@example.org';
export const HOME_PATH = '/home/dana/code/northwind-app/notes.md';
export const WIN_PATH = 'C:\\Users\\Dana\\Documents\\northwind\\plan.md';
export const SECRETS = Object.freeze({
  apiKey: 'sk-abcdefghijklmnop1234567890',
  github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
  password: 'hunter2hunter2',
  nextLine: 'swordfish4417',
  bearer: 'abcdEFGH12345678',
});
/** Words that only the private build may show. */
export const PRIVATE_WORDS = [TERM, OTHER_TERM, 'Whitfield', EMAIL];

export const IDS = Object.freeze({
  featured: '11111111-2222-4333-8444-555555555555',
  display: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  outside: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  exec: '01950000-0000-7000-8000-0000000000e1',
  agent: 'a0f1e2d3c4b5a697',
});

export const SEEDED = [
  `Ship the ${TERM} report from ${HOME_PATH} and ${WIN_PATH}, then mail ${EMAIL}. Ask ${NAME} first.`,
  `Use API_KEY=${SECRETS.apiKey} and token ${SECRETS.github} and ${SECRETS.jwt}.`,
  `The config says {"password": "${SECRETS.password}"} and the header is Authorization: Bearer ${SECRETS.bearer}.`,
  'Password:',
  SECRETS.nextLine,
  'Then run the suite.',
].join('\n');

const OUTPUT = ['TAP version 13', 'not ok 3 - parses dates', '# tests 3', '# pass 2', '# fail 1', `${TERM} build read ${HOME_PATH} for ${EMAIL}`, `token: ${SECRETS.github}`, 'Password:', SECRETS.nextLine].join('\n');

/** A command whose last field is a header's value, which the redactor hides to the end of
 *  the line. A step's description adds its own words after the command (" -> ok"). */
export const HEADER_COMMAND = `curl -s https://api.example.com/v1/items -H Authorization: Bearer ${SECRETS.bearer}`;

/** The long prompt whose excerpt cut falls on the private term. The excerpt runs 160
 *  characters from the search word, and the term sits inside one long path with no space
 *  to step back to, at 155 to 163, so only redacting before cutting keeps all of it out. */
export const STRADDLE_WORD = 'zephyrstraddle';
export const STRADDLE = `${STRADDLE_WORD}/${'segment/'.repeat(17)}dir/${TERM}/plan.md and more words after it to keep going past the cut.`;

/** A prompt longer than any cut, with a token starting 10 characters before its
 *  20,000th: cut there before redacting, the piece left is too short for any rule. */
export const LONG_WORD = 'quokkalongprompt';
const LONG_HEAD = `${LONG_WORD} token `;
export const LONG_PROMPT = `${'x'.repeat(19990 - LONG_HEAD.length - 1)} ${LONG_HEAD}${SECRETS.github} and the end.`;

/** A word only a compaction summary holds: the model's account of earlier context. */
export const SUMMARY_WORD = 'wombatsummary';

/** A word only a prompt typed while the agent was busy holds. */
export const QUEUED_WORD = 'numbatqueued';

const at = (hh, mm, ss = 0, ms = 0) => `2025-03-12T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`;

function claudeLog(id, cwd) {
  const lines = [];
  let n = 0;
  const base = (type, ts, extra = {}) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.0', gitBranch: 'main', type, uuid: `${id.slice(0, 8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`, ...(ts ? { timestamp: ts } : {}), ...extra });
  return {
    lines,
    title: (text) => lines.push(JSON.stringify({ type: 'ai-title', aiTitle: text, sessionId: id })),
    prompt: (ts, text, origin = { kind: 'human' }) => lines.push(JSON.stringify(base('user', ts, { message: { role: 'user', content: text }, ...(origin ? { origin } : {}) }))),
    summary: (ts, text) => lines.push(JSON.stringify(base('user', ts, { message: { role: 'user', content: text }, isCompactSummary: true }))),
    queued: (ts, text) => lines.push(JSON.stringify(base('attachment', ts, { attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt' } }))),
    say: (ts, content) => lines.push(JSON.stringify(base('assistant', ts, { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'model-a', content } }))),
    result: (ts, toolUseId, content, tur) => lines.push(JSON.stringify(base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] }, toolUseResult: tur }))),
  };
}

const cwdOf = (d, projectDir, sessionId) => JSON.parse(readFileSync(join(d.roots.claude[0], projectDir, `${sessionId}.jsonl`), 'utf8').split('\n').find((l) => l.includes('"cwd"'))).cwd;

/**
 * buildViewWeek(root) -> { d, config, goalRecord, keys, roots, week }
 * `keys` holds the history's session keys of the seeded sessions.
 */
export function buildViewWeek(root) {
  const d = buildDemoWeek({ root });
  const dirs = d.ids.projectDirs;
  const projects = d.roots.claude[0];
  const lanternCwd = cwdOf(d, dirs.lantern, SESSION_IDS.sinceFlag);
  const siteCwd = cwdOf(d, dirs.site, SESSION_IDS.sitePost);
  const scratchCwd = cwdOf(d, dirs.scratch, SESSION_IDS.scratch);

  // featured
  const f = claudeLog(IDS.featured, lanternCwd);
  f.title(`${TERM} follow-up`);
  f.prompt(at(10, 0), SEEDED);
  f.say(at(10, 1), [{ type: 'tool_use', id: 'toolu_view_test', name: 'Bash', input: { command: 'node --test', description: `Run the ${TERM} suite` } }]);
  f.result(at(10, 2), 'toolu_view_test', OUTPUT, { stdout: OUTPUT, stderr: '', interrupted: false });
  f.say(at(10, 3), [{ type: 'tool_use', id: 'toolu_view_show', name: 'Bash', input: { command: 'node $GOALS_DIR/goals.mjs show --event gev-late1' } }]);
  f.result(at(10, 3, 2), 'toolu_view_show', 'shown', { stdout: 'shown', stderr: '', interrupted: false });
  // A line with no time of its own: placed at the line before it.
  f.say(null, [{ type: 'text', text: 'Noted, the goal entry is there.' }]);
  // A sub-agent started at 10:05, whose first line is stamped 30 s earlier.
  f.say(at(10, 5), [{ type: 'tool_use', id: 'toolu_view_agent', name: 'Agent', input: { description: 'Check the dates', subagent_type: 'Explore', prompt: 'Check the dates.' } }]);
  f.result(at(10, 6), 'toolu_view_agent', 'Checked.', { status: 'completed', agentId: IDS.agent, content: [{ type: 'text', text: 'Checked.' }] });
  // An older prompt record with no origin field: "You", by a named rule.
  f.prompt(at(10, 7), 'Now tidy the changelog wording.', null);
  f.say(at(10, 8), [{ type: 'text', text: 'Tidied.' }]);
  f.say(at(10, 9), [{ type: 'tool_use', id: 'toolu_view_header', name: 'Bash', input: { command: HEADER_COMMAND } }]);
  f.result(at(10, 9, 5), 'toolu_view_header', 'ok', { stdout: 'ok', stderr: '', interrupted: false });
  // A result whose content blocks split a password from its label.
  f.say(at(10, 10), [{ type: 'tool_use', id: 'toolu_view_split', name: 'Bash', input: { command: 'cat login.txt' } }]);
  f.result(at(10, 10, 5), 'toolu_view_split', [{ type: 'text', text: 'Login with Password:' }, { type: 'text', text: SECRETS.nextLine }], { stdout: 'printed', stderr: '', interrupted: false });
  writeFileSync(join(projects, dirs.lantern, `${IDS.featured}.jsonl`), `${f.lines.join('\n')}\n`);
  const sub = claudeLog(IDS.featured, lanternCwd);
  sub.prompt(at(10, 4, 30), 'Check the dates.', null);
  sub.say(at(10, 5, 40), [{ type: 'text', text: 'The dates parse.' }]);
  const subDir = join(projects, dirs.lantern, IDS.featured, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, `agent-${IDS.agent}.jsonl`), `${sub.lines.map((l) => l.replace('"isSidechain":false', '"isSidechain":true')).join('\n')}\n`);
  writeFileSync(join(subDir, `agent-${IDS.agent}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Check the dates', toolUseId: 'toolu_view_agent' }));

  // display-only
  const s = claudeLog(IDS.display, siteCwd);
  s.title(`${TERM} site post`);
  s.prompt(at(11, 0), SEEDED);
  s.say(at(11, 1), [{ type: 'tool_use', id: 'toolu_view_site', name: 'Bash', input: { command: 'node --test' } }]);
  s.result(at(11, 2), 'toolu_view_site', OUTPUT, { stdout: OUTPUT, stderr: '', interrupted: false });
  writeFileSync(join(projects, dirs.site, `${IDS.display}.jsonl`), `${s.lines.join('\n')}\n`);

  // outside the config
  const o = claudeLog(IDS.outside, scratchCwd);
  o.prompt(at(12, 0), SEEDED);
  o.prompt(at(12, 2), STRADDLE);
  o.say(at(12, 3), [{ type: 'text', text: 'Done.' }]);
  o.prompt(at(12, 4), LONG_PROMPT);
  o.summary(at(12, 5), `This session is being continued from an earlier one. The ${SUMMARY_WORD} covers the work so far.`);
  o.say(at(12, 6), [{ type: 'tool_use', id: 'toolu_view_busy', name: 'Bash', input: { command: 'sleep 1' } }]);
  o.queued(at(12, 6, 30), `Also check the ${QUEUED_WORD} list while that runs.`);
  o.result(at(12, 7), 'toolu_view_busy', 'done', { stdout: 'done', stderr: '', interrupted: false });
  writeFileSync(join(projects, dirs.scratch, `${IDS.outside}.jsonl`), `${o.lines.join('\n')}\n`);

  // a non-interactive Codex run in lantern
  const cx = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
  const codexFile = join(d.roots.codex[0], '2025', '03', '12', `rollout-2025-03-12T13-00-00-${IDS.exec}.jsonl`);
  mkdirSync(join(codexFile, '..'), { recursive: true });
  writeFileSync(codexFile, `${[
    cx(at(13, 0), 'session_meta', { id: IDS.exec, timestamp: at(13, 0), cwd: lanternCwd, originator: 'codex_exec', cli_version: '0.1.0', source: 'exec' }),
    cx(at(13, 0, 1), 'turn_context', { turn_id: 'tv1', model: 'model-b' }),
    cx(at(13, 0, 2), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarise the changelog for the release notes.' }] }),
    cx(at(13, 1), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Summarised.' }] }),
    cx(at(13, 2), 'event_msg', { type: 'task_complete', turn_id: 'tv1', duration_ms: 120000 }),
  ].join('\n')}\n`);

  const config = { ...d.config, redaction: { codenames: [], names: [NAME], terms: [TERM, OTHER_TERM] } };
  const goalRecord = {
    goals: [
      ...d.goalRecord.goals,
      { id: 'client-northwind', title: `${TERM} launch`, state: 'active', observations: [{ note: `Asked about it in session:${IDS.display}` }] },
      { id: 'client-contoso', title: `${OTHER_TERM} launch`, state: 'active', observations: [{ note: `Worked on in session:${IDS.featured}` }] },
    ],
    events: [...d.goalRecord.events, { eventId: 'gev-late1', goalId: 'client-northwind', type: 'goal.update', at: at(10, 30) }],
  };
  const keys = {
    featured: claudeSessionKey(dirs.lantern, IDS.featured),
    display: claudeSessionKey(dirs.site, IDS.display),
    outside: claudeSessionKey(dirs.scratch, IDS.outside),
    exec: sourceKey('cx', IDS.exec),
  };
  return { d, config, goalRecord, keys, roots: d.roots, week: { ...WEEK } };
}
