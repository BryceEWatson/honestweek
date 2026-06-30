// lib/build.mjs — the `build` subcommand: verify-or-abort, redact, emit.
//
// build is where "honest by construction" is enforced. It reads the distilled
// items, re-derives EVERY git-checkable claim against the user's real commits,
// and ABORTS (exit 2) writing nothing if any cited commit is unresolved or not
// authored by the configured identity. With the opt-in voice-fence enabled
// (config.voice.denyMeta), it also aborts if authored prose narrates its own
// withholding or announces the page's honesty (the prose analogue of the numeric
// fact-fence). Only after the verify + voice passes does it assemble, redact, and
// hand the model to the configured emitter. It composes already-specified modules
// (git verify, voice-fence, redactor, badges, emitter) rather than reimplementing them.
//
// Zero runtime dependencies: Node built-ins + system git only.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { loadConfig } from './config.mjs';
import { verifyItems, repoMetricsInWindow } from './git.mjs';
import { checkVoice } from './voice-fence.mjs';
import { createRedactor } from './redact.mjs';
import { statusForTag, STATUSES } from './badges.mjs';
import { resolveWeek, localDateInTimezone } from './resolve-week.mjs';
import { emit, emitSite } from './emit/index.mjs';
import { augmentSiteModel, deriveChart } from './site/derive.mjs';
import { deriveSessions } from './site/sessions.mjs';
import { resolveProjectsRoot } from './claude-adapter.mjs';
import { buildPageModel } from './emit/page.mjs';
import { buildGoalsModel, render as renderGoals } from './emit/goals-page.mjs';
import {
  loadRegistry,
  loadChangelog,
  validateObjectives,
  validateChangelog,
  aggregateGoals,
  buildReportsFromSnapshots,
} from './goals.mjs';
import { writeArchive } from './archive.mjs';

const CONFIG_FILE = 'honestweek.config.json';
const ITEMS_FILE = 'honestweek.items.json';
// Opt-in standalone goals: when this registry is present, `page` mode emits a
// second page (goals.html) beside report.html. Absent -> single-page (unchanged).
const OBJECTIVES_FILE = 'honestweek.objectives.json';
const GOAL_CHANGELOG_FILE = 'honestweek.goal-changelog.json';

/** Read honestweek's archived page-model snapshots (lib/archive.mjs writes one
 *  `<weekStart>.json` per week as `{ week, mode, report }`). Tolerant: a missing
 *  dir or a corrupt snapshot is skipped, never aborts the goals page. */
function readArchivedSnapshots(cwd, archiveDir) {
  const base = join(cwd, archiveDir);
  if (!existsSync(base)) return [];
  let files;
  try {
    files = readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const snap = JSON.parse(readFileSync(join(base, f), 'utf8'));
      if (snap && snap.week && snap.report) out.push(snap);
    } catch {
      /* skip a corrupt snapshot; the goals page is a bonus, never a build blocker */
    }
  }
  return out;
}

/**
 * emitGoalsPage(...) -> { path, goals, activeGoals, entries, bytes }
 *
 * Aggregate the current week (the freshly-built, redacted page model) plus any
 * archived weeks into the goal lens, then write goals.html BESIDE report.html.
 * Every number is honestweek's own aggregation; every string is escaped by the
 * emitter. Pure local write — like report.html, it publishes nothing.
 */
function emitGoalsPage({ cwd, config, registry, changelog, week, currentModel, reportPath, nowISO }) {
  const archived = readArchivedSnapshots(cwd, config.output.archiveDir);
  const reports = buildReportsFromSnapshots({ currentWeek: week, currentModel, archived });
  // The report keeps its configured filename; the latest week's item rows and the
  // goals page's cross-links deep-link into THAT name (goals.html is the fixed sibling).
  const reportHref = basename(reportPath);
  const agg = aggregateGoals(reports, registry, changelog, { reportHref });
  const goalsModel = buildGoalsModel({ agg, registry, generatedAt: nowISO, generator: 'honestweek (page mode)', reportHref });
  const html = renderGoals(goalsModel);
  const goalsPath = join(dirname(reportPath), 'goals.html');
  writeFileSync(goalsPath, html);
  return {
    path: goalsPath,
    goals: agg.totals.goals,
    activeGoals: agg.totals.activeGoals,
    entries: agg.totals.entries,
    weeks: agg.totals.weeksTracked,
    bytes: Buffer.byteLength(html, 'utf8'),
  };
}

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
}

/**
 * Loud diagnostic when a session-deriving build (site/page) found ZERO session logs at the resolved root.
 * Turns the silent degrade (off-machine / wrong CLAUDE_CONFIG_DIR -> every session-derived number is 0, with
 * no signal) into an obvious one. Diagnostic only: never changes the artifact, the numbers, or the exit code.
 *
 * Root-resolution invariant: the message re-resolves the root via resolveProjectsRoot() rather than threading
 * it out of deriveSessions. This names the SAME root that was scanned because neither the site nor the page
 * path passes a `projectsRoot` override, so deriveSessions resolves it via the same pure, env-based
 * resolveProjectsRoot(). If a future change threads a custom projectsRoot, pass that root here instead.
 */
function warnIfNoSessionLogs(sessions, io) {
  if (!sessions || sessions.filesFound !== 0) return;
  io.err(
    `honestweek: no Claude session logs found under ${resolveProjectsRoot()} — session-derived numbers ` +
      `(interactive sessions, session-active days) will be 0 for every project. If your logs live elsewhere, ` +
      `set CLAUDE_CONFIG_DIR. (Expected when building off your local machine.)\n`
  );
}

/** The primary cited commit SHA for an item, from any supported provenance. */
function pickPrimarySha(item) {
  return (
    item.primaryCommit ||
    item.receipt?.primaryCommit ||
    item.commit ||
    (Array.isArray(item.commits) ? item.commits[0] : undefined) ||
    (Array.isArray(item.candidateCommits)
      ? typeof item.candidateCommits[0] === 'string'
        ? item.candidateCommits[0]
        : item.candidateCommits[0]?.sha
      : undefined) ||
    null
  );
}

/** The public status badge for an item (explicit status wins; else map its tag). */
function statusFor(item) {
  if (STATUSES.includes(item.status)) return item.status;
  return statusForTag(item.tag ?? item.status);
}

/** Build the receipt for a model item — commit data is ALWAYS the git-derived
 *  value, never what the items file carried. */
function resolveReceipt(item, verifiedIndex) {
  const sha = pickPrimarySha(item);
  if (sha && verifiedIndex.has(sha)) {
    const v = verifiedIndex.get(sha);
    return { kind: 'commit', sha, shortSha: v.shortSha, dateISO: v.dateISO };
  }
  const r = item.receipt;
  if (r && typeof r === 'object' && (r.sessionId || r.ref || r.turn)) {
    return { kind: 'session', sessionId: r.sessionId, ref: r.ref ?? r.sessionId ?? item.id };
  }
  if (typeof r === 'string' && r.trim()) return r;
  const sid = item.sessionId ?? item.session ?? item.id;
  if (sid) return { kind: 'session', sessionId: sid, ref: sid };
  return undefined; // the emitter will reject a receipt-less item
}

/**
 * assembleReportModel(items, config, verifiedIndex, week) -> reportModel
 * Groups items by repo (featured groups first, then reference, then others);
 * repo-less items go in a top-level list. Pure + testable.
 */
export function assembleReportModel(items, config, verifiedIndex, week, metricsByLabel = new Map()) {
  const roleByLabel = new Map((config.repos ?? []).map((r) => [r.label, r.role]));
  const groupsByLabel = new Map();
  const looseItems = [];

  for (const item of items) {
    const modelItem = {
      status: statusFor(item),
      text: item.text ?? item.summary ?? '',
      repo: item.repo ?? null,
      receipt: resolveReceipt(item, verifiedIndex),
    };
    const label = item.repo;
    if (label && roleByLabel.has(label)) {
      if (!groupsByLabel.has(label)) groupsByLabel.set(label, { label, role: roleByLabel.get(label), items: [] });
      groupsByLabel.get(label).items.push(modelItem);
    } else {
      looseItems.push(modelItem);
    }
  }

  const roleRank = { featured: 0, reference: 1, display: 2 };
  const groups = [...groupsByLabel.values()].sort(
    (a, b) => (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9) || a.label.localeCompare(b.label)
  );

  // Attach git-derived metrics to each non-display group. `entries` is always the
  // render-count; commits/activeDays come from metricsByLabel when the repo was
  // readable. DISPLAY repos are NEVER git-read, so they carry no metrics at all.
  for (const g of groups) {
    if (g.role === 'display') continue;
    const git = metricsByLabel.get(g.label) || null;
    g.metrics = { entries: g.items.length, ...(git || {}) };
  }

  return { week, groups, items: looseItems };
}

function normalizeWeek(week, now, config) {
  if (week && (week.start || week.weekStart)) {
    const norm = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    return { start: norm(week.start ?? week.weekStart), end: norm(week.end ?? week.weekEnd) };
  }
  // Fall back to the last completed week, tz-correct against the real now.
  const tz = config.week?.timezone || 'UTC';
  const today = localDateInTimezone(now, tz);
  const { weekStart, weekEnd } = resolveWeek({ today });
  return { start: weekStart.toISOString().slice(0, 10), end: weekEnd.toISOString().slice(0, 10) };
}

/**
 * runBuild({ cwd, argv, now, io }) -> exit code (0 success).
 * On a verification failure it calls io.exit(2) after a clear message and writes
 * nothing. io.exit defaults to process.exit; tests inject a throwing exit.
 */
export async function runBuild({ cwd = process.cwd(), argv = [], now = new Date(), io = defaultIo() } = {}) {
  const configPath = join(cwd, CONFIG_FILE);
  const itemsPath = join(cwd, ITEMS_FILE);

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    io.err(`build: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }

  if (!existsSync(itemsPath)) {
    io.err(`build: ${ITEMS_FILE} not found in ${cwd}. Run discover and distil first.\n`);
    return io.exit(1) ?? 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(itemsPath, 'utf8'));
  } catch (err) {
    io.err(`build: ${ITEMS_FILE} is not valid JSON (${err.message}).\n`);
    return io.exit(1) ?? 1;
  }

  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  const week = normalizeWeek(Array.isArray(parsed) ? null : parsed.week, now, config);
  // Curated passthrough for site mode: authored editorial the items file carries
  // (top-level content + project metadata). Redacted with everything else; the
  // site adapter/transform maps it. Absent for non-site modes.
  const content = Array.isArray(parsed) ? null : parsed.content ?? null;
  const projects = Array.isArray(parsed) ? null : parsed.projects ?? null;

  // --- verify-or-abort (over ALL cited commits, before any assembly/emit) ---
  const { ok, problems, verified } = verifyItems(items, config);
  if (!ok) {
    const p = problems[0];
    io.err(
      `build: ABORTED — item ${p.item} (repo ${JSON.stringify(p.repo)}) cites commit ${p.sha}: ${p.reason}\n` +
        `No output was written.\n`
    );
    return io.exit(2) ?? 2;
  }

  // --- git-derived per-project metrics (numbers re-derived, never authored) ---
  // Featured/reference repos only; DISPLAY repos are never git-read. An unreadable
  // repo yields no metric (repoMetricsInWindow returns null) — never a fake 0.
  const sinceISO = `${week.start}T00:00:00.000Z`;
  const untilISO = `${week.end}T23:59:59.999Z`;
  const metricsByLabel = new Map();
  for (const repo of config.repos ?? []) {
    if (repo.role === 'display') continue;
    const m = repoMetricsInWindow(repo.resolvedPath ?? repo.path, config.identity.authorEmails, sinceISO, untilISO);
    if (m) metricsByLabel.set(repo.label, m);
  }

  // --- assemble -> (augment for site) -> redact -> emit ---
  const verifiedIndex = new Map(verified.map((v) => [v.sha, v]));
  const model = assembleReportModel(items, config, verifiedIndex, week, metricsByLabel);
  const redactor = createRedactor(config);

  // --- voice-fence (opt-in): the authored-prose honesty lint, after assembly and
  // before emit. Like verify-or-abort and the numeric fact-fence, a violation
  // ABORTS (exit 2, writes nothing). OFF by default (config.voice.denyMeta), so an
  // existing consumer is unchanged. It scans the AUTHORED source fields every mode
  // renders (item title/summary/text + the curated content/projects editorial),
  // never evidence snippets/receipts. (A site TRANSFORM that surfaces other fields
  // owns its own curated strings — trusted passthrough; see lib/site/transform.mjs.)
  // Done OUTSIDE the emit try/catch below (like verify-or-abort) so the exit-2 abort
  // is never re-mapped to a generic exit 1.
  if (config.voice?.denyMeta) {
    const violations = checkVoice(
      { items, content, projects },
      { denyPhrases: config.voice.denyPhrases, allowPhrases: config.voice.allowPhrases }
    );
    if (violations.length) {
      io.err(
        `build: ABORTED — voice: ${violations.length} self-undermining phrase(s) in authored prose:\n` +
          violations.map((v) => `  - ${v.path}: ${JSON.stringify(v.phrase)} [${v.rule}]`).join('\n') +
          `\nThese narrate withholding or announce the page's own honesty — show it through badges/receipts, ` +
          `don't say it. Reword them (or carve out a false positive with voice.allowPhrases). No output was written.\n`
      );
      return io.exit(2) ?? 2;
    }
  }

  // Opt-in MULTI-PAGE goals (page mode only): detect + validate honestweek.objectives.json
  // BEFORE any emit, so an invalid/leaky registry aborts cleanly (exit 2, write nothing).
  // Done OUT of the emit try/catch below, exactly like verify-or-abort, so the abort's
  // io.exit is never re-mapped to a generic exit 1. Absent registry -> single-page.
  let goalsRegistry = null;
  let goalsChangelog = null;
  if (config.output.mode === 'page' && existsSync(join(cwd, OBJECTIVES_FILE))) {
    try {
      goalsRegistry = loadRegistry(join(cwd, OBJECTIVES_FILE));
    } catch (err) {
      io.err(`build: ABORTED — cannot read ${OBJECTIVES_FILE} (${err.message}).\nNo output was written.\n`);
      return io.exit(2) ?? 2;
    }
    try {
      goalsChangelog = loadChangelog(join(cwd, GOAL_CHANGELOG_FILE));
    } catch (err) {
      io.err(`build: ABORTED — cannot read ${GOAL_CHANGELOG_FILE} (${err.message}).\nNo output was written.\n`);
      return io.exit(2) ?? 2;
    }
    const projectLabels = new Set((config.repos ?? []).map((r) => r.label));
    const valRedactor = createRedactor(config);
    const objV = validateObjectives({ registry: goalsRegistry, projectLabels, redactor: valRedactor });
    const clV = validateChangelog({ changelog: goalsChangelog, registry: goalsRegistry, redactor: valRedactor });
    for (const w of [...objV.warnings, ...clV.warnings]) io.err(`build: goal-registry warning: ${w}\n`);
    const errs = [...objV.errors, ...clV.errors];
    if (errs.length) {
      io.err(
        `build: ABORTED — ${OBJECTIVES_FILE} / ${GOAL_CHANGELOG_FILE} invalid:\n` +
          errs.map((e) => `  - ${e}`).join('\n') +
          `\nNo output was written.\n`
      );
      return io.exit(2) ?? 2;
    }
  }

  let result;
  let goalsResult = null; // the optional second page (goals.html), when a registry is present
  let redactedForArchive = null; // the honestweek /log snapshot source (markdown modes only)
  try {
    if (config.output.mode === 'site') {
      // Augment with the git/session-derived bundle BEFORE redaction, so authored
      // content + the chart's per-day item titles are scrubbed by one pass.
      const bundle = augmentSiteModel(model, { config, items, verified, verifiedIndex, week, now, content, projects });
      warnIfNoSessionLogs(bundle.sessions, io); // loud signal if the session root yielded nothing (off-machine / wrong CLAUDE_CONFIG_DIR)
      let toEmit = bundle;
      if (config.output.redact !== false) {
        toEmit = redactor.deepRedact(bundle);
        // provenance.redactions is the true scrub count for this write (filled
        // here, post-redaction). A derived number, so the fact-fence accepts it.
        if (toEmit.provenance) toEmit.provenance.redactions = redactor.count;
      }
      // When output.redact is false the target's transform owns redaction (for
      // placeholder parity with its own redactor) + sets provenance.redactions.
      result = await emitSite(toEmit, config, { cwd }, { now: now.toISOString(), nowDate: now });
    } else if (config.output.mode === 'page') {
      // Standalone site: derive the commits/day chart (honestweek's own git numbers)
      // and shape the page model from the verified items, then redact + emit one
      // self-contained interactive HTML file. Same verify-or-abort + git-derived
      // numbers as every other mode; curated prose is escaped at render.
      const todayKey = localDateInTimezone(now, config.week?.timezone || 'UTC').toISOString().slice(0, 10);
      const chart = deriveChart({ config, weekStartKey: week.start, weekEndKey: week.end, todayKey });
      // Session-active days for the per-project metrics (so a display/session-only repo shows the
      // days it had interactive sessions, not a blank). `week` is string-shaped in this branch, so
      // reconstruct the Date window deriveSessions expects. deriveChart + deriveSessions span the
      // SAME weekGrid(weekStartKey, todayKey), so sessions.days.length === chart.windowDays.
      const weekStart = new Date(`${week.start}T00:00:00.000Z`);
      const weekEnd = new Date(`${week.end}T23:59:59.999Z`);
      const sessions = deriveSessions({ config, weekStart, weekEnd, now });
      warnIfNoSessionLogs(sessions, io); // loud signal if the session root yielded nothing (off-machine / wrong CLAUDE_CONFIG_DIR)

      // The registry was already detected + validated (fail-closed) above; a present
      // goalsRegistry means page mode goes MULTI-PAGE (report.html + goals.html).
      const pageModel = buildPageModel({ items, config, verifiedIndex, week, chart, metricsByLabel, sessions, content, hasGoals: !!goalsRegistry });
      redactedForArchive = redactor.deepRedact(pageModel);
      result = emit(redactedForArchive, config, { cwd });

      // Second page: aggregate the current week + archived weeks into goals.html,
      // written beside report.html (cross-linked). The aggregation reads the same
      // redacted model report.html rendered, so the two pages can never disagree.
      if (goalsRegistry) {
        goalsResult = emitGoalsPage({
          cwd,
          config,
          registry: goalsRegistry,
          changelog: goalsChangelog,
          week,
          currentModel: redactedForArchive,
          reportPath: result.path,
          nowISO: now.toISOString(),
        });
      }
    } else {
      redactedForArchive = redactor.deepRedact(model);
      result = emit(redactedForArchive, config, { cwd });
    }
  } catch (err) {
    // A fact-fence (or resolve) abort is a verify-or-abort: exit 2, write nothing.
    if (err && err.factFence) {
      io.err(`build: ABORTED — ${err.message}\nNo output was written.\n`);
      return io.exit(2) ?? 2;
    }
    io.err(`build: ${err.message}\n`);
    return io.exit(1) ?? 1;
  }

  // Opt-in local weekly archive — a snapshot + index of past weeks ("/log").
  // Local file writes only; an archive failure warns but never loses the primary
  // output or aborts (the rendered output is the contract; the archive is a bonus).
  let archived = null;
  if (config.output?.archive && redactedForArchive) {
    try {
      archived = writeArchive({
        cwd,
        dir: config.output.archiveDir,
        week,
        mode: config.output.mode,
        model: redactedForArchive,
        nowISO: now.toISOString(),
      });
    } catch (err) {
      io.err(`build: WARNING — archive write failed (${err.message}); the ${result.mode} output was still written.\n`);
    }
  }

  io.out(
    `build: wrote ${result.path} (${result.mode}, ${result.items} item(s), ${result.bytes} bytes).` +
      (goalsResult
        ? ` Wrote ${goalsResult.path} (${goalsResult.activeGoals}/${goalsResult.goals} goals active, ${goalsResult.entries} entr${goalsResult.entries === 1 ? 'y' : 'ies'}, ${goalsResult.weeks} week(s)).`
        : '') +
      (archived ? ` Archived ${archived.snapshotFile} (${archived.weeks} week(s) indexed).` : '') +
      '\n'
  );
  return 0;
}

export default function run(argv) {
  return runBuild({ argv });
}
