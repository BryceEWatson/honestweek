// tools/release-check.mjs, the readiness check docs/releasing.md runs before every release:
// the packed file list, the smoke run, and the scan of what came in since the last release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, scanSince, smoke, unexpectedFiles } from '../tools/release-check.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

test('the packed file list allows only what a release ships, and no image', () => {
  const shipped = ['package.json', 'README.md', 'LICENSE', 'SKILL.md', 'honestweek.config.example.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'bin/honestweek.mjs', 'lib/view/assets/app.js'];
  assert.deepEqual(unexpectedFiles(shipped), []);
  const stray = ['test/redact.test.mjs', 'docs/releasing.md', 'tools/release-check.mjs', '.github/workflows/ci.yml', '.claude/notes.md', 'honestweek.config.json', 'lib/view/assets/shot.png', 'honestweek-0.2.0.tgz'];
  assert.deepEqual(unexpectedFiles([...shipped, ...stray]), stray);
});

test('the scan lists what came in since the base, and leaves placeholders out', (t) => {
  const repo = makeTempDir('hw-release-scan-');
  t.after(() => removeTempDir(repo));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=You', '-c', 'user.email=you@example.com', ...args], { encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), 'A made-up project.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  const base = git('rev-parse', 'HEAD').trim();
  const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
  writeFileSync(join(repo, 'notes.txt'), [`token ${token}`, 'mail dev@company.io and you@example.com', 'path /home/devuser/project'].join('\n'));
  writeFileSync(join(repo, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  git('add', '-A');
  git('commit', '-q', '-m', 'Add notes');

  const s = scanSince({ repo, since: base, owner: { tokens: new Set(), handle: '' } });
  assert.equal(s.commits, 1);
  assert.deepEqual(s.identities, ['author You <you@example.com>, committer You <you@example.com>']);
  assert.ok(s.keyFormats.some((k) => k.startsWith('notes.txt@') && k.includes('GitHub token')), 'the key format is found');
  assert.ok(s.secretShapes.some((k) => k.startsWith('notes.txt@')), "honestweek's own secret-shape check finds it too");
  assert.deepEqual([...s.emails.keys()], ['dev@company.io'], 'a placeholder address is left out');
  assert.deepEqual([...s.homes.keys()], ['devuser']);
  assert.deepEqual(s.images, ['shot.png']);
  // Nothing added since the newest commit: an empty range scans nothing.
  const none = scanSince({ repo, since: 'HEAD', owner: { tokens: new Set(), handle: '' } });
  assert.equal(none.commits + none.blobs + none.keyFormats.length, 0);
});

test('the smoke run starts the help, the demo and Setup with no real home or logs', async () => {
  const result = await smoke(join(ROOT, 'bin', 'honestweek.mjs'));
  assert.deepEqual(result, { help: true, demo: true, setup: true });
});

test('a bin that fails says which step failed instead of passing', async (t) => {
  const dir = makeTempDir('hw-release-bad-');
  t.after(() => removeTempDir(dir));
  const bad = join(dir, 'bad.mjs');
  writeFileSync(bad, "console.error('broken'); process.exit(3);\n");
  const result = await smoke(bad);
  assert.match(String(result.help), /^exit 3/);
  assert.match(String(result.demo), /exited with 3 before serving/);
  assert.match(String(result.setup), /exited with 3 before serving/);
});
