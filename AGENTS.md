# AGENTS.md

Conventions for coding agents working in this repository. Read this before changing anything.

## What honestweek is

honestweek turns a completed week of AI coding sessions into an honest, git-verified,
private-by-default work summary. It reads local session transcripts, distils a week into reviewable
items, re-derives every git-checkable claim against real commits, and produces a draft the user
publishes themselves. It never auto-publishes.

The product's value is that it refuses to state anything it cannot back. A change that makes the
tool faster, prettier, or more featureful at the cost of that guarantee is a regression, not a
tradeoff.

## Hard constraints

- **Zero runtime dependencies.** Node built-ins plus the system `git` CLI only. Do not add a
  package, a lockfile, or an `npm install` step. CI installs nothing.
- **Node >= 18.** CI runs the suite on Node 18, 20, and 22. Do not use an API newer than Node 18.
- **Cross-platform.** CI runs on ubuntu; development happens on Windows. Never hardcode a path
  separator, and normalize before comparing paths.
- **No network egress.** No telemetry, no fetch, no outbound calls. The optional `preview` server
  binds to loopback only.
- **Clean-room.** No real names, paths, repo names, author emails, or codenames anywhere in the
  repo. Examples use generic placeholders (`you@example.com`, `/path/to/your/repo`, `your-project`).

## Tests

```bash
node --test
```

Run it from the repository root, with no path argument (passing `test/` fails: Node treats it as a
module specifier). `npm test` runs the same thing. Every change ships with tests, and the suite must
be green before you report the work done.

## Invariants that must not break

1. **A receipt on every line.** Every emitted item points to its source, a commit SHA or a session
   turn. An item reaching a renderer without a receipt is a build error.
2. **Verify or abort.** `build` re-derives every cited commit and exits 2, writing nothing, if one
   is unresolved or was not authored by a configured identity. There is no half-true output.
3. **Under-claim by default.** When evidence is mixed or ambiguous, choose the weaker badge. Never
   assert a motive, cause, or outcome the log does not contain.
4. **`display`-role repos are never git-read.** There must be no code path that runs `git` against
   one.
5. **Redact before disk.** Every string reaching a written artifact has passed the redactor.
6. **New output is additive.** Absent its new inputs, existing output stays byte-identical. This is
   how the goals page was added, and it is the pattern to follow.

## Prose and documentation

Public-facing text (README, SKILL.md, plugin manifests, `--help`) clears a published voice bar: no
em dashes, no marketing tone, first person with contractions, the point stated first. Define a term
the first time you use it rather than assuming the reader knows it.

PR and issue bodies open with an "In plain terms" section of two to four sentences that a
non-implementer can read cold, then what the reader is being asked to decide. File paths, SHAs,
flags, and line references belong at the bottom under an "Implementation detail" heading.

## Git workflow

- Branch from `main` as `feature/<description>`.
- One pull request per issue, squash-merged.
- Never commit secrets, debug code, or scratch files.
- Do not publish a release, push a tag, or run `npm publish`. Those are the operator's calls.
