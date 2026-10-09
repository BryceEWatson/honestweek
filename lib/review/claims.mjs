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
import { runnableEdit } from '../problems/checks.mjs';
import { checkClass, classifyAgentText } from '../problems/classify.mjs';
import { commandChain, simpleCommands } from '../replay/classify.mjs';
import { sameCommit } from '../replay/lookup.mjs';
import { prBodyOf } from './resolve.mjs';

/** "CI is green", "checks pass": a claim about CI the agent can only back by reading it
 *  (brief.ci-claim). Negated or qualified sentences don't count. */
const CI_CLAIM = /\b(?:ci|github actions|the build|(?:all |the )?(?:\d+ )?(?:ci |pr |required )?(?:checks?|jobs))\s+(?:is |are |were |was |now |all |have |has )*(?:green|pass(?:es|ed|ing)?|succeed(?:s|ed)?|ok)\b|\bci passed\b|\bgreen ci\b/gi;
const CI_NEGATED = /\b(?:not|never|until|once|if|when|waiting|wait for|pending|still running|yet)\b|n't\b/i;
/** Checks run on this machine, not CI: "lint checks pass", "type checks pass", or "the build"
 *  or "locally" in a sentence that doesn't name CI. */
const LOCAL_BEFORE = /\b(?:lint(?:ing)?|type|unit|test|local)\s+$/i;
const NAMES_CI = /\bci\b|github actions/i;
const CI_READ = /^gh\s+(?:pr\s+checks|run\s+(?:watch|view|list)|pr\s+view\b.*statusCheckRollup)\b/;

/** Whether some match of CI_CLAIM in `text` is a claim about CI: not negated or deferred in its
 *  sentence, and not about a check run on this machine. */
function claimsCi(text) {
  return [...text.matchAll(CI_CLAIM)].some((m) => {
    const sentence = sentenceAt(text, m);
    if (CI_NEGATED.test(sentence) || LOCAL_BEFORE.test(text.slice(0, m.index))) return false;
    return NAMES_CI.test(sentence) || (!/^the build/i.test(m[0]) && !/\blocally\b/i.test(sentence));
  });
}
/** The sentence of `text` holding match `m`, cut at its sentence ends. */
function sentenceAt(text, m) {
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
  if (claimsCi(s)) kinds.push({ kind: 'ci-green', strength: 'flat', rule: 'brief.ci-claim' });
  return { kinds, admitsNoCheck: fl.admitsNoCheck };
}

/** The body of a recorded gh pr create command (lib/review/resolve.mjs reads it for the issue it closes). */
export { prBodyOf };

/** The pull request's files an edit step changed: every path a Codex patch names, or the one an
 *  Edit, Write or NotebookEdit call names. `files` is a set of repository-relative paths. */
export function prFilesOf(step, event, files) {
  const input = event?._raw?.input;
  const raw = step?.edit?.paths ?? [input?.file_path ?? input?.notebook_path ?? input?.filePath ?? input?.path];
  const out = [];
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const norm = p.replace(/\\/g, '/').toLowerCase();
    for (const f of files) if (!out.includes(f) && (norm === f.toLowerCase() || norm.endsWith(`/${f.toLowerCase()}`))) out.push(f);
  }
  return out;
}

const RISKY = /[;|<>`&]|\$\(|\brm\b|\bcurl\b|\bwget\b|\bgit\s+push\b|\bsudo\b/;
/** Tools that run whatever goal or script they're named with (make deploy, npm run publish). */
const GOAL_TOOLS = new Set(['make', 'mvn', 'gradle', 'gradlew', './gradlew', 'npm', 'pnpm', 'yarn', 'bun']);
const CHECK_GOAL = /^(?:test|tests|check|build|lint|typecheck|type-check|tsc|verify|validate|compile|ci|e2e|smoke)(?:[:-](?:unit|integration|e2e|ci|all|fast))?$/i;
/** For a goal tool, every goal it's given is a known check (test, build, lint and the like),
 *  ignoring flags and what follows `--`; other runners pass. */
function checkGoals(s) {
  const words = s.split(/\s+/);
  if (!GOAL_TOOLS.has(words[0].toLowerCase())) return true;
  const end = words.indexOf('--');
  const goals = words.slice(1, end === -1 ? words.length : end).filter((w) => !w.startsWith('-') && w !== 'run');
  return goals.length > 0 && goals.every((g) => CHECK_GOAL.test(g));
}
/** A check command a reviewer can run as it is: one recognized test, build, lint or type-check
 *  runner, after dropping a leading `cd <folder> &&` (the reviewer runs it in their own checkout
 *  at the head), with no other operator (a lone `&` included), redirect, deletion, download or
 *  push, and for make, Maven, Gradle or a package manager only known check goals. null otherwise. */
export function plainCheck(command) {
  const s = String(command ?? '').trim().replace(/^\s*(?:cd|pushd|set-location)\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*/i, '');
  if (!s || s.includes('\n') || RISKY.test(s)) return null;
  const chain = commandChain(s);
  if (chain.length !== 1) return null;
  const kind = checkClass(s);
  if (!kind || kind === 'run of code' || kind === 'request to a server' || !checkGoals(s)) return null;
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

  // Edits to the pull request's files, and commits, after each moment. An ambiguous edit counts
  // here too: it may be this pull request's, so a check before it may not hold.
  const prEdits = [];
  for (const [id, s] of ctx.steps) {
    if (!(inScope(id) || (scope.ambiguous.has(id) && working.has(s.session)))) continue;
    if (s.cat === 'edit' && s.result === 'ok' && prFilesOf(s, byId.get(s.ev), fileSet).length) prEdits.push(s);
  }
  prEdits.sort((a, b) => a.t - b.t);
  // Ambiguous edits, per session: one after the last in-scope edit is where a claim's check
  // has to come after, since it may be this pull request's last edit.
  const ambiguousEdits = new Map();
  for (const [id, s] of ctx.steps) if (scope.ambiguous.has(id) && working.has(s.session) && runnableEdit(s)) (ambiguousEdits.get(s.session) ?? ambiguousEdits.set(s.session, []).get(s.session)).push(s);
  // When each commit came: the step that made it when a log has it, since git's author date
  // survives a rebase or cherry-pick; else that author date.
  const madeRefs = (h._refIndex?.().commitRefs ?? []).filter((r) => r.via === 'harness-commit' || r.via === 'printed-output');
  const commitTimes = pr.commits.list.map((c) => {
    const made = madeRefs.filter((r) => sameCommit(r.sha, c.sha)).map((r) => r.event.t).filter(Number.isFinite);
    return { sha: c.sha, t: made.length ? Math.min(...made) : c.at ? Date.parse(c.at) : NaN, loggedBy: c.loggedBy ?? [] };
  }).filter((c) => Number.isFinite(c.t));

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
    const inScopeSteps = bySession.get(session) ?? [];
    const lastInScope = lastEditBefore(inScopeSteps, seq);
    const boundary = (ambiguousEdits.get(session) ?? []).filter((s) => s.seq < seq && (!lastInScope || s.seq > lastInScope.seq)).at(-1);
    // Only an in-scope check after the ambiguous edit backs the claim; the edit itself backs nothing.
    const steps = boundary ? [...inScopeSteps, boundary].sort((a, b) => a.seq - b.seq) : inScopeSteps;
    const after = boundary ?? lastInScope;
    const b = backingCheck(ctx, { steps, events: eventsBySession.get(session) ?? [], session, after, before: seq, folderOk });
    if (boundary && b.status !== 'checked' && b.status !== 'delegated') return { ...b, status: 'gap', gap: 'ambiguous-edit', event: boundary.ev, level: 'inferred', how: "The last edit before this claim sits between this pull request's work and another's, and no check ran after it." };
    return b.check ? { ...b, folder: where(b.check) } : b;
  };
  const ciBacking = (session, t) => {
    const read = (eventsBySession.get(session) ?? []).filter((e) => e.kind === 'action' && e.t <= t && !['rejected', 'refused'].includes(e.facts?.result) && simpleCommands(e._command).some((c) => CI_READ.test(c))).at(-1);
    if (!read) return { status: 'gap', gap: 'no-ci-read', level: 'inferred', how: 'No step before this claim read CI (gh pr checks, gh run watch or view).' };
    // A change pushed after the read: CI then ran on a commit the read never saw.
    const changed = prEdits.some((s) => s.session === session && s.t > read.t && s.t <= t) || (eventsBySession.get(session) ?? []).some((e) => e.kind === 'action' && e.t > read.t && e.t <= t && simpleCommands(e._command).some((c) => /^git\s+(?:-C\s+\S+\s+)?(?:push|commit)\b/.test(c)));
    if (changed) return { status: 'gap', gap: 'ci-read-stale', event: read.id, level: 'inferred', how: 'A step read CI before this claim, but an edit, commit or push came after that read.' };
    if (read.facts?.result === 'error') return { status: 'ci-read', event: read.id, failed: true, level: 'inferred', how: 'The last step that read CI before this claim ended in an error, which gh gives when checks fail or are still running.' };
    if (read.facts?.result === 'interrupted') return { status: 'ci-read', event: read.id, failed: true, level: 'inferred', how: 'The last step that read CI before this claim was stopped before it finished.' };
    return { status: 'ci-read', event: read.id, level: 'inferred', how: "A step read CI before this claim. What it printed isn't checked against the claim yet." };
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
