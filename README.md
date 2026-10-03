# honestweek

[![CI](https://github.com/BryceEWatson/honestweek/actions/workflows/ci.yml/badge.svg)](https://github.com/BryceEWatson/honestweek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

honestweek works with the session logs that Claude Code and Codex already keep on your computer. It does two things with them, both on your own machine:

- **Find and replay your work.** `honestweek view` opens a page in your browser where you type a pull request number, a commit, a file, a branch or a few words and get the sessions behind it, then replay any session step by step. Every link and count says how it's known: recorded in a log or by git, computed from records, inferred by a named rule, or missing.
- **Write an honest weekly summary.** A short pipeline turns a finished week into a summary you review and publish yourself. It checks every commit the summary cites against your real git history first, and it stops rather than write a claim it can't back.

It's for developers who do much of their work through an AI coding agent and want to find, check or show that work later. Nothing leaves your machine: there's no account, no telemetry and no network call. The names and client words you list stay hidden on the page unless you turn on its Show private text switch, on your own screen, and keys, tokens and passwords stay hidden either way.

To see it with nothing to set up, run `npx github:BryceEWatson/honestweek view --demo`: a made-up week opens in your browser.

## Try it

You need Node 18 or later and git. Nothing is on npm yet, so run it straight from GitHub with `npx`, with no install step:

```bash
npx github:BryceEWatson/honestweek view --demo   # a made-up week in your browser; it sets nothing up
npx github:BryceEWatson/honestweek init          # set up honestweek.config.json in this folder
npx github:BryceEWatson/honestweek view          # your own last 7 days
```

The demo opens a page with three parts: Search (type one of the examples it offers, or a few words), Goals (each goal in a goal list, a small JSON file of your goals, with its sessions on one timeline you can play), and Replay (one session step by step, each step with the log line behind it). Press Ctrl+C in the terminal to stop it.

If you'd rather have a plain `honestweek` command, install it from GitHub with `npm install -g github:BryceEWatson/honestweek` and write `honestweek` where it says `npx github:BryceEWatson/honestweek`. From a clone of this repository, write `node bin/honestweek.mjs` there instead. `honestweek` with no command lists the same three steps. The messages you meet first (that list, `init`, `view` and its pages, and the one for a missing config) name each next step the way you ran honestweek.

Run `init` from your project folder, or from a new folder next to your projects. It lists the git repositories there and folds each extra working copy of one repository (a git worktree) into it, so one repository shows up once. Before it writes anything you can keep or drop repositories by number (`keep 1-5 9`, `drop 3 7-9`) or change a role (`role 2 display`; the roles are explained under [Config reference](#config-reference)). It then asks for people's names and client or project words to keep private, and reads back what it'll store. When you give some, it also adds `honestweek.config.json` to `.gitignore`, since the file then lists them. You can skip both, but until you list some, names in your logs show as written, and `view` says so in the terminal and on every page, with an example of where to list them. For candidates, run `discover` and then `harvest`: it writes the capitalised words that survived redaction in last week's sessions, most frequent first, to `honestweek.harvest.json`.

What's further down:

- [Install](#install) as a Claude Code plugin, a plain skill, or the standalone command.
- [Finding and replaying your work in the browser](#finding-and-replaying-your-work-in-the-browser-view): every option of `view`, the goal list, and what it keeps private.
- [The flow](#the-flow-an-honest-weekly-summary): the weekly summary from `init` to `build`, then [mining solved problems](#mining-solved-problems-worth-publishing-mine), [a standalone site](#standalone-site-page-mode) and [a report for a client](#a-report-for-a-client-client-mode).
- [Config reference](#config-reference), [Sidecars](#sidecars) (the files it writes) and the [privacy model](#what-it-does-not-do--privacy-model).

## Why

Your commits show what shipped. Your sessions show what you *figured out*: the dead ends you ruled out and the work that's designed but not yet proven. honestweek surfaces that honestly, with a receipt (a pointer to its source commit or session) on every line. Distilled work items also carry a status badge (`shipped` / `in progress` / `designed, not proven`); automatic session-derived digest items state why they surfaced without claiming work status.

## Requirements

- **Node ≥ 18**
- The system **`git` CLI** on your `PATH`
- **Zero runtime dependencies**: Node built-ins plus `git` only
- Runs **entirely locally**. No telemetry, no network egress. The optional `preview` and `view` servers bind to loopback (`127.0.0.1`) only.

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

Run it straight from GitHub. No install, no clone (zero dependencies, so it's quick):

```bash
npx github:BryceEWatson/honestweek --help
npx github:BryceEWatson/honestweek init
```

Or from a clone of the repo:

```bash
# run these from the repo root
node bin/honestweek.mjs --help
```

Or install it from GitHub as a `honestweek` command:

```bash
npm install -g github:BryceEWatson/honestweek
honestweek --help
```

Once it's published to npm (**not yet**; see [Releasing](#releasing-maintainers)), `npx honestweek` and `npm i -g honestweek` will work too.

The CLI surface is eleven subcommands: `init`, `discover`, `prompts`, `digest`, `validate`, `build`, `harvest`, `preview`, `mine`, `history`, and `view`. Every one answers `--help` without touching your files. The `mine` command (`node bin/honestweek.mjs mine --help`) is the separate "solved problems worth publishing" pass described under [Mining solved problems](#mining-solved-problems-worth-publishing-mine). The `digest` command (`node bin/honestweek.mjs digest --help`) prepares one receipt-bearing review across prompts, ideas, techniques, decisions, reversals, and next steps for `page` or `site` output. The `prompts` command (`node bin/honestweek.mjs prompts --help`) remains the private prompt inbox and prompt-only compatibility path. The `harvest` command (`node bin/honestweek.mjs harvest`) proposes redaction-denylist candidates from the draft to a gitignored sidecar (only the count is printed; the raw nouns stay local for you to review). The `preview` command (`node bin/honestweek.mjs preview`) renders the built output as HTML and serves it on a local-only (`127.0.0.1`) server for you to read in your browser. The `view` command (`node bin/honestweek.mjs view --demo` to try it) opens a local page for finding and replaying the sessions behind your work, described under [Finding and replaying your work in the browser](#finding-and-replaying-your-work-in-the-browser-view).

## Finding and replaying your work in the browser (`view`)

`honestweek view` opens a page on your own machine where you can find the sessions and goals behind a pull request, a commit, a file, a branch or some words, see which sessions worked toward each goal, and replay any session step by step. It reads your config and the last 7 days of your Claude Code and Codex logs, serves the page on `127.0.0.1`, and opens your browser. Nothing is published, and nothing it reads is written to disk.

```bash
node bin/honestweek.mjs view                  # the last 7 days of your logs
node bin/honestweek.mjs view --days 30        # look further back
node bin/honestweek.mjs view --from 2024-06-10 --to 2024-06-16 --goals goals.json
node bin/honestweek.mjs view --demo           # a made-up week, before you set anything up
```

With no `honestweek.config.json`, it stops and points to `honestweek init` to set one up and `honestweek view --demo` to look around first. The commands it names, there and on the page, are written the way you ran honestweek, except that a page names a script or package file by a placeholder (`node <your honestweek folder>/bin/honestweek.mjs`), since its steps can happen in another folder. While it reads the logs, the page says what it's reading and for how long. When your config lists no private words, the terminal and every page say that names and client words show as written, and where to add them. Ctrl+C stops it.

What's on the page:

- *Search.* Type a pull request (`#67` or its address), a commit, a file or a branch, and it lists the sessions and goals behind it. Type words, and it lists the goals and sessions whose titles match, the branches that contain them, and the prompts that share the most words, each with a link to replay from that prompt. A line says what these lookups cover: your configured repositories, in the dates shown at the top of every page.
- *Search everywhere.* The same words, searched across the prompts of every session in those dates, including display-only repositories and folders outside your config. Each result says which of those three it comes from.
- *Goals.* Each goal in your goal list, with the sessions working toward it on one timeline you can play, pause and scrub. A citation in the goal list that no session backs is listed as missing, with the reason.
- *Replay.* Any session, step by step. Each step opens a panel with what happened and who did it ("You", "a person or a script" for a non-interactive run, the main agent, or a named sub-agent), the original log line checked against its fingerprint, a command's output, and how its time is known.
- *Problems.* 40 known ways AI coding agents go wrong or waste time and tokens, which of them showed up in your sessions with each finding linked to its step in the replay, and fix ideas from published sources for you to adopt yourself; the replay and goal timelines can mark the same findings. To see it on the made-up week, run `node bin/honestweek.mjs view --demo` and open Problems.
- *One evidence key.* Every link, count and step says how it's known: **recorded** (a log line or git says so), **derived** (computed from recorded facts), **inferred** (a named rule's best reading, and the rule is named), **missing** (the log doesn't say), or **ambiguous** (the records fit more than one way). A goal you assigned a session to yourself, by citing it in your goal list, is labelled as yours.

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

- *It answers only your own page.* The server binds to `127.0.0.1`, refuses a request that names another host or comes from another website, and answers a data request only with this run's key. The key is made fresh each run and never sits in an address or a command line: the address it opens or prints carries a one-time code that the page trades for the key. Each code works once, and pressing Enter in the terminal prints a fresh address.
- *Redacted unless you ask.* The page shows redacted text. Its **Show private text** switch shows names, client words and folders on your own screen; keys, tokens and passwords stay hidden either way. The switch starts off every run and changes only text, never which sessions link to which or which goals they join. That version is built in memory the first time you turn it on, and it's never written to disk.
- *Display-only and outside sessions.* With the switch off, a session from a display-only repository or a folder outside your config never shows a private word, and it never joins a lookup or a goal. Git is never run against a display-only repository.
- *Nothing on disk.* The page's address holds only made-up ids, never what you typed or a goal's name, because the browser keeps addresses in its history. What it reads stays in memory. `--demo` builds its made-up week in a temporary folder and deletes it when you stop.

## Replaying how the work happened (the engine underneath)

The weekly summary below says what landed. The work-history engine in `lib/replay/` rebuilds how it got there from the same local logs: prompts, the sub-agents an agent started, each command and its recorded result, tests, interruptions, what git says happened to each commit, and which pull requests a default-branch commit names. You can replay it to any moment and drill from a week down to the log line behind a step, and every step says whether a record shows it, it was computed from records, a named rule inferred it, or the evidence is missing. It never invents working time or reasons. It doesn't change any existing output, and `honestweek view` (above) is its page. A developer tool also prints each level, from a clone of this repository (the tool isn't in the published package):

```bash
node tools/replay-inspect.mjs --config honestweek.config.json --from 2024-06-10 --to 2024-06-16 walk
```

[docs/work-history-engine.md](docs/work-history-engine.md) has the event model, the measured source coverage, and what it can't reconstruct yet.

### Finding the sessions behind a pull request, a commit, a file, or a goal (in development)

The same engine reads the history backwards too, through two more commands in that developer tool:

- `lookup` takes a pull request (`#64`, `your-repo#64`, or its link), a commit id, a file path, or a branch name, and lists the sessions whose records point at it, strongest evidence first. Each pointer says how it's known: a record shows it, or a named rule read it (for example, a `gh pr view 64` command). A file path is tried under each checkout of a repository, the configured folder and its worktrees, but never under a session's own working folder. An absolute path searches only the repository that holds it; a relative one searches each configured repository and lists the results per repository.
- `goals` takes a goal record: a JSON list of goals plus the log of changes made to it (a separate input from the goals page's registry above). For each goal it lists the sessions that did its work and every reason each one counts: the record cites the session or one of its pull requests or commits, a tool call wrote one of the goal's entries while the record accepted it, a command acted on a cited pull request, or a prompt named the goal. Whatever the record cites that no session matches is listed with the reason.

You can try both without any logs of your own. `--demo` runs them on the made-up sessions, git repository, and goal record the tests use, built in a temporary folder that's deleted afterwards:

```bash
node tools/replay-inspect.mjs --demo goals
node tools/replay-inspect.mjs --demo lookup '#7'
node tools/replay-inspect.mjs --config honestweek.config.json --from 2024-06-10 --to 2024-06-16 --goals goals.json goals
```

Both only read. Nothing is published, sessions outside your configured repos and in display-role ones are never searched, and display-role repos are never read by git. For a page on your own machine, the engine can also build a history that shows your private text (names, folders, addresses, ids) while keeping secrets hidden. It's built in memory and meant for your screen only: `honestweek view` asks for it only when you turn on Show private text, and the engine refuses to turn the whole history into JSON. The join types, their rules, and what lookup can't find are in [docs/work-history-engine.md](docs/work-history-engine.md#goals-and-lookup-reading-the-history-backwards).

## The flow: an honest weekly summary

This turns a completed week of your AI coding **sessions** (each one conversation log) into an honest, git-verified, private-by-default work summary, including the figured-out-but-not-yet-shipped work your commits can't show.

It's shipped as a Claude Code skill (instructions Claude follows when you type `/honestweek`) that runs small Node scripts with no dependencies, all on your machine. It reads your AI coding session transcripts, distils a completed week into an honest shareable summary, **re-derives every git-checkable claim against your real commits (or aborts)**, and produces a draft *you* review and publish yourself. It never auto-publishes.

End-to-end happy path, in order. Each step names the artifact it produces.

> Installed as the skill/plugin? Just run `/honestweek`: Claude drives these steps for you and resolves the CLI path automatically. The raw `node bin/honestweek.mjs …` commands below are for running the CLI directly **from a clone of the repo** (cwd = the repo root).

1. **`init`** → writes `honestweek.config.json`, inferred from your git state (your `git config user.email` plus the nearby git repos it finds), for you to review. If it finds no repositories, it writes nothing and says where to run it instead. It also drops `honestweek.config.example.json` if one isn't present. Two confirmations gate the write; accepting the defaults yields a valid config. Between them it asks for the names and client words to keep private, which go under `redaction` (either can be skipped; when you give some, the config also goes into `.gitignore`), and before the second it shows a short summary of what the file will say.
   ```bash
   node bin/honestweek.mjs init
   ```
   Those questions need someone to answer them. Answers piped in on stdin work, one per line. In a script, in CI, or from an agent's shell where stdin ends before the last answer, `init` exits `2` rather than writing a config you never approved, and tells you to accept the inferred defaults instead:
   ```bash
   node bin/honestweek.mjs init --yes
   ```
   `--yes` leaves an existing `honestweek.config.json` untouched; add `--force` to overwrite it.
2. **`discover`** → scans the **last completed week's** sessions **and session-end handoffs** (`.claude/handoffs/*.md`, for `featured`/`reference` repos; `display` repos are never read) from your allowlisted repos and writes the gitignored, **redacted** `honestweek.draft.json`. Handoffs contribute their tagged claims, reversals, and cited commits as additional, bounded material. Deterministic: no model call.
   ```bash
   node bin/honestweek.mjs discover          # or: discover --week 2024-W23
   ```
3. **`/honestweek`** (the skill) → **distils** the draft into the human-reviewable `honestweek.items.json`, with a status badge **and** a receipt on every item. This is the one model-judgment step; see [`SKILL.md`](SKILL.md) for the distillation contract.
   For `page` or `site` output without the opt-in goals registry, run `node bin/honestweek.mjs digest prepare`. It scans the completed week from Claude Code and Codex, updates the gitignored private prompt inbox and balanced review model, and writes the public-safe `honestweek.prompt-items.json` lane. Use `digest candidates` and `digest explain <item-ref>` to inspect the exact score, selection reason, privacy result, and transcript receipts. Use `digest keep`, `hide`, `delete <item-ref> --yes`, or confirmed `delete --all --yes` to control current items in any category, then run `validate` and `build`. Keep changes selection only and never bypasses receipt or privacy gates. Delete removes private review text and leaves a no-text tombstone so preparation cannot regenerate the item; it cannot recall an output you've already built. `digest reset-tombstones <item-ref>|--week <YYYY-Www>|--all --yes` is the explicit regeneration control. The balanced digest lane and the goals page are not yet compatible; use the existing distillation path when the goals registry is present.

   Selected next steps and cues labelled `unresolved idea: <subject>` carry automatically for at most the next two reporting weeks. They must still pass the current privacy gate, automatic floor, target, and category cap. `digest carry-forward <item-ref>` schedules one current public-safe candidate for exactly the next digest and does not extend automatic carry. A human turn labelled `picked up: <subject>` or `ruled out: <subject>` retires one unambiguous matching carry. Every carried or renewed item discloses why it appeared and its first-seen and current week. Carry history is private, redacted, and limited to 12 week records.

   A lifecycle build binds the exact configured output bytes and next carry state with hashes. If an interrupted build leaves `honestweek.carry.pending.json`, the next `prepare`, `validate`, or `build` recovers only a recognized hash combination. Use `digest recover --discard-pending` only when the output differs and carry is still at its prior hash. Unknown states fail closed. Use `prompts list`, `source`, `keep`, `hide`, and `delete` when you want the prompt inbox controls directly. Automatic selection discloses its floor, overall target, category caps, omitted counts, and uncertainty. Privacy edits are deterministic redactions; ambiguous or residual high-risk material stays private. `prompts curate` remains available when you intentionally want the prompt-only lane.
   > Optional but recommended: gate the distilled items before building:
   > ```bash
   > node bin/honestweek.mjs validate          # add --no-dashes for the voice rule
   > ```
   > `validate` exits `2` if any item lacks a valid badge or a receipt, **names a `display`-role repo or cites a commit against one**, or lets a configured redaction term survive into the prose. It catches an authoring leak at the source instead of relying on build-time scrubbing.
4. **`build`** → re-derives and **git-verifies every cited commit**. It **aborts with exit code `2`** if any cited commit is unresolved or its `authorEmail` is not in `identity.authorEmails`, writing nothing rather than emit a half-true summary. A `shipped` badge additionally requires every cited commit to have **landed**: reachable from the repo's default branch (origin/HEAD as recorded locally, else `main`/`master`, else the repo's only branch), checked offline from local refs, never a fetch. Real work still on an unmerged branch keeps its receipt and is downgraded to `in progress`, announced on stderr; if the repo has no determinable default branch, the `shipped` claim is unverifiable and the build aborts (exit `2`).
   ```bash
   node bin/honestweek.mjs build
   ```
5. **emit** → on success, `build` renders the final **local** output in the configured `output.mode` (`post` / `changelog` / `digest` / `report` / `page` / `site`) to `output.file`. The `digest` carries a git-derived **Activity** summary (commits and active days for `featured`/`reference` repos; `display` repos are never git-read, so they get no metrics, and an unreadable repo gets no fabricated `0`). `page` renders a self-contained, interactive HTML **standalone site** (see below). You review it and publish it yourself.
6. **`preview`** (optional) → serves the built `output.file` on a local-only `127.0.0.1` server, then opens your browser. A Markdown output is converted to a locked-down HTML page; the `page` output is already HTML and is served verbatim (with its inline interactivity). It is a viewer: it reads the file `build` wrote, publishes nothing, and needs no internet. Press Ctrl+C to stop.
   ```bash
   node bin/honestweek.mjs preview              # add --no-open to just print the URL, or --port <n>
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
node bin/honestweek.mjs mine              # report what is undecided
node bin/honestweek.mjs mine --draft      # and write the top one up as a post
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
node bin/honestweek.mjs mine --decide "<finding key>=published"   # or =declined
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
      "text": "Retry queue for failed webhook deliveries — designed, not yet wired in.",
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
- **designed, not proven** — Retry queue for failed webhook deliveries — designed, not yet wired in. _(your-project)_  (`a1b2c3d4`)
```

## Standalone site (`page` mode)

Set `"output": { "mode": "page" }` and `build` writes one self-contained, interactive
HTML file (`honestweek.report.html` by default), a polished **standalone site** with a
git-derived commits/day chart, collapsible per-project cards with metrics, status-badged
items, and an expandable git receipt on each. No target project, no framework, no build
step, and **zero external resources** (inline CSS + JS, system fonts), so it opens
anywhere and `preview` can serve it under a no-egress CSP:

```bash
node bin/honestweek.mjs build     # writes honestweek.report.html
node bin/honestweek.mjs preview   # serves it on 127.0.0.1 + opens your browser
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
happens on one day, so N active days mean at least N sessions); for a cross-cwd generalized
project that reconciled figure is a lower bound on its distinct session-days, not a raw
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
node bin/honestweek.mjs build     # writes report.html + goals.html (when the registry is present)
node bin/honestweek.mjs preview   # serves both at 127.0.0.1 (/ and /goals.html)
```

## A report for a client (`client` mode)

A weekly log is for you. A client report is for the person paying for the work: what you did for them over a period you choose (a sprint, a month, the contract so far), in their words, with the evidence attached. It's one light, printable HTML file (`honestweek.client.html` by default) they can read in a browser or save as a PDF.

It keeps every guarantee the weekly modes have. Every change in it names the pull requests it came from, every cited commit is verify-or-abort'd and has to be yours and on the default branch to count as merged, and a cited commit dated outside the period aborts the build. The numbers at the top (pull requests merged, commits on the main branch, days with work landed) and the activity chart are read from git, and an unreadable repo leaves them blank rather than too low. An appendix lists every pull request of yours that landed in the period, marking which ones the report describes, so nothing is quietly left out.

The source is what reached the default branch, not a week of session logs:

1. Add a `client` block to the config (it names the client, and optionally who it's for and from, plus link prefixes so PR numbers become links), and set `"output": { "mode": "client" }`. Use a separate folder and config for each client.
2. List what landed in the period. This writes the gitignored `honestweek.history.json` and prints only counts:
   ```bash
   node bin/honestweek.mjs history --from 2026-04-01 --to 2026-06-30
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
  "week": { "startsOn": "monday", "timezone": "UTC" },       // optional; startsOn is "monday" for v0.1; timezone is an IANA zone (defaults to the host zone)
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
| `week.startsOn` | `"monday"` (the only supported value in v0.1). |
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
| `output.archive` / `output.archiveDir` | Opt-in local weekly archive. With `archive: true`, `build` also snapshots each week to `<archiveDir>/<weekStart>.json` and maintains `<archiveDir>/index.json` (the "/log" series; default dir `honestweek.archive`). Local files only, never pushed. |
| `client.name` | **Required for `client` mode.** The client or product the report covers. |
| `client.preparedFor` / `preparedBy` / `organization` | Optional lines for the report's header: who it's for, who wrote it, and the business it comes from. |
| `client.prLinks` | Optional map of repo label to an https prefix (`https://github.com/your-org/your-project/pull/`), so a PR number derived from a verified commit becomes a link. Every key must be a configured repo label. |
| `voice.denyMeta` | Opt-in authored-prose honesty lint, **OFF by default**. When `true`, `build` aborts (exit 2, writes nothing) if an authored-prose field (item `title`/`summary`/`text`, or curated `content`/`projects` prose) *narrates its own withholding* ("keeping the specifics sealed", "kept generic here", "not public-facing") or *announces the page's own honesty* ("show the work honestly, receipts and retractions included", "belongs in an honest log"). That's what an honest log should show through its badges and receipts, not say about itself. It's the prose analogue of the numeric fact-fence, names each offending field plus matched phrase plus rule, and is **never** applied to verified evidence snippets/receipts (where a word like "sealed" can legitimately appear); conversely, keep authored prose out of evidence-named keys (`commits`, `receipt`, `snippet`, ...), which are treated as evidence and skipped. Absent, nothing changes. |
| `goalsFile` | Optional. The goal list `view` reads, resolved like a repo path. Leave it out and `view` runs without goals, or pass `--goals <file>` for one run. It's not the goals page's `honestweek.objectives.json`; see [The goal list](#the-goal-list). |
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
| `honestweek.items.json` | The distilled, human-reviewable items. **Yours to keep or ignore** (gitignored by default; safe to delete). |
| `honestweek.reader.json` (opt-in) | The reader profile for a client report: who it's for, what they see first, and where each line of that came from. Holds a real person's preferences, so keep it private with the report. |
| `<report>.note.md` (opt-in) | The short note a reader profile asks for with `format.note`, written beside the client report. Yours to share. |
| `honestweek.history.json` | What landed on the default branch in a period, from `history`: the raw material for a client report. **Gitignored.** Redacted before it's written; only counts are printed. |
| `honestweek.harvest.json` | Proposed redaction-denylist candidates from `harvest`. **Gitignored.** Only the count is printed; the raw nouns stay local for you to review. |
| `output.file` (e.g. `honestweek.digest.md`) | The final rendered output. **Yours to keep or ignore.** |
| `honestweek.config.json` | Your config. `init` adds it to `.gitignore` when you give it private words, since it then lists them; it can also hold private repo paths. Un-ignore it if you want it tracked. |
| `honestweek.archive/` (opt-in) | The local weekly snapshots + `index.json` (the "/log" series). Only written when `output.archive` is true. **Yours to keep, ignore, or commit.** |
| `honestweek.objectives.json` (opt-in) | The goal registry that turns `page` mode multi-page (emits `goals.html`). Absent → single-page. The publish gate for goals; commit it if you want the goals page. |
| `honestweek.goal-changelog.json` (opt-in) | Optional append-only log of structural goal-set changes, rendered as the goals page's "what changed" band. |
| `honestweek.findings.json` (opt-in) | The `mine` findings ledger: what was found, and what you accepted or declined. **Commit it**: it is the only record of what you already said no to, and everything in it is de-identified and redacted before it is written. |

## What it does NOT do / privacy model

- **Only your own allowlisted repos are read.** Nothing outside your `repos` list is ever touched.
- **`display`-role repos are summarized generically and NEVER git-read.** There is no code path that runs `git` against a `display` repo.
- **Output stays local until you publish it.** honestweek writes local files only.
- **No telemetry, no network egress.** The optional `preview` server is loopback-only (`127.0.0.1`): it serves your already-built output to your own browser, and nothing leaves your machine. The `view` page is loopback-only too, answers only the page it opened, and keeps what it reads in memory; see [What `view` keeps private](#what-view-keeps-private).
- **Nothing is auto-published.** honestweek produces a draft; *you* are the publisher.

### What the scrubber catches, and what it doesn't

Redaction is pattern-based and deliberately over-redacts when a pattern is ambiguous. It reliably removes email addresses, home and user paths (including `~/…`), prefixed API keys and JWTs, high-entropy tokens of 32+ characters, UUIDs, bare 9+ digit runs, currency amounts, and every term you list under `redaction`.

It also hides the value of a field whose name says it's a secret: a password, passphrase, token, secret, API key, access or private key, credential, cookie, signature or authorization. The name can be spelled `API_KEY`, `x-api-key`, `client_secret`, `dbPassword`, `authtoken`, `DB_PASS`, `PGPASSWORD` or `MYSQL_PWD`, and the value can follow `=`, `:`, `:=`, `==` or `===`, sit in a quoted JSON string at any level of escaping, or follow a `--password` flag or a `-Password` parameter. A `password:` line and an `Authorization:` or `Cookie:` header are hidden to the end of the line, a quote, or the next `key:` on it. In a JSON record read back whole, a value under a key like that is hidden too. Bearer and Basic credentials, the password in a web address (`redis://:…@host`) or after `curl -u user:…`, and a PowerShell `ConvertTo-SecureString` literal go the same way. Only the value is replaced, with `[redacted:secret]`, so you can still see which field held it. A key that only ends in `Key`, like `fileKey` or `sessionKey`, isn't a secret, and neither is a value like `true`, `none`, or a test count after `pass:`.

It is a safety net, not a guarantee. Known gaps, so you can decide rather than assume:

- **Short secrets with nothing naming them.** A hand-picked password under 32 characters that no field, flag, header or scheme names (a bare `hunter2` in a sentence, a password glued to `mysql -p`, an item in a plural `tokens` list) is indistinguishable from prose and survives.
- **Prose that reads like a field.** Because it errs toward hiding, a sentence that starts like one loses the word after the colon: `Auth: users get logged out` is published as `Auth: [redacted:secret] get logged out`. In goal text (an objective's label, `what`, `why` or `how`, or a changelog entry), anything the redactor would change stops `build` instead, so reword a line like `Auth: refresh sessions quietly` there. Plain words after `Bearer` or `Basic` (`basic validation`) and a type annotation (`login(password: string)`) are left alone.
- **A value after a bold label.** In `**Token:** abc123` the field's value reads as the closing `**`, so `abc123` still shows. Keep secrets out of Markdown bold labels.
- **A quoted part inside a header.** A quoted part (`Cookie: theme="dark"; session=…`, `Authorization: Digest … response="…"`) ends the hidden part at its quote, so what follows can show. A literal `[redacted:…]` placeholder already in the text followed by a quote and more text (`Authorization=[redacted:secret]'…`) keeps that text.
- **Unlisted spellings of a listed term.** Adding `AcmeCorp` does not cover `Acme Corp`, `Acme-Corp`, or `Doe, Jane` for `Jane Doe`. List the variants you care about; `harvest` proposes candidates from your own draft.
- **Structured personal data.** Phone numbers, SSNs, and space- or hyphen-separated card numbers are not matched. Only unbroken 9+ digit runs are.
- **UNC paths.** `\\server\Users\you\…` is not matched; drive-letter and POSIX forms are.

Read the built output before you publish it. That review is part of the design, not a formality, and `preview` exists to make it easy.

### The launch invariant

honestweek's two non-negotiable promises:

1. **A receipt on every line.** Every emitted item points to its source: a commit SHA or a session turn. An item that reaches the renderer without a receipt is a build error, not a receipt-less line.
2. **It never asserts a motive the log does not contain.** honestweek defaults to **under-claiming**: verified/measured work that has landed on the repo's default branch reads as `shipped`; real work still on an unmerged branch reads as `in progress`; anything weaker reads as `designed, not proven`. It never narrates intent the transcript doesn't support.

## Releasing (maintainers)

honestweek is publish-ready but not yet on npm. To cut a release so `npx honestweek` / `npm i -g honestweek` work:

1. Bump the version in `package.json` (and `.claude-plugin/plugin.json` to match), commit, and tag: `git tag v0.1.0 && git push --tags`.
2. **Add the `NPM_TOKEN` repository secret first** (an npm automation token). Do this *before* step 3, not after. The release workflow triggers on a Release being **published**, and publishing a GitHub Release is not reversible in any quiet way: without the token the workflow reaches `npm publish` and fails on authentication, leaving a public Release announcing a version that is not on npm. Confirm with `gh secret list` that `NPM_TOKEN` is listed.
3. **Automated:** publish a GitHub Release for the tag. The [`release` workflow](.github/workflows/release.yml) runs the tests and `npm publish --provenance --access public`.
   **Manual alternative:** `npm publish --access public` from a clean checkout after `npm login`.
4. The `files` allowlist in `package.json` controls what ships to npm (`bin/`, `lib/`, `SKILL.md`, the example config, the plugin manifests). Tests and fixtures are excluded.

Publishing to npm and cutting a GitHub Release are the only steps that go public; everything else in this repo is local.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup (there's nothing to install), the constraints every change keeps, and how to report a bug without pasting your own logs. To report a security or privacy problem privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

## Codex Voice and session logs

honestweek reads regular JSONL files under `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, excluding `subagents`. It does not read `history.jsonl`, plaintext logs, or other app state. A human turn is read from either shape Codex has used: the current `response_item` message with `role: "user"`, or the older `event_msg` / `user_message` string. Codex sends its own context (environment, `AGENTS.md`, plugin lists) and other agents' hand-offs through the same user slot, so a block that opens with a tag or the `AGENTS.md` preamble is dropped, only the request is kept from the IDE extension's wrapper (open file, tabs, mentioned files), and a message carrying a delegation, heartbeat, automation, or approval-review block isn't counted as a person at all. When a turn is written in both shapes, it's counted once. A Voice or dictated turn is ingested only when Codex records its transcript as one of those message shapes. The `audio`, `local_audio`, image, reasoning, tool-output, and other non-message fields are never retained as prompt text. A paired shell record sets only the observed-verification boolean when it contains one literal recognized test or commit command, an explicit zero exit, and matching positive evidence. Current Codex `exec` wrappers qualify only in a closed form that forwards the unchanged shell result; they are parsed without evaluation, and their source and output text are discarded. Raw session ids and working paths become hashes or private attribution; the redacted prompt, privacy audit, timestamp, source, turn, and receipt hashes remain in the current gitignored review store. Raw transcript retention remains Codex's responsibility and is not changed by honestweek.

A valid Codex session record does not need a final assistant message. Its public-safe human prompt can contribute to cross-session lexical recurrence and automatic draft selection, but it cannot supply assistant-final cues or observed verification unless those records exist. A missing, unconfigured, or `display`-role working directory makes the turn private. Private or hidden turns cannot supply recurrence evidence or enter automatic output. An ambiguous or high-risk human prompt is withheld from prompt recurrence and prompt output. A labelled cue in that human prompt retains the prompt receipt and conservative prompt audit; an assistant-final cue is gated separately on its own redacted rendition and exact receipt. A malformed record or missing Codex session identity makes that source unreadable and preserves the prior store. The private prompt store is regenerated for the completed week. Its no-text deletion tombstones persist until explicit reset, and redacted lifecycle carry persists only within the limits described above.
