# honestweek

[![CI](https://github.com/BryceEWatson/honestweek/actions/workflows/ci.yml/badge.svg)](https://github.com/BryceEWatson/honestweek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

See where your Claude Code and Codex sessions went wrong, open the exact steps behind each problem, and check every count yourself. Local and rule-based; nothing is sent to an AI unless you ask.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/replay-dark.png">
  <img src="docs/images/replay-light.png" alt="Replay of a three-hour session from the made-up demo week: one row for the main agent and one for each of its seven sub-agents, a Problems row with two rings, and the selected step, where the agent says all tests pass right after a test run failed.">
</picture>

Replay of the longest session in the made-up demo week (`npx honestweek view --demo`, with Show private text on, so the made-up names show): a main agent and seven sub-agents building a feature over three hours. The rings on the Problems row mark the two things worth a look, and the selected one is the agent saying "All tests pass" right after a run that failed.

<details>
<summary>More screenshots: Problems, a problem up close, sessions, Find, Goals, Setup, a weekly page and a client report</summary>

**Problems** shows the known ways agents go wrong that turned up in your week, worst first, each with a fix to copy.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/problems-dark.png">
  <img src="docs/images/problems-light.png" alt="The Problems page for the demo week: two problems to fix, six smaller and nine to check, the first one listing the two sessions it happened in with a Copy for Claude Code button.">
</picture>

**One problem up close** says what happened step by step, how each part is known, and what to add so it doesn't happen again.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/problem-focus-dark.png">
  <img src="docs/images/problem-focus-light.png" alt="One problem opened: the six times it happened down the left, What happened for the selected one in four numbered steps (the failed run, nothing after it, the success claim, what the agent said), and below it a hook to copy into Claude Code.">
</picture>

**Sessions** lists your week newest day first. A run a program started says what started it and links to that step.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/sessions-dark.png">
  <img src="docs/images/sessions-light.png" alt="Replay's sessions list for the demo week, Saturday first: each session with its time, length, tool, prompts and problems, and a review run marked as started by another session's step.">
</picture>

**Find** takes a pull request, a commit, a file, a branch or a few words and shows the sessions and goals behind it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/find-dark.png">
  <img src="docs/images/find-light.png" alt="Find, looking up the file src/parse.mjs: the six sessions that touched it, each with how that's known, and the two goals they worked toward.">
</picture>

**Goals** puts one goal's sessions on a single timeline you can play.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/goals-dark.png">
  <img src="docs/images/goals-light.png" alt="Goals: the release goal's four sessions on one timeline, with a panel explaining why each session belongs to the goal.">
</picture>

**Setup** opens the first time you run `view` in a folder with no config: it lists the repositories it found nearby and asks what to keep private.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/setup-dark.png">
  <img src="docs/images/setup-light.png" alt="Setup on first run: two git repositories found nearby, each with a role menu, then the email, the timezone, how far back to look, and the words to keep private.">
</picture>

**A weekly page** ([page mode](#standalone-site-page-mode)) is the summary you publish yourself, every change with its status and the commit it came from. This one was built from the demo week.

<img src="docs/images/weekly-page.png" alt="A weekly page built from the demo week: commits per day, a one-line headline, and the week's changes, three shipped and one in progress.">

**A client report** ([client mode](#a-report-for-a-client-client-mode)) is a printable page of the work done for one client, its counts checked against git. This one was built from the demo week too.

<img src="docs/images/client-report.png" alt="A client report built from the demo week: the title, who it's for and by, the period, a headline, counts of merged pull requests and commits, and two highlights.">

</details>

honestweek works with the session logs that Claude Code and Codex already keep on your computer. It does three things with them, all on your own machine:

- **See where it went wrong.** `honestweek view` opens on a Problems page: the known ways AI coding agents go wrong that showed up in your sessions, claims the agent couldn't back first ("done" with no check after the last edit, or success the output doesn't show). Each one links to the step in your replay, says how it's known, shows whether it happened less than in the week before, and offers a fix you can copy into your own instructions or hooks.
- **Find and replay your work.** Its Find page, one click away, takes a pull request number, a commit, a file, a branch or a few words and shows the sessions behind it, then lets you replay any session step by step. Every link and count says how it's known: recorded (a log or git says so), derived (worked out from records), inferred (a named rule's reading), or missing, and a link the records fit more than one way is also marked ambiguous.
- **Write an honest weekly summary.** A short pipeline turns a finished week into a summary you review and publish yourself. It checks every commit the summary cites against your real git history first, and it stops rather than write a claim it can't back.

It's for developers who do much of their work through an AI coding agent and want to find, check or show that work later. Nothing leaves your machine: there's no account, no telemetry and no network call, unless you turn on Include /insights and press Run /insights or Run with Codex, which send your sessions to Claude or OpenAI on your own plan. The names and client words you list stay hidden on the page unless you turn on its Show private text switch, on your own screen, and the keys, tokens and passwords it recognizes stay hidden either way.

## Try it

You need Node 18 or later and git. honestweek is on npm, so `npx` runs it with no install step:

```bash
npx honestweek view --demo   # a made-up week in your browser; it sets nothing up
npx honestweek view          # set up in your browser, then your own last 7 days
```

If you'd rather have a plain `honestweek` command, install it with `npm install -g honestweek` and write `honestweek` where this page says `npx honestweek`. The rest of this page writes `honestweek`. From a clone of this repository, write `node bin/honestweek.mjs` instead, and to run unreleased code from `main`, write `npx github:BryceEWatson/honestweek`. `honestweek` with no command lists its first steps, and its messages name each next step the way you ran it.

The demo opens on Problems: the known ways AI coding agents go wrong that showed up in that week, worst first. The page has four parts: Find (the sessions behind a pull request, a commit, a file or a few words), Goals, Replay and Problems. Press Ctrl+C in the terminal to stop it.

**Before you run it on your own logs.** honestweek only reads your logs; it never changes them. Keys, tokens and passwords it recognizes are always hidden on the page ([what it catches, and what it doesn't](#what-the-scrubber-catches-and-what-it-doesnt)). People's names and client words aren't, until you list them in Setup, and until then `view` says so in the terminal and on every page.

Run `view` from one of your project folders, or from a new folder next to them. With no `honestweek.config.json` there, the page that opens is Setup. It lists that folder if it's a git repository and the git repositories next to it (a second working copy of one repository, a git worktree, folds into it), fills in your email from git and your timezone, and asks which people's names and client or project words to hide and how far back to look. You can remove a repository or change its role first ([Repo roles](#config-reference) says what each role does). Press Save, and it writes the config and opens your week's Problems page. When you list private words, it also adds the config to `.gitignore`, since the file then holds them. Settings, in the page header, changes any of this later. For scripts and CI, `init` asks the same questions in a terminal (`honestweek init --yes` takes the defaults). Once the config exists, run `honestweek discover`, then `honestweek harvest`, and read `honestweek.harvest.json` for words from last week you might want to hide. [docs/local-page.md](docs/local-page.md) has every Setup and Settings detail.

What's further down:

- [Install](#install) as a Claude Code plugin, a plain skill, or the standalone command.
- [Finding and replaying your work in the browser](#finding-and-replaying-your-work-in-the-browser-view): every option of `view`, the goal list, and what it keeps private.
- [The flow](#the-flow-an-honest-weekly-summary): the weekly summary from `init` to `build`, then [mining solved problems](#mining-solved-problems-worth-publishing-mine), [a standalone site](#standalone-site-page-mode) and [a report for a client](#a-report-for-a-client-client-mode).
- [Config reference](#config-reference), [Sidecars](#sidecars) (the files it writes) and the [privacy model](#what-it-does-not-do--privacy-model).

## Why

An agent can say "All tests pass" right after a test run failed, and in a three-hour session with seven sub-agents you might never scroll back far enough to see it. I built honestweek to catch that and let you dig in. Problems checks your sessions against known ways agents go wrong and puts the claims the agent couldn't back first. Each finding opens on its place in the session's timeline, where the main agent has its own row and its sub-agents share one that opens into a row each. Every step opens to what's behind it: the log line it came from (or, for a step worked out from the records around it, a note saying so), the command's output and how its time is known. You see exactly what happened before you change anything, then copy the fix it offers, and its count against the week before shows whether it's happening less.

The same rule runs through all of it: nothing is stated without its evidence. Every link, count and step says how it's known. The weekly summary goes further: your commits show what shipped, your sessions show what you *figured out*, and every line points to the commit or session turn it came from (I call that its receipt). Each work item carries a status, `shipped`, `in progress` or `designed, not proven`, and the digest's own picks say why they were picked without claiming one.

## Requirements

- **Node ≥ 18**
- The system **`git` CLI**, version 2.24 or later, on your `PATH`
- **Zero runtime dependencies**: Node built-ins plus `git` only
- Runs **entirely locally**. No telemetry, and honestweek itself makes no network call. The two optional buttons under Include /insights run your own `claude` or `codex`, which do send sessions to Claude or OpenAI, only when you press them. The optional `preview` and `view` servers bind to loopback (`127.0.0.1`) only.

## Install

honestweek runs locally and has no dependencies to install. Pick whichever path you prefer. The plugin and the skill give you `/honestweek`, which runs the weekly summary inside Claude Code. For the browser page (`view`), use the standalone command.

### As a Claude Code plugin (recommended for the weekly summary)

Add this repo as a plugin marketplace, then install from inside Claude Code:

```
/plugin marketplace add BryceEWatson/honestweek
/plugin install honestweek@honestweek
```

…or from your terminal:

```bash
claude plugin marketplace add BryceEWatson/honestweek
claude plugin install honestweek@honestweek
```

You get `/honestweek` inside Claude Code, with versioned updates via `/plugin marketplace update`.

### As a plain skill

Clone into your personal skills directory:

```bash
git clone https://github.com/BryceEWatson/honestweek ~/.claude/skills/honestweek
```

Either way, when you run `/honestweek` the skill invokes its bundled CLI by a **skill-anchored absolute path** (`${CLAUDE_SKILL_DIR}/bin/honestweek.mjs`), so the commands work from *your own* project directory.

### As a standalone CLI

Run it from npm with `npx`. No install, no clone (zero dependencies, so it's quick):

```bash
npx honestweek --help
npx honestweek init
```

Or install it as a `honestweek` command:

```bash
npm install -g honestweek
honestweek --help
```

Or from a clone of the repo:

```bash
# run these from the repo root
node bin/honestweek.mjs --help
```

To run unreleased code, meaning what's on `main` and not in an npm version yet, run it straight from GitHub:

```bash
npx github:BryceEWatson/honestweek --help
npm install -g github:BryceEWatson/honestweek   # or install that code as the honestweek command
```

The CLI surface is eleven subcommands: `init`, `discover`, `prompts`, `digest`, `validate`, `build`, `harvest`, `preview`, `mine`, `history`, and `view`. Every one answers `--help` without touching your files. `honestweek view` is the browser page, described [next](#finding-and-replaying-your-work-in-the-browser-view). `honestweek init`, `honestweek discover`, `honestweek validate` and `honestweek build` make the weekly summary ([The flow](#the-flow-an-honest-weekly-summary)). `honestweek digest` adds one review of the week's prompts, ideas, techniques, decisions, reversals and next steps to `page` or `site` output, and `honestweek prompts` keeps your private prompt inbox. `honestweek harvest` suggests words to keep private, `honestweek preview` shows the built output on a local-only (`127.0.0.1`) page, `honestweek mine` finds [solved problems worth publishing](#mining-solved-problems-worth-publishing-mine), and `honestweek history` lists what landed in a period, for a [client report](#a-report-for-a-client-client-mode).

## Finding and replaying your work in the browser (`view`)

`honestweek view` opens a page on your own machine, starting on Problems, where you can see where your sessions went wrong, find the sessions and goals behind a pull request, a commit, a file, a branch or some words, see which sessions worked toward each goal, and replay any session step by step. It reads your config and the last 7 days of your Claude Code and Codex logs, serves the page on `127.0.0.1`, and opens your browser. Nothing is published, and nothing it reads is written to disk, apart from the redacted answers Run with Codex keeps beside your config when you use it.

```bash
honestweek view                  # the last 7 days of your logs
honestweek view --days 30        # look further back
honestweek view --from 2024-06-10 --to 2024-06-16 --goals goals.json
honestweek view --demo           # a made-up week, before you set anything up
```

With no `honestweek.config.json` in the folder, it opens the Setup page instead, on the same local server with the same key, and the terminal says so in one line. Setup writes the config with the same code `init` uses, never over one that's already there, and then the page goes on to your week's Problems page. Your answers, private words included, go only to this local server, never into an address or the terminal. With `--config` naming a file that isn't there, it stops and says so. While it reads the logs, the page says what it's reading and for how long. When your config lists no private words, the terminal and every page say that names and client words show as written, and where to add them. Ctrl+C stops it.

What's on the page:

- *Find.* Type a pull request (`#67` or its address), a commit, a file or a branch, and it lists the sessions and goals behind it. Type words, and it lists the goals and sessions whose titles match, the branches that contain them, and the prompts that share the most words, each with a link to replay from that prompt. A line says what these lookups cover: your configured repositories, in the dates shown at the top of every page.
- *Search everywhere.* The same words, searched across the prompts of every session in those dates, including display-only repositories and folders outside your config. Each result says which of those three it comes from.
- *Goals.* Each goal in your goal list, with the sessions working toward it on one timeline you can play, pause and scrub. A citation in the goal list that no session backs is listed as missing, with the reason.
- *Replay.* Any session, step by step. Replay opens on a list of the week's sessions by day, a few per day with "Show more", to pick one from, and every replay links back to it. Each step opens a panel with what happened and who did it ("You", the main agent, or a named sub-agent; what a `codex exec` run was told is the agent's), the original log line checked against its fingerprint, a command's output, and how its time is known.
- *Problems.* The page `view` opens on. 42 known ways AI coding agents go wrong or waste time and tokens, and which of them showed up in your sessions. Claims the agent couldn't back come first. The main list holds only findings worked out from the log itself; ones that rest on a rule's guess or a missing record sit in their own open "Possible" section below it. Each problem shows its count against the window just before it (say "2 times · 4 before"), each count with how it's known, and opens to a fix you can copy (a hook or an instruction line, never applied for you), a suggested prompt that should trigger the problem so you can watch the fix catch it, and each finding linked to its step in the replay. The replay and goal timelines can mark the same findings. To see it on the made-up week, run `honestweek view --demo`. I list every source behind these problems, once each, in [docs/sources.md](docs/sources.md).
- *Include /insights.* An optional toggle under "What was checked" on Problems, off by default and saved as `"insights": true` in the config, that adds what Claude Code's own `/insights` command wrote about these sessions as a separate group labelled AI-written, never counted with honestweek's findings; a Run /insights button starts `claude -p /insights` on your machine after asking, since it uses your Claude plan and sends your sessions to Claude.
- *Facts and Run with Codex.* Replay and Problems have a closed "Facts" fold with the plain facts `/insights` keeps about a session, worked out from your logs for Claude Code and Codex alike, each saying how it's known or "not recorded". With Include /insights on, "Run with Codex" has your own `codex` write the AI-written half for your Codex sessions, kept beside your config and shown as its own group. It asks first, since it uses your Codex plan and sends your Codex sessions to OpenAI, and Codex can read files you can read while it judges.
- *Light or dark.* A switch in every page's header, remembered in this browser only. With no choice made, the pages follow your system setting.
- *How it's known.* Every link, count and step carries one of four labels: **recorded** (a log line or git says so), **derived** (computed from recorded facts), **inferred** (a named rule's best reading, and the rule is named) or **missing** (the log doesn't say). A link the records fit more than one way is also marked **ambiguous**. A goal you assigned a session to yourself, by citing it in your goal list, is labelled as yours.

Options: `--days <n>`, or `--from` with `--to`, picks the dates; `--timezone <zone>` reads them in another timezone; `--goals <file>` names your goal list; `--config <file>` reads another config; `--port <n>` picks the port (a free one otherwise); `--no-open` only prints the address; `--self-test` adds a page that clicks through every page in your browser and reports each step as pass, fail or skip, and prints that page's address too; a step's note can quote what the page showed, so read it before you share it. `--demo` uses only its own made-up logs, config, goal list and week, so it refuses `--config`, `--goals`, `--days`, `--from`, `--to` and `--timezone`.

### The goal list

A goal list is a JSON file of your goals and the changes made to them. Each goal has an `id` and a `title`, and can carry a `state` and notes (`source`, `observations`, `results`, `decisions`) that cite pull requests, commits, or sessions (`session:` followed by the session's id). `events` logs each change to the list, with the time it was accepted:

```json
{
  "goals": [{ "id": "g-widget", "title": "Ship the widget parser", "state": "active",
              "source": { "pr": "https://github.com/example/your-project/pull/7" } }],
  "events": [{ "eventId": "ev-0001", "goalId": "g-widget", "type": "goal.create", "at": "2024-06-11T21:41:30Z" }]
}
```

Name it with `--goals <file>`, or once with `goalsFile` in the config. It's a different file from the goals page's `honestweek.objectives.json` that `build` reads, and passing that one by mistake gets a message saying so. Without a goal list, search and replay still work. [docs/work-history-engine.md](docs/work-history-engine.md#goal-membership) explains how a session joins a goal and how each join is known.

### What `view` keeps private

- *It answers only your own page.* The server binds to `127.0.0.1`, refuses a request that names another host and any data request that comes from another website (its page files hold no data), and answers a data request only with this run's key. The key is made fresh each run and never sits in an address or a command line: the address it opens or prints carries a one-time code that the page trades for the key. Each code works once and only for a while: 15 minutes for a printed address, two for the one it opens your browser with, so an old address in your terminal's scrollback won't open the page. Pressing Enter in the terminal prints a fresh one.
- *The two run buttons.* The server, not just the page, refuses Run /insights and Run with Codex while Include /insights is off. Each program gets only the environment variables it needs to start and sign in, so other tools' tokens in your environment don't reach it.
- *Redacted unless you ask.* The page shows redacted text. Its **Show private text** switch shows names, client words and folders on your own screen; keys, tokens and passwords stay hidden either way. The switch starts off every run and changes only text, never which sessions link to which or which goals they join. That version is built in memory the first time you turn it on, and it's never written to disk.
- *Display-only and outside sessions.* With the switch off, a session from a display-only repository or a folder outside your config never shows a private word, and it never joins a lookup or a goal. Git is never run against a display-only repository.
- *Nothing on disk.* The page's address holds only made-up ids, never what you typed or a goal's name, because the browser keeps addresses in its history. What it reads stays in memory. What it writes is the config (when you save Setup or Settings, or flip Include /insights), the example config beside it when it's missing, `.gitignore` lines for honestweek's private files, Run with Codex's redacted answers in `honestweek.codex-judgments/`, and a small redirect file in your temporary folder that opens the browser and is deleted once it's used, after two minutes, or when you stop. `--demo` builds its made-up week in a temporary folder and deletes it when you stop. When it starts, it also removes its own leftover demo folders older than a day whose run has stopped.

## Replaying how the work happened (the engine underneath)

`honestweek view` runs on a work-history engine (`lib/replay/`) that rebuilds how work happened from the same local logs: prompts, the sub-agents an agent started, each command and its recorded result, tests, interruptions, and what git says happened to each commit. Every step says how it's known, and it never invents working time or reasons. It only reads, and it never runs git against a display-only repository. A developer tool in a clone of this repository prints the history level by level and looks up the sessions behind a pull request, a commit, a file or a goal from the command line (`node tools/replay-inspect.mjs --demo lookup '#7'` tries it on made-up sessions). [docs/work-history-engine.md](docs/work-history-engine.md) explains the event model, the lookups, how a session joins a goal, and what it can't reconstruct yet.

## The flow: an honest weekly summary

This turns a completed week of your AI coding **sessions** (each one conversation log) into an honest, git-verified, private-by-default work summary, including the figured-out-but-not-yet-shipped work your commits can't show.

It's shipped as a Claude Code skill (instructions Claude follows when you type `/honestweek`) that runs small Node scripts with no dependencies, all on your machine. It reads your AI coding session transcripts, distils a completed week into an honest shareable summary, **re-derives every git-checkable claim against your real commits (or aborts)**, and produces a draft *you* review and publish yourself. It never auto-publishes.

End-to-end happy path, in order. Each step names the artifact it produces.

> Installed as the skill/plugin? Just run `/honestweek`: Claude drives these steps for you and resolves the CLI path automatically. The commands below write `honestweek`; with `npx` or from a clone, use the form under [Try it](#try-it).

1. **`init`** → writes `honestweek.config.json`, inferred from your git state (your `git config user.email` plus the nearby git repos it finds), for you to review. If it finds no repositories, it writes nothing and says where to run it instead. It also drops `honestweek.config.example.json` if one isn't present. Two confirmations gate the write; accepting the defaults yields a valid config. Between them it asks for the names and client words to keep private, which go under `redaction` (either can be skipped; when you give some, the config also goes into `.gitignore`), and before the second it shows a short summary of what the file will say.
   ```bash
   honestweek init
   ```
   Those questions need someone to answer them. Answers piped in on stdin work, one per line. In a script, in CI, or from an agent's shell where stdin ends before the last answer, `init` exits `2` rather than writing a config you never approved, and tells you to accept the inferred defaults instead:
   ```bash
   honestweek init --yes
   ```
   `--yes` leaves an existing `honestweek.config.json` untouched; add `--force` to overwrite it.
2. **`discover`** → scans the **last completed week's** sessions **and session-end handoffs** (`.claude/handoffs/*.md`, for `featured`/`reference` repos; `display` repos are never read) from your allowlisted repos and writes the gitignored, **redacted** `honestweek.draft.json`. Handoffs contribute their tagged claims, reversals, and cited commits as additional, bounded material. Deterministic: no model call.
   ```bash
   honestweek discover          # or: discover --week 2024-W23
   ```
3. **`/honestweek`** (the skill) → **distils** the draft into the human-reviewable `honestweek.items.json`, with a status badge **and** a receipt on every item. This is the one model-judgment step; see [`SKILL.md`](SKILL.md) for the distillation contract.
   For `page` or `site` output without the opt-in goals registry, run `honestweek digest prepare` too. It reads the finished week's Claude Code and Codex sessions, picks a short list of prompts, ideas, techniques, decisions, reversals and next steps, each linked to the session it came from, and writes the ones that pass the privacy check to `honestweek.prompt-items.json`. `digest candidates` and `digest explain <item-ref>` show why each one was picked. `digest keep`, `hide` and `delete <item-ref> --yes` change what goes in, and then you run `validate` and `build`; they change the selection only and never bypass the receipt or privacy gates. A deleted item leaves a no-text tombstone (a marker with no text in it) so the next `prepare` doesn't pick it again; deleting cannot recall an output you've already built. The balanced digest and the goals page don't work together yet, so with a goals registry, use the distillation step above. [docs/digest.md](docs/digest.md) has the rest: the hold on high-risk items, carrying unresolved items into later weeks, and recovering an interrupted build.
   > Optional but recommended: gate the distilled items before building:
   > ```bash
   > honestweek validate          # add --no-dashes for the voice rule
   > ```
   > `validate` exits `2` if any item lacks a valid badge or a receipt, **names a `display`-role repo or cites a commit against one**, or lets a configured redaction term survive into the prose. It catches an authoring leak at the source instead of relying on build-time scrubbing.
4. **`build`** → re-derives and **git-verifies every cited commit**. It **aborts with exit code `2`** if any cited commit is unresolved or its `authorEmail` is not in `identity.authorEmails`, writing nothing rather than emit a half-true summary. A `shipped` badge additionally requires every cited commit to have **landed**: reachable from the repo's default branch (origin/HEAD as recorded locally, else `main`/`master`, else the repo's only branch), checked offline from local refs, never a fetch. Real work still on an unmerged branch keeps its receipt and is downgraded to `in progress`, announced on stderr; if the repo has no determinable default branch, the `shipped` claim is unverifiable and the build aborts (exit `2`).
   ```bash
   honestweek build
   ```
5. **emit** → on success, `build` renders the final **local** output in the configured `output.mode` (`post` / `changelog` / `digest` / `report` / `page` / `site` / `client`) to `output.file`. The `digest` carries a git-derived **Activity** summary (commits and active days for `featured`/`reference` repos; `display` repos are never git-read, so they get no metrics, and an unreadable repo gets no fabricated `0`). `page` renders a self-contained, interactive HTML **standalone site** (see below). You review it and publish it yourself.
6. **`preview`** (optional) → serves the built `output.file` on a local-only `127.0.0.1` server, then opens your browser. A Markdown output is converted to a locked-down HTML page; the `page` output is already HTML and is served verbatim (with its inline interactivity). It is a viewer: it reads the file `build` wrote, publishes nothing, and needs no internet. Press Ctrl+C to stop.
   ```bash
   honestweek preview              # add --no-open to just print the URL, or --port <n>
   ```

## Mining solved problems worth publishing (`mine`)

The weekly flow above answers "what did I ship". `mine` answers a different question:
**did I solve a problem that a stranger is going to hit too?**

Not every hard hour is worth writing up. When your own code breaks and you fix your own
code, nobody else can use that. But when a tool *you did not write* fails in your
environment and you work out why, someone else will hit the same wall and paste the same
error into a search box. That second kind is rare, it is already sitting in your session
logs, and it is almost never written down.

`mine` finds those, ranks them, and, with `--draft`, writes one up.

```bash
honestweek mine              # report what is undecided
honestweek mine --draft      # and write the top one up as a post
```

**What it reads.** Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`) and
Cowork session logs. Pick with `--corpus claude-code,codex,cowork`. A name outside that
list is an error (exit 1), not an empty scan: a typo must never read as a quiet week.

**How it decides.** A session is a candidate only when all three hold:

| Requirement | Why |
| --- | --- |
| A quotable error from software you did not write | It is what a stranger types into a search box. Errors from your own compiler, test runner or git are excluded. |
| Diagnosis outside your working tree | Probing the machine, reading another program's install directory, or researching a third party's known behaviour. |
| Evidence it was resolved | An unresolved failure is a bug report, not a guide. |

A session that edited your repo far more than it investigated anything else is rejected
however good it looks otherwise. That is ordinary work.

**The ledger.** Findings land in `honestweek.findings.json` with a status. The number
that matters is the **backlog**: findings you have not yet accepted or declined:

```text
ERROR SIGNAL — backlog 3 undecided; oldest waiting 12 day(s).
```

"Found 3 things this run" measures the tool. The backlog measures whether anything
reached a reader, and it can only fall when **you** decide:

```bash
honestweek mine --decide "<finding key>=published"   # or =declined
```

**Drafts are honest by construction.** A draft asserts nothing about today. Its
last-verified field is emitted **empty**, its publication date is left blank, and it
carries a checklist where every item starts `UNVERIFIED`, plus a "What I could not
check" section. Two things a session log can never establish are always listed there:
whether anyone actually searches for this, and whether the fix still works on the
current build. `mine` never publishes anything.

**When it is blind, it says so.** Every run reports files found per corpus and the
retention floor: the oldest session still on disk, since agents delete old logs. If a
corpus resolves to a real directory holding zero logs, `mine` **exits `2`**: a zero from
a blind sensor is not evidence of a quiet week.

Configure the destination under `mine` in your config (all optional):

```json
{
  "mine": {
    "ledger": "honestweek.findings.json",
    "ownRepos": ["you/your-repo"],
    "publishedErrorStrings": ["an error you already wrote about"],
    "draft": {
      "dir": "src/content/blog",
      "frontmatter": { "title": "", "description": "", "date": "", "tags": [], "lastVerified": "" }
    }
  }
}
```

`draft.frontmatter` is your destination's schema, not honestweek's: keys it recognises
are filled in, keys it does not are passed through empty for you. `ownRepos` stops
issues on your own repositories counting as evidence that someone else's software broke.
honestweek reads the GitHub remote of each configured repository for this, except `display`
repositories, which it never runs `git` against: list their `owner/name` under `ownRepos` if
issues there should count as yours.

See [`docs/mining.md`](docs/mining.md) for the detector's signals, what is measured
versus guessed at, and how the score bar was calibrated.

## Sample output

A short, fabricated (clean-room) example. The distilled `honestweek.items.json`:

```jsonc
{
  "week": { "start": "2024-06-10", "end": "2024-06-16" },
  "items": [
    {
      "text": "Auth redirect now keeps the session cookie across the login bounce.",
      "repo": "your-project",
      "status": "shipped",
      "receipt": { "sessionId": "a1b2c3d4", "primaryCommit": "9f8e7d6" }
    },
    {
      "text": "Retry queue for failed webhook deliveries, designed but not yet wired in.",
      "repo": "your-project",
      "status": "designed, not proven",
      "receipt": { "sessionId": "a1b2c3d4" }
    }
  ]
}
```

Rendered to the default `digest` output. Every line carries a status badge and a receipt:

```markdown
# Weekly digest — 2024-06-10 to 2024-06-16

## Shipped
- **shipped** — Auth redirect now keeps the session cookie across the login bounce. _(your-project)_  (`9f8e7d6`)

## Designed, not proven
- **designed, not proven** — Retry queue for failed webhook deliveries, designed but not yet wired in. _(your-project)_  (`a1b2c3d4`)
```

## Standalone site (`page` mode)

Set `"output": { "mode": "page" }` and `build` writes one self-contained, interactive
HTML file (`honestweek.report.html` by default), a polished **standalone site** with a
git-derived commits/day chart, collapsible per-project cards with metrics, status-badged
items, and an expandable git receipt on each. No target project, no framework, no build
step, and **zero external resources** (inline CSS + JS, system fonts), so it opens
anywhere and `preview` can serve it under a no-egress CSP:

```bash
honestweek build     # writes honestweek.report.html
honestweek preview   # serves it on 127.0.0.1 + opens your browser
```

Same honesty engine as every other mode: every cited commit is verify-or-abort'd, every
number on the page is a deterministic honestweek derivation (git for commits + the chart),
and curated prose is HTML-escaped. A per-project card's **active-days** is
`max(commit-active days, session-active days, entry-active days)`, so a display-role /
session-only project shows the days it genuinely had interactive sessions (counted from your
local session logs, never authored) instead of a blank. A card's header can never report fewer
active days than the dated rows shown beneath it, even when a session ran from one project's
directory but was curated as another's work by content. In `site` mode the same reconciliation
keeps the header's "sessions this week" from falling below that active-day span (a session
happens on one day, so N active days mean at least N sessions); for a project whose sessions ran
from more than one folder, that reconciled figure is a lower bound on its distinct session-days, not a raw
session-log tally. Every figure is a deterministic count, never authored. (To
instead generate INTO an existing website's data
file (the integrated path), use `site` mode with a committed `output.adapter`; see
`docs/site-integration.md`.)

### A goals page too (opt-in, multi-page)

Drop a `honestweek.objectives.json` registry beside your config and `page` mode becomes
**multi-page**: it emits a second self-contained page, `goals.html`, next to `report.html`
and cross-links the two. The goals page groups your verified work **by goal** instead of by
project: goal cards with a kind chip, a what / why / how, a per-week activity strip, status
counts, and an expandable list of the entries behind each goal. With **no** registry, `page`
mode stays single-page exactly as above (the goals page is purely additive).

The registry is the publish gate: only goals listed in it appear, and a work item that maps
to no goal is omitted. It's validated fail-closed before anything is written (an invalid or
leaky registry aborts the whole build, writing neither page).

```jsonc
// honestweek.objectives.json  (opt-in; absent -> single-page)
{
  "schemaVersion": 1,
  "groups": ["open source", "this site"],          // area sections, in this order
  "groupDescriptions": {                            // optional per-area what/why intro
    "open source": { "teaser": "Tooling, in the open.", "what": "...", "why": "..." }
  },
  "objectives": {
    "ship-the-tool": {                              // any anchor-safe id
      "publicLabel": "Ship the tool as an open engine",
      "publicGroup": "open source",                 // must be one of groups
      "kind": "continuous",                          // optional: "continuous" | "finite"
      "what": "...", "why": "...", "how": "...",     // optional card body
      "howType": "sessions"                          // optional: "sessions" | "mined" | "planned"
    }
  },
  "projectToObjective": { "your-project": "ship-the-tool" },  // repo label -> goal id
  "page": { "title": "My goals", "lede": "..." }    // optional page copy overrides
}
```

A work item resolves to a goal by its own `objectiveId` (if set and in the registry), else by
`projectToObjective[<its repo label>]`. Cross-week goal activity aggregates the current week
plus any weeks in your local `output.archive` (so a first run shows one week, richer as weeks
accrue). An optional `honestweek.goal-changelog.json` adds a "what changed" band for
structural goal-set changes (a goal added / split / retired / relabeled / merged).

`preview` serves **both** pages (so the cross-links resolve), still loopback-only under the
same no-external-egress CSP:

```bash
honestweek build     # writes report.html + goals.html (when the registry is present)
honestweek preview   # serves both at 127.0.0.1 (/ and /goals.html)
```

## A report for a client (`client` mode)

A weekly log is for you. A client report is for the person paying for the work: what you did for them over a period you choose (a sprint, a month, the contract so far), in their words, with the evidence attached. It's one light, printable HTML file (`honestweek.client.html` by default) they can read in a browser or save as a PDF.

It keeps every guarantee the weekly modes have. Every change in it names the pull requests it came from, every cited commit is verify-or-abort'd and has to be yours and on the default branch to count as merged, and a cited commit dated outside the period aborts the build. The numbers at the top (pull requests merged, commits on the main branch, days with work landed) and the activity chart are read from git, and an unreadable repo leaves them blank rather than too low. An appendix lists every pull request of yours that landed in the period, marking which ones the report describes, so nothing is quietly left out.

The source is what reached the default branch, not a week of session logs:

1. Add a `client` block to the config (it names the client, and optionally who it's for and from, plus link prefixes so PR numbers become links), and set `"output": { "mode": "client" }`. Use a separate folder and config for each client.
2. List what landed in the period. This writes the gitignored `honestweek.history.json` and prints only counts:
   ```bash
   honestweek history --from 2026-04-01 --to 2026-06-30
   ```
3. Distil it into `honestweek.items.json` (the skill does this): a `period` with the same dates, `content` (a `title`, a one-sentence `headline`, `summary` paragraphs, the `themes` the work falls into, and optional `next` steps, which are shown as planned and never counted), and one item per meaningful change with a `theme`, a `title` and `summary` written for the client, a status, and `commits` citing the squash-merge commits it came from. Mark the few that matter most with `"highlight": true`.
4. `validate`, `build`, and `preview` as usual. Put anything the client must never see (billing, other clients) in `redaction.terms` so `validate` stops it at the source.

In a client report, `shipped` reads as **Merged**: on the main branch and checked against git. It doesn't claim the change has been released to production, and the report says so.

### Shaping it for the reader (reader profiles)

Different readers want different things from the same report. An optional `honestweek.reader.json` beside the config describes the one this report is for: which sections come first, extra sections that gather the changes they care about, areas to leave out, and whether to also write a short note for wherever they read updates. It never changes a fact: every view shows the same entries, statuses and counts, an area it leaves out is counted on the page, and the full record and "how this report was made" are always there.

- An extra section picks its changes either **by git**, from the issue numbers the commits' messages name (`"select": { "issues": [12, 14] }`), or **by hand**, from tags on items (`"select": { "tags": ["requested"] }`). The page says which.
- Every section and every line of writing guidance says where it came from: `their-words`, `your-notes` (both with a `ref`), or `guess`. If everything in the file is a guess, `build` tells you the view is unconfirmed.
- `"format": { "note": true }` also writes `<report>.note.md`: the headline, the reader's sections and what's next, in a few lines, pointing to the full report.
- Anything a profile can't honestly do fails the build instead: redefining "done", unknown keys, a missing source, excluding an area that doesn't exist, an item tag no section picks.

Without the file, the report uses the shipped default and client layers. The design and its rules are in [docs/reader-profiles.md](docs/reader-profiles.md).

## Config reference

Your `honestweek.config.json` mirrors `honestweek.config.example.json`. Whether you commit it is up to you, but its `redaction` lists are the words you want hidden, so keep a config that has them out of anything public (`init` adds it to `.gitignore` when you give it private words):

```jsonc
{
  "identity": { "authorEmails": ["you@example.com"] },     // required, non-empty; the commit-authorship allowlist
  "week": { "startsOn": "monday", "timezone": "UTC" },       // optional; startsOn is "monday" (the only supported value); timezone is an IANA zone (defaults to the host zone)
  "repos": [                                                  // required, non-empty
    { "path": "/path/to/your/repo", "label": "your-project", "role": "featured" },
    { "path": "~/code/a-repo-you-contribute-to", "label": "a-shared-repo", "role": "reference" },
    { "path": "~/code/a-client-repo", "label": "a-private-project", "role": "display" }
  ],
  "redaction": { "codenames": [], "names": [], "terms": [] },  // optional; default-empty private term-lists, scrubbed case-insensitively
  "curation": { "maxItems": 12, "automaticMinScore": 2, "retentionWeeks": 12, "automaticCarryWeeks": 2, "categoryCaps": { "prompts": 2, "ideas": 2, "techniques": 3, "decisions": 2, "reversals": 1, "nextSteps": 2 } }, // disclosed digest target, floor, bounded carry, and category caps
  "privacy": { "publicRenditions": { "enabled": true, "maxAutomaticChangedPercent": 20, "generalizationMappings": {}, "neverPublicTerms": [] } }, // deterministic public-rendition gate
  "output": { "mode": "digest", "file": "honestweek.digest.md" },  // optional; mode ∈ post|changelog|digest|report|page|site|client, default digest
  "client": { "name": "your-client", "preparedFor": "Their name", "preparedBy": "Your name", "organization": "Your business", "prLinks": { "your-project": "https://github.com/your-org/your-project/pull/" } }, // required for mode client only
  "voice": { "denyMeta": false },                              // optional; OFF by default. true = lint authored prose for withholding/honesty-meta (see below)
  "goalsFile": "honestweek.goals.json"                          // optional; the goal list `view` reads
}
```

| Field | Meaning |
| --- | --- |
| `identity.authorEmails` | The emails a commit must be authored by to count as yours. `build` aborts on any cited commit not authored by one of these. |
| `week.startsOn` | `"monday"` (the only supported value). |
| `week.timezone` | IANA timezone used to compute the week boundary; defaults to your host zone. |
| `repos[].path` | A repo path. `~`/`~/` expands to your home dir; relative paths resolve against the config file. Sessions are attributed to this repo from **any working tree of the same git repository**: the path itself, sub-directories, and every `git worktree`, including ones checked out at a sibling path rather than inside it. Git reads (commits, handoffs, metrics) always use this path alone, so a worktree's branch or detached `HEAD` never becomes the basis for your commit counts. A separate *clone* has its own git database and is never attributed here. |
| `repos[].label` | The short name items reference and outputs display. |
| `repos[].role` | One of the three trust levels below. |
| `redaction.codenames` / `names` / `terms` | Private tokens scrubbed from all output, in any letter case. A term is found as a word, after an underscore or a digit, or as one part of a camel-case name (`acme_report`, `AcmeReport`, `XMLAcmeThing`). A web-address or file-name part that starts with a codename or term of four or more letters is replaced whole (`www.acmehq.com`, `http://acmehq:3000`, `acmereport.pdf`); a person's name is matched that way only in a web address, so "Bill" leaves `billing.ts` alone. A word that only shares letters with a term (`academy`) is kept. Default empty (clean-room). |
| `curation.*` | Local weekly-selection policy. Defaults target 12 items with caps of 2 prompts, 2 ideas, 3 techniques, 2 decisions, 1 reversal, and 2 next steps. The automatic floor is 2. `automaticCarryWeeks` defaults to 2 and is hard-limited to 2. `retentionWeeks` defaults to 12 and is hard-limited to 12. Explicit keeps and one-week renewals are never silently dropped, but they never bypass receipt or privacy gates. |
| `privacy.publicRenditions.*` | Public-rendition gate. `enabled` defaults true for the local artifact, `maxAutomaticChangedPercent` defaults to and cannot exceed 20, and `neverPublicTerms` extends hard redaction. `generalizationMappings` remains empty in this slice. Ambiguous or residual high-risk material in every category stays private. |
| `output.mode` | `post` (build-in-public update), `changelog` (in-repo `CHANGELOG.md` section), `digest` (the private, local-only weekly file; the default and trust anchor), `report` (grouped by project, each headed by its git-derived metrics; the structured weekly-work-log shape, still a local file you publish yourself), `site` (integrate the verified report into a target website's data artifact via a committed adapter (advanced; see [docs/site-integration.md](docs/site-integration.md))), or `client` (a printable report of the work done for one client over the items file's `period`; see [A report for a client](#a-report-for-a-client-client-mode)). |
| `output.file` | Where the output is written. Defaults per mode when unset. (Not used by `site`, whose write path comes from the adapter.) |
| `output.adapter` | **Required for `site` mode only**: path to the committed adapter (resolved like a repo path): a `.json` *static* field-map, or a `.mjs` *transform* (`transform(model, ctx)`) for artifacts needing grouping/sorting/joins. It maps the verified model onto the site's data artifact; the artifact's own write path lives in the adapter. |
| `output.redact` | Default `true` (honestweek scrubs every byte). For `site` mode only, `false` delegates string redaction to the committed transform (so a target with its own redactor gets exact placeholder parity), permitted **only with a transform adapter**; verify-or-abort and the numeric fact-fence always run. See [docs/site-integration.md](docs/site-integration.md). |
| `output.skipProgramSessions` | Default `true`. For `page` and `site` modes, the interactive-session count leaves out a Claude Code session that a program, a background task or another session opened and that has no turn from you, and counts one you sent a turn to later from your first turn, on that turn's day, the way the rest of honestweek reads a program's turns. Current Claude Code marks who sent each turn (`turnOrigin`: `human` when it came from your own session, typed or pasted); older logs don't, and count as before. Set it to `false` to count the old way. If you publish this count, it changes from 0.2.0 wherever your logs record `turnOrigin`. See [docs/site-integration.md](docs/site-integration.md). |
| `output.archive` / `output.archiveDir` | Opt-in local weekly archive. With `archive: true`, `build` also snapshots each week to `<archiveDir>/<weekStart>.json` and maintains `<archiveDir>/index.json` (the "/log" series; default dir `honestweek.archive`). Local files only, never pushed. |
| `client.name` | **Required for `client` mode.** The client or product the report covers. |
| `client.preparedFor` / `preparedBy` / `organization` | Optional lines for the report's header: who it's for, who wrote it, and the business it comes from. |
| `client.prLinks` | Optional map of repo label to an https prefix (`https://github.com/your-org/your-project/pull/`), so a PR number derived from a verified commit becomes a link. Every key must be a configured repo label. |
| `voice.denyMeta` | Opt-in authored-prose honesty lint, **OFF by default**. When `true`, `build` aborts (exit 2, writes nothing) if an authored-prose field (item `title`/`summary`/`text`, or curated `content`/`projects` prose) *narrates its own withholding* ("keeping the specifics sealed", "kept generic here", "not public-facing") or *announces the page's own honesty* ("show the work honestly, receipts and retractions included", "belongs in an honest log"). That's what an honest log should show through its badges and receipts, not say about itself. It's the prose analogue of the numeric fact-fence, names each offending field plus matched phrase plus rule, and is **never** applied to verified evidence snippets/receipts (where a word like "sealed" can legitimately appear); conversely, keep authored prose out of evidence-named keys (`commits`, `receipt`, `snippet`, ...), which are treated as evidence and skipped. Absent, nothing changes. |
| `history` | Optional. How far back `view` reads with no `--days`, `--from` or `--to`: `{ "days": 30 }`, `{ "from": "2025-01-01" }`, a range in the past `{ "from": "2025-01-01", "to": "2025-03-31" }`, or `{ "all": true }`. The last 7 days or fewer always load whole. A longer choice loads at most the newest `historyLimitMB` of logs and says which days it loaded when that cuts it short. Leave it out for the last 7 days. Setup and Settings write it. |
| `historyLimitMB` | Optional. The most log data, in MB, a saved `history` longer than a week loads at once, and the most the Problems page reads for the window before a longer choice (for a one-week window, the week before always loads whole): 500 unless you raise it (50 to 20000). Settings shows an estimate of the time and memory before you save a new one. |
| `goalsFile` | Optional. The goal list `view` reads, resolved like a repo path. Leave it out and `view` runs without goals, or pass `--goals <file>` for one run. It's not the goals page's `honestweek.objectives.json`; see [The goal list](#the-goal-list). |
| `longSessionTokens` | Optional. How many tokens of context an agent can carry before the Problems page flags it for going on, from 10000 to 10000000, for example `150000`. Leave it out and that check is off: no vendor recommends a number. Settings sets it. |
| `voice.denyPhrases` / `voice.allowPhrases` | Optional string lists (default empty). `denyPhrases` **extends** the built-in denylist with your own phrases (literal, case-insensitive). `allowPhrases` is the false-positive **off-ramp**: it exempts a legitimate phrase a built-in pattern would otherwise flag (surgical to the matched text), so one over-eager match doesn't force you to disable the whole lint. |

**Repo roles:**

- **`featured`**: git-read **and** git-verified, and headlined in the output.
- **`reference`**: git-read but not headlined.
- **`display`**: summarized generically and **NEVER git-read**. Use it for repos you want acknowledged without reading their commits.

## Sidecars

| File | Status |
| --- | --- |
| `honestweek.draft.json` | The redacted weekly digest from `discover`. **Gitignored.** An intermediate working artifact, never published. |
| `honestweek.prompts.json` | The private, redacted Claude Code and Codex prompt inbox plus no-text deletion tombstones. **Gitignored.** Never read by a renderer. |
| `honestweek.curated.json` | The private, redacted six-category review model from `digest prepare`. **Gitignored.** It contains exact selection and privacy decisions. A deleted current-week item leaves only a no-text tombstone. |
| `honestweek.digest.pending.json` | A no-text transaction marker used only to recover an interrupted `digest prepare`. **Gitignored.** Other commands fail closed while it exists. |
| `honestweek.prompt-items.json` | The public-safe lane. Version 1 is prompt-only; version 2 is the balanced digest. **Gitignored.** `validate` and `build` reconstruct it from local sources before use. |
| `honestweek.carry.json` | The private, redacted carry history, bounded to 12 week records. **Gitignored.** Only a successful lifecycle build advances it. |
| `honestweek.carry.pending.json` | The hash-bound output/carry recovery envelope for an interrupted lifecycle build. **Gitignored.** Unknown output and carry combinations fail closed. |
| `honestweek.items.json` | The distilled, human-reviewable items. **Yours to keep or ignore** (not gitignored unless you add it; safe to delete). |
| `honestweek.reader.json` (opt-in) | The reader profile for a client report: who it's for, what they see first, and where each line of that came from. Holds a real person's preferences, so keep it private with the report. |
| `<report>.note.md` (opt-in) | The short note a reader profile asks for with `format.note`, written beside the client report. Yours to share. |
| `honestweek.history.json` | What landed on the default branch in a period, from `history`: the raw material for a client report. **Gitignored.** Redacted before it's written; only counts are printed. |
| `honestweek.drafts/` (opt-in) | Post drafts from `mine --draft`, with their claims still unverified. **Gitignored** in a folder `init` set up; elsewhere, add it yourself or set `mine.draft.dir`. |
| `honestweek.harvest.json` | Proposed redaction-denylist candidates from `harvest`. **Gitignored.** Only the count is printed; the raw nouns stay local for you to review. |
| `honestweek.codex-judgments/` (opt-in) | What your own `codex` wrote about each Codex session when you press Run with Codex in `view`, one file per session. **Gitignored**: the folder ignores itself and gets a line in the config folder's `.gitignore`. Redacted before it's written. |
| `output.file` (e.g. `honestweek.digest.md`) | The final rendered output. **Yours to keep or ignore.** |
| `honestweek.config.json` | Your config. `init` adds it to `.gitignore` when you give it private words, since it then lists them; it can also hold private repo paths. Un-ignore it if you want it tracked. |
| `honestweek.archive/` (opt-in) | The local weekly snapshots + `index.json` (the "/log" series). Only written when `output.archive` is true. **Yours to keep, ignore, or commit.** |
| `honestweek.objectives.json` (opt-in) | The goal registry that turns `page` mode multi-page (emits `goals.html`). Absent → single-page. The publish gate for goals; commit it if you want the goals page. |
| `honestweek.goal-changelog.json` (opt-in) | Optional append-only log of structural goal-set changes, rendered as the goals page's "what changed" band. |
| `honestweek.findings.json` (opt-in) | The `mine` findings ledger: what was found, and what you accepted or declined. **Commit it**: it is the only record of what you already said no to, and everything in it is de-identified and redacted before it is written. |

## What it does NOT do / privacy model

- **Only your own allowlisted repos are read.** `git` runs only against the repositories in your `repos` list, apart from the setup scans that suggest what to list (`init`, and Setup and Settings in `view`), which look in the folder you run them in and the folders next to it, and the checks that `discover`'s draft file and Settings' config aren't tracked in the folder you run them in. Weekly reports use only sessions from those repos; `mine` reads every session in your logs, as [SECURITY.md](SECURITY.md) explains.
- **`display`-role repos are summarized generically and NEVER git-read.** There is no code path that runs `git` against a `display` repo.
- **Output stays local until you publish it.** honestweek writes local files only.
- **No telemetry, no network egress.** honestweek makes no network call. The one exception is yours to start: with Include /insights on, Run /insights and Run with Codex run your own `claude` or `codex`, which send your sessions to Claude or OpenAI after asking. The optional `preview` server is loopback-only (`127.0.0.1`): it serves your already-built output with no key, so any program or account on your machine can read it while it runs, and nothing leaves your machine. The `view` page is loopback-only too, answers only the page it opened, and keeps what it reads in memory; see [What `view` keeps private](#what-view-keeps-private).
- **Nothing is auto-published.** honestweek produces a draft; *you* are the publisher.

### What the scrubber catches, and what it doesn't

Redaction is pattern-based and deliberately over-redacts when a pattern is ambiguous. It reliably removes email addresses (including ones with an encoded `@`, like `%40`), home and user paths (including `~/…`, the root account's `/root/…`, URL-encoded paths, and the user name in Claude Code's encoded project folder names like `C--Users-you-…`), prefixed API keys (GitLab's `glpat-` too) and JWTs, high-entropy tokens of 32+ characters, UUIDs, bare 9+ digit runs, currency amounts, and every term you list under `redaction`, whether its accents are written composed or decomposed. A bare hex string of 32 or more characters counts as a token too, unless it's exactly 40 characters, the length of a full commit id. Keys in what it writes, like a chart's repo labels or a tool's name, are scrubbed the same way as values.

It also hides the value of a field whose name says it's a secret: a password, passphrase, token, secret, API key, access or private key, credential, cookie, signature or authorization. The name can be spelled `API_KEY`, `x-api-key`, `client_secret`, `dbPassword`, `authtoken`, `DB_PASS`, `PGPASSWORD`, `MYSQL_PWD` or ODBC's `PWD`, and the value can follow `=`, `=>`, `:`, `:=`, `==` or `===`, sit in a quoted JSON string at any level of escaping, sit inside an XML element named that way (`<password>…</password>`), or follow a `--password` flag or a `-Password` parameter. A `password:` line and an `Authorization:` or `Cookie:` header are hidden to the end of the line, a quote, or the next `key:` on it. In a JSON record read back whole, a value under a key like that is hidden too. Bearer and Basic credentials, the password in a web address (`redis://:…@host`) or after `curl -u user:…`, and a PowerShell `ConvertTo-SecureString` literal (after `-String` or `-AsPlainText`, or piped in) go the same way. Only the value is replaced, with `[redacted:secret]`, so you can still see which field held it. A key that only ends in `Key`, like `fileKey` or `sessionKey`, isn't a secret, and neither is a value like `true`, `none`, or a test count after `pass:`.

It is a safety net, not a guarantee. Known gaps, so you can decide rather than assume:

- **Short secrets with nothing naming them.** A hand-picked password under 32 characters that no field, flag, header or scheme names (a bare `hunter2` in a sentence, a password glued to `mysql -p`, an item in a plural `tokens` list) is indistinguishable from prose and survives.
- **Prose that reads like a field.** Because it errs toward hiding, a sentence that starts like one loses the word after the colon: `Auth: users get logged out` is published as `Auth: [redacted:secret] get logged out`. In goal text (an objective's label, `what`, `why` or `how`, or a changelog entry), anything the redactor would change stops `build` instead, so reword a line like `Auth: refresh sessions quietly` there. Plain words after `Bearer` or `Basic` (`basic validation`) and a type annotation (`login(password: string)`) are left alone.
- **A value after a bold label.** In `**Token:** abc123` the field's value reads as the closing `**`, so `abc123` still shows. Keep secrets out of Markdown bold labels.
- **A quoted part inside a header.** A quoted part (`Cookie: theme="dark"; session=…`, `Authorization: Digest … response="…"`) ends the hidden part at its quote, so what follows can show.
- **Unlisted spellings of a listed term.** Adding `AcmeCorp` does not cover `Acme Corp`, `Acme-Corp`, or `Doe, Jane` for `Jane Doe`. List the variants you care about; `harvest` proposes candidates from your own draft.
- **Structured personal data.** Phone numbers, SSNs, and space- or hyphen-separated card numbers are not matched. Only unbroken 9+ digit runs are.
- **UNC paths.** `\\server\Users\you\…` is not matched; drive-letter and POSIX forms are.

Read the built output before you publish it. That review is part of the design, not a formality, and `preview` exists to make it easy.

### The launch invariant

honestweek's two non-negotiable promises:

1. **A receipt on every line.** Every emitted item points to its source: a commit SHA or a session turn. An item that reaches the renderer without a receipt is a build error, not a receipt-less line.
2. **It never asserts a motive the log does not contain.** honestweek defaults to **under-claiming**: verified/measured work that has landed on the repo's default branch reads as `shipped`; real work still on an unmerged branch reads as `in progress`; anything weaker reads as `designed, not proven`. It never narrates intent the transcript doesn't support.

## Releasing (maintainers)

honestweek is on npm, starting with version 0.2.0. I publish each version from my own terminal and then tag it, in the order [docs/releasing.md](docs/releasing.md) sets out. The `files` allowlist in `package.json` decides what ships (`bin/`, `lib/`, `SKILL.md`, the example config and the plugin manifests), and `test/package-contents.test.mjs` pins it.

## How it reads Claude Code and Codex logs

[docs/session-logs.md](docs/session-logs.md) says which Claude Code turns count as yours (a turn a program sent doesn't), which Codex files it reads, and which parts of a Codex turn it keeps.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup (there's nothing to install), the constraints every change keeps, and how to report a bug without pasting your own logs. To report a security or privacy problem privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
