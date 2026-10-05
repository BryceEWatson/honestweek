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
  // Save is always on: the server checks every answer again when it saves, says "Nothing
  // changed." when nothing did, and Review changes is only a look first.
  function changed() {
    $('changes').hidden = true;
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
    $('saveBtn').disabled = false;
  }
  async function save() {
    const sent = answers();
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

  /** "Find new repositories": the git repositories next to this folder the config doesn't list
   *  yet, newest commit first, each with an Add button that puts it in the list above. */
  async function findNew(rl) {
    const note = $('foundNote');
    const list = $('foundList');
    note.hidden = false;
    note.textContent = 'Looking next to this folder.';
    list.hidden = true;
    list.textContent = '';
    const r = await F.call('GET', 'settings/found');
    if (r.status !== 200 || !r.body.editable) {
      note.textContent = r.body?.note ?? r.body?.message ?? `The server answered ${r.status}.`;
      return;
    }
    const listed = new Set(repos.map((x) => x.path));
    const fresh = r.body.repos.filter((x) => !listed.has(x.path));
    const left = () => list.querySelectorAll('li').length;
    const say = () => {
      note.textContent = left() ? `${left()} not in your list yet, newest commit first.` : 'Every repository next to this folder is in your list.';
      list.hidden = !left();
    };
    for (const x of fresh) {
      const add = F.el('button', { type: 'button', className: 'btn', textContent: 'Add' });
      add.setAttribute('aria-label', `Add ${x.label}`);
      const main = F.el('div', { className: 'repomain' }, F.el('span', { className: 'reponame', textContent: x.label }), F.el('code', { className: 'repopath', textContent: x.path }));
      if (Number.isFinite(x.lastAt)) main.append(F.el('span', { className: 'repowhen', textContent: `last commit ${F.ago(x.lastAt)}` }));
      const li = F.el('li', { className: 'reporow' }, main, F.el('span', { className: 'muted', textContent: x.role }), add);
      add.addEventListener('click', () => {
        rl.add(x.path, x);
        li.remove();
        say();
      });
      list.append(li);
    }
    say();
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
    const rl = F.repoList($('repos'), repos, changed, { newestFirst: true });
    F.addBox($('addPath'), $('addBtn'), rl.add);
    $('findBtn').addEventListener('click', () => findNew(rl));
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
