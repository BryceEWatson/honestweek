// The site's session count can read who sent a session's first turn. Current Claude Code marks
// each user record with `turnOrigin` ("human" when it came from the person's own session, typed or pasted, "sdk" when a program
// sent it, other values for a task's notice or another session) and sometimes an `origin`
// object. Unless the config sets `output.skipProgramSessions` to false, a session someone else
// opened counts only from the first later turn marked as the person's. A published weekly number
// depends on this count, so the reading before this rule existed is pinned byte for byte: with
// the switch set to false for every log, and by default for logs that carry neither field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSessions, firstUserMessage, READS_TURN_SENDER } from '../lib/site/sessions.mjs';
import { loadConfig } from '../lib/config.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';
import { WEEK_START, WEEK_END, NOW, siteConfig, writeLogs, LEGACY_LOGS, MARKED_LOGS } from './fixtures/site-sessions-turn-origin.mjs';

const BEFORE = JSON.parse(readFileSync(new URL('./fixtures/site-sessions-legacy-reading.json', import.meta.url), 'utf8'));
const serialize = (v) => JSON.stringify(v, null, 2);

const ON = { ...siteConfig(), output: { mode: 'site', skipProgramSessions: true } };
const OFF = { ...siteConfig(), output: { mode: 'site', skipProgramSessions: false } };
const derive = (root, config = siteConfig()) => deriveSessions({ config, weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW, projectsRoot: root });

function withLogs(logs, fn) {
  const root = makeTempDir('hw-site-origin-');
  try {
    writeLogs(root, logs);
    return fn(root);
  } finally {
    removeTempDir(root);
  }
}

test('set to false: every log, marked or not, counts byte for byte as before', () => {
  withLogs(LEGACY_LOGS, (root) => assert.equal(serialize(derive(root, OFF)), serialize(BEFORE.legacyLogs)));
  withLogs(MARKED_LOGS, (root) => assert.equal(serialize(derive(root, OFF)), serialize(BEFORE.markedLogs)));
});

test('by default: logs without turnOrigin or origin count byte for byte as before', () => {
  withLogs(LEGACY_LOGS, (root) => {
    assert.equal(serialize(derive(root)), serialize(BEFORE.legacyLogs));
    assert.equal(serialize(derive(root, ON)), serialize(BEFORE.legacyLogs), 'true is the default');
  });
});

test('the pins cover the cases a first-turn change could move', () => {
  assert.equal(BEFORE.legacyLogs.total, 6);
  assert.equal(BEFORE.legacyLogs.automatedExcluded, 4, 'a probe or a tool result first stays excluded, though a real prompt follows it');
  assert.equal(BEFORE.legacyLogs.undetermined, 2);
  assert.equal(BEFORE.legacyLogs.duplicatesSkipped, 1);
  assert.equal(BEFORE.markedLogs.total, 10, 'before, a program\'s first turn counted like the person\'s');
  withLogs(LEGACY_LOGS, (root) => {
    const probeFirst = firstUserMessage(join(root, 'proj', 'l04.jsonl'), undefined, { readSender: true });
    assert.equal(probeFirst.timestamp, '2024-06-13T08:00:00Z', 'an unmarked first record is the first turn, as before');
    assert.equal('byOther' in probeFirst, false, 'the result has no new key without the field');
  });
});

test('by default: a session someone else opened counts only from a turn marked as the person\'s', () => {
  withLogs(MARKED_LOGS, (root) => {
    const s = derive(root);
    assert.equal(serialize(derive(root, ON)), serialize(s), 'true is the default');
    assert.notEqual(serialize(s), serialize(BEFORE.markedLogs), 'logs that record who sent a turn count differently than before');
    assert.equal(s.total, 3, 'm01 and m02 are the person\'s; m09 opened by a program, with a turn from the person later');
    assert.equal(s.automatedExcluded, 7, 'm03 to m08 have no turn of the person\'s; m11\'s turn is a probe');
    assert.equal(s.duplicatesSkipped, 1, 'm10 resumes m09 and dedupes on the person\'s turn');
    assert.equal(s.undetermined, 0);
    const byDay = Object.fromEntries(s.days.filter((d) => d.total).map((d) => [d.date, d.byProject]));
    assert.deepEqual(byDay, { '2024-06-11': { alpha: 1, beta: 1 }, '2024-06-13': { beta: 1 } }, 'm09 counts on the day of the person\'s turn, not the day the program opened it');
    assert.deepEqual(s.projectTotals, { alpha: 1, beta: 2 });
  });
});

test('by default, legacy and marked logs together: each set counts as it does alone', () => {
  withLogs([...LEGACY_LOGS, ...MARKED_LOGS], (root) => {
    const s = derive(root);
    assert.equal(s.total, BEFORE.legacyLogs.total + 3);
    assert.equal(s.automatedExcluded, BEFORE.legacyLogs.automatedExcluded + 7);
    assert.equal(s.duplicatesSkipped, BEFORE.legacyLogs.duplicatesSkipped + 1);
    assert.equal(s.undetermined, BEFORE.legacyLogs.undetermined);
  });
});

test('firstUserMessage: the person\'s first marked turn, or byOther when the head has none', () => {
  withLogs(MARKED_LOGS, (root) => {
    const file = (name) => join(root, 'proj', `${name}.jsonl`);
    const first = (name, maxBytes) => firstUserMessage(file(name), maxBytes, { readSender: true });
    const later = first('m09');
    assert.equal(later.timestamp, '2024-06-13T09:15:00Z');
    assert.equal(later.cwd, '/work/beta', 'the session cwd comes from the first record that carries one');
    assert.equal(later.byOther, undefined);

    const program = first('m03');
    assert.equal(program.byOther, true);
    assert.equal(program.timestamp, '2024-06-11T11:00:00Z');

    assert.equal(first('m08').byOther, true, 'an unmarked record after a program\'s turn is not the person\'s');
    assert.equal(first('m01').byOther, undefined);
    assert.equal(first('m02').byOther, undefined, 'an empty turnOrigin reads as no mark');

    const headOnly = Buffer.byteLength(readFileSync(file('m10'), 'utf8').split('\n')[0]) + 1;
    assert.equal(first('m10', headOnly).byOther, true, 'a person\'s turn past the head is not seen');

    assert.equal(firstUserMessage(file('m03')).byOther, undefined, 'without readSender, a program\'s first turn reads as before');
  });
});

test('config: output.skipProgramSessions is a boolean, and the parsed config only carries it when false', () => {
  const dir = makeTempDir('hw-site-origin-cfg-');
  try {
    const load = (output) => {
      const file = join(dir, 'honestweek.config.json');
      writeFileSync(file, JSON.stringify({ identity: { authorEmails: ['you@example.com'] }, repos: [{ path: '/path/to/your/repo', label: 'your-project', role: 'featured' }], output: { mode: 'digest', ...output } }));
      return loadConfig(file).output;
    };
    assert.equal('skipProgramSessions' in load({}), false, 'absent: the parsed config is unchanged');
    assert.equal('skipProgramSessions' in load({ skipProgramSessions: true }), false, 'on is the default, so it reads as absent');
    assert.equal(load({ skipProgramSessions: false }).skipProgramSessions, false);
    assert.throws(() => load({ skipProgramSessions: 'yes' }), /skipProgramSessions/);
  } finally {
    removeTempDir(dir);
  }
});

test('the count says it reads who sent a turn, for a site that keeps its own copy of the rule', () => {
  assert.equal(READS_TURN_SENDER, true);
});
