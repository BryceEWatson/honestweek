// The grouped "report" output mode: one section per project, headed by its
// git-derived metrics, with repo-less item lines (the heading names the project).
// display projects render generically with no metrics.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { render } from '../lib/emit/report.mjs';
import { renderFor } from '../lib/emit/index.mjs';
import { assembleReportModel } from '../lib/build.mjs';
import { OUTPUT_MODES, DEFAULT_OUTPUT_FILES, normalizeConfig } from '../lib/config.mjs';

const week = { start: '2024-06-10', end: '2024-06-16' };
const config = { repos: [{ label: 'app', role: 'featured' }, { label: 'client', role: 'display' }] };

function model() {
  const items = [
    { status: 'in progress', text: 'Retry queue wiring', repo: 'app', receipt: { sessionId: 'sess-b' } },
    { status: 'shipped', text: 'Shipped auth redirect', repo: 'app', receipt: { sessionId: 'sess-a' } },
    { status: 'designed, not proven', text: 'Worked on a private project', repo: 'client', receipt: { sessionId: 'sess-c' } },
  ];
  return assembleReportModel(items, config, new Map(), week, new Map([['app', { commits: 6, activeDays: 3 }]]));
}

test('report groups by project, headed by metrics, with shippable-first repo-less lines', () => {
  const out = render(model(), config);
  assert.match(out, /# Weekly report — 2024-06-10 to 2024-06-16/);
  assert.match(out, /## app/);
  assert.match(out, /6 commits/);
  assert.match(out, /3 active days/);
  assert.match(out, /2 entries/);
  // shipped sorts before in progress within the project
  assert.ok(out.indexOf('Shipped auth redirect') < out.indexOf('Retry queue wiring'));
  // the item line omits the repo (the heading already names it)
  assert.doesNotMatch(out, /_\(app\)_/);
  assert.match(out, /\(`sess-a`\)/);
});

test('report renders a display project generically and gives it no metrics line', () => {
  const out = render(model(), config);
  assert.match(out, /## client/);
  const clientFirstLine = out.slice(out.indexOf('## client')).split('\n')[1];
  assert.doesNotMatch(clientFirstLine, /commits|active days/, 'no metrics under a display project');
});

test('report places repo-less items under Other and handles an empty week', () => {
  const loose = assembleReportModel([{ status: 'shipped', text: 'No repo item', receipt: { sessionId: 'sx' } }], { repos: [] }, new Map(), week);
  const out = render(loose, {});
  assert.match(out, /## Other/);
  assert.match(out, /No repo item/);

  const empty = assembleReportModel([], { repos: [] }, new Map(), week);
  assert.match(render(empty, {}), /No interactive coding sessions were found/);
});

test('report is a registered output mode with a default file and accepted by config', () => {
  assert.ok(OUTPUT_MODES.includes('report'));
  assert.equal(DEFAULT_OUTPUT_FILES.report, 'honestweek.report.md');
  assert.equal(typeof renderFor('report', model(), config), 'string');

  const cfg = normalizeConfig({
    identity: { authorEmails: ['me@example.com'] },
    repos: [{ label: 'app', path: '.', role: 'featured' }],
    output: { mode: 'report' },
  });
  assert.equal(cfg.output.mode, 'report');
  assert.equal(cfg.output.file, 'honestweek.report.md');
});
