// lib/view/leaks.mjs: the leak counter for `honestweek view`, shared by the node tests
// and the click-through self-test.
//
// Secrets, in both modes: the secrets-only scrubber runs over every string a second
// time, and over the same string with its whitespace collapsed onto one line (so a
// password on the line after its label counts). Zero means neither pass changes the
// text. The text is compared, not the scrubber's count, since the count isn't stable on
// its own output. Counting pattern matches can't work: correctly hidden text and the ids
// the switch is meant to show, such as session and commit ids, still match them.
//
// With Show private text off, two differences are expected, because the full redactor
// leaves them on purpose and the secrets-only scrubber doesn't: a Bearer or Basic
// "credential" that is plain words (`basic validation`), and a field value made only of
// `*` and `_` (the close of a Markdown bold label, `**Auth:** …`). Only a span that is
// exactly one of those, where it sits, is set aside before the second pass.
//
// Also with the switch off: configured terms, names and codenames (inside longer words
// too, by the redactor's own patterns), home-folder paths, and email addresses. The
// text's own [redacted:…] markers are taken out first, so every hit is a new find.
//
// In a JSON-shaped value, in both modes: a value whose key is sensitive, which the
// redacted view's own deepRedact hides whole ({"token": "…"}, a long number under a
// password-like key, anything inside a sensitive key's object). A string read alone
// doesn't show its key, so this is checked on the value as it stands.
//
// An answer's top-level `query` field is exempt by name: it echoes what the person typed
// on this run's own page, never anything read from a log.

import { createSecretsOnlyRedactor } from '../redact.mjs';
import { BEARER_RE, emailSpans, IDENTIFIER_KEY, keyIsSecret, markupOnly, normalKey, notASecret, NUMERIC_SECRET_KEY_RE, onlyPlaceholders, plainWords, REDACTION_SOURCES, secretFields, termMatchers } from '../redaction-patterns.mjs';

const MARKER = /\[redacted:[a-z]+\]/g;
const SECRET = '[redacted:secret]';

/** The one field of an answer the counter skips, and only at its top level. */
export const EXEMPT_FIELDS = Object.freeze(['query']);

/** Every string in a JSON-shaped value, object keys included. A top-level field named in
 *  EXEMPT_FIELDS is skipped. */
export function stringsIn(value, out = [], depth = 0) {
  if (depth > 64) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (depth === 0 && EXEMPT_FIELDS.includes(k)) continue;
      out.push(k);
      stringsIn(v, out, depth + 1);
    }
  }
  return out;
}

/** How many values in a JSON-shaped value sit under a sensitive key and are shown: the ones
 *  the full redactor's deepRedact would hide for their key. A string under a sensitive key
 *  counts unless it's empty, only placeholders, or a flag word (`"auth": "true"`); a number
 *  of 1000 or more counts under a password-like key; everything under a sensitive key is
 *  sensitive. A top-level field named in EXEMPT_FIELDS is skipped. */
export function keyedSecrets(value, key = null, inherited = false, depth = 0) {
  if (depth > 64) return 0;
  const named = key !== null && IDENTIFIER_KEY.test(key);
  const sensitive = inherited || (named && keyIsSecret(key));
  if (typeof value === 'string') return sensitive && value !== '' && !onlyPlaceholders(value) && !(key !== null && notASecret(key, value)) ? 1 : 0;
  if (typeof value === 'number') return Math.abs(value) >= 1000 && (inherited || (named && NUMERIC_SECRET_KEY_RE.test(normalKey(key)))) ? 1 : 0;
  let n = 0;
  if (Array.isArray(value)) for (const v of value) n += keyedSecrets(v, key, sensitive, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!(depth === 0 && EXEMPT_FIELDS.includes(k))) n += keyedSecrets(v, k, sensitive, depth + 1);
  }
  return n;
}

/** `text` with each allowed span (a plain-words Bearer or Basic credential, a field
 *  value of only `*` and `_`) replaced by a placeholder the scrubber leaves alone. */
export function setAsideAllowed(text) {
  const spans = [];
  const bearer = new RegExp(BEARER_RE.source, BEARER_RE.flags);
  for (const m of text.matchAll(bearer)) {
    const start = m.index + m[1].length + m[2].length;
    const end = m.index + m[0].length;
    if (plainWords(text.slice(start, end))) spans.push([start, end]);
  }
  secretFields(text, (value, start, end) => {
    if (markupOnly(value)) spans.push([start, end]);
    return null;
  });
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    if (start < at) continue;
    out += text.slice(at, start) + SECRET;
    at = end;
  }
  return out + text.slice(at);
}

/**
 * createLeakCounter(config) -> { redacted(value), secrets(value) }
 *   redacted(value) -> { terms, paths, emails, secrets, total }  switch off
 *   secrets(value)  -> { secrets, total }                         switch on
 * `value` is a string or any JSON-shaped value; every string in it is checked.
 */
export function createLeakCounter(config = {}) {
  const r = config?.redaction ?? {};
  const list = (x) => (Array.isArray(x) ? x.filter((t) => typeof t === 'string' && t.trim()) : []);
  const terms = [...list(r.codenames), ...list(r.names), ...list(r.terms)];
  const matchers = termMatchers(terms, list(r.names));
  const paths = REDACTION_SOURCES.paths.map((s) => new RegExp(s, 'g'));
  const scrubber = createSecretsOnlyRedactor();

  const count = (re, text) => {
    re.lastIndex = 0;
    let n = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) re.lastIndex += 1;
      else n += 1;
    }
    return n;
  };

  /** Whether the scrubber would still change `text`, or its one-line copy. */
  const changes = (text, allow) => {
    for (const variant of new Set([text, text.replace(/\s+/g, ' ').trim()])) {
      const v = allow ? setAsideAllowed(variant) : variant;
      if (scrubber.redact(v) !== v) return true;
    }
    return false;
  };

  function redacted(value) {
    const out = { terms: 0, paths: 0, emails: 0, secrets: 0 };
    for (const raw of stringsIn(value)) {
      const text = raw.replace(MARKER, ' ');
      for (const re of matchers) out.terms += count(re, text);
      for (const re of paths) out.paths += count(re, text);
      out.emails += emailSpans(text).length;
      if (changes(raw, true)) out.secrets += 1;
    }
    out.secrets += keyedSecrets(value);
    return { ...out, total: out.terms + out.paths + out.emails + out.secrets };
  }

  function secrets(value) {
    let n = 0;
    for (const text of stringsIn(value)) if (changes(text, false)) n += 1;
    n += keyedSecrets(value);
    return { secrets: n, total: n };
  }

  return { redacted, secrets };
}
