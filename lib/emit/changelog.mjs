// lib/emit/changelog.mjs — a dated "This week" section in an in-repo CHANGELOG.
//
// render() returns the managed BLOCK for the week (delimited by HTML-comment
// markers). mergeIntoChangelog() folds that block into existing CHANGELOG
// content: a same-week section is replaced in place (no duplicate); everything
// outside the managed block is preserved byte-for-byte. Both are pure; the
// dispatcher does the read + single write.

import { weekRange, renderItemLine, allItems, byShippability } from './_shared.mjs';

function weekKey(week) {
  const { start, end } = weekRange(week);
  return `${start}/${end}`;
}

function markers(key) {
  return {
    start: `<!-- honestweek:week:${key} -->`,
    end: `<!-- /honestweek:week:${key} -->`,
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The managed block (markers + dated heading + badged/receipted items). */
export function render(reportModel, _config) {
  const { start, end } = weekRange(reportModel.week);
  const key = `${start}/${end}`;
  const { start: open, end: close } = markers(key);
  const items = allItems(reportModel).slice().sort(byShippability);

  const lines = [open, `## This week (${start} – ${end})`, ''];
  if (items.length === 0) {
    lines.push('_No reportable work this week._');
  } else {
    for (const it of items) lines.push(renderItemLine(it));
  }
  lines.push(close);
  return lines.join('\n');
}

/**
 * mergeIntoChangelog(existing, block, week) -> merged content.
 * Replaces an existing same-week managed block in place, else appends the block.
 * Content outside the managed block is preserved verbatim.
 */
export function mergeIntoChangelog(existing, block, week) {
  const key = weekKey(week);
  const { start: open, end: close } = markers(key);
  const text = typeof existing === 'string' ? existing : '';

  const blockRe = new RegExp(`${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}`);
  if (blockRe.test(text)) {
    return text.replace(blockRe, block);
  }

  if (text.trim() === '') return `${block}\n`;
  const sep = text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${block}\n`;
}
