// The Settings page: change this folder's config later, without the terminal. How far back
// to look, the repositories and their roles, the emails, the private words, the goal list and
// whether the Problems page includes /insights.
// "Review changes" asks the server what would change, in plain words; Save writes it and the
// same server reloads the week, so the next page shows the new settings.
//
// The answers go only to this server, in a POST body with this run's key. A repository the
// page lists is sent by its place in the file, so every field it has stays as it was. Nothing
// typed is stored or put in the address. Needs key.js, private-text.js and form.js first.
(function () {
  'use strict';
  const HWP = window.HWP;
  const F = window.HWF;
  const { $ } = F;
  let shown = null;
  let repos = [];
  let reviewed = null;
  let historyOf = () => null;
  let limitOf = () => null;

  function answers() {
    return {
      version: shown.version,
      history: historyOf(),
      historyLimitMB: limitOf(),
      repos: repos.map((r) => (r.index === undefined ? { path: r.path, label: r.label, role: r.role } : { index: r.index, role: r.role })),
      authorEmails: F.emailsOf($('emails').value),
      names: $('names').value,
      terms: $('terms').value,
      goalsFile: $('goals').value.trim(),
      insights: $('insights').checked,
    };
  }
  function changed() {
    reviewed = null;
    $('changes').hidden = true;
    $('saveBtn').disabled = true;
    F.problem('');
  }
  function list(items) {
    const ul = $('changes');
    ul.textContent = '';
    for (const c of items) ul.append(F.el('li', { textContent: c }));
    ul.hidden = !items.length;
  }
  async function review() {
    F.problem('');
    const sent = answers();
    const r = await F.call('POST', 'settings/preview', sent);
    if (r.status !== 200) {
      changed();
      F.problem(r.body.message ?? `The server answered ${r.status}.`);
      return;
    }
    const items = [...r.body.changes, ...(r.body.notes ?? [])];
    if (!r.body.changes.length) {
      list([]);
      F.problem('Nothing changed.');
      return;
    }
    list(items);
    reviewed = JSON.stringify(sent);
    $('saveBtn').disabled = false;
  }
  async function save() {
    const sent = answers();
    if (reviewed !== JSON.stringify(sent)) return review();
    $('saveBtn').disabled = true;
    F.status('Saving.');
    const r = await F.call('POST', 'settings/save', sent);
    if (r.status !== 200) {
      F.status('');
      F.problem(r.body.message ?? `The server answered ${r.status}.`);
      return;
    }
    if (r.body.restart) {
      F.status(`Saved. ${r.body.restart}`, { bad: true });
      document.body.dataset.ready = 'saved-restart';
      return;
    }
    F.status('Saved. Loading your week.');
    document.body.dataset.ready = 'saved';
    location.href = 'problems.html';
  }

  async function start() {
    const state = await HWP.ready;
    const stop = (text) => {
      $('lead').hidden = false;
      $('lead').textContent = text;
      document.body.dataset.ready = 'closed';
    };
    if (state !== 'ready') return stop(HWP.notice(state));
    const r = await F.call('GET', 'settings');
    if (r.status !== 200) return stop(r.status === 404 ? "This run can't change settings." : r.body.message ?? `The server answered ${r.status}.`);
    if (!r.body.editable) return stop(r.body.note);
    shown = r.body;
    const hc = F.historyChoice(shown.logs, shown.history, changed, { limitStart: shown.historyLimitMB ?? undefined });
    historyOf = hc.history;
    // The limit is sent only when it moved, so a file without one stays without one.
    limitOf = () => (hc.limitMB() === (shown.historyLimitMB ?? shown.logs?.limits?.default ?? 500) ? shown.historyLimitMB : hc.limitMB());
    F.help($('rolesHelp'), 'roles', shown.roles.map((x) => `${x.role}: ${x.meaning}.`));
    F.roleKey($('roleKey'), shown.roles);
    F.help($('emailHelp'), 'emails', ['A commit counts as yours only when one of these addresses wrote it. Separate several with commas.']);
    F.help($('goalsHelp'), 'the goal list', ['A JSON file of your goals and their changes. Leave it empty for none.']);
    F.help($('insHelp'), '/insights', ["Shows what Claude Code's /insights wrote about your sessions on the Problems page, as its own AI-written group."]);
    repos = shown.repos.map((x) => ({ ...x }));
    const rl = F.repoList($('repos'), repos, changed);
    F.addBox($('addPath'), $('addBtn'), rl.add);
    $('emails').value = shown.authorEmails.join(', ');
    $('wordsIntro').textContent = shown.privateWords.intro;
    $('namesLabel').textContent = shown.privateWords.names;
    $('termsLabel').textContent = shown.privateWords.terms;
    $('names').value = shown.names;
    $('terms').value = shown.terms;
    const n = [shown.names, shown.terms].map((t) => t.split(',').filter((x) => x.trim()).length).reduce((a, b) => a + b, 0);
    $('wordsCount').textContent = `(${n})`;
    $('goals').value = shown.goalsFile;
    $('insights').checked = shown.insights === true;
    $('insights').addEventListener('change', changed);
    for (const id of ['emails', 'names', 'terms', 'goals']) $(id).addEventListener('input', changed);
    $('previewBtn').addEventListener('click', review);
    $('saveBtn').addEventListener('click', save);
    $('form').hidden = false;
    document.body.dataset.ready = '1';
  }
  start().catch((err) => {
    $('lead').hidden = false;
    $('lead').textContent = `This page couldn't be drawn: ${err?.message ?? err}`;
    document.body.dataset.ready = 'fatal';
  });
})();
