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
import { lookupCommit, originSlug, worktreeList } from '../git.mjs';
import { createRedactor, createSecretsOnlyRedactor } from '../redact.mjs';
import { AGENT_ADDRESS_RE } from '../redaction-patterns.mjs';
import { attributionRoots } from '../worktrees.mjs';
import { localDateRangeInstants } from '../resolve-week.mjs';
import { hostTimezone } from '../config.mjs';
import { assemble, compareEvents } from './assemble.mjs';
import { parseClaudeSource } from './claude.mjs';
import { codexOrigin, parseCodexSource } from './codex.mjs';
import { isBuiltinToolName, LOOKUP_RULES, RULES } from './classify.mjs';
import { assertEventContract } from './evidence.mjs';
import { goalMembership, goalView, normalizeGoalRecord } from './goals.mjs';
import { readBytesAt, tryParse } from './jsonl.mjs';
import { keyPath, recordDigest } from './ids.mjs';
import { createLookup, createReferenceIndex, repoSlug } from './lookup.mjs';
import { gitOutcomes } from './outcomes.mjs';
import { collapse, createWatch, redactThenCut } from './parse-common.mjs';
import { defaultRoots, enumerateClaudeSources, enumerateCodexSources } from './sources.mjs';
import { buildTimeline } from './timeline.mjs';
import { createViews } from './views.mjs';

export { parseLookup } from './lookup.mjs';

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
 *   signal     an optional { aborted } checked between files and before any git read: once
 *              aborted, the build stops with an error and runs no git at all
 *   goals      an optional goal record, { goals: [{ id, title, state?, source?,
 *              observations?, results?, decisions? }], events?: [{ eventId, goalId,
 *              type, at }] }. With it, the history gains `goals` (which sessions did
 *              each goal's work, and how each link is known) and the goal(id) view.
 *              Without it, nothing is scanned and the output doesn't change.
 *   privateText  true for this machine's screen only: strings pass the secrets-only
 *              scrubber (names, folders, addresses, ids and numbers show as written;
 *              secrets stay hidden), and sessions outside the configured repos or in
 *              display-role ones show their content too. Which sessions are linked,
 *              scanned for goal ids, or sent to git doesn't change. The history is
 *              marked privateText and refuses to serialize whole: nothing built this
 *              way may be written to disk, published or shared.
 *   hiddenSessions  how sessions outside the configured repos or in display-role ones
 *              show: 'skeleton' (the default) keeps the kind and time of each step and
 *              no text; 'redacted' keeps their content and titles, every string through
 *              the full redactor. Either way they stay out of every link, goal-id scan,
 *              lookup and git read. With 'redacted' the history is marked
 *              hiddenSessions: 'redacted'; it still serializes, since nothing in it is
 *              unredacted.
 *   usage      true adds `usage.calls`: the token counts (input, cache writes, cache
 *              reads, output) of each model call the log records them for, with its
 *              session, agent, source file, tool, line numbers and time, for every file
 *              read (filter by `t` for the window). Numbers and ids only, never text. A
 *              Claude Code call is one assistant message, counted once across the files a
 *              resumed session copies it into (the earliest-ending file keeps it, as for
 *              events); a Codex call is a token-count record with the call's own counts
 *              whose running total differs from the one before; a sub-agent's opening copy
 *              of its parent's history isn't its call, except in a file whose records all
 *              carry one time, where time can't separate it, and a copy of a parent's call
 *              counts once in its fork family, in the parent's file when that's read and
 *              holds it. Skeleton sessions get none. Without it the history doesn't change.
 *   keepRaw    true keeps, in memory only, each tool call's raw input, the full text of
 *              each `message` the agent wrote and each `prompt`, and the start of the
 *              error text of a call whose result is an error, on a non-enumerable `_raw`
 *              field of the event, for checks that run in the same process, and each
 *              readable file's working folder on the history's own `_raw.cwdOfSource`.
 *              JSON and spreads leave both out, and
 *              display-only and outside sessions never get either, whatever privateText
 *              or hiddenSessions say. Without it the history doesn't change.
 */
export async function buildWorkHistory({ config, from, to, timezone, roots, scope = 'configured', quietMs, git = true, goals: goalInput, privateText = false, hiddenSessions = 'skeleton', usage = false, keepRaw = false, signal = null } = {}) {
  if (!config?.identity) throw new Error('replay: a normalized config is required.');
  if (hiddenSessions !== 'skeleton' && hiddenSessions !== 'redacted') throw new Error(`replay: hiddenSessions is 'skeleton' or 'redacted', not ${JSON.stringify(hiddenSessions)}.`);
  // Private sessions keep their content: on this screen only (privateText), or redacted.
  const showHidden = privateText === true || hiddenSessions === 'redacted';
  const goalRecord = goalInput == null ? null : normalizeGoalRecord(goalInput);
  // The parse-time scan: ids looked for in full text, since the engine keeps clipped copies.
  const watch = goalRecord ? createWatch({ entryIds: goalRecord.entries.map((x) => x.eventId), goalIds: goalRecord.goals.map((g) => g.id) }) : null;
  const tz = timezone ?? config.week?.timezone ?? hostTimezone();
  const { start, endExclusive } = localDateRangeInstants(from, to, tz);
  const startT = start.getTime();
  const endT = endExclusive.getTime();
  const redactor = privateText === true ? createSecretsOnlyRedactor() : createRedactor(config);
  const redact = (s) => (typeof s === 'string' ? redactor.redact(s) : s);
  const deep = (v) => redactKeepingCommitIds(redactor.redact, v);
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
  // Sources whose content is cut to a skeleton: the private ones, unless privateText or
  // hiddenSessions 'redacted' keeps it.
  const hiddenSources = showHidden ? new Set() : privateSources;
  const parsed = [];
  for (const s of keep) {
    const repo = sessionRepo.get(s.sessionKey) ?? null;
    const isPrivate = !repo || repo.role === 'display';
    if (isPrivate) privateSources.add(s.key);
    const agentKey = s.role === 'session' ? `${s.key}:main` : s.key;
    const ctx = {
      redact,
      isPrivate,
      privateText: privateText === true,
      hiddenSessions,
      usage: usage === true,
      keepRaw: keepRaw === true,
      cwd: s.cwd ?? null,
      repo: repo ? { label: repo.label, role: repo.role, path: repo.resolvedPath ?? repo.path } : null,
      agentKey,
      sidechainAgentKey: s.role === 'session' && s.tool === 'claude-code' ? `${s.key}:sidechain` : null,
      parentAgentKey: s.parentSource ? (keep.find((x) => x.key === s.parentSource)?.role === 'session' ? `${s.parentSource}:main` : s.parentSource) : null,
      // Private and display-role sessions are never scanned for goal ids.
      watch: isPrivate ? null : watch,
    };
    let result;
    try {
      result = s.tool === 'codex' ? await parseCodexSource(s, ctx) : await parseClaudeSource(s, ctx);
    } catch (err) {
      result = { events: [], joins: { calls: new Map(), uuids: [] }, coverage: new Map([['(file unreadable)', { count: 1, handling: `skipped: the file could not be read (${String(err?.code ?? 'error')})` }]]), anomalies: [{ kind: 'unreadable-file', source: s.key }], stats: { records: 0, unparsable: 0, oversized: 0, firstAt: s.firstAt, lastAt: s.lastAt, models: [], titles: [] } };
    }
    parsed.push({ source: s, ctx, result });
    if (signal?.aborted) break;
  }
  // Everything from here on runs without a pause, so this is the last point a stop can land.
  if (signal?.aborted) throw Object.assign(new Error('replay: the build was stopped.'), { code: 'ABORTED' });

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
  // A Codex agent address (`/root/wide_fixtures`) names an agent, not a folder: its parts were
  // redacted one by one where it was read (lib/replay/codex.mjs), so the home-path rule doesn't
  // take it here.
  const codexSources = new Set(parsed.filter((p) => p.source.tool === 'codex').map((p) => p.source.key));
  for (const e of a.events) {
    if (hiddenSources.has(e.source)) {
      e.facts = pick(e.facts, PRIVATE_FACTS);
      // A tool name is kept only when it is one of the harness's own; an MCP server or a
      // custom tool is named by the person and can name a client.
      if ('tool' in e.facts && !isBuiltinToolName(e.facts.tool)) e.facts.tool = null;
      e.derived = pick(e.derived, PRIVATE_DERIVED);
      // Who wrote a prompt, and which copy rule placed a record, are not content, and
      // dropping either rule would make an inference read as a record.
      e.inferred = e.inferred.filter((x) => x.key === 'authorship' || x.key === 'canonicalCopy').map(({ key, value, rule }) => ({ key, value, rule }));
    } else if (privateSources.has(e.source) && hiddenSessions === 'redacted' && privateText !== true) {
      // A hash of a raw path or prompt links nothing in a session that's never linked, and
      // anyone holding the history could check a guessed path or prompt against it.
      for (const key of PRIVATE_HASHES) delete e.facts[key];
    }
    const addresses = codexSources.has(e.source) ? ADDRESS_FACTS.filter((k) => typeof e.facts[k] === 'string' && AGENT_ADDRESS_RE.test(e.facts[k])).map((k) => [k, e.facts[k]]) : [];
    e.facts = deep(e.facts);
    for (const [k, v] of addresses) e.facts[k] = v;
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
      title: s.isPrivate && !showHidden ? null : titleOf(s.key),
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
    // The goal and lookup rules label no event; they join the table only with a goal
    // record, so a history built without one is byte for byte what it was.
    rules: Object.fromEntries(goalRecord ? [...RULES, ...LOOKUP_RULES] : RULES),
    turnsById: a.turns,
    sourceSession,
  };
  if (privateText === true) h.privateText = true;
  if (hiddenSessions === 'redacted') h.hiddenSessions = 'redacted';
  if (usage === true) h.usage = { calls: usageCalls(parsed) };
  const views = createViews(h);

  // Goal membership and reverse lookup read the raw joins the adapters kept (moved onto
  // the kept copy of each record), from readable sessions only. Git is asked only about
  // configured repositories that aren't display-role.
  const readable = new Set(sessions.filter((s) => !s.private).map((s) => s.key));
  const liveEvents = new Set(h.events);
  const liveJoins = (k) => parsed.flatMap((p) => p.result.joins[k] ?? []).filter((x) => liveEvents.has(x.event) && readable.has(x.event.session));
  const sessionInfo = new Map(sessions.map((s) => [s.key, s]));
  const firstAtOf = (key) => sessionInfo.get(key)?.firstAt ?? null;
  const readRepos = (config.repos ?? []).filter((r) => r.role !== 'display' && (r.resolvedPath ?? r.path)).map((r) => ({ label: r.label, path: r.resolvedPath ?? r.path }));
  const repoSlugs = new Map();
  // A repository is named by its origin remote (owner and name) when git is read, else
  // by its configured label (a name with no owner).
  const repoSlugOfRepo = (repo) => {
    if (!repoSlugs.has(repo.label)) {
      let slug = null;
      if (git) {
        try {
          slug = originSlug(repo.path);
        } catch {
          slug = null;
        }
      }
      repoSlugs.set(repo.label, repoSlug(slug) ?? repoSlug(repo.label));
    }
    return repoSlugs.get(repo.label);
  };
  // The folders a repository is checked out in: the configured path, the worktrees its
  // own git metadata names (the folders sessions are attributed by), and, when git is
  // read, the worktrees git lists. Never a session's working folder.
  const repoRoots = new Map();
  const rootsOfRepo = (repo) => {
    if (!repoRoots.has(repo.label)) {
      const roots = new Set();
      const add = (p) => {
        const k = keyPath(p);
        if (k) roots.add(k);
      };
      add(repo.path);
      for (const p of attributionRoots(repo.path)) add(p);
      if (git) for (const p of worktreeList(repo.path)) add(p);
      repoRoots.set(repo.label, [...roots].sort());
    }
    return repoRoots.get(repo.label);
  };
  const repoLabelOf = (key) => (readable.has(key) ? a.sessionsByKey.get(key)?.repo?.label ?? null : null);
  const repoOfSession = (key) => readRepos.find((r) => r.label === repoLabelOf(key)) ?? null;
  const repoSlugOf = (key) => {
    const repo = repoOfSession(key);
    return repo ? repoSlugOfRepo(repo) : null;
  };
  // A folder a Codex call ran in is inside the session's repository when it sits under
  // one of its checkouts; a relative folder is, unless it climbs out with "..".
  const workdirInRepo = (key, dir) => {
    const repo = repoOfSession(key);
    if (!repo) return false;
    const k = keyPath(dir);
    if (!/^([A-Za-z]:\/|\/)/.test(k)) return !k.split('/').includes('..');
    return rootsOfRepo(repo).some((r) => k === r || k.startsWith(`${r}/`));
  };
  let refs = null;
  const refIndex = () => (refs ??= createReferenceIndex({ events: h.events, readable, joins: { prs: liveJoins('prs'), commits: liveJoins('commits'), branches: liveJoins('branches') }, repoSlugOf, workdirInRepo }));

  let goalByRawId = null;
  if (goalRecord) {
    // A goal can cite a session by the id its harness gave it: a Claude Code session
    // file's id or a Codex thread's id.
    const harnessIds = new Map();
    for (const p of parsed) {
      const id = p.source.fileId ?? p.source.threadId;
      if (typeof id === 'string' && id) harnessIds.set(id.toLowerCase(), p.source.sessionKey);
    }
    const found = goalMembership({ record: goalRecord, index: refIndex(), watched: liveJoins('watched'), harnessIds, readable, firstAtOf, window: h.window, redact: redactor.redact });
    h.goals = redactor.deepRedact(found);
    goalByRawId = new Map(goalRecord.goals.map((g, i) => [g.id, h.goals[i]]));
  }
  function goal(id) {
    if (!goalByRawId) return null;
    return goalView(goalByRawId.get(id) ?? h.goals.find((g) => g.id === id) ?? null, sessionInfo);
  }

  let lookupFn = null;
  /** Which readable sessions (and goals) point at a pull request, commit, file, or branch. */
  function lookup(query) {
    if (!lookupFn) {
      const sessionCwds = new Map();
      for (const p of parsed) {
        const cwd = p.source.cwd;
        if (!readable.has(p.source.sessionKey) || typeof cwd !== 'string' || !cwd) continue;
        if (!sessionCwds.has(p.source.sessionKey)) sessionCwds.set(p.source.sessionKey, []);
        if (!sessionCwds.get(p.source.sessionKey).includes(cwd)) sessionCwds.get(p.source.sessionKey).push(cwd);
      }
      const goalsOf = h.goals
        ? (keys) => {
            const set = new Set(keys);
            return h.goals.filter((g) => g.members.some((m) => set.has(m.session))).map((g) => g.id);
          }
        : null;
      lookupFn = createLookup({ index: refIndex(), repos: readRepos, repoSlugOfRepo, rootsOfRepo, sessionCwds, firstAtOf, git: git ? { lookupCommit } : null, authorEmails: config.identity.authorEmails, goalsOf, deepRedact: (v) => {
        // The query echoes what was asked, so it gets the plain redactor; the rows are the engine's own.
        const { query, ...rows } = v;
        return { query: redactor.deepRedact(query), ...deep(rows) };
      } });
    }
    return lookupFn(query);
  }

  // Each event by its id, built on the first record() call, so a lookup doesn't scan every
  // event. The first event with an id wins, as a search from the front would find it.
  let eventById = null;
  /** Re-read the original record behind a reference and check its digest. */
  function record(refOrEventId) {
    if (typeof refOrEventId === 'string' && !eventById) {
      eventById = new Map();
      for (const e of h.events) if (!eventById.has(e.id)) eventById.set(e.id, e);
    }
    const refs = typeof refOrEventId === 'string' ? eventById.get(refOrEventId)?.refs ?? [] : [refOrEventId];
    return refs.map((ref) => {
      if (ref.sha) return { ref, verified: null, note: 'a git object; inspect it with git show', record: null };
      const file = files.get(ref.src);
      if (!file) return { ref, verified: false, note: 'source not part of this history', record: null };
      const bytes = readBytesAt(file, ref.off, ref.len);
      if (!bytes) return { ref, verified: false, note: 'the record could not be re-read (file shorter or moved)', record: null };
      const ok = recordDigest(bytes) === ref.digest;
      if (!ok) return { ref, verified: false, note: 'the bytes at this position changed since the history was built', record: null };
      const raw = tryParse(bytes.toString('utf8'));
      return { ref, verified: true, note: null, record: hiddenSources.has(ref.src) ? shapeOnly(raw, redact) : redactor.deepRedact(project(raw, redact)) };
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

  const history = {
    ...h,
    timeline,
    threadTimeline,
    stateAt: (t, opts = {}) => (opts.thread ? threadTimeline(opts.thread)?.stateAt(toT(t), opts) ?? null : timeline.stateAt(toT(t), opts)),
    ...views,
    record,
    goal,
    lookup,
    toJSON() {
      // Private text is for this machine's screen: a caller sends the parts it shows,
      // never the whole history, so nothing built this way lands in a file by accident.
      if (h.privateText) throw new Error('replay: a history built with privateText is for the local screen only and is never serialized whole.');
      const { turnsById, sourceSession: _s, ...rest } = h;
      return { ...rest, turns: [...turnsById.values()].sort((x, y) => (x.id < y.id ? -1 : 1)) };
    },
  };
  // keepRaw: each readable file's working folder, in memory only, beside the events' own
  // `_raw`, so a check can tell an edit inside the session's folder from one outside it.
  if (keepRaw === true) Object.defineProperty(history, '_raw', { value: Object.freeze({ cwdOfSource: new Map(parsed.filter((p) => !privateSources.has(p.source.key) && p.source.cwd).map((p) => [p.source.key, p.source.cwd])) }), enumerable: false });
  // Each Claude Code session's own id (its file's name), by session key, in memory only, so a
  // caller can find files another tool keyed by that id. Not enumerable: no output changes.
  Object.defineProperty(history, 'claudeIds', { value: new Map(parsed.filter((p) => p.source.tool === 'claude-code' && p.source.role === 'session' && typeof p.source.fileId === 'string').map((p) => [p.source.sessionKey, p.source.fileId.toLowerCase()])), enumerable: false });
  return history;
}

const LONG = 2000;

// A commit id is hex that git returned or a harness record holds, in a field the engine
// itself builds: event facts and lookup rows, never a raw record read back or a goal's
// text. One made only of digits (about 1 in 280 twelve-character ids) would otherwise read
// as an account number, so it's kept as it is; any other value is redacted as usual.
const COMMIT_ID_KEYS = new Set(['sha', 'originalHead', 'headAtStart']);
const COMMIT_ID = /^[0-9a-f]{7,40}$/;
function redactKeepingCommitIds(redact, value, key = null) {
  if (typeof value === 'string') return key !== null && COMMIT_ID_KEYS.has(key) && COMMIT_ID.test(value) ? value : redact(value);
  if (Array.isArray(value)) return value.map((v) => redactKeepingCommitIds(redact, v));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactKeepingCommitIds(redact, value[k], k);
    return out;
  }
  return value;
}

// What a private session's event may keep: its kind of step and how it went, and the
// ids that connect it to other events. Never text, paths, commit ids, pull-request
// numbers, or names; the numbers it keeps are exit codes, positions, and durations.
const PRIVATE_FACTS = new Set(['tool', 'category', 'result', 'by', 'during', 'delivery', 'state', 'carries', 'marker', 'decision', 'direction', 'from', 'index', 'origin', 'change', 'started', 'action', 'resolvedBy', 'about', 'spawnedAgent', 'completionNotice', 'stoppedBy', 'deliveredTo', 'sentBy', 'status', 'preventedContinuation', 'harnessDurationMs', 'exitCode']);
const PRIVATE_DERIVED = new Set(['recordedSpanMs', 'waitedMs', 'queuedMs', 'ms']);
/** A Codex event's facts that hold an agent address: a session's own, a message's ends, a call's recipient. */
const ADDRESS_FACTS = ['agentPath', 'author', 'recipient', 'to'];

// Facts that hash raw text, kept for lookup: dropped from a hidden session shown redacted.
const PRIVATE_HASHES = ['fileKey', 'fileKeys', 'promptDigest'];

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
  if (typeof raw === 'string') return projectString(raw, redact);
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

/** One string of a raw record, as record() shows it. A record keeps its line breaks, and
 *  the redactor's field rules read one line at a time, so a value on the line after its
 *  label (`password:` then a new line) is read again with the whitespace collapsed; when
 *  that hides more, the collapsed text is shown. A string over LONG characters is
 *  redacted whole before it's cut, the cut stepped back so it never splits a placeholder.
 *  Anything else is returned as it is and redacted by the caller, as it always was. */
function projectString(s, redact) {
  const whole = redact(s);
  const flat = collapse(whole);
  const again = flat === whole ? flat : redact(flat);
  const linesHid = again !== flat;
  if (!linesHid && s.length <= LONG) return s;
  return redactThenCut(s, LONG, redact, { ending: (n) => `… [${n} more characters]`, whole: linesHid ? again : whole });
}

/** For a private session: the record's top-level shape, never its content. Nested
 *  objects show only how many keys they hold, because their keys can be content. */
function shapeOnly(raw, redact) {
  const shape = (v) => (Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `object(${Object.keys(v).length} keys)` : typeof v);
  const top = raw && typeof raw === 'object' ? Object.fromEntries(Object.keys(raw).sort().map((k) => [redact(k), shape(raw[k])])) : {};
  return { private: 'this session is outside the configured repos or in a display-role repo; only the record shape is shown', type: typeof raw?.type === 'string' ? redact(raw.type) : null, timestamp: typeof raw?.timestamp === 'string' ? raw.timestamp : null, shape: top };
}

/**
 * The model calls the parsed files recorded, numbers and ids only. A call several files hold
 * is counted once. A Claude Code message a resumed or forked session copied into its own file
 * is kept in the earliest-ending file (then the smaller source key), the rule the engine uses
 * for copied events. A Codex sub-agent's file holds copies of its parent's token counts as
 * written, so a Codex call is kept once in its fork family (the threads linked by
 * forked_from_id, up to one that wasn't forked or wasn't read), in the file the fewest forks
 * from the family's root (the parent before its sub-agents), then the earliest-ending. The ids
 * that match the copies are dropped here. Sorted by time, then source, then line.
 */
function usageCalls(parsed) {
  const lastAt = (p) => p.result.stats?.lastAt ?? '';
  const earlier = (p, q) => lastAt(p) < lastAt(q) || (lastAt(p) === lastAt(q) && p.source.key < q.source.key);
  const byThread = new Map(parsed.filter((p) => p.source.tool === 'codex').map((p) => [p.source.threadId, p]));
  const depths = new Map();
  // How many forks lie between a Codex file and one that wasn't forked, among the files read.
  const depth = (p, seen = new Set()) => {
    if (depths.has(p)) return depths.get(p);
    const from = p.source.meta?.forked_from_id;
    const parent = typeof from === 'string' ? byThread.get(from) : null;
    seen.add(p);
    const d = typeof from !== 'string' ? 0 : 1 + (parent && !seen.has(parent) ? depth(parent, seen) : 0);
    depths.set(p, d);
    return d;
  };
  // The thread a Codex file's fork family starts from: forked_from_id followed among the files
  // read, to a thread that wasn't forked or wasn't read. Unrelated sessions never share copies.
  const family = (p) => {
    const seen = new Set();
    let root = p.source.threadId;
    for (let q = p; q && !seen.has(q); q = byThread.get(root)) {
      seen.add(q);
      const from = q.source.meta?.forked_from_id;
      if (typeof from !== 'string') return q.source.threadId;
      root = from;
    }
    return root;
  };
  const keeps = (p, q) => (p.source.tool === 'codex' && depth(p) !== depth(q) ? depth(p) < depth(q) : earlier(p, q));
  const owner = new Map(); // tool, fork family and call id -> the parsed file that keeps it
  const keyOf = (p, c) => (p.source.tool === 'codex' ? `codex\u0000${family(p)}\u0000${c.id}` : `${p.source.tool}\u0000${c.id}`);
  for (const p of parsed) {
    for (const c of p.result.usage ?? []) {
      if (c.id == null) continue;
      const have = owner.get(keyOf(p, c));
      if (!have || keeps(p, have)) owner.set(keyOf(p, c), p);
    }
  }
  const out = [];
  for (const p of parsed) {
    for (const c of p.result.usage ?? []) {
      if (c.id != null && owner.get(keyOf(p, c)) !== p) continue;
      out.push({ session: p.source.sessionKey, agent: c.agent, source: p.source.key, tool: p.source.tool, lines: [...c.lines].sort((a, b) => a - b), t: c.t, input: c.input, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, output: c.output });
    }
  }
  return out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.source < b.source ? -1 : a.source > b.source ? 1 : a.lines[0] - b.lines[0]));
}
