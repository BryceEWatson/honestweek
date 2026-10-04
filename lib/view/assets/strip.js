// "Worth a look": the Problems page's findings on the replay and goal timelines, in a thin strip
// above the lanes. Off until asked, never silent: a badge in the page head always counts what's
// there for the sessions on screen ("2 high, 1 medium worth a look"), and a switch (kept in this
// browser by prefs.js, with nothing else) shows the strip. A finding is a dot at its moment, or
// a faint band when it covers a stretch; filled is worked out from the log's facts (derived or
// recorded), hollow is a rule's best guess (inferred) or a record the check expected and didn't
// find (missing), and its colour and word are its pattern's
// priority (the stated rule's, or "My priority"). Dots too close to read merge into a count that
// splits as you zoom in. Each mark is a button: a card says the pattern, what the log shows, how
// it's known, one fix idea, and offers Jump to step and the pattern's card on the Problems page.
// Needs common.js and prefs.js loaded first.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const chip = window.HWE.chip;
  const MAX = 12; // marks drawn per session: high first, then medium, highest cost first
  const H = 30;
  const DOT_Y = 11;
  const RANK = { high: 0, medium: 1, low: 2, dismissed: 3 };
  const LABEL = { high: 'High', medium: 'Medium', low: 'Low', dismissed: 'Not a problem' };
  const COLOR = { high: 'var(--critical)', medium: 'var(--serious)', low: 'var(--other)', dismissed: 'var(--muted)' };
  const PATTERN_ID = /^[a-z][a-z0-9-]{1,60}$/;
  const fmt = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
  };

  let O = null;
  let prefs = null;
  let A = null; // the answer for the sessions on screen
  let failed = null;
  let PAT = new Map();
  let sessions = [];
  let items = [];
  let units = [];
  let drawn = new Set();
  let drawnItems = new Set();
  let byEvent = new Map();
  let sc = null;
  let active = null;
  let card = null;
  let returnFocus = null;
  const el = {};

  const isFact = (f) => f.verdictEvidence === 'derived' || f.verdictEvidence === 'recorded';
  const howWord = (fact, level) => (fact ? "worked out from the log's facts" : level === 'missing' ? "a record it expected isn't in the logs" : "a rule's best guess");
  /** The weakest level among a mark's findings that aren't facts: missing, else inferred. */
  const weakLevel = (i) => (i.members.some((m) => m.f.verdictEvidence === 'missing') ? 'missing' : 'inferred');
  const effective = (p) => window.HWPrefs.effective(prefs, p);

  /** Every finding for the sessions on screen, with its tier, its moment and, for a stretch, its end. */
  function collect() {
    sessions = O.sessions();
    items = [];
    const want = new Set(sessions.map((s) => s.key));
    for (const f of A?.findings ?? []) {
      const p = PAT.get(f.pattern);
      const eff = effective(p);
      if (!eff || !want.has(f.session)) continue;
      const known = O.eventT(f.event);
      const t = known ?? Date.parse(f.at);
      if (!Number.isFinite(t)) continue;
      const end = f.lastAt && f.lastAt !== f.at ? Date.parse(f.lastAt) : null;
      const s = sessions.find((x) => x.key === f.session);
      items.push({ k: items.length, f, p, s, tier: eff.tier, mine: eff.mine, t, end: end > t ? end : null, fact: isFact(f), look: f.severity === 'look', known: known != null });
    }
    // Marks: a point finding is one dot; one pattern's stretches in a session merge where they
    // overlap, and a context-size stretch (one per agent) merges into a single band per session.
    units = [];
    const unit = (members, end) => {
      const m = members[0];
      units.push({ k: units.length, members, f: m.f, p: m.p, s: m.s, tier: m.tier, mine: m.mine, t: m.t, end, known: m.known, fact: members.every((x) => x.fact), estimate: members.reduce((n, x) => n + (Number.isFinite(x.f.estimate) ? x.f.estimate : 0), 0) });
    };
    for (const s of sessions) {
      const byPat = new Map();
      for (const i of items) if (i.s === s && i.look && i.tier !== 'dismissed') (byPat.get(i.p.id) ?? byPat.set(i.p.id, []).get(i.p.id)).push(i);
      for (const list of byPat.values()) {
        list.sort((a, b) => a.t - b.t);
        const whole = list.some((i) => i.end && i.f.check === 'long-sessions');
        const spans = [];
        let cur = null;
        for (const i of list) {
          if (!i.end) {
            unit([i], null);
            continue;
          }
          if (cur && (whole || i.t <= cur.end)) {
            cur.members.push(i);
            cur.end = Math.max(cur.end, i.end);
          } else {
            cur = { members: [i], end: i.end };
            spans.push(cur);
          }
        }
        for (const g of spans) unit(g.members, g.end);
      }
    }
    // The cap counts marks, not findings: high first, then medium, so medium shows when there's room.
    drawn = new Set();
    drawnItems = new Set();
    byEvent = new Map();
    const rank = (a, b) => RANK[a.tier] - RANK[b.tier] || b.estimate - a.estimate || a.t - b.t;
    const low = prefs.low;
    for (const s of sessions) {
      const mine = units.filter((u) => u.s === s);
      mine.filter((u) => u.tier !== 'low').sort(rank).slice(0, MAX).forEach((u) => drawn.add(u));
      if (low) mine.filter((u) => u.tier === 'low').sort(rank).slice(0, MAX).forEach((u) => drawn.add(u));
    }
    for (const u of drawn) u.members.forEach((i) => drawnItems.add(i));
    for (const i of items) if (i.look && i.tier !== 'dismissed') (byEvent.get(i.f.event) ?? byEvent.set(i.f.event, []).get(i.f.event)).push(i);
  }

  function counts() {
    const c = { high: 0, medium: 0, low: 0, dismissed: 0, notes: 0 };
    for (const i of items) {
      if (i.tier === 'dismissed') c.dismissed++;
      else if (!i.look) c.notes++;
      else c[i.tier]++;
    }
    return c;
  }
  const whose = () => (sessions.length === 1 ? 'this session' : `these ${sessions.length} sessions`);
  function badgeText() {
    if (failed) return { text: "Problem checks couldn't load", title: failed, n: 0 };
    if (!A) return { text: 'Checking for problems…', title: 'Reading the problem checks for the sessions on screen.', n: 0 };
    const c = counts();
    const parts = ['high', 'medium', 'low'].filter((t) => c[t]).map((t) => `${c[t]} ${t}`);
    const extra = [c.notes ? `${c.notes} routine ${c.notes === 1 ? 'note' : 'notes'}` : '', c.dismissed ? `${c.dismissed} in patterns you marked not a problem` : ''].filter(Boolean).join(', ');
    return {
      text: parts.length ? `${parts.join(', ')} worth a look` : 'Nothing worth a look',
      title: `Problem findings for ${whose()}, by their pattern's priority.${extra ? ` Not counted: ${extra}.` : ''} ${prefs.strip ? 'Shown on the timeline below.' : 'Press to show them on the timeline.'}`,
      n: parts.length,
    };
  }

  /** mount(opts): the page's chart and its hooks. opts: { host, badge, chart, time(t), sessions(),
   *  eventT(id), jump(id), zoomTo(a, b), redraw() }. */
  function mount(opts) {
    O = opts;
    prefs = window.HWPrefs.createPrefs();
    O.host.classList.add('wl');
    O.host.innerHTML = '<div class="wl-row"><svg class="wl-svg" id="wlSvg" role="group" aria-label="Findings worth a look, each at its moment. Each is a button."></svg><button type="button" class="wl-toggle" id="wlToggle" aria-controls="wlSvg"></button><span class="wl-off" id="wlOff"></span></div><div class="wl-foot" id="wlFoot"></div>';
    el.svg = O.host.querySelector('#wlSvg');
    el.toggle = O.host.querySelector('#wlToggle');
    el.off = O.host.querySelector('#wlOff');
    el.foot = O.host.querySelector('#wlFoot');
    O.badge.innerHTML = '<button type="button" class="wl-badge" id="wlBadgeBtn" aria-controls="wlSvg"></button>';
    el.badge = O.badge.querySelector('button');
    const flip = (v) => {
      prefs.strip = v;
      if (!v) closeCard(false);
    };
    el.toggle.addEventListener('click', () => flip(!prefs.strip));
    el.badge.addEventListener('click', () => {
      if (!prefs.strip) flip(true);
      O.host.scrollIntoView({ block: 'nearest' });
      el.toggle.focus({ preventScroll: true });
    });
    el.foot.addEventListener('change', (ev) => {
      if (ev.target.matches('[data-low]')) prefs.low = ev.target.checked;
    });
    const act = (target) => {
      const k = target.dataset.k;
      if (k != null) return openCard(units[Number(k)], target);
      const c = target.dataset.c;
      if (c != null) return cluster(c.split(',').map((x) => units[Number(x)]), target);
      return null;
    };
    el.svg.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-k], [data-c]');
      if (t) act(t);
    });
    el.svg.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const t = ev.target.closest('[data-k], [data-c]');
      if (!t) return;
      ev.preventDefault();
      ev.stopPropagation();
      act(t);
    });
    // The mark in hand outlines its step in the lanes.
    const hover = (ev) => {
      if (card) return;
      const k = ev.target.closest?.('[data-k]')?.dataset.k;
      active = k != null ? units[Number(k)] : null;
      outline();
    };
    el.svg.addEventListener('mouseover', hover);
    el.svg.addEventListener('focusin', hover);
    el.svg.addEventListener('mouseleave', () => {
      if (!card) {
        active = null;
        outline();
      }
    });
    el.svg.addEventListener('focusout', () => {
      if (!card) {
        active = null;
        outline();
      }
    });
    // Escape closes the card before the page's own Escape (zoom out) hears it.
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && card) {
        ev.preventDefault();
        ev.stopPropagation();
        closeCard(true);
      }
    }, true);
    document.addEventListener('mousedown', (ev) => {
      if (card && !card.contains(ev.target) && !ev.target.closest?.('#wlSvg')) closeCard(false);
    });
    prefs.onChange(() => {
      if (!A) return O.redraw();
      collect();
      O.redraw();
    });
  }

  /** Load the findings for the sessions on screen: { thread } on the replay page, { goal } on the goal page. */
  async function load(params) {
    A = null;
    failed = null;
    closeCard(false);
    O.redraw();
    try {
      const a = await HW.load('problems', params);
      A = a && Array.isArray(a.findings) ? a : { findings: [], patterns: [] };
    } catch (err) {
      if (err?.code === 'shown') return;
      failed = `The problem checks couldn't be read: ${err?.message ?? err}`;
      A = null;
    }
    PAT = new Map((A?.patterns ?? []).filter((p) => PATTERN_ID.test(p.id)).map((p) => [p.id, p]));
    // The whole catalog's ids, never only this page's: an override for a pattern with no finding
    // here must stay.
    if (Array.isArray(A?.catalogIds)) prefs.setKnown(A.catalogIds);
    if (A) collect();
    O.redraw();
  }

  /** Called by the page after each draw of its chart, with the chart's own time scale. */
  function render(scale) {
    if (!O) return;
    sc = scale;
    const on = prefs.strip;
    const b = badgeText();
    el.badge.textContent = b.text;
    el.badge.title = b.title;
    el.badge.classList.toggle('none', !b.n);
    el.toggle.textContent = `${on ? '▾' : '▸'} Worth a look`;
    el.toggle.setAttribute('aria-pressed', String(on));
    el.toggle.style.maxWidth = `${Math.max(90, sc.LEFT - 10)}px`;
    el.off.style.left = `${sc.LEFT}px`;
    el.off.hidden = on;
    el.svg.style.visibility = on ? 'visible' : 'hidden';
    el.foot.classList.toggle('off', !on);
    if (!on) {
      el.off.textContent = A ? (b.n ? `${b.text} for ${whose()}. Off until you show them.` : `Nothing worth a look in ${whose()}.`) : b.text;
      el.svg.innerHTML = '';
      el.foot.innerHTML = '';
      active = null;
      outline();
      return;
    }
    const { x, v0, v1, W, LEFT } = sc;
    const keep = document.activeElement?.closest?.('#wlSvg [data-k], #wlSvg [data-c]');
    const keepKey = keep ? (keep.dataset.k != null ? `[data-k="${keep.dataset.k}"]` : `[data-c="${keep.dataset.c}"]`) : null;
    const clipX = (px) => Math.max(LEFT, Math.min(W - 10, px));
    const list = units.filter((u) => drawn.has(u));
    const bands = [];
    const dots = [];
    for (const i of list) {
      if (i.end && x(i.end) - x(i.t) >= 8) {
        if (i.end >= v0 && i.t <= v1) bands.push(i);
      } else if (i.t >= v0 && i.t <= v1) dots.push({ i, px: x(i.t) });
    }
    dots.sort((a, c) => a.px - c.px);
    // Dots closer than a dot's width merge into a count; zooming in pulls them apart.
    const groups = [];
    for (const d of dots) {
      const g = groups[groups.length - 1];
      if (g && d.px - g.x1 < 13 && d.px - g.x0 < 30) {
        g.list.push(d);
        g.x1 = d.px;
      } else groups.push({ list: [d], x0: d.px, x1: d.px });
    }
    const when = (i) => `${O.time(i.t)}${i.end ? ` to ${O.time(i.end)}` : ''}`;
    const label = (i) => `Worth a look, ${LABEL[i.tier].toLowerCase()} priority${i.mine ? ' (you set this)' : ''}: ${i.p.name}, ${when(i)}${sessions.length > 1 ? `, ${i.s.label}` : ''}${i.members.length > 1 ? `, ${i.members.length} findings merged` : ''}. ${howWord(i.fact, weakLevel(i))}.`;
    let s = '';
    for (const i of bands) {
      const a = clipX(x(i.t));
      const w = Math.max(3, clipX(x(i.end)) - a);
      const c = COLOR[i.tier];
      s += `<g class="wl-band" data-k="${i.k}" tabindex="0" role="button" aria-label="${esc(label(i))}"><rect x="${a}" y="2" width="${w}" height="${H - 4}" fill="${c}" opacity="${i.fact ? 0.12 : 0.06}"/><rect class="wl-bar" x="${a}" y="${H - 7}" width="${w}" height="4" rx="2" fill="${i.fact ? c : 'var(--surface)'}" stroke="${c}" stroke-width="1.2"${i.fact ? '' : ' stroke-dasharray="3 2"'}/><title>${esc(label(i))}</title></g>`;
    }
    for (const g of groups) {
      if (g.list.length === 1) {
        const { i, px } = g.list[0];
        const c = COLOR[i.tier];
        s += `<g class="wl-dot" data-k="${i.k}" tabindex="0" role="button" aria-label="${esc(label(i))}"><circle cx="${px}" cy="${DOT_Y}" r="9" fill="transparent"/><circle class="wl-mark" cx="${px}" cy="${DOT_Y}" r="5" fill="${i.fact ? c : 'var(--surface)'}" stroke="${c}" stroke-width="${i.fact ? 1 : 1.8}"/><title>${esc(label(i))}</title></g>`;
        continue;
      }
      const top = g.list.map((d) => d.i).sort((a, c) => RANK[a.tier] - RANK[c.tier])[0];
      const by = ['high', 'medium', 'low'].map((t) => [t, g.list.filter((d) => d.i.tier === t).length]).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).join(', ');
      const text = `${g.list.length} findings worth a look here (${by}). Press to zoom in, or to list them when they share a moment.`;
      const cx = (g.x0 + g.x1) / 2;
      s += `<g class="wl-bubble" data-c="${g.list.map((d) => d.i.k).join(',')}" tabindex="0" role="button" aria-label="${esc(text)}"><circle class="wl-mark" cx="${cx}" cy="${DOT_Y}" r="8.5" fill="var(--raised)" stroke="${COLOR[top.tier]}" stroke-width="1.8"/><text x="${cx}" y="${DOT_Y + 3.5}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--ink)" aria-hidden="true">${g.list.length}</text><title>${esc(text)}</title></g>`;
    }
    if (!list.length) s += `<text x="${LEFT + 4}" y="${DOT_Y + 4}" font-size="12" fill="var(--muted)">${esc(A ? `Nothing ${prefs.low ? '' : 'high or medium '}worth a look in ${whose()}.` : b.text)}</text>`;
    else if (!bands.length && !dots.length) s += `<text x="${LEFT + 4}" y="${DOT_Y + 4}" font-size="12" fill="var(--muted)">None in this stretch; zoom out to see ${list.length}.</text>`;
    el.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    el.svg.innerHTML = s;
    if (keepKey) el.svg.querySelector(keepKey)?.focus({ preventScroll: true });
    foot();
    outline();
  }

  const swatch = (cls, filled) => `<span class="wl-sw ${cls}${filled ? ' filled' : ''}" aria-hidden="true"></span>`;
  function foot() {
    const legend = `<span class="wl-legend">${swatch('', true)}worked out from the log's facts</span><span class="wl-legend">${swatch('', false)}a rule's best guess, or a record that's missing</span><span class="wl-legend"><span class="wl-sw band" aria-hidden="true"></span>a stretch</span><span class="wl-legend">${['high', 'medium', 'low'].map((t) => `${swatch(`t-${t}`, true)}${LABEL[t]}`).join(' ')}</span>`;
    // What isn't drawn, per session: low ones, routine notes, past the cap; dismissed ones apart.
    const rest = sessions.map((s) => ({ s, n: items.filter((i) => i.s === s && i.tier !== 'dismissed' && !drawnItems.has(i)).length, gone: items.filter((i) => i.s === s && i.tier === 'dismissed').length }));
    const total = rest.reduce((m, r) => m + r.n, 0);
    const gone = rest.reduce((m, r) => m + r.gone, 0);
    const href = (k) => (HW.isId('session', k) ? `problems.html?session=${encodeURIComponent(k)}` : 'problems.html');
    let more = '';
    if (total) {
      more = sessions.length === 1
        ? `<a href="${esc(href(sessions[0].key))}">and ${total} more in Problems</a>`
        : `and ${total} more: ${rest.filter((r) => r.n).map((r) => `<a href="${esc(href(r.s.key))}">${esc(r.s.label)}, ${r.n}</a>`).join(' · ')}`;
    } else if (items.length) more = 'Every finding here is shown.';
    if (gone) more += ` <span class="kbd">${gone} hidden: you marked their pattern not a problem.</span>`;
    const lows = items.filter((i) => i.look && i.tier === 'low').length;
    const low = lows ? `<label class="kbd"><input type="checkbox" data-low${prefs.low ? ' checked' : ''}> Show low (${lows})</label>` : '';
    el.foot.innerHTML = `${legend}<span class="wl-more">${more}</span>${low}`;
  }

  function outline() {
    if (!O) return;
    O.chart.querySelectorAll('.wl-target').forEach((m) => m.classList.remove('wl-target'));
    if (!prefs?.strip || !active?.f?.event) return;
    O.chart.querySelectorAll(`[data-id="${CSS.escape(active.f.event)}"]`).forEach((m) => m.classList.add('wl-target'));
  }

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = card.offsetWidth;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - 40, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + card.offsetHeight > window.innerHeight - 8 && r.top - card.offsetHeight - 6 > 8) top = r.top - card.offsetHeight - 6;
    card.style.left = `${left + window.scrollX}px`;
    card.style.top = `${top + window.scrollY}px`;
  }
  function shell(html, anchor) {
    closeCard(false);
    returnFocus = anchor;
    card = document.createElement('div');
    card.className = 'wl-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'wlCardH');
    card.tabIndex = -1;
    card.innerHTML = html;
    document.body.appendChild(card);
    place(anchor);
    card.querySelector('[data-close]').addEventListener('click', () => closeCard(true));
    card.focus({ preventScroll: true });
  }
  function closeCard(refocus) {
    if (!card) return;
    card.remove();
    card = null;
    active = null;
    outline();
    const back = returnFocus;
    returnFocus = null;
    if (refocus && back) {
      // The strip may have been drawn again since: focus the same finding's mark.
      const k = back.dataset?.k;
      const again = k != null ? el.svg.querySelector(`[data-k="${k}"]`) : back.dataset?.c != null ? el.svg.querySelector(`[data-c="${back.dataset.c}"]`) : null;
      (again ?? (document.contains(back) ? back : el.toggle)).focus({ preventScroll: true });
    }
  }

  function openCard(i, anchor) {
    if (!i) return;
    const p = i.p;
    const f = i.f;
    const n = i.members.length;
    const eff = effective(p);
    const why = i.tier === 'dismissed' ? '' : `<dt>Why ${esc(LABEL[i.tier].toLowerCase())}</dt><dd>${i.mine ? `You set this. The rule says ${esc(LABEL[eff.rule].toLowerCase())}: ${esc(p.priority?.reason ?? '')}.` : `${esc(p.priority?.reason ?? '')}.`}</dd>`;
    const patHref = PATTERN_ID.test(p.id) ? `problems.html#${p.id}` : 'problems.html';
    shell(`<div class="wl-card-h"><h3 id="wlCardH">${esc(p.name)}</h3><button type="button" class="wl-x" data-close aria-label="Close">×</button></div>
      <p class="wl-meta"><span class="wl-pri t-${esc(i.tier)}">${esc(LABEL[i.tier])}</span>${i.mine ? ' <span class="kbd">you set this</span>' : ''} · ${esc(O.time(i.t))}${i.end ? ` to ${esc(O.time(i.end))}` : ''}${sessions.length > 1 ? ` · ${esc(i.s.label)}` : ''}</p>
      <dl>
        <dt>What the log shows here</dt><dd>${n > 1 ? `${n} findings in this stretch, merged into one band. The first: ` : ''}${esc(f.note || f.checkTitle)}${i.estimate > 0 ? ` <span class="kbd">(about ${esc(fmt(i.estimate))} tokens${n > 1 ? ' across them' : ''}, estimated)</span>` : ''}</dd>
        <dt>How it's known</dt><dd>${chip(i.fact ? f.verdictEvidence : weakLevel(i))} ${esc(howWord(i.fact, weakLevel(i)))}${n > 1 && !i.fact ? ' (the weakest of them)' : ''}, from the check “${esc(f.checkTitle)}”</dd>
        ${p.fix ? `<dt>One fix idea</dt><dd>${esc(p.fix)}</dd>` : ''}
        ${why}
      </dl>
      <div class="wl-actions"><button type="button" data-jump${i.known ? '' : ' disabled'}>Jump to ${n > 1 ? 'where it starts' : 'step'}</button><a href="${esc(patHref)}">The pattern, its fixes and sources</a></div>
      ${i.known ? '' : "<p class=\"kbd\">This step isn't among the records loaded here.</p>"}`, anchor);
    active = i;
    outline();
    card.querySelector('[data-jump]').addEventListener('click', () => {
      closeCard(true);
      O.jump(f.event);
    });
  }

  // A count that can't split further (one moment, or zoomed all the way in) lists its findings.
  function cluster(list, anchor) {
    const ts = list.map((i) => i.t);
    const a = Math.min(...ts);
    const b = Math.max(...ts);
    if (b - a >= 2000 && sc && sc.v1 - sc.v0 > 25e3) {
      const pad = Math.max(10e3, (b - a) * 0.25);
      return O.zoomTo(a - pad, b + pad);
    }
    shell(`<div class="wl-card-h"><h3 id="wlCardH">${list.length} findings at this moment</h3><button type="button" class="wl-x" data-close aria-label="Close">×</button></div>
      <ul class="wl-list">${list.sort((x, y) => RANK[x.tier] - RANK[y.tier]).map((i) => `<li><button type="button" data-open="${i.k}"><span class="wl-pri t-${esc(i.tier)}">${esc(LABEL[i.tier])}</span> ${esc(i.p.name)} <span class="kbd">${esc(O.time(i.t))}</span></button></li>`).join('')}</ul>`, anchor);
    card.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => openCard(units[Number(btn.dataset.open)], anchor)));
    return null;
  }

  /** For a screen reader's step line: " Worth a look: <pattern>." when a finding points at this step. */
  function note(eventId) {
    if (!prefs?.strip) return '';
    const l = byEvent.get(eventId);
    if (!l?.length) return '';
    return ` Worth a look: ${[...new Set(l.map((i) => i.p.name))].join('; ')}.`;
  }

  /** For the record panel: a box per pattern with a finding worth a look at this step, while the strip is on. */
  function recordNote(eventId) {
    if (!prefs?.strip) return '';
    const l = byEvent.get(eventId);
    if (!l?.length) return '';
    const seen = new Set();
    return l.filter((i) => !seen.has(i.p.id) && seen.add(i.p.id)).map((i) => {
      const patHref = PATTERN_ID.test(i.p.id) ? `problems.html#${i.p.id}` : 'problems.html';
      return `<div class="wl-rec t-${esc(i.tier)}"><p class="wl-rec-h"><span class="prio t-${esc(i.tier)}">${esc(LABEL[i.tier])}</span> <strong>${esc(i.p.name)}</strong></p><p>${esc(i.f.note || i.f.checkTitle)}</p><p class="kbd">${chip(i.fact ? i.f.verdictEvidence : 'inferred')} ${esc(howWord(i.fact))}, from the check “${esc(i.f.checkTitle)}”</p>${i.p.fix ? `<p><b>Fix idea:</b> ${esc(i.p.fix)}</p>` : ''}<a href="${esc(patHref)}">The pattern, its fixes and sources</a></div>`;
    }).join('');
  }

  window.HWS = { mount, load, render, note, recordNote, refresh: () => O && A && collect() };
})();
