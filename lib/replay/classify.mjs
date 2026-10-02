// lib/replay/classify.mjs — the named rules behind every inference, plus the
// recorded-fact parsers (tool categories, test summaries) the adapters share.
//
// An inference is only allowed if it names a rule registered here, so the full list
// of ways the engine can interpret a record is this file. Each rule is deliberately
// narrow: when a text could mean two things, no label is better than a wrong one.

import { REDIRECT_BODY_RE, REDIRECT_RE } from '../claude-adapter.mjs';

/** id -> plain description. Views and docs print these verbatim. */
export const RULES = new Map([
  ['prompt.authorship.no-origin', 'An older record with no origin field; its text does not look like harness scaffolding, so it is read as typed by a person.'],
  ['prompt.authorship.unknown-origin', 'A record whose origin field names a kind this engine does not recognize; its text does not look like harness scaffolding or a relayed message, so it is read as typed by a person.'],
  ['prompt.authorship.exec-session', 'A prompt in a non-interactive Codex exec session; a script or a person may have written it.'],
  ['prompt.correction', 'The person\'s message opens with a redirect ("no", "wait", "actually", "stop", "revert", "undo", "hold on", "instead", "that\'s wrong", "that\'s not", "don\'t") or says "instead of", "revert", "roll back", "undo that", "that\'s wrong", or "not what I" (the patterns the weekly digest already uses).'],
  ['prompt.approval', 'A short message (at most 160 characters) that opens with go, yes, approve, approved, lgtm, ship it, merge, proceed, or do it.'],
  ['prompt.resume', 'A short message asking the agent to continue, resume, or pick up where it stopped.'],
  ['prompt.question', 'The person\'s message contains a question mark at the end of a sentence.'],
  ['shell.test', 'The command line runs a known test runner (node --test, npm test, jest, vitest, pytest, go test, cargo test, mocha).'],
  ['shell.revert', 'The command line discards or reverses work: git revert, git reset --hard, git checkout --, git restore, git stash drop.'],
  ['shell.git-commit-output', 'A commit id read from the summary line a successful git commit printed, or, when a quiet commit (-q) printed none, from the first commit a git log or show joined to it by && printed (HEAD, the commit just made), provided nothing before the commit in that line prints output. Used only when the harness recorded no commit itself.'],
  ['shell.gh-pr-output', 'A pull request named by the URL a gh pr create command printed, used only when the harness recorded no pull request itself.'],
  ['git.pr-number-from-subject', 'Git has no record of pull requests: a pull request counts as landed when a default-branch commit by a configured identity names it in its own subject ("Merge pull request #N" or a trailing "(#N)"), or, failing that, when such a commit reached the default branch in a merge whose subject names it (the merge\'s author is not checked). The earliest landing is cited.'],
  ['review.delegation', 'A delegated task whose description or agent type names a review, audit, verification, or fact-check.'],
  ['review.skill', 'An invoked skill whose name names a review.'],
  ['handoff.chip-start', 'A session whose first typed prompt is exactly the prompt of a task suggestion an earlier session made.'],
  ['canonical.earliest-ending-copy', 'When one record appears in several session files, the copy in the file whose last record is earliest is treated as the original.'],
]);

// ---------------------------------------------------------------------------
// Person-prompt interpretation
// ---------------------------------------------------------------------------

// The redirect patterns are the session adapter's own, so "correction" means one
// thing across honestweek.
const REDIRECT_OPEN_RE = REDIRECT_RE;
const APPROVAL_RE = /^\s*(go|yes|yep|approve[ds]?|lgtm|ship it|merge|proceed|do it)\b/i;
const RESUME_RE = /\b(continue|resume|pick (it |this )?(back )?up|carry on|keep going)\b/i;
const QUESTION_RE = /\?(\s|$)/;

/** Rule-based labels for a person's prompt text. Returns [{ key, value, rule }]. */
export function promptInferences(text) {
  if (typeof text !== 'string') return [];
  const t = text.trim();
  if (!t) return [];
  const out = [];
  if (REDIRECT_OPEN_RE.test(t) || REDIRECT_BODY_RE.test(t)) out.push({ key: 'intent', value: 'correction', rule: 'prompt.correction' });
  if (t.length <= 160 && APPROVAL_RE.test(t)) out.push({ key: 'intent', value: 'approval', rule: 'prompt.approval' });
  if (t.length <= 160 && RESUME_RE.test(t)) out.push({ key: 'intent', value: 'resume-request', rule: 'prompt.resume' });
  if (QUESTION_RE.test(t)) out.push({ key: 'intent', value: 'question', rule: 'prompt.question' });
  return out;
}

// ---------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------

// Each pattern must match at the START of a simple command (after any VAR=value
// assignments), so a runner named inside a commit message, a PR body, or an echo
// is not mistaken for a run.
const TEST_RUNNERS = [
  [/^node\s+(--[\w-]+(=\S+)?\s+)*--test\b/, 'node --test'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?test\b/, 'npm test'],
  [/^(npx\s+)?jest\b/, 'jest'],
  [/^(npx\s+)?vitest\b/, 'vitest'],
  [/^(python3?\s+-m\s+)?pytest\b/, 'pytest'],
  [/^go\s+test\b/, 'go test'],
  [/^cargo\s+test\b/, 'cargo test'],
  [/^(npx\s+)?mocha\b/, 'mocha'],
];

const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;

/** The simple commands of a shell line, with heredoc bodies and quoted strings removed. */
export function simpleCommands(command) {
  if (typeof command !== 'string') return [];
  const s = command
    .replace(HEREDOC_RE, '<<heredoc')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return s
    .split(/&&|\|\||;|\||\n|\(|\)|\$\(/)
    .map((x) => x.trim().replace(/^(\w+=\S*\s+)+/, '').replace(/^(time|exec|env)\s+/, ''))
    .filter(Boolean);
}

/** The test runner a command line invokes, or null. */
export function testRunner(command) {
  for (const cmd of simpleCommands(command)) for (const [re, name] of TEST_RUNNERS) if (re.test(cmd)) return name;
  return null;
}

const REVERT_RE = /^git\s+(-C\s+\S+\s+)?(revert\b|reset\s+--hard\b|checkout\s+--(\s|$)|restore\b|stash\s+drop\b)/;
export function isRevertCommand(command) {
  return simpleCommands(command).some((c) => REVERT_RE.test(c));
}

/** True when the command's exit status is not the test runner's own: a pipeline or
 *  a list after the runner means the recorded exit flag belongs to something else. */
export function exitStatusIsAmbiguous(command) {
  return typeof command === 'string' && /(\|(?!\|)|;|&&|\|\||\n)/.test(command);
}

/**
 * Pass/fail counts printed by a test runner, parsed from recorded output. Returns
 * { tests, pass, fail, parser } or null. Only exact summary formats are read, and a
 * summary that reports no tests at all is no summary.
 */
export function parseTestSummary(output) {
  if (typeof output !== 'string' || !output) return null;
  const done = (tests, pass, fail, parser) => (!(tests > 0) || pass + fail === 0 ? null : { tests, pass, fail, parser });
  const count = (seg, word) => Number(seg.match(new RegExp(`(\\d+) ${word}\\b`))?.[1] ?? 0);
  // node --test (TAP reporter): "# tests 12" "# pass 11" "# fail 1"
  const nt = output.match(/^# tests (\d+)\s*$/m);
  const np = output.match(/^# pass (\d+)\s*$/m);
  const nf = output.match(/^# fail (\d+)\s*$/m);
  if (np && nf) return done(nt ? Number(nt[1]) : Number(np[1]) + Number(nf[1]), Number(np[1]), Number(nf[1]), 'node-tap');
  // node --test (spec reporter): "ℹ tests 12" "ℹ pass 11" "ℹ fail 1"
  const sp = output.match(/^\S*\s*pass (\d+)\s*$/m);
  const sf = output.match(/^\S*\s*fail (\d+)\s*$/m);
  const st = output.match(/^\S*\s*tests (\d+)\s*$/m);
  if (sp && sf && st) return done(Number(st[1]), Number(sp[1]), Number(sf[1]), 'node-spec');
  // A test file or suite that failed to load fails the run even when every test that
  // did run passed, so its count travels with the summary.
  const withSuites = (s, line) => {
    const failed = line ? count(line[1], 'failed') : 0;
    return s && failed > 0 ? { ...s, suitesFailed: failed } : s;
  };
  // jest: "Tests:       1 failed, 11 passed, 12 total" (any part but the total may be absent)
  const j = output.match(/^\s*Tests:\s+([^\n]*?\b(\d+) total)/m);
  if (j) return withSuites(done(Number(j[2]), count(j[1], 'passed'), count(j[1], 'failed'), 'jest'), output.match(/^\s*Test Suites:\s+([^\n]*)/m));
  // vitest: "Tests  1 failed | 11 passed (12)"
  const v = output.match(/^\s*Tests\s+([^\n]*?(?:passed|failed)[^\n]*?)\((\d+)\)\s*$/m);
  if (v) return withSuites(done(Number(v[2]), count(v[1], 'passed'), count(v[1], 'failed'), 'vitest'), output.match(/^\s*Test Files\s+([^\n]*)/m));
  // pytest: "==== 1 failed, 11 passed, 2 errors in 0.12s ====" or, with -q, "12 passed in 0.1s".
  // An error is counted as a failure: the run did not pass.
  const py = output.match(/^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected)(?:, )?)+) in [\d.]+s\b/m);
  if (py && /passed|failed|error/.test(py[1])) {
    const pass = count(py[1], 'passed');
    const fail = count(py[1], 'failed') + count(py[1], 'errors?');
    return done(pass + fail, pass, fail, 'pytest');
  }
  return null;
}

/** Commit ids from git commit's own summary line ("[branch 1a2b3c4] subject"). Lines a
 *  following git log or show printed are not read here: they can name older commits. */
export function commitSummaryShas(output) {
  if (typeof output !== 'string') return [];
  const shas = new Set();
  for (const m of output.matchAll(/^\s*\[[^\]\n]*?\b([0-9a-f]{7,40})\]/gm)) shas.add(m[1]);
  return [...shas];
}

/** When a quiet commit (-q) prints no summary and a git log or show follows it in the
 *  same command line, the first commit that log prints is HEAD: the commit just made.
 *  Only that first one is returned, never the older commits listed after it. The log
 *  must be joined to the commit by &&, so it ran only if the commit succeeded, and
 *  nothing before the commit may print, so the first commit id in the output is the
 *  log's. Anything else returns null: a missed commit is better than an old one. */
export function headShaAfterCommit(command, output) {
  if (typeof output !== 'string' || NOT_COMMITTED_RE.test(output)) return null;
  const chain = commandChain(command);
  const at = chain.findIndex((c) => GIT_COMMIT_RE.test(c.cmd));
  if (at === -1 || !/(^|\s)(--quiet|-[a-zA-Z]*q[a-zA-Z]*)(\s|$)/.test(chain[at].cmd)) return null;
  if (!chain.slice(0, at).every((c) => c.op === '&&' && SILENT_RE.test(c.cmd))) return null;
  const next = chain[at + 1];
  if (chain[at].op !== '&&' || !next || !printsHeadFirst(next.cmd) || gitDir(next.cmd) !== gitDir(chain[at].cmd)) return null;
  const m = output.match(/^(?:commit )?([0-9a-f]{7,40})\b/m);
  return m ? m[1] : null;
}

/** The repository a git command names with -C, or null for the working directory. */
const gitDir = (cmd) => cmd.match(/^git\s+-C\s+(\S+)/)?.[1] ?? null;

/** Options that make a log or show print something other than HEAD first. */
const NOT_HEAD_FIRST = new Set(['--reverse', '--all', '--branches', '--tags', '--remotes', '--glob', '--exclude', '--walk-reflogs', '--skip', '--since', '--after', '--until', '--before', '--author', '--committer', '--grep', '--merges', '--no-merges', '--min-parents', '--max-parents', '--first-parent', '--ancestry-path', '--not', '--stdin', '--follow', '--diff-filter']);

/** A git log or show whose first commit is HEAD: options only, numbers for options
 *  that take one, and at most the revision HEAD. No other revision, path, or filter. */
function printsHeadFirst(cmd) {
  const m = cmd.match(/^git\s+(?:-C\s+\S+\s+)?(?:log|show)(?:\s+(.*))?$/);
  if (!m) return false;
  return (m[1] ?? '').split(/\s+/).filter(Boolean).every((t) => {
    if (t === 'HEAD' || /^\d+$/.test(t)) return true;
    if (!t.startsWith('-') || t === '--') return false;
    if (/^-[gSGL]/.test(t)) return false;
    return !NOT_HEAD_FIRST.has(t.split('=')[0]);
  });
}

/** Output git prints when a commit did not happen. */
const NOT_COMMITTED_RE = /^(nothing to commit|nothing added to commit|no changes added to commit|error:|fatal:|Aborting commit)/im;
/** Commands that print nothing when they succeed. */
const SILENT_RE = /^(cd|pushd|set-location|git\s+(-C\s+\S+\s+)?(add|stage)(?!.*\s(-v|--verbose|-n|--dry-run)\b))\b/i;

/** The simple commands of a shell line with the operator that follows each one
 *  ('&&', '||', ';', '|', or null at the end), quoting and heredocs removed as in
 *  simpleCommands. A subshell or command substitution makes the chain unreadable. */
export function commandChain(command) {
  if (typeof command !== 'string') return [];
  const s = command
    .replace(HEREDOC_RE, '<<heredoc')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/\(|\)|\$\(|`/.test(s)) return [];
  const parts = s.split(/(&&|\|\||;|\||\n)/);
  const chain = [];
  for (let i = 0; i < parts.length; i += 2) {
    const cmd = parts[i].trim().replace(/^(\w+=\S*\s+)+/, '').replace(/^(time|exec|env)\s+/, '');
    const op = parts[i + 1] === '\n' ? ';' : parts[i + 1] ?? null;
    if (cmd) chain.push({ cmd, op });
    else if (chain.length && op) chain[chain.length - 1].op = op === ';' && chain[chain.length - 1].op ? chain[chain.length - 1].op : op;
  }
  return chain;
}

/** Pull requests a gh pr create command printed: [{ repo: 'owner/name', number }]. */
export function prUrlsInOutput(command, output) {
  if (typeof output !== 'string' || !simpleCommands(command).some((c) => /^gh\s+pr\s+create\b/.test(c))) return [];
  const seen = new Map();
  for (const m of output.matchAll(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\b/g)) seen.set(`${m[1]}#${m[2]}`, { repo: m[1], number: Number(m[2]) });
  return [...seen.values()];
}
const GIT_COMMIT_RE = /^git\s+(-C\s+\S+\s+)?commit\b/;
export function isGitCommitCommand(command) {
  return simpleCommands(command).some((c) => GIT_COMMIT_RE.test(c));
}

// ---------------------------------------------------------------------------
// Tool categories (a recorded tool name mapped to what kind of step it is)
// ---------------------------------------------------------------------------

const CATEGORY = new Map([
  // Claude Code
  ['Bash', 'shell'], ['PowerShell', 'shell'], ['BashOutput', 'wait'], ['KillShell', 'stop'], ['KillBash', 'stop'],
  ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
  ['Read', 'read'], ['NotebookRead', 'read'], ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'],
  ['WebSearch', 'web'], ['WebFetch', 'web'],
  ['Agent', 'delegate'], ['Task', 'delegate'], ['Workflow', 'delegate'],
  ['SendMessage', 'agent-message'], ['SubagentHandback', 'agent-message'],
  ['TodoWrite', 'plan'], ['TaskCreate', 'plan'], ['TaskUpdate', 'plan'], ['TaskList', 'plan'], ['TaskGet', 'plan'],
  ['AskUserQuestion', 'question'], ['ExitPlanMode', 'plan-approval'], ['EnterPlanMode', 'mode'],
  ['Skill', 'skill'], ['SlashCommand', 'skill'],
  ['Monitor', 'wait'], ['ScheduleWakeup', 'wait'], ['TaskOutput', 'wait'], ['TaskStop', 'stop'],
  ['EnterWorktree', 'mode'], ['ExitWorktree', 'mode'],
  ['SendUserFile', 'deliver'], ['PushNotification', 'deliver'], ['Artifact', 'deliver'],
  ['ToolSearch', 'meta'], ['ListAgents', 'meta'], ['ReadNotifications', 'meta'],
  // Codex
  ['exec', 'shell'], ['shell', 'shell'], ['local_shell', 'shell'], ['exec_command', 'shell'], ['js', 'shell'], ['js_reset', 'shell'],
  ['apply_patch', 'edit'], ['view_image', 'read'], ['web_search', 'web'],
  ['spawn_agent', 'delegate'], ['wait_agent', 'wait'], ['sleep', 'wait'], ['wait', 'wait'],
  ['send_message', 'agent-message'], ['followup_task', 'agent-message'], ['list_agents', 'meta'],
  ['request_user_input', 'question'], ['request_user_input_async', 'question'], ['update_plan', 'plan'],
]);

/** True for a tool the harness itself provides (an entry in the table above), as
 *  opposed to an MCP server's tool or a custom one, whose name the person chose. */
export function isBuiltinToolName(name) {
  return typeof name === 'string' && CATEGORY.has(name);
}

/** The recorded category of a tool name: an exact table entry, else by MCP shape. */
export function toolCategory(name) {
  if (typeof name !== 'string' || !name) return 'other';
  const hit = CATEGORY.get(name);
  if (hit) return hit;
  if (/^mcp__.*__spawn_task$/.test(name)) return 'handoff';
  if (/^mcp__.*(browser|chrome|preview)/i.test(name)) return 'browser';
  if (/^mcp__/.test(name)) return 'external';
  return 'other';
}

/** The name of the MCP server behind a tool, never its private tool arguments. */
export function mcpServer(name) {
  const m = typeof name === 'string' ? name.match(/^mcp__([^_]+(?:_[^_]+)*?)__/) : null;
  return m ? m[1] : null;
}

const REVIEW_RE = /\b(review|reviewer|reviews|audit|verify|verification|fact-?check|critic|adversarial)\b/i;
export function looksLikeReview(...texts) {
  return texts.some((s) => typeof s === 'string' && REVIEW_RE.test(s));
}
