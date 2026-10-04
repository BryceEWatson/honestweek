import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARRY_GITIGNORE } from '../lib/digest-carry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const SKILL = readFileSync(resolve(ROOT, 'SKILL.md'), 'utf8');
const BIN = readFileSync(resolve(ROOT, 'bin', 'honestweek.mjs'), 'utf8');
const GITIGNORE = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
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

test('the checked-in ignore template covers every private carry sidecar', () => {
  const lines = new Set(GITIGNORE.split(/\r?\n/));
  for (const entry of CARRY_GITIGNORE) assert.equal(lines.has(entry), true, `${entry} is ignored before runtime mutation`);
});

test('README and SKILL document all-category digest controls without weakening privacy', () => {
  for (const doc of [README, SKILL]) {
    assert.match(doc, /digest keep/);
    assert.match(doc, /hide/);
    assert.match(doc, /delete/);
    assert.match(doc, /no-text tombstone/);
    assert.match(doc, /never bypass|cannot bypass/i);
    assert.match(doc, /receipt or privacy gates/i);
  }
  assert.match(README, /cannot recall an output you've already built/i);
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
  assert.deepEqual(subs.sort(), ['build', 'digest', 'discover', 'harvest', 'history', 'init', 'mine', 'preview', 'prompts', 'validate', 'view']);
  for (const s of subs) assert.ok(README.includes(`honestweek.mjs ${s}`) || README.includes(`honestweek ${s}`), `README documents the ${s} command`);
  // there is no distil/verify/emit SUBCOMMAND — the docs must not invent one
  for (const phantom of ['distil', 'verify', 'emit']) {
    assert.ok(!new RegExp(`honestweek(?:\\.mjs)? ${phantom}\\b`).test(README), `no phantom "honestweek ${phantom}" command`);
  }
});

test('DOCS-CONSISTENCY: every subcommand has a help path, so none can fall through and run', () => {
  // The dispatcher serves help for anything not in SELF_HELP; a command in
  // neither set makes `wantsHelp(rest) && COMMAND_HELP[command]` falsy and
  // falls straight through to the handler, silently reintroducing the
  // side-effecting-help bug. Bind both sets to SUBCOMMANDS so a tenth
  // subcommand cannot be added without picking one.
  const selfHelp = [...(BIN.match(/const SELF_HELP = new Set\(\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const commandHelp = [...(BIN.match(/const COMMAND_HELP = \{([\s\S]*?)\n\};/)?.[1] ?? '').matchAll(/^ {2}([a-z]+): `/gm)].map((x) => x[1]);
  assert.ok(selfHelp.length > 0, 'bin declares a SELF_HELP set');
  assert.ok(commandHelp.length > 0, 'bin declares a COMMAND_HELP map');

  const covered = new Set([...selfHelp, ...commandHelp]);
  assert.deepEqual(
    actualSubcommands().filter((s) => !covered.has(s)),
    [],
    'every subcommand is in SELF_HELP or COMMAND_HELP'
  );
  // and neither set invents a command the dispatcher does not accept
  const subs = new Set(actualSubcommands());
  assert.deepEqual([...covered].filter((s) => !subs.has(s)), [], 'no help entry for a phantom command');
  // a command cannot be in both: SELF_HELP means the handler owns its help
  assert.deepEqual(selfHelp.filter((s) => commandHelp.includes(s)), [], 'no command is in both sets');
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

// The repo's own .claude/ folder holds local working files (hand-offs, research, test logs,
// prototypes built from real sessions). None of it may be committed, so the root ignore file
// covers the whole folder and nothing under it is tracked.
test('the local .claude/ working folder is ignored and nothing under it is tracked', () => {
  const lines = GITIGNORE.split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('/.claude/'), '.gitignore ignores the root .claude/ folder');
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '--', '.claude'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return; // not a git checkout (an unpacked tarball): the ignore rule above is all there is to check
  }
  assert.equal(tracked.trim(), '', 'no file under .claude/ is tracked');
});

test('contributor docs: no dashes, links resolve, no personal data, private reporting documented', () => {
  const files = ['CONTRIBUTING.md', 'SECURITY.md', '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md', '.github/ISSUE_TEMPLATE/config.yml'];
  for (const f of files) {
    const text = readFileSync(resolve(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /[\u2014\u2013]| -- /, `${f} uses an em or en dash`);
    assert.doesNotMatch(text, /@(?:gmail|outlook|yahoo|proton|icloud|hotmail)\.com/i, `${f} holds a personal email`);
    assert.doesNotMatch(text, /\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\/|[A-Z]:\\Users\\[A-Za-z]+\\/, `${f} holds a personal path`);
    for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)) {
      const linked = resolve(ROOT, dirname(f), target);
      assert.doesNotThrow(() => readFileSync(linked), `${f} links to ${target}, which doesn't exist`);
    }
  }
  const security = readFileSync(resolve(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(security, /Report a vulnerability/);
  assert.match(security, /Security report/, 'the fallback route stays documented');
  assert.match(README, /\]\(CONTRIBUTING\.md\)/);
  assert.match(README, /\]\(SECURITY\.md\)/);
});

test('DOCS-CONSISTENCY: the README counts the subcommands the dispatcher has', () => {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];
  const m = README.match(/The CLI surface is (\w+) subcommands/);
  assert.ok(m, 'the README states how many subcommands there are');
  assert.equal(m[1], words[actualSubcommands().length], `the README says ${m[1]}; the dispatcher has ${actualSubcommands().length}`);
});

test('a newcomer meets the first three commands before the weekly pipeline, in the order they run them', () => {
  const tryIt = README.indexOf('## Try it');
  assert.ok(tryIt > 0 && tryIt < README.indexOf('## Install') && tryIt < README.indexOf('## The flow'), 'Try it comes before Install and the weekly flow');
  const block = README.slice(tryIt, README.indexOf('```', README.indexOf('```bash', tryIt) + 7));
  const steps = ['npx honestweek view --demo', 'npx honestweek init', 'npx honestweek view '];
  let at = -1;
  for (const s of steps) {
    const i = block.indexOf(s, at + 1);
    assert.ok(i > at, `Try it runs ${s.trim()} next`);
    at = i;
  }
  // The browser page comes before the weekly pipeline, and every section is still there.
  assert.ok(README.indexOf('## Finding and replaying your work in the browser') < README.indexOf('## The flow'));
  // The usage text names the same three steps.
  for (const s of ['view --demo', '${cmd} init', '${cmd} view\n']) assert.ok(BIN.includes(s), `honestweek with no command names ${s.trim()}`);
});
