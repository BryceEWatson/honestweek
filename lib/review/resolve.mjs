// lib/review/resolve.mjs: find one pull request offline, from the session logs and local git.
//
// Given `#210`, the brief needs the pull request's latest commit (its head), where it starts
// (its base), its branch, its commits, its changed files and the issue it closes. GitHub isn't
// asked: honestweek never reads the network. Each answer says how it's known:
//   recorded  the reviewer gave it (--head, --base, --issue), or git says so outright
//   derived   worked out from recorded facts only (a merge-base, the squash commit's parent)
//   inferred  a named brief.* rule's reading (lib/review/rules.mjs), which can be wrong
//   missing   nothing here could tell
// A value that rests on several takes the weakest of them. When sources disagree (two branch
// names, say), the answer is ambiguous and none is picked. A display-only repository is never
// passed to git: its pull request resolves to nothing but its number.

import { branchTip, changedFiles, commitMessage, commitRange, defaultBranchRefs, isCommitId, isRefName, landedPr, lookupCommit, mergeBase, originSlug, revParse } from '../git.mjs';
import { didNotRun, parseLookup, prMatches, repoName, repoSlug, sameCommit } from '../replay/lookup.mjs';
import { outputOf } from '../replay/record-output.mjs';
import { prRefsInCommand, simpleCommands } from '../replay/classify.mjs';
import { weakest } from '../problems/index.mjs';

/** A question the brief can't answer as asked: the person has to say more (which repository,
 *  say). Its message is shown as is. */
export class BriefError extends Error {}

/** The most commits a range lists; past it the list says it was cut. */
export const MAX_COMMITS = 500;
/** The most commit messages read for a closing keyword. */
const MAX_MESSAGES = 50;
/** The most git and gh outputs read back for printed commit ids, and the most ids tried. */
const MAX_PRINTED_READS = 400;
const MAX_TREE_CHECKS = 60;

const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*(?:,|and)\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;
const REF_IN_RE = /(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/g;
const MENTION_RE = /(?:^|[^\w&/])(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b|\bissues?\s+#?(\d+)(?![\d-]|\.\d)/gi;
const CREATING_RE = /Creating (?:draft )?pull request for (\S+) into (\S+) in (\S+)/;
const HEAD_REF_RE = /"headRefName"\s*:\s*"([^"]+)"/;
const MERGE_FROM_RE = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/;

/** The rules the values in `xs` rest on, joined as the engine joins them, or undefined. */
const rulesOf = (...xs) => [...new Set(xs.flatMap((x) => String(x?.rule ?? '').split(' | ')).filter(Boolean))].join(' | ') || undefined;

const isCreate = (e) => simpleCommands(e?._command).some((c) => /^gh\s+pr\s+create\b/.test(c));

/** The value of `--name X` or `--name=X` in one simple command, or null. */
function optionValue(cmd, ...names) {
  const toks = cmd.split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    for (const n of names) {
      if (toks[i] === n && toks[i + 1]) return toks[i + 1];
      if (toks[i].startsWith(`${n}=`)) return toks[i].slice(n.length + 1);
    }
  }
  return null;
}

/** The branch a `git push` in a command line sends to, when the line names one: `git push
 *  [-u] <remote> <branch>` or `<src>:<branch>`. null for a bare `git push` or a tag. */
export function pushedBranch(command) {
  for (const cmd of simpleCommands(command)) {
    const m = cmd.match(/^git\s+(?:-C\s+\S+\s+)?push\b(.*)$/);
    if (!m) continue;
    const toks = m[1].split(/\s+/).filter(Boolean);
    // A deletion sends nothing to the branch.
    if (toks.some((t) => t === '--delete' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(t))) continue;
    const args = [];
    for (let i = 0; i < toks.length; i++) {
      if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(toks[i])) i++;
      else if (!toks[i].startsWith('-')) args.push(toks[i]);
    }
    if (args.length < 2 || args[1].startsWith(':')) continue;
    const spec = args[1].replace(/^\+/, '');
    const dest = spec.includes(':') ? spec.split(':').pop() : spec;
    const name = dest.replace(/^refs\/heads\//, '');
    if (name && name !== 'HEAD' && !name.startsWith('refs/tags/') && isRefName(name)) return name;
  }
  return null;
}

/** The issues a text closes and the ones it only names, as numbers, for a repository `slug`
 *  ({ owner, name }). A reference to another repository's issue counts for neither. */
export function issueRefs(text, slug, own = null) {
  const s = String(text ?? '');
  const here = (owner, name) => !name || (repoName(name) === slug?.name && (!owner || !slug?.owner || owner.toLowerCase() === slug.owner));
  const closes = new Set();
  for (const m of s.matchAll(CLOSES_RE)) {
    for (const r of m[1].matchAll(REF_IN_RE)) if (here(r[1], r[2])) closes.add(Number(r[3]));
  }
  const named = new Set();
  for (const m of s.matchAll(MENTION_RE)) {
    const n = Number(m[3] ?? m[4]);
    if (m[3] != null && !here(m[1], m[2])) continue;
    if (Number.isSafeInteger(n) && n > 0) named.add(n);
  }
  if (own != null) {
    closes.delete(own);
    named.delete(own);
  }
  return { closes: [...closes], named: [...named].filter((n) => !closes.has(n)) };
}

/** The configured repository a query and the options point at. */
function chooseRepo({ config, want, given, slugOf, sessionLabels }) {
  const repos = (config.repos ?? []).filter((r) => r && r.label);
  const label = (r) => String(r.label).toLowerCase();
  if (given) {
    const g = String(given).trim().toLowerCase();
    // A label is matched first, with no git call; owner/name needs each repository's origin.
    const byLabel = repos.filter((r) => label(r) === g);
    if (byLabel.length === 1) return { repo: byLabel[0], chosenBy: 'given' };
    const hit = repos.filter((r) => label(r) === g || (r.role !== 'display' && slugOf(r) && `${slugOf(r).owner}/${slugOf(r).name}` === g) || (r.role !== 'display' && !g.includes('/') && slugOf(r)?.name === g));
    if (hit.length === 1) return { repo: hit[0], chosenBy: 'given' };
    if (!hit.length) throw new BriefError(`no configured repository is called ${JSON.stringify(given)}. Name one by its label in your config, or as owner/name.`);
    throw new BriefError(`${hit.length} configured repositories fit ${JSON.stringify(given)} (${hit.map((r) => r.label).join(', ')}). Name one by its label.`);
  }
  if (want?.repo) {
    const hit = repos.filter((r) => {
      if (r.role === 'display') return label(r) === want.repo;
      const s = slugOf(r);
      return (s && s.name === want.repo && (!want.owner || !s.owner || s.owner === want.owner)) || label(r) === want.repo;
    });
    if (hit.length === 1) return { repo: hit[0], chosenBy: 'query' };
    if (hit.length > 1) throw new BriefError(`${hit.length} configured repositories fit ${want.owner ? `${want.owner}/` : ''}${want.repo} (${hit.map((r) => r.label).join(', ')}). Name one with --repo.`);
    throw new BriefError(`no configured repository is ${want.owner ? `${want.owner}/` : ''}${want.repo}. Add it to your config, or name one with --repo.`);
  }
  if (repos.length === 1) return { repo: repos[0], chosenBy: 'only' };
  const fromSessions = repos.filter((r) => sessionLabels.has(r.label));
  if (fromSessions.length === 1) return { repo: fromSessions[0], chosenBy: 'sessions' };
  const names = (fromSessions.length ? fromSessions : repos).map((r) => r.label).join(', ');
  throw new BriefError(`more than one configured repository could hold it (${names}). Name one with --repo, or write it as your-repo#N.`);
}

/**
 * resolvePr({ h, config, query, head, base, issue, repo, git }) -> the pull request's shape:
 *   { number, repo: { label, slug, role, chosenBy }, display, sessions, landed, head, base,
 *     branch, commits, files, issues: { closes, related }, headCheck, events, notes }
 *
 * h: an engine history built with keepRaw (lib/replay/index.mjs); its hidden _refIndex and
 * _sessionRepo name the sessions that point at the pull request. query: `#N`, `repo#N`,
 * `owner/repo#N`, a pull request's address, `pr:N`, or `branch:NAME`. head, base: a commit id
 * or branch name the reviewer read from GitHub. issue: the issue number it closes. repo: a
 * configured repository's label or owner/name. git: false reads no git at all.
 * Throws BriefError when the query or the options can't be read, or more than one configured
 * repository fits.
 */
export function resolvePr({ h, config, query, head = null, base = null, issue = null, repo = null, git = true }) {
  const q = parseLookup(query);
  // A bare word could be a branch or a typo: a branch needs its prefix here.
  if (q.kind !== 'pr' && !(q.kind === 'branch' && /^\s*branch:/i.test(String(query)))) throw new BriefError(`${JSON.stringify(String(query ?? ''))} doesn't name a pull request. Give #12, your-repo#12, its address, or branch:<name>.`);
  for (const [name, v] of [['--head', head], ['--base', base]]) if (v != null && !isCommitId(v) && !isRefName(v)) throw new BriefError(`${name} takes a commit id or a branch name.`);
  const issueGiven = issue == null ? null : /^#?\d{1,9}$/.test(String(issue).trim()) ? Number(String(issue).trim().replace('#', '')) : NaN;
  if (Number.isNaN(issueGiven) || issueGiven === 0) throw new BriefError('--issue takes an issue number, such as 19 or #19.');
  if (q.kind === 'branch' && !isRefName(q.branch)) throw new BriefError('branch: takes a branch name.');

  const index = h._refIndex();
  const sessionRepo = (key) => h._sessionRepo(key);
  const authorEmails = config.identity?.authorEmails ?? [];
  const slugCache = new Map();
  const pathOf = (r) => r.resolvedPath ?? r.path;
  // A display-only repository's slug is never read: that would be a git call.
  const slugOf = (r) => {
    if (r.role === 'display' || !git) return repoSlug(r.label);
    if (!slugCache.has(r.label)) {
      let s = null;
      try {
        s = originSlug(pathOf(r));
      } catch {
        s = null;
      }
      slugCache.set(r.label, repoSlug(s) ?? repoSlug(r.label));
    }
    return slugCache.get(r.label);
  };

  // Which sessions point at it, before the repository is known, for choosing one.
  const number0 = q.kind === 'pr' ? q.number : null;
  const pointing = number0 != null
    ? index.prRefs.filter((r) => r.number === number0 && (!q.repo || prMatches(q, r))).map((r) => r.session)
    : [...index.branchRefs.filter((b) => b.branch === q.branch).map((b) => b.session), ...h.events.filter((e) => e.kind === 'action' && pushedBranch(e._command) === q.branch).map((e) => e.session)];
  const chosen = chooseRepo({ config, want: q.kind === 'pr' ? q : null, given: repo, slugOf, sessionLabels: new Set(pointing.map((k) => sessionRepo(k)).filter(Boolean)) });
  const r = chosen.repo;
  const notes = [];
  const note = (kind, text, extra = {}) => notes.push({ kind, text, ...extra });
  const out = {
    number: number0,
    // How the number is known when the query named a branch: a reading of the logs.
    numberFrom: null,
    repo: { label: r.label, slug: null, role: r.role ?? null, chosenBy: chosen.chosenBy },
    display: r.role === 'display',
    sessions: [],
    landed: null,
    head: { sha: null, evidence: 'missing', via: null },
    base: { sha: null, evidence: 'missing', via: null },
    branch: { name: q.kind === 'branch' ? q.branch : null, evidence: q.kind === 'branch' ? 'recorded' : 'missing', ambiguous: false, sources: q.kind === 'branch' ? [{ name: q.branch, via: 'given', evidence: 'recorded' }] : [] },
    commits: { list: [], truncated: false, evidence: 'missing' },
    files: { list: [], evidence: 'missing' },
    issues: { closes: issueGiven != null ? [{ number: issueGiven, evidence: 'recorded', via: 'given', sources: [{ via: 'given', evidence: 'recorded' }] }] : [], related: [] },
    headCheck: null,
    events: { creates: [], pushes: [], prRefs: [], printed: [] },
    notes,
  };
  if (out.display) {
    note('display-only', `${r.label} is a display-only repository, so honestweek never reads it with git or reads its sessions. Nothing about this pull request can be shown.`);
    return out;
  }
  const slug = slugOf(r);
  out.repo.slug = slug?.owner ? `${slug.owner}/${slug.name}` : slug?.name ?? null;
  const path = pathOf(r);
  const gitOk = git && !!path;
  if (!gitOk) note('git-not-read', "Git wasn't read, so the pull request's commits, files and landing commit can't be shown.");

  const inRepo = (key) => sessionRepo(key) === r.label;
  const eventsBySession = new Map();
  for (const e of h.events) {
    if (!inRepo(e.session)) continue;
    (eventsBySession.get(e.session) ?? eventsBySession.set(e.session, []).get(e.session)).push(e);
  }
  const printed = (e) => {
    if (!e?.end?.ref) return null;
    try {
      return outputOf(h.record(e.end.ref)[0]?.record) ?? null;
    } catch {
      return null;
    }
  };

  // Every push in this repository's sessions: the harness's records, and push commands it didn't record.
  const pushes = [];
  for (const b of index.branchRefs) if (b.via === 'push' && inRepo(b.session)) pushes.push({ session: b.session, event: b.event, branch: b.branch, evidence: 'recorded' });
  for (const [key, list] of eventsBySession) {
    for (const e of list) {
      if (e.kind !== 'action' || e.facts?.git?.push || didNotRun(e)) continue;
      const name = pushedBranch(e._command);
      if (name) pushes.push({ session: key, event: e, branch: name, evidence: 'inferred', rule: 'brief.push-command' });
    }
  }
  pushes.sort((a, b) => a.event.t - b.event.t);
  out.events.pushes = pushes;

  // A pull request named by its branch: its number is the one the first create step after a
  // push to that branch (and before that session's next push) made.
  if (number0 == null && q.kind === 'branch') {
    const nums = new Set();
    for (const p of pushes.filter((x) => x.branch === q.branch)) {
      const next = pushes.find((x) => x.session === p.session && x.event.t > p.event.t);
      const c = index.prRefs.filter((x) => x.session === p.session && x.event?.kind === 'action' && isCreate(x.event) && x.event.t >= p.event.t && (!next || x.event.t < next.event.t)).sort((a, b) => a.event.t - b.event.t)[0];
      if (c) nums.add(c.number);
    }
    if (nums.size === 1) {
      out.number = [...nums][0];
      out.numberFrom = { evidence: 'inferred', rule: 'brief.number-create-after-push' };
    }
    else if (nums.size > 1) note('branch-several-prs', `Sessions opened ${nums.size} pull requests after pushing ${q.branch}, so which one it is stays open.`);
  }

  // The pull-request pointers in this repository's sessions.
  const want = { kind: 'pr', owner: slug?.owner ?? null, repo: slug?.name ?? null, number: out.number };
  const prRefs = out.number == null ? [] : index.prRefs.filter((x) => inRepo(x.session) && x.number === out.number && (x.repo == null || prMatches(want, x)));
  out.events.prRefs = prRefs;
  // The gh pr create step(s) for it.
  const createEvents = [...new Set(prRefs.filter((x) => x.event?.kind === 'action' && isCreate(x.event)).map((x) => x.event))];
  out.events.creates = createEvents;
  const number = out.number;
  const sessions = new Set([...prRefs.map((x) => x.session), ...pushes.filter((x) => out.branch.name && x.branch === out.branch.name).map((x) => x.session)]);
  out.sessions = [...sessions].sort();

  // Where it landed, if it has.
  if (gitOk && number != null) {
    const l = landedPr(path, number, authorEmails);
    if (l?.unreadable) note('landing-unreadable', "Git couldn't say whether this pull request landed (no default branch to read, or git didn't answer), so it's treated as not known to have landed.");
    // Git has the commit, but that it is this pull request's landing is read from its subject.
    else if (l) out.landed = { sha: l.sha, subject: l.subject, at: l.landedISO, kind: l.isMerge ? 'merge' : 'squash', parents: l.parents, evidence: 'inferred', via: 'git', rule: rulesOf({ rule: 'brief.landed-subject' }, out.numberFrom), ref: l.ref };
  }

  // Its branch: every source is kept; when they disagree none is picked.
  if (q.kind !== 'branch') {
    const sources = [];
    for (const e of createEvents) {
      const before = pushes.filter((p) => p.session === e.session && p.event.t <= e.t).at(-1);
      if (before) sources.push({ name: before.branch, via: 'push-before-create', evidence: 'inferred', rule: 'brief.branch-push-before-create', session: e.session, event: e.id });
      for (const cmd of simpleCommands(e._command).filter((c) => /^gh\s+pr\s+create\b/.test(c))) {
        const head0 = optionValue(cmd, '--head', '-H');
        if (head0 && isRefName(head0.replace(/^[^:]+:/, ''))) sources.push({ name: head0.replace(/^[^:]+:/, ''), via: 'head-option', evidence: 'inferred', rule: 'brief.branch-head-option', session: e.session, event: e.id });
      }
      const m = String(printed(e) ?? '').match(CREATING_RE);
      if (m && isRefName(m[1])) sources.push({ name: m[1], via: 'printed', evidence: 'inferred', rule: 'brief.branch-printed', session: e.session, event: e.id });
    }
    for (const x of prRefs.filter((x) => x.event?.kind === 'action' && !isCreate(x.event) && /--json\s+\S*headRefName/.test(String(x.event._command ?? '')))) {
      const m = String(printed(x.event) ?? '').match(HEAD_REF_RE);
      if (m && isRefName(m[1])) sources.push({ name: m[1], via: 'printed', evidence: 'inferred', rule: 'brief.branch-printed', session: x.session, event: x.event.id });
    }
    if (out.landed?.kind === 'merge') {
      const m = String(out.landed.subject ?? '').match(MERGE_FROM_RE);
      if (m && isRefName(m[1])) sources.push({ name: m[1], via: 'merge-subject', evidence: 'inferred', rule: 'brief.branch-merge-subject' });
    }
    const names = [...new Set(sources.map((s) => s.name))];
    out.branch = names.length === 1
      ? { name: names[0], evidence: 'inferred', rule: rulesOf(...sources), ambiguous: false, sources }
      : { name: null, evidence: 'missing', ambiguous: names.length > 1, sources };
    if (names.length > 1) note('branch-ambiguous', `The logs and git name ${names.length} branches for it (${names.join(', ')}), so none is picked.`);
    for (const p of pushes) if (out.branch.name && p.branch === out.branch.name) sessions.add(p.session);
    out.sessions = [...sessions].sort();
  }

  // The commits sessions recorded right before each push to its branch.
  // A commit the harness recorded, or one a session printed that git confirmed (the engine's
  // commit-exists outcome, placed at the step that printed it). A landing found by its subject
  // is no session's commit.
  const byId = new Map(h.events.map((e) => [e.id, e]));
  const recorded = index.commitRefs
    .filter((c) => inRepo(c.session) && (c.via === 'harness-commit' || c.via === 'commit-exists') && isCommitId(c.sha))
    .map((c) => (c.via === 'commit-exists' ? { ...c, event: byId.get(c.event.facts?.nominatedBy) ?? c.event } : c));
  const pushedCommits = [];
  if (out.branch.name) {
    for (const p of pushes.filter((x) => x.branch === out.branch.name)) {
      const prev = pushes.filter((x) => x.session === p.session && x.event.t < p.event.t).at(-1);
      for (const c of recorded) if (c.session === p.session && c.event.t <= p.event.t && (!prev || c.event.t > prev.event.t)) pushedCommits.push({ sha: c.sha, session: c.session, event: c.event, push: p });
    }
  }

  // Commit ids its sessions printed: git's own output after a commit, push or log, and the
  // headRefOid gh printed for it. Read back from the logs, only for git and gh commands.
  const landedT = out.landed ? Date.parse(out.landed.at) : Infinity;
  const printedIds = [];
  const printedHeads = [];
  if (gitOk) {
    const near = new Set([...sessions, ...(out.branch.name ? h.events.filter((e) => inRepo(e.session) && e._lineBranch === out.branch.name).map((e) => e.session) : [])]);
    let reads = 0;
    for (const key of near) {
      for (const e of eventsBySession.get(key) ?? []) {
        if (e.kind !== 'action' || e.t > landedT || reads >= MAX_PRINTED_READS) continue;
        const cmds = simpleCommands(e._command);
        if (!cmds.some((c) => /^git\s+(?:-C\s+\S+\s+)?(commit|push|log|rev-parse|show)\b|^gh\s+pr\s+(view|create|checks|status)\b/.test(c))) continue;
        reads++;
        const text = String(printed(e) ?? '');
        const forThis = prRefsInCommand(e._command).some((x) => x.number === number) || /"number"\s*:\s*(\d+)/.exec(text)?.[1] === String(number);
        const oid = text.match(/"headRefOid"\s*:\s*"([0-9a-f]{40})"/);
        if (oid && forThis) printedHeads.push({ sha: oid[1], event: e });
        for (const m of text.matchAll(/^(?:\[[^\]\s]+ )?([0-9a-f]{7,40})\b/gm)) printedIds.push({ id: m[1], event: e });
      }
    }
  }

  out.events.printed = [...printedIds, ...printedHeads.map((x) => ({ id: x.sha, event: x.event }))];

  // Its head.
  let derived = { sha: null, evidence: 'missing', via: null };
  if (gitOk && out.landed?.kind === 'merge' && out.landed.parents[1]) derived = { sha: out.landed.parents[1], evidence: 'inferred', via: 'merge-parent', rule: 'brief.head-merge-parent' };
  else if (gitOk && out.landed?.kind === 'squash') {
    // A commit a session recorded or printed whose files are exactly what the squash landed: the
    // branch's last commit when it was up to date as it merged. The latest one wins.
    const seen = new Set();
    const candidates = [...pushedCommits.map((c) => ({ id: c.sha, event: c.push.event })), ...printedIds, ...printedHeads.map((x) => ({ id: x.sha, event: x.event }))]
      .sort((a, b) => b.event.t - a.event.t)
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .slice(0, MAX_TREE_CHECKS);
    for (const c of candidates) {
      const sha = revParse(path, c.id);
      if (!sha || sha === out.landed.sha) continue;
      const diff = changedFiles(path, sha, out.landed.sha);
      if (diff && diff.length === 0) {
        derived = { sha, evidence: 'inferred', via: 'same-tree', rule: 'brief.head-same-tree', event: c.event.id };
        break;
      }
    }
    if (!derived.sha) {
      const last = pushedCommits.filter((c) => c.push.event.t <= landedT).sort((a, b) => a.push.event.t - b.push.event.t || a.event.t - b.event.t).at(-1);
      const sha = last ? revParse(path, last.sha) : null;
      if (sha) derived = { sha, evidence: 'inferred', via: 'last-push', rule: 'brief.head-last-push', event: last.push.event.id };
    }
  } else if (gitOk && !out.landed && out.branch.name) {
    const tip = branchTip(path, out.branch.name);
    if (tip) derived = { sha: tip.sha, evidence: 'inferred', via: 'local-branch', rule: 'brief.head-local-branch', ref: tip.ref };
  }
  if (gitOk && !derived.sha && printedHeads.length) {
    const last = printedHeads.sort((a, b) => a.event.t - b.event.t).at(-1);
    const sha = revParse(path, last.sha);
    if (sha) derived = { sha, evidence: 'inferred', via: 'printed', rule: 'brief.head-printed', event: last.event.id };
  }
  if (head != null) {
    const sha = gitOk ? revParse(path, head) : null;
    out.head = sha ? { sha, evidence: 'recorded', via: 'given' } : { sha: null, given: String(head), evidence: 'missing', via: 'given', ...(number != null && gitOk ? { hint: `git fetch origin pull/${number}/head` } : {}) };
    if (!sha && gitOk) note('head-not-in-git', `The head you gave isn't in local git.${number != null ? ` Fetch it with: git fetch origin pull/${number}/head` : ''}`);
  } else out.head = derived;
  if (head != null && out.head.sha && derived.sha && out.head.sha !== derived.sha) {
    const ahead = commitRange(path, derived.sha, out.head.sha, { max: MAX_COMMITS });
    const known = new Set(recorded.map((c) => c.sha.toLowerCase()));
    const unlogged = (ahead?.commits ?? []).filter((c) => ![...known].some((k) => sameCommit(k, c.sha))).length;
    out.headCheck = { given: out.head.sha, derived: derived.sha, derivedVia: derived.via, same: false, newer: ahead ? ahead.commits.length : null, unlogged: ahead ? unlogged : null, truncated: !!ahead?.truncated };
    note('head-differs', `The head you gave isn't the one the logs and local git point to (${derived.via}).${ahead ? ` It's ${ahead.truncated ? 'at least ' : ''}${ahead.commits.length} commit(s) past it, and ${unlogged} of them match no commit a session in these logs recorded or git confirmed for this repository.` : ''}`);
  } else if (head != null && out.head.sha && derived.sha) out.headCheck = { given: out.head.sha, derived: derived.sha, derivedVia: derived.via, same: true, newer: 0, unlogged: 0, truncated: false };

  // Its base.
  if (base != null) {
    const sha = gitOk ? revParse(path, base) : null;
    out.base = sha ? { sha, evidence: 'recorded', via: 'given' } : { sha: null, given: String(base), evidence: 'missing', via: 'given' };
  } else if (gitOk && out.landed) {
    out.base = out.landed.parents[0]
      ? { sha: out.landed.parents[0], evidence: weakest(['derived', out.landed.evidence]), via: out.landed.kind === 'merge' ? 'merge-first-parent' : 'squash-parent', rule: out.landed.rule }
      : { sha: null, evidence: 'missing', via: null };
  } else if (gitOk && out.head.sha) {
    const refs = (() => {
      try {
        return defaultBranchRefs(path);
      } catch {
        return [];
      }
    })();
    const mb = refs.length ? mergeBase(path, out.head.sha, refs[0]) : null;
    // Nothing recorded says it targets the default branch (a stacked one doesn't), so this is a reading.
    out.base = mb ? { sha: mb, evidence: 'inferred', via: 'merge-base', rule: rulesOf(out.head, { rule: 'brief.base-default-branch' }), ref: refs[0] } : { sha: null, evidence: 'missing', via: null };
  }

  // Its commits and files.
  if (gitOk && out.base.sha && out.head.sha) {
    const range = commitRange(path, out.base.sha, out.head.sha, { max: MAX_COMMITS });
    if (range) {
      const level = weakest([out.base.evidence, out.head.evidence]);
      const rule = rulesOf(out.base, out.head);
      out.commits = { list: range.commits.map((c) => ({ sha: c.sha, subject: c.subject, at: c.dateISO, authorEmail: c.authorEmail, inGit: true, evidence: level, via: 'range', ...(rule ? { rule } : {}), loggedBy: [...new Set(recorded.filter((x) => sameCommit(x.sha, c.sha)).map((x) => x.session))].sort() })), truncated: range.truncated, evidence: level };
    }
  }
  for (const c of pushedCommits) {
    if (out.commits.list.some((x) => sameCommit(x.sha, c.sha))) continue;
    if (Number.isFinite(landedT) && c.push.event.t > landedT) continue;
    const found = gitOk ? lookupCommit(path, c.sha, authorEmails) : null;
    out.commits.list.push({ sha: found?.resolved ? found.sha : c.sha, subject: found?.resolved ? found.subject : null, at: found?.resolved ? found.dateISO : null, inGit: !!found?.resolved, evidence: found?.resolved ? 'inferred' : 'missing', via: 'pushed', rule: 'brief.commit-before-push', loggedBy: [c.session] });
  }
  // The list reads no stronger than its weakest row.
  if (out.commits.list.length) {
    out.commits.evidence = weakest(out.commits.list.map((c) => c.evidence));
    const rule = rulesOf(...out.commits.list);
    if (rule) out.commits.rule = rule;
  }
  if (gitOk && out.landed?.kind === 'squash' && out.landed.parents[0]) {
    const files = changedFiles(path, out.landed.parents[0], out.landed.sha);
    if (files) out.files = { list: files, evidence: weakest(['recorded', out.landed.evidence]), via: 'landing-commit', rule: out.landed.rule };
  } else if (gitOk && out.base.sha && out.head.sha) {
    const from = out.landed?.kind === 'merge' ? mergeBase(path, out.base.sha, out.head.sha) ?? out.base.sha : out.base.sha;
    const files = changedFiles(path, from, out.head.sha);
    const rule = rulesOf(out.base, out.head);
    if (files) out.files = { list: files, evidence: weakest([out.base.evidence, out.head.evidence]), via: 'range', ...(rule ? { rule } : {}) };
  }

  // The issue it closes, and the ones it names.
  const closes = new Map(out.issues.closes.map((x) => [x.number, x]));
  const related = new Map();
  const take = (text, src) => {
    const found = issueRefs(text, slug, number);
    for (const n of found.closes) {
      if (!closes.has(n)) closes.set(n, { number: n, evidence: 'inferred', via: src.via, rule: 'brief.issue-closes', sources: [] });
      closes.get(n).sources.push({ ...src, evidence: 'inferred', rule: 'brief.issue-closes' });
    }
    for (const n of found.named) {
      if (!related.has(n)) related.set(n, { number: n, evidence: 'inferred', rule: 'brief.issue-mentioned', sources: [] });
      related.get(n).sources.push({ ...src, evidence: 'inferred', rule: 'brief.issue-mentioned' });
    }
  };
  for (const e of createEvents) take(e._command, { via: 'pr-body', session: e.session, event: e.id });
  if (gitOk) {
    for (const c of out.commits.list.filter((x) => x.inGit).slice(0, MAX_MESSAGES)) take(commitMessage(path, c.sha), { via: 'commit-message', sha: c.sha });
    if (out.landed) take(commitMessage(path, out.landed.sha), { via: 'landing-message', sha: out.landed.sha });
  }
  for (const n of closes.keys()) related.delete(n);
  out.issues = { closes: [...closes.values()].sort((a, b) => a.number - b.number), related: [...related.values()].sort((a, b) => a.number - b.number) };
  return out;
}
