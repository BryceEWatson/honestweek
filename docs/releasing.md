# Releasing honestweek

## In plain terms

This is the checklist I follow to put a new version of honestweek on npm, the public registry that `npx honestweek` and `npm install -g honestweek` download from. A release is four steps in a fixed order: a pull request that sets the new version number, a publish to npm from my own terminal, a check that the published package runs, and then a git tag and a GitHub release that point people at it. The order matters because a GitHub release is public the moment it's created, so it comes last, after the package is already live. Nothing here runs by itself.

The first version on npm is 0.2.0. Version 0.1.0 has a GitHub release, but its npm publish failed and it never reached npm.

## Two ways to publish, and the one I use

**From my own terminal (the one I use).** I log in to npm on my machine and run `npm publish`. npm asks for my two-factor code, so no token is stored anywhere. This is the simplest way to do a first publish, and it's what the steps below describe.

**From GitHub, when a release is published.** The [release workflow](../.github/workflows/release.yml) can publish for me, but only with an npm token saved as the repository secret `NPM_TOKEN`. That token has to be a granular access token with publish rights and "bypass two-factor authentication" turned on, because npm refuses an ordinary token for a publish. The 0.1.0 run failed for exactly that reason (`403 Forbidden ... Two-factor authentication or granular access token with bypass 2fa enabled is required`). If I ever switch to this path, I save the token first, check that `gh secret list` shows `NPM_TOKEN` with today's date, and only then publish the GitHub release.

The workflow is safe to leave on with the terminal path. When a release is published it checks four things before it does anything: the release tag matches the version in `package.json` (if not, it stops with an error and publishes nothing), the release isn't a prerelease (if it is, it stops with a notice, because npm would make a prerelease the version everyone installs), that version isn't on npm already (if it is, it stops with a notice; if npm can't be reached, it stops with an error when a token is set and with a notice when one isn't), and an `NPM_TOKEN` secret exists (if not, it stops with a notice). Because I publish to npm before I create the GitHub release, the workflow finds the version already there and does nothing.

## Once, before the first release

1. Turn on two-factor authentication on the npm account, for sign-in and for publishing (npmjs.com, Account, Two-Factor Authentication).
2. Delete the old `NPM_TOKEN` secret, which npm rejected in August: `gh secret delete NPM_TOKEN`. With it gone, a GitHub release can never start a publish with a token that doesn't work. (The workflow's own checks already cover the normal order; this covers a release created by mistake before the npm publish.)
3. Check the name is still free: `npm view honestweek` should answer `404 Not Found` until the first publish. It was free on 3 October 2026, and so were `honest-week`, `honest_week` and `honest.week`, the spellings npm would count as the same name.

## 1. The release pull request

On a branch from `main` (for 0.2.0, `feature/release-0.2.0-final`):

1. Confirm every pull request the changelog marks "not merged yet" has merged (for 0.2.0 those were #84 and #87, and both have).
2. Set the version to `0.2.0` in `package.json` and in `.claude-plugin/plugin.json`. A test checks the two match. `.claude-plugin/marketplace.json` has no version of its own, so it doesn't change.
3. In `CHANGELOG.md`, rename `## Unreleased (0.2.0)` to `## 0.2.0 (<date>)`, drop the "not merged yet" notes, and add anything else merged since.
4. In `README.md`, make `npx honestweek` the main way to run it (keep `npx github:BryceEWatson/honestweek` as the way to run unreleased code), and add an npm version badge if you want one. The Releasing section already points here. Until 0.2.0, `test/install.test.mjs` stopped the README from advertising `npx honestweek` before it worked; the 0.2.0 release pull request turned it into a test that the README leads with `npx honestweek`. From the merge until the publish in step 2, the README on `main` says honestweek is on npm when it isn't yet, so publish soon after merging.
5. Run `node --test`, open the pull request, and merge it once CI is green on Linux, Windows and macOS.

## 2. Publish from a clean copy of main

I publish from a fresh clone, so nothing from my everyday checkout (an untracked file under `lib/`, a local edit) can end up in the package. `test/package-contents.test.mjs` would stop a publish that includes a file under `bin/` or `lib/` that git doesn't track, but it can't see an uncommitted edit to a tracked file. A clean clone covers both.

```bash
git clone https://github.com/BryceEWatson/honestweek.git honestweek-release
cd honestweek-release
git log -1 --oneline   # should be the release pull request's merge commit
npm whoami             # prints your npm user name; if it says you're not logged in, run: npm login
npm publish --dry-run
```

The dry run runs the whole test suite first (about a minute), because `package.json` has a `prepublishOnly` script, and then prints what it would upload. Check:

- `name: honestweek` and `version: 0.2.0`;
- the files are `package.json`, `README.md`, `LICENSE`, `SKILL.md`, `honestweek.config.example.json`, the two files in `.claude-plugin/`, and everything under `bin/` and `lib/` (150 files and about 0.9 MB packed for 0.2.0 on 5 October, with the `view` pages under `lib/view/assets/`; later changes move the count, so check the list rather than the number);
- nothing from `test/`, `docs/`, `tools/` or `.claude/`.

Then publish for real:

```bash
npm publish
```

npm asks for a one-time code from your authenticator, or opens a browser to confirm. You can also pass the code directly: `npm publish --otp 123456`. honestweek isn't a scoped package, so it's public without `--access public`.

A version number can be published only once, ever. If something's wrong after this point, see "If something goes wrong" below.

## 3. Check the published package works

From an empty folder that isn't inside the repository:

```bash
# bash, macOS, Linux
cd "$(mktemp -d)"
```

```powershell
# PowerShell
New-Item -ItemType Directory "$env:TEMP\honestweek-check" | Set-Location
```

Then:

```bash
npm view honestweek version      # 0.2.0
npx honestweek@0.2.0 --help      # prints the help, downloaded from npm
npx honestweek@0.2.0 view --demo # opens a made-up week in your browser; Ctrl+C to stop
```

The registry can take a minute or two to show a new version. If `npx` still says it can't find the package after that, stop here and look before tagging.

## 4. Tag it and write the GitHub release

Back in the clean clone, tag the commit you published and push the tag:

```bash
git tag -a v0.2.0 -m "honestweek 0.2.0"
git push origin v0.2.0
```

Copy the release notes below into a file outside the repository, say `notes.md`, and create the release:

```bash
gh release create v0.2.0 --verify-tag --title "honestweek 0.2.0" --notes-file notes.md
```

Publishing the release starts the release workflow. It finds 0.2.0 already on npm and finishes without publishing, with a notice saying so.

## 5. Afterwards

- Edit the v0.1.0 release notes. Its Install section still lists `npx honestweek` and `npm i -g honestweek`, which never worked for 0.1.0. Point them at 0.2.0.
- Close issue #63 with a link to the npm page: <https://www.npmjs.com/package/honestweek>.
- Update the repository's About text and topics on GitHub to match `package.json`'s description and keywords.
- Delete the clean clone.

## If something goes wrong

- **The dry run lists a file it shouldn't.** Don't publish. `git status` in the clone shows whether it's untracked; the package-contents test names it too.
- **The publish fails with 403.** npm wants your two-factor code: run `npm publish --otp <code>`. If it says you don't have permission, check `npm whoami`.
- **The published version is broken.** Mark it with `npm deprecate honestweek@0.2.0 "Broken; use 0.2.1"`, fix it, and release 0.2.1 the same way. npm limits `npm unpublish` (it's only freely allowed in the first 72 hours), and an unpublished version number can never be used again, so a new version is almost always the better fix.
- **A GitHub release went out before the npm publish.** With `NPM_TOKEN` deleted, the workflow stops with a notice and nothing breaks: publish from your terminal, then the release is correct. If a token is still set and the run failed, publish from your terminal anyway; there's no need to re-run the workflow.

## Readiness check, 5 October 2026

### In plain terms

Before publishing 0.2.0 and sharing the repository, I checked the release branch (the branch that holds everything going into 0.2.0) the way a stranger would meet it: the package npm would ship, every file and commit for secrets and personal details, the privacy promises in the docs against the code, the docs themselves, the third-party text in the problem catalog, and the repository's setup. The package installs and runs from the packed file, and no secret or private name is in any file. The docs had gaps, mostly privacy statements broader than the code and counts that had gone stale, and those are fixed in the pull request that added this section, along with one small code fix: `preview` now refuses other host names the way `view` does. What's left needs me: the publish, tag and GitHub steps above.

### Results

| Check | Result | What was found |
| --- | --- | --- |
| 1. The package | Pass | `npm pack` ships 150 files, 0.9 MB packed: `package.json`, the README, the license, `SKILL.md`, the example config, the two plugin manifests, `bin/` and `lib/`. Nothing from `test/`, `docs/`, `tools/` or `.claude/`. Installed from the packed file into an empty folder, `honestweek --help` works, `view --demo` serves its page on `127.0.0.1` and stops cleanly, `view` with no config opens Setup, and `init --yes` with no repositories nearby writes nothing. `npx honestweek` itself can only be tried after the publish; `npx` from the packed file works, and the name `honestweek` was still free on npm. |
| 2. Secrets and personal data | Pass | Every version of every file reachable from `main` and the release branch (1,260 file versions, 150 commits) went through honestweek's own secret-shape check (the classifier the Problems page uses on session logs), a search for key and token formats, email addresses and home-folder paths, and the clean-room fence (the test that keeps private project names out of the repository). Every key-shaped value is a made-up one in a test or the demo week. Email addresses and home-folder names are made-up ones in tests. No private project name appears in any version. My name appears only as the author, in `Co-authored-by` lines, and in a few old test lines since removed. |
| 3. Privacy promises | Fixed | Backed by the code: no network client anywhere in `bin/` or `lib/` (the only `http` use is the two local servers), both servers bind to `127.0.0.1` only, `view` refuses another host name, refuses data requests the browser marks as cross-site, and needs a fresh random key on every data request, and its pages load nothing from outside. Fixed in the docs: the README said nothing outside your repository list is ever touched, but `mine` reads every session and setup looks in neighbouring folders; the lists of what `view` writes left out the example config, `.gitignore` lines, the Include /insights switch and the browser-opener file; the local-page doc said only reads were allowed, but Setup, Settings and the /insights buttons are POST actions; Settings and Setup also scan neighbouring folders. Fixed in the code: `preview` had no host-name check, so a website using DNS rebinding (pointing a name it controls at your own machine) could read the built summary through your browser while `preview` ran. |
| 4. Docs accuracy | Fixed | Every relative link and heading link in the README and `docs/` resolves. The pattern count (42) and check count (23 checks covering 21 patterns) are right. Stale: "16 of the 19" (and "16 of the 20") checked problems running on Codex is now 17 of 21; "22 patterns have no check yet" is 21; "the demo week shows only two patterns" is 17; a line said re-reads ignore shell commands, which they now count. Em dashes came out of `SKILL.md`, `docs/mining.md` and `docs/site-integration.md`. Two kinds stay on purpose: README code blocks that copy what the program prints, and third-party titles quoted in `docs/sources.md`. A new test holds all of this. The catalog marks the cache-miss check as running on Codex, and the docs say a check gets that mark only once it's been seen working on real Codex logs. I found no record of that, so I measured it on 6 October: on my own week, it found 8 cache misses in one Codex session, and that session's raw token counts give the same 8 and the same total, with the 4 misses that came right after a compaction left out, as the check intends. So the mark stands. |
| 5. Third-party content | Pass | The catalog's 430 source entries (210 distinct addresses) each keep a title, an `https` address, a date, a kind and a paraphrase, with no author field. The longest quoted run inside a paraphrase is 7 words. The longest paraphrase (111 words, Claude Code's prompt-caching page) read against the live page is a condensed summary with no long copied passages. `docs/sources.md` matches what the sources tool writes, and its test passes. |
| 6. Repository hygiene | Fixed | `.gitignore` covered the config and the working files; it now also covers `harvest`'s word list, Run with Codex's answers and `npm pack` tarballs, and a test checks it against the README's list of ignored files. The largest tracked file is 303 KB (the catalog). Nothing under `.claude/` is tracked. CI runs Linux on Node 18, 20 and 22, and Windows and macOS on Node 22. The release workflow runs only when a GitHub release is published and publishes only a full release whose tag matches `package.json`, with an `NPM_TOKEN` secret set and the version not yet on npm. No repository secrets are set, so it can't publish at all right now, which is the state step 2 of "Once, before the first release" asks for. |
| 7. GitHub-side | For me | Listed below. Nothing on GitHub was changed. |

### What's left for me

With the release, in the order above:

- Merge the release pull request, publish from a clean clone, check the published package, then tag `v0.2.0` and create the GitHub release (steps 1 to 4).
- Close issue #63 once 0.2.0 is on npm. Its decision was made on 3 October (publish), so nothing is pending there.
- Turn on branch protection for `main` (Settings, Branches): `main` has no protection rule and no ruleset today, so a force-push or a direct push would go through. Require a pull request and the CI checks, and block force-pushes.
- Optional: the repository's About text and topics already match `package.json` (the topics include every keyword), and its website field is empty; the npm page would fit there after the publish.

CI could also run Node 18 and 20 on Windows and macOS, which it doesn't today. Three smaller hardening follow-ups the check found are fixed in pull request 124.

### Implementation detail

- Branch and commits checked: `origin/main` at `1084129` and `origin/feature/release-0.2.0-final` at `c385754`, with Node 22.14 and npm 10.9 on Windows. Pull request 111 is the release pull request.
- The scan used `secretShapes` from `lib/problems/classify.mjs` per line, regexes for private-key blocks and GitHub, Anthropic, OpenAI, AWS, Slack, Google and npm key formats, and `findForbidden` with `privateForbidden` from `test/helpers/clean-room.mjs`, over `git rev-list --objects` of both refs and every commit message.
- Privacy evidence: `lib/view/server.mjs` (the `listen` on `127.0.0.1`, the host check, the `Sec-Fetch-Site` check, `randomBytes(32)` for the key, `timingSafeEqual`, the `CSP` constant), `lib/loopback-host.mjs` (the host check `preview` and `view` now share, which also lets a bare host name through on port 80, where browsers leave the port out), `lib/view/insights.mjs` and `lib/view/codex-judge.mjs` (fixed arguments, absolute `PATH` folders only).
- Tests added: `test/public-docs.test.mjs` (links and anchors, dashes in prose and `--help`, catalog counts, the Sidecars table against `.gitignore`), a host-name case in `test/preview.test.mjs`, and `test/loopback-host.test.mjs`.
- The cache-miss coverage is `coverage.codex.status` of the `cache-miss` pattern in `lib/problems/catalog.json`, added in `4c9451b`. The 6 October measurement ran `buildWorkHistory` and `runProblems` over 29 September to 5 October, then recomputed the one Codex session's misses from its log's `token_count` records (3,647 model calls; a miss where the call before carried 20,000 tokens or more, this call sent 20,000 or more uncached, and it read back less than half the call before's context from the cache). Both found the largest at call 3,120, 220,447 tokens after a 21-minute pause, and a total of 1,110,230; the log's 4 `compacted` records fall in the same minutes as the 4 misses the check skips.

## 0.2.0 release notes

> **honestweek 0.2.0**
>
> honestweek is on npm. Run `npx honestweek view --demo` to look around a made-up week, then `npx honestweek view` to open your own Claude Code and Codex sessions in your browser. `npm install -g honestweek` gives you a plain `honestweek` command. It still has no dependencies, runs only on your own machine, and never publishes anything for you. The one way your sessions leave your machine is a button you press: Run /insights or Run with Codex, which hand them to your own `claude` or `codex`. You need Node 18 or later and `git` 2.24 or later.
>
> **What's new**
>
> - **Problems: where your sessions went wrong.** `honestweek view` opens on a check of your week against a catalog of 42 known ways AI coding agents go wrong. Claims the agent couldn't back come first. Each finding zooms the replay to its exact steps and says how it's known, and each pattern offers a fix to copy, a prompt to test it with, and its count against the week before. Each check's card links the published sources behind it and says where its numbers come from.
> - **Setup and Settings in the browser.** The first `honestweek view` in a folder with no config opens Setup, which finds your repositories, email and timezone, writes your config and goes straight on to your week. Settings changes it later, including how far back to look.
> - **Codex, as well as Claude Code.** honestweek reads Codex's current log format, and 17 of the 21 checked problems run on Codex. `mine`, `digest` and `prompts` see your Codex sessions again. A Facts fold gives both agents the plain facts `/insights` keeps about a session, worked out from the logs with no model involved.
> - **Find and replay.** Find the sessions and goals behind a pull request, a commit, a file, a branch or a few words, see each goal's sessions on a timeline, and replay any session step by step. Replay opens on a list of the week's sessions. Every link, count and time says how it's known. Text is redacted by default; a "Show private text" switch shows names and client words on your own screen while keys, tokens and passwords stay hidden.
> - **A program's turns aren't counted as yours.** Current Claude Code marks a turn sent by a script, the Agent SDK, a headless `claude -p` run or another session. honestweek reads those turns as the program's in Problems, the replay, the digest, the prompt inbox and `mine`. A run a program started links to the step that started it when another session's log shows that step, and the session count in `page` and `site` modes leaves out sessions a program opened with no turn from you (`output.skipProgramSessions: false` keeps the old count).
> - **Optional AI-written notes, off by default.** Include /insights adds what Claude Code's `/insights` wrote about your sessions as its own labelled group, never counted with honestweek's findings, and Run with Codex has your own `codex` write the same for Codex sessions. Both ask before they send anything.
> - **A client report** (`client` mode): a printable page of the work done for one client over any period, with numbers and pull requests taken from git, and reader profiles that order and trim the same checked facts for the person reading them.
> - **A fuller demo week.** `view --demo` builds a made-up week of 36 sessions, including a three-hour session where a main agent and seven helpers build a feature. The README's screenshots come from it, in light and dark.
> - **Fixes from a security review.** `git` turns off the settings in a repository's own config that could start a program (a remote, a signature check, a file-system monitor, hooks), never fetches, and only gets values that look like commit ids. The local page keeps its key away from pages other websites open, an address printed in the terminal works for 15 minutes, and `claude` gets only the environment variables it needs to sign in. On Linux and macOS, the private files honestweek writes are readable only by you. The redactor catches more ways of writing a key, a password or an email address, runs on the names in written data as well as the values, and no longer stalls on two kinds of input that used to slow it down.
> - **Stronger privacy.** `git` never runs against a display-only repository, even in `mine`, `init` and `discover`. The redactor catches a private term inside longer names and web addresses, a Windows home folder inside JSON text, and many more forms of password and token fields, in everything honestweek writes.
>
> The full list is in [CHANGELOG.md](https://github.com/BryceEWatson/honestweek/blob/main/CHANGELOG.md).
