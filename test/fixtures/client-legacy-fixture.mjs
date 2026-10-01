// A deterministic client-report fixture: fixed file names, dates, identities and
// messages, so its commit SHAs (and the rendered report) are the same on every run.
// test/client-legacy.test.mjs builds it with today's code and compares the bytes with
// client-legacy.html, which the client report produced before reader profiles existed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ME = 'me@example.com';

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function buildLegacyFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'hw-legacy-repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  const shas = [];
  const commits = [
    ['a.txt', 'Let people sign in with their school account (#12)', '2024-04-03T10:00:00Z'],
    ['b.txt', 'Answers cite their sources (#15)', '2024-04-17T09:00:00Z'],
    ['c.txt', 'Show a clear message when the library is empty (#18)', '2024-05-02T10:00:00Z'],
  ];
  for (const [file, msg, date] of commits) {
    writeFileSync(join(repo, file), file);
    const env = { ...process.env, GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_EMAIL: ME, GIT_AUTHOR_NAME: 'Dev', GIT_COMMITTER_NAME: 'Dev', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    git(repo, ['add', '-A'], env);
    git(repo, ['commit', '-q', '-m', msg], env);
    shas.push(git(repo, ['rev-parse', 'HEAD']).trim());
  }
  const work = mkdtempSync(join(tmpdir(), 'hw-legacy-work-'));
  writeFileSync(join(work, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: repo, label: 'app', role: 'featured' }],
    output: { mode: 'client', file: join(work, 'report.html') },
    client: { name: 'Example Co', preparedFor: 'A. Reader', preparedBy: 'Dev', prLinks: { app: 'https://example.com/app/pull/' } },
  }));
  writeFileSync(join(work, 'honestweek.items.json'), JSON.stringify({
    period: { start: '2024-04-01', end: '2024-05-31' },
    content: {
      title: 'Example Co report', headline: 'Sign-in and answers improved.', summary: ['One paragraph.'],
      themes: [{ id: 'access', title: 'Access' }, { id: 'answers', title: 'Answers' }],
      next: ['Next release.'],
    },
    items: [
      { id: 'sso', repo: 'app', theme: 'access', title: 'School sign-in', summary: 'Sign in with the school account.', status: 'shipped', highlight: true, commits: [shas[0]], receipt: { primaryCommit: shas[0] } },
      { id: 'cite', repo: 'app', theme: 'answers', title: 'Answers cite sources', summary: 'Every answer names its sources.', status: 'shipped', commits: [shas[1]], receipt: { primaryCommit: shas[1] } },
    ],
  }));
  return { repo, work, out: join(work, 'report.html'), now: new Date('2024-07-01T12:00:00Z') };
}
