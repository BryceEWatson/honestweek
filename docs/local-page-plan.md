# The local page: find, check and replay your agent work in your browser (plan)

## In plain terms

This plan adds a new honestweek command, `honestweek view`. It opens a page in your browser, served only from your own machine. There you can find the sessions and goals behind a pull request, commit, file, branch or phrase, see the sessions working toward each goal, and replay any session step by step, with how each step is known. Today that page exists only as a private prototype that reads one person's logs. This plan rebuilds it inside honestweek so anyone can run it on their own logs, or on a made-up demo week, under the project's privacy rules. It ships as three pull requests: a redaction speed fix (in a trial it cut the slowest page's build from about 107 seconds to about 27), a fix so the engine never cuts a private word in half before hiding it, and then the page itself. Nothing is published, nothing leaves the machine, and nothing private is written to disk.

## Terms used here

- A **session** is one conversation log from Claude Code or Codex. A **thread** is a group of sessions the logs connect, such as a resumed session and the one it continues.
- The **engine** is honestweek's existing work-history code. It reads the logs, rebuilds what happened, and tags each step and link with one of four **evidence levels**:
  - **recorded**: the log says so;
  - **derived**: computed from recorded facts;
  - **inferred**: a named rule's best guess;
  - **missing**: the log doesn't say.

  An **ambiguous** link is one the records fit more than one way, such as a pull request number that two repositories share. The page shows it as ambiguous, whatever its level.
- **Redaction** replaces private text with markers such as `[redacted:term]`. The **redactor** is the code that does it. The **redacted view** is what every page shows unless you turn on the switch below.
- **Show private text** is a switch on the page. When it's on, your own screen shows names, client words and folders that redaction would hide. Keys, tokens and passwords stay hidden either way.
- A **display-only** repository is one marked `display` in the config: honestweek never runs git against it. An **outside** session is one whose folder isn't in your config at all. With the switch off, the engine shows both kinds of session as **skeletons**: the kind and time of each step, without its text.
- A **goal list** is the file of goals and goal changes the engine reads, called a goal record in the engine docs. It's not the goals-page list that `honestweek build` uses; the two have different formats.
- The **prototype** is the private set of pages this plan replaces. It lives in a git-ignored folder and is never committed.
- The **click-through test** is a test page that drives the real pages the way a person would, by clicking and typing, and reports each step as pass, fail or skip.
- The **demo week** is a made-up week of sessions that honestweek already ships for testing.

## Where this comes from

- The maintainer's word `approve` on 2 October 2026 starts the in-product local page. It was given after the prototype pages had been seen.
- The word `keep` the same evening. With the switch off, a search across the whole machine still shows short excerpts from display-only repositories, with private words blanked out.
- The earlier choice `local-full` for search. On your own machine, search can match private words and display-only sessions in memory, results stay redacted on screen, and nothing unredacted is ever written to disk.
- The goal "Find and check any agent work". This plan serves four of its success criteria:
  - one search finds the goals and sessions behind a pull request, commit, file or phrase, each link tagged with how it's known;
  - every session replays to any moment, down to its log line;
  - no link, count or time appears without its evidence level, ambiguous and conflicting links show as such, and a person's own assignment shows as theirs;
  - a demo built only from made-up sessions shows search, goals and replay.
- `AGENTS.md`: no dependencies, Node 18 or newer, works on Windows and Linux, no network, no real names or data in the repository, redaction before anything is written, and existing output unchanged.
- The prototype and its click-through test, used as the behaviour to match, not as code to copy.
- A profile of the prototype's slow goal page, measured on the maintainer's machine on 2 October:
  - The redacted build took about 107 seconds.
  - About 82% of that went into the redactor. It was called about a million times on mostly tiny strings, with a high fixed cost per call.
  - Two small redactor changes, tried in a scratch copy, brought the same build to about 27 seconds with identical output.
  - Reading only the record a page shows brought it to about 18 seconds.

## Pull request 1: faster redaction

**What changes**

- The redactor matches its private-term patterns with a cheaper loop.
- It skips a term's patterns entirely when the text can't contain that term.
- Looking up one step's original record goes straight to that step instead of scanning the whole history.

Every honestweek command that redacts gets faster, not only the page.

**Why it's its own pull request**

The redactor is honestweek's privacy core. A change there gets its own review and its own tests, separate from new features.

**How it's checked**

- The old and new redactor run side by side over generated text and must give identical output and identical counts. The generated text covers:
  - upper and lower case;
  - separators and words glued together;
  - web addresses;
  - placeholders already in the text;
  - terms with non-English letters;
  - the handful of letters that change case into plain English letters, such as the Kelvin sign.
- The demo week and the test corpus build byte-identical output before and after.

## Pull request 2: redact before cutting

**What changes.** The engine shortens long text, such as a prompt or a command's output, before it hides private words in it. A private name that straddles the cut point loses its end, so the redactor no longer recognises it, and its start shows on screen. The engine will hide private words in the whole text first, then cut, stepping the cut back so it never splits a `[redacted:…]` marker.

**Why now.** No shipped command shows this text today, so nothing published is affected. The page will be the first to put it on screen.

**How it's checked.** A test places a made-up private name across every cut point the engine uses, and no part of the name may reach the output. The engine's output for text with no private word straddling a cut stays byte-identical.

## Pull request 3: the page

### What you get

1. **One command.**
   - `honestweek view` reads your config and the last 7 days of logs, starts a page on `127.0.0.1`, and opens your browser.
   - `--days N`, or `--from` and `--to`, pick another window.
   - `--goals <file>` names your goal list, which can also be set once in the config.
   - `--port` picks a port; otherwise a free one is chosen. `--no-open` skips opening the browser.
   - Ctrl+C stops it.
   - While the data is being built, the page says what it's reading and how long it's been going, instead of showing a blank screen.
   - With no config file, it stops with a message that points to `honestweek init` to set one up and `honestweek view --demo` to look around first.
2. **The window is always visible.** Every page header shows the dates it covers. An empty result says "Nothing between <from> and <to>", and suggests `--days` to look further back. Goal timelines and counts say they're for this window.
3. **Search.** One search box:
   - **A reference.** Type a pull request (`#67` or its address), a commit, a file or a branch, and the page lists the sessions and goals behind it.
   - **Words.** Type words, and the page lists the goals whose titles match, the sessions whose titles match, the branches that contain the text, and the prompts that share the most words, each with its goals and a link to replay from that prompt.
   - **Similar prompts.** "Similar prompts" lists prompts like the one in front of you.
   - **What it covers.** A coverage line says what these lookups cover (your configured repos in this window) and what they leave out.
   - **Evidence on every result.** Every link shows its evidence level and a short reason, and a goal listed beside a session shows how that session joins it. Results the page finds itself carry a level too. Words found in a prompt or title are recorded, because the text is in the log. A shared-word score or a similar prompt is inferred, by a named rule the evidence key explains. Counts in the coverage line are derived. An ambiguous link shows as ambiguous, with the engine's note. A goal you assigned yourself, by citing the session in your goal list, is labelled as your assignment beside its level.
4. **Search everywhere.** Below the lookups, the same words search the prompts of every session on the machine in the window, including display-only repositories and outside folders.
   - Each result says which of those three groups it belongs to.
   - With the switch off, excerpts are redacted before they're cut, so a cut can never expose half a private word. This is the `keep` decision.
   - Opening a result's replay uses the same build as everything else. A display-only or outside session therefore shows as a skeleton with the switch off, and in full with it on.
5. **Goals.** Each goal in your goal list shows the sessions working toward it on a shared timeline. You can play, pause and scrub it, and open any step's record.
   - Each session's place in the goal shows its evidence level (recorded, derived or inferred), whether it's ambiguous, and whether it's your own assignment.
   - Citations in your goal list that the logs don't back are listed too, as missing, each with the engine's reason. Examples: a session that isn't readable in this window, or a session named only in words. They're labelled as your own assignment, so nothing you cited vanishes without a trace.
   - With no goal list, the page explains what a goal list is, links to the demo week's example, and still offers search and replay.
   - Passing the goals-page list by mistake gets a message that names the difference.
6. **Replay.** Any thread replays to any moment. The header's Replay link, with no thread chosen, opens the most recent thread in the window, or says there's none and points to search. Each step opens a side panel showing:
   - what happened, who did it, and its evidence level. "Who" is one of:
     - "You";
     - "a person or a script", for a prompt in a non-interactive run;
     - the main agent;
     - a named sub-agent.

     When the engine only infers that you wrote a prompt, "You" is marked inferred, with the rule;
   - the original log line, checked against its fingerprint (a hash taken when the history was built, so a changed log shows as changed);
   - for a step that ran a command, the command's output, redacted and shortened, so a test run's pass and fail counts sit beside the command;
   - its time, and how that time is known. The panel and the timeline say so in two cases:
     - the step's log line has no time of its own, and the engine took the time from the line before or after it;
     - a sub-agent's step was stamped before the call that started it, and the engine moved it to just after that call.
7. **The evidence key.** One key, used on every page, explains recorded, derived, inferred, missing and ambiguous in plain words. Every page uses those same five words.
8. **Show private text.**
   - The switch appears only when the page comes from this command on your own machine.
   - It's off every time you run the command. Each run gets a fresh random key, which the command puts in the address it opens and the page sends with every data request. The server refuses data requests without it, so another program on the machine can't read your data either. A switch setting counts only under the current run's key, so reloading a tab left open from an earlier run, even on the same port, opens redacted.
   - The address bar never holds what you typed or a goal's name, only made-up ids, because the browser keeps addresses in its history on disk.
   - If the private version fails to build, the page keeps showing the redacted version and says the private one couldn't be built.
   - It changes only text, never which sessions link to which or which goals they join.
   - The private version is built in memory the first time you turn the switch on, and it's never written to disk.
9. **Demo mode.**
   - `honestweek view --demo` builds the made-up demo week in a temporary folder, serves it, and deletes the folder when you stop.
   - It reads only the demo's own logs, config and goal list, never your real logs, so a demo page can't show real text. It refuses `--config`, `--goals`, `--days`, `--from`, `--to` and `--timezone`, because the demo's data and week are fixed.
   - Every demo page carries a notice: the data is made up, and here are the commands to install honestweek, set it up with `honestweek init`, and run `honestweek view` on your own logs.
10. **Self-test.**
    - `honestweek view --self-test` adds the click-through test page, which checks every page in your browser on your own data. It reports counts, never private text.
    - The checks that don't need a browser also run in the normal test suite.

### Fixing what the people who tried the prototype found

These came from simulated users who tried the prototype pages. Each fix has a named test, listed under the Definition of done below.

1. **Keyboard and screen readers.** Every step on a chart can be reached with the keyboard and opened with Enter. Each chart has a matching list of its steps that a screen reader can read, instead of being announced as one picture.
2. **One set of evidence labels.** A count carries the level the engine gives it, so the same count never reads "recorded" in one row and "computed" in the next. A prompt you wrote says "You", not "Main agent".
3. **A step's output.** This is item 6 above.
4. **How to install.** This is the demo notice in item 9.

### Fixing what the prototype gets wrong

- **Other websites could read your data.**
  - The prototype sends its data as scripts and doesn't check who's asking. A website you visit while it runs could probably load your search data, private version included. That's derived from reading the code, not tested.
  - The command sends data in a form other sites can't read. It refuses requests from other sites or other addresses, and it sets a strict policy so each page loads only from the command itself.
- **Private by default.** The prototype served private text when a request left out the private setting. The command serves the redacted view unless a request asks for private text.
- **Display-only sessions readable with the switch off.** To show an outside or display-only session's replay, the prototype rebuilt it as if it were an ordinary repository, so its text showed with the switch off. The command uses one build per switch setting, so those sessions stay skeletons until you turn the switch on. That build never runs git against a display-only repository.
- **No real data in the code.** The prototype had one machine's folders and dates written into it. The command takes everything from the config and the command line.
- **Memory that only grows.** The prototype kept every replay it built. The command keeps a fixed number, separately for each switch setting, so a private replay can never be handed to a redacted request.
- **Records built up front.** The prototype read and redacted the original log line for every step before showing anything. The command reads a step's record only when its panel opens.

### How fast it should be

Targets on 7 days of the maintainer's logs, with pull request 1 merged:

- The search page is ready within 15 seconds.
- The goal page is ready within 20 seconds.
- Turning the switch on takes about the same time again.
- Each replay opens within 5 seconds.

The pull request reports the measured times. If any page takes more than twice its target, the pull request waits with a `decision` label and one line saying what's slow and what fixing it would take.

## Not in this plan

- **Zoom levels for Claude and Codex**, meaning saved views of the work at a chosen level of detail that an agent can read. `zoom-go` hasn't been given.
- **Ways to load more history.** This means picking a start point, following new logs as they're written, loading all history in chunks, and caching each parsed file. These come next. Until then, the window is set by `--days` or `--from`/`--to`.
- **Suggesting goals to a first-time user** who has none.
- **Updating the phone demo page.** `demo` hasn't been given.
- **Letting a person's name match inside file names.** `names-in-files` hasn't been given.
- **The prototype's older pages**: the three-option chooser, the turn ledger, and the week grid.
- **Any release, version tag or npm publish.**

## Definition of done

**Pull request 1**

- The side-by-side and byte-identity checks above pass.
- `node --test` passes, and checks pass on Node 18, 20 and 22.
- An independent review comes back clean.
- The redacted goal-page build time is measured again before and after the change.

**Pull request 2**

- The straddling-name test passes at every cut point.
- `node --test` passes, and checks pass on Node 18, 20 and 22.
- An independent review comes back clean.

**Pull request 3: the click-through test**

- **On the demo**, at desktop and phone width:
  - zero failures and zero console errors;
  - zero skips, except steps on a short named list that can't apply to the demo (the list is in the test file and the pull request quotes it);
  - every search, goal, replay and record step passes, including opening the demo's display-only and outside sessions with the switch off and on;
  - zero content-policy violations: the test counts each one as a failure.

  I read the results myself; a helper's report doesn't count. The pull request reports the pass, fail and skip counts.
- **On the maintainer's real logs**, on that machine only:
  - With the switch off and on, there are no failures, and skips only from the named list.
  - The leak counter (below) finds zero private words with the switch off.
  - It finds zero secrets with the switch on.

  Only the counts go in the pull request.

**Pull request 3: the leak counter**

One function, used by both the node tests and the self-test:

- With the switch off, it counts configured terms, names and codenames (including inside longer words), home-folder paths, and email addresses.
- With the switch on, it runs the secrets-only redactor over the answer a second time. Zero means the second pass changes nothing. Counting pattern matches doesn't work here, because correctly hidden text and the ids the switch is meant to show, such as session ids and commit ids, still match those patterns.

The test data includes made-up private terms, made-up secrets, and the ids the switch is meant to show, so a zero means something.

**Pull request 3: named tests**

- **Security:**
  - another site's request is refused;
  - another address's request is refused;
  - the content policy is sent;
  - a request type other than reading is refused;
  - a malformed address gets an error, not a crash;
  - a path outside the page is refused;
  - private text is served only when asked for.
- **Switch and cache:**
  - The switch changes no session, link or goal.
  - A thread opened with the switch on, then off, comes back with zero private words; the same holds for a record and a goal.
  - The cache drops its least recent thread when full.
- **Restart:** start the command, save the switch as on, restart it on the same port, and the new run treats the saved setting as off. This is a node test, because the click-through page can't restart the command.
- **Run key:**
  - A data request without the run key is refused, even with a correct Host header.
  - The status answer doesn't reveal the key.
- **Failed build:** a forced failure of the private build still serves the redacted answer, with a note, never an error or a hang.
- **Address:** the address never contains the typed words, a goal id or title, or a clicked reference's text. This is checked both in the click-through test and by reading the page code.
- **Privacy everywhere:**
  - Every redacted answer the command can give has zero leaks.
  - With the switch off, a display-only or outside session's replay and record (command output included) carry only the kind and time of each step, and no text. With it on, they carry text.
  - A made-up private term placed across the point where an excerpt is cut leaves no part of itself in the excerpt.
  - The goal and replay data carry no original log lines. The goal page reads none until a record is asked for.
- **Search and goals:**
  - A word from a demo goal's title returns that goal.
  - A lookup's ambiguous flag reaches the page, and so does a goal member's.
  - A goal listed beside a lookup result shows that session's level and ambiguity in the goal.
  - Every goal member's shown level equals the engine's.
  - A goal you assigned shows as yours.
  - A goal-list citation the logs don't back shows as missing, with its reason. Two cases are tested: a session cited by id that isn't readable in the window, and a goal entry whose time no call covers.
  - A goal whose id contains a private term opens before and after the switch flips, and two goals whose ids redact to the same text stay separate.
  - Every row and count in the word, search-everywhere and home answers carries one of the five evidence words.
  - A step whose time was borrowed from a neighbouring line, or moved after the call that started it, is labelled that way.
  - With no thread chosen, the replay opens the most recent thread, or the empty state.
  - Every replay event carries each field the ported pages read.
  - An empty result names the window.
  - With no goal list, the goal page shows its empty state.
- **Demo:**
  - A demo run returns nothing from a realistic session placed in the default log folder.
  - `--demo` with `--goals` or any other refused option exits with an error.
  - Every demo page carries the made-up-data notice and the install commands, and no page outside demo mode does.
- **No config:** `view` with no config file exits with the message naming `init` and `--demo`.
- **Pages:** no shipped page or script contains an inline style, an inline script, or an inline event handler.
- **Record panel:**
  - A record for a command step includes its shortened, redacted output.
  - A count's level equals the engine's level.
  - A prompt with a recorded human origin says "You".
  - A prompt from a non-interactive run says "a person or a script".
  - A prompt with no recorded origin says "You", marked inferred.
- **In the click-through test:**
  - every chart step can be focused and opened with Enter;
  - each chart's step list has one item per drawn step.

**Pull request 3: the rest**

- `node --test` passes, and checks pass on Node 18, 20 and 22.
- Existing output is unchanged. The weekly summary, its preview server, the goals page and the client report (the printable account of work for one client) all write the same bytes as before.
- The command's help text meets the published voice bar.
- **Docs:**
  - the README: the command, its options, the goal-list format, the new config setting for a goal list, and the privacy section;
  - the skill file that tells Claude how to use honestweek;
  - the plugin manifest's list of commands;
  - the security and contributing guides, which today name the preview server as the only local server;
  - the no-network rule in the agent conventions file;
  - the example config;
  - the engine doc;
  - the demo-week doc, whose line saying the engine doesn't read a goal list is already out of date.

  This plan becomes the page's own doc, rewritten to describe what was built. The file names are listed under Implementation detail.

**How both land**

- Each pull request is on a fresh branch off main.
- Approving this plan approves opening these three pull requests: "Make redaction fast on short text", "Redact engine text before cutting it short" and "A local page to find, check and replay your agent work". Each body follows `AGENTS.md`.
- Each merges once every Definition of done item above holds, with the real-log counts and measured times in its body. An independent review must also be clean, checks must pass on its head commit, and every automated review comment must be answered.
- A pull request waits for you only on a speed miss or a judgment call. Then you get a direct ask: a `decision` label, a mention, and a desktop notice. It ends with the one-word replies that settle it, such as `ship-slow` (merge with the measured times in the README) or `fix-speed` (make the named fix first).

## Implementation detail

**Pull request 1, on branch `feature/fast-redaction`**

- `lib/redact.mjs` step 10, around line 242:
  - replace `s.matchAll(re)` with an `exec` loop;
  - check each term's words against `s.toLowerCase()` before running its patterns.
- The precheck's words come from the exact split `termMatchers` uses (export it), so a term with a tab or other whitespace inside is checked word by word, just as its pattern joins them.
- Why the check is safe: `termMatchers` compiles every pattern with flags `gu` and no `i`, and builds case-insensitivity from explicit ASCII classes. So for an all-ASCII term, no non-ASCII character can stand in for one of its letters. A test asserts both facts: every pattern's flags are `gu`, and every class built for an ASCII term holds only ASCII.
- A term with any non-ASCII character always runs its patterns. As a hedge against a future `i` flag, so does any text containing a character that `/iu` case folding or `toLowerCase` maps onto an ASCII letter; the test derives that set by scanning every code point.
- The side-by-side generator includes a term with a tab inside and mixed-case glued words.
- `lib/replay/index.mjs` `record()`: find the event through a `Map` built once, instead of `h.events.find`.
- New test file `test/redact-fast-path.test.mjs`: the side-by-side property test against a copy of the old step 10 kept inside the test, plus the byte-identity runs.

**Pull request 2, on branch `feature/redact-before-cut`**

- `lib/replay/claude.mjs:132` and the matching line in `lib/replay/codex.mjs` (`red(clip(s, max))`) become: redact the whole string, then clip it with a helper that steps the cut back to before any `[redacted:` marker it would split. The helper goes in `lib/replay/parse-common.mjs`.
- `record()` in `lib/replay/index.mjs` redacts before `project()` cuts at 2,000 characters, using the same helper.
- New `test/redact-before-cut.test.mjs` covers the straddling name at each cut length (600, 400, 300, 160 and 2,000), plus byte-identity on the demo week and corpus.

**Pull request 3, on branch `feature/local-page`: the command (`lib/view.mjs`)**

- It default-exports `run(argv, io)`, like the other commands.
- Registration:
  - add `view` to `SUBCOMMANDS` in `bin/honestweek.mjs`;
  - add it to `SELF_HELP`, since it prints its own help;
  - add a line to `USAGE`;
  - update the sorted list in `test/docs.test.mjs:129`;
  - add `view` to the `--help` list in `test/cli.test.mjs:70`.
- Flags: `--config`, `--days`, `--from`, `--to`, `--timezone`, `--goals`, `--port`, `--no-open`, `--demo` and `--self-test`.
- The port parser is its own, with a `view:` message, so `preview.mjs` doesn't change. It imports only `defaultOpener` and `browserOpenCommand`, which are already exported.
- Exit codes: 0 on Ctrl+C, 1 for a setup error, including a missing config, a demo flag clash and a wrong goal-list format.
- Docs to update: `README.md`, `SKILL.md`, `.claude-plugin/marketplace.json`, `SECURITY.md`, `CONTRIBUTING.md`, `AGENTS.md`, `honestweek.config.example.json`, `docs/work-history-engine.md` and `docs/demo-week.md`. This plan becomes `docs/local-page.md`.
- A hold goes through the `ask` skill.

**Config**

- An optional `goalsFile` key in `lib/config.mjs`. Additive: a config without it behaves as before.
- A file that fails `normalizeGoalRecord`, or looks like the goals-page registry, gets a named message.

**The server: `lib/view/server.mjs`**

- It binds to `127.0.0.1` only. It accepts only GET and HEAD, except one POST route that exists only with `--self-test`.
- It answers 403 unless `Host` is `127.0.0.1:<port>` or `localhost:<port>`, and answers 403 on `/api/*` when `Sec-Fetch-Site` is `cross-site` or `same-site`.
- The run key is 32 random bytes made at start with `crypto.randomBytes`. The opened address carries it in the fragment (`#k=`), so it never reaches the server's logs or the `Referer` header. The page moves it into `sessionStorage`, removes it from the address, and sends it as an `X-Honestweek-Key` header on every `/api` request. `/api/*` answers 403 without it, and it's compared in constant time. `--no-open` prints the full address, key included.
- Routes come from a fixed table. Assets come from a fixed list read once at start. Nothing joins a path from the address.
- Every response carries:
  - the CSP `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`, plus `frame-src 'self'` with `--self-test`;
  - `nosniff`, `no-referrer` and `no-store`.
- API answers are `application/json` and are fetched, never served as script.
- A malformed address gets 400. A handler error gets 500 with no stack trace.

**Data: `lib/view/data.mjs`**

- It's the only file that turns `private=1` into `privateText`. Browser files never use that name.
- It holds one engine build per mode, `buildWorkHistory({config, roots, from, to, timezone, scope: 'all', goals, privateText})`, with `roots` and the window always passed in explicitly. The private build starts on the first `private=1` request. Any other value, or none, gives the redacted build.
- The replay cache holds 32 threads per mode.
- Routes:
  - `/api/status`: build state and elapsed time, plus `failed` with a short, redacted reason when a build throws. A failed private build leaves `private=1` requests served from the redacted build, with a note. It never returns the run key.
  - Goals are addressed by a goal key: a letter hash of the raw goal id, computed in `data.mjs` from the raw goal record, and the same in both builds. The redacted id is never used as a key. That matters because `h.goals` ids pass through the redactor, so two ids can redact to the same text and a redacted id isn't found in the private build. Goals attached to lookup and word results come from session membership in `h.goals[i]`, whose order `goalMembership` keeps the same in both builds.
  - `/api/home`:
    - window and coverage: sessions read, excluded by role, files left unnamed;
    - goals and recent sessions;
    - "Try" examples taken from the most common references.
  - `/api/lookup?q=`: `h.lookup(q)`, keeping `ambiguous` and the notes. Its `goals` field is bare ids (`lib/replay/index.mjs:353-357`), so for each listed goal the route attaches the matched session's member row from `h.goals` (`evidence`, `ambiguous`, and whether the join is `cited-session`) and the goal's title. `/api/words` does the same.
  - `/api/words?q=`:
    - goal title and id matches, session title matches, branch substring matches;
    - prompts scored by shared words over the engine's prompt text (its first 600 characters), each with its event id and its session's goals from `h.goals`;
    - similar-prompt scores.
  - `/api/goal?key=`: `h.goal(id)` with each member's `evidence`, `ambiguous` and join types, the goal's `unmatched` citations with their reasons (shown as missing), plus the member sessions' events, agents, turns and per-session frames (from `h.threadTimeline(...).stateAt`). It carries no records.
  - `/api/replay?thread=|session=`: built by `lib/view/replay-export.mjs`, a port of the prototype's thread export. It carries `thread` (id, title, first and last time, metrics, outcomes, missing, links), `session` and `sessions` with turns, `agents`, and `events`. Each event has id, time, end time, kind, `group`, `cat`, actor, agent, turn, tool, result, `outcome`, short text, evidence, inferred and missing keys, test counts, `patch`, `spanMs`, `harnessMs`, `timeFrom`, `clock`, and the engine's already-redacted `facts` and `derived`, which are skeletons for display-only and outside sessions with the switch off. With no `thread` or `session`, it returns the most recent thread in the window, or `null` with the window. It also carries frames sampled at each event, `rules`, `timezone` and `coverage`. It carries no records.
  - `/api/record?event=`: `h.record(id)`, plus the result line of a tool call.
  - `/api/search?q=`: search everywhere.

**Search everywhere: `lib/view/word-index.mjs`**

- It's given the same `roots` and window as the build, and reads prompts and titles line by line. The text stays in memory only.
- A hit's label (configured, display or outside) and its session key come from the build's `sessions[]` (`repoRole`, `private`, `h.sourceSession`), not from a second folder matcher.
- Snippets are redacted whole before they're cut: `createRedactor(config)` with the switch off, `createSecretsOnlyRedactor()` with it on.
- A hit with no session in the build says "not in this window". No second history is ever built.

**The leak counter: `lib/view/leaks.mjs`**

- Switch off: `termMatchers` over the configured terms, names and codenames, plus the home-path and email patterns from `lib/redaction-patterns.mjs`.
- Switch on: `createSecretsOnlyRedactor().redact(text) === text` over every string in the answer, comparing text rather than `.count`, since the count isn't stable on its own output.

**Fences**

- Privacy fence: add `lib/view/data.mjs`, `lib/view/word-index.mjs` and `lib/view/leaks.mjs` to the files allowed to name `privateText` and `createSecretsOnlyRedactor` (`test/private-text.test.mjs:415-426`), with a comment saying why.
- Clean-room fence (`test/site-cleanroom.test.mjs:79-88`): add `lib/view/`, including `assets/` and `selftest/`; `lib/demo/`; and `docs/local-page.md`.

**Demo: `lib/demo/week.mjs`**

- Moved from `tools/demo-week.mjs`, which keeps re-exporting it.
- `--demo` passes `buildDemoWeek()`'s roots, config, goal record and week to both the build and the word index.
- For that run only, it adds one made-up client name as a redaction term, so the switch has something to show.
- It removes the temporary folder on exit.

**Pages: `lib/view/assets/`**

- Ports of the prototype's `search.html`, `goal.html`, `lanes.html` (renamed `replay.html`), `common.css`, `common.js`, `evidence.js` and `private-text.js`.
- Inline scripts move into files. Every `<style>` block moves into `common.css`, and every static `style=` attribute becomes a class. Geometry that changes at run time is set through `el.style` or SVG attributes, which the content policy allows.
- Data loads with `fetch`. The switch lives in `sessionStorage` under the current run key, so a key from an earlier run finds nothing.
- Addresses hold only letter-hash ids (thread, session, event and goal key). The typed query and any clicked reference text stay in memory or `sessionStorage`, never in `location`. The prototype's `#q=` step is dropped.
- In-browser lookup and goal-membership code is replaced by the routes above.

**Self-test: `lib/view/selftest/clickthrough.{html,js}`**

- Ported from the prototype and served only with `--self-test`.
- The search word comes from the server and is never put in the address.
- The named skip list lives in the file.
- Each frame listens for `securitypolicyviolation` and counts every one as a failure.

**Node tests**

- `test/view-server.test.mjs`
- `test/view-data.test.mjs`
- `test/view-cli.test.mjs`
- A byte-identity test for `preview`.

Data tests run on `test/fixtures/replay/corpus.mjs` and the demo week, seeded with made-up private terms and secrets.
