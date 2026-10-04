// lib/problems/checks.mjs: the problem checks. Each reads the shared context (context.mjs)
// and returns findings.
//
// A finding says what the log shows and how that's known, never why it happened, and never
// "failed": every pattern here can be legitimate. Its severity is 'look' (worth a look) or
// 'note' (routine, shown but never raising a priority). verdictEvidence is the weakest link
// the finding rests on (AGENTS.md invariant 3). Notes are built from fixed words and numbers
// only; no text from a log reaches one, and token counts are written short (340k, 1.2M) so
// no long digit run reads as an account number.
//
//   { severity, verdictEvidence, rule, session, event, related?, relatedLabel?, at, lastAt?,
//     note, events?, steps?, estimate?, kind?, stepsNear? }
//
// The steps a finding covers are only steps its check matched: `event`, `related` and `events`
// (the first 50, or for a done claim the last 20 edits and the message), with `steps` counting
// every one `events` stands for. `stepsNear` marks a finding whose check matched something other
// than steps (model calls), so its `event` is only the nearest step, never the whole of it.

import { isPrLanded, testRunResult } from '../replay/metrics.mjs';
import { BUILD_CHECKS, classifyAgentText, classifyPrompt, commitStep, endsWithQuestion, PLAN_FILE_RE, riskyKinds, SECRET_KIND_WORDS, secretShapes, similarity } from './classify.mjs';
import { isExecInstruction, isPersonPrompt, THRESHOLDS } from './context.mjs';

export const plural = (n, one, many = `${one}s`) => `${Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : n} ${n === 1 ? one : many}`;
/** Token counts in notes: 1.2M, 340k. Never a bare long digit run. */
export function fmt(n) {
  if (!Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
export function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 60e3) return `${Math.round(ms / 1e3)} s`;
  if (ms < 3600e3) return `${Math.round(ms / 60e3)} min`;
  return `${(ms / 3600e3).toFixed(1)} h`;
}
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const TOOL_WORD = { shell: 'shell', edit: 'edit', read: 'file read', search: 'search', web: 'web', delegate: 'sub-agent start', browser: 'browser', external: 'connector', wait: 'wait', plan: 'plan', skill: 'skill', other: 'other tool' };
const toolWord = (cat) => TOOL_WORD[cat] ?? 'tool';
const sumCost = (steps) => steps.reduce((m, s) => m + (s.cost?.total ?? 0), 0);
const isCheckStep = (s) => !!s.check && s.result !== 'refused';
const runnableEdit = (s) => s.cat === 'edit' && s.result === 'ok' && s.edit && (s.edit.kind === 'code' || s.edit.kind === 'test');
const DID_NOT_RUN = new Set(['rejected', 'refused', 'interrupted']);
const rawText = (e) => (typeof e?._raw?.text === 'string' ? e._raw.text : null);

// ---------------------------------------------------------------------------------------
// Correctness and honesty
// ---------------------------------------------------------------------------------------

function unverifiedDoneClaim(c) {
  const out = [];
  const tally = { turns: 0, withEdits: 0, checked: 0, delegated: 0, noFinal: 0, noClaim: 0, honest: 0, flat: 0, hedged: 0 };
  for (const s of c.sessions) {
    const turns = c.turnsOf(s.key);
    for (const turn of turns) {
      if (!c.inWin(turn.prompt.t)) continue;
      tally.turns++;
      const edits = turn.steps.filter(runnableEdit);
      if (!edits.length) continue;
      tally.withEdits++;
      const last = edits.at(-1);
      const rest = turn.steps.slice(turn.steps.indexOf(last) + 1);
      if (rest.some((x) => x.cat === 'delegate')) {
        tally.delegated++;
        continue;
      }
      if (rest.some(isCheckStep)) {
        tally.checked++;
        continue;
      }
      const fin = c.finalMessage(turn);
      const text = rawText(fin);
      if (text == null) {
        tally.noFinal++;
        continue;
      }
      const fl = classifyAgentText(text);
      if (fl.admitsNoCheck) {
        tally.honest++;
        continue;
      }
      if (!fl.flat && !fl.hedged) {
        tally.noClaim++;
        continue;
      }
      tally[fl.flat ? 'flat' : 'hedged']++;
      const files = new Set(edits.map((x) => x.edit.key)).size;
      out.push({
        severity: fl.flat ? 'look' : 'note',
        verdictEvidence: 'inferred',
        rule: 'problems.completion-claim, problems.check-step, problems.runnable-file',
        session: s.key,
        event: fin.id,
        related: last.ev,
        relatedLabel: 'Replay at the last edit',
        at: iso(fin.t),
        lastTurn: turn === turns.at(-1),
        events: [...edits.slice(-20).map((x) => x.ev), fin.id],
        steps: edits.length + 1,
        note: `This turn made ${plural(edits.length, 'successful edit')} to ${plural(files, 'code or test file')}, and its last message reads as a ${fl.flat ? 'flat' : 'hedged ("should work")'} completion claim. No test run, build, type check, run of the code, browser step or review skill came after the last edit, and no sub-agent started after it.`,
      });
    }
  }
  return {
    findings: out,
    checked: `${plural(tally.turns, 'turn')} in the window; ${plural(tally.withEdits, 'turn')} edited code or test files. Of those, ${tally.checked} ran a check after the last edit, ${tally.delegated} started a sub-agent after it (which may have checked), ${tally.honest} said plainly what wasn't run, ${tally.noClaim} ended on a message with no completion claim, and ${tally.noFinal} didn't end on a message this page could read.`,
    stats: [
      { label: 'Turns that edited code, ran no check after the last edit, and ended on a flat completion claim', value: tally.flat, unit: 'count', evidence: 'inferred' },
      { label: 'The same, with a hedged claim ("should work")', value: tally.hedged, unit: 'count', evidence: 'inferred' },
      { label: 'Turns that edited code and ran a check after the last edit', value: tally.checked, unit: 'count', evidence: 'inferred' },
      { label: "Turns that said plainly what they didn't run", value: tally.honest, unit: 'count', evidence: 'inferred' },
    ],
  };
}

function prLandedWithoutTests(c) {
  const out = [];
  const seen = new Set();
  // Only pull requests that landed in the window: a session's events can run past its edges.
  for (const o of c.events.filter((e) => isPrLanded(e) && c.inWin(e.t))) {
    const k = `${o.facts.repo}#${o.facts.pr}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let keys = [];
    try {
      keys = (c.h.lookup?.({ kind: 'pr', owner: null, repo: null, number: o.facts.pr })?.sessions ?? []).map((r) => r.session);
    } catch {
      keys = [];
    }
    const repo = c.sessionsByKey.get(o.session)?.repo ?? null;
    keys = [...new Set([o.session, ...keys])].filter((s) => c.configured.has(s) && c.sessionsByKey.get(s)?.repo === repo);
    const runs = keys.flatMap((s) => (c.eventsBySession.get(s) ?? []).filter((e) => testRunResult(e)));
    if (runs.length) continue;
    out.push({ severity: 'look', verdictEvidence: 'inferred', rule: 'git.pr-number-from-subject, shell.test', session: o.session, event: o.id, at: iso(o.t), note: `A pull request landed on the default branch, and none of the ${plural(keys.length, 'session')} in this window that point at it recorded a test run. CI, and runs in sessions before this window, aren't visible here.` });
  }
  return { findings: out, checked: `${plural(seen.size, 'landed pull request')} with a session in this window.`, stats: [{ label: 'Landed pull requests with no test run in their sessions', value: out.length, unit: 'count', evidence: 'inferred' }] };
}

function claimContradictsEvidence(c) {
  const out = [];
  const tally = { turns: 0, endedFailed: 0, claims: 0, dismissed: 0, baseRun: 0 };
  for (const s of c.sessions) {
    const turns = c.turnsOf(s.key);
    for (const turn of turns) {
      if (!c.inWin(turn.prompt.t)) continue;
      const checks = turn.steps.filter((x) => x.result !== 'refused' && (x.test === 'passed' || x.test === 'failed' || (BUILD_CHECKS.has(x.check) && (x.result === 'ok' || x.result === 'error'))));
      if (!checks.length) continue;
      tally.turns++;
      const last = checks.at(-1);
      const failed = last.test ? last.test === 'failed' : last.result === 'error';
      if (!failed) continue;
      tally.endedFailed++;
      const fin = c.finalMessage(turn);
      const text = rawText(fin);
      if (text == null) continue;
      const fl = classifyAgentText(text);
      const what = last.test ? `a test run that failed${last.summary ? ` (${last.summary.fail} failed, ${last.summary.pass} passed)` : ''}` : `a ${last.check} command that recorded an error`;
      if (fl.flat || fl.testsPass) {
        tally.claims++;
        out.push({ severity: 'look', verdictEvidence: 'inferred', rule: 'shell.test or problems.check-step, then problems.completion-claim or problems.tests-pass-claim', session: s.key, event: fin.id, related: last.ev, relatedLabel: 'Replay at the failed check', at: iso(fin.t), lastTurn: turn === turns.at(-1), kind: 'claims success', note: `The last check in this turn was ${what}, with no passing run after it, and the turn's last message reads as ${fl.testsPass ? 'saying tests pass' : 'a completion claim'}.` });
        continue;
      }
      if (fl.dismisses && last.test) {
        const idx = turn.steps.indexOf(last);
        const baseRun = turn.steps.slice(0, idx).some((x, i, arr) => x.gitBase && arr.slice(i + 1).some((y) => y.test));
        if (baseRun) {
          tally.baseRun++;
          continue;
        }
        tally.dismissed++;
        out.push({ severity: 'look', verdictEvidence: 'inferred', rule: 'shell.test, problems.dismisses-failure', session: s.key, event: fin.id, related: last.ev, relatedLabel: 'Replay at the failed run', at: iso(fin.t), lastTurn: turn === turns.at(-1), kind: 'calls the failure pre-existing', note: `The last test run in this turn failed${last.summary ? ` (${last.summary.fail} failed)` : ''}, and the turn's last message calls a failure pre-existing, unrelated or flaky. No run on another checkout (after a git stash, checkout, switch or worktree command) is recorded in the turn to back that.` });
      }
    }
  }
  return {
    findings: out,
    checked: `${plural(tally.turns, 'turn')} in the window ran a test, build, lint or type check with a clear result; ${tally.endedFailed} ended with that check failing.`,
    stats: [
      { label: 'Turns whose last check failed and whose last message claims success', value: tally.claims, unit: 'count', evidence: 'inferred' },
      { label: 'Turns whose last test run failed and whose last message calls it pre-existing or unrelated, with no base run recorded', value: tally.dismissed, unit: 'count', evidence: 'inferred' },
      { label: 'Turns whose last check failed (any last message)', value: tally.endedFailed, unit: 'count', evidence: 'derived' },
    ],
  };
}

function commitAfterFailedTest(c) {
  const out = [];
  const runTally = {};
  let steps = 0;
  for (const s of c.sessions) {
    const runsByAgent = new Map();
    const flagged = new Map();
    for (const e of c.eventsBySession.get(s.key) ?? []) {
      const r = testRunResult(e);
      if (r) {
        runTally[r] = (runTally[r] ?? 0) + 1;
        (runsByAgent.get(e.agent) ?? runsByAgent.set(e.agent, []).get(e.agent)).push({ e, r });
        continue;
      }
      const step = commitStep(e, c.steps.get(e.id)?.cmd);
      if (!step || !c.inWin(e.t)) continue;
      steps++;
      const runs = runsByAgent.get(e.agent) ?? [];
      let skipped = 0;
      let decisive = null;
      for (let i = runs.length - 1; i >= 0; i--) {
        if (runs[i].r === 'passed' || runs[i].r === 'failed') {
          decisive = runs[i];
          break;
        }
        skipped++;
      }
      if (!decisive || decisive.r !== 'failed') continue;
      const have = flagged.get(decisive.e.id);
      if (have) {
        have.more += 1;
        have.later.push(e.id);
        have.note = noteFor(have);
        continue;
      }
      const t = decisive.e.derived?.tests;
      const f = { severity: 'look', verdictEvidence: 'inferred', rule: `shell.test, ${step.rule ?? 'the harness record'}`, session: s.key, event: e.id, related: decisive.e.id, relatedLabel: 'Replay at the failed run', at: iso(e.t), what: step.what, skipped, more: 0, later: [], summary: t ? `${t.fail} failed, ${t.pass} passed` : null };
      f.note = noteFor(f);
      flagged.set(decisive.e.id, f);
      out.push(f);
    }
  }
  function noteFor(f) {
    return `This agent ${f.what} after a test run that failed${f.summary ? ` (${f.summary})` : ''}, with no passing run in between${f.skipped ? `; ${plural(f.skipped, 'run')} in between printed no clear result` : ''}.${f.more ? ` ${plural(f.more, 'more commit or merge step')} followed before any run passed.` : ''}`;
  }
  const runs = Object.values(runTally).reduce((a, b) => a + b, 0);
  for (const f of out) {
    // The later commit or merge steps this check counted are steps it matched too: recorded, so a
    // zoom marks them, and only when there are some, so a finding without them is unchanged.
    if (f.later.length) {
      f.events = [f.related, f.event, ...f.later].slice(0, 50);
      f.steps = f.later.length + 2;
    }
    delete f.what;
    delete f.skipped;
    delete f.more;
    delete f.later;
    delete f.summary;
  }
  return { findings: out, checked: `${plural(steps, 'commit or merge step')} and ${plural(runs, 'test run')} (${runTally.passed ?? 0} passed, ${runTally.failed ?? 0} failed, ${runTally.unclear ?? 0} unclear, ${runTally['no-summary'] ?? 0} with no summary).`, stats: [{ label: 'Commits or merges right after a failed test run', value: out.length, unit: 'count', evidence: 'inferred' }] };
}

function testTampering(c) {
  const out = [];
  const tally = { testEdits: 0, wholeWrites: 0, turns: 0, exclusions: 0 };
  // A test command that gained an exclusion since the same runner's last run by that agent.
  const exclAdded = new Set();
  for (const list of c.stepsByAgent.values()) {
    const prev = new Map();
    for (const s of list) {
      if (!s.runner || s.result === 'refused') continue;
      const p = prev.get(s.runner);
      if (s.testExcl && p && !p.testExcl) exclAdded.add(s.ev);
      prev.set(s.runner, s);
    }
  }
  for (const s of c.sessions) {
    for (const turn of c.turnsOf(s.key)) {
      if (!c.inWin(turn.prompt.t)) continue;
      const tests = turn.steps.filter((x) => x.cat === 'edit' && x.result === 'ok' && x.edit && (x.edit.test || x.edit.testConfig));
      const excl = turn.steps.filter((x) => exclAdded.has(x.ev));
      if (!tests.length && !excl.length) continue;
      tally.turns++;
      tally.testEdits += tests.length;
      tally.wholeWrites += tests.filter((x) => x.edit.whole).length;
      tally.exclusions += excl.length;
      const sum = { assertNet: 0, testsNet: 0, skipAdded: 0, exitAdded: 0, commentedAdded: 0, deleted: 0 };
      for (const x of tests) {
        if (x.edit.deleted && x.edit.test) sum.deleted++;
        for (const k of Object.keys(x.edit.tests ?? {})) sum[k] += x.edit.tests[k];
      }
      const hitSteps = tests.filter((x) => {
        const t = x.edit.tests ?? {};
        return (x.edit.deleted && x.edit.test) || (sum.assertNet > 0 && t.assertNet > 0) || (sum.testsNet > 0 && t.testsNet > 0) || t.skipAdded || t.exitAdded || t.commentedAdded;
      });
      const configAfterFail = tests.filter((x) => x.edit.testConfig && !x.edit.test).filter((x) => {
        const before = turn.steps.slice(0, turn.steps.indexOf(x)).filter((y) => y.test === 'passed' || y.test === 'failed');
        return before.at(-1)?.test === 'failed';
      });
      const signals = [];
      if (sum.assertNet > 0) signals.push(`${plural(sum.assertNet, 'assertion line')} removed, net across the turn's test edits`);
      if (sum.testsNet > 0) signals.push(`${plural(sum.testsNet, 'test definition')} removed, net`);
      if (sum.skipAdded) signals.push(`${plural(sum.skipAdded, 'skip, focus or todo marker')} added`);
      if (sum.commentedAdded) signals.push(`${plural(sum.commentedAdded, 'assertion')} commented out`);
      if (sum.exitAdded) signals.push(`${plural(sum.exitAdded, 'early exit')} added to a test file`);
      if (sum.deleted) signals.push(`${plural(sum.deleted, 'test file')} deleted in a patch`);
      if (excl.length) signals.push(`${plural(excl.length, 'test command')} gained an exclusion (--ignore, -k "not", || true and similar)`);
      if (configAfterFail.length) signals.push(`test configuration edited ${plural(configAfterFail.length, 'time')} after a failed run`);
      if (!signals.length) continue;
      const all = [...hitSteps, ...excl, ...configAfterFail].sort((x, y) => x.seq - y.seq);
      const first = all[0];
      const before = turn.steps.slice(0, turn.steps.indexOf(first)).filter((y) => y.test === 'passed' || y.test === 'failed');
      const afterFail = before.at(-1)?.test === 'failed';
      const asked = classifyPrompt(rawText(turn.prompt) ?? '').mentionsTests;
      const evs = [...new Set(all.map((x) => x.ev))];
      out.push({
        severity: asked ? 'note' : 'look',
        verdictEvidence: 'inferred',
        rule: `problems.test-file, problems.test-weakening${excl.length ? ', problems.test-exclusion' : ''}`,
        session: s.key,
        event: first.ev,
        at: iso(first.t),
        lastAt: iso(all.at(-1).t),
        afterFailedRun: afterFail,
        events: evs.slice(0, 50),
        steps: evs.length,
        note: `In one turn: ${signals.join('; ')}.${afterFail ? ' The first of these came after a failed test run, before any passing one.' : ''}${asked ? ' The prompt for this turn mentions tests, so the change may have been asked for.' : ''} Whether it was done to get a green run isn't in the log.`,
      });
    }
  }
  return {
    findings: out,
    checked: `${plural(tally.testEdits, 'successful edit')} to test files or test configuration in ${plural(tally.turns, 'turn')} (${tally.wholeWrites} of them whole-file writes, which aren't compared), and ${plural(tally.exclusions, 'test command')} that gained an exclusion.`,
    stats: [
      { label: 'Turns with a test weakened, skipped, excluded or deleted', value: out.length, unit: 'count', evidence: 'inferred' },
      { label: 'Of those, after a failed run and before a passing one', value: out.filter((f) => f.afterFailedRun).length, unit: 'count', evidence: 'inferred' },
      { label: 'Of those, where the prompt mentions tests (shown as notes)', value: out.filter((f) => f.severity === 'note').length, unit: 'count', evidence: 'inferred' },
    ],
  };
}

// ---------------------------------------------------------------------------------------
// Efficiency and cost
// ---------------------------------------------------------------------------------------

function actionLoop(c) {
  const { loopMin: MIN, loopGapMs: GAP, retryMin } = THRESHOLDS;
  const out = [];
  let eligible = 0;
  let flips = 0;
  let retries = 0;
  for (const [agent, list] of c.stepsByAgent) {
    const steps = list.filter((s) => c.inWin(s.t) && s.result !== 'refused');
    let run = null;
    const close = () => {
      if (run && run.steps.length >= MIN) {
        const first = run.steps[0];
        const extra = run.steps.slice(1);
        const cost = sumCost(extra);
        const failures = run.steps.filter((s) => s.result === 'error').length;
        out.push({ severity: 'look', verdictEvidence: 'derived', rule: 'problems.same-call, problems.no-change-between; cost.step', session: first.session, event: first.ev, at: iso(first.t), lastAt: iso(run.steps.at(-1).t), kind: 'same call repeated', estimate: cost, events: run.steps.slice(0, 50).map((s) => s.ev), steps: run.steps.length, note: `The same ${toolWord(first.cat)} call ran ${run.steps.length} times in this ${c.agentWord(agent)}, each within ${fmtDur(GAP)} of the last, with no successful edit or other state-changing step by it in between${failures ? `; ${plural(failures, 'run')} recorded an error` : ''}.${c.usage.liveCalls ? ` Estimated cost of the repeats: ${fmt(cost)} tokens.` : ''}` });
      }
      run = null;
    };
    for (const s of steps) {
      if (s.neutral || !s.fp) continue;
      eligible++;
      if (run && run.fp === s.fp && s.t - run.lastT <= GAP) {
        run.steps.push(s);
        run.lastT = s.endT ?? s.t;
      } else {
        close();
        run = { fp: s.fp, steps: [s], lastT: s.endT ?? s.t };
      }
    }
    close();
    // An edit made, exactly reversed, then made again on one file.
    const byFile = new Map();
    for (const s of steps) if (s.cat === 'edit' && s.result === 'ok' && s.edit?.flip) (byFile.get(s.edit.flip.file) ?? byFile.set(s.edit.flip.file, []).get(s.edit.flip.file)).push(s);
    for (const flist of byFile.values()) {
      for (let i = 0; i < flist.length; i++) {
        const A = flist[i].edit.flip;
        const j = flist.findIndex((x, k) => k > i && x.edit.flip.from === A.to && x.edit.flip.to === A.from);
        if (j < 0) continue;
        const k = flist.findIndex((x, n) => n > j && x.edit.flip.from === A.from && x.edit.flip.to === A.to);
        if (k < 0) continue;
        flips++;
        const cost = sumCost([flist[j], flist[k]]);
        out.push({ severity: 'look', verdictEvidence: 'derived', rule: 'problems.same-call; cost.step', session: flist[i].session, event: flist[i].ev, at: iso(flist[i].t), lastAt: iso(flist[k].t), kind: 'edit undone and redone', estimate: cost, events: [flist[i].ev, flist[j].ev, flist[k].ev], steps: 3, note: `An edit to one file was made, undone with the exact reverse edit, and made again by this ${c.agentWord(agent)}.${c.usage.liveCalls ? ` Estimated cost of the undo and redo: ${fmt(cost)} tokens.` : ''}` });
        break;
      }
    }
    // A command that failed and was run again exactly as written, with no edit between.
    let edits = 0;
    const lastFail = new Map();
    const groups = new Map();
    for (const s of list) {
      if (s.result === 'refused') continue;
      if (s.cat === 'edit' && s.result === 'ok') edits++;
      if (s.cat !== 'shell' || !s.fp || !s.result) continue;
      const prev = lastFail.get(s.fp);
      if (prev && prev.edits === edits && c.inWin(s.t)) {
        const g = groups.get(s.fp) ?? groups.set(s.fp, { first: prev.step, retries: [], failures: 1 }).get(s.fp);
        g.retries.push(s);
        if (s.result === 'error') g.failures++;
        g.last = s;
      }
      if (s.result === 'error') lastFail.set(s.fp, { edits, step: s });
      else lastFail.delete(s.fp);
    }
    for (const g of groups.values()) {
      if (g.failures < retryMin) continue;
      // A run of identical calls already listed above covers these steps.
      if (out.some((f) => f.kind === 'same call repeated' && f.events.includes(g.first.ev))) continue;
      retries++;
      const cost = sumCost(g.retries);
      out.push({ severity: 'look', verdictEvidence: 'derived', rule: 'problems.same-call, problems.no-change-between; cost.step', session: g.first.session, event: g.first.ev, at: iso(g.first.t), lastAt: iso(g.last.t), kind: 'failed command run again unchanged', estimate: cost, events: [g.first, ...g.retries].slice(0, 50).map((s) => s.ev), steps: g.retries.length + 1, note: `The same command failed and was run again with no edit by this ${c.agentWord(agent)} in between: ${plural(g.retries.length, 'retry', 'retries')}, ${g.failures} failures in all${g.last?.result === 'ok' ? ', and the last attempt succeeded' : ''}.${c.usage.liveCalls ? ` Estimated cost of the retries: ${fmt(cost)} tokens.` : ''}` });
    }
  }
  out.sort((x, y) => (y.estimate ?? 0) - (x.estimate ?? 0));
  const cost = out.reduce((m, f) => m + (f.estimate ?? 0), 0);
  return {
    findings: out,
    checked: `${plural(eligible, 'tool call')} in the window that could repeat (file reads and status-style commands are left to the re-read and polling checks).`,
    stats: [
      { label: `Runs of ${MIN} or more identical calls with nothing changed between`, value: out.length - flips - retries, unit: 'count', evidence: 'derived' },
      { label: 'Edits undone and redone', value: flips, unit: 'count', evidence: 'derived' },
      { label: 'Failed commands run again unchanged', value: retries, unit: 'count', evidence: 'derived' },
      ...(c.usage.liveCalls ? [{ label: 'Estimated cost of the repeats', value: cost, unit: 'tokens', evidence: 'inferred' }] : []),
    ],
    cost: c.usage.liveCalls ? { tokens: cost, waste: true, label: 'Estimated cost of calls repeated with nothing changed', evidence: 'inferred' } : null,
  };
}

function repeatedToolError(c) {
  const { errorRunMin: MIN, errorGapMs: GAP, editChainMin } = THRESHOLDS;
  const out = [];
  let errors = 0;
  let chains = 0;
  const classes = {};
  for (const [agent, list] of c.stepsByAgent) {
    const steps = list.filter((s) => c.inWin(s.t) && s.result && s.result !== 'refused');
    const open = new Map();
    const close = (k) => {
      const run = open.get(k);
      open.delete(k);
      if (!run || run.steps.length < MIN) return;
      const first = run.steps[0];
      const cost = sumCost(run.steps.slice(1));
      out.push({ severity: 'look', verdictEvidence: 'derived', rule: 'problems.error-signature; cost.step', session: first.session, event: first.ev, at: iso(first.t), lastAt: iso(run.steps.at(-1).t), kind: `${toolWord(first.cat)}: ${first.errClass}`, estimate: cost, events: run.steps.slice(0, 50).map((s) => s.ev), steps: run.steps.length, note: `${first.cat === 'edit' ? 'Edits to one file' : `${toolWord(first.cat).replace(/^./, (m) => m.toUpperCase())} calls`} returned the same error (${first.errClass}) ${run.steps.length} times in a row in this ${c.agentWord(agent)}, with no successful call of that tool in between${run.recovered ? '; the next call of that tool succeeded' : ''}.${c.usage.liveCalls ? ` Estimated cost of the repeats: ${fmt(cost)} tokens.` : ''}` });
    };
    for (const s of steps) {
      const k = s.toolKey;
      if (s.result === 'ok') {
        const run = open.get(k);
        if (run) run.recovered = true;
        close(k);
        continue;
      }
      if (s.result !== 'error') continue;
      errors++;
      if (s.errClass) classes[s.errClass] = (classes[s.errClass] ?? 0) + 1;
      if (!s.errSig) continue;
      const run = open.get(k);
      if (run && run.sig === s.errSig && s.t - run.lastT <= GAP) {
        run.steps.push(s);
        run.lastT = s.endT ?? s.t;
      } else {
        close(k);
        open.set(k, { sig: s.errSig, steps: [s], lastT: s.endT ?? s.t, recovered: false });
      }
    }
    for (const k of [...open.keys()]) close(k);
    // Edits to one file that failed in a row, whatever their errors said.
    const chain = new Map();
    const closeChain = (f) => {
      const cl = chain.get(f);
      chain.delete(f);
      if (!cl || cl.length < editChainMin) return;
      if (out.some((x) => x.events?.includes(cl[0].ev))) return;
      chains++;
      const cost = sumCost(cl.slice(1));
      out.push({ severity: 'look', verdictEvidence: 'derived', rule: 'cost.step', session: cl[0].session, event: cl[0].ev, at: iso(cl[0].t), lastAt: iso(cl.at(-1).t), kind: 'failed edits', estimate: cost, events: cl.slice(0, 50).map((s) => s.ev), steps: cl.length, note: `${cl.length} edits to the same file failed in a row in this ${c.agentWord(agent)}.${c.usage.liveCalls ? ` Estimated cost after the first: ${fmt(cost)} tokens.` : ''}` });
    };
    for (const s of steps) {
      if (s.cat !== 'edit' || !s.edit?.key) continue;
      if (s.result === 'error') chain.set(s.edit.key, [...(chain.get(s.edit.key) ?? []), s]);
      else if (s.result === 'ok') closeChain(s.edit.key);
    }
    for (const f of [...chain.keys()]) closeChain(f);
  }
  out.sort((x, y) => (y.steps ?? 0) - (x.steps ?? 0) || (y.estimate ?? 0) - (x.estimate ?? 0));
  const cost = out.reduce((m, f) => m + (f.estimate ?? 0), 0);
  return {
    findings: out,
    checked: `${plural(errors, 'tool call')} in the window recorded an error (${Object.entries(classes).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(', ') || 'none with readable text'}). Steps a person rejected or a rule refused aren't counted.`,
    stats: [
      { label: `Runs of ${MIN} or more identical errors from one tool`, value: out.length - chains, unit: 'count', evidence: 'derived' },
      { label: 'Runs of failed edits to one file', value: chains, unit: 'count', evidence: 'derived' },
      ...(c.usage.liveCalls ? [{ label: 'Estimated cost of the repeats', value: cost, unit: 'tokens', evidence: 'inferred' }] : []),
    ],
    cost: c.usage.liveCalls ? { tokens: cost, waste: true, label: 'Estimated cost of tool calls that repeated the same error', evidence: 'inferred' } : null,
  };
}

function subagentOveruse(c) {
  const SMALL = THRESHOLDS.smallSubagentCalls;
  const out = [];
  const bySession = new Map();
  let subs = 0;
  let small = 0;
  let smallTokens = 0;
  for (const a of c.h.agents) {
    if (!c.configured.has(a.session) || (a.kind !== 'subagent' && a.kind !== 'child-thread')) continue;
    const steps = (c.stepsByAgent.get(a.key) ?? []).filter((s) => c.inWin(s.t));
    const firstT = (c.eventsByAgent.get(a.key) ?? []).find((e) => c.inWin(e.t))?.t;
    if (!Number.isFinite(firstT)) continue;
    subs++;
    if (steps.length > SMALL) continue;
    small++;
    const tokens = (c.usage.agents.get(a.key)?.liveCalls ?? []).reduce((m, x) => m + x.total, 0);
    smallTokens += tokens;
    const g = bySession.get(a.session) ?? bySession.set(a.session, { agents: [], tokens: 0 }).get(a.session);
    g.agents.push({ key: a.key, spawnedBy: a.spawnedBy ?? null, tools: steps.length, tokens, t: firstT });
    g.tokens += tokens;
  }
  for (const [session, g] of bySession) {
    g.agents.sort((x, y) => x.t - y.t);
    const first = g.agents[0];
    const evs = g.agents.map((x) => x.spawnedBy).filter((x) => x && c.byId.has(x));
    out.push({ severity: g.agents.length >= 3 ? 'look' : 'note', verdictEvidence: 'derived', rule: `problems.small-subagent${c.usage.liveCalls ? '; usage.call' : ''}`, session, event: evs[0] ?? null, at: iso(first.t), lastAt: iso(g.agents.at(-1).t), kind: 'small sub-agents', estimate: g.tokens, events: evs.slice(0, 50), steps: g.agents.length, note: `${plural(g.agents.length, 'sub-agent')} in this session made ${SMALL} or fewer tool calls each (${g.agents.map((x) => x.tools).join(', ')})${c.usage.liveCalls ? `, and used ${fmt(g.tokens)} tokens between them` : ''}. Each one starts a fresh context, so a handful of calls in the parent may have cost less; the logs can't say what the parent would have spent.` });
  }
  // Near-identical briefs started in the same turn.
  let groups = 0;
  for (const s of c.sessions) {
    for (const turn of c.turnsOf(s.key)) {
      if (!c.inWin(turn.prompt.t)) continue;
      const starts = turn.steps.filter((x) => x.cat === 'delegate' && x.brief?.size && x.result !== 'refused');
      if (starts.length < 2) continue;
      const used = new Set();
      for (let i = 0; i < starts.length; i++) {
        if (used.has(i)) continue;
        const grp = [starts[i]];
        for (let j = i + 1; j < starts.length; j++) {
          if (!used.has(j) && similarity(starts[i].brief, starts[j].brief) >= THRESHOLDS.briefSimilarity) {
            grp.push(starts[j]);
            used.add(j);
          }
        }
        if (grp.length < 2) continue;
        groups++;
        out.push({ severity: 'look', verdictEvidence: 'inferred', rule: 'problems.near-identical-brief', session: s.key, event: grp[0].ev, at: iso(grp[0].t), lastAt: iso(grp.at(-1).t), kind: 'near-identical briefs', estimate: 0, events: grp.map((x) => x.ev), steps: grp.length, note: `${grp.length} sub-agents started in one turn with near-identical briefs (most of their words shared). They may have done the same work twice; a reviewer team split by focus can look like this too.` });
      }
    }
  }
  out.sort((x, y) => (y.estimate ?? 0) - (x.estimate ?? 0));
  return {
    findings: out,
    checked: `${plural(subs, 'sub-agent')} with records in the window (Claude Code sub-agents and Codex child threads).`,
    stats: [
      { label: `Sub-agents with ${SMALL} or fewer tool calls`, value: small, unit: 'count', evidence: 'derived' },
      ...(c.usage.liveCalls ? [{ label: 'Tokens those small sub-agents used', value: smallTokens, unit: 'tokens', evidence: 'recorded' }] : []),
      { label: 'Groups of sub-agents started in one turn with near-identical briefs', value: groups, unit: 'count', evidence: 'inferred' },
    ],
    cost: c.usage.liveCalls ? { tokens: smallTokens, waste: false, label: `Tokens used by sub-agents that made ${SMALL} or fewer tool calls (spending: doing the work in the parent would have cost something too)`, evidence: 'recorded' } : null,
  };
}

function subagentNoReport(c) {
  const out = [];
  let n = 0;
  for (const a of c.h.agents) {
    if (a.kind !== 'subagent' || !a.spawnedBy || !c.configured.has(a.session)) continue;
    const call = c.byId.get(a.spawnedBy);
    if (!call || !c.inWin(call.t)) continue;
    n++;
    const background = a.requestShape === 'background';
    const missing = background ? !a.completion : !call.end;
    if (!missing) continue;
    // lastTurn: a sub-agent in a session that may still be running may still hand back, so
    // runChecks downgrades it to a note the same way as a live session's last turn.
    out.push({ severity: 'look', verdictEvidence: 'missing', rule: background ? 'No completion notice for this agent in the logs read.' : 'No recorded result on the call that started it.', session: a.session, event: a.spawnedBy, at: iso(call.t), lastTurn: true, note: background ? 'A background sub-agent was started; no completion notice for it is in the logs read.' : 'A foreground sub-agent was started, and the call that started it has no recorded result.' });
  }
  return { findings: out, checked: `${plural(n, 'Claude Code sub-agent')} with a recorded starting call in the window. Codex child threads aren't checked: Codex records no completion this page reads.`, stats: [{ label: 'Sub-agents with no recorded hand-back', value: out.length, unit: 'count', evidence: 'missing' }] };
}

function longSessions(c) {
  const { longCtx: T, longAfterCalls: MIN, freshBrief: BRIEF } = THRESHOLDS;
  const out = [];
  let crossed = 0;
  let agents = 0;
  for (const a of c.usage.agents.values()) {
    const cs = a.liveCalls;
    if (!cs.length) continue;
    agents++;
    const cross = cs.findIndex((x) => x.ctx >= T);
    if (cross < 0) continue;
    crossed++;
    const after = cs.slice(cross + 1);
    if (after.length < MIN) continue;
    const base = median(cs.slice(0, Math.min(5, cs.length)).map((x) => x.ctx));
    const fresh = base + BRIEF;
    const X = cs[cross].ctx;
    const saved = after.reduce((m, x) => m + Math.max(0, Math.min(x.ctx, X) - fresh), 0);
    const actual = after.reduce((m, x) => m + x.ctx, 0);
    const maxCtx = Math.max(...cs.map((x) => x.ctx));
    const near = (c.eventsByAgent.get(a.key) ?? []).filter((e) => e.t <= cs[cross].t).at(-1) ?? (c.eventsByAgent.get(a.key) ?? [])[0];
    const last = (c.eventsByAgent.get(a.key) ?? []).at(-1);
    out.push({ severity: 'look', verdictEvidence: 'derived', rule: 'usage.call; the hand-off saving is an estimate', session: a.session, event: near?.id ?? null, at: iso(cs[cross].t), lastAt: iso(Math.max(last?.t ?? 0, cs.at(-1).t)), kind: 'context past the threshold', stepsNear: true, estimate: saved, note: `This ${c.agentWord(a.key)} passed ${fmt(T)} tokens of context at model call ${cross + 1} of ${cs.length} (${fmt(X)}), then made ${plural(after.length, 'more call')}, which read ${fmt(actual)} tokens of context in all. Its largest context was ${fmt(maxCtx)}${a.compactions?.length ? `; ${plural(a.compactions.length, 'compaction')} recorded` : '; no compaction recorded'}. A fresh session starting near ${fmt(fresh)} (this agent's early context plus about ${fmt(BRIEF)} for a hand-off brief) would not have re-read about ${fmt(saved)} tokens.` });
  }
  out.sort((x, y) => y.estimate - x.estimate);
  const est = out.reduce((m, f) => m + f.estimate, 0);
  return {
    findings: out,
    checked: `${plural(agents, 'agent')} with token counts in the window; ${crossed} passed ${fmt(T)} tokens of context.`,
    stats: [
      { label: `Agents past ${fmt(T)} tokens with ${MIN} or more calls after`, value: out.length, unit: 'count', evidence: 'derived' },
      { label: 'Estimated context a hand-off at the threshold would not have re-read', value: est, unit: 'tokens', evidence: 'inferred' },
    ],
    cost: { tokens: est, waste: true, label: `Estimated context a hand-off at ${fmt(T)} tokens would not have re-read`, evidence: 'inferred' },
  };
}

function reReads(c) {
  const MIN = THRESHOLDS.rereadMin;
  const out = [];
  let reads = 0;
  for (const [agent, list] of c.stepsByAgent) {
    const ver = new Map();
    const groups = new Map();
    const marks = (c.eventsByAgent.get(agent) ?? []).filter((e) => e.kind === 'external-edit' && e.facts?.fileKey);
    let mi = 0;
    for (const s of list) {
      while (mi < marks.length && marks[mi].t <= s.t) {
        ver.set(marks[mi].facts.fileKey, (ver.get(marks[mi].facts.fileKey) ?? 0) + 1);
        mi++;
      }
      if (s.result === 'refused') continue;
      if (s.cat === 'edit' && s.result === 'ok') for (const f of s.edit?.keys ?? []) ver.set(f, (ver.get(f) ?? 0) + 1);
      if (!s.readFp || s.result === 'error' || !c.inWin(s.t)) continue;
      reads++;
      const key = `${s.readFp}|${ver.get(s.readFile) ?? 0}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push(s);
    }
    for (const g of groups.values()) {
      if (g.length < MIN) continue;
      const extra = g.slice(1);
      const measured = c.usage.liveCalls > 0 && extra.every((s) => s.consumedBy != null);
      const small = measured ? extra.filter((s) => s.cost.added < THRESHOLDS.rereadSmall).length : 0;
      const cost = sumCost(extra);
      out.push({ severity: measured && small === extra.length ? 'note' : 'look', verdictEvidence: 'derived', rule: c.usage.liveCalls ? 'cost.step' : 'problems.same-call', session: g[0].session, event: g[0].ev, at: iso(g[0].t), lastAt: iso(g.at(-1).t), kind: 'file read again', estimate: cost, events: g.slice(0, 50).map((s) => s.ev), steps: g.length, note: `The same file and range was read ${g.length} times by this ${c.agentWord(agent)}, with no edit to that file recorded in between.${small ? ` ${small} of the ${extra.length} repeats added under ${THRESHOLDS.rereadSmall} tokens (a short file, or the harness's note that it hadn't changed).` : ''}${c.usage.liveCalls ? ` Estimated cost of the repeats: ${fmt(cost)} tokens.` : ''}` });
    }
  }
  out.sort((x, y) => (y.estimate ?? 0) - (x.estimate ?? 0));
  const cost = out.reduce((m, f) => m + (f.estimate ?? 0), 0);
  return {
    findings: out,
    checked: `${plural(reads, 'file read')} (the read tools: Read, NotebookRead, view_image and any read tool given a path) in the window. A read starts over when the agent edits the file or the harness records it changed.`,
    stats: [{ label: `Files or ranges read ${MIN} or more times with no change between`, value: out.length, unit: 'count', evidence: 'derived' }, ...(c.usage.liveCalls ? [{ label: 'Estimated cost of the repeats', value: cost, unit: 'tokens', evidence: 'inferred' }] : [])],
    cost: c.usage.liveCalls ? { tokens: cost, waste: true, label: `Estimated cost of the repeats in files read ${MIN} or more times`, evidence: 'inferred' } : null,
  };
}

function polling(c) {
  const { pollMin: MIN, pollGapMs: GAP } = THRESHOLDS;
  const out = [];
  let status = 0;
  const byClass = {};
  for (const [agent, list] of c.stepsByAgent) {
    const open = new Map();
    let epoch = 0;
    const finish = (cl) => {
      if (cl.steps.length < MIN) return;
      const first = cl.steps[0];
      const last = cl.steps.at(-1);
      const cost = sumCost(cl.steps.slice(1));
      out.push({ severity: 'look', verdictEvidence: 'inferred', rule: 'problems.status-command, problems.state-change; cost.step', session: first.session, event: first.ev, at: iso(first.t), lastAt: iso(last.endT ?? last.t), kind: first.status, estimate: cost, events: cl.steps.slice(0, 50).map((s) => s.ev), steps: cl.steps.length, note: `The same ${first.status} call ran ${cl.steps.length} times over ${fmtDur((last.endT ?? last.t) - first.t)}, each within ${fmtDur(GAP)} of the last, with no edit, push or commit by this ${c.agentWord(agent)} in between${cl.other ? ` (${plural(cl.other, 'other step')} mixed in)` : ' and nothing else in between'}.${c.usage.liveCalls ? ` Estimated cost of all but the first: ${fmt(cost)} tokens.` : ''}` });
    };
    for (const s of list) {
      if (s.result === 'refused') continue;
      if ((s.cat === 'edit' && s.result === 'ok') || s.stateChange) epoch++;
      if (!s.status || !s.pollFp || !c.inWin(s.t)) {
        for (const cl of open.values()) cl.pending++;
        continue;
      }
      status++;
      byClass[s.status] = (byClass[s.status] ?? 0) + 1;
      const cl = open.get(s.pollFp);
      if (cl && cl.epoch === epoch && s.t - cl.lastT <= GAP) {
        cl.steps.push(s);
        cl.other += cl.pending;
        cl.pending = 0;
        cl.lastT = s.endT ?? s.t;
      } else {
        if (cl) finish(cl);
        open.set(s.pollFp, { steps: [s], epoch, lastT: s.endT ?? s.t, other: 0, pending: 0 });
      }
      for (const [k, other] of open) if (k !== s.pollFp) other.pending++;
    }
    for (const cl of open.values()) finish(cl);
  }
  out.sort((x, y) => (y.estimate ?? 0) - (x.estimate ?? 0));
  const cost = out.reduce((m, f) => m + (f.estimate ?? 0), 0);
  return {
    findings: out,
    checked: `${plural(status, 'status-style call')} in the window (${Object.entries(byClass).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}).`,
    stats: [{ label: `The same status call ${MIN} or more times, each within ${fmtDur(GAP)}, nothing changed between`, value: out.length, unit: 'count', evidence: 'inferred' }, ...(c.usage.liveCalls ? [{ label: 'Estimated cost of the repeated status calls', value: cost, unit: 'tokens', evidence: 'inferred' }] : [])],
    cost: c.usage.liveCalls ? { tokens: cost, waste: true, label: 'Estimated cost of the repeated status calls', evidence: 'inferred' } : null,
  };
}

function contextAdditions(c) {
  const BIG = THRESHOLDS.bigAdd;
  const big = [];
  let measured = 0;
  for (const list of c.stepsByAgent.values()) {
    for (const s of list) {
      if (!c.inWin(s.t) || !s.cost || s.consumedBy == null) continue;
      measured++;
      if (s.cost.added >= BIG) big.push(s);
    }
  }
  big.sort((x, y) => y.cost.carry - x.cost.carry);
  // The growth comes from recorded token counts, but charging it to one result (shared evenly
  // among the results that call read) is the cost.step rule's reading: inferred.
  const out = big.map((s) => ({ severity: 'look', verdictEvidence: 'inferred', rule: 'cost.step', session: s.session, event: s.ev, at: iso(s.t), kind: s.cat === 'read' ? (s.readWhole ? 'whole-file read' : 'file read') : `${toolWord(s.cat)} result`, estimate: s.cost.carry, note: `One ${s.cat === 'read' && s.readWhole ? 'whole-file read' : `${toolWord(s.cat)} result`} grew this ${c.agentWord(s.agent)}'s context by about ${fmt(s.cost.added)} tokens, which were then re-read by ${plural(s.cost.later, 'later call')} before ${s.cost.compactedAfter ? 'a compaction' : "the agent's last call"}: about ${fmt(s.cost.carry)} tokens.` }));
  const carry = big.reduce((m, s) => m + s.cost.carry, 0);
  return {
    findings: out,
    checked: `${plural(measured, 'tool call')} in the window with a result a later model call read; ${big.length} grew the context by ${fmt(BIG)} tokens or more.`,
    stats: [{ label: `Steps that added ${fmt(BIG)} or more tokens`, value: big.length, unit: 'count', evidence: 'inferred' }, { label: 'Their carried cost', value: carry, unit: 'tokens', evidence: 'inferred' }],
    cost: { tokens: carry, waste: true, label: `Estimated carried cost of single results that added ${fmt(BIG)} tokens or more (an upper bound: some of it had to be read)`, evidence: 'inferred' },
  };
}

// ---------------------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------------------

function scopeCreep(c) {
  const out = [];
  let questions = 0;
  let approved = 0;
  for (const s of c.sessions) {
    for (const turn of c.turnsOf(s.key)) {
      if (!c.inWin(turn.prompt.t) || !isPersonPrompt(turn.prompt)) continue;
      const text = rawText(turn.prompt);
      if (text == null || !classifyPrompt(text).pureQuestion) continue;
      questions++;
      const edits = turn.steps.filter((x) => x.cat === 'edit' && x.result === 'ok' && x.edit?.inRepo);
      if (!edits.length) continue;
      const goAhead = turn.events.find((e) => e.kind === 'decision' && (e.facts?.decision === 'approved-plan' || e.facts?.decision === 'answered-question'));
      if (goAhead && goAhead.t < edits[0].t) {
        approved++;
        continue;
      }
      const files = new Set(edits.map((x) => x.edit.key)).size;
      out.push({ severity: 'look', verdictEvidence: 'inferred', rule: 'problems.question-only-prompt, problems.in-repo-edit', session: s.key, event: edits[0].ev, related: turn.prompt.id, relatedLabel: 'Replay at the question', at: iso(edits[0].t), lastAt: iso(edits.at(-1).t), events: edits.slice(0, 50).map((x) => x.ev), steps: edits.length, note: `The prompt for this turn reads as a question only, and the turn then made ${plural(edits.length, 'successful edit')} to ${plural(files, 'file')} in the session's own folder, with no answered question or approved plan before them. You may have meant it as a request; the words alone can't say.` });
    }
  }
  return { findings: out, checked: `${plural(questions, 'prompt')} in the window read as a question only (a conservative rule); ${approved} of those had an answered question or approved plan before any edit.`, stats: [{ label: 'Question-only prompts followed by edits in the session folder', value: out.length, unit: 'count', evidence: 'inferred' }] };
}

function planModeEdit(c) {
  const out = [];
  let edits = 0;
  for (const s of c.sessions) {
    if (s.tool !== 'claude-code') continue;
    const main = `${s.key}:main`;
    let plan = false;
    const hits = [];
    for (const e of c.eventsBySession.get(s.key) ?? []) {
      if (e.kind === 'mode') {
        const ch = e.facts?.change;
        if (ch === 'plan_mode' || ch === 'plan_mode_reentry') plan = true;
        else if (ch === 'plan_mode_exit') plan = false;
        else if (ch === 'permission-mode' || ch === 'mode') plan = e.facts?.value === 'plan';
        continue;
      }
      if (e.kind === 'decision' && e.facts?.decision === 'approved-plan') plan = false;
      const st = c.steps.get(e.id);
      if (!st || e.agent !== main || st.cat !== 'edit' || st.result !== 'ok') continue;
      if (!c.inWin(e.t)) continue;
      edits++;
      if (!plan || st.edit?.planFile) continue;
      if (!st.edit) continue; // with no raw path, whether it's the plan file isn't known
      hits.push(st);
    }
    if (!hits.length) continue;
    out.push({ severity: 'look', verdictEvidence: 'derived', rule: 'problems.plan-mode', session: s.key, event: hits[0].ev, at: iso(hits[0].t), lastAt: iso(hits.at(-1).t), kind: 'edit in plan mode', events: hits.slice(0, 50).map((x) => x.ev), steps: hits.length, note: `${plural(hits.length, 'edit')} to a file other than the plan ran while the recorded mode was plan, where only the plan is written until you approve it.` });
  }
  return { findings: out, checked: `${plural(edits, 'successful edit')} by Claude Code main agents in the window, against the plan mode their sessions recorded. Codex records no plan mode.`, stats: [{ label: 'Sessions with an edit in plan mode', value: out.length, unit: 'count', evidence: 'derived' }] };
}

function sessionEndedMidStep(c) {
  const SEVERE = new Set(['last-record-is-an-interruption', 'last-record-is-error', 'last-record-is-a-call-without-result']);
  const WORDS = { 'last-record-is-an-interruption': 'an interruption', 'last-record-is-error': 'an error', 'last-record-is-a-call-without-result': 'a tool call with no recorded result', 'last-record-is-an-unanswered-prompt': 'a prompt with no reply after it', 'last-record-is-action': 'a step with a result, and no turn end after it', 'last-record-is-message': 'an agent message, and no turn end after it' };
  const out = [];
  let n = 0;
  for (const s of c.sessions) {
    const t = Date.parse(s.lastAt ?? '');
    if (!c.inWin(t)) continue;
    n++;
    if (s.endState === 'last-turn-ended' || s.endState === 'no-work-records') continue;
    const list = (c.eventsBySession.get(s.key) ?? []).filter((e) => !['link', 'mode', 'quiet', 'queue', 'hook', 'outcome'].includes(e.kind));
    const last = list.at(-1) ?? null;
    // The end state is the engine's (derived), but reading it as a stop the agent made early is a
    // proxy: an interruption is often the person stopping the agent. So the finding is inferred.
    out.push({ severity: SEVERE.has(s.endState) ? 'look' : 'note', verdictEvidence: 'inferred', rule: `The engine's end state: ${s.endState}.`, session: s.key, event: last?.id ?? null, at: iso(last?.t ?? t), lastTurn: true, kind: s.endState, note: `The session's last work record is ${WORDS[s.endState] ?? String(s.endState).replace(/^last-record-is-/, '').replace(/-/g, ' ')}. The logs never say a session ended; this is only what its last record is.` });
  }
  return { findings: out, checked: `${plural(n, 'session')} whose last record falls in the window.`, stats: [{ label: 'Sessions whose last record is an interruption, an error or a waiting call', value: out.filter((f) => f.severity === 'look').length, unit: 'count', evidence: 'derived' }] };
}

function needlessCheckIn(c) {
  const out = [];
  let asked = 0;
  let prompts = 0;
  for (const s of c.sessions) {
    const main = `${s.key}:main`;
    const evs = (c.eventsBySession.get(s.key) ?? []).filter((e) => (e.agent === main || isPersonPrompt(e)) && !['link', 'mode', 'quiet', 'queue', 'hook', 'outcome'].includes(e.kind));
    let n = 0;
    for (let i = 0; i < evs.length; i++) {
      const p = evs[i];
      if (!isPersonPrompt(p)) continue;
      n++;
      if (n === 1 || !c.inWin(p.t)) continue;
      prompts++;
      let lastMsg = null;
      let actionAfter = false;
      let prev = null;
      for (let j = i - 1; j >= 0; j--) {
        const e = evs[j];
        if (isPersonPrompt(e)) break;
        prev ??= e;
        if (e.kind === 'message') {
          lastMsg = e;
          break;
        }
        if (e.kind === 'action') actionAfter = true;
      }
      const text = rawText(lastMsg);
      if (!lastMsg || actionAfter || text == null || !endsWithQuestion(text)) continue;
      asked++;
      const goAhead = (p.inferred ?? []).some((x) => x.rule === 'prompt.approval');
      if (!goAhead) continue;
      const gap = p.t - (prev?.t ?? lastMsg.t);
      out.push({ severity: gap >= THRESHOLDS.waitLookMs ? 'look' : 'note', verdictEvidence: 'inferred', rule: 'problems.ends-in-question, prompt.approval', session: s.key, event: lastMsg.id, related: p.id, relatedLabel: 'Replay at your go-ahead', at: iso(lastMsg.t), note: `This turn ended on a question, and the next prompt, ${fmtDur(gap)} later, was a bare go-ahead. A question isn't always needless, and a gap isn't proof you were being waited on.` });
    }
  }
  return { findings: out, checked: `${plural(prompts, 'prompt')} after the first in each session, in the window; ${asked} followed a turn that ended on a question.`, stats: [{ label: 'Turns that ended on a question answered by a bare go-ahead', value: out.length, unit: 'count', evidence: 'inferred' }, { label: `Of those, with a gap of ${fmtDur(THRESHOLDS.waitLookMs)} or more`, value: out.filter((f) => f.severity === 'look').length, unit: 'count', evidence: 'inferred' }] };
}

// ---------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------

function riskyCommand(c) {
  const out = [];
  let n = 0;
  for (const s of c.steps.values()) {
    if (s.cat !== 'shell' || !s.cmd || DID_NOT_RUN.has(s.result) || !c.inWin(s.t)) continue;
    n++;
    const e = c.byId.get(s.ev);
    const kinds = riskyKinds(s.cmd, (e?.inferred ?? []).some((x) => x.rule === 'shell.revert'));
    if (!kinds.length) continue;
    out.push({ severity: kinds.some((k) => k.look) ? 'look' : 'note', verdictEvidence: 'inferred', rule: `problems.risky-command${kinds.some((k) => k.kind === 'revert' || k.kind === 'hard-reset') ? ', shell.revert' : ''}`, session: s.session, event: s.ev, at: iso(s.t), kind: kinds.map((k) => k.kind).join(' '), patterns: [...new Set(kinds.map((k) => k.pattern))], note: `A command that reads as ${kinds.map((k) => k.words).join(' and ')} ran${s.result === 'ok' ? ' and recorded success' : s.result === 'error' ? ' and recorded an error' : ''}.` });
  }
  return { findings: out, checked: `${plural(n, 'shell command')} that ran in the window.`, stats: [{ label: 'Commands that force-push, skip hooks, hard-reset, clean or delete recursively', value: out.length, unit: 'count', evidence: 'inferred' }] };
}

function secretInLog(c) {
  const groups = new Map();
  let strings = 0;
  const add = (session, where, e, kinds) => {
    const n = Object.values(kinds).reduce((a, b) => a + b, 0);
    if (!n) return;
    const k = `${session}|${where}`;
    const g = groups.get(k) ?? groups.set(k, { session, where, n: 0, kinds: {}, events: [] }).get(k);
    g.n += n;
    for (const [kind, m] of Object.entries(kinds)) g.kinds[kind] = (g.kinds[kind] ?? 0) + m;
    if (!g.events.includes(e)) g.events.push(e);
  };
  for (const e of c.events) {
    if (!c.inWin(e.t) || !e._raw) continue;
    if (isPersonPrompt(e) && typeof e._raw.text === 'string') {
      strings++;
      add(e.session, 'your prompt', e, secretShapes(e._raw.text));
    } else if (isExecInstruction(e) && typeof e._raw.text === 'string') {
      strings++;
      add(e.session, 'codex exec instruction', e, secretShapes(e._raw.text));
    } else if (e.kind === 'action' && e._raw.input) {
      strings++;
      add(e.session, 'tool-call input', e, secretShapes(e._raw.input));
    } else if (e.kind === 'message' && typeof e._raw.text === 'string') {
      strings++;
      add(e.session, 'agent message', e, secretShapes(e._raw.text));
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const evs = g.events.sort((a, b) => a.t - b.t);
    const kinds = Object.entries(g.kinds).sort((a, b) => b[1] - a[1]).map(([k, m]) => `${m} ${SECRET_KIND_WORDS[k]?.[m === 1 ? 0 : 1] ?? k}`).join(', ');
    const place = g.where === 'your prompt' ? 'your prompts' : `${g.where}s`;
    out.push({ severity: g.where === 'agent message' ? 'note' : 'look', verdictEvidence: 'inferred', rule: 'problems.secret-shape', session: g.session, event: evs[0].id, at: iso(evs[0].t), lastAt: iso(evs.at(-1).t), kind: g.where, events: evs.slice(0, 50).map((e) => e.id), steps: evs.length, note: `In ${place}, on ${plural(evs.length, 'step')}: ${kinds}. The values aren't kept here. A test fixture or an example value reads the same as a real secret.` });
  }
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'look' ? -1 : 1) || b.steps - a.steps);
  return { findings: out, checked: `${plural(strings, 'prompt, tool-call input and agent message', 'prompts, tool-call inputs and agent messages')} in the window, read in memory for secret shapes. Tool results aren't read.`, stats: [{ label: 'Sessions and places with secret-shaped text', value: out.length, unit: 'count', evidence: 'inferred' }] };
}

// ---------------------------------------------------------------------------------------

/**
 * Every check: its id, title, how it works, the weakest level its findings carry, what it
 * needs ('raw': the engine's keepRaw; 'usage': token counts), and whether a finding in the last
 * turn of a session that may still be running drops to a note.
 */
export const CHECKS = Object.freeze([
  { id: 'unverified-done-claim', title: 'Edits, a completion claim, and no check after the last edit', evidence: 'inferred', needs: ['raw'], liveSensitive: true, how: "Per turn (a prompt you typed to the next one, every agent's steps included): successful edits to code or test files (problems.runnable-file); whether any check step (problems.check-step) or sub-agent start came after the last edit; and whether the main agent's last message reads as a completion claim (problems.completion-claim). Flat claims are worth a look; hedged ones are notes. Turns whose last message says plainly what wasn't run (problems.admits-no-check) aren't flagged. A check run in a later turn, by a hook, or outside the logs isn't seen.", run: unverifiedDoneClaim },
  { id: 'pr-landed-without-tests', title: 'A landed pull request with no test run in its sessions', evidence: 'inferred', needs: [], how: "Pull requests the engine matched to a default-branch commit (its git.pr-number-from-subject rule). Every session in this window that points at the pull request, by the engine's own lookup, in the same repository, is checked for any test run (the shell.test rule), whatever it printed. CI and runs in sessions before this window aren't visible here.", run: prLandedWithoutTests },
  { id: 'claim-contradicts-evidence', title: 'A success claim after a check that failed', evidence: 'inferred', needs: ['raw'], liveSensitive: true, how: "Per turn: the last test run with a passed or failed summary (the engine's shell.test rule), or build, lint or type-check command with a recorded result, before the turn's last message. When it failed, the last message is read for a completion or tests-pass claim, or for calling the failure pre-existing or unrelated with no run on another checkout recorded in the turn. A test written to fail first, or a failure that really is pre-existing, reads the same.", run: claimContradictsEvidence },
  { id: 'commit-after-failed-test', title: 'A commit or merge right after a failed test run', evidence: 'inferred', needs: [], how: "Per agent: the most recent test run with a passed or failed summary before each commit or merge step (problems.commit-step). A finding when that run failed and no run passed in between. The run and the commit can be in different folders or branches: each command line is read on its own.", run: commitAfterFailedTest },
  { id: 'test-tampering', title: 'Tests weakened, skipped or excluded', evidence: 'inferred', needs: ['raw'], how: 'Per turn: the old and new text of every edit to a test file or test configuration (problems.test-file, problems.test-weakening), netted across the turn, and test commands that gained an exclusion (problems.test-exclusion). Reports what changed, never why. Notes rather than worth a look when the prompt mentions tests, since the change may have been asked for.', run: testTampering },
  { id: 'action-loop', title: 'The same call repeated with nothing changed', evidence: 'derived', needs: ['raw'], how: 'Per agent: runs of 3 or more identical tool calls (problems.same-call), each within 10 minutes of the last, with nothing changed in between (problems.no-change-between); an edit made, exactly reversed, and made again on one file; and a command that failed and was run again exactly as written, with no edit between, failing twice or more.', run: actionLoop },
  { id: 'repeated-tool-error', title: 'The same tool error, again and again', evidence: 'derived', needs: ['raw'], how: 'Per agent and tool: 2 or more errors in a row with the same signature (problems.error-signature), each within 10 minutes, with no successful call of that tool between; and edits to one file that failed in a row, whatever their errors said. The input may change between tries; the error stays the same.', run: repeatedToolError },
  { id: 'subagent-overuse', title: 'Small or duplicated sub-agents', evidence: 'derived', needs: [], how: "Sub-agents and Codex child threads that made 3 or fewer tool calls in the window (problems.small-subagent), grouped by session with the tokens their own model calls used when token counts are recorded; and sub-agents started in the same turn with near-identical briefs (problems.near-identical-brief). Whether the parent could have done the work for less is a judgment the logs can't make.", run: subagentOveruse },
  { id: 'subagent-no-report', title: 'A sub-agent with no recorded hand-back', evidence: 'missing', needs: [], liveSensitive: true, how: "Claude Code sub-agents with a recorded starting call. A background sub-agent needs a completion notice; a foreground one needs a recorded result on the call that started it. A finding when neither is in the logs read. Codex child threads aren't checked, because Codex doesn't record a completion the engine reads.", run: subagentNoReport },
  { id: 'long-sessions', title: 'Agents that kept going past 150k tokens of context', evidence: 'derived', needs: ['usage'], how: "Per agent: the context each model call read, in order (usage.call). When it passed 150k tokens and 30 or more calls followed, the page works out what those later calls would have carried after a hand-off to a fresh session at that point. The fresh start is this agent's own early context plus a brief. Compactions are the harness's own records.", run: longSessions },
  { id: 're-reads', title: 'Files read again with no change between', evidence: 'derived', needs: ['raw'], how: 'Per agent: reads of the same file and range (the read tools: Read, NotebookRead, view_image and any read tool given a path) 3 or more times, with no edit to that file by that agent in between and no harness note that it changed. Another agent or a person could still have changed it; a re-read after that is legitimate. With token counts, a repeat that added under 500 tokens is routine.', run: reReads },
  { id: 'polling', title: 'Status checks repeated while nothing changed', evidence: 'inferred', needs: ['raw'], how: "Per agent: status-style calls (problems.status-command). A finding when the same call runs 3 or more times, each within 10 minutes of the last, with no successful edit and no push, commit or other state change (problems.state-change) by that agent in between. A poll that had to wait for a slow job is still a poll; whether a detached watcher would have served is a judgment the logs can't make.", run: polling },
  { id: 'context-additions', title: 'Single steps that grew the context most', evidence: 'inferred', needs: ['usage'], how: 'For every tool call, how much the context grew between the call that asked for it and the call that read its result, and how many later calls re-read it before a compaction (cost.step). Listed when one step added 20k tokens or more, largest carried cost first.', run: contextAdditions },
  { id: 'scope-creep', title: 'Edits after a question-only prompt', evidence: 'inferred', needs: ['raw'], how: "Per turn: a prompt that reads as a question only (problems.question-only-prompt, a conservative rule), followed in the same turn by successful edits under the session's own folder (problems.in-repo-edit), with no answered question or approved plan before them. The other signals the catalog names (files the prompt didn't name, out-of-proportion diffs) need judgment this page doesn't make.", run: scopeCreep },
  { id: 'plan-mode-edit', title: 'An edit while plan mode was on', evidence: 'derived', needs: ['raw'], how: "Claude Code main agents: successful edits to a file other than the plan while the recorded mode was plan (problems.plan-mode). One finding per session. A rule you overrode for a task reads the same as one broken.", run: planModeEdit },
  { id: 'session-ended-mid-step', title: 'A session whose last record is an interruption, an error or a waiting call', evidence: 'inferred', needs: [], liveSensitive: true, how: "The engine's end state for each session: what its last work record is (links, mode changes, queued messages, hooks and git outcomes aren't work records). The logs never say a session ended; this is only what the last record is. An interruption, an error or a call with no result is worth a look; any other ending without a turn end is a note.", run: sessionEndedMidStep },
  { id: 'needless-check-in', title: 'A turn that ended on a question answered with a bare go-ahead', evidence: 'inferred', needs: ['raw'], how: "Per session's main agent: a turn whose last message ends on a question (problems.ends-in-question), answered by a prompt the engine's prompt.approval rule reads as a bare go-ahead. Worth a look when 30 minutes or more passed before the go-ahead; a note otherwise.", run: needlessCheckIn },
  { id: 'risky-command', title: 'Force-pushes, skipped hooks, hard resets and recursive deletes', evidence: 'inferred', needs: [], how: "Shell commands that ran (not rejected, refused or interrupted), matched by problems.risky-command. A command a shell wrapper runs (bash -c, eval) counts as itself. Force-pushes, skipped hooks, hard resets and git clean are worth a look; a push with --force-with-lease, other reverts, recursive deletes and deleted branches are notes.", run: riskyCommand },
  { id: 'secret-in-log', title: 'Secret-shaped text in prompts or tool inputs', evidence: 'inferred', needs: ['raw'], how: "Your prompts, tool-call inputs and agent messages, read in memory for secret shapes (problems.secret-shape). Only counts are kept, never the text. A match in your prompt or a tool-call input is worth a look, since that text was written into the session; one in an agent message is a note.", run: secretInLog },
]);

/**
 * runChecks(c, defs = CHECKS) -> [{ id, title, how, evidence, ran, notRun, checked, stats, cost, findings }]
 * A check whose input is missing (no token counts, or no raw text) is reported as not run,
 * never as passed.
 */
export function runChecks(c, defs = CHECKS) {
  return defs.map((def) => {
    const base = { id: def.id, title: def.title, how: def.how, evidence: def.evidence };
    const missing = (def.needs ?? []).find((n) => (n === 'usage' ? !c.usage.liveCalls : n === 'raw' ? !c.hasRaw : false));
    if (missing) {
      return { ...base, ran: false, notRun: missing === 'usage' ? 'No token counts were recorded in this window, so this check had nothing to measure.' : "The logs' raw text wasn't available to this check.", checked: null, stats: [], cost: null, findings: [] };
    }
    let res;
    try {
      res = def.run(c);
    } catch {
      return { ...base, ran: false, notRun: 'This check stopped on something in the logs it could not read, so it has no findings.', checked: null, stats: [], cost: null, findings: [] };
    }
    const findings = res.findings.map((f) => {
      const live = def.liveSensitive && f.lastTurn && f.session && c.stillRunning(f.session) && f.severity === 'look';
      const { lastTurn: _l, afterFailedRun: _a, ...rest } = f;
      return { check: def.id, ...rest, ...(live ? { severity: 'note', stillRunning: true, note: `${f.note} This session wrote a record within an hour of this build, so it may still be running.` } : {}) };
    });
    return { ...base, ran: true, notRun: null, checked: res.checked, stats: res.stats ?? [], cost: res.cost ?? null, findings };
  });
}
