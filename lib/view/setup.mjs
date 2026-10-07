// lib/view/setup.mjs: the Setup page's side of `honestweek view`, for a folder with no config,
// and the checks Setup and Settings share.
//
// Setup does what `honestweek init` does, with init's own functions: it infers the email from
// git, finds the repositories nearby, explains the roles and the private words in init's
// words, builds the config with init's buildConfig, and writes it with writeInitFiles. The
// page sends its answers to this program only, in a POST body; nothing here logs them, puts
// them in an address, or writes them anywhere but the config file.
//
// Every write lands in the folder the command was started in, which no request can change.
// A config already there, or one that appears before saving, means nothing is written. A
// repository marked display is never passed to git: discovery skips any the folder's config
// already lists that way, and a repository added by path is only looked at on disk.

import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { hostTimezone, isEmailShaped, normalizeConfig, normalizeHistory, resolveRepoPath, ROLES } from '../config.mjs';
import { buildConfig, checkNestedRoles, displayTest, findRepos, foundLine, gitignoreHas, inferIdentity, isGitRepo, repoIdentity, NAMES_QUESTION, parseWordList, PRIVATE_WORDS_INTRO, ROLE_MEANINGS, TERMS_QUESTION, writeInitFiles } from '../init.mjs';
import { privateWordCount } from '../private-words.mjs';

export const CONFIG_FILE = 'honestweek.config.json';
/** The largest answer the save and preview routes read. */
export const SETUP_MAX_BODY = 64 * 1024;
/** The history choice Setup starts on: the last week, as view has always read. */
export const DEFAULT_HISTORY = Object.freeze({ days: 7 });
const FIELDS = new Set(['authorEmails', 'timezone', 'repos', 'names', 'terms', 'goalsFile', 'history']);
const REPO_FIELDS = new Set(['path', 'label', 'role']);
const MAX_REPOS = 200;
const MAX_EMAILS = 20;
const MAX_WORDS_TEXT = 10000;
const MAX_PATH = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const json = (status, body) => ({ status, body });
export const refuse = (message, field) => json(400, { error: 'invalid', message, ...(field ? { field } : {}) });
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** ROLE_MEANINGS, "featured: ...; reference: ...; display: ...", as one entry per role. */
export function roleMeanings() {
  return ROLE_MEANINGS.split('; ').map((part) => {
    const at = part.indexOf(': ');
    return { role: part.slice(0, at), meaning: part.slice(at + 2) };
  });
}

/** init's private-word questions as a short label each, and init's explanation for the "?". */
export function privateWordsText() {
  const short = (q) => q.replace(/, separated by commas.*$/, '').replace(/\s*\(.*\)/, '');
  return { intro: PRIVATE_WORDS_INTRO, names: short(NAMES_QUESTION), terms: short(TERMS_QUESTION) };
}

// ---- the checks Setup and Settings share: each answers { value } or { refusal } ----------------

/** A request body as one JSON object holding only `fields`. */
export function parseBody(body, fields, where) {
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    return { refusal: refuse("That answer isn't valid JSON, so nothing was written.") };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { refusal: refuse('The answer must be one JSON object, so nothing was written.') };
  const extra = Object.keys(raw).filter((k) => !fields.has(k));
  if (extra.length) return { refusal: refuse(`The answer has fields this page doesn't take (${extra.slice(0, 5).join(', ')}). It only ever writes ${CONFIG_FILE} in ${where}.`, extra[0]) };
  return { value: raw };
}

export function checkEmails(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return { refusal: refuse('Give at least one email address your commits use.', 'authorEmails') };
  if (emails.length > MAX_EMAILS) return { refusal: refuse(`Give at most ${MAX_EMAILS} email addresses.`, 'authorEmails') };
  const out = [];
  for (const e of emails) {
    const t = typeof e === 'string' ? e.trim() : '';
    if (t.length > 254 || !isEmailShaped(t)) return { refusal: refuse(`${JSON.stringify(String(e).slice(0, 80))} doesn't look like an email address.`, 'authorEmails') };
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return { value: out };
}

/** A network share or a device (\\host\share, //host/share, \\?\..., \\.\...), by its shape
 *  alone: on Windows, even asking whether such a folder exists contacts the host. */
export const isNetworkPath = (p) => /^[\\/]{2}/.test(String(p));
const NETWORK_NOTE = "That's a network or device path (it starts with two slashes). honestweek reads only folders on this machine, so it wasn't looked at.";

/** A repository typed or proposed as { path, label?, role }, checked on disk only (never git). */
export function checkRepo(r, i, folder, { isDisplay = () => false, notes = [] } = {}) {
  const field = `repos[${i}]`;
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !REPO_FIELDS.has(k))) return { refusal: refuse(`Repository ${i + 1} must have only a path, a label and a role.`, field) };
  if (typeof r.path !== 'string' || !r.path.trim() || r.path.length > MAX_PATH || CONTROL.test(r.path)) return { refusal: refuse(`Repository ${i + 1} needs a folder path.`, `${field}.path`) };
  if (!ROLES.includes(r.role)) return { refusal: refuse(`Repository ${i + 1}'s role must be featured, reference or display.`, `${field}.role`) };
  if (r.label !== undefined && (typeof r.label !== 'string' || r.label.length > 120 || CONTROL.test(r.label))) return { refusal: refuse(`Repository ${i + 1}'s label must be plain text of at most 120 characters.`, `${field}.label`) };
  // resolve() also tidies the spelling: one separator kind, no trailing one.
  const path = resolve(resolveRepoPath(r.path.trim(), folder));
  if (isNetworkPath(r.path.trim()) || isNetworkPath(path)) return { refusal: refuse(NETWORK_NOTE, `${field}.path`) };
  let isFolder = false;
  try {
    isFolder = statSync(path).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) return { refusal: refuse(`There's no folder at ${path}.`, `${field}.path`) };
  let role = r.role;
  if (role !== 'display' && isDisplay(path)) {
    role = 'display';
    notes.push(`${basename(path)} stays display: this folder's config already marks it display-only.`);
  }
  // Only looked at on disk: a .git entry, never git itself.
  if (role !== 'display' && !isGitRepo(path)) return { refusal: refuse(`${path} isn't a git repository (it has no .git). Mark it display to name it without reading it, or pick another folder.`, `${field}.path`) };
  return { value: { path, label: (r.label ?? '').trim() || basename(path), role } };
}

/**
 * Refuse a list naming one repository twice, however it's spelled: a symlink or junction to a
 * checkout, another case on Windows, or a second worktree of it. Several entries for one
 * repository are kept only when every one is display, since none is ever passed to git;
 * one display entry beside a read one would let git read a display repository.
 */
export function checkSameRepos(repos) {
  const groups = new Map();
  for (const [i, r] of repos.entries()) {
    const key = repoIdentity(r.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, i });
  }
  for (const g of groups.values()) {
    if (g.length < 2 || g.every((r) => r.role === 'display')) continue;
    const [a, b] = g;
    const names = `${a.label ?? a.path} and ${b.label ?? b.path}`;
    if (g.some((r) => r.role === 'display')) return { refusal: refuse(`${names} are the same repository, and one is marked display. Mark both display, or remove one.`, `repos[${b.i}].path`) };
    return { refusal: refuse(`${names} are the same repository. Remove one.`, `repos[${b.i}].path`) };
  }
  return null;
}

export function checkWords(v, k) {
  const text = v ?? '';
  if (typeof text !== 'string' || text.length > MAX_WORDS_TEXT) return { refusal: refuse(`The ${k === 'names' ? 'names' : 'client or project words'} must be plain text of at most ${MAX_WORDS_TEXT} characters.`, k) };
  return { value: parseWordList(text) };
}

/** A goal list path, resolved against `folder`, that `checkGoals` can read. '' means none. */
export function checkGoalsPath(v, folder, checkGoals) {
  if (v === undefined || v === '') return { value: null };
  if (typeof v !== 'string' || v.length > MAX_PATH || CONTROL.test(v) || !v.trim()) return { refusal: refuse('The goal list must be a file path.', 'goalsFile') };
  const path = resolve(resolveRepoPath(v.trim(), folder));
  if (isNetworkPath(v.trim()) || isNetworkPath(path)) return { refusal: refuse(NETWORK_NOTE, 'goalsFile') };
  try {
    checkGoals(path);
  } catch (err) {
    return { refusal: refuse(String(err?.message ?? err).replace(/^view: /, ''), 'goalsFile') };
  }
  return { value: path };
}

export function checkHistory(v) {
  try {
    return { value: normalizeHistory(v) };
  } catch {
    return { refusal: refuse('How far back must be the last week, a number of days from 1 to 3660, a start date, two dates in order, or all history.', 'history') };
  }
}

/**
 * createSetup({ cwd, command, inferEmail, checkGoals, history, onSaved }) -> { info, preview, save, pending }
 * `checkGoals(path)` throws with a plain message when a goal list can't be read.
 * `history()` describes the logs on this machine for the "how far back" choice.
 * `onSaved()` loads the new config and starts the week; it answers { next } or throws.
 */
export function createSetup({ cwd, command = 'honestweek', inferEmail, checkGoals = () => {}, history = () => null, onSaved = async () => ({}) }) {
  const folder = resolve(cwd);
  const configPath = join(folder, CONFIG_FILE);
  let found = null;
  let saved = false;

  /** What init would propose here, worked out once, the first time the page asks. */
  function propose() {
    if (found) return found;
    const { displayPaths, authorEmail } = inferIdentity(folder, inferEmail ? { inferEmail } : {});
    const { repos, folded } = findRepos(folder, authorEmail, { displayPaths });
    found = { displayPaths, authorEmail, repos, folded };
    return found;
  }

  const pending = () => !saved && !existsSync(configPath);

  function info() {
    if (!pending()) return { configured: true, folder, configFile: CONFIG_FILE, note: `${CONFIG_FILE} is already in this folder.` };
    const p = propose();
    return {
      configured: false,
      folder,
      configFile: CONFIG_FILE,
      command,
      found: p.repos.length ? foundLine(p.repos, p.folded) : 'No git repositories found nearby. Add one by its folder path.',
      repos: p.repos,
      roles: roleMeanings(),
      authorEmails: p.authorEmail ? [p.authorEmail] : [],
      emailNote: p.authorEmail ? null : "git doesn't know your email. Type the one your commits use.",
      timezone: hostTimezone(),
      history: DEFAULT_HISTORY,
      logs: history(),
      privateWords: privateWordsText(),
    };
  }

  /** The answers as a config, or a refusal that names the field. Reads nothing but the disk. */
  function check(body) {
    const b = parseBody(body, FIELDS, folder);
    if (b.refusal) return b;
    const raw = b.value;
    const emails = checkEmails(raw.authorEmails);
    if (emails.refusal) return emails;
    if (typeof raw.timezone !== 'string' || raw.timezone.length > 64 || !validTimezone(raw.timezone)) return { refusal: refuse(`${JSON.stringify(String(raw.timezone ?? '').slice(0, 64))} isn't a timezone this machine knows. Use an IANA name such as Europe/Paris or UTC.`, 'timezone') };
    if (!Array.isArray(raw.repos) || raw.repos.length === 0) return { refusal: refuse('honestweek needs at least one repository to read.', 'repos') };
    if (raw.repos.length > MAX_REPOS) return { refusal: refuse(`Give at most ${MAX_REPOS} repositories.`, 'repos') };
    const isDisplay = displayTest(found?.displayPaths ?? []);
    const repos = [];
    const notes = [];
    for (const [i, r] of raw.repos.entries()) {
      const c = checkRepo(r, i, folder, { isDisplay, notes });
      if (c.refusal) return c;
      repos.push(c.value);
    }
    const twice = checkSameRepos(repos);
    if (twice) return twice;
    const nested = checkNestedRoles(repos);
    if (nested) return { refusal: refuse(nested, 'repos') };
    const names = checkWords(raw.names, 'names');
    if (names.refusal) return names;
    const terms = checkWords(raw.terms, 'terms');
    if (terms.refusal) return terms;
    const goals = checkGoalsPath(raw.goalsFile, folder, checkGoals);
    if (goals.refusal) return goals;
    let hist = { value: DEFAULT_HISTORY };
    if (raw.history !== undefined) hist = checkHistory(raw.history);
    if (hist.refusal) return hist;

    const config = buildConfig({ authorEmails: emails.value, repos, timezone: raw.timezone, names: names.value, terms: terms.value, goalsFile: goals.value ?? undefined, history: { ...hist.value } });
    try {
      normalizeConfig(config, { configDir: folder });
    } catch (err) {
      return { refusal: refuse(String(err?.message ?? err)) };
    }
    // Save adds the line unless .gitignore already has it (init's ensureGitignore makes the same check).
    if (!gitignoreHas(folder, CONFIG_FILE)) notes.push(`Saving also adds ${CONFIG_FILE} to .gitignore, since it holds your email, folder paths and any private words.`);
    return { config, notes };
  }

  function preview(body) {
    if (!pending()) return json(409, { error: 'exists', message: `${CONFIG_FILE} is already in this folder, so setup changes nothing. Open your week instead.` });
    propose();
    const r = check(body);
    if (r.refusal) return r.refusal;
    return json(200, { config: r.config, text: `${JSON.stringify(r.config, null, 2)}\n`, notes: r.notes, summary: `${plural(r.config.repos.length, 'repository', 'repositories')}, ${plural(r.config.identity.authorEmails.length, 'email')}, ${plural(privateWordCount(r.config), 'private word')}.` });
  }

  async function save(body) {
    if (!pending()) return json(409, { error: 'exists', message: `${CONFIG_FILE} is already in this folder (it appeared after this page opened), so nothing was written or changed. Reload the page to see your week.` });
    propose();
    const r = check(body);
    if (r.refusal) return r.refusal;
    const result = writeInitFiles(folder, r.config, { onlyNew: true });
    if (!result.wrote.includes(CONFIG_FILE)) return json(409, { error: 'exists', message: `${CONFIG_FILE} appeared in this folder while saving, so nothing was written or changed. Reload the page to see your week.` });
    saved = true;
    const wrote = result.wrote.filter((w) => !w.startsWith('.gitignore ('));
    const ignored = result.wrote.length - wrote.length;
    const written = `Wrote ${wrote.join(' and ')}${ignored ? ` and ${plural(ignored, '.gitignore line')}` : ''}.`;
    try {
      const next = await onSaved();
      return json(200, { saved: true, written, next: next?.next ?? 'problems.html' });
    } catch (err) {
      return json(200, { saved: true, written, restart: `${String(err?.message ?? err).replace(/^view: /, '')} Your config is saved, so stop honestweek view with Ctrl+C and run ${command} view again to see your week.` });
    }
  }

  return { info, preview, save, pending };
}
