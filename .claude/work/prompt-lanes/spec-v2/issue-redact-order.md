## In plain terms

When honestweek mines a session transcript, it shortens long strings first and scrubs private
things like email addresses second. That order is backwards. If an address sits past the cut point,
shortening slices it in half, and the scrubber no longer recognises the half that's left, so a
fragment of a real address ends up in the local draft file. I want to swap the two steps so
scrubbing always runs on the whole string.

This is a privacy fix, and it isn't part of the prompt-lanes feature. I'm filing it on its own
because it changes bytes in files people already have, and that deserves its own decision rather
than riding along inside a feature branch.

## What you're deciding

Whether to change how existing local drafts look, in exchange for closing a real leak.

**What merging this changes:** the four mined text fields in a session entry get scrubbed before
they get shortened. For any string long enough to be cut, the shortened result can differ from what
today's code produces. Strings shorter than the cut length are unaffected, and so is every string
that contains nothing the scrubber matches.

**What it does not touch:** nothing published, nothing rendered, no report, page, post or archive
output. Only the local `honestweek.draft.json` that `discover` writes, which is gitignored and never
leaves the machine. No config key changes. No new dependency. The rule that every emitted string has
passed the redactor is unchanged; this makes it true earlier.

**Why it isn't folded into the prompt-lanes work:** an earlier draft of that spec did fold it in,
and covered the byte change by rewriting `AGENTS.md` invariant 6 to name it as a deliberate
exception. Rewriting an invariant to excuse breaking it is exactly the move this product exists to
refuse, so it's split back out. Invariant 6 keeps its meaning, and prompt-lanes stays additive.
Inside that feature, scrub-before-shorten applies only to fields it introduces.

## The leak, concretely

A 303-character steer ending in an email address. Today the string is cut to 280 characters first,
which lands mid-address, and the scrubber's pattern no longer matches the fragment. The local part
and the first half of the domain survive into the draft. Scrubbing first replaces the whole address,
and the cut then falls on already-safe text.

## Acceptance

- Each of the four mining sites scrubs before it shortens.
- A test pins the 303-character case: an address that today survives in fragments is fully replaced
  after the change, asserted on the exact output string, not on a substring check that could pass
  for the wrong reason.
- A test pins a string shorter than the cut length, proving unchanged output where no cut happens.
- The suite stays green. Baseline is 371 passing tests.
- The changed-bytes note goes in the pull request body, with the field list and the condition under
  which a draft differs.

## Implementation detail

Four call sites in `lib/claude-adapter.mjs`, all inside `extractEntry`:

| Line | Field | Bound |
| --- | --- | --- |
| 345 | `steers[]` | `MAX_STEER_LEN` 280 |
| 347 | `redirects[]` | 160 |
| 370 | `notes[]` from a `thinking` block | `MAX_NOTE_LEN` 400 |
| 372 | `notes[]` from a `text` block | `MAX_NOTE_LEN` 400 |

Each calls `truncate(content, max)` (`lib/claude-adapter.mjs:311`) on the raw string. Redaction runs
later, once, over the assembled entry at `lib/claude-adapter.mjs:518` via
`redactor.deepRedact(entry)`. The fix is to redact each string at the mining site, before
`truncate`, so `deepRedact` at 518 becomes a second pass over already-clean values rather than the
only pass.

`truncate` also collapses whitespace, so the two operations are not commutative in general. Pin the
expected output strings in the tests rather than the lengths.

Related: `AGENTS.md` invariant 5 ("redact before disk") and invariant 6 ("new output is additive").
This change strengthens 5. It is a deliberate, scoped exception to 6, taken here on its own terms
instead of inside a feature that would have needed the invariant loosened.
