// lib/view/facts.mjs: plain facts about each session, the ones Claude Code's /insights writes to
// its session-meta files, computed by honestweek itself from the logs it already read, for
// Claude Code and Codex alike. No model is asked and nothing is read again: every fact comes
// from the work history's events and token counts.
//
// Each fact says how it's known:
//   recorded      a record holds it as it stands (a start time, a prompt's time)
//   derived       counted or computed from recorded values only (a count, a sum, a gap)
//   inferred      a named pattern produced it and could be wrong (a "risky" command)
//   not-recorded  this agent's logs, as honestweek reads them, don't carry it; never shown as 0
//   hidden        recorded, but not shown: the folder of a session outside the configured repos
//
// Facts are numbers, names and times, plus two strings (the first prompt and the folder),
// which the caller passes through the page's redactor before they're shown.

import { mcpServer } from '../replay/classify.mjs';
import { editedFileKeys } from '../replay/metrics.mjs';

/** The facts, in the order /insights writes them, with the short label a page shows. */
export const FACTS = Object.freeze([
  ['session_id', 'Session id'],
  ['project_path', 'Folder'],
  ['start_time', 'Started'],
  ['duration_minutes', 'Minutes'],
  ['user_message_count', 'Your messages'],
  ['assistant_message_count', 'Agent messages'],
  ['tool_counts', 'Tools'],
  ['languages', 'Languages'],
  ['git_commits', 'Commits run'],
  ['git_pushes', 'Pushes run'],
  ['input_tokens', 'Input tokens'],
  ['output_tokens', 'Output tokens'],
  ['first_prompt', 'First prompt'],
  ['user_interruptions', 'Interruptions'],
  ['user_response_times', 'Your reply time'],
  ['tool_errors', 'Tool errors'],
  ['tool_error_categories', 'Errors by tool'],
  ['uses_task_agent', 'Sub-agents'],
  ['uses_mcp', 'MCP tools'],
  ['uses_web_search', 'Web search'],
  ['uses_web_fetch', 'Web fetch'],
  ['lines_added', 'Lines added'],
  ['lines_removed', 'Lines removed'],
  ['files_modified', 'Files changed'],
  ['message_hours', 'Hours you wrote'],
  ['user_message_timestamps', 'Message times'],
  ['bash_would_prompt_count', 'Would prompt'],
  ['file_edit_tool_count', 'Edits'],
  ['destructive_command_count', 'Risky commands'],
]);
export const FACT_NAMES = Object.freeze(FACTS.map(([n]) => n));

/**
 * What an agent's logs don't carry, as honestweek reads them. Neither log says whether a
 * command would have asked for permission. Codex has no web fetch tool, and the engine doesn't
 * read Codex's web search records.
 */
const NOT_RECORDED = Object.freeze({
  'claude-code': new Set(['bash_would_prompt_count']),
  codex: new Set(['bash_would_prompt_count', 'uses_web_search', 'uses_web_fetch']),
});

/** The pattern behind destructive_command_count: commands that delete or rewrite. */
export const DESTRUCTIVE_RULE = 'facts.destructive-command';
const DESTRUCTIVE = [
  /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+push\b[^;&|\n]*\s(?:--force(?:-with-lease)?|-f)\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bRemove-Item\b[^;&|\n]*-Recurse/i,
  /\b(?:rmdir|rd|del)\s+\/[sq]\b/i,
  /\bdrop\s+(?:table|database)\b/i,
];
const GIT_COMMIT = /\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b/;
const GIT_PUSH = /\bgit\s+(?:-[cC]\s+\S+\s+)*push\b/;
const DID_NOT_RUN = new Set(['rejected', 'refused', 'interrupted']);

const LANGUAGE = Object.freeze({
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', cs: 'C#', c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', hpp: 'C++', php: 'PHP', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', sql: 'SQL',
  md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', html: 'HTML', css: 'CSS', scss: 'CSS',
});
const languageOf = (file) => {
  const m = typeof file === 'string' ? file.match(/\.([A-Za-z0-9]+)$/) : null;
  return m ? LANGUAGE[m[1].toLowerCase()] ?? null : null;
};

const fact = (value, how) => ({ value, how });
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const bump = (obj, k, n = 1) => {
  obj[k] = (obj[k] ?? 0) + n;
};

/** The hour of day, 0 to 23, of an instant in `timezone`. */
function hourIn(t, timezone) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)));
  return h === 24 ? 0 : h;
}

/**
 * sessionFacts(h, session, { timezone, usage, id, cwd, hidden, events }) -> { key, agent, facts }
 * `h` is a work history, `session` one of its sessions. `usage` is the token-count list
 * (h.usage.calls, possibly from another build of the same window), `id` the session's own id
 * (Claude Code's file id or Codex's thread id) or null, `cwd` its working folder or null, and
 * `hidden` true for a session outside the configured repos, whose folder isn't shown. The
 * two text facts, first_prompt and project_path, are returned as they are: the caller redacts.
 */
export function sessionFacts(h, session, { timezone = 'UTC', usage = null, id = null, cwd = null, hidden = false, events = null } = {}) {
  const agent = session.tool === 'codex' ? 'codex' : 'claude-code';
  const mine = (events ?? h.events.filter((e) => e.session === session.key)).slice().sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const main = `${session.key}:main`;
  const prompts = mine.filter((e) => e.kind === 'prompt');
  const promptHow = prompts.some((e) => (e.inferred ?? []).some((x) => x.key === 'authorship')) ? 'inferred' : 'derived';
  const actions = mine.filter((e) => e.kind === 'action');
  const tools = {};
  const errorsByTool = {};
  const languages = {};
  let commits = 0;
  let pushes = 0;
  let destructive = 0;
  let added = 0;
  let removed = 0;
  let edits = 0;
  const files = new Set();
  for (const e of actions) {
    const f = e.facts;
    bump(tools, f.tool ?? 'other');
    if (f.result === 'error') bump(errorsByTool, f.tool ?? 'other');
    const lang = languageOf(f.file);
    if (lang && (f.category === 'edit' || f.category === 'read')) bump(languages, lang);
    if (f.category === 'edit') {
      edits++;
      if (f.result === 'ok') {
        const p = e.derived?.patch;
        if (p) {
          added += p.added ?? 0;
          removed += p.removed ?? 0;
        }
        // A whole-file write records the lines it wrote, not a patch against the old file.
        if (Number.isInteger(e.derived?.linesWritten) && !(p?.added || p?.removed)) added += e.derived.linesWritten;
        for (const k of editedFileKeys(e)) files.add(k);
      }
    }
    if (f.category === 'shell' && typeof f.command === 'string' && !DID_NOT_RUN.has(f.result)) {
      if (GIT_COMMIT.test(f.command)) commits++;
      if (GIT_PUSH.test(f.command)) pushes++;
      if (DESTRUCTIVE.some((re) => re.test(f.command))) destructive++;
    }
  }
  // The person's interruptions: Claude Code records who stopped a run; Codex records that a
  // turn was interrupted, not by whom, so its count is an inference.
  const interrupts = mine.filter((e) => e.kind === 'interrupt');
  const byPerson = interrupts.filter((e) => e.facts.by === 'person').length;
  const codexInterrupted = interrupts.filter((e) => e.facts.by === 'harness-reported' && e.facts.reason === 'interrupted').length;
  // Reply time: from the main agent's last recorded step to the person's next prompt.
  const replies = [];
  let lastAgentT = null;
  for (const e of mine) {
    if (e.kind === 'prompt' && e.agent === main) {
      if (lastAgentT != null && e.t >= lastAgentT) replies.push(Math.round((e.t - lastAgentT) / 1000));
      lastAgentT = null;
    } else if (e.agent === main && (e.kind === 'message' || e.kind === 'action' || e.kind === 'turn-end')) {
      lastAgentT = Math.max(lastAgentT ?? 0, e.end?.t ?? e.t);
    }
  }
  const hours = {};
  for (const e of prompts) bump(hours, String(hourIn(e.t, timezone)));
  const calls = (usage ?? []).filter((c) => c.session === session.key);
  const first = prompts.find((e) => typeof e.facts.text === 'string');
  const firstT = Date.parse(session.firstAt);
  const lastT = Date.parse(session.lastAt);

  const out = {
    session_id: id ? fact(id, 'recorded') : fact(null, 'not-recorded'),
    project_path: hidden ? fact(null, 'hidden') : cwd ? fact(cwd, 'recorded') : fact(null, 'not-recorded'),
    start_time: fact(session.firstAt ?? null, 'recorded'),
    duration_minutes: fact(Number.isFinite(firstT) && Number.isFinite(lastT) ? Math.round((lastT - firstT) / 60000) : null, 'derived'),
    user_message_count: fact(prompts.length, promptHow),
    assistant_message_count: fact(mine.filter((e) => e.kind === 'message' && e.agent === main).length, 'derived'),
    tool_counts: fact(tools, 'derived'),
    languages: fact(languages, 'derived'),
    git_commits: fact(commits, 'derived'),
    git_pushes: fact(pushes, 'derived'),
    input_tokens: calls.length ? fact(calls.reduce((n, c) => n + (c.input ?? 0), 0), 'derived') : fact(null, 'not-recorded'),
    output_tokens: calls.length ? fact(calls.reduce((n, c) => n + (c.output ?? 0), 0), 'derived') : fact(null, 'not-recorded'),
    first_prompt: fact(first ? first.facts.text : null, 'recorded'),
    user_interruptions: agent === 'codex' ? fact(codexInterrupted, codexInterrupted ? 'inferred' : 'derived') : fact(byPerson, 'derived'),
    user_response_times: fact(replies, 'derived'),
    tool_errors: fact(actions.filter((e) => e.facts.result === 'error').length, 'derived'),
    tool_error_categories: fact(errorsByTool, 'derived'),
    uses_task_agent: fact(actions.some((e) => e.facts.category === 'delegate'), 'derived'),
    uses_mcp: fact(actions.some((e) => mcpServer(e.facts.tool) != null), 'derived'),
    uses_web_search: fact(actions.some((e) => e.facts.tool === 'WebSearch'), 'derived'),
    uses_web_fetch: fact(actions.some((e) => e.facts.tool === 'WebFetch'), 'derived'),
    lines_added: fact(added, 'derived'),
    lines_removed: fact(removed, 'derived'),
    files_modified: fact(files.size, 'derived'),
    message_hours: fact(hours, 'derived'),
    user_message_timestamps: fact(prompts.map((e) => e.at).filter((x) => typeof x === 'string'), 'recorded'),
    bash_would_prompt_count: fact(null, 'not-recorded'),
    file_edit_tool_count: fact(edits, 'derived'),
    destructive_command_count: fact(destructive, destructive ? 'inferred' : 'derived'),
  };
  for (const name of NOT_RECORDED[agent]) out[name] = fact(null, 'not-recorded');
  return { key: session.key, agent, facts: out };
}

/** The median reply time in seconds, the one figure a page shows for user_response_times. */
export const medianReply = (secs) => median(secs);

/**
 * windowTotals(list) -> { all, 'claude-code', codex }
 * Totals over sessions' facts: counts and sums added, true facts counted as sessions, maps
 * merged. Each total says how many sessions it's known for; a fact no session records stays
 * not-recorded, never 0. A total is inferred when any part of it is.
 */
export function windowTotals(list) {
  const empty = () => ({ sessions: 0, facts: {} });
  const out = { all: empty(), 'claude-code': empty(), codex: empty() };
  for (const s of list) {
    for (const t of [out.all, out[s.agent]]) {
      t.sessions++;
      for (const name of FACT_NAMES) {
        if (name === 'session_id' || name === 'project_path' || name === 'first_prompt' || name === 'start_time') continue;
        const f = s.facts[name];
        const cur = (t.facts[name] ??= { value: null, how: 'not-recorded', known: 0 });
        if (f.how === 'not-recorded' || f.value == null) continue;
        cur.known++;
        if (cur.how === 'not-recorded') cur.how = 'derived';
        if (f.how === 'inferred') cur.how = 'inferred';
        const v = f.value;
        if (typeof v === 'boolean') cur.value = (cur.value ?? 0) + (v ? 1 : 0);
        else if (typeof v === 'number') cur.value = (cur.value ?? 0) + v;
        else if (Array.isArray(v)) cur.value = [...(cur.value ?? []), ...v];
        else if (v && typeof v === 'object') {
          cur.value ??= {};
          for (const [k, n] of Object.entries(v)) bump(cur.value, k, n);
        }
      }
    }
  }
  // The window keeps one figure per reply-time list and per timestamp list: the median, and the count.
  for (const t of Object.values(out)) {
    if (Array.isArray(t.facts.user_response_times?.value)) t.facts.user_response_times.value = median(t.facts.user_response_times.value);
    if (Array.isArray(t.facts.user_message_timestamps?.value)) t.facts.user_message_timestamps.value = t.facts.user_message_timestamps.value.length;
  }
  return out;
}

/**
 * coverage(list) -> { [agent]: { sessions, facts: { [name]: known count } } }
 * How many of each agent's sessions each fact is known for: the figure the pull request quotes.
 */
export function coverage(list) {
  const out = {};
  for (const s of list) {
    const c = (out[s.agent] ??= { sessions: 0, facts: Object.fromEntries(FACT_NAMES.map((n) => [n, 0])) });
    c.sessions++;
    for (const n of FACT_NAMES) if (s.facts[n].how !== 'not-recorded') c.facts[n]++;
  }
  return out;
}
