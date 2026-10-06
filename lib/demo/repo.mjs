// The demo week's git repositories, written without a git process per step.
//
// Starting git costs 30 ms a run on Windows, and more on a busy machine, and the week makes
// dozens of commits, each needing a stat line and a summary, so running git for every step
// took most of the build's time. Here the objects git would write (blobs, trees, commits) are
// hashed and stored by this file, the same bytes `git commit` writes, so every commit id is
// the one git would give. The worktrees, refs and each checkout's index are written the way
// git writes them, and the simple `git log` questions the logs print the answers to are
// answered here too. git itself still creates each repository (it knows the platform's
// settings) and answers anything else, such as `git log --stat`.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import { gitExec } from '../git.mjs';

const gitDate = (at) => `${Math.floor(Date.parse(at) / 1000)} +0000`;

/** A git run the way honestweek runs every one (lib/git.mjs: hardened, nothing GIT_* from the caller). */
const run = (cwd, args, env = {}) => gitExec(args, { cwd, env }).trim();

/** What `git commit -m` keeps of a message with commit.cleanup=whitespace. */
function cleanMessage(message) {
  const lines = message.split('\n').map((l) => l.replace(/\s+$/, ''));
  const kept = [];
  for (const l of lines) if (l || (kept.length && kept[kept.length - 1])) kept.push(l);
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return `${kept.join('\n')}\n`;
}

/** A file's lines as git's diff compares them: a last line with no newline differs from the same text with one. */
function linesOf(text) {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  else parts[parts.length - 1] += '\0no-newline';
  return parts;
}

/** The longest common subsequence of two line lists (Myers' O(ND) walk), so a minimal diff's
 *  insertions and deletions. Git's own diff is minimal on edits this small. */
function lcsLength(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - lo;
  const m = eb - lo;
  const max = n + m;
  if (!n || !m) return lo + (a.length - ea);
  const v = new Int32Array(2 * max + 2);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[lo + x] === b[lo + y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) return lo + (a.length - ea) + (n + m - d) / 2;
    }
  }
  return lo + (a.length - ea);
}

/** ` 3 files changed, 25 insertions(+), 2 deletions(-)`, worded as git words it. */
function shortStat(files, ins, del) {
  const parts = [`${files} file${files === 1 ? '' : 's'} changed`];
  if (ins || !del) parts.push(`${ins} insertion${ins === 1 ? '' : 's'}(+)`);
  if (del || !ins) parts.push(`${del} deletion${del === 1 ? '' : 's'}(-)`);
  return ` ${parts.join(', ')}`;
}

/**
 * createRepo(dir, { remote, name, email, config }) -> repo
 *
 * A repository on `main` whose commits are authored by `name <email>` at the times given.
 * Each checkout (the main one and every worktree) is tracked by its folder: its branch, the
 * files its last commit holds, and any file written on disk and not committed (`edit`), which
 * the next commit takes in as `git add -A` would. `finish()` writes each checkout's index,
 * so `git status` is clean wherever nothing was left uncommitted.
 */
export function createRepo(dir, { remote, name, email, config = [] } = {}) {
  mkdirSync(dir, { recursive: true });
  // No templates (they can carry hooks and settings), and SHA-1 object ids whatever
  // init.defaultObjectFormat says. git writes the platform's own settings (file modes,
  // symlinks, case) into the config; the demo's settings follow them.
  run(dir, ['init', '-q', '--template='], { GIT_DEFAULT_HASH: 'sha1' });
  const gitDir = join(dir, '.git');
  const sections = new Map();
  for (const [key, value] of config) {
    const [section, ...rest] = key.split('.');
    const k = rest.pop();
    const head = rest.length ? `${section} "${rest.join('.')}"` : section;
    if (!sections.has(head)) sections.set(head, []);
    sections.get(head).push(`\t${k} = ${value}`);
  }
  if (remote) sections.set('remote "origin"', [`\turl = ${remote}`, '\tfetch = +refs/heads/*:refs/remotes/origin/*']);
  appendFileSync(join(gitDir, 'config'), [...sections].map(([head, lines]) => `[${head}]\n${lines.join('\n')}\n`).join(''));
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

  const written = new Set();
  const commits = new Map(); // sha -> { tree: Map(path -> { sha, text }), parents, message }
  const branches = new Map(); // name -> sha
  const checkouts = new Map(); // folder -> { branch, files: Map(path -> { sha, text }), headFile }
  checkouts.set(resolve(dir), { branch: 'main', files: new Map(), dirty: new Map(), headFile: join(gitDir, 'HEAD') });
  const who = `${name} <${email}>`;

  const store = (type, body) => {
    const head = Buffer.from(`${type} ${body.length}\0`);
    const full = Buffer.concat([head, body]);
    const sha = createHash('sha1').update(full).digest('hex');
    if (!written.has(sha)) {
      written.add(sha);
      const p = join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, deflateSync(full));
    }
    return sha;
  };
  const blob = (text) => ({ sha: store('blob', Buffer.from(text, 'utf8')), text });
  /** A tree object for a folder's files, entries in git's order (a folder sorts as its name and a slash). */
  const treeOf = (files) => {
    const root = new Map();
    for (const [path, f] of files) {
      const parts = path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.has(part)) node.set(part, new Map());
        node = node.get(part);
      }
      node.set(parts[parts.length - 1], f);
    }
    const write = (node) => {
      const entries = [...node].map(([n, v]) => (v instanceof Map ? { key: `${n}/`, mode: '40000', name: n, sha: write(v) } : { key: n, mode: '100644', name: n, sha: v.sha }));
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
      return store('tree', Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
    };
    return write(root);
  };
  const setRef = (branch, sha) => {
    branches.set(branch, sha);
    const p = join(gitDir, 'refs', 'heads', ...branch.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${sha}\n`);
  };
  const checkoutOf = (cwd) => {
    const c = checkouts.get(resolve(cwd));
    if (!c) throw new Error(`demo-week: ${cwd} is not a checkout of ${dir}`);
    return c;
  };
  /** Make a checkout's files on disk match `files`, writing and removing only what differs. */
  const sync = (cwd, c, files) => {
    for (const [path] of c.files) if (!files.has(path)) rmSync(join(cwd, ...path.split('/')), { force: true });
    for (const [path, f] of files) {
      if (c.files.get(path)?.sha === f.sha && !c.dirty.has(path)) continue;
      const p = join(cwd, ...path.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.text);
    }
    c.files = new Map(files);
    c.dirty.clear();
  };
  const record = (cwd, files, message, at, parents) => {
    const c = checkoutOf(cwd);
    const time = gitDate(at);
    const body = [`tree ${treeOf(files)}`, ...parents.map((p) => `parent ${p}`), `author ${who} ${time}`, `committer ${who} ${time}`, '', cleanMessage(message)].join('\n');
    const sha = store('commit', Buffer.from(body, 'utf8'));
    commits.set(sha, { files: new Map(files), parents, message, time: Math.floor(Date.parse(at) / 1000), subject: cleanMessage(message).split('\n')[0] });
    sync(cwd, c, files);
    setRef(c.branch, sha);
    return describe(sha);
  };
  /** What `git show --shortstat --summary` prints for a commit, measured against its first parent. */
  const diff = (fromFiles, toFiles) => {
    let changed = 0;
    let ins = 0;
    let del = 0;
    const summary = [];
    const added = [];
    const removed = [];
    for (const path of [...new Set([...fromFiles.keys(), ...toFiles.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const a = fromFiles.get(path);
      const b = toFiles.get(path);
      if (a?.sha === b?.sha) continue;
      changed++;
      const la = linesOf(a?.text ?? '');
      const lb = linesOf(b?.text ?? '');
      const same = a && b ? lcsLength(la, lb) : 0;
      ins += lb.length - same;
      del += la.length - same;
      if (!a) {
        summary.push(` create mode 100644 ${path}`);
        added.push(path);
      }
      if (!b) {
        summary.push(` delete mode 100644 ${path}`);
        removed.push(path);
      }
    }
    // git would look for renames between an added and a removed file; the demo never needs one.
    if (added.length && removed.length) throw new Error('demo-week: a commit that adds and removes files could read as a rename');
    return { stat: shortStat(changed, ins, del), summary: summary.join('\n') };
  };
  const describe = (sha) => {
    const c = commits.get(sha);
    const parent = c.parents[0] ? commits.get(c.parents[0]).files : new Map();
    return { sha, short: sha.slice(0, 7), ...diff(parent, c.files) };
  };
  const ancestors = (sha) => {
    const seen = new Set();
    const queue = [sha];
    while (queue.length) {
      const s = queue.shift();
      if (seen.has(s)) continue;
      seen.add(s);
      queue.push(...commits.get(s).parents);
    }
    return seen;
  };

  /** `git log` as git prints it for the forms the demo asks (a branch or HEAD, -N, --since,
   *  --oneline or --format with %h %H %s %ae %ad, --date=short, and -- one path), on its linear
   *  history. Anything else returns null, for git to answer. */
  const log = (args, cwd) => {
    const o = { max: Infinity, since: null, format: null, date: null, rev: null, path: null };
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--oneline') o.format = '%h %s';
      else if (a.startsWith('--format=')) o.format = a.slice(9);
      else if (a === '--date=short') o.date = 'short';
      else if (a.startsWith('--since=')) o.since = Date.parse(a.slice(8)) / 1000;
      else if (/^-\d+$/.test(a)) o.max = Number(a.slice(1));
      else if (a === '--' && i === args.length - 2) o.path = args[++i];
      else if (!a.startsWith('-') && !o.rev && branches.has(a)) o.rev = a;
      else return null;
    }
    if (!o.format || (o.format.includes('%ad') && o.date !== 'short')) return null;
    const out = [];
    for (let sha = branches.get(o.rev ?? checkoutOf(cwd).branch); sha && out.length < o.max; ) {
      const c = commits.get(sha);
      if (o.since !== null && c.time < o.since) break;
      const before = c.parents[0] ? commits.get(c.parents[0]).files : new Map();
      if (!o.path || before.get(o.path)?.sha !== c.files.get(o.path)?.sha) {
        const fields = { h: sha.slice(0, 7), H: sha, s: c.subject, ae: email, ad: new Date(c.time * 1000).toISOString().slice(0, 10) };
        out.push(o.format.replace(/%(ae|ad|h|H|s)/g, (m, k) => fields[k]));
      }
      sha = c.parents[0];
    }
    return out.join('\n');
  };

  return {
    dir,
    /** A read-only git question (`log`, `show`, `diff`, `rev-parse`), as git answers it. */
    git(args, cwd = dir) {
      if (!['log', 'show', 'diff', 'rev-parse'].includes(args[0])) throw new Error(`demo-week: git ${args[0]} would change the repository behind the demo's back`);
      return (args[0] === 'log' ? log(args, cwd) : null) ?? run(cwd, args);
    },
    commit(files, message, at, cwd = dir) {
      const c = checkoutOf(cwd);
      const next = new Map(c.files);
      for (const [path, text] of [...c.dirty, ...Object.entries(files)]) {
        if (text === null) next.delete(path);
        else next.set(path, blob(text));
      }
      const parent = branches.get(c.branch);
      return record(cwd, next, message, at, parent ? [parent] : []);
    },
    /** What a squash merge on the host does, as the default branch sees it after a pull: each
     *  file as the side that changed it since the two parted. Both sides changing one file
     *  would need a line merge, which the demo never does. */
    squash(branch, message, at) {
      this.checkout('main');
      const main = branches.get('main');
      const tip = branches.get(branch);
      // The nearest commit both sides hold (the demo's history has no merges, so the first one
      // met walking back from the branch).
      const mine = ancestors(main);
      const base = [...ancestors(tip)].find((s) => mine.has(s));
      const [bf, mf, tf] = [base, main, tip].map((s) => commits.get(s).files);
      const merged = new Map(mf);
      for (const path of new Set([...bf.keys(), ...tf.keys()])) {
        const was = bf.get(path)?.sha;
        const theirs = tf.get(path);
        if (theirs?.sha === was) continue;
        if (mf.get(path)?.sha !== was && mf.get(path)?.sha !== theirs?.sha) throw new Error(`demo-week: both sides changed ${path}`);
        if (theirs) merged.set(path, theirs);
        else merged.delete(path);
      }
      return record(dir, merged, message, at, [main]);
    },
    /** Files written on disk and left uncommitted, as an editor saves them. */
    edit(files, cwd = dir) {
      const c = checkoutOf(cwd);
      for (const [path, text] of Object.entries(files)) {
        const p = join(cwd, ...path.split('/'));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
        c.dirty.set(path, text);
      }
    },
    /** Switch a checkout to a branch, creating it at the current commit with `create`. */
    checkout(branch, { create = false, cwd = dir } = {}) {
      const c = checkoutOf(cwd);
      if (create) {
        if (branches.has(branch)) throw new Error(`demo-week: branch ${branch} already exists`);
        setRef(branch, branches.get(c.branch));
      } else {
        // git carries an uncommitted edit across a switch when it can; the demo never needs to.
        if (c.dirty.size) throw new Error(`demo-week: switching ${cwd} to ${branch} with uncommitted edits`);
        sync(cwd, c, commits.get(branches.get(branch)).files);
      }
      c.branch = branch;
      writeFileSync(c.headFile, `ref: refs/heads/${branch}\n`);
    },
    /** `git reset --hard`: the checkout's files as its commit holds them, uncommitted edits gone. */
    resetHard(cwd = dir) {
      const c = checkoutOf(cwd);
      sync(cwd, c, commits.get(branches.get(c.branch)).files);
    },
    /** `git worktree add -b branch path from`: the files git writes for a worktree (absolute
     *  paths with forward slashes, as git writes them on every platform) and its checkout. */
    worktree(path, branch, from) {
      if (branches.has(branch)) throw new Error(`demo-week: branch ${branch} already exists`);
      const at = resolve(path);
      const admin = join(gitDir, 'worktrees', basename(at));
      const slashed = (p) => p.replace(/\\/g, '/');
      mkdirSync(admin, { recursive: true });
      mkdirSync(at, { recursive: true });
      writeFileSync(join(admin, 'gitdir'), `${slashed(join(at, '.git'))}\n`);
      writeFileSync(join(admin, 'commondir'), '../..\n');
      writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`);
      writeFileSync(join(at, '.git'), `gitdir: ${slashed(resolve(admin))}\n`);
      setRef(branch, branches.get(from));
      const c = { branch, files: new Map(), dirty: new Map(), headFile: join(admin, 'HEAD') };
      checkouts.set(at, c);
      sync(at, c, commits.get(branches.get(from)).files);
      return path;
    },
    head: (cwd = dir) => describe(branches.get(checkoutOf(cwd).branch)),
    /** A checkout's files as they are on disk: { path: text }. */
    files(cwd = dir) {
      const c = checkoutOf(cwd);
      return Object.fromEntries([...[...c.files].map(([path, f]) => [path, f.text]), ...c.dirty]);
    },
    diffStat: (a, b) => diff(commits.get(a).files, commits.get(b).files).stat,
    /** What git shows for every commit: { sha: { stat, summary } }. */
    stats: () => Object.fromEntries([...commits.keys()].map((sha) => [sha, describe(sha)])),
    /** Write each checkout's index from its commit, as `git reset` would. */
    finish() {
      for (const c of checkouts.values()) {
        const admin = dirname(c.headFile);
        const entries = [...c.files].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
        const parts = [Buffer.from('DIRC'), u32(2), u32(entries.length)];
        for (const [path, f] of entries) {
          const name = Buffer.from(path);
          const stat = Buffer.alloc(40);
          stat.writeUInt32BE(0o100644, 24);
          stat.writeUInt32BE(Buffer.byteLength(f.text), 36);
          const flags = Buffer.alloc(2);
          flags.writeUInt16BE(Math.min(name.length, 0xfff));
          const len = 62 + name.length;
          parts.push(stat, Buffer.from(f.sha, 'hex'), flags, name, Buffer.alloc(8 - (len % 8)));
        }
        const body = Buffer.concat(parts);
        writeFileSync(join(admin, 'index'), Buffer.concat([body, createHash('sha1').update(body).digest()]));
      }
    },
  };
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
