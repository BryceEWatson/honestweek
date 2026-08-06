## In plain terms

honestweek tells you what you shipped last week. It can't yet tell you *how you got there*: which
ways of asking actually worked, and which ideas came up that you haven't done anything with. This
epic adds both in four implementation work packages. Phases 1 and 2 share one release gate; Phases 3
and 4 must each ship independently. The hard part is that "this prompt worked well" is exactly
the kind of unprovable claim honestweek exists to refuse, so the deterministic engine computes the
evidence and the model's only job is to name the technique in plain words.

## What you're deciding

Whether to build two new output bands, and whether the four-phase split below is the right order.

Merging this epic changes nothing on its own. It's the parent for four issue scopes. Phases 1 and 2
are implemented together and checkpointed behind one release decision because the identity producer
and its first authoritative consumer must advance together. What all four scopes change:

- **New:** two bands in `digest`, `report`, `page` and `post` output. One names techniques with the
  measured evidence behind them. One lists ideas that came up, where each came from, and what
  happened to it.
- **New:** a gitignored `honestweek.prompts.json` sidecar holding source-faithful prompts after
  redaction locally, so the model can read what you actually asked for. The private record is never
  published or committed. A separate public-safe rendition remains behind the control plan's
  unresolved triage gate.
- **New:** one config key, `redaction.strictLaneNouns`, off by default.
- **Unchanged:** absent the new inputs, every emitted byte stays identical. Phase 1 changes no
  rendered byte at all.
- **Unchanged:** `build` still exits 2 and writes nothing on a positive dishonesty hit. What changes
  is that a *missing* session corpus now drops the band loudly and still gives you your work report,
  instead of losing the whole week's output to an optional bonus band.

This also closes **#52 item 4** (handoff next-steps render as a carried-forward band) and **#52
item 5** (mined reversals reach the output), because those are the same two code surfaces, not
adjacent ones. Building them separately would mean rewriting the same extractor twice and shipping
two forward-looking vocabularies. Badge taxonomy is coordinated with **#50 item 7** so it doesn't
fork: `STATUSES` gains no member here, and the three pill vocabularies share one render primitive so
#50 item 7 adds a member rather than a fourth parallel system.

## Why it's four phases and not three

An earlier three-phase plan failed review three times: 55 outstanding revision items, 20 of them
blocking, and an independent consistency check returned `implementationOrderIsSound: false`. The
split was the problem, not the wording. Phase 3 consumed identifiers phase 1 never created, it
re-decided rendering policy phase 2 had already settled, and it bundled the within-week band
together with the cross-week state machine, which is where a third of the defects lived.

The four-phase version was audited too, and it also failed the first time: 42 more items came back,
14 of them blocking, including three acceptance criteria that passed only because the fixture they
used couldn't produce the case they tested. Those are fixed and re-audited. I'm stating the defect
rate rather than the decision count because the count is what makes a plan look finished, and the
rate is what tells you whether it is. A final 26-item round then found producer/consumer contracts
that the mechanical checks could not see. D73-D79 close those boundaries, and the readiness gate now
requires an exact-schema ledger plus closure, consistency, and adversarial audits.

The four work packages now split on where the risk actually is:

1. **Evidence substrate.** All the deterministic mining, and every identifier later phases key on.
   Renders nothing, so "no output changed" is provable rather than argued.
2. **Lane substrate and "what worked".** Every rendering policy authored once, at final wording.
   Phases 3 and 4 add rows and a vocabulary, never a rewording.
3. **"Ideas raised", within a single week.** Closes #52 items 4 and 5.
4. **Carrying ideas across weeks.** The only part needing state that survives a build. Split out so a
   defect here can't strand #52.

## Guarantees that hold across all four

- Zero runtime dependencies. Node built-ins and the system `git` CLI only.
- Additive: absent its new inputs, existing output is byte-identical.
- Verify or abort: `build` exits 2 writing nothing rather than emit a half-true summary.
- `display`-role repos are never git-read.
- Keep the private prompt private. A distinct public-safe rendition may surface automatically only
  after the control plan's strong-material, minor-transform, deterministic-validation, and residual-
  risk thresholds pass; ambiguous or unusual cases require approval and persistent high risk is
  excluded. This contract is not yet implementation-ready.
- Every lane row renders a receipt, styled so it can't be misread as a commit. This satisfies the
  README's "a receipt on every line" promise rather than narrowing it.
- Nothing uploads or leaves the local build. “Public” prompt handling means inclusion in a
  public-facing local artifact, not network publication.

## One thing lands before phase 1

A separate privacy fix, filed as its own issue: honestweek currently shortens mined strings before
it scrubs them, so an email address sitting past the cut point survives in fragments. Swapping the
two steps changes bytes in local drafts people already have, which makes it not additive.

An earlier draft of this epic folded that fix into phase 1 and covered the byte change by rewriting
`AGENTS.md` invariant 6 to name it an exception. That's rewriting a rule to excuse breaking it, so
it's split back out and lands on its own terms first. Invariant 6 keeps its meaning, and everything
in this epic stays additive.

## Implementation detail

Settled decisions, phase specs, and the mechanical verifiers are intentionally tracked under
`.claude/work/prompt-lanes/spec-v2/`; the repaired baseline is checkpoint `9e30b0a`. Machine-local
paths were replaced with clean-room placeholders before that checkpoint.

- `decisions.md` holds 79 numbered cross-phase decisions across six addenda. Every phase spec
  references a decision by id and never restates its wording, which is what kept two phases from
  inventing conflicting answers to the same question. Later addenda reverse earlier decisions where
  an audit showed them wrong, and the reversal wins.
- `phase-assignment.md` maps each decision to the phase that builds it, and lists the four decisions
  that deliberately bind no phase, each with its reason.
- `verify-refs.mjs` checks three things: that every backticked repo path in a spec exists, that
  every entry in the `claims*.json` table resolves to a line containing its quoted token, and that
  every inline `path:line` citation has a matching claims entry so the table is the complete record.
  It does not parse and semantically verify inline citations on its own; an earlier version of this
  epic claimed it did, which was the same kind of unbacked claim the product refuses. Extending it
  is a separate follow-up.
- `verify-coverage.mjs` loads all three revision-input files from a checksummed manifest, checks that
  every revision item maps to a decision, that
  every decision is assigned to a phase or explicitly exempted with a reason, and that every phase
  spec cites the decisions assigned to it.
- `producer-consumer-ledger.json` gives every cross-phase boundary an exact schema, error behavior,
  privacy class, and capable positive/negative controls. `verify-contracts.mjs` checks that ledger,
  the source-backed invariant diffs, audit verdicts, and manifest hashes.
- All verifiers are model-free and exit non-zero on a gap. `verify-refs.mjs --self-test` proves the
  citation check can actually fail.
- `implementation-control-plan.md` separates contract readiness from product readiness, maps each
  work package to the reader-visible result, and prevents implementation while deletion, selection,
  public-prompt triage, or carry-lifecycle decisions remain open.

Two measured findings that shaped the design:

- **Slash-command turns.** The rejected plan keyed the command branch on a record's opening
  `<command-name>` tag. Measured over `~/.claude/projects` twice, on different 300-file slices:
  `<command-message>` opens 43 and 24 of the string user turns in those slices, `<command-name>`
  opens 6 and 1. The repo's own fixture `test/fixtures/claude-projects/proj-automated/sessE.jsonl`
  is the common shape. The branch is now defined by content, and one acceptance fixture is byte
  shaped like that file.
- **The prose boundary is currently unguarded.** An audit added a verbatim-prompt field to the
  public digest entry and all 371 tests still passed. Phase 1 adds the structural assertion that
  would have failed it.

Baseline: 371 tests pass. Run `node --test` from the repository root with no path argument.
