// Shared code for every page of `honestweek view`: the page shell (the run key, the switch, the
// build progress, the window and the demo notice), formatting, the "who" and "when" labels with
// how each is known, the record panel, and the chart pieces the goal and replay pages share.
// Every number and label shown comes from the server's answers, which come from the engine;
// nothing here computes a new claim. Needs evidence.js and private-text.js loaded first.
(function () {
  'use strict';
  const HWE = window.HWE;
  const HWP = window.HWP;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
  const toT = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN);
  /** A count as the server sends it: a bare number, or { value, evidence } from the engine. */
  const num = (m) => (m && typeof m === 'object' ? m.value : m);
  const lvl = (m, fallback = 'recorded') => (m && typeof m === 'object' && typeof m.evidence === 'string' ? m.evidence : fallback);

  // ---- time ------------------------------------------------------------------------------
  let TZ = 'UTC';
  const setTimezone = (tz) => {
    if (typeof tz !== 'string' || !tz) return;
    try {
      new Date(0).toLocaleString('en-US', { timeZone: tz });
      TZ = tz;
    } catch {}
  };
  const time = (t, opts = {}) => new Date(t).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...(opts.seconds ? { second: '2-digit' } : {}), ...(opts.day ? { weekday: 'short', month: 'short', day: 'numeric' } : {}) });
  const dayOf = (t) => new Date(t).toLocaleDateString('en-US', { timeZone: TZ });
  const dur = (ms) => {
    if (ms == null || !Number.isFinite(ms)) return 'not recorded';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s} s`;
    const m = Math.round(s / 60);
    return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
  };
  // A window's dates, "Mon, Mar 10 to Sun, Mar 16, 2025", read as calendar dates.
  const ymd = (iso, year) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
  const validDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  function windowText(w) {
    if (!w || !validDay(w.from) || !validDay(w.to)) return '';
    const sameYear = w.from.slice(0, 4) === w.to.slice(0, 4);
    return `${ymd(w.from, !sameYear)} to ${ymd(w.to, true)}`;
  }
  /** "Nothing between <from> and <to>", plus how to look further back. */
  function nothingIn(what = '') {
    const w = shell.window;
    const span = w && validDay(w.from) && validDay(w.to) ? `between ${ymd(w.from, w.from.slice(0, 4) !== w.to.slice(0, 4))} and ${ymd(w.to, true)}` : 'in this window';
    const further = shell.demo ? 'The demo week is fixed, so try one of the examples instead.' : 'To look further back, start it again with <code>honestweek view --days 30</code>, or pick dates with <code>--from</code> and <code>--to</code>.';
    return `Nothing ${span}${what ? ` ${what}` : ''}. ${further}`;
  }

  // ---- the page shell --------------------------------------------------------------------
  const shell = { status: null, window: null, demo: false, notes: [] };
  const $ = (id) => document.getElementById(id);
  function setStatus(html, { bad = false } = {}) {
    const el = $('status');
    if (!el) return;
    el.hidden = !html;
    el.innerHTML = html ?? '';
    el.classList.toggle('bad', !!bad);
  }
  /** A note about this copy of the data (a failed private build, say), kept above the page. */
  function addNote(text, { bad = false } = {}) {
    if (!text || shell.notes.includes(text)) return;
    shell.notes.push(text);
    setStatus(shell.notes.map(esc).join(' '), { bad });
  }
  /** Replace the page's content with one message, keeping the header and its links. */
  function fatal(html) {
    setStatus('');
    const el = $('content');
    if (el) el.innerHTML = `<div class="empty-state" data-fatal="1">${html} <p><a href="search.html">Back to search</a></p></div>`;
    document.body.dataset.ready = 'fatal';
  }
  // The notices key.js names: no key, a refused key, or a server that has stopped.
  const noticeHtml = (state) => esc(HWP.notice(state) || "This page can't get data from honestweek view.");

  function showWindow(w) {
    if (!w || !validDay(w.from)) return;
    shell.window = w;
    setTimezone(w.timezone);
    const el = $('window');
    if (el) {
      el.textContent = `Window: ${windowText(w)}`;
      el.title = `Every count and list on this page covers ${windowText(w)}${w.timezone ? `, in ${w.timezone}` : ''}.`;
    }
  }
  // The server's demo notice: { notice, commands: [{ step, command }] } in demo mode, null otherwise.
  function showDemo(demo) {
    shell.demo = !!demo && typeof demo === 'object';
    const el = $('demo');
    if (!el) return;
    el.hidden = !shell.demo;
    if (!shell.demo) return;
    // Commands that share a step ("Install it as a Claude Code plugin") read as one step.
    const steps = [];
    for (const c of Array.isArray(demo.commands) ? demo.commands : []) {
      if (!c || typeof c.command !== 'string') continue;
      const step = String(c.step ?? 'Run');
      if (steps.length && steps[steps.length - 1].step === step) steps[steps.length - 1].commands.push(c.command);
      else steps.push({ step, commands: [c.command] });
    }
    el.innerHTML = `${esc(demo.notice ?? 'This is a made-up week.')} To see your own work: ${steps.map((s) => `${esc(lowerFirst(s.step))}: ${s.commands.map((x) => `<code>${esc(x)}</code>`).join(', then ')}`).join('; ')}.`;
  }
  function mountSwitch() {
    const el = $('privacy');
    if (!el) return;
    const note = HWP.on ? 'Private text from this program\'s memory, never saved; secrets hidden.' : 'Redacted: private words show as [redacted:…]. Nothing is published.';
    el.innerHTML = `<span class="privnote" id="privnote">${esc(note)}</span><label title="${esc(HWP.promise)}"><input type="checkbox" id="privateSwitch"${HWP.on ? ' checked' : ''}> Show private text (secrets stay hidden; never saved)</label><span class="sr">${esc(HWP.promise)}</span>`;
    $('privateSwitch').addEventListener('change', (ev) => HWP.set(ev.target.checked));
  }

  /** Wait until the build this page needs is ready, saying what it's reading meanwhile. */
  async function waitReady() {
    const shown = (s) => {
      if (!s) return;
      shell.status = s;
      showWindow(s.window);
      showDemo(s.demo);
    };
    const r = await HWP.client.waitForBuild({
      onProgress(p) {
        shown(p.status);
        setStatus(p.phase === 'private'
          ? `<span class="spin" aria-hidden="true"></span>Building private text in this program's memory: ${p.secs} s so far. It's never saved. The page fills in when it's ready.`
          : `<span class="spin" aria-hidden="true"></span>Reading your sessions into this program's memory: ${p.secs} s so far${p.reading ? `, ${esc(p.reading)}` : ''}. The page fills in when it's ready.`);
      },
    });
    if (!r.ok) {
      if (r.reason === 'failed') {
        shown(r.status);
        fatal(`The data couldn't be built${r.message ? `: ${esc(r.message)}` : ''}. Stop honestweek view with Ctrl+C and start it again. If it fails again, <code>honestweek view --demo</code> shows whether the page itself works.`);
      } else fatal(window.HWKey.NOTICE[r.reason] ? noticeHtml(r.reason) : esc(r.message ?? 'The server answered with an error.'));
      return null;
    }
    shown(r.status);
    setStatus('');
    if (r.note) {
      addNote(r.note, { bad: true });
      // One note says the private build failed; the answers that follow don't repeat it.
      shell.privateNoted = true;
    }
    return r.status;
  }
  /** What every data answer may say about itself: its window, and whether private text is in it. */
  // Every data answer carries `view`: { asked, shown, note, privateState, window, demo }. `shown`
  // says which build answered; `note` says why it isn't the one asked for.
  function absorb(answer) {
    if (!answer || typeof answer !== 'object') return answer;
    const v = answer.view && typeof answer.view === 'object' ? answer.view : {};
    if (v.window || answer.window) showWindow(v.window ?? answer.window);
    if (answer.timezone) setTimezone(answer.timezone);
    if ('demo' in v) showDemo(v.demo);
    const redactedInstead = HWP.on && v.shown === 'redacted';
    if (typeof v.note === 'string' && v.note) {
      if (!shell.privateNoted) addNote(v.note, { bad: true });
    } else if (redactedInstead && !shell.privateNoted) addNote("Private text isn't available for this answer, so it shows the redacted version.", { bad: true });
    if (redactedInstead || v.note) shell.privateNoted = true;
    return answer;
  }
  /** Fetch one route and absorb its notes; a build that's still running is waited for. */
  async function load(route, params = {}) {
    for (let tries = 0; ; tries++) {
      try {
        return absorb(await HWP.api(route, params));
      } catch (err) {
        if (err.code !== 'building' || tries > 600) throw err;
        if (!(await waitReady())) throw Object.assign(new Error('stopped'), { code: 'shown' });
      }
    }
  }
  /** Run a page: find the key, mount the switch, wait for the build, then hand over. */
  async function start(run) {
    const state = await HWP.ready;
    if (state !== 'ready') {
      fatal(noticeHtml(state));
      return;
    }
    // A key refused later, or a server that stops while the page is open: say so above what's
    // already drawn. No further data request is made (key.js refuses them).
    HWP.client.onState((s) => {
      if (s === 'ready') return;
      if (document.body.dataset.ready === '1') addNote(HWP.notice(s), { bad: true });
      else fatal(noticeHtml(s));
    });
    mountSwitch();
    const status = await waitReady();
    if (!status) return;
    try {
      await run(status);
      if (document.body.dataset.ready !== 'fatal') document.body.dataset.ready = '1';
    } catch (err) {
      fail(err);
    }
  }
  /** Show why a page or a request couldn't finish. */
  function fail(err) {
    if (err?.code === 'shown') return;
    if (window.HWKey.NOTICE[err?.code]) {
      if (document.body.dataset.ready === '1') addNote(HWP.notice(err.code), { bad: true });
      else fatal(noticeHtml(err.code));
      return;
    }
    fatal(`This page couldn't be drawn: ${esc(err?.message ?? err)}`);
    if (err && err.code !== 'http') setTimeout(() => {
      throw err;
    });
  }

  // ---- ids in the address: letter-hash ids only, never typed or clicked text --------------
  const ID = {
    thread: /^th-[a-p]{4,64}$/,
    session: /^[a-z]{2,4}-[a-p]{4,64}$/,
    event: /^[a-z]{2,4}-[a-p]{4,64}(?:[.:][A-Za-z0-9_-]{1,80}){0,6}$/,
    goal: /^(?:[a-z]{1,4}-)?[a-p]{4,64}$/,
  };
  const isId = (kind, v) => typeof v === 'string' && v.length <= 300 && ID[kind].test(v);

  // ---- evidence labels -------------------------------------------------------------------
  const chip = HWE.chip;
  /** The rule behind an inference, in plain words when the answer carries them. */
  const ruleText = (rule, rules) => {
    if (!rule) return '';
    const parts = String(rule).split(' | ').map((r) => r.trim()).filter(Boolean);
    return parts.map((r) => (rules && typeof rules[r] === 'string' ? rules[r] : r)).join(' ');
  };
  /** Who wrote a prompt, when the engine only infers it: { value, rule }, or null when recorded. */
  function authorship(e) {
    for (const x of e.inferred ?? []) {
      if (typeof x === 'string') {
        const m = x.match(/^authorship=([\w-]+)\s*\[([^\]]+)\]/);
        if (m) return { value: m[1], rule: m[2] };
      } else if (x && x.key === 'authorship') return { value: x.value, rule: x.rule, text: x.text ?? x.ruleText ?? null };
    }
    return null;
  }
  const SPEAKER_KINDS = new Set(['prompt', 'command', 'decision', 'notice', 'interrupt', 'queue']);

  // ---- data a chart page shares with the record panel ------------------------------------
  const data = { byId: new Map(), agentByKey: new Map(), rules: {}, mainLabels: new Map(), sessionTitle: new Map() };
  /** One event as the pages read it, whatever spelling the export used for its time and level. */
  function normEvent(e) {
    const t = Number.isFinite(e.t) ? e.t : toT(e.at ?? e.time);
    const end = Number.isFinite(e.endT) ? e.endT : toT(e.endAt ?? e.end?.at ?? e.endTime);
    return { ...e, t, endT: Number.isFinite(end) ? end : null, ev: e.ev ?? e.evidence ?? 'recorded', text: typeof e.text === 'string' ? e.text : e.description ?? e.kind, inferred: Array.isArray(e.inferred) ? e.inferred : [], missing: Array.isArray(e.missing) ? e.missing : [] };
  }
  function useData({ events = [], agents = [], rules = {}, sessions = [] } = {}) {
    data.byId = new Map(events.map((e) => [e.id, e]));
    data.agentByKey = new Map(agents.map((a) => [a.key, a]));
    data.rules = rules && typeof rules === 'object' ? rules : {};
    data.sessionTitle = new Map(sessions.map((s) => [s.key, s.title ?? null]));
    // An event names its session, or its agent does, or its id starts with its source's key.
    const keys = new Set(sessions.map((s) => s.key));
    for (const e of events) {
      if (e.session) continue;
      const a = data.agentByKey.get(e.agent);
      const src = String(e.id ?? '').split('.')[0];
      e.session = a?.session ?? (typeof e.agent === 'string' && e.agent.endsWith(':main') ? e.agent.slice(0, -5) : null) ?? (keys.has(src) ? src : data.agentByKey.get(src)?.session ?? null);
    }
  }
  const agentLabel = (key) => {
    const named = data.mainLabels.get(key);
    if (named) return named;
    const a = data.agentByKey.get(key);
    if (!a) return key?.endsWith?.(':sidechain') ? 'Inline sub-agent' : 'The agent';
    if (a.kind === 'main') return 'Main agent';
    const name = a.type ?? (a.kind === 'child-thread' ? 'Child thread' : a.kind === 'guardian' ? 'Guardian' : null);
    return `Sub-agent${name ? ` ${name}` : ''}${a.description ? `: ${a.description}` : ''}`;
  };
  /** Who did a step, by the record's own actor, with how that is known. A prompt is yours even
   *  though it sits in the agent's conversation, so it reads "You", never "Main agent". */
  function who(e) {
    if (e.actor === 'person') {
      const to = e.agent ? agentLabel(e.agent) : null;
      const toText = to ? `, to ${to.startsWith('Main agent') ? `the ${to[0].toLowerCase()}${to.slice(1)}` : to}` : '';
      const a = SPEAKER_KINDS.has(e.kind) ? authorship(e) : null;
      if (a && a.value === 'person-or-script') return { text: `A person or a script${toText}`, short: 'A person or a script', level: 'inferred', rule: a.rule };
      if (a) return { text: `You${toText}`, short: 'You', level: 'inferred', rule: a.rule };
      return { text: `You${toText}`, short: 'You', level: 'recorded' };
    }
    if (e.actor === 'harness') return { text: 'The harness (Claude Code or Codex itself)', short: 'The harness', level: 'recorded' };
    if (e.actor === 'git') return { text: 'Git', short: 'Git', level: 'recorded' };
    if (e.actor === 'none') return { text: 'Computed from the records', short: 'Computed', level: 'derived' };
    if (e.actor === 'peer') return { text: 'Another session, an agent or a schedule', short: 'Another session', level: 'recorded' };
    const label = agentLabel(e.agent);
    return { text: label, short: label, level: 'recorded' };
  }
  /** How a step's time is known. The line's own time, one borrowed from a neighbouring line,
   *  or one the engine moved to just after the call that started a sub-agent. */
  function timeHow(e) {
    const out = [];
    if (e.timeFrom === 'previous-record') out.push({ text: 'This log line has no time of its own; its time is borrowed from the line before it.', short: 'time borrowed from the line before', level: 'derived' });
    else if (e.timeFrom === 'next-record') out.push({ text: 'This log line has no time of its own; its time is borrowed from the line after it.', short: 'time borrowed from the line after', level: 'derived' });
    else if (e.timeFrom === 'none') out.push({ text: 'Neither this log line nor any near it has a time.', short: 'no time recorded', level: 'missing' });
    else if (e.timeFrom === 'git-author-date') out.push({ text: "Git's author date for the commit.", short: "git's author date", level: 'recorded' });
    else if (e.timeFrom === 'git-committer-date-on-default-branch') out.push({ text: "Git's committer date on the default branch.", short: "git's committer date", level: 'recorded' });
    if (e.clock) {
      const was = Number.isFinite(e.clock.recordedT) ? ` (stamped ${time(e.clock.recordedT, { day: true, seconds: true })})` : '';
      out.push({ text: `A sub-agent's step stamped before the call that started it${was}; the engine moved it to just after that call.`, short: 'moved after the starting call', level: 'derived', rule: e.clock.rule ?? null });
    }
    if (!out.length) out.push({ text: "The log line's own time.", short: null, level: 'recorded' });
    return out;
  }
  const timeMoved = (e) => !!e.clock || e.timeFrom === 'previous-record' || e.timeFrom === 'next-record' || e.timeFrom === 'none';

  const GROUP_LABEL = { run: 'Ran a command', change: 'Changed a file', look: 'Looked something up', other: 'Other step' };
  const KIND_LABEL = { prompt: 'Prompt', command: 'Slash command', notice: 'An action with no typed text', decision: 'Decision', message: 'Agent message', 'agent-message': 'Message between agents', 'delegation-received': 'Starting instruction', 'turn-end': 'Turn end', interrupt: 'Interruption', queue: 'Queued message', notification: 'Completion notice', guard: 'Refused by a rule or hook', hook: 'Hook run', mode: 'Mode change', 'external-edit': 'File changed outside the agent', compaction: 'Context compacted', error: 'Error', session: 'Session start', quiet: 'No records', link: 'Pull-request link' };
  const kindLabel = (e) => (e.kind === 'action' ? GROUP_LABEL[e.group ?? 'other'] ?? 'Step' : e.kind === 'outcome' ? (e.outcome === 'pr-landed' || e.facts?.outcome === 'pr-landed' ? 'Pull request landed' : 'Commit') : KIND_LABEL[e.kind] ?? e.kind);
  const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
  const stripKind = (s) => String(s ?? '').replace(/^(prompt|message to the person|reply to parent agent|harness notice:) /, '');
  /** The short text a mark is labelled with. */
  function summary(e) {
    if (e.__gitop) return e.label;
    const f = e.facts ?? {};
    return f.command ?? f.file ?? f.description ?? f.pattern ?? f.query ?? f.subject ?? f.skill ?? f.title ?? f.summary ?? (e.kind === 'action' ? e.tool ?? f.tool ?? 'a tool call' : stripKind(e.text));
  }
  // ---- cutting text the server already redacted --------------------------------------
  // A cut never falls inside a placeholder ([redacted:…]) or inside a run of the characters a
  // token is made of, so what's shown is a start of the served text that the scrubber reads the
  // same way. Cut inside a run, a long run the scrubber left whole (its hex part set aside as a
  // commit id) can become a shorter run it takes for a token; cut before a quoted hidden value,
  // the quote left open reads as the value.
  const TOKEN_CHAR = /[A-Za-z0-9_+/=-]/;
  function clip(s, n) {
    const t = String(s ?? '');
    if (t.length <= n) return t;
    const ok = (i) => {
      if (TOKEN_CHAR.test(t[i - 1] ?? '') && TOKEN_CHAR.test(t[i] ?? '')) return false;
      const open = t.lastIndexOf('[redacted:', i - 1);
      return !(open >= 0 && t.indexOf(']', open) >= i);
    };
    let at = n;
    while (at > 0 && !ok(at)) at -= 1;
    // A run longer than half the room is shown whole rather than cut inside.
    if (at < n / 2) for (at = n; at < t.length && !ok(at); ) at += 1;
    // A quote left open at the end has lost its value: `token="` would read as a field whose
    // value is the quote itself.
    return t.slice(0, at).replace(/[\s"']+$/, '');
  }
  /** clip() as markup, with a "…" in an element of its own when the text was cut. */
  const clipHtml = (s, n) => {
    const t = String(s ?? '');
    const cut = clip(t, n);
    return `${esc(cut)}${cut.length < t.length ? '<span>…</span>' : ''}`;
  };
  /** A line in pieces, each [text, fromTheLogs]: a piece read from the logs stands in its own
   *  element on the page, so the page's own words around it never read as part of it. */
  const piecesHtml = (pieces) => pieces.map(([t, logged]) => (logged ? `<span>${esc(t)}</span>` : esc(t))).join('');
  /** One line a screen reader can read for a step: when, who, what, and how it's known, in pieces. */
  function describeStepPieces(e) {
    const at = `${time(e.t, { day: true, seconds: true })}. `;
    if (e.__gitop) return [[`${at}Git operation the harness recorded: `, false], [e.label, true], ['. recorded.', false]];
    const w = who(e);
    const how = timeHow(e).filter((x) => x.short).map((x) => x.short);
    return [
      [at, false],
      [w.text, true],
      [`${w.level !== 'recorded' ? ` (${w.level})` : ''}: ${lowerFirst(kindLabel(e))}, `, false],
      [clip(summary(e), 140), true],
      [`. ${e.ev}${how.length ? `; ${how.join('; ')}` : ''}.`, false],
    ];
  }
  const describeStep = (e) => describeStepPieces(e).map(([t]) => t).join('');

  // ---- the record panel ------------------------------------------------------------------
  // A dialog with the step's fields, each with its level, then the original log line, read
  // from the server only when the panel opens. Focus moves to Close on open and back on close.
  let drawer;
  let returnFocus = null;
  let recordSeq = 0;
  const onDrawer = [];
  function closeDrawer() {
    if (!drawer?.classList.contains('open')) return;
    drawer.classList.remove('open');
    const back = returnFocus;
    returnFocus = null;
    let target = back?.el && document.contains(back.el) ? back.el : null;
    // A chart redrawn while the panel was open has a new mark for the same step.
    if (!target && back?.id) target = document.querySelector(`#chart .mark[data-id="${CSS.escape(back.id)}"]`);
    if (target && target !== document.body) target.focus();
    for (const fn of onDrawer) fn(null);
  }
  function openEvent(id) {
    const e = data.byId.get(id);
    if (!e) return;
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.className = 'drawer';
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-labelledby', 'drawerTitle');
      document.body.appendChild(drawer);
      document.addEventListener('keydown', (ev) => ev.key === 'Escape' && closeDrawer());
    }
    if (!drawer.classList.contains('open')) {
      const a = document.activeElement;
      returnFocus = { el: a, id: a?.dataset?.id ?? null };
    }
    const w = who(e);
    const how = timeHow(e);
    const rows = [
      ['When', `${time(e.t, { day: true, seconds: true })}${e.endT && e.endT !== e.t ? ` to ${time(e.endT, { seconds: true })} (recorded span ${dur(e.endT - e.t)})` : ''}`, how[0].level],
      ...how.map((x) => ['How the time is known', `${x.text}${x.rule ? ` (rule ${x.rule})` : ''}`, x.level]),
      ['Who', `${w.text}${w.rule ? `, because ${lowerFirst(ruleText(w.rule, data.rules))}` : ''}`, w.level],
      ['What', stripKind(e.text), e.ev],
    ];
    if (e.tests) rows.push(['Tests', `${e.tests.pass ?? 0} passed, ${e.tests.fail ?? 0} failed${e.tests.parser ? ` (from the ${e.tests.parser} summary it printed)` : ''}`, 'derived']);
    if (e.patch) rows.push(['Lines', `+${e.patch.added ?? 0} −${e.patch.removed ?? 0}${e.patch.hunks != null ? ` in ${plural(e.patch.hunks, 'hunk')}` : ''}`, 'derived']);
    if (e.harnessMs != null) rows.push(['Harness duration', `${dur(e.harnessMs)} (the harness's own measurement, not working time)`, 'recorded']);
    for (const inf of e.inferred) {
      if (typeof inf === 'string') {
        if (!/^authorship=/.test(inf)) rows.push(['Decided by rule', inf, 'inferred']);
      } else if (inf && inf.key !== 'authorship') rows.push(['Decided by rule', `${inf.key ? `${inf.key}: ` : ''}${inf.value}, because ${lowerFirst(String(inf.text ?? ruleText(inf.rule, data.rules) ?? inf.rule))}`, 'inferred']);
    }
    for (const m of e.missing) rows.push(['Not found', String(m).replace(/-/g, ' '), 'missing']);
    rows.push(['Record id', e.id, null]);
    const head = `${kindLabel(e)}${e.actor === 'agent' && e.agent ? ` · ${agentLabel(e.agent)}` : ''}`;
    const fields = e.facts ? Object.keys(e.facts).length + Object.keys(e.derived ?? {}).length : 0;
    const show = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v);
    drawer.innerHTML = `<header><div class="h"><h2 id="drawerTitle">${esc(head)}</h2><div class="kbd">${esc(time(e.t, { day: true, seconds: true }))}</div></div><button type="button" data-close>Close</button></header>
      <div class="body">
        <dl>${rows.map(([k, v, l]) => `<dt>${esc(k)}</dt><dd>${esc(v)}${l ? ` ${chip(l)}` : ''}</dd>`).join('')}</dl>
        ${fields ? `<details><summary>Every field the engine kept (${fields})</summary><dl class="more">${Object.entries(e.facts).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(show(v))} ${chip('recorded')}</dd>`).join('')}${Object.entries(e.derived ?? {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(show(v))} ${chip('derived')}</dd>`).join('')}</dl></details>` : ''}
        <div data-record><h3>Original record</h3><p class="kbd"><span class="spin" aria-hidden="true"></span>Reading the log line from disk…</p></div>
      </div>`;
    drawer.querySelector('[data-close]').addEventListener('click', closeDrawer);
    drawer.classList.add('open');
    drawer.querySelector('[data-close]').focus();
    for (const fn of onDrawer) fn(id);
    loadRecord(e, ++recordSeq);
  }
  // The answer to /api/record: { records: [{ part, verified, note, line, git, record }], output? }.
  // `part` is "step" (the step's own line), "result" (a call's recorded result) or "copy".
  async function loadRecord(e, seq) {
    const box = () => (seq === recordSeq ? drawer.querySelector('[data-record]') : null);
    let a;
    try {
      a = await load('record', { event: e.id });
    } catch (err) {
      const el = box();
      if (el) el.innerHTML = `<h3>Original record</h3><p class="notverified">The record couldn't be read: ${esc(err.message)}</p>`;
      return;
    }
    const el = box();
    if (!el) return;
    const list = Array.isArray(a) ? a : Array.isArray(a.records) ? a.records : a.record ? [a.record] : [];
    const one = (r, title) => {
      if (!r) return '';
      const line = r.ref?.line ?? r.line;
      if (r.git || r.ref?.sha) return `<h3>${title}</h3><p>A git object: the engine checked it with git.</p>`;
      const body = typeof r.body === 'string' ? r.body : r.record != null ? (typeof r.record === 'string' ? r.record : JSON.stringify(r.record, null, 2)) : '';
      return `<h3>${title}</h3><p>${r.verified ? '<span class="verified">✓ re-read from disk, fingerprint matches</span>' : `<span class="notverified">✗ ${esc(r.note ?? 'not checked')}</span>`}${line ? ` · line ${esc(line)}` : ''}</p>${body ? `<pre>${esc(body)}</pre>` : ''}`;
    };
    const output = typeof a.output === 'string' ? a.output : typeof a.output?.text === 'string' ? a.output.text : null;
    let html = '';
    if (output != null) html += `<div class="output"><h3>Output</h3><p class="kbd">What the command printed, redacted, then shortened${a.outputCut || a.output?.cut ? ' (cut here)' : ''}.</p><pre>${esc(output)}</pre></div>`;
    const own = list.filter((r) => r?.part !== 'result');
    const results = list.filter((r) => r?.part === 'result');
    html += own.length ? own.map((r, i) => one(r, own.length > 1 ? `Original record ${i + 1} of ${own.length}` : 'Original record')).join('') : '<h3>Original record</h3><p>Worked out from neighbouring records; it has no record of its own.</p>';
    html += results.map((r) => one(r, "The call's recorded result")).join('');
    el.innerHTML = html;
  }

  // ---- a tooltip shared by every mark ------------------------------------------------------
  let tip;
  function showTip(ev, html) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tooltip';
      document.body.appendChild(tip);
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }
  const hideTip = () => tip && (tip.style.display = 'none');
  function tipHtml(e, extra = '') {
    if (e.__gitop) return `<b>${esc(time(e.t, { day: true, seconds: true }))}</b> · git operation the harness recorded<br>${esc(e.label)}<br>${chip('recorded')}`;
    const w = who(e);
    const how = timeHow(e).filter((x) => x.short);
    return `<b>${esc(time(e.t, { day: true, seconds: true }))}</b>${extra ? ` · ${esc(extra)}` : ''}<br>${esc(w.text)}${w.level !== 'recorded' ? ` ${chip(w.level)}` : ''}: ${esc(stripKind(e.text))}<br>${chip(e.ev)}${e.inferred.filter((i) => !(i && i.key === 'authorship') && !/^authorship=/.test(String(i))).map((i) => ` ${chip('inferred', typeof i === 'string' ? i : i.value)}`).join('')}${e.missing.map((m) => ` ${chip('missing', m)}`).join('')}${how.map((x) => ` ${chip(x.level, x.short)}`).join('')}${e.endT && e.endT > e.t ? `<br>recorded span ${esc(dur(e.endT - e.t))}` : ''}${e.tests ? `<br>tests ${e.tests.pass ?? 0} passed, ${e.tests.fail ?? 0} failed` : ''}${e.patch ? `<br>+${e.patch.added ?? 0} −${e.patch.removed ?? 0} lines` : ''}`;
  }

  // ---- chart pieces the goal and replay pages share ------------------------------------------
  const HARNESS_KINDS = ['notification', 'guard', 'hook', 'turn-end', 'queue', 'mode', 'external-edit', 'compaction', 'error', 'session'];
  const laneOf = (e) => {
    if (e.kind === 'outcome' || e.kind === 'link') return 'git';
    if (e.kind === 'quiet') return null;
    if (e.actor === 'person' || (['prompt', 'decision', 'notice', 'command'].includes(e.kind) && e.actor !== 'harness')) return 'person';
    if (HARNESS_KINDS.includes(e.kind) || (e.kind === 'interrupt' && e.actor !== 'person')) return 'harness';
    return e.agent ?? 'harness';
  };
  const TOOL_NAME = { Bash: 'Shell commands', PowerShell: 'Shell commands (PowerShell)', Edit: 'File edits', Write: 'File writes', MultiEdit: 'File edits', NotebookEdit: 'Notebook edits', Read: 'File reads', Grep: 'Text searches', Glob: 'File-name searches', Agent: 'Started a sub-agent', Task: 'Started a sub-agent', SendMessage: 'Messages to another agent', Skill: 'Skills invoked', ToolSearch: 'Tool lookups', TodoWrite: 'Plan updates', TaskCreate: 'Plan items created', TaskUpdate: 'Plan items updated', AskUserQuestion: 'Questions to you', ExitPlanMode: 'Plans put to you', WebSearch: 'Web searches', WebFetch: 'Web pages read', SendUserFile: 'Files sent to you', ReadNotifications: 'Notification checks', Monitor: 'Watchers started', ScheduleWakeup: 'Scheduled wake-ups', TaskStop: 'Background tasks stopped', exec_command: 'Shell commands', shell: 'Shell commands', apply_patch: 'File edits', spawn_agent: 'Started a sub-agent', update_plan: 'Plan updates' };
  const HARNESS_SUB = { notification: 'Completion notices', guard: 'Refusals', hook: 'Hooks run', 'turn-end': 'Turn ends', queue: 'Queued messages', mode: 'Mode changes', 'external-edit': 'Files changed outside the agent', compaction: 'Context compacted', error: 'Errors', interrupt: 'Interruptions', session: 'Session start' };
  const subOf = (e, lane) => {
    if (lane === 'person') return e.kind === 'decision' ? 'Decisions' : e.kind === 'interrupt' ? 'Interruptions' : 'Prompts and commands';
    if (lane === 'git') return e.kind === 'link' ? 'Pull-request links (harness)' : e.outcome === 'pr-landed' || e.facts?.outcome === 'pr-landed' ? 'Pull requests landed (git)' : 'Commits (git)';
    if (lane === 'harness') return HARNESS_SUB[e.kind] ?? e.kind;
    if (e.kind === 'message') return 'Messages';
    if (e.kind === 'delegation-received') return 'Starting instruction';
    if (e.kind === 'agent-message') return 'Between agents';
    if (e.kind === 'action') {
      const t = e.tool ?? e.facts?.tool ?? 'unknown';
      if (TOOL_NAME[t]) return `${TOOL_NAME[t]} · ${t}`;
      if (t.startsWith('mcp:')) return `${e.cat === 'browser' ? 'Browser' : 'Connected tool'} · ${t.slice(4)}`;
      if (t.startsWith('mcp__')) return `${e.cat === 'handoff' ? 'Task suggestions' : 'Connected tool'} · ${t.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')}`;
      return t;
    }
    return e.kind;
  };
  const color = (e) => (e.group && ['run', 'change', 'look', 'other'].includes(e.group) ? `var(--${e.group})` : 'var(--other)');
  /** One step's mark: focusable, opened with Enter, named for a screen reader. A step whose time
   *  was borrowed or moved gets a dashed outline, as the legend says. */
  function markSvg(e, { x, mid, small, playhead, big = 7, sm = 5, label = '' }) {
    const cx = x(e.t);
    const hh = small ? sm : big;
    const fade = e.t > playhead ? ' opacity="0.28"' : '';
    const moved = !e.__gitop && timeMoved(e);
    const a = `class="mark${moved ? ' timeby' : ''}" data-id="${esc(e.id)}"${e.__gitop ? ' data-gitop="1"' : ''} tabindex="0" role="button" aria-label="${esc(label)}"`;
    const dash = moved ? ' stroke-dasharray="2 1.5"' : '';
    if (e.__gitop) return `<path ${a} d="M${cx},${mid - hh} l${hh},${hh} l-${hh},${hh} l-${hh},-${hh}z" fill="none" stroke="var(--git)" stroke-width="1.5"${fade}/>`;
    if (e.kind === 'action') {
      const w = e.endT ? Math.max(3, x(e.endT) - cx) : 6;
      const fill = e.missing.includes('result') ? 'url(#hatch)' : color(e);
      return `<rect ${a} x="${cx}" y="${mid - hh}" width="${w}" height="${hh * 2}" rx="${small ? 2.5 : 3}" fill="${fill}" stroke="${moved ? 'var(--ink)' : 'var(--surface)'}" stroke-width="${moved ? 1.2 : 1}"${dash}${fade}/>`;
    }
    if (e.kind === 'prompt' || e.kind === 'command' || e.kind === 'notice') return `<path ${a} d="M${cx},${mid - hh - 1} l${hh},${hh + 1} l-${hh},${hh + 1} l-${hh},-${hh + 1}z" fill="var(--person)"${moved ? ' stroke="var(--run)" stroke-width="1.2"' : ''}${dash}${fade}/>`;
    if (e.kind === 'decision') return `<path ${a} d="M${cx},${mid - hh} l${hh - 1},${hh} l-${hh - 1},${hh} l-${hh - 1},-${hh}z" fill="var(--surface)" stroke="var(--person)" stroke-width="1.5"${dash}${fade}/>`;
    if (e.kind === 'outcome') return e.outcome === 'pr-landed' || e.facts?.outcome === 'pr-landed' ? `<rect ${a} x="${cx - hh + 1}" y="${mid - hh + 1}" width="${(hh - 1) * 2}" height="${(hh - 1) * 2}" rx="2" fill="var(--git)"${fade}/>` : `<circle ${a} cx="${cx}" cy="${mid}" r="${hh - 1.5}" fill="var(--surface)" stroke="var(--git)" stroke-width="2"${dash}${fade}/>`;
    if (e.kind === 'interrupt' || e.kind === 'guard') return `<g ${a}${fade}><circle cx="${cx}" cy="${mid}" r="${hh}" fill="var(--${e.kind === 'guard' ? 'critical' : 'serious'})"${moved ? ' stroke="var(--ink)" stroke-width="1.2"' : ''}${dash}/><text x="${cx}" y="${mid + 3.5}" text-anchor="middle" font-size="${small ? 8 : 10}" fill="#fff" aria-hidden="true">${e.kind === 'guard' ? '⊘' : '!'}</text></g>`;
    if (e.kind === 'notification') return `<path ${a} d="M${cx},${mid + hh} V${mid - hh} l7,3 l-7,3" fill="var(--ink-2)" stroke="var(--ink-2)"${dash}${fade}/>`;
    if (e.kind === 'delegation-received') return `<g ${a}${fade}><path d="M${cx - 1},${mid - hh - 1} h${hh * 2 + 3} v${hh * 2 - 1} h-${hh * 2 - 2} l-5,4 v-4 z" fill="var(--surface)" stroke="var(--ink)" stroke-width="1.4"${dash}/><line x1="${cx + 2}" x2="${cx + hh * 2 - 1}" y1="${mid - hh / 2 + 0.5}" y2="${mid - hh / 2 + 0.5}" stroke="var(--ink)"/><line x1="${cx + 2}" x2="${cx + hh * 2 - 4}" y1="${mid + 1.5}" y2="${mid + 1.5}" stroke="var(--ink)"/></g>`;
    if (e.kind === 'message' || e.kind === 'agent-message') return `<circle ${a} cx="${cx}" cy="${mid}" r="${small ? 3 : 3.5}" fill="var(--ink-2)"${moved ? ' stroke="var(--ink)" stroke-width="1"' : ''}${dash}${fade}/>`;
    if (e.kind === 'link') return `<line ${a} x1="${cx}" x2="${cx}" y1="${mid - hh + 2}" y2="${mid + hh - 2}" stroke="var(--git)" stroke-width="1.5" stroke-dasharray="2 2"${fade}/>`;
    return `<line ${a} x1="${cx}" x2="${cx}" y1="${mid - hh}" y2="${mid + hh}" stroke="var(--muted)" stroke-width="2"${dash}${fade}/>`;
  }
  /** Tick spacing from the pixels available, not the time span: at least ~95px per label. */
  function niceStep(msPerPx) {
    const want = msPerPx * 95;
    const choices = [10e3, 30e3, 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];
    return choices.find((s) => s >= want) ?? 86400e3;
  }
  /** A chart label cut to its room, as escaped SVG text markup: cut where clip() may cut, with
   *  the "…" in a tspan of its own so it never reads as part of the label. */
  const fitText = (s, room, char = 6.3) => {
    const n = Math.max(6, Math.floor(room / char));
    const t = String(s ?? '');
    if (t.length <= n) return esc(t);
    const cut = clip(t, n - 1);
    return cut.length < t.length ? `${esc(cut)}<tspan>…</tspan>` : esc(t);
  };
  /** The chart's list for a screen reader: one item per drawn step, in drawing order. */
  function stepList(el, drawn) {
    if (!el) return;
    el.innerHTML = drawn.map((d) => `<li data-id="${esc(d.id)}">${d.pieces ? piecesHtml(d.pieces) : esc(d.text)}</li>`).join('');
    const count = document.getElementById('stepCount');
    if (count) count.textContent = plural(drawn.length, 'step');
  }
  /** Keep keyboard focus on the same step when the chart is drawn again. */
  function focusedMark(svg) {
    const a = document.activeElement;
    return a && svg.contains(a) && a.dataset?.id ? a.dataset.id : null;
  }
  function refocus(svg, id) {
    if (!id) return;
    const el = svg.querySelector(`.mark[data-id="${CSS.escape(id)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  /** Enter (or Space) on a focused mark opens its record. */
  function keyboardMarks(svg, open) {
    svg.addEventListener('keydown', (ev) => {
      const m = ev.target.closest?.('.mark[data-id]');
      if (!m || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      ev.stopPropagation();
      open(m.dataset.id, m);
    });
  }
  // One polite line for screen readers, updated on Step, Prompt and Pause only (never per Play tick).
  // A line in pieces (describeStepPieces) keeps each piece from the logs in its own element.
  const announce = (text) => {
    const el = document.getElementById('announce');
    if (el && Array.isArray(text)) el.innerHTML = piecesHtml(text);
    else if (el) el.textContent = text;
  };
  // Space presses a focused control; it only starts playback when nothing interactive has focus.
  const ownsSpace = (ev) => ev.key === ' ' && !!ev.target.closest?.('button, [role="button"], summary, a, input, select, textarea, label, [contenteditable]');

  /** A frame (the engine's state at one moment) as the panels read it, with each count's level. */
  function frameOf(f) {
    if (!f) return null;
    const c = f.counts ?? f;
    const ev = f.countEvidence ?? f.evidence ?? {};
    // The server names each count's level by its frame name (testsPassed); the engine's
    // timeline by its own (testRunsAllPassed). Either is read, so a count keeps its level.
    const ALIAS = { testRunsAllPassed: 'testsPassed', testRunsWithFailures: 'testsFailed', testRunsNoSummary: 'testsNoSummary', commitsByConfiguredIdentity: 'commits' };
    const L = (k, fb) => (typeof ev[k] === 'string' ? ev[k] : typeof ev[ALIAS[k]] === 'string' ? ev[ALIAS[k]] : fb);
    const n = (v) => (Number.isFinite(num(v)) ? num(v) : 0);
    return {
      t: Number.isFinite(f.t) ? f.t : toT(f.at),
      prompts: [n(c.prompts), L('prompts', 'recorded')],
      actions: [n(c.actions), L('actions', 'recorded')],
      edits: [n(c.edits), L('edits', 'recorded')],
      filesEdited: [n(f.filesEdited ?? c.filesEdited), L('filesEdited', 'derived')],
      testRuns: [n(c.testRuns), L('testRuns', 'inferred')],
      testsPassed: [n(c.testRunsAllPassed ?? c.testsPassed), L('testRunsAllPassed', 'inferred')],
      testsFailed: [n(c.testRunsWithFailures ?? c.testsFailed), L('testRunsWithFailures', 'inferred')],
      testsUnclear: [n(c.testRunsNoSummary ?? c.testsNoSummary) + n(c.testRunsUnclear), L('testRunsNoSummary', 'missing')],
      delegations: [n(c.delegations), L('delegations', 'recorded')],
      guards: [n(c.guards), L('guards', 'recorded')],
      interrupts: [n(c.interrupts), L('interrupts', 'recorded')],
      commits: [n(c.commitsByConfiguredIdentity ?? c.commits), L('commitsByConfiguredIdentity', 'recorded')],
      prsLanded: [n(c.prsLanded), L('prsLanded', 'inferred')],
      awaiting: Array.isArray(f.awaiting) ? f.awaiting : (f.callsAwaitingRecordedResult ?? []).map((x) => ({ event: x.event, never: x.resultNeverRecorded === true })),
      agentsOpen: Array.isArray(f.agentsOpen) ? f.agentsOpen : f.agentsWithOpenRecordedSpan ?? [],
      queued: Array.isArray(f.queued) ? f.queued : (f.messagesQueued ?? []).map((x) => x.event),
      quiet: typeof f.quiet === 'boolean' ? f.quiet : Array.isArray(f.quietSessions) ? f.quietSessions.length > 0 : false,
    };
  }

  window.HW = {
    esc, plural, toT, num, lvl, time, dayOf, dur, windowText, nothingIn, setTimezone,
    shell, start, load, fail, fatal, setStatus, addNote, isId, ID,
    chip, chips: HWE.chips, ruleText, authorship, who, timeHow, timeMoved, kindLabel, lowerFirst, stripKind, summary, describeStep, describeStepPieces, clip, clipHtml, GROUP_LABEL,
    data, normEvent, useData, agentLabel, openEvent, closeDrawer, onDrawer,
    showTip, hideTip, tipHtml,
    laneOf, subOf, color, markSvg, niceStep, fitText, stepList, focusedMark, refocus, keyboardMarks, announce, ownsSpace, frameOf,
  };
})();
