// lib/goals.mjs — the generic goal lens: aggregator + validators for the
// STANDALONE `page` mode's optional second page (goals.html).
//
// This is honestweek's OWN, generic implementation of the same goal-aggregation
// and publish-gate pattern a site's /goals page uses — clean-room (no dependency
// on any target site's module), and generic in three ways:
//   1. Objective ids are arbitrary anchor-safe slugs (not a fixed `obj-<ts>-<hex>`
//      id form), so any user's registry validates.
//   2. No house no-em-dash voice rule is imposed on a user's curated registry
//      strings — every dynamic string is HTML-escaped at render instead, which is
//      the safety gate.
//   3. Hrefs are in-file anchors for the self-contained two-page site:
//        - a goal's verified item row links to `report.html#<item-id>` for the
//          LATEST week (the one report.html shows) and is unlinked for older
//          weeks (a standalone build has no per-week archive HTML page);
//        - goal anchors (`#goal-<id>`) and change anchors (`#changed-<id>`) are
//          same-page anchors on goals.html.
//
// Honesty posture (identical to page mode): every NUMBER here (entries,
// weeksActive, per-week counts, status counts) is honestweek's OWN aggregation
// of already-verified report snapshots; curated STRINGS (labels, what/why/how,
// change notes) are trusted but HTML-escaped by the emitter before they reach
// the document. The registry is the publish gate: only objectives listed in it
// can appear, and an item that resolves to no objective is OMITTED.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readFileSync } from 'node:fs';

const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// An objective id is used verbatim as the `#goal-<id>` anchor + dom id, so it
// must be anchor-safe. Generic (no fixed id scheme): a leading alphanumeric then
// alphanumerics / dot / underscore / hyphen.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A change-log entry id is a stable lowercase slug (the `#changed-<id>` anchor).
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// week is an ISO date (YYYY-MM-DD); a structural change can land in any week.
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHANGE_TYPES = new Set(['add', 'split', 'retire', 'relabel', 'merge']);
const KINDS = new Set(['continuous', 'finite']);
const HOW_TYPES = new Set(['sessions', 'mined', 'planned']);

/** Read + parse a JSON registry file. Throws (loud) on a missing/invalid file —
 *  the caller decides whether a registry is opt-in (absent = no goals page). */
export function loadRegistry(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** The curated goal-change log. A MISSING file is fine (the band is optional):
 *  it resolves to an empty log, so goals.html simply renders no "what changed". */
export function loadChangelog(p) {
  if (!existsSync(p)) return { changes: [] };
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Resolve a report item to a registry objective, or null.
 *
 * Order: (1) item.objectiveId if present AND in the registry; (2)
 * projectToObjective[item.project] (for the standalone, item.project is the repo
 * label). An item that resolves to nothing is OMITTED from the goal lens — that
 * omission is how unmapped projects are excluded. Never falls back to treating
 * item.project as a goal.
 *
 * @returns {{id, publicLabel, publicGroup, via:"objectiveId"|"project", ...}|null}
 */
export function resolveGoal(item, registry, onWarn) {
  const objectives = (registry && registry.objectives) || {};
  const map = (registry && registry.projectToObjective) || {};
  if (item && item.objectiveId) {
    if (objectives[item.objectiveId]) {
      return { id: item.objectiveId, ...objectives[item.objectiveId], via: 'objectiveId' };
    }
    if (onWarn) onWarn(`item "${item.id}" objectiveId "${item.objectiveId}" is not in the registry; falling back to project mapping`);
  }
  const mappedId = item ? map[item.project] : undefined;
  if (mappedId && objectives[mappedId]) {
    return { id: mappedId, ...objectives[mappedId], via: 'project' };
  }
  return null;
}

/**
 * aggregateGoals(reports, registry, changelog) -> render-ready goals model.
 *
 * Every registered objective appears (registry-driven), in registry group +
 * declared order, with whatever verified work resolves to it across the weeks.
 *
 * @param {Array<{weekStart, weekLabel, latest, items:Array}>} reports
 *   one entry per weekly report (any order), each carrying that week's already-
 *   verified, already-redacted items (each: {id, project, status, date,
 *   dateLabel, tier, title, summary}). For the standalone, item.project is the
 *   repo label and `latest` marks the week report.html renders.
 * @param {object} registry  parsed honestweek.objectives.json
 * @param {object|null} changelog  parsed honestweek.goal-changelog.json or null
 * @param {{reportHref?:string}} [opts]  the report page's filename (default
 *   "report.html") that the latest week's item rows deep-link into.
 * @returns {{groups, weeks, totals, unresolvedByProject, overrides, changes}}
 */
export function aggregateGoals(reports, registry, changelog = null, { reportHref = 'report.html' } = {}) {
  const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
  const weeksAsc = (Array.isArray(reports) ? reports : [])
    .map((r) => ({ weekStart: r.weekStart, weekLabel: r.weekLabel }))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));

  // --- goal-change log -> render-ready `changes` + per-goal `provenance` ---
  // Append-only (oldest-first); the page reads newest-first. `to`/`published`
  // carry only ids, resolved to their LIVE registry label here; `from` keeps its
  // FROZEN inline label (a retired goal is gone from the registry).
  const objectives = (registry && registry.objectives) || {};
  const weekLabelByStart = new Map(weeksAsc.map((w) => [w.weekStart, w.weekLabel]));
  const weekLabelFor = (week) => {
    if (weekLabelByStart.has(week)) return weekLabelByStart.get(week);
    const [, m, d] = String(week).split('-').map(Number);
    return m && d ? `${MONTHS3[m - 1]} ${d}` : String(week);
  };
  const liveLabel = (id) => (objectives[id] ? objectives[id].publicLabel : null);
  const resolveChild = (ref) => ({ id: ref.id, label: liveLabel(ref.id), href: `#goal-${ref.id}` });
  const changes = ((changelog && changelog.changes) || [])
    .map((c) => ({
      id: c.id,
      week: c.week,
      weekLabel: weekLabelFor(c.week),
      type: c.type,
      note: c.note,
      from: (c.from || []).map((f) => ({ id: f.id, label: f.label })),
      to: (c.to || []).map(resolveChild),
      published: (c.published || []).map(resolveChild),
    }))
    .reverse(); // append order is oldest-first; render newest-first

  // Stamp each LIVE goal a change produced with its provenance (newest wins;
  // `changes` is already newest-first, so first-seen is newest).
  const provByGoal = new Map();
  for (const c of changes) {
    const state =
      c.type === 'split' ? 'split-child' : c.type === 'merge' ? 'merge-child' : c.type === 'relabel' ? 'relabeled' : 'added';
    for (const t of c.to) if (!provByGoal.has(t.id)) provByGoal.set(t.id, { state, changeId: c.id, weekLabel: c.weekLabel });
    for (const p of c.published) if (!provByGoal.has(p.id)) provByGoal.set(p.id, { state: 'published', changeId: c.id, weekLabel: c.weekLabel });
  }

  const buckets = new Map(); // objectiveId -> { items:[], perWeek:Map(weekStart->count) }
  const unresolvedByProject = {};
  const overrides = [];

  for (const r of reports || []) {
    for (const it of r.items || []) {
      const goal = resolveGoal(it, registry);
      if (!goal) {
        unresolvedByProject[it.project] = (unresolvedByProject[it.project] || 0) + 1;
        continue;
      }
      if (goal.via === 'objectiveId' && !(registry.projectToObjective || {})[it.project]) {
        overrides.push(`${it.id} (${it.project}, ${r.weekStart}) -> ${goal.id}`);
      }
      if (!buckets.has(goal.id)) buckets.set(goal.id, { items: [], perWeek: new Map() });
      const b = buckets.get(goal.id);
      b.items.push({
        id: it.id,
        project: it.project,
        status: it.status,
        date: it.date,
        dateLabel: it.dateLabel,
        tier: it.tier,
        title: it.title,
        summary: it.summary || '',
        weekStart: r.weekStart,
        weekLabel: r.weekLabel,
        // Standalone in-file anchor: the latest week's items live on the report
        // page; older weeks have no per-week archive page, so they render unlinked.
        href: r.latest && it.id != null ? `${reportHref}#${it.id}` : null,
      });
      b.perWeek.set(r.weekStart, (b.perWeek.get(r.weekStart) || 0) + 1);
    }
  }

  const groups = [];
  for (const group of registry.groups || []) {
    const goals = [];
    for (const [oid, entry] of Object.entries(registry.objectives || {})) {
      if (entry.publicGroup !== group) continue;
      const b = buckets.get(oid);
      const items = b ? [...b.items].sort(byDateDesc) : [];
      const perWeek = weeksAsc.map((w) => ({
        weekStart: w.weekStart,
        weekLabel: w.weekLabel,
        count: b ? b.perWeek.get(w.weekStart) || 0 : 0,
      }));
      const statusCounts = {};
      for (const it of items) {
        if (it.status) statusCounts[it.status] = (statusCounts[it.status] || 0) + 1;
      }
      goals.push({
        objectiveId: oid,
        label: entry.publicLabel,
        group,
        kind: KINDS.has(entry.kind) ? entry.kind : null,
        what: typeof entry.what === 'string' ? entry.what : null,
        why: typeof entry.why === 'string' ? entry.why : null,
        how: typeof entry.how === 'string' ? entry.how : null,
        howType: HOW_TYPES.has(entry.howType) ? entry.howType : null,
        entries: items.length,
        weeksActive: perWeek.filter((w) => w.count > 0).length,
        lastActivity: items.reduce((m, it) => (it.date && it.date > m ? it.date : m), '') || null,
        statusCounts,
        perWeek,
        provenance: provByGoal.get(oid) || null,
        items,
      });
    }
    groups.push({ group, goals });
  }

  const allGoals = groups.flatMap((g) => g.goals);
  const totals = {
    goals: allGoals.length,
    activeGoals: allGoals.filter((g) => g.entries > 0).length,
    entries: allGoals.reduce((s, g) => s + g.entries, 0),
    weeksTracked: weeksAsc.length,
  };
  return { groups, weeks: weeksAsc, totals, unresolvedByProject, overrides, changes };
}

/**
 * Pure validator for honestweek.objectives.json. Generic publish gate: structural
 * validity + label/prose safety, WITHOUT any fixed objective-id form or a house
 * no-em-dash voice rule.
 *
 * Asserts: groups is a non-empty array of non-empty strings; objectives is an
 * object; every id is an anchor-safe slug; each entry has a non-empty publicLabel
 * and a publicGroup in groups; kind (when present) is "continuous"|"finite";
 * howType (when present) is "sessions"|"mined"|"planned"; what/why/how (when
 * present) are non-empty strings; the redactor leaves every label + prose
 * unchanged (no configured private term smuggled in); every projectToObjective
 * VALUE resolves to an objective. A projectToObjective KEY that is not a known
 * repo label is a WARNING (a permanent mapping may sit out a quiet week).
 *
 * @param {{registry, projectLabels?:Set<string>|string[], redactor?:{redact:(s)=>string}}} args
 * @returns {{errors:string[], warnings:string[]}}
 */
export function validateObjectives({ registry, projectLabels, redactor } = {}) {
  const errors = [];
  const warnings = [];

  if (!registry || typeof registry !== 'object') {
    errors.push('registry is not an object');
    return { errors, warnings };
  }
  if (registry.schemaVersion == null) warnings.push('registry has no schemaVersion');

  const groups = registry.groups;
  if (!Array.isArray(groups) || groups.length === 0 || !groups.every((g) => typeof g === 'string' && g.trim())) {
    errors.push('registry.groups must be a non-empty array of non-empty strings');
  }
  const groupSet = new Set(Array.isArray(groups) ? groups : []);

  const objectives = registry.objectives;
  if (!objectives || typeof objectives !== 'object') {
    errors.push('registry.objectives must be an object');
    return { errors, warnings };
  }

  const checkStable = (where, text) => {
    if (redactor && typeof redactor.redact === 'function' && redactor.redact(text) !== text) {
      errors.push(`objective ${where} is altered by the redactor (contains a configured private term): ${JSON.stringify(text)}`);
    }
  };

  for (const [id, entry] of Object.entries(objectives)) {
    if (!ID_RE.test(id)) errors.push(`objective id "${id}" must be an anchor-safe slug matching ${ID_RE}`);

    const label = entry && entry.publicLabel;
    if (typeof label !== 'string' || !label.trim()) {
      errors.push(`objective "${id}" has an empty or non-string publicLabel`);
    } else {
      checkStable(`"${id}" label`, label);
    }

    for (const field of ['what', 'why', 'how']) {
      const text = entry && entry[field];
      if (text == null) continue;
      if (typeof text !== 'string' || !text.trim()) {
        errors.push(`objective "${id}" ${field} is present but not a non-empty string`);
        continue;
      }
      checkStable(`"${id}" ${field}`, text);
    }

    if (entry && entry.howType != null && !HOW_TYPES.has(entry.howType)) {
      errors.push(`objective "${id}" howType ${JSON.stringify(entry.howType)} must be "sessions", "mined", or "planned"`);
    }
    if (entry && entry.kind != null && !KINDS.has(entry.kind)) {
      errors.push(`objective "${id}" kind ${JSON.stringify(entry.kind)} must be "continuous" or "finite"`);
    }

    const group = entry && entry.publicGroup;
    if (!groupSet.has(group)) {
      errors.push(`objective "${id}" publicGroup ${JSON.stringify(group)} is not one of registry.groups`);
    }
  }

  const known = projectLabels instanceof Set ? projectLabels : new Set(projectLabels || []);
  const map = registry.projectToObjective || {};
  for (const [key, val] of Object.entries(map)) {
    if (known.size && !known.has(key)) {
      warnings.push(`projectToObjective key "${key}" is not a configured repo label (it will simply never resolve)`);
    }
    if (!objectives[val]) {
      errors.push(`projectToObjective["${key}"] -> "${val}" does not resolve to a registry objective`);
    }
  }

  return { errors, warnings };
}

/**
 * Pure validator for honestweek.goal-changelog.json (the optional "what changed"
 * band). Generic gate: structural validity + the live-ref rule that keeps the
 * band from rendering a blank label, WITHOUT any fixed id form or voice rule.
 *
 * The load-bearing rules:
 *   - a retire/split/merge parent id MUST be ABSENT from objectives (a frozen,
 *     inline label is carried for it); a relabel parent id MUST still resolve
 *     (same goal, new label);
 *   - every `to`/`published` id MUST resolve to a live objective (its label is
 *     read live, so it cannot dangle);
 *   - per-type arity sanity (split >=2 children, merge >=2 parents, etc.).
 *
 * @param {{changelog, registry, redactor?:{redact:(s)=>string}}} args
 * @returns {{errors:string[], warnings:string[]}}
 */
export function validateChangelog({ changelog, registry, redactor } = {}) {
  const errors = [];
  const warnings = [];
  if (!changelog || typeof changelog !== 'object') {
    errors.push('changelog is not an object');
    return { errors, warnings };
  }
  const changes = changelog.changes;
  if (changes === undefined) {
    warnings.push('changelog has no changes array (nothing to render)');
    return { errors, warnings };
  }
  if (!Array.isArray(changes)) {
    errors.push('changelog.changes must be an array');
    return { errors, warnings };
  }

  const objectives = (registry && registry.objectives) || {};
  const seenIds = new Set();
  const gateStr = (where, s) => {
    if (typeof s !== 'string' || !s.trim()) {
      errors.push(`change ${where} is empty or not a string`);
      return;
    }
    if (redactor && typeof redactor.redact === 'function' && redactor.redact(s) !== s) {
      errors.push(`change ${where} is altered by the redactor (contains a configured private term): ${JSON.stringify(s)}`);
    }
  };

  for (const c of changes) {
    if (!c || typeof c !== 'object') {
      errors.push('a change entry is not an object');
      continue;
    }
    const cid = typeof c.id === 'string' && c.id ? c.id : '(no id)';
    if (typeof c.id !== 'string' || !SLUG_RE.test(c.id)) {
      errors.push(`change "${cid}" id must be a lowercase slug matching ${SLUG_RE}`);
    } else if (seenIds.has(c.id)) {
      errors.push(`change "${cid}" id is duplicated`);
    } else {
      seenIds.add(c.id);
    }
    if (typeof c.week !== 'string' || !WEEK_RE.test(c.week)) {
      errors.push(`change "${cid}" week must be an ISO date (YYYY-MM-DD)`);
    }
    if (!CHANGE_TYPES.has(c.type)) {
      errors.push(`change "${cid}" type ${JSON.stringify(c.type)} must be one of ${[...CHANGE_TYPES].join(', ')}`);
    }
    gateStr(`"${cid}" note`, c.note);

    const from = c.from || [];
    const to = c.to || [];
    const published = c.published || [];
    if (!Array.isArray(from) || !Array.isArray(to) || !Array.isArray(published)) {
      errors.push(`change "${cid}" from/to/published must be arrays`);
      continue;
    }

    for (const f of from) {
      if (!f || !ID_RE.test(f.id || '')) {
        errors.push(`change "${cid}" from id ${JSON.stringify(f && f.id)} is not an anchor-safe slug`);
        continue;
      }
      if (c.type === 'retire' || c.type === 'split' || c.type === 'merge') {
        if (objectives[f.id]) {
          errors.push(`change "${cid}" ${c.type} parent ${f.id} STILL appears in objectives -- a retired/split/merged goal must be absent from the registry`);
        }
        gateStr(`"${cid}" from[].label for ${f.id}`, f.label);
      } else if (c.type === 'relabel') {
        if (!objectives[f.id]) errors.push(`change "${cid}" relabel parent ${f.id} must still resolve in objectives (same id, new label)`);
        gateStr(`"${cid}" from[].label for ${f.id}`, f.label);
      }
    }

    const seenRefIds = new Set();
    for (const t of [...to, ...published]) {
      if (!t || !ID_RE.test(t.id || '')) {
        errors.push(`change "${cid}" to/published id ${JSON.stringify(t && t.id)} is not an anchor-safe slug`);
        continue;
      }
      if (seenRefIds.has(t.id)) errors.push(`change "${cid}" references ${t.id} more than once in to/published`);
      seenRefIds.add(t.id);
      if (!objectives[t.id]) {
        errors.push(`change "${cid}" to/published id ${t.id} does not resolve to a live registry objective (its label is read live, so it cannot dangle)`);
      }
    }

    if (c.type === 'split' && (from.length < 1 || to.length < 2)) errors.push(`change "${cid}" split needs >=1 from and >=2 to`);
    if (c.type === 'retire' && (from.length < 1 || to.length > 0)) errors.push(`change "${cid}" retire needs >=1 from and no to`);
    if (c.type === 'relabel' && (from.length !== 1 || to.length !== 1)) errors.push(`change "${cid}" relabel needs exactly 1 from and 1 to`);
    if (c.type === 'merge' && (from.length < 2 || to.length !== 1)) errors.push(`change "${cid}" merge needs >=2 from and exactly 1 to`);
    if (c.type === 'add' && to.length + published.length < 1) errors.push(`change "${cid}" add needs at least 1 to or published`);

    if (c.type === 'relabel' && from.length === 1 && to.length === 1 && from[0] && to[0] && from[0].id !== to[0].id) {
      errors.push(`change "${cid}" relabel must keep the same id (from ${from[0].id} != to ${to[0].id})`);
    }
  }

  return { errors, warnings };
}

/**
 * buildReportsFromSnapshots({ currentWeek, currentModel, archived }) -> reports[]
 *
 * Shape the cross-week `reports[]` aggregateGoals expects from honestweek's own
 * sources: the current week's freshly-built (redacted) page model PLUS any
 * archived week snapshots (lib/archive.mjs writes `{ week, mode, report }`). Each
 * report carries that week's items with `project` set to the repo label (page
 * mode groups by repo) and `latest` true only for the newest week.
 *
 * The current week is authoritative for its own weekStart: an archived snapshot
 * for the same week (from a prior run) is dropped in favor of the fresh model,
 * so a re-run never double-counts.
 */
export function buildReportsFromSnapshots({ currentWeek, currentModel, archived = [] } = {}) {
  const flatten = (model) =>
    (Array.isArray(model?.groups) ? model.groups : []).flatMap((g) =>
      (Array.isArray(g.items) ? g.items : []).map((it) => ({
        id: it.id ?? null,
        project: g.label,
        status: it.status,
        date: it.date ?? null,
        dateLabel: it.dateLabel ?? null,
        tier: it.tier ?? null,
        title: it.title ?? '',
        summary: it.summary ?? '',
        objectiveId: it.objectiveId ?? undefined,
      }))
    );

  const byWeek = new Map();
  for (const snap of archived) {
    const ws = snap?.week?.start;
    if (!ws || ws === currentWeek?.start) continue; // current week comes from the fresh model
    byWeek.set(ws, {
      weekStart: ws,
      weekLabel: weekRangeLabel(snap.week.start, snap.week.end),
      items: flatten(snap.report),
    });
  }
  byWeek.set(currentWeek.start, {
    weekStart: currentWeek.start,
    weekLabel: weekRangeLabel(currentWeek.start, currentWeek.end),
    items: flatten(currentModel),
  });

  const reports = [...byWeek.values()];
  const latestWeek = reports.reduce((m, r) => (r.weekStart > m ? r.weekStart : m), '');
  for (const r of reports) r.latest = r.weekStart === latestWeek;
  return reports;
}

/** A compact week-range label ("jun 10 - 16" / "jun 30 - jul 6"); mirrors the
 *  page emitter's weekRangeLabel so the two pages agree on week wording. */
function weekRangeLabel(start, end) {
  const [, sm, sd] = String(start).split('-').map(Number);
  const [, em, ed] = String(end).split('-').map(Number);
  if (!Number.isFinite(sm)) return `${start} - ${end}`;
  if (!Number.isFinite(em)) return `${MONTHS3[sm - 1]} ${sd}`;
  return sm === em ? `${MONTHS3[sm - 1]} ${sd} - ${ed}` : `${MONTHS3[sm - 1]} ${sd} - ${MONTHS3[em - 1]} ${ed}`;
}
