// lib/emit/client.mjs — renders the `client` mode model (lib/client.mjs) as one
// self-contained HTML document meant to be handed to a client: a light, printable
// report (Save as PDF from any browser) of the work done over a period.
//
// Same guarantees as page mode: pure render, no I/O; inline CSS and JS, system
// fonts, zero external resources (links to the client's own pull requests are
// plain anchors, never loaded); every dynamic string passes esc(). Every number on
// the page comes from the model, which derives it from git.

import { esc } from './page.mjs';

function fmt(n) {
  return n == null ? '—' : Number(n).toLocaleString('en-US');
}
function plural(n, one, many = `${one}s`) {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

const STYLE = `:root{--ink:#17191c;--ink2:#3d4248;--mute:#6b7178;--rule:#e3e1dc;--rule2:#efede8;--paper:#fbfaf7;--card:#ffffff;--accent:#1d5c55;--accent2:#e7f0ee;--merged:#1f6b45;--mergedbg:#e6f2ea;--progress:#8a5a00;--progressbg:#fbf1dc;--designed:#4d5866;--designedbg:#eceff3;color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink2);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
.doc{max-width:880px;margin:0 auto;padding:40px 24px 64px}
.serif{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);border-bottom:1px solid var(--rule);padding-bottom:12px}
.print{font:inherit;letter-spacing:.04em;text-transform:none;font-size:13px;color:var(--accent);background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:5px 12px;cursor:pointer}
.print:hover{border-color:var(--accent)}
h1{margin:28px 0 10px;font-size:40px;line-height:1.1;font-weight:600;color:var(--ink);letter-spacing:-.01em}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px 24px;margin:18px 0 0;padding:0}
.meta div{margin:0}
.meta dt{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.meta dd{margin:2px 0 0;color:var(--ink);font-size:14px}
.lede{margin:34px 0 0;padding:26px 0 0;border-top:1px solid var(--rule)}
.headline{margin:0 0 14px;font-size:25px;line-height:1.3;font-weight:500;color:var(--ink)}
.lede p{margin:0 0 12px;max-width:68ch}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0 0}
.stat{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:16px 16px 14px}
.stat b{display:block;font-size:30px;line-height:1.1;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.stat span{display:block;margin-top:6px;font-size:13px;color:var(--mute);line-height:1.35}
.note{margin:10px 0 0;font-size:12.5px;color:var(--mute)}
section{margin:46px 0 0}
h2{margin:0 0 6px;font-size:26px;line-height:1.2;font-weight:600;color:var(--ink)}
.sub{margin:0 0 18px;color:var(--mute);font-size:14px}
.chart{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:18px 18px 10px}
.chart svg{display:block;width:100%;height:auto}
.chart .readout{margin:6px 0 0;font-size:12.5px;color:var(--mute);min-height:1.6em}
.chart rect.b{fill:var(--accent);opacity:.82}
.chart rect.b.zero{opacity:.18}
.chart g.col:hover rect.b,.chart g.col:focus rect.b{opacity:1}
.chart g.col:focus{outline:none}
.chart text{font-size:11px;fill:var(--mute)}
.highlights{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.hl{background:var(--card);border:1px solid var(--rule);border-top:3px solid var(--accent);border-radius:10px;padding:16px 18px}
.hl .area{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.hl h3{margin:6px 0 6px;font-size:18px;line-height:1.3;color:var(--ink)}
.hl p{margin:0;font-size:14px}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px;padding:0;list-style:none}
.toc a{display:inline-block;font-size:13px;text-decoration:none;color:var(--ink2);background:var(--card);border:1px solid var(--rule);border-radius:999px;padding:4px 12px}
.toc a:hover{border-color:var(--accent);color:var(--accent)}
.area{scroll-margin-top:16px}
.area-block{margin:34px 0 0;padding:24px 0 0;border-top:1px solid var(--rule)}
.area-block h3.t{margin:0 0 4px;font-size:21px;color:var(--ink);font-weight:600}
.area-block .why{margin:0 0 6px;max-width:68ch}
.area-block .count{margin:0 0 14px;font-size:12.5px;color:var(--mute)}
.item{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:14px 18px 14px;margin:0 0 10px;break-inside:avoid}
.item-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.item h4{margin:0;flex:1 1 320px;font-size:16.5px;line-height:1.35;color:var(--ink);font-weight:600}
.pill{font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 10px;white-space:nowrap}
.pill.merged{color:var(--merged);background:var(--mergedbg)}
.pill.progress{color:var(--progress);background:var(--progressbg)}
.pill.designed{color:var(--designed);background:var(--designedbg)}
.date{font-size:12.5px;color:var(--mute);white-space:nowrap}
.item p{margin:8px 0 0;max-width:72ch}
.refs{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.refs li{font-size:12px}
.refs li{display:inline-flex;border-radius:5px;overflow:hidden}
.refs a,.refs span{display:inline-block;text-decoration:none;color:var(--accent);background:var(--accent2);padding:1px 7px}
.refs span.sha{color:var(--mute);background:var(--rule2);font-size:11px}
.legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 18px;padding:0;list-style:none;font-size:13px;color:var(--mute)}
.legend li{display:flex;align-items:center;gap:8px}
.next{margin:0;padding:0 0 0 20px}
.next li{margin:0 0 8px;max-width:70ch}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--card);border:1px solid var(--rule);border-radius:10px;overflow:hidden}
th{text-align:left;font-weight:600;color:var(--mute);font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:9px 12px;border-bottom:1px solid var(--rule)}
td{padding:7px 12px;border-bottom:1px solid var(--rule2);vertical-align:top}
tr:last-child td{border-bottom:none}
td.n{white-space:nowrap}
td.d{white-space:nowrap;color:var(--mute)}
td.c{white-space:nowrap;color:var(--mute);font-size:12px}
.how p{max-width:72ch;margin:0 0 10px}
footer{margin:46px 0 0;padding:16px 0 0;border-top:1px solid var(--rule);font-size:12.5px;color:var(--mute)}
@media (max-width:640px){h1{font-size:31px}.stats{grid-template-columns:repeat(2,1fr)}.doc{padding:24px 16px 48px}td.c{display:none}}
@media print{body{background:#fff;font-size:11pt}.doc{max-width:none;padding:0}.print,.toc{display:none}.stat,.chart,.item,.hl,table{border-color:#ccc}section{break-before:auto}.area-block,.hl,tr{break-inside:avoid}h2,h3{break-after:avoid}a{color:inherit;text-decoration:none}@page{margin:16mm 15mm}}`;

// Only for pages that list changes in compact rows (reader sections, unfinished work).
const ROWS_STYLE = `.rows{margin:0;padding:0;list-style:none;border-top:1px solid var(--rule)}
.rows li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:9px 2px;border-bottom:1px solid var(--rule2)}
.rows li>a,.rows li>b{flex:1 1 300px;color:var(--ink);font-weight:600;text-decoration:none}
.rows li>a:hover{color:var(--accent)}
.rows .picked{font-size:12px;color:var(--mute)}
.rows .refs{flex-basis:100%;margin:2px 0 0}`;

export const SCRIPT = `(function(){
var b=document.querySelector(".print");if(b)b.addEventListener("click",function(){window.print();});
var r=document.querySelector(".chart .readout");if(!r)return;var d=r.textContent;
document.querySelectorAll(".chart g.col").forEach(function(g){
function s(){r.textContent=g.getAttribute("data-label");}
g.addEventListener("mouseenter",s);g.addEventListener("focus",s);g.addEventListener("mouseleave",function(){r.textContent=d;});g.addEventListener("blur",function(){r.textContent=d;});});
})();`;

function chartSvg(series) {
  const buckets = Array.isArray(series?.buckets) ? series.buckets : [];
  if (!buckets.length) return '';
  const W = 800;
  const H = 170;
  const top = 8;
  const base = 138;
  const max = Math.max(1, Number(series.max) || 0);
  const step = W / buckets.length;
  const bw = Math.max(2, step * 0.62);
  const unit = series.unit === 'month' ? 'month' : 'week';
  let lastMonth = -1;
  const cols = buckets.map((b, i) => {
    const count = Number(b.count) || 0;
    const h = count === 0 ? 2 : Math.max(3, Math.round(((base - top) * count) / max));
    const x = (i * step + (step - bw) / 2).toFixed(1);
    const label = `${unit === 'week' ? 'Week of ' : ''}${b.label}: ${plural(count, 'commit')}`;
    let tick = '';
    if (unit === 'month' || b.month !== lastMonth) {
      tick = `<text x="${x}" y="${base + 18}">${esc(unit === 'month' ? b.label : b.label.split(' ')[0])}</text>`;
      lastMonth = b.month;
    }
    return `<g class="col" tabindex="0" role="img" aria-label="${esc(label)}" data-label="${esc(label)}"><rect class="b${count === 0 ? ' zero' : ''}" x="${x}" y="${base - h}" width="${bw.toFixed(1)}" height="${h}" rx="2"></rect><rect x="${(i * step).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${base - top}" fill="transparent"></rect>${tick}</g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Commits on the main branch per ${unit}"><line x1="0" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}" stroke="#d9d6cf"></line>${cols.join('')}</svg>`;
}

// Every item carries its receipt: each pull request chip names the verified commit it
// was traced through, and a commit that came in without a pull request shows its own.
function refsHtml(it) {
  const prs = it.prs.map((p) => {
    const txt = `PR #${p.n}`;
    const pr = p.url ? `<a href="${esc(p.url)}">${esc(txt)}</a>` : `<span>${esc(txt)}</span>`;
    return `<li>${pr}${p.shortSha ? `<span class="sha mono" title="Verified commit">${esc(p.shortSha)}</span>` : ''}</li>`;
  });
  const shas = it.commits.filter((c) => c.pr == null).map((c) => `<li><span class="sha mono" title="${esc(c.subject)}">${esc(c.shortSha)}</span></li>`);
  const all = [...prs, ...shas];
  return all.length ? `<ul class="refs" aria-label="Evidence">${all.join('')}</ul>` : '';
}

function itemHtml(it) {
  return `<article class="item" id="${esc(it.id)}"><div class="item-top"><h4>${esc(it.title)}</h4><span class="pill ${esc(it.statusKey)}">${esc(it.statusLabel)}</span>${it.dateLabel ? `<span class="date">${esc(it.dateLabel)}</span>` : ''}</div>${it.summary ? `<p>${esc(it.summary)}</p>` : ''}${refsHtml(it)}</article>`;
}

/** render(clientModel, _config) -> a complete, self-contained HTML document. */
export function render(model, _config) {
  const m = model || {};
  const s = m.stats || {};
  const cl = m.client || {};
  const themeTitle = new Map((m.themes || []).map((t) => [t.id, t.title]));

  const metaRows = [
    ['Prepared for', cl.preparedFor],
    ['Prepared by', [cl.preparedBy, cl.organization].filter(Boolean).join(', ')],
    ['Period', m.period?.label],
    ['Report date', m.generatedLabel],
  ].filter(([, v]) => v);
  const meta = `<dl class="meta">${metaRows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;

  const lede = m.headline || (m.summary || []).length
    ? `<div class="lede">${m.headline ? `<p class="headline serif">${esc(m.headline)}</p>` : ''}${(m.summary || []).map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
    : '';

  const statTiles = [
    [s.prs, s.prs === 1 ? 'pull request merged' : 'pull requests merged'],
    [s.commits, s.commits === 1 ? 'commit on the main branch' : 'commits on the main branch'],
    [s.activeDays, s.activeDays === 1 ? 'day with work landed' : 'days with work landed'],
    [s.areas, s.areas === 1 ? 'area of work' : 'areas of work'],
  ];
  const incomplete = s.complete === false
    ? ` Some repositories could not be read (${(s.unreadable || []).join(', ')}), so the git counts are left blank rather than shown too low.`
    : '';
  const stats = `<div class="stats">${statTiles.map(([n, label]) => `<div class="stat"><b>${esc(fmt(n))}</b><span>${esc(label)}</span></div>`).join('')}</div><p class="note">Counted from git on the report date: my commits that reached the main branch during the period, and the pull requests they came in with.${esc(incomplete)}</p>`;

  const svg = chartSvg(m.series);
  const unit = m.series?.unit === 'month' ? 'month' : 'week';
  const peak = m.series?.max ?? 0;
  const activity = svg
    ? `<section aria-labelledby="activity"><h2 id="activity" class="serif">Activity over the period</h2><p class="sub">Commits that reached the main branch, per ${unit}. Hover a bar for the count.</p><div class="chart">${svg}<p class="readout">${esc(`Busiest ${unit}: ${plural(peak, 'commit')}`)}</p></div></section>`
    : '';

  const highlights = (m.highlights || []).length
    ? `<section aria-labelledby="highlights"><h2 id="highlights" class="serif">Highlights</h2><p class="sub">${esc(`The changes with the most effect on how ${cl.name || 'the product'} is used or run.`)}</p><div class="highlights">${m.highlights
        .map((it) => `<a class="hl" href="#${esc(it.id)}" style="text-decoration:none;color:inherit"><div class="area">${esc(themeTitle.get(it.theme) || '')}</div><h3 class="serif">${esc(it.title)}</h3><p>${esc(it.summary)}</p></a>`)
        .join('')}</div></section>`
    : '';

  const legend = (m.legend || []).length
    ? `<ul class="legend">${m.legend.map((l) => `<li><span class="pill ${esc(l.key)}">${esc(l.label)}</span><span>${esc(l.meaning)}</span></li>`).join('')}</ul>`
    : '';
  const toc = (m.themes || []).length > 1 ? `<ul class="toc">${m.themes.map((t) => `<li><a href="#${esc(t.anchor)}">${esc(t.title)}</a></li>`).join('')}</ul>` : '';
  const v = m.view || { order: ['highlights', 'activity', 'done', 'not-finished', 'next', 'record', 'how'], sections: [], notFinished: [], needs: [], hidden: { items: 0, areas: [] } };
  const hidden = v.hidden?.items
    ? `<p class="note">${esc(`${plural(v.hidden.items, 'change')} in ${v.hidden.areas.join(', ')} ${v.hidden.items === 1 ? "isn't" : "aren't"} shown in this view. Their pull requests are still in the full record below.`)}</p>`
    : '';
  const areas = (m.themes || []).length
    ? `<section aria-labelledby="areas"><h2 id="areas" class="serif">The work, by area</h2><p class="sub">${esc(plural((m.themes || []).reduce((n, t) => n + t.items.length, 0), 'change'))} in ${esc(plural(m.themes.length, 'area'))}, newest first within each area.</p>${hidden}${legend}${toc}${m.themes
        .map((t) => `<div class="area area-block" id="${esc(t.anchor)}"><h3 class="t serif">${esc(t.title)}</h3>${t.summary ? `<p class="why">${esc(t.summary)}</p>` : ''}<p class="count">${esc(plural(t.counts.items, 'change'))} · ${esc(plural(t.counts.prs, 'pull request'))}</p>${t.items.map(itemHtml).join('')}</div>`)
        .join('')}</section>`
    : hidden
      ? `<section aria-labelledby="areas"><h2 id="areas" class="serif">The work, by area</h2>${hidden}</section>`
      : `<section><p>No work was recorded for this period.</p></section>`;

  const next = (m.next || []).length
    ? `<section aria-labelledby="next"><h2 id="next" class="serif">What's next</h2><p class="sub">Planned, not done. Nothing here is counted above.</p><ul class="next">${m.next.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>`
    : '';

  const appendixRows = (m.appendix || [])
    .map((a) => `<tr><td class="d">${esc(a.dateLabel)}</td><td class="n mono">${a.url ? `<a href="${esc(a.url)}">#${esc(a.n)}</a>` : `#${esc(a.n)}`}</td><td>${esc(a.title)}</td><td class="c">${a.cited ? 'described above' : ''}</td></tr>`)
    .join('');
  const direct = s.directCommits ? ` ${plural(s.directCommits, 'commit')} landed without a pull request and ${s.directCommits === 1 ? 'is' : 'are'} counted in the totals but not listed here.` : '';
  const hiddenRecord = v.hidden?.items
    ? ` ${plural(v.hidden.items, 'change')} in ${v.hidden.areas.join(', ')} ${v.hidden.items === 1 ? "isn't" : "aren't"} described in this view; ${v.hidden.items === 1 ? 'its' : 'their'} pull requests are listed here.`
    : '';
  const appendix = (m.appendix || []).length
    ? `<section aria-labelledby="appendix"><h2 id="appendix" class="serif">Every pull request in the period</h2><p class="sub">${esc(`All ${plural(m.appendix.length, 'pull request')} with my commits in them that reached the main branch from ${m.period?.label ?? ''}. ${fmt(s.prsCited)} of them are described in the areas above; the rest are listed here without a description.${direct}${hiddenRecord}`)}</p><table><thead><tr><th>Merged</th><th>PR</th><th>Title</th><th></th></tr></thead><tbody>${appendixRows}</tbody></table></section>`
    : hiddenRecord
      ? `<section aria-labelledby="appendix"><h2 id="appendix" class="serif">The full record</h2><p class="sub">${esc(hiddenRecord.trim())}</p></section>`
      : '';

  const how = `<section class="how" aria-labelledby="how"><h2 id="how" class="serif">How this report was made</h2><p>${esc(`Every change above names the pull requests it came from. Before this page was written, each cited commit was looked up in the repository: if one didn't exist or wasn't mine, no report would have been produced. A change is marked Merged only when every commit it cites is on the main branch. The counts at the top, the activity chart and the list of pull requests were read from git on ${m.generatedLabel ?? 'the report date'}, not typed by hand.`)}</p><p>${esc('The descriptions were written for this report, and they are the one part a person chose rather than counted. "Merged" means the change is on the main branch; it doesn\'t by itself mean it has been released to production.')}</p></section>`;

  // Compact rows for sections that gather items from across the areas. A row links to
  // its full entry when that entry is on the page.
  const onPage = new Set((m.themes || []).flatMap((t) => t.items.map((it) => it.id)));
  const rowHtml = (r) => {
    const name = onPage.has(r.id) ? `<a href="#${esc(r.id)}">${esc(r.title)}</a>` : `<b>${esc(r.title)}</b>`;
    const picked = (r.matched || []).length ? `<span class="picked">${esc(r.matched.map((x) => (typeof x === 'number' ? `#${x}` : x)).join(', '))}</span>` : '';
    return `<li>${name}<span class="pill ${esc(r.statusKey)}">${esc(r.statusLabel)}</span>${r.dateLabel ? `<span class="date">${esc(r.dateLabel)}</span>` : ''}${picked}${refsHtml(r)}</li>`;
  };
  const custom = new Map((v.sections || []).map((sec) => {
    const how = sec.pickedBy === 'git'
      ? `Picked by git: each change below cites a commit whose message names one of ${sec.wanted.map((n) => `#${n}`).join(', ')}.`
      : 'Picked by hand for this report.';
    const body = sec.rows.length ? `<ul class="rows">${sec.rows.map(rowHtml).join('')}</ul>` : '<p>None of these landed in this period.</p>';
    return [sec.id, `<section aria-labelledby="sec-${esc(sec.id)}"><h2 id="sec-${esc(sec.id)}" class="serif">${esc(sec.title)}</h2>${sec.summary ? `<p class="sub">${esc(sec.summary)}</p>` : ''}<p class="note">${esc(how)}</p>${body}</section>`];
  }));
  const notFinished = (v.notFinished || []).length
    ? `<section aria-labelledby="unfinished"><h2 id="unfinished" class="serif">Not finished yet</h2><p class="sub">Real work that isn't done, or isn't on the main branch yet.</p><ul class="rows">${v.notFinished.map(rowHtml).join('')}</ul></section>`
    : '';
  const byId = { highlights, activity, done: areas, 'not-finished': notFinished, next, record: appendix, how };
  const ALWAYS = new Set(['highlights', 'activity', 'done', 'next', 'record', 'how']);
  const body = v.order
    .map((id) => ({ id, html: id in byId ? byId[id] : custom.get(id) ?? '' }))
    .filter((x) => x.html || ALWAYS.has(x.id))
    .map((x) => x.html)
    .join('\n');
  const usesRows = (v.sections || []).length > 0 || (v.notFinished || []).length > 0;

  const title = `${m.title || 'Work report'}: ${m.period?.label ?? ''}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}${usesRows ? `\n${ROWS_STYLE}` : ''}</style>
</head>
<body>
<main class="doc">
<div class="bar"><span>${esc(cl.name ? `${cl.name} · work report` : 'Work report')}</span><button type="button" class="print">Print or save as PDF</button></div>
<h1 class="serif">${esc(m.title || 'Work report')}</h1>
${meta}
${lede}
${stats}
${body}
<footer>Generated with honestweek, a local tool that checks every claim against git. Private: this file was made on my machine and is shared only by me.</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/**
 * renderNote(model, { reportFile }) -> a short Markdown note (a handful of lines) for a
 * reader who reads updates where they already work, such as the top of a shared
 * document. Same redacted model as the page; it adds no claim the page doesn't make.
 */
export function renderNote(model, { reportFile = '' } = {}) {
  const m = model || {};
  const v = m.view || { sections: [], notFinished: [] };
  const lines = [`**${m.title || 'Work report'}, ${m.period?.label ?? ''}**`, ''];
  if (m.headline) lines.push(m.headline, '');
  const receipt = (r) => {
    const pr = (r.prs || [])[0];
    if (pr) return pr.shortSha ? `PR #${pr.n}, ${pr.shortSha}` : `PR #${pr.n}`;
    const c = (r.commits || [])[0];
    return c ? c.shortSha : 'no commit yet';
  };
  const listed = (rows) => rows.slice(0, 3).map((r) => `${r.title} (${receipt(r)})`).join('; ');
  const withRows = (v.sections || []).filter((sec) => sec.rows.length).slice(0, 2);
  for (const sec of withRows) lines.push(`- ${sec.title}: ${plural(sec.rows.length, 'change')}, including ${listed(sec.rows)}.`);
  if (!withRows.length && (m.highlights || []).length) lines.push(`- Highlights: ${listed(m.highlights)}.`);
  if ((m.next || []).length) lines.push(`- Next: ${m.next[0]}`);
  if ((v.notFinished || []).length) lines.push(`- Not finished yet: ${plural(v.notFinished.length, 'change')}, listed in the report.`);
  lines.push('', `Full report, with every change and the pull requests behind it: ${reportFile}`, '');
  return lines.join('\n');
}
