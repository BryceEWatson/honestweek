// lib/emit/digest.mjs — the private weekly digest (default mode, trust anchor).
//
// A private, local-only Markdown file capturing the full honest picture, items
// grouped by status, each with its badge and receipt, under a week-range header.
// Pure render() — no I/O; the dispatcher owns the single write.

import { STATUSES, weekRange, renderItemLine, allItems, badge, formatMetrics } from './_shared.mjs';

const STATUS_HEADINGS = {
  shipped: 'Shipped',
  'in progress': 'In progress',
  'designed, not proven': 'Designed, not proven',
};

export function render(reportModel, _config) {
  const { start, end } = weekRange(reportModel.week);
  const items = allItems(reportModel);
  // Validate every item up front so an invalid-status item is a loud error
  // rather than being silently dropped by the per-status grouping below.
  for (const it of items) badge(it);

  const lines = [
    `# Weekly digest — ${start} to ${end}`,
    '',
    '> Private, local-only working draft. Every line carries a status badge and a receipt. Nothing here is published until you publish it.',
    '',
  ];

  // Git-derived activity, when present. Only featured/reference groups carry
  // metrics (display repos are never git-read), and only commits/activeDays —
  // the re-derived numbers — earn a line; an entries-only group is omitted.
  const groups = Array.isArray(reportModel.groups) ? reportModel.groups : [];
  const activity = groups.filter((g) => g.metrics && (g.metrics.commits != null || g.metrics.activeDays != null));
  if (activity.length > 0) {
    lines.push('## Activity', '');
    for (const g of activity) lines.push(`- **${g.label}** — ${formatMetrics(g.metrics)}`);
    lines.push('');
  }

  for (const status of STATUSES) {
    const group = items.filter((it) => it.status === status);
    if (group.length === 0) continue;
    lines.push(`## ${STATUS_HEADINGS[status]}`, '');
    for (const it of group) lines.push(renderItemLine(it));
    lines.push('');
  }

  if (items.length === 0) {
    lines.push('_No interactive coding sessions were found for this week._', '');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}
