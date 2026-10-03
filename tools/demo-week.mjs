#!/usr/bin/env node
// tools/demo-week.mjs: the command line for the synthetic demo week.
//
//   node tools/demo-week.mjs <out-dir>
//
// writes the week into <out-dir> (which must be empty or not exist yet) and prints the
// paths and the date range as JSON. The builder itself lives in lib/demo/week.mjs, so
// `honestweek view --demo` can use it from the published package; this file re-exports
// it, so code that imported it from here keeps working.

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildDemoWeek } from '../lib/demo/week.mjs';

export * from '../lib/demo/week.mjs';

const USAGE = `demo-week: write a synthetic week of session logs, a git repository, and a goal record.

Usage:
  node tools/demo-week.mjs <out-dir>

<out-dir> must be empty or not exist yet. Prints the paths and the date range as JSON.
`;

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [out, ...rest] = argv;
  if (!out || out === '-h' || out === '--help' || rest.length) {
    (out === '-h' || out === '--help' ? io.out : io.err)(USAGE);
    return out === '-h' || out === '--help' ? 0 : 1;
  }
  const root = resolve(out);
  if (existsSync(root) && readdirSync(root).length) {
    io.err(`demo-week: ${root} is not empty; choose a new folder.\n`);
    return 1;
  }
  let d;
  try {
    d = buildDemoWeek({ root });
  } catch (err) {
    const lines = String(err?.message ?? err).trim().split('\n').filter((l) => l.trim());
    const reason = lines[lines.length - 1] ?? 'unknown error';
    // Git for Windows caps a repository's own path near 260 characters, and the week's
    // worktrees sit four folders below <out-dir>.
    const tooLong = /too (big|long)|ENAMETOOLONG/i.test(String(err?.message ?? ''));
    io.err(`demo-week: could not write the week into ${root}: ${reason.trim()}\n`);
    io.err(err?.leftBehind ? `Some files may be left in ${root}; delete that folder before trying again.\n` : 'Nothing was left behind.\n');
    if (tooLong) io.err('The folder path is too long for git. Choose a shorter one, such as C:\\demo-week on Windows.\n');
    return 1;
  }
  io.out(`${JSON.stringify({ root: d.root, from: d.week.from, to: d.week.to, timezone: d.week.timezone, config: d.configFile, goals: d.goalsFile, roots: d.roots, repo: d.repo.dir, displayRepo: d.displayRepo.dir, outsideDir: d.outsideDir }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`demo-week: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
