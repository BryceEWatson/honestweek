# Authoring brief: write one phase spec

You are writing an implementation spec that another agent will build from **without access to this
conversation**. It must stand alone.

## Read first, in this order

1. `.claude/work/prompt-lanes/spec-v2/decisions.md` — **authoritative**. 36 settled decisions.
2. `.claude/work/prompt-lanes/spec-v2/phase-assignment.md` — which decision lands in which phase.
3. `AGENTS.md` — the repo's hard constraints and invariants.
4. `.claude/work/prompt-lanes/items.md` — the 55 revision items that killed the previous spec.
   Read the ones whose `phase=` field overlaps yours. They are the defect record, not instructions:
   `decisions.md` already resolves every one of them. Read them to understand **what went wrong**,
   then make sure your spec cannot repeat it.
5. The **previous** spec for context only: `.claude/work/prompt-lanes/spec/phase-1.json`,
   `phase-2.json`, `phase-3.json`, `cross-cutting.json`. It was decomposed 1/2/3 and that
   decomposition is **rejected** (see D1). Where the old spec conflicts with `decisions.md`,
   `decisions.md` wins, always, with no exceptions and no "the old spec had a point" hedging.
6. The actual source files you cite. **Read every line you reference.**

## Write

`.claude/work/prompt-lanes/spec-v2/phase-<N>.md`, in this shape:

```
# Phase <N>: <title>

## In plain terms
4-6 sentences, no jargon, subject named in the first line, readable cold by a non-programmer.

## Scope
The decision ids this phase builds, from phase-assignment.md. One line each.

## Out of scope
What this phase must NOT do (phase-assignment.md's "What each phase must not do", expanded).

## Requirements
R1..Rn. Each: what to build, and `(D<k>)` naming the decision it implements.

## Acceptance criteria
A1..An. Each: a single mechanically checkable assertion, and `(R<k>)` naming what it proves.

## Files touched
Repo-relative paths, each with one clause saying what changes.

## Test plan
Test file by test file. Name new fixtures and what each proves.

## Risks
Real ones, with the mitigation in the spec that covers each.
```

## Hard rules for the writing itself

These exist because the previous revision closed 17 blockers and **introduced 24 new defects**. That
is the base rate on this spec. Each rule below is a defect class that actually shipped.

1. **Never restate a decision in your own words.** Reference it: "per D11". Two phases wording the
   same rule differently was the single largest defect source.
2. **Every requirement cites a D-id.** A requirement citing none is either out of scope or an
   invented decision. Both are defects.
3. **Check every pair of acceptance criteria that mention the same array, field or count for
   joint satisfiability, before you finish.** Three blockers were pairs of criteria that could not
   both hold (for example asserting `turns.length === 400` while also asserting the presence of
   every past-cap stub in `turns[]`).
4. **Every `path:line` reference must be read before you write it.** Add each one you rely on to
   `.claude/work/prompt-lanes/spec-v2/claims.json` as
   `{ "why": "...", "file": "...", "line": N, "contains": "<a literal token on that line>" }`,
   then run:
   `node .claude/work/prompt-lanes/spec-v2/verify-refs.mjs . .claude/work/prompt-lanes/spec-v2`
   It must exit 0. A stale line reference already shipped once: a criterion cited line 179 of
   `test/skill.test.mjs`, an 86-line file. (That example is deliberately written without the
   backticked `path:line` form, because the verifier's D66 check treats every such token as a live
   citation and would demand a claims entry for a line that does not exist.)
5. **Never invent a constant, field name, file name or vocabulary member.** Use the ones in
   `decisions.md`. If you need one that does not exist there, that is a gap in the decisions: write
   it in a `## Open decisions` section at the bottom of your spec instead of inventing it.
6. **An acceptance criterion must be satisfiable by the code the requirements describe.** Before
   writing a criterion that depends on a config key, a field, or a file, confirm a requirement in
   *some* phase actually creates it. A criterion depending on `config.redaction.strictLaneNouns`
   shipped while nothing made that key survive the config loader.
7. **A criterion whose expected value is construction-dependent must give the exact input.** Not
   "yields 279 characters" but the literal source string and both lengths.
8. **Never weaken a privacy or honesty assertion to make another criterion pass.** If they conflict,
   the other criterion is wrong. Say so in `## Open decisions`.
9. **Zero runtime dependencies. Node >= 18 APIs only. Cross-platform paths.** No package, no
   lockfile, no install step.
10. **Clean-room.** Nothing you write into the repo may contain a real name, a real absolute path, a
    real repo name or a real email. Use repo-relative paths everywhere.

## Definition of done for your task

- `.claude/work/prompt-lanes/spec-v2/phase-<N>.md` exists and follows the shape above.
- `node .claude/work/prompt-lanes/spec-v2/verify-refs.mjs . .claude/work/prompt-lanes/spec-v2`
  exits 0.
- Every decision assigned to your phase in `phase-assignment.md` appears in `## Scope` and is
  implemented by at least one requirement.
- You have run the pairwise satisfiability check in rule 3 and can say you did.
- You wrote **no code**. This task produces a spec only.
