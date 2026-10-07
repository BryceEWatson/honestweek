#!/usr/bin/env node
// bin/honestweek.mjs — thin subcommand dispatcher.
//
// This file ONLY routes. Each subcommand's logic lives in a lib/<cmd>.mjs
// module that default-exports `async function run(args)`. Handlers are imported
// LAZILY via dynamic import() so the dispatcher never statically depends on a
// module that another issue has not built yet — `--help` works from a fresh
// clone with zero modules present.

import { setConfigLookup } from '../lib/config-lookup.mjs';
import { commandForm, setCommandForm } from '../lib/invocation.mjs';

const SUBCOMMANDS = ['init', 'discover', 'build', 'validate', 'harvest', 'preview', 'prompts', 'digest', 'mine', 'history', 'view', 'status'];

// Subcommands that parse `--help` themselves and print their own richer text.
// Everything else is served by COMMAND_HELP below, BEFORE the handler is
// imported, because asking for help must never read a session log or write a file.
const SELF_HELP = new Set(['prompts', 'digest', 'preview', 'mine', 'view']);

const COMMAND_HELP = {
  init: `honestweek init: set up honestweek.config.json in this folder.

Usage:
  honestweek init [--yes] [--force] [--user | --config <file>]

Finds your git email and the git repositories in this folder and the folders
next to it, folding each extra working copy (a git worktree) into its main
repository. It shows the list so you can keep or drop repositories by number
('keep 1-5 9', 'drop 3 7-9') or change a role ('role 2 display'), then asks for
people's names and client or project words to keep private (you can skip
both). It reads back the words it'll store, and writes nothing until you've
said yes twice. Then it writes honestweek.config.json, drops
honestweek.config.example.json if absent, and adds the config and honestweek's
private files to .gitignore, since the config holds your email and folder
paths. If it finds no repositories, it writes nothing. Answers piped in on
stdin work, one per line.

With --user it writes ~/.honestweek/honestweek.config.json instead, the config
every command reads from a folder that has none of its own, so an agent working
in any project finds it.

Options:
  -y, --yes   Accept the inferred defaults without prompting. Use this when no
              one is there to answer (scripts, CI, or an agent shell): if stdin
              ends before the confirmations are answered, init exits 2 and
              writes nothing. On its own --yes leaves an existing config alone.
      --force With --yes, overwrite an existing honestweek.config.json.
      --user  Write the user-level config, ~/.honestweek/honestweek.config.json.
      --config <file>
              Write this file instead. It must be called honestweek.config.json.
  -h, --help  Show this help.
`,
  discover: `honestweek discover: read the last completed week into a redacted draft.

Usage:
  honestweek discover [--week <YYYY-Www>] [--config <file>]

Scans the allowlisted repos' sessions and .claude/handoffs/*.md, then writes the
gitignored, redacted honestweek.draft.json beside the config. Deterministic: no
model call. 'display'-role repos are never read.

Options:
      --week <YYYY-Www>  Report on a specific ISO week instead of the last
                         completed one.
      --config <file>    Read this config instead of the one honestweek finds.
  -h, --help             Show this help.
`,
  validate: `honestweek validate: gate the distilled items before building.

Usage:
  honestweek validate [--no-dashes] [--config <file>]

Checks honestweek.items.json: every item needs a valid badge and a receipt, no
item may name a 'display'-role repo or cite a commit against one, and no
configured redaction term may survive into the prose.

Exits 2 when any check fails, naming the offending item.

Options:
      --no-dashes      Also apply the optional voice rule (no em dashes).
      --config <file>  Read this config instead of the one honestweek finds.
  -h, --help           Show this help.
`,
  build: `honestweek build: verify every git-checkable claim, then emit.

Usage:
  honestweek build [--config <file>]

Re-derives every cited commit against your real git history. Aborts with exit 2,
writing nothing, if a cited commit is unresolved, its author is outside
identity.authorEmails, or the repo has no determinable default branch (so
whether a commit landed cannot be checked). On success, renders output.mode to
output.file.

A 'shipped' item whose commits are real but have not landed on the default
branch is not an abort: it keeps its receipt and is downgraded to 'in progress',
announced on stderr.

The week comes from honestweek.items.json, which discover stamped. To build a
different week, re-run discover with --week and redo the distillation. Mode
"client" instead reports on the items file's "period", any length you name.

Options:
      --config <file>  Read this config instead of the one honestweek finds.
  -h, --help           Show this help.
`,
  status: `honestweek status: where the weekly summary stands, read-only.

Usage:
  honestweek status [--json] [--config <file>]

Says which config it found and where, the last completed week, whether the
draft and the items exist and which week each covers, whether the items pass
validate's item gate, whether the output is built and when, and the next step
as a command.
It writes nothing, runs no git, and always exits 0: a missing or broken file is
a line in the report. It prints names, weeks, counts and states, never an
item's text or anything from a session. The weekly skill loads it first.

Options:
      --json           Print the report as JSON.
      --config <file>  Read this config instead of the one honestweek finds.
  -h, --help           Show this help.
`,
  history: `honestweek history: list what reached the default branch in a period.

Usage:
  honestweek history --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--config <file>]

The raw material for a client report (output.mode "client"). For each featured
and reference repo, lists every pull request you authored that landed on the
default branch in the period, plus commits that landed without one, and writes
them to the gitignored honestweek.history.json. Only counts are printed.
'display'-role repos are never read.

Group those into items in honestweek.items.json, each citing its commits, set
"period" to the same dates, then run validate and build.

Options:
      --from <YYYY-MM-DD>  First day of the period.
      --to <YYYY-MM-DD>    Last day of the period (inclusive).
      --config <file>      Read this config instead of the one honestweek finds.
  -h, --help               Show this help.
`,
  harvest: `honestweek harvest: propose redaction-denylist candidates.

Usage:
  honestweek harvest [--config <file>]

Reads honestweek.draft.json (run discover first) and writes candidate private
nouns, most frequent first, to the gitignored honestweek.harvest.json. Only the
count is printed; the nouns stay local for you to review and add to your
config's redaction lists: "names" for people, "terms" for clients and projects.

Options:
      --config <file>  Read this config instead of the one honestweek finds.
  -h, --help           Show this help.
`,
};

const wantsHelp = (args) => args.some((a) => a === '--help' || a === '-h');

/** The top-level help. `cmd` is the command as the person typed it (lib/invocation.mjs). */
function usage(cmd) {
  return `honestweek: find, check and replay your AI coding sessions, and turn a week of
them into an honest, git-verified summary.

Start here:
  1. Look around a made-up week first. It sets nothing up:
       ${cmd} view --demo
  2. Set up honestweek.config.json in this folder. It asks before writing:
       ${cmd} init
     Add --user to set it up once for every folder.
  3. Find, check and replay your own sessions in your browser:
       ${cmd} view

Usage:
  ${cmd} <command> [options]

Commands:
  init        Set up honestweek.config.json from your git setup. It asks
              before writing.
  discover    Read the last completed week's sessions into a redacted draft.
  prompts     Sync, review, control, and curate private Claude Code and Codex
              prompts for the existing weekly page.
  digest      Prepare, inspect, and control a balanced six-category weekly
              digest for the existing weekly page.
  validate    Gate the distilled items: valid badge + receipt, no display-repo
              leak, no private term in prose (run before build). Add --no-dashes
              for the optional voice rule.
  build       Verify every git-checkable claim, then emit the configured output.
  harvest     Propose redaction-denylist candidates from the draft to a
              gitignored sidecar (count only to stdout). Tighten privacy.
  preview     Render the built Markdown output as HTML and serve it on a
              local-only (127.0.0.1) server, then open your browser. Add
              --port <n> or --no-open. A local viewer; publishes nothing.
  mine        Find sessions where software you did NOT write failed and you
              worked out the fix, rank them, and keep a ledger of what is still
              undecided. Add --draft to write the top one up as a post.
  history     List the pull requests you landed in a period (--from, --to), the
              raw material for a client report. Writes a gitignored sidecar.
  status      Say where the weekly summary stands and what to run next.
              Reads only; always exits 0.
  view        Find, check and replay your agent work in your browser, on a
              local-only (127.0.0.1) page. Add --demo to look around a made-up
              week first. Publishes nothing.

Options:
  -h, --help  Show this help.

Every command reads honestweek.config.json in the folder it runs in, else the
file the HONESTWEEK_CONFIG environment variable names, else
~/.honestweek/honestweek.config.json. --config <file> names one instead. Each
says which it read in one line on stderr, and writes its files beside it.

Run "${cmd} <command> --help" for command-specific help (where available).
`;
}

function printUsage(stream = process.stdout) {
  stream.write(usage(commandForm()));
}

async function main(argv) {
  const [command, ...rest] = argv;
  // Messages that name a next step name it the way this run was started.
  setCommandForm(commandForm());
  // A command run from a folder with no config of its own finds the one in HONESTWEEK_CONFIG or
  // the user-level file, and says which config it read.
  setConfigLookup({ env: process.env });

  if (command === undefined || command === '--help' || command === '-h') {
    printUsage(process.stdout);
    return 0;
  }

  if (!SUBCOMMANDS.includes(command)) {
    process.stderr.write(`honestweek: unknown command "${command}".\n\n`);
    printUsage(process.stderr);
    return 1;
  }

  // Serve help before the handler is imported. `honestweek discover --help`
  // must print help, not scan a week of session logs; `honestweek harvest
  // --help` must not write a file.
  if (!SELF_HELP.has(command) && wantsHelp(rest) && COMMAND_HELP[command]) {
    process.stdout.write(COMMAND_HELP[command]);
    return 0;
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
