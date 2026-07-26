// lib/worktrees.mjs — resolve every working tree that belongs to one git repository.
//
// WHY THIS EXISTS (in plain terms): honestweek decides which project a coding
// session belongs to by looking at where the session was started (its working
// directory) and checking whether that directory sits inside a configured repo
// folder. That works when the session ran in the repo folder itself, or in a
// sub-folder of it. It quietly fails when the session ran in a git WORKTREE that
// lives NEXT TO the repo folder rather than inside it — a second checkout of the
// SAME repository at a sibling path. Nothing about the path says "same repo", so
// the session fell into the catch-all "other" bucket and the project's session
// count read lower than the work that produced it.
//
// This module fixes that by asking git's own on-disk bookkeeping instead of
// guessing from the path shape: given one working tree, it returns EVERY working
// tree of the same repository (the primary one plus every linked worktree).
// Attribution then matches a session against that whole set.
//
// SCOPE — attribution only. This never changes which checkout honestweek READS
// COMMITS FROM. Commit enumeration stays pinned to the configured `repos[].path`,
// so a worktree sitting on a detached HEAD or a feature branch can never silently
// become the basis for the published commit counts. Session attribution and
// commit basis stay deliberately decoupled.
//
// Why a separate clone still stays "other": a sibling directory that is an
// INDEPENDENT clone of the same GitHub project has its own `.git` database and
// therefore never appears in this repository's worktree list. The discriminator
// becomes "is this literally the same git repository", which is stricter and more
// honest than the old "is this path nested inside that path".
//
// Fail-soft by design: any unreadable/malformed git metadata degrades to "just the
// path I was given". Attribution is a labelling concern, never a reason to abort a
// build that git verification would otherwise pass.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Normalize for comparison/dedup: forward slashes, no trailing slash. */
function normalize(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Read a git pointer file (`.git` in a linked worktree, or `worktrees/<n>/gitdir`)
 * and return its single trimmed line, or null. `gitdir:` prefixes are stripped.
 */
function readPointer(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const line = text.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  const trimmed = line.trim();
  const m = trimmed.match(/^gitdir:\s*(.+)$/);
  return (m ? m[1].trim() : trimmed) || null;
}

/**
 * The shared git directory (the ".git" of the primary working tree) for `root`,
 * or null when `root` is not inside a git repository.
 *   - `<root>/.git` is a DIRECTORY  -> root is the primary working tree.
 *   - `<root>/.git` is a FILE       -> root is a linked worktree; the file points
 *     at `<commonDir>/worktrees/<name>`, whose `commondir` file names the shared
 *     git directory (usually the relative "../..").
 */
function resolveCommonDir(root) {
  const gitEntry = join(root, '.git');
  let st;
  try {
    st = statSync(gitEntry);
  } catch {
    return null;
  }
  if (st.isDirectory()) return gitEntry;
  if (!st.isFile()) return null;

  const pointer = readPointer(gitEntry);
  if (!pointer) return null;
  const adminDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
  const common = readPointer(join(adminDir, 'commondir'));
  if (!common) return null;
  return isAbsolute(common) ? common : resolve(adminDir, common);
}

/**
 * resolveWorkTrees(root) -> string[]
 *
 * Every working tree of the git repository that `root` belongs to: the primary
 * working tree plus every linked worktree, with `root` itself always first (so a
 * non-git path, or a path whose git metadata is unreadable, degrades to `[root]`).
 * A BARE repository contributes no primary working tree, only its linked ones.
 * Order after the first element is git's own `worktrees/` directory order; callers
 * that care about precedence must compare matched-prefix length, not position.
 */
export function resolveWorkTrees(root) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    const key = normalize(p).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  add(root);
  if (!root) return out;

  try {
    const commonDir = resolveCommonDir(root);
    if (!commonDir) return out;

    // The primary working tree is the parent of the shared ".git" directory. A bare
    // repository's common dir is the repo itself (not named ".git"), and has none.
    if (basename(normalize(commonDir)) === '.git') add(dirname(commonDir));

    const worktreesDir = join(commonDir, 'worktrees');
    if (!existsSync(worktreesDir)) return out;
    let entries;
    try {
      entries = readdirSync(worktreesDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // `worktrees/<name>/gitdir` holds the absolute path of that worktree's own
      // `.git` FILE; the worktree root is its parent directory. A pruned/stale entry
      // simply yields a path that matches no session cwd — harmless.
      const pointer = readPointer(join(worktreesDir, e.name, 'gitdir'));
      if (!pointer) continue;
      const gitFile = isAbsolute(pointer) ? pointer : resolve(worktreesDir, e.name, pointer);
      add(dirname(gitFile));
    }
  } catch {
    // Unreadable or malformed git metadata: attribution degrades to the given path.
  }
  return out;
}

// One filesystem probe per configured repo per process. A build is a one-shot
// process, so the worktree set cannot meaningfully change under it; the cache keeps
// per-session attribution from re-walking git metadata thousands of times.
const cache = new Map();

/**
 * attributionRoots(configuredPath) -> string[]
 * Memoized resolveWorkTrees, for the per-session attribution hot path.
 */
export function attributionRoots(configuredPath) {
  const key = normalize(configuredPath).toLowerCase();
  let roots = cache.get(key);
  if (!roots) {
    roots = resolveWorkTrees(configuredPath);
    cache.set(key, roots);
  }
  return roots;
}

/** Drop the memoized worktree sets (tests that create/remove worktrees on disk). */
export function clearWorkTreeCache() {
  cache.clear();
}
