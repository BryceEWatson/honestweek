// test/turn-origin-readers.test.mjs: a turn a program, a task or another session sent into a
// Claude Code session is not the person's, in every reader outside the work-history engine:
// the digest adapter (interactive sessions, steers, redirects), the prompts scan and its
// store, the digest's evidence scan, and the miner (first prompt, human events). Logs from
// before `turnOrigin` read byte for byte as they did before this change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { adaptSessions, sentByOther } from '../lib/claude-adapter.mjs';
import { runDigest } from '../lib/digest.mjs';
import { probeSession, streamSession } from '../lib/mine/corpus.mjs';
import { promptIdentity } from '../lib/prompt-identity.mjs';
import { createRedactor } from '../lib/redact.mjs';
import {
  NOW, ORIGINS, PROJECT, SUFFIX, WEEK_END, WEEK_START,
  bash, command, enqueue, readAll, readerConfig, result, say, user, writeLegacyCorpus, writeSession,
} from './fixtures/turn-origin-readers.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const LEGACY = new URL('./fixtures/turn-origin-readers-legacy.json', import.meta.url);
const sessionFile = (root, id) => join(root, 'projects', 'p', `${id}.jsonl`);

async function withRoot(fn) {
  const root = makeTempDir('hw-turn-origin-');
  try {
    return await fn(root);
  } finally {
    removeTempDir(root);
  }
}

test('sentByOther: only a record naming someone other than the person is someone else\'s', () => {
  const rec = (extra) => ({ type: 'user', message: { content: 'x' }, ...extra });
  assert.equal(sentByOther(rec({})), false, 'no field: an older log, read as before');
  assert.equal(sentByOther(rec(ORIGINS.human)), false);
  assert.equal(sentByOther(rec({ turnOrigin: 'human' })), false);
  assert.equal(sentByOther(rec({ origin: { kind: 'human' } })), false);
  assert.equal(sentByOther(rec({ turnOrigin: '' })), false);
  assert.equal(sentByOther(rec(ORIGINS.sdk)), true);
  assert.equal(sentByOther(rec(ORIGINS.task)), true);
  assert.equal(sentByOther(rec({ turnOrigin: 'task_notification' })), true);
  assert.equal(sentByOther(rec({ origin: { kind: 'task-notification' } })), true);
  assert.equal(sentByOther(rec(ORIGINS.peer)), true);
  assert.equal(sentByOther(rec(ORIGINS.coordinator)), true);
  assert.equal(sentByOther(rec({ turnOrigin: 'coordinator' })), true);
  assert.equal(sentByOther(rec({ turnOrigin: 'some-later-kind' })), true, 'a value this reader does not know: the weaker reading');
  assert.equal(sentByOther(rec({ turnOrigin: 'sdk', origin: { kind: 'human' } })), true, 'either field naming someone else is enough');
  assert.equal(sentByOther(null), false);
});

test('logs without turnOrigin read byte for byte as before, in every reader', async () => {
  await withRoot(async (root) => {
    writeLegacyCorpus(root);
    const got = `${JSON.stringify(await readAll(root), null, 2)}\n`;
    assert.equal(got, readFileSync(LEGACY, 'utf8'));
  });
});

/** One session per sender: the same plain-text turn, then a reply. */
function writeOneEach(root) {
  for (const [name, origin] of Object.entries(ORIGINS)) {
    writeSession(root, `only-${name}`, [user(`no, look at the ${name} retry path ${SUFFIX}`, origin), say('Looked.')]);
  }
}

test('digest: only the person\'s turns make a session interactive, and only theirs are steers or redirects', async () => {
  await withRoot(async (root) => {
    writeOneEach(root);
    writeSession(root, 'mixed', [
      user(`revert the parser change ${SUFFIX}`, ORIGINS.sdk),
      say('Reverted.'),
      user('<task-notification>\n<status>completed</status>\n</task-notification>', ORIGINS.task),
      user('<cross-session-message from="another session">stop and wait</cross-session-message>', ORIGINS.peer),
      user(`no, keep the parser change and add a test ${SUFFIX}`, ORIGINS.human),
      say('Added.'),
    ], { start: '2024-06-12T10:00:00.000Z' });
    const config = readerConfig(root);
    const entries = await adaptSessions({ config, weekStart: WEEK_START, weekEnd: WEEK_END, redactor: createRedactor(config), projectsRoot: join(root, 'projects') });
    assert.equal(entries.length, 2, 'the human session and the mixed one; a program, task, peer or coordinator alone is not interactive');
    const [human, mixed] = entries;
    assert.deepEqual(human.steers, [`no, look at the human retry path ${SUFFIX}`]);
    assert.deepEqual(human.redirects, [`no, look at the human retry path ${SUFFIX}`]);
    assert.deepEqual(mixed.steers, [`no, keep the parser change and add a test ${SUFFIX}`]);
    assert.equal(mixed.redirects.length, 1);
    assert.match(mixed.redirects[0], /^no, keep the parser change/);
  });
});

test('digest: a program can open a session the person types into past the head, and it still counts', async () => {
  await withRoot(async (root) => {
    const filler = Array.from({ length: 40 }, (_, i) => say(`step ${i} ${'x'.repeat(2000)}`));
    writeSession(root, 'late-person', [user(`run the nightly review ${SUFFIX}`, ORIGINS.sdk), ...filler, user(`thanks, now fix the first finding ${SUFFIX}`, ORIGINS.human)]);
    writeSession(root, 'program-only-long', [user(`run the nightly review ${SUFFIX}`, ORIGINS.sdk), ...filler], { start: '2024-06-12T10:00:00.000Z' });
    const config = readerConfig(root);
    const entries = await adaptSessions({ config, weekStart: WEEK_START, weekEnd: WEEK_END, redactor: createRedactor(config), projectsRoot: join(root, 'projects') });
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].steers, [`thanks, now fix the first finding ${SUFFIX}`]);
    assert.equal(probeSession('claude-code', sessionFile(root, 'late-person')).firstPrompt, `thanks, now fix the first finding ${SUFFIX}`);
    assert.equal(probeSession('claude-code', sessionFile(root, 'program-only-long')), null);
  });
});

test('prompts: a program\'s turn is never a prompt, keeps its turn number, and is not a correction or the person\'s verification', async () => {
  await withRoot(async (root) => {
    writeOneEach(root);
    writeSession(root, 'mixed', [
      user(`look into why the parser drops the last line ${SUFFIX}`, ORIGINS.human),
      user(`actually, run the whole suite first ${SUFFIX}`, ORIGINS.sdk),
      bash('t1', 'node --test'),
      result('t1', '4 tests passed'),
      user(`now fix the last line handling ${SUFFIX}`, ORIGINS.human),
      say('Fixed.'),
    ], { start: '2024-06-12T10:00:00.000Z' });
    const { prompts, store } = await readAll(root);
    const ours = prompts.prompts.filter((p) => p.sessionKey === promptIdentity('claude-code', 'mixed', 1).sessionKey);
    assert.deepEqual(ours.map((p) => p.turn), [1, 3], 'the program\'s turn keeps number 2, so the person\'s refs do not move');
    assert.equal(ours[1].ref, promptIdentity('claude-code', 'mixed', 3).ref);
    const first = store.prompts.find((p) => p.ref === ours[0].ref);
    assert.equal(first.followOnCorrection, false, 'the program\'s "actually" is not the person correcting');
    assert.equal(first.observedVerification, false, 'the test run belongs to the program\'s turn');
    const only = prompts.prompts.filter((p) => p.sessionKey !== ours[0].sessionKey);
    assert.deepEqual(only.map((p) => p.sessionKey), [promptIdentity('claude-code', 'only-human', 1).sessionKey]);
  });
});

test('digest prepare: a program\'s labelled lines are not evidence, and the scan does not trip on its missing prompt', async () => {
  await withRoot(async (root) => {
    writeSession(root, 'mixed', [
      user(`Decision: ship the parser rewrite today ${SUFFIX}`, ORIGINS.sdk),
      say(`Decision: the program asked for the rewrite ${SUFFIX}`),
      user(`please check the parser rewrite ${SUFFIX}\nidea: keep a fixture per dialect ${SUFFIX}`, ORIGINS.human),
      bash('t1', 'node --test'),
      result('t1', '4 tests passed'),
      say(`Next step: add the dialect fixtures ${SUFFIX}`),
    ]);
    const { evidence } = await readAll(root);
    assert.equal(evidence.accounting.scannedPromptCount, 1);
    assert.deepEqual(evidence.evidence.map((e) => e.turn), [2, 2]);
    assert.ok(evidence.evidence.every((e) => !/rewrite today|program asked/.test(JSON.stringify(e))));

    writeFileSync(join(root, 'honestweek.config.json'), JSON.stringify({
      identity: { authorEmails: ['you@example.com'] },
      week: { startsOn: 'monday', timezone: 'UTC' },
      repos: [{ path: PROJECT, label: 'your-project', role: 'featured' }],
      redaction: { codenames: [], names: [], terms: [] },
      output: { mode: 'page', file: join(root, 'report.html') },
    }));
    writeFileSync(join(root, 'honestweek.items.json'), JSON.stringify({ week: { start: '2024-06-10', end: '2024-06-16' }, items: [] }));
    let stderr = '';
    const io = { out: () => {}, err: (s) => { stderr += s; }, exit: (c) => c };
    const roots = { 'claude-code': join(root, 'projects'), codex: join(root, 'no-codex') };
    assert.equal(await runDigest({ cwd: root, argv: ['prepare'], now: NOW, roots, io }), 0, stderr);
  });
});

test('mine: a program\'s turn is never the first prompt or a human event, even when a queue record carried it', async () => {
  await withRoot(async (root) => {
    writeOneEach(root);
    const programText = `run the nightly review ${SUFFIX}`;
    const personText = `thanks, now fix the first finding ${SUFFIX}`;
    writeSession(root, 'queued', [
      enqueue(programText),
      user(programText, ORIGINS.sdk),
      say('Reviewed.'),
      enqueue(personText),
      user(personText, ORIGINS.human),
      say('Fixed.'),
    ]);
    for (const name of ['sdk', 'task', 'peer', 'coordinator']) assert.equal(probeSession('claude-code', sessionFile(root, `only-${name}`)), null, name);
    assert.match(probeSession('claude-code', sessionFile(root, 'only-human')).firstPrompt, /^no, look at the human/);

    const probe = probeSession('claude-code', sessionFile(root, 'queued'));
    assert.equal(probe.firstPrompt, personText);
    assert.equal(probe.firstPromptISO, '2024-06-11T10:03:00.000Z', 'the person\'s queue record, as an old log reads');

    const { events } = await streamSession('claude-code', sessionFile(root, 'queued'));
    const human = events.filter((e) => e.kind === 'human').map((e) => e.text);
    assert.deepEqual(human, [personText, personText], 'the person\'s queue record and its delivery, as before; none of the program\'s');
    const sdk = await streamSession('claude-code', sessionFile(root, 'only-sdk'));
    assert.equal(sdk.events.filter((e) => e.kind === 'human').length, 0);
  });
});

test('mine: a program-opened session reads past the default head to the person\'s first turn', async () => {
  await withRoot(async (root) => {
    const filler = Array.from({ length: 60 }, (_, i) => say(`step ${i} ${'x'.repeat(2000)}`));
    writeSession(root, 'late', [enqueue('run the nightly review'), user('run the nightly review', ORIGINS.sdk), ...filler, user('fix the first finding', ORIGINS.human)]);
    assert.equal(probeSession('claude-code', sessionFile(root, 'late')).firstPrompt, 'fix the first finding');
  });
});

test('commands a program sends stay out of every reader, as a person\'s commands already do', async () => {
  await withRoot(async (root) => {
    writeSession(root, 'program-command', [{ ...command('review'), ...ORIGINS.sdk }, say('Reviewed.')]);
    const reading = await readAll(root);
    assert.equal(reading.digest.length, 0);
    assert.equal(reading.prompts.prompts.length, 0);
    assert.equal(reading.mine['program-command'].probe, null);
  });
});
