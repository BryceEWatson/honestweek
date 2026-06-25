// lib/site/fact-fence.mjs — the deterministic post-emit honesty backstop.
//
// After the artifact is built, the fact-fence re-scans the FINAL value tree and
// refuses to let any number through that is not traceable to a verified value —
// regardless of what the adapter or the model said. It closes two real gaps:
//   - redact.mjs passes numbers through unchanged (redact.mjs:221), so a number is
//     never scrubbed; here every numeric leaf must byte-match a verified value.
//   - validate.mjs checks badges/receipts but not numerals inside authored prose;
//     here every numeral (incl. comma-grouped and spelled-out compounds) in a
//     freetext/model string must trace to a verified value too.
// A violation throws FactFenceError; the build maps it to exit 2 and writes nothing
// (verify-or-abort). This is the mechanism that makes intelligent generation safe.
//
// Zero runtime dependencies: Node built-ins only.

/** Spelled-out number words, composed (not token-by-token) so "two hundred" reads
 *  as 200 and "twenty three" as 23 — the actual claimed quantity is what's checked. */
const SMALL = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11],
  ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15], ['sixteen', 16],
  ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
]);
const TENS = new Map([
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60],
  ['seventy', 70], ['eighty', 80], ['ninety', 90],
]);
const SCALES = new Map([['thousand', 1000], ['million', 1000000], ['billion', 1000000000]]);
const CONNECTORS = new Set(['and']); // keeps "two hundred and twenty" a single run

/** A fact-fence violation. Tagged so the build can map it to exit 2. */
export class FactFenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FactFenceError';
    this.factFence = true;
  }
}

/** Visit EVERY number-typed leaf in `value` (finite or not), with its path. The
 *  single number-tree walker — callers decide policy (collect vs. fence). */
export function walkNumbers(value, visit, path = '') {
  if (typeof value === 'number') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkNumbers(v, visit, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) walkNumbers(value[k], visit, path ? `${path}.${k}` : k);
  }
}

// Tokens whose digits are NOT a work-claim and must not be read as a stated
// quantity: ISO datetimes/dates (a date is not a count) and hex SHAs (the
// receipts). They are removed BEFORE quantity extraction, so a trusted derived
// date string ("2024-06-10") or a sha can be prose-scanned without a false abort,
// while a real quantity beside one ("shipped 2024-06-10, 50 commits" -> 50) is
// still caught. A bare year ("over 2024 commits") is NOT a date token and is still
// checked — date EXEMPTION is deliberately narrow (a full ISO token only).
const NON_CLAIM_TOKENS = [
  /\d{4}-\d{2}-\d{2}T[0-9:.,+\-Z]*/gi, // ISO datetime
  /\d{4}-\d{2}-\d{2}/g, // ISO date
  /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, // hex SHA (≥1 letter, so pure-digit counts survive)
];

/** Yield every numeric quantity STATED in `text` — comma-grouped digit runs and
 *  composed spelled-out quantities. Best-effort and errs strict: a quantity it
 *  recognizes must be verified, so an unverified claim cannot hide in prose. */
export function* numbersInProse(text) {
  // Strip date/datetime/sha tokens first so their digits aren't read as claims.
  let scanText = String(text);
  for (const re of NON_CLAIM_TOKENS) scanText = scanText.replace(re, ' ');

  // Digit runs, including comma-grouped thousands: "1,200" -> 1200 (one quantity).
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(scanText)) !== null) yield Number(m[0].replace(/,/g, ''));

  // Spelled-out runs, composed: "two hundred" -> 200, "one thousand two" -> 1002.
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const composed = [];
  let total = 0;
  let partial = 0;
  let has = false;
  const flush = () => {
    if (has) composed.push(total + partial);
    total = 0;
    partial = 0;
    has = false;
  };
  for (const w of words) {
    if (SMALL.has(w)) {
      partial += SMALL.get(w);
      has = true;
    } else if (TENS.has(w)) {
      partial += TENS.get(w);
      has = true;
    } else if (w === 'hundred') {
      partial = (partial === 0 ? 1 : partial) * 100;
      has = true;
    } else if (SCALES.has(w)) {
      total += (partial === 0 ? 1 : partial) * SCALES.get(w);
      partial = 0;
      has = true;
    } else if (CONNECTORS.has(w)) {
      // a connector inside a number run ("two hundred and twenty") — keep the run
    } else {
      flush();
    }
  }
  flush();
  for (const n of composed) yield n;
}

/**
 * factFence(artifact, verifiedNumbers, proseLeaves) -> void (throws FactFenceError).
 *
 * `verifiedNumbers` is the Set of legitimate numbers (from the verified model).
 * `proseLeaves` are the authored (freetext) / model-distilled string leaves, the
 * only strings whose embedded numerals are checked — derived strings (dates,
 * labels) are trusted because they came from the verified model.
 */
export function factFence(artifact, verifiedNumbers, proseLeaves = []) {
  walkNumbers(artifact, (n, path) => {
    if (!Number.isFinite(n)) {
      throw new FactFenceError(
        `site: ABORTED — non-finite number (${String(n)}) at ${path || '<root>'} cannot be a verified value. Nothing written.`
      );
    }
    if (!verifiedNumbers.has(n)) {
      throw new FactFenceError(
        `site: ABORTED — number ${n} at ${path || '<root>'} is not traceable to a verified value. Nothing written.`
      );
    }
  });
  for (const { path, value } of proseLeaves) {
    for (const n of numbersInProse(String(value))) {
      if (!verifiedNumbers.has(n)) {
        throw new FactFenceError(
          `site: ABORTED — authored text at ${path || '<root>'} states the quantity ${n}, which is not a verified value. Nothing written.`
        );
      }
    }
  }
}
