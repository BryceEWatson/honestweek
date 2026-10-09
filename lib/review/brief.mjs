// lib/review/brief.mjs: everything the brief says about one pull request, gathered from what
// resolvePr found, the steps scopeSteps kept, the claims pairClaims paired, and the Problems
// checks' cached run. It gives no verdict and runs nothing: each row is a fact, how it's known,
// and where to look. Text copied from a log or git comes back as { quoted } with control
// characters taken out, after the build's redactor; nothing is paraphrased. lib/ask-brief.mjs
// shapes it as text or the honestweek.brief/1 JSON.

import { commitMessage, diffText } from '../git.mjs';
import { createContext } from '../problems/context.mjs';
import { REVIEW_PATTERNS } from '../problems/index.mjs';
import { outputOf } from '../replay/record-output.mjs';
import { simpleCommands } from '../replay/classify.mjs';
import { sameCommit } from '../replay/lookup.mjs';
import { pairClaims } from './claims.mjs';
import { describeBriefRules } from './rules.mjs';

/** The groups whose findings a reviewer is shown; the rest are counted as left out. */
const REVIEW_GROUPS = new Set(['correctness-honesty', 'safety', 'process']);
/** The most bytes of test-file diff read to count assertions and skips. */
const TEST_DIFF_BYTES = 512 * 1024;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]*\.py$/i;
const ASSERT_LINE = /\b(?:assert(?:\.\w+)?|expect|should)\s*\(|\bassert\s+\w|\.should\./;
const SKIP_LINE = /\b(?:it|test|describe)\.(?:skip|todo)\b|\b(?:xit|xdescribe|xtest)\s*\(|\{\s*skip\s*:|\btest\.skip\b|@pytest\.mark\.skip|\bt\.Skip\(|\.only\s*\(/;
const NO_VERIFY = /^git\s+(?:-C\s+\S+\s+)?commit\b.*(?:\s--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)|\bcore\.hooksPath=\s*(?:\s|$|['"]{2})/;
const FORCE_PUSH = /^git\s+(?:-C\s+\S+\s+)?push\b.*(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+[^\s]+)/;
const GH_ISSUE_VIEW = /^gh\s+issue\s+view\s+#?(\d+)\b/;

/** What this brief can't know, always printed. */
export const CANT_KNOW = Object.freeze([
  { kind: 'ci-and-github-reviews', text: "CI results and GitHub reviews: honestweek reads nothing over the network, so it shows only what a session's own output printed." },
  { kind: 'outside-the-logs', text: "Work outside these logs: a person's own edits, a session on another machine, or one whose log was deleted and not saved." },
  { kind: 'codex-hooks', text: "Codex hooks: Codex runs hooks without recording them, so a check a Codex hook ran can't be seen." },
  { kind: 'files-changed-outside', text: "Files changed outside the logs (by a shell command, an editor, or git itself) look the same as no change, so a check called current may not be." },
  { kind: 'check-precision', text: "How often each check is right hasn't been measured yet (issue 148), so a finding is something to look at, not a fact about the work." },
]);

/** Text from a log or git as the brief carries it: redacted, control characters out. */
export function quoter(redact) {
  return (text, max = 4000) => {
    if (text == null) return null;
    let s = redact(String(text)).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f​-‏‪-‮⁦-⁩]/g, '');
    if (s.length > max) s = `${s.slice(0, max)}…`;
    return { quoted: s };
  };
}

/**
 * buildBrief({ h, config, pr, scope, checked, redact, repoPath, git, evidenceOnly, ctx }) -> the brief.
 *
 * h: the redacted build's history (keepRaw). pr, scope: resolvePr's and scopeSteps's answers.
 * checked: the Problems checks' result for h (runProblems), or null when they couldn't run.
 * redact: the build's redactor. repoPath: the repository's folder (null for display-only or no
 * git). evidenceOnly: leave the author's own words out (claims, the pull request's body).
 */
export function buildBrief({ h, config, pr, scope, checked = null, redact = (s) => s, repoPath = null, git = true, evidenceOnly = false, ctx = null }) {
  const q = quoter(redact);
  const gitOk = git && !!repoPath && !pr.display;
  const c = ctx ?? createContext(h, { builtT: Date.now() });
  const byId = new Map(h.events.map((e) => [e.id, e]));
  // A session that only looked the pull request up asked nothing of it and did no work on it.
  const lookedUp = new Set(scope.sessions.filter((s) => s.role === 'mentioned').map((s) => s.key));
  const inScope = (id) => scope.inScope.has(id) && !lookedUp.has(byId.get(id)?.session);
  const rules = new Set();
  const named = (rule) => {
    if (rule) for (const r of String(rule).split(/,\s*|\s\|\s/)) if (r.startsWith('brief.')) rules.add(r);
    return rule;
  };
  const printed = (e) => {
    if (!e?.end?.ref) return null;
    try {
      return outputOf(h.record(e.end.ref)[0]?.record) ?? null;
    } catch {
      return null;
    }
  };

  // ---- the change -------------------------------------------------------------------------
  for (const x of [pr.head, pr.base, pr.branch, ...pr.branch.sources, ...pr.commits.list, ...pr.issues.closes, ...pr.issues.related]) named(x?.rule);
  const change = {
    number: pr.number,
    repo: pr.repo,
    landed: pr.landed ? { sha: pr.landed.sha, kind: pr.landed.kind, at: pr.landed.at, evidence: 'recorded', subject: q(pr.landed.subject, 300) } : null,
    head: pr.head,
    base: pr.base,
    branch: { name: pr.branch.name, evidence: pr.branch.evidence, ambiguous: pr.branch.ambiguous, sources: pr.branch.sources.map((s) => ({ name: s.name, via: s.via, evidence: s.evidence, rule: s.rule ?? null, event: s.event ?? null })) },
    commits: { count: pr.commits.list.length, truncated: pr.commits.truncated, evidence: pr.commits.evidence, list: pr.commits.list.map((x) => ({ sha: x.sha, subject: q(x.subject, 300), at: x.at ?? null, evidence: x.evidence, via: x.via, rule: x.rule ?? null, inGit: x.inGit, loggedBy: x.loggedBy ?? [] })) },
    files: { count: pr.files.list.length, evidence: pr.files.evidence, list: pr.files.list },
    headCheck: pr.headCheck,
  };

  // ---- what was asked ----------------------------------------------------------------------
  // The closed issue's text, when a session in this repository printed it with gh issue view.
  const issueText = new Map();
  for (const e of h.events) {
    if (e.kind !== 'action' || h._sessionRepo(e.session) !== pr.repo.label) continue;
    for (const cmd of simpleCommands(e._command)) {
      const m = cmd.match(GH_ISSUE_VIEW);
      if (!m || issueText.has(Number(m[1])) || !pr.issues.closes.some((x) => x.number === Number(m[1]))) continue;
      const out = printed(e);
      if (out && e.facts?.result !== 'error') issueText.set(Number(m[1]), { text: out, event: e.id, session: e.session });
    }
  }
  const prompts = [];
  for (const e of h.events) {
    if (e.kind !== 'prompt' || e.actor !== 'person' || !inScope(e.id)) continue;
    prompts.push({ event: e.id, session: e.session, at: e.at ?? null, evidence: 'recorded', text: q(e._raw?.text ?? e.facts?.text, 2000), correction: (e.inferred ?? []).some((x) => x.rule === 'prompt.correction') });
  }
  const asked = {
    issues: pr.issues.closes.map((x) => {
      const t = issueText.get(x.number);
      if (t) rules.add('brief.issue-printed');
      return { number: x.number, evidence: x.evidence, rule: x.rule ?? null, via: x.via, text: t ? q(t.text, 3000) : null, textEvidence: t ? 'inferred' : 'missing', textRule: t ? 'brief.issue-printed' : null, printedBy: t ? { session: t.session, event: t.event } : null };
    }),
    related: pr.issues.related.map((x) => ({ number: x.number, evidence: x.evidence, rule: x.rule, via: x.sources[0]?.via ?? null })),
    prompts,
  };

  // ---- sessions behind it --------------------------------------------------------------------
  const sessionTitle = new Map(h.sessions.map((s) => [s.key, s.title ?? null]));
  const sessions = scope.sessions.map((s) => {
    named(s.roleRule);
    const otherPrs = s.lanes.map((l) => l.lane.match(/^pull request #(\d+)$/)?.[1]).filter(Boolean).map(Number);
    const info = h.sessions.find((x) => x.key === s.key);
    return { session: s.key, thread: info?.thread ?? null, title: q(sessionTitle.get(s.key), 200), tool: info?.tool ?? null, role: s.role, roleEvidence: s.roleEvidence, roleRule: s.roleRule, steps: s.steps, inScope: s.in, ambiguous: s.ambiguous, excluded: s.excluded, otherPrs, lanes: s.lanes, saved: s.saved, launchedBy: s.launchedBy };
  });

  // ---- checks and claims ---------------------------------------------------------------------
  const commitMessages = gitOk ? pr.commits.list.filter((x) => x.inGit).slice(0, 50).map((x) => ({ sha: x.sha, text: commitMessage(repoPath, x.sha) ?? '' })) : [];
  const paired = pairClaims({ h, ctx: c, pr, scope, commitMessages });
  const checks = paired.checks.map((x) => {
    named(x.currency.rule);
    return { event: x.event, session: x.session, at: x.at, kind: x.kind, command: q(x.command, 400), result: x.result, tests: x.passedTests != null ? { passed: x.passedTests, failed: x.failedTests } : null, evidence: x.evidence, rule: x.rule, folder: x.folder, currency: x.currency };
  });
  const claims = evidenceOnly ? null : paired.claims.map((x) => {
    named(x.rule);
    if (x.ambiguous) rules.add('brief.boundary');
    const b = x.backing;
    return {
      event: x.event,
      sha: x.sha ?? null,
      session: x.session,
      at: x.at,
      source: x.source,
      kind: x.kind,
      strength: x.strength,
      rule: x.rule,
      text: q(x.text, 1200),
      ambiguous: x.ambiguous,
      backing: { status: b.status, gap: b.gap ?? null, check: b.check?.ev ?? b.event ?? null, result: b.result ?? null, failed: b.failed ?? null, level: b.level, how: b.how },
      evidence: b.status === 'checked' && b.failed !== true ? 'inferred' : b.level === 'missing' ? 'missing' : 'inferred',
    };
  });
  const rerun = paired.rerun.map((x) => ({ command: q(x.command, 300), event: x.event, kind: x.kind }));
  const readFirst = paired.readFirst.map((x) => ({ command: q(x.command, 300), event: x.event, kind: x.kind }));

  // ---- tests and hooks -----------------------------------------------------------------------
  const testFiles = pr.files.list.filter((f) => TEST_FILE.test(f.path));
  let assertions = null;
  let skips = null;
  let diffCut = false;
  if (gitOk && testFiles.length && pr.base.sha && (pr.landed?.kind === 'squash' ? pr.landed.sha : pr.head.sha)) {
    const to = pr.landed?.kind === 'squash' ? pr.landed.sha : pr.head.sha;
    const from = pr.landed?.kind === 'squash' ? pr.landed.parents[0] : pr.base.sha;
    const d = diffText(repoPath, from, to, testFiles.map((f) => f.path), { maxBytes: TEST_DIFF_BYTES });
    if (d) {
      assertions = { added: 0, removed: 0 };
      skips = { added: 0, removed: 0 };
      diffCut = d.truncated;
      for (const line of d.text.split('\n')) {
        if (/^(\+\+\+|---)/.test(line)) continue;
        const sign = line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : null;
        if (!sign) continue;
        if (ASSERT_LINE.test(line)) assertions[sign]++;
        if (SKIP_LINE.test(line)) skips[sign]++;
      }
    }
  }
  const commandSteps = (re) => h.events.filter((e) => inScope(e.id) && e.kind === 'action' && !['rejected', 'refused'].includes(e.facts?.result) && simpleCommands(e._command).some((x) => re.test(x))).map((e) => ({ event: e.id, session: e.session, at: e.at ?? null, evidence: 'recorded', command: q(e._command, 300) }));
  const findingsOf = (id) => (checked?.patterns ?? []).find((p) => p.id === id)?.findings ?? [];
  const inScopeFinding = (f) => inScope(f.event) || scope.ambiguous.has(f.event);
  // A finding's other step (the failed run before a commit, say) can be another pull request's
  // work: it says so, rather than the brief reading the whole finding as this one's.
  const findingOut = (f) => ({ pattern: f.pattern, severity: f.severity, evidence: f.verdictEvidence, rule: f.rule ?? null, session: f.session, event: f.event, at: f.at ?? null, note: f.note ?? null, ambiguous: scope.ambiguous.has(f.event), related: f.related ? { event: f.related, label: f.relatedLabel ?? null, inScope: inScope(f.related), lane: inScope(f.related) ? null : scope.laneOf(f.related) } : null });
  const tests = {
    tampering: findingsOf('test-tampering').filter(inScopeFinding).map(findingOut),
    files: testFiles.map((f) => ({ path: f.path, status: f.status, evidence: pr.files.evidence })),
    assertions,
    skips,
    diffEvidence: assertions ? 'derived' : 'missing',
    diffCut,
    noVerify: commandSteps(NO_VERIFY),
    forcePush: commandSteps(FORCE_PUSH),
  };

  // ---- other problems ------------------------------------------------------------------------
  const scopedSessions = new Set(scope.sessions.map((s) => s.key));
  const listed = [];
  const leftOut = { otherWork: 0, cost: 0, notes: 0, otherPatterns: 0, list: [] };
  const shownElsewhere = new Set(['test-tampering']);
  for (const p of checked?.patterns ?? []) {
    for (const f of p.findings ?? []) {
      if (!scopedSessions.has(f.session)) continue;
      const why = !inScopeFinding(f) ? 'otherWork' : p.group === 'efficiency-cost' ? 'cost' : f.severity !== 'look' ? 'notes' : !REVIEW_PATTERNS.includes(p.id) || !REVIEW_GROUPS.has(p.group) ? 'otherPatterns' : null;
      if (why) {
        leftOut[why]++;
        leftOut.list.push({ ...findingOut(f), name: p.name ?? p.id, why, lane: why === 'otherWork' ? scope.laneOf(f.event) ?? "not this pull request's work" : null });
      } else if (!shownElsewhere.has(p.id)) listed.push({ ...findingOut(f), name: p.name ?? p.id });
    }
  }
  const problems = { ran: !!checked, listed, leftOut };

  // ---- where the person stepped in -----------------------------------------------------------
  const steppedIn = [];
  for (const e of h.events) {
    if (!inScope(e.id) && !scope.ambiguous.has(e.id)) continue;
    if (e.kind === 'prompt' && e.actor === 'person' && (e.inferred ?? []).some((x) => x.rule === 'prompt.correction')) steppedIn.push({ kind: 'correction', event: e.id, session: e.session, at: e.at ?? null, evidence: 'inferred', rule: 'prompt.correction', text: q(e._raw?.text ?? e.facts?.text, 600) });
    else if (e.kind === 'action' && e.facts?.result === 'rejected') steppedIn.push({ kind: 'rejected', event: e.id, session: e.session, at: e.at ?? null, evidence: 'recorded', text: q(e._command ?? e.facts?.tool, 300) });
    else if (e.kind === 'guard') steppedIn.push({ kind: 'refused', event: e.id, session: e.session, at: e.at ?? null, evidence: 'recorded', text: q(e.facts?.reason ?? e.facts?.hook ?? e.facts?.rule, 300) });
    else if (e.kind === 'interrupt') steppedIn.push({ kind: 'interrupted', event: e.id, session: e.session, at: e.at ?? null, evidence: 'recorded', text: null });
  }

  // ---- changes no session explains ----------------------------------------------------------
  const printedIds = (pr.events?.printed ?? []).map((x) => x.id);
  const unexplainedCommits = pr.commits.list.filter((x) => !(x.loggedBy ?? []).length && !printedIds.some((p) => sameCommit(p, x.sha))).map((x) => ({ sha: x.sha, subject: q(x.subject, 300), evidence: 'missing' }));
  const editedFiles = new Set();
  for (const [id, s] of c.steps) {
    if (!inScope(id) || s.cat !== 'edit' || s.result !== 'ok') continue;
    const raw = byId.get(id)?._raw?.input?.file_path ?? byId.get(id)?._raw?.input?.path;
    if (typeof raw !== 'string') continue;
    const norm = raw.replace(/\\/g, '/').toLowerCase();
    for (const f of pr.files.list) if (norm.endsWith(`/${f.path.toLowerCase()}`) || norm === f.path.toLowerCase()) editedFiles.add(f.path);
  }
  const unexplained = {
    commits: unexplainedCommits,
    files: pr.files.list.filter((f) => !editedFiles.has(f.path)).map((f) => ({ path: f.path, status: f.status, evidence: 'missing' })),
    note: 'A file a shell command, a program or a person changed looks the same as one nobody explains: the logs record only the edit tools.',
  };

  for (const s of scope.why.values()) named(s.rule);
  return {
    change,
    asked,
    sessions,
    checks,
    rerun,
    readFirst,
    claims,
    evidenceOnly,
    tests,
    problems,
    steppedIn,
    unexplained,
    cantKnow: [...CANT_KNOW, ...(scope.notes ?? []), ...pr.notes.filter((n) => n.kind !== 'head-differs')],
    notes: pr.notes.filter((n) => n.kind === 'head-differs'),
    rules: describeBriefRules([...rules]),
  };
}
