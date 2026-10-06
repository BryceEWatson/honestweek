// Replay's starting list: replay.html with no thread or session chosen. The window's sessions by
// the day each started (in the configured timezone), newest day first and newest session first
// within a day, a few per day with "Show more", from /api/sessions. Each row opens that session's
// replay. Nothing goes in the address: "Show more" adds rows in place, and the list starts short
// again on the next visit. An old #<thread> address never reaches here; replay.js opens it.
(function () {
  'use strict';
  const { esc, plural, num, lvl, time, toT, dur, isId } = HW;
  const sym = HW.sym;
  const $ = (id) => document.getElementById(id);

  const toolName = (t) => (t === 'codex' ? 'Codex' : t === 'claude-code' ? 'Claude Code' : t ? String(t) : 'Unknown tool');
  // The same words Find's Recent card uses for a session outside the configured repos.
  const GROUP_NOTE = { display: 'display-only repo', outside: 'outside your config' };
  const NO_DAY = 'none';
  // A window whose days fall in more than one calendar year names the year on every day.
  let withYear = false;
  const dayName = (day) => (day === NO_DAY ? 'No time recorded' : new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }));
  const replayHref = (s) => {
    const thread = isId('thread', s.thread) ? `#${s.thread}` : '';
    return isId('session', s.session) ? `replay.html?session=${encodeURIComponent(s.session)}${thread}` : `replay.html${thread}`;
  };

  /** One session: its title, then when it started, how long its records span, the agent, its
   *  repository, its prompts (or what opened it), and its findings worth a look. */
  function row(s) {
    const t0 = toT(s.firstAt);
    const opened = s.startedBy && typeof s.startedBy.text === 'string' && !num(s.prompts) ? s.startedBy : null;
    const look = s.problems && Number(num(s.problems)) > 0 && isId('session', s.session)
      ? `<a href="problems.html?session=${encodeURIComponent(s.session)}">${plural(num(s.problems), 'problem')} worth a look</a> ${sym(lvl(s.problems, 'derived'))}`
      : '';
    const meta = [
      Number.isFinite(t0) ? `${esc(time(t0))} ${sym('recorded')}` : '',
      s.length && Number.isFinite(num(s.length)) ? `${esc(dur(num(s.length)))} ${sym(lvl(s.length, 'derived'))}` : '',
      esc(toolName(s.tool)),
      s.repo ? esc(s.repo) : '',
      GROUP_NOTE[s.group] ?? '',
      opened ? HW.startedByHtml(opened, s.firstAt) : Number.isFinite(num(s.prompts)) ? `${plural(num(s.prompts), 'prompt')} ${sym(lvl(s.prompts, 'derived'))}` : '',
      look,
    ].filter(Boolean).join(' · ');
    return `<li class="row" data-session="${esc(s.session ?? '')}"${s.group ? ` data-group="${esc(s.group)}"` : ''}><a class="t" href="${replayHref(s)}">${esc(s.title ?? s.label ?? 'Untitled session')}</a><div class="meta">${meta}</div></li>`;
  }

  /** "Show N more", N no more than one page, or nothing when the day is all shown. */
  const moreButton = (day, shown, left, page) => (left > 0 ? `<button type="button" class="linklike" data-more="${esc(day)}" data-shown="${shown}">Show ${Math.min(left, page)} more</button>` : '');

  function dayCard(d, page) {
    const n = Number(num(d.count)) || 0;
    const rows = Array.isArray(d.rows) ? d.rows : [];
    return `<section class="hcard sl-day" data-day="${esc(d.day)}" aria-labelledby="day-${esc(d.day)}">
      <div class="hcard-head"><h2 id="day-${esc(d.day)}">${esc(dayName(d.day))}</h2><span class="side">${plural(n, 'session')} ${sym(lvl(d.count, 'derived'))}</span></div>
      <ul class="hcard-list">${rows.map(row).join('')}</ul>
      <div class="hcard-foot">${moreButton(d.day, rows.length, Number(num(d.more)) || 0, page)}<span class="sl-err" role="status"></span></div>
    </section>`;
  }

  const olderButton = (older) => (older && typeof older.before === 'string' ? `<button type="button" class="linklike" data-older="${esc(older.before)}">Show earlier days (${plural(Number(num(older.days)) || 0, 'more day')})</button>` : '');

  /** The list's heading and a quiet "Checking…" while the window's sessions are read. */
  function waiting() {
    $('allSessions')?.remove();
    document.body.dataset.view = 'sessions';
    $('tool').hidden = true;
    $('title').textContent = 'Sessions';
    $('content').innerHTML = '<div class="sl" id="sessions"><p class="checking"><span class="spin" aria-hidden="true"></span>Checking…</p></div>';
  }

  async function show() {
    const a = await HW.load('sessions');
    // This page is the list, so it never links to itself, even when the window is empty.
    $('allSessions')?.remove();
    if (!a || a.empty || !Array.isArray(a.days) || !a.days.length) {
      HW.fatal(`${HW.nothingIn('to replay')} <a href="search.html">Search</a> for a session to replay, or look further back.`);
      $('title').textContent = '';
      const el = document.querySelector('[data-fatal]');
      if (el) el.dataset.fatal = 'no-thread';
      return;
    }
    const page = Number(a.page) || 20;
    withYear = a.spansYears === true;
    const total = Number(num(a.total)) || 0;
    document.body.dataset.view = 'sessions';
    $('tool').hidden = true;
    $('title').textContent = 'Sessions';
    const tz = typeof a.timezone === 'string' ? a.timezone : 'UTC';
    $('meta').innerHTML = `${plural(total, 'session')} ${sym(lvl(a.total, 'derived'))} <details class="help inline"><summary aria-label="About this list">?</summary><p>Every session in this window, by the day it started (${esc(tz)}), newest first. Each opens its replay. Display-only and outside sessions are listed too, and never join a lookup or a goal. "Worth a look" counts a session's findings from the problem checks, which read only your configured repos.</p></details>`;
    if (a.problemsNote) HW.addNote(a.problemsNote);
    $('content').innerHTML = `<div class="sl" id="sessions">${a.days.map((d) => dayCard(d, page)).join('')}<div class="sl-older" id="older">${olderButton(a.older)}</div><p class="sr" id="slAnnounce" aria-live="polite"></p></div>`;
    $('sessions').addEventListener('click', (ev) => {
      const more = ev.target.closest('[data-more]');
      if (more) return showMore(more, page);
      const older = ev.target.closest('[data-older]');
      if (older) showOlder(older, page);
    });
    // An old address typed or pasted here (#<thread>) opens that replay.
    window.addEventListener('hashchange', () => {
      if (isId('thread', location.hash.slice(1).split('~')[0])) location.reload();
    });
  }

  /** The next page of one day's sessions, added under the ones shown. */
  async function showMore(btn, page) {
    const card = btn.closest('.sl-day');
    const err = card.querySelector('.sl-err');
    btn.disabled = true;
    err.textContent = '';
    try {
      const a = await HW.load('sessions', { day: btn.dataset.more, offset: btn.dataset.shown });
      const rows = Array.isArray(a?.rows) ? a.rows : [];
      const list = card.querySelector('.hcard-list');
      const first = list.children.length;
      list.insertAdjacentHTML('beforeend', rows.map(row).join(''));
      const shown = list.children.length;
      const left = Number(num(a?.more)) || 0;
      btn.insertAdjacentHTML('afterend', moreButton(btn.dataset.more, shown, left, page));
      btn.remove();
      list.children[first]?.querySelector('a')?.focus();
      $('slAnnounce').textContent = `Showing ${plural(rows.length, 'more session')} from ${dayName(card.dataset.day)}.`;
    } catch (e) {
      btn.disabled = false;
      err.textContent = `Couldn't load more: ${e?.message ?? e}`;
    }
  }

  /** The next few days, added under the ones shown. */
  async function showOlder(btn, page) {
    const box = $('older');
    btn.disabled = true;
    try {
      const a = await HW.load('sessions', { before: btn.dataset.older });
      const days = Array.isArray(a?.days) ? a.days : [];
      box.insertAdjacentHTML('beforebegin', days.map((d) => dayCard(d, page)).join(''));
      box.innerHTML = olderButton(a?.older);
      const first = days[0] ? document.querySelector(`.sl-day[data-day="${CSS.escape(days[0].day)}"] a`) : null;
      first?.focus();
      $('slAnnounce').textContent = `Showing ${plural(days.length, 'more day')}.`;
    } catch (e) {
      btn.disabled = false;
      box.insertAdjacentHTML('beforeend', `<span class="sl-err" role="status">Couldn't load more: ${esc(e?.message ?? e)}</span>`);
    }
  }

  window.HWSessions = { show, waiting };
})();
