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

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A repository's name for matching: its last path segment, lowercased, so
 *  "owner/name", "name.git" and "Name" all compare as "name". */
export function repoName(repo) {
  if (typeof repo !== 'string' || !repo.trim()) return null;
  return repo.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[\\/]/).pop().toLowerCase() || null;
}

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
const PR_SHORT_RE = /^(?:[A-Za-z0-9_.-]+\/)?([A-Za-z0-9_.-]*)#(\d+)$/;
const HEX_RE = /^[0-9a-f]{7,40}$/i;
const ABSOLUTE_RE = /^([A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/;
const HAS_EXTENSION_RE = /(^|[\\/])[^\\/]*\.[A-Za-z0-9]{1,10}$/;
const SQUASH_SUBJECT_RE = /\(#(\d+)\)\s*$/;

/**
 * parseLookup(text) -> query
 *
 * Turns what a person types into a structured query:
 *   "#64", "64", "your-repo#64", "owner/your-repo#64", a pull-request link -> { kind: 'pr', repo, number }
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
    if (url) return { kind: 'pr', repo: repoName(url[2]), number: Number(url[3]) };
    const short = s.match(PR_SHORT_RE);
    if (short) return { kind: 'pr', repo: repoName(short[1]), number: Number(short[2]) };
    if (/^\d{1,6}$/.test(s)) return { kind: 'pr', repo: null, number: Number(s) };
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
  if (q.kind === 'pr' && Number.isInteger(q.number)) return { kind: 'pr', repo: repoName(q.repo ?? null), number: q.number };
  if (q.kind === 'commit' && typeof q.sha === 'string' && HEX_RE.test(q.sha)) return { kind: 'commit', sha: q.sha.toLowerCase() };
  if (q.kind === 'file' && typeof q.path === 'string' && q.path) return { kind: 'file', path: q.path };
  if (q.kind === 'branch' && typeof q.branch === 'string' && q.branch) return { kind: 'branch', branch: q.branch };
  return { kind: 'unknown', text: typeof q.text === 'string' ? q.text : '' };
}

/**
 * createReferenceIndex({ events, readable, joins, repoNameOf }) -> { prRefs, commitRefs, fileRefs, branchRefs }
 *
 * Every pointer a readable session's records hold, collected once, each with how it is
 * known. `joins` are the adapters' raw join lists already moved onto the kept copy of
 * each record (prs, commits, branches); `repoNameOf(session)` names a session's own
 * repository for commands that don't name one.
 */
export function createReferenceIndex({ events, readable, joins, repoNameOf }) {
  const prRefs = [];
  const commitRefs = [];
  const fileRefs = [];
  const branchRefs = [];
  const prJoinRepo = new Map(); // "event id|number" -> repository the record named

  for (const p of joins.prs ?? []) {
    if (!readable.has(p.event.session) || !Number.isInteger(p.number)) continue;
    prJoinRepo.set(`${p.event.id}|${p.number}`, p.repo ?? null);
    const base = { session: p.event.session, event: p.event, number: p.number, repo: repoName(p.repo) };
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
    if (e.kind === 'action' && f.category === 'shell' && typeof e._command === 'string' && f.result !== 'rejected' && f.result !== 'refused') {
      for (const r of prRefsInCommand(e._command)) {
        if (!r.repoKnown) continue;
        const repo = r.repo ? repoName(r.repo) : repoNameOf(e.session);
        prRefs.push({ session: e.session, event: e, number: r.number, repo, via: r.via === 'link' ? 'pr-link-in-command' : 'gh-pr-command', evidence: EVIDENCE.INFERRED, rule: 'pr.gh-command' });
      }
    }
    if (e.kind === 'outcome' && f.outcome === 'pr-landed' && Number.isInteger(f.pr)) {
      const repo = repoName(prJoinRepo.get(`${f.linkedBy}|${f.pr}`) ?? null);
      prRefs.push({ session: e.session, event: e, number: f.pr, repo, via: 'pr-landed', evidence: e.evidence, rule: rulesOf(e) || undefined, sha: e.refs[0]?.sha ?? null });
      if (e.refs[0]?.sha) commitRefs.push({ session: e.session, event: e, sha: e.refs[0].sha, via: 'pr-landed', evidence: e.evidence, rule: rulesOf(e) || undefined, pr: f.pr });
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

/** One row per session, one ref per (how, evidence, rule), counting the events behind
 *  it and keeping the earliest. Strongest evidence first, then first record. */
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
        const k = [it.via, it.evidence, it.rule ?? '', it.pr ?? ''].join('|');
        const once = `${k}|${it.event?.id ?? ''}`;
        if (counted.has(once)) continue;
        counted.add(once);
        const have = refs.get(k);
        if (have) have.count += 1;
        else refs.set(k, { via: it.via, evidence: it.evidence, ...(it.rule ? { rule: it.rule } : {}), ...(it.pr != null ? { pr: it.pr } : {}), event: it.event?.id ?? null, count: 1 });
      }
      const rows = [...refs.values()].sort((a, b) => evidenceRank(a.evidence) - evidenceRank(b.evidence) || cmp(a.via, b.via) || byRefTime(a, b));
      return { session, evidence: rows[0].evidence, refs: rows };
    })
    .sort((a, b) => evidenceRank(a.evidence) - evidenceRank(b.evidence) || cmp(firstAtOf(a.session) ?? '', firstAtOf(b.session) ?? '') || cmp(a.session, b.session));
}

/**
 * createLookup(deps) -> lookup(query)
 *
 *   index           createReferenceIndex(...)
 *   repos           configured repositories that aren't display-role: [{ label, path }]
 *   repoNameOfRepo  (repo) -> the name its pull requests are matched by
 *   sessionRepo     (session) -> configured label of a readable session's repository, or null
 *   sessionCwds     Map(session -> [working folder]) for readable sessions
 *   firstAtOf       (session) -> its first record's time
 *   git             { lookupCommit, worktreeList } or null when git isn't read
 *   authorEmails    the configured identity, for lookupCommit
 *   goalsOf         (sessions) -> goal ids those sessions are members of, or null with no goal record
 *   deepRedact      the redactor, applied to every result
 *
 * lookup(query) -> { query, kind, sessions: [{ session, evidence, refs }], goals, notes, rules }
 * where `rules` maps each rule id the refs name to its plain description.
 */
export function createLookup({ index, repos, repoNameOfRepo, sessionRepo, sessionCwds, firstAtOf, git, authorEmails, goalsOf, deepRedact }) {
  const note = (kind, text, extra = {}) => ({ kind, ...extra, text });

  function prItems(repo, number) {
    return index.prRefs.filter((r) => r.number === number && (repo == null || r.repo === repo));
  }

  function commitItems(sha, notes) {
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
      const prs = prItems(repoNameOfRepo(repo), number);
      for (const p of prs) items.push({ session: p.session, event: p.event, via: 'squash-subject', evidence: EVIDENCE.INFERRED, rule: ['pr.squash-subject', ...(p.rule ? String(p.rule).split(' | ') : [])].filter((x, i, a) => a.indexOf(x) === i).join(' | '), pr: number });
      notes.push(note('squash-subject', `Git says this commit's subject ends in (#${number}), the shape of a squash merge, so sessions that pointed at pull request ${number} are included and marked inferred.`, { pr: number, repo: repo.label }));
    }
    return items;
  }

  function candidateRoots() {
    const roots = new Map();
    const add = (p) => {
      const k = keyPath(p);
      if (k && !roots.has(k)) roots.set(k, p);
    };
    for (const repo of repos) {
      add(repo.path);
      if (git) for (const w of git.worktreeList(repo.path)) add(w);
      for (const [session, cwds] of sessionCwds) if (sessionRepo(session) === repo.label) for (const c of cwds) add(c);
    }
    return [...roots.keys()];
  }

  function fileItems(path, notes) {
    const roots = candidateRoots();
    const q = keyPath(path.trim());
    const keys = new Set();
    let rel = null;
    if (/^([A-Za-z]:\/|\/)/.test(q)) {
      keys.add(pathKey(path.trim()));
      // The same file in another worktree: the part under the deepest root that holds it.
      const holder = roots.filter((r) => q.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
      if (holder) rel = q.slice(holder.length + 1);
    } else {
      rel = q.replace(/^(\.\/)+/, '');
    }
    if (rel) for (const r of roots) keys.add(pathKey(`${r}/${rel}`));
    notes.push(note('roots-tried', `Resolved the path against ${roots.length} candidate folder(s): each configured repository that isn't display-role, the worktrees git lists for it, and the working folder of each readable session in it.`, { count: roots.length }));
    const items = index.fileRefs.filter((r) => keys.has(r.key));
    if (!items.length) notes.push(note('file-not-found', "No readable session's recorded edit, read, or noticed change names this path under any of those folders. A file edited from a worktree that has since been deleted, outside every folder above, can't be found."));
    return items;
  }

  return function lookup(input) {
    const q = normalizeQuery(input);
    const notes = [];
    let items = [];
    if (q.kind === 'pr') {
      items = prItems(q.repo, q.number);
      if (q.repo == null) notes.push(note('any-repository', `No repository was named, so pull request ${q.number} in any repository counts. Name one (your-repo#${q.number}) to narrow it.`));
    } else if (q.kind === 'commit') {
      items = commitItems(q.sha, notes);
    } else if (q.kind === 'file') {
      items = fileItems(q.path, notes);
    } else if (q.kind === 'branch') {
      items = index.branchRefs.filter((r) => r.branch === q.branch);
    } else {
      notes.push(note('unrecognized-query', "Couldn't tell what this names. Try #64, your-repo#64, a pull-request link, a commit id (7 to 40 hex characters), a file path, or branch:<name>. Prefix file: or branch: when the text could be either."));
    }
    const sessions = groupBySession(items, firstAtOf);
    if (!sessions.length && q.kind !== 'unknown' && q.kind !== 'file') notes.push(note('nothing-found', 'No readable session in this window points at it. Sessions outside the configured repositories and in display-role ones are never searched.'));
    const goals = goalsOf ? goalsOf(sessions.map((s) => s.session)) : [];
    // The plain description of every rule the result names, carried with it, since the
    // lookup rules join a history's rules table only when a goal record was given.
    const rules = describeRules(sessions.flatMap((s) => s.refs.map((r) => r.rule)).filter(Boolean).join(' | '));
    return { ...deepRedact({ query: q, kind: q.kind, sessions, goals, notes }), rules };
  };
}
