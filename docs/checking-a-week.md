# Running the checks over one finished week

## In plain terms

This is the short way to ask honestweek "where did my sessions go wrong last week?" and keep the answer in a file. It's one command, it reads only the logs on this machine, and it changes nothing. I wrote it down in November 2026, after the checks were updated, so that anyone picking this up, a person or an agent in a fresh session, runs the same thing and knows where the answer lands.

## The command

Run it from a checkout of honestweek on its main branch, with the first and last day of the week you want (a Monday and the Sunday after it):

```bash
node --max-old-space-size=12288 bin/honestweek.mjs problems --from 2026-11-09 --to 2026-11-15 --json > honestweek.problems.json
```

The answer lands in `honestweek.problems.json` in the folder you ran it from. This repository's `.gitignore` lists that name, so it won't be committed from this checkout. Anywhere else, keep it out of git yourself: it's redacted, but it's still about your sessions.

For the same answer as text, to read rather than to process, leave off `--json` and the redirect:

```bash
node --max-old-space-size=12288 bin/honestweek.mjs problems --from 2026-11-09 --to 2026-11-15
```

## What to know before trusting the answer

- **Which sessions it reads.** The checks read sessions in the repositories your config lists, and no others. `node bin/honestweek.mjs status` says which config it found. A repository that isn't listed isn't checked, and the answer doesn't mention it.
- **Why the memory setting.** A busy week can be several gigabytes of logs. Without the setting, honestweek loads as many of the latest days as fit and says so in the answer's `windowNote` ("Loaded 2026-11-13 to 2026-11-15: all of ... needs more memory"). Check that field first: when it's there, the answer covers only the days it names. On my machine the whole of the week above (7.2 GB of logs) loaded with the setting shown, which gives Node 12 GB, and took about a minute. I only tried that one value, so a smaller one may do.
- **What a finding is.** Each one names its session, the moment to replay, the rule that found it and how it's known. Nearly all are inferred, which means a fixed rule read the log that way and can be wrong. Read the moment before calling it a mistake: `node bin/honestweek.mjs problems --finding <key>` gives one finding in full, and the `zoomPage` on each finding opens it on the local page.
- **What's checked and what isn't.** `statusCounts` and `notFound` in the answer say how many of the known problems were found, checked and not found, and not checked at all. A problem with no check isn't "not found".
- **How much of it holds up.** I judged one week's findings against the logs in [research/2026-11-21-week-check-findings.md](research/2026-11-21-week-check-findings.md): of 36 worth a look, 21 were real readings, 8 were false alarms or carried the wrong label, all now fixed, and 7 couldn't be settled from the log.

## Reading the file

Each entry of `patterns` is one known problem with its `findings`. A quick count by problem and severity, with nothing but Node:

```bash
node -e "const o=JSON.parse(require('fs').readFileSync('honestweek.problems.json','utf8'));for(const p of o.patterns){const look=p.findings.filter(f=>f.severity==='look').length;console.log(p.id,p.findings.length,'findings,',look,'worth a look')}"
```

A finding marked `look` is worth opening; one marked `note` is routine and listed so the count is honest.

## Implementation detail

- The window flags are `--from` and `--to` (inclusive, read in the config's `week.timezone` unless `--timezone` names another). `--days <n>` counts back from today instead.
- `--config <file>` reads another config; `--session <id>` narrows the answer to one session.
- The rules added in November 2026 show up under the checks `risky-command` and `guardrail-edits`; each finding's `rule` names the one that matched (`problems.package-add`, `problems.credential-read` and so on). The survey behind them is [docs/research/2026-11-agent-failure-survey.md](research/2026-11-agent-failure-survey.md).
