// The rest of the demo week (docs/demo-week.md): one long session that splits its work across
// seven sub-agents, the background review it starts, and the everyday sessions around it, so
// most days hold four to eight sessions the way a working week does.
//
// lib/demo/week.mjs calls one function a day, at the point in its own story where that day's
// repository state is right (a worktree made from main on Tuesday holds Tuesday's main). The
// repetitive parts, the lint rules and their tests, and the steps each rule's sub-agent takes,
// are generated from the tables below.

import { FIXTURES } from './content.mjs';

/** Tuesday afternoon's `lantern lint`: four groups of rules, one sub-agent each. */
const LINT_CORE = `// Check a Keep a Changelog file for mistakes that spoil the release notes.
import { parse } from './parse.mjs';
{{imports}}
/** The rules lint runs, each { id, level, check(ctx) -> [{ line, message }] }. */
export const RULES = [{{rules}}];

const HEADING = /^## \\[?([^\\]\\s]+)\\]?(?: - (\\S+))?\\s*$/;
const ENTRY = /^- (?:(\\w+)(?:\\(([^)]*)\\))?!?: )?(.+)$/;
const LINK = /^\\[([^\\]]+)\\]: (\\S+)$/;

/** Where each heading, entry and link sits (1-based), since parse() keeps no line numbers. */
export function locate(text) {
  const headings = [];
  const entries = [];
  const links = [];
  text.split('\\n').forEach((l, i) => {
    let m;
    if ((m = l.match(HEADING))) headings.push({ line: i + 1, version: m[1], date: m[2] ?? null, entries: 0 });
    else if ((m = l.match(LINK))) links.push({ line: i + 1, version: m[1], url: m[2] });
    else if ((m = l.match(ENTRY)) && headings.length) {
      headings[headings.length - 1].entries++;
      entries.push({ line: i + 1, type: m[1] ?? null, scope: m[2] ?? null, text: m[3] });
    }
  });
  return { headings, entries, links };
}

/** lint(text, { rules, today }) -> [{ line, rule, level, message }]{{order}} */
export function lint(text, { rules = RULES, today = new Date().toISOString().slice(0, 10) } = {}) {
  const ctx = { text, releases: parse(text), today, ...locate(text) };
  return rules
    .flatMap((r) => r.check(ctx).map((p) => ({ line: p.line, rule: r.id, level: r.level, message: p.message })))
    .sort((a, b) => {{sort}});
}

/** One line per problem, for the terminal. */
export function formatProblems(file, problems) {
  return problems.length ? problems.map((p) => \`\${file}:\${p.line} {{format}}\${p.message}\`).join('\\n') : \`\${file}: no problems found\`;
}
`;
const BY_LINE = "a.line - b.line || a.rule.localeCompare(b.rule)";
const ERRORS_FIRST = "(a.level === b.level ? 0 : a.level === 'error' ? -1 : 1) || a.line - b.line || a.rule.localeCompare(b.rule)";
function lintCore(stage) {
  const groups = stage >= 2 ? LINT_GROUPS : [];
  return LINT_CORE.replace('{{imports}}', groups.map((g) => `import { ${g.exportName} } from './rules/${g.key}.mjs';\n`).join(''))
    .replace('{{rules}}', groups.map((g) => `...${g.exportName}`).join(', '))
    .replace('{{order}}', stage >= 3 ? ', errors first, then by line.' : ', by line.')
    .replace('{{sort}}', stage >= 3 ? ERRORS_FIRST : BY_LINE)
    .replace('{{format}}', stage >= 3 ? '${p.level} ${p.rule} ' : '${p.rule} ');
}

const SAMPLE = '# Changelog\n\n## [Unreleased]\n- feat: next\n\n## [1.0.0] - 2025-01-02\n- fix: first\n\n[1.0.0]: https://github.com/example/lantern/releases/tag/v1.0.0\n';
/** test/lint.test.mjs: 1 as first written, 2 with the sample changelogs, 3 with the new output
 *  format, 4 with errors listed first. */
function lintCoreTest(stage) {
  const order = stage >= 4
    ? "test('errors come first, then problems in line order', () => {\n  assert.deepEqual(lint(SAMPLE, { rules: TWO }).map((p) => p.line), [9, 2]);\n});"
    : "test('problems come out in line order', () => {\n  assert.deepEqual(lint(SAMPLE, { rules: TWO }).map((p) => p.line), [2, 9]);\n});";
  const printed = stage >= 3 ? 'CHANGELOG.md:2 warning a early' : 'CHANGELOG.md:2 a early';
  const samples = stage >= 2 ? `

test('the sample changelogs have no errors', () => {
  for (const name of readdirSync(new URL('./fixtures/changelogs/', import.meta.url))) {
    const text = readFileSync(new URL(\`./fixtures/changelogs/\${name}\`, import.meta.url), 'utf8');
    assert.deepEqual(lint(text, { today: '2025-03-11' }).filter((p) => p.level === 'error'), [], name);
  }
});` : '';
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
${stage >= 2 ? "import { readdirSync, readFileSync } from 'node:fs';\n" : ''}import { formatProblems, lint, locate } from '../src/lint.mjs';

const SAMPLE = ${JSON.stringify(SAMPLE)};
const TWO = [{ id: 'b', level: 'error', check: () => [{ line: 9, message: 'late' }] }, { id: 'a', level: 'warning', check: () => [{ line: 2, message: 'early' }] }];

test('locate finds headings, entries and links with their line numbers', () => {
  const { headings, entries, links } = locate(SAMPLE);
  assert.deepEqual(headings.map((h) => [h.line, h.version, h.date]), [[3, 'Unreleased', null], [6, '1.0.0', '2025-01-02']]);
  assert.deepEqual(entries.map((e) => [e.line, e.type]), [[4, 'feat'], [7, 'fix']]);
  assert.deepEqual(links.map((l) => [l.line, l.version]), [[9, '1.0.0']]);
});

${order}

test('formatProblems prints one line per problem', () => {
  assert.equal(formatProblems('CHANGELOG.md', [{ line: 2, rule: 'a', level: 'warning', message: 'early' }]), '${printed}');
  assert.equal(formatProblems('CHANGELOG.md', []), 'CHANGELOG.md: no problems found');
});${samples}
`;
}
const coreTests = (stage) => [
  'locate finds headings, entries and links with their line numbers',
  stage >= 4 ? 'errors come first, then problems in line order' : 'problems come out in line order',
  'formatProblems prints one line per problem',
  ...(stage >= 2 ? ['the sample changelogs have no errors'] : []),
];

// The rules are real functions here, so what the logs print is worked out from the code the
// branch commits: each rule's file holds its check's own source text (Function#toString).
// A test runs the branch's own tests and its lint command to keep the two in step.
const TYPES = new Set(['feat', 'fix', 'docs', 'perf', 'refactor', 'test', 'chore', 'build', 'ci']);
const isDay = (s) => {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return !!m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDate() === +m[3];
};
const cl = (...releases) => `# Changelog\n\n${releases.join('\n')}`;
const LINK_LANTERN = (from, to) => `https://github.com/example/lantern/compare/v${from}...v${to}`;

/** Each rule: its check, the case its test checks, and for some the mistake its sub-agent first
 *  makes ([right, wrong] in the rule's text) with the failure its test shows. `tdd` groups write
 *  each rule's test before the rule. */
const LINT_GROUPS = [
  {
    key: 'versions',
    exportName: 'versionRules',
    noun: 'version',
    agent: 'lintVersions',
    tdd: true,
    rules: [
      {
        id: 'version-shape',
        level: 'error',
        name: 'flags a heading that is not a version',
        input: cl('## [1.4] - 2025-03-01\n- feat: a\n'),
        lines: [3],
        check: ({ headings }) => headings
          .filter((h) => h.version !== 'Unreleased' && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(h.version))
          .map((h) => ({ line: h.line, message: `"${h.version}" is not a version like 1.4.0` })),
      },
      {
        id: 'duplicate-version',
        level: 'error',
        name: 'flags the second heading of one version and date',
        input: cl('## [1.2.0] - 2025-01-27\n- fix: a\n', '## [1.2.0] - 2025-01-27\n- fix: b\n'),
        lines: [6],
        check: ({ headings }) => {
          const seen = new Map();
          return headings.flatMap((h) => {
            const key = `${h.version} ${h.date}`;
            if (!seen.has(key)) return (seen.set(key, h.line), []);
            return [{ line: h.line, message: `${h.version} is already on line ${seen.get(key)}` }];
          });
        },
      },
      {
        id: 'version-order',
        level: 'error',
        name: 'reads 1.10.0 as newer than 1.9.0',
        input: cl('## [1.10.0] - 2025-03-01\n- feat: a\n', '## [1.9.0] - 2025-02-01\n- feat: b\n', '## [1.11.0] - 2025-01-01\n- feat: c\n'),
        lines: [9],
        check: ({ headings }) => {
          const parts = (v) => v.split(/[.-]/).slice(0, 3).map(Number);
          const newer = (a, b) => {
            const [x, y] = [parts(a), parts(b)];
            const i = x.findIndex((n, j) => n !== y[j]);
            return i !== -1 && x[i] > y[i];
          };
          const released = headings.filter((h) => h.version !== 'Unreleased');
          return released.slice(1).filter((h, i) => newer(h.version, released[i].version)).map((h) => ({ line: h.line, message: `${h.version} is newer than the release above it` }));
        },
        bug: { right: 'newer(h.version, released[i].version)', wrong: 'h.version > released[i].version', error: 'Expected values to be strictly deep-equal:\\n+ actual - expected\\n\\n  [\\n+   6\\n-   9\\n  ]', why: 'The order check compares version strings, so "1.9.0" > "1.10.0" as text: it flags the 1.9.0 heading and misses 1.11.0. Use the newer() helper that compares the numeric parts.' },
      },
      {
        id: 'unreleased-first',
        level: 'warning',
        name: 'wants Unreleased above every release',
        input: cl('## [1.3.0] - 2025-02-24\n- feat: a\n', '## [Unreleased]\n- feat: b\n'),
        lines: [6],
        check: ({ headings }) => headings.slice(1).filter((h) => h.version === 'Unreleased').map((h) => ({ line: h.line, message: 'Unreleased should be the first section' })),
      },
      {
        id: 'unreleased-date',
        level: 'error',
        name: 'flags a date on Unreleased',
        input: cl('## [Unreleased] - 2025-03-01\n- feat: a\n'),
        lines: [3],
        check: ({ headings }) => headings.filter((h) => h.version === 'Unreleased' && h.date).map((h) => ({ line: h.line, message: 'Unreleased has a date; give it a version or drop the date' })),
      },
    ],
  },
  {
    key: 'dates',
    exportName: 'dateRules',
    noun: 'date',
    agent: 'lintDates',
    head: `const isDay = ${isDay};\n\n`,
    rules: [
      {
        id: 'missing-date',
        level: 'warning',
        name: 'flags a release with no date',
        input: cl('## [1.3.0]\n- feat: a\n'),
        lines: [3],
        check: ({ headings }) => headings.filter((h) => h.version !== 'Unreleased' && !h.date).map((h) => ({ line: h.line, message: `${h.version} has no release date` })),
      },
      {
        id: 'date-format',
        level: 'error',
        name: 'flags a date that is not a real YYYY-MM-DD day',
        input: cl('## [1.3.0] - 2025-02-30\n- feat: a\n', '## [1.2.0] - 27/01/2025\n- feat: b\n'),
        lines: [3, 6],
        check: ({ headings }) => headings
          .filter((h) => h.date && !isDay(h.date))
          .map((h) => ({ line: h.line, message: `${h.date} is not a date like 2025-03-14` })),
        bug: { right: '!isDay(h.date)', wrong: '!/^\\d{4}-\\d{2}-\\d{2}$/.test(h.date)', error: 'Expected values to be strictly deep-equal:\\n+ actual - expected\\n\\n  [\\n+   6\\n-   3,\\n-   6\\n  ]', why: 'The pattern alone lets 2025-02-30 through. Check the day exists too: isDay() builds the date and compares the day of the month.' },
      },
      {
        id: 'date-order',
        level: 'error',
        name: 'flags a date later than the release above it',
        input: cl('## [1.3.0] - 2025-02-24\n- feat: a\n', '## [1.2.0] - 2025-03-01\n- feat: b\n'),
        lines: [6],
        check: ({ headings }) => {
          const dated = headings.filter((h) => h.date);
          return dated.slice(1).filter((h, i) => h.date > dated[i].date).map((h) => ({ line: h.line, message: `${h.date} is later than the release above it` }));
        },
      },
      {
        id: 'future-date',
        level: 'warning',
        name: 'flags a date after today',
        input: cl('## [1.4.0] - 2025-04-01\n- feat: a\n'),
        lines: [3],
        opts: ", today: '2025-03-11'",
        check: ({ headings, today }) => headings.filter((h) => h.date && h.date > today).map((h) => ({ line: h.line, message: `${h.date} is in the future` })),
      },
      {
        id: 'same-day',
        level: 'warning',
        name: 'flags two releases on one day',
        input: cl('## [1.3.1] - 2025-02-24\n- fix: a\n', '## [1.3.0] - 2025-02-24\n- feat: b\n'),
        lines: [6],
        check: ({ headings }) => {
          const dated = headings.filter((h) => h.date);
          return dated.slice(1).filter((h, i) => h.date === dated[i].date).map((h) => ({ line: h.line, message: `${h.version} has the same date as the release above it` }));
        },
      },
    ],
  },
  {
    key: 'entries',
    exportName: 'entryRules',
    noun: 'entry',
    agent: 'lintEntries',
    tdd: true,
    head: `const TYPES = new Set([${[...TYPES].map((t) => `'${t}'`).join(', ')}]);\n\n`,
    rules: [
      {
        id: 'unknown-type',
        level: 'warning',
        name: 'flags a type lantern does not know',
        input: cl('## [1.3.0] - 2025-02-24\n- feta: a typo\n- fix: b\n'),
        lines: [4],
        check: ({ entries }) => entries.filter((e) => e.type && !TYPES.has(e.type)).map((e) => ({ line: e.line, message: `"${e.type}" is not one of ${[...TYPES].join(', ')}` })),
      },
      {
        id: 'empty-scope',
        level: 'error',
        name: 'flags empty parentheses',
        input: cl('## [1.3.0] - 2025-02-24\n- feat(): a\n'),
        lines: [4],
        check: ({ entries }) => entries.filter((e) => e.scope !== null && !e.scope.trim()).map((e) => ({ line: e.line, message: 'the scope in () is empty' })),
      },
      {
        id: 'empty-release',
        level: 'warning',
        name: 'flags a release with no entries',
        input: cl('## [1.3.0] - 2025-02-24\n', '## [1.2.0] - 2025-01-27\n- fix: b\n'),
        lines: [3],
        check: ({ headings }) => headings.filter((h) => h.version !== 'Unreleased' && h.entries === 0).map((h) => ({ line: h.line, message: `${h.version} has no entries` })),
      },
      {
        id: 'trailing-period',
        level: 'warning',
        name: 'flags an entry that ends with a period',
        input: cl('## [1.3.0] - 2025-02-24\n- fix: keep entries that contain brackets.\n'),
        lines: [4],
        check: ({ entries }) => entries.filter((e) => /[^.]\.$/.test(e.text)).map((e) => ({ line: e.line, message: 'entries read as a list; drop the final period' })),
      },
      {
        id: 'duplicate-entry',
        level: 'warning',
        name: 'flags the same entry twice in one release',
        input: cl('## [1.3.0] - 2025-02-24\n- fix: keep brackets\n- fix: Keep brackets\n'),
        lines: [5],
        check: ({ headings, entries }) => {
          const seen = new Set();
          return entries.filter((e) => {
            const release = headings.filter((h) => h.line < e.line).pop().line;
            const key = `${release} ${e.text.toLowerCase()}`;
            return seen.has(key) || (seen.add(key), false);
          }).map((e) => ({ line: e.line, message: 'the same entry is already in this release' }));
        },
      },
    ],
  },
  {
    key: 'links',
    exportName: 'linkRules',
    noun: 'link',
    agent: 'lintLinks',
    tdd: true,
    rules: [
      {
        id: 'missing-compare-link',
        level: 'warning',
        name: 'flags a release with no link',
        input: cl('## [1.3.0] - 2025-02-24\n- feat: a\n'),
        lines: [3],
        check: ({ headings, links }) => headings.filter((h) => h.version !== 'Unreleased' && !links.some((l) => l.version === h.version)).map((h) => ({ line: h.line, message: `${h.version} has no compare link at the bottom of the file` })),
      },
      {
        id: 'unused-compare-link',
        level: 'warning',
        name: 'flags a link with no release',
        input: cl(`## [1.3.0] - 2025-02-24\n- feat: a\n\n[1.3.0]: ${LINK_LANTERN('1.2.0', '1.3.0')}\n[1.2.9]: ${LINK_LANTERN('1.2.8', '1.2.9')}\n`),
        lines: [7],
        check: ({ headings, links }) => links.filter((l) => !headings.some((h) => h.version === l.version)).map((l) => ({ line: l.line, message: `no release is called ${l.version}` })),
      },
      {
        id: 'link-repo-mismatch',
        level: 'error',
        name: 'flags links into two repositories',
        input: cl(`## [1.3.0] - 2025-02-24\n- feat: a\n\n[1.3.0]: ${LINK_LANTERN('1.2.0', '1.3.0')}\n[1.2.0]: https://github.com/example/beacon/compare/v1.1.0...v1.2.0\n`),
        lines: [7],
        check: ({ links }) => {
          const repo = (u) => u.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? null;
          const first = links.map((l) => repo(l.url)).find(Boolean);
          return links.filter((l) => repo(l.url) && repo(l.url) !== first).map((l) => ({ line: l.line, message: `links to ${repo(l.url)}, not ${first}` }));
        },
      },
      {
        id: 'compare-range',
        level: 'error',
        name: 'wants each range to start at the previous release',
        input: cl('## [1.3.0] - 2025-02-24\n- feat: a\n', `## [1.2.0] - 2025-01-27\n- fix: b\n\n[1.3.0]: ${LINK_LANTERN('1.1.0', '1.3.0')}\n[1.2.0]: ${LINK_LANTERN('1.1.0', '1.2.0')}\n`),
        lines: [9],
        check: ({ headings, links }) => {
          const released = headings.filter((h) => h.version !== 'Unreleased');
          return released.slice(0, -1).flatMap((h, i) => {
            const link = links.find((l) => l.version === h.version);
            const range = link?.url.match(/compare\/v?([^.]+\.[^.]+\.[^.]+)\.\.\.v?(.+)$/);
            const prev = released[i + 1].version;
            return range && range[1] !== prev ? [{ line: link.line, message: `${h.version} compares from ${range[1]}, not ${prev}` }] : [];
          });
        },
        bug: { right: 'released.slice(0, -1).flatMap(', wrong: 'released.flatMap(', error: "Cannot read properties of undefined (reading ''version'')", why: 'The last release has nothing below it, so released[i + 1] is undefined there. Check only the releases that have one below.' },
      },
      {
        id: 'http-link',
        level: 'warning',
        name: 'wants https links',
        input: cl(`## [1.3.0] - 2025-02-24\n- feat: a\n\n[1.3.0]: ${LINK_LANTERN('1.2.0', '1.3.0').replace('https:', 'http:')}\n`),
        lines: [6],
        check: ({ links }) => links.filter((l) => l.url.startsWith('http://')).map((l) => ({ line: l.line, message: 'use https:// for compare links' })),
      },
    ],
  },
];
/** git diff --stat while lint's edit to bin/lantern.mjs is its only change to a tracked file. */
const DIFF_STAT = ' bin/lantern.mjs | 7 +++++++\n 1 file changed, 7 insertions(+)';
const testName = (r) => `${r.id}: ${r.name}`;
/** A rule as its group's file writes it: the check's own source, indented for the file. */
const ruleBlock = (r) => `  {\n    id: '${r.id}',\n    level: '${r.level}',\n    check: ${String(r.check).replace(/\n {4}/g, '\n')},\n  }`;

function ruleFile(g, upTo, { buggy = false } = {}) {
  const blocks = g.rules.slice(0, upTo).map((r, i) => (buggy && i === upTo - 1 && r.bug ? ruleBlock(r).replace(r.bug.right, r.bug.wrong) : ruleBlock(r)));
  return `// The ${g.noun} rules for lantern lint.\n${g.head ?? ''}export const ${g.exportName} = [\n${blocks.join(',\n')},\n];\n`;
}
function ruleTests(g, upTo, { fixture = false } = {}) {
  const cases = g.rules.slice(0, upTo).map((r) => `test(${JSON.stringify(testName(r))}, () => {
  const found = lint(${JSON.stringify(r.input)}, { rules: ${g.exportName}${r.opts ?? ''} }).filter((p) => p.rule === '${r.id}');
  assert.deepEqual(found.map((p) => p.line), ${JSON.stringify(r.lines)});
});
`);
  const fx = fixture ? `
test('flags every ${g.noun} problem in the bad fixture', () => {
  const text = readFileSync(new URL('./fixtures/lint/${g.key}.md', import.meta.url), 'utf8');
  assert.deepEqual([...new Set(lint(text, { rules: ${g.exportName}, today: '2025-03-11' }).map((p) => p.rule))].sort(), ${JSON.stringify(g.rules.map((r) => r.id).sort())});
});
` : '';
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
${fixture ? "import { readFileSync } from 'node:fs';\n" : ''}import { lint } from '../src/lint.mjs';
import { ${g.exportName} } from '../src/rules/${g.key}.mjs';

${cases.join('\n')}${fx}`;
}
const ruleTestNames = (g, upTo, fixture = false) => [...g.rules.slice(0, upTo).map(testName), ...(fixture ? [`flags every ${g.noun} problem in the bad fixture`] : [])];
/** A changelog with one of each problem a group's rules look for. */
const BAD_FIXTURES = {
  versions: cl('## [1.10.0] - 2025-03-01\n- feat: a\n', '## [Unreleased] - 2025-02-15\n- feat: b\n', '## [1.9.0] - 2025-02-01\n- fix: c\n', '## [1.9.0] - 2025-02-01\n- fix: d\n', '## [1.11.0] - 2025-01-20\n- fix: e\n', '## [v1.0] - 2025-01-01\n- feat: f\n'),
  dates: cl('## [1.4.0] - 2025-04-01\n- feat: a\n', '## [1.3.0]\n- feat: b\n', '## [1.2.0] - 2025-02-30\n- fix: c\n', '## [1.1.0] - 2025-03-05\n- fix: d\n', '## [1.0.1] - 2025-03-05\n- fix: e\n'),
  entries: cl('## [1.3.0] - 2025-02-24\n- feta: a typo\n- feta: A typo\n- feat(): empty scope\n- fix: ends with a period.\n', '## [1.2.0] - 2025-01-27\n'),
  links: cl('## [1.3.0] - 2025-02-24\n- feat: a\n', '## [1.2.0] - 2025-01-27\n- fix: b\n', `## [1.1.0] - 2025-01-13\n- fix: c\n\n[1.3.0]: ${LINK_LANTERN('1.1.0', '1.3.0')}\n[1.2.0]: https://github.com/example/beacon/compare/v1.1.0...v1.2.0\n[1.0.9]: ${LINK_LANTERN('1.0.8', '1.0.9').replace('https:', 'http:')}\n`),
};

/** What the branch's lint finds and prints: stage 2 by line, stage 3 and on errors first with
 *  the level in each line (the same steps src/lint.mjs takes). */
const L_HEADING = /^## \[?([^\]\s]+)\]?(?: - (\S+))?\s*$/;
const L_ENTRY = /^- (?:(\w+)(?:\(([^)]*)\))?!?: )?(.+)$/;
const L_LINK = /^\[([^\]]+)\]: (\S+)$/;
function locateLines(text) {
  const headings = [];
  const entries = [];
  const links = [];
  text.split('\n').forEach((l, i) => {
    let m;
    if ((m = l.match(L_HEADING))) headings.push({ line: i + 1, version: m[1], date: m[2] ?? null, entries: 0 });
    else if ((m = l.match(L_LINK))) links.push({ line: i + 1, version: m[1], url: m[2] });
    else if ((m = l.match(L_ENTRY)) && headings.length) {
      headings[headings.length - 1].entries++;
      entries.push({ line: i + 1, type: m[1] ?? null, scope: m[2] ?? null, text: m[3] });
    }
  });
  return { headings, entries, links };
}
function lintOutput(file, text, { stage, rules = LINT_GROUPS.flatMap((g) => g.rules), today = '2025-03-11' }) {
  const ctx = { text, today, ...locateLines(text) };
  const found = rules.flatMap((r) => r.check(ctx).map((p) => ({ line: p.line, rule: r.id, level: r.level, message: p.message })));
  const byLine = (a, b) => a.line - b.line || a.rule.localeCompare(b.rule);
  found.sort(stage >= 3 ? (a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1) || byLine(a, b) : byLine);
  const text2 = found.length ? found.map((p) => `${file}:${p.line} ${stage >= 3 ? `${p.level} ` : ''}${p.rule} ${p.message}`).join('\n') : `${file}: no problems found`;
  return { found, text: text2, exit: stage >= 3 ? (found.some((p) => p.level === 'error') ? 1 : 0) : found.length ? 1 : 0 };
}
/** One rule run on its own test case, as `node -e` prints it. */
const tryRule = (r) => JSON.stringify(r.check({ text: r.input, today: '2025-03-11', ...locateLines(r.input) }));

const LINT_README = `
## Checking a changelog

\`lantern lint\` reads a CHANGELOG.md and lists anything that would spoil the release notes, one line each, so an editor can jump to it:

\`\`\`text
$ lantern lint CHANGELOG.md
{{example}}
\`\`\`

It exits with 1 when it finds an error and 0 when it finds only warnings, so it can gate a release script. The rules cover version headings (shape, duplicates, order, Unreleased first and undated), dates (missing, malformed, out of order, in the future, two on one day), entries (unknown types, empty scopes, empty releases, a trailing period, the same entry twice) and the compare links at the bottom of the file.
`;

/**
 * extraWeek(ctx) -> { monday, tuesday, wednesday, thursday, friday }
 *
 * `ctx` hands over what lib/demo/week.mjs builds the rest of the week with: the two log
 * classes, the lantern repository, the save functions, the session ids, and the content
 * helpers. Each day's function writes that day's extra sessions.
 */
export function extraWeek(ctx) {
  const { ClaudeLog, CodexLog, lantern, lanternDir, commits, saveClaude, saveAgent, saveCodex, committed, F, NAMES, bin, readme, changelog, pkg, tapReport, iso, prUrl, REMOTE, SLUG, ids, codexPatch, codexAddPatch, join } = ctx;
  const { SESSION_IDS: S, AGENT_IDS: A, PROJECT_DIRS: P, CODEX_IDS: X, days } = ids;
  const { MON, TUE, WED, THU, FRI } = days;
  const current = () => ctx.codexFormat() === 'current';
  const pushed = (branch) => ({ stderr: `To ${REMOTE}\n * [new branch]      ${branch} -> ${branch}\nbranch '${branch}' set up to track 'origin/${branch}'.`, git: { push: { branch } } });
  const repushed = (branch, from, to) => ({ stderr: `To ${REMOTE}\n   ${from}..${to}  ${branch} -> ${branch}`, git: { push: { branch } } });
  const worktree = (name, branch) => lantern.worktree(join(lanternDir, '.claude', 'worktrees', name), branch, 'main');
  /** A commit through a shell call, printed the way git prints it, for a Claude Code log. */
  const commitCall = (log, branch, files, message, cwd, { description = 'Commit on the branch', command } = {}) => {
    let made = null;
    log.bash(command ?? `git add -A && git commit -m "${message}"`, { description, ms: 900, run: ({ end }) => {
      made = lantern.commit(files, message, end, cwd);
      return { stdout: committed(branch, made, message), git: { commit: { sha: made.sha, kind: 'committed' } } };
    } });
    return made;
  };
  const codexCommit = (log, branch, files, message, cwd) => {
    let made = null;
    log.exec(`git add -A && git commit -m "${message}"`, { ms: 900, run: ({ end }) => {
      made = lantern.commit(files, message, end, cwd);
      return { out: `${committed(branch, made, message)}\n` };
    } });
    return made;
  };
  const MAIN_TUE = [...NAMES.filter, ...NAMES.format, ...NAMES.parse, ...NAMES.wide, ...NAMES.wrap];

  // ==== Monday ===================================================================
  function monday() {
    // ---- late morning: how a release is cut today (Codex, main checkout, read-only) ----
    if (current()) {
      const c = new CodexLog({ id: X.releaseFlow, cwd: lanternDir, day: MON, start: '10:41:06' });
      // main's tip at 10:41 is #12's squash; the checkout has moved on by the time this runs.
      c.meta({ git: { commit_hash: commits.pr12.sha, branch: 'main', repository_url: REMOTE } });
      c.context();
      c.turn(12400);
      c.user("How do I cut a lantern release today? Walk me through what's manual and what isn't. Don't change anything.");
      c.reason();
      c.exec('cat package.json', { ms: 60, out: pkg('1.3.0') });
      c.exec('git tag --list', { ms: 70, out: '' });
      c.exec('gh release list --limit 5', { ms: 1300, out: 'v1.3.0\tLatest\tv1.3.0\t2025-02-24T09:52:10Z\nv1.2.0\t\tv1.2.0\t2025-01-27T11:20:41Z\nv1.1.0\t\tv1.1.0\t2025-01-13T16:30:02Z\n' });
      c.exec('ls -a', { ms: 40, out: '.\n..\n.claude\n.git\n.gitignore\nCHANGELOG.md\nREADME.md\nbin\npackage.json\nsrc\ntest\n' });
      c.exec("sed -n '1,12p' CHANGELOG.md", { ms: 50, out: changelog(true).split('\n').slice(0, 12).join('\n') + '\n' });
      c.reason(2600);
      c.say("It's all manual. There are no git tags locally, so the releases exist only on GitHub: `gh release list` shows v1.3.0, v1.2.0 and v1.1.0. A release today is: bump `version` in package.json, move the entries under a new `## [x.y.z] - date` heading in CHANGELOG.md, merge that, then create the release on GitHub with `lantern` run against the changelog for its notes. Nothing checks the changelog before that, and nothing publishes the notes anywhere else.");
      c.done();
      saveCodex(c);
    }

    // ---- late morning: why the wrap test is slow (Claude Code, main checkout, read-only) ----
    const s = new ClaudeLog({ id: S.slowTest, cwd: lanternDir, branch: 'main', day: MON, start: '11:20:15', pace: 1.6 });
    s.prompt("test/wrap.test.mjs takes most of a second on my machine. Find out why, but don't change anything yet.");
    s.title('Find out why the wrap test is slow');
    s.read('test/wrap.test.mjs', F.testWrap);
    s.read('src/wrap.mjs', F.wrap, { gap: 1400 });
    s.bash('node --test test/wrap.test.mjs', { description: 'Time the wrap test', ms: 1100, stdout: tapReport({ tests: NAMES.wrap, ms: 912.6, seed: 'slow wrap' }) });
    const findPrompt = 'List every test under test/ that builds a large input (long strings, big arrays, repeated text) and roughly how big each input is. Do not edit files.';
    const a = s.agent({ description: 'Find tests with large inputs', type: 'Explore', prompt: findPrompt }, 2600);
    const sa = new ClaudeLog({ id: s.id, cwd: lanternDir, branch: 'main', day: MON, start: '11:21:00', agentId: A.slowInputs });
    sa.atMs(Date.parse(a.at) + 800);
    sa.delegated(findPrompt);
    sa.glob('test/**/*.test.mjs', ['test/filter.test.mjs', 'test/format.test.mjs', 'test/parse.test.mjs', 'test/wrap.test.mjs'], { gap: 1900 });
    sa.grep('repeat\\(|Array\\.from|fill\\(', { path: 'test', files: ['test/wrap.test.mjs'], gap: 2100 });
    sa.read('test/wrap.test.mjs', F.testWrap, { gap: 1700 });
    sa.read('test/format.test.mjs', F.testFormat, { gap: 1500 });
    const findReport = 'Only test/wrap.test.mjs builds anything sizeable, and it is small: the one test wraps a few sentences. No test repeats text or builds big arrays. Whatever takes the time is outside the test bodies.';
    sa.say(findReport, 5200);
    s.atMs(sa.t + 500);
    s.agentDone(a, { agentId: A.slowInputs, prompt: findPrompt, report: findReport, toolUses: 4 });
    saveAgent(P.lantern, sa, { agentType: 'Explore', description: 'Find tests with large inputs', toolUseId: a.id, spawnDepth: 1 });
    s.think("The test body is tiny, so the time is start-up: node --test spawns a process per file, and the first run also compiles the test runner. Time the bare process to check.", 2400);
    s.bash('node -e "console.time(\'start\'); console.timeEnd(\'start\')"', { description: 'Time a bare node start', ms: 90, stdout: 'start: 0.041ms' });
    s.bash('node --test test/wrap.test.mjs', { description: 'Time it again, warm', ms: 600, stdout: tapReport({ tests: NAMES.wrap, ms: 96.2, seed: 'slow wrap warm' }) });
    s.say("It isn't the test. The wrap test itself takes a few milliseconds; the first run you saw (912 ms) was node starting the test runner cold. Run again, the same file takes 96 ms, and no test in the suite builds a large input. Nothing to change in the code. If the cold start bothers you, running `node --test` once for the whole suite pays it once instead of per file.");
    s.turnEnd();
    s.prompt("Makes sense. Leave it as it is.", 96000);
    s.say('Leaving it. No changes made.', 1800);
    s.turnEnd();
    saveClaude(P.lantern, s);

    // ---- late afternoon: --since keeps Unreleased (Claude Code, a worktree) ----------
    const wt = worktree('since-unreleased', 'fix/since-unreleased');
    const u = new ClaudeLog({ id: S.sinceUnreleased, cwd: wt, branch: 'fix/since-unreleased', day: MON, start: '17:05:31', pace: 1.4 });
    u.mode('acceptEdits');
    u.prompt('With --since, an Unreleased section disappears because it has no date. Keep it whenever --since is a date, add a test, and push it on this branch.');
    u.title('Keep Unreleased when --since is a date');
    u.read('src/filter.mjs', F.filterTag);
    u.read('test/filter.test.mjs', F.testFilterTag, { gap: 1300 });
    const filterKeeps = F.filterTag.replace('r.date !== null && r.date >= since', "r.version === 'Unreleased' || (r.date !== null && r.date >= since)");
    u.edit('src/filter.mjs', F.filterTag, filterKeeps);
    const testKeeps = F.testFilterTag.replace("  { version: '1.3.0', date: '2025-02-24', entries: [] },", "  { version: 'Unreleased', date: null, entries: [] },\n  { version: '1.3.0', date: '2025-02-24', entries: [] },").split("['1.3.0', '1.2.0']);\n});\n").join("['Unreleased', '1.3.0', '1.2.0']);\n});\n") + "\ntest('keeps Unreleased for a date', () => {\n  assert.equal(filterSince(releases, '2025-03-01')[0].version, 'Unreleased');\n});\n";
    u.edit('test/filter.test.mjs', F.testFilterTag, testKeeps, { gap: 4800 });
    const filterNames = [...NAMES.filter, 'keeps Unreleased for a date'];
    u.bash('node --test test/filter.test.mjs', { description: 'Run the filter tests', ms: 700, stdout: tapReport({ tests: filterNames, ms: 71.4, seed: 'since unreleased' }) });
    u.bash('node --test', { description: 'Run the whole suite', ms: 1100, stdout: tapReport({ tests: [...NAMES.filter, 'keeps Unreleased for a date', ...NAMES.format, ...NAMES.parse, ...NAMES.wrap], ms: 233.8, seed: 'since unreleased all' }) });
    const msg = 'Keep the Unreleased section when --since is a date';
    commitCall(u, 'fix/since-unreleased', { 'src/filter.mjs': filterKeeps, 'test/filter.test.mjs': testKeeps }, msg, wt);
    u.bash('git push -u origin fix/since-unreleased', { description: 'Push the branch', ms: 1600, run: () => pushed('fix/since-unreleased') });
    u.say('--since with a date now keeps an Unreleased section, and a version tag still cuts the list at that release. The new test passes along with the rest of the suite (7 tests). Committed and pushed to fix/since-unreleased; no pull request yet.');
    u.turnEnd();
    saveClaude(P.sinceWorktree, u);
  }

  // ==== Tuesday ==================================================================
  function tuesday() {
    // ---- late morning: triage the open issues (Codex, main checkout, read-only) ------
    if (current()) {
      const c = new CodexLog({ id: X.triage, cwd: lanternDir, day: TUE, start: '11:10:22' });
      // main's tip at 11:10 is #13's squash; by the time this runs, the checkout is on the
      // afternoon's feature/bracketless-headings branch.
      c.meta({ git: { commit_hash: commits.pr13.sha, branch: 'main', repository_url: REMOTE } });
      c.context();
      c.turn(9800);
      c.user('Which of the open issues do the merged PRs already fix? Comment on each fixed one saying so, but leave closing them to me.');
      c.reason();
      c.exec('gh issue list --state open', { ms: 1200, out: '8\tOPEN\tWrapped lines are too wide with Japanese text\tbug\t2025-03-03T08:14:20Z\n7\tOPEN\tFilter releases by date\tenhancement\t2025-02-26T19:02:51Z\n5\tOPEN\tGroup entries by scope\tenhancement\t2025-02-11T10:45:09Z\n' });
      c.exec('gh issue view 8', { ms: 1000, out: "title:\tWrapped lines are too wide with Japanese text\nstate:\tOPEN\nlabels:\tbug\n--\nWith --width 40, lines of Japanese entries come out about twice as wide as the setting.\n" });
      c.exec('gh issue view 7', { ms: 1000, out: 'title:\tFilter releases by date\nstate:\tOPEN\nlabels:\tenhancement\n--\nIt would help to print only the releases since the last one I published.\n' });
      c.exec('git log --oneline -3 main', { ms: 80, run: () => ({ out: `${lantern.git(['log', '--oneline', '-3', 'main'])}\n` }) });
      c.reason(2200);
      c.exec('gh issue comment 8 --body "Fixed by #13, which measures wide characters by display width. It ships in 1.4."', { ms: 1400, out: `https://github.com/${SLUG}/issues/8#issuecomment-2718840212\n` });
      c.exec('gh issue comment 7 --body "Fixed by #12: lantern --since 2025-01-01 (or --since v1.2.0) prints only the releases on or after it. It ships in 1.4."', { ms: 1400, out: `https://github.com/${SLUG}/issues/7#issuecomment-2718841907\n` });
      c.say('Two of the three are fixed on main: #8 (wide lines with Japanese text) by #13, and #7 (filter by date) by #12. I commented on both saying so and that the fix ships in 1.4, and left them open for you to close. #5 (group by scope) is still open work; the branch for it was started this morning.');
      c.done();
      saveCodex(c);
    }

    // ---- lunchtime: do the README examples still match? (Claude Code, read-only) ------
    const r = new ClaudeLog({ id: S.readmeExamples, cwd: lanternDir, branch: 'main', day: TUE, start: '12:31:40', pace: 1.3 });
    r.prompt('Run every example in the README and tell me which ones no longer print what the README says.');
    r.title('Check the README examples against the CLI');
    r.read('README.md', readme({ since: true }));
    r.bash('npx lantern CHANGELOG.md | head -4', { description: 'Run the first example', ms: 1900, stdout: '1.3.0 (2025-02-24)\n- add --width to set the wrap column\n- keep entries that contain brackets\n' });
    r.bash('node bin/lantern.mjs CHANGELOG.md | head -4', { description: 'Run the example against the checkout', ms: 300, stdout: '1.3.0 (2025-02-24)\n- add --width to set the wrap column\n- keep entries that contain brackets\n' });
    r.bash('node bin/lantern.mjs --since 2025-02-01 CHANGELOG.md', { description: 'Try the --since option', ms: 300, stdout: '1.3.0 (2025-02-24)\n- add --width to set the wrap column\n- keep entries that contain brackets\n' });
    r.bash('node bin/lantern.mjs --since v1.2.0 --width 40 CHANGELOG.md', { description: 'Try --since with a tag and --width', ms: 300, stdout: '1.3.0 (2025-02-24)\n- add --width to set the wrap column\n- keep entries that contain brackets\n1.2.0 (2025-01-27)\n- wrap long entries\n- describe the release-notes\n  format\n' });
    r.say('All of them still match. The example output is the same from npx and from the checkout, and both options the README lists, --width and --since (with a date or a tag), behave as documented. The only thing worth a note: the README has no example for --since, so the option is described but never shown.');
    r.turnEnd();
    saveClaude(P.lantern, r);

    lint();
  }

  /** Tuesday afternoon: `lantern lint`, planned by the main agent and built by seven sub-agents. */
  function lint() {
    const wt = worktree('lint', 'feature/lint');
    const base = lantern.files(wt);
    // The person's five sample changelogs, copied in before the session and not yet committed.
    const samples = Object.fromEntries(FIXTURES.map((f) => [f.file, f.text]));
    lantern.edit(samples, wt);
    const s = new ClaudeLog({ id: S.lint, cwd: wt, branch: 'feature/lint', day: TUE, start: '15:12:30', base: 24_600, pace: 3 });
    s.mode('acceptEdits');
    s.prompt("I want a `lantern lint` command that checks a CHANGELOG.md before a release: versions in order and not repeated, dates that parse, entry types we know, compare links that match. I put five big sample changelogs in test/fixtures/changelogs/, and none of them should get an error. Plan it first, then split the rule work across sub-agents so the groups get written in parallel. Each rule needs a test.");
    s.title('Add a lint command that checks a changelog before a release');
    s.think('Start from what parse() gives: releases with version, date and entries, but no line numbers, and a lint needs lines. Look at the parser, the CLI, the tests and the samples before planning.', 2600);
    s.read('bin/lantern.mjs', base['bin/lantern.mjs'], { gap: 1800 });
    s.read('src/parse.mjs', base['src/parse.mjs'], { gap: 1400 });
    s.read('src/format.mjs', base['src/format.mjs'], { gap: 1300 });
    s.read('src/filter.mjs', base['src/filter.mjs'], { gap: 1200 });
    s.read('src/wrap.mjs', base['src/wrap.mjs'], { gap: 1100 });
    s.read('README.md', base['README.md'], { gap: 1300 });
    s.read('CHANGELOG.md', base['CHANGELOG.md'], { gap: 1500 });
    s.read('package.json', base['package.json'], { gap: 1200 });
    s.glob('test/**/*.test.mjs', ['test/filter.test.mjs', 'test/format.test.mjs', 'test/parse.test.mjs', 'test/wrap-wide.test.mjs', 'test/wrap.test.mjs'], { gap: 1600 });
    s.read('test/parse.test.mjs', base['test/parse.test.mjs'], { gap: 1300 });
    s.read('test/filter.test.mjs', base['test/filter.test.mjs'], { gap: 1200 });
    s.grep('process\\.exit|console\\.error', { path: 'src', files: [], gap: 1900 });
    s.bash('ls test/fixtures test/fixtures/changelogs', { description: 'See the fixtures', ms: 60, stdout: `test/fixtures:\nchangelogs\nwide.txt\n\ntest/fixtures/changelogs:\n${FIXTURES.map((f) => f.file.split('/').pop()).sort().join('\n')}` });
    s.say("I'll read the five samples whole, since they're what lint mustn't flag as errors.", 2100);
    for (const f of FIXTURES) s.read(f.file, f.text, { gap: 1700 });
    s.bash('node --version', { description: 'Check the Node version', ms: 40, stdout: 'v20.11.1' });
    s.bash('node --test', { description: 'Run the suite before changing anything', ms: 1200, stdout: tapReport({ tests: MAIN_TUE, ms: 241.7, seed: 'lint baseline' }) });
    s.say("Two things to pin down in parallel before writing anything: every changelog shape parse() accepts (so the rules don't flag what lantern reads fine), and how the CLI reports errors and exit codes today.", 2900);
    // Two Explore agents at once.
    const shapesPrompt = 'Work out every CHANGELOG.md shape src/parse.mjs accepts and what it does with each: headings with and without dates or brackets, entries with and without a type or scope, lines it ignores. Try each with node -e. Report a table of shapes and results. Do not edit files.';
    const errorsPrompt = 'Find how bin/lantern.mjs and src/ report errors and set exit codes today: what is printed, to which stream, and the exit code for a missing file and for a bad flag. Run the CLI to check. Do not edit files.';
    const e1 = s.agent({ description: 'Map the changelog shapes parse() accepts', type: 'Explore', prompt: shapesPrompt }, 2200);
    const e2 = s.agent({ description: 'Find how the CLI reports errors', type: 'Explore', prompt: errorsPrompt }, 600);
    const x1 = new ClaudeLog({ id: s.id, cwd: wt, branch: 'feature/lint', day: TUE, start: '15:12:30', agentId: A.lintShapes, pace: 3.6 });
    x1.atMs(Date.parse(e1.at) + 900);
    x1.delegated(shapesPrompt);
    x1.read('src/parse.mjs', base['src/parse.mjs'], { gap: 2000 });
    x1.read('test/parse.test.mjs', base['test/parse.test.mjs'], { gap: 1500 });
    x1.grep('## \\[', { path: 'test', files: ['test/fixtures/changelogs/driftwood.md', 'test/fixtures/changelogs/emberline.md', 'test/fixtures/changelogs/harbor-config.md', 'test/fixtures/changelogs/mossbank.md', 'test/fixtures/changelogs/quillpen.md', 'test/parse.test.mjs'], gap: 2100 });
    const tryParse = (input, out) => x1.bash(`node -e "import('./src/parse.mjs').then(({ parse }) => console.log(JSON.stringify(parse(${JSON.stringify(input).replace(/"/g, "'")}))))"`, { description: 'Try one changelog shape', ms: 240, gap: 2600, stdout: out });
    tryParse('## [1.4.0] - 2025-03-01\n- feat(cli): a\n', '[{"version":"1.4.0","date":"2025-03-01","entries":[{"type":"feat","scope":"cli","text":"a"}]}]');
    tryParse('## [Unreleased]\n- fix: b\n', '[{"version":"Unreleased","date":null,"entries":[{"type":"fix","scope":null,"text":"b"}]}]');
    tryParse('## 1.4.0 - 2025-03-01\n- feat: c\n', '[]');
    tryParse('## [1.4.0] - 03/01/2025\n- feat: d\n', '[{"version":"1.4.0","date":null,"entries":[{"type":"feat","scope":null,"text":"d"}]}]');
    tryParse('## [1.4.0]\nplain line\n- no prefix\n', '[{"version":"1.4.0","date":null,"entries":[{"type":null,"scope":null,"text":"no prefix"}]}]');
    tryParse('- before any heading\n## [1.0.0]\n', '[{"version":"1.0.0","date":null,"entries":[]}]');
    tryParse('## [1.4.0]\n- feat(cli)!: e\n', '[{"version":"1.4.0","date":null,"entries":[{"type":null,"scope":null,"text":"feat(cli)!: e"}]}]');
    tryParse('## [1.4.0] - 2025-03-01 (yanked)\n- g\n', '[{"version":"1.4.0","date":"2025-03-01","entries":[{"type":null,"scope":null,"text":"g"}]}]');
    tryParse('## [v1.4.0] - 2025-03-01\n- h\n', '[{"version":"v1.4.0","date":"2025-03-01","entries":[{"type":null,"scope":null,"text":"h"}]}]');
    tryParse('## [1.4.0]\n### Added\n- f\n', '[{"version":"1.4.0","date":null,"entries":[{"type":null,"scope":null,"text":"f"}]}]');
    const shapesReport = 'parse() accepts `## [x.y.z] - YYYY-MM-DD` (version and date), `## [x.y.z]` or a malformed date (date null), and `## [Unreleased]`. A heading without brackets is ignored entirely, and so are `### Section` lines, entries before the first heading and lines that do not start with "- ". An entry without a prefix keeps type and scope null; `feat(cli)!:` does not match the prefix and keeps its whole text. Lines are not tracked, so a lint has to find them itself. All five samples use bracketed headings with dates.';
    x1.say(shapesReport, 6400);
    const x2 = new ClaudeLog({ id: s.id, cwd: wt, branch: 'feature/lint', day: TUE, start: '15:12:30', agentId: A.lintErrors, pace: 3.2 });
    x2.atMs(Date.parse(e2.at) + 1100);
    x2.delegated(errorsPrompt);
    x2.read('bin/lantern.mjs', base['bin/lantern.mjs'], { gap: 2300 });
    x2.grep('throw new Error|process\\.exit|console\\.error', { path: '.', glob: '*.mjs', files: ['src/filter.mjs'], gap: 2100 });
    x2.read('src/filter.mjs', base['src/filter.mjs'], { gap: 1600 });
    x2.bash('node bin/lantern.mjs no-such-file.md; echo "exit $?"', { description: 'Run the CLI on a missing file', ms: 260, stdout: "node:fs:573\n  return binding.open(\n                 ^\n\nError: ENOENT: no such file or directory, open 'no-such-file.md'\n    at Object.openSync (node:fs:573:18)\nexit 1" });
    x2.bash('node bin/lantern.mjs --since v9.9.9 CHANGELOG.md; echo "exit $?"', { description: 'Run the CLI with an unknown tag', ms: 250, stdout: 'Error: lantern: no release named v9.9.9\n    at filterSince (src/filter.mjs:7:24)\nexit 1' });
    x2.bash('node bin/lantern.mjs --bogus CHANGELOG.md; echo "exit $?"', { description: 'Run the CLI with an unknown flag', ms: 250, stdout: "node:fs:573\n  return binding.open(\n                 ^\n\nError: ENOENT: no such file or directory, open '--bogus'\nexit 1" });
    x2.bash('node bin/lantern.mjs < CHANGELOG.md; echo "exit $?"', { description: 'Run the CLI with no file argument', ms: 240, stdout: '1.3.0 (2025-02-24)\n- add --width to set the wrap column\n- keep entries that contain brackets\n1.2.0 (2025-01-27)\n- wrap long entries\n- describe the release-notes format\n1.1.0 (2025-01-13)\n- read scopes from conventional-commit prefixes\nexit 0' });
    const errorsReport = 'There is no error handling of its own: every failure is an uncaught exception, printed with a stack trace on stderr, exit code 1. A missing file and an unknown --since tag both end that way, and an unknown flag is taken as the file name. Nothing exits 0 with a message, and nothing writes problems to stdout.';
    x2.say(errorsReport, 5900);
    for (const [call, sub, agentId, report, prompt, n] of [[e1, x1, A.lintShapes, shapesReport, shapesPrompt, 11], [e2, x2, A.lintErrors, errorsReport, errorsPrompt, 6]].sort((p, q) => p[1].t - q[1].t)) {
      s.atMs(sub.t + 500);
      s.agentDone(call, { agentId, prompt, report, toolUses: n });
    }
    saveAgent(P.lintWorktree, x1, { agentType: 'Explore', description: 'Map the changelog shapes parse() accepts', toolUseId: e1.id, spawnDepth: 1 });
    saveAgent(P.lintWorktree, x2, { agentType: 'Explore', description: 'Find how the CLI reports errors', toolUseId: e2.id, spawnDepth: 1 });
    s.think('lint needs its own line-aware pass (locate) next to parse(). Rules as plain objects with id, level and check(ctx) let four agents write them without touching each other: each owns src/rules/<group>.mjs and its test file, and lint.mjs only imports them.', 3400);
    s.say('Plan: `src/lint.mjs` finds each heading, entry and link with its line number and runs a list of rules over them; each rule is `{ id, level, check(ctx) }` returning `{ line, message }`. The rules come in four groups (versions, dates, entries, compare links), each in its own `src/rules/<group>.mjs` with its own test file, so four sub-agents can write them at once. `lantern lint [file]` prints one line per problem.', 3800);
    s.write('src/lint.mjs', lintCore(1), { gap: 9200 });
    s.write('test/lint.test.mjs', lintCoreTest(1), { gap: 7400 });
    s.bash('node --test test/lint.test.mjs', { description: 'Run the lint runner tests', ms: 700, stdout: tapReport({ tests: coreTests(1), ms: 64.9, seed: 'lint core' }) });
    const binLint1 = base['bin/lantern.mjs'].replace("import { format } from '../src/format.mjs';", "import { format } from '../src/format.mjs';\nimport { formatProblems, lint } from '../src/lint.mjs';");
    const binLint2 = binLint1.replace('const args = process.argv.slice(2);\n', "const args = process.argv.slice(2);\nif (args[0] === 'lint') {\n  const file = args[1] ?? 'CHANGELOG.md';\n  const problems = lint(readFileSync(file, 'utf8'));\n  console.log(formatProblems(file, problems));\n  process.exit(problems.length ? 1 : 0);\n}\n");
    s.edit('bin/lantern.mjs', base['bin/lantern.mjs'], binLint1, { gap: 4100 });
    s.edit('bin/lantern.mjs', binLint1, binLint2, { gap: 5200 });
    s.bash('node bin/lantern.mjs lint CHANGELOG.md', { description: 'Run lint with no rules yet', ms: 260, stdout: 'CHANGELOG.md: no problems found' });
    s.say('The runner, its three tests and the `lint` command are in, with no rules yet. Ready to hand the four rule groups to sub-agents: versions, dates, entries and compare links.', 2400);
    s.turnEnd();

    // ---- the four rule groups, in parallel -------------------------------------------------
    s.prompt('Plan looks right. Go ahead: one sub-agent per group, each writes its own tests, and keep rule ids unique across groups.', 118000);
    s.think('Four general-purpose agents, one message, so they run at once. Each gets the ctx shape, its group, and the file names it owns.', 2100);
    const plan = (done) => s.todos([['Write the version rules', 'Writing the version rules', done ? 'completed' : 'in_progress'], ['Write the date rules', 'Writing the date rules', done ? 'completed' : 'in_progress'], ['Write the entry rules', 'Writing the entry rules', done ? 'completed' : 'in_progress'], ['Write the compare-link rules', 'Writing the compare-link rules', done ? 'completed' : 'in_progress'], ['Register the rules and check the samples', 'Registering the rules', done ? 'completed' : 'pending']]);
    plan(false);
    const ctxNote = 'lint(text, { rules, today }) in src/lint.mjs calls each rule\'s check(ctx), where ctx has headings [{ line, version, date, entries }], entries [{ line, type, scope, text }], links [{ line, version, url }], releases (from parse()) and today (YYYY-MM-DD). A rule is { id, level: "error" | "warning", check(ctx) -> [{ line, message }] }.';
    const prompts = Object.fromEntries(LINT_GROUPS.map((g) => [g.key, `Write lantern lint's ${g.noun} rules in src/rules/${g.key}.mjs, exported as ${g.exportName}, with tests in test/lint-${g.key}.test.mjs: ${g.rules.map((r) => r.id).join(', ')}. ${ctxNote} Only touch your two files and a fixture under test/fixtures/lint/. Rule ids must be unique across groups. Run your tests and the whole suite before reporting.`]));
    const calls = LINT_GROUPS.map((g, i) => s.agent({ description: `Write the ${g.noun} rules`, type: 'general-purpose', prompt: prompts[g.key] }, i ? 500 : 2400));
    const subs = LINT_GROUPS.map((g, i) => ruleAgent(g, calls[i], { wt, prompt: prompts[g.key], base, index: i }));
    for (const { g, call, sub, report, toolUses } of [...subs].sort((p, q) => p.sub.t - q.sub.t)) {
      s.atMs(sub.t + 600);
      s.agentDone(call, { agentId: A[g.agent], prompt: prompts[g.key], report, toolUses });
      saveAgent(P.lintWorktree, sub, { agentType: 'general-purpose', description: `Write the ${g.noun} rules`, toolUseId: call.id, spawnDepth: 1 });
    }
    s.say('All four groups reported back. Reading what they wrote before wiring it in.', 2300);
    for (const g of LINT_GROUPS) s.read(`src/rules/${g.key}.mjs`, ruleFile(g, g.rules.length), { gap: 1700 });
    for (const g of LINT_GROUPS) s.read(`test/lint-${g.key}.test.mjs`, ruleTests(g, g.rules.length, { fixture: true }), { gap: 1400 });
    s.bash('git status --short', { description: 'See what the sub-agents wrote', ms: 90, stdout: ` M bin/lantern.mjs\n?? src/lint.mjs\n?? src/rules/\n?? test/fixtures/changelogs/\n?? test/fixtures/lint/\n${[...LINT_GROUPS].sort((a, b) => a.key.localeCompare(b.key)).map((g) => `?? test/lint-${g.key}.test.mjs`).join('\n')}\n?? test/lint.test.mjs` });
    s.edit('src/lint.mjs', lintCore(1), lintCore(2), { gap: 6100 });
    for (const g of LINT_GROUPS) s.bash(`node --test test/lint-${g.key}.test.mjs`, { description: `Run the ${g.noun} rule tests`, ms: 650, gap: 1900, stdout: tapReport({ tests: ruleTestNames(g, g.rules.length, true), ms: 70 + g.rules.length * 4.1, seed: `lint main ${g.key}` }) });
    for (const g of LINT_GROUPS) {
      const r = lintOutput(`test/fixtures/lint/${g.key}.md`, BAD_FIXTURES[g.key], { stage: 2 });
      s.bash(`node bin/lantern.mjs lint test/fixtures/lint/${g.key}.md; echo "exit $?"`, { description: `Lint the ${g.noun} fixture`, ms: 280, gap: 1600, stdout: `${r.text}\nexit ${r.exit}` });
    }
    const sampleRuns = [...FIXTURES].sort((a, b) => a.file.localeCompare(b.file)).map((f) => lintOutput(f.file, f.text, { stage: 2 }).text);
    s.bash('for f in test/fixtures/changelogs/*.md; do node bin/lantern.mjs lint "$f"; done', { description: 'Lint the five sample changelogs', ms: 1400, stdout: sampleRuns.join('\n') });
    s.edit('test/lint.test.mjs', lintCoreTest(1), lintCoreTest(2), { gap: 4600 });
    const ownLint = lintOutput('CHANGELOG.md', base['CHANGELOG.md'], { stage: 2 });
    s.bash('node bin/lantern.mjs lint CHANGELOG.md; echo "exit $?"', { description: "Lint lantern's own changelog", ms: 280, stdout: `${ownLint.text}\nexit ${ownLint.exit}` });
    const byFile = [...LINT_GROUPS].sort((a, b) => a.key.localeCompare(b.key));
    const allNames = (stage) => [...NAMES.filter, ...NAMES.format, ...byFile.flatMap((g) => ruleTestNames(g, g.rules.length, true)), ...coreTests(stage), ...NAMES.parse, ...NAMES.wide, ...NAMES.wrap];
    s.bash('node --test', { description: 'Run the whole suite', ms: 1600, stdout: tapReport({ tests: allNames(2), ms: 402.6, seed: 'lint all 1' }) });
    plan(true);
    const rules = LINT_GROUPS.reduce((n, g) => n + g.rules.length, 0);
    s.say(`All four groups are in: ${rules} rules, each with a test, plus a fixture per group with one of every problem it looks for, and a test that the five samples have no errors. The whole suite passes (${allNames(2).length} tests). On lantern's own CHANGELOG.md, lint finds ${ownLint.found.length} warnings: none of the releases has a compare link at the bottom of the file.`, 3600);
    s.turnEnd();

    // ---- exit codes and the output format: a failing run, then "All tests pass" --------------
    s.prompt("Errors should make lint exit 1, warnings shouldn't. Print each problem as file:line, then the level, the rule and the message, so an editor can jump to it. And list errors first.", 838000);
    s.read('bin/lantern.mjs', binLint2, { gap: 2100 });
    const binLint3 = binLint2.replace('process.exit(problems.length ? 1 : 0);', "process.exit(problems.some((p) => p.level === 'error') ? 1 : 0);");
    s.edit('bin/lantern.mjs', binLint2, binLint3, { gap: 3900 });
    s.edit('src/lint.mjs', lintCore(2), lintCore(3), { gap: 5600 });
    const failing = { 'problems come out in line order': 'Expected values to be strictly deep-equal:\\n+ actual - expected\\n\\n  [\\n+   9,\\n+   2\\n-   2,\\n-   9\\n  ]', 'formatProblems prints one line per problem': "Expected values to be strictly equal:\\n+ actual - expected\\n\\n+ ''CHANGELOG.md:2 warning a early''\\n- ''CHANGELOG.md:2 a early''" };
    s.bash('node --test', { description: 'Run the whole suite', ms: 1600, exit: 1, stdout: tapReport({ tests: allNames(2), failures: failing, ms: 411.2, seed: 'lint all 2' }) });
    s.bash('git diff --stat', { description: 'See what changed so far', ms: 90, stdout: DIFF_STAT });
    s.think('The format test still expects the old line. Update it to the new format.', 2300);
    s.edit('test/lint.test.mjs', lintCoreTest(2), lintCoreTest(3), { gap: 3100 });
    const datesRun = lintOutput('test/fixtures/lint/dates.md', BAD_FIXTURES.dates, { stage: 3 });
    s.bash('node bin/lantern.mjs lint test/fixtures/lint/dates.md; echo "exit $?"', { description: 'Check the exit code on errors', ms: 300, stdout: `${datesRun.text}\nexit ${datesRun.exit}` });
    const ownLint3 = lintOutput('CHANGELOG.md', base['CHANGELOG.md'], { stage: 3 });
    s.bash('node bin/lantern.mjs lint CHANGELOG.md; echo "exit $?"', { description: 'Check the exit code on warnings only', ms: 280, stdout: `${ownLint3.text}\nexit ${ownLint3.exit}` });
    s.bash('node --test', { description: 'Run the whole suite again', ms: 1600, exit: 1, stdout: tapReport({ tests: allNames(2), failures: { 'problems come out in line order': failing['problems come out in line order'] }, ms: 405.9, seed: 'lint all 3' }) });
    s.say('Done. lint now exits 1 when it finds an error and 0 when there are only warnings, lists errors first, and prints each problem as `file:line level rule message`. All tests pass.', 3300);
    s.turnEnd();

    s.prompt('All tests pass? The last run still had a failure: "problems come out in line order".', 61000);
    s.say("You're right, it didn't: that test still expects line order, and errors now come first. I'll update it to the new order.", 2600);
    s.read('test/lint.test.mjs', lintCoreTest(3), { gap: 1500 });
    s.edit('test/lint.test.mjs', lintCoreTest(3), lintCoreTest(4), { gap: 3600 });
    s.bash('node --test test/lint.test.mjs', { description: 'Run the lint runner tests', ms: 700, stdout: tapReport({ tests: coreTests(4), ms: 66.3, seed: 'lint core 2' }) });
    s.bash('node --test', { description: 'Run the whole suite', ms: 1600, stdout: tapReport({ tests: allNames(4), ms: 398.4, seed: 'lint all 4' }) });
    s.bash('node bin/lantern.mjs lint CHANGELOG.md; echo "exit $?"', { description: "Lint lantern's own changelog", ms: 280, stdout: `${ownLint3.text}\nexit ${ownLint3.exit}` });
    s.say(`Now the whole suite passes, ${allNames(4).length} of ${allNames(4).length}. Sorry for calling it done before the last run was clean.`, 2400);
    s.turnEnd();

    // ---- a review in the background while a sub-agent writes the docs -------------------------
    s.prompt('Good. Start a /review of the branch in the background, and meanwhile have a sub-agent write the README section for lint.', 132000);
    const launch = s.bash(`claude -p --session-id ${S.lintReview} "/review the lint branch against main"`, { description: 'Start a review run in the background', ms: 400, stdout: 'Command running in background with ID: c4m8q2' });
    const docsPrompt = 'Add a "Checking a changelog" section to README.md for `lantern lint`: what it checks, the output format (file:line level rule message), the exit codes (1 on an error, 0 on warnings only), and one example run. Check the example by running it. Only edit README.md.';
    const d1 = s.agent({ description: 'Write the README section for lint', type: 'general-purpose', prompt: docsPrompt, background: true }, 2200);
    s.result(d1.id, `Async agent launched successfully.\nagentId: ${A.lintDocs} (internal ID, do not mention it to the user)\nThe agent is working in the background. You will be notified when it completes.`, { ms: 500, tur: { isAsync: true, status: 'async_launched', agentId: A.lintDocs, description: 'Write the README section for lint', prompt: docsPrompt } });
    s.say("While the README section is written, I'll run every fixture and sample through lint once more in the new format.", 2400);
    const fixtureRuns = LINT_GROUPS.map((g) => lintOutput(`test/fixtures/lint/${g.key}.md`, BAD_FIXTURES[g.key], { stage: 3 })).map((r) => r.text);
    s.bash('for f in test/fixtures/lint/*.md; do node bin/lantern.mjs lint "$f"; done', { description: 'Lint the four bad fixtures', ms: 1100, stdout: [...fixtureRuns].sort().join('\n') });
    s.bash('for f in test/fixtures/changelogs/*.md; do node bin/lantern.mjs lint "$f"; done', { description: 'Lint the five sample changelogs', ms: 1400, stdout: [...FIXTURES].sort((a, b) => a.file.localeCompare(b.file)).map((f) => lintOutput(f.file, f.text, { stage: 3 }).text).join('\n') });
    s.say('Every fixture reports each of its problems once, errors first, and the five samples are still clean. The README section is on its way.', 2600);
    s.turnEnd();
    const docs = new ClaudeLog({ id: s.id, cwd: wt, branch: 'feature/lint', day: TUE, start: '15:12:30', agentId: A.lintDocs, pace: 4.2 });
    docs.atMs(Date.parse(d1.at) + 900);
    docs.delegated(docsPrompt);
    const readmeNow = base['README.md'];
    const example = cl('## [1.3.0] - 2025-02-24\n- feat: a\n', `## [1.2.0] - 2025-03-01\n- fix: b\n\n[1.2.0]: ${LINK_LANTERN('1.1.0', '1.2.0')}\n`);
    const scratch = 'test/fixtures/lint/readme-example.md';
    const exampleRun = lintOutput(scratch, example, { stage: 3 });
    const readmeLint = `${readmeNow.replace(/\n$/, '')}\n${LINT_README.replace('{{example}}', () => lintOutput('CHANGELOG.md', example, { stage: 3 }).text)}`;
    docs.read('README.md', readmeNow, { gap: 2100 });
    docs.read('src/lint.mjs', lintCore(3), { gap: 1800 });
    docs.read('bin/lantern.mjs', binLint3, { gap: 1600 });
    docs.read('src/rules/dates.mjs', ruleFile(LINT_GROUPS[1], LINT_GROUPS[1].rules.length), { gap: 1500 });
    docs.read('src/rules/links.mjs', ruleFile(LINT_GROUPS[3], LINT_GROUPS[3].rules.length), { gap: 1400 });
    docs.grep("id: '", { path: 'src/rules', files: LINT_GROUPS.map((g) => `src/rules/${g.key}.mjs`), gap: 2000 });
    docs.write(scratch, example, { gap: 5100 });
    docs.bash(`node bin/lantern.mjs lint ${scratch}; echo "exit $?"`, { description: 'Run the example for the README', ms: 300, stdout: `${exampleRun.text}\nexit ${exampleRun.exit}` });
    docs.bash(`rm ${scratch}`, { description: 'Remove the scratch example', ms: 60, stdout: '' });
    docs.edit('README.md', readmeNow, readmeLint, { gap: 8200 });
    const at = readmeLint.split('\n').findIndex((l) => l.startsWith('`lantern lint`')) + 1;
    docs.bash("grep -n 'lantern lint' README.md", { description: 'Check the section landed', ms: 60, stdout: `${at}:\`lantern lint\` reads a CHANGELOG.md and lists anything that would spoil the release notes, one line each, so an editor can jump to it:\n${at + 3}:$ lantern lint CHANGELOG.md` });
    docs.bash('node --test', { description: 'Run the whole suite', ms: 1600, stdout: tapReport({ tests: allNames(4), ms: 401.0, seed: 'lint docs' }) });
    const docsReport = 'Added "Checking a changelog" to README.md: what lint checks (the four groups), the file:line level rule message format, the exit codes, and an example whose output I checked by running it on a scratch changelog (since removed). The suite still passes.';
    docs.say(docsReport, 4800);
    s.notify(`<task-notification>\n<task-id>${A.lintDocs}</task-id>\n<tool-use-id>${d1.id}</tool-use-id>\n<status>completed</status>\n<summary>Agent "Write the README section for lint" completed</summary>\n<result>${docsReport}</result>\n</task-notification>`, Math.max(1000, docs.t + 1200 - s.t));
    saveAgent(P.lintWorktree, docs, { agentType: 'general-purpose', description: 'Write the README section for lint', toolUseId: d1.id, spawnDepth: 1, requestShape: 'background' });
    s.read('README.md', readmeLint, { gap: 1800 });
    s.say('The README now has a "Checking a changelog" section with a checked example.', 2600);
    s.turnEnd();
    // The person compacts before the commit.
    s.typed('compact', '', 64000);
    s.compact(`Summary of the earlier conversation: the user asked for \`lantern lint\`. src/lint.mjs locates headings, entries and links with line numbers and runs ${rules} rules from four groups (src/rules/versions.mjs, dates.mjs, entries.mjs, links.mjs), each written by a sub-agent with tests. lint prints \`file:line level rule message\`, errors first, and exits 1 only on errors. The five sample changelogs in test/fixtures/changelogs/ have no errors. A failing test was fixed after the user pointed it out; the suite passes (${allNames(4).length} tests). A review run is going in the background, and a sub-agent added a README section.`, { trigger: 'manual', gap: 300 });

    // ---- commit, push, open the pull request, watch CI ----------------------------------------
    s.prompt('Commit it on the branch, push, and open a PR.', 41000);
    s.bash('git status --short', { description: 'See what changed on the branch', ms: 90, stdout: ` M README.md\n M bin/lantern.mjs\n?? src/lint.mjs\n?? src/rules/\n?? test/fixtures/changelogs/\n?? test/fixtures/lint/\n${byFile.map((g) => `?? test/lint-${g.key}.test.mjs`).join('\n')}\n?? test/lint.test.mjs` });
    const lintFiles = { 'src/lint.mjs': lintCore(3), 'test/lint.test.mjs': lintCoreTest(4), 'bin/lantern.mjs': binLint3, 'README.md': readmeLint };
    for (const g of LINT_GROUPS) Object.assign(lintFiles, { [`src/rules/${g.key}.mjs`]: ruleFile(g, g.rules.length), [`test/lint-${g.key}.test.mjs`]: ruleTests(g, g.rules.length, { fixture: true }), [`test/fixtures/lint/${g.key}.md`]: BAD_FIXTURES[g.key] });
    const msg1 = 'Add lantern lint: version, date, entry and compare-link rules';
    const c1 = commitCall(s, 'feature/lint', lintFiles, msg1, wt);
    s.bash('git push -u origin feature/lint', { description: 'Push the branch', ms: 1700, run: () => pushed('feature/lint') });
    s.bash(`gh pr create --title "Add lantern lint" --body "Checks a CHANGELOG.md before a release: ${rules} rules in four groups, file:line output, exit 1 on errors only."`, { description: 'Open a pull request', ms: 2300, run: () => ({ stdout: prUrl(17), stderr: `\nCreating pull request for feature/lint into main in ${SLUG}\n`, git: { pr: { number: 17, url: prUrl(17), action: 'created' } } }) });
    s.prLink(17);
    s.bash('gh pr checks 17 --watch', { description: 'Wait for CI', ms: 142000, stdout: 'test (ubuntu-latest, 18)\tpass\t41s\ntest (ubuntu-latest, 20)\tpass\t38s\ntest (ubuntu-latest, 22)\tpass\t37s\ntest (windows-latest, 18)\tpass\t1m12s\ntest (windows-latest, 20)\tpass\t1m9s\ntest (windows-latest, 22)\tpass\t1m7s' });
    s.bash('gh pr view 17 --json state,mergeStateStatus --jq \'"\\(.state) \\(.mergeStateStatus)"\'', { description: 'Check #17', ms: 1000, stdout: 'OPEN CLEAN' });
    s.say(`Committed (${c1.short}), pushed feature/lint, and opened #17. CI is green on all six jobs.`, 2700);
    s.turnEnd();

    // ---- the review run's finding, fixed --------------------------------------------------------
    s.prompt('The review run found one real problem: duplicate-version misses a version repeated with a different date. Fix that with a test and push again.', 7200000);
    const versions = LINT_GROUPS[0];
    const fixedVersions = ruleFile(versions, versions.rules.length).replace('const key = `${h.version} ${h.date}`;', 'const key = h.version;');
    s.read('src/rules/versions.mjs', ruleFile(versions, versions.rules.length), { gap: 2000 });
    s.edit('src/rules/versions.mjs', ruleFile(versions, versions.rules.length), fixedVersions, { gap: 4200 });
    const versionsTest = ruleTests(versions, versions.rules.length, { fixture: true });
    const versionsTestFixed = `${versionsTest}\ntest('duplicate-version: flags a version repeated with another date', () => {\n  const found = lint(${JSON.stringify(cl('## [1.2.0] - 2025-01-27\n- fix: a\n', '## [1.2.0] - 2025-02-03\n- fix: b\n'))}, { rules: versionRules }).filter((p) => p.rule === 'duplicate-version');\n  assert.deepEqual(found.map((p) => p.line), [6]);\n});\n`;
    s.edit('test/lint-versions.test.mjs', versionsTest, versionsTestFixed, { gap: 5100 });
    const extraTest = 'duplicate-version: flags a version repeated with another date';
    s.bash('node --test test/lint-versions.test.mjs', { description: 'Run the version rule tests', ms: 650, stdout: tapReport({ tests: [...ruleTestNames(versions, versions.rules.length, true), extraTest], ms: 79.2, seed: 'lint versions fix' }) });
    const finalNames = allNames(4);
    finalNames.splice(finalNames.indexOf(ruleTestNames(versions, versions.rules.length, true).at(-1)) + 1, 0, extraTest);
    s.bash('node --test', { description: 'Run the whole suite', ms: 1600, stdout: tapReport({ tests: finalNames, ms: 409.3, seed: 'lint all 5' }) });
    const versionsRun = lintOutput('test/fixtures/lint/versions.md', BAD_FIXTURES.versions, { stage: 3 });
    s.bash('node bin/lantern.mjs lint test/fixtures/lint/versions.md; echo "exit $?"', { description: 'Lint the version fixture', ms: 280, stdout: `${versionsRun.text}\nexit ${versionsRun.exit}` });
    s.bash('node bin/lantern.mjs lint CHANGELOG.md', { description: "Lint lantern's own changelog", ms: 280, stdout: ownLint3.text });
    const msg2 = 'lint: flag a version repeated with a different date';
    const c2 = commitCall(s, 'feature/lint', { 'src/rules/versions.mjs': fixedVersions, 'test/lint-versions.test.mjs': versionsTestFixed }, msg2, wt);
    s.bash('git push', { description: 'Push the fix', ms: 1500, run: () => repushed('feature/lint', c1.short, c2.short) });
    s.bash('gh pr checks 17 --watch', { description: 'Wait for CI', ms: 128000, stdout: 'test (ubuntu-latest, 18)\tpass\t40s\ntest (ubuntu-latest, 20)\tpass\t39s\ntest (ubuntu-latest, 22)\tpass\t36s\ntest (windows-latest, 18)\tpass\t1m11s\ntest (windows-latest, 20)\tpass\t1m8s\ntest (windows-latest, 22)\tpass\t1m6s' });
    s.say(`duplicate-version now keys on the version alone, so 1.2.0 repeated with another date is flagged on its second heading. The new test passes with the rest of the suite (${finalNames.length} tests), and the fix is pushed to #17, where CI is green again.`, 2900);
    s.turnEnd();
    saveClaude(P.lintWorktree, s);

    // ---- the review run the session started ----------------------------------------------------
    const rv = new ClaudeLog({ id: S.lintReview, cwd: wt, branch: 'feature/lint', day: TUE, start: '15:12:30', pace: 2.2 });
    rv.atMs(Date.parse(launch.at) + 4200);
    rv.programCommand('review', 'the lint branch against main');
    rv.bash('git diff --stat', { description: 'See what the branch changes', ms: 140, stdout: DIFF_STAT });
    rv.bash('git status --short', { description: 'See the uncommitted work', ms: 90, stdout: ` M bin/lantern.mjs\n?? src/lint.mjs\n?? src/rules/\n?? test/fixtures/changelogs/\n?? test/fixtures/lint/\n${byFile.map((g) => `?? test/lint-${g.key}.test.mjs`).join('\n')}\n?? test/lint.test.mjs` });
    rv.read('src/lint.mjs', lintCore(3), { gap: 1900 });
    for (const g of LINT_GROUPS) rv.read(`src/rules/${g.key}.mjs`, ruleFile(g, g.rules.length), { gap: 1500 });
    rv.think('duplicate-version keys on version and date together, so the same version under two dates never collides. That is the case that matters most: a release re-cut on another day.', 2800);
    rv.bash(`node -e "import('./src/lint.mjs').then(({ lint }) => console.log(lint('## [1.2.0] - 2025-01-27\\n- fix: a\\n\\n## [1.2.0] - 2025-02-03\\n- fix: b\\n').filter((p) => p.rule === 'duplicate-version').length))"`, { description: 'Try a version repeated with another date', ms: 260, stdout: '0' });
    rv.bash('node --test', { description: 'Run the test suite', ms: 1500, stdout: tapReport({ tests: allNames(4), ms: 404.7, seed: 'lint review' }) });
    rv.say(`Review of the lint branch: one real problem. duplicate-version builds its key from the version and the date, so a version repeated under a different date (a release re-cut on another day) is never flagged; checked with a two-heading changelog, which gives no problem. Key on the version alone. Everything else reads right, and the suite passes (${allNames(4).length} tests).`, 3900);
    rv.turnEnd();
    saveClaude(P.lintWorktree, rv);
  }

  /** One rule group's sub-agent: it writes the rules one at a time (test first, for a `tdd`
   *  group), tries each on its own case, fixes the ones its tests catch, waits for the other
   *  groups' files to check ids don't clash, and runs the whole suite before reporting. */
  function ruleAgent(g, call, { wt, prompt, base, index }) {
    const sub = new ClaudeLog({ id: S.lint, cwd: wt, branch: 'feature/lint', day: TUE, start: '15:12:30', agentId: A[g.agent], pace: 7.5 + index * 0.9 });
    sub.atMs(Date.parse(call.at) + 900 + index * 300);
    sub.delegated(prompt);
    sub.read('src/lint.mjs', lintCore(1), { gap: 2000 });
    sub.read('src/parse.mjs', base['src/parse.mjs'], { gap: 1500 });
    sub.read('test/lint.test.mjs', lintCoreTest(1), { gap: 1600 });
    sub.read('CHANGELOG.md', base['CHANGELOG.md'], { gap: 1400 });
    sub.read('src/filter.mjs', base['src/filter.mjs'], { gap: 1300 });
    sub.read('test/filter.test.mjs', base['test/filter.test.mjs'], { gap: 1200 });
    sub.glob('src/rules/*.mjs', [], { gap: 1700 });
    sub.think(`Write the ${g.noun} rules one at a time, each with ${g.tdd ? 'its test first' : 'a test'}, and run the tests after each.`, 2600);
    const file = `src/rules/${g.key}.mjs`;
    const testFile = `test/lint-${g.key}.test.mjs`;
    let src = null;
    let test = null;
    let uses = 9;
    const run = (upTo, failures, i) => sub.bash(`node --test ${testFile}`, { description: `Run the ${g.noun} rule tests`, ms: 620, gap: 1900, ...(failures ? { exit: 1 } : {}), stdout: tapReport({ tests: ruleTestNames(g, upTo), failures: failures ?? {}, ms: 60 + i * 5.3, seed: `${g.key} ${i} ${failures ? 'fail' : 'pass'} ${upTo}` }) });
    g.rules.forEach((r, i) => {
      const next = ruleFile(g, i + 1, { buggy: true });
      const nextTest = ruleTests(g, i + 1);
      const writeTest = () => (test === null ? sub.write(testFile, nextTest, { gap: 6200 }) : sub.edit(testFile, test, nextTest, { gap: 4700 }));
      if (g.tdd) {
        // The test first: it fails until the rule exists.
        writeTest();
        if (src === null) sub.bash(`node --test ${testFile}`, { description: 'Run the new test before the rule exists', ms: 600, gap: 1800, exit: 1, stdout: `node:internal/modules/esm/resolve:275\n    throw new ERR_MODULE_NOT_FOUND(\n          ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '${file}' imported from ${testFile}\n${tapReport({ tests: [`${testFile}`], failures: { [testFile]: 'test failed' }, ms: 48.2, seed: `${g.key} missing` })}` });
        else sub.bash(`node --test --test-name-pattern="${r.id}" ${testFile}`, { description: 'Run the new test before the rule exists', ms: 600, gap: 1800, exit: 1, stdout: tapReport({ tests: [testName(r)], failures: { [testName(r)]: `Expected values to be strictly deep-equal:\\n+ actual - expected\\n\\n+ []\\n- ${JSON.stringify(r.lines)}` }, ms: 52.6, seed: `${g.key} ${i} first` }) });
        uses += 2;
      }
      if (src === null) sub.write(file, next, { gap: 7600 });
      else {
        sub.read(file, src, { gap: 1500 });
        sub.edit(file, src, next, { gap: 6400 });
        uses += 1;
      }
      sub.bash(`node --check ${file}`, { description: 'Check the syntax', ms: 150, gap: 1800, stdout: '' });
      if (!g.tdd) writeTest();
      uses += g.tdd ? 2 : 3;
      if (r.bug) {
        run(i + 1, { [testName(r)]: r.bug.error }, i);
        sub.think(r.bug.why, 2900);
        sub.read(file, next, { gap: 1400 });
        const fixed = ruleFile(g, i + 1);
        sub.edit(file, next, fixed, { gap: 4300 });
        src = fixed;
        uses += 3;
      } else {
        src = next;
      }
      run(i + 1, null, i);
      sub.bash(`node -e "import('./${file}').then(({ ${g.exportName} }) => import('./src/lint.mjs').then(({ locate }) => { const text = ${JSON.stringify(r.input).replace(/"/g, "'")}; console.log(JSON.stringify(${g.exportName}.find((x) => x.id === '${r.id}').check({ text, today: '2025-03-11', ...locate(text) }))); }))"`, { description: `Try ${r.id} on its case`, ms: 260, gap: 2100, stdout: tryRule(r) });
      uses += 2;
      test = nextTest;
      if (i < g.rules.length - 1) sub.say(`${r.id} passes. Next: ${g.rules[i + 1].id}.`, 2200);
      if (i === 2) {
        sub.bash('node --test', { description: 'Run the whole suite midway', ms: 1400, gap: 2000, stdout: tapReport({ tests: [...MAIN_TUE, ...coreTests(1), ...ruleTestNames(g, 3)], ms: 301.2 + index * 5, seed: `${g.key} midway` }) });
        uses += 1;
      }
    });
    // The entries agent's first try at the fixture test edits a line that isn't there.
    if (g.key === 'entries') {
      sub.editFail(testFile, "import { lint } from '../src/lint.mjs';\nimport { entryRules } from '../src/rules/entry.mjs';", "import { readFileSync } from 'node:fs';\nimport { lint } from '../src/lint.mjs';");
      sub.read(testFile, test, { gap: 1300 });
      uses += 2;
    }
    sub.write(`test/fixtures/lint/${g.key}.md`, BAD_FIXTURES[g.key], { gap: 5400 });
    sub.edit(testFile, test, ruleTests(g, g.rules.length, { fixture: true }), { gap: 4200 });
    sub.bash(`node --test ${testFile}`, { description: `Run the ${g.noun} rule tests`, ms: 640, gap: 1800, stdout: tapReport({ tests: ruleTestNames(g, g.rules.length, true), ms: 81.7, seed: `${g.key} fixture` }) });
    // Wait for the other groups' files, then check no rule id is used twice.
    const present = LINT_GROUPS.filter((x, j) => x === g || j < index || j === (index + 1) % LINT_GROUPS.length).map((x) => `${x.key}.mjs`).sort();
    sub.bash('sleep 30 && ls src/rules', { description: 'Wait for the other groups to land', ms: 30200, gap: 2200, stdout: present.join('\n') });
    sub.grep("id: '", { path: 'src/rules', files: present.map((f) => `src/rules/${f}`), gap: 1900 });
    sub.bash(`grep -rhoE "id: '[a-z-]+'" src/rules | sort | uniq -d`, { description: 'Look for a rule id used twice', ms: 80, gap: 1700, stdout: '' });
    const others = LINT_GROUPS.filter((x) => x !== g && present.includes(`${x.key}.mjs`));
    sub.bash('node --test', { description: 'Run the whole suite', ms: 1500, gap: 2400, stdout: tapReport({ tests: [...MAIN_TUE, ...coreTests(1), ...[g, ...others].flatMap((x) => ruleTestNames(x, x.rules.length, x === g))], ms: 330.5 + index * 7, seed: `${g.key} all` }) });
    uses += 7;
    const own = lintOutput('CHANGELOG.md', base['CHANGELOG.md'], { stage: 2, rules: g.rules });
    sub.bash(`node -e "Promise.all([import('./src/lint.mjs'), import('./${file}')]).then(([{ lint, formatProblems }, { ${g.exportName} }]) => console.log(formatProblems('CHANGELOG.md', lint(require('fs').readFileSync('CHANGELOG.md', 'utf8'), { rules: ${g.exportName} }))))"`, { description: "Run my rules on lantern's own changelog", ms: 280, gap: 2000, stdout: own.text });
    sub.bash('git status --short', { description: 'Check only my files changed', ms: 90, gap: 1600, stdout: `?? ${file}\n?? test/fixtures/lint/${g.key}.md\n?? ${testFile}` });
    uses += 1;
    const bug = g.rules.find((r) => r.bug);
    const report = `Wrote ${g.rules.length} ${g.noun} rules in ${file} (${g.rules.map((r) => r.id).join(', ')}), exported as ${g.exportName}, each with a test in ${testFile}, plus a fixture with one of every problem.${bug ? ` One test caught a mistake on the way: ${bug.bug.why}` : ''} No rule id clashes with the ${others.reduce((n, x) => n + x.rules.length, 0)} already in src/rules, and the whole suite passes. Not wired into lint.mjs: RULES is yours to update.`;
    sub.say(report, 5600);
    return { g, call, sub, report, toolUses: uses };
  }

  // ==== Wednesday ================================================================
  function wednesday() {
    // ---- lunchtime: a benchmark for parse() (Codex, its own worktree) ---------------
    if (current()) {
      const wt = worktree('parse-bench', 'perf/parse-bench');
      const c = new CodexLog({ id: X.parseBench, cwd: wt, day: WED, start: '13:05:18' });
      c.meta({ git: { commit_hash: lantern.head(wt).sha, branch: 'perf/parse-bench', repository_url: REMOTE } });
      c.context();
      c.turn(10600);
      c.user('How fast is parse() on a really big changelog, say 5,000 releases? Write a small benchmark script under bench/ (no dependencies), run it, and commit it on this branch.');
      c.reason();
      c.exec("sed -n '1,30p' src/parse.mjs", { ms: 50, out: F.parse });
      c.exec('ls', { ms: 40, out: 'CHANGELOG.md\nREADME.md\nbin\npackage.json\nsrc\ntest\n' });
      const benchSrc = "// How long parse() takes on a made-up changelog with many releases.\nimport { parse } from '../src/parse.mjs';\n\nconst releases = Number(process.argv[2] ?? 5000);\nconst text = ['# Changelog', ''];\nfor (let i = releases; i > 0; i--) text.push(`## [1.${i}.0] - 2025-01-01`, '- feat(cli): one change', '- fix(parse): another', '');\nconst source = text.join('\\n');\n\nconst runs = [];\nfor (let n = 0; n < 20; n++) {\n  const t = process.hrtime.bigint();\n  parse(source);\n  runs.push(Number(process.hrtime.bigint() - t) / 1e6);\n}\nruns.sort((a, b) => a - b);\nconsole.log(`${releases} releases, ${source.length} characters: median ${runs[10].toFixed(1)} ms, fastest ${runs[0].toFixed(1)} ms`);\n";
      c.patch(codexAddPatch('bench/parse.bench.mjs', benchSrc));
      c.exec('node bench/parse.bench.mjs', { ms: 4100, out: '5000 releases, 238894 characters: median 9.4 ms, fastest 8.7 ms\n' });
      c.exec('node bench/parse.bench.mjs 50000', { ms: 21800, out: '50000 releases, 2538894 characters: median 101.3 ms, fastest 96.0 ms\n' });
      c.reason(2400);
      const benchPkg = pkg('1.3.0').replace('"scripts": { "test": "node --test" }', '"scripts": { "test": "node --test", "bench": "node bench/parse.bench.mjs" }');
      c.patch(codexPatch('package.json', pkg('1.3.0'), benchPkg));
      c.exec('npm run bench --silent', { ms: 4300, out: '5000 releases, 238894 characters: median 9.6 ms, fastest 8.8 ms\n' });
      c.exec('node --test', { ms: 1200, out: tapReport({ tests: MAIN_TUE, ms: 236.1, seed: 'bench suite' }) });
      codexCommit(c, 'perf/parse-bench', { 'bench/parse.bench.mjs': benchSrc, 'package.json': benchPkg }, 'Add a parse() benchmark (npm run bench)', wt);
      c.exec('git push -u origin perf/parse-bench', { ms: 1500, out: `To ${REMOTE}\n * [new branch]      perf/parse-bench -> perf/parse-bench\n` });
      c.say("parse() is fast enough: 5,000 releases (about 240,000 characters) take a median of 9.4 ms, and ten times that takes about 100 ms, so it grows in a straight line. The script is bench/parse.bench.mjs, run with `npm run bench` (it takes an optional release count). The test suite still passes. Committed and pushed on perf/parse-bench.");
      c.done();
      saveCodex(c);
    }

    // ---- early afternoon: a quick question (Claude Code, main checkout) ---------------
    const q = new ClaudeLog({ id: S.longWord, cwd: lanternDir, branch: 'feature/bracketless-headings', day: WED, start: '14:20:44', pace: 1.5 });
    q.prompt('What does wrap() do with a single word longer than the width, like a long URL?');
    q.title('What wrap() does with a word longer than the width');
    q.read('src/wrap.mjs', F.wrapWide);
    q.bash(`node -e "import('./src/wrap.mjs').then(({ wrap }) => console.log(JSON.stringify(wrap('see https://github.com/example/lantern/pull/13 for the details', 20))))"`, { description: 'Wrap a line with a long URL', ms: 230, stdout: '"see\\n  https://github.com/example/lantern/pull/13\\n  for the details"' });
    q.say("It keeps the word whole on a line of its own and lets that line run past the width. wrap() only breaks between words, so `https://github.com/example/lantern/pull/13` at width 20 comes out as one 44-column line between `see` and `for the details`. Nothing is cut or hyphenated, which is what you want for a URL.");
    q.turnEnd();
    saveClaude(P.lantern, q);

    // ---- late afternoon: the 1.4 checklist (Claude Code, main checkout, read-only) ------
    const p = new ClaudeLog({ id: S.releasePlan, cwd: lanternDir, branch: 'docs/contributing', day: WED, start: '17:04:12', pace: 1.4 });
    p.prompt("Make me a checklist for releasing 1.4: what's merged, what's still open, and what's left to do. Just tell me, don't change anything.");
    p.title('Plan the 1.4 release');
    p.bash('git log --oneline main -6', { description: 'See what is on main', ms: 90, run: () => ({ stdout: lantern.git(['log', '--oneline', 'main', '-6']) }) });
    p.bash('gh pr list --state open', { description: 'List the open pull requests', ms: 1200, stdout: `17\tAdd lantern lint\tfeature/lint\tOPEN\n` });
    p.bash('git branch --list', { description: 'List local branches', ms: 70, stdout: '* docs/contributing\n  feature/bracketless-headings\n  feature/group-by-scope\n  feature/lint\n  feature/markdown-output\n  feature/since-flag\n  feature/wide-chars\n  fix/since-unreleased\n  main\n  perf/parse-bench' });
    p.read('CHANGELOG.md', changelog(true), { gap: 1900 });
    p.say('For 1.4:\n\nMerged on main: --since (#12) and display-width wrapping (#13).\n\nOpen or in progress: lint (#17, CI green, review fix pushed), grouping by scope (feature/group-by-scope, no PR yet), Markdown output (feature/markdown-output, worked on today), bracketless headings and the Unreleased fix for --since (pushed, no PRs), and the contributing guide (docs/contributing).\n\nLeft to do: decide which of those go in 1.4, open PRs for the pushed branches, add an Unreleased section to CHANGELOG.md, bump package.json to 1.4.0, then tag and publish the release notes.');
    p.turnEnd();
    saveClaude(P.lantern, p);
  }

  // ==== Thursday =================================================================
  function thursday() {
    // ---- late morning: edge-case tests for filterSince (Codex, its own worktree) -----
    if (current()) {
      const wt = worktree('filter-tests', 'test/filter-edges');
      const c = new CodexLog({ id: X.filterTests, cwd: wt, day: THU, start: '11:24:40' });
      c.meta({ git: { commit_hash: lantern.head(wt).sha, branch: 'test/filter-edges', repository_url: REMOTE } });
      c.context();
      c.turn(8900);
      c.ide('test/filter.test.mjs', "Add tests for filterSince's edge cases: a date before every release, a date after every release, a tag without the v, and Unreleased with no date. Don't change src/.");
      c.reason();
      c.exec("sed -n '1,40p' src/filter.mjs", { ms: 50, out: F.filterTag });
      c.exec("sed -n '1,60p' test/filter.test.mjs", { ms: 50, out: F.testFilterTag });
      const edges = "\ntest('a date before every release keeps them all', () => {\n  assert.equal(filterSince(releases, '2024-01-01').length, 3);\n});\n\ntest('a date after every release keeps none', () => {\n  assert.deepEqual(filterSince(releases, '2026-01-01'), []);\n});\n\ntest('a tag without the v works too', () => {\n  assert.deepEqual(filterSince(releases, '1.2.0').map((r) => r.version), ['1.3.0', '1.2.0']);\n});\n";
      const withEdges = `${F.testFilterTag}${edges}`;
      c.patch(codexPatch('test/filter.test.mjs', F.testFilterTag, withEdges));
      const names = [...NAMES.filter, 'a date before every release keeps them all', 'a date after every release keeps none', 'a tag without the v works too'];
      c.exec('node --test test/filter.test.mjs', { ms: 700, out: tapReport({ tests: names, ms: 74.8, seed: 'filter edges' }) });
      c.reason(2100);
      c.say('Added three edge-case tests, and all six filter tests pass. I left out Unreleased with no date: on main, --since drops a release without a date, and the fix that keeps Unreleased is on its own branch (fix/since-unreleased), so a test for it belongs there. Nothing is committed yet.');
      c.done();
      c.turn(41000);
      c.user('Commit and push them.');
      c.reason(1300);
      c.exec('node --test', { ms: 1100, out: tapReport({ tests: [...names, ...NAMES.format, ...NAMES.group, ...NAMES.parse, ...NAMES.wide, ...NAMES.wrap], skipped: ['every wrapped line fits the width'], ms: 268.2, seed: 'filter edges all' }) });
      codexCommit(c, 'test/filter-edges', { 'test/filter.test.mjs': withEdges }, "Test filterSince's edge cases", wt);
      c.exec('git push -u origin test/filter-edges', { ms: 1500, out: `To ${REMOTE}\n * [new branch]      test/filter-edges -> test/filter-edges\n` });
      c.say('Committed and pushed on test/filter-edges. The whole suite passes.');
      c.done();
      saveCodex(c);
    }

    // ---- afternoon: an announcement draft, shown not written (Claude Code) -------------
    const n = new ClaudeLog({ id: S.announcement, cwd: lanternDir, branch: 'main', day: THU, start: '14:06:20', pace: 1.5 });
    n.prompt("Draft a short announcement for lantern 1.4 that I can paste into the release page. Just show it to me here, don't write a file.");
    n.title('Draft the 1.4 announcement');
    n.read('CHANGELOG.md', changelog(true));
    n.read('README.md', readme({ since: true, group: true }), { gap: 1500 });
    n.say("Here's a draft:\n\nlantern 1.4 is out. You can now print only what's new with `--since` (a date or a tag), group each release's entries by scope with `--group-by-scope`, and wrapped lines finally measure Japanese, Korean and emoji by how wide they look, not how many characters they have. Thanks to everyone who reported the wrapping bug!");
    n.turnEnd();
    n.prompt('Shorter, and no exclamation marks.', 52000);
    n.say("lantern 1.4: `--since` prints only releases after a date or tag, `--group-by-scope` groups entries by scope, and wrapping now measures wide characters correctly. Thanks to everyone who reported the wrapping bug.", 2600);
    n.turnEnd();
    saveClaude(P.lantern, n);
  }

  // ==== Friday ===================================================================
  function friday() {
    // ---- mid-morning: a review of #15 before it merges (Claude Code, main checkout) ----
    const v = new ClaudeLog({ id: S.reviewPr15, cwd: lanternDir, branch: 'main', day: FRI, start: '10:21:30', pace: 1.4 });
    v.prompt('Review #15 before I merge it. Read the diff, check it runs, and leave a comment on the PR with anything that needs fixing.');
    v.title('Review #15 before merging');
    v.bash('gh pr view 15 --json title,headRefName,additions,deletions --jq \'"\\(.title) (\\(.headRefName)): +\\(.additions) -\\(.deletions)"\'', { description: 'Look at #15', ms: 1100, stdout: 'Add a JSON output mode (feature/json-output): +38 -2' });
    v.bash('gh pr diff 15 --name-only', { description: 'List the files #15 changes', ms: 900, stdout: 'bin/lantern.mjs\nsrc/json.mjs\ntest/json.test.mjs' });
    v.bash('git show feature/json-output:src/json.mjs', { description: 'Read the new module', ms: 90, stdout: F.jsonKeyed.replace(/\n$/, '') });
    v.bash('git show feature/json-output:test/json.test.mjs', { description: 'Read its tests', ms: 90, stdout: F.testJsonKeyed.replace(/\n$/, '') });
    v.grep('engines', { glob: 'package.json', files: ['package.json'], gap: 2100 });
    v.think('json.mjs groups with Object.groupBy, which arrived in Node 21. package.json says engines node >=18, so on 18 and 20 toJson throws a TypeError. CI runs 18, 20 and 22.', 3100);
    v.bash('gh pr checks 15', { description: 'Check CI on #15', ms: 1200, stdout: 'test (ubuntu-latest, 18)\tfail\t39s\ntest (ubuntu-latest, 20)\tfail\t36s\ntest (ubuntu-latest, 22)\tpass\t35s\ntest (windows-latest, 18)\tfail\t1m10s\ntest (windows-latest, 20)\tfail\t1m8s\ntest (windows-latest, 22)\tpass\t1m6s' });
    v.bash('gh pr review 15 --comment --body "toJson uses Object.groupBy, which Node 18 and 20 don\'t have, and package.json promises Node 18. CI fails on both. A small loop that groups by scope would fix it, plus a test for an empty changelog."', { description: 'Comment on #15', ms: 1600, stdout: '' });
    v.say("Don't merge #15 yet. It groups entries with `Object.groupBy`, which only exists from Node 21, while package.json says Node 18 and up. CI agrees: the Node 18 and 20 jobs fail on both systems and only 22 passes. I left a review comment saying so, with the fix (group with a small loop) and a test for an empty changelog.");
    v.turnEnd();
    saveClaude(P.lantern, v);
  }

  return { monday, tuesday, wednesday, thursday, friday };
}
