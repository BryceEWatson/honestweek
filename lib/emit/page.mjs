// lib/emit/page.mjs — the `page` mode: a STANDALONE, self-contained, interactive
// HTML report. honestweek's default standalone "site": no target project, no
// framework, no external resources. It renders the SAME verified bundle the other
// emitters trust (verify-or-abort commits, git-derived chart + metrics, curated
// prose) into one HTML file using the brycewatson.com console design, baked in.
//
// Honesty model (identical posture to the markdown modes + site mode):
//   - every commit is verify-or-abort'd by build; the receipts shown here are the
//     git-derived shortSha + subject, never what the items file claimed;
//   - every NUMBER on the page (chart totals, per-project metrics) is honestweek's
//     OWN git derivation, not re-emitted from an untrusted source;
//   - curated STRINGS (title/summary/headline) are trusted, and EVERY dynamic
//     string is HTML-escaped before it reaches the document, so curated text can
//     never inject markup.
//
// Zero runtime dependencies: pure render, no I/O (the dispatcher owns the write).
// Zero external resources: inline CSS + inline JS + system fonts only, so the
// `preview` server can serve it under a no-egress CSP.

import { STATUSES } from '../badges.mjs';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WD = { sun: 'sun', mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat' };

// Legend colours mirror brycewatson.com's dark console (the design we adopted).
const LEGEND = [
  { key: 'shipped', label: 'shipped: built, merged, verified', color: '#c8f751' },
  { key: 'in progress', label: 'in progress', color: '#f2b84b' },
  { key: 'designed, not proven', label: 'designed, not proven: machinery exists, no real result yet', color: '#9fb0c0' },
];
const BADGE_CLASS = { shipped: 'is-shipped', 'in progress': 'is-progress', 'designed, not proven': 'is-designed' };

/** HTML-escape — runs on EVERY dynamic string, so curated prose can't inject markup. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function monthDay(ymd) {
  const [, m, d] = String(ymd).split('-').map(Number);
  return Number.isFinite(m) && Number.isFinite(d) ? `${MONTHS[m - 1]} ${d}` : String(ymd);
}
function weekRangeLabel(start, end) {
  const [, sm, sd] = String(start).split('-').map(Number);
  const [, em, ed] = String(end).split('-').map(Number);
  if (!Number.isFinite(sm)) return `${start} - ${end}`;
  return sm === em ? `${MONTHS[sm - 1]} ${sd} - ${ed}` : `${MONTHS[sm - 1]} ${sd} - ${MONTHS[em - 1]} ${ed}`;
}
/** A short title from a summary when an item carries none (first sentence/clause, capped). */
function deriveTitle(summary) {
  const s = String(summary ?? '').trim();
  if (!s) return 'Untitled entry';
  const sentence = s.split(/(?<=[.!?])\s/)[0];
  const t = sentence.length <= 72 ? sentence.replace(/[.]$/, '') : sentence.slice(0, 69).trimEnd() + '…';
  return t;
}

/**
 * buildPageModel({ items, config, verifiedIndex, week, chart, metricsByLabel, content })
 *   -> page model (pure; the numbers are honestweek's own derivation).
 * Groups the verified items by repo (featured first), enriching each with the
 * git-derived date + receipt (shortSha + subject). The lean assembleReportModel
 * drops title/date/subject, so page mode shapes its own richer view here.
 */
export function buildPageModel({ items = [], config = {}, verifiedIndex = new Map(), week = {}, chart = null, metricsByLabel = new Map(), content = null } = {}) {
  const roleByLabel = new Map((config.repos ?? []).map((r) => [r.label, r.role]));
  const groupsByLabel = new Map();
  const loose = [];

  for (const item of items) {
    const sha = item.primaryCommit || item.commit || (Array.isArray(item.commits) ? item.commits[0] : undefined) || null;
    const v = sha && verifiedIndex.has(sha) ? verifiedIndex.get(sha) : null;
    const status = STATUSES.includes(item.status) ? item.status : 'designed, not proven';
    const summary = item.summary ?? item.text ?? '';
    const date = v ? String(v.dateISO).slice(0, 10) : item.date ?? null;
    const view = {
      status,
      title: item.title && String(item.title).trim() ? item.title : deriveTitle(summary),
      summary,
      date,
      dateLabel: date ? monthDay(date) : null,
      tier: item.tier === 'routine' ? 'routine' : 'headline',
      receipt: v ? { shortSha: v.shortSha, subject: v.subject } : null,
    };
    const label = item.repo;
    if (label && roleByLabel.has(label)) {
      if (!groupsByLabel.has(label)) groupsByLabel.set(label, { label, role: roleByLabel.get(label), items: [] });
      groupsByLabel.get(label).items.push(view);
    } else {
      loose.push(view);
    }
  }
  if (loose.length) groupsByLabel.set('other', { label: 'other', role: 'reference', items: loose });

  const roleRank = { featured: 0, reference: 1, display: 2 };
  const groups = [...groupsByLabel.values()]
    .map((g) => {
      const git = metricsByLabel.get(g.label) || null;
      // items most-recent-first
      g.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      return {
        label: g.label,
        metrics: {
          entries: g.items.length,
          commits: git ? git.commits : null,
          activeDays: git ? git.activeDays : null,
        },
        mostRecent: g.items[0]?.date || '',
        items: g.items,
      };
    })
    .sort((a, b) => String(b.mostRecent).localeCompare(String(a.mostRecent)));

  const present = new Set(groups.flatMap((g) => g.items.map((i) => i.status)));
  return {
    week: { start: week.start, end: week.end },
    weekLabel: weekRangeLabel(week.start, week.end),
    headline: (content && content.headline) || 'What I shipped this week.',
    legend: LEGEND.filter((l) => present.has(l.key)),
    chart: chart || { metric: 'commits', max: 0, days: [], windowDays: 7 },
    groups,
    provenance: {
      itemsTotal: items.length,
      commitsVerified: groups.reduce((n, g) => n + g.items.filter((i) => i.receipt).length, 0),
    },
  };
}

// --- chart bars (mirrors brycewatson's hero math) ---
function chartBars(chart) {
  const days = Array.isArray(chart.days) ? chart.days : [];
  const max = Math.max(1, chart.max || 0);
  const n = days.length || 1;
  return days.map((d, i) => {
    const split = d.byRepo || d.byProject || {};
    const breakdown = Object.entries(split)
      .sort((a, b) => (a[0] === 'other' ? 1 : b[0] === 'other' ? -1 : b[1] - a[1]))
      .map(([r, c]) => `${r} ${c}`)
      .join(', ');
    const head = `${WD[d.weekday] || d.weekday} ${monthDay(d.date)}`;
    const label = d.total === 0 ? `${head}: no commits` : `${head}: ${d.total} commit${d.total === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}`;
    return {
      pct: Math.round((d.total / max) * 100),
      alpha: (0.34 + (i / Math.max(1, n - 1)) * 0.5).toFixed(3),
      weekday: WD[d.weekday] || d.weekday,
      isWeekend: !!d.isWeekend,
      isToday: !!d.isToday,
      isZero: d.total === 0,
      date: d.date,
      dayLabel: head,
      label,
    };
  });
}

const STYLE = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#050507;color:#a8a79d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;padding:28px 16px 56px}
.wl-panel{--bg1:#0a0a0d;--bg2:#08080b;--pb:rgba(236,235,230,.12);--hair:rgba(236,235,230,.1);--hairs:rgba(236,235,230,.08);--ink:#f4f3ed;--ink2:#c7c6bc;--body:#a8a79d;--mute:#8a8979;--mute2:#75746a;--link:#c8f751;--barrgb:200,247,81;--bar:#c8f751;--cl:rgba(200,247,81,.16);--gbg:#0b0b0f;--ghbg:#0e0e13;--gedge:rgba(200,247,81,.5);--snip:#14141a;--snipe:rgba(236,235,230,.14);--bsh:#aad24a;--bshb:rgba(200,247,81,.22);--bpr:#f2b84b;--bprb:rgba(242,184,75,.45);--bds:#bcc9d6;--bdsb:rgba(159,176,192,.55);--bdsbg:rgba(159,176,192,.08);
width:100%;max-width:720px;margin:0 auto;background:var(--bg1);border:.5px solid var(--pb);border-radius:14px;overflow:hidden;box-shadow:0 24px 60px -28px rgba(0,0,0,.85);color:var(--body)}
.wl-mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wl-serif{font-family:Fraunces,Georgia,"Times New Roman",serif}
.wl-dim{color:var(--mute)}
.wl-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:13px 22px;border-bottom:.5px solid var(--hairs)}
.wl-head-id{font-size:12px;color:var(--ink)}
.wl-head-week{font-size:12px;color:var(--ink2);white-space:nowrap}
.wl-hero{background:var(--bg2);padding:11px 0 9px}
.wl-hero-top{display:flex;align-items:baseline;justify-content:space-between;padding:0 22px 8px}
.wl-hero-cap{font-size:10.5px;color:var(--mute)}
.wl-hero-peak{font-size:10px;color:var(--mute2)}
.wl-chart{display:grid;align-items:end;height:84px;padding:0 22px;border-bottom:.5px solid var(--cl)}
.wl-col{height:100%;display:flex;align-items:flex-end;justify-content:center;cursor:pointer;outline:none;position:relative}
.wl-col:focus-visible{outline:2px solid var(--link);outline-offset:1px;border-radius:3px}
.wl-bar{width:60%;min-height:2px;background:rgba(var(--barrgb),var(--a,.6));border-radius:2px 2px 0 0;transition:background .18s ease}
.wl-bar.is-today{background:var(--bar);box-shadow:0 0 10px -1px rgba(200,247,81,.5)}
.wl-bar.is-zero{background:rgba(var(--barrgb),.14)}
.wl-col:hover .wl-bar,.wl-col:focus-visible .wl-bar{background:var(--bar)}
.wl-col.is-selected{background:rgba(var(--barrgb),.1);border-radius:4px 4px 0 0}
.wl-col.is-selected .wl-bar{background:var(--bar)}
.wl-days{display:grid;padding:5px 22px 8px}
.wl-day{font-size:10px;text-align:center;color:var(--mute)}
.wl-day.is-weekend{color:var(--mute2)}
.wl-day.is-selected{color:var(--link);font-weight:500}
.wl-readout{margin:0;padding:0 22px;font-size:10.5px;line-height:1.45;color:var(--mute);min-height:2.9em}
.wl-intro{background:var(--bg1);border-top:.5px solid var(--cl);padding:18px 22px 14px}
.wl-headline{margin:0;font-size:27px;line-height:1.05;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.wl-legend{list-style:none;margin:13px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 16px}
.wl-legend-item{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--mute)}
.wl-swatch{width:9px;height:9px;border-radius:2px;flex:none}
.wl-feed{padding:10px 22px 18px}
.wl-filter{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:6px 0 2px}
.wl-filter[hidden]{display:none}
.wl-filter-cap{text-transform:uppercase;letter-spacing:.06em;font-size:9px;color:var(--mute2)}
.wl-filter-days{display:flex;flex-wrap:wrap;gap:6px}
.wl-filter-chip{font-size:10px;padding:2px 8px;border:.5px solid var(--hair);border-radius:5px;background:rgba(var(--barrgb),.08);color:var(--ink2);cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-family:inherit}
.wl-filter-chip:hover{border-color:var(--link);color:var(--link)}
.wl-filter-clear{font-size:10px;color:var(--link);background:none;border:none;cursor:pointer;padding:2px 4px;text-decoration:underline;font-family:inherit}
.wl-feed-empty{margin:14px 2px 6px;font-size:12.5px;color:var(--mute);line-height:1.55}
.wl-feed-empty[hidden]{display:none}
.wl-hide{display:none!important}
.wl-group{margin-top:14px;border:.5px solid var(--hair);border-left:2px solid var(--gedge);border-radius:11px;overflow:hidden;background:var(--gbg)}
.wl-group:first-child{margin-top:6px}
.wl-group-head{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;padding:12px 14px;background:var(--ghbg);flex-wrap:wrap}
.wl-group-head::-webkit-details-marker{display:none}
.wl-group[open] .wl-group-head{border-bottom:.5px solid var(--hair)}
.wl-group-chevron{flex:none;font-size:13px;line-height:1;color:var(--link);transform:rotate(90deg);transition:transform .2s ease}
.wl-group:not([open]) .wl-group-chevron{transform:rotate(0)}
.wl-card-name{margin:0;display:inline-flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;font-size:13px;font-weight:500;color:var(--ink);letter-spacing:-.01em}
.wl-card-kind{color:var(--mute);font-weight:400}
.wl-group-metrics{flex:none;font-size:10.5px;color:var(--mute);white-space:nowrap}
.wl-group-items{padding:2px 14px 10px}
.wl-item{padding:14px 2px 15px 12px;border-top:.5px solid var(--hair);border-left:2px solid transparent}
.wl-group-items .wl-item:first-child{border-top:none;padding-top:8px}
.wl-item.is-spot{border-left-color:var(--gedge);background:linear-gradient(to right,rgba(var(--barrgb),.06),transparent 55%)}
.wl-item-meta{display:flex;align-items:center;gap:8px;margin-bottom:7px}
.wl-badge{font-size:10px;padding:1px 7px;border-radius:5px;white-space:nowrap;letter-spacing:.01em}
.wl-badge.is-shipped{color:var(--bsh);border:.5px solid var(--bshb)}
.wl-badge.is-progress{color:var(--bpr);border:.5px solid var(--bprb)}
.wl-badge.is-designed{color:var(--bds);border:.5px solid var(--bdsb);background:var(--bdsbg)}
.wl-date{font-size:10.5px;color:var(--mute);margin-left:auto}
.wl-title{margin:0 0 5px;font-size:17px;font-weight:600;line-height:1.28;color:var(--ink);letter-spacing:-.005em}
.wl-summary{margin:0;font-size:12.5px;color:var(--ink2);line-height:1.55}
.wl-dig{margin-top:9px}
.wl-dig summary{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--mute2);cursor:pointer;list-style:none;width:fit-content;padding:7px 4px;margin:-7px -4px;user-select:none}
.wl-dig summary::-webkit-details-marker{display:none}
.wl-dig[open] summary{color:var(--link)}
.wl-chev{transition:transform .18s ease;display:inline-block}
.wl-dig[open] .wl-chev{transform:rotate(90deg)}
.wl-snip{background:var(--snip);border:.5px solid var(--hair);border-left:2px solid var(--snipe);border-radius:7px;padding:8px 11px;margin-top:8px}
.wl-snipkind{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute2);margin-bottom:5px}
.wl-sniptext{font-size:11.5px;color:var(--ink2);word-break:break-word}
.wl-sniptext b{color:var(--link);font-weight:500}
.wl-foot{padding:12px 22px 16px;border-top:.5px solid var(--hairs);font-size:10.5px;color:var(--mute2);line-height:1.5}
.wl-empty{padding:22px;font-size:13px;color:var(--mute)}
@media (prefers-reduced-motion:reduce){.wl-bar,.wl-chev,.wl-group-chevron{transition:none}}`;

const SCRIPT = `(function(){
function init(){
 var cols=document.querySelectorAll(".wl-col");if(!cols.length)return;
 var panel=cols[0].closest(".wl-panel");if(!panel||panel.dataset.wlInit==="1")return;panel.dataset.wlInit="1";
 var readout=panel.querySelector(".wl-readout");var def=readout?(readout.getAttribute("data-default")||readout.textContent):"";
 function show(el){if(readout)readout.textContent=el.getAttribute("data-label");}
 function reset(){if(readout)readout.textContent=def;}
 var days=panel.querySelectorAll(".wl-day");var items=panel.querySelectorAll(".wl-item");var groups=panel.querySelectorAll(".wl-group");
 var filterBar=panel.querySelector(".wl-filter");var filterDays=panel.querySelector(".wl-filter-days");var clearBtn=panel.querySelector(".wl-filter-clear");var emptyMsg=panel.querySelector(".wl-feed-empty");
 var selected={};function count(){return Object.keys(selected).length;}
 function apply(){
  var filtering=count()>0;var anyVisible=false;
  items.forEach(function(it){var s=!filtering||!!selected[it.getAttribute("data-date")];it.classList.toggle("wl-hide",!s);if(s)anyVisible=true;});
  groups.forEach(function(g){var any=false;g.querySelectorAll(".wl-item").forEach(function(x){if(!x.classList.contains("wl-hide"))any=true;});g.classList.toggle("wl-hide",!any);g.open=filtering?any:false;});
  cols.forEach(function(c){var sel=!!selected[c.getAttribute("data-date")];c.classList.toggle("is-selected",sel);c.setAttribute("aria-pressed",sel?"true":"false");});
  days.forEach(function(dl){dl.classList.toggle("is-selected",!!selected[dl.getAttribute("data-date")]);});
  if(filterBar){filterBar.hidden=!filtering;if(filtering&&filterDays){filterDays.textContent="";cols.forEach(function(c){var d=c.getAttribute("data-date");if(!selected[d])return;var lbl=c.getAttribute("data-daylabel")||d;var chip=document.createElement("button");chip.type="button";chip.className="wl-filter-chip";chip.setAttribute("aria-label","Remove "+lbl);chip.appendChild(document.createTextNode(lbl+" "));var x=document.createElement("span");x.setAttribute("aria-hidden","true");x.textContent="\\u00d7";chip.appendChild(x);chip.addEventListener("click",function(){toggle(d);});filterDays.appendChild(chip);});}}
  if(emptyMsg)emptyMsg.hidden=!(filtering&&!anyVisible);
 }
 function toggle(d){if(!d)return;if(selected[d])delete selected[d];else selected[d]=true;apply();}
 cols.forEach(function(col){col.addEventListener("mouseenter",function(){show(col);});col.addEventListener("focus",function(){show(col);});col.addEventListener("blur",reset);col.addEventListener("click",function(){show(col);toggle(col.getAttribute("data-date"));});col.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();show(col);toggle(col.getAttribute("data-date"));}});});
 var chart=panel.querySelector(".wl-chart");if(chart)chart.addEventListener("mouseleave",reset);
 if(clearBtn)clearBtn.addEventListener("click",function(){selected={};apply();});
 apply();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();`;

/** render(pageModel, _config) -> a complete, self-contained HTML document string. */
export function render(pageModel, _config) {
  const m = pageModel || {};
  const bars = chartBars(m.chart || {});
  const totalHero = (m.chart?.days || []).reduce((s, d) => s + (d.total || 0), 0);
  const summary = `${totalHero} commits · peak ${m.chart?.max ?? 0}/day`;
  const cols = bars.length || 1;

  const legendHtml = (m.legend || [])
    .map((l) => `<li class="wl-legend-item"><span class="wl-swatch" style="background:${esc(l.color)}" aria-hidden="true"></span><span>${esc(l.label)}</span></li>`)
    .join('');

  const barsHtml = bars
    .map(
      (b) =>
        `<div class="wl-col${b.isToday ? ' is-today' : ''}" tabindex="0" role="button" aria-label="${esc(b.label)}. Click to filter the feed to this day." aria-pressed="false" data-label="${esc(b.label)}" data-date="${esc(b.date)}" data-daylabel="${esc(b.dayLabel)}"><div class="wl-bar${b.isZero ? ' is-zero' : ''}${b.isToday ? ' is-today' : ''}" style="height:${b.pct}%;${b.isToday ? '' : `--a:${b.alpha}`}"></div></div>`
    )
    .join('');
  const daysHtml = bars
    .map((b) => `<span class="wl-day${b.isWeekend ? ' is-weekend' : ''}" data-date="${esc(b.date)}">${esc(b.weekday)}</span>`)
    .join('');

  const groupsHtml = (m.groups || [])
    .map((g) => {
      const met = g.metrics || {};
      const parts = [];
      if (met.commits != null) parts.push(`${met.commits} commit${met.commits === 1 ? '' : 's'} this week`);
      if (met.activeDays) parts.push(`active ${met.activeDays}/${m.chart?.windowDays ?? 7} days`);
      parts.push(`${met.entries} ${met.entries === 1 ? 'entry' : 'entries'}`);
      const metricsStr = parts.join('  ·  ');
      const itemsHtml = g.items
        .map((it) => {
          const badge = BADGE_CLASS[it.status]
            ? `<span class="wl-badge wl-mono ${BADGE_CLASS[it.status]}">${esc(it.status)}</span>`
            : '';
          const drawer = it.receipt
            ? `<details class="wl-dig"><summary class="wl-mono"><span class="wl-chev" aria-hidden="true">&#9656;</span><span>evidence</span></summary><div class="wl-snip"><div class="wl-snipkind wl-mono">commit · git-verified</div><div class="wl-sniptext wl-mono"><b>${esc(it.receipt.shortSha)}</b>&nbsp;&nbsp;${esc(it.receipt.subject)}</div></div></details>`
            : '';
          return `<div class="wl-item${it.tier !== 'routine' ? ' is-spot' : ''}" data-date="${esc(it.date)}"><div class="wl-item-meta">${badge}<span class="wl-date wl-mono">${esc(it.dateLabel || '')}</span></div><h3 class="wl-serif wl-title">${esc(it.title)}</h3><p class="wl-summary">${esc(it.summary)}</p>${drawer}</div>`;
        })
        .join('');
      return `<details class="wl-group" aria-label="${esc(g.label)}"><summary class="wl-group-head"><span class="wl-group-chevron" aria-hidden="true">&#9656;</span><h2 class="wl-mono wl-card-name"><span class="wl-card-kind">Project:</span><span>${esc(g.label)}</span></h2><span class="wl-group-metrics wl-mono">${esc(metricsStr)}</span></summary><div class="wl-group-items">${itemsHtml}</div></details>`;
    })
    .join('');

  const feedInner = (m.groups || []).length
    ? `<div class="wl-filter wl-mono" hidden aria-live="polite"><span class="wl-filter-cap">filtered to</span><span class="wl-filter-days"></span><button type="button" class="wl-filter-clear">clear</button></div><p class="wl-feed-empty wl-mono" hidden>No entries for the selected day(s). The chart counts commits; not every day has a featured entry.</p>${groupsHtml}`
    : `<p class="wl-empty">No interactive coding sessions were found for this week.</p>`;

  const title = `honestweek — ${m.weekLabel || 'weekly report'}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<section class="wl-panel" aria-label="Weekly report">
<div class="wl-head"><span class="wl-mono wl-head-id">honestweek <span class="wl-dim">/ weekly report</span></span><span class="wl-mono wl-head-week"><span class="wl-dim">week of </span>${esc(m.weekLabel || '')}</span></div>
<section class="wl-hero" aria-label="Commits per day">
<div class="wl-hero-top"><span class="wl-mono wl-hero-cap">commits / day</span><span class="wl-mono wl-hero-peak">peak ${esc(m.chart?.max ?? 0)}</span></div>
<div class="wl-chart" role="group" aria-label="Daily commits. ${esc(summary)}." style="grid-template-columns:repeat(${cols},1fr)">${barsHtml}</div>
<div class="wl-days wl-mono" aria-hidden="true" style="grid-template-columns:repeat(${cols},1fr)">${daysHtml}</div>
<p class="wl-readout wl-mono" aria-live="polite" data-default="${esc(summary)}">${esc(summary)}</p>
</section>
<div class="wl-intro"><h1 class="wl-serif wl-headline">${esc(m.headline || '')}</h1><ul class="wl-legend wl-mono" aria-label="Status key">${legendHtml}</ul></div>
<div class="wl-feed">${feedInner}</div>
<div class="wl-foot"><span class="wl-mono" style="color:var(--mute)">honestweek build</span> &nbsp;Every line carries a status badge and a git receipt; every number is re-derived from git. Generated locally; nothing here is published until you publish it.</div>
</section>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
