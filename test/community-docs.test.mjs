// Guards the files a newcomer and the release rely on: the code of conduct, the changelog,
// the release checklist, and the two GitHub workflows. They keep the published voice, link
// only to files that exist, hold no personal data, and the release workflow can't publish
// without the checks that keep a GitHub release from going out half-done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const publish = wf.slice(wf.indexOf('- name: Publish to npm'));
  assert.match(publish, /if: steps\.decide\.outputs\.publish == 'true'/, 'the publish step is gated on the checks');
});

test('CI runs on Linux, Windows and macOS and installs nothing', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) assert.ok(ci.includes(os), `CI runs on ${os}`);
  assert.match(ci, /node-version: \['18', '20', '22'\]/);
  for (const wf of [ci, read('.github/workflows/release.yml')]) {
    assert.doesNotMatch(wf, /npm (install|ci)\b|npm i\b/, 'a workflow installs packages');
  }
});
