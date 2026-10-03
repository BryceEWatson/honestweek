// lib/invocation.mjs: the command a person typed to run honestweek, so a message that names
// a next step names one they can actually run.
//
// A person reaches the same code three ways: the `honestweek` command an npm install puts on
// their PATH, `npx github:<owner>/honestweek` (or `npx honestweek`), or `node <path>/bin/
// honestweek.mjs` from a clone or a Claude Code skill folder. A message that says "run
// honestweek init" to someone who started it with node names a command they don't have.
//
// The entry point (bin/honestweek.mjs) works the form out once and records it here; every
// message reads it back with currentCommand(). Code that never went through the entry point
// (the tests, a library caller) gets plain `honestweek`.
//
// Zero runtime dependencies: Node built-ins only.

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const NAME = 'honestweek';
const slash = (p) => String(p).replace(/\\/g, '/');
const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);

/** `p` relative to `cwd` when it sits inside it, otherwise absolute; forward slashes, which
 *  node, cmd, PowerShell and a POSIX shell all accept. */
function shortPath(p, cwd) {
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  return slash(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs);
}

/** The package spec npx installed, read from its cache folder's own package.json. */
function npxSpec(dir, pkg, readFile) {
  try {
    const spec = JSON.parse(readFile(join(dir, 'package.json'), 'utf8'))?.dependencies?.[pkg];
    return typeof spec === 'string' && spec.trim() ? spec.trim() : null;
  } catch {
    return null;
  }
}

/** The file a command runs: npm links its commands (`node_modules/.bin/honestweek`, `<prefix>/
 *  bin/honestweek`) to the package's own script on Linux and macOS, and node reports the link,
 *  not the script. A path that can't be followed is kept as it is. */
function followLink(p, realpath) {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/**
 * commandForm({ argv1, env, cwd, readFile, realpath }) -> the command prefix to print, such as
 * `honestweek`, `npx github:owner/honestweek` or `node bin/honestweek.mjs`.
 * `argv1` is the script node ran (process.argv[1]).
 */
export function commandForm({ argv1 = process.argv[1], env = process.env, cwd = process.cwd(), readFile = readFileSync, realpath = realpathSync } = {}) {
  if (typeof argv1 !== 'string' || !argv1) return NAME;
  const file = slash(followLink(argv1, realpath));
  // npx keeps each package it fetched in <npm cache>/_npx/<hash>/node_modules/<name>.
  const npx = /^(.*\/_npx\/[^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\/bin\/[^/]+$/.exec(file);
  if (npx) {
    const spec = npxSpec(npx[1], npx[2], readFile);
    if (spec && /^(?:github|gitlab|bitbucket|gist):|^git(?:\+[a-z]+)?:|^[\w.-]+\/[\w.-]+(?:#.*)?$/i.test(spec)) return `npx ${quote(spec)}`;
    if (spec && spec.startsWith('file:')) {
      // A relative file spec needs its leading ./ for npx to read it as a file.
      const p = shortPath(resolve(npx[1], spec.slice(5)), cwd);
      return `npx ${quote(/^(?:\.|\/|[A-Za-z]:)/.test(p) ? p : `./${p}`)}`;
    }
    return `npx ${npx[2]}`;
  }
  // An installed copy: the command npm put on the PATH, or `npx honestweek` from a project
  // that lists it as a dependency.
  if (file.includes('/node_modules/')) return env?.npm_command === 'exec' ? `npx ${NAME}` : NAME;
  return `node ${quote(shortPath(argv1, cwd))}`;
}

/**
 * The same command for a page of `honestweek view`. A page names steps that happen in another
 * folder (set it up in your project folder), where a path relative to this one doesn't reach
 * the script, and the redacted view never shows a path under the home folder. So a form that
 * names a file, relative or absolute, names it by a placeholder.
 */
export function pageCommand(form) {
  const text = String(form ?? '');
  if (/^node /.test(text)) return 'node <your honestweek folder>/bin/honestweek.mjs';
  if (/^npx "?(?:\.|\/|[A-Za-z]:\/)/.test(text)) return 'npx <your honestweek package file>';
  return text || NAME;
}

let current = NAME;

/** Record the form the entry point worked out. */
export function setCommandForm(form) {
  current = typeof form === 'string' && form.trim() ? form.trim() : NAME;
}

/** The form to print: what the entry point recorded, or `honestweek`. */
export function currentCommand() {
  return current;
}
