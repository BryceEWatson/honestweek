// lib/replay/lookup.mjs — reverse lookup: which sessions worked on a pull request, a
// commit, a file, or a branch, and how each link is known.
//
// The rest of the engine reads a session forwards: what it did, step by step. This
// module reads the same records the other way round. Given a pull request, a commit
// id, a file path, or a branch name, it finds every readable session whose records
// point at it, and tags each pointer the way the engine tags everything: recorded (a
// record says so) or inferred (a named rule read it). Private and display-role
// sessions are never searched, and only configured repositories that aren't
// display-role are ever passed to git.

import { describeRules, prRefsInCommand } from './classify.mjs';
import { EVIDENCE } from './evidence.mjs';
import { keyPath, pathKey } from './ids.mjs';

const RANK = { recorded: 0, derived: 1, inferred: 2, missing: 3 };
/** Strongest first: recorded, derived, inferred, missing. */
export const evidenceRank = (level) => RANK[level] ?? 9;
/** A join or a pointer marked ambiguous ranks below every unambiguous one, inferred
 *  included, whatever its own level: which session or repository it means is open. */
export const effectiveRank = (row) => evidenceRank(row.evidence) + (row.ambiguous ? 10 : 0);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A repository's name for matching: its last path segment, lowercased, so
 *  "owner/name", "name.git" and "Name" all compare as "name". */
export function repoName(repo) {
  if (typeof repo !== 'string' || !repo.trim()) return null;
  return repo.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[\\/]/).pop().toLowerCase() || null;
}

/** A repository as { owner, name }, both lowercased: "owner/name" names both, a bare
 *  "name" names no owner. Null when nothing is named. */
export function repoSlug(repo) {
  const name = repoName(repo);
  if (!name) return null;
  const parts = repo.trim().replace(/[\\/]+$/, '').split(/[\\/]/);
  return { owner: parts.length > 1 ? parts.at(-2).toLowerCase() || null : null, name };
}

/** True when a pointer is to the pull request a citation or query names: the number
 *  always, the repository's name when one is named, and its owner when both name one. */
export function prMatches(want, ref) {
  if (ref.number !== want.number) return false;
  if (!want.repo) return true;
  if (ref.repo !== want.repo) return false;
  return !want.owner || !ref.owner || want.owner === ref.owner;
}

/** The pointers to one pull request. Two cases leave which repository was meant open,
 *  and each marks the matches ambiguous rather than picking:
 *   - the request names a repository without its owner, and the matches name more than
 *     one owner: every match is marked { owners: n };
 *   - the request names an owner, and a match names none (its origin remote couldn't be
 *     read, or git wasn't): that match is marked { ownerUnknown: true }. */
export function matchPrRefs(prRefs, want) {
  const items = prRefs.filter((r) => prMatches(want, r));
  const owners = want.repo && !want.owner ? new Set(items.map((r) => r.owner).filter(Boolean)) : new Set();
  if (owners.size > 1) return { items: items.map((r) => ({ ...r, ambiguous: { owners: owners.size } })), owners: owners.size, ownerUnknown: 0 };
  const unknown = want.repo && want.owner ? items.filter((r) => !r.owner).length : 0;
  return { items: unknown ? items.map((r) => (r.owner ? r : { ...r, ambiguous: { ownerUnknown: true } })) : items, owners: owners.size, ownerUnknown: unknown };
}

/** The repository a pull-request pointer names, as { owner, name } with null for a part
 *  the record doesn't name; both null means the repository is unknown. */
export const prRepository = (r) => ({ owner: r.owner ?? null, name: r.repo ?? null });
const repositoryKey = (x) => (x ? `${x.owner ?? '?'}/${x.name ?? '?'}` : '');

/** A call a person rejected, a rule refused, or that was interrupted: it never ran as
 *  recorded, so nothing it carried counts as work on anything. */
const NEVER_RAN = new Set(['rejected', 'refused', 'interrupted']);
export const didNotRun = (e) => NEVER_RAN.has(e?.facts?.result);

/** Two commit ids name the same commit when one starts with the other and both have
 *  at least 7 characters (outcomes keep 12, the harness records 40, a commit's
 *  printed summary shows 7 or more). */
export function sameCommit(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

const PR_URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_SHORT_RE = /^(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]*)#(\d+)$/;
const HEX_RE = /^[0-9a-f]{7,40}$/i;
const ABSOLUTE_RE = /^([A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/;
const HAS_EXTENSION_RE = /(^|[\\/])[^\\/]*\.[A-Za-z0-9]{1,10}$/;
const SQUASH_SUBJECT_RE = /\(#(\d+)\)\s*$/;
const lower = (s) => (s ? s.toLowerCase() : null);

/**
 * parseLookup(text) -> query
 *
 * Turns what a person types into a structured query:
 *   "#64", "64", "your-repo#64", "owner/your-repo#64", a pull-request link -> { kind: 'pr', owner, repo, number }
 *   7 to 40 hex characters                                              -> { kind: 'commit', sha }
 *   a path (absolute, ./relative, or a last segment with an extension)  -> { kind: 'file', path }
 *   anything else made of name characters                              -> { kind: 'branch', branch }
 * A prefix settles an ambiguous text: pr:, commit:, file: (or path:), branch:.
 * Text that fits none gives { kind: 'unknown', text }.
 */
export function parseLookup(text) {
  const raw = String(text ?? '').trim();
  const prefixed = raw.match(/^(pr|pull|commit|file|path|branch):\s*(.*)$/i);
  const hint = prefixed ? prefixed[1].toLowerCase() : null;
  const s = prefixed ? prefixed[2].trim() : raw;
  const unknown = { kind: 'unknown', text: raw };
  if (!s) return unknown;
  if (!hint || hint === 'pr' || hint === 'pull') {
    const url = s.match(PR_URL_RE);
    if (url) return { kind: 'pr', owner: lower(url[1]), repo: repoName(url[2]), number: Number(url[3]) };
    const short = s.match(PR_SHORT_RE);
    if (short) return { kind: 'pr', owner: short[2] ? lower(short[1]) : null, repo: repoName(short[2]), number: Number(short[3]) };
    if (/^\d{1,6}$/.test(s)) return { kind: 'pr', owner: null, repo: null, number: Number(s) };
    if (hint) return unknown;
  }
  if (!hint || hint === 'commit') {
    if (HEX_RE.test(s)) return { kind: 'commit', sha: s.toLowerCase() };
    if (hint) return unknown;
  }
  if (hint === 'branch') return { kind: 'branch', branch: s };
  if (hint === 'file' || hint === 'path') return { kind: 'file', path: s };
  if (ABSOLUTE_RE.test(s) || s.includes('\\') || HAS_EXTENSION_RE.test(s)) return { kind: 'file', path: s };
  if (/^[A-Za-z0-9._/-]+$/.test(s) && !s.includes('..') && !s.startsWith('-') && !s.endsWith('/')) return { kind: 'branch', branch: s };
  return unknown;
}

/** A structured query as given, checked: a string is parsed, an object is kept to
 *  the fields its kind uses. */
function normalizeQuery(input) {
  if (typeof input === 'string') return parseLookup(input);
  const q = input && typeof input === 'object' ? input : {};
  if (q.kind === 'pr' && Number.isInteger(q.number)) {
    const slug = repoSlug(q.repo ?? null);
    return { kind: 'pr', owner: lower(q.owner ?? null) ?? slug?.owner ?? null, repo: slug?.name ?? null, number: q.number };
  }
  if (q.kind === 'commit' && typeof q.sha === 'string' && HEX_RE.test(q.sha)) return { kind: 'commit', sha: q.sha.toLowerCase() };
  if (q.kind === 'file' && typeof q.path === 'string' && q.path) return { kind: 'file', path: q.path };
  if (q.kind === 'branch' && typeof q.branch === 'string' && q.branch) return { kind: 'branch', branch: q.branch };
  return { kind: 'unknown', text: typeof q.text === 'string' ? q.text : '' };
}

/**
 * createReferenceIndex({ events, readable, joins, repoSlugOf, workdirInRepo }) -> { prRefs, commitRefs, fileRefs, branchRefs }
 *
 * Every pointer a readable session's records hold, collected once, each with how it is
 * known. `joins` are the adapters' raw join lists already moved onto the kept copy of
 * each record (prs, commits, branches); `repoSlugOf(session)` names a session's own
 * repository ({ owner, name }) for commands that don't name one, and
 * `workdirInRepo(session, folder)` says whether a Codex call's working folder is inside
 * that repository.
 */
export function createReferenceIndex({ events, readable, joins, repoSlugOf, workdirInRepo }) {
  const prRefs = [];
  const commitRefs = [];
  const fileRefs = [];
  const branchRefs = [];
  const prJoinRepo = new Map(); // "event id|number" -> repository the record named

  for (const p of joins.prs ?? []) {
    if (!readable.has(p.event.session) || !Number.isInteger(p.number)) continue;
    prJoinRepo.set(`${p.event.id}|${p.number}`, p.repo ?? null);
    const slug = repoSlug(p.repo ?? null);
    const base = { session: p.event.session, event: p.event, number: p.number, owner: slug?.owner ?? null, repo: slug?.name ?? null };
    if (p.evidence === EVIDENCE.RECORDED) prRefs.push({ ...base, via: p.event.kind === 'link' ? 'pr-link' : 'harness-git-pr', evidence: EVIDENCE.RECORDED });
    else prRefs.push({ ...base, via: 'printed-output', evidence: EVIDENCE.INFERRED, rule: p.rule ?? 'shell.gh-pr-output' });
  }

  const nominatedSha = new Map(); // nominating event id -> [full sha git resolved]
  for (const e of events) {
    if (e.kind === 'outcome' && e.facts.outcome === 'commit-exists' && e.facts.nominatedBy && e.refs[0]?.sha) {
      nominatedSha.set(e.facts.nominatedBy, [...(nominatedSha.get(e.facts.nominatedBy) ?? []), e.refs[0].sha]);
    }
  }
  for (const c of joins.commits ?? []) {
    if (!readable.has(c.event.session) || typeof c.sha !== 'string') continue;
    const full = (nominatedSha.get(c.event.id) ?? []).find((s) => sameCommit(s, c.sha)) ?? c.sha;
    if (c.evidence === EVIDENCE.RECORDED) commitRefs.push({ session: c.event.session, event: c.event, sha: full, via: 'harness-commit', evidence: EVIDENCE.RECORDED });
    else commitRefs.push({ session: c.event.session, event: c.event, sha: full, via: 'printed-output', evidence: EVIDENCE.INFERRED, rule: c.rule ?? 'shell.git-commit-output' });
  }

  for (const b of joins.branches ?? []) {
    if (readable.has(b.event.session)) branchRefs.push({ session: b.event.session, event: b.event, branch: b.branch, via: b.via, evidence: EVIDENCE.RECORDED });
  }

  const rulesOf = (e) => [...new Set(e.inferred.map((x) => x.rule))].sort().join(' | ');
  for (const e of events) {
    if (!readable.has(e.session)) continue;
    const f = e.facts ?? {};
    if (e.kind === 'action' && f.category === 'shell' && typeof e._command === 'string' && !didNotRun(e)) {
      // A Codex call that ran in a folder outside the session's repository acts on
      // whatever repository that folder holds, which the record doesn't say.
      const ranOutside = typeof e._workdir === 'string' && !workdirInRepo(e.session, e._workdir);
      for (const r of prRefsInCommand(e._command)) {
        if (!r.repoKnown) continue;
        if (!r.repo && ranOutside) continue;
        const slug = r.repo ? repoSlug(r.repo) : repoSlugOf(e.session);
        prRefs.push({ session: e.session, event: e, number: r.number, owner: slug?.owner ?? null, repo: slug?.name ?? null, via: r.via === 'link' ? 'pr-link-in-command' : 'gh-pr-command', evidence: EVIDENCE.INFERRED, rule: 'pr.gh-command' });
      }
    }
    if (e.kind === 'outcome' && f.outcome === 'pr-landed' && Number.isInteger(f.pr)) {
      const slug = repoSlug(prJoinRepo.get(`${f.linkedBy}|${f.pr}`) ?? null);
      prRefs.push({ session: e.session, event: e, number: f.pr, owner: slug?.owner ?? null, repo: slug?.name ?? null, via: 'pr-landed', evidence: e.evidence, rule: rulesOf(e) || undefined, sha: e.refs[0]?.sha ?? null });
      if (e.refs[0]?.sha) commitRefs.push({ session: e.session, event: e, sha: e.refs[0].sha, via: 'pr-landed', evidence: e.evidence, rule: rulesOf(e) || undefined, pr: f.pr, repository: { owner: slug?.owner ?? null, name: slug?.name ?? null } });
    }
    if (e.kind === 'outcome' && f.outcome === 'commit-exists' && e.refs[0]?.sha) {
      // Git recorded the commit; how it hangs from the session is the outcome's own tag.
      const rule = rulesOf(e);
      commitRefs.push({ session: e.session, event: e, sha: e.refs[0].sha, via: 'commit-exists', evidence: rule ? EVIDENCE.INFERRED : e.evidence, rule: rule || undefined });
    }
    if ((e.kind === 'action' || e.kind === 'external-edit') && (f.fileKey || Array.isArray(f.fileKeys))) {
      const via = e.kind === 'external-edit' ? 'external-edit' : f.category === 'edit' ? 'edit' : 'read';
      for (const key of new Set([f.fileKey, ...(f.fileKeys ?? [])].filter(Boolean))) fileRefs.push({ session: e.session, event: e, key, via, evidence: EVIDENCE.RECORDED });
    }
  }
  return { prRefs, commitRefs, fileRefs, branchRefs };
}

/** One row per session, one ref per (how, evidence, rule, ambiguity), counting the
 *  events behind it and keeping the earliest. A session's level is its strongest ref's,
 *  where an ambiguous ref ranks below every unambiguous one; when its strongest ref is
 *  ambiguous, the session is marked ambiguous too. Strongest first, then first record. */
export function groupBySession(items, firstAtOf) {
  const bySession = new Map();
  for (const it of items) {
    if (!bySession.has(it.session)) bySession.set(it.session, []);
    bySession.get(it.session).push(it);
  }
  const byEvent = (a, b) => (a.event?.t ?? -Infinity) - (b.event?.t ?? -Infinity) || cmp(a.event?.id ?? '', b.event?.id ?? '');
  const tOf = new Map(items.filter((it) => it.event).map((it) => [it.event.id, it.event.t]));
  const byRefTime = (a, b) => (tOf.get(a.event) ?? -Infinity) - (tOf.get(b.event) ?? -Infinity) || cmp(a.event ?? '', b.event ?? '');
  return [...bySession]
    .map(([session, list]) => {
      const refs = new Map();
      const counted = new Set();
      for (const it of [...list].sort(byEvent)) {
        const k = [it.via, it.evidence, it.rule ?? '', it.pr ?? '', repositoryKey(it.repository), it.ambiguous ? JSON.stringify(it.ambiguous) : ''].join('|');
        const once = `${k}|${it.event?.id ?? ''}`;
        if (counted.has(once)) continue;
        counted.add(once);
        const have = refs.get(k);
        if (have) have.count += 1;
        else refs.set(k, { via: it.via, evidence: it.evidence, ...(it.rule ? { rule: it.rule } : {}), ...(it.pr != null ? { pr: it.pr } : {}), ...(it.repository ? { repository: it.repository } : {}), ...(it.ambiguous ? { ambiguous: it.ambiguous } : {}), event: it.event?.id ?? null, count: 1 });
      }
      const rows = [...refs.values()].sort((a, b) => effectiveRank(a) - effectiveRank(b) || cmp(a.via, b.via) || byRefTime(a, b));
      return { session, evidence: rows[0].evidence, ...(rows[0].ambiguous ? { ambiguous: true } : {}), refs: rows };
    })
    .sort((a, b) => effectiveRank(a) - effectiveRank(b) || cmp(firstAtOf(a.session) ?? '', firstAtOf(b.session) ?? '') || cmp(a.session, b.session));
}

/**
 * createLookup(deps) -> lookup(query)
 *
 *   index           createReferenceIndex(...)
 *   repos           configured repositories that aren't display-role: [{ label, path }]
 *   repoSlugOfRepo  (repo) -> { owner, name } its pull requests are matched by
 *   rootsOfRepo     (repo) -> the normalized folders of its checkouts: the configured
 *                   path and each worktree git or the repository's own records list
 *   sessionCwds     Map(session -> [working folder]) for readable sessions
 *   firstAtOf       (session) -> its first record's time
 *   git             { lookupCommit } or null when git isn't read
 *   authorEmails    the configured identity, for lookupCommit
 *   goalsOf         (sessions) -> goal ids those sessions are members of, or null with no goal record
 *   deepRedact      the redactor, applied to every result
 *
 * lookup(query) -> { query, kind, sessions: [{ session, evidence, ambiguous?, refs }], goals, notes, rules }
 * where `rules` maps each rule id the refs name to its plain description. A file lookup
 * also returns `repositories: [{ repo, roots, sessions }]`, one group per repository
 * searched, and each of its session rows names its `repo`.
 */
export function createLookup({ index, repos, repoSlugOfRepo, rootsOfRepo, sessionCwds, firstAtOf, git, authorEmails, goalsOf, deepRedact }) {
  const note = (kind, text, extra = {}) => ({ kind, ...extra, text });

  // Every pull-request pointer names the repository it is in (or says it's unknown),
  // so pull request 7 of one repository never reads as pull request 7 of another.
  function prItems(want, notes) {
    const { items, owners, ownerUnknown } = matchPrRefs(index.prRefs, want);
    if (ownerUnknown) notes.push(note('owner-unknown', `${ownerUnknown} pointer(s) name a repository called ${want.repo} without its owner (its origin remote couldn't be read, or git wasn't read), so whether they mean ${want.owner}/${want.repo} is open and each is marked ambiguous.`, { count: ownerUnknown }));
    if (owners > 1) notes.push(note('owners-disagree', `Sessions point at pull request ${want.number} of a repository named ${want.repo} under ${owners} different owners, so which one was meant is open and each of those links is marked ambiguous. Name the owner (owner/${want.repo}#${want.number}) to tell them apart.`, { owners }));
    return items.map((r) => ({ ...r, repository: prRepository(r) }));
  }

  function commitItems(sha, notes) {
    // A commit id read from printed output counts only once git confirmed it exists
    // (the commit-exists outcome); an unconfirmed one may belong to another repository.
    const items = index.commitRefs.filter((r) => r.via !== 'printed-output' && sameCommit(r.sha, sha));
    if (!git) {
      notes.push(note('git-not-read', "Git wasn't read for this history, so no commit's subject was checked for a squash-merged pull request."));
      return items;
    }
    for (const repo of repos) {
      let found = null;
      try {
        found = git.lookupCommit(repo.path, sha, authorEmails);
      } catch {
        notes.push(note('repository-unreadable', 'A configured repository could not be read by git, so its commit subjects were not checked.', { repo: repo.label }));
        continue;
      }
      const m = found?.resolved ? String(found.subject ?? '').match(SQUASH_SUBJECT_RE) : null;
      if (!m) continue;
      const number = Number(m[1]);
      const slug = repoSlugOfRepo(repo);
      for (const p of prItems({ owner: slug?.owner ?? null, repo: slug?.name ?? null, number }, notes)) {
        items.push({ session: p.session, event: p.event, via: 'squash-subject', evidence: EVIDENCE.INFERRED, rule: ['pr.squash-subject', ...(p.rule ? String(p.rule).split(' | ') : [])].filter((x, i, a) => a.indexOf(x) === i).join(' | '), pr: number, repository: p.repository, ...(p.ambiguous ? { ambiguous: p.ambiguous } : {}) });
      }
      notes.push(note('squash-subject', `Git says this commit's subject ends in (#${number}), the shape of a squash merge, so sessions that pointed at pull request ${number} of that repository are included and marked inferred.`, { pr: number, repo: repo.label }));
    }
    return items;
  }

  /** The file lookup's groups, one per repository searched, never merged. */
  function fileGroups(path, notes) {
    const rootsBy = repos.map((repo) => ({ label: repo.label, roots: rootsOfRepo(repo) }));
    const all = rootsBy.flatMap((g) => g.roots.map((root) => ({ label: g.label, root })));
    const holderOf = (p) => all.filter((x) => p === x.root || p.startsWith(`${x.root}/`)).sort((a, b) => b.root.length - a.root.length)[0] ?? null;
    // A session's working folder is never a root of its own: one inside a known root
    // adds nothing, and one outside every root (a worktree since deleted, say) is skipped.
    let outside = 0;
    for (const cwds of sessionCwds.values()) for (const c of cwds) if (!holderOf(keyPath(c) ?? '')) outside += 1;
    if (outside) notes.push(note('session-folders-outside-roots', `${outside} working folder(s) of readable sessions sit outside every repository and worktree folder known here, so a relative path isn't looked up under them. A worktree that has since been deleted looks like this.`, { count: outside }));

    const typed = path.trim();
    const q = keyPath(typed);
    let groups;
    if (/^([A-Za-z]:\/|\/)/.test(q)) {
      // An absolute path belongs to the one repository whose checkout holds it.
      const holder = holderOf(q);
      if (!holder) {
        notes.push(note('outside-every-repository', "This path isn't inside any configured repository or its worktrees, so only that exact path was looked up."));
        groups = [{ repo: null, roots: [], keys: new Set([pathKey(typed)]) }];
      } else {
        const rel = q === holder.root ? '' : q.slice(holder.root.length + 1);
        const roots = rootsBy.find((g) => g.label === holder.label).roots;
        groups = [{ repo: holder.label, roots, keys: new Set([pathKey(typed), ...roots.map((r) => pathKey(rel ? `${r}/${rel}` : r))]) }];
      }
    } else {
      const rel = q.replace(/^(\.\/)+/, '');
      groups = rootsBy.map((g) => ({ repo: g.label, roots: g.roots, keys: new Set(g.roots.map((r) => pathKey(`${r}/${rel}`))) }));
    }
    const total = groups.reduce((n, g) => n + g.roots.length, 0);
    notes.push(note('roots-tried', `Looked the path up under ${total} folder(s) in ${groups.filter((g) => g.repo).length} repository(ies): each configured repository that isn't display-role and each of its worktrees. A session's working folder is never used as a root, and results are listed per repository.`, { count: total, repositories: groups.filter((g) => g.repo).length }));
    const found = groups.map((g) => ({ repo: g.repo, roots: g.roots.length, sessions: groupBySession(index.fileRefs.filter((r) => g.keys.has(r.key)), firstAtOf) }));
    if (!found.some((g) => g.sessions.length)) notes.push(note('file-not-found', "No readable session's recorded edit, read, or noticed change names this path under any of those folders. A file edited from a worktree that has since been deleted can't be found by a relative path."));
    return found;
  }

  return function lookup(input) {
    const q = normalizeQuery(input);
    const notes = [];
    let sessions = [];
    let repositories = null;
    if (q.kind === 'pr') {
      sessions = groupBySession(prItems(q, notes), firstAtOf);
      if (q.repo == null) notes.push(note('any-repository', `No repository was named, so pull request ${q.number} in any repository counts. Name one (your-repo#${q.number}) to narrow it.`));
    } else if (q.kind === 'commit') {
      sessions = groupBySession(commitItems(q.sha, notes), firstAtOf);
    } else if (q.kind === 'file') {
      repositories = fileGroups(q.path, notes);
      sessions = repositories.flatMap((g) => g.sessions.map((s) => ({ repo: g.repo, ...s })));
    } else if (q.kind === 'branch') {
      sessions = groupBySession(index.branchRefs.filter((r) => r.branch === q.branch), firstAtOf);
    } else {
      notes.push(note('unrecognized-query', "Couldn't tell what this names. Try #64, your-repo#64, a pull-request link, a commit id (7 to 40 hex characters), a file path, or branch:<name>. Prefix file: or branch: when the text could be either."));
    }
    if (!sessions.length && q.kind !== 'unknown' && q.kind !== 'file') notes.push(note('nothing-found', 'No readable session in this window points at it. Sessions outside the configured repositories and in display-role ones are never searched.'));
    const goals = goalsOf ? goalsOf([...new Set(sessions.map((s) => s.session))]) : [];
    // The plain description of every rule the result names, carried with it, since the
    // lookup rules join a history's rules table only when a goal record was given.
    const rules = describeRules(sessions.flatMap((s) => s.refs.map((r) => r.rule)).filter(Boolean).join(' | '));
    return { ...deepRedact({ query: q, kind: q.kind, sessions, ...(repositories ? { repositories } : {}), goals, notes }), rules };
  };
}
