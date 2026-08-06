# Prompt-lanes implementation control plan

> Historical review gate. Owner direction after checkpoint `da6812c` supersedes this document's
> stop-at-open-product-choices posture. The current product setpoint, explicit default choices, and
> vertical release gates are authoritative in `product-roadmap.md`. The contract findings and safety
> constraints below remain evidence, not a reason to reopen an indefinite experiment program. The
> owner explicitly approved the seven load-bearing rules on 2026-08-01; `owner-approval.md` is the
> durable decision record and reconciles the historical blocked statuses below.

## Objective and setpoint

The implementation is successful only when a completed week can produce a small, truthful,
reader-useful addition to Honest Week: prompt techniques supported by observable session evidence
and forward-looking material that is still worth the reader's attention. Contract correctness is a
necessary foundation, not the product outcome.

The repaired specification proves identity, privacy, rendering, persistence, and producer/consumer
closure. The owner-approved policy now defines worthwhile selection, prompt deletion, safe
public-prompt triage, reader load, bounded recurrence and retirement, output/carry recovery, and the
representative proof required for completion. Approval settles the policy inputs. It does not itself
prove their runtime behavior or pass a release gate.

## System state

| State | Durable evidence | Status |
| --- | --- | --- |
| Provenance reconciled | checkpoint `9e30b0a`; 35 allowlisted artifacts; personal paths redacted | PASS |
| Contract verification | refs 201/124/66; 79-decision coverage; 13-boundary contract ledger | PASS |
| Execution baseline | `node --test`: 371 pass, 0 fail | PASS |
| Product-selection policy | A1 and A4 in `owner-approval.md`; roadmap score, order, target, caps, and disclosure | APPROVED |
| Private prompt capture policy | automatic capture is approved; text is redacted before disk and private by default | PASS |
| Prompt deletion policy | A2; confirmed individual/all deletion, no-text tombstones, explicit reset | APPROVED |
| Public prompt triage policy | A3; residual-low automatic, ambiguous private, residual-high excluded, 20-percent ceiling | APPROVED |
| Cross-week lifecycle policy | A5; two-week idea/next-step recurrence, one-digest renewal, terminal retirement, 12-week history | APPROVED |
| Output/carry recovery policy | A6; hash-bound pending protocol and fail-closed recovery | APPROVED |
| Representative product proof | A7; predeclared dual-source, all-category, multi-week proof and independent review | REQUIRED |
| Persona hypothesis | no persona source, schema, consent rule, or relevance evidence | DEFERRED |

Owner approval cleared the historical product-policy blockers. Runtime work may advance only inside
the next reviewed slice contract. `REQUIRED` evidence remains fail-closed: approval does not turn an
unrun proof or review into `PASS`.

## Sensors

- Provenance sensor: clean Git status, exact checkpoint SHA, allowlisted file inventory, and
  clean-room scan.
- Contract sensors: `verify-refs.mjs`, `verify-coverage.mjs`, `verify-contracts.mjs`, their negative
  controls, and the producer/consumer ledger.
- Execution sensor: `node --test` on Node 18-compatible code, plus the phase's named contract and
  invariant checks.
- Product sensor: a clean-room completed-week fixture whose expected visible inclusions,
  exclusions, order, and maximum row counts are declared before the implementation is run.
- Selection sensor: exact acceptance and suppression counts against predeclared clean-room cue
  labels. These fixture readings test the closed grammar; they are not population precision/recall
  estimates and private source text never enters the repo.
- Privacy-transformation sensor: exact private-source/rendition hashes, an ordered operation log,
  changed-span coverage, current-policy validation, the automatic or escalated decision record,
  approval identity only on escalated approvals, and negative controls where a transformation
  invents or materially changes a claim.
- Reader-load sensor: visible technique and forward-row counts across a multi-session week and a
  multi-week carry sequence.
- State-coherence sensor: primary output authority and the forward index either advance together or
  leave a durable, redacted recovery state that blocks later carry decisions until reconciled.

## Controller decisions

The controller may advance only when all inputs for the next gate are observable.

1. **Private capture decision (settled).** Discovery automatically captures source-faithful prompt
   text after redaction, in the gitignored local sidecar. Capture is not public approval. Before the
   combined Phase 1+2 release, user-initiated deletion was required. A2 now settles individual and
   all-items deletion, atomic replacement, no-text tombstones, ordinary-rescan suppression, and a
   separate explicit reset. Deletion never relaxes a public-safety gate or implies that an already
   built, copied, or published artifact can be recalled.
2. **Selection decision (approved).** A1 separates evidence eligibility from editorial worth and
   ratifies the roadmap's disclosed floor, weights, category-specific eligibility signals, and
   deterministic order. A4 ratifies placement, volume bounds, omission disclosure, and explicit
   keeps. The policy names its narrow evidence basis and makes no broader "interesting material" or
   universal-importance claim.
3. **Carry lifecycle decision (approved).** A5 separates suppression history from rows worth
   resurfacing. Only unresolved ideas and next steps recur automatically, for two following digests;
   a manual renewal lasts one digest; terminal rows retire; and history is bounded to 12 weeks.
   `--no-lanes` remains a build-wide compatibility control, not a per-row lifecycle control.
4. **Persona decision (settled for this scope).** Do not infer, persist, or rank by persona in
   Phases 1-4. A source prompt that explicitly defines a persona may be named as a technique only
   when it passes the ordinary Phase 2 evidence contract. Persona-based selection or framing is a
   later hypothesis requiring user-supplied definitions, consent, representative evidence, and
   falsifiable relevance controls.
5. **Release decision (settled).** Phase 1 and Phase 2 are implementation work packages behind one
   release gate. Their identity carrier, exact encoding, shared validators, corpus boundary, and
   first reader-visible output advance or roll back together.
6. **Public prompt decision (settled flow and thresholds).** Explicit approval is an exception,
   not a requirement for every public-safe prompt and not a substitute for privacy validation.
   Automatic capture, model selection, a technique row, deletion, or material strength alone never
   establishes public safety. When the public-prompt renderer is enabled, an individual prompt is
   included automatically if and only if it clears
   the declared strong-material threshold, uses no transformation or only an allowed minor,
   meaning-preserving transformation, passes deterministic changed-span and current-policy
   validation, has residual risk below the escalation threshold, and retains a transcript receipt.
   Ambiguous classification, an unusual transformation, a mapping outside the allowlist, validator
   uncertainty, or unresolved privacy concern fails closed into an explicit approval queue. An
   approval can resolve that item's ambiguity but cannot waive validation or approve residual-high-
   risk material. Residual high risk after every permitted minor transformation excludes the item.
   No path publishes or sends anything.

   A retained private record is immutable to the transformation path: a public rendition never
   rewrites it. The separate deletion contract may atomically remove one receipt or the whole
   sidecar and controls whether later discovery can regenerate it. Deterministic transforms may
   replace known sensitive spans
   with fixed generic placeholders, remove exactly identified spans, or apply an approved
   meaning-preserving generalization mapping. They may not add a motive, outcome, actor, or claim
   absent from the private source. Every automatic, escalated, approved, and excluded decision binds
   the prompt identity, transcript receipt, SHA-256 hashes of the exact private redacted source and
   public-safe rendition, ordered transform operations, transform-extent class, policy version,
   validator result, residual-risk class, decision reason, and decision time. Escalated approval
   additionally records approval identity/time. Public output carries the receipt and a structured
   privacy-edited indicator when changed, never private text or transform details. Build re-resolves
   the hashes and policy and verify-or-aborts on mismatch.

7. **Privacy triage decision (settled policy).** Privacy is an independent
   evaluation dimension, not a first-hit rejection shortcut and not a mandatory-approval signal.
   Triage uses an ordered decision table rather than an invented aggregate score: material-strength
   class, raw privacy-risk class, feasible transform class, transform extent, residual privacy-risk
   class, deterministic validation result, ambiguity/unusual flags, and terminal decision
   (`automatic-safe`, `needs-approval`, or `excluded`). For a promising item the default sequence is
   assess, attempt the smallest meaning-preserving privacy transformation, validate the rendition,
   then choose the terminal decision. Low or medium raw risk cannot exclude or automatically force
   approval before that attempt. A3 defines `strong` as explicit keep or score at/above the approved
   floor. Automatic handling requires residual low risk, 100-percent changed-span accounting,
   allowlisted canonical replacements, no unknown mapping or validator uncertainty, and at most 20
   percent of non-whitespace source characters changed. The A7 proof reports the share of strong
   candidates reaching `automatic-safe`, using all strong candidates entering privacy triage as the
   denominator. No numeric quota is approved for the current slices, and no quota may weaken the
   safety table. Residual high risk after every permitted
   minor transform is a non-compensatory item stop: material strength cannot outweigh it. The item
   is excluded with a count-only diagnostic while the rest of the safe report may continue. Any
   privacy hit that survives into the final public collection remains a build-level verify-or-abort
   failure and writes nothing.

   A3 and A4 settle the current automatic-safe, needs-approval, exclusion, placement, and visible
   `Privacy edited.` rules. Generalization mappings, a local approval queue, and a numeric
   automatic-safe target remain Slice 4 implementation choices and require a separately reviewed
   contract before they can broaden the automatic path. Undefined or unmeasurable behavior fails
   closed to `needs-approval`; unavailable approval leaves the item private.

8. **Output/carry transaction decision (approved).** A6 specifies the cross-platform, hash-bound
   pending protocol for the primary artifact and sole carry authority. Exact-hash recovery may
   promote pending automatically; output mismatch requires explicit discard and a fresh prepare and
   build; every unknown state fails closed. Fault injection must prove that a failure at every write,
   flush, phase rewrite, or rename boundary either leaves both at the prior state, advances both, or
   leaves a redacted recovery record that blocks later carry decisions until reconciled. A warning
   after preserving a newer visible artifact with an older index is not sufficient.

## Actuators

- Before product gates pass: edit only specifications, tests, fixtures, verifiers, and control
  evidence. Do not change product runtime behavior.
- After a phase gate passes: change only the files assigned to that phase/work package, run its
  checks, and make one intentional checkpoint.
- On a failed gate: preserve evidence, make no later-phase change, and report the exact failing
  sensor and corrective action.
- No actuator may push, publish, file an external issue, use network egress, or read Git for a
  `display`-role repository.

## Phase-to-reader mapping and gates

### Combined Phase 1+2 release: evidence and the first visible band

- Phase 1 is invisible to the reader. It distinguishes real prompt windows, records narrowly
  cue-matched ideas and heading-scoped handoff material, and creates the one build-local canonical
  identity carrier. The source-faithful, post-redaction prompt sidecar remains local and gitignored.
- Phase 2 is the first reader-visible result: a techniques band in `digest`, `report`, `page`, and
  `post`. Each selected technique uses cautious evidence language and a transcript receipt; no row
  claims that a prompt "worked."
- Required advance evidence: exact shared index-builder APIs; one user-initiated deletion contract;
  the public-prompt triage decision table and its renderer, or an explicit deferral recorded as an
  incomplete public-surfacing outcome; one pre-authoring
  `build --explain-lanes` step;
  selection inclusion/exclusion/order/volume rules; exact clean-room cue acceptance and suppression
  coverage with no population precision/recall claim;
  all Phase 1 and 2 contract tests; lane-absent byte identity; one clean-room reader-visible weekly
  scenario.
- Stop if deleted private rows can reappear without the declared regeneration behavior, an identity is re-minted, a display repo is
  Git-read, an eligible-but-unselected policy is ambiguous, or the combined release cannot roll
  back as one unit.

### Phase 3: current-week forward material and diagnostics

- The reader sees one closing, non-badged band after work and techniques. It may contain selected
  authored ideas plus safe heading-scoped handoff next steps and reversals, with transcript receipts
  and cautious dispositions.
- Required advance evidence: the settled selection/volume rule applies to authored and engine
  candidates; routine handoff boilerplate and semantic duplicates are excluded by declared
  controls; diagnostics survive the named return object; every privacy and copy gate runs; all
  modes obey their declared output authority.
- Stop if every mechanically eligible engine row can flood the display, an authored row can invent
  provenance, a diagnostic is lost, or a ref reaches public output.

### Phase 4: cross-week carry and receipt behavior

- The reader may see a still-relevant prior row marked `deferred`, with its first-seen week and
  current as-of week. Terminal and retired rows do not resurface.
- Required advance evidence: the carry lifecycle decision; a multi-week bounded-relevance test; all
  stored ref/canonical pairs validate before joins; current privacy policy re-gates carried text;
  output and the sole carry authority cannot diverge silently after a write failure.
- Stop if a stale row can recur without the settled policy, corrupt state affects a join, current
  policy cannot be applied, or primary output succeeds without a durable/queryable carry-state
  transition.

## Full-system feedback and completion

After all phase gates pass, run one clean-room end-to-end completed-week scenario through discovery,
authoring, validation, build, rendering, carry, and the following week's suppression/resurfacing.
Record expected and actual inclusions, exclusions, order, visible counts, receipts, diagnostics,
output bytes for the lane-absent control, and cross-week state. Then run the full test suite and a
fresh review-loop. A7 makes this predeclared representative proof mandatory, expands it to both
supported tools and all six categories, and requires the multi-week recurrence, renewal, retirement,
tombstone, pruning, target-compatibility, and transaction fault cases recorded in
`owner-approval.md`.

Completion requires: zero unresolved load-bearing review findings; every required sensor green;
independently shippable Phase 3 and Phase 4 checkpoints; one combined Phase 1+2 release checkpoint;
no personal data in committed evidence; and no external action.

## Review-loop gate

The execution-grounded review-loop verdict on checkpoint `9e30b0a` remains historically **NOT
CLEAN**. Corrective review closed the stale epic provenance, post-authoring `--explain-lanes` retry,
missing exact identity-index APIs, collision-count unit, and contradictory Phase 1/Phase 2
ship-alone checks. Bounded re-review passed those corrections.

The 2026-08-01 owner decision resolves the load-bearing product-policy findings without rewriting
that historical verdict. Exact predeclared clean-room cue acceptance and suppression coverage,
automatic-safe fixture yield, runtime acceptance, target compatibility, the A7 representative
proof, and a fresh independent review remain evidence gates; the fixture readings are not
statistical calibration or population-performance estimates. The controller may now
advance through reviewed slice contracts, but no affected slice is complete or releasable until its
named evidence is green and the fresh review has zero unresolved load-bearing findings.

## Uncertainty and stop conditions

- The current corpus does not support general "interesting material" recall. Under-claim rather
  than presenting four lexical cues as comprehensive idea discovery.
- The current corpus provides no evidence for persona-based ranking or framing.
- A2 approves deletion and regeneration policy. Exact all-items and reset command schemas remain
  implementation work for their reviewed lifecycle slice. Deletion never recalls an already built,
  copied, or published artifact.
- A3 and A4 approve the current automatic-safe thresholds and placement. Public prompt text remains
  prohibited until the dedicated triage, privacy-transformation, receipt, and validation contract
  passes review. Explicit approval is reserved for a later `needs-approval` path; it is not imposed
  on `automatic-safe` items and cannot override high risk or failed validation.
- A5 and A6 authorize a reviewed Slice 3b contract for bounded cross-week lifecycle and hash-bound
  recovery after the current-week Slice 3a work is complete and clean. They do not authorize Slice 4
  generalization/approval UI or Slice 5 feedback behavior.
- Any attempt to resolve those choices by inventing a UI, persona data, or ranking heuristic stops
  the controller and returns the decision to the user.
