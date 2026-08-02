import { localDateInTimezone } from './resolve-week.mjs';
import { assessPublicRendition } from './redact.mjs';
import { evaluatePrompts } from './prompt-curation.mjs';
import { digestItemIdentity } from './prompt-identity.mjs';
import { hasRecurringText } from './curation-similarity.mjs';
import { carryRecordBefore, carryTombstonesForWeek } from './digest-carry.mjs';
import { digestPolicyForConfig } from './digest-store.mjs';
import {
  assessCandidatePublicSafety, chooseRetirementReason, retiredRow,
} from './digest-lifecycle.mjs';
import {
  DIGEST_CATEGORIES, DIGEST_CATEGORY_GROUP, DIGEST_CATEGORY_KIND,
  DIGEST_DECISIONS, DIGEST_SIGNALS,
} from './digest-schema.mjs';
import { sourceBoundProjection, sourcePrivacyBinding } from './digest-source-bound.mjs';
import { DETECTOR_ORDER } from './prompt-privacy.mjs';

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

function transcriptTurnKey(value) {
  return `${value.source}\0${value.sessionKey}\0${value.turn}`;
}

function sortReceipts(values) {
  return values.slice().sort((a, b) => a.source.localeCompare(b.source) ||
    a.sessionKey.localeCompare(b.sessionKey) || a.turn - b.turn ||
    a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
}

function promptCandidates(store, config, week) {
  const evaluated = evaluatePrompts(store, config, week).evaluated;
  return evaluated.map(({ p, codes }) => {
    const evidenceRefs = [p.ref];
    const itemRef = digestItemIdentity('prompts', evidenceRefs, 'prompt');
    const sources = sourcePrivacyBinding([{ ref: p.ref, contentHash: p.contentHash }]);
    const bound = sourceBoundProjection(p);
    return {
      itemRef, category: 'prompts', discriminator: 'prompt', evidenceRefs,
      receipts: [receipt(p.source, p.sessionKey, p.turn, 'human-prompt', p.ref)],
      ...bound.candidate, state: p.state,
      signals: orderedSignals(codes), score: 0, selectionReasonCode: '',
      selectionReason: '', decision: '', privacy: {
        ...sources, ...bound.privacy,
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
    const human = entry.kind === 'human-cue';
    const sources = [{ ref: entry.evidenceRef, contentHash: entry.contentHash }];
    const receipts = [receipt(entry.source, entry.sessionKey, entry.turn, entry.kind, entry.evidenceRef)];
    if (technique || human) {
      sources.push({ ref: prompt.ref, contentHash: prompt.contentHash });
      receipts.push(receipt(prompt.source, prompt.sessionKey, prompt.turn, 'human-prompt', prompt.ref));
    }
    const evidenceRefs = sources.map((source) => source.ref).sort();
    const sourcePrivacy = sourcePrivacyBinding(sources);
    // The prompt receipt proves the technique's verification window. Privacy
    // metadata remains scoped to the exact cue rendition that may be emitted.
    // Human cues additionally inherit the containing prompt's conservative
    // count-only audit because the human authored both sources together.
    const bound = sourceBoundProjection(entry);
    if (human) {
      const risk = ['low', 'medium', 'high'];
      bound.candidate.changedPercent = Math.max(bound.candidate.changedPercent, prompt.changedPercent);
      bound.candidate.rawRisk = risk[Math.max(risk.indexOf(bound.candidate.rawRisk), risk.indexOf(prompt.rawRisk))];
      bound.candidate.rawDetectors = [...new Set([...bound.candidate.rawDetectors, ...prompt.rawDetectors])]
        .sort((a, b) => DETECTOR_ORDER.indexOf(a) - DETECTOR_ORDER.indexOf(b));
      bound.candidate.truncated ||= prompt.truncated;
      bound.privacy.changedPercent = bound.candidate.changedPercent;
      bound.privacy.rawRisk = bound.candidate.rawRisk;
    }
    return {
      itemRef: digestItemIdentity(entry.category, evidenceRefs, entry.discriminator),
      category: entry.category, discriminator: entry.discriminator, evidenceRefs,
      receipts: sortReceipts(receipts), ...bound.candidate,
      state: prompt.state === 'hidden' ? 'hidden' : 'inbox',
      signals: [], score: 0, selectionReasonCode: '', selectionReason: '', decision: '',
      privacy: {
        ...sourcePrivacy, ...bound.privacy,
        residualRisk: entry.residualRisk, decision: '', policyVersion: 1,
      },
      _observedVerification: entry.observedVerification,
    };
  });
}

function baseSignals(candidate) {
  if (candidate._lifecycleMode && candidate.signals.length) return candidate.signals;
  if (candidate.category === 'prompts') return candidate.signals;
  const signals = [];
  if (candidate.category === 'decisions' || candidate.category === 'reversals') signals.push('decision-or-reversal');
  if (candidate._observedVerification) signals.push('observed-verification');
  if (candidate.category === 'nextSteps') signals.push('unresolved-next-step');
  return signals;
}

function primaryReason(candidate) {
  if (candidate._lifecycleMode === 'manual') return ['manual-renewal', 'you renewed this item for this digest'];
  if (candidate.state === 'kept') return ['explicit-keep', candidate.category === 'prompts' ? 'you kept this prompt' : 'you kept this item'];
  if (candidate._lifecycleMode === 'automatic') return ['automatic-carry', 'unresolved item carried from a prior week'];
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
  const assessment = assessCandidatePublicSafety(candidate, config);
  candidate.privacy.residualRisk = assessment.residualRisk;
  return assessment.decision;
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
  const lifecycle = candidate._lifecycle
    ? ` First seen ${candidate._lifecycle.firstSeenWeek}; as of ${candidate._lifecycle.asOfWeek}.`
    : '';
  return `Why it surfaced: ${candidate.selectionReason}. Automatic floor ${config.curation.automaticMinScore}; overall target ${config.curation.maxItems}; ${DIGEST_CATEGORY_GROUP[candidate.category]} cap ${cap}; ${omitted} eligible omitted in this category. These rules favor observable recurrence and verification, not universal importance.${candidate.transform === 'redaction' ? ' Privacy edited.' : ''}${lifecycle}`;
}

function toPublicItems(selected, config, week, withheld) {
  const sessionPrefixes = prefixMap(selected.flatMap((candidate) => candidate.receipts.map((value) => value.sessionKey)));
  const refPrefixes = prefixMap(selected.flatMap((candidate) => candidate.receipts.map((value) => value.ref)));
  return selected.map((candidate) => {
    const receipts = candidate.receipts;
    const first = receipts[0];
    const lifecycleCode = candidate._lifecycleMode === 'manual' ? 'manual-renewal'
      : candidate._lifecycleMode === 'automatic' && candidate.state !== 'kept' ? 'automatic-carry' : null;
    const reasonCodes = lifecycleCode ? [lifecycleCode, ...candidate.signals]
      : candidate.state === 'kept' ? ['explicit-keep', ...candidate.signals] : candidate.signals;
    return {
      id: `digest-${candidate.itemRef}`, itemRef: candidate.itemRef,
      evidenceRefs: candidate.evidenceRefs, receipts, kind: DIGEST_CATEGORY_KIND[candidate.category],
      category: candidate.category, week,
      curationState: candidate._lifecycleMode === 'manual' ? 'renewed'
        : candidate._lifecycleMode === 'automatic' && candidate.state !== 'kept' ? 'carried'
          : candidate.state === 'kept' ? 'kept' : 'automatic',
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

function copyCandidate(value) {
  const candidate = structuredClone(value);
  candidate.state = 'inbox';
  candidate.decision = '';
  candidate.selectionReasonCode = '';
  candidate.selectionReason = '';
  return candidate;
}

function terminalMatches(entry, terminals, config) {
  const matching = terminals.filter((terminal) => hasRecurringText(entry.candidate.text, terminal.text));
  if (matching.length > 1) throw new Error('multiple terminal receipts match a carried lineage; no digest state was changed.');
  if (!matching.length) return null;
  const [terminal] = matching;
  const invalid = terminal.invalid || terminal.isPrivate || terminal.residualRisk !== 'low' || terminal.truncated ||
    terminal.changedPercent > config.privacy.publicRenditions.maxAutomaticChangedPercent ||
    terminal.rawDetectors.includes('capitalized-unknown');
  if (invalid) throw new Error('matching terminal material is not unambiguously public-safe; no digest state was changed.');
  return terminal;
}

function lifecycleCandidates(
  sourceCandidates, scannedEvidence, config, week, carry, tombstoneByRef,
  promptTombstoneRefs, promptTombstoneTurns, priorByRef,
) {
  const record = carryRecordBefore(carry, week);
  if (!record) return { admitted: [], retired: [], consumed: new Set() };
  for (const terminal of scannedEvidence.terminalEvidence ?? []) {
    const matches = record.entries.filter((entry) => hasRecurringText(entry.candidate.text, terminal.text));
    if (matches.length > 1) {
      throw new Error('one terminal receipt matches multiple carried lineages; no digest state was changed.');
    }
  }
  const admitted = [];
  const retired = [];
  const consumed = new Set();
  const matchedCurrent = new Map();
  for (const entry of record.entries) {
    const duplicateMatches = sourceCandidates.filter((candidate) =>
      candidate.category === entry.category && hasRecurringText(entry.candidate.text, candidate.text));
    if (duplicateMatches.length > 1) throw new Error('multiple current candidates match a carried lineage; no digest state was changed.');
    const current = duplicateMatches[0] ?? null;
    if (current) {
      const priorLineage = matchedCurrent.get(current.itemRef);
      if (priorLineage && priorLineage !== entry.lineageRef) {
        throw new Error('one current candidate matches multiple carried lineages; no digest state was changed.');
      }
      matchedCurrent.set(current.itemRef, entry.lineageRef);
    }
    const candidate = current ? structuredClone(current) : copyCandidate(entry.candidate);
    const prior = priorByRef.get(candidate.itemRef) ?? priorByRef.get(entry.itemRef);
    if (prior && prior.state !== 'inbox' && candidate.state !== 'hidden') candidate.state = prior.state;
    const promptTombstoned = (value) =>
      value.evidenceRefs.some((ref) => promptTombstoneRefs.has(ref)) ||
      value.receipts.some((receiptValue) => promptTombstoneTurns.has(transcriptTurnKey(receiptValue)));
    const tombstoned = tombstoneByRef.has(entry.itemRef) || tombstoneByRef.has(candidate.itemRef) ||
      promptTombstoned(entry.candidate) || promptTombstoned(candidate);
    const terminal = terminalMatches(entry, scannedEvidence.terminalEvidence ?? [], config);
    candidate.privacy.residualRisk = assessPublicRendition(candidate.text, config);
    const privacyUnsafe = privacyDecision(candidate, config) !== 'automatic-safe';
    const automaticLive = entry.automaticThroughWeek !== null && week.start <= entry.automaticThroughWeek;
    const manualDue = entry.manualTargetWeek === week.start;
    const manualExpired = entry.manualTargetWeek !== null && entry.manualTargetWeek < week.start;
    const reasons = [];
    if (tombstoned) reasons.push('deleted');
    if (candidate.state === 'hidden') reasons.push('hidden');
    if (terminal) reasons.push(terminal.kind === 'picked-up' ? 'terminal-picked-up' : 'terminal-ruled-out');
    if (privacyUnsafe) reasons.push('privacy-withheld');
    if (current && current.itemRef !== entry.itemRef) reasons.push('superseded');
    if (!automaticLive && !manualDue && entry.automaticThroughWeek !== null) reasons.push('automatic-limit');
    if (!automaticLive && !manualDue && manualExpired) reasons.push('manual-expired');
    const terminalOrBlocking = reasons.some((reason) =>
      ['deleted','hidden','terminal-picked-up','terminal-ruled-out','privacy-withheld'].includes(reason));
    if (terminalOrBlocking || (!automaticLive && !manualDue)) {
      const reason = chooseRetirementReason(reasons);
      if (reason) retired.push(retiredRow({
        entry: { ...entry, candidate }, reason,
        terminalRef: reason.startsWith('terminal-') ? terminal.terminalRef : null,
        config,
      }));
      if (current) consumed.add(current.itemRef);
      continue;
    }
    if (current) {
      consumed.add(current.itemRef);
      if (current.itemRef !== entry.itemRef) retired.push(retiredRow({ entry, reason: 'superseded', config }));
    }
    candidate._lifecycleMode = manualDue ? 'manual' : 'automatic';
    candidate._lifecycle = {
      lineageRef: entry.lineageRef, itemRef: candidate.itemRef,
      firstSeenWeek: entry.firstSeenWeek, asOfWeek: week.start,
      mode: candidate._lifecycleMode,
    };
    candidate._carryEntry = structuredClone(entry);
    admitted.push(candidate);
  }
  return { admitted, retired, consumed };
}

export function curateDigest(promptStore, scannedEvidence, config, week, now = new Date(), {
  outputBinding = { mode: config.output.mode, adapterHash: null, objectives: false },
  priorReview = null,
  carry = null,
  carryHash = null,
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
  const sourceCandidates = [
    ...promptEntries,
    ...cueEntries,
  ];
  const seen = new Set();
  for (const candidate of sourceCandidates) {
    if (seen.has(candidate.itemRef)) throw new Error('digest candidate itemRef collision.');
    seen.add(candidate.itemRef);
  }
  const sameWeek = priorReview && priorReview.week?.start === week.start && priorReview.week?.end === week.end;
  const priorByRef = new Map((sameWeek ? priorReview.candidates : []).map((candidate) => [candidate.itemRef, candidate]));
  const tombstones = [
    ...(sameWeek ? priorReview.tombstones ?? [] : []),
    ...carryTombstonesForWeek(carry, week),
  ].map((value) => ({
    itemRef: value.itemRef, category: value.category,
    evidenceRefs: [...value.evidenceRefs], deletedAt: value.deletedAt,
  })).filter((value, index, values) => values.findIndex((other) => other.itemRef === value.itemRef) === index)
    .sort((a, b) => a.itemRef.localeCompare(b.itemRef));
  const tombstoneByRef = new Map(tombstones.map((value) => [value.itemRef, value]));
  const promptTombstoneRefs = new Set(promptStore.tombstones.map((value) => value.ref));
  const promptTombstoneTurns = new Set(promptStore.tombstones.map(transcriptTurnKey));
  for (const candidate of sourceCandidates) {
    const prior = priorByRef.get(candidate.itemRef);
    if (prior && prior.state !== 'inbox') {
      if (prior.category !== candidate.category || prior.discriminator !== candidate.discriminator ||
          JSON.stringify(prior.evidenceRefs) !== JSON.stringify(candidate.evidenceRefs) ||
          prior.sourceHash !== candidate.sourceHash || prior.contentHash !== candidate.contentHash) {
        throw new Error('source changed for a controlled digest candidate; old review preserved.');
      }
      if (candidate.state !== 'hidden') candidate.state = prior.state;
    }
    const tombstone = tombstoneByRef.get(candidate.itemRef);
    if (tombstone && (tombstone.category !== candidate.category ||
        JSON.stringify(tombstone.evidenceRefs) !== JSON.stringify(candidate.evidenceRefs))) {
      throw new Error('digest tombstone does not match its source candidate; old review preserved.');
    }
  }
  const lifecycle = lifecycleCandidates(
    sourceCandidates, scannedEvidence, config, week, carry, tombstoneByRef,
    promptTombstoneRefs, promptTombstoneTurns, priorByRef,
  );
  const candidates = [
    ...sourceCandidates.filter((candidate) =>
      !tombstoneByRef.has(candidate.itemRef) && !lifecycle.consumed.has(candidate.itemRef)),
    ...lifecycle.admitted,
  ];
  if (new Set(candidates.map((candidate) => candidate.itemRef)).size !== candidates.length) {
    throw new Error('digest candidate itemRef collision after carry reconciliation.');
  }
  const privacyByRef = new Map(candidates.map((candidate) => [candidate.itemRef, privacyDecision(candidate, config)]));
  const recurrenceCandidates = candidates.filter((candidate) =>
    !['hidden', 'private-source', 'high-risk', 'needs-approval'].includes(privacyByRef.get(candidate.itemRef)));
  for (const candidate of candidates) {
    const signals = baseSignals(candidate);
    if (recurrenceCandidates.some((other) => other !== candidate && recurring(candidate, other))) signals.push('recurs');
    candidate.signals = orderedSignals(signals);
    candidate.score = candidate.signals.reduce((sum, signal) => sum + (config.curation.weights[signal] ?? 0), 0);
    const [code, reason] = primaryReason(candidate);
    candidate.selectionReasonCode = code;
    candidate.selectionReason = reason;
    const privacy = privacyByRef.get(candidate.itemRef);
    candidate.privacy.decision = privacy;
    if (privacy !== 'automatic-safe') candidate.decision = privacy;
    else if (candidate._lifecycleMode === 'manual') candidate.decision = '';
    else if (candidate.state !== 'kept' && !hasEligibility(candidate)) candidate.decision = 'missing-eligibility-signal';
    else if (candidate.state !== 'kept' && candidate.score < config.curation.automaticMinScore) candidate.decision = 'below-automatic-floor';
  }

  const kept = candidates.filter((candidate) => !candidate.decision && candidate.state === 'kept' && candidate._lifecycleMode !== 'manual')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.itemRef.localeCompare(b.itemRef));
  kept.forEach((candidate) => { candidate.decision = 'automatic-safe'; });
  const renewed = candidates.filter((candidate) => !candidate.decision && candidate._lifecycleMode === 'manual')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.itemRef.localeCompare(b.itemRef));
  renewed.forEach((candidate) => { candidate.decision = 'automatic-safe'; });
  let remaining = Math.max(0, config.curation.maxItems - kept.length - renewed.length);
  const automatic = candidates.filter((candidate) => !candidate.decision)
    .sort((a, b) => (a._lifecycleMode === 'automatic' ? -1 : 0) - (b._lifecycleMode === 'automatic' ? -1 : 0) ||
      b.score - a.score || CATEGORY_INDEX.get(a.category) - CATEGORY_INDEX.get(b.category) ||
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
      (a.state === 'kept' && !a._lifecycleMode ? 0 : a._lifecycleMode === 'manual' ? 1 : a._lifecycleMode === 'automatic' ? 2 : 3) -
      (b.state === 'kept' && !b._lifecycleMode ? 0 : b._lifecycleMode === 'manual' ? 1 : b._lifecycleMode === 'automatic' ? 2 : 3) ||
      b.score - a.score || a.timestamp.localeCompare(b.timestamp) || a.itemRef.localeCompare(b.itemRef));
  const policy = digestPolicyForConfig(config);
  const renewals = (sameWeek && priorReview?.version === 3 ? priorReview.renewals : [])
    .map((value) => ({ ...value })).sort((a, b) => a.itemRef.localeCompare(b.itemRef));
  const lifecycleEntries = lifecycle.admitted.map((candidate) => candidate._lifecycle)
    .sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
  const lifecycleRetired = lifecycle.retired
    .sort((a, b) => a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
  const lifecycleAware = carry !== null || renewals.length > 0 || lifecycleEntries.length > 0 || lifecycleRetired.length > 0;
  const lane = {
    version: 2, week, generatedAt: now.toISOString(), outputBinding, policy,
    sourceStatus: promptStore.sourceStatus,
    items: toPublicItems(selected, config, week, withheld), withheld,
  };
  for (const candidate of candidates) {
    delete candidate._lifecycleMode;
    delete candidate._lifecycle;
    delete candidate._carryEntry;
  }
  const review = {
    version: lifecycleAware ? 3 : tombstones.length ? 2 : 1, generatedAt: now.toISOString(), week,
    sourceStatus: promptStore.sourceStatus, policy, candidates, withheld,
    ...(tombstones.length ? { tombstones: tombstones.sort((a, b) => a.itemRef.localeCompare(b.itemRef)) } : {}),
    ...(lifecycleAware ? {
      tombstones,
      renewals,
      lifecycle: { carryHash, entries: lifecycleEntries, retired: lifecycleRetired },
    } : {}),
  };
  const withheldCount = Object.values(withheld.total).reduce((sum, count) => sum + count, 0);
  if (candidates.length !== lane.items.length + withheldCount) throw new Error('digest curation accounting invariant failed.');
  return { review, lane };
}
