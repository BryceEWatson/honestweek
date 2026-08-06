# Slice 3a contract: all-category lifecycle controls on the current weekly page

## Authority and narrow release boundary

This contract is the first release inside roadmap Slice 3. It starts from checkpoint `71c53d4`,
the completed balanced weekly digest, and adds one visible capability: `keep`, `hide`, and `delete`
control every current-week candidate in all six digest categories and survive deterministic
re-preparation of that week.

This is deliberately narrower than the complete Slice 3 roadmap boundary. Cross-week retention,
bounded automatic recurrence, `carry-forward`, terminal retirement, `honestweek.carry.json`, and
the output/carry recovery transaction remain required follow-on work in Slice 3b. None of the
already-validated `retentionWeeks` or `automaticCarryWeeks` settings takes effect in Slice 3a.
Expanded privacy transformations, approval, and feedback remain Slices 4 and 5.

Slice 3a is shippable only through the existing `digest prepare -> validate -> build` page or site
flow. A private control command by itself is not the completion boundary.

## Compatibility and honesty boundary

- With no new digest control, the version 2 public lane and every built artifact stay byte-identical
  to Slice 2, excluding existing clock fields in private sidecars.
- The version 1 prompt-only lane and every existing `prompts` command keep their current behavior.
- A keep changes selection only. It never changes evidence, score, factual status, source privacy,
  or public-rendition disposition.
- Hidden and deleted candidates are ineligible before floor and capacity selection.
- A delete removes the candidate text from the private review and leaves only a no-text tombstone.
  A same-week rescan cannot regenerate the deleted item.
- Every visible kept item retains its complete transcript receipts and the same deterministic
  privacy audit as the source candidate.
- `display`-role sources remain private and trigger no Git read. No command performs a network,
  publish, target-repository, or external write.
- Every sidecar write is atomic and occurs only after redaction and strict schema validation.

## CLI and user flow

The digest command becomes:

```text
honestweek digest <prepare|candidates|explain|keep|hide|delete> [options]
```

`keep`, `hide`, and `delete` each accept exactly one current candidate item-ref prefix. Prefixes use
the existing minimum 12 lowercase hexadecimal characters and must resolve uniquely across the full
current private review, including selected and withheld candidates.

`delete` requires `--yes`. Missing confirmation exits 2 without a write. A successful command
reconstructs the sources, applies the control, and atomically refreshes the private prompt store,
private review, and public lane under the existing digest pending transaction. The command tells the
user to run `validate` and `build`; it does not modify or recall an already-built output.

Controls have these exact effects:

| Command | Private state | Selection effect | Public effect after validate/build |
| --- | --- | --- | --- |
| `keep` | candidate state becomes `kept` | bypasses floor, category cap, and overall target | appears first within its category only if receipt and privacy gates pass |
| `hide` | candidate state becomes `hidden` | ineligible | absent |
| `delete --yes` | candidate is removed; no-text tombstone is retained | ineligible and cannot regenerate in the same week | absent |

Keeping a withheld private, ambiguous, high-risk, or disabled-rendition item succeeds as a control
but does not make it public. The command result names the resulting closed decision code, never the
private text or detector detail.

## Private review and tombstone contract

Slice 2 review version 1 remains valid. Its candidate `state` field, already closed to `inbox`,
`kept`, and `hidden`, becomes authoritative for every category when the review week equals the next
prepared week. Prompt-store state remains authoritative when no digest-specific override exists.

Deletion upgrades only the private review to version 2. Version 2 has the Slice 2 top-level keys plus
`tombstones`. Each tombstone has exactly:

```text
itemRef, category, evidenceRefs, deletedAt
```

`itemRef` and every `evidenceRefs` entry are full lowercase 64-hex hashes. `category` is one of the
six closed digest categories. `evidenceRefs` is unique and sorted. `deletedAt` is an ISO timestamp.
The item ref must rederive from `category`, `evidenceRefs`, and the matching current candidate's
closed discriminator before the text is removed. Tombstones sort by item ref and contain no text,
project label, source path, session id, detector, or configured term.

Only controls from a prior review with the exact same week are merged in Slice 3a. Preparing a
different week keeps the existing prompt-store behavior but does not carry non-prompt controls or
tombstones forward. That cross-week behavior belongs to Slice 3b.

The version 2 public lane schema does not change. A kept item in any category uses
`curationState:"kept"`, starts `selection.reasonCodes` with `explicit-keep`, and has
`selection.primaryReasonCode:"explicit-keep"`. Prompt copy remains `you kept this prompt` for byte
compatibility. Other categories use `you kept this item`.

## Failure and transaction rules

The existing `honestweek.digest.pending.json` ordered transaction remains the sole writer protocol
for prompt store, private review, and public lane. Controls do not introduce another partial-write
shape.

- Source, schema, identity, week, output-binding, privacy, or canonical reconstruction failure exits
  2 before the pending marker or any state write.
- A pending or later sidecar fault leaves only one of Slice 2's recognized ordered prefixes. Every
  other command fails closed until `digest prepare` recovers it.
- A failed control preserves the prior control, review, lane, and built output bytes.
- A successful control may change private sidecars, but never writes the configured output. The next
  `validate` and `build` reconstruct the controlled lane before any Git read or output write.
- Deletion recovery never needs deleted text because the pending transaction stages hashes of the
  already-redacted next review and lane.

## Release and verification gates

Implementation starts only after this contract is present, the worktree is clean at `71c53d4`, and
the checkpoint suite passes all 408 tests.

Release requires all of the following:

1. Table-driven tests exercise `keep`, `hide`, and `delete` for prompts, ideas, techniques,
   decisions, reversals, and next steps. Each test resolves a full-review ref, repeats preparation,
   validates, builds, and asserts the expected page row and exact transcript receipt.
2. Every category proves that keep bypasses floor and capacity but cannot bypass private-source,
   needs-approval, high-risk, disabled-rendition, receipt, or schema gates. Explicit keeps may exceed
   the overall target and category caps, with the existing disclosure retained.
3. Hide tests cover selected and already-withheld candidates. Repeated hide and keep commands are
   deterministic, use the latest canonical review, and do not create duplicate state.
4. Delete requires `--yes`, removes all candidate text from `honestweek.curated.json`, writes an
   exact no-text tombstone, blocks same-week regeneration, and never prints the deleted text. A
   minimum-prefix collision or missing ref writes nothing.
5. Version 1 reviews remain loadable and canonical. Version 2 review strict-schema, tombstone order,
   hash, category, evidence, timestamp, duplicate, and text-forbidden tests fail before public lane
   or output writes. The public lane stays version 2.
6. Fault tests inject pending, prompt-store, review, lane, and pending-removal failures for a control
   mutation and prove only the existing recoverable prefixes. Mixed state fails closed.
7. Missing and prompt-only lanes, and balanced lanes with no digest-specific control, retain Slice 2
   output bytes in page and site modes. Existing prompt keep wording and prompt-only commands remain
   unchanged.
8. Display/private clean-room fixtures prove zero Git calls, no path/session/private-term leakage,
   redaction before disk, no network, no publish, and no external target write.
9. `node --test`, the contract hash verifier, clean-room scans, Node 18 syntax compatibility, and a
   final diff review pass. No dependency, lockfile, secret, debug artifact, or scratch file is added.

Any unresolved provenance, privacy, receipt, redaction-before-disk, additivity, transaction, test,
or compatibility finding blocks this release. Uncertain material remains private.
