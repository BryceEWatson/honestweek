// lib/replay/outcomes.mjs — what git itself recorded about the commits and pull
// requests a session mentions.
//
// A session log can say "committed abc1234" or "created pull request 64". That is
// the harness's record of a command, not proof of an outcome. This module asks the
// configured repository: does the commit exist, was it authored by a configured
// identity, did it reach the default branch, and did a commit for that pull request
// land there (and when, by git's own clock). Only featured and reference repos are
// read; a display-role or private session is never passed to git. Every git call
// goes through lib/git.mjs.

import { commitReachableFrom, defaultBranchRefs, landedCommitsInWindow, lookupCommit, originSlug } from '../git.mjs';
import { EVIDENCE } from './evidence.mjs';
import { sourceKey } from './ids.mjs';

/** The rule that tied a nomination to its session, when it was an inference. */
function attribution(nomination) {
  return nomination.evidence === EVIDENCE.INFERRED ? [{ key: 'sessionAttribution', value: nomination.event.id, rule: nomination.rule }] : [];
}

/** Git prints strict ISO times with an offset whose spelling differs across versions
 *  ("Z" or "+00:00"); the history spells every instant one way. */
const iso = (s) => {
  const t = Date.parse(s ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** One commit or pull request named by several events: the harness's own record wins
 *  over an inference from printed output, then the earliest event, then the id. */
function strongestFirst(a, b) {
  const ra = a.evidence === EVIDENCE.RECORDED ? 0 : 1;
  const rb = b.evidence === EVIDENCE.RECORDED ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.event.t !== b.event.t) return a.event.t - b.event.t;
  return a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0;
}

/**
 * gitOutcomes({ config, sessionsByKey, commits, prs, redact }) -> { events, sources, notes }
 *
 * `commits` and `prs` are the nominations the adapters collected, each naming its
 * event, how it was known (recorded by the harness, or inferred from printed output),
 * and the rule when inferred. Facts on an outcome event are git's own record; how the
 * outcome hangs from its session is kept apart in `inferred`. Nothing here claims a
 * session's commit IS the commit that landed unless git says it is reachable from the
 * default branch. A repository git cannot read says so; it never reads as "no such
 * commit" or "not landed".
 */
export function gitOutcomes({ config, sessionsByKey, commits, prs, redact }) {
  const events = [];
  const notes = [];
  const sources = new Map();
  const perRepo = new Map();
  const repoState = (repo) => {
    if (perRepo.has(repo.label)) return perRepo.get(repo.label);
    const path = repo.resolvedPath ?? repo.path;
    let refs = [];
    let landed = null;
    let slug = null;
    try {
      refs = defaultBranchRefs(path);
      landed = landedCommitsInWindow(path, config.identity.authorEmails, '1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z');
      slug = originSlug(path);
    } catch {
      refs = [];
    }
    const bySha = new Map();
    const byPr = new Map();
    for (const c of landed?.commits ?? []) {
      bySha.set(c.sha, c);
      if (c.pr == null || c.isMerge) continue;
      // A later commit can name the same number ("follow-up (#12)"); the pull request
      // landed with the earliest one.
      const prev = byPr.get(c.pr);
      const earlier = !prev || Date.parse(c.landedISO) < Date.parse(prev.landedISO) || (Date.parse(c.landedISO) === Date.parse(prev.landedISO) && c.sha < prev.sha);
      if (earlier) byPr.set(c.pr, c);
    }
    const state = { path, refs, bySha, byPr, slug, landingKnown: landed !== null, unreadable: false };
    perRepo.set(repo.label, state);
    if (!sources.has(repo.label)) sources.set(repo.label, { key: sourceKey('git', repo.label), tool: 'git', role: 'repository', repo: repo.label });
    return state;
  };
  // The one gate: a session's repo is read only when it is configured, not display.
  const repoOf = (event) => {
    const s = sessionsByKey.get(event.session);
    return s?.repo && s.repo.role !== 'display' && !s.isPrivate ? s.repo : null;
  };
  const unreadableRepo = (st, repo, event) => {
    if (!event.missing.includes('readable-session-repository')) event.missing.push('readable-session-repository');
    if (!st.unreadable) notes.push({ kind: 'repository-unreadable', repo: repo.label });
    st.unreadable = true;
  };

  const seenCommit = new Set();
  for (const c of [...commits].sort(strongestFirst)) {
    const repo = repoOf(c.event);
    if (!repo) continue;
    const st = repoState(repo);
    const src = sources.get(repo.label);
    let found;
    try {
      found = lookupCommit(st.path, c.sha, config.identity.authorEmails);
    } catch {
      // lookupCommit throws only when the path is not a usable repository.
      unreadableRepo(st, repo, c.event);
      continue;
    }
    if (!found.resolved) {
      // The command may have run in another repository (a cd in the same line), so
      // all the engine can say is that the session's repository has no such commit.
      if (!c.event.missing.includes('commit-in-session-repository')) c.event.missing.push('commit-in-session-repository');
      notes.push({ kind: 'commit-not-found-in-session-repository', event: c.event.id });
      continue;
    }
    const k = `${repo.label}|${found.sha}`;
    if (seenCommit.has(k)) continue;
    seenCommit.add(k);
    const landedRow = st.bySha.get(found.sha) ?? null;
    const reachable = st.refs.length ? commitReachableFrom(st.path, found.sha, st.refs) : null;
    const at = iso(found.dateISO);
    events.push({
      id: `${src.key}.commit.${found.sha}`,
      kind: 'outcome',
      at,
      t: Date.parse(at),
      timeFrom: 'git-author-date',
      source: src.key,
      session: c.event.session,
      agent: null,
      actor: 'git',
      evidence: EVIDENCE.RECORDED,
      refs: [{ src: src.key, sha: found.sha }],
      facts: {
        outcome: 'commit-exists',
        repo: repo.label,
        sha: found.sha.slice(0, 12),
        subject: redact(found.subject),
        authoredByConfiguredIdentity: found.byAuthor === true,
        onDefaultBranch: reachable,
        landedAt: iso(landedRow?.landedISO),
        nominatedBy: c.event.id,
      },
      derived: {},
      inferred: attribution(c),
      missing: reachable == null ? ['default-branch'] : [],
      turn: c.event.turn,
    });
  }

  const seenPr = new Set();
  for (const p of [...prs].sort(strongestFirst)) {
    const repo = repoOf(p.event);
    if (!repo || !Number.isInteger(p.number)) continue;
    const st = repoState(repo);
    const src = sources.get(repo.label);
    // A pull-request number means nothing without its repository: one the record does
    // not name, or a repo whose remote cannot be read, is skipped rather than guessed.
    if (!p.repo || !st.slug || p.repo.toLowerCase() !== st.slug.toLowerCase()) continue;
    const k = `${repo.label}|${p.number}`;
    if (seenPr.has(k)) continue;
    seenPr.add(k);
    if (!st.landingKnown) {
      // No readable default branch: whether it landed is unknown, not "no".
      if (!p.event.missing.includes('default-branch')) p.event.missing.push('default-branch');
      notes.push({ kind: 'pr-landing-unknown', pr: p.number, repo: repo.label });
      continue;
    }
    const landed = st.byPr.get(p.number);
    if (!landed) {
      notes.push({ kind: 'pr-not-landed-by-configured-identity', pr: p.number, repo: repo.label });
      continue;
    }
    const at = iso(landed.landedISO);
    events.push({
      id: `${src.key}.pr.${p.number}`,
      kind: 'outcome',
      at,
      t: Date.parse(at),
      timeFrom: 'git-committer-date-on-default-branch',
      source: src.key,
      session: p.event.session,
      agent: null,
      actor: 'git',
      // Git records the commit; that it is this pull request's is read from its subject.
      evidence: EVIDENCE.INFERRED,
      refs: [{ src: src.key, sha: landed.sha }],
      facts: { outcome: 'pr-landed', repo: repo.label, pr: p.number, sha: landed.sha.slice(0, 12), subject: redact(landed.subject), linkedBy: p.event.id },
      derived: {},
      inferred: [{ key: 'prMatchedBy', value: landed.sha.slice(0, 12), rule: 'git.pr-number-from-subject' }, ...attribution(p)],
      missing: [],
      turn: null,
    });
  }
  return { events, sources: [...sources.values()], notes };
}
