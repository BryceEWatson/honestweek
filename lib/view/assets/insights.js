// The Problems page's optional /insights group: what Claude Code's own /insights command wrote
// about this window's sessions, shown apart from honestweek's findings and never counted with
// them. Off by default; the toggle is remembered in the config. Each item names a friction
// category and its count, links to its session's replay, and is tied to the whole session, not
// to steps. The text is the model's, AI-written, and the page never marks it as checked.
//
// "Run /insights" starts the local `claude -p /insights` after a confirm, shows how long it has
// run, and reads the files again when it ends. Both actions are POSTs with this run's key.
//
// Data: /api/insights (and ?session=<key> on one session's view). Needs common.js and key.js;
// loads before problems.js, which starts it.
(function () {
  'use strict';
  const { esc, isId } = HW;
  const HWP = window.HWP;
  const box = document.getElementById('insights');
  if (!box) return;
  const params = new URLSearchParams(location.search);
  const SESSION = isId('session', params.get('session')) ? params.get('session') : null;
  const CONFIRM = 'Run /insights? It uses your Claude plan and sends your sessions to Claude.';
  let A = null; // the last /api/insights answer
  let note = '';
  let poll = null;

  const why = (label, html) => `<details class="fwhy"><summary title="${esc(label)}" aria-label="${esc(label)}">?</summary><div>${html}</div></details>`;
  const secs = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : '');
  const replayHref = (it) => (isId('session', it.session) ? `replay.html?session=${encodeURIComponent(it.session)}${isId('thread', it.thread) ? `#${it.thread}` : ''}` : null);

  function runLine() {
    const r = A.run ?? {};
    if (A.demo) return '';
    if (r.state === 'running') return `<span class="ins-run" data-ins-running><span class="spin" aria-hidden="true"></span>Running /insights: ${esc(secs(r.elapsedMs))}</span>`;
    if (A.claude === false) return `<span class="muted" data-ins-noclaude>claude isn't on your PATH.</span>`;
    const ended = { done: '', failed: `/insights stopped${Number.isInteger(r.code) ? ` (exit ${r.code})` : ''}.`, timeout: `/insights ran over ${Math.round((r.timeoutMs ?? 0) / 60000)} min, so it was stopped.`, stopped: '/insights was stopped.' }[r.state] ?? '';
    return `${ended ? `<span class="muted" data-ins-ended>${esc(ended)}</span> ` : ''}<button type="button" class="btn" data-ins-run>Run /insights</button>`;
  }

  function itemsHtml(d) {
    const rows = [];
    for (const it of d.items ?? []) {
      const r = replayHref(it);
      const more = [
        it.detail ? `<p>${esc(it.detail)}</p>` : '',
        it.summary ? `<p class="muted">${esc(it.summary)}</p>` : '',
        '<p class="fine">Tied to the whole session, not to steps. Written by the model in /insights; honestweek didn\'t check it.</p>',
      ].join('');
      for (const f of it.frictions ?? []) {
        rows.push(`<li class="ins-item" data-session="${esc(it.session ?? '')}"><b>${esc(f.category ?? '')}</b> <span class="num">${esc(String(f.count))}</span> ${r ? `<a href="${esc(r)}">${esc(it.title ? `“${it.title}”` : 'Replay')}</a>` : ''} <span class="tag">whole session</span> ${why('About this item', more)}</li>`);
      }
    }
    return rows;
  }

  function render() {
    if (!A) return;
    const d = A.data;
    const head = `<div class="ins-head"><label><input type="checkbox" autocomplete="off" data-ins-on${A.on ? ' checked' : ''}> Include /insights</label> ${why('What this is', "<p>Claude Code's /insights has the model read your sessions. This adds its friction notes as their own group. They're AI-written, tied to whole sessions, and never change honestweek's counts.</p>")}`;
    const nodata = !A.hasData;
    const tail = `${nodata ? '<span class="muted" data-ins-nodata>No /insights data yet.</span> ' : ''}${nodata || A.on ? runLine() : ''}`;
    const extra = note ? `<span class="muted" data-ins-note>${esc(note)}</span>` : '';
    let group = '';
    if (A.on && d) {
      const rows = itemsHtml(d);
      const skipped = d.skipped ? `<p class="fine muted" data-ins-skipped>${esc(`${d.skipped} ${d.skipped === 1 ? 'file' : 'files'} skipped: unreadable.`)}</p>` : '';
      group = `<div class="ins-group" data-ins-group><h2 class="sh">From /insights, AI-written <span class="hcount">${rows.length}</span></h2>${rows.length ? `<ol class="ins-list">${rows.join('')}</ol>` : '<p class="muted" data-ins-empty>No /insights friction for this window.</p>'}${skipped}</div>`;
    }
    box.innerHTML = `${head} ${tail} ${extra}</div>${group}`;
    box.hidden = false;
  }

  async function load() {
    try {
      A = await HW.load('insights', SESSION ? { session: SESSION } : {});
    } catch {
      A = null;
      box.hidden = true;
      return;
    }
    render();
    if (A.run?.state === 'running') watch();
  }

  /** Poll while a run goes on; read the files again when it ends. */
  function watch() {
    if (poll) return;
    poll = setInterval(async () => {
      let a;
      try {
        a = await HWP.api('insights', SESSION ? { session: SESSION } : {});
      } catch {
        return;
      }
      A = a;
      if (a.run?.state !== 'running') {
        clearInterval(poll);
        poll = null;
        note = '';
        await load();
        document.body.dataset.insights = a.run?.state ?? '';
        return;
      }
      render();
    }, 2000);
  }

  async function post(route, body) {
    try {
      return { ok: true, body: await HWP.api(route, {}, { method: 'POST', private: false, body: JSON.stringify(body ?? {}) }) };
    } catch (err) {
      return { ok: false, body: err?.body ?? null, message: err?.body?.message ?? HWP.notice?.(err?.code) ?? String(err?.message ?? err) };
    }
  }

  box.addEventListener('change', async (ev) => {
    const cb = ev.target.closest?.('[data-ins-on]');
    if (!cb) return;
    cb.disabled = true;
    const r = await post('insights/toggle', { on: cb.checked });
    note = r.ok ? r.body.note ?? '' : r.message;
    await load();
    box.querySelector('[data-ins-on]')?.focus();
  });
  box.addEventListener('click', async (ev) => {
    const b = ev.target.closest?.('[data-ins-run]');
    if (!b) return;
    if (!window.confirm(CONFIRM)) return;
    b.disabled = true;
    const r = await post('insights/run');
    note = r.ok ? '' : r.message;
    if (r.body && typeof r.body.on === 'boolean') A = { ...A, ...r.body };
    render();
    if (A.run?.state === 'running') watch();
  });

  // problems.js calls this once its own list is drawn, so this group never delays it.
  window.HWInsights = { load };
})();
