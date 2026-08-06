Part of the prompt-lanes epic: EPIC_LINK. Depends on phase 1: PHASE1_LINK

Implemented with Phase 1 behind one release gate. Both work packages must pass their contract checks
and the combined reader-visible outcome gate before either advances.

## In plain terms

This phase adds the first new band: ways of asking that measurably worked. The model may name a
technique, but the program decides whether the session record actually supports showing it and which
cautious label it gets. A technique with no measured evidence is dropped, not shown with a weaker
badge. Every line points back to the session turn behind it. This phase also settles the shared
rendering and wording rules once, so the next phase adds rows rather than rewriting text.

## What you're deciding

Two things.

**First, what the labels are allowed to say.** They read `no correction observed`, `repeated without
correction` and `correction observed`. They deliberately do not read "worked first time" or "held
up". What the engine measures is whether a correction followed and whether a typed test flipped, and
a label claiming the technique *worked* would be a proxy borrowing the name of the thing it only
stands in for. That's the exact error this whole feature exists to avoid, so I'd rather the labels
read a little flat. Each row also renders a plain evidence clause naming the literal signals.

**Second, whether a missing session corpus should cost you the whole week's report.** It currently
would. I'm changing that. Lane failures now split two ways:

- **Drop the band loudly, still emit the report:** the session logs are gone, pruned, on another
  machine, or wiped by `git clean -xfd`. stderr names the band, the reason, and the `--no-lanes`
  flag without inventing a row count that cannot be known.
- **Exit 2, write nothing:** a copy-gate hit, a `display`-role repo named, a configured redaction
  term that survived, or a strict unconfigured-noun hit.

Verify-or-abort stays exactly where it means something, which is a positive dishonesty hit. Losing a
Sunday-night work report to an optional bonus band was never that.

What merging this changes:

- **New:** a techniques band in `digest`, `report`, `page` and `post`. `changelog` stays work-only.
- **New:** `--no-lanes` on `build` and `validate`.
- **New:** `build --explain-lanes`, read-only, prints which windows are gradeable so authoring isn't
  a retry loop at one full transcript scan per attempt.
- **Changed:** the "Every line carries a status badge and a receipt" contract strings become
  conditional. Byte-identical when no lane renders, scoped wording when one does.
- **New shared contracts:** `ensureLaneCorpus()` carries the Phase 1 identity records plus a hashed
  copy-run index with no recoverable corpus prose. The transcript-receipt helper and every forward
  metadata phrase, including optional `closed by` and carry dates, are authored here once.
- **Corrected receipt wording:** work lines promise a source receipt. Git-checkable work uses a
  commit, while private, display-role, and session-only work may use a transcript receipt.
- **Changed:** `page.mjs`'s legend and badge-class maps become one parameterized pill primitive,
  instantiated three times. The work-status instantiation must emit byte-identical HTML, pinned by
  the golden harness. This is what stops #50 item 7 from becoming a fourth parallel render system.
- **Unchanged:** `STATUSES` gains no member. No lane value passes through `badge()`.

## Acceptance

- A technique with no measured outcome never renders, in any mode.
- Every technique row renders its session receipt, styled so it cannot read as a commit SHA.
- The three vocabularies are pairwise disjoint, and no rendered lane string contains `landed`,
  `merged` or `shipped`.
- A configured redaction term placed inside a technique text is scrubbed in digest, report, page and
  the archive snapshot.
- With no lane keys present, all six modes are byte-identical to the pre-change build.
- A build with lane keys and no session corpus exits 0, emits the work report, and names
  `--no-lanes` on stderr.

## Implementation detail

Spec: `.claude/work/prompt-lanes/spec-v2/phase-2.md`. Decisions: D3, D5, D6, D7, D8, D9, D10, D11,
D13, D14, D15, D16, D17, D18, D19, D20, D23, D24, D25, D27, D28, D30, D31, D32, D33, D35, D36, D37,
D38, D39, D40, D41, D49, D50, D51, D52, D53, D54, D55, D60, D63, D64, D67, D68, D69, D70,
D72, D73, D74, D75, D76, D77, D78, D79.

Coordination with open issues: `STATUSES` is untouched, so #50 item 7 owns the only change to it.
`RESERVED_FOR_WORK_LANE` holds `stranded`, `landed`, `unlanded`, `merged` and `reachable` out of the
two lane vocabularies, and deliberately does **not** assert their absence from `STATUSES`, because
#52 item 1 explicitly leaves that shape open and a reservation enforced as a veto on the reserving
issue isn't a reservation.
