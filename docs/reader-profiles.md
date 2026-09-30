# Reader profiles: one set of checked facts, many readers

Status: step 2 is built, inside the client report (`output.mode: "client"`). Reader types beyond the default and the client still wait for a second real reader. See [Build order](#build-order).

## In plain terms

honestweek writes reports about work: a weekly log for yourself, or a report for a client. Different people read those reports for different reasons. A client wants to know whether what they asked for got done, a manager wants to know what's at risk, and a teammate taking over wants to know what's unfinished. This design lets you describe a reader once, in a small file called a *reader profile*, and have honestweek shape the same report around that reader's questions. The facts never change from one reader to the next. Only the choice, order and length of what's shown do, and anything left out is counted on the page.

## Why this exists

The first client report honestweek built was accurate, but it was organized the way the engineer thinks about the work: by technical area, 36 changes long. When we then looked at what that client had actually said and done, their questions were different and fewer. Had their own requests been done? Was the product safe to open to more people? What would next month's hours go to? They had never asked for a report at all, and their preferred place for updates was a short note at the top of a shared document.

Nothing in the report was wrong. It answered the wrong reader's questions. A report that is honest but unread doesn't help anyone, so honestweek needs a way to point the same honest facts at the person who will actually read them.

## The idea: one set of checked facts, many views

honestweek already separates two things:

- **Items**: the individual pieces of work in a report. Each one has a *status badge* (shipped, in progress, or designed but not proven) and a *receipt*, which points to the commit or session it came from. `build` checks every commit an item cites against git (it has to exist, be yours, and be on the main branch to count as shipped) and refuses to write anything if one doesn't hold up. A receipt that points to a session is carried along as a pointer to its source; it isn't checked against git.
- **Output**: how those items get rendered, as a post, a changelog, a weekly page, or a client report.

A *view* is a third thing that sits between them: for one reader, which items are shown, under which headings, in what order, and at what length. A reader profile describes a view. It never touches the items themselves, so every view of a report is built from the same checked items with the same badges and the same numbers.

## The default profile

Every report starts from the default. It answers the questions nearly every reader has, in this order:

1. **What got done.** Work that's merged, grouped by area, each change naming the pull requests and commits it came from.
2. **What isn't finished.** Work in progress, and work that's designed but not proven, labelled as such.
3. **What's next.** Planned work, marked as planned and never counted in any number.
4. **What's needed from you.** Decisions or approvals the work is waiting on.
5. **The full record.** Everything of yours that landed in the period, with the parts described above marked, plus the counts read from git. Where commit messages name their pull requests (squash and merge commits on GitHub do), the record is a list of pull requests; where they don't, it's a list of commits, because honestweek reads only local git and can't ask a hosting service.

The default also fixes the rules every view keeps (see [Rules no add-on can break](#rules-no-add-on-can-break)).

## Add-ons

An *add-on* is a small file that adjusts the default for one kind of reader, or for one person. There are six kinds of adjustment:

| Kind | What it does | Example |
| --- | --- | --- |
| Emphasis | Reorders or pins sections | A client sees "your requests" first; a security reviewer sees open risks first |
| Extra question | Adds a section that gathers items by tag | "Your requests", "Cost to run", "Ready to widen the rollout?" |
| Stricter definition | Tightens what a word means for this reader | "Done" means released, not just merged |
| Exclusion | Hides areas or terms from this reader | Leave internal tooling out of a client's view |
| Format | Changes length and shape | A five-line note for a shared document, a length cap, a printable page |
| Writing guidance | Tells the writer what this reader cares about and which words they use | "Plain language; they think in terms of testers and rollout stages" |

Writing guidance is the only kind that affects wording, and it only steers how items get written in the distil step (where a model turns sessions and commits into items). It can't change a badge, a date or a number.

### How add-ons stack

Add-ons apply in layers:

1. **The default profile.**
2. **A reader-type add-on** that ships with honestweek: client, manager, public log, or team handoff.
3. **A personal add-on** for one named reader, kept privately beside that report and never shipped.

Later layers win on emphasis and format. On anything to do with honesty, a later layer can only make the rules stricter. If two layers disagree about what "done" means, the stricter one wins.

A client with specific habits would be the default, plus the client add-on, plus their own: their requests first, a proposed scope for next month's hours, a short note for their shared document, and their vocabulary. The weekly public log would be the default plus the public-log add-on. That's close to what the weekly page already does, which is a useful check that this design covers what exists instead of adding a second way to do it.

### Add-ons are data, not code

A shipped add-on is a small declarative file that anyone can read in a review, like the site adapter's field map. It can name sections, tags, order, limits and guidance. It can't run code. That keeps a reader type from carrying logic that could quietly work around the checks.

## Rules no add-on can break

These hold in every view, and `build` enforces them rather than trusting the prose:

1. **Same facts everywhere.** An item's status badge, dates and every number are identical in every view of the same report.
2. **Hiding is counted.** A view may leave items out, but it says how many it left out and why ("4 changes not shown: internal tooling").
3. **The full record is always reachable.** Every view links to, or includes, the complete list of work in the period.
4. **Definitions only get stricter.** An add-on can make "done" mean released; it can never make "in progress" read as done.
5. **Planned is never counted.** Anything in "what's next" stays out of every number.
6. **Sections say where they came from.** A section counted from git says so; a section a person wrote says so.

If a view would break one of these, `build` stops and writes nothing, the same way it does for a commit it can't verify.

## Where a profile's knowledge comes from

honestweek can't work out what a reader wants. Doing that for the first client took their emails, meeting notes and contract, which are private, and honestweek only reads your repos and your local session logs, with no network access. So honestweek never infers a profile. It holds one you write, and it treats each line of a personal add-on the way it treats an item: it has to say where it came from.

Every question or guidance line in a personal add-on carries one of three sources:

- **Their words**: something the reader said or wrote, with where (a meeting, an email, a comment).
- **Your notes**: your own record of what they asked for.
- **A guess**: your inference, not yet confirmed.

When everything in a personal add-on is a guess, `build` says so on the command line: this view of the reader is unconfirmed. It doesn't say so on the reader's page, because the note is for the person writing the report, not for the reader. A profile should get more accurate each time it's used, not be re-guessed each time: when the reader says something that confirms or corrects a line, change its source.

## What git can and can't answer

Some reader questions can be answered straight from git: what landed and when, and which pull request it came in with when the commit message names one. Others can't: whether the product is ready for more users, what it costs to run, whether a request came from this reader. Those sections are written by a person from items that still carry receipts, and each one says it was written, not counted. honestweek will not present a written answer as a measured one.

## What this could replace later

Today honestweek has an output mode for each kind of report: post, changelog, digest, report, page, site and client. Most of them are really a reader plus a format. Once reader profiles exist, new audiences should become add-ons rather than new modes. Collapsing the existing modes into profiles is a separate decision for later. It isn't part of this design, and existing output must stay byte-identical either way.

## Build order

1. **Model the first reader from the evidence, without asking.** The plan was to ask four questions first. The owner decided instead to build from what the record already shows (2026-09-30): the reader's own bug reports and requests, what they said in meetings, and how they reacted to past updates. Every line of that personal add-on carries its source, so what's a guess stays visible to the author.
2. **Build the smallest useful piece (built).** The default profile, the client add-on and a personal add-on file, inside the client report: extra sections picked by git (issue numbers named in commit messages) or by hand (tags), areas left out and counted, a "what I need from you" section, a "not finished" list, and a short note for readers who read updates in a shared document. The first reader's evidence called for the personal file and the note, so they came into step 2 rather than waiting.
3. **Wait for a second, different reader.** Reader types beyond default and client (manager, public log, team handoff) are designed from two real cases, not one guess. A prospect reading the public weekly log is the likely second.

What would change this plan: if the first reader shows no use for the full report, the short note becomes the main output for them. If no second reader type appears, the general layer isn't built.

## Open questions

- Settled: an extra section can pick items either way. Issue numbers named in commit messages are preferred, because git can check them; hand tags on items cover work no issue names.
- How does a personal add-on travel between machines, given it's private and holds a real person's preferences?
- Is one plain-language description per item enough for every reader, or does a technical reader (a handoff) need a second, more detailed field? The current bet is that plain descriptions plus links to the pull requests are enough.

## Implementation detail

What's built (step 2). A profile file, `honestweek.reader.json`, sits beside the report's `honestweek.config.json`:

```jsonc
{
  "extends": ["client"],                  // shipped reader types, applied in order after the default
  "reader": "Their role, not their name",   // for your own reference; shown nowhere
  "sections": [
    { "id": "requests", "title": "Your requests", "summary": "Things you reported or asked for.",
      "select": { "issues": [12, 14] },       // picked by git; or { "tags": ["requested"] }, picked by hand
      "source": { "kind": "your-notes", "ref": "review notes, April" } }
  ],
  "order": ["requests", "needs-you", "highlights", "done", "not-finished", "next", "record", "how"],
  "exclude": { "themes": ["internal-tooling"] },
  "format": { "note": true },               // also write <report>.note.md, a few lines for a shared document
  "guidance": [
    { "text": "Plain language; thinks in terms of testers and rollout stages", "source": { "kind": "guess" } }
  ]
}
```

- `lib/reader.mjs` loads and validates the layers (`lib/readers/default.json`, `lib/readers/client.json`, then the personal file) and resolves them: later layers win on order and format, sections replace by id, exclusions and guidance add up, and `record` and `how` are appended if an order leaves them out. Unknown keys, a `done` key, a missing or wrong `source`, a section id that shadows a built-in, and an `order` naming an unknown section all fail with `ReaderProfileError` (build exits 2 and writes nothing). A `shipped` source is reserved for honestweek's own add-ons.
- `lib/client.mjs` `applyView` runs inside `buildClientModel`. It never edits an item. It refuses an exclusion that names no area and an item tag no section picks, counts hidden items into the model, and marks a pull request "described above" only when an item on this view cites it. Issue numbers come from each cited commit's full message (`commitMessage` in `lib/git.mjs`, `issueRefs`), minus the commit's own pull-request number.
- `lib/emit/client.mjs` renders sections in the profile's order and writes the note (`renderNote`); `lib/build.mjs` writes it beside the report and prints the unconfirmed notice.
- The items file gains optional `content.needs` (shown under "What I need from you", never counted) and optional item `tags`.
- Not built: `format.maxItems`, a stricter `done` (honestweek can't see releases), and reader types other than default and client.
- Tests: `test/reader.test.mjs` (same entries, numbers and statuses across two views; git-picked section; counted exclusion; record and method kept; nine refused profiles; tag typo; unconfirmed notice; the note; other modes byte-identical with a profile present).
