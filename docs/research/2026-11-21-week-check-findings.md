# Running the checks over one real week: what they found, what was real, and what I fixed

## In plain terms

honestweek reads the logs of my AI coding sessions and points at moments where an agent did something known to go wrong. On 21 November 2026 I ran it over the week of 9 to 15 November and then read the logs behind what it said, one finding at a time. Of the 36 findings it marked worth a look, 21 were real readings of the log, 8 were false alarms or carried the wrong label, and 7 I couldn't settle from the log. Only one of the 36 was an agent's mistake, and a small one.

The most useful result was about what it didn't say. Its two checks for "says it works when it doesn't" reported nothing all week. I checked that by hand and found no false claim, so the silence was right. But the check had been unable to read 49 of the week's 83 test runs, 16 of them because the test runner printed its result in colour. So it was right partly by luck. That's fixed, along with five false alarm patterns.

The agent mistakes I did find by reading were ones no check here looks for. They're written up below, because they're the honest picture of the week.

## How to read the labels

- **measured**: counted directly, by honestweek or by a script of mine over the same logs, and I say which.
- **derived**: worked out from measured facts by a rule I state.
- **assumed**: not checked. I say so.

Sessions are named by the short key honestweek prints for them. Quoted lines are copied from the logs. The repositories are private, so they aren't named here.

## What I ran

The command in [docs/checking-a-week.md](../checking-a-week.md), unchanged, on `main` as of the November rules update.

| What | Count | Label |
|---|---|---|
| Sessions in the logs with a record that week | 66 | measured (my script, from the same history) |
| Of those, in a repository my config lists, so checked | 34 | measured (honestweek) |
| Tool calls read | 3,374 | measured (honestweek) |
| Findings | 71 | measured (honestweek) |
| Findings marked worth a look | 36 | measured (honestweek) |
| Known problems found, checked and clear, not checked | 12, 10, 19 | measured (honestweek) |

These match the first run of the same command on the same day. The 32 sessions in unlisted or display-only repositories weren't checked, and nothing below speaks for them.

## The 36 findings worth a look, judged

Real means the log shows what the finding says. It doesn't mean the agent did something wrong.

| Problem | Worth a look | Real | False alarm or wrong label | Can't tell | Label |
|---|---|---|---|---|---|
| Cache missed | 18 | 18 | 0 | 0 | measured |
| Edits outside the session's folder | 5 | 2 | 3 | 0 | measured |
| Re-reads the same unchanged file | 2 | 0 | 2 | 0 | measured |
| The same tool error again | 2 | 1 | 1 | 0 | measured |
| Stops before the work is done | 1 | 0 | 1 | 0 | measured |
| Large tool output | 3 | 0 | 1 | 2 | measured for the one, assumed for the two |
| Thinks more than the task needs | 3 | 0 | 0 | 3 | assumed |
| Too many small sub-agents | 2 | 0 | 0 | 2 | assumed |
| **Total** | **36** | **21** | **8** | **7** | derived (the rows added up) |

**Cache missed (18 real).** I compared every finding with the token counts the log records for the model call it names. In 17, a call wrote about as many tokens to the cache as the finding states (within 600) while its cache read fell from the call before. In the 18th the tokens were sent uncached, which is the same cost. Seventeen came after a pause longer than the cache lasts, the longest 42 hours. One came after 4.8 minutes on a 5-minute cache, and honestweek says plainly that the cause isn't recorded. None is an agent's mistake: they're what it costs to come back to a session later. Two also followed me switching model, which honestweek doesn't mention.

**Edits outside the folder (2 real, 3 false alarms).** Three were a hand-over note written to the desktop app's shared notes folder, which is where a session is told to leave one. Two were edits in a second checkout of the same repository, sitting beside the first. Those are real and expected, though honestweek calls the place "elsewhere" when it could know better.

**Re-reads (2 false alarms).** One was a background job's output file, read three times in 70 seconds while the job was still writing it. The agent said "The model scan just finished, so I'm reading it now." The other was a chart image read again after each command that drew it again. In both, the file had changed, with no edit on record.

**The same tool error again (1 real, 1 false alarm).** The false alarm was two file searches sent together in one go that both timed out. Neither was a retry: the second started 0.4 seconds after the first, 20 seconds before either came back. The real one is the week's one agent mistake among the 36: a reviewing sub-agent tried three times in six seconds to write a script through the shell, hit the same syntax error each time, then said "I'll use the Edit tool instead."

**Stops before the work is done (1 false alarm).** I typed a question and interrupted it myself six seconds later. The log records the interruption as mine.

**Large tool output (1 wrong label, 2 can't tell).** One finding was marked worth a look while its own note said the result was "re-read by 0 later calls ... about 0 tokens". It cost nothing. For the other two I didn't recount the tokens, and whether the agent needed the whole file isn't something the log says.

**Thinks more than needed, and small sub-agents (5 can't tell).** The model's thinking isn't in the log, so "more than needed" can't be judged. The small sub-agents were review passes ("Plan review", "Fresh review"), started with a fresh context on purpose. I didn't recount either check's numbers.

## The 35 routine notes, sampled

I opened all 27 notes from the risky-command check. Each command holds what the rule says it does: 15 delete a branch, 10 delete a folder, one prints part of the environment and one installs a package. All 27 are routine (branches deleted after a merge, temporary folders removed). The other 8 notes I didn't open. Labels: measured for the 27, assumed for the 8.

## Was the claim checks' silence right?

The two claim checks look for a turn that ends by saying the work is done or the tests pass, when no check ran after the last edit or the last check failed. They found nothing. Here is what I found reading the same turns.

| What | Count | Label |
|---|---|---|
| Test runs in the week | 83 | measured (honestweek) |
| Runs honestweek could read a result from, before the fix | 34 (23 passed, 11 failed) | measured (honestweek) |
| Runs it couldn't read | 49 | measured (honestweek) |
| Of those, runs whose output had a plain summary once colour codes were removed | 16 | measured (my script) |
| Unread runs whose output showed a failure or an error | 12 | measured (my script) |
| Turns with at least one failed run, read or unread | 8, in 6 sessions | measured (my script, then read by hand) |
| Success claims in those turns that came with no passing run before them | 0 | measured (read by hand) |

So the silence was right. In all 8 turns, every message I found that said tests pass came after a run that did pass. Two examples of what the agent said straight after a failure: "Two test expectations were worded too narrowly (the guard's behaviour is right); fixing those and rerunning." and "The first check run exited with a failure, most likely because I edited the list file while it ran (it was briefly invalid)."

But the check couldn't see most of the evidence. A test runner told to print in colour puts colour codes inside its summary line, and honestweek's reader wanted the plain line. One run that week ended `Tests  1 failed | 1873 passed (1874)` in colour and was read as no result at all. Had the agent then claimed success, the check would have missed it.

Two limits remain after the fix, and I haven't closed them:

- **35 runs are still unread** (measured, honestweek, after the fix). Most write their output to a file, and a later command prints only each step's exit code. I read the ones in the 8 turns above by hand, not all 35.
- **The check reads only a turn's last message.** A long turn can hold a dozen "tests pass" messages. I read every one in the 8 turns with a failed run, not those in turns where no run failed.

## What the agents got wrong that no check looks for

These came from reading the logs, not from a finding.

**1. "All tests pass" was true for one day.** On 10 November a session finished a change and said "All 2,178 tests pass with the independent review's fixes." The log shows that run: 2,178 passed. The change added a 24-hour limit, and its tests used fixed dates. On 11 November a different session ran the same tests on the untouched main branch and got `Tests  34 failed | 60 passed (94)`. Its words: "The guard test is a time bomb: its fixture timestamps are fixed, and the 24-hour relay limit from yesterday's merge-guard change now expires them. It will fail CI on any PR, so I'll fix it here." It fixed the tests in its own pull request, and a reviewer then had it shift the test clock instead of freezing it. honestweek didn't catch this and couldn't: the claim was true when it was made. It was caught by a session that ran the whole suite before starting its own work, and checked main when something it hadn't touched failed.

**2. A commit made on the wrong branch, three times in one repository.** On 12, 14 and 15 November (Pacific time), three sessions sharing one checkout each committed while it was on the main branch, not their feature branch. The push then reported nothing new, and opening the pull request failed with "aborted: you must first push the current branch to a remote, or use the --head flag". One session's words: "My commit landed on local `main` instead of the feature branch: something switched the checkout mid-session. Nothing reached the remote `main`. Moving the commit back onto its branch now." Each session noticed within a minute and moved the commit. Nothing wrong reached the remote. honestweek has no check for it. I found no further case in the 12 logs from that repository since 16 November (measured), so I filed nothing there.

**3. A review verdict that said a reviewer never reported.** On 9 November a session posted its review verdict on a pull request before the fifth reviewer had answered, and the verdict said that reviewer never reported. When the reviewer did answer, the session wrote: "I corrected the verdict comment on the pull request, which had said that reviewer never reported." Caught by the session itself, fixed in place.

## What I changed in honestweek

Each has a test that fails without the change.

| What was wrong | The change | Effect on this week (measured, honestweek) |
|---|---|---|
| A test result printed in colour wasn't read | Colour codes are removed before a summary is read | Runs read went from 34 to 48 of 83. Turns with a readable check went from 12 to 18 |
| A test file that failed to load, with no tests run, read as no result | It reads as a failed run | 2 runs |
| A note in the app's shared notes folder was "worth a look" | That folder is a routine place, like a temporary folder | 3 findings became routine notes |
| A running job's output file, or an image drawn again, counted as an unchanged re-read | Job output files aren't compared. An image starts over at each command that could have drawn it | 2 findings gone |
| Two calls sent together that failed the same way counted as a repeat | A call sent before the earlier error came back isn't a repeat | 1 finding gone |
| A large result that nothing carried was "worth a look" | It's a routine note | 1 finding became a note |
| My own interruption read as the agent stopping early | It's a routine note, and says it was mine | 1 finding became a note |

After the changes the same week gives 68 findings, 28 worth a look (measured). The claim checks still find nothing, now over 48 runs.

## What this doesn't show

- How often any check is right in general. This is one week, 34 sessions, one person's logs.
- Anything about the 32 sessions that weren't checked.
- Whether the seven findings I marked "can't tell" are real.
- Whether a false claim sits in a turn where no test run failed. The claim checks cover that shape, and I didn't re-read those turns by hand.

## Implementation detail

- The run: `node --max-old-space-size=12288 bin/honestweek.mjs problems --from 2026-11-09 --to 2026-11-15 --json`. No `windowNote`, so all seven days loaded.
- My scripts built the same history the command builds (`buildWorkHistory` with `usage` and `keepRaw`), then listed each step, message and recorded output. They read only; they aren't in the repository.
- Colour codes: `plainOutput` in `lib/replay/classify.mjs`, used by `parseTestSummary` and where a read-back counts summary lines in `lib/replay/parse-common.mjs`. The failed-to-load case is vitest's `Test Files  1 failed (1)` above `Tests  no tests`.
- The shared notes folder: `SHARED_NOTES_DIR` in `lib/problems/checks.mjs`, a `Claude/side-session-notes` folder in the path. The rule text is `problems.outside-folder`.
- Re-reads: `unrecordedChange` in `lib/problems/classify.mjs`, with the new rule `problems.unrecorded-change`. A job output file is `tasks/<id>.output`. A rendered file is a png, jpg, jpeg, gif, webp or pdf.
- Calls sent together: in `repeatedToolError`, an error whose call started before the earlier error's result came back doesn't extend the run.
- Large output: `contextAdditions` marks a finding a note when no later call re-read the result.
- Interruption: `sessionEndedMidStep` marks a note when the last record is an `interrupt` whose actor is the person.
- Tests: `test/replay-units.test.mjs` and `test/problems-checks.test.mjs`. `problems --json` on the demo week changes only in its rules table, so two pinned answers in `test/review-hooks.test.mjs` were pinned again.
- Cache check: for each finding, the model call within 40 lines of the cited line whose `cache_creation_input_tokens` is within 600 of the stated figure, with `cache_read_input_tokens` below the call before.
