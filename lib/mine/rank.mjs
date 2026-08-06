// lib/mine/rank.mjs — ranking candidate findings by publishability.
//
// The detector answers "was a third-party problem solved here". This module answers
// the harder question: "would publishing it be worth anyone's time".
//
// EVERY SIGNAL IS LABELLED, AND THE LABELS ARE NOT DECORATION
// ----------------------------------------------------------------------------
// A score built from measurements and guesses, reported as one number, is a lie by
// omission — the reader cannot tell which part is evidence. So each component
// carries a `basis`:
//
//   measured  — read straight out of the log. Recount it and you get the same
//               number. No judgement was applied.
//   proxy     — a measurable stand-in for something NOT in the log. The measurement
//               is real; the inference from it is a bet, and `proxyFor` names what
//               is actually being guessed at.
//   unknown   — not derivable from a session log at any effort. Scored zero and
//               listed anyway, so it can never be quietly counted as satisfied.
//
// WHAT IS GENUINELY UNKNOWABLE HERE
// ----------------------------------------------------------------------------
//   Search demand.   Whether anyone searches this error is a fact about the world.
//                    A session log cannot contain it. Only an analytics or
//                    keyword tool can, and this module refuses to pretend otherwise.
//   Still true.      Whether the fix still works today depends on the CURRENT build
//                    of software that keeps shipping. The log records what was true
//                    the day it was written. Only re-running the checks can say, so
//                    `stillTrue` is scored 0 and the drafter turns it into required
//                    verification work rather than a claim.
//
// Zero runtime dependencies: Node built-ins only.

/** A primary error string this weak is not worth leading a post with. `{"error":
 *  "not found"}` clears every other gate and is useless to a stranger: it identifies
 *  no product and matches nothing when pasted into a search box. */
export const MIN_PRIMARY_QUOTABILITY = 2;

/** A verbatim string a stranger could paste into a search box scores highest when it
 *  looks like PROGRAM OUTPUT rather than someone's description of program output. */
export function quotability(s) {
  if (typeof s !== 'string' || s.length < 16) return 0;
  let score = 0;
  // Case-insensitive on purpose: the wild spells it `Errno`, `errno` and `ERRNO`, and
  // a case-sensitive test scored `[Errno 10048] error while attempting to bind…` at 1
  // — one of the most searchable strings in the whole corpus.
  if (/\b(?:0x[0-9A-Fa-f]{6,8}|HRESULT|errno|winerror|code[:\s]-?\d{3,}|\b-\d{5}\b)/i.test(s)) score += 3;
  // The shape a program uses to announce a failure. Worth as much as a code: a plain
  // "Error capturing screenshot: ..." is exactly what a stranger pastes into a search
  // box, and scoring it zero excluded a session already known to have made a post.
  // A leading bracketed code counts as part of the announcement.
  if (/^(?:\[[^\]]{1,30}\]\s*)?(?:\w*Error\b|Error[: ]|Failed to\b|Cannot\b|Could not\b|Unable to\b|\w+Exception\b|\w+Warning\b|FATAL\b|\[?BUG\]?)/i.test(s.trim())) score += 3;
  // A searchable error names A THING and says WHAT WENT WRONG with it. Scoring only
  // the leading announcement missed every message that does not open with "Error:" —
  // including "VM service not running. The service failed to start.", the exact string
  // behind the most-read page this tool exists to reproduce.
  //
  // The word count is what keeps this from rewarding everything: `{"error":"not
  // found"}` contains a failure predicate too, and is useless to a stranger precisely
  // because it names no subject.
  const words = s.trim().split(/\s+/).length;
  const predicate = /\b(?:not running|not found|failed to|did not|cannot|can't|unable to|denied|refused|timed? out|does not exist|is not|no such|already in use|not permitted|not supported)\b/i;
  if (words >= 5 && predicate.test(s)) score += 2;

  if (/^[A-Z][^.!?]*$/.test(s.trim())) score += 1; // one clause, no sentence punctuation
  if (/["'`]/.test(s)) score += 1; // quotes a literal the product printed
  if (/\b(?:service|daemon|driver|module|handler|provider|runtime|codec|socket)\b/i.test(s)) score += 1;
  if (s.length > 140) score -= 1; // too long to be pasted whole
  // Prose-about-an-error runs on. A real message is often TWO sentences —
  // "VM service not running. The service failed to start." is the exact text behind
  // the highest-traffic post this tool was built to reproduce, and a flat two-point
  // penalty for a second sentence scored it zero. Only a third sentence, or real
  // length, indicates someone describing a failure rather than a program reporting it.
  const sentences = (s.match(/\.\s+[A-Z]/g) ?? []).length;
  if (sentences >= 2 || (sentences >= 1 && s.length > 110)) score -= 2;
  return Math.max(0, score);
}

/** Pick the single best string to lead a draft with, plus the rest as alternates. */
export function primaryError(errorStrings) {
  const ranked = [...(errorStrings || [])].map((s) => ({ s, q: quotability(s) })).sort((a, b) => b.q - a.q || a.s.length - b.s.length);
  return {
    primary: ranked[0]?.s ?? null,
    primaryQuotability: ranked[0]?.q ?? 0,
    // Alternates must clear the SAME bar as the primary. Letting weak lines through
    // "for context" filled drafts with a GitHub label row, a diff hunk and a JSON
    // blob, all presented under a heading that implies they are evidence.
    alternates: ranked.slice(1).filter((r) => r.q >= MIN_PRIMARY_QUOTABILITY).slice(0, 4).map((r) => r.s),
  };
}

/**
 * scoreFinding(finding, { publishedErrorStrings }) -> ranked finding
 *
 * `publishedErrorStrings` is the destination's already-covered ground, supplied by
 * the caller. It is a hard gate rather than a score component: re-publishing a
 * problem you already wrote up competes with your own page.
 */
export function scoreFinding(finding, { publishedErrorStrings = [] } = {}) {
  const ev = finding.evidence || {};
  const { primary, primaryQuotability, alternates } = primaryError(finding.errorStrings);

  const components = [];
  const add = (name, basis, points, detail, extra = {}) => components.push({ name, basis, points, detail, ...extra });

  // --- measured ---------------------------------------------------------------
  add(
    'quotable-error',
    'measured',
    Math.min(6, primaryQuotability * 2),
    primary ? `best string scores ${primaryQuotability} on program-output shape` : 'no quotable string',
  );
  add('named-product', 'measured', finding.products?.length ? 3 : 0, finding.products?.map((p) => p.name).join(', ') || 'none identified');
  add('version-pinned', 'measured', finding.versions?.length ? 2 : 0, finding.versions?.slice(0, 3).join(', ') || 'no version observed');
  add(
    'external-issue',
    'measured',
    Math.min(3, (ev.externalIssues?.length ?? 0)),
    ev.externalIssues?.length ? `${ev.externalIssues.length} issue(s) on other people's repos` : 'none',
  );
  add(
    'resolution-strength',
    'measured',
    finding.resolution?.some((r) => r.strength === 'strong') ? 4 : finding.resolution?.length ? 2 : 0,
    finding.resolution?.map((r) => r.kind).join(', ') || 'none',
  );
  // An explicit human "this is worth a post" is the closest thing to ground truth
  // here. Weighted at 4 rather than the 8 first tried: across this corpus the phrase
  // fired on a large share of candidates, because someone who writes about their
  // tooling mentions posts constantly. Real signal, weak discrimination.
  add('human-publish-intent', 'measured', finding.publishIntent?.length ? 4 : 0, finding.publishIntent?.[0]?.slice(0, 120) || 'not stated');

  // --- proxies ----------------------------------------------------------------
  add(
    'research-depth',
    'proxy',
    Math.min(4, Math.floor((ev.searchAttempts ?? 0) / 2)),
    `${ev.searchAttempts ?? 0} web searches during the session`,
    { proxyFor: 'the fix was not already written down somewhere findable' },
  );
  add(
    'diagnosis-breadth',
    'proxy',
    Math.min(3, (ev.diagnosisKinds?.length ?? 0) + (ev.probeKinds?.length ?? 0)),
    [...(ev.diagnosisKinds ?? []), ...(ev.probeKinds ?? [])].join(', ') || 'none',
    { proxyFor: 'the root cause was non-obvious' },
  );
  add('effort', 'proxy', Math.min(2, Math.floor((ev.humanTurns ?? 0) / 8)), `${ev.humanTurns ?? 0} human turns`, {
    proxyFor: 'the problem resisted a first attempt',
  });

  // --- unknown ----------------------------------------------------------------
  add('search-demand', 'unknown', 0, 'not derivable from a session log; needs analytics or a keyword tool', {
    proxyFor: 'whether anyone actually searches for this',
  });
  add('still-true', 'unknown', 0, 'not derivable from a session log; the drafter requires a re-verification pass', {
    proxyFor: 'whether the fix still works on the current build',
  });

  const score = components.reduce((s, c) => s + c.points, 0);
  const measuredScore = components.filter((c) => c.basis === 'measured').reduce((s, c) => s + c.points, 0);

  // Already-covered gate: normalized substring match against the destination's
  // existing posts. Deliberately generous — a near-match is still competing ground.
  const norm = (s) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const covered = (finding.errorStrings || []).find((e) => publishedErrorStrings.some((p) => norm(p).includes(norm(e)) || norm(e).includes(norm(p))));

  return {
    ...finding,
    primaryError: primary,
    alternateErrors: alternates,
    score,
    measuredScore,
    scoreComponents: components,
    alreadyCovered: covered ? { matched: covered } : null,
  };
}

/** The identity of a PROBLEM, as opposed to the identity of a session. Two sessions
 *  that hit the same failure on different days are one finding — without this, the
 *  same error is drafted twice and the backlog reads as two open items when the world
 *  contains one. Numbers and quoting are normalized away so near-misses collapse. */
export function findingKey(finding) {
  const e = finding.primaryError ?? finding.errorStrings?.[0] ?? '';
  return String(e)
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Collapse findings that are about the same problem, keeping the best-scoring one
 *  and recording how many sessions hit it — a repeat is evidence of durability, not
 *  a reason to draft twice. */
export function dedupeFindings(ranked) {
  const byKey = new Map();
  for (const f of ranked) {
    const k = findingKey(f);
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...f, findingKey: k, sessionCount: 1, sessionKeys: [f.sessionKey] });
    else {
      prev.sessionCount += 1;
      prev.sessionKeys.push(f.sessionKey);
      if (f.score > prev.score) Object.assign(prev, f, { findingKey: k, sessionCount: prev.sessionCount, sessionKeys: prev.sessionKeys });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (Boolean(a.alreadyCovered) !== Boolean(b.alreadyCovered)) return a.alreadyCovered ? 1 : -1;
    return b.score - a.score || String(b.startedAt).localeCompare(String(a.startedAt));
  });
}

/**
 * rankFindings(findings, opts) -> ranked, highest first.
 *
 * Findings already covered by the destination are kept in the list, not dropped —
 * a caller that silently discarded them would report a smaller candidate pool than
 * it actually found, which is the counting error this whole tool exists to avoid.
 * They sort last and are excluded from `publishable`.
 */
export function rankFindings(findings, opts = {}) {
  const scored = findings.map((f) => scoreFinding(f, opts));
  return dedupeFindings(scored);
}

/** The bar a finding must clear to be worth a human's attention. Set by running the
 *  detector across the full local corpus and reading the output (1,893 sessions, 40
 *  candidates, 7 cleared) rather than chosen a priori — see "Where the score bar came
 *  from" in docs/mining.md. Policy, not physics; --threshold moves it. */
export const PUBLISHABLE_THRESHOLD = 20;

export function publishable(ranked, threshold = PUBLISHABLE_THRESHOLD) {
  return ranked.filter((f) => !f.alreadyCovered && f.score >= threshold && quotability(f.primaryError) >= MIN_PRIMARY_QUOTABILITY);
}
