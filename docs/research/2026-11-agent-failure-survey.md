# What coding agents get wrong: a survey behind the November 2026 rule update

## In plain terms

honestweek reads the logs of my AI coding sessions and points at moments where an agent did something known to go wrong, such as saying the tests pass after a run failed. In November 2026 I checked that list of things against what has been published about coding agents since I last looked, and against my own measurements, and updated the checks. This page is the record of what I read, what each source actually shows, and which change each one led to. It also lists what I decided not to build, with the reason.

Nothing here measures how often the new checks are right. Every new finding is marked inferred (a fixed rule's reading that can be wrong), and the page says so wherever it matters.

## How to read the labels

Each claim carries one of three labels, the same ones honestweek uses on its own rows:

- **measured**: counted directly, by the source or by me, and I say who counted and what.
- **derived**: worked out from measured facts by a stated rule.
- **assumed**: not checked. I say what would check it.

A source marked **re-opened** is one I opened at its publisher's own page on 20 November 2026 and read for the claim I use. A source marked **search pass only** was found by a search pass that day and reported to me in summary; I did not open it myself, and no rule rests on it alone.

## What the published sources show

### Agents that report more than they did

| Source | Date | Read | What it shows | Label |
|---|---|---|---|---|
| [Characterizing and Detecting Unfaithful Work Reports by Coding Agents](https://arxiv.org/abs/2611.25760) | 2026-11-19 | re-opened | From real developer and agent conversations, eleven kinds of unfaithful work report in four groups. Overstated task success is the most common. Sorting one out took 4.3 more user turns and 12.71 minutes of recorded response and execution time on average. The share of reports with an unfaithful claim is a blank placeholder on the abstract page, so I don't have that number. | measured by the authors, on their sample |
| [How Coding Agents Fail Their Users (arXiv 2605.29442)](https://arxiv.org/abs/2605.29442) | 2026-05 | in the catalog since October 2026; not re-opened in November | In 20,574 real sessions, inaccurate self-reporting (claiming success, completion or readiness too early) appeared in 22.58% of the episodes where agent and user were at odds. The figure is the one I recorded in October. | measured by the authors |

What I take from these: a wrong "done" or "tests pass" is common and costs real time. That supports the claim checks honestweek already had, and the fixes to them below. It doesn't tell me how often my own rule is right.

### Agents that change the check instead of the code

| Source | Date | Read | What it shows | Label |
|---|---|---|---|---|
| [METR on reward hacking in recent models (June 2025 post)](https://metr.org/blog/2025-06-05-recent-reward-hacking/) | 2025-06-05 | re-opened | On METR's own tasks, recent models raised their score by changing the tests or scoring code, reading the answer the grader checks against, or using other loopholes, and said they wouldn't cheat when asked. The post's rates are for METR's tasks, not for everyday sessions. | measured by METR, on benchmark tasks |
| [ImpossibleBench (arXiv 2510.20270)](https://arxiv.org/abs/2510.20270) | 2025-10-23 | already in the catalog; search pass only in November | Tasks whose tests contradict the spec, so a pass means the agent cheated; the cheating ranged from editing tests to overloading operators. | measured by the authors, on a benchmark |

I found no published report of an agent adding a lint-ignore comment, an empty error handler or a "pass anyway" setting in CI to get a green run. The new check for those rests on the vendor guidance the catalog already cites for "Added code that silences errors", so its basis is **assumed**, and it's worth a look only right after a failed check.

### Instructions planted in what an agent reads

| Source | Date | Read | What it shows | Label |
|---|---|---|---|---|
| [GitHub Copilot: Remote Code Execution via Prompt Injection (CVE-2025-53773)](https://embracethered.com/blog/posts/2025/github-copilot-remote-code-execution-via-prompt-injection/) | 2025-08-12 | re-opened | Planted text made the agent add an automatic-approval line to the workspace settings file. That turned off every confirmation, and the agent then ran shell commands. | demonstrated by the researcher |
| [CVE-2025-61260: Codex CLI command injection via project-local configuration](https://research.checkpoint.com/2025/openai-codex-cli-command-injection-vulnerability/) | 2025-12-01 | re-opened | A repository's `.env` file that pointed Codex's settings folder at a local folder made Codex load that folder's config and run its MCP server commands at startup, with no approval. | demonstrated by the researchers |
| [PromptPwnd: prompt injection in GitHub Actions using AI agents](https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents) | 2025-12-04 | re-opened | Untrusted issue and pull request text put into an agent's prompt in CI made it use its privileged tools, so secrets leaked or workflows were changed. | demonstrated by the researchers |
| [Rules File Backdoor (Pillar Security)](https://www.pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents) | 2025-03-18 | re-opened | Instructions hidden with invisible Unicode characters in a rules file made the editor's agent insert malicious code without mentioning it. | demonstrated by the researchers |
| [GitHub MCP exploited (Invariant Labs)](https://invariantlabs.ai/blog/mcp-github-vulnerability) and [Gemini CLI hijack (Tracebit)](https://tracebit.com/blog/code-exec-deception-gemini-ai-cli-hijack) | 2025-05-26, 2025-07-28 | already in the catalog; search pass only in November | A planted issue led an agent to copy private data into a public pull request; a planted README led an agent to send environment variables off the machine behind a harmless-looking command. | demonstrated by the researchers |

What these have in common, and what a log can show: the planted text arrives in something the agent reads (a tool result), and the harm shows up as an action. honestweek doesn't keep tool results, so it can't see the planted text. It can see two of the actions: an edit to the agent's own settings, and a credential read on a command line that also sends data out. Those are the two I built.

### Packages and workflows that steal secrets

| Source | Date | Read | What it shows | Label |
|---|---|---|---|---|
| [Malicious versions of Nx (GHSA-cxm3-wv7p-598c)](https://github.com/nrwl/nx/security/advisories/GHSA-cxm3-wv7p-598c) | 2025-08-27 | re-opened | Malicious versions of a widely used npm package scanned the file system, collected credentials and posted them to a repository under the victim's own GitHub account. The advisory doesn't name the agent command-line flags that press reports mention. | reported by the maintainers |
| [Shai Hulud campaign, August 2026 (JFrog)](https://research.jfrog.com/post/shai-hulud-is-back-august/) | 2026-08-04 | re-opened | Over 400 infected packages ran a script at install that collected local, CI and cloud secrets. The worm also committed a `.claude/settings.json` and a `.vscode/tasks.json` to repositories it could reach, so its code runs when the folder opens. | measured by JFrog on the sample it analyzed |
| [Microsoft agent-framework compromised (Wiz)](https://www.wiz.io/blog/malicious-version-of-microsofts-agent-framework-published-to-pypi) | 2026-11-17 | re-opened | Two malicious versions of a Microsoft package on PyPI dropped a file that runs a credential stealer every time Python starts. | reported by Wiz |
| [Package hallucinations by code-generating models (arXiv 2406.10279)](https://arxiv.org/abs/2406.10279) | 2024-06 | already in the catalog; not re-opened in November | Models name packages that don't exist at a measurable rate, and someone can register those names. | measured by the authors, for code generation |

What I take from these: installing a package runs someone else's code with my credentials in reach, and an agent's settings file is now a place attackers write to. None of the sources measures how often an agent in an ordinary session installs something it shouldn't. So a plain package add is a note in honestweek, and only three shapes are worth a look: a download run without being read, an install the registry answers with "no such package", and a read of a private key, a credential store or a token. A read of a `.env` file or of the whole environment is a note, unless the same pipeline also sends data out.

### Destructive commands and switched-off permissions

Everything the search pass found here was press coverage or second-hand: an agent that deleted a production database during a freeze, an agent that lost a user's files after misreading a failed command, and command-line flags that turn an agent's permission prompts off being used by malware. I did not find or open a first-hand account of any of them, so they are **search pass only** and I cite none of them in the catalog.

The two rules in this area rest on what the catalog already cited: OpenAI's system card section on avoiding data-destructive actions and both vendors' permission docs, checked in October 2026 and not re-opened in November. Their basis is **assumed** beyond that: it is my own judgment that dropping a table or starting an agent with its sandbox off is worth showing me.

## What my own measurements show

- **The claim check was wrong in both directions.** In October 2026 I measured the check for "said it worked after a check failed" on 30 days of my own logs (398 sessions, 1,345 turns). In 31 turns the last check had failed; the rule flagged 16 of them and none was a real misreport. Eleven were runs that fail on purpose (a new test run against the old code, then the file put back), three were failures the final message named openly, and two or three were later passes the rule couldn't read because the output went to a file or a background job. The one real case sat among the turns it didn't flag: a pull request and a final message said "1,843 tests, 0 failed" after a full run with one failure and a re-run of two files. **Measured**, by me, by reading all 31 turns against the raw logs. Issue 248 in this repository holds the detail.
- **Three fixes were proposed and not built**: set aside a failure when the same file is put back; compare a stated count with the runs that were recorded; read claims wherever they land, including pull request text and commit messages. Issue 248 added a fourth: read a run's result when the agent reads its output file back. **Assumed** to help at the time; this update builds all four, and rerunning them on the same month gives no false flag and finds the real case. That rerun is **measured**, but on the logs the rules were tuned on, so it isn't a precision figure.
- **A passing run chained after an edit wasn't counted** (issue 212), so a commit after it was flagged. One hand-checked case, **measured**. The shape now has a test and reads as a pass; I haven't confirmed what caused the original miss, so the issue stays open.
- **No check's precision is measured yet** (issue 148). That is why every finding from the new rules is inferred, and why only the narrowest shapes are worth a look.
- I also read my private studies of my own sessions. They agree that unverified "done" and "verified" claims are my most common correction. They stay private and nothing from them is reproduced here.

## What changed, and what each change rests on

| Change | What it reads | Rests on |
|---|---|---|
| Claim check: runs that fail on purpose are set aside | A failed run between putting a file in and putting it back | My October measurement (11 of 16 false flags) |
| Claim check: a stated test count is compared with recorded runs | "1,843 tests, 0 failed" against the session's runs | My October measurement (the one real case); the unfaithful-reports paper |
| Claim check: claims are read anywhere in a message, and in pull request and commit text | The whole message; what `gh` and `git commit` write | My October measurement; the unfaithful-reports paper |
| A run's result can be read back from its output file or background job | A later read of the file the run wrote | My October measurement (the unreadable passes) |
| New: an agent started with its permission prompts or sandbox off | The command's own flags | Vendor permission docs in the catalog; assumed beyond that |
| New: a download run without being read | `curl ... \| sh` and its relatives | The supply-chain sources above; no source measures agents doing it, so assumed |
| New: a package added by name, and an install the registry has no package for | Install commands and their recorded error | The Nx, Shai Hulud and agent-framework reports; the package-hallucination paper |
| New: dropped or reset data, torn-down infrastructure | A fixed list of commands | The system card section already in the catalog; assumed beyond that |
| New: a credential file, a token or the environment read, alone or in a pipeline that sends data out | Read commands and the read tool, by file name only | The Nx, PromptPwnd and agent-framework reports |
| New: an edit to an agent's own settings, hooks, permission rules or MCP servers | The edited file's name and which keys the new text holds | The Copilot and Codex CLI reports; the Shai Hulud report |
| New: a check switched off in code or CI | Ignore comments, empty error handlers, CI steps set to pass anyway, netted across a turn | Vendor guidance already in the catalog; assumed, since I found no report of agents doing it |

Two of the new rules read a failure. The package rule reads an install's own recorded error for "no such package". The switched-off-check rule reads whether a check failed earlier in the turn, with the same reading the claim check now uses: a run that fails on purpose is set aside, and a failure followed by a clear pass doesn't count. Tests hold both. The other five read no result at all.

Two of the reports I cite for the settings rule (the Codex CLI report and the Shai Hulud report) show an attacker writing an agent's settings, not an agent doing it. They're there because they show why that file matters, and the catalog's wording for each says who did the writing.

## What I did not build

- **Reading tool results for planted instructions or hidden Unicode.** That is where an injection arrives, and four of the sources above show it. honestweek's engine doesn't keep tool results, by design, and its privacy page says so. Building this means changing both log readers and that promise, so it needs its own change. "Followed instructions planted in what it read" still has no check.
- **A list of known-bad package versions.** The reports name exact versions, but a list shipped in a tool that never goes online is out of date the day after.
- **Comparing an installed package with the project's manifest.** Without it, a package the project already declares reads the same as a new one. The catalog marks the check as partial for that reason.
- **Tests special-cased or graders patched** (the METR shapes). Telling a hard-coded answer from ordinary code needs a reading of the code that a fixed rule can't make.
- **Made-up verification output** ("grep found 12 matches" with no such command). My own studies show it happens; matching a quoted result to a recorded command is a larger piece of work.
- **Writes to an agent's settings made by a shell command.** Only edits made with the edit tools are read.
- **"Done" in the middle of a long message.** Every mid-message hit was a false alarm when I measured it in October, so that stays as it was. The pull request brief still reads a message's start and end.
- **Any measure of how often the new checks are right.** That waits on issue 148.

## Implementation detail

- The catalog (`lib/problems/catalog.json`) is version 0.2.0 and adds 20 November 2026 to its checked dates. It gains the nine re-opened sources, on the patterns `unverified-done-claim`, `claim-contradicts-evidence`, `test-tampering`, `special-casing-tests`, `bypassing-safeguards`, `unsafe-dependency`, `secret-exposure` and `prompt-injection-followed`. `docs/sources.md` is rebuilt from it.
- New rule ids: `problems.agent-permissions-off`, `problems.remote-script`, `problems.package-add`, `problems.data-destroy`, `problems.credential-read` (all in the `risky-command` check), and `problems.agent-config-edit` and `problems.silenced-check` (the new `guardrail-edits` check). The readers are in `lib/problems/classify.mjs`.
- The patterns `unsafe-dependency` and `error-swallowing` now have a check; `prompt-injection-followed` still has none.
- Tests: `test/problems-checks.test.mjs` and `test/problems-priority.test.mjs` hold a hit and a quiet partner for each new rule; `test/claim-check.test.mjs` holds the claim check's.
- The claim-check changes came from issue 248 and its pull request, which this update carries.
