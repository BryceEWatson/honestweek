// lib/view/problems-route.mjs: /api/problems, the Problems page and the "Worth a look" strip.
//
// The checks (lib/problems/) run once, over the redacted build, on sessions in configured
// repositories only, so Show private text changes words, never which findings exist. Each
// answer is then drawn for the build that answers it: a finding's step description and its
// session's title come from that build, and every string in the answer passes that build's
// redactor (the full one by default, the secrets-only one with the switch on). Ids, times and
// dates pass only when they have an id's, a time's or a date's shape. The one exception is a
// catalog source's title and address: they're the catalog's own published text, shipped with
// honestweek and the same on every machine, never read from a log, so they go out whole (the
// redactor read a dollar amount in a title as an account number, and an id or a long slug in an
// address as a secret, which broke the link). The address still goes out in parts. The leak
// counter (leaks.mjs) sets those two fields aside for the same reason.
//
// Each finding has a key (pf- and a letter hash of what identifies it) and a zoom: the steps its
// check recorded, in time order and by lane, how many it matched, and whether its one step is
// only the nearest (`stepsNear`). The zoom carries the finding's scope (lib/problems/scope.mjs):
// how Replay frames it (a moment, a stretch, a repeat, a hand-off or a turn ending), worked out
// once per run from the same redacted history the checks read, with only the steps the answering
// build holds. `?finding=<key>` answers one finding, for the replay's "Zoom to these steps"
// address (#<thread>~zoom~<key>).

import { letterHash } from '../replay/ids.mjs';
import { describe } from '../replay/views.mjs';
import { runProblems, SURE, trendCounts, trendOf } from '../problems/index.mjs';
import { historyIndex, scopeHeld, scopeOf } from '../problems/scope.mjs';

/** Findings listed per pattern on the whole page, of each kind (worked out, and possible); one
 *  session's view lists them all. */
export const PROBLEM_EXAMPLES = 25;

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,200}$/;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_SHAPE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,3}$/;
/** The only words a pattern's coverage status can be (lib/problems/catalog.json). */
const COVER_STATUS = new Set(['runs', 'partial', 'not yet']);
const FIX_VERSION = /^[0-9a-f]{4}$/;
const TEST_WORDS = { state: new Set(['fired', 'none', 'loaded', 'not-loaded', 'seen', 'not-seen', 'unknown']), level: new Set(['recorded', 'derived', 'inferred', 'missing']), why: new Set(['no-trace', 'unread', 'no-instructions-record', 'no-check', 'not-on-agent', 'not-run', 'too-short', 'running']) };
/** A fired or problem answer, only its fixed words. */
const wordsOf = (a) => Object.fromEntries(['state', 'level', 'why'].filter((k) => TEST_WORDS[k].has(a?.[k])).map((k) => [k, a[k]]));
const testOk = (t) => FIX_VERSION.test(t?.version ?? '') && ID_SHAPE.test(t.session ?? '') && ID_SHAPE.test(t.event ?? '') && ISO_SHAPE.test(t.at ?? '') && (t.tool === 'claude-code' || t.tool === 'codex') && t.fired && t.problem;
// A scope's step ids sit under steps, anchor, prompt, next, message, helper and parent.
const ID_KEYS = new Set(['id', 'session', 'thread', 'event', 'related', 'events', 'pattern', 'check', 'patterns', 'key', 'sessions', 'agent', 'steps', 'anchor', 'prompt', 'next', 'message', 'helper', 'parent']);
export const FINDING_KEY = /^pf-[a-p]{12}$/;
const TIME_KEYS = new Set(['at', 'lastAt', 'startAt', 'endAt']);
const DAY_KEYS = new Set(['from', 'to', 'checkedOn']);

/** A web address as its origin and its path parts: each part passes the redactor on its own. */
export function splitUrl(u) {
  const m = String(u ?? '').match(/^(https?:\/\/[^/?#]+)(.*)$/);
  return m ? [m[1], ...m[2].split(/(?=[/?#])/).filter(Boolean)] : [String(u ?? '')];
}

/**
 * Every string in `value` through `redact`, except an id, a time, a date or a timezone under
 * the key that names one, when it has that shape. Object keys pass when they have an id's
 * shape and are redacted otherwise.
 */
export function redactAnswer(value, redact, key = null, depth = 0) {
  if (depth > 40) return null;
  if (typeof value === 'string') {
    if (ID_KEYS.has(key) && ID_SHAPE.test(value)) return value;
    if (TIME_KEYS.has(key) && ISO_SHAPE.test(value)) return value;
    if (DAY_KEYS.has(key) && DAY_SHAPE.test(value)) return value;
    if (key === 'timezone' && ZONE_SHAPE.test(value)) return value;
    return redact(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactAnswer(v, redact, key, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[ID_SHAPE.test(k) ? k : redact(k)] = redactAnswer(v, redact, k, depth + 1);
    return out;
  }
  return value;
}

/**
 * createProblemsRoute({ now, run }) -> problems(ctx, params, helpers)
 *   ctx      the answering build's context from data.mjs ({ mode, b, h, sessionByKey, redact })
 *   helpers  { redactedH, builtT, goalsOf(ctx, key), membersOfGoal(key), evidenceKey, idOk }
 */
/**
 * The steps one finding covers, as its check recorded them: never a step in between that the
 * check didn't match. `events` are the recorded steps this build holds, in time order; `total`
 * is how many the check matched (null when it matched something other than steps); `unread`
 * counts recorded ids this build doesn't hold; `lanes` groups the steps by thread and agent.
 * Null when the check recorded no step this build holds.
 */
export function zoomOf(f, eventsById, threadOf) {
  const listed = (f.events ?? []).filter((x) => typeof x === 'string');
  const named = [...new Set([...listed, f.event, f.related].filter((x) => typeof x === 'string'))];
  const known = named.map((id) => eventsById?.get(id)).filter(Boolean).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  if (!known.length) return null;
  const extra = new Set([f.event, f.related].filter((x) => typeof x === 'string' && !listed.includes(x))).size;
  const total = f.stepsNear ? null : listed.length && Number.isFinite(f.steps) ? f.steps + extra : named.length;
  const lanes = [];
  for (const e of known) {
    const thread = threadOf(e.session) ?? null;
    let lane = lanes.find((l) => l.thread === thread && l.agent === (e.agent ?? null));
    if (!lane) lanes.push((lane = { thread, session: e.session ?? null, agent: e.agent ?? null, events: [] }));
    lane.events.push(e.id);
  }
  return {
    events: known.map((e) => e.id),
    total,
    near: f.stepsNear === true,
    unread: named.length - known.length,
    lanes,
    threads: new Set(lanes.map((l) => l.thread)).size,
    agents: new Set(lanes.map((l) => l.agent)).size,
  };
}

/**
 * The zoom with the finding's scope attached (lib/problems/scope.mjs), keeping only the steps
 * this build holds. With no zoom, or no scope (a check with no kind, a finding its kind can't
 * frame), the zoom is unchanged, and Replay frames the recorded steps as before.
 */
export function withScope(zoom, scope, eventsById) {
  if (!zoom) return zoom;
  const held = scopeHeld(scope, (id) => !!eventsById?.has(id));
  return held ? { ...zoom, scope: held } : zoom;
}

/** Each finding's key: a letter hash of what identifies it, made unique within one run. */
function keyFindings(result) {
  const keys = new Map();
  const byKey = new Map();
  for (const p of result.patterns) {
    for (const f of p.findings) {
      const base = [f.pattern, f.check, f.session, f.event, f.related, f.at, f.lastAt, f.kind, (f.events ?? []).join(',')].map((x) => String(x ?? '')).join('\u0000');
      let k;
      for (let n = 0; !k || byKey.has(k); n++) k = `pf-${letterHash(`${base}\u0000${n}`, 12)}`;
      keys.set(f, k);
      byKey.set(k, { f, p });
    }
  }
  return { keys, byKey };
}

export function createProblemsRoute({ now = () => Date.now(), run = runProblems, longSessionTokens = null } = {}) {
  let cache = null; // { h, result, error, keys, byKey, idx, scopes }
  const staticCache = new Map(); // mode -> the answer's parts that don't depend on params

  /** builtT: when the build began reading the logs, the moment "may still be running" is
   *  measured from; the first request can come long after. */
  function resultFor(h, builtT) {
    if (cache?.h !== h) {
      staticCache.clear();
      try {
        const result = run(h, { builtT: Number.isFinite(builtT) ? builtT : now(), longSessionTokens });
        cache = { h, result, error: null, ...keyFindings(result), idx: null, scopes: new Map() };
      } catch (err) {
        cache = { h, result: null, error: String(err?.message ?? err).split('\n')[0] };
      }
    }
    return cache;
  }

  /** A finding's scope from the history the checks read, worked out once per run. A scope that
   *  can't be worked out leaves the zoom as it was. */
  function scopeFor(f) {
    if (!cache?.scopes) return null;
    if (!cache.scopes.has(f)) {
      let s = null;
      try {
        cache.idx ??= historyIndex(cache.h);
        s = scopeOf(f, cache.idx);
      } catch {
        s = null;
      }
      cache.scopes.set(f, s);
    }
    return cache.scopes.get(f);
  }

  /** A pattern's catalog side and its counts, without findings, redacted for one mode. */
  function staticFor(mode, result, redact, engineRules) {
    if (staticCache.has(mode)) return staticCache.get(mode);
    const patterns = result.patterns.map((p) => ({
      id: p.id,
      name: p.name,
      headline: p.headline,
      group: p.group,
      looksLike: p.looksLike,
      whyItMatters: p.whyItMatters,
      strength: p.strength,
      strengthReason: p.strengthReason,
      sourceKinds: p.sourceKinds,
      sources: p.sources.map((s) => ({ title: s.title, link: splitUrl(s.url), date: s.date, kind: s.kind, says: s.says })),
      detection: { level: p.detection.level, summary: p.detection.summary, signals: p.detection.signals.map((x) => ({ signal: x.signal, level: x.level })), falsePositives: p.detection.falsePositives },
      coverage: p.coverage,
      mitigation: p.mitigation,
      related: p.related,
      status: p.status,
      notRun: p.notRun,
      measures: p.measures,
      count: p.count,
      look: p.look,
      notesFound: p.notesFound,
      derivedFound: p.derivedFound,
      claim: p.claim,
      sure: p.sure,
      possible: p.possible,
      testPrompt: p.testPrompt,
      testSetup: p.testSetup,
      testCost: p.testCost,
      testCostWhy: p.testCostWhy,
      testExpect: p.testExpect,
      tokens: p.tokens,
      countEvidence: p.countEvidence,
      priority: p.priority,
      draft: p.draft,
    }));
    // The rules go out as a list: some rule ids (problems.secret-shape) read as a credential's
    // field name when they're an object's keys. The engine's rules come too, because checks and
    // findings name some of them (shell.test, prompt.approval).
    const rules = Object.entries({ ...(engineRules ?? {}), ...result.rules }).map(([id, text]) => ({ id, text }));
    const out = redactAnswer({ window: result.window, catalog: result.catalog, groups: result.groups, priorityRule: result.priorityRule, statusCounts: result.statusCounts, coverage: result.coverage, rules, checks: result.checks, patterns }, redact);
    // A source's title and address are the catalog's published text, not log text: whole, so
    // the title reads as published and the link works. Everything else stays redacted.
    out.patterns.forEach((p, i) => p.sources.forEach((s, j) => {
      const src = result.patterns[i].sources[j];
      s.title = src.title;
      s.link = splitUrl(src.url);
    }));
    // A coverage status is one of a fixed set of words, never log text: the catalog's value goes
    // out whole, so a private word that happens to be "runs" can't change the page's advice, and
    // anything outside the set is dropped. The reason stays redacted.
    out.patterns.forEach((p, i) => {
      if (!p.coverage) return;
      for (const agent of Object.keys(p.coverage)) {
        const status = result.patterns[i].coverage?.[agent]?.status;
        if (COVER_STATUS.has(status)) p.coverage[agent].status = status;
        else delete p.coverage[agent].status;
      }
    });
    // Tests of a fix (lib/problems/fix-tests.mjs): ids, times and fixed words only, never log
    // text, so each goes out checked against its shape instead of through the redactor.
    out.patterns.forEach((p, i) => {
      const src = result.patterns[i];
      if (!src.testTag || !FIX_VERSION.test(src.fixVersion ?? '')) return;
      p.fixVersion = src.fixVersion;
      p.testTag = src.testTag;
      p.fixTests = (src.fixTests ?? []).filter(testOk).map((t) => ({ version: t.version, session: t.session, thread: ID_SHAPE.test(t.thread ?? '') ? t.thread : null, event: t.event, at: t.at, tool: t.tool, fired: wordsOf(t.fired), problem: { ...wordsOf(t.problem), ...(Number.isInteger(t.problem.count) ? { count: t.problem.count } : {}) } }));
    });
    staticCache.set(mode, out);
    return out;
  }

  /** One finding as the answering build shows it: its step's description and its session's title. */
  function findingOut(ctx, f, goalsOf) {
    const e = f.event ? ctx.b.eventsById?.get(f.event) : null;
    const s = ctx.sessionByKey.get(f.session);
    return {
      key: cache?.keys?.get(f) ?? null,
      pattern: f.pattern,
      check: f.check,
      checkTitle: f.checkTitle,
      severity: f.severity,
      verdictEvidence: f.verdictEvidence,
      basis: Array.isArray(f.basis) ? f.basis : null,
      rule: f.rule ?? null,
      session: f.session ?? null,
      thread: s?.thread ?? null,
      event: e ? f.event : null,
      related: f.related && ctx.b.eventsById?.has(f.related) ? f.related : null,
      relatedLabel: f.related ? f.relatedLabel ?? 'Replay at the related step' : null,
      at: f.at ?? null,
      lastAt: f.lastAt ?? null,
      kind: f.kind ?? null,
      note: f.note,
      text: e ? describe(e) : null,
      events: (f.events ?? []).filter((id) => ctx.b.eventsById?.has(id)),
      steps: f.steps ?? null,
      estimate: Number.isFinite(f.estimate) ? Math.round(f.estimate) : null,
      stillRunning: f.stillRunning === true,
      goals: f.session ? goalsOf(ctx, f.session).map((g) => ({ key: g.key, title: g.title })) : [],
      zoom: withScope(zoomOf(f, ctx.b.eventsById, (key) => ctx.sessionByKey.get(key)?.thread), scopeFor(f), ctx.b.eventsById),
    };
  }

  const sessionsOf = (ctx, findings, labelOf) => {
    const out = {};
    for (const f of findings) {
      if (!f.session || out[f.session]) continue;
      const s = ctx.sessionByKey.get(f.session);
      const label = labelOf?.(ctx, f.session) ?? null;
      // The repository is the configured label, already redacted with the rest of the history.
      out[f.session] = { title: s?.title ?? null, ...(label ? { label } : {}), thread: s?.thread ?? null, tool: s?.tool ?? null, repo: typeof s?.repo === 'string' ? s.repo : null };
    }
    return out;
  };

  return function problems(ctx, params, { redactedH, builtT, goalsOf, membersOfGoal, evidenceKey, idOk, earlier = null, labelOf = null }) {
    const { result, error } = resultFor(redactedH, builtT);
    if (!result) return { status: 500, body: { error: `The problem checks couldn't run: ${ctx.redact(error ?? 'unknown error')}` } };
    const base = staticFor(ctx.mode, result, ctx.redact, redactedH.rules);
    const session = params.get('session');
    const thread = params.get('thread');
    const goal = params.get('goal');
    const finding = params.get('finding');

    // One finding, for the replay's zoom: the finding as the page shows it, and its pattern's name
    // and tier.
    if (finding !== null) {
      if (!FINDING_KEY.test(finding)) return { status: 400, body: { error: 'That finding key is malformed.' } };
      const hit = cache.byKey.get(finding);
      if (!hit) return { status: 404, body: { error: 'No finding in this window has that key. The logs may have changed since the link was made.' } };
      const p = base.patterns.find((x) => x.id === hit.p.id);
      return { window: base.window, finding: redactAnswer(findingOut(ctx, hit.f, goalsOf), ctx.redact), pattern: { id: p.id, name: p.name, group: p.group, status: p.status, strength: p.strength, priority: p.priority, fix: p.draft?.title ?? p.mitigation?.[0]?.action ?? null }, catalogIds: base.patterns.map((x) => x.id), evidenceKey };
    }

    // The trend: each pattern's findings worth a look in this window against the window just
    // before it, of the same length. The earlier window is read only for these counts, once. A
    // list, like the rules: a pattern id such as secret-exposure reads as a credential's field
    // name when it's an object's key.
    if (params.get('trend') === '1') {
      if (typeof earlier !== 'function') return { status: 404, body: { error: 'No earlier window can be read here.' } };
      const now = trendCounts(result);
      return Promise.resolve(earlier()).then((before) => ({
        window: base.window,
        ...redactAnswer({ earlier: before?.window ? { from: before.window.from, to: before.window.to, days: before.window.days, sessions: before.error ? null : before.sessions, ...(before.skipped ? { skipped: before.skipped, note: before.note } : {}), ...(before.partial ? { partial: before.partial, note: before.note } : {}), ...(before.loaded && !before.skipped ? { loaded: before.loaded, note: before.note } : {}) } : null, trend: Object.entries(trendOf(now, before)).map(([id, t]) => ({ id, ...t })) }, ctx.redact),
        evidenceKey,
      }));
    }

    // The summary every page's header and the Find page read: each pattern's tier and counts,
    // with no findings and no catalog text beyond its name. `lookSessions` counts the sessions
    // with a finding worth a look, a number worked out from the same findings as `look`.
    if (params.get('summary') === '1') {
      const lookSessions = new Map(result.patterns.map((p) => [p.id, new Set(p.findings.filter((f) => f.severity === 'look' && f.session).map((f) => f.session)).size]));
      const patterns = base.patterns.map((p) => ({ id: p.id, name: p.name, group: p.group, status: p.status, strength: p.strength, priority: p.priority, count: p.count, look: p.look, notesFound: p.notesFound, countEvidence: p.countEvidence, tokens: p.tokens, lookSessions: lookSessions.get(p.id) ?? 0, sure: p.sure, possible: p.possible, fix: p.draft?.title ?? p.mitigation?.[0]?.action ?? null }));
      return { window: base.window, summary: true, groups: base.groups, statusCounts: base.statusCounts, coverage: base.coverage, patterns, catalogIds: base.patterns.map((p) => p.id), evidenceKey };
    }

    // The strip: the findings for the sessions one replay or goal page shows.
    if (thread !== null || goal !== null) {
      let keys;
      if (thread !== null) {
        if (!idOk(thread)) return { status: 400, body: { error: 'That thread id is malformed.' } };
        keys = ctx.h.threads.find((t) => t.id === thread)?.sessions ?? [];
      } else {
        keys = membersOfGoal(goal);
        if (keys === null) return { status: 404, body: { error: 'No goal in your goal list has that key.' } };
      }
      const want = new Set(keys);
      const found = result.patterns.flatMap((p) => p.findings.filter((f) => want.has(f.session)));
      const ids = new Set(found.map((f) => f.pattern));
      const findings = found.map((f) => findingOut(ctx, f, goalsOf)).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
      const patterns = base.patterns.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, name: p.name, group: p.group, status: p.status, strength: p.strength, priority: p.priority, fix: p.draft?.title ?? p.mitigation?.[0]?.action ?? null }));
      // Every catalog id rides along, so the page's preferences keep "My priority" for patterns
      // with no finding on this page.
      return { window: base.window, sessions: keys, patterns, catalogIds: base.patterns.map((p) => p.id), findings: redactAnswer(findings, ctx.redact), coverage: base.coverage, evidenceKey };
    }

    let focus = null;
    const sure = (f) => SURE.includes(f.verdictEvidence);
    // Each pattern lists its most recent findings first: those worth a look, then routine notes.
    const newest = (list) => [...list].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'look' ? -1 : 1) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
    let pick = (p) => [...newest(p.findings.filter(sure)).slice(0, PROBLEM_EXAMPLES), ...newest(p.findings.filter((f) => !sure(f))).slice(0, PROBLEM_EXAMPLES)];
    if (session !== null) {
      if (!idOk(session)) return { status: 400, body: { error: 'That session id is malformed.' } };
      const s = ctx.sessionByKey.get(session);
      const all = result.patterns.flatMap((p) => p.findings.filter((f) => f.session === session));
      const label = labelOf?.(ctx, session) ?? null;
      focus = { session, title: s?.title ?? null, ...(label ? { label } : {}), thread: s?.thread ?? null, known: !!s, findings: all.length, look: all.filter((f) => f.severity === 'look').length, patterns: new Set(all.map((f) => f.pattern)).size };
      pick = (p) => newest(p.findings.filter((f) => f.session === session));
    }
    const shown = new Map(result.patterns.map((p) => [p.id, pick(p)]));
    const rendered = new Map([...shown].map(([id, list]) => [id, redactAnswer(list.map((f) => findingOut(ctx, f, goalsOf)), ctx.redact)]));
    const patterns = base.patterns.map((p) => ({ ...p, findings: rendered.get(p.id), findingsListed: result.patterns.find((x) => x.id === p.id).findings.length }));
    const all = [...shown.values()].flat();
    return { ...base, patterns, focus: focus ? redactAnswer(focus, ctx.redact) : null, sessions: redactAnswer(sessionsOf(ctx, all, labelOf), ctx.redact), examples: PROBLEM_EXAMPLES, evidenceKey };
  };
}
