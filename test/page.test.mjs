// test/page.test.mjs — the standalone `page` mode (self-contained interactive HTML
// report in the adopted brycewatson.com console design).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPageModel, render, esc } from '../lib/emit/page.mjs';
import { renderFor } from '../lib/emit/index.mjs';
import { OUTPUT_MODES, DEFAULT_OUTPUT_FILES } from '../lib/config.mjs';

const config = {
  identity: { authorEmails: ['dev@example.com'] },
  repos: [{ path: '/x', label: 'proj', role: 'featured' }],
  output: { mode: 'page', file: 'honestweek.report.html' },
};
const week = { start: '2024-06-10', end: '2024-06-16' };
const verifiedIndex = new Map([
  ['aaaaaaa', { sha: 'aaaaaaa', shortSha: 'aaaaaaa', subject: 'feat: did the thing', dateISO: '2024-06-12T10:00:00Z' }],
]);
const chart = {
  metric: 'commits',
  windowDays: 7,
  max: 3,
  days: [
    { date: '2024-06-10', weekday: 'mon', isWeekend: false, isToday: false, total: 3, byRepo: { proj: 3 } },
    { date: '2024-06-11', weekday: 'tue', isWeekend: false, isToday: false, total: 0, byRepo: {} },
  ],
};

function model() {
  return buildPageModel({
    items: [
      { id: 'a', status: 'shipped', repo: 'proj', primaryCommit: 'aaaaaaa', title: 'Did the thing', summary: 'A real, verified change.' },
      { id: 'b', status: 'in progress', repo: 'proj', summary: 'No commit yet, still a receipt-less entry.' },
    ],
    config,
    verifiedIndex,
    week,
    chart,
    metricsByLabel: new Map([['proj', { commits: 3, activeDays: 1 }]]),
    content: { headline: 'My week.' },
  });
}

test('page is a registered output mode with a default HTML file', () => {
  assert.ok(OUTPUT_MODES.includes('page'));
  assert.equal(DEFAULT_OUTPUT_FILES.page, 'honestweek.report.html');
});

test('buildPageModel groups by repo and uses the git-derived receipt + date', () => {
  const m = model();
  assert.equal(m.groups.length, 1);
  const g = m.groups[0];
  assert.equal(g.label, 'proj');
  assert.equal(g.metrics.commits, 3);
  assert.equal(g.metrics.entries, 2);
  const shipped = g.items.find((i) => i.status === 'shipped');
  assert.equal(shipped.receipt.shortSha, 'aaaaaaa');
  assert.equal(shipped.receipt.subject, 'feat: did the thing');
  assert.equal(shipped.date, '2024-06-12');
  assert.equal(shipped.dateLabel, 'jun 12');
  // a commit-less item carries no receipt (the drawer simply will not render)
  const wip = g.items.find((i) => i.status === 'in progress');
  assert.equal(wip.receipt, null);
});

test('render produces a self-contained HTML document with the panel, chart, badges, and receipt', () => {
  const html = render(model(), config);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('wl-panel'));
  assert.ok(html.includes('wl-chart'));
  assert.ok(html.includes('is-shipped'));
  assert.ok(html.includes('is-progress'));
  assert.ok(html.includes('My week.'));
  assert.ok(html.includes('aaaaaaa'));
  assert.ok(html.includes('feat: did the thing'));
  assert.ok(html.includes('<script>'));
});

test('render goes through the emit dispatcher for mode "page"', () => {
  assert.equal(typeof renderFor('page', model(), config), 'string');
});

test('curated prose is HTML-escaped (no markup injection)', () => {
  const m = buildPageModel({
    items: [{ id: 'x', status: 'shipped', repo: 'proj', primaryCommit: 'aaaaaaa', title: '<img src=x onerror=alert(1)>', summary: 'a < b && c > d' }],
    config, verifiedIndex, week, chart, metricsByLabel: new Map(),
  });
  const html = render(m, config);
  assert.ok(!html.includes('<img src=x onerror'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('a &lt; b &amp;&amp; c &gt; d'));
});

test('the output has NO external resources (zero-egress promise)', () => {
  const html = render(model(), config);
  // no external stylesheet/script/font/image fetches — everything is inline.
  assert.ok(!/<link\b/i.test(html));
  assert.ok(!/src\s*=\s*["']https?:/i.test(html));
  assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(html));
});

test('esc neutralizes the five markup-significant characters', () => {
  assert.equal(esc('<a href="x">&y</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;');
});

test('an empty week renders the honest "no sessions" line, not a fake panel of zeros', () => {
  const m = buildPageModel({ items: [], config, verifiedIndex: new Map(), week, chart: { max: 0, days: [], windowDays: 7 } });
  const html = render(m, config);
  assert.ok(html.includes('No interactive coding sessions were found'));
});
