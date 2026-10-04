// lib/view/problems-route.mjs: /api/problems, the Problems page and the "Worth a look" strip.
//
// The checks (lib/problems/) run once, over the redacted build, on sessions in configured
// repositories only, so Show private text changes words, never which findings exist. Each
// answer is then drawn for the build that answers it: a finding's step description and its
// session's title come from that build, and every string in the answer passes that build's
// redactor (the full one by default, the secrets-only one with the switch on). Ids, times and
// dates pass only when they have an id's, a time's or a date's shape. A source's address goes
// out in parts, each redacted on its own, so a part the redactor hides drops the link and
// keeps the title.

import { describe } from '../replay/views.mjs';
import { runProblems } from '../problems/index.mjs';

/** Findings listed per pattern on the whole page; one session's view lists them all. */
export const PROBLEM_EXAMPLES = 25;

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,200}$/;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_SHAPE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,3}$/;
const ID_KEYS = new Set(['id', 'session', 'thread', 'event', 'related', 'events', 'pattern', 'check', 'patterns', 'key', 'sessions']);
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
export function createProblemsRoute({ now = () => Date.now(), run = runProblems } = {}) {
  let cache = null; // { h, result, error }
  const staticCache = new Map(); // mode -> the answer's parts that don't depend on params

  /** builtT: when the build began reading the logs, the moment "may still be running" is
   *  measured from; the first request can come long after. */
  function resultFor(h, builtT) {
    if (cache?.h !== h) {
      staticCache.clear();
      try {
        cache = { h, result: run(h, { builtT: Number.isFinite(builtT) ? builtT : now() }), error: null };
      } catch (err) {
        cache = { h, result: null, error: String(err?.message ?? err).split('\n')[0] };
      }
    }
    return cache;
  }

  /** A pattern's catalog side and its counts, without findings, redacted for one mode. */
  function staticFor(mode, result, redact, engineRules) {
    if (staticCache.has(mode)) return staticCache.get(mode);
    const patterns = result.patterns.map((p) => ({
      id: p.id,
      name: p.name,
      group: p.group,
      looksLike: p.looksLike,
      whyItMatters: p.whyItMatters,
      strength: p.strength,
      strengthReason: p.strengthReason,
      sourceKinds: p.sourceKinds,
      sources: p.sources.map((s) => ({ title: s.title, link: splitUrl(s.url), date: s.date, kind: s.kind, says: s.says })),
      detection: { level: p.detection.level, summary: p.detection.summary, signals: p.detection.signals.map((x) => ({ signal: x.signal, level: x.level })), falsePositives: p.detection.falsePositives },
      mitigation: p.mitigation,
      related: p.related,
      status: p.status,
      notRun: p.notRun,
      measures: p.measures,
      count: p.count,
      look: p.look,
      notesFound: p.notesFound,
      derivedFound: p.derivedFound,
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
    staticCache.set(mode, out);
    return out;
  }

  /** One finding as the answering build shows it: its step's description and its session's title. */
  function findingOut(ctx, f, goalsOf) {
    const e = f.event ? ctx.b.eventsById?.get(f.event) : null;
    const s = ctx.sessionByKey.get(f.session);
    return {
      pattern: f.pattern,
      check: f.check,
      checkTitle: f.checkTitle,
      severity: f.severity,
      verdictEvidence: f.verdictEvidence,
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
    };
  }

  const sessionsOf = (ctx, findings) => {
    const out = {};
    for (const f of findings) {
      if (!f.session || out[f.session]) continue;
      const s = ctx.sessionByKey.get(f.session);
      out[f.session] = { title: s?.title ?? null, thread: s?.thread ?? null, tool: s?.tool ?? null };
    }
    return out;
  };

  return function problems(ctx, params, { redactedH, builtT, goalsOf, membersOfGoal, evidenceKey, idOk }) {
    const { result, error } = resultFor(redactedH, builtT);
    if (!result) return { status: 500, body: { error: `The problem checks couldn't run: ${ctx.redact(error ?? 'unknown error')}` } };
    const base = staticFor(ctx.mode, result, ctx.redact, redactedH.rules);
    const session = params.get('session');
    const thread = params.get('thread');
    const goal = params.get('goal');

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
    let pick = (p) => p.findings.slice(0, PROBLEM_EXAMPLES);
    if (session !== null) {
      if (!idOk(session)) return { status: 400, body: { error: 'That session id is malformed.' } };
      const s = ctx.sessionByKey.get(session);
      const all = result.patterns.flatMap((p) => p.findings.filter((f) => f.session === session));
      focus = { session, title: s?.title ?? null, thread: s?.thread ?? null, known: !!s, findings: all.length, look: all.filter((f) => f.severity === 'look').length, patterns: new Set(all.map((f) => f.pattern)).size };
      pick = (p) => p.findings.filter((f) => f.session === session);
    }
    const shown = new Map(result.patterns.map((p) => [p.id, pick(p)]));
    const rendered = new Map([...shown].map(([id, list]) => [id, redactAnswer(list.map((f) => findingOut(ctx, f, goalsOf)), ctx.redact)]));
    const patterns = base.patterns.map((p) => ({ ...p, findings: rendered.get(p.id), findingsListed: result.patterns.find((x) => x.id === p.id).findings.length }));
    const all = [...shown.values()].flat();
    return { ...base, patterns, focus: focus ? redactAnswer(focus, ctx.redact) : null, sessions: redactAnswer(sessionsOf(ctx, all), ctx.redact), examples: PROBLEM_EXAMPLES, evidenceKey };
  };
}
