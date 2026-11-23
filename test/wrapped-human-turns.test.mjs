// test/wrapped-human-turns.test.mjs: the Claude desktop app writes a turn the person typed as an
// ARRAY of text blocks, marked `turnOrigin: "human"` / `origin.kind: "human"`, whenever it attaches
// a note: a `<system-reminder>` block ahead of what was typed. Such a turn makes a session
// interactive in the digest, and gives a steer with the reminders taken out. An array with no mark
// (a tool result, a skill's loaded instructions) and a harness-injected `isMeta` string never do.
// A session a coordinator opened counts from the person's first marked turn even when that turn is
// far past the head. Every session, path and line here is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { adaptSessions, humanTurnText } from '../lib/claude-adapter.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { deriveSessions, firstUserMessage, isInteractiveFirstPrompt, READS_PAST_HEAD } from '../lib/site/sessions.mjs';
import { PROJECT, SUFFIX, WEEK_END, WEEK_START, readerConfig, say, user, writeSession } from './fixtures/turn-origin-readers.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const HUMAN = { turnOrigin: 'human', origin: { kind: 'human' } };
const REMINDER = '<system-reminder>\nLinked sessions now: one session, working.\n</system-reminder>';
/** A typed turn as the desktop app writes it when it attaches a note. */
const wrapped = (typed) => user([{ type: 'text', text: `${REMINDER}\n\n` }, { type: 'text', text: typed }], HUMAN);
const coordinatorOpens = (text) => user(text, { turnOrigin: 'host_synthetic' });
const skillLoader = () => user([{ type: 'text', text: 'Base directory for this skill: /skills/review\n\n# review\nRead the diff.' }], { isMeta: true });
const unmarkedArray = (text) => user([{ type: 'text', text }]);
const hookFeedback = () => user('Stop hook feedback:\nThe last reply broke the style.', { isMeta: true });
const compactSummary = () => user('This session is being continued from a previous conversation.', { turnOrigin: 'human', isCompactSummary: true });
/** Enough assistant text to push what follows well past the 64KB head. */
const filler = (n) => Array.from({ length: n }, (_, i) => say(`Step ${i}: ${'reading the parser and its tests '.repeat(40)}`));

async function digestOf(root) {
  const config = readerConfig(root);
  return adaptSessions({ config, weekStart: WEEK_START, weekEnd: WEEK_END, redactor: createRedactor(config), projectsRoot: join(root, 'projects') });
}

async function withRoot(fn) {
  const root = makeTempDir('hw-wrapped-');
  try {
    return await fn(root);
  } finally {
    removeTempDir(root);
  }
}

test('humanTurnText: a marked array gives its typed text with the reminder taken out', () => {
  assert.equal(humanTurnText(wrapped('the PC crashed, please resume')), 'the PC crashed, please resume');
  assert.equal(humanTurnText(user('a plain typed turn')), 'a plain typed turn', 'a string reads as before');
  assert.equal(humanTurnText(user([{ type: 'text', text: REMINDER }], HUMAN)), null, 'only a reminder: nothing typed');
  assert.equal(humanTurnText(user([{ type: 'text', text: 'typed' }], { origin: { kind: 'human' } })), 'typed', 'origin.kind alone marks it');
  assert.equal(humanTurnText(user([{ type: 'text', text: 'typed' }], { turnOrigin: 'human' })), 'typed', 'turnOrigin alone marks it');
  assert.equal(humanTurnText(unmarkedArray('typed?')), null, 'an array with no mark is never the person\'s');
  assert.equal(humanTurnText(skillLoader()), null);
  assert.equal(humanTurnText(hookFeedback()), null, 'a harness-injected string is not typed');
  assert.equal(humanTurnText(compactSummary()), null, 'a compaction summary is not typed, though marked');
  assert.equal(humanTurnText(user([{ type: 'text', text: 'typed' }], { turnOrigin: 'human', origin: { kind: 'peer' } })), null, 'someone else named on either field');
  assert.equal(humanTurnText(user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], HUMAN)), null);
});

test('digest: a session whose only typed turn is a wrapped array is interactive, and its steer is the typed text, redacted', async () => {
  await withRoot(async (root) => {
    writeSession(root, 'wrapped-only', [wrapped(`no, mail the summary to someone@private-mail.test ${SUFFIX}`), say('Sent.')]);
    const entries = await digestOf(root);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.steers.length, 1);
    assert.ok(!entry.steers[0].includes('system-reminder'), 'the reminder is taken out');
    assert.ok(!entry.steers[0].includes('Linked sessions'), 'and its text with it');
    assert.ok(!entry.steers[0].includes('someone@private-mail.test'), 'redaction applies to the typed text');
    assert.ok(entry.steers[0].startsWith('no, mail the summary'));
    assert.equal(entry.redirects.length, 1, 'a redirect reads the typed text too');
  });
});

test('a coordinator\'s first turn, then the person\'s wrapped turn far past the head: counted in the digest and on the page', async () => {
  await withRoot(async (root) => {
    writeSession(root, 'coordinated', [
      coordinatorOpens(`Task: fix the parser ${SUFFIX}`),
      skillLoader(),
      hookFeedback(),
      ...filler(120),
      compactSummary(),
      wrapped(`what's the status of the parser ${SUFFIX}`),
      say('Nearly done.'),
    ], { start: '2024-06-11T10:00:00.000Z' });
    const file = join(root, 'projects', 'p', 'coordinated.jsonl');

    const entries = await digestOf(root);
    assert.equal(entries.length, 1, 'the digest keeps the session');
    assert.deepEqual(entries[0].steers.map((s) => s.slice(0, 26)), ['what\'s the status of the p'], 'only the person\'s turn is a steer');

    const fu = firstUserMessage(file, undefined, { readSender: true });
    assert.equal(fu.byOther, undefined, 'the late turn is found past the head');
    assert.ok(fu.text.includes('what\'s the status'), 'the person\'s turn, not the coordinator\'s');
    const headOnly = firstUserMessage(file, 4096, { readSender: true });
    assert.equal(headOnly.timestamp, fu.timestamp, 'a smaller head finds the same turn');

    const config = { week: { timezone: 'UTC' }, repos: [{ label: 'your-project', path: PROJECT, resolvedPath: PROJECT, role: 'featured' }] };
    const sessions = deriveSessions({ config, weekStart: WEEK_START, weekEnd: WEEK_END, now: WEEK_END, projectsRoot: join(root, 'projects') });
    assert.equal(sessions.interactiveTotal, 1);
    assert.equal(sessions.projectTotals['your-project'], 1);
  });
});

test('unmarked arrays, skill instructions and hook feedback never make a session interactive', async () => {
  await withRoot(async (root) => {
    writeSession(root, 'no-person', [
      coordinatorOpens('Task: tidy the docs.'),
      skillLoader(),
      unmarkedArray('Looks like a prompt but carries no mark.'),
      hookFeedback(),
      ...filler(60),
      unmarkedArray('Another unmarked array, past the head.'),
      say('Done.'),
    ]);
    writeSession(root, 'unmarked-first', [unmarkedArray('An unmarked array first.'), say('Ok.')], { start: '2024-06-12T10:00:00.000Z' });
    assert.deepEqual(await digestOf(root), []);

    const fu = firstUserMessage(join(root, 'projects', 'p', 'no-person.jsonl'), undefined, { readSender: true });
    assert.equal(fu.byOther, true, 'no marked turn anywhere: still someone else\'s session');
  });
});

test('the count says it reads past the head, for a site that keeps its own copy of the rule', () => {
  assert.equal(READS_PAST_HEAD, true);
});

test('a first prompt is read past every leading reminder, not only the first', () => {
  assert.equal(isInteractiveFirstPrompt(`${REMINDER}\n${REMINDER}\n\nmerge`), true);
  assert.equal(isInteractiveFirstPrompt(`${REMINDER} ${REMINDER}`), false, 'nothing typed after them');
  assert.equal(isInteractiveFirstPrompt(`${REMINDER}\n${REMINDER}\nProject: status check`), false, 'a probe behind them stays a probe');
});
