// lib/demo/content.mjs: the bulky made-up text the demo week's longer sessions read and print.
//
// Five changelogs of invented projects (the fixtures Wednesday's session renders as Markdown),
// the renderer that session builds, mirrored here so what the logs print matches the code the
// session wrote, a CI log the way `gh run view --log` prints one, and the TAP report `node
// --test` prints. Everything is generated from fixed seeds, so it's the same on every run. The
// project names, owners and links are placeholders under github.com/example.

import { createHash } from 'node:crypto';

/** A small seeded generator: the same seed gives the same numbers on every run. */
export function rng(seed) {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

// ---------------------------------------------------------------------------
// Changelogs of five invented projects
// ---------------------------------------------------------------------------

const VERBS = {
  feat: ['add', 'support', 'allow', 'accept', 'expose', 'read'],
  fix: ['keep', 'stop dropping', 'handle', 'respect', 'restore', 'fix'],
  other: ['speed up', 'simplify', 'document', 'rename', 'clean up', 'log'],
};
const SECTION_OF = { feat: 'Added', fix: 'Fixed', other: 'Changed' };
const PROJECTS = [
  {
    name: 'driftwood',
    style: 'conventional',
    scopes: ['build', 'cli', 'config', 'dev-server', 'markdown', 'plugins', 'themes'],
    things: ['relative links', 'front matter dates', 'draft pages', 'the --watch flag', 'image paths', 'nested layouts', 'the output folder', 'page titles with quotes', 'unicode file names', 'the sitemap', 'plugin load order', 'theme overrides', 'the base path', 'code block languages'],
    when: ['on Windows', 'in nested folders', 'after a rebuild', 'with a custom base path', 'in watch mode', 'when the config is missing', 'for pages with no title', 'when two plugins register the same hook'],
    first: [3, 1, 2],
    pr: 512,
  },
  {
    name: 'quillpen',
    style: 'sections',
    scopes: [],
    things: ['heading level rules', 'line length checks', 'fenced code blocks', 'the --fix flag', 'table alignment', 'list markers', 'trailing spaces', 'front matter', 'link reference checks', 'the ignore file', 'emphasis style', 'blank lines around headings', 'HTML comments'],
    when: ['in long documents', 'with CRLF line endings', 'when a rule is disabled inline', 'in nested lists', 'for files with a BOM', 'when run from a subfolder', 'with the JSON reporter'],
    first: [3, 3, 0],
    pr: 388,
  },
  {
    name: 'harbor-config',
    style: 'conventional',
    scopes: ['env', 'loader', 'schema', 'types', 'yaml', 'merge'],
    things: ['nested defaults', 'environment overrides', 'the extends key', 'YAML anchors', 'array merging', 'secret file references', 'schema errors', 'dotted keys', 'number coercion', 'the watch callback', 'missing files'],
    when: ['for deeply nested keys', 'when two files set the same key', 'with an empty file', 'in strict mode', 'on reload', 'when the schema has defaults'],
    first: [2, 2, 1],
    pr: 247,
  },
  {
    name: 'emberline',
    style: 'sections',
    scopes: [],
    things: ['the follow mode', 'JSON log lines', 'colour themes', 'the time column', 'search highlighting', 'multi-line stack traces', 'the --since filter', 'compressed log files', 'level filters', 'very long lines', 'the status bar'],
    when: ['in narrow terminals', 'when the file is rotated', 'with UTC timestamps', 'for logs over 1 GB', 'when the terminal has no colour', 'after a resize'],
    first: [1, 6, 2],
    pr: 171,
  },
  {
    name: 'mossbank',
    style: 'mixed',
    scopes: ['api', 'disk', 'eviction', 'stats', 'ttl'],
    things: ['expired entries', 'the size limit', 'stale reads', 'the stats endpoint', 'write batching', 'key prefixes', 'the on-disk index', 'concurrent writers', 'the clear command', 'binary values'],
    when: ['under heavy write load', 'after a crash', 'when the disk is full', 'with very short TTLs', 'on startup', 'with keys over 1 KB'],
    first: [2, 4, 3],
    pr: 309,
  },
];

function releasesOf(p) {
  const r = rng(`demo changelog ${p.name}`);
  let [major, minor, patch] = p.first;
  let t = Date.parse('2025-03-03T00:00:00Z');
  let pr = p.pr;
  const out = [];
  for (let i = 0; i < 40 && (major > 0 || minor > 0 || patch > 0); i++) {
    const n = 5 + Math.floor(r() * 7);
    const entries = [];
    for (let j = 0; j < n; j++) {
      const roll = r();
      const type = patch > 0 && roll < 0.6 ? 'fix' : roll < 0.45 ? 'feat' : roll < 0.85 ? 'fix' : 'other';
      const otherType = pick(r, ['perf', 'refactor', 'docs', 'chore']);
      const verb = pick(r, VERBS[type]);
      const text = `${verb} ${pick(r, p.things)} ${pick(r, p.when)} (#${pr--})`;
      entries.push({ type: type === 'other' ? otherType : type, kind: type, scope: p.scopes.length ? pick(r, p.scopes) : null, text });
    }
    out.push({ version: `${major}.${minor}.${patch}`, date: new Date(t).toISOString().slice(0, 10), entries });
    t -= (9 + Math.floor(r() * 30)) * 86400e3;
    pr -= Math.floor(r() * 4);
    if (patch > 0) patch -= 1;
    else if (minor > 0) {
      minor -= 1;
      patch = Math.floor(r() * 3);
    } else {
      major -= 1;
      minor = 4 + Math.floor(r() * 4);
      patch = 0;
    }
  }
  return out;
}

function changelogText(p) {
  const releases = releasesOf(p);
  const lines = ['# Changelog', '', 'All notable changes to this project are written down here.', ''];
  releases.forEach((rel, i) => {
    lines.push(`## [${rel.version}] - ${rel.date}`, '');
    const conventional = p.style === 'conventional' || (p.style === 'mixed' && i % 3 !== 0);
    if (conventional) {
      for (const e of rel.entries) lines.push(`- ${e.type}${e.scope ? `(${e.scope})` : ''}: ${e.text}`);
      lines.push('');
      return;
    }
    for (const kind of ['feat', 'fix', 'other']) {
      const list = rel.entries.filter((e) => e.kind === kind);
      if (!list.length) continue;
      lines.push(`### ${SECTION_OF[kind]}`, '');
      for (const e of list) lines.push(`- ${e.text.charAt(0).toUpperCase()}${e.text.slice(1)}`);
      lines.push('');
    }
  });
  for (let i = 0; i < releases.length - 1; i++) lines.push(`[${releases[i].version}]: https://github.com/example/${p.name}/compare/v${releases[i + 1].version}...v${releases[i].version}`);
  lines.push(`[${releases.at(-1).version}]: https://github.com/example/${p.name}/releases/tag/v${releases.at(-1).version}`);
  return `${lines.join('\n')}\n`;
}

/** The five fixture changelogs: [{ name, file, text }], file relative to the repository. */
export const FIXTURES = Object.freeze(PROJECTS.map((p) => Object.freeze({ name: p.name, file: `test/fixtures/changelogs/${p.name}.md`, text: changelogText(p) })));

// ---------------------------------------------------------------------------
// The Markdown renderer Wednesday's session writes, mirrored
// ---------------------------------------------------------------------------

/** lantern's parse(), with Keep a Changelog sections when `sections` is set. */
export function parseChangelog(text, { sections = false } = {}) {
  const releases = [];
  let section = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/);
    if (heading) {
      releases.push({ version: heading[1], date: heading[2] ?? null, entries: [] });
      section = null;
      continue;
    }
    const sec = sections ? line.match(/^### (\w+)/) : null;
    if (sec) {
      section = sec[1];
      continue;
    }
    const entry = line.match(/^- (?:(\w+)(?:\(([^)]*)\))?: )?(.+)$/);
    if (entry && releases.length) releases[releases.length - 1].entries.push({ type: entry[1] ?? null, scope: entry[2] ?? null, text: entry[3], ...(section ? { section } : {}) });
  }
  return releases;
}

const GROUP_OF_TYPE = { feat: 'Features', fix: 'Fixes' };
const GROUP_OF_SECTION = { Added: 'Features', Fixed: 'Fixes', Security: 'Fixes' };
function wrapPlain(text, width, indent) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = indent + word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** The repository named by a changelog's compare links, or null. */
export const repoOf = (text) => text.match(/^\[[^\]]+\]: https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:compare|releases)\//m)?.[1] ?? null;

/** toMarkdown() at each of its stages: `width` wraps entries (the first two), `sections`
 *  reads Keep a Changelog headings into the groups (from the second). */
export function toMarkdown(releases, { repo = null, width = null, sections = false } = {}) {
  const out = [];
  for (const r of releases) {
    out.push(`## ${r.version}${r.date ? ` (${r.date})` : ''}`, '');
    const by = new Map([['Features', []], ['Fixes', []], ['Other', []]]);
    for (const e of r.entries) by.get((sections && e.section ? GROUP_OF_SECTION[e.section] : GROUP_OF_TYPE[e.type]) ?? 'Other').push(e);
    for (const [title, list] of by) {
      if (!list.length) continue;
      out.push(`### ${title}`, '');
      for (const e of list) {
        const text = repo ? e.text.replace(/\(#(\d+)\)/g, (m, n) => `([#${n}](https://github.com/${repo}/pull/${n}))`) : e.text;
        const item = `- ${e.scope ? `**${e.scope}:** ` : ''}${text}`;
        out.push(width ? wrapPlain(item, width, '  ') : item);
      }
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// What `node --test` and `gh run view --log` print
// ---------------------------------------------------------------------------

/** The TAP report `node --test` prints when its output isn't a terminal, every test listed.
 *  tests: [name], failures: { name: error }, skipped: [name]. */
export function tapReport({ tests, failures = {}, skipped = [], ms, seed = 'tap' }) {
  const r = rng(seed);
  const lines = ['TAP version 13'];
  tests.forEach((name, i) => {
    const d = (0.4 + r() * 3).toFixed(4);
    lines.push(`# Subtest: ${name}`);
    if (failures[name]) lines.push(`not ok ${i + 1} - ${name}`, '  ---', `  duration_ms: ${d}`, "  failureType: 'testCodeFailure'", `  error: '${failures[name]}'`, "  code: 'ERR_ASSERTION'", '  ...');
    else lines.push(`ok ${i + 1} - ${name}${skipped.includes(name) ? ' # SKIP' : ''}`, '  ---', `  duration_ms: ${skipped.includes(name) ? '0.0412' : d}`, '  ...');
  });
  const fail = Object.keys(failures).length;
  lines.push(`1..${tests.length}`, `# tests ${tests.length}`, '# suites 0', `# pass ${tests.length - fail - skipped.length}`, `# fail ${fail}`, '# cancelled 0', `# skipped ${skipped.length}`, '# todo 0', `# duration_ms ${ms}`);
  return lines.join('\n');
}

/** A whole CI run as `gh run view <id> --log` prints it: one line per log line, each
 *  prefixed with its job and step. The Windows jobs fail `failing` with `error`. */
export function ciLog({ start, sha, tests, failing, error }) {
  const r = rng(`demo ci log ${sha}`);
  const lines = [];
  let t;
  const stamp = () => {
    t += 3 + Math.floor(r() * 900);
    return `${new Date(t).toISOString().slice(0, 19)}.${String(Math.floor(r() * 1e7)).padStart(7, '0')}Z`;
  };
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    for (const node of ['18', '20', '22']) {
      const job = `test (${os}, ${node})`;
      // The six jobs run side by side, so each one's clock starts with the run.
      t = Date.parse(start);
      const win = os === 'windows-latest';
      const say = (step, text) => lines.push(`${job}\t${step}\t${stamp()} ${text}`);
      const image = win ? 'windows-2022' : 'ubuntu-24.04';
      for (const l of ['Current runner version: \'2.322.0\'', 'Operating System', win ? 'Microsoft Windows Server 2022' : 'Ubuntu', win ? '10.0.20348' : '24.04.2', 'LTS', 'Runner Image', `Image: ${image}`, `Version: 20250302.1.0`, 'Complete job name: ' + job]) say('Set up job', l);
      for (const l of ['##[group]Run actions/checkout@v4', 'with:', '  repository: example/lantern', '##[endgroup]', 'Syncing repository: example/lantern', '##[group]Getting Git version info', `Working directory is '${win ? 'D:\\a\\lantern\\lantern' : '/__w/lantern/lantern'}'`, `[command]${win ? '"C:\\Program Files\\Git\\bin\\git.exe"' : '/usr/bin/git'} version`, `git version ${win ? '2.47.1.windows.2' : '2.48.1'}`, '##[endgroup]', 'Initializing the repository', '[command]git init', '[command]git remote add origin https://github.com/example/lantern', '##[group]Fetching the repository', `[command]git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +${sha}:refs/remotes/origin/main`, ` * [new ref]         ${sha} -> origin/main`, '##[endgroup]', '##[group]Checking out the ref', '[command]git checkout --progress --force -B main refs/remotes/origin/main', "Switched to a new branch 'main'", "branch 'main' set up to track 'origin/main'.", '##[endgroup]', `[command]git log -1 --format=%H`, sha]) say('Run actions/checkout@v4', l);
      for (const l of ['##[group]Run actions/setup-node@v4', 'with:', `  node-version: ${node}`, '  always-auth: false', '  check-latest: false', '  token: ***', '##[endgroup]', 'Attempting to download ' + node + '...', `Found in cache @ ${win ? 'C:\\hostedtoolcache\\windows\\node' : '/opt/hostedtoolcache/node'}/${node === '18' ? '18.20.7' : node === '20' ? '20.18.3' : '22.14.0'}/x64`, '##[group]Environment details', `node: v${node === '18' ? '18.20.7' : node === '20' ? '20.18.3' : '22.14.0'}`, `npm: ${node === '18' ? '10.8.2' : '10.9.2'}`, 'yarn: 1.22.22', '##[endgroup]']) say('Run actions/setup-node@v4', l);
      say('Run node --test', '##[group]Run node --test');
      say('Run node --test', 'node --test');
      say('Run node --test', `shell: ${win ? 'C:\\Program Files\\PowerShell\\7\\pwsh.EXE -command ". \'{0}\'"' : '/usr/bin/bash -e {0}'}`);
      say('Run node --test', '##[endgroup]');
      const report = tapReport({ tests, failures: win ? { [failing]: error } : {}, ms: (380 + r() * 260).toFixed(4), seed: `${job} tap` });
      for (const l of report.split('\n')) say('Run node --test', l);
      if (win) {
        say('Run node --test', '##[error]Process completed with exit code 1.');
      }
      say('Complete job', 'Cleaning up orphan processes');
    }
  }
  return lines.join('\n');
}
