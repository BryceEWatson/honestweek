# Security gaps after the November 2026 rule update

## In plain terms

honestweek reads the logs of my AI coding sessions and points at moments that are worth a second look. Its November 2026 rule update (see [the agent failure survey](2026-11-agent-failure-survey.md)) added seven safety rules, such as an agent started with its permission prompts off, or a credential file read. This page checks what has been published about coding-agent security since then and lists what honestweek still can't see, ranked by how much each gap matters. It also checks honestweek itself against the same attacks, since it reads untrusted text and runs a local web page.

The short version, as my judgment rather than a count (assumed): honestweek already covers most of the actions these attacks leave behind. The three biggest gaps are data being sent out through a channel other than a plain upload, agent settings changed by a shell command rather than the edit tool, and everything that arrives in a tool's output, which honestweek doesn't read at all.

## How to read the labels

The same labels as the November survey:

- **measured**: counted or run directly, and I say what.
- **derived**: worked out from measured facts by a stated rule.
- **assumed**: not checked. I say what would check it.

Sources here were gathered on 22 November 2026 by one search pass. A source marked **opened** was opened at its publisher's page by that pass; **search only** came from search summaries. A source marked **re-opened** was opened again that day and read for the claim used here; those five are in the problems catalog. They back the DNS lookup, the image link, the settings-file writes and the git hook shapes of the two rules built from this page. The lists of collecting services and tunnels, and the `core.fsmonitor`, `core.sshCommand`, filter and `.gitattributes` shapes, are my own choice from sources that weren't re-opened (assumed). Several 2026 CVE numbers below have an unusual length; treat every identifier and every figure from a source not marked re-opened as unconfirmed.

## What's new since the November survey

### Data sent out through side channels

| Source | Date | Read | What it shows |
|---|---|---|---|
| [Claude Code DNS exfiltration (CVE-2025-55284)](https://embracethered.com/blog/posts/2025/claude-code-exfiltration-via-dns-requests) | 11 Aug 2025 | re-opened | Planted text made the agent encode data into a hostname and look it up, so the data left through DNS with no upload command. |
| Claude Code WebFetch trusted-domain prefix match ([GHSA-vhw5-3g5m-8ggf](https://github.com/advisories/GHSA-vhw5-3g5m-8ggf)) | 2026 | opened | A lookalike host such as `trusted.com.evil.example` passed the trusted-domain check. |
| Claude Code pre-approved download host as a covert channel ([GHSA-fg94-h982-f3mm](https://github.com/anthropics/claude-code/security/advisories/GHSA-fg94-h982-f3mm)) | Jun 2026 | opened | Requests to an allowed host carried data out through what they asked for. |
| Codex Desktop markdown image auto-fetch ([OpenAI advisory](https://openai.com/security/advisories/cve-2026-14898/)) | 30 Oct 2026 | re-opened | An image link in the agent's reply, with data in its address, was fetched as soon as it showed. |
| Claude Code GitHub Action read `/proc/self/environ` ([Microsoft](https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/)) | 5 Jun 2026 | re-opened | Planted text made the Read tool read the process environment and send the API key out with its prefix trimmed to dodge secret scanners. |

**What honestweek sees today:** the credential-read rule (`problems.credential-read`) already reads `/proc/*/environ`, and it raises a read to "worth a look" when the same pipeline sends data out. It doesn't recognise DNS lookups with long encoded names, uploads to catch-all hosts (webhook and tunnel services), or an image link carrying data in the agent's own message. The agent's messages are already read, so the image check needs no new input.

### Agent settings written by a shell command

| Source | Date | Read | What it shows |
|---|---|---|---|
| [Mini Shai-Hulud (SonarSource)](https://www.sonarsource.com/blog/mini-shai-hulud-targets-ai-coding-agents/) | 26 May 2026 | re-opened | An npm worm wrote a session-start hook into `.claude/settings.json` that runs `node .claude/setup.mjs`, plus a VS Code task that runs when the folder opens, and spread to other projects on the machine. |
| [keyv wave (GitGuardian)](https://blog.gitguardian.com/keyv-mini-shai-hulud/) | Aug 2026 | opened | The next wave scanned 469 places by the report's count (not re-opened), including Cursor, Codex and Gemini settings. |
| [Codex PowerShell `--%` approval bypass (OpenAI advisory)](https://openai.com/security/advisories/cve-2026-19591/) | 30 Oct 2026 | re-opened | Repository instructions could run a git command through PowerShell without approval, and where git could write Codex's config, that command could add an attacker's MCP server (a plug-in tool server). The advisory reports no known abuse. Sibling advisories cover git hooks, `core.fsmonitor` and attribute filters that run code when a folder opens. |
| [Claude Code settings in a cloned repository (Check Point)](https://blog.checkpoint.com/research/check-point-researchers-expose-critical-claude-code-flaws/) | Feb 2026 | opened | A repository's own settings started hooks and MCP servers, and redirected API traffic, before the user trusted the folder. |

**What honestweek sees today:** the agent-config-edit rule (`problems.agent-config-edit`) reads edits made with the edit tools to these files, including `.cursor`, `.gemini`, `config.toml`, `tasks.json` and `hooksPath`. The November survey listed "writes made by a shell command" as not built. These sources show that's exactly how the writes happen: `echo >`, `tee`, `sed -i`, `git config core.hooksPath`, `claude mcp add`, `codex mcp add`.

### Secrets that end up on disk

| Source | Date | Read | What it shows |
|---|---|---|---|
| [Claude Code issue 71654](https://github.com/anthropics/claude-code/issues/71654) | Jun 2026 | opened | A token printed by a password manager command, and one in an error message, were saved word for word in the session log. |
| "Don't ask again" saves secrets into `.claude/settings.local.json` (Apiiro, via qodo.ai) | 5 Nov 2026 | search only | Approving a command for good saves it, credentials and all, as a permission rule. A search summary reports that the study counted 2,539 distinct secrets in 1,994 public repositories, and that two common scanners missed 215 (not opened; unconfirmed). |

**What honestweek sees today:** the secret-in-log check (`problems.secret-in-log`) counts secret shapes in prompts, tool inputs and agent messages, never in tool output, which is where issue 71654's tokens sat. Nothing reads the permission rules in a repository's `.claude/settings.local.json`.

### Instructions planted in what an agent reads

| Source | Date | Read | What it shows |
|---|---|---|---|
| [MCP tool poisoning (Invariant Labs)](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) | Apr 2025 | opened | Hidden instructions in a tool's description made the agent read SSH keys and pass them in an extra argument. A tool can change its description after you approve it. |
| A live MCP rug-pull campaign (Cloud Security Alliance note on a Pillar Security finding) | Aug 2026 | search only | A promoted MCP server changed its tool list after its third call to tell the agent to find SSH keys, cloud credentials and shell history. |
| Prompt injection through pull request and issue comments, affecting three vendors' CI agents (SecurityWeek) | Apr 2026 | search only | Hidden HTML comments in titles and bodies made CI agents leak secrets. |
| Malicious skills (Snyk audit, Koi's ClawHavoc, via a CSA note) | Feb to May 2026 | search only | Skill files whose steps upload files or install a stealer. |

**What honestweek sees today:** nothing. This is the November survey's first "did not build" item, and in my judgment (assumed) it's still the largest blind spot, because the planted text only ever appears in a tool's output.

### Commands shaped to slip past approval

Claude Code, Copilot CLI, Cursor and Codex each fixed approval bypasses in 2025 and 2026 that rest on shell tricks: `$IFS`, `${var@P}`, `${!var}`, `>|`, `sed ... w`, `find -exec`, PowerShell's `--%`, and shell built-ins that change `PATH` or `NODE_OPTIONS`. Sources are the vendors' advisories ([Copilot CLI GHSA-g8r9-g2v8-jv6f](https://github.com/advisories/GHSA-g8r9-g2v8-jv6f), opened; the Claude Code ones through advisory mirrors, search only). An ordinary session almost never needs these shapes, but I haven't measured that on my own logs (assumed).

## What honestweek itself got right, and one thing to keep

I checked honestweek against the same classes of attack, since it reads attacker-controlled text and serves a local page.

- **A planted `git.exe`.** Claude Desktop on Windows ran a `git.exe` committed to a repository ([GHSA-4p2j-qj3c-6x84](https://github.com/anthropics/claude-code/security/advisories/GHSA-4p2j-qj3c-6x84), opened). honestweek runs `git` by name too, in repositories it didn't choose during setup. **Measured** on Windows 11 with Node 22.23.5: a fake `git.exe` in the working folder, and in the folder passed as the run's working folder, didn't run; the real git answered both times. Node 18 and 20 weren't tried. A test that pins this would keep it true.
- **Secret shapes.** **Measured:** the redactor replaced current GitHub, Anthropic (including a key with its prefix trimmed), OpenAI project, npm, Google, Hugging Face and AWS key shapes.
- **The local page.** `view` already does what the localhost CVEs lacked (Claude Code's IDE extension, MCP Inspector, the MCP SDK's DNS-rebinding default): it binds to loopback, checks the host, refuses other sites and needs a per-run key. Its content security policy blocks every script that isn't one of its own files, which is the guard OpenCode's markdown XSS lacked.
- **Releases.** The release workflow can publish with a stored npm token. npm's trusted publishing, where GitHub proves who's publishing and no token exists to steal, would remove that token. Releases normally go out from my own terminal with two-factor, so this is small (assumed: I didn't check whether the token is set).
- **Pinned actions.** CI pins each action to a commit, which is the right defence, but nothing proposes updates to those pins.

## Recommended changes, ranked

Items 1 and 2 are built (see "What was built" below); the rest are proposals.

Ranked by how much each adds to the bet that honestweek can say what happened in a session, honestly. Each is a new rule or a widened one, every finding is marked inferred, and each needs a hit test and a quiet partner, as before.

1. **Data sent out through side channels** (new rule in the risky-command check). DNS lookups with long encoded names, uploads to catch-all hosts, a fetch to a lookalike of a host seen earlier, and image links carrying data in the agent's own message. Reads only what's already read. Small.
2. **Agent settings written by a shell command** (widens the agent-config-edit rule). The same file list, matched in shell write shapes and in `git config`, `claude mcp add` and `codex mcp add`. Closes a gap the November survey named. Small to medium.
3. **Read tool output, in memory, for counts only** (one change that unlocks three checks). Secret shapes in tool output, hidden text (invisible Unicode, HTML comments) in what the agent read, and a tool list that changes mid-session. This changes a promise in the privacy page (tool output isn't read), and both log readers, so it needs your word before it's built. Medium to large.
4. **Approval-dodging command shapes** (new note-level rule). The shell tricks above. Small, but its false-alarm rate is unknown until it runs on a few weeks of my logs.
5. **Secrets in saved permission rules** (new check). Read `.claude/settings.local.json` in the configured repositories, count secret shapes, and say whether git tracks the file. Never shows the text. Small.
6. **Agent extensions added** (widens the package-add rule). Plugin, skill and MCP server installs, as notes. Small.
7. **Re-open and cite the new sources** in the problems catalog, the way the November survey did, before any rule above ships. Needed for each rule's backing.
8. **Small hardening**: a planted-`git.exe` test, Dependabot for the pinned actions, and trusted publishing in the release workflow.

## What was built

- **Item 1**, as a new rule in the risky-command check, `problems.exfil-route`. A DNS lookup whose name holds a command, a variable named like a login, or a part that reads as data (32 or more letters and digits mixed, no hyphen: my own cut, set above the 24-character limit on cloud storage names) is worth a look. A name built from any other variable is a note, since `db.$NAMESPACE.svc.cluster.local` is ordinary cluster work. A request or web fetch to a collecting service is worth a look; one to a tunnel is a note. An image link in the agent's message is a note when it goes to a tunnel or carries a base64-shaped piece of 32 or more characters (upper case, lower case and digits, so a hex hash or a UUID path isn't counted), and worth a look when it goes to a collecting service or carries a secret shape. Cut from item 1: a fetch to a lookalike of a host seen earlier. Telling a lookalike from an ordinary subdomain needs a list of the hosts a session trusts, which the logs don't hold, so I left it out rather than guess.
- **Item 2**, as a widening of `problems.agent-config-edit` in the guardrail-edits check. A shell command that ran and wrote one of the same settings files (a redirect, `tee`, `sed -i`, `cp`, `mv` or PowerShell's writers), ran `claude`, `codex` or `gemini mcp add`, set `core.hooksPath`, `core.fsmonitor`, `core.sshCommand` or a filter command with git config, wrote a git hook, or wrote a `.gitattributes` filter line other than Git LFS's. Pointing hooks at nothing stays the skip-checks finding it already was. A copy into an editor settings file or a .env file isn't counted, since its text can't be seen, and neither is a write from inside a script (`node -e`, `python -c`).
- Neither rule has been measured on real logs yet, so how often each is right is unknown (assumed), as with the November rules.

## What I'd still not build

- **A list of agent versions with known security fixes.** The logs may record the agent's version (assumed: I didn't check either log format), so honestweek could flag sessions run on an unpatched agent. But a list shipped in a tool that never goes online goes stale, which is why the November survey turned down the same idea for packages.
- **A list of known-bad hosts or packages**, for the same reason. The collecting services and tunnels in item 1 are a short list of my own (assumed), and it can go stale too. A host missing from it means a missed finding, never a false one, so it fails toward under-claiming. I'll re-check it with the next survey.

## OWASP mapping

The [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026) (search only for the item names): items 1 and 3 above map to goal hijack (ASI01) and memory and context poisoning (ASI06); item 2 to unexpected code execution (ASI05); items 5 and 3 to identity and privilege abuse (ASI03); item 6 to agentic supply chain (ASI04); item 4 to tool misuse (ASI02).

## Implementation detail

- Existing rules this page builds on, all in `lib/problems/classify.mjs` and `lib/problems/checks.mjs`: `problems.credential-read` (already lists `/proc/*/environ`), `problems.agent-config-edit` (edit tools only; already names `.cursor`, `.gemini`, `config.toml`, `tasks.json`, `hooksPath`, `autoApprove`, `mcp.json`), `problems.package-add`, and the `secret-in-log` check.
- Tool output is parsed in `lib/replay/claude.mjs` (around line 431) and `lib/replay/record-output.mjs`, but the problems checks don't read it. Item 3 would change `SECURITY.md` and `docs/where-your-data-goes.md`.
- `git` is started in `lib/git.mjs` `gitExec` with `execFileSync('git', ...)`, no shell. The planted-binary check copied `hostname.exe` to `git.exe` in a temp folder and ran `git --version` from it, with and without the `cwd` option.
- The redactor check ran `createSecretsOnlyRedactor()` from `lib/redact.mjs` on synthetic tokens of each shape.
- `view`'s policy is `CSP` in `lib/view/server.mjs`; `preview` sets its own in `lib/preview.mjs`. The release workflow is `.github/workflows/release.yml` (`id-token: write`, with an `NPM_TOKEN` fallback). There's no `.github/dependabot.yml`.
