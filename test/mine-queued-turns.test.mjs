// test/mine-queued-turns.test.mjs: a turn typed while the agent was busy is logged twice in
// Claude Code, as a queue record and then as the record that delivers it (a user record, or
// a mid-turn note when the agent takes it in mid-turn). The miner counts it once, as the
// delivery, because the delivery says who sent it. Every session here is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { probeSession, streamSession } from '../lib/mine/corpus.mjs';
import { extractFeatures } from '../lib/mine/detect.mjs';
import { ORIGINS, enqueue, say, user, writeSession } from './fixtures/turn-origin-readers.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const absorbed = (content) => ({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content });
const note = (prompt, kind) => ({ type: 'attachment', attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind } } });

async function read(records) {
  const root = makeTempDir('hw-mine-queued-');
  try {
    writeSession(root, 's', records);
    const { events } = await streamSession('claude-code', join(root, 'projects', 'p', 's.jsonl'));
    return events;
  } finally {
    removeTempDir(root);
  }
}
const humans = (events) => events.filter((e) => e.kind === 'human').map((e) => e.text);

test('mine: a queued turn and its delivery are one human turn, and only the person\'s count', async () => {
  const peerNote = '<agent-message from="helper">the build is green</agent-message>';
  const peerWrapped = '<cross-session-message from="another session">a note from elsewhere</cross-session-message>';
  const events = await read([
    enqueue('look at the parser'), say('Working.'), user('look at the parser', ORIGINS.human), say('Looked.'),
    enqueue('now the lexer'), user('now the lexer', ORIGINS.human), say('Done.'),
    enqueue('and the docs'), user('and the docs', ORIGINS.human), say('Done.'),
    user('thanks, run the tests', ORIGINS.human), say('Ran them.'),
    // Delivered with a line the person added.
    enqueue('fix the flaky one'), user('fix the flaky one\nand say which test it was', ORIGINS.human), say('Fixed.'),
    // Taken in mid-turn: no user record, a note says who sent it.
    enqueue('also check the timeout path'), absorbed('also check the timeout path'), note('also check the timeout path', 'human'), say('Checked.'),
    enqueue(peerNote), absorbed(peerNote), note(peerNote, 'peer'),
    // Another session's message, delivered wrapped in a line about where it came from.
    enqueue(peerWrapped), user(`A message from another session:\n${peerWrapped}\nReply only if needed.`, ORIGINS.peer),
    enqueue('run the nightly review'), user('run the nightly review', ORIGINS.sdk), say('Reviewed.'),
    // Queued and never delivered: the session ended first.
    enqueue('one more thing before you stop'), say('Stopping.'),
  ]);
  assert.deepEqual(humans(events), [
    'look at the parser',
    'now the lexer',
    'and the docs',
    'thanks, run the tests',
    'fix the flaky one\nand say which test it was',
    'also check the timeout path',
    'one more thing before you stop',
  ]);
  // The code before this change read 12 here: each delivered turn twice, and the queue
  // record of the other session's wrapped message as the person's.
  assert.equal(extractFeatures(events, { cwd: '/work/your-project' }).humanTurns, 7);
});

test('mine: the copy that counts is the delivery, where the agent took it in', async () => {
  const delivered = await read([enqueue('look at the parser'), say('Working.'), user('look at the parser', ORIGINS.human), say('Looked.')]);
  assert.deepEqual(delivered.map((e) => e.kind), ['assistant', 'human', 'assistant']);
  const midTurn = await read([enqueue('check the timeout'), say('Working.'), absorbed('check the timeout'), note('check the timeout', 'human'), say('Checked.')]);
  assert.deepEqual(midTurn.map((e) => e.kind), ['assistant', 'human', 'assistant']);
  const never = await read([enqueue('one more thing'), say('Stopping.')]);
  assert.deepEqual(never.map((e) => e.kind), ['human', 'assistant'], 'never delivered: its queue record stands in');
});

test('mine: a delivery delivers a queued turn only by its exact text or the text plus added lines', async () => {
  const added = await read([enqueue('yes'), user('yes\nand fix the second one too', ORIGINS.human)]);
  assert.deepEqual(humans(added), ['yes\nand fix the second one too']);
  const another = await read([enqueue('yes'), say('Stopping.'), user('yes please fix the second one', ORIGINS.human)]);
  assert.deepEqual(humans(another), ['yes', 'yes please fix the second one'], 'a longer sentence is a new turn');
  const twice = await read([
    enqueue('yes'), user('yes', ORIGINS.human), say('Done.'),
    enqueue('yes'), absorbed('yes'), note('yes', 'human'), say('Done again.'),
  ]);
  assert.deepEqual(humans(twice), ['yes', 'yes'], 'the same text queued twice is two turns');
  const quoted = await read([
    enqueue('yes'), user('A message from another session:\nthe reviewer says yes to it', ORIGINS.peer),
    note('yes', 'human'), say('Done.'),
  ]);
  assert.deepEqual(humans(quoted), ['yes'], 'another session\'s message clears a queued text only when it holds it on lines of its own');
});

test('mine: a session only another session queued into has no first prompt and no human turn', async () => {
  const peer = '<agent-message from="helper">the build is green</agent-message>';
  const root = makeTempDir('hw-mine-queued-');
  try {
    writeSession(root, 'peer-only', [enqueue(peer), absorbed(peer), note(peer, 'peer'), say('Noted.')]);
    const file = join(root, 'projects', 'p', 'peer-only.jsonl');
    assert.equal(probeSession('claude-code', file), null);
    assert.deepEqual(humans((await streamSession('claude-code', file)).events), []);
  } finally {
    removeTempDir(root);
  }
});

test('mine: a log without sender marks counts a queued turn and its delivery once', async () => {
  const events = await read([enqueue('look at the parser'), user('look at the parser'), say('Looked.'), enqueue('also the lexer'), say('Stopping.')]);
  assert.deepEqual(humans(events), ['look at the parser', 'also the lexer']);
});
