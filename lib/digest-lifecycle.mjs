import { assessPublicRendition, createRedactor } from './redact.mjs';
import { sha256 } from './prompt-identity.mjs';
import { DIGEST_CATEGORIES } from './digest-schema.mjs';

export const HEX_64 = /^[0-9a-f]{64}$/;
export const RETIREMENT_REASONS = Object.freeze([
  'automatic-limit', 'manual-expired', 'terminal-picked-up', 'terminal-ruled-out',
  'hidden', 'deleted', 'privacy-withheld', 'superseded',
]);
export const RETIREMENT_PRECEDENCE = Object.freeze([
  'deleted', 'hidden', 'terminal-picked-up', 'terminal-ruled-out',
  'privacy-withheld', 'superseded', 'automatic-limit', 'manual-expired',
]);

export function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const got = Object.keys(value).sort();
  const want = [...keys].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name} has unknown or missing keys.`);
}

export function validIso(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toISOString() === value;
}

export function validateLifecycleWeek(week, name = 'lifecycle week') {
  exactObject(week, ['start', 'end'], name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week.start) || !/^\d{4}-\d{2}-\d{2}$/.test(week.end) ||
      week.start > week.end) throw new Error(`${name} is invalid.`);
  return week;
}

export function addWeeks(weekStart, count) {
  const date = new Date(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || !Number.isInteger(count)) throw new Error('lifecycle week arithmetic is invalid.');
  date.setUTCDate(date.getUTCDate() + count * 7);
  return date.toISOString().slice(0, 10);
}

export function effectiveAutomaticCarryWeeks(config) {
  return Math.min(2, config.curation.automaticCarryWeeks);
}

export function effectiveRetentionWeeks(config) {
  return Math.min(12, config.curation.retentionWeeks);
}

export function normalizedSubject(value) {
  return String(value).normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

export function subjectFingerprint(value) {
  return sha256(normalizedSubject(value));
}

export function validateRenewal(value) {
  exactObject(value, ['itemRef', 'requestedAt', 'targetWeek'], 'digest renewal');
  if (!HEX_64.test(value.itemRef) || !validIso(value.requestedAt) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.targetWeek)) throw new Error('digest renewal is invalid.');
  return value;
}

export function validateLifecycleEntry(value) {
  exactObject(value, ['lineageRef', 'itemRef', 'firstSeenWeek', 'asOfWeek', 'mode'], 'digest lifecycle entry');
  if (!HEX_64.test(value.lineageRef) || !HEX_64.test(value.itemRef) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.firstSeenWeek) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.asOfWeek) ||
      value.firstSeenWeek > value.asOfWeek || !['automatic', 'manual'].includes(value.mode)) {
    throw new Error('digest lifecycle entry is invalid.');
  }
  return value;
}

export function validateRetired(value, config) {
  exactObject(value, [
    'lineageRef', 'itemRef', 'category', 'subject', 'subjectFingerprint',
    'reason', 'terminalRef',
  ], 'digest retired row');
  if (!HEX_64.test(value.lineageRef) || !HEX_64.test(value.itemRef) ||
      !DIGEST_CATEGORIES.includes(value.category) || !RETIREMENT_REASONS.includes(value.reason) ||
      (value.terminalRef !== null && !HEX_64.test(value.terminalRef))) {
    throw new Error('digest retired row is invalid.');
  }
  const terminal = value.reason === 'terminal-picked-up' || value.reason === 'terminal-ruled-out';
  if (terminal !== (value.terminalRef !== null)) throw new Error('digest retired terminal receipt is inconsistent.');
  if (value.subject === null || value.subjectFingerprint === null) {
    if (value.subject !== null || value.subjectFingerprint !== null) throw new Error('digest retired privacy state is inconsistent.');
    return value;
  }
  if (typeof value.subject !== 'string' || !value.subject.trim() || !HEX_64.test(value.subjectFingerprint) ||
      createRedactor(config).redact(value.subject) !== value.subject ||
      assessPublicRendition(value.subject, config) !== 'low' ||
      subjectFingerprint(value.subject) !== value.subjectFingerprint) {
    throw new Error('digest retired subject fingerprint is invalid.');
  }
  return value;
}

export function retiredRow({ entry, reason, terminalRef = null, config }) {
  const safe = assessPublicRendition(entry.candidate.text, config) === 'low' &&
    createRedactor(config).redact(entry.candidate.text) === entry.candidate.text;
  return validateRetired({
    lineageRef: entry.lineageRef,
    itemRef: entry.itemRef,
    category: entry.category,
    subject: safe ? entry.candidate.text : null,
    subjectFingerprint: safe ? subjectFingerprint(entry.candidate.text) : null,
    reason,
    terminalRef,
  }, config);
}

export function chooseRetirementReason(reasons) {
  for (const reason of RETIREMENT_PRECEDENCE) if (reasons.includes(reason)) return reason;
  return null;
}
