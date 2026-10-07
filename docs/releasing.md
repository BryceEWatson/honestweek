# Releasing honestweek

## In plain terms

This is the plan I follow for every release of honestweek to npm, the public registry that `npx honestweek` and `npm install -g honestweek` download from. It runs in a fixed order: a release pull request that sets the new version, a readiness check, my own test of the build, the merge, the publish to npm, a check that the published package runs, and last a git tag and a GitHub release. The order matters because a version number can be published to npm only once, and a GitHub release is public the moment it's created, so each step waits until the one before it has passed.

An agent session (Claude Code or Codex) can do the work, but nothing runs by itself: the merge, the publish and the tag each wait for my word, and npm's two-factor prompt is always mine to approve.

## Who does what

| Step | Who | Starts when |
| --- | --- | --- |
| 1. The release pull request | the agent | I ask for a release |
| 2. The readiness check | the agent | the last change for the release has landed |
| 3. My test of the build | me, on a build the agent installs | the readiness check passes |
| 4. Ship | the agent | I say `ship` |
| 5. Publish | the agent runs it in my terminal, and I approve npm's prompt | I say `publish` |
| 6. Check the published package | the agent | the publish finishes |
| 7. Tag and GitHub release | the agent | I say `tag` |
| 8. Afterwards | the agent, then me for sharing | the release is out |

Below, `X.Y.Z` stands for the new version number, like `0.2.1`.

## Once per machine and account

1. **Two-factor authentication on the npm account, for writes as well as sign-in** (npmjs.com, my avatar, Account, Two-Factor Authentication). npm refuses a publish without it, with `403 Forbidden ... Two-factor authentication or granular access token with bypass 2fa enabled is required`. That stopped the first try at 0.2.0 on 6 October 2026, and nothing was published.
2. **Logged in to npm on the machine I publish from.** `npm whoami` prints my npm user name; if it says I'm not logged in, the agent runs `npm login` in my Terminal panel and I sign in in the browser it opens.
3. **No `NPM_TOKEN` repository secret.** `gh secret list` should show none. The [release workflow](../.github/workflows/release.yml) publishes from GitHub only with that secret, a granular npm token with "bypass two-factor authentication" turned on. I publish from my own terminal instead, so no token is stored anywhere. The workflow is safe to leave on: when a GitHub release is published, it checks that the tag matches `package.json`, that the release isn't a prerelease, that the version isn't on npm yet, and that a token exists, and it stops at the first that fails. Because I publish before I tag, it finds the version already on npm and does nothing.

## 1. The release pull request

On a branch from `main` named `feature/release-X.Y.Z`. Changes meant for the release go into this branch as their own pull requests, each with its own review and CI.

1. Set the version to `X.Y.Z` in `package.json` and in `.claude-plugin/plugin.json`. A test checks the two match. `.claude-plugin/marketplace.json` has no version of its own.
2. In `CHANGELOG.md`, rename the unreleased section to `## X.Y.Z (<date>)` and check that every merged pull request is in it.
3. Rewrite the release notes block at the end of this file for `X.Y.Z`: what's new, in plain words, with every count true to the code. The tests pin several counts.
4. Check the README still says how to install and run this version, and what it needs (Node and git versions).
5. Open the pull request into `main`.

## 2. The readiness check

On the release branch's head, once the last change for the release has landed:

```bash
node tools/release-check.mjs
```

It runs three checks, compared with the last release tag (pass `--since <ref>` to compare with something else):

1. **The package.** `npm pack` lists only `package.json`, the README, the license, `SKILL.md`, the example config, the two plugin manifests, `bin/` and `lib/`. Anything else, or any image, fails.
2. **It runs.** The packed tarball, installed into an empty folder, prints `--help`, serves `view --demo`, and opens Setup when there's no config. It uses an empty home folder, so it reads no real logs.
3. **What came in since the last release**, listed for a person to judge: every commit's author and committer, and in every new file version, honestweek's own secret-shape check, key formats, email addresses, home-folder paths, the clean-room fence (the check that keeps private names out of the repository), and new images.

Checks 1 and 2 must pass. For check 3, the agent confirms each listed value is a made-up one in a test or the demo, every author is the GitHub no-reply address, and every new image shows only made-up data, by looking at each one.

Then:

- **The privacy and security statements** in the README, `SECURITY.md` and `docs/local-page.md` still match the code, above all after a change to what honestweek reads, writes, runs or serves.
- **The full suite** passes once, with `node --test` from the repository root, and CI is green on all five jobs.
- **One independent review** of the release pull request runs in a fresh session.

The agent records the results as a dated comment on the release pull request, plain terms first. Anything private (personal details in git history, a security gap not fixed yet) never goes in the repository or the pull request; it goes in the project's private goal record.

## 3. My test of the build

The agent installs the release branch as my global `honestweek` and checks the installed `lib/` and `bin/` match the release branch's head:

```bash
npm install -g github:BryceEWatson/honestweek#feature/release-X.Y.Z
```

Then it starts `honestweek view` in my Terminal panel from the folder I usually run it in, and gives me the address. I look at what changed and try it on my own week. When I'm happy, I say `ship`.

## 4. Ship

On my word `ship`, the agent merges the release pull request into `main`: squash merge, pinned to its head commit with `--match-head-commit`, only when all five CI checks are green on that commit and every review thread is answered and resolved. It checks the merge commit's author is the GitHub no-reply address, closes any older pull request the release already includes (a comment first, then the close), and updates my `main` checkout.

From the merge until the publish, the README on `main` describes a version npm doesn't have yet, so the publish should follow soon.

## 5. Publish from a clean copy of main

On my word `publish`. I publish from a fresh clone, so nothing from an everyday checkout (an untracked file under `lib/`, a local edit) can end up in the package. `test/package-contents.test.mjs` would stop a publish that includes a file under `bin/` or `lib/` that git doesn't track, but it can't see an uncommitted edit to a tracked file. A clean clone covers both.

The agent runs these:

```bash
git clone https://github.com/BryceEWatson/honestweek.git honestweek-release
cd honestweek-release
git log -1 --oneline   # the release pull request's merge commit
npm whoami             # my npm user name; if it says I'm not logged in, see "Once per machine and account"
npm publish --dry-run
```

The dry run runs the whole test suite first (a few minutes), because `package.json` has a `prepublishOnly` script, and then prints what it would upload. Check:

- `name: honestweek` and `version: X.Y.Z`;
- the files are `package.json`, `README.md`, `LICENSE`, `SKILL.md`, `honestweek.config.example.json`, the two files in `.claude-plugin/`, and everything under `bin/` and `lib/` (157 files and 1.0 MB packed for 0.2.0; the count moves, so check the list rather than the number);
- nothing from `test/`, `docs/`, `tools/` or `.claude/`.

Then the agent starts the real publish in my Terminal panel:

```bash
npm publish
```

It runs the suite again, then npm asks for my two-factor approval in the terminal or a browser. I approve it there. The agent never types a password or a one-time code. honestweek isn't a scoped package, so it's public without `--access public`.

## 6. Check the published package works

From an empty folder that isn't inside the repository, because `npx` inside the clean clone could run the clone's own copy instead of the one on npm:

```bash
# bash, macOS, Linux
cd "$(mktemp -d)"
```

```powershell
# PowerShell
New-Item -ItemType Directory "$env:TEMP\honestweek-check-X.Y.Z" | Set-Location
```

Then:

```bash
npm view honestweek version        # X.Y.Z
npx honestweek@X.Y.Z --help        # prints the help, downloaded from npm
npx honestweek@X.Y.Z view --demo   # opens the made-up week in a browser; Ctrl+C to stop
```

The registry can take a minute or two to show a new version. If `npx` still can't find the package after that, stop and look before tagging.

## 7. Tag it and write the GitHub release

On my word `tag`, back in the clean clone, the agent tags the commit that was published and pushes the tag:

```bash
git tag -a vX.Y.Z -m "honestweek X.Y.Z"
git push origin vX.Y.Z
```

It copies the release notes block below into a file outside the repository, say `../notes.md` next to the clean clone, and creates the release:

```bash
gh release create vX.Y.Z --verify-tag --title "honestweek X.Y.Z" --notes-file ../notes.md
```

Publishing the release starts the release workflow, which finds `X.Y.Z` already on npm and finishes without publishing.

## 8. Afterwards

- Close the release's tracking issue, if there is one, with a link to <https://www.npmjs.com/package/honestweek>.
- Reinstall my global copy from npm, `npm install -g honestweek@X.Y.Z`, so my machine runs what everyone else gets.
- Check the repository's About text and topics still match `package.json`'s description and keywords.
- Delete the clean clone, `notes.md` next to it, and the check folder from step 6.
- Then I share it.

## If something goes wrong

- **The readiness check fails.** Fix it on the release branch and run it again. Nothing is public yet.
- **The dry run lists a file it shouldn't.** Don't publish. `git status` in the clone shows whether it's untracked; the package-contents test names it too.
- **The publish fails with `E403 ... Two-factor authentication ... is required`.** The npm account doesn't have two-factor authentication on for writes. Turn it on (see "Once per machine and account") and publish again. Nothing was published, so the version number is still free.
- **The publish stops asking for a one-time code (`EOTP`).** Approve it in the terminal, or run `npm publish --otp <code>` myself.
- **The published version is broken.** Mark it with `npm deprecate honestweek@X.Y.Z "Broken; use X.Y.(Z+1)"`, fix it, and release the next patch version the same way. npm limits `npm unpublish` (it's only freely allowed in the first 72 hours), and an unpublished version number can never be used again, so a new version is almost always the better fix.
- **A GitHub release went out before the npm publish.** With no `NPM_TOKEN` secret, the workflow stops with a notice and nothing breaks: publish from the terminal, and then the release is correct.

## Records from 0.2.0

0.2.0 was the first version on npm (0.1.0 has a GitHub release, but its npm publish failed and it never reached npm). Its readiness checks are recorded below. Later releases record theirs on the release pull request instead.

### Readiness check, 5 October 2026

#### In plain terms

Before publishing 0.2.0 and sharing the repository, I checked the release branch (the branch that holds everything going into 0.2.0) the way a stranger would meet it: the package npm would ship, every file and commit for secrets and personal details, the privacy promises in the docs against the code, the docs themselves, the third-party text in the problem catalog, and the repository's setup. The package installs and runs from the packed file, and no secret or private name is in any file. The docs had gaps, mostly privacy statements broader than the code and counts that had gone stale, and those are fixed in the pull request that added this section, along with one small code fix: `preview` now refuses other host names the way `view` does. What's left needs me: the publish, tag and GitHub steps above.

#### Results

| Check | Result | What was found |
| --- | --- | --- |
| 1. The package | Pass | `npm pack` ships 150 files, 0.9 MB packed: `package.json`, the README, the license, `SKILL.md`, the example config, the two plugin manifests, `bin/` and `lib/`. Nothing from `test/`, `docs/`, `tools/` or `.claude/`. Installed from the packed file into an empty folder, `honestweek --help` works, `view --demo` serves its page on `127.0.0.1` and stops cleanly, `view` with no config opens Setup, and `init --yes` with no repositories nearby writes nothing. `npx honestweek` itself can only be tried after the publish; `npx` from the packed file works, and the name `honestweek` was still free on npm. |
| 2. Secrets and personal data | Pass | Every version of every file reachable from `main` and the release branch (1,260 file versions, 150 commits) went through honestweek's own secret-shape check (the classifier the Problems page uses on session logs), a search for key and token formats, email addresses and home-folder paths, and the clean-room fence (the test that keeps private project names out of the repository). Every key-shaped value is a made-up one in a test or the demo week. Email addresses and home-folder names are made-up ones in tests. No private project name appears in any version. My name appears only as the author, in `Co-authored-by` lines, and in a few old test lines since removed. |
| 3. Privacy promises | Fixed | Backed by the code: no network client anywhere in `bin/` or `lib/` (the only `http` use is the two local servers), both servers bind to `127.0.0.1` only, `view` refuses another host name, refuses data requests the browser marks as cross-site, and needs a fresh random key on every data request, and its pages load nothing from outside. Fixed in the docs: the README said nothing outside your repository list is ever touched, but `mine` reads every session and setup looks in neighbouring folders; the lists of what `view` writes left out the example config, `.gitignore` lines, the Include /insights switch and the browser-opener file; the local-page doc said only reads were allowed, but Setup, Settings and the /insights buttons are POST actions; Settings and Setup also scan neighbouring folders. Fixed in the code: `preview` had no host-name check, so a website using DNS rebinding (pointing a name it controls at your own machine) could read the built summary through your browser while `preview` ran. |
| 4. Docs accuracy | Fixed | Every relative link and heading link in the README and `docs/` resolves. The pattern count (42) and check count (23 checks covering 21 patterns) are right. Stale: "16 of the 19" (and "16 of the 20") checked problems running on Codex is now 17 of 21; "22 patterns have no check yet" is 21; "the demo week shows only two patterns" is 17; a line said re-reads ignore shell commands, which they now count. Em dashes came out of `SKILL.md`, `docs/mining.md` and `docs/site-integration.md`. Two kinds stay on purpose: README code blocks that copy what the program prints, and third-party titles quoted in `docs/sources.md`. A new test holds all of this. The catalog marks the cache-miss check as running on Codex, and the docs say a check gets that mark only once it's been seen working on real Codex logs. I found no record of that, so I measured it on 6 October: on my own week, it found 8 cache misses in one Codex session, and that session's raw token counts give the same 8 and the same total, with the 4 misses that came right after a compaction left out, as the check intends. So the mark stands. |
| 5. Third-party content | Pass | The catalog's 430 source entries (210 distinct addresses) each keep a title, an `https` address, a date, a kind and a paraphrase, with no author field. The longest quoted run inside a paraphrase is 7 words. The longest paraphrase (111 words, Claude Code's prompt-caching page) read against the live page is a condensed summary with no long copied passages. `docs/sources.md` matches what the sources tool writes, and its test passes. |
| 6. Repository hygiene | Fixed | `.gitignore` covered the config and the working files; it now also covers `harvest`'s word list, Run with Codex's answers and `npm pack` tarballs, and a test checks it against the README's list of ignored files. The largest tracked file is 303 KB (the catalog). Nothing under `.claude/` is tracked. CI runs Linux on Node 18, 20 and 22, and Windows and macOS on Node 22. The release workflow runs only when a GitHub release is published and publishes only a full release whose tag matches `package.json`, with an `NPM_TOKEN` secret set and the version not yet on npm. No repository secrets are set, so it can't publish at all right now, which is the state step 2 of "Once, before the first release" asks for. |
| 7. GitHub-side | For me | Listed below. Nothing on GitHub was changed. |

#### What's left for me

With the release, in the order above:

- Merge the release pull request, publish from a clean clone, check the published package, then tag `v0.2.0` and create the GitHub release (steps 1 to 4).
- Close issue #63 once 0.2.0 is on npm. Its decision was made on 3 October (publish), so nothing is pending there.
- Turn on branch protection for `main` (Settings, Branches): `main` has no protection rule and no ruleset today, so a force-push or a direct push would go through. Require a pull request and the CI checks, and block force-pushes.
- Optional: the repository's About text and topics already match `package.json` (the topics include every keyword), and its website field is empty; the npm page would fit there after the publish.

CI could also run Node 18 and 20 on Windows and macOS, which it doesn't today. Three smaller hardening follow-ups the check found are fixed in pull request 124.

#### Implementation detail

- Branch and commits checked: `origin/main` at `1084129` and `origin/feature/release-0.2.0-final` at `c385754`, with Node 22.14 and npm 10.9 on Windows. Pull request 111 is the release pull request.
- The scan used `secretShapes` from `lib/problems/classify.mjs` per line, regexes for private-key blocks and GitHub, Anthropic, OpenAI, AWS, Slack, Google and npm key formats, and `findForbidden` with `privateForbidden` from `test/helpers/clean-room.mjs`, over `git rev-list --objects` of both refs and every commit message.
- Privacy evidence: `lib/view/server.mjs` (the `listen` on `127.0.0.1`, the host check, the `Sec-Fetch-Site` check, `randomBytes(32)` for the key, `timingSafeEqual`, the `CSP` constant), `lib/loopback-host.mjs` (the host check `preview` and `view` now share, which also lets a bare host name through on port 80, where browsers leave the port out), `lib/view/insights.mjs` and `lib/view/codex-judge.mjs` (fixed arguments, absolute `PATH` folders only).
- Tests added: `test/public-docs.test.mjs` (links and anchors, dashes in prose and `--help`, catalog counts, the Sidecars table against `.gitignore`), a host-name case in `test/preview.test.mjs`, and `test/loopback-host.test.mjs`.
- The cache-miss coverage is `coverage.codex.status` of the `cache-miss` pattern in `lib/problems/catalog.json`, added in `4c9451b`. The 6 October measurement ran `buildWorkHistory` and `runProblems` over 29 September to 5 October, then recomputed the one Codex session's misses from its log's `token_count` records (3,647 model calls; a miss where the call before carried 20,000 tokens or more, this call sent 20,000 or more uncached, and it read back less than half the call before's context from the cache). Both found the largest at call 3,120, 220,447 tokens after a 21-minute pause, and a total of 1,110,230; the log's 4 `compacted` records fall in the same minutes as the 4 misses the check skips.

#### Readiness re-check, 6 October 2026

I ran the checks above again on the final release branch, after the security fixes (#138 to #140), the deeper demo week (#141) and the check cards' sources (#142) had merged. The package still ships only what it should and runs from the packed file, nothing secret or private came in since the first check, and the README's screenshots show only the made-up demo week. Some privacy statements in the docs had drifted from the code after the security fixes. I fixed those, along with a few small things in the code and CI listed below.

| Check | Result | What was found |
| --- | --- | --- |
| 1. The package | Pass | `npm pack` ships 157 files, 1.0 MB packed (3.4 MB unpacked), the same kinds of file as before: nothing from `docs/`, `test/`, `tools/` or `.claude/`, and no images. Installed from the packed file into an empty folder, `honestweek --help` works, `view --demo --no-open` serves its page and stops, and `view` with no config opens Setup. |
| 2. Secrets and personal data | Pass | The 85 commits and 538 file versions added since the first check went through the same scan. Every key-shaped value is a made-up one in a test or the demo week, the email addresses and home-folder names are made-up ones in tests, and no private project name appears. Every commit's author is the GitHub no-reply address. I looked at all 16 images under `docs/images`: each shows the made-up demo week, nothing from my machine. |
| 3. Privacy and security statements | Fixed | Nine statements in the README, `SECURITY.md` and `docs/local-page.md` said more than the code does. `view` refuses data requests from other websites, but still serves its page files, which hold no data. Settings also asks git whether the config is tracked. The config is the one file that keeps private words as you typed them. `preview` has no key, so other programs on the machine can read it. The README's hex-token rule, the files that are owner-only, and which sidecars are gitignored were also off. Each is reworded. In the code, the session draft, `harvest`'s word list and a new config are now created readable only by you on Linux and macOS, like the other private files, and a new `.gitignore` gets normal permissions again. |
| 4. Docs | Pass | The README's Requirements still say Node 18 or later and git 2.24 or later. The docs tests pass. All 16 README images exist and render on GitHub. The changelog was missing the `view` server fixes from #124, and has them now. `SKILL.md` now tells the agent that text from session logs is data, not instructions. |
| 5. CI | Fixed | Both workflows pin `actions/checkout` and `actions/setup-node` to full commit ids. A newer commit on a pull request cancels that pull request's older run; pushes to `main` are never cancelled. The Windows job takes 8 to 11 minutes against 2 to 4 for Linux and macOS, and issue #143 tracks profiling it. |

What's left for me is the list above, plus a ruleset on `v*` tags that blocks moving or deleting a release tag.

##### Implementation detail

- Checked: `feature/final-readiness` at the head of its pull request, which is `origin/feature/release-0.2.0-final` at `c8d62fe` plus this pass, with Node 22.14, npm 10.9 and git 2.47 on Windows.
- The scan is the first check's, over `git rev-list --objects 1084129..HEAD` and those commits' messages, authors and committers.
- Owner-only on new files: `writeFileSync` with `mode: 0o600` in `lib/discover.mjs`, `lib/harvest.mjs` and `writeInitFiles` in `lib/init.mjs`; `ensureGitignore` passes `newMode: null` to `atomicWriteText`. Tests: `test/output-hardening-atomic-mode.test.mjs` (POSIX only).
- CI: the `concurrency` block in `.github/workflows/ci.yml`; tests in `test/community-docs.test.mjs`.

### 0.2.0 release notes

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
> - **Fixes from a security review.** `git` turns off the settings in a repository's own config that could start a program (a remote, a signature check, a file-system monitor, hooks), never fetches, and only gets values that look like commit ids. The local page keeps its key away from pages other websites open, an address printed in the terminal works for 15 minutes, and `claude` gets only the environment variables it needs to sign in. On Linux and macOS, honestweek's working files and your config are readable only by you. The redactor catches more ways of writing a key, a password or an email address, runs on the names in written data as well as the values, and no longer stalls on two kinds of input that used to slow it down.
> - **Stronger privacy.** `git` never runs against a display-only repository, even in `mine`, `init` and `discover`. The redactor catches a private term inside longer names and web addresses, a Windows home folder inside JSON text, and many more forms of password and token fields, in everything honestweek writes.
>
> The full list is in [CHANGELOG.md](https://github.com/BryceEWatson/honestweek/blob/main/CHANGELOG.md).
