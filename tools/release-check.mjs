#!/usr/bin/env node
// tools/release-check.mjs: the readiness check docs/releasing.md runs before every release.
//
//   node tools/release-check.mjs [--since <ref>] [--no-smoke]
//
// 1. The package. `npm pack --dry-run` lists only what a release ships: package.json, the
//    README, the license, SKILL.md and its flows/ files, the example config, the two plugin manifests, bin/ and lib/.
//    Anything else, or any image, fails the check.
// 2. It runs. The packed tarball, installed into an empty folder, prints --help, serves
//    `view --demo`, and opens Setup when there's no config. Its home and temporary folders are
//    empty ones made for the check, so it reads no real logs and leaves nothing behind.
// 3. Secrets and personal data. Every commit and file version added since <ref> (the last
//    release tag by default) goes through honestweek's own secret-shape check, a search for key
//    formats, email addresses and home-folder paths, and the clean-room fence, and every commit's
//    author and committer are listed. This step prints what it finds for a person to judge:
//    made-up keys and addresses in tests are expected, so it never fails the run on its own.
//    Images added since <ref> are listed too, for a person to look at.
//
// Exit 0 when steps 1 and 2 pass, 1 when either fails, 2 on a usage error. Nothing here
// touches the network except npm itself, which installs a local tarball with no dependencies.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { secretShapes } from '../lib/problems/classify.mjs';
import { findForbidden, privateForbidden, readOwner, stripOwnAddress } from '../test/helpers/clean-room.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What a release ships, by path inside the tarball. */
const SHIPPED = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^SKILL\.md$/, /^flows\/[a-z-]+\.md$/, /^honestweek\.config\.example\.json$/, /^\.claude-plugin\/[^/]+\.json$/, /^bin\//, /^lib\//];
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

/** The packed paths that shouldn't be in a release: outside the shipped list, or an image. */
export function unexpectedFiles(paths) {
  return paths.filter((p) => !SHIPPED.some((re) => re.test(p)) || IMAGE.test(p) || /\.tgz$/i.test(p));
}

/** Runs npm. On Windows npm is a .cmd file, which Node starts only through a shell. */
function npm(args, opts = {}) {
  const win = process.platform === 'win32';
  const quoted = win ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
  return spawnSync(win ? 'npm.cmd' : 'npm', quoted, { encoding: 'utf8', maxBuffer: 1 << 28, shell: win, ...opts });
}

/** Step 1: { files, size, unpackedSize, unexpected } from `npm pack --dry-run --json`. */
export function packList(root = ROOT) {
  const r = npm(['pack', '--dry-run', '--json', '--no-update-notifier'], { cwd: root });
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  const [pack] = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  const paths = pack.files.map((f) => f.path.replace(/\\/g, '/'));
  return { files: paths.length, size: pack.size, unpackedSize: pack.unpackedSize, unexpected: unexpectedFiles(paths) };
}

/** A fresh folder for the check, removed by the caller. */
function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Starts `node <bin> <args>` and waits for the address it prints. Resolves with what it printed
 * and the status of a GET of that address, then stops it. Rejects when it exits first or prints
 * nothing within `ms`.
 */
function serveOnce(bin, args, { cwd, env, ms = 90_000 }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.once('exit', () => fn(value));
      child.kill();
    };
    const timer = setTimeout(() => finish(reject, new Error(`no address within ${ms / 1000} s: ${out.trim().slice(-300)}`)), ms);
    const onData = (chunk) => {
      out += chunk;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (!m || settled) return;
      get(m[0], (res) => {
        res.resume();
        finish(resolvePromise, { out, status: res.statusCode });
      }).on('error', (err) => finish(reject, err));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`exited with ${code} before serving: ${out.trim().slice(-300)}`));
    });
  });
}

/**
 * Step 2 against one honestweek bin: { help, demo, setup }, each true or an error message.
 * Home and the temporary folder point at an empty folder made here, so no real logs are read
 * and the demo week's own folder is removed with it.
 */
export async function smoke(bin) {
  const base = scratch('hw-release-check-');
  try {
    const home = join(base, 'home');
    const tmp = join(base, 'tmp');
    const empty = join(base, 'setup', 'empty');
    for (const d of [home, tmp, empty]) mkdirSync(d, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    const result = {};
    const help = spawnSync(process.execPath, [bin, '--help'], { cwd: empty, env, encoding: 'utf8' });
    result.help = help.status === 0 && /^honestweek: /.test(help.stdout) ? true : `exit ${help.status}: ${(help.stderr || help.stdout).trim().slice(0, 200)}`;
    for (const [name, args, expect] of [['demo', ['view', '--demo', '--no-open'], /made-up demo week/], ['setup', ['view', '--no-open'], /setup is open/]]) {
      try {
        const { out, status } = await serveOnce(bin, args, { cwd: empty, env });
        result[name] = status === 200 && expect.test(out) ? true : `answered ${status}; printed: ${out.trim().slice(0, 200)}`;
      } catch (err) {
        result[name] = err.message;
      }
    }
    return result;
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Step 2 on the real package: pack the tarball, install it into an empty folder, and smoke it. */
export async function smokePacked(root = ROOT) {
  const base = scratch('hw-release-pack-');
  try {
    const packed = npm(['pack', '--pack-destination', base, '--no-update-notifier'], { cwd: root });
    if (packed.status !== 0) return { install: `npm pack failed: ${(packed.stderr || '').trim().split('\n').pop()}` };
    const tgz = readdirSync(base).find((f) => f.endsWith('.tgz'));
    const into = join(base, 'install');
    mkdirSync(into);
    const installed = npm(['install', '--no-audit', '--no-fund', '--no-update-notifier', '--prefix', into, join(base, tgz)], { cwd: into });
    if (installed.status !== 0) return { install: `npm install failed: ${(installed.stderr || '').trim().split('\n').pop()}` };
    return { install: true, ...(await smoke(join(into, 'node_modules', 'honestweek', 'bin', 'honestweek.mjs'))) };
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const KEY_FORMATS = [
  ['private-key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['AWS key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Placeholder and no-reply addresses, which the repository uses on purpose. */
const placeholderEmail = (e) => /@(?:[\w-]+\.)*example\.(?:com|org|net)$|@users\.noreply\.github\.com$|^noreply@(?:github|anthropic)\.com$|\.(?:test|invalid|localhost|example)$/i.test(e);
const HOME_PATH = /(?:[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+|\/Users\/|\/home\/)([^\\/\s"'`<>:;,)]+)/g;
/** Lines are read in pieces this long, each overlapping the one before by LINE_OVERLAP. */
const LINE_PIECE = 20_000;
const LINE_OVERLAP = 2_000;

/**
 * Step 3: what came in since `since`, for a person to judge. Returns { commits, blobs, images,
 * identities, secretShapes, keyFormats, emails, homes, cleanRoom }; the last five are lists of
 * "where: what" strings, and emails and homes are maps from the value to where it appears.
 */
export function scanSince({ repo = ROOT, since, head = 'HEAD', owner = readOwner(ROOT) } = {}) {
  // Text by default; a Buffer when `input` is given (a blob may not be text).
  const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { ...(input === undefined ? { encoding: 'utf8' } : { input }), maxBuffer: 1 << 30 });
  const range = `${since}..${head}`;
  const objects = git(['rev-list', '--objects', range]).split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf(' ');
    return i < 0 ? [l, null] : [l.slice(0, i), l.slice(i + 1)];
  });
  // A file copied or renamed with its content unchanged brings no new object, so rev-list
  // misses its new path. The diff between the two ends names every path added or changed.
  const seen = new Set(objects.map(([sha, path]) => `${sha} ${path}`));
  const raw = git(['diff', '--raw', '--no-renames', '--no-abbrev', '-z', since, head]).split('\0');
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [, mode, sha, status] = raw[i].match(/^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) (\w)/) ?? [];
    if (!sha || status === 'D' || mode === '160000' || seen.has(`${sha} ${raw[i + 1]}`)) continue;
    seen.add(`${sha} ${raw[i + 1]}`);
    objects.push([sha, raw[i + 1]]);
  }
  const commits = git(['rev-list', range]).split('\n').filter(Boolean);
  const kinds = objects.length ? git(['cat-file', '--batch-check'], `${objects.map(([sha]) => sha).join('\n')}\n`).toString('utf8').trim().split('\n') : [];
  const forbidden = privateForbidden(owner);
  const out = { commits: commits.length, blobs: 0, images: [], identities: new Set(), secretShapes: [], keyFormats: [], emails: new Map(), homes: new Map(), cleanRoom: [] };
  const note = (map, key, where) => map.set(key, [...(map.get(key) ?? []), where]);
  const scanText = (text, where) => {
    text.split(/\r?\n/).forEach((line, i) => {
      const at = `${where}:${i + 1}`;
      // A long line (minified code, generated JSON) is read in overlapping pieces, so the
      // checks stay fast and a value across a piece boundary is still whole in one of them.
      const found = { shapes: new Set(), keys: new Set(), emails: new Set(), homes: new Set() };
      for (let k = 0; k === 0 || k < line.length; k += LINE_PIECE - LINE_OVERLAP) {
        const piece = line.slice(k, k + LINE_PIECE);
        for (const kind of Object.keys(secretShapes(piece))) found.shapes.add(kind);
        for (const [name, re] of KEY_FORMATS) for (const m of piece.matchAll(re)) found.keys.add(`${name} ${m[0].slice(0, 10)}...`);
        for (const [e] of piece.matchAll(EMAIL)) if (!placeholderEmail(e)) found.emails.add(e);
        for (const m of piece.matchAll(HOME_PATH)) found.homes.add(m[1]);
      }
      if (found.shapes.size) out.secretShapes.push(`${at} ${[...found.shapes].join(', ')}`);
      for (const k of found.keys) out.keyFormats.push(`${at} ${k}`);
      for (const e of found.emails) note(out.emails, e, at);
      for (const u of found.homes) note(out.homes, u, at);
    });
    for (const { line, kind } of findForbidden(stripOwnAddress(text, owner.handle), forbidden)) out.cleanRoom.push(`${where}:${line} ${kind}`);
  };
  const scanned = new Set();
  kinds.forEach((row, i) => {
    const [sha, type] = row.split(' ');
    const path = objects[i][1];
    if (path) for (const { kind } of findForbidden(stripOwnAddress(path, owner.handle), forbidden)) out.cleanRoom.push(`path ${path} ${kind}`);
    if (type !== 'blob') return;
    out.blobs += 1;
    if (IMAGE.test(path ?? '')) return void out.images.push(path);
    // The same content under a second path needs its path checked (above), not a second read.
    if (scanned.has(sha)) return;
    scanned.add(sha);
    const buf = git(['cat-file', 'blob', sha], '');
    if (buf.includes(0)) return void out.images.push(`${path} (binary)`);
    scanText(buf.toString('utf8'), `${path}@${sha.slice(0, 7)}`);
  });
  for (const c of commits) {
    const [an, ae, cn, ce] = git(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', c]).trim().split('\0');
    out.identities.add(`author ${an} <${ae}>, committer ${cn} <${ce}>`);
    scanText(git(['show', '-s', '--format=%B', c]).replace(/^Co-authored-by: .*$/gim, ''), `message ${c.slice(0, 7)}`);
  }
  out.images = [...new Set(out.images)].sort();
  out.identities = [...out.identities];
  return out;
}

/** The last release tag reachable from HEAD, or null. */
function lastTag(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'describe', '--tags', '--abbrev=0', '--match', 'v*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const USAGE = 'usage: node tools/release-check.mjs [--since <ref>] [--no-smoke]\n';

export async function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let since = null;
  let runSmoke = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since' && argv[i + 1]) since = argv[++i];
    else if (argv[i] === '--no-smoke') runSmoke = false;
    else return io.err(USAGE), 2;
  }
  since ??= lastTag(ROOT);
  if (!since) return io.err(`No release tag found, so pass --since <ref>.\n${USAGE}`), 2;
  let ok = true;
  const line = (s = '') => io.out(`${s}\n`);
  const list = (title, items, max = 40) => {
    line(`${title}: ${items.length}`);
    for (const s of items.slice(0, max)) line(`  ${s}`);
    if (items.length > max) line(`  ...and ${items.length - max} more`);
  };

  line('1. The package');
  const pack = packList();
  line(`  ${pack.files} files, ${(pack.size / 1e6).toFixed(2)} MB packed, ${(pack.unpackedSize / 1e6).toFixed(2)} MB unpacked`);
  if (pack.unexpected.length) ok = false;
  list(pack.unexpected.length ? '  FAIL, files a release shouldn\'t ship' : '  pass, files a release shouldn\'t ship', pack.unexpected);

  line('2. It runs, installed from the packed tarball');
  if (runSmoke) {
    const result = await smokePacked();
    for (const [step, value] of Object.entries(result)) {
      if (value !== true) ok = false;
      line(`  ${value === true ? 'pass' : 'FAIL'} ${step}${value === true ? '' : `: ${value}`}`);
    }
  } else line('  skipped (--no-smoke)');

  line(`3. Since ${since}: for a person to judge`);
  const s = scanSince({ since });
  line(`  ${s.commits} commit${s.commits === 1 ? '' : 's'}, ${s.blobs} file version${s.blobs === 1 ? '' : 's'}`);
  list('  Authors and committers', s.identities);
  list('  Secret shapes (honestweek\'s own check)', s.secretShapes);
  list('  Key formats', s.keyFormats);
  list('  Email addresses other than placeholders', [...s.emails].map(([e, at]) => `${e} (${at.length}, first at ${at[0]})`));
  list('  Home-folder user names', [...s.homes].map(([u, at]) => `${u} (${at.length}, first at ${at[0]})`));
  list('  Clean-room fence', s.cleanRoom);
  list('  Images to look at', s.images);

  line(ok ? 'Steps 1 and 2 pass. Read step 3 before releasing.' : 'Step 1 or 2 failed: fix it before releasing.');
  return ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`release-check: ${err.message}\n`);
    process.exit(1);
  });
}
