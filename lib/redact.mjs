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
// It hides, as [redacted:secret], everything the full redactor hides as a secret except
// bare UUIDs (session and tool ids), and more: known API-key and token prefixes, JWTs,
// the value of a sensitive field (KEY=VALUE, key: value to the end of the line,
// "key": "value" with escaped quotes, :=, ?=, ==, a typed `password: string = …`), a
// sensitive --flag or -Parameter value, Authorization and Cookie headers, a JSON value
// read back from a record whose key is sensitive, Bearer/Basic/Token credentials, the
// password in a web address or after curl's -u, a PowerShell SecureString literal, and
// opaque high-entropy tokens. It shows emails, home paths, configured terms, account-
// shaped numbers, UUIDs not tied to a sensitive key, git SHAs and other hex up to 40
// characters (as the full redactor does), and long runs made of words (folder paths,
// web addresses) that would otherwise look like tokens.

// A sensitive key, tested after camelCase and "-" become "_" (dbPassword, x-api-key,
// _authToken, PGPASSWORD, MYSQL_PWD, ENCRYPTION_KEY, client_secret, X-Amz-Signature, ?sig=).
// A key merely ending in "Key" isn't one: the engine's own fileKey and sessionKey hold ids.
const SECRET_KEY_RE = /(?:(?<![A-Za-z])(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|PASSPHRASE|PASS|AUTHORIZATION|SECRET|TOKEN|AUTH|COOKIE|CREDENTIALS?|SIGNATURE|SIG)|PASSWORD|PASSWD|(?<=_)PWD|(?:ENCRYPTION|SIGNING|MASTER|CLIENT|LICENSE|SERVICE|DEPLOY|SESSION_SECRET|SSH|GPG|PGP|HMAC|JWT|AES|APP)_?KEY)(?![A-Za-z])/i;
const keyIsSecret = (key) => SECRET_KEY_RE.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_'));
// Each identifier is read once from its front; its value is read only when the key is
// sensitive, so an ordinary key never swallows the next one and matching stays linear.
const IDENTIFIER_RE = /(?<![A-Za-z0-9_])[A-Za-z0-9_][A-Za-z0-9_-]*/g;
const HSPACE = String.raw`[^\S\r\n]*`;
// After the key: its closing quote (escaped or not), the separator, and a type name
// between ":" and "=" when there is one (`password: string = "…"`).
const FIELD_SEP_RE = new RegExp(String.raw`\\*["']?${HSPACE}(:=|\?=|==|=|:)${HSPACE}(?:(?:string|str|String|bytes|SecretStr|SecureString|any|&str|char\s?\*)${HSPACE}=${HSPACE})?`, 'y');
// After a --flag or -Parameter: spaces, then a value that isn't another flag.
const FLAG_SEP_RE = new RegExp(String.raw`[^\S\r\n]+(?=[^\s-])`, 'y');
const SCHEME_RE = /(?:bearer|basic|token|digest)[^\S\r\n]+/iy;
const BEARER_RE = /\b(bearer|basic)([ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;
// scheme://user:password@host. The user may be empty (redis://:password@host); the
// password may hold an "@" itself and ends at the last one.
const URL_PASSWORD_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@"']*:)[^\s/"']+(?=@)/g;
// curl and wget basic auth: -u user:password, --user user:password, --user=user:password.
const USER_PASSWORD_RE = /(?<![\w-])(-u|--user)([ \t=]+["']?[^\s:"']+:)([^\s"']+)/g;
const SECURE_STRING_RE = /(ConvertTo-SecureString[ \t]+(?:-String[ \t]+)?)(["'])([^"'\n]*)\2/gi;

/** Where a value starting at `p` ends, and the part of it to hide: a double-quoted string
 *  (its quote escaped by `n` backslashes, so the closing quote is the next one escaped by
 *  exactly `n`), a single-quoted one, or an unquoted run. `toLineEnd` runs an unquoted value
 *  to the end of the line (a "key: value" line, a header); otherwise to the next space. */
function readValue(s, p, toLineEnd) {
  const open = /\\*"/y;
  open.lastIndex = p;
  const o = open.exec(s);
  if (o) {
    const n = o[0].length - 1;
    for (let i = p + o[0].length; i < s.length; ) {
      const q = s.indexOf('"', i);
      const nl = s.indexOf('\n', i);
      if (q < 0 || (nl >= 0 && nl < q)) break;
      let k = 0;
      while (k < q - i && s[q - 1 - k] === '\\') k += 1;
      if (k === n) return { start: p + o[0].length, end: q - n, after: q + 1 };
      i = q + 1;
    }
  } else if (s[p] === "'") {
    const q = s.indexOf("'", p + 1);
    const nl = s.indexOf('\n', p + 1);
    if (q > p && (nl < 0 || q < nl)) return { start: p + 1, end: q, after: q + 1 };
  }
  let end = p;
  if (toLineEnd) {
    while (end < s.length && !'\r\n"\''.includes(s[end])) end += 1;
    while (end > p && /\s/.test(s[end - 1])) end -= 1;
  } else {
    SCHEME_RE.lastIndex = p;
    if (SCHEME_RE.exec(s)) end = SCHEME_RE.lastIndex;
    while (end < s.length && !/\s/.test(s[end])) end += 1;
  }
  return end > p ? { start: p, end, after: end } : null;
}

/** Hide the value of every sensitive field and flag in `s`. `hide(text)` returns the
 *  replacement for one value, or null to leave it. */
function secretFields(s, hide) {
  let out = '';
  let at = 0;
  const ids = new RegExp(IDENTIFIER_RE.source, 'g');
  for (let m = ids.exec(s); m; m = ids.exec(s)) {
    if (!keyIsSecret(m[0])) continue;
    const end = m.index + m[0].length;
    let v = null;
    FIELD_SEP_RE.lastIndex = end;
    const sep = FIELD_SEP_RE.exec(s);
    if (sep) v = readValue(s, FIELD_SEP_RE.lastIndex, sep[1] === ':' || /(?:^|[_-])(?:authorization|cookie)$/i.test(m[0]));
    else if (s[m.index - 1] === '-') {
      FLAG_SEP_RE.lastIndex = end;
      if (FLAG_SEP_RE.exec(s)) v = readValue(s, FLAG_SEP_RE.lastIndex, false);
    }
    if (!v) continue;
    const hidden = hide(s.slice(v.start, v.end));
    if (hidden === null) continue;
    out += s.slice(at, v.start) + hidden;
    at = v.end;
    ids.lastIndex = Math.max(v.after, v.end);
  }
  return out + s.slice(at);
}

// A long run is words, not a token, when it splits on / - _ . into parts that are each a
// word (lowercase, Capitalized or camelCase, maybe ending in a few digits), a number, a
// short hex suffix, one capital letter, or a timestamp. Random tokens almost never do:
// none of a million random base64, base64url or hex tokens passed in testing.
const WORD_PART = /^(?:[a-z]+[0-9]{0,4}|[0-9]+[a-z]{0,2}|[0-9a-f]{4,8}|[A-Z]|\d{8}T\d{4,6}Z?|(?:[A-Z]{1,3}(?=[A-Z][a-z]{2})|[A-Z]?[a-z]{2,}(?![a-z]))+[0-9]{0,4})$/;
function madeOfWords(m) {
  const parts = m.split(/[/_.-]+/);
  return parts.length > 1 && parts.every((p) => p === '' || (p.length <= 40 && WORD_PART.test(p)));
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
    const hasStash = new RegExp(`${delimiter}\\d+${delimiter}`);
    const store = [];
    const stash = (text) => {
      store.push(text);
      return `${delimiter}${store.length - 1}${delimiter}`;
    };
    const secret = () => {
      count += 1;
      return stash(PLACEHOLDER.secret);
    };
    // A value already made only of placeholders is left as it is.
    const onlyStashes = (v) => v.replace(sentinelRe, '').trim() === '';

    // Placeholders already present stay as they are (idempotency).
    let s = str.replace(PLACEHOLDER_RE, stash);
    s = s.replace(URL_PASSWORD_RE, (m, head) => head + secret());
    s = s.replace(USER_PASSWORD_RE, (m, flag, user) => flag + user + secret());
    s = s.replace(SECURE_STRING_RE, (m, head, q, value) => (value ? `${head}${q}${secret()}${q}` : m));
    s = secretFields(s, (value) => (value === '' || onlyStashes(value) ? null : secret()));
    // The full redactor's KEY=VALUE rule as well, so nothing it hides shows here.
    s = s.replace(KV_RE, (m, key, value) => (SENSITIVE_KEY_RE.test(key) && !hasStash.test(value) ? `${key}=${secret()}` : m));
    for (const re of API_KEY_RES) s = s.replace(re, secret);
    s = s.replace(BEARER_RE, (m, scheme, gap) => `${scheme}${gap}${secret()}`);
    // Ids and commit SHAs are shown, so they're set aside before the opaque-token rule.
    s = s.replace(UUID_RE, stash);
    s = s.replace(SHA_CANDIDATE_RE, (m) => (/[a-f]/.test(m) ? stash(m) : m));
    s = s.replace(OPAQUE_RE, (m) => (/[A-Za-z]/.test(m) && /[0-9]/.test(m) && !madeOfWords(m) ? secret() : m));
    return s.replace(sentinelRe, (match, i) => store[Number(i)] ?? match);
  }

  // A record read back as JSON loses the text around its values, so a value is hidden
  // here when its own key is sensitive ({"password": "…"}, {"x-api-key": "…"}).
  function deepRedact(value, key = null) {
    if (typeof value === 'string') {
      if (key !== null && value !== '' && keyIsSecret(key) && !/^(?:\s*\[redacted:\w+\]\s*)+$/.test(value)) {
        count += 1;
        return PLACEHOLDER.secret;
      }
      return redact(value);
    }
    if (Array.isArray(value)) return value.map((v) => deepRedact(v, key));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = deepRedact(value[k], k);
      return out;
    }
    return value;
  }

  return {
    redact,
    deepRedact: (value) => deepRedact(value),
    get count() {
      return count;
    },
  };
}

// The prompt lane uses the same public module as every other artifact for its
// replayable privacy audit. The implementation is split only to keep the
// existing redactor's byte-for-byte behavior stable for lane-absent builds.
export { redactWithAudit, replayRedactions, assessPublicRendition } from './prompt-privacy.mjs';
