// lib/view/settings.mjs: the Settings page's side of `honestweek view`. It changes the config
// view started with, later, without the terminal: how far back to look, the repositories and
// their roles, the author emails, the private words, the goal list, whether the Problems page
// includes /insights, the long-session limit it checks against, and whether results are saved
// between runs and for how long (lib/saved/).
//
// It edits the file as it stands on disk, field by field: everything the page doesn't show,
// and everything it shows but wasn't changed, stays exactly as it was (a repository's other
// fields, the order of the redaction lists, curation, privacy, output). The checks are
// Setup's own. A save names what changes first (preview), writes only the config view read,
// wherever it sits, and only if the file is still the one the page was shown: a file
// changed meanwhile is never overwritten. Nothing is written when any check fails.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { atomicWriteText } from '../atomic-json.mjs';
import { gitExec } from '../git.mjs';
import { HISTORY_LIMIT_MB, LONG_SESSION_MAX, LONG_SESSION_MIN, normalizeConfig, normalizeHistoryLimit, resolveRepoPath, ROLES, SAVE_KEEP_DAYS } from '../config.mjs';
import { authorHasCommits, checkNestedRoles, ensureGitignore, checkoutOf, displayTest, existingDisplayRepos, findRepos, keptFromOldConfig, lookedUpConfig, nestsDisplay, reachesDisplay, repoLastCommitAt } from '../init.mjs';
import { privateWordCount } from '../private-words.mjs';
import { SAVED_GITIGNORE } from '../saved/store.mjs';
import { checkEmails, checkGoalsPath, checkHistory, checkRepo, checkWords, checkSameRepos, CONFIG_FILE, json, parseBody, plural, privateWordsText, refuse, roleMeanings } from './setup.mjs';

const FIELDS = new Set(['version', 'history', 'historyLimitMB', 'repos', 'authorEmails', 'names', 'terms', 'goalsFile', 'insights', 'longSessionTokens', 'saveResults']);
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

/** One .gitignore line as a test on a file in the .gitignore's own folder, or null when the
 *  line can't match one there (a comment, a blank, a folder-only or deeper pattern). */
function gitignoreRule(line) {
  let t = line.replace(/\r$/, '');
  if (!t || t.startsWith('#')) return null;
  t = t.replace(/(?<!\\)\s+$/, '');
  let negate = false;
  if (t.startsWith('!')) {
    negate = true;
    t = t.slice(1);
  } else if (t.startsWith('\\!') || t.startsWith('\\#')) t = t.slice(1);
  if (t.startsWith('**/')) t = t.slice(3);
  else if (t.startsWith('/')) t = t.slice(1);
  if (!t || t.endsWith('/') || t.includes('/')) return null;
  const literal = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (c === '\\' && i + 1 < t.length) re += literal(t[++i]);
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += literal(c);
  }
  const pattern = new RegExp(`^${re}$`);
  return { negate, test: (name) => pattern.test(name) };
}

/** True when the folder's .gitignore ignores `name`, read in order so a later `!` line un-ignores it. */
export function gitignoreIgnores(folder, name) {
  const file = join(folder, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let ignored = false;
  for (const line of text.split('\n')) {
    const rule = gitignoreRule(line);
    if (rule && rule.test(name)) ignored = !rule.negate;
  }
  return ignored;
}

/** Adds the config to the folder's .gitignore unless it's already ignored there. */
function ignoreConfig(folder) {
  if (gitignoreIgnores(folder, CONFIG_FILE)) return false;
  const file = join(folder, '.gitignore');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  atomicWriteText(file, `${prefix}${CONFIG_FILE}\n`, undefined, { newMode: null });
  return true;
}

/** Whether git tracks the config in `folder`: 'tracked', 'untracked', or 'unchecked' when git
 *  isn't asked because it would reach a display-only folder (reachesDisplay; AGENTS.md invariant
 *  4). Outside any checkout there's nothing for git to track, so git isn't run and it reads as
 *  untracked, as it does with no git. */
export function configTrackState(folder) {
  if (checkoutOf(folder) === null) return 'untracked';
  if (reachesDisplay(existingDisplayRepos(folder))(folder)) return 'unchecked';
  try {
    gitExec(['ls-files', '--error-unmatch', '--', CONFIG_FILE], { repo: folder, stdio: 'ignore' });
    return 'tracked';
  } catch {
    return 'untracked';
  }
}

/** True when git tracks the config in `folder` (configTrackState). */
export function configTracked(folder) {
  return configTrackState(folder) === 'tracked';
}

/** Settings' note when it can't ask git whether the config is committed (issue 161). */
export const CANT_CHECK_CONFIG = `Check that ${CONFIG_FILE} was never committed to git. It holds your private words, and listing it in .gitignore doesn't remove it from git if it was committed before. honestweek can't check for you here because of your display-only setting. Run git ls-files ${CONFIG_FILE}. If it prints the file name, run git rm --cached ${CONFIG_FILE}.`;

/**
 * createSettings({ cwd, configDir, editable, checkGoals, history, windowFor, onSaved }) -> { info, preview, save }
 * `configDir()` answers the folder of the config this run reads (the folder view started in,
 * `cwd`, unless the config came from --config, HONESTWEEK_CONFIG or the user-level file); the
 * file, its .gitignore and its relative paths are that folder's. Repositories to add are still
 * looked for next to `cwd`.
 * `windowFor(history, limitMB)` answers which days that would load and an estimate of the cost.
 * `editable()` answers null when this run's config can be changed here, or why it can't.
 * `onSaved()` reloads the week from the new file; it throws with a plain message when it can't.
 * `saved()` answers what the saved-results folder holds (lib/saved/saver.mjs), or null.
 */
export function createSettings({ cwd, configDir = () => cwd, editable = () => null, checkGoals = () => {}, history = () => null, windowFor = () => null, onSaved = async () => ({}), saved = () => null, lastCommitAt = repoLastCommitAt, hasCommits = authorHasCommits }) {
  const here = resolve(cwd);
  const where = () => {
    const folder = resolve(configDir() ?? cwd);
    return { folder, path: join(folder, CONFIG_FILE) };
  };
  const read = () => {
    const text = readFileSync(where().path, 'utf8');
    return { text, raw: JSON.parse(text), version: versionOf(text) };
  };
  const closed = () => {
    const why = editable();
    if (why) return why;
    if (!existsSync(where().path)) return `There's no ${CONFIG_FILE} in ${where().folder === here ? 'this folder' : where().folder} yet.`;
    return null;
  };

  function info() {
    const { folder } = where();
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
      saveResults: { on: r.saveResults?.on === true, keepDays: Number.isInteger(r.saveResults?.keepDays) ? r.saveResults.keepDays : null, history: r.saveResults?.history !== false, defaultDays: SAVE_KEEP_DAYS.default, min: SAVE_KEEP_DAYS.min, max: SAVE_KEEP_DAYS.max },
      saved: saved(),
      privateWords: privateWordsText(),
    };
  }

  /**
   * The git repositories next to this folder that the config doesn't list yet, by any spelling
   * or worktree of one it does, found the way Setup finds them: newest commit first, each with
   * the role Setup would suggest. A folder the config marks display-only is never passed to git.
   */
  function found() {
    const { folder } = where();
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
    // Repositories are looked for next to the folder view started in, so the display-only
    // folders of a config there (or the one the lookup finds from there) are kept from git too,
    // not only those of the config this run edits.
    // One of those that can't be read can't say which folders it marks, so git runs nowhere.
    const startKept = keptFromOldConfig(here);
    const around = lookedUpConfig(here);
    const blocked = startKept.unreadable ? join(here, CONFIG_FILE) : around?.unreadable ? around.path : null;
    if (blocked) return { editable: false, note: `${blocked} can't be read, so Settings can't tell which folders it marks display-only, and doesn't look for repositories until it can.` };
    const display = [...new Set([...existingDisplayRepos(folder), ...startKept.display.map((d) => resolveRepoPath(d.path, here)), ...(around?.display ?? [])])];
    // findRepos never asks git about a repository holding a display-only folder, or inside one,
    // since git reading it would read that folder's history too (nestsDisplay). It isn't
    // offered either, since Save would refuse it.
    const nested = nestsDisplay(display);
    const { repos } = findRepos(here, email, { displayPaths: display, lastCommitAt, hasCommits });
    const fresh = repos.filter((x) => x.role !== 'display' && !listed(x.path) && !nested(x.path));
    return { editable: true, repos: fresh.map((x) => ({ path: x.path, label: x.label, role: x.role, lastAt: x.lastAt ?? null })) };
  }

  /** The new file from the answers, and the changes in plain words, or a refusal. */
  function check(body) {
    const { folder } = where();
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

    // Saved results: { on, keepDays, history } where keepDays null is the default and history is on
    // unless it's false. Off removes the field, so a file that never had it gets back the same
    // bytes; on keeps a chosen keepDays, and history only when it's turned off.
    if (a.saveResults !== undefined) {
      const v = a.saveResults;
      if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.on !== 'boolean' || Object.keys(v).some((k) => k !== 'on' && k !== 'keepDays' && k !== 'history') || (v.history !== undefined && typeof v.history !== 'boolean')) return { refusal: refuse('Save results must be on or off.', 'saveResults') };
      const keep = v.keepDays ?? null;
      if (keep !== null && !(Number.isInteger(keep) && keep >= SAVE_KEEP_DAYS.min && keep <= SAVE_KEEP_DAYS.max)) return { refusal: refuse(`Keep saved days for a whole number of days from ${SAVE_KEEP_DAYS.min} to ${SAVE_KEEP_DAYS.max.toLocaleString('en-US')}, or leave it empty for ${SAVE_KEEP_DAYS.default}.`, 'saveResults.keepDays') };
      const wasOn = was.saveResults?.on === true;
      const wasKeep = Number.isInteger(was.saveResults?.keepDays) ? was.saveResults.keepDays : null;
      const history = v.history !== false;
      const wasHistory = was.saveResults?.history !== false;
      if (v.on !== wasOn || (v.on && (keep !== wasKeep || history !== wasHistory))) {
        if (v.on) next.saveResults = { on: true, ...(keep !== null ? { keepDays: keep } : {}), ...(history ? {} : { history: false }) };
        else delete next.saveResults;
        changes.push(v.on ? `Save results between runs: on, ${history ? 'with each day\'s history' : 'check results only'}, kept ${(keep ?? SAVE_KEEP_DAYS.default).toLocaleString('en-US')} days.` : 'Save results between runs: off. What was saved stays until you press Forget saved results.');
        if (v.on && !gitignoreIgnores(folder, SAVED_GITIGNORE[0])) notes.push(`Saving also adds ${SAVED_GITIGNORE[0]} to .gitignore.`);
      }
    }

    try {
      normalizeConfig(next, { configDir: folder });
    } catch (err) {
      return { refusal: refuse(String(err?.message ?? err)) };
    }
    // A tracked config is worth a warning once it lists private words, and where git can't be
    // asked, so is checking by hand. Save adds the .gitignore line either way, and this makes the
    // same check it does, so the note matches what Save does.
    // Save repeats the warning (`warning`), since it can be pressed without Review.
    const trackState = privateWordCount(next) > 0 ? configTrackState(folder) : null;
    const warning = trackState === 'tracked' ? `${CONFIG_FILE} is tracked by git, so .gitignore won't hide it. It lists private words: run git rm --cached ${CONFIG_FILE} if it shouldn't be committed.` : trackState === 'unchecked' ? CANT_CHECK_CONFIG : null;
    if (warning) notes.push(warning);
    if (trackState !== 'tracked' && !gitignoreIgnores(folder, CONFIG_FILE)) notes.push(`Saving also adds ${CONFIG_FILE} to .gitignore, since it holds your email, folder paths and any private words.`);
    return { next, changes, notes, cur, warning };
  }

  function preview(body) {
    const r = check(body);
    if (r.refusal) return r.refusal;
    return json(200, { changes: r.changes, notes: r.notes });
  }

  async function save(body) {
    const { folder, path } = where();
    const r = check(body);
    if (r.refusal) return r.refusal;
    if (!r.changes.length) {
      // Save always adds the .gitignore line (Preview's note says so), so a save with nothing else to change still does.
      const ignored = ignoreConfig(folder);
      const message = ignored ? `Nothing in the config changed. ${CONFIG_FILE} is now in .gitignore.` : 'Nothing changed.';
      return json(200, { saved: false, changes: [], message: r.warning ? `${message} ${r.warning}` : message });
    }
    atomicWriteText(path, serializeLike(r.next, r.cur.text));
    ignoreConfig(folder);
    if (r.next.saveResults?.on === true) ensureGitignore(folder, SAVED_GITIGNORE[0]);
    const warning = r.warning ? { warning: r.warning } : {};
    try {
      await onSaved();
      return json(200, { saved: true, changes: r.changes, next: 'problems.html', ...warning });
    } catch (err) {
      return json(200, { saved: true, changes: r.changes, ...warning, restart: `${String(err?.message ?? err).replace(/^view: /, '')} Your settings are saved; stop honestweek view with Ctrl+C and start it again.` });
    }
  }

  return { info, found, preview, save };
}
