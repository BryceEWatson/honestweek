// lib/review/scope.mjs: which steps of each session were one pull request's own work.
//
// One session often works on several pull requests, and may never record the branch of the one
// under review (it reaches each worktree with `cd`). So every step is tied to a pull request by
// anchors, each with how it's known:
//   strong  a commit in the pull request, a push to its branch, a pull-request link or a
//           `gh pr ... N` command, a branch made for it, and the step's folder when that
//           folder is on its branch (a leading `cd`, a Codex workdir, the record's own folder)
//   weak    an edit to one of its files, and its closed issue (`gh issue view|comment|edit|close
//           N`, a prompt naming it): these join a stretch a strong anchor ties to the pull
//           request, and never put a step in scope alone
//   other   any of the strong anchors for another pull request, branch or folder
// The steps from one of its anchors to the next, with no other anchor between, are in scope. A
// step anchored both ways, or on the edge between its work and another's, is ambiguous: it's
// never counted as backing a claim, and never silently included. Every other step is excluded
// and counted by the lane it belongs to. A session the person started to review the pull
// request is in scope whole. A saved session, read back without its commands or folders, is
// scoped by commits, pushes and pull-request links only.

import { isRefName, worktreeBranches } from '../git.mjs';
import { keyPath } from '../replay/ids.mjs';
import { looksLikeReview, prRefsInCommand, simpleCommands } from '../replay/classify.mjs';
import { sameCommit } from '../replay/lookup.mjs';
import { pushedBranch } from './resolve.mjs';

const NEVER_RAN = new Set(['rejected', 'refused', 'interrupted']);
const ISSUE_CMD_RE = /^gh\s+issue\s+(view|comment|edit|close|develop)\s+#?(\d+)\b/;
const ABS_RE = /^([A-Za-z]:\/|\/)/;
const short = (sha) => String(sha ?? '').slice(0, 7);

/** A folder written in a command, made absolute against `cwd` and normalized as keyPath does. */
export function folderAt(cwd, dir) {
  const d = keyPath(String(dir ?? '').replace(/^~(?=[\\/])/, ''));
  if (!d) return null;
  const base = keyPath(cwd ?? '');
  const raw = ABS_RE.test(d) ? d : base ? `${base}/${d}` : null;
  if (!raw) return null;
  const out = [];
  for (const part of raw.split('/')) {
    if (part === '.' || (part === '' && out.length)) continue;
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return keyPath(out.join('/') || '/');
}

/** The folder a shell command runs in when it says so itself: a leading `cd X &&`, or a
 *  `git -C X`. null when it doesn't. */
export function commandFolder(command) {
  const s = String(command ?? '');
  const cd = s.match(/^\s*(?:cd|pushd|chdir|set-location|sl)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\n|$)/i);
  if (cd) return cd[1] ?? cd[2] ?? cd[3];
  const gc = s.match(/^\s*git\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return gc ? gc[1] ?? gc[2] ?? gc[3] : null;
}

/** The branch a command makes or switches a folder to: `git worktree add <path> -b <branch>`
 *  (the folder is <path>), `git switch -c|checkout -b <branch>` (the step's own folder). */
export function branchMade(command) {
  for (const cmd of simpleCommands(command)) {
    const wt = cmd.match(/^git\s+(?:-C\s+\S+\s+)?worktree\s+add\s+(.*)$/);
    if (wt) {
      const toks = wt[1].split(/\s+/).filter(Boolean);
      let branch = null;
      const rest = [];
      for (let i = 0; i < toks.length; i++) {
        if ((toks[i] === '-b' || toks[i] === '-B') && toks[i + 1]) branch = toks[++i];
        else if (!toks[i].startsWith('-')) rest.push(toks[i]);
      }
      // `git worktree add <path> <commit-ish>` checks out a branch only when it names a local
      // one: a remote-tracking name, a full ref or a commit id isn't a branch made there.
      if (!branch && rest[1] && !/^(origin|upstream)\/|^refs\/|^[0-9a-f]{7,40}$|^HEAD/.test(rest[1]) && !toks.includes('--detach')) branch = rest[1];
      if (rest[0] && branch && isRefName(branch)) return { branch, path: rest[0] };
    }
    const sw = cmd.match(/^git\s+(?:-C\s+\S+\s+)?(?:switch\s+(?:-c|-C|--create)|checkout\s+-[bB])\s+(\S+)/);
    if (sw && isRefName(sw[1])) return { branch: sw[1], path: null };
  }
  return null;
}

/** The branch a command switches the step's own folder to without making it: `git switch <b>`,
 *  `git checkout <b>` (one name, not a file's). null when it doesn't. */
export function branchSwitched(command) {
  for (const cmd of simpleCommands(command)) {
    const m = cmd.match(/^git\s+(?:-C\s+\S+\s+)?(switch|checkout)\s+([^\s-]\S*)\s*$/);
    if (m && isRefName(m[2]) && !(m[1] === 'checkout' && /\.\w{1,5}$/.test(m[2]))) return m[2];
  }
  return null;
}

/** The issue numbers a person's prompt names: #N, issue N. */
const promptIssues = (text) => [...String(text ?? '').matchAll(/(?:^|[^\w&/])#(\d+)\b|\bissues?\s+#?(\d+)\b/gi)].map((m) => Number(m[1] ?? m[2]));

/**
 * scopeSteps({ h, pr, repoPath, git }) -> { inScope, ambiguous, why, sessions, notes, branchOf, folderOf, laneOf }
 *
 * h: the history resolvePr read (built with keepRaw). pr: resolvePr's answer. repoPath: the
 * configured repository's folder (never a display-only one; pass null to read no git). git:
 * false reads no git. inScope and ambiguous are Sets of event ids; why maps an event id to the
 * { evidence, rule } that placed it; branchOf, folderOf and laneOf answer an event id's folder
 * branch, folder and excluded lane (or null). Each session row is
 *   { key, role, roleEvidence, roleRule, steps, in, ambiguous, excluded, lanes: [{ lane, steps }],
 *     saved, launchedBy }
 * where role is 'author', 'review' or 'mentioned', and lanes name where excluded steps belong
 * ("pull request #21", "branch feature/x", "folder on branch feature/x", "commit abc1234", "no anchor",
 * and for a session that only looked it up, "not this pull request's work").
 */
export function scopeSteps({ h, pr, repoPath = null, git = true }) {
  const inScope = new Set();
  const ambiguous = new Set();
  const why = new Map(); // event id -> { evidence, rule }
  const notes = [];
  const out = { inScope, ambiguous, why, sessions: [], notes, branchOf: () => null, folderOf: () => null, laneOf: (id) => laneById.get(id) ?? null };
  const laneById = new Map(); // event id -> the lane an excluded step belongs to
  if (pr.display) return out;
  const index = h._refIndex();
  const label = pr.repo.label;
  const N = pr.number;
  const branch = pr.branch.name;
  const issues = new Set(pr.issues.closes.map((x) => x.number));
  const files = new Set(pr.files.list.map((f) => f.path));
  const commits = pr.commits.list.map((c) => c.sha);
  const commitsKnown = pr.commits.evidence !== 'missing' && commits.length > 0;
  const byId = new Map(h.events.map((e) => [e.id, e]));
  const inRepo = (key) => h._sessionRepo(key) === label;
  const sessionOf = new Map(h.sessions.map((s) => [s.key, s]));

  // Each event's pull-request numbers (the engine's own pointers), and its recorded commits.
  const prsOf = new Map();
  for (const r of index.prRefs) if (inRepo(r.session)) (prsOf.get(r.event.id) ?? prsOf.set(r.event.id, new Set()).get(r.event.id)).add(r.number);
  const commitsOf = new Map();
  for (const c of index.commitRefs) {
    if (!inRepo(c.session) || !(c.via === 'harness-commit' || c.via === 'commit-exists')) continue;
    const ev = c.via === 'commit-exists' ? byId.get(c.event.facts?.nominatedBy) ?? c.event : c.event;
    (commitsOf.get(ev.id) ?? commitsOf.set(ev.id, []).get(ev.id)).push(c.sha);
  }

  // The repository's checkouts, and which branch each folder was on (and when).
  const roots = new Set((h._repoRoots(label) ?? []).map(keyPath));
  const folderBranch = new Map(); // folder key -> [{ t, branch, how }]
  const saw = (folder, t, b, how) => {
    if (!folder || !b || b === 'HEAD') return;
    (folderBranch.get(folder) ?? folderBranch.set(folder, []).get(folder)).push({ t, branch: b, how });
  };
  if (git && repoPath) for (const w of worktreeBranches(repoPath)) {
    roots.add(keyPath(w.path));
    if (w.branch) saw(keyPath(w.path), Infinity, w.branch, w.prunable ? 'gone worktree' : 'worktree');
  }
  const stepFolder = new Map(); // event id -> folder key
  const lastCwd = new Map(); // session -> last record folder seen
  for (const e of h.events) {
    if (!inRepo(e.session)) continue;
    const cwd = typeof e._lineCwd === 'string' ? e._lineCwd : null;
    if (cwd) lastCwd.set(e.session, cwd);
    const base = cwd ?? lastCwd.get(e.session) ?? null;
    let folder = null;
    if (typeof e._workdir === 'string' && e._workdir) folder = folderAt(base, e._workdir);
    if (e.kind === 'action' && typeof e._command === 'string') {
      const said = commandFolder(e._command);
      if (said) folder = folderAt(folder ?? base, said);
    }
    if (e.kind === 'action' && typeof e._command === 'string' && !NEVER_RAN.has(e.facts?.result)) {
      const made = branchMade(e._command);
      if (made?.path) {
        const p = folderAt(folder ?? base, made.path);
        roots.add(p);
        saw(p, e.t, made.branch, 'worktree add');
      } else if (made) saw(folder ?? keyPath(base), e.t, made.branch, 'switch');
      else {
        const switched = branchSwitched(e._command);
        if (switched) saw(folder ?? keyPath(base), e.t, switched, 'switch');
      }
      const pushed = e.facts?.git?.push?.branch ?? pushedBranch(e._command);
      if (pushed && (folder || base)) saw(folder ?? keyPath(base), e.t, pushed, 'push');
    }
    const fp = e._raw?.input?.file_path ?? e._raw?.input?.path ?? e._raw?.input?.notebook_path;
    if (!folder && e.facts?.category === 'edit' && typeof fp === 'string') {
      const abs = folderAt(base, fp);
      folder = [...roots].filter((r) => abs && (abs === r || abs.startsWith(`${r}/`))).sort((a, b) => b.length - a.length)[0] ?? null;
    }
    if (!folder && cwd) folder = keyPath(cwd);
    if (folder) stepFolder.set(e.id, folder);
    if (cwd && typeof e._lineBranch === 'string' && !folder?.startsWith(`${keyPath(cwd)}/`)) saw(keyPath(cwd), e.t, e._lineBranch, 'record');
  }
  for (const list of folderBranch.values()) list.sort((a, b) => a.t - b.t);
  // Each step's folder, and that folder's branch when the step ran, for the claims' pairing.
  out.folderOf = (id) => stepFolder.get(id) ?? null;
  out.branchOf = (id) => {
    const f = stepFolder.get(id);
    const e = byId.get(id);
    return f && e ? branchAt(f, e.t) : null;
  };
  // A folder's branch at a moment (brief.folder-branch): its last observation at or before it,
  // else its first after.
  const branchAt = (folder, t) => {
    const holder = folderBranch.has(folder) ? folder : [...folderBranch.keys()].filter((f) => folder.startsWith(`${f}/`)).sort((a, b) => b.length - a.length)[0];
    const all = holder ? folderBranch.get(holder) : null;
    if (!all?.length) return null;
    // A push names the branch it sends, which needn't be the one checked out: it counts only for
    // a folder nothing else says anything about.
    const firm = all.filter((o) => o.how !== 'push');
    const list = firm.length ? firm : all;
    let pick = null;
    for (const o of list) if (o.t <= t) pick = o;
    // Before a branch is made or switched to there, the folder wasn't on it, and what it was on
    // isn't known.
    if (!pick && (list[0].how === 'switch' || list[0].how === 'worktree add')) return null;
    return (pick ?? list[0]).branch;
  };
  const defaultNames = new Set(['main', 'master']);
  if (typeof pr.base?.ref === 'string') defaultNames.add(pr.base.ref.replace(/^(refs\/heads\/|refs\/remotes\/)?(origin\/)?/, ''));
  const relPath = (abs) => {
    const r = [...roots].filter((x) => abs === x || abs.startsWith(`${x}/`)).sort((a, b) => b.length - a.length)[0];
    return r ? abs.slice(r.length + 1) : null;
  };

  /** One event's anchors: { this: [kinds], other: [lanes], weak: [kinds] }. */
  function anchors(e) {
    const a = { this: [], other: [], weak: [] };
    if (e.kind === 'action' && NEVER_RAN.has(e.facts?.result)) return a;
    for (const n of prsOf.get(e.id) ?? []) (n === N ? a.this : a.other).push(n === N ? 'pull request' : `pull request #${n}`);
    for (const sha of commitsOf.get(e.id) ?? []) {
      if (commits.some((c) => sameCommit(c, sha))) a.this.push('commit');
      else a.other.push(commitsKnown ? `commit ${short(sha)}` : `commit ${short(sha)} (its own commits unknown)`);
    }
    if (e.kind === 'action' && typeof e._command === 'string') {
      const pushed = e.facts?.git?.push?.branch ?? pushedBranch(e._command);
      if (pushed && branch) (pushed === branch ? a.this : a.other).push(pushed === branch ? 'push' : `branch ${pushed}`);
      const made = branchMade(e._command);
      if (made && branch) (made.branch === branch ? a.this : a.other).push(made.branch === branch ? 'branch made' : `branch ${made.branch}`);
      for (const cmd of simpleCommands(e._command)) {
        const m = cmd.match(ISSUE_CMD_RE);
        if (m && issues.has(Number(m[2]))) a.weak.push('issue');
      }
    }
    const folder = stepFolder.get(e.id);
    if (folder && branch) {
      const b = branchAt(folder, e.t);
      if (b && !defaultNames.has(b)) (b === branch ? a.this : a.other).push(b === branch ? 'folder' : `folder on branch ${b}`);
    }
    if (e.kind === 'prompt' && promptIssues(e.facts?.text).some((n) => issues.has(n))) a.weak.push('issue');
    const fp = e._raw?.input?.file_path ?? e._raw?.input?.path;
    if (e.facts?.category === 'edit' && typeof fp === 'string') {
      const rel = relPath(folderAt(stepFolder.get(e.id) ?? null, fp) ?? '');
      if (rel && files.has(rel)) a.weak.push('file');
    }
    return a;
  }

  // Which sessions to read: those resolvePr found, those launched from them, and any that
  // recorded or worked in its branch.
  const candidates = new Set(pr.sessions.filter(inRepo));
  const launchedBy = new Map();
  for (const l of h.links ?? []) {
    if (l.type !== 'program-launch') continue;
    const fromKey = byId.get(l.from)?.session;
    if (fromKey && candidates.has(fromKey) && inRepo(l.to)) {
      candidates.add(l.to);
      launchedBy.set(l.to, { session: fromKey, event: l.from, evidence: l.evidence, rule: l.rule });
    }
  }
  if (branch) for (const e of h.events) if (inRepo(e.session) && e._lineBranch === branch) candidates.add(e.session);

  const eventsBy = new Map();
  for (const e of h.events) if (candidates.has(e.session)) (eventsBy.get(e.session) ?? eventsBy.set(e.session, []).get(e.session)).push(e);

  // Launched sessions last, so whether the step that started each is in scope is known first.
  const keys = [...candidates].sort((a, b) => Number(launchedBy.has(a)) - Number(launchedBy.has(b)) || (a < b ? -1 : 1));
  for (const key of keys) {
    const list = eventsBy.get(key) ?? [];
    const launch = launchedBy.get(key);
    const launchedHere = !!launch && (inScope.has(launch.event) || ambiguous.has(launch.event));
    // Started by a step whose pull request is open: its steps can be no firmer than that step.
    const launchedOpen = launchedHere && !inScope.has(launch.event);
    const s = sessionOf.get(key);
    const saved = !!s?.saved;
    // A saved session has no commands or folders, and is scoped by its commits, pushes and links
    // only: no file, issue or folder anchor.
    const marks = list.map((e) => {
      const a = anchors(e);
      return saved ? { this: a.this.filter((k) => k !== 'folder'), other: a.other.filter((k) => !k.startsWith('folder ')), weak: [] } : a;
    });
    const isCreateStep = (e) => simpleCommands(e._command).some((c) => /^gh\s+pr\s+create\b/.test(c));
    // A review run counts only for a pull request it's tied to: it points at it, a step in scope
    // started it, or it worked on its branch.
    const tiedFirm = pr.sessions.includes(key) || (!!branch && list.some((e) => e._lineBranch === branch));
    const tied = tiedFirm || launchedHere;
    // How the session opened: its first prompt, or the slash command a program started it with.
    // A review skill an author runs later (a Stop hook's, say) doesn't make it a review.
    const opener = list.find((e) => e.kind === 'prompt' || e.kind === 'command');
    const openText = opener?.kind === 'command' ? String(opener.facts?.name ?? '') : String(opener?.facts?.text ?? '');
    const opensReview = /^\s*\/[\w:-]*review/i.test(openText) || (launchedHere && looksLikeReview(openText));
    const created = list.some((e) => isCreateStep(e) && prsOf.get(e.id)?.has(N));
    const reviewed = list.some((e) => simpleCommands(e._command).some((c) => /^gh\s+pr\s+review\b/.test(c) && prRefsInCommand(c).some((r) => r.number === N)));
    const review = tied && (opensReview || (reviewed && !created));
    const authored = created || list.some((e, i) => marks[i].this.some((k) => k === 'commit' || k === 'push' || k === 'branch made'));
    const role = review ? 'review' : authored ? 'author' : 'mentioned';
    const row = { key, role, roleEvidence: 'inferred', roleRule: review ? 'brief.review-session' : authored ? 'brief.author-session' : 'brief.mentioned-session', steps: list.length, in: 0, ambiguous: 0, excluded: 0, lanes: [], saved, launchedBy: launchedHere ? launch : null };
    const lanes = new Map();
    const exclude = (i, lane) => {
      lanes.set(lane, (lanes.get(lane) ?? 0) + 1);
      laneById.set(list[i].id, lane);
    };
    const put = (e, evidence, rule) => {
      inScope.add(e.id);
      why.set(e.id, { evidence, rule });
    };

    if (role === 'review' && !tiedFirm && launchedOpen) {
      for (const e of list) {
        ambiguous.add(e.id);
        why.set(e.id, { evidence: 'inferred', rule: 'brief.boundary', ambiguous: true });
      }
    } else if (role === 'review') {
      for (const e of list) put(e, 'inferred', 'brief.review-session');
    } else if (role === 'author') {
      // Split at every step that names another pull request, branch or folder.
      const turnOf = (e) => e.turn ?? null;
      const segs = [];
      let cur = [];
      list.forEach((e, i) => {
        const m = marks[i];
        if (m.other.length) {
          if (cur.length) segs.push(cur);
          segs.push([{ i, boundary: true }]);
          cur = [];
        } else cur.push({ i });
      });
      if (cur.length) segs.push(cur);
      const placed = new Map(); // index -> 'in' | 'ambiguous' | lane
      for (const seg of segs) {
        if (seg[0].boundary) {
          const i = seg[0].i;
          if (marks[i].this.length) placed.set(i, 'ambiguous');
          else placed.set(i, marks[i].other[0]);
          continue;
        }
        const strong = seg.filter(({ i }) => marks[i].this.length);
        if (!strong.length) continue;
        const anchored = seg.filter(({ i }) => marks[i].this.length || marks[i].weak.length).map(({ i }) => i);
        const lo = Math.min(...anchored);
        const hi = Math.max(...anchored);
        for (let i = lo; i <= hi; i++) placed.set(i, 'in');
        // The edges: unanchored steps in the same turn as the stretch's first or last anchor.
        // Next to another pull request's work, or in a turn that also did another's, they're
        // ambiguous; at the session's own start or end, in a turn that did only this, they're in.
        const segStart = seg[0].i;
        const segEnd = seg.at(-1).i;
        const turnHasOther = (t) => list.some((x, j) => turnOf(x) === t && marks[j].other.length);
        for (const [from, to, step, edge] of [[hi + 1, segEnd, 1, hi], [lo - 1, segStart, -1, lo]]) {
          const t = turnOf(list[edge]);
          const bounded = step === 1 ? segEnd < list.length - 1 : segStart > 0;
          for (let i = from; step === 1 ? i <= to : i >= to; i += step) {
            if (turnOf(list[i]) !== t || t == null) break;
            placed.set(i, bounded || turnHasOther(t) ? 'ambiguous' : 'in-edge');
          }
        }
      }
      // A session's opening steps, before its first branch, commit or push, are this pull
      // request's when they read the issue it closes.
      const firstStrong = list.findIndex((e, i) => marks[i].this.length || marks[i].other.length);
      const open = firstStrong === -1 ? list.length : firstStrong;
      if (!saved && list.slice(0, open).some((e, i) => marks[i].weak.includes('issue'))) for (let i = 0; i < open; i++) if (!placed.has(i)) placed.set(i, 'opening');
      list.forEach((e, i) => {
        const p = placed.get(i);
        if (p === 'in') put(e, 'inferred', marks[i].this.length ? (marks[i].this.includes('folder') ? 'brief.anchor, brief.folder-branch' : 'brief.anchor') : 'brief.between-anchors');
        else if (p === 'in-edge') put(e, 'inferred', 'brief.turn-edge');
        else if (p === 'opening') put(e, 'inferred', 'brief.issue-opening');
        else if (p === 'ambiguous') {
          ambiguous.add(e.id);
          why.set(e.id, { evidence: 'inferred', rule: 'brief.boundary', ambiguous: true });
        } else exclude(i, p ?? nearestLane(marks, i));
      });
    } else {
      // A session that only looked the pull request up: just the steps that name it.
      list.forEach((e, i) => {
        if (marks[i].this.includes('pull request')) put(e, 'inferred', 'brief.anchor');
        else exclude(i, marks[i].other[0] ?? 'not this pull request\'s work');
      });
    }
    row.in = list.filter((e) => inScope.has(e.id)).length;
    row.ambiguous = list.filter((e) => ambiguous.has(e.id)).length;
    row.excluded = row.steps - row.in - row.ambiguous;
    // A session found only because another started it, and none of whose steps are this pull
    // request's, isn't listed.
    if (!pr.sessions.includes(key) && row.in === 0 && row.ambiguous === 0) continue;
    row.lanes = [...lanes].map(([lane, steps]) => ({ lane, steps })).sort((a, b) => b.steps - a.steps || (a.lane < b.lane ? -1 : 1));
    out.sessions.push(row);
  }
  if (out.sessions.some((s) => s.saved)) notes.push({ kind: 'saved-sessions', text: "A saved session is read back without its commands or folders, so its steps are tied to this pull request by commits, pushes and pull-request links only." });
  if (!branch) notes.push({ kind: 'no-branch', text: "The pull request's branch isn't known, so no step is tied to it by its folder or a push." });
  const order = { author: 0, review: 1, mentioned: 2 };
  out.sessions.sort((a, b) => order[a.role] - order[b.role] || (a.key < b.key ? -1 : 1));
  return out;
}

/** The lane of the nearest step that names another pull request, branch or folder. */
function nearestLane(marks, i) {
  for (let d = 1; d < marks.length; d++) {
    for (const j of [i - d, i + d]) if (j >= 0 && j < marks.length && marks[j].other.length) return marks[j].other[0];
  }
  return 'no anchor';
}
