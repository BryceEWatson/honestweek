# Reader profiles: one set of checked facts, many readers

Status: design only. Nothing here is built yet. The first real test is described under [Build order](#build-order).

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

A profile made only of guesses is shown on the page as unconfirmed, and the cheapest fix is to ask the reader. A profile should get more accurate each time it's used, not be re-guessed each time.

## What git can and can't answer

Some reader questions can be answered straight from git: what landed and when, and which pull request it came in with when the commit message names one. Others can't: whether the product is ready for more users, what it costs to run, whether a request came from this reader. Those sections are written by a person from items that still carry receipts, and each one says it was written, not counted. honestweek will not present a written answer as a measured one.

## What this could replace later

Today honestweek has an output mode for each kind of report: post, changelog, digest, report, page, site and client. Most of them are really a reader plus a format. Once reader profiles exist, new audiences should become add-ons rather than new modes. Collapsing the existing modes into profiles is a separate decision for later. It isn't part of this design, and existing output must stay byte-identical either way.

## Build order

The general version waits for evidence. Right now there is one client report and its reader hasn't seen it.

1. **Ask the first reader.** Four questions: do they want a periodic report at all, and how often; who else reads it; whether hours belong in it or only on the invoice; and whether writing it counts against the agreed hours. Their answers become the first lines of their personal add-on, sourced as their words.
2. **Build the smallest useful piece.** The default profile plus the client add-on, inside the existing client report: sections chosen by tag, hidden items counted, and the six rules enforced by `build`. Nothing else.
3. **Wait for a second, different reader.** A prospect reading the public weekly log is the likely one. Only when two real profiles exist do the reader-type add-ons, the personal-add-on file and the short-note format become general features, designed from two real cases instead of one guess.

What would change this plan: if the first reader says they don't want a report, step 2 shrinks to the short-note format alone. If no second reader type appears, the general layer isn't built.

## Open questions

- Should tags for extra questions ("requested by this reader") live on items, or be derived from issue references in commit messages, which git can check?
- How does a personal add-on travel between machines, given it's private and holds a real person's preferences?
- Is one plain-language description per item enough for every reader, or does a technical reader (a handoff) need a second, more detailed field? The current bet is that plain descriptions plus links to the pull requests are enough.

## Implementation detail

Nothing below exists yet. It's a sketch for step 2.

A profile file, `honestweek.reader.json`, beside the report's `honestweek.config.json`:

```jsonc
{
  "extends": ["client"],                // reader-type add-ons, applied in order after the default
  "reader": "Their role, not their name", // shown nowhere; for your own reference
  "sections": [
    { "id": "requests", "title": "Your requests", "select": { "tag": "requested" },
      "source": { "kind": "their-words", "ref": "meeting 2026-08-21" } }
  ],
  "order": ["requests", "done", "not-finished", "next", "needs-you", "record"],
  "done": "merged",                     // or "released"; may only get stricter than the layers below
  "exclude": { "themes": ["internal-tooling"] },
  "format": { "maxItems": 12, "note": true },
  "guidance": [
    { "text": "Plain language; thinks in terms of testers and rollout stages", "source": { "kind": "guess" } }
  ]
}
```

- Shipped add-ons would live under `lib/readers/` as JSON (default, client, manager, public, handoff), validated by the same config loader, with no executable content.
- `lib/client.mjs` would gain an `applyView(model, profile)` step after `buildClientModel`: select and order sections, count hidden items into the model, and fail with `ClientReportError` when a rule in "Rules no add-on can break" would be broken.
- Items would gain an optional `tags` array. `validate` would reject a tag no profile section uses, so a typo can't silently drop an item from a view.
- Tests needed: same badges and numbers across two views of one report; hidden counts match; a looser `done` in a later layer is refused; an unconfirmed-only profile renders the unconfirmed notice; existing modes stay byte-identical without a profile file (the same all-modes loop as `test/digest.test.mjs`).
