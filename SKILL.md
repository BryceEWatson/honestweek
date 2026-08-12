---
name: honestweek
description: Turn a completed week of your AI coding sessions into an honest, git-verified, private-by-default work summary. Run /honestweek to scaffold config, discover the week's sessions into a redacted digest, distil it into reviewable work items with a status badge and receipt, build it with verify-or-abort, and review the draft before you publish it yourself. Automatic session-derived digest items carry receipts without claiming work status. honestweek never auto-publishes.
disable-model-invocation: true
---

# honestweek

honestweek is a Claude Code skill that orchestrates a set of small, zero-dependency Node scripts to turn a week of your AI coding **sessions** into an honest, shareable work summary. It refuses to ship a single unverifiable claim. The git log only records what got committed; your session transcripts hold the richer record (what you figured out, the approaches you tried and dropped, the work you designed but haven't yet shipped). honestweek reasons over those transcripts, distils them into a reviewable set of items, and re-derives every git-checkable claim against your real commits before emitting anything.

Every other stage is deterministic code. **DISTIL is the one place a model puts words into the output**, so the contract it must obey (below) is a load-bearing honesty boundary for the whole product.

See the v0.1 epic and the repo Issues for cross-cutting decisions (config schema, digest schema, badge taxonomy, redaction guarantees); this skill references them rather than restating them in full.

## Orchestrator flow: `init` → `discover` → **DISTIL** → `build` → `review`

For `page` or `site` output, `honestweek digest prepare` is an additive input to the same build when the opt-in goals registry is absent. It scans local Claude Code and Codex transcripts, keeps raw source private, and writes a gitignored redacted review plus a validated public-safe lane across prompts, ideas, techniques, decisions, reversals, and next steps. The balanced digest lane and the goals page are not yet compatible; use the existing distillation path when the goals registry is present. Every visible item states its deterministic selection reason and carries a transcript receipt. Configured floors, the overall target, category caps, omitted counts, and uncertainty are disclosed. The low-risk privacy gate applies to every category; ambiguity and residual high risk remain private. Use `honestweek digest keep`, `hide`, `delete <item-ref> --yes`, or `delete --all --yes` to control candidates in any category. Keep cannot bypass receipt or privacy gates; delete leaves a no-text tombstone and cannot recall an already-built page. `digest reset-tombstones <item-ref>|--week <YYYY-Www>|--all --yes` is the only regeneration control.

Codex ingestion is limited to regular JSONL files under `$CODEX_HOME/sessions` and `archived_sessions`, excluding `subagents`. A Voice or dictated turn is treated as an ordinary prompt only when its transcript is present as a standard Codex user-message string. Audio, images, reasoning, and tool-output content are excluded. Recognized paired shell records retain only the observed-verification boolean; current Codex `exec` wrappers are parsed without evaluation and fail closed unless one closed wrapper forwards an unchanged successful shell result. A valid prompt from a session with no final assistant message may still contribute to public-safe lexical recurrence; missing or unconfigured repository attribution makes it private, and private or hidden turns cannot contribute to recurrence or automatic output. An ambiguous human prompt stays out of prompt recurrence and prompt output. Its labelled cues retain the prompt's conservative audit, while an assistant-final cue is gated separately on its own redacted rendition and exact receipt. Raw Codex source retention is outside honestweek. This path writes the current redacted prompt store, persistent no-text deletion tombstones, and bounded redacted carry.

Selected next steps and `unresolved idea:` cues carry for at most two following reporting weeks under the current automatic floor, target, caps, and privacy gate. `digest carry-forward <item-ref>` renews one current public-safe candidate for exactly the next digest. Exact human `picked up:` and `ruled out:` cues retire one unambiguous match. Carry history is redacted before disk and bounded to 12 week records. A successful `build` advances carry only after the exact configured output bytes are installed. `digest recover` reconciles an interrupted output/carry transaction by hashes; `--discard-pending` is allowed only when output differs and carry remains at its prior hash. Unknown state fails closed. `validate` plus `build` re-scan the sources before the existing page-generation pipeline writes anything. `honestweek prompts curate` remains the prompt-only compatibility path, with `list`, `source`, `keep`, `hide`, and `delete` prompt controls.

Drive the pipeline in this exact order. Each stage names its input and its output artifact.

**Running the bundled CLI.** honestweek ships a Node CLI bundled with this skill. Run the commands below from the **user's project directory** (so the config and sidecars land there), but invoke the script by its **skill-anchored absolute path**. `${CLAUDE_SKILL_DIR}` resolves to this skill's own install directory, so the path works regardless of the current working directory (personal, project, or plugin install). If `${CLAUDE_SKILL_DIR}` is ever not substituted in your environment, fall back to the absolute path of the directory containing this `SKILL.md`.

1. **`init`** *(input: none; output: `honestweek.config.json`)*
   Run `node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" init`. It writes `honestweek.config.json`, inferred from your git state (your `git config user.email` plus the nearby git repos it finds), **only when the config is absent; it never overwrites an existing config**. The user fills in `identity.authorEmails`, the repo allowlist + roles, and `output.mode`, then commits it themselves.

2. **`discover`** *(input: your allowlisted repos' session transcripts; output: `honestweek.draft.json`)*
   Run `node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" discover`. It reads the last completed week's interactive sessions **and the session-end handoffs** (`.claude/handoffs/*.md` for `featured`/`reference` repos; `display` repos are never read) from your allowlisted repos and writes the gitignored, fully **redacted** weekly digest `honestweek.draft.json` (a `sessions[]` array plus a `handoffs[]` array of tagged claims, reversals, and cited SHAs). This is a deterministic step: no model call. Distil from these fields; never lift them verbatim.

3. **DISTIL** *(input: `honestweek.draft.json`; output: `honestweek.items.json`)*
   **This is the single model-judgment step, performed by you (the model) under the contract below; it is NOT a Node subcommand.** Read `honestweek.draft.json` and write `honestweek.items.json`: a human-reviewable set of narrative items, each carrying a `status` badge and a `receipt`. The user reviews and edits this file.

4. **`build`** *(input: `honestweek.items.json`; output: `output.file`)*
   **First gate the distilled items**: run `node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" validate` (it exits 2 if any item lacks a valid badge or a receipt, names a `display`-role repo or cites a commit against one, or leaks a configured redaction term into the prose; add `--no-dashes` for the voice rule). Fix every flagged item in `honestweek.items.json` before building. Then run `node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" build`. It re-derives and **verifies every git-checkable claim** from the cited commits and renders the configured output (`output.mode` = `post` / `changelog` / `digest` / `report`). **`build` aborts with exit code `2` on any unresolved or non-authored cited commit** (and, when the opt-in `voice.denyMeta` is enabled, on authored prose that narrates its own withholding or announces the page's own honesty — the prose analogue of the numeric fact-fence); it writes nothing rather than emit a half-true summary. `build` also enforces the **landed gate**: a `shipped` item whose cited commits have not landed on the repo's default branch (checked offline from local refs, never a fetch) is downgraded to `in progress` with a stderr note, and a `shipped` claim in a repo with no determinable default branch aborts as unverifiable.

5. **`review`** *(input: the build output; output: the user's decision)*
   Present the build output and a short summary of what was emitted to the user for review. Optionally run `node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" preview` to open the built output as HTML on a local-only `127.0.0.1` server in the user's browser (a viewer over the file `build` wrote; add `--no-open` to just print the URL, `--port <n>` to choose a port). **The user reviews and publishes it themselves. This step performs no publish action and sends nothing off the machine.**

## Distillation contract (the rules you MUST obey when writing `honestweek.items.json`)

The digest is already redacted before you see it. Turning it into items is the one place you author output, so these rules are not advisory: they are the product's honesty guarantee in prose form. `build`'s verify-or-abort is the deterministic backstop, but this contract must keep you from emitting an unsupported claim in the first place.

1. **Draft-and-distil, never lift verbatim.** Write each item in your own plain prose synthesised from the digest fields. Do **not** paste digest strings (`steers`, `assistantNotes`, commit subjects) verbatim into item text.
2. **Plain, subject-led voice.** Lead each item with the concrete subject/thing changed, not "I" and not a generic "worked on…". No hype, no marketing tone.
3. **Honest badge per item.** Every item carries exactly one `status` from `STATUSES = ['shipped', 'in progress', 'designed, not proven']`, assigned via the `statusForTag` mapping (verified/measured → `shipped`; assumed/unverified → `designed, not proven`; in-progress markers → `in progress`). When evidence is mixed or ambiguous, choose the **weaker** badge. `shipped` additionally requires every cited commit to have **landed** on the repo's default branch; `build` re-checks this offline from local refs and downgrades an unlanded `shipped` to `in progress`, so cite the sha that actually landed (after a squash merge, that is the squash commit on the default branch, not the original branch commit).
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

`build` re-derives each cited commit's subject and date from git; it **never trusts** values you carry in the items file. A commit you cite that does not resolve, or was not authored by `identity.authorEmails`, **aborts the build (exit 2)**. A `shipped` item whose cited commits are real but have not landed on the repo's default branch keeps its receipt and is downgraded to `in progress` (announced on stderr, never silent). Do not paper over a missing receipt to keep an item.

## Safety invariants (non-negotiable)

- **Private by default.** Only the user's own allowlisted repos are read. The redaction layer has **already** run before distillation: you must not re-introduce anything the digest omitted, and `isPrivate` / `display` sessions stay at a single generic line with no commit, repo, or file paths.
- **Verify or abort.** Every git-checkable claim is re-derived at `build`; an unresolved or non-authored commit **aborts the build (exit 2)**, writing nothing. A `shipped` badge must also be **landed**: every cited commit reachable from the repo's default branch, verified offline from local refs. Unlanded work is downgraded to `in progress`, and a `shipped` claim that cannot be checked (no determinable default branch) aborts. There is no half-true output.
- **Human gate: honestweek never auto-publishes.** `review` shows the build output and the emitted-items summary; **the USER is the publisher.** Nothing is posted in the user's voice automatically.
- **Local-only preview.** The optional `preview` server binds to loopback (`127.0.0.1`) only, renders the built output in memory as a self-contained page (no external resources), and publishes nothing. It is a viewer, not a producer: it never re-runs `build`, calls git, or writes a file.
- **A mined draft asserts nothing about today.** `mine --draft` writes a post from old session logs. Its last-verified field is emitted **empty**, its publication date is left blank, and every item on its verification checklist starts `UNVERIFIED`. Do not fill any of them in on the user's behalf: they record whether a human re-ran the checks, and pre-filling them would launder a past observation into a present-tense claim. If asked to help publish one, work the checklist first and say plainly which items you could not verify.

## Mining solved problems (`mine`)

A separate, optional flow from the weekly digest. It searches the user's agent session logs for moments where software they did **not** write failed and they worked out the fix — the kind of thing a stranger will hit and search for.

```bash
node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" mine            # report the undecided backlog
node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" mine --draft    # write the top one up
```

- Findings live in `honestweek.findings.json`. The number to report is the **backlog** — findings not yet accepted or declined — not how many this run found. Only the user deciding can lower it: `mine --decide "<key>=published"` or `=declined`.
- **Exit `2` means the sensor was blind:** a configured log corpus resolved to a real directory holding zero logs. Never report that as "nothing found this week"; say the corpus was empty and check the root.
- Every run prints a retention floor — the oldest session still on disk. Nothing before it can ever be mined, because the agent deleted it.

Full detector, ranker, and calibration notes: `docs/mining.md`.

## Clean-room

This is a fresh, generic skill. It ships with no hardcoded personal data (no real names, paths, repo names, author emails, or codenames), and every example above uses obviously generic placeholders (`you@example.com`, `/path/to/your/repo`, `your-project`).
