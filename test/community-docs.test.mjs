// Guards the files a newcomer and the release rely on: the code of conduct, the changelog,
// the release checklist, and the two GitHub workflows. They keep the published voice, link
// only to files that exist, hold no personal data, and the release workflow can't publish
// without the checks that keep a GitHub release from going out half-done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './helpers/temp-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const PKG = JSON.parse(read('package.json'));

const DOCS = ['CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'docs/releasing.md'];

test('community docs: no dashes, no personal data, and every relative link resolves', () => {
  for (const f of DOCS) {
    const text = read(f);
    assert.doesNotMatch(text, /[—–]| -- /, `${f} uses an em or en dash`);
    assert.doesNotMatch(text, /@(?:gmail|outlook|yahoo|proton|icloud|hotmail)\.com/i, `${f} holds a personal email`);
    assert.doesNotMatch(text, /\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\/|[A-Z]:\\Users\\[A-Za-z]+\\/, `${f} holds a personal path`);
    for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)) {
      const linked = resolve(ROOT, dirname(f), target);
      assert.doesNotThrow(() => readFileSync(linked), `${f} links to ${target}, which doesn't exist`);
    }
  }
});

test('the code of conduct names its source, gives a private route, and lists no email', () => {
  const coc = read('CODE_OF_CONDUCT.md');
  assert.match(coc, /Contributor Covenant/);
  assert.match(coc, /contributor-covenant\.org\/version\/2\/1\/code_of_conduct/);
  assert.match(coc, /\]\(SECURITY\.md\)/, 'security problems are sent to the security policy');
  assert.match(coc, /privately/i);
  assert.doesNotMatch(coc, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'no email address in the code of conduct');
  assert.match(read('CONTRIBUTING.md'), /\]\(CODE_OF_CONDUCT\.md\)/, 'CONTRIBUTING links the code of conduct');
});

test('the changelog has a section for the version in package.json', () => {
  const log = read('CHANGELOG.md');
  const escaped = PKG.version.replace(/\./g, '\\.');
  assert.match(log, new RegExp(`^## ${escaped} \\(`, 'm'), `CHANGELOG.md has no "## ${PKG.version} (" section`);
});

test('the release checklist covers login, the dry run, the publish, the check and the tag, in that order', () => {
  const doc = read('docs/releasing.md');
  let last = -1;
  for (const step of ['npm login', 'npm publish --dry-run', '\nnpm publish\n', 'npx honestweek@', 'git tag -a v', 'gh release create']) {
    const i = doc.indexOf(step, last + 1);
    assert.ok(i > last, `releasing.md has "${step.trim()}" after the step before it`);
    last = i;
  }
  assert.match(doc, /## In plain terms/);
  assert.match(doc, /CHANGELOG\.md/);
});

test('the release workflow publishes only after its checks pass', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /TAG" != "v\$version"/, 'the release tag must match package.json');
  assert.match(wf, /npm view "honestweek@\$version"/, 'a version already on npm is not published again');
  assert.match(wf, /HAS_NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN != '' \}\}/, 'a missing token stops the run with a notice');
  assert.match(wf, /PRERELEASE: \$\{\{ github\.event\.release\.prerelease \}\}/, 'a prerelease is never published');
  const publish = wf.slice(wf.indexOf('- name: Publish to npm'));
  assert.match(publish, /if: steps\.decide\.outputs\.publish == 'true'/, 'the publish step is gated on the checks');
});

/** The shell script of the release workflow's decide step, unindented. */
function decideScript() {
  const lines = read('.github/workflows/release.yml').split(/\r?\n/);
  const step = lines.findIndex((l) => l.includes('id: decide'));
  const start = lines.findIndex((l, i) => i > step && /^\s+run: \|\s*$/.test(l)) + 1;
  const indent = lines[start].match(/^\s*/)[0];
  const body = [];
  for (let i = start; i < lines.length && (lines[i].startsWith(indent) || lines[i].trim() === ''); i++) body.push(lines[i].slice(indent.length));
  return body.join('\n');
}

// The decide step run for real, with a stand-in `npm` that answers the version lookup.
// Skipped on Windows, where `bash` may not be Git Bash; the workflow itself runs on Linux.
test('the release workflow decides to publish only a full release, with a token, that npm lacks', { skip: process.platform === 'win32' }, () => {
  const script = decideScript();
  const run = ({ version = '0.2.0', tag = 'v0.2.0', prerelease = 'false', token = 'true', npm = 'missing' }) => {
    const dir = makeTempDir('hw-release-decide-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'honestweek', version }));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const answers = {
      found: `echo "${version}"`,
      missing: 'echo "npm error code E404" >&2; exit 1',
      offline: 'echo "npm error code ETIMEDOUT" >&2; exit 1',
    };
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\n${answers[npm]}\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const output = join(dir, 'out');
    writeFileSync(output, '');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAG: tag, PRERELEASE: prerelease, HAS_NPM_TOKEN: token, GITHUB_OUTPUT: output };
    const r = spawnSync('bash', ['-c', script], { cwd: dir, env, encoding: 'utf8' });
    return { status: r.status, publish: (readFileSync(output, 'utf8').match(/publish=(\w+)/) || [])[1] ?? null };
  };
  assert.deepEqual(run({}), { status: 0, publish: 'true' }, 'a full release npm lacks, with a token');
  assert.deepEqual(run({ npm: 'found' }), { status: 0, publish: 'false' }, 'already on npm');
  assert.deepEqual(run({ token: 'false' }), { status: 0, publish: 'false' }, 'no token');
  assert.deepEqual(run({ prerelease: 'true' }), { status: 0, publish: 'false' }, 'marked a prerelease on GitHub');
  assert.deepEqual(run({ version: '0.3.0-rc.1', tag: 'v0.3.0-rc.1' }), { status: 0, publish: 'false' }, 'a prerelease version number');
  assert.equal(run({ tag: 'v0.2.1' }).status, 1, 'a tag that does not match package.json fails the run');
  assert.deepEqual(run({ npm: 'offline' }), { status: 1, publish: null }, 'a failed npm lookup with a token fails the run without deciding');
  assert.deepEqual(run({ npm: 'offline', token: 'false' }), { status: 0, publish: 'false' }, 'with no token a failed lookup changes nothing');
});

test('CI runs on Linux, Windows and macOS and installs nothing', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) assert.ok(ci.includes(os), `CI runs on ${os}`);
  assert.match(ci, /node-version: \['18', '20', '22'\]/);
  for (const wf of [ci, read('.github/workflows/release.yml')]) {
    assert.doesNotMatch(wf, /npm (install|ci)\b|npm i\b/, 'a workflow installs packages');
  }
});

test('every action a workflow uses is pinned to a full commit id', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const uses = read(`.github/workflows/${name}`).split(/\r?\n/).filter((l) => /^\s*-?\s*uses:/.test(l));
    assert.ok(uses.length > 0, `${name} uses actions`);
    for (const line of uses) assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/, `${name}: ${line.trim()}`);
  }
});

test('a newer commit cancels a pull request\'s CI run, and a push to main is never cancelled', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(ci, /group: .*github\.event\.pull_request\.number.*github\.run_id/, 'pushes each get their own group, so none waits behind or replaces another');
});
