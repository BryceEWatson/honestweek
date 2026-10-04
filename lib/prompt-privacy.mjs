// Deterministic, prompt-specific privacy audit. Raw text is accepted only for
// this call and is never returned. The persisted result contains a redacted
// rendition plus replayable code-point spans and count-only risk metadata.

import { isIP } from 'node:net';
import {
  REDACTION_SOURCES, regex, termMatchers, pathMatchEnd, emailSpans, hideSecretFields, freshDelimiter, tokenSource,
} from './redaction-patterns.mjs';

export const DETECTOR_ORDER = Object.freeze([
  'configured-term', 'never-public-term', 'email', 'phone', 'home-path',
  'secret', 'uuid', 'currency', 'account-number', 'ip-address',
  'display-context', 'capitalized-unknown',
]);
export const REPLACEABLE_DETECTORS = Object.freeze(DETECTOR_ORDER.slice(0, 10));

const PLACEHOLDER = Object.freeze({
  'configured-term': '[redacted:term]',
  'never-public-term': '[redacted:term]',
  email: '[redacted:email]', phone: '[redacted:account]',
  'home-path': '[redacted:path]', secret: '[redacted:secret]',
  uuid: '[redacted:secret]', currency: '[redacted:account]',
  'account-number': '[redacted:account]', 'ip-address': '[redacted:secret]',
});
const SAFE_CAPS = new Set(['API','CSS','Claude','Codex','Git','HTML','HTTP','HTTPS','JavaScript','JSON','JSONL','Linux','Node','SQL','TypeScript','UI','URL','Windows','macOS']);
const PLACEHOLDER_RE = /\[redacted:(?:email|secret|path|term|account)\]/g;

const nonWs = (s) => [...s].filter((c) => !/\s/u.test(c)).length;

/** Maps a UTF-16 index in `text` to the code-point offset `[...text.slice(0, index)].length`
 *  gives, in constant time after one linear pass (built on the first lookup). Counting from
 *  index 0 for every match made a long input with thousands of matches quadratic. A low
 *  surrogate right after a high one closes a pair and adds nothing; every other unit, a lone
 *  surrogate included, is one code point, exactly as the string iterator counts it. */
export function codePointOffsets(text) {
  let table = null;
  return (index) => {
    if (!table) {
      table = new Uint32Array(text.length + 1);
      for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        const closesPair = c >= 0xdc00 && c <= 0xdfff && i > 0 && (text.charCodeAt(i - 1) & 0xfc00) === 0xd800;
        table[i + 1] = table[i] + (closesPair ? 0 : 1);
      }
    }
    return table[index];
  };
}

function addRegex(matches, text, toCp, detector, regex, placeholder, accept = () => true) {
  regex.lastIndex = 0;
  for (const m of text.matchAll(regex)) {
    if (!m[0] || !accept(m[0])) continue;
    // A home path keeps the backslashes of an escaped quote it ends against (`…\\repo\"`).
    const end = detector === 'home-path' ? pathMatchEnd(text, m.index, m.index + m[0].length) : m.index + m[0].length;
    matches.push({ detector, start: toCp(m.index), end: toCp(end), placeholder });
  }
}

function candidates(raw, config, { fields = true } = {}) {
  const out = [];
  const configured = [
    ...(config?.redaction?.codenames ?? []), ...(config?.redaction?.names ?? []), ...(config?.redaction?.terms ?? []),
  ];
  const never = config?.privacy?.publicRenditions?.neverPublicTerms ?? [];
  const toCp = codePointOffsets(raw);
  const add = (detector, re, placeholder, accept) => addRegex(out, raw, toCp, detector, re, placeholder, accept);
  for(const re of termMatchers(configured,config?.redaction?.names ?? []))add('configured-term',re,PLACEHOLDER['configured-term']);
  for(const re of termMatchers(never))add('never-public-term',re,PLACEHOLDER['never-public-term']);
  for (const [from, to] of emailSpans(raw)) out.push({ detector: 'email', start: toCp(from), end: toCp(to), placeholder: PLACEHOLDER.email });
  for (const m of raw.matchAll(/(?<!\d)(?:\+?[\d(). -]){8,22}(?!\d)/g)) {
    const s = m[0]; const n = (s.match(/\d/g) ?? []).length;
    if (!(n >= 8 && n <= 15 && /[+ .()-]/.test(s))) continue;
    let end = m.index + s.length;
    // A phone-shaped run doesn't take the dashes of a flag right after it.
    if (s.endsWith('-') && /[A-Za-z]/.test(raw[end] ?? '')) while (end > m.index && /[ -]/.test(raw[end - 1])) end -= 1;
    out.push({ detector: 'phone', start: toCp(m.index), end: toCp(end), placeholder: PLACEHOLDER.phone });
  }
  REDACTION_SOURCES.paths.forEach((s,i)=>add('home-path',regex(s,i===1?'gi':'g'),PLACEHOLDER['home-path']));
  add('uuid', regex(REDACTION_SOURCES.uuid), PLACEHOLDER.uuid);
  REDACTION_SOURCES.api.forEach((s)=>add('secret',regex(s),PLACEHOLDER.secret));
  // A "value" starting with "=" is the rest of an == or === comparison: only its operand is
  // a span, as in the canonical scrubber, and none when the operand is already a placeholder.
  const kv=regex(REDACTION_SOURCES.keyValue);for(const m of raw.matchAll(kv)){if(!regex(REDACTION_SOURCES.sensitiveKey,'i').test(m[1]))continue;const offset=m[0].lastIndexOf(m[2]);if(m[2].startsWith('=')){const operand=m[2].replace(/^=+/,'');if(!operand||/^\[redacted:(?:email|secret|path|term|account)\](?:["'].*)?$/s.test(operand))continue;const from=m.index+offset+m[2].length-operand.length;out.push({detector:'secret',start:toCp(from),end:toCp(from+operand.length),placeholder:PLACEHOLDER.secret});continue;}out.push({detector:'secret',start:toCp(m.index+offset),end:toCp(m.index+offset+m[2].length),placeholder:PLACEHOLDER.secret});}
  add('secret', regex(REDACTION_SOURCES.opaque), PLACEHOLDER.secret,
    (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s) && !(/^[0-9a-f]{7,40}$/.test(s) && /[a-f]/.test(s)));
  REDACTION_SOURCES.currency.forEach((s)=>add('currency',regex(s,'gi'),PLACEHOLDER.currency));
  add('account-number', regex(REDACTION_SOURCES.account), PLACEHOLDER['account-number']);
  add('ip-address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, PLACEHOLDER['ip-address'], (s) => isIP(s) === 4);
  // Match the whole colon-bearing token before asking net.isIP. A bounded
  // 2..7-colon pattern can otherwise redact a valid-looking prefix of an
  // invalid overlong address and leave the suffix behind as apparently safe.
  add('ip-address', /(?<![\p{L}\p{N}:])(?:[0-9A-Fa-f]*:){2,}[0-9A-Fa-f]*(?![\p{L}\p{N}:])/gu, PLACEHOLDER['ip-address'], (s) => isIP(s) === 6);
  if (!fields) return out;
  // The secret-field forms last, read the way the canonical scrubber reads them.
  const ops = selectedOps(raw, config, out);
  const chars = [...raw];
  const lead = ops.map((op) => {
    let t = op.start;
    while (t < op.end && /\s/u.test(chars[t])) t += 1;
    return t < op.end ? t : op.start;
  });
  let hits = secretFieldSpans(raw, chars, ops, () => false);
  if (ops.some((op, i) => lead[i] > op.start)) {
    // A span that starts with spaces (a phone-shaped run takes the one before it) hides the
    // gap a flag or a Bearer reads before its value (`--password 20240101Secret!`). A first
    // read gives every span its spaces back; a span keeps them only when a hidden value then
    // starts right after them, and the fields are read again with just those, so the
    // rendition has the layout they were read from. Text with no hidden value there keeps
    // its spans as they were.
    const trial = new Set(secretFieldSpans(raw, chars, ops, () => true).map((h) => h.start));
    const gapped = new Set(ops.filter((op, i) => lead[i] > op.start && trial.has(lead[i])));
    if (gapped.size) {
      hits = secretFieldSpans(raw, chars, ops, (op) => gapped.has(op));
      // Each candidate that starts in a kept gap now starts after it (gaps are in order).
      const gaps = ops.flatMap((op, i) => (gapped.has(op) ? [[op.start, lead[i]]] : []));
      for (const c of out) {
        let lo = 0;
        let hi = gaps.length - 1;
        let k = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (gaps[mid][0] <= c.start) { k = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (k >= 0 && c.start < gaps[k][1] && c.end > gaps[k][1]) c.start = gaps[k][1];
      }
    }
  }
  out.push(...hits);
  return out;
}

/** The secret-field values (a password in a web address or after curl -u, a SecureString
 *  literal, a sensitive field or flag's value, a Bearer or Basic credential) the canonical
 *  scrubber would hide, as 'secret' spans over `raw` in code points. The scrubber reads these
 *  last, on its text with every other placeholder set down (lib/redact.mjs, step 10b). This
 *  builds the same view from the other detectors' selected spans `ops` and runs the same step
 *  on it (hideSecretFields), so the audit hides what the scrubber hides, and the scrubber
 *  leaves the audited rendition as it is. */
function secretFieldSpans(raw, chars, ops, gapped) {
  const delimiter = freshDelimiter(raw);
  const parts = [];
  let view = '';
  // For each UTF-16 index of the view: the code point of `raw` a span starting there starts
  // at, and the one a span ending there ends at. A set-aside part maps whole.
  const starts = [];
  const ends = [];
  const setAside = (part, from, to) => {
    parts.push(part);
    const t = `${delimiter}${parts.length - 1}${delimiter}`;
    for (let k = 0; k < t.length; k += 1) {
      starts.push(from);
      ends.push(k === 0 ? from : to);
    }
    view += t;
  };
  const addText = (a, b) => {
    const seg = chars.slice(a, b).join('');
    const cp = codePointOffsets(seg);
    // Placeholders already in the text are set aside, as the scrubber freezes them.
    const pieces = [];
    for (const m of seg.matchAll(PLACEHOLDER_RE)) pieces.push([m.index, m.index + m[0].length, { text: m[0] }]);
    let at = 0;
    const literal = (to) => {
      for (let i = at; i < to; i += 1) {
        const c = seg.charCodeAt(i);
        const low = c >= 0xdc00 && c <= 0xdfff && i > 0 && (seg.charCodeAt(i - 1) & 0xfc00) === 0xd800;
        starts.push(a + cp(i) - (low ? 1 : 0));
        ends.push(a + cp(i));
      }
      view += seg.slice(at, to);
    };
    for (const [from, to, part] of pieces) {
      literal(from);
      setAside(part, a + cp(from), a + cp(to));
      at = to;
    }
    literal(seg.length);
  };
  let cursor = 0;
  for (const op of ops) {
    addText(cursor, op.start);
    // A span given its leading spaces back (see candidates) keeps them as text.
    let from = op.start;
    if (gapped(op)) while (from < op.end - 1 && /\s/u.test(chars[from])) from += 1;
    addText(op.start, from);
    setAside({ text: op.placeholder }, from, op.end);
    cursor = op.end;
  }
  addText(cursor, chars.length);
  starts.push(chars.length);
  ends.push(chars.length);

  const hidden = hideSecretFields(view, {
    delimiter,
    partText: (n) => parts[n]?.text,
    hide: (value) => {
      parts.push({ text: PLACEHOLDER.secret, hid: value });
      return `${delimiter}${parts.length - 1}${delimiter}`;
    },
  });
  // Each hidden value's place in the view, found by putting the values back in order (a
  // value may hold one hidden before it).
  const tokens = new RegExp(tokenSource(delimiter), 'g');
  const spans = [];
  let pos = 0;
  const walk = (text) => {
    let at = 0;
    for (const m of text.matchAll(tokens)) {
      pos += m.index - at;
      const part = parts[Number(m[1])];
      if (part?.hid !== undefined) {
        const from = pos;
        walk(part.hid);
        spans.push([from, pos]);
      } else pos += m[0].length;
      at = m.index + m[0].length;
    }
    pos += text.length - at;
  };
  walk(hidden);
  if (pos !== view.length) throw new Error('prompt privacy: secret-field spans did not map back to the source.');
  return spans.map(([from, to]) => ({ detector: 'secret', start: starts[from], end: ends[to], placeholder: PLACEHOLDER.secret }))
    .filter((op) => op.end > op.start);
}

function selectedOps(raw, config, found = candidates(raw, config)) {
  const rank = new Map(DETECTOR_ORDER.map((x, i) => [x, i]));
  const sorted = found.slice().sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || rank.get(a.detector) - rank.get(b.detector));
  const out = [];
  for (const op of sorted) {
    const previous = out.at(-1);
    if (!previous || op.start >= previous.end) { out.push({ ...op }); continue; }
    previous.end = Math.max(previous.end, op.end);
    if (rank.get(op.detector) < rank.get(previous.detector)) {
      previous.detector = op.detector;
      previous.placeholder = op.placeholder;
    }
  }
  return out;
}

export function replayRedactions(raw, ops) {
  const chars = [...raw];
  let at = 0; let out = '';
  for (const op of ops) { out += chars.slice(at, op.start).join('') + op.placeholder; at = op.end; }
  return out + chars.slice(at).join('');
}

function capitalizedUnknown(text) {
  const frozen = text.normalize('NFKC').replace(PLACEHOLDER_RE, (s) => ' '.repeat(s.length));
  const chars = [...frozen];
  const toCp = codePointOffsets(frozen);
  const re = /\p{Lu}[\p{L}\p{M}\p{N}_'’-]*/gu;
  for (const m of frozen.matchAll(re)) {
    if (SAFE_CAPS.has(m[0])) continue;
    const cp = toCp(m.index);
    if (cp === 0) continue;
    let i = cp - 1; while (i >= 0 && /\s/u.test(chars[i])) i--;
    if (i >= 0 && /[.!?]/u.test(chars[i])) continue;
    return true;
  }
  return false;
}

export function assessPublicRendition(text, config = {}, { isPrivate = false } = {}) {
  const frozen = text.replace(PLACEHOLDER_RE, (s) => ' '.repeat(s.length));
  const high = candidates(frozen, config, { fields: false }).some((x) => REPLACEABLE_DETECTORS.includes(x.detector));
  if (high) return 'high';
  // The secret fields are read with the placeholders kept, as the scrubber reads them: blanked,
  // `token: [redacted:secret] then retries` would read "then" as the token.
  if (secretFieldSpans(text, [...text], [], () => false).length) return 'high';
  return isPrivate || capitalizedUnknown(text) ? 'medium' : 'low';
}

export function redactWithAudit(raw, config = {}, { isPrivate = false } = {}) {
  if (typeof raw !== 'string' || nonWs(raw) === 0) throw new Error('prompt privacy: source text must be nonempty.');
  const sourceLength = nonWs(raw);
  const found=candidates(raw,config);const ops = selectedOps(raw, config, found);
  const full = replayRedactions(raw, ops);
  const rawDetectors = [...new Set(found.map((x) => x.detector))];
  if (isPrivate) rawDetectors.push('display-context');
  if (capitalizedUnknown(full)) rawDetectors.push('capitalized-unknown');
  rawDetectors.sort((a, b) => DETECTOR_ORDER.indexOf(a) - DETECTOR_ORDER.indexOf(b));
  const rawRisk = rawDetectors.some((x) => REPLACEABLE_DETECTORS.includes(x)) ? 'high' : rawDetectors.length ? 'medium' : 'low';
  const rawChars = [...raw];
  const changed = ops.reduce((n, op) => n + nonWs(rawChars.slice(op.start, op.end).join('')), 0);
  const changedPercent = Math.ceil(100 * changed / sourceLength);
  const chars = [...full];
  return {
    text: chars.slice(0, 4000).join(''), redactionOps: ops, redactionCount: ops.length,
    sourceLength, changedPercent, rawRisk, rawDetectors,
    truncated: chars.length > 4000,
    residualRisk: assessPublicRendition(full, config, { isPrivate }),
  };
}
