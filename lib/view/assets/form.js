// The pieces the Setup and Settings pages share: the "?" folds, the list of repositories with
// a role menu each, the "how far back" choice, and the header's light/dark button. Every value
// is drawn with textContent, never as HTML, and nothing typed is stored or put in the address.
// Needs prefs.js (in the page's head), key.js and private-text.js first; setup.js and
// settings.js use it as window.HWF.
(function () {
  'use strict';
  const HWP = window.HWP;
  const ROLES = ['featured', 'reference', 'display'];
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) n.append(k);
    return n;
  };

  /** A closed "?" fold after `anchor`, holding `lines` (one paragraph each). */
  function help(anchor, name, lines) {
    const d = el('details', { className: 'help' });
    const s = el('summary', { textContent: '?' });
    s.setAttribute('aria-label', `About ${name}`);
    d.append(s, ...lines.filter(Boolean).map((t) => el('p', { textContent: t })));
    anchor.append(d);
    return d;
  }

  /** One request through the key client, which adds this run's key. Answers { status, body }. */
  async function call(method, route, body) {
    try {
      const json = await HWP.api(route, {}, { method, private: false, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: 200, body: json };
    } catch (err) {
      if (err?.code === 'http') return { status: err.status, body: err.body ?? { message: err.message } };
      return { status: 0, body: { message: HWP.notice(err?.code) || String(err?.message ?? err) } };
    }
  }

  /** The repository list in `list`: rows of name, folder, role menu and Remove. */
  function repoList(list, rows, changed) {
    function draw() {
      list.textContent = '';
      rows.forEach((r, i) => {
        const pick = el('select');
        pick.setAttribute('aria-label', `Role for ${r.label}`);
        for (const role of ROLES) pick.append(el('option', { value: role, textContent: role }));
        pick.value = r.role;
        pick.addEventListener('change', () => {
          rows[i].role = pick.value;
          changed();
        });
        const drop = el('button', { type: 'button', className: 'btn', textContent: 'Remove' });
        drop.setAttribute('aria-label', `Remove ${r.label}`);
        drop.addEventListener('click', () => {
          rows.splice(i, 1);
          draw();
          changed();
        });
        list.append(el('li', { className: 'reporow' }, el('div', { className: 'repomain' }, el('span', { className: 'reponame', textContent: r.label }), el('code', { className: 'repopath', textContent: r.path })), pick, drop));
      });
      if (!rows.length) list.append(el('li', { className: 'muted', textContent: 'None yet.' }));
    }
    function add(path) {
      const label = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
      // The server checks the folder on preview and save; a new one starts as reference.
      rows.push({ path, label, role: 'reference' });
      draw();
      changed();
    }
    draw();
    return { draw, add };
  }

  /** Wire an "Add" box: the input, its button, Enter. */
  function addBox(input, button, add) {
    const go = () => {
      const v = input.value.trim();
      if (v) add(v);
      input.value = '';
      input.focus();
    };
    button.addEventListener('click', go);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        go();
      }
    });
  }

  /**
   * The "how far back" choice: the last week, a number of days, from a date, between two dates,
   * or all history, plus (on Settings) the limit on log data. Under it, one line says which days
   * that loads and marks it partial when the limit cuts it short; it comes from the server's
   * /api/window, which sizes it from file sizes and dates. A line above says how far back the
   * logs go; the size of each span sits in the "?". Answers { history, limit } getters.
   */
  function historyChoice(logs, start, changed, { limitStart } = {}) {
    const kind = $('histKind');
    const days = $('histDays');
    const from = $('histFrom');
    const to = $('histTo');
    const line = $('histLine');
    const limit = $('histLimit');
    const estimate = $('histEstimate');
    const h = start ?? null;
    kind.value = !h || h.days === 7 ? 'week' : h.all ? 'all' : h.from && h.to ? 'range' : h.from ? 'from' : 'days';
    if (h?.days && h.days !== 7) days.value = String(h.days);
    if (h?.from) from.value = h.from;
    if (h?.to) to.value = h.to;
    if (limit) limit.value = String(limitStart ?? logs?.limits?.default ?? 500);
    const history = () => {
      // A config with no saved choice reads the last week already, so it stays without one.
      if (kind.value === 'week') return h === null ? null : { days: 7 };
      if (kind.value === 'all') return { all: true };
      if (kind.value === 'from') return { from: from.value };
      if (kind.value === 'range') return { from: from.value, to: to.value };
      return { days: Number(days.value) };
    };
    const limitMB = () => (limit ? Number(limit.value) : null);
    let asked = 0;
    async function plan() {
      const n = ++asked;
      // Setup's timezone field, when there is one: the saved config reads the days in it.
      const tz = $('timezone')?.value.trim();
      const q = { kind: kind.value, days: days.value, from: from.value, to: to.value, ...(limit ? { limit: limit.value } : {}), ...(tz ? { tz } : {}) };
      let r;
      try {
        r = await HWP.api('window', q, { private: false });
      } catch (err) {
        r = { line: err?.body?.message ?? '' };
      }
      if (n !== asked) return;
      line.hidden = !r.line;
      line.textContent = r.line ?? '';
      line.classList.toggle('partial', !!r.capped);
      line.dataset.capped = r.capped ? '1' : '';
      if (estimate) {
        // A limit other than the saved one shows its cost first.
        const moved = limit && Number(limit.value) !== (limitStart ?? logs?.limits?.default ?? 500);
        estimate.hidden = !moved || !r.estimate;
        estimate.textContent = r.estimate ?? '';
      }
    }
    const show = () => {
      days.hidden = kind.value !== 'days';
      from.hidden = kind.value !== 'from' && kind.value !== 'range';
      to.hidden = kind.value !== 'range';
      plan();
    };
    for (const n of [kind, days, from, to, limit].filter(Boolean)) {
      n.addEventListener('input', () => {
        show();
        changed();
      });
    }
    if (logs) {
      const span = $('logsLine');
      if (span) span.textContent = logs.earliest ? `Logs: ${logs.earliest} to ${logs.latest}, ${logs.logs}.` : 'No logs found yet.';
      help($('histHelp'), 'how far back', [
        logs.spans.map((s) => `${s.label}: ${s.size}`).join('. ') + '. Sizes are of the log files, by the day each was last written.',
        `The last week, or up to 7 days, always loads whole, newest day first. A longer choice loads the newest days up to the log limit (${logs.limits.default} MB unless you raise it), and says when it's partial. All of it here would be ${logs.all.cost}.`,
        'The --days, --from and --to options still change it for one run.',
      ]);
    }
    show();
    return { history, limitMB, plan };
  }

  function problem(text) {
    const p = $('problem');
    p.hidden = !text;
    p.textContent = text ?? '';
  }
  function status(text, { bad = false } = {}) {
    const s = $('status');
    s.hidden = !text;
    s.textContent = text ?? '';
    s.classList.toggle('bad', !!bad);
  }
  const emailsOf = (v) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

  // The header's light/dark button, as on every other page (prefs.js draws it).
  window.HWPrefs?.mountTheme(document);

  window.HWF = { $, el, help, call, repoList, addBox, historyChoice, problem, status, emailsOf, ROLES };
})();
