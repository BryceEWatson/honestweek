// lib/config-lookup.mjs: which honestweek.config.json a command reads, wherever it runs.
//
// Claude Code and Codex keep sessions for the whole machine, not per folder, so an agent working
// in some other project still wants the config the person set up. The lookup, in order:
//
//   1. --config <file>, when the command was given one;
//   2. honestweek.config.json in the folder the command runs in, so every existing setup (and a
//      scheduled run) reads exactly what it always read;
//   3. the file the HONESTWEEK_CONFIG environment variable names;
//   4. the user-level file, ~/.honestweek/honestweek.config.json.
//
// Steps 3 and 4 are on only when the entry point (bin/honestweek.mjs) turns them on. A library
// caller that hands a command its own `cwd`, such as a scheduled run or a test, reads that folder's
// config and nothing else, as it always has.
//
// A command that writes files (the draft, the items, the sidecars, the output) writes them beside
// the config it read, never into an unrelated folder it happened to run in: `dir` is that folder.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = 'honestweek.config.json';
export const CONFIG_ENV = 'HONESTWEEK_CONFIG';
/** The user-level folder, under the home folder. */
export const USER_DIR = '.honestweek';

/** The user-level config file for `home` (the home folder by default). */
export function userConfigPath(home = homedir()) {
  return join(home, USER_DIR, CONFIG_FILE);
}

let machine = null;

/**
 * Turn the machine-wide steps (HONESTWEEK_CONFIG, then the user-level file) on for this process,
 * and the one stderr line that names the config each command read. The entry point calls this
 * once; `null` turns them off again (tests).
 */
export function setConfigLookup(context = {}) {
  machine = context ? { env: context.env ?? process.env, home: context.home ?? homedir() } : null;
}

/** Whether the machine-wide steps are on. */
export function configLookupOn() {
  return machine !== null;
}

/** The user-level config file this process would read, or null when the lookup is off. */
export function lookupUserConfig() {
  return machine ? userConfigPath(machine.home) : null;
}

/** Whether anything is at `path`, a broken link included: a config here that can't be read is an
 *  error to report, never a reason to read another one. */
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const same = (a, b) => {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** The config's folder, kept exactly as the caller gave `cwd` when it's the same folder, so a
 *  message that prints the folder prints what it always printed. */
const folderOf = (path, cwd) => (same(dirname(path), cwd) ? cwd : dirname(path));

/**
 * findConfig({ cwd, flag, lookup }) -> { path, dir, source, exists }
 *
 * `source` says which step answered: 'flag' (--config), 'folder' (the folder it runs in), 'env'
 * (HONESTWEEK_CONFIG), 'user' (the user-level file), or 'none' (nowhere; `path` is then this
 * folder's, where today's messages say it's missing). A step that names a file stops the lookup
 * even when the file isn't there, so a typo in --config or HONESTWEEK_CONFIG is an error, never a
 * quiet fall through to another config. `dir` is the folder a writing command writes in.
 */
export function findConfig({ cwd = process.cwd(), flag, lookup = machine } = {}) {
  if (typeof flag === 'string' && flag) {
    const path = resolve(cwd, flag);
    return { path, dir: folderOf(path, cwd), source: 'flag', exists: existsSync(path) };
  }
  const here = join(cwd, CONFIG_FILE);
  if (present(here)) return { path: here, dir: cwd, source: 'folder', exists: true };
  if (lookup) {
    const named = lookup.env?.[CONFIG_ENV];
    if (typeof named === 'string' && named.trim()) {
      const path = resolve(cwd, named.trim());
      return { path, dir: folderOf(path, cwd), source: 'env', exists: existsSync(path) };
    }
    const user = userConfigPath(lookup.home);
    if (present(user)) return { path: user, dir: folderOf(user, cwd), source: 'user', exists: true };
  }
  return { path: here, dir: cwd, source: 'none', exists: false };
}

/**
 * takeConfigFlag(argv) -> { config, argv, error }
 * Takes `--config <file>` (or `--config=<file>`) out of `argv`, so each command's own parser sees
 * only its own options. `error` is a plain message for a missing value or a repeat.
 */
export function takeConfigFlag(argv = []) {
  const rest = [];
  let config;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let value;
    if (a === '--config') {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { config, argv, error: '--config needs a file.' };
      i += 1;
    } else if (typeof a === 'string' && a.startsWith('--config=')) {
      value = a.slice('--config='.length);
      if (!value) return { config, argv, error: '--config needs a file.' };
    } else {
      rest.push(a);
      continue;
    }
    if (config !== undefined) return { config, argv, error: '--config is given twice.' };
    config = value;
  }
  return { config, argv: rest };
}

/** `--config <file>` as it was given, for a printed next command to repeat; none without one. */
export function configAgain(config) {
  if (config === undefined) return [];
  return ['--config', /\s/.test(config) ? `"${config}"` : config];
}

const WHY = {
  flag: 'named with --config',
  folder: 'in this folder',
  env: `named by ${CONFIG_ENV}`,
  user: 'your user-level config',
};

/** How a config was found, in words ('in this folder'); null for none. */
export function configSourceWords(source) {
  return WHY[source] ?? null;
}

/** The one line that names the config a command read, and where its files go when that isn't the
 *  folder it runs in. '' when no config was found (the command's own message says so). */
export function configLine(command, found, { cwd = process.cwd(), writes = false } = {}) {
  if (!found || found.source === 'none') return '';
  const away = writes && !same(found.dir, cwd) ? ` Files it writes go in ${resolve(found.dir)}.` : '';
  return `honestweek ${command}: config ${found.path} (${WHY[found.source]}).${away}\n`;
}

/** Write configLine to `err` when the entry point turned the lookup on. */
export function noteConfig(err, command, found, options) {
  if (!machine) return;
  const line = configLine(command, found, options);
  if (line) err(line);
}

/**
 * commandConfig({ command, cwd, argv, err, writes }) -> { found, cwd, argv } or { error }
 * The lookup as a command uses it: takes --config out of `argv`, finds the config, names it on
 * stderr, and answers the folder the command works in from here on (the config's own).
 */
export function commandConfig({ command, cwd = process.cwd(), argv = [], err = () => {}, writes = true }) {
  const taken = takeConfigFlag(argv);
  if (taken.error) return { error: taken.error };
  const found = findConfig({ cwd, flag: taken.config });
  noteConfig(err, command, found, { cwd, writes });
  return { found, cwd: found.dir, argv: taken.argv };
}

/** What a missing config looks like for `found`, in one line that names the fix. */
export function missingConfig(found, command = 'honestweek') {
  if (found.source === 'flag') return `there's no config at ${found.path}, the file --config names.`;
  if (found.source === 'env') return `there's no config at ${found.path}, the file ${CONFIG_ENV} names.`;
  return `there's no ${CONFIG_FILE} here, no ${CONFIG_ENV}, and no user-level config. Run ${command} init (add --user to set one up for every folder), or ${command} view to set one up in your browser.`;
}
