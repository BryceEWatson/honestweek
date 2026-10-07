---
name: honestweek
description: Turn a completed week of your AI coding sessions into an honest, git-verified, private-by-default work summary. Run /honestweek to scaffold config, discover the week's sessions into a redacted digest, distil it into reviewable work items with a status badge and receipt, build it with verify-or-abort, and review the draft before you publish it yourself. Automatic session-derived digest items carry receipts without claiming work status. honestweek never auto-publishes.
disable-model-invocation: true
---

# honestweek, in its own repository

This copy of the skill is here so `/honestweek` works in a clone of the honestweek repository with nothing to install. The full instructions live in the repository's root `SKILL.md`, at `${CLAUDE_SKILL_DIR}/../../../SKILL.md`.

1. Read that file in full before you do anything else, and follow it exactly. Its distillation contract applies word for word.
2. Its commands run the bundled CLI from the skill's own folder. Here that folder is the repository root, `${CLAUDE_SKILL_DIR}/../../..`, which holds `bin/honestweek.mjs`. So where it runs `node "<skill folder>/bin/honestweek.mjs" init --yes`, you run `node "${CLAUDE_SKILL_DIR}/../../../bin/honestweek.mjs" init --yes`, and the same for every other command.

Everything else, including where it may and may not write, is in the root file.
