// lib/replay/timeline.mjs — deterministic reconstruction at any moment, and seeking.
//
// The history is flattened into POINTS: an instant event is one point; an event
// with a recorded end (a tool call and its result, a queued message and its
// delivery, a quiet interval) is a start point and an end point. Points are totally
// ordered (time, then end-after-start, then event order), so "the state at time T"
// has exactly one answer: fold every point at or before T.
//
// Folding from the beginning for every seek would be slow on a long history, so a
// snapshot of the fold is kept every CHECKPOINT points. A seek starts from the
// nearest snapshot at or before its target. The tests prove the snapshot path and
// the from-scratch path give identical states at every point.
//
// What the state reports is limited to what the records support. "In flight" means
// a call was recorded and its result was not yet recorded; it does not mean the
// agent was busy. An "open agent span" means the agent's first record (or the call
// that started it) is at or before T and its completion (or last record) is at or
// after T; it is not a count of agents working.

import { isCommitByConfiguredIdentity, isCommitFound, isDelegation, isPrLanded, isSuccessfulEdit, promptLabels, testRunResult } from './metrics.mjs';

// A snapshot every 512 points bounds a seek to 511 replayed points; the number trades
// memory for seek time and has no effect on any result (the tests prove it).
const CHECKPOINT = 512;

function emptyState() {
  return {
    point: -1,
    t: null,
    counts: {
      events: 0,
      prompts: 0,
      promptsLabelled: { correction: 0, approval: 0, question: 0, 'resume-request': 0 },
      decisions: 0,
      interrupts: 0,
      actions: 0,
      byCategory: {},
      delegations: 0,
      testRuns: 0,
      testRunsWithFailures: 0,
      testRunsAllPassed: 0,
      testRunsNoSummary: 0,
      edits: 0,
      linesAdded: 0,
      linesRemoved: 0,
      guards: 0,
      errors: 0,
      compactions: 0,
      commitsFoundInGit: 0,
      commitsByConfiguredIdentity: 0,
      prsLanded: 0,
      agentMessages: 0,
    },
    inFlight: new Map(), // action event id -> { since, session, agent, category }
    queued: new Map(), // queue event id -> { since, session }
    quiet: new Map(), // quiet event id -> { since, session }
    files: new Map(), // file key -> edit count
    lastPrompt: new Map(), // session -> prompt event id
    lastEvent: new Map(), // agent -> event id
    lastTest: new Map(), // `${session}|${runner}` -> { event, pass, fail, at }
  };
}

function cloneState(s) {
  return {
    point: s.point,
    t: s.t,
    counts: { ...s.counts, promptsLabelled: { ...s.counts.promptsLabelled }, byCategory: { ...s.counts.byCategory } },
    inFlight: new Map(s.inFlight),
    queued: new Map(s.queued),
    quiet: new Map(s.quiet),
    files: new Map(s.files),
    lastPrompt: new Map(s.lastPrompt),
    lastEvent: new Map(s.lastEvent),
    lastTest: new Map(s.lastTest),
  };
}

function applyStart(s, e) {
  const c = s.counts;
  c.events += 1;
  if (e.agent) s.lastEvent.set(e.agent, e.id);
  switch (e.kind) {
    case 'prompt':
      c.prompts += 1;
      s.lastPrompt.set(e.session, e.id);
      for (const v of promptLabels(e)) if (v in c.promptsLabelled) c.promptsLabelled[v] += 1;
      break;
    case 'decision':
      c.decisions += 1;
      break;
    case 'interrupt':
      c.interrupts += 1;
      break;
    case 'guard':
      c.guards += 1;
      break;
    case 'error':
      c.errors += 1;
      break;
    case 'compaction':
      c.compactions += 1;
      break;
    case 'agent-message':
      c.agentMessages += 1;
      break;
    case 'queue':
      // Only the enqueue record opens a queued item; it closes at its resolving record,
      // or never, when the log records no delivery.
      if (e.facts.state === 'enqueued' || e.facts.resolvedBy) s.queued.set(e.id, { since: e.t, session: e.session, neverDelivered: !e.end });
      break;
    case 'quiet':
      s.quiet.set(e.id, { since: e.t, session: e.session });
      break;
    case 'outcome':
      if (isCommitFound(e)) c.commitsFoundInGit += 1;
      if (isCommitByConfiguredIdentity(e)) c.commitsByConfiguredIdentity += 1;
      if (isPrLanded(e)) c.prsLanded += 1;
      break;
    case 'action': {
      c.actions += 1;
      const cat = e.facts.category ?? 'other';
      c.byCategory[cat] = (c.byCategory[cat] ?? 0) + 1;
      if (isDelegation(e)) c.delegations += 1;
      if (e.end || e.missing.includes('result')) s.inFlight.set(e.id, { since: e.t, session: e.session, agent: e.agent, category: cat, noResult: !e.end });
      break;
    }
    default:
      break;
  }
}

function applyEnd(s, e) {
  if (e.kind === 'quiet') {
    s.quiet.delete(e.id);
    return;
  }
  if (e.kind === 'queue') {
    s.queued.delete(e.id);
    return;
  }
  if (e.kind !== 'action') return;
  s.inFlight.delete(e.id);
  const c = s.counts;
  if (isSuccessfulEdit(e)) {
    c.edits += 1;
    if (e.derived.patch) {
      c.linesAdded += e.derived.patch.added;
      c.linesRemoved += e.derived.patch.removed;
    }
    if (e.facts.fileKey) s.files.set(e.facts.fileKey, (s.files.get(e.facts.fileKey) ?? 0) + 1);
  }
  const run = testRunResult(e);
  if (run) {
    const tests = e.derived.tests;
    c.testRuns += 1;
    if (run === 'no-summary') c.testRunsNoSummary += 1;
    else if (run === 'failed') c.testRunsWithFailures += 1;
    else c.testRunsAllPassed += 1;
    s.lastTest.set(`${e.session}|${e.facts.testRunner}`, { event: e.id, at: e.end.at, pass: tests?.pass ?? null, fail: tests?.fail ?? null });
  }
}

/**
 * buildTimeline(events, { agents, sessions }) -> timeline
 * `events` must already be in total order (compareEvents).
 */
export function buildTimeline(events, { agents = [], sessions = [] } = {}) {
  const order = new Map(events.map((e, i) => [e.id, i]));
  const points = [];
  for (const e of events) {
    points.push({ t: e.t, phase: 0, i: order.get(e.id) });
    if (e.end && Number.isFinite(e.end.t)) points.push({ t: Math.max(e.end.t, e.t), phase: 1, i: order.get(e.id) });
  }
  points.sort((a, b) => a.t - b.t || a.phase - b.phase || a.i - b.i);

  const checkpoints = [];
  let s = emptyState();
  checkpoints.push(cloneState(s));
  for (let p = 0; p < points.length; p++) {
    step(s, points[p], p);
    if ((p + 1) % CHECKPOINT === 0) checkpoints.push(cloneState(s));
  }

  function step(state, point, p) {
    const e = events[point.i];
    if (point.phase === 0) applyStart(state, e);
    else applyEnd(state, e);
    state.point = p;
    state.t = point.t;
  }

  /** Index of the last point at or before `t` (-1 if `t` precedes every point). */
  function cursorAt(t) {
    let lo = 0;
    let hi = points.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** The folded state after point `cursor` (inclusive), via the nearest checkpoint. */
  function stateAtCursor(cursor, { fromScratch = false } = {}) {
    const c = Math.max(-1, Math.min(cursor, points.length - 1));
    let st;
    let from;
    if (fromScratch) {
      st = emptyState();
      from = 0;
    } else {
      const k = Math.floor((c + 1) / CHECKPOINT);
      st = cloneState(checkpoints[Math.min(k, checkpoints.length - 1)]);
      from = Math.min(k, checkpoints.length - 1) * CHECKPOINT;
    }
    for (let p = from; p <= c; p++) step(st, points[p], p);
    return st;
  }

  /** A plain, serializable view of the state at time `t`. */
  function stateAt(t, opts) {
    const cursor = cursorAt(t);
    return view(stateAtCursor(cursor, opts), t, cursor);
  }

  function view(st, t, cursor) {
    const open = (a, b) => a != null && a <= t && (b == null || b >= t);
    const toT = (iso) => (iso ? Date.parse(iso) : null);
    return {
      t,
      at: Number.isFinite(t) ? new Date(t).toISOString() : null,
      cursor,
      lastPointEvent: cursor >= 0 ? events[points[cursor].i].id : null,
      counts: st.counts,
      sessionsWithOpenRecordedSpan: sessions.filter((s) => open(toT(s.firstAt), toT(s.lastAt))).map((s) => s.key).sort(),
      agentsWithOpenRecordedSpan: agents
        .filter((a) => a.kind !== 'main' && open(toT(a.spawnAt ?? a.firstAt), toT(a.completion?.at ?? a.lastAt)))
        .map((a) => a.key)
        .sort(),
      callsAwaitingRecordedResult: [...st.inFlight.entries()].map(([id, v]) => ({ event: id, since: new Date(v.since).toISOString(), category: v.category, session: v.session, resultNeverRecorded: v.noResult })),
      messagesQueued: [...st.queued.entries()].map(([id, v]) => ({ event: id, since: new Date(v.since).toISOString(), session: v.session, deliveryNeverRecorded: v.neverDelivered })),
      quietSessions: [...st.quiet.entries()].map(([id, v]) => ({ event: id, session: v.session, since: new Date(v.since).toISOString() })),
      filesEdited: st.files.size,
      latestTestRuns: [...st.lastTest.entries()].map(([k, v]) => ({ session: k.split('|')[0], runner: k.split('|')[1], ...v })),
      lastPromptBySession: Object.fromEntries([...st.lastPrompt.entries()].sort()),
    };
  }

  /** Move `n` points from `cursor` (negative = backwards), clamped to the history. */
  function step2(cursor, n) {
    const c = Math.max(-1, Math.min(points.length - 1, cursor + n));
    const p = c >= 0 ? points[c] : null;
    return { cursor: c, t: p ? p.t : null, event: p ? events[p.i].id : null, phase: p ? (p.phase === 0 ? 'start' : 'end') : null };
  }

  /** The next (dir = 1) or previous (dir = -1) point after `cursor` whose event matches. */
  function seekWhere(cursor, dir, predicate) {
    for (let c = cursor + dir; c >= 0 && c < points.length; c += dir) {
      const e = events[points[c].i];
      if (predicate(e, points[c].phase === 0 ? 'start' : 'end')) return step2(c, 0);
    }
    return null;
  }

  return {
    points: points.length,
    checkpointEvery: CHECKPOINT,
    cursorAt,
    stateAt,
    stateAtCursor: (c, opts) => view(stateAtCursor(c, opts), c >= 0 ? points[Math.min(c, points.length - 1)].t : -Infinity, c),
    step: step2,
    seekWhere,
    pointAt: (c) => (c >= 0 && c < points.length ? { t: points[c].t, phase: points[c].phase === 0 ? 'start' : 'end', event: events[points[c].i].id } : null),
  };
}
