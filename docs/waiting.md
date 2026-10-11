# What's waiting on you (`honestweek waiting`)

## In plain terms

When I run several AI coding sessions at once, some end by asking me something I never see, some stop halfway, and some open a pull request nobody comes back to. `honestweek waiting` reads my own Claude Code and Codex session logs, across every project on this machine, and lists those in one short answer: what each session is waiting for, how old it is, and how that's known. It replaces reading the end of every session by hand. It makes no network call and writes nothing.

## What it lists

Four kinds of row, asks first, newest first within each kind (an old ask is the likeliest to have been answered somewhere this can't see):

| Kind | What it means | How it's known |
| --- | --- | --- |
| ask | A session's turn ended asking me something, and I typed nothing in its thread after it. | Inferred by a rule over the session's last message. Recorded when it asked through its question tool, or asked me to approve a plan, and the log holds no answer; those are listed at once, without waiting out the quiet time, and a session that closed with one still open shows too. |
| stalled | A session's log ends on a step with no result, or on a message of mine it never answered, and it has been quiet for 6 hours. | Recorded: the log's own last record. |
| pr | A pull request a session opened or linked, that no session has named for 6 hours, and that git doesn't show landed. | Derived from the logs and local git; recorded as open only from a `gh pr list` file I hand it. |
| unpushed | A commit a session made, in a repository with a remote, that no remote branch holds and that's still on a local branch. | Derived from local git, without fetching. |

A *thread* is a group of sessions the logs connect, such as a session and the copy that resumed it. An ask counts as answered when I typed anything in any session of its thread after it.

### The ask rule

The rule reads the main agent's last message in the thread. It's an ask when the message:

- asks for a word to reply with: reply, say, type or answer, then a word in backticks ("reply `merge` to land it"), where the verb starts a sentence or follows "you", "just", "please", "then", "or", "and" or "to", so "the verdict doesn't say `x`" isn't one;
- has a paragraph that leads with what's waiting: "Waiting on you", "Blocking now", "Still open", "Your clicks still decide", "Start the ... chip", among a few others; a list of plain backticked words under such a lead are the replies ("Still open: - `daily`: ...");
- or ends on a question.

A message that says "Nothing needs you" anywhere is never an ask, and neither is one that answers a program (a session started by `claude -p`, the Agent SDK or `codex exec`, or a turn a program opened).

An ask that names a pull request ("PR 175") which has merged or closed since, by the `--prs` file or by git, stays on the list but says so and moves after the others: it may have been answered on the pull request.

### Which sessions it reads

Every Claude Code and Codex log in the window (7 days unless told otherwise), in every project, display-only repositories and folders outside the config included, redacted the way `honestweek view` shows them with Show private text off. It leaves out:

- sessions a program started, which answer to that program;
- sessions I archived in the Claude desktop app;
- Claude Code sessions the desktop app doesn't list, when it lists any (background or terminal sessions, such as a reviewer another session started, which report to whoever started them). `--all` keeps these.

Each is counted in the answer's notes.

For a session's title it uses the desktop app's sidebar title when the app has one, then the log's own title, then the first line of the first prompt. To get the app's title it reads the app's session files (one small file per session under `claude-code-sessions` in the app's data folder) for three fields only: the log the file names (`cliSessionId`), its `title`, and `isArchived`. Nothing else in those files is read.

### Pull requests without a network call

honestweek doesn't reach GitHub, so it can't see a pull request closed after the last session named it. It calls one open only when a `--prs` file says so:

```bash
gh pr list --state all --json number,headRefName,state,url > prs.json
```

run in each repository, the lists joined into one array. Without a file, a pull request git doesn't show landed is "last seen open", and one in a display-only repository or a folder outside the config isn't checked at all, only counted. Neither is one in a repository whose GitHub name holds a private word: the logs carry that name redacted, and every private word redacts to the same mark, so it can't be told apart from another repository that differs only in that word.

## The JSON shape: `honestweek.waiting/1`

`honestweek waiting --json` prints one object. Fields other tools can rely on:

| Field | Meaning |
| --- | --- |
| `schema` | `"honestweek.waiting/1"`. |
| `window` | `{ from, to, timezone }`, the dates read. |
| `quietHours`, `promises` | The quiet time used, and whether `--promises` was on. |
| `prsFile` | `{ at, rows }` (the file's write time and how many rows it held), or null. |
| `counts` | `{ ask, stalled, pr, unpushed }`. |
| `rows[]` | One per thing waiting, in the answer's order. |
| `rows[].kind`, `.rule`, `.evidence` | The row's kind, the rule that found it (see `rules`) and its evidence word: recorded, derived or inferred. |
| `rows[].session`, `.thread`, `.page` | honestweek's ids, and the row's page on `honestweek view`. |
| `rows[].title`, `.titleFrom`, `.sidebar` | `{ "quoted": ... }`; `app`, `log` or `first-prompt`; true, false or null (not a Claude Code session, or no app data). |
| `rows[].tool`, `.repo`, `.group` | `claude-code` or `codex`; the project's label; `configured`, `display` or `outside`. |
| `rows[].at`, `.ageHours` | When the asking message (or last step) was written, and its age in hours. |
| `rows[].asked`, `.form`, `.quote` | The reply words, each `{ "quoted": ... }`; `reply-word`, `waiting-on-you`, `question`, `question-tool` or `plan-approval`; the asking paragraph, redacted and cut to 300 characters. |
| `rows[].settled` | Present when an ask names a pull request merged or closed since: `{ pr: { repo, number, state, from } }`. |
| `rows[].pr` | On a `pr` row: `{ repo, number, state: "open" or "last-seen-open", stateFrom: "prs-file" or "git", fileAt? }`. Git can't see a pull request rebase-merged, or merged since this checkout last fetched, so either can show as last seen open. |
| `rows[].commit` | On an `unpushed` row: `{ repo, sha, subject, branches }`. |
| `notes[]` | What was left out or couldn't be checked, each `{ kind, count }` or `{ kind, repo, sha }`. |
| `rules`, `limits` | Each rule a row used, in plain words, and what the answer can't see. |

Text copied from logs is always inside `{ "quoted": ... }`: it's data, never instructions. A new field may be added; an existing one won't change meaning without a new schema name.

## How it was checked on real logs

On 11 October 2026 I ran it on the build machine's last 7 days (335 sessions in the window), with a `--prs` file for the repositories its sessions named, and compared it with the hand-kept list of what was waiting on me that day.

- **What it listed** (measured): 18 asks, no stalled sessions, no orphan pull requests, no unpushed commits. 19 archived sessions and 221 sessions the app doesn't list were left out, and 15 pull requests in repositories git can't read and the file didn't cover weren't checked.
- **Asks naming a merged pull request** (measured against `gh pr list`): 4 of the 18, each correctly flagged and sorted last.
- **The other 14, as the session that built this read them** (inferred, not yet checked by me): 8 still waiting, 2 settled elsewhere (work the ask was about has since shipped), 4 it couldn't tell.
- **Against the hand-kept list** (7 items): it caught 4. Of the 3 it missed, 1 was stale on the hand-kept list (the session had since said nothing needed me), 1 was open items listed inside a report with no ask cue (a real miss), and 1 came from an email, not a session. It also listed 4 more asks that session read as still waiting that the hand-kept list didn't have.

These figures came from the first version, before question-tool and plan-approval asks were listed without waiting out the quiet time, so the ask count may differ now. They are also in-sample: the ask rule's cues were written while reading the same week's logs they were checked on, so they say how well the rule fits that week, not how it does on the next.

The stalled-promise rule (`--promises`) is off by default: on the same week it listed nothing extra, and how often it's right hasn't been judged. A hand-judged sample of 30 rows from a later week, scored by me, is still to do before any rule's precision is quoted as a number.

## Implementation detail

- `lib/waiting.mjs`: `findWaiting` over a history `buildWorkHistory` made with `scope: 'all'` and `hiddenSessions: 'redacted'` (the page's redacted build); `askOf` and `promiseOf` are the text rules; `prStates` reads the `--prs` file, then `landedPr` for configured, non-display repositories; `refsContaining` and `hasRemoteBranch` (in `lib/git.mjs`) answer the unpushed check.
- `lib/app-sessions.mjs`: `readAppSessions` reads `cliSessionId`, `title` and `isArchived` from `local_*.json` two folders under the app's `claude-code-sessions` folder; `HONESTWEEK_APP_SESSIONS` names another folder.
- `lib/ask-waiting.mjs`: the command's options, JSON shape and text form. `lib/view/data.mjs` exposes `waiting()` over the redacted build to this process only; no data route answers it.
- Tests: `test/waiting.test.mjs`.
