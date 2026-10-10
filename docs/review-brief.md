# The review brief (`honestweek brief`)

## In plain terms

`honestweek brief` tells whoever reviews a pull request how it was made, from your own session logs and local git. When a fresh agent session reviews a change, it usually sees only the diff and a summary the authoring session wrote, so the session under review decides what its reviewer hears. The brief gives the reviewer the record instead: what was asked, the checks the work's own steps ran and whether they still hold, each claim the agent made next to the check behind it, and what no session explains. It gives no verdict, runs nothing, and reads nothing over the network.

## What it prints

A pull request here means a GitHub pull request in one of your configured repositories, named by its number (`#210`, `your-repo#210`), its address, or its branch (`branch:feature/x`). The text answer stays near 80 lines however large the pull request is, and `--json` lists everything in the `honestweek.brief/1` shape. In order:

1. **The change.** Its latest commit (the head), the commit it starts from (the base), its branch, how many commits and files, and how each was found.
2. **What was asked.** The issue it closes, with that issue's text when a session printed it with `gh issue view`, and your own prompts among its steps. An issue the pull request only mentions is listed as related, never as what was asked.
3. **Sessions behind it.** Which session wrote it and which reviewed it, how many of each one's steps were this pull request's, and which other pull requests the rest were.
4. **Checks its steps ran.** Each test run, build or lint, its result, the folder it ran in, and whether it's current at the head or stale (an edit or an untested commit came after it). Then "Run these yourself": only plain check commands, one test or build runner each, with no chaining, redirect, deletion, download or push. Anything else is listed to read before running.
5. **Claims to check, unbacked first.** Each claim quoted, with the check behind it or the gap: no check after the last edit, a check that ran in another folder, or a claim on the edge of another pull request's work.
6. **Tests and hooks.** Test files it changed, assertions and skips added or removed in their diff, weakened-test findings, commits that skipped hooks, and force-pushes.
7. **Other problems in its steps.** Findings from the Problems checks that a reviewer cares about. Findings in other pull requests' work, cost findings and routine notes are counted under "Left out".
8. **Where you stepped in.** Your corrections, and calls a rule refused or you interrupted.
9. **Changes no session explains.** Commits no session made or printed, and changed files no edit in its steps touched.
10. **What it can't know.** Always printed: CI and GitHub reviews, work outside these logs, Codex hooks, files changed outside the logs, and that how often each check is right isn't measured yet.

Every row says how it's known, with the evidence words honestweek uses everywhere: recorded (a log line or git says so), derived (worked out from recorded facts only), inferred (a named rule's reading, which can be wrong), missing (nothing here can tell), and ambiguous (the facts fit more than one way). An inferred row names its rule, and a row built from several facts takes the weakest of their words. The author agent's own words appear only as quoted claims to check, and `--evidence-only` leaves them out.

## How it finds a pull request offline

It never asks GitHub, so it works the pull request out from git and the logs, and says how:

- **Its head**: the one you give with `--head` (recorded), else the second parent of the merge commit it landed as, else, for a squash merge, the commit a session recorded or printed whose files are exactly what the squash landed, else this machine's copy of its branch. All but the first are inferred.
- **Its branch**: every source is kept (the push a session made before it ran `gh pr create`, that command's `--head`, what `gh` printed, a merge commit's subject). When they disagree, the branch is ambiguous and none is picked.
- **Its base**: `--base` when given, else the squash or merge commit's first parent, else where its branch left the default branch.
- **The issue it closes**: `--issue` when given, else "Closes", "Fixes" or "Resolves #N" in the recorded `gh pr create` body, a commit message, or the landing commit's message. When the body came from a file (`--body-file <path>`) that the same session wrote with its own edit tools, the brief reads it back from those writes and edits. If another session wrote the file or ran a command naming it, or this session ran a command that could reach it by a pattern, a variable or git putting files back, the body isn't known. A change the logs don't show, such as a script that writes the file without naming it, can't be seen. The issue's text is shown only when a session printed it with `gh issue view` and nothing else on that line.

The command `gh pr view N --json headRefOid,baseRefOid,closingIssuesReferences` gives you what to pass, and the brief says so when the head you gave isn't the one the logs point to.

## How it picks out one pull request's steps

One session often works on several pull requests, and may reach each one's worktree with `cd` without ever recording its branch. So each step is tied to a pull request by anchors: one of its commits, a push to its branch, a link to it or a `gh pr` command for it, its branch being made, or the step's folder being on its branch. An edit to one of its files and its closed issue are weaker anchors: they join a stretch the others tie to the pull request, and never put a step in on their own. The steps between two of its anchors are in, unless an anchor for another pull request comes between. A step tied both ways, or on the edge between two pull requests' work, is ambiguous: it's shown, but never counted as backing a claim. A session that opened with a review command for the pull request, or that a step in scope started to review it, is in whole.

A branch made from the pull request's branch (a review worktree made with `git worktree add <path> -b review/x origin/<its branch>`, say), or one whose folder pushes to its branch by name (`git push origin HEAD:<its branch>`), counts as on its branch. That's inferred, so the brief names the rule. A branch that's pushed under its own name or to another branch, or that a pull request was opened from (a stacked pull request's branch, say), is other work and never counts. So is one made from its branch that gets a commit of its own the pull request doesn't have, such as unpushed work for the next pull request. A step after the pull request landed isn't part of how it was made, so the brief leaves it out and counts it as "came after it landed". The exception is a step that belongs to other work, which keeps that lane.

## How a claim is paired with a check

A claim pairs with the latest check after the last edit before it, in the same session, decided exactly as the Problems page's "says done without checking" and "says it works after a check failed" decide it (a test holds the two to the same answer). The check has to have run in a folder on the pull request's branch; one that ran in another checkout is a named gap. A claim that CI is green pairs only with a step that read CI. A claim in a commit message is the weakest kind.

## Limits

- Its default window is the pull request's own dates, from 3 days before its first commit to 2 days after it landed. A pull request with no landing commit and no `--head` reads your usual window. A squash keeps no trace of its first commit, so it starts 3 days before the squash landed; if no log there names a commit of it that git can date, it reads once more from 14 days before, and if that finds none either, it says how far back it read. Name its latest commit with `--head`, or read earlier with `--from`.
- A commit or file list that isn't known (git couldn't read it, or no log names a squash's commits) is shown as unknown, never as zero, and so are the commits or files no session explains.
- When you have more than one repository configured and don't name one, the dates come from the only readable one where git shows that number landed, and the brief reads that same repository and says so. If the sessions point at a different one, it asks instead. If you meant another, name it with `--repo` or as `your-repo#N`.
- It reads every log in that window, as `find` does, so a long window takes a while; a later version reads only the sessions that could matter.
- Earlier reviews' ranges, CI results printed in a session, and a Review page in `view` aren't in this first version.

## Implementation detail

- `lib/review/resolve.mjs` (`resolvePr`): the pull request's shape, from the engine's hidden pointer index (`history._refIndex`), `history._sessionRepo`, and the git helpers in `lib/git.mjs` (`landedPr`, `revParse`, `branchTip`, `mergeBase`, `commitRange`, `changedFiles`, `commitMessage`). A display-only repository gets no git call; `test/review-resolve.test.mjs` proves it with a process recorder.
- `lib/review/scope.mjs` (`scopeSteps`): anchors per step, from `_command`, `_lineCwd`, `_lineBranch`, Codex `_workdir`, the edit tools' `file_path`, recorded pushes and commits, and `worktreeBranches`.
- `lib/review/claims.mjs` (`pairClaims`): claims from `_raw.text`, the `gh pr create` body and commit messages; pairing through `backingCheck` (`lib/problems/backing.mjs`); currency; `plainCheck`.
- `lib/review/brief.mjs` (`buildBrief`) and `lib/review/make.mjs` (`makeBrief`, the `honestweek.brief/1` shape and its redaction, with commit ids, step ids and times kept).
- `lib/review/rules.mjs`: every `brief.*` rule, with where it reads.
- `/api/brief` in `lib/view/data.mjs`, on the redacted build only; `lib/ask-brief.mjs` holds the help, the default window (`prWindow`) and the text; `lib/ask.mjs` runs it like `find`.
- Tests: `test/review-*.test.mjs`, on the shared fixture `test/fixtures/replay/review-pr.mjs`.
