# Prompt-lanes implementation control plan

> Historical review gate. Owner direction after checkpoint `da6812c` supersedes this document's
> stop-at-open-product-choices posture. The current product setpoint, explicit default choices, and
> vertical release gates are authoritative in `product-roadmap.md`. The contract findings and safety
> constraints below remain evidence, not a reason to reopen an indefinite experiment program.

## Objective and setpoint

The implementation is successful only when a completed week can produce a small, truthful,
reader-useful addition to Honest Week: prompt techniques supported by observable session evidence
and forward-looking material that is still worth the reader's attention. Contract correctness is a
necessary foundation, not the product outcome.

The current repaired specification proves identity, privacy, rendering, persistence, and
producer/consumer closure. It does not yet prove worthwhile selection, prompt deletion, safe
public-prompt triage, or a bounded lifecycle for recurring ideas. Those are open product gates, not
implementation details.

## System state

| State | Durable evidence | Status |
| --- | --- | --- |
| Provenance reconciled | checkpoint `9e30b0a`; 35 allowlisted artifacts; personal paths redacted | PASS |
| Contract verification | refs 201/124/66; 79-decision coverage; 13-boundary contract ledger | PASS |
| Execution baseline | `node --test`: 371 pass, 0 fail | PASS |
| Product-selection contract | no inclusion, exclusion, global order, or reader-volume rule | BLOCKED |
| Private prompt capture policy | automatic capture is approved; text is redacted before disk and private by default | PASS |
| Prompt deletion control | no user-initiated individual/all deletion contract exists | BLOCKED |
| Public prompt triage | automatic-safe, escalation, exclusion, transformation, and receipt thresholds are not yet defined | BLOCKED |
| Cross-week lifecycle | nonterminal rows recur indefinitely with no selective retirement contract | BLOCKED |
| Output/carry coherence | an index failure after primary emit can leave carry authority behind visible output | BLOCKED |
| Persona hypothesis | no persona source, schema, consent rule, or relevance evidence | DEFERRED |

No product implementation may begin while any required state is `BLOCKED`.

## Sensors

- Provenance sensor: clean Git status, exact checkpoint SHA, allowlisted file inventory, and
  clean-room scan.
- Contract sensors: `verify-refs.mjs`, `verify-coverage.mjs`, `verify-contracts.mjs`, their negative
  controls, and the producer/consumer ledger.
- Execution sensor: `node --test` on Node 18-compatible code, plus the phase's named contract and
  invariant checks.
- Product sensor: a clean-room completed-week fixture whose expected visible inclusions,
  exclusions, order, and maximum row counts are declared before the implementation is run.
- Selection sensor: locally measured precision/recall evidence for the closed idea cues, recorded
  only as aggregate numbers and clean-room examples. Private source text never enters the repo.
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
   combined Phase 1+2 release, define user-initiated deletion for one receipt and for the whole
   sidecar, atomic rewrite/delete behavior, and what regeneration does. Deletion must not relax any
   public-safety gate or imply that an already published copy can be recalled.
2. **Selection decision (open).** Separate evidence eligibility from editorial worth. Declare
   inclusion, exclusion, deterministic tie/order behavior, and reader-facing volume bounds for both
   techniques and forward material. If evidence supports only narrow cue capture, name it narrowly
   and defer broader "interesting material" discovery.
3. **Carry lifecycle decision (open).** Separate history needed for zombie suppression from rows
   worth resurfacing. Declare a selective retirement or bounded recurrence policy and a long-run
   acceptance sequence. `--no-lanes` is not a per-row lifecycle control.
4. **Persona decision (settled for this scope).** Do not infer, persist, or rank by persona in
   Phases 1-4. A source prompt that explicitly defines a persona may be named as a technique only
   when it passes the ordinary Phase 2 evidence contract. Persona-based selection or framing is a
   later hypothesis requiring user-supplied definitions, consent, representative evidence, and
   falsifiable relevance controls.
5. **Release decision (settled).** Phase 1 and Phase 2 are implementation work packages behind one
   release gate. Their identity carrier, exact encoding, shared validators, corpus boundary, and
   first reader-visible output advance or roll back together.
6. **Public prompt decision (settled flow, open thresholds).** Explicit approval is an exception,
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

7. **Privacy triage decision (settled shape, open thresholds).** Privacy is an independent
   evaluation dimension, not a first-hit rejection shortcut and not a mandatory-approval signal.
   Triage uses an ordered decision table rather than an invented aggregate score: material-strength
   class, raw privacy-risk class, feasible transform class, transform extent, residual privacy-risk
   class, deterministic validation result, ambiguity/unusual flags, and terminal decision
   (`automatic-safe`, `needs-approval`, or `excluded`). For a promising item the default sequence is
   assess, attempt the smallest meaning-preserving privacy transformation, validate the rendition,
   then choose the terminal decision. Low or medium raw risk cannot exclude or automatically force
   approval before that attempt. The gate must declare an auditable target for the share of strong
   candidates reaching `automatic-safe`, using all strong candidates entering privacy triage as the
   denominator, and demonstrate it on representative clean-room fixtures. No numeric target is
   inferred here. Residual high risk after every permitted
   minor transform is a non-compensatory item stop: material strength cannot outweigh it. The item
   is excluded with a count-only diagnostic while the rest of the safe report may continue. Any
   privacy hit that survives into the final public collection remains a build-level verify-or-abort
   failure and writes nothing.

   The open, auditable policy choices are: the evidence-backed definition of `promising` and
   `strong`; raw and residual risk classes; the exact automatic-safe, escalation, and exclusion
   decision-table rows; the allowed operation types and maximum per-operation and total changed-span
   extent; approved generalization mappings; what makes a case ambiguous or unusual; the approval
   queue/control shape; the `automatic-safe` share target; where a surfaced prompt appears; and the
   visible privacy-edited wording.
   Undefined or unmeasurable thresholds fail closed to `needs-approval`; unavailable approval leaves
   the item private. Implementation stops until these thresholds and controls are reviewed.

8. **Output/carry transaction decision (open).** Before Phase 4, specify one cross-platform
   transaction or durable recovery protocol for the primary artifact and sole forward-index
   authority. Fault injection must prove that a failure at every write, flush, or rename boundary
   either leaves both at the prior state, advances both, or leaves a redacted recovery record that
   blocks later carry decisions until reconciled. A count-free warning after preserving a newer
   visible artifact with an older index is not sufficient.

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
  selection inclusion/exclusion/order/volume rules; cue calibration or an explicitly narrow claim;
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
fresh review-loop.

Completion requires: zero unresolved load-bearing review findings; every required sensor green;
independently shippable Phase 3 and Phase 4 checkpoints; one combined Phase 1+2 release checkpoint;
no personal data in committed evidence; and no external action.

## Review-loop gate

The execution-grounded review-loop verdict on checkpoint `9e30b0a` is **NOT CLEAN**. Runtime
implementation is stopped. Corrective review closed the stale epic provenance, post-authoring
`--explain-lanes` retry, missing exact identity-index APIs, collision-count unit, and contradictory
Phase 1/Phase 2 ship-alone checks. Bounded re-review passed those corrections.

Load-bearing work remains: worthwhile inclusion/exclusion/order/volume rules; calibration or narrow
claims for the four idea cues; routine/duplicate suppression and a display bound for Phase 3;
private prompt deletion/regeneration; automatic-safe/escalation/exclusion thresholds and public
prompt placement; selective cross-week retirement; output/index transaction recovery; and a
representative end-to-end test that proves useful weekly selection rather than contract closure
alone. The controller cannot advance until these inputs are settled and a fresh review-loop returns
clean.

## Uncertainty and stop conditions

- The current corpus does not support general "interesting material" recall. Under-claim rather
  than presenting four lexical cues as comprehensive idea discovery.
- The current corpus provides no evidence for persona-based ranking or framing.
- Automatic private capture is approved, but the current plan provides no deletion command/flow,
  public-prompt decision thresholds, escalated-approval control, prompt placement, or
  deletion-versus-already-published policy.
- Public prompt text remains prohibited from automatic bands until the dedicated triage,
  privacy-transformation, receipt, and validation contract passes review. Once it does, explicit
  approval is reserved for the `needs-approval` path; it is not imposed on `automatic-safe` items.
- Any attempt to resolve those choices by inventing a UI, persona data, or ranking heuristic stops
  the controller and returns the decision to the user.
