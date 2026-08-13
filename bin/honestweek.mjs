#!/usr/bin/env node
// bin/honestweek.mjs — thin subcommand dispatcher.
//
// This file ONLY routes. Each subcommand's logic lives in a lib/<cmd>.mjs
// module that default-exports `async function run(args)`. Handlers are imported
// LAZILY via dynamic import() so the dispatcher never statically depends on a
// module that another issue has not built yet — `--help` works from a fresh
// clone with zero modules present.

const SUBCOMMANDS = ['init', 'discover', 'build', 'validate', 'harvest', 'preview', 'prompts', 'digest', 'mine'];

// Subcommands that parse `--help` themselves and print their own richer text.
// Everything else is served by COMMAND_HELP below, BEFORE the handler is
// imported, because asking for help must never read a session log or write a file.
const SELF_HELP = new Set(['prompts', 'digest', 'preview', 'mine']);

const COMMAND_HELP = {
  init: `honestweek init: scaffold honestweek.config.json.

Usage:
  honestweek init [--yes] [--force]

Infers your identity and repo allowlist from local git state, then asks for two
confirmations before writing. Writes honestweek.config.json, drops
honestweek.config.example.json if absent, and adds honestweek's generated files
to .gitignore.

Options:
  -y, --yes   Accept the inferred defaults without prompting. Use this when no
              one is there to answer (scripts, CI, or an agent shell): if stdin
              ends before the confirmations are answered, init exits 2 and
              writes nothing. On its own --yes leaves an existing config alone.
      --force With --yes, overwrite an existing honestweek.config.json.
  -h, --help  Show this help.
`,
  discover: `honestweek discover: read the last completed week into a redacted draft.

Usage:
  honestweek discover [--week <YYYY-Www>]

Scans the allowlisted repos' sessions and .claude/handoffs/*.md, then writes the
gitignored, redacted honestweek.draft.json. Deterministic: no model call.
'display'-role repos are never read.

Options:
      --week <YYYY-Www>  Report on a specific ISO week instead of the last
                         completed one.
  -h, --help             Show this help.
`,
  validate: `honestweek validate: gate the distilled items before building.

Usage:
  honestweek validate [--no-dashes]

Checks honestweek.items.json: every item needs a valid badge and a receipt, no
item may name a 'display'-role repo or cite a commit against one, and no
configured redaction term may survive into the prose.

Exits 2 when any check fails, naming the offending item.

Options:
      --no-dashes  Also apply the optional voice rule (no em dashes).
  -h, --help       Show this help.
`,
  build: `honestweek build: verify every git-checkable claim, then emit.

Usage:
  honestweek build

Re-derives every cited commit against your real git history. Aborts with exit 2,
writing nothing, if a cited commit is unresolved, its author is outside
identity.authorEmails, or the repo has no determinable default branch (so
whether a commit landed cannot be checked). On success, renders output.mode to
output.file.

A 'shipped' item whose commits are real but have not landed on the default
branch is not an abort: it keeps its receipt and is downgraded to 'in progress',
announced on stderr.

The week comes from honestweek.items.json, which discover stamped. To build a
different week, re-run discover with --week and redo the distillation.

Options:
  -h, --help  Show this help.
`,
  harvest: `honestweek harvest: propose redaction-denylist candidates.

Usage:
  honestweek harvest

Reads honestweek.draft.json and writes candidate private nouns to the
gitignored honestweek.harvest.json. Only the count is printed; the nouns stay
local for you to review and promote into your config's redaction lists.

Options:
  -h, --help  Show this help.
`,
};

const wantsHelp = (args) => args.some((a) => a === '--help' || a === '-h');

const USAGE = `honestweek: honest, git-verified weekly summaries from your AI coding sessions.

Usage:
  honestweek <command> [options]

Commands:
  init        Scaffold honestweek.config.json (two-confirmation setup).
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
