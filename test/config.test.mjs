import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

import {
  loadConfig,
  normalizeConfig,
  isEmailShaped,
  resolveRepoPath,
  hostTimezone,
  ROLES,
  OUTPUT_MODES,
  DEFAULT_OUTPUT_FILES,
} from '../lib/config.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'honestweek-cfg-'));
}

function writeConfig(dir, obj) {
  const p = join(dir, 'honestweek.config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const minimalValid = () => ({
  identity: { authorEmails: ['dev@example.com'] },
  repos: [{ path: '/abs/repo', label: 'r', role: 'featured' }],
});

const fullValid = () => ({
  identity: { authorEmails: ['dev@example.com', 'other@example.org'] },
  week: { startsOn: 'monday', timezone: 'America/New_York' },
  repos: [
    { path: '/abs/featured', label: 'feat', role: 'featured' },
    { path: '/abs/reference', label: 'ref', role: 'reference' },
    { path: '/abs/display', label: 'disp', role: 'display' },
  ],
  redaction: { codenames: ['Foo'], names: ['Jane'], terms: ['secretword'] },
  output: { mode: 'changelog', file: 'OUT.md' },
});

test('minimal valid config loads', () => {
  const dir = tempDir();
  try {
    const cfg = loadConfig(writeConfig(dir, minimalValid()));
    assert.deepEqual(cfg.identity.authorEmails, ['dev@example.com']);
    assert.equal(cfg.repos.length, 1);
    assert.equal(cfg.repos[0].role, 'featured');
    // defaults filled
    assert.equal(cfg.week.startsOn, 'monday');
    assert.ok(cfg.week.timezone.length > 0);
    assert.deepEqual(cfg.redaction, { codenames: [], names: [], terms: [] });
    assert.equal(cfg.output.mode, 'digest');
    assert.equal(cfg.output.file, DEFAULT_OUTPUT_FILES.digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full valid config loads and exercises all roles', () => {
  const dir = tempDir();
  try {
    const cfg = loadConfig(writeConfig(dir, fullValid()));
    assert.deepEqual(cfg.repos.map((r) => r.role), ['featured', 'reference', 'display']);
    assert.equal(cfg.week.timezone, 'America/New_York');
    assert.deepEqual(cfg.redaction.codenames, ['Foo']);
    assert.equal(cfg.output.mode, 'changelog');
    assert.equal(cfg.output.file, 'OUT.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped example config loads cleanly', () => {
  const examplePath = resolve(HERE, '..', 'honestweek.config.example.json');
  const cfg = loadConfig(examplePath);
  assert.ok(cfg.identity.authorEmails.length >= 1);
  assert.ok(cfg.repos.length >= 1);
  // clean-room: example ships with EMPTY term-lists
  assert.deepEqual(cfg.redaction, { codenames: [], names: [], terms: [] });
});

// --- rejection cases -------------------------------------------------------

const rejects = [
  ['missing identity', { repos: minimalValid().repos }, /identity/],
  ['empty authorEmails', { identity: { authorEmails: [] }, repos: minimalValid().repos }, /authorEmails/],
  ['non-string authorEmail', { identity: { authorEmails: [42] }, repos: minimalValid().repos }, /authorEmails\[0\]/],
  ['non-email authorEmail', { identity: { authorEmails: ['nope'] }, repos: minimalValid().repos }, /authorEmails\[0\]/],
  ['missing repos', { identity: minimalValid().identity }, /repos/],
  ['empty repos', { identity: minimalValid().identity, repos: [] }, /repos/],
  [
    'repo missing path',
    { identity: minimalValid().identity, repos: [{ label: 'x', role: 'featured' }] },
    /repos\[0\]\.path/,
  ],
  [
    'repo missing label',
    { identity: minimalValid().identity, repos: [{ path: '/p', role: 'featured' }] },
    /repos\[0\]\.label/,
  ],
  [
    'bad role',
    { identity: minimalValid().identity, repos: [{ path: '/p', label: 'x', role: 'public' }] },
    /repos\[0\]\.role/,
  ],
  [
    'unknown output mode',
    { ...minimalValid(), output: { mode: 'tweet' } },
    /output\.mode/,
  ],
  [
    'non-monday startsOn',
    { ...minimalValid(), week: { startsOn: 'sunday' } },
    /week\.startsOn/,
  ],
];

for (const [name, cfg, pattern] of rejects) {
  test(`rejects: ${name}`, () => {
    const dir = tempDir();
    try {
      assert.throws(() => loadConfig(writeConfig(dir, cfg)), pattern);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('missing file produces a clear error naming the path', () => {
  const p = join(tempDir(), 'does-not-exist.json');
  assert.throws(() => loadConfig(p), new RegExp(`not found.*${p.replace(/\\/g, '\\\\')}`));
});

test('malformed JSON produces a clear parse error naming the file', () => {
  const dir = tempDir();
  try {
    const p = join(dir, 'honestweek.config.json');
    writeFileSync(p, '{ not json ');
    assert.throws(() => loadConfig(p), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- path resolution -------------------------------------------------------

test('~ expands to home dir', () => {
  const cfg = normalizeConfig(
    { ...minimalValid(), repos: [{ path: '~/code/x', label: 'x', role: 'featured' }] },
    { configDir: '/some/dir' }
  );
  assert.equal(cfg.repos[0].resolvedPath, resolve(homedir(), 'code/x'));
  assert.equal(cfg.repos[0].path, '~/code/x'); // original retained
});

test('bare ~ expands to home dir', () => {
  const cfg = normalizeConfig(
    { ...minimalValid(), repos: [{ path: '~', label: 'x', role: 'featured' }] },
    { configDir: '/some/dir' }
  );
  assert.equal(cfg.repos[0].resolvedPath, homedir());
});

test('relative path resolves against config dir', () => {
  const configDir = isAbsolute('/work/proj') ? '/work/proj' : resolve('/work/proj');
  const cfg = normalizeConfig(
    { ...minimalValid(), repos: [{ path: '../sibling', label: 'x', role: 'featured' }] },
    { configDir }
  );
  assert.equal(cfg.repos[0].resolvedPath, resolve(configDir, '../sibling'));
});

test('absolute path passes through unchanged', () => {
  const abs = resolve('/abs/repo');
  const cfg = normalizeConfig(
    { ...minimalValid(), repos: [{ path: abs, label: 'x', role: 'featured' }] },
    { configDir: '/other' }
  );
  assert.equal(cfg.repos[0].resolvedPath, abs);
});

// --- defaults + no mutation ------------------------------------------------

test('defaulting never mutates the caller input object', () => {
  const input = minimalValid();
  const snapshot = JSON.parse(JSON.stringify(input));
  normalizeConfig(input, { configDir: '/x' });
  assert.deepEqual(input, snapshot, 'input object was mutated');
});

test('host timezone resolves to a usable IANA-ish zone', () => {
  const tz = hostTimezone();
  assert.equal(typeof tz, 'string');
  assert.ok(tz.length > 0);
  // must not throw when used as a real timezone
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }));
});

// --- pure helpers ----------------------------------------------------------

test('isEmailShaped accept/reject cases', () => {
  for (const ok of ['a@b.co', 'dev.user@example.com', 'x+y@sub.domain.org']) {
    assert.ok(isEmailShaped(ok), `${ok} should be valid`);
  }
  for (const bad of ['', 'noat', 'a@b', 'a@@b.co', '@b.co', 'a@', 'a b@c.co', 42, null, ' a@b.co']) {
    assert.equal(isEmailShaped(bad), false, `${String(bad)} should be invalid`);
  }
});

test('exported enums are exactly the documented sets', () => {
  assert.deepEqual(ROLES, ['featured', 'reference', 'display']);
  assert.deepEqual(OUTPUT_MODES, ['post', 'changelog', 'digest', 'report']);
});

test('resolveRepoPath helper handles ~, relative, absolute', () => {
  assert.equal(resolveRepoPath('~', '/d'), homedir());
  assert.equal(resolveRepoPath('~/a', '/d'), resolve(homedir(), 'a'));
  const abs = resolve('/abs');
  assert.equal(resolveRepoPath(abs, '/d'), abs);
  assert.equal(resolveRepoPath('rel', resolve('/d')), resolve('/d', 'rel'));
});
