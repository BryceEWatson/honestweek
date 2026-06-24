// Guards the install/distribution surface: the plugin + marketplace manifests
// are well-formed, the SKILL.md invokes the bundled CLI by a skill-anchored path
// (never a bare relative path that breaks from the user's project dir), and the
// README documents the plugin install route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const PLUGIN = JSON.parse(read('.claude-plugin/plugin.json'));
const MARKETPLACE = JSON.parse(read('.claude-plugin/marketplace.json'));
const SKILL = read('SKILL.md');
const README = read('README.md');

test('plugin.json is valid and declares the single required field (name)', () => {
  assert.equal(typeof PLUGIN.name, 'string');
  assert.equal(PLUGIN.name, 'honestweek');
  // name must be a single token (becomes the skill namespace / dir name)
  assert.doesNotMatch(PLUGIN.name, /[\s/\\]/);
});

test('marketplace.json has name, owner.name, and a plugins[] entry sourced at the repo root', () => {
  assert.equal(typeof MARKETPLACE.name, 'string');
  assert.doesNotMatch(MARKETPLACE.name, /\s/, 'marketplace name is kebab-case, no spaces');
  assert.equal(typeof MARKETPLACE.owner?.name, 'string');
  assert.ok(Array.isArray(MARKETPLACE.plugins) && MARKETPLACE.plugins.length >= 1);
  const entry = MARKETPLACE.plugins.find((p) => p.name === 'honestweek');
  assert.ok(entry, 'marketplace lists the honestweek plugin');
  // same-repo plugin source must be a relative path starting with "./"
  assert.equal(typeof entry.source, 'string');
  assert.match(entry.source, /^\.\//);
});

test('SKILL.md invokes the bundled CLI by a skill-anchored absolute path, not a bare relative one', () => {
  // every CLI invocation must go through ${CLAUDE_SKILL_DIR}
  for (const cmd of ['init', 'discover', 'build']) {
    assert.match(SKILL, new RegExp(`\\$\\{CLAUDE_SKILL_DIR\\}/bin/honestweek\\.mjs" ${cmd}`), `SKILL.md anchors the ${cmd} command`);
  }
  // the install-breaking bare relative form must NOT appear in the skill
  assert.doesNotMatch(SKILL, /`node bin\/honestweek\.mjs/, 'no bare relative CLI path in SKILL.md');
  assert.match(SKILL, /CLAUDE_SKILL_DIR/, 'documents the skill-dir substitution');
});

test('README documents the plugin-marketplace install route', () => {
  assert.match(README, /\/plugin marketplace add BryceEWatson\/honestweek/);
  assert.match(README, /\/plugin install honestweek@honestweek/);
});

test('README does not advertise npx as if it were installable yet', () => {
  // npx may be mentioned, but only flagged as not-yet-published
  const idx = README.indexOf('npx honestweek');
  if (idx !== -1) {
    const around = README.slice(Math.max(0, idx - 120), idx + 120);
    assert.match(around, /not yet published|planned/i, 'npx must be marked not-yet-published');
  }
});

test('plugin.json metadata agrees with package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(PLUGIN.name, pkg.name);
  assert.equal(PLUGIN.version, pkg.version);
  assert.equal(PLUGIN.license, pkg.license);
});
