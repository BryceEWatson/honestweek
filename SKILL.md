---
name: honestweek
description: Turn a completed week of your AI coding sessions into an honest, git-verified, private-by-default work summary. Run /honestweek to scaffold config, discover the week's sessions into a redacted digest, distil it into reviewable items (each with a status badge + receipt), build it with verify-or-abort, and review the draft before you publish it yourself. honestweek never auto-publishes.
---

# honestweek

honestweek is a Claude Code skill that orchestrates a set of small, zero-dependency Node scripts to turn a week of your AI coding **sessions** into an honest, shareable work summary — and refuses to ship a single unverifiable claim. The git log only records what got committed; your session transcripts hold the richer record (what you figured out, the approaches you tried and dropped, the work you designed but haven't yet shipped). honestweek reasons over those transcripts, distils them into a reviewable set of items, and re-derives every git-checkable claim against your real commits before emitting anything.

Every other stage is deterministic code. **DISTIL is the one place a model puts words into the output**, so the contract it must obey (below) is a load-bearing honesty boundary for the whole product.

See the v0.1 epic and the repo Issues for cross-cutting decisions (config schema, digest schema, badge taxonomy, redaction guarantees) — this skill references them rather than restating them in full.

## Orchestrator flow: `init` → `discover` → **DISTIL** → `build` → `review`

Drive the pipeline in this exact order. Each stage names its input and its output artifact.

1. **`init`** — *(input: none; output: `honestweek.config.json`)*
   Run `node bin/honestweek.mjs init`. It scaffolds `honestweek.config.json` from `honestweek.config.example.json` **only when the config is absent — it never overwrites an existing config**. The user fills in `identity.authorEmails`, the repo allowlist + roles, and `output.mode`, then commits it themselves.

2. **`discover`** — *(input: your allowlisted repos' session transcripts; output: `honestweek.draft.json`)*
   Run `node bin/honestweek.mjs discover`. It reads the last completed week's interactive sessions from your allowlisted repos and writes the gitignored, fully **redacted** weekly digest `honestweek.draft.json`. This is a deterministic step — no model call.

3. **DISTIL** — *(input: `honestweek.draft.json`; output: `honestweek.items.json`)*
   **This is the single model-judgment step, performed by you (the model) under the contract below — NOT a Node subcommand.** Read `honestweek.draft.json` and write `honestweek.items.json`: a human-reviewable set of narrative items, each carrying a `status` badge and a `receipt`. The user reviews and edits this file.

4. **`build`** — *(input: `honestweek.items.json`; output: `output.file`)*
   Run `node bin/honestweek.mjs build`. It re-derives and **verifies every git-checkable claim** from the cited commits and renders the configured output (`output.mode` = `post` / `changelog` / `digest`). **`build` aborts with exit code `2` on any unresolved or non-authored cited commit** — it writes nothing rather than emit a half-true summary.

5. **`review`** — *(input: the build output; output: the user's decision)*
   Present the build output and a short summary of what was emitted to the user for review. **The user reviews and publishes it themselves. This step performs no network or publish action.**

## Distillation contract (the rules you MUST obey when writing `honestweek.items.json`)

The digest is already redacted before you see it. Turning it into items is the one place you author output, so these rules are not advisory — they are the product's honesty guarantee in prose form. `build`'s verify-or-abort is the deterministic backstop, but this contract must keep you from emitting an unsupported claim in the first place.

1. **Draft-and-distil, never lift verbatim.** Write each item in your own plain prose synthesised from the digest fields. Do **not** paste digest strings (`steers`, `assistantNotes`, commit subjects) verbatim into item text.
2. **Plain, subject-led voice.** Lead each item with the concrete subject/thing changed — not "I" and not a generic "worked on…". No hype, no marketing tone.
3. **Honest badge per item.** Every item carries exactly one `status` from `STATUSES = ['shipped', 'in progress', 'designed, not proven']`, assigned via the `statusForTag` mapping (verified/measured → `shipped`; assumed/unverified → `designed, not proven`; in-progress markers → `in progress`). When evidence is mixed or ambiguous, choose the **weaker** badge.
4. **Receipt on every item.** Every item carries a `receipt` pointing to its source: the digest session `id` and/or a `primaryCommit` (a candidate-commit SHA from that session). **No item ships without at least one receipt.**
5. **Never over-claim.** Do not assert a motive, cause, or outcome the digest does not support. Default to **under-claiming**; if the digest only shows a symptom, do not narrate intent.
6. **Private/display sessions get a generalized one-line entry.** A session flagged `isPrivate` (and any `display`-role repo) produces **at most one** generic, non-specific line with **no commit SHA, no repo name, and no file paths**. These items are never git-read or git-verified.

### Item shape

Each item in `honestweek.items.json` carries:

```jsonc
{
  "text": "Plain, subject-led prose describing the work.",
  "repo": "<repo label from config, or omitted for a private/display line>",
  "status": "shipped | in progress | designed, not proven",
  "tag": "verified | measured | in-progress | assumed | unverified",  // optional; build maps it via statusForTag
  "receipt": { "sessionId": "<digest session id>", "primaryCommit": "<candidate-commit SHA>" }
}
```

`build` re-derives each cited commit's subject and date from git — it **never trusts** values you carry in the items file. A commit you cite that does not resolve, or was not authored by `identity.authorEmails`, **aborts the build (exit 2)**. Do not paper over a missing receipt to keep an item.

## Safety invariants (non-negotiable)

- **Private by default.** Only the user's own allowlisted repos are read. The redaction layer has **already** run before distillation — you must not re-introduce anything the digest omitted, and `isPrivate` / `display` sessions stay at a single generic line with no commit, repo, or file paths.
- **Verify or abort.** Every git-checkable claim is re-derived at `build`; an unresolved or non-authored commit **aborts the build (exit 2)**, writing nothing. There is no half-true output.
- **Human gate — honestweek never auto-publishes.** `review` shows the build output and the emitted-items summary; **the USER is the publisher.** Nothing is posted in the user's voice automatically.

## Clean-room

This is a fresh, generic skill. It ships with no hardcoded personal data — no real names, paths, repo names, author emails, or codenames — and every example above uses obviously generic placeholders (`you@example.com`, `/path/to/your/repo`, `your-project`).
