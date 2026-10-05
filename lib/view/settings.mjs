// lib/view/settings.mjs: the Settings page's side of `honestweek view`. It changes the config
// view started with, later, without the terminal: how far back to look, the repositories and
// their roles, the author emails, the private words, the goal list, whether the Problems page
// includes /insights, and the long-session limit it checks against.
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
import { HISTORY_LIMIT_MB, LONG_SESSION_MAX, LONG_SESSION_MIN, normalizeConfig, normalizeHistoryLimit, resolveRepoPath, ROLES } from '../config.mjs';
import { authorHasCommits, checkNestedRoles, displayTest, ensureGitignore, existingDisplayRepos, findRepos, repoLastCommitAt } from '../init.mjs';
import { privateWordCount } from '../private-words.mjs';
import { checkEmails, checkGoalsPath, checkHistory, checkRepo, checkWords, checkSameRepos, CONFIG_FILE, json, parseBody, plural, privateWordsText, refuse, roleMeanings } from './setup.mjs';

const FIELDS = new Set(['version', 'history', 'historyLimitMB', 'repos', 'authorEmails', 'names', 'terms', 'goalsFile', 'insights', 'longSessionTokens']);
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
 * saveInsightsFlag(cwd, on) -> { remembered: true, changed }
 * The Problems page's Include /insights toggle, written to the config in `cwd` alone: the rest
 * of the file stays as it was. Off removes the field, so a file that never had it gets back
 * the same bytes. Throws with a plain message when the file can't be read or written.
 */
export function saveInsightsFlag(cwd, on) {
  const folder = resolve(cwd);
  const path = join(folder, CONFIG_FILE);
  const text = readFileSync(path, 'utf8');
  const raw = JSON.parse(text);
  if ((raw.insights === true) === on && (on || raw.insights === undefined)) return { remembered: true, changed: false };
  if (on) raw.insights = true;
  else delete raw.insights;
  normalizeConfig(raw, { configDir: folder });
  atomicWriteText(path, serializeLike(raw, text));
  return { remembered: true, changed: true };
}

/**
 * createSettings({ cwd, editable, checkGoals, history, windowFor, onSaved }) -> { info, preview, save }
 * `windowFor(history, limitMB)` answers which days that would load and an estimate of the cost.
 * `editable()` answers null when this run's config can be changed here, or why it can't.
 * `onSaved()` reloads the week from the new file; it throws with a plain message when it can't.
 */
export function createSettings({ cwd, editable = () => null, checkGoals = () => {}, history = () => null, windowFor = () => null, onSaved = async () => ({}), lastCommitAt = repoLastCommitAt, hasCommits = authorHasCommits }) {
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
      // When each read repository was last committed to, for the list's order. A display-only
      // one is never passed to git (AGENTS.md invariant 4), so it has none.
      repos: (Array.isArray(r.repos) ? r.repos : []).map((x, index) => ({ index, path: String(x?.path ?? ''), label: String(x?.label ?? ''), role: x?.role, lastAt: x?.role === 'display' || typeof x?.path !== 'string' ? null : lastCommitAt(resolveRepoPath(x.path, folder)) ?? null })),
      roles: roleMeanings(),
      authorEmails: Array.isArray(r.identity?.authorEmails) ? r.identity.authorEmails : [],
      names: joined(r.redaction?.names),
      terms: joined(r.redaction?.terms),
      goalsFile: typeof r.goalsFile === 'string' ? r.goalsFile : '',
      insights: r.insights === true,
      longSessionTokens: Number.isInteger(r.longSessionTokens) ? r.longSessionTokens : null,
      privateWords: privateWordsText(),
    };
  }

  /**
   * The git repositories next to this folder that the config doesn't list yet, by any spelling
   * or worktree of one it does, found the way Setup finds them: newest commit first, each with
   * the role Setup would suggest. A folder the config marks display-only is never passed to git.
   */
  function found() {
    const why = closed();
    if (why) return { editable: false, note: why };
    let raw;
    try {
      raw = read().raw;
    } catch (err) {
      return { editable: false, note: `${CONFIG_FILE} can't be read (${String(err?.message ?? err).split('\n')[0]}).` };
    }
    const listed = displayTest((Array.isArray(raw.repos) ? raw.repos : []).filter((x) => typeof x?.path === 'string').map((x) => resolveRepoPath(x.path, folder)));
    const email = Array.isArray(raw.identity?.authorEmails) ? raw.identity.authorEmails[0] ?? null : null;
    const display = existingDisplayRepos(folder);
    // A repository holding a display-only folder, or inside one, isn't asked either: git reading
    // it would read that folder's history too (checkNestedRoles), and Save would refuse it.
    const clear = (p) => !checkNestedRoles([{ path: p, role: 'reference' }, ...display.map((d) => ({ path: d, role: 'display' }))]);
    const { repos } = findRepos(folder, email, { displayPaths: display, lastCommitAt: (p) => (clear(p) ? lastCommitAt(p) : null), hasCommits: (p, e) => clear(p) && hasCommits(p, e) });
    const fresh = repos.filter((x) => x.role !== 'display' && !listed(x.path) && clear(x.path));
    return { editable: true, repos: fresh.map((x) => ({ path: x.path, label: x.label, role: x.role, lastAt: x.lastAt ?? null })) };
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

    // Include /insights: written only when it changed; off removes the field.
    if (a.insights !== undefined && a.insights !== (was.insights === true)) {
      if (typeof a.insights !== 'boolean') return { refusal: refuse('Include /insights must be on or off.', 'insights') };
      if (a.insights) next.insights = true;
      else delete next.insights;
      changes.push(`Include /insights: ${a.insights ? 'on' : 'off'}.`);
    }

    // The long-session limit: a whole number of tokens, or null for off, which removes the field.
    const oldLimit = Number.isInteger(was.longSessionTokens) ? was.longSessionTokens : null;
    if (a.longSessionTokens !== undefined && a.longSessionTokens !== oldLimit) {
      const v = a.longSessionTokens;
      if (v !== null && !(Number.isInteger(v) && v >= LONG_SESSION_MIN && v <= LONG_SESSION_MAX)) {
        return { refusal: refuse(`The long-session limit must be a whole number of tokens from ${LONG_SESSION_MIN.toLocaleString('en-US')} to ${LONG_SESSION_MAX.toLocaleString('en-US')}, or empty for off.`, 'longSessionTokens') };
      }
      if (v === null) delete next.longSessionTokens;
      else next.longSessionTokens = v;
      changes.push(v === null ? 'Long-session limit: off.' : `Long-session limit: ${v.toLocaleString('en-US')} tokens.`);
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
      return json(200, { saved: true, changes: r.changes, next: 'problems.html' });
    } catch (err) {
      return json(200, { saved: true, changes: r.changes, restart: `${String(err?.message ?? err).replace(/^view: /, '')} Your settings are saved; stop honestweek view with Ctrl+C and start it again.` });
    }
  }

  return { info, found, preview, save };
}
