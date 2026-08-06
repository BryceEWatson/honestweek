Part of the prompt-lanes epic: EPIC_LINK. Depends on phase 3: PHASE3_LINK

## In plain terms

This phase makes ideas survive the week they came up in. An idea you didn't act on shows up again the
following week marked `deferred`, with the week it originally came from shown beside it. An idea you
picked up or ruled out never comes back. Without this, every week starts from zero and a good idea
disappears the moment the week ends.

## What you're deciding

Whether honestweek keeps a running local memory across builds.

Every other file honestweek writes is either about one week or is regenerated from scratch. This one
accumulates: `honestweek.forward-index.json`, gitignored, holding each carried idea's text,
disposition, and the week it first appeared. It has to hold the text, because the archive snapshot
deliberately has no matching key and there's no other way to join a carried id back to something
renderable.

Three properties make that safe, and they're the reason this is its own phase rather than part of the
band:

- **Written by the engine, still not trusted on read.** Every carried row is re-run through the
  display-repo check, the configured private-term check, the unconfigured-noun check and the copy
  gate against the **current** config and corpus, not the config that was in effect when it was
  written. A repo you reclassify as `display` this week retroactively covers last week's carried row.
- **Carried rows are exempt only from current-week receipt resolution** by a named, tested branch.
  Their stored transcript receipt must still be structurally valid and still renders. Every current
  policy, privacy, redaction, and identity check remains active.
- **Absent or unparseable is not fatal.** The carried rows drop loudly and the rest of the report
  still builds.

What merging this changes:

- **New file:** `honestweek.forward-index.json`, gitignored, cumulative.
- **New:** rows that first appeared in an earlier week can render as `deferred`, showing their
  originating week through Phase 2's already-authored date formatter.
- **New validation:** every stored `refCanonical` uses one exact JSON encoding and must hash back to
  its `ref` before it can affect a zombie, duplicate, suppression, or carry join.
- **New:** an idea that reached `picked up` or `ruled out` in any prior week is never surfaced again.
- **Unchanged:** no within-week rendering path. A first-ever build with no index is identical to
  phase 3's output.

## Acceptance

- A week-1 `not started` row renders `deferred` in week 2, its rendered text byte-equal to week 1's,
  and its shown originating week equal to week 1's start.
- A row that reached `picked up` or `ruled out` in any prior week does not reappear.
- A carried row whose text would now name a `display`-role repo aborts the build, using this week's
  config.
- A missing or corrupt index drops the carried rows with a count-free file diagnostic and still
  emits the report. Parseable invalid rows use an exact row count.
- No ref value appears in any rendered artifact or archive snapshot.

## Implementation detail

Spec: `.claude/work/prompt-lanes/spec-v2/phase-4.md`. Decisions: D5, D10, D12, D19, D28, D30, D32,
D33, D40, D45, D46, D47, D49, D50, D55, D56, D57, D58, D62, D63, D64, D65, D69, D73, D74,
D75, D76, D77, D78, D79.

The index is cumulative rather than single-week because the never-resurface rule ranges over any
prior entry, and a single-week file that gets overwritten cannot answer that. Refs are hashes of
identity only, never of text, so a carried key stays stable when the redaction config changes and
carries no information about the prose it points at.
