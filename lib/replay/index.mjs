// lib/replay/index.mjs — build an evidence-backed, time-scrubbable work history.
//
// buildWorkHistory() reads the session logs whose recorded span overlaps a window,
// turns every record into typed events that point back to the exact line they came
// from, connects sessions, agents and hand-offs where the records connect them, asks
// git what happened to the commits and pull requests the logs mention, and returns a
// history that can be replayed to any moment and drilled into down to the record.
//
// Privacy is the same as everywhere in honestweek: deterministic, local, no network,
// every emitted string redacted, display-role repos never git-read. Sessions outside
// the configured repos are left out by default; with scope "all" they appear as
// content-free skeletons (kind, time and tool category only).

import { matchRepo } from '../claude-adapter.mjs';
import { createRedactor } from '../redact.mjs';
import { localDateRangeInstants } from '../resolve-week.mjs';
import { hostTimezone } from '../config.mjs';
import { assemble, compareEvents } from './assemble.mjs';
import { parseClaudeSource } from './claude.mjs';
import { codexOrigin, parseCodexSource } from './codex.mjs';
import { isBuiltinToolName, RULES } from './classify.mjs';
import { assertEventContract } from './evidence.mjs';
import { readBytesAt, tryParse } from './jsonl.mjs';
import { recordDigest } from './ids.mjs';
import { gitOutcomes } from './outcomes.mjs';
import { defaultRoots, enumerateClaudeSources, enumerateCodexSources } from './sources.mjs';
import { buildTimeline } from './timeline.mjs';
import { createViews } from './views.mjs';

export const HISTORY_SCHEMA_VERSION = 1;

/**
 * buildWorkHistory(options) -> Promise<WorkHistory>
 *   config     normalized honestweek config (identity, repos, redaction, week.timezone)
 *   from, to   YYYY-MM-DD, inclusive, read in `timezone`
 *   timezone   IANA zone; default config.week.timezone, else the host zone
 *   roots      { claude: [dir], codex: [dir] }; default the standard locations
 *   scope      'configured' (default) or 'all'
 *   quietMs    shortest gap reported as a quiet interval (default 20 minutes)
 *   git        false skips the git outcome lookups (tests of parsing alone)
 */
export async function buildWorkHistory({ config, from, to, timezone, roots, scope = 'configured', quietMs, git = true } = {}) {
  if (!config?.identity) throw new Error('replay: a normalized config is required.');
  const tz = timezone ?? config.week?.timezone ?? hostTimezone();
  const { start, endExclusive } = localDateRangeInstants(from, to, tz);
  const startT = start.getTime();
  const endT = endExclusive.getTime();
  const redactor = createRedactor(config);
  const redact = (s) => (typeof s === 'string' ? redactor.redact(s) : s);
  const r = roots ?? defaultRoots();

  const claude = await enumerateClaudeSources(r.claude ?? [], startT, endT - 1);
  const codex = await enumerateCodexSources(r.codex ?? [], startT, endT - 1);

  // Codex child threads belong to their parent's session when the parent is present.
  const byThread = new Map(codex.sources.map((s) => [s.threadId, s]));
  for (const s of codex.sources) {
    const o = codexOrigin(s.meta);
    if (o.kind !== 'child-thread' && o.kind !== 'guardian') continue;
    let root = s;
    let parentAgent = null;
    const seen = new Set();
    for (let p = byThread.get(codexOrigin(root.meta).parentThreadId); p && !seen.has(p.key); p = byThread.get(codexOrigin(p.meta).parentThreadId)) {
      seen.add(p.key);
      if (!parentAgent) parentAgent = p;
      root = p;
      if (!['child-thread', 'guardian'].includes(codexOrigin(p.meta).kind)) break;
    }
    if (root !== s) {
      s.role = 'subagent';
      s.sessionKey = root.key;
      s.parentSource = parentAgent.key;
    }
  }

  const skipped = { notWrittenSinceBeforeWindow: claude.skipped.notWrittenSinceBeforeWindow + codex.skipped.notWrittenSinceBeforeWindow, outsideWindow: claude.skipped.outsideWindow + codex.skipped.outsideWindow, noTimestamps: claude.skipped.noTimestamps + codex.skipped.noTimestamps, outsideConfiguredRepos: 0 };
  // One file reachable through two roots (overlapping or repeated roots) is one source.
  const seenKeys = new Set();
  const all = [...claude.sources, ...codex.sources].filter((s) => !seenKeys.has(s.key) && seenKeys.add(s.key));
  const sessionRepo = new Map();
  for (const s of all) {
    if (s.role !== 'session') continue;
    sessionRepo.set(s.sessionKey, matchRepo(s.cwd, config));
  }
  const keep = all.filter((s) => {
    const repo = sessionRepo.get(s.sessionKey) ?? null;
    if (!repo && scope !== 'all') {
      if (s.role === 'session') skipped.outsideConfiguredRepos += 1;
      return false;
    }
    return true;
  });
  keep.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const files = new Map(keep.map((s) => [s.key, s.file]));
  const privateSources = new Set();
  const parsed = [];
  for (const s of keep) {
    const repo = sessionRepo.get(s.sessionKey) ?? null;
    const isPrivate = !repo || repo.role === 'display';
    if (isPrivate) privateSources.add(s.key);
    const agentKey = s.role === 'session' ? `${s.key}:main` : s.key;
    const ctx = {
      redact,
      isPrivate,
      cwd: s.cwd ?? null,
      repo: repo ? { label: repo.label, role: repo.role, path: repo.resolvedPath ?? repo.path } : null,
      agentKey,
      sidechainAgentKey: s.role === 'session' && s.tool === 'claude-code' ? `${s.key}:sidechain` : null,
      parentAgentKey: s.parentSource ? (keep.find((x) => x.key === s.parentSource)?.role === 'session' ? `${s.parentSource}:main` : s.parentSource) : null,
    };
    let result;
    try {
      result = s.tool === 'codex' ? await parseCodexSource(s, ctx) : await parseClaudeSource(s, ctx);
    } catch (err) {
      result = { events: [], joins: { calls: new Map(), uuids: [] }, coverage: new Map([['(file unreadable)', { count: 1, handling: `skipped: the file could not be read (${String(err?.code ?? 'error')})` }]]), anomalies: [{ kind: 'unreadable-file', source: s.key }], stats: { records: 0, unparsable: 0, oversized: 0, firstAt: s.firstAt, lastAt: s.lastAt, models: [], titles: [] } };
    }
    parsed.push({ source: s, ctx, result });
  }

  const a = assemble({ parsed, quietMs });

  // Git: only for sessions in featured or reference repos.
  let gitPart = { events: [], sources: [], notes: [] };
  if (git) {
    const sessionsForGit = new Map([...a.sessionsByKey].map(([k, s]) => [k, { repo: s.repo ? config.repos.find((x) => x.label === s.repo.label) ?? null : null, isPrivate: s.isPrivate }]));
    const live = new Set(a.events);
    const commits = parsed.flatMap((p) => p.result.joins.commits ?? []).filter((c) => live.has(c.event));
    const prs = parsed.flatMap((p) => p.result.joins.prs ?? []).filter((x) => live.has(x.event));
    gitPart = gitOutcomes({ config, sessionsByKey: sessionsForGit, commits, prs, redact });
    for (const e of gitPart.events) a.events.push(e);
    a.events.sort(compareEvents);
  }

  // Backstops, applied once to everything the history returns: a private session's
  // events keep only structural facts, and every string fact passes the redactor.
  for (const e of a.events) {
    if (privateSources.has(e.source)) {
      e.facts = pick(e.facts, PRIVATE_FACTS);
      // A tool name is kept only when it is one of the harness's own; an MCP server or a
      // custom tool is named by the person and can name a client.
      if ('tool' in e.facts && !isBuiltinToolName(e.facts.tool)) e.facts.tool = null;
      e.derived = pick(e.derived, PRIVATE_DERIVED);
      // Who wrote a prompt, and which copy rule placed a record, are not content, and
      // dropping either rule would make an inference read as a record.
      e.inferred = e.inferred.filter((x) => x.key === 'authorship' || x.key === 'canonicalCopy').map(({ key, value, rule }) => ({ key, value, rule }));
    }
    e.facts = redactor.deepRedact(e.facts);
  }
  for (const e of a.events) assertEventContract(e, RULES);

  // A Codex child thread whose parent rollout is not in this history.
  for (const p of parsed) {
    if (p.source.tool !== 'codex' || p.source.role !== 'session') continue;
    const kind = p.result.stats.origin?.kind;
    if (kind === 'child-thread' || kind === 'guardian') {
      const s = a.sessionsByKey.get(p.source.sessionKey);
      if (s) s.missing = [...(s.missing ?? []), 'parent-thread-transcript'];
    }
  }

  // Sessions and agents as plain records.
  const titleOf = (sessKey) => {
    const main = parsed.find((p) => p.source.key === sessKey);
    const titles = main?.result.stats.titles ?? [];
    const custom = titles.filter((x) => x.kind === 'custom-title').at(-1);
    const ai = titles.filter((x) => x.kind === 'ai-title').at(-1);
    return custom?.text ?? ai?.text ?? null;
  };
  const turnsBySession = new Map();
  for (const t of a.turns.values()) {
    if (!turnsBySession.has(t.session)) turnsBySession.set(t.session, []);
    turnsBySession.get(t.session).push(t);
  }
  const sessions = [...a.sessionsByKey.values()]
    .map((s) => ({
      key: s.key,
      tool: s.tool,
      thread: s.thread ?? null,
      repo: s.repo ? redact(s.repo.label) : null,
      repoRole: s.repo?.role ?? null,
      private: s.isPrivate,
      title: s.isPrivate ? null : titleOf(s.key),
      firstAt: s.firstAt ?? null,
      lastAt: s.lastAt ?? null,
      endState: s.endState ?? 'no-work-records',
      startedFrom: s.startedFrom ?? null,
      sources: [...s.sources].sort(),
      agents: [...a.agents.values()].filter((x) => x.session === s.key).map((x) => x.key).sort(),
      turns: (turnsBySession.get(s.key) ?? []).sort((x, y) => x.startT - y.startT || (x.id < y.id ? -1 : 1)).map((t) => t.id),
      missing: s.missing ?? [],
    }))
    .sort((x, y) => ((x.firstAt ?? '') < (y.firstAt ?? '') ? -1 : (x.firstAt ?? '') > (y.firstAt ?? '') ? 1 : x.key < y.key ? -1 : 1));
  const agents = [...a.agents.values()].sort((x, y) => (x.key < y.key ? -1 : 1));

  // Coverage: every record type seen, how it was handled, by tool.
  const coverage = {};
  for (const p of parsed) {
    const tool = p.source.tool;
    coverage[tool] ??= {};
    for (const [k, v] of p.result.coverage) {
      const c = (coverage[tool][redact(k)] ??= { count: 0, handling: redact(v.handling) });
      c.count += v.count;
    }
  }
  const anomalies = redactor.deepRedact([...parsed.flatMap((p) => p.result.anomalies), ...a.anomalies]);

  const sourceSession = new Map(parsed.map((p) => [p.source.key, p.source.sessionKey]));
  const timeline = buildTimeline(a.events, { agents, sessions });

  const h = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    window: { from, to, timezone: tz, startAt: start.toISOString(), endAt: endExclusive.toISOString(), startT, endT },
    scope,
    sources: parsed.map((p) => ({ key: p.source.key, tool: p.source.tool, role: p.source.role, session: p.source.sessionKey, agent: p.ctx.agentKey, private: p.ctx.isPrivate, records: p.result.stats.records, unparsable: p.result.stats.unparsable, oversized: p.result.stats.oversized })).concat(gitPart.sources.map((g) => ({ key: g.key, tool: 'git', role: 'repository', repo: redact(g.repo) }))),
    sessions,
    agents,
    threads: a.threads,
    events: a.events,
    links: a.links,
    anomalies,
    gitNotes: redactor.deepRedact(gitPart.notes),
    coverage,
    skipped,
    rules: Object.fromEntries(RULES),
    turnsById: a.turns,
    sourceSession,
  };
  const views = createViews(h);

  /** Re-read the original record behind a reference and check its digest. */
  function record(refOrEventId) {
    const refs = typeof refOrEventId === 'string' ? h.events.find((e) => e.id === refOrEventId)?.refs ?? [] : [refOrEventId];
    return refs.map((ref) => {
      if (ref.sha) return { ref, verified: null, note: 'a git object; inspect it with git show', record: null };
      const file = files.get(ref.src);
      if (!file) return { ref, verified: false, note: 'source not part of this history', record: null };
      const bytes = readBytesAt(file, ref.off, ref.len);
      if (!bytes) return { ref, verified: false, note: 'the record could not be re-read (file shorter or moved)', record: null };
      const ok = recordDigest(bytes) === ref.digest;
      if (!ok) return { ref, verified: false, note: 'the bytes at this position changed since the history was built', record: null };
      const raw = tryParse(bytes.toString('utf8'));
      return { ref, verified: true, note: null, record: privateSources.has(ref.src) ? shapeOnly(raw, redact) : redactor.deepRedact(project(raw, redact)) };
    });
  }

  // A timeline over one thread's sessions only, so scrubbing a thread is not mixed
  // with whatever else was running at the same moment. Built on first use, cached.
  const scoped = new Map();
  function threadTimeline(threadId) {
    if (scoped.has(threadId)) return scoped.get(threadId);
    const th = h.threads.find((x) => x.id === threadId);
    if (!th) return null;
    const members = new Set(th.sessions);
    const tl = buildTimeline(h.events.filter((e) => members.has(e.session)), { agents: agents.filter((x) => members.has(x.session)), sessions: sessions.filter((x) => members.has(x.key)) });
    scoped.set(threadId, tl);
    return tl;
  }
  const toT = (t) => (typeof t === 'string' ? Date.parse(t) : t);

  return {
    ...h,
    timeline,
    threadTimeline,
    stateAt: (t, opts = {}) => (opts.thread ? threadTimeline(opts.thread)?.stateAt(toT(t), opts) ?? null : timeline.stateAt(toT(t), opts)),
    ...views,
    record,
    toJSON() {
      const { turnsById, sourceSession: _s, ...rest } = h;
      return { ...rest, turns: [...turnsById.values()].sort((x, y) => (x.id < y.id ? -1 : 1)) };
    },
  };
}

const LONG = 2000;

// What a private session's event may keep: its kind of step and how it went, and the
// ids that connect it to other events. Never text, paths, commit ids, pull-request
// numbers, or names; the numbers it keeps are exit codes, positions, and durations.
const PRIVATE_FACTS = new Set(['tool', 'category', 'result', 'by', 'during', 'delivery', 'state', 'carries', 'marker', 'decision', 'direction', 'from', 'index', 'origin', 'change', 'started', 'action', 'resolvedBy', 'about', 'spawnedAgent', 'completionNotice', 'stoppedBy', 'deliveredTo', 'sentBy', 'status', 'preventedContinuation', 'harnessDurationMs', 'exitCode']);
const PRIVATE_DERIVED = new Set(['recordedSpanMs', 'waitedMs', 'queuedMs', 'ms']);

function pick(obj, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (allowed.has(k) && (v === null || typeof v !== 'object')) out[k] = v;
  return out;
}

/** A raw record made safe to show: reasoning removed, long strings cut, and object
 *  keys redacted too, since some records key their values by free text (answers are
 *  keyed by the question). */
function project(raw, redact, depth = 0) {
  if (depth > 12) return '[nested too deep]';
  if (typeof raw === 'string') return raw.length > LONG ? `${raw.slice(0, LONG)}… [${raw.length - LONG} more characters]` : raw;
  if (Array.isArray(raw)) return raw.map((x) => project(x, redact, depth + 1));
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.type === 'thinking' || raw.type === 'redacted_thinking') return { type: raw.type, omitted: 'private model reasoning is not shown' };
  if (raw.type === 'reasoning' || raw.encrypted_content) return { type: raw.type ?? 'reasoning', omitted: 'private model reasoning is not shown' };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    let key = redact(k);
    while (key in out) key = `${key} `;
    out[key] = k === 'thinking' || k === 'signature' || k === 'encrypted_content' ? '[omitted]' : project(v, redact, depth + 1);
  }
  return out;
}

/** For a private session: the record's top-level shape, never its content. Nested
 *  objects show only how many keys they hold, because their keys can be content. */
function shapeOnly(raw, redact) {
  const shape = (v) => (Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `object(${Object.keys(v).length} keys)` : typeof v);
  const top = raw && typeof raw === 'object' ? Object.fromEntries(Object.keys(raw).sort().map((k) => [redact(k), shape(raw[k])])) : {};
  return { private: 'this session is outside the configured repos or in a display-role repo; only the record shape is shown', type: typeof raw?.type === 'string' ? redact(raw.type) : null, timestamp: typeof raw?.timestamp === 'string' ? raw.timestamp : null, shape: top };
}
