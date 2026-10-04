// The pieces the Setup and Settings pages share: the "?" folds, the list of repositories with
// a role menu each, and the "how far back" choice. Every value is drawn with textContent,
// never as HTML, and nothing typed is stored or put in the address. Needs key.js and
// private-text.js first; setup.js and settings.js use it as window.HWF.
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

  /** The "how far back" choice: kind (week, days, from, all), with a days box or a date box. */
  function historyChoice(logs, start, changed) {
    const kind = $('histKind');
    const days = $('histDays');
    const from = $('histFrom');
    const line = $('histLine');
    const h = start ?? null;
    kind.value = !h || h.days === 7 ? 'week' : h.all ? 'all' : h.from ? 'from' : 'days';
    if (h?.days && h.days !== 7) days.value = String(h.days);
    if (h?.from) from.value = h.from;
    const show = () => {
      days.hidden = kind.value !== 'days';
      from.hidden = kind.value !== 'from';
      // All history says at once what it loads; the numbers behind it sit in the fold.
      line.hidden = kind.value !== 'all' || !logs;
      if (logs) line.textContent = logs.all.capped ? `Newest ${logs.maxMB} MB of logs: ${logs.all.from} to ${logs.all.to}.` : `${logs.all.from} to ${logs.all.to}, ${logs.logsMB} MB of logs.`;
    };
    for (const n of [kind, days, from]) {
      n.addEventListener('input', () => {
        show();
        changed();
      });
      n.addEventListener('change', show);
    }
    if (logs) {
      help($('histHelp'), 'how far back', [
        `This machine has ${logs.logsMB} MB of logs${logs.earliest ? `, back to ${logs.earliest}` : ''}.`,
        `All history loads the newest days first, up to ${logs.maxMB} MB of logs, and the page says which days it loaded. All of it here is ${logs.all.cost}; Show private text about doubles the time.`,
        'The --days, --from and --to options still change it for one run.',
      ]);
    }
    show();
    return () => {
      // A config with no saved choice reads the last week already, so it stays without one.
      if (kind.value === 'week') return h === null ? null : { days: 7 };
      if (kind.value === 'all') return { all: true };
      if (kind.value === 'from') return { from: from.value };
      return { days: Number(days.value) };
    };
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

  window.HWF = { $, el, help, call, repoList, addBox, historyChoice, problem, status, emailsOf, ROLES };
})();
