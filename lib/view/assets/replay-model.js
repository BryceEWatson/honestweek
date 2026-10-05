// The replay page's pure logic, with no page in it: the time axis with each long stretch with no
// new step squeezed into a narrow break labelled by what filled it, the steps the agent waited
// on, the findings worth a look as the Problems row's dots and each step's chips, the story's
// cards and its groups of repeated steps, where a step sits in them (the two-way link between
// the timeline and the story), how a finding's zoom frames it (its scope: a moment, a
// stretch, a repeat, a hand-off or a turn ending), and the problem focus a finding opens: its
// key facts, its cause drawn, the lanes it involves and its steps list. replay.js draws what
// these answer; the node tests import this file the way prefs.js is imported
// (test/view-replay-model.test.mjs, test/view-replay-focus.test.mjs).
(function (root) {
  'use strict';

  // ---- which records are steps --------------------------------------------------------------
  /** Housekeeping records sit on the chart but aren't steps: Step, Play and the story skip them. */
  const HOUSEKEEPING = Object.freeze(['link', 'mode', 'queue', 'hook', 'quiet']);
  const isStep = (e) => !!e && !HOUSEKEEPING.includes(e.kind);
  /** When each record starts. A "quiet" record is the engine's own mark for a stretch with no
   *  records, so it never counts as one. */
  const starts = (events) => events.filter((e) => e && e.kind !== 'quiet' && Number.isFinite(e.t)).map((e) => e.t);

  // ---- recorded spans and long waits ----------------------------------------------------------
  /** A step's recorded span (its call to its recorded result), or null when it has none. */
  const spanOf = (e) => (e && Number.isFinite(e.t) && Number.isFinite(e.endT) && e.endT > e.t ? e.endT - e.t : null);
  /** A step the agent waited on: a recorded span of 30 seconds or more. */
  const LONG_WAIT_MS = 30e3;
  const isLongWait = (e) => (spanOf(e) ?? 0) >= LONG_WAIT_MS;
  /** A span in words, to the second under an hour: "450 ms", "12 s", "4 min 12 s", "1 h 5 min". */
  function spanText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    let s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    let m = Math.floor(s / 60);
    s -= m * 60;
    if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
    const h = Math.floor(m / 60);
    m -= h * 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  /** A stretch in whole minutes: "19 min", "2 h 5 min". */
  function minText(ms) {
    const all = Math.max(1, Math.round(ms / 60e3));
    if (all < 60) return `${all} min`;
    const h = Math.floor(all / 60);
    const m = all - h * 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  /** A served string cut to about `n` characters between words, never inside a hidden part
   *  ([redacted:…]), with "…" when it was cut. */
  function cutWords(s, n) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    let at = t.lastIndexOf(' ', n);
    if (at < n / 3) at = n;
    const open = t.lastIndexOf('[redacted:', at);
    if (open >= 0 && t.indexOf(']', open) >= at) at = open;
    return `${t.slice(0, at).trimEnd()}…`;
  }
  /** A step in a few words for a label: its command, else its file, else its tool. */
  const shortWhat = (e, n = 28) => cutWords(e?.facts?.command ?? e?.facts?.file ?? e?.tool ?? e?.facts?.tool ?? e?.kind ?? 'a step', n);

  // ---- stretches with no new step ------------------------------------------------------------
  /** The shortest stretch with no new step that becomes a break: two minutes, or a tenth of the
   *  session's span when that's longer. */
  const MIN_IDLE_MS = 120e3;
  const IDLE_SHARE = 0.1;
  const idleLimit = (T0, T1, { minMs = MIN_IDLE_MS, share = IDLE_SHARE } = {}) => Math.max(minMs, share * Math.max(0, T1 - T0));

  /** The stretches longer than the limit in which no new step starts. `times` is when each
   *  record starts (`starts(events)`). */
  function idleGaps(times, T0, T1, opts = {}) {
    const limit = idleLimit(T0, T1, opts);
    const ts = times.filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > limit) gaps.push([ts[i - 1], ts[i]]);
    return { gaps, limit };
  }

  /** What filled a break, decided by the records, first match wins:
   *  - "wait": a step was in flight across it (its recorded span starts at or before the break
   *    and covers at least half of it): "waiting on <command or tool>, N min";
   *  - "helper": a helper was open across it (started before it, and its completion, or its last
   *    record when none is recorded, comes after at least half of it): "helper still open, N min";
   *  - "unrecorded": inside a turn, with nothing in flight: "no records, N min (not idle, just
   *    unrecorded)";
   *  - "between": the next step is your prompt: "N min before your next prompt";
   *  - otherwise "unrecorded" too.
   *  Every label is worked out from recorded times, so it's derived. Answers { kind, level,
   *  pieces: [[text, fromTheLogs]], text, ms, step, agent }. `steps` and `agents` as the replay
   *  answer has them (t, endT; spawnAt, firstAt, lastAt, completion), `turns` with startAt and
   *  lastRecordAt or endAt, `isMain(agentKey)` for the agent kinds. */
  function breakLabel([a, b], { steps = [], agents = [], turns = [] } = {}) {
    const len = b - a;
    const half = len / 2;
    const T = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN);
    const out = (kind, pieces, extra = {}) => ({ kind, level: 'derived', pieces, text: pieces.map(([t]) => t).join(''), ms: len, ...extra });
    let wait = null;
    for (const e of steps) {
      const sp = spanOf(e);
      if (sp == null || e.t > a || e.endT <= a) continue;
      const covered = Math.min(e.endT, b) - a;
      if (covered >= half && (!wait || covered > wait.covered)) wait = { e, covered };
    }
    if (wait) {
      // The "…" of a cut command is the page's own mark, kept apart from the log's words.
      const what = shortWhat(wait.e);
      const cut = what.endsWith('…');
      return out('wait', [['waiting on ', false], [cut ? what.slice(0, -1) : what, true], ...(cut ? [['…', false]] : []), [`, ${minText(spanOf(wait.e))}`, false]], { step: wait.e });
    }
    for (const g of agents) {
      if (!g || g.kind === 'main') continue;
      const s = T(g.spawnAt ?? g.firstAt);
      const end = T(g.completion?.at ?? g.lastAt);
      if (Number.isFinite(s) && Number.isFinite(end) && s <= a && end - a >= half) return out('helper', [[`helper still open, ${minText(len)}`, false]], { agent: g });
    }
    const inTurn = turns.some((t) => {
      const s = T(t.startAt);
      const end = T(t.lastRecordAt ?? t.endAt);
      return Number.isFinite(s) && Number.isFinite(end) && s <= a && end >= b;
    });
    if (inTurn) return out('unrecorded', [[`no records, ${minText(len)} (not idle, just unrecorded)`, false]]);
    // The first record after the break that isn't housekeeping or a session's start (a hook can
    // fire as a prompt lands, and a resumed session records its start just before it).
    const next = steps.filter((e) => e.t >= b && !HOUSEKEEPING.includes(e.kind) && e.kind !== 'session').sort((p, q) => p.t - q.t)[0];
    if (next && next.kind === 'prompt') return out('between', [[`${minText(len)} before your next prompt`, false]]);
    return out('unrecorded', [[`no records, ${minText(len)} (not idle, just unrecorded)`, false]]);
  }

  // ---- the time scale -------------------------------------------------------------------------
  /** A scale from time to pixels over the view [v0, v1] onto [p0, p1]. Each gap whose part
   *  inside the view is at least `limit` long becomes a break of fixed width `breakW`; the busy
   *  stretches share the rest of the width in proportion to their length. With no break the scale
   *  is linear. Answers { x(t), t(px), pieces, breaks, compressed }: each piece is
   *  { t0, t1, x0, x1, brk }. */
  function makeScale({ v0, v1, p0, p1, gaps = [], limit = 0, breakW = 36 }) {
    const span = Math.max(1, v1 - v0);
    const width = Math.max(1, p1 - p0);
    const cuts = [];
    for (const [a, b] of gaps) {
      const s = Math.max(a, v0);
      const e = Math.min(b, v1);
      if (e > s && e - s >= limit) cuts.push([s, e]);
    }
    cuts.sort((a, b) => a[0] - b[0]);
    const busy = span - cuts.reduce((n, [s, e]) => n + (e - s), 0);
    const room = width - cuts.length * breakW;
    if (!cuts.length || busy <= 0 || room < width * 0.25) {
      const k = width / span;
      const piece = { t0: v0, t1: v1, x0: p0, x1: p1, brk: false };
      return { x: (t) => p0 + (t - v0) * k, t: (px) => v0 + (px - p0) / k, pieces: [piece], breaks: [], compressed: false, k };
    }
    const k = room / busy;
    const pieces = [];
    let t = v0;
    let x = p0;
    for (const [s, e] of cuts) {
      if (s > t) {
        pieces.push({ t0: t, t1: s, x0: x, x1: x + (s - t) * k, brk: false });
        x += (s - t) * k;
      }
      pieces.push({ t0: s, t1: e, x0: x, x1: x + breakW, brk: true });
      x += breakW;
      t = e;
    }
    if (v1 > t) pieces.push({ t0: t, t1: v1, x0: x, x1: x + (v1 - t) * k, brk: false });
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    const toX = (time) => {
      if (time <= first.t0) return first.x0 + (time - first.t0) * k;
      if (time >= last.t1) return last.x1 + (time - last.t1) * k;
      for (const p of pieces) {
        if (time <= p.t1) return p.t1 === p.t0 ? p.x0 : p.x0 + ((time - p.t0) / (p.t1 - p.t0)) * (p.x1 - p.x0);
      }
      return last.x1;
    };
    const toT = (px) => {
      if (px <= first.x0) return first.t0 + (px - first.x0) / k;
      if (px >= last.x1) return last.t1 + (px - last.x1) / k;
      for (const p of pieces) {
        if (px <= p.x1) return p.x1 === p.x0 ? p.t0 : p.t0 + ((px - p.x0) / (p.x1 - p.x0)) * (p.t1 - p.t0);
      }
      return last.t1;
    };
    return { x: toX, t: toT, pieces, breaks: pieces.filter((p) => p.brk), compressed: true, k };
  }

  /** The axis ticks: in each busy stretch, round times at a spacing its own pixels allow
   *  (`niceStep(msPerPx)`), and the stretch's first moment when it starts the view or a break
   *  comes before it, so the times either side of a break read true. Each is { t, x, step, edge }. */
  function axisTicks(scale, niceStep) {
    const out = [];
    scale.pieces.forEach((p, i) => {
      if (p.brk) return;
      const w = p.x1 - p.x0;
      if (w < 1 || p.t1 <= p.t0) return;
      const step = niceStep((p.t1 - p.t0) / w);
      if (i === 0 || scale.pieces[i - 1].brk) out.push({ t: p.t0, x: p.x0, step, edge: true });
      for (let t = Math.ceil(p.t0 / step) * step; t <= p.t1; t += step) out.push({ t, x: scale.x(t), step, edge: false });
    });
    out.sort((a, b) => a.x - b.x || a.t - b.t);
    return out.filter((tk, i) => i === 0 || Math.abs(tk.x - out[i - 1].x) >= 1);
  }

  // ---- findings ---------------------------------------------------------------------------------
  const RANK = { high: 0, medium: 1, low: 2, dismissed: 3 };
  const PATTERN_ID = /^[a-z][a-z0-9-]{1,60}$/;
  const FINDING_KEY = /^pf-[a-p]{12}$/;
  const SESSION_ID = /^[a-z]{2,4}-[a-p]{4,64}$/;
  const THREAD_ID = /^th-[a-p]{4,64}$/;
  const STEP_ID = /^[a-z]{2,4}-[a-p]{4,64}(?:[.:][A-Za-z0-9_-]{1,80}){0,6}$/;

  /** The findings of the sessions on screen, each with its pattern's tier (the rule's, or "My
   *  priority" through `tierOf(pattern)`), its moment and its step. A finding "worth a look" has
   *  severity "look"; the rest are routine notes. A pattern marked not a problem is "dismissed".
   *  answer: /api/problems?thread=; opts: { tierOf, sessions (keys, or null for all), eventT }. */
  function findingItems(answer, { tierOf = (p) => (p?.priority?.tier ? { tier: p.priority.tier, mine: false } : null), sessions = null, eventT = () => null } = {}) {
    const pats = new Map((Array.isArray(answer?.patterns) ? answer.patterns : []).filter((p) => p && PATTERN_ID.test(p.id)).map((p) => [p.id, p]));
    const want = sessions ? new Set(sessions) : null;
    const items = [];
    for (const f of Array.isArray(answer?.findings) ? answer.findings : []) {
      if (!f || (want && !want.has(f.session))) continue;
      const p = pats.get(f.pattern);
      const eff = p ? tierOf(p) : null;
      if (!eff || !(eff.tier in RANK)) continue;
      const known = typeof f.event === 'string' ? eventT(f.event) : null;
      const t = Number.isFinite(known) ? known : Date.parse(f.at);
      if (!Number.isFinite(t)) continue;
      items.push({
        k: items.length,
        f,
        p,
        tier: eff.tier,
        mine: !!eff.mine,
        look: f.severity === 'look',
        dismissed: eff.tier === 'dismissed',
        event: typeof f.event === 'string' ? f.event : null,
        known: Number.isFinite(known),
        t,
        level: typeof f.verdictEvidence === 'string' ? f.verdictEvidence : 'inferred',
      });
    }
    return items;
  }
  const SURE = new Set(['recorded', 'derived']);
  const byTier = (a, b) => (a.look === b.look ? 0 : a.look ? -1 : 1) || RANK[a.tier] - RANK[b.tier] || a.t - b.t || a.k - b.k;

  /** The Problems row: one dot per finding worth a look (and, when asked, per routine note), at
   *  its step's time, never one in a pattern marked not a problem. */
  function problemDots(items, { routine = false } = {}) {
    return items.filter((i) => !i.dismissed && (i.look || routine)).sort((a, b) => a.t - b.t || RANK[a.tier] - RANK[b.tier] || a.k - b.k);
  }

  /** How many findings worth a look of each tier, routine notes and dismissed ones. Of those worth
   *  a look, `possible` counts the ones only a rule's reading or a missing record backs (the
   *  Problems page's Possible), and `levels` lists how each is known. */
  function tierCounts(items) {
    const c = { high: 0, medium: 0, low: 0, look: 0, possible: 0, levels: [], routine: 0, dismissed: 0 };
    for (const i of items) {
      if (i.dismissed) c.dismissed++;
      else if (!i.look) c.routine++;
      else {
        c[i.tier]++;
        c.look++;
        if (!SURE.has(i.level)) c.possible++;
        c.levels.push(i.level);
      }
    }
    return c;
  }

  /** Each step's findings (worth a look first, by tier, then routine notes), by its event id. */
  function flagsByEvent(items) {
    const out = new Map();
    for (const i of items) {
      if (i.dismissed || !i.event) continue;
      (out.get(i.event) ?? out.set(i.event, []).get(i.event)).push(i);
    }
    for (const l of out.values()) l.sort(byTier);
    return out;
  }

  /** The top tier among a step's findings worth a look, or null: the colour of its ring. */
  function ringTier(list) {
    const look = (list ?? []).filter((i) => i.look && !i.dismissed);
    if (!look.length) return null;
    return look.reduce((best, i) => (RANK[i.tier] < RANK[best] ? i.tier : best), 'low');
  }

  /** The step to go to for Previous problem or Next problem from moment `t` (the selected step
   *  `id` counts as being on its own problem): the dots' known steps in time order. */
  function problemStep(dots, { t, id = null, dir }) {
    const steps = [];
    const seen = new Set();
    for (const d of dots) {
      if (!d.known || !d.event || seen.has(d.event)) continue;
      seen.add(d.event);
      steps.push({ id: d.event, t: d.t });
    }
    const at = steps.findIndex((s) => s.id === id);
    if (at >= 0) return steps[at + dir]?.id ?? null;
    if (dir > 0) return steps.find((s) => s.t > t)?.id ?? null;
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].t < t) return steps[i].id;
    return null;
  }

  /** The replay zoomed to a finding's recorded steps, in its own thread's lane when it has one
   *  (the same link the Problems page and the strip build). */
  function zoomHref(f) {
    const lanes = f?.zoom?.lanes;
    if (!FINDING_KEY.test(f?.key ?? '') || !Array.isArray(lanes) || !lanes.length) return null;
    const lane = lanes.find((l) => l.thread === f.thread) ?? lanes[0];
    if (!SESSION_ID.test(lane?.session ?? '') || !THREAD_ID.test(lane?.thread ?? '')) return null;
    return `replay.html?session=${encodeURIComponent(lane.session)}#${lane.thread}~zoom~${f.key}`;
  }

  // ---- a finding's scope: how its zoom frames it ---------------------------------------------------
  /** The kinds a finding's scope can be (lib/problems/scope.mjs), and the steps a scope names
   *  beside the ones it rings: your prompt before them, your next prompt, the turn's last message,
   *  a helper's last record and its parent carrying on. */
  const SCOPE_KINDS = Object.freeze(['moment', 'stretch', 'repeat', 'hand-off', 'turn-end']);
  const SCOPE_ROLES = Object.freeze(['prompt', 'next', 'message', 'helper', 'parent']);
  const LEVELS = ['recorded', 'derived', 'inferred', 'missing', 'ambiguous'];
  const spanIn = (o) => (o && typeof o === 'object' && Number.isFinite(o.from) && Number.isFinite(o.to) && o.to >= o.from ? { from: o.from, to: o.to } : null);

  /** A served scope as the replay uses it, or null when it's missing or malformed (the zoom then
   *  frames the recorded steps as before). Only steps this replay holds (`has`) stay, the ringed
   *  ones in time order (`tOf`); a named step it lacks drops to null. */
  function readScope(s, { has = () => true, tOf = () => 0 } = {}) {
    if (!s || typeof s !== 'object' || !SCOPE_KINDS.includes(s.kind)) return null;
    const frame = spanIn(s);
    if (!frame) return null;
    const ok = (id) => typeof id === 'string' && has(id);
    const steps = [...new Set(Array.isArray(s.steps) ? s.steps.filter(ok) : [])].sort((a, b) => tOf(a) - tOf(b));
    if (!steps.length) return null;
    const out = { kind: s.kind, steps, from: frame.from, to: frame.to, stretch: null, gap: spanIn(s.gap), anchor: ok(s.anchor) ? s.anchor : steps[0], caption: typeof s.caption === 'string' && s.caption ? s.caption : null, level: LEVELS.includes(s.level) ? s.level : null };
    const st = spanIn(s.stretch);
    if (st) out.stretch = { ...st, agent: typeof s.stretch.agent === 'string' ? s.stretch.agent : null };
    for (const r of SCOPE_ROLES) out[r] = ok(s[r]) ? s[r] : null;
    return out;
  }

  /** The view a scope opens on: its frame with a small margin either side, never past `within`
   *  (the replay's first and last record) when it's given. */
  function scopeFrame(S, { minPad = 10e3, share = 0.04, within = null } = {}) {
    const pad = Math.max(minPad, (S.to - S.from) * share);
    const [lo, hi] = Array.isArray(within) && within.every(Number.isFinite) ? within : [-Infinity, Infinity];
    return [Math.max(lo, S.from - pad), Math.min(hi, S.to + pad)];
  }

  /** The steps a scope names beside the ones it rings, by id, with their role. A named step that
   *  is also ringed stays only ringed. */
  function scopeMarks(S) {
    const out = new Map();
    if (!S) return out;
    const rung = new Set(S.steps);
    for (const r of SCOPE_ROLES) if (S[r] && !rung.has(S[r]) && !out.has(S[r])) out.set(S[r], r);
    return out;
  }

  /** How a step stands in a zoom: 'ring' (one of the finding's steps), a role the scope names it
   *  for, 'stretch' (the stretch's own agent, inside the stretch), or null (it steps back). */
  function scopeRole(S, e, { set, marks } = {}) {
    if (!e) return null;
    if (set ? set.has(e.id) : (S?.steps ?? []).includes(e.id)) return 'ring';
    const m = (marks ?? scopeMarks(S)).get(e.id);
    if (m) return m;
    const st = S?.stretch;
    if (st && st.agent && e.agent === st.agent && e.t >= st.from && e.t <= st.to) return 'stretch';
    return null;
  }

  /** Which numbers a repeat can show on one row without two touching: the indexes into `xs` (each
   *  step's x, in order) whose number is drawn, at least `gap` pixels from the last one drawn. */
  function repeatNumbers(xs, { gap = 14 } = {}) {
    const out = [];
    let last = -Infinity;
    xs.forEach((x, i) => {
      if (!Number.isFinite(x) || x - last < gap) return;
      out.push(i);
      last = x;
    });
    return out;
  }

  // ---- a problem's focus: what the replay shows when it opens from a finding --------------------
  /** Token counts the way the problem checks write them (lib/problems/checks.mjs fmt): 1.2M, 340k. */
  function tokensText(n) {
    if (!Number.isFinite(n)) return '?';
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
    if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
  }
  const words = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const isEvent = (x) => !!x && typeof x.id === 'string' && Number.isFinite(x.t);

  /** One agent's context per model call from the replay's `contextCalls`: { agent, threshold,
   *  calls: [{ n, t, context }], cross (the index of the first call at or past the threshold, or
   *  -1), max, after (the calls after the crossing) }. Null when the answer has none for it, or
   *  any call is malformed: the calls are numbered as the check numbers them, so none is dropped. */
  function contextPlan(answer, agent) {
    const threshold = answer?.threshold;
    const list = Array.isArray(answer?.agents) ? answer.agents.find((a) => a && a.agent === agent)?.calls : null;
    if (!Number.isFinite(threshold) || threshold <= 0 || !Array.isArray(list) || !list.length) return null;
    if (!list.every((c) => c && Number.isFinite(c.t) && Number.isFinite(c.context) && c.context >= 0)) return null;
    const calls = list.map((c, i) => ({ n: i + 1, t: c.t, context: c.context }));
    const cross = calls.findIndex((c) => c.context >= threshold);
    return { agent, threshold, calls, cross, max: Math.max(...calls.map((c) => c.context)), after: cross >= 0 ? calls.length - cross - 1 : 0 };
  }

  /** The scope the focus draws: the finding's own, or for a check with no kind, its recorded
   *  steps as a moment with nothing named beside them. Null with no step. */
  function focusScope(S, ids, tOf = () => 0) {
    if (S) return S;
    const steps = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
    if (!steps.length) return null;
    const ts = steps.map(tOf).filter(Number.isFinite);
    return { kind: 'moment', steps, from: ts.length ? Math.min(...ts) : 0, to: ts.length ? Math.max(...ts) : 0, stretch: null, gap: null, anchor: steps[0], caption: null, level: null, prompt: null, next: null, message: null, helper: null, parent: null };
  }

  /** The lanes the focus gives a row of their own: yours, then every lane the scope's steps, the
   *  steps it names and its stretch's agent sit in, and in a hand-off the helper its call started.
   *  `laneOf(id)` answers a step's lane key, `spawned(id)` the helper's lane a call started. */
  function focusLanes(S, { laneOf = () => null, spawned = () => null } = {}) {
    const out = new Set(['person']);
    if (!S) return out;
    const add = (k) => typeof k === 'string' && k && out.add(k);
    for (const id of [...(S.steps ?? []), S.anchor, ...SCOPE_ROLES.map((r) => S[r])]) if (typeof id === 'string') add(laneOf(id));
    if (S.stretch?.agent) add(S.stretch.agent);
    if (S.kind === 'hand-off') for (const id of [S.anchor, ...(S.steps ?? [])]) if (typeof id === 'string') add(spawned(id));
    return out;
  }

  /** The page's lanes split for the focus: `shown`, the involved ones in the page's order, each
   *  on its own row (a helper never merged with the others), and `other`, the rest, which fold
   *  into one Other activity row. */
  function splitLanes(lanes, involved) {
    const shown = [];
    const other = [];
    for (const l of Array.isArray(lanes) ? lanes : []) (involved.has(l.key) ? shown : other).push(l);
    return { shown, other };
  }

  /** The focus's steps list: only the scope's own steps and the steps its frame holds (the ones
   *  it names, and a stretch's own agent's steps inside it), in order, each with its role
   *  ('ring', a role from SCOPE_ROLES, or 'stretch'). Everything else waits for "Show every step". */
  function focusSteps(S, steps, { set, marks } = {}) {
    if (!S) return [];
    const opts = { set: set ?? new Set(S.steps), marks: marks ?? scopeMarks(S) };
    const out = [];
    for (const e of Array.isArray(steps) ? steps : []) {
      const role = scopeRole(S, e, opts);
      if (role) out.push({ e, role });
    }
    return out;
  }

  /** At most `max` of a list, as its first ones, a { more: n } in place of the middle, and its
   *  last ones. */
  function capList(list, max, tail) {
    if (list.length <= max) return list;
    const head = max - tail - 1;
    return [...list.slice(0, head), { more: list.length - head - tail }, ...list.slice(-tail)];
  }

  /** What "The cause, drawn" shows, by the scope's kind: `draw` is 'context' (the long-session
   *  check's context per model call, when the replay has it), 'sequence' (a moment: the prompt
   *  before, outlined, then the steps), 'repeat' (the repeats, numbered, with the count),
   *  'hand-off' (the helper starting, its last record, the gap, the parent carrying on) or
   *  'turn-end' (the last message, the wait, the next prompt). Each item is { id, role, n },
   *  { gap: { from, to } }, { end: true } (nothing after it in the replay) or { more: n }. */
  function focusDraw(f, S, { ctx = null, has = () => true, tOf = () => 0 } = {}) {
    if (!S) return null;
    const own = S.steps.filter(has).map((id) => ({ id, role: 'ring' }));
    const named = (r) => (S[r] && has(S[r]) && !S.steps.includes(S[r]) ? [{ id: S[r], role: r }] : []);
    // A hand-off's or a turn ending's steps in time order, the gap where it falls (before the
    // first step at or after its end), and an end card when nothing follows in the replay.
    const around = (list, follows) => {
      const sorted = [...list].sort((a, b) => tOf(a.id) - tOf(b.id));
      if (S.gap) {
        const i = sorted.findIndex((x) => tOf(x.id) >= S.gap.to);
        sorted.splice(i < 0 ? sorted.length : i, 0, { gap: { from: S.gap.from, to: S.gap.to } });
      }
      return follows ? sorted : [...sorted, { end: true }];
    };
    switch (S.kind) {
      case 'stretch':
        if (f?.check === 'long-sessions' && ctx && ctx.cross >= 0) return { draw: 'context', ctx, items: [] };
        return { draw: 'sequence', items: capList(own, 6, 2) };
      case 'repeat': {
        const count = Number.isFinite(f?.steps) && f.steps >= own.length ? f.steps : own.length;
        return { draw: 'repeat', count, items: capList(own.map((x, i) => ({ ...x, n: i + 1 })), 8, 3) };
      }
      case 'hand-off':
        return { draw: 'hand-off', items: around([...own, ...named('helper'), ...named('parent')], !!S.parent && has(S.parent)) };
      case 'turn-end': {
        const before = named('message').length ? named('message') : named('prompt');
        return { draw: 'turn-end', items: around([...before, ...own, ...named('next')], !!S.next && has(S.next)) };
      }
      default:
        return { draw: 'sequence', items: [...named('prompt'), ...capList(own, 6, 2)] };
    }
  }

  const LEVEL_SET = new Set(['recorded', 'derived', 'inferred', 'missing']);
  const levelOr = (l, fallback) => (LEVEL_SET.has(l) ? l : fallback);

  /** The key facts on the "What happened" card: at most three { text, level, title }, each taken
   *  mechanically from the finding and the records, never a reading: the context per call (the
   *  largest context, the compactions, the check's estimate), a repeat's count, a gap's length, a
   *  failed run's counts, then the parts the finding says it rests on (`basis`), then how many
   *  steps it marks. `byId(id)` answers a step, `compactions` the count for a stretch's agent,
   *  `span(ms)` writes a length of time. */
  function focusFacts(f, S, { byId = () => null, ctx = null, compactions = null, span = (ms) => `${Math.round(ms / 1000)} s` } = {}) {
    if (!S) return [];
    const out = [];
    const put = (text, level, title = '') => text && out.push({ text, level, title });
    const steps = S.steps.map(byId).filter(isEvent);
    if (S.kind === 'stretch' && f?.check === 'long-sessions' && ctx) {
      put(`Largest context ${tokensText(ctx.max)}`, 'derived', 'The most context any of its model calls read: input, cache-read and cache-write tokens.');
      if (Number.isInteger(compactions)) put(compactions ? `${words(compactions, 'compaction')} recorded` : 'No compaction recorded', 'derived', "Counted from this agent's records.");
      if (Number.isFinite(f.estimate) && f.estimate > 0) put(`About ${tokensText(f.estimate)} tokens a fresh start wouldn't re-read`, 'inferred', "The check's estimate: a hand-off to a fresh session at the threshold.");
    }
    // A repeat's count is in its caption and its drawing; its span isn't.
    if (S.kind === 'repeat' && steps.length > 1) put(`Over ${span(steps.at(-1).t - steps[0].t)}`, 'derived', 'From the first to the last, by their recorded times.');
    if (S.gap) put(S.kind === 'hand-off' ? `${span(S.gap.to - S.gap.from)} with no hand-back` : `${span(S.gap.to - S.gap.from)} until your next prompt`, 'derived', 'Worked out from recorded times.');
    if (S.kind === 'hand-off' && !S.parent) put('Nothing after it in the session', 'derived', 'No record of the parent agent after the helper.');
    const run = steps.find((e) => e.tests && Number.isFinite(e.tests.fail) && e.tests.fail > 0);
    if (run) put(`${run.tests.fail} failed, ${run.tests.pass ?? 0} passed`, levelOr(run.tests.evidence, 'derived'), "The run's recorded result, as the engine counted it.");
    const patched = steps.filter((e) => e.patch && (Number.isFinite(e.patch.added) || Number.isFinite(e.patch.removed)));
    if (patched.length) put(`+${patched.reduce((n, e) => n + (e.patch.added ?? 0), 0)} −${patched.reduce((n, e) => n + (e.patch.removed ?? 0), 0)} lines`, 'derived', "The edits' recorded patches, as the engine counted them.");
    for (const b of Array.isArray(f?.basis) ? f.basis : []) if (b && typeof b.part === 'string') put(b.part, levelOr(b.level, 'inferred'), typeof b.how === 'string' ? b.how : '');
    if (out.length < 2 && steps.length) put(`${words(steps.length, 'step')} marked`, 'recorded', 'The steps the check recorded, each in the log.');
    return out.slice(0, 3);
  }

  /** The cause box: the scope's key step (its anchor) with a fixed label by kind, and for the
   *  long-session check the call where the context crossed. { label, id, t, call } or null. */
  function focusCause(f, S, { byId = () => null, ctx = null } = {}) {
    if (!S) return null;
    const e = byId(S.anchor);
    if (!isEvent(e)) return null;
    if (S.kind === 'stretch' && f?.check === 'long-sessions' && ctx && ctx.cross >= 0) return { label: 'Where it crossed', id: e.id, t: ctx.calls[ctx.cross].t, call: ctx.cross + 1 };
    const label = { stretch: 'Where it started', repeat: 'The first one', 'hand-off': 'The helper started', 'turn-end': 'Where the turn ended' }[S.kind] ?? 'The key step';
    return { label, id: e.id, t: e.t, call: null };
  }

  /** Everything the focus draws from a finding and its scope, in one answer: { S, lanes, draw,
   *  facts, cause }. `ids` are the finding's steps this replay holds, for a check with no kind. */
  function focusPlan(f, S0, { ids = [], byId = () => null, laneOf, spawned, context = null, compactionsOf = () => null, span } = {}) {
    const S = focusScope(S0, ids, (id) => byId(id)?.t);
    if (!S) return null;
    const ctx = S.kind === 'stretch' && S.stretch?.agent ? contextPlan(context, S.stretch.agent) : null;
    const has = (id) => isEvent(byId(id));
    return {
      S,
      lanes: focusLanes(S, { laneOf, spawned }),
      draw: focusDraw(f, S, { ctx, has, tOf: (id) => byId(id)?.t ?? 0 }),
      facts: focusFacts(f, S, { byId, ctx, compactions: S.stretch?.agent ? compactionsOf(S.stretch.agent) : null, span }),
      cause: focusCause(f, S, { byId, ctx }),
    };
  }

  /** "See in the whole session": the replay's address for one step (the record-open form,
   *  ?session=<key>#<thread>~<step>), from ids alone; null when one isn't an id. */
  function wholeHref(e, thread) {
    if (!SESSION_ID.test(e?.session ?? '') || !THREAD_ID.test(thread ?? '') || !STEP_ID.test(e?.id ?? '')) return null;
    return `replay.html?session=${encodeURIComponent(e.session)}#${thread}~${e.id}`;
  }

  // ---- the story --------------------------------------------------------------------------------
  /** A step's kind for grouping: the tool's category for a tool call ("test" when it recorded a
   *  test summary), else the record's kind. Mechanical: read from the record, never guessed. */
  function storyKind(e) {
    if (!e) return null;
    if (e.kind === 'action') {
      if (e.tests && typeof e.tests === 'object') return 'test';
      const cat = e.cat ?? e.facts?.category ?? null;
      if (cat) return `cat:${cat}`;
      return `tool:${e.tool ?? e.facts?.tool ?? 'unknown'}`;
    }
    return `kind:${e.kind}`;
  }

  /** Runs of `min` or more consecutive steps of the same kind by the same agent, with no finding
   *  on any of them, become one group; every other step stands alone. Each row is
   *  { step } or { group: key, kind, agent, steps }, the key being the run's first step id. */
  function groupRuns(steps, { kindOf = storyKind, agentOf = (e) => e.agent ?? null, flagged = () => false, min = 3 } = {}) {
    const rows = [];
    let run = [];
    const flush = () => {
      if (run.length >= min) rows.push({ group: run[0].id, kind: kindOf(run[0]), agent: agentOf(run[0]), steps: run });
      else for (const e of run) rows.push({ step: e });
      run = [];
    };
    for (const e of steps) {
      const kind = kindOf(e);
      if (flagged(e) || kind == null) {
        flush();
        rows.push({ step: e });
        continue;
      }
      if (run.length && (kindOf(run[0]) !== kind || agentOf(run[0]) !== agentOf(e))) flush();
      run.push(e);
    }
    flush();
    return rows;
  }

  /** The story: one card per prompt (a lead card for what came before the first prompt), each
   *  holding the steps after its prompt until the next, in rows (groupRuns). A gap between
   *  two steps splits the rows there and is kept as { gap: [a, b] }, between cards when it falls
   *  before a prompt. Answers { cards: [{ prompt, steps, rows }], order: [card or { gap }] }. */
  function buildStory(steps, { gaps = [], kindOf = storyKind, agentOf, flagged, min = 3, isPrompt = (e) => e.kind === 'prompt' } = {}) {
    const gapBetween = (a, b) => gaps.find(([s, e]) => s >= a.t && e <= b.t) ?? null;
    const cards = [];
    const order = [];
    let card = null;
    let chunk = [];
    let prev = null;
    const close = () => {
      if (!card) return;
      if (chunk.length) card.rows.push(...groupRuns(chunk, { kindOf, agentOf, flagged, min }));
      chunk = [];
    };
    for (const e of steps) {
      const gap = prev ? gapBetween(prev, e) : null;
      if (isPrompt(e)) {
        close();
        if (gap) order.push({ gap });
        card = { prompt: e, steps: [], rows: [] };
        cards.push(card);
        order.push(card);
      } else {
        if (!card) {
          card = { prompt: null, steps: [], rows: [] };
          cards.push(card);
          order.push(card);
        } else if (gap) {
          if (chunk.length) card.rows.push(...groupRuns(chunk, { kindOf, agentOf, flagged, min }));
          chunk = [];
          card.rows.push({ gap });
        }
        card.steps.push(e);
        chunk.push(e);
      }
      prev = e;
    }
    close();
    return { cards, order };
  }

  /** Where step `id` sits in the story: its card's index, and the group holding it (null for a
   *  step that stands alone, or a card's prompt). */
  function locate(story, id) {
    for (let c = 0; c < story.cards.length; c++) {
      const card = story.cards[c];
      if (card.prompt?.id === id) return { card: c, group: null, prompt: true };
      for (const r of card.rows) {
        if (r.step?.id === id) return { card: c, group: null, prompt: false };
        if (r.group && r.steps.some((s) => s.id === id)) return { card: c, group: r.group, prompt: false };
      }
    }
    return null;
  }

  /** The step at moment `t`: the last one at or before it, else the first. `steps` in time order. */
  function stepAt(steps, t) {
    if (!steps.length) return null;
    let lo = 0;
    let hi = steps.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return steps[Math.max(0, ans)];
  }

  /** Selecting a step, from either side. From a row (`id`): the playhead goes to its moment and
   *  its group opens. From the timeline (a moment `t`): the step there, its row and its group.
   *  Answers { id, t, card, group } or null. */
  function selectStep(story, steps, { id = null, t = null } = {}) {
    const e = id != null ? steps.find((s) => s.id === id) : Number.isFinite(t) ? stepAt(steps, t) : null;
    if (!e) return null;
    const at = locate(story, e.id);
    return { id: e.id, t: e.t, card: at ? at.card : null, group: at ? at.group : null };
  }

  root.HWReplayModel = {
    MIN_IDLE_MS, IDLE_SHARE, RANK, HOUSEKEEPING, LONG_WAIT_MS,
    isStep, starts, spanOf, isLongWait, spanText, minText, cutWords, shortWhat,
    idleLimit, idleGaps, breakLabel, makeScale, axisTicks,
    findingItems, problemDots, tierCounts, flagsByEvent, ringTier, problemStep, zoomHref,
    SCOPE_KINDS, SCOPE_ROLES, readScope, scopeFrame, scopeMarks, scopeRole, repeatNumbers,
    tokensText, contextPlan, focusScope, focusLanes, splitLanes, focusSteps, focusDraw, focusFacts, focusCause, focusPlan, wholeHref,
    storyKind, groupRuns, buildStory, locate, stepAt, selectStep,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
