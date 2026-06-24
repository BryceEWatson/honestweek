// lib/archive.mjs — the local weekly-archive series (opt-in).
//
// When output.archive is enabled, a successful build also snapshots that week's
// (already-redacted) report model to <archiveDir>/<weekStart>.json and upserts a
// lightweight <archiveDir>/index.json listing every archived week. This is the
// local equivalent of a "/log" series of past weekly reports — it makes ONLY
// local file writes: no network, no git, no push. The user keeps (or commits) the
// archive themselves; honestweek never publishes it.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_FILE = 'index.json';

function countItems(model) {
  let n = Array.isArray(model?.items) ? model.items.length : 0;
  if (Array.isArray(model?.groups)) {
    for (const g of model.groups) n += Array.isArray(g.items) ? g.items.length : 0;
  }
  return n;
}

/** Read the existing index's weeks[] (tolerant of an absent/corrupt file). */
function readIndexWeeks(indexPath) {
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (Array.isArray(parsed?.weeks)) return parsed.weeks;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* a corrupt index is rebuilt from this run forward, never throws */
  }
  return [];
}

/**
 * writeArchive({ cwd, dir, week, mode, model, nowISO }) ->
 *   { snapshotFile, indexFile, weeks }
 *
 * Writes the per-week snapshot and upserts the index (one entry per weekStart,
 * newest first). All paths are returned project-relative for reporting. Pure
 * local I/O — no network/git.
 */
export function writeArchive({ cwd = process.cwd(), dir, week, mode, model, nowISO }) {
  const base = join(cwd, dir);
  mkdirSync(base, { recursive: true });

  const snapshotName = `${week.start}.json`;
  const snapshot = { week, mode, generatedAt: nowISO, report: model };
  writeFileSync(join(base, snapshotName), `${JSON.stringify(snapshot, null, 2)}\n`);

  const indexPath = join(base, INDEX_FILE);
  const weeks = readIndexWeeks(indexPath).filter((e) => e?.week?.start !== week.start);
  weeks.push({ week, mode, file: snapshotName, items: countItems(model), generatedAt: nowISO });
  weeks.sort((a, b) => String(b?.week?.start).localeCompare(String(a?.week?.start)));
  writeFileSync(indexPath, `${JSON.stringify({ weeks }, null, 2)}\n`);

  return { snapshotFile: join(dir, snapshotName), indexFile: join(dir, INDEX_FILE), weeks: weeks.length };
}
