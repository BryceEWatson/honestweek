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

export function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateLifecycleWeek(week, name = 'lifecycle week') {
  exactObject(week, ['start', 'end'], name);
  if (!validDateKey(week.start) || !validDateKey(week.end)) throw new Error(`${name} is invalid.`);
  const expectedEnd = new Date(`${week.start}T00:00:00.000Z`);
  expectedEnd.setUTCDate(expectedEnd.getUTCDate() + 6);
  if (expectedEnd.toISOString().slice(0, 10) !== week.end) throw new Error(`${name} is invalid.`);
  return week;
}

export function addWeeks(weekStart, count) {
  if (!validDateKey(weekStart)) throw new Error('lifecycle week arithmetic is invalid.');
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
      !validDateKey(value.targetWeek)) throw new Error('digest renewal is invalid.');
  return value;
}

export function validateLifecycleEntry(value) {
  exactObject(value, ['lineageRef', 'itemRef', 'firstSeenWeek', 'asOfWeek', 'mode'], 'digest lifecycle entry');
  if (!HEX_64.test(value.lineageRef) || !HEX_64.test(value.itemRef) ||
      !validDateKey(value.firstSeenWeek) || !validDateKey(value.asOfWeek) ||
      value.firstSeenWeek > value.asOfWeek || !['automatic', 'manual'].includes(value.mode)) {
    throw new Error('digest lifecycle entry is invalid.');
  }
  return value;
}

export function assessCandidatePublicSafety(candidate, config) {
  if (candidate.isPrivate) return { decision: 'private-source', residualRisk: 'high' };
  if (createRedactor(config).redact(candidate.text) !== candidate.text) {
    return { decision: 'high-risk', residualRisk: 'high' };
  }
  const residualRisk = assessPublicRendition(candidate.text, config);
  if (residualRisk === 'high') return { decision: 'high-risk', residualRisk };
  if (candidate.truncated ||
      candidate.changedPercent > config.privacy.publicRenditions.maxAutomaticChangedPercent ||
      candidate.rawDetectors.includes('capitalized-unknown') || residualRisk === 'medium') {
    return { decision: 'needs-approval', residualRisk };
  }
  if (!config.privacy.publicRenditions.enabled) {
    return { decision: 'public-renditions-disabled', residualRisk };
  }
  return { decision: 'automatic-safe', residualRisk };
}

export function validateRetired(value, config, { historical = false } = {}) {
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
      subjectFingerprint(value.subject) !== value.subjectFingerprint ||
      (!historical && (createRedactor(config).redact(value.subject) !== value.subject ||
        assessPublicRendition(value.subject, config) !== 'low'))) {
    throw new Error('digest retired subject fingerprint is invalid.');
  }
  return value;
}

export function retiredRow({ entry, reason, terminalRef = null, config }) {
  const safe = assessCandidatePublicSafety(entry.candidate, config).decision === 'automatic-safe';
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
