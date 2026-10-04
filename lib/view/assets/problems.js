// The Problems page: a researched catalog of known ways AI coding agents go wrong or waste time
// and tokens, joined to the checks that look for each one in this window's sessions. It opens
// with the three to start with (the top of High), then one table of every pattern found, High
// and Medium first, sorted by a stated rule (or by "My priority"); Low, routine notes, the rule
// itself, and the patterns not found, with no check yet, or that a log can't show are each one
// click away. Each row opens to this window's findings with replay links, fix ideas, what the
// pattern looks like, why it matters, how strong the evidence is, how it's detected, and sources.
//
// Data: /api/problems, or /api/problems?session=<key> for one session's findings (the replay
// strip's "and N more" link). The address holds only ids: ?session=<key> and #<pattern id>.
(function () {
  'use strict';
  const { esc, chip, sym, isId } = HW;
  const $ = (id) => document.getElementById(id);
  const full = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0');
  const plural = (n, one, many = `${one}s`) => `${full(n)} ${n === 1 ? one : many}`;
  /** Token counts, short: 1.2M, 340k. */
  const fmt = (n) => {
    if (!Number.isFinite(n)) return '?';
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
    if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
  };
  const pct = (x) => (!Number.isFinite(x) ? '' : x > 0 && x < 0.001 ? 'under 0.1%' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
  const tok = (n) => `<span class="num" title="${esc(full(n))} tokens">${esc(fmt(n))}</span>`;
  const when = (iso) => (iso ? HW.time(Date.parse(iso), { day: true }) : '');
  const PATTERN_ID = /^[a-z][a-z0-9-]{1,60}$/;

  const TIER_LABEL = { high: 'High', medium: 'Medium', low: 'Low', dismissed: 'Not a problem' };
  const RANK = { high: 0, medium: 1, low: 2, dismissed: 3 };
  const STATUS = {
    found: { icon: '■', word: 'Found in your sessions' },
    clear: { icon: '●', word: 'Checked, not found' },
    unchecked: { icon: '○', word: 'No check here yet' },
    undetectable: { icon: '–', word: "Can't be checked from logs" },
  };
  const SEV = { look: { icon: '■', word: 'Worth a look' }, note: { icon: '○', word: 'Routine note' } };
  const STRENGTH = { 'well-established': 'Well established', reported: 'Reported', speculative: 'Speculative' };
  const KINDS = { docs: ['vendor doc', 'vendor docs'], 'user-report': ['user report', 'user reports'], paper: ['paper', 'papers'] };
  const KIND1 = { docs: 'vendor doc', 'user-report': 'user report', paper: 'paper' };
  const FIXKIND = { hook: 'Hook', instruction: 'Instruction', skill: 'Skill change', setting: 'Setting', workflow: 'Workflow' };

  // ?session=<key>: the page narrowed to one session's findings.
  const params = new URLSearchParams(location.search);
  const SESSION = isId('session', params.get('session')) ? params.get('session') : null;

  let D = null;
  let PAT = new Map();
  let GROUP = new Map();
  let prefs = null;
  let group = null;
  let status = null;
  const expanded = new Set();
  const SHOW = 6;
  // Low priority is one click away; one session's view shows it from the start.
  let lowShown = !!SESSION;
  let routineShown = false;

  // ---- links: ids only ---------------------------------------------------------------------
  function replayHref(f, event = f.event) {
    if (!isId('session', f.session)) return null;
    const t = isId('thread', f.thread) ? f.thread : '';
    const e = isId('event', event) ? `~${event}` : '';
    return `replay.html?session=${encodeURIComponent(f.session)}${t || e ? `#${t}${e}` : ''}`;
  }
  const goalHref = (key) => (isId('goal', key) ? `goal.html#${key}` : null);
  /** A source's address, joined from parts the server redacted one by one; none when a part was hidden. */
  const linkOf = (parts) => (Array.isArray(parts) && parts.length && parts.every((x) => typeof x === 'string' && !x.includes('[redacted:')) && /^https:\/\/[A-Za-z0-9.-]+$/.test(parts[0]) ? parts.join('') : null);
  const sessionLabel = (key) => {
    const s = D.sessions?.[key];
    return s?.title ? `“${s.title}”` : 'an untitled session';
  };

  const effective = (p) => window.HWPrefs.effective(prefs, p);
  const tierClass = (t) => (RANK[t] != null ? `t-${t}` : '');

  // ---- one finding -----------------------------------------------------------------------------
  function findingHtml(f) {
    const sev = SEV[f.severity] ?? SEV.note;
    const time = f.at ? `<time datetime="${esc(f.at)}">${esc(when(f.at))}</time>${f.lastAt && f.lastAt !== f.at ? ` to ${esc(when(f.lastAt))}` : ''}` : '<span class="muted">no time in the record</span>';
    const links = [];
    const r = replayHref(f);
    if (r) links.push(`<a href="${esc(r)}">Replay at this step</a>`);
    if (f.related) {
      const rr = replayHref(f, f.related);
      if (rr) links.push(`<a href="${esc(rr)}">${esc(f.relatedLabel ?? 'Replay at the related step')}</a>`);
    }
    for (const g of f.goals ?? []) {
      const gh = goalHref(g.key);
      if (gh) links.push(`<a href="${esc(gh)}">Goal: <span>${esc(g.title ?? 'Untitled goal')}</span></a>`);
    }
    const evs = (f.events ?? []).filter((id) => isId('event', id));
    const steps = evs.length > 1 && r ? `<span class="steps">Steps: ${evs.map((id, i) => `<a href="${esc(replayHref(f, id))}" aria-label="Replay at step ${i + 1} of ${evs.length}">${i + 1}</a>`).join(' ')}${f.steps > evs.length ? ` (the first ${evs.length} of ${f.steps})` : ''}</span>` : '';
    const where = f.session ? `In <span>${esc(sessionLabel(f.session))}</span>` : '';
    return `<li class="finding s-${f.severity === 'look' ? 'look' : 'note'}" data-session="${esc(f.session ?? '')}">
      <div class="fhead"><span class="sev"><span aria-hidden="true">${sev.icon}</span> ${sev.word}</span> ${time} ${chip(f.verdictEvidence)}${Number.isFinite(f.estimate) && f.estimate > 0 ? ` <span class="num">about ${esc(fmt(f.estimate))} tokens</span>` : ''}${f.stillRunning ? ' <span class="tag">may still be running</span>' : ''}</div>
      <p class="fnote">${esc(f.note)}</p>
      ${f.text ? `<p class="ftext"><code>${esc(HW.clip(f.text, 220))}</code></p>` : ''}
      <p class="fmeta">${[where, `From the check “${esc(f.checkTitle ?? f.check)}”`, f.rule ? `Rule: ${esc(f.rule)}` : ''].filter(Boolean).join(' · ')}</p>
      ${links.length || steps ? `<p class="flinks">${links.join(' ')}${steps}</p>` : ''}
    </li>`;
  }

  // ---- the stated rule, the lead, and the three to start with ----------------------------------
  const num = (m) => (m && typeof m === 'object' ? m.value : m) ?? 0;
  function header() {
    const n = D.statusCounts?.found ?? 0;
    const cov = D.coverage ?? {};
    const sessions = Number.isFinite(Number(num(cov.sessions))) ? `${plural(num(cov.sessions), 'session')} ${sym(cov.sessions?.evidence ?? 'derived')} checked against` : 'Your sessions checked against';
    $('lead').innerHTML = `${sessions} ${D.patterns.length} known problems in AI coding agents. ${n} showed up.<span class="fine">A finding is worth a look, never a verdict: each pattern can be legitimate, and no finding says why it happened.</span>`;
    const PR = D.priorityRule;
    $('priRule').innerHTML = PR
      ? `<summary>How priority is set</summary><p>A pattern found in this window gets a tier from a stated rule, never a score. Its impact comes from its catalog group: ${PR.classes.map((c) => `<b>${esc(c.label.toLowerCase())}</b> (${esc(c.text)})`).join(', ')}.</p><ul>${PR.tiers.map((t) => `<li><b>${esc(t.label)}:</b> ${esc(t.text)}.</li>`).join('')}</ul><p>${esc(PR.counts)} ${esc(PR.order)} ${esc(PR.rest)} "My priority" on a row overrides the rule here and on the replay and goal timelines. This browser keeps only the pattern's id and the tier you picked.</p>`
      : '<summary>How priority is set</summary><p>No priority rule came with this answer.</p>';
    if (SESSION) {
      const el = $('sessFilter');
      const fo = D.focus;
      el.hidden = false;
      const r = fo?.thread ? replayHref({ session: SESSION, thread: fo.thread }) : null;
      el.innerHTML = fo && fo.findings
        ? `Showing one session: <span>${esc(fo.title ? `“${fo.title}”` : 'an untitled session')}</span>, ${esc(plural(fo.findings, 'finding'))} (${esc(full(fo.look))} worth a look) in ${esc(plural(fo.patterns, 'pattern'))}. ${r ? `<a href="${esc(r)}">Replay it</a> · ` : ''}<a href="problems.html">Show every session</a>`
        : `No findings for that session in this window${fo?.known ? '' : ': it may be outside the window, display-only or outside your configured repositories'}. <a href="problems.html">Show every session</a>`;
    }
  }
  // Within a tier: tokens measured, then findings worth a look, then how well established it is.
  const cmp = (a, b) => (b.priority?.tokens ?? 0) - (a.priority?.tokens ?? 0) || (b.priority?.look ?? 0) - (a.priority?.look ?? 0) || (a.priority?.strength ?? 9) - (b.priority?.strength ?? 9);
  const fixOf = (p) => (p.draft ? { kind: FIXKIND[p.draft.kind] ?? p.draft.kind, text: p.draft.title, draft: true } : p.mitigation?.[0] ? { kind: FIXKIND[p.mitigation[0].kind] ?? p.mitigation[0].kind, text: p.mitigation[0].action, draft: false } : null);
  /** One of the three to start with: what showed up, one fix idea, and where to see it happen. */
  function startCard(p) {
    const f = (p.findings ?? []).find((x) => x.severity === 'look' && replayHref(x)) ?? null;
    const measure = p.tokens?.tokens > 0
      ? `<b>${tok(p.tokens.tokens)}</b> tokens ${p.tokens.waste ? 'estimated' : 'spent'}${D.coverage?.tokens?.value ? `, ${pct(p.tokens.tokens / D.coverage.tokens.value)} of the window's` : ''} ${chip(p.tokens.evidence)} · ${esc(plural(p.look, 'finding'))} worth a look`
      : `<b class="num">${esc(full(p.look))}</b> worth a look${p.notesFound ? `, plus ${full(p.notesFound)} routine` : ''} ${chip(p.countEvidence ?? 'derived')}`;
    const fix = fixOf(p);
    const e = effective(p);
    return `<article class="scard ${tierClass(e?.tier)}" data-start="${esc(p.id)}">
      <div class="scard-top"><span class="prio ${tierClass(e?.tier)}">${esc(TIER_LABEL[e?.tier] ?? '')}</span><span>${esc(GROUP.get(p.group)?.name ?? p.group)}</span></div>
      <h3>${esc(p.name)}</h3>
      <p class="smeasure">${measure}</p>
      ${f ? `<p class="sx">Example: <span>${esc(sessionLabel(f.session))}</span>, ${esc(when(f.at))}.</p>` : ''}
      ${fix ? `<p class="fix"><b>Fix idea (${esc(String(fix.kind).toLowerCase())}):</b> ${esc(fix.text)}.${fix.draft ? ` <a href="#${esc(p.id)}" data-open="${esc(p.id)}" data-to="draft">Read the draft</a>` : ''}</p>` : ''}
      <div class="acts">${f ? `<a class="btn primary" href="${esc(replayHref(f))}">See it happen</a>` : ''}<a class="btn" href="#${esc(p.id)}" data-open="${esc(p.id)}">Details</a></div>
    </article>`;
  }
  function renderStart() {
    const el = $('startWith');
    const high = D.patterns.filter((p) => effective(p)?.tier === 'high').sort(cmp);
    el.hidden = !!SESSION || !high.length;
    el.innerHTML = el.hidden ? '' : `<h2 id="startH">Start with these</h2><div class="startgrid">${high.slice(0, 3).map(startCard).join('')}</div>`;
  }

  // ---- filters -----------------------------------------------------------------------------------
  const inSession = (p) => !SESSION || (p.findings ?? []).length > 0;
  const shown = () => D.patterns.filter((p) => (!group || p.group === group) && (!status || p.status === status) && inSession(p));
  function renderFilters() {
    const inGroup = (p) => !group || p.group === group;
    const foundAll = D.patterns.filter((p) => p.status === 'found').length;
    $('groups').innerHTML = [
      `<button type="button" class="pgroup" data-group="" aria-pressed="${!group}" title="Every group: ${foundAll} of ${D.patterns.length} found">All<span class="n">${foundAll}</span></button>`,
      ...D.groups.map((g) => {
        const mine = D.patterns.filter((p) => p.group === g.id);
        const f = mine.filter((p) => p.status === 'found').length;
        return `<button type="button" class="pgroup" data-group="${esc(g.id)}" aria-pressed="${group === g.id}" title="${esc(`${g.description} ${f} of ${mine.length} found.`)}">${esc(g.name)}<span class="n">${f}</span><span class="sr"> of ${mine.length} found</span></button>`;
      }),
    ].join('');
    const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, D.patterns.filter((p) => inGroup(p) && p.status === k).length]));
    $('statusFilter').innerHTML = [`<button type="button" data-status="" aria-pressed="${!status}">Any status <span class="n">${D.patterns.filter(inGroup).length}</span></button>`, ...Object.entries(STATUS).map(([k, s]) => `<button type="button" data-status="${k}" aria-pressed="${status === k}"><span class="pstat st-${k}" aria-hidden="true">${s.icon}</span>${esc(s.word)} <span class="n">${counts[k]}</span></button>`)].join('');
  }
  function rerender(sel, host) {
    renderFilters();
    renderCards();
    host.querySelector(sel)?.focus();
    $('announce').textContent = `Showing ${shown().length} of ${D.patterns.length} patterns`;
  }

  // ---- one pattern: a row that opens -------------------------------------------------------------
  function tallyText(p) {
    if (SESSION) return `${plural((p.findings ?? []).length, 'finding')} in this session`;
    if (p.status === 'found') return `${full(p.look)} worth a look${p.notesFound ? `, plus ${full(p.notesFound)} routine` : ''}${p.tokens?.tokens > 0 ? ` · ${p.tokens.waste ? 'est.' : 'spent'} ${fmt(p.tokens.tokens)} tokens` : ''}`;
    if (p.status === 'clear') return 'checked, nothing found';
    if (p.status === 'unchecked') return 'no check here yet';
    return "can't be checked from logs";
  }
  function priHtml(p) {
    const e = effective(p);
    if (!e) return '';
    const tag = `<span class="ptier ${tierClass(e.tier)}">${esc(TIER_LABEL[e.tier])}</span>`;
    if (e.mine) return `<span class="pwhy">${tag} <b>you set this</b> · the rule says ${esc(TIER_LABEL[e.rule].toLowerCase())}: ${esc(p.priority.reason)}</span>`;
    return `<span class="pwhy">${tag} Why ${esc(TIER_LABEL[e.tier].toLowerCase())}: ${esc(p.priority.reason)}</span>`;
  }
  function cardHtml(p) {
    const st = STATUS[p.status] ?? STATUS.unchecked;
    const e = effective(p);
    const mine = e ? `<label class="pmine">My priority <select data-pri="${esc(p.id)}">${['high', 'medium', 'low', 'dismissed'].map((t) => `<option value="${t}"${e.tier === t ? ' selected' : ''}>${esc(TIER_LABEL[t])}${t === e.rule ? " (the rule's)" : ''}</option>`).join('')}</select></label>` : '';
    const prio = e ? `<span class="prio ${tierClass(e.tier)}">${esc(TIER_LABEL[e.tier])}</span>` : `<span class="pstat st-${p.status}" aria-hidden="true">${st.icon}</span>`;
    const known = p.status === 'found' ? (p.countEvidence ? chip(p.countEvidence) : '') : `<span class="muted">${esc(st.word)}</span>`;
    return `<div class="pcw"><details class="pcard" id="${esc(p.id)}" data-pattern="${esc(p.id)}">
      <summary>
        <span class="pprio">${prio}</span>
        <span class="pname"><span class="sr">${esc(st.word)}: </span><span class="ptitle">${esc(p.name)}</span> <span class="kbd">${esc(GROUP.get(p.group)?.name ?? p.group)}</span></span>
        <span class="pfound num tally">${esc(tallyText(p))}</span>
        <span class="pknown">${known}</span>
        <span class="ptoggle" aria-hidden="true"></span>
      </summary>
      ${e ? `<div class="pextra">${priHtml(p)}${mine}</div>` : ''}
      <div class="pbody" data-body></div>
    </details></div>`;
  }
  function bodyHtml(p) {
    const kinds = Object.entries(p.sourceKinds ?? {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${KINDS[k]?.[n === 1 ? 0 : 1] ?? k}`).join(', ');
    const measures = (p.measures ?? []).length
      ? `<p>Counted here by:</p><ul class="mlist">${p.measures.map((m) => `<li><a href="#check-${esc(m.check)}" data-check="${esc(m.check)}">${esc(m.title)}</a> ${chip(m.evidence)} <span class="num">${esc(m.ran ? plural(m.count, 'finding') : 'not run')}</span><br><span class="rel">${esc(m.relation)}</span>${m.ran ? '' : `<br><span class="muted">${esc(m.notRun ?? '')}</span>`}</li>`).join('')}</ul>`
      : p.status === 'undetectable' ? "<p>The catalog says a session log can't show this. It names proxies a later check could use:</p>" : "<p>No check here looks for this yet. The catalog's signal, for a check to come:</p>";
    const level = p.detection.level === 'not-detectable' ? 'Logs alone cannot show it.' : `The most a log check can claim: ${chip(p.detection.level)}`;
    const detect = `${measures}<p><b>The catalog's signal.</b> ${esc(p.detection.summary)} <span class="nowrap">${level}</span></p>
      <details class="rules"><summary>${plural(p.detection.signals.length, 'signal')} and ${plural(p.detection.falsePositives.length, 'known false alarm')}</summary>
        <p class="subhead">Signals</p><ul class="mlist">${p.detection.signals.map((s) => `<li>${esc(s.signal)} ${chip(s.level)}</li>`).join('')}</ul>
        <p class="subhead">Known false alarms</p><ul class="mlist">${p.detection.falsePositives.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </details>`;
    const list = p.findings ?? [];
    const all = expanded.has(p.id);
    const showList = all ? list : list.slice(0, SHOW);
    const listed = p.findingsListed ?? list.length;
    const notes = showList.filter((f) => f.severity !== 'look').length;
    const week = p.status === 'found'
      ? `<p>${SESSION ? `<b>${esc(plural(list.length, 'finding'))} in this session</b>; in all, ` : ''}<b>${esc(plural(p.count, 'finding'))}</b>${p.notesFound ? `, ${full(p.look)} worth a look and ${plural(p.notesFound, 'routine note')}` : ''}.${p.tokens?.tokens > 0 ? ` ${p.tokens.waste ? 'Estimated cost' : 'Spent'}: ${tok(p.tokens.tokens)} tokens${D.coverage?.tokens?.value ? `, ${pct(p.tokens.tokens / D.coverage.tokens.value)} of the window's` : ''} (${esc(p.tokens.label)}) ${chip(p.tokens.evidence)}` : ''} ${p.countEvidence ? `The count is ${chip(p.countEvidence)}: no stronger than the weakest check behind it.` : ''}</p>
         <ol class="findings">${showList.map(findingHtml).join('')}</ol>
         ${notes ? `<p class="routinenote">${routineShown ? `${plural(notes, 'routine note')} shown.` : `${plural(notes, 'routine note')} hidden.`} <button type="button" class="linklike" data-routine>${routineShown ? 'Hide routine notes' : 'Show routine notes'}</button></p>` : ''}
         ${list.length > SHOW ? `<button type="button" class="more" data-more="${esc(p.id)}" aria-expanded="${all}">${all ? `Show the first ${SHOW}` : `Show all ${list.length} listed`}</button>` : ''}
         ${!SESSION && listed > list.length ? `<p class="muted">The first ${full(list.length)} of ${full(listed)} are listed. Open a session's replay strip, or this page for one session, to see the rest.</p>` : ''}`
      : p.status === 'clear' ? '<p class="muted">Checked; nothing found in this window.</p>'
      : p.status === 'unchecked' ? `<p class="muted">Not checked${p.notRun ? `: ${esc(p.notRun)}` : ''}, so this says nothing about whether it happened.</p>`
      : '<p class="muted">Not checkable from logs.</p>';
    const d = p.draft;
    const draft = d ? `<div class="draft" id="draft-${esc(p.id)}" tabindex="-1"><h4>A draft to adopt yourself (not applied): ${esc(d.title)}</h4><p class="dmeta"><span class="tag">${esc(FIXKIND[d.kind] ?? d.kind)}</span> ${esc(d.where)}</p><pre>${esc(d.text)}</pre></div>` : '';
    const sources = `<ol class="srcs">${p.sources.map((s) => {
      const href = linkOf(s.link);
      return `<li>${href ? `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(s.title)}</a>` : `<span>${esc(s.title)}</span> <span class="muted">(its address is hidden by redaction)</span>`} <span class="tag">${esc(KIND1[s.kind] ?? s.kind)}</span> <span class="smeta">${esc(s.date ?? '')}</span>${s.says ? `<span class="says">${esc(s.says)}</span>` : ''}</li>`;
    }).join('')}</ol>`;
    const related = (p.related ?? []).filter((r) => PAT.has(r));
    return `<section><h3>This window</h3>${week}</section>
      <div class="pgrid">
        <section><h3>Fix ideas</h3>${draft}<p class="subhead">From the catalog</p><ul class="mitig">${p.mitigation.map((m) => `<li><span class="tag">${esc(FIXKIND[m.kind] ?? m.kind)}</span> ${esc(m.action)}</li>`).join('')}</ul></section>
        <section><h3>How common it is</h3><p><span class="tag">${esc(STRENGTH[p.strength] ?? p.strength)}</span> ${esc(p.strengthReason)}</p><p class="fine">Known from ${esc(plural(p.sources.length, 'source'))}: ${esc(kinds)}. <a href="#src-${esc(p.id)}" data-src="${esc(p.id)}">Sources</a></p></section>
      </div>
      <div class="pgrid">
        <section><h3>What it looks like</h3><p>${esc(p.looksLike)}</p></section>
        <section><h3>Why it matters</h3><p>${esc(p.whyItMatters)}</p></section>
      </div>
      <h3>How it's detected here</h3>${detect}
      <h3 id="src-${esc(p.id)}" tabindex="-1">Sources</h3><p class="fine">Each opens the published page in a new tab when you click it; this page fetches nothing.</p>${sources}
      ${related.length ? `<p class="related"><b>Related:</b> ${related.map((r) => `<a href="#${esc(r)}" data-open="${esc(r)}">${esc(PAT.get(r).name)}</a>`).join(' ')}</p>` : ''}`;
  }
  function fill(d) {
    const body = d.querySelector('[data-body]');
    if (body && !body.dataset.filled) {
      body.innerHTML = bodyHtml(PAT.get(d.dataset.pattern));
      body.dataset.filled = '1';
    }
  }
  function renderCards() {
    const cards = $('cards');
    const open = new Set([...cards.querySelectorAll('details.pcard[open]')].map((d) => d.id));
    const listsOpen = new Set([...cards.querySelectorAll('details.restlist[open]')].map((d) => d.dataset.list));
    const dismissedOpen = !!cards.querySelector('details.dismissed[open]');
    const list = shown();
    const tierOf = (p) => effective(p)?.tier ?? null;
    const inTier = (t) => list.filter((p) => tierOf(p) === t).sort(cmp);
    const gi = new Map(D.groups.map((g, i) => [g.id, i]));
    const SR = { 'well-established': 0, reported: 1, speculative: 2 };
    const rest = (st) => list.filter((p) => p.status === st).sort((a, b) => gi.get(a.group) - gi.get(b.group) || (SR[a.strength] ?? 3) - (SR[b.strength] ?? 3));
    const tiersShown = !SESSION && (!status || status === 'found');
    const tierSec = (t, label, ps, always) => (ps.length || always
      ? `<section class="tier t-${t}" id="tier-${t}" aria-label="${esc(`${label} priority`)}" data-tier="t-${t}"${t === 'low' && !lowShown ? ' hidden' : ''}><p class="tier-label">${esc(label)} <span class="hcount">${ps.length}</span></p>${ps.length ? ps.map(cardHtml).join('') : '<p class="muted gempty">None in this window.</p>'}</section>`
      : '');
    const listSec = (cls, note, ps) => (ps.length ? `<section class="tier ${cls}" aria-label="${esc(note)}" data-tier="${esc(cls)}"><div class="ghead"><p>${esc(note)}</p></div>${ps.map(cardHtml).join('')}</section>` : '');
    const high = inTier('high');
    const medium = inTier('medium');
    const low = inTier('low');
    const dis = inTier('dismissed');
    const routine = list.filter((p) => p.status === 'found').reduce((n, p) => n + (Number(p.notesFound) || 0), 0);
    const tiers = tierSec('high', 'High', high, tiersShown) + tierSec('medium', 'Medium', medium, tiersShown) + tierSec('low', 'Low', low, tiersShown);
    const lowBtn = low.length ? `<button type="button" class="linklike" data-low aria-expanded="${lowShown}" aria-controls="tier-low">${lowShown ? 'Hide low-priority problems' : `Show ${plural(low.length, 'low-priority problem')}`}</button>` : '';
    const routineBox = routine ? `<label><input type="checkbox" data-routine-all${routineShown ? ' checked' : ''}> Show routine notes (${full(routine)})</label>` : '';
    const lists = [['clear', 'Not found this week', 'Checked, and nothing was found. No priority.'], ['unchecked', 'No check built yet', 'Not looked for, so this says nothing about whether it happened. No priority.'], ['undetectable', "Can't be checked from logs", "The catalog says a session log can't show these. No priority."]]
      .map(([st, title, note]) => {
        const ps = rest(st);
        if (!ps.length) return '';
        const isOpen = status === st || listsOpen.has(st);
        return `<details class="restlist" data-list="${st}"${isOpen ? ' open' : ''}><summary>${esc(title)} <span class="hcount">${ps.length}</span></summary>${listSec(`t-${st}`, note, ps)}</details>`;
      }).join('');
    const html = [
      tiers ? `<div class="pcols" aria-hidden="true"><span>Priority</span><span>Problem</span><span>Found</span><span>How it's known</span><span></span></div>${tiers}` : '',
      lowBtn || routineBox ? `<div class="ptable-foot">${lowBtn}${routineBox}</div>` : '',
      dis.length ? `<details class="tier dismissed"${dismissedOpen ? ' open' : ''}><summary><h2>Not a problem, by you <span class="num hcount">${dis.length}</span></h2><span class="muted">patterns you marked not a problem; set "My priority" to bring one back</span></summary>${dis.map(cardHtml).join('')}</details>` : '',
      lists ? `<div class="restlists">${lists}</div>` : '',
    ].join('');
    cards.innerHTML = html || '<p class="muted gempty">No pattern matches these filters.</p>';
    cards.classList.toggle('show-routine', routineShown);
    for (const id of open) {
      const d = document.getElementById(id);
      if (d) {
        d.setAttribute('open', '');
        fill(d);
      }
    }
    $('foundCount').textContent = String(list.filter((p) => p.status === 'found').length);
    $('filterNote').textContent = `Showing ${list.length} of ${D.patterns.length} patterns${group ? ` in ${GROUP.get(group)?.name ?? group}` : ''}${status ? `, ${STATUS[status].word.toLowerCase()}` : ''}${SESSION ? ', with findings in this session' : ''}.`;
    renderStart();
  }

  // Opening a pattern from a link: make sure the filters show it, then open and scroll to it.
  function openPattern(id, to) {
    const p = PAT.get(id);
    if (!p) return false;
    if ((group && p.group !== group) || (status && p.status !== status) || !inSession(p)) {
      group = null;
      status = null;
      renderFilters();
      renderCards();
    }
    let d = document.getElementById(id);
    if (!d) return false;
    // A low-priority row is one click away: show the low tier first.
    if (d.closest('section.tier[hidden]')) {
      lowShown = true;
      renderCards();
      d = document.getElementById(id);
      if (!d) return false;
    }
    for (let el = d.parentElement; el; el = el.parentElement) if (el.tagName === 'DETAILS') el.setAttribute('open', '');
    d.setAttribute('open', '');
    fill(d);
    const target = to === 'draft' ? document.getElementById(`draft-${id}`) ?? d : d;
    target.scrollIntoView({ block: 'start' });
    (to === 'draft' ? target : d.querySelector('summary'))?.focus({ preventScroll: true });
    return true;
  }

  // ---- how the checks work ------------------------------------------------------------------------
  function checksHtml() {
    const statVal = (s) => (s.unit === 'tokens' ? `${tok(s.value)} tokens` : `<span class="num">${esc(full(s.value))}</span>`);
    const rules = new Map((Array.isArray(D.rules) ? D.rules : []).map((r) => [r.id, r.text]));
    const rulesOf = (c) => [...rules.keys()].filter((id) => c.how.includes(id));
    return `<p class="lead">${D.checks.length} checks read this window's sessions in your configured repositories, in memory. Each keeps fixed words, counts and fingerprints, never text from a log. Display-only and outside sessions aren't checked, as they're left out of lookups and goals.</p>${D.checks.map((c) => {
      const used = rulesOf(c);
      return `<details class="pcheck" id="check-${esc(c.id)}">
        <summary><span class="ptitle">${esc(c.title)}</span> <span class="pmeta">${chip(c.evidence)} <span class="num">${esc(c.ran ? (c.findingsTotal ? plural(c.findingsTotal, 'finding') : 'nothing found') : 'not run')}</span></span></summary>
        <div class="pbody">
          <p><b>Measures.</b> ${(c.patterns ?? []).filter((id) => PAT.has(id)).map((id) => `<a href="#${esc(id)}" data-open="${esc(id)}">${esc(PAT.get(id).name)}</a>`).join(', ')}</p>
          <p><b>How this is known.</b> ${esc(c.how)} Its findings are ${chip(c.evidence)} or weaker, each marked.</p>
          ${c.ran ? `<p><b>Checked.</b> ${esc(c.checked)}</p>` : `<p><b>Not run.</b> ${esc(c.notRun ?? '')}</p>`}
          ${c.stats?.length ? `<ul class="stgrid">${c.stats.map((s) => `<li><span class="sl">${esc(s.label)}</span> <span class="sv">${statVal(s)} ${s.evidence ? chip(s.evidence) : ''}</span></li>`).join('')}</ul>` : ''}
          ${used.length ? `<details class="rules"><summary>The ${used.length === 1 ? 'rule' : `${used.length} rules`} behind it</summary><dl>${used.map((id) => `<dt><code>${esc(id)}</code></dt><dd>${esc(rules.get(id))}</dd>`).join('')}</dl></details>` : ''}
        </div>
      </details>`;
    }).join('')}`;
  }
  function footHtml() {
    const cov = D.coverage ?? {};
    const checked = (D.catalog?.checkedOn ?? []).join(', ');
    return `<h2 class="sh">About this page</h2>
      <p><b>The catalog.</b> ${esc(D.catalog?.about ?? '')} Its ${esc(full(D.catalog?.sources ?? 0))} sources were checked on ${esc(checked || 'the dates the catalog records')}.</p>
      <p><b>Detection is from local logs only.</b> Nothing here calls out to the web or reads anything but the session files this page already read. "No check here yet" means a pattern wasn't looked for, so it says nothing about whether it happened; "can't be checked from logs" means the catalog says a log can't show it.</p>
      <p><b>What the counts cover.</b> ${esc(plural(num(cov.sessions), 'session'))} in your configured repositories with records in this window, ${esc(plural(num(cov.toolCalls), 'tool call'))}${cov.usageRecorded ? ` and ${esc(plural(num(cov.modelCalls), 'model call'))} with token counts (${tok(num(cov.tokens))} tokens in all)` : ', and no token counts, so the checks that measure tokens didn\'t run'}.</p>
      <p><b>How each finding is known.</b> ${chip('recorded')} a log line says it, ${chip('derived')} worked out from records alone, ${chip('inferred')} a named rule decided it and could be wrong. A finding that rests on more than one carries the weakest. Token estimates overlap between checks, so they don't add up to a total.</p>
      <p><b>Fix ideas are drafts.</b> Nothing on this page changes your settings, hooks, skills or instructions.</p>`;
  }

  // ---- wiring ------------------------------------------------------------------------------------
  function wire() {
    $('groups').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-group]');
      if (!b) return;
      group = b.dataset.group || null;
      rerender(`[data-group="${CSS.escape(group ?? '')}"]`, $('groups'));
    });
    $('statusFilter').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-status]');
      if (!b) return;
      status = b.dataset.status || null;
      rerender(`[data-status="${CSS.escape(status ?? '')}"]`, $('statusFilter'));
    });
    const cards = $('cards');
    cards.addEventListener('change', (ev) => {
      if (ev.target.matches?.('[data-routine-all]')) {
        routineShown = ev.target.checked;
        cards.classList.toggle('show-routine', routineShown);
        cards.querySelectorAll('[data-body][data-filled]').forEach((b) => {
          b.innerHTML = bodyHtml(PAT.get(b.closest('details.pcard').dataset.pattern));
        });
        return;
      }
      const sel = ev.target.closest('[data-pri]');
      if (!sel) return;
      const p = PAT.get(sel.dataset.pri);
      if (p) prefs.setTier(p.id, sel.value, p.priority?.tier);
    });
    prefs.onChange(() => {
      const was = document.activeElement?.dataset?.pri;
      // A row moved to Low or to Not a problem stays in sight, with its select still focused.
      const moved = was ? effective(PAT.get(was))?.tier : null;
      if (moved === 'low') lowShown = true;
      renderFilters();
      renderCards();
      if (moved === 'dismissed') $('cards').querySelector('details.dismissed')?.setAttribute('open', '');
      HW.navCount(D.patterns);
      if (was) {
        cards.querySelector(`[data-pri="${CSS.escape(was)}"]`)?.focus();
        const e = effective(PAT.get(was));
        $('announce').textContent = e ? `${PAT.get(was).name}: ${e.tier === 'dismissed' ? 'moved to Not a problem' : `${TIER_LABEL[e.tier]} priority${e.mine ? ', set by you' : ", the rule's"}`}` : '';
      }
    });
    cards.addEventListener('toggle', (ev) => {
      const d = ev.target;
      if (!d.matches?.('details.pcard')) return;
      if (d.open) fill(d);
      const openIds = [...cards.querySelectorAll('details.pcard[open]')].map((x) => x.id).filter((id) => PATTERN_ID.test(id));
      const want = openIds.length === 1 ? `#${openIds[0]}` : '';
      if (location.hash !== want && (want || PAT.has(location.hash.slice(1)))) history.replaceState(null, '', want || `${location.pathname}${location.search}`);
    }, true);
    cards.addEventListener('click', (ev) => {
      // "Show N low-priority problems": the Low tier, one click away.
      const lowBtn = ev.target.closest('[data-low]');
      if (lowBtn) {
        lowShown = !lowShown;
        renderCards();
        $('cards').querySelector('[data-low]')?.focus();
        return;
      }
      // A row's "Show routine notes": the same switch as the one under the table.
      if (ev.target.closest('[data-routine]')) {
        const box = $('cards').querySelector('[data-routine-all]');
        if (box) {
          box.checked = !routineShown;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
      const src = ev.target.closest('a[data-src]');
      if (src) {
        ev.preventDefault();
        const h = document.getElementById(`src-${src.dataset.src}`);
        h?.scrollIntoView({ block: 'start' });
        h?.focus({ preventScroll: true });
        return;
      }
      const b = ev.target.closest('[data-more]');
      if (!b) return;
      const id = b.dataset.more;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      const body = document.getElementById(id)?.querySelector('[data-body]');
      if (!body) return;
      body.innerHTML = bodyHtml(PAT.get(id));
      body.querySelector(`[data-more="${CSS.escape(id)}"]`)?.focus();
    });
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[data-open]');
      if (a) {
        ev.preventDefault();
        const id = a.dataset.open;
        if (!PATTERN_ID.test(id)) return;
        if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
        openPattern(id, a.dataset.to);
        return;
      }
      const c = ev.target.closest('a[data-check]');
      if (c) {
        ev.preventDefault();
        const d = document.getElementById(`check-${c.dataset.check}`);
        if (!d) return;
        $('checksBox').setAttribute('open', '');
        d.setAttribute('open', '');
        d.scrollIntoView({ block: 'start' });
        d.querySelector('summary')?.focus({ preventScroll: true });
      }
    });
    const readHash = () => {
      const id = location.hash.slice(1);
      if (PATTERN_ID.test(id) && PAT.has(id)) openPattern(id);
    };
    window.addEventListener('hashchange', readHash);
    window.addEventListener('popstate', readHash);
    readHash();
  }

  HW.start(async () => {
    D = await HW.load('problems', SESSION ? { session: SESSION } : {});
    if (!D || !Array.isArray(D.patterns)) {
      HW.fatal("This page's data couldn't be read.");
      return;
    }
    PAT = new Map(D.patterns.map((p) => [p.id, p]));
    GROUP = new Map((D.groups ?? []).map((g) => [g.id, g]));
    prefs = window.HWPrefs.createPrefs();
    prefs.setKnown(D.patterns.map((p) => p.id));
    header();
    renderFilters();
    renderCards();
    HW.navCount(D.patterns);
    $('checks').innerHTML = checksHtml();
    $('foot').innerHTML = footHtml();
    wire();
  });
})();
