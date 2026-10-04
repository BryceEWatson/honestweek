// The Find page: one box for a reference (a pull request, a commit, a file, a branch) or words.
// References go to /api/lookup, words to /api/words, and the same words search every session on
// this machine through /api/search. Every result is the server's, with its evidence level; the
// page only arranges them. With an empty box it shows three cards: the problems worth a look
// (from /api/problems?summary=1), recent sessions in your repos, and your goals.
//
// The address never holds what was typed. The first request for a query sends its text; the
// answer carries a query id, and the address gets #q=<query id>~<l|w> (lookup or words). On
// load with that, the page asks again by id and puts the answer's query text back in the box,
// so Back, reload and the switch's reload all restore the search.
(function () {
  'use strict';
  const { esc, plural, chip, chips, sym, time, toT, num, lvl, nothingIn, windowText, isId } = HW;
  const $ = (id) => document.getElementById(id);
  const input = $('q');
  const out = $('out');
  let HOME = null;
  const sessionInfo = new Map();
  const goalInfo = new Map();
  const similarOf = new Map();
  let seq = 0;
  let moreSeq = 0;
  out.dataset.seq = '0';
  out.dataset.state = 'idle';

  // ---- small pieces --------------------------------------------------------------------
  const toolName = (t) => (t === 'codex' ? 'Codex' : t === 'claude-code' ? 'Claude Code' : t ? String(t) : 'Unknown tool');
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  /** When a session ran, with its level as a symbol (the word stays for a screen reader). */
  const when = (s) => {
    const a = toT(s.firstAt);
    const b = toT(s.lastAt);
    if (!Number.isFinite(a)) return '';
    return `${time(a, { day: true })}${Number.isFinite(b) && b - a > 60e3 ? ` to ${time(b, { day: HW.dayOf(a) !== HW.dayOf(b) })}` : ''} ${sym('recorded')}`;
  };
  /** Several counts on one line, with one level: the weakest of theirs. */
  const counts = (list) => {
    const shown = list.filter(([m]) => Number.isFinite(num(m)));
    if (!shown.length) return '';
    return `${shown.map(([m, w, many]) => plural(num(m), w, many)).join(', ')} ${sym(HWE.weakest(shown.map(([m, , , fb]) => lvl(m, fb ?? 'recorded'))))}`;
  };
  const replayHref = (key, thread, event) => {
    const s = isId('session', key) ? `?session=${encodeURIComponent(key)}` : '';
    const t = isId('thread', thread) ? thread : '';
    const e = isId('event', event) ? `~${event}` : '';
    return `replay.html${s}${t || e ? `#${t}${e}` : ''}`;
  };
  const goalHref = (key) => (isId('goal', key) ? `goal.html#${key}` : 'goal.html');
  const isMine = (m) => !!m && (m.assigned === true || m.mine === true || m.cited === true || m.join === 'cited-session' || (Array.isArray(m.joins) && m.joins.some((j) => j.type === 'cited-session')));
  const mineTag = '<span class="tag mine" title="You cited this session in your goal list">your assignment</span>';
  /** A goal beside a session: how that session joins it, whether that's ambiguous, and whether it's yours. */
  const goalLink = (g) => `<span><a href="${goalHref(g.key)}">Goal: ${esc(g.title ?? 'Untitled goal')}</a> ${chips(g.evidence ?? 'recorded', g.ambiguous === true)}${isMine(g) ? ` ${mineTag}` : ''}</span>`;
  const RULED = (rule, rules) => (rule ? `<details class="kbd"><summary>Rule ${esc(rule)}</summary>${esc(HW.ruleText(rule, rules))}</details>` : '');
  /** A section of results: a heading with its count (data-count), then its rows. */
  const section = (title, n, body, cls = '') => `<section class="rsec${cls ? ` ${cls}` : ''}"><h2 data-count="${n}">${esc(title)}<span class="hcount">${n}</span></h2>${body}</section>`;
  const clipText = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

  // ---- what the lookups cover: a quiet line at the foot of the page --------------------
  function coverageLine() {
    const c = HOME.coverage ?? {};
    // The lookups cover the configured sessions; display-only and outside ones are counted apart.
    const read = c.configured ?? c.sessionsRead;
    const nOther = (Number(num(c.display)) || 0) + (Number(num(c.outside)) || 0);
    const otherLvl = HWE.weakest([c.display, c.outside].filter((m) => m != null).map((m) => lvl(m, 'derived')));
    // The engine keeps a fingerprint of each file path these sessions touched, never the path.
    const unnamed = c.filesUnnamed;
    // One short sentence, then the rest behind a disclosure, every count with its level.
    const head = `Pull request, commit, file and word lookups cover ${Number.isFinite(num(read)) ? `${plural(num(read), 'session')} ${chip(lvl(read, 'derived'))} in ` : ''}your configured repos, ${esc(windowText(HW.shell.window))}.`;
    const more = [];
    if (nOther) more.push(`${nOther === 1 ? '1 other session' : `${nOther} other sessions`}, in a display-only repo (a repository you marked display-only: honestweek never runs git against it or publishes its text) or outside your configured repos, ${nOther === 1 ? "isn't" : "aren't"} in these lookups ${chip(otherLvl)}; the search of every session covers them.`);
    if (Number(num(unnamed)) > 0) more.push(`The ${plural(num(unnamed), 'file')} these sessions touched ${num(unnamed) === 1 ? 'is' : 'are'} kept as fingerprints, never by name, so type a file's path to look one up ${chip(lvl(unnamed, 'derived'))}.`);
    $('coverage').innerHTML = `<span data-cover="head">${head}</span>${more.length ? ` <details data-cover="more"><summary>More: ${[nOther ? `${plural(nOther, 'session')} left out` : '', Number(num(unnamed)) > 0 ? 'how to find a file' : ''].filter(Boolean).join('; ')}</summary><p>${more.join(' ')}</p></details>` : ''}`;
  }
  // Example searches the server picked from this window's most common references: three of them.
  const examples = () => (Array.isArray(HOME.try) ? HOME.try : []).map((x) => (typeof x === 'string' ? x : x?.text ?? x?.q ?? '')).filter((x) => typeof x === 'string' && x.trim()).slice(0, 3);
  const tryRow = () => (examples().length ? `<span>Try</span>${examples().map((x) => `<button type="button" class="trychip${/\s/.test(x) ? ' words' : ''}" data-try="${esc(x)}">${esc(x)}</button>`).join('')}` : '');

  // ---- result rows -----------------------------------------------------------------------
  const VIA = {
    'pr-link': 'The harness recorded a link to it',
    'harness-git-pr': 'The harness recorded git acting on it',
    'printed-output': "Read from a command's printed output",
    'gh-pr-command': 'A recorded gh command acted on it',
    'pr-link-in-command': 'A recorded command used its link',
    'pr-landed': 'Git shows it landed',
    'harness-commit': 'The harness recorded this commit',
    'commit-exists': 'Git confirms the commit exists',
    edit: 'Edited it',
    read: 'Read it',
    'external-edit': 'Noticed it change outside the agent',
    worktree: 'Worked in a worktree on this branch',
    push: 'Pushed this branch',
  };
  const viaText = (r) => {
    if (r.via === 'squash-subject') return `A commit whose subject names pull request ${esc(r.pr)}, the shape of a squash merge`;
    if (/^branch-/.test(r.via ?? '')) return `Recorded a branch ${esc(r.via.slice(7))}`;
    return esc(VIA[r.via] ?? r.via ?? 'Linked');
  };
  const ambText = (a) => (!a || a === true ? '' : a.owners ? ` (${a.owners} repositories share this name, so which one is meant is open)` : a.ownerUnknown ? " (its repository's owner isn't known)" : a.candidates ? ` (${a.candidates} sessions fit)` : '');
  const moreButton = (id) => `<button type="button" class="more" data-more aria-expanded="false" aria-controls="${id}">More</button>`;
  /** A session as one line: its level, its title, when, and a short reason; "More" opens every
   *  reason with its record, the session's goals, and where to go next. */
  function sessionCard(row, { rules = {}, snippet = '', goals = null, why = '' } = {}) {
    const key = row.session ?? row.key;
    // A lookup's row carries the session's own fields (its times, tool, repo); what the home
    // page already knows about the session, and the row's info, come on top.
    const own = Object.fromEntries(['tool', 'repo', 'title', 'firstAt', 'lastAt', 'startedBy'].filter((k) => row[k] != null).map((k) => [k, row[k]]));
    const s = { ...own, ...(sessionInfo.get(key) ?? {}), ...(row.info ?? {}) };
    const refs = Array.isArray(row.refs) ? row.refs : [];
    const best = row.evidence ?? null;
    const gs = goals ?? row.goals ?? s.goals ?? [];
    const title = s.title ?? row.title ?? 'Untitled session';
    const thread = s.thread ?? row.thread;
    // A session with no prompt says what opened it (a command, a schedule, another session)
    // in place of "0 prompts". Its title stays the engine's own, or "Untitled session".
    const opened = s.startedBy ?? row.startedBy ?? null;
    const tally = counts([[opened && !num(s.prompts) ? null : s.prompts, 'prompt'], [s.steps, 'step'], [s.agents, 'agent']]);
    const meta = [when(s), esc(toolName(s.tool)), s.repo ? esc(s.repo) : '', row.repo && row.repo !== s.repo ? esc(row.repo) : '', tally, opened && typeof opened.text === 'string' ? `${esc(opened.text)} ${sym(lvl(opened, 'recorded'))}` : ''].filter(Boolean).join(' · ');
    const first = refs.find((r) => r.event && isId('event', r.event)) ?? null;
    const amb = row.ambiguous ? ` ${chip('ambiguous', ambText(row.ambiguous).replace(/^ \(|\)$/g, '') || '')}` : refs.slice(1).some((r) => r.ambiguous) ? ` ${chip('ambiguous', 'one of the other reasons')}` : '';
    const short = refs.length
      ? `${cap(refs[0].evidence ?? best ?? 'recorded')}: ${HW.lowerFirst(viaText(refs[0]))}${refs.length > 1 ? `, and ${plural(refs.length - 1, 'more reason')}` : ''}.`
      : why || (gs.length ? `Toward ${gs.map((g) => esc(g.title ?? 'Untitled goal')).join(', ')}.` : 'Linked to no goal.');
    const id = `more${++moreSeq}`;
    return `<div class="card rrow${best === 'inferred' ? ' inferred' : ''}${row.ambiguous ? ' ambiguous' : ''}" data-session="${esc(key)}">
      ${best ? sym(best) : ''}
      <div class="rbody">
        <div class="rtop"><a class="t" href="${replayHref(key, thread)}">${esc(title)}</a><span class="meta">${meta}</span></div>
        <p class="rwhy">${short}${amb} ${moreButton(id)}</p>
        <div class="rmore" id="${id}" hidden>
          ${refs.length ? `<ul class="reasons">${refs.map((r) => `<li>${chips(r.evidence, !!r.ambiguous)} ${viaText(r)}${r.count > 1 ? ` ×${r.count}` : ''}${esc(ambText(r.ambiguous))} ${r.event && isId('event', r.event) ? `<a href="${replayHref(key, thread, r.event)}">see the record</a>` : ''}${RULED(r.rule, rules)}</li>`).join('')}</ul>` : ''}
          ${snippet}
          <div class="actions"><a class="btn primary" href="${replayHref(key, thread)}">Replay from here</a>${first ? `<a class="btn" href="${replayHref(key, thread, first.event)}">See the record</a>` : ''}${gs.map(goalLink).join('')}${gs.length ? '' : '<span class="meta">Linked to no goal</span>'}</div>
        </div>
      </div>
    </div>`;
  }
  /** A goal card: its state, and its sessions in this window by how they join it. A lookup's
   *  goal lists only the sessions the lookup found (`sessions`), and says so. */
  function goalCard(g, why = '') {
    const listed = Array.isArray(g.sessions) ? g.sessions : null;
    const members = Array.isArray(g.members) ? g.members : listed;
    const total = members ? members.length : num(g.sessions ?? g.members);
    const recorded = members ? members.filter((m) => m.evidence !== 'inferred' && !m.ambiguous).length : num(g.recorded);
    const ruled = members ? members.filter((m) => m.evidence === 'inferred' && !m.ambiguous).length : num(g.inferred);
    const amb = members ? members.filter((m) => m.ambiguous).length : num(g.ambiguous);
    const mine = members ? members.filter(isMine).length : num(g.mine ?? g.assigned);
    const parts = [];
    if (Number.isFinite(recorded)) parts.push(`${recorded} joined by a record`);
    if (Number.isFinite(ruled)) parts.push(`${ruled} by a rule only`);
    if (amb) parts.push(`${amb} ambiguous`);
    if (mine) parts.push(`${mine} cited by you`);
    return `<div class="card gcard" data-goal="${esc(g.key)}"><div><a class="t" href="${goalHref(g.key)}">${esc(g.title ?? 'Untitled goal')}</a>${g.state ? ` <span class="tag">${esc(g.state)}</span>` : ''}</div>
      <div class="meta">${Number.isFinite(total) ? `${plural(total, 'session')} ${listed ? 'listed here' : 'in this window'}${parts.length ? `: ${parts.join(', ')}` : ''} ${chip(members ? HW.memberLevel(members) : lvl(g.members ?? g.sessions, 'derived'))}` : ''}${g.parent && goalInfo.get(g.parent) ? ` · part of ${esc(goalInfo.get(g.parent).title)}` : ''}</div>
      ${why ? `<div class="snippet">${why}</div>` : ''}</div>`;
  }
  /** The goals a lookup lists beside its sessions: per session, its row in the goal. */
  function goalsBySession(a) {
    const by = new Map();
    for (const g of Array.isArray(a.goals) ? a.goals : []) {
      if (!g || typeof g !== 'object') continue;
      for (const m of Array.isArray(g.sessions) ? g.sessions : Array.isArray(g.members) ? g.members : []) {
        if (!m?.session) continue;
        (by.get(m.session) ?? by.set(m.session, []).get(m.session)).push({ key: g.key, title: g.title ?? goalInfo.get(g.key)?.title, evidence: m.evidence, ambiguous: m.ambiguous === true, assigned: isMine(m) });
      }
    }
    return by;
  }
  const notesHtml = (notes) => {
    const list = (Array.isArray(notes) ? notes : []).filter((n) => n && (typeof n === 'string' || n.text) && n.kind !== 'nothing-found');
    if (!list.length) return '';
    return `<ul class="notes">${list.map((n) => `<li class="${/owner|ambig/.test(n.kind ?? '') ? 'ambig-note' : ''}">${esc(typeof n === 'string' ? n : n.text)}</li>`).join('')}</ul>`;
  };

  // ---- a reference: /api/lookup ------------------------------------------------------------
  const PR_RE = /^(?:(?:[\w.-]+\/)?[\w.-]+#|pr\s*#?\s*|pull\/|#)(\d+)$/i;
  const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i;
  const isRef = (q) => PR_RE.test(q) || PR_URL.test(q) || /^[0-9a-f]{7,40}$/i.test(q) || /^(file|branch):/i.test(q) || (!/\s/.test(q) && (/[\\/]/.test(q) || /^[\w.-]+\.[a-z0-9]{1,6}$/i.test(q)));
  // A lookup answer: `kind`, the engine's reading of the reference in `parsed`, and on a restore by
  // id the typed text in `query`.
  function renderLookup(a) {
    const p = a.parsed && typeof a.parsed === 'object' ? a.parsed : {};
    const kind = a.kind ?? p.kind ?? 'unknown';
    const q = queryText(a);
    const sessions = Array.isArray(a.sessions) ? a.sessions : [];
    const goalsOf = goalsBySession(a);
    const goals = (Array.isArray(a.goals) ? a.goals : []).filter((g) => g && typeof g === 'object');
    const n = kind === 'pr' ? p.number ?? (q.match(/(\d+)\s*$/) ?? [])[1] : null;
    const lead = kind === 'pr' ? `Pull request ${esc(n ?? q)}${p.repo ? ` in ${esc(p.owner ? `${p.owner}/` : '')}${esc(p.repo)}` : ''}` : kind === 'commit' ? `Commit ${esc(String(p.sha ?? q).slice(0, 12))}` : kind === 'file' ? `File ${esc(p.path ?? q)}` : kind === 'branch' ? `Branch ${esc(p.branch ?? q)}` : `"${esc(q)}"`;
    // One summary line for what was found, its count no stronger than the weakest row in it.
    const fileRows = kind === 'file' && Array.isArray(a.repositories) ? a.repositories.flatMap((g) => (Array.isArray(g.sessions) ? g.sessions : [])) : [];
    const rows = kind === 'file' && Array.isArray(a.repositories) ? fileRows : sessions;
    const did = { pr: 'worked on it', commit: 'made or recorded it', branch: 'were on this branch', file: 'touched it' }[kind] ?? 'point at it';
    const level = HWE.weakest(rows.map((r) => r.evidence ?? 'recorded'));
    const sum = rows.length ? `<p class="sumline"><b>${plural(rows.length, 'session')}</b> ${rows.length === 1 ? did.replace(/^were /, 'was ') : did}${goals.length ? `, toward <b>${plural(goals.length, 'goal')}</b>` : ''}. ${sym(level)}</p>` : '';
    let html = `<div class="leadblock"><p class="lead">${lead}${a.subject ? `: <b>${esc(a.subject)}</b>` : ''}</p>${sum}${notesHtml(a.notes)}`;
    if (kind === 'commit') for (const nt of (a.notes ?? []).filter((x) => x?.kind === 'squash-subject' && Number.isInteger(x.pr))) html += `<p><button type="button" class="linklike go" data-try="#${nt.pr}">Look up pull request ${nt.pr}</button></p>`;
    html += '</div>';
    const card = (row) => sessionCard(row, { rules: a.rules, goals: goalsOf.get(row.session) ?? null });
    const head = { pr: 'Sessions that worked on it', commit: 'Sessions that made or recorded it', branch: 'Sessions on this branch' }[kind] ?? 'Sessions';
    if (kind === 'file' && Array.isArray(a.repositories)) {
      for (const g of a.repositories) {
        const list = Array.isArray(g.sessions) ? g.sessions : [];
        if (!list.length && a.repositories.length > 1) continue;
        html += section(`${g.repo ?? 'Outside every repository'}: sessions`, list.length, list.map((r) => card({ ...r, repo: g.repo })).join(''));
      }
    } else html += section(head, sessions.length, sessions.map(card).join(''));
    if (!sessions.length) html += `<p class="lead empty">${nothingIn(`points at ${kind === 'unknown' ? 'it' : `this ${kind === 'pr' ? 'pull request' : kind}`}`)}</p>`;
    if (goals.length) html += section('Goals these sessions belong to', goals.length, goals.map((g) => goalCard({ ...(goalInfo.get(g.key) ?? {}), ...g })).join(''));
    if (kind === 'pr') html += '<p class="hint">A session that only mentions a pull request in passing isn\'t listed. Links come from the harness record, git, or a recorded gh command (by rule).</p>';
    return html;
  }

  // ---- words: /api/words -------------------------------------------------------------------
  const FILLER = new Set(['a', 'an', 'the', 'please', 'just', 'really', 'me', 'my', 'our', 'we', 'you', 'your', 'to', 'of', 'and', 'it', 'is', 'in', 'on', 'for', 'that', 'this', 'i']);
  const tokens = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\[redacted:\w+\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter((t) => t && !FILLER.has(t));
  function highlight(text, qt) {
    let html = esc(text);
    for (const t of qt) if (t.length > 2) html = html.replace(new RegExp(`(${esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    return html;
  }
  // A score as the server sends it: { value, of } shared words, or { value } a share from 0 to 1.
  const pct = (p) => {
    const s = p.score && typeof p.score === 'object' ? p.score : { value: p.score };
    if (!Number.isFinite(s.value)) return null;
    if (Number.isFinite(s.of) && s.of > 0) return Math.round((s.value / s.of) * 100);
    return Math.round(s.value <= 1 ? s.value * 100 : s.value);
  };
  const scoreChip = (p) => chip(p.score?.evidence ?? 'inferred', p.score?.rule ?? p.rule ?? 'shared words');
  function promptCard(p, qt, rules) {
    const key = p.session;
    const s = sessionInfo.get(key) ?? {};
    const t = toT(p.t ?? p.at);
    const id = p.event ?? p.id;
    if (Array.isArray(p.similar)) similarOf.set(id, p.similar);
    const score = pct(p);
    return `<div class="card pcardrow" data-prompt="${esc(id)}"><div class="meta">${Number.isFinite(t) ? `${esc(time(t, { day: true }))} · ` : ''}${esc(s.title ?? p.title ?? 'Untitled session')}${score != null ? ` · ${score}% of your words ${scoreChip(p)}` : ''}</div>
      <div class="snippet">${highlight(clipText(p.text, 420), qt)} ${chip(p.evidence ?? 'recorded')}</div>
      <div class="actions"><a href="${replayHref(key, p.thread ?? s.thread, id)}">Replay from this prompt</a><button type="button" class="linklike" data-similar="${esc(id)}">Similar prompts</button>${(p.goals ?? []).map(goalLink).join('')}</div>${RULED(p.rule, rules)}<div data-simout="${esc(id)}"></div></div>`;
  }
  const wordsFound = (a) => ['goals', 'titled', 'sessions', 'branches', 'prompts'].reduce((n, k) => n + (Array.isArray(a?.[k]) ? a[k].length : 0), 0);
  function renderWords(a, { lead = true } = {}) {
    const q = queryText(a);
    const qt = [...new Set(tokens(q))];
    const goals = Array.isArray(a.goals) ? a.goals : [];
    const titled = Array.isArray(a.titled) ? a.titled : Array.isArray(a.sessions) ? a.sessions : [];
    const branches = Array.isArray(a.branches) ? a.branches : [];
    const prompts = Array.isArray(a.prompts) ? a.prompts : [];
    if (!goals.length && !titled.length && !branches.length && !prompts.length) return `<p class="lead" data-nothing="1">${nothingIn(`matches "${esc(q)}"`)} Try fewer words, a pull request like #12, a commit id, or a file name.</p><div class="hint">${tryRow()}</div>`;
    const found = [prompts.length ? plural(prompts.length, 'prompt') : '', titled.length ? plural(titled.length, 'session title') : '', goals.length ? plural(goals.length, 'goal') : '', branches.length ? plural(branches.length, 'branch', 'branches') : ''].filter(Boolean).join(', ');
    let html = lead ? `<div class="leadblock"><p class="lead">"${esc(q)}"</p><p class="sumline">Found in <b>${found}</b>.</p></div>` : '';
    html += section('Your prompts that use these words', prompts.length, prompts.map((p) => promptCard(p, qt, a.rules)).join('') || '<p class="empty">No prompt uses any of these words.</p>');
    html += section('Sessions whose title matches', titled.length, titled.map((s) => sessionCard({ ...s, session: s.session ?? s.key, evidence: s.evidence ?? 'recorded' }, { goals: s.goals ?? null, why: 'Its title matches.' })).join('') || '<p class="empty">None.</p>');
    html += section('Goals whose title or id matches', goals.length, goals.map((g) => goalCard({ ...(goalInfo.get(g.key) ?? {}), ...g }, `Matched in its ${(g.matchedIn ?? g.matched) === 'id' ? 'id' : 'title'} ${chip(g.evidence ?? 'recorded')}`)).join('') || '<p class="empty">No goal title matches.</p>');
    if (branches.length) {
      html += section('Branches containing these words', branches.length, branches.map((b) => `<p class="lead branchlead">${esc(b.branch ?? b.name ?? '')} ${chip(b.evidence ?? 'recorded')}</p>${(b.sessions ?? []).map((r) => sessionCard(typeof r === 'string' ? { session: r } : r, { rules: a.rules, why: 'Recorded on this branch.' })).join('')}`).join(''));
    }
    return html;
  }
  async function showSimilar(id, box) {
    let list = similarOf.get(id);
    if (!Array.isArray(list)) {
      box.innerHTML = '<div class="sim kbd">Finding similar prompts…</div>';
      try {
        const a = await HW.load('words', { similar: id });
        list = Array.isArray(a.similar) ? a.similar : [];
      } catch (err) {
        HW.fail(err);
        return;
      }
    }
    box.innerHTML = `<div class="sim">${list.map((p) => {
      const s = sessionInfo.get(p.session) ?? {};
      const t = toT(p.t ?? p.at);
      const score = pct(p);
      return `<div class="snippet"><span class="meta">${score != null ? `${score}% shared words ${scoreChip(p)} · ` : ''}${Number.isFinite(t) ? `${esc(time(t, { day: true }))} · ` : ''}${esc(s.title ?? p.title ?? '')}</span><br>${esc(clipText(p.text, 260))} <a href="${replayHref(p.session, p.thread ?? s.thread, p.event ?? p.id)}">replay</a></div>`;
    }).join('') || '<div class="meta">No other prompt shares at least a fifth of its words.</div>'}<div class="meta">Similarity is shared words only, a rough measure worked out on this machine: no AI, nothing sent anywhere.</div></div>`;
  }

  // ---- every session on this machine: /api/search, folded as "Elsewhere" ----------------------
  const GROUP = { configured: 'your configured repos', display: 'a display-only repo', outside: 'a folder outside your config' };
  async function everywhere(q, mySeq) {
    const box = document.createElement('details');
    box.className = 'fold everywhere';
    box.id = 'everywhere';
    box.dataset.state = 'loading';
    const say = (summary, body) => {
      const open = box.open;
      box.innerHTML = `<summary><h2>${summary}</h2></summary><div class="foldbody">${body}</div>`;
      box.open = open;
    };
    say('Elsewhere on this machine: searching…', '<p class="empty">Searching…</p>');
    out.appendChild(box);
    let a;
    for (let tries = 0; ; tries++) {
      try {
        a = await HW.load('search', { q });
      } catch (err) {
        if (mySeq !== seq) return;
        box.dataset.state = 'done';
        say('Elsewhere on this machine', `<p class="empty">${esc(err.message)}</p>`);
        if (window.HWKey.NOTICE[err.code]) HW.fail(err);
        return;
      }
      if (mySeq !== seq) return;
      // While the index is still being read the answer is { ready: false, state, note }; a
      // failed read says why and stops asking.
      if (a.ready === false && a.state === 'failed') {
        box.dataset.state = 'done';
        say('Elsewhere on this machine', `<p class="empty">${esc(a.note ?? "Every session couldn't be read.")}</p>`);
        return;
      }
      if (a.ready !== false || tries > 60) break;
      say('Elsewhere on this machine: still reading', `<p class="empty">${esc(a.note ?? 'Still reading every session into memory; it answers in a moment.')}</p>`);
      await new Promise((r) => setTimeout(r, 2000));
      if (mySeq !== seq) return;
    }
    const qt = [...new Set(tokens(queryText(a) || q))];
    const results = Array.isArray(a.results) ? a.results : [];
    const DISPLAY_ONLY = '(a repository you marked display-only: honestweek never runs git against it or publishes its text)';
    // `indexed` counts the sessions searched, `sessions` the ones that matched, `total` their prompts.
    const head = `Elsewhere on this machine: ${Number.isFinite(num(a.total)) ? plural(num(a.total), 'matching prompt') : plural(results.length, 'result')}${Number.isFinite(num(a.sessions)) ? ` in ${plural(num(a.sessions), 'session')}` : ''}${Number.isFinite(num(a.indexed)) ? `, of ${plural(num(a.indexed), 'session')} searched` : ''} ${chip(HWE.weakest([lvl(a.indexed, 'derived'), lvl(a.sessions, 'derived'), lvl(a.total, 'derived')]))}`;
    say(head, `<p class="hint">Unlike the lookups, this searches the prompts and titles of every session on this machine in this window: your configured repos, display-only repos ${DISPLAY_ONLY}, and folders outside your config. ${HWP.on ? 'Private text is shown: names, client text and folders are visible, and secrets stay hidden.' : 'Excerpts are redacted before they\'re cut, so a private word shows as [redacted:…] and never in part.'} Results stay in this program's memory.</p>
      ${results.slice(0, 40).map((r) => {
        const key = r.session ?? null;
        // A hit outside this window's history has no known group: say so, never guess one.
        const group = r.group ?? r.role ?? null;
        const t0 = toT(r.firstAt);
        const t1 = toT(r.lastAt);
        const inWindow = r.inWindow !== false && !!key;
        return `<div class="card pcardrow"${group ? ` data-group="${esc(group)}"` : ''}${key ? ` data-session="${esc(key)}"` : ''}>
          <div>${inWindow ? `<a class="t" href="${replayHref(key, r.thread)}">${esc(r.name ?? r.title ?? 'Untitled session')}</a>` : `<span class="t">${esc(r.name ?? r.title ?? 'Untitled session')}</span>`} ${chip(r.evidence ?? 'recorded')}</div>
          <div class="meta">${esc(toolName(r.tool))}${Number.isFinite(t0) ? ` · ${esc(time(t0, { day: true }))}${Number.isFinite(t1) && t1 - t0 > 60e3 ? ` to ${esc(time(t1, { day: HW.dayOf(t0) !== HW.dayOf(t1) }))}` : ''}` : ''} · ${Number.isFinite(num(r.matches)) ? `${plural(num(r.matches), 'matching prompt')} ${chip(lvl(r.matches, 'derived'))}` : ''}${r.titleMatched ? ', title matches' : ''}${group ? ` · in ${esc(GROUP[group] ?? group)}` : " · its group isn't known, because it's not in this window"}${r.named === 'first prompt' ? ' · no title, named by its first prompt' : ''}</div>
          ${(Array.isArray(r.snippets) ? r.snippets : []).map((p) => {
            const t = toT(p.t ?? p.at);
            return `<div class="snippet">${Number.isFinite(t) ? `<span class="meta">${esc(time(t, { day: true }))}</span> ` : ''}${highlight(p.text, qt)} ${chip(p.evidence ?? 'recorded')}</div>`;
          }).join('')}
          <div class="actions">${inWindow ? `<a href="${replayHref(key, r.thread)}">Open this session</a>` : '<span class="meta">Not in this window, so it can\'t be opened here.</span>'}</div>
        </div>`;
      }).join('') || `<p class="empty">${nothingIn('in any session on this machine uses all of these words')}</p>`}`);
    box.dataset.state = 'done';
  }

  // ---- home: three cards ------------------------------------------------------------------------
  // /api/home: { coverage, goals, goalList: { given, note }, recent: [session rows], try }.
  const recentOf = (h) => (Array.isArray(h?.recent) ? h.recent : []);
  const keyOf = (s) => s?.session ?? s?.key ?? null;
  const SHOW_RECENT = 5;
  const SHOW_GOALS = 3;
  // The recent list holds every session in the window, so one outside the configured repos says so.
  const GROUP_NOTE = { display: 'display-only repo', outside: 'outside your config' };
  /** A recent session, compact: its title, when, the tool, its repo, its goals, and what opened it. */
  function recentRow(s, hidden) {
    const key = keyOf(s);
    const info = { ...s, ...(sessionInfo.get(key) ?? {}) };
    const gs = info.goals ?? [];
    const opened = info.startedBy ?? null;
    const tally = counts([[opened && !num(info.prompts) ? null : info.prompts, 'prompt'], [info.steps, 'step'], [info.agents, 'agent']]);
    const goals = gs.length ? gs.map((g) => `<a href="${goalHref(g.key)}">${esc(g.title ?? 'Untitled goal')}</a> ${sym(g.evidence ?? 'recorded')}${g.ambiguous ? ` ${chip('ambiguous')}` : ''}${isMine(g) ? ` ${mineTag}` : ''}`).join(', ') : 'no goal';
    const meta = [when(info), esc(toolName(info.tool)), info.repo ? esc(info.repo) : '', GROUP_NOTE[info.group] ?? '', goals, tally, opened && typeof opened.text === 'string' ? `${esc(opened.text)} ${sym(lvl(opened, 'recorded'))}` : ''].filter(Boolean).join(' · ');
    return `<li class="card row" data-session="${esc(key)}"${hidden ? ' hidden data-extra' : ''}><a class="t" href="${replayHref(key, info.thread)}">${esc(info.title ?? 'Untitled session')}</a><div class="meta">${meta}</div>${info.firstPrompt ? `<div class="snippet">${esc(clipText(info.firstPrompt, 240))}</div>` : ''}</li>`;
  }
  /** A goal, compact: its title, state and session count, and one pip per session by how it joins. */
  function goalRow(g, hidden) {
    const m = g.members && typeof g.members === 'object' ? g.members : null;
    const n = Number(num(g.members)) || 0;
    const rec = Number(num(g.recorded)) || 0;
    const rule = Number(num(g.inferred)) || 0;
    const amb = Number(num(g.ambiguous)) || 0;
    const split = [`${rec} joined by a record`, `${rule} by a rule only`, amb ? `${amb} ambiguous` : '', g.assigned ? `${g.assigned} cited by you` : ''].filter(Boolean).join(', ');
    const pips = n ? `<span class="pips" role="img" aria-label="${esc(`${plural(n, 'session')}: ${split}`)}" title="${esc(split)}">${'<span class="pip"></span>'.repeat(Math.min(rec, 24))}${'<span class="pip rule"></span>'.repeat(Math.min(rule, Math.max(0, 24 - rec)))}${'<span class="pip amb"></span>'.repeat(Math.min(amb, Math.max(0, 24 - rec - rule)))}</span>` : '';
    return `<li class="card" data-goal="${esc(g.key)}"${hidden ? ' hidden data-extra' : ''}><a class="hitem goalitem" href="${goalHref(g.key)}"><span class="hmain"><span class="hname">${esc(g.title ?? 'Untitled goal')}</span><span class="hsub">${g.state ? `${esc(g.state)} · ` : ''}${plural(n, 'session')} ${sym(m ? lvl(m, 'derived') : 'derived')}</span>${pips}</span></a></li>`;
  }
  const moreLink = (list, n, label) => (n > list ? `<button type="button" class="linklike" data-showall aria-expanded="false">${label}</button>` : '');
  function home() {
    const noList = HOME.goals == null || HOME.goalList === false || HOME.goalList?.given === false;
    const goals = (HOME.goals ?? []).filter((g) => g.state !== 'retired').slice().sort((a, b) => (Number(num(b.members)) || 0) - (Number(num(a.members)) || 0));
    // Sessions with a prompt first, each group newest first, as the server sends them.
    const prompted = (x) => (Number(num(x.prompts)) > 0 ? 1 : 0);
    const recent = recentOf(HOME).slice().sort((a, b) => prompted(b) - prompted(a) || toT(b.lastAt) - toT(a.lastAt));
    const unlinked = recent.filter((s) => !(s.goals ?? []).length).length;
    const c = HOME.coverage ?? {};
    const inRepos = c.configured ?? c.sessionsRead;
    const look = `<section class="hcard" aria-labelledby="lookH" id="lookCard"><div class="hcard-head"><h2 id="lookH">Worth a look</h2><span class="side">this window</span></div><div id="lookBody"><p class="empty"><span class="spin" aria-hidden="true"></span>Checking for problems…</p></div></section>`;
    const recentCard = `<section class="hcard" aria-labelledby="recentH"><div class="hcard-head"><h2 id="recentH" data-count="${recent.length}">Recent sessions</h2><span class="side">${Number.isFinite(num(inRepos)) ? `${plural(num(inRepos), 'session')} in your repos ${sym(lvl(inRepos, 'derived'))}` : ''}</span></div>
      ${recent.some((x) => !prompted(x)) ? '<p class="kbd">Sessions with a prompt of yours come first.</p>' : ''}
      ${recent.length ? `<ul class="hcard-list">${recent.map((s, i) => recentRow(s, i >= SHOW_RECENT)).join('')}</ul>` : `<p class="empty">${nothingIn('is in your configured repos')}</p>`}
      <div class="hcard-foot">${moreLink(SHOW_RECENT, recent.length, `See all ${recent.length} recent`)}${noList ? '' : `<span class="kbd">${unlinked} linked to no goal</span>`}</div></section>`;
    const goalsCard = noList
      ? '<section class="hcard" aria-labelledby="goalsH"><div class="hcard-head"><h2 id="goalsH" data-count="0">Your goals</h2></div><p class="empty">No goal list is set, so sessions aren\'t grouped by goal. The <a href="goal.html">Goals page</a> says what a goal list is and how to give one.</p></section>'
      : `<section class="hcard" aria-labelledby="goalsH"><div class="hcard-head"><h2 id="goalsH" data-count="${goals.length}">Your goals</h2><span class="side">${plural(goals.length, 'goal')} in your list</span></div>
        ${goals.length ? `<ul class="hcard-list">${goals.map((g, i) => goalRow(g, i >= SHOW_GOALS)).join('')}</ul>` : `<p class="empty">${nothingIn('has a session joined to a goal in your goal list')}</p>`}
        <div class="hcard-foot">${moreLink(SHOW_GOALS, goals.length, `See all ${goals.length}`)}<a href="goal.html">Open goals</a></div></section>`;
    return `<div class="homecards">${look}${recentCard}${goalsCard}</div>`;
  }
  // "Worth a look": the top three patterns found, by their tier (the rule's, or "My priority").
  const TIER = { high: 'High', medium: 'Medium', low: 'Low' };
  const RANK = { high: 0, medium: 1, low: 2 };
  let prefs = null;
  async function fillLook() {
    const body = $('lookBody');
    if (!body) return;
    let a;
    try {
      a = await HW.problemsSummary();
    } catch (err) {
      if (window.HWKey.NOTICE[err?.code]) return HW.fail(err);
      HW.navCount(null);
      if ($('lookBody')) $('lookBody').innerHTML = `<p class="empty">The problem checks couldn't load: ${esc(err?.message ?? err)}</p>`;
      return;
    }
    const el = $('lookBody');
    if (!el) return;
    if (!prefs && window.HWPrefs) prefs = window.HWPrefs.createPrefs();
    const tierOf = (p) => (prefs ? window.HWPrefs.effective(prefs, p)?.tier : p.priority?.tier) ?? null;
    const patterns = Array.isArray(a?.patterns) ? a.patterns : [];
    const found = patterns.filter((p) => p.status === 'found');
    const cmp = (x, y) => RANK[tierOf(x)] - RANK[tierOf(y)] || (y.priority?.tokens ?? 0) - (x.priority?.tokens ?? 0) || (y.priority?.look ?? 0) - (x.priority?.look ?? 0) || (x.priority?.strength ?? 9) - (y.priority?.strength ?? 9);
    const top = found.filter((p) => RANK[tierOf(p)] != null).sort(cmp).slice(0, 3);
    const total = num(a.coverage?.tokens);
    const sub = (p) => {
      if (p.tokens?.tokens > 0 && Number(total) > 0) {
        const share = p.tokens.tokens / total;
        return `${HW.pct(share)} of the window's tokens ${sym(p.tokens.evidence ?? 'derived')}`;
      }
      return `${plural(Number(p.look) || 0, 'time')}${Number(p.lookSessions) > 0 ? ` in ${plural(p.lookSessions, 'session')}` : ''}${p.notesFound ? `, plus ${p.notesFound} routine` : ''} ${sym(p.countEvidence ?? 'derived')}`;
    };
    el.innerHTML = top.length
      ? `<ul class="hcard-list">${top.map((p) => `<li><a class="hitem" href="problems.html#${esc(p.id)}"><span class="prio t-${esc(tierOf(p))}">${esc(TIER[tierOf(p)])}</span><span class="hmain"><span class="hname">${esc(p.name)}</span><span class="hsub">${sub(p)}</span></span></a></li>`).join('')}</ul><div class="hcard-foot"><a href="problems.html">All ${plural(found.length, 'problem')} found</a></div>`
      : `<p class="empty">${found.length ? 'Every problem found here is one you marked not a problem.' : 'None of the known problems the checks look for showed up in this window.'}</p><div class="hcard-foot"><a href="problems.html">What's checked</a></div>`;
    HW.navCount(patterns);
  }

  // ---- running a query --------------------------------------------------------------------------
  // An answer to a search by id echoes the typed text in `query` (the one field the leak counter
  // exempts, since it's what this page sent); every answer carries its `queryId`.
  const queryText = (a) => (typeof a?.query === 'string' ? a.query : '');
  const queryIdOf = (a) => [a?.queryId].find((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v)) ?? null;
  const setAddress = (qid, route) => {
    const want = qid ? `#q=${qid}~${route === 'lookup' ? 'l' : 'w'}` : '';
    if (location.hash !== want) history.replaceState(null, '', `${location.pathname}${location.search}${want}`);
  };
  const readAddress = () => {
    const m = location.hash.match(/^#q=([A-Za-z0-9_-]{4,64})(?:~([lw]))?$/);
    return m ? { id: m[1], route: m[2] === 'l' ? 'lookup' : 'words' } : null;
  };
  /** Home or results: the welcome and the cards, or the results with the key beside them. */
  function showView(v) {
    document.body.dataset.view = v;
    const side = $('keySide');
    side.hidden = v !== 'results';
    if (v === 'results' && !side.firstChild) side.innerHTML = `${HWE.sideKeyHtml()}<p class="kbd">This key also opens from the ? button at the top of every page.</p>`;
  }
  function begin() {
    const mine = ++seq;
    out.dataset.state = 'loading';
    return mine;
  }
  function finish(mine, html, view = 'results') {
    if (mine !== seq) return false;
    showView(view);
    out.innerHTML = html;
    out.dataset.seq = String(Number(out.dataset.seq) + 1);
    out.dataset.state = 'done';
    if (view === 'home') fillLook();
    return true;
  }
  /** Run what's in the box (or, with `restore`, the query an id in the address names). */
  async function run(restore = null) {
    const q = restore ? '' : input.value.trim();
    const mine = begin();
    if (!q && !restore) {
      setAddress(null);
      finish(mine, home(), 'home');
      return;
    }
    const route = restore ? restore.route : isRef(q) ? 'lookup' : 'words';
    let a;
    try {
      a = await HW.load(route, restore ? { id: restore.id } : { q });
    } catch (err) {
      if (mine !== seq) return;
      if (restore && err.code === 'http') {
        // The id is from an earlier run, or the server no longer has it: start from home.
        setAddress(null);
        finish(mine, home(), 'home');
        return;
      }
      out.dataset.state = 'done';
      HW.fail(err);
      return;
    }
    if (mine !== seq) return;
    if (restore && typeof a?.query !== 'string') {
      // The server kept no words for this id, or won't echo them with the switch off: say
      // why, and start from home with an empty box.
      setAddress(null);
      input.value = '';
      finish(mine, `${a?.empty ? `<p class="hint">${esc(a.empty)}</p>` : ''}${home()}`, 'home');
      return;
    }
    const text = restore ? queryText(a) : q;
    if (restore) input.value = text;
    const qid = queryIdOf(a);
    setAddress(qid, route);
    let html = route === 'lookup' ? renderLookup({ ...a, query: text }) : renderWords({ ...a, query: text });
    // A file, a branch or anything else that isn't a pull request or a commit may also be words
    // in a prompt or a branch name: folded away when the lookup found sessions, open when not.
    const kind = a.kind ?? a.parsed?.kind;
    const found = Array.isArray(a.sessions) && a.sessions.length > 0;
    let words = null;
    if (route === 'lookup' && kind !== 'pr' && kind !== 'commit') {
      try {
        words = await HW.load('words', { q: text });
      } catch {}
      if (mine !== seq) return;
      if (words && (!found || wordsFound(words))) html += `<details class="fold alsowords" id="alsoWords"${found ? '' : ' open'}><summary><h2>Also mentioned in words</h2> <span class="hcount">${plural(wordsFound(words), 'match', 'matches')}</span></summary><div class="foldbody">${renderWords({ ...words, query: text }, { lead: false })}</div></details>`;
    }
    if (!finish(mine, html)) return;
    // The machine-wide search is asked by its text, which the page has by now.
    if (route === 'words' || words) await everywhere(text, mine);
  }

  HW.start(async () => {
    HOME = await HW.load('home');
    for (const s of recentOf(HOME)) if (keyOf(s)) sessionInfo.set(keyOf(s), s);
    for (const g of HOME.goals ?? []) if (g?.key) goalInfo.set(g.key, g);
    coverageLine();
    $('hint').innerHTML = tryRow();
    // Turning the switch off: what was typed with private text showing may itself be private,
    // so it leaves the box and the address before the page reloads redacted.
    HWP.beforeOff = () => {
      input.value = '';
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    };
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(), 200);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      clearTimeout(timer);
      run();
    });
    $('findForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      clearTimeout(timer);
      run();
    });
    document.addEventListener('click', (ev) => {
      const tryIt = ev.target.closest('[data-try]');
      if (tryIt) {
        ev.preventDefault();
        clearTimeout(timer);
        input.value = tryIt.dataset.try;
        run();
        return;
      }
      const sim = ev.target.closest('[data-similar]');
      if (sim) {
        ev.preventDefault();
        const box = document.querySelector(`[data-simout="${CSS.escape(sim.dataset.similar)}"]`);
        if (box) showSimilar(sim.dataset.similar, box);
        return;
      }
      // "More" on a result: every reason, with its record, and where to go next.
      const more = ev.target.closest('[data-more]');
      if (more) {
        const box = document.getElementById(more.getAttribute('aria-controls'));
        if (!box) return;
        const open = box.hidden;
        box.hidden = !open;
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Less' : 'More';
        more.closest('.rrow')?.classList.toggle('open', open);
        return;
      }
      // "See all" on a home card: the rows it keeps folded.
      const all = ev.target.closest('[data-showall]');
      if (all) {
        const card = all.closest('.hcard');
        const open = all.getAttribute('aria-expanded') !== 'true';
        card.querySelectorAll('[data-extra]').forEach((li) => {
          li.hidden = !open;
        });
        all.setAttribute('aria-expanded', String(open));
        if (!all.dataset.label) all.dataset.label = all.textContent;
        all.textContent = open ? 'Show fewer' : all.dataset.label;
      }
    });
    window.addEventListener('hashchange', () => {
      const r = readAddress();
      if (r) run(r);
    });
    const restore = readAddress();
    await run(restore);
    input.focus();
  });
})();
