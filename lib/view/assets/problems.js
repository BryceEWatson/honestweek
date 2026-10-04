// The Problems page, and the page `honestweek view` opens on: where this window's sessions went
// wrong. It joins a researched catalog of known ways AI coding agents go wrong or waste time and
// tokens to the checks that look for each one, and lists what showed up.
//
// The main list holds only findings worked out from the log (recorded or derived). Claims not
// backed (a done claim with no check after the last edit, a success claim the output doesn't
// show) come first, then the rest by the stated rule; "My priority" overrides either per pattern
// (HWPrefs.order). Findings that rest on a rule's guess or a missing record sit under one closed
// "Possible" fold that says how many and why. Low priority, routine notes, the rule itself, how
// the checks work, and the patterns not found are each one click away.
//
// Each row opens to a copy-ready fix (the catalog's draft, copied exactly, with where it goes in
// Codex and a Codex version to copy where one exists), a suggested prompt that should trigger
// the problem, this window's findings with replay links, and a closed fold
// with the rest of the catalog's text. Each row shows its trend: findings worth a look in this
// window against the window of the same length just before it, each count with how it's known.
// A pattern with a check shows a small Codex marker (runs, partial or not yet, from the
// catalog's coverage), and its reason is behind "?" in the opened row.
//
// Data: /api/problems, /api/problems?trend=1 for the trend, or /api/problems?session=<key> for
// one session's findings (the replay strip's "and N more" link). The address holds only ids:
// ?session=<key> and #<pattern id>. "Zoom to these steps" opens the replay at
// #<thread>~zoom~<finding key>; following any replay link first notes where this page was (in the
// history entry), so Back comes to the same place.
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
  const { pct } = HW;
  const OVER = "more than all the window's tokens, since estimates for neighbouring steps overlap";
  const tok = (n) => `<span class="num" title="${esc(full(n))} tokens">${esc(fmt(n))}</span>`;
  const when = (iso) => (iso ? HW.time(Date.parse(iso), { day: true }) : '');
  const PATTERN_ID = /^[a-z][a-z0-9-]{1,60}$/;

  const TIER_LABEL = { high: 'High', medium: 'Medium', low: 'Low', dismissed: 'Not a problem' };
  const RANK = { high: 0, medium: 1, low: 2, dismissed: 3 };
  const STATUS = {
    found: { icon: '■', word: 'Found in your sessions' },
    clear: { icon: '●', word: 'Checked, not found' },
    unchecked: { icon: '○', word: 'Not checked' },
    undetectable: { icon: '–', word: "Can't be checked from logs" },
  };
  const SEV = { look: { icon: '■', word: 'Worth a look' }, note: { icon: '○', word: 'Routine note' } };
  const STRENGTH = { 'well-established': 'Well established', reported: 'Reported', speculative: 'Speculative' };
  const KINDS = { docs: ['vendor doc', 'vendor docs'], 'user-report': ['user report', 'user reports'], paper: ['paper', 'papers'] };
  const KIND1 = { docs: 'vendor doc', 'user-report': 'user report', paper: 'paper' };
  const FIXKIND = { hook: 'Hook', instruction: 'Instruction', skill: 'Skill change', setting: 'Setting', workflow: 'Workflow' };
  // Whether a pattern's check runs on an agent's logs, from the catalog's coverage.
  const COVER = { runs: { icon: '✓', word: 'runs' }, partial: { icon: '◐', word: 'partial' }, 'not yet': { icon: '✕', word: 'not yet' } };
  const coverOf = (p, agent) => p.coverage?.[agent] ?? null;
  const SURE = new Set(['recorded', 'derived']);
  const isSure = (f) => SURE.has(f.verdictEvidence);
  const HIDDEN = /\[redacted:[a-z]+\]/;

  // ?session=<key>: the page narrowed to one session's findings.
  const params = new URLSearchParams(location.search);
  const SESSION = isId('session', params.get('session')) ? params.get('session') : null;

  let D = null;
  let PAT = new Map();
  let GROUP = new Map();
  let prefs = null;
  let group = null;
  let status = null;
  let TREND = null; // { trend, earlier } once /api/problems?trend=1 answers; false when it couldn't
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
  const FINDING_KEY = /^pf-[a-p]{12}$/;
  /** The replay zoomed to the steps a finding's check recorded, in the thread of its first lane
   *  that's the finding's own, or its first lane. */
  function zoomHref(f) {
    const z = f.zoom;
    if (!z || !FINDING_KEY.test(f.key ?? '') || !Array.isArray(z.lanes) || !z.lanes.length) return null;
    const lane = z.lanes.find((l) => l.thread === f.thread) ?? z.lanes[0];
    if (!isId('session', lane.session) || !isId('thread', lane.thread)) return null;
    return `replay.html?session=${encodeURIComponent(lane.session)}#${lane.thread}~zoom~${f.key}`;
  }
  const zoomCount = (f) => {
    const n = f.zoom?.events?.length ?? 0;
    return f.zoom?.total != null && f.zoom.total > n ? `${full(n)} of ${plural(f.zoom.total, 'step')} recorded` : plural(n, 'step');
  };
  const goalHref = (key) => (isId('goal', key) ? `goal.html#${key}` : null);
  /** A source's address, joined from parts the server redacted one by one; none when a part was hidden. */
  const linkOf = (parts) => (Array.isArray(parts) && parts.length && parts.every((x) => typeof x === 'string' && !x.includes('[redacted:')) && /^https:\/\/[A-Za-z0-9.-]+$/.test(parts[0]) ? parts.join('') : null);
  const sessionLabel = (key) => {
    const s = D.sessions?.[key];
    return s?.title ? `“${s.title}”` : 'an untitled session';
  };

  const effective = (p) => window.HWPrefs.effective(prefs, p);
  const tierClass = (t) => (RANK[t] != null ? `t-${t}` : '');
  /** A closed "?" fold: the reasoning behind something on the line, off the page until asked. */
  const why = (label, html) => `<details class="fwhy"><summary title="${esc(label)}" aria-label="${esc(label)}">?</summary><div>${html}</div></details>`;

  // ---- counts: worked out (recorded or derived) and possible (the rest) ---------------------
  /** Findings worth a look of each kind, and all findings of each kind. One session's view counts
   *  the findings it lists; the whole page counts the window, from the server. */
  function counts(p) {
    if (SESSION) {
      const l = p.findings ?? [];
      return { sureLook: l.filter((f) => isSure(f) && f.severity === 'look').length, possLook: l.filter((f) => !isSure(f) && f.severity === 'look').length, sure: l.filter(isSure).length, poss: l.filter((f) => !isSure(f)).length };
    }
    return { sureLook: p.sure?.look ?? 0, possLook: p.possible?.look ?? 0, sure: p.sure?.count ?? 0, poss: p.possible?.count ?? 0 };
  }
  /** Where a pattern's row sits: the main list, the Possible fold, Not a problem, or a list of patterns not found. */
  function placeOf(p) {
    if (p.status !== 'found') return p.status;
    if (effective(p)?.tier === 'dismissed') return 'dismissed';
    const c = counts(p);
    return c.sureLook > 0 || c.possLook === 0 ? 'main' : 'possible';
  }

  // ---- the trend: this window against the one just before it ---------------------------------
  const count = (c) => `${esc(full(c.value))}${c.evidence ? sym(c.evidence) : ''}`;
  /** "4 before, 1 now", each count with its level's symbol; the row's own kind of finding. */
  function trendHtml(p, kind) {
    const c = counts(p);
    if (SESSION) return esc(`${plural(kind === 'sure' ? c.sureLook : c.possLook, 'finding')} here`);
    const routine = kind === 'sure' && c.sureLook === 0 && c.possLook === 0;
    if (routine) return esc(`${full(p.notesFound)} routine`);
    const t = TREND?.trend?.[p.id]?.[kind];
    const now = t?.now ?? { value: kind === 'sure' ? c.sureLook : c.possLook, evidence: null };
    const nowText = `${count(now)} now`;
    if (TREND === null) return `<span data-trend-pending>${nowText}</span>`;
    if (!t) return nowText;
    if (t.before) return `${count(t.before)} before, ${nowText}`;
    const w = TREND.trend[p.id].why;
    return `${nowText} · ${w === 'no-logs' ? 'no logs before' : w === 'not-checked' ? 'not checked before' : 'before unknown'}`;
  }
  function trendTitle() {
    const e = TREND?.earlier;
    return e?.from ? `Findings worth a look: the ${e.days} days before (${e.from} to ${e.to}), then this window` : 'Findings worth a look in this window';
  }
  function fillTrends() {
    for (const el of document.querySelectorAll('[data-trend]')) {
      const p = PAT.get(el.dataset.trend);
      if (!p) continue;
      el.innerHTML = trendHtml(p, el.dataset.kind);
      el.title = trendTitle();
    }
  }

  // ---- copying a fix or a test prompt --------------------------------------------------------
  /** Copy without a permission prompt where the browser allows (a click on this loopback page),
   *  then the older copy command, then select the text so Ctrl+C or Cmd+C copies it. */
  async function copyText(text, btn, shown) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {}
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.className = 'offscreen';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {}
    }
    if (!ok && shown) {
      const fold = shown.closest('details');
      if (fold) fold.open = true;
      const r = document.createRange();
      r.selectNodeContents(shown);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    btn.textContent = ok ? 'Copied' : 'Selected: press Ctrl+C';
    btn.dataset.copied = ok ? '1' : 'selected';
    $('announce').textContent = ok ? 'Copied' : 'The text is selected. Press Ctrl+C, or Cmd+C, to copy it.';
  }
  /** The text a Copy button copies: the catalog's fix or test prompt, exactly as the server sent it. */
  const copySource = (p, what) => (what === 'fix' ? p.draft?.text : what === 'codex' ? p.draft?.codex?.text : p.testPrompt) ?? null;
  function copyBtn(p, what) {
    const t = copySource(p, what);
    if (!t) return '';
    if (HIDDEN.test(t)) return `<span class="muted" title="Part of it is hidden by redaction. Turn on Show private text to copy it whole.">hidden in part</span>`;
    return `<button type="button" class="copybtn" data-copy="${what}" data-for="${esc(p.id)}">${what === 'codex' ? 'Copy for Codex' : 'Copy'}</button>`;
  }

  // ---- one finding -----------------------------------------------------------------------------
  function findingHtml(f) {
    const sev = SEV[f.severity] ?? SEV.note;
    const time = f.at ? `<time datetime="${esc(f.at)}">${esc(when(f.at))}</time>` : '<span class="muted">no time</span>';
    const links = [];
    const r = replayHref(f);
    const z = zoomHref(f);
    if (r) links.push(`<a href="${esc(r)}">Replay at this step</a>`);
    if (z) links.push(`<a href="${esc(z)}" data-zoomlink aria-label="Zoom to these steps: ${esc(zoomCount(f))}">Zoom to these steps</a>`);
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
    // The reasoning behind the level, the check's note and the step it names: behind the "?".
    const basis = Array.isArray(f.basis) && f.basis.length ? `<ul class="basis">${f.basis.map((b) => `<li>${chip(b.level)} <b>${esc(b.part)}.</b> ${esc(b.how)}</li>`).join('')}</ul>` : '';
    const more = `${basis}<p>${esc(f.note)}</p>${f.text ? `<p class="ftext"><code>${esc(HW.clip(f.text, 220))}</code></p>` : ''}<p class="fmeta">${[`From the check “${esc(f.checkTitle ?? f.check)}”`, f.rule ? `Rule: ${esc(f.rule)}` : '', f.lastAt && f.lastAt !== f.at ? `Until ${esc(when(f.lastAt))}` : ''].filter(Boolean).join(' · ')}</p>`;
    return `<li class="finding s-${f.severity === 'look' ? 'look' : 'note'}" data-session="${esc(f.session ?? '')}">
      <div class="fhead"><span class="sev"><span aria-hidden="true">${sev.icon}</span> ${sev.word}</span> ${time} ${chip(f.verdictEvidence)}${Number.isFinite(f.estimate) && f.estimate > 0 ? ` <span class="num">${esc(fmt(f.estimate))} tokens</span>` : ''}${f.stillRunning ? ' <span class="tag">may still be running</span>' : ''} ${f.session ? `<span class="fwhere">${esc(sessionLabel(f.session))}</span>` : ''} ${why('How this is known', more)}</div>
      ${links.length || steps ? `<p class="flinks">${links.join(' ')}${steps}</p>` : ''}
    </li>`;
  }

  // ---- the lead and the stated rule ------------------------------------------------------------
  const num = (m) => (m && typeof m === 'object' ? m.value : m) ?? 0;
  function header() {
    const n = D.statusCounts?.found ?? 0;
    const cov = D.coverage ?? {};
    const lvl = sym(cov.sessions?.evidence ?? 'derived');
    // With no session to read, nothing was checked: the lead says so instead of "0 showed up".
    const nothing = Number(num(cov.sessions)) === 0 && n === 0;
    $('lead').innerHTML = nothing ? `No session with a record in this window ${lvl}, so nothing was checked.` : `${esc(plural(num(cov.sessions), 'session'))} ${lvl} checked for ${D.patterns.length} known problems.`;
    const PR = D.priorityRule;
    $('priRule').innerHTML = PR
      ? `<summary>How priority is set</summary><p>Claims not backed come first: ${esc(PAT.get('unverified-done-claim')?.name ?? 'says done without checking')}, and ${esc(PAT.get('claim-contradicts-evidence')?.name ?? 'a success claim the output contradicts')}. The rest follow a stated rule, never a score. A pattern's impact comes from its catalog group: ${PR.classes.map((c) => `<b>${esc(c.label.toLowerCase())}</b> (${esc(c.text)})`).join(', ')}.</p><ul>${PR.tiers.map((t) => `<li><b>${esc(t.label)}:</b> ${esc(t.text)}.</li>`).join('')}</ul><p>${esc(PR.counts)} ${esc(PR.order)} ${esc(PR.rest)} "My priority" on a row overrides both, here and on the replay and goal timelines. This browser keeps only the pattern's id and the tier you picked.</p>`
      : '<summary>How priority is set</summary><p>No priority rule came with this answer.</p>';
    if (SESSION) {
      const el = $('sessFilter');
      const fo = D.focus;
      el.hidden = false;
      const r = fo?.thread ? replayHref({ session: SESSION, thread: fo.thread }) : null;
      el.innerHTML = fo && fo.findings
        ? `Showing one session: <span>${esc(fo.title ? `“${fo.title}”` : 'an untitled session')}</span>, ${esc(plural(fo.findings, 'finding'))}. ${r ? `<a href="${esc(r)}">Replay it</a> · ` : ''}<a href="problems.html">Show every session</a>`
        : `No findings for that session in this window${fo?.known ? '' : ': it may be outside the window, display-only or outside your configured repositories'}. <a href="problems.html">Show every session</a>`;
    }
  }

  // ---- filters (a closed fold) --------------------------------------------------------------------
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
    const cs = Object.fromEntries(Object.keys(STATUS).map((k) => [k, D.patterns.filter((p) => inGroup(p) && p.status === k).length]));
    $('statusFilter').innerHTML = [`<button type="button" data-status="" aria-pressed="${!status}">Any status <span class="n">${D.patterns.filter(inGroup).length}</span></button>`, ...Object.entries(STATUS).map(([k, s]) => `<button type="button" data-status="${k}" aria-pressed="${status === k}"><span class="pstat st-${k}" aria-hidden="true">${s.icon}</span>${esc(s.word)} <span class="n">${cs[k]}</span></button>`)].join('');
  }
  function rerender(sel, host) {
    renderFilters();
    renderCards();
    host.querySelector(sel)?.focus();
    $('announce').textContent = `Showing ${shown().length} of ${D.patterns.length} patterns`;
  }

  // ---- one pattern: a row that opens -------------------------------------------------------------
  function statusText(p) {
    if (p.status === 'clear') return 'checked, nothing found';
    if (p.status === 'unchecked') return (p.measures ?? []).length ? 'not checked' : 'no check here yet';
    return "can't be checked from logs";
  }
  function priHtml(p) {
    const e = effective(p);
    if (!e) return '';
    const tag = `<span class="ptier ${tierClass(e.tier)}">${esc(TIER_LABEL[e.tier])}</span>`;
    const reason = `${p.claim && !e.mine ? 'A claim not backed, so it comes first. ' : ''}Why ${esc(TIER_LABEL[e.rule].toLowerCase())}: ${esc(p.priority.reason)}.`;
    if (e.mine) return `<span class="pwhy">${tag} <b>you set this</b> ${why('Why this priority', `<p>The rule says ${esc(TIER_LABEL[e.rule].toLowerCase())}. ${reason}</p>`)}</span>`;
    return `<span class="pwhy">${tag} ${why('Why this priority', `<p>${reason}</p>`)}</span>`;
  }
  /** The small Codex marker on a row: whether this pattern's check runs on Codex's logs. */
  function coverMark(p) {
    const c = coverOf(p, 'codex');
    const m = c && (p.measures ?? []).length ? COVER[c.status] : null;
    return m ? ` <span class="cov cov-${c.status === 'not yet' ? 'no' : esc(c.status)}" title="On Codex: ${esc(m.word)}"><span class="sr">On </span>Codex <span aria-hidden="true">${m.icon}</span><span class="sr">: ${esc(m.word)}</span></span>` : '';
  }
  /** One line in an opened row: where the check runs, with the Codex reason behind "?". */
  function coverLine(p) {
    const cc = coverOf(p, 'claudeCode');
    const cx = coverOf(p, 'codex');
    if (!cc || !cx || !(p.measures ?? []).length) return '';
    const reason = [cc, cx].some((c) => c.why) ? why('Why', [['Claude Code', cc], ['Codex', cx]].filter(([, c]) => c.why).map(([n, c]) => `<p>${n}: ${esc(c.why)}.</p>`).join('')) : '';
    return `<div class="fine covline">Its check on Claude Code: ${esc(COVER[cc.status]?.word ?? cc.status)}. On Codex: ${esc(COVER[cx.status]?.word ?? cx.status)}. ${reason}</div>`;
  }
  function cardHtml(p, kind = 'sure') {
    const st = STATUS[p.status] ?? STATUS.unchecked;
    const e = effective(p);
    const mine = e ? `<label class="pmine">My priority <select data-pri="${esc(p.id)}">${['high', 'medium', 'low', 'dismissed'].map((t) => `<option value="${t}"${e.tier === t ? ' selected' : ''}>${esc(TIER_LABEL[t])}${t === e.rule ? " (the rule's)" : ''}</option>`).join('')}</select></label>` : '';
    const prio = e ? `<span class="prio ${tierClass(e.tier)}">${esc(TIER_LABEL[e.tier])}</span>` : `<span class="pstat st-${p.status}" aria-hidden="true">${st.icon}</span>`;
    const tally = p.status === 'found' ? `<span class="pfound num tally" data-trend="${esc(p.id)}" data-kind="${kind}" title="${esc(trendTitle())}">${trendHtml(p, kind)}</span>` : `<span class="pfound muted">${esc(statusText(p))}</span>`;
    return `<div class="pcw"><details class="pcard" id="${esc(p.id)}" data-pattern="${esc(p.id)}" data-kind="${kind}">
      <summary>
        <span class="pprio">${prio}</span>
        <span class="pname"><span class="sr">${esc(st.word)}: </span><span class="ptitle">${esc(p.name)}</span>${p.claim && e && !e.mine ? ' <span class="tag claimtag">claim not backed</span>' : ''}${coverMark(p)}</span>
        ${tally}
        <span class="ptoggle" aria-hidden="true"></span>
      </summary>
      ${e ? `<div class="pextra">${priHtml(p)}${mine}</div>` : ''}
      <div class="pbody" data-body></div>
    </details></div>`;
  }
  function listHtml(p, list, all) {
    const showList = all ? list : list.slice(0, SHOW);
    return `<ol class="findings">${showList.map(findingHtml).join('')}</ol>${list.length > SHOW ? `<button type="button" class="more" data-more="${esc(p.id)}" aria-expanded="${all}">${all ? `Show the first ${SHOW}` : `Show all ${list.length} listed`}</button>` : ''}`;
  }
  function bodyHtml(p) {
    const kind = document.getElementById(p.id)?.dataset.kind === 'possible' ? 'possible' : 'sure';
    const d = p.draft;
    const cx = d?.codex;
    const codexFix = cx ? `<p class="fine">${esc(cx.where)}</p>${cx.text ? `<pre data-copytext="codex">${esc(cx.text)}</pre>` : ''}` : '';
    const fix = d
      ? `<div class="draft" id="draft-${esc(p.id)}" tabindex="-1"><p class="fixline"><b>Fix</b> <span class="tag">${esc(FIXKIND[d.kind] ?? d.kind)}</span> ${esc(d.title)} ${copyBtn(p, 'fix')}${cx?.text ? ` ${copyBtn(p, 'codex')}` : ''}</p><details class="fixtext"><summary>Show it</summary><p class="fine">${esc(d.where)}. honestweek never changes a settings file.</p><pre data-copytext="fix">${esc(d.text)}</pre>${codexFix}</details></div>`
      : '';
    // Try it names Codex only where the pattern's check runs on Codex's logs.
    const onCodex = coverOf(p, 'codex');
    const tryWhere = onCodex?.status === 'runs'
      ? '<p>Paste it into Claude Code or Codex after adding the fix, and the fix should catch it. A suggestion only: it may not trigger every time.</p>'
      : `<p>Paste it into Claude Code after adding the fix, and the fix should catch it. A suggestion only: it may not trigger every time.</p><p>${onCodex?.status === 'partial' ? 'On Codex it may not be caught yet' : "On Codex the check can't catch it yet"}${onCodex?.why ? `: ${esc(onCodex.why)}` : ''}.</p>`;
    const tryIt = p.testPrompt ? `<p class="tryit"><b>Try it</b> <span class="muted">a suggested prompt</span> ${copyBtn(p, 'try')} ${why('What this is', tryWhere)}<br><code data-copytext="try">${esc(p.testPrompt)}</code></p>` : '';

    const list = p.findings ?? [];
    const mineList = list.filter((f) => (kind === 'sure' ? isSure(f) : !isSure(f)));
    const otherList = list.filter((f) => (kind === 'sure' ? !isSure(f) : isSure(f)));
    const c = counts(p);
    const otherCount = SESSION ? otherList.length : kind === 'sure' ? c.poss : c.sure;
    const truncated = !SESSION && (kind === 'sure' ? c.sure : c.poss) > mineList.length;
    const cost = p.tokens?.tokens > 0 ? `<p class="fine">${p.tokens.waste ? 'Estimated cost' : 'Spent'}: ${tok(p.tokens.tokens)} tokens${D.coverage?.tokens?.value ? (p.tokens.tokens > D.coverage.tokens.value ? `, ${OVER}` : `, ${pct(p.tokens.tokens / D.coverage.tokens.value)} of the window's`) : ''} ${chip(p.tokens.evidence)} ${why('How the cost is worked out', `<p>${esc(p.tokens.label)}.${p.tokens.waste && p.tokens.lookTokens < p.tokens.tokens ? ` ${esc(fmt(p.tokens.lookTokens))} of it is in findings worth a look, which alone sets the priority.` : ''}</p>`)}</p>` : '';
    const week = p.status === 'found'
      ? `${cost}${mineList.length ? listHtml(p, mineList, expanded.has(p.id)) : '<p class="muted">None of this kind listed.</p>'}
         ${truncated ? `<p class="muted">The first ${full(mineList.length)} listed. Open one session's view for the rest.</p>` : ''}
         ${otherCount ? `<details class="otherkind"><summary>${kind === 'sure' ? `${full(otherCount)} possible` : `${full(otherCount)} worked out`}</summary>${kind === 'sure' ? '<p class="fine">Found by a rule\'s guess or a missing record, so each could be wrong.</p>' : ''}<ol class="findings">${otherList.slice(0, SHOW).map(findingHtml).join('')}</ol></details>` : ''}`
      : p.status === 'clear' ? '<p class="muted">Checked; nothing found in this window.</p>'
      : p.status === 'unchecked' ? `<p class="muted">${p.notRun ? `Not checked. ${esc(p.notRun)} This` : 'Not checked, so this'} says nothing about whether it happened.</p>`
      : '<p class="muted">Not checkable from logs.</p>';
    return `${coverLine(p)}${fix}${tryIt}<section><h3>This window</h3>${week}</section>${aboutHtml(p)}`;
  }
  /** The catalog's text about a pattern, one click away. */
  function aboutHtml(p) {
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
    const sources = `<ol class="srcs">${p.sources.map((s) => {
      const href = linkOf(s.link);
      return `<li>${href ? `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(s.title)}</a>` : `<span>${esc(s.title)}</span> <span class="muted">(its address is hidden by redaction)</span>`} <span class="tag">${esc(KIND1[s.kind] ?? s.kind)}</span> <span class="smeta">${esc(s.date ?? '')}</span>${s.says ? `<span class="says">${esc(s.says)}</span>` : ''}</li>`;
    }).join('')}</ol>`;
    const related = (p.related ?? []).filter((r) => PAT.has(r));
    return `<details class="pmore" data-about="${esc(p.id)}"><summary>About this problem</summary>
      <div class="pgrid">
        <section><h3>What it looks like</h3><p>${esc(p.looksLike)}</p></section>
        <section><h3>Why it matters</h3><p>${esc(p.whyItMatters)}</p></section>
      </div>
      <div class="pgrid">
        <section><h3>Fix ideas</h3><ul class="mitig">${p.mitigation.map((m) => `<li><span class="tag">${esc(FIXKIND[m.kind] ?? m.kind)}</span> ${esc(m.action)}</li>`).join('')}</ul></section>
        <section><h3>How strong the evidence is that it's common</h3><p><span class="tag">${esc(STRENGTH[p.strength] ?? p.strength)}</span> ${esc(p.strengthReason)}</p><p class="fine">Known from ${esc(plural(p.sources.length, 'source'))}: ${esc(kinds)}. <a href="#src-${esc(p.id)}" data-src="${esc(p.id)}">Sources</a></p></section>
      </div>
      <h3>How it's detected here</h3>${detect}
      <h3 id="src-${esc(p.id)}" tabindex="-1">Sources</h3><p class="fine">Each opens the published page in a new tab when you click it; this page fetches nothing.</p>${sources}
      ${related.length ? `<p class="related"><b>Related:</b> ${related.map((r) => `<a href="#${esc(r)}" data-open="${esc(r)}">${esc(PAT.get(r).name)}</a>`).join(' ')}</p>` : ''}
    </details>`;
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
    const foldsOpen = new Set([...cards.querySelectorAll('details[data-list][open]')].map((d) => d.dataset.list));
    const list = shown();
    const order = (ps) => window.HWPrefs.order(prefs, ps);
    const at = (place) => list.filter((p) => placeOf(p) === place);
    const main = order(at('main'));
    const top = main.filter((p) => effective(p)?.tier !== 'low');
    const low = main.filter((p) => effective(p)?.tier === 'low');
    const possible = order(at('possible'));
    const dis = order(at('dismissed'));
    const gi = new Map(D.groups.map((g, i) => [g.id, i]));
    const SR = { 'well-established': 0, reported: 1, speculative: 2 };
    const rest = (st) => at(st).sort((a, b) => gi.get(a.group) - gi.get(b.group) || (SR[a.strength] ?? 3) - (SR[b.strength] ?? 3));
    const routine = list.filter((p) => p.status === 'found').reduce((n, p) => n + (Number(p.notesFound) || 0), 0);
    const mainShown = !status || status === 'found';
    const sec = (cls, ps, kind, extra = '') => `<section class="tier ${cls}" data-tier="${cls}"${extra}>${ps.map((p) => cardHtml(p, kind)).join('')}</section>`;
    const fold = (listId, cls, title, note, ps, kind) => (ps.length ? `<details class="restlist ${cls}" data-list="${listId}"${foldsOpen.has(listId) || status === listId ? ' open' : ''}><summary>${esc(title)} <span class="hcount">${ps.length}</span></summary>${note ? `<p class="foldnote">${esc(note)}</p>` : ''}${sec(`t-${listId}`, ps, kind)}</details>` : '');
    const lowBtn = low.length ? `<button type="button" class="linklike" data-low aria-expanded="${lowShown}" aria-controls="tier-low">${lowShown ? 'Hide low priority' : `Show ${full(low.length)} low priority`}</button>` : '';
    const routineBox = routine ? `<label><input type="checkbox" data-routine-all${routineShown ? ' checked' : ''}> Show routine notes (${full(routine)} found)</label>` : '';
    const html = [
      mainShown ? (top.length ? sec('t-top', top, 'sure') : `<p class="muted gempty">${SESSION ? 'Nothing worked out from the log in this session.' : 'Nothing worked out from the log in this window.'}${possible.length ? ' See Possible below.' : ''}</p>`) : '',
      mainShown && low.length ? sec('t-low', low, 'sure', ` id="tier-low"${lowShown ? '' : ' hidden'}`) : '',
      lowBtn || routineBox ? `<div class="ptable-foot">${lowBtn}${routineBox}</div>` : '',
      fold('possible', 'possible', 'Possible', "Found only by a rule's guess or a missing record, so each could be wrong.", possible, 'possible'),
      fold('dismissed', 'dismissed', 'Not a problem, by you', 'Set "My priority" to bring one back.', dis, 'sure'),
      `<div class="restlists">${[['clear', 'Not found in this window'], ['unchecked', 'Not checked'], ['undetectable', "Can't be checked from logs"]].map(([st, title]) => fold(st, '', title, null, rest(st), 'sure')).join('')}</div>`,
    ].join('');
    cards.innerHTML = html;
    cards.classList.toggle('show-routine', routineShown);
    for (const id of open) {
      const d = document.getElementById(id);
      if (d) {
        d.setAttribute('open', '');
        fill(d);
      }
    }
    $('foundCount').textContent = String(main.length);
    const filtered = group || status;
    $('filterNote').hidden = !filtered;
    $('filterNote').textContent = filtered ? `Showing ${list.length} of ${D.patterns.length} patterns${group ? ` in ${GROUP.get(group)?.name ?? group}` : ''}${status ? `, ${STATUS[status].word.toLowerCase()}` : ''}.` : '';
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
          <p><b>How this is known.</b> ${esc(c.how)} Its findings are ${chip(c.evidence)} or stronger where marked.</p>
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
    return `<summary><h2 class="sh">About this page</h2></summary>
      <p><b>Worth a look, never a verdict.</b> Each pattern can be legitimate, and no finding says why it happened.</p>
      <p><b>The main list and Possible.</b> The main list holds findings worked out from the log alone (${chip('recorded')} or ${chip('derived')}). Possible holds the rest: ${chip('inferred')} a named rule decided it and could be wrong, ${chip('missing')} a record the check expected isn't in the logs. Nothing is hidden for good; each row says how many of each kind.</p>
      <p><b>Before and now.</b> Findings worth a look of the row's kind in this window, against the window of the same length just before it. When that earlier window has no logs, or its checks couldn't run, the row says so instead of showing zero.</p>
      <p><b>The catalog.</b> ${esc(D.catalog?.about ?? '')} Its ${esc(full(D.catalog?.sources ?? 0))} sources were checked on ${esc(checked || 'the dates the catalog records')}.</p>
      <p><b>Detection is from local logs only.</b> Nothing here calls out to the web or reads anything but the session files this page already read. "Not checked" means a pattern wasn't looked for, so it says nothing about whether it happened; "can't be checked from logs" means the catalog says a log can't show it.</p>
      <p><b>What the counts cover.</b> ${esc(plural(num(cov.sessions), 'session'))} in your configured repositories with records in this window, ${esc(plural(num(cov.toolCalls), 'tool call'))}${cov.usageRecorded ? ` and ${esc(plural(num(cov.modelCalls), 'model call'))} with token counts (${tok(num(cov.tokens))} tokens in all)` : ', and no token counts, so the checks that measure tokens didn\'t run'}. Token estimates overlap between checks, so they don't add up to a total.</p>
      <p><b>Fixes are for you to adopt.</b> Copy puts the catalog's draft on your clipboard. Nothing on this page changes your settings, hooks, skills or instructions.</p>`;
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
    const redrawBodies = () => cards.querySelectorAll('[data-body][data-filled]').forEach((b) => {
      b.innerHTML = bodyHtml(PAT.get(b.closest('details.pcard').dataset.pattern));
    });
    cards.addEventListener('change', (ev) => {
      if (ev.target.matches?.('[data-routine-all]')) {
        routineShown = ev.target.checked;
        cards.classList.toggle('show-routine', routineShown);
        redrawBodies();
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
      if (moved === 'dismissed') $('cards').querySelector('details[data-list="dismissed"]')?.setAttribute('open', '');
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
      const cb = ev.target.closest('[data-copy]');
      if (cb) {
        const p = PAT.get(cb.dataset.for);
        const text = p ? copySource(p, cb.dataset.copy) : null;
        if (text) copyText(text, cb, cb.closest('.pbody')?.querySelector(`[data-copytext="${CSS.escape(cb.dataset.copy)}"]`));
        return;
      }
      // "Show N low priority": the Low tier, one click away.
      const lowBtn = ev.target.closest('[data-low]');
      if (lowBtn) {
        lowShown = !lowShown;
        renderCards();
        $('cards').querySelector('[data-low]')?.focus();
        return;
      }
      const src = ev.target.closest('a[data-src]');
      if (src) {
        ev.preventDefault();
        const h = document.getElementById(`src-${src.dataset.src}`);
        h?.closest('details')?.setAttribute('open', '');
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
    // Leaving for a replay: this entry keeps the open pattern, its "Show all" lists and the scroll
    // position, so Back returns here.
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[href^="replay.html"]');
      if (!a || ev.defaultPrevented) return;
      const row = a.closest('details.pcard')?.id;
      const want = row && PATTERN_ID.test(row) ? `${location.pathname}${location.search}#${row}` : location.href;
      const state = { ...(history.state ?? {}), y: Math.round(window.scrollY), more: [...expanded] };
      history.replaceState(state, '', want);
    });
    const back = history.state;
    if (back && Number.isFinite(back.y)) window.scrollTo(0, back.y);
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
    for (const id of history.state?.more ?? []) if (PAT.has(id)) expanded.add(id);
    if (SESSION) TREND = false;
    header();
    renderFilters();
    renderCards();
    HW.navCount(D.patterns);
    $('checks').innerHTML = checksHtml();
    $('foot').innerHTML = footHtml();
    wire();
    // The optional /insights group (insights.js): its own answer, drawn apart from these counts.
    window.HWInsights?.load();
    // The trend reads the window before this one, which can take a while: the rows show this
    // window's counts until it answers.
    if (!SESSION) {
      HW.load('problems', { trend: '1' }).then(
        (a) => {
          TREND = a && Array.isArray(a.trend) ? { trend: Object.fromEntries(a.trend.filter((t) => t && PATTERN_ID.test(t.id ?? '')).map((t) => [t.id, t])), earlier: a.earlier ?? null } : false;
          fillTrends();
        },
        () => {
          TREND = false;
          fillTrends();
        },
      );
    }
  });
})();
