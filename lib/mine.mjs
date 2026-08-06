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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadConfig } from './config.mjs';
import { createRedactor } from './redact.mjs';
import { enumerateSessions } from './mine/corpus.mjs';
import { detectSession } from './mine/detect.mjs';
import { rankFindings, publishable, PUBLISHABLE_THRESHOLD } from './mine/rank.mjs';
import { renderDraft } from './mine/draft.mjs';
import { backlog, errorSignal, loadLedger, mergeFindings, nextToDraft, recordRun, saveLedger, setStatus } from './mine/ledger.mjs';

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
  2  a configured corpus yielded ZERO log files — the sensor is blind, which is
     NOT the same as finding nothing. Fix the root before trusting a zero.
`;

function parseArgs(argv) {
  const out = { corpus: null, draft: false, json: false, threshold: PUBLISHABLE_THRESHOLD, decide: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--draft') out.draft = true;
    else if (a === '--json') out.json = true;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--ledger') out.ledger = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--corpus') out.corpus = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--decide') out.decide = argv[++i];
    else if (a === '--threshold') out.threshold = Number(argv[++i]);
    else if (a.startsWith('-')) throw new Error(`unknown option "${a}"`);
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
  for (const s of config?.mine?.ownRepos ?? []) if (typeof s === 'string' && s.includes('/')) slugs.add(s);
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

  const configPath = resolve(args.config ?? 'honestweek.config.json');
  let config = {};
  try {
    config = loadConfig(configPath);
  } catch (err) {
    // Mining works without a config; it only loses repo-aware attribution and the
    // redaction denylist. Say so rather than failing, but never pretend it was there.
    process.stderr.write(`honestweek mine: no usable config at ${configPath} (${err.message}); continuing without repo context.\n`);
  }

  const ledgerPath = resolve(args.ledger ?? config?.mine?.ledger ?? 'honestweek.findings.json');
  const ledger = loadLedger(ledgerPath);
  const now = new Date();

  // --- a human decision, recorded ------------------------------------------
  if (args.decide) {
    const [key, status] = String(args.decide).split('=');
    const updated = setStatus(ledger, key, status, { now });
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

  const ranked = rankFindings(findings, { publishedErrorStrings: publishedErrorStrings(config) });
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
  const blind = [...byKind.entries()]
    .filter(([, roots]) => roots.some((r) => r.present) && roots.every((r) => r.filesFound === 0))
    .map(([kind]) => ({ kind }));
  const sensorOk = blind.length === 0;

  // --- fold into the ledger -------------------------------------------------
  // Only findings that CLEAR THE BAR enter the ledger. A backlog that counted every
  // weak candidate would report dozens of undecided items when the number of things
  // actually worth a person's attention is a handful — and an error signal nobody
  // believes is an error signal nobody acts on. Sub-threshold candidates stay in the
  // run record, where they remain auditable without polluting the signal.
  const merge = mergeFindings(ledger, pub, { now });
  recordRun(ledger, {
    at: now.toISOString(),
    sessionsSeen: sessions.length,
    sessionsScanned: scanned,
    sessionsTruncated: truncated,
    sessionsUnreadable: unreadable,
    candidates: findings.length,
    publishable: pub.length,
    corpusFloor: diagnostics.corpusFloor,
    corpora: diagnostics.corpora.map((c) => ({ kind: c.kind, present: c.present, filesFound: c.filesFound, accepted: c.accepted, oldest: c.oldest, newest: c.newest })),
    blindCorpora: blind.map((c) => c.kind),
    ...merge,
  });

  // --- actuate --------------------------------------------------------------
  let drafted = null;
  if (args.draft) {
    const target = nextToDraft(ledger);
    if (target) {
      const redactor = createRedactor(config);
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
      `${JSON.stringify({ sensorOk, blindCorpora: blind.map((c) => c.kind), diagnostics, signal, merge, drafted, publishable: pub.map((f) => ({ key: f.findingKey, score: f.score, primaryError: f.primaryError })) }, null, 2)}\n`,
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
      w(`WARNING: ${blind.map((c) => c.kind).join(', ')} resolved to a real directory containing zero session logs.`);
      w('A zero from a blind sensor is not evidence of a quiet week. Check the root before believing it.');
    }
  }

  return sensorOk ? 0 : 2;
}
