# Releasing honestweek

## In plain terms

This is the checklist I follow to put a new version of honestweek on npm, the public registry that `npx honestweek` and `npm install -g honestweek` download from. A release is four steps in a fixed order: a pull request that sets the new version number, a publish to npm from my own terminal, a check that the published package runs, and then a git tag and a GitHub release that point people at it. The order matters because a GitHub release is public the moment it's created, so it comes last, after the package is already live. Nothing here runs by itself.

The first version on npm is 0.2.0. Version 0.1.0 has a GitHub release, but its npm publish failed and it never reached npm.

## Two ways to publish, and the one I use

**From my own terminal (the one I use).** I log in to npm on my machine and run `npm publish`. npm asks for my two-factor code, so no token is stored anywhere. This is the simplest way to do a first publish, and it's what the steps below describe.

**From GitHub, when a release is published.** The [release workflow](../.github/workflows/release.yml) can publish for me, but only with an npm token saved as the repository secret `NPM_TOKEN`. That token has to be a granular access token with publish rights and "bypass two-factor authentication" turned on, because npm refuses an ordinary token for a publish. The 0.1.0 run failed for exactly that reason (`403 Forbidden ... Two-factor authentication or granular access token with bypass 2fa enabled is required`). If I ever switch to this path, I save the token first, check that `gh secret list` shows `NPM_TOKEN` with today's date, and only then publish the GitHub release.

The workflow is safe to leave on with the terminal path. When a release is published it checks four things before it does anything: the release tag matches the version in `package.json` (if not, it stops with an error and publishes nothing), the release isn't a prerelease (if it is, it stops with a notice, because npm would make a prerelease the version everyone installs), that version isn't on npm already (if it is, it stops with a notice; if npm can't be reached, it stops with an error), and an `NPM_TOKEN` secret exists (if not, it stops with a notice). Because I publish to npm before I create the GitHub release, the workflow finds the version already there and does nothing.

## Once, before the first release

1. Turn on two-factor authentication on the npm account, for sign-in and for publishing (npmjs.com, Account, Two-Factor Authentication).
2. Delete the old `NPM_TOKEN` secret, which npm rejected in August: `gh secret delete NPM_TOKEN`. With it gone, a GitHub release can never start a publish with a token that doesn't work. (The workflow's own checks already cover the normal order; this covers a release created by mistake before the npm publish.)
3. Check the name is still free: `npm view honestweek` should answer `404 Not Found` until the first publish. It was free on 3 October 2026, and so were `honest-week`, `honest_week` and `honest.week`, the spellings npm would count as the same name.

## 1. The release pull request

On a branch `feature/release-0.2.0` from `main`:

1. Confirm the pull requests the changelog lists as "not merged yet" have merged (for 0.2.0, #84 and #87).
2. Set the version to `0.2.0` in `package.json` and in `.claude-plugin/plugin.json`. A test checks the two match. `.claude-plugin/marketplace.json` has no version of its own, so it doesn't change.
3. In `CHANGELOG.md`, rename `## Unreleased (0.2.0)` to `## 0.2.0 (<date>)`, drop the "not merged yet" notes, and add anything else merged since.
4. In `README.md`, make `npx honestweek` the main way to run it (keep `npx github:BryceEWatson/honestweek` as the way to run unreleased code), and add an npm version badge if you want one. The Releasing section already points here. `test/install.test.mjs` has a test that stops the README from advertising `npx honestweek` as working before it does. Update that test in the same pull request.
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
- the files are `package.json`, `README.md`, `LICENSE`, `SKILL.md`, `honestweek.config.example.json`, the two files in `.claude-plugin/`, and everything under `bin/` and `lib/` (96 files and about 0.36 MB packed before #84; more once #84 adds the `view` pages under `lib/view/assets/`, so check the list rather than the count);
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

## 0.2.0 release notes

> **honestweek 0.2.0**
>
> honestweek is on npm. `npx honestweek --help` works from any folder, and `npm install -g honestweek` gives you a plain `honestweek` command. It still has no dependencies, runs only on your own machine, and never publishes anything for you. You need Node 18 or later and `git`.
>
> **What's new**
>
> - **`honestweek view`**, a page in your browser served only from your own machine. Find the sessions and goals behind a pull request, a commit, a file, a branch or a few words, see each goal's sessions on a timeline, and replay any session step by step. Every link, count and time says how it's known. Text is redacted by default; a "Show private text" switch shows names and client words on your own screen while keys, tokens and passwords stay hidden. Try it on a made-up week with `npx honestweek view --demo`.
> - **An easier first run.** Run `honestweek` with no arguments for three first steps. `init` explains repository roles, asks which names and client words to keep private, and points you to `view`.
> - **A client report** (`client` mode): a printable page of the work done for one client over any period, with numbers and pull requests taken from git, and reader profiles that order and trim the same checked facts for the person reading them.
> - **Codex logs in the current format** are read again, so `mine`, `digest` and `prompts` see your Codex sessions.
> - **Stronger privacy.** `git` never runs against a display-only repository, even in `mine`, `init` and `discover`. The redactor now catches a private term inside longer names and web addresses, a Windows home folder inside JSON text, and many more forms of password and token fields, in everything honestweek writes.
>
> The full list is in [CHANGELOG.md](https://github.com/BryceEWatson/honestweek/blob/main/CHANGELOG.md).
