# Prompt-lanes and lifecycle-controls completion evidence

## Outcome

The owner-approved prompt lanes and lifecycle controls are implemented behind Honest Week's
existing validate, build, and configured-site output authority. The implementation remains local,
private by default, dependency free, and fail closed. It does not add a publisher, page shell,
network path, or target-site write.

The verified runtime checkpoint is `d0f8ca5`. Earlier focused checkpoints on this branch preserve
the staged contracts, current-week controls, bounded carry, recovery protocol, and operator-facing
documentation.

## Control model

### System state

The controlled state is the tuple below. A transition is valid only when every affected component
passes its own schema and the cross-component invariants.

| State component | Durable or derived form | Trust boundary |
| --- | --- | --- |
| Policy | normalized local configuration and fixed lifecycle policy | hard limits are validated before use |
| Current evidence | source-bound digest candidates and private prompt records | receipts and source projections are re-resolved locally |
| Review decisions | keeps, hidden rows, deletions, renewals, and privacy decisions | exact identities and allowed transitions only |
| Suppression history | no-text tombstones across current and carry stores | tombstone identity and authoritative deletion week |
| Carry history | at most 12 canonical weekly records with active and retired lineages | adjacent transitions and retained-base transitions are validated |
| Transaction state | hash-bound pending generation for output and carry | canonical, size-bounded, output-path-bound recovery state |
| Public artifact | existing configured output plus optional configured site emission | validate and build remain the sole output authority |

### Setpoints

The controller targets the seven approved rules without weakening Honest Week's older invariants:

1. Evidence eligibility and editorial worth are separate, disclosed decisions.
2. Individual and bulk deletion require confirmation, leave no-text tombstones, and regenerate only
   after an explicit reset.
3. Privacy triage has three outcomes: residual-low automatic surface, ambiguity kept private, and
   residual-high exclusion. Automatic edits cannot exceed 20 percent.
4. Digest categories remain separate. Automatic selections obey the target and category caps;
   disclosed explicit keeps may exceed them.
5. Unresolved ideas and next steps carry automatically for two following digests, manual renewal is
   one digest, terminal evidence retires a lineage, and history is limited to 12 weeks.
6. Output and carry advance through one hash-bound pending generation. Exact known states recover;
   mismatches and unknown states fail closed.
7. Completion requires a representative multi-week proof plus independent review.

### Observable sensors

The runtime sensors are strict schema validation, canonical date validation, exact item and lineage
identity, source receipt re-resolution, independently reconstructed eligibility signals, current
privacy re-gating, deterministic selection diagnostics, tombstone presence, adjacent carry
transitions, pending and output hashes, configured output-path binding, and write-boundary results.

The completion sensors are the model-free contract verifiers, syntax checks for every module, the
full Node test suite, the frozen representative-proof artifact, clean-room and added-egress scans,
the zero-dependency gate, and three independent review lenses.

### Control actions

The allowed runtime actions are prepare; keep or hide; confirmed individual or bulk delete;
explicit tombstone reset; one-digest renewal; validate and build; exact pending recovery; and
explicit pending discard followed by a fresh prepare and build. Atomic local replacement is the
only persistence actuator. No action sends, uploads, publishes, pushes, or writes a target site.

### Invariants

- Every visible row has a receipt. Current and carried local receipts must still resolve.
- Any unresolved, changed, unauthorized, display-role, or privacy-unsafe evidence aborts before
  output.
- A display-role repository is never Git-read.
- All strings are redacted before a written artifact.
- A deleted identity cannot reseed while any authoritative tombstone remains.
- A superseded retirement has one distinct active replacement. A terminally retired lineage cannot
  resume.
- Automatic recurrence, manual renewal, and retained history cannot exceed their approved bounds.
- Output and carry are either both prior, both advanced, or blocked by one recognized pending
  generation. Unknown or mixed pending state cannot influence carry.
- With lanes absent or disabled, older output remains byte-identical.

### Feedback cadence

Prepare measures sources, receipts, privacy, worth, and prior carry before proposing a review.
Every review action revalidates the exact state it changes. Validate and build re-resolve current
and carried evidence and current policy before any output transition. Recovery is checked whenever
a pending marker exists. Weekly carry applies one transition and then validates the bounded history.
Repository-wide tests, contract checks, clean-room checks, and independent review run at each
completion checkpoint.

### Stop and rollback criteria

The runtime stops with exit 2 and writes no new public artifact when evidence cannot be resolved,
privacy or identity validation fails, a carry transition is impossible, a display-role Git read is
requested, or recovery state is mismatched, mixed, malformed, noncanonical, oversized, or bound to
a different output. A write-boundary fault may leave a recognized pending generation, but that
generation blocks later carry decisions until exact recovery or explicit discard.

Implementation work does not advance past a red test, verifier failure, representative-proof drift,
or material review finding. The rollback unit is the latest focused local checkpoint. Any failure
that cannot be corrected without changing an approved rule returns to the owner instead of silently
relaxing a setpoint.

### Escalation conditions

Ambiguous privacy stays private. Persistent residual-high privacy is excluded and cannot be
approved around. A pending mismatch requires an explicit discard and fresh generation. An unknown
transaction state, unresolvable historical source, contradictory lineage history, or proposed
policy expansion requires operator or owner intervention. Persona ranking, a second publisher,
target-site mutation, generalization beyond the approved transform set, and network behavior remain
outside this controller.

## Auditable transition coverage

| Transition | Required pre-state | Observable post-state |
| --- | --- | --- |
| Automatic selection | eligible, strong, residual-low, edit at or below 20 percent | selected row, receipt, score reason, privacy audit |
| Ambiguous triage | strong but uncertain classification or transformation | private candidate and `needs-approval` diagnostic |
| High-risk triage | persistent residual-high result | excluded count, no public row |
| Delete and reset | exact identity plus confirmation | no-text tombstone, suppression, then explicit regeneration permission |
| Automatic carry | unresolved idea or next step inside two-following-digest window | same lineage, bounded week fields, revalidated source |
| Manual renewal | exact eligible identity and target week | one renewed digest, then no automatic extension |
| Replacement | same semantic lineage with a new current receipt | one distinct active item and one superseded audit row |
| Terminal retirement | exact terminal evidence for one active lineage | retired audit row and no later recurrence |
| Output and carry advance | validated pending generation and prior hashes | both new hashes match and pending is removed |
| Exact recovery | output already matches pending target and bindings remain current | pending carry promoted and marker removed |
| Unknown recovery | any unrecognized or mismatched state | exit 2, bytes preserved, explicit discard required |

## Representative proof

The frozen proof in `test/fixtures/representative-proof.expected.json` exercises both supported
session sources, all six categories, all three privacy dispositions, exact 20 and 21 percent edit
boundaries, disclosed caps and explicit keeps, individual and bulk deletion, reset, wrapper and
boilerplate suppression, duplicate replacement, two-week carry, one-digest renewal, terminal and
automatic-limit retirement, configured site output, and 12-week pruning across 13 weeks.

The proof's `automaticSafeShare` is the exact privacy-triage yield for this frozen fixture, not a
statistical calibration estimate or a claim about population performance. The closed-cue reading is
the predeclared acceptance and suppression coverage in `closedCueSuppression`; it makes no
precision/recall inference beyond the clean-room corpus.

The proof also injects failures at 17 pending, primary-output, phase-rewrite, carry, and final-remove
boundaries. Each observed outcome is prior state, fully advanced state, or recognized blocking
pending state. Separate negative controls cover mixed pending markers, path and policy rebinding,
prior-carry mismatch, malformed and noncanonical pending bytes, oversized state, and explicit
discard.

Canonical scanning removes closed-detector matches before they can persist. For that reason, the
persistent-high-risk negative control is an explicit post-scan integrity fault, not a claim that
ordinary discovery stores those strings. It injects nine residual-high candidates across all six
categories and proves that zero reach public output. The frozen proof records zero residual-high
candidates from the canonical scanner itself.

## Final sensor readings

| Gate | Reading | Result |
| --- | --- | --- |
| Full suite | 429 tests passed, 0 failed | PASS |
| Module syntax | 97 module files accepted by the current Node runtime | PASS |
| Reference contracts | 202 paths, 124 claims, 66 citations | PASS |
| Coverage contracts | 79 decisions, 123 revision inputs, 75 assignments, 4 declared exemptions | PASS |
| Boundary contracts | 13 boundaries, 6 invariant diffs, 3 checksummed coverage inputs | PASS |
| Negative verifier controls | reference and contract self-tests rejected their injected defects | PASS |
| Dependency boundary | no dependencies, development dependencies, optional dependencies, or lockfiles | PASS |
| Clean-room and egress diff scans | no personal-path/email additions and no added network primitives | PASS |
| Independent design review | no remaining material findings after one bounded corrective follow-up | PASS |
| Independent simplicity review | no remaining material findings | PASS |
| Independent statistical and proof review | no remaining material findings | PASS |

No push, merge, release, publication, upload, network call, external message, or target-site write was
performed as part of this implementation.
