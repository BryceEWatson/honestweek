# Security and privacy

honestweek runs on your own machine and reads private data: your AI coding session logs and your git history. This page says what it reads, writes and runs, what counts as a security problem, and how to report one privately.

## What honestweek touches

- **It reads session logs** from Claude Code (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` when you set that) and Codex (`$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, with `~/.codex` as the default home). The `mine` command can also read Claude desktop's Cowork logs (under `%APPDATA%\Claude`).
- **It runs `git`** against the repositories you list in your config. A few setup steps look a little further: `init`, and Setup and Settings (its Find new repositories button) in `view`, check the folder you run them in and the folders next to it for repositories with your commits, to suggest what to list, and `discover` checks whether its draft file is tracked in the folder you run it in.
- **It never runs `git`** against a repository you mark display-only, and it summarizes display-only work generically.
- **Weekly reports use sessions from your listed repositories.** A session anywhere else is private to the report: its text never becomes a report item. `mine` works differently: it looks for solved problems across every session in the logs it reads, because a problem worth writing up can come from any project. It reports what it found and writes a draft only when you run it with `--draft`.
- **It writes local files only**, and every string passes through its redactor (a pattern-based scrubber for secrets, personal paths and terms you list) before it's written. One of those files is meant to be committed: `mine` keeps its findings ledger in `honestweek.findings.json` on every run, de-identified and redacted, as the record of what you've already accepted or declined.
- **It makes no network calls.** No telemetry, no fetch. The one exception is a choice you make on `view`'s Problems page: with Include /insights turned on, Run /insights starts your own `claude -p /insights` and Run with Codex starts your own `codex`, each only after you confirm. Those programs send your sessions to Claude or OpenAI on your own plan, and Codex runs in its read-only sandbox, which still lets it read files you can read. honestweek itself still sends nothing. Two commands start a local server, and both bind to `127.0.0.1`, so only your own machine can reach them: `preview`, which shows your built output, and `view`, a page for finding and replaying your sessions. Both refuse a request that names another host. `view` also refuses requests that come from another website, and answers data requests only from the page it opened: each run makes a fresh key, and the address it opens or prints carries a one-time code the page trades for that key.
- **`view` keeps what it reads in memory.** It reads your logs to answer the page and writes none of it to disk. What it does write: Setup writes `honestweek.config.json` (and `honestweek.config.example.json` if it's missing) when you press Save, Settings rewrites the config when you press Save, and the Include /insights switch saves its on or off in the config. Setup also adds honestweek's private working files to that folder's `.gitignore`, and Setup and Settings add the config there too once it lists private words. Run with Codex keeps Codex's answers, redacted again, in `honestweek.codex-judgments/` beside your config, a folder that ignores itself and gets a line in that folder's `.gitignore`. To open your browser without putting the one-time code in a command line, `view` writes a small redirect file to your temporary folder and deletes it within two minutes. Its Show private text switch shows names and folders on your own screen, never secrets, and that version is built in memory only when you turn the switch on. `view --demo` writes a made-up week to a temporary folder and deletes it when you stop.
- **It never publishes anything.** You decide what leaves your machine.

## What counts as a security problem

Please report privately if you find any way honestweek could:

- send any data off your machine, other than through Run /insights or Run with Codex after you confirm;
- write an unredacted secret, or text it was told to redact, into an output file;
- run `git` against a display-only repository, or against a repository outside your list other than the setup checks above;
- let the `preview` server answer anyone other than your own machine, or serve a file outside its output folder;
- let the `view` server answer another website, another host name, or a request without the run's key, show a secret with Show private text on, show a private word with it off, or write anything it read to disk other than the config and Run with Codex's redacted answers;
- run a command built from text inside a session log, or run `claude` or `codex` without your confirm.

The redactor's known gaps (short low-entropy passwords, unlisted spellings of a listed term, phone numbers and similar) are documented in the README under "What the scrubber catches, and what it doesn't". Improvements there are welcome as ordinary issues or pull requests.

## How to report

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you ran, what you expected, and what happened. If that option isn't there, open an issue titled "Security report" with no details in it, and I'll contact you to take it private.

Please don't attach real session logs: a synthetic log line with the same shape is enough to reproduce most problems, and keeps your own data private.

I'll acknowledge a report as soon as I can, and I'll credit you in the fix unless you'd rather I didn't.

## The npm package

honestweek's npm package is `honestweek`, starting with version 0.2.0. It has no dependencies, so `npm install` and `npx` fetch honestweek's own files and no one else's code. I publish each version myself from `main`, and `npm publish` runs the whole test suite before it uploads anything. [`CHANGELOG.md`](CHANGELOG.md) lists what changed in each version, and each version is tagged here as `v` plus its number.

If a version on npm doesn't match its tag in this repository, or a package with a similar name claims to be honestweek, please report it privately as described above.

## Supported versions

Security fixes land on `main` and go into the next npm release. Only the latest version gets fixes, so please check you're on it before you report: that's `npx honestweek@latest` or `npm install -g honestweek@latest`. There's no long-term support for older versions yet.
