// The project skill at .claude/skills/honestweek makes /honestweek work in a clone of this
// repository with nothing to install. It points at the root SKILL.md, the one source of the
// instructions, and at the root's bin/honestweek.mjs; these tests keep it that way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = join(root, '.claude', 'skills', 'honestweek');
const project = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const rootSkill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const field = (text, name) => new RegExp(`^${name}: (.*)$`, 'm').exec(text)?.[1];
const DIR = '${CLAUDE_SKILL_DIR}';

test('the project skill names honestweek, starts the way the root skill does, and its description matches it', () => {
  assert.ok(project.startsWith('---\n'));
  assert.equal(field(project, 'name'), 'honestweek');
  assert.equal(field(project, 'disable-model-invocation'), field(rootSkill, 'disable-model-invocation'));
  assert.equal(field(project, 'description'), field(rootSkill, 'description'));
});

test('it points at the root SKILL.md and the root CLI, and both paths resolve from its folder', () => {
  assert.ok(project.includes(`${DIR}/../../../SKILL.md`));
  assert.ok(project.includes(`node "${DIR}/../../../bin/honestweek.mjs" init --yes`));
  assert.equal(resolve(skillDir, '../../../SKILL.md'), join(root, 'SKILL.md'));
  assert.ok(existsSync(resolve(skillDir, '../../../bin/honestweek.mjs')));
  assert.doesNotMatch(project, /—|–/, 'no em or en dashes');
});

test('it names the same flows as the root, sends Claude to flows/, and pre-approves only the root CLI', () => {
  assert.equal(field(project, 'argument-hint'), field(rootSkill, 'argument-hint'));
  assert.equal(field(project, 'allowed-tools'), `Bash(node "${DIR}/../../../bin/honestweek.mjs" *)`);
  assert.ok(project.includes(`${DIR}/../../../flows/`));
  assert.match(project, /\$ARGUMENTS/);
});

test('git tracks the project skill though the rest of .claude stays ignored', () => {
  const ignored = (p) => {
    try {
      execFileSync('git', ['-C', root, 'check-ignore', '-q', p], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ignored('.claude/skills/honestweek/SKILL.md'), false);
  assert.equal(ignored('.claude/handoffs/example.md'), true);
  assert.equal(ignored('.claude/worktrees/example'), true);
  assert.equal(ignored('.claude/skills/another-skill/SKILL.md'), true);
});

// Issue 180: Codex reads a repository's skills from .agents/skills, and doesn't fill in
// ${CLAUDE_SKILL_DIR}, so the clone's Codex copy names the root's files by relative path.
const codexDir = join(root, '.agents', 'skills', 'honestweek');
const codex = readFileSync(join(codexDir, 'SKILL.md'), 'utf8');

test('the Codex copy names honestweek, matches the root description, and points at the root files', () => {
  assert.ok(codex.startsWith('---\n'));
  assert.equal(field(codex, 'name'), 'honestweek');
  assert.equal(field(codex, 'description'), field(rootSkill, 'description'));
  assert.equal(field(codex, 'disable-model-invocation'), undefined, 'Codex reads its own switch, not this one');
  assert.ok(codex.includes('`../../../SKILL.md`'));
  assert.ok(codex.includes('`../../../flows/`'), 'it sends Codex to the flow files too (issue 182)');
  assert.ok(codex.includes('node "<repository root>/bin/honestweek.mjs" init --yes'));
  assert.equal(resolve(codexDir, '../../../SKILL.md'), join(root, 'SKILL.md'));
  assert.ok(existsSync(resolve(codexDir, '../../../bin/honestweek.mjs')));
  assert.doesNotMatch(codex, /—|–/, 'no em or en dashes');
});
