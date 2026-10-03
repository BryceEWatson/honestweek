import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  runInit,
  discoverRepos,
  existingDisplayRepos,
  buildConfig,
  ensureGitignore,
  inferAuthorEmail,
  defaultIo,
  findRepos,
  parseNumbers,
  parseWordList,
  NAMES_QUESTION,
  TERMS_QUESTION,
} from '../lib/init.mjs';
import { setCommandForm } from '../lib/invocation.mjs';
import { privateWordsNote } from '../lib/private-words.mjs';
import { loadConfig } from '../lib/config.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const ME = 'me@example.com';
const OTHER = 'other@example.test';

let counter = 0;
function git(dir, args, env) {
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepoWithCommit(dir, email) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', email]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev' };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'init'], env);
}

function setupTree() {
  const parent = makeTempDir('hw-init-');
  const cwd = join(parent, 'myproj');
  const sibA = join(parent, 'sibA');
  const plain = join(parent, 'plaindir');
  mkdirSync(cwd);
  mkdirSync(sibA);
  mkdirSync(plain);
  initRepoWithCommit(cwd, ME);
  initRepoWithCommit(sibA, OTHER);
  writeFileSync(join(plain, 'readme.txt'), 'not a repo');
  return { parent, cwd, sibA, plain };
}

function cleanup(dir) {
  removeTempDir(dir);
}

function fakeIo(answers = []) {
  const queue = [...answers];
  const io = {
    outBuf: '',
    errBuf: '',
    out(s) { io.outBuf += s; },
    err(s) { io.errBuf += s; },
    async prompt() { return queue.length ? queue.shift() : ''; },
  };
  return io;
}

test('discoverRepos finds parent-sibling + current git repos, not non-git dirs, no recursion', () => {
  const t = setupTree();
  try {
    const repos = discoverRepos(t.cwd, ME);
    const labels = repos.map((r) => r.label).sort();
    assert.deepEqual(labels, ['myproj', 'sibA']);
    const byLabel = Object.fromEntries(repos.map((r) => [r.label, r]));
    assert.equal(byLabel.myproj.role, 'featured', 'cwd defaults to featured');
    assert.equal(byLabel.sibA.role, 'reference', 'a repo with no commit by the author defaults to reference');
    assert.ok(!labels.includes('plaindir'), 'non-git dir is not discovered');
  } finally {
    cleanup(t.parent);
  }
});

test('discoverRepos keeps a display-only repo as display and never asks git about it', () => {
  const t = setupTree();
  try {
    const asked = [];
    const repos = discoverRepos(t.cwd, ME, { displayPaths: [t.sibA], hasCommits: (p) => (asked.push(p), true) });
    const byLabel = Object.fromEntries(repos.map((r) => [r.label, r]));
    assert.equal(byLabel.sibA.role, 'display');
    assert.ok(!asked.some((p) => p.toLowerCase() === t.sibA.toLowerCase()), 'git is never asked about a display-only repo');
    // Failing-path partner: without the display list, the same repo is asked about.
    const asked2 = [];
    discoverRepos(t.cwd, ME, { hasCommits: (p) => (asked2.push(p), false) });
    assert.ok(asked2.some((p) => p.toLowerCase() === t.sibA.toLowerCase()));
  } finally {
    cleanup(t.parent);
  }
});

test('existingDisplayRepos reads display paths from an existing config, and none from a missing or broken one', () => {
  const t = setupTree();
  try {
    assert.deepEqual(existingDisplayRepos(t.cwd), []);
    writeFileSync(join(t.cwd, 'honestweek.config.json'), JSON.stringify({ repos: [{ path: '../sibA', role: 'display' }, { path: '.', role: 'featured' }] }));
    assert.deepEqual(existingDisplayRepos(t.cwd).map((p) => p.toLowerCase()), [t.sibA.toLowerCase()]);
    writeFileSync(join(t.cwd, 'honestweek.config.json'), '{ not json');
    assert.deepEqual(existingDisplayRepos(t.cwd), []);
  } finally {
    cleanup(t.parent);
  }
});

test('--yes writes a schema-valid config, the example, and the gitignore entry', async () => {
  const t = setupTree();
  try {
    const io = fakeIo();
    const c = await runInit({ cwd: t.cwd, argv: ['--yes'], io });
    assert.equal(c, 0);
    const cfgPath = join(t.cwd, 'honestweek.config.json');
    assert.ok(existsSync(cfgPath));
    const cfg = loadConfig(cfgPath); // must validate without error
    assert.deepEqual(cfg.identity.authorEmails, [ME]);
    assert.equal(cfg.week.startsOn, 'monday');
    assert.ok(cfg.week.timezone.length > 0);
    assert.equal(cfg.output.mode, 'digest');
    assert.equal(cfg.repos.find((r) => r.label === 'myproj').role, 'featured');

    // example written, clean-room (empty term-lists, placeholder paths)
    const example = JSON.parse(readFileSync(join(t.cwd, 'honestweek.config.example.json'), 'utf8'));
    assert.deepEqual(example.redaction, { codenames: [], names: [], terms: [] });
    assert.ok(!JSON.stringify(example).includes(ME), 'example must not contain the real email');

    // .gitignore has the draft sidecar exactly once
    const gi = readFileSync(join(t.cwd, '.gitignore'), 'utf8');
    assert.equal(gi.split(/\r?\n/).filter((l) => l.trim() === 'honestweek.draft.json').length, 1);
    assert.ok(!gi.includes('honestweek.items.json'), 'init must not gitignore items.json');
  } finally {
    cleanup(t.parent);
  }
});

test('--yes is a no-op when a config exists; --force overwrites; gitignore stays idempotent', async () => {
  const t = setupTree();
  try {
    await runInit({ cwd: t.cwd, argv: ['--yes'], io: fakeIo() });
    const cfgPath = join(t.cwd, 'honestweek.config.json');
    const first = readFileSync(cfgPath, 'utf8');

    // tamper, then re-run without --force: must be left unchanged
    writeFileSync(cfgPath, first.replace('myproj', 'TAMPERED'));
    const io2 = fakeIo();
    await runInit({ cwd: t.cwd, argv: ['--yes'], io: io2 });
    assert.match(io2.outBuf, /already exists/);
    assert.match(readFileSync(cfgPath, 'utf8'), /TAMPERED/, 'no-op left the file unchanged');

    // re-run with --force: overwrites back to the inferred config
    await runInit({ cwd: t.cwd, argv: ['--yes', '--force'], io: fakeIo() });
    assert.doesNotMatch(readFileSync(cfgPath, 'utf8'), /TAMPERED/);

    // gitignore not duplicated across runs
    const gi = readFileSync(join(t.cwd, '.gitignore'), 'utf8');
    assert.equal(gi.split(/\r?\n/).filter((l) => l.trim() === 'honestweek.draft.json').length, 1);
  } finally {
    cleanup(t.parent);
  }
});

test('interactive: declining the FIRST confirmation writes nothing', async () => {
  const t = setupTree();
  try {
    // edit prompt: accept (''), first confirmation: 'n'
    const io = fakeIo(['', 'n']);
    const code = await runInit({ cwd: t.cwd, argv: [], io });
    assert.equal(code, 1);
    assert.match(io.outBuf, /Aborted/);
    assert.ok(!existsSync(join(t.cwd, 'honestweek.config.json')), 'nothing written on abort');
  } finally {
    cleanup(t.parent);
  }
});

test('interactive: declining the SECOND confirmation writes nothing', async () => {
  const t = setupTree();
  try {
    // edit: accept (''), confirm1: 'y', names and terms: skipped, confirm2: 'n'
    const io = fakeIo(['', 'y', '', '', 'n']);
    const code = await runInit({ cwd: t.cwd, argv: [], io });
    assert.equal(code, 1);
    assert.ok(!existsSync(join(t.cwd, 'honestweek.config.json')));
  } finally {
    cleanup(t.parent);
  }
});

test('interactive: pressing through both confirmations (defaults) yields a valid config', async () => {
  const t = setupTree();
  try {
    // edit: accept (''), confirm1: '' (default yes), confirm2: '' (default yes when fresh)
    const io = fakeIo(['', '', '']);
    const code = await runInit({ cwd: t.cwd, argv: [], io });
    assert.equal(code, 0);
    const cfg = loadConfig(join(t.cwd, 'honestweek.config.json'));
    assert.deepEqual(cfg.identity.authorEmails, [ME]);
  } finally {
    cleanup(t.parent);
  }
});

test('ensureGitignore creates, appends idempotently', () => {
  const dir = makeTempDir('hw-gi-');
  try {
    assert.equal(ensureGitignore(dir, 'honestweek.draft.json'), true, 'creates and adds');
    assert.equal(ensureGitignore(dir, 'honestweek.draft.json'), false, 'idempotent on second call');
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.equal(gi.split(/\r?\n/).filter((l) => l.trim() === 'honestweek.draft.json').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('buildConfig with no inferred email yields empty authorEmails (and stays clean-room)', () => {
  const cfg = buildConfig({ authorEmail: null, repos: [{ path: '/p', label: 'p', role: 'featured' }], timezone: 'UTC' });
  assert.deepEqual(cfg.identity.authorEmails, []);
  assert.deepEqual(cfg.redaction, { codenames: [], names: [], terms: [] });
  assert.equal(cfg.output.mode, 'digest');
});

test('no-email case: inferAuthorEmail returns null and runInit warns (config authorEmails empty)', async () => {
  const t = setupTree();
  // suppress global/system git identity; remove the local one too
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const emptyCfg = join(t.parent, 'empty.gitconfig');
  writeFileSync(emptyCfg, '');
  const noEmailRepo = join(t.parent, 'noemail');
  mkdirSync(noEmailRepo);
  git(noEmailRepo, ['init', '-q']);
  try {
    process.env.GIT_CONFIG_GLOBAL = emptyCfg;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    assert.equal(inferAuthorEmail(noEmailRepo), null);
    const io = fakeIo();
    await runInit({ cwd: noEmailRepo, argv: ['--yes'], io });
    assert.match(io.errBuf, /could not infer/i);
    const cfg = JSON.parse(readFileSync(join(noEmailRepo, 'honestweek.config.json'), 'utf8'));
    assert.deepEqual(cfg.identity.authorEmails, []);
  } finally {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    cleanup(t.parent);
  }
});

// ---- first run: worktrees, narrowing the list, private words, piped answers, next step ----

/** setupTree plus a linked worktree of sibA, checked out beside it. */
function setupTreeWithWorktree() {
  const t = setupTree();
  const wt = join(t.parent, 'sibA-wt');
  git(t.sibA, ['worktree', 'add', '-q', wt, '-b', 'side']);
  return { ...t, wt };
}

test('a linked worktree beside its repository folds into it, and the count says so', () => {
  const t = setupTreeWithWorktree();
  try {
    const { repos, folded } = findRepos(t.cwd, ME);
    assert.deepEqual(repos.map((r) => r.label).sort(), ['myproj', 'sibA']);
    assert.equal(folded, 1);
    assert.equal(repos.find((r) => r.label === 'sibA').path.toLowerCase(), t.sibA.toLowerCase(), 'the main working tree is the one configured');
    // Failing-path partner: two separate clones stay two entries, with nothing folded.
    const clone = join(t.parent, 'sibA-clone');
    execFileSync('git', ['clone', '-q', t.sibA, clone], { stdio: 'ignore' });
    const again = findRepos(t.cwd, ME);
    assert.deepEqual(again.repos.map((r) => r.label).sort(), ['myproj', 'sibA', 'sibA-clone']);
    assert.equal(again.folded, 1);
  } finally {
    cleanup(t.parent);
  }
});

test('a worktree folder an existing config marks display-only makes its repository display-only, and git is never asked', () => {
  const t = setupTreeWithWorktree();
  try {
    const asked = [];
    const { repos, folded } = findRepos(t.cwd, ME, { displayPaths: [t.wt], hasCommits: (p) => (asked.push(p.toLowerCase()), true) });
    assert.equal(repos.find((r) => r.label === 'sibA').role, 'display');
    // A display-only repository is matched by its own folder only, so each folder stays its
    // own display-only entry rather than one that claims the worktree's sessions.
    assert.equal(repos.find((r) => r.label === 'sibA-wt')?.role, 'display');
    assert.equal(folded, 0);
    assert.ok(!asked.includes(t.sibA.toLowerCase()) && !asked.includes(t.wt.toLowerCase()));
  } finally {
    cleanup(t.parent);
  }
});

test('init run from inside a worktree configures the main repository, first and featured', () => {
  const t = setupTreeWithWorktree();
  try {
    const { repos } = findRepos(t.wt, OTHER, { hasCommits: () => false });
    assert.equal(repos[0].path.toLowerCase(), t.sibA.toLowerCase());
    assert.equal(repos[0].role, 'featured');
  } finally {
    cleanup(t.parent);
  }
});

test('parseNumbers reads lists and ranges, and refuses anything else', () => {
  assert.deepEqual(parseNumbers('3'), [3]);
  assert.deepEqual(parseNumbers('1 3 5-7'), [1, 3, 5, 6, 7]);
  assert.deepEqual(parseNumbers('2,1, 2'), [1, 2]);
  for (const bad of ['', 'x', '0', '5-3', '1-', '-2', '1.5']) assert.equal(parseNumbers(bad), null, bad);
});

test('parseWordList trims, drops blanks and one-letter entries, and keeps one of each word', () => {
  assert.deepEqual(parseWordList(' Dana Doe, Acme ,, x, acme'), ['Dana Doe', 'Acme']);
  assert.deepEqual(parseWordList(''), []);
  // Typed the way the config writes them, the quotes and brackets aren't part of the word.
  assert.deepEqual(parseWordList('["Dana Doe", "Sam Lee"]'), ['Dana Doe', 'Sam Lee']);
  assert.deepEqual(parseWordList("'Acme'; “Zephyrcorp”"), ['Acme', 'Zephyrcorp']);
  assert.deepEqual(parseWordList("O'Neil"), ["O'Neil"], 'a quote inside a name stays');
});

test('interactive: keep and drop take lists and ranges, role takes a list, and a change that empties the list is refused', async () => {
  const t = setupTreeWithWorktree();
  try {
    const third = join(t.parent, 'third');
    mkdirSync(third);
    initRepoWithCommit(third, ME);
    const io = fakeIo(['drop 1-3', 'role 2,3 display', 'keep 1 3', 'drop 9', 'teleport 1', '', '', '', '', '']);
    const code = await runInit({ cwd: t.cwd, argv: [], io });
    assert.equal(code, 0);
    const cfg = loadConfig(join(t.cwd, 'honestweek.config.json'));
    assert.deepEqual(cfg.repos.map((r) => [r.label, r.role]), [['myproj', 'featured'], ['third', 'display']]);
    assert.match(io.errBuf, /that leaves no repositories/);
    assert.match(io.errBuf, /use numbers from 1 to 2/);
    assert.match(io.errBuf, /not a change I know/);
  } finally {
    cleanup(t.parent);
  }
});

test('interactive: the names and client words given go into the config, and the summary counts them instead of printing the file', async () => {
  const t = setupTree();
  try {
    const io = fakeIo(['', 'y', 'Dana Doe, Sam Lee', 'Acme', 'y']);
    const asked = [];
    const prompt = io.prompt;
    io.prompt = (q) => (asked.push(q), prompt(q));
    assert.equal(await runInit({ cwd: t.cwd, argv: [], io }), 0);
    assert.ok(asked.includes(NAMES_QUESTION) && asked.includes(TERMS_QUESTION), 'both private-word questions are asked');
    const cfg = JSON.parse(readFileSync(join(t.cwd, 'honestweek.config.json'), 'utf8'));
    assert.deepEqual(cfg.redaction, { codenames: [], names: ['Dana Doe', 'Sam Lee'], terms: ['Acme'] });
    assert.match(io.outBuf, /Private words: 2 names, 1 client or project word\./);
    assert.ok(io.outBuf.includes('Hiding: Dana Doe | Sam Lee\n') && io.outBuf.includes('Hiding: Acme\n'), 'each answer is read back as stored');
    assert.doesNotMatch(io.outBuf, /"curation"/, 'the whole file is not printed');
    assert.doesNotMatch(io.outBuf, /No private words are set/);
    // The config now holds those words as written, so it goes into .gitignore.
    const ignored = readFileSync(join(t.cwd, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignored.includes('honestweek.config.json'));
    assert.match(io.outBuf, /honestweek\.config\.json lists your private words, so it's now in \.gitignore\. That keeps git from picking up a new file, not one it already tracks/);
  } finally {
    cleanup(t.parent);
  }
});

test('init ends by pointing to view, in the form the person ran it, and notes when no private words are set', async () => {
  const t = setupTree();
  try {
    setCommandForm('node bin/honestweek.mjs');
    const io = fakeIo();
    await runInit({ cwd: t.cwd, argv: ['--yes'], io });
    const next = io.outBuf.slice(io.outBuf.indexOf('\nNext'));
    assert.match(next, /^\nNext, find, check and replay your sessions in your browser:\n {2}node bin\/honestweek\.mjs view\n/);
    assert.ok(next.indexOf(' view\n') < next.indexOf(' discover\n'), 'view comes before discover');
    assert.ok(io.outBuf.includes(privateWordsNote('node bin/honestweek.mjs', { restart: false })), 'the note names discover and harvest the way it was run');
    assert.doesNotMatch(io.outBuf, /\(\+honestweek\./, 'one line for the .gitignore entries, not one each');
    assert.match(io.outBuf, /wrote \.gitignore \(\d+ entries for honestweek's private files\)/);
  } finally {
    setCommandForm('honestweek');
    cleanup(t.parent);
  }
});

test('answers piped in one chunk each reach their own question', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (c) => (shown += c));
  const io = defaultIo({ input, output, errput: output });
  input.end('first\n\nthird\n');
  try {
    assert.equal(await io.prompt('One? '), 'first');
    assert.equal(await io.prompt('Two? '), '');
    assert.equal(await io.prompt('Three? '), 'third');
    // Failing path: a question after the input has ended fails as stdin-ended, not a hang.
    await assert.rejects(io.prompt('Four? '), (err) => err.code === 'HONESTWEEK_STDIN_EOF');
    assert.match(shown, /One\? \nTwo\? \nThree\? \nFour\? $/);
  } finally {
    io.close();
  }
});

test('the private-words question says what Show private text is before the person has seen the page', async () => {
  const { PRIVATE_WORDS_INTRO } = await import('../lib/init.mjs');
  assert.match(PRIVATE_WORDS_INTRO, /Show private text, a switch on view's page,/);
  assert.doesNotMatch(PRIVATE_WORDS_INTRO, /[—–]|`/, 'no dashes or code quotes in a terminal question');
});

test('folding and the display-only check see through a linked projects folder, since git writes real paths', (t0) => {
  const t = setupTreeWithWorktree();
  const link = `${t.parent}-link`;
  try {
    try {
      symlinkSync(t.parent, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t0.skip(`no folder link here: ${err.code}`);
      return;
    }
    const via = (p) => join(link, basename(p));
    const real = (p) => realpathSync.native(p).toLowerCase();
    const asked = [];
    const { repos } = findRepos(via(t.cwd), ME, { displayPaths: [via(t.sibA)], hasCommits: (p) => (asked.push(real(p)), true) });
    assert.ok(!asked.includes(real(t.sibA)), 'git is never asked about the display-only repository');
    const sibA = repos.filter((r) => r.label.startsWith('sibA'));
    assert.deepEqual(sibA.map((r) => [r.label, r.role]), [['sibA', 'display'], ['sibA-wt', 'display']], 'listed once per folder, never again as featured');
    // Failing-path partner: with nothing display-only, the worktree folds into its repository.
    const folded = findRepos(via(t.cwd), ME, { hasCommits: () => true });
    assert.equal(folded.folded, 1);
    assert.deepEqual(folded.repos.filter((r) => r.label.startsWith('sibA')).map((r) => r.label), ['sibA']);
  } finally {
    // Remove the link itself, never what it points to.
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {
        /* never made */
      }
    }
    cleanup(t.parent);
  }
});

test('init run from a worktree of a display-only repository never asks that repository for an email', async () => {
  const t = setupTreeWithWorktree();
  try {
    writeFileSync(join(t.wt, 'honestweek.config.json'), JSON.stringify({ repos: [{ path: t.sibA, label: 'sibA', role: 'display' }] }));
    const seen = [];
    const inferEmail = (cwd, opts) => (seen.push(opts), ME);
    assert.equal(await runInit({ cwd: t.wt, argv: ['--yes', '--force'], io: fakeIo(), inferEmail }), 0);
    assert.deepEqual(seen, [{ isDisplay: true }]);
    // The same repository by another of its folders: a second worktree whose config lists only
    // the first one, and a subfolder of the repository itself.
    const wt2 = join(t.parent, 'sibA-wt2');
    git(t.sibA, ['worktree', 'add', '-q', wt2, '-b', 'side2']);
    const sub = join(t.sibA, 'sub');
    mkdirSync(sub);
    for (const [cwd, listed] of [[wt2, t.wt], [sub, t.sibA]]) {
      writeFileSync(join(cwd, 'honestweek.config.json'), JSON.stringify({ repos: [{ path: listed, label: 'x', role: 'display' }] }));
      seen.length = 0;
      await runInit({ cwd, argv: ['--yes', '--force'], io: fakeIo(), inferEmail });
      assert.deepEqual(seen, [{ isDisplay: true }], cwd);
    }
    // Failing-path partner: from the repository's own, configured folder it may.
    seen.length = 0;
    await runInit({ cwd: t.cwd, argv: ['--yes', '--force'], io: fakeIo(), inferEmail });
    assert.deepEqual(seen, [{ isDisplay: false }]);
  } finally {
    cleanup(t.parent);
  }
});

test('init in a folder with no git repositories near it writes nothing and says where to run it', async () => {
  const parent = makeTempDir('hw-init-empty-');
  const lonely = join(parent, 'lonely');
  mkdirSync(lonely);
  try {
    for (const argv of [['--yes'], []]) {
      const io = fakeIo(['', 'y', '', '', 'y']);
      assert.equal(await runInit({ cwd: lonely, argv, io, inferEmail: () => ME }), 1, argv.join(' ') || 'interactive');
      assert.ok(!existsSync(join(lonely, 'honestweek.config.json')), 'no config that view would refuse');
      assert.ok(!existsSync(join(lonely, '.gitignore')));
      assert.match(io.errBuf, /Found no git repositories in this folder or the folders next to it, so nothing was written/);
      assert.match(io.errBuf, /init again from your project folder/);
    }
  } finally {
    cleanup(parent);
  }
});

test('a config with no private words is not added to .gitignore', async () => {
  const t = setupTree();
  try {
    await runInit({ cwd: t.cwd, argv: ['--yes'], io: fakeIo() });
    assert.ok(!readFileSync(join(t.cwd, '.gitignore'), 'utf8').split(/\r?\n/).includes('honestweek.config.json'));
  } finally {
    cleanup(t.parent);
  }
});
