// lib/replay/goals.mjs — goal membership: which sessions did one goal's work, and how
// each link is known.
//
// A goal record is a person's own list of goals ({ goals: [...] }) with the record's
// write log beside it ({ events: [...] }: one entry per change, each with a stable id
// the writer chose and the time the record accepted it). This module joins that record
// to the sessions the engine read. Every join names its type and evidence level:
//
//   cited-session      recorded  the goal record names the session's harness id
//   cited-pr           recorded  the session's harness recorded a link to, or a git
//                                fact about, a pull request the goal cites (inferred,
//                                with the outcome rule, when read from printed output)
//   cited-commit       recorded  the harness recorded a commit the goal cites (inferred
//                                when read from a commit command's printed output)
//   wrote-entry        derived   a tool call's input carried one of the goal's entry ids
//                                and the record accepted that entry while the call ran
//   created-goal       derived   the same, for the entry that created the goal
//   command-on-pr      inferred  a command acted on a cited pull request (pr.gh-command)
//   prompt-names-goal  inferred  a prompt names the goal id (goal.prompt-names-id)
//
// A session merely mentioning a pull request or a commit in a prompt or a message is
// never a join. Private and display-role sessions are never scanned and never members.

import { EVIDENCE } from './evidence.mjs';
import { describeRules } from './classify.mjs';
import { didNotRun, effectiveRank, matchPrRefs, prRepository, repoName, sameCommit } from './lookup.mjs';
import { redactClipFirstLine } from './parse-common.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const TYPE_ORDER = ['cited-session', 'cited-pr', 'cited-commit', 'created-goal', 'wrote-entry', 'command-on-pr', 'prompt-names-goal'];

/**
 * normalizeGoalRecord(input) -> { goals, entries }
 * Throws with a plain message when the shape is wrong. Goals without a string id (or
 * repeating one) are skipped; entries are kept only when they name a goal in the record.
 */
export function normalizeGoalRecord(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.goals)) {
    throw new Error('replay: a goal record must be an object with a "goals" list, such as { "goals": [{ "id": "g-1", "title": "Ship the parser" }], "events": [] }.');
  }
  if (input.events != null && !Array.isArray(input.events)) {
    throw new Error('replay: a goal record\'s "events" must be a list of { "eventId", "goalId", "type", "at" } entries.');
  }
  const goals = [];
  const ids = new Set();
  for (const g of input.goals) {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id.trim() || ids.has(g.id)) continue;
    ids.add(g.id);
    goals.push(g);
  }
  const entries = (input.events ?? []).filter((x) => x && typeof x === 'object' && typeof x.eventId === 'string' && x.eventId && typeof x.goalId === 'string' && ids.has(x.goalId));
  return { goals, entries };
}

const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])/i;
const PR_LINK_G = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?!\d)/gi;
const PR_SHORT_G = /(?<![\w./#-])(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]*[A-Za-z_-][A-Za-z0-9_.-]*)#(\d+)(?![\w-])/g;
const BARE_SHA_G = /(?<![0-9A-Za-z])[0-9a-f]{40}(?![0-9A-Za-z])/gi;
const MARKER_G = /(?<![\w-])(session|commit):(?=\S)/gi;

function walkStrings(value, where, fn, depth = 0) {
  if (depth > 20 || value == null) return;
  if (typeof value === 'string') fn(value, where);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${where}[${i}]`, fn, depth + 1));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, `${where}.${k}`, fn, depth + 1);
}

/**
 * goalCitations(goal, { redact }) -> [{ kind, ref, where, ... }]
 *
 * Every reference inside the goal's source, observations, results and decisions, in
 * the order the record holds them, once each:
 *   { kind: 'pr', owner, repo, number }  a pull-request link, or repo#N / owner/repo#N
 *                                        (owner is null when the citation names none)
 *   { kind: 'session', id }              session:<harness session id>
 *   { kind: 'commit', sha }              commit:<7 to 40 hex>, or a bare 40-hex id
 *   { kind: 'session-words' | 'commit-words' }  the marker followed by anything else
 *
 * A words citation's `ref` is an excerpt: the marker and the rest of its text, redacted
 * with `redact` (nothing is hidden by default), then its first line, cut to 80
 * characters. Ids are matched on the raw first line, since the redactor hides a session id.
 */
export function goalCitations(goal, { redact = (s) => s } = {}) {
  const wordsRef = (marker, rest) => redactClipFirstLine(`${marker}:${rest}`, 80, redact);
  const out = [];
  const seen = new Set();
  const add = (key, c) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const scan = (s, where) => {
    for (const m of s.matchAll(PR_LINK_G)) {
      const repo = repoName(m[2]);
      const owner = m[1].toLowerCase();
      add(`pr|${owner}|${repo}|${m[3]}`, { kind: 'pr', owner, repo, number: Number(m[3]), ref: `${m[1]}/${m[2]}#${m[3]}`, where });
    }
    for (const m of s.matchAll(PR_SHORT_G)) {
      const repo = repoName(m[2]);
      const owner = m[1] ? m[1].toLowerCase() : null;
      add(`pr|${owner ?? ''}|${repo}|${m[3]}`, { kind: 'pr', owner, repo, number: Number(m[3]), ref: `${m[1] ? `${m[1]}/` : ''}${m[2]}#${m[3]}`, where });
    }
    for (const m of s.matchAll(MARKER_G)) {
      const marker = m[1].toLowerCase();
      const rest = s.slice(m.index + m[0].length);
      const tail = rest.split(/\r?\n/)[0];
      if (marker === 'session') {
        const id = tail.match(UUID_RE);
        if (id) add(`session|${id[1].toLowerCase()}`, { kind: 'session', id: id[1].toLowerCase(), ref: `session:${id[1]}`, where });
        else add(`session-words|${tail}`, { kind: 'session-words', ref: wordsRef('session', rest), where });
      } else {
        const sha = tail.match(/^([0-9a-f]{7,40})(?![0-9A-Za-z])/i);
        if (sha) add(`commit|${sha[1].toLowerCase()}`, { kind: 'commit', sha: sha[1].toLowerCase(), ref: sha[1].toLowerCase(), where });
        else add(`commit-words|${tail}`, { kind: 'commit-words', ref: wordsRef('commit', rest), where });
      }
    }
    for (const m of s.matchAll(BARE_SHA_G)) add(`commit|${m[0].toLowerCase()}`, { kind: 'commit', sha: m[0].toLowerCase(), ref: m[0].toLowerCase(), where });
  };
  for (const field of ['source', 'observations', 'results', 'decisions']) walkStrings(goal[field], field, scan);
  return out;
}

/** The recorded span of a call: its own time to its recorded result's time, both as
 *  the records wrote them (never the axis position a clock rule raised). A call that
 *  was rejected, refused, or interrupted never ran as recorded, so it has no span. */
function spanContains(call, t) {
  if (!call.end || didNotRun(call)) return false;
  const from = Date.parse(call.at ?? '');
  const to = Date.parse(call.end.at ?? '');
  return Number.isFinite(from) && Number.isFinite(to) && from <= t && t <= to;
}

/**
 * goalMembership({ record, index, watched, harnessIds, readable, firstAtOf, window, redact }) -> goals
 *
 *   record      normalizeGoalRecord(...)
 *   index       createReferenceIndex(...) from lookup.mjs
 *   watched     the parse-time side notes of readable sessions: [{ token, where, event }]
 *   harnessIds  Map(lowercased harness session id -> session key)
 *   readable    Set of readable session keys
 *   firstAtOf   (session) -> its first record's time
 *   window      { startT, endT }
 *   redact      the history's redactor, for the excerpts goalCitations cuts
 *
 * Returns, per goal in record order: { id, title, state, members, unmatched }. Strings
 * are the record's own, those excerpts aside; the caller redacts the result before it
 * leaves the engine.
 */
export function goalMembership({ record, index, watched, harnessIds, readable, firstAtOf, window, redact }) {
  const callsByToken = new Map();
  const promptsByToken = new Map();
  for (const w of watched) {
    if (!readable.has(w.event.session)) continue;
    const into = w.where === 'call' && w.event.kind === 'action' ? callsByToken : w.where === 'prompt' && (w.event.kind === 'prompt' || w.event.facts?.from === 'codex-exec') ? promptsByToken : null;
    if (!into) continue;
    if (!into.has(w.token)) into.set(w.token, []);
    into.get(w.token).push(w.event);
  }
  const byTime = (a, b) => a.t - b.t || cmp(a.id, b.id);

  return record.goals.map((goal) => {
    const raw = [];
    const unmatched = [];

    // 1. The record's own entries: written by the call whose recorded span holds the
    //    time the record accepted it. A call that only read or searched the record
    //    carries the id too, but at another time, so it never qualifies.
    const entries = record.entries.filter((x) => x.goalId === goal.id).sort((a, b) => cmp(String(a.at ?? ''), String(b.at ?? '')) || cmp(a.eventId, b.eventId));
    for (const x of entries) {
      const t = Date.parse(typeof x.at === 'string' ? x.at : '');
      const carriers = [...(callsByToken.get(x.eventId) ?? [])].sort(byTime);
      if (!Number.isFinite(t)) {
        if (carriers.length) unmatched.push({ kind: 'entry', ref: x.eventId, why: "the record gives this entry no readable time, so no call's span can be checked against it" });
        continue;
      }
      const bySession = new Map();
      for (const call of carriers) if (spanContains(call, t) && !bySession.has(call.session)) bySession.set(call.session, call);
      const n = bySession.size;
      const type = x.type === 'goal.create' ? 'created-goal' : 'wrote-entry';
      for (const [session, call] of bySession) {
        raw.push({ session, type, evidence: EVIDENCE.DERIVED, event: call, matched: `${x.type ?? ''}|${n > 1 ? n : 1}`, ...(n > 1 ? { ambiguous: { candidates: n } } : {}), detail: { entry: x.eventId, entryType: typeof x.type === 'string' ? x.type : null, at: x.at } });
      }
      if (n) continue;
      if (carriers.length) {
        unmatched.push({ kind: 'entry', ref: x.eventId, why: `${carriers.length} call(s) carried this id, but none has a recorded result spanning the time the record accepted it (reading or searching the record isn't writing it)` });
      } else if (t >= window.startT && t < window.endT) {
        unmatched.push({ kind: 'entry', ref: x.eventId, why: 'no tool call in a readable session in this window carried this id' });
      }
    }

    // 2. What the goal record cites.
    for (const c of goalCitations(goal, { redact })) {
      if (c.kind === 'session') {
        const session = harnessIds.get(c.id);
        if (session && readable.has(session)) raw.push({ session, type: 'cited-session', evidence: EVIDENCE.RECORDED, event: null, matched: c.id, detail: { ref: c.ref, where: c.where } });
        else unmatched.push({ kind: 'session', ref: c.ref, where: c.where, why: 'no readable session with that id is in the logs read for this window' });
      } else if (c.kind === 'session-words') {
        unmatched.push({ kind: 'session', ref: c.ref, where: c.where, why: "names a session in words, not by its harness id, so it isn't matched to one" });
      } else if (c.kind === 'commit-words') {
        unmatched.push({ kind: 'commit', ref: c.ref, where: c.where, why: "names a commit in words, not by its id, so it isn't matched to one" });
      } else if (c.kind === 'pr') {
        // The repository's name must match, and its owner too when both sides name one.
        // A citation without an owner whose matches name several owners is ambiguous.
        const { items: refs } = matchPrRefs(index.prRefs, c);
        let found = false;
        for (const r of refs) {
          const amb = r.ambiguous ? { ambiguous: r.ambiguous } : {};
          if (r.via === 'pr-link' || r.via === 'harness-git-pr' || r.via === 'printed-output') {
            raw.push({ session: r.session, type: 'cited-pr', evidence: r.evidence, ...(r.rule ? { rule: r.rule } : {}), event: r.event, matched: `${c.ref}|${r.via}|${r.owner ?? '?'}/${r.repo ?? '?'}`, ...amb, detail: { ref: c.ref, where: c.where, via: r.via, repository: prRepository(r) } });
            found = true;
          } else if (r.via === 'gh-pr-command' || r.via === 'pr-link-in-command') {
            raw.push({ session: r.session, type: 'command-on-pr', evidence: EVIDENCE.INFERRED, rule: 'pr.gh-command', event: r.event, matched: `${c.ref}|${r.owner ?? '?'}/${r.repo ?? '?'}`, ...amb, detail: { ref: c.ref, where: c.where, repository: prRepository(r) } });
            found = true;
          }
        }
        if (!found) unmatched.push({ kind: 'pr', ref: c.ref, where: c.where, why: 'no readable session in this window recorded a link to it, a git fact about it, or a command on it' });
      } else if (c.kind === 'commit') {
        const refs = index.commitRefs.filter((r) => (r.via === 'harness-commit' || r.via === 'printed-output') && sameCommit(r.sha, c.sha));
        for (const r of refs) raw.push({ session: r.session, type: 'cited-commit', evidence: r.evidence, ...(r.rule ? { rule: r.rule } : {}), event: r.event, matched: `${c.sha}|${r.via}`, detail: { ref: c.ref, where: c.where, via: r.via } });
        if (!refs.length) unmatched.push({ kind: 'commit', ref: c.ref, where: c.where, why: 'no readable session in this window recorded this commit or printed it from a commit command' });
      }
    }

    // 3. Prompts that name the goal id, read in full while parsing.
    for (const e of promptsByToken.get(goal.id) ?? []) raw.push({ session: e.session, type: 'prompt-names-goal', evidence: EVIDENCE.INFERRED, rule: 'goal.prompt-names-id', event: e, matched: '', detail: {} });

    return {
      id: goal.id,
      title: typeof goal.title === 'string' ? goal.title : null,
      state: typeof goal.state === 'string' ? goal.state : null,
      members: groupMembers(raw, firstAtOf),
      unmatched,
    };
  });
}

/** One member per session; one join per (type, evidence, what it matched), counting
 *  the matches and keeping the earliest event. */
function groupMembers(raw, firstAtOf) {
  const bySession = new Map();
  for (const j of raw) {
    if (!bySession.has(j.session)) bySession.set(j.session, []);
    bySession.get(j.session).push(j);
  }
  const at = (j) => (j.event ? j.event.t : -Infinity);
  const tOf = new Map(raw.filter((j) => j.event).map((j) => [j.event.id, j.event.t]));
  const byEventTime = (a, b) => (tOf.get(a.event) ?? -Infinity) - (tOf.get(b.event) ?? -Infinity) || cmp(a.event ?? '', b.event ?? '');
  return [...bySession]
    .map(([session, list]) => {
      const joins = new Map();
      for (const j of [...list].sort((a, b) => at(a) - at(b) || cmp(a.event?.id ?? '', b.event?.id ?? ''))) {
        const k = [j.type, j.evidence, j.rule ?? '', j.matched, j.ambiguous ? JSON.stringify(j.ambiguous) : ''].join('|');
        const have = joins.get(k);
        if (have) {
          have.count += 1;
          continue;
        }
        joins.set(k, { type: j.type, evidence: j.evidence, ...(j.rule ? { rule: j.rule } : {}), event: j.event?.id ?? null, count: 1, ...(j.ambiguous ? { ambiguous: j.ambiguous } : {}), detail: j.detail });
      }
      // An ambiguous join ranks below every unambiguous one, inferred included, so a
      // member's level is never lifted by a join that may belong to another session.
      const rows = [...joins.values()].sort((a, b) => effectiveRank(a) - effectiveRank(b) || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || byEventTime(a, b));
      return { session, evidence: rows[0].evidence, ...(rows[0].ambiguous ? { ambiguous: true } : {}), joins: rows };
    })
    .sort((a, b) => cmp(firstAtOf(a.session) ?? '', firstAtOf(b.session) ?? '') || cmp(a.session, b.session));
}

/** One goal with its members' session rows and each rule's plain description. */
export function goalView(goal, sessionsByKey) {
  if (!goal) return null;
  return {
    ...goal,
    members: goal.members.map((m) => {
      const s = sessionsByKey.get(m.session);
      return {
        ...m,
        thread: s?.thread ?? null,
        tool: s?.tool ?? null,
        repo: s?.repo ?? null,
        title: s?.title ?? null,
        firstAt: s?.firstAt ?? null,
        lastAt: s?.lastAt ?? null,
        joins: m.joins.map((j) => (j.rule ? { ...j, ruleText: Object.values(describeRules(j.rule)).filter(Boolean).join(' ') || null } : j)),
      };
    }),
  };
}
