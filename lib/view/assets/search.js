// The search page: one box for a reference (a pull request, a commit, a file, a branch) or
// words. References go to /api/lookup, words to /api/words, and the same words search every
// session on this machine through /api/search. Every result is the server's, with its evidence
// level; the page only arranges them.
//
// The address never holds what was typed. The first request for a query sends its text; the
// answer carries a query id, and the address gets #q=<query id>~<l|w> (lookup or words). On
// load with that, the page asks again by id and puts the answer's query text back in the box,
// so Back, reload and the switch's reload all restore the search.
(function () {
  'use strict';
  const { esc, plural, chip, chips, time, toT, num, lvl, nothingIn, windowText, isId } = HW;
  const $ = (id) => document.getElementById(id);
  const input = $('q');
  const out = $('out');
  let HOME = null;
  const sessionInfo = new Map();
  const goalInfo = new Map();
  const similarOf = new Map();
  let seq = 0;
  out.dataset.seq = '0';
  out.dataset.state = 'idle';

  // ---- small pieces --------------------------------------------------------------------
  const RANK = { recorded: 0, derived: 1, inferred: 2, missing: 3 };
  const toolName = (t) => (t === 'codex' ? 'Codex' : t === 'claude-code' ? 'Claude Code' : t ? String(t) : 'Unknown tool');
  const when = (s) => {
    const a = toT(s.firstAt);
    const b = toT(s.lastAt);
    if (!Number.isFinite(a)) return '';
    return `${time(a, { day: true })}${Number.isFinite(b) && b - a > 60e3 ? ` to ${time(b, { day: HW.dayOf(a) !== HW.dayOf(b) })}` : ''} ${chip('recorded')}`;
  };
  /** Several counts on one line, with one chip: the weakest of their levels. */
  const counts = (list) => {
    const shown = list.filter(([m]) => Number.isFinite(num(m)));
    if (!shown.length) return '';
    return `${shown.map(([m, w, many]) => plural(num(m), w, many)).join(', ')} ${chip(HWE.weakest(shown.map(([m, , , fb]) => lvl(m, fb ?? 'recorded'))))}`;
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

  // ---- what the lookups cover ----------------------------------------------------------
  function coverageLine() {
    const c = HOME.coverage ?? {};
    // The lookups cover the configured sessions; display-only and outside ones are counted apart.
    const read = c.configured ?? c.sessionsRead;
    const nOther = (Number(num(c.display)) || 0) + (Number(num(c.outside)) || 0);
    const otherLvl = HWE.weakest([c.display, c.outside].filter((m) => m != null).map((m) => lvl(m, 'derived')));
    // The engine keeps a fingerprint of each file path these sessions touched, never the path.
    const unnamed = c.filesUnnamed;
    let text = `Pull request, commit, file and word lookups cover your configured repos only: ${Number.isFinite(num(read)) ? `${plural(num(read), 'session')} ${chip(lvl(read, 'derived'))}, ` : ''}${esc(windowText(HW.shell.window))}.`;
    if (nOther) text += ` ${nOther === 1 ? '1 other session' : `${nOther} other sessions`}, in a display-only repo (a repository you marked display-only: honestweek never runs git against it or publishes its text) or outside your configured repos, ${nOther === 1 ? "isn't" : "aren't"} in these lookups ${chip(otherLvl)}; the search of every session below covers them.`;
    if (Number(num(unnamed)) > 0) text += ` The ${plural(num(unnamed), 'file')} these sessions touched ${num(unnamed) === 1 ? 'is' : 'are'} kept as fingerprints, never by name, so type a file's path to look one up ${chip(lvl(unnamed, 'derived'))}.`;
    $('coverage').innerHTML = text;
  }
  // Example searches the server picked from this window's most common references.
  const examples = () => (Array.isArray(HOME.try) ? HOME.try : []).map((x) => (typeof x === 'string' ? x : x?.text ?? x?.q ?? '')).filter((x) => typeof x === 'string' && x.trim()).slice(0, 6);
  const tryRow = () => (examples().length ? `Try: ${examples().map((x) => `<button type="button" data-try="${esc(x)}">${esc(x)}</button>`).join('')}` : '');

  // ---- cards ---------------------------------------------------------------------------
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
  /** A session card: why it matched, the goals it belongs to, where to go next. */
  function sessionCard(row, { rules = {}, snippet = '', goals = null } = {}) {
    const key = row.session ?? row.key;
    const s = { ...(sessionInfo.get(key) ?? {}), ...(row.info ?? {}) };
    const refs = Array.isArray(row.refs) ? row.refs : [];
    const best = row.evidence ?? null;
    const gs = goals ?? row.goals ?? s.goals ?? [];
    const title = s.title ?? row.title ?? 'Untitled session';
    return `<div class="card ${best === 'inferred' ? 'inferred' : ''}${row.ambiguous ? ' ambiguous' : ''}" data-session="${esc(key)}">
      <div><a class="t" href="${replayHref(key, s.thread ?? row.thread)}">${esc(title)}</a>${best ? ` ${chips(best, row.ambiguous === true)}` : ''}</div>
      <div class="meta">${esc(toolName(s.tool))}${s.repo ? ` · ${esc(s.repo)}` : ''}${row.repo && row.repo !== s.repo ? ` · ${esc(row.repo)}` : ''} · ${when(s)}${counts([[s.prompts, 'prompt'], [s.steps, 'step'], [s.agents, 'agent']]) ? ` · ${counts([[s.prompts, 'prompt'], [s.steps, 'step'], [s.agents, 'agent']])}` : ''}</div>
      ${refs.length ? `<ul>${refs.map((r) => `<li>${viaText(r)}${r.count > 1 ? ` ×${r.count}` : ''} ${chips(r.evidence, !!r.ambiguous)}${esc(ambText(r.ambiguous))} ${r.event && isId('event', r.event) ? `<a href="${replayHref(key, s.thread ?? row.thread, r.event)}">see the record</a>` : ''}${RULED(r.rule, rules)}</li>`).join('')}</ul>` : ''}
      ${snippet}
      <div class="actions"><a href="${replayHref(key, s.thread ?? row.thread)}">Replay this session</a>${gs.map(goalLink).join('')}${gs.length ? '' : '<span class="meta">Linked to no goal</span>'}</div>
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
    return `<div class="card" data-goal="${esc(g.key)}"><div><a class="t" href="${goalHref(g.key)}">${esc(g.title ?? 'Untitled goal')}</a>${g.state ? ` <span class="tag">${esc(g.state)}</span>` : ''}</div>
      <div class="meta">${Number.isFinite(total) ? `${plural(total, 'session')} ${listed ? 'listed here' : 'in this window'}${parts.length ? `: ${parts.join(', ')}` : ''} ${chip(lvl(listed ? null : g.sessions ?? g.members, 'derived'))}` : ''}${g.parent && goalInfo.get(g.parent) ? ` · part of ${esc(goalInfo.get(g.parent).title)}` : ''}</div>
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
    let html = `<p class="lead">${lead}${a.subject ? `: <b>${esc(a.subject)}</b>` : ''}</p>${notesHtml(a.notes)}`;
    if (kind === 'commit') for (const nt of (a.notes ?? []).filter((x) => x?.kind === 'squash-subject' && Number.isInteger(x.pr))) html += `<p><button type="button" class="linklike go" data-try="#${nt.pr}">Look up pull request ${nt.pr}</button></p>`;
    if (goals.length) html += `<h2>Goals these sessions belong to (${goals.length})</h2>${goals.map((g) => goalCard({ ...(goalInfo.get(g.key) ?? {}), ...g })).join('')}`;
    const card = (row) => sessionCard(row, { rules: a.rules, goals: goalsOf.get(row.session) ?? null });
    const head = { pr: 'Sessions that worked on it', commit: 'Sessions that made or recorded it', branch: 'Sessions on this branch' }[kind] ?? 'Sessions';
    if (kind === 'file' && Array.isArray(a.repositories)) {
      for (const g of a.repositories) {
        const list = Array.isArray(g.sessions) ? g.sessions : [];
        if (!list.length && a.repositories.length > 1) continue;
        html += `<h2>${esc(g.repo ?? 'Outside every repository')}: ${plural(list.length, 'session')}</h2>${list.map((r) => card({ ...r, repo: g.repo })).join('')}`;
      }
    } else html += `<h2>${head} (${sessions.length})</h2>${sessions.map(card).join('')}`;
    if (!sessions.length) html += `<p class="lead empty">${nothingIn(`points at ${kind === 'unknown' ? 'it' : `this ${kind === 'pr' ? 'pull request' : kind}`}`)}</p>`;
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
  const clipText = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));
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
    return `<div class="card" data-prompt="${esc(id)}"><div class="meta">${Number.isFinite(t) ? `${esc(time(t, { day: true }))} · ` : ''}${esc(s.title ?? p.title ?? 'Untitled session')}${score != null ? ` · ${score}% of your words ${scoreChip(p)}` : ''}</div>
      <div class="snippet">${highlight(clipText(p.text, 420), qt)} ${chip(p.evidence ?? 'recorded')}</div>
      <div class="actions"><a href="${replayHref(key, p.thread ?? s.thread, id)}">Replay from this prompt</a><button type="button" class="linklike" data-similar="${esc(id)}">Similar prompts</button>${(p.goals ?? []).map(goalLink).join('')}</div>${RULED(p.rule, rules)}<div data-simout="${esc(id)}"></div></div>`;
  }
  function renderWords(a) {
    const q = queryText(a);
    const qt = [...new Set(tokens(q))];
    const goals = Array.isArray(a.goals) ? a.goals : [];
    const titled = Array.isArray(a.titled) ? a.titled : Array.isArray(a.sessions) ? a.sessions : [];
    const branches = Array.isArray(a.branches) ? a.branches : [];
    const prompts = Array.isArray(a.prompts) ? a.prompts : [];
    if (!goals.length && !titled.length && !branches.length && !prompts.length) return `<p class="lead" data-nothing="1">${nothingIn(`matches "${esc(q)}"`)} Try fewer words, a pull request like #12, a commit id, or a file name.</p><div class="hint">${tryRow()}</div>`;
    let html = `<h2>Goals whose title or id matches (${goals.length})</h2>${goals.map((g) => goalCard({ ...(goalInfo.get(g.key) ?? {}), ...g }, `Matched in its ${(g.matchedIn ?? g.matched) === 'id' ? 'id' : 'title'} ${chip(g.evidence ?? 'recorded')}`)).join('') || '<p class="empty">No goal title matches.</p>'}`;
    html += `<h2>Sessions whose title matches (${titled.length})</h2>${titled.map((s) => sessionCard({ ...s, session: s.session ?? s.key, evidence: s.evidence ?? 'recorded' }, { goals: s.goals ?? null })).join('') || '<p class="empty">None.</p>'}`;
    if (branches.length) {
      html += `<h2>Branches containing these words (${branches.length})</h2>`;
      for (const b of branches) html += `<p class="lead">${esc(b.branch ?? b.name ?? '')} ${chip(b.evidence ?? 'recorded')}</p>${(b.sessions ?? []).map((r) => sessionCard(typeof r === 'string' ? { session: r } : r, { rules: a.rules })).join('')}`;
    }
    html += `<h2>Your prompts that use these words (${prompts.length})</h2>`;
    html += prompts.map((p) => promptCard(p, qt, a.rules)).join('') || '<p class="empty">No prompt uses any of these words.</p>';
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

  // ---- every session on this machine: /api/search ------------------------------------------
  const GROUP = { configured: 'your configured repos', display: 'a display-only repo', outside: 'a folder outside your config' };
  async function everywhere(q, mySeq) {
    const box = document.createElement('section');
    box.className = 'everywhere';
    box.id = 'everywhere';
    box.dataset.state = 'loading';
    box.innerHTML = '<h2>Every session on this machine</h2><p class="empty">Searching…</p>';
    out.appendChild(box);
    let a;
    for (let tries = 0; ; tries++) {
      try {
        a = await HW.load('search', { q });
      } catch (err) {
        if (mySeq !== seq) return;
        box.dataset.state = 'done';
        box.innerHTML = `<h2>Every session on this machine</h2><p class="empty">${esc(err.message)}</p>`;
        if (window.HWKey.NOTICE[err.code]) HW.fail(err);
        return;
      }
      if (mySeq !== seq) return;
      // While the index is still being read the answer is { ready: false, state, note }; a
      // failed read says why and stops asking.
      if (a.ready === false && a.state === 'failed') {
        box.dataset.state = 'done';
        box.innerHTML = `<h2>Every session on this machine</h2><p class="empty">${esc(a.note ?? "Every session couldn't be read.")}</p>`;
        return;
      }
      if (a.ready !== false || tries > 60) break;
      box.innerHTML = `<h2>Every session on this machine</h2><p class="empty">${esc(a.note ?? 'Still reading every session into memory; it answers in a moment.')}</p>`;
      await new Promise((r) => setTimeout(r, 2000));
      if (mySeq !== seq) return;
    }
    const qt = [...new Set(tokens(queryText(a) || q))];
    const results = Array.isArray(a.results) ? a.results : [];
    const DISPLAY_ONLY = '(a repository you marked display-only: honestweek never runs git against it or publishes its text)';
    // `indexed` counts the sessions searched, `sessions` the ones that matched, `total` their prompts.
    const head = `Every session on this machine: ${Number.isFinite(num(a.indexed)) ? `${plural(num(a.indexed), 'session')} searched, ` : ''}${Number.isFinite(num(a.total)) ? plural(num(a.total), 'matching prompt') : plural(results.length, 'result')}${Number.isFinite(num(a.sessions)) ? ` in ${plural(num(a.sessions), 'session')}` : ''} ${chip(HWE.weakest([lvl(a.indexed, 'derived'), lvl(a.sessions, 'derived'), lvl(a.total, 'derived')]))}`;
    box.innerHTML = `<h2>${head}</h2>
      <p class="hint">Unlike the lookups, this searches the prompts and titles of every session on this machine in this window: your configured repos, display-only repos ${DISPLAY_ONLY}, and folders outside your config. ${HWP.on ? 'Private text is shown: names, client text and folders are visible, and secrets stay hidden.' : 'Excerpts are redacted before they\'re cut, so a private word shows as [redacted:…] and never in part.'} Results stay in this program's memory.</p>
      ${results.slice(0, 40).map((r) => {
        const key = r.session ?? null;
        const group = r.group ?? r.role ?? 'configured';
        const t0 = toT(r.firstAt);
        const t1 = toT(r.lastAt);
        const inWindow = r.inWindow !== false && !!key;
        return `<div class="card" data-group="${esc(group)}"${key ? ` data-session="${esc(key)}"` : ''}>
          <div>${inWindow ? `<a class="t" href="${replayHref(key, r.thread)}">${esc(r.name ?? r.title ?? 'Untitled session')}</a>` : `<span class="t">${esc(r.name ?? r.title ?? 'Untitled session')}</span>`} ${chip(r.evidence ?? 'recorded')}</div>
          <div class="meta">${esc(toolName(r.tool))}${Number.isFinite(t0) ? ` · ${esc(time(t0, { day: true }))}${Number.isFinite(t1) && t1 - t0 > 60e3 ? ` to ${esc(time(t1, { day: HW.dayOf(t0) !== HW.dayOf(t1) }))}` : ''}` : ''} · ${Number.isFinite(num(r.matches)) ? `${plural(num(r.matches), 'matching prompt')} ${chip(lvl(r.matches, 'derived'))}` : ''}${r.titleMatched ? ', title matches' : ''} · in ${esc(GROUP[group] ?? group)}${r.named === 'first prompt' ? ' · no title, named by its first prompt' : ''}</div>
          ${(Array.isArray(r.snippets) ? r.snippets : []).map((p) => {
            const t = toT(p.t ?? p.at);
            return `<div class="snippet">${Number.isFinite(t) ? `<span class="meta">${esc(time(t, { day: true }))}</span> ` : ''}${highlight(p.text, qt)} ${chip(p.evidence ?? 'recorded')}</div>`;
          }).join('')}
          <div class="actions">${inWindow ? `<a href="${replayHref(key, r.thread)}">Open this session</a>` : '<span class="meta">Not in this window, so it can\'t be opened here.</span>'}</div>
        </div>`;
      }).join('') || `<p class="empty">${nothingIn('in any session on this machine uses all of these words')}</p>`}`;
    box.dataset.state = 'done';
  }

  // ---- home: goals and recent sessions --------------------------------------------------------
  // /api/home: { coverage, goals, goalList: { given, note }, recent: [session rows], try }.
  const recentOf = (h) => (Array.isArray(h?.recent) ? h.recent : []);
  const keyOf = (s) => s?.session ?? s?.key ?? null;
  function home() {
    const noList = HOME.goals == null || HOME.goalList === false || HOME.goalList?.given === false;
    const goals = (HOME.goals ?? []).filter((g) => g.state !== 'retired');
    const recent = recentOf(HOME).slice().sort((a, b) => toT(b.lastAt) - toT(a.lastAt));
    const unlinked = recent.filter((s) => !(s.goals ?? []).length).length;
    const goalCol = noList
      ? '<h2>Goals</h2><p class="empty">No goal list is set, so sessions aren\'t grouped by goal. The <a href="goal.html">Goals page</a> says what a goal list is and how to give one.</p>'
      : `<h2>Goals (${goals.length})</h2>${goals.map((g) => goalCard(g)).join('') || `<p class="empty">${nothingIn('has a session joined to a goal in your goal list')}</p>`}`;
    return `<div class="cols"><div>${goalCol}</div>
      <div><h2>Recent sessions (${recent.length})${noList ? '' : ` · ${unlinked} linked to no goal`}</h2>${recent.map((s) => sessionCard({ session: keyOf(s) }, { snippet: s.firstPrompt ? `<div class="snippet">${esc(clipText(s.firstPrompt, 240))}</div>` : '' })).join('') || `<p class="empty">${nothingIn('is in your configured repos')}</p>`}</div></div>`;
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
  function begin() {
    const mine = ++seq;
    out.dataset.state = 'loading';
    return mine;
  }
  function finish(mine, html) {
    if (mine !== seq) return false;
    out.innerHTML = html;
    out.dataset.seq = String(Number(out.dataset.seq) + 1);
    out.dataset.state = 'done';
    return true;
  }
  /** Run what's in the box (or, with `restore`, the query an id in the address names). */
  async function run(restore = null) {
    const q = restore ? '' : input.value.trim();
    const mine = begin();
    if (!q && !restore) {
      setAddress(null);
      finish(mine, home());
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
        finish(mine, home());
        return;
      }
      out.dataset.state = 'done';
      HW.fail(err);
      return;
    }
    if (mine !== seq) return;
    const text = restore ? queryText(a) : q;
    if (restore) input.value = text;
    const qid = queryIdOf(a);
    setAddress(qid, route);
    let html = route === 'lookup' ? renderLookup({ ...a, query: text }) : renderWords({ ...a, query: text });
    // A file or branch nothing points at may still be words in a prompt or a branch name.
    const kind = a.kind ?? a.parsed?.kind;
    const found = Array.isArray(a.sessions) && a.sessions.length > 0;
    let words = null;
    if (route === 'lookup' && !found && kind !== 'pr' && kind !== 'commit') {
      try {
        words = await HW.load('words', { q: text });
      } catch {}
      if (mine !== seq) return;
      if (words) html += `<h2>As words</h2>${renderWords({ ...words, query: text })}`;
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
