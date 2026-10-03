// Pins what `npm publish` ships. The package is the tool and nothing else: the CLI, its
// library, the skill, the example config and the plugin manifests. Tests, fixtures, docs,
// tools and the repository's own planning files never ship, and nothing that git doesn't
// track can slip into the tarball from a local checkout.
//
// The file list comes from `npm pack --dry-run`, which is exactly what `npm publish` would
// upload. `prepublishOnly` runs this suite, so a publish with a wrong file list stops here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// The `files` allowlist in package.json, exactly.
const FILES_ALLOWLIST = ['bin/', 'lib/', 'SKILL.md', 'honestweek.config.example.json', '.claude-plugin/'];
// Every top-level file that ships. npm adds package.json, README.md and LICENSE on its own.
const SHIPPED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'SKILL.md',
  'honestweek.config.example.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];
// Folders that ship whole: every file git tracks in them goes into the package.
const SHIPPED_DIRS = ['bin/', 'lib/'];
// A generous ceiling that still catches a stray log or fixture landing in lib/.
const MAX_UNPACKED_BYTES = 5 * 1024 * 1024;

/** How to run npm: through the npm that came with this Node when it can be found, so no shell is needed. */
function npmInvocation() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((p) => typeof p === 'string' && /npm-cli\.js$/.test(p) && existsSync(p));
  if (cli) return { cmd: process.execPath, args: [cli], shell: false };
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
}

/** `npm pack --dry-run --json` for the repository root, or null when npm isn't installed here. */
function packDryRun() {
  const npm = npmInvocation();
  try {
    const out = execFileSync(npm.cmd, [...npm.args, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: npm.shell,
      maxBuffer: 1 << 26,
    });
    return JSON.parse(out)[0];
  } catch (err) {
    if (err.code === 'ENOENT' && process.env.CI !== 'true') return null;
    throw err;
  }
}

const gitTracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0')
    .filter(Boolean);

test('package.json ships through a files allowlist, with no dependencies of any kind', () => {
  assert.deepEqual(PKG.files, FILES_ALLOWLIST);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const value = PKG[field];
    assert.ok(value === undefined || Object.keys(value).length === 0, `package.json declares ${field}; honestweek has zero dependencies`);
  }
  assert.equal(PKG.engines?.node, '>=18');
});

test('package.json runs the test suite before every publish', () => {
  assert.equal(PKG.scripts?.prepublishOnly, 'node --test');
  assert.equal(PKG.scripts?.test, 'node --test');
});

test('the bin entry is a shipped file that starts with a node shebang', () => {
  assert.deepEqual(PKG.bin, { honestweek: 'bin/honestweek.mjs' });
  const bin = readFileSync(join(ROOT, PKG.bin.honestweek), 'utf8');
  assert.match(bin, /^#!\/usr\/bin\/env node\r?\n/);
});

test('npm pack ships exactly the CLI, its library, the skill, the example config and the manifests', (t) => {
  const pack = packDryRun();
  if (!pack) {
    t.skip('npm is not installed next to this Node, so the packed file list cannot be read');
    return;
  }
  const packed = pack.files.map((f) => f.path.replace(/\\/g, '/'));
  const packedSet = new Set(packed);

  // Nothing ships that isn't a listed top-level file or inside a shipped folder.
  const unexpected = packed.filter((p) => !SHIPPED_FILES.includes(p) && !SHIPPED_DIRS.some((d) => p.startsWith(d)));
  assert.deepEqual(unexpected, [], 'files outside the intended set would ship');

  // Every listed top-level file is there.
  assert.deepEqual(SHIPPED_FILES.filter((f) => !packedSet.has(f)), [], 'an intended top-level file is missing from the package');

  // Every file git tracks under bin/ and lib/ ships (the view page's assets included), and
  // nothing ships from those folders that git doesn't track (a local scratch file, a log).
  const tracked = gitTracked().filter((p) => SHIPPED_DIRS.some((d) => p.startsWith(d)));
  assert.ok(tracked.length > 0, 'git lists the files under bin/ and lib/');
  assert.deepEqual(tracked.filter((p) => !packedSet.has(p)), [], 'a tracked file under bin/ or lib/ is missing from the package');
  const trackedSet = new Set(tracked);
  assert.deepEqual(
    packed.filter((p) => SHIPPED_DIRS.some((d) => p.startsWith(d)) && !trackedSet.has(p)),
    [],
    'a file git does not track would ship; remove it or commit it before publishing'
  );

  assert.ok(pack.unpackedSize < MAX_UNPACKED_BYTES, `the package unpacks to ${pack.unpackedSize} bytes, over the ${MAX_UNPACKED_BYTES}-byte ceiling`);
});

test('the shipped-file rule catches what must never ship', () => {
  // The same predicate as above, run on paths that must be rejected, so the check can fail.
  const ships = (p) => SHIPPED_FILES.includes(p) || SHIPPED_DIRS.some((d) => p.startsWith(d));
  for (const p of ['test/redact.test.mjs', 'test/fixtures/replay/corpus.mjs', 'tools/demo-week.mjs', 'docs/mining.md', '.claude/work/notes.md', '.github/workflows/ci.yml', 'honestweek.config.json', 'honestweek.draft.json', 'CHANGELOG.md']) {
    assert.equal(ships(p), false, `${p} must not ship`);
  }
  for (const p of ['bin/honestweek.mjs', 'lib/redact.mjs', 'lib/view/assets/search.html', 'lib/readers/default.json', 'SKILL.md']) {
    assert.equal(ships(p), true, `${p} must ship`);
  }
});
