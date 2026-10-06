// The replay page: every recorded step of one thread (a session, or sessions the logs connect)
// by agent and tool over time, with each long stretch in which no new step starts squeezed into
// a narrow break labelled by what filled it, a Problems row of the findings worth a look, and
// below the chart the steps as a story, one card per prompt. Selecting a step anywhere (a mark,
// a dot, a row of the story, the step controls) moves the playhead, the "now" line, the story's
// highlight and the Selected step panel together. Data: /api/replay?thread=<id> or
// ?session=<key>; with neither, the page is the list of the window's sessions (sessions.js), and
// every replay links back to it with "All sessions". The address holds only ids: ?session=<key>
// and #<thread>~<event> for the record open in the panel.
// #<thread>~zoom~<finding key>[~<event>] zooms to the steps a problem finding's check recorded and
// marks only those, until the fit control, Esc or the bar's own button leaves the zoom. A finding
// with a scope (lib/problems/scope.mjs) is framed the way its kind says: a moment with your prompt
// before it, a stretch shaded from its start to its end, a repeat numbered, a hand-off with the
// gap where no hand-back is recorded, a turn ending with your next prompt. Opened that way the
// page is in the problem focus: "What happened" (the caption, a few facts and the cause step),
// the cause drawn by kind (for a long session, its context per model call), only the lanes the
// problem involves with the rest folded into Other activity, and only its steps in the list,
// each with "See in the whole session" (#<thread>~<event>, out of the focus). "Show the whole
// session", Esc and the fit control leave it. The pure logic (the axis, the breaks, the story's
// groups, the dots, a scope's frame, the focus's plan) is replay-model.js.
(function () {
  'use strict';
  const { esc, plural, chip, time, toT, dur, isId } = HW;
  const RM = window.HWReplayModel;
  const sym = HW.sym;
  const $ = (id) => document.getElementById(id);
  const svg = $('chart');
  let D;
  let T0;
  let T1;
  let multi = false;
  let multiDay = false;
  let mains = [];
  let mainKeys = new Set();
  let LANES = [];
  let placed = [];
  let steps = [];
  let prompts = [];
  let mainTurns = [];
  let frames = [];
  let instrOf = new Map();
  let gitOps = [];
  let opened = null;
  let WHOLE = 'the whole session';
  let base = '';
  // The zoomed finding: { key, f, pattern, z, ids (its steps in this replay, in time order), set, i,
  // S (its scope, or null), marks (the other steps the scope names, by id, with their role),
  // plan (the problem focus: RM.focusPlan), lanes (the lanes it involves) }. While it's set the
  // page is in the problem focus: what happened, the cause drawn, only the lanes involved, and
  // only the problem's steps in the list until "Show every step in the session" (focusWide).
  let Z = null;
  let openId = null;
  let focusWide = false;
  let focusKey = null;
  // Each step's lane, by id (a git operation shares its step's id and never replaces it).
  let laneById = new Map();
  // Lanes opened into one row per tool; HELPERS is the one row every sub-agent shares until opened,
  // and OTHER, in the problem focus, the one row every lane it doesn't involve shares.
  const HELPERS = 'helpers';
  const OTHER = 'other';
  const expanded = new Set();
  const hiddenFamilies = new Set();
  let playhead;
  let view;
  let timer = null;
  let LEFT = 200;
  const HEAD_H = 30;
  const SUB_H = 26;
  const CHAR = 6.3;
  const AX = 32;
  const PH = 28;
  let TOP = 60;
  // The selected step, and what the story and the Problems row are built from.
  let selId = null;
  let navSteps = [];
  let navPrompts = [];
  let gaps = [];
  let idleLim = 0;
  const gapLabel = new Map();
  let whole = null;
  let scale = null;
  let story = { cards: [], order: [] };
  let mode = 'matters';
  const openGroups = new Set();
  let prefs = null;
  let PA = null;
  let F = { loaded: false, failed: null, items: [], flags: new Map(), dots: [], counts: null };
  let showRoutine = false;
  let sessionKeys = [];
  const TIER_WORD = { high: 'High', medium: 'Medium', low: 'Low' };
  const PATTERN_ID = /^[a-z][a-z0-9-]{1,60}$/;

  // ---- what started a session, and what a step started ---------------------------------------
  /** "Started by …" for a session a program opened (its log says a program or codex exec sent
   *  its opening, and it has no prompt), from the replay's launch links; null otherwise. */
  function startedLine(key, events, sessions) {
    if (!key) return null;
    const launch = D.launch?.by?.[key] ?? null;
    const own = events.filter((e) => e.session === key);
    const opener = own.find((e) => (e.kind === 'delegation-received' && (e.facts?.from === 'program' || e.facts?.from === 'codex-exec')) || (e.kind === 'command' && e.actor === 'program'));
    if (!launch && (!opener || own.some((e) => e.kind === 'prompt'))) return null;
    const text = opener?.facts?.from === 'codex-exec' ? 'started by codex exec' : 'started by a program';
    const html = HW.startedByHtml({ text, evidence: 'recorded', ...(launch ? { launch } : {}) }, sessions.find((s) => s.key === key)?.firstAt ?? null);
    return html.replace(/^s/, 'S');
  }
  // A step that launched a session says which, in its record panel, linked to that session.
  HW.addStepNote((id) => {
    const list = D?.launch?.started?.[id];
    if (!Array.isArray(list) || !list.length) return '';
    return list.map((s) => {
      const href = HW.sessionHref(s);
      const name = esc(s.title ?? s.label ?? 'an untitled session');
      return `<p class="launched">Started ${href ? `<a href="${esc(href)}">${name}</a>` : name} ${sym(HW.lvl(s, 'inferred'))}</p>`;
    }).join('');
  });

  // ---- the address ------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const askedSession = isId('session', params.get('session')) ? params.get('session') : null;
  const hashParts = () => location.hash.slice(1).split('~');
  const askedThread = isId('thread', hashParts()[0]) ? hashParts()[0] : null;
  const askedEvent = () => {
    const id = hashParts()[1];
    return isId('event', id) ? id : null;
  };
  const FINDING_KEY = /^pf-[a-p]{12}$/;
  const zoomKey = (parts = hashParts()) => (parts[1] === 'zoom' && FINDING_KEY.test(parts[2] ?? '') ? parts[2] : null);
  const zoomAddress = (id = openId) => `#${base}${Z ? `~zoom~${Z.key}` : ''}${id ? `~${id}` : ''}`;

  // ---- what goes where ------------------------------------------------------------------
  const family = (p) => (p.e.__gitop ? 'kind:gitop' : p.e.kind === 'action' ? `step:${p.e.group ?? 'other'}` : p.e.actor === 'program' ? 'kind:program' : `kind:${p.e.kind}`);
  const FAMILIES = [
    ['step:run', 'Commands run'], ['step:change', 'Files changed'], ['step:look', 'Reads, searches, web and browser'], ['step:other', 'Other tool calls (delegation, plans, skills, messages, connected tools)'],
    ['kind:message', 'Agent messages'], ['kind:update', 'Progress updates (inferred from position)'], ['kind:delegation-received', 'Sub-agent instructions'], ['kind:agent-message', 'Messages between agents'], ['kind:program', 'Sent by a program (commands, instructions, messages)'],
    ['kind:prompt', 'Your prompts'], ['kind:command', 'Your slash commands'], ['kind:notice', 'Your actions with no typed text'], ['kind:decision', 'Your decisions (answers, rejections)'], ['kind:interrupt', 'Interruptions'],
    ['kind:notification', 'Completion notices'], ['kind:guard', 'Refusals by a rule or hook'], ['kind:hook', 'Hooks run'], ['kind:turn-end', 'Turn ends'], ['kind:queue', 'Queued messages'], ['kind:mode', 'Mode changes'], ['kind:external-edit', 'Files changed outside the agent'], ['kind:compaction', 'Context compacted'], ['kind:error', 'Errors'], ['kind:session', 'Session starts'],
    ['kind:outcome', "Git's own record (commits, landed pull requests)"], ['kind:gitop', 'Git operations the harness recorded'], ['kind:link', 'Pull-request links'],
  ];
  const shown = (e) => !hiddenFamilies.has(family({ e }));
  function catalog() {
    const counts = new Map();
    for (const p of placed) counts.set(family(p), (counts.get(family(p)) ?? 0) + 1);
    const calls = placed.filter((p) => p.e.kind === 'action' && !p.e.__gitop);
    const tools = new Set(calls.map((p) => p.e.tool ?? p.e.facts?.tool)).size;
    const others = placed.filter((p) => !calls.includes(p));
    $('catalogSummary').textContent = `What the logs show for ${multi ? `these ${mains.length} sessions` : 'this session'}: ${plural(calls.length, 'tool call')} across ${plural(tools, 'tool')}, and ${plural(others.length, 'other record')} in ${plural(new Set(others.map(family)).size, 'kind')}. Show or hide any kind.`;
    $('catalogGrid').innerHTML = FAMILIES.map(([k, label]) => {
      const n = counts.get(k) ?? 0;
      return `<label class="${n ? '' : 'zero'}"><input type="checkbox" data-fam="${k}" ${hiddenFamilies.has(k) ? '' : 'checked'} ${n ? '' : 'disabled'}> ${esc(label)}<span class="n">${n || 'none here'}</span></label>`;
    }).join('');
    document.querySelectorAll('[data-fam]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) hiddenFamilies.delete(cb.dataset.fam);
      else hiddenFamilies.add(cb.dataset.fam);
      refilter();
      if (Z) zoomPanel();
    }));
  }
  /** The steps Step, Play and the story move through: every step of a kind that's shown; in the
   *  problem focus, only the problem's own steps and the steps its frame holds, until "Show every
   *  step in the session". */
  function refilter() {
    navSteps = steps.filter(shown);
    if (Z && !focusWide) navSteps = navSteps.filter((e) => zRole(e.id));
    navPrompts = navSteps.filter((e) => e.kind === 'prompt');
    renderStory();
    render();
  }

  // ---- layout -----------------------------------------------------------------------------
  function rows() {
    const visible = placed.filter((p) => !hiddenFamilies.has(family(p)));
    const out = [];
    /** One lane's row, and a row per tool or record kind when it's opened. */
    const laneRows = (L) => {
      const mine = visible.filter((p) => p.lane === L.key);
      const isOpen = expanded.has(L.key);
      out.push({ key: L.key, label: `${isOpen ? '▾' : '▸'} ${L.label}`, head: true, lane: L, items: isOpen ? [] : mine, count: mine.length, h: HEAD_H });
      if (isOpen) {
        const groups = new Map();
        for (const p of mine) (groups.get(p.sub) ?? groups.set(p.sub, []).get(p.sub)).push(p);
        for (const [sub, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) out.push({ key: `${L.key}|${sub}`, label: sub, head: false, lane: L, items, count: items.length, h: SUB_H });
      }
    };
    /** Lanes as the whole replay draws them: helpers (sub-agents) share one row, folded, until it's
     *  opened into a lane each. */
    const allRows = (lanes) => {
      const helpers = lanes.filter((l) => l.agent);
      const helperKeys = new Set(helpers.map((l) => l.key));
      const helpersOpen = expanded.has(HELPERS);
      let helperRow = false;
      for (const L of lanes) {
        if (L.agent) {
          if (!helperRow) {
            helperRow = true;
            const all = visible.filter((p) => helperKeys.has(p.lane));
            out.push({ key: HELPERS, label: `${helpersOpen ? '▾' : '▸'} ${plural(helpers.length, 'helper')}`, head: true, group: true, lane: { key: HELPERS, label: plural(helpers.length, 'helper'), helpers }, items: helpersOpen ? [] : all, count: all.length, counted: !helpersOpen, h: HEAD_H });
          }
          if (!helpersOpen) continue;
        }
        laneRows(L);
      }
    };
    if (Z?.lanes) {
      // The problem focus: the lanes it involves, each on its own row (a helper too), then one
      // faint Other activity row for the rest, opened on click into the lanes as the whole
      // replay draws them.
      const { shown: mine, other } = RM.splitLanes(LANES, Z.lanes);
      mine.forEach(laneRows);
      if (other.length) {
        const keys = new Set(other.map((l) => l.key));
        const all = visible.filter((p) => keys.has(p.lane));
        const open = expanded.has(OTHER);
        out.push({ key: OTHER, label: `${open ? '▾' : '▸'} Other activity`, head: true, group: true, other: true, lane: { key: OTHER, label: 'Other activity', lanes: other }, items: open ? [] : all, count: all.length, counted: !open, h: HEAD_H });
        if (open) allRows(other);
      }
    } else allRows(LANES);
    // Self-check: every record the catalog counts (and isn't hidden) must sit in some lane.
    const undrawn = visible.length - out.filter((r) => r.head && r.counted !== false).reduce((n, r) => n + r.count, 0);
    const warn = $('undrawn');
    warn.hidden = undrawn <= 0;
    warn.textContent = undrawn > 0 ? `${undrawn} record${undrawn === 1 ? " isn't" : "s aren't"} drawn in any lane.` : '';
    return out;
  }
  // Which session a moment belongs to: the last one that had started by then.
  const sessionAt = (t) => {
    let at = mains[0];
    for (const m of mains) if (m.start <= t) at = m;
    return at;
  };
  const instructionText = (e) => String(e.facts?.text ?? e.text.replace(/^started (?:with instructions from its parent agent|by codex exec with instructions) /, ''));

  // ---- a step in words ------------------------------------------------------------------
  const unquote = (s) => String(s ?? '').replace(/^"([\s\S]*)"$/, '$1');
  /** The step's own words from the log, as served (redacted): a prompt's or a message's text, a
   *  command, a file, an instruction; null when the record has none. */
  function logText(e) {
    const f = e.facts ?? {};
    if (e.__gitop) return e.label;
    if (['prompt', 'message', 'update', 'agent-message', 'command', 'decision', 'queue', 'notice'].includes(e.kind)) return typeof f.text === 'string' ? f.text : unquote(HW.stripKind(e.text));
    if (e.kind === 'delegation-received') return instructionText(e);
    if (e.kind === 'action') return f.command ?? f.file ?? f.description ?? f.pattern ?? f.query ?? f.subject ?? f.skill ?? f.title ?? f.summary ?? null;
    if (e.kind === 'outcome') return HW.summary(e);
    return null;
  }
  const QUOTED = new Set(['prompt', 'message', 'update', 'agent-message', 'command', 'decision', 'queue', 'notice']);
  /** A harness record's own line, for the records with no words of their own. */
  const detailText = (e) => (['turn-end', 'session', 'hook', 'mode'].includes(e.kind) || e.kind === 'action' || e.kind === 'outcome' ? null : HW.stripKind(e.text) || null);
  const CAT_TITLE = { shell: 'Ran a command', edit: 'Changed a file', read: 'Read a file', search: 'Searched', web: 'Looked something up on the web', delegate: 'Started a helper', 'agent-message': 'Sent a message to another agent', plan: 'Updated the plan', question: 'Asked you a question', 'plan-approval': 'Put a plan to you', skill: 'Used a skill', wait: 'Waited', stop: 'Stopped a task', mode: 'Changed mode', deliver: 'Sent you something', meta: 'Looked up a tool', browser: 'Used the browser', external: 'Used a connected tool', handoff: 'Suggested a task' };
  /** A short mechanical title: what kind of step it was, never what it meant. */
  function stepTitle(e) {
    if (e.__gitop) return 'Git operation the harness recorded';
    switch (e.kind) {
      case 'prompt': return `${HW.who(e).short === 'You' ? 'You' : HW.who(e).short} asked`;
      case 'action': return CAT_TITLE[e.cat ?? e.facts?.category] ?? `Used ${e.tool ?? e.facts?.tool ?? 'a tool'}`;
      case 'message': return /^message to the person/.test(e.text) ? 'Message to you' : /^reply to parent agent/.test(e.text) ? 'Reply to its parent agent' : /^reply to the program/.test(e.text) ? 'Reply to the program' : 'Agent message';
      case 'delegation-received': return 'Started with instructions';
      case 'turn-end': return `Turn ended${Number.isFinite(e.harnessMs) ? ` after ${RM.spanText(e.harnessMs)}` : ''}`;
      case 'interrupt': return 'Interrupted';
      case 'session': return mainKeys.has(e.agent) ? 'Session started' : 'Helper started';
      default: return HW.kindLabel(e);
    }
  }
  /** The kind's colour on the story's dot. */
  function kindClass(e) {
    if (['prompt', 'command', 'decision', 'notice'].includes(e.kind) && e.actor !== 'harness' && e.actor !== 'program') return 'k-you';
    if (e.kind === 'action') {
      if (e.tests?.fail > 0) return 'k-fail';
      if ((e.cat ?? e.facts?.category) === 'delegate') return 'k-helper';
      return e.group === 'run' ? 'k-run' : e.group === 'change' ? 'k-change' : e.group === 'look' ? 'k-look' : 'k-other';
    }
    if (e.kind === 'message' || e.kind === 'agent-message' || e.kind === 'update') return 'k-msg';
    if (e.kind === 'delegation-received') return 'k-helper';
    if (e.kind === 'interrupt' || e.kind === 'guard') return 'k-stop';
    if (e.kind === 'outcome') return 'k-git';
    return 'k-harness';
  }
  /** The lane a step sits in, by name. */
  function laneLabel(e) {
    const k = e.__gitop ? 'git' : HW.laneOf(e) ?? 'harness';
    const L = LANES.find((l) => l.key === k);
    return L ? L.label.replace(/^↳ /, '') : 'Harness';
  }
  /** A test run's recorded result: its pass and fail counts, as the engine read them. */
  function resultOf(e) {
    if (!e.tests || typeof e.tests !== 'object') return null;
    const pass = e.tests.pass ?? 0;
    const fail = e.tests.fail ?? 0;
    return { fail: fail > 0, text: fail > 0 ? `✕ ${fail} failed, ${pass} passed` : `✓ ${pass} passed`, level: typeof e.tests.evidence === 'string' ? e.tests.evidence : 'derived' };
  }
  const stime = (t) => time(t, { seconds: true, day: multiDay });
  const fchip = (i) => `<span class="fchip t-${i.look ? i.tier : 'routine'}" title="${esc(i.f.checkTitle ?? '')}">${i.look ? TIER_WORD[i.tier] : 'Routine note'} · ${esc(i.p.name)} ${sym(i.level)}</span>`;
  const waitChip = (e) => `<span class="fchip t-wait">waited ${esc(RM.spanText(RM.spanOf(e)))} ${sym('derived')}</span>`;
  const isCorrection = (e) => e.inferred.some((x) => (x && typeof x === 'object' ? x.key === 'intent' && x.value === 'correction' : /^intent=correction\b/.test(String(x))));
  const whose = () => (sessionKeys.length > 1 ? `these ${sessionKeys.length} sessions` : 'this session');
  /** What filled the gap that holds this stretch of the view. */
  const labelAt = (a, b) => {
    const g = gaps.find(([s, e]) => s <= a + 1 && e >= b - 1);
    return g ? gapLabel.get(g[0]) : null;
  };
  const piecesSvg = (pieces) => pieces.map(([t]) => `<tspan>${esc(t)}</tspan>`).join('');
  const piecesHtml = (pieces) => pieces.map(([t, logged]) => (logged ? `<span>${esc(t)}</span>` : esc(t))).join('');

  // ---- the chart ------------------------------------------------------------------------------
  const breakW = (plotW) => Math.round(Math.max(28, Math.min(48, plotW * 0.05)));
  const scaleFor = (W) => RM.makeScale({ v0: view[0], v1: view[1], p0: LEFT, p1: W - 10, gaps, limit: idleLim, breakW: breakW(W - 10 - LEFT) });
  /** One step's mark. A step with a recorded span of 30 seconds or more is a bar to scale in the
   *  waiting style, and a failed test run a taller tick in the high colour; the rest are the
   *  marks every chart page draws. */
  function markOf(e, { x, mid, small, label, RIGHT }) {
    const fail = !e.__gitop && e.kind === 'action' && e.tests?.fail > 0;
    const long = !e.__gitop && RM.isLongWait(e);
    if (!fail && !long) return HW.markSvg(e, { x, mid, small, playhead: Infinity, big: 7, sm: 5, label });
    const hh = (small ? 5 : 7) + (fail ? 3 : 0);
    const moved = HW.timeMoved(e);
    const cx = x(e.t);
    const w = long ? Math.max(4, Math.min(RIGHT, x(e.endT)) - cx) : 4;
    const g = fail ? 'fail' : ['run', 'change', 'look'].includes(e.group) ? e.group : 'other';
    const cls = `mark${moved ? ' timeby' : ''}${long ? ` wait g-${g}` : ' failtest'}`;
    return `<rect class="${cls}" data-id="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(label)}" x="${cx}" y="${mid - hh}" width="${w}" height="${hh * 2}" rx="${long ? 3 : 1.5}"${moved ? ' stroke-dasharray="2 1.5"' : ''}/>${long ? `<rect class="wait-start g-${g}" x="${cx}" y="${mid - hh}" width="3" height="${hh * 2}" aria-hidden="true"/>` : ''}`;
  }
  /** A box around a mark: the selected step's halo, or a ring in its top finding's tier colour. */
  function around(e, { x, mid, small, RIGHT }, cls, pad) {
    const hh = (small ? 5 : 7) + (!e.__gitop && e.kind === 'action' && e.tests?.fail > 0 ? 3 : 0);
    const cx = x(e.t);
    if (e.kind === 'action' && !e.__gitop) {
      const w = e.endT ? Math.max(6, Math.min(RIGHT, x(e.endT)) - cx) : 6;
      return `<rect class="${cls}" x="${cx - pad}" y="${mid - hh - pad}" width="${w + pad * 2}" height="${(hh + pad) * 2}" rx="${pad + 2}" aria-hidden="true"/>`;
    }
    return `<circle class="${cls}" cx="${cx}" cy="${mid}" r="${hh + pad}" aria-hidden="true"/>`;
  }
  /** The inline label a step may take, in pieces [text, fromTheLogs]: a prompt's or message's
   *  opening words, an edited file, a helper's instruction and its commands, a test result, a
   *  wait, and the harness's turn ends and interruptions. Null for the rest. */
  function labelFor(e) {
    const f = e.facts ?? {};
    const quoted = (t) => (t ? { pieces: [['“', false], [t, true], ['”', false]] } : null);
    if (e.__gitop) return null;
    const res = resultOf(e);
    if (RM.isLongWait(e)) return { cls: res?.fail ? 'bad' : '', inside: true, pieces: [[f.command ?? f.file ?? e.tool ?? 'a step', true], [` · ${RM.spanText(RM.spanOf(e))}${res ? ` · ${res.text}` : ''}`, false]] };
    if (res) return { cls: res.fail ? 'bad' : 'dim', pieces: [[res.text, false]] };
    switch (e.kind) {
      case 'prompt':
      case 'command':
      case 'message':
      case 'agent-message':
        return quoted(logText(e));
      case 'delegation-received':
        return { pieces: [['Started with: ', false], [instructionText(e), true]] };
      case 'turn-end':
        return { cls: 'dim', pieces: [['turn ended', false]] };
      case 'interrupt':
        return { cls: 'dim', pieces: [['interrupted', false]] };
      case 'session':
        return { cls: 'dim', pieces: [[mainKeys.has(e.agent) ? 'session started' : 'helper started', false]] };
      case 'outcome':
        return { pieces: [[HW.summary(e), true]] };
      case 'action':
        if (e.group === 'change' && f.file) return { pieces: [[f.file, true]] };
        if ((e.cat ?? f.category) === 'delegate' && f.description) return { pieces: [[f.description, true]] };
        if (!mainKeys.has(e.agent) && f.command) return { pieces: [[f.command, true]] };
        return null;
      default:
        return null;
    }
  }
  /** The label's markup in `room` pixels: the page's own words whole, the log's words cut to the
   *  rest (between words, never inside a hidden part), each in an element of its own. */
  function fitPieces(pieces, room) {
    const CH = 6;
    const own = pieces.filter(([, logged]) => !logged).reduce((n, [t]) => n + t.length * CH, 0);
    const left = room - own;
    // The log's words get at least eight characters, or the label waits for more room.
    if (pieces.some(([, logged]) => logged) ? left < 48 : own > room) return null;
    const width = Math.min(room, pieces.reduce((n, [t]) => n + t.length * CH, 0));
    return { width, markup: pieces.map(([t, logged]) => `<tspan>${logged ? HW.fitText(t, left, CH) : esc(t)}</tspan>`).join('') };
  }
  /** Labels on one row where there's room: right of the mark, else left of it, never over
   *  another mark, another label or a break. A wait's label sits inside its bar when it fits. */
  function labelsSvg(items, { x, mid, RIGHT }) {
    const sorted = [...items].sort((a, b) => a.e.t - b.e.t);
    const ext = sorted.map((p) => [x(p.e.t) - 7, Math.min(RIGHT, x(p.e.endT && p.e.kind === 'action' ? p.e.endT : p.e.t)) + 7]);
    let free = LEFT;
    let out = '';
    const put = (L, at, anchor, fit) => {
      out += `<text class="ilabel${L.cls ? ` ${L.cls}` : ''}" x="${at}" y="${mid + 4}"${anchor === 'end' ? ' text-anchor="end"' : ''} aria-hidden="true">${fit.markup}</text>`;
    };
    sorted.forEach((p, i) => {
      if (p.e.endT && p.e.endT < view[0]) return;
      const L = labelFor(p.e);
      if (!L) return;
      const [a, b] = ext[i];
      const others = (s0, s1) => ext.some(([oa, ob], j) => j !== i && oa < s1 && ob > s0);
      if (L.inside) {
        const s0 = Math.max(a + 7 + 6, free + 8, LEFT + 2);
        const fit = fitPieces(L.pieces, b - 7 - 4 - s0);
        if (fit && !others(s0, s0 + fit.width)) {
          put(L, s0, 'start', fit);
          free = s0 + fit.width;
          return;
        }
      }
      const nextStart = ext.slice(i + 1).find(([na]) => na > a)?.[0] ?? RIGHT;
      const brkAfter = scale.breaks.find((k) => k.x0 >= b - 0.5)?.x0 ?? RIGHT;
      const start = Math.max(b + 2, free + 8);
      const right = fitPieces(L.pieces, Math.min(nextStart, brkAfter, RIGHT) - 4 - start);
      if (right && right.width >= 40) {
        put(L, start, 'start', right);
        free = start + right.width;
        return;
      }
      const prevEnd = i > 0 ? ext[i - 1][1] : LEFT;
      const brkBefore = [...scale.breaks].reverse().find((k) => k.x1 <= a + 0.5)?.x1 ?? LEFT;
      const end = a - 2;
      const left = fitPieces(L.pieces, end - Math.max(prevEnd, brkBefore, free + 8, LEFT + 2) - 4);
      if (left && left.width >= 40) {
        put(L, end, 'end', left);
        free = end;
      }
    });
    return out;
  }
  const dotLabel = (i) => `${i.look ? TIER_WORD[i.tier] : 'Routine note'}${i.mine ? ' (you set this)' : ''}: ${i.p.name}, ${time(i.t, { day: multiDay, seconds: true })}. ${i.level}.`;

  function render() {
    if (!view) return;
    const keep = HW.focusedMark(svg);
    const dot = document.activeElement?.closest?.('#chart .pdot, #chart .pbubble');
    const dotKey = dot ? (dot.dataset.k != null ? `[data-k="${dot.dataset.k}"]` : `[data-c="${dot.dataset.c}"]`) : null;
    const W = svg.clientWidth || 900;
    const RIGHT = W - 10;
    LEFT = Math.round(Math.min(220, Math.max(108, W * 0.22)));
    const R = rows();
    const hasTurns = mainTurns.length > 0;
    const TURN_Y = AX + 2;
    const SESS_Y = (hasTurns ? TURN_Y + 16 : AX) + 2;
    const PTOP = multi ? SESS_Y + 20 : hasTurns ? TURN_Y + 18 : AX + 4;
    TOP = PTOP + (Z ? 0 : PH);
    const H = TOP + R.reduce((n, r) => n + r.h, 0) + 8;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    const [v0, v1] = view;
    scale = scaleFor(W);
    const { x } = scale;
    const cl = (px) => Math.max(LEFT, px);
    const drawn = [];
    let s = '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" stroke-width="2"/></pattern></defs>';
    // Breaks: each long stretch with no new step, squeezed, behind everything.
    const brks = scale.breaks.map((b) => ({ b, label: labelAt(b.t0, b.t1) }));
    for (const { b, label } of brks) {
      const tip = label ? `${label.text} (derived from recorded times). Squeezed so the busy stretches get room.` : `No new step for ${RM.minText(b.t1 - b.t0)}.`;
      s += `<g class="rbrk"><rect class="brk-band" x="${b.x0}" y="16" width="${b.x1 - b.x0}" height="${H - 16}"/><line class="brk-edge" x1="${b.x0}" x2="${b.x0}" y1="16" y2="${H}"/><line class="brk-edge" x1="${b.x1}" x2="${b.x1}" y1="16" y2="${H}"/><title>${esc(tip)}</title></g>`;
    }
    // A zoomed finding's stretch, shaded with its start marked, and its gap, hatched.
    if (Z?.S) s += scopeBands(Z.S, { x, H, v0, v1 });
    // The axis: round times in each busy stretch, the first moment after each break, and the day
    // on the first label of each day.
    const taken = [];
    let lastDay = null;
    for (const tk of RM.axisTicks(scale, HW.niceStep)) {
      if (tk.x < LEFT - 0.5 || tk.x > RIGHT + 0.5) continue;
      const day = HW.dayOf(tk.t);
      const label = time(tk.t, { day: lastDay === null || day !== lastDay || tk.step >= 86400e3, seconds: tk.step < 60e3 || (tk.edge && tk.t % 60e3 !== 0) });
      s += `<line x1="${tk.x}" x2="${tk.x}" y1="16" y2="${H - 6}" stroke="var(--grid)"/>`;
      const w = label.length * 5.8 + 4;
      if (taken.some(([p, q]) => tk.x + 3 < q && tk.x + 3 + w > p) || tk.x + 3 + w > W) continue;
      taken.push([tk.x, tk.x + 3 + w + 6]);
      s += `<text class="tick" x="${tk.x + 3}" y="12">${esc(label)}</text>`;
      lastDay = day;
    }
    // Each break's label under the times: what filled it where there's room, else its length.
    // Every break keeps room for its length first; a full label only takes room no other needs.
    const spot = (b, pieces) => {
      const w = pieces.reduce((n, [t]) => n + t.length, 0) * 5.6;
      const a = Math.max(LEFT, Math.min(RIGHT - w, (b.x0 + b.x1) / 2 - w / 2));
      return { pieces, a, z: [a - 8, a + w + 8] };
    };
    const placedBrk = brks.map(({ b }) => spot(b, [[RM.minText(b.t1 - b.t0), false]]));
    brks.forEach(({ b, label }, i) => {
      if (!label) return;
      const full = spot(b, label.pieces);
      if (!placedBrk.some((o, j) => j !== i && full.z[0] < o.z[1] && full.z[1] > o.z[0])) placedBrk[i] = full;
    });
    placedBrk.forEach((o, i) => {
      if (placedBrk.some((p, j) => j < i && o.z[0] < p.z[1] && o.z[1] > p.z[0])) return;
      s += `<text class="brk-label" x="${o.a}" y="27" aria-hidden="true">${piecesSvg(o.pieces)}</text>`;
    });
    // Turn band: every main agent's turns, numbered; click one to zoom to it.
    mainTurns.forEach((t, i) => {
      const a = Math.max(v0, toT(t.startAt));
      const b = Math.min(v1, toT(t.lastRecordAt ?? t.endAt ?? t.startAt));
      if (b < v0 || a > v1) return;
      const w = Math.max(2, x(b) - x(a));
      s += `<g class="turnseg" data-turn="${i}"><rect x="${x(a)}" y="${TURN_Y}" width="${w}" height="14" rx="4" fill="var(--surface)" stroke="var(--ring)"/>${w > 22 ? `<text class="tick" x="${x(a) + 4}" y="${TURN_Y + 11}">T${i + 1}</text>` : ''}<title>Turn ${i + 1}${multi ? `, session ${mains.findIndex((m) => m.a.key === t.agent) + 1}` : ''}: ${esc(t.opener?.text ?? '')} (click to zoom)</title></g>`;
    });
    // Sessions: a labelled rule at each later session's first record, and a name in the strip.
    if (multi) {
      let limit = RIGHT;
      for (let i = mains.length - 1; i >= 0; i--) {
        const m = mains[i];
        const until = mains[i + 1]?.start ?? T1;
        if (m.start > v1 || until < v0) continue;
        const showStart = m.start >= v0;
        const lx = showStart ? x(m.start) : LEFT;
        const when = time(m.start, { day: true });
        const tip = `Session ${i + 1}: its first record is ${time(m.start, { day: true, seconds: true })}.`;
        if (showStart && i > 0) s += `<line class="sessrule" x1="${lx}" x2="${lx}" y1="${SESS_Y}" y2="${H - 6}" stroke="var(--ink-2)" stroke-width="1.2" stroke-dasharray="4 3"><title>${esc(tip)}</title></line>`;
        const names = showStart ? [`Session ${i + 1} starts, ${when}`, `Session ${i + 1} starts`, `Session ${i + 1}`, `S${i + 1}`] : [`Session ${i + 1}`, `S${i + 1}`];
        let at = null;
        for (const name of names) {
          const tw = name.length * 5.8 + 6;
          if (lx + 4 + tw <= limit) {
            at = { name, tx: lx + 4, tw };
            break;
          }
          if (showStart && i > 0 && lx - 4 - tw - 12 >= LEFT) {
            at = { name: `${name} →`, tx: lx - 4 - tw - 12, tw: tw + 12 };
            break;
          }
        }
        if (!at) continue;
        s += `<g><rect x="${at.tx - 2}" y="${SESS_Y + 2}" width="${at.tw}" height="15" rx="3" fill="var(--page)"/><text class="sesslabel" x="${at.tx}" y="${SESS_Y + 13}">${esc(at.name)}</text><title>${esc(tip)}</title></g>`;
        limit = at.tx - 10;
      }
    }
    // The Problems row: one dot per finding worth a look, at its step's time, in its tier's
    // colour. The problem focus has none: the page is about one finding.
    if (!Z) {
      const pmid = PTOP + PH / 2;
      const pd = F.loaded ? RM.problemDots(F.items, { routine: showRoutine }) : [];
      s += `<rect class="prob-bg" x="0" y="${PTOP}" width="${RIGHT}" height="${PH}"/><text class="prob-label" x="8" y="${pmid + 4}">Problems</text><text class="row-count" x="${LEFT - 8}" y="${pmid + 4}" text-anchor="end">${F.loaded ? pd.length : ''}</text><line x1="0" x2="${RIGHT}" y1="${PTOP + PH - 0.5}" y2="${PTOP + PH - 0.5}" stroke="var(--grid)"/>`;
      const inv = pd.filter((i) => i.t >= v0 && i.t <= v1).map((i) => ({ i, px: x(i.t) }));
      const pnote = !F.loaded ? (F.failed ? "Problem checks couldn't load." : 'Checking for problems…') : !pd.length ? `Nothing worth a look in ${whose()}.` : !inv.length ? `None in this stretch; zoom out to see ${pd.length}.` : '';
      if (pnote) s += `<text class="prob-note" x="${LEFT + 6}" y="${pmid + 4}">${esc(pnote)}</text>`;
      const clusters = [];
      for (const d of inv) {
        const g = clusters[clusters.length - 1];
        if (g && d.px - g.x1 < 13) {
          g.list.push(d);
          g.x1 = d.px;
        } else clusters.push({ list: [d], x0: d.px, x1: d.px });
      }
      for (const g of clusters) {
        if (g.list.length === 1) {
          const { i, px } = g.list[0];
          const text = dotLabel(i);
          s += `<g class="pdot t-${i.look ? i.tier : 'routine'}${i.event && i.event === selId ? ' on' : ''}" data-k="${i.k}" tabindex="0" role="button" aria-label="${esc(text)}"><circle cx="${px}" cy="${pmid}" r="10" fill="transparent"/><circle class="pm" cx="${px}" cy="${pmid}" r="${i.look ? 6 : 4.5}"/><title>${esc(text)}</title></g>`;
          continue;
        }
        const list = g.list.map((d) => d.i);
        const top = list.filter((i) => i.look).sort((a, b) => RM.RANK[a.tier] - RM.RANK[b.tier])[0];
        const by = ['high', 'medium', 'low'].map((t) => [t, list.filter((i) => i.look && i.tier === t).length]).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).concat(list.some((i) => !i.look) ? [`${list.filter((i) => !i.look).length} routine`] : []).join(', ');
        const text = `${list.length} ${list.every((i) => i.look) ? 'problems' : 'findings'} here (${by}). Press to zoom in, or to go to the first when they share a moment.`;
        const cx = (g.x0 + g.x1) / 2;
        s += `<g class="pbubble t-${top ? top.tier : 'routine'}" data-c="${list.map((i) => i.k).join(',')}" tabindex="0" role="button" aria-label="${esc(text)}"><circle class="pm" cx="${cx}" cy="${pmid}" r="9"/><text x="${cx}" y="${pmid + 3.5}" text-anchor="middle" aria-hidden="true">${list.length}</text><title>${esc(text)}</title></g>`;
      }
    }
    // The lanes.
    let y = TOP;
    for (const r of R) {
      const mid = y + r.h / 2;
      s += `<line x1="0" x2="${RIGHT}" y1="${y + r.h - 0.5}" y2="${y + r.h - 0.5}" stroke="var(--grid)"/>`;
      const ins = r.head && r.lane.agent ? instrOf.get(r.lane.key) : null;
      const hover = r.other
        ? "Everything else in this replay, faded: the lanes this problem doesn't involve.\n\nClick to open them."
        : r.group
          ? `${r.lane.label}, the sub-agents the agents started: ${r.lane.helpers.map((l) => l.label.replace(/^↳ /, '')).join('; ')}.\n\nClick to open a lane for each.`
          : r.head && r.lane.agent ? `${r.label}\n\n${ins ? `Started with: ${instructionText(ins)}` : "Its starting instruction isn't in the logs read."}\n\nClick to open one row per tool.` : r.label;
      const room = LEFT - (r.head ? 34 : 50);
      const focus = r.head ? ` tabindex="0" role="button" aria-expanded="${expanded.has(r.lane.key)}"` : '';
      if (r.group) {
        s += `<text class="row-label head helpers${r.other ? ' other' : ''}" data-lane="${esc(r.key)}"${focus} x="8" y="${mid + 4}">${HW.fitText(r.label, room, CHAR)}<title>${esc(hover)}</title></text>`;
      } else if (r.head && r.lane.session && r.label.length * CHAR > room) {
        // A main lane's full name doesn't fit: "Main agent" on one line, its session under it.
        s += `<text class="row-label head" data-lane="${esc(r.lane.key)}"${focus} x="8" y="${y + 13}">${esc(`${r.label.slice(0, 2)}Main agent`)}<title>${esc(hover)}</title></text><text class="row-sub" data-lane="${esc(r.lane.key)}" x="20" y="${y + 26}">session ${r.lane.session}<title>${esc(hover)}</title></text>`;
      } else {
        s += `<text class="row-label ${r.head ? 'head' : ''}" ${r.head ? `data-lane="${esc(r.lane.key)}"${focus}` : ''} x="${r.head ? 8 : 26}" y="${mid + 4}">${HW.fitText(r.label, room, CHAR)}<title>${esc(hover)}</title></text>`;
      }
      s += `<text class="row-count" x="${LEFT - 8}" y="${mid + 4}" text-anchor="end">${r.count}</text>`;
      if (r.key === 'git' && !r.count) s += `<text class="prob-note" x="${LEFT + 6}" y="${mid + 4}">Nothing from git in ${whose()}</text>`;
      for (const a of r.group ? (r.items.length && r.lane.helpers ? r.lane.helpers.map((l) => l.agent) : []) : r.head && r.lane.agent ? [r.lane.agent] : []) {
        const st = toT(a.spawnAt ?? a.firstAt);
        const en = toT(a.completion?.at ?? a.lastAt);
        if (en >= v0 && st <= v1) s += `<rect x="${cl(x(st))}" y="${y + 5}" width="${Math.max(2, x(Math.min(en, v1)) - cl(x(st)))}" height="${r.h - 11}" rx="4" fill="var(--wash)" stroke="var(--ring)"><title>${r.group ? `${esc(HW.agentLabel(a.key))}: open` : 'Open'} recorded span: started ${time(st)}, ${a.completion ? `finished ${time(en)} (${a.completion.via})` : `last record ${time(en)}`}</title></rect>`;
      }
      // Stretches with no records sit on the main lane of the session they fall in.
      if (r.head && mainKeys.has(r.lane.key) && !hiddenFamilies.has('kind:quiet')) {
        for (const q of [...HW.data.byId.values()].filter((e) => e.kind === 'quiet' && (e.endT ?? e.t) >= v0 && e.t <= v1 && sessionAt(e.t).a.key === r.lane.key)) {
          const qx = cl(x(q.t));
          const w = Math.max(1, x(Math.min(q.endT ?? q.t, v1)) - qx);
          const span = q.spanMs ?? q.derived?.ms ?? (q.endT ? q.endT - q.t : null);
          const label = `${time(q.t, { day: true, seconds: true })}. No records for ${dur(span)}: not idle, just unrecorded. derived.`;
          drawn.push({ id: q.id, text: label });
          s += `<rect class="mark" data-id="${esc(q.id)}" tabindex="0" role="button" aria-label="${esc(label)}" x="${qx}" y="${y + 4}" width="${w}" height="${r.h - 9}" rx="3" fill="var(--grid)" opacity="0.55"><title>No records for ${dur(span)} (derived): not idle, just unrecorded</title></rect>`;
        }
      }
      // Marks: the selected step's halo and each finding's ring behind its mark.
      const inView = r.items.filter((p) => (p.e.endT ?? p.e.t) >= v0 && p.e.t <= v1);
      const small = !r.head;
      const geo = { x, mid, small, RIGHT };
      // A repeat's numbers on this row, drawn after its marks where two don't touch.
      const nums = [];
      // Starting instructions draw last so a sub-agent's first step can't hide them.
      for (const p of [...inView].sort((a, b) => (a.e.kind === 'delegation-received') - (b.e.kind === 'delegation-received'))) {
        const e = p.e;
        const pieces = HW.describeStepPieces(e);
        const flags = e.__gitop ? null : F.flags.get(e.id);
        const look = (flags ?? []).filter((i) => i.look);
        if (look.length) pieces.push([` Worth a look: ${[...new Set(look.map((i) => i.p.name))].join('; ')}.`, false]);
        if (!e.__gitop && RM.isLongWait(e)) pieces.push([` Recorded span ${RM.spanText(RM.spanOf(e))}: the agent waited on it.`, false]);
        // A step of the zoomed finding: a ring behind its mark, and a line saying so; in a repeat,
        // its number too.
        if (Z?.set.has(e.id)) {
          const n = Z.ids.indexOf(e.id) + 1;
          pieces.push([Z.S?.kind === 'repeat' ? ` In the zoomed finding: repeat ${n} of ${Z.ids.length}.` : ` In the zoomed finding: step ${n} of ${Z.ids.length}.`, false]);
          const hx = x(e.t);
          const hx2 = e.endT && e.kind === 'action' ? x(Math.min(e.endT, v1)) : hx;
          s += `<rect class="zoomhalo" aria-hidden="true" x="${cl(hx - 8)}" y="${mid - 10}" width="${Math.max(16, hx2 - hx + 16)}" height="20" rx="7" fill="var(--accent-wash)" stroke="var(--accent)" stroke-width="2"/>`;
          if (Z.S?.kind === 'repeat' && !e.__gitop) nums.push({ x: hx, n });
        } else if (Z?.marks.has(e.id) && !e.__gitop) {
          // A step the scope names beside its own (your prompt before them, your next prompt, the
          // turn's last message, a helper's last record, its parent carrying on): a dashed outline.
          pieces.push([` ${ROLE_WORDS[Z.marks.get(e.id)]}.`, false]);
          s += around(e, geo, 'zctx', 7);
        } else if (Z?.S?.stretch && zRole(e.id) === 'stretch') pieces.push([" Inside the zoomed finding's stretch.", false]);
        if (e.id === selId && !e.__gitop) s += around(e, geo, 'selhalo', 6);
        const tier = RM.ringTier(flags);
        if (tier) s += around(e, geo, `ring t-${tier}`, 3.5);
        const label = pieces.map(([t]) => t).join('');
        drawn.push({ id: e.id, text: label, pieces });
        s += markOf(e, { ...geo, label });
      }
      nums.sort((a, b) => a.x - b.x);
      for (const i of RM.repeatNumbers(nums.map((o) => o.x))) s += `<text class="znum" x="${nums[i].x}" y="${mid - 12}" text-anchor="middle" aria-hidden="true">${nums[i].n}</text>`;
      // The focus's folded Other activity row stays faint: its marks only, no labels.
      if (!r.other) s += labelsSvg(inView, geo);
      y += r.h;
    }
    // Delegation connectors when the sub-agent lane is visible.
    const rowY = new Map();
    let yy = TOP;
    for (const r of R) {
      if (r.head) rowY.set(r.lane.key, yy + r.h / 2);
      yy += r.h;
    }
    for (const L of LANES.filter((l) => l.agent && l.agent.spawnedBy)) {
      const call = HW.data.byId.get(L.agent.spawnedBy);
      if (!call || call.t < v0 || call.t > v1) continue;
      const y1 = rowY.get(HW.laneOf(call)) ?? rowY.get(HELPERS);
      const y2 = rowY.get(L.key) ?? rowY.get(HELPERS);
      if (y1 === y2) continue;
      if (y1 == null || y2 == null) continue;
      s += `<path d="M${x(call.t)},${y1} V${y2}" stroke="var(--axis)" stroke-dasharray="2 3" fill="none"/>`;
    }
    if (playhead >= v0 && playhead <= v1) s += `<line class="playhead" x1="${x(playhead)}" x2="${x(playhead)}" y1="16" y2="${H}" stroke="var(--accent)" stroke-width="2"/><circle class="playknob" cx="${x(playhead)}" cy="16" r="4"/>`;
    svg.innerHTML = s;
    // While zoomed to a finding, every other mark steps back so its own steps stand out, beside
    // the steps its scope names and, in a stretch, that agent's steps inside it. Each mark that
    // stays says why (data-z), for the self-test.
    if (Z) {
      svg.querySelectorAll('.mark[data-id]').forEach((m) => {
        const role = zRole(m.dataset.id);
        if (role) m.setAttribute('data-z', role);
        else m.setAttribute('opacity', '0.3');
      });
    }
    HW.stepList($('chartSteps'), drawn);
    HW.refocus(svg, keep);
    if (dotKey) svg.querySelector(dotKey)?.focus({ preventScroll: true });
    $('scrub').style.paddingLeft = `${LEFT}px`;
    $('scrub').style.paddingRight = '10px';
    nowLine();
    panel();
    controls();
  }

  // ---- the now line, the controls and the Selected step panel ----------------------------------
  function nowLine() {
    const e = HW.data.byId.get(selId);
    $('readout').textContent = time(playhead, { day: true, seconds: true });
    if (!e) {
      $('nowLane').textContent = '';
      $('nowText').textContent = '';
      $('nowSpan').textContent = '';
      $('nowFlag').innerHTML = '';
      return;
    }
    $('nowLane').textContent = laneLabel(e);
    const t = logText(e) ?? detailText(e);
    $('nowText').innerHTML = `${esc(stepTitle(e))}${t ? `: <span>${esc(HW.clip(t, 240))}</span>` : ''}`;
    const sp = RM.spanOf(e);
    $('nowSpan').textContent = sp != null ? `recorded span ${RM.spanText(sp)}` : '';
    const top = (F.flags.get(e.id) ?? []).find((i) => i.look);
    $('nowFlag').innerHTML = top ? fchip(top) : '';
    $('nowBefore').innerHTML = beforeHtml(e);
  }

  // ---- just before: what led to the selected step, even outside the zoom ---------------------------
  /** The step before `e` in its own lane, of any kind; for a helper's first step, the call that
   *  started it. Null when neither is recorded. */
  function priorOf(e) {
    const i = steps.indexOf(e);
    for (let k = (i >= 0 ? i : steps.length) - 1; k >= 0; k--) {
      const s = steps[k];
      if (s !== e && s.agent === e.agent && s.t <= e.t) return { step: s, how: 'before' };
    }
    const call = starterOf(e.agent);
    return call ? { step: call, how: 'started' } : null;
  }
  /** The parent's call that started helper `agent`, when the logs record it. */
  const starterOf = (agent) => {
    const id = HW.data.agentByKey?.get(agent)?.spawnedBy;
    return id ? HW.data.byId.get(id) ?? null : null;
  };
  /** "Before it, 6 s earlier: Ran a command: …", and for a helper's opening record, who started
   *  it. Each is a button that selects that step. */
  function beforeHtml(e) {
    const pr = priorOf(e);
    if (!pr) return '';
    const link = (s, label) => {
      const t = logText(s) ?? detailText(s);
      return `<button type="button" class="linklike" data-before="${esc(s.id)}">${esc(label)}${esc(stepTitle(s))}${t ? `: ${esc(HW.clip(t, 90))}` : ''}</button>`;
    };
    const ago = e.t - pr.step.t;
    const when = ago >= 1000 ? `, ${dur(ago)} earlier` : '';
    let out = `<span class="muted">${pr.how === 'started' ? 'Started by' : `Before it${when}`}:</span> ${link(pr.step, pr.how === 'started' ? `${laneLabel(pr.step)}, ` : '')}`;
    // The step before is the helper's first record: say who started the helper too.
    const call = pr.how === 'before' ? starterOf(e.agent) : null;
    if (call && !steps.some((s) => s.agent === e.agent && s.t < pr.step.t)) out += ` <span class="muted">· started by</span> ${link(call, `${laneLabel(call)}, `)}`;
    return out;
  }
  /** Select a step from "Before it" or "Started by", widening the zoom just enough to hold it. */
  function goBefore(id) {
    const s = HW.data.byId.get(id);
    if (!s) return;
    if (s.t < view[0] || s.t > view[1]) {
      const pad = Math.max(2e3, (view[1] - view[0]) * 0.08);
      setView(Math.min(view[0], s.t - pad), Math.max(view[1], s.t + pad));
    }
    select(id, { from: 'controls', announce: true, follow: false });
  }
  function controls() {
    const i = navSteps.findIndex((e) => e.id === selId);
    // A step before the focus's first, reached from "Before it" or ◀ Step, reads as such.
    const ahead = i < 0 && navSteps.length && playhead < navSteps[0].t;
    $('stepOf').textContent = navSteps.length ? (ahead ? `Before step 1 of ${navSteps.length}` : `Step ${i >= 0 ? i + 1 : navSteps.filter((e) => e.t <= playhead).length} of ${navSteps.length}`) : '';
    const slider = $('slider');
    slider.value = String(Math.round(Math.max(0, Math.min(1000, whole.x(playhead)))));
    slider.setAttribute('aria-valuetext', time(playhead, { day: true, seconds: true }));
    const dots = RM.problemDots(F.items);
    $('prevProblem').disabled = !RM.problemStep(dots, { t: playhead, id: selId, dir: -1 });
    $('nextProblem').disabled = !RM.problemStep(dots, { t: playhead, id: selId, dir: 1 });
  }
  const ago = (t) => (playhead - t < 1000 ? 'at this moment' : `${dur(playhead - t)} ago`);
  const whoOf = (key) => {
    const a = HW.data.agentByKey.get(key);
    return !a || a.kind === 'main' ? HW.data.mainLabels.get(key) ?? 'Main agent' : HW.agentLabel(key);
  };
  function frameAt(t) {
    let lo = 0;
    let hi = frames.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return frames[ans] ?? null;
  }
  function inProgress(f) {
    const items = [];
    for (const a of f.awaiting) {
      const e = HW.data.byId.get(a.event);
      if (!e) continue;
      // A sub-agent's starting call is shown once, as the sub-agent below.
      if (e.facts?.spawnedAgent && f.agentsOpen.includes(e.facts.spawnedAgent)) continue;
      items.push(`<li data-id="${esc(e.id)}"><span class="who">${esc(whoOf(e.agent))}</span> asked for ${esc(e.tool ?? e.facts?.tool ?? 'a step')} and has no result yet<div class="sub">${esc(HW.clip(HW.summary(e), 110))}</div><div class="sub">asked ${esc(ago(e.t))}${a.never ? '. The log never records a result for this one.' : ''}</div></li>`);
    }
    for (const k of f.agentsOpen) {
      const ag = HW.data.agentByKey.get(k);
      const ins = instrOf.get(k);
      const text = ins ? instructionText(ins) : '';
      items.push(`<li ${ins ? `data-id="${esc(ins.id)}"` : ''}><span class="who">${esc(whoOf(k))}</span> started ${esc(ago(toT(ag?.spawnAt ?? ag?.firstAt)))} and hasn't reported back yet<div class="sub">${esc(ag?.description ?? '')}</div>${ins ? `<div class="instr">${HW.clipHtml(text, 240)}</div>` : "<div class=\"sub\">Its starting instruction isn't in the logs read.</div>"}</li>`);
    }
    for (const id of f.queued) {
      const e = HW.data.byId.get(id);
      items.push(`<li data-id="${esc(id)}"><span class="who">You</span> typed a message while the agent was busy; it hasn't been delivered yet<div class="sub">${esc(HW.clip(e?.text, 120))}</div></li>`);
    }
    return items;
  }
  /** What the logs say was going on at the playhead: the last prompt, what was in progress, and
   *  the totals so far. It sits in a closed fold of the Selected step panel. */
  function moment() {
    const f = frameAt(playhead) ?? HW.frameOf({});
    const last = [...prompts].reverse().find((p) => p.t <= playhead);
    const row = (label, [v, l], text = v) => `<span>${label} ${chip(l)}</span><span class="v">${esc(text)}</span>`;
    const now = inProgress(f);
    const askedWhen = last ? (playhead - last.t < 1000 ? 'At this moment' : `${dur(playhead - last.t)} earlier`) : '';
    const w = last ? HW.who(last) : null;
    return `
      <h2>The last thing you asked</h2>
      ${last ? `<div class="quote"><a href="#" class="plain" data-id="${esc(last.id)}">${esc(HW.stripKind(last.text))}</a></div><div class="note tight">${esc(askedWhen)} · ${esc(w.short)} ${chip(w.level)}</div>` : "<p class=\"note\">You haven't asked anything yet at this point.</p>"}
      <h2>In progress at this moment (${now.length})</h2>
      ${now.length ? `<ul class="now">${now.join('')}</ul>` : '<p class="note">Nothing. Every step started so far already has its result in the log.</p>'}
      ${f.quiet ? "<p class=\"note\">The log is silent around here: no records for a while. That doesn't mean idle, only unrecorded.</p>" : ''}
      <h2>Totals up to this moment</h2>
      <div class="tally">
        ${row('Your prompts', f.prompts)}
        ${row('Steps the agents took', f.actions)}
        ${row('Files changed', f.filesEdited, `${f.filesEdited[0]}${f.edits[0] ? ` (${plural(f.edits[0], 'edit')})` : ''}`)}
        ${row('Test runs', f.testRuns, f.testRuns[0] ? `${f.testRuns[0]}: ${f.testsPassed[0]} passed, ${f.testsFailed[0]} with failures${f.testsUnclear[0] ? `, ${f.testsUnclear[0]} unclear` : ''}` : 0)}
        ${row('Sub-agents started', f.delegations)}
        ${row('Steps a rule or hook blocked', f.guards)}
        ${row('Interruptions', f.interrupts)}
        ${row('Your commits (git)', f.commits)}
        ${row('Pull requests landed (git)', f.prsLanded)}
      </div>
      <p class="note">Each number carries the level the engine gives it. Derived means worked out from logged values; inferred means a named rule decided what counts (here, which commands are test runs), so it could be wrong. Nothing here measures time spent working.</p>`;
  }
  function flagBox(i) {
    const fix = PATTERN_ID.test(i.p.id) ? `<a href="problems.html#${esc(i.p.id)}">See the fix →</a>` : '';
    const zh = RM.zoomHref(i.f);
    // One step with no scope zooms to itself, which the panel already shows; a scope frames more.
    const zoom = zh && ((i.f.zoom?.events?.length ?? 0) > 1 || i.f.zoom?.scope) ? `<a href="${esc(zh)}" data-zoomlink>Zoom to these steps</a>` : '';
    return `<div class="sel-flag">${fchip(i)}<p>${esc(i.f.note || i.f.checkTitle)}</p>${fix || zoom ? `<p class="sel-links">${fix}${zoom}</p>` : ''}</div>`;
  }
  function panel() {
    const box = $('panel');
    const wasOpen = $('selMore')?.open ?? false;
    const e = HW.data.byId.get(selId);
    if (!e) {
      box.innerHTML = '<h2 class="sel-k">Selected step</h2><p class="sel-none">No step to show here.</p>';
      return;
    }
    const flags = F.flags.get(e.id) ?? [];
    const full = logText(e) ?? detailText(e);
    const res = resultOf(e);
    const sp = RM.spanOf(e);
    const dot = '<span aria-hidden="true">·</span>';
    box.innerHTML = `<h2 class="sel-k">Selected step</h2>
      <p class="sel-meta"><span>${esc(time(e.t, { day: multiDay, seconds: true }))}</span>${dot}<span>${esc(laneLabel(e))}</span>${dot}${chip(e.ev)}${multi ? `${dot}<span>Session ${mains.indexOf(sessionAt(e.t)) + 1} of ${mains.length}</span>` : ''}${sp != null ? `${dot}<span>recorded span ${esc(RM.spanText(sp))}</span> ${sym('derived')}` : ''}</p>
      <p class="sel-title">${esc(stepTitle(e))}</p>
      ${full ? (QUOTED.has(e.kind) ? `<p class="sel-quote"><span>${esc(full)}</span></p>` : `<pre class="sel-code"><span>${esc(full)}</span>${e.patch ? `<span> +${e.patch.added ?? 0} −${e.patch.removed ?? 0}</span>` : ''}</pre>`) : ''}
      ${res ? `<p class="sres${res.fail ? ' fail' : ''}">${esc(res.text)} ${sym(res.level)}</p>` : ''}
      ${flags.length ? `<div class="sel-flags">${flags.map(flagBox).join('')}</div>` : `<p class="sel-none">${F.loaded ? 'No problem found at this step.' : F.failed ? "Problem checks couldn't load." : 'Checking for problems…'}</p>`}
      <button type="button" class="sel-full" id="selFull" data-id="${esc(e.id)}" title="Every field and the original log line">Full record</button>
      <details class="sel-more" id="selMore"${wasOpen ? ' open' : ''}><summary>At this moment</summary>${moment()}</details>`;
    // Each record listed in the fold is a button: Tab reaches it, and Enter or Space opens it.
    box.querySelectorAll('li[data-id], a[data-id]').forEach((li) => {
      if (li.tagName !== 'A') {
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
      }
      li.addEventListener('click', (ev) => {
        ev.preventDefault();
        HW.openEvent(li.dataset.id);
      });
      li.addEventListener('keydown', (ev) => {
        if (li.tagName === 'A' || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        HW.openEvent(li.dataset.id);
      });
    });
  }

  // ---- the summary over the chart ------------------------------------------------------------
  function summary() {
    const el = $('pSummary');
    el.title = '';
    if (F.failed) {
      el.textContent = "Problem checks couldn't load";
      el.title = F.failed;
      return;
    }
    if (!F.loaded) {
      el.textContent = 'Checking for problems…';
      return;
    }
    const c = F.counts;
    const pills = ['high', 'medium', 'low'].filter((t) => c[t]).map((t) => `<span class="tierpill t-${t}">${c[t]} ${t}</span>`).join('');
    const ids = sessionKeys.filter((k) => isId('session', k));
    // Numbered as the chart numbers its main agents, by when each session started.
    const sessionNo = (k, n) => (mains.findIndex((m) => m.a.session === k) + 1 || n + 1);
    const one = ids.length === 1 ? `<a href="problems.html?session=${encodeURIComponent(ids[0])}">Open in Problems</a>` : ids.length > 1 ? `<span>Open in Problems: ${ids.map((k, n) => `<a href="problems.html?session=${encodeURIComponent(k)}">session ${sessionNo(k, n)}</a>`).join(', ')}</span>` : '';
    el.innerHTML = `<strong>${c.look ? `${plural(c.look, 'problem')} worth a look ${sym(window.HWE.weakest(c.levels))}` : `Nothing worth a look in ${whose()}`}</strong>${c.possible ? `<span class="kbd">${c.possible} of them possible: a rule read the words, or a record is missing</span>` : ''}${pills}${c.routine ? `<label><input type="checkbox" id="showRoutine"${showRoutine ? ' checked' : ''}> Show routine notes (${c.routine})</label>` : ''}${c.dismissed ? `<span class="kbd">${c.dismissed} hidden: you marked their pattern not a problem</span>` : ''}${one}`;
  }
  async function loadFindings(thread) {
    try {
      PA = await HW.load('problems', { thread });
      if (!PA || !Array.isArray(PA.findings)) PA = { findings: [], patterns: [] };
    } catch (err) {
      if (err?.code === 'shown') return;
      F = { loaded: false, failed: `The problem checks couldn't be read: ${err?.message ?? err}`, items: [], flags: new Map(), dots: [], counts: null };
      summary();
      render();
      return;
    }
    // The whole catalog's ids, never only this page's: an override for a pattern with no finding
    // here must stay.
    if (Array.isArray(PA.catalogIds)) prefs.setKnown(PA.catalogIds);
    collect();
  }
  function collect() {
    if (!PA) return;
    const items = RM.findingItems(PA, { tierOf: (p) => window.HWPrefs.effective(prefs, p), sessions: sessionKeys, eventT: (id) => HW.data.byId.get(id)?.t ?? null });
    F = { loaded: true, failed: null, items, flags: RM.flagsByEvent(items), dots: RM.problemDots(items), counts: RM.tierCounts(items) };
    summary();
    renderStory();
    render();
  }

  // ---- the story -------------------------------------------------------------------------------
  const NOUN = {
    'cat:shell': ['shell command', 'shell commands'], 'cat:edit': ['file edit', 'file edits'], 'cat:read': ['file read', 'file reads'], 'cat:search': ['search', 'searches'], 'cat:web': ['web lookup', 'web lookups'], 'cat:delegate': ['helper started', 'helpers started'], 'cat:agent-message': ['message to another agent', 'messages to another agent'], 'cat:plan': ['plan update', 'plan updates'], 'cat:question': ['question to you', 'questions to you'], 'cat:skill': ['skill used', 'skills used'], 'cat:wait': ['wait', 'waits'], 'cat:meta': ['tool lookup', 'tool lookups'], 'cat:browser': ['browser step', 'browser steps'], 'cat:external': ['connected-tool call', 'connected-tool calls'],
    test: ['test run', 'test runs'], 'kind:message': ['message', 'messages'], 'kind:agent-message': ['message between agents', 'messages between agents'], 'kind:turn-end': ['turn end', 'turn ends'], 'kind:notification': ['completion notice', 'completion notices'], 'kind:session': ['session start', 'session starts'], 'kind:outcome': ['git record', 'git records'], 'kind:guard': ['refusal', 'refusals'], 'kind:error': ['error', 'errors'],
  };
  const nounOf = (kind, n) => {
    const w = NOUN[kind];
    if (w) return w[n === 1 ? 0 : 1];
    if (String(kind).startsWith('tool:')) return `${kind.slice(5)} calls`;
    return `${String(kind).replace(/^(kind|cat):/, '')} records`;
  };
  /** A step stands alone in the story when it has a finding, the agent waited on it, or it's a
   *  failed test run, so a group never hides a failure. */
  const standsAlone = (e) => F.flags.has(e.id) || RM.isLongWait(e) || !!resultOf(e)?.fail;
  const quietRow = (e) => mode === 'matters' && (RM.storyKind(e) === 'cat:shell' || ['turn-end', 'session', 'notification'].includes(e.kind));
  const gapWords = (g) => {
    const l = gapLabel.get(g[0]);
    return l ? `${piecesHtml(l.pieces)} ${sym(l.level)}` : esc(RM.minText(g[1] - g[0]));
  };
  function codeLine(e) {
    const t = logText(e);
    if (!t) {
      const d = detailText(e);
      return d ? `<span class="scode"><span>${HW.clipHtml(d, 300)}</span></span>` : '';
    }
    if (QUOTED.has(e.kind)) return `<span class="squote">“<span>${HW.clipHtml(t, 500)}</span>”</span>`;
    return `<code class="scode"><span>${HW.clipHtml(t, 300)}</span>${e.patch ? `<span> +${e.patch.added ?? 0} −${e.patch.removed ?? 0}</span>` : ''}</code>`;
  }
  const byWhom = (e) => (e.actor === 'agent' && e.agent && !mainKeys.has(e.agent) ? ` · ${HW.agentLabel(e.agent)}` : '');
  /** In the problem focus's steps list: a step's part in the problem (its own steps marked, the
   *  ones its frame holds tagged "context") and "See in the whole session", the replay's address
   *  for that step out of the focus. Nothing outside that list. */
  const focusList = () => !!Z && !focusWide;
  function focusTag(e) {
    const role = focusList() ? zRole(e.id) : null;
    return role && role !== 'ring' ? `<span class="ftag" title="${esc(ROLE_TIP[role] ?? '')}">context</span>` : '';
  }
  function wholeLink(e) {
    const href = focusList() ? RM.wholeHref(e, base) : null;
    return href ? `<a class="fwhole" href="${esc(href)}" data-wholelink="${esc(e.id)}">See in the whole session</a>` : '';
  }
  function stepRowHtml(e) {
    const flags = F.flags.get(e.id) ?? [];
    const strong = flags.some((i) => i.look && i.tier === 'high');
    const res = resultOf(e);
    const quiet = !flags.length && !RM.isLongWait(e) && quietRow(e);
    const chips = `${focusTag(e)}${RM.isLongWait(e) ? waitChip(e) : ''}${flags.map(fchip).join('')}`;
    const hot = focusList() && zRole(e.id) === 'ring';
    return `<li class="srow${quiet ? ' dim' : ''}${strong ? ' strong' : ''}${hot ? ' hot' : ''}" data-id="${esc(e.id)}"><span class="stime">${esc(stime(e.t))}</span><span class="kd ${kindClass(e)}" aria-hidden="true"></span><div class="smain"><button type="button" class="sbtn" data-sel="${esc(e.id)}"><span class="stitle">${esc(stepTitle(e))}${esc(byWhom(e))}</span>${codeLine(e)}${res ? `<span class="sres${res.fail ? ' fail' : ''}">${esc(res.text)} ${sym(res.level)}</span>` : ''}</button>${chips ? `<div class="schips">${chips}</div>` : ''}${wholeLink(e)}</div><span class="sev">${sym(e.ev)}</span></li>`;
  }
  const kidRes = (e) => {
    const res = resultOf(e);
    return res ? ` <span class="sres">${esc(res.text)} ${sym(res.level)}</span>` : '';
  };
  function groupRowHtml(r) {
    const open = mode === 'all' || openGroups.has(r.group);
    const first = r.steps[0];
    const last = r.steps[r.steps.length - 1];
    const title = `${r.steps.length} ${nounOf(r.kind, r.steps.length)}, ${stime(first.t)} to ${stime(last.t)}${byWhom(first)}`;
    const kids = open ? `<ol class="kids">${r.steps.map((e) => `<li class="kid" data-id="${esc(e.id)}"><button type="button" class="kbtn" data-sel="${esc(e.id)}"><span class="stime">${esc(stime(e.t))}</span><code><span>${HW.clipHtml(logText(e) ?? stepTitle(e), 220)}</span></code>${kidRes(e)} ${sym(e.ev)}</button>${wholeLink(e)}</li>`).join('')}</ol>` : '';
    const toggle = mode === 'all' ? '' : `<button type="button" class="gtoggle" data-toggle="${esc(r.group)}" aria-expanded="${open}">${open ? 'Hide' : `Show ${r.steps.length} steps`}</button>`;
    // A group in the focus's list is made of steps its frame holds: tagged once, on the group.
    const tag = focusTag(first);
    return `<li class="srow grp" data-group="${esc(r.group)}"><span class="stime">${esc(stime(first.t))}</span><span class="kd ${kindClass(first)}" aria-hidden="true"></span><div class="smain"><button type="button" class="sbtn" data-sel="${esc(first.id)}"><span class="stitle">${esc(title)}</span>${open ? '' : codeLine(first)}</button>${tag ? `<div class="schips">${tag}</div>` : ''}${kids}</div>${toggle}<span class="sev">${sym(window.HWE.weakest(r.steps.map((e) => e.ev)))}</span></li>`;
  }
  const rowHtml = (r) => (r.gap ? `<li class="srow sgaprow">${gapWords(r.gap)}</li>` : r.group ? groupRowHtml(r) : stepRowHtml(r.step));
  // ---- the story's length: never a whole long session at once -----------------------------------
  // Drawn whole, a long session's story ran to hundreds of screens (72 prompts and 2,699 rows on
  // one real session). A session with a few prompts shows them all; a longer one shows the card
  // holding the selected step and one on each side, with buttons for the rest. A card with many
  // rows shows its first ones and asks before drawing the rest; the selected row is always drawn.
  const CARDS_ALL = 5; // this many prompt cards or fewer show whole
  const CARDS_NEAR = 1; // otherwise, cards on each side of the selected step's card
  const CARDS_STEP = 3; // how many more cards one "Show earlier" or "Show later" adds
  const ROWS_ALL = 15; // a card with more rows than this shows its first ROWS_FIRST
  const ROWS_FIRST = 10;
  let storyWin = null; // { from, to }: the cards drawn, by index
  const openCards = new Set(); // cards drawn with every row
  /** The cards to draw: all of them when few, else the window, moved to hold card `c`. */
  function windowFor(c) {
    const n = story.cards.length;
    if (n <= CARDS_ALL) return { from: 0, to: n - 1 };
    const at = Number.isInteger(c) && c >= 0 ? c : n - 1;
    if (storyWin && at >= storyWin.from && at <= storyWin.to && storyWin.to < n) return storyWin;
    return { from: Math.max(0, at - CARDS_NEAR), to: Math.min(n - 1, at + CARDS_NEAR) };
  }
  function cardHtml(c) {
    const i = story.cards.indexOf(c);
    const p = c.prompt;
    let head;
    if (p) {
      const corr = isCorrection(p) ? ` <span class="rtag corr" title="${esc(HW.data.rules['prompt.correction'] ?? 'A rule reads the opening words as a correction.')}">you corrected it ${sym('inferred')}</span>` : '';
      const sess = multi ? ` <span class="rtag sess">session ${mains.indexOf(sessionAt(p.t)) + 1}</span>` : '';
      const w = HW.who(p);
      head = `<button type="button" class="shead" data-sel="${esc(p.id)}" data-id="${esc(p.id)}"><span class="stime">${esc(time(p.t, { day: multiDay }))}</span><span class="sbody"><span class="sask"><strong>${esc(stepTitle(p))}</strong>${w.level !== 'recorded' ? ` ${sym(w.level)}` : ''}${corr}${sess}</span><span class="sprompt"><span>${HW.clipHtml(logText(p) ?? '', 1500)}</span></span></span></button>`;
    } else head = `<div class="shead first"><span class="stime">${c.steps[0] ? esc(time(c.steps[0].t, { day: multiDay })) : ''}</span><span class="sbody"><strong>Before the first prompt</strong></span></div>`;
    const cut = c.rows.length > ROWS_ALL && !openCards.has(i);
    const rows = cut ? c.rows.slice(0, ROWS_FIRST) : c.rows;
    const more = cut ? `<li class="srow smore"><button type="button" class="linklike" data-morerows="${i}">Show ${c.rows.length - ROWS_FIRST} more rows</button></li>` : '';
    return `<article class="rcard" data-card="${i}">${head}${c.rows.length ? `<ol class="srows">${rows.map(rowHtml).join('')}${more}</ol>` : ''}</article>`;
  }
  /** The drawn cards, with the gaps between them, and a button for the cards on either side. */
  function storyHtml() {
    const n = story.cards.length;
    const { from, to } = storyWin;
    const inWin = (o) => (o.gap ? true : story.cards.indexOf(o) >= from && story.cards.indexOf(o) <= to);
    // A gap shows only between two drawn cards.
    const order = story.order.filter(inWin);
    while (order[0]?.gap) order.shift();
    while (order.at(-1)?.gap) order.pop();
    const earlier = from > 0 ? `<button type="button" class="btn smorecards" data-morecards="earlier">Show earlier prompts <span class="muted">(${from})</span></button>` : '';
    const later = to < n - 1 ? `<button type="button" class="btn smorecards" data-morecards="later">Show later prompts <span class="muted">(${n - 1 - to})</span></button>` : '';
    return `${earlier}${order.map((o) => (o.gap ? `<div class="sgap">${gapWords(o.gap)}</div>` : cardHtml(o))).join('')}${later}`;
  }
  /** One more step of cards on one side, keeping the reader's place on the page. */
  function moreCards(side) {
    const n = story.cards.length;
    storyWin = side === 'earlier' ? { from: Math.max(0, storyWin.from - CARDS_STEP), to: storyWin.to } : { from: storyWin.from, to: Math.min(n - 1, storyWin.to + CARDS_STEP) };
    const body = $('storyBody');
    const anchor = side === 'earlier' ? body.querySelector('.rcard') : null;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    body.innerHTML = storyHtml();
    storySelect(selId, { open: false });
    if (anchor) {
      const again = body.querySelector(`.rcard[data-card="${anchor.dataset.card}"]`);
      if (again) window.scrollBy(0, again.getBoundingClientRect().top - before);
    }
    body.querySelector(`[data-morecards="${side}"]`)?.focus({ preventScroll: true });
  }
  function renderStory() {
    if (focusList()) {
      // The problem focus: one list from the problem's first step to its last, holding only its
      // steps and the steps its frame holds. Its own and the ones its scope names stand alone; a
      // stretch's steps group in runs, as everywhere.
      const rows = RM.groupRuns(navSteps, { flagged: (e) => standsAlone(e) || zRole(e.id) !== 'stretch' });
      const card = { prompt: null, steps: navSteps, rows };
      story = { cards: [card], order: [card] };
      $('storyBody').innerHTML = rows.length ? `<article class="rcard fsteps" data-card="0"><ol class="srows">${rows.map(rowHtml).join('')}</ol></article>` : '<p class="kbd">None of its steps is of a kind shown.</p>';
    } else {
      story = RM.buildStory(navSteps, { gaps, flagged: standsAlone });
      const at = selId ? RM.locate(story, selId) : null;
      if (at && story.cards[at.card]?.rows.length > ROWS_ALL && !at.prompt && !story.cards[at.card].rows.slice(0, ROWS_FIRST).some((r) => r.step?.id === selId || (r.group && r.group === at.group))) openCards.add(at.card);
      storyWin = windowFor(at?.card);
      $('storyBody').innerHTML = story.cards.length ? storyHtml() : '<p class="kbd">No step of the kinds shown.</p>';
    }
    storySelect(selId, { open: false });
  }
  const storyRow = (id) => {
    const body = $('storyBody');
    const row = body.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) return row;
    const at = RM.locate(story, id);
    return at?.group ? body.querySelector(`[data-group="${CSS.escape(at.group)}"]`) : null;
  };
  function redrawGroup(key) {
    const body = $('storyBody');
    const li = body.querySelector(`[data-group="${CSS.escape(key)}"]`);
    const r = story.cards.flatMap((c) => c.rows).find((x) => x.group === key);
    if (li && r) li.outerHTML = groupRowHtml(r);
  }
  /** The selected step's row: highlighted, with "See it in the timeline"; with `open`, its group
   *  opens first. */
  function storySelect(id, { open = true } = {}) {
    const body = $('storyBody');
    body.querySelectorAll('.is-sel').forEach((el) => el.classList.remove('is-sel'));
    body.querySelector('.totl')?.remove();
    if (!id) return;
    const at = RM.locate(story, id);
    if (open && at?.group && mode !== 'all' && !openGroups.has(at.group)) {
      openGroups.add(at.group);
      redrawGroup(at.group);
    }
    let row = storyRow(id);
    if (!row && at && storyWin && !focusList()) {
      // A step the story hasn't drawn: draw its card, with every row when it sits past the first.
      storyWin = windowFor(at.card);
      if (story.cards[at.card]?.rows.length > ROWS_ALL) openCards.add(at.card);
      body.innerHTML = storyHtml();
      row = storyRow(id);
    }
    if (!row) return;
    row.classList.add('is-sel');
    const link = '<button type="button" class="linklike totl" data-totl>↑ See it in the timeline</button>';
    if (row.classList.contains('shead')) row.insertAdjacentHTML('afterend', link);
    else if (row.classList.contains('kid')) row.insertAdjacentHTML('beforeend', link);
    else row.querySelector(':scope > .smain')?.insertAdjacentHTML('beforeend', link);
  }
  function toggleGroup(key) {
    if (openGroups.has(key)) openGroups.delete(key);
    else openGroups.add(key);
    redrawGroup(key);
    storySelect(selId, { open: false });
    $('storyBody').querySelector(`[data-toggle="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }
  function setMode(m) {
    mode = m;
    // The story's cards and rows are built again for the new mode: start from the selected step.
    storyWin = null;
    openCards.clear();
    $('modeMatters').setAttribute('aria-pressed', String(m === 'matters'));
    $('modeAll').setAttribute('aria-pressed', String(m === 'all'));
    $('modeNote').textContent = m === 'matters' ? 'Repeated steps are grouped.' : 'Every recorded step, in order.';
    renderStory();
  }
  /** "↓ In the steps": the selected step's row, scrolled to and focused. */
  function toStory() {
    if (!selId) return;
    storySelect(selId, { open: true });
    const row = storyRow(selId);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    (row.matches('[data-sel]') ? row : row.querySelector('[data-sel]'))?.focus({ preventScroll: true });
  }
  /** "↑ See it in the timeline": the chart, with focus on the selected step's mark. */
  function toTimeline() {
    $('timeline').scrollIntoView({ block: 'start' });
    const m = selId ? svg.querySelector(`.mark[data-id="${CSS.escape(selId)}"]`) : null;
    (m ?? $('timeline')).focus({ preventScroll: true });
  }

  // ---- selecting a step ---------------------------------------------------------------------
  /** The record panel follows the record it was opened for; a new selection from anywhere else
   *  closes it without moving focus. */
  function closeRecordQuietly() {
    if (!document.querySelector('.drawer.open')) return;
    const a = document.activeElement;
    HW.closeDrawer();
    if (a && a !== document.body && document.contains(a)) a.focus({ preventScroll: true });
  }
  /** Select step `id`: the playhead, the now line, the story's row (its group opened) and the
   *  Selected step panel follow. With `record`, its full record opens too. */
  function select(id, { from = 'chart', record = false, focusNav = 0, announce = false, follow = true } = {}) {
    const e = HW.data.byId.get(id);
    if (!e) return false;
    const changed = id !== selId;
    selId = id;
    playhead = e.t;
    if (Z) {
      const zi = Z.ids.indexOf(id);
      if (zi >= 0 && zi !== Z.i) {
        Z.i = zi;
        zoomPanel();
      }
    }
    if (!record && changed && from !== 'drawer') closeRecordQuietly();
    storySelect(id, { open: true });
    if (follow && (playhead < view[0] || playhead > view[1])) {
      const w = view[1] - view[0];
      setView(playhead - w / 2, playhead + w / 2);
    } else render();
    if (announce) HW.announce(HW.describeStepPieces(e));
    if (record) HW.openEvent(id, { focusNav });
    return true;
  }
  /** The step at moment `t` (the last at or before it), selected. */
  const selectAt = (t, opts = {}) => {
    const e = RM.stepAt(navSteps, t);
    if (e) select(e.id, opts);
  };
  const stepTo = (dir, list = navSteps) => {
    const i = list.findIndex((e) => e.id === selId);
    const next = i >= 0 ? list[i + dir] : dir > 0 ? list.find((e) => e.t > playhead) : [...list].reverse().find((e) => e.t < playhead);
    if (next) return select(next.id, { from: 'controls', announce: true });
    // In a problem's focus, ◀ Step past its first step goes on to what came before it in its lane.
    const e = dir < 0 && Z && list === navSteps ? HW.data.byId.get(selId) : null;
    const pr = e ? priorOf(e) : null;
    if (pr) goBefore(pr.step.id);
  };
  /** Previous problem or Next problem: the step of the finding worth a look before or after. */
  function problem(dir) {
    const id = RM.problemStep(RM.problemDots(F.items), { t: playhead, id: selId, dir });
    if (id) select(id, { from: 'controls', announce: true });
  }
  function pickDots(keys) {
    const list = keys.map((k) => F.items[k]).filter(Boolean);
    if (!list.length) return;
    const ts = list.map((i) => i.t);
    const a = Math.min(...ts);
    const b = Math.max(...ts);
    if (list.length > 1 && b - a >= 2000 && view[1] - view[0] > 25e3) {
      const pad = Math.max(10e3, (b - a) * 0.25);
      setView(a - pad, b + pad);
      return;
    }
    const top = [...list].sort((p, q) => (p.look === q.look ? 0 : p.look ? -1 : 1) || RM.RANK[p.tier] - RM.RANK[q.tier])[0];
    if (top.known) select(top.event, { from: 'problems', announce: true });
    else selectAt(top.t, { from: 'problems', announce: true });
  }
  /** The step and its full record, as the record panel's Previous and Next step, a fact's
   *  receipt and the address ask. With `zoom`, the chart zooms to five minutes around it. */
  function showAt(id, { zoom = true, focusNav = 0 } = {}) {
    const e = HW.data.byId.get(id);
    if (!e) return false;
    if (zoom) {
      selId = id;
      playhead = e.t;
      storySelect(id, { open: true });
      setView(e.t - 150e3, e.t + 150e3, '300000');
      HW.openEvent(e.id, { focusNav });
      return true;
    }
    return select(id, { from: 'drawer', record: true, focusNav });
  }

  function setView(a, b, preset) {
    const min = 20e3;
    if (b - a < min) {
      const m = (a + b) / 2;
      a = m - min / 2;
      b = m + min / 2;
    }
    view = [Math.max(T0 - 60e3, a), Math.min(T1 + 60e3, b)];
    const isWhole = view[0] <= T0 && view[1] >= T1;
    // While a finding is zoomed, the fit control and "Whole session" stay usable even when its
    // steps span the whole session, since choosing either is how the zoom is left.
    $('zoom').value = isWhole && !Z ? '0' : preset ?? 'custom';
    $('fit').disabled = isWhole && !Z;
    const bar = $('zoombar');
    bar.hidden = isWhole;
    if (!isWhole) bar.innerHTML = `Zoomed in: showing ${esc(time(view[0], { seconds: true, day: multiDay }))} to ${esc(time(view[1], { seconds: true, day: multiDay && HW.dayOf(view[0]) !== HW.dayOf(view[1]) }))} (${esc(dur(view[1] - view[0]))} of ${esc(dur(T1 - T0))} in all). <button type="button" data-fit>⤢ Back to ${WHOLE}</button> <span class="kbd">or press Esc, or double-click the chart</span>`;
    bar.querySelector('[data-fit]')?.addEventListener('click', fitAll);
    render();
  }
  /** Back to the whole thread, leaving a finding's zoom and clearing its marks. */
  function fitAll() {
    if (Z) clearZoom();
    setView(T0, T1);
  }
  // ---- zoomed to a finding: the steps its check recorded, and only those ---------------------
  const LEVEL_HOW = {
    recorded: 'the log records each one',
    derived: "worked out from the log's facts",
    inferred: 'a named rule picked them, so it could be wrong',
    missing: "the check matched it, and a record it expected isn't in the logs",
  };
  const cap = (t) => `${t[0].toUpperCase()}${t.slice(1)}`;
  /** The steps a scope names beside its own, in words. */
  const ROLE_WORDS = {
    prompt: "Your prompt before the finding's steps",
    next: 'Your next prompt',
    message: "The turn's last message",
    helper: "The helper's last record",
    parent: 'The parent agent carrying on',
  };
  /** Why a step in the focus's list is context: a step its scope names, or one inside its stretch. */
  const ROLE_TIP = { ...ROLE_WORDS, stretch: "Inside the problem's stretch" };
  /** How each kind of scope frames its finding, for the "?" fold. */
  const FRAME_HOW = {
    moment: 'The view runs from your prompt before these steps to the last of them, so you can see whether it was asked for.',
    stretch: "The shaded stretch runs from where it started to where it ended, and the line marks its start. That agent's steps inside it stay bright: they're the stretch, not each a problem. Long stretches with no new step are squeezed inside it, as everywhere on the chart.",
    repeat: 'Each repetition is numbered in order.',
    'hand-off': 'The view runs from the helper starting to its parent carrying on. The hatched part runs from the helper\'s last record to the parent\'s next one, where no hand-back is recorded.',
    'turn-end': "The view runs from the turn's last message to your next prompt, with the wait between them hatched, or to the session's last record when no prompt follows.",
  };
  const GAP_TIP = {
    'hand-off': "No hand-back is recorded from the helper's last record to the parent carrying on (derived from recorded times).",
    'turn-end': 'The wait for your next prompt (derived from recorded times).',
  };
  /** How a step stands in the zoom: 'ring', a role its scope names it for, 'stretch', or null. */
  function zRole(id) {
    if (!Z) return null;
    if (!Z.S) return Z.set.has(id) ? 'ring' : null;
    return RM.scopeRole(Z.S, HW.data.byId.get(id), { set: Z.set, marks: Z.marks });
  }
  /** The scope's stretch, shaded from its start to its end with a line at the start, and its gap,
   *  hatched, each clipped to the view. */
  function scopeBands(S, { x, H, v0, v1 }) {
    const band = (o, cls, tip, extra = '') => {
      const a = Math.max(o.from, v0);
      const b = Math.min(o.to, v1);
      if (b < a) return '';
      const x0 = Math.max(LEFT, x(a));
      return `<rect class="${cls}" x="${x0}" y="16" width="${Math.max(2, x(b) - x0)}" height="${H - 16}"${extra}><title>${esc(tip)}</title></rect>`;
    };
    let out = '';
    if (S.stretch) {
      out += band(S.stretch, 'zstretch', `${S.caption ?? 'The finding'}: shaded from where it started to where it ended.`);
      if (S.stretch.from >= v0 && S.stretch.from <= v1) out += `<line class="zstart" x1="${x(S.stretch.from)}" x2="${x(S.stretch.from)}" y1="16" y2="${H}"><title>Where it started</title></line>`;
    }
    if (S.gap) out += band(S.gap, 'zgap', GAP_TIP[S.kind] ?? 'Nothing recorded here (derived from recorded times).', ' fill="url(#hatch)"');
    return out;
  }
  /** How the set of steps is known, never more than the check recorded. */
  function zoomHow(f, z) {
    const check = `the check “${f.checkTitle ?? f.check}”`;
    const recorded = z.events.length + (z.unread ?? 0);
    let what;
    if (z.near) what = `It isn't a set of steps: ${check} measures model calls, which aren't steps on this timeline, so it records only the step nearest where the finding starts${f.lastAt ? `, and the finding runs to ${time(toT(f.lastAt), { day: multiDay, seconds: true })}` : ''}. That one step is marked; nothing after it is guessed.`;
    else if (z.total === 1) what = `${cap(check)} matched one step, and that's the one marked.`;
    else if (z.total != null && z.total > recorded) what = `${cap(check)} matched ${plural(z.total, 'step')} and recorded the ids of ${recorded}. Only those are marked; the rest aren't guessed.`;
    else what = `These are the ${plural(recorded, 'step')} ${check} matched, and only those.`;
    // A finding that says which of its parts the log records and which are worked out lists them.
    const basis = Array.isArray(f.basis) && f.basis.length ? ` ${f.basis.map((b) => `${chip(b.level)} ${esc(b.part)}: ${esc(HW.lowerFirst(b.how))}`).join(' ')}` : '';
    // A scope says how the view frames the finding.
    const frame = Z?.S && FRAME_HOW[Z.S.kind] ? ` ${esc(FRAME_HOW[Z.S.kind])}` : '';
    return `${esc(cap(LEVEL_HOW[f.verdictEvidence] ?? f.verdictEvidence))}. ${esc(what)}${frame}${basis}`;
  }
  const laneName = (l) => (l.thread !== base ? 'Another thread' : mainKeys.has(l.agent) ? HW.data.mainLabels.get(l.agent) ?? 'Main agent' : l.agent ? HW.agentLabel(l.agent) : 'No agent');
  /** The lanes the focus gives a row of their own, in a few words: "You and Main agent; the
   *  rest is folded". */
  function laneNote() {
    if (!Z?.lanes) return '';
    const { shown: mine, other } = RM.splitLanes(LANES, Z.lanes);
    const names = mine.map((l) => (l.key === 'person' ? 'You' : l.agent ? 'a helper' : l.label));
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
    return other.length ? `${list}; the rest is folded` : list;
  }
  function zoomPanel() {
    syncFocus();
    const bar = $('zoomFinding');
    if (!Z) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const { f, z } = Z;
    const n = Z.ids.length;
    const notDrawn = Z.ids.filter((id) => {
      const p = placed.find((q) => q.e.id === id);
      return !p || hiddenFamilies.has(family(p));
    }).length;
    const elsewhere = (l) => l.events.every((id) => !HW.data.byId.has(id));
    const stepBtn = (id) => `<button type="button" class="linklike" data-zstep="${Z.ids.indexOf(id)}" aria-label="Step ${Z.ids.indexOf(id) + 1} of ${n} in the finding">${Z.ids.indexOf(id) + 1}</button>`;
    const lanes = z.lanes.length > 1 ? `<p class="zlanes">${z.lanes.map((l) => {
      if (elsewhere(l)) {
        const href = isId('session', l.session) && isId('thread', l.thread) && l.thread !== base ? `replay.html?session=${encodeURIComponent(l.session)}#${l.thread}~zoom~${Z.key}` : null;
        return `${esc(laneName(l))}, ${esc(plural(l.events.length, 'step'))}${href ? ` (<a href="${esc(href)}">open it zoomed</a>)` : ''}`;
      }
      return `${esc(laneName(l))}: ${l.events.filter((id) => Z.set.has(id)).map(stepBtn).join(' ')}`;
    }).join(' · ')}.</p>` : '';
    // The chart's one line in the problem focus: which lanes it shows, a "?" fold with how the
    // steps are known and what's missing, and the controls that step through them. The caption
    // and its mark sit on the "What happened" card above.
    const count = z.near ? '1 step, nearest' : z.total != null && z.total > n ? `${n} of ${plural(z.total, 'step')}` : plural(n, 'step');
    const span = z.threads > 1 ? ` · ${z.threads} threads` : z.agents > 1 ? ` · ${z.agents} agents` : '';
    bar.hidden = false;
    bar.innerHTML = `<strong class="zon">On the timeline</strong> <span class="zcap">${esc(laneNote() || `${count}${span}`)}</span>
      <details class="zwhy"><summary title="How the steps are known" aria-label="How the steps are known">?</summary><p>${zoomHow(f, z)}${z.unread ? ` ${esc(plural(z.unread, 'recorded step'))} ${z.unread === 1 ? "isn't" : "aren't"} in this page's records.` : ''}${notDrawn ? ` ${notDrawn} ${notDrawn === 1 ? "isn't" : "aren't"} drawn: that kind of record is hidden.` : ''}</p>${lanes}</details>
      <span class="zctl" role="group" aria-label="Step through the finding's steps"><button type="button" data-zdir="-1" aria-label="Previous step in the finding"${n && Z.i > 0 ? '' : ' disabled'}>◀</button><span class="zpos">${Z.i >= 0 ? `${Z.i + 1} of ${n}` : ''}</span><button type="button" data-zdir="1" aria-label="Next step in the finding"${n && Z.i < n - 1 ? '' : ' disabled'}>▶</button> <button type="button" data-zleave title="Show the whole session (Esc)">⤢ Leave</button></span>`;
  }

  // ---- the problem focus: what happened, the cause drawn, and its steps -----------------------
  /** The page in or out of the problem focus, as Z says: the sections shown or hidden, and drawn
   *  once per finding. */
  function syncFocus() {
    const on = !!Z;
    if (on) document.body.dataset.focus = '1';
    else delete document.body.dataset.focus;
    if (on && focusWide) document.body.dataset.wide = '1';
    else delete document.body.dataset.wide;
    $('focus').hidden = !on;
    $('focusStepsHead').hidden = !on;
    if (!on) {
      focusKey = null;
      return;
    }
    if (focusKey === Z.key) return;
    focusKey = Z.key;
    renderFocus();
  }
  /** Leaving the focus: the lanes open as they were before it, and the steps list whole again. */
  let savedExpanded = null;
  function leaveFocus() {
    if (savedExpanded) {
      expanded.clear();
      savedExpanded.forEach((k) => expanded.add(k));
      savedExpanded = null;
    }
    focusWide = false;
  }
  const STEPS_NOTE = { stretch: 'From where it started to where it ended', repeat: 'Each one, in order', 'hand-off': 'From the helper starting to the parent carrying on', 'turn-end': 'From the last message to your next prompt' };
  /** The steps list's head in the focus: what it holds, and the switch that widens it. */
  function stepsHead() {
    const el = $('focusStepsHead');
    if (!Z) {
      el.innerHTML = '';
      return;
    }
    const S = Z.plan?.S;
    const note = focusWide ? '' : S?.kind === 'moment' ? (S.prompt ? 'Your prompt, then the steps' : '') : STEPS_NOTE[S?.kind] ?? '';
    el.innerHTML = `<h2>${focusWide ? 'Every step in the session' : 'The steps in this problem'}</h2>${note ? `<span class="rp-mode-note">${esc(note)}</span>` : ''}<span class="rp-gap"></span>${Z.plan ? `<button type="button" class="linklike fwide" data-fwide aria-pressed="${focusWide}">${focusWide ? "Show only this problem's steps" : 'Show every step in the session'}</button>` : ''}`;
  }
  /** A step's own words for a card: its quoted text, or its command, file or other words. */
  function stepWords(e, n) {
    const t = logText(e) ?? detailText(e);
    if (!t) return '';
    return QUOTED.has(e.kind) ? `<span class="fquote">“<span>${HW.clipHtml(t, n)}</span>”</span>` : `<code class="fcode"><span>${HW.clipHtml(t, n)}</span></code>`;
  }
  const GAP_TITLE = { 'hand-off': 'No hand-back recorded', 'turn-end': 'The wait' };
  const END_TITLE = { 'hand-off': 'Nothing after it in the session', 'turn-end': 'No prompt after it' };
  /** One card of the cause, drawn: a step (the problem's own outlined in the high colour, a step
   *  its scope names outlined faintly and tagged "context"), a gap, an end, or how many more. */
  function drawCard(it, kind) {
    if (it.more) return `<li class="fstep fmore">${esc(`${it.more} more`)}</li>`;
    if (it.gap) return `<li class="fstep fgap"><span class="fat">${esc(stime(it.gap.from))} to ${esc(stime(it.gap.to))}</span><strong>${esc(GAP_TITLE[kind] ?? 'Nothing recorded')}</strong><span>${esc(RM.spanText(it.gap.to - it.gap.from))} ${sym('derived')}</span></li>`;
    if (it.end) return `<li class="fstep fend"><strong>${esc(END_TITLE[kind] ?? 'Nothing after it')}</strong><span>${sym('derived')}</span></li>`;
    const e = HW.data.byId.get(it.id);
    if (!e) return '';
    const res = resultOf(e);
    const ctx = it.role !== 'ring';
    return `<li class="fstep${ctx ? ' ctx' : ' ring'}">${it.n ? `<span class="fnum" aria-hidden="true">${it.n}</span>` : ''}<button type="button" class="fstep-btn" data-sel="${esc(e.id)}"${it.n ? ` aria-label="${esc(`${it.n}: ${stepTitle(e)}, ${stime(e.t)}`)}"` : ''}><span class="fat">${esc(stime(e.t))} · <span>${esc(HW.clip(laneLabel(e), 40))}</span></span><strong>${esc(stepTitle(e))}</strong>${res ? `<span class="sres${res.fail ? ' fail' : ''}">${esc(res.text)} ${sym(res.level)}</span>` : stepWords(e, 160)}</button><span class="fev">${sym(e.ev)}${ctx ? ` <span class="ftag" title="${esc(ROLE_TIP[it.role] ?? '')}">context</span>` : ''}</span></li>`;
  }
  /** A round number just above `v` for the top of the context chart: 200k over 169k. */
  const niceTop = (v) => {
    const half = 10 ** Math.floor(Math.log10(Math.max(1, v))) / 2;
    return Math.ceil(v / half) * half;
  };
  /** The long-session check's context per model call: a bar per call to scale, the threshold as a
   *  dashed line, the call that crossed it in the high colour, and the calls after it tinted. */
  function contextSvg(c) {
    const box = $('focusDraw');
    const W = Math.max(300, Math.round((box?.clientWidth || 900) - 44));
    const L = 48;
    const TOPPAD = 26;
    const H = 150;
    const BOT = 22;
    const top = niceTop(Math.max(c.max, c.threshold) * 1.06);
    const y = (v) => TOPPAD + H - (v / top) * H;
    const slot = (W - L - 4) / c.calls.length;
    const bw = Math.max(1, slot - (slot > 6 ? Math.min(3, slot * 0.2) : 0));
    const tok = RM.tokensText;
    const bars = c.calls.map((x, i) => `<rect class="cbar${i === c.cross ? ' cross' : i > c.cross ? ' after' : ''}" x="${(L + i * slot).toFixed(1)}" y="${y(x.context).toFixed(1)}" width="${bw.toFixed(1)}" height="${(TOPPAD + H - y(x.context)).toFixed(1)}"><title>${esc(`Model call ${x.n}: ${tok(x.context)} tokens of context, ${stime(x.t)}`)}</title></rect>`).join('');
    const ty = y(c.threshold);
    const cx = L + c.cross * slot + bw / 2;
    const right = cx > W * 0.65;
    const label = `call ${c.cross + 1} passed ${tok(c.threshold)}`;
    const aria = `Context per model call: ${plural(c.calls.length, 'call')}. Call ${c.cross + 1} passed ${tok(c.threshold)} tokens, and ${plural(c.after, 'call')} came after it. The largest was ${tok(c.max)}.`;
    return `<svg class="fctx-svg" viewBox="0 0 ${W} ${TOPPAD + H + BOT}" height="${TOPPAD + H + BOT}" role="img" aria-label="${esc(aria)}">
      <line class="caxis" x1="${L}" x2="${W}" y1="${TOPPAD + H}" y2="${TOPPAD + H}"/>${bars}
      <line class="cline" x1="${L}" x2="${W}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}"/>
      <text class="clabel" x="${L - 6}" y="${TOPPAD + 4}" text-anchor="end">${esc(tok(top))}</text>
      <text class="clabel hot" x="${L - 6}" y="${(ty + 4).toFixed(1)}" text-anchor="end">${esc(tok(c.threshold))}</text>
      <text class="clabel" x="${L - 6}" y="${TOPPAD + H + 4}" text-anchor="end">0</text>
      <text class="clabel hot cmark" x="${right ? cx + bw / 2 : cx - bw / 2}" y="${(ty - 8).toFixed(1)}" text-anchor="${right ? 'end' : 'start'}">${esc(label)}</text>
      <text class="clabel" x="${L}" y="${TOPPAD + H + 16}">call 1</text>
      <text class="clabel" x="${W}" y="${TOPPAD + H + 16}" text-anchor="end">call ${c.calls.length}</text>
    </svg>`;
  }
  /** "The cause, drawn", by the scope's kind. */
  function drawFocus() {
    const box = $('focusDraw');
    const d = Z?.plan?.draw;
    box.hidden = !d;
    if (!d) {
      box.innerHTML = '';
      return;
    }
    const kind = Z.plan.S.kind;
    if (d.draw === 'context') {
      box.innerHTML = `<h2 id="focusDrawH">Context per model call</h2>${contextSvg(d.ctx)}`;
      return;
    }
    const title = d.draw === 'repeat' ? `${d.count} times` : d.draw === 'hand-off' ? 'The hand-off' : d.draw === 'turn-end' ? 'How the turn ended' : 'The sequence';
    box.innerHTML = `<h2 id="focusDrawH">${esc(title)}</h2><ol class="fseq${d.draw === 'repeat' ? ' frep' : ''}">${d.items.map((it) => drawCard(it, kind)).join('')}</ol>`;
  }
  /** The focus's head, its "What happened" card and its cause, drawn. Every word from a log is
   *  the served, redacted text, in an element of its own. */
  function renderFocus() {
    const { f, pattern, plan } = Z;
    const S = plan?.S ?? null;
    const pid = PATTERN_ID.test(pattern?.id ?? '') ? pattern.id : null;
    const eff = pattern ? window.HWPrefs.effective(prefs, pattern) : null;
    const tier = eff ? (eff.tier === 'dismissed' ? 'Not a problem' : TIER_WORD[eff.tier]) : null;
    const sess = (Array.isArray(D.sessions) ? D.sessions : []).find((x) => x.key === f.session);
    const tool = sess?.tool === 'codex' ? 'Codex' : sess?.tool === 'claude' ? 'Claude Code' : null;
    const title = sess?.title ?? D.labels?.[f.session] ?? null;
    const t0 = S ? S.from : toT(f.at);
    const where = [tool ? esc(tool) : '', title ? `“<span>${HW.clipHtml(title, 80)}</span>”` : '', Number.isFinite(t0) ? esc(time(t0, { day: true })) : ''].filter(Boolean).join(' · ');
    $('focusHead').innerHTML = `<a class="fback" href="problems.html">← Problems</a>${tier ? `<span class="tierpill t-${eff.tier === 'dismissed' ? 'low' : esc(eff.tier)}"${eff.mine ? ' title="You set this priority"' : ''}>${esc(tier)}</span>` : ''}<strong class="fname">${esc(pattern?.name ?? f.checkTitle ?? 'A problem')}</strong>${where ? `<span class="fwhere">${where}</span>` : ''}<span class="rp-gap"></span><a class="fall" href="replay.html">All sessions</a><button type="button" class="fleave" data-fleave title="Leave the focus (Esc)">Show the whole session</button>`;
    const level = S?.level ?? f.verdictEvidence;
    const caption = S?.caption ?? f.checkTitle ?? pattern?.name ?? 'A problem';
    const facts = plan?.facts ?? [];
    const c = plan?.cause ?? null;
    const ce = c ? HW.data.byId.get(c.id) : null;
    const cause = ce ? `<div class="fcause"${c.call ? ' title="A model call is not a step: the step shown is the nearest one at or before it."' : ''}><span class="fcause-k">${esc(c.label)}</span><span class="fcause-at">${esc(time(c.t, { seconds: true, day: multiDay }))}${c.call ? `, model call ${c.call}` : ''}</span><button type="button" class="fcause-step" data-sel="${esc(ce.id)}">${c.call ? '<span class="fcause-near">nearest step</span>' : `<span class="fcause-title">${esc(stepTitle(ce))}</span>`}${stepWords(ce, 300)}</button></div>` : '';
    $('focusWhat').innerHTML = `<p class="fk">What happened</p><h1 class="fcap" id="focusCaption">${esc(caption)} ${sym(level)}</h1>${facts.length ? `<ul class="ffacts">${facts.map((x) => `<li${x.title ? ` title="${esc(x.title)}"` : ''}>${esc(x.text)} ${sym(x.level)}</li>`).join('')}</ul>` : ''}${cause}<p class="fbtns">${pid ? `<a class="fbtn fix" href="problems.html#${esc(pid)}">See the fix →</a>` : ''}<button type="button" class="fbtn" data-fsteps>Step through it</button></p>`;
    drawFocus();
    stepsHead();
  }
  /** "Step through it": the list of the problem's steps, its first selected and its row focused. */
  function stepThrough() {
    if (!Z) return;
    if (focusWide) {
      focusWide = false;
      syncFocus();
      stepsHead();
      refilter();
    }
    const first = navSteps[0];
    if (!first) return;
    select(first.id, { from: 'focus', announce: true });
    toStory();
  }
  /** "See in the whole session": the focus left, and step `id` selected in the whole replay, the
   *  chart around it, its record open and its row in the steps scrolled into view. */
  function seeWhole(id) {
    if (!HW.data.byId.has(id)) return false;
    if (Z) {
      Z = null;
      leaveFocus();
      zoomPanel();
      refilter();
    }
    if (!showAt(id)) return false;
    revealStep(id);
    HW.announce([['Out of the problem focus, at: ', false], ...HW.describeStepPieces(HW.data.byId.get(id))]);
    return true;
  }
  /** The selected step's row in the steps, scrolled to the middle of the window. */
  function revealStep(id) {
    storyRow(id)?.scrollIntoView({ block: 'center' });
  }
  /** Go to step i of the finding: selected, with its record open, focus kept on `keep`. */
  function zoomStep(i, keep) {
    if (!Z || i < 0 || i >= Z.ids.length) return;
    Z.i = i;
    const id = Z.ids[i];
    const e = HW.data.byId.get(id);
    if (!showAt(id, { zoom: false })) return;
    HW.announce([[`Step ${i + 1} of ${Z.ids.length} in the finding: `, false], ...HW.describeStepPieces(e)]);
    zoomPanel();
    const bar = $('zoomFinding');
    const again = keep?.dataset?.zdir ? bar.querySelector(`[data-zdir="${keep.dataset.zdir}"]`) : keep?.dataset?.zstep ? bar.querySelector(`[data-zstep="${keep.dataset.zstep}"]`) : null;
    const target = again && !again.disabled ? again : keep ? bar.querySelector('[data-zleave]') : null;
    target?.focus({ preventScroll: true });
  }
  /** Zoom to finding `key`, in the problem focus: its scope's frame with a small margin when it
   *  has one, else its first step to its last; its own steps ringed, only the steps the scope
   *  names beside them, only the lanes it involves, and only its steps in the list. */
  async function applyZoom(key, { open = null, focus = true } = {}) {
    let a;
    try {
      a = await HW.load('problems', { finding: key });
    } catch (err) {
      if (err?.code === 'shown') return;
      HW.addNote(`The finding named in the address couldn't be loaded: ${esc(err?.message ?? err)}`);
      return;
    }
    const f = a?.finding;
    const z = f?.zoom;
    if (!f || !z || !Array.isArray(z.events) || !Array.isArray(z.lanes)) {
      HW.addNote('That finding recorded no step to zoom to.');
      return;
    }
    const held = (id) => isId('event', id) && HW.data.byId.has(id);
    const S = RM.readScope(z.scope, { has: held, tOf: (id) => HW.data.byId.get(id).t });
    const ids = S ? S.steps : z.events.filter(held).sort((p, q) => HW.data.byId.get(p).t - HW.data.byId.get(q).t);
    if (!Z) savedExpanded = new Set(expanded);
    Z = { key, f, z, pattern: a.pattern ?? null, ids, set: new Set(ids), i: -1, S, marks: RM.scopeMarks(S) };
    Z.plan = RM.focusPlan(f, S, {
      ids,
      byId: (id) => HW.data.byId.get(id) ?? null,
      laneOf: (id) => laneById.get(id) ?? null,
      spawned: (id) => [...HW.data.agentByKey.values()].find((x) => x.spawnedBy === id)?.key ?? null,
      context: D.contextCalls ?? null,
      compactionsOf: (agent) => steps.filter((e) => e.kind === 'compaction' && e.agent === agent).length,
      span: RM.spanText,
    });
    Z.lanes = Z.plan ? Z.plan.lanes : null;
    // The focus opens with each lane it shows on one row; leaving it opens them as they were.
    expanded.clear();
    // With none of its steps here, the list keeps every step.
    focusWide = !Z.plan;
    focusKey = null;
    zoomPanel();
    refilter();
    if (ids.length) {
      const es = ids.map((id) => HW.data.byId.get(id));
      const s0 = Math.min(...es.map((e) => e.t));
      const s1 = Math.max(...es.map((e) => e.endT ?? e.t));
      const pad = Math.max(15e3, (s1 - s0) * 0.06);
      selId = ids[0];
      playhead = s0;
      storySelect(selId, { open: true });
      if (S) setView(...RM.scopeFrame(S, { within: [T0, T1] }));
      else setView(s0 - pad, s1 + pad);
    } else render();
    zoomPanel();
    const at = open && Z.set.has(open) ? open : null;
    const want = zoomAddress(at ?? (openId && Z.set.has(openId) ? openId : null));
    history.replaceState(null, '', want);
    if (at) zoomStep(Z.ids.indexOf(at));
    else if (focus) $('focusWhat').focus();
    const name = Z.pattern?.name ?? f.checkTitle ?? 'a problem pattern';
    const when = ids.length ? `from ${time(S ? S.from : HW.data.byId.get(ids[0]).t, { day: multiDay, seconds: true })} to ${time(S ? S.to : HW.data.byId.get(ids.at(-1)).t, { day: multiDay, seconds: true })}` : '';
    HW.announce(!ids.length
      ? `None of the steps of the finding “${name}” are in this replay.`
      : S?.caption
        ? `Zoomed to the finding “${name}”, ${when}: ${S.caption}. ${plural(ids.length, 'step')} marked.`
        : `Zoomed to ${plural(ids.length, 'step')} of the finding “${name}”, ${when}. Only those steps are marked.`);
  }
  /** Leave the zoom and the focus: the marks, the bar and the focus's sections go, the lanes and
   *  the steps are whole again, and the address drops the finding. */
  function clearZoom() {
    if (!Z) return;
    const inBar = $('zoomFinding').contains(document.activeElement) || $('focus').contains(document.activeElement);
    Z = null;
    leaveFocus();
    zoomPanel();
    const want = zoomAddress();
    history.replaceState(null, '', want);
    refilter();
    if (inBar) $('zoom').focus();
    HW.announce('Left the zoom. The marks are cleared.');
  }

  /** The record panel's Previous step and Next step: the step before or after, in time order. */
  function neighbour(id, dir) {
    const e = HW.data.byId.get(id);
    if (!e) return null;
    const i = steps.findIndex((x) => x.id === id);
    if (i >= 0) return steps[i + dir] ?? null;
    return dir > 0 ? steps.find((x) => x.t > e.t) ?? null : [...steps].reverse().find((x) => x.t < e.t) ?? null;
  }

  function wire() {
    $('prevStep').addEventListener('click', () => stepTo(-1));
    $('nextStep').addEventListener('click', () => stepTo(1));
    $('prevPrompt').addEventListener('click', () => stepTo(-1, navPrompts));
    $('nextPrompt').addEventListener('click', () => stepTo(1, navPrompts));
    $('prevProblem').addEventListener('click', () => problem(-1));
    $('nextProblem').addEventListener('click', () => problem(1));
    // The slider runs along the whole session's axis, breaks squeezed as on the chart; it selects
    // the step at or before where it stands.
    $('slider').addEventListener('input', (ev) => selectAt(whole.t(Number(ev.target.value)), { from: 'slider', follow: true }));
    $('zoom').addEventListener('change', (ev) => {
      const z = Number(ev.target.value);
      if (!z) return fitAll();
      setView(playhead - z / 2, playhead + z / 2, String(z));
    });
    $('fit').addEventListener('click', fitAll);
    $('zoomFinding').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b || !Z) return;
      if (b.dataset.zleave != null) return fitAll();
      if (b.dataset.zdir) return zoomStep(Z.i + Number(b.dataset.zdir), b);
      if (b.dataset.zstep) zoomStep(Number(b.dataset.zstep), b);
    });
    // "Zoom to these steps" for this thread (the Selected step panel's finding, a record panel's
    // finding box) zooms here as a new history entry, so Back undoes it.
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[data-zoomlink]');
      if (!a || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      const u = new URL(a.href, location.href);
      const parts = u.hash.slice(1).split('~');
      const key = zoomKey(parts);
      if (!key || parts[0] !== base || u.pathname !== location.pathname) return;
      ev.preventDefault();
      const want = `#${base}~zoom~${key}`;
      history.pushState(null, '', want);
      HW.closeDrawer();
      applyZoom(key);
    });
    // The problem focus: "Show the whole session" leaves it, "Step through it" goes to its steps,
    // and a step on the card or in the cause, drawn, is selected.
    $('focus').addEventListener('click', (ev) => {
      if (!Z) return;
      if (ev.target.closest('[data-fleave]')) return fitAll();
      if (ev.target.closest('[data-fsteps]')) return stepThrough();
      const b = ev.target.closest('[data-sel]');
      if (b) select(b.dataset.sel, { from: 'focus', announce: true });
    });
    $('focusStepsHead').addEventListener('click', (ev) => {
      if (!Z || !Z.plan || !ev.target.closest('[data-fwide]')) return;
      focusWide = !focusWide;
      syncFocus();
      stepsHead();
      refilter();
      $('focusStepsHead').querySelector('[data-fwide]')?.focus({ preventScroll: true });
    });
    // "See in the whole session" on a step in the focus's list: the same page out of the focus,
    // at that step, as a new history entry, so Back returns to the focus. A link to another
    // session's page (or one opened in a new tab) loads it, and the address opens that step.
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[data-wholelink]');
      if (!a || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      const u = new URL(a.href, location.href);
      const id = a.dataset.wholelink;
      if (u.pathname !== location.pathname || u.search !== location.search || !isId('event', id) || !HW.data.byId.has(id)) return;
      ev.preventDefault();
      const want = `#${base}~${id}`;
      history.pushState(null, '', want);
      seeWhole(id);
    });
    $('expandAll').addEventListener('click', () => {
      LANES.forEach((l) => expanded.add(l.key));
      expanded.add(HELPERS);
      render();
    });
    $('collapseAll').addEventListener('click', () => {
      expanded.clear();
      render();
    });
    $('play').addEventListener('click', () => {
      const btn = $('play');
      if (timer) {
        clearInterval(timer);
        timer = null;
        btn.textContent = '▶ Play';
        HW.announce(`Paused at ${time(playhead, { day: true, seconds: true })}.`);
        return;
      }
      btn.textContent = '⏸ Pause';
      timer = setInterval(() => {
        const i = navSteps.findIndex((e) => e.id === selId);
        const next = i >= 0 ? navSteps[i + 1] : navSteps.find((e) => e.t > playhead);
        if (!next) return $('play').click();
        select(next.id, { from: 'play' });
      }, 250);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.target.tagName === 'SELECT' || ev.target.tagName === 'INPUT' || HW.ownsSpace(ev) || ev.defaultPrevented) return;
      if (ev.key === 'ArrowRight') stepTo(1, ev.shiftKey ? navPrompts : navSteps);
      else if (ev.key === 'ArrowLeft') stepTo(-1, ev.shiftKey ? navPrompts : navSteps);
      else if (ev.key === ']') problem(1);
      else if (ev.key === '[') problem(-1);
      else if (ev.key === 'Escape' && !document.querySelector('.drawer.open')) fitAll();
      else if (ev.key === ' ') {
        ev.preventDefault();
        $('play').click();
      }
    });
    // Enter on a step selects it; Enter on a lane name opens or folds it; Enter on a dot selects
    // its step.
    // A stretch with no records isn't a step: Enter or a click opens its record.
    HW.keyboardMarks(svg, (id) => (HW.data.byId.get(id)?.kind === 'quiet' ? HW.openEvent(id) : select(id, { from: 'chart', announce: true })));
    svg.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const d = ev.target.closest?.('.pdot, .pbubble');
      if (d) {
        ev.preventDefault();
        ev.stopPropagation();
        pickDots(d.dataset.k != null ? [Number(d.dataset.k)] : d.dataset.c.split(',').map(Number));
        return;
      }
      const lane = ev.target.closest?.('text.head[data-lane]')?.dataset.lane;
      if (!lane) return;
      ev.preventDefault();
      if (expanded.has(lane)) expanded.delete(lane);
      else expanded.add(lane);
      render();
      svg.querySelector(`text.head[data-lane="${CSS.escape(lane)}"]`)?.focus();
    });
    // Pointer: hover for a summary, click a mark or a dot to select its step, click empty space to
    // select the step there, drag to zoom, double-click to fit, click a lane name to open it.
    let drag = null;
    svg.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.mark, .turnseg, .pdot, .pbubble, [data-lane]')) return;
      const px = ev.clientX - svg.getBoundingClientRect().left;
      if (px > LEFT) drag = { start: px, now: px };
    });
    window.addEventListener('mousemove', (ev) => {
      if (drag) {
        drag.now = ev.clientX - svg.getBoundingClientRect().left;
        let sel = svg.querySelector('#sel');
        if (!sel) {
          sel = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          sel.id = 'sel';
          sel.setAttribute('y', '16');
          sel.setAttribute('fill', 'var(--wash)');
          sel.setAttribute('stroke', 'var(--accent)');
          svg.appendChild(sel);
        }
        sel.setAttribute('x', Math.min(drag.start, drag.now));
        sel.setAttribute('width', Math.abs(drag.now - drag.start));
        sel.setAttribute('height', svg.viewBox.baseVal.height - 16);
        return;
      }
      const d = ev.target.closest?.('#chart .pdot');
      if (d) {
        const i = F.items[Number(d.dataset.k)];
        if (i) return HW.showTip(ev, `<b>${esc(time(i.t, { day: true, seconds: true }))}</b> · ${esc(i.look ? TIER_WORD[i.tier] : 'Routine note')}<br>${esc(i.p.name)}<br>${chip(i.level)}`);
      }
      const target = ev.target.closest?.('#chart .mark');
      if (!target) return HW.hideTip();
      const e = target.dataset.gitop ? gitOps.find((g) => g.id === target.dataset.id) : HW.data.byId.get(target.dataset.id);
      if (e && e.kind !== 'quiet') HW.showTip(ev, HW.tipHtml(e));
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (Math.abs(d.now - d.start) > 8) setView(scale.t(Math.min(d.start, d.now)), scale.t(Math.max(d.start, d.now)));
      else selectAt(scale.t(d.start), { from: 'chart', follow: false });
    });
    svg.addEventListener('mouseleave', HW.hideTip);
    svg.addEventListener('dblclick', fitAll);
    svg.addEventListener('click', (ev) => {
      const lane = ev.target.closest('[data-lane]')?.dataset.lane;
      if (lane) {
        if (expanded.has(lane)) expanded.delete(lane);
        else expanded.add(lane);
        render();
        return;
      }
      const turn = ev.target.closest('.turnseg')?.dataset.turn;
      if (turn != null) {
        const t = mainTurns[Number(turn)];
        const a = toT(t.startAt);
        const b = toT(t.lastRecordAt ?? t.endAt ?? t.startAt);
        const pad = Math.max(10e3, (b - a) * 0.04);
        setView(a - pad, b + pad);
        const first = navSteps.find((e) => e.t >= a);
        if (first) select(first.id, { from: 'chart', follow: false });
        return;
      }
      const d = ev.target.closest('.pdot, .pbubble');
      if (d) return pickDots(d.dataset.k != null ? [Number(d.dataset.k)] : d.dataset.c.split(',').map(Number));
      const id = ev.target.closest('.mark')?.dataset.id;
      if (id) HW.data.byId.get(id)?.kind === 'quiet' ? HW.openEvent(id) : select(id, { from: 'chart' });
    });
    // The story: a row selects its step; a group's toggle opens or hides it.
    $('storyBody').addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-toggle]');
      if (t) return toggleGroup(t.dataset.toggle);
      const mc = ev.target.closest('[data-morecards]');
      if (mc) return moreCards(mc.dataset.morecards);
      const mr = ev.target.closest('[data-morerows]');
      if (mr) {
        const i = Number(mr.dataset.morerows);
        openCards.add(i);
        const card = $('storyBody').querySelector(`.rcard[data-card="${i}"]`);
        if (card) card.outerHTML = cardHtml(story.cards[i]);
        storySelect(selId, { open: false });
        // Keyboard focus moves to the first row the button drew.
        const rows = [...($('storyBody').querySelector(`.rcard[data-card="${i}"]`)?.querySelectorAll(':scope > ol.srows > li') ?? [])];
        rows[ROWS_FIRST]?.querySelector('[data-sel]')?.focus({ preventScroll: true });
        return;
      }
      if (ev.target.closest('[data-totl]')) return toTimeline();
      const b = ev.target.closest('[data-sel]');
      if (!b) return;
      const id = b.dataset.sel;
      select(id, { from: 'story' });
      if (!document.contains(b)) storyRow(id)?.querySelector('[data-sel]')?.focus({ preventScroll: true });
    });
    $('modeMatters').addEventListener('click', () => setMode('matters'));
    $('modeAll').addEventListener('click', () => setMode('all'));
    $('toStory').addEventListener('click', toStory);
    $('now').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-before]');
      if (b) goBefore(b.dataset.before);
    });
    $('panel').addEventListener('click', (ev) => {
      if (ev.target.closest('#selFull') && selId) HW.openEvent(selId);
    });
    $('pSummary').addEventListener('change', (ev) => {
      if (ev.target.id !== 'showRoutine') return;
      showRoutine = ev.target.checked;
      render();
    });
    window.addEventListener('resize', () => {
      render();
      if (Z?.plan?.draw?.draw === 'context') drawFocus();
    });
    HW.setDrawerNav((id, dir, peek) => {
      const next = neighbour(id, dir);
      if (!next) return null;
      if (!peek && showAt(next.id, { zoom: false, focusNav: dir })) HW.announce(HW.describeStepPieces(next));
      return next.id;
    });
    // The address names this thread and the record open in the panel: #<thread>~<event>.
    // Opening a record adds a history entry, so Back closes it again.
    HW.onDrawer.push((id) => {
      openId = id;
      if (Z && id && Z.set.has(id) && Z.ids[Z.i] !== id) {
        Z.i = Z.ids.indexOf(id);
        zoomPanel();
      }
      const want = zoomAddress(id);
      if (location.hash === want) return;
      // Stepping through a finding's own steps replaces the entry, so one Back leaves the replay.
      if (id && !(Z && Z.set.has(id))) history.pushState(null, '', want);
      else history.replaceState(null, '', want);
    });
    window.addEventListener('popstate', () => {
      const parts = location.hash.slice(1).split('~');
      const where = parts[0];
      if ((where || base) !== base) return location.reload();
      const key = zoomKey(parts);
      const id = key ? parts[3] : parts[1];
      if (key && key !== Z?.key) return applyZoom(key, { open: isId('event', id) ? id : null });
      const left = !key && !!Z;
      if (left) {
        Z = null;
        leaveFocus();
        zoomPanel();
        refilter();
        setView(view[0], view[1]);
        HW.announce('Left the zoom. The marks are cleared.');
      }
      const e = isId('event', id) && HW.data.byId.get(id);
      if (e) {
        // Out of the focus at a step (Forward to "See in the whole session"): framed around it,
        // with its row in view, as that link opens it.
        if (left) seeWhole(e.id);
        else showAt(e.id, { zoom: false });
      } else document.querySelector('.drawer.open [data-close]')?.click();
    });
  }

  function empty(html) {
    HW.fatal(html);
    $('title').textContent = '';
  }

  HW.start(async () => {
    // Nothing chosen: Replay starts on the list of the window's sessions to pick from.
    if (!askedThread && !askedSession) return window.HWSessions.show();
    const q = askedThread ? { thread: askedThread } : { session: askedSession };
    let a;
    try {
      a = await HW.load('replay', q);
    } catch (err) {
      if (err.code !== 'http') throw err;
      empty(`This ${askedThread ? 'thread' : 'session'} couldn't be loaded: ${esc(err.message)} It may be outside the window this page covers.`);
      return;
    }
    D = a;
    if (!D || !D.thread) {
      empty(`${HW.nothingIn('has this thread')} <a href="replay.html">All sessions</a> lists the ones it has, or <a href="search.html">search</a> for another.`);
      const el = document.querySelector('[data-fatal]');
      if (el) el.dataset.fatal = 'no-thread';
      return;
    }
    const events = (Array.isArray(D.events) ? D.events : []).map(HW.normEvent).filter((e) => Number.isFinite(e.t));
    const agents = Array.isArray(D.agents) ? D.agents : [];
    const sessions = Array.isArray(D.sessions) ? D.sessions : [];
    HW.useData({ events, agents, rules: D.rules ?? {}, sessions });
    const th = D.thread;
    T0 = toT(th.firstAt);
    T1 = toT(th.lastAt);
    if (!Number.isFinite(T0) || !Number.isFinite(T1)) {
      const ts = events.flatMap((e) => (e.endT ? [e.t, e.endT] : [e.t]));
      T0 = Math.min(...ts);
      T1 = Math.max(...ts);
    }
    if (!(T1 > T0)) T1 = T0 + 60e3;
    multiDay = HW.dayOf(T0) !== HW.dayOf(T1);

    // A replay can hold several sessions (a session resumed later is a new session file), each
    // with its own main agent. A session starts at its main agent's first own record.
    const ownFirst = new Map();
    const ownLast = new Map();
    for (const e of events) {
      if (!e.agent) continue;
      ownFirst.set(e.agent, Math.min(ownFirst.get(e.agent) ?? Infinity, e.t));
      ownLast.set(e.agent, Math.max(ownLast.get(e.agent) ?? -Infinity, e.endT ?? e.t));
    }
    mains = agents.filter((x) => x.kind === 'main').map((x) => ({ a: x, start: ownFirst.get(x.key) ?? toT(x.firstAt), end: ownLast.get(x.key) ?? toT(x.lastAt) })).sort((p, r) => p.start - r.start);
    if (!mains.length) mains = [{ a: { key: '(none)', kind: 'main' }, start: T0, end: T1 }];
    multi = mains.length > 1;
    const mainLabel = (i) => (multi ? `Main agent, session ${i + 1}` : 'Main agent');
    HW.data.mainLabels = new Map(mains.map((m, i) => [m.a.key, mainLabel(i)]));
    mainKeys = new Set(mains.map((m) => m.a.key));
    WHOLE = multi ? (mains.length === 2 ? 'both sessions' : `all ${mains.length} sessions`) : 'the whole session';
    const WHOLE_CAP = WHOLE[0].toUpperCase() + WHOLE.slice(1);
    document.querySelector('#zoom option[value="0"]').textContent = WHOLE_CAP;
    $('fit').textContent = `⤢ ${WHOLE_CAP}`;
    $('fit').title = `Zoom back out to ${WHOLE} (Esc, or double-click the chart)`;
    $('legendSession').hidden = !multi;
    sessionKeys = sessions.map((s) => s.key).filter((k) => typeof k === 'string');
    // The session the reader opened: a search link names it (?session=<key>).
    opened = askedSession ? mains.find((m) => m.a.key === `${askedSession}:main` || (m.a.session === askedSession && m.a.kind === 'main')) ?? null : null;
    const titleOf = (key) => sessions.find((s) => s.key === key)?.title ?? D.labels?.[key] ?? null;
    const openedTitle = opened ? titleOf(askedSession) ?? (opened === mains[0] ? th.title : null) : null;
    // A thread with no title: its first session's label, from what its log records.
    const thName = th.title || D.labels?.[sessions[0]?.key] || 'Untitled session';
    const span = (a2, b2) => `${time(a2, { day: true })} to ${time(b2, { day: HW.dayOf(a2) !== HW.dayOf(b2) })}`;

    // What goes where: one lane per main agent, one per sub-agent, then the harness and git.
    const subs = agents.filter((x) => x.kind !== 'main').sort((p, r) => toT(p.spawnAt ?? p.firstAt) - toT(r.spawnAt ?? r.firstAt));
    instrOf = new Map(events.filter((e) => e.kind === 'delegation-received').map((e) => [e.agent, e]));
    // Git operations the harness recorded on a command (pushes, pull requests), in the Git lane.
    gitOps = events.filter((e) => e.facts?.git && typeof e.facts.git === 'object').map((e) => ({ ...e, __gitop: true, t: e.endT ?? e.t, label: Object.entries(e.facts.git).map(([k, v]) => (k === 'pr' ? `PR ${v?.number ?? ''} ${v?.action ?? ''}` : k === 'commit' ? `commit ${String(v?.sha ?? '').slice(0, 7)}` : k === 'push' ? `push ${v?.branch ?? ''}` : `${k} ${v?.action ?? ''}`).trim()).join(', ') }));
    const all = events.filter((e) => HW.laneOf(e)).concat(gitOps).sort((p, r) => p.t - r.t);
    const laneKeys = new Set(['person', 'harness', 'git', ...agents.map((x) => x.key)]);
    placed = all.map((e) => {
      let lane = e.__gitop ? 'git' : HW.laneOf(e);
      if (!laneKeys.has(lane)) lane = 'harness';
      return { e, lane, sub: e.__gitop ? 'Git operations (harness)' : HW.subOf(e, lane) };
    });
    laneById = new Map(placed.filter((p) => !p.e.__gitop).map((p) => [p.e.id, p.lane]));
    LANES = [
      { key: 'person', label: 'You' },
      ...mains.map((m, i) => ({ key: m.a.key, label: mainLabel(i), session: multi ? i + 1 : null })),
      ...subs.map((x) => ({ key: x.key, label: `↳ ${HW.agentLabel(x.key)}`, agent: x })),
      { key: 'harness', label: 'Harness' },
      { key: 'git', label: 'Git' },
    ];
    steps = events.filter(RM.isStep).sort((p, r) => p.t - r.t);
    prompts = steps.filter((e) => e.kind === 'prompt');
    const turns = Array.isArray(D.session?.turns) ? D.session.turns : Array.isArray(D.turns) ? D.turns : [];
    mainTurns = turns.filter((t) => mainKeys.has(t.agent)).sort((p, r) => toT(p.startAt) - toT(r.startAt));
    frames = (Array.isArray(D.frames) ? D.frames : []).map(HW.frameOf).filter((f) => Number.isFinite(f.t)).sort((p, r) => p.t - r.t);

    // The title, then where it ran, when and how much, quieter.
    const tools = [...new Set(sessions.map((s) => (s.tool === 'codex' ? 'Codex' : s.tool === 'claude' ? 'Claude Code' : null)).filter(Boolean))];
    $('tool').hidden = !tools.length;
    $('tool').textContent = tools.join(', ');
    $('title').textContent = multi && opened ? openedTitle ?? thName : (opened && openedTitle) || thName;
    const counts = `${plural(prompts.length, 'prompt')} · ${plural(steps.length, 'step')}`;
    $('meta').textContent = multi && opened
      ? `${span(opened.start, opened.end)} · session ${mains.indexOf(opened) + 1} of ${mains.length} in this replay · ${counts}`
      : `${span(T0, T1)} · ${counts}${multi ? ` · ${mains.length} sessions` : ''}`;

    // What started the session shown, when a program did: the step that launched it, linked,
    // or a "?" that says why none is named.
    const shownKey = opened ? opened.a.session : multi ? null : sessions[0]?.key ?? null;
    const started = startedLine(shownKey, events, sessions);
    $('startedBy').hidden = !started;
    $('startedBy').innerHTML = started ?? '';

    // Long stretches with no new step, and what filled each.
    const recs = events.filter((e) => e.kind !== 'quiet');
    ({ gaps, limit: idleLim } = RM.idleGaps(RM.starts(events), T0, T1));
    for (const g of gaps) gapLabel.set(g[0], RM.breakLabel(g, { steps: recs, agents, turns: mainTurns }));
    whole = RM.makeScale({ v0: T0, v1: T1, p0: 0, p1: 1000, gaps, limit: idleLim, breakW: 30 });

    // Every lane opens when the whole chart stays short; a long one starts folded.
    LANES.forEach((l) => expanded.add(l.key));
    expanded.add(HELPERS);
    if (rows().length > 30) expanded.clear();

    base = askedThread ?? (isId('thread', th.id) ? th.id : '');
    prefs = window.HWPrefs.createPrefs();
    prefs.onChange(() => collect());
    navSteps = steps;
    navPrompts = prompts;
    const first = (opened && prompts.find((p) => p.agent === opened.a.key)) || prompts[0] || steps[0];
    selId = first?.id ?? null;
    playhead = first?.t ?? T0;
    wire();
    catalog();
    view = [T0, T1];
    renderStory();
    setView(T0, T1);
    // The findings worth a look load once the chart has a view to draw them on.
    if (isId('thread', th.id)) loadFindings(th.id);
    else {
      F = { ...F, failed: 'This replay has no thread id to ask the problem checks for.' };
      summary();
    }
    // Facts (facts.js): plain counts for this replay's sessions, in a closed fold.
    if (isId('thread', th.id)) {
      window.HWFacts?.load({ thread: th.id }, {
        jump: (id) => {
          const e = HW.data.byId.get(id);
          if (e && showAt(id, { zoom: false })) HW.announce(HW.describeStepPieces(e));
        },
      });
    }
    // #<thread>~<event>: open at that step, zoomed to five minutes around it, with its record, and
    // its row in the steps scrolled into view ("See in the whole session" opens this address).
    const at = askedEvent();
    if (at && !showAt(at)) HW.addNote("The step named in the address isn't in this replay.");
    else if (at) revealStep(at);
    if (!location.hash && base) history.replaceState(null, '', `${location.pathname}${location.search}#${base}`);
    // #<thread>~zoom~<finding key>: zoomed to the finding's steps, only those marked.
    const zk = zoomKey();
    if (zk) await applyZoom(zk, { open: isId('event', hashParts()[3]) ? hashParts()[3] : null });
  });
})();
