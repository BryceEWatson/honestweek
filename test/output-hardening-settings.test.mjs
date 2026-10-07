// Settings and the config's .gitignore line, which Save always adds: a later `!`
// line that un-ignores the config is honoured (so the line is added again), and a config git
// already tracks gets a note saying .gitignore won't hide it, instead of the "adds it to
// .gitignore" one. A folder inside a display-only repository is never asked (invariant 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configTracked, createSettings, gitignoreIgnores } from '../lib/view/settings.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const CONFIG = 'honestweek.config.json';
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const norm = (s) => s.replace(/\\/g, '/').toLowerCase();

/** root/code: a repository the config reads. root/<work>: the folder holding the config. */
function setup(t, { workInRepo = false, displayParent = false } = {}) {
  const root = makeTempDir('hw-settings-ignore-');
  t.after(() => removeTempDir(root));
  const code = join(root, 'code');
  execFileSync('git', ['init', '-q', code]);
  let work = join(root, 'work');
  const repos = [{ path: code, label: 'code', role: 'featured' }];
  if (displayParent) {
    const client = join(root, 'client');
    execFileSync('git', ['init', '-q', client]);
    work = join(client, 'notes');
    mkdirSync(work);
    repos.push({ path: '..', label: 'client', role: 'display' });
  } else if (workInRepo) {
    execFileSync('git', ['init', '-q', work]);
  } else {
    mkdirSync(work);
  }
  writeFileSync(join(work, CONFIG), `${JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos,
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'out.md' },
  }, null, 2)}\n`);
  return work;
}

/** The answers Settings would send with one private word added. */
function withWord(s) {
  const i = s.info();
  assert.equal(i.editable, true, JSON.stringify(i));
  return JSON.stringify({ version: i.version, history: i.history, repos: i.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: i.authorEmails, names: i.names, terms: 'secretword', goalsFile: i.goalsFile });
}
const answer = (r) => ({ status: r.status, json: r.body });

test('gitignoreIgnores reads lines in order, so a later ! line un-ignores the config', () => {
  const dir = makeTempDir('hw-gitignore-rules-');
  try {
    const ignores = (text) => (writeFileSync(join(dir, '.gitignore'), text), gitignoreIgnores(dir, CONFIG));
    assert.equal(ignores(`${CONFIG}\n`), true);
    assert.equal(ignores(`${CONFIG}\n!${CONFIG}\n`), false, 'a later negation wins');
    assert.equal(ignores(`!${CONFIG}\n${CONFIG}\n`), true, 'a later ignore wins back');
    assert.equal(ignores('*.json\r\n!honestweek.*\r\n'), false, 'globs and CRLF');
    assert.equal(ignores(`/${CONFIG}\n`), true);
    assert.equal(ignores(`**/${CONFIG}\n`), true);
    assert.equal(ignores(`# ${CONFIG}\n`), false, 'a comment');
    assert.equal(ignores(`${CONFIG}/\n`), false, 'a folder-only pattern');
    assert.equal(ignores(`sub/${CONFIG}\n`), false, 'a deeper path');
    assert.equal(ignores('honestweek?config.json\n'), true);
    assert.equal(ignores('honestweek.config.jsonx\n'), false);
  } finally {
    removeTempDir(dir);
  }
});

test('Save adds the config to .gitignore again when a later ! line un-ignores it', async (t) => {
  const work = setup(t, { workInRepo: true });
  const gi = join(work, '.gitignore');
  writeFileSync(gi, `${CONFIG}\n!${CONFIG}\n`);
  const s = createSettings({ cwd: work });
  const r = answer(await s.save(withWord(s)));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.saved, true);
  assert.equal(readFileSync(gi, 'utf8'), `${CONFIG}\n!${CONFIG}\n${CONFIG}\n`);
  // git agrees the untracked config is now ignored.
  assert.doesNotThrow(() => git(work, ['check-ignore', '-q', CONFIG]));
});

test('Save ignores a config with no private words too, since it holds an email and folder paths', async (t) => {
  const work = setup(t, { workInRepo: true });
  const gi = join(work, '.gitignore');
  const s = createSettings({ cwd: work });
  const i = s.info();
  const noWords = JSON.stringify({ version: i.version, history: i.history, repos: i.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: [...i.authorEmails, 'two@example.com'], names: i.names, terms: i.terms, goalsFile: i.goalsFile });
  const p = answer(await s.preview(noWords));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.ok(p.json.notes.includes(`Saving also adds ${CONFIG} to .gitignore, since it holds your email, folder paths and any private words.`), JSON.stringify(p.json.notes));
  const r = answer(await s.save(noWords));
  assert.equal(r.json.saved, true, JSON.stringify(r.json));
  assert.equal(readFileSync(gi, 'utf8'), `${CONFIG}\n`);
  // A tracked config with no private words gets no warning: there are no words to leak.
  git(work, ['add', '-f', CONFIG]);
  const again = createSettings({ cwd: work });
  const j = again.info();
  const tracked = answer(await again.preview(JSON.stringify({ version: j.version, history: j.history, repos: j.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: ['you@example.com'], names: j.names, terms: j.terms, goalsFile: j.goalsFile })));
  assert.ok(!tracked.json.notes.some((n) => n.includes('tracked by git')), JSON.stringify(tracked.json.notes));
});

test('failing-path partner: a config already ignored leaves .gitignore byte for byte', async (t) => {
  const work = setup(t);
  const gi = join(work, '.gitignore');
  writeFileSync(gi, `node_modules/\n${CONFIG}\n`);
  const s = createSettings({ cwd: work });
  assert.equal(answer(await s.save(withWord(s))).status, 200);
  assert.equal(readFileSync(gi, 'utf8'), `node_modules/\n${CONFIG}\n`);
});

test('a config git tracks gets a note that .gitignore won\'t hide it, not that it\'s being ignored', async (t) => {
  const work = setup(t, { workInRepo: true });
  git(work, ['add', CONFIG]);
  assert.equal(configTracked(work), true);
  const s = createSettings({ cwd: work });
  const r = answer(await s.preview(withWord(s)));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.notes.some((n) => n.includes('tracked by git')), JSON.stringify(r.json.notes));
  assert.ok(!r.json.notes.some((n) => n.startsWith('Saving also adds')), JSON.stringify(r.json.notes));
  assert.ok(r.json.notes.every((n) => !/—|–/.test(n)), 'no em or en dashes in the note');
});

test('failing-path partner: an untracked config gets the "adds it to .gitignore" note', async (t) => {
  for (const workInRepo of [true, false]) {
    const work = setup(t, { workInRepo });
    assert.equal(configTracked(work), false, workInRepo ? 'in a repo, untracked' : 'not in a repo');
    const s = createSettings({ cwd: work });
    const r = answer(await s.preview(withWord(s)));
    assert.ok(r.json.notes.some((n) => n.startsWith('Saving also adds')), JSON.stringify(r.json.notes));
    assert.ok(!r.json.notes.some((n) => n.includes('tracked by git')));
  }
});

test('a config inside a display-only repository is never checked with git', async (t) => {
  const work = setup(t, { displayParent: true });
  const client = join(work, '..');
  git(client, ['add', join('notes', CONFIG)]);
  const cp = createRequire(import.meta.url)('node:child_process');
  const real = cp.execFileSync;
  const seen = [];
  cp.execFileSync = function (file, args, ...rest) {
    if (file === 'git') seen.push(norm((args ?? []).join(' ')));
    return real.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(configTracked(work), false);
    const s = createSettings({ cwd: work, lastCommitAt: () => null });
    const r = answer(await s.preview(withWord(s)));
    assert.equal(r.status, 200, JSON.stringify(r.json));
  } finally {
    cp.execFileSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(seen.filter((c) => c.includes('ls-files')), [], 'no ls-files run at all');
  assert.deepEqual(seen.filter((c) => c.includes(norm(work))), [], 'no git command names the folder');
});

test('the "adds it to .gitignore" note follows what Save will do, not whether the words are new', async (t) => {
  // Words already listed, and a later ! line un-ignores the config: Save adds the line, so the note says so.
  const work = setup(t);
  const gi = join(work, '.gitignore');
  const first = createSettings({ cwd: work });
  assert.equal(answer(await first.save(withWord(first))).status, 200);
  writeFileSync(gi, `${CONFIG}\n!${CONFIG}\n`);
  const s = createSettings({ cwd: work });
  const i = s.info();
  const body = JSON.stringify({ version: i.version, history: i.history, repos: i.repos.map((r) => ({ index: r.index, role: r.role })), authorEmails: i.authorEmails, names: i.names, terms: 'secretword, otherword', goalsFile: i.goalsFile });
  const r = answer(await s.preview(body));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.notes.some((n) => n.startsWith('Saving also adds')), JSON.stringify(r.json.notes));
  // New words, but a pattern already ignores the config: Save adds nothing, so there's no note.
  const other = setup(t);
  writeFileSync(join(other, '.gitignore'), '*.json\n');
  const s2 = createSettings({ cwd: other });
  const r2 = answer(await s2.preview(withWord(s2)));
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.ok(!r2.json.notes.some((n) => n.startsWith('Saving also adds')), JSON.stringify(r2.json.notes));
});
