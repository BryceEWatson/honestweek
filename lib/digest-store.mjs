import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson } from './atomic-json.mjs';
import { createRedactor } from './redact.mjs';
import {
  DIGEST_CATEGORIES, DIGEST_CATEGORY_GROUP, DIGEST_CATEGORY_KIND,
  DIGEST_DECISIONS, DIGEST_SIGNALS,
} from './digest-schema.mjs';
import { digestItemIdentity, sha256 } from './prompt-identity.mjs';
import { DETECTOR_ORDER, REPLACEABLE_DETECTORS } from './prompt-privacy.mjs';
import {
  validateLifecycleEntry, validateRenewal, validateRetired,
} from './digest-lifecycle.mjs';

export const DIGEST_STORE = 'honestweek.curated.json';
export const DIGEST_PENDING = 'honestweek.digest.pending.json';
export const DIGEST_GITIGNORE = Object.freeze([
  DIGEST_STORE, `${DIGEST_STORE}.tmp-*`, DIGEST_PENDING, `${DIGEST_PENDING}.tmp-*`,
]);

const HEX = /^[0-9a-f]{64}$/;
const REVIEW_V1_KEYS = ['version','generatedAt','week','sourceStatus','policy','candidates','withheld'];
const REVIEW_V2_KEYS = [...REVIEW_V1_KEYS, 'tombstones'];
const REVIEW_V3_KEYS = [...REVIEW_V2_KEYS, 'renewals', 'lifecycle'];
const LANE_KEYS = ['version','week','generatedAt','outputBinding','policy','sourceStatus','items','withheld'];
const POLICY_KEYS = ['version','maxItems','automaticMinScore','categoryCaps','weights','maxAutomaticChangedPercent','publicRenditionsEnabled'];
const CANDIDATE_KEYS = [
  'itemRef','category','discriminator','evidenceRefs','receipts','timestamp','project','isPrivate','state','text',
  'sourceHash','contentHash','sourceLength','redactionCount','changedPercent','rawRisk','rawDetectors','redactionOps',
  'transform','truncated','signals','score','selectionReasonCode','selectionReason','decision','privacy',
];
const ITEM_KEYS = [
  'id','itemRef','evidenceRefs','receipts','kind','category','week','curationState','publicDisposition','status',
  'project','repo','date','title','summary','receipt','snippets','selection','privacy',
];
const RECEIPT_KEYS = ['source','sessionKey','turn','kind','ref'];
const PRIVATE_PRIVACY_KEYS = ['sourceRefs','sourceContentHashes','renditionHash','transform','changedPercent','rawRisk','residualRisk','decision','policyVersion'];
const SELECTION_KEYS = ['score','reasonCodes','primaryReasonCode','reason'];
const COMPAT_RECEIPT_KEYS = ['sessionId','ref','turn'];
const SNIPPET_KEYS = ['kind','source','text','provenance'];
const WITHHELD_KEYS = ['total','byCategory','scanExcluded'];
const OUTPUT_BINDING_KEYS = ['mode','adapterHash','objectives'];
const PENDING_KEYS = ['version','generation','week','phase','prior','next'];
const HASH_SET_KEYS = ['promptStoreHash','curatedHash','laneHash'];
const SOURCE_STATUS_KEYS = ['claude-code','codex'];
const OP_KEYS = ['detector','start','end','placeholder'];
const TOMBSTONE_KEYS = ['itemRef','category','evidenceRefs','deletedAt'];
const LIFECYCLE_KEYS = ['carryHash','entries','retired'];
const PLACEHOLDERS = new Set(['[redacted:term]','[redacted:email]','[redacted:path]','[redacted:secret]','[redacted:account]']);
const NON_PRIVACY_DECISIONS = new Set([
  'automatic-safe', 'missing-eligibility-signal', 'below-automatic-floor',
  'category-capacity', 'overall-capacity',
]);

function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const got = Object.keys(value).sort(); const want = [...keys].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name} has unknown or missing keys.`);
}

function validIso(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) && new Date(value).toISOString() === value;
}

function validateWeek(week, name = 'digest week') {
  exact(week, ['start','end'], name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week.start) || !/^\d{4}-\d{2}-\d{2}$/.test(week.end) || week.start > week.end) {
    throw new Error(`${name} is invalid.`);
  }
}

function validateSourceStatus(value) {
  exact(value, SOURCE_STATUS_KEYS, 'digest sourceStatus');
  for (const source of SOURCE_STATUS_KEYS) {
    const status = value[source];
    exact(status, ['state','weekStart','weekEnd','syncedAt','records','malformedLines'], `digest sourceStatus.${source}`);
    if (!['present','absent','unreadable'].includes(status.state) || !validIso(status.syncedAt) ||
        !Number.isInteger(status.records) || status.records < 0 || !Number.isInteger(status.malformedLines) || status.malformedLines < 0) {
      throw new Error(`digest sourceStatus.${source} is invalid.`);
    }
  }
}

function validateSourceStatusWeek(value, week) {
  for (const source of SOURCE_STATUS_KEYS) {
    if (value[source].weekStart !== week.start || value[source].weekEnd !== week.end) throw new Error(`digest sourceStatus.${source} week does not match the digest week.`);
  }
}

function validatePolicy(policy) {
  exact(policy, POLICY_KEYS, 'digest policy');
  if (policy.version !== 2 || !Number.isInteger(policy.maxItems) || !Number.isInteger(policy.automaticMinScore) ||
      !Number.isInteger(policy.maxAutomaticChangedPercent) || typeof policy.publicRenditionsEnabled !== 'boolean') {
    throw new Error('digest policy is invalid.');
  }
  exact(policy.categoryCaps, DIGEST_CATEGORIES, 'digest policy categoryCaps');
  exact(policy.weights, DIGEST_SIGNALS, 'digest policy weights');
  if (policy.maxItems < 1 || policy.maxItems > 50 || policy.automaticMinScore < -10 || policy.automaticMinScore > 10 ||
      policy.maxAutomaticChangedPercent < 0 || policy.maxAutomaticChangedPercent > 100) throw new Error('digest policy is out of bounds.');
  for (const value of Object.values(policy.categoryCaps)) if (!Number.isInteger(value) || value < 0 || value > 20) throw new Error('digest category cap is invalid.');
  for (const value of Object.values(policy.weights)) if (!Number.isInteger(value) || value < -10 || value > 10) throw new Error('digest weight is invalid.');
}

export function digestPolicyForConfig(config) {
  return {
    version: 2,
    maxItems: config.curation.maxItems,
    automaticMinScore: config.curation.automaticMinScore,
    categoryCaps: { ...config.curation.categoryCaps },
    weights: { ...config.curation.weights },
    maxAutomaticChangedPercent: config.privacy.publicRenditions.maxAutomaticChangedPercent,
    publicRenditionsEnabled: config.privacy.publicRenditions.enabled,
  };
}

function validatePolicyAgainstConfig(policy, config) {
  const expected = digestPolicyForConfig(config);
  if (JSON.stringify(policy) !== JSON.stringify(expected)) throw new Error('digest policy does not match the active configuration.');
}

function validateOutputBinding(value) {
  exact(value, OUTPUT_BINDING_KEYS, 'digest output binding');
  if (!['page','site'].includes(value.mode) ||
      (value.adapterHash !== null && !HEX.test(value.adapterHash)) || value.objectives !== false) {
    throw new Error('digest output binding is invalid.');
  }
}

function compareReceipts(a, b) {
  return a.source.localeCompare(b.source) || a.sessionKey.localeCompare(b.sessionKey) ||
    a.turn - b.turn || a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref);
}

function validateRedactionOps(candidate) {
  if (candidate.redactionCount !== candidate.redactionOps.length) throw new Error('digest candidate redaction count is invalid.');
  let prior = 0;
  for (const op of candidate.redactionOps) {
    exact(op, OP_KEYS, 'digest redaction operation');
    if (!REPLACEABLE_DETECTORS.includes(op.detector) || !Number.isInteger(op.start) || !Number.isInteger(op.end) ||
        op.start < prior || op.end <= op.start || !PLACEHOLDERS.has(op.placeholder)) throw new Error('digest redaction operation is invalid.');
    prior = op.end;
  }
}

function validateReceipt(value, name) {
  exact(value, RECEIPT_KEYS, name);
  if (!['claude-code','codex'].includes(value.source) || !HEX.test(value.sessionKey) || !HEX.test(value.ref) ||
      !Number.isInteger(value.turn) || value.turn < 1 || !['human-prompt','human-cue','assistant-final'].includes(value.kind)) {
    throw new Error(`${name} is invalid.`);
  }
}

function validatePrivacy(value, name, { publicItem = false } = {}) {
  exact(value, PRIVATE_PRIVACY_KEYS, name);
  if (!Array.isArray(value.sourceRefs) || !Array.isArray(value.sourceContentHashes) ||
      value.sourceRefs.length !== value.sourceContentHashes.length || value.sourceRefs.some((ref) => !HEX.test(ref)) ||
      value.sourceContentHashes.some((hash) => !HEX.test(hash)) || !HEX.test(value.renditionHash) ||
      !['none','redaction'].includes(value.transform) || !Number.isInteger(value.changedPercent) || value.changedPercent < 0 || value.changedPercent > 100 ||
      !['low','medium','high'].includes(value.rawRisk) || !['low','medium','high'].includes(value.residualRisk) ||
      !DIGEST_DECISIONS.includes(value.decision) || value.policyVersion !== 1) throw new Error(`${name} is invalid.`);
  if (JSON.stringify(value.sourceRefs) !== JSON.stringify([...new Set(value.sourceRefs)].sort())) throw new Error(`${name} source refs are not canonical.`);
  if (publicItem && (value.decision !== 'automatic-safe' || value.residualRisk !== 'low')) throw new Error(`${name} is not public-safe.`);
}

function validateWithheld(value) {
  exact(value, WITHHELD_KEYS, 'digest withheld');
  const decisions = DIGEST_DECISIONS.slice(1);
  exact(value.total, decisions, 'digest withheld total');
  exact(value.byCategory, DIGEST_CATEGORIES, 'digest withheld byCategory');
  exact(value.scanExcluded, DIGEST_CATEGORIES, 'digest scanExcluded');
  for (const category of DIGEST_CATEGORIES) {
    exact(value.byCategory[category], decisions, `digest withheld ${category}`);
    exact(value.scanExcluded[category], ['human-cue','assistant-final'], `digest scanExcluded ${category}`);
    for (const count of Object.values(value.byCategory[category])) if (!Number.isInteger(count) || count < 0) throw new Error('digest withheld count is invalid.');
    for (const count of Object.values(value.scanExcluded[category])) if (!Number.isInteger(count) || count < 0) throw new Error('digest scan-excluded count is invalid.');
  }
  for (const decision of decisions) {
    const sum = DIGEST_CATEGORIES.reduce((total, category) => total + value.byCategory[category][decision], 0);
    if (value.total[decision] !== sum) throw new Error('digest withheld totals do not reconcile.');
  }
}

function canonicalProse(value, config, name) {
  if (typeof value !== 'string' || createRedactor(config).redact(value) !== value) throw new Error(`${name} is not canonically redacted.`);
}

export function validateDigestCandidate(candidate, config, policy = digestPolicyForConfig(config)) {
  exact(candidate, CANDIDATE_KEYS, 'digest candidate');
  if (!HEX.test(candidate.itemRef) || !DIGEST_CATEGORIES.includes(candidate.category) || !Array.isArray(candidate.evidenceRefs) ||
      candidate.evidenceRefs.length === 0 || candidate.evidenceRefs.some((ref) => !HEX.test(ref)) ||
      JSON.stringify(candidate.evidenceRefs) !== JSON.stringify([...new Set(candidate.evidenceRefs)].sort()) ||
      !Array.isArray(candidate.receipts) || candidate.receipts.length !== candidate.evidenceRefs.length ||
      !validIso(candidate.timestamp) || typeof candidate.isPrivate !== 'boolean' || !['inbox','kept','hidden'].includes(candidate.state) ||
      !HEX.test(candidate.sourceHash) || !HEX.test(candidate.contentHash) || sha256(candidate.text) !== candidate.contentHash ||
      !Number.isInteger(candidate.sourceLength) || candidate.sourceLength < 1 || !Number.isInteger(candidate.redactionCount) || candidate.redactionCount < 0 ||
      !Number.isInteger(candidate.changedPercent) || candidate.changedPercent < 0 || candidate.changedPercent > 100 ||
      !['low','medium','high'].includes(candidate.rawRisk) || !Array.isArray(candidate.rawDetectors) || !Array.isArray(candidate.redactionOps) ||
      !['none','redaction'].includes(candidate.transform) || typeof candidate.truncated !== 'boolean' ||
      !Array.isArray(candidate.signals) || candidate.signals.some((signal) => !DIGEST_SIGNALS.includes(signal)) ||
      !Number.isInteger(candidate.score) || typeof candidate.selectionReasonCode !== 'string' || !candidate.selectionReasonCode ||
      typeof candidate.selectionReason !== 'string' || !candidate.selectionReason || !DIGEST_DECISIONS.includes(candidate.decision)) {
    throw new Error('digest candidate is invalid.');
  }
  const expectedRef = digestItemIdentity(candidate.category, candidate.evidenceRefs, candidate.discriminator);
  if (expectedRef !== candidate.itemRef) throw new Error('digest candidate itemRef mismatch.');
  const expectedDiscriminator = candidate.category === 'prompts'
    ? /^prompt$/
    : candidate.category === 'ideas'
      ? /^(?:idea|unresolved-idea):[1-9]\d*$/
      : new RegExp(`^${candidate.category === 'nextSteps' ? 'next-step' : candidate.category.slice(0, -1)}:[1-9]\\d*$`);
  if (typeof candidate.discriminator !== 'string' || !expectedDiscriminator.test(candidate.discriminator)) throw new Error('digest candidate discriminator is invalid.');
  candidate.receipts.forEach((value, index) => validateReceipt(value, `digest candidate receipt[${index}]`));
  if (JSON.stringify(candidate.receipts) !== JSON.stringify(candidate.receipts.slice().sort(compareReceipts))) throw new Error('digest candidate receipts are not canonical.');
  if (JSON.stringify(candidate.receipts.map((value) => value.ref).sort()) !== JSON.stringify(candidate.evidenceRefs)) throw new Error('digest candidate receipts do not match evidence refs.');
  const cueReceipts = candidate.receipts.filter((value) => value.kind !== 'human-prompt');
  if (candidate.category === 'prompts'
    ? candidate.receipts.length !== 1 || candidate.receipts[0].kind !== 'human-prompt'
    : candidate.category === 'techniques'
      ? candidate.receipts.length !== 2 || cueReceipts.length !== 1 || !candidate.receipts.some((value) => value.kind === 'human-prompt')
      : candidate.receipts.length !== 1 || cueReceipts.length !== 1) throw new Error('digest candidate receipt shape is invalid.');
  if (JSON.stringify(candidate.rawDetectors) !== JSON.stringify([...new Set(candidate.rawDetectors)].sort((a, b) => DETECTOR_ORDER.indexOf(a) - DETECTOR_ORDER.indexOf(b))) ||
      candidate.rawDetectors.some((value) => !DETECTOR_ORDER.includes(value))) throw new Error('digest candidate detector ordering is invalid.');
  validateRedactionOps(candidate);
  if (candidate.transform !== (candidate.redactionCount ? 'redaction' : 'none')) throw new Error('digest candidate transform is inconsistent.');
  if (JSON.stringify(candidate.signals) !== JSON.stringify([...new Set(candidate.signals)].sort((a, b) => DIGEST_SIGNALS.indexOf(a) - DIGEST_SIGNALS.indexOf(b)))) throw new Error('digest candidate signals are not canonical.');
  const expectedScore = candidate.signals.reduce((sum, signal) => sum + policy.weights[signal], 0);
  if (candidate.score !== expectedScore) throw new Error('digest candidate score does not match policy weights.');
  const allowedReasonCodes = new Set([
    ...DIGEST_SIGNALS, ...DIGEST_DECISIONS, 'explicit-keep', 'automatic-carry', 'manual-renewal',
  ]);
  if (!allowedReasonCodes.has(candidate.selectionReasonCode)) throw new Error('digest candidate selection reason code is invalid.');
  if (candidate.isPrivate ? candidate.project !== null : typeof candidate.project !== 'string' || !candidate.project) throw new Error('digest candidate project classification is invalid.');
  validatePrivacy(candidate.privacy, 'digest candidate privacy');
  if (JSON.stringify(candidate.privacy.sourceRefs) !== JSON.stringify(candidate.evidenceRefs)) throw new Error('digest candidate privacy refs are not aligned.');
  const primaryRef = candidate.category === 'prompts' ? candidate.receipts[0].ref : cueReceipts[0].ref;
  if (candidate.privacy.sourceContentHashes[candidate.evidenceRefs.indexOf(primaryRef)] !== candidate.contentHash) throw new Error('digest candidate primary content hash is not aligned.');
  if (candidate.privacy.renditionHash !== sha256(candidate.text) || candidate.privacy.transform !== candidate.transform ||
      candidate.privacy.changedPercent !== candidate.changedPercent || candidate.privacy.rawRisk !== candidate.rawRisk) throw new Error('digest candidate privacy audit is inconsistent.');
  const expectedPrivacyDecision = NON_PRIVACY_DECISIONS.has(candidate.decision) ? 'automatic-safe' : candidate.decision;
  if (candidate.privacy.decision !== expectedPrivacyDecision) throw new Error('digest candidate privacy decision is inconsistent.');
  canonicalProse(candidate.text, config, 'digest candidate text');
  if (candidate.project !== null) canonicalProse(candidate.project, config, 'digest candidate project');
}

export function validateDigestReview(review, config) {
  const keys = review?.version === 3 ? REVIEW_V3_KEYS : review?.version === 2 ? REVIEW_V2_KEYS : REVIEW_V1_KEYS;
  exact(review, keys, 'digest review');
  if (![1,2,3].includes(review.version) || !validIso(review.generatedAt) || !Array.isArray(review.candidates) ||
      (review.version >= 2 && !Array.isArray(review.tombstones)) ||
      (review.version === 3 && (!Array.isArray(review.renewals) || !review.lifecycle))) {
    throw new Error('digest review schema is invalid.');
  }
  validateWeek(review.week); validateSourceStatus(review.sourceStatus); validateSourceStatusWeek(review.sourceStatus, review.week);
  validatePolicy(review.policy); validatePolicyAgainstConfig(review.policy, config); validateWithheld(review.withheld);
  const seen = new Set();
  for (const candidate of review.candidates) {
    validateDigestCandidate(candidate, config, review.policy);
    if (seen.has(candidate.itemRef)) throw new Error('digest review has duplicate itemRef.');
    seen.add(candidate.itemRef);
  }
  for (const tombstone of review.tombstones ?? []) {
    exact(tombstone, TOMBSTONE_KEYS, 'digest tombstone');
    if (!HEX.test(tombstone.itemRef) || !DIGEST_CATEGORIES.includes(tombstone.category) ||
        !Array.isArray(tombstone.evidenceRefs) || tombstone.evidenceRefs.length === 0 ||
        tombstone.evidenceRefs.some((ref) => !HEX.test(ref)) ||
        JSON.stringify(tombstone.evidenceRefs) !== JSON.stringify([...new Set(tombstone.evidenceRefs)].sort()) ||
        !validIso(tombstone.deletedAt)) throw new Error('digest tombstone is invalid.');
    if (seen.has(tombstone.itemRef)) throw new Error('digest review ref appears live and deleted.');
    seen.add(tombstone.itemRef);
  }
  if (review.version === 2 && JSON.stringify(review.tombstones) !==
      JSON.stringify(review.tombstones.slice().sort((a, b) => a.itemRef.localeCompare(b.itemRef)))) {
    throw new Error('digest tombstones are not canonical.');
  }
  if (review.version === 3) {
    if (JSON.stringify(review.tombstones) !==
        JSON.stringify(review.tombstones.slice().sort((a, b) => a.itemRef.localeCompare(b.itemRef)))) {
      throw new Error('digest tombstones are not canonical.');
    }
    const renewalRefs = new Set();
    for (const renewal of review.renewals) {
      validateRenewal(renewal);
      if (renewalRefs.has(renewal.itemRef)) throw new Error('digest review has duplicate renewal itemRef.');
      renewalRefs.add(renewal.itemRef);
    }
    if (JSON.stringify(review.renewals) !== JSON.stringify(review.renewals.slice().sort((a, b) => a.itemRef.localeCompare(b.itemRef)))) {
      throw new Error('digest renewals are not canonical.');
    }
    exact(review.lifecycle, LIFECYCLE_KEYS, 'digest lifecycle');
    if ((review.lifecycle.carryHash !== null && !HEX.test(review.lifecycle.carryHash)) ||
        !Array.isArray(review.lifecycle.entries) || !Array.isArray(review.lifecycle.retired)) {
      throw new Error('digest lifecycle is invalid.');
    }
    const lifecycleRefs = new Set();
    for (const entry of review.lifecycle.entries) {
      validateLifecycleEntry(entry);
      if (lifecycleRefs.has(entry.itemRef)) throw new Error('digest lifecycle has duplicate itemRef.');
      lifecycleRefs.add(entry.itemRef);
      if (!review.candidates.some((candidate) => candidate.itemRef === entry.itemRef)) {
        throw new Error('digest lifecycle entry has no review candidate.');
      }
    }
    for (const retired of review.lifecycle.retired) validateRetired(retired, config);
    const entryOrder = review.lifecycle.entries.slice().sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    const retiredOrder = review.lifecycle.retired.slice().sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    if (JSON.stringify(review.lifecycle.entries) !== JSON.stringify(entryOrder) ||
        JSON.stringify(review.lifecycle.retired) !== JSON.stringify(retiredOrder)) {
      throw new Error('digest lifecycle rows are not canonical.');
    }
  }
  const selected = review.candidates.filter((candidate) => candidate.decision === 'automatic-safe').length;
  const withheld = Object.values(review.withheld.total).reduce((sum, count) => sum + count, 0);
  if (review.candidates.length !== selected + withheld) throw new Error('digest review accounting does not reconcile.');
  return review;
}

function validateItem(item, config, policy) {
  exact(item, ITEM_KEYS, 'digest lane item');
  if (!HEX.test(item.itemRef) || item.id !== `digest-${item.itemRef}` || !DIGEST_CATEGORIES.includes(item.category) ||
      item.kind !== DIGEST_CATEGORY_KIND[item.category] || item.project !== DIGEST_CATEGORY_GROUP[item.category] || item.repo !== null || item.status !== '' ||
      !['kept','automatic','carried','renewed'].includes(item.curationState) || item.publicDisposition !== 'automatic-safe' ||
      !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0 || item.evidenceRefs.some((ref) => !HEX.test(ref)) ||
      JSON.stringify(item.evidenceRefs) !== JSON.stringify([...new Set(item.evidenceRefs)].sort()) ||
      !Array.isArray(item.receipts) || item.receipts.length !== item.evidenceRefs.length ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || typeof item.title !== 'string' || !item.title || typeof item.summary !== 'string' || !item.summary) {
    throw new Error('digest lane item is invalid.');
  }
  validateWeek(item.week, 'digest item week');
  item.receipts.forEach((value, index) => validateReceipt(value, `digest item receipt[${index}]`));
  if (JSON.stringify(item.receipts) !== JSON.stringify(item.receipts.slice().sort(compareReceipts))) throw new Error('digest item receipts are not canonical.');
  if (JSON.stringify(item.receipts.map((value) => value.ref).sort()) !== JSON.stringify(item.evidenceRefs)) throw new Error('digest item receipts do not match evidence refs.');
  exact(item.receipt, COMPAT_RECEIPT_KEYS, 'digest compatibility receipt');
  if (item.receipt.sessionId !== item.receipts[0].sessionKey || item.receipt.ref !== item.receipts[0].ref || item.receipt.turn !== item.receipts[0].turn) throw new Error('digest compatibility receipt mismatch.');
  if (!Array.isArray(item.snippets) || item.snippets.length !== item.receipts.length + 1) throw new Error('digest item snippets are incomplete.');
  item.snippets.forEach((value, index) => exact(value, SNIPPET_KEYS, `digest snippet[${index}]`));
  const rendition = item.snippets[0];
  if (rendition.kind !== item.kind || rendition.source !== 'public-safe rendition' || rendition.provenance !== 'validated-rendition' || !rendition.text) throw new Error('digest rendition snippet is invalid.');
  for (const source of item.snippets.slice(1)) {
    if (source.kind !== 'source' || !['Claude Code','Codex'].includes(source.source) || source.provenance !== 'transcript-receipt' || !source.text) throw new Error('digest source snippet is invalid.');
  }
  canonicalProse(item.snippets[0].text, config, 'digest rendition snippet text');
  exact(item.selection, SELECTION_KEYS, 'digest selection');
  const validReasonCodes = new Set([...DIGEST_SIGNALS, 'explicit-keep', 'automatic-carry', 'manual-renewal']);
  if (!Number.isInteger(item.selection.score) || !Array.isArray(item.selection.reasonCodes) || item.selection.reasonCodes.length === 0 ||
      item.selection.reasonCodes.some((value) => !validReasonCodes.has(value)) ||
      JSON.stringify(item.selection.reasonCodes) !== JSON.stringify([...new Set(item.selection.reasonCodes)]) ||
      !item.selection.reasonCodes.includes(item.selection.primaryReasonCode) || !item.selection.reason) throw new Error('digest selection is invalid.');
  const signalCodes = item.selection.reasonCodes.filter((value) =>
    !['explicit-keep','automatic-carry','manual-renewal'].includes(value));
  if (JSON.stringify(signalCodes) !== JSON.stringify(signalCodes.slice().sort((a, b) => DIGEST_SIGNALS.indexOf(a) - DIGEST_SIGNALS.indexOf(b))) ||
      item.selection.score !== signalCodes.reduce((sum, signal) => sum + policy.weights[signal], 0)) throw new Error('digest selection does not match policy weights.');
  const expectedLifecycleCode = item.curationState === 'carried' ? 'automatic-carry'
    : item.curationState === 'renewed' ? 'manual-renewal' : item.curationState === 'kept' ? 'explicit-keep' : null;
  if (expectedLifecycleCode ? item.selection.reasonCodes[0] !== expectedLifecycleCode || item.selection.primaryReasonCode !== expectedLifecycleCode
    : item.selection.reasonCodes.some((value) => ['explicit-keep','automatic-carry','manual-renewal'].includes(value))) {
    throw new Error('digest selection lifecycle state is inconsistent.');
  }
  if (!item.summary.includes(item.selection.reason) || !item.summary.includes(`Automatic floor ${policy.automaticMinScore}`) ||
      !item.summary.includes(`overall target ${policy.maxItems}`)) throw new Error('digest selection disclosure is incomplete.');
  validatePrivacy(item.privacy, 'digest item privacy', { publicItem: true });
  if (JSON.stringify(item.privacy.sourceRefs) !== JSON.stringify(item.evidenceRefs)) throw new Error('digest item privacy refs are not aligned.');
  if (item.privacy.renditionHash !== sha256(rendition.text) ||
      (item.privacy.transform === 'redaction' && !/\[redacted:(?:email|secret|path|term|account)\]/.test(rendition.text))) throw new Error('digest item rendition audit is inconsistent.');
  canonicalProse(item.title, config, 'digest item title'); canonicalProse(item.summary, config, 'digest item summary');
}

export function validateDigestLane(lane, config) {
  exact(lane, LANE_KEYS, 'digest lane');
  if (lane.version !== 2 || !validIso(lane.generatedAt) || !Array.isArray(lane.items)) throw new Error('digest lane schema is invalid.');
  validateWeek(lane.week); validateSourceStatus(lane.sourceStatus); validateSourceStatusWeek(lane.sourceStatus, lane.week);
  validatePolicy(lane.policy); validatePolicyAgainstConfig(lane.policy, config); validateWithheld(lane.withheld);
  validateOutputBinding(lane.outputBinding);
  const seen = new Set();
  for (const item of lane.items) {
    validateItem(item, config, lane.policy);
    if (item.week.start !== lane.week.start || item.week.end !== lane.week.end) throw new Error('digest item week does not match the lane week.');
    if (seen.has(item.itemRef)) throw new Error('digest lane has duplicate itemRef.');
    seen.add(item.itemRef);
  }
  const explicit = lane.items.filter((item) => ['kept','renewed'].includes(item.curationState)).length;
  const automatic = lane.items.filter((item) => ['automatic','carried'].includes(item.curationState));
  if (automatic.length > Math.max(0, lane.policy.maxItems - explicit)) throw new Error('digest lane exceeds the overall automatic target.');
  for (const category of DIGEST_CATEGORIES) {
    if (automatic.filter((item) => item.category === category).length > lane.policy.categoryCaps[category]) throw new Error(`digest lane exceeds the ${category} category cap.`);
  }
  return lane;
}

export function readDigestReview(cwd, config) {
  const path = join(cwd, DIGEST_STORE);
  if (!existsSync(path)) throw new Error(`${DIGEST_STORE} not found; run honestweek digest prepare.`);
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`${DIGEST_STORE} is not valid JSON (${error.message}).`); }
  return validateDigestReview(value, config);
}

export function writeDigestReview(cwd, review, config, fs) {
  validateDigestReview(review, config);
  const text = `${JSON.stringify(review, null, 2)}\n`;
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error(`${DIGEST_STORE} exceeds the 8 MiB cap.`);
  atomicWriteJson(join(cwd, DIGEST_STORE), review, fs);
}

export function writeDigestLane(cwd, lane, config, fs) {
  validateDigestLane(lane, config);
  const text = `${JSON.stringify(lane, null, 2)}\n`;
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('digest lane exceeds the 1 MiB cap.');
  atomicWriteJson(join(cwd, 'honestweek.prompt-items.json'), lane, fs);
}

export function hashFile(path) { return existsSync(path) ? sha256(readFileSync(path)) : null; }

export function currentDigestHashes(cwd) {
  return {
    promptStoreHash: hashFile(join(cwd, 'honestweek.prompts.json')),
    curatedHash: hashFile(join(cwd, DIGEST_STORE)),
    laneHash: hashFile(join(cwd, 'honestweek.prompt-items.json')),
  };
}

function validateHashSet(value, name) {
  exact(value, HASH_SET_KEYS, name);
  for (const hash of Object.values(value)) if (hash !== null && !HEX.test(hash)) throw new Error(`${name} has an invalid hash.`);
}

export function validateDigestPending(value) {
  exact(value, PENDING_KEYS, 'digest pending');
  if (value.version !== 1 || !HEX.test(value.generation) || value.phase !== 'prepared') throw new Error('digest pending is invalid.');
  validateWeek(value.week, 'digest pending week'); validateHashSet(value.prior, 'digest pending prior'); validateHashSet(value.next, 'digest pending next');
  return value;
}

export function readDigestPending(cwd, { optional = false } = {}) {
  const path = join(cwd, DIGEST_PENDING);
  if (!existsSync(path)) { if (optional) return null; throw new Error(`${DIGEST_PENDING} not found.`); }
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`${DIGEST_PENDING} is not valid JSON (${error.message}).`); }
  return validateDigestPending(value);
}

export function assertNoDigestPending(cwd) {
  if (existsSync(join(cwd, DIGEST_PENDING))) throw new Error(`${DIGEST_PENDING} is present; run honestweek digest prepare to recover before any other command.`);
}

export function assertRecoverableDigestPending(cwd, pending) {
  const current = currentDigestHashes(cwd);
  const p = pending.prior; const n = pending.next;
  const allowed = [
    p,
    { promptStoreHash: n.promptStoreHash, curatedHash: p.curatedHash, laneHash: p.laneHash },
    { promptStoreHash: n.promptStoreHash, curatedHash: n.curatedHash, laneHash: p.laneHash },
    n,
  ];
  if (!allowed.some((value) => JSON.stringify(value) === JSON.stringify(current))) throw new Error(`${DIGEST_PENDING} does not match a recoverable ordered write prefix; no state was changed.`);
  return current;
}

function digestGeneration(week, outputBinding, next) {
  return sha256(`${week.start}\0${week.end}\0${JSON.stringify(outputBinding)}\0${next.promptStoreHash}\0${next.curatedHash}\0${next.laneHash}`);
}

export function assertDigestPendingGeneration(pending, outputBinding) {
  validateOutputBinding(outputBinding);
  if (pending.generation !== digestGeneration(pending.week, outputBinding, pending.next)) {
    throw new Error(`${DIGEST_PENDING} generation does not match the active output binding; no state was changed.`);
  }
}

export function makeDigestPending({ week, outputBinding, prior, next }) {
  validateOutputBinding(outputBinding);
  const generation = digestGeneration(week, outputBinding, next);
  return validateDigestPending({ version: 1, generation, week, phase: 'prepared', prior, next });
}

export function writeDigestPending(cwd, pending, fs) {
  atomicWriteJson(join(cwd, DIGEST_PENDING), validateDigestPending(pending), fs);
}

export function removeDigestPending(cwd, fs = { unlinkSync }) {
  fs.unlinkSync(join(cwd, DIGEST_PENDING));
}
