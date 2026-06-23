// lib/emit/digest.mjs — the private weekly digest (default mode, trust anchor).
//
// A private, local-only Markdown file capturing the full honest picture, items
// grouped by status, each with its badge and receipt, under a week-range header.
// Pure render() — no I/O; the dispatcher owns the single write.

import { STATUSES, weekRange, renderItemLine, allItems, badge } from './_shared.mjs';

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
