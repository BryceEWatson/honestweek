import { localDateInTimezone } from './resolve-week.mjs';
import { assessPublicRendition } from './redact.mjs';
import { evaluatePrompts } from './prompt-curation.mjs';
import { digestItemIdentity, sha256 } from './prompt-identity.mjs';
import { DETECTOR_ORDER } from './prompt-privacy.mjs';
import { hasRecurringText } from './curation-similarity.mjs';
import {
  DIGEST_CATEGORIES, DIGEST_CATEGORY_GROUP, DIGEST_CATEGORY_KIND,
  DIGEST_DECISIONS, DIGEST_SIGNALS,
} from './digest-schema.mjs';

export { DIGEST_CATEGORIES, DIGEST_DECISIONS, DIGEST_SIGNALS } from './digest-schema.mjs';

const CATEGORY_INDEX = new Map(DIGEST_CATEGORIES.map((value, index) => [value, index]));
const SIGNAL_INDEX = new Map(DIGEST_SIGNALS.map((value, index) => [value, index]));
const SOURCE_LABELS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });
const DECISION_REASONS = Object.freeze({
  hidden: 'hidden by prompt control',
  'private-source': 'source remains private',
  'high-risk': 'residual privacy risk is high',
  'needs-approval': 'privacy result is ambiguous',
  'public-renditions-disabled': 'public renditions are disabled',
  'missing-eligibility-signal': 'no automatic eligibility signal',
  'below-automatic-floor': 'below the automatic score floor',
  'category-capacity': 'omitted by the category cap',
  'overall-capacity': 'omitted by the overall target',
});
function recurring(a, b) {
  if (a.category !== b.category || a.receipts[0].sessionKey === b.receipts[0].sessionKey) return false;
  return hasRecurringText(a.text, b.text);
}

function orderedSignals(values) {
  return [...new Set(values)].sort((a, b) => SIGNAL_INDEX.get(a) - SIGNAL_INDEX.get(b));
}

function receipt(source, sessionKey, turn, kind, ref) {
  return { source, sessionKey, turn, kind, ref };
}

function sortReceipts(values) {
  return values.slice().sort((a, b) => a.source.localeCompare(b.source) ||
    a.sessionKey.localeCompare(b.sessionKey) || a.turn - b.turn ||
    a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
}

function privacySources(entries) {
  const ordered = entries.slice().sort((a, b) => a.ref.localeCompare(b.ref));
  return {
    sourceRefs: ordered.map((entry) => entry.ref),
    sourceContentHashes: ordered.map((entry) => entry.contentHash),
  };
}

function promptCandidates(store, config, week) {
  const evaluated = evaluatePrompts(store, config, week).evaluated;
  return evaluated.map(({ p, codes }) => {
    const evidenceRefs = [p.ref];
    const itemRef = digestItemIdentity('prompts', evidenceRefs, 'prompt');
    const sources = privacySources([{ ref: p.ref, contentHash: p.contentHash }]);
    return {
      itemRef, category: 'prompts', discriminator: 'prompt', evidenceRefs,
      receipts: [receipt(p.source, p.sessionKey, p.turn, 'human-prompt', p.ref)],
      timestamp: p.timestamp, project: p.project, isPrivate: p.isPrivate, state: p.state,
      text: p.text, sourceHash: p.sourceHash, contentHash: p.contentHash,
      sourceLength: p.sourceLength, redactionCount: p.redactionCount,
      changedPercent: p.changedPercent, rawRisk: p.rawRisk,
      rawDetectors: p.rawDetectors, redactionOps: p.redactionOps,
      transform: p.redactionCount ? 'redaction' : 'none', truncated: p.truncated,
      signals: orderedSignals(codes), score: 0, selectionReasonCode: '',
      selectionReason: '', decision: '', privacy: {
        ...sources, renditionHash: sha256(p.text), transform: p.redactionCount ? 'redaction' : 'none',
        changedPercent: p.changedPercent, rawRisk: p.rawRisk,
        residualRisk: assessPublicRendition(p.text, config, { isPrivate: p.isPrivate }),
        decision: '', policyVersion: 1,
      },
    };
  });
}

function cueCandidates(evidence, promptStore) {
  const promptByRef = new Map(promptStore.prompts.map((prompt) => [prompt.ref, prompt]));
  return evidence.map((entry) => {
    const prompt = promptByRef.get(entry.promptRef);
    if (!prompt) throw new Error('digest cue has no associated prompt receipt.');
    const technique = entry.category === 'techniques';
    const sources = [{ ref: entry.evidenceRef, contentHash: entry.contentHash }];
    const receipts = [receipt(entry.source, entry.sessionKey, entry.turn, entry.kind, entry.evidenceRef)];
    if (technique) {
      sources.push({ ref: prompt.ref, contentHash: prompt.contentHash });
      receipts.push(receipt(prompt.source, prompt.sessionKey, prompt.turn, 'human-prompt', prompt.ref));
    }
    const evidenceRefs = sources.map((source) => source.ref).sort();
    const sourcePrivacy = privacySources(sources);
    // The prompt receipt proves the technique's verification window. Privacy
    // metadata remains scoped to the exact cue rendition that may be emitted.
    const rawDetectors = [...entry.rawDetectors]
      .sort((a, b) => DETECTOR_ORDER.indexOf(a) - DETECTOR_ORDER.indexOf(b));
    const rawRisk = entry.rawRisk;
    const changedPercent = entry.changedPercent;
    return {
      itemRef: digestItemIdentity(entry.category, evidenceRefs, entry.discriminator),
      category: entry.category, discriminator: entry.discriminator, evidenceRefs,
      receipts: sortReceipts(receipts), timestamp: entry.timestamp,
      project: entry.project, isPrivate: entry.isPrivate, state: 'inbox', text: entry.text,
      sourceHash: entry.sourceHash, contentHash: entry.contentHash,
      sourceLength: entry.sourceLength, redactionCount: entry.redactionCount,
      changedPercent, rawRisk, rawDetectors, redactionOps: entry.redactionOps,
      transform: entry.redactionCount ? 'redaction' : 'none', truncated: entry.truncated,
      signals: [], score: 0, selectionReasonCode: '', selectionReason: '', decision: '',
      privacy: {
        ...sourcePrivacy, renditionHash: sha256(entry.text),
        transform: entry.redactionCount ? 'redaction' : 'none', changedPercent,
        rawRisk, residualRisk: entry.residualRisk, decision: '', policyVersion: 1,
      },
      _observedVerification: entry.observedVerification,
    };
  });
}

function baseSignals(candidate) {
  if (candidate.category === 'prompts') return candidate.signals;
  const signals = [];
  if (candidate.category === 'decisions' || candidate.category === 'reversals') signals.push('decision-or-reversal');
  if (candidate._observedVerification) signals.push('observed-verification');
  if (candidate.category === 'nextSteps') signals.push('unresolved-next-step');
  return signals;
}

function primaryReason(candidate) {
  if (candidate.state === 'kept') return ['explicit-keep', 'you kept this prompt'];
  const has = (signal) => candidate.signals.includes(signal);
  if (candidate.category === 'decisions') return ['decision-or-reversal', 'records an explicit decision'];
  if (candidate.category === 'reversals') return ['decision-or-reversal', 'records an explicit reversal'];
  if (candidate.category === 'prompts') {
    if (has('recurs')) return ['recurs', 'matched lexical overlap across sessions'];
    if (has('observed-verification')) return ['observed-verification', 'connected to observed verification'];
  }
  if (candidate.category === 'ideas') {
    if (has('observed-verification')) return ['observed-verification', 'connected to observed verification'];
    if (has('recurs')) return ['recurs', 'matched lexical overlap across sessions'];
  }
  if (candidate.category === 'techniques') return ['observed-verification', 'connected to observed verification'];
  if (candidate.category === 'nextSteps') {
    if (has('recurs')) return ['recurs', 'matched lexical overlap across sessions'];
    return ['unresolved-next-step', 'names unfinished work'];
  }
  return ['', ''];
}

function hasEligibility(candidate) {
  const has = (signal) => candidate.signals.includes(signal);
  if (candidate.category === 'prompts' || candidate.category === 'ideas') return has('recurs') || has('observed-verification');
  if (candidate.category === 'techniques') return has('observed-verification');
  if (candidate.category === 'decisions' || candidate.category === 'reversals') return has('decision-or-reversal');
  return candidate.category === 'nextSteps' && has('unresolved-next-step');
}

function privacyDecision(candidate, config) {
  if (candidate.state === 'hidden') return 'hidden';
  if (candidate.isPrivate) return 'private-source';
  const residual = assessPublicRendition(candidate.text, config);
  candidate.privacy.residualRisk = residual;
  if (residual === 'high') return 'high-risk';
  if (candidate.truncated || candidate.changedPercent > config.privacy.publicRenditions.maxAutomaticChangedPercent ||
      candidate.rawDetectors.includes('capitalized-unknown') || residual === 'medium') return 'needs-approval';
  if (!config.privacy.publicRenditions.enabled) return 'public-renditions-disabled';
  return 'automatic-safe';
}

function excerpt(text) {
  const chars = [...text];
  if (chars.length <= 160) return text;
  const first = chars.slice(0, 159).join('');
  const cut = first.search(/\s+\S*$/u);
  return `${(cut > 0 ? first.slice(0, cut) : first).trimEnd()}…`;
}

function prefixMap(values) {
  const unique = [...new Set(values)];
  return new Map(unique.map((value) => {
    let size = 12;
    while (size < 64 && unique.some((other) => other !== value && other.slice(0, size) === value.slice(0, size))) size += 1;
    return [value, value.slice(0, size)];
  }));
}

function emptyCounts() {
  return Object.fromEntries(DIGEST_DECISIONS.slice(1).map((decision) => [decision, 0]));
}

function buildWithheld(candidates, scanExcluded) {
  const byCategory = Object.fromEntries(DIGEST_CATEGORIES.map((category) => [category, emptyCounts()]));
  const total = emptyCounts();
  for (const candidate of candidates) {
    if (candidate.decision === 'automatic-safe') continue;
    total[candidate.decision] += 1;
    byCategory[candidate.category][candidate.decision] += 1;
  }
  return { total, byCategory, scanExcluded };
}

function summaryFor(candidate, config, withheld) {
  const cap = config.curation.categoryCaps[candidate.category];
  const omitted = withheld.byCategory[candidate.category]['category-capacity'] +
    withheld.byCategory[candidate.category]['overall-capacity'];
  return `Why it surfaced: ${candidate.selectionReason}. Automatic floor ${config.curation.automaticMinScore}; overall target ${config.curation.maxItems}; ${DIGEST_CATEGORY_GROUP[candidate.category]} cap ${cap}; ${omitted} eligible omitted in this category. These rules favor observable recurrence and verification, not universal importance.${candidate.transform === 'redaction' ? ' Privacy edited.' : ''}`;
}

function toPublicItems(selected, config, week, withheld) {
  const sessionPrefixes = prefixMap(selected.flatMap((candidate) => candidate.receipts.map((value) => value.sessionKey)));
  const refPrefixes = prefixMap(selected.flatMap((candidate) => candidate.receipts.map((value) => value.ref)));
  return selected.map((candidate) => {
    const receipts = candidate.receipts;
    const first = receipts[0];
    const reasonCodes = candidate.state === 'kept'
      ? ['explicit-keep', ...candidate.signals]
      : candidate.signals;
    return {
      id: `digest-${candidate.itemRef}`, itemRef: candidate.itemRef,
      evidenceRefs: candidate.evidenceRefs, receipts, kind: DIGEST_CATEGORY_KIND[candidate.category],
      category: candidate.category, week,
      curationState: candidate.state === 'kept' ? 'kept' : 'automatic',
      publicDisposition: 'automatic-safe', status: '', project: DIGEST_CATEGORY_GROUP[candidate.category],
      repo: null,
      date: localDateInTimezone(new Date(candidate.timestamp), config.week.timezone).toISOString().slice(0, 10),
      title: excerpt(candidate.text), summary: summaryFor(candidate, config, withheld),
      receipt: { sessionId: first.sessionKey, ref: first.ref, turn: first.turn },
      snippets: [
        { kind: DIGEST_CATEGORY_KIND[candidate.category], source: 'public-safe rendition', text: candidate.text, provenance: 'validated-rendition' },
        ...receipts.map((value) => ({
          kind: 'source', source: SOURCE_LABELS[value.source],
          text: `session ${sessionPrefixes.get(value.sessionKey)} turn ${value.turn} ref ${refPrefixes.get(value.ref)} (${value.kind})`,
          provenance: 'transcript-receipt',
        })),
      ],
      selection: {
        score: candidate.score, reasonCodes,
        primaryReasonCode: candidate.selectionReasonCode, reason: candidate.selectionReason,
      },
      privacy: { ...candidate.privacy, decision: 'automatic-safe' },
    };
  });
}

export function curateDigest(promptStore, scannedEvidence, config, week, now = new Date(), {
  outputBinding = { mode: config.output.mode, adapterHash: null, objectives: false },
} = {}) {
  const promptEntries = promptCandidates(promptStore, config, week);
  const cueEntries = cueCandidates(scannedEvidence.evidence, promptStore);
  const scanExcludedCount = Object.values(scannedEvidence.scanExcluded)
    .flatMap((value) => Object.values(value)).reduce((sum, count) => sum + count, 0);
  const accounting = scannedEvidence.accounting;
  if (!accounting || accounting.acceptedPromptCount !== promptEntries.length ||
      accounting.scannedPromptCount !== promptStore.prompts.length ||
      accounting.acceptedCueCount !== scannedEvidence.evidence.length ||
      accounting.scannedCueCount !== accounting.acceptedCueCount + scanExcludedCount) {
    throw new Error('digest source scan accounting does not reconcile.');
  }
  if (accounting.acceptedPromptCount + accounting.acceptedCueCount !== promptEntries.length + cueEntries.length ||
      accounting.scannedPromptCount + accounting.scannedCueCount !==
        promptEntries.length + cueEntries.length + scanExcludedCount) {
    throw new Error('digest accepted-source accounting does not reconcile.');
  }
  const candidates = [
    ...promptEntries,
    ...cueEntries,
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.itemRef)) throw new Error('digest candidate itemRef collision.');
    seen.add(candidate.itemRef);
  }
  for (const candidate of candidates) {
    const signals = baseSignals(candidate);
    if (candidates.some((other) => other !== candidate && recurring(candidate, other))) signals.push('recurs');
    candidate.signals = orderedSignals(signals);
    candidate.score = candidate.signals.reduce((sum, signal) => sum + (config.curation.weights[signal] ?? 0), 0);
    const [code, reason] = primaryReason(candidate);
    candidate.selectionReasonCode = code;
    candidate.selectionReason = reason;
    const privacy = privacyDecision(candidate, config);
    candidate.privacy.decision = privacy;
    if (privacy !== 'automatic-safe') candidate.decision = privacy;
    else if (candidate.state !== 'kept' && !hasEligibility(candidate)) candidate.decision = 'missing-eligibility-signal';
    else if (candidate.state !== 'kept' && candidate.score < config.curation.automaticMinScore) candidate.decision = 'below-automatic-floor';
  }

  const kept = candidates.filter((candidate) => !candidate.decision && candidate.state === 'kept')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.itemRef.localeCompare(b.itemRef));
  kept.forEach((candidate) => { candidate.decision = 'automatic-safe'; });
  let remaining = Math.max(0, config.curation.maxItems - kept.length);
  const automatic = candidates.filter((candidate) => !candidate.decision)
    .sort((a, b) => b.score - a.score || CATEGORY_INDEX.get(a.category) - CATEGORY_INDEX.get(b.category) ||
      a.timestamp.localeCompare(b.timestamp) || a.itemRef.localeCompare(b.itemRef));
  const used = Object.fromEntries(DIGEST_CATEGORIES.map((category) => [category, 0]));
  for (const candidate of automatic) {
    if (used[candidate.category] >= config.curation.categoryCaps[candidate.category]) {
      candidate.decision = 'category-capacity';
    } else if (remaining === 0) {
      candidate.decision = 'overall-capacity';
    } else {
      candidate.decision = 'automatic-safe';
      used[candidate.category] += 1;
      remaining -= 1;
    }
  }
  candidates.sort((a, b) => CATEGORY_INDEX.get(a.category) - CATEGORY_INDEX.get(b.category) ||
    DIGEST_DECISIONS.indexOf(a.decision) - DIGEST_DECISIONS.indexOf(b.decision) ||
    b.score - a.score || a.timestamp.localeCompare(b.timestamp) || a.itemRef.localeCompare(b.itemRef));
  for (const candidate of candidates) {
    if (!candidate.selectionReason) {
      candidate.selectionReasonCode = candidate.decision;
      candidate.selectionReason = DECISION_REASONS[candidate.decision];
    }
    delete candidate._observedVerification;
  }
  const withheld = buildWithheld(candidates, scannedEvidence.scanExcluded);
  const selected = candidates.filter((candidate) => candidate.decision === 'automatic-safe')
    .sort((a, b) => CATEGORY_INDEX.get(a.category) - CATEGORY_INDEX.get(b.category) ||
      (a.state === 'kept' ? -1 : 0) - (b.state === 'kept' ? -1 : 0) ||
      b.score - a.score || a.timestamp.localeCompare(b.timestamp) || a.itemRef.localeCompare(b.itemRef));
  const policy = {
    version: 2, maxItems: config.curation.maxItems,
    automaticMinScore: config.curation.automaticMinScore,
    categoryCaps: { ...config.curation.categoryCaps }, weights: { ...config.curation.weights },
    maxAutomaticChangedPercent: config.privacy.publicRenditions.maxAutomaticChangedPercent,
    publicRenditionsEnabled: config.privacy.publicRenditions.enabled,
  };
  const review = {
    version: 1, generatedAt: now.toISOString(), week,
    sourceStatus: promptStore.sourceStatus, policy, candidates, withheld,
  };
  const lane = {
    version: 2, week, generatedAt: now.toISOString(), outputBinding, policy,
    sourceStatus: promptStore.sourceStatus,
    items: toPublicItems(selected, config, week, withheld), withheld,
  };
  const withheldCount = Object.values(withheld.total).reduce((sum, count) => sum + count, 0);
  if (candidates.length !== lane.items.length + withheldCount) throw new Error('digest curation accounting invariant failed.');
  return { review, lane };
}
