# Prompt-lanes owner approval record

## Decision

**Status: APPROVED**

On 2026-08-01, the owner explicitly approved A1 through A7 below exactly as presented in the
owner-facing checklist. This record is the durable product authority for those seven rules. The
roadmap and reviewed slice contracts supply their executable detail; historical D1-D79 phase
documents remain technical evidence only where the roadmap says they do.

This approval clears the product-policy blockers recorded in `implementation-control-plan.md`. It
does not mark implementation, representative proof, independent review, or any release gate as
passed.

## A1 - APPROVED: evidence-based worthwhile selection

- Use the roadmap's disclosed evidence heuristic, not manual-only selection or broad "interesting
  material" inference.
- Require resolvable receipts, supported categories, honest claims, current privacy validation, and
  live non-hidden evidence before selection.
- Use the default automatic floor of 2 and the documented observable weights, category-specific
  eligibility signals, deterministic ordering, and fixed explanations.
- Explicit keep may bypass score and capacity, but never receipt, honesty, or privacy gates.
- Output states that the rules favor observable recurrence and verification, not universal
  importance.

## A2 - APPROVED: deletion, tombstones, and regeneration

- Confirm individual and all-items deletion before mutation.
- Remove text and leave a no-text identity tombstone so ordinary source sync cannot regenerate a
  deleted item.
- Permit regeneration only after a separate explicit reset, scoped to an item, week, or all
  tombstones.
- Keep writes atomic. Deletion invalidates stale derivatives until prepare or curate, validate, and
  build complete again.
- Deletion cannot recall an already built, copied, or published artifact. The command must state
  that boundary and the local cleanup path.
- Retain private prompt text for 12 completed weeks by default; retained tombstones contain no text.

## A3 - APPROVED: privacy transformation and local public-facing surfacing

"Public-facing" means eligible for the local weekly artifact. Honest Week still uploads and
publishes nothing.

- `strong` means explicitly kept or selected at the automatic floor. Strength never overrides
  privacy.
- `automatic-safe` requires a valid receipt, residual low risk, 100 percent changed-span
  accounting, only allowlisted canonical redactor replacements, no unknown mapping or validator
  uncertainty, and no more than 20 percent of non-whitespace source characters changed.
- Ambiguous or medium-risk material remains private as `needs-approval`. Until the later approval
  workflow exists, it has no path to the public-safe lane.
- Residual high-risk material is excluded. Approval can never override residual high risk or failed
  validation.
- A changed visible rendition says `Privacy edited.` and carries hashes, policy version, decision
  reason, and source receipt without private text or transformation detail.
- The automatic-safe share is measured and reported in the representative proof. No numeric quota
  may weaken the safety table. A later Slice 4 expansion needs a separately reviewed target and
  contract.

## A4 - APPROVED: placement and reader-load controls

- Place badge-less digest groups after ordinary work in this fixed order: Prompt highlights, Ideas,
  Techniques, Decisions, Reversals, Next steps.
- Use an overall automatic target of 12 and automatic category caps of 2, 2, 3, 2, 1, and 2 in that
  order.
- Add no filler for empty categories. Show why each item surfaced, retain its receipt, and disclose
  eligible omissions by category.
- Explicit keeps render before automatic items and may exceed category caps and the overall target.
  The over-target result must be disclosed and may not silently drop a keep.
- Missing or empty lane input remains byte-identical to the established output.

## A5 - APPROVED: carry, renewal, retirement, and history

- Only unresolved ideas and next steps recur automatically, for at most the next two weekly
  digests.
- Manual `carry-forward` may renew any category for exactly the next digest. Repeating renewal is
  explicit; there is no permanent implicit pin.
- Carried rows show first-seen and current as-of weeks.
- Terminal evidence (`picked up` or `ruled out`) suppresses carry before rendering. Keep affects
  selection, not factual status.
- Retain at most 12 weeks of carry history. Expired and terminal rows retire.

## A6 - APPROVED: output and carry recovery

- Use the roadmap's redacted pending record with generation, prior and next carry hashes, target
  output hash, week, phase, and next carry.
- Write and flush pending, atomically write the primary output, mark pending `output-written`, then
  atomically promote the next carry to the sole canonical carry index.
- At startup, auto-promote only when the output and prior-carry hashes match exactly.
- If output does not match, require explicit pending discard followed by a fresh prepare and build.
  Every unknown combination fails closed without guessing or mutation.
- Fault injection covers every temp write, flush, phase rewrite, output rename, carry rename, and
  repeated recovery.

## A7 - APPROVED: representative proof and independent review

Before an affected runtime slice is complete, freeze expected results and run a representative,
clean-room, dual-source, all-category, multi-session, multi-week proof through source scan, private
review, curation, validate, build, and the actual configured target transform imported read-only in
memory.

The proof must cover exact inclusions, exclusions, order, scores and reasons, category and overall
counts, receipts, privacy edits, omissions, duplicate and boilerplate suppression, keep/hide/delete,
two-week automatic recurrence, one-week renewal, terminal retirement, tombstones, 12-week pruning,
lane-absent byte identity, display-role zero-Git behavior, no network or publish action, and every
transaction recovery boundary. It records exact predeclared clean-room acceptance and suppression
coverage for the closed cues, plus automatic-safe fixture yield, without private source text. These
readings are not statistical calibration or population-performance estimates. The full supported
Node suite, clean-room checks, contract verifiers, target
compatibility, and an independent review-loop must finish with zero unresolved load-bearing
findings. Contract closure or unit tests alone are insufficient.

## Gate effect and next implementation boundary

The owner decision clears the seven product-policy blockers. Evidence and release gates remain
fail-closed until their named tests and reviews pass.

The next authorized runtime boundary is the reviewed Slice 3b follow-on after the current-week
Slice 3a control work is complete and clean. Slice 3b may implement only cross-week retention,
two-week automatic recurrence for unresolved ideas and next steps, one-digest manual renewal across
categories, terminal retirement, 12-week history, the hash-bound output/carry recovery protocol,
and the A7 multi-week proof. Its exact contract must be reviewed before runtime changes begin.

This approval does not authorize expanded generalization or approval UI from Slice 4, feedback or
weight learning from Slice 5, a push, merge, release, publish action, target-repository write, or
any external-system change.
