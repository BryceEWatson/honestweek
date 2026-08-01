# Phase 2: Lane substrate + Lane A

## In plain terms

honestweek will add a clearly separate section for prompting techniques that have measurable session
evidence. The model may name a technique, but the program decides whether the session record supports
showing it and which cautious observation label it receives. Every technique line will point back to
the session turn that supports it, and private wording will still pass through the same redaction and
leak checks as the work report. If the session record is unavailable, honestweek will omit the
optional lane and still produce the work report with a loud explanation. This phase also finishes the
shared wording and rendering rules that the later forward-looking lane must use without rewriting.

## Scope

- D3.
- D5.
- D6.
- D7.
- D8.
- D9.
- D10.
- D11.
- D13.
- D14.
- D15.
- D16.
- D17.
- D18.
- D19.
- D20.
- D23.
- D24.
- D25.
- D27.
- D28.
- D30.
- D31.
- D32.
- D33.
- D35.
- D36.
- D37.
- D38.
- D39.
- D40.
- D41.
- D49.
- D50.
- D51.
- D52.
- D53.
- D54.
- D55.
- D59.
- D60.
- D62.
- D63.
- D64.
- D65.
- D67.
- D68.
- D69.
- D70.
- D72.

## Out of scope

- Do not read, write, migrate, or gitignore `honestweek.forward-index.json`; D12 belongs to Phase 4.
- Do not read or produce `forward[]`, derive a disposition, render a handoff-sourced row, or implement
  `forwardUnactioned`. Phase 2 may author and test the settled copy branches, reserved vocabulary,
  and shared row-format policy. In `SKILL.md`, it reserves rule 8's number and title only, marks the
  rule inactive until Phase 3, and publishes neither its body nor a Forward item shape. (D54, D62)
- Do not change `lib/handoffs.mjs`, the Phase 1 ref algebra, turn extraction, idea extraction, sidecar
  writer, or `config.redaction.strictLaneNouns` loader behavior.
- Do not change the Phase 1 `normalizePhrase` or `FILLER` producer contract, the pinned
  `test/fixtures/lane-corpus/copy-gate-corpus.json`, or any Phase 1 collision fixture. Consume those
  inputs as committed. (D59, D69, D70)
- Do not add lane roots to the site bundle, render a lane in `site` or `changelog`, or weaken the gate
  for either mode. A gated lane-bearing `changelog` build still emits D52's runtime notice.
- Do not add to, remove from, or reorder `STATUSES`. Do not route a lane value through the work-item
  badge, grouping, sorting, or item-count paths.
- Do not weaken or qualify AGENTS invariant 6. Phase 2 must preserve lane-absent artifacts and stdout
  byte for byte. (D63)
- Do not add a runtime dependency, a lockfile, network access, telemetry, or an auto-publish action.

## Requirements

### Lane and taxonomy substrate

R1. Treat a lane array as present only under the single D6 predicate
`Array.isArray(value) && value.length > 0`. Use that predicate for item-file extraction, validation,
gating, conditional model attachment, rendering, contract copy, empty-state copy, and counts.
`undefined`, `null`, and `[]` are absent and must not start a corpus scan. The Phase 2 implementation
uses the predicate for `techniques`; the four-way copy helper accepts booleans so Phase 3 can supply
forward presence without Phase 2 reading `forward[]`. (D6)

R2. Add the D9 and D35 exports to `lib/badges.mjs`: `TECHNIQUE_GRADES`,
`DISPOSITIONS`, and `RESERVED_FOR_WORK_LANE`, with their exact settled members and order. Keep
`STATUSES` byte-for-byte unchanged at `lib/badges.mjs:12`, keep `statusForTag`'s under-claim fallback,
and assert the vocabulary-level isolation required by D35. Lane A's page legend text must describe
the observation, never claim that a technique worked. (D9, D35)

R3. Finish `lib/lanes.mjs` as the shared home for Phase 2's lane operations. Export the D30 copy
gate, the Lane A group grader, and these four exact pure text-gate interfaces:

```js
checkConfiguredPrivateTerms(rows, { config }) // -> { hits: [{ id, count }] }
checkDisplayLabels(rows, { config })           // -> { hits: [{ id, count }] }
checkUnconfiguredNouns(rows, { config })       // -> { hits: [{ id, count }] }
checkLaneVoice(rows, { config })               // -> { hits: [{ id, count }] }
```

`rows` is an array of exactly `{ id: string, text: string, repo?: string }`. Each `hits` array is
sorted by `id`, has at most one entry per affected row, and `count` is a positive integer. For the
noun gate it is the row's distinct unmatched-token count; for the other gates it is the number of
matches or rule violations. These result objects are also the complete diagnostic payload: they
contain no matched token, label, configured term, voice phrase, source prose, or preformatted
message. The four functions do not read files, run git, print, or write. Build and validate format
their policy-level messages from these results, and Phases 3 and 4 must reuse the exports rather than
forking their logic or result shapes. (D7, D14, D30, D32, D51, D55)

### Lane A authoring and grading

R4. Accept authored Lane A input only at the top-level `techniques` array. A row is
`{ id, text, repo?, receipt: { sessionId, turn } }`: `id` is unique and matches
`/^technique-[a-z0-9-]+$/`, `text` is non-empty, `repo` is an optional configured label, `sessionId`
is the Phase 1 eight-hex entry id, and `turn` is a non-negative integer matching `turns[].index`.
The model must not control `grade`, `shapeKey`, `repeatedOpenings`, or the evidence line; if present
in the items file, those values are ignored and cannot change output bytes. Enforce D67 before
corpus resolution: a duplicate authored `id` aborts, and every accepted `id` remains local-only for
the stripping step in R24. (D8, D9, D18, D32, D36, D67)

R5. Implement the Lane A grader as one result per `shapeKey` group, not one result per window. Use
the Phase 1 fields named by D18 and the D27 relationship without recomputing correction text. A
window is eligible only when `stub === false`, `complete === true`, `kind === 'prose'`, and
`shapeKey !== null`. `testRunFlip` is true only when ordered `testSignals` contain a
`fail` or `build-broke`, later contain `pass`, and contain no later `fail` or `build-broke`.
`committed` is true only when the grader's injected `resolveCommit` callback returns
`state: 'resolved-authored'` for a member of `commitShas`; build injects R6's single shared
`resolveLaneCommit` export. `inspectedShas` never contributes.
Apply these exhaustive definitions with the D9 labels:

- `no correction observed`: `correctionObserved === 'no'`, the immediately preceding non-stub
  window is not the same shape, and this window has `testRunFlip || committed`.
- `repeated without correction`: the group occurs in at least two distinct sessions, every window
  in the group is eligible and has `correctionObserved === 'no'`, and at least one has
  `testRunFlip || committed`.
- `correction observed`: `correctionObserved === 'yes'` and this window or its immediately following
  window has `testRunFlip || committed`.
- Precedence is `repeated without correction`, then `no correction observed`, then
  `correction observed`; a group matching none is absent.

Set `repeatedOpenings` to the group's eligible-window count. A `repeated without correction` row may
cite any eligible member because the grade's recurrence predicate covers the whole group. For either
other grade, the authored receipt must cite the member that satisfies the stated per-window
predicate; the following window may supply the evidence only for `correction observed`. Discard
authored rows that cite a different member before deduplicating, then render the earliest remaining
authored row by receipt order and drop later rows as authoring redundancy. Per D3, never assign
`repeated without correction` when any session contributing a window to the group has
`truncatedAtTurn !== null`. (D3, D9, D23, D27, D36, D50)

R6. Export D50's one shared commit resolver from `lib/lanes.mjs` with this exact interface:

```js
resolveLaneCommit(sha, { repoKey, config })
// -> { state, sha, repoLabel }
```

The result always has exactly those three keys. `sha` is the input string. `repoLabel` is the
configured label when `repoKey` selects a repo and is `null` when it does not. `state` is exactly one
of D50's six members. Resolve through the existing `lookupCommit` path at `lib/git.mjs:71`, and guard
a `display` role before any git call, matching the ordering already enforced for work items at
`lib/git.mjs:264`. Missing and out-of-range `repoKey` values take the same `no-repo-key` branch;
a throw takes `unusable-repo`; an ordinary miss takes `unresolved`; and a resolved commit whose
author is not configured takes `resolved-other-author`. Only `resolved-authored` is positive commit
evidence. `unresolved` and `unusable-repo` count the affected authored row once as failed optional
evidence; no other state does. The Lane A grader receives this export as its `resolveCommit`
callback. Phase 3 must inject the same export into the Lane B grader and must not create a second
resolver or translate its states. (D23, D24, D49, D50, D55)

R7. Render one deterministic evidence clause adjacent to every technique row. For a
`no correction observed` row, use exactly one of these same-window clauses:

- tests only: `tests went failing to passing in the same window`
- commit only: `an authored commit resolved in the same window`
- both: `tests went failing to passing and an authored commit resolved in the same window`

For `repeated without correction`, use exactly
`<N> windows, same shape, no correction`. For `correction observed`, prefer evidence from the cited
window when it has either signal; otherwise use the immediately following window. Use exactly one
of these clauses for cited-window evidence:

- tests only: `tests went failing to passing in the cited window; a correction opened the next window`
- commit only: `an authored commit resolved in the cited window; a correction opened the next window`
- both: `tests went failing to passing and an authored commit resolved in the cited window; a correction opened the next window`

Use exactly one of these clauses for following-window evidence:

- tests only: `a correction opened the next window; tests then went failing to passing`
- commit only: `a correction opened the next window; an authored commit then resolved`
- both: `a correction opened the next window; tests then went failing to passing and an authored commit then resolved`

Tests take ordering priority only when deciding the both-signal sentence; neither signal outranks the
other for grading. The grade and clause are engine-derived. The authored technique name remains the
only model-written part of the row. (D9, D36)

### One re-derivation and the two-class gate

R8. Add one memoized build-local `ensureLaneCorpus()` operation with this exact result contract:

```js
{
  sessions,       // the Phase 1 adaptSessions() array, unchanged
  handoffs,       // the Phase 1 discoverHandoffs() array, unchanged
  sessionFiles: { count, state },
  identities: [{
    ref, refCanonical, kind, repoKey, repo, receipt, text, sectioned,
    shapeKey, shapeCanonical
  }],
  copyRunIndex
}
```

`sessionFiles.count` is a non-negative integer and `state` is exactly `'present'` when the count is
positive or `'absent'` when it is zero. `identities` is an array; each member has exactly the listed
keys. `ref` and `refCanonical` are strings. `kind` is one of the four D5 origins. `repoKey` is the
non-negative configured-repo index, and `repo` is that config entry's label, derived from the
resolved session or handoff rather than authored input. `receipt` is exactly
`{ sessionId: string, turn: number | null }` or `{ handoffId: string }`. `text` is the redacted
source string for idea and handoff identities and `null` for turn identities. `sectioned` is a
boolean for reversal identities and `null` otherwise. `shapeKey` and `shapeCanonical` are strings
for a shape-bearing turn, are both `null` for a below-floor turn, and are both `null` for other
identity kinds. `copyRunIndex` is D78's frozen `Map<string, number>` from lowercase 64-hex SHA-256
run hashes to positive occurrence counts and contains no recoverable prompt, idea, or normalized-run
source string. The `identities` array is exactly the
result of the one D73 carrier injected into both Phase 1 adapters; `ensureLaneCorpus()` never calls
`refFor`, rebuilds an ordinal, or constructs `refCanonical`.

On first use, construct `weekStart` and `weekEnd` Dates from the normalized string week, resolve the
root with `resolveProjectsRoot()`, record the file-count state with `enumerateSessionFiles`, create
one D73 carrier, pass it to `adaptSessions` and `discoverHandoffs`, and take `identities` from
`carrier.records()`. Later consumers receive the same object identity and
no second scan occurs. Pass no `projectsRoot` override, preserving `CLAUDE_CONFIG_DIR` as the
hermetic test override. Build never reads `honestweek.draft.json` or
`honestweek.prompts.json`; validate is the only Phase 2 sidecar consumer. The current entry points
are `lib/claude-adapter.mjs:524` and `lib/handoffs.mjs:103`. R30, not a consumer, builds the two
collision-aware indexes from this result. (D20, D28, D55, D65, D69, D73, D78)

R9. Implement D10's two failure classes before the emit try block that starts at
`lib/build.mjs:389`.

| D10 class | What could not be resolved | Behavior |
| --- | --- | --- |
| Corpus-absent / unresolvable | **Row identity:** its `ref` matches no record, the corpus is absent, the validate sidecar is absent/unparseable/stale, or the carry index is absent/unparseable. | Drop the affected band or rows loudly, emit the work report, and exit 0. There is no row identity to render. File-level absent/unparseable states follow D64 and never invent a count. |
| Corpus-absent / unresolvable | **Optional evidence:** a commit lookup throws or the SHA does not resolve. | Keep the identity-resolved row. A forward row renders as `not started`; a technique receives no commit evidence but may still grade from an independent test flip. Build reports the number of rows whose commit resolution failed. |
| Positive dishonesty hit | Copy, display-role label, configured private term, strict noun, or enabled voice-fence hit. | Exit 2 and write nothing. |

An identity-resolved but ineligible or ungraded technique remains absent as the ordinary Lane A
under-claim, not as a failed identity or failed commit resolution.

- A row-level or zero-file-corpus diagnostic, where the affected count is derivable, is exactly
  `<command>: lane <band> dropped <count> row(s): <reason>. Work output continues. Re-run with --no-lanes to skip lanes.`
- A file-level absent or unparseable diagnostic is exactly
  `<command>: lane <band> unavailable: <file> is <reason>. Work output continues. Re-run with --no-lanes to skip lanes.`
  It contains no numeric dropped-row count. `<file>` is the repo-relative state-file name, never an
  absolute machine path. A parseable stale-week sidecar is a row-level drop and reports its exact
  affected-row count.
- A failed-optional-evidence diagnostic reports the numeric affected-row count, does not call those
  rows dropped, and names `--no-lanes`.
- A positive-hit diagnostic begins
  `<command>: ABORTED - lane <band>: <reason>. Re-run with --no-lanes to skip lanes. No output was written.`

Diagnostics name ids or counts, never offending prose, residual noun tokens, display labels, voice
phrases, or matched private terms. The D51 default noun summary is count-only by row id and has no
exception to this rule. (D10, D15, D24, D49, D51, D64)

R10. Add a real `--no-lanes` flag to both `build` and `validate`. It makes both commands ignore all
authored lane arrays, suppress all engine-derived lane rows, skip the lane corpus and sidecar reads,
skip all lane gates and lane rendering, and preserve the work-only command's normal result. Every
lane warning, drop, abort, and help entry must name `--no-lanes` verbatim. Add
`build --explain-lanes` as a read-only path that runs the one re-derivation and prints one line per
gradeable group with only its grade, `sessionId`, `turn`, `shapeKey`, and `repeatedOpenings`; it
prints no prompt text, writes no report or archive, and exits 0. Document both flags in the
dispatcher help, README, and SKILL flow. (D10, D18)

R11. Run the gate in all six output modes. Lane A renders only in `digest`, `report`, `page`, and
`post`; `changelog` and `site` still pay the gate and produce work-only output. After a valid
lane-bearing `changelog` build passes every gate, stderr contains exactly one notice:
`build: changelog mode ignored <count> lane row(s) after gating. Re-run with --no-lanes to skip lanes.`
The count is the derived Lane A plus Lane B row count that would be attached in a rendering mode;
Phase 2 supplies only Lane A's part. A lane-bearing `site` build remains silent because site already
has a same-run byte-identity control. (D15, D52)

### Copy, noun, display, redaction, and voice gates

R12. Implement build's `sharesRun(authored, copyRunIndex)` exactly per D30/D78 and expose its
boolean result without the matching text or run. Implement validate's separate
`sharesRunAgainstSidecar(authored, corpusStrings)` over the available `prompts[].text` and
`ideas[].text` from `honestweek.prompts.json`; it is explicitly partial when that sidecar is
truncated. Build supplies only R8's opaque complete `copyRunIndex`, so it remains authoritative
without retaining corpus source strings. Consume the
Phase 1-captured `test/fixtures/lane-corpus/copy-gate-corpus.json` unchanged. Before measuring a
false-positive result, recompute its `sha256` with `node:crypto` over
`JSON.stringify(corpus.prompts)` and require equality with the artifact's checked-in `sha256`.
Measure the ten fixed A29 names under D53's precommitted floor/escalation rule; a checksum mismatch
fails before the copy-gate assertions run. Report a real hit by row id without echoing the text or
matching run. (D20, D30, D53, D70, D78)

R13. Export the existing module-private `excludeSet` at `lib/harvest.mjs:74`, seed it with D51's
combined baseline, and use it with the already-exported `harvestNouns` at
`lib/harvest.mjs:55`. With `strictLaneNouns: false`, emit one count-only summary line from R3's
`checkUnconfiguredNouns` result: it names each affected row id and distinct unmatched-token count,
never a token value and never authored text. With `strictLaneNouns: true`, the same hit is a D10
positive dishonesty abort. Read the key from the Phase 1-normalized config; do not re-parse raw config
in either consumer. (D13, D14, D51, D55)

R14. Apply both parts of D32 independently to every authored technique. Check an optional `repo`
field against config roles, and case-insensitively scan `text` for each configured display-role
label as a substring. Featured and reference labels are permitted unless another gate catches them.
Also scan `text` for configured `redaction.codenames`, `redaction.names`, and `redaction.terms`.
This scan is case-insensitive, matching the current work-item term check at
`lib/validate.mjs:131`. These are positive dishonesty hits in validate and build, reported by row id
with no matched label or term echoed. Do not reuse work-item `itemRepoLabel` alone: the current
field-only check begins at `lib/validate.mjs:121` and cannot see a label in lane prose.
(D7, D10, D32)

R15. Run R3's `checkLaneVoice` over the technique rows when `voice.denyMeta` is enabled. The helper
reuses the shipped `checkVoice` rules internally but remains separate from the work-item call at
`lib/build.mjs:336`, so a lane violation reports its D67 technique id and can never be mislabeled as
`item[N]`. This remains a D10 positive honesty hit and its message includes `--no-lanes`. (D7, D10,
D55, D67)

R16. Validate lane rows with a sibling pure validator rather than widening `validateItems`. Extract
`techniques` beside the current work-item extraction at `lib/validate.mjs:187`. When a lane is
present, read and parse the sidecar; compare `week.start` and `week.end` field-wise only when the
items envelope carries `week`. If the items envelope has no week, skip the comparison and print that
the check was skipped. When `truncated === true`, run the copy check over available rows and warn
that validate is partial while build remains authoritative. Route structural row failures through
the D10 unresolvable/drop channel except D67's duplicate-id abort, and route positive text hits
through the abort channel. (D10, D20, D31, D67)

### Attach point, receipt, render, and copy policy

R17. Attach lane keys only after report-model assembly and before `deepRedact`, using a conditional
spread. In markdown modes, copy the base model returned at `lib/build.mjs:323`, conditionally attach
the derived `techniques`, then pass that object to the redaction call currently at
`lib/build.mjs:443`. In page mode, conditionally attach after `buildPageModel` returns at
`lib/build.mjs:423` and before the redaction call at `lib/build.mjs:424`. Pass the untouched base
model into `augmentSiteModel` at `lib/build.mjs:393`, and assert both its input and return have
neither lane key. Never attach after redaction: the archive serializes the redacted model wholesale
at `lib/archive.mjs:51`. (D5, D11)

R18. Export D74's exact `renderTranscriptReceipt(receipt, format) -> string`, accepting only D8's
transcript and handoff shapes and `format: 'markdown' | 'html'`, even though Phase 2 emits transcript
receipts only. Its final visible Markdown forms are
`session <sessionId> · turn <turn>` and `handoff <handoffId>`; a null turn renders
`session <sessionId>`. Its HTML form uses the same text inside a distinct
`wl-transcript-receipt` class and never the git-evidence drawer or git badge class. A missing or
malformed receipt or format is a build error before rendering. The existing work-item pointer
preference at `lib/emit/_shared.mjs:47` remains unchanged. (D8, D74, D76)

R19. Render Lane A under the exact heading `Techniques observed`. In `digest` and `report`, place it
after all work sections and, when work count is zero, after the R22 empty-work sentence. In `post`,
place it after the work lines, including the R22 sentence when applicable. In `page`, place it after
the feed's work rows and R22 sentence and before the foot. Each Markdown row is one physical line
with this exact template:

```text
- **<grade>** - <text>  _Evidence: <clause>_  (`session <id> · turn <turn>`)
```

Each HTML row renders the same four visible parts: observation pill, escaped technique text, evidence
clause, and transcript receipt. No lane row may pass through the work-only `badge`,
`renderItemLine`, or `allItems` paths rooted at `lib/emit/_shared.mjs:28` and
`lib/emit/_shared.mjs:89`. No rendered lane string may contain `landed`, `merged`, or `shipped`.

Pin the later Lane B surface wording in the shared formatting layer now, without reading or
attaching `forward[]`. Its exact heading is `carried forward - not a verified claim`, and it renders
below Lane A and before the surface contract footer. Its Markdown rows have these final one-line
forms:

```text
- **<disposition>** - <text>  _as of <dispositionAsOf>_  (<receipt>)
- **<disposition>** - <text>  _suggested by the assistant; as of <dispositionAsOf>_  (<receipt>)
- **<disposition>** - <text>  _from a session-end note (assistant-drafted); as of <dispositionAsOf>_  (<receipt>)
```

Use the first line for `you`, the second for `assistant`, and the third for both handoff origins.
The receipt placeholder uses R18. Every form accepts D77's optional `closedByReceipt` slot after the
date clause and before the row receipt, rendering exactly
`_closed by_ (<transcript receipt>)`; absence adds zero bytes. The same Phase 2 formatter accepts
optional carry metadata and owns the exact date phrase
`first seen <firstSeenWeek>; as of <dispositionAsOf>` while current rows keep the existing
`as of <dispositionAsOf>` bytes. The HTML form has the same visible text, uses the shared pill
primitive with a disposition-specific class map, escapes every dynamic value, includes
`wl-transcript-receipt`, and contains none of the three work-status class names. Pin these four final
legend entries:

| Disposition | Legend entry |
| --- | --- |
| `not started` | `No verified pickup signal was found.` |
| `picked up` | `A git commit result named a commit that resolved in the source repository and matched a configured author identity.` |
| `ruled out` | `A reversal record exists in the cited handoff.` |
| `deferred` | `The intent carried from an earlier week without a verified pickup or reversal signal.` |

Phase 3 supplies derived rows and instantiates this authored policy with `DISPOSITIONS`; it does not
change any heading, row form, authorship label, date label, legend entry, placement, pointer copy,
carry copy, or receipt form. (D8, D9, D15, D16, D35, D62, D77)

R20. Replace the work-only legend/class/span path in `lib/emit/page.mjs` with the single D35
`renderPillSet({ vocab, classMap, legendEntries, present })` primitive. The work-status instantiation
must reproduce the current `LEGEND` and `BADGE_CLASS` bytes at `lib/emit/page.mjs:33` and
`lib/emit/page.mjs:38`; Lane A instantiates it with `TECHNIQUE_GRADES`; Phase 3 may only instantiate
it with `DISPOSITIONS`. The function returns exactly
`{ legendHtml: string, renderValue: function }`. `legendHtml` is empty when `present` is false and
otherwise renders only the supplied entries. `renderValue(selected)` rejects a value outside
`vocab`, selects `classMap[selected]`, and passes that selected value through `esc` into the one
HTML template that emits `wl-badge`. A consumer never supplies the selected value by mutating
`present`, `legendEntries`, or a global. Phase 3 receives a disposition renderer only by calling
`renderPillSet` once and then `renderValue(row.disposition)`. (D35, D55)

R21. Export one pure `contractCopy({ hasTechniques, hasForward })` function that returns exactly
`{ digest: string, page: string, readme: string }` and pin every cell below now. Phase 2 renderers
call it with the actual technique presence and `hasForward: false`; Phase 3 wires only its
already-authored forward boolean. No renderer reconstructs or edits a returned string. The
"neither" branch stays byte-identical to the current digest line at
`lib/emit/digest.mjs:25`, page foot at `lib/emit/page.mjs:410`, and README sample line at
`README.md:128`. (D6, D16, D55, D60)

| Presence | Digest contract line | Page foot contract copy | README sample-output contract copy |
| --- | --- | --- | --- |
| Neither | `> Private, local-only working draft. Every line carries a status badge and a receipt. Nothing here is published until you publish it.` | `honestweek build  Every line carries a status badge and a git receipt; every number is re-derived from git. Generated locally; nothing here is published until you publish it.` | ``Rendered to the default `digest` output. Every line carries a status badge and a receipt:`` |
| Lane A only | `> Private, local-only working draft. Work lines carry a status badge and a source receipt. Technique lines carry an evidence grade and a transcript receipt. Nothing here is published until you publish it.` | `honestweek build  Every work line carries a status badge and a source receipt; every technique line carries an evidence grade and a transcript receipt. Every number is derived by honestweek from git or local session transcripts. Generated locally; nothing here is published until you publish it.` | `Rendered to the default digest output. Work lines carry a status badge and a source receipt. Technique lines carry an evidence grade and a transcript receipt:` |
| Lane B only | `> Private, local-only working draft. Work lines carry a status badge and a source receipt. Carried-forward lines carry a disposition and a transcript receipt; they are not verified claims. Nothing here is published until you publish it.` | `honestweek build  Every work line carries a status badge and a source receipt; every carried-forward line carries a disposition and a transcript receipt and is not a verified claim. Every number is derived by honestweek from git or local session transcripts. Generated locally; nothing here is published until you publish it.` | `Rendered to the default digest output. Work lines carry a status badge and a source receipt. Carried-forward lines carry a disposition and a transcript receipt; they are not verified claims:` |
| Both | `> Private, local-only working draft. Work lines carry a status badge and a source receipt. Technique lines carry an evidence grade and a transcript receipt. Carried-forward lines carry a disposition and a transcript receipt; they are not verified claims. Nothing here is published until you publish it.` | `honestweek build  Every work line carries a status badge and a source receipt; every technique line carries an evidence grade and a transcript receipt; every carried-forward line carries a disposition and a transcript receipt and is not a verified claim. Every number is derived by honestweek from git or local session transcripts. Generated locally; nothing here is published until you publish it.` | `Rendered to the default digest output. Work lines carry a status badge and a source receipt. Technique lines carry an evidence grade and a transcript receipt. Carried-forward lines carry a disposition and a transcript receipt; they are not verified claims:` |

R22. Export one pure `emptyWorkCopy({ hasTechniques, hasForward })` function. It returns `null` for
the neither-lane case, instructing each renderer to keep its current empty-state bytes, and returns
the exact presence-specific string below for the other three cases. When work-item count is zero and
a lane is present, use that returned string in Markdown and HTML, with only the existing surface
wrapper changing. The current neither-lane lines are at `lib/emit/digest.mjs:49`,
`lib/emit/report.mjs:47`, `lib/emit/post.mjs:16`, and `lib/emit/page.mjs:388`. (D6, D25, D55)

| Presence | Empty-work copy |
| --- | --- |
| Lane A only | `No distilled work items were found for this week. The technique rows below are transcript-derived observations.` |
| Lane B only | `No distilled work items were found for this week. The carried-forward rows below record intent and are not verified claims.` |
| Both | `No distilled work items were found for this week. The technique rows below are transcript-derived observations; the carried-forward rows record intent and are not verified claims.` |

R23. Keep work totals work-only. Do not change `emit`'s `itemCount` or archive `countItems`. When
both authored lane arrays are empty/absent and the Phase 3 producer reports no raw engine row,
preserve the existing successful-build
stdout branch at `lib/build.mjs:476` byte for byte, including its optional goals and archive suffixes:
`build: wrote <path> (<mode>, <N> item(s), <bytes> bytes).` When at least one lane is present under
D6, including a non-empty authored array whose rows later under-claim to zero, use the extended form:
`build: wrote <path> (<mode>, <N> item(s), <T> technique row(s), <F> carried-forward row(s), <bytes> bytes).`
Phase 2 reports `F` as zero; Phase 3 supplies the final count without changing the raw-presence
branch selected earlier. Final collections control rendering, never stdout authority. The no-work
branches are exhaustive: `N + T + F === 0` keeps the lane-absent surface's current empty sentence,
while `N === 0 && T + F > 0` selects the matching R22 sentence. (D25, D63, D75)

R24. Strip every Phase 1 `ref`, D67 technique `id`, D69 `refCanonical`, and D69 `shapeCanonical`
before the derived Lane A array reaches an emitter or `writeArchive`. Test absence using exact known
values, not an eight-hex regex because session ids legitimately render. Archive snapshots may
contain the rendered receipt but no local-only key or value named here. (D5, D67, D69)

### Documentation and additivity

R25. Update `SKILL.md` once for Lane A and reserve Phase 3's rule number without teaching an
unsupported input. Step 2 names `honestweek.prompts.json` as a second gitignored, source-faithful
post-redaction, local-only discover output. Before Step 3 authors any lane row, it runs one read-only
`build --explain-lanes` invocation and supplies the resulting gradeable-window list to DISTIL. Step
3 names that list and both files as inputs and says:
`Read it to understand what you asked for; name the technique in your own words; never copy a run of words from it.`
Step 4 describes both D10 failure classes and `--no-lanes`; it does not introduce
`--explain-lanes` after authoring has already happened.

Add this final active contract rule after existing rule 6:

7. **Name a technique; never claim it worked.** Read `honestweek.prompts.json` to understand the
   request, then name the technique in your own words without copying a run of words. Cite a draft
   turn by `sessionId` and `turn`. Only turns with `stub: false`, `complete: true`, `kind: "prose"`,
   a non-null `shapeKey`, and the evidence fields `correctionObserved`, `testSignals`, and
   `commitShas` are candidates. Omit a technique whose only possible support is an unverified commit
   SHA. `build` derives the grade and may drop the row; never author `grade`.

Add rule 8 as exactly this title plus reservation sentence, with no other body:

8. **Copy a forward ref; never invent one.** Reserved. This rule is not active until the
   carried-forward band ships.

Add the final `### Technique item shape` block under rule 7 with this exact JSONC:

```jsonc
"techniques": [
  {
    "id": "technique-example",
    "text": "Name the technique in your own words",
    "receipt": { "sessionId": "aaaaaaaa", "turn": 0 }
  }
]
```

The block states that `repo` is an optional configured repo label, `id` follows D67, and `grade`
must not be authored. Phase 2 publishes no `### Forward item shape` heading, no `forward` JSONC
example, and no rule-8 fields or authoring instructions. Phase 3 replaces only the reservation
sentence with D54's one active body and adds the Forward item shape; it does not renumber or retitle
the rule. Change the test title and exact count directly from the current six-rule test at
`test/skill.test.mjs:42` to eight once. (D5, D8, D16, D18, D54, D62, D67)

R26. Update README, CLI help, SKILL, and AGENTS together. README documents the rendered modes,
sidecar role, copy/noun gates, lane failure classes, both flags, the contract-copy matrix, and the
session-derived evidence limitation. Restate invariant 1 in README, SKILL, and `AGENTS.md` exactly as:
`A source receipt on every emitted item. Git-checkable work uses a commit receipt. Private, display-role, and session-only work may use a transcript receipt. Every lane line uses a transcript receipt. An item reaching a renderer without its required receipt is a build error.`
This replaces the current AGENTS wording at `AGENTS.md:40` and README wording at `README.md:294`
without narrowing the promise. Keep Phase 1's invariant 6 wording unchanged. (D8, D16, D17, D18,
D76)

R27. Extend the Phase 1 hermetic harness without changing its frozen corpus. Put all new lane
sessions under a separate fixture root used only by lane tests. The six lane-absent modes compare
against the Phase 1 committed goldens. A site build with valid techniques uses the lane fixture root
and compares against a same-run, lane-free site build, not against the Phase 1 golden. Keep fixed
`now`, `CLAUDE_CONFIG_DIR`, and independently constructed git repos with pinned author/committer
names, emails, and dates; the existing pattern pins these values at
`test/refuses-to-lie.test.mjs:40`. Consume D70's separate copy-gate corpus without moving any of its
sessions into the frozen golden root. (D19, D70)

R28. Follow D33 for every reference in this spec, keep all new fixtures clean-room, use only Node 18
APIs and the system git CLI, normalize paths before comparisons, and run `node --test` from the
repository root. (D33)

R29. Consume the Phase 1 substrate exactly as written, without normalizing it into a second schema.
A non-stub window has exactly the 15 D37 keys
`index`, `ref`, `repoKey`, `shapeKey`, `kind`, `opensWithCorrection`, `correctionObserved`,
`complete`, `stub`, `assistantTurns`, `toolsUsed`, `statusSignals`, `testSignals`, `commitShas`, and
`inspectedShas`, with numeric `repoKey`. A stub has exactly
`{ index, stub: true, complete: false }`, has no `ref`, and has no prompt-sidecar row; no Phase 2
path may assume every turn has a ref or try to resolve a stub. Lane A eligibility uses Phase 1's
`shapeKey` and `complete` values as-is. Do not re-run, extend, or fork Phase 1's D59/D72
`normalizePhrase` and exact closed `FILLER` contract. Consume the corresponding D69 normalized
six-word phrase only through R8's
`shapeCanonical` field for collision detection. The idea caps, `ideasTruncatedAtTurn`, and
`ideasDropped` never make a Lane A window incomplete or change its grade. Preserve for Phase 3 the
D68 distinction that truncation is present only when `ideasDropped > 0`;
`ideasTruncatedAtTurn` is location context and may be `null` in both truncated and untruncated
sessions.

Treat every non-stub `ref` as an opaque Phase 1 identifier. Do not parse or re-mint it. Consume its
D73 NUL-separated `refCanonical` only through the shared validator and carrier records; pipe forms
are invalid and fixture expectations use the exact D73 encoding.
Read `opensWithCorrection` and `correctionObserved` from the window. Do not add or run another
correction regex in Phase 2. (D37, D38, D39, D40, D41, D59, D68, D69, D72, D73)

R30. Before any ref join or shape grade, call D73's exact Phase 1 exports directly:
`buildValidatedRefIndex(records)` over each R8 `{ ref, refCanonical }` pair and
`buildValidatedShapeIndex(records)` over each non-null `{ shapeKey, shapeCanonical }` pair. Do not
implement or wrap a Phase 2 validator, index, or collision check. A same-hash/different-canonical
ref pair aborts before a receipt can resolve, exits 2, and writes nothing. A
same-hash/different-canonical shape pair contributes its two distinct canonical groups to the
returned `collisionGroups`; all records under the colliding key are absent from that capability's
`has`, `get`, and `entries`, follow D10's under-claim path, and report the
exact excluded-canonical-group count under D79. The diagnostic never labels groups as rows or
implies the affected rows were dropped. Consumers use only the builders' frozen capability methods
and do not compare or rebuild canonical strings. (D10, D64, D69, D73, D79)

## Acceptance criteria

A1. `node --test` from the repository root exits 0. (R28)

A2. For each of `undefined`, `null`, and `[]`, the lane-presence helper returns false and neither
validate nor build invokes its corpus reader. (R1)

A3. With no lane arrays, all six modes are byte-identical to the Phase 1 golden artifacts. (R27)

A4. With `techniques: []` and no session files, build exits 0 and its artifact is byte-identical to
the same input with the key omitted. (R1)

A5. A spy around `augmentSiteModel` observes no `techniques` or `forward` key in either its input or
its return during a populated, valid Lane A site build. (R17)

A6. A valid populated Lane A site build is byte-identical to a same-run site build whose items file
omits `techniques`. (R11, R27)

A7. With no lane array, the archive snapshot is byte-identical to Phase 1's snapshot. (R17)

A8. The exact arrays `STATUSES`, `TECHNIQUE_GRADES`, `DISPOSITIONS`, and
`RESERVED_FOR_WORK_LANE` satisfy every D35 isolation assertion in one table-driven test. (R2)

A9. A source scan of `lib/emit/page.mjs` finds exactly one HTML template containing
`class="wl-badge`, and lane-free page output remains byte-identical to the Phase 1 golden. (R20)

A10. The seven ordered signal inputs `[]`, `['pass']`, `['fail']`, `['fail','pass']`,
`['pass','fail','pass']`, `['fail','pass','fail']`, and `['build-broke','pass']` deep-equal
`[false,false,false,true,true,false,true]`. (R5)

A11. A table-driven grade test deep-equals the expected D9 grade for the test-flip,
verified-commit, repeated-group, and correction cases, and returns no entry for unmatched evidence.
(R5)

A12. Calling `resolveLaneCommit` over one resolved-authored commit, one wrong-author commit, one
unresolved SHA, one throwing repo, one missing `repoKey`, one out-of-range `repoKey`, and one
display-role repo deep-equals the seven expected R6 result objects. Missing and out-of-range both
return `no-repo-key` with `repoLabel: null`; display-role and no-repo-key make zero git calls;
throwing and unresolved are the only failed-optional-evidence counts. Injecting those same results
into the Lane A grader makes only `resolved-authored` positive while preserving an independent test
flip in every other case. (R6)

A13. Two distinct sessions sharing one qualifying `shapeKey` render exactly one
`repeated without correction` row whose `repeatedOpenings` equals the number of eligible windows.
(R5)

A14. The same repeated group receives no grade when any contributing session has
`truncatedAtTurn !== null`. (R5)

A15. A table containing a stub, an incomplete window, a command window, a null-shape window, and a
terminal `correctionObserved: 'unknown'` window produces no grade for any row. (R5)

A16. Two authored techniques resolving to the same qualifying group render the earliest receipt
only when both cited members qualify, and build exits 0. (R5)

A17. A ten-row table covering the three no-correction signal combinations, the repeated-group
clause, and the six correction signal-and-position combinations deep-equals every exact R7
evidence template. (R7)

A18. Calling the memoized corpus operation twice during one build calls each of `adaptSessions`
and `discoverHandoffs` exactly once and returns the same object identity. (R8)

A19. A fabricated `honestweek.draft.json` cannot change a Lane A grade, and deleting that file
cannot make the same build fail. (R8)

A20. A zero-file session root with exactly one structurally valid authored technique row drops the
Lane A band, emits the work report, exits 0, and deep-equals R9's numeric row-level template with
count `1`. (R9)

A21. With exactly two authored techniques, one receipt resolving to an eligible turn and one
resolving to no turn, build drops exactly the unresolved row, emits the one resolvable technique
plus the work report, reports count `1`, and exits 0. (R9)

A22. In separate throwing-lookup and unresolved-SHA cases, a Lane A row with an independent
same-window test flip still renders with its tests-only grade and evidence clause, exits 0, emits no
dropped-row diagnostic, and reports exactly one failed commit-resolution row with `--no-lanes`.
(R6, R9)

A23. Each positive dishonesty case exits 2, leaves the configured output and archive snapshot
absent, and prints the R9 abort prefix without offending prose. (R9)

A24. `build --no-lanes` and `validate --no-lanes` skip all lane readers and gates even when authored
arrays and engine-source records exist, and their work-only results equal the Phase 1 golden for the
same work items. (R10)

A25. Every stderr line emitted by a lane code path contains the literal `--no-lanes`. (R9, R10)

A26. The orchestrator flow invokes `build --explain-lanes` exactly once after discover and before
DISTIL authors `techniques`; the gradeable-window list is an explicit DISTIL input. The command
writes no report or archive and prints no source prompt substring. A flow with the invocation moved
after DISTIL fails the ordering assertion. (R10, R25)

A27. A build with exactly one valid derived technique row runs all gates in all six modes. The four
rendering modes contain its text; `site` and `changelog` contain none; `site` emits no ignored-row
notice; and `changelog` stderr deep-equals R11's one-line notice with count `1`. (R11)

A28. A table-driven `sharesRun` test pins whole-string and adaptive-run hits at 4, 5, 6, 7, and
8-plus authored words, plus a three-word non-hit. (R12)

A29. First recompute the checked-in `sha256` for
`test/fixtures/lane-corpus/copy-gate-corpus.json` and fail on a mismatch. Then assert the artifact's
`prompts` array is non-empty, so the zero-hit result below cannot pass against an empty corpus. Then
run **D70's ten pinned names**, read from that decision and not restated here, against the
artifact's multi-session `prompts` array.

Record the floor-4 result before applying the gate: if all ten are false, the shipped floor remains
4; if any is true, the shipped floor becomes 5 per D53 and all ten must be false on the rerun. The
test never edits the corpus, checksum, or names in response to the measurement.

A positive control runs in the same test: a verbatim run of `sharesRun`'s floor length taken
directly out of the corpus must return true. Without it the zero-hit assertion proves only that
`sharesRun` returns false, which an unimplemented gate also does. (R12, D53, D70)

A30. A copy hit makes validate and build exit 2 without writing output or echoing the authored text
or matching run. (R12)

A31. A truncated sidecar makes validate state that its copy check is partial while the equivalent
build still catches a copied run located beyond the written sidecar budget. (R12, R16)

A32. With one authored technique row, a missing sidecar and an unparseable sidecar each drop the
band, exit 0, emit the exact R9 file-level template naming `honestweek.prompts.json`, and contain no
numeric dropped-row count. The same spies prove neither case reaches a row resolver or text gate.
(R9, R16)

A33. When the items envelope has no `week`, validate skips only the sidecar week comparison, says
so once, and still runs all available lane text gates. (R16)

A34. With strict mode off, `technique-one` has text `Copperleaf Riverstone review` and
`technique-two` has text `Cloudberry review`; both carry valid eligible receipts. They produce
exactly one summary warning that names both row ids and counts `2` and `1`. The warning
contains none of the three residual token values, no authored row text, and no per-row warning line.
A companion input made only of D51 baseline and ambient tool tokens produces an empty `hits` array.
(R3, R13)

A35. The same residual noun input loaded through a real config with `strictLaneNouns: true` exits 2
and writes no output. (R13)

A36. A table-driven display check aborts for either an optional `repo` naming a display role or a
display label occurring in `text`, while featured and reference labels pass this gate. (R14)

A37. A configured private term in technique text makes validate and build exit 2 without echoing
the term. (R14)

A38. With `voice.denyMeta` enabled, the authored row
`{ id: 'technique-voice', text: 'keeping the specifics sealed', receipt: { sessionId: 'aaaaaaaa', turn: 0 } }`
resolves to the eligible turn 0 fixture and takes the shipped
`withholding:sealed` branch. Build aborts under `technique-voice`, never under `item[N]`, and neither
R3's result nor stderr echoes the matched phrase. (R3, R15)

A39. A direct attach-and-redact unit test passes a pre-gated derived technique object containing a
configured redaction term into the R17 attachment point and observes the term scrubbed in digest,
report, post, page, and the archive snapshot. This structural backstop test does not run or bypass
the full-build positive-term gate proven by A37. (R17)

A40. The exact Phase 1 `ref`, `refCanonical`, `shapeCanonical`, and D67 technique `id` values used
by a successful lane build occur in no rendered artifact and no archive snapshot, while the
eight-hex session receipt remains present. (R24)

A41. Every Lane A Markdown row in digest, report, and post matches the exact R19 one-line shape and
contains the final visible transcript receipt. (R18, R19)

A42. Every Lane A HTML row contains a `wl-transcript-receipt`, escaped technique text, one pill,
and its exact evidence clause, and it contains no git drawer class. (R18, R19)

A43. In each rendering mode, the Lane A band begins after the last work row and any R22 empty-work
sentence, and before the surface's contract footer or end copy. (R19)

A44. No Lane A object reaches `allItems`, `renderItemLine`, or the work `badge` helper. (R19)

A45. No rendered Lane A string contains `landed`, `merged`, or `shipped`. (R19)

A46. A parameterized test over the four presence combinations and three contract surfaces
deep-equals all twelve exact R21 strings. Its neither/README expectation is the literal
``Rendered to the default `digest` output. Every line carries a status badge and a receipt:``, with
both backtick bytes around `digest`. (R21)

A47. A parameterized test over the three non-empty presence combinations deep-equals the exact R22
empty-work sentence, while the lane-absent surface strings remain byte-identical. (R22)

A48. A lane-only report with one valid technique keeps work-item count zero, prints R23's extended
stdout branch with `0 item(s), 1 technique row(s), 0 carried-forward row(s)`, and leaves archive
`items` at zero. (R23)

A49. After Phase 2, `SKILL.md` contains exactly eight numbered contract rules. Steps 2 and 3 name
both required files; rule 7 and the Technique item shape deep-equal R25; rule 8 contains exactly its
settled title and reservation sentence; and the file contains no `### Forward item shape`, no
`"forward": [` JSONC example, and no rule-8 authoring body. (R25)

A50. README, SKILL, AGENTS, and CLI help each name `--no-lanes`; README, SKILL, and AGENTS contain
the exact R26 receipt invariant without a contradictory universal receipt claim. (R26)

A51. The new lane fixtures live outside the frozen golden corpus and pass the repository's existing
email, home-path, and forbidden-token clean-room scans. (R27, R28)

A52. A table-driven substrate fixture supplies a non-stub window with the exact 15 D37 keys and a
numeric `repoKey`; a proxy that throws on any undeclared property access remains untriggered while
the grader produces the expected result. (R29)

A53. A D38 stub has exactly three keys. With a populated authored technique whose receipt points to
that stub, spies on the current-week R8 identity resolver and `resolveLaneCommit` both record zero
calls, build takes R9's structural row-drop path, and no correction-text regex is evaluated.
Validate's separate sidecar branches are exercised by A31-A33, not by this build criterion.
(R9, R29)

A54. A session whose session cap drops its first otherwise-recordable pre-boundary idea has
`ideasDropped: 1` and `ideasTruncatedAtTurn: null`; an otherwise identical uncapped session has
`ideasDropped: 0` and `ideasTruncatedAtTurn: null`. The same eligible Lane A window remains complete
and receives the same grade in both inputs, while a direct D68 consumer distinguishes truncation
only from `ideasDropped > 0`. (R29)

A55. A valid authored Lane A row resolves through one exact turn identity from R8; that reachable
turn `ref` and `refCanonical` are absent from every Phase 2 artifact and archive while its session
receipt remains visible. Separately, the same R8 result exposes pre-turn idea, in-turn idea,
next-step, and reversal carrier records unchanged to a Phase 3 consumer, proving Phase 2 preserved
rather than published or re-minted them. Removing R24 stripping fails the reachable turn assertion;
removing any carrier record fails the handoff assertion. (R8, R24, R29, D73, D79)

A56. A source scan finds no Phase 2 `CORRECTION_RE` or new redirect-pattern definition, and the
grader produces its correction result from a D37 proxy object that exposes only
`opensWithCorrection` and `correctionObserved` as correction inputs. (R5, R29)

A57. When two authored techniques resolve to one non-repeated group but the earlier receipt cites a
member that does not satisfy the selected grade predicate, only the later qualifying receipt
renders. (R5)

A58. Pure shared-formatting tests deep-equal the exact Lane B heading, four legend entries, three
Markdown row forms, authorship mapping, and HTML visible-part policy in R19 without attaching a
`forward` key to a Phase 2 model. (R19)

A59. A pure D49 policy table deep-equals these results: an identity-resolved forward row whose commit
lookup throws and the same row whose SHA does not resolve are each retained as `not started` and
counted once as a failed resolution; an unmatched `ref`, absent corpus, and unparseable carry index
each take the loud identity-drop path. The unparseable file-level case returns the count-free R9
diagnostic shape; the parseable row-level cases return exact counts. No `forward` key is attached to
a Phase 2 model. (R9)

A60. For the lane-absent hermetic input used by A3, with both authored arrays omitted, no engine
records, no goals registry, and archive off, stdout deep-equals
this template after its fixture-derived interpolations are resolved:

```text
build: wrote ${configuredOutputFile} (${mode}, ${workItemCount} item(s), ${Buffer.byteLength(committedGolden, 'utf8')} bytes).\n
```

for each mode's configured path and committed golden. It contains neither `technique row(s)` nor
`carried-forward row(s)`. The same assertion holds with `techniques: []`. (R23, R27)

A61. With a parseable sidecar whose week differs from the items envelope and exactly two authored
technique rows, validate exits 0, drops exactly two rows through R9's numeric row-level template,
and does not use the count-free file-level template. (R9, R16)

A62. An end-to-end Lane A build scans the complete Phase 2 lane fixture root and resolves one valid
authored row whose exact text is `Bash Edit Read Write Grep Glob Task workflow`. With
`strictLaneNouns: false`, stderr contains zero noun warnings and R3 returns `{ hits: [] }`; the
separate A34 coined-token input proves the warning branch can still fire. (R3, R13, R27)

A63. Two authored techniques with the same valid `technique-example` id and different resolvable
receipts make build exit 2 before either receipt resolution and write nothing. A one-row control
renders successfully and A40 proves the id is stripped. (R4, R24)

A64. With one featured session and one reference handoff in the lane fixture root, two calls to
`ensureLaneCorpus()` return the same object. Its top-level keys deep-equal
`['sessions','handoffs','sessionFiles','identities','copyRunIndex']`; every identity deep-equals the
key set and types in R8; and the turn, idea, next-step, and reversal identities each carry the repo label
and `repoKey` derived from their actual source. Supplying a conflicting authored `repo` elsewhere in
the items input cannot change this object. The copy index is a frozen Map with 64-hex keys and
numeric counts, and a recursive scan of the result finds none of the source prompt, idea, or
normalized-run strings. (R8)

A65. Each R3 gate receives the same three exact rows: one clean row, one row with two hits for that
gate, and one row with one hit. Its result deep-equals
`{ hits: [{ id: 'technique-one', count: 2 }, { id: 'technique-two', count: 1 }] }` in id order, and a
recursive string scan of the result finds none of the configured terms, labels, residual nouns,
voice phrases, or source texts that caused the hits. (R3)

A66. Instantiating `renderPillSet` with the work vocabulary and `present: true` returns exactly the
key and value types in R20. Calling `renderValue('shipped')` reaches the one `wl-badge` template with
the shipped class; an out-of-vocabulary selected value throws; and `present: false` changes
`legendHtml` to the empty string without changing `renderValue`'s contract. The Lane A
instantiation repeats the same assertions with one D9 grade. (R20)

A67. For all four presence pairs, `contractCopy` returns exactly the three R21 keys and strings and
`emptyWorkCopy` returns `null` only for the neither pair and the exact R22 string otherwise. A proxy
throws on any extra argument read or result-key access. (R21, R22)

A68. Reuse Phase 1's checked-in real D73 NUL-canonical collision pair. Placing both validated
`{ ref, refCanonical }` pairs in R8's identity list and supplying a populated authored technique
makes the ref-index builder detect different canonicals, build exit 2 before any receipt or git
lookup, and no output or archive file exist. Either pair alone succeeds. A syntactically valid
canonical paired with the other ref is rejected by `validateRefIdentity` before collision logic.
The test calls the shipped hash and validator, not a stub. (R30)

A69. The real normalized six-word phrases
`zuidhuv yrsfpqs omaqnph dkqbzoh wsqlver lhhmrxj` and
`ssnhcin ilgjbuj wprkiks saqppkt hdohati oymsrws` both produce `62ed7764`. Before collision
handling, four exact two-window sessions make each phrase a qualifying two-session recurrence: in
each pair, only the second window of the first session has a failing-to-passing test flip and its
immediately preceding window has the same canonical phrase. With both canonical groups in the
shape index, neither authored technique receives a recurrence or single-window grade, the work
report still emits, and the diagnostic reports exactly `collisionGroups: 2`, never dropped rows.
The test calls the
shipped hash, not a stub. (R30)

A70. Use Phase 1's D72 producer to obtain keys for these exact pairs:

- `run focused checks record result before changing code` versus
  `do not run focused checks record result before changing code`
- `compare focused output before editing source carefully today` versus the same string with
  `after` replacing `before`
- `review all failing cases before changing source carefully` versus the same string with `some`
  replacing `all`
- `you must run focused checks before changing code today carefully` versus the same string with
  `may` replacing `must`
- `compare focused output before editing source carefully today` versus the same string prefixed by
  `please`
- `trace one concrete input end to end carefully` versus the same string prefixed by `just`

The first four pairs have different keys and remain two groups when passed into the Lane A grader;
the last two have equal keys and remain one group. Spies prove Phase 2 never calls
`normalizePhrase`, reads `FILLER`, or removes another token while grouping the supplied windows.
(R5, R29, D72, D79)

A71. A table renders one Git-checkable work item with a commit receipt and one private, one
display-role, and one session-only work item with transcript receipts. Every line has exactly one
source receipt; the last three contain no SHA and the display case records zero git calls. The
lane-present contract copy says `source receipt`, and a source scan rejects the false phrase
`git receipt on every work line` outside the byte-frozen neither-lane compatibility cell. (R18,
R21, R26, D76)

A72. Pure Phase 2 forward-formatting tests cover all three authorship forms with no pointer, a valid
escaped handoff pointer, malformed pointer receipt, and HTML escaping. Pointer absence is
byte-identical to the settled templates; presence places exactly `_closed by_ (handoff <id>)` after
the date phrase and before the row receipt. The same formatter owns the carried date phrase and a
current row never gains `first seen`. (R18, R19, D77)

The acceptance cases are pairwise satisfiable. A12's resolver states, A22's independent test flip,
A32's file-level sidecar failures, A61's parseable row-level drop, and A68's pre-join collision are
distinct branches. A34's deliberately coined nouns and A62's complete ordinary fixture build use
different authored rows. A29 verifies its checksum before observing a copy result. A53 supplies an
actual stub receipt, A54 supplies a pre-boundary dropped idea, A68 supplies a real ref collision, and
A69 supplies two real recurrence groups. A70 includes both key-equal and key-different controls, so
none of those assertions can pass because its named branch is unreachable.

## Files touched

- `lib/badges.mjs`: add the two lane vocabularies and the work-lane reservation registry without
  changing `STATUSES`.
- `lib/lanes.mjs`: add the copy gate, Lane A group grader, one shared lane commit resolver, D49
  identity/evidence classifier, exact reusable text-gate interfaces, and consumers for the Phase 1
  collision-aware index builders.
- `lib/harvest.mjs`: export and seed `excludeSet`.
- `lib/validate.mjs`: add conditional lane validation, sidecar handling, drop/abort policy, and
  `--no-lanes`.
- `lib/build.mjs`: add the memoized corpus derivation, Lane A re-grading, D49 failed-resolution
  count, gate policy, flags, conditional pre-redaction attachment, changelog notice, collision
  handling, and conditional lane-present summary.
- `bin/honestweek.mjs`: document `--no-lanes` and `--explain-lanes` in CLI help.
- `lib/emit/_shared.mjs`: add lane-value, transcript-receipt, and final lane-row metadata helpers
  without widening work-item helpers.
- `lib/emit/digest.mjs`: render Lane A and use the final contract and empty-state copy.
- `lib/emit/report.mjs`: render Lane A without changing work totals.
- `lib/emit/post.mjs`: render Lane A after work rows.
- `lib/emit/page.mjs`: extract the one pill primitive, render Lane A, and use final copy.
- `README.md`: document lanes, flags, gates, receipt policy, and the four-way contract matrix.
- `SKILL.md`: update flow inputs, write active rule 7 and its Technique item shape, and reserve only
  rule 8's number and title.
- `AGENTS.md`: strengthen invariant 1 per D8.
- `test/badges.test.mjs`: pin taxonomy isolation and reservation behavior.
- `test/lanes.test.mjs`: cover pure grading, the checked copy corpus and ten names, exact text-gate
  interfaces, display and resolver matrices, and both real collision pairs.
- `test/harvest.test.mjs`: cover exported exclusions and baseline seeding.
- `test/validate.test.mjs`: cover sidecar states, both gate classes, strict nouns, and flags.
- `test/build.test.mjs`: cover the exact corpus contract, derived repo provenance, drop/abort
  behavior, full-corpus noun silence, changelog notice, attachment, conditional stdout, flags, and
  read-only explanation.
- `test/archive.test.mjs`: cover all local-only Lane A field stripping and work-only archive counts.
- `test/emit.test.mjs`: cover Markdown band placement, receipts, evidence, contract copy, and empty
  copy.
- `test/page.test.mjs`: cover the pill primitive, HTML lane receipt, escaping, placement, and copy.
- `test/site-transform.test.mjs`: assert the structural lane-free site boundary.
- `test/golden-output.test.mjs`: extend the frozen lane-absent goldens and same-run site comparison.
- `test/cli.test.mjs`: pin the two new flags in help.
- `test/docs.test.mjs`: pin the four-way copy matrix, including README's literal `digest` backticks,
  and the cross-document receipt invariant.
- `test/skill.test.mjs`: move the contract rule count from six to eight once, pin active rule 7, and
  prove rule 8 is reservation-only with no Forward item shape.
- `test/fixtures/claude-projects/lanes/`: add only Phase 2 grading, privacy, and gate fixtures.

## Test plan

- `test/lanes.test.mjs`: use table-driven plain objects for the seven `testRunFlip` cases, the three
  D9 grades, eligibility, precedence, D3 truncation, D23/D24 lookup outcomes, one-row-per-group,
  D30 run lengths, D70 checksum and the ten fixed false-positive names, display checks, exact gate
  result shapes, count-only noun summaries, the exact D37/D38 substrate shapes, D39/D68 idea-cap
  non-effects, D72 producer-consumer table, opaque D40 refs, D41 correction-field consumption, D49's
  identity-versus-optional-evidence split, and A68-A69's real FNV-1a pairs.
- `test/build.test.mjs`: add independent temp-repo scenarios for successful Lane A rendering,
  fabricated draft independence, a zero-file drop, file-level and row-level diagnostics, every
  positive abort, strict nouns through the real config loader, the A62 full-corpus zero-warning
  build, voice ids, exact one-scan return shape, derived source repo labels, both flags, local-field
  stripping, throwing and unresolved optional evidence with exact failed-resolution counts,
  changelog's ignored-row notice, redaction before archive, and both stdout branches.
- `test/validate.test.mjs`: use sidecars named valid.json, missing, malformed.json,
  wrong-week.json, and truncated.json to prove field-wise week comparison, partial-copy wording,
  drop behavior, copy/display/private-term aborts, never-echo behavior, and `--no-lanes`.
- `test/emit.test.mjs`: parameterize all four presence combinations. Pin the twelve R21 strings, the
  three R22 strings, exact Markdown receipt/evidence rows, placement, post rendering, changelog
  exclusion, work-only totals, prohibited words, and the unattached Lane B heading, authorship,
  as-of, receipt, and legend formatting policy.
- `test/page.test.mjs`: pin one `wl-badge` template, lane-free golden bytes, the Lane A pill
  instantiation, transcript receipt class, escape behavior, no external resources, and placement
  before the foot.
- `test/site-transform.test.mjs`: instrument `augmentSiteModel` and assert its input and return are
  lane-free even while the gate sees valid authored techniques.
- `test/golden-output.test.mjs`: leave the Phase 1 golden corpus frozen, rerun all six lane-absent
  goldens, pin the lane-absent stdout template, and compare valid lane-bearing site mode to a
  same-run lane-free control under the lane fixture root.
- `test/archive.test.mjs`: collect the exact Phase 1 refs, canonical companions, and technique id
  from the re-derived corpus, then assert none is a key or value in the snapshot while the session
  receipt and work-only `items` count remain.
- `test/docs.test.mjs`, `test/skill.test.mjs`, and `test/cli.test.mjs`: pin exact final prose,
  eight rule numbers, the Technique item shape, the inactive rule-8 reservation and absence of a
  Forward item shape, both flow inputs, both flags, and the strengthened receipt invariant.
- Lane fixture root: keep the existing golden root untouched. Add generic sessions named
  repeated-a.jsonl, repeated-b.jsonl, correction.jsonl, command.jsonl, truncation.jsonl, and
  private-noun.jsonl; each fixture proves only its named case and passes every clean-room scan.

## Risks

- The pill refactor touches a byte-sensitive HTML path. R20 and A9 make any work-status byte drift a
  hard failure.
- Copy detection can reject ordinary short phrases. R12 and A29 verify the Phase 1-captured checksum
  before measuring ten fixed names and apply D53's precommitted escalation rule.
- Proper-noun detection is deliberately heuristic and can leak through its own warning. R3, R13,
  A34, and A62 make the payload count-only, exclude ambient tool names, and prove the normal full
  fixture build is quiet; strict mode remains an explicit operator choice.
- Re-deriving session and handoff data adds local build cost. R8 bounds it to one shared scan, and
  `--no-lanes` is the explicit off-ramp.
- Session-start week filtering can hide a use that began before the week. The grader under-claims by
  omitting unsupported rows; this phase does not widen transcript selection.
- A future Phase 3 edit could drift shared wording or rendering. The four-way copy tests, exact
  helper returns, reservation-to-body SKILL handoff, one pill-template assertion, and two stdout
  branches make that drift fail before merge.
- A lane could accidentally enter the site transform through object spread. R17 and A5 assert the
  structural boundary, not merely unchanged site bytes.
- A careless resolver could git-read a display repo. R6's guard ordering and the zero-invocation
  assertion make that a test failure.
- A compact hash can join unrelated evidence. R30 and A68-A69 use real collisions against the
  shipped hash and prove ref joins abort while recurrence grading degrades loudly.
- Treating optional commit evidence as row identity recreates the D10/D24 conflict and hides
  identity-resolved ideas. R6, R9, A22, and A59 keep throws and unresolved SHAs on D49's retained,
  counted under-claim path.
