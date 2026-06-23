// lib/redact.mjs — the single canonical scrubber.
//
// Every byte of text honestweek emits passes through THIS module. There is no
// second redaction path. It is conservative by design: when a pattern is
// ambiguous it over-redacts (privacy bias — leakage is unacceptable, an extra
// [redacted:...] token is not). At the same time it SPARES the two things the
// product's honesty depends on:
//   - lowercase hex git SHAs (7-40 chars, with at least one a-f letter) - the
//     load-bearing receipts, which must survive verbatim; and
//   - plain counts / percentages (e.g. "8 of 13", "22 tests", "31.3%", "1200").
//
// Zero runtime dependencies (language built-ins only); Node >= 18.
//
// Normative placeholder set (an interface downstream tooling may rely on):
//   [redacted:email] [redacted:secret] [redacted:path] [redacted:term] [redacted:account]
//
// Mapping of source -> placeholder:
//   email addresses                                     -> [redacted:email]
//   home / user paths (POSIX, macOS, Windows, git-bash) -> [redacted:path]
//   user codenames / names / terms (config-supplied)    -> [redacted:term]
//   bare 9+ digit runs (account numbers) + currency     -> [redacted:account]
//   api keys / tokens / JWTs / KEY=VALUE secrets / UUIDs / opaque tokens -> [redacted:secret]

const PLACEHOLDER = {
  email: '[redacted:email]',
  secret: '[redacted:secret]',
  path: '[redacted:path]',
  term: '[redacted:term]',
  account: '[redacted:account]',
};

// Matches any already-emitted placeholder, so a second pass can freeze them and
// stay idempotent (redact(redact(s)) === redact(s)).
const PLACEHOLDER_RE = /\[redacted:(?:email|secret|path|term|account)\]/g;

// Sentinel delimiter: a Private-Use-Area code point (U+E000) that does not occur
// in normal source text or JSON. Built via fromCharCode so the source stays pure
// ASCII. Sentinels are ALWAYS restored before redact() returns, so they never
// persist in any emitted artifact.
const SENTINEL = String.fromCharCode(0xe000);
const SENTINEL_RE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

// --- generic secret patterns ------------------------------------------------

const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// API keys / tokens with known prefixes, and JWTs.
const API_KEY_RES = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub ghp_/gho_/ghu_/ghs_/ghr_
  /\bAKIA[0-9A-Z]{12,}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}/g, // JWT (header.payload.signature)
];

// KEY=VALUE shell-style assignment where the KEY looks sensitive. We keep the
// key text and redact only the value. Sensitivity is decided word-boundaried
// (letter boundaries), so AUTH_TOKEN / AUTHORIZATION match but AUTHOR does not.
const KV_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g;
const SENSITIVE_KEY_RE =
  /(?<![A-Za-z])(?:API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|AUTHORIZATION|SECRET|TOKEN|AUTH)(?![A-Za-z])/i;

// Currency: keyword- or $-gated only — NEVER a bare number.
const CURRENCY_RES = [
  /\$\s?\d[\d,]*(?:\.\d+)?/g,
  /\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s?\$?\s?\d[\d,]*(?:\.\d+)?/gi,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|euros?|pounds?|cents?|USD|EUR|GBP)\b/gi,
];

// Home / user paths — redacted through (at least) the username segment.
const PATH_RES = [
  /[A-Za-z]:[\\/]Users[\\/][^\s"']+/g, // Windows  C:\Users\<user>\... or C:/Users/<user>/...
  /\/[a-z]\/Users\/[^\s"']+/gi, // git-bash  /c/Users/<user>/...
  /\/home\/[^\s"']+/g, // POSIX    /home/<user>/...
  /\/Users\/[^\s"']+/g, // macOS    /Users/<user>/...
];

// Candidate lowercase-hex SHA token (7-40). Spared verbatim ONLY when it
// contains at least one a-f letter — a pure-digit run is left for the account
// pattern (so 9+ digit account numbers still redact; short counts still pass).
const SHA_CANDIDATE_RE = /\b[0-9a-f]{7,40}\b/g;

// Bare account-number digit run (9+). Plain short counts (< 9 digits) survive.
const ACCOUNT_RE = /\b\d{9,}\b/g;

// Opaque / high-entropy token: 32+ base64-ish chars containing BOTH a letter
// and a digit (so long ordinary words are not mangled). SHAs and account
// numbers are already removed/protected before this runs.
const OPAQUE_RE = /\b[A-Za-z0-9_+/=-]{32,}\b/g;

/** Frozen list of the generic patterns (exported for transparency / testing). */
export const SECRET_PATTERNS = Object.freeze([
  { name: 'uuid', placeholder: 'secret' },
  { name: 'keyValue', placeholder: 'secret' },
  { name: 'apiKey', placeholder: 'secret' },
  { name: 'email', placeholder: 'email' },
  { name: 'homePath', placeholder: 'path' },
  { name: 'currency', placeholder: 'account' },
  { name: 'accountNumber', placeholder: 'account' },
  { name: 'opaqueToken', placeholder: 'secret' },
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * createRedactor(config) -> { redact, deepRedact, count }
 * `config.redaction = { codenames:[], names:[], terms:[] }` (all default empty).
 * Only `config.redaction` is consulted — never `config.identity` (author emails
 * are still redacted in prose; verification reads identity from config directly).
 */
export function createRedactor(config = {}) {
  const redaction = (config && config.redaction) || {};
  const terms = [
    ...(Array.isArray(redaction.codenames) ? redaction.codenames : []),
    ...(Array.isArray(redaction.names) ? redaction.names : []),
    ...(Array.isArray(redaction.terms) ? redaction.terms : []),
  ].filter((t) => typeof t === 'string' && t.length > 0);

  const termMatchers = terms.map(
    (t) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(t)}(?![A-Za-z0-9_])`, 'gi')
  );

  let count = 0;

  function redact(str) {
    if (typeof str !== 'string' || str.length === 0) return str;

    const store = [];
    const stash = (text) => {
      const i = store.length;
      store.push(text);
      return `${SENTINEL}${i}${SENTINEL}`;
    };
    const redactTo = (kind) => () => {
      count += 1;
      return stash(PLACEHOLDER[kind]);
    };

    let s = str;

    // 0. Freeze any placeholders already present (idempotency).
    s = s.replace(PLACEHOLDER_RE, (m) => stash(m));

    // 1. UUIDs (before SHA protection, which would otherwise grab hex groups).
    s = s.replace(UUID_RE, redactTo('secret'));

    // 2. KEY=VALUE sensitive assignments — keep the key, redact the value.
    s = s.replace(KV_RE, (m, key) => {
      if (SENSITIVE_KEY_RE.test(key)) {
        count += 1;
        return `${key}=${stash(PLACEHOLDER.secret)}`;
      }
      return m;
    });

    // 3. API keys / tokens / JWTs (before SHA protection — their bodies can be hex).
    for (const re of API_KEY_RES) s = s.replace(re, redactTo('secret'));

    // 4. Emails.
    s = s.replace(EMAIL_RE, redactTo('email'));

    // 5. Home / user paths.
    for (const re of PATH_RES) s = s.replace(re, redactTo('path'));

    // 6. Currency (gated) — before bare-number handling.
    for (const re of CURRENCY_RES) s = s.replace(re, redactTo('account'));

    // 7. PROTECT git SHAs (hex with at least one letter). No count — they survive.
    s = s.replace(SHA_CANDIDATE_RE, (m) => (/[a-f]/.test(m) ? stash(m) : m));

    // 8. Bare account numbers (9+ digit runs).
    s = s.replace(ACCOUNT_RE, redactTo('account'));

    // 9. Opaque high-entropy tokens.
    s = s.replace(OPAQUE_RE, (m) => {
      if (/[A-Za-z]/.test(m) && /[0-9]/.test(m)) {
        count += 1;
        return stash(PLACEHOLDER.secret);
      }
      return m;
    });

    // 10. User term-lists (whole-token, case-insensitive).
    for (const re of termMatchers) s = s.replace(re, redactTo('term'));

    // 11. Restore protected / placeholder spans.
    s = s.replace(SENTINEL_RE, (_, i) => store[Number(i)]);

    return s;
  }

  function deepRedact(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map((v) => deepRedact(v));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) {
        out[key] = deepRedact(value[key]); // keys unchanged, values redacted
      }
      return out;
    }
    return value; // numbers, booleans, null, undefined pass through
  }

  return {
    redact,
    deepRedact,
    get count() {
      return count;
    },
  };
}
