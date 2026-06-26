// lib/emit/goals-page.mjs — the standalone `goals.html` page (page mode's optional
// second page, emitted beside report.html when a honestweek.objectives.json
// registry is present).
//
// It renders the aggregated goal lens (lib/goals.mjs) into ONE self-
// contained HTML document in the SAME dark-console design as lib/emit/page.mjs:
// the look is ported from brycewatson.com's src/pages/goals.astro, recolored to
// the page-mode palette and made standalone — inline CSS + inline JS + system
// fonts, ZERO external resources, so `preview` can serve it under a no-egress CSP.
//
// Honesty posture (identical to page mode): every NUMBER (goal/area counts,
// per-week item counts, status counts) is honestweek's OWN aggregation of
// already-verified report snapshots; every dynamic STRING is HTML-escaped by
// esc() before it reaches the document, so curated prose can never inject markup.
//
// Zero runtime dependencies: pure render, no I/O (build owns the write).

import { esc } from './page.mjs';

const MONTHS_CAP = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const KIND_LABEL = { continuous: 'ongoing', finite: 'milestone' };
// How a goal entered the set (links to the "what changed" band). Wording is the
// stable relationship, not novelty.
const PROV_LABEL = {
  'split-child': 'from a split',
  'merge-child': 'from a merge',
  relabeled: 'relabeled',
  added: 'new goal',
  published: 'newly public',
};
const CHANGE_VERB = { split: 'Split', merge: 'Merged', retire: 'Retired', relabel: 'Relabeled', add: 'Added' };

/** Format an ISO timestamp as "26 Jun 2026" without Date (no tz drift). */
function formatDate(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  return m && d ? `${d} ${MONTHS_CAP[m - 1]} ${y}` : String(iso || '');
}

// Activity signal, kept DISTINCT from the work mix (health is not progress). A
// worked goal is "active" if it logged work in the most recent tracked week,
// "resting" if only in older weeks; a goal with no work is "underway".
function activity(goal) {
  if (goal.entries === 0) return { cls: 'is-underway', label: 'underway' };
  const last = goal.perWeek[goal.perWeek.length - 1];
  return last && last.count > 0 ? { cls: 'is-active', label: 'active' } : { cls: 'is-resting', label: 'resting' };
}

// Per-goal activity over time: a curated ITEM COUNT per week, bucketed in 3
// discrete intensity steps (never height-scaled, never an interpolated line) so
// a cell can't read as effort or imply a trend at low N.
function bucket(count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return 3;
}
function sparkAria(goal) {
  if (goal.entries === 0) return 'No work logged yet.';
  const parts = goal.perWeek.map((w) => `${w.count} ${w.count === 1 ? 'item' : 'items'} the week of ${w.weekLabel}`);
  return `Curated items per week: ${parts.join('; ')}.`;
}

/**
 * buildGoalsModel({ agg, registry, generatedAt, generator }) -> render model.
 *
 * Shapes the aggregateGoals output (lib/goals.mjs) plus the registry's
 * optional page copy + group descriptions into the model render() consumes. Pure;
 * every number flows straight from `agg` (honestweek's own aggregation).
 */
export function buildGoalsModel({ agg, registry = {}, generatedAt = '', generator = 'honestweek (page mode)', reportHref = 'report.html' } = {}) {
  const groupDescriptions = (registry && registry.groupDescriptions) || {};
  const groups = (agg.groups || []).map((g) => ({
    group: g.group,
    goals: g.goals,
    description: groupDescriptions[g.group] || null,
  }));
  const areaCount = groups.filter((g) => g.goals.length > 0).length;
  const recentProof = groups
    .flatMap((g) => g.goals)
    .flatMap((g) => g.items)
    .filter((it) => it.status === 'shipped' && it.date)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 4);

  const page = (registry && registry.page) || {};
  return {
    eyebrow: typeof page.eyebrow === 'string' ? page.eyebrow : 'honestweek / goals',
    title: typeof page.title === 'string' ? page.title : 'My goals, and the work behind them.',
    lede:
      typeof page.lede === 'string'
        ? page.lede
        : 'The goals below are the outcomes I am driving toward, grouped by area, each with the verified work behind it.',
    note:
      typeof page.note === 'string'
        ? page.note
        : 'Each goal carries what done looks like, why it matters, and how the work gets done, grounded in real weekly work or, where there is no history yet, a plain forward plan.',
    reportHref,
    meta: {
      goals: agg.totals?.goals ?? 0,
      areaCount,
      weeksTracked: agg.totals?.weeksTracked ?? 0,
      updated: formatDate(generatedAt),
      generator,
    },
    groups,
    changes: agg.changes || [],
    recentProof,
  };
}

// --- inline section renderers (esc() on EVERY dynamic string) ---------------

function renderSpark(goal) {
  if (!goal.perWeek || goal.perWeek.length === 0) return '';
  const cells = goal.perWeek
    .map(
      (w, i) =>
        `<span class="g-spark-cell lvl-${bucket(w.count)}${i === goal.perWeek.length - 1 ? ' is-newest' : ''}" title="${esc(`${w.count} ${w.count === 1 ? 'item' : 'items'} · week of ${w.weekLabel}`)}"></span>`
    )
    .join('');
  const cap = goal.entries > 0 ? 'items / wk' : 'no work yet';
  return `<div class="g-spark" role="img" aria-label="${esc(sparkAria(goal))}"><span class="g-spark-cells" aria-hidden="true">${cells}</span><span class="g-spark-cap g-mono" aria-hidden="true">${esc(cap)}</span></div>`;
}

function renderSessions(goal) {
  if (!goal.items || goal.items.length === 0) return '';
  const rows = goal.items
    .map((it) => {
      const title = esc(it.title || '');
      const date = esc(it.dateLabel || '');
      const inner = `<span class="g-session-title">${title}</span><span class="g-session-date g-mono">${date}</span>`;
      // The latest week's items deep-link to report.html#<id>; older weeks have no
      // archive page, so they render as a non-link row.
      const body = it.href ? `<a class="g-session" href="${esc(it.href)}">${inner}</a>` : `<span class="g-session is-static">${inner}</span>`;
      return `<li class="g-session-li">${body}</li>`;
    })
    .join('');
  const n = goal.items.length;
  return `<details class="g-sessions"><summary class="g-sessions-sum g-mono"><span class="g-sessions-chev" aria-hidden="true">&#9656;</span><span>${n} ${n === 1 ? 'entry' : 'entries'} behind this</span></summary><ul class="g-sessions-list">${rows}</ul></details>`;
}

function renderGoalCard(goal) {
  const act = activity(goal);
  const tags = [];
  if (goal.kind) tags.push(`<span class="g-kind is-${esc(goal.kind)}">${esc(KIND_LABEL[goal.kind] || goal.kind)}</span>`);
  if (goal.provenance) {
    tags.push(
      `<a class="g-prov g-mono" href="#changed-${esc(goal.provenance.changeId)}" title="What changed">${esc(PROV_LABEL[goal.provenance.state] || 'changed')}<span class="g-prov-arrow" aria-hidden="true">&nbsp;&rarr;</span></a>`
    );
  }
  tags.push(
    `<span class="g-activity"><span class="g-key-dot ${act.cls}" aria-hidden="true"></span><span class="g-activity-tag g-mono">${esc(act.label)}</span></span>`
  );

  const what = goal.what ? `<p class="g-goal-what">${esc(goal.what)}</p>` : '';
  const why = goal.why ? `<div class="g-wwh"><span class="g-wwh-label g-mono">why</span><p class="g-wwh-text">${esc(goal.why)}</p></div>` : '';
  const how = goal.how ? `<div class="g-wwh"><span class="g-wwh-label g-mono">how</span><p class="g-wwh-text">${esc(goal.how)}</p></div>` : '';

  return `<li class="g-goal-card g-reveal" id="goal-${esc(goal.objectiveId)}" style="scroll-margin-top:90px"><div class="g-goal-card-head"><h3 class="g-serif g-goal-card-label"><span class="g-goal-name">${esc(goal.label)}</span></h3><div class="g-goal-card-tags">${tags.join('')}</div>${renderSpark(goal)}</div>${what}${why}${how}${renderSessions(goal)}</li>`;
}

function renderGroupSection(group) {
  const active = group.goals.filter((g) => g.entries > 0);
  const quiet = group.goals.filter((g) => g.entries === 0);
  const n = group.goals.length;
  const teaser = group.description && group.description.teaser
    ? `<span class="g-area-teaser">${esc(group.description.teaser)}</span>`
    : '';
  let intro = '';
  if (group.description && (group.description.what || group.description.why)) {
    const what = group.description.what ? `<p class="g-area-what">${esc(group.description.what)}</p>` : '';
    const why = group.description.why
      ? `<div class="g-area-why"><span class="g-area-why-label g-mono">why</span><p class="g-area-why-text">${esc(group.description.why)}</p></div>`
      : '';
    intro = `<div class="g-area-intro">${what}${why}</div>`;
  }
  const cards = [...active, ...quiet].map(renderGoalCard).join('');
  return `<details class="g-section g-reveal"><summary class="g-area"><span class="g-area-chevron" aria-hidden="true">&#9656;</span><span class="g-area-head"><h2 class="g-serif g-area-name">${esc(group.group)}</h2>${teaser}</span><span class="g-area-count g-mono">${n} ${n === 1 ? 'goal' : 'goals'}</span></summary><div class="g-area-body">${intro}<p class="g-area-how g-mono">how <span class="g-dim">&middot; the ${n} ${n === 1 ? 'goal' : 'goals'} below</span></p><ul class="g-goals-grid">${cards}</ul></div></details>`;
}

function renderChangeBand(changes) {
  if (!changes || changes.length === 0) return '';
  const rows = changes
    .map((c) => {
      const from = c.from
        .map(
          (f) =>
            `<p class="g-change-from"><span class="g-change-tag is-retired g-mono">${esc(c.type === 'relabel' ? 'was' : 'retired')}</span><span class="g-change-retired-label">${esc(f.label)}</span></p>`
        )
        .join('');
      const toRows = c.to
        .map(
          (t) =>
            `<li><a class="g-change-to" href="${esc(t.href)}"><span class="g-change-arrow" aria-hidden="true">&rarr;</span><span class="g-change-child-label">${esc(t.label || t.id)}</span></a></li>`
        )
        .join('');
      const pubRows = c.published
        .map(
          (p) =>
            `<li><a class="g-change-to" href="${esc(p.href)}"><span class="g-change-tag is-pub g-mono">published</span><span class="g-change-child-label">${esc(p.label || p.id)}</span></a></li>`
        )
        .join('');
      const toList = c.to.length > 0 || c.published.length > 0 ? `<ul class="g-change-to-list">${toRows}${pubRows}</ul>` : '';
      return `<div class="g-change" id="changed-${esc(c.id)}" style="scroll-margin-top:90px"><p class="g-change-meta g-mono"><span class="g-change-verb">${esc(CHANGE_VERB[c.type] || 'Changed')}</span> &middot; week of ${esc(c.weekLabel)}</p><p class="g-change-note">${esc(c.note)}</p><div class="g-change-lineage">${from}${toList}</div></div>`;
    })
    .join('');
  const n = changes.length;
  return `<details class="g-section g-changed g-reveal" open><summary class="g-changed-sum"><span class="g-changed-chev" aria-hidden="true">&#9656;</span><span class="g-changed-head"><h2 class="g-serif g-changed-title">What changed</h2><span class="g-changed-teaser">How the goal set itself has shifted, most recent first.</span></span><span class="g-changed-count g-mono">${n} ${n === 1 ? 'update' : 'updates'}</span></summary><div class="g-changed-body">${rows}</div></details>`;
}

function renderProofStrip(recentProof, reportHref = 'report.html') {
  if (!recentProof || recentProof.length === 0) return '';
  const rows = recentProof
    .map((it) => {
      const inner = `<span class="g-proofstrip-title">${esc(it.title || '')}</span><span class="g-proofstrip-date g-mono">${esc(it.dateLabel || '')}</span>`;
      const body = it.href
        ? `<a class="g-proofstrip-item" href="${esc(it.href)}">${inner}</a>`
        : `<span class="g-proofstrip-item is-static">${inner}</span>`;
      return `<li>${body}</li>`;
    })
    .join('');
  return `<div class="g-proofstrip g-reveal"><p class="g-proofstrip-cap g-mono">recently shipped</p><ul class="g-proofstrip-list">${rows}</ul><a class="g-proofstrip-more g-mono" href="${esc(reportHref)}">all verified work, this week <span aria-hidden="true">&rarr;</span></a></div>`;
}

const STYLE = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#050507;color:#a8a79d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;padding:28px 16px 64px}
.g-shell{--ink:#f4f3ed;--ink2:#c7c6bc;--body:#a8a79d;--mute:#8a8979;--mute2:#75746a;--link:#c8f751;--gedge:rgba(200,247,81,.5);--halo:rgba(200,247,81,.06);--hair:rgba(236,235,230,.1);--gcard:#0b0b0f;--gcard2:#0e0e13;--gline:rgba(236,235,230,.12);--bsh:#aad24a;--bpr:#f2b84b;--spark1:rgba(200,247,81,.28);--spark2:rgba(200,247,81,.55);
max-width:880px;margin:0 auto;color:var(--body)}
.g-serif{font-family:Fraunces,Georgia,"Times New Roman",serif}
.g-mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.g-dim{color:var(--mute)}
.g-hero{padding:4px 0 24px;border-bottom:.5px solid var(--hair);margin-bottom:8px}
.g-eyebrow{font-size:11.5px;color:var(--ink);margin:0 0 14px;letter-spacing:.02em}
.g-title{margin:0;font-weight:600;letter-spacing:-.015em;color:var(--ink);font-size:clamp(26px,4.4vw,38px);line-height:1.08;max-width:22ch}
.g-lede{margin:16px 0 0;max-width:62ch;font-size:15px;line-height:1.62;color:var(--ink2)}
.g-updated{margin:16px 0 0;font-size:10.5px;color:var(--mute);letter-spacing:.02em}
.g-note{margin:9px 0 0;font-size:12px;line-height:1.5;color:var(--mute);max-width:60ch}
.g-section{margin-top:14px}
.g-area{display:flex;align-items:center;gap:13px;cursor:pointer;list-style:none;padding:14px 17px;border:.5px solid var(--gline);border-left:2px solid var(--gedge);border-radius:12px;background:var(--gcard);transition:border-color .16s ease}
.g-area::-webkit-details-marker{display:none}
.g-area:hover{border-color:var(--gedge)}
.g-area-chevron{flex:none;display:inline-block;font-size:14px;line-height:1;color:var(--link);transform:rotate(90deg);transition:transform .2s ease}
.g-section:not([open]) .g-area-chevron{transform:rotate(0)}
.g-area-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;min-width:0}
.g-area-name{margin:0;font-size:13px;font-weight:500;color:var(--link);text-transform:uppercase;letter-spacing:.14em}
.g-area-teaser{font-size:12.5px;color:var(--mute);line-height:1.4}
.g-section[open] .g-area-teaser{display:none}
.g-area-count{margin-left:auto;flex:none;font-size:10.5px;color:var(--mute);white-space:nowrap}
.g-area-body{padding:18px 3px 4px}
.g-area-intro{display:flex;flex-direction:column;gap:13px;max-width:66ch;margin-bottom:20px}
.g-area-what{margin:0;font-size:14.5px;line-height:1.6;color:var(--ink)}
.g-area-why{display:flex;flex-direction:column;gap:5px}
.g-area-why-label{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:var(--link)}
.g-area-why-text{margin:0;font-size:13.5px;line-height:1.6;color:var(--ink2)}
.g-area-how{margin:0 0 12px;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--mute)}
.g-goals-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,1fr);gap:12px;align-items:start}
.g-goal-card{display:flex;flex-direction:column;gap:13px;background:var(--gcard);border:.5px solid var(--gline);border-left:2px solid var(--gedge);border-radius:12px;padding:17px 19px}
.g-goal-card:target{box-shadow:0 0 0 2px var(--gedge)}
.g-goal-card-head{display:flex;flex-direction:column;gap:9px}
.g-goal-card-label{margin:0;font-size:16px;line-height:1.3;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.g-goal-card-tags{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.g-kind{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:9px;text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border-radius:999px;border:.5px solid var(--gline);color:var(--mute)}
.g-kind.is-finite{color:var(--link);border-color:var(--gedge)}
.g-activity{display:inline-flex;align-items:center;gap:6px}
.g-activity-tag{font-size:9px;color:var(--mute);letter-spacing:.08em;text-transform:uppercase}
.g-key-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;background:var(--mute)}
.g-key-dot.is-active{background:var(--bsh)}
.g-key-dot.is-resting{background:var(--mute)}
.g-key-dot.is-underway{background:var(--bpr)}
.g-prov{font-size:9px;text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border-radius:999px;text-decoration:none;border:.5px solid var(--gedge);color:var(--link);transition:background .14s ease}
.g-prov:hover{background:var(--halo)}
.g-prov-arrow{opacity:.7}
.g-spark{display:flex;align-items:center;gap:8px;margin-top:2px}
.g-spark-cells{display:inline-flex;align-items:center;gap:3px}
.g-spark-cell{width:8px;height:8px;border-radius:2px;flex:none;background:transparent;border:1px solid var(--gline);box-sizing:border-box}
.g-spark-cell.lvl-1{background:var(--spark1);border-color:transparent}
.g-spark-cell.lvl-2{background:var(--spark2);border-color:transparent}
.g-spark-cell.lvl-3{background:var(--bsh);border-color:transparent}
.g-spark-cell.is-newest{box-shadow:0 0 0 1.5px var(--link)}
.g-spark-cap{font-size:8.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);white-space:nowrap}
.g-goal-what{margin:0;font-size:14px;line-height:1.55;color:var(--ink2)}
.g-wwh{display:grid;grid-template-columns:30px 1fr;gap:11px;align-items:baseline}
.g-wwh-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--mute)}
.g-wwh-text{margin:0;font-size:12.5px;line-height:1.55;color:var(--mute)}
.g-sessions{margin-top:2px}
.g-sessions-sum{display:inline-flex;align-items:center;gap:6px;cursor:pointer;list-style:none;width:fit-content;font-size:10px;letter-spacing:.04em;color:var(--link);padding:4px 0}
.g-sessions-sum::-webkit-details-marker{display:none}
.g-sessions-sum:hover{text-decoration:underline}
.g-sessions-chev{font-size:9px;line-height:1;display:inline-block;transition:transform .18s ease}
.g-sessions[open] .g-sessions-chev{transform:rotate(90deg)}
.g-sessions-list{list-style:none;margin:5px 0 0;padding:0}
.g-session{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 0;border-top:.5px solid var(--hair);text-decoration:none}
.g-session-li:first-child .g-session{border-top:0}
.g-session-title{font-size:12px;line-height:1.4;color:var(--mute)}
a.g-session:hover .g-session-title{color:var(--link)}
.g-session-date{font-size:9.5px;color:var(--mute2);white-space:nowrap;flex:none}
.g-changed{margin-top:40px}
.g-changed-sum{display:flex;align-items:center;gap:13px;cursor:pointer;list-style:none;padding:14px 17px;border:.5px solid var(--gline);border-left:2px solid var(--gedge);border-radius:12px;background:var(--gcard);transition:border-color .16s ease}
.g-changed-sum::-webkit-details-marker{display:none}
.g-changed[open] .g-changed-sum{border-bottom-left-radius:0;border-bottom-right-radius:0}
.g-changed-sum:hover{border-color:var(--gedge)}
.g-changed-chev{flex:none;font-size:14px;line-height:1;color:var(--link);transform:rotate(90deg);transition:transform .2s ease}
.g-section:not([open]) .g-changed-chev{transform:rotate(0)}
.g-changed-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;min-width:0}
.g-changed-title{margin:0;font-size:13px;font-weight:500;color:var(--link);text-transform:uppercase;letter-spacing:.14em}
.g-changed-teaser{font-size:12.5px;color:var(--mute);line-height:1.4}
.g-section[open] .g-changed-teaser{display:none}
.g-changed-count{margin-left:auto;flex:none;font-size:10.5px;color:var(--mute);white-space:nowrap}
.g-changed-body{padding:18px;border:.5px solid var(--gline);border-top:0;border-radius:0 0 12px 12px;background:var(--gcard2)}
.g-change+.g-change{margin-top:16px;padding-top:16px;border-top:.5px solid var(--hair)}
.g-change:target{box-shadow:0 0 0 2px var(--gedge);border-radius:8px}
.g-change-meta{margin:0 0 7px;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--mute)}
.g-change-verb{color:var(--link)}
.g-change-note{margin:0 0 13px;font-size:14px;line-height:1.55;color:var(--ink2);max-width:64ch}
.g-change-lineage{display:flex;flex-direction:column;gap:9px}
.g-change-from{display:flex;align-items:baseline;gap:9px;margin:0}
.g-change-tag{flex:none;font-size:8.5px;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:999px;border:.5px solid var(--gline);color:var(--mute)}
.g-change-tag.is-pub{color:var(--link);border-color:var(--gedge)}
.g-change-retired-label{font-size:13.5px;line-height:1.4;color:var(--mute);text-decoration:line-through;text-decoration-color:var(--gline)}
.g-change-to-list{list-style:none;margin:4px 0 0;padding:0 0 0 16px;display:flex;flex-direction:column;gap:7px}
.g-change-to{display:inline-flex;align-items:baseline;gap:8px;text-decoration:none}
.g-change-arrow{flex:none;color:var(--link);font-size:12px}
.g-change-child-label{font-size:13.5px;line-height:1.4;color:var(--ink2)}
.g-change-to:hover .g-change-child-label{color:var(--link)}
.g-proofstrip{margin-top:44px;background:var(--gcard);border:.5px solid var(--gline);border-left:2px solid var(--gedge);border-radius:14px;padding:15px 18px 16px}
.g-proofstrip-cap{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:var(--mute);margin:0 0 4px}
.g-proofstrip-list{list-style:none;margin:0;padding:0}
.g-proofstrip-item{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:9px 0;border-top:.5px solid var(--hair);text-decoration:none}
.g-proofstrip-list li:first-child .g-proofstrip-item{border-top:0}
.g-proofstrip-title{font-size:13.5px;line-height:1.4;color:var(--ink2)}
a.g-proofstrip-item:hover .g-proofstrip-title{color:var(--link)}
.g-proofstrip-date{font-size:10px;color:var(--mute);white-space:nowrap;flex:none}
.g-proofstrip-more{display:inline-block;margin-top:11px;font-size:11px;color:var(--link);text-decoration:none}
.g-proofstrip-more:hover{text-decoration:underline}
.g-foot{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:48px;padding-top:22px;border-top:.5px solid var(--hair)}
.g-foot-link{display:flex;flex-direction:column;gap:4px;text-decoration:none;background:var(--gcard);border:.5px solid var(--gline);border-radius:12px;padding:16px 18px;transition:border-color .18s ease,transform .18s ease}
.g-foot-link:hover{border-color:var(--gedge);transform:translateY(-2px)}
.g-foot-cap{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--mute)}
.g-foot-line{font-size:13.5px;color:var(--ink2);line-height:1.4}
.g-foot-link:hover .g-foot-line{color:var(--link)}
.g-credit{margin:26px 0 0;font-size:10.5px;color:var(--mute2);line-height:1.5}
.js .g-reveal{opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s cubic-bezier(.22,1,.36,1)}
.js .g-reveal.is-in{opacity:1;transform:none}
@media (max-width:640px){.g-goals-grid{grid-template-columns:1fr}.g-foot{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.g-reveal,.js .g-reveal{opacity:1;transform:none;transition:none}.g-foot-link{transition:none}}`;

const SCRIPT = `(function(){
var io=null;
function init(){
 var shell=document.querySelector(".g-shell");if(!shell||shell.dataset.gInit==="1")return;shell.dataset.gInit="1";
 var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
 var reveals=shell.querySelectorAll(".g-reveal");
 if(reduce||!("IntersectionObserver" in window)){reveals.forEach(function(el){el.classList.add("is-in");});}
 else{io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("is-in");io.unobserve(e.target);}});},{rootMargin:"0px 0px -24px 0px",threshold:0});reveals.forEach(function(el){io.observe(el);});}
 shell.querySelectorAll("details.g-section").forEach(function(d){d.addEventListener("toggle",function(){if(d.open)d.querySelectorAll(".g-reveal").forEach(function(el){el.classList.add("is-in");});});});
 openFromHash();
}
function openFromHash(){
 if(!location.hash||location.hash.length<2)return;
 var el=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(!el)return;
 var sec=el.closest("details.g-section");if(sec&&!sec.open)sec.open=true;
 el.classList.add("is-in");
 requestAnimationFrame(function(){el.scrollIntoView({block:"center"});});
}
document.documentElement.classList.add("js");
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
window.addEventListener("hashchange",openFromHash);
})();`;

/** render(goalsModel) -> a complete, self-contained HTML document string. */
export function render(goalsModel) {
  const m = goalsModel || {};
  const meta = m.meta || {};
  const reportHref = m.reportHref || 'report.html';
  const withGoals = (m.groups || []).filter((g) => g.goals.length > 0);
  const sections = withGoals.map(renderGroupSection).join('');
  const areaWord = meta.areaCount === 1 ? 'area' : 'areas';
  const counts = `${esc(meta.goals)} goals across ${esc(meta.areaCount)} ${areaWord}${meta.updated ? ` · updated ${esc(meta.updated)}` : ''}`;

  const body = sections
    ? sections
    : `<p class="g-note">No goals are registered yet. Add objectives to honestweek.objectives.json to populate this page.</p>`;

  const title = `honestweek — goals`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="g-shell" aria-label="Goals">
<div class="g-hero g-reveal">
<p class="g-eyebrow g-mono">${esc(m.eyebrow || '')}</p>
<h1 class="g-serif g-title">${esc(m.title || '')}</h1>
<p class="g-lede">${esc(m.lede || '')}</p>
<p class="g-updated g-mono">${counts}</p>
<p class="g-note">${esc(m.note || '')}</p>
</div>
${body}
${renderChangeBand(m.changes)}
${renderProofStrip(m.recentProof, reportHref)}
<div class="g-foot g-reveal">
<a class="g-foot-link" href="${esc(reportHref)}"><span class="g-foot-cap g-mono">weekly report</span><span class="g-foot-line">By project, with the receipts <span aria-hidden="true">&rarr;</span></span></a>
</div>
<p class="g-credit g-mono">Built by honestweek. Every number on this page is honestweek's own aggregation of git-verified weekly reports; nothing here is published until you publish it.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
