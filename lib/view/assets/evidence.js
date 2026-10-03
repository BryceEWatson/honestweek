// One evidence vocabulary for every page: how each fact is known, in five words. Each word has
// its own mark (filled, half, hollow, dotted, double) so the level never depends on color.
// Loaded by every page before its own script; it fills each [data-evkey] with the one-line key.
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
  // The short gloss in the one-line key under each page header.
  const GLOSS = {
    recorded: 'a log or git says so',
    derived: 'worked out from records',
    inferred: 'a rule decided; could be wrong',
    missing: 'expected, not in the logs',
    ambiguous: 'fits more than one way',
  };
  const WORDS = Object.keys(LEVELS);
  const known = (level) => Object.prototype.hasOwnProperty.call(LEVELS, level);
  /** A chip for one level, with an optional short note after it ("inferred · rule x"). */
  const chip = (level, extra = '') => {
    const more = extra !== '' && extra != null ? ` · ${esc(extra)}` : '';
    if (!known(level)) return `<span class="chip">${esc(level)}${more}</span>`;
    return `<span class="chip ${level}" title="${esc(LEVELS[level])}"><span class="dot" aria-hidden="true"></span>${level}${more}</span>`;
  };
  /** A level, plus the ambiguous chip when the engine marks the link ambiguous. */
  const chips = (level, ambiguous, extra = '') => `${chip(level, extra)}${ambiguous ? ` ${chip('ambiguous')}` : ''}`;
  /** The weakest of several levels: a count is never labelled stronger than what it counts. */
  const RANK = { recorded: 0, derived: 1, inferred: 2, missing: 3 };
  const weakest = (levels) => levels.filter(known).sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0] ?? 'recorded';
  const keyHtml = () => `<span class="evkey-h">How it's known:</span>${WORDS.map((l) => `<span class="evkey-item">${chip(l)}<span class="gloss">${GLOSS[l]}</span></span>`).join('')}<details class="evkey-more"><summary>What these mean</summary><dl>${WORDS.map((l) => `<dt>${l}</dt><dd>${esc(LEVELS[l])}</dd>`).join('')}</dl></details>`;
  const fill = () => document.querySelectorAll('[data-evkey]').forEach((el) => {
    if (!el.firstChild) el.innerHTML = keyHtml();
  });
  window.HWE = { LEVELS, WORDS, chip, chips, weakest, keyHtml, fill };
  fill();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
})();
