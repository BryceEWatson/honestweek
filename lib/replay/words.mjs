// lib/replay/words.mjs: phrase search over a built work history, for `honestweek view`'s Find
// page and the `find` command alike, so both read one implementation.
//
// Words match only sessions in configured repositories: a display-only or outside session never
// joins a lookup, whichever build answers. Goal titles and ids match when the history was built
// with a goal record. Each match says how it's known: words in a prompt, a title or a branch are
// recorded there; ranking prompts by how many of the words they share is a named rule's reading.
// Nothing here redacts: the history's strings already passed its redactor, and each caller shapes
// and scrubs its own answer. "Search everywhere", which reads every session's prompts again from
// the logs, is lib/replay/word-index.mjs.
//
// Zero runtime dependencies: Node built-ins only.

/** The rules behind word matches, beside the engine's own. Their ids keep the `view.` prefix
 *  they were first published under. */
export const WORD_RULES = Object.freeze({
  'view.shared-words': 'A prompt shares some of the words you typed. The score counts how many of your words appear in it as whole words; sharing words doesn\'t mean it was about the same thing.',
  'view.similar-prompt': 'Two prompts share a large part of their words (the shared words divided by all the words either uses). Similar wording doesn\'t mean similar work.',
});

/** The most prompts one word search returns, and the most a "similar prompts" answer does. */
export const MAX_PROMPTS = 20;
export const MAX_SIMILAR = 10;
/** The least share of words two prompts need to count as similar. */
export const SIMILAR_MIN = 0.2;

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'so', 'that', 'the', 'then', 'this', 'to', 'up', 'we', 'with', 'you', 'your', 'i', 'redacted']);
const MARKERS = /\[redacted:[a-z]+\]/g;

/** Lowercased words of a text, its redaction markers taken out first. */
export function wordsOf(text) {
  return (String(text ?? '').replace(MARKERS, ' ').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? []).filter((w) => w.length >= 2 && !STOP.has(w));
}

const PR_RE = /^(?:(?:[\w.-]+\/)?[\w.-]+#|pr\s*#?\s*|pull\/|#)(\d+)$/i;
const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i;

/**
 * Whether `text` reads as a reference (a pull request, a commit, a file or a branch) rather than
 * words: the Find page's rule (isRef in lib/view/assets/search.js, which keeps its own copy),
 * plus the `pr:`, `pull:`, `commit:` and `path:` prefixes the find command names, so a prefix
 * always makes it a reference.
 */
export function isReference(text) {
  const q = String(text ?? '').trim();
  if (/^(pr|pull|commit|path):/i.test(q)) return true;
  return PR_RE.test(q) || PR_URL.test(q) || /^[0-9a-f]{7,40}$/i.test(q) || /^(file|branch):/i.test(q) || (!/\s/.test(q) && (/[\\/]/.test(q) || /^[\w.-]+\.[a-z0-9]{1,6}$/i.test(q)));
}

/** The prompts a word search reads: those with text, in sessions in configured repositories. */
export function readablePrompts(h) {
  const readable = new Set(h.sessions.filter((s) => s.private === false).map((s) => s.key));
  return h.events.filter((e) => readable.has(e.session) && e.kind === 'prompt' && typeof e.facts?.text === 'string' && e.facts.text);
}

/**
 * matchWords(h, text) -> { want, goals, sessions, branches, prompts }
 *   want      the query's words (wordsOf), each once
 *   goals     [{ index, matchedIn: 'title' | 'id' }], an index into h.goals, for a goal whose
 *             title or id holds every word
 *   sessions  [key] of configured sessions whose title holds every word
 *   branches  [{ branch, sessions: [{ session, event }] }] for each branch name (pushed, checked
 *             out, or the session's mode) holding the text, with each session's first such step
 *   prompts   [{ event, shared }] up to MAX_PROMPTS prompts sharing any of the words, most shared
 *             first, then newest; `event` is the history's own event
 */
export function matchWords(h, text) {
  const q = String(text ?? '');
  const want = [...new Set(wordsOf(q))];
  const low = q.toLowerCase();
  const has = (t) => want.length > 0 && want.every((w) => String(t ?? '').toLowerCase().includes(w));
  const goals = (h.goals ?? []).flatMap((g, index) => {
    const inTitle = has(g.title);
    return inTitle || has(g.id) ? [{ index, matchedIn: inTitle ? 'title' : 'id' }] : [];
  });
  const sessions = h.sessions.filter((s) => s.private === false && s.title && has(s.title)).map((s) => s.key);
  const readable = new Set(h.sessions.filter((s) => s.private === false).map((s) => s.key));
  const branchMap = new Map();
  for (const e of h.events) {
    if (!readable.has(e.session)) continue;
    const f = e.facts ?? {};
    for (const b of [f.git?.push?.branch, f.git?.branch?.ref, e.kind === 'mode' ? f.branch : null]) {
      if (typeof b !== 'string' || !b || !b.toLowerCase().includes(low)) continue;
      if (!branchMap.has(b)) branchMap.set(b, new Map());
      if (!branchMap.get(b).has(e.session)) branchMap.get(b).set(e.session, e.id);
    }
  }
  const branches = [...branchMap].map(([branch, bySession]) => ({ branch, sessions: [...bySession].map(([session, event]) => ({ session, event })) }));
  const prompts = readablePrompts(h)
    .map((e) => {
      const theirs = new Set(wordsOf(e.facts.text));
      return { event: e, shared: want.filter((w) => theirs.has(w)).length };
    })
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.event.t - a.event.t)
    .slice(0, MAX_PROMPTS);
  return { want, goals, sessions, branches, prompts };
}

/**
 * similarPrompts(h, eventId) -> null when no readable prompt has that id, else
 * [{ event, score }]: up to MAX_SIMILAR other prompts sharing at least SIMILAR_MIN of their
 * words with it (shared words over all the words either uses), most similar first, then newest.
 */
export function similarPrompts(h, eventId) {
  const prompts = readablePrompts(h);
  const base = prompts.find((e) => e.id === eventId);
  if (!base) return null;
  const mine = new Set(wordsOf(base.facts.text));
  return prompts
    .filter((e) => e.id !== base.id)
    .map((e) => {
      const theirs = new Set(wordsOf(e.facts.text));
      let shared = 0;
      for (const w of theirs) if (mine.has(w)) shared += 1;
      const union = mine.size + theirs.size - shared;
      return { event: e, score: union ? shared / union : 0 };
    })
    .filter((x) => x.score >= SIMILAR_MIN)
    .sort((a, b) => b.score - a.score || b.event.t - a.event.t)
    .slice(0, MAX_SIMILAR);
}
