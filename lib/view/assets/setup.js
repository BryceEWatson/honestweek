// The Setup page: what `honestweek init` asks at a terminal, asked on a page. The server
// proposes the repositories, the email and the timezone with init's own functions; this page
// shows them, lets the person change them, previews the config the server will write, and
// saves it. Then it goes on to the person's own week on the same server, with the same key.
//
// Every answer, private words included, goes only to this server, in a POST body with this
// run's key. Nothing typed is ever put in the address or stored in the browser. Needs
// key.js, private-text.js and form.js first.
(function () {
  'use strict';
  const HWP = window.HWP;
  const F = window.HWF;
  const { $ } = F;
  let repos = [];
  let previewed = null;
  let historyOf = () => ({ days: 7 });

  function answers() {
    const goals = $('goals').value.trim();
    return {
      authorEmails: F.emailsOf($('emails').value),
      timezone: $('timezone').value.trim(),
      history: historyOf(),
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
    F.problem('');
  }
  function offerWeek() {
    $('problem').append(F.el('a', { href: 'search.html', textContent: ' Open your week.' }));
  }
  async function preview() {
    F.problem('');
    const sent = answers();
    const r = await F.call('POST', 'setup/preview', sent);
    if (r.status !== 200) {
      changed();
      F.problem(r.body.message ?? `The server answered ${r.status}.`);
      if (r.status === 409) offerWeek();
      return;
    }
    previewed = JSON.stringify(sent);
    $('previewSummary').textContent = r.body.summary;
    const notes = $('previewNotes');
    notes.textContent = '';
    for (const n of r.body.notes ?? []) notes.append(F.el('li', { textContent: n }));
    $('previewText').textContent = r.body.text;
    $('preview').hidden = false;
    $('saveBtn').disabled = false;
  }
  async function save() {
    const sent = answers();
    if (previewed !== JSON.stringify(sent)) return preview();
    $('saveBtn').disabled = true;
    F.problem('');
    F.status('Saving.');
    const r = await F.call('POST', 'setup/save', sent);
    if (r.status !== 200) {
      F.status('');
      F.problem(r.body.message ?? `The server answered ${r.status}.`);
      if (r.status === 409) offerWeek();
      else $('saveBtn').disabled = false;
      return;
    }
    // The private words leave the page now that they're in the file.
    $('names').value = '';
    $('terms').value = '';
    $('previewText').textContent = '';
    if (r.body.restart) {
      F.status(`Saved. ${r.body.restart}`, { bad: true });
      document.body.dataset.ready = 'saved-restart';
      return;
    }
    F.status(`Saved. ${r.body.written} Opening your week.`);
    document.body.dataset.ready = 'saved';
    location.href = 'search.html';
  }

  async function start() {
    const state = await HWP.ready;
    if (state !== 'ready') {
      $('lead').textContent = HWP.notice(state);
      document.body.dataset.ready = 'fatal';
      return;
    }
    const r = await F.call('GET', 'setup');
    const toWeek = () => $('lead').append(F.el('a', { href: 'search.html', textContent: ' Open your week.' }));
    if (r.status !== 200 || r.body.configured) {
      $('lead').textContent = r.body.configured ? r.body.note : r.status === 404 ? 'This folder already has a config.' : r.body.message ?? `The server answered ${r.status}.`;
      if (r.status === 404 || r.body.configured) toWeek();
      document.body.dataset.ready = r.body.configured ? 'configured' : 'fatal';
      return;
    }
    const info = r.body;
    $('lead').textContent = 'Check these, then save.';
    $('found').textContent = info.found;
    F.help($('rolesHelp'), 'roles', info.roles.map((x) => `${x.role}: ${x.meaning}.`));
    F.help($('emailHelp'), 'emails', ['A commit counts as yours only when one of these addresses wrote it. Separate several with commas.']);
    F.help($('wordsHelp'), 'private words', [info.privateWords.intro, 'Separate several with commas.']);
    F.help($('goalsHelp'), 'the goal list', ['A JSON file of your goals and their changes: { "goals": [{ "id": "g-1", "title": "Ship the parser" }], "events": [] }. Search and replay work without one.']);
    repos = info.repos.map((x) => ({ path: x.path, label: x.label, role: x.role }));
    const list = F.repoList($('repos'), repos, changed);
    F.addBox($('addPath'), $('addBtn'), list.add);
    $('emails').value = info.authorEmails.join(', ');
    if (info.emailNote) {
      $('emailNote').hidden = false;
      $('emailNote').textContent = info.emailNote;
    }
    $('timezone').value = info.timezone;
    historyOf = F.historyChoice(info.logs, info.history, changed).history;
    $('namesLabel').textContent = info.privateWords.names;
    $('termsLabel').textContent = info.privateWords.terms;
    for (const id of ['emails', 'timezone', 'names', 'terms', 'goals']) $(id).addEventListener('input', changed);
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
