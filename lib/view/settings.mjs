// lib/view/settings.mjs: the Settings page's side of `honestweek view`. It changes the config
// view started with, later, without the terminal: how far back to look, the repositories and
// their roles, the author emails, the private words and the goal list.
//
// It edits the file as it stands on disk, field by field: everything the page doesn't show,
// and everything it shows but wasn't changed, stays exactly as it was (a repository's other
// fields, the order of the redaction lists, curation, privacy, output). The checks are
// Setup's own. A save names what changes first (preview), writes only the config in the
// folder view started in, and only if the file is still the one the page was shown: a file
// changed meanwhile is never overwritten. Nothing is written when any check fails.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { atomicWriteText } from '../atomic-json.mjs';
import { HISTORY_LIMIT_MB, normalizeConfig, normalizeHistoryLimit, resolveRepoPath, ROLES } from '../config.mjs';
import { checkNestedRoles, displayTest, ensureGitignore, existingDisplayRepos } from '../init.mjs';
import { privateWordCount } from '../private-words.mjs';
import { checkEmails, checkGoalsPath, checkHistory, checkRepo, checkWords, checkSameRepos, CONFIG_FILE, json, parseBody, plural, privateWordsText, refuse, roleMeanings } from './setup.mjs';

const FIELDS = new Set(['version', 'history', 'historyLimitMB', 'repos', 'authorEmails', 'names', 'terms', 'goalsFile']);
const MAX_REPOS = 200;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const joined = (list) => (Array.isArray(list) ? list.join(', ') : '');
const versionOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const historyWords = (h) => (!h ? 'the last 7 days' : h.all ? 'all history' : h.from && h.to ? `${h.from} to ${h.to}` : h.from ? `from ${h.from}` : h.days === 7 ? 'the last week' : `the last ${h.days} days`);

/** `value` as JSON written the way `text` is: its indent (spaces or a tab, the width of its
 *  first indented line), its line ending (\r\n or \n), and a final newline if it had one. */
export function serializeLike(value, text) {
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(value, null, indent).replace(/\n/g, eol);
  return /\r?\n$/.test(text) || !text ? `${body}${eol}` : body;
}

/**
 * createSettings({ cwd, editable, checkGoals, history, windowFor, onSaved }) -> { info, preview, save }
 * `windowFor(history, limitMB)` answers which days that would load and an estimate of the cost.
 * `editable()` answers null when this run's config can be changed here, or why it can't.
 * `onSaved()` reloads the week from the new file; it throws with a plain message when it can't.
 */
export function createSettings({ cwd, editable = () => null, checkGoals = () => {}, history = () => null, windowFor = () => null, onSaved = async () => ({}) }) {
  const folder = resolve(cwd);
  const path = join(folder, CONFIG_FILE);
  const read = () => {
    const text = readFileSync(path, 'utf8');
    return { text, raw: JSON.parse(text), version: versionOf(text) };
  };
  const closed = () => {
    const why = editable();
    if (why) return why;
    if (!existsSync(path)) return `There's no ${CONFIG_FILE} in this folder yet.`;
    return null;
  };

  function info() {
    const why = closed();
    if (why) return { editable: false, note: why };
    let cur;
    try {
      cur = read();
    } catch (err) {
      return { editable: false, note: `${CONFIG_FILE} can't be read (${String(err?.message ?? err).split('\n')[0]}).` };
    }
    const r = cur.raw;
    return {
      editable: true,
      version: cur.version,
      history: r.history ?? null,
      historyLimitMB: Number.isInteger(r.historyLimitMB) ? r.historyLimitMB : null,
      logs: history(),
      repos: (Array.isArray(r.repos) ? r.repos : []).map((x, index) => ({ index, path: String(x?.path ?? ''), label: String(x?.label ?? ''), role: x?.role })),
      roles: roleMeanings(),
      authorEmails: Array.isArray(r.identity?.authorEmails) ? r.identity.authorEmails : [],
      names: joined(r.redaction?.names),
      terms: joined(r.redaction?.terms),
      goalsFile: typeof r.goalsFile === 'string' ? r.goalsFile : '',
      privateWords: privateWordsText(),
    };
  }

  /** The new file from the answers, and the changes in plain words, or a refusal. */
  function check(body) {
    const why = closed();
    if (why) return { refusal: json(409, { error: 'not-editable', message: why }) };
    const b = parseBody(body, FIELDS, folder);
    if (b.refusal) return b;
    const a = b.value;
    let cur;
    try {
      cur = read();
    } catch (err) {
      return { refusal: json(409, { error: 'unreadable', message: `${CONFIG_FILE} can't be read, so nothing was written (${String(err?.message ?? err).split('\n')[0]}).` }) };
    }
    if (a.version !== cur.version) return { refusal: json(409, { error: 'changed', message: `${CONFIG_FILE} changed since this page opened, so nothing was written. Reload the page to see it as it is now.` }) };
    const next = JSON.parse(cur.text);
    const was = cur.raw;
    const changes = [];

    // How far back. null keeps the default, the last 7 days.
    if (!same(a.history, was.history)) {
      if (a.history === null) delete next.history;
      else {
        const h = checkHistory(a.history);
        if (h.refusal) return h;
        next.history = h.value;
      }
      changes.push(`How far back: ${historyWords(was.history)} to ${historyWords(next.history)}.`);
    }

    // The limit on log data loaded at once. null keeps the default, 500 MB.
    if (a.historyLimitMB !== undefined && !same(a.historyLimitMB, was.historyLimitMB)) {
      if (a.historyLimitMB === null) delete next.historyLimitMB;
      else {
        try {
          next.historyLimitMB = normalizeHistoryLimit(a.historyLimitMB);
        } catch (err) {
          return { refusal: refuse(String(err?.message ?? err).replace(/^honestweek config: /, ''), 'historyLimitMB') };
        }
      }
      changes.push(`Log limit: ${was.historyLimitMB ?? HISTORY_LIMIT_MB.default} MB to ${next.historyLimitMB ?? HISTORY_LIMIT_MB.default} MB.`);
    }
    // A new window or limit says what it will load, and what that's likely to cost.
    if (!same(next.history, was.history) || !same(next.historyLimitMB, was.historyLimitMB)) {
      const w = windowFor(next.history ?? null, next.historyLimitMB ?? HISTORY_LIMIT_MB.default);
      if (w?.line) changes.push(w.line, w.estimate);
    }

    // Repositories: { index, role } keeps a listed one (every field it has) with that role;
    // { path, label?, role } adds one, checked on disk only.
    if (!Array.isArray(a.repos) || a.repos.length === 0) return { refusal: refuse('honestweek needs at least one repository to read.', 'repos') };
    if (a.repos.length > MAX_REPOS) return { refusal: refuse(`Give at most ${MAX_REPOS} repositories.`, 'repos') };
    const old = Array.isArray(was.repos) ? was.repos : [];
    // A folder the file already marks display stays display when it's added again.
    const isDisplay = displayTest(existingDisplayRepos(folder));
    const repos = [];
    const kept = new Set();
    const notes = [];
    for (const [i, r] of a.repos.entries()) {
      if (r && typeof r === 'object' && 'index' in r) {
        if (Object.keys(r).some((k) => k !== 'index' && k !== 'role') || !Number.isInteger(r.index) || r.index < 0 || r.index >= old.length || kept.has(r.index)) return { refusal: refuse(`Repository ${i + 1} doesn't name one of the listed repositories.`, `repos[${i}]`) };
        if (!ROLES.includes(r.role)) return { refusal: refuse(`Repository ${i + 1}'s role must be featured, reference or display.`, `repos[${i}].role`) };
        kept.add(r.index);
        const entry = JSON.parse(JSON.stringify(old[r.index]));
        if (entry.role !== r.role) {
          changes.push(`${entry.label ?? entry.path}: ${entry.role} to ${r.role}.`);
          entry.role = r.role;
        }
        repos.push(entry);
        continue;
      }
      const c = checkRepo(r, i, folder, { isDisplay, notes });
      if (c.refusal) return c;
      changes.push(`Add ${c.value.label} (${c.value.role}).`);
      repos.push(c.value);
    }
    for (const [i, r] of old.entries()) if (!kept.has(i)) changes.push(`Remove ${r?.label ?? r?.path}.`);
    // One repository twice, by any spelling, is refused unless every entry for it is display.
    const twice = checkSameRepos(repos.map((r) => ({ path: typeof r.path === 'string' ? resolveRepoPath(r.path, folder) : folder, label: r.label, role: r.role })));
    if (twice) return twice;
    // Git would read a display-only folder inside a read repository, or the reverse.
    const nested = checkNestedRoles(repos.map((r) => ({ path: typeof r.path === 'string' ? resolveRepoPath(r.path, folder) : folder, label: r.label, role: r.role })));
    if (nested) return { refusal: refuse(nested, 'repos') };
    const order = repos.map((r) => JSON.stringify(r));
    if (!same(order, old.map((r) => JSON.stringify(r)))) next.repos = repos;

    // Emails: kept as written unless the list changed.
    const emails = checkEmails(a.authorEmails);
    if (emails.refusal) return emails;
    const oldEmails = Array.isArray(was.identity?.authorEmails) ? was.identity.authorEmails : [];
    if (!same(emails.value, oldEmails)) {
      next.identity = { ...(next.identity ?? {}), authorEmails: emails.value };
      changes.push(`Emails: ${plural(emails.value.length, 'address', 'addresses')}.`);
    }

    // Private words: a list is rewritten only when its text changed, so its order and spelling stay.
    for (const [k, label] of [['names', 'Names'], ['terms', 'Client or project words']]) {
      const before = Array.isArray(was.redaction?.[k]) ? was.redaction[k] : [];
      if (a[k] === joined(before)) continue;
      const w = checkWords(a[k], k);
      if (w.refusal) return w;
      if (same(w.value, before)) continue;
      next.redaction = { ...(next.redaction ?? {}), [k]: w.value };
      const lower = (l) => new Set(l.map((x) => x.toLowerCase()));
      const added = w.value.filter((x) => !lower(before).has(x.toLowerCase())).length;
      const removed = before.filter((x) => !lower(w.value).has(String(x).toLowerCase())).length;
      changes.push(`${label}: ${[added && `${added} added`, removed && `${removed} removed`].filter(Boolean).join(', ') || 'reworded'}.`);
    }

    // The goal list: kept as written unless it changed; empty removes it.
    const oldGoals = typeof was.goalsFile === 'string' ? was.goalsFile : '';
    const goalsText = typeof a.goalsFile === 'string' ? a.goalsFile.trim() : a.goalsFile;
    if (goalsText !== oldGoals) {
      const g = checkGoalsPath(goalsText, folder, checkGoals);
      if (g.refusal) return g;
      if (g.value === null) delete next.goalsFile;
      else next.goalsFile = goalsText;
      changes.push(g.value === null ? 'Goal list: none.' : 'Goal list: changed.');
    }

    try {
      normalizeConfig(next, { configDir: folder });
    } catch (err) {
      return { refusal: refuse(String(err?.message ?? err)) };
    }
    if (privateWordCount(next) > 0 && privateWordCount(was) === 0) notes.push(`Saving also adds ${CONFIG_FILE} to .gitignore, since it lists private words.`);
    return { next, changes, notes, cur };
  }

  function preview(body) {
    const r = check(body);
    if (r.refusal) return r.refusal;
    return json(200, { changes: r.changes, notes: r.notes });
  }

  async function save(body) {
    const r = check(body);
    if (r.refusal) return r.refusal;
    if (!r.changes.length) return json(200, { saved: false, changes: [], message: 'Nothing changed.' });
    atomicWriteText(path, serializeLike(r.next, r.cur.text));
    if (privateWordCount(r.next) > 0) ensureGitignore(folder, CONFIG_FILE);
    try {
      await onSaved();
      return json(200, { saved: true, changes: r.changes, next: 'search.html' });
    } catch (err) {
      return json(200, { saved: true, changes: r.changes, restart: `${String(err?.message ?? err).replace(/^view: /, '')} Your settings are saved; stop honestweek view with Ctrl+C and start it again.` });
    }
  }

  return { info, preview, save };
}
