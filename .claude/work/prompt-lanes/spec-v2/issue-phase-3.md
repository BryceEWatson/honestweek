Part of the prompt-lanes epic: EPIC_LINK. Depends on phase 2: PHASE2_LINK.
Closes #52 item 4 and #52 item 5.

## In plain terms

This phase adds the second band: what came up that hasn't been done yet. Three things feed it. Ideas
mined from your sessions, next steps written into session-end handoffs, and dead ends you already
ruled out. Each row shows where it came from and what happened to it: not started, picked up, ruled
out, or deferred. The band sits below the badged work, carries a literal "carried forward, not a
verified claim" label, and never renders as a badge.

## What you're deciding

Whether handoff prose may reach a published page for the first time.

Right now nothing in `lib/emit` or `lib/site` reads handoff claims or reversals, so no handoff text
has ever reached a rendered artifact. This phase changes that, and it's the reason the phase carries
the gates it does. Handoffs are free prose written by an assistant, which is exactly the surface the
lane privacy rules exist to keep out of output. So:

- Only lines inside a reversal **heading section** can render. The free-floating pattern stays draft
  only. That pattern is `/\b(revers|reverted|rolled back|don'?t resurrect|corrected)\b/i`, which
  matches any line anywhere in a handoff, so without this narrowing an ordinary line like "corrected
  the invoice before the call" would publish.
- Every engine-sourced row passes the same four gates as authored text: the unconfigured-noun check,
  the configured private-term check, the display-role repo naming check, and the prose honesty lint.
- A negative-control test asserts an unconfigured private noun inside a handoff reversal line reaches
  no rendered artifact and no archive snapshot.

The second decision is smaller but worth stating: the band renders when **either** the model authored
forward items **or** the engine found handoff reversals or next steps. Gating it on the authored key
alone would mean that in the common week, where the model writes nothing forward-looking, your
reversals still render nothing, and #52 item 5 stays open while looking closed.

What merging this changes:

- **New:** a forward band in `digest`, `report`, `page` and `post`.
- **New:** `forwardUnactioned`, a count in the archive index, present only when the band is.
- **Changed:** every forward row carries `dispositionAsOf`, set to the build's week start, so an
  archived week's frozen band can be labelled honestly rather than reading as current.
- **Changed:** Phase 3 fills the already-reserved SKILL rule 8 body with the exact Forward item
  schema. It does not renumber a rule or edit Phase 2's public copy.
- **New private boundary:** one named result object carries final rows, exact engine rows, raw
  authored/engine presence, and four typed diagnostic arrays. No diagnostic is lost in a tuple or
  recomputed by Phase 4.

## Acceptance

- An items file with no `forward` key at all, plus a handoff carrying a reversal, renders the band.
  This is what closes #52 item 5.
- Handoff next steps render in a labelled carried-forward band, visually distinct from badged claims.
  This closes #52 item 4.
- Ideas from transcripts, next steps from handoffs, and reversals from handoffs all land in one array
  with one vocabulary. That's the mechanical form of "the taxonomy didn't fork".
- The band's HTML contains none of the work badge class names, and no forward row passes through
  `badge()`, `renderItemLine()` or `allItems()`.
- A week with no authored forward key, no handoff reversals and no next steps is byte-identical to
  the pre-change build.

## Implementation detail

Spec: `.claude/work/prompt-lanes/spec-v2/phase-3.md`. Decisions: D5, D6, D7, D8, D10, D14, D19, D23,
D24, D26, D28, D29, D30, D32, D33, D34, D35, D39, D40, D42, D43, D44, D45, D46, D47, D48, D49,
D50, D54, D55, D56, D57, D58, D62, D63, D65, D68, D69, D73, D74, D75, D76, D77, D78, D79.

Dispositions are `not started`, `picked up`, `ruled out`, `deferred`. `open` was deliberately not
used: #52 item 3 asks for a stat band counting unlanded work, and an `open` disposition counting
un-actioned ideas at the bottom of the same page would collide with it.

`picked up` requires a SHA that came from a `git commit` result specifically, resolves through the
same path `verifyItems` uses in the session's own repo, and is authored by a configured address.
Anything short of all three renders `not started`. `ruled out` beats `picked up` when both hold,
because under-claiming is the invariant.
