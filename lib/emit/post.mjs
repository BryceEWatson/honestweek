// lib/emit/post.mjs — a copy-paste build-in-public Markdown update.
//
// Leads with the honest/badged items, most-shippable-first (shipped, then in
// progress, then "designed, not proven"). Each line carries its status badge
// and a receipt. Pure render() — no I/O.

import { weekRange, renderItemLine, allItems, byShippability } from './_shared.mjs';

export function render(reportModel, _config) {
  const { start, end } = weekRange(reportModel.week);
  const items = allItems(reportModel).slice().sort(byShippability);

  const lines = [`**This week** (${start} – ${end})`, ''];

  if (items.length === 0) {
    lines.push('_No reportable work this week._');
  } else {
    for (const it of items) lines.push(renderItemLine(it));
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}
