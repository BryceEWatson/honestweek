// Deterministic, prompt-specific privacy audit. Raw text is accepted only for
// this call and is never returned. The persisted result contains a redacted
// rendition plus replayable code-point spans and count-only risk metadata.

import { isIP } from 'node:net';
import { REDACTION_SOURCES, regex, termMatchers } from './redaction-patterns.mjs';

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

const cpLength = (s) => [...s].length;
const nonWs = (s) => [...s].filter((c) => !/\s/u.test(c)).length;

function utf16ToCp(text, index) { return cpLength(text.slice(0, index)); }

function addRegex(matches, text, detector, regex, placeholder, accept = () => true) {
  regex.lastIndex = 0;
  for (const m of text.matchAll(regex)) {
    if (!m[0] || !accept(m[0])) continue;
    matches.push({ detector, start: utf16ToCp(text, m.index), end: utf16ToCp(text, m.index + m[0].length), placeholder });
  }
}

function candidates(raw, config) {
  const out = [];
  const configured = [
    ...(config?.redaction?.codenames ?? []), ...(config?.redaction?.names ?? []), ...(config?.redaction?.terms ?? []),
  ];
  const never = config?.privacy?.publicRenditions?.neverPublicTerms ?? [];
  for(const re of termMatchers(configured))addRegex(out,raw,'configured-term',re,PLACEHOLDER['configured-term']);
  for(const re of termMatchers(never))addRegex(out,raw,'never-public-term',re,PLACEHOLDER['never-public-term']);
  addRegex(out, raw, 'email', regex(REDACTION_SOURCES.email), PLACEHOLDER.email);
  addRegex(out, raw, 'phone', /(?<!\d)(?:\+?[\d(). -]){8,22}(?!\d)/g, PLACEHOLDER.phone,
    (s) => { const n = (s.match(/\d/g) ?? []).length; return n >= 8 && n <= 15 && /[+ .()-]/.test(s); });
  REDACTION_SOURCES.paths.forEach((s,i)=>addRegex(out,raw,'home-path',regex(s,i===1?'gi':'g'),PLACEHOLDER['home-path']));
  addRegex(out, raw, 'uuid', regex(REDACTION_SOURCES.uuid), PLACEHOLDER.uuid);
  REDACTION_SOURCES.api.forEach((s)=>addRegex(out,raw,'secret',regex(s),PLACEHOLDER.secret));
  const kv=regex(REDACTION_SOURCES.keyValue);for(const m of raw.matchAll(kv)){if(!regex(REDACTION_SOURCES.sensitiveKey,'i').test(m[1]))continue;const offset=m[0].lastIndexOf(m[2]);out.push({detector:'secret',start:utf16ToCp(raw,m.index+offset),end:utf16ToCp(raw,m.index+offset+m[2].length),placeholder:PLACEHOLDER.secret});}
  addRegex(out, raw, 'secret', regex(REDACTION_SOURCES.opaque), PLACEHOLDER.secret,
    (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s) && !(/^[0-9a-f]{7,40}$/.test(s) && /[a-f]/.test(s)));
  REDACTION_SOURCES.currency.forEach((s)=>addRegex(out,raw,'currency',regex(s,'gi'),PLACEHOLDER.currency));
  addRegex(out, raw, 'account-number', regex(REDACTION_SOURCES.account), PLACEHOLDER['account-number']);
  addRegex(out, raw, 'ip-address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, PLACEHOLDER['ip-address'], (s) => isIP(s) === 4);
  // Match the whole colon-bearing token before asking net.isIP. A bounded
  // 2..7-colon pattern can otherwise redact a valid-looking prefix of an
  // invalid overlong address and leave the suffix behind as apparently safe.
  addRegex(out, raw, 'ip-address', /(?<![\p{L}\p{N}:])(?:[0-9A-Fa-f]*:){2,}[0-9A-Fa-f]*(?![\p{L}\p{N}:])/gu, PLACEHOLDER['ip-address'], (s) => isIP(s) === 6);
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
  const re = /\p{Lu}[\p{L}\p{M}\p{N}_'’-]*/gu;
  for (const m of frozen.matchAll(re)) {
    if (SAFE_CAPS.has(m[0])) continue;
    const cp = utf16ToCp(frozen, m.index);
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
  const changed = ops.reduce((n, op) => n + nonWs([...raw].slice(op.start, op.end).join('')), 0);
  const changedPercent = Math.ceil(100 * changed / sourceLength);
  const chars = [...full];
  return {
    text: chars.slice(0, 4000).join(''), redactionOps: ops, redactionCount: ops.length,
    sourceLength, changedPercent, rawRisk, rawDetectors,
    truncated: chars.length > 4000,
    residualRisk: assessPublicRendition(full, config, { isPrivate }),
  };
}
