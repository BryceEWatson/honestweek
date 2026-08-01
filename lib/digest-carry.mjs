import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson } from './atomic-json.mjs';
import { sha256 } from './prompt-identity.mjs';
import { DIGEST_CATEGORIES } from './digest-schema.mjs';
import {
  digestPolicyForConfig, validateDigestCandidate, validateDigestLane, validateDigestReview,
} from './digest-store.mjs';
import {
  HEX_64, addWeeks, effectiveAutomaticCarryWeeks, effectiveRetentionWeeks, exactObject,
  subjectFingerprint, validateLifecycleWeek, validateRetired, validIso,
} from './digest-lifecycle.mjs';

export const CARRY_STORE = 'honestweek.carry.json';
export const CARRY_PENDING = 'honestweek.carry.pending.json';
export const CARRY_GITIGNORE = Object.freeze([
  CARRY_STORE, `${CARRY_STORE}.tmp-*`, CARRY_PENDING, `${CARRY_PENDING}.tmp-*`,
]);

const ENTRY_KEYS = [
  'lineageRef','itemRef','category','firstSeenWeek','lastShownWeek','automaticThroughWeek',
  'manualTargetWeek','strength','candidate',
];
const WEEK_RECORD_KEYS = ['week','entries','retired'];
const TOMBSTONE_KEYS = ['itemRef','category','evidenceRefs','deletedAt','week'];
const PENDING_KEYS = [
  'version','generation','priorCarryHash','nextCarryHash','targetOutputHash','week','phase','carry',
];

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashBytes(value) {
  return sha256(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
}

export function hashLocalFile(path) {
  return existsSync(path) ? hashBytes(readFileSync(path)) : null;
}

function validWeekKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function validateCarryEntry(entry, config) {
  exactObject(entry, ENTRY_KEYS, 'carry entry');
  if (!HEX_64.test(entry.lineageRef) || !HEX_64.test(entry.itemRef) ||
      !DIGEST_CATEGORIES.includes(entry.category) || !validWeekKey(entry.firstSeenWeek) ||
      !validWeekKey(entry.lastShownWeek) || entry.firstSeenWeek > entry.lastShownWeek ||
      (entry.automaticThroughWeek !== null && !validWeekKey(entry.automaticThroughWeek)) ||
      (entry.manualTargetWeek !== null && !validWeekKey(entry.manualTargetWeek)) ||
      !['automatic','explicit'].includes(entry.strength) ||
      (entry.automaticThroughWeek === null && entry.manualTargetWeek === null)) {
    throw new Error('carry entry is invalid.');
  }
  if (entry.itemRef !== entry.candidate?.itemRef || entry.category !== entry.candidate?.category ||
      entry.candidate?.state !== 'inbox') throw new Error('carry entry candidate identity/state is invalid.');
  validateDigestCandidate(entry.candidate, config, digestPolicyForConfig(config));
  return entry;
}

export function validateCarryTombstone(value) {
  exactObject(value, TOMBSTONE_KEYS, 'carry tombstone');
  validateLifecycleWeek(value.week, 'carry tombstone week');
  if (!HEX_64.test(value.itemRef) || !DIGEST_CATEGORIES.includes(value.category) ||
      !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 ||
      value.evidenceRefs.some((ref) => !HEX_64.test(ref)) ||
      JSON.stringify(value.evidenceRefs) !== JSON.stringify([...new Set(value.evidenceRefs)].sort()) ||
      !validIso(value.deletedAt)) throw new Error('carry tombstone is invalid.');
  return value;
}

export function validateCarry(value, config) {
  exactObject(value, ['version','weeks','tombstones'], 'carry');
  if (value.version !== 1 || !Array.isArray(value.weeks) || !Array.isArray(value.tombstones) ||
      value.weeks.length > effectiveRetentionWeeks(config)) throw new Error('carry schema is invalid.');
  let prior = null;
  for (const record of value.weeks) {
    exactObject(record, WEEK_RECORD_KEYS, 'carry week record');
    validateLifecycleWeek(record.week, 'carry week');
    if (prior && prior >= record.week.start) throw new Error('carry weeks are duplicate or not canonical.');
    prior = record.week.start;
    if (!Array.isArray(record.entries) || !Array.isArray(record.retired)) throw new Error('carry week record is invalid.');
    const refs = new Set();
    for (const entry of record.entries) {
      validateCarryEntry(entry, config);
      if (refs.has(entry.lineageRef)) throw new Error('carry week has duplicate active lineage.');
      refs.add(entry.lineageRef);
    }
    for (const retired of record.retired) validateRetired(retired, config);
    const entries = record.entries.slice().sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    const retired = record.retired.slice().sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    if (JSON.stringify(record.entries) !== JSON.stringify(entries) || JSON.stringify(record.retired) !== JSON.stringify(retired)) {
      throw new Error('carry week rows are not canonical.');
    }
  }
  const seen = new Set();
  for (const tombstone of value.tombstones) {
    validateCarryTombstone(tombstone);
    const key = `${tombstone.week.start}\0${tombstone.itemRef}`;
    if (seen.has(key)) throw new Error('carry has duplicate tombstone.');
    seen.add(key);
  }
  const tombstones = value.tombstones.slice().sort((a, b) =>
    a.week.start.localeCompare(b.week.start) || a.itemRef.localeCompare(b.itemRef));
  if (JSON.stringify(value.tombstones) !== JSON.stringify(tombstones)) throw new Error('carry tombstones are not canonical.');
  return value;
}

export function emptyCarry() {
  return { version: 1, weeks: [], tombstones: [] };
}

export function readCarry(cwd, config, { optional = false } = {}) {
  const path = join(cwd, CARRY_STORE);
  if (!existsSync(path)) {
    if (optional) return { value: null, hash: null, bytes: null };
    throw new Error(`${CARRY_STORE} not found.`);
  }
  const bytes = readFileSync(path);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${CARRY_STORE} is not valid JSON (${error.message}).`); }
  validateCarry(value, config);
  if (canonicalJson(value) !== bytes.toString('utf8')) throw new Error(`${CARRY_STORE} is not canonical JSON.`);
  return { value, hash: hashBytes(bytes), bytes };
}

export function writeCarry(cwd, value, config, fs) {
  validateCarry(value, config);
  const text = canonicalJson(value);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error(`${CARRY_STORE} exceeds the 8 MiB cap.`);
  atomicWriteJson(join(cwd, CARRY_STORE), value, fs);
}

export function carryRecordBefore(carry, week) {
  if (!carry) return null;
  const latest = carry.weeks.at(-1);
  if (latest && latest.week.start > week.start) throw new Error('carry backfill is not supported; no state was changed.');
  return carry.weeks.filter((record) => record.week.start < week.start).at(-1) ?? null;
}

export function carryTombstonesForWeek(carry, week) {
  return (carry?.tombstones ?? []).filter((value) =>
    value.week.start === week.start && value.week.end === week.end);
}

export function validateCarryPending(value, config) {
  exactObject(value, PENDING_KEYS, 'carry pending');
  if (value.version !== 1 || !HEX_64.test(value.generation) ||
      (value.priorCarryHash !== null && !HEX_64.test(value.priorCarryHash)) ||
      !HEX_64.test(value.nextCarryHash) || !HEX_64.test(value.targetOutputHash) ||
      !['prepared','output-written'].includes(value.phase)) throw new Error('carry pending is invalid.');
  validateLifecycleWeek(value.week, 'carry pending week');
  validateCarry(value.carry, config);
  if (hashBytes(canonicalJson(value.carry)) !== value.nextCarryHash) throw new Error('carry pending next hash mismatch.');
  return value;
}

export function carryGeneration({ week, priorCarryHash, nextCarryHash, targetOutputHash, outputBinding }) {
  return sha256(`${week.start}\0${week.end}\0${priorCarryHash ?? ''}\0${nextCarryHash}\0${targetOutputHash}\0${JSON.stringify(outputBinding)}`);
}

export function makeCarryPending({ week, priorCarryHash, carry, targetOutputHash, outputBinding, config }) {
  validateCarry(carry, config);
  const nextCarryHash = hashBytes(canonicalJson(carry));
  const generation = carryGeneration({ week, priorCarryHash, nextCarryHash, targetOutputHash, outputBinding });
  return validateCarryPending({
    version: 1, generation, priorCarryHash, nextCarryHash, targetOutputHash,
    week, phase: 'prepared', carry,
  }, config);
}

export function readCarryPending(cwd, config, { optional = false } = {}) {
  const path = join(cwd, CARRY_PENDING);
  if (!existsSync(path)) {
    if (optional) return null;
    throw new Error(`${CARRY_PENDING} not found.`);
  }
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`${CARRY_PENDING} is not valid JSON (${error.message}).`); }
  return validateCarryPending(value, config);
}

export function writeCarryPending(cwd, value, config, fs) {
  atomicWriteJson(join(cwd, CARRY_PENDING), validateCarryPending(value, config), fs);
}

export function removeCarryPending(cwd, fs = { unlinkSync }) {
  fs.unlinkSync(join(cwd, CARRY_PENDING));
}

export function assertNoCarryPending(cwd) {
  if (existsSync(join(cwd, CARRY_PENDING))) {
    throw new Error(`${CARRY_PENDING} is present; run honestweek digest recover before continuing.`);
  }
}

export function recoverCarryPending({ cwd, config, outputPath, outputBinding, discard = false, fs = {} }) {
  const pending = readCarryPending(cwd, config, { optional: true });
  if (!pending) return { recovered: false, action: 'none' };
  const expectedGeneration = carryGeneration({
    week: pending.week,
    priorCarryHash: pending.priorCarryHash,
    nextCarryHash: pending.nextCarryHash,
    targetOutputHash: pending.targetOutputHash,
    outputBinding,
  });
  if (expectedGeneration !== pending.generation) {
    throw new Error('carry pending generation does not match the active output binding; no state was changed.');
  }
  const currentCarry = readCarry(cwd, config, { optional: true });
  const outputHash = hashLocalFile(outputPath);
  const outputTarget = outputHash === pending.targetOutputHash;
  const carryPrior = currentCarry.hash === pending.priorCarryHash;
  const carryNext = currentCarry.hash === pending.nextCarryHash;
  if (discard) {
    if (outputTarget || !carryPrior) {
      throw new Error('carry pending can be discarded only when output differs and carry remains at its prior hash.');
    }
    removeCarryPending(cwd, fs.remove);
    return { recovered: true, action: 'discarded' };
  }
  if (outputTarget && carryPrior) {
    writeCarry(cwd, pending.carry, config, fs.carry);
    removeCarryPending(cwd, fs.remove);
    return { recovered: true, action: 'promoted' };
  }
  if (outputTarget && carryNext) {
    removeCarryPending(cwd, fs.remove);
    return { recovered: true, action: 'completed' };
  }
  if (!outputTarget && carryPrior) {
    throw new Error('carry pending has no matching output; run honestweek digest recover --discard-pending after verifying the prior output.');
  }
  throw new Error('carry pending hashes are in an unknown state; no state was changed.');
}

function normalizedCarryCandidate(candidate) {
  return { ...structuredClone(candidate), state: 'inbox' };
}

function canonicalEntries(values) {
  return values.sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
}

function canonicalRetired(values) {
  return values.sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
}

export function assertLifecycleJoins({ review, lane, priorCarryHash, config }) {
  validateDigestReview(review, config);
  validateDigestLane(lane, config);
  if (review.week.start !== lane.week.start || review.week.end !== lane.week.end) {
    throw new Error('digest lifecycle review and lane weeks differ.');
  }
  const lifecycleItems = lane.items.filter((item) => ['carried','renewed'].includes(item.curationState));
  if (review.version !== 3) {
    if (lifecycleItems.length) throw new Error('digest lane has lifecycle items without lifecycle review state.');
    return true;
  }
  if (review.lifecycle.carryHash !== priorCarryHash) throw new Error('digest lifecycle carry hash is stale.');
  const itemByRef = new Map(lane.items.map((item) => [item.itemRef, item]));
  const candidateByRef = new Map(review.candidates.map((candidate) => [candidate.itemRef, candidate]));
  for (const entry of review.lifecycle.entries) {
    const candidate = candidateByRef.get(entry.itemRef);
    const item = itemByRef.get(entry.itemRef);
    if (!candidate) throw new Error('digest lifecycle entry has no candidate.');
    if (candidate.decision === 'automatic-safe') {
      const expectedState = entry.mode === 'manual' ? 'renewed'
        : candidate.state === 'kept' ? 'kept' : 'carried';
      if (!item || item.curationState !== expectedState) {
        throw new Error('selected digest lifecycle entry does not match the public lane.');
      }
    } else if (item) {
      throw new Error('withheld digest lifecycle entry appears in the public lane.');
    }
  }
  for (const item of lifecycleItems) {
    if (!review.lifecycle.entries.some((entry) => entry.itemRef === item.itemRef)) {
      throw new Error('public lifecycle item has no private lifecycle entry.');
    }
  }
  for (const row of review.lifecycle.retired) {
    if (lane.items.some((item) => item.itemRef === row.itemRef)) {
      throw new Error('retired digest lifecycle row appears in the public lane.');
    }
  }
  for (const renewal of review.renewals) {
    const candidate = candidateByRef.get(renewal.itemRef);
    if (!candidate || candidate.state === 'hidden' || candidate.decision !== 'automatic-safe') {
      throw new Error('digest renewal no longer names a live selected public-safe candidate.');
    }
  }
  return true;
}

export function lifecycleTransactionNeeded({ review, lane, priorCarry }) {
  const selectedRefs = new Set(lane.items.map((item) => item.itemRef));
  const eligibleFresh = review.candidates.some((candidate) => selectedRefs.has(candidate.itemRef) &&
    (candidate.category === 'nextSteps' || candidate.discriminator.startsWith('unresolved-idea:')));
  return eligibleFresh || (review.tombstones?.length ?? 0) > 0 || priorCarry !== null ||
    (review.version === 3 && (review.renewals.length > 0 || review.lifecycle.entries.length > 0 ||
      review.lifecycle.retired.length > 0));
}

export function deriveNextCarry({ priorCarry, priorCarryHash, review, lane, week, config }) {
  assertLifecycleJoins({ review, lane, priorCarryHash, config });
  const carry = priorCarry ? structuredClone(priorCarry) : emptyCarry();
  const latest = carry.weeks.at(-1);
  if (latest && latest.week.start > week.start) throw new Error('carry backfill is not supported; no state was changed.');
  const priorRecord = carryRecordBefore(carry, week);
  const active = new Map((priorRecord?.entries ?? []).map((entry) => [entry.lineageRef, structuredClone(entry)]));
  const retired = review.version === 3 ? structuredClone(review.lifecycle.retired) : [];
  const lifecycleByLineage = new Map((review.version === 3 ? review.lifecycle.entries : [])
    .map((entry) => [entry.lineageRef, entry]));
  const retiredLineages = new Set(retired.filter((row) => row.reason !== 'superseded').map((row) => row.lineageRef));
  const candidateByRef = new Map(review.candidates.map((candidate) => [candidate.itemRef, candidate]));
  const publicByRef = new Map(lane.items.map((item) => [item.itemRef, item]));

  for (const [lineageRef, entry] of active) {
    if (retiredLineages.has(lineageRef)) {
      active.delete(lineageRef);
      continue;
    }
    const lifecycle = lifecycleByLineage.get(lineageRef);
    if (!lifecycle) continue;
    const candidate = candidateByRef.get(lifecycle.itemRef);
    if (!candidate) throw new Error('digest lifecycle candidate disappeared during carry derivation.');
    entry.itemRef = candidate.itemRef;
    entry.category = candidate.category;
    entry.candidate = normalizedCarryCandidate(candidate);
    if (publicByRef.has(candidate.itemRef)) entry.lastShownWeek = week.start;
    if (lifecycle.mode === 'manual' && entry.manualTargetWeek === week.start) entry.manualTargetWeek = null;
    if (entry.automaticThroughWeek === null && entry.manualTargetWeek === null) active.delete(lineageRef);
  }

  const renewalByRef = new Map((review.version === 3 ? review.renewals : []).map((row) => [row.itemRef, row]));
  for (const renewal of renewalByRef.values()) {
    const existing = [...active.values()].find((entry) => entry.itemRef === renewal.itemRef);
    if (existing) {
      existing.manualTargetWeek = renewal.targetWeek;
      existing.strength = 'explicit';
      continue;
    }
    const candidate = candidateByRef.get(renewal.itemRef);
    if (!candidate) throw new Error('digest renewal candidate disappeared during carry derivation.');
    active.set(candidate.itemRef, {
      lineageRef: candidate.itemRef, itemRef: candidate.itemRef, category: candidate.category,
      firstSeenWeek: week.start, lastShownWeek: week.start,
      automaticThroughWeek: null, manualTargetWeek: renewal.targetWeek,
      strength: 'explicit', candidate: normalizedCarryCandidate(candidate),
    });
  }

  const autoWeeks = effectiveAutomaticCarryWeeks(config);
  const retiredFingerprints = new Set(carry.weeks.flatMap((record) => record.retired)
    .filter((row) => row.subjectFingerprint !== null)
    .map((row) => `${row.category}\0${row.subjectFingerprint}`));
  if (autoWeeks > 0) {
    for (const item of lane.items) {
      if (!['automatic','kept'].includes(item.curationState)) continue;
      const candidate = candidateByRef.get(item.itemRef);
      if (!candidate || (candidate.category !== 'nextSteps' && !candidate.discriminator.startsWith('unresolved-idea:'))) continue;
      if (retiredFingerprints.has(`${candidate.category}\0${subjectFingerprint(candidate.text)}`)) continue;
      const existing = [...active.values()].find((entry) => entry.itemRef === candidate.itemRef);
      if (existing) {
        if (existing.automaticThroughWeek === null) {
          existing.automaticThroughWeek = addWeeks(week.start, autoWeeks);
        }
        continue;
      }
      active.set(candidate.itemRef, {
        lineageRef: candidate.itemRef, itemRef: candidate.itemRef, category: candidate.category,
        firstSeenWeek: week.start, lastShownWeek: week.start,
        automaticThroughWeek: addWeeks(week.start, autoWeeks), manualTargetWeek: null,
        strength: item.curationState === 'kept' ? 'explicit' : 'automatic',
        candidate: normalizedCarryCandidate(candidate),
      });
    }
  }

  const tombstones = [...carry.tombstones];
  for (const tombstone of review.tombstones ?? []) {
    if (!tombstones.some((row) => row.week.start === week.start && row.itemRef === tombstone.itemRef)) {
      tombstones.push({ ...structuredClone(tombstone), week: structuredClone(week) });
    }
  }
  tombstones.sort((a, b) => a.week.start.localeCompare(b.week.start) || a.itemRef.localeCompare(b.itemRef));
  const record = {
    week: structuredClone(week),
    entries: canonicalEntries([...active.values()]),
    retired: canonicalRetired(retired),
  };
  const priorWeeks = carry.weeks.filter((row) => row.week.start < week.start);
  const weeks = [...priorWeeks, record].slice(-effectiveRetentionWeeks(config));
  return validateCarry({ version: 1, weeks, tombstones }, config);
}
