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

// Sentinel base: a Private-Use-Area code point (U+E000), built this way so the
// source stays pure ASCII. Each redact call chooses a repeated delimiter absent
// from its input, so authored PUA text can never impersonate an internal token.
const SENTINEL = String.fromCharCode(0xe000);

// --- generic secret patterns ------------------------------------------------

import { REDACTION_SOURCES, regex, termMatchers } from './redaction-patterns.mjs';

const UUID_RE = regex(REDACTION_SOURCES.uuid);
const EMAIL_RE = regex(REDACTION_SOURCES.email);

// API keys / tokens with known prefixes, and JWTs.
const API_KEY_RES = REDACTION_SOURCES.api.map((s)=>regex(s));

// KEY=VALUE shell-style assignment where the KEY looks sensitive. We keep the
// key text and redact only the value. Sensitivity is decided word-boundaried
// (letter boundaries), so AUTH_TOKEN / AUTHORIZATION match but AUTHOR does not.
const KV_RE = regex(REDACTION_SOURCES.keyValue);
const SENSITIVE_KEY_RE = regex(REDACTION_SOURCES.sensitiveKey,'i');

// Currency: keyword- or $-gated only — NEVER a bare number.
const CURRENCY_RES = REDACTION_SOURCES.currency.map((s)=>regex(s,'gi'));

// Home / user paths — redacted through (at least) the username segment.
// The username may contain spaces (e.g. Windows "Alex Jordan"), but a space is
// only consumed when a path separator confirms real path structure, so trailing
// prose after a bare "/home/user" is not swallowed. PATH_TAIL captures both:
//   - multi-segment, space-tolerant username:  user name/deeper/segments
//   - single bare username (no spaces):         username
const PATH_RES = REDACTION_SOURCES.paths.map((s,i)=>regex(s,i===1?'gi':'g'));

// Candidate lowercase-hex SHA token (7-40). Spared verbatim ONLY when it
// contains at least one a-f letter — a pure-digit run is left for the account
// pattern (so 9+ digit account numbers still redact; short counts still pass).
const SHA_CANDIDATE_RE = regex(REDACTION_SOURCES.sha);

// Bare account-number digit run (9+). Plain short counts (< 9 digits) survive.
// Lookarounds spare percentages and decimals of any length: a run immediately
// preceded by "." (a fraction) or followed by "%" or "." (a percentage/decimal)
// is left alone, honoring the "spare plain counts/percentages" guarantee. A bare
// large integer remains an account-number candidate (over-redaction is acceptable).
const ACCOUNT_RE = regex(REDACTION_SOURCES.account);

// Opaque / high-entropy token: 32+ base64-ish chars containing BOTH a letter
// and a digit (so long ordinary words are not mangled). SHAs and account
// numbers are already removed/protected before this runs.
const OPAQUE_RE = regex(REDACTION_SOURCES.opaque);

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
  ].filter((t) => typeof t === 'string' && t.trim().length > 0);

  // A multi-word term's internal whitespace is matched as \s+ (any run of
  // whitespace, including NBSP, tabs, and a wrapped newline) so a configured
  // term cannot leak just because the source used a different separator.
  const configuredTermMatchers = termMatchers(terms);

  let count = 0;

  function redact(str) {
    if (typeof str !== 'string' || str.length === 0) return str;

    let delimiter = SENTINEL;
    while (str.includes(delimiter)) delimiter += SENTINEL;
    const sentinelRe = new RegExp(`${delimiter}(\\d+)${delimiter}`, 'g');
    const store = [];
    const frozenPlaceholders = new Set();
    const stash = (text) => {
      const i = store.length;
      store.push(text);
      return `${delimiter}${i}${delimiter}`;
    };
    const redactTo = (kind) => () => {
      count += 1;
      return stash(PLACEHOLDER[kind]);
    };
    const replaceOutsideStashes = (input, re, replacement) => {
      const guard = new RegExp(sentinelRe.source, 'g');
      let out = ''; let at = 0;
      for (const match of input.matchAll(guard)) {
        out += input.slice(at, match.index).replace(re, replacement) + match[0];
        at = match.index + match[0].length;
      }
      return out + input.slice(at).replace(re, replacement);
    };

    let s = str;

    // 0. Freeze any placeholders already present (idempotency).
    s = s.replace(PLACEHOLDER_RE, (m) => {
      const token = stash(m);
      frozenPlaceholders.add(token);
      return token;
    });

    // 1. UUIDs (before SHA protection, which would otherwise grab hex groups).
    s = s.replace(UUID_RE, redactTo('secret'));

    // 2. KEY=VALUE sensitive assignments — keep the key, redact the value.
    s = s.replace(KV_RE, (m, key, value) => {
      if (SENSITIVE_KEY_RE.test(key)) {
        if (frozenPlaceholders.has(value)) return m;
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
    for (const re of configuredTermMatchers) s = replaceOutsideStashes(s, re, redactTo('term'));

    // 11. Restore protected / placeholder spans.
    s = s.replace(sentinelRe, (match, i) => store[Number(i)] ?? match);

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

// The prompt lane uses the same public module as every other artifact for its
// replayable privacy audit. The implementation is split only to keep the
// existing redactor's byte-for-byte behavior stable for lane-absent builds.
export { redactWithAudit, replayRedactions, assessPublicRendition } from './prompt-privacy.mjs';
