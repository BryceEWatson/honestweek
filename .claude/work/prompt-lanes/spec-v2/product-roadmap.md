# Honest Week product roadmap

## Product setpoint

Honest Week should turn a completed week across Claude Code and Codex into a concise, useful local
review: what the user asked, figured out, decided, reversed, and intends to do next. Every surfaced
item explains why it was selected and carries a source receipt. The user can correct curation with
keep, hide, delete, and carry-forward controls before choosing whether to publish anything.

This is a product completion roadmap, not an experiment program. Defaults below are reasonable,
disclosed product choices. They do not claim to identify universally important material. Owner
feedback may change a default through an intentional, tested configuration or product revision.

The owner explicitly approved the seven load-bearing product rules on 2026-08-01. The durable
decision record is `owner-approval.md`: evidence-based selection; deletion with no-text tombstones
and explicit reset; low-risk automatic privacy surfacing with a 20-percent edit ceiling; separate
groups with the documented caps and target; bounded carry and retirement; hash-bound pending
recovery; and mandatory representative multi-week proof plus independent review. That approval
settles policy. It does not mark implementation, proof, review, or release gates as passed.

The completion target is the balanced weekly digest, not a prompt-highlights endpoint. Slice 1 is
the first shippable foundation because it proves dual-source identity, receipts, controls, privacy
validation, selection disclosure, and the established weekly-page join end to end. It is not the
finished product and must not be described as coverage of the other five material types.

## Ordered continuation plan

1. Finish and checkpoint Slice 1 as the prompt-only foundation through the existing configured
   weekly-work-page artifact.
2. Add balanced extraction and curation for prompts, ideas, techniques, decisions, reversals, and
   next steps in one concise digest. Apply the documented per-category caps, overall target, receipt
   rules, selection reasons, omitted counts, and uncertainty disclosure through that same page.
   Extend Slice 1's deterministic low-risk privacy gate to every category in this slice; anything
   ambiguous or outside its closed transformations remains private rather than reaching the page.
3. Add cross-week retention, keep/hide/delete, bounded automatic recurrence, explicit carry-forward,
   terminal retirement, and recoverable output/carry transactions for all six categories.
4. Complete the separate private-to-public-safe rendition path with additional meaning-preserving
   transformations, configured generalization, and exceptional approval. The low-risk gate already
   protects every visible category in step 2; this step safely recovers more strong material without
   weakening that gate, escalating ambiguity and excluding residual high risk with source links.
5. Add exact-item useful/not-useful feedback and a count-only improvement backlog. Suggestions may
   propose reviewed configuration changes, but never silently change weights or construct personas.

Each continuation slice must deliver visible, receipt-bearing behavior in the established
configured weekly-work-page flow. Private commands and sidecars support that outcome; none is a
standalone completion boundary. The product is complete only when all five steps have cleared their
own contract, execution, additivity, target-compatibility, and independent-review gates.

## Non-negotiable constraints

- Every visible item has a transcript or verified-commit receipt.
- Git-checkable claims remain verify-or-abort; ambiguous evidence under-claims.
- `display` repositories are never Git-read.
- Every persisted string is redacted before the first write, including temporary files.
- Raw private records and public-safe renditions are distinct and audibly linked.
- No runtime dependencies, Node 18 support, cross-platform paths and atomic file replacement.
- No network egress, telemetry, upload, publish action, or non-loopback server.
- New output remains additive when its inputs are absent.
- Personas are never inferred, persisted, or ranked. An explicitly authored persona is ordinary
  prompt content and receives no special weight.

## Authority and precedence

`owner-approval.md` is the decision authority for the seven approved product rules. This roadmap is
their product source of truth for the owner-directed vertical-slice program. Before a slice changes
runtime behavior, its exact `slice-<N>-*.md` contract becomes the executable authority for that
slice. A slice contract may close implementation detail but may not broaden or weaken an approved
rule. The earlier D1-D79 decisions, four phase specs, assignment, ledger, and audits remain
historical technical evidence only. When they conflict with the approval record, this roadmap, or a
reviewed slice contract, they are superseded and must not be used to fill a gap silently. Slice 1 is
specified in `slice-1-end-to-end-prompts.md`; later slice contracts must close their schemas and
failure tables before their implementation gate.

The established weekly-work-page pipeline remains output authority: `honestweek.items.json` plus any
reviewed additive lane file enters `validate`, then `build`, then the configured existing emitter.
For the established target weekly page, that is the committed `site` adapter and its local data artifact. No slice may
replace that adapter, invent a second publisher, or require the page to read private sidecars.

## Product model

### One private evidence layer

Claude Code and Codex adapters produce the same build-local record shape. Tool-specific envelopes,
system messages, tool results, reasoning, and agent-control messages never enter prompt text.

Each record has a full SHA-256 `ref` over `source + U+0000 + sessionKey + U+0000 + turn`, the exact
canonical identity, source (`claude-code` or `codex`), non-sensitive hashed session key, one-based
human-turn number, timestamp, configured project label or `null`, redacted text, content hash, and
state. Raw source session ids remain build-local. The CLI displays the
shortest unique prefix with a minimum of 12 hex characters and falls back to the full ref. Mutation
resolves against the full current store and rejects zero or multiple matches before a write. A ref collision or canonical mismatch
aborts before a join or write.

The private store is `honestweek.prompts.json`, version 1, gitignored before it is written. It is
cumulative so controls survive a new sync. States are `inbox`, `kept`, and `hidden`. Deletion removes
text and leaves only a no-text ref tombstone so later sync does not regenerate the deleted prompt.
An all-delete operation tombstones every current ref. Writes use a redacted same-directory temporary
file plus atomic rename. The private store is never an emitter or archive input directly.

### One curated weekly item layer

The curated layer uses six user-facing categories: prompts, ideas, techniques, decisions,
reversals, and next steps. Each item carries:

- `itemRef`, category, cautious text, state, week, and public/private disposition;
- one or more source receipts;
- closed selection reason codes plus a short reader-facing reason;
- observable evidence signals used by curation;
- private-source hash and, when applicable, public-rendition hash and transform record.

The model may summarize or name a technique, but it may not invent evidence or a score. Deterministic
code validates identity, receipts, privacy, category, reason codes, configured limits, and every
Git-checkable claim.

Evidence identity and curated-item identity are separate. `evidenceRef` identifies one immutable
source record. `itemRef` is SHA-256 over the category, the sorted complete evidence-ref list, and a
source-produced discriminator such as `prompt`, `idea:<ordinal>`, or `technique:<shapeKey>`; model
wording never enters identity. Controls on the six-category digest target `itemRef`. Prompt-inbox
controls target `evidenceRef`. Deleting prompt evidence removes every derivative that cites it from
the next private review model; it does not claim to recall an already published artifact.

### Cross-tool source authority

| Category | Claude Code authority | Codex authority | Receipt | Excluded inputs |
| --- | --- | --- | --- | --- |
| prompts | human string user turns | `event_msg/user_message` human turns | source, session, turn | commands, delegation/environment/control wrappers, tool results |
| ideas | explicit idea cues in human turns or final assistant text | same cues in human turns or final `agent_message` | source turn(s) | reasoning, tool calls/results, uncued inference |
| techniques | qualifying prompt window plus observed correction/test/commit signals | same tool-neutral window/signals | prompt plus evidence turn/commit | outcome inferred from wording alone |
| decisions | explicit `Decision:`/`Decided:` text or project handoff decision section | same final-message or handoff forms | source turn or handoff | inferred intent |
| reversals | explicit correction/reversal text or handoff reversal section | same final-message or handoff forms | source turn or handoff | generic failure without a changed direction |
| next steps | heading-scoped handoff/final-message next-step list | same forms | source turn or handoff | incidental future tense |

Tool adapters may expose only human turns and final assistant text; reasoning, system/control
messages, tool calls/results, and subagent transcripts are excluded. Project handoffs are a third
local evidence source and are not attributed to a tool without an explicit source field. Slice 2's
contract must pin the exact cues and final-message envelopes for both tools before mining begins.

### Durable state ownership

| Artifact | Versioned writer | Readers | Contents and retention |
| --- | --- | --- | --- |
| `honestweek.prompts.json` | `prompts sync/keep/hide/delete` | `prompts list`, `prompts curate` | redacted prompt evidence and no-text tombstones; Slice 1 schema; never a renderer input |
| `honestweek.prompt-items.json` | `prompts curate` | `validate`, `build`, human review | public-safe prompt items, selection reasons, receipts, and private-ref/hash linkage; an additive existing-pipeline input |
| `honestweek.curated.json` | `digest prepare/keep/hide/delete/carry-forward` | `digest candidates/explain`, validated private build | redacted candidates, item controls, reasons, receipts; regenerated per week while controls merge by itemRef |
| `honestweek.carry.json` | successful digest transaction | `digest prepare` | redacted nonterminal lifecycle state; 12-week maximum history |
| `honestweek.carry.pending.json` | staged digest transaction/recovery | startup reconciliation and `digest recover` | next carry generation, target output hash, prior carry hash, phase; deleted after commit/recovery |
| `honestweek.renditions.json` | `privacy prepare/approve/keep-private` | validated public-facing build | hashes, operations, risk result, decisions, exceptional approvals; no raw private text |
| `honestweek.feedback.json` | `feedback useful/not-useful` | selector and feedback summary | exact-item events; same retention as curated history |
| `honestweek.feedback-backlog.json` | `feedback summarize` | `feedback list/apply` | count-only category/reason suggestions; no prompt or item text |

All are gitignored private state, written atomically after redaction. CLI commands are the only
mutation authority. Existing preview stays read-only. Deleting evidence cascades to private curated
and rendition records on the next reconciliation but preserves no-text audit/tombstone hashes.

## Automatic selection policy

Selection separates evidence eligibility from editorial priority.

An item is eligible only when it has a resolvable receipt, passes redaction/privacy validation, has
a supported category, and contains no unsupported factual claim. `hidden` and deleted items are
ineligible. `kept` items are explicitly selected by the user and render before automatic items.

Automatic priority uses only observable signals and reports them:

| Signal | Default points | Disclosed reason |
| --- | ---: | --- |
| explicit decision or reversal | 3 | “records a decision/reversal” |
| test or verified-commit evidence follows the item | 2 | “connected to observed verification” |
| same normalized subject appears in at least two sessions | 2 | “recurred across sessions” |
| explicit unresolved next step | 1 | “names unfinished work” |
| correction or redirection follows a prompt | 1 | “prompt was refined” |
| explicit positive feedback on this exact ref | 2 | “you marked this useful” |
| explicit negative feedback on this exact ref | -2 | “you marked this not useful” |

Missing evidence scores zero; it is never treated as negative evidence. Automatic inclusion requires
a default score of at least 2. Empty capacity never lowers that floor; a zero- or one-point item is
omitted as `below-automatic-floor`. Explicit keep is the only inclusion override and does not waive
receipt, honesty, or privacy gates. Ties resolve by category order above, then source timestamp, then
full item ref.

The automatic digest target is 12 items, with default category caps of 2 prompts, 2 ideas,
3 techniques, 2 decisions, 1 reversal, and 2 next steps. Kept items bypass category caps and are
never silently dropped; if they push the digest above 12, the digest says that explicit keeps
exceeded the target. Automatic items fill remaining slots. Empty categories do not receive filler.
Every digest discloses the target, actual count, omitted eligible count by category, and that the
rules favor observable recurrence/verification rather than universal importance.

The validated `curation` config object has exact keys `maxItems`, `automaticMinScore`,
`categoryCaps`, `weights`, `retentionWeeks`, and `automaticCarryWeeks`. Defaults are 12, 2, the six
caps above, the exact weights below, 12, and 2. `weights` has exact keys
`decision-or-reversal`, `observed-verification`, `recurs`, `unresolved-next-step`,
`follow-on-correction`, `positive-feedback`, `negative-feedback`, `decision-request`,
`reversal-request`, and `next-step-request`, with defaults 3, 2, 2, 1, 1, 2, -2, 1, 1, and 1.
The last three are prompt-request cues and cannot reach the automatic floor alone. `maxItems` is 1..50;
`automaticMinScore` and each weight are integers -10..10; every category cap is 0..20;
`retentionWeeks` is 1..52; `automaticCarryWeeks` is 0..8. Unknown categories, signals, or keys fail
config validation rather than becoming silent policy.

## Retention and recurrence

- Private prompt text is retained for 12 completed weeks by default; `kept` text is retained until
  hidden or deleted. The range is configurable from 1 through 52 weeks.
- Expired inbox/hidden text is removed and replaced with no-text tombstones. Tombstones prevent
  accidental regeneration and may be explicitly cleared only through a separate reset control.
- An unresolved idea or next step may recur automatically for at most two following weekly digests.
  The receipt and first-seen week remain visible. It then retires from automatic display.
- `carry-forward` renews one item for exactly the next digest and records a local control receipt.
  Repeating the control is explicit; there is no permanent implicit pin.
- Decisions and reversals do not recur automatically. `kept` affects selection, not factual status.
- Terminal evidence (`picked up` or `ruled out`) suppresses nonterminal carry before rendering.

### Carry transaction and recovery

The primary artifact remains output authority; `honestweek.carry.json` is the sole recurrence
authority. A digest build first writes and flushes the fully redacted next carry envelope to
`honestweek.carry.pending.json` with exact keys `version`, `generation`, `priorCarryHash`,
`nextCarryHash`, `targetOutputHash`, `week`, `phase`, and `carry`. `phase` is `prepared` or
`output-written`. It then writes the primary output atomically, records `output-written`, and
atomically promotes pending to canonical carry. A primary-output failure removes pending and leaves
canonical carry unchanged. A promotion failure leaves pending durable and makes every later carry
read fail closed until reconciliation.

At startup and in `digest recover`, if the current output hash equals `targetOutputHash` and the
canonical carry hash equals `priorCarryHash`, recovery promotes pending. If output does not match,
recovery offers `--discard-pending`, which removes pending and requires a fresh prepare/build before
carry can run; it never guesses. Hash mismatch, missing staged state, or any other combination exits
2 with no output/index mutation. Fault tests cover each temp write, flush, primary rename, phase
rewrite, and carry rename boundary plus repeated recovery.

## Private-to-public-safe path

“Public” means eligible for a local public-facing artifact. Honest Week still uploads nothing and
the user remains the publisher.

For a strong selected item, the default flow is assess, apply the smallest permitted
meaning-preserving privacy transformation, validate, then choose `automatic-safe`,
`needs-approval`, or `excluded`.

`strong` means selected by explicit keep or a score at/above `curation.automaticMinScore`; it never
overrides privacy. Privacy detectors are closed and versioned: configured redaction tokens, email,
phone, absolute path, credential/key/token patterns, IP address, numeric account/identity strings,
unknown proper nouns, and `display`-role source context. Raw and residual risk are `low`, `medium`,
or `high`:

- low: no detector hit remains, every operation is allowlisted, and changed-span validation is
  complete;
- medium: only an unknown proper noun, numeric identifier, display-context generalization,
  20-percent boundary excess, unknown mapping, or classifier/validator uncertainty remains;
- high: a credential/secret, configured never-public token, direct contact identifier, or two or
  more linkable identity/location/account signals remain after feasible transformation.

The decision table is ordered and non-compensatory: residual high is `excluded`; validation failure
or medium/ambiguous/unusual status is `needs-approval`; strong plus residual low plus every automatic
transform limit is `automatic-safe`; everything else remains private as `not-strong`. Approval may
resolve medium ambiguity after a valid rendition but cannot override a validator failure or high
risk. Slice 1 pins and implements the closed prompt-specific detector, audit, and automatic-safe
subset before its code changes. Slice 2 applies that deterministic low-risk kernel to every visible
category. Slice 4 adds configured generalization mappings, more allowed transformations, and
exceptional approval; it does not replace, defer, or weaken the gate.

Automatic transformations are limited to redactor replacements, removal of a validator-identified
sensitive span, and configured exact generalization mappings. They may not add an actor, motive,
outcome, number, or claim. Automatic handling requires 100 percent changed-span accounting, no
remaining privacy-rule hit, no unknown mapping, and at most 20 percent of non-whitespace source
characters changed. These thresholds are configuration, not a claim that every item below them is
safe.

Ambiguous classification, an unusual transform, an unknown mapping, validator uncertainty, or a
larger meaning-preserving edit becomes `needs-approval` and remains private until approved.
Residual high risk after permitted transformation is `excluded`; approval cannot override it.
Every path records the private ref/receipt, source and rendition hashes, ordered operations, policy
version, residual-risk class, decision reason/time, and approval identity/time only when escalated.
The public line carries its receipt and a `privacy edited` marker when changed, never private text or
transform details.

The local-only approval view shows the redacted private source beside the proposed rendition,
highlights every changed span, lists ordered operations and remaining rule hits, and offers only
`approve` or `keep-private`. Approval is therefore an informed exception, not a blind confirmation.

The validated `privacy.publicRenditions` config has exact keys `enabled`,
`maxAutomaticChangedPercent`, `generalizationMappings`, and `neverPublicTerms`. Defaults are true,
20, an empty exact-string mapping object, and an empty string array. Enabling it never enables an
upload or publish action.

## Feedback and improvement backlog

`useful` and `not-useful` are local control events tied to an exact ref. They affect only that ref's
disclosed score. Category-level suggestions are accumulated in a gitignored backlog as counts and
reason codes, without private text. Honest Week may recommend a cap or weight change after at least
five same-direction events in a category, but never applies it silently. The user accepts a proposed
configuration change explicitly; the resulting diff is ordinary reviewable product configuration.

This gives the shipped product a feedback loop without inferred preferences, opaque learning, or
persona construction.

## Safe end-to-end vertical slices

Every slice terminates in the established local weekly-page artifact. A private-only command is a
supporting control, not a shippable slice boundary. The existing `items -> validate -> build ->
configured page/site adapter` path stays intact; each lane is an optional, validated input to it.

### Slice 1: dual-source prompts on the existing weekly page

**User experience.** `honestweek prompts sync` captures the completed week from Claude Code and
Codex into a private redacted inbox. `list`, `keep`, `hide`, and `delete` provide source-receipted
control. `honestweek prompts curate` applies the disclosed prompt-only score and privacy policy,
shows selected and withheld counts with reasons, and writes a reviewable
`honestweek.prompt-items.json`. Running the unchanged `validate` then `build` combines those items
with the normal `honestweek.items.json` work items and writes the configured weekly page or site
artifact. A low-risk item may flow automatically after no edit or a bounded redactor edit;
ambiguous or residual-high items stay private. Nothing publishes.

**Reader outcome.** The existing weekly-work page gains one ordinary visual group named `Prompt
highlights` with at most two automatic entries plus every receipt-valid, privacy-safe explicit keep.
Prompt rows carry no work-status badge. Each uses the
existing detail drawer for a transcript receipt and includes a short selection reason. The committed
target transform already accepts this as a generalized, commit-less item group, so it needs no target
repository change. No new page shell or parallel output is introduced. With the prompt-items file
absent or empty, every existing build mode and site artifact stays byte-identical.

**Implementation scope.** Add the two narrow prompt adapters, identity/private store, inbox controls,
prompt-only selector and deterministic privacy validator, public-safe prompt-items sidecar, and the
small additive `validate`/`build` join for `page` and `site`. Reuse the configured target transform's
existing item/snippet grammar. Do not change its artifact path, publish flow, Git verification, or
interpretation of existing work items. A nonempty Slice 1 lane fails preflight under other modes
rather than silently building without prompt rows.
`slice-1-end-to-end-prompts.md` is the executable contract.

**Release gate.** A clean-room week from both tools produces selected and withheld prompts, passes
the additive validate/build gates, and changes the expected local weekly-page artifact only by the
receipt-bearing selected rows. Missing lane input is byte-identical. Unsafe/private/display material
does not enter the public-safe sidecar or page. Each file write is atomic. A successful sync followed
by a lane-write failure may leave the new private inbox with the prior lane/page, but canonical
rescan makes that pair unbuildable until curate is rerun; it never emits stale content. No Git read
occurs for prompt ingestion or display repos; no network or publish action occurs.
The local release gate also imports the actual configured target transform read-only, passes the
generated bundle through it in memory, and asserts the resulting group, no-badge item, reason, and
transcript snippet. A source check confirms the target report component renders arbitrary groups,
items, and snippets through its existing generic branch. No target file is written. If the configured
target adapter/component is unavailable, implementation work may continue but Slice 1 release and
completion remain blocked; the gate report names the missing path and carries no private content.

### Slice 2: all six categories through the same page

**User experience.** `honestweek digest prepare` syncs both sources, mines prompts, ideas, techniques,
decisions, reversals, and next steps, and produces one concise review with selection reasons and
receipts. The same validated lane input joins the established build and weekly page. Candidate views
explain both selected and omitted material without claiming universal importance.

**Release gate.** Declared clean-room fixtures pin extraction authority, category, score, caps,
reasons, receipts, privacy disposition under the deterministic low-risk gate, page order, and
lane-absent additivity for every category. Ambiguous or unsupported transformations remain private.

### Slice 3: lifecycle and recurrence on the generated page

**User experience.** Keep, hide, delete, and carry-forward work across all categories. The next built
weekly page shows bounded first-seen/as-of context; expired and terminal items retire. The page and
carry state commit as one recoverable local transaction.

**Release gate.** Multi-week fixtures prove retention, the two-week automatic limit, explicit
one-week renewal, tombstones, terminal suppression, and output/carry recovery at each fault point.

### Slice 4: expanded public-rendition triage through the page

**User experience.** Building on the low-risk gate already applied to every category in Slice 2,
the selector attempts additional allowed minimal transformations for every strong item. Newly
automatic-safe renditions join the weekly page; ambiguous items enter a local approval queue; high
residual risk stays excluded. Approval is exceptional, side-by-side, and cannot override high risk
or failed validation.

**Release gate.** All detector classes, changed-span accounting, configured mappings, threshold
boundaries, audit linkage, exceptional approval, exclusion, and page additivity have adversarial
coverage. No action publishes or sends the artifact.

### Slice 5: feedback-driven curation on the generated page

**User experience.** Useful/not-useful feedback on exact page items updates the next disclosed score.
The user reviews count-only configuration suggestions; no weight changes silently. The loopback
preview shows the same curation summary that generated the page.

**Release gate.** Exact-ref feedback affects only the documented selector, private text never enters
the backlog, and no persona or implicit profile is inferred, persisted, or ranked.

## Controller and feedback gates

| Control element | Honest Week definition |
| --- | --- |
| objective/setpoint | A concise, useful, receipt-bearing weekly page across Claude Code and Codex, with private evidence controls and only validated public-safe renditions |
| system state | source roots and statuses, private evidence/tombstones, curated controls, rendition decisions, existing work items, configured emitter, primary artifact, carry, and feedback |
| sensors | exact schema/hash/receipt checks, source re-resolution, privacy detectors, Git verification, output byte comparisons, fault injection, full Node suite, and independent review |
| controller decisions | eligible/withheld, selected/omitted, automatic-safe/needs-approval/excluded, render/abort, carry/retire, and advance/stop |
| actuators | local sync, atomic sidecar replacement, additive verified-model attachment, existing local emitter, lifecycle mutations, and explicit config changes |
| constraints | all non-negotiable constraints above, plus the committed target adapter as output authority and no target-repository write in this task |
| feedback | user keep/hide/delete/carry/useful decisions, exact reason counts, test failures, parity diffs, and review findings |
| uncertainty | selection is a disclosed heuristic, proper-noun/privacy ambiguity escalates, missing evidence scores zero, and no persona or universal-importance inference is allowed |
| stop conditions | any unresolved receipt, privacy/audit ambiguity on a rendered item, display Git read, partial write, non-additive unexplained diff, failed invariant, or non-clean review |

The roadmap controller advances one slice at a time. Sensors include the full Node test suite, exact
schema/receipt/privacy contract tests, clean-room fixtures, byte-diff additivity checks, forbidden
Git/network spies, cross-platform temporary-directory tests, and review-loop verdicts. Actuators are
limited to the current slice's files. Each slice gets an intentional checkpoint and is independently
revertible.

Stop a slice when any receipt cannot resolve, a public claim cannot verify, a display repo would be
Git-read, an unredacted string could reach disk, a ref/canonical collision is ambiguous, an output
authority can diverge silently, a Node 18/cross-platform check fails, or independent review is not
clean. Product uncertainty is labelled in output and refined through explicit feedback; it does not
block reasonable defaults from shipping.
