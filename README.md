# honestweek

Turn a week of your AI coding sessions into an honest, shareable record of what you actually did — including the figured-out-but-not-yet-shipped work your commits can't show.

honestweek reads your AI coding **sessions** (the transcript, not just your git history), distils a week of them into a plain, honest summary, and verifies every git-checkable claim against your real commits — or it doesn't ship the claim. Private by default. You review and publish; nothing is posted in your voice automatically.

> **Status: spec-first, pre-implementation.** The v0.1 design is settled and the build is described, issue by issue, in [Issues](../../issues). No code is written yet.

## Why

Your commits show what shipped. Your sessions show what you *figured out* — the dead ends you ruled out and the work that's designed but not yet proven. honestweek surfaces that honestly, with a status badge on every item (`shipped` / `in progress` / `designed, not proven`) and a receipt (a link to its source) on every claim.

## Principles

- **Reasons over the session, not just the commit.** The transcript is the only record of the work that never landed in git.
- **Honest by construction.** Every git-checkable number is re-derived from your commits at build time, or the build aborts. Every narrative line links to its source.
- **Private by default.** Only your own allowlisted repos are read; a redaction layer scrubs secrets and configurable private terms; output stays local until you choose to publish it.

## What it does NOT do (yet)

- No hosted service — it runs locally, against your own machine's session logs.
- No auto-publishing — it produces a draft you review and post yourself.
- v0.1 targets Claude Code session logs first; other agents (Codex CLI, Cursor) come later.

## License

[MIT](LICENSE)
