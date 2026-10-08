// lib/problems/index.mjs: known problems in AI coding agents, checked against one window of
// sessions.
//
// runProblems(h) runs every check (checks.mjs) over an engine history and joins its findings
// to the catalog (catalog.json): each pattern with the checks that measure it, this window's
// findings, a priority tier from a stated rule, a draft fix and its sources. It reads only the
// history; it never reads a file other than the catalog shipped beside it, runs git or writes
// anything. The strings it returns aren't redacted yet: the caller redacts them for the screen
// they go to.

import { readFileSync } from 'node:fs';

import { CHECKS, fmt, runChecks } from './checks.mjs';
import { RULE_SOURCES, RULES } from './classify.mjs';
import { createContext, NUMBERS, THRESHOLDS } from './context.mjs';
import { DRAFTS } from './drafts.mjs';
import { findFixTests, fixVersion, testTag } from './fix-tests.mjs';
import { SCOPE_KINDS } from './scope.mjs';

let CATALOG = null;
/** The shipped catalog of known problems, read once. */
export function loadCatalog() {
  CATALOG ??= JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
  return CATALOG;
}

// ---------------------------------------------------------------------------------------
// Priority: a stated rule over this window's findings, never a score. Each found pattern gets a
// tier and the reason the rule gave it; patterns not found get none.
// ---------------------------------------------------------------------------------------
export const PRIORITY = Object.freeze({
  impact: Object.freeze({ 'correctness-honesty': 'harm', safety: 'harm', 'efficiency-cost': 'cost', process: 'friction', collaboration: 'friction' }),
  harmHighCount: 3, // a harm pattern found this many times, by a rule alone, is high
  highShare: 0.05, // a cost pattern at this share of the window's tokens is high
  mediumShare: 0.01, // and at this share, medium
  frictionMediumCount: 5, // a friction pattern found this many times is medium
});
// The rule's words are built from PRIORITY, so the page always states the rule the code applies.
const pctLine = (x) => `${Math.round(x * 1000) / 10}%`;
/** What every check says when the window holds no session to read. */
export const NOTHING_TO_CHECK = 'No session in your configured repositories has a record in this window, so there was nothing to check.';

export const PRIORITY_RULE = Object.freeze({
  classes: [
    { id: 'harm', label: 'Harm', text: 'safety, and correctness and honesty patterns' },
    { id: 'cost', label: 'Cost', text: "efficiency and cost patterns, judged by the tokens their check estimates for the findings worth a look (an estimate from recorded token counts, not a measurement)" },
    { id: 'friction', label: 'Friction', text: 'process and collaboration patterns' },
  ],
  tiers: [
    { id: 'high', label: 'High', text: `a harm pattern with a finding worth a look worked out from the log's facts (derived or recorded), or with ${PRIORITY.harmHighCount} or more worth a look by a rule's best guess; or a cost pattern whose findings worth a look are estimated at ${pctLine(PRIORITY.highShare)} or more of the window's tokens` },
    { id: 'medium', label: 'Medium', text: `a harm pattern with fewer than ${PRIORITY.harmHighCount} findings worth a look, only by a rule's best guess; or a cost pattern at ${pctLine(PRIORITY.mediumShare)} to ${pctLine(PRIORITY.highShare)} of the window's tokens; or a friction pattern, or a cost pattern whose check counts tokens spent rather than an estimate of waste, with ${PRIORITY.frictionMediumCount} or more worth a look` },
    { id: 'low', label: 'Low', text: 'anything else found in this window, including a pattern whose findings are all routine notes' },
  ],
  counts: 'Only findings worth a look count, over the whole window, so a longer window can raise a tier. A finding a check records as a note (a routine case, such as a hedged "should work") never raises a tier; the card shows it as routine.',
  order: 'Within a tier: the estimated tokens of the findings worth a look, then findings worth a look, then how well established the pattern is (well established before reported).',
  rest: "Patterns not found in this window, with no check built yet, or that a log can't show get no priority.",
});
const STRENGTH_RANK = { 'well-established': 0, reported: 1, speculative: 2 };

/** The tier and the rule's reason for one found pattern; null when it wasn't found. */
export function priorityOf(p, groupName, allTokens) {
  if (p.status !== 'found') return null;
  const impact = PRIORITY.impact[p.group] ?? 'friction';
  const n = p.look ?? 0;
  const times = n === 1 ? 'once' : `${n.toLocaleString('en-US')} times`;
  const gname = String(groupName ?? p.group).toLowerCase();
  const what = `${/^[aeiou]/.test(gname) ? 'an' : 'a'} ${gname} pattern`;
  // A cost tier rests on the findings worth a look, and only on an estimate of waste: tokens a
  // check counts as spending (small sub-agents) don't set a tier.
  const spending = !!p.tokens && p.tokens.waste === false;
  const tokens = !spending && p.tokens?.lookTokens > 0 ? p.tokens.lookTokens : null;
  const share = tokens && allTokens > 0 ? tokens / allTokens : null;
  // Rounded down, so a share just under a tier's line never prints as the line itself.
  const pctText = share == null ? '' : share < 0.001 ? 'under 0.1%' : share < 0.1 ? `${(Math.floor(share * 1000) / 10).toFixed(1)}%` : `${Math.floor(share * 100)}%`;
  const out = (tier, reason) => ({ tier, impact, reason, look: n, notes: p.notesFound ?? 0, derived: p.derivedFound ?? 0, tokens, share, strength: STRENGTH_RANK[p.strength] ?? 3 });
  if (n === 0) return out('low', `nothing worth a look, only routine notes; ${what}`);
  if (impact === 'harm') {
    const facts = p.derivedFound ?? 0;
    if (facts > 0) return out('high', `found ${times}, ${facts >= n ? (n === 1 ? 'worked out' : 'each worked out') : `${facts.toLocaleString('en-US')} of them worked out`} from the log's facts; ${what}`);
    if (n >= PRIORITY.harmHighCount) return out('high', `found ${times} (${PRIORITY.harmHighCount} or more), each by a rule's best guess; ${what}`);
    return out('medium', `found ${times} (fewer than ${PRIORITY.harmHighCount}), only by a rule's best guess; ${what}`);
  }
  const byCount = spending ? "; its check counts tokens spent, not an estimate of waste, so the count sets the tier" : '';
  if (impact === 'cost' && !spending) {
    // Estimates for neighbouring steps overlap (a later call's context holds an earlier result),
    // so a pattern's estimate can pass the window's total; it's never printed as a share over 100%.
    const shareText = share > 1 ? "more than all the window's tokens, since estimates for neighbouring steps overlap" : `${pctText} of the window's`;
    const tok = tokens ? `${fmt(tokens)} tokens estimated for the findings worth a look, ${shareText}` : null;
    if (share != null && share >= PRIORITY.highShare) return out('high', `${tok} (${pctLine(PRIORITY.highShare)} or more); ${what}`);
    if (share != null && share >= PRIORITY.mediumShare) return out('medium', `${tok} (${pctLine(PRIORITY.mediumShare)} to ${pctLine(PRIORITY.highShare)}); ${what}`);
    return out('low', tok ? `${tok} (under ${pctLine(PRIORITY.mediumShare)}); ${what}` : `found ${times}, with no token estimate; ${what}`);
  }
  if (n >= PRIORITY.frictionMediumCount) return out('medium', `found ${times} (${PRIORITY.frictionMediumCount} or more)${byCount}; ${what}`);
  return out('low', `found ${times} (fewer than ${PRIORITY.frictionMediumCount})${byCount}; ${what}`);
}

// ---------------------------------------------------------------------------------------
// The map: every pattern a check measures. A filter narrows a shared check to the findings
// that bear on one pattern.
// ---------------------------------------------------------------------------------------
export const PATTERN_CHECKS = Object.freeze({
  'unverified-done-claim': [
    { check: 'unverified-done-claim', relation: 'A turn that edited code, ran no check after the last edit, and ended on a completion claim.' },
    { check: 'pr-landed-without-tests', relation: 'A pull request that landed with no test run in any session behind it.' },
  ],
  'claim-contradicts-evidence': [
    { check: 'claim-contradicts-evidence', relation: 'The last check in a turn failed, and the last message claims success or calls the failure pre-existing.' },
    { check: 'commit-after-failed-test', relation: 'A commit or merge right after a failed test run, with no passing run between: moving on as if it passed.' },
  ],
  'test-tampering': [{ check: 'test-tampering', relation: 'Recorded edits to test files and test commands that weaken, skip or exclude tests.' }],
  'context-bloat': [{ check: 'long-sessions', relation: 'Agents that passed your long-session limit and kept going for 30 or more calls, with what a hand-off at that point would have saved. Off until you set a limit in Settings.' }],
  'cache-miss': [{ check: 'cache-misses', relation: 'Model calls that re-sent 20k tokens or more of a conversation the call before had cached, with the pause before each and, where Claude Code recorded it, how long it cached.' }],
  'repeated-file-reads': [{ check: 're-reads', relation: 'The same file and range read 3 or more times with no change recorded between.' }],
  'action-loop': [{ check: 'action-loop', relation: '3 or more identical calls with nothing changed between, edits undone and redone, and failed commands run again unchanged.' }],
  'repeated-tool-error': [{ check: 'repeated-tool-error', relation: 'The same error from the same tool, 2 or more times in a row, and edits to one file that failed in a row.' }],
  'busy-polling': [{ check: 'polling', relation: 'The same status call 3 or more times, each within 10 minutes, with nothing changed between.' }],
  'oversized-tool-output': [{ check: 'context-additions', relation: 'Single tool results that grew the context by 20k tokens or more, and what later calls paid to carry them.' }],
  'overthinking': [{ check: 'output-per-call', relation: `Model calls whose output per tool call was ${THRESHOLDS.outputRatio} times or more the session's median for the same model, and ${THRESHOLDS.outputMin.toLocaleString('en-US')} tokens or more, never compared across models.` }],
  'subagent-overuse': [{ check: 'subagent-overuse', relation: 'Sub-agents with 3 or fewer tool calls, and near-identical briefs started together.' }],
  'subagent-handoff-loss': [{ check: 'subagent-no-report', relation: 'A sub-agent with no recorded hand-back: no completion notice, or no result on the call that started it.' }],
  'scope-creep': [{ check: 'scope-creep', relation: 'Edits after a prompt that only asked a question.' }],
  'edits-outside-folder': [{ check: 'outside-edits', relation: "Successful edits to files outside the folder the session started in, by where they went." }],
  'instruction-violation': [{ check: 'plan-mode-edit', relation: "The one written rule a log can check without knowing your own instructions: the harness's plan mode, where only the plan is written until you approve it." }],
  'premature-stop': [
    { check: 'open-todos-stop', relation: "A turn that ended on a message to you while the agent's own to-do list still had open items, and the message named no blocker." },
    { check: 'session-ended-mid-step', relation: "A proxy: the session's last record is an interruption, an error, a waiting call, or a step with no turn end after it." },
  ],
  'needless-check-in': [{ check: 'needless-check-in', relation: 'A turn that ended on a question, an offer to carry on, or a list of options, with no blocker named, answered by a bare go-ahead.' }],
  'destructive-command': [{ check: 'risky-command', filter: (f) => (f.patterns ?? []).includes('destructive-command'), relation: "Force-pushes, hard resets and other discards (the engine's shell.revert rule), recursive deletes and git clean." }],
  'bypassing-safeguards': [{ check: 'risky-command', filter: (f) => (f.patterns ?? []).includes('bypassing-safeguards'), relation: 'Commands that skip git hooks: --no-verify (or git commit -n), or core.hooksPath pointed at nothing.' }],
  'secret-exposure': [{ check: 'secret-in-log', relation: "Secret-shaped text in your prompts, tool-call inputs or agent messages, or in the agent's progress updates (read by where they sit, so inferred). Counts only, never the values." }],
});

/** Claims not backed: the patterns the Problems page ranks first unless "My priority" says otherwise. */
export const CLAIM_PATTERNS = Object.freeze(['unverified-done-claim', 'claim-contradicts-evidence']);
/** The levels a finding needs to sit in the page's main list; the rest go under "Possible". */
export const SURE = Object.freeze(['recorded', 'derived']);
export const isSure = (f) => SURE.includes(f.verdictEvidence);

const RANK = { recorded: 0, derived: 1, inferred: 2, missing: 3 };
export const weakest = (levels) => levels.filter((l) => l in RANK).sort((a, b) => RANK[b] - RANK[a])[0] ?? 'inferred';
const findingOrder = (x, y) => (x.severity === y.severity ? 0 : x.severity === 'look' ? -1 : 1) || (y.estimate ?? -1) - (x.estimate ?? -1) || String(y.at ?? '').localeCompare(String(x.at ?? ''));

/**
 * runProblems(h, { builtT, longSessionTokens, saved }) -> { window, catalog, groups, priorityRule, patterns, checks,
 * coverage, rules, thresholds, ms }. Every pattern carries all its findings, best first; callers
 * trim what they show. `saved` maps a session that came back from saved results (lib/saved/) to
 * the findings saved with it, which stand in for whatever the checks find in it now.
 */
export function runProblems(h, { builtT = Date.now(), longSessionTokens = null, saved = null } = {}) {
  const started = Date.now();
  const catalog = loadCatalog();
  const c = createContext(h, { builtT, longSessionTokens });
  // With no session to read, a check has nothing to look at, so it says it didn't run instead
  // of reading as checked and clear.
  const sessionsChecked = c.sessions.filter((s) => (c.eventsBySession.get(s.key) ?? []).some((e) => c.inWin(e.t))).length;
  const checked = runChecks(c);
  const nothingToCheck = sessionsChecked === 0 && checked.every((r) => !r.findings.length);
  const results = nothingToCheck ? checked.map((r) => ({ ...r, ran: false, notRun: NOTHING_TO_CHECK, checked: null, stats: [], cost: null })) : checked;
  const byCheck = new Map(results.map((r) => [r.id, r]));
  const groupName = new Map(catalog.groups.map((g) => [g.id, g.name]));
  const allTokens = c.usage.allTokens;

  const patterns = catalog.patterns.map((p) => {
    const measures = [];
    const found = [];
    const seen = new Set();
    let tokens = null;
    for (const m of PATTERN_CHECKS[p.id] ?? []) {
      const r = byCheck.get(m.check);
      if (!r) continue;
      const list = m.filter ? r.findings.filter(m.filter) : r.findings;
      let cost = null;
      // lookTokens: the estimate for this pattern's findings worth a look, which alone sets a tier.
      const lookTokens = list.reduce((s, f) => s + (f.severity === 'look' ? f.estimate ?? 0 : 0), 0);
      if (r.cost && !m.filter) cost = { tokens: r.cost.tokens, lookTokens, waste: !!r.cost.waste, label: r.cost.label, evidence: r.cost.evidence };
      else if (r.cost && m.filter) cost = { tokens: list.reduce((s, f) => s + (f.estimate ?? 0), 0), lookTokens, waste: !!r.cost.waste, label: `${r.cost.label} (only the findings that bear on this pattern)`, evidence: r.cost.evidence };
      if (cost && !tokens) tokens = cost;
      measures.push({ check: r.id, title: r.title, evidence: r.evidence, relation: m.relation, ran: r.ran, notRun: r.notRun, count: list.length, look: list.filter((f) => f.severity === 'look').length });
      for (const f of list) {
        const k = `${f.session}|${f.event}|${f.at}`;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push({ ...f, pattern: p.id, checkTitle: r.title });
      }
    }
    // A session that came back as saved (lib/saved/) has no raw text for the checks to read, so
    // its findings are the ones saved with it, each with the evidence word it had then.
    if (saved?.size) {
      for (let i = found.length - 1; i >= 0; i -= 1) if (saved.has(found[i].session)) found.splice(i, 1);
      for (const list of saved.values()) for (const f of list) if (f?.pattern === p.id) found.push({ ...f });
    }
    found.sort(findingOrder);
    const level = p.detection?.level ?? null;
    const ran = measures.filter((m) => m.ran);
    const status = level === 'not-detectable' ? 'undetectable' : !ran.length ? 'unchecked' : found.length ? 'found' : 'clear';
    const sourceKinds = {};
    for (const s of p.sources) sourceKinds[s.kind] = (sourceKinds[s.kind] ?? 0) + 1;
    const look = found.filter((f) => f.severity === 'look').length;
    const out = {
      id: p.id,
      name: p.name,
      // Plain words for the pattern itself, for the page's titles; `name` stays the catalog's.
      headline: p.headline,
      group: p.group,
      looksLike: p.looksLike,
      whyItMatters: p.whyItMatters,
      strength: p.strength,
      strengthReason: p.strengthReason,
      sourceKinds,
      sources: p.sources,
      detection: p.detection,
      coverage: p.coverage,
      mitigation: p.mitigation,
      related: p.related,
      status,
      notRun: status === 'unchecked' && measures.length ? measures.find((m) => m.notRun)?.notRun ?? null : null,
      measures,
      count: found.length,
      look,
      notesFound: found.length - look,
      derivedFound: found.filter((f) => f.severity === 'look' && (f.verdictEvidence === 'derived' || f.verdictEvidence === 'recorded')).length,
      claim: CLAIM_PATTERNS.includes(p.id),
      // Findings worked out from the log (recorded or derived), and the rest: a rule's guess or a missing record.
      sure: { count: found.filter(isSure).length, look: found.filter((f) => isSure(f) && f.severity === 'look').length },
      possible: { count: found.filter((f) => !isSure(f)).length, look: found.filter((f) => !isSure(f) && f.severity === 'look').length },
      testPrompt: PATTERN_CHECKS[p.id] && typeof p.testPrompt === 'string' ? p.testPrompt : null,
      // Riding with the test prompt: a temporary change to make first, an estimate of what the
      // prompt costs, and what to look for when the fix works and when it doesn't.
      ...Object.fromEntries(['testSetup', 'testCost', 'testCostWhy', 'testExpect'].map((k) => [k, PATTERN_CHECKS[p.id] && typeof p.testPrompt === 'string' ? p[k] ?? null : null])),
      tokens: status === 'found' || status === 'clear' ? tokens : null,
      // The weakest level among the findings counted; with none, among the checks that ran.
      countEvidence: found.length ? weakest(found.map((f) => f.verdictEvidence)) : ran.length ? weakest(ran.map((m) => m.evidence)) : null,
      draft: DRAFTS[p.id] ?? null,
      findings: found,
    };
    out.priority = priorityOf(out, groupName.get(p.group), allTokens);
    return out;
  });

  // Tests of a fix: a session holding a test prompt's tag, and what it showed (fix-tests.mjs).
  // Each pattern with a test prompt and a fix carries the fix's version and the tag to copy.
  const tests = findFixTests(c, { results: new Map(patterns.map((p) => [p.id, { found: p.findings, measures: p.measures, coverage: p.coverage }])), kindOf: (id) => SCOPE_KINDS[id]?.kind ?? null });
  for (const p of patterns) {
    if (!p.testPrompt || !p.draft) continue;
    p.fixVersion = fixVersion(p.draft);
    p.testTag = testTag(p.id, p.fixVersion);
    p.fixTests = tests.get(p.id) ?? [];
  }

  // Each check's numbers, as its card states them, and where each comes from: null for
  // honestweek's own choice, or a catalog source's address (context.mjs, NUMBERS).
  const numbersOf = (id) => (CHECKS.find((x) => x.id === id)?.numbers ?? []).map((key) => ({ key, says: NUMBERS[key].says, source: NUMBERS[key].source }));
  const checks = results.map((r) => ({ id: r.id, title: r.title, how: r.how, evidence: r.evidence, ran: r.ran, notRun: r.notRun, checked: r.checked, stats: r.stats, cost: r.cost, findingsTotal: r.findings.length, patterns: Object.entries(PATTERN_CHECKS).filter(([, ms]) => ms.some((m) => m.check === r.id)).map(([id]) => id), numbers: numbersOf(r.id) }));
  const statusCounts = { found: 0, clear: 0, unchecked: 0, undetectable: 0 };
  for (const p of patterns) statusCounts[p.status]++;
  return {
    window: { from: h.window.from, to: h.window.to, timezone: h.window.timezone, startAt: h.window.startAt, endAt: h.window.endAt },
    catalog: { name: catalog.name, version: catalog.version, checkedOn: catalog.checkedOn, about: catalog.about, sources: catalog.patterns.reduce((n, p) => n + p.sources.length, 0) },
    groups: catalog.groups,
    priorityRule: PRIORITY_RULE,
    statusCounts,
    patterns,
    checks,
    coverage: {
      sessions: { value: sessionsChecked, evidence: 'derived' },
      toolCalls: { value: [...c.steps.values()].filter((s) => c.inWin(s.t)).length, evidence: 'derived' },
      modelCalls: { value: c.usage.liveCalls, evidence: 'recorded' },
      tokens: { value: allTokens, evidence: 'recorded' },
      usageRecorded: c.usage.liveCalls > 0,
      rawText: c.hasRaw,
    },
    rules: RULES,
    ruleSources: RULE_SOURCES,
    thresholds: THRESHOLDS,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------------------
// The trend: this window against the one just before it, of the same length. Only counts.
// ---------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (s) => Date.parse(`${s}T00:00:00Z`);
const dayText = (t) => new Date(t).toISOString().slice(0, 10);
/** The window just before from..to (inclusive calendar days), of the same length. */
export function earlierWindow({ from, to }) {
  const a = dayOf(from);
  const b = dayOf(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const days = Math.round((b - a) / DAY_MS) + 1;
  return { from: dayText(a - days * DAY_MS), to: dayText(a - DAY_MS), days };
}

/**
 * The counts a trend needs from one run, and nothing else: the sessions read, and for each
 * pattern whether its checks ran and its findings worth a look of each kind, each with how the
 * count is known. `sure` counts the findings worked out from the log (recorded or derived): its
 * level is the weakest among them, or derived for a zero, which the run's findings alone give.
 * `possible` counts the rest: the weakest among them, or for a zero the weakest check that ran.
 */
export function trendCounts(result) {
  const patterns = {};
  for (const p of result.patterns) {
    const looks = p.findings.filter((f) => f.severity === 'look');
    const ran = p.status === 'found' || p.status === 'clear';
    const sure = looks.filter(isSure);
    const possible = looks.filter((f) => !isSure(f));
    const checksLevel = weakest(p.measures.filter((m) => m.ran).map((m) => m.evidence));
    patterns[p.id] = {
      ran,
      sure: { value: sure.length, evidence: sure.length ? weakest(sure.map((f) => f.verdictEvidence)) : 'derived' },
      possible: { value: possible.length, evidence: possible.length ? weakest(possible.map((f) => f.verdictEvidence)) : checksLevel },
    };
  }
  return { sessions: result.coverage.sessions.value, patterns };
}

/**
 * Each pattern's trend: { sure: { now, before }, possible: { now, before }, why }, each count a
 * { value, evidence }. `now` is null when this window's checks didn't run. `before` is null when
 * the earlier window has no session to read (why 'no-logs'), its checks didn't run there
 * ('not-checked'), or it couldn't be read ('failed'): a zero is shown only for a window that was
 * read and checked. One skipped on purpose (past the log limit, or more than memory holds) is
 * 'not-loaded'.
 */
export function trendOf(now, before) {
  const out = {};
  for (const [id, n] of Object.entries(now.patterns)) {
    const b = before?.patterns?.[id];
    const why = before?.skipped ? 'not-loaded' : !before || before.error ? 'failed' : !before.sessions ? 'no-logs' : !b?.ran ? 'not-checked' : null;
    const side = (k) => ({ now: n.ran ? n[k] : null, before: why ? null : b[k] });
    out[id] = { sure: side('sure'), possible: side('possible'), why };
  }
  return out;
}

export { CHECKS, RULES, THRESHOLDS };
