// lib/repo-identity.mjs: which repository a folder belongs to, from git's files on disk.
//
// Shared by init, Setup, Settings and config loading, so every one refuses the same lists:
// a display-only repository that git would read after all (AGENTS.md invariant 4). Never runs git.

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { gitDirOf, resolveCommonDir } from './worktrees.mjs';

const samePath = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/** One spelling for a folder, so two names for it compare equal: a symlink or junction on the
 *  way (git writes a worktree's main checkout by its real path), or another case on Windows.
 *  A folder that can't be followed keeps its resolved name. */
export function folderKey(p) {
  let real;
  try {
    real = realpathSync.native(p);
  } catch {
    real = resolve(p);
  }
  return samePath(real);
}

/** Whether an existing config marks a folder display-only, by either spelling of it. */
export function displayTest(displayPaths) {
  const keys = new Set(displayPaths.flatMap((p) => [samePath(p), folderKey(p)]));
  const repos = new Set(displayPaths.map((p) => repoKey(p)).filter(Boolean));
  return (p, { walk = false } = {}) => keys.has(samePath(p)) || keys.has(folderKey(p)) || (repos.size > 0 && repos.has(repoKey(p, { walk })));
}

/** One spelling per repository: its shared git folder when it's a checkout, else the folder,
 *  each through its real path (a symlink or junction followed) and, on Windows, one case. Two
 *  names for one checkout, or two worktrees of one repository, get the same key. Never runs git. */
export function repoIdentity(p) {
  return repoKey(p) ?? folderKey(p);
}

/** Whether folder `child` sits under folder `parent`, both already one spelling (folderKey). */
const isUnder = (child, parent) => child.length > parent.length && child.startsWith(parent) && (parent.endsWith(sep) || child[parent.length] === sep);

/**
 * The one-line refusal for a list where a display-only folder and a folder git reads overlap,
 * or null. Git reading a repository reads the history of every folder in it, so a display
 * folder inside a featured or reference repository (or inside another worktree of it) would be
 * read after all (AGENTS.md invariant 4); a read repository inside a display folder is refused
 * too, since the person said that whole folder is display-only. Folders are compared by their
 * real paths, so a junction, a symlink or another case on Windows can't hide the overlap. The
 * same folder twice is left to checkSameRepos. `repos` are { path, label?, role }, paths resolved.
 */
export function checkNestedRoles(repos) {
  const keyed = repos.map((r) => ({ ...r, key: folderKey(r.path), name: r.label || basename(r.path) }));
  const display = keyed.filter((r) => r.role === 'display');
  const read = keyed.filter((r) => r.role !== 'display');
  for (const d of display) {
    const walked = repoKey(d.path, { walk: true });
    for (const r of read) {
      if (isUnder(d.key, r.key) || (walked && !repoKey(d.path) && walked === repoKey(r.path))) return `${d.name} is display-only but sits inside ${r.name}, which git reads, so its history would be read too. Move it out of ${r.name}, or mark ${r.name} display as well.`;
      if (isUnder(r.key, d.key)) return `${r.name} is read by git but sits inside ${d.name}, which is display-only. Mark ${r.name} display as well, or remove one of them.`;
    }
  }
  return null;
}

/** Whether git running in folder `p` would reach a display-only folder too: `p` holds one, or
 *  sits inside one (checkNestedRoles). Never runs git. */
export function nestsDisplay(displayPaths) {
  const display = displayPaths.map((d) => ({ path: d, role: 'display' }));
  return (p) => checkNestedRoles([{ path: p, role: 'reference' }, ...display]) !== null;
}

/** The git repository a folder belongs to, as its shared git folder (the one every worktree
 *  of it points at), read from git's files on disk, never by running git. With `walk`, a
 *  subfolder is read from the checkout that holds it. Null outside a repository. */
export function repoKey(p, { walk = false } = {}) {
  for (let d = resolve(p); ; ) {
    // A worktree points at its repository's shared folder; a main checkout uses its own git
    // folder, which `git init --separate-git-dir` puts elsewhere and names in a .git file.
    if (existsSync(join(d, '.git'))) return folderKey(resolveCommonDir(d) ?? gitDirOf(d) ?? join(d, '.git'));
    const up = dirname(d);
    if (!walk || up === d) return null;
    d = up;
  }
}

/**
 * The one-line refusal for a repository list that would let git read a display-only
 * repository, or null: one repository listed both display and featured or reference (the
 * same folder twice, another spelling of it, or a worktree of it), or a display folder and a
 * read folder nested in each other (checkNestedRoles). Several entries for one repository
 * that are all display, or all read, are left alone here. `repos` are { path, label?, role },
 * paths resolved.
 */
export function checkDisplayOverlap(repos) {
  const groups = new Map();
  for (const r of repos) {
    const key = repoIdentity(r.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const g of groups.values()) {
    const d = g.find((r) => r.role === 'display');
    const read = g.find((r) => r.role !== 'display');
    if (d && read) return `${d.label || basename(d.path)} and ${read.label || basename(read.path)} are the same repository, and one is marked display, so git would read it. Mark both display, or remove one.`;
  }
  return checkNestedRoles(repos);
}
