# The work-history engine

## In plain terms

The work-history engine reads my local AI coding session logs and rebuilds what happened as a timeline I can replay to any moment and drill into, from a week down to the single log line behind each step. Every step it shows carries a tag saying how it's known: a log line says so, it was computed from log lines, a named rule interpreted it, or the evidence I'd expect is missing. It never invents working time, a count of agents "working", a cause, or a reason. It doesn't change any report honestweek already makes, and it has no screen of its own yet: a small developer tool prints each level so the model can be checked before a visual design is chosen.

## What it's for

honestweek's reports say what landed. This engine is the layer under a future replay view that shows how it got there: the prompts, the sub-agents an agent started, the commands it ran, the tests, the interruptions, and what git says happened to the result. The visual layer is a separate decision; the engine only promises a complete, checkable model to draw from.

A few terms used below:

- The **harness** is the program that runs an AI agent and writes its log: Claude Code or Codex.
- A **session** is one conversation log file. A **sub-agent** is a helper an agent started; Claude Code writes its transcript beside the session, and Codex writes a separate log (a **child thread**) that names its parent.
- A **turn** runs from a prompt (or a notice that wakes the agent) to the next one.
- A **thread** is a group of sessions the records themselves connect: a resumed session that copies an earlier one, or a message one session sent to another.
- A **hook** is a script the harness runs at set points, such as before a command or at the end of a turn. Some hooks refuse a step.
- **Compaction** is the harness shortening the conversation it sends to the model when it grows too long.
- A **reference** points at the exact bytes of one log line and carries a fingerprint (a digest) of them, so drilling down re-reads that line and refuses to show it if it changed.

## The four evidence levels

| Level | Meaning | Example |
| --- | --- | --- |
| recorded | A log line or git says it directly. | A tool call, its result, a git commit's date. |
| derived | Computed from recorded values only. | Time between a call and its result; lines added in a recorded patch; a pass/fail count read from a test runner's printed summary. |
| inferred | A named rule interpreted a record, and could be wrong. | Calling a prompt a correction; calling a command a test run; treating a session as started from another's task suggestion; reading a commit id from printed output. |
| missing | Evidence I'd expect is absent. | A call with no recorded result; a sub-agent whose starting call is in no log. |

Every step stores the four apart, and building a history fails if a step has no reference or names a rule that isn't registered.

## What it reconstructs

- **People's input.** Typed prompts, prompts typed while the agent was busy (and whether they were delivered at the next turn or absorbed mid-turn), slash commands, answers to questions, plan rejections and their feedback, rejected tool calls, and interruptions. Labels like correction, approval, and question are inferences from narrow rules; the correction rule uses the same patterns the weekly digest already uses.
- **Sessions, agents, and delegation.** The main agent, each sub-agent with its type and description, who started whom (from the starting call's id), and when each finished (from the call's result or a completion notice). Codex child threads join their parent's session. Messages between sessions link when the sender's recorded message id matches the receiver's.
- **Steps and their outcomes.** Each tool call with its recorded result, edits with line counts, test runs with parsed summaries, refusals by hooks and permission rules, API errors, compaction, and mode changes. A test command that was rejected, refused, or interrupted isn't counted as a test run. Git then says whether each commit a session mentions exists, who authored it, whether it reached the default branch, and when each pull request's commit landed. Claude Code usually records its own commits and pull requests; Codex doesn't, so for Codex, and for any Claude Code command the harness didn't record, a commit or pull request is read from what the command printed, which is an inference and is tagged as one.
- **Time.** Spans of recorded activity, harness-recorded durations (labelled as the harness's own measurement), queued-message waits, calls still awaiting a result, open sub-agent spans, and quiet intervals (no records for a while, never called idle).

Replay is deterministic: the same logs and repository state always build byte-identical output, and the state at any moment has one answer. Seeking jumps to a time or steps forward and back one record at a time. Snapshots every 512 points keep a seek fast on a long history, and the tests prove a snapshot seek equals a full replay. The timeline and the summaries share one definition per counted thing, and a test checks that they agree on every one.

## How the real example was used

I built and checked the model against one substantial real session on the build machine in this repository: a recorded span of about eight hours from its first record to its last, gaps included, with 13 typed prompts, four sub-agents, 446 tool calls, a call the harness later marked as never having a recorded result followed by a prompt asking it to continue, and three pull requests. The developer tool's `walk` command drilled from the week overview to that thread, its session, its busiest turn, one event of each kind, and the original log line behind each, then scrubbed the thread's time span. All 27 checks passed, and every sampled line re-read with a matching digest. That run stays on the machine; no session content is in this repository, and the tests use a synthetic corpus with the same record shapes.

What that session showed, as the engine reports it: 13 prompts (recorded), 1 approval (inferred), 1 interruption (the harness's record that a call's result was never written), 4 sub-agents with recorded parents (3 finished by a notice, 1 by its call's result), 64 edits across 29 files (derived), 41 test runs (inferred; 28 all passed, 9 with failures, 4 with no parsed summary, so missing), 1 call refused by a hook, 2 commits that git confirms exist and were authored by me (neither on the default branch itself), and 3 pull requests that git says landed.

## Source coverage

Counts were measured on the build machine on 2 October 2026 by a content-free survey: 3,892 Claude Code session files, 5,821 sub-agent transcripts reachable from them, 1,565,290 records (15 unparsable), and the 250 most recent of 3,634 Codex logs (107,051 records). They show how often each record shape occurs, not how much work happened. Record names in the tables are the logs' own type names.

### Claude Code

| Record | Becomes | Evidence | Seen |
| --- | --- | --- | --- |
| user text with origin human | prompt | recorded | 5,670 |
| user text without an origin (older logs) | prompt | authorship inferred | not counted separately |
| user text with origin task-notification | notification, linked to the agent or task it reports | recorded | 3,058 |
| user text with origin peer or coordinator | agent-message, linked to the sender by message id | recorded | 1,249 |
| "[Request interrupted by user]" | interrupt by the person | recorded | 399 |
| tool_use | action, with a category from the tool name | recorded | 347,900 |
| tool_result | completes its call: result, refusal, rejection, interruption | recorded | 498 calls had no result later in the same file (a resumed copy can count one call twice) |
| result with a denial kind | guard (permission-rule 363, automode-blocked 358, automode-unavailable 35, cancelled 4), decision (user-rejected 59), interrupt (16) | recorded | 835 |
| thinking | nothing | excluded: private reasoning | every session |
| text | message | recorded | |
| queue-operation | queue: typed while busy, delivered or absorbed | recorded; wait derived | 36,809 |
| attachment queued_command | prompt or notification delivered mid-turn | recorded | 5,712 |
| attachment edited_text_file | external-edit (who changed it is not recorded) | recorded | 3,010 |
| attachment hook records | hook, or guard when it blocked | recorded | 5,010 |
| system stop_hook_summary, turn_duration | turn-end, with the harness's duration | recorded | 9,808 and 1,198 |
| system api_error, compact_boundary | error, compaction | recorded | 110 and 37 |
| pr-link | link to a pull request; its time is when it was written | recorded | 25,927 |
| custom-title, ai-title, agent-name | session and agent names | recorded | |
| mode, permission-mode, worktree-state, relocated | mode | recorded | 35,038 |
| sub-agent meta file | agent type, description, starting call | recorded | 4,853 name an Agent or Task call in the parent file; 968 name a call that isn't one (some were started by other tools) |
| compaction and away summaries | nothing | excluded: model-written | 37 and 3 |
| reminders, tool listings, instructions, and other context attachments | nothing | ignored, counted per run | 214,337 of the 228,130 attachments |
| file backups, bridge and cost bookkeeping | nothing | ignored, counted per run | |

### Codex

| Record | Becomes | Evidence | Seen (250 logs) |
| --- | --- | --- | --- |
| session_meta | session, and what started it: the editor or app, a non-interactive run, a parent thread, or the approval reviewer | recorded | 250, among them 24 from the editor, 22 non-interactive, and 13 from the reviewer |
| message, role user | prompt; harness context dropped; in a child thread, its instructions | recorded; authorship inferred in non-interactive sessions | 4,246 messages |
| message, role assistant | message; a turn written in both formats counts once | recorded | |
| function_call, custom_tool_call and outputs | action and result; exit code when printed; commits and pull requests read from printed output | recorded; nominations inferred | 12,323 calls |
| spawn_agent output, child's session_meta | a sub-agent link confirmed from both ends | recorded | 167 spawns |
| wait_agent, sleep, wait | action in the wait category, with its recorded span | recorded | 993 |
| agent_message | agent-message between agents | recorded | 1,799 |
| task_complete, turn_aborted | turn-end with duration; interrupt with Codex's own reason word | recorded | 644 and 4 |
| compacted | compaction | recorded | 53 |
| reasoning | nothing | excluded: private reasoning | 12,939 |
| token counts, world state, settings, timing echoes | nothing | ignored | |

### Git

Commits the harness recorded, or that a successful commit command printed (an inference), are looked up in the session's own repository. Pull requests are matched by number only when the record names the same repository as the configured repo's remote. Display-role repositories and sessions outside the configured repos are never passed to git.

## Messy records

- **Clocks.** Event time is the record's own timestamp. The survey found 87,486 records stamped earlier than the latest stamp above them in the same file, by up to 2.9 days. Of the 59,816 such steps of more than a minute in session files, at least 92% (55,138) came right after a pull-request link or queue record had set that latest stamp, which fits those records being stamped out of band and resumed sessions copying older records below fresh ones; the survey can't say which record holds the wrong time. So the engine doesn't force time forward, and pull-request links and queue records never set a session's span or quiet intervals. Only recorded cause and effect constrains time: a result can't precede its call, and a sub-agent can't act before its starting call. A violation is kept as an anomaly with its size, and only the later event moves.
- **Duplicates.** 109 session files begin with a record that appears in an earlier file (a resume or fork copies history and keeps the record ids). Each copied record is counted once, and the two sessions join one thread. Which copy is the original is a named rule (the one whose file ends first). When the copy recorded a call's result that the original never did, the result, and everything it links to, moves to the kept call. A Claude Code reply split across several records is one message. A Codex turn written in two formats is one turn.
- **Incomplete sessions.** 216 transcripts hold at least one call with no result later in the same file. The engine never says a session "ended": it reports what the last record was, and a call with no result stays open on the timeline, marked as never recorded. A cut-off last line is counted and skipped.
- **Interruptions.** A person pressing stop, a turn limit, a Codex turn the harness aborted, and the harness's later note that a call's result was never written are separate interrupt events. Codex records its own reason word, not who stopped the turn, so the engine doesn't say who did.
- **Privacy.** Every string is redacted before it reaches an event, including the keys of records that key values by free text. File paths keep only directory shape and extension. Sessions outside the configured repos are left out; with scope `all`, they and display-role sessions appear as skeletons that keep the kind of each step, its time, its tool category, and whether it succeeded, never text, paths, commit ids, pull-request numbers, or counts. Drilling into one shows the record's top-level shape only. Nothing is sent anywhere.
- **Size.** Files are streamed, and a record over 8 MB is skipped and reported. A file's first and last timestamps are found by reading as far as needed, since one record can be larger than any fixed window (on the build machine, 20 of 3,897 session files have their first timestamp past their first 64 KB). Files not written since two days before the window are skipped without opening: a log is appended as work happens, so it can't hold a later record. Modification time is never used as evidence of when work happened, because 937 files on the build machine share one modification date from a bulk copy. On the real machine a two-day window built in under 3 seconds; a synthetic 12,000-call session builds and answers 2,000 seeks within the test's limits.

## What it can't reconstruct yet

- **Working time.** Logs record moments, not effort. Gaps between records aren't working or idle time, so the engine reports recorded spans, the harness's own durations, and quiet intervals, never active hours.
- **Why.** A reason exists only where a person or agent wrote one in a prompt or message. Private model reasoning is excluded by design, so a decision without a written reason shows no reason.
- **Approvals that weren't refusals.** In normal permission mode, a tool call the person approved looks the same as one a rule allowed. Rejections are recorded; approvals aren't.
- **Who edited a file outside the agent.** The harness notes the change, not whether the person or another program made it.
- **Sub-agents whose starting call isn't in the logs read.** 968 sub-agent metadata files name a starting call that isn't an Agent or Task call in their parent file. The engine links any call id it finds, so some of these do link; how many stay unlinked wasn't measured. The rest appear with the missing link marked.
- **Several inline sub-agents in older logs.** Before sub-agents got their own files, their records sat inside the session file without an id, so they collapse into one marked agent that may stand for several.
- **Which repository a commit belongs to** when a command changed directory first. The engine says the commit isn't in the session's repository rather than guessing.
- **Commits a quiet command never printed.** When the harness didn't record a commit and the command printed no commit id, git isn't asked about it.
- **Pull-request reviews and CI.** The engine reads no network service, so review comments, approvals on GitHub, and CI results are absent. It knows what the session recorded and what local git has.
- **Clock differences between machines.** Skew is detected only along recorded cause and effect inside the logs it reads.
- **Hand-offs without a recorded id.** A session started from another's task suggestion is linked only when its first prompt matches the suggestion exactly, and that link is an inference kept outside the thread. Hand-off documents written by one session and read by another aren't linked yet.
- **Abandoned approaches** beyond what's explicit: a rejected plan, a refused or rejected call, a revert command, a stopped background task, an interruption, or a correction. The engine doesn't guess that a sequence of steps was an abandoned attempt.
- **Plan lists over time.** To-do and task updates are captured on each call, but not yet folded into a plan timeline of their own.
- **Codex edits made inside shell scripts,** which can't be told apart from other shell work, and whether Codex's patch tool succeeded, which isn't parsed. Whether a person or a script wrote a non-interactive Codex session's prompt is an open question for the repo, so those prompts are tagged as inferred.
- **Anything older than the retention window.** Claude Code deletes transcripts after its cleanup period, so nothing before the oldest file exists to reconstruct.
- **Claude desktop local-agent sessions,** which the miner reads, aren't read here yet.

## Trying it

From a clone of this repository (the developer tool isn't in the published package):

```bash
node tools/replay-inspect.mjs --config honestweek.config.json --from 2024-06-10 --to 2024-06-16 walk
```

`overview`, `thread`, `session`, `turn`, `event`, and `record` print one level each; `at` and `step` scrub time; `coverage` lists every record type seen in the run and how it was handled; `--json` prints the same data as JSON. The tool writes nothing to disk and redacts everything it prints.

## Implementation detail

- `lib/replay/index.mjs`: `buildWorkHistory({ config, from, to, timezone, roots, scope, quietMs, git })` returns the history: `sessions`, `agents`, `threads`, `events`, `links`, `anomalies`, `coverage`, plus `stateAt(t, { thread })`, `timeline` and `threadTimeline(id)` (`cursorAt`, `step`, `seekWhere`, `stateAtCursor`), the views `overview()`, `thread(id)`, `session(key)`, `turn(id)`, `event(id)`, and `record(eventIdOrRef)`. `toJSON()` is deterministic and holds no file paths.
- Each event keeps `facts` (recorded), `derived`, `inferred` (each with its rule id), and `missing`; `lib/replay/evidence.mjs` holds the contract, checked on every event before a history is returned.
- `lib/replay/sources.mjs` finds files by the timestamps inside them; `claude.mjs` and `codex.mjs` parse one file each in file order, sharing `parse-common.mjs`; `assemble.mjs` de-duplicates, links, applies the clock rules, and builds turns and threads; `outcomes.mjs` asks git through `lib/git.mjs`; `timeline.mjs` folds points with snapshots; `views.mjs` renders the drill-down; `metrics.mjs` defines each counted thing once for both; `classify.mjs` holds every inference rule (`RULES`) and the parsers; `ids.mjs` makes ids from SHA-256 spelled in the letters a to p, so the redactor never alters them; `jsonl.mjs` reads lines with their byte offsets.
- Non-interactive Codex runs are `codex exec`; Codex's patch tool is `apply_patch`.
- Tests: `test/replay-model.test.mjs`, `test/replay-timeline.test.mjs`, `test/replay-units.test.mjs`, `test/replay-harness.test.mjs`, the clean-room fence in `test/site-cleanroom.test.mjs`, over the synthetic corpus in `test/fixtures/replay/corpus.mjs`.
