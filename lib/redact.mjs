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

import { REDACTION_SOURCES, regex, termMatchers, pathMatchEnd } from './redaction-patterns.mjs';

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

    // 5. Home / user paths. Backslashes that end a match right before a quote
    // belong to an escaped quote in JSON text (`…\\repo\"`), so they're kept.
    for (const re of PATH_RES) {
      s = s.replace(re, (m, offset, whole) => redactTo('path')() + m.slice(pathMatchEnd(whole, offset, offset + m.length) - offset));
    }

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

// --- secrets only, for this machine's screen ---------------------------------
//
// "Show private text": a person reading their own logs on their own machine sees
// names, folders, addresses, ids and numbers as written. Secrets stay hidden all the
// same. This scrubber is for text shown from memory on that machine and nothing
// else: it is never used for anything written to disk, published, or shared, and a
// work history built with it refuses to serialize whole (lib/replay/index.mjs).
//
// What it hides, as [redacted:secret]: known API-key and token prefixes, JWTs, the
// value of any sensitive KEY=VALUE, "key": "value" or key: value field, a Bearer or
// Basic credential, the password in a URL (scheme://user:password@host), and opaque
// high-entropy tokens. What it leaves: emails, home paths, configured terms, account-
// shaped numbers, UUIDs (session and tool ids), git SHAs, and long folder paths that
// the opaque-token rule would otherwise take for a token.

// A sensitive field: an identifier holding one of these words at letter boundaries
// (API_KEY, x-api-key, client_secret, "Authorization"), then its closing quote (escaped
// or not), ":" or "=", and the value: the inside of a quoted string, or an unquoted
// run, optionally after a Bearer/Basic/Token scheme. Each identifier is read once from
// its front and the value is read only after a sensitive one, so an ordinary key never
// swallows the next one as its value and matching stays linear.
const IDENTIFIER_RE = /(?<![A-Za-z0-9_-])[A-Za-z_][A-Za-z0-9_-]*/g;
const SECRET_KEY_RE = /(?<![A-Za-z])(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD|PASSWD|PASSPHRASE|PASS|AUTHORIZATION|SECRET|TOKEN|AUTH|COOKIE|CREDENTIALS?)(?![A-Za-z])/i;
const SECRET_VALUE_RE = /(\\*["']?[ \t]*[:=][ \t]*)(?:(\\*")([^"\n]*?)(\\*")|(')([^'\n]*)(')|((?:(?:Bearer|Basic|Token)[ \t]+)?[^\s"',;{}[\]]+))/y;
const BEARER_RE = /\b(Bearer|Basic)([ \t]+)[A-Za-z0-9._~+/=-]{8,}/g;
// scheme://user:password@host. The password may hold an "@" itself; it ends at the last one.
const URL_PASSWORD_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s/"']+(?=@)/g;

/** A long run like `claude/worktrees/quiet-river-20c28a/lib` is a folder path, not a
 *  token, when it has a "/" and every segment is lowercase words, digits, "-" and "_",
 *  capitalized at most at its start (`Projects`). Hex tokens never hold a "/", and a
 *  base64 secret almost always has a capital mid-segment, a "+" or a "=". */
function looksLikeFolderPath(m) {
  return m.includes('/') && m.split('/').every((seg) => /^[A-Z]?[a-z0-9_-]*$/.test(seg));
}

/** Replace the value part (separator onward) of every sensitive field in `s`. */
function secretFields(s, replaceValue) {
  let out = '';
  let at = 0;
  const ids = new RegExp(IDENTIFIER_RE.source, 'g');
  const value = new RegExp(SECRET_VALUE_RE.source, 'y');
  for (let m = ids.exec(s); m; m = ids.exec(s)) {
    if (!SECRET_KEY_RE.test(m[0])) continue;
    value.lastIndex = m.index + m[0].length;
    const v = value.exec(s);
    if (!v) continue;
    out += s.slice(at, value.lastIndex - v[0].length) + replaceValue(v);
    at = value.lastIndex;
    ids.lastIndex = at;
  }
  return out + s.slice(at);
}

/**
 * createSecretsOnlyRedactor() -> { redact, deepRedact, count }
 * The same shape as createRedactor, hiding secrets only. For text shown from memory
 * on the person's own machine; never for anything written or published.
 */
export function createSecretsOnlyRedactor() {
  let count = 0;

  function redact(str) {
    if (typeof str !== 'string' || str.length === 0) return str;
    let delimiter = SENTINEL;
    while (str.includes(delimiter)) delimiter += SENTINEL;
    const sentinelRe = new RegExp(`${delimiter}(\\d+)${delimiter}`, 'g');
    const onlyStash = new RegExp(`^${delimiter}\\d+${delimiter}$`);
    const store = [];
    const stash = (text) => {
      store.push(text);
      return `${delimiter}${store.length - 1}${delimiter}`;
    };
    const secret = () => {
      count += 1;
      return stash(PLACEHOLDER.secret);
    };

    // Placeholders already present stay as they are (idempotency).
    let s = str.replace(PLACEHOLDER_RE, stash);
    s = s.replace(URL_PASSWORD_RE, (m, head) => head + secret());
    s = secretFields(s, (m) => {
      const [whole, sep, dq1, dqBody, dq2, sq1, sqBody, sq2, bare] = m;
      if (dq1 !== undefined) return dqBody && !onlyStash.test(dqBody) ? sep + dq1 + secret() + dq2 : whole;
      if (sq1 !== undefined) return sqBody && !onlyStash.test(sqBody) ? sep + sq1 + secret() + sq2 : whole;
      return onlyStash.test(bare) ? whole : sep + secret();
    });
    for (const re of API_KEY_RES) s = s.replace(re, secret);
    s = s.replace(BEARER_RE, (m, scheme, gap) => `${scheme}${gap}${secret()}`);
    // Ids and commit SHAs are shown, so they're set aside before the opaque-token rule.
    s = s.replace(UUID_RE, stash);
    s = s.replace(SHA_CANDIDATE_RE, (m) => (/[a-f]/.test(m) ? stash(m) : m));
    s = s.replace(OPAQUE_RE, (m) => (/[A-Za-z]/.test(m) && /[0-9]/.test(m) && !looksLikeFolderPath(m) ? secret() : m));
    return s.replace(sentinelRe, (match, i) => store[Number(i)] ?? match);
  }

  function deepRedact(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map((v) => deepRedact(v));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = deepRedact(value[key]);
      return out;
    }
    return value;
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
