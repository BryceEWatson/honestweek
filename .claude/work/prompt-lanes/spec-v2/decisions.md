# Prompt lanes: settled decisions (v2)

Authoritative for every phase spec. A phase spec **references a decision by id** and never restates
its wording. If a phase spec and this file disagree, this file wins and the phase spec is a defect.

Paths are repo-relative. Line references are checked mechanically by `verify-refs.mjs`; a stale one
is a build-the-spec failure, not a nit.

## In plain terms

honestweek reads a week of AI coding sessions and writes an honest summary of the work. We are
adding two more things to that summary: the ways of asking that measurably worked, and the ideas
that came up but have not been done yet. The hard part is that "this prompt worked well" is exactly
the kind of unprovable claim the tool exists to refuse, so the deterministic engine computes the
evidence and the model's only job is to give the technique a name. This file settles the decisions
that more than one phase depends on. A prior version of this plan failed review three times, and
almost every defect was a place where two phases needed the same answer and each invented its own.

---

## D1 — Phase decomposition (re-decided)

The previous 1/2/3 split is **rejected**. Cross-phase consistency returned
`implementationOrderIsSound: false`, and the reason is structural, not editorial: phase 3 consumed
identifiers phase 1 never minted, phase 3 re-litigated render policy phase 2 had already written,
and phase 3 bundled the within-week band together with the cross-week state machine, which is the
single most defect-dense area in the plan.

**Four phases.**

| Phase | Name | Ships | Renders anything? |
| --- | --- | --- | --- |
| 1 | Evidence substrate | Turn windows, idea cues, refs for **all four** origins, handoff next-steps, the prompts sidecar, the config key, redact-before-truncate, the hermetic golden harness | **No.** Zero rendered bytes change. |
| 2 | Lane substrate + Lane A | Taxonomy, the one pill primitive, the attach point, receipt rendering, the gate policy, the copy gate, the noun check, the **final** contract-string wording, then Lane A rows | Yes |
| 3 | Lane B, within-week | `forward[]` from ideas + handoff next-steps + handoff reversals, dispositions, `dispositionAsOf`. Closes #52 items 4 and 5 | Yes |
| 4 | Cross-week carry | `honestweek.forward-index.json`, deferred rows, the zombie rule, carry re-gating | Yes |

Why this split and not the old one:

- **Phase 1 renders nothing.** That makes its strongest claim (Layer 1 strict byte-identity) trivially
  provable rather than argued, and it is the phase that must mint every identifier later phases key
  on. Handoff-line refs, which the old plan needed in phase 3 and minted nowhere, are phase 1 work.
- **Phase 2 owns every rendering policy, authored once at its final wording.** The old plan had
  phase 2 and phase 3 each re-authoring the same three contract strings and the SKILL rule count.
  Phase 3 now adds a vocabulary instantiation, never a rewording.
- **Phase 4 is split out** because cross-week carry is the only work needing state that survives a
  build, it carries five of its own blockers, it needs multi-week fixtures nothing else needs, and
  Lane B is fully useful without it. A defect there must not strand #52 items 4 and 5.

Closes: items 26, 28, 29, 35, 41, 44, 51 structurally.

---

## D2 — A slash-command boundary is defined by content, never by opening tag

**Decision.** A user string record that is machine-envelope-only is a turn boundary of kind
`command` **iff its content contains a well-formed `<command-name>…</command-name>` block**. The
window's instruction text is that block's inner text. Never `<command-args>` (may hold secrets),
never `<command-message>`.

**Why.** The old rule keyed the branch on the record's *opening* tag being `command-name`. Measured
twice, independently, over `~/.claude/projects`:

| Measurement | `command-message` opens | `command-name` opens |
| --- | --- | --- |
| Prior session, 300 files, 757 string user turns | 43 | 6 |
| This session, a different 300-file slice, 432 string user turns | 24 | 1 |

Both slices agree on direction by more than an order of magnitude. The repo's own committed fixture
`test/fixtures/claude-projects/proj-automated/sessE.jsonl` is the common shape
(`<command-message>` first, then `<command-name>`). Under the old rule the overwhelming majority of
real slash-command turns open no window, and the proposed acceptance fixture used the rare shape, so
the suite would have gone green over a dead branch.

**Enforcement.** At least one acceptance fixture is byte-shaped like `sessE.jsonl` and asserts
exactly one window of kind `command` whose instruction text is the `command-name` inner text.
Another asserts a `<command-args>` value never appears in the draft or the sidecar.

Closes: item 2.

---

## D3 — `turns[]` holds one record per boundary; the cap bounds *grading*, not records

**Decision.** Rename the constant to `MAX_GRADED_TURNS` (= 400). `turns[]` carries one record per
turn boundary. Boundaries past the cap are **stubs**: `{ index, stub: true, complete: false }` and
nothing else. So a synthetic session with 500 boundaries yields:

```
turns.length                      === 500
turns.filter(t => !t.stub).length === 400
entry.truncatedAtTurn             === 400
turns[400..499]  each deepEqual   { index: n, stub: true, complete: false }
```

**Why.** The old criterion asserted `turns.length === 400` *and* the presence of every past-cap stub
in `turns[]`. Those cannot both hold. An agent satisfying the length assertion drops the stubs, which
reinstates the exact inverted-bias trap the stub rule exists to close (a long session silently looks
like a short clean one). The old constant name `MAX_TURNS` is what invited the misreading.

**Downstream.** Phase 2's fail-closed rule is restated as: a shapeKey group does not receive the
`repeated without correction` grade if **any session contributing a window to that group has
`truncatedAtTurn !== null`**. The old clause "if any window carrying that shapeKey is a stub" is
deleted as vacuous — stubs carry no `shapeKey` field.

Closes: items 1, 28.

---

## D4 — The no-prose scan is a per-shape whitelist, with no catch-all clause

**Decision.** The structural privacy assertion is:

- (a) a stub window `deepEqual`s `{ index: number, stub: true, complete: false }`;
- (b) a non-stub window has **exactly** the 14 specified keys;
- (c) each string value matches its own key's rule:
  - `ref`, `shapeKey` → `/^[0-9a-f]{8}$/`
  - `kind` → `'prose' | 'command'`
  - `correctionObserved` → `'yes' | 'no' | 'unknown'`
  - `statusSignals[]`, `testSignals[]` → members of the `deriveStatus` token set
  - `commitShas[]`, `inspectedShas[]` → `/^[0-9a-f]{7,40}$/` **only**
  - `toolsUsed` → an object whose keys are tool-name-shaped and whose values are numbers
- (d) an idea is exactly `{ turn, ref, origin, cue }`, `origin ∈ ['you','assistant']`,
  `cue ∈ IDEA_CUES`, `turn` a number **or `null`** (see D26).

No "or an 8-hex value" catch-all anywhere. This is the assertion the `promptVerbatim` probe would
have failed, so it may not be loosened to make another criterion pass.

**Why.** The old single-sentence version was unsatisfiable against two other requirements: commit
SHAs are 7 or 40 hex chars and fail `/^[0-9a-f]{8}$/`, and stubs carry 3 keys, not 14.

Closes: item 3.

---

## D5 — Ref algebra: identity only, never text; four origins, one function

**Decision.** `lib/lanes.mjs` exports one ref minter:

```js
refFor({ kind, sessionId, handoffId, index })
// kind ∈ 'turn' | 'idea' | 'handoff-next-step' | 'handoff-reversal'
// canonical string: `${kind}\u0000${sessionId ?? handoffId}\u0000${index}`
// → 8-hex FNV-1a
```

**Text is not an input.** This is a change from both prior drafts and it is strictly better on three
axes at once:

1. **Privacy.** The old ref hashed the redacted text and was published beside the same row's
   `{ sessionId, turn }`, making it a one-hash confirmation oracle over prose the redactor was the
   last line on. With text out of the input, that oracle does not exist.
2. **Stability.** The cross-week carry (D12) and the zombie rule key on `ref`. A text-derived ref
   changes when the redaction config changes, silently orphaning every carried row.
3. **Coverage.** Handoff lines have no `sessionId` and no `turnIndex`, so the old signature could not
   produce a ref for them at all — which is why the two origins that actually deliver #52 items 4 and
   5 had no resolvable key.

Collisions across kinds are prevented by `kind` being in the canonical string. Two handoffs carrying
byte-identical reversal lines get distinct refs because `handoffId` and `index` differ.

**Emission.** Phase 1 emits refs on: each turn window, each idea, each `handoffs[].nextSteps[]`
entry, each `handoffs[].reversals[]` entry. The last two are emitted as **new sibling arrays**
(`nextSteps: [{ ref, text }]`, `reversalRefs: [{ ref, text }]`) so that `handoffs[].reversals` keeps
its existing bare-string shape and the draft-superset test (D22) still passes.

**Publication.** `ref` is local state. It is stripped before emit and before `writeArchive`. The
acceptance criterion is rewritten to **"no `ref` value appears in any rendered artifact or archive
snapshot"** — not the old "no 8-hex value that is not a git shortSha", which fails against
pre-existing correct behaviour (`receipt.sessionId` is 8 hex and is published today, by design).

Closes: items 5 (ref half), 21, 23 (ref half), 26, 37, 53, 55.

---

## D6 — Forward-band presence is authored rows **union** engine-derived rows

**Decision.** One presence rule, stated once:

```
forwardPresent = (authoredForwardRows.length + engineForwardRows.length) > 0
```

where `engineForwardRows` = handoff next-steps + handoff reversals discovered for the week (subject
to D7's narrowing). A lane array is *present* iff `Array.isArray(x) && x.length > 0`; that single
definition is used by the gate and by the render alike.

Consequences, written down rather than implied:

- A week where the model authors **no** `forward` key at all but whose handoffs carry reversals
  **does** render the forward band. That is what closes #52 item 5 and README.md:12's "the dead ends
  you ruled out".
- The Layer 1 byte-identity criterion is therefore restated as: **for a fixture week with no
  authored `forward` key, no handoff reversals and no handoff next-steps**, every emitted byte is
  identical to the pre-change build. A dedicated frozen fixture corpus (D19) satisfies this.
- The copy gate, the noun check and the ref-resolution gate fire on **authored** rows. Engine rows
  get D7's gate set instead.

**Why.** The old plan simultaneously required mined reversals to render "independent of whether any
authored item cites it" and required byte-identity whenever the authored `forward` key was absent.
Both could not hold, and in the common week (model authors nothing forward-looking) the reversals
rendered nothing, leaving the residual failure the phase claimed to have fixed.

Closes: items 18, 42, 54.

---

## D7 — Engine-sourced forward prose passes the same gates as authored prose, from a narrower source

**Decision, two parts.**

**Narrow the source.** Only lines inside a section matched by `REVERSAL_HEADING_RE` may become a
rendered row. The free-floating `REVERSAL_LINE_RE` branch at `lib/handoffs.mjs:88` stays
**draft-only** and never reaches a rendered artifact.

**Gate the text.** Before an engine-sourced forward row can render, its text passes, and aborts or
drops under the same rules as authored prose:

- the P5 `harvestNouns` / `excludeSet` unconfigured-noun check (D14)
- the configured-private-term check
- the display-role repo naming check (D32)
- `checkVoice`, as its own keyed collection in the object `build` scans

**Why.** This is the first path in the codebase from handoff prose to a rendered artifact. Measured:
nothing in `lib/emit` or `lib/site` reads `handoffs[].claims` or `.reversals`, so no handoff prose is
published today. The old plan justified rendering it raw by analogy to `claims[]` — a false
equivalence, since `claims[]` is also unpublished. `REVERSAL_LINE_RE`
(`/\b(revers|reverted|rolled back|don'?t resurrect|corrected)\b/i`) matches **any** line anywhere in
a handoff, so an ordinary line such as "corrected the invoice before the call" would publish.

**Negative control.** An unconfigured private noun placed inside a handoff reversal line appears in
no rendered artifact and in no archive snapshot.

Closes: items 20, 32.

---

## D8 — Every lane row renders its receipt; invariant 1 is satisfied, not narrowed

**Decision.** Every lane row renders a **transcript receipt** in all three rendering modes: the
8-hex session id plus the turn index for a transcript-sourced row, or the handoff id for a
handoff-sourced row. It is styled distinctly from a git SHA (a leading `session ` / `handoff ` label
in markdown, a separate CSS class in HTML) so it cannot be misread as a commit.

`AGENTS.md:40` and `README.md:294` are then restated to the **stronger and true** form:

> A git receipt on every work line; a transcript receipt on every lane line.

not the old scoping ("receipt on every line applies only to work items"), which reworded a launch
promise instead of satisfying it.

**Why.** README.md:283-285 names this as one of honestweek's two non-negotiable promises. Every lane
row already carries a resolvable pointer. Rendering it costs one line and keeps the invariant intact.

Closes: items 43, 51 (invariant 1 half).

---

## D9 — Grade labels name the observation, never the outcome

**Decision.**

```js
export const TECHNIQUE_GRADES = [
  'no correction observed',
  'repeated without correction',
  'correction observed',
];
```

Each row additionally renders a one-clause **evidence line** naming the literal signals behind the
grade, for example `tests went failing to passing in the same window` or `3 windows, same shape, no
correction`.

**Why.** The field name was already correct (`repeatedOpenings`, not `techniqueRecurrence`), and then
the render undid it: labels reading "worked first time" and "held up" assert an outcome, when what
was measured is "no correction in the next window, plus a typed test flip". That is a proxy
borrowing the construct's name at the label layer, which is the specific error this whole design
exists to avoid.

Closes: item 45.

---

## D10 — Two lane failure classes: drop loudly, or abort

**Decision.**

| Class | Behaviour |
| --- | --- |
| **Corpus-absent / unresolvable** — the session-log root yields zero files; a row's `ref` matches no record; the carry index is absent or unparseable; a commit lookup throws | **Drop the affected band or rows loudly.** stderr names the band, the reason, the count dropped, and the `--no-lanes` flag verbatim. The work report is still emitted. Exit 0. |
| **Positive dishonesty hit** — copy gate hit, display-role repo named, configured redaction term survived, `strictLaneNouns` noun hit | **Exit 2, write nothing.** |

Plus a real `--no-lanes` flag on `build` and `validate`. Every lane message names it verbatim.

**Why.** Under the old plan every lane failure was whole-build fatal. It is Sunday night, the
scheduled run hits a week whose `~/.claude` logs were pruned (or a second machine, or after
`git clean -xfd`), and the operator loses the entire work report because of an optional bonus band —
with the only documented recovery being to hand-edit `honestweek.items.json` and delete two keys.
Dropping an uncheckable row is the under-claim direction the engine already takes for ungraded
windows. Verify-or-abort is preserved exactly where it means something: a positive hit.

Closes: items 14, 24 (behaviour half), 46.

---

## D11 — Lanes attach after `assembleReportModel`, before `deepRedact`, in both branches

**Decision.** Lane keys are attached to the model object **after `assembleReportModel` returns and
before `redactor.deepRedact`**, in the page branch and the markdown branch alike. Never inside
`assembleReportModel`. Never on the site path.

Measured: `lib/build.mjs` markdown branch is `redactedForArchive = redactor.deepRedact(model)` then
`emit(redactedForArchive, config, { cwd })`. Attaching at or after that line puts lane prose into the
emitted file **and** into the archive snapshot without ever passing the `deepRedact` backstop, while
the page branch (which redacts after `buildPageModel`) would redact it — a mode-dependent redaction
hole.

**Acceptance.** A configured redaction term placed inside a technique text and inside a forward text
is scrubbed in `digest`, `report`, `page` **and** the archive snapshot. A test asserts
`augmentSiteModel`'s input and return contain no `techniques` and no `forward` key.

Closes: item 29.

---

## D12 — The carry index is cumulative, self-contained, engine-written, and re-gated on read

**Decision.** `honestweek.forward-index.json`, gitignored local state (Layer 0, so prose is
permitted):

```jsonc
{
  "version": 1,
  "weeks": [
    {
      "week": { "start": "…", "end": "…" },
      "entries": [
        { "ref": "…", "id": "forward-…", "text": "…", "origin": "…",
          "receipt": { … }, "disposition": "…", "dispositionAsOf": "…",
          "firstSeenWeek": "…", "repo": "…" }
      ]
    }
  ]
}
```

Four rules follow from it:

1. **Week N renders a carried row from the index, never from the archive snapshot.** The snapshot has
   the text but no `ref` (D5); the index has both. There is no other join.
2. **Cumulative, not single-week.** The zombie rule ranges over "any prior entry", so a single-week
   overwritten file cannot support it. `weeks[]` is append-and-replace-this-week.
3. **Engine-written only, and still untrusted on read.** `build` writes it and never trusts it: every
   carried row is re-run at build time through the display-repo check, the configured-private-term
   check, the P5 noun check and the copy gate, against the **current** config and corpus. Carried
   rows are exempt from the current-week receipt-resolution rule by a named, tested branch (a week
   N-1 session does not resolve in week N).
4. **Absent or unparseable is not fatal** — drop the carried rows loudly per D10.

**Acceptance.** A week-1 `not started` ref renders `deferred` in week 2, its rendered text
byte-equal to week 1's, and its shown originating week equal to week 1's start.

Closes: items 19, 22, 27, 33, 34.

---

## D13 — `config.redaction.strictLaneNouns` is a real loader key, added in Phase 1

**Decision.** `lib/config.mjs` normalizes `redaction.strictLaneNouns` as an optional boolean
defaulting `false`, failing loud on a non-boolean, exactly mirroring the `voice.denyMeta` branch.
`lib/config.mjs` and `test/config.test.mjs` join **Phase 1**'s `filesTouched`. README gains a
config-table row. A `test/config.test.mjs` assertion pins that the key survives `loadConfig`.

Measured: `lib/config.mjs` rebuilds `redaction` as exactly `{ codenames, names, terms }` and silently
drops every other key, and it does not fail loud, because the only `fail()` on that path fires when
`redaction` is not an object. Under the old plan the flag was unreachable and an acceptance criterion
depending on it could never pass.

It lands in Phase 1 rather than Phase 2 because it is a pure loader change with no lane semantics;
parking it beside its consumer is what made it unreachable.

Closes: items 10, 50.

---

## D14 — The unconfigured-noun check is quiet by default and summarized, not per-item spam

**Decision.** `lib/harvest.mjs` exports its today-private `excludeSet(config)` beside the already
public `harvestNouns(text, { exclude })`. Both are called from `validate` and from `build`'s lane
gate over each technique and forward `text`.

- **Default posture: warn**, emitted as **one summary line** naming the distinct-token count and the
  top few tokens, never one line per item, and never echoing the offending text.
- `excludeSet` is seeded with a shipped baseline of tokens that would otherwise fire constantly:
  `Claude`, `Node`, `Windows`, `macOS`, `Linux`, `Git`, `GitHub`, `JSON`, `README`, `CI`.
- `config.redaction.strictLaneNouns: true` (D13) promotes the warning to exit 2.

**Why.** `harvestNouns`'s `isCandidate` matches any single capitalized word, and the plan itself
conceded those tokens "would fire constantly". A per-item warning the operator cannot clear and
should not act on trains them to ignore the one that matters.

Closes: items 48, and the P5 half of 20 and 32.

---

## D15 — Lane bands render in `digest`, `report`, `page` and `post`; the gate runs in every mode

**Decision.** Lane A and Lane B bands render in `digest`, `report`, `page` and `post`. `changelog`
stays work-only. The lane **gate** runs in every mode, including `site` and `changelog`, so there is
no mode in which the privacy gate is off.

**Why.** `post` is the build-in-public update and the most natural home for "prompts that worked";
under the old plan `post` paid every lane cost (an extra transcript scan, the copy gate, a possible
exit 2) and rendered nothing.

The `site` byte-identity criterion requires a **valid** lane corpus present (hermetic fixture, same
week) so the gate passes and byte-identity is a real assertion about the site path ignoring lane
keys, rather than an artifact of the build having aborted.

Closes: item 49.

---

## D16 — Contract strings and SKILL rule numbering are authored once, at final wording, in Phase 2

**Decision.** Phase 2 authors the **final** wording for all three rendered contract strings
(`lib/emit/digest.mjs`'s "Every line carries a status badge and a receipt.", `lib/emit/page.mjs`'s
foot div, and the `README.md` "## Sample output" slice) against a **four-way presence matrix**:
neither lane / Lane A only / Lane B only / both. Every branch is pinned by a test in Phase 2. Phase 3
adds rows to the band; it adds **no wording**.

Likewise Phase 2 reserves and writes **both** SKILL.md rules 7 (technique item shape) and 8 (forward
item shape) and updates `test/skill.test.mjs`'s name and count **once**. Phase 3 fills rule 8's body
without renumbering.

Closes: items 35, 41.

---

## D17 — `AGENTS.md` is in scope, and both affected invariants are strengthened, not narrowed

**Decision.** `AGENTS.md` joins Phase 1's and Phase 2's `filesTouched`.

- **Invariant 1** is restated per D8 — a git receipt on every work line, a transcript receipt on
  every lane line. It gets stronger, not scoped away.
- **Invariant 6** ("absent its new inputs, existing output stays byte-identical") is restated with
  the Layer 0 split: **rendered artifacts** strictly byte-identical; **local-state artifacts**
  (`honestweek.draft.json`, `honestweek.prompts.json`, `honestweek.harvest.json`,
  `honestweek.forward-index.json`) additive-superset, with Layer 2b's redact-before-truncate reorder
  named as the one deliberate exception.

**Why.** `AGENTS.md` is the constitution Codex reads before changing anything. Under the old plan it
appeared in no phase's `filesTouched` while two of its six invariants were made false, so an
implementer reading only `AGENTS.md` had to either block phase 1 or knowingly break a stated
invariant.

Closes: items 44, 51.

---

## D18 — SKILL.md names the sidecar as a DISTIL input and states the eligibility predicate

**Decision.** Phase 2's docs requirement:

- SKILL.md **step 2** gains `honestweek.prompts.json` as a second `discover` output (gitignored,
  source-faithful after redaction, local-only).
- SKILL.md **step 3 DISTIL** gains it as a second **input**, with a one-line rule: *read it to
  understand what you asked for; name the technique in your own words; never copy a run of words
  from it.*
- SKILL.md **step 4** gains the new abort classes and the `--no-lanes` off-ramp.
- Rule 7 states the **eligibility predicate** and names the draft turn fields carrying it (`stub`,
  `complete`, `kind`, `shapeKey`, `correctionObserved`, `testSignals`, `commitShas`), plus an
  explicit instruction to omit a technique whose only evidence is an unverified commit SHA.
- Rule 8 states that a forward row's `ref` is copied verbatim from a draft record.
- The orchestrator runs `build --explain-lanes` once after discover and before DISTIL authors lane
  rows. Its read-only gradeable-window list is an explicit DISTIL input, so authoring is informed
  rather than a retry loop at one full transcript scan per attempt.
- `test/skill.test.mjs` asserts DISTIL's input list names both files.

**Why.** Phase 1 strips all free text out of the draft's `turns[]`/`ideas[]`, so under the old docs
the model had no instructed source from which to author a technique at all. Rule 7 forbade copying
from the sidecar without ever instructing the model to read it.

Closes: items 47, 52.

---

## D19 — The golden harness is hermetic, and the frozen corpus is separate from new fixtures

**Decision.**

- The harness sets `CLAUDE_CONFIG_DIR` to a fixture root for its own process, passes a **fixed
  `now`** into `runBuild`, and points `config.repos` at a throwaway git repo built in-test with
  pinned author name, author email and both commit dates (the `test/refuses-to-lie.test.mjs`
  pattern), so SHAs are reproducible.
- The **byte-identity control corpus is frozen**: `test/fixtures/claude-projects/golden/`. It gains
  no new sessions, has no handoff reversals and no handoff next-steps (D6), and no over-length mined
  string (so Layer 2b's fixture byte-identity gate is labelled as the weak control it is).
- **New fixtures live under their own project roots** and are used only by their own tests.

**Why.** `lib/build.mjs`'s page and site paths call `deriveSessions` and `augmentSiteModel` with no
`projectsRoot` override, so golden bytes were a function of whichever session logs existed on the
machine — zero on CI, non-zero locally. And without the frozen/new split, the new fixtures required
by the lane tests would have invalidated the very goldens three phases assert against.

Closes: items 12, 38.

---

## D20 — Sidecar shape, bounds, and what a truncated sidecar does and does not weaken

**Decision.**

- Shape: `{ generatedAt, week: { start, end }, prompts: [{ ref, sessionId, turn, text }],
  ideas: [{ ref, sessionId, turn, origin, cue, text }] }`. **Two separate arrays**, written from two
  separate sinks — never one array discriminated by the presence of a key.
- `MAX_PROMPT_LEN` = 4000 characters per `text`, applied **after** redaction (D-2b ordering).
- `MAX_SIDECAR_BYTES` = 8 MiB bounds the **written file**. Enforcement is explicit: stop appending
  once the next entry would exceed the budget, set `truncated: true`, and report the dropped count on
  stdout. Counts only, never text.
- **`build` does not read the sidecar.** It re-derives its own corpus from the session logs and
  indexes normalized n-grams rather than holding text, so build's copy gate is complete even when the
  written sidecar was truncated.
- `validate` **does** read the sidecar. When `truncated` is true, validate says so and states plainly
  that its copy gate is partial while build's remains authoritative.

**Gitignore ordering.** `discover` appends the ignore lines for `honestweek.prompts.json` **and**
`honestweek.harvest.json` **before** writing either file. `lib/init.mjs` ensures both. Both go in the
repo's committed `.gitignore`. Measured: today `discover` writes the draft and only then calls
`ensureDraftGitignored`, and `honestweek.harvest.json` is a pre-existing gap.

Closes: items 6, 7.

---

## D21 — `MAX_IDEAS` is two named constants, because it is two different bounds

**Decision.** `MAX_IDEAS_PER_WINDOW` and `MAX_IDEAS_PER_SESSION`, both named in the `complete: false`
enumeration with the scope each one bounds.

**Why.** The old single `MAX_IDEAS` was enumerated as a window-local evidence bound while being
enforced session-wide, which reintroduces in miniature the structural bias the enumeration exists to
remove: late windows in a long session look idea-free because an earlier window used the budget.

Closes: item 4.

---

## D22 — "Pre-change value" is a committed baseline artifact, not an instruction to remember

**Decision.** Phase 1 commits `test/fixtures/golden/draft-baseline.json`, generated from the
**pre-change** `discover` over the frozen corpus, in the same PR. The DRAFT SUPERSET test
`deepEqual`s each pre-existing key against that file. The REDACTION ORDER criterion likewise names
its exact source string and both expected lengths rather than the bare numbers `279` and `281`.

**Why.** Two load-bearing criteria compared against "its pre-change value" with no requirement
telling anyone to capture one. That is a step gated on someone remembering to do it first, which is
the defect class that gets dropped.

Closes: items 5, 9.

---

## D23 — Windows carry a `repoKey`, not a repo path, and that is how a SHA gets resolved

**Decision.** A turn window carries `repoKey`, an index into `config.repos`. `resolveCommit(sha,
config.repos[repoKey])` is the resolution path, using the same `lib/git.mjs` entry point
`verifyItems` uses.

**Why.** Both lanes need to resolve a commit "in the session's repo", but `adaptOneSession` emits
`repo: repo.label` — a label string — and carries no path, and no phase defined `resolveCommit`'s
signature. An index avoids putting a machine-local absolute path into an artifact at all.

Closes: item 31.

---

## D24 — A throwing commit lookup is an unresolved commit

**Decision.** `lib/git.mjs`'s `lookupCommit` throws when `repoPath` is not a usable git repository —
a routine state. Every lane call site catches it, treats the SHA as unresolved, and falls back to the
under-claim default (`not started` for a forward row, ungraded for a technique), reporting it under
D10's drop-loudly channel.

Closes: item 24.

---

## D25 — Lane rows never touch `total`, and the no-sessions line stops contradicting itself

**Decision.** `lib/emit/index.mjs`'s `itemCount` and `lib/archive.mjs`'s `countItems` keep counting
**work items only**. Lane rows are reported as their own separate numbers.

The "_No interactive coding sessions_" line's condition becomes **no work items *and* no lane rows**.
When lane rows exist but no work items, the emitter prints a scoped line naming what is present
instead. Bytes change only when lane rows are present, so Layer 1 holds.

**Why.** The old rule required a week with only lane rows to still print "no interactive coding
sessions" directly above a band of rows mined from interactive coding sessions.

Closes: item 11.

---

## D26 — An idea before the first turn boundary is `turn: null`, and every consumer handles it

**Decision.** An idea mined from a block before the first boundary carries `turn: null`. Its ref is
`refFor({ kind: 'idea', sessionId, index })` where `index` is its ordinal among pre-boundary ideas,
offset into a reserved negative range so it cannot collide with a windowed idea. Phase 3's forward
row accepts `turn: null` and renders a session-only receipt (D8).

Closes: item 37.

---

## D27 — `opensWithCorrection` is defined, and `correctionObserved` is derived from it

**Decision.** `opensWithCorrection` is true iff the window's own instruction text matches
`CORRECTION_RE` (a closed, tested pattern list). `correctionObserved` for window *i* is:

- `'yes'` if window *i+1* exists and `turns[i+1].opensWithCorrection` is true;
- `'no'` if window *i+1* exists and it is false;
- `'unknown'` if window *i* is the last window, or window *i+1* is a stub.

Both fields, and the link between them, are stated in one place.

Closes: item 36.

---

## D28 — The lane corpus is re-derived once per build and shared

**Decision.** When either lane is present, `build` calls `adaptSessions` and `discoverHandoffs`
**once**, and both lanes read that result. No phase may add a second scan.

Closes: item 39.

---

## D29 — `forwardOpen` is a conditional field

**Decision.** `lib/archive.mjs`'s index entry gains `forwardOpen` via a conditional spread, present
only when the forward band is present. `writeArchive` pushes a fixed-shape entry today, so an
unconditional field would change `archive/index.json` bytes for every archive-enabled user with no
forward band.

Closes: item 40.

---

## D30 — The copy gate's run length has a floor of 4 and a measured false-positive check

**Decision.** `sharesRun(authored, corpusStrings)`: normalize both sides (lowercase, collapse
whitespace, strip punctuation); let `w` = authored word count; hit iff

- the whole normalized authored string occurs as a substring of a corpus string **and** `w >= 4`, or
- any run of `n = min(8, max(4, ceil(0.6 * w)))` consecutive authored words occurs in a corpus string.

The test plan includes a **measured** false-positive check: a list of ordinary technique names
(`"ask for the failing test first"`, `"two-pass review"`, `"name the invariant before the fix"`) run
against the frozen fixture corpus, asserting no hit.

**Why.** The floor of 3 rejects a 5-word technique name if any 3 consecutive words occur anywhere in
a week's prompt corpus, which makes lane authoring a guessing loop. The floor of 4 with containment
gated at 4 words keeps the gate meaningful without that. If the measured check fails, the floor moves
up, not the gate away.

Closes: items 15 (grade half moves to D36), 17.

---

## D31 — `validate`'s week check is field-wise and conditional; Phase 1 writes the envelope

**Decision.** Phase 1 writes the `week: { start, end }` envelope into `honestweek.prompts.json`.
`validate` compares it field-wise (`a.start === b.start && a.end === b.end`) against the items file's
week **only when the items file carries one**; absent that, validate skips the comparison and says
so, because `runValidate`'s signature is `{ cwd, argv, io }` with no injectable `now` and the
week-fallback rule lives in `lib/build.mjs`. Build's own re-derivation stays authoritative.

Closes: items 16, 30.

---

## D32 — The display-repo check for lane text is a two-part rule

**Decision.** `validate`'s existing check computes `isDisplay` from an item **field**
(`item.repo ?? item.repoLabel ?? item.label`), which a lane row does not have. So:

1. A lane row may carry an optional `repo` label field, checked exactly as a work item's is.
2. **Independently**, every lane `text` is scanned for any `display`-role repo's configured label as
   a substring, which is the naming half of the existing rule at `lib/validate.mjs:121-124`.

Both parts are required; neither alone repeats the existing rule.

Closes: item 13.

---

## D33 — Every code reference in every phase spec is mechanically verified

**Decision.** `.claude/work/prompt-lanes/spec-v2/verify-refs.mjs` parses every `path:line` and
`path` reference out of the phase specs and this file, and asserts each path exists and each cited
line contains the quoted token. It runs before the specs are considered ready and before each phase
is handed to an implementer. A stale reference fails the check.

Additionally: no requirement may instruct adding a README row that already exists. Measured,
`README.md` already carries the `honestweek.harvest.json` sidecar row.

Closes: items 8, 25, and the numeric half of 9.

---

## D34 — Forward-row ids

**Decision.** Engine-generated rows get `id = 'forward-' + origin + '-' + ref` (which satisfies
`/^forward-[a-z0-9-]+$/` since `origin` is a closed lowercase-hyphen vocabulary and `ref` is 8-hex).
Authored rows must supply an id matching the same pattern. Uniqueness is asserted across the union of
both sets, and a duplicate is a D10 **abort** (it means two rows claim one identity), not a drop.

Closes: item 23.

---

## D35 — Taxonomy, carried forward from the prior cross-cutting record unchanged except D9

The prior taxonomy decision stands and is restated here as settled, with one change:

- `STATUSES` stays exactly `['shipped','in progress','designed, not proven']`. No lane value is ever
  routed through `statusForTag`, `emit/_shared.badge()`, `byShippability`, `digest.mjs`'s
  `STATUS_HEADINGS`, or `page.mjs`'s `LEGEND` / `BADGE_CLASS`. #50 item 7 owns the only future change.
- `TECHNIQUE_GRADES` — **per D9**, the labels change.
- `DISPOSITIONS = ['not started','picked up','ruled out','deferred']`. `'open'` is deliberately not
  used: #52 item 3 asks for an "unlanded count" and #52's own problem statement calls the stat band
  `(sessions, landed, open, stranded)`, so `'open'` would mean unlanded badged work at the top of the
  page and un-actioned ideas at the bottom.
- `RESERVED_FOR_WORK_LANE = ['stranded','landed','unlanded','merged','reachable']`, asserted absent
  from the two **lane** vocabularies only — never from `STATUSES`, because #52 item 1 explicitly
  leaves that shape open and a reservation enforced as a veto on the reserving issue is not a
  reservation.
- **One parameterized pill primitive** in `page.mjs`, `renderPillSet({ vocab, classMap,
  legendEntries, present })`, instantiated three times. The work-status instantiation must produce
  byte-identical HTML to today's path. #50 item 7 then adds a vocabulary member, not a fourth
  parallel legend-plus-class-plus-render system.
- `'picked up'` requires a SHA that (a) came from a `git commit` result specifically — not
  `git log` / `show` / `rev-parse` — **and** (b) resolves through the same `lib/git.mjs` path
  `verifyItems` uses, in the session's own repo (D23), **and** (c) is authored by a
  `config.identity.authorEmails` address. Anything short of all three renders `not started`.
- No rendered lane string in any mode contains `landed`, `merged` or `shipped`, asserted by a test.
- `DISPOSITIONS` are explicitly **not** badges: disjoint from `STATUSES`; the forward band's HTML
  contains none of `BADGE_CLASS`'s three class names; the band carries the literal label
  `carried forward - not a verified claim`; no forward row passes through `badge()`,
  `renderItemLine()` or `allItems()`; the band renders below the badged sections in every mode.

---

## D36 — Lane A renders one row per shapeKey group, not one per window

**Decision.** A technique row corresponds to a **shapeKey group**. The grade (D9) is computed for the
group. `repeatedOpenings` is the group's eligible-window count. The acceptance criterion "a corpus
mixing repeated CLI boilerplate openings with one genuine repeated instruction yields exactly one
`repeated without correction` row" is then consistent with "every eligible window in a qualifying
group contributes to that group's grade".

**Why.** The old spec said both "every eligible window in a qualifying shapeKey group carries the
grade" and "yields exactly one" — true only if the row is the group, which was never stated.

Closes: item 15.

---

## Addendum: D37-D42

These close seven gaps the phase-1 authoring pass surfaced instead of inventing values for. Two of
them (D37, D38) are genuine conflicts inside D3/D4/D5/D23 and **amend** those decisions. The rest
promote rules the rejected spec carried that no revision item ever objected to, because a rejected
spec cannot be cited as authority for anything.

### D37 — The non-stub window shape is a 15-key list, not a count (amends D4)

D23 adds `repoKey` to a shape D4 described as 14 keys. The shape is stated as a list so it cannot
drift again:

```
index, ref, repoKey, shapeKey, kind, opensWithCorrection, correctionObserved,
complete, stub, assistantTurns, toolsUsed, statusSignals, testSignals,
commitShas, inspectedShas
```

Fifteen keys, exactly, on every non-stub window. D4's per-key value rules are unchanged; `repoKey`
is a number.

### D38 — Stubs carry no ref, and a past-cap boundary produces no sidecar row (amends D3, D5)

D5's "a ref on each turn window" means each **non-stub** window. A stub `deepEqual`s
`{ index, stub: true, complete: false }` and nothing else, per D3, which wins. A past-cap boundary
therefore also writes no `honestweek.prompts.json` row: it is never graded, so its instruction text
is never needed, and not writing it keeps the sidecar's growth bounded by the same cap.

### D39 — Cue vocabulary, shapeKey construction, bounds, and the exhaustive `complete: false` causes

**`IDEA_CUES`** (closed, one regex each, in `lib/lanes.mjs`):

| cue | pattern |
| --- | --- |
| `what-if` | `/\bwhat if\b/i` |
| `we-could` | `/\bwe could\b/i` |
| `idea` | `/^\s*idea[:,]/im` (anchored to a line start, never a bare occurrence) |
| `worth-trying` | `/\bworth (a )?try(ing)?\b/i` |

A bare `later` is deliberately excluded: it fires constantly in ordinary assistant prose and would
let the assistant side dominate the band.

**`shapeKeyFor(text)`** has a floor and may refuse. It returns `null` when fewer than 6 distinct
content words remain after `normalizePhrase` and `FILLER` removal; otherwise the `shortHash` of the
first 6 remaining content words with digit runs mapped to `#`. A `null` shapeKey makes the window
ineligible for recurrence and for every Lane A grade. Measured over 300 real session logs with the
unfloored fingerprint: 179 of 662 distinct fingerprints (27%) recurred across two or more distinct
sessions, and the strongest recurrers were CLI plumbing (`heads up you are going to`, 26 sessions;
`scheduled task name nightly wiki digest`, 22; `local command stdout set model to`, 22). Without the
floor, plumbing out-competes real instructions for the strongest evidence grade.

**Bounds**, added beside the existing block at `lib/claude-adapter.mjs`:

```
MAX_GRADED_TURNS      400        MAX_IDEAS_PER_WINDOW      5
MAX_TOOLS_PER_TURN     20        MAX_IDEAS_PER_SESSION    40
MAX_STATUS_PER_TURN    20        MAX_PROMPT_LEN         4000
MAX_SHAS_PER_TURN      10        MAX_SIDECAR_BYTES   8388608
```

**`complete: false` causes, exhaustively** (this list is closed; nothing else sets the flag):

- **Sets it, on the open window:** `MAX_TOOLS_PER_TURN`, `MAX_STATUS_PER_TURN`, `MAX_SHAS_PER_TURN`.
  These are the window's own gradeable evidence, and losing any of it is what makes the window
  ungradeable.
- **Never sets it:** `MAX_STEERS`, `MAX_NOTES`, `MAX_STATUS`, `MAX_REDIRECTS`, `MAX_CANDIDATES`.
  Each caps a flat legacy array the window projection never reads.
- **Never sets it:** `MAX_IDEAS_PER_WINDOW` and `MAX_IDEAS_PER_SESSION`. **This corrects the
  rejected spec, which had the idea caps set the flag.** Ideas are Lane B input, not Lane A
  evidence, so an idea cap has no business making a window ungradeable, and a session-scoped cap
  marking every later window incomplete is exactly the structural bias D21 exists to remove. Instead
  the session entry records `ideasTruncatedAtTurn: number | null`, and Lane B reports the truncation
  through D10's drop-loudly channel rather than silently under-representing a long session.

### D40 — A ref's `index` is a string segment, so no arithmetic encoding is needed (amends D5)

`refFor({ kind, sessionId, handoffId, index })` builds the canonical string
`` `${kind}|${sessionId ?? handoffId}|${index}` `` and hashes it with `shortHash` (FNV-1a to 8 hex,
the algorithm already in `lib/handoffs.mjs`). `index` is a **string**:

| origin | `index` |
| --- | --- |
| turn window | `String(turnIndex)` |
| idea | `` `${turn ?? 'pre'}:${ordinal}` `` where `ordinal` is 0-based within that turn, or within the pre-boundary run when `turn` is `null` (D26) |
| handoff next-step | `String(lineIndex)` |
| handoff reversal | `String(lineIndex)` |

This replaces D26's "reserved negative range", which needed a formula nothing had defined. A string
segment cannot collide by arithmetic accident and reads as what it is.

### D41 — `opensWithCorrection` reuses the two shipped redirect patterns (amends D27)

`opensWithCorrection` is true iff `REDIRECT_RE.test(text) || REDIRECT_BODY_RE.test(text)`, using the
two patterns already at `lib/claude-adapter.mjs`, unchanged. No new `CORRECTION_RE` is introduced.
Those patterns already define "the user corrected me" for the existing `redirects[]` field and are
already tested; a second vocabulary for the same concept would fork the definition. D27's derivation
of `correctionObserved` from the next window's `opensWithCorrection` is unchanged.

### D42 — Next-step extraction: headings, bound, precedence

- `NEXT_HEADING_RE = /^#{1,6}\s.*(next step|open question|follow[- ]?up|not done|carried forward|todo)/i`,
  beside `REVERSAL_HEADING_RE` in `lib/handoffs.mjs`.
- `MAX_NEXT_STEPS = 20`.
- **No free-floating line rule.** There is no `NEXT_LINE_RE` twin of `REVERSAL_LINE_RE`. This matches
  D7's narrowing: a section-scoped rule is the only safe one, and a keyword rule for next-steps would
  swallow ordinary prose.
- **Both section flags are set from the same `if (HEADING_RE.test(line))` block**, because that
  single assignment is also the reset. Setting the new flag anywhere else leaves `inReversalSection`
  stale-true under a next-steps heading, and next-steps bullets land in `reversals[]`, corrupting the
  exact signal Lane B uses to close an idea.
- **Precedence:** a line matching both patterns is a reversal only.

## Addendum 2: D43-D49

These close seven gaps the phase-3 authoring pass surfaced. Two of them (D43, D44) are missing
**Phase 1** outputs that Phase 3 cannot synthesize. D49 is a genuine conflict between D10 and D24.

### D43 — Reversal rows carry section provenance (amends D5, adds a Phase 1 output)

D7 renders only reversal lines mined **inside** a `REVERSAL_HEADING_RE` section, and keeps the
free-floating `REVERSAL_LINE_RE` branch draft-only. Phase 1's `reversalRefs: [{ ref, text }]` carries
no way to tell the two apart, so Phase 3 could not implement D7 without inventing a field.

Phase 1 emits `reversalRefs: [{ ref, text, sectioned }]`, where `sectioned` is `true` when the line
came from inside a `REVERSAL_HEADING_RE` section and `false` when it came from the free-floating
branch. Phase 3 renders only `sectioned: true` rows. The bare-string `reversals` array is unchanged,
so the draft-superset test still holds.

### D44 — Idea truncation reports a count, not just a turn (amends D39, adds a Phase 1 output)

D39 records `ideasTruncatedAtTurn` and D10's diagnostic requires a dropped count, which Phase 1 did
not produce. Phase 1 additionally records `ideasDropped: number` on the session entry: the count of
ideas a cap prevented from being recorded. Zero when no cap bit. D10's Lane B diagnostic reports that
count.

### D45 — `dispositionAsOf` is the build's week start

`dispositionAsOf` is the ISO date string of the current build's `week.start`, identical on every row
that build emits. It answers "as of when was this disposition true", which is the question an archive
page needs in order to label a frozen band honestly.

### D46 — The archive index field is `forwardUnactioned`, and it is a count (amends D29)

D29 named the field `forwardOpen` without a type. It is renamed and typed: **`forwardUnactioned`, a
number**, counting forward rows whose disposition is `not started` or `deferred`.

The rename is not cosmetic. D35 deliberately refused `open` as a Lane B disposition because #52 item
3 asks for a stat band counting unlanded **work**, and an `open` count over **ideas** in the same
archive index that feeds #50's multi-week pages recreates exactly that collision one layer down.
`forwardUnactioned` cannot be misread as unlanded work.

Conditional-spread rules from D29 are unchanged: present only when the forward band is present.

### D47 — An authored row supersedes the engine row with the same ref (amends D34)

Uniqueness is enforced over **`ref`** as well as `id`:

- An authored row and an engine-derived row carrying the **same `ref`**: the authored row renders and
  the engine row is suppressed. The model named it and may have attached a `closedBy` link, so its
  row is strictly more informative, and rendering both would double-count one idea.
- Two **authored** rows carrying the same `ref`, or any duplicate `id`: abort, per D34. That means
  two rows claim one identity, which is a positive error rather than a merge.

### D48 — `ruled out` beats `picked up`

When one authored idea satisfies both D35's `picked up` conditions and a verified `closedBy` path to
`ruled out`, it renders **`ruled out`**.

This is the under-claim direction, which `AGENTS.md` invariant 3 requires. A reversal recorded in a
handoff is a human-authored statement that the idea was abandoned; `picked up` is a commit heuristic.
Claiming forward progress on something that was reversed is the over-claim, so the heuristic yields.

### D49 — An unresolvable commit keeps the row; an unresolvable identity drops it (amends D10, D24)

D10 put "a commit lookup throws" in the drop-loudly class while D24 said it falls back to
`not started`. Those conflict. The line is drawn on **what** could not be resolved:

| Cannot resolve | Result |
| --- | --- |
| A row's **identity** (its `ref` matches no record; the corpus is absent; the carry index is unparseable) | Drop the row or band loudly, per D10. There is nothing to render. |
| A row's **optional evidence** (a commit lookup throws or the SHA does not resolve) | **The row renders as `not started`**, per D24. Build reports a count of rows whose commit resolution failed. |

Dropping a row because its optional evidence failed would hide an idea that genuinely exists, and
`not started` is already the honest statement of "no confirmed pick-up". D10's table is read with
this split.

## Addendum 3: D50-D60

These close the four residuals from the closure audit and all eight defects from the cross-phase
consistency audit, which returned `implementationOrderIsSound: false` with phases 2, 3 and 4 failing
ship-alone. Four were blockers, and three of those trace to ambiguity in earlier decisions here.

### D50 — One shared lane commit resolver (closes residual item 31)

D23 named the resolution path but not its contract, so Lane A and Lane B would each build one and
drift on what "unresolved" means. `lib/lanes.mjs` exports exactly one:

```js
resolveLaneCommit(sha, { repoKey, config })
// -> { state, sha, repoLabel }
// state: 'resolved-authored' | 'resolved-other-author' | 'unresolved' | 'unusable-repo'
//        | 'no-repo-key' | 'display-role'
```

- `display-role` is returned **without running git**, per the never-git-read-a-display-repo invariant.
- `no-repo-key` covers a missing or out-of-range `repoKey`.
- `unusable-repo` covers `lookupCommit` throwing.
- Only `resolved-authored` may ever support a positive claim. Every other state falls to the
  under-claim default, per D49.

Both lane graders consume this one function. No phase may implement a second lookup.

### D51 — The noun warning is count-only, and the exclusion baseline covers the tool vocabulary (amends D14)

D14 said the warning names "the top few tokens". That is wrong and this decision corrects it: naming
the tokens is itself a leak channel, and it contradicts the counts-only discipline `lib/harvest.mjs`
and `lib/validate.mjs` already follow.

- The default diagnostic is **count-only**: the number of distinct unmatched tokens, reported by item
  id. No token is ever echoed at the default posture.
- The `excludeSet` baseline additionally includes the ambient tool vocabulary: `Bash`, `Edit`, `Read`,
  `Write`, `Grep`, `Glob`, `Task`. D39's own rationale already identified these as the top harvest
  polluters, so leaving them out of the exclusion baseline was inconsistent.
- **Acceptance:** an end-to-end lane build over the full fixture corpus asserts **zero** default noun
  warnings. A default diagnostic the operator cannot clear is one they learn to ignore.

### D52 — A lane-bearing `changelog` build says so (closes residual item 49)

`changelog` stays work-only per D15, but a build with lane keys pays the whole gate and renders
nothing. It emits a one-line stderr notice naming the mode and the count of lane rows ignored.
Documentation is not a substitute for the program saying what it did.

### D53 — The copy gate's false-positive check is measured over at least ten names (amends D30)

The floor stays at 4. The measured check grows: **at least ten** ordinary technique names, every one
of them at least four words so it can actually exercise the gate, run against a multi-session corpus
rather than the deliberately small frozen one. Escalation rule, stated in advance: if the measured
check produces a false positive, the floor rises to 5 and the check re-runs. The floor moves on
evidence, never on preference.

### D54 — SKILL.md rule 8 has exactly one producer: Phase 3 (amends D16)

D16 said Phase 2 "reserves and writes both rules 7 and 8" **and** that Phase 3 "fills rule 8's body".
Those contradict, and the contradiction produced two blockers: a double producer, and a Phase 2 that
cannot ship alone because it would instruct the model to author `forward[]` while Phase 2's own
`build` and `validate` are forbidden to consume it.

- **Phase 2** writes rule 7's full body, and reserves rule 8's **number and title only**, explicitly
  marked as not active until the forward band ships. Phase 2 publishes **no** forward item shape.
- **Phase 3** authors rule 8's body and the forward item shape.
- `test/skill.test.mjs`'s rule **count** is set once, by Phase 2. Phase 3 changes only the body
  assertion, never the numbering.

D16's intent, that numbering is settled once, is preserved. Its wording was the defect.

### D55 — Every cross-phase export has a specified shape, in the phase that produces it

Phase 2 promised helpers to Phases 3 and 4 by name only. A named function with an unspecified return
is not a contract. Phase 2's spec must give exact input and output shapes for at minimum:

- `ensureLaneCorpus()` — its returned object's keys and types, including the session list, the
  handoff list, the file-count state and the identity list Phase 3 consumes.
- The four text gates (configured-private-term, display-label, unconfigured-noun, voice) — each
  one's function name, signature, result shape and diagnostic shape.
- `renderPillSet` — its return, and exactly how one selected value reaches the single badge template.

The same rule binds Phase 3 for anything Phase 4 consumes.

### D56 — `closedBy` is a reversal ref

`closedBy` is an optional **string**: a `handoff-reversal` ref as minted by D5 and D40.

- Absent: the idea simply is not closed.
- Present and matching a reversal ref for the week: the row renders `ruled out`.
- Present and matching nothing: **abort**. It is an authored claim about a specific record, so a
  wrong one is a positive error, exactly as D34 treats a duplicate id.

### D57 — Forward rows carry private `sourceKind` provenance (amends D34, D47)

D47's authored-beats-engine merge needs to know which row is which, and an id cannot safely encode
provenance. Every forward row carries `sourceKind: 'authored' | 'engine'`, minted by Phase 3,
preserved through Phase 4's merge, and **stripped before render, before `writeArchive`, and from the
D12 carry-index schema**. It is local-only, exactly like `ref`.

### D58 — The corpus scan is unconditional; only the carry-index read and write are skippable (amends D12)

Phase 4's no-input fast path was circular: it skipped the corpus scan when there were no current
rows, but engine-derived rows only exist *after* that scan, so the fast path could suppress
legitimate Phase 3 rows. Whenever lanes are enabled, Phase 3's single corpus scan (D28) always runs.
Phase 4 may skip only the carry-index reader and writer, and only after that scan has proven there
are no current rows and no index file exists.

### D59 — `normalizePhrase` and `FILLER` are defined exactly (amends D39)

Phase 2 treats `shapeKey` as authoritative grading identity, so its producer cannot be
under-specified. D39 gains:

- **`normalizePhrase(str)`**, step by step and in this order: Unicode NFKC normalize; lowercase;
  replace every character that is not a letter, digit or space with a single space; collapse runs of
  whitespace to one space; trim.
- **`FILLER`**, published as an exact closed token list, not a description.
- **Table tests** pinning punctuation, case, repeated words, digit runs, filler removal and Unicode
  handling, so two implementations of the spec produce the same fingerprint.

### D60 — The README neither-lane string keeps its backticks

Phase 2's "neither lane present" cell must reproduce `README.md`'s existing sample-output line
**exactly**, including the backticks around `digest`. Dropping them changes a byte sequence the same
requirement claims is unchanged.

## Addendum 4: D61-D68 (judgment calls from the defect hunt)

The defect hunt returned 21 defects, 10 of them blockers. The mechanical ones are folded in by the
next revision pass from `revision-inputs-round2.json`. These eight are the judgment calls, and
several reverse an earlier decision here.

### D61 — The redact-before-truncate reorder is split out of this feature entirely (reverses part of D17)

**This is the most important correction in this addendum.** D17 restated `AGENTS.md` invariant 6 with
a Layer 0 split and named the truncate-order reorder as "the one deliberate exception". That is
rewriting an invariant to excuse breaking it, which is exactly the move this product exists to
refuse. The reorder changes existing steering, redirect and assistant-text bytes **even when no lane
input is present**, so it is not additive under any honest reading.

- The reorder is removed from Phase 1 and from every phase of this feature.
- It becomes **its own issue and its own PR**, landing before Phase 1, described as what it is: a
  privacy fix with a stated blast radius on existing drafts.
- Within the lanes feature, redaction-before-truncation applies **only to the new fields** (sidecar
  text, window and idea projections). Legacy field bytes are untouched.
- `AGENTS.md` invariant 6 keeps its meaning. D17's invariant-1 restatement (D8) stands; its
  invariant-6 rewrite does not.

The leak it fixes is real: a 303-character string ending in an email address currently ships the
local part and half the domain. It deserves a fix on its own terms, not a rider on a feature branch
that needs the invariant loosened.

### D62 — `closedBy` renders a pointer; it never produces a disposition (amends D48, D56)

`build` can verify that a cited reversal **exists**. It cannot verify that the reversal is what
closed the idea. Turning that existence check into the disposition `ruled out` asserts a causal
relationship from evidence that contains none, which is the exact claim class this design refuses.

- An authored `closedBy` renders as a **linked pointer** beside the row ("closed by" plus the handoff
  receipt). It does not change the row's disposition, which stays engine-derived.
- The reversal still renders as its own `ruled out` engine row per D6 and D7, so #52 item 5 is closed
  without inventing a link.
- D48's precedence rule is therefore moot for the `closedBy` path and applies only where both
  dispositions are engine-derived.
- D56's abort-on-unmatched-ref rule stands: a pointer to nothing is still a positive error.

### D63 — Build stdout is byte-identical when both lanes are absent (amends D-Layer-3)

Layer 3 said stdout was "free to change". It is not, when the change is unconditional: an extended
summary printed on every build breaks the absent-input byte-identity invariant for anyone scripting
against it. The existing summary is preserved byte for byte when both lane arrays and all engine rows
are absent. The extended form prints only when at least one lane is present. An acceptance criterion
pins the absent-lane stdout exactly.

### D64 — A file-level failure reports no count (amends D10)

D10's diagnostic template demands a numeric dropped-row count. For an **absent** carry index that
number does not exist, and for an unparseable one it cannot be derived, so the template forces an
invented figure. Split it:

- **File-level** absent or unparseable: a count-free band diagnostic naming the file and the reason.
- **Row-level** drops from a parseable source: the exact count, which is genuinely derivable.

### D65 — `repo` on a forward row is derived, never authored (closes the carry re-gating bypass)

An optional, author-controlled `repo` field lets a carried row skip the display-role check, which is
the one check that exists only in `validate` and is therefore not caught by the `deepRedact`
backstop.

- Phase 3 **derives** `repo` from the resolved session or handoff for every private forward row.
- A conflicting authored `repo` value is rejected, not merged.
- The derived label persists into every carry entry, so Phase 4's re-gating always has it.

### D66 — D33 is restated to describe the verifier that exists (corrects D33)

D33 claimed `verify-refs.mjs` "parses every `path:line` reference out of the phase specs". It does
not: it checks backticked path existence plus an explicit `claims*.json` table. Claiming a capability
the tool lacks is the same error the spec polices elsewhere, so the claim is corrected rather than
the tool quietly credited.

What is actually true, and what is now required: the verifier checks path existence and every entry
in the claims table. **Every inline `path:line` citation in a phase spec must have a matching claims
entry**, so the table is the complete record. A spec citing a line with no claims entry is a defect.
Extending the verifier to parse inline citations directly is a worthwhile follow-up, filed
separately, not assumed here.

### D67 — Technique-row identity (closes an invented vocabulary)

Phase 2 invented `/^technique-[a-z0-9-]+$/` with no decision behind it. Settled here, mirroring D34:
an authored technique row carries `id` matching `/^technique-[a-z0-9-]+$/`, unique across the
techniques array, and the `id` is **stripped before render and before `writeArchive`** exactly like
`ref` and `sourceKind`. A duplicate id aborts.

### D68 — `ideasDropped > 0` is the truncation signal (amends D39, D44)

`ideasTruncatedAtTurn: number | null` cannot signal truncation on its own, because `null` already
means "no truncation" and a pre-boundary idea legitimately has no turn. Truncation presence is
`ideasDropped > 0`. `ideasTruncatedAtTurn` is optional location context only. An acceptance case
covers a session whose first dropped idea is pre-boundary.

## Addendum 5: D69-D71 (decision-level gaps the round-2 items open)

Three of the 42 round-2 items cannot be folded into a phase spec as written, because their fix
changes what an earlier decision means rather than how a phase implements it. Per the rule that a
phase spec never invents, they are settled here first.

### D69 — A ref or shapeKey collision is detected, never assumed away (amends D5, D39, D40)

D5 says "collisions across kinds are prevented by `kind` being in the canonical string". That is
true and beside the point: it rules out identical canonical strings, not identical hashes of
different canonical strings. `shortHash` is a 32-bit FNV-1a rendered as 8 hex
(`lib/claude-adapter.mjs:417`), so distinct inputs can and eventually do land on the same value. D39
then uses that same 8-hex construction as the sole grouping key behind the `repeated without
correction` claim, which turns a hash accident into a false honesty claim. That is the claim class
this product exists to refuse, so the hash is demoted from identity to lookup token.

- **The canonical string is retained**, not just its hash. Every ref-bearing record keeps its
  canonical tuple (`kind`, `sessionId ?? handoffId`, `index`) in local state alongside the 8-hex
  `ref`. Every shapeKey-bearing record keeps its normalized six-word phrase alongside the 8-hex
  `shapeKey`. Both extras are local-only, stripped before render and before `writeArchive`, exactly
  like `ref` (D5) and `sourceKind` (D57).
- **Collision detection runs before any join or grade.** Building the ref index and the shapeKey
  group index each check for a same-hash/different-canonical pair. There is exactly one such check
  per index, in the shared minter's index builder; no consumer re-implements it.
- **What a detected collision does** follows D10's two-class policy rather than adding a third:
  a ref collision **aborts** (`build` exits 2, writing nothing), because ref is the join key that
  every downstream claim hangs on and a wrong join silently attributes one session's evidence to
  another. A shapeKey collision **drops loudly**: both colliding groups lose their recurrence grade
  and fall to the under-claim default, and the band reports the dropped count per D64's row-level
  rule. Recurrence is one grade among several, so losing it degrades a claim instead of corrupting
  one.
- **Acceptance uses real colliding pairs**, not a mocked hash. Both fixtures pin two concrete inputs
  whose `shortHash` values are equal and whose canonical strings differ, found by search over the
  32-bit space and checked in as literals. A test that stubs the hash function proves nothing about
  the hash actually shipped.

The compact hash stays the published/local lookup token, unchanged in shape and length. Nothing
about the ref's privacy properties (D5) changes: the canonical tuple contains no prose.

### D70 — The copy gate's false-positive corpus is captured before the gate exists (amends D53)

D53 requires the false-positive check to run "at least ten ordinary technique names ... against a
multi-session corpus". Nothing says where that corpus comes from, and the same implementer who has
to make the criterion pass is also told to create the corpus. A measurement whose input can be
chosen after seeing the result is not a measurement.

A checksum alone does not fix this. It proves the corpus did not change *after* it was written, and
the problem is what goes into it in the first place: the same author can still pick source prose
with no overlap. So the corpus is **derived, not authored**.

**Extraction, specified exactly so it is a procedure and not a choice.** Sources are files that
already exist on `main` and were written for other purposes, before any lane code:

1. `README.md` and `SKILL.md`. Strip fenced code blocks, then split on sentence enders, blank lines,
   and lines opening with a list, table or heading marker.
2. Every `test/fixtures/claude-projects/**/*.jsonl` record with `type === 'user'` whose
   `message.content` is a string. These are the only real prompt-shaped prose in the repo.
3. Drop any segment whose raw text matches a URL or badge marker. This is a clean-room guard, not a
   quality filter: `README.md`'s badge line carries the repository URL, and the corpus is committed.
4. `normalizePhrase` each survivor per D59; keep those with at least four words; dedupe; sort.
5. Write `test/fixtures/lane-corpus/copy-gate-corpus.json` with that `prompts` array and a `sha256`
   of `JSON.stringify(prompts)` from `node:crypto`. Commit the generator beside it.

The implementer runs the procedure. They do not select the inputs, and they cannot reach the sources
to tailor them without editing the project's own README in the same pull request, which is visible.

**The ten technique names are pinned here as literals**, and this decision is their single source.
A phase spec cites "D70's ten names" and does not restate the list, so the two cannot drift apart:

1. `ask for the failing test first`
2. `name the invariant before changing code`
3. `separate evidence gathering from implementation`
4. `request the smallest reproducible example`
5. `compare expected output before editing`
6. `trace one concrete input end to end`
7. `state the rollback condition up front`
8. `check the boundary case explicitly`
9. `verify the public contract after refactoring`
10. `summarize unresolved risks before stopping`

Normalized word counts are 6, 6, 5, 5, 5, 7, 6, 5, 6, 5. Every one clears the four-word floor, so
every one can actually exercise the gate. That was the original defect in D30's check: one of its
three names was too short to fire.

**Measured, at `b017048` plus the AGENTS.md commit**, by running the procedure above: 206 corpus
segments, 2611 distinct 4-grams, and **zero** of the ten names produce a copy hit at floor 4. A
positive control taken as a verbatim five-word run out of the corpus produces two hits, so the check
is capable of failing.

A second, independently written set of ten names was measured against the same corpus and also
produced zero hits. Two independent name sets agreeing is weak evidence, not strong: both were
written by someone who knew what the gate does. It is reported because suppressing it would be
worse, not because it settles anything.

Those numbers are evidence the procedure works, not a target to reproduce: if `README.md` or
`SKILL.md` change before Phase 1 lands, the counts and the checksum change with them, and the pinned
checksum is whatever the generator produces in the Phase 1 commit.

**Both halves are required in acceptance.** The zero-false-positive assertion alone would pass
against an empty corpus, so the criterion also asserts the positive control fires and that the
corpus is non-empty at its checksum.

**What this proves and what it does not.** It proves the gate does not fire on ten ordinary
technique names against this corpus. It is not a general false-positive rate, and it should not be
described as one. D53's escalation rule is unchanged and runs on the measured result: a false
positive raises the floor to 5 and the check re-runs. The floor moves on evidence.

### D71 — A reversal-bearing draft baseline exists outside the frozen corpus (amends D19, D22)

D22's `draft-baseline.json` is generated from the frozen corpus, and D19 requires that corpus to
contain **no** handoff reversals. The reversal-preservation criterion therefore deep-equals `[]`
against `[]` and passes no matter what reversal extraction does. It reads as evidence and is not.

- Phase 1 commits a **second** baseline, `test/fixtures/golden/draft-baseline-reversals.json`,
  generated by pre-change `discover` over a small dedicated project root that carries at least one
  handoff with at least two exact reversal strings and at least one next-steps section.
- That project root lives under its own fixture tree per D19's new-fixtures rule, so the frozen
  byte-identity corpus is untouched and keeps its D6 no-reversals property.
- The reversal-preservation criterion deep-equals `handoffs[].reversals` against the **nonempty**
  bare-string array in that file, after `reversalRefs` is added. An empty expected array fails the
  criterion by construction.
- The same fixture carries the next-steps case, so the drop-guard behaviour change (a handoff
  carrying only a next-steps section is no longer dropped) has a real record to assert against.

**The general rule these three share**, worth stating once: an acceptance criterion whose fixture
cannot exercise the branch it names is a defect, not a passing test. Every criterion added by the
round-2 pass names the input that makes its assertion capable of failing.

### D72 — `FILLER` is this exact 75-token list (completes D59)

D59 required `FILLER` to be "published as an exact closed token list, not a description" and then
supplied no members. The Phase 1 authoring pass hit that and, correctly, refused to invent one. This
settles it. The list is closed: nothing is added at implementation time.

```js
const FILLER = Object.freeze([
  // articles and determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  // pronouns and possessives
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'it', 'its', 'they', 'them', 'their', 'theirs', 'he', 'him', 'his', 'she', 'her', 'hers',
  // copulas, auxiliaries and modals
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had',
  // low-load prepositions and conjunctions
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'and', 'or', 'but',
  // discourse and politeness markers
  'please', 'just', 'really', 'actually', 'basically', 'simply', 'okay', 'ok', 'thanks',
  'hey', 'so', 'well', 'now', 'then', 'also', 'very', 'quite', 'maybe',
]);
```

**What is deliberately NOT in it, and why.** This is the load-bearing half of the decision. These
words look like function words and are excluded on purpose, because dropping them would merge two
prompts that mean opposite things into one shape, and `shapeKey` is what the `repeated without
correction` honesty claim groups on:

- **Negation and exclusion:** `not`, `no`, `never`, `none`, `nothing`, `without`, `instead`,
  `except`, `unless`. "Run the tests" and "do not run the tests" must not fingerprint alike.
- **Sequence and repetition:** `before`, `after`, `first`, `last`, `next`, `again`, `still`, `once`.
  These carry the instruction's ordering, which is often the technique itself.
- **Quantifiers and scope:** `all`, `every`, `each`, `only`, `both`, `any`, `some`, `more`, `less`,
  `than`, `same`, `different`. Scope is meaning here, not noise.
- **Modals:** `will`, `would`, `shall`, `should`, `can`, `could`, `may`, `might`, `must`. These were
  in the first draft of this list, under "auxiliaries", and the round-3 defect hunt caught it as a
  blocker. It was right. A modal carries obligation, and "you must run the tests" and "you may run
  the tests" are different requests. Dropping them would have merged an instruction with its own
  permission-granting opposite, under a claim that the list only removed words that change nothing.
  Auxiliaries that genuinely carry no obligation (`do`, `does`, `did`, `have`, `has`, `had`, and the
  copulas) stay in.

**Removal is exact-token, after `normalizePhrase`.** D59's normalization already lowercases and
strips everything that is not a letter, digit or space, so a `FILLER` member matches a whole
whitespace-delimited token or it does not match at all. There is no stemming, no substring matching,
and no case handling left to do. `data` never loses its `a`.

**Ordering, stated because it is observable.** `normalizePhrase` runs first, then `FILLER` removal,
then the digit-run mapping to `#`, then the 6-distinct-content-word floor, then the hash of the
first 6. A word removed by `FILLER` does not count toward the floor.

**Why this list and not a standard stopword list.** A published stopword list is tuned for document
retrieval and drops exactly the negations and quantifiers above. Using one here would be importing
someone else's tradeoff into an honesty claim, and it would also be a dependency this repo does not
take. The list is small, auditable, and every member is a word whose presence or absence does not
change what a prompt asks for.

**Acceptance.** D59's table tests gain one row per exclusion group: a pair differing only by
`not`, only by `before` versus `after`, and only by `all` versus `some` must each produce
**different** `shapeKey` values. A pair differing only by `please` or only by `just` must produce
the **same** value. Without the differing-pair half, the table would pass with `FILLER` set to
every word in English.

## Addendum 6: D73-D79 (producer/consumer contract closure)

These decisions supersede any earlier phrase or phase requirement that conflicts with them. They
close the round-3 boundary audit without changing product direction.

### D73 — One build-local identity carrier owns minting, validation, and persisted encoding (amends D5, D40, D69)

Phase 1 exports `createLaneIdentityCarrier()` from `lib/lanes.mjs`. One carrier instance is created
per discovery or build and passed as the optional final `{ identityCarrier }` dependency to both
`adaptSessions` and `discoverHandoffs`. Their legacy return values stay unchanged. Extraction calls
`identityCarrier.register(record)` at the point where the source ordinal is still known; no later
phase reconstructs an ordinal, canonical, or ref.

`register(record)` accepts exactly:

```js
{
  kind: 'turn' | 'idea' | 'handoff-next-step' | 'handoff-reversal',
  sessionId: string | null,
  handoffId: string | null,
  index: string,
  repoKey: number,
  repo: string,
  receipt: { sessionId: string, turn: number | null } | { handoffId: string },
  text: string | null,
  sectioned: boolean | null,
  shapeKey: string | null,
  shapeCanonical: string | null
}
```

Exactly one of `sessionId` and `handoffId` is non-null and agrees with `kind` and `receipt`.
`repoKey` is a non-negative configured-repo index. `text` is the already-redacted source string for
ideas and handoff records and `null` for turns. `sectioned` is boolean only for reversals and `null`
otherwise. Shape fields are both strings for a shape-bearing turn and both null otherwise.

The carrier creates `refCanonical` as the three JavaScript string segments `kind`, the non-null
source id, and `index`, joined by one U+0000 NUL code unit. It creates `ref` by applying the shipped
8-hex FNV-1a `shortHash` to that exact string. This NUL-delimited rule is authoritative; D40's later
pipe-delimited prose and every pipe-based fixture literal are corrected. `records()` returns a new
frozen array of frozen records with exactly
`{ ref, refCanonical, kind, repoKey, repo, receipt, text, sectioned, shapeKey, shapeCanonical }`, in
registration order. The carrier rejects a same-ref/different-`refCanonical` pair immediately and
accepts an exact repeat idempotently. It also owns the checked shape-key index. Its lifetime is one
build or discovery call and it is never global.

The same module exports `validateRefIdentity(ref, refCanonical)`. It accepts only a lowercase
8-hex `ref` and a string `refCanonical` containing exactly two U+0000 separators with nonempty
segments, recomputes the shipped hash, and returns the parsed frozen
`{ kind, sourceId, index }` only when the result equals `ref`; otherwise it throws a D69 identity
error. Every ref-index builder calls this validator before collision checks. Phase 4 calls it on
every parseable carry entry before duplicate, zombie, suppression, or join logic.

The same module is the sole producer of both checked index APIs:

- `buildValidatedRefIndex(records)` accepts a read-only array whose entries contain string `ref` and
  `refCanonical`. It validates every pair, preserves input order, and returns a frozen capability
  object with exact keys `{ size, has, get, entries }`. `has(ref)` is boolean; `get(ref)` returns a
  frozen source-ordered array of the original records or `undefined`; `entries()` returns a new
  frozen array of frozen `[ref, records]` pairs. A same-ref/different-canonical pair throws the D69
  identity error before the result exists. Same-ref/same-canonical records remain grouped so the
  owning consumer can apply its declared duplicate or precedence rule; the builder never silently
  chooses one.
- `validateShapeIdentity(shapeKey, shapeCanonical)` accepts only a lowercase 8-hex key and nonempty
  canonical string, recomputes the shipped hash, and throws on a mismatch.
  `buildValidatedShapeIndex(records)` accepts a read-only array whose entries contain non-null
  `shapeKey` and `shapeCanonical`, validates every pair, and returns a frozen capability object with
  exact keys `{ size, collisionGroups, has, get, entries }`. When a key has more than one validated
  canonical, each distinct canonical group under that key contributes one to `collisionGroups`; all
  records under that key are absent from `has`, `get`, and `entries` and therefore cannot support
  recurrence grading. Noncolliding `get`/`entries` values are frozen
  source-ordered record arrays with the same semantics as the ref index.

Neither capability exposes its private `Map` or a mutator. Phase 1 implements these four exports;
Phases 2-4 call them directly and never wrap, parse, re-mint, or reimplement them.

The version-1 carry property is named `refCanonical` and is the same in-memory NUL-delimited string.
On disk it is encoded only by `JSON.stringify`, so each separator is persisted as the six ASCII
bytes `\\u0000`; readers use `JSON.parse` and then the shared validator. No tuple object, pipe form,
base64 form, or alternative property name is valid version-1 state.

### D74 — The remaining cross-phase values and Phase 3 result are exact (amends D4, D8, D54, D55)

- `turns[].assistantTurns` is `Array<{ text: string }>`. Each object has that one key, `text` is
  redacted before entering the draft, and the array contains no machine envelope or tool-result
  body. Empty is `[]`.
- Phase 2 exports `renderTranscriptReceipt(receipt, format) -> string`, where `format` is exactly
  `'markdown' | 'html'`. It accepts only D8's two receipt shapes, returns the settled visible text
  for markdown, and returns that escaped text inside one
  `<span class="wl-transcript-receipt">...</span>` for HTML. Invalid input or format throws before
  rendering.
- The authored `forward[]` item has required exact keys `{ id, ref, text, origin, receipt }` and the
  sole optional key `closedBy`. `id` matches D34; `ref` is lowercase 8-hex; `text` is nonempty;
  `origin` is `'you' | 'assistant'`; `receipt` is a session receipt and must agree with the resolved
  source; `closedBy`, when present, is a lowercase 8-hex D56 reversal ref. Unknown keys and authored
  `repo`, `disposition`, `dispositionAsOf`, or `sourceKind` are rejected.
- `deriveCurrentForwardRows(...)` returns an object, never a legacy tuple:

```js
{
  finalPrivateRows: Array<PrivateForwardRow>,
  engineForwardRows: Array<EngineForwardRow>,
  laneInputPresence: { authoredForward: boolean, engineForward: boolean },
  diagnostics: {
    commitResolutionFailures: Array<{ rowId: string, state: 'unresolved' | 'unusable-repo' }>,
    rowDrops: Array<{ rowId: string, reason: 'invalid-shape' | 'identity-unresolved' | 'source-conflict' }>,
    nounWarnings: Array<{ rowId: string, count: number }>,
    ideaTruncations: Array<{ sessionId: string, dropped: number, firstDroppedTurn: number | null }>
  }
}
```

`PrivateForwardRow` has Phase 3's settled required keys and optional `closedBy`.
`EngineForwardRow` has exactly required `{ id, ref, text, origin, receipt, repo, disposition,
dispositionAsOf, sourceKind }`, where `origin` is exactly `'handoff-next-step' |
'handoff-reversal'`, `receipt` is exactly `{ handoffId: string }`, `repo` is the derived configured
label, `disposition` is one of D35's four values, `dispositionAsOf` is the normalized week-start ISO
date, `sourceKind` is `'engine'`, and it has no `closedBy`. Both arrays and every diagnostics array preserve
source order. A row id appears at most once per diagnostics array. Diagnostics contain ids, counts,
and closed enum codes only, never source text, tokens, repo paths, or configured values. Consumers
use these returned diagnostics without a second lookup, scan, or mutable side channel.

### D75 — Raw authored/engine presence owns stdout; final presence owns rendering (amends D63)

The successful-build stdout branch is selected from raw source authority: the extended form is used
when the authored `techniques` array is nonempty, the authored `forward` array is nonempty, or Phase
3 produced at least one engine row before later gates or carry merging. This fact is retained before
drops. Final collection presence controls only band attachment, rendered counts, empty-work copy,
and `forwardUnactioned`. A nonempty authored array whose rows all drop therefore prints the extended
summary with a zero final count. Phase 4 consumes `laneInputPresence` and never substitutes the
final-union predicate for stdout selection.

### D76 — Every line has the receipt its evidence permits (corrects D8 and D17)

The invariant wording is:

> A source receipt on every emitted item. Git-checkable work uses a commit receipt. Private,
> display-role, and session-only work may use a transcript receipt. Every lane line uses a transcript
> receipt. An item reaching a renderer without its required receipt is a build error.

This preserves existing private/display/session-only work behavior and the no-Git-read rule for
display repositories. No newly selected or reworded contract branch may promise a Git receipt for
every work line. D63 and additive output keep the legacy neither-lane page bytes unchanged; that
frozen compatibility string is not the invariant's authority and is not copied into any lane branch.

### D77 — Phase 2 owns all forward metadata wording (amends D16, D62)

Phase 2's forward formatter accepts optional producer-resolved `closedByReceipt` and optional carry
metadata `{ firstSeenWeek }`. The metadata clause order is fixed: authorship phrase, date phrase,
optional pointer, then receipt. A present pointer renders exactly
`_closed by_ (<renderTranscriptReceipt(closedByReceipt, format)>)` after the date phrase and before
the row's own receipt. Absence adds zero bytes. Phase 3 supplies only the resolved handoff receipt.

For a carried row, Phase 2's date formatter owns the exact phrase
`first seen <firstSeenWeek>; as of <dispositionAsOf>`. Phase 4 supplies only `firstSeenWeek`; it does
not author or edit public copy. Current rows keep `as of <dispositionAsOf>` byte-for-byte.

### D78 — Build copy matching carries an opaque normalized-run index, never source strings (amends D20, D55)

`ensureLaneCorpus()` returns `copyRunIndex`, not `corpusStrings`. The index is a frozen
`Map<string, number>` whose keys are lowercase 64-hex SHA-256 values of the UTF-8 bytes of normalized
four-word runs after D59 normalization and whose values are occurrence counts. It is built with
`node:crypto` during the one corpus scan; raw prompt, idea, and run strings are released before the
result crosses the Phase 2 boundary. `sharesRun(text, copyRunIndex)` normalizes only the candidate
row, hashes each candidate run the same way, and tests those hashes against the map. Validate's
sidecar string path remains separate and explicitly partial. Tests recursively reject any corpus
source string or normalized run in the build result.

### D79 — Diagnostics name their unit, and acceptance controls must exercise both sides

Shape collisions report `collisionGroups: <count>` as the number of distinct validated canonical
groups excluded under colliding keys, not the number of keys, records, rows, or dropped rows.
Row drops report rows. Optional commit failures report affected rows. Idea truncations report ideas
plus the affected session id. These units are not interchangeable.

D72 closure includes the explicit pair `you must run focused checks before changing code` versus
`you may run focused checks before changing code`; both inputs remain above the six-content-word
floor and must produce different `shapeKey` values. Its positive control differs only by `please`
and must produce the same value. Every new boundary acceptance proof names a capable positive and
negative input; an empty fixture, unreachable branch, or assertion that cannot observe the named
field does not count.

---

## Coverage map: all 26 round-3 revision items

| Item | Severity | Decision |
| --- | --- | --- |
| 1 | major | D74 |
| 2 | major | D74 |
| 3 | major | D74 |
| 4 | major | D74 |
| 5 | major | D73 |
| 6 | minor | D77 |
| 7 | major | D74 |
| 8 | major | D74 |
| 9 | major | D74 |
| 10 | major | D74 |
| 11 | major | D74 |
| 12 | major | D74 |
| 13 | major | D74 |
| 14 | major | D74 |
| 15 | major | D70 |
| 16 | blocker | D73 |
| 17 | major | D78 |
| 18 | major | D70 |
| 19 | blocker | D72, D79 |
| 20 | blocker | D77 |
| 21 | blocker | D74, D79 |
| 22 | blocker | D75 |
| 23 | blocker | D76 |
| 24 | major | D79 |
| 25 | minor | D73, D79 |
| 26 | blocker | D73 |

## Coverage map: all 55 revision items

| Item | Severity | Decision |
| --- | --- | --- |
| 1 | blocker | D3 |
| 2 | blocker | D2 |
| 3 | blocker | D4 |
| 4 | major | D21 |
| 5 | major | D22, D5 |
| 6 | major | D20 |
| 7 | minor | D20 |
| 8 | minor | D33 |
| 9 | minor | D22, D33 |
| 10 | blocker | D13 |
| 11 | major | D25 |
| 12 | major | D19 |
| 13 | major | D32 |
| 14 | minor | D10 |
| 15 | minor | D36 |
| 16 | minor | D31 |
| 17 | minor | D30 |
| 18 | blocker | D6 |
| 19 | blocker | D12 |
| 20 | blocker | D7, D14 |
| 21 | major | D5 |
| 22 | major | D12 |
| 23 | major | D34, D5 |
| 24 | minor | D24, D10 |
| 25 | minor | D33 |
| 26 | blocker | D5, D1 |
| 27 | blocker | D12 |
| 28 | blocker | D3, D1 |
| 29 | blocker | D11, D1 |
| 30 | major | D31 |
| 31 | major | D23 |
| 32 | major | D7, D14 |
| 33 | major | D12 |
| 34 | major | D12 |
| 35 | major | D16, D1 |
| 36 | minor | D27 |
| 37 | minor | D26, D5 |
| 38 | minor | D19 |
| 39 | minor | D28 |
| 40 | minor | D29 |
| 41 | minor | D16, D1 |
| 42 | blocker | D6 |
| 43 | blocker | D8 |
| 44 | medium | D17, D1 |
| 45 | medium | D9 |
| 46 | blocker | D10 |
| 47 | blocker | D18 |
| 48 | medium | D14 |
| 49 | medium | D15 |
| 50 | blocker | D13 |
| 51 | blocker | D17, D8, D1 |
| 52 | blocker | D18 |
| 53 | blocker | D5 |
| 54 | blocker | D6 |
| 55 | medium | D5 |

Every item maps to at least one decision. No item is rejected.

---

## Coverage map: all 42 round-2 items

Source: `revision-inputs-round2.json`. Same rule as the 55-item map above: every item maps to at
least one decision, and no item is rejected. Eight were judgment calls settled as D61-D68, three
opened decision-level gaps settled as D69-D71, and the rest resolve against decisions that already
existed.

| Item | Severity | Decision |
| --- | --- | --- |
| 1 | minor | D53 |
| 2 | major | D50 |
| 3 | medium | D51 |
| 4 | medium | D52 |
| 5 | blocker | D60 |
| 6 | minor | D5 |
| 7 | major | D66 |
| 8 | major | D12, D19 |
| 9 | blocker | D57 |
| 10 | major | D68 |
| 11 | blocker | D58 |
| 12 | minor | D45, D66 |
| 13 | minor | D22, D61 |
| 14 | major | D70 |
| 15 | major | D6 |
| 16 | blocker | D64 |
| 17 | blocker | D51 |
| 18 | blocker | D65 |
| 19 | major | D67 |
| 20 | major | D71 |
| 21 | minor | D38, D20 |
| 22 | blocker | D61 |
| 23 | blocker | D63 |
| 24 | blocker | D62 |
| 25 | blocker | D69 |
| 26 | blocker | D58 |
| 27 | blocker | D54 |
| 28 | blocker | D54 |
| 29 | blocker | D57 |
| 30 | major | D56, D62 |
| 31 | major | D55 |
| 32 | major | D59 |
| 33 | minor | D60 |
| 34 | major | D59 |
| 35 | major | D55 |
| 36 | major | D55 |
| 37 | major | D55 |
| 38 | major | D60 |
| 39 | major | D54 |
| 40 | major | D56 |
| 41 | major | D57 |
| 42 | major | D58 |

---

## Constraints that bound every phase

- Zero runtime dependencies. Node built-ins and the system `git` CLI only.
- Node >= 18 APIs only. CI runs Node 18, 20, 22 on ubuntu with zero install.
- Cross-platform paths; normalize before comparing.
- Clean-room: no real names, paths, repo names or emails anywhere in the repo.
- `display`-role repos are never git-read.
- Redact before disk. Inside this feature, redaction runs before truncation on the **new** fields
  only (sidecar text, window and idea projections). The legacy adapter reorder is **not** in scope
  here: D61 splits it into its own issue and PR, landing before Phase 1.
- Never auto-publish.
- Baseline suite: **371 tests pass**. Run `node --test` from the repo root with no path argument.
