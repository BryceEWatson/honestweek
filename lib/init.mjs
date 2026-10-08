// lib/init.mjs — the `init` subcommand: two-confirmation, low-friction setup.
//
// `init` infers and proposes everything (identity, repo allowlist + roles, sane
// defaults), asks for the names and client words to keep private (optional), shows a
// summary of the proposed config, and writes NOTHING until the user confirms twice. All
// discovery is read-only — it never runs a mutating git command. Accepting every default
// (pressing through every question) yields a valid, buildable config.
//
// Zero runtime dependencies: Node built-ins + the system `git` CLI only.

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { hostTimezone, isEmailShaped, DEFAULT_OUTPUT_FILES, ROLES, resolveRepoPath } from './config.mjs';
import { PROMPT_GITIGNORE } from './prompt-store.mjs';
import { DIGEST_GITIGNORE } from './digest-store.mjs';
import { CARRY_GITIGNORE } from './digest-carry.mjs';
import { MINE_GITIGNORE } from './mine/ledger.mjs';
import { HISTORY_GITIGNORE } from './history.mjs';
import { HARVEST_GITIGNORE } from './harvest.mjs';
import { SAVED_GITIGNORE } from './saved/store.mjs';
import { atomicWriteText } from './atomic-json.mjs';
import { currentCommand } from './invocation.mjs';
import { findConfig, lookupUserConfig, takeConfigFlag, userConfigPath } from './config-lookup.mjs';
import { isUsedWord, neverPublicWordCount, privateWordCount, privateWordsNote } from './private-words.mjs';
import { resolveCommonDir } from './worktrees.mjs';
import { gitExec } from './git.mjs';
import { checkDisplayOverlap, checkNestedRoles, checkoutOf, displayTest, folderKey, nestsDisplay, reachesDisplay, repoIdentity, repoKey } from './repo-identity.mjs';

export { checkDisplayOverlap, checkNestedRoles, checkoutOf, displayTest, nestsDisplay, reachesDisplay, repoIdentity };

const CONFIG_FILE = 'honestweek.config.json';
const EXAMPLE_FILE = 'honestweek.config.example.json';
const GITIGNORE_FILE = '.gitignore';
// The line writeInitFiles reports when it adds the config itself to .gitignore.
const CONFIG_IGNORE_LINE = `${GITIGNORE_FILE} (+${CONFIG_FILE})`;
const DRAFT_SIDECAR = 'honestweek.draft.json';
// Run with Codex's folder (JUDGE_DIR in lib/view/codex-judge.mjs, which imports this module).
const CODEX_JUDGMENTS_GITIGNORE = Object.freeze(['honestweek.codex-judgments/']);

// The clean-room template init writes when no example exists: empty term-lists,
// placeholder-only values, NO real paths/names/repos/emails.
const EXAMPLE_CONFIG = {
  identity: { authorEmails: ['you@example.com'] },
  week: { startsOn: 'monday', timezone: 'UTC' },
  repos: [
    { path: '/path/to/your/repo', label: 'your-project', role: 'featured' },
    { path: '~/code/a-shared-repo', label: 'a-shared-repo', role: 'reference' },
    { path: '~/code/a-client-repo', label: 'a-private-project', role: 'display' },
  ],
  redaction: { codenames: [], names: [], terms: [] },
  curation: { maxItems: 12, automaticMinScore: 2, retentionWeeks: 12, automaticCarryWeeks: 2, categoryCaps: { prompts: 2, ideas: 2, techniques: 3, decisions: 2, reversals: 1, nextSteps: 2 } },
  privacy: { publicRenditions: { enabled: true, maxAutomaticChangedPercent: 20, generalizationMappings: {}, neverPublicTerms: [] } },
  output: { mode: 'digest', file: DEFAULT_OUTPUT_FILES.digest },
};

function git(repoPath, args) {
  return gitExec(args, { repo: repoPath });
}

/** git config user.email in `cwd`, or null if unavailable. Read-only. When `cwd`
 *  is a display-role repo, only the global git config is read, never the repo. */
export function inferAuthorEmail(cwd, { isDisplay = false } = {}) {
  try {
    const email = (isDisplay
      ? gitExec(['config', '--global', 'user.email'], { cwd: homedir() })
      : git(cwd, ['config', 'user.email'])
    ).trim();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/** True iff `email` has authored at least one commit in `repoPath`. Read-only. */
export function authorHasCommits(repoPath, email) {
  if (!email) return false;
  try {
    return git(repoPath, ['log', `--author=${email}`, '-1', '--format=%H']).trim().length > 0;
  } catch {
    return false;
  }
}

/** When the newest commit on any local branch was made, in ms, or null when git can't say. */
export function repoLastCommitAt(repoPath) {
  try {
    const out = git(repoPath, ['for-each-ref', '--count=1', '--sort=-committerdate', '--format=%(committerdate:unix)', 'refs/heads']).trim();
    const s = Number(out);
    return out && Number.isFinite(s) ? s * 1000 : null;
  } catch {
    return null;
  }
}

export function isGitRepo(dir) {
  return existsSync(join(dir, '.git'));
}

/** The main working tree of the repository `dir` belongs to: `dir` itself, unless it's a
 *  linked worktree (its `.git` is a file pointing into another checkout's `.git`). Reads
 *  git's files on disk; never runs git. A bare repository, or unreadable metadata, keeps `dir`. */
function mainWorkTree(dir) {
  const common = resolveCommonDir(dir);
  if (!common || basename(common) !== '.git') return dir;
  return dirname(common);
}

/**
 * findRepos(cwd, authorEmail) -> { repos: [{ path, label, role }], folded }
 * Scans the immediate children of cwd's parent, plus cwd itself, for git repos
 * (no recursion). A linked worktree (a second working copy of one repository) is folded
 * into its main working tree, because a configured repository already counts the sessions
 * of every worktree it has; `folded` counts the folders folded that way. A display-only
 * repository is matched by its own folder only, so its folders stay separate display-only
 * entries. Separate clones have their own git database and stay separate entries. The current
 * dir defaults to
 * "featured"; other repos default to "featured" if the author has committed in them, else
 * "reference". Each read repository carries `lastAt`, when its newest local commit was made
 * (ms, or null), and the list is ordered: cwd's repository first, then the most recently
 * committed, then those git gave no time for, in folder order. A display-only repository is
 * never asked (AGENTS.md invariant 4), so it has no `lastAt` and sorts with those. Nor is a
 * repository that holds a display-only folder, sits inside one, or has a worktree inside one,
 * since git reading it would read that folder's history too: it keeps its default role with
 * no `lastAt`, and init's nested-role refusal (checkNestedRoles) explains the conflict.
 */
export function findRepos(cwd, authorEmail, { displayPaths = [], hasCommits = authorHasCommits, lastCommitAt = repoLastCommitAt } = {}) {
  // A repo an existing config marks display-only keeps that role and is never
  // passed to git (AGENTS.md invariant 4).
  const isDisplay = displayTest(displayPaths);
  const nested = nestsDisplay(displayPaths);
  const cwdAbs = resolve(cwd);
  const parent = dirname(cwdAbs);
  const candidates = [cwdAbs];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(resolve(parent, entry.name));
    }
  } catch {
    /* parent unreadable — fall back to just cwd */
  }

  const seen = new Set();
  const byRepo = new Map();
  let found = 0;
  let cwdKey = null;
  for (const p of candidates) {
    const own = folderKey(p);
    if (seen.has(own)) continue;
    seen.add(own);
    if (!isGitRepo(p)) continue;
    found += 1;
    const main = mainWorkTree(p);
    const key = folderKey(main);
    if (p === cwdAbs) cwdKey = key;
    const entry = byRepo.get(key) ?? { path: main, label: basename(main), folders: [] };
    // The main checkout itself was found: name it the way the folder listing does.
    if (own === key) Object.assign(entry, { path: p, label: basename(p) });
    entry.folders.push(p);
    byRepo.set(key, entry);
  }

  const found_ = [];
  for (const [key, entry] of byRepo) {
    if (isDisplay(entry.path) || entry.folders.some((f) => isDisplay(f))) {
      for (const f of entry.folders) found_.push({ key, repo: { path: f, label: basename(f), role: 'display' } });
      continue;
    }
    const asked = !nested(entry.path) && !entry.folders.some(nested);
    const role = key === cwdKey || (asked && hasCommits(entry.path, authorEmail)) ? 'featured' : 'reference';
    const lastAt = asked ? lastCommitAt(entry.path) : null;
    found_.push({ key, repo: { path: entry.path, label: entry.label, role, lastAt: Number.isFinite(lastAt) ? lastAt : null } });
  }
  // cwd's repository first, then the most recently committed, then the rest in stable
  // (already-sorted by readdir) order.
  const at = (f) => f.repo.lastAt ?? -Infinity;
  found_.sort((a, b) => (a.key === cwdKey ? -1 : b.key === cwdKey ? 1 : at(b) - at(a) || 0));
  const repos = found_.map((f) => f.repo);
  return { repos, folded: found - repos.length };
}

/** findRepos without the count of folded worktrees. */
export function discoverRepos(cwd, authorEmail, opts = {}) {
  return findRepos(cwd, authorEmail, opts).repos;
}

/** What rewriting the config in `cwd` keeps from the one there: its display-only entries, as
 *  written, and its private words (the redaction lists and neverPublicTerms, leaving out blank
 *  entries as the redactor does, and repeats). A rewrite that dropped them would let git read a folder the
 *  person marked display-only, or stop hiding words they listed. An absent config keeps
 *  nothing; one that's there but can't be read keeps nothing, and `unreadable` says why ("not
 *  valid JSON", "not a config object", a plain reason for a file it can't open, or the error
 *  code), else it's false. Read-only. */
export function keptFromOldConfig(cwd, file = join(cwd, CONFIG_FILE)) {
  const none = (why) => ({ display: [], names: [], terms: [], codenames: [], neverPublicTerms: [], unreadable: why });
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    // JSON that isn't a config can't say which folders are display-only either.
    if (!config || typeof config !== 'object' || Array.isArray(config)) return none('not a config object');
    if (config.repos !== undefined && !Array.isArray(config.repos)) return none('its repos is not a list');
    const words = (list) => (Array.isArray(list) ? [...new Set(list.filter(isUsedWord))] : []);
    const display = (Array.isArray(config?.repos) ? config.repos : [])
      .filter((r) => r?.role === 'display' && typeof r.path === 'string')
      .map((r) => ({ path: r.path, label: typeof r.label === 'string' && r.label ? r.label : basename(r.path), role: 'display' }));
    const r = config?.redaction;
    return { display, names: words(r?.names), terms: words(r?.terms), codenames: words(r?.codenames), neverPublicTerms: words(config?.privacy?.publicRenditions?.neverPublicTerms), unreadable: false };
  } catch (err) {
    // A link to a missing file is still there: lstat sees it where existsSync follows it.
    let there = true;
    try {
      lstatSync(file);
    } catch {
      there = false;
    }
    return none(!there ? false : err instanceof SyntaxError ? 'not valid JSON' : (UNREADABLE_WHY[err?.code] ?? String(err?.code ?? 'unreadable')));
  }
}

/** Plain words for why a config that's there can't be read. */
const UNREADABLE_WHY = { EACCES: 'permission denied', EPERM: 'permission denied', EISDIR: "it's a folder", ENOENT: 'it links to a file that is missing', ELOOP: 'it links in a loop' };

/** Paths an existing config in `cwd` marks display-only, resolved against `cwd`.
 *  An absent or unreadable config marks none. Read-only. */
export function existingDisplayRepos(cwd) {
  return keptFromOldConfig(cwd).display.map((d) => resolveRepoPath(d.path, cwd));
}

/** The config every command run in `cwd` reads when the lookup found it outside `cwd`
 *  (HONESTWEEK_CONFIG or the user-level file): its path, the folders it marks display-only
 *  (resolved against its own folder), and why it can't be read, if it can't. null when the
 *  lookup is off, or this folder has its own config, or there's none elsewhere. Read-only. */
export function lookedUpConfig(cwd) {
  const found = findConfig({ cwd });
  if (found.source !== 'env' && found.source !== 'user') return null;
  const dir = dirname(found.path);
  const kept = keptFromOldConfig(dir, found.path);
  return { path: found.path, unreadable: kept.unreadable, display: kept.display.map((d) => resolveRepoPath(d.path, dir)) };
}

/** Assemble the config object from the inferred pieces and the private words given. The
 *  setup page may give several `authorEmails`, a `goalsFile` and a `history`; init gives none. */
export function buildConfig({ authorEmail, authorEmails, repos, timezone, names = [], terms = [], codenames = [], neverPublicTerms = [], goalsFile, history }) {
  return {
    identity: { authorEmails: authorEmails ? [...authorEmails] : authorEmail ? [authorEmail] : [] },
    week: { startsOn: 'monday', timezone: timezone || 'UTC' },
    repos: repos.map((r) => ({ path: r.path, label: r.label, role: r.role })),
    redaction: { codenames: [...codenames], names: [...names], terms: [...terms] },
    curation: { maxItems: 12, automaticMinScore: 2, retentionWeeks: 12, automaticCarryWeeks: 2, categoryCaps: { prompts: 2, ideas: 2, techniques: 3, decisions: 2, reversals: 1, nextSteps: 2 } },
    privacy: { publicRenditions: { enabled: true, maxAutomaticChangedPercent: 20, generalizationMappings: {}, neverPublicTerms: [...neverPublicTerms] } },
    output: { mode: 'digest', file: DEFAULT_OUTPUT_FILES.digest },
    ...(goalsFile ? { goalsFile } : {}),
    ...(history ? { history } : {}),
  };
}

const hasLine = (text, entry) => text.split(/\r?\n/).some((l) => l.trim() === entry);

/** Whether `.gitignore` in `cwd` already has `entry` as a line, so ensureGitignore would add nothing. */
export function gitignoreHas(cwd, entry) {
  try {
    return hasLine(readFileSync(join(cwd, GITIGNORE_FILE), 'utf8'), entry);
  } catch {
    return false;
  }
}

/** Append `entry` to `.gitignore` idempotently (create if absent). Returns true
 *  if a line was added. A new .gitignore gets the system's normal mode, not the owner-only
 *  one private stores get: it's a file the user commits, and it holds no private words. */
export function ensureGitignore(cwd, entry, fs) {
  const file = join(cwd, GITIGNORE_FILE);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (hasLine(existing, entry)) return false;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  atomicWriteText(file, `${prefix}${entry}\n`, fs, { newMode: null });
  return true;
}

/**
 * writeInitFiles(cwd, config, { force }) -> { wrote, skipped }
 * Writes honestweek.config.json (overwriting only when force), the generic
 * example if absent, and the .gitignore entries: the config itself, which always holds my email
 * and folder paths, the draft and every other private file honestweek makes. The ONLY disk writes. With `onlyNew` (the
 * setup page), a config already there, even one that appears while this runs, means nothing
 * at all is written. `example: false` leaves the example out (the user-level folder).
 */
export function writeInitFiles(cwd, config, { force = false, onlyNew = false, example = true } = {}) {
  const wrote = [];
  const skipped = [];
  const configPath = join(cwd, CONFIG_FILE);

  // The config lists private words as written, so a new one is readable only by its owner on
  // POSIX. Overwriting an existing one (--force) keeps the mode it has.
  if (onlyNew) {
    try {
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      return { wrote, skipped: [`${CONFIG_FILE} (already exists)`] };
    }
    wrote.push(CONFIG_FILE);
  } else if (existsSync(configPath) && !force) {
    skipped.push(`${CONFIG_FILE} (already exists; pass --force to overwrite)`);
  } else {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    wrote.push(CONFIG_FILE);
  }

  const examplePath = join(cwd, EXAMPLE_FILE);
  if (!example) {
    // The user-level folder holds no project, so it gets no example to commit.
  } else if (existsSync(examplePath)) {
    skipped.push(`${EXAMPLE_FILE} (already exists)`);
  } else {
    writeFileSync(examplePath, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
    wrote.push(EXAMPLE_FILE);
  }

  // Every config holds an email and folder paths, and private words added later are written as
  // typed, so it stays out of git from the start: ignoring it only once it's committed is too late.
  if (ensureGitignore(cwd, CONFIG_FILE)) wrote.push(CONFIG_IGNORE_LINE);
  if (ensureGitignore(cwd, DRAFT_SIDECAR)) wrote.push(`${GITIGNORE_FILE} (+${DRAFT_SIDECAR})`);
  else skipped.push(`${GITIGNORE_FILE} (${DRAFT_SIDECAR} already ignored)`);
  for (const entry of [...PROMPT_GITIGNORE, ...DIGEST_GITIGNORE, ...CARRY_GITIGNORE, ...MINE_GITIGNORE, ...HISTORY_GITIGNORE, ...HARVEST_GITIGNORE, ...CODEX_JUDGMENTS_GITIGNORE, ...SAVED_GITIGNORE]) {
    if (ensureGitignore(cwd, entry)) wrote.push(`${GITIGNORE_FILE} (+${entry})`);
    else skipped.push(`${GITIGNORE_FILE} (${entry} already ignored)`);
  }

  return { wrote, skipped };
}

function parseFlags(argv) {
  const taken = takeConfigFlag(argv ?? []);
  const flags = { yes: false, force: false, user: false, config: taken.config, error: taken.error };
  for (const a of taken.argv) {
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--user') flags.user = true;
  }
  if (!flags.error && flags.user && flags.config !== undefined) flags.error = '--user and --config both say where to write; give one.';
  return flags;
}

/** Where init writes: this folder, the user-level folder (--user), or the file --config names,
 *  which must be called honestweek.config.json so every command and Settings can find it. */
function initTarget(cwd, flags) {
  if (flags.user) return { dir: dirname(lookupUserConfig() ?? userConfigPath()), make: true };
  if (flags.config === undefined) return { dir: cwd, make: false };
  const file = resolve(cwd, flags.config);
  if (basename(file) !== CONFIG_FILE) return { error: `--config for init must name a file called ${CONFIG_FILE}.` };
  let isFolder = false;
  try {
    isFolder = statSync(dirname(file)).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) return { error: `there's no folder at ${dirname(file)} to write ${CONFIG_FILE} in.` };
  return { dir: resolve(dirname(file)) === resolve(cwd) ? cwd : dirname(file), make: false };
}

const isYes = (s, dflt) => {
  const t = String(s ?? '').trim().toLowerCase();
  if (t === '') return dflt;
  return t === 'y' || t === 'yes';
};

/** The question init asks when git doesn't know the person's email, as Setup does. */
export const EMAIL_QUESTION = "git doesn't know your email. Type the one your commits use, or press Enter to skip: ";

/** Ask for the email commits use; Enter skips. Three tries at most, so a script can't loop. */
async function askEmail(io) {
  for (let tries = 0; tries < 3; tries++) {
    const answer = String((await io.prompt(EMAIL_QUESTION)) ?? '').trim();
    if (!answer) return null;
    if (isEmailShaped(answer)) return answer;
    io.err(`  (that isn't an email address; type one like you@example.com, or press Enter to skip)\n`);
  }
  return null;
}

/** Marker for "stdin ended before a confirmation could be answered". */
const STDIN_EOF = 'HONESTWEEK_STDIN_EOF';

function eofError() {
  const err = new Error('stdin closed before the prompt was answered');
  err.code = STDIN_EOF;
  return err;
}

/**
 * The terminal: one line reader for the whole run, so answers piped in one go
 * (`printf '\ny\n' | honestweek init`) each reach their own question. A line that
 * arrives before its question waits in a queue; a question asked after stdin has
 * ended, with nothing queued, fails with STDIN_EOF.
 */
export function defaultIo({ input = process.stdin, output = process.stdout, errput = process.stderr } = {}) {
  let rl = null;
  let ended = false;
  const queue = [];
  const waiters = [];
  const start = () => {
    rl = createInterface({ input, terminal: false });
    rl.on('line', (line) => {
      const w = waiters.shift();
      if (w) w.resolve(line);
      else queue.push(line);
    });
    rl.on('close', () => {
      ended = true;
      for (const w of waiters.splice(0)) w.reject(eofError());
    });
  };
  // A piped answer isn't echoed by a terminal, so end the question's line here.
  const answered = (line) => {
    if (!input.isTTY) output.write('\n');
    return line;
  };
  return {
    out: (s) => output.write(s),
    err: (s) => errput.write(s),
    prompt(question) {
      if (!rl) start();
      output.write(question);
      if (queue.length) return Promise.resolve(answered(queue.shift()));
      if (ended) return Promise.reject(eofError());
      return new Promise((res, rej) => waiters.push({ resolve: (line) => res(answered(line)), reject: rej }));
    },
    close() {
      rl?.close();
    },
  };
}

/** The three roles, in the words the repository list shows them with. */
export const ROLE_MEANINGS = "featured: your own work, read from git and shown first; reference: read from git and shown after featured; display: named only, git never reads it and its sessions stay out of lookups and goals";

function renderAllowlist(repos) {
  const w = String(repos.length).length;
  return repos.map((r, i) => `  [${String(i + 1).padStart(w)}] ${r.label} (${r.role})  ${r.path}`).join('\n');
}

/** "1 3 5-9" or "1,3,5-9" -> the distinct numbers in order, or null when a part isn't a
 *  number or a range. */
export function parseNumbers(text) {
  const out = new Set();
  for (const part of String(text ?? '').split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a || b - a > 100000) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

const EDIT_QUESTION = "Press Enter to keep this list, or change it: 'keep 1-5 9' keeps only those, 'drop 3 7-9' removes those, 'role 2 display' changes a role: ";

/** Interactive editing: keep or drop entries, or change roles, before confirming. */
async function editAllowlist(io, repos) {
  let working = repos.map((r) => ({ ...r }));
  for (;;) {
    io.out(`\nRepositories honestweek may read (${ROLE_MEANINGS}):\n${renderAllowlist(working)}\n`);
    const cmd = (await io.prompt(EDIT_QUESTION)).trim().toLowerCase();
    if (cmd === '') break;
    const roleM = /^role\s+(.+?)\s+(featured|reference|display)$/.exec(cmd);
    const listM = /^(keep|drop)\s+(.+)$/.exec(cmd);
    if (!roleM && !listM) {
      io.err("  (not a change I know; use 'keep N', 'drop N', 'role N <featured|reference|display>', or Enter)\n");
      continue;
    }
    const nums = parseNumbers(roleM ? roleM[1] : listM[2]);
    if (!nums || nums.some((n) => n > working.length)) {
      io.err(`  (use numbers from 1 to ${working.length}; a range such as 2-4 or a list such as 1,3 works too)\n`);
      continue;
    }
    const picked = new Set(nums.map((n) => n - 1));
    if (roleM) {
      for (const i of picked) working[i].role = roleM[2];
      continue;
    }
    const next = working.filter((_, i) => (listM[1] === 'keep' ? picked.has(i) : !picked.has(i)));
    if (!next.length) {
      io.err('  (that leaves no repositories; honestweek needs at least one)\n');
      continue;
    }
    working = next;
  }
  return working;
}

/** "a, b ,A" -> ['a', 'b']: split at commas or semicolons, each trimmed of spaces and of the
 *  quotes and brackets of a JSON list (`["Dana Doe", "Acme"]`, the way the config writes
 *  them), distinct ignoring case, at least two characters. */
export function parseWordList(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/[,;]/)) {
    const w = raw.replace(/^[\s[\]"'“”‘’]+|[\s[\]"'“”‘’]+$/g, '');
    if (w.length < 2 || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
  }
  return out;
}

export const PRIVATE_WORDS_INTRO =
  "Private words: honestweek hides these in everything it shows and writes, as [redacted:...], unless you turn on Show private text, a switch on view's page, on your own screen. Nothing else knows your clients' or teammates' names, so it can only hide the ones you list. You can add more later under \"redaction\" in honestweek.config.json.";
export const NAMES_QUESTION = "People's names to hide (yours, teammates', clients'), separated by commas, or Enter to skip: ";
export const TERMS_QUESTION = 'Client, company or project words to hide, separated by commas, or Enter to skip: ';

/** Ask for the names and client words to keep private. Either can be skipped. Each answer is
 *  read back as it will be stored, on the person's own terminal, so a misread shows before
 *  anything is written. Words the old config already lists stay, and only their count is
 *  printed; the answers add to them. */
async function askPrivateWords(io, kept) {
  io.out(`\n${PRIVATE_WORDS_INTRO}\n`);
  const keptCount = keptWordCount(kept);
  if (keptCount) io.out(`  Your old config already lists ${count(keptCount, 'private word')}. They stay; add any others below.\n`);
  const ask = async (question) => {
    const answer = await io.prompt(question);
    const words = parseWordList(answer);
    if (words.length) io.out(`  Hiding: ${words.join(' | ')}\n`);
    else if (answer.trim()) io.out('  Nothing to hide there: each entry needs at least two characters.\n');
    return words;
  };
  const both = (old, added) => [...new Set([...old, ...added])];
  const names = both(kept.names, await ask(NAMES_QUESTION));
  const terms = both(kept.terms, await ask(TERMS_QUESTION));
  return { names, terms, codenames: [...kept.codenames], neverPublicTerms: [...kept.neverPublicTerms] };
}

const keptWordCount = (kept) => kept.names.length + kept.terms.length + kept.codenames.length + kept.neverPublicTerms.length;

/** The private words a config init writes lists, counted as keptWordCount counts them: the
 *  redaction lists and neverPublicTerms, so what init prints about them agrees. */
const configWordCount = (config) => privateWordCount(config) + neverPublicWordCount(config);

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the config will say, in a few lines, instead of the whole file. */
function summarize(config) {
  const roles = ROLES.map((role) => [role, config.repos.filter((r) => r.role === role).length]).filter(([, n]) => n > 0);
  const { names } = config.redaction;
  const words = configWordCount(config);
  return [
    `  You: ${config.identity.authorEmails.join(', ') || 'no email found (fill in identity.authorEmails before build)'}. A commit counts as yours only when ${config.identity.authorEmails.length > 1 ? 'one of these addresses' : 'this address'} wrote it.`,
    `  Weeks: start on Monday, in ${config.week.timezone}.`,
    `  Repositories: ${config.repos.length} (${roles.map(([role, n]) => `${n} ${role}`).join(', ')}).`,
    `  Private words: ${words ? `${count(names.length, 'name')}, ${count(words - names.length, 'client or project word')}` : 'none'}.`,
    `  Weekly summary: a private digest written to ${config.output.file}.`,
  ].join('\n');
}

const isIgnoreLine = (line) => line.startsWith(`${GITIGNORE_FILE} (`);

function reportWrite(io, result, config) {
  for (const w of result.wrote) if (!isIgnoreLine(w)) io.out(`  wrote ${w}\n`);
  const added = result.wrote.filter(isIgnoreLine).length;
  if (added) io.out(`  wrote ${GITIGNORE_FILE} (${count(added, "entry for honestweek's private files", "entries for honestweek's private files")})\n`);
  for (const s of result.skipped) if (!isIgnoreLine(s)) io.out(`  skipped ${s}\n`);
  const had = result.skipped.filter(isIgnoreLine).length;
  if (had) io.out(`  skipped ${GITIGNORE_FILE} (${count(had, 'entry was', 'entries were')} already there)\n`);
  if (result.wrote.includes(CONFIG_IGNORE_LINE)) {
    io.out(`  ${CONFIG_FILE} holds your email, folder paths and any private words, so it's now in ${GITIGNORE_FILE}. If you committed it before, listing it there doesn't remove it from git: run git rm --cached ${CONFIG_FILE}.\n`);
  }
  const cmd = currentCommand();
  // Only the redaction lists hide a word in the person's own pages, so the note's gate is
  // privateWordCount; words kept out of public versions only are named in it, not counted as hiding.
  if (config && privateWordCount(config) === 0) io.out(`\n${privateWordsNote(cmd, { restart: false, publicOnly: neverPublicWordCount(config) })}\n`);
  io.out(`\nNext, find, check and replay your sessions in your browser:\n  ${cmd} view\nFor a weekly summary of last week, start with:\n  ${cmd} discover\n`);
}

export function foundLine(repos, folded) {
  if (!repos.length) return `Found no git repositories in this folder or the folders next to it, so nothing was written: honestweek needs at least one to read. Run ${currentCommand()} init again from your project folder, or from a folder next to your projects.`;
  const head = `Found ${count(repos.length, 'git repository', 'git repositories')}.`;
  if (!folded) return head;
  return folded === 1
    ? `${head} 1 more folder was an extra working copy (a git worktree) of one of them, so it's folded into its main repository, which counts its sessions too.`
    : `${head} ${folded} more folders were extra working copies (git worktrees) of those, so they're folded into their main repository, which counts their sessions too.`;
}

/** The display-only folders an existing config lists, and the email inferred from git. No
 *  folder of a display-only repository (its main checkout, a worktree, or a plain subfolder
 *  of either) is passed to git, nor one that holds a display-only folder, sits inside one, or
 *  sits in a checkout that holds one (nestsDisplay), so the email there comes from the global
 *  git config. */
export function inferIdentity(cwd, { inferEmail = inferAuthorEmail, configDir = cwd } = {}) {
  // Writing a config elsewhere (init --user, --config) still never runs git on a folder any
  // config marks display-only: the one here, the one being rewritten, or the one every other
  // command run here reads (HONESTWEEK_CONFIG, the user-level file).
  const displayPaths = [...new Set([...existingDisplayRepos(cwd), ...(resolve(configDir) === resolve(cwd) ? [] : existingDisplayRepos(configDir)), ...(lookedUpConfig(cwd)?.display ?? [])])];
  const isDisplay = displayTest(displayPaths);
  return { displayPaths, authorEmail: inferEmail(cwd, { isDisplay: isDisplay(cwd, { walk: true }) || nestsDisplay(displayPaths)(cwd) }) };
}

/** Core init flow with injectable cwd/argv/io (for testability). */
export async function runInit({ cwd = process.cwd(), argv = [], io = defaultIo(), inferEmail = inferAuthorEmail } = {}) {
  const flags = parseFlags(argv);
  const target = flags.error ? { error: flags.error } : initTarget(cwd, flags);
  if (target.error) {
    io.err(`honestweek init: ${target.error} Nothing was written.\n`);
    return 1;
  }
  // The config goes in `dir`: this folder, unless --user or --config said otherwise. The
  // repositories are still looked for here and in the folders next to it.
  const dir = target.dir;
  io.out(`honestweek init: set up ${CONFIG_FILE} in ${resolve(dir)}.${flags.yes ? '' : ' Nothing is written until you say yes.'}\n`);
  // A config that's there but can't be read can't say which folders are display-only, so init
  // stops before it runs git anywhere (AGENTS.md invariant 4; issue 171).
  const kept = keptFromOldConfig(dir);
  if (kept.unreadable) {
    io.err(`${CONFIG_FILE} is here but can't be read (${kept.unreadable}), so init can't tell which folders you marked display-only, and it runs git nowhere until it can. Fix the file, or move it away to start fresh, then run init again. Nothing was written.\n`);
    return 1;
  }
  // Writing elsewhere, the config in this folder still marks folders display-only, and so does
  // the one the other commands read from this folder (HONESTWEEK_CONFIG, the user-level file).
  const here = resolve(dir) === resolve(cwd) ? null : keptFromOldConfig(cwd);
  const around = lookedUpConfig(cwd);
  const blocked = here?.unreadable ? { path: join(resolve(cwd), CONFIG_FILE), why: here.unreadable } : around?.unreadable ? { path: around.path, why: around.unreadable } : null;
  if (blocked) {
    io.err(`${blocked.path} can't be read (${blocked.why}), so init can't tell which folders you marked display-only, and it runs git nowhere until it can. Fix the file, or move it away, then run init again. Nothing was written.\n`);
    return 1;
  }
  const identity = inferIdentity(cwd, { inferEmail, configDir: dir });
  const { displayPaths } = identity;
  // Asked in a terminal, a missing email is a question rather than a warning: build's authorship
  // check needs it (issue 163). With --yes there's nobody to ask.
  const authorEmail = identity.authorEmail ?? (flags.yes ? null : await askEmail(io));
  if (!authorEmail) {
    io.err(
      'Warning: could not infer your git user.email. identity.authorEmails will be empty. Fill it in before running build, or the authorship check cannot pass.\n'
    );
  }
  io.out('Looking for git repositories in this folder and the folders next to it...\n');
  const { repos, folded } = findRepos(cwd, authorEmail, { displayPaths });
  if (repos.length) io.out(`${foundLine(repos, folded)}\n`);
  const timezone = hostTimezone();
  const configExists = existsSync(join(dir, CONFIG_FILE));
  // A rewrite keeps the old config's private words, and its display-only folders the list
  // doesn't show: the person never saw those, so never chose to drop them. The list names each
  // folder of a display-only repository separately (findRepos), so they're matched by folder,
  // not by repository. Only counts are printed, since a label can be a client's name, and a
  // kept folder joins the nested check by its path alone, so a refusal names it by its folder.
  const shown = new Set(repos.map((r) => folderKey(r.path)));
  const unseen = kept.display.filter((d) => !shown.has(folderKey(resolveRepoPath(d.path, dir))));
  const keptWords = keptWordCount(kept);
  const sayKeptFolders = () => {
    if (unseen.length) io.out(`Keeping ${count(unseen.length, 'display-only folder')} from your old config that this search didn't list.\n`);
  };
  const forCheck = (list) => [...list.map((r) => ({ ...r, path: resolveRepoPath(r.path, cwd) })), ...unseen.map((d) => ({ path: resolveRepoPath(d.path, dir), role: 'display' }))];
  // A config with no repositories is one view and discover refuse, so none is written.
  // Nor is one where git would read a display-only repository (checkDisplayOverlap): the same
  // repository as display and read, or one inside the other. The display-only folders the old
  // config lists join the nested check, so a repository holding one, or whose folder is inside
  // one, or has a worktree inside one, is refused rather than written as one git reads.
  const listedDisplay = displayPaths.map((p) => ({ path: p, role: 'display' }));
  const overlap = (list) => checkDisplayOverlap(list) ?? checkNestedRoles([...list, ...listedDisplay]);
  const refuseNested = (line) => {
    io.err(`${line} Nothing was written.
`);
    return 1;
  };
  const noRepos = () => {
    io.err(`${foundLine(repos, folded)}\n`);
    return 1;
  };

  // Non-interactive escape hatch.
  if (flags.yes) {
    if (configExists && !flags.force) {
      io.out(`${CONFIG_FILE} already exists; leaving it unchanged (pass --force to overwrite).\n`);
      return 0;
    }
    if (!repos.length) return noRepos();
    const list = [...repos, ...unseen];
    const nested = overlap(forCheck(repos));
    if (nested) return refuseNested(nested);
    sayKeptFolders();
    if (keptWords) io.out(`Keeping the ${count(keptWords, 'private word')} your old config lists.\n`);
    const config = buildConfig({ authorEmail, repos: list, timezone, names: kept.names, terms: kept.terms, codenames: kept.codenames, neverPublicTerms: kept.neverPublicTerms });
    reportWrite(io, writeTo(dir, config, target), config);
    return 0;
  }

  if (!repos.length) return noRepos();
  if (configExists) {
    io.out(`Note: ${CONFIG_FILE} already exists and will be overwritten only if you confirm.\n`);
  }

  // First confirmation: the repositories (after any edits).
  const finalRepos = await editAllowlist(io, repos);
  const finalList = [...finalRepos, ...unseen];
  // A repository that holds a display-only folder, or sits inside one, can be marked
  // display-only too, so init offers that rather than stopping (issue 163). The folder init runs
  // in defaults to no, since marking it means git reads none of it. The reason shown is the
  // culprit's own, so the question never names a different repository than the line above it.
  for (let nested = overlap(forCheck(finalRepos)); nested; nested = overlap(forCheck(finalRepos))) {
    const display = [...forCheck(finalRepos).filter((x) => x.role === 'display'), ...listedDisplay];
    const reasonFor = (r) => (r.role === 'display' ? null : checkNestedRoles([{ ...r, path: resolveRepoPath(r.path, cwd) }, ...display]));
    const culprit = finalRepos.find((r) => reasonFor(r) !== null);
    if (!culprit) return refuseNested(nested);
    const reason = reasonFor(culprit);
    const here = repoIdentity(resolveRepoPath(culprit.path, cwd)) === repoIdentity(resolve(cwd));
    const answer = await io.prompt(`\n${reason}\nMark ${culprit.label} display-only too? [${here ? 'y/N' : 'Y/n'}] `);
    if (!isYes(answer, !here)) return refuseNested(reason);
    culprit.role = 'display';
    io.out(`  ${culprit.label} is display-only now, so git won't read it.\n`);
  }
  sayKeptFolders();
  const ok1 = await io.prompt(`\nUse ${finalRepos.length === 1 ? 'this repository' : `these ${finalRepos.length} repositories`}? [Y/n] `);
  if (!isYes(ok1, true)) {
    io.out('Aborted; nothing was written.\n');
    return 1;
  }

  const { names, terms, codenames, neverPublicTerms } = await askPrivateWords(io, kept);

  // Second confirmation: what the config will say, before writing.
  const config = buildConfig({ authorEmail, repos: finalList, timezone, names, terms, codenames, neverPublicTerms });
  io.out(`\n${CONFIG_FILE} will say:\n${summarize(config)}\nIt's a plain JSON file, so you can open it and change any of this later.\n`);
  const writeDefault = !configExists; // default-yes for fresh setup, default-no to overwrite
  const ok2 = await io.prompt(`\nWrite ${CONFIG_FILE} now? [${writeDefault ? 'Y/n' : 'y/N'}] `);
  if (!isYes(ok2, writeDefault)) {
    io.out('Aborted; nothing was written.\n');
    return 1;
  }

  reportWrite(io, writeTo(dir, config, target), config);
  return 0;
}

/** writeInitFiles in init's target folder, made first when it's the user-level one, which gets
 *  no example file: it holds no project to commit one in. */
function writeTo(dir, config, target) {
  if (target.make) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return writeInitFiles(dir, config, { force: true, example: !target.make });
}

export default async function run(argv) {
  // A stdin that ends before the questions are answered lands here. Left
  // unhandled that was a silent exit 0 with nothing written, which reads as
  // success to a script, to CI, and to the agent shell the skill runs in.
  const io = defaultIo();
  try {
    return await runInit({ argv, io });
  } catch (err) {
    if (err?.code === STDIN_EOF) {
      process.stderr.write(
        '\nhonestweek init: stdin ended before the setup questions were answered, so nothing was written.\n' +
          'Re-run in an interactive terminal, or accept the inferred defaults non-interactively:\n' +
          `  ${currentCommand()} init --yes\n`
      );
      return 2;
    }
    throw err;
  } finally {
    io.close();
  }
}
