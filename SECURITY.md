# Security and privacy

honestweek runs on your own machine and reads private data: your AI coding session logs and your git history. This page says what it reads, writes and runs, what counts as a security problem, and how to report one privately.

## What honestweek touches

- **It reads session logs** from Claude Code (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` when you set that) and Codex (`$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, with `~/.codex` as the default home). The `mine` command can also read Claude desktop's Cowork logs (under `%APPDATA%\Claude`).
- **It runs `git`** against the repositories you list in your config. Two setup commands look a little further: `init` checks the folder you run it in and the folders next to it for repositories with your commits, to suggest what to list, and `discover` checks whether its draft file is tracked in the folder you run it in.
- **It never runs `git`** against a repository you mark display-only, and it summarizes display-only work generically.
- **Weekly reports use sessions from your listed repositories.** A session anywhere else is private to the report: its text never becomes a report item. `mine` works differently: it looks for solved problems across every session in the logs it reads, because a problem worth writing up can come from any project. It reports what it found and writes a draft only when you run it with `--draft`.
- **It writes local files only**, and every string passes through its redactor (a pattern-based scrubber for secrets, personal paths and terms you list) before it's written. One of those files is meant to be committed: `mine` keeps its findings ledger in `honestweek.findings.json` on every run, de-identified and redacted, as the record of what you've already accepted or declined.
- **It makes no network calls.** No telemetry, no fetch. The optional `preview` server binds to `127.0.0.1`, so only your own browser can reach it.
- **It never publishes anything.** You decide what leaves your machine.

## What counts as a security problem

Please report privately if you find any way honestweek could:

- send any data off your machine;
- write an unredacted secret, or text it was told to redact, into an output file;
- run `git` against a display-only repository, or against a repository outside your list other than the two setup checks above;
- let the `preview` server answer anyone other than your own machine, or serve a file outside its output folder;
- run a command built from text inside a session log.

The redactor's known gaps (short low-entropy passwords, unlisted spellings of a listed term, phone numbers and similar) are documented in the README under "What the scrubber catches, and what it doesn't". Improvements there are welcome as ordinary issues or pull requests.

## How to report

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you ran, what you expected, and what happened. If that option isn't there, open an issue titled "Security report" with no details in it, and I'll contact you to take it private.

Please don't attach real session logs: a synthetic log line with the same shape is enough to reproduce most problems, and keeps your own data private.

I'll acknowledge a report as soon as I can, and I'll credit you in the fix unless you'd rather I didn't.

## Supported versions

Security fixes land on `main` and go into the next release. There's no long-term support for older versions yet.
