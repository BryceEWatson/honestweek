# Site integration (the `site` output): design

How honestweek produces a **website-integrated** weekly artifact for a target
project that contains a website, intelligently and generically, without ever
weakening verify-or-abort, private-by-default, the human gate, or clean-room.

This is the generic capability. brycewatson.com is the first real integration
(see that repo's `honestweek.site.json` adapter); nothing here is specific to it.

## Status (branch `feature/site-integration`)

**Implemented + tested (Phase A complete):** the closed-grammar adapter validator
(`lib/site/adapter.mjs`), the value context (`lib/site/values.mjs`), the
deterministic fact-fence (`lib/site/fact-fence.mjs`), the emit resolver
(`lib/site/emit-site.mjs`), the shared week grid (`lib/site/week-grid.mjs`), the
git/session derivers (`lib/site/derive.mjs`, `lib/site/sessions.mjs`), site
detection + schema inference (`lib/site/detect.mjs`, `lib/site/inspect.mjs`), and
the `site` output-mode wiring (`config.mjs` `OUTPUT_MODES` + `output.adapter`;
`emit/index.mjs` dispatch; `build.mjs` model augmentation + exit-2 mapping for a
fence abort). Covered by `test/site-adapter`, `site-emit`, `site-fact-fence`,
`site-sessions`, `site-derive`, `site-detect`, `site-cleanroom`, and `site-build`.

**Pending (Phase B onward):** the brycewatson.com committed adapter + the
parity-gate harness (Stage-1 pixel + Stage-2 content). One grammar increment is
deliberately deferred to Phase B, where it can be designed against the real
artifact: emitting a TRUSTED, value-free STRING structure (e.g. an author-email or
repo-label array) — `derivedTree` is numeric-only by design (a string leaf is
rejected, so prose can't bypass the fence), and the scalar grammar has no
primitive-array node yet. If the target's byte-parity needs one, it gets a
purpose-built, value-free mechanism then.

## The pipeline

```
discover -> DISTIL -> build (verify-or-abort) -> assemble reportModel -> redact
   -> [ INSPECT the target site ]            (deterministic; assists the skill)
   -> [ ADAPT: skill authors honestweek.site.json ]   (the ONE runtime-intelligent step; committed + human-reviewed in the TARGET repo)
   -> EMIT-SITE: resolve the adapter against the verified model   (deterministic, resolve-or-throw)
   -> FACT-FENCE: re-scan the emitted bytes; abort on any unverifiable number   (deterministic)
   -> write the site artifact (local; the existing PR flow publishes)
```

The model adapts to an unseen site at runtime (it authors the adapter by
inspecting the site), but it is **structurally off the value path**: the adapter
grammar has no source kind by which a raw number becomes a claim, and the
fact-fence re-checks the final bytes regardless of what the adapter says.

## The closed source-kind grammar (`lib/site/adapter.mjs`)

The adapter (`honestweek.site.json`, committed in the target repo) maps each
field of the site's artifact to ONE source kind. The set is closed:

| kind | fills with | numeric literal? |
| --- | --- | --- |
| `const` | a literal NON-numeric constant (labels, colours, static copy) | forbidden |
| `derived` | a SCALAR value from honestweek's generic derived registry (a count, date, or metric), re-derived from git/sessions | n/a (not a literal) |
| `derivedTree` | a whole derived NUMERIC sub-structure embedded wholesale (a dynamic-keyed count map / number array the scalar grammar can't express). Numbers re-walked by the fence; STRING leaves forbidden (would dodge the prose check); object keys may be trusted labels | n/a (resolves a key) |
| `model` | a model-distilled STRING already in the verified model (an item's text) | n/a |
| `freetext` | authored prose; every numeral in it must trace to a derived value (enforced at emit) | checked |
| `omit` | the field is absent | n/a |

A numeric literal is illegal in every kind. `const` forbids it directly;
`derived`/`derivedTree` resolve a key into the trusted registry (never a literal);
the fact-fence is the backstop for any that slips through.

Adapter shape:

```jsonc
{
  "artifact": "src/data/work-log.json",          // where to write, relative to target root
  "clockFields": ["meta.generatedAt", "meta.updatedLabel"], // excluded from the parity diff
  "volatileFields": ["chart.days[].isToday"],     // set deterministically from `now`, excluded from parity
  "tree": <Node>
}
```

`Node` is recursive:
- object: `{ "type": "object", "props": { "<key>": Node, ... } }`
- array (templated over a derived collection): `{ "type": "array", "over": "<collectionKey>", "item": Node }` — `item` leaves resolve `derived`/`model` keys against the CURRENT element.
- leaf: a directive `{ "source": <kind>, ... }` (`value` for const/freetext; `key` for derived/model).

`validateAdapter(spec)` is pure (returns `{ ok, problems }`, never throws): it
checks the structure, that every `source` is in the closed set, that `const` is
non-numeric, and that `derived`/`model` carry a key and no literal value. It
knows the GRAMMAR, never any site's field names.

## The generic derived registry (`lib/site/values.mjs`)

`buildValueContext(siteModel)` exposes resolve-or-throw accessors over the
verified, redacted model (augmented with the derived sections below). Keys are
GENERIC (the adapter maps a site's field names onto these), e.g.:

- `week.start`, `week.end`
- `provenance.itemsTotal`, `provenance.itemsVerified`, `provenance.commitsVerified`, `provenance.redactions`
- `groups`, `group[<label>].metrics.commits|activeDays|entries`
- `chart.days` (collection), `chart.max`
- `sessions.total`, `sessions.days` (collection), `sessions.<field>` — **session-derived, labeled NOT git-verified**
- `items` / `item.text` (model strings)

It also computes `verifiedNumbers`: the SET of finite numbers seeded from the
EXPLICITLY TRUSTED derived roots (`chart`, `sessions`, `provenance`, and each
group's git-derived `metrics`) — never the whole model. Derived date STRINGS
(e.g. `week.start`) are not numeric leaves and are not prose-scanned, so their
digits are not required to be verified. **Verified-number provenance (resolved):**
seeding from named trusted roots makes the guarantee STRUCTURAL — a future
model-authored numeric field elsewhere in the model could not silently become a
"verified" number. See `seedVerifiedNumbers` / `TRUSTED_ROOTS` in `values.mjs`.

`derived(key)` / `model(key)` / `collection(key)` THROW on an unknown key — the
same loud-fail posture as `_shared.mjs` `badge()/receiptPointer()/itemText()`.

## Emit + fact-fence (`lib/site/emit-site.mjs`, `lib/site/fact-fence.mjs`)

`renderSite(siteModel, adapter)`:
1. `buildValueContext(siteModel)`.
2. Walk `adapter.tree`; resolve each leaf (resolve-or-throw); iterate arrays over
   `collection(over)`; record EVERY string-valued leaf as prose — `freetext`,
   `model`, AND any `const`/`derived` that resolved to a string. (A `derived` key
   can path into model substructure, and a `const` is author-supplied text, so
   both could carry a quantity; scanning them too means no source kind is a fence
   bypass. `derivedTree` carries no string leaves — they are rejected at resolve.)
3. `factFence(artifact, verifiedNumbers, proseLeaves)` before returning.

`factFence(artifact, verifiedNumbers, proseLeaves)`:
- Every NUMERIC leaf must be finite AND byte-equal to a value in `verifiedNumbers`,
  else THROW (a non-finite leaf is always a violation — it would serialize to
  `null` silently otherwise).
- Every PROSE leaf: extract stated quantities — comma-grouped digit runs
  (`1,200` → 1200) and composed spelled-out numbers (`two hundred` → 200,
  `twenty three` → 23); each must be a verified number, else THROW. ISO
  date/datetime and hex-sha tokens are exempted first (a date or a receipt is not a
  work-claim), so a trusted derived date string is not a false abort while a real
  quantity beside it still is. This closes the numbers-in-prose gap (`validate`
  does not check prose numerals; `redact` passes numbers through unchanged —
  `redact.mjs:221`).
- A throw is a verify-or-abort: `build` maps it to exit 2, writes nothing.

## Derivers (`lib/site/derive.mjs`, `lib/site/sessions.mjs`)

Deterministic derivers over the verified model + the user's real git/sessions.
`augmentSiteModel(model, ctx)` returns `{ ...model, chart, sessions, provenance }`;
all three are seeded into `verifiedNumbers`. The seven Monday→Sunday day stubs come
from the shared `week-grid.mjs`, so a chart day and a session day never disagree.
- `deriveChart` — per-day commit `total` + `byRepo` (a dynamic-keyed count map) +
  `repoTotals`, from `commitsInWindow` per readable repo over the window. A
  display-role repo is NEVER git-read; an unreadable repo contributes nothing
  (never a fake zero-for-real). `chart.max` is the peak day total.
- `deriveProvenance` — `{ itemsTotal, itemsVerified, commitsVerified, redactions }`.
  `redactions` is filled by `build` AFTER the redaction pass (`redactor.count`).
  Note `itemsVerified == itemsTotal` BY CONSTRUCTION: `build` aborts before this
  runs unless every cited commit resolved, so the equality honestly asserts "0
  items failed verification" — it is NOT an independently-measured ratio, and an
  adapter must not render it as "N of M verified" implying it could be less.
  `commitsVerified` (count of re-derived commits) is the real verification signal.
- `deriveSessions` — interactive-session counts per day, with the SAME
  interactive-vs-automated classification + resume-dedup as the target
  (`isInteractiveFirstPrompt` mirrors the target's first-prompt classifier; dedup
  is by first-prompt timestamp; windowing is by the first-prompt's local date).
  **Labeled `session-derived`**: a deterministic count of local session-log files
  classified interactive (deduped) — a PROXY for "human work sessions", NOT
  git-commit-verified and NOT an exact session count. The classification +
  exact-timestamp dedup have known two-sided error (a classifier false-positive or
  a fresh-timestamp resume overcounts; a timestamp collision or a dropped
  unreadable head undercounts); the gap is surfaced, not hidden, via the emitted
  `filesScanned`/`automatedExcluded`/`undetermined`/`duplicatesSkipped` diagnostics.
  It is `verifiedNumbers`-eligible because it is reproducible from the inputs, not
  because it is an exact measure. Clean-room: project labels come from
  `config.repos` (cwd-match), never a hardcoded allowlist.

`augmentSiteModel` also reconnects the feed: each chart/session day carries that
day's items `{ id, title, status, project }`, placed by the item's git-derived
commit date (an item that cites no resolved commit has no day).

## Detection + schema inference (`lib/site/detect.mjs`, `lib/site/inspect.mjs`)

- `detectSite(rootDir)` — deterministic, framework-agnostic: reads `package.json`
  deps + conventional config files (astro/next/gatsby/eleventy/vite/…) + data
  directories, and reports `{ isSite, frameworks, signals, dataArtifacts, packageName }`. It
  hardcodes only public framework conventions, never one site.
- `inferSchema(sampleBytes)` — infers an artifact's STRUCTURE (types, keys, array
  element shapes, coarse string-format hints, a `dynamicKeyed` flag for count
  maps) from the REAL sample bytes, NOT a hand-written TS type (which drifts and
  omits keys the live JSON has). Value-free: it never echoes a scalar value, so
  inspecting an artifact cannot leak its contents.

## Two adapter styles

- **Static** (`honestweek.site.json`): the closed-grammar field map above. `renderSite`
  resolves it + runs the FULL fact-fence (numeric leaves + prose). Best for simple
  artifacts whose shape is a direct field mapping.
- **Transform** (`honestweek.site.mjs`): for artifacts that need GROUPING / gating /
  sorting / joins the static grammar can't express. The target commits a pure
  `transform(model, ctx)` + an `artifact` path export. honestweek runs it over the
  verified bundle and `renderSiteViaTransform` re-walks every NUMBER of the output
  against the verified set (and fails CLOSED on a Date/BigInt/boxed leaf that would
  serialize to digits). The guarantee is NARROWER than the static grammar's: STRINGS
  are NOT prose-scanned — in transform mode they are trusted, redacted, curated
  content the target owns and reviews (honestweek verifies the numbers, not the
  words). A transform that derives a number not in the bundle (e.g. its own redaction
  count under `output.redact:false`) declares it via
  `return { artifact, verifiedExtra:[n] }`.

**Honesty caveats (documented, not bugs):**
- The numeric fence is set-MEMBERSHIP: every output number must be SOME verified
  derived value. Calendar years (in `repos[].archive`) and window constants
  (`windowDays`/`monthsBack`) are legitimately in the output and thus in the set, so
  a fabricated count equal to one of them would pass — implausible for a weekly
  metric, but the fence is a coarse "no number that isn't a derived fact" net, not a
  per-field type-checker.
- `deriveChart`/`deriveArchive` mirror the integrated tool's git query EXACTLY
  (`--since/--until` window, which git prunes by COMMITTER date, while buckets use
  AUTHOR date). For byte-parity this reproduces the tool's behavior, including its
  edge: a rebased commit whose committer-date falls outside the window is undercounted
  identically to the tool. honestweek's generic `commitsInWindow` (author-date JS
  filter) has no such edge and is used everywhere else.
- Site mode writes to the TARGET's artifact, so honestweek's own `/log` archive
  (`output.archive`) is skipped in site mode (the target keeps its own archive).

## Wiring

- New output mode `site` in `config.mjs` (`OUTPUT_MODES`), requiring
  `output.adapter` (path to the committed adapter — `.json` static or `.mjs`
  transform, resolved like a repo path). `site` has NO entry in
  `DEFAULT_OUTPUT_FILES`: its write path is the adapter's own `artifact` (relative to
  the target root = build `cwd`). `build` assembles → `augmentSiteModel` → redacts
  (unless `output.redact:false`) → `emit/index.mjs`'s async `emitSite` dispatches by
  adapter extension (static `renderSite` vs transform `renderSiteViaTransform`) and
  writes the JSON artifact. `emit()` itself THROWS for site mode (it is async, via
  `emitSite`).
- `output.redact` (default true): honestweek scrubs every byte. A `site` target with
  its OWN redactor (applied inside the transform, for placeholder parity) sets it
  false to receive the raw bundle — **only permitted with a transform adapter** (a
  static `.json` adapter does not scrub strings, so `redact:false` there is rejected
  at config load). verify-or-abort + the numeric fence run regardless of `redact`.
- A fact-fence/resolve throw carries `.factFence === true`; `build` maps it to
  **exit 2** (verify-or-abort, nothing written), distinct from a config error (exit 1).
- No network, no publish: the artifact is a local write, exactly like every other
  emitter. The target's existing PR flow is the human publish gate.

## Parity gates (Phase B, in the target repo)

- **Stage 1 (visual, content held constant):** regenerate a FROZEN past week with
  the SAME verified items, render, screenshot the report element (the target's
  existing Playwright harness, element-scoped), and assert pixel-identical vs the
  current page, masking only `clockFields` + `volatileFields`. Because the page
  render is a pure function of the artifact, this reduces to a golden-bytes diff of
  the artifact (clock/volatile fields masked) plus one screenshot confirmation.
- **Stage 2 (content, equal-or-better):** re-distil the week from real sessions;
  diff generated content vs the live curated content item-by-item against a rubric
  (faithful, honestly badged, on-voice, nothing dropped); iterate; human signs off.

## Clean-room + tests (synthetic fixtures only)

All Phase-A tests use a SYNTHETIC toy site/model/adapter — never brycewatson.com
field names — which doubles as the clean-room guarantee. The full Phase-A suite:
- `test/site-adapter.test.mjs` — grammar validator (accept valid; reject numeric
  const, unknown source kind, literal in a derived slot, malformed array node, and
  the `derivedTree` key/value rules).
- `test/site-emit.test.mjs` — `renderSite` over a toy model+adapter -> golden toy
  artifact; `derivedTree` numeric maps; and that NO source kind (const/derived/
  derivedTree) bypasses the fence.
- `test/site-fact-fence.test.mjs` — passes a clean artifact; THROWS on an injected
  unverified numeric leaf and a numbers-in-prose violation; date/sha exemption.
- `test/site-sessions.test.mjs` — classifier + resume-dedup + windowing + per-day
  counts on synthetic session logs.
- `test/site-derive.test.mjs` — chart bucketing (display repos never read) +
  provenance counts + `augmentSiteModel` day-item placement, on synthetic git repos.
- `test/site-detect.test.mjs` — detects a synthetic framework signal; non-site ->
  false; `inferSchema` structure-only (value-free).
- `test/site-build.test.mjs` — end-to-end `site` build: deterministic artifact;
  fact-fence abort -> exit 2; `output.adapter` required.
- `test/site-cleanroom.test.mjs` — fails if any target-specific token appears in
  `lib/site/`.
```
