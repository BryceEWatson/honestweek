# The demo week

## In plain terms

The demo week is a made-up week of AI coding sessions that I generate on demand, so anyone can try the work-history engine, and the page that sits on top of it (`honestweek view --demo`), without their own session logs. One command writes the session logs, the small git repository those sessions worked in, and a goal record into a folder. Everything in it is invented and fixed: a command-line tool called lantern, the author you@example.com, and the same timestamps and commit ids on every run. Most of the week is ordinary good work; a few sessions go wrong in the ways the Problems page looks for, so the page has something real to show. The tests build it and check that the engine, and the problem checks, read it the way this page says.

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

The first command needs a folder that's empty or doesn't exist yet, and prints the paths and the date range as JSON. `.demo-out/` is ignored by git. If the build fails partway, it removes what it wrote and says so. On Windows, keep the folder path short: on the machine I built this on, git failed once the folder path passed about 175 characters (173 worked, 176 didn't), and the error says when that's the cause. The second runs the engine's developer tool, described in [the work-history engine doc](work-history-engine.md), which drills from the week down to single log lines and checks each level. Swap `walk` for `overview`, `thread <id>`, `session <key>`, or `at <time>` to look at one level, and add `--scope all` to include the session outside the configured repos. Times print in UTC, the timezone the demo's config sets.

Code can build the same folder directly and hand it to the engine; the last section says how.

## What the week contains

A few terms first. A **session** is one conversation log file from Claude Code or Codex (the two programs that run an agent and write its log). A **thread** is a group of sessions the records themselves connect, such as a resumed session and the one it continues. A **sub-agent** is a helper an agent started; in Codex it's a separate log called a **child thread**. A **worktree** is a second checkout of the same repository on its own branch, here inside the lantern folder. A **display-only** repository is configured with the role `display`: it can appear in reports, but honestweek never runs git against it, and the engine shows its sessions as **skeletons** that keep the kind and time of each step and drop its content. A **task suggestion** is a chip one session offers for starting a new session with a prepared prompt. A **goal record** lists goals and the **goal events** that changed them, each with an id like `gev-3k9a`. A **model call** is one request the agent made to its model; each one records how many **tokens** (the pieces of text a model reads and writes) it read and wrote, and the part it read is its **context**.

The project is lantern, which turns a CHANGELOG.md into release notes. Its remote is `github.com/example/lantern`. The week runs Monday 10 March to Sunday 16 March 2025, all times UTC, and the person behind it is working towards a 1.4 release.

| When | Tool | Where | What happens |
| --- | --- | --- | --- |
| Mon 09:02 | Claude Code | lantern | Adds a `--since` flag. Two Explore sub-agents read the parser and the flag handling at the same time. A test fails, then passes. A message I type while the agent is busy waits for the next turn. Opens #12, and after a quiet hour squash-merges it and records goal event `gev-3k9a`. |
| Mon 14:05 | Codex | lantern | Makes wrapping measure display width. A child thread writes test fixtures while the main thread patches the code. A test fails, then passes. Opens #13 and records `gev-7m2q`. |
| Mon 16:31 | Claude Code | lantern | I ask how entry types and scopes are read, and what happens to a breaking change like `feat(cli)!:`. The agent reads the parser, tries one entry, and answers. No edits. |
| Tue 09:20 | Claude Code | a worktree | Merges #13 and marks the wrap goal done (`gev-d4h5`). Starts grouping entries by scope. I interrupt and correct course. A general-purpose reviewer runs in the background and finds two edge cases. A message I type mid-turn is absorbed. The session stops while a test run is still waiting for its result. |
| Tue 14:10 | Claude Code | lantern | Makes release headings without brackets parse. The test it adds fails, and its last message still opens with "Done." I say commit it, and it commits on that failing run and pushes. Later that afternoon CI is red; it says it misread the run, fixes the parser, and the suite passes. |
| Wed 09:40 | Claude Code | a second worktree | Three hours on a Markdown output mode (`--format md`), checked against five made-up changelogs it reads and renders in full. Its context passes 150,000 tokens at model call 44 of 77 and keeps growing to about 163,000. Early on it changes `wrap()`'s arguments and from then on runs only the tests for the files it's working on. At the end the whole suite fails in the two wrap tests; it commits anyway and calls both failures pre-existing. Along the way it deletes a scratch folder it made with `rm -rf`. |
| Wed 15:10 | Codex | lantern | Writes a CONTRIBUTING.md on its own branch, asks before committing, then commits and pushes. |
| Thu 09:05 | Claude Code | the Tuesday worktree | Resumes Tuesday's session, and Claude Code records the cut-off test run as interrupted. A hook refuses a force-push, so the fix goes in as a new commit. Opens and merges #14 (`gev-9p4x`), then suggests a JSON output task and creates a goal for it (`gev-b6t1`). |
| Thu 11:12 | Claude Code | lantern | CI on main is red on the Windows jobs. The agent saves the whole CI log and reads it in one go (about 23,000 tokens), then skips the failing test with `test.skip` and pushes that straight to main. |
| Thu 13:20 | Claude Code | a third worktree | Writes a release script that uploads the notes to a docs site. My prompt ends with a made-up sandbox token (it has EXAMPLE in it), and the agent puts it in a dry-run command. It starts a background agent to check the README examples, which never reports back. Commits on the branch and creates the `publish-notes` goal (`gev-r5k2`). |
| Fri 09:30 | Claude Code | a fourth worktree | Starts from Thursday's suggestion. An Explore sub-agent maps where output is written. Opens #15 and notes it on the goal (`gev-c2w8`), then stops while watching CI, a call that never gets a result. |
| Fri 13:31 | Codex | the fourth worktree | Makes #15 run on Node 18. A test fails, then passes. Pushes a commit; #15 stays open. |
| Fri 15:05 | Claude Code | lantern | Fills in the changelog's Unreleased section. An Explore sub-agent lists the week's merges; its first line is stamped 45 ms before the call that started it. Seeing my uncommitted notes in CHANGELOG.md, the agent runs `git reset --hard` and discards them, then says so when I ask. I paste them back from my editor; it opens #16 and records `gev-h8n3`. |
| Fri 16:20 | Codex | the third worktree | The real upload fails. I paste the same token again; Codex runs the failing command a second time, unchanged, then explains it's the docs host's example token. It adds a `--token-file` option instead and records `gev-w3j7`. |
| Fri 18:00 | Codex, non-interactive | lantern | A scripted `codex exec` run summarizes the week's changes on main from git history. |
| Fri 18:10 | Claude Code | personal-site, display-only | Drafts a post about the release. |
| Sat 10:02 | Claude Code | lantern | Looks up the week's goal events. It names their ids but writes none. |
| Sat 11:32 | Claude Code, an older version | lantern | An older Claude Code that records no origin on a typed prompt. I ask why `--width 0` puts every word on its own line; the agent answers and then changes the code too. Two edits fail because their old text isn't in the file, it reads the same file three times, and it says "I've fixed it" with nothing run after the edit. Asked to, it runs the tests, which pass. |
| Sat 13:05 | Claude Code, the same older version | lantern | Resumes the late-morning session and commits the `--width` check on its own branch. |
| Sat 16:04 | Claude Code | a folder outside the configured repos | Renames some screenshots. |

Sunday is quiet. No two sessions overlap, and every one falls between 09:00 and 19:00.

### As the engine reads it

These are the counts the demo's tests check, from the default view, with the `--scope all` figure in brackets where it differs:

- 19 sessions (20), 14 from Claude Code and 5 from Codex, in 17 threads, on 6 days. Tuesday's group-by-scope session and Thursday's form one thread, because the second copies the first's records, and Saturday's two older-version sessions form another.
- 50 typed prompts (52), between 1 and 7 per session. Three are labelled corrections and two approvals, by the engine's labelling rules, so all five are inferences. Saturday's three prompts carry no origin, so who typed them is inferred too, and Friday evening's comes from a non-interactive run, so it's "a person or a script".
- 4 sessions switch to accept-edits mode (Monday morning, Tuesday afternoon, Wednesday and Friday afternoon). Claude Code writes that line with no time of its own, so the engine takes its time from the line after it.
- 7 sub-agents: 4 Explore, 2 general-purpose, and 1 Codex child thread, each tied to the call that started it. Thursday afternoon's README check has no completion notice. Friday afternoon's Explore agent stamped its first line 45 ms before its starting call, and the engine moves that line to the call's time.
- 258 tool calls (261), including 58 edits and 28 test runs: 21 passed and 7 had failures. The run cut off on Tuesday morning isn't counted, because it never ran to a result.
- 2 interruptions (one by me, and one Claude Code recorded on Thursday for the call Tuesday's session never finished), 1 hook refusal, 1 call with no result, and 10 quiet intervals inside sessions.
- 5 pull requests. #12, #13, and #14 were squash-merged into main by you@example.com; #15 and #16 are still open. 17 commits, all authored by you@example.com, all on feature branches except Thursday's skipped test, pushed straight to main.
- 1 inferred hand-off, from Thursday's task suggestion to Friday's session.
- Token counts on every model call: about 12.5 million tokens over 303 model calls in the sessions the problem checks read.

The display-only session appears as a skeleton in both views, and the outside session appears as one only with `--scope all`. Neither shows text, paths, or commit ids, and git never reads the display-only repository.

### What the Problems page finds

The Problems page (`docs/local-page.md` describes it) runs its checks over the sessions in configured repositories and gives each pattern it finds a tier by a stated rule. On this week it finds 15 patterns, and the demo's tests pin each one's tier, its counts, and the session of each finding worth a look:

- **High.** A claim that contradicts the evidence, found 4 times by rule: Tuesday's "Done." after a failing run and its commit on that run, and Wednesday's commit on a failing suite and its message calling the failures pre-existing. Context bloat, estimated from the token counts: Wednesday's session past 150,000 tokens with 33 more calls, and by the check's estimate (its early context plus a 5,000-token hand-off brief) about 3.8 million tokens of context a fresh session would not have re-read, 31% of the window's. Secret exposure, found 4 times: the pasted token in Thursday's prompt and command and again in Friday's, plus 1 routine note for Thursday's agent message that repeats it. The page and every answer show the token redacted, including at the very end of Thursday's prompt, where it reads `DOCS_TOKEN=[redacted:secret]` right before the closing quote of the step's description.
- **Medium.** An unverified done claim (Saturday's "I've fixed it"), test tampering (Thursday's `test.skip`), and a destructive command (Friday's hard reset), each found once by rule. The destructive-command card also counts Wednesday's `rm -rf` of the session's own scratch folder as 1 routine note.
- **Low.** A tool failing the same way twice, found twice (Saturday's two failed edits and Friday's Codex upload), the same failing command run again unchanged (Friday's Codex session), one whole-file read that added about 23,000 tokens (Thursday's CI log), a background sub-agent with no hand-back (Thursday), which carries the missing level because the record the check expected isn't in the logs, edits after a question-only prompt (Saturday), and a session whose last record is a call with no result (Friday morning), plus 1 routine note for Tuesday's group-by-scope session, cut off while a test run waited. Small sub-agents, one question answered by a bare go-ahead, and the same file read three times (Saturday) appear only as routine notes. The file is short: each repeat added about 250 tokens, under the 500 the check asks for before a repeat is worth a look.

8 of the 18 sessions the checks read have something worth a look; the other 10 have nothing worth a look, and the display-only session isn't checked. On Wednesday's replay, the "Worth a look" strip shows the context stretch as a band and the commit and the message that follows it as two High marks close enough to merge into a count.

### The goal record

The week also writes a goal record next to the logs. It holds four goals: `release-1-4` (active), `wrap-every-script` (done), `json-output` (active), and `publish-notes` (active). Each goal names where it came from and carries notes, and each citation is a pull request (written `lantern#12` or as a full pull-request URL) or a session (written `session:` plus the session's file name).

Nine goal events changed those goals during the week. In the session that wrote each one, the agent ran `goals.mjs apply`, the command that records a goal event, with that event's id, and the event's time falls between the moment the command started and the moment its result came back. Saturday morning's session runs the same tool's read-only `list` and `show` commands and a search for two ids, so a goal view can show that reading an id isn't writing it. The engine reads the goal record and joins each goal to the sessions that did its work, and `honestweek view --demo` shows those goals on its goal page; the demo week's tests also check the record against the sessions directly.

### What I left out

- Codex writes no pull-request link records, so #13 has none. The engine reads #13 from what `gh pr create` printed, which it tags as an inference. The four Claude Code pull requests have link records.
- The engine keeps a Codex child thread's type and instructions on the call that started it, not on the sub-agent, and doesn't mark when a child thread finished. So the Codex sub-agent shows no type, description, or finish of its own. The Claude Code sub-agents have all three, except Thursday's background check, which never finished.
- There's no answered question, plan approval, API error, or compaction: the demo records none, not even in Wednesday's long session. Nothing asked for them, and the engine's own test corpus already covers questions, plans, and compaction.
- The pasted token, `DOCS_TOKEN=sandbox-EXAMPLE-…`, is made up for a made-up docs host: a credential-named field with a random-looking value, which reads as a secret to anything that looks for one, and no provider's format. I first used AWS's documented example key pair. GitHub's push protection let it through on this repository, but I switched anyway, so the demo doesn't lean on a scanner knowing a vendor's example keys.

## Implementation detail

- `lib/demo/week.mjs`: `buildDemoWeek({ root })` writes the folder (a fresh temp folder when `root` is left out) and returns `{ root, roots: { claude, codex }, repo, displayRepo, outsideDir, config, configFile, goalRecord, goalsFile, week, ids, files }`. `repo` is `{ dir, remote, defaultBranch, worktrees, commits }`. Pass `config`, `roots`, and `week.from` and `week.to` to `buildWorkHistory`. It lives in `lib/` so `honestweek view --demo` can use it from the published package. `tools/demo-week.mjs` re-exports it and holds the command line, `main(argv, io)`.
- `lib/demo/content.mjs` generates the bulky text from fixed seeds: the five made-up changelogs Wednesday's session reads (`driftwood`, `quillpen`, `harbor-config`, `emberline`, `mossbank`, 390 to 730 lines each, under `github.com/example`), a mirror of the Markdown renderer that session writes so what the logs print matches the committed code, the CI log Thursday's session reads, and full TAP reports.
- The goal record, `goals.json`, has this shape:

  ```json
  { "goals": [{ "id": "", "title": "", "state": "", "source": { "ref": "" }, "observations": [{ "source": { "ref": "" }, "note": "" }] }],
    "events": [{ "eventId": "", "goalId": "", "type": "", "at": "" }] }
  ```

  Each event's id appears in exactly one `node $GOALS_DIR/goals.mjs apply --goal <id> --event <id> --type <type>` command, and its `at` is 700 ms after that call starts, inside the 1.4 seconds before its result.
- Folder layout: `claude/projects/<folder>/<session id>.jsonl` with sub-agents under `<session id>/subagents/`, `codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `lantern/` with its worktrees under `lantern/.claude/worktrees/` (`group-by-scope`, `markdown`, `release-script`, `json-output`), `personal-site/`, `scratch/`, `honestweek.config.json` (lantern featured, personal-site display), and `goals.json`.
- Claude Code names a project folder after the full working directory. The demo uses short stand-ins (`-lantern`, `-lantern--claude-worktrees-group-by-scope`, and so on) so session keys, which include the folder name, are the same on every run.
- Record shapes follow `test/fixtures/replay/corpus.mjs`, with new values throughout. `ClaudeLog` and `CodexLog` write one file each, and each refuses to move its clock backwards. A `ClaudeLog` takes a `version`, `origins: false` for a version that records no prompt origin, a `base` context size, and a `pace` that stretches each model call's time.
- Token counts: each log keeps a running estimate of its context, about 3.6 characters a token for everything that went into it, with the demo folder's path read as one short stand-in so the counts don't depend on where the week is written. `buildDemoWeek` resolves the folder first, so on Windows `C:/a` and `C:\a` give the same counts. Claude Code records carry `usage` on every assistant block (input, cache writes, cache reads, output so far); Codex writes a `token_count` after each response. A call reads from the cache what the previous call read when that call was under five minutes earlier (Codex in whole 128-token blocks), and writes it all again after a longer pause.
- Git: every commit uses fixed author and committer dates, and each repository is created with no templates, SHA-1 object ids, and local settings that win over any global ones (`LOCAL_GIT_CONFIG`: no signing, UTF-8 commit messages, `-m`'s default message cleanup, no line-ending conversion or global attributes, no hooks, `merge.ff=true` so `--squash` works, long paths allowed, no signatures or color in printed output, no background gc). So commit ids repeat across runs and machines. A squash merge is `git merge --squash` on main with a `(#N)` subject. Commands that print commit ids print the real ones.
- `buildDemoWeek` removes everything it wrote when a step fails, and sets `leftBehind` on the error if that removal fails too. The command line reports the cause, and suggests a shorter folder when git says a path is too long.
- The test builds the week twice and compares every log byte for byte, after replacing the folder path (which Codex call arguments escape twice).
- Monday's Codex commit time was picked, back when the engine read a 12-character commit id made only of digits as an account number, so no commit id in the week is one. The engine now keeps commit ids as they are (`test/replay-commit-ids.test.mjs`), and the test still checks that no outcome's commit id was redacted.
- The click-through test (`lib/view/selftest/clickthrough.js`) allows only three skips on the demo week (`DEMO_SKIPS`: `built-before-test`, `private-words-set`, `goal-list-set`), since the week holds every other case it looks for; a skip for any other reason fails there. `test/demo-week.test.mjs` checks that those cases sit in the twelve most recent sessions, the ones the click-through's replay steps open.
- Tests: `test/demo-week.test.mjs`; the clean-room fence in `test/site-cleanroom.test.mjs` covers the builder, the script, the test, and this page.
