# Phase 1: Evidence substrate

## In plain terms

Phase 1 gives honestweek a private evidence record for each instruction in a coding session. It
separates real instructions from machine notices, records ideas and session-end next steps, and gives
each usable record a stable local identifier. It keeps the exact redacted wording in a bounded,
gitignored working file so later phases can check authored summaries without publishing the prompt.
It also makes the configuration and test fixtures ready for the later lane work. No report, page,
site artifact, archive snapshot, or other rendered output changes by even one byte in this phase.

## Scope

- D2: Build.
- D3: Build.
- D4: Build.
- D5: Mint all four origins.
- D13: Build.
- D17: Preserve invariant 6 as amended before Phase 1.
- D19: Build.
- D20: Build.
- D21: Build.
- D22: Build.
- D23: Build.
- D26: Emit.
- D27: Build.
- D31: Emit the envelope.
- D37: Build the 15-key non-stub shape.
- D38: Build ref-free, sidecar-free stubs.
- D39: Build cue, shape-key, bound, and completeness rules.
- D40: Mint refs with string index segments.
- D41: Reuse the existing redirect patterns.
- D42: Build bounded, heading-scoped next-step extraction.
- D43: Build reversal section provenance.
- D44: Build the idea-drop count.
- D59: Build exact phrase normalization and the closed filler vocabulary.
- D72: Build `FILLER` as the exact closed token array, with both halves of its proof.
- D68: Make `ideasDropped` the idea-truncation signal.
- D69: Retain canonical identities and detect hash collisions.
- D70: Capture and checksum the copy-gate measurement corpus.
- D71: Capture a nonempty reversal-bearing draft baseline.

## Out of scope

- Do not add a rendered band, render a lane row, attach a lane key to a report model, or change any
  emitter, page builder, site bundle, archive writer, rendered contract string, count, badge, pill,
  legend, or receipt.
- Do not add `techniques`, `forward`, dispositions, technique grades, `dispositionAsOf`,
  `forwardUnactioned`, `honestweek.forward-index.json`, cross-week state, or carry behavior.
- Do not add lane validation, lane build gates, copy-gate behavior, noun-gate behavior,
  `--no-lanes`, or `--explain-lanes`. Phase 1 only makes `strictLaneNouns` survive configuration
  loading.
- Do not change `SKILL.md` or reserve or renumber distillation-contract rules. D18 assigns that work
  to Phase 2.
- Do not add any configuration key other than `redaction.strictLaneNouns`.
- Do not reorder redaction and truncation for any legacy steering, redirect, assistant-thinking,
  assistant-text, handoff, or other pre-existing field. Do not edit `AGENTS.md` to permit such a
  reorder. D61 moves that privacy migration to a separate issue and PR before this phase.
- Do not make `build` read `honestweek.draft.json` or `honestweek.prompts.json`. D20 keeps the
  sidecar out of the build authority path.
- Do not add a runtime dependency, a lockfile, an install step, network access, or an API unavailable
  in Node 18.
- Do not introduce any path that reads a `display`-role repository, and do not change the
  verify-or-abort behavior for work items.

## Requirements

R1. Keep the Phase 1 implementation confined to the evidence and local-state surfaces assigned by
this phase. Preserve every legacy field byte from the phase-start baseline when the new evidence
inputs are absent. Add only the new local evidence fields and the D42
next-steps-only handoff behavior, keep every rendered artifact byte-identical, and leave
`AGENTS.md` unchanged so invariant 6 retains its existing meaning. (D17, D19, D22)

R3. Add the pure, zero-I/O `lib/lanes.mjs` module. Implement the single `refFor` minter for
`turn`, `idea`, `handoff-next-step`, and `handoff-reversal` exactly per D5 as amended by D40:
identity inputs only, a required string `index` segment, D73's NUL-delimited canonical string, and
the existing 8-hex FNV-1a algorithm. The module also owns D39's closed `IDEA_CUES`,
`normalizePhrase`, `FILLER`, and `shapeKeyFor`. Implement D59's normalization steps in their settled
order. `FILLER` is the exact closed array D72 settles, frozen, with no member added or removed at
implementation time; removal is whole-token and runs after `normalizePhrase`, in D72's stated order.
The shape key returns `null` below D39's six-distinct-content-word floor and otherwise hashes the
first six remaining words after digit-run normalization; a token removed by `FILLER` does not count
toward that floor. Use plain JavaScript without a dependency. (D5, D39, D40, D59, D72, D73)

R4. Add turn-window extraction to `lib/claude-adapter.mjs` without replacing the existing flat
arrays or changing any of their values. Implement the command boundary and
command instruction source per D2 and the graded-turn behavior per D3 and D38. Every non-stub window
has exactly D37's explicit 15 keys, including numeric `repoKey` per D23; every past-cap boundary is
the exact three-key D38 stub, with no ref and no prompt-sidecar row. Pin the new bounds at
`MAX_GRADED_TURNS = 400`, `MAX_TOOLS_PER_TURN = 20`, `MAX_STATUS_PER_TURN = 20`, and
`MAX_SHAS_PER_TURN = 10`. Only the latter three make the open window `complete: false`; D39's
exhaustive list permits no other open-window cause. A non-stub `shapeKey` is either D39's `null` or
an 8-hex string. Retain D69's normalized six-word canonical phrase in local index state without
adding it to D37's enumerable window shape, and register each non-stub turn's D69 ref tuple with the
shared D73 identity carrier. `assistantTurns` is exactly D74's `Array<{ text: string }>`: each object
has no other key, every text value is redacted before draft attachment, and machine envelopes and
tool-result bodies never enter it. Derive `opensWithCorrection` from the unchanged
`REDIRECT_RE` and
`REDIRECT_BODY_RE`, with no new correction regex, then derive `correctionObserved` per D27. A valid
D2 command boundary is not discarded solely because it has no prose boundary. Tool results are
attributed to the window that created their tool use, pre-boundary tool results are not assigned to
a synthetic turn, test signals are typed from test-command results, and commit SHAs remain split by
`git commit` versus read-only git inspection.
(D2, D3, D4, D23, D27, D37, D38, D39, D41, D69, D73, D74)

R5. Mine ideas from human instruction text and assistant text into the exact D4 idea shape using
D39's closed cue vocabulary, minting refs through R3. Pin `MAX_IDEAS_PER_WINDOW = 5` and
`MAX_IDEAS_PER_SESSION = 40`. Neither cap changes any window's `complete` flag; on the first dropped
idea, record `ideasTruncatedAtTurn: number | null` on the session entry instead. Also record
`ideasDropped: number` as the total count of otherwise-recordable ideas rejected by either cap, with
zero when neither cap bit. Per D68, `ideasDropped > 0` is the sole truncation-presence signal and
`ideasTruncatedAtTurn` is only location context, so it remains `null` when the first dropped idea is
pre-boundary. Emit pre-boundary ideas per D26, using D40's `pre:<ordinal>` string
segment, and use
`<turn>:<ordinal-within-that-turn>` for windowed ideas. Machine-envelope text and tool-result bodies
never produce ideas. Register every emitted idea's D69 canonical tuple with the shared ref index.
(D4, D5, D21, D26, D39, D40, D44, D68, D69)

R6. Thread the new turn and idea projections through public and private session entries without
changing `adaptSessions`' array return contract. A private or `display`-role entry receives the
empty forms of the new collections, never reaches transcript extraction, and carries no mined ref
or sidecar text. Existing session fields and candidate-commit values remain a pure superset, subject
only to R1, and are pinned by R11. Public entries carry both `truncatedAtTurn` and
`ideasTruncatedAtTurn` with their settled number-or-null shapes, plus numeric `ideasDropped`; the
private and `display` empty shape carries `ideasDropped: 0`. Consumers must test
`ideasDropped > 0`, never the truthiness or nullness of `ideasTruncatedAtTurn`, to detect truncation.
(D4, D5, D22, D23, D38, D39, D44, D68)

R7. Extend `lib/handoffs.mjs` to extract bounded, heading-scoped next steps and to retain a handoff
whose only mined content is next steps. Emit the D5 sibling arrays exactly as named there:
`nextSteps: [{ ref, text }]` and `reversalRefs: [{ ref, text, sectioned }]`, while preserving the
existing bare-string `reversals` array byte-for-byte. Set `sectioned: true` when the reversal line
was mined inside a `REVERSAL_HEADING_RE` section and `sectioned: false` when it was mined by the
free-floating `REVERSAL_LINE_RE` branch; a line satisfying both reversal branches is sectioned.
Implement D42's exact `NEXT_HEADING_RE`, set
`MAX_NEXT_STEPS = 20`, add no free-floating next-step rule, and set both section flags from the same
existing heading block so each heading also resets the other section. A line matching both origins
is a reversal only. Mint each ref through R3 from the handoff id and D40's string form of the source
line index, and register its D69 canonical tuple in the shared ref index without changing either
settled sibling-array shape. Record the intentional next-steps-only draft behavior delta in the
implementation PR body. (D5, D22, D40, D42, D43, D69)

R8. Extend discovery with two separate in-memory sinks and write `honestweek.prompts.json` in the
exact D20 envelope, including the D31 week envelope. Prompt rows and idea rows use the same refs as
their corresponding draft records. Emit a prompt row for each non-stub window and no row for a D38
stub. Redact only the new prompt and idea projections before applying
`MAX_PROMPT_LEN = 4000`; do not route legacy fields through that reordered path. Enforce
`MAX_SIDECAR_BYTES = 8388608` against UTF-8 serialized bytes in discovery order, stop before the
first entry that would exceed it, set `truncated: true`, and report only the dropped count. Keep
`adaptOneSession` and `adaptSessions` return values unchanged. The sidecar is never derived from the
deep-redacted draft object. (D5, D20, D31, D38, D39, D40)

R9. Ensure the ignore entries for `honestweek.prompts.json` and `honestweek.harvest.json` before
either local-state file is written, preserving idempotency and the already-tracked warning. Make
`lib/init.mjs` ensure both entries, and add both to the committed `.gitignore`. Do not add a second
README row for `honestweek.harvest.json`, which is already documented. (D20)

R10. Make `harvest` include `honestweek.prompts.json` as a second local input when present, walking
both sidecar arrays without changing its count-only stdout rule. An absent prompts sidecar preserves
current harvest behavior. Leave the `excludeSet` export and lane noun policy to D14 in Phase 2.
(D20)

R11. First add only the frozen corpus required by D19. Before changing extraction code or adding
case-specific fixtures, commit `test/fixtures/golden/draft-baseline.json` from the pre-change
discovery result over that corpus. The regression test compares every pre-existing session and
handoff field to this committed baseline, including the legacy prose arrays, tool signal, status and
redirect arrays, and candidate commits. The baseline is not regenerated after implementation
changes, and no redaction-order exception is allowed in the comparison. (D22)

R12. Add the reusable hermetic golden harness per D19 to `test/build.test.mjs`. Its source corpus is
the frozen `test/fixtures/claude-projects/golden/` root, which contains no handoff reversals, no
handoff next steps, and no over-length mined string. Materialize only the generic fixture repo path
into a newly constructed throwaway repository, fix `now`, set `CLAUDE_CONFIG_DIR` for the harness
process, and pin author name, author email, committer name, committer email, author date, and
committer date. Capture the pre-change bytes for all six modes under `test/fixtures/golden/`, then
compare Phase 1 output to those committed bytes. Materialize one generic tagged-claim-only handoff
so the D22 baseline covers the existing handoff keys without adding a reversal or next step. Two
independently constructed repositories must produce the same SHA and the same artifacts. (D19)

R13. Normalize `redaction.strictLaneNouns` in `lib/config.mjs` exactly per D13. Update
`test/config.test.mjs` so the normalized redaction object and real `loadConfig` path cover the
default, enabled, and invalid cases. Add the D13 row to the `README.md` config table, and add the
`honestweek.prompts.json` row to the existing sidecar table without duplicating the harvest row.
(D13, D20)

R14. Keep every new fixture, source token, example value, golden, baseline, and diagnostic
clean-room. Use repo-relative paths in committed prose and normalize paths before comparisons.
Exercise the reference verifier before handoff. (D19)

R15. Before any copy-gate implementation exists, **derive** the corpus into
`test/fixtures/lane-corpus/copy-gate-corpus.json` by running D70's five-step extraction procedure
over its named sources. Do not hand-author the strings and do not select the sources: D70 fixes both,
so that the corpus cannot be chosen to suit a result nobody has measured yet. Commit the generator
beside the artifact so the derivation is reproducible at the phase commit. Store the `prompts` array
and its `sha256`, pin the same checksum as a literal in a test outside the artifact, and prohibit
regenerating or tailoring the corpus after Phase 2's copy-gate result is known. Compute the checksum
over the UTF-8 bytes of `JSON.stringify(prompts)` and do not trust the artifact's own `sha256`
field. (D70)

R16. Before changing handoff extraction, create D71's dedicated clean-room project root outside the
frozen D19 corpus and commit
`test/fixtures/golden/draft-baseline-reversals.json` from pre-change discovery. Its source contains
one handoff with a `## Reversals` section whose bare-string result is exactly
`["Reverted the retry change.", "Do not resurrect the polling branch."]`, followed by a
`## Next steps` section containing `- Write the focused parser test.`, plus a separate
next-steps-only handoff containing `- Add a focused parser test.` that pre-change discovery drops.
Keep the resulting reversal array nonempty and immutable after implementation. (D19, D22, D71)

R17. Implement D73's `createLaneIdentityCarrier()` and `validateRefIdentity()` in `lib/lanes.mjs`.
Create exactly one carrier per discovery or build and pass that same object through the optional
final `{ identityCarrier }` dependency to `adaptSessions` and `discoverHandoffs`, without changing
either legacy return. Register turn, idea, next-step, reversal, and shape records at extraction time,
while their exact ordinals and already-redacted source values are available. `records()` returns
D73's frozen exact-key records in registration order. The shared ref index validates each pair
before it detects a same-hash/different-canonical collision; the shape index identifies both
colliding canonical groups so later grading can under-claim rather than merge them. Identical
canonical repeats are not collisions. Keep the carrier, canonical strings, and normalized phrases
build-local and out of the D37 window shape, sidecar, rendered artifacts, and archive snapshots. No
consumer may re-mint or reimplement validation or collision checks. (D5, D39, D69, D73)

## Acceptance criteria

A1. `node --test` from the repository root exits 0, and the pre-change total of 371 passing tests
does not decrease. (R14)

A2. One comparison over the committed six-mode golden set reports zero differing bytes for `post`,
`changelog`, `digest`, `report`, `page`, and `site`. (R1, R12)

A3. One deep equality over the outputs from two independently constructed, fully pinned throwaway
repositories succeeds. (R12)

A4. A site-mode golden build over the valid frozen corpus exits 0 while its emitted bytes remain
equal to the pre-change site golden. (R1, R12)

A5. One recursive comparison against `test/fixtures/golden/draft-baseline.json` reports equality for
every pre-existing session and handoff field named by R11. (R6, R11)


A8. Feeding the command-message-first record from
`test/fixtures/claude-projects/proj-automated/sessE.jsonl` to the boundary extractor yields exactly
one window whose selected fields deep-equal `{ index: 0, kind: 'command' }`. (R4)

A9. A command fixture containing `<command-message>status</command-message>`,
`<command-name>run-checks</command-name>`, and
`<command-args>PRIVATEARG</command-args>` produces a sidecar prompt text equal to `run-checks`.
(R4, R8)

A10. One scan over the draft and prompts sidecar produced by A9 finds zero occurrences of
`PRIVATEARG` and zero occurrences of the command-message inner text. (R4, R8)

A11. A synthetic session with 500 boundaries produces one deep equality of
`{ records: 500, graded: 400, promptRows: 400, truncatedAtTurn: 400 }`; none of the 100 past-cap
boundaries contributes a sidecar row. (R4, R8)

A12. A single loop deep-equals every record at indices 400 through 499 from A11 to
`{ index: n, stub: true, complete: false }`. (R4)

A13. One structural scan deep-equals every non-stub key set to exactly
`index, ref, repoKey, shapeKey, kind, opensWithCorrection, correctionObserved, complete, stub,`
`assistantTurns, toolsUsed, statusSignals, testSignals, commitShas, inspectedShas`; asserts
`repoKey` is numeric; deep-equals `assistantTurns` to an array of one-key `{ text: string }` objects
whose strings already passed redaction; permits `shapeKey` to be only `null` or 8 hex per D39; and applies each
remaining D4 value rule only to its named field, with no catch-all 8-hex allowance. (R4)

A14. Direct calls with the exact D73 three-segment inputs deep-equal refs produced by hashing the
same segments joined with U+0000. Each test also asserts that `records()[0].refCanonical` contains
exactly two NUL code units and that `validateRefIdentity(ref, refCanonical)` returns the original
`{ kind, sourceId, index }`. Replacing either separator with `|`, changing one canonical segment, or
changing one ref hex digit throws. (R3, R17)

A15. Passing an otherwise identical extra prose property to each A14 input leaves all five ref
values unchanged. (R3)

A16. One equality asserts that `adaptSessions` returns an array both with and without the discovery
sidecar sinks enabled. (R6, R8)

A17. One deep equality asserts that a private session and a `display`-role session each carry the
resolved empty new-field shape and contribute zero prompt and idea sidecar rows. (R6)

A18. A pre-boundary assistant idea in session `abcd1234` produces exactly one D4-shaped idea whose
selected fields deep-equal `{ turn: null, ref: '8225f691', origin: 'assistant' }`, proving its ref
uses D40's `pre:0` string segment rather than a negative number. (R5)

A19. One scan asserts that idea-shaped text inside a tool-result body and machine-envelope text each
produce zero idea records. (R5)

A20. The dedicated D71 project root's handoff whose only content is
`## Next steps` followed by `- Add a focused parser test.` is absent from the pre-change baseline
and produces exactly one discovered handoff entry after R7, proving the drop guard includes a real
D42-scoped `nextSteps` branch. (R7, R16)

A21. One deep equality against
`test/fixtures/golden/draft-baseline-reversals.json` asserts that the dedicated reversal handoff's
pre-existing bare-string `reversals` value is nonempty and remains exactly
`["Reverted the retry change.", "Do not resurrect the polling branch."]` after `reversalRefs` is
added. (R7, R16)

A22. One deep equality asserts that a line classified as a reversal appears once in `reversals`,
once in `reversalRefs`, and zero times in `nextSteps`. (R7)

A23. One deep equality asserts that repeated discovery gives byte-identical `nextSteps` and
`reversalRefs`; that every emitted ref equals `refFor` with its actual source-line index converted to
a string; and that the next-step and reversal refs in the same handoff differ. (R3, R7)

A24. A non-truncated sidecar deep-equals the D20 top-level shape with
`generatedAt` equal to the injected time and `week` equal to the discovery run's start and end.
(R8)

A25. One deep equality asserts that every non-stub sidecar prompt has exactly
`{ ref, sessionId, turn, text }`, every normal sidecar idea has exactly
`{ ref, sessionId, turn, origin, cue, text }`, and each ref equals its corresponding draft ref.
(R5, R8)

A26. A prompt whose exact source expression is `'abcd '.repeat(10_000)` produces one sidecar `text`
whose length is exactly 4000 characters after redaction. (R8)

A27. A synthetic corpus of eight sessions with exactly 400 boundary prompts each, every prompt
using the exact source expression `'abcd '.repeat(1_000)`, writes a file whose UTF-8 byte length is
at most 8 MiB. (R8)

A28. Parsing the file from A27 succeeds and yields `truncated: true`. (R8)

A29. The stdout from A27 reports a dropped-entry count equal to
`3200 - parsed.prompts.length`, and contains none of the dropped text. (R8)

A30. One instrumented write-order comparison records both required `.gitignore` entries before the
first protected local-state JSON write in both discovery and harvest. (R9)

A31. Running `init` twice leaves exactly one `honestweek.prompts.json` line and one
`honestweek.harvest.json` line in `.gitignore`. (R9)

A32. One repository-source assertion finds both sidecar entries in the committed `.gitignore`.
(R9)

A33. With a prompts sidecar present, one equality asserts that harvest's candidates equal the
combined draft-plus-sidecar candidates; with it absent, they equal the draft-only baseline. (R10)

A34. Harvest stdout from A33 contains only counts and contains none of the candidate tokens. (R10)

A35. A real on-disk configuration with no `strictLaneNouns` key loads with
`config.redaction.strictLaneNouns === false`. (R13)

A36. A real on-disk configuration with `"strictLaneNouns": true` loads with
`config.redaction.strictLaneNouns === true`. (R13)

A37. A real on-disk configuration with a non-boolean `strictLaneNouns` value throws an error that
names `redaction.strictLaneNouns`. (R13)

A38. One documentation test finds exactly one `honestweek.prompts.json` sidecar row, exactly one
pre-existing `honestweek.harvest.json` row, and a config-table row for
`redaction.strictLaneNouns`. (R9, R13)

A39. One documentation test deep-equals invariant 6 in `AGENTS.md` to its existing sentence,
`New output is additive. Absent its new inputs, existing output stays byte-identical.`, and finds no
Phase 1 exception or redaction-order carve-out. (R1)

A40. Running
`node .claude/work/prompt-lanes/spec-v2/verify-refs.mjs . .claude/work/prompt-lanes/spec-v2`
exits 0. (R14)

A41. A table test deep-equals D39's `IDEA_CUES` keys, regex sources, and flags to the four settled
entries, then proves `What if this changes?`, `we could split this`, `Idea: split this`, and
`worth trying again` select their respective cues while mid-sentence `one idea is enough` and bare
`later` select none. (R3, R5)

A42. `shapeKeyFor('continue')`, `shapeKeyFor('ok do it')`, and a five-distinct-content-word fixture
each return `null`. `shapeKeyFor('alpha1 beta2 gamma3 delta4 epsilon5 zeta6 extra')` equals
`4060edfa`, and changing only `extra` leaves it unchanged, pinning the digit mapping, six-word floor,
and first-six construction together. (R3, R4)

A43. A synthetic session that separately exceeds five ideas in one window and 40 ideas in the
session emits no more than five for any window and 40 overall, records the first dropped idea's
numeric turn in `ideasTruncatedAtTurn`, records in `ideasDropped` the exact number of otherwise
recordable ideas rejected by the two caps, and leaves every non-stub window `complete === true`. A
companion session where neither cap bites deep-equals
`{ ideasTruncatedAtTurn: null, ideasDropped: 0 }`. (R5, R6)

A44. Three table-driven fixtures that exceed only `MAX_TOOLS_PER_TURN`,
`MAX_STATUS_PER_TURN`, or `MAX_SHAS_PER_TURN` make only the affected open window incomplete and
leave its non-stub neighbours complete. Companion fixtures that exceed each of `MAX_STEERS`,
`MAX_NOTES`, `MAX_STATUS`, `MAX_REDIRECTS`, and `MAX_CANDIDATES` leave every non-stub window
complete while distributing their inputs so none of the three per-turn evidence caps also bites.
Together with A43, this exhausts D39's closed completeness list. (R4, R5)

A45. Direct boundary tests prove that one string matching only `REDIRECT_RE` and one matching only
`REDIRECT_BODY_RE` each set `opensWithCorrection: true`, while a neutral string sets it false.
Successor-window tests then deep-equal D27's `yes`, `no`, and terminal-or-stub `unknown` states,
without introducing or testing a third correction regex. (R4)

A46. A heading table covering `next step`, `open question`, `follow-up`, `follow up`, `not done`,
`carried forward`, and `todo` extracts the following bullet as a next step. The same bullet outside
every matching section produces no next step, proving there is no free-floating line rule. (R7)

A47. A reversal heading followed by a reversal bullet and then a next-step heading followed by an
ordinary bullet puts only the first bullet in `reversals` and only the second in `nextSteps`,
proving the shared heading reset. A bullet matching both classifications remains reversal-only, and
a 30-bullet next-step section emits exactly 20 entries. (R7)

A48. One handoff containing a bullet that does not match `REVERSAL_LINE_RE` inside a
`## Reversals` section and, after a neutral heading, a free-floating line matching
`REVERSAL_LINE_RE` emits both rows in `reversalRefs`: the section bullet has `sectioned: true`, the
free-floating line has `sectioned: false`, and both retain their actual source-line refs. (R7)

A49. A session containing exactly 41 pre-boundary assistant text blocks made by
`Array.from({ length: 41 }, (_, i) => 'Idea: candidate number ' + i + '.')`, followed by the first neutral
human boundary, emits exactly 40 ideas and deep-equals
`{ ideasDropped: 1, ideasTruncatedAtTurn: null }`. The assertion treats
`ideasDropped > 0` as truncation even though no numeric drop location exists. (R5, R6)

A50. A table test makes each D59 normalization branch capable of failing:
`'  CAFÉ—Ｆｏｏ!!  123  '` normalizes to `'café foo 123'`,
`'Echo, echo; ECHO.'` normalizes to `'echo echo echo'`, and
`'alpha_1\tBETA-22'` normalizes to `'alpha 1 beta 22'`. A companion table pins D72's array as a
literal and asserts `FILLER.length` equals its stated count, so a member silently added or dropped
fails the test rather than changing a grade. (R3, D59, D72)

A51. Re-running D70's extraction procedure over its named sources deep-equals the committed
`prompts` array, so the artifact is provably derived rather than authored. Hashing those exact
serialized array bytes with `node:crypto` using R15's serialization deep-equals both the artifact's
`sha256` and a checksum literal held in the test, so editing the corpus or its prompt order without
re-deriving fails. The array is non-empty and every entry has at least four normalized words, so a
downstream zero-hit result cannot come from an empty or unusable corpus. No entry matches the D70
step-3 URL guard, which is what keeps the repository URL out of a committed fixture. (R15, D70)

A52. The real canonical ref strings `turn|fab5a81d|6646` and
`turn|2ce6dbd0|5102` each hash to `8c2a7648` while remaining unequal. Feeding both to R17's shared
ref index is rejected before a ref lookup can be returned, while inserting either canonical value
twice is accepted as one identity. No hash stub or mocked minter is used. (R3, R17)

A53. The real normalized phrases
`hjoiwan nmtvpua bzpxwah xooywlk rszzdri cysqzlg` and
`swtlatj wtttgii tugriij qolqxwn meiiugf ffnkavj` each hash to `c370b388` while remaining unequal.
Feeding both to R17's shared shape-key index reports both canonical groups as colliding and produces
no merged recurrence group, while two copies of the first phrase remain one ordinary group. No hash
stub or mocked minter is used. (R3, R17)

A54. A table drives the exact prompt source
`'abcd '.repeat(798) + 'you@example.com tail'` and the exact assistant-idea source
`'Idea: ' + 'abcd '.repeat(797) + 'you@example.com tail'` through their new projections. Each
source contains `@` after a 4000-character slice taken before redaction, while every written prompt
or idea sidecar `text` contains no `@`, making redaction-before-cap order capable of failing for both
new sinks. (R4, R5, R8)

The changed acceptance cases are pairwise satisfiable. A43's capped and uncapped sessions are
separate fixtures, and A48's two-origin handoff is independent of A21's baseline preservation,
A22's reversal-only classification, and A47's shared-reset and bound fixture. A49's pre-boundary
session is separate from A43's numeric-turn truncation case. A52 and A53 use independently verified
real collisions and each includes a same-canonical control, so neither confuses repetition with a
collision. A54 uses separate prompt and idea sources and does not reuse the frozen D19 corpus or
either D22 baseline.

A55. Filler removal is proved in both directions, per D72's acceptance. Three pairs differing only
by an excluded token produce **different** `shapeKeyFor` values: one differing only by `not`, one
differing only by `before` versus `after`, and one differing only by `all` versus `some`. Two pairs
differing only by a `FILLER` member produce **equal** values: one differing only by a leading
`please`, one differing only by a leading `just`. Each input is at least six content words after
removal, so no pair passes by both sides returning `null`. Without the differing half this table
would pass with `FILLER` set to every word in English, which is why both halves are required.
(R3, D59, D72)

A56. The explicit D79 modal pair
`you must run focused checks before changing code today carefully` and
`you may run focused checks before changing code today carefully` produces two non-null, different
`shapeKeyFor` values. The positive control that adds only a leading `please` produces the same
non-null value. Removing `must` and `may` from the producer makes the first assertion fail. (R3,
D72, D79)

A57. One end-to-end extraction creates a single D73 carrier, injects it into both adapters, and
registers a turn, a pre-boundary idea, an in-turn idea, a handoff next step, and a handoff reversal.
The adapters retain their legacy array returns. `records()` exposes all five exact canonicals and
source ordinals to a Phase 2 consumer; spies prove Phase 2 calls neither `refFor` nor an ordinal
reconstruction. A conflicting same-ref/different-canonical registration throws before either
adapter returns. (R5, R7, R17)

## Files touched

- `lib/claude-adapter.mjs`: add redaction-first handling only for the new projections, D37/D38 turn
  shapes, D39 bounds, D44/D68 idea truncation metadata, D41 correction reuse, attribution, refs, and
  sidecar sinks while preserving every legacy field and the array return contract.
- `lib/lanes.mjs`: add the pure D5/D40 ref minter, D39/D59 cue and shape-key helpers, and D69's
  canonical-aware shared indexes.
- `lib/handoffs.mjs`: add D42's bounded next-step extraction, D43 reversal provenance, and D5/D40
  sibling ref arrays, then update the next-steps-only drop guard.
- `lib/discover.mjs`: collect the two sidecar sinks, ensure ignore entries first, and write the D20
  and D31 envelope with bounded counts-only diagnostics.
- `lib/harvest.mjs`: include the prompts sidecar as an optional second local input.
- `lib/config.mjs`: normalize and validate `redaction.strictLaneNouns`.
- `lib/init.mjs`: ensure the prompts and harvest sidecar ignore entries.
- `.gitignore`: add the prompts and harvest sidecar entries.
- `README.md`: document `strictLaneNouns` and the prompts sidecar without duplicating the harvest
  row.
- `test/claude-adapter.test.mjs`: cover boundary classification, attribution, structural privacy,
  bounds, D68 pre-boundary idea truncation, private symmetry, and the legacy/new redaction split.
- `test/lanes.test.mjs`: pin D5 ref algebra, D59 normalization and filler behavior, D69 real
  collisions, D70's corpus checksum, and the remaining pure evidence helpers.
- `test/discover.test.mjs`: cover the exact sidecar envelope, matching refs, byte budget, write
  ordering, counts-only diagnostics, unchanged adapter contract, and draft-superset baseline.
- `test/handoffs.test.mjs`: cover next-step extraction, precedence, bounds, refs, drop-guard behavior,
  and preservation of bare-string reversals.
- `test/harvest.test.mjs`: cover combined draft and prompts-sidecar harvesting and absent-sidecar
  compatibility.
- `test/config.test.mjs`: cover the D13 loader default, enabled, and invalid cases.
- `test/init.test.mjs`: cover both new ignore entries and idempotency.
- `test/build.test.mjs`: add the reusable D19 six-mode hermetic golden harness.
- `test/docs.test.mjs`: pin the README additions and the unchanged AGENTS invariant.
- `test/fixtures/golden/draft-baseline.json`: commit the pre-change discovery baseline required by
  D22.
- `test/fixtures/golden/draft-baseline-reversals.json`: commit D71's nonempty pre-change reversal
  baseline.
- `test/fixtures/lane-corpus/copy-gate-corpus.json`: commit D70's pre-gate normalized corpus and
  checksum.
- `test/fixtures/golden/`: commit the pre-change rendered bytes for the six D19 modes.
- `test/fixtures/claude-projects/golden/`: add the frozen, clean-room D19 transcript corpus and keep
  it isolated from case-specific fixtures.
- `test/fixtures/claude-projects/`: add D71's dedicated reversal and next-step project root outside
  the frozen corpus.

## Test plan

`test/lanes.test.mjs`

- Pin all five A14 refs, string-index construction, text independence, kind separation, handoff-id
  separation, and repeat-run stability.
- Table-test D39's exact four-cue vocabulary and negative controls, plus D59's normalization order,
  exact closed filler array once settled, six-distinct-word floor, first-six construction, and
  digit-run normalization.
- Use the literal A52 and A53 pairs to exercise the shipped FNV-1a implementation and both D69
  canonical-aware indexes without stubbing the hash.
- Re-extract D70's fixed multi-session corpus, deep-equal its prompt array, and recompute the
  externally pinned SHA-256.

`test/claude-adapter.test.mjs`

- Reuse the command-message-first `sessE` record for D2, and generate a command-with-args case that
  proves the args and message bodies never enter the draft or sidecar.
- Update the existing exact entry-count assertion and its title for the newly retained command-only
  fixture session; keep every pre-existing entry value pinned by the D22 comparison.
- Generate 500 boundaries in memory and assert the D3/D38 counts, exact ref-free stubs, and exactly
  400 matching prompt rows.
- Test delayed tool results against their originating turn, typed test results, commit-versus-inspect
  SHA arrays, D40 pre-boundary refs, and private/display empty symmetry.
- Deep-equal D37's explicit 15-key non-stub shape and D4's field-specific value rules.
- Exercise all eight D39 bounds. Trip each of the three evidence caps separately; prove each flat
  legacy cap and both idea caps leave non-stub windows complete; and pin
  `ideasTruncatedAtTurn` independently of `truncatedAtTurn`. For the idea caps, assert D44's exact
  `ideasDropped` count, the uncapped zero, and A49's pre-boundary dropped idea whose location stays
  null.
- Test D41's two unchanged redirect patterns independently and pin every D27 successor state,
  including terminal and next-stub `unknown`.
- Keep the phase-start legacy projections pinned by the D22 baseline; add redaction-order coverage
  only for the new prompt and idea projections using A54's boundary-straddling email controls.

`test/discover.test.mjs`

- Update the injectable adapter fixture with the resolved new entry fields while keeping its return
  value a bare array.
- Pin normal sidecar shape, week and generation time, non-stub prompt/idea ref equality, zero rows
  for stubs, redaction before the 4000-character cap, the valid JSON 8 MiB stop rule,
  `truncated: true`, exact dropped count, and counts-only stdout.
- Spy on write ordering so both ignore entries precede protected local-state writes.
- Compare all pre-existing fields to `test/fixtures/golden/draft-baseline.json`, then keep the
  existing byte-identical rerun assertion.
- Generate `test/fixtures/golden/draft-baseline-reversals.json` before extractor changes, assert its
  exact nonempty D71 reversal array, and never regenerate it from post-change output.

`test/handoffs.test.mjs`

- Add D42's exact heading alternatives, no-free-floating negative control, next-steps-only handoff,
  shared section reset, reversal-wins precedence, 20-entry bound, and D40 stable source-line ref
  cases.
- In one handoff, assert D43's `sectioned: true` row from a reversal section and
  `sectioned: false` row from the free-floating reversal-line branch.
- Deep-equal existing bare-string reversals against D71's nonempty baseline and candidate commits
  against the D22 baseline.

`test/harvest.test.mjs`

- Compare combined-input candidates with the draft-only baseline and prove both stdout paths remain
  count-only.
- Assert the prompts and harvest ignore entries are ensured before the harvest sidecar write.

`test/config.test.mjs`

- Drive D13 through real config files for absent, `true`, and non-boolean values; update existing
  exact normalized-redaction assertions.

`test/init.test.mjs`

- Assert `init` alone writes each required sidecar ignore entry once and stays idempotent on rerun.

`test/build.test.mjs`

- Build all six modes from the frozen corpus with a fixed time, a materialized generic repo path, a
  clean static site adapter, and fully pinned git identity and dates.
- Compare each mode to its committed pre-change golden, then reconstruct the repo independently and
  compare the second SHA and all second-run bytes.

`test/docs.test.mjs`

- Pin the unchanged invariant-6 sentence, the single prompts row, the existing single harvest row,
  and the D13 config row.

Fixture sets

- `test/fixtures/claude-projects/golden/` is the frozen byte-identity control only. It receives no
  later case-specific sessions and contains no reversal, next-step, or over-length mined prose.
- D71's dedicated project root is separate from the frozen corpus, carries the exact two-reversal
  baseline handoff and the separate next-steps-only handoff, and is the input for A20 and A21.
- D70's committed copy-gate corpus is captured before any copy-gate implementation and is immutable
  after Phase 2 measures it.
- Command, bound, attribution, idea, and sidecar-budget cases are generated under isolated temporary
  project roots so they cannot change golden session counts.
- Every committed or generated fixture uses generic labels, `you@example.com`, and
  `/path/to/your/repo`, and passes the existing clean-room scans.

Full verification

- Run `node --test` from the repository root with no path argument.
- Run the reference verifier with the exact command in A40.

## Risks

- A structural scan based only on a key count can drift when a field is added or replaced. R4 and
  A13 pin D37's full 15-key list and the numeric `repoKey` rule.
- Treating a D3 stub as an ordinary ref-bearing window breaks its exact shape and needlessly grows
  the prompt sidecar. R4, R8, and A11 through A13 pin D38's ref-free, sidecar-free stub behavior.
- Treating idea truncation as Lane A incompleteness would undercount long or idea-heavy sessions.
  R5, A43, A44, and A49 keep D39's idea truncation metadata separate from its exhaustive three-cause
  completeness rule, while D68 makes the drop count authoritative even when the location is null.
- Applying redaction-first to a legacy mining path would silently reintroduce the invariant break
  removed by D61. R1, R8, the D22 baseline, A39, and A54 preserve legacy bytes while protecting only
  the new projections.
- A command parser that keys on the first tag misses the common command-message-first record; one
  that reads the whole envelope can leak command arguments. A8 through A10 guard both sides.
- Character counts do not enforce an 8 MiB UTF-8 file budget. R8 and A27 measure serialized bytes,
  then A28 proves the stopped file is still JSON.
- Ref inputs that include prose, numeric index conventions, filtered-array ordinals, or separate
  minters orphan later joins. R3, R5, R7, A14, A15, A18, and A23 pin D40's string segments and one
  identity-only function.
- Treating an 8-hex ref or shape key as collision-free can misjoin evidence or fabricate recurrence.
  R17 and the real A52/A53 pairs keep canonical values until the shared indexes distinguish a hash
  collision from an ordinary repeat.
- A new correction regex would fork the meaning of a redirect. R4 and A45 pin D41's reuse of both
  existing patterns unchanged.
- Updating only one handoff section flag leaves the other stale under a new heading. R7, A22, A46,
  and A47 pin D42's shared reset and reversal-wins rule; A48 separately pins D43's two provenance
  values.
- Changing the shape returned by `adaptSessions` breaks discovery's injectable adapter contract.
  R6 and A16 keep the return as an array.
- The next-steps-only drop-guard change intentionally adds local draft entries for existing repos.
  R7, R11, A20, and the required PR-body note distinguish that local-state delta from a rendered
  byte change.
- A copy-gate measurement can be tailored after its result is known, and an empty reversal baseline
  can pass without exercising preservation. R15/A51 freeze and independently checksum the former;
  R16/A21 require the latter to contain two exact strings before extraction changes.
- A golden harness tied to host logs, the current clock, an unpinned git identity, or one reused repo
  can pass locally and fail in CI. R12, A2 through A4, and the independent reconstruction in A3
  remove those inputs.
- A private or `display`-role repo can leak through either transcript extraction or handoff
  discovery if the early role guards move. R6, A17, and the existing never-git-read tests remain
  mandatory.
