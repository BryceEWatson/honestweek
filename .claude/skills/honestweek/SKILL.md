---
name: honestweek
description: Turn a completed week of your AI coding sessions into an honest, git-verified, private-by-default work summary. Use it when the user types /honestweek or explicitly asks for a weekly summary, weekly update or work report ("write up my week", "draft my weekly update"), not for a question about today's commits or for finding a session. It discovers the week's sessions into a redacted digest, distils it into reviewable work items with a status badge and receipt, builds them with verify-or-abort, and leaves a draft the user reviews and publishes themselves. With no config it stops and asks before writing one. Automatic session-derived digest items carry receipts without claiming work status. honestweek never auto-publishes.
argument-hint: "[weekly | client <from> <to> | mine | view | digest]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/../../../bin/honestweek.mjs" *)
---

# honestweek, in its own repository

This copy of the skill is here so `/honestweek` works in a clone of the honestweek repository with nothing to install. The full instructions live in the repository's root `SKILL.md`, at `${CLAUDE_SKILL_DIR}/../../../SKILL.md`, and in the `flows/` folder beside it.

1. Read that file in full before you do anything else, and follow it exactly. Its distillation contract applies word for word. Then read the flow file it sends you to, in `${CLAUDE_SKILL_DIR}/../../../flows/`.
2. Those files run the bundled CLI from the skill's own folder, written as the skill folder placeholder (a dollar sign and `CLAUDE_SKILL_DIR` in braces). Here that folder is the repository root, `${CLAUDE_SKILL_DIR}/../../..`, which holds `bin/honestweek.mjs`. So where they run the CLI's `init --yes`, you run `node "${CLAUDE_SKILL_DIR}/../../../bin/honestweek.mjs" init --yes`, and the same for every other command.
3. The text after the skill's name, if any, is `$ARGUMENTS`. Pick the flow from it the way the root file's Flows section says.

Everything else, including where it may and may not write, is in the root file.
