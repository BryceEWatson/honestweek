// Deterministic, prompt-specific privacy audit. Raw text is accepted only for
// this call and is never returned. The persisted result contains a redacted
// rendition plus replayable code-point spans and count-only risk metadata.

import { isIP } from 'node:net';
import { REDACTION_SOURCES, regex, termMatchers, pathMatchEnd } from './redaction-patterns.mjs';

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

function candidates(raw, config) {
  const out = [];
  const configured = [
    ...(config?.redaction?.codenames ?? []), ...(config?.redaction?.names ?? []), ...(config?.redaction?.terms ?? []),
  ];
  const never = config?.privacy?.publicRenditions?.neverPublicTerms ?? [];
  const toCp = codePointOffsets(raw);
  const add = (detector, re, placeholder, accept) => addRegex(out, raw, toCp, detector, re, placeholder, accept);
  for(const re of termMatchers(configured,config?.redaction?.names ?? []))add('configured-term',re,PLACEHOLDER['configured-term']);
  for(const re of termMatchers(never))add('never-public-term',re,PLACEHOLDER['never-public-term']);
  add('email', regex(REDACTION_SOURCES.email), PLACEHOLDER.email);
  add('phone', /(?<!\d)(?:\+?[\d(). -]){8,22}(?!\d)/g, PLACEHOLDER.phone,
    (s) => { const n = (s.match(/\d/g) ?? []).length; return n >= 8 && n <= 15 && /[+ .()-]/.test(s); });
  REDACTION_SOURCES.paths.forEach((s,i)=>add('home-path',regex(s,i===1?'gi':'g'),PLACEHOLDER['home-path']));
  add('uuid', regex(REDACTION_SOURCES.uuid), PLACEHOLDER.uuid);
  REDACTION_SOURCES.api.forEach((s)=>add('secret',regex(s),PLACEHOLDER.secret));
  const kv=regex(REDACTION_SOURCES.keyValue);for(const m of raw.matchAll(kv)){if(!regex(REDACTION_SOURCES.sensitiveKey,'i').test(m[1]))continue;const offset=m[0].lastIndexOf(m[2]);out.push({detector:'secret',start:toCp(m.index+offset),end:toCp(m.index+offset+m[2].length),placeholder:PLACEHOLDER.secret});}
  add('secret', regex(REDACTION_SOURCES.opaque), PLACEHOLDER.secret,
    (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s) && !(/^[0-9a-f]{7,40}$/.test(s) && /[a-f]/.test(s)));
  REDACTION_SOURCES.currency.forEach((s)=>add('currency',regex(s,'gi'),PLACEHOLDER.currency));
  add('account-number', regex(REDACTION_SOURCES.account), PLACEHOLDER['account-number']);
  add('ip-address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, PLACEHOLDER['ip-address'], (s) => isIP(s) === 4);
  // Match the whole colon-bearing token before asking net.isIP. A bounded
  // 2..7-colon pattern can otherwise redact a valid-looking prefix of an
  // invalid overlong address and leave the suffix behind as apparently safe.
  add('ip-address', /(?<![\p{L}\p{N}:])(?:[0-9A-Fa-f]*:){2,}[0-9A-Fa-f]*(?![\p{L}\p{N}:])/gu, PLACEHOLDER['ip-address'], (s) => isIP(s) === 6);
  return out;
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
  const high = candidates(frozen, config).some((x) => REPLACEABLE_DETECTORS.includes(x.detector));
  if (high) return 'high';
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
