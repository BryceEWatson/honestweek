---
name: honestweek-contract
description: The rules for writing or editing honestweek.items.json, the reviewable work items of an honestweek weekly summary or client report. Every item gets one status badge and a receipt, nothing is copied verbatim from session text, and nothing is claimed that the draft doesn't support. Loads whenever Claude works with honestweek.items.json.
user-invocable: false
paths:
  - "**/honestweek.items.json"
---

# The honestweek distillation contract

These are the rules the honestweek skill gives Claude for its one model-judgment step. They apply whenever you write or edit `honestweek.items.json`, in any chat, whether or not the skill is running. `validate` and `build` check the items afterwards; these rules keep an unsupported claim from being written in the first place.

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
