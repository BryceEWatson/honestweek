# Plan: where honestweek fits into how I work (October 2026)

## In plain terms

honestweek reads my Claude Code and Codex session logs on my own machine. This plan says where it would save me the most time or catch the most mistakes in my day, measured on my last two weeks of sessions, and ranks what to build. The biggest win is letting honestweek do the "what's waiting on me?" sweep that a coordinating session now does by hand, reading dozens of other sessions to find unanswered questions, stalled work and pull requests nobody owns. Second is saying which of my habits make sessions re-send their whole conversation at full price, and third is checking a session's "done" and "tests pass" before it closes. Nothing here publishes anything or sends anything off the machine. Each item ends with the one word that approves it.

## How I ranked

The lens is my attention: the minutes I spend checking on sessions and the mistakes that slip past me, with tokens as a second weight. honestweek is a free, public tool rather than a business ([Who it's for](#who-its-for-and-what-it-isnt)), so the bet I'm validating is that it earns daily use from its own author. An item that puts honestweek in a loop I already run every day ranks above one that adds a new loop.

Every number below is labelled the way honestweek labels its own rows:

- **measured**: counted directly from logs, git or GitHub;
- **derived**: worked out from measured facts by a fixed rule, such as honestweek's token estimates;
- **inferred**: a rule's reading that can be wrong, such as a check deciding a message claims "done";
- **assumed**: not checked.

When a count stands in for something it can't see directly (a *proxy*), the row says so.

When I asked a session to review a day's mistakes on 10 October, what I wanted back was a short list for a stated window, reached by one command, with every finding opening on its zoomed timeline; I asked for exactly that link the same night ([#240](https://github.com/BryceEWatson/honestweek/issues/240)). Every item here keeps that shape: a short list, each row a link to its moment.

## The ranked plan

| Rank | Item | Saves or catches | Effort | Privacy risk | Reply |
|---|---|---|---|---|---|
| 1 | A "what's waiting on me" sweep from the logs | The hand sweep of every session | Medium | Low | `build sweep` |
| 2 | Say what woke each cold session | The habits behind the biggest cost leak | Small | None | `build wake` |
| 3 | Check "done" claims before a session closes | Unbacked "done" and "tests pass" | Small | None | `wire close` |
| 4 | A daily results file, run without a model | Makes 1 and 2 instant and free | Small | Low | `daily` |
| 5 | Pull-request reviews start from the brief | Claims a diff-only reviewer misses | Already planned | Low | `keep order` |
| 6 | Session ids in commit messages | Turns guessed links into recorded ones | Small | Low | `trailer` or `skip` |

Items 1, 2 and 4 depend on each other: 4 is what makes 1 and 2 cheap enough to show every morning. Item 5 is already approved work; this plan only files its kit half (the *kit* is the shared skills and instructions every one of my Claude sessions inherits).

### 1. A "what's waiting on me" sweep from the logs

**What it replaces.** On 10 October one coordinating session read the ends of about 50 other sessions through helper agents to find questions I never answered, promises nobody kept, pull requests nobody owned and work nobody pushed, then rebuilt my "Needs you" page by hand. (The *Needs you page* is a local HTML page listing everything waiting on my word, built from a hand-written list.) The kit has no detector for an unanswered question or a stalled promise: the status brief (the summary every session prints when it starts) lists items carrying an ask label, but nothing finds an ask a session made in its own chat and I never saw. honestweek already reads every session and knows which turns I typed, so it can do this sweep in seconds, for no model tokens.

**What it would do.** A new answer, `honestweek waiting`, lists per session:

- the session ended its last turn asking me something, and I never replied (an *unanswered ask*);
- the session said it would do something next and then went quiet for longer than a set time (a *stalled promise*);
- a pull request a session opened that no session has touched since, and that nothing shows was merged or closed (an *orphan pull request*). honestweek reads no network, so it can say "open" only from a current `--prs <file>` (the output of `gh pr list` I hand it, the same way the brief takes `gh` output). Without one, the row says "last seen open" with the time a session last printed it, since it may have closed since;
- commits a session made that never reached a remote branch.

Each row links to the moment on the local page, says how it's known, and quotes the ask. A kit change then has the Needs-you page start from this list instead of from a hand sweep, and the coordinating session judges only the rows, never re-reads the sessions.

**Evidence.** From 27 September to 11 October, 5 sessions ran a sweep like this by hand, each with between 3 and 25 helper agents and between 22 and 126 reads of other sessions' logs (derived, a proxy for sweeps; helper counts are floors). Between sweeps I check sessions one at a time: about 66 of my prompts in that window ask a session for its status, about 4.7 a day (derived). And the asks pile up: of the 159 sessions I typed in or launched whose last word was the agent's, 51 end on an ask-shaped message and 45 of those are more than a day old (derived, an upper bound, since some were settled from another session). How each was counted is under [How the numbers were taken](#how-the-numbers-were-taken). The 10 October sweep's own page names four orphan pull requests and seven open asks, all found by reading sessions.

**Cost of the current way.** A coordinating session that messages an idle session to ask its state wakes it, and a woken session re-sends its whole conversation (see item 2). Of the 65 cache-miss findings in the last 14 days, 15 sit next to a message from another session, about 7.3 million tokens re-sent (derived; the cause is honestweek's positional guess, inferred).

**Effort.** Medium. honestweek already records a question asked through Claude Code's question prompt and whether I answered it, but most of my sessions ask in plain text ("reply `merge` to land it"), so an ask in the last message needs a new rule, and so does a stalled promise. Both stay deliberately narrow, and its precision has to be measured before the page trusts it (issue [#148](https://github.com/BryceEWatson/honestweek/issues/148)'s judging buttons would cover it).

**Privacy.** Low. It quotes my own sessions back to me, redacted the way `view` shows them, on my machine. The Needs-you page is already local and private.

**Decision.** On 8 October I said honestweek only needs to work in chats inside its own folder. This item reads every project's sessions, which the user-level config already allows, and is run by the kit, not by a session in each project. Reply `build sweep` to build it, or `skip` to keep the hand sweep.

### 2. Say what woke each cold session

**What it replaces.** Guessing why sessions are expensive. honestweek's cache check already finds a session that re-sent its cached conversation at full price after a pause longer than the cache lasts (one hour for these sessions). It doesn't say what woke it, so the fix isn't obvious.

**Evidence.** Over 28 September to 11 October, honestweek made 65 cache-miss findings in 41 sessions, covering 125 full-price re-sends and about 37.6 million tokens (derived: honestweek's estimate, summed over every finding; one finding groups a session's re-sends, so a finding isn't one miss). Each finding's nearest step, from honestweek's positional guess (inferred):

| Nearest step | Findings | Re-sends | Tokens re-sent |
|---|---|---|---|
| A message from another session | 15 | 23 | 7.3M |
| A prompt I typed (two were my merge word, after a wait for it) | 7 | 18 | 5.9M |
| A background task finishing | 4 | 4 | 1.4M |
| A tool call, so the real cause is unknown | 23 | 52 | 12.6M |
| Something else (a pull-request link, a queue change, a prompt hook) | 16 | 28 | 10.4M |
| **Total** | **65** | **125** | **37.6M** |

Claude Code's own `/usage` screen now names likely cache-miss causes for one session at a time ([costs docs](https://code.claude.com/docs/en/costs)), so honestweek's value is the cross-session total by cause, over weeks, for Claude Code and Codex alike.

**What it would do.** Each cache-miss finding names the event that started the turn (my reply, a message from another session, a background task, a scheduled wake) as recorded where the log says so, and `problems --pattern cache-miss` totals tokens by cause. Then I can decide on facts: if waiting for my merge word is the main cause, the fix is in my landing rule; if coordinating sessions are, it's item 1.

**Effort.** Small: the turn's first event is already parsed.

**Privacy.** None new.

**Decision.** Reply `build wake`.

### 3. Check "done" claims before a session closes

**What it replaces.** Trusting the closing summary. The session-end skill writes a record of claims and whether each was verified, but by reading the conversation, not by pairing each claim with the check that ran.

**Evidence.** In the same 14 days honestweek flagged 21 "said it was done without running a check" findings in 9 sessions and 40 "called a failed run a pass" findings in 15 sessions (inferred; how often these checks are right isn't measured yet, issue [#148](https://github.com/BryceEWatson/honestweek/issues/148)). When I correct a session, the most common reasons are a fact it got wrong (about 30 of my 1,361 typed prompts in 14 days) and asking whether something was reviewed (about 13) (derived, one reader's hand coding, approximate).

**What it would do.** The session-end skill runs `honestweek problems --session <this session>` and lists only the claim findings, each with its step link, before it writes the record. A finding is a prompt to check, never a verdict.

**Effort.** Small, all in the kit. It waits on nothing, but until #148 measures precision it shows at most three findings so a noisy check can't bury the record.

**Privacy.** None: same machine, same session.

**Decision.** Reply `wire close`.

### 4. A daily results file, run without a model

**What it replaces.** Running the checks live. A 14-day `problems` run over my logs (5.0 GB) didn't fit in Node's default memory: it stopped at 9 days and asked for a bigger heap. With 12 GB it took about 1.5 minutes (measured). One day takes about 4 seconds (measured). The status brief that starts every session has a 40-second budget for everything, so it can't run the week live.

**What it would do.** A plain operating-system scheduled task (no Claude session, so no tokens) runs `waiting` and `problems --days 1` each morning and writes their JSON beside my config, private and gitignored. The status brief reads one line from it ("yesterday: 4 cold re-sends, 1.9M tokens; 3 asks waiting on you") and the Needs-you page reads the waiting list. honestweek's part is a `--out` option and a stable shape for that file; the scheduling is the kit's.

**Effort.** Small.

**Privacy.** Low: a new file of redacted findings beside the config, readable only by me.

**Decision.** Reply `daily`.

### 5. Pull-request reviews start from the brief

**What it replaces.** Reviewers that see only the diff and the author's summary. The *brief* is honestweek's record of how one pull request was made: the sessions behind it, the checks they ran, and each claim they made with whether a check backs it. From 27 September to 11 October my repositories merged 222 pull requests (measured from GitHub, across the 8 repositories in my kit's list). `honestweek brief` on one merged pull request took 28 seconds and listed 6 claims, 4 with no check behind them (measured, on one pull request; a sample of one).

**Status.** Already planned and approved, in this order: first a review skill that hands reviewers the brief ([#225](https://github.com/BryceEWatson/honestweek/issues/225)); then a measurement of whether the brief actually helps a reviewer ([#226](https://github.com/BryceEWatson/honestweek/issues/226)); and only then a Review page, a local page for reading a brief ([#214](https://github.com/BryceEWatson/honestweek/issues/214)). What wasn't filed is the kit half, decided in [#227](https://github.com/BryceEWatson/honestweek/issues/227): my review loop gives the brief to its execution check (the step that runs the tests) and to one reviewer that checks the author's claims. I've filed that in my kit's tracker, waiting on #225.

**Decision.** Reply `keep order` to keep that sequence. The alternative is building the Review page before #226 shows the brief helps, which I don't recommend.

### 6. Session ids in commit messages

**What it replaces.** Guessed links. `find` and `brief` work out which session made a commit from the logs, and many of those links are inferred. Tools like [Entire](https://docs.entire.io/core-concepts) and [Git AI](https://usegitai.com/docs/get-started/how-git-ai-works) write the session's id into the commit itself, and [Copilot's coding agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilot-sessions) links each commit to its session log. A one-line `Session:` trailer (a `Key: value` line at the end of a commit message) would let honestweek record the link instead of inferring it.

**Effort.** Small in both places: the kit's commit instructions add the line, and honestweek reads it as recorded.

**Privacy.** Low but real: a session id is a random id, yet it would appear in public repositories' history. Reply `trailer` to do it, or `skip`.

## What I'm not proposing, and why

- **A cost status line.** Claude Code's status line already gets cost, context use and rate limits as input, and [ccusage](https://ccusage.com/guide/statusline) shows burn rate there. honestweek reading logs on every turn would be slower than both and add nothing.
- **Installing honestweek's skills in every project and for Codex.** I decided against that on 8 October. Items 1 and 4 run from the kit and need only the user-level config.
- **A Review page now.** Waits for #226's measurement, as agreed.
- **Uploading or sharing anything.** Several peers add a share or upload path ([Sniffly](https://github.com/chiphuyen/sniffly), [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts), [SpecStory](https://docs.specstory.com/cloud/sync-and-store)). honestweek never sends anything, and that's a reason to use it.
- **Replacing the worktree sweep.** The kit's weekly worktree sweep already finds uncommitted and unlanded worktrees. Item 1 lists only commits a session made that never reached a remote, and links to the sweep for the rest.

## Who it's for, and what it isn't

honestweek is MIT-licensed and free. This plan is about its author's own daily use, which is also the evidence its find-and-check goal says it's missing: a person who reaches for it without being reminded.

## What other tools do

I checked the closest tools on 11 October, from their own docs. Patterns worth copying, and what I took from each:

- **Hooks are where everyone plugs in.** Langfuse, LangSmith, Braintrust, Arize Phoenix, Git AI and Entire all attach to Claude Code's session and turn hooks ([Claude Code hooks](https://code.claude.com/docs/en/hooks), [Langfuse](https://langfuse.com/integrations/developer-tools/claude-code), [Phoenix](https://arize.com/docs/phoenix/integrations/coding-agents/claude-code)). Item 3 uses the existing session-end step rather than a new hook, since honestweek reads logs after the fact.
- **Provenance travels with the commit.** Entire adds a checkpoint line to each commit, Git AI writes git notes, and Copilot links each commit to its session log. That's item 6.
- **The pull request is where reviewers look.** CodeRabbit and Copilot put their summary in the pull request itself ([CodeRabbit](https://docs.coderabbit.ai/pr-reviews/summaries)). honestweek's brief stays a draft I paste, never a post, which is item 5's shape.
- **Flags beat raw numbers.** Claude Code's `/usage` flags any behavior that's 10% or more of recent usage and names a likely cache-miss cause ([costs docs](https://code.claude.com/docs/en/costs)). That covers one session; item 2 adds the cross-session, cross-agent total by cause.
- **Report by time window.** ccusage reports by day, week and five-hour block ([ccusage](https://github.com/ryoppippi/ccusage)), and claude-code-log filters by "last week" ([claude-code-log](https://github.com/daaain/claude-code-log)). Item 4's daily file fits that.
- **Local and private is rare in full.** Most transcript viewers add an upload or share path, and hosted tracers send everything off the machine; Weights & Biases' plugin says outright it doesn't scrub personal data ([Weave](https://docs.wandb.ai/weave/guides/integrations/agents/claude-code-harness.md)). Nothing here changes honestweek's no-network rule.

None of the tools I found does item 1: none reads a fleet of sessions to say which ones are waiting on their person.

## Implementation detail

### How the numbers were taken

- All runs used honestweek at commit `59b301d` (main after #241) with my user-level config, on 11 October.
- `problems --days 14 --json` with `node --max-old-space-size=12288`: 290 sessions, 41,324 model calls (recorded), 28 September to 11 October. With the default heap the same run loaded only 3 to 11 October and printed the memory note.
- `problems --days 14 --pattern cache-miss --json`: 65 findings, 41 sessions, `estimate` summed to 37,629,859 tokens, and `steps` (the re-sends each finding groups) summed to 125. The cause split groups each finding's `text` (the step `problems` places nearest the miss) by its kind; a finding's tokens and re-sends all go to that one step's kind.
- Claim checks: `unverified-done-claim` 21 findings, all listed, in 9 sessions; `claim-contradicts-evidence` 40 findings, and the 25 listed fall in 15 sessions, so "15 sessions" is a floor.
- `brief BryceEWatson/honestweek#241`: 28.6 s, 6 claims, 4 with no check after the last edit that didn't fail.
- Merged pull requests: `gh pr list --state merged --search "merged:>=2026-09-27"` per repository in the kit's list, summed.
- Transcript counts (sweeps, status prompts, asks, corrections): a streaming pass over every Claude Code project folder and the desktop app's no-folder sessions active from 27 September to 11 October, 556 session files. A typed prompt is a user record that isn't a tool result, meta or sidechain line, compaction summary, notification, scheduled task, message from another session, or chip launch; 1,361 after removing forked copies. Codex had 7 logs in the window and none held a typed prompt.
- Hand sweeps: sessions with a prompt asking for a review across other sessions, counted with their tool calls that read other sessions' transcripts. A proxy for sweeps; helper-agent counts are floors.
- Status prompts: a phrase search over typed prompts, then read through by hand.
- Asks: a session whose last assistant message comes after my last typed prompt and whose last 700 characters end in a question or a reply cue ("reply `x`", "your call", "want me to"), excluding a message that opens "Nothing needs you".

### Where each item lands

| Item | honestweek | Kit |
|---|---|---|
| 1 | [#242](https://github.com/BryceEWatson/honestweek/issues/242) `waiting` command, its JSON and the find skill's answer | kit issue 1311 Needs-you page and status brief read it |
| 2 | [#243](https://github.com/BryceEWatson/honestweek/issues/243) cache-miss findings name what woke the session; totals by cause | none |
| 3 | none | kit issue 1312 session-end lists claim findings for its own session |
| 4 | [#244](https://github.com/BryceEWatson/honestweek/issues/244) `--out` for `waiting` and `problems`, a stable file shape | kit issue 1311 the scheduled task that runs them |
| 5 | #225, #226 (existing) | kit issue 1313 review loop hands the brief to its execution check and one claims lens |
| 6 | [#245](https://github.com/BryceEWatson/honestweek/issues/245) read a `Session:` trailer as a recorded link | kit issue 1314 commit instructions add the trailer |

### Existing pieces each item builds on

- Questions and their answers: the engine records a question asked through the question tool (`AskUserQuestion`, Codex `request_user_input`) and my answer (`lib/replay/claude.mjs`, the `answered-question` decision). A question in an agent's plain text isn't classified today; `prompt.question` in `lib/replay/classify.mjs` covers only my own messages.
- Typed versus program-sent turns: the engine separates them already, which the kit's own retro count gets wrong (kit issue on retro counting by last activity). Item 1 reuses it.
- Cache misses: `lib/problems/checks.mjs`, the `cache-miss` check.
- Offline pull-request facts: the brief's `gh` output reading (`lib/review/`), which item 1 reuses for "still open".
- The status brief: the kit's `status.mjs`, which has a 40-second cap and no cost or `problems` line today.
- The Needs-you page: its builder only turns a hand-written Markdown list into HTML; it discovers nothing.
