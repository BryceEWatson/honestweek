# Phase 4: Cross-week carry

## In plain terms

Phase 4 lets honestweek keep unfinished forward-looking rows available across weekly builds. It
stores the engine's own cumulative local record in a gitignored file, then checks that record again
against the current configuration and current session corpus before showing anything from it. A row
that was still unactioned in an earlier week can appear as deferred, while a row already picked up or
ruled out stays gone in every later week. If the local record is missing or unreadable, honestweek
says so and still writes the ordinary work report. Current-week forward rows keep the exact
discovery, disposition, rendering, and failure paths established before this phase.

## Scope

- D5: Consume `ref` as the private carry key and keep it out of rendered artifacts.
- D6: Consume the settled lane-presence helper after the carry merge.
- D7: Re-apply the settled engine-row prose gates to selected carried rows.
- D8: Preserve and render the originating transcript receipt on every carried row.
- D10: Apply the settled drop-loudly and abort classes.
- D11: Inherit the settled pre-redaction attach point.
- D12: Build the cumulative carry index, deferred rows, zombie rule, and carry re-gating.
- D14: Apply the settled noun warning and strict-abort behavior.
- D19: Extend the hermetic harness with isolated multi-week cases.
- D24: Preserve the settled under-claim behavior for failed optional commit evidence.
- D25: Keep work counts unchanged and report carried rows separately.
- D28: Reuse the one build-local lane corpus.
- D29: Feed final forward presence into the conditional archive-index field.
- D30: Re-run the settled copy gate against the current corpus.
- D32: Re-run both settled display-repo checks.
- D33: Apply the mechanically verified reference discipline.
- D34: Consume current-week forward rows by their settled ids and refs.
- D40: Treat every carried ref as an opaque Phase 1 value.
- D45: Keep every carried `dispositionAsOf` equal to the current build's week start.
- D46: Consume the conditional numeric `forwardUnactioned` count.
- D47: Preserve ref uniqueness and authored-over-engine precedence through carry.
- D49: Keep identity-resolved rows when optional commit evidence cannot resolve.
- D50: Consume the one shared lane commit resolver without adding a carry lookup.
- D51: Apply count-only noun diagnostics and the settled ambient-tool exclusions.
- D55: Consume the exact producer-owned Phase 2 and Phase 3 export contracts.
- D56: Consume the settled `closedBy` representation.
- D57: Consume private authored-versus-engine provenance through the carry merge.
- D58: Build the carry fast path only after the mandatory corpus result exists.
- D62: Preserve `closedBy` as a pointer without using it as disposition evidence.
- D63: Preserve the settled build stdout when the final lane set is absent.
- D64: Separate count-free file failures from exact-count row failures.
- D65: Require the producer-derived source repo on every private forward row and carry entry.
- D69: Detect real ref collisions before any carry join.

## Out of scope

- Do not change how a current-week idea, handoff next step, or handoff reversal becomes a forward
  row. Consume a forward row as defined by D34 only after its within-week derivation is complete.
- Do not change a current-week disposition, authorship label, receipt, legend entry, heading, row
  order, contract string, empty-state string, pill, CSS class, or render mode.
- Do not make `validate` read the carry index. Carried rows are engine-produced at build time and
  use D12's build-side re-gating branch.
- Do not read an archive snapshot to reconstruct a ref, text, receipt, first-seen week, or
  disposition. Do not change `lib/archive.mjs`'s snapshot or weekly archive-index format.
- Do not make carry conditional on `output.archive`, `output.archiveDir`, the goals registry, or an
  existing archive directory.
- Do not change the D5/D40 ref function, re-mint a ref, parse a ref back into identity fields, or put
  a ref in a report, page, site bundle, or archive snapshot.
- Do not add a carry-index field, disposition, origin, id pattern, receipt shape, retention bound,
  pruning rule, config key, CLI flag, source module, or migration format not named by a settled
  decision.
- Do not add a second transcript or handoff scan, run git for a carried row, or introduce a path
  that git-reads a `display`-role repository.
- Do not wrap, fork, rename, or reshape a producer-owned D55 export. Phase 4 consumes those
  contracts and adds no second resolver, corpus operation, text gate, or current-row boundary.
- Do not infer authorship from an id, accept authored repo provenance, use `closedBy` as a
  disposition or zombie signal, or join two rows whose D69 canonical identities collide.
- Do not add a dependency, lockfile, install step, network access, telemetry, or auto-publish
  behavior.

## Requirements

R1. Add Phase 4 only after Phase 3 has produced the exact private current-row boundary required by
D55/D74. Consume its named `finalPrivateRows`, `engineForwardRows`, `laneInputPresence`, and
`diagnostics` without tuple destructuring, aliasing, or recomputation, including final D34 rows,
raw engine presence, D57 provenance, D65 repo provenance, and D69
canonical ref identities, the normalized week, and the already-created D28 corpus result without
reshaping any of them. Whenever lanes are enabled, Phase 3's D58 corpus operation runs once before
this boundary, including when both authored lane arrays are absent. Phase 4 must not call a
within-week extractor, disposition function, renderer, `lookupCommit`, or D50 resolver, and it must
not create a second implementation of any producer-owned contract. Current rows have already
consumed D24 as amended by D49: a throw or unresolved SHA may leave an identity-resolved current row
as `not started`, and carry retains it without turning optional evidence into an identity failure.
Only after the mandatory corpus result proves that the current row set is empty may an absent
`honestweek.forward-index.json` skip the carry reader, all carry diagnostics, and the index writer;
the corpus operation itself is never part of that fast path. The existing model assembled at
`lib/build.mjs:285` and the lane-absent stdout remain unchanged. `--no-lanes` skips the Phase 3
corpus operation and every Phase 4 read, gate, render, and write. (D6, D10, D12, D24, D28, D34,
D49, D50, D55, D57, D58, D65, D69, D74, D75, D78, D79)

R2. Read `honestweek.forward-index.json` only from the build `cwd`. Parse and structurally check
D12's version-1 envelope and every representation added to that local state by D65 and D69 before
using an entry. A wrong version, wrong top-level shape, malformed `weeks[]` member, or file-level
JSON error is unparseable for this version. An absent or unparseable file yields no carried rows and
uses D64's count-free D10 band diagnostic, including the filename, reason, and `--no-lanes`; it never
invents a numeric count, aborts, or removes a valid current-week row. A malformed entry inside an
otherwise usable week drops that entry through the row-level channel with the exact derived count
while valid entries remain eligible. Require the exact property `refCanonical`, decode it only
through `JSON.parse`, and call D73's `validateRefIdentity(ref, refCanonical)` before an entry can
participate in any other logic. Do not reconstruct a canonical from row fields. Do not call or
extend the tolerant archive-snapshot reader:
the snapshot at `lib/archive.mjs:51` contains the public report model and is not carry authority.
(D5, D10, D12, D40, D49, D64, D65, D69, D73)

R3. Implement D12's cumulative state transition as a pure operation in `lib/lanes.mjs`. "Prior"
means a week whose `week.start` is earlier than the build's current `week.start`, regardless of
array order; a later stored week never changes an earlier rerun. Build the zombie set from every
prior entry whose disposition is `picked up` or `ruled out`. A zombie ref contributes no current or
carried row. For each remaining ref, select its latest prior `not started` or `deferred` entry by
week start. Before any zombie lookup, same-ref suppression, or carry join, apply D69 to the
producer-owned canonical identities through D73's shared validator and index; a mismatched
ref/canonical pair or same-hash/different-canonical pair follows D69 rather than
any D47 branch. Apply this precedence exactly once, reading current-row authorship only from D57
`sourceKind` and treating a selected prior entry as the separately typed carry candidate:

1. A current D57-authored row wins over a selected same-ref carry row and renders once.
2. Otherwise, a current `picked up` or `ruled out` D34 row wins over a prior nonterminal entry and
   renders once.
3. Otherwise, a selected prior nonterminal entry wins over an absent or D57-engine nonterminal
   current row and becomes one carried `deferred` row.
4. A current row with no selected prior entry remains byte-for-byte unchanged.

The carried copy preserves the selected index entry's `ref`, `id`, `text`, `origin`, `receipt`,
required D65 `repo`, D69 canonical identity, and `firstSeenWeek`; only `disposition` becomes
`deferred` and `dispositionAsOf` becomes the normalized current `week.start` produced at
`lib/build.mjs:253`. Assert that same D45 value on every final row, including unchanged current
rows. Apply D47 to the current-plus-selected candidate union in this order: any duplicate id aborts
before suppression; two D57-authored rows with the same ref abort; otherwise a D57-authored row
suppresses a same-ref engine or carry candidate. The resulting union has unique refs and ids, and no
carried row may reintroduce a ref that the current authored union superseded. A surviving current
row's private index entry uses the matching prior entry's `firstSeenWeek` when one exists and
otherwise sets `firstSeenWeek` to the current week start; its public row does not gain that field. A
current terminal winner uses its current D34 payload and the preserved first-seen value. A D56
`closedBy` value remains only D62 pointer metadata: it cannot create a terminal disposition, enter
the zombie set, or change this precedence. Do not infer provenance from an id or use array position,
text, receipt, id, `closedBy`, or archive contents as the carry join. (D12, D34, D45, D47, D56,
D57, D62, D65, D69, D73)

R4. Name and isolate the carry-index receipt exemption. A row selected by R3 from the index does
not run the current-week `ref` or receipt-resolution lookup because its source session or handoff
belongs to an earlier week. It still must carry a structurally valid D8 transcript receipt, and the
same receipt must render on the carried line. This exemption applies only to current-week source
resolution. It does not exempt schema checks, text gates, receipt rendering, redaction, ref
stripping, or final id/ref uniqueness. Preserve the exact selected index text as the carried row's
text; never source or refresh that text from the current items file, current corpus, or an archive
snapshot. Private/display/session-only work remains eligible for D76 transcript receipts and no
display repo is Git-read. (D5, D8, D12, D40, D76)

R5. Re-gate every row selected for carry through the settled Phase 2 lane-gate functions against
the current config and the single current build-local corpus. Consume the D55 function names,
inputs, outputs, and diagnostics exactly as Phase 2 exports them; do not add a carry adapter or
reimplement a gate. Re-run both D32 display checks, the configured-private-term check, D14 as
amended by D51, D30's copy gate, and the enabled D7 voice check. Use D28's memoized transcript and
handoff result; do not scan either source again and do not call the D50 resolver. Every candidate
must have D65's derived `repo`; a missing value is unusable row-level provenance and cannot bypass
the display-role gate. A zero-file current corpus cannot support the copy check, so it drops all
selected carried rows loudly under D10 with D64's exact row count and still emits work output.
Default noun diagnostics are D51 count-only by safe row id, never echo token values, and the settled
ambient tool vocabulary produces no finding. Strict noun, copy, display, configured-term, and
enabled voice hits exit 2 and write no report, snapshot, or forward index. Gate only rows R3 would
render: a zombie, a superseded prior entry, and a prior entry displaced by a current terminal row are
not republished and need no prose gate. (D7, D10, D12, D14, D28, D30, D32, D50, D51, D55, D64,
D65)

R6. Write D12's exact version-1 index only after all honesty gates pass, the public row collection
has passed the existing pre-emit redaction path, and the primary artifact has been written
successfully. The stored `text`, `origin`, `receipt`, and required D65 `repo` must be the same
deep-redacted values used by the successful public row. The private index retains D5's `ref` and
the D69 canonical identity required to detect a future collision; D57 `sourceKind` never enters the
D12 schema. In `site` and `changelog`, where the forward collection is deliberately not attached to
the emitted model, deep-redact the private entry payload through the same configured redaction
policy before the index write without adding a lane key to either output. The current week entry
contains the final forward rows for that build, including deferred carried rows and first-time
terminal rows, but excluding zombies and dropped rows. Every persisted entry's
`dispositionAsOf` equals that current index member's `week.start`.

Implement D12's `weeks[]` rule literally: retain every valid week whose `week.start` differs from
the current start, then append one replacement object for the current week. Never prune terminal or
empty weeks. An absent or unparseable index starts a fresh valid version-1 envelope after the
successful current build; the earlier loud read diagnostic still appears. A rerun of the same week
replaces, rather than duplicates, that week. An exit-2 gate, `--no-lanes`, or a primary emit failure
does not create or mutate the index. An index-write failure after a successful primary emit uses
the count-free D64 file-level channel and preserves the already-written work artifact. Perform this
write in every successful build mode when Phase 4 is active, independently of the optional archive
block at `lib/build.mjs:422`. (D5, D10, D11, D12, D45, D57, D64, D65, D69)

R7. Use the settled Phase 2 forward renderer for carried rows. Supply only D12's `firstSeenWeek` to
D77's producer-owned metadata formatter; Phase 4 authors no public phrase. That formatter changes a
carried row's date clause from the current-row form to D77's exact first-seen/as-of form in Markdown
and HTML. Its text, disposition,
authorship phrase, transcript receipt, heading, legend, pill, placement, and contract copy stay on
the Phase 2 path. A current D56 `closedBy` value stays on D62's pointer-rendering path and never
changes the disposition or the carry date clause. A current-week row never receives the first-seen
phrase and remains byte-identical to its pre-Phase-4 rendering. Preserve D57 `sourceKind` and D69's
canonical identity through the private merge, then strip both before either renderer or
`writeArchive`; retain only `refCanonical` beside `ref` in the private forward index using D73's
exact JSON encoding. Attach
the final union through D11's existing conditional, pre-redaction forward key; do not add a second
forward band or a carry-specific model key. (D8, D11, D12, D16, D56, D57, D62, D69, D73, D77)

R8. Pass the final union through the settled D6 presence helper. A carried row can therefore make
the forward band present when no current D34 row exists. Keep D25 work totals unchanged, report the
final union length as the carried-forward row count, and let D29 as amended by D46 add
`forwardUnactioned` at the fixed archive-index insertion point at `lib/archive.mjs:56`. The field is
present only when the final forward band is present, is a number, and counts only final rows whose
disposition is `not started` or `deferred`; `picked up` and `ruled out` do not contribute. Archive
snapshots may contain the redacted public carried row and its transcript receipt, but contain no D5
ref and are never read by Phase 4. Final presence controls those render/count fields only. Apply D63
from D74's raw `laneInputPresence` plus Phase 2's raw authored-technique presence: the existing stdout
at `lib/build.mjs:438` remains byte-identical only when all three raw sources are absent, and the
settled extended summary remains selected when an authored row later drops to a zero final count.
(D5, D6, D12, D25, D29, D46, D63, D74, D75)

R9. Make the index engine-written local state. Extend `lib/init.mjs` through its existing
`ensureGitignore` helper at `lib/init.mjs:115`, and add `honestweek.forward-index.json` to the
committed sidecar block beginning at `.gitignore:1`. Build ensures that ignore line before its first
index write, using the settled idempotent sidecar behavior and already-tracked warning. `init` and
repeated builds leave exactly one ignore line. README documents the cumulative local file, the
current-config/current-corpus re-gating, the zombie rule, the D10 missing/corrupt behavior, and that
carry does not require the weekly archive. SKILL adds a non-numbered build note that the model must
never create, edit, or repair this engine-written file. Do not renumber or reword the settled eight
distillation-contract rules. Public prose uses the repository voice rules. (D10, D12)

R10. Keep the archive and carry stores mechanically distinct. A build with
`output.archive: false` still writes and reads the forward index. A build with
`output.archive: true` may write the existing redacted snapshot after the primary emit, but Phase 4
must not enumerate `output.archiveDir`, call the archive snapshot reader, or use the snapshot's
forward text. Deleting, corrupting, or changing a snapshot cannot change carry output when the
forward index is unchanged. (D5, D12)

R11. Validate an untrusted but parseable index before it can affect rendering, the zombie set, or a
ref join. The version-1 reader accepts only the D12 envelope, D12 entry fields, D65 repo provenance,
D69 canonical identity, settled disposition and origin members, D34 id form, D5 ref form, D8
receipt forms, and string week/date fields. Reject an entry whose required repo or canonical
identity is absent, whose `firstSeenWeek` is later than its containing week start, or whose
`dispositionAsOf` differs from its containing week start. Duplicate refs or ids inside one stored
week make the conflicting entries unusable and loud; they do not silently select by file order.
Before any duplicate-ref or D47 logic, call D73's validator for each entry. A malformed canonical or
hash mismatch drops that entry loudly before it can join; a real validated
same-hash/different-canonical pair aborts per D69 and writes nothing. Unknown extra entry fields,
including a serialized D57 `sourceKind`, are ignored
on read and are not copied into the next engine-written index. Parseable row failures use D64's
exact count; file-level failures remain count-free. All invalid-data diagnostics name the filename,
week or row id when safe and `--no-lanes`, but never echo entry text, configured terms, matched
prompt runs, or noun tokens. (D5, D8, D10, D12, D34, D57, D64, D65, D69, D73)

R12. Extend the D19 harness with generated clean-room multi-week roots, fixed dates, and the same
fully pinned throwaway repository discipline. Keep the frozen Phase 1 golden corpus unchanged.
Run the D33 verifier, its checked-in negative self-test, the coverage verifier, and `node --test`
from the repository root. Every new fixture uses repo-relative or temporary paths and generic
identities, and all implementation uses Node 18 APIs, Node built-ins, and cross-platform path
helpers. (D19, D33)

## Acceptance criteria

A1. `node --test` from the repository root exits 0. (R12)

A2. With lanes enabled, no authored lane arrays, a hermetic session-and-handoff root whose one
ordinary handoff has no D42 next-step section and no D7-eligible reversal, and no
`honestweek.forward-index.json`, Phase 3's producer-owned corpus operation is called exactly once
and returns the empty engine-presence result. All six artifacts remain byte-identical to the settled
lane-absent goldens; Phase 4 performs no carry read or write, emits no carry diagnostic, creates no
index, and preserves the exact lane-absent stdout bytes rooted at `lib/build.mjs:438`. (R1, R8,
R12)

A3. In each of the four lane-rendering modes, a valid current-week forward set produces identical
artifact bytes when the carry index is a valid empty version-1 envelope and when it is absent; only
the absent-index D10 diagnostic differs. (R1, R2, R7)

A4. In separate builds with one valid current-week row, an absent index and a file containing the
exact bytes `{not-json` each leave that row present, emit the work artifact, exit 0, and print one
D64 file-level line containing the filename, the reason, and `--no-lanes`. Neither line contains a
numeric dropped-row count or a row-count placeholder. (R2)

A5. After either A4 build, parsing the project-root index succeeds and deep-equals a `version: 1`
envelope with one current-week object, D12's entry data, required D65 repo provenance, and D69's
producer-owned `refCanonical`. The raw UTF-8 JSON bytes contain exactly two literal `\\u0000`
escapes for that entry and no literal NUL or pipe-form canonical. Parsing restores two NUL code
units and D73's validator returns the expected tuple. It contains no D57 `sourceKind` and no unknown
input field.
(R6, R11)

A6. With `output.archive: false`, build an explicit week 1 of
`{ start: '2026-01-05', end: '2026-01-11' }` containing one `not started` row. For week 2, omit the
items envelope's week, inject `now: 2026-01-19T12:00:00.000Z` with timezone `UTC`, and provide no
current row, forcing the fallback branch reached by the call at `lib/build.mjs:253`. Week 2 renders
one `deferred` row whose text is byte-equal to week 1's, whose visible date clause is exactly
`first seen 2026-01-05; as of 2026-01-12`, and whose origin and receipt deep-equal week 1's. Its
private and public `dispositionAsOf` values equal `2026-01-12`, as do those of every other final row
in that build. (R3, R4, R7, R10)

A7. In an independent two-week control, enable `output.archive: true` for week 1 and first assert
that the snapshot at the configured archive directory plus `<week-1 start>.json` exists and its
`report` contains the exact week-1 forward text. Replace only that snapshot text with the distinct
clean string `archive decoy text`, leave `honestweek.forward-index.json` unchanged, and run week 2
with no current row. The week-2 artifact is byte-identical to the unmodified-snapshot control and
does not contain `archive decoy text`. (R2, R4, R10)

A8. In a second independent two-week control, enable `output.archive: true` for week 1 and first
assert that the configured archive directory contains the `<week-1 start>.json` snapshot whose
`report` contains the exact week-1 forward text. Delete that archive directory, leave
`honestweek.forward-index.json` unchanged, and run week 2 with no current row. The week-2 artifact
and forward-index bytes deep-equal an undeleted control. (R10)

A9. Building three distinct weeks yields three retained `weeks[]` members. Rebuilding the middle
week with a different valid row leaves the first and third members deep-equal to their prior values,
replaces the middle member, and keeps exactly three week starts. (R6)

A10. A three-week zombie scenario records a ref as `ruled out` in week 1, has no matching output in
week 2, and suppresses the same ref when it returns as a current D34 row in week 3; the week-1
terminal entry remains present after all three builds. (R3, R6)

A11. A hand-built cumulative index whose array order is week 3, week 1, week 2 gives a week-2 build
the same carry and zombie results as chronological order, and the week-3 entry has no effect on that
week-2 rerun. (R3)

A12. A prior `not started` entry plus a current `picked up` row for the same ref renders the current
terminal row exactly once, writes `picked up` in the current week index entry, preserves the prior
`firstSeenWeek`, and suppresses that ref in the following week. (R3, R6)

A13. A prior `not started` entry plus a nonterminal current row carrying
`sourceKind: 'engine'`, the same ref and canonical identity, and different text renders the prior
index text once as `deferred`, renders none of the current text, and preserves the prior id,
required repo, and `firstSeenWeek`. (R3, R4)

A14. A carried transcript receipt whose session is absent from the current corpus still renders
through the named carry-index exemption, while the same entry with a malformed receipt drops loudly
and does not render. (R4, R11)

A15. One table-driven current-policy test makes each of these selected carry inputs exit 2 with no
artifact, archive snapshot, or index mutation: its required derived `repo` newly configured as
`display`, a display label newly present in `text`, a newly configured private term, a
current-corpus copy hit, a strict noun hit, and an enabled voice hit. The display-role case records
zero git and D50 resolver calls. No diagnostic echoes the carried text, noun token, or matched
private value. (R5)

A16. An end-to-end carry-enabled build over the full fixture corpus produces zero default noun
warnings. In a separate strict-off input, one carried text containing only `Bash`, `Edit`, `Read`,
`Write`, `Grep`, `Glob`, and `Task` also produces zero noun warnings. In a third input, two selected
rows contain the unmatched tokens `Samplealpha` and `Samplebeta`; they render, exit 0, and emit one
summary naming distinct count `2` and both safe row ids while neither token value appears in stdout
or stderr. (R5)

A17. A selected carried row with a zero-file current corpus is dropped, the work artifact is
written, exit code is 0, and one D10 diagnostic reports the exact selected-row count and
`--no-lanes`. (R5)

A18. A lane-enabled build containing both current and selected carried rows calls the producer-owned
Phase 3 corpus operation once, gives Phase 4 that same result object, and calls no corpus reader or
D50 resolver from the carry path. (R1, R5)

A19. Every exact ref collected from the final current-plus-carried private set appears in
`honestweek.forward-index.json` beside its D69 canonical identity and in no rendered artifact, site
bundle, or archive snapshot. D57 `sourceKind` appears in neither the index nor any public artifact,
while the carried transcript receipt remains visible. (R4, R6, R7, R8)

A20. A source and output comparison proves every current-week forward row retains the exact
pre-Phase-4 Markdown and HTML bytes, while only a carried `deferred` row gains the R7 first-seen
phrase. (R7)

A21. A final union containing one `not started`, one `deferred`, one `picked up`, and one `ruled out`
row leaves the work-item output count and archive `items` unchanged, reports four carried-forward
rows, and makes D46's conditional `forwardUnactioned` a numeric `2`. An empty final union does not
introduce `forwardUnactioned`. (R8)

A22. With a populated valid index, `build --no-lanes` performs zero carry reads, corpus reads,
gates, and index writes, and its work-only artifact and stdout equal the lane-absent control.
(R1, R6, R8)

A23. Making the project-root index path unwritable after a valid carry read leaves the successfully
written primary artifact intact, exits 0, and emits one count-free file-level line containing the
filename, write-failure reason, and `--no-lanes`. It contains no numeric dropped-row count. (R6)

A24. In a table of parseable version-1 indexes, one valid entry plus one entry with an invalid
origin, receipt, id, required repo, canonical identity, or date relationship drops exactly one row
and retains the valid row. A separate two-entry duplicate-ref case drops both conflicting entries
and reports exact count `2`. Neither case echoes text or noun tokens. A wrong-version envelope drops
the whole carry band through one count-free file-level diagnostic. (R2, R11)

A24b. A syntactically valid entry with an 8-hex `ref` and a well-formed two-NUL `refCanonical` whose
recomputed shipped hash differs is dropped loudly before duplicate, zombie, suppression, or join
logic; spies observe zero such operations and no render. A positive control using the matching pair
reaches the intended precedence branch. A validated real same-hash/different-canonical pair still
aborts the whole build per D69. (R2, R3, R11, D73, D79)

A25. A current row containing a generic redactor-matched token writes the same redacted text to the
artifact and index; carrying it one week later preserves those redacted text bytes exactly. (R6)

A26. A selected carry is gated in all six modes and updates the cumulative index after success; it
renders in `digest`, `report`, `page`, and `post`, and its text is absent from `changelog` and
`site`. (R5, R6, R7)

A27. Running `init` twice and two subsequent builds leaves exactly one
`honestweek.forward-index.json` ignore line, and the committed `.gitignore` contains the same line
once. An instrumented first build observes the ignore write before the index write. (R9)

A28. Documentation tests find the cumulative, engine-written, current-policy re-gating,
missing/corrupt drop, no-archive dependency, and never-edit statements without changing the eight
numbered SKILL contract rules. (R9)

A29. Running
`node .claude/work/prompt-lanes/spec-v2/verify-refs.mjs . .claude/work/prompt-lanes/spec-v2`
exits 0. (R12)

A30. Running
`node .claude/work/prompt-lanes/spec-v2/verify-coverage.mjs .claude/work/prompt-lanes/spec-v2`
exits 0. (R12)

A31. A selected prior nonterminal row and a current authored nonterminal row with the same ref and
canonical identity but distinct ids render the current row carrying `sourceKind: 'authored'`
exactly once, suppress the carry candidate, and persist one entry for the ref without `sourceKind`.
The same setup with `sourceKind: 'engine'` follows A13 instead; omitting `sourceKind` fails the
private boundary, and giving the current and carried candidates the same id exits 2 before same-ref
suppression. (R3, R6)

A32. In separate throwing-lookup and unresolved-SHA week-1 builds, an authored forward row whose
identity resolves renders as `not started`, is counted once in the failed-resolution report, never
enters a dropped-row diagnostic, and is persisted. An injected spy proves the week-1 evidence used
the producer-owned D50 resolver; with no current row in week 2, the row carries as `deferred` with
zero git, resolver, or corpus re-scan calls from Phase 4. (R1, R3, R6)

A33. With both authored lane arrays absent, use a hermetic handoff containing exactly one bullet
under `## Next steps`. The mandatory Phase 3 corpus operation runs once, its D55 result reports the
engine row, and Phase 4 does not take A2's empty fast path: the row renders as current, the carry
reader observes the supplied empty version-1 index, and the current week is written once. Replacing
the bullet with an ordinary unsectioned line produces A2's empty result. (R1, R6)

A34. Through the actual Phase 3-to-Phase 4 boundary, one authored idea row and one engine handoff row
each carry the D57 `sourceKind`, D65 repo derived from their resolved source, and D69 canonical
identity. Both persist their required repo and canonical identity, neither publishes `sourceKind`,
and a conflicting authored repo is rejected before the boundary. A hand-built current row or
parseable index entry missing the required repo drops with exact row count `1` before any display
gate can be skipped. (R1, R3, R5, R6, R11)

A35. A contract test imports the producer-owned D55 Phase 2 text-gate exports and Phase 3 private
boundary export, feeds Phase 4 the exact D74 returned object, and deep-equals every result and
diagnostic without a wrapper or reshaping step. The current-plus-carry case preserves the Phase 3
result object identity through selection; a deliberately omitted required key is rejected rather
than defaulted. A spy proves stdout reads `laneInputPresence` and diagnostics are not recomputed.
(R1, R5)

A36. Use the exact real same-hash/different-canonical ref pair pinned by Phase 1 for D69, placing
one canonical identity in a valid prior index entry and the other in a valid current Phase 3 row
with the shared 8-hex ref. Build exits 2 before zombie selection or D47 suppression and writes no
artifact, archive snapshot, or index mutation. A control using the same ref with the same canonical
identity reaches the applicable R3 precedence branch. (R1, R3, R11)

A37. A current `sourceKind: 'authored'` row carrying a valid D56 `closedBy` string and a
producer-resolved pointer receipt wins over a selected same-ref carry candidate, renders the
pointer once, and keeps its engine-derived `not started` disposition; it does not become terminal or
enter the zombie set. Replacing the pointer with an unmatched reversal ref aborts in the Phase 3
producer and no Phase 4 read or write occurs. (R1, R3, R7)

A38. Running
`node .claude/work/prompt-lanes/spec-v2/verify-refs.mjs --self-test`
exits 0 by proving that an uncatalogued inline citation makes the nested verifier command fail.
(R12)

The acceptance set has been checked pairwise for shared fields and counts. In particular, A2's
mandatory empty scan and no-write case is distinct from A33's scan-produced engine row and from
A4's current-row recovery case. A4 and A23 are count-free file failures, while A17 and A24 provide
parseable row sets whose exact drop counts are knowable. A10's zombie has a prior terminal entry
while A12's current terminal has only a prior nonterminal entry. A13's same-ref current row is
D57-engine, while A31's authored-precedence fixture uses distinct ids and its duplicate-id companion
aborts before suppression. A21 separates four total forward rows from two unactioned rows. A34
separates required repo provenance from the positive display-role hit in A15. A36's differing
canonical identities abort before A13/A31's same-identity D47 branches. A37's pointer remains
noncausal under D62. A32's resolved identity with failed optional evidence is distinct from A4's
missing index and A17's absent corpus. Each named fixture creates the branch it asserts.

## Files touched

- `lib/lanes.mjs`: add the pure version-1 entry checks, D69 collision guard, and cumulative
  carry/zombie transition over the exact D55/D57 Phase 3 boundary.
- `lib/build.mjs`: read, re-gate, merge, attach, and write the project-root carry index around the
  existing one-corpus and pre-redaction lane path, preserving D63 stdout and D64 diagnostics.
- `lib/init.mjs`: ensure the forward-index ignore entry idempotently.
- `.gitignore`: add the engine-written forward index to the local-state sidecar block.
- `lib/emit/_shared.mjs`: add only the carry-specific first-seen date clause to the settled forward
  row metadata formatter.
- `lib/emit/digest.mjs`: pass carry provenance through the existing forward renderer without
  changing current rows.
- `lib/emit/report.mjs`: pass carry provenance through the existing forward renderer without
  changing current rows or totals.
- `lib/emit/post.mjs`: pass carry provenance through the existing forward renderer without changing
  current rows.
- `lib/emit/page.mjs`: show the same carry-only first-seen value in the existing forward HTML row.
- `README.md`: document cumulative carry state, current-policy re-gating, failure behavior, and
  independence from the weekly archive.
- `SKILL.md`: tell the model never to create or edit the engine-written index without changing the
  eight settled rules.
- `test/lanes.test.mjs`: cover schema checks, temporal selection, source provenance, real ref
  collisions, deferred precedence, and the three-week zombie rule.
- `test/build.test.mjs`: cover multi-week I/O, current-policy re-gating, mode behavior, recovery,
  producer-contract consumption, unconditional engine discovery, write ordering, private-field
  stripping, stdout additivity, and no-archive operation.
- `test/init.test.mjs`: cover the forward-index ignore entry and idempotency.
- `test/archive.test.mjs`: prove snapshots contain only public carried rows and are never carry
  authority.
- `test/emit.test.mjs`: pin carry-only Markdown provenance, current-row byte identity, placement,
  counts, and non-rendering modes.
- `test/page.test.mjs`: pin carry-only HTML provenance, escaping, receipt styling, and current-row
  byte identity.
- `test/golden-output.test.mjs`: extend the hermetic controls without changing the frozen corpus.
- `test/docs.test.mjs`: pin the README carry contract.
- `test/skill.test.mjs`: pin the engine-written note and unchanged eight-rule count.

## Test plan

`test/lanes.test.mjs`

- Build plain version-1 objects for exact field validation, invalid version and row matrices,
  duplicate ids/refs, date relationships, unknown-field removal, and opaque D40 refs.
- Table-test the R3 transition for new current, prior-open/current-absent,
  prior-open/current-nonterminal, prior-open/current-terminal, prior-terminal/current-returned, and
  future-week cases.
- Add D47's prior-carry/current-authored collision beside the current-engine control using explicit
  D57 `sourceKind`, and assert one final ref plus D45's current-week `dispositionAsOf` on every
  winner.
- Reuse Phase 1's checked-in real D69 ref-collision pair across a prior entry and a current row,
  proving the abort precedes every join; reject missing D65 repo or canonical identity as an exact
  row-level drop.
- Store weeks in deliberately nonchronological order and prove comparisons use `week.start`.
- Run the three-week zombie case and a same-week replacement without filesystem I/O.

`test/build.test.mjs`

- Use generated isolated session roots and fixed weeks for the absent, corrupt, recovery,
  archive-off, archive-on decoy/deletion controls, selected-carry, zero-corpus, and `--no-lanes`
  cases.
- Spy on the Phase 3 producer contract so both the empty-handoff control and a sectioned next-step
  run the mandatory corpus operation once; pass its exact result object into Phase 4.
- Import the producer-owned D55 gate and boundary exports in a contract test, and assert Phase 4
  neither wraps their shapes nor calls the D50 resolver.
- Run the six-row current-policy abort table and assert exit 2, no primary artifact, no archive
  snapshot, no index mutation, and no prose echo.
- Run the ambient-tool noun exclusion, count-only default noun diagnostic, parseable row failures,
  count-free absent/unparseable/write failures, and exact D10/D64 controls.
- Run throwing and unresolved current-row commit evidence through D49: retain as `not started`,
  report the exact failed-resolution count, persist it, then carry it without a second git lookup.
- Run a D56 pointer through current authored precedence and prove D62 keeps it out of disposition
  and zombie derivation.
- Build week 1 and week 2 with archive disabled; compare rendered text, dates, receipt, index schema,
  and post-redaction bytes.
- Repeat as two independent archive-enabled controls that first assert the exact week-1 snapshot
  path and text, then change the snapshot or delete its directory to prove the index is the sole
  carry source.
- Build and rebuild three weeks to prove cumulative retain-and-replace behavior.

`test/emit.test.mjs`

- Reuse Phase 2's forward fixtures as current-row byte controls in `digest`, `report`, and `post`.
- Add one deferred carried row and pin its exact first-seen/as-of clause, receipt, authorship label,
  band placement, D45 date value, final forward count, unchanged work count, and ref absence.
- Assert `changelog` gates but does not render the carried text.

`test/page.test.mjs`

- Reuse the current-row HTML fixture byte-for-byte.
- Add one carried row and pin escaped text, the exact visible first-seen/as-of clause, the existing
  disposition pill and authorship phrase, `wl-transcript-receipt`, and absence of work badge classes
  and refs.

`test/archive.test.mjs`

- Write a carry-bearing public model and assert the snapshot contains the receipt and redacted text
  but no ref.
- Change and delete snapshot files between weekly builds and prove carry output remains index-driven.
- Keep archive `items` work-only and pin D46's conditional numeric `forwardUnactioned` over a mixed
  disposition set.

`test/init.test.mjs`

- Run `init` twice and assert one forward-index ignore line beside the settled sidecars.

`test/golden-output.test.mjs`

- Leave `test/fixtures/claude-projects/golden/` unchanged and rerun every lane-absent golden.
- Compare valid current-row builds against Phase 3 bytes with an empty or absent carry index, and
  pin the exact lane-absent stdout when the mandatory corpus result is empty.
- Use generated multi-week roots only for carry cases.

`test/docs.test.mjs` and `test/skill.test.mjs`

- Pin every R9 statement, public voice rules, the engine-only edit prohibition, and the unchanged
  eight-rule sequence.

Full verification

- Run `node --test` from the repository root with no path argument.
- Run the D33 reference verifier with A29's exact command.
- Run the reference verifier's negative self-test with A38's exact command.
- Run the coverage verifier with A30's exact command.

## Risks

- Overwriting the file with only the current week makes the zombie rule forget a terminal ref.
  R6, A9, and A10 require cumulative retain-and-replace behavior and keep terminal weeks forever.
- Joining to an archive snapshot recreates the missing-ref defect and can publish different text
  from the index. R2, R4, A7, and A8 make the index the only source.
- Treating an engine-written file as trusted lets stale policy bypass current privacy rules. R5 and
  A15 re-run the full settled text policy against the current config and corpus.
- Letting a missing or authored repo value pass makes the display-role check optional. R1, R5,
  R11, A15, and A34 require D65 provenance and fail closed before render.
- Inferring current-row authorship from an id makes D47's two branches indistinguishable. R3, A13,
  A31, and A34 consume and strip D57 `sourceKind` at the exact private boundary.
- Treating the 8-hex ref as collision-free can join unrelated evidence. R3, R11, and A36 carry the
  D69 canonical identity and abort on a real collision before selection.
- Applying the receipt exemption to current rows disables evidence resolution. R4 and A14 limit it
  to rows actually selected from the carry index.
- Gating every historical entry can abort on prose that will never render. R3 and R5 select the
  final carry candidates before text gates.
- Comparing weeks by array order lets an out-of-order rerun use future state. R3 and A11 compare
  normalized week starts.
- Using current authored text for a known ref breaks D12's self-contained source and text-stability
  guarantee for an engine collision, while always preferring prior carry would violate D47 for a
  current authored row. R3, R4, A6, A13, and A31 distinguish those cases.
- Writing the index before the primary artifact can advance history for a report that never
  existed. R6 and the no-mutation assertions in A15 place the state write after success.
- Writing pre-redaction prose to the index or stripping the ref too early breaks one of the two
  storage guarantees. R6, A19, and A25 pin the post-redaction payload and private-only ref.
- A carry-only metadata change can accidentally alter every current forward row. R7, A3, and A20
  require byte identity for all within-week rows.
- Treating a failed commit lookup as failed identity hides a source row that still exists. R1 and
  A32 keep both throwing and unresolved optional evidence on D49's counted `not started` path.
- Re-running a resolver or reshaping a producer result lets Lane A, Lane B, and carry disagree.
  R1, R5, A18, A32, and A35 consume D50/D55 contracts without a Phase 4 fork.
- Reporting a made-up row count for an absent, corrupt, or unwritable file is itself a false claim.
  R2, R6, R11, A4, A17, A23, and A24 separate D64's file and row cases.
- Treating `closedBy` as causal evidence creates an unsupported terminal state and zombie. R3, R7,
  and A37 preserve only D62's pointer behavior.
- Skipping the corpus operation before engine presence is known can erase a valid handoff row. R1,
  A2, A18, and A33 enforce D58 with capable empty and nonempty controls.
- Tying the index to the archive option makes carry inert by default and brings the snapshot join
  back indirectly. R6, R10, A6, and A8 prove archive-independent operation.
- A partial or manually edited JSON file can suppress or inject intent. R11 drops malformed rows
  loudly, while R5 treats every renderable carried row as untrusted prose under current policy.
