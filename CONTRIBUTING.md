# Contributing to honestweek

honestweek reads your local AI coding session logs and turns them into accounts of your work that never claim more than the logs and git can back. I welcome contributions, from people and from coding agents. This page covers what you need to know before you open an issue or a pull request.

## The one rule that decides most reviews

honestweek's value is that it refuses to state anything it can't back. A change that makes it faster, prettier or more featureful at the cost of that guarantee is a regression, not a tradeoff. When evidence is mixed, the weaker claim wins.

## Getting set up

You need Node 18 or later and `git` on your `PATH`. There's nothing to install:

```bash
git clone https://github.com/BryceEWatson/honestweek.git
cd honestweek
node --test
```

Run `node --test` from the repository root with no path argument (passing `test/` fails, because Node treats it as a module name). `npm test` runs the same thing. CI runs the suite on Node 18, 20 and 22, on Linux, and development happens on Windows too, so a change has to work on both.

## The constraints every change keeps

[`AGENTS.md`](AGENTS.md) is the full list, written for coding agents but meant for everyone. In short:

- **Zero runtime dependencies.** Node built-ins and the system `git` only. No package, no lockfile, no install step.
- **No network calls.** No telemetry, no fetch. Two commands start a small local server, and both bind to `127.0.0.1` only: `preview`, which shows your built output, and `view`, a page for finding and replaying your sessions.
- **Node 18 APIs only**, and no hardcoded path separators.
- **Redact before disk.** honestweek's redactor scrubs secrets, personal paths and any terms you list. Every string that reaches a written file passes through it first.
- **Display-only repositories never reach `git`.** A repository you mark `display` in your config gets a generic summary, and no code path runs `git` against it.
- **New output is additive.** Without its new inputs, existing output stays byte-identical.
- **Clean-room.** No real names, paths, repository names, emails or codenames anywhere in the repo. Examples use placeholders like `you@example.com` and `/path/to/your/repo`.

## Tests

Every change ships with tests, and the suite has to be green before review. Tests run over synthetic fixtures (for example `test/fixtures/replay/corpus.mjs` for the work-history engine). Please don't add real session logs to the repo, even redacted ones: build a synthetic line with the same shape instead. Test the failure path next to the success path. If you add a rule that interprets a record, add a case where the rule should not fire.

## Writing

Public text (the README, `SKILL.md`, `--help`, docs) is written in plain first person with contractions, states the point first, and defines a term the first time it's used. No em dashes, no marketing tone.

Pull request bodies open with an **In plain terms** section of two to four sentences that someone who doesn't read code can follow, then **What you're deciding**: what merging changes and what it doesn't touch. File paths, commit ids, flags and line references go at the bottom under **Implementation detail**. The pull request template sets this up for you. Issues open with **In plain terms** too; the issue templates ask for the rest.

## Pull requests

- Branch from `main` as `feature/<short-description>`.
- One pull request per issue. I squash-merge them.
- No secrets, debug code or scratch files.
- Releases, tags and npm publishing are the maintainer's call; please don't include version bumps.

## Reporting a bug without leaking your logs

Session logs hold your prompts, file paths and sometimes secrets. Don't paste a real transcript into an issue. Describe the record's shape (its `type` and which fields it has), or write a synthetic line that reproduces the problem. The bug report template walks through this.

## Security

If you find a way honestweek could send data off your machine, write an unredacted secret to an output file, run `git` against a display-only repository, or expose the `preview` or `view` server beyond your own machine, please report it privately as described in [`SECURITY.md`](SECURITY.md) rather than in a public issue.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
