// lib/review/claims.mjs: the checks a pull request's steps ran, and each claim its author agent
// made, paired with the check behind it or the gap where there's none.
//
// A claim is a sentence the agent wrote that the work is done, that tests pass, or that CI is
// green, in any of its messages in scope (mid-turn ones and sub-agents' included), in the body
// of its recorded gh pr create command, or in a commit message (the weakest kind: nobody reads a
// commit message as a report). Each pairs with the latest check after the last edit before it,
// in the same session, decided the way the Problems checks decide it (lib/problems/backing.mjs).
// A check run in a folder on another branch is a named gap, never backing, and so is a step
// whose pull request is ambiguous. Every check also says whether it still holds at the pull
// request's head: stale when an edit to its files came after it (derived) or a commit nobody
// tested did (inferred), else current as far as the logs show.

import { backingCheck, lastEditBefore } from '../problems/backing.mjs';
import { classifyAgentText } from '../problems/classify.mjs';
import { checkClass } from '../problems/classify.mjs';
import { commandChain, simpleCommands } from '../replay/classify.mjs';
import { sameCommit } from '../replay/lookup.mjs';

/** "CI is green", "checks pass": a claim about CI the agent can only back by reading it
 *  (brief.ci-claim). Negated or qualified sentences don't count. */
const CI_CLAIM = /\b(?:ci|checks?|the build|github actions|all (?:\d+ )?(?:ci )?(?:jobs|checks))\s+(?:is |are |were |was |now |all )*(?:green|pass(?:es|ed|ing)?|succeed(?:s|ed)?|ok)\b|\bci passed\b|\bgreen ci\b/i;
const CI_NEGATED = /\b(?:not|n't|never|no|until|once|if|when|waiting|wait for|pending|still running)\b/i;
const CI_READ = /^gh\s+(?:pr\s+checks|run\s+(?:watch|view|list)|pr\s+view\b.*statusCheckRollup)\b/;

/** One sentence of `text` holding a match of `re`, cut at its sentence ends. */
function sentenceOf(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n'), before.lastIndexOf('! '), before.lastIndexOf('? ')) + 1;
  const rest = text.slice(m.index);
  const endRel = rest.search(/[.!?](?:\s|$)|\n/);
  return text.slice(start, endRel === -1 ? text.length : m.index + endRel + 1).trim();
}

/** The kinds of claim a text makes: 'done', 'tests-pass', 'ci-green', with how strongly. */
export function claimKinds(text) {
  const s = String(text ?? '');
  const fl = classifyAgentText(s);
  const kinds = [];
  if (fl.flat) kinds.push({ kind: 'done', strength: 'flat', rule: 'problems.completion-claim' });
  else if (fl.hedged) kinds.push({ kind: 'done', strength: 'hedged', rule: 'problems.completion-claim' });
  if (fl.testsPass) kinds.push({ kind: 'tests-pass', strength: 'flat', rule: 'problems.tests-pass-claim' });
  const ci = sentenceOf(s, CI_CLAIM);
  if (ci && !CI_NEGATED.test(ci)) kinds.push({ kind: 'ci-green', strength: 'flat', rule: 'brief.ci-claim' });
  return { kinds, admitsNoCheck: fl.admitsNoCheck };
}

/** The body text of a gh pr create command: its --body / -b value, or a heredoc's lines. */
export function prBodyOf(command) {
  const s = String(command ?? '');
  const heredoc = s.match(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1(?=\s|$)/);
  if (heredoc && /gh\s+pr\s+create/.test(s)) return heredoc[2];
  const quoted = s.match(/(?:--body|-b)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
  return quoted ? (quoted[1] ?? quoted[2]).replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;
}

const RISKY = /[;|<>`]|&&|\$\(|\brm\b|\bcurl\b|\bwget\b|\bgit\s+push\b|\bsudo\b/;
/** A check command a reviewer can run as it is: one recognized test, build, lint or type-check
 *  runner, after dropping a leading `cd <folder> &&` (the reviewer runs it in their own checkout
 *  at the head), with no other operator, redirect, deletion, download or push. null otherwise. */
export function plainCheck(command) {
  const s = String(command ?? '').trim().replace(/^\s*(?:cd|pushd|set-location)\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*/i, '');
  if (!s || s.includes('\n') || RISKY.test(s)) return null;
  const chain = commandChain(s);
  if (chain.length !== 1) return null;
  const kind = checkClass(s);
  if (!kind || kind === 'run of code' || kind === 'request to a server') return null;
  return s;
}

/**
 * pairClaims({ h, ctx, pr, scope, commitMessages }) -> { checks, claims, rerun, readFirst }
 *
 * h: the history; ctx: the problems context built on it (lib/problems/context.mjs); pr and scope:
 * resolvePr's and scopeSteps's answers. commitMessages: [{ sha, text }] for the pull request's
 * commits (read from git by the caller; empty without git). Texts are returned raw: the caller
 * redacts and quotes them.
 */
export function pairClaims({ h, ctx, pr, scope, commitMessages = [] }) {
  const branch = pr.branch.name;
  const defaultNames = new Set(['main', 'master']);
  const fileSet = new Set(pr.files.list.map((f) => f.path));
  // Only the sessions that wrote or reviewed it: a session that only looked it up ran no check on it.
  const working = new Set((scope.sessions ?? []).filter((s) => s.role !== 'mentioned').map((s) => s.key));
  const inScope = (id) => scope.inScope.has(id) && working.has(ctx.byId.get(id)?.session);
  // A check ran on this pull request's branch when its folder was on it; on the default branch
  // or another branch it tested something else. A folder the logs don't place can't be told.
  const branchOfStep = (id) => scope.branchOf(id);
  const folderOk = (s) => {
    const b = branchOfStep(s.ev);
    return b == null || (branch != null && b === branch);
  };
  const where = (s) => {
    const b = branchOfStep(s.ev);
    if (b == null) return 'unknown';
    if (branch && b === branch) return 'on-branch';
    return defaultNames.has(b) ? 'default-branch' : 'other-branch';
  };

  // In-scope steps, per session, in the engine's order.
  const bySession = new Map();
  for (const [id, s] of ctx.steps) if (inScope(id)) (bySession.get(s.session) ?? bySession.set(s.session, []).get(s.session)).push(s);
  for (const list of bySession.values()) list.sort((a, b) => a.seq - b.seq);
  const eventsBySession = new Map();
  for (const e of h.events) if (inScope(e.id)) (eventsBySession.get(e.session) ?? eventsBySession.set(e.session, []).get(e.session)).push(e);
  const byId = ctx.byId;

  // Edits to the pull request's files, and commits, after each moment.
  const relOf = (s) => {
    const raw = byId.get(s.ev)?._raw?.input?.file_path ?? byId.get(s.ev)?._raw?.input?.path;
    if (typeof raw !== 'string') return null;
    const norm = raw.replace(/\\/g, '/');
    return [...fileSet].find((f) => norm.toLowerCase().endsWith(`/${f.toLowerCase()}`)) ?? null;
  };
  const prEdits = [];
  for (const list of bySession.values()) for (const s of list) if (s.cat === 'edit' && s.result === 'ok' && relOf(s)) prEdits.push(s);
  const commitTimes = pr.commits.list.filter((c) => c.at).map((c) => ({ sha: c.sha, t: Date.parse(c.at), loggedBy: c.loggedBy ?? [] }));

  // The checks its steps ran.
  const checks = [];
  for (const [key, list] of bySession) {
    for (const s of list) {
      if (!s.check || s.result === 'refused') continue;
      const e = byId.get(s.ev);
      const editAfter = prEdits.find((x) => x.t > s.t);
      // A commit after the check, by a session that made no commit right after it with nothing
      // edited between: the head may hold work the check never ran on.
      const commitAfter = commitTimes.find((c) => c.t > s.t && !(c.loggedBy.includes(key) && !prEdits.some((x) => x.session === key && x.t > s.t && x.t < c.t)));
      const currency = editAfter
        ? { state: 'stale', evidence: 'derived', why: 'edit', event: editAfter.ev }
        : commitAfter
          ? { state: 'stale', evidence: 'inferred', why: 'commit', sha: commitAfter.sha, rule: 'brief.stale-commit' }
          : { state: 'current', evidence: 'inferred', why: 'none-seen', rule: 'brief.current-as-logged' };
      checks.push({ event: s.ev, session: key, t: s.t, at: e?.at ?? null, kind: s.check, command: typeof e?._command === 'string' ? e._command : null, result: s.test ?? s.result ?? null, failedTests: s.summary?.fail ?? null, passedTests: s.summary?.pass ?? null, evidence: s.test ? 'inferred' : 'recorded', rule: s.test ? 'shell.test' : null, folder: where(s), currency });
    }
  }
  checks.sort((a, b) => a.t - b.t);

  // Run these yourself: each plain check command once; the rest are read first.
  const rerun = [];
  const readFirst = [];
  const seen = new Set();
  for (const c of checks) {
    if (!c.command) continue;
    const plain = plainCheck(c.command);
    const key = plain ?? c.command;
    if (seen.has(key)) continue;
    seen.add(key);
    (plain ? rerun : readFirst).push({ command: plain ?? c.command, event: c.event, kind: c.kind });
  }

  // Claims in its messages.
  const claims = [];
  const pair = (session, seq, t) => {
    const steps = bySession.get(session) ?? [];
    const after = lastEditBefore(steps, seq);
    return backingCheck(ctx, { steps, events: eventsBySession.get(session) ?? [], session, after, before: seq, folderOk });
  };
  const ciBacking = (session, t) => {
    const read = (eventsBySession.get(session) ?? []).filter((e) => e.kind === 'action' && e.t <= t && simpleCommands(e._command).some((c) => CI_READ.test(c))).at(-1);
    return read
      ? { status: 'ci-read', event: read.id, level: 'inferred', how: "A step read CI before this claim. What it printed isn't checked against the claim yet." }
      : { status: 'gap', gap: 'no-ci-read', level: 'inferred', how: 'No step before this claim read CI (gh pr checks, gh run watch or view).' };
  };
  for (const e of h.events) {
    if (e.kind !== 'message' || !working.has(e.session) || !(scope.inScope.has(e.id) || scope.ambiguous.has(e.id))) continue;
    const text = typeof e._raw?.text === 'string' ? e._raw.text : null;
    if (!text) continue;
    const { kinds, admitsNoCheck } = claimKinds(text);
    if (!kinds.length) continue;
    const seq = ctx.seqOf.get(e.id);
    const ambiguous = scope.ambiguous.has(e.id);
    for (const k of kinds) {
      const backing = k.kind === 'ci-green' ? ciBacking(e.session, e.t) : pair(e.session, seq, e.t);
      claims.push({ event: e.id, session: e.session, t: e.t, at: e.at ?? null, source: e.agent?.endsWith(':main') ? 'message' : 'sub-agent message', kind: k.kind, strength: k.strength, rule: k.rule, text, admitsNoCheck, ambiguous, backing: ambiguous ? { status: 'gap', gap: 'ambiguous', level: 'inferred', how: "This message sits between this pull request's work and another's, so no check is paired with it." } : backing });
    }
  }
  // Claims in the recorded pull-request body.
  for (const ev of pr.events?.creates ?? []) {
    const body = prBodyOf(ev._command);
    if (!body) continue;
    const { kinds } = claimKinds(body);
    const seq = ctx.seqOf.get(ev.id);
    for (const k of kinds.filter((x) => x.kind !== 'done')) {
      const backing = k.kind === 'ci-green' ? ciBacking(ev.session, ev.t) : inScope(ev.id) ? pair(ev.session, seq, ev.t) : { status: 'gap', gap: 'not-in-scope', level: 'inferred', how: "The step that opened the pull request isn't in scope." };
      claims.push({ event: ev.id, session: ev.session, t: ev.t, at: ev.at ?? null, source: 'pull-request body', kind: k.kind, strength: 'flat', rule: k.rule, text: body, ambiguous: false, backing });
    }
  }
  // Claims in commit messages: weaker, and paired with the step that made the commit when a log has it.
  for (const m of commitMessages) {
    const { kinds } = claimKinds(m.text);
    for (const k of kinds.filter((x) => x.kind !== 'done')) {
      const step = [...(bySession.values())].flat().find((s) => (h._refIndex?.().commitRefs ?? []).some((c) => sameCommit(c.sha, m.sha) && (c.event.id === s.ev || c.event.facts?.nominatedBy === s.ev)));
      const backing = step ? pair(step.session, step.seq, step.t) : { status: 'gap', gap: 'commit-not-logged', level: 'missing', how: 'No step in these logs made this commit, so nothing here backs or contradicts its message.' };
      claims.push({ event: step?.ev ?? null, sha: m.sha, session: step?.session ?? null, t: step?.t ?? null, at: null, source: 'commit message', kind: k.kind, strength: 'weaker', rule: k.rule, text: m.text, ambiguous: false, backing });
    }
  }
  // Unbacked first: a gap, then a failed check, then the rest; each in time order.
  const rank = (c) => (c.backing.status === 'gap' ? 0 : c.backing.failed === true ? 1 : 2);
  claims.sort((a, b) => rank(a) - rank(b) || (a.t ?? Infinity) - (b.t ?? Infinity));
  return { checks, claims, rerun, readFirst };
}
