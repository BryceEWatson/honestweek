// lib/replay/saved-sessions.mjs: sessions the engine didn't read from a log this run, given to it
// as they were saved by an earlier run (issue 151).
//
// `honestweek view` can keep each day's history between runs (lib/saved/). A session saved that
// way comes back into a later build, as if its log had been read, once its log is gone (Claude
// Code deletes logs after 30 days by default). The engine takes such a session through
// `buildWorkHistory({ saved })`, and everything downstream (threads, goals, lookups, git
// outcomes, timelines, the checks' context) works on it as on any other. This module turns a
// built session into what's saved, and what's saved back into the engine's own shapes.
//
// What's saved is the redacted build's own output for the session: its steps, agents, links,
// token counts, and the joins that connect it to other sessions and to goals and git (pull
// requests, commits, branches). Nothing raw: fields the engine keeps in memory only (an event's
// `_raw`, `_command`, `_workdir`, `_lineCwd`) are dropped; record ids, message ids and token call
// ids are kept only as hashes; a goal id found in its text is kept as a hash; a log file only as
// the hash of its path. Git outcomes and quiet intervals aren't saved: the build works them out
// again. When saved sessions come back, every string passes the current redactor again.
//
// Ids a saved session shares with another session (record ids a resumed copy repeats, a message's
// id) are compared as hashes, so with `saved` in play the engine hashes the fresh sessions' ids
// the same way before it joins them. Without `saved`, nothing here runs.

import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { prRefsInCommand } from './classify.mjs';
import { pathKey, letterHash } from './ids.mjs';

/** The shape of a saved session; one of another is left out of a build. */
export const SAVED_SESSION_SCHEMA = 1;

/** An id as saved and as compared once saved sessions are in a build. */
export const idHash = (s) => letterHash(`id\u0000${String(s)}`, 24);
/** A log's own session id (a Claude Code file id, a Codex thread id), as saved. */
export const logIdHash = (id) => (typeof id === 'string' && id ? letterHash(`log-id\u0000${id.toLowerCase()}`, 24) : null);
/** How many bytes from a log's start its fingerprint reads. */
export const HEAD_BYTES = 4096;

/**
 * A log file's fingerprint: { size, mtimeMs, head }, `head` a hash of its first HEAD_BYTES bytes,
 * so a file replaced by another of the same size and time still reads as changed. Null when it
 * can't be read.
 */
export function fileFingerprint(path) {
  if (typeof path !== 'string' || !path) return null;
  let fd;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    fd = openSync(path, 'r');
    const n = buf.length ? readSync(fd, buf, 0, buf.length, 0) : 0;
    return { size: st.size, mtimeMs: st.mtimeMs, head: letterHash(buf.subarray(0, n), 16) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** A repository label, as saved: the config's label is matched to it on the way back. */
export const labelHash = (label) => (typeof label === 'string' ? letterHash(`repo-label\u0000${label}`, 16) : null);
/** A goal id or goal-event id found in a session's text, as saved. */
export const tokenHash = (token) => letterHash(`goal-token\u0000${String(token)}`, 24);

/** The links the engine makes from one session's own records, which a saved session brings back
 *  as saved, since the joins behind them aren't saved. */
const OWN_LINKS = new Set(['spawned', 'completion-notice', 'stopped', 'handback', 'program-launch']);
/** Links between sessions a saved session also brings back: a resumed copy's records were let go
 *  when it was saved, and a message's two ends may not both be in this build. The engine makes
 *  them again too, where both sessions are here; each is kept once. */
const SHARED_LINKS = new Set(['continuation', 'message-delivered', 'handoff']);
/** A pull request's repository as it's matched on the way back, without its name on disk. */
export const repoNameHash = (repo) => (typeof repo === 'string' && repo ? letterHash(`repo\u0000${repo.toLowerCase()}`, 24) : null);

/** A pull-request, commit or branch join as saved: every field but its step, which is named by id,
 *  each string redacted except a commit id. */
function joinOut(x, redact) {
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === 'event' || k.startsWith('_')) continue;
    out[k] = typeof v === 'string' && k !== 'sha' ? redact(v) : v;
  }
  if (typeof x.repo === 'string' && x.repo) out.repoHash = repoNameHash(x.repo);
  out.event = x.event.id;
  return out;
}

/** What git says about a step, which every build asks git again rather than keeping. */
const GIT_MISSING = new Set(['readable-session-repository', 'commit-in-session-repository', 'default-branch']);

const ownFields = (e) => {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (!k.startsWith('_')) out[k] = v;
  if (Array.isArray(out.missing)) out.missing = out.missing.filter((m) => !GIT_MISSING.has(m));
  return out;
};

/**
 * exportSession({ key, parsed, a, sessions, links, usage, redact, fileStat }) -> a saved session
 * The redacted build's own parts for one session, ready to write. `a` is the assembled history,
 * `sessions` the history's session records, `usage` its token calls. Null for a session the
 * build doesn't hold. `hashed` says the build already hashed the shared ids (it had saved sessions).
 */
export function exportSession({ key, parsed, a, sessions, links, usage, redact, fileStat = () => null, ranOutside = () => false, hashed = false }) {
  const record = sessions.find((s) => s.key === key);
  if (!record) return null;
  // With saved sessions in the build, the engine has already hashed these ids for the join.
  const hashOnce = hashed ? (x) => x : idHash;
  const mine = parsed.filter((p) => p.source.sessionKey === key);
  const main = mine.find((p) => p.source.role === 'session') ?? null;
  const sourceKeys = new Set(mine.map((p) => p.source.key));
  const events = a.events.filter((e) => e.session === key && sourceKeys.has(e.source) && e.kind !== 'quiet').map(ownFields);
  const eventIds = new Set(events.map((e) => e.id));
  const agents = [...a.agents.values()].filter((x) => x.session === key);
  const agentKeys = new Set(agents.map((x) => x.key));
  const touches = (v) => typeof v === 'string' && (eventIds.has(v) || agentKeys.has(v) || sourceKeys.has(v) || v === key);
  const ownLinks = links.filter((l) => touches(l.from) || touches(l.to) || (Array.isArray(l.sessions) && l.sessions.includes(key)));
  const live = (x) => x?.event && eventIds.has(x.event.id);
  // A join is kept once across files, so one on this session's step can sit in another file's
  // list (a resumed copy's): every file's joins are looked through.
  const j = (k) => parsed.flatMap((p) => p.result.joins?.[k] ?? []).filter(live);
  const repo = a.sessionsByKey.get(key)?.repo ?? null;
  const id = main ? (main.source.tool === 'codex' ? main.source.threadId : main.source.fileId) : null;
  return {
    schema: SAVED_SESSION_SCHEMA,
    key,
    tool: record.tool,
    record,
    repo: repo ? { label: labelHash(repo.label), role: repo.role ?? null } : null,
    logId: logIdHash(id),
    sources: mine.map((p) => {
      const st = fileStat(p.source.file);
      return {
        key: p.source.key,
        tool: p.source.tool,
        role: p.source.role,
        agent: p.ctx.agentKey,
        file: pathKey(p.source.file),
        size: st?.size ?? p.source.size ?? null,
        mtimeMs: st?.mtimeMs ?? null,
        head: st?.head ?? null,
        firstAt: p.result.stats.firstAt ?? p.source.firstAt ?? null,
        lastAt: p.result.stats.lastAt ?? p.source.lastAt ?? null,
        records: p.result.stats.records ?? 0,
        unparsable: p.result.stats.unparsable ?? 0,
        oversized: p.result.stats.oversized ?? 0,
        models: p.result.stats.models ?? [],
        entrypoint: p.result.stats.entrypoint ?? null,
        origin: p.result.stats.origin ? { kind: p.result.stats.origin.kind ?? null } : null,
        // How each record type in the file was handled, and what reading it noticed.
        coverage: [...(p.result.coverage ?? new Map())].map(([k, v]) => [redact(k), { count: v.count, handling: redact(v.handling) }]),
        anomalies: p.result.anomalies ?? [],
      };
    }),
    events,
    agents,
    links: ownLinks,
    // What assembly noticed about its steps (a result stamped before its call, say).
    anomalies: a.anomalies.filter((x) => eventIds.has(x.event)),
    usage: usage.filter((c) => c.session === key).map((c) => ({ ...c, id: c.idHash ?? null })),
    joins: {
      uuids: mine.flatMap((p) => p.result.joins?.uuids ?? []).map((u) => ({ uuid: hashOnce(u.uuid), eventIds: u.eventIds })),
      // A record this session's file repeats from another (a resumed copy) was let go in favour of
      // the original; its id, kind and place are kept, so the original can still say it was copied.
      copies: mine.flatMap((p) => p.result.events).filter((e) => !eventIds.has(e.id) && e.kind !== 'quiet').map((e) => ({ id: e.id, source: e.source, kind: e.kind, refs: e.refs ?? [] })),
      sentMessages: j('sentMessages').map((m) => ({ msgId: hashOnce(m.msgId), event: m.event.id })),
      receivedMessages: j('receivedMessages').map((m) => ({ msgId: hashOnce(m.msgId), event: m.event.id })),
      chips: j('chips').map((c) => ({ digest: c.digest, event: c.event.id })),
      prs: j('prs').map((x) => joinOut(x, redact)),
      commits: j('commits').map((x) => joinOut(x, redact)),
      branches: j('branches').map((x) => joinOut(x, redact)),
      watched: j('watched').map((x) => ({ token: tokenHash(x.token), where: x.where, event: x.event.id })),
      // The pull requests a gh command names, read from the command when it was saved, since the
      // command's own text isn't kept: each repository redacted, with a hash to match it back.
      commandPrs: a.events
        .filter((e) => e.session === key && eventIds.has(e.id) && e.kind === 'action' && e.facts?.category === 'shell' && typeof e._command === 'string')
        .map((e) => ({ event: e.id, ranOutside: ranOutside(e), refs: prRefsInCommand(e._command).map((r) => ({ number: r.number, via: r.via, repoKnown: r.repoKnown, repo: typeof r.repo === 'string' ? redact(r.repo) : r.repo ?? null, ...(typeof r.repo === 'string' && r.repo ? { repoHash: repoNameHash(r.repo) } : {}) })) }))
        .filter((x) => x.refs.length),
      firstPromptDigest: main?.result.joins?.firstPromptDigest ?? null,
      firstPromptEvent: main && eventIds.has(main.result.joins?.firstPromptEvent) ? main.result.joins.firstPromptEvent : null,
    },
  };
}

/**
 * The engine's parsed entries for one saved session, as if its sources had been read: each with
 * the saved steps, the joins the engine matches across sessions, and its token calls. `ctxOf(source)`
 * gives each source the build's context (its repository and whether it's private, from the config
 * as it is now). `resolve(token hash)` is the goal id or goal-event id it stands for, or null.
 */
export function savedAsParsed(saved, { ctxOf, resolveToken = () => null, repoSlug = () => null }) {
  // A pull request's repository comes back as the name the session's repository has now, when it
  // was that one; otherwise it stays as saved, redacted, and matches nothing.
  const slugBack = (x) => {
    if (!x.repoHash) return x;
    const slug = repoSlug();
    const { repoHash, ...rest } = x;
    return slug && repoNameHash(slug) === repoHash ? { ...rest, repo: slug } : rest;
  };
  const events = saved.events.map((e) => ({ ...e, refs: e.refs ?? [], facts: e.facts ?? {}, derived: e.derived ?? {}, inferred: e.inferred ?? [], missing: [...(e.missing ?? [])] }));
  // Marked, in memory only, so assembly says nothing twice that a saved step already says.
  for (const e of events) Object.defineProperty(e, '_saved', { value: true, enumerable: false });
  const byId = new Map(events.map((e) => [e.id, e]));
  // A gh command's pull requests, kept in memory beside its step for the reverse lookup, as the
  // command's own text is for a step read from a log.
  for (const c of saved.joins?.commandPrs ?? []) {
    const e = byId.get(c.event);
    if (!e) continue;
    Object.defineProperty(e, '_prRefs', { value: (c.refs ?? []).map((r) => slugBack({ ...r })), enumerable: false });
    Object.defineProperty(e, '_ranOutside', { value: c.ranOutside === true, enumerable: false });
  }
  const ev = (id) => byId.get(id) ?? null;
  const withEvent = (list, map) => (list ?? []).map((x) => ({ ...map(x), event: ev(x.event) })).filter((x) => x.event);
  const joins = saved.joins ?? {};
  const out = [];
  for (const s of saved.sources) {
    const source = { key: s.key, tool: s.tool, role: s.role, sessionKey: saved.key, file: null, cwd: null, firstAt: s.firstAt, lastAt: s.lastAt, size: s.size, saved: true };
    const ctx = ctxOf(source, s);
    const isMain = s.role === 'session';
    const own = events.filter((e) => e.source === s.key);
    const ownIds = new Set(own.map((e) => e.id));
    const onlyOwn = (list) => list.filter((x) => ownIds.has(x.event.id));
    out.push({
      source,
      ctx,
      result: {
        events: own,
        joins: {
          calls: new Map(),
          uuids: (joins.uuids ?? []).filter((u) => u.eventIds?.some((x) => String(x).startsWith(`${s.key}.`))),
          sentMessages: onlyOwn(withEvent(joins.sentMessages, (m) => ({ msgId: m.msgId }))),
          receivedMessages: onlyOwn(withEvent(joins.receivedMessages, (m) => ({ msgId: m.msgId }))),
          chips: onlyOwn(withEvent(joins.chips, (c) => ({ digest: c.digest }))),
          prs: onlyOwn(withEvent(joins.prs, (x) => slugBack({ ...x }))),
          commits: onlyOwn(withEvent(joins.commits, (x) => slugBack({ ...x }))),
          branches: onlyOwn(withEvent(joins.branches, (x) => ({ ...x }))),
          watched: onlyOwn(withEvent(joins.watched, (x) => ({ token: resolveToken(x.token), where: x.where }))).filter((x) => x.token != null),
          firstPromptDigest: isMain ? joins.firstPromptDigest ?? null : null,
          firstPromptEvent: isMain ? joins.firstPromptEvent ?? null : null,
          programStart: null,
          hookLaunches: [],
        },
        coverage: new Map(Array.isArray(s.coverage) ? s.coverage : []),
        anomalies: Array.isArray(s.anomalies) ? s.anomalies : [],
        copyStubs: (joins.copies ?? []).filter((c) => c.source === s.key).map((c) => ({ id: c.id, kind: c.kind, refs: c.refs ?? [], facts: {}, derived: {}, inferred: [], missing: [] })),
        stats: { records: s.records ?? 0, unparsable: s.unparsable ?? 0, oversized: s.oversized ?? 0, firstAt: s.firstAt, lastAt: s.lastAt, models: s.models ?? [], titles: [], entrypoint: s.entrypoint ?? null, origin: s.origin ?? null },
        usage: (saved.usage ?? []).filter((c) => c.source === s.key).map((c) => ({ id: c.id, agent: c.agent, t: c.t, lines: c.lines ?? [], input: c.input, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, output: c.output, ...(c.ttl ? { ttl: c.ttl } : {}), hashed: true })),
      },
    });
  }
  return out;
}

/**
 * After assembly: each saved session's own agents and the links its own records made come back as
 * saved, replacing what assembly could make without the joins behind them; anomalies about its
 * steps are left out (they weren't saved). Links between sessions that assembly made (a resumed
 * copy, a message delivered, a hand-off) stay.
 */
export function restoreSaved(a, savedList) {
  if (!savedList.length) return;
  const keys = new Set(savedList.map((s) => s.key));
  const savedEvents = new Set(savedList.flatMap((s) => s.events.map((e) => e.id)));
  const savedSources = new Set(savedList.flatMap((s) => s.sources.map((x) => x.key)));
  for (const [k, agent] of a.agents) if (keys.has(agent.session)) a.agents.delete(k);
  for (const s of savedList) for (const agent of s.agents ?? []) a.agents.set(agent.key, { ...agent, missing: [...(agent.missing ?? [])] });
  const isSaved = (v) => typeof v === 'string' && (savedEvents.has(v) || keys.has(v) || savedSources.has(v) || savedSources.has(v.replace(/:.*$/, '')));
  const kept = a.links.filter((l) => !(OWN_LINKS.has(l.type) && (isSaved(l.from) || isSaved(l.to))));
  const seen = new Set(kept.map((l) => `${l.type}\u0000${l.from}\u0000${l.to}`));
  for (const s of savedList) {
    for (const l of s.links ?? []) {
      if (!OWN_LINKS.has(l.type) && !SHARED_LINKS.has(l.type)) continue;
      const k = `${l.type}\u0000${l.from}\u0000${l.to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      kept.push(l);
    }
  }
  a.links.length = 0;
  a.links.push(...kept);
  const keptAnomalies = a.anomalies.filter((x) => !savedEvents.has(x.event));
  a.anomalies.length = 0;
  a.anomalies.push(...keptAnomalies, ...savedList.flatMap((s) => s.anomalies ?? []));
  for (const s of savedList) {
    const sess = a.sessionsByKey.get(s.key);
    if (!sess) continue;
    if (s.record.launchedBy && !sess.launchedBy) sess.launchedBy = s.record.launchedBy;
    if (s.record.startedFrom && !sess.startedFrom) sess.startedFrom = s.record.startedFrom;
    sess.missing = [...(s.record.missing ?? [])];
  }
}
