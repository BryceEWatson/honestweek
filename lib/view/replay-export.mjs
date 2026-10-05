// lib/view/replay-export.mjs: one thread of a built history, shaped for the replay page.
//
// Every string here is one the engine already redacted (or, with Show private text,
// passed through its secrets-only scrubber): the event facts, titles and agent names. A
// description the engine builds from those facts is scrubbed once more as a whole.
// Nothing here reads a log line. The original record behind a step is read only when its
// panel asks for it, through /api/record.

import { THRESHOLDS } from '../problems/context.mjs';
import { describe } from '../replay/views.mjs';

/** The step groups the replay page draws as lanes. */
const GROUP = { shell: 'run', edit: 'change', read: 'look', search: 'look', web: 'look', browser: 'look' };

/** The most frames one replay carries; a longer thread is sampled evenly, keeping
 *  every prompt, interruption and outcome. */
export const MAX_FRAMES = 2000;

/** Every field each replay event carries, null when it doesn't apply. The pages read
 *  these, and a test checks every event has each one. */
export const REPLAY_EVENT_FIELDS = Object.freeze([
  'id', 't', 'at', 'endT', 'endAt', 'kind', 'group', 'cat', 'actor', 'who', 'agent', 'session', 'turn', 'tool', 'fileKey',
  'result', 'outcome', 'text', 'ev', 'inferred', 'missing', 'testRun', 'tests', 'patch', 'spanMs', 'harnessMs',
  'timeFrom', 'clock', 'timeNote', 'facts', 'derived', 'source',
]);

/** The counts a frame carries, each with the evidence level the engine's timeline gives it. */
const FRAME_COUNTS = [
  ['prompts', 'prompts'],
  ['actions', 'actions'],
  ['edits', 'edits'],
  ['testRuns', 'testRuns'],
  ['testsPassed', 'testRunsAllPassed'],
  ['testsFailed', 'testRunsWithFailures'],
  ['testsNoSummary', 'testRunsNoSummary'],
  ['testsUnclear', 'testRunsUnclear'],
  ['delegations', 'delegations'],
  ['interrupts', 'interrupts'],
  ['guards', 'guards'],
  ['prsLanded', 'prsLanded'],
  ['commits', 'commitsByConfiguredIdentity'],
];

/** Which group a session belongs to: a configured repository, a display-only one, or a
 *  folder outside the config. */
export function sessionGroup(s) {
  if (!s) return null;
  if (s.repoRole === 'display') return 'display';
  if (s.private) return 'outside';
  return 'configured';
}

/** Who did a step, and how that's known. A prompt is yours when its record says a
 *  person typed it; when only a named rule says so, "You" is marked inferred with the
 *  rule; a prompt in a non-interactive run may come from a person or a script. */
export function whoOf(e, agentsByKey) {
  const authorship = e.kind === 'prompt' ? (e.inferred ?? []).find((x) => x.key === 'authorship') : null;
  if (e.kind === 'prompt') {
    if (authorship?.value === 'person-or-script') return { label: 'a person or a script', evidence: 'inferred', rule: authorship.rule };
    if (authorship) return { label: 'You', evidence: 'inferred', rule: authorship.rule };
    return { label: 'You', evidence: 'recorded', rule: null };
  }
  switch (e.actor) {
    case 'person':
      return { label: 'You', evidence: 'recorded', rule: null };
    case 'agent': {
      const a = agentsByKey.get(e.agent);
      if (!a || a.kind === 'main') return { label: 'the main agent', evidence: 'recorded', rule: null };
      const name = a.description ?? a.type ?? null;
      const kind = a.kind === 'child-thread' ? 'child thread' : a.kind === 'guardian' ? 'approval reviewer' : 'sub-agent';
      return { label: name ? `the ${kind} "${name}"` : `a ${kind}`, evidence: 'recorded', rule: null };
    }
    case 'harness':
      return { label: 'the harness', evidence: 'recorded', rule: null };
    case 'peer':
      return { label: 'another session or agent', evidence: 'recorded', rule: null };
    case 'git':
      return { label: 'git', evidence: 'recorded', rule: null };
    default:
      return { label: null, evidence: 'recorded', rule: null };
  }
}

/** How a step's time is known, when it isn't simply the time its own line records. */
export function timeNoteOf(e) {
  if (e.clock?.rule === 'agent-after-spawn') {
    return { kind: 'moved-after-spawn', text: `This sub-agent's line was stamped ${Math.max(0, Math.round((e.clock.raisedTo - e.clock.recordedT) / 1000))} s before the call that started it, so it's placed just after that call.`, evidence: 'derived' };
  }
  if (e.timeFrom === 'previous-record') return { kind: 'borrowed-previous', text: "This line has no time of its own; it's placed at the time of the line before it.", evidence: 'derived' };
  if (e.timeFrom === 'next-record') return { kind: 'borrowed-next', text: "This line has no time of its own; it's placed at the time of the first line after it that has one.", evidence: 'derived' };
  if (e.end?.adjusted) return { kind: 'result-before-call', text: "The result's line was stamped before its call, so the result is shown at the call's time.", evidence: 'derived' };
  return null;
}

/** One event as the replay page reads it. `redact` is the build's own scrubber: the engine
 *  builds an event's description from fields it already redacted, and adds words of its own
 *  after them (` -> ok`, `, tests 3 passed / 0 failed`). Read whole, a field that ends one of
 *  those parts (`Authorization: [redacted:secret]`) runs on into the added words, so the
 *  description is scrubbed once more as the text it now is. */
export function eventRow(h, e, agentsByKey, redact = (s) => s) {
  const f = e.facts ?? {};
  const d = e.derived ?? {};
  const testRun = (e.inferred ?? []).find((x) => x.key === 'step' && x.value === 'test-run');
  return {
    id: e.id,
    t: e.t,
    at: e.at ?? null,
    endT: e.end?.t ?? null,
    endAt: e.end?.at ?? null,
    kind: e.kind,
    group: e.kind === 'action' ? GROUP[f.category] ?? 'other' : null,
    cat: f.category ?? null,
    actor: e.actor ?? null,
    who: whoOf(e, agentsByKey),
    agent: e.agent ?? null,
    session: e.session ?? null,
    turn: e.turn ?? null,
    tool: f.tool ?? null,
    fileKey: f.fileKey ?? null,
    result: f.result ?? null,
    outcome: f.outcome ?? null,
    text: redact(describe(e)),
    ev: e.evidence,
    inferred: (e.inferred ?? []).map((x) => ({ key: x.key, value: x.value, rule: x.rule, text: h.rules?.[x.rule] ?? null })),
    missing: e.missing ?? [],
    testRun: testRun ? { evidence: 'inferred', rule: testRun.rule } : null,
    tests: d.tests ? { ...d.tests, evidence: 'derived' } : null,
    patch: d.patch ?? null,
    spanMs: d.recordedSpanMs ?? d.ms ?? null,
    harnessMs: f.harnessDurationMs ?? null,
    timeFrom: e.timeFrom ?? null,
    clock: e.clock ?? null,
    timeNote: timeNoteOf(e),
    facts: f,
    derived: d,
    source: e.source ?? null,
  };
}

/** The moments to sample: every event's time, thinned evenly past `max`, always keeping
 *  each prompt, interruption and outcome. */
export function frameMoments(events, t0, t1, max = MAX_FRAMES) {
  const all = [...new Set(events.map((e) => e.t).filter(Number.isFinite))].sort((a, b) => a - b);
  if (all.length <= max) return all;
  const keep = new Set(events.filter((e) => e.kind === 'prompt' || e.kind === 'interrupt' || e.kind === 'outcome').map((e) => e.t));
  const room = Math.max(2, max - keep.size);
  for (let i = 0; i < room; i++) keep.add(all[Math.round(((all.length - 1) * i) / (room - 1))]);
  keep.add(t0);
  keep.add(t1);
  return [...keep].filter(Number.isFinite).sort((a, b) => a - b);
}

/** The timeline's state at one moment, with each count's evidence level. */
export function frameAt(tl, t) {
  const s = tl.stateAt(t);
  const c = s.counts;
  const ce = s.countEvidence;
  const frame = { t };
  const evidence = {};
  for (const [name, key] of FRAME_COUNTS) {
    frame[name] = c[key];
    evidence[name] = ce[key];
  }
  frame.filesEdited = s.filesEdited;
  evidence.filesEdited = ce.filesEdited;
  frame.awaiting = s.callsAwaitingRecordedResult.map((x) => ({ event: x.event, since: x.since, never: x.resultNeverRecorded ?? false }));
  frame.agentsOpen = s.agentsWithOpenRecordedSpan;
  frame.queued = s.messagesQueued.map((x) => x.event);
  frame.quiet = s.quietSessions.length > 0;
  frame.evidence = evidence;
  return frame;
}

/**
 * contextCalls(calls, { agents, window }) -> { threshold, agents: [{ agent, calls: [{ t, context }] }] }
 * Each listed agent's model calls in the window, in the order the long-session check reads them
 * (lib/problems/context.mjs: by source file, then line), each with its time and its context
 * size: the input, cache-read and cache-write tokens the log records for that call, the sum the
 * check compares with `threshold`. `calls` is a history's usage.calls. Numbers and ids only,
 * for the replay page's problem focus; nothing written to a file carries them.
 */
export function contextCalls(calls, { agents = [], window = {} } = {}) {
  const want = new Set(agents);
  const inWin = (t) => Number.isFinite(t) && t >= window.startT && t < window.endT;
  const by = new Map();
  for (const c of Array.isArray(calls) ? calls : []) {
    if (c && want.has(c.agent)) (by.get(c.agent) ?? by.set(c.agent, []).get(c.agent)).push(c);
  }
  const out = [];
  for (const agent of want) {
    const list = by.get(agent);
    if (!list) continue;
    list.sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : (x.lines?.[0] ?? 0) - (y.lines?.[0] ?? 0)));
    const live = list.filter((c) => inWin(c.t)).map((c) => ({ t: c.t, context: (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0) }));
    if (live.length) out.push({ agent, calls: live });
  }
  return { threshold: THRESHOLDS.longCtx, agents: out };
}

/**
 * exportThread(h, threadId, { focus, extraRules, redact, usage }) -> the replay page's data, or null
 * `focus` is the session the replay was opened for, when it was opened by session.
 * `redact` is the build's scrubber, for each event's description (eventRow).
 * `usage`, a history's usage.calls (possibly another build's of the same window), adds
 * `contextCalls` (contextCalls()) for the agents of the thread's configured sessions; without
 * it the answer is as it was.
 */
export function exportThread(h, threadId, { focus = null, extraRules = {}, redact, usage } = {}) {
  const th = h.thread(threadId);
  if (!th) return null;
  const members = new Set(th.sessions.map((s) => s.key));
  const events = h.events.filter((e) => members.has(e.session));
  const agentsByKey = new Map(h.agents.map((a) => [a.key, a]));
  const sessionByKey = new Map(h.sessions.map((s) => [s.key, s]));
  const real = events.filter((e) => e.kind !== 'quiet');
  const times = real.flatMap((e) => [e.t, e.end?.t]).filter(Number.isFinite);
  const t0 = times.length ? Math.min(...times) : Date.parse(th.firstAt ?? '') || null;
  const t1 = times.length ? Math.max(...times) : Date.parse(th.lastAt ?? '') || t0;
  const tl = h.threadTimeline(threadId);
  const frames = tl && t0 != null ? frameMoments(events, t0, t1).map((t) => frameAt(tl, t)) : [];
  const agents = h.agents
    .filter((a) => members.has(a.session))
    .map((a) => ({ key: a.key, session: a.session, kind: a.kind, type: a.type ?? null, description: a.description ?? null, parentAgent: a.parentAgent ?? null, spawnedBy: a.spawnedBy ?? null, spawnAt: a.spawnAt ?? null, firstAt: a.firstAt ?? null, lastAt: a.lastAt ?? null, completion: a.completion ?? null, missing: a.missing ?? [] }));
  const turns = th.sessions.flatMap((s) => h.session(s.key)?.turns ?? []);
  const first = th.sessions.find((s) => s.key === focus) ?? th.sessions[0];
  return {
    window: h.window,
    timezone: h.window.timezone,
    focus: focus && members.has(focus) ? focus : null,
    thread: {
      id: th.id,
      title: th.title ?? null,
      firstAt: t0 != null ? new Date(t0).toISOString() : th.firstAt ?? null,
      lastAt: t1 != null ? new Date(t1).toISOString() : th.lastAt ?? null,
      metrics: th.metrics,
      outcomes: th.outcomes,
      missing: th.missing,
      links: th.links,
      related: th.related,
    },
    session: { key: first?.key ?? null, title: first?.title ?? th.title ?? null, turns },
    sessions: th.sessions.map((s) => ({ key: s.key, tool: s.tool, repo: s.repo ?? null, group: sessionGroup(sessionByKey.get(s.key)), title: s.title ?? null, firstAt: s.firstAt ?? null, lastAt: s.lastAt ?? null, endState: s.endState ?? null, missing: s.missing ?? [] })),
    agents,
    events: events.map((e) => eventRow(h, e, agentsByKey, redact)),
    frames,
    rules: { ...h.rules, ...extraRules },
    coverage: h.coverage,
    ...(Array.isArray(usage) ? { contextCalls: contextCalls(usage, { agents: agents.filter((a) => sessionByKey.get(a.session)?.private === false).map((a) => a.key), window: h.window }) } : {}),
  };
}
