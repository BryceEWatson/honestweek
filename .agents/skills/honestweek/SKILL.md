---
name: honestweek
description: Turn a completed week of your AI coding sessions into an honest, git-verified, private-by-default work summary. Use it when the user types /honestweek or explicitly asks for a weekly summary, weekly update or work report ("write up my week", "draft my weekly update"), not for a question about today's commits or for finding a session. It discovers the week's sessions into a redacted digest, distils it into reviewable work items with a status badge and receipt, builds them with verify-or-abort, and leaves a draft the user reviews and publishes themselves. With no config it stops and asks before writing one. Automatic session-derived digest items carry receipts without claiming work status. honestweek never auto-publishes.
---

# honestweek, in its own repository (Codex)

This copy of the skill is here so Codex finds honestweek in a clone of the honestweek repository with nothing to install. The full instructions live in the repository's root `SKILL.md`, three folders up from this file (`../../../SKILL.md`).

1. Read that file in full before you do anything else, and follow it exactly. Its distillation contract applies word for word.
2. Its commands run the bundled CLI as `node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" ...`. Codex doesn't fill in `${CLAUDE_SKILL_DIR}`, and here the CLI sits at the repository root, three folders up from this file. So run `node "<repository root>/bin/honestweek.mjs" init --yes`, with the repository root's absolute path, and the same for every other command.

Everything else, including where it may and may not write, is in the root file.
