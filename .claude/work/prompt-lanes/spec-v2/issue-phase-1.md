Part of the prompt-lanes epic: EPIC_LINK

## In plain terms

This phase teaches honestweek to notice which of your instructions each piece of session evidence
belongs to, and to keep your exact wording in a private local file it never publishes. It separates
real instructions from machine notices like slash-command envelopes, records ideas that came up and
next steps written into session-end handoffs, and gives every usable record a stable local id so
later phases can point at it. Nothing renders. Not one byte of any report, page, site bundle or
archive snapshot changes in this phase.

## What you're deciding

Whether honestweek may keep a gitignored file of your verbatim prompts on your own machine.

That's the real question here. Everything else is plumbing. `honestweek.prompts.json` holds your
redacted prompt text so the distilling model can read what you actually asked for and name the
technique in its own words. It is added to `.gitignore` **before** it is written, it never reaches
any rendered artifact, and `build` never reads it. If you'd rather it not exist, say so now, because
the two lanes can't be built without it.

What merging this changes:

- **New file:** `honestweek.prompts.json`, gitignored, capped at 4000 characters per entry and 8 MiB
  total.
- **New config key:** `redaction.strictLaneNouns`, a boolean defaulting to false. Nothing reads it
  yet.
- **Changed:** `honestweek.draft.json` gains new keys. Every pre-existing key keeps its exact value,
  pinned against a committed baseline.
- **New, build-local:** one identity carrier records each turn, idea, next step, and reversal while
  its source ordinal is known. Later phases consume those exact records and never mint a replacement
  identity. Redaction-before-cap applies only to the new prompt and idea projections; the separate
  legacy reorder remains outside this phase.
- **Changed, deliberately:** a handoff whose only content is a "Next steps" section is no longer
  dropped. Those handoffs start appearing in the draft.
- **Unchanged:** every rendered artifact, byte for byte.

## Acceptance

- The six-mode golden output set is byte-identical before and after, over a frozen fixture corpus.
- Every pre-existing draft key deep-equals a baseline committed before any extraction code changed.
- A slash-command fixture shaped like the repo's own `sessE.jsonl` opens exactly one window, and no
  `<command-args>` value reaches the draft or the sidecar.
- A 500-boundary session yields 500 records, 400 of them gradeable, and 100 exact stubs.
- Every window object has exactly the 15 specified keys and every string value matches its key's
  rule. `assistantTurns` is an exact array of redacted one-key text objects.
- One carrier crosses both extraction adapters, preserves their legacy array returns, and exposes
  matching NUL-canonical identities for all five acceptance origins without ordinal reconstruction.
- `must` versus `may` produces different non-null shape keys; a `please`-only control stays equal.
- `redaction.strictLaneNouns` survives the real config loader, defaults false, and fails loud on a
  non-boolean.

## Implementation detail

Spec: `.claude/work/prompt-lanes/spec-v2/phase-1.md` (acceptance through A57). Decisions it
implements: D1, D2, D3, D4, D5, D13, D17, D19, D20, D21, D22, D23, D26, D27, D31, D33, D37, D38,
D39, D40, D41, D42, D43, D44, D68, D69, D70, D71, D72, D73, D74, D79 in `decisions.md`.

Files: `lib/lanes.mjs` (new), `lib/claude-adapter.mjs`, `lib/handoffs.mjs`, `lib/discover.mjs`,
`lib/config.mjs`, `lib/init.mjs`, `lib/harvest.mjs`, `.gitignore`, `README.md`, `AGENTS.md`, plus
tests and a frozen golden fixture corpus.

Two measured findings behind design choices here:

- The command branch is keyed on **content**, not on a record's opening tag. Measured over
  `~/.claude/projects` on two different 300-file slices: `<command-message>` opens 43 and 24 of the
  string user turns, `<command-name>` opens 6 and 1. Keying on the opening tag would have missed
  most real slash-command turns while an acceptance fixture built to the rare shape passed.
- The prose boundary is currently unguarded. An audit added a verbatim-prompt field to the public
  digest entry and all 371 tests still passed. This phase adds the structural assertion that would
  have caught it.

Baseline: 371 tests pass. `node --test` from the repository root, no path argument.
