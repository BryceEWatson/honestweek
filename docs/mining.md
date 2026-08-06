# Mining session logs for solved problems worth publishing

## In plain terms

When you work with an AI coding assistant, everything you type and everything it runs is
written to a log file on your own machine. Buried in those logs is a small number of
moments where some piece of software you did not write broke, and you worked out how to
fix it. Those moments are worth publishing, because other people hit the same failures
and go looking for exactly that answer. Almost nobody writes them up, because by the
time the thing is fixed you have moved on.

`honestweek mine` reads those logs, picks out the moments that look like a solved
problem with somebody else's software, ranks them by how likely they are to be worth a
stranger's time, and writes the best one up as a draft post. It never publishes
anything: a person still has to read the draft, check that the fix still works, and
decide.

This document explains how it decides, what it can and cannot know, and where the
numbers in it came from.

## Why this exists

The observation behind it is uncomfortable: on the site this was built alongside, a
single post about fixing one specific error in one specific Windows application accounts
for about three-quarters of all traffic. It was not planned, it was not promoted, and it
has needed no attention since the day it went up. People find it because they paste an
error message into a search engine at the moment their tool is broken.

That post was an accident. The raw material for more of them is produced constantly, as
a by-product of ordinary work, and thrown away. This is a mechanism for not throwing it
away.

## The control loop

Stating it in control terms, because the failure this is designed around is a specific
one and the framing is what makes it visible.

**Setpoint.** At least one publishable finding reaching a human decision each week that
the logs contain one. Deliberately not "N posts published" — publishing is a human act
and cannot be a machine's target.

**Sensor.** The `mine` command, reading three log corpora.

**What the sensor is blind to.** Four things, none of them fixable by better code:

- Anything older than the **retention floor**. Agents delete their own old logs, so
  there is a date before which nothing survives. Every run prints that date.
- Problems solved outside a logged session — in a browser, in a chat window, by hand.
- Whether anyone actually searches for the error. That is a fact about the world, not
  about your logs.
- Whether the fix still works today. The log records one machine, one day, one build.

**Error signal.** The **backlog**: findings discovered and not yet accepted or declined.
This is the part worth being pedantic about. "This run found 3 things" is an activity
count — it goes up when you run the tool more often and tells you nothing about whether
any problem ever reached a reader. The backlog only falls when a person decides
something, so a rising backlog says exactly one thing: the finding half works and the
deciding half does not.

The ledger also records **how long the oldest undecided finding has been waiting**,
because a backlog of one item sitting for two months is a different failure from a
backlog of twelve opened this morning.

**Actuator.** `--draft` writes a real post file and marks the finding as drafted. The
human's remaining job is to read it and say yes or no. This is the part that gets
designed wrong most often: a mechanism whose output is "here is a list for you to review
on a schedule" has an actuator that is really just "the operator remembers to work a
queue", and that actuator has a bad track record.

**Silent-failure handling.** Every run records what it *saw*, not just what it found:
files enumerated per corpus, sessions accepted, the date range covered, the retention
floor. If a corpus resolves to a directory that exists but holds no logs, the command
**exits 2**. "I looked at 1,893 sessions and found nothing" and "I looked at nothing"
must never print the same way.

## The detector

### The one question it asks

Most of a session log is ordinary work: you write code, it breaks, you fix it. That is
worth nothing to a stranger. The publishable fraction is different in one specific way,
and it is not "was it hard":

> **Whose bug was it?**
>
> Ordinary work — your code broke — so you **edit files in your repository**.
> Publishable — a tool broke — so you **investigate the machine around it**.

Every signal below is a measurable expression of that one distinction.

### What has to be true

A session becomes a candidate only when all three hold. The first two establish that it
was somebody else's bug; the third establishes that it was actually solved, because an
unresolved failure is a bug report, not a guide.

**1. A quotable error from software you did not write.** A line lifted from a command's
output that reads like a program announcing a failure. Errors from your own toolchain
(compiler, test runner, bundler, linter) and from version control are excluded, because
a broken build in your repository is a fact about your repository.

**2. Diagnosis outside your working tree.** Any one of three kinds:

- *state* — inspecting the machine: services, event logs, the registry, running
  processes, ports, installed packages, scheduled tasks.
- *artifact* — touching another program's installation or state directory.
- *research* — reading up on a third party's known behaviour: repeated web searching, or
  issues on a repository that is not yours.

Requiring only the first kind was wrong, and the corpus proved it. A session already
known to have produced a published post probed no services at all: it ran a controlled
experiment against a browser tool, researched it, and filed bug reports. Every part of
that was diagnosis of software the author did not write.

**3. Evidence it was resolved.** One of: a person saying so in their own words; a bug
filed upstream *in that session*; or a run of failures followed by a success.

Filing a bug counts. Merely *reading* ten of somebody else's bug reports does not — that
is research, not an outcome. Conflating the two made this test fire on nearly every
session in the corpus.

### What disqualifies a session

If the number of edits to files inside your own working tree dwarfs everything else the
session did, it was ordinary work that happened to print something alarming. Rejected
regardless of its other signals.

An edit *outside* the tree — changing a config file in another program's install
directory — is not ordinary work. It is often the fix.

## The ranker

Not every solved problem is worth publishing. Each signal carries a label, and the labels
are the point: a score built from measurements and guesses, reported as one number, hides
which part is evidence.

| Signal | Basis | What it actually measures |
| --- | --- | --- |
| quotable-error | measured | How much the best error line looks like program output rather than someone's description of it |
| named-product | measured | Whether the failing software could be identified from the evidence |
| version-pinned | measured | Whether a version number appeared alongside the error |
| external-issue | measured | Bug reports on repositories that are not yours |
| resolution-strength | measured | Which kind of resolution evidence exists |
| human-publish-intent | measured | Whether a person said in the session that this was worth writing up |
| research-depth | **proxy** | Web searches during the session — standing in for *the fix was not already written down somewhere findable* |
| diagnosis-breadth | **proxy** | How many kinds of investigation were used — standing in for *the root cause was non-obvious* |
| effort | **proxy** | Human turns — standing in for *the problem resisted a first attempt* |
| search-demand | **unknown** | Scored zero. Whether anyone searches for this cannot come from a log. |
| still-true | **unknown** | Scored zero. Whether the fix still works cannot come from a log. |

The two `unknown` rows score nothing and are listed anyway, so they can never be quietly
treated as satisfied. `still-true` is not a dead entry: it is what the drafter turns into
required verification work.

### Answering the question directly

Asked which ranking signals are real measurements and which are guesses:

- **Genuinely measured:** is there an exact error string, is there a named product and
  version, was a bug filed upstream, was the fix confirmed, did a person say it was worth
  publishing.
- **Guessed at, with a measurable stand-in:** is the fix non-obvious (search count and
  investigation breadth), would someone else search for this (error-string shape plus a
  named third-party product).
- **Not knowable at all:** actual search demand, and whether it is still true. Both are
  reported as zero rather than estimated.

### Where the score bar came from

The threshold is 20, and it was set by running the detector across the full local corpus
and reading the output, not chosen in advance. On 1,893 deduplicated human-started
sessions the detector produced 40 candidates (2.1%), of which 7 cleared the bar. A
separate floor requires the leading error string to be quotable enough to lead a post
with, which is what excludes findings whose only error is something like
`{"error":"not found"}` — technically an error, useless to a stranger.

Both numbers are policy, not physics. Lower the bar with `--threshold` and you get more
to read.

## What the drafter refuses to do

The drafter will not assert that a fix still works. Everything it knows came from a log
written on a past day about a past build. If it filled in a publication date, a
description, or a "last verified" field, it would launder an old observation into a
present-tense claim, and the person publishing it would have no way to see which parts
were ever checked.

So every draft carries, structurally:

- a **verification checklist** where every item starts `UNVERIFIED`, built from the
  specific commands, versions and bug reports that session actually used;
- a **"What I could not check"** section, pre-filled with the things a log genuinely
  cannot establish;
- an **empty** last-verified field, whatever your destination calls it;
- a section for the fix that explicitly says a log cannot tell you what the fix *was* in
  a form worth publishing. Inventing one would be the worst output this system could
  produce.

## Corpus hazards

These are properties of the logs themselves. Each one silently corrupts counts, and each
was measured on the machine this was built against rather than assumed.

**Log retention.** Agents delete their own old transcripts. On the reference machine the
oldest surviving Claude Code session was about three months old, and everything before
that was gone permanently — raising the retention setting does not bring back what has
already been deleted. Reported every run as the retention floor.

**Two shapes for a human turn.** A user message is sometimes a plain string and sometimes
a list of blocks. On the reference machine 1,106 of 2,606 session files used the list
form. A reader that only accepts the string form silently drops 42% of the corpus while
reporting a confident number.

**Text that looks like a person and is not.** Injected reminders, slash-command wrappers,
subagent task descriptions, delegation envelopes, and automated status probes all appear
in the same position as a typed prompt. All are filtered.

**The same session written more than once.** Deduplicated on when the first human turn
happened and what it said. Measured on the reference machine at 7.8% of keyed Claude Code
files and 0.3% of Cowork files — notably *lower* than the roughly one-third that had been
assumed going in, so the assumption is recorded here as not reproduced rather than
repeated. The deduplication runs regardless; it is cheap and it is correct.

**Subagent transcripts.** They sit inside session directories and look like sessions.
Their first line is an instruction *to* an agent, not a person speaking. Excluded in all
three corpora.

**Attribution is by launch directory.** A session is filed under the directory it was
started from, not what it touched — so work on one project done from another project's
worktree is filed under the wrong one. Findings are therefore deliberately **not**
attributed to a project. A finding is a finding regardless of where the terminal was
open.

## Where this lives, and why

honestweek is a generic verified-page generator. It knows nothing about any particular
website, and this feature keeps it that way:

- The **detector** and **ranker** are generic. "Find solved third-party problems in agent
  session logs" involves no site-specific knowledge.
- The **drafter** takes its destination schema from configuration. The field names in a
  draft's frontmatter come from your config; none of them is hardcoded here.
- Anything that knows a specific site's layout, tags, or publishing rules belongs in that
  site's own repository, alongside its other site-specific scripts.

## Implementation detail

Everything below this line is code-level and can be skipped.

| File | Role |
| --- | --- |
| `lib/mine/corpus.mjs` | Enumerates and streams the three log dialects into one event shape; deduplication; the diagnostics that make blindness visible. |
| `lib/mine/detect.mjs` | Feature extraction, de-identification, and the candidate test. |
| `lib/mine/rank.mjs` | Scoring with per-signal basis labels; problem-level deduplication. |
| `lib/mine/ledger.mjs` | Durable findings ledger; the backlog computation. |
| `lib/mine/draft.mjs` | Draft rendering, verification plan, disclosure sections. |
| `lib/mine.mjs` | The `honestweek mine` subcommand. |

Log locations: `$CLAUDE_CONFIG_DIR/projects` (else `~/.claude/projects`);
`$CODEX_HOME/sessions` (else `~/.codex/sessions`);
`%APPDATA%/Claude/local-agent-mode-sessions` and `%APPDATA%/Claude/claude-code-sessions`.
A tool mid-rename has both directories present and one of them empty, which is why the
blind-sensor check groups by corpus kind rather than by directory.

Reading is streamed line by line and capped per session (`MAX_SESSION_BYTES`, 8 MB), so a
very large transcript cannot stall a scan; truncated sessions are counted and disclosed
in any draft they produce. A full scan of ~4,700 files takes about 25 seconds.

De-identification (`deidentify` in `detect.mjs`) runs before the configured redactor,
never instead of it. It removes home directories in every path spelling, UNC shares,
encoded working-directory names, and — as a last-resort backstop — the local account name
as a literal, which is the only rule here that is machine-specific rather than a pattern.

Result bodies are attributed to the tool call that produced them, and only results from
tools that *execute* something are mined for error text. A file read is content someone
wrote, not program output; mining it produces confident findings about sentences in
design documents.
