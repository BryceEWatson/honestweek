// The engine hooks the review brief reads, and proof that adding them changed no output: the
// branch Claude Code records on each line is kept on its steps in memory only, the history
// names each repository's checkouts in memory only, and the find, replay and problems answers
// on the demo week are byte-for-byte what they were before the hooks existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { REVIEW_PATTERNS, PATTERN_CHECKS } from '../lib/problems/index.mjs';
import { buildCorpus } from './fixtures/replay/corpus.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';
import { withoutUserConfig } from './helpers/no-user-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'honestweek.mjs');
const fx = buildCorpus();
const build = (extra = {}) => buildWorkHistory({ config: fx.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, ...extra });
const fwd = (p) => realpathSync(p).replace(/\\/g, '/').toLowerCase();

test('each Claude Code step keeps its line\'s branch, hidden, and no output carries it', async () => {
  const h = await build({ keepRaw: true });
  const branched = h.events.filter((e) => e._lineBranch);
  assert.ok(branched.length > 10, 'steps carry the recorded branch');
  assert.ok(branched.every((e) => typeof e._lineBranch === 'string'));
  assert.ok(branched.some((e) => e._lineBranch === 'feature/widget'));
  assert.ok(branched.some((e) => e.kind === 'prompt') && branched.some((e) => e.kind === 'action') && branched.some((e) => e.kind === 'message'), 'prompts, actions and messages all carry it');
  // Not enumerable: never in JSON, a spread copy or Object.keys.
  for (const e of branched.slice(0, 20)) {
    assert.ok(!Object.keys(e).includes('_lineBranch'));
    assert.equal({ ...e }._lineBranch, undefined);
  }
  const json = JSON.stringify(h);
  assert.doesNotMatch(json, /_lineBranch/);
  // A private session keeps none.
  const priv = new Set(h.sessions.filter((s) => s.private).map((s) => s.key));
  assert.ok(priv.size > 0, 'the corpus has a private session (the test can fail)');
  assert.ok(!h.events.some((e) => priv.has(e.session) && e._lineBranch));
});

test('a saved session carries no branch field', async () => {
  const h = await build({ saving: true });
  const key = h.sessions.find((s) => !s.private && h.events.some((e) => e.session === s.key && e._lineBranch))?.key;
  assert.ok(key, 'a readable session with a branch (the test can fail)');
  const saved = h.exportSession(key);
  assert.ok(saved, 'the session exports');
  assert.doesNotMatch(JSON.stringify(saved), /_lineBranch/);
});

test('the history names a repository\'s checkouts, hidden, and nothing for a display-only one', async () => {
  const h = await build();
  assert.ok(!Object.keys(h).includes('_repoRoots'));
  const roots = h._repoRoots('your-project');
  assert.ok(Array.isArray(roots) && roots.length >= 1);
  assert.ok(roots.includes(fwd(fx.repoDir ?? fx.config.repos.find((r) => r.label === 'your-project').resolvedPath)) || roots.some((r) => r.endsWith('/your-project')));
  const display = fx.config.repos.find((r) => r.role === 'display');
  assert.ok(display, 'the corpus has a display-only repository (the test can fail)');
  assert.equal(h._repoRoots(display.label), null);
  assert.equal(h._repoRoots('no-such-repo'), null);
  // A copy of the list: changing it doesn't change the history's.
  roots.push('/elsewhere');
  assert.ok(!h._repoRoots('your-project').includes('/elsewhere'));
});

test('REVIEW_PATTERNS names only patterns the catalog has', () => {
  assert.deepEqual([...REVIEW_PATTERNS], ['unverified-done-claim', 'claim-contradicts-evidence', 'test-tampering', 'bypassing-safeguards', 'destructive-command', 'instruction-violation', 'edits-outside-folder', 'scope-creep']);
  for (const p of REVIEW_PATTERNS) assert.ok(p in PATTERN_CHECKS, p);
  assert.ok(Object.isFrozen(REVIEW_PATTERNS));
});

test('find, replay and problems answer byte-for-byte as before the hooks', () => {
  // sha256 of each answer on the demo week, text and --json, as main answered them before
  // piece 2 of the review brief (issue 217), with this run's form put back to `honestweek`.
  const PINNED = {
    'find #12': '22a5b1de8dc50c25', 'find #12 --json': '33ddc9999430b119',
    'find #14': 'fb73ec20a63afee7', 'find #14 --json': '050caed3f4faed8a',
    'find branch:main': 'd52084d24f74e406', 'find branch:main --json': 'bdb174b7c83e0795',
    'replay cc-dbmkomobcblb': 'd477628bb136b9d5', 'replay cc-dbmkomobcblb --json': '9a2f03a33d78b889',
    'problems': '51b1113b060aa6b7', 'problems --json': 'ed3f715b5c2024e2',
    'problems --session cc-dbmkomobcblb': '4ce405dd60c636f7', 'problems --session cc-dbmkomobcblb --json': 'd5e429385891025a',
  };
  const outside = makeTempDir('hw-hooks-pin-');
  const slashed = BIN.replace(/\\/g, '/');
  const form = `node ${/\s/.test(slashed) ? `"${slashed}"` : slashed}`;
  const env = withoutUserConfig();
  const got = {};
  for (const q of [['find', '#12'], ['find', '#14'], ['find', 'branch:main'], ['replay', 'cc-dbmkomobcblb'], ['problems'], ['problems', '--session', 'cc-dbmkomobcblb']]) {
    for (const json of [false, true]) {
      const r = spawnSync(process.execPath, [BIN, ...q, '--demo', ...(json ? ['--json'] : [])], { cwd: outside, env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120e3 });
      assert.equal(r.status, 0, r.stderr);
      got[`${q.join(' ')}${json ? ' --json' : ''}`] = createHash('sha256').update(r.stdout.split(form).join('honestweek')).digest('hex').slice(0, 16);
    }
  }
  assert.deepEqual(got, PINNED);
});
