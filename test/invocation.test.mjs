// The command a message names (lib/invocation.mjs): the form the person typed, so a next step
// they're told to run is one they can run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import { commandForm, currentCommand, pageCommand, setCommandForm } from '../lib/invocation.mjs';

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
  assert.equal(tgz, 'npx pkgs/honestweek-0.1.0.tgz');
  // Failing path: an unreadable cache manifest still names npx, never a bare command.
  assert.equal(commandForm({ argv1, env, cwd: at('project'), readFile: noFile }), 'npx honestweek');
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

test('a page shows a command with an absolute path by a placeholder, never the path', () => {
  assert.equal(pageCommand('honestweek'), 'honestweek');
  assert.equal(pageCommand('npx github:your-org/honestweek'), 'npx github:your-org/honestweek');
  assert.equal(pageCommand('node bin/honestweek.mjs'), 'node bin/honestweek.mjs');
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
