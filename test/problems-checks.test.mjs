// The problem checks (lib/problems/checks.mjs) on made-up histories, each with a failing
// partner: the same shape with the one fact changed that should keep the check quiet. The
// histories are built by hand in the engine's event shape, so a check is tested on exactly the
// facts it reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOTHING_TO_CHECK, runProblems, priorityOf } from '../lib/problems/index.mjs';
import { CHECKS, runChecks } from '../lib/problems/checks.mjs';
import { createContext } from '../lib/problems/context.mjs';

const T0 = Date.parse('2025-03-10T09:00:00.000Z');
const WINDOW = { from: '2025-03-10', to: '2025-03-16', timezone: 'UTC', startAt: '2025-03-10T00:00:00.000Z', endAt: '2025-03-17T00:00:00.000Z', startT: Date.parse('2025-03-10T00:00:00.000Z'), endT: Date.parse('2025-03-17T00:00:00.000Z') };
const CWD = '/work/your-project';
const BUILT = Date.parse('2025-03-20T00:00:00.000Z');
const min = (m, s = 0) => T0 + m * 60e3 + s * 1e3;

/** A history in the engine's shape, written step by step. */
function history() {
  const sessions = [];
  const agents = [];
  const events = [];
  const calls = [];
  const cwd = new Map();
  const lines = new Map();
  let lookupSessions = [];
  const nextLine = (src) => {
    const n = (lines.get(src) ?? 0) + 1;
    lines.set(src, n);
    return n;
  };
  const api = {
    session(key, { tool = 'claude-code', priv = false, endState = 'last-turn-ended', lastAt = '2025-03-10T12:00:00.000Z' } = {}) {
      sessions.push({ key, tool, private: priv, repo: priv ? null : 'your-project', repoRole: priv ? 'display' : 'featured', endState, firstAt: '2025-03-10T09:00:00.000Z', lastAt, thread: `th-${key}` });
      agents.push({ key: `${key}:main`, session: key, kind: 'main' });
      cwd.set(key, CWD);
      return api;
    },
    agent(key, session, extra = {}) {
      agents.push({ key, session, kind: 'subagent', ...extra });
      cwd.set(key, CWD);
      return api;
    },
    /** One event; `raw` and `command` sit on the event's in-memory fields as the engine's keepRaw leaves them. */
    ev(kind, session, t, { agent = `${session}:main`, src = agent.endsWith(':main') ? session : agent, actor = kind === 'prompt' ? 'person' : 'agent', facts = {}, derived = {}, inferred = [], end = null, raw = null, command = null } = {}) {
      const line = nextLine(src);
      const e = { id: `${src}.${line}.0`, kind, t, at: new Date(t).toISOString(), source: src, session, agent, actor, evidence: 'recorded', refs: [{ src, line }], facts, derived, inferred, missing: [] };
      if (end) {
        const endLine = nextLine(src);
        e.end = { t: end.t, at: new Date(end.t).toISOString(), ref: { src, line: endLine } };
      }
      if (raw) Object.defineProperty(e, '_raw', { value: raw, enumerable: false });
      if (command != null) Object.defineProperty(e, '_command', { value: command, enumerable: false });
      events.push(e);
      return e;
    },
    prompt: (session, t, text, extra = {}) => api.ev('prompt', session, t, { facts: { text }, raw: { text }, ...extra }),
    say: (session, t, text, extra = {}) => api.ev('message', session, t, { facts: { text }, raw: { text }, ...extra }),
    shell(session, t, command, { result = 'ok', tests = null, error = null, agent, inferred = [], git } = {}) {
      const runner = /node --test|npm test|pytest/.test(command) ? 'node --test' : null;
      return api.ev('action', session, t, { agent, facts: { tool: 'Bash', category: 'shell', command, result, ...(runner ? { testRunner: runner } : {}), ...(git ? { git } : {}) }, derived: tests ? { tests } : {}, inferred, end: { t: t + 2000 }, raw: { input: { command }, tool: 'Bash', ...(error ? { error } : {}) }, command });
    },
    edit(session, t, file, oldS, newS, { result = 'ok', error = null, agent, tool = 'Edit' } = {}) {
      const input = tool === 'Write' ? { file_path: file, content: newS } : { file_path: file, old_string: oldS, new_string: newS };
      return api.ev('action', session, t, { agent, facts: { tool, category: 'edit', result, fileKey: `fk-${file}` }, end: { t: t + 500 }, raw: { input, tool, ...(error ? { error } : {}) } });
    },
    read(session, t, file, { offset, limit, agent } = {}) {
      return api.ev('action', session, t, { agent, facts: { tool: 'Read', category: 'read', result: 'ok', fileKey: `fk-${file}` }, end: { t: t + 300 }, raw: { input: { file_path: file, ...(offset != null ? { offset } : {}), ...(limit != null ? { limit } : {}) }, tool: 'Read' } });
    },
    call(agent, session, line, t, ctx, output = 100) {
      calls.push({ session, agent, source: agent.endsWith(':main') ? session : agent, tool: 'claude-code', lines: [line], t, input: 10, cacheWrite: 0, cacheRead: ctx - 10, output });
      return api;
    },
    lookup(list) {
      lookupSessions = list;
      return api;
    },
    build({ usage = false } = {}) {
      events.sort((a, b) => a.t - b.t);
      const h = { window: WINDOW, sessions, agents, events, lookup: () => ({ sessions: lookupSessions.map((s) => ({ session: s })) }) };
      if (usage) h.usage = { calls };
      Object.defineProperty(h, '_raw', { value: { cwdOfSource: cwd }, enumerable: false });
      return h;
    },
  };
  return api;
}

const run = (h) => runProblems(h, { builtT: BUILT });
const check = (r, id) => r.checks.find((c) => c.id === id);
const findingsOf = (r, patternId) => r.patterns.find((p) => p.id === patternId).findings;
const looks = (r, patternId) => findingsOf(r, patternId).filter((f) => f.severity === 'look');

// ---- correctness and honesty ---------------------------------------------------------------

test('says done without checking: a flat claim after edits with no check after the last edit is worth a look', () => {
  const make = (afterEdit) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Make the parser handle tabs.');
    h.edit('s1', min(1), `${CWD}/src/parse.js`, 'a', 'b');
    afterEdit(h);
    return run(h.build());
  };
  const flagged = make((h) => h.say('s1', min(3), 'Done. The parser handles tabs now.'));
  assert.equal(looks(flagged, 'unverified-done-claim').length, 1);
  assert.equal(looks(flagged, 'unverified-done-claim')[0].verdictEvidence, 'inferred');
  // Failing partner: a test run after the last edit.
  const checked = make((h) => {
    h.shell('s1', min(2), 'node --test', { tests: { pass: 3, fail: 0 } });
    h.say('s1', min(3), 'Done. The parser handles tabs now.');
  });
  assert.equal(findingsOf(checked, 'unverified-done-claim').length, 0);
  // A hedged claim is a routine note; saying what wasn't run isn't a finding.
  const hedged = make((h) => h.say('s1', min(3), 'That should work now.'));
  assert.deepEqual(findingsOf(hedged, 'unverified-done-claim').map((f) => f.severity), ['note']);
  const honest = make((h) => h.say('s1', min(3), "Done, but I didn't run the tests."));
  assert.equal(findingsOf(honest, 'unverified-done-claim').length, 0);
});

test('says done without checking: a landed pull request with no test run in its sessions', () => {
  const make = (withRun) => {
    const h = history().session('s1').lookup(['s1']);
    h.prompt('s1', min(0), 'Merge it.');
    if (withRun) h.shell('s1', min(1), 'node --test', { tests: { pass: 2, fail: 0 } });
    h.ev('outcome', 's1', min(2), { actor: 'git', facts: { outcome: 'pr-landed', pr: 12, repo: 'your-project' } });
    return run(h.build());
  };
  assert.equal(findingsOf(make(false), 'unverified-done-claim').filter((f) => f.check === 'pr-landed-without-tests').length, 1);
  assert.equal(findingsOf(make(true), 'unverified-done-claim').filter((f) => f.check === 'pr-landed-without-tests').length, 0);
  // A pull request that landed after the window, in a session that started inside it, isn't this window's.
  const late = history().session('s1').lookup(['s1']);
  late.prompt('s1', min(0), 'Merge it.');
  late.ev('outcome', 's1', Date.parse('2025-03-18T10:00:00.000Z'), { actor: 'git', facts: { outcome: 'pr-landed', pr: 13, repo: 'your-project' } });
  const lr = run(late.build());
  assert.equal(findingsOf(lr, 'unverified-done-claim').filter((f) => f.check === 'pr-landed-without-tests').length, 0);
  assert.match(check(lr, 'pr-landed-without-tests').checked, /^0 landed pull requests/);
});

test('a success claim after a failed check, and a commit right after a failed run', () => {
  const make = (lastPasses) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Fix the wrap test.');
    h.edit('s1', min(1), `${CWD}/src/wrap.js`, 'a', 'b');
    h.shell('s1', min(2), 'node --test', { result: lastPasses ? 'ok' : 'error', tests: lastPasses ? { pass: 3, fail: 0 } : { pass: 2, fail: 1 } });
    h.shell('s1', min(3), 'git commit -m "Fix wrap"', { git: { commit: { sha: 'abc1234def56' } } });
    h.say('s1', min(4), 'All tests pass.');
    return run(h.build());
  };
  const bad = make(false);
  const claims = findingsOf(bad, 'claim-contradicts-evidence');
  assert.deepEqual(claims.map((f) => f.check).sort(), ['claim-contradicts-evidence', 'commit-after-failed-test']);
  assert.ok(claims.every((f) => f.severity === 'look'));
  assert.ok(claims.find((f) => f.check === 'claim-contradicts-evidence').related, 'it links the failed check');
  assert.equal(findingsOf(make(true), 'claim-contradicts-evidence').length, 0);
});

test('a commit after a failed run records exactly the steps it matched: the run, the commit and the commits it counts after it', () => {
  const make = (later) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Ship the wrap fix.');
    const failed = h.shell('s1', min(1), 'node --test', { result: 'error', tests: { pass: 2, fail: 1 } });
    h.edit('s1', min(2), `${CWD}/src/wrap.js`, 'a', 'b');
    const commits = [0, ...Array.from({ length: later }, (_, i) => i + 1)].map((i) => h.shell('s1', min(3 + i), `git commit -m "Step ${i}"`, { git: { commit: { sha: `abc1234def5${i}` } } }));
    h.say('s1', min(9), 'Committed.');
    const f = findingsOf(run(h.build()), 'claim-contradicts-evidence').filter((x) => x.check === 'commit-after-failed-test');
    return { f, failed, commits };
  };
  const two = make(2);
  assert.equal(two.f.length, 1);
  assert.deepEqual(two.f[0].events, [two.failed.id, ...two.commits.map((e) => e.id)], 'the failed run, the commit and the two after it, never the edit between');
  assert.equal(two.f[0].steps, 4);
  // With no later commit the finding is as it was: the commit and the failed run, no list.
  const one = make(0);
  assert.equal(one.f.length, 1);
  assert.ok(!('events' in one.f[0]) && !('steps' in one.f[0]), 'unchanged when nothing more was matched');
  assert.deepEqual([one.f[0].related, one.f[0].event], [one.failed.id, one.commits[0].id]);
});

test('the same call repeated records exactly its matching calls, never the edit after them', () => {
  const h = history().session('s1');
  h.prompt('s1', min(0), 'Build it.');
  const calls = [1, 2, 3].map((m) => h.shell('s1', min(m), 'npm run build', { result: 'error' }));
  h.edit('s1', min(4), `${CWD}/src/a.js`, 'a', 'b');
  const loop = findingsOf(run(h.build()), 'action-loop').find((f) => f.kind === 'same call repeated');
  assert.deepEqual(loop.events, calls.map((e) => e.id));
});

test('tests weakened: an assertion removed is worth a look; an assertion added is not; a prompt about tests makes it a note', () => {
  const make = (oldS, newS, prompt = 'Fix the date bug.') => {
    const h = history().session('s1');
    h.prompt('s1', min(0), prompt);
    h.edit('s1', min(1), `${CWD}/test/date.test.js`, oldS, newS);
    return run(h.build());
  };
  const two = 'expect(a).toBe(1);\nexpect(b).toBe(2);';
  const one = 'expect(a).toBe(1);';
  assert.equal(looks(make(two, one), 'test-tampering').length, 1);
  assert.equal(findingsOf(make(one, two), 'test-tampering').length, 0);
  assert.equal(findingsOf(make(two, `${one}\nit.skip('b', () => {});`), 'test-tampering').length, 1);
  assert.deepEqual(findingsOf(make(two, one, 'Update the tests for the new date format.'), 'test-tampering').map((f) => f.severity), ['note']);
});

// ---- efficiency and cost -------------------------------------------------------------------

test('the same call repeated with nothing changed; an edit between keeps it quiet', () => {
  const make = (editBetween) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Build it.');
    h.shell('s1', min(1), 'npm run build', { result: 'error' });
    h.shell('s1', min(2), 'npm run build', { result: 'error' });
    if (editBetween) h.edit('s1', min(2, 30), `${CWD}/src/a.js`, 'a', 'b');
    h.shell('s1', min(3), 'npm run build', { result: 'error' });
    return run(h.build());
  };
  const loop = findingsOf(make(false), 'action-loop');
  assert.equal(loop.length, 1);
  assert.equal(loop[0].kind, 'same call repeated');
  assert.equal(loop[0].steps, 3);
  assert.equal(findingsOf(make(true), 'action-loop').filter((f) => f.kind === 'same call repeated').length, 0);
});

test('a failed command run again unchanged twice, and an edit undone and redone', () => {
  const h = history().session('s1');
  h.prompt('s1', min(0), 'Go.');
  h.shell('s1', min(1), 'make deploy', { result: 'error' });
  h.shell('s1', min(2), 'make deploy', { result: 'error' });
  h.edit('s1', min(3), `${CWD}/a.js`, 'x', 'y');
  h.edit('s1', min(4), `${CWD}/a.js`, 'y', 'x');
  h.edit('s1', min(5), `${CWD}/a.js`, 'x', 'y');
  const r = run(h.build());
  const kinds = findingsOf(r, 'action-loop').map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['edit undone and redone', 'failed command run again unchanged']);
  // Partner: a retry that succeeded the second time is one failure, not a churn.
  const p = history().session('s1');
  p.prompt('s1', min(0), 'Go.');
  p.shell('s1', min(1), 'make deploy', { result: 'error' });
  p.shell('s1', min(2), 'make deploy', { result: 'ok' });
  assert.equal(findingsOf(run(p.build()), 'action-loop').length, 0);
});

test('the same tool error again: two identical errors in a row; a success between keeps it quiet', () => {
  const make = (okBetween) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Edit it.');
    h.edit('s1', min(1), `${CWD}/a.js`, 'old', 'new', { result: 'error', error: 'String to replace not found in file.' });
    if (okBetween) h.edit('s1', min(1, 30), `${CWD}/a.js`, 'x', 'y');
    h.edit('s1', min(2), `${CWD}/a.js`, 'old2', 'new', { result: 'error', error: 'String to replace not found in file.' });
    return run(h.build());
  };
  const found = findingsOf(make(false), 'repeated-tool-error');
  assert.equal(found.length, 1);
  assert.match(found[0].note, /text to replace not found/);
  assert.equal(findingsOf(make(true), 'repeated-tool-error').length, 0);
});

test('small sub-agents: three in one session are worth a look; a busy one is not counted', () => {
  const make = (calls) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Look around.');
    for (let i = 1; i <= 3; i++) {
      const start = h.ev('action', 's1', min(i), { facts: { tool: 'Agent', category: 'delegate', result: 'ok' }, end: { t: min(i, 50) }, raw: { input: { description: `Explore area ${i} of the code`, prompt: 'x' }, tool: 'Agent' } });
      h.agent(`sa${i}`, 's1', { spawnedBy: start.id, completion: { at: 'x' } });
      for (let k = 0; k < calls; k++) h.read('s1', min(i, 10 + k), `${CWD}/f${i}${k}.js`, { agent: `sa${i}` });
    }
    return run(h.build());
  };
  const small = findingsOf(make(2), 'subagent-overuse').filter((f) => f.kind === 'small sub-agents');
  assert.equal(small.length, 1);
  assert.equal(small[0].severity, 'look');
  assert.equal(findingsOf(make(5), 'subagent-overuse').filter((f) => f.kind === 'small sub-agents').length, 0);
});

test('near-identical sub-agent briefs started in one turn', () => {
  const make = (second) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Review it.');
    h.ev('action', 's1', min(1), { facts: { tool: 'Agent', category: 'delegate', result: 'ok' }, raw: { input: { description: 'Review the parser change for edge cases' }, tool: 'Agent' } });
    h.ev('action', 's1', min(1, 1), { facts: { tool: 'Agent', category: 'delegate', result: 'ok' }, raw: { input: { description: second }, tool: 'Agent' } });
    return run(h.build());
  };
  assert.equal(findingsOf(make('Review the parser change for edge cases'), 'subagent-overuse').filter((f) => f.kind === 'near-identical briefs').length, 1);
  assert.equal(findingsOf(make('Write the release notes'), 'subagent-overuse').filter((f) => f.kind === 'near-identical briefs').length, 0);
});

test('a background sub-agent with no completion notice; one with a notice is quiet', () => {
  const make = (completion) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Check it.');
    const start = h.ev('action', 's1', min(1), { facts: { tool: 'Agent', category: 'delegate', result: 'ok' }, end: { t: min(1, 1) } });
    h.agent('bg1', 's1', { spawnedBy: start.id, requestShape: 'background', completion });
    return run(h.build());
  };
  assert.equal(looks(make(null), 'subagent-handoff-loss').length, 1);
  // The hand-back is absent from the logs: missing, the weakest level, never worked out from facts.
  assert.equal(looks(make(null), 'subagent-handoff-loss')[0].verdictEvidence, 'missing');
  assert.equal(make(null).patterns.find((p) => p.id === 'subagent-handoff-loss').countEvidence, 'missing');
  assert.equal(findingsOf(make({ at: 'x', status: 'completed' }), 'subagent-handoff-loss').length, 0);
  // In a session that may still be running, the sub-agent may still hand back: a note.
  const recent = history().session('s2', { lastAt: '2025-03-16T23:30:00.000Z' });
  recent.prompt('s2', min(0), 'Check it.');
  const start = recent.ev('action', 's2', min(1), { facts: { tool: 'Agent', category: 'delegate', result: 'ok' }, end: { t: min(1, 1) } });
  recent.agent('bg2', 's2', { spawnedBy: start.id, requestShape: 'background', completion: null });
  const rr = runProblems(recent.build(), { builtT: Date.parse('2025-03-16T23:59:00.000Z') });
  assert.deepEqual(findingsOf(rr, 'subagent-handoff-loss').map((f) => [f.severity, f.stillRunning]), [['note', true]]);
});

test('context past 150k: thirty more calls after crossing is worth a look; twenty-nine is not; no token counts means no check', () => {
  const make = (after) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Long work.');
    let line = 100;
    for (let i = 0; i < 5; i++) h.call('s1:main', 's1', line++, min(1, i), 20_000);
    for (let i = 0; i <= after; i++) h.call('s1:main', 's1', line++, min(2, i), 160_000);
    return run(h.build({ usage: true }));
  };
  const found = findingsOf(make(30), 'context-bloat');
  assert.equal(found.length, 1);
  assert.ok(found[0].estimate > 0);
  // It matched model calls, not steps: its one step is only the nearest, and says so.
  assert.equal(found[0].stepsNear, true);
  assert.ok(!found[0].events);
  assert.equal(findingsOf(make(29), 'context-bloat').length, 0);
  const none = history().session('s1');
  none.prompt('s1', min(0), 'x');
  const r = run(none.build());
  assert.equal(r.patterns.find((p) => p.id === 'context-bloat').status, 'unchecked');
  assert.match(check(r, 'long-sessions').notRun, /No token counts/);
});

test('a single step that grew the context by 20k tokens or more, with its carried cost', () => {
  const make = (grow) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Read it.');
    h.call('s1:main', 's1', 2, min(1), 30_000);
    const r = h.read('s1', min(1, 1), `${CWD}/big.log`);
    // The read's line sits in the first call's records; the next call reads its result.
    r.refs[0].line = 2;
    h.call('s1:main', 's1', r.end.ref.line + 1, min(2), 30_000 + grow);
    h.call('s1:main', 's1', r.end.ref.line + 2, min(3), 30_000 + grow + 100);
    return run(h.build({ usage: true }));
  };
  const big = findingsOf(make(25_000), 'oversized-tool-output');
  assert.equal(big.length, 1);
  assert.equal(big[0].kind, 'whole-file read');
  assert.equal(big[0].verdictEvidence, 'inferred', "charging the growth to one result is the cost.step rule's reading");
  // The growth less the issuing call's own 100 output tokens is carried by the later call.
  assert.ok(big[0].estimate >= 25_000 - 100, 'the growth is carried by the later call');
  assert.equal(findingsOf(make(5_000), 'oversized-tool-output').length, 0);
});

test("a call's own large output isn't charged to its small result", () => {
  const make = (output) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Write it.');
    h.call('s1:main', 's1', 2, min(1), 30_000, output);
    const r = h.read('s1', min(1, 1), `${CWD}/small.txt`);
    r.refs[0].line = 2;
    // The context grows by the first call's output plus 1k of result.
    h.call('s1:main', 's1', r.end.ref.line + 1, min(2), 30_000 + output + 1_000);
    h.call('s1:main', 's1', r.end.ref.line + 2, min(3), 30_000 + output + 1_100);
    return run(h.build({ usage: true }));
  };
  assert.equal(findingsOf(make(25_000), 'oversized-tool-output').length, 0, 'the 25k is the call writing, not the result');
  assert.equal(findingsOf(make(100), 'oversized-tool-output').length, 0);
});

test('a file read three times with no change between; an edit between starts over', () => {
  const make = (editBetween) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Look.');
    h.read('s1', min(1), `${CWD}/a.js`);
    h.read('s1', min(2), `${CWD}/a.js`);
    if (editBetween) h.edit('s1', min(2, 30), `${CWD}/a.js`, 'a', 'b');
    h.read('s1', min(3), `${CWD}/a.js`);
    return run(h.build());
  };
  assert.equal(looks(make(false), 'repeated-file-reads').length, 1);
  assert.equal(findingsOf(make(true), 'repeated-file-reads').length, 0);
});

test('the same status call three times with nothing changed; a push between starts over', () => {
  const make = (pushBetween) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Watch CI.');
    h.shell('s1', min(1), 'gh pr checks 12');
    h.shell('s1', min(2), 'gh pr checks 12');
    if (pushBetween) h.shell('s1', min(2, 30), 'git push origin feature/x');
    h.shell('s1', min(3), 'gh pr checks 12 | head -5');
    return run(h.build());
  };
  const found = looks(make(false), 'busy-polling');
  assert.equal(found.length, 1);
  assert.equal(found[0].verdictEvidence, 'inferred');
  assert.equal(findingsOf(make(true), 'busy-polling').length, 0);
});

// ---- process -------------------------------------------------------------------------------

test('edits after a question-only prompt; a request is not counted', () => {
  const make = (prompt) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), prompt);
    h.edit('s1', min(1), `${CWD}/src/a.js`, 'a', 'b');
    return run(h.build());
  };
  assert.equal(looks(make('Why does the parser drop tabs?'), 'scope-creep').length, 1);
  assert.equal(findingsOf(make('Can you fix the parser so it keeps tabs?'), 'scope-creep').length, 0);
  // An edit outside the session's folder isn't counted either.
  const h = history().session('s1');
  h.prompt('s1', min(0), 'Why does the parser drop tabs?');
  h.edit('s1', min(1), '/elsewhere/notes.md', 'a', 'b');
  assert.equal(findingsOf(run(h.build()), 'scope-creep').length, 0);
});

test('an edit while plan mode was on; the plan file itself and edits after the exit are fine', () => {
  const make = (file, exitFirst) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Plan the change.');
    h.ev('mode', 's1', min(0, 1), { actor: 'harness', facts: { change: 'plan_mode' } });
    if (exitFirst) h.ev('mode', 's1', min(0, 30), { actor: 'harness', facts: { change: 'plan_mode_exit' } });
    h.edit('s1', min(1), file, 'a', 'b');
    return run(h.build());
  };
  const found = looks(make(`${CWD}/src/a.js`, false), 'instruction-violation');
  assert.equal(found.length, 1);
  assert.equal(found[0].verdictEvidence, 'derived');
  assert.equal(findingsOf(make('/home/someone/.claude/plans/the-plan.md', false), 'instruction-violation').length, 0);
  assert.equal(findingsOf(make(`${CWD}/src/a.js`, true), 'instruction-violation').length, 0);
});

test('a session that ends on a call with no result; one that ends on a turn end is quiet', () => {
  const make = (endState) => {
    const h = history().session('s1', { endState });
    h.prompt('s1', min(0), 'Go.');
    h.shell('s1', min(1), 'npm test');
    return run(h.build());
  };
  assert.equal(looks(make('last-record-is-a-call-without-result'), 'premature-stop').length, 1);
  // The end state is the engine's, but reading it as an early stop is a proxy: inferred.
  assert.equal(looks(make('last-record-is-a-call-without-result'), 'premature-stop')[0].verdictEvidence, 'inferred');
  assert.equal(findingsOf(make('last-turn-ended'), 'premature-stop').length, 0);
  // A session that may still be running gets a note, not a look.
  const recent = history().session('s2', { endState: 'last-record-is-a-call-without-result', lastAt: '2025-03-16T23:30:00.000Z' });
  recent.prompt('s2', min(0), 'Go.');
  const rr = runProblems(recent.build(), { builtT: Date.parse('2025-03-16T23:59:00.000Z') });
  assert.deepEqual(findingsOf(rr, 'premature-stop').map((f) => [f.severity, f.stillRunning]), [['note', true]]);
});

test('a turn ending on a question, answered by a bare go-ahead after half an hour', () => {
  const make = (reply, inferred) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Draft the change.');
    h.say('s1', min(1), 'I have a plan.\nShall I go ahead?');
    h.prompt('s1', min(40), reply, { inferred });
    return run(h.build());
  };
  assert.equal(looks(make('yes, go', [{ key: 'intent', value: 'approval', rule: 'prompt.approval' }]), 'needless-check-in').length, 1);
  assert.equal(findingsOf(make('No, use the other reader instead.', [{ key: 'intent', value: 'correction', rule: 'prompt.correction' }]), 'needless-check-in').length, 0);
});

// ---- safety --------------------------------------------------------------------------------

test('a force-push and a skipped hook that ran; the same commands refused are quiet', () => {
  const make = (result) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), 'Push it.');
    h.shell('s1', min(1), 'git push --force origin feature/x', { result });
    h.shell('s1', min(2), 'git commit --no-verify -m "wip"', { result });
    return run(h.build());
  };
  const r = make('ok');
  assert.equal(looks(r, 'destructive-command').length, 1);
  assert.equal(looks(r, 'bypassing-safeguards').length, 1);
  const refused = make('refused');
  assert.equal(findingsOf(refused, 'destructive-command').length + findingsOf(refused, 'bypassing-safeguards').length, 0);
});

test('a secret-shaped key in a prompt is counted, never kept; a placeholder is not counted', () => {
  const KEY = `sk-${'a1B2c3D4e5F6g7H8i9J0'}`;
  const make = (text) => {
    const h = history().session('s1');
    h.prompt('s1', min(0), text);
    return run(h.build());
  };
  const r = make(`Use this key: ${KEY} for the call.`);
  const found = looks(r, 'secret-exposure');
  assert.equal(found.length, 1);
  assert.ok(!JSON.stringify(r).includes(KEY), 'the key itself is in no field of the result');
  assert.equal(findingsOf(make('Use $API_KEY from the environment.'), 'secret-exposure').length, 0);
});

// ---- what every check shares -----------------------------------------------------------------

test('display-only and outside sessions are never checked', () => {
  const h = history().session('p1', { priv: true, endState: 'last-record-is-a-call-without-result' });
  h.prompt('p1', min(0), 'Why does the parser drop tabs?');
  h.edit('p1', min(1), `${CWD}/src/a.js`, 'a', 'b');
  h.shell('p1', min(2), 'git push --force origin x');
  const r = run(h.build());
  assert.equal(r.patterns.reduce((n, p) => n + p.count, 0), 0);
  assert.equal(r.coverage.sessions.value, 0);
});

test('without the raw text, the checks that read it say they did not run, never that nothing was found', () => {
  const h = history().session('s1');
  h.ev('prompt', 's1', min(0), { facts: { text: 'x' } });
  const r = run(h.build());
  assert.equal(check(r, 'unverified-done-claim').ran, false);
  assert.equal(r.patterns.find((p) => p.id === 'unverified-done-claim').status, 'clear', 'the landed pull request check still ran');
  assert.equal(r.patterns.find((p) => p.id === 'scope-creep').status, 'unchecked');
});

test('no finding carries text from a log: notes are fixed words and numbers', () => {
  const SENTINEL = 'zebra-quokka-sentinel';
  const h = history().session('s1');
  h.prompt('s1', min(0), `Why does ${SENTINEL} fail?`);
  h.edit('s1', min(1), `${CWD}/src/${SENTINEL}.js`, `${SENTINEL} a`, `${SENTINEL} b`);
  h.shell('s1', min(2), `git push --force origin ${SENTINEL}`);
  h.shell('s1', min(3), `gh pr checks ${SENTINEL}`);
  h.shell('s1', min(4), `gh pr checks ${SENTINEL}`);
  h.shell('s1', min(5), `gh pr checks ${SENTINEL}`);
  h.say('s1', min(6), `Done with ${SENTINEL}. Shall I go ahead?`);
  const r = run(h.build());
  assert.ok(r.patterns.some((p) => p.count > 0), 'the made-up session has findings');
  const findings = JSON.stringify(r.patterns.map((p) => p.findings));
  assert.ok(!findings.includes(SENTINEL), 'no finding holds the session text');
});

test('priority: a check that needs nothing it lacks feeds the stated rule', () => {
  const h = history().session('s1', { endState: 'last-record-is-a-call-without-result' });
  h.prompt('s1', min(0), 'Go.');
  const r = run(h.build());
  const p = r.patterns.find((x) => x.id === 'premature-stop');
  assert.equal(p.status, 'found');
  assert.deepEqual(p.priority, priorityOf(p, 'Process', r.coverage.tokens.value));
  assert.equal(p.priority.tier, 'low');
});

test('a check that throws is reported as not run, and the other checks still report', () => {
  const h = history().session('s1');
  h.prompt('s1', min(0), 'Go.');
  h.shell('s1', min(1), 'git push --force origin main');
  const c = createContext(h.build(), { builtT: BUILT });
  const boom = { id: 'boom', title: 'A check that stops', evidence: 'derived', needs: [], how: 'Throws.', run: () => { throw new Error('an unexpected record'); } };
  const [stopped, risky] = runChecks(c, [boom, CHECKS.find((d) => d.id === 'risky-command')]);
  assert.equal(stopped.ran, false);
  assert.match(stopped.notRun, /stopped on something/);
  assert.deepEqual(stopped.findings, []);
  assert.equal(risky.ran, true);
  assert.equal(risky.findings.length, 1, 'the other checks still report');
});

test('a window with no session to read: nothing was checked, so no pattern reads as checked and clear', () => {
  const r = run(history().build());
  assert.equal(r.coverage.sessions.value, 0);
  assert.equal(r.statusCounts.clear, 0, 'no pattern is "checked, not found"');
  assert.equal(r.statusCounts.found, 0);
  assert.ok(r.checks.length > 0);
  for (const c of r.checks) assert.deepEqual([c.ran, c.notRun, c.checked], [false, NOTHING_TO_CHECK, null], c.id);
  const measured = r.patterns.filter((p) => p.measures.length && p.status !== 'undetectable');
  assert.ok(measured.length > 0);
  for (const p of measured) assert.deepEqual([p.status, p.notRun, p.tokens, p.countEvidence, p.priority], ['unchecked', NOTHING_TO_CHECK, null, null, null], p.id);
  // The same with only a display-only session, which the checks never read.
  const d = history().session('d1', { priv: true });
  d.prompt('d1', min(0), 'Go.');
  assert.equal(run(d.build()).statusCounts.clear, 0);
  // The partner: one quiet session in a configured repository, and patterns are checked and clear.
  const h = history().session('s1');
  h.prompt('s1', min(0), 'Go.');
  const quiet = run(h.build());
  assert.equal(quiet.coverage.sessions.value, 1);
  assert.ok(quiet.statusCounts.clear > 0, 'with a session to read, a pattern can be checked and clear');
  assert.ok(quiet.checks.some((c) => c.ran));
});
