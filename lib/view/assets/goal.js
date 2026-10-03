// The goal page: one goal's sessions in this window on a shared clock, each foldable into its
// agent lanes, with why each session belongs and how that is known. Data: the goal list from
// /api/home, then one goal from /api/goal?key=<goal key>. The address holds the goal key and
// the sessions opened in it (#<goal key>~<session>~<session>), never a goal's id or title.
(function () {
  'use strict';
  const { esc, plural, chip, chips, time, toT, num, dur, isId } = HW;
  const $ = (id) => document.getElementById(id);
  const svg = $('chart');
  const goalSel = $('goal');

  const GAP_MS = 30 * 60e3;
  const BREAK_W = 54;
  const TOP = 34;
  const H_SESSION = 46;
  const H_LANE = 28;
  const H_SUB = 22;
  let LEFT = 240;

  let HOME = null;
  let D = null; // the open goal's answer
  let goal = null; // the open goal: { key, title, state, members, unmatched }
  let sessionByKey = new Map();
  let bySession = new Map();
  let T0;
  let T1;
  let view;
  let playhead;
  let steps = [];
  let prompts = [];
  let breaks = [];
  const openSessions = new Set();
  const openLanes = new Set();
  const openBreaks = new Set();
  let collapse = true;
  let timer = null;
  let loadSeq = 0;

  // ---- membership wording ---------------------------------------------------------------
  const ENTRY = { 'goal.create': 'created the goal', 'observation.record': 'recorded an observation', 'result.record': 'recorded a result', 'decision.record': 'recorded a decision', 'review.record': 'recorded a review', created: 'created the goal', progress: 'recorded progress', observation: 'recorded an observation', 'state-change': "changed the goal's state" };
  const where = (p) => ({ source: 'its source', observations: 'an observation', results: 'a result', decisions: 'a decision' })[String(p ?? '').split(/[.[]/)[0]] ?? 'its record';
  const VIA = { 'pr-link': 'the harness recorded a link to it', 'harness-git-pr': 'the harness recorded git acting on it', 'printed-output': "a command's printed output names it", 'harness-commit': 'the harness recorded it', 'pr-landed': 'git shows it landed' };
  const shortRef = (r) => String(r ?? '').replace(/^https?:\/\/github\.com\/[^/]+\//, '').replace('/pull/', '#');
  function joinText(j) {
    const d = j.detail ?? {};
    const times = j.count > 1 ? ` (×${j.count})` : '';
    if (j.type === 'cited-session') return `Your goal list names this session in ${where(d.where)}.`;
    if (j.type === 'created-goal') return `Created the goal: a call carried the entry's id while the goal list shows it written${times}.`;
    if (j.type === 'wrote-entry') return `Wrote to the goal list: ${ENTRY[d.entryType] ?? d.entryType ?? 'an entry'}. A call carried the entry's id while the goal list shows it written${times}.`;
    if (j.type === 'cited-pr') return `The goal cites ${shortRef(d.ref)} in ${where(d.where)}, and ${VIA[d.via] ?? d.via ?? 'a record points at it'}${times}.`;
    if (j.type === 'cited-commit') return `The goal cites commit ${shortRef(d.ref)} in ${where(d.where)}, and ${VIA[d.via] ?? d.via ?? 'a record points at it'}${times}.`;
    if (j.type === 'command-on-pr') return `A recorded command acted on ${shortRef(d.ref)}, which the goal cites in ${where(d.where)}${times}.`;
    if (j.type === 'prompt-names-goal') return `A prompt names the goal's id${times}.`;
    return String(j.type ?? 'joined');
  }
  const SHORT = { 'cited-session': 'you cited it', 'created-goal': 'created it', 'wrote-entry': 'wrote its record', 'prompt-names-goal': 'prompt names it' };
  const shortWhy = (m) => (m.joins ?? []).map((j) => (j.type === 'cited-pr' || j.type === 'cited-commit' ? `cites ${shortRef(j.detail?.ref)}` : j.type === 'command-on-pr' ? `ran gh on ${shortRef(j.detail?.ref)}` : j.type === 'wrote-entry' ? ENTRY[j.detail?.entryType] ?? SHORT[j.type] : SHORT[j.type] ?? j.type) + (j.count > 1 ? ` ×${j.count}` : '')).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
  const isMine = (m) => m.assigned === true || m.mine === true || (m.joins ?? []).some((j) => j.type === 'cited-session');
  const mineTag = '<span class="tag mine" title="You cited this in your goal list">your assignment</span>';

  // ---- what goes where (the same lanes as the replay, inside each session) --------------
  function lanesOf(key) {
    const ags = (D.agents ?? []).filter((a) => a.session === key);
    const main = ags.find((a) => a.kind === 'main');
    const subs = ags.filter((a) => a.kind !== 'main').sort((a, b) => toT(a.spawnAt ?? a.firstAt) - toT(b.spawnAt ?? b.firstAt));
    return [{ key: 'person', label: 'You' }, ...(main ? [{ key: main.key, label: 'Main agent' }] : []), ...subs.map((a) => ({ key: a.key, label: `↳ ${HW.agentLabel(a.key)}`, agent: a })), { key: 'harness', label: 'Harness' }, { key: 'git', label: 'Git' }];
  }

  // ---- the address: #<goal key>~<session>~<session> -------------------------------------
  const readHash = () => {
    const parts = location.hash.slice(1).split('~');
    return { key: isId('goal', parts[0]) ? parts[0] : null, open: parts.slice(1).filter((p) => isId('session', p)) };
  };
  const hashFor = () => `#${goal.key}${[...openSessions].map((k) => `~${k}`).join('')}`;
  function syncUrl() {
    if (!goal || !isId('goal', goal.key)) return;
    const want = hashFor();
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  // ---- loading a goal --------------------------------------------------------------------
  async function pickGoal(key, { open = null, push = false } = {}) {
    const mine = ++loadSeq;
    if (push && key !== goal?.key && isId('goal', key)) history.pushState(null, '', `#${key}`);
    goalSel.value = key;
    $('goalMeta').textContent = 'Loading…';
    const a = await HW.load('goal', { key });
    if (mine !== loadSeq) return;
    D = a;
    const g = a.goal && typeof a.goal === 'object' ? a.goal : a;
    goal = { ...g, key: g.key ?? key, members: Array.isArray(g.members) ? g.members : [], unmatched: Array.isArray(g.unmatched) ? g.unmatched : [] };
    if (!goal.members.length && !goal.unmatched.length && a.goal === null) throw Object.assign(new Error('The server has no goal with this key in this window.'), { code: 'http' });
    const sessions = (Array.isArray(a.sessions) ? a.sessions : []).map((s) => ({ ...s }));
    for (const m of goal.members) if (!sessions.some((s) => s.key === m.session)) sessions.push({ key: m.session, title: m.title ?? null, tool: m.tool ?? null, thread: m.thread ?? null, firstAt: m.firstAt ?? null, lastAt: m.lastAt ?? null });
    for (const s of sessions) {
      const m = goal.members.find((x) => x.session === s.key);
      if (m) for (const k of ['title', 'tool', 'thread', 'firstAt', 'lastAt']) if (s[k] == null && m[k] != null) s[k] = m[k];
    }
    sessionByKey = new Map(sessions.map((s) => [s.key, s]));
    const events = (Array.isArray(a.events) ? a.events : []).map(HW.normEvent).filter((e) => Number.isFinite(e.t));
    HW.useData({ events, agents: a.agents ?? [], rules: a.rules ?? {}, sessions });
    HW.data.mainLabels = new Map();
    const placed = events.map((e) => ({ e, lane: HW.laneOf(e) })).filter((p) => p.lane).map((p) => ({ ...p, sub: HW.subOf(p.e, p.lane) })).sort((x, y) => x.e.t - y.e.t);
    bySession = new Map();
    for (const p of placed) (bySession.get(p.e.session) ?? bySession.set(p.e.session, []).get(p.e.session)).push(p);
    const spans = goal.members.map((m) => sessionByKey.get(m.session)).filter(Boolean).flatMap((s) => [toT(s.firstAt), toT(s.lastAt)]).filter(Number.isFinite);
    const evTimes = events.filter((e) => e.kind !== 'quiet').flatMap((e) => (e.endT ? [e.t, e.endT] : [e.t]));
    const all = [...spans, ...evTimes];
    T0 = all.length ? Math.min(...all) : Date.now();
    T1 = all.length ? Math.max(...all) : T0 + 60e3;
    if (T1 <= T0) T1 = T0 + 60e3;
    const keys = new Set(goal.members.map((m) => m.session));
    const evs = events.filter((e) => keys.has(e.session));
    steps = evs.filter((e) => !['link', 'mode', 'queue', 'hook', 'quiet'].includes(e.kind)).sort((x, y) => x.t - y.t);
    prompts = steps.filter((e) => e.kind === 'prompt');
    // Stretches with a record from any member session; the rest are gaps (derived).
    const times = evs.filter((e) => e.kind !== 'quiet').flatMap((e) => (e.endT ? [e.t, e.endT] : [e.t])).concat(spans).sort((x, y) => x - y);
    const segs = [];
    for (const t of times) {
      const last = segs[segs.length - 1];
      if (last && t - last[1] < GAP_MS) last[1] = Math.max(last[1], t);
      else segs.push([t, t]);
    }
    breaks = segs.slice(1).map((s, i) => ({ id: `${segs[i][1]}`, a: segs[i][1], b: s[0] }));
    openSessions.clear();
    openLanes.clear();
    openBreaks.clear();
    if (open) for (const k of open) if (keys.has(k)) openSessions.add(k);
    if (!open && goal.members.length === 1) openSessions.add(goal.members[0].session);
    playhead = T0;
    const recorded = goal.members.filter((m) => m.evidence !== 'inferred' && !m.ambiguous).length;
    const ambiguous = goal.members.filter((m) => m.ambiguous).length;
    $('goalMeta').innerHTML = goal.members.length
      ? `${plural(goal.members.length, 'session')} in this window: ${recorded} joined by a record, ${goal.members.length - recorded - ambiguous} by a rule only${ambiguous ? `, ${ambiguous} ambiguous` : ''} ${chip(HW.memberLevel(goal.members))} · ${esc(time(T0, { day: true }))} to ${esc(time(T1, { day: true }))} ${chip('recorded')}`
      : `${HW.nothingIn('joins this goal')}`;
    setView(T0, T1);
  }

  // ---- the clock: linear inside a stretch of records, a fixed band for each gap ------------
  function scale(W) {
    const [v0, v1] = view;
    const inner = W - LEFT - 10;
    const linear = { parts: [], x: (t) => LEFT + ((t - v0) / (v1 - v0)) * inner, toT: (px) => v0 + ((px - LEFT) / inner) * (v1 - v0), pxPerMs: inner / (v1 - v0) };
    if (!collapse) return linear;
    const folded = breaks.filter((b) => !openBreaks.has(b.id) && b.a < v1 && b.b > v0);
    if (!folded.length) return linear;
    const parts = [];
    let cur = v0;
    for (const b of folded) {
      if (b.a > cur) parts.push({ kind: 'seg', a: cur, b: Math.min(b.a, v1) });
      parts.push({ kind: 'brk', a: Math.max(b.a, v0), b: Math.min(b.b, v1), brk: b });
      cur = Math.min(b.b, v1);
    }
    if (cur < v1) parts.push({ kind: 'seg', a: cur, b: v1 });
    const active = parts.filter((p) => p.kind === 'seg').reduce((n, p) => n + (p.b - p.a), 0);
    if (active <= 0) return linear;
    const bw = Math.min(BREAK_W, Math.floor((inner * 0.3) / folded.length));
    const pxPerMs = (inner - folded.length * bw) / active;
    let x = LEFT;
    for (const p of parts) {
      p.x0 = x;
      x += p.kind === 'seg' ? (p.b - p.a) * pxPerMs : bw;
      p.x1 = x;
    }
    const xOf = (t) => {
      if (t <= parts[0].a) return LEFT - (parts[0].a - t) * pxPerMs;
      for (const p of parts) if (t <= p.b) return p.kind === 'seg' ? p.x0 + (t - p.a) * pxPerMs : p.x0 + (bw * (t - p.a)) / Math.max(1, p.b - p.a);
      const l = parts[parts.length - 1];
      return l.x1 + (t - l.b) * pxPerMs;
    };
    const toT2 = (px) => {
      for (const p of parts) if (px <= p.x1) return p.kind === 'seg' ? p.a + (px - p.x0) / pxPerMs : p.a + ((px - p.x0) / bw) * (p.b - p.a);
      return v1;
    };
    return { parts, x: xOf, toT: toT2, pxPerMs };
  }

  // ---- rows ---------------------------------------------------------------------------------
  function rows() {
    const out = [];
    goal.members.forEach((m, i) => {
      const mine = bySession.get(m.session) ?? [];
      const isOpen = openSessions.has(m.session);
      out.push({ type: 'session', key: m.session, m, i, items: isOpen ? [] : mine, count: mine.length, h: H_SESSION });
      if (!isOpen) return;
      for (const L of lanesOf(m.session)) {
        const lm = mine.filter((p) => p.lane === L.key);
        if (!lm.length && !L.agent) continue;
        const lk = `${m.session}|${L.key}`;
        const lo = openLanes.has(lk);
        out.push({ type: 'lane', key: lk, L, session: m.session, items: lo ? [] : lm, count: lm.length, h: H_LANE });
        if (!lo) continue;
        const groups = new Map();
        for (const p of lm) (groups.get(p.sub) ?? groups.set(p.sub, []).get(p.sub)).push(p);
        for (const [sub, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) out.push({ type: 'sub', key: `${lk}|${sub}`, label: sub, items, count: items.length, h: H_SUB });
      }
    });
    return out;
  }

  function render() {
    const keep = HW.focusedMark(svg);
    const W = svg.clientWidth || 1000;
    LEFT = Math.round(Math.min(240, Math.max(120, W * 0.24)));
    const R = rows();
    const H = TOP + R.reduce((n, r) => n + r.h, 0) + 8;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    const sc = scale(W);
    const x = sc.x;
    const [v0, v1] = view;
    const drawn = [];
    let s = '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" stroke-width="2"/></pattern></defs>';
    // Axis: ticks inside each stretch of records; a labelled band for each folded gap.
    const stepMs = HW.niceStep(1 / sc.pxPerMs);
    const stretches = sc.parts.length ? sc.parts.filter((p) => p.kind === 'seg') : [{ a: v0, b: v1 }];
    let lastDay = null;
    let freeX = -Infinity;
    const bands = sc.parts.filter((q) => q.kind === 'brk');
    for (const p of stretches) {
      for (let t = Math.ceil(p.a / stepMs) * stepMs; t <= p.b; t += stepMs) {
        const day = HW.dayOf(t);
        const label = time(t, { day: day !== lastDay, seconds: stepMs < 60e3 });
        const x0 = x(t) + 3;
        const x1 = x0 + label.length * 5.8;
        s += `<line x1="${x(t)}" x2="${x(t)}" y1="14" y2="${H - 6}" stroke="var(--grid)"/>`;
        if (x0 < freeX || x1 > W - 10 || bands.some((b) => b.x0 < x1 && b.x1 > x0)) continue;
        s += `<text class="tick" x="${x0}" y="11">${esc(label)}</text>`;
        freeX = x1 + 10;
        lastDay = day;
      }
    }
    for (const p of bands) {
      const span = p.brk.b - p.brk.a;
      const bw = p.x1 - p.x0;
      // A narrow band (a phone, or many gaps) keeps its duration in the hover text only.
      const words = bw >= 30 ? `<rect x="${p.x0 + 4}" y="1" width="${bw - 8}" height="13" rx="3" fill="var(--page)"/><text class="tick" x="${(p.x0 + p.x1) / 2}" y="11" text-anchor="middle">${esc(dur(span))}</text><text class="tick" transform="translate(${(p.x0 + p.x1) / 2 + 4},${TOP + 60}) rotate(-90)" text-anchor="end">no records</text>` : '';
      s += `<g class="brk" data-brk="${p.brk.id}"><rect x="${p.x0 + 3}" y="14" width="${Math.max(1, bw - 6)}" height="${H - 20}" rx="${bw >= 14 ? 4 : 1}" fill="var(--grid)" opacity="0.6"/>${bw >= 14 ? `<path d="M${p.x0 + 3},14 l4,6 l-4,6 l4,6 l-4,6" stroke="var(--axis)" fill="none"/><path d="M${p.x1 - 3},14 l-4,6 l4,6 l-4,6 l4,6" stroke="var(--axis)" fill="none"/>` : ''}${words}<title>None of these sessions wrote a record for ${dur(span)}, ${time(p.brk.a, { day: true })} to ${time(p.brk.b, { day: true })} (derived). Not idle, just unrecorded. Click to unfold.</title></g>`;
    }
    let y = TOP;
    for (const r of R) {
      const mid = r.type === 'session' ? y + 30 : y + r.h / 2;
      s += `<line x1="0" x2="${W - 10}" y1="${y + r.h - 0.5}" y2="${y + r.h - 0.5}" stroke="${r.type === 'session' ? 'var(--axis)' : 'var(--grid)'}"/>`;
      if (r.type === 'session') {
        const se = sessionByKey.get(r.key) ?? {};
        const isOpen = openSessions.has(r.key);
        const title = `${isOpen ? '▾' : '▸'} S${r.i + 1} · ${se.title ?? 'Untitled session'}`;
        const why = `${r.m.evidence}${r.m.ambiguous ? ', ambiguous' : ''}${isMine(r.m) ? ', your assignment' : ''} · ${shortWhy(r.m)}`;
        s += `<text class="row-label head" data-session="${esc(r.key)}" tabindex="0" role="button" aria-expanded="${isOpen}" x="8" y="${y + 17}">${HW.fitText(title, LEFT - 40)}<title>${esc(title)}</title></text>`;
        s += `<text class="row-why" data-session="${esc(r.key)}" x="22" y="${y + 33}">${HW.fitText(why, (LEFT - 30) * 1.15)}<title>${esc((r.m.joins ?? []).map(joinText).join('\n'))}</title></text>`;
        s += `<text class="row-count" x="${LEFT - 8}" y="${y + 17}" text-anchor="end">${r.count}</text>`;
        // The session's recorded span, outlined by how it joins the goal.
        const a = toT(se.firstAt);
        const b = toT(se.lastAt);
        if (Number.isFinite(a) && Number.isFinite(b) && b >= v0 && a <= v1) {
          const weak = r.m.evidence === 'inferred' || r.m.ambiguous;
          s += `<rect x="${x(Math.max(a, v0))}" y="${y + 21}" width="${Math.max(2, x(Math.min(b, v1)) - x(Math.max(a, v0)))}" height="18" rx="5" fill="var(--wash)" stroke="var(--ink-2)" stroke-width="${weak ? 1.2 : 1.6}"${weak ? ' stroke-dasharray="5 4"' : ''}><title>${esc(se.title ?? '')}: first record ${time(a, { day: true })}, last record ${time(b, { day: true })} (recorded)</title></rect>`;
        }
        // Flags at the records that tie the session to the goal.
        for (const j of r.m.joins ?? []) {
          const ev = j.event && HW.data.byId.get(j.event);
          if (!ev || ev.t < v0 || ev.t > v1) continue;
          const fx = x(ev.t);
          const weak = j.evidence === 'inferred' || j.ambiguous;
          const dash = weak ? ' stroke-dasharray="2 2"' : '';
          const label = `Why the session belongs: ${joinText(j)} ${j.evidence}${j.ambiguous ? ', ambiguous' : ''}${j.rule ? `, rule ${j.rule}` : ''}.`;
          drawn.push({ id: ev.id, text: `${time(ev.t, { day: true, seconds: true })}. ${label}` });
          s += `<g class="mark" data-id="${esc(ev.id)}" tabindex="0" role="button" aria-label="${esc(label)}"><line x1="${fx}" x2="${fx}" y1="${y + 4}" y2="${y + 22}" stroke="var(--ink)" stroke-width="1.2"${dash}/><path d="M${fx},${y + 4} h9 l-3,3.5 l3,3.5 h-9z" fill="${weak ? 'var(--surface)' : 'var(--ink)'}" stroke="var(--ink)" stroke-width="1"${dash}/><title>${esc(joinText(j))} (${j.evidence}${j.ambiguous ? ', ambiguous' : ''}${j.rule ? `, rule ${j.rule}` : ''}). Enter or click for the record.</title></g>`;
        }
      } else if (r.type === 'lane') {
        const open = openLanes.has(r.key);
        const ins = r.L.agent && [...HW.data.byId.values()].find((e) => e.kind === 'delegation-received' && e.agent === r.L.key);
        const lab = `${open ? '▾' : '▸'} ${r.L.label}`;
        const hover = r.L.agent ? `${r.L.label}\n\n${ins ? `Started with: ${ins.facts?.text ?? ins.text}` : "Its starting instruction isn't in the logs read."}` : r.L.label;
        s += `<text class="row-label lane" data-lane="${esc(r.key)}" tabindex="0" role="button" aria-expanded="${open}" x="22" y="${mid + 4}">${HW.fitText(lab, LEFT - 52)}<title>${esc(hover)}</title></text><text class="row-count" x="${LEFT - 8}" y="${mid + 4}" text-anchor="end">${r.count}</text>`;
        if (r.L.agent) {
          const a = toT(r.L.agent.spawnAt ?? r.L.agent.firstAt);
          const b = toT(r.L.agent.completion?.at ?? r.L.agent.lastAt);
          if (b >= v0 && a <= v1) s += `<rect x="${x(Math.max(a, v0))}" y="${y + 5}" width="${Math.max(2, x(Math.min(b, v1)) - x(Math.max(a, v0)))}" height="${r.h - 10}" rx="4" fill="var(--wash)" stroke="var(--ring)"/>`;
        }
      } else {
        s += `<text class="row-label" x="40" y="${mid + 4}">${HW.fitText(r.label, LEFT - 70)}<title>${esc(r.label)}</title></text><text class="row-count" x="${LEFT - 8}" y="${mid + 4}" text-anchor="end">${r.count}</text>`;
      }
      const inView = r.items.filter((p) => (p.e.endT ?? p.e.t) >= v0 && p.e.t <= v1);
      for (const p of [...inView].sort((a, b) => (a.e.kind === 'delegation-received') - (b.e.kind === 'delegation-received'))) {
        const pieces = HW.describeStepPieces(p.e);
        const label = pieces.map(([t]) => t).join('');
        drawn.push({ id: p.e.id, text: label, pieces });
        s += HW.markSvg(p.e, { x, mid, small: r.type !== 'session', playhead, big: 6, sm: 5, label });
      }
      if (r.type !== 'session') {
        let free = -Infinity;
        // Housekeeping records never take a label, so your prompts and the agents' steps get the room.
        const labelable = inView.filter((p) => !['queue', 'mode', 'hook', 'turn-end', 'quiet'].includes(p.e.kind));
        labelable.forEach((p, i) => {
          const startX = x(p.e.endT && p.e.kind === 'action' ? p.e.endT : p.e.t) + 6;
          const next = labelable[i + 1] ? x(labelable[i + 1].e.t) : W - 10;
          const room = next - startX - 6;
          if (startX < free || room < 60) return;
          const text = String(HW.summary(p.e) ?? '');
          const chars = Math.floor(room / 6);
          s += `<text class="marklabel" x="${startX}" y="${mid + 3.5}" aria-hidden="true">${esc(text.length > chars ? `${text.slice(0, chars - 1)}…` : text)}</text>`;
          free = startX + Math.min(room, text.length * 6);
        });
      }
      y += r.h;
    }
    if (playhead >= v0 && playhead <= v1) s += `<line class="playhead" x1="${x(playhead)}" x2="${x(playhead)}" y1="14" y2="${H}" stroke="var(--run)" stroke-width="2"/><circle cx="${x(playhead)}" cy="14" r="4" fill="var(--run)"/>`;
    svg.innerHTML = s;
    svg.__toT = sc.toT;
    HW.stepList($('chartSteps'), drawn);
    HW.refocus(svg, keep);
    syncUrl();
    panel();
  }

  // The engine's state for one session at a moment: its last frame at or before it.
  function frameFor(key, t) {
    const fr = (D.frames && !Array.isArray(D.frames) ? D.frames[key] : null) ?? [];
    let ans = null;
    for (const f of fr) {
      const ft = Number.isFinite(f.t) ? f.t : toT(f.at);
      if (ft <= t) ans = f;
    }
    return HW.frameOf(ans);
  }

  function panel() {
    $('readout').textContent = time(playhead, { day: true, seconds: true });
    const slider = $('slider');
    slider.value = Math.round(((playhead - T0) / Math.max(1, T1 - T0)) * 1000);
    slider.setAttribute('aria-valuetext', time(playhead, { day: true, seconds: true }));
    const stat = (k, [v, l], text = v) => `<span>${k} ${chip(l)}</span><span class="v">${esc(text)}</span>`;
    const members = goal.members.map((m, i) => {
      const se = sessionByKey.get(m.session) ?? {};
      const a = toT(se.firstAt);
      const b = toT(se.lastAt);
      const f = frameFor(m.session, playhead);
      const whereNow = Number.isFinite(a) && playhead < a ? `starts ${esc(time(a, { day: true }))}` : Number.isFinite(b) && playhead > b ? `last record ${esc(time(b, { day: true }))}` : 'has records around now';
      // The last thing you asked in this session, up to the playhead.
      const asked = [...(bySession.get(m.session) ?? [])].reverse().find((p) => p.e.kind === 'prompt' && p.e.t <= playhead)?.e;
      return `<div class="member ${m.evidence === 'inferred' || m.ambiguous ? 'inferred' : ''}" data-member="${esc(m.session)}">
        <div><button type="button" class="linklike t" data-open="${esc(m.session)}" aria-expanded="${openSessions.has(m.session)}">S${i + 1} · ${esc(se.title ?? 'Untitled session')}</button> ${chips(m.evidence, m.ambiguous === true)}${isMine(m) ? ` ${mineTag}` : ''}</div>
        <div class="kbd">${se.tool === 'codex' ? 'Codex' : 'Claude Code'} · ${whereNow}${isId('session', m.session) ? ` · <a href="replay.html?session=${encodeURIComponent(m.session)}${isId('thread', se.thread) ? `#${se.thread}` : ''}">replay</a>` : ''}</div>
        ${asked ? `<div class="kbd gap">The last thing you asked, ${esc(time(asked.t, { day: true }))}:</div><div class="quote"><a href="#" class="plain" data-id="${esc(asked.id)}">${esc(HW.clip(HW.stripKind(asked.text), 220))}</a></div>` : ''}
        <ul>${(m.joins ?? []).map((j) => `<li>${esc(joinText(j))} ${chips(j.evidence, !!j.ambiguous)}${j.type === 'cited-session' ? ` ${mineTag}` : ''}${j.event && HW.data.byId.has(j.event) ? ` <a href="#" data-id="${esc(j.event)}">record</a>` : ''}${j.rule ? `<details class="kbd"><summary>Rule ${esc(j.rule)}</summary>${esc(j.ruleText ?? HW.ruleText(j.rule, D.rules))}</details>` : ''}</li>`).join('')}</ul>
        ${f ? `<div class="stats">${stat('Prompts so far', f.prompts)}${stat('Tool calls', f.actions)}${stat('Edits', f.edits, `${f.edits[0]} on ${f.filesEdited[0]} files`)}${stat('Test runs', f.testRuns, `${f.testRuns[0]}: ${f.testsPassed[0]} passed, ${f.testsFailed[0]} with failures`)}${stat('Pull requests landed', f.prsLanded)}</div>` : ''}
      </div>`;
    }).join('');
    const um = goal.unmatched;
    const cov = D.coverage ?? HOME?.coverage ?? {};
    const read = num(cov.sessionsRead ?? cov.sessions);
    const priv = num(cov.privateSessions ?? cov.excludedTotal) ?? ((Number(num(cov.excluded?.display ?? cov.display)) || 0) + (Number(num(cov.excluded?.outside ?? cov.outside)) || 0));
    $('panel').innerHTML = `
      <h2>Why these ${plural(goal.members.length, 'session')}</h2>
      ${members || `<p class="note tight">${HW.nothingIn('joins this goal')}</p>`}
      <p class="note">Sessions join a goal only through evidence: your goal list citing them, or a record they wrote to it. A named rule's join is shown dashed and could be wrong. A session can belong to several goals.</p>
      <h2>Cited in your goal list, not backed by these logs (${um.length})</h2>
      <ul class="unmatched">${um.map((u) => `<li data-unmatched="1">${esc(u.ref ?? u.kind ?? 'a citation')}: ${esc(u.why ?? '')} ${chip('missing')} ${mineTag}</li>`).join('') || '<li>none</li>'}</ul>
      <p class="note">${Number.isFinite(read) ? `Read ${plural(read, 'session')} in ${esc(HW.windowText(HW.shell.window))}${Number(priv) > 0 ? `; ${priv} were outside the configured repos or display-only, so they were never searched for goal links` : ''}. ` : ''}Every count here is for this window only.</p>`;
    // Record links are real links, so Tab reaches them and Enter opens the record.
    document.querySelectorAll('#panel [data-id]').forEach((el) => el.addEventListener('click', (ev) => {
      ev.preventDefault();
      HW.openEvent(el.dataset.id);
    }));
    document.querySelectorAll('#panel [data-open]').forEach((el) => el.addEventListener('click', () => toggleSession(el.dataset.open)));
  }
  function toggleSession(k) {
    if (openSessions.has(k)) openSessions.delete(k);
    else openSessions.add(k);
    render();
  }

  function setView(a, b, preset) {
    const min = 20e3;
    if (b - a < min) {
      const m = (a + b) / 2;
      a = m - min / 2;
      b = m + min / 2;
    }
    view = [Math.max(T0 - 60e3, a), Math.min(T1 + 60e3, b)];
    const whole = view[0] <= T0 && view[1] >= T1;
    $('zoom').value = whole ? '0' : preset ?? 'custom';
    $('fit').disabled = whole;
    const bar = $('zoombar');
    bar.hidden = whole;
    if (!whole) bar.innerHTML = `Zoomed in: showing ${esc(time(view[0], { day: true }))} to ${esc(time(view[1], { day: true }))}. <button type="button" data-fit>⤢ Back to the whole goal</button> <span class="kbd">or press Esc, or double-click the chart</span>`;
    bar.querySelector('[data-fit]')?.addEventListener('click', () => setView(T0, T1));
    render();
  }
  function setPlayhead(t, follow = true) {
    playhead = Math.max(T0, Math.min(T1, t));
    if (follow && (playhead < view[0] || playhead > view[1])) {
      const w = view[1] - view[0];
      setView(playhead - w / 2, playhead + w / 2);
      return;
    }
    render();
  }
  // One line for a screen reader: when, which session, who, and what.
  const describe = (e) => {
    const i = goal.members.findIndex((m) => m.session === e.session);
    return [[i >= 0 ? `S${i + 1}. ` : '', false], ...HW.describeStepPieces(e)];
  };
  const stepTo = (dir, list = steps) => {
    const next = dir > 0 ? list.find((e) => e.t > playhead) : [...list].reverse().find((e) => e.t < playhead);
    if (!next) return;
    setPlayhead(next.t);
    HW.announce(describe(next));
  };

  function wire() {
    $('prevStep').addEventListener('click', () => stepTo(-1));
    $('nextStep').addEventListener('click', () => stepTo(1));
    $('prevPrompt').addEventListener('click', () => stepTo(-1, prompts));
    $('nextPrompt').addEventListener('click', () => stepTo(1, prompts));
    $('slider').addEventListener('input', (ev) => setPlayhead(T0 + ((T1 - T0) * Number(ev.target.value)) / 1000));
    $('zoom').addEventListener('change', (ev) => {
      const z = Number(ev.target.value);
      if (!z) return setView(T0, T1);
      setView(playhead - z / 2, playhead + z / 2, String(z));
    });
    $('fit').addEventListener('click', () => setView(T0, T1));
    $('collapse').addEventListener('change', (ev) => {
      collapse = ev.target.checked;
      render();
    });
    $('openAll').addEventListener('click', () => {
      goal.members.forEach((m) => openSessions.add(m.session));
      render();
    });
    $('closeAll').addEventListener('click', () => {
      openSessions.clear();
      openLanes.clear();
      render();
    });
    goalSel.addEventListener('change', () => pickGoal(goalSel.value, { push: true }).catch(HW.fail));
    $('play').addEventListener('click', () => {
      const btn = $('play');
      if (timer) {
        clearInterval(timer);
        timer = null;
        btn.textContent = '▶ Play';
        HW.announce(`Paused at ${time(playhead, { day: true, seconds: true })}.`);
        return;
      }
      btn.textContent = '⏸ Pause';
      timer = setInterval(() => {
        const next = steps.find((e) => e.t > playhead);
        if (!next) return $('play').click();
        setPlayhead(next.t);
      }, 90);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.target.tagName === 'SELECT' || ev.target.tagName === 'INPUT' || HW.ownsSpace(ev) || ev.defaultPrevented) return;
      if (ev.key === 'ArrowRight') stepTo(1, ev.shiftKey ? prompts : steps);
      else if (ev.key === 'ArrowLeft') stepTo(-1, ev.shiftKey ? prompts : steps);
      else if (ev.key === 'Escape' && !document.querySelector('.drawer.open')) setView(T0, T1);
      else if (ev.key === ' ') {
        ev.preventDefault();
        $('play').click();
      }
    });
    // Enter on a step opens its record; Enter on a session or lane name folds or opens it.
    HW.keyboardMarks(svg, (id) => HW.openEvent(id));
    svg.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const ses = ev.target.closest?.('text[data-session]')?.dataset.session;
      const lane = ev.target.closest?.('text[data-lane]')?.dataset.lane;
      if (!ses && !lane) return;
      ev.preventDefault();
      if (ses) toggleSession(ses);
      else {
        if (openLanes.has(lane)) openLanes.delete(lane);
        else openLanes.add(lane);
        render();
      }
      const again = svg.querySelector(ses ? `text.head[data-session="${CSS.escape(ses)}"]` : `text[data-lane="${CSS.escape(lane)}"]`);
      again?.focus();
    });
    const toT2 = (px) => svg.__toT(px);
    let drag = null;
    svg.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.mark, .brk, [data-session], [data-lane]')) return;
      const px = ev.clientX - svg.getBoundingClientRect().left;
      if (px > LEFT) drag = { start: px, now: px };
    });
    window.addEventListener('mousemove', (ev) => {
      if (drag) {
        drag.now = ev.clientX - svg.getBoundingClientRect().left;
        let sel = svg.querySelector('#sel');
        if (!sel) {
          sel = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          sel.id = 'sel';
          sel.setAttribute('y', '14');
          sel.setAttribute('fill', 'var(--wash)');
          sel.setAttribute('stroke', 'var(--run)');
          svg.appendChild(sel);
        }
        sel.setAttribute('x', Math.min(drag.start, drag.now));
        sel.setAttribute('width', Math.abs(drag.now - drag.start));
        sel.setAttribute('height', svg.viewBox.baseVal.height - 14);
        return;
      }
      const target = ev.target.closest?.('#chart .mark');
      if (!target || target.querySelector?.('title')) return HW.hideTip();
      const e = HW.data.byId.get(target.dataset.id);
      if (e) HW.showTip(ev, HW.tipHtml(e, sessionByKey.get(e.session)?.title ?? ''));
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (Math.abs(d.now - d.start) > 8) setView(toT2(Math.min(d.start, d.now)), toT2(Math.max(d.start, d.now)));
      else setPlayhead(toT2(d.start), false);
    });
    svg.addEventListener('mouseleave', HW.hideTip);
    svg.addEventListener('dblclick', () => setView(T0, T1));
    svg.addEventListener('click', (ev) => {
      const brk = ev.target.closest('.brk')?.dataset.brk;
      if (brk) {
        openBreaks.add(brk);
        render();
        return;
      }
      const ses = ev.target.closest('[data-session]')?.dataset.session;
      if (ses) return toggleSession(ses);
      const lane = ev.target.closest('[data-lane]')?.dataset.lane;
      if (lane) {
        if (openLanes.has(lane)) openLanes.delete(lane);
        else openLanes.add(lane);
        render();
        return;
      }
      const id = ev.target.closest('.mark')?.dataset.id;
      if (id) HW.openEvent(id);
    });
    window.addEventListener('resize', () => goal && render());
    window.addEventListener('popstate', () => {
      const { key, open } = readHash();
      if (key && key !== goal?.key) pickGoal(key, { open }).catch(HW.fail);
    });
  }

  // With no goal list: what one is, how to give one, and where to see an example.
  function noGoalList() {
    HW.fatal(`<p><b>No goal list is set</b>, so there are no goals to show for ${esc(HW.windowText(HW.shell.window))}. Search and replay still work.</p>
      <p>A goal list is a JSON file of your goals. Each goal has an id and a title, and can cite the pull requests, commits and sessions behind it in its source, observations, results and decisions. The page then shows which sessions did each goal's work, and how each link is known.</p>
      <pre>{
  "goals": [
    { "id": "ship-parser", "title": "Ship the parser", "state": "active",
      "observations": ["your-project#12 adds the flag"] }
  ],
  "events": []
}</pre>
      <p>Name the file with <code>honestweek view --goals &lt;file&gt;</code>, or once with <code>goalsFile</code> in your config. To see one at work first, run <code>honestweek view --demo</code>: the made-up demo week has a goal list of three goals.</p>`);
    const el = document.querySelector('[data-fatal]');
    if (el) el.dataset.fatal = 'no-goal-list';
  }

  HW.start(async () => {
    HOME = await HW.load('home');
    const goals = Array.isArray(HOME.goals) ? HOME.goals.filter((g) => g && isId('goal', g.key)) : null;
    if (goals == null || HOME.goalList === false || HOME.goalList?.given === false) return noGoalList();
    if (!goals.length) {
      HW.fatal(`Your goal list has no goals. ${HW.nothingIn('to show here')}`);
      return;
    }
    const count = (g) => num(g.sessions ?? (Array.isArray(g.members) ? g.members.length : g.members)) ?? 0;
    goalSel.innerHTML = goals.map((g) => `<option value="${esc(g.key)}">${esc(g.title ?? 'Untitled goal')} · ${plural(count(g), 'session')}</option>`).join('');
    wire();
    const initial = readHash();
    const start = initial.key && goals.some((g) => g.key === initial.key) ? initial.key : [...goals].sort((a, b) => count(b) - count(a))[0].key;
    await pickGoal(start, { open: initial.key === start && initial.open.length ? initial.open : null });
  });
})();
