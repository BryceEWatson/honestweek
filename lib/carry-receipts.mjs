import { scanDigestEvidence } from './digest-evidence.mjs';
import { carryRecordBefore } from './digest-carry.mjs';
import { assessCandidatePublicSafety } from './digest-lifecycle.mjs';
import { candidateSourceBoundProjection, sourceBoundProjection } from './digest-source-bound.mjs';
import { curateDigest } from './digest-curation.mjs';
import { scanPromptSources } from './prompt-adapters.mjs';
import { mergePromptStore } from './prompt-store.mjs';
import { localDateInTimezone, localDateRangeInstants } from './resolve-week.mjs';

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sourceWeekFor(candidate, config) {
  const date = new Date(candidate.timestamp);
  if (Number.isNaN(date.getTime())) throw new Error('carried receipt timestamp is invalid; no digest state was changed.');
  const local = localDateInTimezone(date, config.week.timezone);
  const weekday = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() - weekday + 1);
  const end = new Date(local);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start:local.toISOString().slice(0, 10), end:end.toISOString().slice(0, 10) };
}

function receiptShape(source, kind) {
  return {
    source: source.source, sessionKey: source.sessionKey, turn: source.turn,
    kind, ref: kind === 'human-prompt' ? source.ref : source.evidenceRef,
  };
}

function verifyCandidate(candidate, prompts, evidence, sourceCandidates, config) {
  const resolved = new Map();
  for (const receipt of candidate.receipts) {
    const source = receipt.kind === 'human-prompt' ? prompts.get(receipt.ref) : evidence.get(receipt.ref);
    if (!source || !same(receipt, receiptShape(source, receipt.kind))) {
      throw new Error('carried receipt does not resolve exactly; no digest state was changed.');
    }
    resolved.set(receipt.ref, source);
  }
  const primaryReceipt = candidate.category === 'prompts'
    ? candidate.receipts[0]
    : candidate.receipts.find((receipt) => receipt.kind !== 'human-prompt');
  const primary = resolved.get(primaryReceipt?.ref);
  if (!primary || candidate.discriminator !== (candidate.category === 'prompts' ? 'prompt' : primary.discriminator) ||
      candidate.sourceHash !== primary.sourceHash || candidate.timestamp !== primary.timestamp ||
      candidate.isPrivate !== primary.isPrivate) {
    throw new Error('carried rendition does not match its local receipt; no digest state was changed.');
  }
  const contentHashes = candidate.evidenceRefs.map((ref) => resolved.get(ref)?.contentHash);
  const renditionMatches = same(candidateSourceBoundProjection(candidate), sourceBoundProjection(primary));
  const auditMatches = same(contentHashes, candidate.privacy.sourceContentHashes) &&
    same(candidate.evidenceRefs, candidate.privacy.sourceRefs);
  if ((!renditionMatches || !auditMatches) &&
      assessCandidatePublicSafety(candidate, config).decision === 'automatic-safe') {
    throw new Error('carried privacy audit does not match its local receipts; no digest state was changed.');
  }
  const reconstructed = sourceCandidates.get(candidate.itemRef);
  if (!reconstructed || !same(candidate.signals, reconstructed.signals)) {
    throw new Error('carried eligibility signals do not match local receipt evidence; no digest state was changed.');
  }
}

export async function verifyCarryReceipts({ carry, week, config, roots, now = new Date() }) {
  const record = carryRecordBefore(carry, week);
  if (!record?.entries.length) return { verified: 0, weeks: 0 };
  const groups = new Map();
  for (const entry of record.entries) {
    const sourceWeek = sourceWeekFor(entry.candidate, config);
    const key = `${sourceWeek.start}\0${sourceWeek.end}`;
    const group = groups.get(key) ?? { week: sourceWeek, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  let verified = 0;
  for (const group of groups.values()) {
    const range = localDateRangeInstants(group.week.start, group.week.end, config.week.timezone);
    const scanned = await scanPromptSources({
      config, weekStart: range.start, weekEnd: range.endExclusive, roots, now,
    });
    const promptStore = mergePromptStore(null, scanned, now);
    const digest = await scanDigestEvidence({
      config, promptStore, roots, sourceStatus: scanned.sourceStatus,
    });
    const reconstructed = curateDigest(promptStore, digest, config, group.week, now, {
      outputBinding:{ mode:'page', adapterHash:null, objectives:false },
    }).review.candidates;
    const prompts = new Map(promptStore.prompts.map((prompt) => [prompt.ref, prompt]));
    const evidence = new Map(digest.evidence.map((value) => [value.evidenceRef, value]));
    const sourceCandidates = new Map(reconstructed.map((candidate) => [candidate.itemRef, candidate]));
    for (const entry of group.entries) {
      verifyCandidate(entry.candidate, prompts, evidence, sourceCandidates, config);
      verified += 1;
    }
  }
  return { verified, weeks: groups.size };
}
