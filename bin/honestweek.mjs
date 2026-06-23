#!/usr/bin/env node
// bin/honestweek.mjs — thin subcommand dispatcher.
//
// This file ONLY routes. Each subcommand's logic lives in a lib/<cmd>.mjs
// module that default-exports `async function run(args)`. Handlers are imported
// LAZILY via dynamic import() so the dispatcher never statically depends on a
// module that another issue has not built yet — `--help` works from a fresh
// clone with zero modules present.

const SUBCOMMANDS = ['init', 'discover', 'build'];

const USAGE = `honestweek — honest, git-verified weekly summaries from your AI coding sessions.

Usage:
  honestweek <command> [options]

Commands:
  init        Scaffold honestweek.config.json (two-confirmation setup).
  discover    Read the last completed week's sessions into a redacted draft.
  build       Verify every git-checkable claim, then emit the configured output.

Options:
  -h, --help  Show this help.

Run "honestweek <command> --help" for command-specific help (where available).
`;

function printUsage(stream = process.stdout) {
  stream.write(USAGE);
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    printUsage(process.stdout);
    return 0;
  }

  if (!SUBCOMMANDS.includes(command)) {
    process.stderr.write(`honestweek: unknown command "${command}".\n\n`);
    printUsage(process.stderr);
    return 1;
  }

  let mod;
  try {
    mod = await import(new URL(`../lib/${command}.mjs`, import.meta.url));
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      process.stderr.write(
        `honestweek: the "${command}" command is not yet implemented in this build.\n`
      );
      return 1;
    }
    throw err;
  }

  const run = mod.default ?? mod.run;
  if (typeof run !== 'function') {
    process.stderr.write(
      `honestweek: the "${command}" handler does not export a run() function.\n`
    );
    return 1;
  }

  const code = await run(rest);
  return typeof code === 'number' ? code : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`honestweek: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
