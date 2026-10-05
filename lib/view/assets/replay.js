// The replay page: every recorded step of one thread (a session, or sessions the logs connect)
// by agent and tool over time, a playhead to scrub, and a side panel saying what the logs say
// was going on at that moment. Data: /api/replay?thread=<id> or ?session=<key>; with neither,
// the most recent thread in the window. The address holds only ids: ?session=<key> and
// #<thread>~<event> for the record open in the panel. #<thread>~zoom~<finding key>[~<event>]
// zooms to the steps a problem finding's check recorded and marks only those, until the fit
// control, Esc or the bar's own button leaves the zoom.
(function () {
  'use strict';
  const { esc, plural, chip, time, toT, dur, isId } = HW;
  const $ = (id) => document.getElementById(id);
  const svg = $('chart');
  let D;
  let T0;
  let T1;
  let multi = false;
  let multiDay = false;
  let mains = [];
  let mainKeys = new Set();
  let LANES = [];
  let placed = [];
  let steps = [];
  let prompts = [];
  let mainTurns = [];
  let frames = [];
  let instrOf = new Map();
  let gitOps = [];
  let opened = null;
  let WHOLE = 'the whole session';
  let base = '';
  // The zoomed finding: { key, f, pattern, z, ids (its steps in this replay, in time order), set, i }.
  let Z = null;
  let openId = null;
  // Lanes opened into one row per tool; HELPERS is the one row every sub-agent shares until opened.
  const HELPERS = 'helpers';
  const expanded = new Set();
  const hiddenFamilies = new Set();
  let playhead;
  let view;
  let timer = null;
  let LEFT = 240;
  const HEAD_H = 30;
  const SUB_H = 22;
  const CHAR = 6.3;
  const SESS_Y = 40;
  let TOP = 46;

  // ---- the address ------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const askedSession = isId('session', params.get('session')) ? params.get('session') : null;
  const hashParts = () => location.hash.slice(1).split('~');
  const askedThread = isId('thread', hashParts()[0]) ? hashParts()[0] : null;
  const askedEvent = () => {
    const id = hashParts()[1];
    return isId('event', id) ? id : null;
  };
  const FINDING_KEY = /^pf-[a-p]{12}$/;
  const zoomKey = (parts = hashParts()) => (parts[1] === 'zoom' && FINDING_KEY.test(parts[2] ?? '') ? parts[2] : null);
  const zoomAddress = (id = openId) => `#${base}${Z ? `~zoom~${Z.key}` : ''}${id ? `~${id}` : ''}`;

  // ---- what goes where ------------------------------------------------------------------
  const family = (p) => (p.e.__gitop ? 'kind:gitop' : p.e.kind === 'action' ? `step:${p.e.group ?? 'other'}` : `kind:${p.e.kind}`);
  const FAMILIES = [
    ['step:run', 'Commands run'], ['step:change', 'Files changed'], ['step:look', 'Reads, searches, web and browser'], ['step:other', 'Other tool calls (delegation, plans, skills, messages, connected tools)'],
    ['kind:message', 'Agent messages'], ['kind:delegation-received', 'Sub-agent instructions'], ['kind:agent-message', 'Messages between agents'],
    ['kind:prompt', 'Your prompts'], ['kind:command', 'Your slash commands'], ['kind:notice', 'Your actions with no typed text'], ['kind:decision', 'Your decisions (answers, rejections)'], ['kind:interrupt', 'Interruptions'],
    ['kind:notification', 'Completion notices'], ['kind:guard', 'Refusals by a rule or hook'], ['kind:hook', 'Hooks run'], ['kind:turn-end', 'Turn ends'], ['kind:queue', 'Queued messages'], ['kind:mode', 'Mode changes'], ['kind:external-edit', 'Files changed outside the agent'], ['kind:compaction', 'Context compacted'], ['kind:error', 'Errors'], ['kind:session', 'Session starts'],
    ['kind:outcome', "Git's own record (commits, landed pull requests)"], ['kind:gitop', 'Git operations the harness recorded'], ['kind:link', 'Pull-request links'],
  ];
  function catalog() {
    const counts = new Map();
    for (const p of placed) counts.set(family(p), (counts.get(family(p)) ?? 0) + 1);
    const calls = placed.filter((p) => p.e.kind === 'action' && !p.e.__gitop);
    const tools = new Set(calls.map((p) => p.e.tool ?? p.e.facts?.tool)).size;
    const others = placed.filter((p) => !calls.includes(p));
    $('catalogSummary').textContent = `What the logs show for ${multi ? `these ${mains.length} sessions` : 'this session'}: ${plural(calls.length, 'tool call')} across ${plural(tools, 'tool')}, and ${plural(others.length, 'other record')} in ${plural(new Set(others.map(family)).size, 'kind')}. Show or hide any kind.`;
    $('catalogGrid').innerHTML = FAMILIES.map(([k, label]) => {
      const n = counts.get(k) ?? 0;
      return `<label class="${n ? '' : 'zero'}"><input type="checkbox" data-fam="${k}" ${hiddenFamilies.has(k) ? '' : 'checked'} ${n ? '' : 'disabled'}> ${esc(label)}<span class="n">${n || 'none here'}</span></label>`;
    }).join('');
    document.querySelectorAll('[data-fam]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) hiddenFamilies.delete(cb.dataset.fam);
      else hiddenFamilies.add(cb.dataset.fam);
      render();
      if (Z) zoomPanel();
    }));
  }

  // ---- layout -----------------------------------------------------------------------------
  function rows() {
    const visible = placed.filter((p) => !hiddenFamilies.has(family(p)));
    const out = [];
    // Helpers (sub-agents) share one row, folded, until it's opened into a lane each.
    const helpers = LANES.filter((l) => l.agent);
    const helperKeys = new Set(helpers.map((l) => l.key));
    const helpersOpen = expanded.has(HELPERS);
    let helperRow = false;
    for (const L of LANES) {
      if (L.agent) {
        if (!helperRow) {
          helperRow = true;
          const all = visible.filter((p) => helperKeys.has(p.lane));
          out.push({ key: HELPERS, label: `${helpersOpen ? '▾' : '▸'} ${plural(helpers.length, 'helper')}`, head: true, group: true, lane: { key: HELPERS, label: plural(helpers.length, 'helper'), helpers }, items: helpersOpen ? [] : all, count: all.length, counted: !helpersOpen, h: HEAD_H });
        }
        if (!helpersOpen) continue;
      }
      const mine = visible.filter((p) => p.lane === L.key);
      const isOpen = expanded.has(L.key);
      out.push({ key: L.key, label: `${isOpen ? '▾' : '▸'} ${L.label}`, head: true, lane: L, items: isOpen ? [] : mine, count: mine.length, h: HEAD_H });
      if (isOpen) {
        const groups = new Map();
        for (const p of mine) (groups.get(p.sub) ?? groups.set(p.sub, []).get(p.sub)).push(p);
        for (const [sub, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) out.push({ key: `${L.key}|${sub}`, label: sub, head: false, lane: L, items, count: items.length, h: SUB_H });
      }
    }
    // Self-check: every record the catalog counts (and isn't hidden) must sit in some lane.
    const undrawn = visible.length - out.filter((r) => r.head && r.counted !== false).reduce((n, r) => n + r.count, 0);
    const warn = $('undrawn');
    warn.hidden = undrawn <= 0;
    warn.textContent = undrawn > 0 ? `${undrawn} record${undrawn === 1 ? " isn't" : "s aren't"} drawn in any lane.` : '';
    return out;
  }
  // Which session a moment belongs to: the last one that had started by then.
  const sessionAt = (t) => {
    let at = mains[0];
    for (const m of mains) if (m.start <= t) at = m;
    return at;
  };
  const instructionText = (e) => String(e.facts?.text ?? e.text.replace(/^started (?:with instructions from its parent agent|by codex exec with instructions) /, ''));

  function render() {
    const keep = HW.focusedMark(svg);
    const W = svg.clientWidth || 900;
    LEFT = Math.round(Math.min(240, Math.max(120, W * 0.24)));
    const R = rows();
    const H = TOP + R.reduce((n, r) => n + r.h, 0) + 8;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    const [v0, v1] = view;
    const x = (t) => LEFT + ((t - v0) / (v1 - v0)) * (W - LEFT - 10);
    const cl = (px) => Math.max(LEFT, px);
    const drawn = [];
    let s = '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" stroke-width="2"/></pattern></defs>';
    // Axis: a gridline at every step, a label wherever it fits; the day shows on each day's first label.
    const stepMs = HW.niceStep((v1 - v0) / (W - LEFT - 10));
    let lastDay = null;
    let freeX = -Infinity;
    for (let t = Math.ceil(v0 / stepMs) * stepMs; t <= v1; t += stepMs) {
      const day = HW.dayOf(t);
      const label = time(t, { day: day !== lastDay || stepMs >= 86400e3, seconds: stepMs < 60e3 });
      s += `<line x1="${x(t)}" x2="${x(t)}" y1="12" y2="${H - 6}" stroke="var(--grid)"/>`;
      if (x(t) + 3 < freeX) continue;
      s += `<text class="tick" x="${x(t) + 3}" y="10">${esc(label)}</text>`;
      freeX = x(t) + 3 + label.length * 5.8 + 10;
      lastDay = day;
    }
    // Turn band: every main agent's turns, numbered; click one to zoom to it.
    mainTurns.forEach((t, i) => {
      const a = Math.max(v0, toT(t.startAt));
      const b = Math.min(v1, toT(t.lastRecordAt ?? t.endAt ?? t.startAt));
      if (b < v0 || a > v1) return;
      const w = Math.max(2, x(b) - x(a));
      const opener = HW.stripKind(t.opener?.text ?? '').replace(/^"|"$/g, '');
      s += `<g class="turnseg" data-turn="${i}"><rect x="${x(a)}" y="17" width="${w}" height="20" rx="4" fill="var(--surface)" stroke="var(--ring)"/>${w > 22 ? `<text class="tick" x="${x(a) + 4}" y="31">T${i + 1}${w > 140 ? ` · ${esc(opener.slice(0, Math.floor((w - 40) / 6)))}` : ''}</text>` : ''}<title>Turn ${i + 1}${multi ? `, session ${mains.findIndex((m) => m.a.key === t.agent) + 1}` : ''}: ${esc(t.opener?.text ?? '')} (click to zoom)</title></g>`;
    });
    // Sessions: a labelled rule at each later session's first record, and a name in the strip.
    if (multi) {
      let limit = W - 10;
      for (let i = mains.length - 1; i >= 0; i--) {
        const m = mains[i];
        const until = mains[i + 1]?.start ?? T1;
        if (m.start > v1 || until < v0) continue;
        const shown = m.start >= v0;
        const lx = shown ? x(m.start) : LEFT;
        const when = time(m.start, { day: true });
        const tip = `Session ${i + 1}: its first record is ${time(m.start, { day: true, seconds: true })}.`;
        if (shown && i > 0) s += `<line class="sessrule" x1="${lx}" x2="${lx}" y1="${SESS_Y}" y2="${H - 6}" stroke="var(--ink-2)" stroke-width="1.2" stroke-dasharray="4 3"><title>${esc(tip)}</title></line>`;
        const names = shown ? [`Session ${i + 1} starts, ${when}`, `Session ${i + 1} starts`, `Session ${i + 1}`, `S${i + 1}`] : [`Session ${i + 1}`, `S${i + 1}`];
        let at = null;
        for (const name of names) {
          const tw = name.length * 5.8 + 6;
          if (lx + 4 + tw <= limit) {
            at = { name, tx: lx + 4, tw };
            break;
          }
          if (shown && i > 0 && lx - 4 - tw - 12 >= LEFT) {
            at = { name: `${name} →`, tx: lx - 4 - tw - 12, tw: tw + 12 };
            break;
          }
        }
        if (!at) continue;
        s += `<g><rect x="${at.tx - 2}" y="${SESS_Y + 2}" width="${at.tw}" height="15" rx="3" fill="var(--page)"/><text class="sesslabel" x="${at.tx}" y="${SESS_Y + 13}">${esc(at.name)}</text><title>${esc(tip)}</title></g>`;
        limit = at.tx - 10;
      }
    }
    let y = TOP;
    for (const r of R) {
      const mid = y + r.h / 2;
      s += `<line x1="0" x2="${W - 10}" y1="${y + r.h - 0.5}" y2="${y + r.h - 0.5}" stroke="var(--grid)"/>`;
      const ins = r.head && r.lane.agent ? instrOf.get(r.lane.key) : null;
      const hover = r.group
        ? `${r.lane.label}, the sub-agents the agents started: ${r.lane.helpers.map((l) => l.label.replace(/^↳ /, '')).join('; ')}.\n\nClick to open a lane for each.`
        : r.head && r.lane.agent ? `${r.label}\n\n${ins ? `Started with: ${instructionText(ins)}` : "Its starting instruction isn't in the logs read."}\n\nClick to open one row per tool.` : r.label;
      const room = LEFT - (r.head ? 34 : 50);
      const focus = r.head ? ` tabindex="0" role="button" aria-expanded="${expanded.has(r.lane.key)}"` : '';
      if (r.group) {
        s += `<text class="row-label head helpers" data-lane="${HELPERS}"${focus} x="8" y="${mid + 4}">${HW.fitText(r.label, room, CHAR)}<title>${esc(hover)}</title></text>`;
      } else if (r.head && r.lane.session && r.label.length * CHAR > room) {
        // A main lane's full name doesn't fit: "Main agent" on one line, its session under it.
        s += `<text class="row-label head" data-lane="${esc(r.lane.key)}"${focus} x="8" y="${y + 13}">${esc(`${r.label.slice(0, 2)}Main agent`)}<title>${esc(hover)}</title></text><text class="row-sub" data-lane="${esc(r.lane.key)}" x="20" y="${y + 26}">session ${r.lane.session}<title>${esc(hover)}</title></text>`;
      } else {
        s += `<text class="row-label ${r.head ? 'head' : ''}" ${r.head ? `data-lane="${esc(r.lane.key)}"${focus}` : ''} x="${r.head ? 8 : 26}" y="${mid + 4}">${HW.fitText(r.label, room, CHAR)}<title>${esc(hover)}</title></text>`;
      }
      s += `<text class="row-count" x="${LEFT - 8}" y="${mid + 4}" text-anchor="end">${r.count}</text>`;
      for (const a of r.group ? (r.items.length ? r.lane.helpers.map((l) => l.agent) : []) : r.head && r.lane.agent ? [r.lane.agent] : []) {
        const st = toT(a.spawnAt ?? a.firstAt);
        const en = toT(a.completion?.at ?? a.lastAt);
        if (en >= v0 && st <= v1) s += `<rect x="${cl(x(st))}" y="${y + 5}" width="${Math.max(2, x(Math.min(en, v1)) - cl(x(st)))}" height="${r.h - 11}" rx="4" fill="var(--wash)" stroke="var(--ring)"><title>${r.group ? `${esc(HW.agentLabel(a.key))}: open` : 'Open'} recorded span: started ${time(st)}, ${a.completion ? `finished ${time(en)} (${a.completion.via})` : `last record ${time(en)}`}</title></rect>`;
      }
      // Stretches with no records sit on the main lane of the session they fall in.
      const busy = [];
      if (r.head && mainKeys.has(r.lane.key) && !hiddenFamilies.has('kind:quiet')) {
        for (const q of [...HW.data.byId.values()].filter((e) => e.kind === 'quiet' && (e.endT ?? e.t) >= v0 && e.t <= v1 && sessionAt(e.t).a.key === r.lane.key)) {
          const qx = cl(x(q.t));
          const w = Math.max(1, x(Math.min(q.endT ?? q.t, v1)) - qx);
          const span = q.spanMs ?? q.derived?.ms ?? (q.endT ? q.endT - q.t : null);
          const label = `${time(q.t, { day: true, seconds: true })}. No records for ${dur(span)}: not idle, just unrecorded. derived.`;
          drawn.push({ id: q.id, text: label });
          s += `<rect class="mark" data-id="${esc(q.id)}" tabindex="0" role="button" aria-label="${esc(label)}" x="${qx}" y="${y + 4}" width="${w}" height="${r.h - 9}" rx="3" fill="var(--grid)" opacity="0.55"><title>No records for ${dur(span)} (derived): not idle, just unrecorded</title></rect>`;
          if (w > 90) {
            const text = `no records · ${dur(span)}`;
            s += `<text class="tick" x="${qx + w / 2}" y="${mid + 4}" text-anchor="middle" aria-hidden="true">${esc(text)}</text>`;
            busy.push([qx + w / 2 - (text.length * 6) / 2 - 4, qx + w / 2 + (text.length * 6) / 2 + 4]);
          }
        }
      }
      // Marks, then labels where there's room to read them.
      const inView = r.items.filter((p) => (p.e.endT ?? p.e.t) >= v0 && p.e.t <= v1);
      // Starting instructions draw last so a sub-agent's first step can't hide them.
      for (const p of [...inView].sort((a, b) => (a.e.kind === 'delegation-received') - (b.e.kind === 'delegation-received'))) {
        const pieces = HW.describeStepPieces(p.e);
        // A finding the "Worth a look" strip shows at this step, in the page's own words.
        const wl = window.HWS?.note(p.e.id);
        if (wl) pieces.push([wl, false]);
        // A step of the zoomed finding: a ring behind its mark, and a line saying so.
        if (Z?.set.has(p.e.id)) {
          pieces.push([` In the zoomed finding: step ${Z.ids.indexOf(p.e.id) + 1} of ${Z.ids.length}.`, false]);
          const hx = x(p.e.t);
          const hx2 = p.e.endT && p.e.kind === 'action' ? x(Math.min(p.e.endT, v1)) : hx;
          s += `<rect class="zoomhalo" aria-hidden="true" x="${cl(hx - 8)}" y="${mid - 10}" width="${Math.max(16, hx2 - hx + 16)}" height="20" rx="7" fill="var(--accent-wash)" stroke="var(--accent)" stroke-width="2"/>`;
        }
        const label = pieces.map(([t]) => t).join('');
        drawn.push({ id: p.e.id, text: label, pieces });
        s += HW.markSvg(p.e, { x, mid, small: !r.head, playhead, big: 7, sm: 5, label });
      }
      let free = -Infinity;
      // Housekeeping records never take a label, so your prompts and the agents' steps get the room.
      const labelable = inView.filter((p) => !['queue', 'mode', 'hook', 'turn-end', 'quiet'].includes(p.e.kind));
      labelable.forEach((p, i) => {
        const startX = x(p.e.endT && p.e.kind === 'action' ? p.e.endT : p.e.t) + 6;
        if (busy.some(([a, b]) => startX >= a && startX <= b)) return;
        const next = Math.min(labelable[i + 1] ? x(labelable[i + 1].e.t) : W - 10, ...busy.filter(([a]) => a > startX).map(([a]) => a));
        const room = next - startX - 6;
        if (startX < free || room < 60) return;
        const text = String(HW.summary(p.e) ?? '');
        const chars = Math.floor(room / 6);
        s += `<text class="marklabel" x="${startX}" y="${mid + 3.5}" aria-hidden="true">${esc(text.length > chars ? `${text.slice(0, chars - 1)}…` : text)}</text>`;
        free = startX + Math.min(room, text.length * 6);
      });
      y += r.h;
    }
    // Delegation connectors when the sub-agent lane is visible.
    const rowY = new Map();
    let yy = TOP;
    for (const r of R) {
      if (r.head) rowY.set(r.lane.key, yy + r.h / 2);
      yy += r.h;
    }
    for (const L of LANES.filter((l) => l.agent && l.agent.spawnedBy)) {
      const call = HW.data.byId.get(L.agent.spawnedBy);
      if (!call || call.t < v0 || call.t > v1) continue;
      const y1 = rowY.get(HW.laneOf(call)) ?? rowY.get(HELPERS);
      const y2 = rowY.get(L.key) ?? rowY.get(HELPERS);
      if (y1 === y2) continue;
      if (y1 == null || y2 == null) continue;
      s += `<path d="M${x(call.t)},${y1} V${y2}" stroke="var(--axis)" stroke-dasharray="2 3" fill="none"/>`;
    }
    if (playhead >= v0 && playhead <= v1) s += `<line class="playhead" x1="${x(playhead)}" x2="${x(playhead)}" y1="12" y2="${H}" stroke="var(--run)" stroke-width="2"/><circle cx="${x(playhead)}" cy="12" r="4" fill="var(--run)"/>`;
    svg.innerHTML = s;
    // While zoomed to a finding, every other mark steps back so its own steps stand out.
    if (Z) svg.querySelectorAll('.mark[data-id]').forEach((m) => !Z.set.has(m.dataset.id) && m.setAttribute('opacity', '0.3'));
    HW.stepList($('chartSteps'), drawn);
    HW.refocus(svg, keep);
    window.HWS?.render({ x, v0, v1, W, LEFT });
    panel();
  }

  // ---- the side panel: what do the logs say was going on at the playhead? --------------------
  const ago = (t) => (playhead - t < 1000 ? 'at this moment' : `${dur(playhead - t)} ago`);
  const whoOf = (key) => {
    const a = HW.data.agentByKey.get(key);
    return !a || a.kind === 'main' ? HW.data.mainLabels.get(key) ?? 'Main agent' : HW.agentLabel(key);
  };
  function frameAt(t) {
    let lo = 0;
    let hi = frames.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return frames[ans] ?? null;
  }
  function inProgress(f) {
    const items = [];
    for (const a of f.awaiting) {
      const e = HW.data.byId.get(a.event);
      if (!e) continue;
      // A sub-agent's starting call is shown once, as the sub-agent below.
      if (e.facts?.spawnedAgent && f.agentsOpen.includes(e.facts.spawnedAgent)) continue;
      items.push(`<li data-id="${esc(e.id)}"><span class="who">${esc(whoOf(e.agent))}</span> asked for ${esc(e.tool ?? e.facts?.tool ?? 'a step')} and has no result yet<div class="sub">${esc(HW.clip(HW.summary(e), 110))}</div><div class="sub">asked ${esc(ago(e.t))}${a.never ? '. The log never records a result for this one.' : ''}</div></li>`);
    }
    for (const k of f.agentsOpen) {
      const ag = HW.data.agentByKey.get(k);
      const ins = instrOf.get(k);
      const text = ins ? instructionText(ins) : '';
      items.push(`<li ${ins ? `data-id="${esc(ins.id)}"` : ''}><span class="who">${esc(whoOf(k))}</span> started ${esc(ago(toT(ag?.spawnAt ?? ag?.firstAt)))} and hasn't reported back yet<div class="sub">${esc(ag?.description ?? '')}</div>${ins ? `<div class="instr">${HW.clipHtml(text, 240)}</div>` : "<div class=\"sub\">Its starting instruction isn't in the logs read.</div>"}</li>`);
    }
    for (const id of f.queued) {
      const e = HW.data.byId.get(id);
      items.push(`<li data-id="${esc(id)}"><span class="who">You</span> typed a message while the agent was busy; it hasn't been delivered yet<div class="sub">${esc(HW.clip(e?.text, 120))}</div></li>`);
    }
    return items;
  }
  function panel() {
    const f = frameAt(playhead) ?? HW.frameOf({});
    const last = [...prompts].reverse().find((p) => p.t <= playhead);
    const row = (label, [v, l], text = v) => `<span>${label} ${chip(l)}</span><span class="v">${esc(text)}</span>`;
    const now = inProgress(f);
    const at = time(playhead, { day: true, seconds: true });
    $('readout').textContent = at;
    const slider = $('slider');
    slider.value = Math.round(((playhead - T0) / Math.max(1, T1 - T0)) * 1000);
    slider.setAttribute('aria-valuetext', at);
    $('stepOf').textContent = steps.length ? `step ${steps.filter((e) => e.t <= playhead).length} of ${steps.length}` : '';
    const askedWhen = last ? (playhead - last.t < 1000 ? 'At this moment' : `${dur(playhead - last.t)} earlier`) : '';
    const w = last ? HW.who(last) : null;
    $('panel').innerHTML = `
      <p class="intro">Move the playhead and this panel shows what the logs say was going on at that moment.</p>
      <div class="when">${esc(at)}</div>${multi ? `<div class="note tight">Session ${mains.indexOf(sessionAt(playhead)) + 1} of ${mains.length}</div>` : ''}
      <h2>The last thing you asked</h2>
      ${last ? `<div class="quote"><a href="#" class="plain" data-id="${esc(last.id)}">${esc(HW.stripKind(last.text))}</a></div><div class="note tight">${esc(askedWhen)} · ${esc(w.short)} ${chip(w.level)}</div>` : "<p class=\"note\">You haven't asked anything yet at this point.</p>"}
      <h2>In progress at this moment (${now.length})</h2>
      ${now.length ? `<ul class="now">${now.join('')}</ul>` : '<p class="note">Nothing. Every step started so far already has its result in the log.</p>'}
      ${f.quiet ? "<p class=\"note\">The log is silent around here: no records for a while. That doesn't mean idle, only unrecorded.</p>" : ''}
      <h2>Totals up to this moment</h2>
      <div class="tally">
        ${row('Your prompts', f.prompts)}
        ${row('Steps the agents took', f.actions)}
        ${row('Files changed', f.filesEdited, `${f.filesEdited[0]}${f.edits[0] ? ` (${plural(f.edits[0], 'edit')})` : ''}`)}
        ${row('Test runs', f.testRuns, f.testRuns[0] ? `${f.testRuns[0]}: ${f.testsPassed[0]} passed, ${f.testsFailed[0]} with failures${f.testsUnclear[0] ? `, ${f.testsUnclear[0]} unclear` : ''}` : 0)}
        ${row('Sub-agents started', f.delegations)}
        ${row('Steps a rule or hook blocked', f.guards)}
        ${row('Interruptions', f.interrupts)}
        ${row('Your commits (git)', f.commits)}
        ${row('Pull requests landed (git)', f.prsLanded)}
      </div>
      <p class="note">Each number carries the level the engine gives it. Derived means worked out from logged values; inferred means a named rule decided what counts (here, which commands are test runs), so it could be wrong. Nothing here measures time spent working.</p>`;
    // Each listed record is a button: Tab reaches it, and Enter or Space opens it.
    document.querySelectorAll('#panel [data-id]').forEach((li) => {
      if (li.tagName !== 'A') {
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
      }
      li.addEventListener('click', (ev) => {
        ev.preventDefault();
        HW.openEvent(li.dataset.id);
      });
      li.addEventListener('keydown', (ev) => {
        if (li.tagName === 'A' || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        HW.openEvent(li.dataset.id);
      });
    });
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
    // While a finding is zoomed, the fit control and "Whole session" stay usable even when its
    // steps span the whole session, since choosing either is how the zoom is left.
    $('zoom').value = whole && !Z ? '0' : preset ?? 'custom';
    $('fit').disabled = whole && !Z;
    const bar = $('zoombar');
    bar.hidden = whole;
    if (!whole) bar.innerHTML = `Zoomed in: showing ${esc(time(view[0], { seconds: true, day: multiDay }))} to ${esc(time(view[1], { seconds: true, day: multiDay && HW.dayOf(view[0]) !== HW.dayOf(view[1]) }))} (${esc(dur(view[1] - view[0]))} of ${esc(dur(T1 - T0))} in all). <button type="button" data-fit>⤢ Back to ${WHOLE}</button> <span class="kbd">or press Esc, or double-click the chart</span>`;
    bar.querySelector('[data-fit]')?.addEventListener('click', fitAll);
    render();
  }
  /** Back to the whole thread, leaving a finding's zoom and clearing its marks. */
  function fitAll() {
    if (Z) clearZoom();
    setView(T0, T1);
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
  const stepTo = (dir, list = steps) => {
    const next = dir > 0 ? list.find((e) => e.t > playhead) : [...list].reverse().find((e) => e.t < playhead);
    if (!next) return;
    setPlayhead(next.t);
    HW.announce(HW.describeStepPieces(next));
  };
  function showAt(id, { zoom = true, focusNav = 0 } = {}) {
    const e = HW.data.byId.get(id);
    if (!e) return false;
    playhead = e.t;
    if (zoom || e.t < view[0] || e.t > view[1]) setView(e.t - 150e3, e.t + 150e3, '300000');
    else render();
    HW.openEvent(e.id, { focusNav });
    return true;
  }
  // ---- zoomed to a finding: the steps its check recorded, and only those ---------------------
  const LEVEL_HOW = {
    recorded: 'the log records each one',
    derived: "worked out from the log's facts",
    inferred: 'a named rule picked them, so it could be wrong',
    missing: "the check matched it, and a record it expected isn't in the logs",
  };
  const cap = (t) => `${t[0].toUpperCase()}${t.slice(1)}`;
  /** How the set of steps is known, never more than the check recorded. */
  function zoomHow(f, z) {
    const check = `the check “${f.checkTitle ?? f.check}”`;
    const recorded = z.events.length + (z.unread ?? 0);
    let what;
    if (z.near) what = `It isn't a set of steps: ${check} measures model calls, which aren't steps on this timeline, so it records only the step nearest where the finding starts${f.lastAt ? `, and the finding runs to ${time(toT(f.lastAt), { day: multiDay, seconds: true })}` : ''}. That one step is marked; nothing after it is guessed.`;
    else if (z.total === 1) what = `${cap(check)} matched one step, and that's the one marked.`;
    else if (z.total != null && z.total > recorded) what = `${cap(check)} matched ${plural(z.total, 'step')} and recorded the ids of ${recorded}. Only those are marked; the rest aren't guessed.`;
    else what = `These are the ${plural(recorded, 'step')} ${check} matched, and only those.`;
    // A finding that says which of its parts the log records and which are worked out lists them.
    const basis = Array.isArray(f.basis) && f.basis.length ? ` ${f.basis.map((b) => `${chip(b.level)} ${esc(b.part)}: ${esc(HW.lowerFirst(b.how))}`).join(' ')}` : '';
    return `${esc(cap(LEVEL_HOW[f.verdictEvidence] ?? f.verdictEvidence))}. ${esc(what)}${basis}`;
  }
  const laneName = (l) => (l.thread !== base ? 'Another thread' : mainKeys.has(l.agent) ? HW.data.mainLabels.get(l.agent) ?? 'Main agent' : l.agent ? HW.agentLabel(l.agent) : 'No agent');
  function zoomPanel() {
    const bar = $('zoomFinding');
    if (!Z) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const { f, z, pattern } = Z;
    const n = Z.ids.length;
    const patHref = /^[a-z][a-z0-9-]{1,60}$/.test(pattern?.id ?? '') ? `problems.html#${pattern.id}` : 'problems.html';
    const notDrawn = Z.ids.filter((id) => {
      const p = placed.find((q) => q.e.id === id);
      return !p || hiddenFamilies.has(family(p));
    }).length;
    const elsewhere = (l) => l.events.every((id) => !HW.data.byId.has(id));
    const stepBtn = (id) => `<button type="button" class="linklike" data-zstep="${Z.ids.indexOf(id)}" aria-label="Step ${Z.ids.indexOf(id) + 1} of ${n} in the finding">${Z.ids.indexOf(id) + 1}</button>`;
    const lanes = z.lanes.length > 1 ? `<p class="zlanes">${z.lanes.map((l) => {
      if (elsewhere(l)) {
        const href = isId('session', l.session) && isId('thread', l.thread) && l.thread !== base ? `replay.html?session=${encodeURIComponent(l.session)}#${l.thread}~zoom~${Z.key}` : null;
        return `${esc(laneName(l))}, ${esc(plural(l.events.length, 'step'))}${href ? ` (<a href="${esc(href)}">open it zoomed</a>)` : ''}`;
      }
      return `${esc(laneName(l))}: ${l.events.filter((id) => Z.set.has(id)).map(stepBtn).join(' ')}`;
    }).join(' · ')}.</p>` : '';
    // One short line: the pattern, how many steps, the level's marker, and a "?" fold with how
    // the steps are known and what's missing.
    const count = z.near ? '1 step, nearest' : z.total != null && z.total > n ? `${n} of ${plural(z.total, 'step')}` : plural(n, 'step');
    const span = z.threads > 1 ? ` · ${z.threads} threads` : z.agents > 1 ? ` · ${z.agents} agents` : '';
    bar.hidden = false;
    bar.innerHTML = `<a href="${esc(patHref)}">${esc(pattern?.name ?? f.checkTitle ?? 'a problem pattern')}</a> <span>· ${esc(count)}${esc(span)}</span> ${chip(f.verdictEvidence)}
      <details class="zwhy"><summary title="How the steps are known" aria-label="How the steps are known">?</summary><p>${zoomHow(f, z)}${z.unread ? ` ${esc(plural(z.unread, 'recorded step'))} ${z.unread === 1 ? "isn't" : "aren't"} in this page's records.` : ''}${notDrawn ? ` ${notDrawn} ${notDrawn === 1 ? "isn't" : "aren't"} drawn: that kind of record is hidden.` : ''}</p>${lanes}</details>
      <span class="zctl" role="group" aria-label="Step through the finding's steps"><button type="button" data-zdir="-1" aria-label="Previous step in the finding"${n && Z.i > 0 ? '' : ' disabled'}>◀</button><span class="zpos">${Z.i >= 0 ? `${Z.i + 1} of ${n}` : ''}</span><button type="button" data-zdir="1" aria-label="Next step in the finding"${n && Z.i < n - 1 ? '' : ' disabled'}>▶</button> <button type="button" data-zleave title="Leave the zoom (Esc)">⤢ Leave</button></span>`;
  }
  /** Go to step i of the finding: the playhead to it and its record open, focus kept on `keep`. */
  function zoomStep(i, keep) {
    if (!Z || i < 0 || i >= Z.ids.length) return;
    Z.i = i;
    const id = Z.ids[i];
    const e = HW.data.byId.get(id);
    if (!showAt(id, { zoom: false })) return;
    HW.announce([[`Step ${i + 1} of ${Z.ids.length} in the finding: `, false], ...HW.describeStepPieces(e)]);
    zoomPanel();
    const bar = $('zoomFinding');
    const again = keep?.dataset?.zdir ? bar.querySelector(`[data-zdir="${keep.dataset.zdir}"]`) : keep?.dataset?.zstep ? bar.querySelector(`[data-zstep="${keep.dataset.zstep}"]`) : null;
    const target = again && !again.disabled ? again : keep ? bar.querySelector('[data-zleave]') : null;
    target?.focus({ preventScroll: true });
  }
  /** Zoom to finding `key`: its first step to its last with a small margin, marking only those. */
  async function applyZoom(key, { open = null, focus = true } = {}) {
    let a;
    try {
      a = await HW.load('problems', { finding: key });
    } catch (err) {
      if (err?.code === 'shown') return;
      HW.addNote(`The finding named in the address couldn't be loaded: ${esc(err?.message ?? err)}`);
      return;
    }
    const f = a?.finding;
    const z = f?.zoom;
    if (!f || !z || !Array.isArray(z.events) || !Array.isArray(z.lanes)) {
      HW.addNote('That finding recorded no step to zoom to.');
      return;
    }
    const ids = z.events.filter((id) => isId('event', id) && HW.data.byId.has(id)).sort((p, q) => HW.data.byId.get(p).t - HW.data.byId.get(q).t);
    Z = { key, f, z, pattern: a.pattern ?? null, ids, set: new Set(ids), i: -1 };
    if (ids.length) {
      const es = ids.map((id) => HW.data.byId.get(id));
      const s0 = Math.min(...es.map((e) => e.t));
      const s1 = Math.max(...es.map((e) => e.endT ?? e.t));
      const pad = Math.max(15e3, (s1 - s0) * 0.06);
      playhead = s0;
      setView(s0 - pad, s1 + pad);
    } else render();
    zoomPanel();
    const at = open && Z.set.has(open) ? open : null;
    const want = zoomAddress(at ?? (openId && Z.set.has(openId) ? openId : null));
    history.replaceState(null, '', want);
    if (at) zoomStep(Z.ids.indexOf(at));
    else if (focus) $('zoomFinding').focus();
    const name = Z.pattern?.name ?? f.checkTitle ?? 'a problem pattern';
    HW.announce(ids.length
      ? `Zoomed to ${plural(ids.length, 'step')} of the finding “${name}”, from ${time(HW.data.byId.get(ids[0]).t, { day: multiDay, seconds: true })} to ${time(HW.data.byId.get(ids.at(-1)).t, { day: multiDay, seconds: true })}. Only those steps are marked.`
      : `None of the steps of the finding “${name}” are in this replay.`);
  }
  /** Leave the zoom: the marks and the bar go, and the address drops the finding. */
  function clearZoom() {
    if (!Z) return;
    const inBar = $('zoomFinding').contains(document.activeElement);
    Z = null;
    zoomPanel();
    const want = zoomAddress();
    history.replaceState(null, '', want);
    render();
    if (inBar) $('zoom').focus();
    HW.announce('Left the zoom. The marks are cleared.');
  }

  /** The record panel's Previous step and Next step: the step before or after, in time order. */
  function neighbour(id, dir) {
    const e = HW.data.byId.get(id);
    if (!e) return null;
    const i = steps.findIndex((x) => x.id === id);
    if (i >= 0) return steps[i + dir] ?? null;
    return dir > 0 ? steps.find((x) => x.t > e.t) ?? null : [...steps].reverse().find((x) => x.t < e.t) ?? null;
  }

  function wire() {
    $('prevStep').addEventListener('click', () => stepTo(-1));
    $('nextStep').addEventListener('click', () => stepTo(1));
    $('prevPrompt').addEventListener('click', () => stepTo(-1, prompts));
    $('nextPrompt').addEventListener('click', () => stepTo(1, prompts));
    $('slider').addEventListener('input', (ev) => setPlayhead(T0 + ((T1 - T0) * Number(ev.target.value)) / 1000));
    $('zoom').addEventListener('change', (ev) => {
      const z = Number(ev.target.value);
      if (!z) return fitAll();
      setView(playhead - z / 2, playhead + z / 2, String(z));
    });
    $('fit').addEventListener('click', fitAll);
    $('zoomFinding').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b || !Z) return;
      if (b.dataset.zleave != null) return fitAll();
      if (b.dataset.zdir) return zoomStep(Z.i + Number(b.dataset.zdir), b);
      if (b.dataset.zstep) zoomStep(Number(b.dataset.zstep), b);
    });
    // "Zoom to these steps" for this thread (the record panel's finding box, a strip card) zooms
    // here as a new history entry, so Back undoes it.
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[data-zoomlink]');
      if (!a || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      const u = new URL(a.href, location.href);
      const parts = u.hash.slice(1).split('~');
      const key = zoomKey(parts);
      if (!key || parts[0] !== base || u.pathname !== location.pathname) return;
      ev.preventDefault();
      const want = `#${base}~zoom~${key}`;
      history.pushState(null, '', want);
      HW.closeDrawer();
      applyZoom(key);
    });
    $('expandAll').addEventListener('click', () => {
      LANES.forEach((l) => expanded.add(l.key));
      expanded.add(HELPERS);
      render();
    });
    $('collapseAll').addEventListener('click', () => {
      expanded.clear();
      render();
    });
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
      else if (ev.key === 'Escape' && !document.querySelector('.drawer.open')) fitAll();
      else if (ev.key === ' ') {
        ev.preventDefault();
        $('play').click();
      }
    });
    // Enter on a step opens its record; Enter on a lane name opens or folds it.
    HW.keyboardMarks(svg, (id) => HW.openEvent(id));
    svg.addEventListener('keydown', (ev) => {
      const lane = ev.target.closest?.('text.head[data-lane]')?.dataset.lane;
      if (!lane || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      if (expanded.has(lane)) expanded.delete(lane);
      else expanded.add(lane);
      render();
      svg.querySelector(`text.head[data-lane="${CSS.escape(lane)}"]`)?.focus();
    });
    // Pointer: hover for a summary, click a mark for the record, click empty space to move
    // the playhead, drag to zoom, double-click to fit, click a lane name to open it.
    const toT2 = (px) => view[0] + ((px - LEFT) / ((svg.clientWidth || 900) - LEFT - 10)) * (view[1] - view[0]);
    let drag = null;
    svg.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.mark, .turnseg, [data-lane]')) return;
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
          sel.setAttribute('y', '12');
          sel.setAttribute('fill', 'var(--wash)');
          sel.setAttribute('stroke', 'var(--run)');
          svg.appendChild(sel);
        }
        sel.setAttribute('x', Math.min(drag.start, drag.now));
        sel.setAttribute('width', Math.abs(drag.now - drag.start));
        sel.setAttribute('height', svg.viewBox.baseVal.height - 12);
        return;
      }
      const target = ev.target.closest?.('#chart .mark');
      if (!target) return HW.hideTip();
      const e = target.dataset.gitop ? gitOps.find((g) => g.id === target.dataset.id) : HW.data.byId.get(target.dataset.id);
      if (e && e.kind !== 'quiet') HW.showTip(ev, HW.tipHtml(e));
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (Math.abs(d.now - d.start) > 8) setView(toT2(Math.min(d.start, d.now)), toT2(Math.max(d.start, d.now)));
      else setPlayhead(toT2(d.start), false);
    });
    svg.addEventListener('mouseleave', HW.hideTip);
    svg.addEventListener('dblclick', fitAll);
    svg.addEventListener('click', (ev) => {
      const lane = ev.target.closest('[data-lane]')?.dataset.lane;
      if (lane) {
        if (expanded.has(lane)) expanded.delete(lane);
        else expanded.add(lane);
        render();
        return;
      }
      const turn = ev.target.closest('.turnseg')?.dataset.turn;
      if (turn != null) {
        const t = mainTurns[Number(turn)];
        const a = toT(t.startAt);
        const b = toT(t.lastRecordAt ?? t.endAt ?? t.startAt);
        const pad = Math.max(10e3, (b - a) * 0.04);
        playhead = a;
        setView(a - pad, b + pad);
        return;
      }
      const id = ev.target.closest('.mark')?.dataset.id;
      if (id) HW.openEvent(id);
    });
    window.addEventListener('resize', render);
    HW.setDrawerNav((id, dir, peek) => {
      const next = neighbour(id, dir);
      if (!next) return null;
      if (!peek && showAt(next.id, { zoom: false, focusNav: dir })) HW.announce(HW.describeStepPieces(next));
      return next.id;
    });
    // The address names this thread and the record open in the panel: #<thread>~<event>.
    // Opening a record adds a history entry, so Back closes it again.
    HW.onDrawer.push((id) => {
      openId = id;
      if (Z && id && Z.set.has(id) && Z.ids[Z.i] !== id) {
        Z.i = Z.ids.indexOf(id);
        zoomPanel();
      }
      const want = zoomAddress(id);
      if (location.hash === want) return;
      // Stepping through a finding's own steps replaces the entry, so one Back leaves the replay.
      if (id && !(Z && Z.set.has(id))) history.pushState(null, '', want);
      else history.replaceState(null, '', want);
    });
    window.addEventListener('popstate', () => {
      const parts = location.hash.slice(1).split('~');
      const where = parts[0];
      if ((where || base) !== base) return location.reload();
      const key = zoomKey(parts);
      const id = key ? parts[3] : parts[1];
      if (key && key !== Z?.key) return applyZoom(key, { open: isId('event', id) ? id : null });
      if (!key && Z) {
        Z = null;
        zoomPanel();
        setView(view[0], view[1]);
        HW.announce('Left the zoom. The marks are cleared.');
      }
      const e = isId('event', id) && HW.data.byId.get(id);
      if (e) showAt(e.id, { zoom: false });
      else document.querySelector('.drawer.open [data-close]')?.click();
    });
  }

  function empty(html) {
    HW.fatal(html);
    $('title').textContent = '';
  }

  HW.start(async () => {
    const q = askedThread ? { thread: askedThread } : askedSession ? { session: askedSession } : {};
    let a;
    try {
      a = await HW.load('replay', q);
    } catch (err) {
      if (err.code !== 'http' || (!askedThread && !askedSession)) throw err;
      empty(`This ${askedThread ? 'thread' : 'session'} couldn't be loaded: ${esc(err.message)} It may be outside the window this page covers.`);
      return;
    }
    D = a;
    if (!D || !D.thread) {
      empty(askedThread || askedSession ? `${HW.nothingIn('has this thread')} <a href="search.html">Search</a> for another one.` : `${HW.nothingIn('to replay')} <a href="search.html">Search</a> for a session to replay, or look further back.`);
      const el = document.querySelector('[data-fatal]');
      if (el) el.dataset.fatal = 'no-thread';
      return;
    }
    const events = (Array.isArray(D.events) ? D.events : []).map(HW.normEvent).filter((e) => Number.isFinite(e.t));
    const agents = Array.isArray(D.agents) ? D.agents : [];
    const sessions = Array.isArray(D.sessions) ? D.sessions : [];
    HW.useData({ events, agents, rules: D.rules ?? {}, sessions });
    const th = D.thread;
    T0 = toT(th.firstAt);
    T1 = toT(th.lastAt);
    if (!Number.isFinite(T0) || !Number.isFinite(T1)) {
      const ts = events.flatMap((e) => (e.endT ? [e.t, e.endT] : [e.t]));
      T0 = Math.min(...ts);
      T1 = Math.max(...ts);
    }
    if (!(T1 > T0)) T1 = T0 + 60e3;
    multiDay = HW.dayOf(T0) !== HW.dayOf(T1);

    // A replay can hold several sessions (a session resumed later is a new session file), each
    // with its own main agent. A session starts at its main agent's first own record.
    const ownFirst = new Map();
    const ownLast = new Map();
    for (const e of events) {
      if (!e.agent) continue;
      ownFirst.set(e.agent, Math.min(ownFirst.get(e.agent) ?? Infinity, e.t));
      ownLast.set(e.agent, Math.max(ownLast.get(e.agent) ?? -Infinity, e.endT ?? e.t));
    }
    mains = agents.filter((x) => x.kind === 'main').map((x) => ({ a: x, start: ownFirst.get(x.key) ?? toT(x.firstAt), end: ownLast.get(x.key) ?? toT(x.lastAt) })).sort((p, r) => p.start - r.start);
    if (!mains.length) mains = [{ a: { key: '(none)', kind: 'main' }, start: T0, end: T1 }];
    multi = mains.length > 1;
    TOP = multi ? 62 : 46;
    const mainLabel = (i) => (multi ? `Main agent, session ${i + 1}` : 'Main agent');
    HW.data.mainLabels = new Map(mains.map((m, i) => [m.a.key, mainLabel(i)]));
    mainKeys = new Set(mains.map((m) => m.a.key));
    WHOLE = multi ? (mains.length === 2 ? 'both sessions' : `all ${mains.length} sessions`) : 'the whole session';
    const WHOLE_CAP = WHOLE[0].toUpperCase() + WHOLE.slice(1);
    document.querySelector('#zoom option[value="0"]').textContent = WHOLE_CAP;
    $('fit').textContent = `⤢ ${WHOLE_CAP}`;
    $('fit').title = `Zoom back out to ${WHOLE} (Esc, or double-click the chart)`;
    $('legendSession').hidden = !multi;
    // The session the reader opened: a search link names it (?session=<key>).
    opened = askedSession ? mains.find((m) => m.a.key === `${askedSession}:main` || (m.a.session === askedSession && m.a.kind === 'main')) ?? null : null;
    const titleOf = (key) => sessions.find((s) => s.key === key)?.title ?? D.labels?.[key] ?? null;
    const openedTitle = opened ? titleOf(askedSession) ?? (opened === mains[0] ? th.title : null) : null;
    // A thread with no title: its first session's label, from what its log records.
    const thName = th.title || D.labels?.[sessions[0]?.key] || 'Untitled session';
    const span = (a2, b2) => `${time(a2, { day: true })} to ${time(b2, { day: HW.dayOf(a2) !== HW.dayOf(b2) })}`;
    // The title, then when and how many sessions, quieter.
    const [name, rest] = multi && opened
      ? [openedTitle ?? thName, ` · ${span(opened.start, opened.end)} · session ${mains.indexOf(opened) + 1} of ${mains.length} in this replay`]
      : [(opened && openedTitle) || thName, ` · ${span(T0, T1)}${multi ? ` · ${mains.length} sessions` : ''}`];
    $('title').innerHTML = `<span class="ttl">${esc(name)}</span><span class="tmeta">${esc(rest)}</span>`;

    // What goes where: one lane per main agent, one per sub-agent, then the harness and git.
    const subs = agents.filter((x) => x.kind !== 'main').sort((p, r) => toT(p.spawnAt ?? p.firstAt) - toT(r.spawnAt ?? r.firstAt));
    instrOf = new Map(events.filter((e) => e.kind === 'delegation-received').map((e) => [e.agent, e]));
    // Git operations the harness recorded on a command (pushes, pull requests), in the Git lane.
    gitOps = events.filter((e) => e.facts?.git && typeof e.facts.git === 'object').map((e) => ({ ...e, __gitop: true, t: e.endT ?? e.t, label: Object.entries(e.facts.git).map(([k, v]) => (k === 'pr' ? `PR ${v?.number ?? ''} ${v?.action ?? ''}` : k === 'commit' ? `commit ${String(v?.sha ?? '').slice(0, 7)}` : k === 'push' ? `push ${v?.branch ?? ''}` : `${k} ${v?.action ?? ''}`).trim()).join(', ') }));
    const all = events.filter((e) => HW.laneOf(e)).concat(gitOps).sort((p, r) => p.t - r.t);
    const laneKeys = new Set(['person', 'harness', 'git', ...agents.map((x) => x.key)]);
    placed = all.map((e) => {
      let lane = e.__gitop ? 'git' : HW.laneOf(e);
      if (!laneKeys.has(lane)) lane = 'harness';
      return { e, lane, sub: e.__gitop ? 'Git operations (harness)' : HW.subOf(e, lane) };
    });
    LANES = [
      { key: 'person', label: 'You' },
      ...mains.map((m, i) => ({ key: m.a.key, label: mainLabel(i), session: multi ? i + 1 : null })),
      ...subs.map((x) => ({ key: x.key, label: `↳ ${HW.agentLabel(x.key)}`, agent: x })),
      { key: 'harness', label: 'Harness' },
      { key: 'git', label: 'Git' },
    ];
    steps = events.filter((e) => !['link', 'mode', 'queue', 'hook', 'quiet'].includes(e.kind)).sort((p, r) => p.t - r.t);
    prompts = steps.filter((e) => e.kind === 'prompt');
    const turns = Array.isArray(D.session?.turns) ? D.session.turns : Array.isArray(D.turns) ? D.turns : [];
    mainTurns = turns.filter((t) => mainKeys.has(t.agent)).sort((p, r) => toT(p.startAt) - toT(r.startAt));
    frames = (Array.isArray(D.frames) ? D.frames : []).map(HW.frameOf).filter((f) => Number.isFinite(f.t)).sort((p, r) => p.t - r.t);

    base = askedThread ?? (isId('thread', th.id) ? th.id : '');
    wire();
    // "Worth a look": the problem findings for this thread's sessions, in a strip above the lanes.
    window.HWS?.mount({
      host: $('wl'),
      badge: $('wlBadge'),
      chart: svg,
      time: (t) => time(t, { day: multiDay, seconds: true }),
      sessions: () => mains.filter((m) => m.a.session).map((m, i) => ({ key: m.a.session, label: multi ? `session ${i + 1}` : 'this session' })),
      eventT: (id) => HW.data.byId.get(id)?.t ?? null,
      // Jump to step: the playhead to it, zoomed in when it's out of view, and its record open.
      jump: (id) => {
        const e = HW.data.byId.get(id);
        if (e && showAt(id, { zoom: false })) HW.announce(HW.describeStepPieces(e));
      },
      zoomTo: (a2, b2) => setView(a2, b2),
      redraw: () => view && render(),
    });
    catalog();
    playhead = ((opened && prompts.find((p) => p.agent === opened.a.key)) || prompts[0])?.t ?? T0;
    view = [T0, T1];
    setView(T0, T1);
    // The strip's findings load once the chart has a view to draw them on.
    if (isId('thread', th.id)) window.HWS?.load({ thread: th.id });
    // Facts (facts.js): plain counts for this replay's sessions, in a closed fold.
    if (isId('thread', th.id)) {
      window.HWFacts?.load({ thread: th.id }, {
        jump: (id) => {
          const e = HW.data.byId.get(id);
          if (e && showAt(id, { zoom: false })) HW.announce(HW.describeStepPieces(e));
        },
      });
    }
    // #<thread>~<event>: open at that step, zoomed to five minutes around it, with its record.
    const at = askedEvent();
    if (at && !showAt(at)) HW.addNote("The step named in the address isn't in this replay.");
    if (!location.hash && base) history.replaceState(null, '', `${location.pathname}${location.search}#${base}`);
    // #<thread>~zoom~<finding key>: zoomed to the finding's steps, only those marked.
    const zk = zoomKey();
    if (zk) await applyZoom(zk, { open: isId('event', hashParts()[3]) ? hashParts()[3] : null });
  });
})();
