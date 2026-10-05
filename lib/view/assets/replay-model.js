// The replay page's pure logic, with no page in it: the time axis with each long stretch with no
// new step squeezed into a narrow break labelled by what filled it, the steps the agent waited
// on, the findings worth a look as the Problems row's dots and each step's chips, the story's
// cards and its groups of repeated steps, and where a step sits in them (the two-way link between
// the timeline and the story). replay.js draws what these answer; the node tests import this
// file the way prefs.js is imported (test/view-replay-model.test.mjs).
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
   *    record when none is recorded, comes after at least half of it): "helper working, N min";
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
      if (Number.isFinite(s) && Number.isFinite(end) && s <= a && end - a >= half) return out('helper', [[`helper working, ${minText(len)}`, false]], { agent: g });
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
  const byTier = (a, b) => (a.look === b.look ? 0 : a.look ? -1 : 1) || RANK[a.tier] - RANK[b.tier] || a.t - b.t || a.k - b.k;

  /** The Problems row: one dot per finding worth a look (and, when asked, per routine note), at
   *  its step's time, never one in a pattern marked not a problem. */
  function problemDots(items, { routine = false } = {}) {
    return items.filter((i) => !i.dismissed && (i.look || routine)).sort((a, b) => a.t - b.t || RANK[a.tier] - RANK[b.tier] || a.k - b.k);
  }

  /** How many findings worth a look of each tier, routine notes and dismissed ones. */
  function tierCounts(items) {
    const c = { high: 0, medium: 0, low: 0, look: 0, routine: 0, dismissed: 0 };
    for (const i of items) {
      if (i.dismissed) c.dismissed++;
      else if (!i.look) c.routine++;
      else {
        c[i.tier]++;
        c.look++;
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
    storyKind, groupRuns, buildStory, locate, stepAt, selectStep,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
