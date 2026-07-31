# Slice 1 contract: dual-source prompts on the existing weekly page

## Authority, setpoint, and compatibility boundary

This is the executable contract for Slice 1 of `product-roadmap.md`. It supersedes conflicting
prompt-lane requirements in D1-D79 and the earlier phase files, which remain historical evidence.

The setpoint is one safe, useful end-to-end improvement to the product that already generates the
weekly work page: prompts from both Claude Code and Codex can be privately captured, controlled,
automatically curated under disclosed limits, privacy-validated, and included through the existing
`validate -> build -> configured emitter` path. The configured `site` adapter and its artifact path
remain authority for the established target weekly page. Honest Week does not publish, push, or write a second page.

The slice is prompt-only. Ideas, techniques, decisions as standalone categories, reversals, next
steps, carry-forward, ambiguous-item approval UI, and feedback weights remain later slices. Their
absence is disclosed and is not represented as completeness.

The reporting week is the inclusive local-date object `{ start: Monday YYYY-MM-DD, end: Sunday
YYYY-MM-DD }` returned by the existing resolver in the configured timezone. Adapters scan the
timezone-resolved instant interval `[startInclusive, endExclusive)`, where endExclusive is local
midnight on the Monday after the reporting end. `sourceStatus.weekStart` and `weekEnd` store the two
inclusive reporting date strings, not instants. Lane `week` uses the same object. Full rescan resolves
the instants again and compares the stored date strings. Fixtures include startInclusive, the final
Sunday instant, and the excluded next-Monday boundary, including a daylight-saving transition.

## End-to-end user flow

```text
honestweek prompts sync [--week <value>]
honestweek prompts list [--week <value>] [--state inbox|kept|hidden|all] [--limit <1..200>] [--offset <0..>]
honestweek prompts source <ref-prefix>
honestweek prompts review [--week <value>] [--decision below-automatic-floor|needs-approval|high-risk|all] [--limit <1..200>] [--offset <0..>]
honestweek prompts keep <ref-prefix>
honestweek prompts hide <ref-prefix>
honestweek prompts delete <ref-prefix> --yes
honestweek prompts curate [--week <value>]
honestweek validate
honestweek build
```

`sync` reads both local transcript roots and atomically updates `honestweek.prompts.json`. `list` and
mutations read that gitignored private store only. `source` re-resolves one live receipt and shows
only its current redacted text. `review` is a private, read-only paged view that recomputes score and
privacy disposition from the store, showing ref, redacted preview, decision/reason, and the exact
`hide` and `delete` off-ramps; it says that keep cannot override privacy. `curate` first performs the
same sync for its selected week, then requires at least one present valid source, rejects a present
unreadable, stale, or mixed-week source, selects only public-safe prompt renditions, and atomically replaces
`honestweek.prompt-items.json`. It prints selected count, withheld counts by reason, the automatic
score floor and cap, and the next commands `validate` and `build`.

Sync and lane replacement are two ordered atomic writes, not a claimed cross-file transaction.
If sync fails, neither file changes. If sync succeeds and lane replacement fails, the new private
store remains, the prior lane/page remain, stderr says `private inbox updated; prompt lane not
updated; rerun honestweek prompts curate`, and canonical rescan makes validate/build fail closed on
the stale pair. A repeated curate reconciles it. Fault tests pin every temp/write/flush/rename
boundary and this recovery; no path rolls the private inbox back or treats the old lane as current.

Before source reads or writes, `curate` preflights the configured output. `page` without an objectives
registry and `site` with a configured existing adapter are supported. Any other mode exits 1 and says
`prompt highlights render only in page or site mode; update output.mode, then rerun prompts curate`.
`page` plus an objectives registry exits 1 and says the Slice 1 multi-page transaction is unsupported
and names `site` as the established compatible weekly-page path; it never discovers the limitation
after producing a lane file. This is a bounded first-slice limit, not silent success.

`review` defaults to the completed week, all withheld decisions, limit 50, and offset 0. Its stable
order is decision-table order, then score descending, timestamp ascending, full ref. It reports
matched total, displayed range, remaining count, and the exact next-offset command, matching `list`.

`validate` and `build` load ordinary work items from `honestweek.items.json` and the optional prompt
lane from `honestweek.prompt-items.json`. Both gates validate the prompt lane before any Git read or
output write. For `page` and `site`, build appends prompt items after existing work items and then uses
the configured existing emitter, target transform, and local artifact path. Whenever a nonempty lane
exists, both `validate` and `build` repeat curate's exact output-mode, objectives-registry, and adapter
preflight before Git reads or writes, including the same recovery diagnostic. A mode/registry/adapter
change after curation therefore fails loudly. With the optional lane absent or carrying zero items, the parsed model
and every existing output byte are unchanged.

The existing items file is never rewritten by a prompt command. The private prompt store is never
read by an emitter or site adapter. The public-safe lane file is reviewable and removable; deleting
it restores the exact legacy input path.

### Compatibility repairs inside the slice

Three existing seams must be repaired before the prompt lane is enabled. They are foundation work
inside this vertical slice, not separate product endpoints:

1. Repo attribution must match a configured display path with pure segment-aware path logic and must
   never call worktree discovery or any Git helper for a display repo. Featured/reference attribution
   may still use worktree discovery. A spy pins zero display-role Git calls.
2. `page` must carry a prompt's validated session receipt into its existing detail drawer and use
   lane-aware footer copy only when a prompt lane is present. Lane-absent HTML bytes stay identical.
3. `emit` and `emitSite` must fully render/serialize first, then write an exclusive same-directory
   temp, flush, close, and rename. Success bytes remain identical; any temp/write/flush/rename failure
   preserves the prior primary artifact. Multi-page goals remain outside the Slice 1 prompt
   transaction and a prompt-bearing build is rejected for that combination until a later contract
   makes both outputs atomic together.

The display-attribution repair closes a pre-existing hard-invariant violation. Its only permitted
lane-absent behavior change is that a session in a linked worktree of a display repo can no longer be
attributed through Git metadata; it fails private instead. This exception is pinned and called out in
the checkpoint. Every other lane-absent success artifact is byte-identical.

## Source adapters and identity

Both adapters implement:

```text
readPromptRecords({ root, weekStart, weekEnd, config, redactor })
  -> { state: "present"|"absent"|"unreadable", records, malformedLines }
```

The normalized adapter result is exactly:

```text
{ source, sessionId, turn, timestamp, repoKey, project, isPrivate, sourceHash, sourceLength, text, redactionCount, changedPercent, rawRisk, rawDetectors, followOnCorrection, observedVerification }
```

The adapter may hold one raw line only while hashing, measuring, and redacting it. Raw text never
enters its returned record, a serializable object, log, exception, or fixture snapshot. Raw session
id is returned only to the sync identity boundary, hashed immediately, and then discarded before a
persistable object exists. `redactionCount` and `changedPercent` are exact per-record audit values.

Roots are Claude Code `$CLAUDE_CONFIG_DIR/projects` else `~/.claude/projects`, and Codex
`$CODEX_HOME` else `~/.codex` with reads confined to `sessions` and `archived_sessions`. Tests inject
roots. Enumeration skips symlinks and reparse points, never resolves outside a root, reads Claude
top-level project JSONLs excluding subagents, and reads Codex regular JSONLs only under the two named
children. There are no Git, network, or write calls in adapters.

Claude accepts nonempty string `type:user` turns. It excludes array tool results and a first
opening-tag name in the closed machine set `command-*`, `task-notification`,
`local-command-caveat`, `local-command-stdout`, `local-command-stderr`, `system-reminder`,
`cross-session-message`, `scheduled-task`, and `user-prompt-submit-hook`. Codex accepts only
`type:event_msg` plus `payload.type:user_message` string messages and excludes known delegation,
environment, app, permission, collaboration, plugin, skill, recommended-plugin, abort, and AGENTS
wrappers. Unknown user-authored XML remains eligible.

Within a Claude file, the first conversational session id is authoritative and a later conflict
makes the file unreadable; filename is fallback. Timestamp and cwd come from the turn, then first
valid file cwd. Within Codex, the first `session_meta` id is authoritative, conflict is unreadable,
event timestamp is top-level, and cwd is the most recent preceding `turn_context`, then session-meta
cwd. Turn is the one-based accepted-human-turn ordinal across the whole session, including turns
outside the selected week. Week membership is `timestamp >= weekStart && timestamp < weekEnd`.

Project attribution uses segment-aware `path.relative`, Windows case-insensitive and POSIX
case-sensitive. A matched featured/reference repo receives its safe configured label and
`repoKey = sha256(normalized configured path)`. Display and unmatched sources have `project:null`,
`isPrivate:true`; no Git read is permitted.

`sessionKey = sha256(source + NUL + rawSessionId)`. `refCanonical = source + NUL + sessionKey + NUL
+ decimalTurn`; `ref = sha256(refCanonical)`. Production uses Node SHA-256. A pure identity helper
accepts a digest seam only for collision tests. Raw session ids are discarded before persistence.

## Private prompt store and controls

`honestweek.prompts.json` is gitignored before its first same-directory temp write. It has exact top
keys `version`, `generatedAt`, `sourceStatus`, `prompts`, and `tombstones`. Version is 1.
`sourceStatus` has exact keys `claude-code` and `codex`; each records `state`, `weekStart`, `weekEnd`,
`syncedAt`, `records`, and `malformedLines`.

Each prompt has exact keys `ref`, `refCanonical`, `source`, `sessionKey`, `turn`, `timestamp`,
`repoKey`, `project`, `isPrivate`, `state`, `sourceHash`, `contentHash`, `text`, `redactionCount`,
`sourceLength`, `changedPercent`, `rawRisk`, `rawDetectors`, `redactionOps`, `truncated`,
`followOnCorrection`, and `observedVerification`. `state` is
`inbox|kept|hidden`. Text is redacted, nonempty, capped at 4000 Unicode
code points after redaction. `sourceHash` hashes the private raw source for change detection only;
`contentHash` hashes persisted text. `sourceLength` is the raw non-whitespace code-point count.
`changedPercent` is the raw-to-redacted transformation measure defined below. They are the only
raw-derived quantities persisted. A tombstone has exactly:

```json
{
  "ref": "64 lowercase hex",
  "refCanonical": "source NUL sessionKey NUL turn",
  "source": "claude-code|codex",
  "sessionKey": "64 lowercase hex",
  "turn": 1,
  "deletedAt": "ISO-8601 UTC"
}
```

Unknown/missing keys fail. `deletedAt` must equal `new Date(value).toISOString()`. Identity fields
pass the same canonical/hash validation as a live prompt. Tombstones sort by ref; no ref can appear
in both collections; same ref with another canonical aborts. Version 1 has no implicit tombstone
migration or expiry. Delete preserves an existing identical tombstone's original deletedAt.

Before discarding raw text, the adapter records only closed detector enums, never matched values.
The exact order is `configured-term`, `never-public-term`, `email`, `phone`, `home-path`, `secret`,
`uuid`, `currency`, `account-number`, `ip-address`, `display-context`, and `capitalized-unknown`.
The array is unique and sorted in that order. Raw risk is `high` when any of the first ten is present,
`medium` when either of the last two is present, otherwise `low`. Raw risk affects audit and triage
but never skips the required transformation attempt.

`redactionOps` is an array of exact objects `{ detector, start, end, placeholder }`. Start is an
inclusive and end an exclusive Unicode-code-point offset into raw text. Operations are ordered by
start, never overlap, and use the detector order above as same-start priority, then longest match.
The placeholder is one of the canonical existing strings `[redacted:term]`, `[redacted:email]`,
`[redacted:path]`, `[redacted:secret]`, or `[redacted:account]`. `redactionCount` deep-equals the
array length. `truncated` is true only when the audited redacted result exceeded 4000 code points;
such a record is stored at the cap but cannot be automatic-safe.

Every persisted string passes the canonical redactor; enums, ISO strings, hashes, and canonical
identity must remain byte-identical or sync aborts exit 2. Same identity/sourceHash with changed
redaction policy replaces only redaction-derived fields and preserves state. Same identity with a
different sourceHash, any collision, canonical/hash mismatch, malformed old store, unreadable root,
or failed write preserves the exact old bytes. Reclassification against current repoKey config runs
over all stored prompts on every sync and fails private on removed/display/unsafe mappings.

Store ordering is timestamp, source, sessionKey, turn, ref; tombstones sort by ref. The serialized
store cap is 8 MiB. Writes use exclusive same-directory temp creation, flush, close, and rename.
Both `honestweek.prompts.json` and `honestweek.prompts.json.tmp-*` are gitignored. No text is silently
dropped to meet the cap.

List defaults to the completed week, inbox plus kept, 50 rows, offset zero. It prints stable paging,
a 120-character redacted preview, state/source/time/project-or-private, and
`[source session <short-session> turn <n>]`. Refs and session keys use the shortest unique prefix,
minimum 12 hex, full fallback. Mutations re-resolve a unique ref prefix immediately before write.
Keep/hide are idempotent. Delete requires `--yes`, removes text, and leaves a tombstone that prevents
recapture. Slice 1 supports individual deletion only; bounded week/all deletion and tombstone reset
ship with lifecycle Slice 3.

Delete prints that it cannot recall `honestweek.prompt-items.json` or an already built page. It names
the configured local output path and the exact cleanup sequence `honestweek prompts curate`,
`honestweek validate`, `honestweek build`; the next curate removes the tombstoned derivative. Until
that sequence succeeds, validation of an old lane file fails against the tombstone, so stale prompt
text cannot silently ship again. Manual removal of the local output is an immediate off-ramp.

`source` resolves live prompts only. It scans the named source root, finds exactly one raw session
whose hash matches the stored sessionKey, selects the stored accepted-turn ordinal, re-runs current
redaction, and requires exact sourceHash/contentHash/audit equality before printing. A tombstone or
missing source exits 1 with no text; ambiguity, changed source, or identity mismatch exits 2 with no
text. Build uses this same resolver without printing for every selected prompt before any Git read.

## Prompt-only automatic curation

`curate` evaluates non-hidden, non-deleted prompts in the selected week. `kept` is an explicit
selection override but never a receipt or privacy override. Every receipt-valid, public-safe keep
renders before automatic prompts. Automatic prompts require the configured
`curation.automaticMinScore` (default 2) and their cap is configured
`curation.categoryCaps.prompts` (default 2). Keeps do not consume that cap. When keeps make the lane
exceed the configured automatic cap, stdout and the fixed summary disclose `explicit keeps exceeded
the automatic target`. Missing evidence scores zero; capacity never lowers the floor.

Prompt subject normalization is deterministic: Unicode NFKC, lowercase, canonical redaction
placeholders replaced by the token `redacted`, every non-letter/non-number replaced by a space,
whitespace collapsed, then exact filler tokens `a`, `an`, `the`, `please`, `just`, `really`, `me`,
`my`, `our`, `we`, `you`, and `your` removed. Modal verbs are never removed. Two prompts recur when
they are from different session keys, each retains at least four tokens, and the set Jaccard score is
at least 0.75. Recurrence is pairwise; it does not use a transitive cluster.

For each accepted prompt, both adapters also derive two boolean follow-on signals without retaining
assistant/tool text. `followOnCorrection` is true when the next accepted human turn in the same
session begins, after whitespace, with `actually`, `correction`, `instead`, `rather`, or `no,`.
`observedVerification` is true when a result from a linked shell tool named `Bash`, `shell_command`,
or `exec_command` between this prompt and that next human turn (or session end) contains a complete
40-hex commit token or matches `N passing|N passed|all tests passed|test(s) passed|PASS|# fail 0|✓`,
case-insensitively, and does not match `build failed|compilation failed|test(s) failed|FAIL|# fail
[1-9]`. Claude uses `tool_result` blocks linked to a preceding tool use. Codex uses paired
`response_item/function_call` and `function_call_output` records by call id. Unpaired, malformed,
failed, aborted, assistant prose, and reasoning records contribute false. Only the booleans enter the
returned/persisted record.

Closed Slice 1 signals are:

- `recurs`, +2: the pairwise normalized-subject rule above matches another session;
- `observed-verification`, +2: the follow-on evidence window contains a test pass or commit receipt;
- `follow-on-correction`, +1: the next human turn begins with a correction marker;
- `decision-request`, +1: the prompt contains the whole token `decide`, `decision`, `choose`, or the
  phrase `settle on`;
- `reversal-request`, +1: the prompt contains the whole token `instead`, `revert`, `reverse`, or the
  phrase `change course` or `no longer`;
- `next-step-request`, +1: the prompt contains the whole token `next`, `todo`, or `later`, or the
  phrase `follow up`.

The fixed reader-facing reason phrases are, in the same order: `recurred across sessions`, `followed
by observed verification`, `was refined in a later turn`, `asked for an explicit decision`, `asked
to change direction`, and `named follow-up work`.

Signals are literal policy cues, not claims about motive or importance. Ties sort by score descending,
timestamp ascending, then full ref. Every matched signal appears once in `reasonCodes` in the listed
order even when its configured weight is zero. An automatic item's reader-facing reason is the fixed
phrase for its first matched eligibility-bearing signal: `recurs`, else `observed-verification`.
Other codes remain auditable metadata. Kept items say `you kept this prompt`. An automatic
selection must contain `recurs` or `observed-verification`; lexical requests and follow-on correction
can affect order but cannot establish automatic eligibility alone. A kept item uses reasonCodes
`["explicit-keep"]`, the fixed reason `you kept this prompt`, and still records its computed score.
Withheld reasons are exactly
`below-automatic-floor`, `hidden`, `private-source`, `needs-approval`, `high-risk`, `capacity`, and
`public-renditions-disabled`. The command reports counts without private text.

Every live in-week prompt is either selected once or assigned exactly one withheld reason. First
apply `hidden`; `private-source`; residual `high-risk`; then `needs-approval` for
medium/audit/truncation ambiguity. For non-kept prompts, next apply `below-automatic-floor` when the
configured score or non-lexical-evidence gate fails, rank the remaining eligible automatic prompts,
and apply `capacity` beyond the configured cap. Only then, when public renditions are disabled,
assign `public-renditions-disabled` to safe kept prompts and within-cap eligible automatic prompts
that otherwise would render. A kept low-risk prompt skips floor and capacity. Deleted/tombstoned refs
are not live candidates and do not enter selected/withheld counts.
The invariant is `live in-week prompts = selected + sum(withheld)` and is asserted for every run.

Slice 1 consumes the roadmap's validated configuration without adding a second policy namespace.
`curation.automaticMinScore`, `curation.categoryCaps.prompts`, and the six prompt-applicable weights
control the floor, cap, and score. All other category caps and weights validate and persist their
defaults but are unused until their category ships. `privacy.publicRenditions.enabled` defaults true
because the output is still only a local artifact; false writes a valid empty lane and reports every
otherwise selected item as `public-renditions-disabled`. `maxAutomaticChangedPercent` controls the
automatic edit limit. Slice 1 rejects nonempty `generalizationMappings` because it implements only
canonical redactor edits; later slices may activate validated exact mappings.

## Privacy transformation and public-safe lane

For each score-eligible prompt, curation performs assess, minimal transform, validate, then decision.
In Slice 1 the only automatic transform is the audited canonical replacement table below. It cannot
introduce or generalize wording. Raw text remains in the source transcript, not a new Honest Week file.

| Detector | Exact match authority | Placeholder |
| --- | --- | --- |
| configured-term | canonical redactor's whole-token, case-insensitive configured-term matcher | `[redacted:term]` |
| never-public-term | the same matcher over `privacy.publicRenditions.neverPublicTerms` | `[redacted:term]` |
| email | canonical redactor email matcher | `[redacted:email]` |
| phone | a candidate with 8..15 digits and at least one `+`, space, `.`, `(`, `)`, or `-`; boundary characters cannot be digits | `[redacted:account]` |
| home-path | canonical redactor Windows, git-bash, POSIX, and macOS home-path matchers | `[redacted:path]` |
| secret | canonical key/value, API-key, JWT, and opaque-token matchers | `[redacted:secret]` |
| uuid | canonical UUID matcher | `[redacted:secret]` |
| currency | canonical keyword/dollar-gated currency matchers | `[redacted:account]` |
| account-number | canonical bare 9+-digit account matcher | `[redacted:account]` |
| ip-address | IPv4 candidates `[0-9]{1,3}` four times separated by `.`, accepted only when every octet is 0..255; IPv6 colon-bearing hex candidates accepted only by Node `net.isIP(value) === 6` | `[redacted:secret]` |
| display-context | source maps to a display repo | no automatic replacement |
| capitalized-unknown | the capitalized-word rule and allowlist below | no automatic replacement |

`redactWithAudit` is added to the canonical redactor module and owns this table. It finds matches on
raw text, resolves overlap by the operation rule above, applies all replacements, and returns only
redacted text plus operations/count/risk/length metadata. Replaying the ordered operations against a
freshly re-resolved raw turn must reproduce the complete redacted result byte-for-byte; no changed
span may exist outside an operation. This is the 100-percent changed-span check.

Changed percent is `ceil(100 * changedNonWhitespace / sourceLength)`, where the numerator is the
number of raw non-whitespace code points inside the nonoverlapping operations and sourceLength is all
raw non-whitespace code points. Zero sourceLength fails. The automatic limit is configured
`maxAutomaticChangedPercent` (default 20). A changed rendition requires at least one operation and
placeholder; an unchanged rendition requires neither. Truncation, an unaccounted difference, a
placeholder/operation mismatch, or a nonempty generalization map is medium/ambiguous.

Residual risk reruns the same detector table on the reconstructed redacted rendition while treating
canonical placeholders as frozen safe tokens. Any unredacted match from the first ten detectors is
high. A canonical placeholder is evidence that its exact span was removed, not residual risk. High
risk is excluded and cannot be kept into output. Medium/ambiguous is display/unmatched source,
truncation, any non-redactor edit, changed percent above config, inconsistent audit, or a capitalized interior word not in the
closed allowlist `API`, `CSS`, `Claude`, `Codex`, `Git`, `HTML`, `HTTP`, `HTTPS`, `JavaScript`,
`JSON`, `JSONL`, `Linux`, `Node`, `SQL`, `TypeScript`, `UI`, `URL`, `Windows`, and `macOS`. The
first word of a sentence is not tested solely because it is capitalized. Medium remains private as
`needs-approval`; Slice 1 has no approval command. Residual low plus score eligibility and valid
audit is `automatic-safe`. Privacy is therefore a triage dimension, not a quick raw-input blocker,
but this slice fails closed when its bounded transform cannot establish low risk.

`capitalized-unknown` runs on the redacted rendition after Unicode NFKC. Tokens are the nonoverlapping
matches of `/\p{Lu}[\p{L}\p{M}\p{N}_'’-]*/gu`. A token is exempt only when it exactly equals one
case-sensitive allowlist entry above, begins at code-point offset zero, or the nearest preceding
non-whitespace code point is `.`, `!`, or `?`. A leading quote, opening parenthesis, comma, colon,
semicolon, slash, or line break does not create a sentence exemption by itself. Unknown all-caps
abbreviations and non-ASCII uppercase tokens are therefore medium. Fixtures pin each punctuation
boundary, combining marks, curly/straight apostrophes, hyphens, acronyms, and Unicode uppercase.

`honestweek.prompt-items.json` is version 1 with exact top keys `version`, `week`, `generatedAt`,
`outputBinding`, `policy`, `sourceStatus`, `items`, and `withheld`. `outputBinding` has exact keys
`mode`, `adapterHash`, and `objectives`; it records `page` plus a null hash, or `site` plus SHA-256
over the normalized adapter path and its bytes, and records `objectives:false` in Slice 1. Validation
recomputes this binding so a mode, adapter path/content, or objectives-state change fails loudly
without persisting a private path. A successful one-source curation records and prints
both source states, and each visible prompt summary includes the fixed coverage clause `Coverage:
Claude Code <present|absent>; Codex <present|absent>.` It never labels the result a complete
cross-tool week when one source is absent. `policy` has exact keys `version`,
`automaticMinScore`, `automaticCap`, `weights`, `maxAutomaticChangedPercent`, and `publicRenditionsEnabled`.
`weights` has only the six prompt-applicable signal-code keys above, copied from the validated full
`curation.weights` object. `sourceStatus` deep-equals the just-completed
private-store status. `withheld` has every exact withheld-reason key above with nonnegative integer
counts. It is gitignored and atomically written. Each item
has the existing build fields plus exact lane metadata:

```json
{
  "id": "prompt-<full-itemRef>",
  "itemRef": "<full-itemRef>",
  "evidenceRefs": ["<full-ref>"],
  "kind": "prompt",
  "category": "prompts",
  "week": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "curationState": "automatic|kept",
  "publicDisposition": "automatic-safe",
  "status": "",
  "project": "Prompt highlights",
  "repo": null,
  "date": "YYYY-MM-DD",
  "title": "<bounded public-safe excerpt>",
  "summary": "Why it surfaced: <fixed reason>. Coverage: Claude Code <present|absent>; Codex <present|absent>.",
  "receipt": { "sessionId": "<sessionKey>", "ref": "<full-ref>", "turn": 1 },
  "snippets": [
    { "kind": "prompt", "source": "public-safe rendition", "text": "<complete public-safe rendition>", "provenance": "validated-rendition" },
    { "kind": "source", "source": "Claude Code|Codex", "text": "session <short-session> turn <n>", "provenance": "transcript-receipt" }
  ],
  "selection": { "score": 2, "reasonCodes": ["observed-verification"], "reason": "followed by observed verification" },
  "privacy": {
    "sourceRef": "<full-ref>",
    "sourceContentHash": "<private redacted contentHash>",
    "renditionHash": "<sha256 of exact rendition>",
    "transform": "none|redaction",
    "changedPercent": 0,
    "rawRisk": "low|medium|high",
    "residualRisk": "low",
    "decision": "automatic-safe",
    "policyVersion": 1
  }
}
```

`withheld` contains counts only, never refs or text. Prompt item validation rejects unknown keys,
invalid receipt/ref/hash/score/reason/privacy combinations, non-low risk, non-automatic-safe status,
any status other than the exact empty no-work-badge value, any project/repo/date/title/summary/snippet
that does not reconstruct from the validated source and fixed policy, more automatic items than the
persisted configured `automaticCap`,
or a kept item whose private state is not kept. It
opens the private store and re-resolves each source turn before any Git read or output write, then
requires matching sourceHash, sessionKey, turn, sourceContentHash, week, safe source classification,
current redaction, and exact rendition. Missing, stale, unreadable, malformed, or mismatched evidence
aborts exit 2 with no output.

Curated identity is separate from evidence identity. Sort the complete evidence-ref array by raw
ASCII bytes, then form `itemCanonical = category + NUL + refs joined by NUL + NUL + discriminator`.
For Slice 1 the exact values are category `prompts`, the one-element prompt ref array, and
discriminator `prompt`, so the bytes are `prompts + NUL + evidenceRef + NUL + prompt`.
`itemRef = sha256(itemCanonical)` and presentation `id = "prompt-" + itemRef`. The canonical string
never persists, but validation recomputes the digest. Wording, score, state, and privacy policy never
enter identity. `week` must equal the lane week; `curationState` is `kept` only when the private
source state is kept, otherwise `automatic`; `publicDisposition` is exactly `automatic-safe`.

Before any Git read or output write, validate and build perform a full read-only rescan of every
present weekly source root, merge the current private keep/hide/tombstone controls in memory, rerun
redaction audit, privacy, scoring, ordering, and selection over the complete evidence set, and
reconstruct the canonical lane. They normalize only top-level `generatedAt` and each source
`syncedAt` to one clock sentinel, then require a deep equality with the persisted lane. New prompts,
changed controls/config, omitted higher-ranked candidates, changed ordering, stale source status,
or tampered withheld counts therefore abort exit 2 with `rerun honestweek prompts curate`; the
read-only check changes no sidecar.

The visible title is at most 160 Unicode code points. A rendition at or below the limit is exact. A
longer rendition is cut after the last whitespace at or before code point 159 (or at 159 when none),
trailing whitespace is removed, and the single Unicode ellipsis `…` is appended. This is a labelled
display excerpt, not a privacy transformation. The first detail snippet carries the complete
public-safe rendition, capped by the private store's 4000-code-point limit. Validation reconstructs
both representations and hashes the complete rendition; arbitrary truncation or hidden text fails.

The prompt lane never cites commits and never triggers a Git read. Existing work items retain their
current verification behavior. The committed target transform already accepts a commit-less,
generalized item with `project`, `date`, `title`, `summary`, and `snippets`; its report component
renders the transcript receipt in the existing detail drawer. The slice therefore needs no target
repository write. Standalone `page` gains the same prompt-only no-badge and transcript-drawer branch.
No prompt passes through a work badge, commit receipt, goal join, or commit metric. The fixed summary
carries the disclosed reason because the target transform already renders it.

## Controller, evidence, and stop conditions

The controller advances only after these checks are green:

1. Clean-room Claude and Codex roots each contribute accepted human prompts while every named
   control/tool/reasoning/subagent form contributes zero.
2. Identity, cross-week turn stability, source ordering, collision seams, path containment, Windows
   and POSIX mapping, redaction-before-cap, source/content migration, and atomic fault points pass.
3. List/keep/hide/delete round-trip; a tombstone cannot regenerate; stdout/stderr/temp/store contain
   no raw configured token, session id, path, email, or secret.
4. Fixed scoring fixtures pin selected, below-floor, capacity, kept, hidden, private, medium, and
   high-risk outcomes plus exact reason counts/order. A prompt with no lexical cue surfaces from
   observed verification or cross-session subject recurrence; multi-keyword boilerplate remains
   ineligible without non-lexical evidence. Three safe keeps all render before the default two-item
   automatic cap and disclose excess. Non-default floor 3 and prompt caps 0 and 4 are pinned.
5. Privacy fixtures pin every detector/placeholder pair, overlap priority, no-edit, default 20-percent
   edit, 21-percent boundary, non-default limit, 100-percent replay, audit mismatch, truncation,
   secret residual, valid/invalid IPv4, compressed/full IPv6, display/private source, and capitalized
   ambiguity. Only low-risk items reach the lane file.
6. `validate` and `build` accept clean prompt items, reject tampering before Git/output, and preserve
   the old output on any lane failure. Full-rescan fixtures add a prompt, change keep to hide, change
   a weight, omit a higher-ranked candidate, reorder rows, and tamper with withheld counts; every
   stale lane aborts before Git and asks for a fresh curate.
7. End-to-end `page` and `site` fixtures show the selected prompt and source receipt through the
   existing emitter/adapter grammar. The site fixture mirrors the committed target transform's
   item/snippet join without copying target-specific prose. Lane absent and empty are byte-identical
   across all six modes; a nonempty lane under the four non-page modes fails preflight with no output.
   Tests also change mode, objectives-registry presence, and adapter path after curation. The local release
   gate additionally imports the actual configured target transform read-only, sends the generated
   verified bundle through it in memory, and asserts `Prompt highlights`, null/no badge, the fixed
   reason and coverage text, and both rendition/receipt snippets in the returned artifact. A
   read-only source assertion confirms the target component renders generic groups/items/snippets.
   This gate writes no target file. An unavailable configured target blocks Slice 1 release and
   completion, though implementation checks may continue. The exact report is `target compatibility:
   BLOCKED - configured adapter or report component unavailable at <redacted path>; no target file
   written`.
8. Spies prove prompt ingestion/curation reads no Git and all paths make no network/publish call.
9. README, SKILL, help, gitignore patterns, Node 18 APIs, `node --test`, verifier suite, and final
   review loop are clean.

Stop immediately on an unresolved receipt, stale or mixed source status, collision/canonical
mismatch, raw-before-redaction write, private/display page row, unverifiable transformation,
unexplained selection, Git read caused by a prompt, existing artifact divergence without a valid
lane input, partial output write, Node/cross-platform failure, or non-clean review verdict.
