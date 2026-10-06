// The Problems page, and the page `honestweek view` opens on: where this window's sessions went
// wrong. It joins a researched catalog of known ways AI coding agents go wrong or waste time and
// tokens to the checks that look for each one, and answers three questions without a click: what
// went wrong, worst first; where exactly (which agent, when, what the log shows); and what to
// paste to stop it.
//
// Three views, one page, chosen by the address's fragment:
// - the landing (no fragment): a headline built from the counts, "Found in the log" with one card
//   per pattern worked out from the log (recorded or derived), worst first, each with its findings
//   as rows and its fix to copy; low priority behind one "N smaller things" control; then
//   "Possible: check these yourself", the patterns a rule's guess or a missing record found, each
//   with what the agent said or ran beside what the log shows. Claims not backed come first; "My
//   priority" overrides the order per pattern (HWPrefs.order).
// - one problem (#<pattern id>): when it happened, what happened step by step with how each step
//   is known, the fix for either agent, a prompt to check the fix, "My priority", and the
//   catalog's text and sources in a closed fold.
// - what was checked (#checked): the patterns not found, not checked or that a log can't show,
//   the /insights group, the window's facts, how priority is set, how the checks work, and about
//   this page.
//
// Data: /api/problems, /api/problems?trend=1 for the trend, or /api/problems?session=<key> for
// one session's findings (Replay's "Open in Problems" and the goal page strip's "and N more" link). The address holds only ids:
// ?session=<key>, #<pattern id> and #checked. "See the steps" opens the replay at
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
  const STRENGTH = { 'well-established': 'Well established', reported: 'Reported', speculative: 'Speculative' };
  const KINDS = { docs: ['vendor doc', 'vendor docs'], 'user-report': ['user report', 'user reports'], paper: ['paper', 'papers'] };
  const KIND1 = { docs: 'vendor doc', 'user-report': 'user report', paper: 'paper' };
  const FIXKIND = { hook: 'Hook', instruction: 'Instruction', skill: 'Skill change', setting: 'Setting', workflow: 'Workflow' };
  // The two agents, by the session's `tool`, and by the catalog's coverage keys.
  const AGENT = { 'claude-code': 'Claude Code', codex: 'Codex' };
  const COVER_AGENT = { claudeCode: 'Claude Code', codex: 'Codex' };
  const coverOf = (p, agent) => p.coverage?.[agent] ?? null;
  const SURE = new Set(['recorded', 'derived']);
  const isSure = (f) => SURE.has(f.verdictEvidence);
  const HIDDEN = /\[redacted:[a-z]+\]/;
  // How many finding rows a card shows before "Show all", and how many moments a problem's
  // "When" list shows before "N more".
  const SHOW = 3;
  const WHEN_SHOW = 6;
  // How many possible patterns show as cards before "N more possible problems".
  const POSSIBLE_SHOW = 3;

  // ?session=<key>: the page narrowed to one session's findings.
  const params = new URLSearchParams(location.search);
  const SESSION = isId('session', params.get('session')) ? params.get('session') : null;

  let D = null;
  let PAT = new Map();
  let GROUP = new Map();
  let prefs = null;
  let group = null;
  let TREND = null; // { trend, earlier } once /api/problems?trend=1 answers; false when it couldn't
  const expanded = new Set(); // cards showing every finding row
  const whenAll = new Set(); // problems whose "When" list shows every moment
  const pick = new Map(); // pattern id -> the finding key chosen in its "When" list
  // Low priority is one click away; one session's view shows it from the start.
  let lowShown = !!SESSION;
  let routineShown = false;
  let morePossible = false;
  let fixAgent = null; // 'claude' or 'codex' once chosen in a problem's switch
  let view = null; // { name: 'landing' | 'problem' | 'checked', id }
  let landingY = 0;

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
    return s?.title ? `“${s.title}”` : s?.label ? s.label : 'an untitled session';
  };
  /** The agent a finding's session ran on, named; null when the answer doesn't say. */
  const agentOf = (f) => AGENT[D.sessions?.[f.session]?.tool] ?? null;
  /** The agent a finding's session ran on and the repository it worked in, each when the answer says. */
  const agentTag = (f) => {
    const a = agentOf(f);
    const repo = D.sessions?.[f.session]?.repo;
    return `${a ? `<span class="agent">${esc(a)}</span>` : ''}${repo ? `<span class="repotag" title="Repository">${esc(repo)}</span>` : ''}`;
  };
  const timeHtml = (f) => (f.at ? `<time datetime="${esc(f.at)}">${esc(when(f.at))}</time>` : '<span class="muted">no time</span>');
  // The plain past-tense headline says it happened, so it titles only a pattern found in the log;
  // Not found, Not checked and Can't be checked keep the catalog's name for the pattern.
  const titleOf = (p) => (p.headline && p.status === 'found' ? p.headline : p.name);

  const effective = (p) => window.HWPrefs.effective(prefs, p);
  const tierClass = (t) => (RANK[t] != null ? `t-${t}` : '');
  const tierPill = (p) => {
    const e = effective(p);
    return e ? `<span class="prio ${tierClass(e.tier)}">${esc(TIER_LABEL[e.tier])}</span>` : '';
  };
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
  /** Where a pattern sits: the main list, Possible, Not a problem, or a list of patterns not found. */
  function placeOf(p) {
    if (p.status !== 'found') return p.status;
    if (effective(p)?.tier === 'dismissed') return 'dismissed';
    const c = counts(p);
    return c.sureLook > 0 || c.possLook === 0 ? 'main' : 'possible';
  }
  const kindOf = (p) => (placeOf(p) === 'possible' ? 'possible' : 'sure');
  const ofKind = (p, kind) => (p.findings ?? []).filter((f) => (kind === 'sure' ? isSure(f) : !isSure(f)));
  /** How a pattern's count of one kind is known: the weakest level among the findings it counts. */
  const levelOf = (p, kind) => {
    const l = ofKind(p, kind);
    return l.length ? window.HWE.weakest(l.map((f) => f.verdictEvidence)) : p.countEvidence ?? null;
  };

  // While the rest of the window loads, the page speaks of the days in so far, never the window.
  const partial = () => !!HW.shell.window?.partial;
  const inWin = () => (partial() ? 'the days loaded so far' : 'this window');

  // ---- the trend: this window against the one just before it ---------------------------------
  const count = (c) => `${esc(full(c.value))}${c.evidence ? sym(c.evidence) : ''}`;
  const times = (c) => `${esc(plural(c.value, 'time'))}${c.evidence ? ` ${sym(c.evidence)}` : ''}`;
  /** "2 times · 4 before", each count with its level's symbol: the card's own kind of finding. */
  function trendHtml(p, kind) {
    const c = counts(p);
    if (SESSION) return `${esc(`${plural(kind === 'sure' ? c.sureLook : c.possLook, 'time')} here`)}`;
    const routine = kind === 'sure' && c.sureLook === 0 && c.possLook === 0;
    if (routine) return esc(`${full(p.notesFound)} routine`);
    const t = TREND?.trend?.[p.id]?.[kind];
    const now = t?.now ?? { value: kind === 'sure' ? c.sureLook : c.possLook, evidence: levelOf(p, kind) };
    // While the rest of the window loads, a count covers only the days in so far.
    const nowText = `${times(now)}${partial() ? ' so far' : ''}`;
    if (TREND === null) return `<span data-trend-pending>${nowText}</span>`;
    if (!t) return nowText;
    // While the week before is still loading, "before" covers only its days in so far.
    if (t.before) return `${nowText} · ${count(t.before)} before${TREND.earlier?.partial ? ' so far' : ''}`;
    const w = TREND.trend[p.id].why;
    // No logs before at all: the line under the headline says so once, not on every card.
    if (w === 'no-logs') return nowText;
    return `${nowText} · ${w === 'not-checked' ? 'not checked before' : w === 'not-loaded' ? 'before not loaded' : 'before unknown'}`;
  }
  /** One quiet line under the headline: the comparison is on its way, or why there's none. */
  function trendNote() {
    const el = $('trendNote');
    if (!el) return;
    const e = TREND?.earlier;
    const text = SESSION
      ? ''
      : TREND === null ? 'Comparing with the week before…'
      : TREND?.waiting === 'loading' ? 'Compared with the week before once every day is in.'
      : TREND === false ? "Couldn't compare with the week before."
      : e?.skipped ? HW.friendlyDates(e.note ?? "The week before isn't loaded, so nothing is compared.")
      : e?.partial || e?.loaded ? HW.friendlyDates(e.note ?? '')
      : e && e.sessions === 0 ? `No logs in the ${plural(e.days ?? 0, 'day')} before, so no trend yet.`
      : '';
    el.hidden = !text;
    el.textContent = text;
  }
  function trendTitle() {
    const e = TREND?.earlier;
    return e?.from ? `Findings worth a look: this window, then the ${e.days} days before (${HW.daySpan(e.from, e.to)})` : 'Findings worth a look in this window';
  }
  function fillTrends() {
    trendNote();
    for (const el of document.querySelectorAll('[data-trend]')) {
      const p = PAT.get(el.dataset.trend);
      if (!p) continue;
      el.innerHTML = trendHtml(p, el.dataset.kind);
      el.title = trendTitle();
    }
  }
  const trendSpan = (p, kind) => `<span class="ptrend num" data-trend="${esc(p.id)}" data-kind="${kind}" title="${esc(trendTitle())}">${trendHtml(p, kind)}</span>`;
  /** A pattern's token estimate, its level, and its share of the window's tokens. */
  function costHtml(p) {
    if (!(p.tokens?.tokens > 0)) return '';
    const all = D.coverage?.tokens?.value;
    const share = all ? (p.tokens.tokens > all ? `, ${OVER}` : `, ${pct(p.tokens.tokens / all)} of the window's`) : '';
    return `<span class="pcost" title="${esc(p.tokens.label)}">${tok(p.tokens.tokens)} tokens${p.tokens.waste ? '' : ' spent'} ${sym(p.tokens.evidence)}${esc(share)}</span>`;
  }

  // ---- where a check runs: a badge only when it doesn't run fully on an agent ---------------
  const COVER_WORD = { partial: (a) => `Partial on ${a}`, 'not yet': (a) => `Not on ${a} yet` };
  /** "Partial on Codex", "Not on Codex yet": one badge per agent whose logs the pattern's check
   *  reads only in part or not at all. A pattern with no check, or one that runs on both, has none. */
  function covBadge(p) {
    if (!(p.measures ?? []).length) return '';
    return Object.entries(COVER_AGENT)
      .map(([k, name]) => [coverOf(p, k), name])
      .filter(([c]) => c && COVER_WORD[c.status])
      .map(([c, name]) => `<span class="cov" data-cov="${esc(c.status)}" title="${esc(`${COVER_WORD[c.status](name)}${c.why ? `: ${c.why}` : ''}.`)}">${esc(COVER_WORD[c.status](name))}</span>`)
      .join(' ');
  }

  /** "Sources: 4 vendor docs, 2 papers": where the catalog got the pattern from, opening its
   *  published sources on the pattern's own page. */
  function sourcesLink(p) {
    const n = (p.sources ?? []).length;
    if (!n) return '';
    const kinds = Object.entries(p.sourceKinds ?? {}).filter(([, k]) => k > 0).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c} ${KINDS[k]?.[c === 1 ? 0 : 1] ?? k}`).join(', ');
    return `<a class="pc-src" href="#${esc(p.id)}" data-sources="${esc(p.id)}">Sources: ${esc(kinds || plural(n, 'source'))}</a>`;
  }

  // ---- copying a fix or a test prompt --------------------------------------------------------
  /** Copy without a permission prompt where the browser allows (a click on this loopback page),
   *  then the older copy command, then show and select the text so Ctrl+C or Cmd+C copies it. */
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
      shown.hidden = false;
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
  // An instruction or workflow goes into Codex's AGENTS.md as it is, so its one text serves both
  // agents. A hook, setting or skill is written for Claude Code: Codex gets only the catalog's
  // own Codex text.
  const SHARED_KINDS = new Set(['instruction', 'workflow']);
  /** The text "Copy for Codex" copies, or null when the catalog has none for Codex. */
  const codexText = (p) => {
    const d = p.draft;
    const cx = d?.codex;
    if (!cx) return null;
    if (cx.text) return cx.text;
    return SHARED_KINDS.has(d.kind) && /^In Codex: /.test(cx.where ?? '') ? d.text ?? null : null;
  };
  /** The text a Copy button copies: the catalog's fix or test prompt, exactly as the server sent it. */
  // A test prompt is copied with its tag, so the session that runs it can be found again.
  const copySource = (p, what) => (what === 'fix' ? p.draft?.text : what === 'codex' ? codexText(p) : p.testPrompt && p.testTag ? `${p.testPrompt} ${p.testTag}` : p.testPrompt) ?? null;
  const COPY_LABEL = { fix: 'Copy for Claude Code', codex: 'Copy for Codex', try: 'Copy prompt' };
  function copyBtn(p, what, cls = '') {
    const t = copySource(p, what);
    if (!t) return '';
    if (HIDDEN.test(t)) return `<span class="muted" title="Part of it is hidden by redaction. Turn on Show private text to copy it whole.">hidden in part</span>`;
    return `<button type="button" class="copybtn${cls ? ` ${cls}` : ''}" data-copy="${what}" data-for="${esc(p.id)}">${COPY_LABEL[what]}</button>`;
  }
  /** The texts the Copy buttons copy, kept out of sight until a refused clipboard needs them shown. */
  const copyTexts = (p) => ['fix', 'codex'].map((w) => {
    const t = copySource(p, w);
    return t ? `<pre class="copytext" data-copytext="${w}" hidden>${esc(t)}</pre>` : '';
  }).join('');

  // ---- what the agent said or ran, from a finding's step description --------------------------
  const STEP_LABEL = { shell: 'The agent ran', edit: 'The agent edited', read: 'The agent read', search: 'The agent searched', delegate: 'The agent started a helper' };
  /** A finding's step, read into who did what: the label is the step's kind, never a reading of it. */
  function saidOf(text) {
    const t = String(text ?? '');
    if (!t) return null;
    let m = t.match(/^(message to the person|reply to parent agent|reply to whatever ran codex exec|reply to the program that sent the turn) "([^]*)"$/);
    if (m) return { label: m[1] === 'message to the person' ? 'The agent said' : 'The agent replied', body: m[2], code: false };
    m = t.match(/^prompt "([^]*)"(?: \(typed while the agent was busy, delivered mid-turn\))?$/);
    if (m) return { label: 'You wrote', body: m[1], code: false };
    m = t.match(/^(\S+) \(([a-z-]+)\) ([^]*) -> ([^]*)$/);
    if (m) return { label: STEP_LABEL[m[2]] ?? 'The step', body: m[2] === 'shell' ? m[3] : `${m[1]} ${m[3]}`, code: true, result: m[4] };
    return { label: 'The step', body: t, code: false };
  }
  const saidBody = (s, n) => (s.code ? `<code>${HW.clipHtml(s.body, n)}</code>` : `“${HW.clipHtml(s.body, n)}”`);
  /** A note's first sentence, cut short: the rest is one click away. */
  function shortNote(note, n = 110) {
    const t = String(note ?? '');
    const first = t.split(/(?<=[.!?])\s+(?=[A-Z“"(])/)[0] ?? t;
    const cut = HW.clip(first, n);
    // A cut ends on a word, never on the comma before the next one.
    return cut.length < first.length ? `${esc(cut.replace(/[\s,;:]+$/, ''))}<span>…</span>` : esc(first);
  }

  // ---- one finding: a row on a card, and the fold behind its "more" ---------------------------
  /** The finding's links: the replay at its step, a related step, its goals, each step it names. */
  function linksHtml(f) {
    const links = [];
    const r = replayHref(f);
    const z = zoomHref(f);
    if (r) links.push(`<a href="${esc(r)}">Replay at this step</a>`);
    if (z) links.push(`<a href="${esc(z)}" aria-label="Zoom to these steps: ${esc(zoomCount(f))}">Zoom to these steps</a>`);
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
    return links.length || steps ? `<p class="flinks">${links.join(' ')}${steps}</p>` : '';
  }
  const metaHtml = (f) => `<p class="fmeta">${[`From the check “${esc(f.checkTitle ?? f.check)}”`, f.rule ? `Rule: ${esc(f.rule)}` : '', f.lastAt && f.lastAt !== f.at ? `Until ${esc(when(f.lastAt))}` : '', Number.isFinite(f.estimate) && f.estimate > 0 ? `${tok(f.estimate)} tokens estimated ${sym('inferred')}` : ''].filter(Boolean).join(' · ')}</p>`;
  const basisHtml = (f) => (Array.isArray(f.basis) && f.basis.length ? `<ul class="basis">${f.basis.map((b) => `<li>${chip(b.level)} <b>${esc(b.part)}.</b> ${esc(b.how)}</li>`).join('')}</ul>` : '');
  /** Behind a row's "more": the whole note, how each part is known, the step, and the links. */
  function moreHtml(f) {
    const s = saidOf(f.text);
    return `<p>${esc(f.note)}</p>${basisHtml(f)}${s ? `<p class="fsaid"><span class="muted">${esc(s.label)}:</span> ${saidBody(s, 220)}</p>` : ''}${linksHtml(f)}${metaHtml(f)}`;
  }
  /** The link a row offers: the replay zoomed to the finding's steps, else the replay at its step. */
  function seeHtml(f, label = 'See the steps') {
    const z = zoomHref(f);
    if (z) return `<a class="see" href="${esc(z)}" data-zoomlink aria-label="${esc(`${label}: ${zoomCount(f)}`)}">${esc(label)} <span aria-hidden="true">→</span></a>`;
    const r = replayHref(f);
    return r ? `<a class="see" href="${esc(r)}">${esc(label)} <span aria-hidden="true">→</span></a>` : '';
  }
  function rowHtml(f) {
    return `<li class="frow s-${f.severity === 'look' ? 'look' : 'note'}" data-session="${esc(f.session ?? '')}" data-key="${esc(f.key ?? '')}">
      ${agentTag(f)}${timeHtml(f)}
      <span class="fwhat"><span class="fsess">${esc(sessionLabel(f.session))}</span> ${shortNote(f.note)} ${sym(f.verdictEvidence)}${f.severity === 'look' ? '' : ' <span class="tag">routine</span>'}${f.stillRunning ? ' <span class="tag">may still be running</span>' : ''}
        <details class="fmore"><summary>more</summary><div>${moreHtml(f)}</div></details></span>
      ${seeHtml(f)}
    </li>`;
  }
  function rowsHtml(p, list) {
    const all = expanded.has(p.id);
    // Routine rows count only while "Show routine notes" brings them into view.
    const sorted = [...list.filter((f) => f.severity === 'look'), ...(routineShown ? list.filter((f) => f.severity !== 'look') : [])];
    const showList = all ? sorted : sorted.slice(0, SHOW);
    if (!showList.length) return '';
    return `<ol class="frows">${showList.map(rowHtml).join('')}</ol>${sorted.length > SHOW ? `<button type="button" class="linklike more" data-more="${esc(p.id)}" aria-expanded="${all}">${all ? `Show the first ${SHOW}` : `Show all ${sorted.length} listed`}</button>` : ''}`;
  }

  // ---- the fix, in one line --------------------------------------------------------------------
  function fixRow(p) {
    const d = p.draft;
    if (!d) return '';
    const cx = d.codex;
    const noCodex = codexText(p) ? '' : cx && /^In Codex: /.test(cx.where ?? '') ? ` <a class="fixcx" href="#${esc(p.id)}" data-agent="codex" title="${esc(cx.where)}">Codex: where it goes</a>` : ' <span class="muted fixcx">No Codex version yet</span>';
    return `<div class="fixrow" data-fix="${esc(p.id)}"><b>Fix</b> <span class="fixtitle">${esc(d.title)}</span> <span class="fixbtns">${copyBtn(p, 'fix', 'primary')} ${copyBtn(p, 'codex')}${noCodex}</span>${copyTexts(p)}</div>`;
  }

  // ---- the landing's cards -----------------------------------------------------------------
  const titleLink = (p) => `<a class="ptitle" href="#${esc(p.id)}">${esc(titleOf(p))}</a>`;
  /** A card in "Found in the log": tier, title, its cost and count, its rows, its fix. */
  function cardHtml(p) {
    const list = ofKind(p, 'sure');
    const other = ofKind(p, 'possible').length;
    const c = counts(p);
    const otherN = SESSION ? other : c.poss;
    return `<article class="pc" data-pattern="${esc(p.id)}" data-kind="sure" data-place="${effective(p)?.tier === 'low' ? 'low' : 'top'}">
      <div class="pc-head">${tierPill(p)}<h3 class="pc-title">${titleLink(p)}</h3>${covBadge(p)}${sourcesLink(p)}</div>
      <p class="pc-key">${costHtml(p)}${trendSpan(p, 'sure')}${otherN ? ` <a class="pc-other" href="#${esc(p.id)}">${esc(`${full(otherN)} possible`)}</a>` : ''}</p>
      ${rowsHtml(p, list)}
      ${fixRow(p)}
    </article>`;
  }
  /** The finding a possible card shows: the first worth a look, else the first. */
  const leadOf = (p, kind) => {
    const l = ofKind(p, kind);
    return l.find((f) => f.severity === 'look') ?? l[0] ?? null;
  };
  /** A card in "Possible": what the agent said or ran beside what the log shows. */
  function possCardHtml(p) {
    const f = leadOf(p, 'possible');
    const s = f ? saidOf(f.text) : null;
    const strip = f
      ? `<div class="pc-strip">${s ? `<div class="said"><div class="lbl">${esc(s.label)}</div><div class="body">${saidBody(s, 110)}</div></div>` : ''}<div class="shows"><div class="lbl">The log shows</div><div class="body">${shortNote(f.note, 110)} ${sym(f.verdictEvidence)}</div></div></div>
        <p class="pc-foot">${agentTag(f)}${timeHtml(f)} <span class="fsess">${esc(sessionLabel(f.session))}</span><span class="grow"></span><a class="see" href="#${esc(p.id)}" data-pick="${esc(f.key ?? '')}">See the moment <span aria-hidden="true">→</span></a></p>`
      : '';
    return `<article class="pc pc-poss" data-pattern="${esc(p.id)}" data-kind="possible">
      <div class="pc-head">${tierPill(p)}<h3 class="pc-title">${titleLink(p)}</h3>${covBadge(p)}${trendSpan(p, 'possible')}${sourcesLink(p)}</div>
      ${strip}
    </article>`;
  }
  const rowLine = (p, extra = '') => `<li data-pattern="${esc(p.id)}">${tierPill(p)}${titleLink(p)} ${covBadge(p)}${extra}</li>`;

  // ---- the headline and the line under it ----------------------------------------------------
  const num = (m) => (m && typeof m === 'object' ? m.value : m) ?? 0;
  function header(top, low, possible) {
    const n = D.statusCounts?.found ?? 0;
    const cov = D.coverage ?? {};
    const lvl = sym(cov.sessions?.evidence ?? 'derived');
    // With no session to read, nothing was checked: the page says so instead of "0 showed up".
    const nothing = Number(num(cov.sessions)) === 0 && n === 0;
    const parts = [top.length ? `${plural(top.length, 'problem')} to fix` : 'No problem to fix', low.length ? `${full(low.length)} smaller` : '', possible.length ? `${full(possible.length)} to check` : ''].filter(Boolean);
    $('headline').textContent = nothing ? 'Nothing to check' : !top.length && !low.length && !possible.length ? `Nothing found${partial() ? ' so far' : ''}` : `${parts.join(', ')}${partial() ? ' so far' : ''}`;
    const tokens = cov.usageRecorded && num(cov.tokens) > 0 ? `, ${tok(num(cov.tokens))} tokens ${sym(cov.tokens?.evidence ?? 'recorded')}` : '';
    $('lead').innerHTML = nothing
      ? `No session with a record in ${inWin()} ${lvl}, so nothing was checked${partial() ? ' yet' : ''}. <span id="trendNote" role="status" hidden></span>`
      : `${esc(plural(num(cov.sessions), 'session'))} ${lvl}${tokens} checked${partial() ? ' so far' : ''}. Worst first. <span id="trendNote" role="status" hidden></span>`;
    trendNote();
    if (SESSION) {
      const el = $('sessFilter');
      const fo = D.focus;
      el.hidden = false;
      const r = fo?.thread ? replayHref({ session: SESSION, thread: fo.thread }) : null;
      el.innerHTML = fo && fo.findings
        ? `Showing one session: <span>${esc(fo.title ? `“${fo.title}”` : fo.label ? fo.label : 'an untitled session')}</span>, ${esc(plural(fo.findings, 'finding'))}. ${r ? `<a href="${esc(r)}">Replay it</a> · ` : ''}<a href="problems.html">Show every session</a>`
        : `No findings for that session in ${inWin()}${fo?.known ? '' : ': it may be outside the window, display-only or outside your configured repositories'}. <a href="problems.html">Show every session</a>`;
    }
  }
  /** "41 known problems: 16 found, 3 not found, 22 not checked." */
  function statusLine() {
    const s = D.statusCounts ?? {};
    return `${plural(D.patterns.length, 'known problem')}: ${full(s.found ?? 0)} found, ${full(s.clear ?? 0)} not found, ${full((s.unchecked ?? 0) + (s.undetectable ?? 0))} not checked`;
  }

  // ---- the group filter (a closed fold) ------------------------------------------------------
  const inSession = (p) => !SESSION || (p.findings ?? []).length > 0;
  const shown = () => D.patterns.filter((p) => (!group || p.group === group) && inSession(p));
  function renderFilters() {
    // Hidden while the page is still being checked: a filter over nothing yet.
    $('filterBox').hidden = false;
    const foundAll = D.patterns.filter((p) => p.status === 'found').length;
    $('groups').innerHTML = [
      `<button type="button" class="pgroup" data-group="" aria-pressed="${!group}" title="Every group: ${foundAll} of ${D.patterns.length} found">All<span class="n">${foundAll}</span></button>`,
      ...D.groups.map((g) => {
        const mine = D.patterns.filter((p) => p.group === g.id);
        const f = mine.filter((p) => p.status === 'found').length;
        return `<button type="button" class="pgroup" data-group="${esc(g.id)}" aria-pressed="${group === g.id}" title="${esc(`${g.description} ${f} of ${mine.length} found.`)}">${esc(g.name)}<span class="n">${f}</span><span class="sr"> of ${mine.length} found</span></button>`;
      }),
    ].join('');
    const note = $('filterNote');
    note.hidden = !group;
    note.textContent = group ? `Showing ${shown().length} of ${D.patterns.length} patterns, in ${GROUP.get(group)?.name ?? group}.` : '';
  }

  // ---- the landing ---------------------------------------------------------------------------
  /** The landing's lists, for the group the filter shows, or for every group. */
  function landingLists(everyGroup = false) {
    const list = everyGroup ? D.patterns.filter(inSession) : shown();
    const order = (ps) => window.HWPrefs.order(prefs, ps);
    const at = (place) => list.filter((p) => placeOf(p) === place);
    const main = order(at('main'));
    return { list, main, top: main.filter((p) => effective(p)?.tier !== 'low'), low: main.filter((p) => effective(p)?.tier === 'low'), possible: order(at('possible')), dismissed: order(at('dismissed')) };
  }
  function renderLanding() {
    const { main, top, low, possible, dismissed } = landingLists();
    // The headline counts the whole page, whatever group the filter shows.
    const whole = group ? landingLists(true) : { top, low, possible };
    header(whole.top, whole.low, whole.possible);
    const cards = $('cards');
    const foldsOpen = new Set([...cards.querySelectorAll('details[data-list][open]')].map((d) => d.dataset.list));
    const moreOpen = new Set([...document.querySelectorAll('#landing details.fmore[open]')].map((d) => d.closest('[data-key]')?.dataset.key).filter(Boolean));
    // Routine notes: the ones the cards' rows hold, which "Show routine notes" brings into view.
    const routine = main.reduce((n, p) => n + (SESSION ? ofKind(p, 'sure').filter((f) => f.severity !== 'look').length : Math.max(0, (p.sure?.count ?? 0) - (p.sure?.look ?? 0))), 0);
    const lowBtn = low.length ? `<button type="button" class="pmorebtn" data-low aria-expanded="${lowShown}" aria-controls="tier-low"><span>${esc(`${plural(low.length, 'smaller thing')} found, each low priority`)}</span><span class="act">${lowShown ? 'Hide' : 'Show'}</span></button>` : '';
    const routineBox = routine ? `<label class="quietctl"><input type="checkbox" data-routine-all autocomplete="off"${routineShown ? ' checked' : ''}> Show routine notes (${full(routine)} found)</label>` : '';
    const dis = dismissed.length ? `<details class="restlist dismissed" data-list="dismissed"${foldsOpen.has('dismissed') ? ' open' : ''}><summary>Not a problem, by you <span class="hcount">${dismissed.length}</span></summary><p class="foldnote">Open one and set "My priority" to bring it back.</p><ul class="plist">${dismissed.map((p) => rowLine(p)).join('')}</ul></details>` : '';
    cards.innerHTML = [
      top.length ? `<div class="pcards" data-tier="t-top">${top.map(cardHtml).join('')}</div>` : low.length ? '' : `<p class="muted gempty">${SESSION ? 'Nothing worked out from the log in this session.' : `Nothing worked out from the log in ${inWin()}.`}${possible.length ? ' See Possible below.' : ''}</p>`,
      lowBtn,
      low.length ? `<div class="pcards" data-tier="t-low" id="tier-low"${lowShown ? '' : ' hidden'}>${low.map(cardHtml).join('')}</div>` : '',
      routineBox || dis ? `<div class="pquiet">${routineBox}${dis}</div>` : '',
    ].join('');
    cards.classList.toggle('show-routine', routineShown);
    for (const k of moreOpen) cards.querySelector(`[data-key="${CSS.escape(k)}"] details.fmore`)?.setAttribute('open', '');

    const pos = $('possible');
    $('possSec').hidden = !possible.length;
    const rest = possible.length - POSSIBLE_SHOW;
    pos.innerHTML = possible.length
      ? `${possible.slice(0, POSSIBLE_SHOW).map(possCardHtml).join('')}${rest > 0 ? `<button type="button" class="pmorebtn" data-possmore aria-expanded="${morePossible}" aria-controls="possRest"><span>${esc(plural(rest, 'more possible problem'))}</span><span class="act">${morePossible ? 'Hide' : 'Show'}</span></button><div class="pcards" id="possRest"${morePossible ? '' : ' hidden'}>${possible.slice(POSSIBLE_SHOW).map(possCardHtml).join('')}</div>` : ''}`
      : '';
    $('checkedLine').innerHTML = `<a href="#checked">What was checked</a> <span>${esc(statusLine())}</span>`;
  }

  // ---- what was checked ------------------------------------------------------------------------
  function statusText(p) {
    if (p.status === 'clear') return 'checked, nothing found';
    if (p.status === 'unchecked') return (p.measures ?? []).length ? 'not checked' : 'no check here yet';
    return "can't be checked from logs";
  }
  function renderChecked() {
    const list = D.patterns.filter(inSession);
    const gi = new Map(D.groups.map((g, i) => [g.id, i]));
    const SR = { 'well-established': 0, reported: 1, speculative: 2 };
    const rest = (st) => list.filter((p) => p.status === st).sort((a, b) => gi.get(a.group) - gi.get(b.group) || (SR[a.strength] ?? 3) - (SR[b.strength] ?? 3));
    const open = new Set([...document.querySelectorAll('#restLists details[data-list][open]')].map((d) => d.dataset.list));
    $('checkedLead').textContent = `${statusLine()}.`;
    $('restLists').innerHTML = `<div class="restlists">${[['clear', `Not found in ${inWin()}`], ['unchecked', 'Not checked'], ['undetectable', "Can't be checked from logs"]].map(([st, title]) => {
      const ps = rest(st);
      return ps.length ? `<details class="restlist" data-list="${st}"${open.has(st) ? ' open' : ''}><summary>${esc(title)} <span class="hcount">${ps.length}</span></summary><ul class="plist">${ps.map((p) => rowLine(p, ` <span class="muted">${esc(statusText(p))}</span>`)).join('')}</ul></details>` : '';
    }).join('')}</div>`;
  }
  function priRuleHtml() {
    const PR = D.priorityRule;
    return PR
      ? `<summary>How priority is set</summary><p>Claims not backed come first: ${esc(titleOf(PAT.get('unverified-done-claim') ?? { name: 'says done without checking' }))}, and ${esc(titleOf(PAT.get('claim-contradicts-evidence') ?? { name: 'a success claim the output contradicts' }))}. The rest follow a stated rule, never a score. A pattern's impact comes from its catalog group: ${PR.classes.map((c) => `<b>${esc(c.label.toLowerCase())}</b> (${esc(c.text)})`).join(', ')}.</p><ul>${PR.tiers.map((t) => `<li><b>${esc(t.label)}:</b> ${esc(t.text)}.</li>`).join('')}</ul><p>${esc(PR.counts)} ${esc(PR.order)} ${esc(PR.rest)} "My priority" on a problem's page overrides both, here and on the replay and goal timelines. This browser keeps only the pattern's id and the tier you picked.</p>`
      : '<summary>How priority is set</summary><p>No priority rule came with this answer.</p>';
  }
  /** A published source by its title, linked where its address survived redaction. */
  const sourceLink = (src) => {
    const href = linkOf(src.link);
    return href ? `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(src.title)}</a>` : esc(src.title);
  };
  const OWN = "honestweek's own";
  /** Where a check's numbers come from: one line, and each number behind its "?". A number the
   *  answer doesn't mark either way isn't counted as honestweek's own; it isn't said at all. */
  function numbersHtml(c) {
    const nums = (c.numbers ?? []).filter((n) => n && typeof n.says === 'string' && n.source !== undefined);
    if (!nums.length) return '';
    const from = nums.filter((n) => n.source);
    const titles = [...new Set(from.map((n) => n.source.title))];
    const own = nums.length - from.length;
    const line = !from.length
      ? `${nums.length === 1 ? 'It is' : 'Each is'} ${OWN} choice, not taken from a published source.`
      : `${from.length === 1 ? 'One comes' : `${from.length} come`} from ${titles.map((t) => sourceLink(from.find((n) => n.source.title === t).source)).join(' and ')}${own ? `; ${own === 1 ? 'the other is' : 'the rest are'} ${OWN} choice${own === 1 ? '' : 's'}, not taken from a published source` : ''}.`;
    const each = nums.map((n) => `<li>${esc(n.says)}: ${n.source ? sourceLink(n.source) : `${OWN}`}</li>`).join('');
    return `<p><b>Its numbers.</b> ${line} <details class="help inline"><summary aria-label="Each number and where it comes from">?</summary><ul class="mlist">${each}</ul></details></p>`;
  }
  /** Where the rules behind a check come from: a source beside a rule that rests on one, and one
   *  line for the rules that are honestweek's own. */
  function rulesBasis(used, sourceOf) {
    const own = used.filter((id) => sourceOf.get(id) === null);
    if (!own.length) return '';
    const all = own.length === used.length;
    return `<p class="foldnote">${all ? (used.length === 1 ? 'It is' : 'Each is') : own.length === 1 ? 'The other is' : 'The others are'} ${OWN} rule${!all && own.length > 1 ? 's' : ''}, not taken from a published source.</p>`;
  }
  function checksHtml() {
    const statVal = (s) => (s.unit === 'tokens' ? `${tok(s.value)} tokens` : `<span class="num">${esc(full(s.value))}</span>`);
    const rules = new Map((Array.isArray(D.rules) ? D.rules : []).map((r) => [r.id, r.text]));
    // null: honestweek's own; a source; or absent, when the answer doesn't say.
    const sourceOf = new Map((Array.isArray(D.rules) ? D.rules : []).filter((r) => r.source !== undefined).map((r) => [r.id, r.source]));
    const rulesOf = (c) => [...rules.keys()].filter((id) => c.how.includes(id));
    return `<p class="lead">${D.checks.length} checks read this window's sessions in your configured repositories, in memory. Each keeps fixed words, counts and fingerprints, never text from a log. Display-only and outside sessions aren't checked, as they're left out of lookups and goals.</p>${D.checks.map((c) => {
      const used = rulesOf(c);
      return `<details class="pcheck" id="check-${esc(c.id)}">
        <summary><span class="ptitle">${esc(c.title)}</span> <span class="pmeta">${chip(c.evidence)} <span class="num">${esc(c.ran ? (c.findingsTotal ? plural(c.findingsTotal, 'finding') : 'nothing found') : 'not run')}</span></span></summary>
        <div class="pbody">
          <p><b>Measures.</b> ${(c.patterns ?? []).filter((id) => PAT.has(id)).map((id) => { const src = sourcesLink(PAT.get(id)); return `<a href="#${esc(id)}">${esc(titleOf(PAT.get(id)))}</a>${src ? ` <span class="nowrap">(${src})</span>` : ''}`; }).join('; ')}</p>
          <p><b>How this is known.</b> ${esc(c.how)} Its findings are ${chip(c.evidence)} or stronger where marked.</p>
          ${numbersHtml(c)}
          ${c.ran ? `<p><b>Checked.</b> ${esc(c.checked)}</p>` : `<p><b>Not run.</b> ${esc(c.notRun ?? '')}</p>`}
          ${c.stats?.length ? `<ul class="stgrid">${c.stats.map((s) => `<li><span class="sl">${esc(s.label)}</span> <span class="sv">${statVal(s)} ${s.evidence ? chip(s.evidence) : ''}</span></li>`).join('')}</ul>` : ''}
          ${used.length ? `<details class="rules"><summary>The ${used.length === 1 ? 'rule' : `${used.length} rules`} behind it</summary><dl>${used.map((id) => `<dt><code>${esc(id)}</code></dt><dd>${esc(rules.get(id))}${sourceOf.get(id) ? ` From ${sourceLink(sourceOf.get(id))}.` : ''}</dd>`).join('')}</dl>${rulesBasis(used, sourceOf)}</details>` : ''}
        </div>
      </details>`;
    }).join('')}`;
  }
  function footHtml() {
    const cov = D.coverage ?? {};
    const checked = (D.catalog?.checkedOn ?? []).join(', ');
    return `<summary><h2 class="sh">About this page</h2></summary>
      <p><b>Worth a look, never a verdict.</b> Each pattern can be legitimate, and no finding says why it happened.</p>
      <p><b>Found in the log, and Possible.</b> "Found in the log" holds findings worked out from the log alone (${chip('recorded')} or ${chip('derived')}). "Possible" holds the rest: ${chip('inferred')} a named rule decided it and could be wrong, ${chip('missing')} a record the check expected isn't in the logs. Nothing is hidden for good; each card says how many of each kind.</p>
      <p><b>Now and before.</b> A card's count is its findings worth a look in this window, then the count for the window of the same length just before it. When that earlier window has no logs, the line under the headline says so; when a pattern's check couldn't run there, its card says so instead of showing zero.</p>
      <p><b>Which agent.</b> Each finding names the agent its session ran on. A card says "Partial on Codex" or "Not on Codex yet" (or the same for Claude Code) when its check reads that agent's logs only in part or not at all; with no such mark, the check runs on both.</p>
      <p><b>The catalog.</b> ${esc(D.catalog?.about ?? '')} Its ${esc(full(D.catalog?.sources ?? 0))} sources were checked on ${esc(checked || 'the dates the catalog records')}.</p>
      <p><b>Detection is from local logs only.</b> Nothing here calls out to the web or reads anything but the session files this page already read. "Not checked" means a pattern wasn't looked for, so it says nothing about whether it happened; "can't be checked from logs" means the catalog says a log can't show it.</p>
      <p><b>What the counts cover.</b> ${esc(plural(num(cov.sessions), 'session'))} in your configured repositories with records in this window, ${esc(plural(num(cov.toolCalls), 'tool call'))}${cov.usageRecorded ? ` and ${esc(plural(num(cov.modelCalls), 'model call'))} with token counts (${tok(num(cov.tokens))} tokens in all)` : ', and no token counts, so the checks that measure tokens didn\'t run'}. Token estimates overlap between checks, so they don't add up to a total.</p>
      <p><b>Fixes are for you to adopt.</b> Copy puts the catalog's draft on your clipboard. Nothing on this page changes your settings, hooks, skills or instructions.</p>`;
  }

  // ---- one problem, opened -------------------------------------------------------------------
  /** The catalog's text about a pattern, in one closed fold: what it is, why it matters, how it's
   *  detected here, and its published sources. */
  function aboutHtml(p) {
    const kinds = Object.entries(p.sourceKinds ?? {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${KINDS[k]?.[n === 1 ? 0 : 1] ?? k}`).join(', ');
    const measures = (p.measures ?? []).length
      ? `<p>Counted here by:</p><ul class="mlist">${p.measures.map((m) => `<li><a href="#check-${esc(m.check)}" data-check="${esc(m.check)}">${esc(m.title)}</a> ${chip(m.evidence)} <span class="num">${esc(m.ran ? plural(m.count, 'finding') : 'not run')}</span><br><span class="rel">${esc(m.relation)}</span>${m.ran ? '' : `<br><span class="muted">${esc(m.notRun ?? '')}</span>`}</li>`).join('')}</ul>`
      : p.status === 'undetectable' ? "<p>The catalog says a session log can't show this. It names proxies a later check could use:</p>" : "<p>No check here looks for this yet. The catalog's signal, for a check to come:</p>";
    const level = p.detection.level === 'not-detectable' ? 'Logs alone cannot show it.' : `The most a log check can claim: ${chip(p.detection.level)}`;
    const cc = coverOf(p, 'claudeCode');
    const cx = coverOf(p, 'codex');
    const where = cc && cx && (p.measures ?? []).length ? `<p class="fine covline">Its check on Claude Code: ${esc(cc.status)}${cc.why ? ` (${esc(cc.why)})` : ''}. On Codex: ${esc(cx.status)}${cx.why ? ` (${esc(cx.why)})` : ''}.</p>` : '';
    const detect = `${measures}${where}<p><b>The catalog's signal.</b> ${esc(p.detection.summary)} <span class="nowrap">${level}</span></p>
      <details class="rules"><summary>${plural(p.detection.signals.length, 'signal')} and ${plural(p.detection.falsePositives.length, 'known false alarm')}</summary>
        <p class="subhead">Signals</p><ul class="mlist">${p.detection.signals.map((s) => `<li>${esc(s.signal)} ${chip(s.level)}</li>`).join('')}</ul>
        <p class="subhead">Known false alarms</p><ul class="mlist">${p.detection.falsePositives.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </details>`;
    const sources = `<ol class="srcs">${p.sources.map((s) => {
      const href = linkOf(s.link);
      return `<li>${href ? `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(s.title)}</a>` : `<span>${esc(s.title)}</span> <span class="muted">(its address is hidden by redaction)</span>`} <span class="tag">${esc(KIND1[s.kind] ?? s.kind)}</span> <span class="smeta">${esc(s.date ?? '')}</span>${s.says ? `<span class="says">${esc(s.says)}</span>` : ''}</li>`;
    }).join('')}</ol>`;
    const related = (p.related ?? []).filter((r) => PAT.has(r));
    return `<details class="pmore" data-about="${esc(p.id)}"><summary>Why it matters, and the published sources</summary>
      <section><h3>About this problem</h3><p>The catalog names it “<span class="pname">${esc(p.name)}</span>”. ${esc(p.looksLike)}</p></section>
      <section><h3>Why it matters</h3><p>${esc(p.whyItMatters)}</p></section>
      <section><h3>How strong the evidence is that it's common</h3><p><span class="tag">${esc(STRENGTH[p.strength] ?? p.strength)}</span> ${esc(p.strengthReason)}</p><p class="fine">Known from ${esc(plural(p.sources.length, 'source'))}: ${esc(kinds)}. <a href="#src-${esc(p.id)}" data-src="${esc(p.id)}">Sources</a></p></section>
      <h3>How it's detected here</h3>${detect}
      <h3 id="src-${esc(p.id)}" tabindex="-1">Sources</h3><p class="fine">Each opens the published page in a new tab when you click it; this page fetches nothing.</p>${sources}
      ${related.length ? `<p class="related"><b>Related:</b> ${related.map((r) => `<a href="#${esc(r)}">${esc(titleOf(PAT.get(r)))}</a>`).join(' ')}</p>` : ''}
    </details>`;
  }
  /** The findings a problem's "When" lists, its card's kind first. */
  function momentsOf(p) {
    const kind = kindOf(p);
    return [...ofKind(p, kind), ...ofKind(p, kind === 'sure' ? 'possible' : 'sure')];
  }
  function selectedOf(p) {
    const list = momentsOf(p);
    const want = pick.get(p.id);
    return list.find((f) => f.key && f.key === want) ?? leadOf(p, kindOf(p)) ?? list[0] ?? null;
  }
  function whenHtml(p, sel) {
    const kind = kindOf(p);
    const list = momentsOf(p);
    if (!list.length) return '';
    const all = whenAll.has(p.id) || list.indexOf(sel) >= WHEN_SHOW;
    const shownList = all ? list : list.slice(0, WHEN_SHOW);
    const first = ofKind(p, kind).length;
    const btn = (f, i) => `${i === first && i > 0 ? `<p class="whensub">${kind === 'sure' ? 'Possible' : 'Found in the log'}</p>` : ''}<button type="button" class="moment" data-moment="${esc(f.key ?? '')}" aria-pressed="${f === sel}">
        <span class="mline">${agentTag(f)}${timeHtml(f)}${f.severity === 'look' ? '' : ' <span class="tag">routine</span>'}</span>
        <span class="msess">${esc(sessionLabel(f.session))}</span>${f.kind ? `<span class="mkind">${esc(/\s/.test(f.kind) ? f.kind : String(f.kind).replace(/-/g, ' '))}</span>` : ''}
      </button>`;
    const c = counts(p);
    const truncated = !SESSION && p.count > list.length;
    return `<section class="pd-when" aria-labelledby="whenH"><h2 id="whenH" class="eyebrow">When</h2>
      ${shownList.map(btn).join('')}
      ${list.length > WHEN_SHOW ? `<button type="button" class="whenmore" data-whenmore="${esc(p.id)}" aria-expanded="${all}">${all ? `Show the first ${WHEN_SHOW}` : `${full(list.length - WHEN_SHOW)} more`}</button>` : ''}
      ${truncated ? `<p class="fine muted">The first ${full(list.length)} of ${full(c.sure + c.poss)} listed. Open one session's view for the rest.</p>` : ''}
    </section>`;
  }
  /** What happened at one finding: the check's note, each part of it with how it's known, then
   *  the agent's own words or command. */
  function momentHtml(f) {
    if (!f) return '';
    const s = saidOf(f.text);
    const steps = Array.isArray(f.basis) && f.basis.length
      ? f.basis.map((b) => ({ head: b.part, body: `<p>${esc(b.how)}</p>`, level: b.level }))
      : [{ head: 'What the log shows', body: `<p>${esc(f.note)}</p>`, level: f.verdictEvidence }];
    if (s) steps.push({ head: s.label, body: `<blockquote class="${s.code ? 'cmd' : 'words'}">${s.code ? `<code>${esc(s.body)}</code>` : esc(s.body)}</blockquote>${s.result ? `<p class="muted">Result: ${esc(s.result)}</p>` : ''}`, level: 'recorded', said: true });
    const z = zoomHref(f) ?? replayHref(f);
    return `<div class="pd-momenthead"><h2 id="momentH">What happened</h2>${z ? `<a class="see" href="${esc(z)}"${zoomHref(f) ? ` data-zoomlink aria-label="${esc(`Open in Replay: ${zoomCount(f)}`)}"` : ''}>Open in Replay <span aria-hidden="true">→</span></a>` : ''}</div>
      <p class="pd-meta">${agentTag(f)}${timeHtml(f)} <span class="fsess">${esc(sessionLabel(f.session))}</span>${f.stillRunning ? ' <span class="tag">may still be running</span>' : ''}</p>
      ${Array.isArray(f.basis) && f.basis.length ? `<p class="pd-note">${esc(f.note)} ${sym(f.verdictEvidence)}</p>` : ''}
      <ol class="pd-steps">${steps.map((x, i) => `<li${x.said ? ' class="said"' : ''}><span class="stepn" aria-hidden="true">${i + 1}</span><div class="stepb"><b>${esc(x.head)}</b>${x.body}</div><span class="steplvl">${chip(x.level)}</span></li>`).join('')}</ol>
      ${linksHtml(f)}${metaHtml(f)}`;
  }
  function fixHtml(p, sel) {
    const d = p.draft;
    if (!d) return '';
    const agent = fixAgent ?? (sel && agentOf(sel) === 'Codex' ? 'codex' : 'claude');
    const cx = d.codex;
    const tabs = [['claude', 'Claude Code'], ['codex', 'Codex']].map(([k, label]) => `<button type="button" data-fixagent="${k}" aria-pressed="${agent === k}">${label}</button>`).join('');
    const ct = codexText(p);
    const body = agent === 'codex'
      ? `<p class="fixwhere"><strong>${esc(d.title)}</strong> <span class="muted">${esc(cx?.where ?? 'No Codex equivalent yet.')}</span></p>${ct ? `<pre class="fixtext" data-copytext="codex">${esc(ct)}</pre><p class="fixacts">${copyBtn(p, 'codex', 'primary')} <span class="muted">honestweek never edits your settings. You paste it.</span></p>` : '<p class="muted">No Codex version of the text yet.</p>'}`
      : `<p class="fixwhere"><strong>${esc(d.title)}</strong> <span class="muted">${esc(d.where)}.</span></p><pre class="fixtext" data-copytext="fix">${esc(d.text)}</pre><p class="fixacts">${copyBtn(p, 'fix', 'primary')} <span class="muted">honestweek never edits your settings. You paste it.</span></p>`;
    const ways = p.mitigation ?? [];
    return `<section class="pd-box pd-fix" aria-labelledby="fixH"><div class="pd-boxhead"><h2 id="fixH">Stop it happening again</h2><div class="seg" role="group" aria-label="Agent">${tabs}</div></div>
      <span class="tag">${esc(FIXKIND[d.kind] ?? d.kind)}</span>${body}
      ${ways.length ? `<details class="otherways"><summary>${esc(plural(ways.length, 'other way'))}</summary><ul class="mitig">${ways.map((m) => `<li><span class="tag">${esc(FIXKIND[m.kind] ?? m.kind)}</span> ${esc(m.action)}</li>`).join('')}</ul></details>` : ''}
    </section>`;
  }
  function tryHtml(p) {
    if (!p.testPrompt) return '';
    // It names Codex only where the pattern's check runs on Codex's logs.
    const onCodex = coverOf(p, 'codex');
    const tryWhere = onCodex?.status === 'runs'
      ? '<p>Paste it into Claude Code or Codex after adding the fix, and the fix should catch it. A suggestion only: it may not trigger every time.</p>'
      : `<p>Paste it into Claude Code after adding the fix, and the fix should catch it. A suggestion only: it may not trigger every time. ${onCodex?.status === 'partial' ? 'On Codex it may not be caught yet' : "On Codex the check can't catch it yet"}${onCodex?.why ? `: ${esc(onCodex.why)}` : ''}.</p>`;
    const tag = p.testTag ? ` <span class="trytag">${esc(p.testTag)}</span>` : '';
    return `<section class="pd-box pd-try" aria-labelledby="tryH"><h2 id="tryH">Check the fix works</h2>${tryWhere}
      ${trySetupHtml(p)}<div class="tryrow"><code class="trytext" data-copytext="try">${esc(p.testPrompt)}${tag}</code>${copyBtn(p, 'try')}${p.testTag ? why('About the tag', TAG_WHY) : ''}</div>${trackHtml(p)}${tryCostHtml(p)}${tryExpectHtml(p)}</section>`;
  }

  // ---- tests of a fix: the tagged sessions (lib/problems/fix-tests.mjs) -------------------------
  const TAG_WHY = "<p>The tag lets honestweek find this test in your logs, then say whether the fix fired and whether the problem showed up anyway. Run it in a session started in one of your repositories: honestweek reads only those.</p>";
  const TOOL_NAME = { 'claude-code': 'Claude Code', codex: 'Codex' };
  const FIRED_WORD = { fired: 'fired', none: 'no sign it fired', loaded: "its words were in the session's instructions", 'not-loaded': "not in the session's instructions" };
  const FIRED_WHY = { 'no-trace': 'this kind of fix leaves nothing in a log', unread: "the log couldn't be read", 'no-instructions-record': "this log doesn't record its instructions" };
  const PROBLEM_WORD = { seen: 'seen', 'not-seen': 'not seen' };
  const PROBLEM_WHY = { 'no-check': 'no check for it yet', 'not-on-agent': "its check doesn't run on this agent yet", 'not-run': "its check didn't run", 'too-short': "a test this short can't show it", running: 'the session may still be running' };
  /** "every time", "both times", "2 of 3 times": how many of `n` tests had `k`. */
  const howOften = (k, n) => (k === n ? (n === 1 ? '' : n === 2 ? ' both times' : ' every time') : ` ${k} of ${full(n)} times`);
  /** The fix's part of the line: fired, loaded, or no sign. A fix the log can't show says nothing. */
  function firedPart(ts) {
    const k = (s) => ts.filter((t) => t.fired?.state === s).length;
    if (k('fired')) return `fired${howOften(k('fired'), ts.length)}`;
    if (k('loaded')) return `in its instructions${howOften(k('loaded'), ts.length)}`;
    if (k('none')) return 'no sign it fired';
    if (k('not-loaded')) return 'not in its instructions';
    return '';
  }
  /** The problem's part: seen, not seen, or why a test can't tell. Never "fixed". */
  function problemPart(ts) {
    const seen = ts.filter((t) => t.problem?.state === 'seen').length;
    if (seen) return `problem seen${ts.length === 1 ? '' : seen === 1 ? ' once' : ` ${full(seen)} times`}`;
    const not = ts.filter((t) => t.problem?.state === 'not-seen').length;
    if (not) return `problem not seen${not === ts.length ? '' : ` in ${full(not)} of ${full(ts.length)}`}`;
    const w = ts.find((t) => t.problem?.why)?.problem.why;
    return w === 'too-short' || w === 'running' ? PROBLEM_WHY[w] : '';
  }
  /** The track record of this version of the fix, on one line, each test a link to its session in
   *  Replay; per test what fired and what was seen, each with how it's known, behind its "?". */
  function trackHtml(p) {
    if (!p.testTag) return '';
    const all = p.fixTests ?? [];
    const cur = all.filter((t) => t.version === p.fixVersion);
    const old = all.length - cur.length;
    const earlier = old ? `Earlier versions of this fix: tested ${old === 1 ? 'once' : `${full(old)} times`}.` : '';
    if (!cur.length) return earlier ? `<div class="trytrack muted">${esc(earlier)}</div>` : '';
    const n = cur.length;
    const parts = [firedPart(cur), problemPart(cur)].filter(Boolean);
    const line = `Tested ${n === 1 ? 'once' : `${full(n)} times`}${parts.length ? `: ${parts.join(', ')}` : ''}.`;
    const links = cur.map((t, i) => {
      const h = replayHref({ session: t.session, thread: t.thread }, t.event);
      return h ? `<a href="${esc(h)}">${n === 1 ? 'Open the test' : `Test ${i + 1}`}</a>` : '';
    }).filter(Boolean).join(' ');
    const rows = cur.map((t, i) => `<li>${n > 1 ? `<b>Test ${i + 1}</b> ` : ''}<time datetime="${esc(t.at)}">${esc(when(t.at))}</time> ${esc(TOOL_NAME[t.tool] ?? '')}<br>The fix: ${esc(FIRED_WORD[t.fired?.state] ?? FIRED_WHY[t.fired?.why] ?? 'not known')} ${chip(t.fired?.level ?? 'missing')}<br>The problem: ${esc(PROBLEM_WORD[t.problem?.state] ?? PROBLEM_WHY[t.problem?.why] ?? 'not known')} ${chip(t.problem?.level ?? 'missing')}</li>`).join('');
    const more = `<ul class="mlist">${rows}</ul>${earlier ? `<p class="fine">${esc(earlier)}</p>` : ''}<p class="fine">A fix fired when its own words are in a hook's record after the prompt. An instruction leaves no trace when followed, so the most a log shows is that it was loaded. Not seeing the problem on a test is a hint, not proof.</p>`;
    return `<div class="trytrack">${esc(line)} ${links} ${why('About these tests', more)}</div>`;
  }
  /** The temporary change a test prompt needs first, and how to put it back, on one line. */
  function trySetupHtml(p) {
    const s = p.testSetup;
    if (!s?.do) return '';
    return `<p class="trystep"><b>First:</b> ${esc(s.do)}${s.undo ? ` <b>After:</b> ${esc(s.undo)}` : ''}</p>`;
  }
  /** A warning when the prompt costs many tokens, with the catalog's reason behind its "?". */
  function tryCostHtml(p) {
    if (p.testCost !== 'high') return '';
    return `<div class="trycost"><span class="tag costly">High token use</span>${p.testCostWhy ? ` ${why('Why it uses many tokens', `<p>${esc(p.testCostWhy)}</p>`)}` : ''}</div>`;
  }
  /** What the fix working looks like, on one line; what failing looks like, where to look and
   *  what Replay shows sit behind its "?". */
  function tryExpectHtml(p) {
    const x = p.testExpect;
    if (!x?.works) return '';
    const more = [['If it didn\'t work', x.fails], ['Where to look', x.look], ['In Replay', x.replay]]
      .filter(([, t]) => t).map(([h, t]) => `<p><b>${h}:</b> ${esc(t)}</p>`).join('');
    return `<div class="tryexpect"><b>What you should see:</b> ${esc(x.works)}${more ? ` ${why('More on what to look for', more)}` : ''}</div>`;
  }
  function priHtml(p) {
    const e = effective(p);
    if (!e) return '';
    const reason = `${p.claim && !e.mine ? 'A claim not backed, so it comes first. ' : ''}Why ${esc(TIER_LABEL[e.rule].toLowerCase())}: ${esc(p.priority.reason)}.`;
    const select = `<label class="pmine"><span class="sr">My priority</span><select data-pri="${esc(p.id)}">${['high', 'medium', 'low', 'dismissed'].map((t) => `<option value="${t}"${e.tier === t ? ' selected' : ''}>${esc(TIER_LABEL[t])}${t === e.rule ? " (the rule's)" : ''}</option>`).join('')}</select></label>`;
    return `<section class="pd-box pd-pri" aria-labelledby="priH"><h2 id="priH">My priority</h2>${select}
      <p class="pwhy">${e.mine ? `<b>you set this</b>. The rule says ${esc(TIER_LABEL[e.rule].toLowerCase())}. ` : ''}${reason}</p></section>`;
  }
  function detailHtml(p) {
    const sel = selectedOf(p);
    const kind = kindOf(p);
    // The kind the page names: the card's own, or the other when the card's holds none.
    const other = kind === 'sure' ? 'possible' : 'sure';
    const seen = !ofKind(p, kind).length && ofKind(p, other).length ? other : kind;
    const e = effective(p);
    const level = p.status === 'found' ? levelOf(p, seen) : null;
    const how = p.status !== 'found' ? `<span class="muted">${esc(STATUS[p.status]?.word ?? '')}</span>`
      : placeOf(p) === 'dismissed' ? '<span class="muted">Not a problem, by you</span>'
      : seen === 'sure' ? `<span class="muted">Found in the log</span> ${level ? chip(level) : ''}`
      : `<span class="muted">Possible: check it yourself</span> ${level ? chip(level) : ''}`;
    const statusBody = p.status === 'found' ? ''
      : p.status === 'clear' ? `<p class="muted">Checked; nothing found in ${inWin()}.</p>`
      : p.status === 'unchecked' ? `<p class="muted">${p.notRun ? `Not checked. ${esc(p.notRun)} This` : 'Not checked, so this'} says nothing about whether it happened.</p>`
      : '<p class="muted">Not checkable from logs.</p>';
    const back = `<a class="backlink" href="problems.html${SESSION ? `?session=${encodeURIComponent(SESSION)}` : ''}" data-home><span aria-hidden="true">←</span> All problems</a>`;
    return `${back}
      <div class="pd-head">
        <p class="pd-tier">${e ? tierPill(p) : ''} ${how} ${covBadge(p)}</p>
        <h1 id="detailH" tabindex="-1">${esc(titleOf(p))}</h1>
        ${p.status === 'found' ? `<p class="pc-key">${trendSpan(p, kind)} ${costHtml(p)}</p>` : statusBody}
      </div>
      ${p.status === 'found' && sel
        // The fix and what follows sit in the right-hand column, under What happened, beside When.
        ? `<div class="pd-grid">${whenHtml(p, sel)}<div class="pd-main"><section class="pd-moment" id="moment" aria-labelledby="momentH">${momentHtml(sel)}</section>${fixHtml(p, sel)}${tryHtml(p)}${priHtml(p)}${aboutHtml(p)}</div></div>`
        : `${fixHtml(p, sel)}${tryHtml(p)}${priHtml(p)}${aboutHtml(p)}`}`;
  }

  // ---- views ------------------------------------------------------------------------------------
  function show(name, id = null, { focus = true, restoreY = null } = {}) {
    const was = view;
    if (was?.name === 'landing' && name !== 'landing') landingY = Math.round(window.scrollY);
    view = { name, id };
    $('landing').hidden = name !== 'landing';
    $('detail').hidden = name !== 'problem';
    $('checkedView').hidden = name !== 'checked';
    document.body.dataset.view = name;
    if (name === 'problem') {
      const p = PAT.get(id);
      $('detail').innerHTML = detailHtml(p);
      document.title = `${titleOf(p)} · Problems · honestweek`;
    } else document.title = name === 'checked' ? 'What was checked · Problems · honestweek' : 'Problems · honestweek';
    if (name === 'checked') renderChecked();
    if (restoreY != null) window.scrollTo(0, restoreY);
    else if (name === 'landing') window.scrollTo(0, was && was.name !== 'landing' ? landingY : window.scrollY);
    else window.scrollTo(0, 0);
    if (!focus) return;
    if (name === 'landing') {
      // Back from a problem: focus its title on the card, where the reader left.
      const link = was?.id ? document.querySelector(`#landing [data-pattern="${CSS.escape(was.id)}"] a.ptitle`) : null;
      if (link && !link.closest('[hidden]')) link.focus({ preventScroll: true });
    } else (name === 'problem' ? $('detailH') : $('checkedH'))?.focus({ preventScroll: true });
  }
  /** The view the address names: #checked, #<pattern id>, or the landing. */
  function route(opts) {
    const id = location.hash.slice(1);
    const [name, pid] = id === 'checked' ? ['checked', null] : PATTERN_ID.test(id) && PAT.has(id) ? ['problem', id] : ['landing', null];
    // Back fires both hashchange and popstate: the second finds the view already shown.
    if (view && view.name === name && view.id === pid) return;
    show(name, pid, opts);
  }
  /** Open a problem's "Why it matters, and the published sources" fold at its Sources. */
  function openSources(id) {
    const h = document.getElementById(`src-${id}`);
    h?.closest('details')?.setAttribute('open', '');
    h?.scrollIntoView({ block: 'start' });
    h?.focus({ preventScroll: true });
  }
  /** Redraw the problem view in place, keeping focus on the control that changed it. */
  function redrawDetail(sel) {
    if (view?.name !== 'problem') return;
    const y = Math.round(window.scrollY);
    $('detail').innerHTML = detailHtml(PAT.get(view.id));
    window.scrollTo(0, y);
    if (sel) $('detail').querySelector(sel)?.focus({ preventScroll: true });
  }

  // ---- wiring ------------------------------------------------------------------------------------
  function wire() {
    $('groups').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-group]');
      if (!b) return;
      group = b.dataset.group || null;
      renderFilters();
      renderLanding();
      fillTrends();
      $('groups').querySelector(`[data-group="${CSS.escape(group ?? '')}"]`)?.focus();
      $('announce').textContent = `Showing ${shown().length} of ${D.patterns.length} patterns`;
    });
    const content = $('content');
    content.addEventListener('change', (ev) => {
      if (ev.target.matches?.('[data-routine-all]')) {
        routineShown = ev.target.checked;
        renderLanding();
        fillTrends();
        $('cards').querySelector('[data-routine-all]')?.focus();
        return;
      }
      const sel = ev.target.closest('[data-pri]');
      if (!sel) return;
      const p = PAT.get(sel.dataset.pri);
      if (p) prefs.setTier(p.id, sel.value, p.priority?.tier);
    });
    prefs.onChange(() => {
      const was = document.activeElement?.dataset?.pri;
      renderLanding();
      fillTrends();
      HW.navCount(D.patterns);
      if (view?.name === 'problem') redrawDetail(was ? `[data-pri="${CSS.escape(was)}"]` : null);
      if (view?.name === 'checked') renderChecked();
      if (was) {
        const e = effective(PAT.get(was));
        $('announce').textContent = e ? `${titleOf(PAT.get(was))}: ${e.tier === 'dismissed' ? 'moved to Not a problem' : `${TIER_LABEL[e.tier]} priority${e.mine ? ', set by you' : ", the rule's"}`}` : '';
      }
    });
    content.addEventListener('click', (ev) => {
      const cb = ev.target.closest('[data-copy]');
      if (cb) {
        const p = PAT.get(cb.dataset.for);
        const text = p ? copySource(p, cb.dataset.copy) : null;
        if (text) copyText(text, cb, cb.closest('[data-fix], .pd-box')?.querySelector(`[data-copytext="${CSS.escape(cb.dataset.copy)}"]`));
        return;
      }
      // "N smaller things": the Low tier, one click away.
      if (ev.target.closest('[data-low]')) {
        lowShown = !lowShown;
        renderLanding();
        fillTrends();
        $('cards').querySelector('[data-low]')?.focus();
        return;
      }
      if (ev.target.closest('[data-possmore]')) {
        morePossible = !morePossible;
        renderLanding();
        fillTrends();
        $('possible').querySelector('[data-possmore]')?.focus();
        return;
      }
      const more = ev.target.closest('[data-more]');
      if (more) {
        const id = more.dataset.more;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        renderLanding();
        fillTrends();
        $('cards').querySelector(`[data-more="${CSS.escape(id)}"]`)?.focus();
        return;
      }
      // One problem: pick a moment, switch the fix's agent, show every moment.
      const m = ev.target.closest('[data-moment]');
      if (m && view?.name === 'problem') {
        pick.set(view.id, m.dataset.moment);
        redrawDetail(`[data-moment="${CSS.escape(m.dataset.moment)}"]`);
        const f = selectedOf(PAT.get(view.id));
        $('announce').textContent = f ? `${agentOf(f) ?? 'A session'}, ${when(f.at)}` : '';
        return;
      }
      const fa = ev.target.closest('[data-fixagent]');
      if (fa) {
        fixAgent = fa.dataset.fixagent;
        redrawDetail(`[data-fixagent="${fixAgent}"]`);
        return;
      }
      const wm = ev.target.closest('[data-whenmore]');
      if (wm) {
        const id = wm.dataset.whenmore;
        if (whenAll.has(id)) whenAll.delete(id);
        else whenAll.add(id);
        redrawDetail(`[data-whenmore="${CSS.escape(id)}"]`);
        return;
      }
      // "See the moment" and "Codex: where it goes" open the problem at that finding or that agent.
      const pk = ev.target.closest('a[data-pick]');
      if (pk) pick.set(pk.getAttribute('href').slice(1), pk.dataset.pick);
      const ag = ev.target.closest('a[data-agent]');
      if (ag) fixAgent = ag.dataset.agent;
      const home = ev.target.closest('a[data-home]');
      if (home) {
        ev.preventDefault();
        history.pushState(null, '', `${location.pathname}${location.search}`);
        route();
        return;
      }
      const src = ev.target.closest('a[data-src]');
      if (src) {
        ev.preventDefault();
        openSources(src.dataset.src);
        return;
      }
      // A card's Sources: the problem's page, opened at its published sources.
      const srcs = ev.target.closest('a[data-sources]');
      const id = srcs?.dataset.sources;
      if (id && PAT.has(id)) {
        ev.preventDefault();
        history.pushState(null, '', `#${id}`);
        show('problem', id, { focus: false });
        openSources(id);
        return;
      }
      const c = ev.target.closest('a[data-check]');
      if (c) {
        ev.preventDefault();
        history.pushState(null, '', '#checked');
        route({ focus: false });
        const d = document.getElementById(`check-${c.dataset.check}`);
        if (!d) return;
        $('checksBox').setAttribute('open', '');
        d.setAttribute('open', '');
        d.scrollIntoView({ block: 'start' });
        d.querySelector('summary')?.focus({ preventScroll: true });
      }
    });
    window.addEventListener('hashchange', () => route());
    window.addEventListener('popstate', () => route());
    // Leaving for a replay: this entry keeps the "Show all" lists, the moment picked and the
    // scroll position, so Back returns here.
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[href^="replay.html"]');
      if (!a || ev.defaultPrevented) return;
      const state = { ...(history.state ?? {}), y: Math.round(window.scrollY), more: [...expanded], pick: [...pick].filter(([id, k]) => PATTERN_ID.test(id) && FINDING_KEY.test(k ?? '')) };
      const want = location.href;
      history.replaceState(state, '', want);
    });
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
    const back = history.state;
    for (const id of back?.more ?? []) if (PAT.has(id)) expanded.add(id);
    for (const [id, k] of Array.isArray(back?.pick) ? back.pick : []) if (PAT.has(id) && FINDING_KEY.test(k ?? '')) pick.set(id, k);
    if (SESSION) TREND = false;
    renderFilters();
    renderLanding();
    HW.navCount(D.patterns);
    $('priRule').innerHTML = priRuleHtml();
    $('checks').innerHTML = checksHtml();
    $('foot').innerHTML = footHtml();
    wire();
    route({ focus: !!location.hash.slice(1), restoreY: back && Number.isFinite(back.y) ? back.y : null });
    // The optional /insights group (insights.js): its own answer, drawn apart from these counts.
    window.HWInsights?.load();
    // The window's plain facts (facts.js), in a closed fold of their own.
    window.HWFacts?.load(SESSION ? { session: SESSION } : {});
    // The trend reads the window before this one, which can take a while: the cards show this
    // window's counts until it answers.
    if (!SESSION) {
      trendNote();
      // The week before loads newest day first: while it's partial, ask again until all of it is in.
      const askTrend = () => HW.load('problems', { trend: '1' }).then(
        (a) => {
          TREND = a && Array.isArray(a.trend) ? { trend: Object.fromEntries(a.trend.filter((t) => t && PATTERN_ID.test(t.id ?? '')).map((t) => [t.id, t])), earlier: a.earlier ?? null, waiting: a.waiting ?? null } : false;
          fillTrends();
          if (TREND && TREND.earlier?.partial) setTimeout(askTrend, 3000);
        },
        () => {
          TREND = false;
          fillTrends();
        },
      );
      askTrend();
    }
  });
})();
