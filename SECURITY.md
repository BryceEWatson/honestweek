# Security and privacy

honestweek runs on your own machine and reads private data: your AI coding session logs and your git history. This page says exactly what it touches, what counts as a security problem, and how to report one privately.

## What honestweek touches

- **It reads** session logs from Claude Code (under `~/.claude/projects`) and Codex (under `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`), and runs `git` against the repositories you list in your config.
- **It never runs `git`** against a repository you haven't listed, or one you've marked display-only. It treats sessions from those repositories as private, and summarizes display-only work generically.
- **It writes** local files only: the outputs you ask for, plus gitignored review stores. Every string passes through its redactor (a pattern-based scrubber for secrets, personal paths and terms you list) before it's written.
- **It makes no network calls.** No telemetry, no fetch. The optional `preview` server binds to `127.0.0.1`, so only your own browser can reach it.
- **It never publishes anything.** You decide what leaves your machine.

## What counts as a security problem

Please report privately if you find any way honestweek could:

- send any data off your machine;
- write an unredacted secret, or text it was told to redact, into an output file;
- run `git` against a display-only repository or one you didn't list;
- let the `preview` server answer anyone other than your own machine, or serve a file outside its output folder;
- run a command built from text inside a session log.

The redactor's known gaps (short low-entropy passwords, unlisted spellings of a listed term, phone numbers and similar) are documented in the README under "What the scrubber catches, and what it doesn't". Improvements there are welcome as ordinary issues or pull requests.

## How to report

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you ran, what you expected, and what happened. If that option isn't there, open an issue titled "Security report" with no details in it, and I'll contact you to take it private. Please don't attach real session logs: a synthetic log line with the same shape is enough to reproduce most problems, and keeps your own data private.

I'll acknowledge a report as soon as I can, and I'll credit you in the fix unless you'd rather I didn't.

## Supported versions

Security fixes land on `main` and go into the next release. There's no long-term support for older versions yet.
