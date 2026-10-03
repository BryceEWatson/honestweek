# Plan: problems and fixes in `honestweek view`

## In plain terms

This adds a Problems page to `honestweek view`, the page honestweek serves on my own machine. It lists 40 known ways AI coding agents (Claude Code and Codex) go wrong or waste time and tokens, from a researched catalog with its published sources, and says which of them showed up in my own sessions this window, each finding linked to the exact step in the replay. Each pattern gets fix ideas I can adopt myself; nothing is applied for me. The replay and goal timelines get a thin "Worth a look" strip that marks those findings at their moments. Everything stays local and private: findings say what the log shows and how that's known, never why it happened, and the page redacts their text like every other page.

## Terms used here

- A **pattern** is one known problem from the catalog, such as "says done without checking" or "the same call repeated with nothing changed". The **catalog** is the list of 40 patterns, each with what it looks like, why it matters, how strong the evidence is that it's common, how a log could show it, ways to prevent it, and its sources.
- A **check** (or detector) is code that reads the engine's history of a window and returns **findings**: one place in one session where a pattern shows, with the step it points at, the rule that decided it, and its evidence level.
- A **finding worth a look** is one a check flags. A **routine note** is one a check records but doesn't flag, such as a hedged "should work" claim. Only findings worth a look raise a pattern's priority.
- **Priority** is a tier (High, Medium, Low) a stated rule gives each pattern found this window. **My priority** is my own override of that tier, or "not a problem".
- The **engine** is honestweek's work-history code in `lib/replay/`. The **redacted build** and the **private build** are the two histories `view` keeps: every page reads the redacted one unless I turn on Show private text.
- **Usage** is the token counts each model call records: input, cache writes, cache reads and output.
- A **turn** is a stretch of a session from a prompt I typed to the next one, with every agent's steps in between.

## What I'm deciding here

### Where the checks run

The checks run once, over the redacted build, on sessions in my configured repositories only. Display-only and outside sessions stay out, as they do from lookups and goals. The private build only swaps the text a finding shows (the step's description and the session's title), so Show private text changes words, never which findings exist or how many. A check reads only the history; it never reads a file, runs git or writes anything.

### Two engine options, additive, in their own commits

Some checks need more than the engine keeps today, so the engine gets two options. Both are off by default, and with both off every history is byte for byte what it was.

- `usage: true` adds `usage.calls` to the history: per model call, its session, agent, source file and line numbers, time, and four token counts. Numbers and ids only, never text. A Claude Code call is one assistant message id, counted once even when a resumed session copies it (the copy in the earliest-ending file wins, the same rule the engine uses for events). A Codex call is a token-count record whose running total went up. Skeleton sessions get none.
- `keepRaw: true` keeps, in memory only, the raw input of each tool call, the full text of each agent message and prompt, and the first part of a failed call's error text, on a non-enumerable `_raw` field of the event. It's never serialized (JSON leaves non-enumerable fields out) and no view reads it. The engine already keeps a raw command this way (`_command`). The checks read `_raw` to classify text and compare inputs, and keep only booleans, counts and one-way fingerprints.

These commits touch only `lib/replay/` and its tests, so they can be split into their own pull request.

### Which checks are ported, and which aren't

Ported, as rule modules under `lib/problems/`, each with a made-up test and a failing partner:

| Check | Pattern it measures | Level |
| --- | --- | --- |
| Edits, a completion claim, and no check after the last edit | unverified-done-claim | inferred |
| A landed pull request with no test run in its sessions | unverified-done-claim | inferred |
| A success claim after a check that failed | claim-contradicts-evidence | inferred |
| A commit right after a failed test run | claim-contradicts-evidence | inferred |
| Tests weakened, skipped or excluded | test-tampering | inferred |
| The same call repeated with nothing changed (and a failed command re-run unchanged, an edit undone and redone) | action-loop | derived |
| The same tool error again and again (and failed edits to one file in a row) | repeated-tool-error | derived |
| Small or duplicated sub-agents | subagent-overuse | derived |
| A sub-agent with no recorded hand-back | subagent-handoff-loss | derived |
| Edits after a question-only prompt | scope-creep | inferred |
| An edit while plan mode was on | instruction-violation | derived |
| A session whose last record is an interruption, an error or a waiting call | premature-stop | derived |
| Force-pushes, hard resets, recursive deletes, git clean | destructive-command | inferred |
| Skipped git hooks | bypassing-safeguards | inferred |
| Secret-shaped text in prompts or tool inputs | secret-exposure | inferred |
| Long agents that kept going past 150k tokens of context | context-bloat | derived |
| A file and range read three or more times with no change between | repeated-file-reads | derived |
| The same status call three or more times with nothing changed | busy-polling | inferred |
| A turn that ended on a question answered with a bare go-ahead | needless-check-in | inferred |
| Single steps that grew the context by 20k tokens or more | oversized-tool-output | derived |

Not ported: the prototype's checks of one person's own written rules (no em dashes, "In plain terms" bodies, squash merges, no releases, zero dependencies, screenshots next to a text read), because they're one person's rules, not a pattern; "edits not committed", because it needs git to say which files are tracked and the checks never run git; and the context-only checks (fix loops, review cost, last test run failed, steps refused), which never make a pattern found. Those patterns show as "no check here yet". A token check with no usage records in the window says so instead of "checked, not found".

### The priority rule

The prototype's stated rule, unchanged. A pattern's impact comes from its catalog group: harm (safety, and correctness and honesty), cost (efficiency and cost) or friction (process and collaboration). Only findings worth a look count.

- **High:** a harm pattern with a finding worth a look worked out from the log's facts (derived or recorded), or with 3 or more by a rule's best guess; or a cost pattern whose measured tokens are 5% or more of the window's.
- **Medium:** a harm pattern with 1 or 2 findings worth a look, only by a rule's best guess; a cost pattern at 1% to 5%; or a friction pattern with 5 or more worth a look.
- **Low:** anything else found, including a pattern whose findings are all routine notes. A card shows those as "plus N routine".
- Within a tier: tokens measured, then findings worth a look, then how well established the pattern is. Patterns not found, with no check yet, or that a log can't show get no tier.

### Where "My priority" and the strip's switch are kept

The page's storage rule is that the browser keeps nothing I typed or that a page showed from my logs, and session storage holds only the run key and the Show private text switch. That stays true. "My priority" and the strip's on and off switch are kept in the browser's local storage, under one key, `hw.prefs`, because they're preferences about the shipped catalog, not about my logs: the value is `{ "v": 1, "priority": { "<pattern id>": "high" | "medium" | "low" | "dismissed" }, "strip": true | false, "low": true | false }`. Pattern ids come from the catalog shipped in the package, the same on every machine, and the four tiers are fixed words. One small script, `prefs.js`, is the only code that touches local storage. It drops any pattern id the page didn't get from the server's catalog list, any tier outside the four, and anything else in the value, on every read and write. A node test drives it with a fake storage and checks the key holds nothing else; the page-file test checks no other script names local storage. An override lasts across runs, which is what an override is for.

### The catalog and its sources

The catalog ships as data in `lib/problems/catalog.json`. Each source keeps its title, address, date, kind (vendor doc, user report or paper) and the catalog's own paraphrase. Dropped: the publisher field, which names people (authors, "et al." lines), the direct quotes, and the research bookkeeping. One source on a personal blog is dropped, because its address is a person's name. Two paraphrases are reworded and one source is dropped where the text carried a word the clean-room fence reserves. Public issues on the vendors' own issue trackers (github.com/anthropics/claude-code, github.com/openai/codex, github.com/google-gemini/gemini-cli) are kept as public references, with their titles. That's a deliberate call for the reviewer: the issues are public, but each was filed by a person, and their titles are that person's words.

### Privacy

Every string the problems route returns passes the same redactor as the rest of the page: the full one by default, the secrets-only one with the switch on. Catalog text passes it too, and each source address goes out in parts, so a part the redactor hides drops the link and keeps the title. Ids pass only when they match an id's shape. Notes are built from fixed words and numbers, with token counts written short (340k, 1.2M) so no long digit run reads as an account number. The leak counter's node tests cover the new route in both modes, and the click-through test sends the page's pieces to the leak counter like every other page.

## In scope

1. A Problems page (`problems.html`) and `/api/problems`: patterns grouped High, Medium, Low, then not found, no check yet, and can't be checked from logs; the stated rule; group and status filters; each card with what it looks like, why it matters, how strong the evidence is, how it's detected (evidence level, signals, known false alarms), this window's findings with replay links, fix ideas (catalog mitigations plus a generic hook, skill or instruction draft, not applied) and sources; "My priority".
2. The checks above, under `lib/problems/`, run over the redacted build.
3. The two engine options, in their own commits with tests.
4. The catalog as data, with the fence over `lib/problems/` and its tests.
5. The "Worth a look" strip on the replay and goal pages: dots by priority colour, filled for derived or recorded and hollow for inferred, merged bands for stretches, crowded dots merged into a count, a header badge ("N high, M medium worth a look"), a switch, and a card with the pattern, what the log shows, how it's known, one fix idea, Jump to step and a link to the pattern's card. Every mark is a button a keyboard reaches and a screen reader names.
6. Tests: every check on made-up histories with a failing partner, the tier rule, the route contract, leaks in both modes, the preferences store, the fence, and click-through groups for Problems and the strip (named skips where the demo has no such finding).
7. Docs: a Problems section in `docs/local-page.md`, a sentence and the command in the README's `view` section, and the engine options in `docs/work-history-engine.md`. This plan folds into `docs/local-page.md` and is deleted at the end.

## Not in scope

- Applying a fix, writing a hook, or changing any setting. Fix ideas are drafts to copy.
- Week-over-week comparison of the numbers a fix should move.
- The prototype's audit and efficiency pages as pages of their own.
- Checks that need git to say which files are tracked, and checks of one person's own written rules.
- New demo sessions, unless a click-through group has nothing to show without them.

## Definition of done

- `node --test` is green, with a test for every check and its failing partner, the tier rule, the route's fields and leaks in both modes, the preferences store, the engine options (additive: output unchanged with them off), and the fence over `lib/problems/`.
- The click-through test passes on the demo week with any skip named on its list, and once on my own logs with a fresh config, switch off, reporting counts only.
- `docs/local-page.md` has the Problems section, the README names the page in one or two sentences, and this plan is gone.
- No real names, paths, repository names, emails or codenames anywhere in what's committed, and nothing from my own logs.

## Implementation detail

- `lib/replay/claude.mjs`, `lib/replay/codex.mjs`, `lib/replay/index.mjs`: the `usage` and `keepRaw` options. Tests: `test/replay-usage.test.mjs`, `test/replay-raw.test.mjs`.
- `lib/problems/catalog.json`: the data. `lib/problems/classify.mjs`: the text and command classifiers (completion claims, check steps, test files and test-weakening counts, error signatures, secret shapes, status commands). `lib/problems/context.mjs`: turns, steps, usage joined to steps, and the round-trip and carried cost of each step. `lib/problems/checks.mjs`: the checks. `lib/problems/drafts.mjs`: the generic draft fixes. `lib/problems/index.mjs`: `runProblems(h, { builtT })` and `assemblePatterns()`, with `PRIORITY_RULE`, `priorityOf()` and the map from patterns to checks.
- `lib/view/data.mjs`: `/api/problems` (whole page), `?session=<key>` (one session's findings), `?thread=<id>` and `?goal=<key>` (the strip's findings for the sessions on screen). The redacted build is asked for `usage: true, keepRaw: true`; the checks run once when it's ready.
- `lib/view/assets/problems.html`, `problems.js`, `prefs.js`, `strip.js`, and rules in `common.css`. `replay.html` and `goal.html` load `prefs.js` and `strip.js`.
- `lib/view/selftest/clickthrough.js`: the `problems` and `strip` groups.
- Tests: `test/problems-classify.test.mjs`, `test/problems-checks.test.mjs`, `test/problems-priority.test.mjs`, `test/view-problems.test.mjs`, `test/view-prefs.test.mjs`, and the fence in `test/site-cleanroom.test.mjs`.
