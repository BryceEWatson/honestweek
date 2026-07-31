# Implementation brief: build one phase

You are implementing a phase of the prompt-lanes feature in honestweek. You write code and tests.
You do **not** own git: no branches, no commits, no PRs. The orchestrator does that, and runs the
suite itself before it believes anything.

## Read first

1. `AGENTS.md` — hard constraints and the invariants that must not break.
2. `.claude/work/prompt-lanes/spec-v2/decisions.md` — the 79 settled cross-phase decisions, across
   six addenda. Read D50 to D79: several **reverse** an earlier decision in the same file, and the
   later one wins.
3. `.claude/work/prompt-lanes/spec-v2/phase-<N>.md` — **your** phase spec. This is the contract.
4. `.claude/work/prompt-lanes/spec-v2/phase-assignment.md` — what is yours and what is not, plus the
   four decisions that deliberately bind no phase.

## What this feature does not contain

The redact-before-truncate reorder in `lib/claude-adapter.mjs` is **not** part of any phase here
(D61). It changes existing draft bytes with no lane input present, so it is not additive, and it
ships as its own issue and pull request before Phase 1. If your phase spec seems to ask for it, the
spec is stale: stop and say so. Inside this feature, redaction runs before truncation on the new
fields only.

## Build

Every requirement `R<k>` in your phase spec, and every acceptance criterion `A<k>` as a real test.

## Rules

1. **Zero runtime dependencies.** Node built-ins plus the system `git` CLI. No package, no lockfile,
   no `npm install` step. CI installs nothing.
2. **Node >= 18 APIs only.** CI runs the suite on Node 18, 20 and 22.
3. **Cross-platform.** CI is ubuntu, development is Windows. Never hardcode a path separator;
   normalize before comparing paths.
4. **Clean-room.** No real name, real absolute path, real repo name, real email or codename anywhere
   in the repo. Examples use `you@example.com`, `/path/to/your/repo`, `your-project`.
5. **Run the suite** with `node --test` from the repository root, **with no path argument**
   (`node --test test/` fails: Node reads it as a module specifier). Baseline before your phase is
   stated in your prompt. Report the exact new count.
6. **Do not weaken an existing test to make a new one pass.** If an existing test genuinely must
   change, say which, why, and what the new assertion proves, in your final message. The orchestrator
   treats a silently relaxed test as a failed phase.
7. **Do not touch `.git`.** Your sandbox denies it anyway.
8. **Do not implement another phase's work.** If your phase needs something `phase-assignment.md`
   assigns elsewhere, stop and say so rather than building it.
9. **Public-facing prose** (README, SKILL.md, AGENTS.md, `--help`, plugin manifests) clears the
   repo's voice bar: **no em dash and no ` -- `**, no marketing tone, first person with
   contractions, the point stated first. Recast a scope-and-qualify clause as a colon, a
   parenthetical, or a second sentence; keep the move, drop the glyph. Define a term the first time
   you use it. This applies to every line you add to those files, including a table cell.

## Report back

Your final message is read by the orchestrator, not a human. Give it:

- The exact `node --test` tail: pass, fail, and total counts.
- Every file you created or modified.
- Every acceptance criterion `A<k>` from your phase spec, each marked `done` with the test name that
  proves it, or `not done` with the reason. Do not mark one done because the code looks right; mark
  it done because a test asserts it and that test passed.
- Anything you could not do, and why. An honest gap is useful; a silent one wastes a review cycle.
