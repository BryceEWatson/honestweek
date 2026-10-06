// Made-up Claude Code sessions, and one reading of them through every reader outside the
// work-history engine that decides what a person typed: the digest adapter (steers and
// redirects), the prompts scan and its store, the digest's evidence scan, and the miner's
// probe and stream. Current Claude Code writes `turnOrigin` on a user record ("human",
// "sdk", "task_notification", ...) and sometimes an `origin` object; older logs carry
// neither. Nothing here comes from a real log.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { adaptSessions, normalizeAttributionPath } from '../../lib/claude-adapter.mjs';
import { normalizeConfig } from '../../lib/config.mjs';
import { scanDigestEvidence } from '../../lib/digest-evidence.mjs';
import { probeSession, streamSession } from '../../lib/mine/corpus.mjs';
import { scanPromptSources } from '../../lib/prompt-adapters.mjs';
import { sha256 } from '../../lib/prompt-identity.mjs';
import { mergePromptStore } from '../../lib/prompt-store.mjs';
import { createRedactor } from '../../lib/redact.mjs';

export const PROJECT = '/work/your-project';
export const WEEK_START = new Date('2024-06-10T00:00:00.000Z');
export const WEEK_END = new Date('2024-06-17T00:00:00.000Z');
export const NOW = new Date('2024-06-17T12:00:00.000Z');
/** Words that keep a line long enough for the digest's cue grammar to read it. */
export const SUFFIX = 'with enough plain neutral words that the weekly digest keeps this line as one reviewable item';

export function readerConfig(root) {
  return normalizeConfig({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: PROJECT, label: 'your-project', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
  }, { configDir: root });
}

// Record builders. `writeSession` adds the session id, cwd and a timestamp a minute apart.
export const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
export const enqueue = (content) => ({ type: 'queue-operation', operation: 'enqueue', content });
export const bash = (id, command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } });
export const result = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
export const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
export const think = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } });
export const command = (name) => user(`<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`);

/** Who sent a user record, as current Claude Code writes it. */
export const ORIGINS = Object.freeze({
  human: { turnOrigin: 'human', origin: { kind: 'human' } },
  sdk: { turnOrigin: 'sdk' },
  task: { turnOrigin: 'task_notification', origin: { kind: 'task-notification' } },
  peer: { turnOrigin: 'peer', origin: { kind: 'peer' } },
  coordinator: { origin: { kind: 'coordinator' } },
});

export function writeSession(root, sessionId, records, { cwd = PROJECT, start = '2024-06-11T10:00:00.000Z' } = {}) {
  const dir = join(root, 'projects', 'p');
  mkdirSync(dir, { recursive: true });
  const t0 = Date.parse(start);
  const rows = records.map((r, i) => ({ ...r, sessionId, cwd, timestamp: new Date(t0 + i * 60000).toISOString() }));
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** Sessions with no `turnOrigin` and no `origin`, as Claude Code wrote them before either. */
export function writeLegacyCorpus(root) {
  writeSession(root, 'legacy-work', [
    enqueue(`fix the flaky retry test in the parser ${SUFFIX}`),
    user(`fix the flaky retry test in the parser ${SUFFIX}\nidea: keep every retry bounded by a deadline ${SUFFIX}`),
    bash('t1', 'node --test'),
    result('t1', '4 tests passed'),
    think('the retry loop needs a deadline'),
    say(`Decision: bound the retry loop by a deadline ${SUFFIX}\nNext step: document the deadline in the parser notes ${SUFFIX}`),
    command('review'),
    user('<task-notification>\n<status>completed</status>\n</task-notification>'),
    user(`no, use the other parser file instead ${SUFFIX}`),
    bash('t2', 'git commit -m "bound the retry loop"'),
    result('t2', '[main abc1234] bound the retry loop\n 1 file changed'),
    user('<cross-session-message from="another session">a note from elsewhere</cross-session-message>'),
    enqueue('also check the timeout path'),
    say('Done.'),
  ]);
  writeSession(root, 'legacy-command-only', [command('status'), say('All clear.')], { start: '2024-06-12T10:00:00.000Z' });
  writeSession(root, 'legacy-private', [user('look over the scratch notes'), say('Read them.')], { cwd: '/elsewhere/scratch', start: '2024-06-13T10:00:00.000Z' });
}

function sessionFiles(root) {
  const dir = join(root, 'projects', 'p');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().map((n) => join(dir, n));
}

/** Every reader's output over `root`'s sessions, with the machine's paths and the
 *  platform-shaped repo key replaced so the reading is the same on every OS. */
export async function readAll(root) {
  const config = readerConfig(root);
  const projectsRoot = join(root, 'projects');
  const roots = { 'claude-code': projectsRoot, codex: join(root, 'no-codex') };
  const digest = await adaptSessions({ config, weekStart: WEEK_START, weekEnd: WEEK_END, redactor: createRedactor(config), projectsRoot });
  const prompts = await scanPromptSources({ config, weekStart: WEEK_START, weekEnd: WEEK_END, roots, now: NOW });
  const store = mergePromptStore(null, prompts, NOW);
  const evidence = await scanDigestEvidence({ config, promptStore: store, roots, sourceStatus: prompts.sourceStatus });
  const mine = {};
  for (const file of sessionFiles(root)) {
    const name = file.replace(/\\/g, '/').split('/').pop().replace(/\.jsonl$/, '');
    mine[name] = { probe: probeSession('claude-code', file), stream: await streamSession('claude-code', file) };
  }
  const repoKey = sha256(normalizeAttributionPath(config.repos[0].resolvedPath, PROJECT));
  const roots2 = [root, root.replace(/\\/g, '/')];
  const scrub = (v) => {
    if (typeof v === 'string') {
      let s = v.split(repoKey).join('<repoKey>');
      for (const r of roots2) s = s.split(r).join('<root>');
      return s;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(JSON.parse(JSON.stringify({ digest, prompts, store, evidence, mine })));
}
