// Made-up Claude Code session logs for the site's session count (lib/site/sessions.mjs).
//
// LEGACY_LOGS carry neither `turnOrigin` nor `origin`, as older Claude Code writes them. The
// count the deriver gave them before it read either field is pinned, byte for byte, in
// site-sessions-legacy-reading.json. MARKED_LOGS carry the fields current Claude Code writes on
// user records. Every name, path and line of text here is invented.

import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

export const WEEK_START = new Date('2024-06-10T00:00:00.000Z'); // Monday
export const WEEK_END = new Date('2024-06-16T23:59:59.999Z'); // Sunday
export const NOW = new Date('2024-06-19T12:00:00Z');
const MTIME = new Date('2024-06-14T12:00:00Z'); // inside the week, so no log is pre-filtered by age

export function siteConfig() {
  return {
    week: { timezone: 'UTC' },
    repos: [
      { label: 'alpha', path: '/work/alpha', resolvedPath: '/work/alpha', role: 'featured' },
      { label: 'beta', path: '/work/beta', resolvedPath: '/work/beta', role: 'reference' },
    ],
  };
}

const user = (ts, cwd, content, extra = {}) => ({ type: 'user', timestamp: ts, cwd, message: { role: 'user', content }, ...extra });
const assistant = (ts, cwd) => ({ type: 'assistant', timestamp: ts, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
const toolResult = (ts, cwd, extra = {}) => user(ts, cwd, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], extra);
const snapshot = () => ({ type: 'file-history-snapshot', messageId: 'm0', snapshot: {} });
const SDK = { turnOrigin: 'sdk' };
const HUMAN = { turnOrigin: 'human' };

export const LEGACY_LOGS = [
  { dir: 'proj', name: 'l01', records: [snapshot(), user('2024-06-12T09:00:00Z', '/work/alpha', 'Help me build the importer.'), assistant('2024-06-12T09:00:05Z', '/work/alpha')] },
  { dir: 'proj', name: 'l02', records: [user('2024-06-12T14:00:00Z', '/work/beta', [{ type: 'text', text: 'Fix the flaky test.' }])] },
  { dir: 'proj', name: 'l03', records: [user('2024-06-13T10:00:00Z', '/work/gamma', 'Tidy an unrelated folder.')] },
  { dir: 'proj', name: 'l04', records: [user('2024-06-13T08:00:00Z', '/work/alpha', 'Project: status check'), user('2024-06-13T08:01:00Z', '/work/alpha', 'Now write the parser.')] },
  { dir: 'proj', name: 'l05', records: [toolResult('2024-06-13T11:00:00Z', '/work/alpha'), user('2024-06-13T11:01:00Z', '/work/alpha', 'Carry on with the parser.')] },
  { dir: 'proj', name: 'l06', records: [user('2024-06-14T09:30:00Z', '/work/beta', '<system-reminder>context</system-reminder>\nAdd a retry to the fetcher.')] },
  { dir: 'proj', name: 'l07', records: [user('2024-06-12T09:00:00Z', '/work/alpha', 'Help me build the importer.'), assistant('2024-06-12T09:30:00Z', '/work/alpha')] },
  { dir: 'proj', name: 'l08', records: [user('2024-06-08T10:00:00Z', '/work/alpha', 'Work from the week before.')] },
  { dir: 'proj', name: 'l09', records: [snapshot(), assistant('2024-06-12T10:00:00Z', '/work/alpha')] },
  { dir: 'proj', name: 'l10', records: [user(undefined, '/work/alpha', 'A prompt with no time on it.')] },
  { dir: 'proj', name: 'l11', records: [user('2024-06-15T07:00:00Z', '/work/alpha', '<command-name>/weekly</command-name>')] },
  { dir: 'proj', name: 'l12', records: [user('2024-06-14T16:00:00Z', '/work/alpha/.claude/worktrees/task-1', 'Ship the worktree change.')] },
  { dir: 'proj', name: 'l13', records: [user('2024-06-16T23:30:00Z', '/work/beta', 'Late Sunday fix.')] },
  { dir: 'proj', name: 'l14', records: [user('2024-06-15T12:00:00Z', '/work/alpha', 'You are a reviewer. Review the diff.')] },
  { dir: 'C--Users-you-AppData-Local-Temp-probe', name: 'l15', records: [user('2024-06-12T12:00:00Z', '/tmp/probe', 'A probe in a temp folder.')] },
];

export const MARKED_LOGS = [
  // A turn marked as the person's counts, as an unmarked one always has.
  { dir: 'proj', name: 'm01', records: [user('2024-06-11T09:00:00Z', '/work/alpha', 'Plan the release.', HUMAN)] },
  { dir: 'proj', name: 'm02', records: [user('2024-06-11T10:00:00Z', '/work/beta', 'An empty mark reads as no mark.', { turnOrigin: '' })] },
  // Someone else opened the session and no turn came from the person: not counted.
  { dir: 'proj', name: 'm03', records: [user('2024-06-11T11:00:00Z', '/work/alpha', 'Review the open pull request.', SDK), assistant('2024-06-11T11:00:09Z', '/work/alpha'), toolResult('2024-06-11T11:01:00Z', '/work/alpha')] },
  { dir: 'proj', name: 'm04', records: [user('2024-06-11T12:00:00Z', '/work/alpha', 'Check the build for me.', { origin: { kind: 'peer' } })] },
  { dir: 'proj', name: 'm05', records: [user('2024-06-11T13:00:00Z', '/work/alpha', 'Background task finished.', { turnOrigin: 'task_notification' })] },
  { dir: 'proj', name: 'm06', records: [user('2024-06-11T14:00:00Z', '/work/alpha', 'Summarise the week.', { turnOrigin: 'some-later-kind' })] },
  { dir: 'proj', name: 'm07', records: [user('2024-06-11T15:00:00Z', '/work/alpha', 'Either field naming someone else is enough.', { turnOrigin: 'sdk', origin: { kind: 'human' } })] },
  // After a program's first turn, a record with no mark (a tool result, harness context) is not the person's.
  { dir: 'proj', name: 'm08', records: [user('2024-06-12T08:00:00Z', '/work/beta', 'Run the audit.', SDK), toolResult('2024-06-12T08:01:00Z', '/work/beta'), user('2024-06-12T08:02:00Z', '/work/beta', 'Loaded context for the task.')] },
  // A program opened it on Wednesday and the person sent a turn on Thursday: counted once, on Thursday.
  { dir: 'proj', name: 'm09', records: [snapshot(), user('2024-06-12T22:00:00Z', '/work/beta', 'Start the long job.', SDK), toolResult('2024-06-12T22:05:00Z', '/work/beta'), user('2024-06-13T09:15:00Z', '/work/beta', 'Pick this back up and finish it.', HUMAN)] },
  { dir: 'proj', name: 'm10', records: [user('2024-06-12T22:00:00Z', '/work/beta', 'Start the long job.', SDK), user('2024-06-13T09:15:00Z', '/work/beta', 'Pick this back up and finish it.', HUMAN), assistant('2024-06-13T09:20:00Z', '/work/beta')] },
  // The person's turn is still classified: an operator probe they sent is not an interactive prompt.
  { dir: 'proj', name: 'm11', records: [user('2024-06-14T08:00:00Z', '/work/alpha', 'Open the session.', SDK), user('2024-06-14T08:01:00Z', '/work/alpha', 'Project: status check', HUMAN)] },
];

/** Write `logs` under `root` (one folder per `dir`) with a fixed in-week modification time. */
export function writeLogs(root, logs) {
  for (const { dir, name, records } of logs) {
    const folder = join(root, dir);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${name}.jsonl`);
    writeFileSync(file, records.map((r) => JSON.stringify({ sessionId: name, ...r })).join('\n') + '\n');
    utimesSync(file, MTIME, MTIME);
  }
  return root;
}
