// lib/demo/week.mjs: a synthetic week of AI coding sessions for the work-history engine.
//
// buildDemoWeek({ root }) writes, into one folder, the Claude Code and Codex session
// logs of a made-up week of work on `lantern` (a small CLI that formats changelogs),
// the git repository those sessions worked in, a display-only site repository, and a
// goal record whose event ids the sessions carry. Everything is fixed: the same
// session ids, the same timestamps, and the same commit ids on every run, so only the
// folder path differs between two builds.
//
// `honestweek view --demo` serves it from a temporary folder, and the developer command
// `node tools/demo-week.mjs <out-dir>` writes it into <out-dir> (which must be empty or
// not exist yet) and prints the paths and the date range as JSON.
//
// Every name, address, and URL here is a placeholder: the author is you@example.com
// and the remote is github.com/example/lantern. Records follow the shapes the engine's
// parsers read (see test/fixtures/replay/corpus.mjs and docs/work-history-engine.md).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizeConfig } from '../config.mjs';

export const ME = 'you@example.com';
const AUTHOR = 'You';
export const WEEK = Object.freeze({ from: '2025-03-10', to: '2025-03-16', timezone: 'UTC' });
const SLUG = 'example/lantern';
const REMOTE = `https://github.com/${SLUG}.git`;
const prUrl = (n) => `https://github.com/${SLUG}/pull/${n}`;
const GOALS = 'node $GOALS_DIR/goals.mjs';

const MON = '2025-03-10';
const TUE = '2025-03-11';
const THU = '2025-03-13';
const FRI = '2025-03-14';
const SAT = '2025-03-15';

/** Claude Code session file ids (the file names) and sub-agent ids. */
export const SESSION_IDS = Object.freeze({
  sinceFlag: 'c41d7e2a-5b9f-4a63-8e1c-2f7a9d04b6e8',
  groupByScope: '7e2b9c14-3a6d-4f58-b1e0-9c4d2a8f6e73',
  groupByScopeResumed: 'f09a3d6c-2e81-4b57-9c3a-6d1e8b2f4a05',
  jsonOutput: '2d8f6a3b-9c17-4e05-a4b2-7f3e1c9d5a68',
  sitePost: '5a1c8e7f-4d26-4b93-8f0a-3e6b9d2c7f14',
  goalLookup: '9b4e2f71-6c3a-4d18-a5e9-0f7c2b8d3e46',
  scratch: 'e6d3b8a2-1f4c-4a79-9b2e-5c8f0a7d3e19',
});
const AGENT_IDS = Object.freeze({ parse: 'a1c4e9f27b3d5086', flags: 'a7f20b6d18e4c935', review: 'ab38d1f5c7e2094a', output: 'ac5e7019d2f4b683' });

/** Claude Code names a project folder after its working directory. These stand in for
 *  that encoding, relative to the demo folder, so session keys are the same every run. */
const PROJECT_DIRS = Object.freeze({
  lantern: '-lantern',
  groupWorktree: '-lantern--claude-worktrees-group-by-scope',
  jsonWorktree: '-lantern--claude-worktrees-json-output',
  site: '-personal-site',
  scratch: '-scratch',
});

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

const iso = (t) => new Date(t).toISOString();
const hex = (s) => createHash('sha256').update(s).digest('hex');
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function token(seed, n) {
  const bytes = createHash('sha256').update(seed).digest();
  let out = '';
  for (let i = 0; i < n; i++) out += B62[bytes[i % bytes.length] % 62];
  return out;
}
function uuid4(seed) {
  const h = hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** A version-7 shaped id (time first), as Codex names its threads. */
function uuid7(at, seed) {
  const ms = Date.parse(at).toString(16).padStart(12, '0');
  const h = hex(seed);
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${h.slice(0, 3)}-${'89ab'[parseInt(h[3], 16) & 3]}${h.slice(4, 7)}-${h.slice(7, 19)}`;
}
export const CODEX_IDS = Object.freeze({
  wideChars: uuid7('2025-03-10T14:05:12.000Z', 'demo-week wide chars'),
  wideFixtures: uuid7('2025-03-10T14:06:02.600Z', 'demo-week wide fixtures'),
  node18: uuid7('2025-03-14T13:31:02.000Z', 'demo-week node 18'),
});

/** The lines an edit changed, with unchanged lines at either end kept as context. */
function changedRegion(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { a, b, p, q };
}
function structuredPatch(oldString, newString, line) {
  const { a, b, p, q } = changedRegion(oldString, newString);
  const lines = [...a.slice(0, p).map((l) => ` ${l}`), ...a.slice(p, a.length - q).map((l) => `-${l}`), ...b.slice(p, b.length - q).map((l) => `+${l}`), ...a.slice(a.length - q).map((l) => ` ${l}`)];
  return [{ oldStart: line, oldLines: a.length, newStart: line, newLines: b.length, lines }];
}
/** The smallest old/new pair (one line of context each side) that turns `before` into `after`. */
function minimalEdit(before, after) {
  const { a, b, p, q } = changedRegion(before, after);
  const from = Math.max(0, p - 1);
  const tailA = Math.min(a.length, a.length - q + 1);
  const tailB = Math.min(b.length, b.length - q + 1);
  return { oldString: a.slice(from, tailA).join('\n'), newString: b.slice(from, tailB).join('\n'), line: from + 1 };
}
function codexPatch(file, before, after) {
  const { oldString, newString } = minimalEdit(before, after);
  return `*** Begin Patch\n*** Update File: ${file}\n@@\n${oldString.split('\n').map((l) => `-${l}`).join('\n')}\n${newString.split('\n').map((l) => `+${l}`).join('\n')}\n*** End Patch\n`;
}
const codexAddPatch = (file, content) => `*** Begin Patch\n*** Add File: ${file}\n${content.replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n')}\n*** End Patch\n`;

/** The tail of what `node --test` prints with its TAP reporter. */
function tap({ tests, failures = [], ms }) {
  const lines = ['TAP version 13'];
  for (const f of failures) lines.push(`not ok ${f.n} - ${f.name}`, '  ---', `  duration_ms: ${f.ms ?? 2.4}`, "  failureType: 'testCodeFailure'", `  error: '${f.error}'`, "  code: 'ERR_ASSERTION'", '  ...');
  lines.push(`1..${tests}`, `# tests ${tests}`, '# suites 0', `# pass ${tests - failures.length}`, `# fail ${failures.length}`, '# cancelled 0', '# skipped 0', '# todo 0', `# duration_ms ${ms}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// lantern's files at each stage of the week
// ---------------------------------------------------------------------------

const F = {};
const pkg = (version) => `{
  "name": "lantern",
  "version": "${version}",
  "description": "Format a CHANGELOG.md into release notes.",
  "type": "module",
  "bin": { "lantern": "bin/lantern.mjs" },
  "scripts": { "test": "node --test" },
  "engines": { "node": ">=18" },
  "license": "MIT"
}
`;
F.gitignore = 'node_modules/\n.claude/\n';
const RELEASE_1_3 = `## [1.3.0] - 2025-02-24
- feat(cli): add --width to set the wrap column
- fix(parse): keep entries that contain brackets

`;
const changelog = (released) => `# Changelog

${released ? RELEASE_1_3 : ''}## [1.2.0] - 2025-01-27
- feat(format): wrap long entries
- docs: describe the release-notes format

## [1.1.0] - 2025-01-13
- feat(parse): read scopes from conventional-commit prefixes
`;
F.parse = `// Parse a Keep a Changelog file into releases: [{ version, date, entries }].
const HEADING = /^## \\[([^\\]]+)\\](?: - (\\d{4}-\\d{2}-\\d{2}))?/;
const ENTRY = /^- (?:(\\w+)(?:\\(([^)]*)\\))?: )?(.+)$/;

export function parse(text) {
  const releases = [];
  for (const line of text.split('\\n')) {
    const heading = line.match(HEADING);
    if (heading) {
      releases.push({ version: heading[1], date: heading[2] ?? null, entries: [] });
      continue;
    }
    const entry = line.match(ENTRY);
    if (entry && releases.length) releases[releases.length - 1].entries.push({ type: entry[1] ?? null, scope: entry[2] ?? null, text: entry[3] });
  }
  return releases;
}
`;
const WRAP_LOOP = (measure) => `export function wrap(text, width = 80, indent = '  ') {
  const lines = [];
  let line = '';
  for (const word of text.split(/\\s+/).filter(Boolean)) {
    if (line && ${measure} > width) {
      lines.push(line);
      line = indent + word;
    } else {
      line = line ? \`\${line} \${word}\` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\\n');
}
`;
const IS_WIDE = `function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff);
}
`;
F.wrap = `// Wrap text at \`width\` columns, indenting continuation lines.
${WRAP_LOOP('line.length + 1 + word.length')}`;
F.wrapWideFirst = `// Columns a string takes in a terminal: wide East Asian characters and emoji take two.
export function displayWidth(s) {
  let width = 0;
  for (const ch of s) width += isWide(ch.codePointAt(0)) ? 2 : 1;
  return width;
}

${IS_WIDE}
// Wrap text at \`width\` columns, indenting continuation lines.
${WRAP_LOOP('displayWidth(line) + 1 + displayWidth(word)')}`;
F.wrapWide = `// Columns a string takes in a terminal: wide East Asian characters and emoji take
// two, and combining marks take none.
export function displayWidth(s) {
  let width = 0;
  for (const ch of s) {
    if (/\\p{Mn}/u.test(ch)) continue;
    width += isWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

${IS_WIDE}
// Wrap text at \`width\` columns, indenting continuation lines.
${WRAP_LOOP('displayWidth(line) + 1 + displayWidth(word)')}`;
F.format = `import { wrap } from './wrap.mjs';

// Release notes as text: each release's heading, then its entries.
export function format(releases, { width = 80 } = {}) {
  const out = [];
  for (const r of releases) {
    out.push(\`\${r.version}\${r.date ? \` (\${r.date})\` : ''}\`);
    for (const e of r.entries) out.push(wrap(\`- \${e.text}\`, width));
    out.push('');
  }
  return \`\${out.join('\\n').trimEnd()}\\n\`;
}
`;
F.formatGrouped = `import { groupByScope } from './group.mjs';
import { wrap } from './wrap.mjs';

// Release notes as text: each release's heading, then its entries. With groupByScope,
// the entries are listed under their scope.
export function format(releases, { width = 80, groupByScope: grouped = false } = {}) {
  const out = [];
  for (const r of releases) {
    out.push(\`\${r.version}\${r.date ? \` (\${r.date})\` : ''}\`);
    if (grouped) {
      for (const g of groupByScope(r.entries)) {
        out.push(\`  \${g.scope}:\`);
        for (const e of g.entries) out.push(indent(wrap(\`- \${e.text}\`, width - 2), '  '));
      }
    } else {
      for (const e of r.entries) out.push(wrap(\`- \${e.text}\`, width));
    }
    out.push('');
  }
  return \`\${out.join('\\n').trimEnd()}\\n\`;
}

const indent = (text, pad) => text.split('\\n').map((l) => pad + l).join('\\n');
`;
F.filterFirst = `// Keep the releases dated on or after \`since\` (YYYY-MM-DD).
export function filterSince(releases, since) {
  return releases.filter((r) => r.date !== null && r.date > since);
}
`;
F.filterDate = F.filterFirst.replace('r.date > since', 'r.date >= since');
F.filterTag = `const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;

// Keep the releases on or after \`since\`: a date (YYYY-MM-DD) or a version tag (v1.2.0).
export function filterSince(releases, since) {
  if (DATE.test(since)) return releases.filter((r) => r.date !== null && r.date >= since);
  const at = releases.findIndex((r) => r.version === since.replace(/^v/, ''));
  if (at === -1) throw new Error(\`lantern: no release named \${since}\`);
  return releases.slice(0, at + 1);
}
`;
F.groupFirst = `// Group entries by scope, in the order each scope first appears.
export function groupByScope(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const scope = entry.scope ?? 'other';
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(entry);
  }
  return [...groups].map(([scope, items]) => ({ scope, entries: items }));
}
`;
F.group = `// Group entries by scope, in the order each scope first appears. Scopes are compared
// without case, and an entry with no scope (or an empty one) goes under "other".
export function groupByScope(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const scope = entry.scope ? entry.scope.toLowerCase() : 'other';
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(entry);
  }
  return [...groups].map(([scope, items]) => ({ scope, entries: items }));
}
`;
const JSON_BODY = (grouping, wrapped) => `export function toJson(releases) {
  const out = releases.map((r) => ({ version: r.version, date: r.date, scopes: ${grouping} }));
  return \`\${JSON.stringify(${wrapped ? '{ releases: out }' : 'out'}, null, 2)}\\n\`;
}
`;
const GROUP_BY = "Object.groupBy(r.entries, (e) => (e.scope ? e.scope.toLowerCase() : 'other'))";
F.jsonFirst = `// Releases as JSON for scripts, with each release's entries grouped by scope.
${JSON_BODY(GROUP_BY, false)}`;
F.jsonKeyed = `// Releases as JSON for scripts: { releases: [{ version, date, scopes }] }.
${JSON_BODY(GROUP_BY, true)}`;
F.json = `import { groupByScope } from './group.mjs';

// Releases as JSON for scripts: { releases: [{ version, date, scopes }] }. Uses
// groupByScope rather than Object.groupBy, which Node 18 and 20 don't have.
${JSON_BODY('Object.fromEntries(groupByScope(r.entries).map((g) => [g.scope, g.entries]))', true)}`;

function bin({ since = false, group = false, json = false } = {}) {
  const imports = ["import { readFileSync } from 'node:fs';", since && "import { filterSince } from '../src/filter.mjs';", "import { format } from '../src/format.mjs';", json && "import { toJson } from '../src/json.mjs';", "import { parse } from '../src/parse.mjs';"].filter(Boolean);
  const opts = ["file: 'CHANGELOG.md'", 'width: 80', since && 'since: null', group && 'groupByScope: false', json && "format: 'text'"].filter(Boolean);
  const flags = ["  if (args[i] === '--width') opts.width = Number(args[++i]);", since && "  else if (args[i] === '--since') opts.since = args[++i];", group && "  else if (args[i] === '--group-by-scope') opts.groupByScope = true;", json && "  else if (args[i] === '--format') opts.format = args[++i];", '  else opts.file = args[i];'].filter(Boolean);
  const out = json ? "opts.format === 'json' ? toJson(releases) : format(releases, opts)" : 'format(releases, opts)';
  return `#!/usr/bin/env node
${imports.join('\n')}

const args = process.argv.slice(2);
const opts = { ${opts.join(', ')} };
for (let i = 0; i < args.length; i++) {
${flags.join('\n')}
}
${since ? 'let' : 'const'} releases = parse(readFileSync(opts.file, 'utf8'));
${since ? 'if (opts.since) releases = filterSince(releases, opts.since);\n' : ''}process.stdout.write(${out});
`;
}

function readme({ since = false, group = false } = {}) {
  const options = ['- `--width <n>`: wrap entries at n columns (default 80).'];
  if (since) options.push('- `--since <date|tag>`: only print releases on or after a date (YYYY-MM-DD) or a version tag such as v1.2.0.');
  if (group) options.push("- `--group-by-scope`: list each release's entries under their scope.");
  const grouped = group
    ? `
\`\`\`text
$ lantern --since v1.3.0 --group-by-scope
1.3.0 (2025-02-24)
  cli:
  - add --width to set the wrap column
  parse:
  - keep entries that contain brackets
\`\`\`
`
    : '';
  return `# lantern

lantern turns a CHANGELOG.md into release notes you can paste into a release page.

\`\`\`sh
npx lantern CHANGELOG.md
\`\`\`

## Options

${options.join('\n')}

## Example

\`\`\`text
$ lantern CHANGELOG.md
1.3.0 (2025-02-24)
- add --width to set the wrap column
- keep entries that contain brackets
\`\`\`
${grouped}`;
}

const TEST_HEAD = (imports) => `import { test } from 'node:test';
import assert from 'node:assert/strict';
${imports}
`;
F.testParse = `${TEST_HEAD("import { parse } from '../src/parse.mjs';")}
test('reads versions, dates and scoped entries', () => {
  const [r] = parse('## [1.0.0] - 2025-01-06\\n- feat(cli): add a flag\\n- plain entry\\n');
  assert.equal(r.version, '1.0.0');
  assert.equal(r.date, '2025-01-06');
  assert.deepEqual(r.entries, [{ type: 'feat', scope: 'cli', text: 'add a flag' }, { type: null, scope: null, text: 'plain entry' }]);
});
`;
F.testWrap = `${TEST_HEAD("import { wrap } from '../src/wrap.mjs';")}
test('wraps at the width and indents continuation lines', () => {
  assert.equal(wrap('- one two three four', 10), '- one two\\n  three\\n  four');
});
`;
F.testFormat = `${TEST_HEAD("import { format } from '../src/format.mjs';")}
test('prints each release with its date and entries', () => {
  const out = format([{ version: '1.0.0', date: '2025-01-06', entries: [{ type: 'feat', scope: 'cli', text: 'add a flag' }] }]);
  assert.equal(out, '1.0.0 (2025-01-06)\\n- add a flag\\n');
});
`;
const FILTER_DATA = `
const releases = [
  { version: '1.3.0', date: '2025-02-24', entries: [] },
  { version: '1.2.0', date: '2025-01-27', entries: [] },
  { version: '1.1.0', date: '2025-01-13', entries: [] },
];
`;
const T_FILTER_DATE = `
test('keeps releases on or after the date', () => {
  assert.deepEqual(filterSince(releases, '2025-01-27').map((r) => r.version), ['1.3.0', '1.2.0']);
});
`;
const T_FILTER_TAG = `
test('accepts a version tag', () => {
  assert.deepEqual(filterSince(releases, 'v1.2.0').map((r) => r.version), ['1.3.0', '1.2.0']);
});

test('names an unknown tag', () => {
  assert.throws(() => filterSince(releases, 'v9.9.9'), /no release named v9\\.9\\.9/);
});
`;
F.testFilterDate = `${TEST_HEAD("import { filterSince } from '../src/filter.mjs';")}${FILTER_DATA}${T_FILTER_DATE}`;
F.testFilterTag = `${F.testFilterDate}${T_FILTER_TAG}`;
F.wideFixture = '- 日本語 の 説明 を 追加 しました 長い 行 です\n- 한국어 항목 을 정리 했습니다 그리고 더 많은 단어\n- café crème brûlée naïve résumé\n- 🎉 release 🎉 notes 🎉 with 🎉 emoji\n';
F.testWrapWide = `${TEST_HEAD("import { readFileSync } from 'node:fs';\nimport { displayWidth, wrap } from '../src/wrap.mjs';")}
const samples = readFileSync(new URL('./fixtures/wide.txt', import.meta.url), 'utf8').split('\\n').filter(Boolean);

test('wide characters take two columns, combining marks none', () => {
  assert.equal(displayWidth('日本'), 4);
  assert.equal(displayWidth('e\\u0301'), 1);
});

test('every wrapped line fits the width', () => {
  for (const s of samples) for (const line of wrap(s, 20).split('\\n')) assert.ok(displayWidth(line) <= 20, line);
});
`;
const GROUP_TEST_HEAD = `${TEST_HEAD("import { format } from '../src/format.mjs';\nimport { groupByScope } from '../src/group.mjs';")}
const entry = (scope, text) => ({ type: 'feat', scope, text });

test('groups entries by scope', () => {
  const groups = groupByScope([entry('cli', 'a'), entry('parse', 'b'), entry('cli', 'c')]);
  assert.deepEqual(groups.map((g) => [g.scope, g.entries.length]), [['cli', 2], ['parse', 1]]);
});
`;
const T_GROUP_ORDER = `
test('keeps scopes in the order they first appear', () => {
  const groups = groupByScope([entry('parse', 'a'), entry('cli', 'b'), entry('api', 'c')]);
  assert.deepEqual(groups.map((g) => g.scope), ['parse', 'cli', 'api']);
});
`;
const T_GROUP_EDGES = `
test('compares scopes without case', () => {
  assert.deepEqual(groupByScope([entry('CLI', 'a'), entry('cli', 'b')]).map((g) => [g.scope, g.entries.length]), [['cli', 2]]);
});

test('puts a missing or empty scope under "other"', () => {
  assert.deepEqual(groupByScope([entry(null, 'a'), entry('', 'b')]).map((g) => [g.scope, g.entries.length]), [['other', 2]]);
});
`;
const T_GROUP_FORMAT = `
test('format is unchanged without the flag', () => {
  const releases = [{ version: '1.0.0', date: null, entries: [entry('parse', 'a')] }];
  assert.equal(format(releases), '1.0.0\\n- a\\n');
  assert.equal(format(releases, { groupByScope: true }), '1.0.0\\n  parse:\\n  - a\\n');
});
`;
F.testGroupFirst = `${GROUP_TEST_HEAD}${T_GROUP_FORMAT}`;
F.testGroupOrder = `${GROUP_TEST_HEAD}${T_GROUP_ORDER}${T_GROUP_FORMAT}`;
F.testGroup = `${GROUP_TEST_HEAD}${T_GROUP_ORDER}${T_GROUP_EDGES}${T_GROUP_FORMAT}`;
const JSON_TEST = (keyed) => `${TEST_HEAD("import { toJson } from '../src/json.mjs';")}
const release = { version: '1.0.0', date: '2025-01-06', entries: [{ type: 'feat', scope: 'cli', text: 'add a flag' }] };

test('prints each release with its entries grouped by scope', () => {
  const expected = [{ version: '1.0.0', date: '2025-01-06', scopes: { cli: release.entries } }];
  assert.deepEqual(JSON.parse(toJson([release])), ${keyed ? '{ releases: expected }' : 'expected'});
});
`;
F.testJsonFirst = JSON_TEST(false);
F.testJsonKeyed = JSON_TEST(true);
const T_JSON_EMPTY = (expected) => `
test('prints an empty list for an empty changelog', () => {
  assert.equal(toJson([]), '${expected}');
});
`;
F.testJsonEmptyWrong = `${F.testJsonKeyed}${T_JSON_EMPTY('{"releases":[]}\\n')}`;
F.testJson = `${F.testJsonKeyed}${T_JSON_EMPTY('{\\n  "releases": []\\n}\\n')}`;

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

const gitDate = (at) => `${at.slice(0, 10)} ${at.slice(11, 19)} +0000`;
function gitEnv(at) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_AUTHOR_NAME: AUTHOR, GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: AUTHOR, GIT_COMMITTER_EMAIL: ME, ...(at ? { GIT_AUTHOR_DATE: gitDate(at), GIT_COMMITTER_DATE: gitDate(at) } : {}) };
}
function git(cwd, args, at) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(at) }).trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'));
    if (content === null) {
      rmSync(p, { force: true });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** A repository whose every commit is authored by ME at a fixed time. */
/** Settings that would change a commit id, stop a step, or change what a command prints.
 *  Set in each repository, they win over any global or system git config. */
const LOCAL_GIT_CONFIG = [
  ['user.name', AUTHOR],
  ['user.email', ME],
  ['commit.gpgsign', 'false'], // a signature is part of the commit
  ['tag.gpgsign', 'false'],
  ['i18n.commitEncoding', 'UTF-8'], // any other encoding adds a header to the commit
  ['commit.cleanup', 'whitespace'], // what -m uses by default; verbatim keeps other bytes
  ['core.autocrlf', 'false'], // the blobs are the bytes written
  ['core.attributesFile', '.git/no-attributes'], // no global eol, text, or filter rules
  ['core.hooksPath', '.git/no-hooks'],
  ['core.longpaths', 'true'], // Git for Windows: allow paths past 260 characters
  ['merge.ff', 'true'], // merge.ff=false refuses --squash
  ['merge.verifySignatures', 'false'],
  ['log.showSignature', 'false'], // printed output is copied into the logs
  ['color.ui', 'false'],
  ['gc.auto', '0'],
];

function createRepo(dir, { remote } = {}) {
  mkdirSync(dir, { recursive: true });
  // No templates (they can carry hooks and settings), and SHA-1 object ids whatever
  // init.defaultObjectFormat says.
  execFileSync('git', ['init', '-q', '--template='], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...gitEnv(), GIT_DEFAULT_HASH: 'sha1' } });
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  for (const [k, v] of LOCAL_GIT_CONFIG) git(dir, ['config', k, v]);
  if (remote) git(dir, ['remote', 'add', 'origin', remote]);
  const describe = (sha, cwd = dir) => {
    const stat = git(cwd, ['show', '--format=', '--shortstat', sha]);
    const summary = git(cwd, ['show', '--format=', '--summary', sha]);
    return { sha, short: sha.slice(0, 7), stat: ` ${stat.trim()}`, summary: summary ? summary.split('\n').map((l) => ` ${l.trim()}`).join('\n') : '' };
  };
  return {
    dir,
    git: (args, at, cwd = dir) => git(cwd, args, at),
    commit(files, message, at, cwd = dir) {
      writeFiles(cwd, files);
      git(cwd, ['add', '-A'], at);
      git(cwd, ['commit', '-q', '-m', message], at);
      return describe(git(cwd, ['rev-parse', 'HEAD']), cwd);
    },
    /** What a squash merge on the host does, as the default branch sees it after a pull. */
    squash(branch, message, at) {
      git(dir, ['checkout', '-q', 'main']);
      git(dir, ['merge', '--squash', '-q', branch], at);
      git(dir, ['commit', '-q', '-m', message], at);
      return describe(git(dir, ['rev-parse', 'HEAD']));
    },
    worktree(path, branch, from) {
      git(dir, ['worktree', 'add', '-q', '-b', branch, path, from]);
      return path;
    },
    head: (cwd = dir) => describe(git(cwd, ['rev-parse', 'HEAD']), cwd),
    diffStat: (a, b) => ` ${git(dir, ['diff', '--shortstat', a, b]).trim()}`,
  };
}

// ---------------------------------------------------------------------------
// Log writers
// ---------------------------------------------------------------------------

/** One Claude Code transcript: a session file, or one sub-agent's file. */
class ClaudeLog {
  constructor({ id, cwd, branch, day, start, agentId = null }) {
    Object.assign(this, { id, cwd, branch, day, agentId, lines: [], parent: null, n: 0, msg: null, turnStart: null });
    this.t = Date.parse(`${day}T${start}Z`);
  }
  now() {
    return iso(this.t);
  }
  at(hms) {
    return this.atMs(Date.parse(`${this.day}T${hms}Z`));
  }
  atMs(t) {
    if (this.lines.length && t < this.t) throw new Error(`demo-week: a log's clock moved back to ${iso(t)}`);
    this.t = t;
    return this.now();
  }
  wait(ms) {
    this.t += ms;
    return this.now();
  }
  seed(k) {
    return `${this.id}|${this.agentId ?? 'main'}|${k}|${++this.n}`;
  }
  push(obj) {
    this.lines.push(JSON.stringify(obj));
  }
  rec(type, extra) {
    const uuid = uuid4(this.seed('uuid'));
    this.push({ parentUuid: this.parent, isSidechain: this.agentId != null, userType: 'external', cwd: this.cwd, sessionId: this.id, version: '2.1.0', gitBranch: this.branch, ...(this.agentId ? { agentId: this.agentId } : {}), type, uuid, timestamp: this.now(), ...extra });
    this.parent = uuid;
  }
  /** Every record of an earlier session, as a resumed session copies them. */
  copyFrom(other) {
    for (const line of other.lines) {
      const r = JSON.parse(line);
      if (!r.uuid) continue;
      this.lines.push(JSON.stringify({ ...r, sessionId: this.id }));
      this.parent = r.uuid;
    }
  }
  mode(permissionMode) {
    this.push({ type: 'permission-mode', permissionMode, sessionId: this.id });
  }
  title(aiTitle) {
    this.push({ type: 'ai-title', aiTitle, sessionId: this.id });
  }
  prompt(text, gap = 0) {
    this.wait(gap);
    this.msg = null;
    this.turnStart = this.t;
    this.rec('user', { message: { role: 'user', content: text }, origin: { kind: 'human' } });
    this.wait(500);
  }
  delegated(text) {
    this.rec('user', { message: { role: 'user', content: text } });
    this.wait(400);
  }
  interrupt(gap = 0) {
    this.wait(gap);
    this.msg = null;
    this.rec('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  }
  assistant(block, gap) {
    if (!this.msg) this.msg = `msg_01${token(this.seed('msg'), 22)}`;
    this.wait(gap);
    this.rec('assistant', { message: { id: this.msg, type: 'message', role: 'assistant', model: 'model-a', content: [block] }, requestId: `req_01${token(this.msg, 22)}` });
  }
  think(text, gap = 3100) {
    this.assistant({ type: 'thinking', thinking: text, signature: token(this.seed('sig'), 40) }, gap);
  }
  say(text, gap = 4300) {
    this.assistant({ type: 'text', text }, gap);
  }
  use(name, input, gap = 3600) {
    const id = `toolu_01${token(this.seed('tool'), 22)}`;
    this.assistant({ type: 'tool_use', id, name, input }, gap);
    return { id, at: this.now() };
  }
  result(id, content, { ms = 300, isError = false, tur, denial } = {}) {
    this.wait(ms);
    this.rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...(tur !== undefined ? { toolUseResult: tur } : {}), ...(denial ? { toolDenialKind: denial } : {}) });
    this.msg = null;
    return this.now();
  }
  turnEnd(gap = 400) {
    this.wait(gap);
    this.rec('system', { subtype: 'turn_duration', durationMs: this.t - (this.turnStart ?? this.t), isMeta: false });
  }
  stopHooks(gap = 300) {
    this.wait(gap);
    this.rec('system', { subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'node .claude/hooks/remind-tests.mjs', durationMs: 620 }], hookErrors: [], preventedContinuation: false, stopReason: '', hasOutput: false, level: 'suggestion' });
  }
  queue(operation, { content, reason, gap = 0 } = {}) {
    this.wait(gap);
    this.push({ type: 'queue-operation', operation, timestamp: this.now(), sessionId: this.id, ...(content != null ? { content } : {}), ...(reason ? { reason } : {}) });
  }
  attach(attachment, gap = 1) {
    this.wait(gap);
    this.rec('attachment', { attachment });
  }
  prLink(n, gap = 400) {
    this.wait(gap);
    this.push({ type: 'pr-link', sessionId: this.id, prNumber: n, prUrl: prUrl(n), prRepository: SLUG, timestamp: this.now() });
  }
  notify(body, gap = 0) {
    this.wait(gap);
    this.msg = null;
    this.turnStart = this.t;
    this.rec('user', { message: { role: 'user', content: body }, origin: { kind: 'task-notification' }, isMeta: true });
  }

  // ---- tools --------------------------------------------------------------
  bash(command, { description, ms = 900, gap, stdout = '', stderr = '', exit = 0, run } = {}) {
    const call = this.use('Bash', { command, ...(description ? { description } : {}) }, gap);
    const out = run ? { stdout: '', stderr: '', exit: 0, ...run({ at: call.at, end: iso(this.t + ms) }) } : { stdout, stderr, exit };
    const text = [out.stdout, out.stderr].filter(Boolean).join('\n');
    const end = this.result(call.id, out.exit === 0 ? text : `Exit code ${out.exit}\n${text}`, { ms, isError: out.exit !== 0, tur: { stdout: out.stdout, stderr: out.stderr, interrupted: false, isImage: false, ...(out.git ? { gitOperation: out.git } : {}) } });
    return { ...call, end };
  }
  refused(command, message, { description, gap } = {}) {
    const call = this.use('Bash', { command, ...(description ? { description } : {}) }, gap);
    const end = this.result(call.id, message, { ms: 180, isError: true, tur: `Error: ${message}` });
    return { ...call, end };
  }
  read(file, content, { gap = 2600, ms = 90 } = {}) {
    const filePath = join(this.cwd, ...file.split('/'));
    const call = this.use('Read', { file_path: filePath }, gap);
    const lines = content.replace(/\n$/, '').split('\n');
    this.result(call.id, lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'), { ms, tur: { type: 'text', file: { filePath, content, numLines: lines.length, startLine: 1, totalLines: lines.length } } });
    return call;
  }
  grep(pattern, { path, glob, files = [], gap = 2800, ms = 160 } = {}) {
    const call = this.use('Grep', { pattern, ...(path ? { path: join(this.cwd, ...path.split('/')) } : {}), ...(glob ? { glob } : {}), output_mode: 'files_with_matches' }, gap);
    this.result(call.id, files.length ? `Found ${files.length} file${files.length === 1 ? '' : 's'}\n${files.join('\n')}` : 'No files found', { ms, tur: { mode: 'files_with_matches', filenames: files, numFiles: files.length } });
    return call;
  }
  glob(pattern, files, { gap = 2400, ms = 70 } = {}) {
    const call = this.use('Glob', { pattern }, gap);
    this.result(call.id, files.join('\n'), { ms, tur: { filenames: files, durationMs: 12, numFiles: files.length, truncated: false } });
    return call;
  }
  write(file, content, { gap = 7800, ms = 120 } = {}) {
    const filePath = join(this.cwd, ...file.split('/'));
    const call = this.use('Write', { file_path: filePath, content }, gap);
    this.result(call.id, `File created successfully at: ${filePath}`, { ms, tur: { type: 'create', filePath, content, structuredPatch: [] } });
    return call;
  }
  edit(file, before, after, { gap = 5600, ms = 140 } = {}) {
    const filePath = join(this.cwd, ...file.split('/'));
    const { oldString, newString, line } = minimalEdit(before, after);
    const call = this.use('Edit', { file_path: filePath, old_string: oldString, new_string: newString }, gap);
    this.result(call.id, `The file ${filePath} has been updated successfully.`, { ms, tur: { filePath, oldString, newString, originalFile: before, structuredPatch: structuredPatch(oldString, newString, line), userModified: false, replaceAll: false } });
    return call;
  }
  agent({ description, type, prompt, background = false }, gap) {
    return this.use('Agent', { description, subagent_type: type, prompt, ...(background ? { run_in_background: true } : {}) }, gap);
  }
  agentDone(call, { agentId, prompt, report, toolUses }) {
    const content = [{ type: 'text', text: report }];
    return this.result(call.id, content, { ms: 0, tur: { status: 'completed', prompt, agentId, content, totalDurationMs: this.t - Date.parse(call.at), totalTokens: 9000 + toolUses * 2100, totalToolUseCount: toolUses } });
  }
}

/** One Codex rollout: a thread, or a child thread a spawn_agent call started. */
class CodexLog {
  constructor({ id, cwd, day, start }) {
    Object.assign(this, { id, cwd, day, lines: [], n: 0, turnId: null, turnStart: null });
    this.t = Date.parse(`${day}T${start}Z`);
  }
  now() {
    return iso(this.t);
  }
  at(hms) {
    return this.atMs(Date.parse(`${this.day}T${hms}Z`));
  }
  atMs(t) {
    if (this.lines.length && t < this.t) throw new Error(`demo-week: a log's clock moved back to ${iso(t)}`);
    this.t = t;
    return this.now();
  }
  wait(ms) {
    this.t += ms;
    return this.now();
  }
  seed(k) {
    return `${this.id}|${k}|${++this.n}`;
  }
  push(type, payload) {
    this.lines.push(JSON.stringify({ timestamp: this.now(), type, payload }));
  }
  meta(extra = {}) {
    this.push('session_meta', { id: this.id, timestamp: this.now(), cwd: this.cwd, originator: 'codex_vscode', cli_version: '0.1.0', source: 'vscode', ...extra });
  }
  context() {
    this.wait(10);
    this.push('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>\nApprovals: on-request. Sandbox: workspace-write.\n</permissions instructions>' }] });
    this.wait(10);
    this.push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\nRun `node --test` before you commit. Keep changes small.' }, { type: 'input_text', text: `<environment_context>\n  <cwd>${this.cwd}</cwd>\n  <approval_policy>on-request</approval_policy>\n  <sandbox_mode>workspace-write</sandbox_mode>\n  <shell>bash</shell>\n</environment_context>` }] });
  }
  turn(gap = 0) {
    this.wait(gap);
    this.turnId = uuid4(this.seed('turn'));
    this.turnStart = this.t;
    this.push('turn_context', { turn_id: this.turnId, cwd: this.cwd, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'model-b', effort: 'medium', summary: 'auto' });
    this.wait(5);
    this.push('event_msg', { type: 'task_started', turn_id: this.turnId, model_context_window: 258400 });
  }
  user(text) {
    this.wait(10);
    this.push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  }
  ide(active, request) {
    this.user(`# Context from my IDE setup:\n\n## Active file: ${active}\n\n## Open tabs:\n- ${active.split('/').pop()}: ${active}\n\n## My request for Codex:\n${request}`);
  }
  reason(gap = 4200) {
    this.wait(gap);
    this.push('response_item', { type: 'reasoning', summary: [], content: null, encrypted_content: `gAAAAB${token(this.seed('reasoning'), 40)}` });
  }
  tokens() {
    this.push('event_msg', { type: 'token_count', info: null, rate_limits: null });
  }
  fn(name, args, output, { gap = 3000, ms = 400 } = {}) {
    const call_id = `call_${token(this.seed('call'), 24)}`;
    this.wait(gap);
    const at = this.now();
    this.push('response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id });
    this.wait(ms);
    this.push('response_item', { type: 'function_call_output', call_id, output: typeof output === 'function' ? output({ at, end: this.now() }) : output });
    return { at, end: this.now() };
  }
  exec(cmd, { ms = 700, gap = 3600, out = '', exit = 0, run } = {}) {
    const call_id = `call_${token(this.seed('call'), 24)}`;
    this.wait(gap);
    const at = this.now();
    this.push('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, workdir: this.cwd }), call_id });
    this.wait(ms);
    const r = run ? { out: '', exit: 0, ...run({ at, end: this.now() }) } : { out, exit };
    const output = `Chunk ID: ${token(call_id, 6).toLowerCase()}\nWall time: ${(ms / 1000).toFixed(1)} seconds\nProcess exited with code ${r.exit}\nOriginal token count: ${Math.max(1, Math.round(r.out.length / 4))}\nOutput:\n${r.out}`;
    this.push('response_item', { type: 'function_call_output', call_id, output });
    return { at, end: this.now() };
  }
  patch(input, { gap = 6500, ms = 120 } = {}) {
    const call_id = `call_${token(this.seed('call'), 24)}`;
    this.wait(gap);
    this.push('response_item', { type: 'custom_tool_call', status: 'completed', call_id, name: 'apply_patch', input });
    this.wait(ms);
    const files = [...input.matchAll(/^\*\*\* (Update|Add) File: (.+)$/gm)].map((m) => `${m[1] === 'Add' ? 'A' : 'M'} ${m[2]}`);
    this.push('response_item', { type: 'custom_tool_call_output', call_id, output: JSON.stringify({ output: `Success. Updated the following files:\n${files.join('\n')}\n`, metadata: { exit_code: 0, duration_seconds: ms / 1000 } }) });
  }
  say(text, gap = 4000) {
    this.wait(gap);
    this.push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    this.wait(10);
    this.push('event_msg', { type: 'agent_message', message: text });
  }
  done(gap = 300) {
    this.wait(gap);
    this.push('event_msg', { type: 'task_complete', turn_id: this.turnId, last_agent_message: null, duration_ms: this.t - this.turnStart });
  }
}

function writeLines(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

/**
 * buildDemoWeek({ root }) -> { root, roots, repo, config, configFile, goalRecord, goalsFile, ids, week }
 *
 * `roots` is { claude: [dir], codex: [dir] } for buildWorkHistory, `config` is the
 * normalized honestweek config (lantern featured, the site display-only), and
 * `goalRecord` is the goal record whose event ids the sessions carry. With no `root`,
 * it writes into a new temp folder.
 *
 * If any step fails, everything it wrote is removed before the error is thrown: a half
 * week can't be resumed, and the command line refuses a folder that isn't empty. When
 * that removal fails too, the error carries `leftBehind: true`.
 */
export function buildDemoWeek({ root } = {}) {
  const created = root == null || !existsSync(root);
  const dir = root ?? mkdtempSync(join(tmpdir(), 'hw-demo-week-'));
  const before = created ? null : new Set(readdirSync(dir));
  try {
    return writeWeek(dir);
  } catch (err) {
    try {
      if (created) rmSync(dir, { recursive: true, force: true });
      else for (const name of readdirSync(dir)) if (!before.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      if (err && typeof err === 'object') err.leftBehind = true;
    }
    throw err;
  }
}

function writeWeek(root) {
  mkdirSync(root, { recursive: true });
  const projects = join(root, 'claude', 'projects');
  const codexRoot = join(root, 'codex', 'sessions');
  const lanternDir = join(root, 'lantern');
  const siteDir = join(root, 'personal-site');
  const scratchDir = join(root, 'scratch');
  mkdirSync(scratchDir, { recursive: true });
  const goalEvents = [];
  const commits = {};
  const claudeFiles = [];
  const codexFiles = [];
  const saveClaude = (dir, log) => {
    const file = join(projects, dir, `${log.id}.jsonl`);
    writeLines(file, log.lines);
    claudeFiles.push(file);
  };
  const saveAgent = (dir, log, meta) => {
    const base = join(projects, dir, log.id, 'subagents', `agent-${log.agentId}`);
    writeLines(`${base}.jsonl`, log.lines);
    writeFileSync(`${base}.meta.json`, JSON.stringify(meta));
  };
  const saveCodex = (log) => {
    const [d, time] = JSON.parse(log.lines[0]).timestamp.split('T');
    const file = join(codexRoot, ...d.split('-'), `rollout-${d}T${time.slice(0, 8).replace(/:/g, '-')}-${log.id}.jsonl`);
    writeLines(file, log.lines);
    codexFiles.push(file);
  };
  /** A goals.mjs apply call; the goal event's time falls inside the call's recorded span. */
  const applyGoal = (log, { goal, event, type, extra = '' }) => {
    const cmd = `${GOALS} apply --goal ${goal} --event ${event} --type ${type}${extra}`;
    const stdout = `applied ${event}: ${type} on ${goal}`;
    const call = log instanceof CodexLog ? log.exec(cmd, { ms: 1400, out: `${stdout}\n` }) : log.bash(cmd, { description: 'Record the goal event', ms: 1400, stdout });
    goalEvents.push({ eventId: event, goalId: goal, type, at: iso(Date.parse(call.at) + 700) });
    return call;
  };
  const committed = (branch, c, message) => `[${branch} ${c.short}] ${message}\n${c.stat}${c.summary ? `\n${c.summary}` : ''}`;

  // ---- the repositories before the week -------------------------------------
  const lantern = createRepo(lanternDir, { remote: REMOTE });
  const unwrapped = F.format.replace("import { wrap } from './wrap.mjs';\n\n", '').replace('wrap(`- ${e.text}`, width)', '`- ${e.text}`');
  lantern.commit({ 'package.json': pkg('1.1.0'), '.gitignore': F.gitignore, 'CHANGELOG.md': changelog(false), 'README.md': readme(), 'bin/lantern.mjs': bin(), 'src/parse.mjs': F.parse, 'src/format.mjs': unwrapped, 'test/parse.test.mjs': F.testParse, 'test/format.test.mjs': F.testFormat }, 'Parse a changelog and print release notes', '2025-01-13T16:12:40Z');
  lantern.commit({ 'package.json': pkg('1.2.0'), 'src/format.mjs': F.format, 'src/wrap.mjs': F.wrap, 'test/wrap.test.mjs': F.testWrap }, 'Wrap long entries at the terminal width (#9)', '2025-01-27T11:05:12Z');
  commits.before = lantern.commit({ 'package.json': pkg('1.3.0'), 'CHANGELOG.md': changelog(true) }, 'Release 1.3.0 (#11)', '2025-02-24T09:41:57Z');

  const site = createRepo(siteDir);
  site.commit({ 'package.json': '{\n  "name": "personal-site",\n  "private": true,\n  "scripts": { "build": "node build.mjs" }\n}\n', 'build.mjs': "import { readdirSync } from 'node:fs';\n\nconst posts = readdirSync('posts').filter((f) => f.endsWith('.md'));\nconsole.log(`built ${posts.length} posts into dist/`);\n", 'posts/2025-02-28-hello.md': '# Hello\n\nThis is where I write about the small tools I build.\n' }, 'Start the site', '2025-02-28T20:14:03Z');

  // ==== Monday: a --since flag (Claude Code, main checkout) =====================
  const s1 = new ClaudeLog({ id: SESSION_IDS.sinceFlag, cwd: lanternDir, branch: 'main', day: MON, start: '09:02:11' });
  s1.mode('acceptEdits');
  s1.prompt('Add a --since flag to lantern so I can print only the releases after a given date, like `lantern --since 2025-01-01 CHANGELOG.md`. Look at how parsing and the CLI flags work first.');
  s1.title('Add a --since flag to filter releases');
  s1.think('The flag touches the parser output and the argument loop; both can be read at once.');
  s1.say("I'll look at how releases are parsed and how flags reach format(), in parallel.");
  const parsePrompt = 'Find where CHANGELOG.md is parsed into releases. Report the function, the shape of a release object, and whether release dates are kept. Quote file paths and line numbers.';
  const flagsPrompt = 'Find where bin/lantern.mjs reads its command-line flags and how options reach format(). Report the pattern it uses and any tests that cover flags.';
  const a1 = s1.agent({ description: 'Find how releases are parsed', type: 'Explore', prompt: parsePrompt }, 1600);
  const a2 = s1.agent({ description: 'Find how CLI flags are read', type: 'Explore', prompt: flagsPrompt }, 450);
  const sa1 = new ClaudeLog({ id: s1.id, cwd: lanternDir, branch: 'main', day: MON, start: '09:02:16', agentId: AGENT_IDS.parse });
  sa1.atMs(Date.parse(a1.at) + 700);
  sa1.delegated(parsePrompt);
  sa1.grep('export function parse', { files: ['src/parse.mjs'], gap: 2400 });
  sa1.read('src/parse.mjs', F.parse, { gap: 1900 });
  const parseReport = 'parse() in src/parse.mjs (line 5) returns [{ version, date, entries }]. date comes from the "## [x.y.z] - YYYY-MM-DD" heading and is null when the heading has none (for example "Unreleased"). Entries keep type, scope and text.';
  sa1.say(parseReport, 6200);
  const sa2 = new ClaudeLog({ id: s1.id, cwd: lanternDir, branch: 'main', day: MON, start: '09:02:16', agentId: AGENT_IDS.flags });
  sa2.atMs(Date.parse(a2.at) + 900);
  sa2.delegated(flagsPrompt);
  sa2.read('bin/lantern.mjs', bin(), { gap: 2600 });
  sa2.grep('opts\\.', { files: ['bin/lantern.mjs', 'src/format.mjs'], gap: 2200 });
  sa2.read('test/format.test.mjs', F.testFormat, { gap: 2000 });
  const flagsReport = 'bin/lantern.mjs walks process.argv with a for loop (lines 8 to 11): --width takes the next argument, anything else is the file. The whole opts object is passed to format(). No test covers flags; test/format.test.mjs calls format() directly.';
  sa2.say(flagsReport, 7400);
  s1.atMs(sa1.t + 600);
  s1.agentDone(a1, { agentId: AGENT_IDS.parse, prompt: parsePrompt, report: parseReport, toolUses: 2 });
  s1.atMs(sa2.t + 600);
  s1.agentDone(a2, { agentId: AGENT_IDS.flags, prompt: flagsPrompt, report: flagsReport, toolUses: 3 });
  saveAgent(PROJECT_DIRS.lantern, sa1, { agentType: 'Explore', description: 'Find how releases are parsed', toolUseId: a1.id, spawnDepth: 1 });
  saveAgent(PROJECT_DIRS.lantern, sa2, { agentType: 'Explore', description: 'Find how CLI flags are read', toolUseId: a2.id, spawnDepth: 1 });
  s1.say("Releases come out of parse() with a date (or null), and bin/lantern.mjs passes one opts object to format(). I'll put the filtering in its own module and add a --since flag to the loop.");
  s1.bash('git checkout -b feature/since-flag', { description: 'Create a branch for the flag', stderr: "Switched to a new branch 'feature/since-flag'", run: () => (lantern.git(['checkout', '-q', '-b', 'feature/since-flag']), { stderr: "Switched to a new branch 'feature/since-flag'" }) });
  s1.branch = 'feature/since-flag';
  s1.write('src/filter.mjs', F.filterFirst);
  s1.write('test/filter.test.mjs', F.testFilterDate);
  s1.edit('bin/lantern.mjs', bin(), bin({ since: true }));
  s1.bash('node --test', { description: 'Run the test suite', ms: 1100, exit: 1, stdout: tap({ tests: 4, failures: [{ n: 4, name: 'keeps releases on or after the date', error: 'Expected values to be strictly deep-equal: ["1.3.0"] !== ["1.3.0", "1.2.0"]' }], ms: 412.7 }) });
  s1.queue('enqueue', { content: 'also accept a tag name like v1.2.0, not just a date', gap: 2600 });
  s1.think('The boundary release is dropped: the comparison is strict.');
  s1.say('One failure: a release dated exactly on the --since day is dropped. I compared with > where it should be >=.');
  s1.edit('src/filter.mjs', F.filterFirst, F.filterDate);
  s1.bash('node --test', { description: 'Run the test suite', ms: 1000, stdout: tap({ tests: 4, ms: 398.2 }) });
  const f1Msg = 'Add a --since flag to filter releases by date';
  s1.bash(`git add -A && git commit -m "${f1Msg}"`, { description: 'Commit the flag', run: ({ end }) => {
    commits.sinceDate = lantern.commit({ 'src/filter.mjs': F.filterDate, 'test/filter.test.mjs': F.testFilterDate, 'bin/lantern.mjs': bin({ since: true }) }, f1Msg, end);
    return { stdout: committed('feature/since-flag', commits.sinceDate, f1Msg), git: { commit: { sha: commits.sinceDate.sha, kind: 'committed' } } };
  } });
  s1.say('Added `--since <date>`: releases dated on or after it are kept, and releases with no date are dropped. Tests pass and it is committed on feature/since-flag.');
  s1.turnEnd();
  s1.queue('dequeue', { gap: 200 });
  s1.prompt('also accept a tag name like v1.2.0, not just a date', 300);
  s1.think('A tag maps to a release by version; keep everything up to and including it.');
  s1.edit('src/filter.mjs', F.filterDate, F.filterTag);
  s1.edit('test/filter.test.mjs', F.testFilterDate, F.testFilterTag);
  s1.bash('node --test', { description: 'Run the test suite', ms: 1050, stdout: tap({ tests: 6, ms: 405.9 }) });
  const f2Msg = 'Accept a version tag for --since';
  s1.bash(`git add -A && git commit -m "${f2Msg}"`, { description: 'Commit tag support', run: ({ end }) => {
    commits.sinceTag = lantern.commit({ 'src/filter.mjs': F.filterTag, 'test/filter.test.mjs': F.testFilterTag }, f2Msg, end);
    return { stdout: committed('feature/since-flag', commits.sinceTag, f2Msg), git: { commit: { sha: commits.sinceTag.sha, kind: 'committed' } } };
  } });
  s1.say('`--since` now takes a date or a version tag. With a tag it keeps that release and everything newer, and an unknown tag is an error that names it.');
  s1.turnEnd();
  s1.prompt('Add an example to the README, then push and open a PR.', 151000);
  s1.read('README.md', readme());
  s1.edit('README.md', readme(), readme({ since: true }));
  const f3Msg = 'Document --since in the README';
  s1.bash(`git add README.md && git commit -m "${f3Msg}"`, { description: 'Commit the README change', run: ({ end }) => {
    commits.sinceReadme = lantern.commit({ 'README.md': readme({ since: true }) }, f3Msg, end);
    return { stdout: committed('feature/since-flag', commits.sinceReadme, f3Msg), git: { commit: { sha: commits.sinceReadme.sha, kind: 'committed' } } };
  } });
  s1.bash('git push -u origin feature/since-flag', { description: 'Push the branch', ms: 1600, stderr: `To ${REMOTE}\n * [new branch]      feature/since-flag -> feature/since-flag\nbranch 'feature/since-flag' set up to track 'origin/feature/since-flag'.`, run: () => ({ stderr: `To ${REMOTE}\n * [new branch]      feature/since-flag -> feature/since-flag\nbranch 'feature/since-flag' set up to track 'origin/feature/since-flag'.`, git: { push: { branch: 'feature/since-flag' } } }) });
  s1.bash('gh pr create --title "Add a --since flag to filter releases by date or tag" --body "Adds --since <date|tag>. A date keeps releases on or after it; a tag keeps that release and newer ones. Tests in test/filter.test.mjs."', { description: 'Open a pull request', ms: 2300, run: () => ({ stdout: prUrl(12), stderr: `\nCreating pull request for feature/since-flag into main in ${SLUG}\n`, git: { pr: { number: 12, url: prUrl(12), action: 'created' } } }) });
  s1.prLink(12);
  s1.say(`Opened #12: ${prUrl(12)}`);
  s1.turnEnd();
  s1.at('10:24:40');
  s1.prompt('CI is green on #12. Squash-merge it, switch back to main, and log progress on the release goal.');
  s1.bash('gh pr view 12 --json state,mergeStateStatus', { description: 'Check the pull request', ms: 1100, stdout: '{"mergeStateStatus":"CLEAN","state":"OPEN"}' });
  s1.bash('gh pr merge 12 --squash', { description: 'Squash-merge #12', ms: 3400, run: ({ end }) => {
    commits.pr12 = lantern.squash('feature/since-flag', 'Add a --since flag to filter releases by date or tag (#12)', iso(Date.parse(end) - 1500));
    return { stdout: `✓ Squashed and merged pull request ${SLUG}#12 (Add a --since flag to filter releases by date or tag)` };
  } });
  s1.bash('git checkout main && git pull --ff-only', { description: 'Update main', ms: 1700, run: () => ({ stdout: `Updating ${commits.before.short}..${commits.pr12.short}\nFast-forward\n${lantern.diffStat(commits.before.sha, commits.pr12.sha)}`, stderr: "Switched to branch 'main'\nYour branch is up to date with 'origin/main'." }) });
  s1.branch = 'main';
  applyGoal(s1, { goal: 'release-1-4', event: 'gev-3k9a', type: 'progress', extra: ' --cite lantern#12' });
  s1.say(`Merged #12 as ${commits.pr12.short} on main, and recorded progress on release-1-4 (gev-3k9a).`);
  s1.stopHooks();
  s1.turnEnd(200);
  saveClaude(PROJECT_DIRS.lantern, s1);

  // ==== Monday afternoon: wide characters (Codex, main checkout) ================
  const cx1 = new CodexLog({ id: CODEX_IDS.wideChars, cwd: lanternDir, day: MON, start: '14:05:12' });
  cx1.meta({ git: { commit_hash: commits.pr12.sha, branch: 'main', repository_url: REMOTE } });
  cx1.context();
  cx1.turn(27800);
  cx1.ide('src/wrap.mjs', 'Wrapping breaks on CJK text and emoji: lines come out wider than --width. Make wrap() measure display width rather than string length. Branch off main first, and get fixtures for the tricky cases written in parallel.');
  cx1.reason();
  cx1.exec('git checkout -b feature/wide-chars', { run: () => (lantern.git(['checkout', '-q', '-b', 'feature/wide-chars']), { out: "Switched to a new branch 'feature/wide-chars'\n" }) });
  cx1.exec('rg -n "length" src/wrap.mjs src/format.mjs', { out: 'src/wrap.mjs:6:    if (line && line.length + 1 + word.length > width) {\n' });
  cx1.exec("sed -n '1,40p' src/wrap.mjs", { out: F.wrap });
  cx1.reason(1900);
  const fixturesTask = 'Write test fixtures for wrap(): test/fixtures/wide.txt with CJK, Hangul, emoji and combining-mark lines, and test/wrap-wide.test.mjs that checks displayWidth() on a few cases and that every wrapped line fits the width. Do not change src/.';
  const spawn = cx1.fn('spawn_agent', { message: fixturesTask, agent_type: 'worker' }, JSON.stringify({ task_name: '/root/wide_fixtures', nickname: 'Fixtures' }), { ms: 500 });
  const child = new CodexLog({ id: CODEX_IDS.wideFixtures, cwd: lanternDir, day: MON, start: '14:06:02' });
  child.atMs(Date.parse(spawn.end) + 100);
  child.push('session_meta', { id: child.id, timestamp: child.now(), cwd: lanternDir, originator: 'codex_vscode', cli_version: '0.1.0', source: { subagent: { thread_spawn: { parent_thread_id: cx1.id, depth: 1, agent_path: '/root/wide_fixtures', agent_nickname: 'Fixtures' } } } });
  child.turn(100);
  child.user(fixturesTask);
  child.reason(2100);
  child.patch(codexAddPatch('test/fixtures/wide.txt', F.wideFixture), { gap: 14000 });
  child.patch(codexAddPatch('test/wrap-wide.test.mjs', F.testWrapWide), { gap: 19500 });
  child.say('Added test/fixtures/wide.txt and test/wrap-wide.test.mjs. The combining-mark check will fail until displayWidth() skips combining marks.', 9000);
  child.done();
  cx1.patch(codexPatch('src/wrap.mjs', F.wrap, F.wrapWideFirst), { gap: 7400 });
  const waited = cx1.fn('wait_agent', { timeout_ms: 120000 }, JSON.stringify({ message: 'Wait completed.', timed_out: false }), { gap: 19000, ms: Math.max(500, child.t + 900 - (cx1.t + 19000)) });
  cx1.atMs(Date.parse(waited.end) + 100);
  cx1.push('response_item', { type: 'agent_message', author: '/root/wide_fixtures', recipient: '/root', content: [{ type: 'input_text', text: 'Fixtures written: test/fixtures/wide.txt and test/wrap-wide.test.mjs.' }] });
  cx1.exec('node --test', { ms: 1300, exit: 1, out: `${tap({ tests: 8, failures: [{ n: 7, name: 'wide characters take two columns, combining marks none', error: 'Expected values to be strictly equal: 2 !== 1' }], ms: 461.4 })}\n` });
  cx1.tokens();
  cx1.reason();
  cx1.patch(codexPatch('src/wrap.mjs', F.wrapWideFirst, F.wrapWide));
  cx1.exec('node --test', { ms: 1200, out: `${tap({ tests: 8, ms: 433.0 })}\n` });
  cx1.say('wrap() now measures display width: CJK and emoji count as two columns and combining marks as none. The fixtures from the worker cover all three, and the suite passes (8 tests).');
  cx1.done();
  cx1.at('14:29:51');
  cx1.turn();
  cx1.ide('test/wrap-wide.test.mjs', 'Looks good. Commit it, push, open a PR, and log progress on the wrap goal.');
  cx1.reason(2000);
  const f4Msg = 'Measure wide characters by display width when wrapping';
  cx1.exec(`git add -A && git commit -m "${f4Msg}"`, { run: ({ end }) => {
    commits.wideChars = lantern.commit({ 'src/wrap.mjs': F.wrapWide, 'test/fixtures/wide.txt': F.wideFixture, 'test/wrap-wide.test.mjs': F.testWrapWide }, f4Msg, end);
    return { out: `${committed('feature/wide-chars', commits.wideChars, f4Msg)}\n` };
  } });
  cx1.exec('git push -u origin feature/wide-chars', { ms: 1500, out: `To ${REMOTE}\n * [new branch]      feature/wide-chars -> feature/wide-chars\nbranch 'feature/wide-chars' set up to track 'origin/feature/wide-chars'.\n` });
  cx1.exec('gh pr create --fill', { ms: 2600, out: `\nCreating pull request for feature/wide-chars into main in ${SLUG}\n\n${prUrl(13)}\n` });
  applyGoal(cx1, { goal: 'wrap-every-script', event: 'gev-7m2q', type: 'progress', extra: ` --cite ${prUrl(13)}` });
  cx1.say(`Committed ${commits.wideChars.short} on feature/wide-chars, opened ${prUrl(13)}, and logged progress on wrap-every-script (gev-7m2q).`);
  cx1.done();
  saveCodex(cx1);
  saveCodex(child);

  // ==== Tuesday: group by scope (Claude Code, in a worktree) ===================
  const groupWt = lantern.worktree(join(lanternDir, '.claude', 'worktrees', 'group-by-scope'), 'feature/group-by-scope', 'main');
  const s3 = new ClaudeLog({ id: SESSION_IDS.groupByScope, cwd: groupWt, branch: 'feature/group-by-scope', day: TUE, start: '09:20:04' });
  s3.prompt('#13 is green. Squash-merge it and mark the wrap goal done. Then plan how to group entries by scope under each release heading, behind a --group-by-scope flag. Plan only, no edits yet.');
  s3.title('Group changelog entries by scope');
  s3.bash("gh pr view 13 --json state,mergeStateStatus,statusCheckRollup --jq '{state, mergeStateStatus, checks: [.statusCheckRollup[].conclusion]}'", { description: 'Check #13', ms: 1200, stdout: '{"checks":["SUCCESS","SUCCESS","SUCCESS"],"mergeStateStatus":"CLEAN","state":"OPEN"}' });
  s3.bash('gh pr merge 13 --squash', { description: 'Squash-merge #13', ms: 3600, run: ({ end }) => {
    commits.pr13 = lantern.squash('feature/wide-chars', `${f4Msg} (#13)`, iso(Date.parse(end) - 1600));
    return { stdout: `✓ Squashed and merged pull request ${SLUG}#13 (${f4Msg})` };
  } });
  applyGoal(s3, { goal: 'wrap-every-script', event: 'gev-d4h5', type: 'state-change', extra: ' --state done --cite lantern#13' });
  s3.grep('entries', { path: 'src', files: ['src/parse.mjs', 'src/format.mjs'] });
  s3.read('src/format.mjs', F.format);
  s3.read('src/parse.mjs', F.parse, { gap: 900 });
  s3.think('Grouping is a transform on entries; the renderer only needs to know when to print scope headings.');
  s3.say('Plan:\n1. Add src/group.mjs with groupByScope(entries), returning [{ scope, entries }] in first-seen order; entries without a scope go under "other".\n2. In format(), when the groupByScope option is set, print each scope as an indented heading with its entries under it.\n3. Add --group-by-scope to bin/lantern.mjs.\n4. Tests in test/group.test.mjs, including that the output is unchanged without the flag.', 5200);
  s3.turnEnd();
  s3.at('09:24:02');
  s3.prompt('Go ahead.');
  s3.write('src/group.mjs', F.groupFirst);
  s3.write('test/group.test.mjs', F.testGroupFirst);
  s3.say('Next I will rework format() so every release goes through the grouped path, which changes how each entry line is built and indented, even without the flag...', 2700);
  s3.interrupt(3600);
  s3.prompt("no, don't rework the renderer. Group first, in its own step, and only when the flag is on. format() should print exactly what it does today without the flag.", 17000);
  s3.think('Keep the existing branch of format() as is and add a separate grouped branch.');
  s3.edit('src/format.mjs', F.format, F.formatGrouped);
  s3.edit('bin/lantern.mjs', bin({ since: true }), bin({ since: true, group: true }));
  const reviewPrompt = 'Review src/group.mjs and the --group-by-scope path in src/format.mjs on this branch. Look for edge cases in how scopes are read and grouped (a missing scope, an empty one, case, ordering) and report concrete inputs that misbehave. Do not edit files.';
  const rv = s3.agent({ description: 'Review the scope grouping for edge cases', type: 'general-purpose', prompt: reviewPrompt, background: true }, 2400);
  s3.result(rv.id, `Async agent launched successfully.\nagentId: ${AGENT_IDS.review} (internal ID, do not mention it to the user)\nThe agent is working in the background. You will be notified when it completes.`, { ms: 500, tur: { isAsync: true, status: 'async_launched', agentId: AGENT_IDS.review, description: 'Review the scope grouping for edge cases', prompt: reviewPrompt } });
  const sr = new ClaudeLog({ id: s3.id, cwd: groupWt, branch: 'feature/group-by-scope', day: TUE, start: '09:26:00', agentId: AGENT_IDS.review });
  sr.atMs(s3.t + 200);
  sr.delegated(reviewPrompt);
  sr.read('src/group.mjs', F.groupFirst, { gap: 3100 });
  sr.read('src/format.mjs', F.formatGrouped, { gap: 2600 });
  sr.bash(`node -e "import('./src/group.mjs').then((m) => console.log(JSON.stringify(m.groupByScope([{ scope: 'CLI' }, { scope: 'cli' }, { scope: '' }]).map((g) => g.scope))))"`, { description: 'Try mixed-case and empty scopes', ms: 300, gap: 21000, stdout: '["CLI","cli",""]' });
  const reviewReport = 'Two edge cases. (1) Scopes that differ only in case, "CLI" and "cli", land in separate groups. (2) An empty scope, as in "feat(): x", is grouped under "" instead of "other". Ordering is first-seen and stable. Nothing else found.';
  sr.say(reviewReport, 31000);
  s3.bash('node --test', { description: 'Run the test suite', ms: 1150, gap: 2000, stdout: tap({ tests: 8, ms: 420.5 }) });
  s3.queue('enqueue', { content: 'keep scopes in the order they first appear in the changelog, not alphabetical', gap: 4800 });
  s3.think('Check whether anything sorts the groups.', 1200);
  s3.queue('remove', { content: 'keep scopes in the order they first appear in the changelog, not alphabetical', reason: 'absorbed_mid_turn', gap: 5200 });
  s3.attach({ type: 'queued_command', prompt: 'keep scopes in the order they first appear in the changelog, not alphabetical', origin: { kind: 'human' }, commandMode: 'prompt' });
  s3.say('groupByScope already keeps first-seen order: it fills a Map and never sorts. I will pin that with a test.', 2100);
  s3.edit('test/group.test.mjs', F.testGroupFirst, F.testGroupOrder);
  s3.bash('node --test', { description: 'Run the test suite', ms: 1100, stdout: tap({ tests: 9, ms: 431.8 }) });
  s3.say('Grouping works behind --group-by-scope, and format() prints exactly what it did before when the flag is off. The reviewer is still running.');
  s3.turnEnd();
  s3.notify(`<task-notification>\n<task-id>${AGENT_IDS.review}</task-id>\n<tool-use-id>${rv.id}</tool-use-id>\n<status>completed</status>\n<summary>Agent "Review the scope grouping for edge cases" completed</summary>\n<result>${reviewReport}</result>\n</task-notification>`, Math.max(1000, sr.t + 1200 - s3.t));
  saveAgent(PROJECT_DIRS.groupWorktree, sr, { agentType: 'general-purpose', description: 'Review the scope grouping for edge cases', toolUseId: rv.id, spawnDepth: 1, requestShape: 'background' });
  s3.say('The reviewer found two edge cases: scopes that differ only in case ("CLI" and "cli") form separate groups, and an empty scope ("feat(): x") is grouped under "" instead of "other". Want me to handle both?', 3000);
  s3.turnEnd();
  s3.at('10:58:30');
  s3.prompt('Handle both edge cases and run the full suite.');
  s3.edit('src/group.mjs', F.groupFirst, F.group);
  s3.edit('test/group.test.mjs', F.testGroupOrder, F.testGroup);
  const pending = s3.use('Bash', { command: 'node --test', description: 'Run the test suite' }, 1900);
  saveClaude(PROJECT_DIRS.groupWorktree, s3);

  // ==== Thursday: the same work, resumed (Claude Code, same worktree) ===========
  const s4 = new ClaudeLog({ id: SESSION_IDS.groupByScopeResumed, cwd: groupWt, branch: 'feature/group-by-scope', day: THU, start: '09:05:01' });
  s4.copyFrom(s3);
  s4.result(pending.id, "[Tool call interrupted: the session ended before this call's result was recorded]", { ms: 0, isError: true });
  s4.prompt('continue from where we stopped on Tuesday', 19000);
  s4.title('Group changelog entries by scope');
  s4.say('Picking up: the edge-case fixes to src/group.mjs and its tests are written, but the last test run never finished. Running it now.');
  s4.bash('node --test', { description: 'Run the test suite', ms: 1200, stdout: tap({ tests: 11, ms: 447.3 }) });
  const f5Msg = 'Group entries by scope under each release heading';
  s4.bash(`git add -A && git commit -m "${f5Msg}"`, { description: 'Commit the grouping', run: ({ end }) => {
    commits.group = lantern.commit({ 'src/group.mjs': F.group, 'test/group.test.mjs': F.testGroup, 'src/format.mjs': F.formatGrouped, 'bin/lantern.mjs': bin({ since: true, group: true }) }, f5Msg, end, groupWt);
    return { stdout: committed('feature/group-by-scope', commits.group, f5Msg), git: { commit: { sha: commits.group.sha, kind: 'committed' } } };
  } });
  s4.bash('git push -u origin feature/group-by-scope', { description: 'Push the branch', ms: 1500, run: () => ({ stderr: `To ${REMOTE}\n * [new branch]      feature/group-by-scope -> feature/group-by-scope\nbranch 'feature/group-by-scope' set up to track 'origin/feature/group-by-scope'.`, git: { push: { branch: 'feature/group-by-scope' } } }) });
  s4.bash(`gh pr create --title "${f5Msg}" --body "Adds --group-by-scope. Without the flag the output is byte-for-byte what it was."`, { description: 'Open a pull request', ms: 2400, run: () => ({ stdout: prUrl(14), stderr: `\nCreating pull request for feature/group-by-scope into main in ${SLUG}\n`, git: { pr: { number: 14, url: prUrl(14), action: 'created' } } }) });
  s4.prLink(14);
  s4.say(`Opened #14: ${prUrl(14)}`);
  s4.turnEnd();
  s4.at('09:48:12');
  s4.prompt("CI's docs check says the README doesn't mention --group-by-scope. Add it with an example and fold the fix into the same commit.");
  s4.read('README.md', readme({ since: true }));
  s4.edit('README.md', readme({ since: true }), readme({ since: true, group: true }));
  s4.refused('git add README.md && git commit --amend --no-edit && git push --force-with-lease', "PreToolUse:Bash hook error: [no-force-push]: Refused: this rewrites a commit that's already pushed. Add a new commit instead.", { description: 'Amend and force-push' });
  s4.say("A hook blocks rewriting a pushed commit, so I'll add the README change as its own commit. The squash merge folds both into one anyway.");
  const f6Msg = 'Document --group-by-scope in the README';
  s4.bash(`git add README.md && git commit -m "${f6Msg}"`, { description: 'Commit the README change', run: ({ end }) => {
    commits.groupReadme = lantern.commit({ 'README.md': readme({ since: true, group: true }) }, f6Msg, end, groupWt);
    return { stdout: committed('feature/group-by-scope', commits.groupReadme, f6Msg), git: { commit: { sha: commits.groupReadme.sha, kind: 'committed' } } };
  } });
  s4.bash('git push', { description: 'Push the fix', ms: 1400, run: () => ({ stderr: `To ${REMOTE}\n   ${commits.group.short}..${commits.groupReadme.short}  feature/group-by-scope -> feature/group-by-scope`, git: { push: { branch: 'feature/group-by-scope' } } }) });
  s4.say('Pushed. CI is running again on #14.');
  s4.turnEnd();
  s4.at('10:21:05');
  s4.prompt('Checks are green. Squash-merge #14 and log progress on the release goal.');
  s4.bash('gh pr view 14 --json state,mergeStateStatus', { description: 'Check #14', ms: 1100, stdout: '{"mergeStateStatus":"CLEAN","state":"OPEN"}' });
  s4.bash('gh pr merge 14 --squash', { description: 'Squash-merge #14', ms: 3500, run: ({ end }) => {
    commits.pr14 = lantern.squash('feature/group-by-scope', `${f5Msg} (#14)`, iso(Date.parse(end) - 1400));
    return { stdout: `✓ Squashed and merged pull request ${SLUG}#14 (${f5Msg})` };
  } });
  applyGoal(s4, { goal: 'release-1-4', event: 'gev-9p4x', type: 'progress', extra: ' --cite lantern#14' });
  s4.say(`Merged #14 as ${commits.pr14.short}, and recorded progress on release-1-4 (gev-9p4x).`);
  s4.turnEnd();
  s4.prompt('Next up is a JSON output mode. Suggest it as a separate task, and add a goal for it.', 150000);
  const jsonTask = 'Add a --format json option to lantern that prints each release as an object with its version, date and entries grouped by scope. Keep the text output unchanged and add tests.';
  const chip = s4.use('mcp__ccd_session__spawn_task', { title: 'Add a JSON output mode', prompt: jsonTask, tldr: 'Adds --format json so scripts can read lantern output; the text output stays the same.' }, 2600);
  s4.result(chip.id, 'Noted (position 1, task_id: task_8kq2m). The person can start it from the suggestion.', { ms: 150, tur: [{ type: 'text', text: 'Noted (position 1, task_id: task_8kq2m).' }] });
  applyGoal(s4, { goal: 'json-output', event: 'gev-b6t1', type: 'created', extra: ' --title "Offer machine-readable output"' });
  s4.say('Suggested "Add a JSON output mode" as a separate task, and created the json-output goal (gev-b6t1).');
  s4.stopHooks();
  s4.turnEnd(200);
  saveClaude(PROJECT_DIRS.groupWorktree, s4);

  // ==== Friday: JSON output, started from the suggestion (Claude Code, worktree) ==
  const jsonWt = lantern.worktree(join(lanternDir, '.claude', 'worktrees', 'json-output'), 'feature/json-output', 'main');
  const s5 = new ClaudeLog({ id: SESSION_IDS.jsonOutput, cwd: jsonWt, branch: 'feature/json-output', day: FRI, start: '09:30:05' });
  s5.prompt(jsonTask);
  s5.title('Add a JSON output mode');
  s5.say("I'll map where lantern writes output before adding a second format.");
  const outPrompt = 'Find every place lantern writes to stdout or builds output text, and every option that changes the output. Report file paths, line numbers, and how options flow from bin/lantern.mjs.';
  const ex = s5.agent({ description: 'Find every place lantern writes output', type: 'Explore', prompt: outPrompt }, 1800);
  const se = new ClaudeLog({ id: s5.id, cwd: jsonWt, branch: 'feature/json-output', day: FRI, start: '09:30:00', agentId: AGENT_IDS.output });
  se.atMs(Date.parse(ex.at) + 800);
  se.delegated(outPrompt);
  se.grep('process\\.stdout|console\\.log', { files: ['bin/lantern.mjs'], gap: 2300 });
  se.read('bin/lantern.mjs', bin({ since: true, group: true }), { gap: 2100 });
  se.read('src/format.mjs', F.formatGrouped, { gap: 2400 });
  const outReport = 'Output is written in one place: process.stdout.write(format(releases, opts)) at the end of bin/lantern.mjs. Options that change it: --width and --group-by-scope (both read by format()), and --since (filters releases before formatting). Nothing else prints.';
  se.say(outReport, 8800);
  s5.atMs(se.t + 700);
  s5.agentDone(ex, { agentId: AGENT_IDS.output, prompt: outPrompt, report: outReport, toolUses: 3 });
  saveAgent(PROJECT_DIRS.jsonWorktree, se, { agentType: 'Explore', description: 'Find every place lantern writes output', toolUseId: ex.id, spawnDepth: 1 });
  s5.say('There is a single write at the end of bin/lantern.mjs, so a --format option can choose between format() and a new toJson().');
  s5.write('src/json.mjs', F.jsonFirst);
  s5.write('test/json.test.mjs', F.testJsonFirst);
  s5.edit('bin/lantern.mjs', bin({ since: true, group: true }), bin({ since: true, group: true, json: true }));
  s5.bash('node --test', { description: 'Run the test suite', ms: 1250, stdout: tap({ tests: 14, ms: 468.1 }) });
  s5.say('`--format json` prints an array of releases, each with its entries grouped by scope. The text output is untouched, and the suite passes.');
  s5.turnEnd();
  s5.at('09:40:02');
  s5.prompt('Use "releases" as the top-level key, so we can add metadata next to it later.');
  s5.edit('src/json.mjs', F.jsonFirst, F.jsonKeyed);
  s5.edit('test/json.test.mjs', F.testJsonFirst, F.testJsonKeyed);
  s5.bash('node --test', { description: 'Run the test suite', ms: 1200, stdout: tap({ tests: 14, ms: 459.6 }) });
  const f7Msg = 'Add a JSON output mode';
  s5.bash(`git add -A && git commit -m "${f7Msg}"`, { description: 'Commit the JSON mode', run: ({ end }) => {
    commits.json = lantern.commit({ 'src/json.mjs': F.jsonKeyed, 'test/json.test.mjs': F.testJsonKeyed, 'bin/lantern.mjs': bin({ since: true, group: true, json: true }) }, f7Msg, end, jsonWt);
    return { stdout: committed('feature/json-output', commits.json, f7Msg), git: { commit: { sha: commits.json.sha, kind: 'committed' } } };
  } });
  s5.bash('git push -u origin feature/json-output', { description: 'Push the branch', ms: 1500, run: () => ({ stderr: `To ${REMOTE}\n * [new branch]      feature/json-output -> feature/json-output\nbranch 'feature/json-output' set up to track 'origin/feature/json-output'.`, git: { push: { branch: 'feature/json-output' } } }) });
  s5.bash(`gh pr create --title "${f7Msg}" --body "Adds --format json: { releases: [{ version, date, scopes }] }. Text output is unchanged."`, { description: 'Open a pull request', ms: 2300, run: () => ({ stdout: prUrl(15), stderr: `\nCreating pull request for feature/json-output into main in ${SLUG}\n`, git: { pr: { number: 15, url: prUrl(15), action: 'created' } } }) });
  s5.prLink(15);
  s5.say(`Opened #15: ${prUrl(15)}`);
  s5.turnEnd();
  s5.prompt('Note the PR on the JSON goal, then watch CI.', 64000);
  applyGoal(s5, { goal: 'json-output', event: 'gev-c2w8', type: 'observation', extra: ` --cite ${prUrl(15)}` });
  s5.use('Bash', { command: 'gh pr checks 15 --watch', description: 'Watch CI on #15' }, 2200);
  saveClaude(PROJECT_DIRS.jsonWorktree, s5);

  // ==== Friday afternoon: Node 18 fix on the same branch (Codex, worktree) =======
  const cx2 = new CodexLog({ id: CODEX_IDS.node18, cwd: jsonWt, day: FRI, start: '13:31:02' });
  cx2.meta({ git: { commit_hash: commits.json.sha, branch: 'feature/json-output', repository_url: REMOTE } });
  cx2.context();
  cx2.turn(17900);
  cx2.ide('src/json.mjs', 'CI on #15 fails on the Node 18 and Node 20 jobs with `TypeError: Object.groupBy is not a function`. lantern supports Node 18, so fix it without that API.');
  cx2.reason();
  cx2.exec('rg -n "Object.groupBy|toSorted|findLast" src test', { out: "src/json.mjs:3:  const out = releases.map((r) => ({ version: r.version, date: r.date, scopes: Object.groupBy(r.entries, (e) => (e.scope ? e.scope.toLowerCase() : 'other')) }));\n" });
  cx2.exec("sed -n '1,20p' src/json.mjs", { out: F.jsonKeyed });
  cx2.reason(2200);
  cx2.patch(codexPatch('src/json.mjs', F.jsonKeyed, F.json));
  cx2.exec('node --test', { ms: 1300, out: `${tap({ tests: 14, ms: 452.2 })}\n` });
  cx2.say('Replaced Object.groupBy with the groupByScope helper the text output already uses, so toJson() runs on Node 18. The JSON shape is the same and the suite passes.');
  cx2.done();
  cx2.at('13:40:15');
  cx2.turn();
  cx2.ide('test/json.test.mjs', 'Also add a test that an empty changelog prints an empty releases list. Then commit and push.');
  cx2.reason(1800);
  cx2.patch(codexPatch('test/json.test.mjs', F.testJsonKeyed, F.testJsonEmptyWrong));
  cx2.exec('node --test', { ms: 1250, exit: 1, out: `${tap({ tests: 15, failures: [{ n: 15, name: 'prints an empty list for an empty changelog', error: 'Expected values to be strictly equal: the actual output is pretty-printed over three lines' }], ms: 470.9 })}\n` });
  cx2.reason();
  cx2.patch(codexPatch('test/json.test.mjs', F.testJsonEmptyWrong, F.testJson));
  cx2.exec('node --test', { ms: 1200, out: `${tap({ tests: 15, ms: 455.5 })}\n` });
  const f8Msg = 'Run the JSON mode on Node 18 and cover an empty changelog';
  cx2.exec(`git add -A && git commit -m "${f8Msg}"`, { run: ({ end }) => {
    commits.node18 = lantern.commit({ 'src/json.mjs': F.json, 'test/json.test.mjs': F.testJson }, f8Msg, end, jsonWt);
    return { out: `${committed('feature/json-output', commits.node18, f8Msg)}\n` };
  } });
  cx2.exec('git push', { ms: 1400, run: () => ({ out: `To ${REMOTE}\n   ${commits.json.short}..${commits.node18.short}  feature/json-output -> feature/json-output\n` }) });
  cx2.say(`The new test expected compact JSON, but toJson() pretty-prints, so I fixed the expectation rather than the code. Committed ${commits.node18.short} and pushed to feature/json-output; #15 will rerun CI.`);
  cx2.done();
  saveCodex(cx2);

  // ==== Friday evening: a post on a display-only site (Claude Code) =============
  const post = '# lantern 1.4\n\nlantern 1.4 adds two things.\n\n- `--since` prints only the releases after a date or a tag.\n- `--group-by-scope` lists entries under their scope.\n\nBoth are off by default, so existing scripts see the same output.\n';
  const postShort = '# lantern 1.4\n\n`--since` prints only the releases after a date or a tag, and `--group-by-scope` lists entries under their scope. Both are off by default.\n';
  const s7 = new ClaudeLog({ id: SESSION_IDS.sitePost, cwd: siteDir, branch: 'main', day: FRI, start: '18:10:03' });
  s7.prompt('Draft a short post for my site about lantern 1.4: date filtering with --since and grouped output. Keep it under 300 words.');
  s7.title('Draft a post about lantern 1.4');
  s7.glob('posts/*.md', ['posts/2025-02-28-hello.md']);
  s7.read('posts/2025-02-28-hello.md', '# Hello\n\nThis is where I write about the small tools I build.\n');
  s7.write('posts/2025-03-14-lantern-1-4.md', `# 🔦 ${post.slice(2)}`);
  s7.bash('npm run build', { description: 'Build the site', ms: 1600, stdout: '\n> personal-site build\n> node build.mjs\n\nbuilt 2 posts into dist/' });
  s7.say('Drafted posts/2025-03-14-lantern-1-4.md (about 40 words) and the site builds.');
  s7.turnEnd();
  s7.at('18:21:40');
  s7.prompt('Shorter, and drop the emoji from the title.');
  s7.edit('posts/2025-03-14-lantern-1-4.md', `# 🔦 ${post.slice(2)}`, postShort);
  s7.bash('git add -A && git commit -m "Draft a post about lantern 1.4"', { description: 'Commit the draft', run: ({ end }) => {
    commits.sitePost = site.commit({ 'posts/2025-03-14-lantern-1-4.md': postShort }, 'Draft a post about lantern 1.4', end);
    return { stdout: committed('main', commits.sitePost, 'Draft a post about lantern 1.4'), git: { commit: { sha: commits.sitePost.sha, kind: 'committed' } } };
  } });
  s7.say('Cut it to two sentences, dropped the emoji, and committed the draft.');
  s7.turnEnd();
  saveClaude(PROJECT_DIRS.site, s7);

  // ==== Saturday: looking up the goal events, read-only (Claude Code) ===========
  const s8 = new ClaudeLog({ id: SESSION_IDS.goalLookup, cwd: lanternDir, branch: 'main', day: SAT, start: '10:02:14' });
  s8.prompt("Which goal events did I record this week? Just list them, don't change anything.");
  s8.title("List this week's goal events");
  const listed = goalEvents.map((g) => `${g.at.slice(0, 10)} ${g.at.slice(11, 16)}  ${g.eventId}  ${g.goalId.padEnd(17)}  ${g.type}`).join('\n');
  s8.bash(`${GOALS} list --since 2025-03-10`, { description: 'List goal events since Monday', ms: 900, stdout: `${goalEvents.length} events\n${listed}` });
  s8.say(`Six goal events this week:\n${listed}`);
  s8.turnEnd();
  s8.at('10:05:40');
  s8.prompt('Show me gev-9p4x in full, and check whether either release-goal event id turns up anywhere in this repo.');
  const e9 = goalEvents.find((g) => g.eventId === 'gev-9p4x');
  s8.bash(`${GOALS} show gev-9p4x`, { description: 'Show one goal event', ms: 800, stdout: JSON.stringify({ ...e9, cite: 'lantern#14' }, null, 2) });
  s8.grep('gev-3k9a|gev-9p4x', { files: [] });
  s8.say('gev-9p4x is the progress event on release-1-4 from Thursday, citing lantern#14. Neither gev-3k9a nor gev-9p4x appears in this repository; they live only in the goal record.');
  s8.turnEnd();
  saveClaude(PROJECT_DIRS.lantern, s8);

  // ==== Saturday afternoon: outside every configured repo (Claude Code) =========
  const s9 = new ClaudeLog({ id: SESSION_IDS.scratch, cwd: scratchDir, branch: '', day: SAT, start: '16:04:30' });
  s9.prompt('Write a small Node script that renames the screenshots in this folder to their capture date, with a dry-run mode.');
  s9.title('Rename screenshots by date');
  s9.write('rename-shots.mjs', "import { readdirSync, renameSync, statSync } from 'node:fs';\n\nconst dry = process.argv.includes('--dry-run');\nfor (const f of readdirSync('.').filter((n) => n.endsWith('.png'))) {\n  const to = `${statSync(f).mtime.toISOString().slice(0, 10)}-${f}`;\n  if (dry) console.log(`${f} -> ${to}`);\n  else renameSync(f, to);\n}\n");
  s9.bash('node rename-shots.mjs --dry-run', { description: 'Preview the renames', ms: 400, stdout: 'Screenshot 1.png -> 2025-03-12-Screenshot 1.png\nScreenshot 2.png -> 2025-03-14-Screenshot 2.png' });
  s9.say('The dry run shows each rename. Run it without --dry-run when the list looks right.');
  s9.turnEnd();
  s9.at('16:09:10');
  s9.prompt('Looks right. Run it for real.');
  s9.bash('node rename-shots.mjs', { description: 'Rename the screenshots', ms: 400, stdout: '' });
  s9.say('Renamed the screenshots.');
  s9.turnEnd();
  saveClaude(PROJECT_DIRS.scratch, s9);

  // ---- config, goal record ---------------------------------------------------
  const rawConfig = {
    identity: { authorEmails: [ME] },
    week: { startsOn: 'monday', timezone: WEEK.timezone },
    repos: [
      { path: './lantern', label: 'lantern', role: 'featured' },
      { path: './personal-site', label: 'personal-site', role: 'display' },
    ],
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: 'honestweek.digest.md' },
  };
  const configFile = join(root, 'honestweek.config.json');
  writeFileSync(configFile, `${JSON.stringify(rawConfig, null, 2)}\n`);
  const config = normalizeConfig(rawConfig, { configDir: root });

  const session = (id) => ({ ref: `session:${id}` });
  const goalRecord = {
    goals: [
      {
        id: 'release-1-4',
        title: 'Release lantern 1.4 with date filtering and grouped output',
        state: 'active',
        source: { ref: 'lantern#12' },
        observations: [
          { source: session(SESSION_IDS.sinceFlag), note: '--since landed with dates and version tags; #12 is squash-merged.' },
          { source: { ref: 'lantern#14' }, note: 'Grouping by scope landed in #14. Cutting the release is still to do.' },
        ],
      },
      {
        id: 'wrap-every-script',
        title: 'Wrap output correctly for every script',
        state: 'done',
        source: { ref: prUrl(13) },
        observations: [{ source: session(SESSION_IDS.groupByScope), note: 'Merged #13 and marked the goal done.' }],
      },
      {
        id: 'json-output',
        title: 'Offer machine-readable output',
        state: 'active',
        source: session(SESSION_IDS.groupByScopeResumed),
        observations: [
          { source: { ref: prUrl(15) }, note: 'The JSON mode is open for review in #15.' },
          { source: session(SESSION_IDS.jsonOutput), note: 'Started from the task suggestion; CI was still running when the session stopped recording.' },
        ],
      },
    ],
    events: goalEvents,
  };
  const goalsFile = join(root, 'goals.json');
  writeFileSync(goalsFile, `${JSON.stringify(goalRecord, null, 2)}\n`);

  return {
    root,
    roots: { claude: [projects], codex: [codexRoot] },
    repo: { dir: lanternDir, remote: REMOTE, defaultBranch: 'main', worktrees: { groupByScope: groupWt, jsonOutput: jsonWt }, commits: Object.fromEntries(Object.entries(commits).filter(([k]) => k !== 'sitePost').map(([k, c]) => [k, c.sha])) },
    displayRepo: { dir: siteDir, commit: commits.sitePost.sha },
    outsideDir: scratchDir,
    config,
    configFile,
    goalRecord,
    goalsFile,
    week: { ...WEEK },
    files: { claude: claudeFiles, codex: codexFiles },
    ids: { claude: { ...SESSION_IDS }, codex: { ...CODEX_IDS }, agents: { ...AGENT_IDS }, projectDirs: { ...PROJECT_DIRS } },
  };
}
