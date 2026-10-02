// lib/replay/views.mjs — progressive drill-down over a built history.
//
//   overview  -> one row per local day, and one per thread
//   thread    -> its sessions, agent tree, links, outcomes, and what is missing
//   session   -> its agents and turns
//   turn      -> its events in order
//   event     -> every field, each tagged with how it is known
//   record    -> the original log line, re-read from disk and checked against the
//                digest taken when it was parsed
//
// Every metric a view reports carries its evidence level, so a reader can always
// tell a counted record from an interpretation.

import { localDateInTimezone } from '../resolve-week.mjs';
import { RULES } from './classify.mjs';
import { EVIDENCE } from './evidence.mjs';
import { isCommitByConfiguredIdentity, isCommitFound, isDelegation, isPrLanded, isSuccessfulEdit, promptLabels, testRunResult } from './metrics.mjs';

const R = EVIDENCE.RECORDED;
const D = EVIDENCE.DERIVED;
const I = EVIDENCE.INFERRED;

const metric = (value, evidence, extra = {}) => ({ value, evidence, ...extra });

export function localDay(t, tz) {
  return localDateInTimezone(new Date(t), tz).toISOString().slice(0, 10);
}

function hasInference(e, value) {
  return e.inferred.some((x) => x.value === value);
}

/**
 * Aggregate a list of events into the metrics every level shows. Metrics that need
 * a record's content (labels on prompts, files, test runs, reviews) are computed
 * over readable sessions only; events from private sessions are counted separately
 * so "0" never stands in for "not read". Each count uses the one definition in
 * metrics.mjs that the timeline also uses.
 *
 * `agents` are the agents to count as started; an agent with no recorded starting
 * call is counted apart, as missing evidence, because its start is only its first
 * record.
 */
export function summarize(events, agents = [], privateSessions = new Set()) {
  const readable = events.filter((e) => !privateSessions.has(e.session));
  const unread = events.length - readable.length;
  const scoped = (m) => (unread ? { ...m, excludesPrivateEvents: unread } : m);
  const prompts = events.filter((e) => e.kind === 'prompt');
  const readablePrompts = readable.filter((e) => e.kind === 'prompt');
  const actions = events.filter((e) => e.kind === 'action');
  const readableActions = readable.filter((e) => e.kind === 'action');
  const testRuns = readableActions.map(testRunResult).filter(Boolean);
  const edits = actions.filter(isSuccessfulEdit);
  const files = new Set(edits.map((e) => e.facts.fileKey).filter(Boolean));
  const labelled = (v) => readablePrompts.filter((e) => promptLabels(e).includes(v)).length;
  return {
    prompts: metric(prompts.length, R),
    corrections: scoped(metric(labelled('correction'), I, { rule: 'prompt.correction' })),
    approvals: scoped(metric(labelled('approval'), I, { rule: 'prompt.approval' })),
    decisions: metric(events.filter((e) => e.kind === 'decision').length, R),
    interrupts: metric(events.filter((e) => e.kind === 'interrupt').length, R),
    actions: metric(actions.length, R),
    actionsWithoutRecordedResult: metric(actions.filter((e) => !e.end).length, EVIDENCE.MISSING),
    delegations: metric(actions.filter(isDelegation).length, R),
    agentsStartedByARecordedCall: metric(agents.filter((a) => a.spawnedBy).length, R),
    agentsWithoutARecordedStart: metric(agents.filter((a) => !a.spawnedBy).length, EVIDENCE.MISSING, { note: 'an inline sub-agent from an older log may stand for several' }),
    edits: metric(edits.length, R),
    filesEdited: scoped(metric(files.size, D)),
    testRuns: scoped(metric(testRuns.length, I, { rule: 'shell.test', note: 'runs that were rejected, refused, or interrupted are not counted' })),
    testRunsAllPassed: scoped(metric(testRuns.filter((x) => x === 'passed').length, D)),
    testRunsWithFailures: scoped(metric(testRuns.filter((x) => x === 'failed').length, D)),
    testRunsWithoutSummary: scoped(metric(testRuns.filter((x) => x === 'no-summary').length, EVIDENCE.MISSING)),
    reviews: scoped(metric(readableActions.filter((e) => hasInference(e, 'review')).length, I, { rule: 'review.delegation | review.skill' })),
    eventsInPrivateSessions: metric(unread, R, { note: 'kind, time, and step category only; content not read' }),
    guards: metric(events.filter((e) => e.kind === 'guard').length, R),
    errors: metric(events.filter((e) => e.kind === 'error').length, R),
    commitsFoundInGit: metric(events.filter(isCommitFound).length, R, { by: 'git', note: 'whoever authored them' }),
    commitsByConfiguredIdentity: metric(events.filter(isCommitByConfiguredIdentity).length, R, { by: 'git' }),
    prsLanded: metric(events.filter(isPrLanded).length, R, { by: 'git' }),
    quietIntervals: metric(events.filter((e) => e.kind === 'quiet').length, D),
  };
}

/** One line of plain text describing an event, built only from its own fields. */
export function describe(e) {
  const f = e.facts ?? {};
  const q = (s) => (s ? `"${s}"` : '(text not shown)');
  switch (e.kind) {
    case 'prompt':
      return `prompt ${q(f.text)}${f.delivery === 'mid-turn' ? ' (typed while the agent was busy, delivered mid-turn)' : ''}`;
    case 'message':
      return `${f.to === 'parent-agent' ? 'reply to parent agent' : 'message to the person'} ${q(f.text)}`;
    case 'action': {
      const what = f.command ?? f.file ?? f.description ?? f.pattern ?? f.query ?? f.subject ?? f.skill ?? f.title ?? '';
      const res = e.end ? f.result ?? 'recorded' : 'no result recorded';
      const extra = e.derived.tests ? `, tests ${e.derived.tests.pass} passed / ${e.derived.tests.fail} failed` : e.derived.patch ? `, +${e.derived.patch.added} -${e.derived.patch.removed} lines` : '';
      return `${f.tool} (${f.category})${what ? ` ${what}` : ''} -> ${res}${extra}`;
    }
    case 'delegation-received':
      return `started with instructions from its parent agent ${q(f.text)}`;
    case 'agent-message':
      return `agent message ${f.direction ?? ''} ${q(f.text ?? f.summary)}`.replace(/\s+/g, ' ');
    case 'notification':
      return `harness notice: ${f.summary ?? 'background work finished'} (status ${f.status ?? 'not recorded'})`;
    case 'queue':
      if (f.carries) return `${f.carries === 'notification' ? 'a notice' : 'a message'} queued while the agent was busy; ${f.state === 'enqueued' ? 'no delivery recorded' : `later ${f.state}`}${e.derived.waitedMs != null ? ` after ${e.derived.waitedMs} ms` : ''}`;
      return `queue ${f.state === 'delivered' ? 'delivered a waiting message' : 'withdrew a waiting message'}${f.reason ? ` (${f.reason})` : ''}`;
    case 'interrupt':
      if (f.by === 'harness-reported') return `the harness recorded the turn as aborted${f.reason ? ` (its reason word: ${f.reason})` : ''}`;
      if (f.by === 'session-end') return "the harness recorded that the session ended before this call's result was written";
      return `interrupted by ${f.by}${f.during ? ` during a ${f.during}` : ''}${f.reason ? ` (${f.reason})` : ''}`;
    case 'decision':
      return `person ${f.decision}${f.feedback ? `: ${q(f.feedback)}` : ''}${f.answers ? `: ${f.answers.map(q).join(', ')}` : ''}`;
    case 'guard':
      return `refused by ${f.rule ?? 'a rule'}${f.reason ? `: ${f.reason}` : ''}`;
    case 'hook':
      return `hook ${f.hook ?? ''} ${f.hookEvent ?? ''} (exit ${f.exitCode ?? 'not recorded'})`.replace(/\s+/g, ' ');
    case 'turn-end':
      return `turn ended (${f.marker})${f.harnessDurationMs != null ? `, harness-recorded duration ${f.harnessDurationMs} ms` : ''}`;
    case 'outcome':
      return f.outcome === 'pr-landed' ? `git: pull request ${f.pr} landed as ${f.sha} "${f.subject}"` : `git: commit ${f.sha} exists${f.onDefaultBranch ? ' on the default branch' : ' (not on the default branch)'} "${f.subject}"`;
    case 'quiet':
      return `no records in this session for ${Math.round(e.derived.ms / 60000)} min`;
    case 'link':
      return `linked to pull request ${f.pr}${f.repo ? ` in ${f.repo}` : ''}`;
    case 'mode':
      return `mode change: ${f.change}${f.value ? ` = ${f.value}` : ''}${f.branch ? ` (branch ${f.branch})` : ''}`;
    case 'external-edit':
      return `a file changed outside the agent's own tools${f.file ? `: ${f.file}` : ''}`;
    case 'compaction':
      return `context compacted (${f.trigger || 'trigger not recorded'})`;
    case 'error':
      return `error recorded: ${f.kind}${f.status ? ` ${f.status}` : ''}`;
    case 'command':
      return `slash command ${f.name ?? ''}`;
    case 'notice':
      return 'harness note for an action the person took (no typed text)';
    case 'session':
      return `thread started (${f.started})`;
    default:
      return e.kind;
  }
}

export function eventRow(e) {
  return {
    id: e.id,
    at: e.at,
    t: e.t,
    endAt: e.end?.at ?? null,
    kind: e.kind,
    actor: e.actor,
    agent: e.agent,
    evidence: e.evidence,
    text: describe(e),
    inferred: e.inferred.map((x) => `${x.key}=${x.value} [${x.rule}]`),
    missing: e.missing,
    clock: e.clock ?? null,
  };
}

export function createViews(h) {
  const tz = h.window.timezone;
  const eventsById = new Map(h.events.map((e) => [e.id, e]));
  const sessionsByKey = new Map(h.sessions.map((s) => [s.key, s]));
  const agentsByKey = new Map(h.agents.map((a) => [a.key, a]));
  const inWindow = (e) => e.t >= h.window.startT && e.t < h.window.endT;
  const startedInWindow = (a) => {
    const t = Date.parse(a.spawnAt ?? a.firstAt ?? '');
    return Number.isFinite(t) && t >= h.window.startT && t < h.window.endT;
  };
  const privateSessions = new Set(h.sessions.filter((s) => s.private).map((s) => s.key));
  const eventsBySession = new Map();
  for (const e of h.events) {
    if (!eventsBySession.has(e.session)) eventsBySession.set(e.session, []);
    eventsBySession.get(e.session).push(e);
  }
  const eventsOf = (keys) => keys.flatMap((k) => eventsBySession.get(k) ?? []);

  function overview() {
    const days = new Map();
    for (const e of h.events) {
      if (!inWindow(e)) continue;
      const d = localDay(e.t, tz);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(e);
    }
    const dayRows = [...days.keys()].sort().map((d) => {
      const evs = days.get(d);
      // A session counts on a day it wrote a record of its own; a git outcome or a
      // late-stamped link does not put it there.
      const sess = new Set(evs.filter((e) => e.timeFrom === 'record' && !['outcome', 'link', 'queue', 'quiet'].includes(e.kind)).map((e) => e.session));
      const started = h.agents.filter((a) => a.kind !== 'main' && (a.spawnAt ?? a.firstAt) && localDay(Date.parse(a.spawnAt ?? a.firstAt), tz) === d);
      return { date: d, sessions: metric(sess.size, R), metrics: summarize(evs, started, privateSessions) };
    });
    return {
      window: h.window,
      days: dayRows,
      threads: h.threads.map((th) => threadRow(th)),
      totals: summarize(h.events.filter(inWindow), h.agents.filter((a) => a.kind !== 'main' && startedInWindow(a)), privateSessions),
      sessionsOutsideConfiguredRepos: h.skipped.outsideConfiguredRepos,
      evidenceLevels: { recorded: 'a record says so directly', derived: 'computed only from recorded values', inferred: 'a named rule interpreted a record', missing: 'expected evidence that is absent' },
    };
  }

  function threadRow(th) {
    const sess = th.sessions.map((k) => sessionsByKey.get(k));
    const evs = eventsOf(th.sessions);
    const agents = h.agents.filter((a) => th.sessions.includes(a.session) && a.kind !== 'main');
    return {
      id: th.id,
      title: sess.find((s) => s.title)?.title ?? null,
      sessions: metric(sess.length, R),
      agentsStarted: metric(agents.length, R, { note: 'sub-agents and child threads in this thread, with or without a recorded starting call' }),
      firstAt: sess.map((s) => s.firstAt).filter(Boolean).sort()[0] ?? null,
      lastAt: sess.map((s) => s.lastAt).filter(Boolean).sort().at(-1) ?? null,
      private: sess.every((s) => s.private),
      events: evs.length,
      metrics: summarize(evs, agents, privateSessions),
    };
  }

  function thread(id) {
    const th = h.threads.find((x) => x.id === id);
    if (!th) return null;
    const members = new Set(th.sessions);
    const agents = h.agents.filter((a) => members.has(a.session));
    const tree = (parentKey) =>
      agents
        .filter((a) => (parentKey === null ? a.kind === 'main' : a.parentAgent === parentKey))
        .map((a) => ({ key: a.key, kind: a.kind, type: a.type, description: a.description, session: a.session, spawnedBy: a.spawnedBy, spawnAt: a.spawnAt ?? null, firstAt: a.firstAt, lastAt: a.lastAt, completion: a.completion, missing: a.missing, children: tree(a.key) }));
    const orphanAgents = agents.filter((a) => a.kind !== 'main' && !a.parentAgent).map((a) => ({ key: a.key, kind: a.kind, description: a.description, missing: a.missing }));
    const evs = eventsOf(th.sessions);
    const touching = (l) => [l.from, l.to].some((x) => members.has(x) || members.has(eventsById.get(x)?.session) || members.has(agentsByKey.get(x)?.session) || members.has(h.sourceSession.get(x)));
    const missing = [];
    for (const e of evs) for (const m of e.missing) missing.push({ event: e.id, missing: m, text: describe(e) });
    for (const a of agents) for (const m of a.missing) missing.push({ agent: a.key, missing: m });
    const prKeys = new Set(evs.filter((e) => e.kind === 'link').map((e) => `${e.facts.repo}|${e.facts.pr}`));
    const sharedPr = h.events.filter((e) => e.kind === 'link' && !members.has(e.session) && prKeys.has(`${e.facts.repo}|${e.facts.pr}`));
    return {
      ...threadRow(th),
      sessions: th.sessions.map((k) => sessionRow(sessionsByKey.get(k))),
      agentTree: tree(null),
      agentsWithoutRecordedParent: orphanAgents,
      links: h.links.filter(touching),
      related: {
        handoffs: h.links.filter((l) => l.type === 'handoff' && touching(l)),
        sessionsSharingAPullRequest: [...new Set(sharedPr.map((e) => e.session))].sort().map((k) => ({ session: k, thread: sessionsByKey.get(k)?.thread ?? null, evidence: D })),
      },
      outcomes: evs.filter((e) => e.kind === 'outcome').map(eventRow),
      missing,
    };
  }

  function sessionRow(s) {
    return { key: s.key, tool: s.tool, repo: s.repo, private: s.private, title: s.title, firstAt: s.firstAt, lastAt: s.lastAt, endState: s.endState, agents: s.agents.length, turns: s.turns.length, missing: s.missing };
  }

  function session(key) {
    const s = sessionsByKey.get(key);
    if (!s) return null;
    return {
      ...sessionRow(s),
      thread: s.thread,
      startedFrom: s.startedFrom ?? null,
      agents: h.agents.filter((a) => a.session === key),
      turns: s.turns.map((id) => turnRow(h.turnsById.get(id))),
      metrics: summarize(eventsBySession.get(key) ?? [], h.agents.filter((a) => a.session === key && a.kind !== 'main'), privateSessions),
    };
  }

  function turnRow(t) {
    const evs = t.events.map((id) => eventsById.get(id)).filter(Boolean);
    const opener = eventsById.get(t.id);
    return {
      id: t.id,
      agent: t.agent,
      startAt: new Date(t.startT).toISOString(),
      lastRecordAt: new Date(t.endT).toISOString(),
      opener: opener ? { kind: opener.kind, text: describe(opener) } : null,
      events: evs.length,
      actions: evs.filter((e) => e.kind === 'action').length,
      stopRecorded: t.stopRecorded,
      missing: [...new Set(evs.flatMap((e) => e.missing))],
    };
  }

  function turn(id) {
    const t = h.turnsById.get(id);
    if (!t) return null;
    return { ...turnRow(t), session: t.session, events: t.events.map((x) => eventRow(eventsById.get(x))).filter(Boolean) };
  }

  function event(id) {
    const e = eventsById.get(id);
    if (!e) return null;
    return {
      ...e,
      description: describe(e),
      inferred: e.inferred.map((x) => ({ ...x, ruleText: RULES.get(x.rule) })),
      links: h.links.filter((l) => l.from === id || l.to === id),
    };
  }

  return { overview, thread, session, turn, event, describe };
}
