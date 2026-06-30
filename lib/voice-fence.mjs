// lib/voice-fence.mjs — the opt-in AUTHORED-PROSE honesty lint.
//
// honestweek is "honest by construction": build re-derives every number, the
// fact-fence (lib/site/fact-fence.mjs) fences numerals in authored prose, and
// validate.mjs checks badges/receipts. The one thing a human still authors freely
// is the PROSE VOICE — and a whole class of self-undermining phrasing passes every
// existing check:
//   - WITHHOLDING-NARRATION — prose that narrates its own restraint instead of just
//     being generic ("keeping the specifics sealed", "kept generic here", "not
//     public-facing"). An honest log shows restraint through generic wording; it
//     never announces the withholding.
//   - PAGE-HONESTY META — prose that announces the page's own honesty/format ("show
//     the work honestly, receipts and retractions included", "belongs in an honest
//     log"). The badges and receipts ARE the honesty; saying so reads as performance.
//
// This lint is the PROSE analogue of the numeric fact-fence: when enabled, a match
// in an authored-prose field makes build ABORT (exit 2, write nothing). It is
//   - OFF BY DEFAULT (config.voice.denyMeta) — an existing consumer is never surprised;
//   - CONFIGURABLE — a consumer extends the denylist (voice.denyPhrases) and can carve
//     out a false positive (voice.allowPhrases) without disabling the whole lint;
//   - SCOPED TO AUTHORED PROSE ONLY — item title/summary/text + the curated content/
//     projects editorial — and NEVER to verified evidence snippets/receipts, where a
//     word like "sealed" can legitimately appear in a pre-registration record.
//
// checkVoice is PURE (collects, never throws); build owns the exit-2 abort, exactly
// as it owns verify-or-abort over verifyItems. Zero runtime dependencies.

// The authored-prose fields read off each ITEM. Items carry evidence/metadata
// siblings (receipt, commit, status, repo, …), so the prose surface is an
// allowlist — mirrors validate.mjs reading `text ?? summary`, never a snippet.
export const ITEM_PROSE_FIELDS = Object.freeze(['title', 'summary', 'text']);

// Keys whose SUBTREE is never descended into, anywhere. These hold verified
// evidence / provenance, not authored voice — a denylisted word inside one of them
// (e.g. "sealed" in a quoted pre-registration snippet) must pass. The curated
// content/projects walk is "all prose EXCEPT these"; that is the structural
// "never scan evidence" guarantee. (Mirrors the evidence fields validate.mjs's
// citedShas() already enumerates: commit(s), primaryCommit, candidateCommits, …)
export const EVIDENCE_KEYS = Object.freeze([
  'receipt', 'receipts', 'snippet', 'snippets', 'evidence', 'proof',
  'commit', 'commits', 'primaryCommit', 'candidateCommits', 'sha', 'shas',
]);
const EVIDENCE_SET = new Set(EVIDENCE_KEYS);

// === The built-in denylist — a maintainable, documented regex list. ===
// Each entry is { re, rule }: `re` is global+case-insensitive (so every match in a
// leaf is found and its span is known for the allowPhrases carve-out); `rule` names
// the voice rule, surfaced in the abort so a consumer knows WHY a phrase fired.
//
// The regexes are deliberately CONTEXTUAL, not bare words: they capture the
// withholding/meta INTENT and catch paraphrases, while letting an innocuous use of
// a trigger word pass (a "sealed-bid auction", an "honest mistake", a "generic
// helper", "surfaced a bug"). They are not exhaustive — a consumer extends the list
// via voice.denyPhrases and carves out a false positive via voice.allowPhrases.
export const DEFAULT_DENY_PHRASES = Object.freeze([
  // --- Withholding-narration: prose that narrates what it is NOT saying. ---
  // "keeping the specifics sealed", "details remain sealed", "kept ... sealed" — a
  // withholding verb governing "sealed" (so "a sealed-bid auction" does not match).
  { re: /\b(?:keep(?:ing|s)?|kept|stay(?:s|ing)?|remain(?:s|ing|ed)?|leav(?:e|ing)|left|held|holding)\b[^.!?\n]{0,40}?\bsealed\b/i, rule: 'withholding:sealed' },
  // "keeping it generic", "kept it private", "stays deliberately vague".
  { re: /\b(?:keep(?:ing|s)?|kept|stay(?:s|ing)?|remain(?:s|ing|ed)?|held)\b[^.!?\n]{0,24}?\b(?:generic|private|vague)\b/i, rule: 'withholding:kept-generic' },
  // "kept generic here", "generic here".
  { re: /\bgeneric\s+here\b/i, rule: 'withholding:generic-here' },
  // "not public-facing" / "not public facing".
  { re: /\bnot\s+public[-\s]?facing\b/i, rule: 'withholding:not-public-facing' },
  // "the specifics are folded away", "folded away here".
  { re: /\bfolded\s+away\b/i, rule: 'withholding:folded-away' },
  // "kept under wraps", "under wraps for now" (paraphrase).
  { re: /\bunder\s+wraps\b/i, rule: 'withholding:under-wraps' },

  // --- Page-honesty meta: prose that announces the page's own honesty/format. ---
  // "show the work honestly", "showing the work honestly", "shown honestly".
  { re: /\bshow(?:ing|s|n|ed)?\b[^.!?\n]{0,24}?\bhonestly\b/i, rule: 'meta:show-honestly' },
  // "receipts and retractions (included)".
  { re: /\breceipts\s+and\s+retractions\b/i, rule: 'meta:receipts-and-retractions' },
  // "belongs in an honest log", "an honest log".
  { re: /\bhonest\s+log\b/i, rule: 'meta:honest-log' },
  // "what gets surfaced here", "worth surfacing here".
  { re: /\bsurfac(?:e|es|ed|ing)\s+here\b/i, rule: 'meta:surfaced-here' },
  // "recording only the kind of work (worth showing)" + sort/type paraphrases.
  { re: /\brecord(?:ing|s|ed)?\s+only\s+the\s+(?:kind|sort|type)\s+of\s+work\b/i, rule: 'meta:recording-only' },
  // Self-referential "this page/log/report … honest/honestly".
  { re: /\bthis\s+(?:page|log|report|feed|entry)\b[^.!?\n]{0,40}?\bhonest(?:ly)?\b/i, rule: 'meta:this-page-honest' },
]);

/** Escape a literal string so it can be a RegExp source (consumer denyPhrases are
 *  matched literally — no invalid-regex / ReDoS risk from config). */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compose the active denylist: the built-in regexes plus the consumer's literal
 *  denyPhrases (case-insensitive substrings), tagged rule `custom`. */
function buildDenylist(denyPhrases = []) {
  const list = [...DEFAULT_DENY_PHRASES];
  for (const p of Array.isArray(denyPhrases) ? denyPhrases : []) {
    if (typeof p === 'string' && p.trim()) list.push({ re: new RegExp(escapeRegExp(p), 'i'), rule: 'custom' });
  }
  return list;
}

/** All [start, end) spans where any allowPhrase occurs in `value` (case-insensitive).
 *  A deny-match whose span lies within one of these is carved out — surgical to the
 *  match, not a blanket exemption of the whole leaf. */
function allowedSpans(value, allowPhrases = []) {
  const spans = [];
  const hay = value.toLowerCase();
  for (const p of Array.isArray(allowPhrases) ? allowPhrases : []) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const needle = p.toLowerCase();
    let from = 0;
    let at;
    while ((at = hay.indexOf(needle, from)) !== -1) {
      spans.push([at, at + needle.length]);
      from = at + Math.max(1, needle.length);
    }
  }
  return spans;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively collect every string leaf under `value`, skipping EVIDENCE_KEYS
 *  subtrees. Used for the curated content/projects editorial, whose field shape the
 *  engine does not define — so prose is found by content, not by a guessed name. */
function walkProse(value, ref, out, path) {
  if (typeof value === 'string') {
    out.push({ ref, field: path.split('.').pop() || ref, path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkProse(v, ref, out, `${path}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (EVIDENCE_SET.has(k)) continue; // never descend into evidence
      walkProse(value[k], ref, out, path ? `${path}.${k}` : k);
    }
  }
}

/**
 * collectAuthoredProse({ items, content, projects }) -> [{ ref, field, path, value }]
 *
 * The authored-prose surface the lint scans:
 *   - items: an ALLOWLIST of ITEM_PROSE_FIELDS only, keyed by item identity
 *     (id, else `item[i]`) so the abort names a human-identifiable offender —
 *     never an item's receipt/commit/snippet (those are not prose fields here);
 *   - content + projects: the curated editorial. ALL string leaves, skipping
 *     EVIDENCE_KEYS subtrees — so project mission/frontier/blurb (or whatever a
 *     consumer names them) are covered by content, and an embedded snippet/receipt
 *     is not.
 */
export function collectAuthoredProse({ items, content, projects } = {}) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((item, i) => {
    if (!isPlainObject(item)) return;
    const ref = item.id != null && String(item.id).trim() ? String(item.id) : `item[${i}]`;
    for (const field of ITEM_PROSE_FIELDS) {
      const v = item[field];
      if (typeof v === 'string') out.push({ ref, field, path: `${ref}.${field}`, value: v });
    }
  });
  if (content != null) walkProse(content, 'content', out, 'content');
  if (projects != null) walkProse(projects, 'projects', out, 'projects');
  return out;
}

/**
 * checkVoice(sources, { denyPhrases, allowPhrases }) -> violations[]
 *
 * PURE — collects every voice violation and NEVER throws / exits (the build owns the
 * abort, exactly as it owns verify-or-abort over verifyItems). `sources` is the
 * authored input `{ items, content, projects }`. Returns one violation per matched
 * leaf×pattern: `{ ref, field, path, phrase, rule }` (`phrase` is the literal matched
 * text — already authored, so naming it cannot leak anything redaction would catch,
 * and on a violation nothing is ever emitted). An allowPhrases-covered match is
 * dropped.
 */
export function checkVoice(sources, { denyPhrases = [], allowPhrases = [] } = {}) {
  const denylist = buildDenylist(denyPhrases);
  const violations = [];
  for (const leaf of collectAuthoredProse(sources)) {
    const spans = allowedSpans(leaf.value, allowPhrases);
    for (const { re, rule } of denylist) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const m of leaf.value.matchAll(global)) {
        const start = m.index;
        const end = start + m[0].length;
        const allowed = spans.some(([s, e]) => s <= start && end <= e);
        if (allowed) continue;
        violations.push({ ref: leaf.ref, field: leaf.field, path: leaf.path, phrase: m[0], rule });
      }
    }
  }
  return violations;
}
