import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const SKILL = readFileSync(resolve(ROOT, 'SKILL.md'), 'utf8');
const BIN = readFileSync(resolve(ROOT, 'bin', 'honestweek.mjs'), 'utf8');
const EXAMPLE = JSON.parse(readFileSync(resolve(ROOT, 'honestweek.config.example.json'), 'utf8'));

/** The subcommands the dispatcher actually accepts. */
function actualSubcommands() {
  const m = BIN.match(/const SUBCOMMANDS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'bin declares a SUBCOMMANDS array');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('README contains all nine documentation sections', () => {
  for (const heading of [
    /^# honestweek/m,
    /^## Why/m,
    /^## Requirements/m,
    /^## Install/m,
    /^## The flow/m,
    /^## Sample output/m,
    /^## Config reference/m,
    /^## Sidecars/m,
    /^## What it does NOT do \/ privacy model/m,
  ]) {
    assert.match(README, heading);
  }
});

test('both install paths are documented with copy-pasteable commands', () => {
  assert.match(README, /git clone .*~\/\.claude\/skills\/honestweek/);
  assert.match(README, /node bin\/honestweek\.mjs/);
  assert.match(README, /npx honestweek/);
});

test('the flow is presented in the exact order with artifacts named', () => {
  const order = ['init', 'discover', '/honestweek', 'build', 'emit'];
  let last = -1;
  const flow = README.slice(README.indexOf('## The flow'));
  for (const step of order) {
    const i = flow.indexOf(step, last + 1);
    assert.ok(i > last, `flow step ${step} appears in order`);
    last = i;
  }
  for (const artifact of ['honestweek.config.json', 'honestweek.draft.json', 'honestweek.items.json', 'output.file']) {
    assert.ok(README.includes(artifact), `flow names ${artifact}`);
  }
});

test('the flow states build aborts with exit code 2 on an unresolved/non-authored commit', () => {
  assert.match(README, /exit code `2`/);
  assert.match(README, /unresolved|not authored|authorEmails/i);
});

test('the privacy-model section states all five guarantees', () => {
  const sec = README.slice(README.indexOf('## What it does NOT do'));
  assert.match(sec, /only your own allowlisted repos are read/i);
  assert.match(sec, /display.*never git-read/i);
  assert.match(sec, /local until you publish|stays local/i);
  assert.match(sec, /no telemetry|no network egress/i);
  assert.match(sec, /auto-publish|you.*are the publisher/i);
});

test('the launch invariant is its own clearly-marked subsection', () => {
  assert.match(README, /### The launch invariant/);
  const sec = README.slice(README.indexOf('### The launch invariant'));
  assert.match(sec, /receipt on every line/i);
  assert.match(sec, /under-?claim/i);
  assert.match(sec, /never asserts? a motive/i);
});

test('every config field is documented, including the three roles and their read semantics', () => {
  for (const field of ['identity.authorEmails', 'week.startsOn', 'week.timezone', 'redaction', 'output.mode', 'output.file']) {
    assert.ok(README.includes(field), `documents ${field}`);
  }
  for (const k of ['authorEmails', 'startsOn', 'timezone', 'path', 'label', 'role', 'codenames', 'names', 'terms', 'mode', 'file']) {
    assert.ok(README.includes(k), `documents config key ${k}`);
  }
  assert.match(README, /featured.*git-read.*git-verified|git-read \*\*and\*\* git-verified/i);
  assert.match(README, /reference.*not headlined/i);
  assert.match(README, /display.*NEVER git-read/i);
});

test('the sidecar section marks draft.json gitignored and items.json/output as the user\'s to keep', () => {
  const sec = README.slice(README.indexOf('## Sidecars'));
  assert.match(sec, /honestweek\.draft\.json[\s\S]*?gitignored/i);
  assert.match(sec, /honestweek\.items\.json[\s\S]*?keep or ignore|keep/i);
});

test('the sample output snippets show a status badge and a receipt on every rendered line', () => {
  const sec = README.slice(README.indexOf('## Sample output'), README.indexOf('## Config reference'));
  for (const status of ['shipped', 'designed, not proven']) assert.ok(sec.includes(status), `sample shows ${status}`);
  // each rendered bullet carries a backticked receipt pointer
  const bullets = sec.split('\n').filter((l) => l.trim().startsWith('- **'));
  assert.ok(bullets.length >= 2);
  for (const b of bullets) assert.match(b, /\(`[^`]+`\)/, `bullet carries a receipt: ${b}`);
});

test('DOCS-CONSISTENCY: documented subcommands match the dispatcher, with no phantom commands', () => {
  const subs = actualSubcommands();
  assert.deepEqual(subs.sort(), ['build', 'discover', 'harvest', 'init', 'preview', 'validate']);
  for (const s of subs) assert.ok(README.includes(`honestweek.mjs ${s}`) || README.includes(`honestweek ${s}`), `README documents the ${s} command`);
  // there is no distil/verify/emit SUBCOMMAND — the docs must not invent one
  for (const phantom of ['distil', 'verify', 'emit']) {
    assert.ok(!new RegExp(`honestweek(?:\\.mjs)? ${phantom}\\b`).test(README), `no phantom "honestweek ${phantom}" command`);
  }
});

test('DOCS-CONSISTENCY: documented config keys match honestweek.config.example.json', () => {
  for (const key of Object.keys(EXAMPLE)) assert.ok(README.includes(key), `README documents top-level key ${key}`);
  // the example itself is clean-room
  assert.deepEqual(EXAMPLE.redaction, { codenames: [], names: [], terms: [] });
});

test('README and SKILL.md describe the same flow and invariants without contradiction', () => {
  for (const doc of [README, SKILL]) {
    for (const cmd of ['init', 'discover', 'build']) assert.ok(doc.includes(cmd));
    assert.match(doc, /never auto-publish|auto-publishe?s/i);
    assert.match(doc, /exit (code )?`?2`?/i);
  }
});

test('clean-room: README contains no real personal data', () => {
  assert.doesNotMatch(README, /@(?:gmail|outlook|yahoo|proton|icloud)\.com/i);
  assert.doesNotMatch(README, /\/home\/[a-z]+\/|C:\\Users\\[A-Za-z]+\\/);
});
