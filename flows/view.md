# Finding and replaying work (`view`)

A flow of the honestweek skill. The safety invariants in `SKILL.md` apply throughout.

Commands in this file are written with the skill folder placeholder, the dollar sign and `CLAUDE_SKILL_DIR` in braces. This file is read as a plain file, so the placeholder isn't filled in here: use the skill folder `SKILL.md` names, under "Running the bundled CLI".

When the user wants to find the sessions behind a pull request, a commit, a file, a branch or a phrase, see which sessions worked toward a goal, or replay a session step by step, start the local page:

```bash
node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" view                     # the last 7 days; opens the browser
node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" view --days 30 --goals goals.json
node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" view --demo              # a made-up week, no logs or config needed
```

- It serves on `127.0.0.1` until Ctrl+C, so run it in the background or let the user run it in their own terminal. It prints an address carrying a one-time code; each code works once, and pressing Enter in that terminal prints a fresh one. Give that address only to the user's own browser.
- With no config to read, the page that opens is Setup, which writes the config when the user presses Save (`init` asks the same questions in a terminal).
- Every command reads `honestweek.config.json` in the folder it runs in, else the file `HONESTWEEK_CONFIG` names, else `~/.honestweek/honestweek.config.json` (written by `init --user` or Setup's "Every folder"); `--config <file>` names one instead. Each names the config it read in one line on stderr, and writes its files beside that config, never in the folder it ran in. So from another project, the user's every-folder config just works; don't copy it into the project.
- `--goals <file>` (or `goalsFile` in the config) names a goal list: `{ "goals": [{ "id", "title" }], "events": [] }`. It's a different file from the goals page's `honestweek.objectives.json`.
- The page is redacted unless the user turns on Show private text. Don't copy what it shows into anything you write for someone else, and don't flip the switch for them.
- Every link, count and step on it says how it's known (recorded, derived, inferred, missing, or ambiguous). When you report what it shows, keep that word: an inferred link is not a recorded one.
