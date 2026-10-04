# Changelog

What changed in each version of honestweek, newest first. Numbers in parentheses are the pull requests on GitHub.

## Unreleased (0.2.0)

This will be the first version on npm. 0.1.0 was released on GitHub, but its npm publish failed, so `npx honestweek` has never worked before this version. One pull request this version waits for hasn't merged yet; it's marked "not merged yet" below.

### Added

- **Setup in the browser.** Run `honestweek view` in a folder with no config and the page that opens is Setup: the repositories it found nearby with their roles explained, your email and timezone filled in, the names and client words to keep private, an optional goal list, and a preview of the config. Save writes it and goes straight on to your week, with no restart. `honestweek init` still works for scripts and CI.
- **Settings, and how far back to look.** Setup asks how far back `view` reads: the last week (the default), a number of days, from a date, between two dates, or all history, and the page says which days a choice loads and how far back your logs go. A Settings page, linked from every page's header, changes that later, along with the repositories and their roles, your emails, the private words and the goal list. It shows what will change before it saves, keeps everything else in the file as it was, and reloads the week with no restart. A choice loads the newest days first, up to 500 MB of logs, a limit you can raise in Settings after seeing an estimate of its cost, and the page says when that makes it partial. `--days`, `--from` and `--to` still change it for one run.
- **`honestweek view`, a page in your browser served only from your own machine.** Find the sessions and goals behind a pull request, a commit, a file, a branch or a few words, see each goal's sessions on a timeline, and replay any session step by step. Every link, count and time says how it's known. Text is redacted by default, and a "Show private text" switch shows names and client words on your own screen while keys, tokens and passwords stay hidden. `honestweek view --demo` shows it all on a made-up week. (#84)
- **An easier first run.** Messages name the command the way you ran it, so every next step can be copied. With no arguments, honestweek prints three first steps. `init` explains repository roles, asks which names and client words to keep private, prints a short summary instead of the whole config, and points you to `view`. (#87, not merged yet)
- **A work-history engine.** It reads your local Claude Code and Codex logs and rebuilds a timeline you can replay to any moment, down to the log line behind each step. Every step says whether a record shows it, it was computed from records, a named rule inferred it, or the evidence is missing. It never invents working time, causes or reasons. (#67)
- **Finding the sessions behind your work.** The engine can list the sessions that worked toward a goal, and the sessions behind a pull request, a commit, a file or a branch. A link it can't settle is marked as ambiguous instead of guessed. (#70)
- **A demo week.** One command writes a made-up week of sessions, the small git repository they worked in, and a goal record, so you can try the engine without your own logs. (#72)
- **A client report** (`client` mode): one printable page of the work done for one client over any period, with its numbers and pull requests taken straight from git. (#64)
- **Reader profiles for the client report.** The same checked facts, ordered and trimmed for the person reading them. Anything left out is counted on the page. The design is in `docs/reader-profiles.md`. (#65, #66)
- **"Zoom to these steps" on every problem finding.** It opens the replay zoomed to exactly the steps the finding's check recorded, marks only those, steps through them, and says how that set is known, without guessing the steps in between.
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

### Privacy

- `git` never runs against a repository you mark display-only. `mine`, `init` and `discover` had broken that promise in a few cases. (#69)
- A Windows home folder inside JSON text, where every backslash is doubled, is redacted like any other home folder. (#71)
- A private term you list is caught inside longer names too: after an underscore or a digit, as part of a camel-case name, and in a web address or file name. (#76)
- Secret fields are hidden in everything honestweek writes, not only on screen: passwords in JSON, `Authorization` and `x-api-key` headers, `DB_PASS=` and similar, `--password` flags and `curl -u`. (#79)
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
