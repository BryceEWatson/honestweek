// lib/emit/_shared.mjs — helpers shared by the three emitters.
//
// Emitters add NO new claims, motives, or numbers. They format the verified,
// badged, receipt-bearing items they are handed. An item that reaches an emitter
// without a status drawn from STATUSES or without a usable receipt is a bug
// upstream — the emitter fails LOUD rather than render an unbadged or
// receipt-less line. Default to under-claiming: render exactly the status the
// model carries, never upgrade it.

import { STATUSES } from '../badges.mjs';

export { STATUSES };

/** Normalize a week range to { start, end } ISO date strings (YYYY-MM-DD). */
export function weekRange(week) {
  if (!week || (week.start == null && week.weekStart == null)) {
    throw new Error('emit: report model is missing a week range.');
  }
  const norm = (v) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'string') return v.slice(0, 10);
    throw new Error('emit: week range bound is neither a Date nor an ISO string.');
  };
  return { start: norm(week.start ?? week.weekStart), end: norm(week.end ?? week.weekEnd) };
}

/** The validated status badge for an item (throws if missing/invalid). */
export function badge(item) {
  if (!item || !STATUSES.includes(item.status)) {
    throw new Error(
      `emit: item has a missing or invalid status (${JSON.stringify(item?.status)}); must be one of ${JSON.stringify(STATUSES)}.`
    );
  }
  return item.status;
}

/** A display pointer for an item's receipt (throws if there is none). */
export function receiptPointer(item) {
  const r = item?.receipt;
  if (r == null) {
    throw new Error('emit: item is missing a receipt (every rendered item must carry one).');
  }
  if (typeof r === 'string') {
    if (!r.trim()) throw new Error('emit: item receipt is an empty string.');
    return r.trim();
  }
  const p = r.shortSha || r.sha || r.sessionId || r.ref || r.turn;
  if (!p) throw new Error('emit: item receipt has no usable pointer (shortSha/sha/sessionId/ref).');
  return String(p);
}

/** The text/summary body of an item (throws if absent). */
export function itemText(item) {
  const t = item?.text ?? item?.summary;
  if (typeof t !== 'string' || !t.trim()) {
    throw new Error('emit: item is missing its text/summary.');
  }
  return t.trim();
}

/** Render a single item as a Markdown bullet: "- **badge** — text  (receipt)". */
export function renderItemLine(item) {
  const b = badge(item);
  const text = itemText(item);
  const receipt = receiptPointer(item);
  const repo = item.repo ? ` _(${item.repo})_` : '';
  return `- **${b}** — ${text}${repo}  (\`${receipt}\`)`;
}

/** Stable most-shippable-first ordering (shipped, in progress, designed). */
export function byShippability(a, b) {
  return STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
}

/** Collect the flat item list from a report model (groups[].items and/or items). */
export function allItems(reportModel) {
  const items = [];
  if (Array.isArray(reportModel?.items)) items.push(...reportModel.items);
  if (Array.isArray(reportModel?.groups)) {
    for (const g of reportModel.groups) {
      if (Array.isArray(g.items)) {
        for (const it of g.items) items.push(it.repo ? it : { ...it, repo: it.repo ?? g.label });
      }
    }
  }
  return items;
}
