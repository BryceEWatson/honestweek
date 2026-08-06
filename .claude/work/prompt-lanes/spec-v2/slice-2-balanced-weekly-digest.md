# Slice 2 contract: balanced weekly digest on the existing weekly page

## Authority, setpoint, and compatibility boundary

This is the executable contract for Slice 2 of `product-roadmap.md`. It supersedes conflicting
requirements in the historical phase files and D1-D79. Slice 1 remains the compatibility foundation.

The setpoint is one concise, independently shippable digest of prompts, ideas, techniques,
decisions, reversals, and next steps from the completed week of local Claude Code and Codex
activity. Every visible item states why it was selected, discloses the configured selection limits
and uncertainty, and carries an exact transcript receipt. Every visible category uses the existing
deterministic low-risk privacy kernel. Ambiguous or high-risk material remains private. Honest Week
does not publish, upload, infer a persona, or write the configured target repository.

The established output authority does not change. `honestweek.items.json` plus the optional
`honestweek.prompt-items.json` lane enters `validate`, then `build`, then the configured existing
`page` or `site` emitter. The public-safe lane filename remains unchanged. Version 1 is the Slice 1
prompt-only envelope. Version 2 is the balanced envelope defined here. A missing lane, an empty
version 1 lane, and all prompt commands retain Slice 1 behavior byte for byte.

`digest prepare` may replace a version 1 lane with version 2. A later `prompts curate` intentionally
replaces it with a prompt-only version 1 lane and says so. There is never a second lane with hidden
precedence, and an emitter never reads the private digest candidate store.

Lifecycle controls for non-prompt items, recurrence, retention expiry, approval, expanded
generalization, and feedback remain Slices 3 through 5. Slice 2 does not imply those controls exist.

## End-to-end user flow

```text
honestweek digest prepare [--week <value>]
honestweek digest candidates [--week <value>] [--category <category|all>]
                             [--decision <decision|all>] [--limit <1..200>]
                             [--offset <0..>]
honestweek digest explain <item-ref-prefix>
honestweek validate
honestweek build
```

`prepare` performs the same canonical prompt sync as `prompts curate`, scans the same confined local
source files for the closed material cues below, and constructs one balanced selection. It first
atomically writes `honestweek.digest.pending.json`, then atomically replaces the prompt store, the
redacted private review model `honestweek.curated.json`, and `honestweek.prompt-items.json` with a
version 2 public-safe lane, in that order. It removes pending only after all three next hashes are on
disk. All files and their temp patterns are gitignored before the first write. Stdout reports actual count, overall target,
automatic floor, category caps, omitted eligible counts by category, privacy-withheld counts, and
source coverage. It says that selection favors explicit decisions, reversals, recurrence, and
observed verification rather than universal importance.

The pending marker makes the ordered writes a detectable local transaction, not an atomic multi-file
rename. It has exact keys `version`, `generation`, `week`, `phase`, `prior`, and `next`. `generation`
is SHA-256 of the three next hashes plus week and output binding. `phase` is `prepared`; readers use
hashes rather than trusting a rewritten progress flag. `prior` and `next` each have exact keys
`promptStoreHash`, `curatedHash`, and `laneHash`; a missing prior file is represented by `null`.
Pending contains no content text.

Any pending marker makes every `honestweek prompts` command, `digest candidates`, `digest explain`,
`validate`, and `build` fail closed before source reads, private-state mutation, Git reads, or output
writes. Help text remains available. `digest prepare` is the only recovery command. This prevents
`prompts sync`, `keep`, `hide`, or `delete` from changing a transaction hash while recovery is
pending. On `digest prepare`, the current three hashes must be one of the four ordered
prefixes encoded by pending: all prior; next prompt only; next prompt and curated; or all next. Any
other combination exits 2 without mutation. A recognized prefix keeps pending present while prepare
rescans and atomically replaces it with the new generation before resuming the ordered writes. If a
write fails, stderr says which state may have changed and directs the user to rerun prepare. A crash
after all next files but before pending removal is the all-next recoverable prefix. Genuine lane
absence and an intentional version 1 lane have no pending marker and remain valid. A repeated prepare
reconciles every recognized interruption.

`validate` and `build` reject pending, then reconstruct the canonical version 2 review model and lane
from current transcripts, prompt controls, configuration, and output binding before any Git read or
output write. Any stale combination therefore exits 2 and writes nothing.

`candidates` is private and read-only. It validates that the private model is canonical, then prints
the item-ref prefix, category, decision, score, fixed reason, redacted preview, and every shortened
source receipt. It never prints private raw text or a detector match. It defaults to the completed
week, every category, every decision, limit 50, and offset 0. Order is category order, decision
order, score descending, timestamp ascending, full item ref. Paging reports matched count, displayed
range, remaining count, and the exact next-offset command.

`explain` resolves exactly one current full-model item-ref prefix of at least 12 lowercase hex
characters. It prints category, selected or withheld decision, every score signal and configured
weight, the fixed selection reason, privacy risk classes, transform kind and changed percentage,
and every shortened source receipt. It prints no raw text, detector match, path, session id, or
private transform span.

The Slice 1 prompt inbox remains the only stateful control surface in this slice. Prompt `kept` and
`hidden` states carry into the balanced digest. A kept prompt bypasses the prompt cap and overall
target but never receipt or privacy gates. Non-prompt keep, hide, delete, and carry-forward wait for
Slice 3.

## Source envelopes and evidence identity

The reporting week and source roots are exactly Slice 1's timezone-resolved inclusive local-date
week and confined Claude Code/Codex roots. Enumeration, symlink rejection, malformed-source
handling, project attribution, display-role privacy, and no-Git/no-network rules are unchanged.

Prompts remain the accepted human messages defined by Slice 1. Digest mining may additionally read
only the following final assistant envelopes:

- Claude Code: the last text-bearing `type:"assistant"` row after an accepted human turn and before
  the next accepted human turn or end of file. Text is the ordered concatenation of string content
  or `message.content[]` blocks whose `type` is `text`. Tool-use and reasoning blocks are excluded.
- Codex: the last `type:"event_msg"`, `payload.type:"agent_message"` string after an accepted human
  turn and before the next accepted human turn or end of file. Response items, reasoning, tool
  calls/results, and control events are excluded.

An assistant envelope is eligible only when it belongs to an accepted human turn in the reporting
week. Its attribution and one-based turn are inherited from that turn. The source message's own
timestamp is retained when valid; otherwise the human turn timestamp is used. No subagent
transcript or project handoff is mined in Slice 2. That limitation is disclosed in `prepare` output.

The Slice 1 prompt `ref` remains the prompt item's evidence reference. Every mined cue line, whether
from a human prompt or an assistant final, uses:

```text
sessionKey = sha256(source + NUL + rawSessionId)
evidenceCanonical = source + NUL + sessionKey + NUL + turn + NUL
                    + envelopeKind + NUL + oneBasedCueOrdinal + NUL + sourceHash
evidenceRef = sha256(evidenceCanonical)
```

`envelopeKind` is `human-cue` or `assistant-final`. Cue ordinals count every accepted cue in source
order within that one human or final-assistant envelope, before category filtering. A human cue
therefore has a distinct evidence ref from the containing Slice 1 prompt.

`sourceHash` is SHA-256 over the exact raw cue text after removing its cue prefix or list marker and
before redaction. It is never reversible and raw text is discarded before a persistable object
exists. A collision, canonical mismatch, conflicting session identity, changed source, or ambiguous
receipt aborts before either digest file is written.

`itemRef` is SHA-256 over category, the sorted complete evidence-ref list, and a discriminator:

```text
sha256(category + NUL + evidenceRefs.join(NUL) + NUL + discriminator)
```

Discriminators are `prompt`, `idea:<ordinal>`, `technique:<ordinal>`,
`decision:<ordinal>`, `reversal:<ordinal>`, and `next-step:<ordinal>`. Wording never enters item
identity except through the immutable evidence reference's source hash. Receipt objects have exact
keys `source`, `sessionKey`, `turn`, `kind`, and `ref`. `kind` is `human-prompt`, `human-cue`, or
`assistant-final`. Every public item carries all evidence refs and all receipt objects. Receipt
order is source, sessionKey, turn, kind, ref.

## Closed extraction grammar

Extraction is intentionally literal and under-claims. It never classifies free prose, motive,
impact, persona, or importance.

The scanner first normalizes line endings only. A cue is either a labelled line or a heading-scoped
list. Leading and trailing whitespace is removed from the extracted text. Empty text and text over
1,000 Unicode code points are scan exclusions, not candidates. They increment the exact
`unsupported-cue` count for that category and envelope and retain no text or hash.

Labelled lines optionally begin with one Markdown bullet and then one of these case-insensitive
labels followed by `:` and nonempty text:

| Label | Category | Allowed envelope |
| --- | --- | --- |
| `Idea` | ideas | human prompt or assistant final |
| `Technique` | techniques | human prompt or assistant final, with observed verification in the same turn |
| `Decision`, `Decided` | decisions | human prompt or assistant final |
| `Reversal`, `Reversed` | reversals | human prompt or assistant final |
| `Next step` | next steps | assistant final only |

A heading-scoped list begins with an exact Markdown heading `Ideas`, `Techniques`, `Decisions`,
`Reversals`, or `Next steps`, with optional leading `#` marks and an optional trailing colon. Each
immediately following nonempty Markdown bullet or numbered-list line becomes one cue in that
category. The section ends at a blank line, another heading, or a non-list line. The same envelope
and technique-verification restrictions apply. Cue order within its containing accepted human or
final-assistant envelope, before category filtering, supplies the one-based ordinal. Duplicate
evidence canonical values abort rather than collapse silently.

Prompt candidates are the existing prompts. A prompt's request cues remain score signals for the
prompt category only. A labelled decision inside a prompt can therefore become a decision candidate
without claiming the whole prompt is a decision. The prompt item usually remains below the
automatic floor unless it independently has a Slice 1 eligibility signal.

Observed verification and follow-on correction use Slice 1's exact tool/result windows and failure
precedence. A technique must have both an explicit technique cue and observed verification in that
turn. Its evidence-ref list contains exactly the distinct cue reference and associated Slice 1
prompt reference, for both human-cue and assistant-final techniques, so the visible receipt points
to both the technique wording and its verification window. An assistant idea
may use that turn's observed-verification signal for priority, but verification is never inferred
from assistant prose.

## Private review model

`honestweek.curated.json` version 1 has exact top-level keys `version`, `generatedAt`, `week`,
`sourceStatus`, `policy`, `candidates`, and `withheld`. It is regenerated for one week by
`digest prepare`; Slice 2 has no cross-week merge.

Candidate decisions are the exact ordered enum:

```text
automatic-safe, hidden, private-source, high-risk, needs-approval,
public-renditions-disabled, missing-eligibility-signal,
below-automatic-floor, category-capacity, overall-capacity
```

`withheld` has exact keys `total`, `byCategory`, and `scanExcluded`. `total` contains every enum key
except `automatic-safe`, each with a nonnegative integer count. `byCategory` has exact category keys
`prompts`, `ideas`, `techniques`, `decisions`, `reversals`, and `nextSteps`; each value repeats the
same nine decision-count keys. `scanExcluded` has the same six category keys, each containing exact
keys `human-cue` and `assistant-final`, whose values are nonnegative `unsupported-cue` counts.
Prompts always have zero scan exclusions.

The accounting equations are exact:

```text
candidates.length = publicItems.length + sum(withheld.total)
withheld.total[decision] = sum(byCategory[*][decision])
acceptedPromptCount + acceptedCueCount = candidates.length
scannedPromptCount + scannedCueCount = candidates.length + sum(scanExcluded[*][*])
```

Unsupported cues never enter candidate accounting or a written text field. Every other accepted cue
becomes exactly one candidate, including privacy-withheld and capacity-withheld cues.

Each candidate has exact keys:

```text
itemRef, category, discriminator, evidenceRefs, receipts,
timestamp, project, isPrivate, state, text,
sourceHash, contentHash, sourceLength, redactionCount, changedPercent,
rawRisk, rawDetectors, redactionOps, transform, truncated,
signals, score, selectionReasonCode, selectionReason,
decision, privacy
```

`state` is `inbox`, `kept`, or `hidden`; only prompt controls can currently produce the latter two.
`text` is the redacted private rendition capped by the extraction limit. `contentHash` is SHA-256 of
that exact text. Human-derived candidates link to the prompt source/content hashes and conservative
prompt audit. Assistant-derived candidates carry the same replayable detector audit used by Slice
1, computed over the exact extracted raw cue text. `transform` is `none` or `redaction`.

`privacy` has exact keys `sourceRefs`, `sourceContentHashes`, `renditionHash`, `transform`,
`changedPercent`, `rawRisk`, `residualRisk`, `decision`, and `policyVersion`. Arrays align with the
sorted evidence refs. No raw text, session id, matched detector value, or persona field is permitted.

Every persisted string in both digest files must be byte-identical after the canonical redactor is
applied. Every write is exclusive same-directory temp, flush, close, and atomic rename. The private
model cap is 8 MiB and the public lane cap remains 1 MiB. Exceeding either cap aborts without
truncating or dropping candidates.

## Deterministic privacy gate

Every candidate follows the ordered Slice 1 kernel: assess, apply only canonical redactor
replacements, validate changed spans and residual risk, then decide.

1. A display/unmatched source is `private-source` and cannot render.
2. Residual high risk is `high-risk` and cannot render.
3. A capitalized-unknown hit, truncation, validator uncertainty, incomplete accounting, unknown
   transform, or changed percentage above `privacy.publicRenditions.maxAutomaticChangedPercent` is
   `needs-approval` and remains private. Slice 2 provides no approval action.
4. When public renditions are disabled, otherwise-safe candidates are
   `public-renditions-disabled`.
5. Only receipt-valid, low residual-risk, fully accounted, limit-compliant results are eligible for
   automatic selection.

The gate may remove only a detector-identified sensitive span by replacing it with the existing
canonical placeholder. It may not add an actor, motive, outcome, number, or claim. Generalization
mappings remain unsupported until Slice 4. Persistent high risk is excluded. Ambiguity is never
automatically surfaced.

The public item records source refs and content hashes, rendition hash, `none|redaction`, changed
percentage, raw/residual risk, `automatic-safe`, and policy version. Changed items display
`Privacy edited.` in their reader-facing summary. The page never receives private text or operation
spans.

## Selection policy and visible shape

Category keys and page labels are fixed and ordered:

| Key | Page group | Default cap |
| --- | --- | ---: |
| `prompts` | Prompt highlights | 2 |
| `ideas` | Ideas | 2 |
| `techniques` | Techniques | 3 |
| `decisions` | Decisions | 2 |
| `reversals` | Reversals | 1 |
| `nextSteps` | Next steps | 2 |

The score signals, weights, floor, caps, and overall target are exactly the validated `curation`
configuration in `product-roadmap.md`. Slice 2 uses these signals:

- `decision-or-reversal` for an explicit decision or reversal cue;
- `observed-verification` when the same turn has Slice 1's observed passing-test or commit signal;
- `recurs` when the same category's normalized subject matches a candidate in another session under
  Slice 1's token and Jaccard rule;
- `unresolved-next-step` for every explicit next-step cue;
- `follow-on-correction` for prompt candidates only;
- `decision-request`, `reversal-request`, and `next-step-request` for prompt candidates only.

Feedback signals remain zero because Slice 5 has not shipped. Missing evidence scores zero. Signals
are unique and ordered as in the roadmap. A candidate automatically qualifies only at or above
`automaticMinScore` and only when it has a category-specific eligibility-bearing signal. Capacity
never lowers the floor. Explicit keep is the only floor override.

Eligibility-bearing signals are closed and independent from numeric configuration:

- prompts require `recurs` or `observed-verification`, exactly preserving Slice 1;
- ideas require `recurs` or `observed-verification`;
- techniques require `observed-verification`, which extraction already requires;
- decisions and reversals require `decision-or-reversal`, which extraction supplies;
- next steps require `unresolved-next-step`, which extraction supplies.

An otherwise-safe, non-kept candidate with no category eligibility signal is
`missing-eligibility-signal`, even when a zero or negative floor would admit its score. A candidate
with an eligibility signal but a score below the configured floor is `below-automatic-floor`.

Eligible kept prompts sort first by timestamp and ref. They bypass category caps and `maxItems` and
are never silently dropped. Automatic candidates sort by score descending, category order,
timestamp ascending, and full item ref. The selector walks that order while enforcing each category
cap and the remaining overall target. Rejections are `category-capacity` or `overall-capacity`.
Empty categories receive no filler.

Fixed primary reason codes and reader-facing reasons are:

| First applicable code | Reader-facing reason |
| --- | --- |
| `explicit-keep` | `you kept this prompt` |
| `decision-or-reversal` on a decision | `records an explicit decision` |
| `decision-or-reversal` on a reversal | `records an explicit reversal` |
| `observed-verification` | `connected to observed verification` |
| `recurs` | `matched lexical overlap across sessions` |
| `unresolved-next-step` | `names unfinished work` |

Primary reason precedence is category-specific. Prompts use `explicit-keep`, `recurs`, then
`observed-verification`, preserving Slice 1. Ideas use `observed-verification`, then `recurs`.
Techniques use `observed-verification`. Decisions and reversals use their explicit
`decision-or-reversal` wording. Next steps use `recurs`, then `unresolved-next-step`. No automatic
item can reach the lane without one of these reasons.

Every visible item summary starts `Why it surfaced: <reason>.` It then states the configured
automatic floor, overall target, that category's cap, and eligible omissions for that category. It
ends `These rules favor observable recurrence and verification, not universal importance.` It adds
`Privacy edited.` when transformed. All matched signal codes and weights remain in the private model
and public lane.

Lane items have `status:""` and use kinds `prompt`, `idea`, `technique`, `decision`, `reversal`, or
`next-step`. They have no work-status badge. They use the existing detail drawer with public-safe
rendition and one source snippet per receipt. The page extends its existing generalized item branch
to all six kinds. Ordinary work items keep their badge and Git evidence behavior. The target site
transform receives the same generic commit-less item/snippet grammar proven by Slice 1.

Within the lane, items order by the fixed category order, then kept before automatic, score
descending, timestamp ascending, and item ref. Existing work items remain before the lane at the
build join. With no nonempty lane, every existing output byte remains identical.

## Public lane version 2

`honestweek.prompt-items.json` version 2 has exact top-level keys `version`, `week`, `generatedAt`,
`outputBinding`, `policy`, `sourceStatus`, `items`, and `withheld`. `policy` records version,
`maxItems`, `automaticMinScore`, all six category caps, all configured weights,
`maxAutomaticChangedPercent`, and `publicRenditionsEnabled`. `withheld` records every decision count
overall and by category. Accounting requires candidates equal public items plus all withheld counts.

Each item has the exact keys:

```text
id, itemRef, evidenceRefs, receipts, kind, category, week,
curationState, publicDisposition, status, project, repo, date,
title, summary, receipt, snippets, selection, privacy
```

`id` is `digest-<itemRef>`. `kind` and `category` use the fixed pairing above. `curationState` is
`kept` or `automatic`; `publicDisposition` is `automatic-safe`; `status` is the empty string;
`project` is the fixed page-group label; `repo` is null. `date` is the candidate `timestamp` in the
configured local timezone. `title` is the public rendition capped at 160 code points with the Slice 1 word-boundary
ellipsis rule. `summary` is the exact disclosure text defined above.

`receipts` is the complete sorted receipt array. The compatibility singular `receipt` has exact keys
`sessionId`, `ref`, and `turn` and copies those values from `receipts[0]`. Session and ref display
prefixes are the shortest unique prefix among all full values in the version 2 lane, minimum 12,
with full fallback.

`snippets` begins with exactly
`{kind:<item kind>, source:"public-safe rendition", text:<full rendition>,
provenance:"validated-rendition"}`. It then has one entry per sorted receipt with exact value
`{kind:"source", source:<Claude Code|Codex>, text:"session <sessionPrefix> turn <turn> ref
<refPrefix> (<receipt kind>)", provenance:"transcript-receipt"}`. Receipt and snippet order must
match. `selection` has exact keys `score`, `reasonCodes`, `primaryReasonCode`, and `reason`.
`privacy` has the exact public audit keys defined above. Every item must be reconstructible byte for
byte, excluding clock fields, from the canonical private model and current source scan.

The version 2 loader strictly rejects unknown or missing keys, bad hashes, duplicate refs, unsupported
category/kind pairs, receipt/evidence mismatch, invalid order, out-of-policy scores or decisions,
non-low public privacy, incorrect summary disclosure, output binding drift, week drift, source drift,
private-store drift, and any non-canonical reconstruction. It performs these checks before Git reads
or output writes.

## Failure and compatibility table

| Condition | Exit | Writes | Required result |
| --- | ---: | --- | --- |
| both sources absent during prepare | 2 | none | old prompt store, private model, and lane preserved |
| either previously present source becomes absent or unreadable | 2 | none after detection | old bytes preserved |
| malformed/conflicting source identity or receipt collision | 2 | none | no partial model |
| pending write fails | 2 | none | all three prior files preserved |
| prompt store succeeds, later digest write fails | 2 | prompt store may be newer; pending remains | diagnostic requires rerun; all other commands reject pending |
| private model succeeds, lane write fails | 2 | prompt store/private model may be newer; pending remains | diagnostic requires rerun; all other commands reject pending |
| all files succeed, pending removal fails | 2 | all next files plus pending | rerun recognizes all-next; all other commands reject pending |
| version 2 lane or private model tampered/stale | 2 | none | validate/build abort before Git/output |
| unsupported output mode, goals transaction, or target adapter | 1 in prepare, 2 in validate/build | none | Slice 1 preflight wording and recovery direction |
| ambiguous/high/private candidate | 0 | private review model only for that item | no public lane/page text for it |
| lane missing or empty | existing result | existing result | existing model/output byte-identical |
| version 1 lane present | existing Slice 1 result | existing result | prompt-only compatibility unchanged |
| display-role source | 0 | private redacted review metadata only | zero Git calls, no public text |

No error names a raw cue, detector match, source path, raw session id, configured private term, or
private project.

## Exact acceptance checks

Implementation may start only after an independent reviewer finds this contract coherent and
feasible against checkpoint `0529c4f`, with no unresolved load-bearing finding.

The release gate is all of the following:

1. Contract fixtures for both tools contain accepted prompts, final assistant envelopes, every cue
   form, excluded reasoning/tool/control/subagent content, multiple sessions, malformed input, and
   week boundaries. They pin exact evidence refs, categories, turn ordinals, cue ordinals, source
   coverage, and exclusions.
2. One clean-room week yields at least one candidate in each category. Exact fixtures pin signals,
   scores, floor, category caps, global target, tie order, keeps, empty-cap behavior, every omitted
   count, fixed reasons, uncertainty text, and total accounting.
3. Every category has automatic-safe unchanged and redactor-edited examples, plus private-source,
   needs-approval, and high-risk examples. Tests pin 20/21 percent, capitalized ambiguity,
   disabled renditions, audit hashes, receipt linkage, and absence from public output.
4. `digest candidates` and `digest explain` paging/filter/ref tests prove private-only disclosure and
   never print raw session ids, paths, detector matches, configured terms, or private text.
5. Version 1 prompt lane tests remain byte-identical. Version 2 strict-schema, collision, order,
   accounting, source-rescan, prompt-control drift, config drift, adapter drift, and week-drift tests
   all fail before Git or output. Fault tests cover pending, prompt sync, private
   temp/write/flush/rename, lane temp/write/flush/rename, pending removal, all four recognized
   prefixes, an invalid mixed prefix, deliberate version 1 replacement, and genuine lane absence.
6. `validate` and `build` fixtures join ordinary work plus all six categories for both `page` and
   `site`. Every digest row has no status badge, the fixed group label, reason, public-safe text, and
   exact source drawer. Ordinary work keeps its badge and verified Git drawer.
7. Lane-absent and empty-lane builds for every existing output mode are byte-identical to checkpoint
   fixtures. Version 1 output is unchanged. A display source triggers zero Git helpers. Network and
   publish spies remain zero.
8. The actual configured target transform is imported read-only and receives an in-memory generated
   version 2 bundle. The transformed value contains all six generic groups, badge-less items,
   reasons, and transcript snippets. A source check confirms the target report component still
   renders arbitrary groups/items/snippets through its generic branch. No target file is written.
   Missing target paths block release and name no private data.
9. `node --test`, the phase contract verifiers, invariant diff checks, clean-room scans, Node 18
   compatibility checks, and the project-local `review-loop` all finish clean. Every load-bearing
   review finding is fixed and the affected checks rerun.
10. The final commit is on `feature/balanced-weekly-digest`, contains no dependency or lockfile,
    makes no external change, and leaves the worktree clean. No push, publish, tag, release, or target
    repository write occurs.

Any unresolved provenance, privacy, receipt, display-Git, redaction-before-disk, additivity, target
compatibility, test, or independent-review finding stops the slice. Under uncertainty, the item is
withheld or the slice remains uncommitted.
