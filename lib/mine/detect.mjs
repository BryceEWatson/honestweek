// lib/mine/detect.mjs — the solved-environment-problem detector.
//
// THE QUESTION THIS MODULE ANSWERS
// ----------------------------------------------------------------------------
// Most of a session log is ordinary work: you write code, it breaks, you fix it.
// That is worth nothing to a stranger. A small fraction is something else — a
// TOOL you did not write failed in your environment, you diagnosed it from the
// outside, and you found the fix. That is worth something to a stranger, because
// they will hit the same failure and paste the same error into a search box.
//
// The discriminating axis is therefore NOT "was this hard" or "did tests pass".
// It is: WHOSE BUG WAS IT?
//
//   ordinary work      your code broke      -> you EDIT files under the repo
//   publishable        a tool broke         -> you PROBE the machine outside it
//
// Every feature below is a measurable expression of that one axis. The detector
// requires evidence on both sides of the arc — a foreign failure AND a resolution —
// because an unresolved failure is a bug report, not a guide.
//
// WHAT IS MEASURED VS. WHAT IS PROXIED
// ----------------------------------------------------------------------------
// Measured directly from the log (deterministic, reproducible):
//   foreign failure text, environment-probe commands, out-of-tree path touches,
//   web-search attempts, own-repo edit count, own-toolchain failure count,
//   external issue URLs, fail->pass status arc, human resolution phrases.
// Proxied (a stand-in, and named as one wherever it is reported):
//   "non-obvious" is proxied by search-attempts + probe-depth. A fix found on the
//   first search is one someone already wrote down.
//   "someone would search for this" is proxied by the presence of a verbatim,
//   quotable error string plus a named third-party product.
// NOT knowable from a session log at all, and never inferred here:
//   whether anyone actually searches for it (a demand fact, not a log fact), and
//   whether the fix is STILL TRUE today. Only re-verification can answer the
//   second, which is why the drafter forces a verification pass.
//
// Zero runtime dependencies: Node built-ins only.

import { userInfo } from 'node:os';

import { streamSession } from './corpus.mjs';

/** This machine's account name, as a literal pattern — the backstop in `deidentify`.
 *  Guarded: a username shorter than 3 characters would match far too much text, and a
 *  machine that cannot report one simply gets no backstop. */
const LOCAL_USERNAME_RE = (() => {
  let name = '';
  try {
    name = userInfo().username ?? '';
  } catch {
    name = '';
  }
  if (name.length < 3) return /(?!)/g; // never matches
  return new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
})();

// ---------------------------------------------------------------------------
// Signal vocabularies
// ---------------------------------------------------------------------------

/** Commands that INSPECT the machine rather than change the project. The strongest
 *  single indicator that the failure was not in the repo. Cross-platform on purpose:
 *  the detector is not a Windows tool. */
const ENV_PROBE_RE = [
  [/\bGet-Service\b|\bsc(?:\.exe)?\s+query\b|\bsystemctl\s+(status|list-units)\b|\blaunchctl\s+list\b/i, 'service-state'],
  [/\bGet-WinEvent\b|\bwevtutil\b|\bjournalctl\b|\blog\s+show\b/i, 'system-event-log'],
  [/\bGet-Process\b|\btasklist\b|\bps\s+-\w*ef?\b|\bpgrep\b/i, 'process-list'],
  [/\breg\s+query\b|\bGet-ItemProperty\s+["']?HK(LM|CU)|HKEY_(LOCAL_MACHINE|CURRENT_USER)/i, 'registry'],
  [/\bnetstat\b|\bGet-NetTCPConnection\b|\blsof\s+-i\b|\bss\s+-\w*l/i, 'network-state'],
  [/\bGet-WindowsOptionalFeature\b|\bdism\b|\bGet-WmiObject\b|\bGet-CimInstance\b/i, 'os-feature-state'],
  [/\bGet-AppxPackage\b|\bwinget\s+list\b|\bbrew\s+(list|info)\b|\bdpkg\s+-l\b|\brpm\s+-q/i, 'installed-package'],
  [/\bGet-ScheduledTask\b|\bschtasks\b|\bcrontab\s+-l\b/i, 'scheduled-task-state'],
];

/** Directory roots that hold ANOTHER program's installation or state. A read here is
 *  a read of someone else's software. Patterns are matched against a normalized,
 *  forward-slashed path so Windows and POSIX shapes both hit. */
const FOREIGN_ROOT_RE =
  /(?:appdata\/(?:roaming|local))|(?:program files(?:\s*\(x86\))?)|(?:programdata)|(?:\/library\/(?:application support|logs))|(?:\/etc\/)|(?:\/var\/(?:log|lib))|(?:\/usr\/(?:local\/)?(?:lib|share))|(?:localappdata)/i;

/** Error-shaped text.
 *
 *  The errno alternative is an EXPLICIT LIST, not `E[A-Z]{3,}`. The pattern-shaped
 *  version was tried first and matched every ordinary capitalised word starting with
 *  E — ENFORCEMENT, EMAIL, EXIT — which put filenames and echo banners at the top of
 *  the ranking. A closed list cannot do that.
 *
 *  Case-INSENSITIVE, which it was not at first. Without the flag, `Failed to start
 *  the workspace.` did not register as error-shaped at all, because the pattern spells
 *  `failed` in lower case and real messages capitalise their first word. That silently
 *  cost recall on the most ordinary error shape there is. */
const ERROR_LINE_RE =
  /\b(?:error|failed|failure|cannot|can't|unable to|not running|not found|denied|refused|timed? out|invalid|corrupt|missing|crash(?:ed)?|exception|fatal|0x[0-9A-Fa-f]{8}|HRESULT|errno|ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|EPIPE|EINVAL|ENOTDIR|EISDIR|ENOSPC|EMFILE|EBUSY)\b/i;

/** Failures from the tools that build and test YOUR code. A session full of these is
 *  ordinary work. Kept separate from foreign failures rather than deleted, because
 *  the ratio between them is itself a feature. */
const OWN_TOOLCHAIN_RE =
  /\b(?:error TS\d+|npm ERR!|pnpm ERR|yarn error|ESLint|eslint|Prettier|tsc|jest|vitest|mocha|pytest|AssertionError|expect\(|Test(?:s)? failed|\d+ (?:failing|passed|passed,)|SyntaxError: |Traceback \(most recent call last\)|Cannot find module|Module not found|esbuild|rollup|webpack|vite:|Transform failed|Build failed with \d+ error)\b/;

/** Version control complaining about YOUR repository. Git is third-party software,
 *  but "branch not found" is a fact about your branches, not about git — nobody
 *  searches for it. Separated from OWN_TOOLCHAIN_RE only for clarity of intent. */
// A line-leading lowercase `fatal:` / `hint:` is git's house style and almost nothing
// else's. Every one of these is a fact about YOUR branches, worktrees or index — real
// errors, zero search demand. Left unfiltered they took six of the top nine slots in a
// full-corpus run, all of them noise.
const OWN_VCS_RE =
  /^\s*(?:fatal|hint):\s|\b(?:error: (?:branch|pathspec|src refspec|failed to push)|nothing to commit|Your branch is|CONFLICT \(content\)|Automatic merge failed|index\.lock)\b/i;

/** Human turns that confirm a fix landed. Deliberately conservative — a false
 *  "solved" produces a draft about a problem that was never solved, which is the
 *  worst output this system can emit. */
const RESOLUTION_RE =
  /\b(?:that (?:worked|did it|fixed it)|it(?:'s| is) (?:working|running|fixed|back)|works now|working now|fixed(?: it)?[.!]|solved(?: it)?[.!]|we (?:fixed|solved) (?:it|that)|confirmed fixed|back up|resolved(?: it)?[.!]|nice,? that|perfect,? (?:that|it))\b/i;

/** A human turn that says the session is worth writing up. The single highest-signal
 *  phrase in the corpus, and the only one that is an explicit human label rather
 *  than an inference. */
const PUBLISH_INTENT_RE =
  /\b(?:blog post|write (?:this|it|that) up|writing (?:this|it) up|worth (?:a )?post|post about (?:this|it)|write a post|fit (?:it|this|these) into a post|turn (?:this|it) into a post|document this publicly)\b/i;

/** Noise shapes that survive the error-line test but are not a product's error text.
 *  Each was observed producing a junk "quotable error" during detector validation:
 *  a file body read back with line numbers, a markdown bullet from a report the
 *  agent wrote, and the agent's own malformed shell command. */
const NOT_AN_ERROR_LINE_RE = [
  /^\s*\d+[→\t]/, // Read-tool line-number prefix — this is file content, not output
  /^\s*(?:[-*+]\s|#{1,6}\s|\||>)/, // markdown bullet / heading / table row / quote
  /^\s*\d+[.)]\s/, // numbered list — prose the agent wrote, not program output
  /^\S*\/(?:ba|z|k)?sh: line \d+:/, // the agent's own shell syntax mistake, any shell path
  /\b(?:invalid option|unrecognized option|usage:)\b/i, // wrong flag passed by the agent
  /\bA parameter cannot be found that matches parameter name\b/i, // PowerShell: agent's own bad flag
  /[;{}()=]{4,}|\w+\.\w+=\w+,/, // minified JavaScript, not a message anyone printed
  // The agent listing a path that is not there. A fact about one machine's disk, and
  // the single most common self-inflicted "error" in the corpus.
  /^\s*(?:ls|cat|cd|rm|stat|Get-Content|Get-ChildItem)\s*:?\s*(?:cannot access|No such file|Cannot find path)/i,
  /\bInvalid argument\/option\b/i, // the agent passed a flag the program does not take
  /^Command timed out after\b/i, // the harness giving up on the agent's own command
  /^<tool_use_error>/, // the harness rejecting a call, not a product failing
  // `cp: cannot stat …`, `python3: command not found` — a shell naming the command it
  // could not carry out. Always the agent's own mistake, never a product's bug.
  /^\s*[\w.\-/\\]{1,40}:\s(?:command not found|cannot stat|cannot remove|No such file or directory|Permission denied|Operation not permitted)\b/i,
  // Prose punctuation. A program does not print an em dash, and it does not join two
  // independent clauses with a semicolon.
  //
  // A possessive was on this list too and had to come off: it rejected "Failed to
  // start Claude's workspace", which is the literal headline of the failure behind the
  // most-read post this tool exists to reproduce. Products own things, and their error
  // messages say so.
  /—|;\s+[a-z]/,
  /^Web search results for query:/i, // a search-tool result header
  /:\s*$/, // a sentence introducing the error, not the error ("It fails with:")
  // Structural shapes that are a TOOL's framing of file content, not a program's
  // output. Every one of these reached the top of a ranking during validation.
  /^\s*[+-]{1,3}[/\\ ]/, // a diff hunk line
  /^\s*\d+[-:]/, // grep context / grep match line prefix (file-42-content)
  /^\s*[=*#~_-]{3,}/, // an echo banner or rule the agent printed
  /^\s*"[\w.$-]+"\s*:/, // a JSON object key — config or state, not output
  /^\s*(?:[\w.$-]+\/)+[\w.$-]+\.\w{1,5}\s*$/, // a bare file path on its own line
  /^[A-Z][\w-]*\.(?:md|txt|json|ya?ml|ts|js|mjs|py)\s*$/i, // a bare filename
  // A compiler or bundler pointing at a source position. Whatever tool printed it,
  // the subject is YOUR code — nobody searches for a syntax error in your file.
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cpp|h):\d+(?::\d+)?\b/,
];

/** Prose ABOUT an error, rather than the error. The distinction matters more than any
 *  other in this module: the whole value of a quotable string is that a stranger can
 *  paste it verbatim into a search box and match another machine's output. An agent's
 *  summary of a failure looks error-shaped and is worthless for that. Markdown
 *  emphasis, first-person, and analysis verbs are all things a program never prints. */
const PROSE_ABOUT_ERROR_RE =
  // The leading-pronoun alternative is what finally kept documents out. `gh pr view`
  // prints a PR body, which is real output of a real command, so neither provenance
  // nor an exclusion list catches it — but a program never opens a line with "This "
  // or "It ", and an English sentence about a system very often does.
  /\*\*|^(?:It|This|That|These|Those|There|You|We|I|Our|My)\s|\b(?:I |I'?(?:ve|m|ll)|we |we'?(?:ve|ll)|here'?s|let'?s|this (?:suggests|means|indicates|confirms)|suggests|indicates that|appears to be|regarding the|summary of|in other words|note that|it seems)\b/i;

/** A missing file under a temp directory is the agent's own scratch work, not a
 *  product defect. Three of ten publishable findings were this shape before the check;
 *  a missing file under a product's CONFIG directory stays, because that is a real
 *  failure someone else will hit. */
const OWN_SCRATCH_MISS_RE = /(?:no such file|filenotfounderror|cannot find path)[^\n]*?(?:[\\/]|<drive>\/|^)(?:tmp|temp|Temp)[\\/]/i;

/** An unambiguous machine-issued code: an errno name, a Win32 or HRESULT hex value, a
 *  numeric protocol code, or an exception class name. */
const ERROR_CODE_RE =
  /\b(?:0x[0-9A-Fa-f]{6,8}|HRESULT|errno|winerror|E(?:NOENT|ACCES|PERM|EXIST|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|PIPE|INVAL|NOTDIR|ISDIR|NOSPC|MFILE|BUSY)\b|code[":\s]{1,3}-?\d{3,}|\b-3\d{4}\b|\w+(?:Error|Exception)\b)/i;

/** The shape a program uses to ANNOUNCE a failure: it leads with a failure word, or it
 *  states a failure about something. */
const ERROR_ANNOUNCEMENT_RE =
  /^(?:\[[^\]]{1,30}\]\s*)?(?:\w*Error\b|ERROR\b|Error[: ]|Failed\b|Cannot\b|Could not\b|Unable to\b|\w+Exception\b|FATAL\b|\[?BUG\]?)/;

const FAILURE_PREDICATE_RE =
  /\b(?:not running|not found|failed to|failed with|did not|cannot|can't|unable to|denied|refused|timed? out|does not exist|no such|already in use|not permitted|not supported|is not valid|invalid)\b/i;

const ISSUE_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/g;

/** Language that means an issue was RAISED here, as opposed to merely read.
 *  Reading ten issues while researching is diagnosis; filing one is an outcome, and
 *  conflating them made "resolution evidence" fire on almost every session. */
const ISSUE_FILED_RE = /\b(?:i |we |just )?(?:have )?(?:filed|opened|reported|submitted|raised)\b[^.]{0,40}\b(?:issue|bug|report|ticket)\b|\b(?:issue|bug)\b[^.]{0,20}\b(?:filed|opened|reported|submitted)\b/i;

/** Directory names that sit under an install root but name no product. Without this
 *  stoplist, product inference reported "Temp", "nvm" and "Programs" as the software
 *  a guide would be about. */
const GENERIC_SEGMENT = new Set([
  'temp',
  'tmp',
  'local',
  'locallow',
  'roaming',
  'programs',
  'common',
  'common files',
  'bin',
  'lib',
  'share',
  'cache',
  'logs',
  'log',
  'data',
  'config',
  'settings',
  'node_modules',
  'nvm',
  'npm',
  'node',
  'python',
  'packages',
  'vendor',
  'users',
  'windows',
  'system32',
  'downloads',
  'desktop',
  'documents',
]);

/**
 * Tools whose result body is PROGRAM OUTPUT — the only place a real error message can
 * come from.
 *
 * This is the structural answer to a problem no amount of pattern-matching solved. A
 * `Read` result is the contents of a file somebody wrote; a `WebFetch` result is a web
 * page; a `Grep` result is lines out of a repository. Mining those for "errors" yields
 * sentences from design documents and PR descriptions, scored and ranked as though a
 * program had printed them. Three separate prose false-positives reached the top of a
 * full-corpus ranking that way, and each new regex only moved the next one up.
 *
 * A result whose tool is unknown (an older log without an id, or a shape not seen
 * here) is ALLOWED through: dropping it would silently shrink the corpus, which is a
 * worse failure than a stray candidate a human can reject.
 */
const EXECUTION_TOOLS = new Set(['Bash', 'BashOutput', 'PowerShell', 'exec', 'shell', 'shell_command', 'run_command', 'local_shell', 'container.exec']);

/** Tools whose result is content, never output. Explicit so the "unknown is allowed"
 *  rule above cannot quietly readmit them if a name changes. */
const CONTENT_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookRead',
  'Edit',
  'Write',
  'MultiEdit',
  'TodoWrite',
  'Task',
  'Agent',
  'view',
  'read_file',
  'grep',
  'web_search',
  'web_fetch',
]);

/** Is this result body worth scanning for a third-party error message? */
export function isExecutionResult(tool) {
  if (!tool) return true; // unknown provenance: allow, and let the other filters judge
  if (CONTENT_TOOLS.has(tool)) return false;
  return EXECUTION_TOOLS.has(tool) || !/^(?:mcp__|Notebook|Todo)/.test(tool);
}

const SEARCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_fetch', 'browser_search']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch', 'edit_file', 'MultiEdit']);

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function normSlash(s) {
  return String(s).replace(/\\/g, '/');
}

/** Pull the path out of a token that may carry leading junk — a Read-tool line
 *  number, a quote, a log prefix. Without this, `136→C:/…` is stored as a path and
 *  the line number ends up in published evidence. */
function cleanPathToken(token) {
  const m = normSlash(token).match(/(?:[A-Za-z]:\/|\/)[^\s"'`|;]*$/);
  return m ? m[0] : null;
}

/** Every foreign-install path mentioned in a blob of text. */
function foreignPathsIn(text, cwdNorm) {
  const out = [];
  for (const m of normSlash(text).matchAll(/[^\s"'`|;]*[\\/][^\s"'`|;]+/g)) {
    const p = cleanPathToken(m[0]);
    if (!p) continue;
    if (!FOREIGN_ROOT_RE.test(p)) continue;
    if (cwdNorm && p.toLowerCase().includes(cwdNorm)) continue;
    // De-identify BEFORE the caller's Set sees it, so two raw spellings of the same
    // path collapse to one entry instead of appearing as two pieces of evidence.
    out.push(deidentify(p));
  }
  return out;
}

/** Strip anything that identifies THIS machine or user from a line that may be
 *  published. Home directories, drive-letter paths, and UNC shares all go. Runs
 *  before the config redactor, not instead of it. */
export function deidentify(line) {
  // Separators are normalized FIRST. Doing it last let a backslash-spelled home
  // directory slip through the home rule and reach output as `<drive>/c/Users/<name>`
  // — the exact leak this function exists to prevent. Every rule below therefore
  // sees one separator style, and none of them has to spell `[\\/]`.
  let s = normSlash(String(line));
  return (
    s
      .replace(/\/\/[^/\s]+\/[^/\s]+/g, '<share>') // UNC \\host\share, now forward-slashed
      // Any home directory, however the path is anchored: `C:/Users/<name>`,
      // `/home/<name>`, `/Users/<name>`, and the Git-Bash `/c/Users/<name>` form.
      .replace(/(?:[A-Za-z]:)?(?:\/[A-Za-z])?\/(?:Users|home|Documents and Settings)\/[^/\s"']+/gi, '<home>')
      .replace(/\b[A-Za-z]:\/[^\s"']*/g, (m) => m.replace(/^[A-Za-z]:/, '<drive>'))
      // An agent encodes a working directory into one directory name by replacing the
      // separators (`C--Users-Bryce-Projects-SomeProject`). That segment carries the
      // full path of a project that may be private, and no other rule here sees it as
      // a path at all, because it contains no separators.
      .replace(/(^|\/)[A-Za-z]-{1,2}[A-Za-z][\w.]*(?:-[\w.]+){2,}(?=\/|$)/g, '$1<project>')
      .replace(/([^:])\/{2,}/g, '$1/')
      // Last-resort backstop. A path whose separators were mangled before it reached
      // here (`c:UsersBryceProjectsfoo`) matches none of the rules above, yet still
      // carries the account name. This is machine-specific by design: everything else
      // in this module is a pattern, and a pattern cannot catch a name it does not
      // know. Publishing someone's username is worse than an ugly redaction.
      .replace(LOCAL_USERNAME_RE, '<user>')
  );
}

/**
 * Lift quotable error lines out of a tool-result body.
 *
 * A quotable line is one a stranger could paste into a search box: error-shaped,
 * self-contained, and free of anything local. Lines mentioning the session's own
 * working tree are dropped — those are the user's own failures, and they are also
 * the leak surface.
 */
export function quotableErrors(body, cwd) {
  const out = [];
  const cwdNorm = cwd ? normSlash(cwd).toLowerCase() : '';
  for (const raw of String(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 16 || line.length > 200) continue;
    if (!ERROR_LINE_RE.test(line)) continue;
    if (OWN_TOOLCHAIN_RE.test(line)) continue;
    if (OWN_VCS_RE.test(line)) continue;
    if (NOT_AN_ERROR_LINE_RE.some((re) => re.test(line))) continue;
    if (PROSE_ABOUT_ERROR_RE.test(line)) continue;
    if (OWN_SCRATCH_MISS_RE.test(line)) continue;
    // A POSITIVE gate, not another exclusion. Negative filters alone could not keep
    // documents out: `gh pr view` prints a PR body, and a PR body is genuinely the
    // output of an executed command, so no provenance rule catches it either. An
    // error line is one of two things and nothing else — a line carrying a machine
    // CODE, or a line ANNOUNCING a failure in the terse shape a program uses.
    const coded = ERROR_CODE_RE.test(line);
    const announced = (ERROR_ANNOUNCEMENT_RE.test(line) || (/^[A-Z[<"']/.test(line) && FAILURE_PREDICATE_RE.test(line))) && line.length <= 120;
    if (!coded && !announced) continue;
    if (cwdNorm && normSlash(line).toLowerCase().includes(cwdNorm)) continue;
    // A line that is mostly punctuation/hex is a stack frame or a hash dump.
    if ((line.match(/[A-Za-z]/g) || []).length < line.length * 0.45) continue;
    const clean = deidentify(line);
    if (clean.includes('<home>') && clean.length < 40) continue; // nothing left worth quoting
    out.push(clean);
  }
  return out;
}

/** The third-party product a failure is about, inferred from foreign install paths
 *  and probed service/process names. Generic: the name is READ OUT OF the evidence,
 *  never matched against a built-in list of products. */
export function inferProducts(paths, probeCommands) {
  const hits = new Map();
  const bump = (name, source) => {
    if (!name) return;
    const n = name.replace(/\.(exe|app|service)$/i, '');
    if (n.length < 3 || n.length > 40) return;
    if (GENERIC_SEGMENT.has(n.toLowerCase())) return; // a folder, not a product
    if (!/^[A-Za-z]/.test(n)) return; // "-Id" and friends: a flag caught by the regex
    if (!hits.has(n)) hits.set(n, { name: n, sources: new Set() });
    hits.get(n).sources.add(source);
  };
  for (const p of paths) {
    const norm = normSlash(p);
    // <foreign root>/<Vendor-or-Product>/...  — the segment right after the root.
    const m = norm.match(/(?:AppData\/(?:Roaming|Local)|Program Files(?:\s*\(x86\))?|ProgramData|Application Support)\/([^/]+)/i);
    if (m) bump(m[1], 'install-path');
  }
  for (const cmd of probeCommands) {
    for (const m of String(cmd).matchAll(/\b(?:Get-Service|sc(?:\.exe)?\s+query|systemctl\s+status)\s+["']?([\w.-]+)/gi)) bump(m[1], 'service');
    for (const m of String(cmd).matchAll(/\b(?:Get-Process|pgrep)\s+(?:-Name\s+)?["']?\*?([\w.-]+?)\*?["']?(?:\s|$|\|)/gi)) bump(m[1], 'process');
  }
  return [...hits.values()]
    .map((h) => ({ name: h.name, sources: [...h.sources].sort() }))
    .sort((a, b) => b.sources.length - a.sources.length || a.name.localeCompare(b.name));
}

/** Version-shaped tokens near a product mention — the "which build was this" fact a
 *  guide needs to stay honest about what it was verified against. */
export function inferVersions(texts) {
  const out = new Set();
  for (const t of texts) {
    // Strip dotted quads before looking for versions. `127.0.0.1` is shaped exactly
    // like a four-part version number, and a draft that named the loopback address as
    // "the version this was seen on" is worse than naming no version at all.
    const cleaned = String(t).replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ' ');
    for (const m of cleaned.matchAll(/\bv?(\d+\.\d+(?:\.\d+){0,3})\b/g)) {
      const v = m[1];
      if (/^\d+\.\d+$/.test(v) && Number(v.split('.')[0]) < 5) continue; // "2.0" style noise
      out.add(v);
    }
  }
  return [...out].slice(0, 8);
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * extractFeatures(events, { cwd }) -> features
 *
 * Every field is a count or a verbatim list lifted from the log. Nothing here is a
 * judgement; scoring happens in rank.mjs so the raw measurements stay auditable.
 */
export function extractFeatures(events, { cwd, ownRepos = [] } = {}) {
  const f = {
    humanTurns: 0,
    envProbes: [], // {kind, command}
    foreignPaths: new Set(),
    quotableErrors: [],
    ownToolchainFailures: 0,
    ownRepoEdits: 0,
    searchAttempts: 0,
    externalIssues: new Set(),
    ownIssues: new Set(),
    filedIssues: new Set(),
    resolutionPhrases: [],
    publishIntent: [],
    statusArc: [], // 'fail' | 'pass' in order
    assistantText: [],
  };
  const cwdNorm = cwd ? normSlash(cwd).toLowerCase() : '';
  const own = new Set(ownRepos.map((r) => String(r).toLowerCase()));
  // An issue on YOUR OWN repo is your own bug — the opposite of the signal wanted.
  // Only issues against software someone else maintains count as foreign evidence.
  const addIssue = (owner, repo, num) => {
    const slug = `${owner}/${repo}`;
    if (own.has(slug.toLowerCase())) f.ownIssues.add(`${slug}#${num}`);
    else f.externalIssues.add(`${slug}#${num}`);
  };

  for (const ev of events) {
    if (ev.kind === 'human') {
      f.humanTurns += 1;
      if (RESOLUTION_RE.test(ev.text)) f.resolutionPhrases.push(deidentify(ev.text.trim().slice(0, 200)));
      if (PUBLISH_INTENT_RE.test(ev.text)) f.publishIntent.push(deidentify(ev.text.trim().slice(0, 200)));
      const filedHere = ISSUE_FILED_RE.test(ev.text);
      for (const m of ev.text.matchAll(ISSUE_URL_RE)) {
        addIssue(m[1], m[2], m[3]);
        if (filedHere && !own.has(`${m[1]}/${m[2]}`.toLowerCase())) f.filedIssues.add(`${m[1]}/${m[2]}#${m[3]}`);
      }
      continue;
    }

    if (ev.kind === 'assistant') {
      if (f.assistantText.length < 200) f.assistantText.push(ev.text.slice(0, 600));
      for (const m of ev.text.matchAll(ISSUE_URL_RE)) addIssue(m[1], m[2], m[3]);
      continue;
    }

    if (ev.kind === 'tool_use') {
      if (SEARCH_TOOLS.has(ev.name)) f.searchAttempts += 1;
      const text = ev.text || '';
      if (EDIT_TOOLS.has(ev.name)) {
        // Only an edit INSIDE the working tree counts as own-repo work. An edit to a
        // config file under someone else's install directory is part of the fix.
        if (!cwdNorm || normSlash(text).toLowerCase().includes(cwdNorm) || !/[\\/]/.test(text)) f.ownRepoEdits += 1;
      }
      for (const [re, kind] of ENV_PROBE_RE) {
        // Collapse whitespace: a multi-line PowerShell block pasted verbatim into a
        // Markdown checklist item breaks the list. One line per command.
        if (re.test(text)) f.envProbes.push({ kind, command: deidentify(text.replace(/\s+/g, ' ').trim().slice(0, 200)) });
      }
      for (const p of foreignPathsIn(text, cwdNorm)) f.foreignPaths.add(p);
      continue;
    }

    if (ev.kind === 'result') {
      const body = ev.text || '';
      if (OWN_TOOLCHAIN_RE.test(body)) {
        f.ownToolchainFailures += 1;
        if (/\b(?:\d+ failing|Test(?:s)? failed|AssertionError|error TS\d+)\b/.test(body)) f.statusArc.push('fail');
        else if (/\b(?:\d+ passing|\d+ passed|all tests passed)\b/i.test(body)) f.statusArc.push('pass');
        continue;
      }
      if (ev.isError) f.statusArc.push('fail');
      // Only a body that a PROGRAM produced can hold a program's error message.
      if (isExecutionResult(ev.tool)) {
        for (const q of quotableErrors(body, cwd)) {
          if (f.quotableErrors.length < 40) f.quotableErrors.push(q);
        }
      }
      for (const m of body.matchAll(ISSUE_URL_RE)) addIssue(m[1], m[2], m[3]);
      for (const p of foreignPathsIn(body, cwdNorm)) f.foreignPaths.add(p);
    }
  }

  f.foreignPaths = [...f.foreignPaths].slice(0, 40);
  // The same probe re-run across a session is one diagnostic step, not several. Left
  // duplicated it appeared three times in a draft's command block and three times in
  // its verification checklist.
  const seenCmd = new Set();
  f.envProbes = f.envProbes.filter((p) => (seenCmd.has(p.command) ? false : (seenCmd.add(p.command), true)));
  f.externalIssues = [...f.externalIssues];
  f.filedIssues = [...f.filedIssues];
  f.ownIssues = [...f.ownIssues];
  return f;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Did the session reach a resolution? Three independent kinds of evidence, weakest
 *  last. `none` means the failure was never closed out — not a candidate. */
export function resolutionEvidence(f) {
  const out = [];
  if (f.resolutionPhrases.length) out.push({ kind: 'human-confirmed', detail: f.resolutionPhrases[0], strength: 'strong' });
  // Only issues the human said they FILED. Reading someone else's issue while
  // researching is diagnosis, not an outcome — counting it as one made this branch
  // fire on nearly every session in the corpus.
  if (f.filedIssues?.length) out.push({ kind: 'issue-filed', detail: f.filedIssues.join(', '), strength: 'strong' });
  const firstFail = f.statusArc.indexOf('fail');
  if (firstFail >= 0 && f.statusArc.indexOf('pass', firstFail) > firstFail) {
    out.push({ kind: 'fail-then-pass', detail: f.statusArc.join('>').slice(0, 80), strength: 'moderate' });
  }
  return out;
}

/**
 * Minimum evidence for a candidate. Both sides of the arc are required.
 *
 * "Diagnosed from outside the tree" has THREE independent forms, and requiring any
 * one of them is what makes the rule general rather than a Windows-services rule.
 * The third was added after the detector missed a known-good session: the work there
 * was a controlled experiment against a browser tool, driven by web research and
 * ending in bug reports on the vendor's tracker. Nothing was a service probe, yet
 * every part of it was diagnosis of software the user did not write.
 *
 *   1. state    — probing the machine (services, event log, registry, processes)
 *   2. artifact — touching another program's install or state directory
 *   3. research — reading up on a third party's known behavior: repeated web
 *                 searches, or issues on a repo that is not yours
 *
 * The `ordinaryWork` guard is the precision lever, and it is weighed against ALL
 * THREE. Weighing it against state-probes alone rejected that same known-good
 * session, because writing throwaway test files scored as "editing the repo".
 */
export function classify(f) {
  const probeKinds = new Set(f.envProbes.map((p) => p.kind));
  const foreignFailure = f.quotableErrors.length > 0;

  const byState = probeKinds.size >= 2;
  const byArtifact = f.foreignPaths.length >= 3;
  const byResearch = f.externalIssues.length >= 1 || f.searchAttempts >= 4;
  const outsideDiagnosis = byState || byArtifact || byResearch;
  const diagnosisKinds = [byState && 'state', byArtifact && 'artifact', byResearch && 'research'].filter(Boolean);

  const resolution = resolutionEvidence(f);

  const reasons = [];
  if (!foreignFailure) reasons.push('no quotable third-party error');
  if (!outsideDiagnosis) reasons.push('no out-of-tree diagnosis');
  if (!resolution.length) reasons.push('no resolution evidence');

  const outOfTreeWeight = f.envProbes.length + f.foreignPaths.length + f.externalIssues.length + f.searchAttempts;
  const ordinaryWork = f.ownRepoEdits > 0 && f.ownRepoEdits > outOfTreeWeight * 2;
  if (ordinaryWork) reasons.push('own-repo edits dominate out-of-tree investigation');

  return {
    isCandidate: foreignFailure && outsideDiagnosis && resolution.length > 0 && !ordinaryWork,
    rejectedFor: reasons,
    resolution,
    probeKinds: [...probeKinds].sort(),
    diagnosisKinds,
  };
}

/** Collapse near-identical error lines so one failure repeated 30 times counts once. */
function dedupeErrors(errors) {
  const seen = new Map();
  for (const e of errors) {
    const norm = e.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    if (!seen.has(norm)) seen.set(norm, e);
  }
  return [...seen.values()];
}

/**
 * detectSession(session) -> Promise<finding | null>
 *
 * Streams one session and returns a finding when it clears `classify`. The finding
 * carries its own raw features so a reader can re-derive the verdict rather than
 * trust it — the same discipline honestweek applies to its git numbers.
 */
export async function detectSession(session, { maxBytes, ownRepos = [] } = {}) {
  const { events, truncated } = await streamSession(session.kind, session.file, { maxBytes });
  const f = extractFeatures(events, { cwd: session.cwd, ownRepos });
  const verdict = classify(f);

  const errors = dedupeErrors(f.quotableErrors);
  const products = inferProducts(f.foreignPaths, f.envProbes.map((p) => p.command));
  const versions = inferVersions([...errors, ...f.foreignPaths]);

  return {
    sessionKey: session.key,
    corpus: session.kind,
    startedAt: session.startedAt,
    truncated,
    isCandidate: verdict.isCandidate,
    rejectedFor: verdict.rejectedFor,
    errorStrings: errors.slice(0, 8),
    products: products.slice(0, 5),
    versions,
    resolution: verdict.resolution,
    publishIntent: f.publishIntent,
    evidence: {
      diagnosisKinds: verdict.diagnosisKinds,
      probeKinds: verdict.probeKinds,
      probeCommands: f.envProbes.slice(0, 12).map((p) => p.command),
      foreignPaths: f.foreignPaths.slice(0, 12),
      externalIssues: f.externalIssues,
      filedIssues: f.filedIssues,
      ownIssues: [...f.ownIssues],
      searchAttempts: f.searchAttempts,
      humanTurns: f.humanTurns,
      ownRepoEdits: f.ownRepoEdits,
      ownToolchainFailures: f.ownToolchainFailures,
    },
    provenance: 'session-derived',
  };
}
