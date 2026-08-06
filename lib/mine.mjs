// lib/mine.mjs — `honestweek mine`: find solved third-party problems worth publishing.
//
// THE CONTROL LOOP THIS CLOSES
// ----------------------------------------------------------------------------
//   setpoint   at least one publishable finding reaching a human decision each week
//              that the logs contain one. Not "N posts published" — publishing is a
//              human act and cannot be a machine's setpoint.
//   sensor     this command. Reads agent session logs across every configured corpus
//              and extracts solved third-party failures.
//   blind to   anything older than the agent's own log-retention floor (reported as
//              `corpusFloor`); problems solved outside a logged session; and whether
//              anyone actually searches for the error.
//   error      the BACKLOG of undecided findings, from the ledger — not a count of
//              what this run found. See lib/mine/ledger.mjs.
//   actuator   `--draft` writes a real post and marks the finding `drafted`. The
//              human merges or closes. One action.
//   silent     every run records what it SAW: files found, probed and accepted per
//   failure    corpus, plus the corpus date range. A corpus that resolves to a real
//              root but yields zero files is an ERROR (exit 2), never "no findings".
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadConfig } from './config.mjs';
import { createRedactor } from './redact.mjs';
import { CORPUS_KINDS, enumerateSessions } from './mine/corpus.mjs';
import { detectSession } from './mine/detect.mjs';
import { rankFindings, publishable, PUBLISHABLE_THRESHOLD } from './mine/rank.mjs';
import { renderDraft } from './mine/draft.mjs';
import { ALL_STATUSES, backlog, errorSignal, loadLedger, mergeFindings, nextToDraft, recordRun, saveLedger, setStatus } from './mine/ledger.mjs';

const USAGE = `honestweek mine: find solved third-party problems in your session logs.

Usage:
  honestweek mine [options]

What it does:
  Reads your agent session logs, finds sessions where software you did NOT write
  failed and you worked out the fix, ranks them, and records them in a findings
  ledger. With --draft it also writes the top undecided one up as a post.

Options:
  --config <path>   Config file (default: honestweek.config.json).
  --ledger <path>   Findings ledger (default: honestweek.findings.json).
  --since <date>    Only sessions starting on/after this ISO date.
  --corpus <list>   Comma-separated: claude-code,codex,cowork (default: all).
  --draft           Write a draft for the top undecided finding and mark it drafted.
  --decide <key=status>  Set a finding's status: published | declined | stale.
  --threshold <n>   Publishable score bar (default: ${PUBLISHABLE_THRESHOLD}).
  --json            Machine-readable output.
  -h, --help        Show this help.

Exit codes:
  0  ran, and every configured corpus yielded logs
  1  bad invocation: an unknown option, an unknown --corpus name, or a config
     that was named (or exists) but cannot be loaded. Nothing was scanned.
  2  the sensor is blind: a corpus directory held zero log files, an explicitly
     requested corpus has no directory, files were present but none yielded a
     session identity, or every scanned session failed in the detector. None of
     these is the same as finding nothing. Fix the cause before trusting a zero.
`;

function parseArgs(argv) {
  const out = { corpus: null, draft: false, json: false, threshold: PUBLISHABLE_THRESHOLD, decide: null };
  // Every value-taking flag validates what it got. A flag with a missing or garbage
  // value must exit 1, never quietly degrade: `--threshold abc` used to become NaN
  // (every finding fails `score >= NaN`, a run that scans everything and reports a
  // quiet week), and `--since abc` an Invalid Date (all comparisons false, the filter
  // silently off) — the same silent-bad-invocation class as an unknown option.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} expects a value`);
      i += 1;
      return v;
    };
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--draft') out.draft = true;
    else if (a === '--json') out.json = true;
    else if (a === '--config') out.config = value();
    else if (a === '--ledger') out.ledger = value();
    else if (a === '--since') {
      out.since = value();
      if (Number.isNaN(new Date(out.since).getTime())) throw new Error(`--since expects an ISO date (got ${JSON.stringify(out.since)})`);
    } else if (a === '--corpus') {
      // Validated HERE, not just in resolveCorpora: a typo like `claud-code` used to
      // resolve to zero corpora and exit 0 — a blind sensor reporting a quiet week.
      const list = value().split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) throw new Error(`--corpus expects a comma-separated list of: ${CORPUS_KINDS.join(', ')}`);
      const bad = list.find((k) => !CORPUS_KINDS.includes(k));
      if (bad !== undefined) throw new Error(`unknown corpus ${JSON.stringify(bad)}; valid: ${CORPUS_KINDS.join(', ')}`);
      out.corpus = list;
    } else if (a === '--decide') out.decide = value();
    else if (a === '--threshold') {
      const v = value();
      out.threshold = Number(v);
      if (!Number.isFinite(out.threshold)) throw new Error(`--threshold expects a number (got ${JSON.stringify(v)})`);
    } else if (a.startsWith('-')) throw new Error(`unknown option "${a}"`);
  }
  return out;
}

/** `owner/name` for every configured repo that has a GitHub remote. Used to tell
 *  YOUR bug reports from other people's — an issue on your own repo is not evidence
 *  that you fixed someone else's software. */
async function ownRepoSlugs(config) {
  const { execFileSync } = await import('node:child_process');
  const slugs = new Set();
  // An explicit list always wins: it is the only way to declare ownership of a repo
  // that is not configured here, or to run with no config at all.
  // Shape is enforced by normalizeConfig, so nothing is silently dropped here.
  for (const s of config?.mine?.ownRepos ?? []) slugs.add(s);
  for (const r of config?.repos ?? []) {
    const path = r.resolvedPath ?? r.path;
    if (!path) continue;
    try {
      const out = execFileSync('git', ['-C', path, 'remote', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const m of out.matchAll(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s/g)) slugs.add(`${m[1]}/${m[2]}`);
    } catch {
      // A repo without git, or without a remote, simply contributes nothing.
    }
  }
  return [...slugs];
}

/** Error strings the destination has already covered, so the ranker can gate them.
 *  Supplied by config as literal strings — honestweek does not read anyone's site. */
function publishedErrorStrings(config) {
  const v = config?.mine?.publishedErrorStrings;
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.length > 0) : [];
}

export default async function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`honestweek mine: ${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Mining works without a config; it only loses repo-aware attribution and the
  // redaction denylist. But "without a config" means the DEFAULT path holds no file —
  // nothing else. A config that was named with --config, or that exists but cannot be
  // loaded, must fail LOUD: continuing would silently rank the user's own-repo issues
  // as third-party evidence (mine.ownRepos gone) and run with the redaction denylist
  // off, in a command whose output the docs say to commit.
  const configPath = resolve(args.config ?? 'honestweek.config.json');
  let config = {};
  if (args.config !== undefined || existsSync(configPath)) {
    try {
      config = loadConfig(configPath);
    } catch (err) {
      process.stderr.write(`honestweek mine: unusable config at ${configPath}: ${err.message}\n`);
      return 1;
    }
  } else {
    process.stderr.write(`honestweek mine: no config at ${configPath}; continuing without repo context.\n`);
  }

  const ledgerPath = resolve(args.ledger ?? config?.mine?.ledger ?? 'honestweek.findings.json');
  const ledger = loadLedger(ledgerPath);
  const now = new Date();

  // --- a human decision, recorded ------------------------------------------
  if (args.decide) {
    // Split on the LAST `=`, not the first. A finding key is a normalized error string
    // and routinely contains one (`bind failed code=#`); splitting on the first made
    // those findings impossible to decide, which quietly disables the only mechanism
    // that can lower the backlog.
    const raw = String(args.decide);
    const at = raw.lastIndexOf('=');
    if (at <= 0) {
      process.stderr.write(`honestweek mine: --decide expects "<key>=<status>" (got ${JSON.stringify(raw)}).\n`);
      return 1;
    }
    const key = raw.slice(0, at);
    const status = raw.slice(at + 1);
    let updated;
    try {
      updated = setStatus(ledger, key, status, { now });
    } catch (err) {
      process.stderr.write(`honestweek mine: ${err.message}. Valid: ${ALL_STATUSES.join(' | ')}.\n`);
      return 1;
    }
    if (!updated) {
      process.stderr.write(`honestweek mine: no finding with key "${key}" in ${ledgerPath}\n`);
      return 1;
    }
    saveLedger(ledgerPath, ledger);
    process.stdout.write(`Recorded: ${key} -> ${status}\n`);
    const sig = errorSignal(ledger);
    process.stdout.write(`Backlog now ${sig.backlog} undecided finding(s).\n`);
    return 0;
  }

  // --- sense ----------------------------------------------------------------
  const since = args.since ? new Date(args.since) : null;
  const { sessions, diagnostics } = enumerateSessions({ corpora: args.corpus, since });

  const ownRepos = await ownRepoSlugs(config);
  const findings = [];
  let scanned = 0;
  let truncated = 0;
  let unreadable = 0;
  for (const s of sessions) {
    let d;
    try {
      d = await detectSession(s, { ownRepos });
    } catch {
      unreadable += 1; // one bad session never aborts the sweep
      continue;
    }
    scanned += 1;
    if (d.truncated) truncated += 1;
    if (d.isCandidate) findings.push(d);
  }

  // The configured redactor runs HERE, over everything that leaves detection — not
  // only over drafts. It was built inside the --draft branch at first, which meant the
  // findings ledger was written with de-identification alone: a configured codename,
  // an email, or a private term went to disk raw, in a file the docs tell you to
  // commit BECAUSE it was redacted. `deidentify` handles paths and this machine's
  // account name; it knows nothing about the user's own denylist.
  const redactor = createRedactor(config);
  const ranked = redactor.deepRedact(rankFindings(findings, { publishedErrorStrings: publishedErrorStrings(config) }));
  const pub = publishable(ranked, args.threshold);

  // --- silent-failure guard -------------------------------------------------
  // A corpus that EXISTS but holds no logs means the sensor is blind. Reporting
  // "0 findings" in that state would be indistinguishable from a quiet week, which is
  // the exact confusion this whole guard exists to prevent.
  //
  // Grouped by corpus KIND, not by root. One kind can resolve to several roots — a
  // tool mid-rename has both its old and new directory on disk, and the new one being
  // empty is the NORMAL state, not a fault. Alarming per-root cried wolf on exactly
  // that case; a kind is only blind when every one of its roots came back empty.
  const byKind = new Map();
  for (const c of diagnostics.corpora) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind).push(c);
  }
  //
  // A corpus the caller NAMED explicitly is also blind when none of its roots exists:
  // asking for it and getting nothing back is a fault, whereas a corpus absent from the
  // default all-three sweep just means that tool is not installed here.
  const explicitlyRequested = Array.isArray(args.corpus) && args.corpus.length > 0;
  const blind = [];
  for (const [kind, roots] of byKind.entries()) {
    const anyPresent = roots.some((r) => r.present);
    if (!anyPresent) {
      if (explicitlyRequested) blind.push({ kind, reason: 'no such directory for an explicitly requested corpus' });
      continue;
    }
    if (roots.every((r) => r.filesFound === 0)) {
      blind.push({ kind, reason: 'directory exists but holds zero session logs' });
      continue;
    }
    // Files were found and probed, and NOT ONE yielded a usable identity. A --since
    // skip or a subagent transcript is not a probe failure, so a legitimately quiet
    // window stays exit 0 — this fires only when the reader no longer understands the
    // dialect, i.e. the upstream-format-change hazard the docs warn about. Without it,
    // a format change zeroed `accepted` while filesFound stayed high, and the run
    // still exited 0: a blind sensor reporting a quiet week.
    const probed = roots.reduce((n, r) => n + r.filesProbed, 0);
    const failed = roots.reduce((n, r) => n + (r.probeFailed ?? 0), 0);
    if (probed > 0 && failed === probed) {
      blind.push({ kind, reason: 'log files present but none yielded a session identity (upstream format change?)' });
    }
  }
  // The detector-side twin of the same guard: every session that reached
  // detectSession THREW. The sweep tolerates any one bad session; ALL of them failing
  // means the detector is broken against today's logs, not that nothing happened.
  const allScansFailed = sessions.length > 0 && scanned === 0;
  const sensorOk = blind.length === 0 && !allScansFailed;

  // --- fold into the ledger -------------------------------------------------
  // Only findings that CLEAR THE BAR enter the ledger. A backlog that counted every
  // weak candidate would report dozens of undecided items when the number of things
  // actually worth a person's attention is a handful — and an error signal nobody
  // believes is an error signal nobody acts on. Of sub-threshold candidates only the
  // COUNT survives (the run record's `candidates`); the candidates themselves are
  // discarded at process exit, so lowering the bar means re-running the scan.
  //
  // The ledger is RE-READ here, immediately before merging. A full scan takes tens of
  // seconds across thousands of files, so the copy loaded at the top of this run is
  // stale by now: a `--decide` issued during the scan would be silently overwritten,
  // the finding would revert to `new`, and the human would be asked again about
  // something they already declined. That is the one invariant this file exists to
  // hold, and an unattended weekly run makes the window a normal occurrence.
  const current = loadLedger(ledgerPath);
  current.runs = ledger.runs;
  const merge = mergeFindings(current, pub, { now });
  ledger.findings = current.findings;
  ledger.runs = current.runs;
  recordRun(ledger, {
    at: now.toISOString(),
    sessionsSeen: sessions.length,
    sessionsScanned: scanned,
    sessionsTruncated: truncated,
    sessionsUnreadable: unreadable,
    candidates: findings.length,
    publishable: pub.length,
    corpusFloor: diagnostics.corpusFloor,
    corpora: diagnostics.corpora.map((c) => ({ kind: c.kind, present: c.present, filesFound: c.filesFound, filesProbed: c.filesProbed, probeFailed: c.probeFailed, accepted: c.accepted, oldest: c.oldest, newest: c.newest })),
    blindCorpora: blind.map((c) => c.kind),
    ...merge,
  });

  // --- actuate --------------------------------------------------------------
  let drafted = null;
  if (args.draft) {
    const target = nextToDraft(ledger);
    if (target) {
      const { path, body, title } = renderDraft(target, { config, now, redactor });
      const outPath = resolve(path);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, body, 'utf8');
      setStatus(ledger, target.key, 'drafted', { now, draftPath: path });
      drafted = { key: target.key, path, title };
    }
  }

  saveLedger(ledgerPath, ledger);
  const signal = errorSignal(ledger);

  // --- report ---------------------------------------------------------------
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ sensorOk, blindCorpora: blind.map((c) => c.kind), allSessionsUnreadable: allScansFailed, diagnostics, signal, merge, drafted, publishable: pub.map((f) => ({ key: f.findingKey, score: f.score, primaryError: f.primaryError })) }, null, 2)}\n`,
    );
  } else {
    const w = (s) => process.stdout.write(`${s}\n`);
    w('Corpora scanned');
    const blindKinds = new Set(blind.map((b) => b.kind));
    for (const c of diagnostics.corpora) {
      const range = c.oldest ? `${c.oldest}..${c.newest}` : 'no sessions';
      w(`  ${c.kind.padEnd(12)} files ${String(c.filesFound).padStart(5)}  sessions ${String(c.accepted).padStart(5)}  ${range}${blindKinds.has(c.kind) ? '   <-- BLIND' : ''}`);
    }
    w(`  retention floor: ${diagnostics.corpusFloor ?? 'unknown'} (nothing older survives on disk)`);
    if (ownRepos.length === 0) {
      w('  NOTE: no own-repo list resolved, so issues on YOUR repos count as third-party');
      w('        evidence. Set mine.ownRepos in config to fix.');
    }
    w('');
    w(`Scanned ${scanned} deduped session(s); ${findings.length} candidate(s); ${pub.length} above the score bar of ${args.threshold}.`);
    w(`Ledger: +${merge.added} new, ${merge.refreshed} refreshed, ${merge.suppressed} already decided (left alone).`);
    w('');
    w(`ERROR SIGNAL — backlog ${signal.backlog} undecided; oldest waiting ${signal.oldestOpenDays} day(s).`);
    w(`  discovered ${signal.discovered} all time, ${signal.decided} decided.`);
    if (signal.backlog > 0 && !args.draft) w('  Run with --draft to write the top one up.');
    w('');
    if (drafted) {
      w(`Drafted: ${drafted.path}`);
      w(`  "${drafted.title}"`);
      w('  Every claim in it starts UNVERIFIED. Work the checklist, then publish or decline.');
    } else if (args.draft) {
      w('Nothing new to draft: the backlog holds no undecided, undrafted finding.');
    }
    for (const f of backlog(ledger).slice(0, 8)) {
      w(`  [${String(f.score).padStart(3)}] ${f.status.padEnd(8)} ${f.key.slice(0, 80)}`);
    }
    if (!sensorOk) {
      w('');
      for (const b of blind) w(`WARNING: corpus ${b.kind} is blind: ${b.reason}.`);
      if (allScansFailed) w(`WARNING: all ${sessions.length} session(s) failed to scan — the detector is broken against these logs.`);
      w('A zero from a blind sensor is not evidence of a quiet week. Check the cause before believing it.');
    }
  }

  return sensorOk ? 0 : 2;
}
