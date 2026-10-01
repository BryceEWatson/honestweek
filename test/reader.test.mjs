import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.mjs';
import { normalizeLayer, resolveProfile, loadReaderProfile, ReaderProfileError } from '../lib/reader.mjs';

const ME = 'me@example.com';
let counter = 0;
const dirs = [];
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function commit(dir, { subject, body = '', dateISO }) {
  counter += 1;
  writeFileSync(join(dir, `f${counter}.txt`), `x${counter}`);
  const env = { ...process.env, GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], env);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
class ExitError extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }
function makeIo() {
  const io = { outBuf: '', errBuf: '', out(s) { io.outBuf += s; }, err(s) { io.errBuf += s; }, exit(code) { throw new ExitError(code); } };
  return io;
}
async function build(work) {
  const io = makeIo();
  let code;
  try { code = await runBuild({ cwd: work, io, now: new Date('2024-07-01T12:00:00Z') }); } catch (e) { if (!(e instanceof ExitError)) throw e; code = e.code; }
  return { code, io };
}
test.after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

// A client repo where two changes name the reader's own issues in their commit messages.
function fixture({ mode = 'client' } = {}) {
  const repo = tmp('hw-reader-repo-');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  const s = {
    signup: commit(repo, { subject: 'New users choose what they came for (#30)', body: 'Fixes #12, the item raised in the review.', dateISO: '2024-04-10T10:00:00Z' }),
    badge: commit(repo, { subject: 'Clear the unread badge (#31)', body: 'Part of #14.', dateISO: '2024-04-18T10:00:00Z' }),
    infra: commit(repo, { subject: 'Release in one run (#32)', dateISO: '2024-05-02T10:00:00Z' }),
  };
  const work = tmp('hw-reader-work-');
  const out = join(work, mode === 'client' ? 'report.html' : 'report.md');
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repo, label: 'app', role: 'featured' }],
    output: { mode, file: out },
    client: { name: 'Example Co', prLinks: { app: 'https://example.com/app/pull/' } },
  }));
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    period: { start: '2024-04-01', end: '2024-05-31' },
    week: { start: '2024-04-01', end: '2024-05-31' },
    content: {
      title: 'Example Co report', headline: 'The requests you raised are in.',
      themes: [{ id: 'people', title: 'For the people using it' }, { id: 'ops', title: 'Running it' }],
      next: ['Next release.'],
    },
    items: [
      { id: 'signup', repo: 'app', theme: 'people', title: 'Choose on first sign-in', summary: 'New users choose.', status: 'shipped', highlight: true, commits: [s.signup], receipt: { primaryCommit: s.signup } },
      { id: 'badge', repo: 'app', theme: 'people', title: 'Unread badge clears', summary: 'It clears.', status: 'shipped', commits: [s.badge], receipt: { primaryCommit: s.badge } },
      { id: 'infra', repo: 'app', theme: 'ops', title: 'One-run releases', summary: 'Releases run once.', status: 'shipped', commits: [s.infra], receipt: { primaryCommit: s.infra } },
    ],
  }));
  return { repo, work, out, s };
}
function profile(work, p) {
  writeFileSync(join(work, 'honestweek.reader.json'), JSON.stringify(p));
}
const REQUESTS = { id: 'requests', title: 'Your requests', select: { issues: [12, 14, 99] }, source: { kind: 'your-notes', ref: 'review notes, April' } };

test('a section picked by git lists the changes whose commits name the reader\'s issues', async () => {
  const { work, out } = fixture();
  profile(work, { extends: ['client'], sections: [REQUESTS], order: ['requests', 'done', 'record', 'how'] });
  const { code, io } = await build(work);
  assert.equal(code, 0, io.errBuf);
  const html = readFileSync(out, 'utf8');
  const sec = html.slice(html.indexOf('id="sec-requests"'), html.indexOf('</section>', html.indexOf('id="sec-requests"')));
  assert.match(sec, /Picked by git: each change below cites a commit whose message names one of #12, #14, #99\./);
  assert.match(sec, /href="#signup">Choose on first sign-in<\/a>.*#12/);
  assert.match(sec, /href="#badge">Unread badge clears<\/a>.*#14/);
  assert.doesNotMatch(sec, /One-run releases/, 'a change that names none of the issues is not picked');
  // Order follows the profile, and the record and method are kept even though...
  assert.ok(html.indexOf('id="sec-requests"') < html.indexOf('id="areas"'));
  assert.doesNotMatch(html, /What I need from you/, 'a report carries no asks');
  // ...the order left out activity, highlights, next: those simply aren't shown.
  assert.doesNotMatch(html, /id="activity"|id="highlights"|id="next"/);
});

test('every view of a report shows the same facts: identical entries, numbers and statuses', async () => {
  const { work, out } = fixture();
  assert.equal((await build(work)).code, 0);
  const plain = readFileSync(out, 'utf8');
  profile(work, { extends: ['client'], sections: [REQUESTS], order: ['requests', 'done', 'record', 'how'] });
  assert.equal((await build(work)).code, 0);
  const shaped = readFileSync(out, 'utf8');
  const cards = (h) => h.match(/<article class="item"[\s\S]*?<\/article>/g).join('');
  const tiles = (h) => h.slice(h.indexOf('<div class="stats">'), h.indexOf('</p>', h.indexOf('<div class="stats">')));
  assert.equal(cards(shaped), cards(plain));
  assert.equal(tiles(shaped), tiles(plain));
  assert.equal(shaped.match(/<tbody>[\s\S]*<\/tbody>/)[0], plain.match(/<tbody>[\s\S]*<\/tbody>/)[0]);
});

test('an excluded area is counted on the page, and its pull requests stay in the record', async () => {
  const { work, out } = fixture();
  profile(work, { extends: ['client'], exclude: { themes: ['ops'] } });
  const { code, io } = await build(work);
  assert.equal(code, 0, io.errBuf);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /1 change in Running it isn&#39;t shown in this view\. Their pull requests are still in the full record below\./);
  assert.doesNotMatch(html, /<h4>One-run releases<\/h4>/);
  assert.match(html, /<td>Release in one run<\/td><td class="c"><\/td>/, 'still listed, no longer "described above"');
  assert.match(html, /<b>3<\/b><span>commits on the main branch/, 'the counts do not change with the view');
});

test('the record and the method can never be ordered away', async () => {
  const { work, out } = fixture();
  profile(work, { extends: ['client'], order: ['done'] });
  assert.equal((await build(work)).code, 0);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /id="appendix"/);
  assert.match(html, /id="how"/);
});

test('failure paths: a profile that could mislead or hides a typo writes nothing', async () => {
  const cases = [
    [{ done: 'released' }, /"done" can't be redefined/],
    [{ script: 'x' }, /unknown key "script"/],
    [{ extends: ['wizard'] }, /isn't a reader type honestweek ships/],
    [{ sections: [{ ...REQUESTS, source: { kind: 'shipped' } }] }, /source\.kind/],
    [{ sections: [{ ...REQUESTS, source: { kind: 'their-words' } }] }, /needs a "ref"/],
    [{ sections: [{ ...REQUESTS, select: { issues: [1], tags: ['x'] } }] }, /exactly one of/],
    [{ sections: [{ ...REQUESTS, id: 'done' }] }, /built-in section/],
    [{ order: ['done', 'nowhere'] }, /neither a built-in section/],
    [{ exclude: { themes: ['opps'] } }, /excludes area "opps"/],
    [{ order: ['needs-you', 'done'] }, /neither a built-in section/],
  ];
  for (const [p, re] of cases) {
    const { work, out } = fixture();
    profile(work, p);
    const { code, io } = await build(work);
    assert.equal(code, 2, JSON.stringify(p));
    assert.match(io.errBuf, re, JSON.stringify(p));
    assert.equal(existsSync(out), false, JSON.stringify(p));
  }
});

test('failure path: an item tagged for a section that does not exist is refused', async () => {
  const { work, out } = fixture();
  const items = JSON.parse(readFileSync(join(work, 'honestweek.items.json'), 'utf8'));
  items.items[2].tags = ['requsted'];
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify(items));
  profile(work, { extends: ['client'], sections: [{ id: 'picked', title: 'Picked', select: { tags: ['requested'] }, source: { kind: 'guess' } }] });
  const { code, io } = await build(work);
  assert.equal(code, 2);
  assert.match(io.errBuf, /tagged "requsted", but no section/);
  assert.equal(existsSync(out), false);
});

test('a profile made only of guesses builds, and says on the command line that it is unconfirmed', async () => {
  const { work } = fixture();
  profile(work, { extends: ['client'], sections: [{ ...REQUESTS, source: { kind: 'guess' } }], guidance: [{ text: 'Short.', source: { kind: 'guess' } }] });
  const { code, io } = await build(work);
  assert.equal(code, 0);
  assert.match(io.errBuf, /made only of guesses, so this view of the reader is unconfirmed/);
  profile(work, { extends: ['client'], sections: [REQUESTS], guidance: [{ text: 'Short.', source: { kind: 'guess' } }] });
  const again = await build(work);
  assert.doesNotMatch(again.io.errBuf, /unconfirmed/, 'one line from notes is enough to call it confirmed in part');
});

test('the short note: a few lines beside the report, only when the profile asks for it', async () => {
  const { work, out } = fixture();
  assert.equal((await build(work)).code, 0);
  assert.equal(existsSync(out.replace(/\.html$/, '.note.md')), false);
  profile(work, { extends: ['client'], sections: [REQUESTS], format: { note: true } });
  const { code, io } = await build(work);
  assert.equal(code, 0, io.errBuf);
  const note = readFileSync(out.replace(/\.html$/, '.note.md'), 'utf8');
  assert.match(note, /^\*\*Example Co report, April 1 to May 31, 2024\*\*/);
  assert.match(note, /- Your requests: 2 changes, including Unread badge clears; Choose on first sign-in\./);
  assert.doesNotMatch(note, /Needs you/);
  assert.match(note, /- Next: Next release\./);
  assert.match(note, /Full report, with every change and the pull requests behind it: report\.html/);
  assert.ok(note.split('\n').filter(Boolean).length <= 8, 'it stays short');
  assert.doesNotMatch(note, /—/);
  assert.match(io.outBuf, /short note/);
});

test('other report types ignore a reader profile entirely (byte-identical)', async () => {
  const { work, out } = fixture({ mode: 'report' });
  assert.equal((await build(work)).code, 0);
  const before = readFileSync(out);
  profile(work, { extends: ['client'], sections: [REQUESTS], format: { note: true } });
  assert.equal((await build(work)).code, 0);
  assert.deepEqual(readFileSync(out), before);
  unlinkSync(join(work, 'honestweek.reader.json'));
});

test('layers: later wins on order and format, exclusions and guidance add up, sections replace by id', () => {
  const a = normalizeLayer({ order: ['done', 'record', 'how'], exclude: { themes: ['x'] }, guidance: [{ text: 'A', source: { kind: 'guess' } }], sections: [REQUESTS] }, 'a');
  const b = normalizeLayer({ order: ['requests', 'done'], exclude: { themes: ['y'] }, format: { note: true }, guidance: [{ text: 'B', source: { kind: 'your-notes', ref: 'n' } }], sections: [{ ...REQUESTS, title: 'Asked for' }] }, 'b');
  const p = resolveProfile([a, b]);
  assert.deepEqual(p.order, ['requests', 'done', 'record', 'how']);
  assert.deepEqual(p.exclude.themes.sort(), ['x', 'y']);
  assert.deepEqual(p.guidance.map((g) => g.text), ['A', 'B']);
  assert.equal(p.sections.length, 1);
  assert.equal(p.sections[0].title, 'Asked for');
  assert.equal(p.format.note, true);
  assert.throws(() => normalizeLayer([], 'x'), ReaderProfileError);
});

test('without a profile file the client report uses the shipped default and client layers', () => {
  const p = loadReaderProfile(tmp('hw-reader-empty-'));
  assert.deepEqual(p.layers, ['reader type "default"', 'reader type "client"']);
  assert.deepEqual(p.order, ['highlights', 'activity', 'done', 'not-finished', 'next', 'record', 'how']);
  assert.equal(p.unconfirmed, false);
});

test('failure path: a report carries no asks, so content.needs is refused and nothing is written', async () => {
  const { work, out } = fixture();
  const items = JSON.parse(readFileSync(join(work, 'honestweek.items.json'), 'utf8'));
  items.content.needs = ['Approve next month.'];
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify(items));
  const { code, io } = await build(work);
  assert.equal(code, 2);
  assert.match(io.errBuf, /content\.needs isn't supported/);
  assert.equal(existsSync(out), false);
});
