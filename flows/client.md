# A report for a client (`client` mode)

A flow of the honestweek skill. The distillation contract and safety invariants in `SKILL.md` apply throughout.

Commands in this file are written with the skill folder placeholder, the dollar sign and `CLAUDE_SKILL_DIR` in braces. This file is read as a plain file, so the placeholder isn't filled in here: use the skill folder `SKILL.md` names, under "Running the bundled CLI".

A separate flow for work you did for someone else: a light, printable report of one period (a sprint, a month, the contract to date) that you hand to the client. Run it from a folder that holds that client's own `honestweek.config.json` (with a `client` block and `"output": { "mode": "client" }`), never from the weekly one.

1. **`history`** *(output: the gitignored `honestweek.history.json`)*: `node "${CLAUDE_SKILL_DIR}/bin/honestweek.mjs" history --from <YYYY-MM-DD> --to <YYYY-MM-DD>` lists every pull request the user authored that landed on each featured/reference repo's default branch in the period. Read the pull requests' own descriptions when you need more than the title.
2. **DISTIL for a client** *(output: `honestweek.items.json`)*: `{ "period": {start,end}, "content": {...}, "items": [...] }`.
   - `content.title`, a one-sentence `content.headline` (the outcome, in the client's terms), two or three `content.summary` paragraphs, `content.themes` (`[{ "id", "title", "summary" }]`, the five to ten areas the work falls into, each summary saying why the area matters to them), and optional `content.next` (planned work; the page labels it planned and counts none of it).
   - One item per meaningful change, usually one to three related pull requests: `repo` (the config label), `theme` (a theme id), `title` (what changed, not how), `summary` (what it means for the people using or running the product), `status`, `commits` (the squash-merge SHAs from the history file), and `receipt: { "primaryCommit": <one of them> }`. Mark the three to six that matter most `"highlight": true`.
   - Write for the client, not for engineers: no internal jargon, file names, or tool names. Every rule of the distillation contract still holds: under-claim, cite what landed, never assert an outcome the evidence doesn't show. "Merged" means on the main branch, not released; say "released" only where a release is on record.
   - Leave out anything that isn't the client's business: billing, rates, invoices, other clients, personal matters. Add those words to `redaction.terms` so `validate` stops a leak at the source.
3. **`validate`**, **`build`**, then **`preview`**. `build` verify-or-aborts every cited commit, aborts on a cited commit dated outside the period, and derives every number on the page from git. The appendix lists every pull request in the period and marks the ones your items describe, so check that the uncited ones really are minor.

4. **Shape it for the reader** *(optional; `honestweek.reader.json`)*: when you know who the report is for, write their profile from evidence, never from a hunch dressed as fact. Put their questions first as sections (prefer `"select": { "issues": [...] }` with the issue numbers they filed or asked for, which git can check against commit messages) and set `"format": { "note": true }` if they read updates in a shared document. Give every section and guidance line a `source`: `their-words` or `your-notes` with a `ref` saying where, or `guess`. Follow the profile's `guidance` when writing items, and never change a status, date or number to suit a reader. See `docs/reader-profiles.md`.

The user reads the report and sends it themselves.
