# The demo week

## In plain terms

The demo week is a made-up week of AI coding sessions that I generate on demand, so anyone can try the work-history engine, and the page that sits on top of it (`honestweek view --demo`), without their own session logs. One command writes the session logs, the small git repository those sessions worked in, and a goal record into a folder. Everything in it is invented and fixed: a command-line tool called lantern, the author you@example.com, and the same timestamps and commit ids on every run. The tests build it and check that the engine reads it the way this page says.

## Running it

The quickest way to look around it is the page:

```bash
node bin/honestweek.mjs view --demo
```

That builds the week in a temporary folder, serves only it on `127.0.0.1`, and deletes the folder when you stop it. For that run it also treats the made-up project name, lantern, as a private word, so the page's Show private text switch has something to show. To write the week into a folder you keep:

```bash
node tools/demo-week.mjs ./.demo-out
node tools/replay-inspect.mjs --config ./.demo-out/honestweek.config.json --claude-root ./.demo-out/claude/projects --codex-root ./.demo-out/codex/sessions --from 2025-03-10 --to 2025-03-16 walk
```

The first command needs a folder that's empty or doesn't exist yet, and prints the paths and the date range as JSON. `.demo-out/` is ignored by git. If the build fails partway, it removes what it wrote and says so. On Windows, keep the folder path short: on the machine I built this on, git failed once the folder path passed about 175 characters (173 worked, 181 didn't), and the error says when that's the cause. The second runs the engine's developer tool, described in [the work-history engine doc](work-history-engine.md), which drills from the week down to single log lines and checks each level. Swap `walk` for `overview`, `thread <id>`, `session <key>`, or `at <time>` to look at one level, and add `--scope all` to include the session outside the configured repos. Times print in UTC, the timezone the demo's config sets.

Code can build the same folder directly and hand it to the engine; the last section says how.

## What the week contains

A few terms first. A **session** is one conversation log file from Claude Code or Codex (the two programs that run an agent and write its log). A **thread** is a group of sessions the records themselves connect, such as a resumed session and the one it continues. A **sub-agent** is a helper an agent started; in Codex it's a separate log called a **child thread**. A **worktree** is a second checkout of the same repository on its own branch, here inside the lantern folder. A **display-only** repository is configured with the role `display`: it can appear in reports, but honestweek never runs git against it, and the engine shows its sessions as **skeletons** that keep the kind and time of each step and drop its content. A **task suggestion** is a chip one session offers for starting a new session with a prepared prompt. A **goal record** lists goals and the **goal events** that changed them, each with an id like `gev-3k9a`.

The project is lantern, which turns a CHANGELOG.md into release notes. Its remote is `github.com/example/lantern`. The week runs Monday 10 March to Sunday 16 March 2025, all times UTC.

| When | Tool | Where | What happens |
| --- | --- | --- | --- |
| Mon 09:02 | Claude Code | lantern | Adds a `--since` flag. Two Explore sub-agents read the parser and the flag handling at the same time. A test fails, then passes. A message I type while the agent is busy waits for the next turn. Opens #12, and after a quiet hour squash-merges it and records goal event `gev-3k9a`. |
| Mon 14:05 | Codex | lantern | Makes wrapping measure display width. A child thread writes test fixtures while the main thread patches the code. A test fails, then passes. Opens #13 and records `gev-7m2q`. |
| Tue 09:20 | Claude Code | a worktree | Merges #13 and marks the wrap goal done (`gev-d4h5`). Starts grouping entries by scope. I interrupt and correct course. A general-purpose reviewer runs in the background and finds two edge cases. A message I type mid-turn is absorbed. The session stops while a test run is still waiting for its result. |
| Thu 09:05 | Claude Code | the same worktree | Resumes Tuesday's session, and Claude Code records the cut-off test run as interrupted. A hook refuses a force-push, so the fix goes in as a new commit. Opens and merges #14 (`gev-9p4x`), then suggests a JSON output task and creates a goal for it (`gev-b6t1`). |
| Fri 09:30 | Claude Code | a second worktree | Starts from that suggestion. An Explore sub-agent maps where output is written. Opens #15 and notes it on the goal (`gev-c2w8`), then stops while watching CI, a call that never gets a result. |
| Fri 13:31 | Codex | the second worktree | Makes #15 run on Node 18. A test fails, then passes. Pushes a commit; #15 stays open. |
| Fri 18:10 | Claude Code | personal-site, display-only | Drafts a post about the release. |
| Sat 10:02 | Claude Code | lantern | Looks up the week's goal events. It names their ids but writes none. |
| Sat 16:04 | Claude Code | a folder outside the configured repos | Renames some screenshots. |

Wednesday and Sunday are quiet, and Tuesday 11:00 to Thursday 09:05 is the longest gap.

### As the engine reads it

These are the counts the demo's tests check, from the default view, with the `--scope all` figure in brackets where it differs:

- 8 sessions (9), 6 from Claude Code and 2 from Codex, in 7 threads, on 5 days. Tuesday's and Thursday's sessions form one thread, because the second copies the first's records.
- 24 typed prompts (26), between 2 and 5 per session. One is labelled a correction and one an approval, both by the engine's labelling rules, so both are inferences.
- 5 sub-agents: 3 Explore, 1 general-purpose, and 1 Codex child thread, each tied to the call that started it.
- 112 tool calls (115), including 29 edits and 13 test runs: 10 passed and 3 had failures. The run cut off on Tuesday isn't counted, because it never ran to a result.
- 2 interruptions (one by me, and one Claude Code recorded on Thursday for the call Tuesday's session never finished), 1 hook refusal, 1 call with no result, and 5 quiet intervals inside sessions.
- 4 pull requests. #12, #13, and #14 were squash-merged into main by you@example.com, and #15 is still open. 8 commits on feature branches, all authored by you@example.com.
- 1 inferred hand-off, from Thursday's task suggestion to Friday's session.

The display-only session appears as a skeleton in both views, and the outside session appears as one only with `--scope all`. Neither shows text, paths, or commit ids, and git never reads the display-only repository.

### The goal record

The week also writes a goal record next to the logs. It holds three goals: `release-1-4` (active), `wrap-every-script` (done), and `json-output` (active). Each goal names where it came from and carries notes, and each citation is a pull request (written `lantern#12` or as a full pull-request URL) or a session (written `session:` plus the session's file name).

Six goal events changed those goals during the week. In the session that wrote each one, the agent ran `goals.mjs apply`, the command that records a goal event, with that event's id, and the event's time falls between the moment the command started and the moment its result came back. Saturday's session runs the same tool's read-only `list` and `show` commands and a search for two ids, so a goal view can show that reading an id isn't writing it. The engine reads the goal record and joins each goal to the sessions that did its work, and `honestweek view --demo` shows those goals on its goal page; the demo week's tests also check the record against the sessions directly.

### What I left out

- Codex writes no pull-request link records, so #13 has none. The engine reads #13 from what `gh pr create` printed, which it tags as an inference. The three Claude Code pull requests have link records.
- The engine keeps a Codex child thread's type and instructions on the call that started it, not on the sub-agent, and doesn't mark when a child thread finished. So the Codex sub-agent shows no type, description, or finish of its own. The Claude Code sub-agents have all three.
- There's no answered question, plan approval, API error, or compaction. Nothing asked for them, and the engine's own test corpus already covers questions, plans, and compaction.

## Implementation detail

- `lib/demo/week.mjs`: `buildDemoWeek({ root })` writes the folder (a fresh temp folder when `root` is left out) and returns `{ root, roots: { claude, codex }, repo, displayRepo, outsideDir, config, configFile, goalRecord, goalsFile, week, ids, files }`. `repo` is `{ dir, remote, defaultBranch, worktrees, commits }`. Pass `config`, `roots`, and `week.from` and `week.to` to `buildWorkHistory`. It lives in `lib/` so `honestweek view --demo` can use it from the published package. `tools/demo-week.mjs` re-exports it and holds the command line, `main(argv, io)`.
- The goal record, `goals.json`, has this shape:

  ```json
  { "goals": [{ "id": "", "title": "", "state": "", "source": { "ref": "" }, "observations": [{ "source": { "ref": "" }, "note": "" }] }],
    "events": [{ "eventId": "", "goalId": "", "type": "", "at": "" }] }
  ```

  Each event's id appears in exactly one `node $GOALS_DIR/goals.mjs apply --goal <id> --event <id> --type <type>` command, and its `at` is 700 ms after that call starts, inside the 1.4 seconds before its result.
- Folder layout: `claude/projects/<folder>/<session id>.jsonl` with sub-agents under `<session id>/subagents/`, `codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `lantern/` with its worktrees under `lantern/.claude/worktrees/`, `personal-site/`, `scratch/`, `honestweek.config.json` (lantern featured, personal-site display), and `goals.json`.
- Claude Code names a project folder after the full working directory. The demo uses short stand-ins (`-lantern`, `-lantern--claude-worktrees-group-by-scope`, and so on) so session keys, which include the folder name, are the same on every run.
- Record shapes follow `test/fixtures/replay/corpus.mjs`, with new values throughout. `ClaudeLog` and `CodexLog` write one file each, and each refuses to move its clock backwards.
- Git: every commit uses fixed author and committer dates, and each repository is created with no templates, SHA-1 object ids, and local settings that win over any global ones (`LOCAL_GIT_CONFIG`: no signing, UTF-8 commit messages, `-m`'s default message cleanup, no line-ending conversion or global attributes, no hooks, `merge.ff=true` so `--squash` works, long paths allowed, no signatures or color in printed output, no background gc). So commit ids repeat across runs and machines. A squash merge is `git merge --squash` on main with a `(#N)` subject. Commands that print commit ids print the real ones.
- `buildDemoWeek` removes everything it wrote when a step fails, and sets `leftBehind` on the error if that removal fails too. The command line reports the cause, and suggests a shorter folder when git says a path is too long.
- The test builds the week twice and compares every log byte for byte, after replacing the folder path (which Codex call arguments escape twice).
- Monday's Codex commit time was picked, back when the engine read a 12-character commit id made only of digits as an account number, so no commit id in the week is one. The engine now keeps commit ids as they are (`test/replay-commit-ids.test.mjs`), and the test still checks that no outcome's commit id was redacted.
- Tests: `test/demo-week.test.mjs`; the clean-room fence in `test/site-cleanroom.test.mjs` covers the builder, the script, the test, and this page.
