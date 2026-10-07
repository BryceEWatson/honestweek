# Mining solved problems (`mine`)

A flow of the honestweek skill. The safety invariants in `SKILL.md` apply throughout.

Commands in this file are written with the skill folder placeholder, the dollar sign and `CLAUDE_SKILL_DIR` in braces. This file is read as a plain file, so the placeholder isn't filled in here: use the skill folder `SKILL.md` names, under "Running the bundled CLI".

A separate, optional flow from the weekly digest. It searches the user's agent session logs for moments where software they did **not** write failed and they worked out the fix: the kind of thing a stranger will hit and search for.

```bash
node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" mine            # report the undecided backlog
node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" mine --draft    # write the top one up
```

- Findings live in `honestweek.findings.json`. The number to report is the **backlog** (findings not yet accepted or declined), not how many this run found. Only the user deciding can lower it: `mine --decide "<key>=published"` or `=declined`.
- **Exit `2` means the sensor was blind:** a configured log corpus resolved to a real directory holding zero logs. Never report that as "nothing found this week"; say the corpus was empty and check the root.
- Every run prints a retention floor: the oldest session still on disk. Nothing before it can ever be mined, because the agent deleted it.

Full detector, ranker, and calibration notes: `docs/mining.md`.
