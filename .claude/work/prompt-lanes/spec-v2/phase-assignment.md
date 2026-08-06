# Which decision lands in which phase

Authoritative. A phase spec that implements a decision not assigned to it, or omits one that is, is
a defect. Read `decisions.md` for the decisions themselves.

| Decision | P1 evidence substrate | P2 lane substrate + Lane A | P3 Lane B within-week | P4 cross-week carry |
| --- | :-: | :-: | :-: | :-: |
| D1 decomposition | (this table) | | | |
| D2 command boundary by content | build | | | |
| D3 MAX_GRADED_TURNS + stubs | build | consume (fail-closed rule) | | |
| D4 per-shape key whitelist scan | build | | | |
| D5 ref algebra (4 origins) | **mint all four** | strip before emit/archive | consume | consume (carry key) |
| D6 forward presence = authored ∪ engine | | define lane-presence rule | **apply to forward band** | consume |
| D7 engine forward prose gates | | provide gate functions | **apply** | re-apply on carry |
| D8 receipt on every lane row | | **build (Lane A) + restate invariant 1** | apply (Lane B) | apply (carried rows) |
| D9 grade labels | | build | | |
| D10 drop-loudly vs abort | | **build the two-class policy + `--no-lanes`** | apply | apply |
| D11 attach point | | **build** | inherit | inherit |
| D12 carry index | | | | **build** |
| D13 `strictLaneNouns` config key | **build** | consume | | |
| D14 noun check, quiet by default | | **build** | apply | apply |
| D15 modes + gate in every mode | | **build** | apply | |
| D16 contract strings, final wording | | **author all four branches once** | fill rule 8 body only | |
| D17 AGENTS.md | invariant 6 restatement | invariant 1 restatement | | |
| D18 SKILL.md sidecar + eligibility | | **build (rules 7 and 8 both reserved)** | fill rule 8 | |
| D19 hermetic golden harness | **build** | extend | extend | extend |
| D20 sidecar shape + bounds + gitignore | **build** | validate reads it | | |
| D21 two MAX_IDEAS constants | build | | | |
| D22 committed draft baseline | **build** | | | |
| D23 `repoKey` on windows | **build** | consume | consume | |
| D24 throwing lookup is unresolved | | build | apply | apply |
| D25 `total` and the no-sessions line | | build | apply | |
| D26 `turn: null` pre-boundary idea | emit | | consume | |
| D27 `opensWithCorrection` | **build** | consume | | |
| D28 one shared re-derivation | | **build** | consume | consume |
| D29 `forwardOpen` conditional | | | **build** | consume |
| D30 copy gate run floor | | **build** | apply | apply |
| D31 validate week check | emit envelope | **build** | | |
| D32 display-repo two-part rule | | **build** | apply | apply |
| D33 verify-refs discipline | applies | applies | applies | applies |
| D34 forward-row ids | | | **build** | consume |
| D35 taxonomy + pill primitive | | **build** | instantiate only | |
| D36 one row per shapeKey group | | **build** | | |
| D37 15-key window shape | **build** | consume | | |
| D38 stubs carry no ref, no sidecar row | **build** | consume | | |
| D39 cues, shapeKey, bounds, complete causes | **build** | consume | consume | |
| D40 ref index is a string segment | **mint** | consume | consume | consume |
| D41 opensWithCorrection reuses redirect patterns | **build** | consume | | |
| D42 next-step headings, bound, precedence | **build** | | consume | |
| D43 reversal section provenance | **build** | | consume | |
| D44 ideasDropped count | **build** | | consume | |
| D45 dispositionAsOf is the week start | | | **build** | consume |
| D46 forwardUnactioned count | | | **build** | consume |
| D47 authored row supersedes engine row | | | **build** | consume |
| D48 ruled out beats picked up | | | **build** | |
| D49 unresolvable evidence keeps the row | | **build** | apply | apply |
| D50 one shared lane commit resolver | | **build** | consume | consume |
| D51 noun warning count-only, tools excluded | | **build** | apply | apply |
| D52 changelog lane notice | | **build** | apply | |
| D53 copy-gate false-positive check | | **build** | | |
| D54 SKILL rule 8 single producer | | reserve number only | **author body** | |
| D55 cross-phase export contracts | | **build** | **build** | consume |
| D56 closedBy is a reversal ref | | | **build** | consume |
| D57 sourceKind provenance | | | **build** | consume |
| D58 corpus scan unconditional | | | provide | **build** |
| D59 normalizePhrase and FILLER exact | **build** | consume | | |
| D60 README neither-lane string keeps backticks | | **build** | | |
| D62 closedBy is a pointer, not a disposition | | reserve only | **build** | consume |
| D63 stdout byte-identical when lanes absent | | **build** | apply | apply |
| D64 file-level failure reports no count | | **build** | apply | apply |
| D65 repo is derived, never authored | | provide | **build** | consume |
| D67 technique-row identity | | **build** | | |
| D68 ideasDropped is the truncation signal | **build** | consume | consume | |
| D69 hash collisions detected, never assumed | **build** | consume | consume | consume |
| D70 copy-gate false-positive corpus is pinned | **build** | consume | | |
| D71 reversal-bearing draft baseline | **build** | | | |
| D72 FILLER is an exact closed token list | **build** | consume | | |
| D73 build-local identity carrier + validator | **build** | consume records | consume checked index | validate persisted identities |
| D74 exact cross-phase values + Phase 3 result | **build assistantTurns** | **build receipt helper** | **build Forward shape and result** | consume result |
| D75 raw presence owns stdout | | define authored technique presence | **provide authored/engine presence** | consume without overriding |
| D76 source-receipt invariant | | **restate and build Lane A** | apply Lane B | apply carry |
| D77 Phase 2 owns forward metadata wording | | **author formatter and copy** | provide pointer receipt | provide firstSeenWeek |
| D78 opaque build copy-run index | | **build** | consume | consume |
| D79 typed diagnostic units + capable controls | **provide modal controls** | **build diagnostic units** | apply | apply |

## Decisions that bind no phase

Every decision above must be cited by each phase it is assigned to. These four are deliberately not
assigned, and each states why. `verify-coverage.mjs` reads this list, so an exemption cannot be
added silently.

| Decision | Why it binds no phase |
| --- | --- |
| D1 | It **is** this table. Nothing implements it. |
| D33 | Spec-authoring discipline, not build work. It binds every phase spec's citations, which `verify-refs.mjs` checks directly. |
| D61 | It **removes** the redact-before-truncate reorder from this feature. It lands as its own issue and its own PR, before Phase 1. No phase here implements it. |
| D66 | Corrects D33's description of the verifier. Same cross-cutting character as D33, checked by the tool rather than by a phase. |

## Phase 1 also owns

- `lib/handoffs.mjs`: extract `nextSteps[]`, and change the drop guard so a handoff carrying only a
  next-steps section is no longer dropped. This is an intended behaviour delta on existing repos and
  goes in the PR body.
- `lib/init.mjs` and the committed `.gitignore`.
- The two committed baseline artifacts (D22, D71) and the pinned copy-gate corpus (D70), all captured
  from pre-change behaviour before any lane code exists.

## What Phase 1 does not own any more

The redact-before-truncate reorder at every adapter mining site is **out of scope for this feature**
(D61). It changes existing draft bytes with no lane input present, so it is not additive, and no
restatement of `AGENTS.md` invariant 6 makes it so. It ships as its own issue and PR with its own
stated blast radius, before Phase 1. Inside the lanes work, redaction-before-truncation applies only
to the new fields.

## Phase 1 renders nothing

Phase 1 changes **zero** rendered bytes. Its acceptance includes the full six-mode golden set being
byte-identical before and after, over the frozen corpus. If a phase 1 requirement changes a rendered
byte, the requirement is wrong.

## What each phase must not do

- P1 must not add a rendered band, a badge vocabulary, or a config key beyond `strictLaneNouns`.
- P2 must not touch the carry index, `forward[]`, or any handoff-sourced row.
- P3 must not reword a contract string, renumber a SKILL rule, or add a second pill render system.
- P4 must not change any within-week rendering path.
