// lib/view/data.mjs: the data behind `honestweek view`'s pages.
//
// This is the only file that turns a request's `private=1` into the engine's private
// text option. It holds one engine build per mode:
//
//   redacted  every string passes the full redactor. It starts as soon as the page
//             server does, and answers every request that doesn't ask for private text.
//   private   names, folders and ids show as written; secrets stay hidden. It's built
//             in memory the first time a request carries private=1, never written to
//             disk, and never sent to a request without private=1. If it fails, those
//             requests get the redacted answer with a note saying so.
//
// Both builds read the same folders and window, passed in explicitly, so the switch
// changes only text, never which sessions link to which or which goals they join. Goals
// are addressed by a key made from the raw goal id, the same in both builds, because a
// redacted id can collide with another and isn't found in the private build.
//
// Every answer is JSON-shaped data for this machine's own screen. Nothing here writes a
// file, and nothing here reads an original log line except /api/record, on request.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildWorkHistory } from '../replay/index.mjs';
import { normalizeGoalRecord } from '../replay/goals.mjs';
import { letterHash } from '../replay/ids.mjs';
import { createRedactor, createSecretsOnlyRedactor } from '../redact.mjs';
import { createLeakCounter } from './leaks.mjs';
import { buildTimeline } from '../replay/timeline.mjs';
import { privateWordCount, privateWordsNote } from '../private-words.mjs';
import { eventRow, exportThread, frameAt, frameMoments, sessionGroup, timeNoteOf, whoOf } from './replay-export.mjs';
import { buildWordIndex, createWordSearch, cutRedacted } from './word-index.mjs';

/** The most moments a goal page samples per member session. */
const GOAL_FRAMES = 600;
/** Threads kept built per mode; the least recently opened one goes first. */
export const REPLAY_CACHE_SIZE = 32;

/** The rules behind results the page computes itself, beside the engine's own. */
export const VIEW_RULES = Object.freeze({
  'view.shared-words': 'A prompt shares some of the words you typed. The score counts how many of your words appear in it as whole words; sharing words doesn\'t mean it was about the same thing.',
  'view.similar-prompt': 'Two prompts share a large part of their words (the shared words divided by all the words either uses). Similar wording doesn\'t mean similar work.',
});

/** The five evidence words every page uses, in plain words. */
export const EVIDENCE_KEY = Object.freeze({
  recorded: 'A log line or git says so directly.',
  derived: 'Computed only from recorded facts, such as a count or the time between two lines.',
  inferred: "A named rule's best reading of the records. It can be wrong, and the rule is named.",
  missing: "Evidence I'd expect is absent, such as a call with no recorded result.",
  ambiguous: 'The records fit more than one way, such as a pull request number two repositories share.',
});

const NO_GOAL_LIST = 'No goal list was given. A goal list is a JSON file of your goals and the changes made to them: { "goals": [{ "id": "g-1", "title": "Ship the parser" }], "events": [] }. Name it with --goals <file>, or set "goalsFile" in your config. Search and replay work without one.';

/** Where honestweek is published, read from its own package.json so no owner name is
 *  written into this code: "owner/name" on GitHub. */
function packageSlug() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const m = String(pkg?.repository?.url ?? pkg?.homepage ?? '').match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/].*)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * The made-up-data notice and the commands to try honestweek on your own logs, written the
 * way the person ran it (`run`): set it up, then look. The plugin comes last, for the weekly
 * summary inside Claude Code, because it doesn't give the browser page.
 */
export function demoNotice(run) {
  const slug = packageSlug();
  const commands = [
    { step: 'Set it up in your project folder', command: `${run} init` },
    { step: 'Look at your own logs', command: `${run} view` },
    ...(slug ? [{ step: 'For the weekly summary inside Claude Code, install it as a Claude Code plugin', command: `claude plugin marketplace add ${slug}` }, { step: 'For the weekly summary inside Claude Code, install it as a Claude Code plugin', command: 'claude plugin install honestweek@honestweek' }] : []),
  ];
  return Object.freeze({
    notice: "This is a made-up week. Every session, name and commit here is invented, so nothing on these pages is real. This run treats the made-up project's name as a private word, so Show private text has something to show.",
    commands: Object.freeze(commands.map((c) => Object.freeze(c))),
  });
}

/** The notice as someone who hasn't installed anything would run it: from GitHub with npx. */
export const DEMO_NOTICE = (() => {
  const slug = packageSlug();
  return demoNotice(slug ? `npx github:${slug}` : 'npx honestweek');
})();

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'so', 'that', 'the', 'then', 'this', 'to', 'up', 'we', 'with', 'you', 'your', 'i', 'redacted']);
const MARKERS = /\[redacted:[a-z]+\]/g;

/** A goal's key: a letter hash of its raw id, so it never shows the id and the redactor
 *  never alters it. */
export function goalKey(rawId) {
  return `g${letterHash(`goal\u0000${String(rawId)}`, 15)}`;
}

/** Lowercased words of a text, its redaction markers taken out first. */
export function wordsOf(text) {
  return (String(text ?? '').replace(MARKERS, ' ').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? []).filter((w) => w.length >= 2 && !STOP.has(w));
}

/** A small least-recently-used map: get() refreshes an entry, set() drops the oldest
 *  once it holds more than `size`. */
export function createLru(size) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > size) map.delete(map.keys().next().value);
    },
    has: (key) => map.has(key),
    keys: () => [...map.keys()],
    get size() {
      return map.size;
    },
  };
}

const json = (status, body) => ({ status, body });
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const QUERY_ID_RE = /^q[a-p]{16}$/;
/** The most typed queries one run keeps; the oldest goes first. */
const MAX_QUERIES = 1000;

/** A string in a raw record whose lines, joined, read as a secret field (a password on
 *  the line after its label) is shown joined and redacted again; any other string keeps
 *  its line breaks. The engine already joins the text it keeps for steps this way. */
function joinLinesWhereNeeded(value, redact, depth = 0) {
  if (depth > 64) return value;
  if (typeof value === 'string') {
    if (!/\s/.test(value)) return value;
    const one = value.replace(/\s+/g, ' ').trim();
    const again = redact(one);
    return again === one ? value : again;
  }
  if (Array.isArray(value)) return joinBlocksWhereNeeded(value.map((v) => joinLinesWhereNeeded(v, redact, depth + 1)), redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[joinLinesWhereNeeded(k, redact, depth + 1)] = joinLinesWhereNeeded(v, redact, depth + 1);
    return out;
  }
  return value;
}

/** A list whose text is split across its items (a tool result's content blocks, with a
 *  password's label ending one and its value starting the next) is read joined too. When
 *  the joined text redacts differently from its pieces, the list's text is shown joined
 *  and redacted, in its first text item, and the other text items are dropped. */
function joinBlocksWhereNeeded(items, redact) {
  const textOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (typeof v.text === 'string' ? v.text : typeof v.content === 'string' ? v.content : null) : null);
  const at = items.map((v, i) => (textOf(v) === null ? -1 : i)).filter((i) => i >= 0);
  if (at.length < 2) return items;
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  const pieces = at.map((i) => flat(textOf(items[i])));
  const joined = redact(pieces.join(' '));
  if (joined === pieces.map((p) => redact(p)).join(' ')) return items;
  const first = items[at[0]];
  const merged = typeof first === 'string' ? joined : { ...first, [typeof first.text === 'string' ? 'text' : 'content']: joined };
  return items.flatMap((v, i) => (i === at[0] ? [merged] : at.includes(i) ? [] : [v]));
}

/** A count of a goal's sessions, no stronger than the weakest session it counts: one
 *  joined only by a rule, or ambiguously, makes the count inferred. The split by how each
 *  joins rides along, so the page can say how many of each. */
export function memberCount(members) {
  const n = (f) => members.filter(f).length;
  const weak = members.some((m) => m.evidence === 'inferred' || m.evidence === 'missing' || m.ambiguous === true);
  return {
    value: members.length,
    evidence: weak ? 'inferred' : 'derived',
    recorded: n((m) => m.evidence !== 'inferred' && m.evidence !== 'missing' && m.ambiguous !== true),
    inferred: n((m) => (m.evidence === 'inferred' || m.evidence === 'missing') && m.ambiguous !== true),
    ambiguous: n((m) => m.ambiguous === true),
    assigned: n((m) => (m.joins ?? []).some((j) => j.type === 'cited-session')),
  };
}

/** The same split as plain numbers beside a goal, which the home page's goal card reads. */
function goalSplit(members) {
  const { recorded, inferred, ambiguous, assigned } = memberCount(members);
  return { recorded, inferred, ambiguous, assigned };
}

/**
 * createViewData(options) -> { start, status, route, leakCheck, routes }
 *   config        the normalized config (with the demo's made-up term in demo mode)
 *   roots         { claude: [dir], codex: [dir] }, always explicit
 *   from, to      YYYY-MM-DD, inclusive; timezone the IANA zone they're read in
 *   goalRecord    the parsed goal list, or null
 *   demo          true in demo mode
 *   selfTest      true with --self-test
 *   buildHistory  the engine's buildWorkHistory (tests pass a wrapper)
 */
// The private-word count and note live in lib/private-words.mjs, shared with init.
export { privateWordCount, privateWordsNote };

export function createViewData({ config, roots, from, to, timezone, goalRecord = null, demo = false, selfTest = false, command = 'honestweek', buildHistory = buildWorkHistory, cacheSize = REPLAY_CACHE_SIZE, now = () => Date.now() }) {
  const wordCount = privateWordCount(config);
  const demoNote = demo ? demoNotice(command) : null;
  const record = goalRecord ? normalizeGoalRecord(goalRecord) : null;
  const keys = record ? record.goals.map((g) => goalKey(g.id)) : [];
  const indexOfKey = new Map(keys.map((k, i) => [k, i]));
  const fullRedactor = createRedactor(config);
  const secretsRedactor = createSecretsOnlyRedactor();
  const redactFor = { redacted: (s) => fullRedactor.redact(String(s)), private: (s) => secretsRedactor.redact(String(s)) };
  const leaks = createLeakCounter(config);
  const startedAt = now();
  const slot = () => ({ state: 'idle', startedAt: null, ms: null, error: null, h: null, promise: null, replays: createLru(cacheSize), eventsById: null });
  const builds = { redacted: slot(), private: slot() };
  const words = { state: 'waiting', ms: null, error: null, search: null, sessions: 0 };

  const reason = (err) => cutRedacted(fullRedactor.redact(String(err?.message ?? err ?? 'unknown error').split('\n')[0]), 200);

  function start(mode = 'redacted') {
    const b = builds[mode];
    if (b.state !== 'idle') return b.promise;
    b.state = 'building';
    b.startedAt = now();
    const options = { config, roots, from, to, timezone, scope: 'all', ...(goalRecord ? { goals: goalRecord } : {}) };
    // The redacted build asks the engine to show display-only and outside sessions as
    // redacted text rather than skeletons; an engine without that option ignores it.
    if (mode === 'private') options.privateText = true;
    else options.hiddenSessions = 'redacted';
    b.promise = Promise.resolve()
      .then(() => buildHistory(options))
      .then(
        (h) => {
          b.h = h;
          b.eventsById = new Map(h.events.map((e) => [e.id, e]));
          b.state = 'ready';
          b.ms = now() - b.startedAt;
          if (mode === 'redacted') startWords(h);
        },
        (err) => {
          b.state = 'failed';
          b.ms = now() - b.startedAt;
          b.error = reason(err);
        },
      );
    return b.promise;
  }

  function startWords(h) {
    words.state = 'building';
    const t0 = now();
    words.promise = buildWordIndex({ roots, startT: h.window.startT, endT: h.window.endT, sessionOfSource: (k) => h.sourceSession?.get(k) ?? null }).then(
      (index) => {
        words.search = createWordSearch(index);
        words.sessions = index.sessions.length;
        words.state = 'ready';
        words.ms = now() - t0;
      },
      (err) => {
        words.state = 'failed';
        words.error = reason(err);
      },
    );
  }

  // One build's state as the pages read it: how long it has run (or took), and why it failed.
  const buildState = (b, extra = {}) => ({ state: b.state, ms: b.ms, elapsedMs: b.state === 'ready' || b.state === 'failed' ? b.ms : b.startedAt == null ? 0 : now() - b.startedAt, failed: b.state === 'failed' ? b.error : null, ...extra });

  // What a person typed, kept in this run's memory only, under a random letter-hash id
  // the page can put in its address instead of the words. An id from another run, or
  // one this run never gave out, finds nothing. Each query remembers whether it was ever
  // typed with Show private text off: one typed only with it on is never echoed back to a
  // request with it off, so turning the switch off and pressing Back can't bring it back.
  const queryById = new Map(); // id -> { text, typedOff }
  const idOfQuery = new Map();
  function rememberQuery(text, typedOff) {
    if (idOfQuery.has(text)) {
      const id = idOfQuery.get(text);
      if (typedOff) queryById.get(id).typedOff = true;
      return id;
    }
    const id = `q${letterHash(randomBytes(16), 16)}`;
    queryById.set(id, { text, typedOff });
    idOfQuery.set(text, id);
    while (queryById.size > MAX_QUERIES) {
      const [oldId, old] = queryById.entries().next().value;
      queryById.delete(oldId);
      idOfQuery.delete(old.text);
    }
    return id;
  }
  /** The query a request names, by q= (typed words) or id= (an id this run gave out). */
  function readQuery(params, empty) {
    const off = params.get('private') !== '1';
    const id = params.get('id');
    if (id !== null) {
      if (!QUERY_ID_RE.test(id)) return { answer: json(400, { error: 'That search id is malformed.' }) };
      const kept = queryById.get(id);
      if (kept === undefined) return { answer: { ...empty, queryId: id, query: null, empty: "That search isn't kept in this run's memory. Type it again." } };
      if (off && !kept.typedOff) return { answer: { ...empty, queryId: id, query: null, empty: "That search was typed with Show private text on, so it isn't shown with the switch off. Type it again." } };
      return { text: kept.text, id, echo: true };
    }
    const text = String(params.get('q') ?? '').trim();
    if (!text) return { answer: json(400, { error: 'Type something to search for.' }) };
    if (text.length > 500) return { answer: json(400, { error: 'That search is longer than 500 characters.' }) };
    return { text, id: rememberQuery(text, off), echo: false };
  }
  const withQuery = (q, body) => (body && typeof body.status === 'number' && 'body' in body ? body : { ...body, queryId: q.id, ...(q.echo ? { query: q.text } : {}) });

  function status() {
    const r = builds.redacted;
    const state = r.state === 'ready' ? 'ready' : r.state === 'failed' ? 'failed' : 'building';
    const days = daysBetween(from, to);
    const reading = demo ? `Reading the made-up demo week, ${from} to ${to}.` : `Reading ${days} day${days === 1 ? '' : 's'} of Claude Code and Codex logs, ${from} to ${to}.`;
    return {
      state,
      elapsedMs: (r.state === 'ready' || r.state === 'failed' ? r.ms : now() - (r.startedAt ?? startedAt)) ?? 0,
      reading,
      failed: r.state === 'failed' ? r.error : null,
      window: { from, to, timezone },
      // The page waits on the slot for its mode: the redacted build, and the private one
      // while Show private text is on.
      builds: { redacted: buildState(r, { reading }), private: buildState(builds.private) },
      search: { state: words.state, failed: words.state === 'failed' ? words.error : null },
      goalList: { given: !!record, goals: record ? record.goals.length : 0 },
      demo: demoNote,
      // How the person runs honestweek, for the commands a page names, and whether the
      // config lists any private words (the demo always has its made-up one).
      command,
      privateWords: { count: wordCount, note: !demo && wordCount === 0 ? privateWordsNote(command) : null },
      selfTest,
      evidenceKey: EVIDENCE_KEY,
    };
  }

  // ---- shared helpers over one build -------------------------------------------------

  function context(mode) {
    const b = builds[mode];
    const h = b.h;
    const sessionByKey = new Map(h.sessions.map((s) => [s.key, s]));
    return { mode, b, h, sessionByKey, redact: redactFor[mode] };
  }

  /** A timeline over one session's own steps, built on first use and kept with its build. */
  function sessionTimeline(ctx, key) {
    const cache = (ctx.b.sessionTimelines ??= new Map());
    if (!cache.has(key)) {
      const h = ctx.h;
      cache.set(key, buildTimeline(h.events.filter((e) => e.session === key), { agents: h.agents.filter((a) => a.session === key), sessions: h.sessions.filter((x) => x.key === key) }));
    }
    return cache.get(key);
  }

  /** Each session's prompt count, and for one with no prompt, what opened it. Built once per build. */
  const promptInfoCache = new WeakMap();
  function promptInfo(h) {
    let info = promptInfoCache.get(h);
    if (info) return info;
    info = new Map();
    const of = (key) => info.get(key) ?? info.set(key, { prompts: { value: 0, evidence: 'derived' }, opener: null }).get(key);
    for (const e of h.events) {
      if (e.kind === 'prompt') {
        const c = of(e.session).prompts;
        c.value += 1;
        // A session's prompt count is inferred when the engine only infers who wrote one of them.
        if ((e.inferred ?? []).some((x) => x.key === 'authorship')) c.evidence = 'inferred';
      } else if (e.kind === 'command' && e.actor === 'person') {
        const o = of(e.session);
        if (!o.opener || e.t < o.opener.t) o.opener = e;
      } else if (e.kind === 'agent-message' && e.facts?.direction !== 'outbound') {
        const o = of(e.session);
        if (!o.opener || e.t < o.opener.t) o.opener = e;
      }
    }
    promptInfoCache.set(h, info);
    return info;
  }
  /** What a session with no prompt was, from the record that opened it: a command typed, or a
   *  message from a schedule, another session or an agent. Null for a session with a prompt.
   *  Never a title: the engine's own title, or none, stays the title. */
  function startedBy(h, key) {
    const i = promptInfo(h).get(key);
    if (i && i.prompts.value > 0) return null;
    const e = i?.opener;
    if (!e) return { text: `no prompt between ${from} and ${to}`, evidence: 'derived' };
    if (e.kind === 'command') {
      const name = typeof e.facts?.name === 'string' && /^\/[\w:.-]{1,60}$/.test(e.facts.name) ? e.facts.name : null;
      return { text: `started with a command you typed${name ? ` (${name})` : ''}, no prompt`, evidence: e.evidence ?? 'recorded' };
    }
    const origin = e.facts?.from;
    const who = origin === 'scheduled-task' ? 'a schedule' : origin === 'parent-agent' ? 'the agent that started it' : 'another session or an agent';
    return { text: `started by ${who}, no prompt`, evidence: e.evidence ?? 'recorded' };
  }

  const sessionRow = (ctx, key) => {
    const s = ctx.sessionByKey.get(key);
    if (!s) return { session: key, thread: null, tool: null, repo: null, group: null, title: null, firstAt: null, lastAt: null, startedBy: null };
    return { session: s.key, thread: s.thread, tool: s.tool, repo: s.repo, group: sessionGroup(s), title: s.title, firstAt: s.firstAt, lastAt: s.lastAt, startedBy: startedBy(ctx.h, s.key) };
  };

  /** The goals a session is a member of, each with that session's place in the goal. */
  function goalsOfSession(ctx, key) {
    if (!record || !ctx.h.goals) return [];
    const out = [];
    ctx.h.goals.forEach((g, i) => {
      const m = g.members.find((x) => x.session === key);
      if (!m) return;
      out.push({ key: keys[i], title: g.title, state: g.state, evidence: m.evidence, ambiguous: m.ambiguous === true, assigned: m.joins.some((j) => j.type === 'cited-session'), joins: m.joins.map((j) => ({ type: j.type, evidence: j.evidence, ambiguous: j.ambiguous ?? null, rule: j.rule ?? null })) });
    });
    return out;
  }

  const emptyText = () => (demo ? `Nothing between ${from} and ${to} in the demo week.` : `Nothing between ${from} and ${to}. Run ${command} view --days 30 to look further back.`);

  const readableEvents = (ctx) => ctx.h.events.filter((e) => ctx.sessionByKey.get(e.session)?.private === false);

  /** The references most sessions point at, as things to try typing. */
  function tryExamples(ctx) {
    const counts = new Map();
    const add = (kind, text, session) => {
      if (typeof text !== 'string' || !text || text.includes('[redacted:') || text.length > 80) return;
      const k = `${kind}|${text}`;
      if (!counts.has(k)) counts.set(k, { kind, text, sessions: new Set() });
      counts.get(k).sessions.add(session);
    };
    for (const e of readableEvents(ctx)) {
      const f = e.facts ?? {};
      if (e.kind === 'link' && Number.isInteger(f.pr)) add('pull request', `#${f.pr}`, e.session);
      if (e.kind === 'outcome' && f.outcome === 'pr-landed' && Number.isInteger(f.pr)) add('pull request', `#${f.pr}`, e.session);
      if (e.kind === 'outcome' && f.outcome === 'commit-exists' && typeof f.sha === 'string') add('commit', f.sha.slice(0, 12), e.session);
      if (typeof f.git?.push?.branch === 'string') add('branch', f.git.push.branch, e.session);
      if (e.kind === 'mode' && typeof f.branch === 'string') add('branch', f.branch, e.session);
    }
    const best = (kind) => [...counts.values()].filter((x) => x.kind === kind).sort((a, b) => b.sessions.size - a.sessions.size || (a.text < b.text ? -1 : 1))[0];
    return ['pull request', 'commit', 'branch']
      .map(best)
      .filter(Boolean)
      .map((x) => ({ kind: x.kind, text: x.text, sessions: { value: x.sessions.size, evidence: 'derived' }, evidence: 'derived', why: 'the reference the most sessions in this window point at' }));
  }

  // ---- routes ------------------------------------------------------------------------

  function home(ctx) {
    const h = ctx.h;
    const groups = { configured: 0, display: 0, outside: 0 };
    for (const s of h.sessions) groups[sessionGroup(s)] += 1;
    const files = new Set();
    for (const e of readableEvents(ctx)) for (const k of [e.facts?.fileKey, ...(e.facts?.fileKeys ?? [])]) if (typeof k === 'string') files.add(k);
    const count = (value, note = null) => ({ value, evidence: 'derived', ...(note ? { note } : {}) });
    // Sessions with a prompt come first, each group newest first.
    const info = promptInfo(h);
    const prompted = (s) => (info.get(s.key)?.prompts.value ?? 0) > 0;
    const recent = [...h.sessions]
      .sort((a, b) => prompted(b) - prompted(a) || ((b.lastAt ?? '') < (a.lastAt ?? '') ? -1 : (b.lastAt ?? '') > (a.lastAt ?? '') ? 1 : a.key < b.key ? -1 : 1))
      .slice(0, 12)
      .map((s) => ({ ...sessionRow(ctx, s.key), evidence: 'recorded', prompts: info.get(s.key)?.prompts ?? count(0), goals: goalsOfSession(ctx, s.key) }));
    return {
      window: h.window,
      coverage: {
        sessionsRead: count(h.sessions.length),
        configured: count(groups.configured),
        display: count(groups.display, 'display-only repositories: never read by git'),
        outside: count(groups.outside, 'folders outside your config'),
        excludedFromLookups: count(groups.display + groups.outside, 'display-only and outside sessions are left out of lookups and goals; search everywhere includes them'),
        filesUnnamed: count(files.size, 'the engine keeps a fingerprint of each file path, never the path, so a file is found by typing its path'),
        text: `These lookups cover your configured repositories between ${from} and ${to}. They leave out ${groups.display} display-only and ${groups.outside} outside session${groups.display + groups.outside === 1 ? '' : 's'}; search everywhere, below, includes them.`,
      },
      goals: record
        ? h.goals.map((g, i) => ({ key: keys[i], title: g.title, state: g.state, evidence: 'recorded', members: memberCount(g.members), ...goalSplit(g.members), unmatched: count(g.unmatched.length) }))
        : [],
      goalList: { given: !!record, note: record ? null : NO_GOAL_LIST },
      recent,
      try: tryExamples(ctx),
      empty: h.sessions.length ? null : emptyText(),
      evidenceKey: EVIDENCE_KEY,
      rules: VIEW_RULES,
    };
  }

  function lookup(ctx, params) {
    const q = readQuery(params, { sessions: [], goals: [], notes: [] });
    if (q.answer) return q.answer;
    return withQuery(q, lookupOf(ctx, q.text));
  }

  function lookupOf(ctx, text) {
    const r = ctx.h.lookup(text);
    const withSession = (row) => ({ ...sessionRow(ctx, row.session), ...row, goals: goalsOfSession(ctx, row.session) });
    const sessions = (r.sessions ?? []).map(withSession);
    const repositories = Array.isArray(r.repositories) ? r.repositories.map((g) => ({ ...g, sessions: (g.sessions ?? []).map(withSession) })) : undefined;
    const goals = new Map();
    for (const s of sessions) {
      for (const g of s.goals) {
        if (!goals.has(g.key)) goals.set(g.key, { key: g.key, title: g.title, state: g.state, sessions: [] });
        goals.get(g.key).sessions.push({ session: s.session, evidence: g.evidence, ambiguous: g.ambiguous, assigned: g.assigned });
      }
    }
    // The engine's own `query` is the parsed reference; it's returned as `parsed`, so
    // `query` only ever means the words a person typed.
    const { goals: _bareIds, sessions: _rows, query: parsed, ...rest } = r;
    return { ...rest, parsed, sessions, ...(repositories ? { repositories } : {}), goals: [...goals.values()], empty: sessions.length ? null : emptyText(), evidenceKey: EVIDENCE_KEY };
  }

  function promptRow(ctx, e, extra) {
    return { event: e.id, ...sessionRow(ctx, e.session), t: e.t, at: e.at ?? null, text: cutRedacted(String(e.facts?.text ?? ''), 240), who: whoOf(e, new Map(ctx.h.agents.map((a) => [a.key, a]))), goals: goalsOfSession(ctx, e.session), ...extra };
  }

  function wordSearch(ctx, params) {
    const h = ctx.h;
    // Display-only and outside sessions never join a lookup, whichever build answers.
    const prompts = readableEvents(ctx).filter((e) => e.kind === 'prompt' && typeof e.facts?.text === 'string' && e.facts.text);
    const similarTo = params.get('similar');
    if (similarTo) {
      if (!ID_RE.test(similarTo)) return json(400, { error: 'That prompt id is malformed.' });
      const base = prompts.find((e) => e.id === similarTo);
      if (!base) return json(404, { error: 'No prompt with that id in this window.' });
      const mine = new Set(wordsOf(base.facts.text));
      const similar = prompts
        .filter((e) => e.id !== base.id)
        .map((e) => {
          const theirs = new Set(wordsOf(e.facts.text));
          let shared = 0;
          for (const w of theirs) if (mine.has(w)) shared += 1;
          const union = mine.size + theirs.size - shared;
          return { e, score: union ? shared / union : 0 };
        })
        .filter((x) => x.score >= 0.2)
        .sort((a, b) => b.score - a.score || b.e.t - a.e.t)
        .slice(0, 10)
        .map(({ e, score }) => promptRow(ctx, e, { evidence: 'inferred', rule: 'view.similar-prompt', score: { value: Math.round(score * 100) / 100, evidence: 'inferred', rule: 'view.similar-prompt' } }));
      return { similarTo: base.id, similar, goals: [], sessions: [], branches: [], prompts: [], empty: similar.length ? null : 'No prompt in this window shares enough words with that one.', rules: VIEW_RULES, evidenceKey: EVIDENCE_KEY };
    }
    const query = readQuery(params, { goals: [], sessions: [], branches: [], prompts: [], similar: [] });
    if (query.answer) return query.answer;
    return withQuery(query, wordsFor(ctx, query.text, prompts));
  }

  function wordsFor(ctx, q, prompts) {
    const h = ctx.h;
    const want = [...new Set(wordsOf(q))];
    const low = q.toLowerCase();
    const has = (text) => want.length > 0 && want.every((w) => String(text ?? '').toLowerCase().includes(w));
    const goals = record
      ? h.goals.flatMap((g, i) => {
          const inTitle = has(g.title);
          const inId = has(g.id);
          return inTitle || inId ? [{ key: keys[i], title: g.title, state: g.state, matchedIn: inTitle ? 'title' : 'id', evidence: 'recorded', members: memberCount(g.members) }] : [];
        })
      : [];
    const sessions = h.sessions.filter((s) => s.private === false && s.title && has(s.title)).map((s) => ({ ...sessionRow(ctx, s.key), evidence: 'recorded', goals: goalsOfSession(ctx, s.key) }));
    const branchMap = new Map();
    for (const e of readableEvents(ctx)) {
      const f = e.facts ?? {};
      for (const b of [f.git?.push?.branch, f.git?.branch?.ref, e.kind === 'mode' ? f.branch : null]) {
        if (typeof b !== 'string' || !b || !b.toLowerCase().includes(low)) continue;
        if (!branchMap.has(b)) branchMap.set(b, new Map());
        if (!branchMap.get(b).has(e.session)) branchMap.get(b).set(e.session, e.id);
      }
    }
    const branches = [...branchMap].map(([branch, bySession]) => ({ branch, evidence: 'recorded', sessions: [...bySession].map(([session, event]) => ({ ...sessionRow(ctx, session), event, evidence: 'recorded' })) }));
    const scored = prompts
      .map((e) => {
        const theirs = new Set(wordsOf(e.facts.text));
        const shared = want.filter((w) => theirs.has(w)).length;
        return { e, shared };
      })
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || b.e.t - a.e.t)
      .slice(0, 20)
      .map(({ e, shared }) => {
        // The words are in the prompt's text, so the row is recorded; ranking it by how many
        // of them it shares is a named rule's reading, so the score is inferred.
        return promptRow(ctx, e, { evidence: 'recorded', rule: 'view.shared-words', matched: shared === want.length ? 'all your words' : 'some of your words', score: { value: shared, of: want.length, evidence: 'inferred', rule: 'view.shared-words' } });
      });
    const nothing = !goals.length && !sessions.length && !branches.length && !scored.length;
    return { goals, sessions, branches, prompts: scored, similar: [], empty: nothing ? emptyText() : null, rules: VIEW_RULES, evidenceKey: EVIDENCE_KEY };
  }

  function goal(ctx, params) {
    if (!record) return json(404, { error: 'no-goal-list', note: NO_GOAL_LIST, window: ctx.h.window });
    const key = String(params.get('key') ?? '');
    const i = indexOfKey.get(key);
    if (i === undefined) return json(404, { error: 'No goal in your goal list has that key.' });
    const h = ctx.h;
    const g = h.goal(record.goals[i].id);
    if (!g) return json(404, { error: 'No goal in your goal list has that key.' });
    const members = g.members.map((m) => ({ ...m, ambiguous: m.ambiguous === true, assigned: m.joins.some((j) => j.type === 'cited-session'), group: sessionGroup(ctx.sessionByKey.get(m.session)) }));
    const memberKeys = new Set(members.map((m) => m.session));
    const agentsByKey = new Map(h.agents.map((a) => [a.key, a]));
    const events = h.events.filter((e) => memberKeys.has(e.session));
    const sessions = h.sessions
      .filter((s) => memberKeys.has(s.key))
      .map((s) => ({ key: s.key, tool: s.tool, thread: s.thread, repo: s.repo, group: sessionGroup(s), title: s.title, firstAt: s.firstAt, lastAt: s.lastAt, endState: s.endState, startedFrom: s.startedFrom ?? null, turns: (h.session(s.key)?.turns ?? []).filter((t) => !t.agent || t.agent.endsWith(':main')) }));
    // Each member's counts come from a timeline over that session's own steps, never its
    // whole thread: a resumed or forked session in the same thread may belong to another
    // goal, and its work isn't this session's.
    const frames = {};
    for (const s of sessions) {
      const own = events.filter((e) => e.session === s.key);
      if (!own.length) continue;
      const tl = sessionTimeline(ctx, s.key);
      const times = own.map((e) => e.t).filter(Number.isFinite);
      frames[s.key] = frameMoments(own, Math.min(...times), Math.max(...times), GOAL_FRAMES).map((t) => frameAt(tl, t));
    }
    return {
      key,
      id: g.id,
      title: g.title,
      state: g.state,
      window: h.window,
      timezone: h.window.timezone,
      members,
      unmatched: g.unmatched.map((u) => ({ ...u, evidence: 'missing', assigned: true })),
      sessions,
      agents: h.agents.filter((a) => memberKeys.has(a.session)).map((a) => ({ key: a.key, session: a.session, kind: a.kind, type: a.type ?? null, description: a.description ?? null, spawnedBy: a.spawnedBy ?? null, spawnAt: a.spawnAt ?? null, firstAt: a.firstAt ?? null, lastAt: a.lastAt ?? null, completion: a.completion ?? null, missing: a.missing ?? [] })),
      events: events.map((e) => eventRow(h, e, agentsByKey, ctx.redact)),
      frames,
      coverage: { sessionsRead: { value: h.sessions.length, evidence: 'derived' }, privateSessions: { value: h.sessions.filter((s) => s.private).length, evidence: 'derived', note: 'display-only and outside sessions are never searched for goal links' } },
      rules: { ...h.rules, ...VIEW_RULES },
      evidenceKey: EVIDENCE_KEY,
    };
  }

  function replay(ctx, params) {
    const h = ctx.h;
    const thread = params.get('thread');
    const session = params.get('session');
    let threadId = null;
    let focus = null;
    if (session) {
      if (!ID_RE.test(session)) return json(400, { error: 'That session id is malformed.' });
      const s = ctx.sessionByKey.get(session);
      // A well-formed id this window doesn't hold is an empty result that names the window,
      // the same answer as a window with no thread at all.
      if (!s) return { thread: null, window: h.window, empty: `No session with that id between ${from} and ${to}.` };
      threadId = s.thread;
      focus = s.key;
    } else if (thread) {
      if (!ID_RE.test(thread)) return json(400, { error: 'That thread id is malformed.' });
      if (!h.threads.some((t) => t.id === thread)) return { thread: null, window: h.window, empty: `No thread with that id between ${from} and ${to}.` };
      threadId = thread;
    } else {
      const latest = [...h.sessions].filter((s) => s.thread).sort((a, b) => ((b.lastAt ?? '') < (a.lastAt ?? '') ? -1 : (b.lastAt ?? '') > (a.lastAt ?? '') ? 1 : a.key < b.key ? -1 : 1))[0];
      if (!latest) return { thread: null, window: h.window, empty: `${emptyText()} Search for a pull request, a commit or some words to find a session to replay.` };
      threadId = latest.thread;
    }
    const cacheKey = `${threadId}|${focus ?? ''}`;
    let data = ctx.b.replays.get(cacheKey);
    if (!data) {
      data = exportThread(h, threadId, { focus, extraRules: VIEW_RULES, redact: ctx.redact });
      if (!data) return json(404, { error: 'That thread has no records in this window.' });
      ctx.b.replays.set(cacheKey, data);
    }
    return data;
  }

  function recordRoute(ctx, params) {
    const id = String(params.get('event') ?? '');
    if (!ID_RE.test(id)) return json(400, { error: 'That step id is malformed.' });
    const e = ctx.b.eventsById.get(id);
    if (!e) return json(404, { error: `No step with that id between ${from} and ${to}.` });
    const h = ctx.h;
    const agentsByKey = new Map(h.agents.map((a) => [a.key, a]));
    const sameRef = (a, b) => !!a && !!b && (a === b || (a.src === b.src && a.line === b.line && a.off === b.off));
    const reads = h.record(id).map((r, i) => ({
      part: sameRef(r.ref, e.end?.ref) ? 'result' : i === 0 ? 'step' : 'copy',
      line: r.ref?.line ?? null,
      git: !!r.ref?.sha,
      verified: r.verified,
      note: r.note,
      record: r.record == null ? null : joinLinesWhereNeeded(r.record, ctx.redact),
    }));
    const result = reads.find((x) => x.part === 'result');
    const out = e.kind === 'action' && result?.record ? outputOf(result.record) : null;
    return {
      event: eventRow(h, e, agentsByKey, ctx.redact),
      who: whoOf(e, agentsByKey),
      timeNote: timeNoteOf(e),
      records: reads,
      output: out ? { text: cutRedacted(out, 1500), cut: out.length > 1500, evidence: 'recorded' } : null,
      tests: e.derived?.tests ? { ...e.derived.tests, evidence: 'derived' } : null,
      evidenceKey: EVIDENCE_KEY,
      rules: { ...h.rules, ...VIEW_RULES },
    };
  }

  function search(ctx, params) {
    const none = { total: { value: 0, evidence: 'derived' }, sessions: { value: 0, evidence: 'derived' }, results: [] };
    const query = readQuery(params, none);
    if (query.answer) return query.answer;
    if (words.state !== 'ready') {
      return withQuery(query, { ready: false, state: words.state, note: words.state === 'failed' ? `Search everywhere couldn't read the logs: ${words.error}` : 'Search everywhere is still reading the logs. Try again in a moment.', ...none });
    }
    const info = (key) => {
      const s = ctx.sessionByKey.get(key);
      return s ? { thread: s.thread, group: sessionGroup(s) } : null;
    };
    const found = words.search(query.text, { redact: ctx.redact, mode: ctx.mode, sessionInfo: info });
    return withQuery(query, { ready: true, state: 'ready', ...found, indexed: { value: words.sessions, evidence: 'derived' }, groups: { configured: 'a repository in your config', display: 'a display-only repository, never read by git', outside: 'a folder outside your config' }, empty: found.results.length ? null : emptyText(), evidenceKey: EVIDENCE_KEY });
  }

  /** The most common plain word in the prompts of the sessions `keep` accepts. */
  function commonWord(ctx, keep) {
    const freq = new Map();
    for (const e of ctx.h.events) {
      if (e.kind !== 'prompt' || !keep(ctx.sessionByKey.get(e.session))) continue;
      for (const w of new Set(wordsOf(e.facts?.text))) if (w.length >= 5 && /^\p{L}+$/u.test(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    return [...freq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
  }

  /** A file path a prompt or a sub-agent's instruction names (as this build shows it) whose
   *  lookup finds a session: the engine keeps no file names, so a typed path is the way in. */
  function exampleFile(ctx) {
    const tried = new Set();
    for (const e of readableEvents(ctx)) {
      if (e.kind !== 'prompt' && e.kind !== 'delegation-received') continue;
      for (const m of String(e.facts?.text ?? '').matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})(?=$|[\s`'",;:)]|\.(?:\s|$))/g)) {
        const path = m[1];
        if (tried.has(path) || path.includes('[redacted:')) continue;
        tried.add(path);
        if (tried.size > 40) return null;
        const r = ctx.h.lookup(path);
        if (r.kind === 'file' && (r.sessions ?? []).length) return path;
      }
    }
    return null;
  }

  /** A commit this window records whose lookup notes it's a pull request's squash merge. */
  function exampleSquash(ctx) {
    const shas = new Set();
    for (const e of readableEvents(ctx)) for (const s of [e.facts?.sha, e.facts?.git?.commit?.sha]) if (typeof s === 'string' && /^[0-9a-f]{12,40}$/.test(s)) shas.add(s.slice(0, 12));
    for (const sha of [...shas].slice(0, 40)) if ((ctx.h.lookup(sha).notes ?? []).some((n) => n?.kind === 'squash-subject')) return sha;
    return null;
  }

  /** What the click-through test needs to find on its own: search words (the most common
   *  one in the configured sessions' prompts, then one each from the display-only and the
   *  outside sessions' prompts, so search everywhere reaches both), references to look up
   *  beside the home page's examples (a squash-merged commit, a file a prompt names), a
   *  goal, and a session of each group. */
  function selftestInfo(ctx) {
    const h = ctx.h;
    const word = commonWord(ctx, (s) => s?.private === false);
    const groupWords = ['display', 'outside'].map((g) => commonWord(ctx, (s) => sessionGroup(s) === g));
    const pick = (group) => h.sessions.find((s) => sessionGroup(s) === group) ?? null;
    const ids = (s) => (s ? { session: s.key, thread: s.thread } : null);
    const goalIdx = record ? h.goals.findIndex((g) => g.members.length) : -1;
    const examples = [{ kind: 'commit', text: exampleSquash(ctx) }, { kind: 'file', text: exampleFile(ctx) }].filter((x) => x.text);
    return { word, words: [...new Set([word, ...groupWords].filter(Boolean))], examples, goal: goalIdx >= 0 ? keys[goalIdx] : null, configured: ids(pick('configured')), display: ids(pick('display')), outside: ids(pick('outside')), try: tryExamples(ctx) };
  }

  const ROUTES = { '/api/home': home, '/api/lookup': lookup, '/api/words': wordSearch, '/api/goal': goal, '/api/replay': replay, '/api/record': recordRoute, '/api/search': search, ...(selfTest ? { '/api/selftest': selftestInfo } : {}) };

  /** Answer one data request. `params` is the request's URLSearchParams. */
  async function route(path, params) {
    if (path === '/api/status') {
      // A page with Show private text on waits on this answer, so asking starts that build.
      if (params.get('private') === '1') start('private');
      return json(200, status());
    }
    const fn = ROUTES[path];
    if (!fn) return json(404, { error: 'No such data route.' });
    const asked = params.get('private') === '1' ? 'private' : 'redacted';
    if (asked === 'private') start('private');
    const priv = builds.private;
    let shown = asked === 'private' && priv.state === 'ready' ? 'private' : 'redacted';
    let note = null;
    if (asked === 'private' && shown === 'redacted') {
      note = priv.state === 'failed' ? `The private version couldn't be built, so this is the redacted view: ${priv.error}` : 'The private version is still being built, so this is the redacted view for now.';
    }
    if (shown === 'redacted' && builds.redacted.state !== 'ready') {
      return json(503, { error: builds.redacted.state === 'failed' ? 'failed' : 'building', status: status() });
    }
    const ctx = context(shown);
    const out = fn(ctx, params);
    const answer = out && typeof out.status === 'number' && 'body' in out ? out : json(200, out);
    return json(answer.status, { ...answer.body, view: { asked, shown, note, privateState: priv.state, window: { from, to, timezone }, demo: demoNote } });
  }

  /** The self-test's leak counter: counts only, never the words. */
  function leakCheck(text, params) {
    const asked = params?.get?.('private') === '1' ? 'private' : 'redacted';
    // With parts=1 the text is a JSON list of what a page shows, each string as it stands on
    // the page and each value as the page got it, checked one by one. Joined into one text,
    // the end of one piece and the start of the next read as a field and its value.
    if (params?.get?.('parts') === '1') {
      let parts;
      try {
        parts = JSON.parse(String(text));
      } catch {
        parts = null;
      }
      if (!Array.isArray(parts)) return { error: 'With parts=1 the text must be a JSON list.', chars: String(text).length, mode: asked };
      const counts = asked === 'private' ? leaks.secrets(parts) : leaks.redacted(parts);
      return { chars: String(text).length, mode: asked, ...counts };
    }
    const counts = asked === 'private' ? leaks.secrets(text) : leaks.redacted(text);
    return { chars: String(text).length, mode: asked, ...counts };
  }

  return { start, status, route, leakCheck, routes: ['/api/status', ...Object.keys(ROUTES)] };
}

/** The text a tool call's result record holds, from either harness's record shape. */
export function outputOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const textOf = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : '')).filter(Boolean).join('\n');
    if (v && typeof v === 'object' && typeof v.output === 'string') return v.output;
    return null;
  };
  const content = rec.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) if (b && b.type === 'tool_result') return textOf(b.content);
  }
  const p = rec.payload;
  if (p && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
    let o = p.output;
    if (typeof o === 'string' && o.startsWith('{')) {
      try {
        const parsed = JSON.parse(o);
        if (typeof parsed?.output === 'string') o = parsed.output;
      } catch {
        /* a cut or non-JSON output is shown as it is */
      }
    }
    return textOf(o);
  }
  return null;
}
