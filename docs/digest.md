# The weekly digest: review controls in detail

## In plain terms

With `page` or `site` output, `honestweek digest prepare` picks a short list of the week's prompts, ideas, techniques, decisions, reversals and next steps for the published page, each linked to the session it came from, and only the ones that pass the privacy check. The README covers the everyday controls. This page has the rest: every control, the hold on items the redactor can't settle, how unresolved items carry into later weeks, and how an interrupted build recovers.

## Preparing and controlling the digest

For `page` or `site` output without the opt-in goals registry, run `honestweek digest prepare`. It scans the completed week from Claude Code and Codex, updates the gitignored private prompt inbox and balanced review model, and writes the public-safe `honestweek.prompt-items.json` lane. Use `digest candidates` and `digest explain <item-ref>` to inspect the exact score, selection reason, privacy result, and transcript receipts. Use `digest keep`, `hide`, `delete <item-ref> --yes`, or confirmed `delete --all --yes` to control current items in any category, then run `validate` and `build`. Keep changes selection only and never bypasses receipt or privacy gates. If the redactor would still change an item's redacted text on a second pass, that one item is held back as `high-risk`, its text is replaced by a single placeholder in the private files, and the rest of the week still builds. Delete removes private review text and leaves a no-text tombstone so preparation cannot regenerate the item; it cannot recall an output you've already built. `digest reset-tombstones <item-ref>|--week <YYYY-Www>|--all --yes` is the explicit regeneration control. The balanced digest lane and the goals page are not yet compatible; use the existing distillation path when the goals registry is present.

## Carrying items into later weeks

Selected next steps and cues labelled `unresolved idea: <subject>` carry automatically for at most the next two reporting weeks. They must still pass the current privacy gate, automatic floor, target, and category cap. `digest carry-forward <item-ref>` schedules one current public-safe candidate for exactly the next digest and does not extend automatic carry. A human turn labelled `picked up: <subject>` or `ruled out: <subject>` retires one unambiguous matching carry. Every carried or renewed item discloses why it appeared and its first-seen and current week. Carry history is private, redacted, and limited to 12 week records.

## Recovering an interrupted build

A lifecycle build binds the exact configured output bytes and next carry state with hashes. If an interrupted build leaves `honestweek.carry.pending.json`, the next `prepare`, `validate`, or `build` recovers only a recognized hash combination. Use `digest recover --discard-pending` only when the output differs and carry is still at its prior hash. Unknown states fail closed. Use `prompts list`, `source`, `keep`, `hide`, and `delete` when you want the prompt inbox controls directly. Automatic selection discloses its floor, overall target, category caps, omitted counts, and uncertainty. Privacy edits are deterministic redactions; ambiguous or residual high-risk material stays private. `prompts curate` remains available when you intentionally want the prompt-only lane.
