# Changelog

What changed in each version of honestweek, newest first. Numbers in parentheses are the pull requests on GitHub.

## 0.2.0 (4 October 2026)

This is the first version on npm. 0.1.0 was released on GitHub, but its npm publish failed, so `npx honestweek` has never worked before this version.

### Added

- **`honestweek view`, a page in your browser served only from your own machine.** Find the sessions and goals behind a pull request, a commit, a file, a branch or a few words, see each goal's sessions on a timeline, and replay any session step by step. Every link, count and time says how it's known. Text is redacted by default, and a "Show private text" switch shows names and client words on your own screen while keys, tokens and passwords stay hidden. It has four pages, Find, Goals, Replay and Problems, under one slim header. Each page shows a few things first and keeps the rest one click away, and a "?" button explains the five evidence words. `honestweek view --demo` shows it all on a made-up week. (#84, #94, #95)
- **A Problems page in `view`.** It checks your Claude Code and Codex sessions against a catalog of 40 known ways AI coding agents go wrong, such as saying "done" after a failing test, loops, oversized context and destructive commands. Each problem found links to the exact moment in the replay, with fix ideas drawn from the catalog's published sources, and a thin "Worth a look" strip marks the same findings on the replay and goal timelines. Every finding says how it's known, and none is called a failure. When the window has no sessions to check, the page says so and no pattern reads as clear. Your "My priority" choices and the strip's switches are saved in your browser's local storage, as pattern ids and settings only. (#90, #95)
- **An easier first run.** Messages name the command the way you ran it, so every next step can be copied. With no arguments, honestweek prints three first steps. `init` explains repository roles, asks which names and client words to keep private, prints a short summary instead of the whole config, and points you to `view`. `view` says, in the terminal and on every page, when no private words are set. (#87)
- **A work-history engine.** It reads your local Claude Code and Codex logs and rebuilds a timeline you can replay to any moment, down to the log line behind each step. Every step says whether a record shows it, it was computed from records, a named rule inferred it, or the evidence is missing. It never invents working time, causes or reasons. (#67)
- **Finding the sessions behind your work.** The engine can list the sessions that worked toward a goal, and the sessions behind a pull request, a commit, a file or a branch. A link it can't settle is marked as ambiguous instead of guessed. (#70)
- **Token counts and raw text in the engine, both off by default.** With `usage: true` the engine records the token counts of each model call: numbers and ids, never text. A Codex sub-agent's log copies its parent's history, and the engine leaves those copies out so each call counts once. With `keepRaw: true` it keeps a session's raw text in memory, so checks running in the same process (the Problems page's) can read it. That text sits on a field that's never turned into JSON, and sessions outside your configured repositories or in display-only ones never get it. (#89)
- **A demo week.** One command writes a made-up week of sessions, the small git repository they worked in, and a goal record, so you can try the engine without your own logs. The week tells one story: a developer pushing a made-up project toward a release. Most sessions are ordinary good work, and a few show problems at all three priority levels, so the Problems page has something to show. Every name, project, host and token in it is made up. (#72, #91)
- **A client report** (`client` mode): one printable page of the work done for one client over any period, with its numbers and pull requests taken straight from git. (#64)
- **Reader profiles for the client report.** The same checked facts, ordered and trimmed for the person reading them. Anything left out is counted on the page. The design is in `docs/reader-profiles.md`. (#65, #66)
- **A contributing guide, a security policy, and issue and pull request templates**, so someone new can set up, learn the rules every change keeps, and report a problem without pasting their own logs. (#68)

### Changed

- Redaction is much faster on short text, and the prompt privacy check stays fast on large prompts with thousands of matches. What gets hidden is unchanged. (#77, #82)
- New tests make sure two repositories that share a pull request number stay apart in lookups and goals. (#75)
- The npm package has a new description and keywords, and runs the full test suite before every publish. CI now runs on Windows and macOS as well as Linux. (#88)

### Fixed

- honestweek reads the current Codex log format again. `mine`, `digest` and `prompts` had been seeing zero Codex sessions. (#61)
- A commit id made only of digits stays a commit id, instead of showing as `[redacted:account]`. (#74)
- The test suite no longer leaves folders in your system temp folder, and one slow test no longer looks through the whole temp folder. (#81, #86)
- A session in another worktree of a configured repository counts toward it even when the repository is reached through a symlinked folder (as macOS does for its temp folder) or a shortened Windows folder name. Before, git's spelling of the path and yours didn't match and the session counted as "other". (#88)
- The weekly digest (the step that picks prompts, ideas and decisions out of a week of sessions) no longer stops the whole week over one item. When a second pass of the redactor would still hide more of an item's text, `digest prepare` holds that one item back as `high-risk`, counts it in its "Privacy withheld" line, and builds the rest. The held-back text isn't written to any file. (#96)
- An idea carried from one week's digest into the next no longer stops the following week's build when the prompt it was written in had something redacted, such as an email address. A carried idea whose prompt changed afterwards is still refused. (#96)
- `view --self-test`, which clicks through every page and counts private words that slip through, no longer raises a false alarm when one of your private words also appears in the title or address of a published source on the Problems page. The word still counts as a leak anywhere else. (#96)
- One kind of input, a long run of `name=value` text with no spaces, no longer makes the redactor four times slower each time the text doubles in length. What gets hidden is unchanged. (#97)

### Privacy

- `git` never runs against a repository you mark display-only. `mine`, `init` and `discover` had broken that promise in a few cases. (#69)
- A Windows home folder inside JSON text, where every backslash is doubled, is redacted like any other home folder. (#71)
- A private term you list is caught inside longer names too: after an underscore or a digit, as part of a camel-case name, and in a web address or file name. (#76)
- Secret fields are hidden in everything honestweek writes, not only on screen: passwords in JSON, `Authorization` and `x-api-key` headers, `DB_PASS=` and similar, `--password` flags and `curl -u`. (#79)
- A secret flag whose name has a dot, like `--docs.token abc123`, has its value hidden like any other secret flag. Ordinary dotted flags such as `--log.level debug` stay readable. (#92)
- Three more ways of writing a secret are hidden: a Java property such as `-Dapi.key=…`, a dotted key such as `api.key=…`, and a secret field whose opening single quote is never closed. This can hide a harmless word: `app.key = loadKey()` now hides `loadKey()`. (#93)
- A secret that comes after a second secret-sounding name, as in `api_key=token: VALUE`, is hidden. Before, the name was hidden and the value showed. So is the value of a `KEY=VALUE` whose key is split from its `=` or its value by a line break. A value still shows when the inner name doesn't sound like a secret, as in `token: note: VALUE`. (#97)
- Private words are hidden before the engine shortens a long text, so a name the cut would split can't show its first letters. (#83)
- The engine can build a history for your own screen where names and folders show as written and secrets stay hidden. No command writes it to a file, and the engine refuses to turn it into JSON whole. (#73)

## 0.1.0 (14 August 2026)

The first release, on GitHub. Its npm publish failed, so it never reached npm.

- **The weekly summary pipeline:** `init`, `discover`, a distil step where the model drafts items under a written honesty contract, `validate`, `build` and `preview`. Every item carries a receipt: the commit or session turn it came from.
- **Verify or abort.** `build` checks every cited commit against your real git history and stops with exit code 2, writing nothing, if one doesn't resolve or wasn't authored by you. A `shipped` item whose commits haven't reached the default branch is downgraded to `in progress`.
- **Nine commands:** `init`, `discover`, `prompts`, `digest`, `validate`, `build`, `harvest`, `preview` and `mine`, plus the `/honestweek` skill. Each one answers `--help` without reading a log or writing a file.
- **A redactor** for private terms, home folders, API keys, tokens and account numbers, which keeps the commit ids and counts the summary depends on. Display-only repositories are summarized generically and never read with `git`. No telemetry, no network calls.
- **Status badges** (`shipped`, `in progress`, `designed, not proven`) that pick the weaker one when the evidence is mixed.
- **Six output modes:** `post`, `changelog`, `digest` (the default), `report`, `page` (a self-contained HTML page, with an optional goals page) and `site` (JSON for your own site to render).
- **Claude Code and Codex readers** that use your session transcripts without copying their text into the output.
- **`mine`**, which finds sessions where you worked out a fix for software you didn't write, ranks them, and keeps a ledger of what you've decided. With `--draft` it writes the top one up as a post whose checklist starts `UNVERIFIED`.
