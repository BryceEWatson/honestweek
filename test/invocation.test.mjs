// The command a message names (lib/invocation.mjs): the form the person typed, so a next step
// they're told to run is one they can run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { commandForm, currentCommand, pageCommand, setCommandForm } from '../lib/invocation.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const root = resolve('/work');
const at = (...p) => join(root, ...p);
const noFile = () => {
  throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
};

test('the command npm put on the PATH prints as honestweek', () => {
  const argv1 = at('prefix', 'node_modules', 'honestweek', 'bin', 'honestweek.mjs');
  assert.equal(commandForm({ argv1, env: {}, cwd: at('project'), readFile: noFile }), 'honestweek');
  // A project dependency run through npx is `npx honestweek`.
  assert.equal(commandForm({ argv1: at('project', 'node_modules', 'honestweek', 'bin', 'honestweek.mjs'), env: { npm_command: 'exec' }, cwd: at('project'), readFile: noFile }), 'npx honestweek');
});

test('npx prints the package spec it fetched, read from its cache folder', () => {
  const cache = at('npm-cache', '_npx', 'a1b2c3');
  const argv1 = join(cache, 'node_modules', 'honestweek', 'bin', 'honestweek.mjs');
  const readWith = (spec) => (file) => {
    assert.equal(resolve(file), join(cache, 'package.json'));
    return JSON.stringify({ dependencies: { honestweek: spec } });
  };
  const env = { npm_command: 'exec' };
  assert.equal(commandForm({ argv1, env, cwd: at('project'), readFile: readWith('github:your-org/honestweek') }), 'npx github:your-org/honestweek');
  assert.equal(commandForm({ argv1, env, cwd: at('project'), readFile: readWith('your-org/honestweek') }), 'npx your-org/honestweek');
  assert.equal(commandForm({ argv1, env, cwd: at('project'), readFile: readWith('^0.1.0') }), 'npx honestweek');
  // A local tarball resolves against the cache folder, then prints relative to where I am.
  const tgz = commandForm({ argv1, env, cwd: at('npm-cache'), readFile: readWith('file:../../pkgs/honestweek-0.1.0.tgz') });
  assert.equal(tgz, 'npx ./pkgs/honestweek-0.1.0.tgz', 'with the ./ npx needs to read it as a file');
  // Failing path: an unreadable cache manifest still names npx, never a bare command.
  assert.equal(commandForm({ argv1, env, cwd: at('project'), readFile: noFile }), 'npx honestweek');
});

test('on Linux and macOS npm runs its command through a link, which is followed to the package', () => {
  // npx runs <cache>/_npx/<hash>/node_modules/.bin/honestweek, a link to the package's script,
  // and node reports the link.
  const cache = at('npm-cache', '_npx', 'a1b2c3');
  // The links as npm writes them: relative to the folder the link sits in.
  const links = new Map([
    [join(cache, 'node_modules', '.bin', 'honestweek'), '../honestweek/bin/honestweek.mjs'],
    [at('usr', 'local', 'bin', 'honestweek'), '../lib/node_modules/honestweek/bin/honestweek.mjs'],
  ]);
  const readlink = (p) => links.get(p) ?? noFile();
  const readFile = () => JSON.stringify({ dependencies: { honestweek: 'github:your-org/honestweek' } });
  const env = { npm_command: 'exec' };
  assert.equal(commandForm({ argv1: join(cache, 'node_modules', '.bin', 'honestweek'), env, cwd: at('project'), readFile, readlink }), 'npx github:your-org/honestweek');
  // A global install's command on the PATH is a link into <prefix>/lib/node_modules.
  assert.equal(commandForm({ argv1: at('usr', 'local', 'bin', 'honestweek'), env: {}, cwd: at('project'), readFile: noFile, readlink }), 'honestweek');
  // Failing path: a path that isn't a link is read as it is.
  assert.equal(commandForm({ argv1: at('clone', 'bin', 'honestweek.mjs'), env: {}, cwd: at('clone'), readlink: noFile }), 'node bin/honestweek.mjs');
});

test('a package folder npm links into its cache (npx ./folder) is named by its folder, not followed out of the cache', (t) => {
  const dir = makeTempDir('hw-npx-folder-');
  const cache = join(dir, '_npx', 'a1b2c3');
  mkdirSync(join(dir, 'pkg', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'pkg', 'bin', 'honestweek.mjs'), '');
  mkdirSync(join(cache, 'node_modules'), { recursive: true });
  writeFileSync(join(cache, 'package.json'), JSON.stringify({ dependencies: { honestweek: 'file:../../pkg' } }));
  try {
    symlinkSync(join(dir, 'pkg'), join(cache, 'node_modules', 'honestweek'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`no folder link here: ${err.code}`);
    return;
  }
  assert.equal(commandForm({ argv1: join(cache, 'node_modules', 'honestweek', 'bin', 'honestweek.mjs'), env: { npm_command: 'exec' }, cwd: dir }), 'npx ./pkg');
});

test('a real npx cache with its .bin link prints the spec npx fetched', { skip: process.platform === 'win32' && 'symlinks need extra rights on Windows' }, () => {
  const dir = makeTempDir('hw-npx-');
  try {
    const cache = join(dir, '_npx', 'a1b2c3');
    mkdirSync(join(cache, 'node_modules', 'honestweek', 'bin'), { recursive: true });
    mkdirSync(join(cache, 'node_modules', '.bin'));
    writeFileSync(join(cache, 'node_modules', 'honestweek', 'bin', 'honestweek.mjs'), '');
    writeFileSync(join(cache, 'package.json'), JSON.stringify({ dependencies: { honestweek: 'github:your-org/honestweek' } }));
    symlinkSync('../honestweek/bin/honestweek.mjs', join(cache, 'node_modules', '.bin', 'honestweek'));
    assert.equal(commandForm({ argv1: join(cache, 'node_modules', '.bin', 'honestweek'), env: { npm_command: 'exec' }, cwd: dir }), 'npx github:your-org/honestweek');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node with a script path prints that path: relative inside the folder, absolute outside it, quoted with a space', () => {
  const argv1 = at('clone', 'bin', 'honestweek.mjs');
  assert.equal(commandForm({ argv1, env: {}, cwd: at('clone') }), 'node bin/honestweek.mjs');
  const outside = commandForm({ argv1, env: {}, cwd: at('elsewhere') });
  assert.equal(outside, `node ${argv1.replace(/\\/g, '/')}`);
  assert.doesNotMatch(outside, /\\/, 'forward slashes, which every shell takes');
  const spaced = commandForm({ argv1: at('my tools', 'bin', 'honestweek.mjs'), env: {}, cwd: at('elsewhere') });
  assert.match(spaced, /^node ".+my tools\/bin\/honestweek\.mjs"$/);
  // Failing path: no script at all falls back to the plain command.
  assert.equal(commandForm({ argv1: null, env: {} }), 'honestweek');
});

test('a page shows a command that names a file by a placeholder, never the path', () => {
  assert.equal(pageCommand('honestweek'), 'honestweek');
  assert.equal(pageCommand('npx github:your-org/honestweek'), 'npx github:your-org/honestweek');
  assert.equal(pageCommand('npx your-org/honestweek'), 'npx your-org/honestweek');
  // A relative path only works from the folder honestweek was started in, and a page names
  // steps for another folder (set it up in your project folder).
  assert.equal(pageCommand('node bin/honestweek.mjs'), 'node <your honestweek folder>/bin/honestweek.mjs');
  assert.equal(pageCommand('npx ./pkgs/honestweek-0.1.0.tgz'), 'npx <your honestweek package file>');
  assert.equal(pageCommand('node C:/Users/you/code/honestweek/bin/honestweek.mjs'), 'node <your honestweek folder>/bin/honestweek.mjs');
  assert.equal(pageCommand('node "/home/you/my tools/bin/honestweek.mjs"'), 'node <your honestweek folder>/bin/honestweek.mjs');
  assert.equal(pageCommand('npx /home/you/honestweek-0.1.0.tgz'), 'npx <your honestweek package file>');
});

test('currentCommand is honestweek until the entry point records a form', () => {
  assert.equal(currentCommand(), 'honestweek');
  try {
    setCommandForm('node bin/honestweek.mjs');
    assert.equal(currentCommand(), 'node bin/honestweek.mjs');
    setCommandForm('  ');
    assert.equal(currentCommand(), 'honestweek', 'a blank form falls back');
  } finally {
    setCommandForm('honestweek');
  }
});
