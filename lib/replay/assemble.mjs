// lib/replay/assemble.mjs — connect parsed sources into one history.
//
// Each adapter parsed one file in isolation. This step:
//   1. drops records that appear in more than one session file (a resumed or forked
//      session copies its history into the new file, keeping the record ids),
//   2. links what the records themselves link: a sub-agent to the tool call that
//      started it, a background task to its completion notice, a message one
//      session sent to the session that received it, a Codex child thread to the
//      spawn call that named it,
//   3. applies the two clock rules (below),
//   4. builds sessions, agents, turns, and threads, and marks quiet intervals.
//
// CLOCK RULES. Event time is the record's own timestamp. It is NOT forced to move
// forward in file order: measured on the build machine, out-of-band records
// (pull-request links, queue operations) are stamped minutes to days AFTER the
// conversational records written below them, so a "never go backwards" clock would
// shift real work by days. Instead, only recorded cause-and-effect constrains time:
// a tool result cannot precede its call, and a sub-agent cannot act before the call
// that started it. A violation is kept as an anomaly with its measured size, and the
// later event's position on the axis is raised to the cause's; the recorded
// timestamp is never rewritten.

import { EVIDENCE } from './evidence.mjs';
import { letterHash } from './ids.mjs';

const DEFAULT_QUIET_MS = 20 * 60 * 1000;

/** Total order on events: time, then source, then line, then sub-index. */
export function compareEvents(a, b) {
  if (a.t !== b.t) return a.t - b.t;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const [, la, sa] = a.id.split('.');
  const [, lb, sb] = b.id.split('.');
  const na = Number(la);
  const nb = Number(lb);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (sa !== sb) return Number(sa) - Number(sb) || (a.id < b.id ? -1 : 1);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * assemble({ parsed, quietMs }) -> history parts.
 * `parsed` is [{ source, result, ctx }] for every parsed file.
 */
export function assemble({ parsed, quietMs = DEFAULT_QUIET_MS }) {
  const anomalies = [];
  const links = [];
  const bySource = new Map(parsed.map((p) => [p.source.key, p]));

  // ---- 1. duplicate records across session files ---------------------------
  const owners = new Map(); // uuid -> [{ key, eventIds }]
  for (const p of parsed) {
    for (const u of p.result.joins.uuids ?? []) {
      if (!owners.has(u.uuid)) owners.set(u.uuid, []);
      owners.get(u.uuid).push({ key: p.source.key, eventIds: u.eventIds });
    }
  }
  const drop = new Map(); // removed event id -> canonical event id
  const shared = new Map(); // "copy->original" -> count
  const eventIndex = new Map();
  for (const p of parsed) for (const e of p.result.events) eventIndex.set(e.id, e);
  const lastAtOf = (key) => bySource.get(key)?.result.stats.lastAt ?? '';
  for (const list of owners.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (lastAtOf(a.key) < lastAtOf(b.key) ? -1 : lastAtOf(a.key) > lastAtOf(b.key) ? 1 : a.key < b.key ? -1 : 1));
    const canon = sorted[0];
    for (const copy of sorted.slice(1)) {
      const pair = `${copy.key}->${canon.key}`;
      shared.set(pair, (shared.get(pair) ?? 0) + 1);
      copy.eventIds.forEach((id, i) => {
        // The two files parsed the same record; each copy event pairs with the original
        // event of the same position and kind. One with no such partner is kept, not
        // folded into an unrelated event.
        const keep = eventIndex.get(canon.eventIds[i]);
        const gone = eventIndex.get(id);
        if (!keep || !gone || keep.kind !== gone.kind || id.split('.').at(-1) !== keep.id.split('.').at(-1)) return;
        drop.set(id, keep.id);
        keep.copies = [...(keep.copies ?? []), ...gone.refs];
        // Which file's session the record belongs to is the rule's choice, not a record's.
        if (!keep.inferred.some((x) => x.key === 'sessionAttribution')) keep.inferred.push({ key: 'sessionAttribution', value: keep.session, rule: 'canonical.earliest-ending-copy' });
        // A resumed copy can hold the result the original never recorded (the first
        // run stopped mid-call). Everything the result taught the copy moves over.
        if (gone.end && !keep.end) {
          keep.end = gone.end;
          keep.refs.push(gone.end.ref);
          keep.facts = { ...keep.facts, ...gone.facts };
          keep.derived = { ...keep.derived, ...gone.derived };
          for (const inf of gone.inferred) if (!keep.inferred.some((x) => x.key === inf.key && x.value === inf.value)) keep.inferred.push(inf);
          keep.missing = [...new Set([...keep.missing.filter((m) => m !== 'result'), ...gone.missing.filter((m) => m !== 'result')])];
        }
      });
    }
  }

  // Every join and every event-to-event reference now points at the kept copy.
  const live = (e) => (e && drop.has(e.id) ? eventIndex.get(drop.get(e.id)) : e);
  const liveId = (id) => (typeof id === 'string' && drop.has(id) ? drop.get(id) : id);
  // A copy's join now names the original's event, which the original's own file also
  // joins, so each join is kept once across all files, not once per file.
  const seenJoin = new Map();
  for (const p of parsed) {
    const j = p.result.joins;
    for (const k of ['calls', 'backgroundTasks']) if (j[k] instanceof Map) for (const [id, e] of j[k]) j[k].set(id, live(e));
    for (const k of ['agentLaunches', 'notifications', 'sentMessages', 'receivedMessages', 'chips', 'prs', 'commits', 'spawns', 'stoppedTasks']) {
      if (!Array.isArray(j[k])) continue;
      if (!seenJoin.has(k)) seenJoin.set(k, new Set());
      const seen = seenJoin.get(k);
      j[k] = j[k].map((x) => ({ ...x, event: live(x.event) })).filter((x) => {
        const key = `${x.event.id}|${x.sha ?? x.number ?? x.taskId ?? x.msgId ?? x.agentId ?? x.agentPath ?? x.digest ?? ''}`;
        return !seen.has(key) && seen.add(key);
      });
    }
  }
  for (const p of parsed) {
    for (const e of p.result.events) {
      for (const k of ['action', 'resolvedBy', 'about', 'deliveredTo', 'sentBy']) if (k in e.facts) e.facts[k] = liveId(e.facts[k]);
    }
  }
  for (const [pair, count] of shared) {
    const [from, to] = pair.split('->');
    links.push({ type: 'continuation', from, to, evidence: EVIDENCE.DERIVED, facts: { sharedRecords: count }, inferred: [{ key: 'original', value: to, rule: 'canonical.earliest-ending-copy' }] });
  }
  let events = [];
  for (const p of parsed) for (const e of p.result.events) if (!drop.has(e.id)) events.push(e);
  for (const e of events) if (e.turn && drop.has(e.turn)) e.turn = drop.get(e.turn);

  // ---- 2. recorded links ----------------------------------------------------
  const callById = new Map(); // raw tool-call id -> action event (all sources)
  for (const p of parsed) for (const [id, e] of p.result.joins.calls ?? []) if (!drop.has(e.id)) callById.set(id, e);

  const agents = new Map();
  const sessionsByKey = new Map();
  for (const p of parsed) {
    const s = p.source;
    if (s.role === 'session' && !sessionsByKey.has(s.sessionKey)) sessionsByKey.set(s.sessionKey, { key: s.sessionKey, tool: s.tool, sources: [], repo: p.ctx.repo ?? null, isPrivate: p.ctx.isPrivate });
  }
  for (const p of parsed) {
    const s = p.source;
    let sess = sessionsByKey.get(s.sessionKey);
    if (!sess) {
      sess = { key: s.sessionKey, tool: s.tool, sources: [], repo: p.ctx.repo ?? null, isPrivate: p.ctx.isPrivate, missing: ['parent-session-file'] };
      sessionsByKey.set(s.sessionKey, sess);
    }
    sess.sources.push(s.key);
    const st = p.result.stats;
    const agent = {
      key: p.ctx.agentKey,
      session: s.sessionKey,
      source: s.key,
      kind: s.role === 'subagent' ? (s.tool === 'codex' ? (st.origin?.kind === 'guardian' ? 'guardian' : 'child-thread') : 'subagent') : 'main',
      type: s.meta && !s.meta.unreadable && s.tool === 'claude-code' && !p.ctx.isPrivate ? p.ctx.redact(s.meta.agentType ?? null) : null,
      description: s.meta && !s.meta.unreadable && s.tool === 'claude-code' && !p.ctx.isPrivate ? p.ctx.redact(s.meta.description ?? null) : null,
      requestShape: s.meta?.requestShape ?? null,
      depth: s.meta?.spawnDepth ?? st.origin?.depth ?? null,
      models: st.models,
      name: st.agentName ?? null,
      firstAt: st.firstAt,
      lastAt: st.lastAt,
      spawnedBy: null,
      parentAgent: null,
      completion: null,
      missing: [],
    };
    agents.set(agent.key, agent);
    if (p.ctx.sidechainAgentKey && p.result.events.some((e) => e.agent === p.ctx.sidechainAgentKey)) {
      agents.set(p.ctx.sidechainAgentKey, { ...agent, key: p.ctx.sidechainAgentKey, kind: 'inline-sidechain', type: null, description: null, missing: ['spawn-call', 'agent-identity'] });
    }
  }

  // Claude Code sub-agents -> the call that started them.
  const launchByAgentId = new Map();
  for (const p of parsed) for (const l of p.result.joins.agentLaunches ?? []) launchByAgentId.set(l.agentId, l.event);
  const agentIdToKey = new Map();
  for (const p of parsed) {
    const s = p.source;
    if (s.tool !== 'claude-code' || s.role !== 'subagent') continue;
    agentIdToKey.set(s.agentId, p.ctx.agentKey);
    const agent = agents.get(p.ctx.agentKey);
    const byMeta = s.meta?.toolUseId ? callById.get(s.meta.toolUseId) : null;
    const byResult = launchByAgentId.get(s.agentId);
    const call = byMeta ?? byResult ?? null;
    if (!s.meta || s.meta.unreadable) agent.missing.push('agent-metadata');
    if (!call) {
      agent.missing.push('spawn-call');
      continue;
    }
    agent.spawnedBy = call.id;
    agent.parentAgent = call.agent;
    agent.spawnAt = call.at;
    call.facts.spawnedAgent = agent.key;
    links.push({ type: 'spawned', from: call.id, to: agent.key, evidence: EVIDENCE.RECORDED, facts: { via: byMeta ? 'agent-metadata' : 'call-result' } });
    if (call.end && call.facts.handback?.status === 'completed') agent.completion = { at: call.end.at, status: 'completed', via: 'call-result', harnessDurationMs: call.facts.handback.harnessDurationMs };
  }
  for (const [agentId, call] of launchByAgentId) {
    if (!agentIdToKey.has(agentId)) call.missing.push('agent-transcript');
  }
  for (const e of events) {
    if (e.kind === 'action' && e.facts.category === 'delegate' && e.facts.tool !== 'Workflow' && e.source.startsWith('cc-') && !e.facts.spawnedAgent && !e.missing.includes('agent-transcript') && !e.missing.includes('result')) {
      e.missing.push('agent-transcript');
    }
  }

  // Completion notices -> the agent or background task they report on.
  const bgTasks = new Map();
  for (const p of parsed) for (const [id, e] of p.result.joins.backgroundTasks ?? []) bgTasks.set(id, e);
  for (const p of parsed) {
    for (const n of p.result.joins.notifications ?? []) {
      if (drop.has(n.event.id)) continue;
      const agentKey = n.taskId ? agentIdToKey.get(n.taskId) : null;
      const call = n.toolUseId ? callById.get(n.toolUseId) : null;
      if (agentKey) {
        const agent = agents.get(agentKey);
        n.event.facts.about = agentKey;
        links.push({ type: 'completion-notice', from: n.event.id, to: agentKey, evidence: EVIDENCE.RECORDED });
        if (!agent.completion || agent.completion.via !== 'call-result') agent.completion = { at: n.event.at, status: n.status ?? null, via: 'notification', harnessDurationMs: n.event.facts.harnessDurationMs ?? null };
      } else if (n.taskId && bgTasks.has(n.taskId)) {
        const task = bgTasks.get(n.taskId);
        n.event.facts.about = task.id;
        task.facts.completionNotice = n.event.id;
        links.push({ type: 'completion-notice', from: n.event.id, to: task.id, evidence: EVIDENCE.RECORDED });
      } else if (call) {
        n.event.facts.about = call.id;
        links.push({ type: 'completion-notice', from: n.event.id, to: call.id, evidence: EVIDENCE.RECORDED });
      } else {
        n.event.missing.push('reported-task');
      }
    }
    for (const s of p.result.joins.stoppedTasks ?? []) {
      const task = bgTasks.get(s.taskId);
      if (task) {
        task.facts.stoppedBy = s.event.id;
        links.push({ type: 'stopped', from: s.event.id, to: task.id, evidence: EVIDENCE.RECORDED });
      }
    }
  }
  for (const a of agents.values()) {
    if (a.kind === 'subagent' && !a.completion && a.requestShape === 'background') a.missing.push('completion-notice');
  }

  // Codex child threads -> the spawn call whose recorded output named them.
  const spawnByPath = new Map();
  for (const p of parsed) for (const s of p.result.joins.spawns ?? []) spawnByPath.set(`${s.event.session}|${s.agentPath}`, s.event);
  for (const p of parsed) {
    const s = p.source;
    if (s.tool !== 'codex' || s.role !== 'subagent') continue;
    const o = p.result.stats.origin ?? {};
    const agent = agents.get(p.ctx.agentKey);
    const call = o.agentPath ? spawnByPath.get(`${s.sessionKey}|${o.agentPath}`) : null;
    agent.parentAgent = p.ctx.parentAgentKey ?? null;
    if (call) {
      agent.spawnedBy = call.id;
      agent.spawnAt = call.at;
      call.facts.spawnedAgent = agent.key;
      links.push({ type: 'spawned', from: call.id, to: agent.key, evidence: EVIDENCE.RECORDED, facts: { via: 'child-thread-metadata' } });
    } else {
      agent.missing.push(o.kind === 'guardian' ? 'requesting-call' : 'spawn-call');
    }
  }

  // Messages one session sent to another, matched by the recorded message id.
  const received = new Map();
  for (const p of parsed) for (const m of p.result.joins.receivedMessages ?? []) received.set(m.msgId, m.event);
  for (const p of parsed) {
    for (const m of p.result.joins.sentMessages ?? []) {
      const to = received.get(m.msgId);
      if (!to) continue;
      m.event.facts.deliveredTo = to.id;
      to.facts.sentBy = m.event.id;
      links.push({ type: 'message-delivered', from: m.event.id, to: to.id, evidence: EVIDENCE.RECORDED, sessions: [m.event.session, to.session] });
    }
  }

  // Task suggestions a later session's first prompt matches exactly (an inference).
  const firstPrompt = new Map();
  // A first prompt that was a copy of another file's record is that file's start, not this one's.
  for (const p of parsed) if (p.source.role === 'session' && p.result.joins.firstPromptDigest && !drop.has(p.result.joins.firstPromptEvent)) firstPrompt.set(p.result.joins.firstPromptDigest, [...(firstPrompt.get(p.result.joins.firstPromptDigest) ?? []), p.source.sessionKey]);
  const sessionStartT = new Map();
  for (const e of events) if (!sessionStartT.has(e.session) || e.t < sessionStartT.get(e.session)) sessionStartT.set(e.session, e.t);
  for (const p of parsed) {
    for (const c of p.result.joins.chips ?? []) {
      for (const key of firstPrompt.get(c.digest) ?? []) {
        if (key === c.event.session) continue;
        const target = sessionsByKey.get(key);
        if (!(sessionStartT.get(key) >= c.event.t)) continue;
        links.push({ type: 'handoff', from: c.event.id, to: key, evidence: EVIDENCE.INFERRED, inferred: [{ key: 'handoff', value: true, rule: 'handoff.chip-start' }] });
        c.event.inferred.push({ key: 'startedSession', value: key, rule: 'handoff.chip-start' });
        if (target) target.startedFrom = c.event.id;
      }
    }
  }

  // ---- 3. clock rules --------------------------------------------------------
  for (const e of events) {
    if (e.end && e.end.t < e.t) {
      anomalies.push({ kind: 'result-before-call', event: e.id, ms: e.t - e.end.t });
      e.end = { ...e.end, t: e.t, adjusted: true };
    }
  }
  const spawnT = new Map();
  for (const a of agents.values()) {
    if (!a.spawnedBy) continue;
    const call = eventIndex.get(a.spawnedBy);
    if (call) spawnT.set(a.key, call.t);
  }
  for (const e of events) {
    const floor = spawnT.get(e.agent);
    if (floor != null && e.t < floor) {
      anomalies.push({ kind: 'agent-record-before-spawn', event: e.id, ms: floor - e.t });
      e.clock = { recordedT: e.t, raisedTo: floor, rule: 'agent-after-spawn' };
      e.t = floor;
    }
  }

  events.sort(compareEvents);

  // A queued message ends at the record that delivered or withdrew it.
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const e of events) {
    if (e.kind !== 'queue' || !e.facts.resolvedBy || e.end) continue;
    const r = byId.get(e.facts.resolvedBy);
    if (r) e.end = { at: r.at, t: Math.max(r.t, e.t) };
  }

  // ---- 4. sessions, agents, turns, threads, quiet intervals ------------------
  const bySession = new Map();
  for (const e of events) {
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  const quiet = [];
  for (const [key, list] of bySession) {
    const sess = sessionsByKey.get(key);
    // Spans and quiet intervals come from the session's own records. Pull-request links
    // and queue records are stamped out of band, so they are left out of both.
    const timed = list.filter((e) => e.timeFrom === 'record' && e.kind !== 'link' && e.kind !== 'queue');
    sess.firstAt = timed[0]?.at ?? null;
    sess.lastAt = timed.reduce((m, e) => (e.at && (!m || e.at > m) ? e.at : m), null);
    for (let i = 1; i < timed.length; i++) {
      const a = timed[i - 1];
      const b = timed[i];
      if (b.t - a.t >= quietMs) {
        quiet.push({ id: `${key}.quiet.${a.id}`, kind: 'quiet', at: a.at, t: a.t, timeFrom: 'record', end: { at: b.at, t: b.t }, source: a.source, session: key, agent: null, actor: 'none', evidence: EVIDENCE.DERIVED, refs: [], basis: [a.id, b.id], facts: { from: a.at, to: b.at }, derived: { ms: b.t - a.t }, inferred: [], missing: [], turn: null });
      }
    }
    sess.endState = endState(list);
  }
  for (const q of quiet) events.push(q);
  events.sort(compareEvents);

  const turns = new Map();
  for (const e of events) {
    if (!e.turn) continue;
    if (!turns.has(e.turn)) turns.set(e.turn, { id: e.turn, session: e.session, agent: e.agent, events: [], startT: e.t, endT: e.t, stopRecorded: false });
    const t = turns.get(e.turn);
    t.events.push(e.id);
    t.endT = Math.max(t.endT, e.end?.t ?? e.t);
    if (e.kind === 'turn-end') t.stopRecorded = true;
  }

  // Threads: sessions joined by recorded or derived links only.
  const parent = new Map([...sessionsByKey.keys()].map((k) => [k, k]));
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const sourceSession = new Map(parsed.map((p) => [p.source.key, p.source.sessionKey]));
  for (const l of links) {
    if (l.type === 'continuation') union(sourceSession.get(l.from), sourceSession.get(l.to));
    if (l.type === 'message-delivered') union(l.sessions[0], l.sessions[1]);
  }
  const groups = new Map();
  for (const k of sessionsByKey.keys()) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(k);
  }
  const threads = [];
  for (const members of groups.values()) {
    members.sort((a, b) => {
      const fa = sessionsByKey.get(a).firstAt ?? '';
      const fb = sessionsByKey.get(b).firstAt ?? '';
      return fa < fb ? -1 : fa > fb ? 1 : a < b ? -1 : 1;
    });
    const id = `th-${letterHash(members[0], 10)}`;
    for (const m of members) sessionsByKey.get(m).thread = id;
    threads.push({ id, sessions: members });
  }
  threads.sort((a, b) => {
    const fa = sessionsByKey.get(a.sessions[0]).firstAt ?? '';
    const fb = sessionsByKey.get(b.sessions[0]).firstAt ?? '';
    return fa < fb ? -1 : fa > fb ? 1 : a.id < b.id ? -1 : 1;
  });

  return { events, links, anomalies, agents, sessionsByKey, turns, threads };
}

/** What the last records of a session show. Never "ended": logs do not record that. */
function endState(list) {
  const work = list.filter((e) => !['link', 'mode', 'quiet', 'queue', 'hook', 'outcome'].includes(e.kind));
  const last = work[work.length - 1];
  if (!last) return 'no-work-records';
  if (last.kind === 'action' && !last.end) return 'last-record-is-a-call-without-result';
  if (last.kind === 'prompt') return 'last-record-is-an-unanswered-prompt';
  if (last.kind === 'turn-end') return 'last-turn-ended';
  if (last.kind === 'interrupt') return 'last-record-is-an-interruption';
  return `last-record-is-${last.kind}`;
}
