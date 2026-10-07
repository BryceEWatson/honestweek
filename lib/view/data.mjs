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
import { localDay } from '../replay/views.mjs';
import { privateWordCount, privateWordsNote } from '../private-words.mjs';
import { eventRow, exportThread, frameAt, frameMoments, sessionGroup, timeNoteOf, whoOf } from './replay-export.mjs';
import { buildWordIndex, createWordSearch, cutRedacted } from '../replay/word-index.mjs';
import { matchWords, similarPrompts, WORD_RULES, wordsOf } from '../replay/words.mjs';
import { createProblemsRoute } from './problems-route.mjs';
import { earlierWindow, runProblems, trendCounts } from '../problems/index.mjs';
import { INSIGHTS_TEXT } from './insights.mjs';
import { sessionFacts, windowTotals } from './facts.mjs';
import { sessionText } from './codex-judge.mjs';
import { suggestWords } from './suggest-words.mjs';

/** The most moments a goal page samples per member session. */
const GOAL_FRAMES = 600;
/** Threads kept built per mode; the least recently opened one goes first. */
export const REPLAY_CACHE_SIZE = 32;
/** The sessions list (/api/sessions): days per answer, sessions shown per day, and how many
 *  more each "Show more" adds. */
export const SESSION_DAYS = 7;
export const SESSIONS_PER_DAY = 5;
export const SESSIONS_PAGE = 20;
/** The day a session with no recorded time is listed under, after every dated day. */
export const NO_DAY = 'none';

/** The rules behind results the page computes itself, beside the engine's own: the phrase
 *  search's (lib/replay/words.mjs). */
export const VIEW_RULES = WORD_RULES;

/** The five evidence words every page uses, in plain words. */
export const EVIDENCE_KEY = Object.freeze({
  recorded: 'A log line or git says so directly.',
  derived: 'Computed only from recorded facts, such as a count or the time between two lines.',
  inferred: "A named rule's best reading of the records. It can be wrong, and the rule is named.",
  missing: "Evidence I'd expect is absent, such as a call with no recorded result.",
  ambiguous: 'The records fit more than one way, such as a pull request number two repositories share.',
});

/** The one line every page shows when the config lists no private words. */
export const PRIVATE_WORDS_SHORT = 'No private words set, so names show as written.';

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


/** A goal's key: a letter hash of its raw id, so it never shows the id and the redactor
 *  never alters it. */
export function goalKey(rawId) {
  return `g${letterHash(`goal\u0000${String(rawId)}`, 15)}`;
}

/** Lowercased words of a text (the engine's phrase search, lib/replay/words.mjs). */
export { wordsOf };

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
const dayShift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * What a page shows while the rest of a window loads (lib/view/progressive.mjs): the whole
 * window, the days the rest reads, how many of its log files it has read and for how long, or
 * why it stopped. The page writes its one loading line from these (lib/view/assets/common.js).
 *   partial  { from, to, progress() -> { read, total } | null, failed() -> string | null,
 *              start() -> the first day the rest reads (a window cut to fit starts later) | null,
 *              startedAt() -> when the rest began loading, in ms | null }
 */
export function partialState(partial, { from, now = Date.now }) {
  const p = typeof partial.progress === 'function' ? partial.progress() : null;
  const failed = typeof partial.failed === 'function' ? partial.failed() : null;
  const start = typeof partial.start === 'function' ? partial.start() : null;
  const began = typeof partial.startedAt === 'function' ? partial.startedAt() : null;
  const read = Number.isInteger(p?.read) ? p.read : null;
  const total = Number.isInteger(p?.total) ? p.total : null;
  // A cut that keeps only the shown day reads that day again, never the days it dropped.
  const restFrom = DAY_RE.test(start ?? '') ? start : partial.from;
  return {
    from: partial.from,
    to: partial.to,
    // The days not yet shown that the rest reads: from the window's start (or where it was cut
    // to fit) to the day before the first one shown.
    rest: { from: restFrom, to: from > restFrom ? dayShift(from, -1) : from },
    read,
    total,
    elapsedMs: Number.isFinite(began) ? Math.max(0, now() - began) : null,
    failed: failed ?? null,
  };
}

/** The first `n` words of a text, cut at a redaction marker's edge, with "…" when cut. */
function firstWords(text, n = 8) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  let out = cutRedacted(one.split(' ').slice(0, n).join(' '), 60);
  if (out.length < one.length) out = `${out}…`;
  return out;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_RE = /^\d{1,6}$/;
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
 *   insights      the /insights toggle and run (lib/view/insights.mjs), or null
 *   codexJudge    the "Run with Codex" button and its stored results (lib/view/codex-judge.mjs),
 *                 or null; read only while the /insights toggle is on
 */
// The private-word count and note live in lib/private-words.mjs, shared with init.
export { privateWordCount, privateWordsNote };

export function createViewData({ config, roots, from, to, timezone, goalRecord = null, demo = false, selfTest = false, command: ranAs = 'honestweek', buildHistory = buildWorkHistory, cacheSize = REPLAY_CACHE_SIZE, now = () => Date.now(), windowNote = null, insights = null, codexJudge = null, settingsOpen = true, partial = null, onProgress = null, earlierCheck = null, privateCheck = null, earlierProgressive = false, queries = null }) {
  const wordCount = privateWordCount(config);
  const fullRedactor = createRedactor(config);
  // How the person ran honestweek, for the commands a page names. It goes through the
  // redactor like every other string, since a folder or a package owner in it can be a
  // private word.
  const command = fullRedactor.redact(String(ranAs));
  const demoNote = demo ? demoNotice(command) : null;
  const record = goalRecord ? normalizeGoalRecord(goalRecord) : null;
  const keys = record ? record.goals.map((g) => goalKey(g.id)) : [];
  const indexOfKey = new Map(keys.map((k, i) => [k, i]));
  const secretsRedactor = createSecretsOnlyRedactor();
  const redactFor = { redacted: (s) => fullRedactor.redact(String(s)), private: (s) => secretsRedactor.redact(String(s)) };
  const leaks = createLeakCounter(config);
  const startedAt = now();
  // The window the pages show, with a note when a saved choice was cut to fit. While the rest of
  // a week loads (lib/view/progressive.mjs), `partial` names the whole window and how far it has
  // got, and every page says its counts cover only the days loaded so far.
  const shownWindow = () => {
    if (!partial) return { from, to, timezone, ...(windowNote ? { note: windowNote } : {}) };
    // The header's "so far" and the loading line say it's partial; a note is only for a cut.
    return { from, to, timezone, partial: partialState(partial, { from, now }) };
  };
  // " so far" after a span of days, while the rest of the window is still loading.
  const soFar = partial ? ' so far (the rest is still loading)' : '';
  const slot = () => ({ state: 'idle', startedAt: null, ms: null, error: null, h: null, promise: null, replays: createLru(cacheSize), eventsById: null });
  const builds = { redacted: slot(), private: slot() };
  const words = { state: 'waiting', ms: null, error: null, search: null, sessions: 0 };

  // Set when Settings replaces this data or the page stops: a build still reading, this
  // window's or the week before's, stops at its next check and runs no more git.
  const signal = { aborted: false };
  const reason = (err) => cutRedacted(fullRedactor.redact(String(err?.message ?? err ?? 'unknown error').split('\n')[0]), 200);

  function start(mode = 'redacted') {
    const b = builds[mode];
    if (b.state !== 'idle' || signal.aborted) return b.promise;
    b.state = 'building';
    b.startedAt = now();
    const options = { config, roots, from, to, timezone, scope: 'all', updates: true, signal, ...(goalRecord ? { goals: goalRecord } : {}) };
    // Both builds read the agent's progress updates between tool calls (inferred from where a
    // thinking block sits), held in memory for this page only; nothing view writes carries one.
    // The redacted build asks the engine to show display-only and outside sessions as
    // redacted text rather than skeletons; an engine without that option ignores it.
    // The redacted build also records token counts and keeps raw text in memory for the
    // problem checks, which run on it alone; an engine without those options ignores them.
    if (mode === 'private') options.privateText = true;
    else Object.assign(options, { hiddenSessions: 'redacted', usage: true, keepRaw: true, ...(typeof onProgress === 'function' ? { onProgress } : {}) });
    // A second copy of a large window may not fit beside the first: it isn't built then, and the
    // page says why instead of the process running out of memory.
    const tooBig = mode === 'private' && typeof privateCheck === 'function' ? privateCheck() : null;
    if (tooBig) {
      b.state = 'failed';
      b.ms = 0;
      b.error = tooBig;
      b.promise = Promise.resolve();
      return b.promise;
    }
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
  // `queries` lets a window loaded newest day first keep what was typed when the whole window
  // takes over (lib/view/progressive.mjs), so an address with a search id still finds it.
  const queryById = queries?.byId ?? new Map(); // id -> { text, typedOff }
  const idOfQuery = queries?.byText ?? new Map();
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
      window: shownWindow(),
      // The page waits on the slot for its mode: the redacted build, and the private one
      // while Show private text is on.
      builds: { redacted: buildState(r, { reading }), private: buildState(builds.private) },
      search: { state: words.state, failed: words.state === 'failed' ? words.error : null },
      goalList: { given: !!record, goals: record ? record.goals.length : 0 },
      demo: demoNote,
      // How the person runs honestweek, for the commands a page names, and whether the
      // config lists any private words (the demo always has its made-up one).
      command,
      // One short line on every page; the rest of the note sits behind its "?".
      privateWords: { count: wordCount, note: !demo && wordCount === 0 ? PRIVATE_WORDS_SHORT : null, more: !demo && wordCount === 0 ? privateWordsNote(command, { restart: false, settings: settingsOpen }) : null },
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
        const o = of(e.session);
        const c = o.prompts;
        c.value += 1;
        if (typeof e.facts?.text === 'string' && e.facts.text && (!o.first || e.t < o.first.t)) o.first = e;
        // A session's prompt count is inferred when the engine only infers who wrote one of them.
        if ((e.inferred ?? []).some((x) => x.key === 'authorship')) c.evidence = 'inferred';
      } else if (e.kind === 'command' && (e.actor === 'person' || e.actor === 'program')) {
        const o = of(e.session);
        if (!o.opener || e.t < o.opener.t) o.opener = e;
      } else if ((e.kind === 'agent-message' && e.facts?.direction !== 'outbound') || (e.kind === 'delegation-received' && (e.facts?.from === 'codex-exec' || e.facts?.from === 'program'))) {
        const o = of(e.session);
        if (!o.opener || e.t < o.opener.t) o.opener = e;
      }
    }
    promptInfoCache.set(h, info);
    return info;
  }
  /** A command's name as a label can show it: a slash and up to 60 name characters, else null. */
  const commandName = (e) => (typeof e?.facts?.name === 'string' && /^\/[\w:.-]{1,60}$/.test(e.facts.name) ? e.facts.name : null);
  /** What a session with no prompt was, from the record that opened it: a command, or a
   *  message from a program, a schedule, another session or an agent. Null for a session with a
   *  prompt. Never a title: the engine's own title, or none, stays the title. */
  function startedBy(h, key) {
    const i = promptInfo(h).get(key);
    if (i && i.prompts.value > 0) return null;
    const e = i?.opener;
    if (!e) return { text: `no prompt between ${from} and ${to}${soFar}`, evidence: 'derived' };
    // The record says a program sent it (`turnOrigin: "sdk"`), so the label says so.
    if (e.actor === 'program') {
      const name = e.kind === 'command' ? commandName(e) : null;
      return { text: `started by a program${name ? `: ${name}` : ''}`, evidence: e.evidence ?? 'recorded' };
    }
    if (e.kind === 'command') {
      const name = commandName(e);
      // A record without turnOrigin shows a command, not who typed it, so the label doesn't say.
      return { text: `started with a command${name ? ` (${name})` : ''}, no prompt`, evidence: e.evidence ?? 'recorded' };
    }
    const origin = e.facts?.from;
    const who = origin === 'scheduled-task' ? 'a schedule' : origin === 'parent-agent' ? 'the agent that started it' : origin === 'codex-exec' ? 'codex exec' : 'another session or an agent';
    return { text: `started by ${who}, no prompt`, evidence: e.evidence ?? 'recorded' };
  }

  /** The Codex sessions this build's logs say `codex exec` started. */
  const execCache = new WeakMap();
  function execSessions(h) {
    if (!execCache.has(h)) execCache.set(h, new Set(h.events.filter((e) => e.kind === 'session' && e.facts?.tool === 'codex' && e.facts.started === 'exec' && e.source === e.session).map((e) => e.session)));
    return execCache.get(h);
  }
  /**
   * A label for a session with no title, from what its log records: "headless run" when it was
   * started by `claude -p`, the Agent SDK or `codex exec`, "program run" when its record says a
   * program sent its first turn (otherwise "untitled"), when it started, and the first words of
   * its first prompt or of the program's instruction, redacted for this answer. A session a
   * program started with a command is labelled by the command. Never a title: null for a session
   * with one, and the label says what it is. A display-only or outside session's words stay out,
   * as its title does.
   */
  function labelOf(ctx, key) {
    const s = ctx.sessionByKey.get(key);
    if (!s || s.title) return null;
    const info = promptInfo(ctx.h).get(s.key);
    const opener = info && !(info.prompts.value > 0) && info.opener?.actor === 'program' ? info.opener : null;
    const headless = s.headless === true || execSessions(ctx.h).has(s.key);
    const first = s.private === false ? info?.first ?? (opener?.kind === 'delegation-received' ? opener : null) : null;
    const words = first && typeof first.facts?.text === 'string' && first.facts.text ? firstWords(ctx.redact(first.facts.text)) : null;
    const command = opener?.kind === 'command' ? commandName(opener) : null;
    if (!headless && !opener && !words) return null;
    let when = null;
    try {
      when = s.firstAt ? new Date(s.firstAt).toLocaleString('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
    } catch {
      when = null;
    }
    if (command) return `${command}${when ? `, ${when}` : ''}`;
    return `${headless ? 'headless run' : opener ? 'program run' : 'untitled'}${when ? `, ${when}` : ''}${words ? `: “${words}”` : ''}`;
  }

  /** The steps that launched sessions, by id, and the sessions each one launched, from the
   *  history's launch links. Built once per build. */
  const launchCache = new WeakMap();
  function launchSteps(h) {
    if (launchCache.has(h)) return launchCache.get(h);
    const started = new Map();
    for (const l of h.links) if (l.type === 'program-launch') started.set(l.from, [...(started.get(l.from) ?? []), l]);
    const steps = new Map(started.size ? h.events.filter((e) => started.has(e.id)).map((e) => [e.id, e]) : []);
    const out = { started, steps };
    launchCache.set(h, out);
    return out;
  }
  /** A session's title, or its label when it has none, as a page names it. */
  const nameOf = (ctx, key) => {
    const s = ctx.sessionByKey.get(key);
    return { title: s?.title ?? null, label: s?.title ? null : labelOf(ctx, key) };
  };
  /**
   * What launched a session a program opened (the engine's launch join): the step in another
   * session (its session, thread, id and time), that session's title or label, and how the link
   * is known. Or, when more than one step fits, how many, and no step. Null when no launch step
   * fits, so a session's answer without one is what it was before the join existed.
   */
  function launchOf(ctx, key) {
    const by = ctx.sessionByKey.get(key)?.launchedBy;
    if (!by) return null;
    const n = (value) => ({ value, evidence: by.evidence });
    if (by.ambiguous) return { ambiguous: true, launches: n(by.launches), ...(by.sessions ? { sessions: n(by.sessions) } : {}), evidence: by.evidence, rule: by.rule };
    const step = launchSteps(ctx.h).steps.get(by.event);
    return { session: by.session, thread: ctx.sessionByKey.get(by.session)?.thread ?? null, event: by.event, at: step?.at ?? null, ...nameOf(ctx, by.session), evidence: by.evidence, rule: by.rule };
  }
  /** What started a session, with what launched it when the engine found the step. */
  function startedWith(ctx, key) {
    const sb = startedBy(ctx.h, key);
    const launch = sb ? launchOf(ctx, key) : null;
    return launch ? { ...sb, launch } : sb;
  }

  const sessionRow = (ctx, key) => {
    const s = ctx.sessionByKey.get(key);
    if (!s) return { session: key, thread: null, tool: null, repo: null, group: null, title: null, firstAt: null, lastAt: null, startedBy: null };
    const label = labelOf(ctx, s.key);
    return { session: s.key, thread: s.thread, tool: s.tool, repo: s.repo, group: sessionGroup(s), title: s.title, ...(label ? { label } : {}), firstAt: s.firstAt, lastAt: s.lastAt, startedBy: startedWith(ctx, s.key) };
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

  const emptyText = () => (demo ? `Nothing between ${from} and ${to} in the demo week.` : partial ? `Nothing between ${from} and ${to}${soFar}.` : `Nothing between ${from} and ${to}. Run ${command} view --days 30 to look further back.`);

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
    // Sessions with a prompt, or a codex exec run's or a program's starting instruction, come
    // first, each group newest first.
    const info = promptInfo(h);
    const instructed = (o) => o?.facts?.from === 'codex-exec' || (o?.facts?.from === 'program' && o.kind === 'delegation-received');
    const prompted = (s) => (info.get(s.key)?.prompts.value ?? 0) > 0 || instructed(info.get(s.key)?.opener);
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
        text: `These lookups cover your configured repositories between ${from} and ${to}${soFar}. They leave out ${groups.display} display-only and ${groups.outside} outside session${groups.display + groups.outside === 1 ? '' : 's'}; search everywhere, below, includes them.`,
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

  // ---- /api/sessions: Replay's starting list. Every session the window read, as on Find's
  // Recent card, by the day it started in the configured timezone, newest day first and newest
  // session first within a day. A display-only or outside session says which (its words stay out
  // as its title does, and it joins no lookup or goal). Paged, so no answer is long: a few days at
  // a time with a few sessions each, and more of one day on request.
  const daysCache = new WeakMap();
  function sessionDays(h) {
    if (daysCache.has(h)) return daysCache.get(h);
    const startOf = (s) => s.firstAt ?? s.lastAt ?? '';
    const byDay = new Map();
    for (const s of h.sessions) {
      const t = Date.parse(startOf(s));
      const day = Number.isFinite(t) ? localDay(t, timezone) : NO_DAY;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(s);
    }
    for (const list of byDay.values()) list.sort((a, b) => (startOf(b) < startOf(a) ? -1 : startOf(b) > startOf(a) ? 1 : a.key < b.key ? -1 : 1));
    const days = [...byDay.keys()].filter((d) => d !== NO_DAY).sort().reverse();
    if (byDay.has(NO_DAY)) days.push(NO_DAY);
    const out = { days, byDay };
    daysCache.set(h, out);
    return out;
  }
  /** Each configured session's findings worth a look, from the checks' one run on the redacted
   *  build (the run every page's header count reads). Null when they couldn't run. */
  function looksBySession() {
    const r = builds.redacted;
    return r.state === 'ready' ? problemsRoute.lookBySession(r.h, r.startedAt) : null;
  }
  function listRow(ctx, s, looks) {
    const row = sessionRow(ctx, s.key);
    const text = (v) => (typeof v === 'string' ? ctx.redact(v) : v);
    const t0 = Date.parse(s.firstAt ?? '');
    const t1 = Date.parse(s.lastAt ?? '');
    return {
      ...row,
      title: text(row.title),
      ...(row.label ? { label: text(row.label) } : {}),
      repo: text(row.repo),
      startedBy: row.startedBy ? { ...row.startedBy, text: text(row.startedBy.text), ...(row.startedBy.launch?.session ? { launch: { ...row.startedBy.launch, title: text(row.startedBy.launch.title), label: text(row.startedBy.launch.label) } } : {}) } : null,
      evidence: 'recorded',
      // From the first record to the last in the window: a recorded span, not time spent working.
      length: Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? { value: t1 - t0, evidence: 'derived' } : null,
      prompts: promptInfo(ctx.h).get(s.key)?.prompts ?? { value: 0, evidence: 'derived' },
      // The checks read configured repositories only, so another session has no count, never a zero.
      problems: looks && sessionGroup(s) === 'configured' ? looks.get(s.key) ?? { value: 0, evidence: 'derived' } : null,
    };
  }
  function sessionsList(ctx, params) {
    const day = params.get('day');
    const offset = params.get('offset');
    const before = params.get('before');
    if (day !== null && !DAY_RE.test(day) && day !== NO_DAY) return json(400, { error: 'That day is malformed.' });
    if (before !== null && !DAY_RE.test(before)) return json(400, { error: 'That day is malformed.' });
    if (offset !== null && !OFFSET_RE.test(offset)) return json(400, { error: 'That offset is malformed.' });
    if (offset !== null && day === null) return json(400, { error: 'An offset needs a day.' });
    const { days, byDay } = sessionDays(ctx.h);
    const looks = looksBySession();
    const n = (value) => ({ value, evidence: 'derived' });
    const rows = (list) => list.map((s) => listRow(ctx, s, looks));
    // Days in more than one calendar year: each day's heading then says its year.
    const years = new Set(days.filter((d) => d !== NO_DAY).map((d) => d.slice(0, 4)));
    const common = { timezone, problemsNote: looks ? null : "The problem checks couldn't run, so no session shows a count of problems.", evidenceKey: EVIDENCE_KEY, ...(years.size > 1 ? { spansYears: true } : {}) };
    if (day !== null) {
      const list = byDay.get(day) ?? [];
      const at = Number(offset ?? 0);
      const page = list.slice(at, at + SESSIONS_PAGE);
      const none = day === NO_DAY ? 'No session without a recorded time.' : `No session started on ${day} in this window.`;
      return { day, count: n(list.length), offset: at, rows: rows(page), more: n(Math.max(0, list.length - at - page.length)), page: SESSIONS_PAGE, ...common, empty: list.length ? null : none };
    }
    const start = before === null ? 0 : days.findIndex((d) => d === NO_DAY || d < before);
    const shown = start < 0 ? [] : days.slice(start, start + SESSION_DAYS);
    const rest = start < 0 ? 0 : days.length - start - shown.length;
    return {
      total: n(ctx.h.sessions.length),
      days: shown.map((d) => {
        const list = byDay.get(d);
        const first = list.slice(0, SESSIONS_PER_DAY);
        return { day: d, evidence: 'derived', count: n(list.length), rows: rows(first), more: n(list.length - first.length) };
      }),
      older: rest > 0 ? { before: shown[shown.length - 1], days: n(rest) } : null,
      perDay: SESSIONS_PER_DAY,
      page: SESSIONS_PAGE,
      ...common,
      empty: ctx.h.sessions.length ? null : emptyText(),
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

  // Phrase search is the engine's (lib/replay/words.mjs): display-only and outside sessions never
  // join a lookup, whichever build answers. These shape its matches into the page's rows.
  function wordSearch(ctx, params) {
    const similarTo = params.get('similar');
    if (similarTo) {
      if (!ID_RE.test(similarTo)) return json(400, { error: 'That prompt id is malformed.' });
      const found = similarPrompts(ctx.h, similarTo);
      if (!found) return json(404, { error: 'No prompt with that id in this window.' });
      const similar = found.map(({ event: e, score }) => promptRow(ctx, e, { evidence: 'inferred', rule: 'view.similar-prompt', score: { value: Math.round(score * 100) / 100, evidence: 'inferred', rule: 'view.similar-prompt' } }));
      return { similarTo, similar, goals: [], sessions: [], branches: [], prompts: [], empty: similar.length ? null : 'No prompt in this window shares enough words with that one.', rules: VIEW_RULES, evidenceKey: EVIDENCE_KEY };
    }
    const query = readQuery(params, { goals: [], sessions: [], branches: [], prompts: [], similar: [] });
    if (query.answer) return query.answer;
    return withQuery(query, wordsFor(ctx, query.text));
  }

  function wordsFor(ctx, q) {
    const h = ctx.h;
    const m = matchWords(h, q);
    const goals = record
      ? m.goals.map(({ index, matchedIn }) => {
          const g = h.goals[index];
          return { key: keys[index], title: g.title, state: g.state, matchedIn, evidence: 'recorded', members: memberCount(g.members) };
        })
      : [];
    const sessions = m.sessions.map((key) => ({ ...sessionRow(ctx, key), evidence: 'recorded', goals: goalsOfSession(ctx, key) }));
    const branches = m.branches.map(({ branch, sessions: bySession }) => ({ branch, evidence: 'recorded', sessions: bySession.map(({ session, event }) => ({ ...sessionRow(ctx, session), event, evidence: 'recorded' })) }));
    // The words are in the prompt's text, so the row is recorded; ranking it by how many of them
    // it shares is a named rule's reading, so the score is inferred.
    const scored = m.prompts.map(({ event: e, shared }) => promptRow(ctx, e, { evidence: 'recorded', rule: 'view.shared-words', matched: shared === m.want.length ? 'all your words' : 'some of your words', score: { value: shared, of: m.want.length, evidence: 'inferred', rule: 'view.shared-words' } }));
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
      .map((s) => ({ key: s.key, tool: s.tool, thread: s.thread, repo: s.repo, group: sessionGroup(s), title: s.title, label: labelOf(ctx, s.key), firstAt: s.firstAt, lastAt: s.lastAt, endState: s.endState, startedFrom: s.startedFrom ?? null, turns: (h.session(s.key)?.turns ?? []).filter((t) => !t.agent || t.agent.endsWith(':main')) }));
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
      if (!s) return { thread: null, window: h.window, empty: `No session with that id between ${from} and ${to}${soFar}.` };
      threadId = s.thread;
      focus = s.key;
    } else if (thread) {
      if (!ID_RE.test(thread)) return json(400, { error: 'That thread id is malformed.' });
      if (!h.threads.some((t) => t.id === thread)) return { thread: null, window: h.window, empty: `No thread with that id between ${from} and ${to}${soFar}.` };
      threadId = thread;
    } else {
      const latest = [...h.sessions].filter((s) => s.thread).sort((a, b) => ((b.lastAt ?? '') < (a.lastAt ?? '') ? -1 : (b.lastAt ?? '') > (a.lastAt ?? '') ? 1 : a.key < b.key ? -1 : 1))[0];
      if (!latest) return { thread: null, window: h.window, empty: `${emptyText()} Search for a pull request, a commit or some words to find a session to replay.` };
      threadId = latest.thread;
    }
    const cacheKey = `${threadId}|${focus ?? ''}`;
    let data = ctx.b.replays.get(cacheKey);
    if (!data) {
      // The token counts are the redacted build's (the private one doesn't record them): numbers
      // only, for the problem focus's context per model call.
      data = exportThread(h, threadId, { focus, extraRules: VIEW_RULES, redact: ctx.redact, usage: (builds.redacted.h ?? h).usage?.calls, longSession });
      if (!data) return json(404, { error: 'That thread has no records in this window.' });
      const labels = Object.fromEntries((data.sessions ?? []).map((x) => [x.key, labelOf(ctx, x.key)]).filter(([, l]) => l));
      if (Object.keys(labels).length) data = { ...data, labels };
      const launch = launchesOf(ctx, data);
      if (launch) data = { ...data, launch };
      ctx.b.replays.set(cacheKey, data);
    }
    // `at` (milliseconds): the thread's state at exactly that moment, read from its timeline
    // rather than the sampled frames, which change only at a step's start. `replay --at` asks
    // for it; the page doesn't, so its answer stays as it was.
    const at = params.get('at');
    if (at !== null) {
      const t = Number(at);
      if (at.trim() === '' || !Number.isFinite(t)) return json(400, { error: 'That moment is malformed.' });
      const tl = h.threadTimeline(threadId);
      return { ...data, atFrame: tl ? frameAt(tl, t) : null };
    }
    return data;
  }

  /** A replay's launch links, when it has any: `by`, what launched each of its sessions a
   *  program opened (launchOf), and `started`, for each of its steps that launched a session,
   *  the sessions it launched, each with its thread, title or label, start and how it's known. */
  function launchesOf(ctx, data) {
    const members = new Set((data.sessions ?? []).map((x) => x.key));
    const by = Object.fromEntries([...members].map((k) => [k, launchOf(ctx, k)]).filter(([, l]) => l));
    const started = {};
    for (const [id, list] of launchSteps(ctx.h).started) {
      if (!members.has(list[0].sessions[0])) continue;
      started[id] = list.map((l) => ({ session: l.to, thread: ctx.sessionByKey.get(l.to)?.thread ?? null, firstAt: ctx.sessionByKey.get(l.to)?.firstAt ?? null, ...nameOf(ctx, l.to), evidence: l.evidence, rule: l.rule }));
    }
    return Object.keys(by).length || Object.keys(started).length ? { by, started } : null;
  }

  function recordRoute(ctx, params) {
    const id = String(params.get('event') ?? '');
    if (!ID_RE.test(id)) return json(400, { error: 'That step id is malformed.' });
    const e = ctx.b.eventsById.get(id);
    if (!e) return json(404, { error: `No step with that id between ${from} and ${to}${soFar}.` });
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

  // ---- problems: the checks run once on the redacted build; each answer is drawn for its own --
  // The long-session check runs only with a limit set in Settings (config.longSessionTokens).
  const longSession = Number.isInteger(config?.longSessionTokens) ? config.longSessionTokens : null;
  const problemsRoute = createProblemsRoute({ now, longSessionTokens: longSession });
  /** The sessions a goal joins, by the redacted build's membership (the same in both builds). */
  function membersOfGoal(key) {
    const i = indexOfKey.get(String(key ?? ''));
    if (!record || i === undefined) return null;
    const g = builds.redacted.h?.goal(record.goals[i].id);
    return g ? g.members.map((m) => m.session) : [];
  }
  // The window just before this one, of the same length, read once and only for the Problems
  // page's trend counts: the same build options as the redacted build, the checks run on it, and
  // the history let go as soon as the counts are taken. No text from it reaches an answer.
  //
  // With `earlierProgressive` (a window of a week or less, as `view` loads my own logs), the week
  // before loads the way this one did: its newest day first, then all of it, and until all of it
  // is in, the answer says its counts cover only the days in so far. Each build is let go as soon
  // as its counts are taken, and the whole week starts only after the first day's is gone, so at
  // most one build of the week before is in memory, beside this window.
  // `earlierCheck(w)` answers null to read it all, { from, note } to read only the newest days
  // that fit in memory, or { why, note } to skip it.
  let earlier = null; // { first, whole, done: { first, whole } }
  function earlierCounts() {
    if (!earlier) earlier = startEarlier();
    const e = earlier;
    if (e.done.whole) return e.done.whole;
    if (!e.first) return e.whole;
    if (e.done.first) return e.done.first;
    // The first answer waits for the newest day; later ones say how far the rest has got.
    return e.first.then((f) => f ?? e.whole);
  }
  function startEarlier() {
    const w = earlierWindow({ from, to });
    const done = { first: null, whole: null };
    const settled = (value) => {
      done.whole = value;
      return { first: null, whole: Promise.resolve(value), done };
    };
    if (!w) return settled({ window: null, error: 'no window' });
    // Past the log limit, or more than memory holds beside this window: not read, or only its
    // newest days, and the page says which in a few words.
    const check = typeof earlierCheck === 'function' ? earlierCheck(w) : null;
    if (check?.why) return settled({ window: w, error: 'skipped', skipped: check.why, note: check.note });
    const wholeFrom = check?.from ?? w.from;
    const count = (a, b) => {
      const t0 = now();
      return Promise.resolve()
        .then(() => buildHistory({ config, roots, from: a, to: b, timezone, scope: 'all', updates: true, hiddenSessions: 'redacted', usage: true, keepRaw: true, signal }))
        .then(
          // Only the counts are kept: the history and the checks' result go with this function.
          (h) => ({ window: w, ...trendCounts(runProblems(h, { builtT: now(), longSessionTokens: longSession })), ms: now() - t0 }),
          (err) => ({ window: w, error: reason(err), ms: now() - t0 }),
        );
    };
    const cut = check?.note ? { note: check.note, loaded: { from: wholeFrom, to: w.to } } : {};
    if (!earlierProgressive || wholeFrom >= w.to) {
      const whole = count(wholeFrom, w.to).then((r) => (done.whole = { ...r, ...cut }));
      return { first: null, whole, done };
    }
    // Newest day first; then the whole week, started only once the first day's build is let go.
    const so = `The ${w.days} days before: only ${w.to} so far, so "before" covers just that day. The rest is loading.`;
    const first = count(w.to, w.to).then((r) => {
      if (r.error) return null;
      done.first = { ...r, partial: { from: w.to, to: w.to }, note: so };
      return done.first;
    });
    const whole = first.then(() => count(wholeFrom, w.to)).then((r) => (done.whole = { ...r, ...cut }));
    return { first, whole, done };
  }
  function problems(ctx, params) {
    if (builds.redacted.state !== 'ready') return json(503, { error: 'building', status: status() });
    // Comparing part of a week with the whole week before would mislead: the trend waits.
    if (partial && params.get('trend') === '1') return { window: builds.redacted.h.window, earlier: null, waiting: 'loading', trend: [], evidenceKey: EVIDENCE_KEY };
    return problemsRoute(ctx, params, { redactedH: builds.redacted.h, builtT: builds.redacted.startedAt, goalsOf: goalsOfSession, membersOfGoal, evidenceKey: EVIDENCE_KEY, idOk: (v) => ID_RE.test(v), earlier: earlierCounts, labelOf });
  }

  // ---- /insights: what Claude Code's /insights wrote about this window's sessions, its own
  // group on the Problems page. Only sessions the checks read (configured repositories) are
  // matched, by the session id the redacted build already holds; no other log is read and no
  // git runs. Every string passes this answer's redactor, then is cut. Its counts are its own
  // and never reach /api/problems.
  function insightsRoute(ctx, params) {
    if (!insights) return json(404, { error: 'No /insights here.' });
    const session = params.get('session');
    if (session !== null && !ID_RE.test(session)) return json(400, { error: 'That session id is malformed.' });
    const info = insights.info();
    if (!info.on) return { ...info, data: null };
    const rh = builds.redacted.h;
    const ids = rh.claudeIds ?? new Map();
    const list = rh.sessions.filter((s) => s.private === false && ids.has(s.key) && (session === null || s.key === session)).map((s) => ({ key: s.key, id: ids.get(s.key) }));
    const read = insights.read(list);
    if (!read) return { ...info, data: null };
    const text = (v) => {
      if (typeof v !== 'string') return null;
      const whole = ctx.redact(v);
      const cut = cutRedacted(whole, INSIGHTS_TEXT);
      return cut.length < whole.length ? `${cut}…` : cut;
    };
    const items = read.items.map((it) => {
      const s = ctx.sessionByKey.get(it.session);
      return {
        session: it.session,
        thread: s?.thread ?? null,
        title: text(s?.title),
        frictions: it.frictions.map((f) => ({ category: text(f.category), count: f.count })),
        detail: text(it.detail),
        summary: text(it.summary),
        outcome: text(it.outcome),
        minutes: it.minutes,
      };
    });
    const out = { ...info, data: { exists: read.exists, sessions: read.sessions, matched: read.matched, skipped: read.skipped, items } };
    if (codexJudge) out.codex = codexPart(ctx, rh, session, text);
    return out;
  }

  // ---- Run with Codex: the Codex sessions a judgment is for, and what's stored for them. Only
  // sessions in configured repositories that a person started (not a `codex exec` run, and not a
  // child or guardian thread whose parent isn't in the window, which another agent started), by
  // the thread id the redacted build holds. The stored text is redacted already and passes this
  // answer's redactor again; none of it reaches /api/problems or the facts.
  const AGENT_STARTED = new Set(['exec', 'child-thread', 'guardian']);
  function judgedSessions(h) {
    const ids = h.codexIds ?? new Map();
    // A session's own thread is the source its key names; a joined child thread has another.
    const exec = new Set(h.events.filter((e) => e.kind === 'session' && e.facts?.tool === 'codex' && AGENT_STARTED.has(e.facts.started) && e.source === e.session).map((e) => e.session));
    return h.sessions.filter((s) => s.tool === 'codex' && s.private === false && ids.has(s.key) && !exec.has(s.key)).map((s) => ({ key: s.key, id: ids.get(s.key) }));
  }
  function codexPart(ctx, rh, session, text) {
    const list = judgedSessions(rh).filter((s) => session === null || s.key === session);
    const read = codexJudge.read(list);
    const items = read.items.map((it) => {
      const s = ctx.sessionByKey.get(it.session);
      const f = it.facets;
      const counts = (m) => Object.entries(m).map(([k, n]) => ({ category: text(k), count: n })).sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));
      return {
        session: it.session,
        thread: s?.thread ?? null,
        title: text(s?.title),
        outcome: text(f.outcome),
        summary: text(f.brief_summary),
        goal: text(f.underlying_goal),
        detail: text(f.friction_detail),
        success: text(f.primary_success),
        type: text(f.session_type),
        helpfulness: text(f.claude_helpfulness),
        frictions: counts(f.friction_counts),
        goals: counts(f.goal_categories),
        satisfaction: counts(f.user_satisfaction_counts),
      };
    });
    return { ...codexJudge.info(), data: { sessions: read.sessions, judged: read.judged, skipped: read.skipped, items } };
  }
  /** What a Codex run judges: each waiting session's text, from the redacted build. Null while it loads. */
  function codexWork() {
    const b = builds.redacted;
    if (b.state !== 'ready') return null;
    const bySession = new Map();
    for (const e of b.h.events) if (bySession.has(e.session)) bySession.get(e.session).push(e); else bySession.set(e.session, [e]);
    const redact = (v) => fullRedactor.redact(String(v));
    return { redact, sessions: judgedSessions(b.h).map((s) => ({ ...s, text: sessionText(bySession.get(s.key) ?? [], redact) })) };
  }

  // ---- /api/facts: plain facts about each session, computed by honestweek from the events it
  // already read, for Claude Code and Codex alike, each saying how it's known, and the window's
  // totals. No model, no git. Strings pass this answer's redactor; token counts come from the
  // redacted build, which alone records them, as numbers.
  const factsCache = new WeakMap();
  function factsOf(ctx) {
    if (factsCache.has(ctx.h)) return factsCache.get(ctx.h);
    const h = ctx.h;
    const rh = builds.redacted.h;
    const bySession = new Map();
    for (const e of h.events) if (bySession.has(e.session)) bySession.get(e.session).push(e); else bySession.set(e.session, [e]);
    const usage = rh?.usage?.calls ?? [];
    const cwds = rh?._raw?.cwdOfSource ?? new Map();
    const list = h.sessions.map((s) => sessionFacts(h, s, { timezone, usage, events: bySession.get(s.key) ?? [], id: (s.tool === 'codex' ? h.codexIds : h.claudeIds)?.get(s.key) ?? null, cwd: cwds.get(s.key) ?? null, hidden: s.private !== false }));
    const out = { list, totals: windowTotals(list) };
    factsCache.set(ctx.h, out);
    return out;
  }
  function factsRoute(ctx, params) {
    const session = params.get('session');
    const thread = params.get('thread');
    if ((session !== null && !ID_RE.test(session)) || (thread !== null && !ID_RE.test(thread))) return json(400, { error: 'That id is malformed.' });
    const { list, totals } = factsOf(ctx);
    const str = (v) => (typeof v === 'string' ? ctx.redact(v) : v);
    const keys = (m) => Object.fromEntries(Object.entries(m).map(([k, n]) => [ctx.redact(k), n]));
    const shown = (f) => {
      const out = {};
      for (const [name, x] of Object.entries(f)) {
        const v = x.value;
        const value = name === 'start_time' || name === 'user_message_timestamps' ? v : typeof v === 'string' ? str(v) : v && typeof v === 'object' && !Array.isArray(v) ? keys(v) : v;
        out[name] = { ...x, value: name === 'first_prompt' && typeof value === 'string' ? (cutRedacted(value, INSIGHTS_TEXT).length < value.length ? `${cutRedacted(value, INSIGHTS_TEXT)}…` : value) : value };
      }
      return out;
    };
    const sessions = list
      .filter((x) => {
        const s = ctx.sessionByKey.get(x.key);
        return (session === null || x.key === session) && (thread === null || s?.thread === thread);
      })
      .map((x) => {
        const s = ctx.sessionByKey.get(x.key);
        return { key: x.key, agent: x.agent, thread: s?.thread ?? null, title: str(s?.title ?? null), facts: shown(x.facts) };
      });
    return { sessions, totals: Object.fromEntries(Object.entries(totals).map(([k, t]) => [k, { sessions: t.sessions, facts: shown(t.facts) }])) };
  }

  /** Settings' "Suggest words": name-shaped words in my configured sessions' prompts and titles.
   *  Always from the redacted build, whichever version the page shows, so a word already hidden
   *  never comes back as a suggestion. */
  function suggestedWords() {
    const { h, redact } = context('redacted');
    // A prompt's shown text is an excerpt, which can miss a later name or cut a code block
    // open; the whole prompt the engine keeps in memory is scanned instead, redacted first.
    const promptText = (e) => (typeof e._raw?.text === 'string' ? redact(e._raw.text) : e.facts?.text);
    const listed = ['names', 'terms', 'codenames'].flatMap((k) => (Array.isArray(config?.redaction?.[k]) ? config.redaction[k] : []));
    const labels = (Array.isArray(config?.repos) ? config.repos : []).flatMap((r) => (typeof r?.label === 'string' ? r.label.split(/[^\p{L}\p{N}]+/u) : []));
    return { words: suggestWords({ sessions: h.sessions, events: h.events, include: (s) => sessionGroup(s) === 'configured', exclude: [...listed, ...labels], promptText }) };
  }

  const ROUTES = { '/api/suggest-words': suggestedWords, '/api/home': home, '/api/sessions': sessionsList, '/api/problems': problems, '/api/insights': insightsRoute, '/api/facts': factsRoute, '/api/lookup': lookup, '/api/words': wordSearch, '/api/goal': goal, '/api/replay': replay, '/api/record': recordRoute, '/api/search': search, ...(selfTest ? { '/api/selftest': selftestInfo } : {}) };

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
    const out = await fn(ctx, params);
    const answer = out && typeof out.status === 'number' && 'body' in out ? out : json(200, out);
    return json(answer.status, { ...answer.body, view: { asked, shown, note, privateState: priv.state, window: shownWindow(), demo: demoNote } });
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

  /** Stop this data for good: its builds run no more git, and nothing new starts. */
  function stop() {
    signal.aborted = true;
  }

  /** Settles once "search everywhere" has read the logs, or failed to (after start()). */
  const searchReady = () => words.promise ?? Promise.resolve();

  return { start, stop, status, route, leakCheck, codexWork, searchReady, routes: ['/api/status', ...Object.keys(ROUTES)] };
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
