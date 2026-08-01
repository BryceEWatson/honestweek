// Shared deterministic text-overlap kernel for prompt-only and balanced
// curation. Callers own category and cross-session eligibility.

const FILLER = new Set(['a','an','the','please','just','really','me','my','our','we','you','your']);

export function curationTokens(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/\[redacted:(?:email|secret|path|term|account)\]/g, ' redacted ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
    .filter((token) => token && !FILLER.has(token));
}

export function hasRecurringText(leftText, rightText) {
  const left = new Set(curationTokens(leftText));
  const right = new Set(curationTokens(rightText));
  if (left.size < 4 || right.size < 4) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared) >= 0.75;
}
