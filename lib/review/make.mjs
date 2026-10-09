// lib/review/make.mjs: one pull request's brief, from a query to the honestweek.brief/1 answer.
//
// It finds the pull request (resolve.mjs), keeps its steps (scope.mjs), gathers the brief
// (brief.mjs), then puts every string through the build's redactor once more, except an id, a
// commit id, a time or a date under the key that names one, and gives every list its total.
// The view data layer's /api/brief route and `honestweek brief` both answer from here, on the
// redacted build only.

import { resolvePr } from './resolve.mjs';
import { scopeSteps } from './scope.mjs';
import { buildBrief } from './brief.mjs';

/** The JSON's schema name: a change to its shape that breaks a reader takes a new number. */
export const BRIEF_SCHEMA = 'honestweek.brief/1';
/** What the brief is, in honestweek's own words, at the top of every answer. */
export const NOT_A_VERDICT = "This is the record of how the change was made, for whoever reviews it. It isn't a review and gives no verdict: check each row yourself.";

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,200}$/;
const SHA_SHAPE = /^[0-9a-f]{7,64}$/;
const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA_KEYS = new Set(['sha', 'given', 'derived', 'head', 'base']);
const ID_KEYS = new Set(['session', 'event', 'check', 'events', 'sessions', 'printedBy', 'from']);
const TIME_KEYS = new Set(['at']);
const WORD_KEYS = new Set(['status', 'gap', 'evidence', 'level', 'kind', 'strength', 'source', 'via', 'role', 'roleEvidence', 'roleRule', 'rule', 'textRule', 'textEvidence', 'state', 'why', 'folder', 'result', 'severity', 'pattern', 'diffEvidence', 'chosenBy']);

/** Every string through `redact`, except the shapes under the keys that name them. */
export function redactBrief(value, redact, key = null, depth = 0) {
  if (depth > 40) return null;
  if (typeof value === 'string') {
    if (SHA_KEYS.has(key) && SHA_SHAPE.test(value)) return value;
    if (ID_KEYS.has(key) && ID_SHAPE.test(value)) return value;
    if (TIME_KEYS.has(key) && TIME_SHAPE.test(value)) return value;
    if (WORD_KEYS.has(key) && /^[a-z][a-z0-9.,:\s-]{0,120}$/.test(value)) return value;
    return redact(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactBrief(v, redact, key, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactBrief(v, redact, k, depth + 1);
    return out;
  }
  return value;
}

const listed = (items) => ({ total: items.length, items });

/**
 * makeBrief({ h, config, query, head, base, issue, repo, landedIn, evidenceOnly, checked, redact, git })
 *   -> the brief's answer: { pr, change, asked, sessions, checks, rerun, readFirst, claims,
 *      tests, problems, steppedIn, unexplained, cantKnow, notes, rules, earliestCommitAt }
 * Throws BriefError (lib/review/resolve.mjs) when the query or an option can't be read.
 */
export function makeBrief({ h, config, query, head = null, base = null, issue = null, repo = null, landedIn = null, evidenceOnly = false, checked = null, redact = (s) => s, git = true }) {
  const pr = resolvePr({ h, config, query, head, base, issue, repo, landedIn, git });
  const repoCfg = (config.repos ?? []).find((r) => r.label === pr.repo.label);
  const repoPath = pr.display || !git ? null : repoCfg?.resolvedPath ?? repoCfg?.path ?? null;
  const scope = scopeSteps({ h, pr, repoPath, git });
  const b = buildBrief({ h, config, pr, scope, checked, redact, repoPath, git, evidenceOnly });
  const { list: commitList, ...commits } = b.change.commits;
  const { list: fileList, ...files } = b.change.files;
  const { list: leftOutList, ...leftOut } = b.problems.leftOut;
  const times = commitList.map((c) => Date.parse(c.at ?? '')).filter(Number.isFinite);
  const answer = {
    pr: { number: pr.number, repo: pr.repo, display: pr.display },
    change: { ...b.change, commits: { ...commits, ...listed(commitList) }, files: { ...files, ...listed(fileList) } },
    asked: { issues: listed(b.asked.issues), related: listed(b.asked.related), prompts: listed(b.asked.prompts) },
    sessions: listed(b.sessions),
    checks: listed(b.checks),
    rerun: listed(b.rerun),
    readFirst: listed(b.readFirst),
    claims: b.claims ? listed(b.claims) : null,
    evidenceOnly: b.evidenceOnly,
    tests: { ...b.tests, tampering: listed(b.tests.tampering), files: listed(b.tests.files), noVerify: listed(b.tests.noVerify), forcePush: listed(b.tests.forcePush) },
    problems: { ran: b.problems.ran, listed: listed(b.problems.listed), leftOut: { ...leftOut, ...listed(leftOutList) } },
    steppedIn: listed(b.steppedIn),
    unexplained: { commits: listed(b.unexplained.commits), files: listed(b.unexplained.files), note: b.unexplained.note },
    cantKnow: listed(b.cantKnow.map((x) => ({ kind: x.kind, text: x.text }))),
    notes: listed(b.notes.map((x) => ({ kind: x.kind, text: x.text }))),
    rules: b.rules,
    earliestCommitAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
  };
  return redactBrief(answer, redact);
}
