// lib/problems/classify.mjs: the text and command classifiers the problem checks use.
//
// Each is a named rule (RULES below), so anything one decides is an inference and says so.
// They read a step's raw input or a message's full text in memory, from the engine's
// `keepRaw` field, and return booleans, counts, fixed words or one-way fingerprints. No text
// they read is kept or returned.

import { createHash } from 'node:crypto';

import { HEREDOC_RE, SIMPLE_SPLIT, simpleCommands, testRunner } from '../replay/classify.mjs';
import { keyIsSecret, REDACTION_SOURCES } from '../redaction-patterns.mjs';

/** The rules this page adds, in plain words. A finding names the rules it rests on. */
export const RULES = Object.freeze({
  'problems.completion-claim': 'An agent message reads as a completion claim when its first or last 600 characters say the work is done, fixed, working, complete, resolved, passing or all set ("is fixed", "Done.", "I\'ve implemented", "works now"). "Should work", "should be fixed" and "should pass" count as hedged claims, separately. A message that also says something is not done, not fixed or not working isn\'t counted as a claim; one that says something is not yet done, still needed, or that it hasn\'t done something takes back only a claim in the same sentence (a dot in a file name, a version or "e.g." doesn\'t end one), and a clause about your own readiness ("let me know when you\'re ready", "once you\'re all set") is left out before the message is read. The words are matched in memory; no message text is kept.',
  'problems.claim-opens-message': 'The stricter reading a claim can reach, and it fails closed. The whole message has to be an unqualified claim: it opens with Done, Fixed, All done, All set, Complete, Completed or Implemented (or, for tests, unqualified all-pass wording: "All tests pass", "All 42 tests passed" or "Tests pass"), followed by a stop, colon, comma, exclamation mark or the line\'s end; it is 40 words or fewer; it asks nothing; it has no number after the claim; and no word anywhere in it negates, hedges, defers, admits a check wasn\'t run, or names a failure (not, but, probably, I think, should, will, next, TODO, remaining, still, unverified, check, skipped, failed, error, bug, pre-existing, and the rest of a fixed list). The message\'s text is recorded; this rule is a fixed, exact test of that text, not a reading of what it means, so a finding that otherwise rests only on recorded steps is worked out (derived). Any message that misses the bar, however it opens, stays a rule\'s reading (inferred). Whether the agent meant its words about this change is never checked.',
  'problems.admits-no-check': 'An agent message says plainly that it did not run, test, verify or build something ("didn\'t run", "not tested", "untested", "couldn\'t verify"), or asks you to run, test or try it ("can you run it again"). The catalog counts that as the honest outcome, so these turns aren\'t flagged.',
  'problems.tests-pass-claim': 'An agent message says tests pass or the suite is green ("all tests pass", "42 tests passing", "all green").',
  'problems.dismisses-failure': 'An agent message calls a failure pre-existing, unrelated, flaky, already failing, or not caused by its change.',
  'problems.check-step': 'A step counts as a check of a change when it is a test run (the engine\'s shell.test rule), a build, lint, type-check or test script (npm run build, tsc, eslint, ruff, mypy, cargo build, go vet, make), a run of code (node, python, deno, a shell script, a local ./ program), a request to a server (curl and similar), any browser or computer-use step, or a review skill call. The list is broad on purpose: a broader list flags fewer turns.',
  'problems.runnable-file': 'An edit counts as a code change when its file isn\'t documentation (.md, .txt, images, logs) or configuration (.json, .yaml, .toml, .ini, dotfiles). The catalog names changes with nothing runnable as a known false alarm.',
  'problems.test-file': 'A test file sits under a tests, test, __tests__, spec or specs folder, or is named *.test.*, *.spec.*, test_*.py, *_test.py, *_test.go or conftest.py. Test configuration is jest, vitest, playwright, karma or cypress config, pytest.ini, tox.ini, .mocharc or setupTests.',
  'problems.test-weakening': 'In the old and new text of an edit to a test file (Edit, MultiEdit, a Codex patch): lines with an assertion (assert, expect(, .should., t.is(, self.assertX(, assert_eq!), lines that define a test (it(, test(, describe(, def test_, func TestX, #[test], @Test), skip or focus markers (.skip, .only, .todo, xit, @pytest.mark.skip or xfail, @unittest.skip, @Ignore, { skip: true }), early exits (process.exit(0), sys.exit(0), os._exit) and commented-out assertions. Assertions and tests are netted across every test edit in a turn, so a test moved to another file isn\'t counted. A whole-file write isn\'t compared: its old text isn\'t in the record.',
  'problems.test-exclusion': 'A test run whose command adds --ignore, --deselect, -k "not ...", --testPathIgnorePatterns, --test-skip-pattern, --exclude, Jest\'s pass-with-no-tests flag or a trailing || true, when the previous run of the same runner by the same agent didn\'t have it.',
  'problems.same-call': 'Two tool calls are the same call when the tool and its whole input match after whitespace is collapsed (a shell command, an edit\'s file and text, a search pattern, a connector call\'s arguments). Compared by one-way fingerprint in memory; the input itself isn\'t kept. File reads, status-style shell commands, waits and plan updates are left to the re-read and polling checks.',
  'problems.no-change-between': 'Between two identical calls, nothing changed when the same agent made no successful edit and ran no other call that could change state (a different shell command, a connector call, an edit or a sub-agent start). Reads, searches, status checks, waits and plan updates don\'t count as changes.',
  'problems.error-signature': 'A tool error\'s signature is the tool, an error class from fixed words (text to replace not found, matched more than once, file not read first, not found, command not found, unknown option or bad argument, permission denied, timed out, network error, syntax error, non-zero exit, other) and the first line of the error with numbers, quoted text and paths taken out. Two errors match when their signatures do, and for edits when the file is the same too.',
  'problems.small-subagent': 'A sub-agent (a Claude Code sub-agent or a Codex child thread) that made 3 or fewer tool calls in the window.',
  'problems.near-identical-brief': 'Two sub-agents started in the same turn have near-identical briefs when at least 80% of the distinct words in their short description are shared (for a Codex child thread, which has none, the first 300 characters of its message). Compared in memory; the briefs aren\'t kept.',
  'problems.question-only-prompt': 'A prompt reads as a question only when it is under 400 characters, starts with a question word (why, what, how, where, which, who, when, is, are, does, do, did, can, could, should, would, was, were, has, have), ends with a question mark, and has no request words (fix, add, change, make, run, update, please, can you, go ahead, and about forty more). Conservative on purpose: "can you fix this?" is a request and isn\'t counted.',
  'problems.in-repo-edit': 'An edit counts toward scope creep when its file sits under the session\'s own working folder, outside any .claude folder (plans, memory and scratch files stay out).',
  'problems.plan-mode': "Plan mode is on from a recorded plan-mode notice, or a permission-mode change to plan, until a plan-mode exit notice, a change to another mode, or an approved plan. On Codex, from a turn whose recorded settings say its collaboration mode is plan, until a turn whose settings say another mode.",
  'problems.shell-read': 'A shell command counts as a file read when the whole line is one read of one file: cat (with -n at most), head or tail with a line count, sed -n with one line range, or PowerShell\'s Get-Content (or gc) with a path and at most a line count or -Raw, optionally piped to Select-Object -First, -Skip or -Last. A second file, a pipe to another program, a redirect, a separator, a variable, a wildcard, follow mode, a byte count or an in-place edit makes it not a read. The same lines read two ways (head -n 40, sed -n 1,40p, Get-Content -TotalCount 40) count as the same read.',
  'problems.commit-step': 'A step that committed or merged: the harness\'s own git record, the engine\'s shell.git-commit-output rule, or a successful shell command that runs git commit or gh pr merge.',
  'problems.risky-command': 'A shell command that ran (not rejected, refused or interrupted) and, outside quoted text (a command a shell wrapper such as bash -c or eval runs counts as run, and a leading sudo, env, nohup, time, exec, xargs, command or builtin with its options, or a variable assignment, is set aside; command -v and sudo -l only look a command up, so nothing behind them runs), runs git push with --force, -f, a +refspec or --force-with-lease (not a dry run); runs git commit, push, merge, am, rebase, cherry-pick or revert with --no-verify (or git commit with -n), or points core.hooksPath at nothing (both skip git hooks); runs rm -rf, git clean with -f and without -n or --dry-run, or git branch -D; or matches the engine\'s shell.revert rule (git revert, reset --hard, checkout --, restore, stash drop). A force-push, skipped hooks, a hard reset and git clean are worth a look; a push with --force-with-lease, which refuses to overwrite work it hasn\'t seen, a recursive delete, a deleted branch and a softer revert are routine notes.',
  'problems.secret-shape': 'A known key or token shape (sk-, gh*_, AKIA, xox, a JWT), a private-key block, a password in a web address, a Bearer or Basic credential, or a field named like a password, token, secret or API key (the same names the redactor hides a value for) whose value is 16 or more characters mixing letters and digits and not made of words. A test fixture or an example value matches the same way as a real secret; a secret with nothing around it to name it isn\'t counted. Only counts are kept, never the text.',
  'problems.status-command': 'A status-style call checks state rather than doing work: sleep or Start-Sleep, git status, gh pr checks or view, gh run view, list or watch, curl and similar against an address, a process listing, a log tail, or a tool that reads a background job\'s output, a terminal or a server log. A shell line counts when every part of it is one of these or only filters their output. Two status calls are the same call when their status part matches word for word; every wait counts as the same call.',
  'problems.state-change': 'A shell command that changes what a status check would report: git push, commit, merge, rebase, pull or cherry-pick; gh pr create, merge, ready, edit, close, reopen or comment; gh workflow run, gh run rerun, gh release create; npm publish or a deploy command. A status call after one of these starts a new count, as does a successful edit.',
  'problems.ends-in-question': 'An agent message whose last two lines include one ending in a question mark. A question isn\'t always a request to you, and a gap after one isn\'t proof you were being waited on.',
  'usage.call': 'A model call\'s recorded token counts: input, cache writes, cache reads and output. The context it read is input plus cache writes plus cache reads.',
  'cost.step': 'The estimated cost of one tool call: its round trip (the context of the model call that read its result, shared equally between the results that call read) plus what it carried (how much the context grew across the step, shared equally between that step\'s results, times the later model calls in the same agent before a compaction or the agent\'s last call). Both are worked out from recorded token counts, but sharing a jump equally and assuming a result stays in context until a compaction are estimates. Most of these tokens are cache reads, which cost less per token than fresh input; this page counts tokens, not money.',
});

// ---- small helpers ----------------------------------------------------------------------

/** A one-way fingerprint, compared in memory only and never returned. */
export const fingerprint = (s) => createHash('sha1').update(String(s)).digest('base64').slice(0, 16);

/** An input as a stable string: keys sorted, whitespace collapsed. Fingerprinted, never kept. */
export function stable(v, depth = 0) {
  if (depth > 32) return '"…"';
  if (typeof v === 'string') return JSON.stringify(v.replace(/\s+/g, ' ').trim());
  if (Array.isArray(v)) return `[${v.map((x) => stable(x, depth + 1)).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k], depth + 1)}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** A path with forward slashes and no trailing slash. */
export const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

// ---- agent messages and prompts -----------------------------------------------------------

const CLAIM_FLAT = [
  /\b(?:is|are|now|all|everything(?:'s| is)?)\s+(?:done|fixed|working|complete|completed|resolved|passing|green|in place|ready)\b/i,
  /(?:^|\n)[\s#*>_-]*(?:done|fixed|complete|all set|shipped|implemented|resolved)\b[.!:,]/i,
  /\b(?:the )?(?:fix|change|feature|bug|issue|build|page|script|check|update) (?:is|has been|was) (?:done|fixed|complete|implemented|resolved|working|in place|live)\b/i,
  /\b(?:works|working) (?:now|correctly|as expected|end to end)\b/i,
  /\bI(?:'ve| have) (?:fixed|implemented|resolved|completed|finished|built|added)\b/i,
  /\ball set\b/i,
];
const CLAIM_HEDGED = [/\b(?:should|ought to)\s+(?:now\s+)?(?:work|be (?:fixed|working|resolved|good|fine)|pass|fix it)\b/i];
const CLAIM_NEGATED = /\b(?:not|n't|never|no longer)\s+(?:yet\s+)?(?:be\s+)?(?:done|fixed|working|complete|completed|passing|resolved|ready)\b/i;
// Work still to do ("I haven't wired the UI yet", "you still need to restart it") takes back only
// a claim in its own sentence: "All tests pass. I haven't pushed yet." still claims the tests pass.
const WORK_LEFT = /\b(?:have|has)\s?n[o']t\s+(?:yet\s+)?[a-z]+ed\b|\bnot yet\b|\bstill (?:need|needs|have to|has to)\b/i;
// Clauses about the person's own readiness ("let me know when you're ready", "once you're all
// set") are taken out before a message is read for a claim: they describe the person, not the work.
const ADDRESSED = /\b(?:when|once|if|whenever|until)\s+(?:you|you're|you are|you've)\b[^.?!\n,;:]*|\b(?:let me know|tell me)\b[^.?!\n,;:]*/gi;
const ADMITS_NO_CHECK = /\b(?:did ?n[o']t|have ?n[o']t|has ?n[o']t|could ?n[o']t|was ?n[o']t able to|unable to|did not get to|not yet)\s+(?:run|test|verif|check|build|exercis)|\buntested\b|\bnot (?:been )?(?:tested|verified|run|built|checked)\b|\b(?:(?:can|could|would|will) you|please) (?:please )?(?:(?:re-?)?run|test|try)\b|\b(?:(?:can|could|would|will) you|please) (?:please )?(?:check|verify|confirm)\s+(?:(?:that )?(?:it|this|that) works|the (?:fix|change|build|tests?|suite))\b/i;
const TESTS_PASS = /\b(?:all\s+)?(?:\d[\d,]*\s+)?tests?\s+(?:now\s+)?(?:pass|passes|passing|passed|are green|green)\b|\bsuite (?:passes|is green|passed)\b|\ball green\b/i;
const DISMISSES = /\bpre-?existing\b|\bunrelated (?:to|failure|test)|\balready (?:failing|broken|red)\b|\bflaky\b|\bnot (?:caused|introduced) by (?:my|this|these|the) change/i;

/** Booleans for one agent message (problems.completion-claim and its neighbours). The zones a
 *  completion claim sits in are the message's opening and closing stretch. */
export function classifyAgentText(text) {
  const s = String(text ?? '');
  const zone = (s.length > 1200 ? `${s.slice(0, 600)}\n${s.slice(-600)}` : s).replace(ADDRESSED, ' ');
  const negated = CLAIM_NEGATED.test(zone);
  const flat = !negated && CLAIM_FLAT.some((re) => claimStands(zone, re));
  const hedged = !negated && !flat && CLAIM_HEDGED.some((re) => claimStands(zone, re));
  return { flat, hedged, testsPass: !negated && claimStands(zone, TESTS_PASS), admitsNoCheck: ADMITS_NO_CHECK.test(s), dismisses: DISMISSES.test(s) };
}
// A sentence ends at . ! or ? before a space or the end, so the dot in a file name, a version or
// an abbreviation (lib/foo.mjs, 1.2, e.g.) doesn't split one; and at a line break, unless the next
// line carries on in lower case (a soft wrap).
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/i;
const endsSentence = (zone, i) =>
  zone[i] === '\n'
    ? !/^[ \t]*[a-z]/.test(zone.slice(i + 1, i + 40))
    : /[.!?]/.test(zone[i]) && (i + 1 >= zone.length || /\s/.test(zone[i + 1])) && !(zone[i] === '.' && ABBREV.test(zone.slice(Math.max(0, i - 5), i + 1)));
/** True when a match of re sits in a sentence that doesn't also say work is left (WORK_LEFT). */
function claimStands(zone, re) {
  for (const m of zone.matchAll(new RegExp(re.source, re.flags.replace('g', '') + 'g'))) {
    const start = m.index + m[0].length - m[0].trimStart().length;
    const end = m.index + m[0].length;
    let a = start;
    while (a > 0 && !endsSentence(zone, a - 1)) a--;
    let b = Math.max(start, end - 1);
    while (b < zone.length && !endsSentence(zone, b)) b++;
    if (!WORK_LEFT.test(zone.slice(a, b + 1))) return true;
  }
  return false;
}

// problems.claim-opens-message: the whole message is an unqualified claim, or it isn't strict.
// It fails closed: the message opens with the claim, is short, asks nothing, has no number after
// the claim, and has no word from DOUBT anywhere in it. A message that hedges, defers, admits no
// check or reports a failure, in any words, stays a rule's reading (inferred), however it opens.
const OPENS_DONE = /^(?:done|fixed|all done|all set|complete|completed|implemented)(?:[.!:,\n]|$)/i;
// Unqualified all-pass wording only: "All tests pass", "All 42 tests passed", "Tests pass". A
// count without "all" before it ("42 tests passed") can sit beside a failure count, so it isn't one.
const OPENS_TESTS_PASS = /^(?:all\s+(?:\d[\d,]*\s+)?tests?|tests)\s+(?:now\s+)?(?:pass|passed|are passing|are green)(?:[.!:,\n]|$)/i;
export const STRICT_MAX_WORDS = 40;
// Words that negate, hedge, defer, admit no check, or name a failure. A stem ends in "-" and
// matches a word's start ("fail-" covers failed, failing and failures); the rest match whole.
export const DOUBT_WORDS = Object.freeze([
  // negation and exceptions
  'not', 'no', 'never', 'none', 'nothing', 'nor', 'without', 'cannot', "can't", "won't", "isn't", "aren't", "doesn't", "didn't", "don't", "hasn't", "haven't", "wasn't", "weren't", "couldn't", "wouldn't", "shouldn't", 'but', 'except', 'unless', 'although', 'though', 'however', 'if', 'instead',
  // hedges
  'may', 'might', 'maybe', 'perhaps', 'probabl-', 'possibl-', 'likely', 'unlikely', 'hope-', 'think', 'believ-', 'guess-', 'suppos-', 'assum-', 'seem-', 'appear-', 'should', 'could', 'would', 'sure', 'unsure', 'uncertain-', 'unclear', 'roughly', 'mostly', 'partial-', 'partly', 'some', 'somewhat', 'almost', 'nearly', 'mainly',
  // deferral and work left
  'will', "i'll", "we'll", "you'll", 'next', 'then', 'later', 'todo', 'fixme', 'tbd', 'remain-', 'still', 'yet', 'pending', 'follow-', 'left', 'need-', 'must', 'wip', 'until', 'once', 'workaround-',
  // a claim limited to part of the work, or work not tried
  'only', 'just', 'happy path', 'so far', 'for now', 'out of time', 'ran out', 'unfinish-', 'incomplet-', 'untried', 'untri-', 'unrun',
  // checks not run
  'unverif-', 'verif-', 'untest-', 'uncheck-', 'check-', 'skip-',
  // failure, in any words
  'fail-', 'error-', 'broke-', 'break-', 'red', 'flak-', 'pre-exist-', 'preexist-', 'exist-', 'issue-', 'bug-', 'problem-', 'warn-', 'crash-', 'regress-', 'wrong', 'incorrect-', 'miss-', 'bad', 'timeout-', 'timed',
]);
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DOUBT = new RegExp(
  `\\b(?:${DOUBT_WORDS.filter((w) => w.endsWith('-')).map((w) => escRe(w.slice(0, -1))).join('|')})|\\b(?:${DOUBT_WORDS.filter((w) => !w.endsWith('-')).map(escRe).join('|')})(?![\\w'])`,
  'i',
);
/** 'done' or 'tests-pass' when the whole message is an unqualified claim (problems.claim-opens-message); null otherwise. */
export function strictClaim(text) {
  const s = String(text ?? '')
    .replace(/[’‘]/g, "'")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s#>*_-]+/, '').replace(/[*_`]+/g, '').trim())
    .filter(Boolean)
    .join('\n');
  const opener = s.match(OPENS_DONE) ?? s.match(OPENS_TESTS_PASS);
  if (!opener) return null;
  const rest = s.slice(opener[0].length);
  if (s.split(/\s+/).length > STRICT_MAX_WORDS || s.includes('?') || /\d/.test(rest) || DOUBT.test(s)) return null;
  return OPENS_DONE.test(s) ? 'done' : 'tests-pass';
}


/** True when one of an agent message's last two lines ends in a question mark (problems.ends-in-question). */
export function endsWithQuestion(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).some((l) => /\?["')\]*_`]*$/.test(l));
}

export const QUESTION_PROMPT_MAX = 400;
const QUESTION_START = /^(?:why|what|what's|how|where|which|who|when|is|are|does|do|did|can|could|should|would|was|were|has|have|isn't|aren't|doesn't|didn't)\b/i;
const REQUEST_WORDS = /\b(?:fix|add|implement|build|change|update|make|create|write|remove|delete|rename|refactor|run|deploy|commit|push|merge|ship|publish|install|set ?up|go ahead|do it|proceed|please|can you|could you|would you|will you|let'?s|i want|i'?d like|i need|need you|try|draft|prepare|open|send|post|apply|edit|move|replace|convert|generate|clean|start|continue|resume|redo|revert|undo|keep|use|switch|finish|complete|handle|address|investigate)\b/i;
/** Booleans for one prompt (problems.question-only-prompt). */
export function classifyPrompt(text) {
  const s = String(text ?? '').trim();
  const mentionsTests = /\btests?\b|\bspecs?\b|\bassert/i.test(s);
  if (!s || s.length > QUESTION_PROMPT_MAX || /^[<\/]/.test(s)) return { pureQuestion: false, mentionsTests };
  return { pureQuestion: QUESTION_START.test(s) && /\?\s*$/.test(s) && !REQUEST_WORDS.test(s), mentionsTests };
}

// ---- shell commands -----------------------------------------------------------------------

const CHECK_CMD = [
  ['build or check script', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck|type-check|tsc|verify|validate|ci|e2e|smoke)\b/],
  ['type check or linter', /^(?:npx\s+)?(?:tsc|eslint|biome|ruff|mypy|pyright|flake8|pylint|shellcheck)\b|^cargo\s+clippy\b|^go\s+vet\b|^(?:npx\s+)?prettier\s+--check\b|^black\s+--check\b/],
  ['build', /^(?:cargo\s+(?:build|check)|go\s+build|make|dotnet\s+build|mvn|gradle|\.\/gradlew)\b/],
  ['run of code', /^(?:node|deno|bun|tsx|ts-node|python3?|py|ruby|php|go\s+run|cargo\s+run|dotnet\s+run|java)\b|^(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*\S+\.(?:sh|ps1)\b|^\.{1,2}[\\/]\S+/],
  ['request to a server', /^(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i],
];
/** The kind of check a shell command runs, or null (problems.check-step). */
export function checkClass(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (testRunner(cmd)) return 'test';
  for (const c of simpleCommands(cmd)) for (const [name, re] of CHECK_CMD) if (re.test(c)) return name;
  return null;
}
export const BUILD_CHECKS = new Set(['build or check script', 'type check or linter', 'build']);

const READ_ONLY_CMD = /^(?:sleep|Start-Sleep|timeout(?:\.exe)?\s+\/t|git(?:\s+-[Cc]\s+\S+)*\s+(?:status|log|diff|show|branch|rev-parse|remote|ls-files|blame|describe)|gh\s+(?:pr\s+(?:checks|view|status|list|diff)|run\s+(?:view|list|watch)|api|issue\s+(?:view|list)|repo\s+view|auth\s+status)|curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Test-NetConnection|ps|Get-Process|tasklist|pgrep|netstat|Get-NetTCPConnection|Get-Job|Receive-Job|ls|dir|Get-ChildItem|gci|pwd|Get-Location|which|where|Get-Command|echo|Write-Output|Write-Host|Test-Path|wc|find|rg|grep|Select-String|tail|Get-Content|gc|cat|head|type|sed\s+-n|nl|less|more|stat|Get-Item|du|df|date|Get-Date|whoami|hostname|env|printenv|node\s+--version|npm\s+(?:ls|view|--version))\b/i;
const SHAPING_CMD = /^(?:cd|Set-Location|Select-Object|select|sort|uniq|cut|awk|jq|Out-String|Format-\w+|ft|fl|Where-Object|ConvertFrom-Json|ConvertTo-Json|Measure-Object|true|exit)\b/i;
/** True when every part of a shell line only reads state (status, listing, printing a file). */
export function readOnlyShell(cmd) {
  const parts = simpleCommands(cmd);
  return parts.length > 0 && parts.every((p) => READ_ONLY_CMD.test(p) || SHAPING_CMD.test(p));
}

// ---- shell file reads (problems.shell-read) ------------------------------------------------

/** The words of one command line with their quotes taken off, or null when anything in it
 *  isn't a plain word: a separator, a redirect, a substitution, a variable, a glob or a
 *  backslash escape outside a Windows path. `|` comes back as its own word. */
function plainWords(line) {
  const words = [];
  let cur = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, i + 1);
      if (end < 0) return null;
      const body = line.slice(i + 1, end);
      if (ch === '"' && /[$`\\]/.test(body.replace(/\\(?=[^"$`\\\n])/g, ''))) return null;
      cur = (cur ?? '') + body;
      i = end;
    } else if (/\s/.test(ch)) {
      if (cur != null) words.push(cur);
      cur = null;
    } else if (ch === '|') {
      if (cur != null) words.push(cur);
      cur = null;
      if (line[i + 1] === '|') return null;
      words.push({ pipe: true });
    } else if (/[;&<>$`(){}*?!#\n\r]/.test(ch)) return null;
    else cur = (cur ?? '') + ch;
  }
  if (cur != null) words.push(cur);
  return words;
}

const COUNT = /^\d{1,9}$/;
const lines = (from, to) => `${from}-${to}`;
/** A path word a read can name: not empty, not an option, no home or glob shorthand. */
const pathWord = (w) => typeof w === 'string' && w !== '' && w !== '-' && !w.startsWith('-') && !/^~|[*?]/.test(w);

function catRead(args) {
  const files = args.filter((a) => !(a === '-n' || a === '--number'));
  if (files.length !== 1 || !pathWord(files[0])) return null;
  return { file: files[0], range: '' };
}
function headTailRead(args, tail) {
  let n = 10;
  let file = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m;
    if (a === '-n' && COUNT.test(args[i + 1] ?? '')) n = Number(args[++i]);
    else if ((m = /^(?:-n|--lines=)(\d{1,9})$/.exec(a)) || (m = /^-(\d{1,9})$/.exec(a))) n = Number(m[1]);
    else if (file == null && pathWord(a)) file = a;
    else return null;
  }
  if (file == null || n < 1) return null;
  return { file, range: tail ? `last:${n}` : lines(1, n) };
}
function sedRead(args) {
  if (args.length !== 3 || args[0] !== '-n' || !pathWord(args[2])) return null;
  const m = /^(\d{1,9})(?:,(\d{1,9}|\$))?p$/.exec(args[1]);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] == null ? from : m[2] === '$' ? 'end' : Number(m[2]);
  if (from < 1 || (to !== 'end' && to < from)) return null;
  return { file: args[2], range: from === 1 && to === 'end' ? '' : lines(from, to) };
}
const PS_VALUE = { path: 'path', literalpath: 'path', lp: 'path', pspath: 'path', totalcount: 'first', head: 'first', first: 'first', tail: 'last', last: 'last', encoding: 'encoding' };
function getContentRead(args) {
  const seen = {};
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-raw$/i.test(a)) {
      if (seen.raw) return null;
      seen.raw = true;
      continue;
    }
    const m = /^-([A-Za-z]+)(?::(.+))?$/.exec(a);
    const key = m ? PS_VALUE[m[1].toLowerCase()] : 'path';
    if (!key) return null;
    const value = m ? m[2] ?? args[++i] : a;
    if (value == null || seen[key] != null) return null;
    if (m && /^(?:literalpath|lp|pspath)$/i.test(m[1])) literal = true;
    seen[key] = value;
  }
  const file = seen.path;
  // Without -LiteralPath, brackets in a path are wildcards.
  if (!pathWord(file) || (!literal && /[[\]]/.test(file))) return null;
  if (seen.first != null && seen.last != null) return null;
  if (seen.first != null) return COUNT.test(seen.first) && Number(seen.first) > 0 ? { file, range: lines(1, Number(seen.first)) } : null;
  if (seen.last != null) return COUNT.test(seen.last) && Number(seen.last) > 0 ? { file, range: `last:${Number(seen.last)}` } : null;
  return { file, range: '', raw: !!seen.raw };
}
/** `| Select-Object -Skip S -First F` (or -First, or -Last) after a Get-Content: a line range. */
function selectRange(read, args) {
  // With -Raw the whole file is one item, so Select-Object can't pick lines from it.
  if (read.range !== '' || read.raw || !args.length || !/^(?:Select-Object|select)$/i.test(args[0])) return null;
  const o = {};
  for (let i = 1; i < args.length; i += 2) {
    const k = /^-(skip|first|last)$/i.exec(args[i])?.[1].toLowerCase();
    if (!k || o[k] != null || !COUNT.test(args[i + 1] ?? '')) return null;
    o[k] = Number(args[i + 1]);
  }
  if (o.last != null) return o.skip == null && o.first == null && o.last > 0 ? { ...read, range: `last:${o.last}` } : null;
  if (o.first == null || o.first < 1) return null;
  const from = (o.skip ?? 0) + 1;
  return { ...read, range: lines(from, from + o.first - 1) };
}

/**
 * shellFileRead(cmd) -> { file, range, whole } | null (problems.shell-read)
 * The file a shell command line reads and prints, when the line is nothing but that read:
 * cat (with -n at most), head or tail with a line count, sed -n with one line range, or
 * PowerShell's Get-Content (or gc) with a path and a line count, optionally piped to
 * Select-Object for a range. One file only. Anything else on the line (a second file, a pipe to
 * another program, a redirect, a separator, a variable, a glob, follow mode, a byte count, an
 * in-place edit) makes it not a read. `range` is '' for the whole file, `A-B` for lines A to B,
 * and `last:N` for the last N lines, so the same lines read two ways compare equal.
 */
export function shellFileRead(cmd) {
  if (typeof cmd !== 'string' || cmd.length > 4096) return null;
  const words = plainWords(cmd.trim());
  if (!words?.length) return null;
  const bar = words.findIndex((w) => typeof w !== 'string');
  if (bar >= 0 && words.slice(bar + 1).some((w) => typeof w !== 'string')) return null;
  const first = bar >= 0 ? words.slice(0, bar) : words;
  const rest = bar >= 0 ? words.slice(bar + 1) : null;
  const [prog, ...args] = first;
  const name = cmdName(String(prog ?? ''));
  let read = null;
  if (/^(?:Get-Content|gc)$/i.test(name)) read = getContentRead(args);
  else if (rest) return null;
  else if (name === 'cat') read = catRead(args);
  else if (name === 'head' || name === 'tail') read = headTailRead(args, name === 'tail');
  else if (name === 'sed') read = sedRead(args);
  if (read && rest) read = selectRange(read, rest);
  if (!read) return null;
  const file = read.file.replace(/^(?:\.[\\/])+/, '');
  return file ? { file, range: read.range, whole: read.range === '' } : null;
}

export const TEST_EXCLUSION =/\s--ignore(?:=|\s)|\s--deselect\s|\s-k\s+["']?not\s|--testPathIgnorePatterns|--test-skip-pattern|\s--exclude(?:=|\s)|--passWithNoTests|\|\|\s*(?:true|exit\s+0|:)\s*(?:$|[;&|)])/;
export const GIT_BASE_CMD = /\bgit\b[^|;&\n]*\s(?:stash|checkout|switch|worktree)\b/;

const GIT_COMMIT_RE = /\bgit(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit\b/;
const GH_MERGE_RE = /\bgh\s+pr\s+merge\b/;
// The risky-command shapes are matched one simple command at a time, with quoted text taken out
// (executedCommands), so a commit message, a search pattern or a pull request body that names one
// isn't read as running it. A command a shell wrapper runs (bash -c "...", Codex's joined
// `bash -lc git push -f`, eval) is read as its own command line.
const GIT_START = '^(?:\\S*[\\\\/])?git(?:\\.exe)?';
const GIT_SUB = (sub) => new RegExp(GIT_START + '(?:\\s+(?:-[Cc]\\s+\\S+|--[\\w-]+(?:=\\S+)?))*\\s+(?:' + sub + ')(?=\\s|$)');
const GIT_PUSH = GIT_SUB('push');
const HOOKED = GIT_SUB('commit|push|merge|am|rebase|cherry-pick|revert');
const GIT_COMMIT_SUB = GIT_SUB('commit');
// git reads config keys case-insensitively, so core.hookspath points the hooks away too.
const HOOKS_KEY = '[cC][oO][rR][eE]\\.[hH][oO][oO][kK][sS][pP][aA][tT][hH]';
// Windows reads device names in any case too, so nul is NUL.
const NUL = '[nN][uU][lL]';
const NO_HOOKS_C = new RegExp(GIT_START + "\\s(?:.*\\s)?-c\\s+" + HOOKS_KEY + "=(?:\\/dev\\/null|" + NUL + "|''|\"\"|\\s|$)");
const NO_HOOKS_CONFIG = new RegExp("\\s" + HOOKS_KEY + "\\s+(?:\\/dev\\/null|" + NUL + "|''|\"\")(?:\\s|$)");
const GIT_CONFIG = GIT_SUB('config');
const GIT_CLEAN = GIT_SUB('clean');
const GIT_BRANCH = GIT_SUB('branch');
const HARD_RESET_RE = /\breset\s+--hard\b/;
/** A command word's name, with its folder and a .exe dropped (/usr/bin/rm, rm.exe). */
const cmdName = (word) => word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
// Words in front of the command that only change how it runs: sudo, env, nohup, time, exec,
// command, builtin or xargs with their options (and an option's value, short or long, for the
// ones that take one), a variable assignment, or a background &. Read word by word, never by a
// backtracking pattern. command -v or -V and sudo -l, -v, -V or -K only look up or list, so
// nothing behind them runs.
const LEAD_VALUED = {
  sudo: /^(?:-[ugCDhprtTUR]|--(?:user|group|close-from|chdir|host|prompt|role|type|command-timeout|other-user|chroot))$/,
  env: /^(?:-[uSC]|--(?:unset|split-string|chdir))$/,
  exec: /^-a$/,
  xargs: /^(?:-[nILPEdsa]|--(?:max-args|max-lines|max-procs|delimiter|arg-file|max-chars|process-slot-var))$/,
};
const LEAD_LOOKUP = { sudo: /^-[lvVK]$/, command: /^-[vV]$/ };
function stripLead(p) {
  const w = p.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < w.length) {
    if (w[i] === '&' || /^[A-Za-z_]\w*=/.test(w[i])) {
      i++;
      continue;
    }
    const name = cmdName(w[i]);
    if (!/^(?:sudo|env|nohup|time|exec|command|builtin|xargs)$/.test(name)) break;
    i++;
    while (i < w.length && w[i].startsWith('-') && w[i] !== '--') {
      if (LEAD_LOOKUP[name]?.test(w[i])) return '';
      i += LEAD_VALUED[name]?.test(w[i]) ? 2 : 1;
    }
    if (w[i] === '--') i++;
  }
  return w.slice(i).join(' ');
}
const WRAPPER = /^(?:\S*[\\/])?(?:(?:bash|sh|zsh|dash|ksh|pwsh|powershell)(?:\.exe)?\s+(?:-[\w-]+\s+)*?-(?:[a-z]*c|command)|eval)\s+/i;
const SLOT = /\u0001(\d+)\u0001/g;

/** Quoted text swapped for numbered slots, its bodies pushed to `bodies`, in one pass (a pattern
 *  with alternation backtracks for seconds on a long unclosed quote). Text after an unclosed quote
 *  is a shell syntax error, so it's taken out as a body too and never read as run. */
function slotQuotes(s, bodies) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const q = s[i];
    if (q !== "'" && q !== '"') {
      out += q;
      i++;
      continue;
    }
    let j = i + 1;
    let body = '';
    while (j < s.length && s[j] !== q) {
      if (q === '"' && s[j] === '\\' && j + 1 < s.length) j++;
      body += s[j++];
    }
    out += `\u0001${bodies.push(body) - 1}\u0001`;
    i = j + 1;
  }
  return out;
}

/** The simple commands a shell line runs, with heredoc bodies and quoted text taken out, the
 *  leading words stripLead sets aside dropped, and a shell wrapper's command read in its place.
 *  It splits the line itself: simpleCommands drops a leading env, time or exec but leaves their
 *  options, and stripLead needs the word to read them (env -i git push -f). */
function executedCommands(cmd, depth = 0) {
  const bodies = [];
  const s = slotQuotes(String(cmd ?? '').replace(HEREDOC_RE, '<<heredoc'), bodies).replace(/`/g, ';');
  const out = [];
  for (const raw of s.split(SIMPLE_SPLIT)) {
    const p = stripLead(raw);
    const w = WRAPPER.exec(p);
    if (w && depth < 3) {
      const rest = p.slice(w[0].length).trim();
      // The body is the first word after -c (a bare -- may come first); what follows it is the
      // body's own arguments or a redirect, never more of the command.
      const slot = /^(?:--\s+)?\u0001(\d+)\u0001(?=\s|$)/.exec(rest);
      out.push(...executedCommands(slot ? bodies[Number(slot[1])] : rest.replace(SLOT, "''"), depth + 1));
    } else if (p) out.push(p.replace(SLOT, "''"));
  }
  return out;
}
/** The arguments after a git subcommand, up to a bare `--`; null when p isn't that subcommand. */
function gitArgs(p, re) {
  const m = re.exec(p);
  if (!m) return null;
  const args = p.slice(m[0].length).trim().split(/\s+/).filter(Boolean);
  const stop = args.indexOf('--');
  return stop < 0 ? args : args.slice(0, stop);
}
/** A short-flag group's letters before the first one that takes a value (git commit -nm "x"). */
const shortFlags = (a, valued) => (/^-[a-zA-Z]+$/.test(a) ? a.slice(1).split(new RegExp(`[${valued}]`))[0] : '');
/** True when an rm command deletes recursively and by force: -r (or -R, --recursive) and -f
 *  (or --force), in any order or flag group, before a bare --. Read word by word. */
function rmRecursiveForce(p) {
  const w = p.split(/\s+/);
  if (cmdName(w[0]) !== 'rm') return false;
  let r = false;
  let f = false;
  for (const x of w.slice(1)) {
    if (x === '--') break;
    if (x === '--recursive') r = true;
    else if (x === '--force') f = true;
    else if (/^-[a-zA-Z]+$/.test(x)) {
      if (/[rR]/.test(x)) r = true;
      if (/f/.test(x)) f = true;
    }
  }
  return r && f;
}

/** A step that committed or merged (problems.commit-step), how that's known; null otherwise. */
export function commitStep(e, cmd) {
  if (e.kind !== 'action' || e.facts?.category !== 'shell') return null;
  if (e.facts.git?.pr?.action === 'merged') return { evidence: 'recorded', what: 'merged a pull request (the harness recorded the merge)' };
  if (e.facts.git?.commit?.sha) return { evidence: 'recorded', what: 'made a commit (the harness recorded it)' };
  if (e.facts.result !== 'ok') return null;
  if ((e.inferred ?? []).some((x) => x.rule === 'shell.git-commit-output')) return { evidence: 'inferred', rule: 'shell.git-commit-output', what: 'made a commit (its id read from what the command printed)' };
  const c = String(cmd ?? e.facts.command ?? '');
  if (GH_MERGE_RE.test(c)) return { evidence: 'inferred', rule: 'problems.commit-step', what: 'ran gh pr merge' };
  if (GIT_COMMIT_RE.test(c)) return { evidence: 'inferred', rule: 'problems.commit-step', what: 'ran git commit' };
  return null;
}

/** What a shell command that ran reads as (problems.risky-command): [{ kind, words, look }]. */
export function riskyKinds(cmd, revert) {
  const parts = executedCommands(cmd);
  const any = (test) => parts.some(test);
  const out = [];
  // A push: --force, -f in a short-flag group, or a +refspec force; --force-with-lease alone is
  // the guarded kind. A dry run (-n, --dry-run) pushes nothing.
  const pushes = parts.map((p) => gitArgs(p, GIT_PUSH)).filter((a) => a && !a.some((x) => x === '--dry-run' || shortFlags(x, '').includes('n')));
  const plain = pushes.some((a) => a.some((x, i) => x === '--force' || shortFlags(x, '').includes('f') || (i > 0 && /^\+[^\s+]/.test(x))));
  const lease = pushes.some((a) => a.some((x) => /^--force-with-lease(?:=|$)/.test(x)));
  if (plain || lease) out.push({ kind: plain ? 'force-push' : 'force-with-lease', words: plain ? 'a force-push' : 'a force-push with lease', look: plain, pattern: 'destructive-command' });
  const noVerify = (p) => {
    const a = gitArgs(p, HOOKED);
    if (!a) return false;
    // A word after a flag that takes a value (-m -n) is that value, not a flag.
    return a.includes('--no-verify') || (GIT_COMMIT_SUB.test(p) && a.some((x, i) => !/^(?:-[mFCct]|--message|--file|--template|--author|--date)$/.test(a[i - 1] ?? '') && shortFlags(x, 'mFCctS').includes('n')));
  };
  const noHooks = (p) => NO_HOOKS_C.test(p) || (GIT_CONFIG.test(p) && NO_HOOKS_CONFIG.test(p));
  if (any((p) => noVerify(p) || noHooks(p))) out.push({ kind: 'skip-checks', words: 'skipping git hooks', look: true, pattern: 'bypassing-safeguards' });
  const hard = any((p) => HARD_RESET_RE.test(p));
  if (revert) out.push({ kind: hard ? 'hard-reset' : 'revert', words: hard ? 'a hard reset' : 'discarding or reversing work', look: hard, pattern: 'destructive-command' });
  // git clean: -f (in a group before -e, which takes a pattern) or --force, and no dry run; the
  // word after -e or --exclude is a pattern, never a flag.
  const clean = any((p) => {
    const a = gitArgs(p, GIT_CLEAN);
    if (!a) return false;
    const flags = a.filter((x, i) => !/^(?:-e|--exclude)$/.test(a[i - 1] ?? ''));
    return flags.some((x) => x === '--force' || shortFlags(x, 'e').includes('f')) && !flags.some((x) => x === '--dry-run' || shortFlags(x, 'e').includes('n'));
  });
  const branchD = any((p) => (gitArgs(p, GIT_BRANCH) ?? []).some((x) => shortFlags(x, '').includes('D')));
  if (clean || branchD || any(rmRecursiveForce)) {
    out.push({ kind: clean ? 'git-clean' : branchD ? 'branch-delete' : 'recursive-delete', words: clean ? 'git clean' : branchD ? 'force-deleting a branch' : 'a recursive delete', look: clean, pattern: 'destructive-command' });
  }
  return out;
}

// Status-style calls (problems.status-command) and state changes (problems.state-change).
const STATUS_SHELL = [
  ['wait', /^(sleep|Start-Sleep|timeout(\.exe)?\s+\/t)\b/i],
  ['git status', /^git(\s+-[Cc]\s+\S+)*\s+status\b/],
  ['CI or pull request status', /^gh\s+(pr\s+(checks|view|status)|run\s+(view|list|watch)|api\s+\S*(check-runs|statuses|actions\/runs|\/pulls\/\d+))/],
  ['local server or address check', /^(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Test-NetConnection)\b/i],
  ['process check', /^(ps|Get-Process|tasklist|pgrep|Get-NetTCPConnection|netstat|Get-Job|Receive-Job)\b/i],
  ['log tail', /^(tail\b|Get-Content\b.*-(Tail|Wait)\b)/i],
];
const FILTER_SHELL = /^(head|tail|grep|rg|findstr|Select-String|Select-Object|select|jq|wc|sort|uniq|cut|awk|sed|echo|Write-Output|Write-Host|cd|Set-Location|Out-String|Format-\w+|ft|fl|Where-Object|where|ConvertFrom-Json|ConvertTo-Json|Measure-Object|true|exit|cat)\b/i;
const STATUS_TOOL = [
  ['background job output', /^(TaskOutput|BashOutput)$/],
  ['terminal read', /^mcp__.*__read_terminal$/],
  ['server log read', /^mcp__.*__preview_logs$/],
  ['CI or pull request status', /^mcp__.*__get_status$/],
];
const STATE_CHANGE = /\bgit\b[^|;&\n]*\s(push|commit|merge|rebase|pull|cherry-pick)\b|\bgh\s+(pr\s+(create|merge|ready|edit|close|reopen|comment)|workflow\s+run|run\s+rerun|release\s+create)\b|\bnpm\s+(publish|run\s+deploy)\b|\b(vercel|netlify|wrangler|firebase)\b[^|;&\n]*\bdeploy\b/;
const SPLIT = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;

/** The status class of a shell line and the status part a repeat is compared on (output
 *  filters and redirections dropped), or null when any part does work. */
export function statusOfShell(cmd) {
  const segs = String(cmd ?? '').split(SPLIT).map((s) => s.trim()).filter(Boolean);
  let cls = null;
  let part = null;
  for (const seg of segs) {
    const hit = STATUS_SHELL.find(([, re]) => re.test(seg));
    if (hit) {
      if (!cls || (cls === 'wait' && hit[0] !== 'wait')) {
        cls = hit[0];
        part = hit[0] === 'wait' ? 'wait' : seg.replace(/\s*\d?>&?\d?\s*\S*$/, '').replace(/\s+/g, ' ');
      }
      continue;
    }
    if (FILTER_SHELL.test(seg)) continue;
    return null;
  }
  return cls ? { cls, part } : null;
}
/** The status class of a tool call by its name, or null. */
export const statusOfTool = (name) => STATUS_TOOL.find(([, re]) => re.test(String(name ?? '')))?.[0] ?? null;
export const isStateChange = (cmd) => STATE_CHANGE.test(String(cmd ?? ''));

// ---- files and edits --------------------------------------------------------------------

export const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[A-Za-z0-9]+$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|(?:^|\/)conftest\.py$/i;
export const TEST_CONFIG_RE = /(?:^|\/)(?:jest|vitest|playwright|karma|cypress)\.config\.[A-Za-z]+$|(?:^|\/)(?:pytest\.ini|tox\.ini|conftest\.py|\.mocharc(?:\.[A-Za-z]+)?|setupTests\.[A-Za-z]+)$/i;
const DOC_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf|log)$|(?:^|\/)(?:LICENSE|NOTICE|AUTHORS|CHANGELOG)[^/]*$/i;
const CONFIG_FILE = /\.(?:json|jsonc|ya?ml|toml|ini|cfg|conf|env|properties|lock)$|(?:^|\/)\.[^/]+$/i;
/** doc, config, test or code, from a normalized path (problems.runnable-file, problems.test-file). */
export function fileKind(norm) {
  if (TEST_FILE_RE.test(norm)) return 'test';
  if (DOC_FILE.test(norm)) return 'doc';
  if (CONFIG_FILE.test(norm)) return 'config';
  return 'code';
}
export const PLAN_FILE_RE = /\/\.claude\/plans\/[^/]+\.md$/i;

/** Under a folder, outside any .claude folder (problems.in-repo-edit). */
export function underFolder(norm, cwd) {
  if (!cwd) return false;
  const base = `${normPath(cwd).toLowerCase()}/`;
  const l = norm.toLowerCase();
  return l.startsWith(base) && !/(?:^|\/)\.claude\//.test(l.slice(base.length));
}
/** A relative path joined under a folder. */
export function absoluteIn(file, cwd) {
  if (/^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(file) || !cwd) return file;
  return `${String(cwd).replace(/[\\/]+$/, '')}/${file}`;
}

const ASSERT_LINE = /\bassert(?:\.\w+)*\s*\(|^\s*assert\s+(?!from\b|\{|\*)\S|\bexpect\s*\(|\.should\.|\bt\.(?:is|not|deepEqual|notDeepEqual|equal|notEqual|ok|notOk|true|false|truthy|falsy|throws|notThrows|rejects|match|regex|snapshot|strictEqual|deepStrictEqual)\s*\(|\bself\.assert\w*\s*\(|\bassert_eq!|\bassert!\s*\(/;
const TEST_DEF_LINE = /^\s*(?:it|test|describe|suite|context)(?:\.each\([^)]*\))?\s*\(|^\s*(?:async\s+)?def\s+test_?\w*\s*\(|^\s*func\s+Test\w*\s*\(|^\s*#\[test\]|^\s*@Test\b/;
const SKIP_MARK = /\b(?:it|test|describe|suite|context)\.(?:skip|only|todo)\b|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.skip|\.skipTest\s*\(|@(?:Ignore|Disabled)\b|\{\s*(?:skip|only|todo)\s*:\s*(?:true|['"])|\bt\.(?:skip|todo)\s*\(|#\[ignore\]/;
const EXIT_LINE = /\bprocess\.exit\s*\(\s*0?\s*\)|\bsys\.exit\s*\(\s*0?\s*\)|\bos\._exit\s*\(/;
const COMMENTED_ASSERT = /^\s*(?:\/\/|#)\s*(?:assert|expect\s*\(|t\.\w+\s*\()/;
/** Counts over an edit's old and new text in a test file (problems.test-weakening). */
export function testEditCounts(oldText, newText) {
  const lines = (s) => (typeof s === 'string' && s ? s.split(/\r?\n/) : []);
  const count = (arr, re) => arr.filter((l) => re.test(l)).length;
  const asserts = (arr) => arr.filter((l) => !COMMENTED_ASSERT.test(l) && ASSERT_LINE.test(l)).length;
  const o = lines(oldText);
  const n = lines(newText);
  return {
    assertNet: asserts(o) - asserts(n),
    testsNet: count(o, TEST_DEF_LINE) - count(n, TEST_DEF_LINE),
    skipAdded: Math.max(0, count(n, SKIP_MARK) - count(o, SKIP_MARK)),
    exitAdded: Math.max(0, count(n, EXIT_LINE) - count(o, EXIT_LINE)),
    commentedAdded: Math.max(0, count(n, COMMENTED_ASSERT) - count(o, COMMENTED_ASSERT)),
  };
}

/** A Codex patch's files, each with its operation and its added and removed lines. */
export function parsePatch(text) {
  const files = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/);
    if (m) {
      cur = { op: m[1].toLowerCase(), path: m[2], add: [], del: [] };
      files.push(cur);
      continue;
    }
    if (line.startsWith('***')) {
      if (/^\*\*\* End Patch/.test(line)) cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) cur.add.push(line.slice(1));
    else if (line.startsWith('-')) cur.del.push(line.slice(1));
  }
  return files;
}

// ---- tool errors ------------------------------------------------------------------------

const EDIT_WHY = [
  ['text to replace not found', /String to replace not found|old_string not found|could not find the (?:text|string)/i],
  ['text matched more than once', /Found \d+ matches|matches of the string to replace|replace_all/i],
  ['file not read first', /has not been read yet|Read it first|must read/i],
  ['file changed since it was read', /modified since (?:it was )?read|has been modified/i],
  ['edit made no change', /No changes to make|exactly the same/i],
  ['patch did not apply', /verification failed|patch|hunk/i],
];
// "command not found" is tried first: the plain "not found" words would match it too.
const OTHER_WHY = [
  ['command not found', /command not found|is not recognized as/i],
  ['not found', /no such file|enoent|does not exist|cannot find (?:the )?(?:path|file|module)|not found/i],
  ['unknown option or bad argument', /unknown (?:option|flag|argument|command)|unrecognized (?:option|argument)|invalid (?:option|argument|value)|usage:/i],
  ['permission denied', /permission denied|eacces|access is denied|eperm|operation not permitted/i],
  ['timed out', /timed? ?out\b|timeout/i],
  ['network error', /econnrefused|econnreset|fetch failed|getaddrinfo|socket hang up|network/i],
  ['syntax error', /syntaxerror|parse error|unexpected token|invalid syntax/i],
];
/** An error's class, from fixed words (problems.error-signature). */
export function errorClass(cat, body, exit) {
  const b = String(body ?? '');
  if (cat === 'edit') for (const [w, re] of EDIT_WHY) if (re.test(b)) return w;
  for (const [w, re] of OTHER_WHY) if (re.test(b)) return w;
  if (Number.isFinite(exit) && exit !== 0) return 'non-zero exit';
  return 'other error';
}
/** The first error line with paths, quoted text and numbers taken out: a comparison key that
 *  is fingerprinted and never kept. */
export function errorLine(body) {
  const lines = String(body ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error|fail|denied|not found|invalid|unknown|cannot|can't|unable/i.test(l)) ?? lines[0] ?? '';
  return line.toLowerCase().replace(/[a-z]:[\\/][^\s'"`]*|(?:^|\s)\/[^\s'"`]+/gi, ' p ').replace(/(["'`])(?:(?!\1).)*\1/g, 'q').replace(/0x[0-9a-f]+|\d+(?:\.\d+)*/g, '#').replace(/\s+/g, ' ').slice(0, 160);
}

// ---- sub-agent briefs -------------------------------------------------------------------

/** Distinct words of a brief (problems.near-identical-brief). */
export function briefWords(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []);
}
/** Shared words over all words of two briefs. */
export function similarity(a, b) {
  if (!a?.size || !b?.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

// ---- secret shapes ------------------------------------------------------------------------

const KEY_SHAPES = REDACTION_SOURCES.api.map((x) => new RegExp(x, 'g'));
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g;
const URL_PASSWORD_RE = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@"'<>]+:([^\s/@"'<>]{6,})@/g;
const BEARER_RE = /\b(?:bearer|basic)[ \t]+([A-Za-z0-9._~+/=-]{20,})/gi;
const FIELD_RE = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{1,63})\1\s*(?::=|=|:)\s*["']?([A-Za-z0-9_+/=.~-]{16,})/g;
/** The next field inside a matched value (the value's characters allow key=), read in place; the
 *  name may follow other value characters, as in --api-key= or config/TOKEN=. */
const INNER_FIELD = /[A-Za-z0-9_+/=.~-]*?([A-Za-z_][A-Za-z0-9_.-]{1,63})=/y;
const FIELD_AT = new RegExp(FIELD_RE.source, 'y');
const MAX_LABELS = 8;
// A field's name counts when the redactor would hide its value for that name (keyIsSecret), so
// this check and the redactor never disagree about which names are sensitive.
const secretKey = (key) => keyIsSecret(key.replace(/\./g, '_'));
const PLACEHOLDER_VALUE = /^(?:\$\{.*|\$[A-Za-z_]|process\.env|env\.|<.*>|\*+|x{6,}|\[redacted)/i;
const keyShaped = (v) => KEY_SHAPES.some((re) => new RegExp(re.source).test(v));
/** A value that reads as a credential: letters and digits mixed, not a run of words. */
function randomLooking(v) {
  if (v.length < 16 || PLACEHOLDER_VALUE.test(v) || !/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
  const parts = v.split(/[-_./]+/).filter(Boolean);
  const wordy = parts.length > 1 && parts.every((p) => /^[A-Za-z][a-z]*\d{0,4}$/.test(p) || /^\d{1,4}$/.test(p));
  return !wordy;
}
function secretsInText(str, into) {
  for (const re of KEY_SHAPES) for (const _ of str.matchAll(re)) into.keyShape = (into.keyShape ?? 0) + 1;
  for (const _ of str.matchAll(PRIVATE_KEY_RE)) into.privateKey = (into.privateKey ?? 0) + 1;
  for (const m of str.matchAll(URL_PASSWORD_RE)) if (!PLACEHOLDER_VALUE.test(m[1]) && !/^(?:password|pass|secret)$/i.test(m[1])) into.urlPassword = (into.urlPassword ?? 0) + 1;
  for (const m of str.matchAll(BEARER_RE)) if (randomLooking(m[1])) into.bearer = (into.bearer ?? 0) + 1;
  // A label in front ("one: DOCS_TOKEN=...", "label=PASSWORD=...") is part of the matched value,
  // so the fields inside it are read too, up to MAX_LABELS deep, in place: never a rescan, which
  // turns quadratic on a long run of a=b.
  const fields = new RegExp(FIELD_RE.source, 'g');
  for (let m; (m = fields.exec(str)); ) {
    const end = m.index + m[0].length;
    let key = m[2];
    let at = end - m[3].length;
    let cutShort = false;
    for (let n = 0; n <= MAX_LABELS; n++) {
      if (secretKey(key)) {
        const v = str.slice(at, end);
        if (randomLooking(v) && !keyShaped(v)) {
          into.field = (into.field ?? 0) + 1;
          break;
        }
      }
      INNER_FIELD.lastIndex = at;
      const inner = INNER_FIELD.exec(str);
      if (!inner || INNER_FIELD.lastIndex >= end) {
        cutShort = true;
        break;
      }
      key = inner[1];
      at = INNER_FIELD.lastIndex;
    }
    // A long name the label took as its value ("one: GITHUB_ACCESS_TOKEN = ...") ends the value,
    // and its own quote, space, := or : sits past it. Read that name again as a field of its own,
    // from where it starts (its opening quote included). The name is at most 64 characters at the
    // value's end, so this stays one pass.
    if (cutShort) {
      let from = str[end - 1] === '=' ? end - 1 : end;
      const stop = Math.max(at, from - 64);
      while (from > stop && /[A-Za-z0-9_.-]/.test(str[from - 1])) from--;
      while (from < end && !/[A-Za-z_]/.test(str[from])) from++;
      for (const start of /["']/.test(str[from - 1]) ? [from - 1, from] : [from]) {
        if (start >= end) break;
        FIELD_AT.lastIndex = start;
        if (FIELD_AT.test(str)) {
          fields.lastIndex = start;
          break;
        }
      }
    }
  }
}
/** Counts by kind of secret-shaped values in a string or a tool input (problems.secret-shape):
 *  { keyShape, privateKey, urlPassword, bearer, field }. Counts only; nothing is kept. */
export function secretShapes(value, into = {}, key = null, depth = 0) {
  if (depth > 32) return into;
  if (typeof value === 'string') {
    if (key && secretKey(key) && randomLooking(value) && !keyShaped(value)) into.field = (into.field ?? 0) + 1;
    secretsInText(value, into);
  } else if (Array.isArray(value)) for (const v of value) secretShapes(v, into, key, depth + 1);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) secretShapes(v, into, k, depth + 1);
  return into;
}
export const SECRET_KIND_WORDS = Object.freeze({ keyShape: ['known key or token shape', 'known key or token shapes'], privateKey: ['private-key block', 'private-key blocks'], urlPassword: ['password in a web address', 'passwords in web addresses'], bearer: ['Bearer or Basic credential', 'Bearer or Basic credentials'], field: ['credential-named field with a random-looking value', 'credential-named fields with random-looking values'] });
