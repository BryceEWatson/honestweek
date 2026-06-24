# honestweek

Turn a completed week of your AI coding **sessions** into an honest, git-verified, private-by-default work summary — including the figured-out-but-not-yet-shipped work your commits can't show.

honestweek is a locally-run, Claude-Code-native tool, shipped as a skill that orchestrates small zero-dependency Node scripts. It reads your AI coding session transcripts, distils a completed week into an honest shareable summary, **re-derives every git-checkable claim against your real commits — or aborts**, and produces a draft *you* review and publish yourself. It never auto-publishes.

## Why

Your commits show what shipped. Your sessions show what you *figured out* — the dead ends you ruled out and the work that's designed but not yet proven. honestweek surfaces that honestly, with a status badge on every item (`shipped` / `in progress` / `designed, not proven`) and a receipt (a pointer to its source commit or session) on every line.

## Requirements

- **Node ≥ 18**
- The system **`git` CLI** on your `PATH`
- **Zero runtime dependencies** — Node built-ins plus `git` only
- Runs **entirely locally**. No telemetry, no network egress.

## Install

honestweek runs locally with zero `npm install`. Pick whichever path you prefer.

### As a Claude Code plugin (recommended)

Add this repo as a plugin marketplace, then install — from inside Claude Code:

```
/plugin marketplace add BryceEWatson/honestweek
/plugin install honestweek@honestweek
```

…or from your terminal:

```bash
claude plugin marketplace add BryceEWatson/honestweek
claude plugin install honestweek@honestweek
```

You get `/honestweek` inside Claude Code, with versioned updates via `/plugin marketplace update`.

### As a plain skill

Clone into your personal skills directory:

```bash
git clone https://github.com/BryceEWatson/honestweek ~/.claude/skills/honestweek
```

Either way, when you run `/honestweek` the skill invokes its bundled CLI by a **skill-anchored absolute path** (`${CLAUDE_SKILL_DIR}/bin/honestweek.mjs`), so the commands work from *your own* project directory.

### As a standalone CLI

Run it straight from GitHub — no install, no clone (zero dependencies, so it's quick):

```bash
npx github:BryceEWatson/honestweek --help
npx github:BryceEWatson/honestweek init
```

Or from a clone of the repo:

```bash
# run these from the repo root
node bin/honestweek.mjs --help
```

Once it's published to npm (**not yet** — see [Releasing](#releasing-maintainers)), `npx honestweek` and `npm i -g honestweek` will work too.

The CLI surface is exactly three subcommands: `init`, `discover`, `build`.

## The flow

End-to-end happy path, in order. Each step names the artifact it produces.

> Installed as the skill/plugin? Just run `/honestweek` — Claude drives these steps for you and resolves the CLI path automatically. The raw `node bin/honestweek.mjs …` commands below are for running the CLI directly **from a clone of the repo** (cwd = the repo root).

1. **`init`** → writes `honestweek.config.json` (scaffolded from `honestweek.config.example.json`) for you to fill in and commit. Two confirmations gate the write; accepting the defaults yields a valid config.
   ```bash
   node bin/honestweek.mjs init
   ```
2. **`discover`** → scans the **last completed week's** sessions from your allowlisted repos and writes the gitignored, **redacted** `honestweek.draft.json`. Deterministic — no model call.
   ```bash
   node bin/honestweek.mjs discover          # or: discover --week 2024-W23
   ```
3. **`/honestweek`** (the skill) → **distils** the draft into the human-reviewable `honestweek.items.json`, with a status badge **and** a receipt on every item. This is the one model-judgment step; see [`SKILL.md`](SKILL.md) for the distillation contract.
4. **`build`** → re-derives and **git-verifies every cited commit**. It **aborts with exit code `2`** if any cited commit is unresolved or its `authorEmail` is not in `identity.authorEmails` — writing nothing rather than emit a half-true summary.
   ```bash
   node bin/honestweek.mjs build
   ```
5. **emit** → on success, `build` renders the final **local** output in the configured `output.mode` (`post` / `changelog` / `digest`) to `output.file`. You review it and publish it yourself.

## Sample output

A short, fabricated (clean-room) example. The distilled `honestweek.items.json`:

```jsonc
{
  "week": { "start": "2024-06-10", "end": "2024-06-16" },
  "items": [
    {
      "text": "Auth redirect now keeps the session cookie across the login bounce.",
      "repo": "your-project",
      "status": "shipped",
      "receipt": { "sessionId": "a1b2c3d4", "primaryCommit": "9f8e7d6" }
    },
    {
      "text": "Retry queue for failed webhook deliveries — designed, not yet wired in.",
      "repo": "your-project",
      "status": "designed, not proven",
      "receipt": { "sessionId": "a1b2c3d4" }
    }
  ]
}
```

Rendered to the default `digest` output — every line carries a status badge and a receipt:

```markdown
# Weekly digest — 2024-06-10 to 2024-06-16

## Shipped
- **shipped** — Auth redirect now keeps the session cookie across the login bounce. _(your-project)_  (`9f8e7d6`)

## Designed, not proven
- **designed, not proven** — Retry queue for failed webhook deliveries — designed, not yet wired in. _(your-project)_  (`a1b2c3d4`)
```

## Config reference

You commit your own `honestweek.config.json`. It mirrors `honestweek.config.example.json`:

```jsonc
{
  "identity": { "authorEmails": ["you@example.com"] },     // required, non-empty; the commit-authorship allowlist
  "week": { "startsOn": "monday", "timezone": "UTC" },       // optional; startsOn is "monday" for v0.1; timezone is an IANA zone (defaults to the host zone)
  "repos": [                                                  // required, non-empty
    { "path": "/path/to/your/repo", "label": "your-project", "role": "featured" },
    { "path": "~/code/a-repo-you-contribute-to", "label": "a-shared-repo", "role": "reference" },
    { "path": "~/code/a-client-repo", "label": "a-private-project", "role": "display" }
  ],
  "redaction": { "codenames": [], "names": [], "terms": [] },  // optional; default-empty private term-lists, scrubbed case-insensitively
  "output": { "mode": "digest", "file": "honestweek.digest.md" }  // optional; mode ∈ post|changelog|digest, default digest
}
```

| Field | Meaning |
| --- | --- |
| `identity.authorEmails` | The emails a commit must be authored by to count as yours. `build` aborts on any cited commit not authored by one of these. |
| `week.startsOn` | `"monday"` (the only supported value in v0.1). |
| `week.timezone` | IANA timezone used to compute the week boundary; defaults to your host zone. |
| `repos[].path` | A repo path. `~`/`~/` expands to your home dir; relative paths resolve against the config file. |
| `repos[].label` | The short name items reference and outputs display. |
| `repos[].role` | One of the three trust levels below. |
| `redaction.codenames` / `names` / `terms` | Private tokens scrubbed from all output. Default empty (clean-room). |
| `output.mode` | `post` (build-in-public update), `changelog` (in-repo `CHANGELOG.md` section), or `digest` (the private, local-only weekly file — the default and trust anchor). |
| `output.file` | Where the output is written. Defaults per mode when unset. |

**Repo roles:**

- **`featured`** — git-read **and** git-verified, and headlined in the output.
- **`reference`** — git-read but not headlined.
- **`display`** — summarized generically and **NEVER git-read**. Use it for repos you want acknowledged without reading their commits.

## Sidecars

| File | Status |
| --- | --- |
| `honestweek.draft.json` | The redacted weekly digest from `discover`. **Gitignored** — an intermediate working artifact, never published. |
| `honestweek.items.json` | The distilled, human-reviewable items. **Yours to keep or ignore** (gitignored by default; safe to delete). |
| `output.file` (e.g. `honestweek.digest.md`) | The final rendered output. **Yours to keep or ignore.** |
| `honestweek.config.json` | Your config. Gitignored by default (it can hold private repo paths/terms); un-ignore it if you want it tracked. |

## What it does NOT do / privacy model

- **Only your own allowlisted repos are read.** Nothing outside your `repos` list is ever touched.
- **`display`-role repos are summarized generically and NEVER git-read.** There is no code path that runs `git` against a `display` repo.
- **Output stays local until you publish it.** honestweek writes local files only.
- **No telemetry, no network egress.** Nothing is sent anywhere.
- **Nothing is auto-published.** honestweek produces a draft; *you* are the publisher.

### The launch invariant

honestweek's two non-negotiable promises:

1. **A receipt on every line.** Every emitted item points to its source — a commit SHA or a session turn. An item that reaches the renderer without a receipt is a build error, not a receipt-less line.
2. **It never asserts a motive the log does not contain.** honestweek defaults to **under-claiming**: verified/measured work reads as `shipped`; anything weaker reads as `designed, not proven`. It never narrates intent the transcript doesn't support.

## Releasing (maintainers)

honestweek is publish-ready but not yet on npm. To cut a release so `npx honestweek` / `npm i -g honestweek` work:

1. Bump the version in `package.json` (and `.claude-plugin/plugin.json` to match), commit, and tag: `git tag v0.1.0 && git push --tags`.
2. **Automated:** add an `NPM_TOKEN` repository secret (an npm automation token), then publish a GitHub Release for the tag — the [`release` workflow](.github/workflows/release.yml) runs the tests and `npm publish --provenance --access public`.
   **Manual alternative:** `npm publish --access public` from a clean checkout after `npm login`.
3. The `files` allowlist in `package.json` controls what ships to npm (`bin/`, `lib/`, `SKILL.md`, the example config, the plugin manifests). Tests and fixtures are excluded.

Publishing to npm and cutting a GitHub Release are the only steps that go public — everything else in this repo is local.

## License

[MIT](LICENSE)
