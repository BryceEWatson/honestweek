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
import { RULES } from './classify.mjs';
import { createContext, THRESHOLDS } from './context.mjs';
import { DRAFTS } from './drafts.mjs';

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
export const PRIORITY_RULE = Object.freeze({
  classes: [
    { id: 'harm', label: 'Harm', text: 'safety, and correctness and honesty patterns' },
    { id: 'cost', label: 'Cost', text: 'efficiency and cost patterns, judged by the tokens their check measured' },
    { id: 'friction', label: 'Friction', text: 'process and collaboration patterns' },
  ],
  tiers: [
    { id: 'high', label: 'High', text: "a harm pattern with a finding worth a look worked out from the log's facts (derived or recorded), or with 3 or more worth a look by a rule's best guess; or a cost pattern whose tokens are 5% or more of the window's" },
    { id: 'medium', label: 'Medium', text: "a harm pattern with 1 or 2 findings worth a look, only by a rule's best guess; or a cost pattern at 1% to 5% of the window's tokens; or a friction pattern with 5 or more worth a look" },
    { id: 'low', label: 'Low', text: 'anything else found in this window, including a pattern whose findings are all routine notes' },
  ],
  counts: 'Only findings worth a look count. A finding a check records as a note (a routine case, such as a hedged "should work") never raises a tier; the card shows it as routine.',
  order: 'Within a tier: tokens measured, then findings worth a look, then how well established the pattern is (well established before reported).',
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
  const tokens = p.tokens?.tokens > 0 ? p.tokens.tokens : null;
  const share = tokens && allTokens > 0 ? tokens / allTokens : null;
  const pctText = share == null ? '' : share < 0.001 ? 'under 0.1%' : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
  const out = (tier, reason) => ({ tier, impact, reason, look: n, notes: p.notesFound ?? 0, derived: p.derivedFound ?? 0, tokens, share, strength: STRENGTH_RANK[p.strength] ?? 3 });
  if (n === 0) return out('low', `nothing worth a look, only routine notes; ${what}`);
  if (impact === 'harm') {
    const facts = p.derivedFound ?? 0;
    if (facts > 0) return out('high', `found ${times}, ${facts >= n ? (n === 1 ? 'worked out' : 'each worked out') : `${facts.toLocaleString('en-US')} of them worked out`} from the log's facts; ${what}`);
    if (n >= PRIORITY.harmHighCount) return out('high', `found ${times} (3 or more), each by a rule's best guess; ${what}`);
    return out('medium', `found ${times} (fewer than 3), only by a rule's best guess; ${what}`);
  }
  if (impact === 'cost') {
    const tok = tokens ? `${fmt(tokens)} tokens by its check's estimate, ${pctText} of the window's` : null;
    if (share != null && share >= PRIORITY.highShare) return out('high', `${tok} (5% or more); ${what}`);
    if (share != null && share >= PRIORITY.mediumShare) return out('medium', `${tok} (1% to 5%); ${what}`);
    return out('low', tok ? `${tok} (under 1%); ${what}` : `found ${times}, with no token measure; ${what}`);
  }
  if (n >= PRIORITY.frictionMediumCount) return out('medium', `found ${times} (5 or more); ${what}`);
  return out('low', `found ${times} (fewer than 5); ${what}`);
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
  'context-bloat': [{ check: 'long-sessions', relation: 'Agents that passed 150k tokens of context and kept going for 30 or more calls, with what a hand-off at that point would have saved.' }],
  'repeated-file-reads': [{ check: 're-reads', relation: 'The same file and range read 3 or more times with no change recorded between.' }],
  'action-loop': [{ check: 'action-loop', relation: '3 or more identical calls with nothing changed between, edits undone and redone, and failed commands run again unchanged.' }],
  'repeated-tool-error': [{ check: 'repeated-tool-error', relation: 'The same error from the same tool, 2 or more times in a row, and edits to one file that failed in a row.' }],
  'busy-polling': [{ check: 'polling', relation: 'The same status call 3 or more times, each within 10 minutes, with nothing changed between.' }],
  'oversized-tool-output': [{ check: 'context-additions', relation: 'Single tool results that grew the context by 20k tokens or more, and what later calls paid to carry them.' }],
  'subagent-overuse': [{ check: 'subagent-overuse', relation: 'Sub-agents with 3 or fewer tool calls, and near-identical briefs started together.' }],
  'subagent-handoff-loss': [{ check: 'subagent-no-report', relation: 'A sub-agent with no recorded hand-back: no completion notice, or no result on the call that started it.' }],
  'scope-creep': [{ check: 'scope-creep', relation: 'Edits after a prompt that only asked a question.' }],
  'instruction-violation': [{ check: 'plan-mode-edit', relation: "The one written rule a log can check without knowing your own instructions: the harness's plan mode, where only the plan is written until you approve it." }],
  'premature-stop': [{ check: 'session-ended-mid-step', relation: "A proxy: the session's last record is an interruption, an error, a waiting call, or a step with no turn end after it." }],
  'needless-check-in': [{ check: 'needless-check-in', relation: "A turn that ended on a question, answered by a bare go-ahead (the engine's prompt.approval rule on your next prompt)." }],
  'destructive-command': [{ check: 'risky-command', filter: (f) => (f.patterns ?? []).includes('destructive-command'), relation: "Force-pushes, hard resets and other discards (the engine's shell.revert rule), recursive deletes and git clean." }],
  'bypassing-safeguards': [{ check: 'risky-command', filter: (f) => (f.patterns ?? []).includes('bypassing-safeguards'), relation: 'Commands that skip git hooks: --no-verify, or core.hooksPath set.' }],
  'secret-exposure': [{ check: 'secret-in-log', relation: 'Secret-shaped text in your prompts, tool-call inputs or agent messages (counts only, never the values).' }],
});

const RANK = { recorded: 0, derived: 1, inferred: 2, missing: 3 };
const weakest = (levels) => levels.filter((l) => l in RANK).sort((a, b) => RANK[b] - RANK[a])[0] ?? 'inferred';
const findingOrder = (x, y) => (x.severity === y.severity ? 0 : x.severity === 'look' ? -1 : 1) || (y.estimate ?? -1) - (x.estimate ?? -1) || String(y.at ?? '').localeCompare(String(x.at ?? ''));

/**
 * runProblems(h, { builtT }) -> { window, catalog, groups, priorityRule, patterns, checks,
 * coverage, rules, thresholds }. Every pattern carries all its findings, best first; callers
 * trim what they show.
 */
export function runProblems(h, { builtT = Date.now() } = {}) {
  const started = Date.now();
  const catalog = loadCatalog();
  const c = createContext(h, { builtT });
  const results = runChecks(c);
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
      if (r.cost && !m.filter) cost = { tokens: r.cost.tokens, waste: !!r.cost.waste, label: r.cost.label, evidence: r.cost.evidence };
      else if (r.cost && m.filter) cost = { tokens: list.reduce((s, f) => s + (f.estimate ?? 0), 0), waste: !!r.cost.waste, label: `${r.cost.label} (only the findings that bear on this pattern)`, evidence: r.cost.evidence };
      if (cost && !tokens) tokens = cost;
      measures.push({ check: r.id, title: r.title, evidence: r.evidence, relation: m.relation, ran: r.ran, notRun: r.notRun, count: list.length, look: list.filter((f) => f.severity === 'look').length });
      for (const f of list) {
        const k = `${f.session}|${f.event}|${f.at}`;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push({ ...f, pattern: p.id, checkTitle: r.title });
      }
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
      group: p.group,
      looksLike: p.looksLike,
      whyItMatters: p.whyItMatters,
      strength: p.strength,
      strengthReason: p.strengthReason,
      sourceKinds,
      sources: p.sources,
      detection: p.detection,
      mitigation: p.mitigation,
      related: p.related,
      status,
      notRun: status === 'unchecked' && measures.length ? measures.find((m) => m.notRun)?.notRun ?? null : null,
      measures,
      count: found.length,
      look,
      notesFound: found.length - look,
      derivedFound: found.filter((f) => f.severity === 'look' && (f.verdictEvidence === 'derived' || f.verdictEvidence === 'recorded')).length,
      tokens: status === 'found' || status === 'clear' ? tokens : null,
      countEvidence: ran.length ? weakest(ran.map((m) => m.evidence)) : null,
      draft: DRAFTS[p.id] ?? null,
      findings: found,
    };
    out.priority = priorityOf(out, groupName.get(p.group), allTokens);
    return out;
  });

  const checks = results.map((r) => ({ id: r.id, title: r.title, how: r.how, evidence: r.evidence, ran: r.ran, notRun: r.notRun, checked: r.checked, stats: r.stats, cost: r.cost, findingsTotal: r.findings.length, patterns: Object.entries(PATTERN_CHECKS).filter(([, ms]) => ms.some((m) => m.check === r.id)).map(([id]) => id) }));
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
      sessions: { value: c.sessions.filter((s) => (c.eventsBySession.get(s.key) ?? []).some((e) => c.inWin(e.t))).length, evidence: 'derived' },
      toolCalls: { value: [...c.steps.values()].filter((s) => c.inWin(s.t)).length, evidence: 'derived' },
      modelCalls: { value: c.usage.liveCalls, evidence: 'recorded' },
      tokens: { value: allTokens, evidence: 'recorded' },
      usageRecorded: c.usage.liveCalls > 0,
      rawText: c.hasRaw,
    },
    rules: RULES,
    thresholds: THRESHOLDS,
    ms: Date.now() - started,
  };
}

export { CHECKS, RULES, THRESHOLDS };
