// lib/waiting.mjs: what's waiting on you, read from the same redacted history `honestweek view`
// builds (lib/replay/index.mjs) over every session on this machine in the window.
//
// Four kinds of row, each with its session's title, project, age, page and evidence word:
//
//   ask       a session whose turn ended on a question for you, and you typed nothing in its
//             thread after it. A question asked through the question tool and never answered is
//             recorded; one asked in plain text is inferred by the waiting.plain-ask rule.
//   stalled   a session that stopped mid-work and stayed quiet: its log ends on a call with no
//             result or on a message of yours it never answered (recorded end states). With
//             `promises` on, also one whose last message said what it would do next and then
//             went quiet (waiting.stalled-promise, inferred, off by default until it's judged).
//   pr        a pull request a session opened, that no session has touched since, that git
//             doesn't show landed and no session merged. It's called open only from a `gh pr
//             list` file you hand it; without one it's "last seen open".
//   unpushed  a commit a session made in a configured repository that no remote branch holds,
//             still on a local branch whose upstream wasn't deleted (derived, from local git).
//
// Read-only. It writes nothing, makes no network call, and never runs git against a display-only
// repository or a folder outside the config. Every quote passes the redactor and is cut, as the
// page shows it with Show private text off.
//
// Zero runtime dependencies: Node built-ins only.

import { hasRemoteBranch, landedPr, originSlug, refsContaining } from './git.mjs';
import { endsWithQuestion } from './problems/classify.mjs';
import { isExecInstruction, isPersonPrompt } from './problems/context.mjs';
import { cutRedacted } from './replay/word-index.mjs';
import { replayPage } from './view/page-link.mjs';

export const WAITING_SCHEMA = 'honestweek.waiting/1';
/** How long a session has to be quiet before a stop, a promise or a pull request counts. */
export const STALE_HOURS = 6;
/** How much of an ask is quoted. */
export const ASK_QUOTE_MAX = 300;
/** The order rows come in: what blocks on your word first. */
export const KIND_ORDER = Object.freeze(['ask', 'stalled', 'pr', 'unpushed']);

/** Each rule a row can name, in plain words, so a reader can judge it. */
export const WAITING_RULES = Object.freeze({
  'waiting.question-tool': { evidence: 'recorded', text: 'The session asked through its question tool, or asked you to approve its plan, and the log holds no answer. Listed at once, without waiting out the quiet time, so a session that closed with one still open shows too.' },
  'waiting.plain-ask': { evidence: 'inferred', text: "The main agent's last message in the thread asks you to reply with a word in backticks (reply, say, type or answer, then `word`), has a paragraph that leads with what's waiting on you (\"Waiting on you\", \"Blocking now\", \"Still open\", \"Your clicks still decide\", \"Start the ... chip\"), or ends on a question; and you typed nothing in the thread after it. A message that says \"Nothing needs you\" anywhere never counts, and neither does one that answers a program." },
  'waiting.cut-off': { evidence: 'recorded', text: 'The log ends on a call with no recorded result, and nothing was written for longer than the quiet time.' },
  'waiting.unanswered-prompt': { evidence: 'recorded', text: 'The log ends on a message from you that the agent never answered, and nothing was written for longer than the quiet time.' },
  'waiting.stalled-promise': { evidence: 'inferred', text: "The main agent's last message says what it will do next (I'll, I will, I'm going to, next I), its turn ended, and nothing was written for longer than the quiet time. Off unless asked for: how often it's right hasn't been judged." },
  'waiting.orphan-pr': { evidence: 'derived', text: "A session opened or linked this pull request, no session named it for longer than the quiet time, git doesn't show it landed on the default branch, and no session merged it. Open only when the --prs file says so." },
  'waiting.unpushed': { evidence: 'derived', text: "A commit a session made, in a repository that has a remote, that no remote-tracking branch holds, still on a local branch whose upstream wasn't deleted. Read from local git without fetching, so a push from another clone isn't seen." },
});

/** What this answer can't see, said once with every answer. */
export const WAITING_LIMITS = Object.freeze([
  'An answer you gave somewhere else (another session, a pull request, a chat) is not seen, so an ask you settled there still shows.',
  "Uncommitted work in a worktree isn't listed; a worktree sweep covers it.",
  "A pull request closed after the last session named it leaves no trace in the logs or local git, and git can't see one rebase-merged or merged since this checkout last fetched: without a --prs file each is \"last seen open\".",
  'Sessions a program started (claude -p, the Agent SDK, codex exec) answer to that program, so they are left out.',
  "A pull request in a repository whose GitHub name holds a private word is never checked: redacted, it can't be told apart from a repository that differs only in that word.",
]);

// ---- the plain-text ask rule ------------------------------------------------------------------

const NOTHING_NEEDS_YOU = /\bnothing (?:needs|is waiting on|is blocked on) you\b/i;
// A reply cue: reply, say, type or answer (with, back), then a word in backticks within the line.
// The cue starts a sentence or a list item, or follows you, just, please, then, or, and, to: so
// "say `merge`" and "when you say `ship`" count, and "the verdict doesn't say `x`" doesn't.
const REPLY_CUE = /(?:^|[.:;!?(*_]\s*|^\s*(?:[-*•+]|\d{1,2}[.)])\s+|\b(?:you|just|please|then|or|and|to|simply)\s+)(?:reply|say|type|answer|respond)(?:\s+(?:with|back(?:\s+with)?))?\b[^\n`]{0,60}`([^`\n]{1,40})`/i;
// The backticked words that follow a cue in the same line: "say `merge` or `skip`".
const MORE_WORDS = /`([^`\n]{1,40})`/g;
// A paragraph that leads with what's waiting on you: "Waiting on you:", "Blocking now", "Your clicks
// still decide the next step", "Still open, ranked:". Its backticked list items are the replies.
const WAIT_LEAD = /^\W*(?:waiting on you|waiting, not blocking|blocking now|blocked on you|needs you\b|needs your (?:word|click|clicks|answer|ok|approval|go-ahead)|still needs your word|your (?:clicks?|word|call|turn)\b[^.\n]{0,40}\b(?:decide|needed|next)|still open|(?:start|click) the\b[^.\n]{0,120}\bchip\b)/i;
// A list item that starts with a reply word: "- `daily`: lets the list refresh". A reply word is
// one to three plain words, so a file name, a flag or a code name isn't read as one.
const WORD_ITEM = /^\s*(?:[-*•+]|\d{1,2}[.)])\s+(?:\*\*)?`([a-z][a-z0-9 -]{0,30})`/i;
const REPLY_WORD = /^[a-z][a-z0-9-]*(?: [a-z0-9-]+){0,2}$/i;
// A promise of a next step, in the last paragraph.
const PROMISE = /\b(?:i'll|i will|i'm going to|i am going to|next,? i(?:'ll| will)?|will now)\s+(?:\w+\s+){0,2}?(?:check|run|merge|push|open|start|watch|report|wait|re-?run|retry|look|finish|continue|land|ship|post|update|fix)\b/i;

const stripFences = (text) => String(text ?? '').replace(/```[\s\S]*?(?:```|$)/g, ' ');
const paragraphs = (text) => stripFences(text).replace(/[’‘]/g, "'").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/**
 * askOf(text) -> { form: 'reply-word' | 'waiting-on-you' | 'question', words: string[], paragraph } | null
 * Whether an agent message asks the person something (the waiting.plain-ask rule). `words` are
 * the replies it named in backticks, in order, each once; `paragraph` is the first paragraph
 * that asks. A message that says nothing needs you never asks.
 */
export function askOf(text) {
  const paras = paragraphs(text);
  if (!paras.length || paras.some((p) => NOTHING_NEEDS_YOU.test(p))) return null;
  const words = [];
  const add = (w) => {
    if (!words.includes(w)) words.push(w);
  };
  let paragraph = null;
  let lead = null;
  for (const p of paras) {
    const led = WAIT_LEAD.test(p);
    if (led) lead ??= p;
    for (const line of p.split(/\r?\n/)) {
      const m = REPLY_CUE.exec(line);
      if (m) {
        paragraph ??= p;
        for (const w of line.slice(m.index).matchAll(MORE_WORDS)) add(w[1]);
        continue;
      }
      const item = led ? WORD_ITEM.exec(line) : null;
      if (item && REPLY_WORD.test(item[1].trim())) {
        paragraph ??= p;
        for (const w of line.matchAll(MORE_WORDS)) if (REPLY_WORD.test(w[1].trim())) add(w[1]);
      }
    }
  }
  if (words.length) return { form: 'reply-word', words, paragraph };
  if (lead) return { form: 'waiting-on-you', words: [], paragraph: lead };
  if (endsWithQuestion(stripFences(text))) return { form: 'question', words: [], paragraph: paras.at(-1) };
  return null;
}

/** Whether an agent message's last paragraph promises a next step (waiting.stalled-promise). */
export function promiseOf(text) {
  const last = paragraphs(text).at(-1);
  return last && PROMISE.test(last) ? last : null;
}

// ---- reading the history ----------------------------------------------------------------------

const rawText = (e) => (typeof e?._raw?.text === 'string' ? e._raw.text : typeof e?.facts?.text === 'string' ? e.facts.text : null);
const hours = (ms) => Math.round((ms / 3600000) * 10) / 10;

/** Who a session belongs with: the configured repository, a display-only one, or an outside folder. */
const groupOf = (s) => (!s.private ? 'configured' : s.repoRole === 'display' ? 'display' : 'outside');

/**
 * findWaiting({ h, config, redact, now, staleMs, promises, prs, git }) -> { rows, counts, notes }
 *   h         a history built with scope 'all' (the page's redacted build)
 *   redact    the page's redactor, for every quote taken from raw text
 *   prs       null, or { at, rows: [{ number, state, headRefName?, repo? }] } from a --prs file
 *   git       false to read no git at all (tests of the log-only rows)
 */
export function findWaiting({ h, config, redact = (s) => String(s), now = Date.now(), staleMs = STALE_HOURS * 3600000, promises = false, prs = null, git = true, app = new Map(), all = false }) {
  const notes = [];
  // The desktop app's sidebar title wins over the log's own, and a session you archived there
  // is done with: it's left out, and counted. When the app keeps any record, a Claude Code
  // session it doesn't list (a background or terminal one, such as a reviewer another session
  // started) reports to whoever started it, so it's left out too unless `all` asks for it.
  const appOf = (s) => {
    const id = h.claudeIds?.get(s.key);
    return id ? app.get(id) ?? null : null;
  };
  const sidebarOf = (s) => (s.tool === 'claude-code' && app.size ? !!appOf(s) : null);
  let archived = 0;
  let unlisted = 0;
  const sessions = h.sessions.filter((s) => {
    if (s.headless) return false;
    if (appOf(s)?.archived) {
      archived += 1;
      return false;
    }
    if (!all && sidebarOf(s) === false) {
      unlisted += 1;
      return false;
    }
    return true;
  });
  if (archived) notes.push({ kind: 'archived-sessions-left-out', count: archived });
  if (unlisted) notes.push({ kind: 'sessions-not-in-sidebar-left-out', count: unlisted });
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  // No title anywhere (a session started from a terminal, say): its first prompt's first line.
  const firstPrompt = (s) => {
    const e = h.events.find((x) => x.session === s.key && (isPersonPrompt(x) || x.kind === 'delegation-received') && typeof x.facts?.text === 'string' && x.facts.text.trim());
    return e ? cutRedacted(e.facts.text.trim().split(/\r?\n/)[0], 120) : null;
  };
  const titleOf = (s) => {
    const t = appOf(s)?.title;
    if (t) return { text: cutRedacted(redact(t), 200), from: 'app' };
    if (s.title) return { text: s.title, from: 'log' };
    const p = firstPrompt(s);
    return p ? { text: p, from: 'first-prompt' } : { text: null, from: null };
  };
  const eventsOf = new Map();
  for (const e of h.events) {
    if (!eventsOf.has(e.session)) eventsOf.set(e.session, []);
    eventsOf.get(e.session).push(e);
  }
  const quote = (s) => (typeof s === 'string' && s.trim() ? cutRedacted(redact(s.replace(/\s+/g, ' ').trim()), ASK_QUOTE_MAX) : null);
  const base = (s, at, extra = {}, title = titleOf(s)) => ({
    session: s.key,
    thread: s.thread ?? null,
    tool: s.tool ?? null,
    repo: s.repo ?? null,
    group: groupOf(s),
    title: title.text,
    titleFrom: title.from,
    sidebar: sidebarOf(s),
    at,
    ageHours: at ? hours(now - Date.parse(at)) : null,
    page: replayPage({ session: s.key, thread: s.thread, event: extra.event ?? null }),
    ...extra,
  });
  const rows = [];

  // One row per thread for asks and stops: the thread's newest session speaks for it, and a prompt
  // you typed anywhere in the thread after the ask answers it.
  const threads = new Map();
  for (const s of sessions) {
    const k = s.thread ?? s.key;
    if (!threads.has(k)) threads.set(k, []);
    threads.get(k).push(s);
  }
  for (const members of threads.values()) {
    const s = members.reduce((a, b) => ((b.lastAt ?? '') > (a.lastAt ?? '') ? b : a));
    const lastT = Date.parse(s.lastAt ?? '');
    const quiet = Number.isFinite(lastT) ? now - lastT : 0;
    const lastPromptT = Math.max(-Infinity, ...members.flatMap((m) => (eventsOf.get(m.key) ?? []).filter(isPersonPrompt).map((e) => e.t)));
    const main = `${s.key}:main`;
    const evs = (eventsOf.get(s.key) ?? []).filter((e) => e.agent === main || isPersonPrompt(e) || isExecInstruction(e));

    if (s.endState === 'last-record-is-a-call-without-result' || s.endState === 'last-record-is-an-unanswered-prompt') {
      const last = [...evs].reverse().find((e) => e.kind === 'action' || isPersonPrompt(e)) ?? null;
      // A question or a plan put to you with no answer is waiting on you now, without waiting out the quiet time.
      // Only the call itself still waiting counts: the end state may come from a helper's step.
      const decision = last?.kind === 'action' && !last.end && ['question', 'plan-approval'].includes(last.facts?.category) ? last.facts.category : null;
      if (decision) {
        rows.push(base(s, last.at, { kind: 'ask', rule: 'waiting.question-tool', evidence: 'recorded', event: last.id, asked: [], form: decision === 'question' ? 'question-tool' : decision, quote: null }));
      } else if (quiet >= staleMs) { // sooner, it's still running, most likely
        const rule = s.endState === 'last-record-is-an-unanswered-prompt' ? 'waiting.unanswered-prompt' : 'waiting.cut-off';
        rows.push(base(s, s.lastAt, { kind: 'stalled', rule, evidence: 'recorded', event: last?.id ?? null, asked: [], quote: rule === 'waiting.unanswered-prompt' && last ? quote(rawText(last)) : null }));
      }
      continue;
    }
    if (s.endState !== 'last-turn-ended') continue;
    // The main agent's last message, and what opened its turn.
    let msg = null;
    let opener = null;
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (!msg && e.kind === 'message') msg = e;
      if (msg && (isPersonPrompt(e) || isExecInstruction(e) || e.kind === 'agent-message' || e.kind === 'notification')) {
        opener = e;
        break;
      }
    }
    if (!msg) continue;
    // A reply to a program goes back to the program, not to you.
    if (opener && isExecInstruction(opener)) continue;
    if (lastPromptT > msg.t) continue;
    const text = rawText(msg);
    const ask = askOf(text);
    if (ask) {
      rows.push(base(s, msg.at, { kind: 'ask', rule: 'waiting.plain-ask', evidence: 'inferred', event: msg.id, asked: ask.words.map((w) => cutRedacted(redact(w), 40)), form: ask.form, quote: quote(ask.paragraph) }));
      continue;
    }
    if (promises && quiet >= staleMs) {
      const said = promiseOf(text);
      if (said) rows.push(base(s, msg.at, { kind: 'stalled', rule: 'waiting.stalled-promise', evidence: 'inferred', event: msg.id, asked: [], quote: quote(said) }));
    }
  }

  const states = prStates({ config, prs, git });
  // An ask that names a pull request merged or closed since may have been answered there: it
  // stays on the list, says so, and goes after the others.
  const reposOf = new Map();
  for (const e of h.events) {
    if (e.kind === 'link' && typeof e.facts?.repo === 'string') {
      if (!reposOf.has(e.session)) reposOf.set(e.session, new Set());
      reposOf.get(e.session).add(e.facts.repo);
    }
  }
  // The GitHub name of a configured repository git may read, by its label as rows show it.
  const slugs = new Map();
  const slugOf = (label) => {
    if (!git || !slugs.has(label)) {
      // Two labels that redact alike name neither.
      const found = git ? (config?.repos ?? []).filter((x) => x.role !== 'display' && redact(x.label) === label) : [];
      const slug = found.length === 1 ? originSlug(found[0].resolvedPath ?? found[0].path) : null;
      // Link events carry the redacted name, and a row prints it: the GitHub name is redacted too.
      slugs.set(label, slug ? redact(slug) : null);
    }
    return slugs.get(label);
  };
  for (const r of rows) {
    if (r.kind !== 'ask') continue;
    const repos = new Set(reposOf.get(r.session) ?? []);
    const own = r.repo ? slugOf(r.repo) : null;
    if (own) repos.add(own);
    const settled = repos.size ? settledBy([r.quote, r.title], [...repos], states) : null;
    if (settled) r.settled = { pr: settled };
  }
  rows.push(...orphanPrs({ h, byKey, now, staleMs, prs, states, base, notes }));
  if (git) rows.push(...unpushed({ h, byKey, config, redact, base, notes }));

  rows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || !!a.settled - !!b.settled || (a.ageHours ?? Infinity) - (b.ageHours ?? Infinity) || (a.session < b.session ? -1 : 1));
  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, rows.filter((r) => r.kind === k).length]));
  return { rows, counts, notes };
}

// ---- pull requests ------------------------------------------------------------------------------

const REDACTED_MARK = /\[redacted:/;
const prKey = (repo, n) => `${String(repo ?? '').toLowerCase()}#${n}`;

/**
 * prStates({ config, prs, git }) -> (repo, number) => { state, from } | null
 * What's known of one pull request: OPEN, MERGED or CLOSED from the --prs file, else MERGED or
 * NOT-LANDED from git, asked of a configured repository git may read (never a display-only one)
 * by its GitHub name. null when neither can say. Each answer is asked once.
 *
 * `repo` is the name the logs carry, already redacted. When the redactor changed it, it can't be
 * told apart from any other repository, configured or not, whose name differs only in a private
 * word (every private word becomes the same mark), so it's never answered: the caller counts it
 * as not checked rather than borrow another repository's state.
 */
export function prStates({ config, prs, git }) {
  const readable = new Map();
  if (git) {
    for (const r of config?.repos ?? []) {
      if (r.role === 'display') continue;
      const slug = originSlug(r.resolvedPath ?? r.path);
      if (slug) readable.set(slug.toLowerCase(), r);
    }
  }
  const fileRows = Array.isArray(prs?.rows) ? prs.rows : null;
  const cache = new Map();
  const lookup = (repo, number) => {
    if (REDACTED_MARK.test(repo)) return null;
    if (fileRows) {
      const match = fileRows.filter((r) => r.number === number && (r.repo ? r.repo.toLowerCase() === repo.toLowerCase() : true));
      // A row with no repository counts only when it's the only row with that number.
      const pick = match.find((r) => r.repo) ?? (match.length === 1 ? match[0] : null);
      const state = pick ? String(pick.state ?? '').toUpperCase() : '';
      if (['OPEN', 'MERGED', 'CLOSED'].includes(state)) return { state, from: 'prs-file' };
    }
    const r = readable.get(repo.toLowerCase());
    if (!r) return null;
    const landed = landedPr(r.resolvedPath ?? r.path, number, config.identity?.authorEmails);
    if (landed?.unreadable) return null;
    return { state: landed ? 'MERGED' : 'NOT-LANDED', from: 'git' };
  };
  return (repo, number) => {
    if (typeof repo !== 'string' || !Number.isInteger(number)) return null;
    const k = prKey(repo, number);
    if (!cache.has(k)) cache.set(k, lookup(repo, number));
    return cache.get(k);
  };
}

// "PR 175", "PR #175", "pull request 175": a pull request an ask names.
const NAMED_PR = /\b(?:PR|pull request)\s*#?(\d{1,6})\b/gi;

/**
 * settledBy(texts, repos, states) -> { repo, number, state, from } | null
 * The first pull request an ask names (in its quote or its title) that has merged or closed
 * since, in a repository the session linked or works in. The ask may have been answered there.
 */
function settledBy(texts, repos, states) {
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(NAMED_PR)) {
      for (const repo of repos) {
        const st = states(repo, Number(m[1]));
        if (st && (st.state === 'MERGED' || st.state === 'CLOSED')) return { repo, number: Number(m[1]), ...st };
      }
    }
  }
  return null;
}

function orphanPrs({ h, byKey, now, staleMs, prs, states, base, notes }) {
  // Every recorded mention of a pull request: the harness's link names its repository; a git step
  // names only a number, so it counts for the repository a link in the same session gave that
  // number, or else for the one pull request anywhere with that number.
  const seen = new Map();
  const linkedRepo = new Map();
  for (const e of h.events) {
    if (e.kind === 'link' && Number.isInteger(e.facts?.pr) && typeof e.facts.repo === 'string') linkedRepo.set(`${e.session}#${e.facts.pr}`, e.facts.repo);
  }
  const mention = (repo, n, e, action) => {
    const k = prKey(repo, n);
    const x = seen.get(k) ?? { repo, number: n, first: e, last: e, merged: false, created: false };
    if (e.t < x.first.t) x.first = e;
    if (e.t >= x.last.t) x.last = e;
    if (action === 'merged') x.merged = true;
    if (action === 'created' || action === 'linked') x.created = true;
    seen.set(k, x);
  };
  const unnamed = [];
  for (const e of h.events) {
    if (e.kind === 'link' && Number.isInteger(e.facts?.pr) && typeof e.facts.repo === 'string') mention(e.facts.repo, e.facts.pr, e, 'linked');
    else if (e.kind === 'action' && Number.isInteger(e.facts?.git?.pr?.number)) {
      const n = e.facts.git.pr.number;
      const action = String(e.facts.git.pr.action ?? '').toLowerCase();
      const repo = linkedRepo.get(`${e.session}#${n}`);
      if (repo) mention(repo, n, e, action);
      else unnamed.push({ n, e, action });
    }
  }
  for (const { n, e, action } of unnamed) {
    const same = [...seen.values()].filter((x) => x.number === n);
    if (same.length === 1) mention(same[0].repo, n, e, action);
  }

  const out = [];
  let unchecked = 0;
  for (const x of seen.values()) {
    if (!x.created || x.merged) continue;
    if (now - x.last.t < staleMs) continue;
    const s = byKey.get(x.last.session);
    if (!s) continue;
    const st = states(x.repo, x.number);
    if (!st) {
      unchecked += 1;
      continue;
    }
    if (st.state === 'MERGED' || st.state === 'CLOSED') continue;
    const open = st.state === 'OPEN';
    out.push(base(s, x.last.at, {
      kind: 'pr',
      rule: 'waiting.orphan-pr',
      evidence: open ? 'recorded' : 'derived',
      event: x.last.id,
      asked: [],
      quote: null,
      pr: { repo: x.repo, number: x.number, state: open ? 'open' : 'last-seen-open', stateFrom: st.from, ...(open && prs?.at ? { fileAt: prs.at } : {}) },
    }));
  }
  if (unchecked) notes.push({ kind: 'prs-not-checked', count: unchecked });
  return out;
}

/**
 * readPrsFile(text, mtime) -> { at, rows } | throws
 * `gh pr list --json number,headRefName,state[,url]` output, or several of them joined into one
 * array. A row's repository comes from its url when there is one.
 */
export function readPrsFile(text, at) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the --prs file isn't JSON. Make it with gh pr list --state all --json number,headRefName,state,url.");
  }
  if (!Array.isArray(parsed)) throw new Error('the --prs file should hold a list, as gh pr list --json prints.');
  const rows = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.number)) continue;
    const repo = typeof r.url === 'string' ? r.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? null : typeof r.repository?.nameWithOwner === 'string' ? r.repository.nameWithOwner : null;
    rows.push({ number: r.number, state: typeof r.state === 'string' ? r.state : null, headRefName: typeof r.headRefName === 'string' ? r.headRefName : null, repo });
  }
  return { at, rows };
}

// ---- unpushed commits ---------------------------------------------------------------------------

function unpushed({ h, byKey, config, redact, base, notes }) {
  // Only configured repositories git may read. The outcome events carry the configured label as
  // written, so it's matched as written and redacted wherever a row or a note prints it.
  const repoByLabel = new Map();
  // The engine's backstop redacts every string fact, the label included, so a label with a
  // private word arrives redacted: it's matched in either form, and two labels that redact alike
  // match neither.
  for (const r of config?.repos ?? []) {
    if (r.role === 'display') continue;
    repoByLabel.set(r.label, r);
    const red = redact(r.label);
    if (red !== r.label) repoByLabel.set(red, repoByLabel.has(red) && repoByLabel.get(red) !== r ? null : r);
  }
  const out = [];
  const asked = new Set();
  // A repository with no remote at all is local by design: nothing in it is waiting to be pushed.
  const hasRemote = new Map();
  const remoteOf = (repo) => {
    if (!hasRemote.has(repo.label)) hasRemote.set(repo.label, hasRemoteBranch(repo.resolvedPath ?? repo.path));
    return hasRemote.get(repo.label);
  };
  for (const e of h.events) {
    if (e.kind !== 'outcome' || e.facts?.outcome !== 'commit-exists' || e.facts.onDefaultBranch !== false || e.facts.authoredByConfiguredIdentity !== true) continue;
    const repo = repoByLabel.get(e.facts.repo);
    const s = byKey.get(e.session);
    if (!repo || !s || s.private || s.headless) continue;
    const sha = e.refs?.[0]?.sha;
    const k = `${repo.label}|${sha}`;
    if (!sha || asked.has(k)) continue;
    asked.add(k);
    if (!remoteOf(repo)) continue;
    const refs = refsContaining(repo.resolvedPath ?? repo.path, sha);
    if (!refs) {
      notes.push({ kind: 'git-unreadable', repo: redact(e.facts.repo), sha: e.facts.sha });
      continue;
    }
    // On a remote branch: pushed. On no branch: rewritten or deleted, not waiting. Only on
    // branches whose upstream is gone: merged and cleaned up, most often.
    if (refs.remote || !refs.heads.length || refs.heads.every((b) => b.gone)) continue;
    out.push(base(s, e.at, { kind: 'unpushed', rule: 'waiting.unpushed', evidence: 'derived', event: e.facts.nominatedBy ?? null, asked: [], quote: null, commit: { repo: redact(e.facts.repo), sha: e.facts.sha, subject: e.facts.subject ?? null, branches: refs.heads.filter((b) => !b.gone).map((b) => redact(b.name)) } }));
  }
  return out;
}
