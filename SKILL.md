---
name: honestweek
description: Turn a completed week of your AI coding sessions into an honest, git-verified, private-by-default work summary. Use it when the user types /honestweek or explicitly asks for a weekly summary, weekly update or work report ("write up my week", "draft my weekly update"), not for a question about today's commits or for finding a session. It discovers the week's sessions into a redacted digest, distils it into reviewable work items with a status badge and receipt, builds them with verify-or-abort, and leaves a draft the user reviews and publishes themselves. With no config it stops and asks before writing one. Automatic session-derived digest items carry receipts without claiming work status. honestweek never auto-publishes.
argument-hint: "[weekly | client <from> <to> | mine | view | digest]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" *)
---

# honestweek

honestweek turns a week of your AI coding **sessions** into an honest, shareable work summary, and refuses to ship a single claim it can't back. It runs small, zero-dependency Node scripts on the user's machine: they read the session transcripts, distil a reviewable set of items, and re-derive every git-checkable claim against real commits before emitting anything.

Every stage but one is deterministic code. **DISTIL is the one place a model puts words into the output**, so the contract below is a load-bearing honesty boundary for the whole product. It comes first in this file on purpose: read it before any flow.

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
- **Local-only preview.** The optional `preview` server binds to loopback (`127.0.0.1`) only, renders the built output in memory as a self-contained page (no external resources), and publishes nothing. It is a viewer, not a producer: it never re-runs `build`, calls git, or writes a file. It stops on its own after 30 minutes with no visits; run it again to see the page.
- **Local-only page.** `view` binds to loopback (`127.0.0.1`) only, answers only the page it opened (each run's key is traded once for the one-time code in the address it prints), keeps only what the user chooses to save, and publishes nothing. Its Show private text switch belongs to the user, on their own screen.
- **A mined draft asserts nothing about today.** `mine --draft` writes a post from old session logs. Its last-verified field is emitted **empty**, its publication date is left blank, and every item on its verification checklist starts `UNVERIFIED`. Do not fill any of them in on the user's behalf: they record whether a human re-ran the checks, and pre-filling them would launder a past observation into a present-tense claim. If asked to help publish one, work the checklist first and say plainly which items you could not verify.

## Running the bundled CLI

**Running the bundled CLI.** honestweek ships a Node CLI bundled with this skill. Run the flows' commands from the **user's project directory** (each command writes its sidecars beside the config it read, which is this folder's unless the weekly flow's step 1 found one elsewhere), but invoke the script by its **skill-anchored absolute path**. `${CLAUDE_SKILL_DIR}` resolves to this skill's own install directory, so the path works regardless of the current working directory (personal, project, or plugin install). If `${CLAUDE_SKILL_DIR}` is ever not substituted in your environment, fall back to the absolute path of the directory containing this `SKILL.md`.

This skill's folder is `${CLAUDE_SKILL_DIR}`. The flow files below are plain files read with your file tools, so the skill folder placeholder in their commands isn't filled in for you: use this folder in its place, written the same way, with forward slashes. Claude Code then runs honestweek's own commands without asking each time, and asks as usual for anything else.

## Flows

The text after the skill's name, if any, is `$ARGUMENTS`. Its first word picks the flow. If it's empty, or shows a dollar sign and a word instead, nothing was passed: pick the flow from what the user asked for, and with no clear ask run the weekly flow. Before you run any of a flow's commands, read its file in full from the `flows/` folder beside this `SKILL.md`.

| Flow | When | Read |
| --- | --- | --- |
| `weekly` (the default) | A summary of the last completed week: `init`, `discover`, DISTIL, `build`, `review` | [flows/weekly.md](flows/weekly.md) |
| `client` | A report of one period of work for a client, such as `client 2026-09-01 2026-09-30` | [flows/client.md](flows/client.md) |
| `mine` | Solved problems in the user's logs worth writing up | [flows/mine.md](flows/mine.md) |
| `view` | Finding and replaying sessions, in the local page or with `find`, `replay`, `problems` and `goals` | [flows/view.md](flows/view.md) |
| `digest` | The balanced digest lane, for `page` or `site` output with no goals registry | [flows/digest.md](flows/digest.md) |

The distillation contract and the safety invariants above apply to every flow.

## Clean-room

This is a fresh, generic skill. It ships with no hardcoded personal data (no real names, paths, repo names, author emails, or codenames), and every example in it and in its flow files uses obviously generic placeholders (`you@example.com`, `/path/to/your/repo`, `your-project`).
