# Phase 3: Lane B, within-week

## In plain terms

Phase 3 gives honestweek a closing section for ideas and session-end notes from one completed week.
It combines authored idea rows with next steps and reversals the program finds in handoffs, even when
the items file has no forward section. The program checks where every row came from, derives the
most cautious disposition the evidence supports, and shows a session or handoff receipt on the
line. The section stays visibly separate from verified work and uses the wording and rendering rules
already settled in Phase 2. This phase closes issue #52 items 4 and 5; carrying a row into another
week remains Phase 4 work.

## Scope

- D5 (R1, R3, R8).
- D6 (R2, R7, R10).
- D7 (R2, R6).
- D8 (R3, R9, R11).
- D10 (R3, R6, R7, R12).
- D11 (R8).
- D14 (R6, R12).
- D15 (R6, R9, R10).
- D16 (R5, R9, R10).
- D18 (R3, R12, R13).
- D19 (R15).
- D23 (R1, R4).
- D24 (R4).
- D25 (R9, R10, R14).
- D26 (R1, R4, R11).
- D28 (R1, R7).
- D29 (R14).
- D30 (R6, R12).
- D32 (R6, R12).
- D34 (R2, R3, R16).
- D35 (R4, R9).
- D39 (R1, R6).
- D40 (R1, R3).
- D42 (R1, R2).
- D43 (R1, R2).
- D44 (R1, R6).
- D45 (R5, R16).
- D46 (R14).
- D47 (R2, R3).
- D48 (R4).
- D49 (R3, R4).
- D50 (R4).
- D51 (R6).
- D52 (R9).
- D54 (R13).
- D55 (R1, R4, R6, R9, R16).
- D56 (R3, R13, R16).
- D57 (R2, R8, R16).
- D58 (R1, R7, R16).
- D62 (R3, R4, R9, R13).
- D63 (R10).
- D64 (R6, R12).
- D65 (R1, R3, R16).
- D68 (R1, R6).
- D69 (R1, R3, R8, R16).

## Out of scope

- Do not read, write, migrate, gitignore, or document `honestweek.forward-index.json`. Do not build
  deferred rows, the zombie rule, carry re-gating, prior-week lookup, cumulative history, or any
  other D12 behavior. Those belong to Phase 4.
- Do not change any Phase 1 ref formula, cue, bound, window shape, handoff extraction rule, sidecar
  shape, or ref-bearing handoff array. Consume D43's `sectioned` discriminator and D44's
  `ideasDropped` count exactly as Phase 1 emits them.
- Do not reword any Phase 2 heading, row form, authorship label, legend entry, empty-state sentence,
  build-summary sentence, contract string, receipt form, or invariant.
- Do not renumber, retitle, or add a SKILL rule. Phase 2 leaves rule 8 non-actionable and publishes
  no forward shape; this phase authors only the reserved rule 8 body and its shape under D54.
- Do not add a second pill, legend, class-map, badge, or lane-row rendering system. Phase 3 only
  instantiates Phase 2's parameterized primitive with `DISPOSITIONS`.
- Do not add, remove, or reorder a member of `STATUSES`, `TECHNIQUE_GRADES`, `DISPOSITIONS`, or
  `RESERVED_FOR_WORK_LANE`.
- Do not render Lane B in `site` or `changelog`, add a lane root to the site bundle, or weaken the
  gate in either mode.
- Do not route a forward row through work-item sorting, grouping, badge, receipt, total, or archive
  item-count code.
- Do not add a config key, dependency, lockfile, install step, network access, telemetry, publish
  action, or API unavailable in Node 18.

## Requirements

R1. Consume Phase 2's exact D55 `ensureLaneCorpus()` result without renaming keys, changing types, or
building a second projection. Whenever lanes are enabled, invoke that memoized operation exactly once
per build even when both authored lane arrays are absent. Use its sessions, handoffs, file-count
state, D78 copy-run index, and D73 carrier records to derive the D6 `engineForwardRows` collection
before any Phase 4 fast
path can run. Build the current-week ref lookup only by calling D73's exact Phase 1 export
`buildValidatedRefIndex(records)` over session ideas, `handoffs[].nextSteps`, and
`handoffs[].reversalRefs`; retain each record's D69
canonical identity until the private Phase 4 boundary. Validate every pair with D73's shared
validator and abort before any join on a mismatch or ref collision.
Retain the source session id or handoff id, the D65 source repo label, and, for an idea, its
number-or-null turn; retain `sectioned` on reversals. A numeric idea may use only its own indexed
window and `repoKey`; a null-turn idea has no window. Treat `ideasDropped > 0` as the sole
truncation-presence signal and `ideasTruncatedAtTurn` only as location context. Do not parse or
re-mint a ref, and do not add another transcript or handoff scan. (D5, D23, D26, D28, D39, D40,
D42, D43, D44, D55, D58, D65, D68, D69, D73, D78)

R2. Form one current-week candidate union from resolved authored rows plus the D6 engine rows
produced by R1. Every D42 next step and every D7-eligible reversal remains an engine candidate when
the items envelope omits `forward` or carries `forward: []`. Mint every candidate's private D57
`sourceKind` in Phase 3, using `authored` for an authored row and `engine` for a handoff-derived row;
do not infer it from an id. Give an engine row its D34 id, settled origin, source text, and D8
handoff receipt. Only `reversalRefs` records with `sectioned: true` enter the union. Enforce D47
after the collision-safe R1 lookup and before publication: an authored row suppresses an engine row
with the same ref, while the abort cases remain aborts. (D6, D7, D8, D34, D42, D43, D47, D57)

R3. Accept authored input only from the top-level `forward` array under D6's presence predicate and
validate D74's exact required `{ id, ref, text, origin, receipt }` keys and sole optional
`closedBy` key. Reject unknown or author-controlled derived fields. Resolve its copied `ref` through
R1. The resolved
source, never authored values, determines `origin`, `receipt`, and the required D65 `repo`; an
authored value that conflicts with any of those derived values is rejected through the D10
structural row-drop path, and an agreeing authored `repo` is still replaced by the derived label.
A missing source repo is an unresolvable identity, so no private forward row may cross R16 without
one. Validate `closedBy`, when present, only as D56's reversal ref. Resolve it through the same
collision-safe R1 index: a match is retained as a private D62 pointer and does not affect
disposition, while a missing target is D56's exit-2 abort with no output. Enforce D34 id uniqueness
and D47 ref uniqueness over the unsuppressed union before same-ref suppression. Ignore authored
`disposition`, `dispositionAsOf`, and `sourceKind`; they never change derived bytes. (D5, D8, D10,
D18, D34, D40, D47, D49, D56, D57, D62, D65, D69, D74)

R4. Derive current-week disposition in `lib/lanes.mjs` from the resolved R1 source. For a numeric
idea, evaluate D35's commit predicate only through Phase 2's one D50 `resolveLaneCommit` export and
only against that idea's own window. Consume its exact D55 return shape and all six D50 states; only
`resolved-authored` may support `picked up`. Every other state takes the D49 under-claim path, and
the shared resolver must make the display-role state without a git call. A pre-boundary idea and a
handoff next step have no qualifying turn window. A row whose own resolved source is a D7-eligible
reversal is `ruled out`; a D62 `closedBy` pointer never supplies that disposition. Phase 3 never
derives `deferred`. Apply D48 only when both competing disposition signals are engine-derived.
Return failed optional commit resolution in D74's `diagnostics.commitResolutionFailures`, counting
a row once even if several lookups throw or do not resolve; do not drop the identity-resolved row.
(D23, D24, D26, D35, D48, D49, D50, D55, D62, D74, D79)

R5. Add `dispositionAsOf` to every derived current-week row before attachment, and pass it unchanged
to the final Phase 2 formatting policy. Set it to the ISO date string in the normalized build
`week.start` created at `lib/build.mjs:276`, identical on every row the build emits. Do not accept an
authored value or derive a second date. (D16, D45)

R6. Consume the four exact Phase 2 D55 text-gate exports on every row that survives R2 and R3; do
not wrap them in differently shaped Lane B helpers or translate their diagnostics. Authored rows
receive D30 copy checking plus the D7 gate set. Engine rows receive only D7's source and gate set.
Apply every gate before the emit try block in all six modes. Apply D51 to noun diagnostics: the
default output is count-only, identifies affected row ids, never includes a token or row text, and
uses the settled tool exclusions; strict mode and every other positive dishonesty hit abort with
exit 2 and no output. Treat a parseable row-level drop under D64 as count-bearing. Report idea
truncation only when `ideasDropped > 0`, using D44's exact count even when
`ideasTruncatedAtTurn` is null. Report D49's failed commit-resolution count without dropping those
rows or describing them as dropped. Populate only D74's four typed diagnostic arrays, with D79's
units, source-order stability, id deduplication, and no sensitive prose. (D7, D10, D14, D15, D30,
D32, D39, D44, D49, D51, D55, D64, D68, D74, D79)

R7. Extend Phase 2's one re-derivation and `--no-lanes` implementation rather than adding a Lane B
scan or flag branch. Per D58, every lanes-enabled build calls the shared corpus operation once
before it knows whether engine rows exist, including when both authored arrays are absent; a
both-lanes build still shares the same result object and each primary reader runs once. Validate
still skips the sidecar when no authored lane is present. `--no-lanes` is the only branch that
suppresses all lane corpus readers, gates, counts, and rendering. Every new lane diagnostic names
`--no-lanes` and never echoes source or authored prose. (D6, D10, D15, D28, D58)

R8. Keep the final private current rows intact through the R16 Phase 4 boundary, then attach only a
non-empty public `forward` projection through D11: after report/page model construction and before
`deepRedact`, never inside report-model assembly, never after redaction, and never on the site path.
The current base-model assembly is at `lib/build.mjs:323`; site augmentation is at
`lib/build.mjs:393`; page construction and redaction are at `lib/build.mjs:423` and
`lib/build.mjs:424`; the markdown redaction call is at `lib/build.mjs:443`. Before attachment,
strip `ref`, the D69 canonical identity, `id`, and D57 `sourceKind`. Resolve a valid D62 pointer to
its D8 handoff receipt and pass only `closedByReceipt` into D77's Phase 2 formatter, then strip its
reversal ref as well. No emitter, site bundle,
or archive snapshot may receive any local-only key or known local-only value. (D5, D8, D11, D34,
D57, D62, D69, D77)

R9. Consume Phase 2's exact D55 `renderPillSet` contract and its final Lane B formatting policy;
instantiate it with `DISPOSITIONS` without adding a renderer, pill template, or selected-value
adapter. Render below work and Lane A in `digest`, `report`, `page`, and `post`; render no lane row in
`site` or `changelog`. Render a valid D62 pointer beside its current row through the settled
transcript-receipt helper, without changing disposition. A lane-bearing `changelog` build emits
D52's one-line ignored-row notice with the mode and the exact sum of Phase 2 technique rows plus
final forward rows; Phase 3 supplies only its final forward-row count to that shared notice. No
forward row may enter the work-only helpers rooted at `lib/emit/_shared.mjs:28` and
`lib/emit/_shared.mjs:89`, and HTML uses the one Phase 2 pill primitive rather than the current
work-only span site at `lib/emit/page.mjs:369`. (D8, D15, D16, D25, D35, D52, D55, D62)

R10. Compute `hasForward` from the final post-drop authored-engine union and pass only that boolean
to Phase 2's settled contract-copy and empty-state helpers. Do not edit any matrix cell. Keep the
work item count at `lib/emit/index.mjs:122` and archive `countItems` at
`lib/archive.mjs:17` work-only. Apply D63 to stdout: preserve the pre-lane build summary byte for
the exact case where both authored lane arrays and all engine rows are absent, and use Phase 2's
extended lane summary only when at least one authored lane is present or an engine row exists before
later drops. Retain that raw fact in D74's `laneInputPresence`; Phase 4 cannot replace it with final
presence. A forward-present build supplies the exact final forward-row count. (D6, D15, D16, D25,
D63, D74, D75)

R11. Render every forward row through Phase 2's transcript-receipt helper. A numeric-turn idea uses
the final visible session-and-turn form, a D26 null-turn idea uses the final session-only form, and
both handoff origins use the final handoff form. Treat a missing or malformed derived receipt as a
build error before rendering. Session ids remain legitimate visible eight-hex values even though
refs are stripped. Private/display/session-only work continues to follow D76 and is never forced
onto a Git receipt path. (D8, D26, D76)

R12. Add a sibling forward validator at the item extraction boundary currently at
`lib/validate.mjs:187`; do not widen work-item validation. Validate the R3 authored shape,
union-independent id rules, `closedBy`'s D56 string type, configured terms, D32 display checks, D30
copy gate, D14/D51 noun behavior, and the sidecar states already settled in Phase 2. Validate cannot
authenticate a handoff ref, a D65 source repo, or a `closedBy` target from the prompts sidecar, so
build's R1/R3 resolution remains authoritative. Structural failures drop authored rows per D10
except D34 duplicate ids, which abort. Apply D64 at this file boundary: an absent or unparseable
sidecar produces a count-free band diagnostic; a parseable row-level rejection carries the exact
derived count. (D10, D14, D18, D30, D32, D34, D47, D49, D51, D56, D64, D65)

R13. Author the reserved SKILL rule 8 body and the Forward item shape in Phase 3, and nowhere else.
Keep Phase 2's number, title, position, and exact eight-rule count unchanged. The body and shape
list D74's five required keys, sole optional `closedBy`, exact scalar/receipt types, and prohibited
derived/unknown keys. The JSONC example contains no other key. They implement the R3 authored
contract without publishing an author-controlled `repo`, an authored
disposition, or an actionable Phase 2-era forward rule. Do not edit rule 7 or any settled flow-step
text. (D5, D8, D16, D18, D34, D54, D56, D62, D65, D74)

R14. Add numeric `forwardUnactioned` to the archive index entry through D29's conditional spread
only when the final forward band is present. Its value is the count of final forward rows whose
disposition is `not started` or `deferred`. Do not change work-only `items`, and keep lane-absent
snapshot and index bytes identical. The current snapshot serializes its supplied model at
`lib/archive.mjs:51`, and the fixed index entry is pushed at `lib/archive.mjs:56`. Do not add the
Phase 4 carry index while making this change. Snapshot checks also reject D57 `sourceKind`, D69
canonical identity, and any `closedBy` reversal ref. (D25, D29, D46, D57, D62, D69)

R15. Extend the D19 harness with Phase 3-only sessions and handoffs under the separate lane fixture
root. Do not modify the frozen corpus or Phase 1/2 goldens. Keep fixed time, isolated
`CLAUDE_CONFIG_DIR`, and independently constructed repos with pinned author and committer identity
and dates. Use only Node 18 APIs, Node built-ins, and the system git CLI; normalize paths, keep every
fixture clean-room, and run both spec verifiers. (D19)

R16. Export
`deriveCurrentForwardRows(authoredForwardRows, laneCorpus, config, week, resolveLaneCommit)` from
`lib/lanes.mjs` as the one exact private Phase 4 boundary after all within-week joins, derivation,
gates, and uniqueness checks. `laneCorpus` is the unchanged Phase 2 D55 result and
`resolveLaneCommit` is the exact D50 function object shared with Lane A. Return D74's exact object
`{ finalPrivateRows, engineForwardRows, laneInputPresence, diagnostics }`; never return the legacy
two-element tuple and never use hidden mutable state. `engineForwardRows` is the original D6 engine
collection with D74's exact member schema, not a recomputed boolean or authored-array proxy.
`laneInputPresence.authoredForward` is the D6 predicate over the raw authored input and
`engineForward` is `engineForwardRows.length > 0`, both captured before later drops. Every member of
`finalPrivateRows` has exactly
these settled string-keyed fields: required `id`, `ref`, `text`, `origin`, `receipt`, `repo`,
`disposition`, `dispositionAsOf`, and `sourceKind`, plus optional `closedBy`. The D69 canonical
identity remains associated with each ref in the shared index through this private boundary and is
not an additional row key. `sourceKind` survives until Phase 4 finishes D47 merging, while D57 bars
it from the D12 index and every public projection. Phase 4 may skip only its carry-index reader and
writer after the already-completed D58 scan returns empty row arrays and no carry index exists.
Diagnostics are D74's four exact arrays, returned in source order with no sensitive text, and all
later reporting consumes them directly. (D6, D34, D45, D50, D55, D56, D57, D58, D65, D69, D74,
D75, D79)

## Acceptance criteria

A1. `node --test` from the repository root exits 0. (R15)

A2. For each of `undefined`, `null`, and `[]`, authored forward presence is false, validate reads no
sidecar, and a lanes-enabled build calls the shared corpus operation exactly once before determining
engine presence; when the D55 result contains no next step or eligible reversal, build attaches no
forward key and passes an empty `engineForwardRows` collection through R16. (R2, R7, R16)

A3. A fixture with no authored forward row, no handoff next step, and no D7-eligible handoff
reversal is byte-identical to the Phase 2 goldens in all six modes and in both archive snapshot and
archive index. (R10, R14, R15)

A4. Supply the exact Phase 2 D55 `ensureLaneCorpus()` fixture with one session, one handoff, a
nonzero file-count state, and its identity list. Calling it from both lane derivations invokes
`adaptSessions` and `discoverHandoffs` exactly once each, returns the same object identity, and
Phase 3 consumes each value through its Phase 2 key and type without a fallback alias. (R1, R7)

A5. A table over authored-engine row counts `(0,0)`, `(1,0)`, `(0,1)`, and `(1,1)`, using distinct
refs whenever both sources are present, deep-equals forward presence `[false,true,true,true]`, and
the gate and renderer observe the same result. (R2, R10)

A6. Feed Phase 3 this exact three-source input. The session source is id `aaaaaaaa`, repo
`your-project`, turn `0`, and idea ref `ef23d3cc`, minted from D73's NUL-joined canonical segments
`idea`, `aaaaaaaa`, and `0:0`. The authored items row is
`{ "id": "forward-review-rollout", "text": "Review the rollout boundary", "origin": "you",
"receipt": { "sessionId": "aaaaaaaa", "turn": 0 }, "ref": "ef23d3cc" }`. Handoff
`handoff-a` in repo `your-project` contributes
`{ "ref": "d1930f56", "text": "Check the release checklist" }` in `nextSteps`, and handoff
`handoff-b` in the same repo contributes
`{ "ref": "0467e97f", "text": "Drop the unused fallback", "sectioned": true }` in
`reversalRefs`. One derivation produces exactly three rows with origins
`['you','handoff-next-step','handoff-reversal']`, source kinds
`['authored','engine','engine']`, derived repo `your-project` on all three, and dispositions
`['not started','not started','ruled out']`. Omitting the exact authored items row removes the idea
row while retaining both handoff rows. (R1, R2, R3, R4)

A7. With no authored `forward` key, a handoff whose only content is one bullet under `## Next
steps` renders that text as a `handoff-next-step` row in the one closing band in `digest`, `report`,
`page`, and `post`; the row has a handoff receipt, the Phase 2 carried-forward label, and no work
status class. This is the acceptance criterion that closes issue #52 item 4: handoff next steps
render as a closing carried-forward band, visibly distinct from badged claims and never presented as
a verified claim. (R2, R9, R11)

A8. With no authored `forward` key, one bullet inside a matching reversal section reaches Phase 3
with `sectioned: true` and renders as a `handoff-reversal` row with `ruled out` in `digest`,
`report`, `page`, and `post`, while `README.md:12` still states that honestweek surfaces dead ends.
This is the acceptance criterion that closes issue #52 item 5: mined reversals reach the output and
the existing README promise agrees with the render. (R1, R2, R4, R9)

A9. A line matched only by the free-floating branch at `lib/handoffs.mjs:88`, outside every
reversal section, reaches Phase 3 with `sectioned: false`, remains draft-only, and appears in no
rendered artifact or archive snapshot. (R1, R2, R6)

A10. With `strictLaneNouns: true`, put exact text `Drop Unlistedtoken before release` inside the A8
heading-scoped handoff reversal. Build exits 2 and leaves every rendered artifact and archive
snapshot absent. (R6)

A11. Using the A6 idea source, change exactly one authored value at a time: origin `assistant`,
receipt turn `1`, or repo `other-project`, where `other-project` is a configured non-display repo.
Each conflicting row is rejected with the exact D10 row-drop template. The A6 row with no authored
repo and the otherwise identical row with agreeing repo `your-project` each render once with the
source-derived repo; a resolved source with no repo label drops before R16. (R3)

A12. The Phase 1 D73 refs `68ad2586` and `6d38691a` produce engine ids
`forward-handoff-next-step-68ad2586` and `forward-handoff-reversal-6d38691a`; malformed authored
ids are structural drops, and any duplicate id across the full authored-engine union exits 2 and
writes nothing. (R2, R3)

A13. For an idea from session `aaaaaaaa` at turn `0`, use only window 0 with
`{ repoKey: 0, commitShas: ['aaaaaaa'], inspectedShas: [] }` and exercise the real shared D50
resolver with these capable inputs in order: an authored commit in configured repo 0, a
wrong-author commit in repo 0, an unresolved SHA in repo 0, an unusable non-display repo 0, a
missing `repoKey`, out-of-range `repoKey: 99`, and a display-role repo 0. The returned state order is
`['resolved-authored','resolved-other-author','unresolved','unusable-repo','no-repo-key',
'no-repo-key','display-role']`; the disposition order is
`['picked up','not started','not started','not started','not started','not started','not started']`,
and the display-role case makes zero git calls. Moving the authored commit to window 1, putting it
only in `inspectedShas`, setting the idea turn to null, using a handoff next step, and using an idea
with no commit signal each yield `not started`; a row whose own source is a heading-scoped reversal
yields `ruled out`. (R4)

A14. A table with two identity-resolved idea rows, one whose actual configured repo makes
`lookupCommit` throw and one whose SHA is unresolved in a usable repo, deep-equals two rendered
`not started` dispositions and `diagnostics.commitResolutionFailures` containing those two row ids
once in source order with closed reason codes; neither row appears in `rowDrops`. A third
wrong-author row is `not started` but does not enter either diagnostics array.
(R4, R6)

A15. The final private rows from A6, A13, A14, and A17 contain no `deferred` disposition; changing
the derivation fallback to `deferred` makes this criterion fail. (R4)

A16. Given build week `{ start: '2026-01-05', end: '2026-01-11' }`, every derived row owns
`dispositionAsOf: '2026-01-05'`, ignores an authored value, and renders that same string in the exact
Phase 2 date slot. (R5, R9)

A17. Start from two authored idea rows backed by numeric-turn sources: one satisfies D35 and one has
no pickup evidence. Give each the exact `closedBy: "0467e97f"` pointer to A6's distinct sectioned
reversal. They retain dispositions `picked up` and `not started`, respectively, and each renders
`closed by` with handoff `handoff-b`; the cited reversal still renders separately as its own
`ruled out` engine row. Removing `closedBy` removes only the pointer. Replacing it with unmatched
ref `ffffffff` exits 2 and writes nothing. (R3, R4, R8, R9)

A18. Each authored copy hit, configured-private-term hit, display-role repo-field hit,
display-label-in-text hit, strict noun hit, and enabled keyed voice hit exits 2, writes no artifact
or archive, names only the row id, and includes `--no-lanes`. (R6, R12)

A19. A single row id `forward-noun-check` with text `Try Unlistedtoken after review` under default
noun policy emits exactly one count-only summary naming that row id and count `1`, never includes
`Unlistedtoken` or the row text in that diagnostic, and still renders the row. The identical strict
input satisfies A18.
(R6, R12)

A20. `build --no-lanes` and `validate --no-lanes` skip all forward readers and gates, suppress
engine and authored rows, and byte-equal the Phase 2 work-only artifacts and stdout without adding a
carried-forward count. (R7, R10)

A21. With exactly two valid authored forward rows in the items file, an absent prompts sidecar and
the literal invalid JSON `{` each produce a count-free band diagnostic naming the sidecar and the
reason. A parseable sidecar for a different week produces a row-level diagnostic with exact dropped
count `2`. No case fabricates an engine row or echoes authored text. (R12)

A22. Use the A6 input, whose final forward count is `3`, plus exactly one valid Phase 2 technique
row in all six modes. Every mode runs both gates; only `digest`, `report`, `page`, and `post` contain
lane text. `site` contains none, and `changelog` contains none while stderr has exactly one line
naming mode `changelog`, ignored row count `4`, and `--no-lanes`. Removing the technique changes
only that notice count to `3`. (R6, R9)

A23. The exact idea, next-step, and reversal ref values collected from R1 occur in no rendered
artifact and no archive snapshot; no attached or archived forward row retains `ref`, D69 canonical
identity, `id`, D57 `sourceKind`, or a `closedBy` ref. The resolved `closedBy` handoff receipt and
visible eight-hex session receipts remain present. A configured redaction term injected after the
forward gate is scrubbed by the shared `deepRedact` backstop in every rendering mode and the
snapshot. (R8, R11, R14)

A24. A table over numeric-turn idea, null-turn idea, and both handoff origins deep-equals the final
Phase 2 visible receipt forms in Markdown and HTML, and every HTML receipt has
`wl-transcript-receipt`. (R9, R11)

A25. Pure rendering tests use one current row for each settled origin plus the two A17 pointer rows,
and deep-equal the exact Phase 2 Lane B heading, all three Markdown forms, four legend entries,
authorship mapping, as-of placement, HTML visible parts, pointer placement, and escaping policy.
(R9)

A26. In every rendering mode the forward band begins after the final work row, the applicable
lane-aware empty sentence, and Lane A, and before the contract footer or end copy; no forward object
reaches `badge`, `renderItemLine`, or `allItems`. (R9, R10)

A27. A source scan still finds exactly one HTML template containing `class="wl-badge`, every
forward HTML row uses the `DISPOSITIONS` instantiation, and no forward HTML contains
`is-shipped`, `is-progress`, or `is-designed`. (R9)

A28. The twelve outputs from Phase 2's four-presence-by-three-surface contract test remain
byte-identical after Phase 3 wires the actual forward boolean. (R10)

A29. A model with zero work rows, zero technique rows, and exactly one valid forward row keeps the
work item count and archive `items` at zero, prints Phase 2's exact Lane-B-only empty sentence, and
reports exactly one carried-forward row in Phase 2's extended build summary. The same fixture with
that forward source removed prints the exact pre-lane stdout byte instead of the extended summary.
(R10, R14)

A29b. A nonempty authored `forward` array whose only row takes R3's structural drop path leaves the
final forward collection empty but retains `laneInputPresence.authoredForward: true`. It renders no
band and reports zero final forward rows through the extended stdout form. The otherwise identical
input with `forward: []` uses the byte-identical legacy stdout form. (R3, R10, R16, D75)

A30. A populated valid forward build leaves both the input and return of `augmentSiteModel` without
a `forward` key and produces site bytes equal to a same-run lane-free control. (R8, R15)

A31. Archive index entries omit `forwardUnactioned` when the band is absent. Given a present band
with dispositions `['not started', 'deferred', 'picked up', 'ruled out']`, the index contains numeric
`forwardUnactioned: 2`, while `items` remains work-only and the snapshot contains none of
`sourceKind`, a D69 canonical identity, or a `closedBy` ref. (R14)

A32. The Phase 2 control has exactly eight numbered rules but rule 8 contains only its reserved
number, title, and non-actionable marker, with no Forward item shape. After Phase 3, `SKILL.md`
still has exactly eight rules; rule 8 keeps that number and title, the non-actionable marker is
gone, the R3 Forward item shape is present, and no rule except rule 8 differs from the Phase 2
control. (R13)

A33. Every Phase 3 fixture lives outside the frozen golden corpus and passes the repository's
clean-room scans. (R15)

A34. Running
`node .claude/work/prompt-lanes/spec-v2/verify-refs.mjs . .claude/work/prompt-lanes/spec-v2`
exits 0. (R15)

A35. A dedicated session fixture places exactly 43 idea-cue blocks before its first turn boundary,
so Phase 1 supplies `ideasDropped: 3` and `ideasTruncatedAtTurn: null` after its session cap. Lane B
emits the truncation diagnostic with exact dropped count `3` despite the null location. The same
fixture trimmed to 40 blocks supplies `ideasDropped: 0` and emits no truncation diagnostic.
(R1, R6)

A36. A table over ref collisions deep-equals these D47 outcomes: an authored row and engine row with
the same ref but different ids and source kinds `authored`/`engine` produce only the authored row;
two authored rows with the same ref but different ids exit 2 and write nothing. The surviving
private row carries `sourceKind: 'authored'` through R16. (R2, R3, R16)

A37. An authored row whose ref matches no R1 record takes the exact D10 identity-drop path, while
the two optional-evidence failures in A14 retain both identity-resolved rows. (R3, R4)

A38. Run an end-to-end default-policy build over the full Phase 3 fixture corpus, including one
valid row whose text is `Use Bash, Edit, Read, Write, Grep, Glob, and Task during review`. It emits
zero noun warnings. Replacing only `Task` with `Unlistedtoken` produces A19's one count-only
warning, proving the zero is caused by the settled exclusions rather than an unexercised gate.
(R6, R15)

A39. With authored arrays absent and one A8 sectioned reversal in the D55 corpus, R16 returns D74's
object whose `finalPrivateRows` and original `engineForwardRows` each have length `1`, whose presence
is `{ authoredForward: false, engineForward: true }`, and whose diagnostics have exactly four empty
arrays; the row renders and each primary corpus reader was called once. With authored arrays absent,
no handoff candidates, and no carry index, both row arrays are empty and both presence fields false
after those same readers were each called once; only the Phase 4 carry reader and writer are eligible
to be skipped. A proxy rejects a missing or extra result key. (R1, R2, R7, R16)

A40. Build one valid authored row and one distinct engine row from A6. Before publication, a
sorted property-key deep equality on each private row matches R16's exact required set with no
unknown string key, the values include `sourceKind` values `authored` and `engine`, and both repos
are source-derived. The shared index still returns each row's D69 canonical identity. After the
Phase 4 boundary, A23 and A31 prove those local-only values are absent from public and archive
shapes. (R2, R3, R8, R14, R16)

A41. Reuse Phase 1's two checked-in D69 literal records whose hashes are equal and canonical
identities differ. Put both in the exact D55 corpus result and run the real shared ref-index builder:
build exits 2 before authored resolution, disposition grading, rendering, or archive writing. A
control containing either record alone resolves normally. No test stubs the hash function.
(R1, R3, R15)

A42. Inject one function object with D50's exact signature and return shape into both lane graders.
For each of the six D50 states, give both graders a qualifying row backed by the same repo condition
and assert the spy sees both consumers, `resolved-authored` is the only positive commit result, all
five other states under-claim, missing and out-of-range keys share `no-repo-key`, and
`display-role` makes zero git calls. A source scan finds exactly one exported lane commit resolver
and no lane-local git lookup. (R4)

A43. Running
`node .claude/work/prompt-lanes/spec-v2/verify-coverage.mjs .claude/work/prompt-lanes/spec-v2`
exits 0 and reports no Phase 3 gap. (R15)

A44. One derivation produces all four D74 diagnostic kinds with two capable controls each: a
throwing/unresolved commit versus wrong-author, a malformed/unresolved identity versus a valid row,
a coined noun versus ambient tool names, and `ideasDropped: 3` versus zero. The exact result object
contains source-ordered, deduplicated ids/counts/codes and no source text or sensitive token. Spies
prove reporting performs no second lookup, corpus scan, or mutable-side-channel read. (R4, R6, R16,
D74, D79)

The acceptance set has been checked pairwise for every shared array, field, branch, and count. A5
and A6 use distinct refs while A36 isolates same-ref precedence; A8 and A9 differ by `sectioned`;
A12's duplicate-id abort is distinct from A36's same-ref, different-id outcomes; A13, A14, and A42
agree on every D50 under-claim state while A14 separately counts actual throw and unresolved rows;
A14 and A37 separate optional evidence from identity; A17 keeps `closedBy` independent of
disposition; A19 and A38 exercise both noun-warning branches; A21 separates file-level and
row-level diagnostics; A22 supplies a nonzero changelog ignored count; A35 makes the pre-boundary
truncation branch possible; A39 exercises both outcomes of engine discovery after the mandatory
scan; A40 separates the private and public shapes; A41 exercises a real collision; and A3, A29,
A31, and A35 keep presence, stdout, work items, `forwardUnactioned`, and dropped-idea counts
independent. All pairs are jointly satisfiable.

## Files touched

- `lib/lanes.mjs`: consume the shared ref index, commit resolver, and gate contracts; add
  current-week forward resolution, provenance, disposition derivation, and the exact Phase 4
  private boundary.
- `lib/build.mjs`: run the shared corpus scan unconditionally when lanes are enabled, form and gate
  the authored-engine union once, preserve private provenance through the Phase 4 boundary, attach
  the public projection before redaction, and apply lane-aware stdout.
- `lib/validate.mjs`: add the sibling authored-forward validator without widening work validation.
- `lib/archive.mjs`: add D29/D46's conditional numeric `forwardUnactioned` field and exclude every
  local-only forward value from snapshots.
- `lib/emit/digest.mjs`: instantiate the final forward band after work and Lane A.
- `lib/emit/report.mjs`: instantiate the final forward band without changing `total`.
- `lib/emit/post.mjs`: instantiate the final forward band after work and Lane A.
- `lib/emit/page.mjs`: instantiate `DISPOSITIONS` through the single Phase 2 pill primitive.
- `SKILL.md`: author only rule 8's reserved body and Forward item shape.
- `test/lanes.test.mjs`: cover current-week source resolution, shared-resolver states, real
  collision handling, ids, source kinds, dispositions, pointers, repo derivation, and stripping.
- `test/validate.test.mjs`: cover authored forward structure, `closedBy` type, file-level
  diagnostics, and text gates.
- `test/build.test.mjs`: cover union activation, one re-derivation, failure classes, modes,
  mandatory engine discovery, `--no-lanes`, attachment, provenance, changelog notice, redaction,
  stdout, counts, and issue #52 end-to-end cases.
- `test/archive.test.mjs`: cover ref-free snapshots, work-only counts, and conditional numeric
  `forwardUnactioned`.
- `test/emit.test.mjs`: instantiate and pin the final Markdown band, placement, copy, receipts, and
  forward-only empty state.
- `test/page.test.mjs`: instantiate and pin the final HTML band, one pill template, class
  isolation, receipts, escaping, placement, and copy.
- `test/site-transform.test.mjs`: extend the structural lane-free site assertion to `forward`.
- `test/golden-output.test.mjs`: extend the hermetic lane-absent and same-run site controls.
- `test/skill.test.mjs`: assert the non-actionable Phase 2 reservation becomes the one Phase 3 body
  and shape without changing numbering.
- `test/fixtures/claude-projects/lanes/`: add only clean-room Phase 3 idea and handoff cases.

## Test plan

- `test/lanes.test.mjs`: use table-driven plain objects for all four origins, D34 ids, D57 source
  kinds, D65 repo derivation, ref lookup and real collision input, null-turn handling, the D35/D50
  pickup matrix, reversal dispositions, non-causal `closedBy` pointers, no-deferred behavior, and
  D49 throwing and unresolved lookup behavior.
- `test/validate.test.mjs`: cover absent and empty arrays, exact authored shape, malformed and
  duplicate ids, `closedBy` type, optional authored repo conflicts, count-free file failures,
  count-bearing row failures, copy hits, private terms, noun modes, never-echo diagnostics, and
  `--no-lanes`.
- `test/build.test.mjs`: add independent temp-repo scenarios for engine-only next steps,
  engine-only heading reversals, free-floating reversal exclusion, mixed sources, union duplicates
  under D47, origin/receipt/repo mismatch, one mandatory shared scan, pre-boundary D68 truncation,
  D49's two resolution classes, all six modes, changelog ignored counts, local-only stripping,
  redaction backstop, voice ids, stdout additivity, counts, and `--no-lanes`.
- `test/emit.test.mjs`: reuse the Phase 2 pure formatting expectations verbatim, then attach real
  forward rows to test all three Markdown authorship forms, receipts, placement, forward-only empty
  copy, contract-copy booleans, prohibited words, and unchanged work totals.
- `test/page.test.mjs`: reuse the Phase 2 Lane B formatting policy verbatim, instantiate the shared
  pill primitive, and test one pill template, status-class isolation, receipt class, escaping,
  placement, and exact contract copy.
- `test/archive.test.mjs`: compare both snapshot and index bytes in the lane-absent case, assert no
  known ref in a forward-bearing snapshot, keep `items` unchanged, and pin D29/D46's
  `forwardUnactioned` count.
- `test/site-transform.test.mjs`: instrument `augmentSiteModel` and assert that valid authored and
  engine forward rows never enter its input or return.
- `test/golden-output.test.mjs`: keep the frozen corpus untouched, rerun all six lane-absent
  goldens, and compare a valid forward-bearing site build with a same-run lane-free control.
- `test/skill.test.mjs`: deep-equal Phase 2's title-only reservation, then assert Phase 3 authors the
  only actionable rule 8 body and Forward shape while preserving position and total rule count.
- Lane fixture root: add generic files named `idea-human.jsonl`, `idea-assistant.jsonl`,
  `idea-pre-boundary.jsonl`, `idea-truncated.jsonl`, `handoff-next-step.md`,
  `handoff-reversal-section.md`, `handoff-reversal-free-floating.md`, and
  `handoff-private-noun.md`; each proves only its named case and stays outside the frozen corpus.

## Risks

- Engine-sourced handoff text is a new publication path. R6 and A9-A10 make source narrowing,
  private-term checks, noun checks, display checks, voice checks, and archive absence part of the
  end-to-end gate.
- An authored row and an engine row can cite the same handoff ref. D47's authored-row precedence and
  D57 provenance plus duplicate-ref abort cases prevent double rendering without encoding
  provenance in an id.
- Forward refs are useful local join keys but must never become publication receipts. R8 and A23
  strip the ref, its canonical identity, D34's ref-bearing engine id, `sourceKind`, and `closedBy`
  ref, then assert absence by exact known values while preserving legitimate session and handoff
  receipts.
- The HTML change can accidentally fork Phase 2's pill implementation or acquire work-badge
  styling. R9 and A27 make both mistakes source-level failures.
- A long session can hit an idea cap before any numeric turn exists. D68 and A35 make
  `ideasDropped > 0` the exercised signal and keep the nullable turn as context only.
- Conditional archive metadata can break additivity even when no band renders. R14 and A3 compare
  both the snapshot and index.
- A valid reversal pointer can be mistaken for causal disposition evidence. R3, R4, and A17 keep
  `closedBy` as a checked pointer while deriving disposition only from the row's own source.
- Identity failures and optional commit-evidence failures used to share one drop path. R3, R4, A14,
  and A37 keep D49's drop-versus-render split explicit.
- A no-input fast path can hide engine rows because their existence is known only after the corpus
  scan. R1, R7, R16, and A39 make the scan unconditional and export its result to Phase 4.
- A short hash collision can silently join the wrong source. R1 and A41 use the shared D69 index
  builder and a real collision fixture before any Phase 3 join.
