// lib/view/setup.mjs: the Setup page's side of `honestweek view`, for a folder with no config.
//
// It does what `honestweek init` does, with init's own functions: it infers the email from
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

import { hostTimezone, isEmailShaped, normalizeConfig, resolveRepoPath, ROLES } from '../config.mjs';
import { buildConfig, displayTest, findRepos, foundLine, inferIdentity, isGitRepo, NAMES_QUESTION, parseWordList, PRIVATE_WORDS_INTRO, ROLE_MEANINGS, TERMS_QUESTION, writeInitFiles } from '../init.mjs';
import { privateWordCount } from '../private-words.mjs';

export const CONFIG_FILE = 'honestweek.config.json';
/** The largest answer the save and preview routes read. */
export const SETUP_MAX_BODY = 64 * 1024;
const FIELDS = new Set(['authorEmails', 'timezone', 'repos', 'names', 'terms', 'goalsFile']);
const REPO_FIELDS = new Set(['path', 'label', 'role']);
const MAX_REPOS = 200;
const MAX_EMAILS = 20;
const MAX_WORDS_TEXT = 10000;
const MAX_PATH = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;

const json = (status, body) => ({ status, body });
const refuse = (message, field) => json(400, { error: 'invalid', message, ...(field ? { field } : {}) });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

/** A question init asks at the terminal, as a label: the "or Enter to skip" ending is the terminal's. */
const asLabel = (question) => question.replace(/,? or Enter to skip: $/, '').replace(/: $/, '');

/**
 * createSetup({ cwd, command, inferEmail, checkGoals, onSaved }) -> { info, preview, save, pending }
 * `checkGoals(path)` throws with a plain message when a goal list can't be read.
 * `onSaved()` loads the new config and starts the week; it answers { next } or throws.
 */
export function createSetup({ cwd, command = 'honestweek', inferEmail, checkGoals = () => {}, onSaved = async () => ({}) }) {
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
    if (!pending()) return { configured: true, folder, configFile: CONFIG_FILE, note: `${CONFIG_FILE} is already in this folder, so there's nothing to set up.` };
    const p = propose();
    return {
      configured: false,
      folder,
      configFile: CONFIG_FILE,
      command,
      found: p.repos.length ? foundLine(p.repos, p.folded) : 'I found no git repositories in this folder or the folders next to it. Add one below by its folder path, or stop honestweek view and start it again from your project folder.',
      repos: p.repos,
      roles: roleMeanings(),
      authorEmails: p.authorEmail ? [p.authorEmail] : [],
      emailNote: p.authorEmail ? null : "I couldn't read your email from git's user.email. Type the address your commits use: a commit counts as yours only when one of your addresses wrote it.",
      timezone: hostTimezone(),
      privateWords: { intro: PRIVATE_WORDS_INTRO, names: asLabel(NAMES_QUESTION), terms: asLabel(TERMS_QUESTION) },
    };
  }

  /** The answers as a config, or a refusal that names the field. Reads nothing but the disk. */
  function check(body) {
    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      return { refusal: refuse("That answer isn't valid JSON, so nothing was written.") };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { refusal: refuse('The answer must be one JSON object, so nothing was written.') };
    const extra = Object.keys(raw).filter((k) => !FIELDS.has(k));
    if (extra.length) return { refusal: refuse(`The answer has fields setup doesn't take (${extra.slice(0, 5).join(', ')}). It only ever writes ${CONFIG_FILE} in ${folder}.`, extra[0]) };

    const emails = raw.authorEmails;
    if (!Array.isArray(emails) || emails.length === 0) return { refusal: refuse('Give at least one email address your commits use.', 'authorEmails') };
    if (emails.length > MAX_EMAILS) return { refusal: refuse(`Give at most ${MAX_EMAILS} email addresses.`, 'authorEmails') };
    const authorEmails = [];
    for (const e of emails) {
      const t = typeof e === 'string' ? e.trim() : '';
      if (t.length > 254 || !isEmailShaped(t)) return { refusal: refuse(`${JSON.stringify(String(e).slice(0, 80))} doesn't look like an email address.`, 'authorEmails') };
      if (!authorEmails.some((x) => x.toLowerCase() === t.toLowerCase())) authorEmails.push(t);
    }

    if (typeof raw.timezone !== 'string' || raw.timezone.length > 64 || !validTimezone(raw.timezone)) return { refusal: refuse(`${JSON.stringify(String(raw.timezone ?? '').slice(0, 64))} isn't a timezone this machine knows. Use an IANA name such as Europe/Paris or UTC.`, 'timezone') };

    if (!Array.isArray(raw.repos) || raw.repos.length === 0) return { refusal: refuse('honestweek needs at least one repository to read.', 'repos') };
    if (raw.repos.length > MAX_REPOS) return { refusal: refuse(`Give at most ${MAX_REPOS} repositories.`, 'repos') };
    const isDisplay = displayTest(found?.displayPaths ?? []);
    const repos = [];
    const notes = [];
    const seen = new Set();
    for (const [i, r] of raw.repos.entries()) {
      const field = `repos[${i}]`;
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !REPO_FIELDS.has(k))) return { refusal: refuse(`Repository ${i + 1} must have only a path, a label and a role.`, field) };
      if (typeof r.path !== 'string' || !r.path.trim() || r.path.length > MAX_PATH || CONTROL.test(r.path)) return { refusal: refuse(`Repository ${i + 1} needs a folder path.`, `${field}.path`) };
      if (!ROLES.includes(r.role)) return { refusal: refuse(`Repository ${i + 1}'s role must be featured, reference or display.`, `${field}.role`) };
      if (r.label !== undefined && (typeof r.label !== 'string' || r.label.length > 120 || CONTROL.test(r.label))) return { refusal: refuse(`Repository ${i + 1}'s label must be plain text of at most 120 characters.`, `${field}.label`) };
      // resolve() also tidies the spelling: one separator kind, no trailing one.
      const path = resolve(resolveRepoPath(r.path.trim(), folder));
      let isFolder = false;
      try {
        isFolder = statSync(path).isDirectory();
      } catch {
        isFolder = false;
      }
      if (!isFolder) return { refusal: refuse(`There's no folder at ${path}.`, `${field}.path`) };
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (seen.has(key)) return { refusal: refuse(`${path} is listed twice.`, `${field}.path`) };
      seen.add(key);
      let role = r.role;
      if (role !== 'display' && isDisplay(path)) {
        role = 'display';
        notes.push(`${basename(path)} stays display: this folder's config already marks it display-only.`);
      }
      // Only looked at on disk: a .git entry, never git itself.
      if (role !== 'display' && !isGitRepo(path)) return { refusal: refuse(`${path} isn't a git repository (it has no .git). Mark it display to name it without reading it, or pick another folder.`, `${field}.path`) };
      repos.push({ path, label: (r.label ?? '').trim() || basename(path), role });
    }

    const words = {};
    for (const k of ['names', 'terms']) {
      const v = raw[k] ?? '';
      if (typeof v !== 'string' || v.length > MAX_WORDS_TEXT) return { refusal: refuse(`The ${k === 'names' ? 'names' : 'client or project words'} must be plain text of at most ${MAX_WORDS_TEXT} characters.`, k) };
      words[k] = parseWordList(v);
    }

    let goalsFile;
    if (raw.goalsFile !== undefined && raw.goalsFile !== '') {
      if (typeof raw.goalsFile !== 'string' || raw.goalsFile.length > MAX_PATH || CONTROL.test(raw.goalsFile)) return { refusal: refuse('The goal list must be a file path.', 'goalsFile') };
      goalsFile = resolve(resolveRepoPath(raw.goalsFile.trim(), folder));
      try {
        checkGoals(goalsFile);
      } catch (err) {
        return { refusal: refuse(String(err?.message ?? err).replace(/^view: /, ''), 'goalsFile') };
      }
    }

    const config = buildConfig({ authorEmails, repos, timezone: raw.timezone, names: words.names, terms: words.terms, goalsFile });
    try {
      normalizeConfig(config, { configDir: folder });
    } catch (err) {
      return { refusal: refuse(String(err?.message ?? err)) };
    }
    if (privateWordCount(config) > 0) notes.push(`${CONFIG_FILE} will list your private words, so saving also adds it to .gitignore.`);
    return { config, notes };
  }

  function preview(body) {
    if (!pending()) return json(409, { error: 'exists', message: `${CONFIG_FILE} is already in this folder, so setup changes nothing. Open your week instead.` });
    propose();
    const r = check(body);
    if (r.refusal) return r.refusal;
    return json(200, { config: r.config, text: `${JSON.stringify(r.config, null, 2)}\n`, notes: r.notes, summary: `${plural(r.config.repos.length, 'repository', 'repositories')}, ${plural(r.config.identity.authorEmails.length, 'email address', 'email addresses')}, weeks in ${r.config.week.timezone}, ${plural(privateWordCount(r.config), 'private word')}.` });
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
    const written = `I wrote ${wrote.join(' and ')}${ignored ? `, and added ${plural(ignored, 'line')} to .gitignore so honestweek's private files stay out of git` : ''}.`;
    try {
      const next = await onSaved();
      return json(200, { saved: true, written, next: next?.next ?? 'search.html' });
    } catch (err) {
      return json(200, { saved: true, written, restart: `${String(err?.message ?? err).replace(/^view: /, '')} Your config is saved, so stop honestweek view with Ctrl+C and run ${command} view again to see your week.` });
    }
  }

  return { info, preview, save, pending };
}
