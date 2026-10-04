// The quiet "Facts" fold: plain facts about each session, the ones Claude Code's /insights
// writes to session-meta, worked out by honestweek itself from the logs, for Claude Code and
// Codex alike, no model involved. On Replay it lists each session in the replay; on Problems it
// shows the window's totals. Each fact carries how it's known (the evidence symbols), and a fact
// an agent's logs don't carry says "not recorded", never 0. Closed until opened.
//
// Data: /api/facts (?thread=<id> on Replay, ?session=<key> on one session's Problems). Needs common.js, evidence.js and key.js; the page's
// own script starts it with HWFacts.load(params).
(function () {
  'use strict';
  const { esc } = HW;
  const box = document.getElementById('facts');
  if (!box) return;
  const LABEL = {
    session_id: 'Session id', project_path: 'Folder', start_time: 'Started', duration_minutes: 'Minutes',
    user_message_count: 'Your messages', assistant_message_count: 'Agent messages', tool_counts: 'Tools', languages: 'Languages',
    git_commits: 'Commits run', git_pushes: 'Pushes run', input_tokens: 'Input tokens', output_tokens: 'Output tokens',
    first_prompt: 'First prompt', user_interruptions: 'Interruptions', user_response_times: 'Your reply time', tool_errors: 'Tool errors',
    tool_error_categories: 'Errors by tool', uses_task_agent: 'Sub-agents', uses_mcp: 'MCP tools', uses_web_search: 'Web search',
    uses_web_fetch: 'Web fetch', lines_added: 'Lines added', lines_removed: 'Lines removed', files_modified: 'Files changed',
    message_hours: 'Hours you wrote', user_message_timestamps: 'Message times', bash_would_prompt_count: 'Would prompt',
    file_edit_tool_count: 'Edits', destructive_command_count: 'Risky commands',
  };
  const AGENT = { 'claude-code': 'Claude Code', codex: 'Codex' };
  const HELP = '<p>Worked out by honestweek from your logs. No model is asked. The symbol says how each is known. "not recorded" means that agent\'s logs don\'t carry it.</p><p>Risky commands match a fixed pattern (rm -rf, git reset --hard, force push and the like). Reply time runs from the agent\'s last step to your next message. Input tokens leave out cached input.</p>';
  const why = (html) => `<details class="fwhy"><summary title="About these facts" aria-label="About these facts">?</summary><div>${html}</div></details>`;
  const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '');
  const median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const secs = (n) => (n == null ? '–' : n < 120 ? `${Math.round(n)} s` : `${Math.round(n / 60)} min`);

  /** One fact's value as short text. Sessions-wide totals count true facts as sessions. */
  function shown(name, f, total) {
    if (f.how === 'not-recorded') return '<span class="muted">not recorded</span>';
    if (f.how === 'hidden') return '<span class="muted">hidden</span>';
    const v = f.value;
    if (v == null) return '–';
    if (name === 'user_response_times') return esc(secs(Array.isArray(v) ? median(v) : v));
    if (name === 'user_message_timestamps') return esc(Array.isArray(v) ? num(v.length) : num(v));
    if (name === 'start_time') return esc(HW.time ? HW.time(Date.parse(v), { day: true }) : v);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number') return esc(total && name.startsWith('uses_') ? `${num(v)} sessions` : num(v));
    if (typeof v === 'string') return esc(v);
    if (typeof v === 'object') {
      const parts = Object.entries(v).sort((a, b) => b[1] - a[1]);
      if (!parts.length) return '–';
      const shownParts = parts.slice(0, 6).map(([k, n]) => `${esc(name === 'message_hours' ? `${k}:00` : k)} ${num(n)}`);
      return `${shownParts.join(', ')}${parts.length > 6 ? ` +${parts.length - 6}` : ''}`;
    }
    return '';
  }
  const mark = (how) => (how === 'not-recorded' || how === 'hidden' ? '' : window.HWE ? HWE.sym(how) : esc(how));
  const table = (facts, total) =>
    `<table class="facts-t"><tbody>${Object.keys(LABEL)
      .filter((n) => facts[n])
      .map((n) => `<tr data-fact="${esc(n)}"><th scope="row">${esc(LABEL[n])}</th><td>${shown(n, facts[n], total)}</td><td>${mark(facts[n].how)}</td></tr>`)
      .join('')}</tbody></table>`;

  function render(a, params) {
    let body = '';
    let count = '';
    if (params.thread || params.session) {
      const list = a.sessions ?? [];
      count = list.length > 1 ? ` <span class="hcount">${list.length}</span>` : '';
      body = list.map((s, i) => `<section class="facts-s" data-facts-session="${esc(s.key)}">${list.length > 1 ? `<h3>${esc(`Session ${i + 1}`)} <span class="muted">${esc(AGENT[s.agent] ?? s.agent)}</span></h3>` : `<p class="muted">${esc(AGENT[s.agent] ?? s.agent)}</p>`}${table(s.facts, false)}</section>`).join('');
    } else {
      const t = a.totals ?? {};
      const cols = ['claude-code', 'codex'].filter((k) => t[k]?.sessions);
      body = cols.map((k) => `<section class="facts-s" data-facts-agent="${esc(k)}"><h3>${esc(AGENT[k])} <span class="muted">${esc(`${t[k].sessions} ${t[k].sessions === 1 ? 'session' : 'sessions'}`)}</span></h3>${table(t[k].facts, true)}</section>`).join('');
    }
    box.innerHTML = `<summary>Facts${count}</summary>${why(HELP)}<div class="facts-grid">${body || '<p class="muted">No sessions.</p>'}</div>`;
    box.hidden = false;
  }

  async function load(params = {}) {
    let a;
    try {
      a = await HW.load('facts', params);
    } catch {
      box.hidden = true;
      return;
    }
    render(a, params);
  }
  window.HWFacts = { load };
})();
