// lib/emit/report.mjs — the grouped "report" output mode.
//
// Where `digest` groups by status, `report` groups BY PROJECT: one section per
// repo (featured, then reference, then display), each headed by its git-derived
// activity (commits / active days / entries) and its items, with repo-less item
// lines since the heading already names the project. This is the structured,
// per-project shape of a public weekly work log — as plain Markdown, never an
// auto-published page. Pure render() — no I/O; the dispatcher owns the write.

import { weekRange, badge, itemText, receiptPointer, formatMetrics, byShippability } from './_shared.mjs';

/** A repo-less item line (the section heading already names the project). */
function renderLine(item) {
  const b = badge(item);
  const text = itemText(item);
  const receipt = receiptPointer(item);
  return `- **${b}** — ${text}  (\`${receipt}\`)`;
}

export function render(reportModel, _config) {
  const { start, end } = weekRange(reportModel.week);
  const lines = [`# Weekly report — ${start} to ${end}`, ''];
  let total = 0;

  const groups = Array.isArray(reportModel.groups) ? reportModel.groups : [];
  for (const g of groups) {
    const items = Array.isArray(g.items) ? g.items : [];
    if (items.length === 0) continue;
    total += items.length;
    lines.push(`## ${g.label}`);
    const metricsLine = g.metrics ? formatMetrics(g.metrics) : '';
    if (metricsLine) lines.push(`_${metricsLine}_`);
    lines.push('');
    for (const it of [...items].sort(byShippability)) lines.push(renderLine(it));
    lines.push('');
  }

  const loose = Array.isArray(reportModel.items) ? reportModel.items : [];
  if (loose.length > 0) {
    total += loose.length;
    lines.push('## Other', '');
    for (const it of [...loose].sort(byShippability)) lines.push(renderLine(it));
    lines.push('');
  }

  if (total === 0) {
    lines.push('_No interactive coding sessions were found for this week._', '');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}
