// The Setup page: what `honestweek init` asks at a terminal, asked on a page. The server
// proposes the repositories, the email and the timezone with init's own functions; this page
// shows them, lets the person change them, previews the config the server will write, and
// saves it. Then it goes on to the person's own week on the same server, with the same key.
//
// Every answer, private words included, goes only to this server, in a POST body with this
// run's key. Nothing typed is ever put in the address or stored in the browser, and every
// value is drawn with textContent, never as HTML. Needs key.js and private-text.js first.
(function () {
  'use strict';
  const HWP = window.HWP;
  const $ = (id) => document.getElementById(id);
  const ROLES = ['featured', 'reference', 'display'];
  let info = null;
  let repos = [];
  let previewed = null;

  function setStatus(text, { bad = false } = {}) {
    const el = $('status');
    el.hidden = !text;
    el.textContent = text ?? '';
    el.classList.toggle('bad', !!bad);
  }
  function problem(text) {
    const el = $('problem');
    el.hidden = !text;
    el.textContent = text ?? '';
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

  // ---- the repositories ---------------------------------------------------------------------
  function drawRepos() {
    const list = $('repos');
    list.textContent = '';
    repos.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'reporow';
      const main = document.createElement('div');
      main.className = 'repomain';
      const name = document.createElement('span');
      name.className = 'reponame';
      name.textContent = r.label;
      const path = document.createElement('code');
      path.className = 'repopath';
      path.textContent = r.path;
      main.append(name, path);
      const pick = document.createElement('select');
      pick.setAttribute('aria-label', `Role for ${r.label}`);
      for (const role of ROLES) {
        const o = document.createElement('option');
        o.value = role;
        o.textContent = role;
        pick.append(o);
      }
      pick.value = r.role;
      pick.addEventListener('change', () => {
        repos[i].role = pick.value;
        changed();
      });
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'btn';
      drop.textContent = 'Remove';
      drop.setAttribute('aria-label', `Remove ${r.label}`);
      drop.addEventListener('click', () => {
        repos.splice(i, 1);
        drawRepos();
        changed();
        $('addPath').focus();
      });
      li.append(main, pick, drop);
      list.append(li);
    });
    if (!repos.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No repositories yet. Add one by its folder path.';
      list.append(li);
    }
  }
  function addRepo() {
    const input = $('addPath');
    const path = input.value.trim();
    if (!path) return input.focus();
    const label = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
    // The server checks the folder on save and preview; a new one starts as reference.
    repos.push({ path, label, role: 'reference' });
    input.value = '';
    drawRepos();
    changed();
    input.focus();
  }

  // ---- the answers, the preview and saving ----------------------------------------------------
  function answers() {
    const goals = $('goals').value.trim();
    return {
      authorEmails: $('emails').value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      timezone: $('timezone').value.trim(),
      repos: repos.map((r) => ({ path: r.path, label: r.label, role: r.role })),
      names: $('names').value,
      terms: $('terms').value,
      ...(goals ? { goalsFile: goals } : {}),
    };
  }
  /** Any change makes the shown preview out of date, so Save waits for a fresh one. */
  function changed() {
    previewed = null;
    $('preview').hidden = true;
    $('saveBtn').disabled = true;
    problem('');
  }
  async function preview() {
    problem('');
    const sent = answers();
    const r = await call('POST', 'setup/preview', sent);
    if (r.status !== 200) {
      changed();
      problem(r.body.message ?? `The server answered ${r.status}.`);
      if (r.status === 409) offerWeek();
      return;
    }
    previewed = JSON.stringify(sent);
    $('previewSummary').textContent = `It will say: ${r.body.summary}`;
    const notes = $('previewNotes');
    notes.textContent = '';
    for (const n of r.body.notes ?? []) {
      const li = document.createElement('li');
      li.textContent = n;
      notes.append(li);
    }
    $('previewText').textContent = r.body.text;
    $('preview').hidden = false;
    $('saveBtn').disabled = false;
    document.body.dataset.previewed = '1';
  }
  async function save() {
    const sent = answers();
    if (previewed !== JSON.stringify(sent)) return preview();
    $('saveBtn').disabled = true;
    problem('');
    setStatus('Saving.');
    const r = await call('POST', 'setup/save', sent);
    if (r.status !== 200) {
      setStatus('');
      problem(r.body.message ?? `The server answered ${r.status}.`);
      if (r.status === 409) offerWeek();
      else $('saveBtn').disabled = false;
      return;
    }
    // The private words leave the page now that they're in the file.
    $('names').value = '';
    $('terms').value = '';
    $('previewText').textContent = '';
    if (r.body.restart) {
      setStatus(`Saved. ${r.body.written} ${r.body.restart}`, { bad: true });
      document.body.dataset.ready = 'saved-restart';
      return;
    }
    setStatus(`Saved. ${r.body.written} Opening your week.`);
    document.body.dataset.ready = 'saved';
    location.href = 'search.html';
  }
  function offerWeek() {
    const p = $('problem');
    const a = document.createElement('a');
    a.href = 'search.html';
    a.textContent = ' Open your week.';
    p.append(a);
  }

  // ---- start ------------------------------------------------------------------------------
  async function start() {
    const state = await HWP.ready;
    if (state !== 'ready') {
      $('lead').textContent = HWP.notice(state);
      document.body.dataset.ready = 'fatal';
      return;
    }
    const r = await call('GET', 'setup');
    if (r.status !== 200) {
      $('lead').textContent = r.status === 404 ? "This run of honestweek view isn't doing setup: its folder already has a config." : r.body.message ?? `The server answered ${r.status}.`;
      if (r.status === 404) $('lead').append(Object.assign(document.createElement('a'), { href: 'search.html', textContent: ' Open your week.' }));
      document.body.dataset.ready = 'fatal';
      return;
    }
    info = r.body;
    if (info.configured) {
      $('lead').textContent = info.note;
      $('lead').append(Object.assign(document.createElement('a'), { href: 'search.html', textContent: ' Open your week.' }));
      document.body.dataset.ready = 'configured';
      return;
    }
    $('lead').textContent = `There's no ${info.configFile} in ${info.folder} yet. Check these answers, preview the file and save it, and this page goes on to your week. For scripts and CI, ${info.command} init asks the same questions in a terminal.`;
    $('found').textContent = info.found;
    const roles = $('roles');
    for (const { role, meaning } of info.roles) {
      const dt = document.createElement('dt');
      dt.textContent = role;
      const dd = document.createElement('dd');
      dd.textContent = meaning;
      roles.append(dt, dd);
    }
    repos = info.repos.map((x) => ({ path: x.path, label: x.label, role: x.role }));
    drawRepos();
    $('emails').value = info.authorEmails.join(', ');
    if (info.emailNote) {
      $('emailNote').hidden = false;
      $('emailNote').textContent = info.emailNote;
    }
    $('timezone').value = info.timezone;
    $('wordsIntro').textContent = info.privateWords.intro;
    $('namesLabel').textContent = info.privateWords.names;
    $('termsLabel').textContent = info.privateWords.terms;
    for (const id of ['emails', 'timezone', 'names', 'terms', 'goals']) $(id).addEventListener('input', changed);
    $('addBtn').addEventListener('click', addRepo);
    $('addPath').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        addRepo();
      }
    });
    $('previewBtn').addEventListener('click', preview);
    $('saveBtn').addEventListener('click', save);
    $('form').hidden = false;
    document.body.dataset.ready = '1';
  }
  start().catch((err) => {
    $('lead').textContent = `This page couldn't be drawn: ${err?.message ?? err}`;
    document.body.dataset.ready = 'fatal';
  });
})();
