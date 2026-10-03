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

import { readFileSync } from 'node:fs';
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

/**
 * commandForm({ argv1, env, cwd, readFile }) -> the command prefix to print, such as
 * `honestweek`, `npx github:owner/honestweek` or `node bin/honestweek.mjs`.
 * `argv1` is the script node ran (process.argv[1]).
 */
export function commandForm({ argv1 = process.argv[1], env = process.env, cwd = process.cwd(), readFile = readFileSync } = {}) {
  if (typeof argv1 !== 'string' || !argv1) return NAME;
  const file = slash(argv1);
  // npx keeps each package it fetched in <npm cache>/_npx/<hash>/node_modules/<name>.
  const npx = /^(.*\/_npx\/[^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\/bin\/[^/]+$/.exec(file);
  if (npx) {
    const spec = npxSpec(npx[1], npx[2], readFile);
    if (spec && /^(?:github|gitlab|bitbucket|gist):|^git(?:\+[a-z]+)?:|^[\w.-]+\/[\w.-]+(?:#.*)?$/i.test(spec)) return `npx ${quote(spec)}`;
    if (spec && spec.startsWith('file:')) return `npx ${quote(shortPath(resolve(npx[1], spec.slice(5)), cwd))}`;
    return `npx ${npx[2]}`;
  }
  // An installed copy: the command npm put on the PATH, or `npx honestweek` from a project
  // that lists it as a dependency.
  if (file.includes('/node_modules/')) return env?.npm_command === 'exec' ? `npx ${NAME}` : NAME;
  return `node ${quote(shortPath(argv1, cwd))}`;
}

/**
 * The same command for a page of `honestweek view`. The redacted view never shows a path
 * under the home folder, so a form that names an absolute path names it by a placeholder.
 */
export function pageCommand(form) {
  const m = /^(node|npx) "?(?:[A-Za-z]:\/|\/)/.exec(String(form ?? ''));
  if (!m) return String(form ?? NAME) || NAME;
  return m[1] === 'node' ? 'node <your honestweek folder>/bin/honestweek.mjs' : 'npx <your honestweek package file>';
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
