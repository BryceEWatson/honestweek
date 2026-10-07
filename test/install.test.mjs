// Guards the install/distribution surface: the plugin + marketplace manifests
// are well-formed, the SKILL.md invokes the bundled CLI by a skill-anchored path
// (never a bare relative path that breaks from the user's project dir), and the
// README documents the plugin install route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const PLUGIN = JSON.parse(read('.claude-plugin/plugin.json'));
const MARKETPLACE = JSON.parse(read('.claude-plugin/marketplace.json'));
const SKILL = read('SKILL.md');
const README = read('README.md');

// Issue 180: a plugin loads its root SKILL.md only while it has no skills/ folder and no
// "skills" key, or a "skills" key that lists the root. Adding a second skill any other way would
// silently drop the weekly skill for plugin users, and CI has no Claude Code to catch it.
test('the plugin still loads its root SKILL.md', () => {
  assert.ok(existsSync(resolve(ROOT, 'SKILL.md')), 'a root SKILL.md');
  if (existsSync(resolve(ROOT, 'skills')) || PLUGIN.skills !== undefined) {
    // Each listed path, as the folder it names relative to the plugin root.
    const listed = [PLUGIN.skills ?? []].flat().map((p) => resolve(ROOT, String(p)));
    assert.ok(listed.includes(ROOT), 'a skills folder or key must also list the root ("./")');
  }
});

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

test('SKILL.md is manual-invoke only (disable-model-invocation)', () => {
  const fm = SKILL.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^disable-model-invocation:\s*true\s*$/m);
});

test('README documents the plugin-marketplace install route (in-app and terminal)', () => {
  assert.match(README, /\/plugin marketplace add BryceEWatson\/honestweek/);
  assert.match(README, /\/plugin install honestweek@honestweek/);
  assert.match(README, /claude plugin marketplace add BryceEWatson\/honestweek/);
});

test('README leads with "npx honestweek" from npm, and no longer says it is unpublished', () => {
  const first = README.indexOf('npx honestweek');
  const github = README.indexOf('npx github:BryceEWatson/honestweek');
  assert.ok(first !== -1 && first < github, 'npx honestweek comes before the npx-from-GitHub form');
  assert.match(README, /npm install -g honestweek\b/);
  assert.doesNotMatch(README, /Nothing is on npm yet|isn't on npm yet|Once it's published to npm/);
});

test('README keeps npx-from-GitHub, only as the way to run unreleased code', () => {
  const re = /npx github:BryceEWatson\/honestweek/g;
  const hits = [...README.matchAll(re)];
  assert.ok(hits.length >= 1, 'the npx-from-GitHub form is still documented');
  for (const hit of hits) {
    const around = README.slice(Math.max(0, hit.index - 200), hit.index);
    assert.match(around, /unreleased code/, 'npx-from-GitHub is introduced as running unreleased code');
  }
});

test('plugin.json metadata agrees with package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(PLUGIN.name, pkg.name);
  assert.equal(PLUGIN.version, pkg.version);
  assert.equal(PLUGIN.license, pkg.license);
});
