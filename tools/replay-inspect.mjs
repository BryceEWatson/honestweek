#!/usr/bin/env node
// tools/replay-inspect.mjs — a developer harness for the work-history engine.
//
// Not part of the published package (package.json "files" ships bin/ and lib/ only).
// It builds a history from your local session logs and prints one level of the
// drill-down at a time, or `walk` to prove every level on a real thread. Output is
// plain text on stdout (or JSON with --json); nothing is written to disk, nothing
// leaves the machine, and every string has passed the redactor.
//
//   node tools/replay-inspect.mjs --config <file> --from 2024-06-10 --to 2024-06-16 overview
//   node tools/replay-inspect.mjs --config <file> --from … --to … thread <thread-id>
//   node tools/replay-inspect.mjs --config <file> --from … --to … walk

import { loadConfig } from '../lib/config.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';

const USAGE = `replay-inspect: drill into an evidence-backed work history.

Usage:
  node tools/replay-inspect.mjs --config <file> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [options] <command> [args]

Commands:
  overview              one row per day and per thread
  thread <id>           sessions, agent tree, links, outcomes, what is missing
  session <key>         agents and turns of one session
  turn <id>             the events of one turn, in order
  event <id>            one event, every field with its evidence level
  record <event-id>     the original log record(s), re-read and digest-checked
  at <ISO-time>         the reconstructed state at that moment
  step <ISO-time> <n>   move n timeline points forward (negative: back) from a moment
  coverage              every record type seen and how it was handled
  walk [thread-id]      prove the full drill-down on one thread (default: the busiest
                        readable thread); exits 1 if any check fails

Options:
  --scope configured|all   sessions outside the configured repos: left out (default)
                           or shown as content-free skeletons
  --claude-root <dir>      read Claude Code logs from here (repeatable)
  --codex-root <dir>       read Codex logs from here (repeatable)
  --timezone <IANA>        day boundaries (default: config week.timezone, else host)
  --no-git                 skip the git outcome lookups
  --json                   print JSON instead of text
  -h, --help               show this help
`;

function parseArgs(argv) {
  const o = { claude: [], codex: [], rest: [], scope: 'configured', git: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--config') o.config = next();
    else if (a === '--from') o.from = next();
    else if (a === '--to') o.to = next();
    else if (a === '--scope') o.scope = next();
    else if (a === '--claude-root') o.claude.push(next());
    else if (a === '--codex-root') o.codex.push(next());
    else if (a === '--timezone') o.timezone = next();
    else if (a === '--no-git') o.git = false;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else o.rest.push(a);
  }
  return o;
}

const local = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not recorded');
const lvl = (evidence) => (evidence === 'recorded' ? '' : ` (${evidence})`);
const m = (x) => (x == null ? '-' : `${x.value}${x.evidence === 'recorded' ? '' : ` (${x.evidence})`}${x.excludesPrivateEvents ? '*' : ''}`);

function printMetrics(out, metrics, indent = '  ') {
  const order = ['prompts', 'corrections', 'approvals', 'decisions', 'interrupts', 'actions', 'actionsWithoutRecordedResult', 'delegations', 'agentsStartedByARecordedCall', 'agentsWithoutARecordedStart', 'edits', 'filesEdited', 'testRuns', 'testRunsAllPassed', 'testRunsWithFailures', 'testRunsWithoutSummary', 'reviews', 'guards', 'errors', 'commitsFoundInGit', 'commitsByConfiguredIdentity', 'prsLanded', 'quietIntervals', 'eventsInPrivateSessions'];
  const parts = order.filter((k) => metrics[k] && metrics[k].value).map((k) => `${k} ${m(metrics[k])}`);
  out(`${indent}${parts.join(', ') || 'nothing recorded'}\n`);
}

export async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const o = parseArgs(argv);
  if (o.help || !o.config || !o.from || !o.to || !o.rest.length) {
    (o.help ? io.out : io.err)(USAGE);
    return o.help ? 0 : 1;
  }
  const config = loadConfig(o.config);
  const roots = o.claude.length || o.codex.length ? { claude: o.claude, codex: o.codex } : undefined;
  const h = await buildWorkHistory({ config, from: o.from, to: o.to, timezone: o.timezone, roots, scope: o.scope, git: o.git });
  const tz = h.window.timezone;
  const [cmd, ...args] = o.rest;
  const out = io.out;
  const emit = (value) => out(`${JSON.stringify(value, null, 2)}\n`);

  if (cmd === 'overview') {
    const v = h.overview();
    if (o.json) return emit(v), 0;
    out(`Work history ${h.window.from} to ${h.window.to} (${tz}). ${h.sessions.length} sessions, ${h.events.length} events, ${h.threads.length} threads.\n`);
    out(`Levels: plain = recorded; (derived) computed from records; (inferred) a named rule; * = private sessions not read.\n\n`);
    for (const d of v.days) {
      out(`${d.date}: ${d.sessions.value} sessions\n`);
      printMetrics(out, d.metrics);
    }
    out(`\nThreads:\n`);
    for (const t of v.threads) {
      out(`  ${t.id}  ${t.private ? '[private]' : t.title ?? '(untitled)'}  ${local(t.firstAt, tz)} to ${local(t.lastAt, tz)}, ${t.sessions.value} session(s), ${t.agentRecords.value} agent record(s), ${t.events} events\n`);
    }
    if (v.sessionsOutsideConfiguredRepos) out(`\n${v.sessionsOutsideConfiguredRepos} session(s) outside the configured repos were left out (use --scope all to show them as skeletons).\n`);
    return 0;
  }
  if (cmd === 'thread') {
    const v = h.thread(args[0]);
    if (!v) return io.err(`no thread ${args[0]}\n`), 1;
    if (o.json) return emit(v), 0;
    out(`Thread ${v.id}: ${v.title ?? '(untitled)'}\n  ${local(v.firstAt, tz)} to ${local(v.lastAt, tz)} (span of recorded records, not working time)\n`);
    printMetrics(out, v.metrics);
    out(`\nSessions:\n`);
    for (const s of v.sessions) out(`  ${s.key} ${s.tool} ${s.repo ?? ''} ${s.private ? '[private]' : ''} ${s.turns} turns, ${s.agents} agents, last record: ${s.endState}\n`);
    out(`\nAgents (who started whom, as recorded):\n`);
    const walkTree = (nodes, depth) => {
      for (const a of nodes) {
        out(`  ${'  '.repeat(depth)}${a.kind} ${a.key}${a.type ? ` [${a.type}]` : ''}${a.description ? ` "${a.description}"` : ''}  ${local(a.spawnAt ?? a.firstAt, tz)} to ${local(a.completion?.at ?? a.lastAt, tz)}${a.completion ? ` (${a.completion.status ?? 'done'} via ${a.completion.via})` : ''}${a.missing.length ? `  missing: ${a.missing.join(', ')}` : ''}\n`);
        walkTree(a.children, depth + 1);
      }
    };
    walkTree(v.agentTree, 0);
    for (const a of v.agentsWithoutRecordedParent) out(`  (no recorded parent) ${a.kind} ${a.key} missing: ${a.missing.join(', ')}\n`);
    out(`\nOutcomes (from git; how each ties to its session is marked):\n`);
    for (const e of v.outcomes) out(`  ${local(e.at, tz)}  ${e.text}${e.evidence === 'recorded' ? '' : ` (${e.evidence})`}${e.inferred.length ? `  [${e.inferred.join('; ')}]` : ''}\n`);
    if (!v.outcomes.length) out('  none recorded\n');
    out(`\nLinks: ${v.links.length} (${[...new Set(v.links.map((l) => `${l.type}/${l.evidence}`))].join(', ') || 'none'})\n`);
    if (v.related.handoffs.length) out(`Inferred hand-offs: ${v.related.handoffs.map((l) => l.to).join(', ')}\n`);
    if (v.related.sessionsSharingAPullRequest.length) out(`Other sessions linked to the same pull requests: ${v.related.sessionsSharingAPullRequest.map((x) => x.session).join(', ')}\n`);
    out(`\nMissing evidence: ${v.missing.length}\n`);
    for (const x of v.missing.slice(0, 12)) out(`  ${x.event ?? x.agent}: ${x.missing}${x.text ? `  (${x.text.slice(0, 100)})` : ''}\n`);
    return 0;
  }
  if (cmd === 'session') {
    const v = h.session(args[0]);
    if (!v) return io.err(`no session ${args[0]}\n`), 1;
    if (o.json) return emit(v), 0;
    out(`Session ${v.key} (${v.tool}, ${v.repo ?? 'no repo'}${v.private ? ', private' : ''}) in thread ${v.thread}\n  ${v.title ?? ''}\n  ${local(v.firstAt, tz)} to ${local(v.lastAt, tz)}; last record: ${v.endState}\n`);
    printMetrics(out, v.metrics);
    out(`\nTurns:\n`);
    for (const t of v.turns) out(`  ${t.id}  ${local(t.startAt, tz)}  ${t.events} events, ${t.actions} actions${t.stopRecorded ? '' : ', no recorded turn end'}  ${t.opener?.text.slice(0, 110) ?? ''}\n`);
    return 0;
  }
  if (cmd === 'turn') {
    const v = h.turn(args[0]);
    if (!v) return io.err(`no turn ${args[0]}\n`), 1;
    if (o.json) return emit(v), 0;
    out(`Turn ${v.id} in session ${v.session}, ${local(v.startAt, tz)}; ${v.events.length} events\n`);
    for (const e of v.events) out(`  ${local(e.at, tz)}  ${e.kind.padEnd(19)} ${e.actor.padEnd(8)} ${e.text.slice(0, 140)}${e.inferred.length ? `  {${e.inferred.join('; ')}}` : ''}${e.missing.length ? `  [missing: ${e.missing.join(', ')}]` : ''}\n      ${e.id}\n`);
    return 0;
  }
  if (cmd === 'event') {
    const v = h.event(args[0]);
    if (!v) return io.err(`no event ${args[0]}\n`), 1;
    return emit(v), 0;
  }
  if (cmd === 'record') {
    const v = h.record(args[0]);
    if (!v.length) return io.err(`no event ${args[0]}\n`), 1;
    return emit(v), v.every((x) => x.verified !== false) ? 0 : 1;
  }
  if (cmd === 'at') {
    const v = h.stateAt(args[0]);
    return emit(v), 0;
  }
  if (cmd === 'step') {
    const from = h.timeline.cursorAt(Date.parse(args[0]));
    const s = h.timeline.step(from, Number(args[1] ?? 1));
    const e = s.event ? h.event(s.event) : null;
    return emit({ from, ...s, description: e?.description ?? null, state: h.timeline.stateAtCursor(s.cursor) }), 0;
  }
  if (cmd === 'coverage') {
    if (o.json) return emit(h.coverage), 0;
    for (const [tool, table] of Object.entries(h.coverage)) {
      out(`${tool}:\n`);
      for (const [k, v] of Object.entries(table).sort((a, b) => b[1].count - a[1].count)) out(`  ${String(v.count).padStart(7)}  ${k.padEnd(42)} ${v.handling}\n`);
    }
    return 0;
  }
  if (cmd === 'walk') return walk(h, args[0], { out, json: o.json, tz });
  io.err(`unknown command "${cmd}"\n\n${USAGE}`);
  return 1;
}

/** Drill from the weekly overview down to individual records on one thread, then
 *  scrub its time axis, checking each step. Prints what it saw; exits 1 on a failure. */
function walk(h, threadId, { out, json, tz }) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  let samples = [];
  let scrub = [];
  let sessionKey = null;
  let busiest = null;
  let turn = null;
  let nextPrompt = null;
  let prevPrompt = null;
  const ov = h.overview();
  check('overview has at least one day', ov.days.length > 0, `${ov.days.length} days`);
  const readable = ov.threads.filter((t) => !t.private);
  const pick = threadId ? ov.threads.find((t) => t.id === threadId) : [...readable].sort((a, b) => b.events - a.events || (a.id < b.id ? -1 : 1))[0];
  check('a thread to walk exists', pick, pick?.id ?? 'none');
  if (!pick) return finish();
  const th = h.thread(pick.id);
  check('thread view resolves', th, `${th?.sessions.length ?? 0} sessions`);
  if (!th?.sessions.length) return finish();
  sessionKey = [...th.sessions].sort((a, b) => b.turns - a.turns)[0].key;
  const sess = h.session(sessionKey);
  check('session view resolves', sess && sess.turns.length > 0, `${sess?.turns.length ?? 0} turns`);
  if (!sess?.turns.length) return finish();
  busiest = [...sess.turns].sort((a, b) => b.events - a.events || (a.id < b.id ? -1 : 1))[0];
  turn = h.turn(busiest.id);
  check('turn view resolves', turn && turn.events.length > 0, `${turn?.events.length ?? 0} events`);

  const sessionEvents = h.events.filter((e) => th.sessions.some((s) => s.key === e.session));
  const kinds = [...new Set(sessionEvents.map((e) => e.kind))].sort();
  for (const k of kinds) {
    const e = sessionEvents.find((x) => x.kind === k && x.refs.length);
    if (!e) continue;
    const full = h.event(e.id);
    const recs = h.record(e.id);
    const verified = recs.every((r) => r.verified !== false);
    check(`record behind a "${k}" event re-reads with a matching digest`, verified, `${recs.length} record(s)`);
    samples.push({ kind: k, event: full.id, description: full.description, inferred: full.inferred.map((x) => `${x.value} [${x.rule}]`), missing: full.missing, records: recs.map((r) => ({ verified: r.verified, line: r.ref.line, type: r.record?.type ?? (r.ref.sha ? 'git' : null) })) });
  }

  // Time scrubbing across the thread's recorded span.
  const t0 = Date.parse(pick.firstAt);
  const t1 = Date.parse(pick.lastAt);
  const instants = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(t0 + (t1 - t0) * f));
  // The thread's own timeline: other sessions running at the same time are not mixed in.
  const tl = h.threadTimeline(pick.id);
  scrub = instants.map((t) => {
    const a = h.stateAt(t, { thread: pick.id });
    const b = h.stateAt(t, { thread: pick.id, fromScratch: true });
    const same = JSON.stringify(a) === JSON.stringify(b);
    check(`state at ${new Date(t).toISOString()} is the same from a snapshot and from scratch`, same);
    return { at: new Date(t).toISOString(), local: local(new Date(t).toISOString(), tz), prompts: a.counts.prompts, actions: a.counts.actions, sessionsOpen: a.sessionsWithOpenRecordedSpan.length, agentSpansOpen: a.agentsWithOpenRecordedSpan.length, callsAwaitingResult: a.callsAwaitingRecordedResult.length, queued: a.messagesQueued.length, testRuns: a.counts.testRuns, prsLanded: a.counts.prsLanded, evidence: { prompts: a.countEvidence.prompts, testRuns: a.countEvidence.testRuns, prsLanded: a.countEvidence.prsLanded } };
  });
  const totals = h.thread(pick.id).metrics;
  check('the state at the end of the thread matches the thread totals', scrub.at(-1).prompts === totals.prompts.value && scrub.at(-1).actions === totals.actions.value, `${scrub.at(-1).prompts}/${totals.prompts.value} prompts, ${scrub.at(-1).actions}/${totals.actions.value} actions`);
  const mid = tl.cursorAt(instants[2]);
  const fwd = tl.step(mid, 3);
  const back = tl.step(fwd.cursor, -3);
  check('stepping forward 3 points and back 3 returns to the same point', back.cursor === mid, `${mid} -> ${fwd.cursor} -> ${back.cursor}`);
  const monotone = scrub.every((s, i) => i === 0 || (s.actions >= scrub[i - 1].actions && s.prompts >= scrub[i - 1].prompts));
  check('cumulative counts never decrease as time moves forward', monotone);
  nextPrompt = tl.seekWhere(mid, 1, (e, phase) => e.kind === 'prompt' && phase === 'start');
  prevPrompt = tl.seekWhere(mid, -1, (e, phase) => e.kind === 'prompt' && phase === 'start');

  return finish();

  function finish() {
    const failed = checks.filter((c) => !c.ok);
    const report = { thread: pick?.id ?? null, title: pick?.title ?? null, checks, samples, scrub };
    if (json) out(`${JSON.stringify(report, null, 2)}\n`);
    else {
      out(`Walk of thread ${report.thread}: ${report.title ?? ''}\n\n`);
      if (pick && turn) {
        out(`Overview -> thread -> session ${sessionKey} -> turn ${busiest.id} (${turn.events.length} events)\n\nOne event of each kind, with its record:\n`);
        for (const s of samples) out(`  ${s.kind.padEnd(19)} ${s.description.slice(0, 110)}${s.inferred.length ? `  {${s.inferred.join('; ')}}` : ''}${s.missing.length ? `  [missing: ${s.missing.join(', ')}]` : ''}\n${' '.repeat(22)}records: ${s.records.map((r) => `line ${r.line ?? 'git'} ${r.verified === true ? 'verified' : r.verified === null ? 'git object' : 'NOT VERIFIED'}`).join('; ')}\n`);
        out(`\nScrubbing the thread's recorded span:\n`);
        for (const s of scrub) out(`  ${s.local.padEnd(18)} prompts ${s.prompts}${lvl(s.evidence.prompts)}, actions ${s.actions}, sessions open ${s.sessionsOpen}, agent spans open ${s.agentSpansOpen}, calls awaiting a result ${s.callsAwaitingResult}, queued messages ${s.queued}, test runs ${s.testRuns}${lvl(s.evidence.testRuns)}, PRs landed ${s.prsLanded}${lvl(s.evidence.prsLanded)}\n`);
        if (nextPrompt) out(`  next prompt after the midpoint: ${local(new Date(nextPrompt.t).toISOString(), tz)}; previous: ${prevPrompt ? local(new Date(prevPrompt.t).toISOString(), tz) : 'none'}\n`);
      }
      out(`\nChecks: ${checks.length - failed.length} of ${checks.length} passed\n`);
      for (const c of failed) out(`  FAILED: ${c.name} ${c.detail}\n`);
    }
    return failed.length ? 1 : 0;
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`replay-inspect: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
