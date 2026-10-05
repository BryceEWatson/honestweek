# Sources behind the known problems

## In plain terms

This page lists every published source behind honestweek's 41 known problems, each one once: vendor docs, bug reports, research papers and a few others. Each entry gives the source's title, linked to where it's published, its date, and the problems that cite it, so you can check the evidence for any problem in one place. I generate it from the problem catalog, so it changes only when the catalog does.

212 sources. The catalog was checked on 2026-10-03 and 2026-10-05.

## Vendor docs (53)

- [Addendum to GPT-5.2 System Card: GPT-5.2-Codex (section 4.2, avoid data-destructive actions)](https://cdn.openai.com/pdf/ac7c37ae-7f4c-4442-b741-2eabdeaf77e0/oai_5_2_Codex.pdf) (2025-12)
  Cited by: Committed, pushed or rewrote history without being asked; Ran a command that can't be undone.
- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security) (undated page, fetched 2026-10-05)
  Cited by: Approved nearly every permission prompt, quickly; Committed, pushed or rewrote history without being asked; Edited files outside the session's folder; Exposed a credential, or went looking for one; Followed instructions planted in what it read; Went around a hook, a check or a refusal.
- [Auto-review (Codex)](https://learn.chatgpt.com/docs/sandboxing/auto-review) (undated page, fetched 2026-10-05)
  Cited by: Approved nearly every permission prompt, quickly; Exposed a credential, or went looking for one; Went around a hook, a check or a refusal.
- [Best practices (Codex)](https://learn.chatgpt.com/guides/best-practices) (undated page, fetched 2026-10-05)
  Cited by: Broke something outside the task; Instruction files grew too long to follow; Said it was done without running a check; Sessions ran long past where a fresh start would help; Started editing before reading enough of the code; You had to correct the same thing more than once.
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) (undated page, fetched 2026-10-03)
  Cited by: Added code that silences errors; Approved nearly every permission prompt, quickly; Broke a rule it was given; Instruction files grew too long to follow; Ran a command that can't be undone; Read far more than the task needed; Said it was done without running a check; Sessions ran long past where a fresh start would help; Started editing before reading enough of the code; The tests passed, but the fix was still wrong; You had to correct the same thing more than once.
- [Build skills (Codex)](https://learn.chatgpt.com/docs/build-skills) (undated page, fetched 2026-10-05)
  Cited by: Started helpers the work didn't need.
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (2024-12-19)
  Cited by: Called a failed run a pass, or its failures unrelated; Repeated the same step without getting further.
- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes) (undated page, fetched 2026-10-05)
  Cited by: Broke a rule it was given; Edited files outside the session's folder.
- [Claude 3.7 Sonnet System Card (section 6, excessive focus on passing tests)](https://www-cdn.anthropic.com/9ff93dfa8f445c932415d335c88852ef47f1201e.pdf) (2025-02 (release month; card undated))
  Cited by: Hard-coded what the tests check for; Removed or skipped tests, or narrowed the test command.
- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) (2026-02-25)
  Cited by: Added code that silences errors; Committed, pushed or rewrote history without being asked; Ran a command that can't be undone; Read the same file again when it hadn't changed; Stopped before the work was finished; Stopped to ask permission it didn't need.
- [Commands (Claude Code)](https://code.claude.com/docs/en/commands) (undated page, fetched 2026-10-05)
  Cited by: Kept deliberating when one step would settle it; Said it was done without running a check; Sessions ran long past where a fresh start would help; Stopped before the work was finished.
- [Configuration Reference (Codex)](https://learn.chatgpt.com/docs/config-file/config-reference) (undated page, fetched 2026-10-05)
  Cited by: Kept deliberating when one step would settle it.
- [Configure permissions](https://code.claude.com/docs/en/permissions) (undated page, fetched 2026-10-05)
  Cited by: Approved nearly every permission prompt, quickly; Committed, pushed or rewrote history without being asked; Exposed a credential, or went looking for one; Removed or skipped tests, or narrowed the test command.
- [Configure the sandboxed Bash tool (Claude Code)](https://code.claude.com/docs/en/sandboxing) (undated page, fetched 2026-10-05)
  Cited by: Approved nearly every permission prompt, quickly; Edited files outside the session's folder; Exposed a credential, or went looking for one.
- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) (undated page, fetched 2026-10-05)
  Cited by: Instruction files grew too long to follow.
- [Customize your status line](https://code.claude.com/docs/en/statusline) (undated page, fetched 2026-10-05)
  Cited by: Sessions ran long past where a fresh start would help.
- [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) (2025-06-12)
  Cited by: Guessed instead of asking; Lost or ignored what a helper found.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (2025-09-29)
  Cited by: Filled the context with huge command output; Forgot earlier work after the context was summarized; Sessions ran long past where a fresh start would help.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (2025-11-26)
  Cited by: Removed or skipped tests, or narrowed the test command; Said it was done without running a check; Started editing before reading enough of the code.
- [Environment variables (Claude Code)](https://code.claude.com/docs/en/env-vars) (undated page, fetched 2026-10-05)
  Cited by: Started helpers the work didn't need.
- [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide) (2025-08-07)
  Cited by: Instruction files grew too long to follow; Read far more than the task needed; Stopped before the work was finished.
- [GPT-5 System Card (section 3.8, deception)](https://cdn.openai.com/gpt-5-system-card.pdf) (2025-08)
  Cited by: Said it did something the log doesn't show; Said it was done without running a check.
- [Hooks (Codex)](https://learn.chatgpt.com/docs/hooks) (undated page, fetched 2026-10-05)
  Cited by: Broke a rule it was given; Called a failed run a pass, or its failures unrelated; Filled the context with huge command output; Hit the same tool error again and again; Installed a package it shouldn't have; Left scratch files or debug edits behind; Read the same file again when it hadn't changed; Removed or skipped tests, or narrowed the test command; Repeated the same step without getting further; Said it was done without running a check; Sessions ran long past where a fresh start would help; Waited by sleeping and checking again and again; Went around a hook, a check or a refusal.
- [Hooks reference (Claude Code)](https://code.claude.com/docs/en/hooks) (undated page, fetched 2026-10-05)
  Cited by: Broke a rule it was given; Called a failed run a pass, or its failures unrelated; Filled the context with huge command output; Hit the same tool error again and again; Installed a package it shouldn't have; Left scratch files or debug edits behind; Ran a command that can't be undone; Read the same file again when it hadn't changed; Removed or skipped tests, or narrowed the test command; Repeated the same step without getting further; Said it was done without running a check; Sessions ran long past where a fresh start would help; Stopped before the work was finished; Waited by sleeping and checking again and again; Went around a hook, a check or a refusal.
- [How Claude remembers your project](https://code.claude.com/docs/en/memory) (undated page, fetched 2026-10-03)
  Cited by: Broke a rule it was given; Forgot earlier work after the context was summarized; Instruction files grew too long to follow.
- [How we built Claude Code auto mode: a safer way to skip permissions](https://www.anthropic.com/engineering/claude-code-auto-mode) (2026-03-25)
  Cited by: Approved nearly every permission prompt, quickly; Committed, pushed or rewrote history without being asked; Exposed a credential, or went looking for one; Followed instructions planted in what it read; Ran a command that can't be undone; Went around a hook, a check or a refusal.
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (2025-06-13)
  Cited by: Lost or ignored what a helper found; Read far more than the task needed; Started helpers the work didn't need.
- [Long-running work (Codex)](https://learn.chatgpt.com/docs/long-running-work) (undated page, fetched 2026-10-05)
  Cited by: Said it was done without running a check; Stopped before the work was finished.
- [Manage costs effectively](https://code.claude.com/docs/en/costs) (undated page, fetched 2026-10-03)
  Cited by: Filled the context with huge command output; Kept deliberating when one step would settle it; Read far more than the task needed; Read the same file again when it hadn't changed; Sessions ran long past where a fresh start would help; Started editing before reading enough of the code; Started helpers the work didn't need; Waited by sleeping and checking again and again.
- [Migrating to Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) (undated page, fetched 2026-10-05)
  Cited by: Instruction files grew too long to follow.
- [Model configuration (Claude Code)](https://code.claude.com/docs/en/model-config) (undated page, fetched 2026-10-05)
  Cited by: Kept deliberating when one step would settle it.
- [Models (Codex)](https://learn.chatgpt.com/docs/models) (undated page, fetched 2026-10-05)
  Cited by: Kept deliberating when one step would settle it; Started helpers the work didn't need.
- [Permission profiles (Codex)](https://learn.chatgpt.com/docs/permissions) (undated page, fetched 2026-10-05)
  Cited by: Exposed a credential, or went looking for one.
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (undated page, fetched 2026-10-03)
  Cited by: Added code that silences errors; Committed, pushed or rewrote history without being asked; Did more than you asked for; Hard-coded what the tests check for; Kept deliberating when one step would settle it; Left scratch files or debug edits behind; Ran a command that can't be undone; Read far more than the task needed; Removed or skipped tests, or narrowed the test command; Started helpers the work didn't need; Stopped before the work was finished; Used a file, function or flag that doesn't exist; Went around a hook, a check or a refusal.
- [Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) (undated page, fetched 2026-10-03)
  Cited by: Committed, pushed or rewrote history without being asked; Did more than you asked for; Hid what it needed from you in a long report; Kept deliberating when one step would settle it; Left placeholders in and called the work finished; Left scratch files or debug edits behind; Oversold the result; Read far more than the task needed; Said it did something the log doesn't show; Stopped before the work was finished; Stopped to ask permission it didn't need.
- [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) (undated page, fetched 2026-10-03)
  Cited by: Did more than you asked for; Hid what it needed from you in a long report; Kept deliberating when one step would settle it; Left placeholders in and called the work finished; Said it did something the log doesn't show; Started helpers the work didn't need.
- [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) (undated page, fetched 2026-10-05)
  Cited by: Followed instructions planted in what it read; Instruction files grew too long to follow; Kept deliberating when one step would settle it; Lost or ignored what a helper found; Read far more than the task needed; Said it did something the log doesn't show; Stopped before the work was finished; Stopped to ask permission it didn't need.
- [Prompting Claude Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) (undated page, fetched 2026-10-03)
  Cited by: Did more than you asked for; Hit the same tool error again and again; Installed a package it shouldn't have; Kept deliberating when one step would settle it; Left scratch files or debug edits behind; Said it was done without running a check; Started helpers the work didn't need; Stopped to ask permission it didn't need.
- [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) (2026-09-11)
  Cited by: Instruction files grew too long to follow; Kept deliberating when one step would settle it; Read far more than the task needed; Stopped before the work was finished; Stopped to ask permission it didn't need.
- [Rules (Codex)](https://learn.chatgpt.com/docs/agent-configuration/rules) (undated page, fetched 2026-10-05)
  Cited by: Approved nearly every permission prompt, quickly; Committed, pushed or rewrote history without being asked; Ran a command that can't be undone.
- [Sandbox (Codex)](https://learn.chatgpt.com/docs/sandboxing) (undated page, fetched 2026-10-05)
  Cited by: Approved nearly every permission prompt, quickly.
- [Security](https://code.claude.com/docs/en/security) (undated page, fetched 2026-10-03)
  Cited by: Followed instructions planted in what it read.
- [Settings files and precedence](https://code.claude.com/docs/en/settings) (undated page, fetched 2026-10-03)
  Cited by: Exposed a credential, or went looking for one.
- [Slash commands in Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli) (undated page, fetched 2026-10-05)
  Cited by: Said it was done without running a check; Sessions ran long past where a fresh start would help; Stopped before the work was finished.
- [Subagents (Claude Code docs)](https://code.claude.com/docs/en/sub-agents) (undated page, fetched 2026-10-03)
  Cited by: Started helpers the work didn't need.
- [System Card: Claude Opus 4.6](https://www-cdn.anthropic.com/c788cbc0a3da9135112f97cdf6dcd06f2c16cee2.pdf) (2026-02)
  Cited by: Called a failed run a pass, or its failures unrelated; Exposed a credential, or went looking for one; Hard-coded what the tests check for; Ran a command that can't be undone.
- [System Card: Claude Opus 5](https://www-cdn.anthropic.com/c5fbac3f0b1280a933ebd26d3cb8bb9f5bdeaf48/Claude%20Opus%205%20System%20Card.pdf) (2026-07)
  Cited by: Broke a rule it was given; Called a failed run a pass, or its failures unrelated; Exposed a credential, or went looking for one; Kept deliberating when one step would settle it; Oversold the result; Went around a hook, a check or a refusal.
- [Tools reference](https://code.claude.com/docs/en/tools-reference) (undated page, fetched 2026-10-03)
  Cited by: Filled the context with huge command output; Stopped before the work was finished; Waited by sleeping and checking again and again.
- [Track cost and usage (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/cost-tracking) (undated page, fetched 2026-10-05)
  Cited by: Started helpers the work didn't need.
- [Unified diffs make GPT-4 Turbo 3X less lazy](https://aider.chat/2023/12/21/unified-diffs.html) (2023-12-21)
  Cited by: Left placeholders in and called the work finished.
- [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) (undated page, fetched 2026-10-05)
  Cited by: Broke a rule it was given; Guessed instead of asking; Hid what it needed from you in a long report; Instruction files grew too long to follow; Kept deliberating when one step would settle it; Started helpers the work didn't need; Stopped before the work was finished; Stopped to ask permission it didn't need.
- [What's new in Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5) (undated page, fetched 2026-10-05)
  Cited by: Said it did something the log doesn't show.
- [Writing effective tools for agents, with agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11)
  Cited by: Filled the context with huge command output; Hit the same tool error again and again; Read the same file again when it hadn't changed.

## Bug reports (110)

- ["Error: String to replace not found in file."](https://github.com/anthropics/claude-code/issues/968) (2025-05-05)
  Cited by: Hit the same tool error again and again.
- [\[Codex App\] Agent repeatedly creates unrequested validation projects despite opt-in rules](https://github.com/openai/codex/issues/40033) (2026-08-21)
  Cited by: Left scratch files or debug edits behind.
- [\[Meta\] Systematic completion-integrity failures — 16 issues across 6 phases from 100+ sessions of evidence](https://github.com/anthropics/claude-code/issues/32650) (2026-03-10)
  Cited by: Said it was done without running a check.
- [\`replace\` tool \`old\_string\` mismatch loop (especially in Flash versions)](https://github.com/google-gemini/gemini-cli/issues/4576) (2025-07-21)
  Cited by: Hit the same tool error again and again.
- [A tendency to re-write tests so they pass.](https://github.com/anthropics/claude-code/issues/319) (2025-03-04)
  Cited by: Removed or skipped tests, or narrowed the test command.
- [Agent asks permission to fix an already-confirmed defect instead of just fixing it (stall via needless confirmation prompt)](https://github.com/anthropics/claude-code/issues/70255) (2026-06-23)
  Cited by: Stopped to ask permission it didn't need.
- [Agent bypasses git pre-commit hooks using --no-verify, stash, and quiet flags despite explicit deny rules](https://github.com/anthropics/claude-code/issues/40117) (2026-03-28)
  Cited by: Went around a hook, a check or a refusal.
- [Agent deflects with "untouched by my change" after its own change breaks previously-passing tests — needs accountability-first framing](https://github.com/anthropics/claude-code/issues/64053) (2026-05-30)
  Cited by: Broke something outside the task.
- [Agent makes unasked changes, adds assumptions, breaks working code](https://github.com/anthropics/claude-code/issues/54240) (2026-04-28)
  Cited by: Broke something outside the task.
- [Agent performed hours of unauthorized work, ignored its core process rule after eight corrections, and reported unverified results as fact](https://github.com/anthropics/claude-code/issues/91899) (2026-09-03)
  Cited by: You had to correct the same thing more than once.
- [Agent promotes unapproved assumptions to requirements and omits them from a requested audit](https://github.com/openai/codex/issues/41813) (2026-08-31)
  Cited by: Guessed instead of asking.
- [Agent repeatedly overrode explicit scope, presented fake test results as real, and committed without permission](https://github.com/anthropics/claude-code/issues/95494) (2026-09-19)
  Cited by: Did more than you asked for.
- [Agent Skills Are Spreading Hallucinated npx Commands](https://www.aikido.dev/blog/agent-skills-spreading-hallucinated-npx-commands) (2026-01-21)
  Cited by: Installed a package it shouldn't have; Used a file, function or flag that doesn't exist.
- [Agent tool \`name\` parameter silently switches to teammate protocol, losing background agent results](https://github.com/anthropics/claude-code/issues/71723) (2026-06-27)
  Cited by: Lost or ignored what a helper found.
- [Agent used git clean on nested ignored paths and deleted the entire ignored parent directory](https://github.com/openai/codex/issues/42355) (2026-09-02)
  Cited by: Exposed a credential, or went looking for one; Ran a command that can't be undone.
- [Agent wastes context through oversized browser observations and repeated retries despite efficiency instructions](https://github.com/openai/codex/issues/48792) (2026-09-27)
  Cited by: Filled the context with huge command output.
- [Agent weakens regression tests and reports nonexistent validation/changes as complete during refactor task](https://github.com/openai/codex/issues/24922) (2026-05-28)
  Cited by: Called a failed run a pass, or its failures unrelated; Removed or skipped tests, or narrowed the test command; Said it did something the log doesn't show.
- [Agents repeatedly reread unchanged files already available in context](https://github.com/openai/codex/issues/33498) (2026-07-16)
  Cited by: Read the same file again when it hadn't changed.
- [Auto compaction causes GPT-5-Codex to lose the plot. It forgets it is mid-task, forgets it has edited files and stops.](https://github.com/openai/codex/issues/5957) (2025-10-30)
  Cited by: Forgot earlier work after the context was summarized.
- [Auto-compact repeatedly re-reads same files instead of continuing from prior state](https://github.com/anthropics/claude-code/issues/96414) (2026-09-23)
  Cited by: Read the same file again when it hadn't changed.
- [Avoid fallbacks](https://github.com/openai/codex/issues/6356) (2025-11-07)
  Cited by: Added code that silences errors.
- [Avoid repetitive confirmation loops in long-running browser tasks](https://github.com/openai/codex/issues/42349) (2026-09-02)
  Cited by: Stopped to ask permission it didn't need.
- [Bug: Claude edits code files while Plan Mode is active despite system instructions](https://github.com/anthropics/claude-code/issues/35128) (2026-03-17)
  Cited by: Broke a rule it was given.
- [Claude Code circumvents PreToolUse:Edit hook via Bash tool](https://github.com/anthropics/claude-code/issues/29709) (2026-03-01)
  Cited by: Went around a hook, a check or a refusal.
- [Claude Code commits without being asked, repeatedly ignoring CLAUDE.md rule](https://github.com/anthropics/claude-code/issues/68724) (2026-06-16)
  Cited by: Committed, pushed or rewrote history without being asked.
- [Claude Code create c:/memfs directory without asking me.](https://github.com/anthropics/claude-code/issues/63099) (2026-05-28)
  Cited by: Edited files outside the session's folder; Left scratch files or debug edits behind.
- [Claude Code deleted ~600GB: unprompted \`rm -rf\` on a substitution that resolved to a drive root](https://github.com/anthropics/claude-code/issues/95426) (2026-09-18)
  Cited by: Ran a command that can't be undone.
- [Claude Code destroyed user's uncommitted work by running git reset --hard on session startup — TWICE](https://github.com/anthropics/claude-code/issues/34327) (2026-03-14)
  Cited by: Ran a command that can't be undone.
- [Claude Code fabricated test results and repeatedly lied to user](https://github.com/anthropics/claude-code/issues/11913) (2025-11-19)
  Cited by: Called a failed run a pass, or its failures unrelated.
- [Claude Code Incident Report — Benchmark Gaming & Destructive File Overwrite](https://github.com/anthropics/claude-code/issues/41350) (2026-03-31)
  Cited by: Hard-coded what the tests check for.
- [Claude Code repeatedly ignores CLAUDE.md security guidelines and exposes API keys to version control](https://github.com/anthropics/claude-code/issues/2142) (2025-06-16)
  Cited by: Exposed a credential, or went looking for one.
- [Claude Code repeats an already-corrected mistake within the same session; explicit corrections don't bind subsequent behavior](https://github.com/anthropics/claude-code/issues/76261) (2026-07-10)
  Cited by: You had to correct the same thing more than once.
- [Claude commits and amends git history unprompted while generating commit messages](https://github.com/anthropics/claude-code/issues/90097) (2026-08-27)
  Cited by: Committed, pushed or rewrote history without being asked.
- [Claude displayed sensitive .env credentials (API keys, secrets) in output when it should have redacted them.](https://github.com/anthropics/claude-code/issues/18223) (2026-01-14)
  Cited by: Exposed a credential, or went looking for one.
- [Claude fabricated test results in PR description without running tests](https://github.com/anthropics/claude-code/issues/22507) (2026-02-02)
  Cited by: Called a failed run a pass, or its failures unrelated; Said it did something the log doesn't show.
- [Claude fabricates test results - reports ALL PASSED when tests are FAILING](https://github.com/anthropics/claude-code/issues/46940) (2026-04-12)
  Cited by: Called a failed run a pass, or its failures unrelated.
- [Claude forgets everything in CLAUDE.md after compaction](https://github.com/anthropics/claude-code/issues/6354) (2025-08-22)
  Cited by: Forgot earlier work after the context was summarized.
- [Claude generates stub code instead of complete implementations](https://github.com/anthropics/claude-code/issues/88438) (2026-08-21)
  Cited by: Left placeholders in and called the work finished.
- [Claude gets stuck in infinite loop repeating the same failing command](https://github.com/anthropics/claude-code/issues/19699) (2026-01-21)
  Cited by: Repeated the same step without getting further.
- [Claude patches symptoms instead of understanding root causes — breaks project rules repeatedly](https://github.com/anthropics/claude-code/issues/45041) (2026-04-08)
  Cited by: Removed or skipped tests, or narrowed the test command.
- [Claude ran a credential-helper \`get\` command and printed a live access token into the transcript](https://github.com/anthropics/claude-code/issues/90758) (2026-08-30)
  Cited by: Exposed a credential, or went looking for one.
- [Claude repeatedly promoted third-party pasted assumptions into user decisions, even after the failure pattern was corrected](https://github.com/anthropics/claude-code/issues/95826) (2026-09-21)
  Cited by: Guessed instead of asking.
- [Claude says "You're absolutely right!" about everything](https://github.com/anthropics/claude-code/issues/3382) (2025-07-12)
  Cited by: Agreed too easily.
- [Claude stops mid-task without completing stated actions](https://github.com/anthropics/claude-code/issues/90557) (2026-08-29)
  Cited by: Stopped before the work was finished.
- [claude-fable-5: repeatedly delivers incomplete structured work despite specs being available in-context](https://github.com/anthropics/claude-code/issues/92567) (2026-09-06)
  Cited by: Stopped before the work was finished.
- [CLAUDE.md and memory rules stop applying after compaction — 163 sessions of logged evidence, same rule broken 3x after explicit acknowledgment](https://github.com/anthropics/claude-code/issues/89733) (2026-08-26)
  Cited by: Forgot earlier work after the context was summarized.
- [CLAUDE.md hard rules and persistent memory instructions consistently ignored — violations escalate with each session despite repeated explicit reinforcement](https://github.com/anthropics/claude-code/issues/33603) (2026-03-12)
  Cited by: Broke a rule it was given.
- [CLAUDE.md Mandatory Rules Consistently Ignored Across Multiple Repositories](https://github.com/anthropics/claude-code/issues/2544) (2025-06-24)
  Cited by: Broke a rule it was given.
- [Cloud GitHub App reviewer fabricates make\_pr follow-up commit narration with non-existent SHAs](https://github.com/openai/codex/issues/19520) (2026-04-25)
  Cited by: Said it did something the log doesn't show.
- [Code Execution Through Deception: Gemini AI CLI Hijack](https://tracebit.com/blog/code-exec-deception-gemini-ai-cli-hijack) (2025-07-28)
  Cited by: Followed instructions planted in what it read.
- [Codex (terra) repeatedly stopping prematurely](https://github.com/openai/codex/issues/34900) (2026-07-23)
  Cited by: Stopped before the work was finished.
- [Codex app intermittently ends a turn after commentary before executing planned tool calls](https://github.com/openai/codex/issues/46153) (2026-09-17)
  Cited by: Stopped before the work was finished.
- [Codex CLI loves to use stubs, shims, fallbacks, placeholders as default approaches](https://github.com/openai/codex/issues/6587) (2025-11-13)
  Cited by: Added code that silences errors; Left placeholders in and called the work finished.
- [Codex fails to reconstruct the global plan after repeated corrections across dependent deliverables](https://github.com/openai/codex/issues/40849) (2026-08-26)
  Cited by: You had to correct the same thing more than once.
- [Codex long-task reliability: completion claims without target evidence and missing circuit breakers](https://github.com/openai/codex/issues/42080) (2026-09-01)
  Cited by: Said it was done without running a check.
- [Codex repeatedly generates nonexistent file paths in final summaries/reports](https://github.com/openai/codex/issues/24137) (2026-05-22)
  Cited by: Said it did something the log doesn't show; Used a file, function or flag that doesn't exist.
- [Codex repeatedly ignores explicit task scope and performs destructive out-of-scope changes](https://github.com/openai/codex/issues/36666) (2026-08-03)
  Cited by: Broke something outside the task; Did more than you asked for.
- [Codex repeatedly reuses flawed validator code and hard-codes validation results despite explicit clean-rewrite instructions](https://github.com/openai/codex/issues/42490) (2026-09-03)
  Cited by: Hard-coded what the tests check for.
- [Codex Security scan exhausted a freshly reset weekly allowance in ~44 minutes through worker/subagent fan-out](https://github.com/openai/codex/issues/46819) (2026-09-20)
  Cited by: Started helpers the work didn't need.
- [Codex VS Code extension/agent ran git restore despite explicit "never touch git" instruction, overwriting uncommitted work](https://github.com/openai/codex/issues/8643) (2025-12-31)
  Cited by: Broke a rule it was given; Committed, pushed or rewrote history without being asked.
- [Context auto-compaction loop repeatedly rereads files, loses progress, and consumes paid Codex credits](https://github.com/openai/codex/issues/35226) (2026-07-24)
  Cited by: Forgot earlier work after the context was summarized; Read the same file again when it hadn't changed.
- [Context compaction forgets AGENTS rules: task progress can jump from 97% back to 42%](https://github.com/openai/codex/issues/25792) (2026-06-02)
  Cited by: Broke a rule it was given; Forgot earlier work after the context was summarized.
- [CRITICAL: Agent deleted entire file without permission and tried to hide it](https://forum.cursor.com/t/critical-agent-deleted-entire-file-without-permission-and-tried-to-hide-it/155098) (2026-03-17)
  Cited by: Ran a command that can't be undone; Went around a hook, a check or a refusal.
- [Critical: Codex leaked production secrets and irreversibly rotated credentials without authorization](https://github.com/openai/codex/issues/40378) (2026-08-24)
  Cited by: Exposed a credential, or went looking for one.
- [CRITICAL: Mandatory Rule Violations - Unauthorized Fallbacks and Synthetic Data](https://github.com/anthropics/claude-code/issues/5941) (2025-08-16)
  Cited by: Added code that silences errors.
- [Desktop agent turns a simple explorer-link request into a ~13-minute research flow](https://github.com/openai/codex/issues/37750) (2026-08-10)
  Cited by: Kept deliberating when one step would settle it; Read far more than the task needed.
- [Destructive unauthorized regression: customer-facing Ask Data narration removed during correctness hardening](https://github.com/openai/codex/issues/45093) (2026-09-12)
  Cited by: Broke something outside the task.
- [Fake \<system-reminder\> injected into tool output (conceal-from-user + reduced-oversight framing)](https://github.com/anthropics/claude-code/issues/75758) (2026-07-08)
  Cited by: Followed instructions planted in what it read.
- [False completion: agent reported repair task fully resolved while the defect was still live (8,726 records missed)](https://github.com/anthropics/claude-code/issues/88271) (2026-08-20)
  Cited by: Oversold the result.
- [Gemini agent performed a 'git reset --hard' without user confirmation, causing data loss of uncommitted files.](https://github.com/google-gemini/gemini-cli/issues/5352) (2025-08-01)
  Cited by: Ran a command that can't be undone.
- [Gemini CLI 'lost' files during a failed file move operation. \[Windows\]](https://github.com/google-gemini/gemini-cli/issues/4586) (2025-07-21)
  Cited by: Ran a command that can't be undone.
- [Gemini repeatedly claims that the build succeeds with no errors, despite clearly printing errors in the console](https://github.com/google-gemini/gemini-cli/issues/15518) (2025-12-24)
  Cited by: Called a failed run a pass, or its failures unrelated.
- [git checkout without permission](https://github.com/google-gemini/gemini-cli/issues/1938) (2025-06-26)
  Cited by: Committed, pushed or rewrote history without being asked.
- [GitHub MCP Exploited: Accessing private repositories via MCP](https://invariantlabs.ai/blog/mcp-github-vulnerability) (2025-05-26)
  Cited by: Followed instructions planted in what it read.
- [gpt-5-codex ran \`rm -rf .git\` out of nowhere](https://github.com/openai/codex/issues/3728) (2025-09-16)
  Cited by: Ran a command that can't be undone.
- [GPT-5.4 frequently reports tasks as completed without executing them](https://github.com/openai/codex/issues/14341) (2026-03-11)
  Cited by: Said it was done without running a check.
- [Inefficient AI Behavior and Sandbox Bypass](https://github.com/google-gemini/gemini-cli/issues/27090) (2026-05-15)
  Cited by: Edited files outside the session's folder; Went around a hook, a check or a refusal.
- [Long Codex thread repeatedly reports incomplete QuantPilot scope as finished after extreme tool usage](https://github.com/openai/codex/issues/40938) (2026-08-26)
  Cited by: Oversold the result; Said it was done without running a check.
- [Main turn can complete before collecting required subagent results; results surface only after the next user prompt](https://github.com/openai/codex/issues/40932) (2026-08-26)
  Cited by: Lost or ignored what a helper found.
- [Memory file duplication causes excessive token consumption](https://github.com/anthropics/claude-code/issues/62325) (2026-05-25)
  Cited by: Instruction files grew too long to follow.
- [Model drifts full-width CJK punctuation to half-width in Edit's old\_string, causing silent "String to replace not found"](https://github.com/anthropics/claude-code/issues/52482) (2026-04-23)
  Cited by: Hit the same tool error again and again.
- [Model is over-cautious to the point of unhelpful — asks permission for work already authorised](https://github.com/anthropics/claude-code/issues/84998) (2026-08-08)
  Cited by: Stopped to ask permission it didn't need.
- [Model reports a fix as done without running the failing tests, and the fix was incomplete](https://github.com/anthropics/claude-code/issues/97155) (2026-09-25)
  Cited by: Said it was done without running a check.
- [Model reports work as completed that it did not do, at a volume that defeats verification](https://github.com/anthropics/claude-code/issues/92505) (2026-09-06)
  Cited by: Said it did something the log doesn't show.
- [Model stuck in error loop](https://github.com/openai/codex/issues/40439) (2026-08-24)
  Cited by: Hit the same tool error again and again.
- [Opus 4.6 Extended reports all tasks completed (15/15 ✅) while actually fabricating data, skipping work, and making the file worse than before](https://github.com/anthropics/claude-code/issues/27399) (2026-02-21)
  Cited by: Oversold the result.
- [Opus 4.6 sycophantic capitulation: abandoned verified multi-source research after single unverified contradiction](https://github.com/anthropics/claude-code/issues/37457) (2026-03-22)
  Cited by: Agreed too easily.
- [Opus 4.8 in Claude Code declares work "verified" / "done" without running the canonical build — false-green regression vs. Opus 4.7](https://github.com/anthropics/claude-code/issues/63861) (2026-05-30)
  Cited by: Said it was done without running a check.
- [Opus 5.5: Severe scope creep and task focus regression compared to Opus 4.6](https://github.com/anthropics/claude-code/issues/97117) (2026-09-25)
  Cited by: Did more than you asked for.
- [Opus generates confident, unverified code: nine defects in one production session (nonexistent CLI flags, stderr capture, printf arity, broken scripted edits)](https://github.com/anthropics/claude-code/issues/98815) (2026-10-01)
  Cited by: Added code that silences errors; Used a file, function or flag that doesn't exist.
- [Opus over-investigates simple debug tasks, consuming disproportionate quota](https://github.com/anthropics/claude-code/issues/92970) (2026-09-09)
  Cited by: Read far more than the task needed.
- [Prototype Contains Hardcoded Mock Data Instead of Real Functionality -LYING MODEL](https://github.com/anthropics/claude-code/issues/7056) (2025-09-03)
  Cited by: Left placeholders in and called the work finished.
- [rm -rf'd a directory of important code without first checking the contents of the directory](https://github.com/google-gemini/gemini-cli/issues/1504) (2025-06-25)
  Cited by: Guessed instead of asking; Ran a command that can't be undone.
- [SECURITY: Claude circumvents denied Bash(rm) by using Python os.remove() as workaround](https://github.com/anthropics/claude-code/issues/39459) (2026-03-26)
  Cited by: Went around a hook, a check or a refusal.
- [Self-authored tests do the work of the code under test — hand-seeded fixtures masked a broken paid feature (271-incident retro, 3/5)](https://github.com/anthropics/claude-code/issues/94170) (2026-09-14)
  Cited by: Hard-coded what the tests check for.
- [Session quality degrades significantly during long conversations](https://github.com/anthropics/claude-code/issues/45564) (2026-04-09)
  Cited by: Sessions ran long past where a fresh start would help.
- [Single web search request spawned 280 parallel subagent sessions, consuming entire daily limit + $51 extra usage](https://github.com/anthropics/claude-code/issues/49275) (2026-04-16)
  Cited by: Started helpers the work didn't need.
- [Sleep polling loop on large inputs instead of using handoff-to-subscription](https://github.com/anthropics/claude-code/issues/34734) (2026-03-15)
  Cited by: Waited by sleeping and checking again and again.
- [Spawned subagents never execute the dispatched task; main agent then falls into an endless sleep/list\_agents polling loop and reports false progress](https://github.com/openai/codex/issues/47802) (2026-09-24)
  Cited by: Lost or ignored what a helper found; Waited by sleeping and checking again and again.
- [Subagent cost is dominated by re-reading files: a judgement pass over a few hundred JSON records costs 470K-910K tokens](https://github.com/anthropics/claude-code/issues/97784) (2026-09-28)
  Cited by: Read the same file again when it hadn't changed.
- [Subagent final assistant messages not delivered to parent session](https://github.com/anthropics/claude-code/issues/86996) (2026-08-15)
  Cited by: Lost or ignored what a helper found.
- [Subagent Write tool rejects .md files named "report"/"summary"/"findings"/"analysis" — no opt-out](https://github.com/anthropics/claude-code/issues/44657) (2026-04-07)
  Cited by: Left scratch files or debug edits behind.
- [Subagents can shut down without delivering results; fork\_turns none scouts acted as orchestrators](https://github.com/openai/codex/issues/26822) (2026-06-06)
  Cited by: Lost or ignored what a helper found.
- [Subagents keep polling long jobs with shell sleep loops instead of using run\_in\_background/Monitor notifications](https://github.com/anthropics/claude-code/issues/95202) (2026-09-17)
  Cited by: Waited by sleeping and checking again and again.
- [Tool/sub-agent results deliver with multi-minute buffering delay causing model busy-wait polling](https://github.com/anthropics/claude-code/issues/64077) (2026-05-30)
  Cited by: Waited by sleeping and checking again and again.
- [Unproductive looping while guessing till runout of tokens](https://github.com/openai/codex/issues/43452) (2026-09-07)
  Cited by: Repeated the same step without getting further.
- [Vibe coding service Replit deleted user's production database, faked data, told fibs galore](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/) (2025-07-21)
  Cited by: Broke a rule it was given; Left placeholders in and called the work finished; Ran a command that can't be undone.
- [Warning Large CLAUDE.md will impact performance : Recommendations ?](https://github.com/anthropics/claude-code/issues/2766) (2025-06-30)
  Cited by: Instruction files grew too long to follow.
- [Workflow tool: one invocation spawned 46 Opus subagents (~3M tokens) with no cost confirmation](https://github.com/anthropics/claude-code/issues/66023) (2026-06-07)
  Cited by: Started helpers the work didn't need.
- [You're right, I wasted a ton of tokens looping on tsc.](https://github.com/anthropics/claude-code/issues/57535) (2026-05-09)
  Cited by: Repeated the same step without getting further.

## Research papers (49)

- ["Your AI, My Shell": Demystifying Prompt Injection Attacks on Agentic AI Coding Editors](https://arxiv.org/abs/2509.22040) (2025-09)
  Cited by: Followed instructions planted in what it read.
- [Ambig-SWE: Interactive Agents to Overcome Underspecificity in Software Engineering](https://arxiv.org/abs/2502.13069) (2025-02)
  Cited by: Guessed instead of asking; Stopped to ask permission it didn't need.
- [An Empirical Study on Failures in Automated Issue Solving](https://arxiv.org/abs/2509.13941) (2025-09)
  Cited by: Added code that silences errors; Called a failed run a pass, or its failures unrelated; Forgot earlier work after the context was summarized; Hard-coded what the tests check for; Removed or skipped tests, or narrowed the test command; Repeated the same step without getting further.
- [Analyzing Message-Code Inconsistency in AI Coding Agent-Authored Pull Requests](https://arxiv.org/abs/2601.04886) (2026-01)
  Cited by: Said it did something the log doesn't show.
- [Are "Solved Issues" in SWE-bench Really Solved Correctly? An Empirical Study](https://arxiv.org/abs/2503.15223) (2025-03)
  Cited by: The tests passed, but the fix was still wrong.
- [Ask or Assume? Uncertainty-Aware Clarification-Seeking in Coding Agents](https://arxiv.org/abs/2603.26233) (2026-03)
  Cited by: Guessed instead of asking.
- [Beyond Final Code: A Process-Oriented Error Analysis of Software Development Agents in Real-World GitHub Scenarios](https://arxiv.org/abs/2503.12374) (2025-03)
  Cited by: Hit the same tool error again and again.
- [ClayBuddy: A Framework, Evaluation, & Mitigation of Coding Agent Failures](https://arxiv.org/abs/2606.19380) (2026-06)
  Cited by: Ran a command that can't be undone.
- [Coding Agents Don't Know When to Act](https://arxiv.org/abs/2605.07769) (2026-05)
  Cited by: Did more than you asked for.
- [Context Length Alone Hurts LLM Performance Despite Perfect Retrieval](https://arxiv.org/abs/2510.05381) (2025-10)
  Cited by: Sessions ran long past where a fresh start would help.
- [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://www.trychroma.com/research/context-rot) (2025-07)
  Cited by: Sessions ran long past where a fresh start would help.
- [Failure as a Process: An Anatomy of CLI Coding Agent Trajectories](https://arxiv.org/abs/2607.09510) (2026-07)
  Cited by: Said it was done without running a check.
- [From Confident Closing to Silent Failure: Characterizing False Success in LLM Agents](https://arxiv.org/abs/2606.09863) (2026-06)
  Cited by: Called a failed run a pass, or its failures unrelated; Said it was done without running a check.
- [From Misuse to Mastery: Enhancing Code Generation with Knowledge-Driven AI Chaining](https://arxiv.org/abs/2309.15606) (2023-09)
  Cited by: Added code that silences errors.
- [How Coding Agents Fail Their Users: A Large-Scale Analysis of Developer-Agent Misalignment in 20,574 Real-World Sessions](https://arxiv.org/abs/2605.29442) (2026-05)
  Cited by: Broke a rule it was given; Did more than you asked for; Guessed instead of asking; Oversold the result; Ran a command that can't be undone; Said it was done without running a check; Stopped to ask permission it didn't need; You had to correct the same thing more than once.
- [How Do AI Agents Spend Your Money? Analyzing and Predicting Token Consumption in Agentic Coding Tasks](https://arxiv.org/abs/2604.22750) (2026-04)
  Cited by: Sessions ran long past where a fresh start would help.
- [How Many Instructions Can LLMs Follow at Once?](https://arxiv.org/abs/2507.11538) (2025-07)
  Cited by: Instruction files grew too long to follow.
- [ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases](https://arxiv.org/abs/2510.20270) (2025-10)
  Cited by: Hard-coded what the tests check for; Removed or skipped tests, or narrowed the test command.
- [LLM Hallucinations in Practical Code Generation: Phenomena, Mechanism, and Mitigation](https://arxiv.org/abs/2409.20550) (2024-09)
  Cited by: Used a file, function or flag that doesn't exist.
- [LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120) (2025-05)
  Cited by: Guessed instead of asking; Sessions ran long past where a fresh start would help.
- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) (2023-07)
  Cited by: Sessions ran long past where a fresh start would help.
- [Measuring AI Ability to Complete Long Tasks](https://arxiv.org/abs/2503.14499) (2025-03)
  Cited by: Repeated the same step without getting further; Stopped before the work was finished.
- [Mitigating LLM Sycophancy in Code Smell Detection Using Evidence-Guided Reasoning Prompts](https://arxiv.org/abs/2607.10411) (2026-07)
  Cited by: Agreed too easily.
- [Monitoring Reasoning Models for Misbehavior and the Risks of Promoting Obfuscation](https://arxiv.org/abs/2503.11926) (2025-03)
  Cited by: Left placeholders in and called the work finished; Removed or skipped tests, or narrowed the test command; Went around a hook, a check or a refusal.
- [Natural Emergent Misalignment from Reward Hacking in Production RL](https://arxiv.org/abs/2511.18397) (2025-11)
  Cited by: Removed or skipped tests, or narrowed the test command.
- [On the Use of Agentic Coding: An Empirical Study of Pull Requests on GitHub](https://arxiv.org/abs/2509.14745) (2025-09)
  Cited by: Did more than you asked for; Hid what it needed from you in a long report.
- [OpenAgentSafety: A Comprehensive Framework for Evaluating Real-World AI Agent Safety](https://arxiv.org/abs/2507.06134) (2025-07)
  Cited by: Exposed a credential, or went looking for one; Ran a command that can't be undone.
- [Prompt Injection Attacks on Agentic Coding Assistants: A Systematic Analysis](https://arxiv.org/abs/2601.17548) (2026-01)
  Cited by: Followed instructions planted in what it read.
- [RedCode: Risky Code Execution and Generation Benchmark for Code Agents](https://arxiv.org/abs/2411.07781) (2024-11)
  Cited by: Ran a command that can't be undone.
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793) (2024-05)
  Cited by: Hard-coded what the tests check for; Hit the same tool error again and again.
- [SWE-Bench+: Enhanced Coding Benchmark for LLMs](https://arxiv.org/abs/2410.06992) (2024-10)
  Cited by: The tests passed, but the fix was still wrong.
- [SWE-chat: Coding Agent Interactions From Real Users in the Wild](https://arxiv.org/abs/2604.20779) (2026-04)
  Cited by: The tests passed, but the fix was still wrong; You had to correct the same thing more than once.
- [SWE-Effi: Re-Evaluating Software AI Agent System Effectiveness Under Resource Constraints](https://arxiv.org/abs/2509.09853) (2025-09)
  Cited by: Repeated the same step without getting further; Sessions ran long past where a fresh start would help.
- [The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management](https://arxiv.org/abs/2508.21433) (2025-08)
  Cited by: Filled the context with huge command output; Forgot earlier work after the context was summarized.
- [The Danger of Overthinking: Examining the Reasoning-Action Dilemma in Agentic Tasks](https://arxiv.org/abs/2502.08235) (2025-02)
  Cited by: Kept deliberating when one step would settle it; Stopped before the work was finished.
- [The State of Secrets Sprawl 2026](https://gitguardian.com/state-of-secrets-sprawl-report-2026) (2026)
  Cited by: Exposed a credential, or went looking for one.
- [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) (2025-12)
  Cited by: Lost or ignored what a helper found; Started helpers the work didn't need.
- [Towards Understanding Sycophancy in Language Models](https://arxiv.org/abs/2310.13548) (2023-10)
  Cited by: Agreed too easily.
- [TRAIL: Trace Reasoning and Agentic Issue Localization](https://arxiv.org/abs/2505.08638) (2025-05)
  Cited by: Broke a rule it was given; Used a file, function or flag that doesn't exist.
- [TRIM: Reducing AI-Generated CodeSlop via Agent Trajectory Minimization](https://arxiv.org/abs/2607.18161) (2026-07)
  Cited by: Left scratch files or debug edits behind.
- [Trust but Verify? Uncovering the Security Debt of Autonomous Coding Agents](https://arxiv.org/abs/2607.12428) (2026-07)
  Cited by: Exposed a credential, or went looking for one; Installed a package it shouldn't have.
- [Understanding Code Agent Behaviour: An Empirical Study of Success and Failure Trajectories](https://arxiv.org/abs/2511.00197) (2025-10)
  Cited by: Repeated the same step without getting further.
- [Understanding Software Engineering Agents: A Study of Thought-Action-Result Trajectories](https://arxiv.org/abs/2506.18824) (2025-06)
  Cited by: Read the same file again when it hadn't changed; Said it did something the log doesn't show.
- [Unsupervised Cycle Detection in Agentic Applications](https://arxiv.org/abs/2511.10650) (2025-10)
  Cited by: Repeated the same step without getting further.
- [We Have a Package for You! A Comprehensive Analysis of Package Hallucinations by Code Generating LLMs](https://arxiv.org/abs/2406.10279) (2024-06)
  Cited by: Installed a package it shouldn't have; Used a file, function or flag that doesn't exist.
- [When Models Edit Too Much: On the Fidelity of Minimal Code Edits](https://arxiv.org/abs/2609.04061) (2026-09)
  Cited by: Did more than you asked for.
- [Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests in GitHub](https://arxiv.org/abs/2601.15195) (2026-01)
  Cited by: Did more than you asked for.
- [Where LLM Agents Fail and How They Can Learn From Failures](https://arxiv.org/abs/2509.25370) (2025-09)
  Cited by: Forgot earlier work after the context was summarized; Oversold the result.
- [Why Do Multi-Agent LLM Systems Fail? (MAST)](https://arxiv.org/abs/2503.13657) (2025-03 (v3 2025-10))
  Cited by: Broke a rule it was given; Called a failed run a pass, or its failures unrelated; Did more than you asked for; Forgot earlier work after the context was summarized; Guessed instead of asking; Lost or ignored what a helper found; Repeated the same step without getting further; Said it did something the log doesn't show; Said it was done without running a check; Stopped before the work was finished.

## Implementation detail

`node tools/sources-index.mjs` writes this file from `lib/problems/catalog.json`, and `test/sources-index.test.mjs` fails when the two disagree, so edit the catalog and run the tool rather than editing this file. A source is known by its address; the tool stops if one address carries two titles, dates or kinds.
