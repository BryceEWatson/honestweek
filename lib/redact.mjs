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
//   the value of a sensitive field or flag in its other spellings ("password": "…",
//     x-api-key: …, DB_PASS=…, password := …, --password …, -Password …, a dotted
//     --docs.token …), Authorization and Cookie headers, Bearer/Basic credentials, the
//     password in a web address or after curl -u, a PowerShell SecureString literal, and,
//     in deepRedact, a value whose own key is sensitive -> [redacted:secret]
//   the value after a name that was itself a sensitive field's value (api_key=token: …,
//     password="token": "…"), and after a key split from its "=" by a line break
//     -> [redacted:secret]

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
const PLACEHOLDERS = new Set(Object.values(PLACEHOLDER));

// Placeholders and spared spans are set aside as tokens: a Private-Use-Area delimiter absent
// from the input (U+E000 unless the input holds it; freshDelimiter in redaction-patterns.mjs),
// a number, the delimiter again, so authored PUA text can never impersonate a token.

// --- generic secret patterns ------------------------------------------------

import {
  REDACTION_SOURCES, regex, termMatchers, skipWords, FOLDS_ONTO_ASCII, pathMatchEnd, emailSpans, freshDelimiter, tokenSource,
  recordKeyIsSecret, hideLaterFields, hideSourceFields, normalKey, notASecret, secretFields, hideSecretFields, onlyPlaceholders, IDENTIFIER_KEY, NUMERIC_SECRET_KEY_RE,
  URL_PASSWORD_RE, USER_PASSWORD_RE, SECURE_STRING_RE, BEARER_RE,
} from './redaction-patterns.mjs';

const UUID_RE = regex(REDACTION_SOURCES.uuid);

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
  { name: 'urlPassword', placeholder: 'secret' },
  { name: 'userPassword', placeholder: 'secret' },
  { name: 'secureString', placeholder: 'secret' },
  { name: 'secretField', placeholder: 'secret' },
  { name: 'bearer', placeholder: 'secret' },
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
export function createRedactor(config = {}, { laterFields = true, sourceFields = laterFields } = {}) {
  const redaction = (config && config.redaction) || {};
  const terms = [
    ...(Array.isArray(redaction.codenames) ? redaction.codenames : []),
    ...(Array.isArray(redaction.names) ? redaction.names : []),
    ...(Array.isArray(redaction.terms) ? redaction.terms : []),
  ].filter((t) => typeof t === 'string' && t.trim().length > 0);

  // A multi-word term's internal whitespace is matched as \s+ (any run of
  // whitespace, including NBSP, tabs, and a wrapped newline) so a configured
  // term cannot leak just because the source used a different separator.
  //
  // Each term keeps its own patterns, with the words a match must hold (lowercase), so step 10
  // can skip a term whose words aren't all in the text. That's safe for a term written only in
  // plain English characters: its patterns spell each letter as a class of its two cases
  // ([aA]) under flags gu, never i, so only those characters can match it, and a text that
  // matches holds every word in some mix of cases. A term with any other character has no
  // words here (skipWords gives null), and always runs its patterns.
  const names = Array.isArray(redaction.names) ? redaction.names : [];
  const configuredTerms = terms.map((t) => ({
    words: skipWords(t),
    patterns: termMatchers([t], names),
  }));
  // Step 10's exec loop moves on through the g flag; without it exec finds the first match
  // forever, where matchAll threw. The message leaves the pattern out: it spells the term.
  for (const { patterns } of configuredTerms) {
    if (patterns.some((re) => !re.global)) throw new TypeError('a term pattern is missing the g flag');
  }

  let count = 0;

  function redact(str) {
    if (typeof str !== 'string' || str.length === 0) return str;

    // One pass finds the delimiter (a growing run of U+E000 once made the pattern too large
    // to build on a long run of them, and scanning it quadratic).
    const delimiter = freshDelimiter(str);
    const token = tokenSource(delimiter);
    const sentinelRe = new RegExp(token, 'g');
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
    let s = str;

    // 0. Freeze any placeholders already present (idempotency).
    s = s.replace(PLACEHOLDER_RE, (m) => {
      const token = stash(m);
      frozenPlaceholders.add(token);
      return token;
    });

    // 1. UUIDs (before SHA protection, which would otherwise grab hex groups).
    s = s.replace(UUID_RE, redactTo('secret'));

    // 2. KEY=VALUE sensitive assignments — keep the key, redact the value. A "value" that
    // starts with "=" is the rest of an == or === comparison: its operand is hidden and the
    // operator kept (step 10b reads one set apart by spaces, `password == "…"`), here, before
    // a later step can take the key into a placeholder. A placeholder from an earlier pass,
    // alone, right after an opening quote, or right before a closing one
    // (`"Authorization=[redacted:secret]"` read again), is left.
    const startsWithToken = new RegExp(`^${token}`);
    const frozen = (v) => {
      if (frozenPlaceholders.has(v)) return true;
      const w = v.replace(/^["']/, '');
      const lead = startsWithToken.exec(w);
      return lead !== null && frozenPlaceholders.has(lead[0]) && (w.length === lead[0].length || w[lead[0].length] === '"' || w[lead[0].length] === "'");
    };
    s = s.replace(KV_RE, (m, key, value) => {
      if (!SENSITIVE_KEY_RE.test(key)) return m;
      if (value.startsWith('=')) {
        const operand = value.replace(/^=+/, '');
        if (operand === '' || frozen(operand)) return m;
        count += 1;
        return m.slice(0, m.length - operand.length) + stash(PLACEHOLDER.secret);
      }
      if (frozen(value)) return m;
      count += 1;
      return `${key}=${stash(PLACEHOLDER.secret)}`;
    });

    // 3. API keys / tokens / JWTs (before SHA protection — their bodies can be hex).
    for (const re of API_KEY_RES) s = s.replace(re, redactTo('secret'));

    // 4. Emails (the same matches as a global search with the email pattern, found in
    // linear time).
    {
      let out = '';
      let at = 0;
      for (const [from, to] of emailSpans(s)) {
        out += s.slice(at, from) + redactTo('email')();
        at = to;
      }
      s = out + s.slice(at);
    }

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
    // Every term pattern's matches are gathered on the same text and overlapping ones merged,
    // so each private span is replaced once whichever pattern found it, as the audit does. A
    // web-address pattern may look past a placeholder to a part's ending; no match may
    // overlap one.
    // A term runs its patterns only when each of its words is in the text in some mix of cases
    // (see configuredTerms above); the order terms run in doesn't change the merged spans.
    // A text holding a character that lowercases or case-folds onto a plain English letter
    // runs every term, so the check stays safe if a pattern ever ignores case.
    // test/redact-fast-path.test.mjs puts the old step 10 back between this heading and 10b's
    // to compare the two; its header lists the text and the names it relies on.
    const lower = configuredTerms.length === 0 || FOLDS_ONTO_ASCII.test(s) ? null : s.toLowerCase();
    const live = lower === null ? configuredTerms : configuredTerms.filter((t) => t.words === null || t.words.every((w) => lower.includes(w)));
    if (live.length) {
      // heldBefore[i]: how many characters before i sit inside a placeholder.
      const heldBefore = new Uint32Array(s.length + 1);
      let inside = new Uint8Array(s.length);
      for (const m of s.matchAll(new RegExp(sentinelRe.source, 'g'))) inside.fill(1, m.index, m.index + m[0].length);
      for (let i = 0; i < s.length; i += 1) heldBefore[i + 1] = heldBefore[i] + inside[i];
      inside = null;
      const spans = [];
      for (const { patterns } of live) {
        for (const re of patterns) {
          // An exec loop finds what matchAll finds without copying the pattern on every call.
          // A term pattern always takes at least one character; were one to match empty, the
          // loop moves on by one character (a whole surrogate pair), as matchAll does.
          re.lastIndex = 0;
          for (let m = re.exec(s); m !== null; m = re.exec(s)) {
            const from = m.index;
            const to = from + m[0].length;
            if (to === from) {
              re.lastIndex = from + (from + 1 < s.length && s.codePointAt(from) > 0xffff ? 2 : 1);
              continue;
            }
            if (heldBefore[to] === heldBefore[from]) spans.push([from, to]);
          }
        }
      }
      spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
      let out = '';
      let at = 0;
      for (let i = 0; i < spans.length; ) {
        let [from, to] = spans[i];
        for (i += 1; i < spans.length && spans[i][0] < to; i += 1) to = Math.max(to, spans[i][1]);
        out += s.slice(at, from) + redactTo('term')();
        at = to;
      }
      s = out + s.slice(at);
    }

    // 10b. The secret-field forms shared with the secrets-only scrubber and the prompt audit
    // (hideSecretFields in redaction-patterns.mjs): the password in a web address and after
    // curl's -u, a PowerShell SecureString literal, the value of a sensitive field or flag in
    // any of its spellings (`"password": "…"`, `x-api-key: …`, `DB_PASS=…`, `--password …`,
    // an Authorization or Cookie header), and a Bearer or Basic credential that isn't a plain
    // word (`basic validation` is prose), then the KEY=VALUE rule once more on the text as it
    // then reads (a field step 2 read as another key's value). Only the value is hidden.
    // They run last, on the text with every other placeholder already in place, so a second
    // pass reads the same text and finds nothing new: run earlier, a placeholder set down
    // after them (an email, an account number, a term) could split a word they read whole
    // (`…12345678901--password`) and turn up a field on the second pass. The prompt audit
    // reads its rendition the same way, so the scrubber leaves audited text as it is. A value
    // made only of placeholders is left as it is (a `password@host.tld` the email rule took
    // keeps its host hidden), and so is a field value made only of `*` and `_` (the close of
    // a `**Auth:**` label). Commit ids set aside in step 7 are put back first: whether a hex
    // run is set aside depends on what's next to it (a placeholder on the second pass, a
    // letter on the first), and the field rules must read the same characters both times.
    s = s.replace(sentinelRe, (m, i) => (PLACEHOLDERS.has(store[Number(i)]) ? m : store[Number(i)]));
    s = hideSecretFields(s, {
      delimiter,
      partText: (n) => store[n],
      hide: redactTo('secret'),
    });

    // 11. Restore protected / placeholder spans.
    s = s.replace(sentinelRe, (match, i) => store[Number(i)] ?? match);

    return s;
  }

  // The fields read after the rules above (a Java property, a dotted key, an unclosed single
  // quote): a pass over the finished text that only puts more placeholders down. With
  // `laterFields` false the rules above run alone, which is how the tests check that the pass
  // changes nothing but the spans it hides.
  const redactLater = (str) => {
    const out = redact(str);
    return laterFields && typeof out === 'string' && out.length > 0 ? hideLaterFields(out, PLACEHOLDER.secret, () => { count += 1; }) : out;
  };
  // The fields read from the text as it was written (a value after a name that was itself a
  // field's value, a key split from its "=" by a line break): hidden in the finished text in
  // addition to everything above. With `sourceFields` false this step is left out.
  const redactAll = (str) => {
    const out = redactLater(str);
    if (!sourceFields || typeof out !== 'string' || out.length === 0) return out;
    const more = hideSourceFields(str, out, PLACEHOLDER.secret, () => { count += 1; });
    // A value hidden here can end a stop the later pass read up to (a `name:` on a password
    // line), so that pass reads once more, as it would on a second run.
    return more === out ? out : hideLaterFields(more, PLACEHOLDER.secret, () => { count += 1; });
  };

  return {
    redact: redactAll,
    // Keys unchanged, values redacted; a value under a sensitive key is hidden whole.
    deepRedact: keyAwareDeepRedact(redactAll, () => {
      count += 1;
    }, { plainValues: true }),
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
// bare UUIDs (session and tool ids): known API-key and token prefixes, JWTs, the value of
// a sensitive field (KEY=VALUE, key: value to the end of the line, "key": "value" with
// escaped quotes, :=, ?=, ==, a typed `password: string = …`), a sensitive --flag or
// -Parameter value (a dotted name, --docs.token, too), Authorization and Cookie headers, a
// JSON value read back from a record whose key is sensitive, Bearer/Basic/Token
// credentials, the password in a web address or after curl's -u, a PowerShell SecureString literal, and opaque high-entropy tokens (the
// field rules live in redaction-patterns.mjs, shared with the full redactor, which reads
// them after setting down its other placeholders, so where an address or a long number is
// glued to a flag, `you@example.com--password x`, it can find a field this one reads as one
// word). It shows
// emails, home paths, configured terms, account-shaped numbers, UUIDs not tied to a
// sensitive key, git SHAs and other hex up to 40 characters (as the full redactor does),
// and long runs made of words (folder paths, web addresses) that would otherwise look like
// tokens.

// A long run is words, not a token, when it splits on / - _ . into parts that are each a
// word (lowercase, Capitalized or camelCase, maybe ending in a few digits), a number, a
// short hex suffix, one capital letter, or a timestamp. Random tokens almost never do: none
// of 600,000 random base64 or base64url tokens passed in testing, and a few in 10,000 to
// about 1 in 100 dash-grouped lowercase ones, more as the groups get longer.
// A part like `k8s`, `i18n` or `v1beta1` counts as a word, and so does a short hex run
// holding digits and letters (a worktree suffix like `20c28a`), but at most one such odd
// part per run, and at most two parts that mix letters and digits, so dash-grouped random
// tokens stay hidden. A letters-only part needs a vowel and no run of five consonants.
const WORD_PART = /^(?:[a-z]+[0-9]{0,4}|[0-9]+[a-z]{0,2}|[a-z]{1,4}[0-9]{1,2}[a-z]{1,6}[0-9]{0,2}|[0-9a-f]{4,8}|[A-Z]|\d{8}T\d{4,6}Z?|(?:[A-Z]{1,3}(?=[A-Z][a-z]{2})|[A-Z]?[a-z]{2,}(?![a-z]))+[0-9]{0,4})$/;
const ODD_PART = /^(?:(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{4,8}|[a-z]{1,4}[0-9]{1,2}[a-z]{1,6}[0-9]{0,2})$/;
const PLAIN_PART = /^(?:[a-z]+[0-9]{0,4}|[0-9]+[a-z]{0,2})$/;
const MIXED_HEX_PART = /^(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{4,8}$/;
// A letters-only part of five or more letters has a vowel (a e i o u y) and no run of five
// consonants, as words do (`scripts`, `branch`, `strength`); random letters often don't.
const sayable = (p) => !/^[a-z]{5,}$/i.test(p) || (/[aeiouy]/i.test(p) && !/[b-df-hj-np-tv-xz]{5}/i.test(p));
function madeOfWords(m) {
  const parts = m.split(/[/_.-]+/);
  // Every mixed hex part is odd (`db45` too); a `k8s`-style part is odd unless it's a plain word.
  const odd = (p) => MIXED_HEX_PART.test(p) || (ODD_PART.test(p) && !PLAIN_PART.test(p));
  return parts.length > 1 && parts.every((p) => p === '' || (p.length <= 40 && WORD_PART.test(p))) && parts.filter(odd).length <= 1 && parts.filter((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p)).length <= 2 && parts.every(sayable);
}

/**
 * createSecretsOnlyRedactor() -> { redact, deepRedact, count }
 * The same shape as createRedactor, hiding secrets only. For text shown from memory
 * on the person's own machine; never for anything written or published.
 */
export function createSecretsOnlyRedactor({ laterFields = true, sourceFields = laterFields } = {}) {
  let count = 0;

  function redact(str) {
    if (typeof str !== 'string' || str.length === 0) return str;
    const delimiter = freshDelimiter(str);
    const token = tokenSource(delimiter);
    const sentinelRe = new RegExp(token, 'g');
    const hasStash = new RegExp(token);
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

  // The fields read after the rules above, then the ones read from the text as it was written,
  // as in createRedactor.
  const redactLater = (str) => {
    const out = redact(str);
    return laterFields && typeof out === 'string' && out.length > 0 ? hideLaterFields(out, PLACEHOLDER.secret, () => { count += 1; }) : out;
  };
  const redactAll = (str) => {
    const out = redactLater(str);
    if (!sourceFields || typeof out !== 'string' || out.length === 0) return out;
    const more = hideSourceFields(str, out, PLACEHOLDER.secret, () => { count += 1; });
    // A value hidden here can end a stop the later pass read up to (a `name:` on a password
    // line), so that pass reads once more, as it would on a second run.
    return more === out ? out : hideLaterFields(more, PLACEHOLDER.secret, () => { count += 1; });
  };

  return {
    redact: redactAll,
    deepRedact: keyAwareDeepRedact(redactAll, () => {
      count += 1;
    }),
    get count() {
      return count;
    },
  };
}

/** deepRedact for both scrubbers. A record read back as JSON loses the text around its
 *  values, so a value is hidden when its own key is sensitive ({"password": "…"},
 *  {"x-api-key": "…"}), and so is a long number under a password-like key ({"password":
 *  12345678}). Only a key shaped like an identifier counts: an answer keyed by a question's
 *  text keeps its value, and the engine's own fileKey, sessionKey and statusKey are not
 *  sensitive. Every other string goes through `redact`; keys are kept as they are.
 *  `counted()` is called once per value hidden here. With `plainValues`, a string the text
 *  rule also leaves (`"auth": "true"`, `"pass": "12"`) is not hidden for its key either.
 *  Everything beneath a sensitive key is sensitive too (strings, and numbers of 1000 or more),
 *  so a credential stored as an object
 *  (`{"token": {"value": "…"}}`, `{"apiKeys": [{"value": "…"}]}`) is hidden. */
function keyAwareDeepRedact(redact, counted, { plainValues = false } = {}) {
  function deepRedact(value, key = null, inherited = false) {
    const secretKey = key !== null && IDENTIFIER_KEY.test(key);
    const sensitive = inherited || (secretKey && recordKeyIsSecret(key));
    if (typeof value === 'string') {
      if (sensitive && value !== '' && !onlyPlaceholders(value) && !(plainValues && key !== null && notASecret(key, value))) {
        counted();
        return PLACEHOLDER.secret;
      }
      return redact(value);
    }
    if (typeof value === 'number' && (inherited || (secretKey && NUMERIC_SECRET_KEY_RE.test(normalKey(key)))) && Math.abs(value) >= 1000) {
      counted();
      return PLACEHOLDER.secret;
    }
    // An array's items sit under its key.
    if (Array.isArray(value)) return value.map((v) => deepRedact(v, key, sensitive));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = deepRedact(value[k], k, sensitive);
      return out;
    }
    return value; // booleans, null, undefined and other numbers pass through
  }
  return (value) => deepRedact(value);
}

// The prompt lane uses the same public module as every other artifact for its
// replayable privacy audit. The implementation is split only to keep the
// existing redactor's byte-for-byte behavior stable for lane-absent builds.
export { redactWithAudit, replayRedactions, assessPublicRendition } from './prompt-privacy.mjs';
