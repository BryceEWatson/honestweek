// One evidence vocabulary for every page: how each fact is known, in five words. Four of them have
// a small symbol (filled, half, ring, dashed ring) so the level never depends on colour; the fifth,
// "ambiguous", stays as a word. The word itself is always there: beside the symbol, or for a
// screen reader when only the symbol shows. The symbols are inline SVG markup, which the content
// policy allows (no style attribute, no script). Loaded by every page before its own script; it
// fills each [data-evkey] with the key, which the header's "?" button opens.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // The five words, and what each means, in the words every page uses.
  const LEVELS = {
    recorded: 'A log line or git says this directly.',
    derived: 'Worked out from recorded values only, with no interpretation.',
    inferred: 'A named rule decided this, and it could be wrong. The rule is shown with it.',
    missing: "Evidence the engine expected and didn't find in the logs.",
    ambiguous: 'The records fit more than one reading, such as a pull request number two repositories share. Shown whatever the level.',
  };
  // The short gloss in the key.
  const GLOSS = {
    recorded: 'a log or git says so',
    derived: 'worked out from records',
    inferred: 'a rule decided; could be wrong',
    missing: 'expected, not in the logs',
    ambiguous: 'fits more than one way',
  };
  const WORDS = Object.keys(LEVELS);
  const known = (level) => Object.prototype.hasOwnProperty.call(LEVELS, level);
  // Each symbol's shapes in a 12 by 12 box, drawn in the text's own colour.
  const SHAPES = {
    recorded: '<circle cx="6" cy="6" r="4.5" fill="currentColor"/>',
    derived: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor"/>',
    inferred: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    missing: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/>',
  };
  /** The symbol alone, hidden from a screen reader (the word goes beside it). Empty for "ambiguous". */
  const symbol = (level) => (SHAPES[level] ? `<svg class="evsym" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" focusable="false">${SHAPES[level]}</svg>` : '');
  /** A level as its symbol and its word, with an optional short note after it ("inferred · rule x"). */
  const chip = (level, extra = '') => {
    const more = extra !== '' && extra != null ? ` · ${esc(extra)}` : '';
    if (!known(level)) return `<span class="chip">${esc(level)}${more}</span>`;
    return `<span class="chip ${level}" title="${esc(LEVELS[level])}">${symbol(level)}${level}${more}</span>`;
  };
  /** A level as its symbol only, the word kept for a screen reader. "ambiguous" shows its word. */
  const sym = (level) => {
    if (!known(level)) return `<span class="chip">${esc(level)}</span>`;
    if (!SHAPES[level]) return chip(level);
    return `<span class="chip ${level} sym" title="${esc(`${level}: ${LEVELS[level]}`)}">${symbol(level)}<span class="sr">${level}</span></span>`;
  };
  /** A level, plus the ambiguous chip when the engine marks the link ambiguous. */
  const chips = (level, ambiguous, extra = '') => `${chip(level, extra)}${ambiguous ? ` ${chip('ambiguous')}` : ''}`;
  /** The weakest of several levels: a count is never labelled stronger than what it counts. */
  const RANK = { recorded: 0, derived: 1, inferred: 2, missing: 3 };
  const weakest = (levels) => levels.filter(known).sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0] ?? 'recorded';
  /** The key the header's "?" button opens: each word with its symbol and gloss, then what each means. */
  const keyHtml = () => `<span class="evkey-h">How each link is known</span>${WORDS.map((l) => `<span class="evkey-item">${chip(l)}<span class="gloss">${GLOSS[l]}</span></span>`).join('')}<details class="evkey-more"><summary>What these mean</summary><dl>${WORDS.map((l) => `<dt>${l}</dt><dd>${esc(LEVELS[l])}</dd>`).join('')}</dl></details>`;
  /** The same key as a side panel beside results: a list, not the header's [data-evkey]. */
  const sideKeyHtml = () => `<h2 class="keyside-h">How each link is known</h2><ul class="keyside-list">${WORDS.map((l) => `<li>${chip(l)}<span class="gloss">${GLOSS[l]}</span></li>`).join('')}</ul>`;
  const fill = () => document.querySelectorAll('[data-evkey]').forEach((el) => {
    if (!el.firstChild) el.innerHTML = keyHtml();
  });
  window.HWE = { LEVELS, WORDS, GLOSS, chip, chips, sym, symbol, weakest, keyHtml, sideKeyHtml, fill };
  fill();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
})();
