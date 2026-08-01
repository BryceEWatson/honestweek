# Slice 3b contract: bounded carry and recoverable output state

## Authority and release boundary

This contract implements only the Slice 3b boundary authorized by `owner-approval.md`. It starts
from the validated Slice 3a checkpoint and adds cross-week retention, automatic recurrence,
one-digest manual renewal, terminal retirement, bounded carry history, deletion reset, and the
output/carry transaction. It does not add generalization mappings, an approval UI, feedback,
another renderer, another publisher, goals-page support, or any network or target-repository action.

The existing `digest prepare -> validate -> build -> configured page/site emitter` path remains the
only output authority. `digest prepare` may prepare lifecycle-aware private review and public lane
state, but only a successful `build` advances canonical carry. The user remains the publisher.

## Control loop

The setpoint is the seven approved owner rules: selected material is evidence-based and disclosed;
deletion is confirmed and reversible only through explicit tombstone reset; privacy remains the
three-way low/ambiguous/high gate with the 20-percent automatic edit ceiling; fixed groups, target,
caps, and explicit-keep disclosure remain intact; recurrence and history are bounded; recovery is
hash-bound and fail-closed; and representative proof plus independent review are mandatory.

System state is the resolved reporting week, source statuses, private prompt store, private digest
review and tombstones, public-safe lane, canonical carry, pending carry transaction, configured
primary output path and bytes, and configured output binding. Observable sensors are strict schema
checks, canonical hashes, transcript receipt reconstruction, privacy re-evaluation, explicit
terminal receipts, output byte hashes, carry byte hashes, atomic-write fault hooks, clean-room
scans, no-egress spies, the full Node suite, and independent review.

Controller actions are `prepare`, `keep`, `hide`, confirmed `delete`, confirmed tombstone reset,
`carry-forward`, `validate`, transactional `build`, automatic recovery, and explicit pending
discard. Controller decisions are current/withheld, fresh/automatic-carry/manual-renewal,
render/retire, promote/discard/abort, and advance/stop. Actuators are limited to atomic local
sidecar replacement, the existing configured emitter's one primary write, and atomic carry
promotion.

The loop runs at every stateful command startup, every weekly prepare/validate/build cycle, every
fault boundary, and every implementation checkpoint. Stop and preserve prior canonical state on an
unknown hash combination, unresolved receipt, non-low carried rendition, display-role Git read,
partial primary write, unredacted persisted string, unexplained lane-absent byte change, schema
drift, Node 18 incompatibility, test failure, or unresolved independent-review finding. Rollback is
the last focused local checkpoint plus the prior canonical output/carry bytes. Escalate only when a
product rule would need to change, an unknown pending state cannot be reconciled, or the configured
emitter cannot be prepared deterministically in memory.

## State files and schemas

`honestweek.carry.json` and `honestweek.carry.pending.json`, including their temporary-file patterns,
are gitignored. Both are redacted before disk, strict-schema, canonical JSON with a trailing newline,
and capped at 8 MiB. No carry value may contain a raw source path, raw session id, configured private
term, secret detector match, or unredacted private source.

Canonical carry has exactly:

```jsonc
{
  "version": 1,
  "weeks": [
    {
      "week": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
      "entries": [
        {
          "lineageRef": "64-hex",
          "itemRef": "64-hex",
          "category": "one of the six digest categories",
          "firstSeenWeek": "YYYY-MM-DD",
          "lastShownWeek": "YYYY-MM-DD",
          "automaticThroughWeek": "YYYY-MM-DD or null",
          "manualTargetWeek": "YYYY-MM-DD or null",
          "strength": "automatic or explicit",
          "candidate": "one complete, redacted digest candidate"
        }
      ],
      "retired": [
        {
          "lineageRef": "64-hex",
          "itemRef": "64-hex",
          "category": "one of the six digest categories",
          "reason": "automatic-limit, manual-expired, terminal-picked-up, terminal-ruled-out, hidden, deleted, privacy-withheld, or superseded",
          "terminalRef": "64-hex or null"
        }
      ]
    }
  ],
  "tombstones": [
    {
      "itemRef": "64-hex",
      "category": "one of the six digest categories",
      "evidenceRefs": ["sorted distinct 64-hex values"],
      "deletedAt": "ISO timestamp",
      "week": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }
    }
  ]
}
```

Weeks sort oldest to newest and contain at most `curation.retentionWeeks` records, default 12.
Entries and retired rows sort by lineage ref, then item ref. Tombstones sort by week start, then
item ref, persist until explicit reset, and are not history-pruned. A candidate's hashes, evidence refs,
receipts, score, privacy audit, and item identity are revalidated before use. `lineageRef` is the
first item ref in a recurrence line. `itemRef` may advance to a current receipt-bearing duplicate;
text is never an identity input. The latest week before the requested week is the only active-state
source. Older records are audit history, not independent recurrence authorities.

Every candidate embedded into carry is normalized to `state: "inbox"`. `strength` records only
how the seed first became strong: `automatic` means it met the then-current automatic floor and
`explicit` means a keep or manual action selected it. Strength is audit data, not an override.
On automatic recurrence the normalized candidate must meet the current automatic floor and counts
against current caps and target. It can never inherit keep's capacity bypass.

The pending record has exactly:

```jsonc
{
  "version": 1,
  "generation": "64-hex",
  "priorCarryHash": "64-hex or null",
  "nextCarryHash": "64-hex",
  "targetOutputHash": "64-hex",
  "week": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "phase": "prepared or output-written",
  "carry": "the complete next canonical carry envelope"
}
```

`nextCarryHash` hashes the canonical carry bytes. `generation` hashes the week, prior and next carry
hashes, target output hash, and the active output binding, including the normalized configured
output path. A binding or path change therefore cannot recover an old transaction accidentally.

Private review version 1 and 2 remain loadable. Version 3 has the version-2 keys plus exact arrays
`renewals` and a `lifecycle` object. A renewal is exactly `{ itemRef, requestedAt, targetWeek }`.
Lifecycle is exactly `{ carryHash, entries, retired }`; its entry is exactly
`{ lineageRef, itemRef, firstSeenWeek, asOfWeek, mode }`, where mode is `automatic` or `manual`.
Lifecycle retired rows use the no-text retired schema above. Version 3 always carries a tombstones
array, even when empty. If no carry input, renewal, or lifecycle retirement exists, preparation
keeps the existing version 1/2 private schemas and version 2 public-lane bytes.

`lifecycle.carryHash` is the SHA-256 of the prior canonical carry bytes read by preparation, or
`null` when none existed. Lifecycle entries cover every carry-derived candidate admitted to the
review, selected or withheld; the ordinary review candidate/withheld accounting therefore includes
them. Each public `carried` or `renewed` item has exactly one lifecycle entry with the same item ref,
and each lifecycle entry whose review decision is `automatic-safe` has exactly one public item.
Retired lifecycle rows have no public item. Build rejects any mismatch among review lifecycle,
public items, prior carry hash, tombstones, renewals, and next carry.

The public lane remains version 2. A lifecycle item uses the existing item schema and adds no new
public key. Its summary ends with exactly `First seen <week>; as of <week>.` Its curation state is
`carried` for automatic recurrence or `renewed` for manual renewal. Its disclosed primary reason is
`unresolved item carried from a prior week` or `you renewed this item for this digest`. Carried
automatic items count against the overall automatic target and category cap. Manual renewals, like
explicit keeps, render before automatic items and may exceed both, with the existing over-target
disclosure. Missing or empty lifecycle input changes no existing output byte.

The two closed lifecycle selection reason codes are `automatic-carry` and `manual-renewal`.
Exactly one is prepended to a lifecycle public item's `selection.reasonCodes` and is its
`primaryReasonCode`. Neither contributes score; the remaining closed signal codes still recompute
the exact score. Current explicit keeps retain `explicit-keep` and are not relabelled as lifecycle
items unless a due manual renewal is the reason they appear.

## Recurrence, duplicate handling, and retirement

Only a currently public-safe selected idea or next step seeds automatic carry. Define
`effectiveAutomaticCarryWeeks = Math.min(2, config.curation.automaticCarryWeeks)`. Zero creates no
automatic entry. Otherwise its window is exactly that many following calendar reporting weeks and
`automaticThroughWeek = firstSeenWeek + 7 * effectiveAutomaticCarryWeeks days`. Configured values
above 2 cannot weaken the owner-approved maximum. Every field ending in `Week` is a reporting-week
start date, and week arithmetic adds or subtracts exact seven-day UTC calendar intervals. Decisions,
reversals, prompts, and techniques never recur automatically.

`digest carry-forward <item-ref>` accepts one uniquely resolved current review candidate in any
category. The candidate must have a valid receipt and an `automatic-safe` privacy result. The
command records one renewal for exactly the next calendar reporting week. It does not imply keep,
change factual status, bypass privacy, or write output/carry. Repeating the same request is
idempotent and preserves the original request time. Repeating it from a later digest is a new,
explicit one-week renewal.

During preparation, eligible manual renewal precedes automatic carry, which precedes fresh
automatic selection. Fresh explicit keeps remain first. Automatic carry consumes the fixed target
and category caps; deterministic overflow retires no state early and may try again only while its
two-week window remains. Manual renewal bypasses capacity but not receipt, honesty, or privacy.

The lifecycle transition table is authoritative:

| Prior/current observation | Current action | Next active state |
| --- | --- | --- |
| fresh selected idea/next step | render under ordinary rules; seed normalized candidate only when effective automatic carry is nonzero | automatic through `firstSeenWeek + 7 * effectiveAutomaticCarryWeeks days` |
| automatic due, at floor, capacity available | render as `carried` | preserve original first-seen and automatic-through dates |
| automatic due but below floor or over capacity | withhold with ordinary disclosed reason | preserve only through the unchanged automatic window |
| manual target equals current week | render once as `renewed`, even if automatic is also due | consume manual target; preserve any still-live original automatic window |
| manual target is before current week | do not render from manual state | retire manual-only state as `manual-expired` |
| manual target is after current week | do not render yet | preserve exact target without early display |
| manual row renders | do not seed or extend automatic carry | only a still-live pre-existing automatic window survives |
| user renews a row from a later digest | record a new next-week target | one new manual week; no automatic extension |
| a reporting week is skipped | no implicit catch-up | manual target expires; automatic eligibility remains calendar-bounded |
| automatic-through is before current week | do not render from automatic state | retire as `automatic-limit` |
| carried subject has one current duplicate | use current receipt/candidate | keep original lineage, first-seen, and automatic-through bounds |
| a retired lineage reappears as a current duplicate | ordinary current selection may render it | it does not seed a new automatic window; only explicit renewal may carry it |

An entry with both a live automatic window and a due manual target uses manual mode for that week.
The manual display does not extend, restart, or replace the original automatic bound.

Carry-to-current duplicate suppression uses the existing closed lexical-overlap operation within
the same category. One unambiguous current candidate supersedes the old candidate, retains the
lineage's first-seen week, and supplies the current receipt. Zero matches carries the old candidate;
multiple matches abort the entire prepare with no sidecar change. Wrapper/control boilerplate
remains excluded by the existing source adapters.

Terminal evidence is accepted only from an accepted human turn containing an exact labelled line
`picked up: <subject>` or `ruled out: <subject>`. The extracted and redacted `<subject>` alone,
without label tokens, is the lexical-match input and receives a transcript evidence ref. One
low-risk lexical match suppresses the carry before selection and records the matching terminal ref.
Zero matches is nonterminal. Multiple matching terminal rows, multiple carried-lineage matches, or
medium/high/invalid terminal material abort the entire prepare with no sidecar change; canonical
carry remains active for a later explicit resolution. Keep never defeats a valid terminal result.

Hidden or deleted carried candidates retire before rendering. A carried rendition that is no longer
low-risk under current configuration retires as `privacy-withheld` and never reaches the public
lane. Automatic entries retire after their configured window. Manual entries retire after their
target week unless explicitly renewed again. History pruning removes whole oldest week records only.

## Deletion and reset controls

`digest delete <item-ref> --yes` keeps Slice 3a behavior. `digest delete --all --yes` deletes every
current review candidate, removes their private review text, writes sorted no-text tombstones, and
prints counts only. Missing `--yes`, a mixed item/`--all` request, an ambiguous prefix, or an empty
all-items request writes nothing.

`digest reset-tombstones <item-ref>|--week <YYYY-Www>|--all --yes` is the only regeneration
authority. Item scope clears one uniquely matched digest or prompt tombstone across canonical carry,
the current review, and the prompt store. Week scope clears every canonical/current-review digest
tombstone whose recorded source week matches the resolved week plus prompt tombstones referenced by
those digest tombstones. All scope clears every canonical/current-review digest tombstone and every
prompt tombstone. New prompt-store tombstones record their source week in prompt-store version 2;
version 1 remains readable, and a legacy prompt tombstone without a week is resettable by item or all,
never guessed into week scope.

Reset removes no live text and writes no public lane or output. Each affected private file is
atomically rewritten under the existing prompt lock. Partial reset failure remains fail-closed:
ordinary sync treats a matching tombstone in any one of carry, review, or prompt store as sufficient
to block regeneration, so retrying reset can only remove another blocker and can never expose an
item early. The next `digest prepare`, `validate`, and `build` must succeed before regenerated
material can appear. The command states that reset cannot recall or repair an already built, copied,
or published artifact.

Delete, bulk delete, and carry-forward use the existing digest sidecar transaction. Reset uses the
monotonic fail-closed tombstone rule above because it intentionally leaves the old public lane stale.
A fault leaves a recognized ordered prefix or at least one blocking tombstone; unknown mixed state
fails closed.

## Output/carry transaction and recovery

The lifecycle transaction predicate is true when a validated version 2 digest lane has at least one
currently selected idea/next step, the private review has a renewal or tombstone, canonical carry is
present, or lifecycle preparation recorded an entry or retirement. This includes the first fresh
week with no prior carry: build derives initial normalized entries from the selected lane items and
their exact review candidates. Next carry is derived only from the validated prior carry bytes,
canonical current review, canonical public lane, resolved week, and active configuration. When the
predicate is false, build uses the pre-Slice-3b emitter path, writes no carry sidecar, and its output
and write behavior remain byte-identical.

For a lifecycle-capable digest build, the emitter first prepares the exact primary path and bytes in
memory without writing. Build derives and validates next carry, writes and flushes pending in phase
`prepared`, atomically writes the primary bytes through the existing configured emitter boundary,
rewrites and flushes pending as `output-written`, atomically writes canonical carry from the embedded
envelope, then removes pending. Only after that may the existing optional archive run.

An initial pending-write failure changes nothing. A primary temp/open/write/flush/rename failure
removes pending and preserves canonical carry and the prior primary artifact. Failure to remove that
marker leaves a recoverable prepared state. A phase-rewrite failure leaves the written output plus
prepared pending. A carry temp/open/write/flush/rename failure leaves output plus output-written
pending. A final pending-removal failure leaves output, next canonical carry, and pending.

At startup and in `digest recover`, recovery computes current primary and carry hashes before any
mutation:

- output equals target and carry equals prior: validate and promote embedded carry, then remove
  pending;
- output equals target and carry equals next: remove the completed pending marker;
- output differs from target and carry equals prior: make no change and require
  `digest recover --discard-pending`;
- explicit discard is allowed only for that last combination and removes only pending;
- every missing, malformed, hash-mismatched, path/binding-mismatched, or other combination exits 2
  with no output, carry, or pending mutation.

Recovery is idempotent. `prepare`, `carry-forward`, lifecycle controls, `validate`, and `build` do not
proceed until known recovery completes. No recovery branch guesses from timestamps or file presence.

## Verification and release gates

Release requires one frozen clean-room proof that runs at least four consecutive dual-source weeks
through scan, private review, curation, validate, build, and the configured site transform prepared
in memory. It pins all six categories, exact scores/reasons/order/counts/receipts, unchanged and
edited automatic-safe rows, ambiguous/private/high-risk exclusions, omissions, wrapper suppression,
carry duplicate suppression, keep/hide/delete/bulk delete/reset, two automatic weeks, one manual
renewal, terminal retirement, and first-seen/as-of wording. A 13-week history sequence proves oldest
week pruning and no entry beyond configured bounds.

Fault injection covers pending temp/open/write/flush/rename, primary temp/open/write/flush/rename,
phase rewrite, carry temp/open/write/flush/rename, final pending removal, every recognized recovery
state, every unknown hash combination, repeated recovery, and explicit discard. Every abort pins
prior output and canonical carry bytes.

The proof records only aggregate counts for privacy outcomes and closed cues. Clean-room scans,
display-role zero-Git spies, network/publish spies, lane-absent byte identity in page and site modes,
no dependency/lockfile checks, contract hashes, `node --test`, Node 18/20/22-compatible syntax, and
the project review-loop must all pass. Independent review must report zero unresolved load-bearing
findings. No push, merge, tag, release, publish, upload, target-repository write, or external action
is permitted.

Any unresolved provenance, privacy, receipt, state transition, recovery, additivity, output-authority,
clean-room, compatibility, test, or independent-review finding blocks completion.
