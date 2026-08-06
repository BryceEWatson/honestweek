import { sha256 } from './prompt-identity.mjs';
import { DETECTOR_ORDER } from './prompt-privacy.mjs';

function orderedDetectors(values) {
  return [...values].sort((a, b) => DETECTOR_ORDER.indexOf(a) - DETECTOR_ORDER.indexOf(b));
}

function directFields(source) {
  return {
    timestamp:source.timestamp, project:source.project, isPrivate:source.isPrivate,
    text:source.text, sourceHash:source.sourceHash, contentHash:source.contentHash,
    sourceLength:source.sourceLength, redactionCount:source.redactionCount,
    changedPercent:source.changedPercent, rawRisk:source.rawRisk,
    rawDetectors:orderedDetectors(source.rawDetectors), redactionOps:structuredClone(source.redactionOps),
    transform:source.redactionCount ? 'redaction' : 'none', truncated:source.truncated,
  };
}

function privacyFields(source) {
  return {
    renditionHash:sha256(source.text), transform:source.redactionCount ? 'redaction' : 'none',
    changedPercent:source.changedPercent, rawRisk:source.rawRisk,
  };
}

export function sourceBoundProjection(source) {
  return { candidate:directFields(source), privacy:privacyFields(source) };
}

export function candidateSourceBoundProjection(candidate) {
  return {
    candidate:directFields(candidate),
    privacy: {
      renditionHash:candidate.privacy.renditionHash, transform:candidate.privacy.transform,
      changedPercent:candidate.privacy.changedPercent, rawRisk:candidate.privacy.rawRisk,
    },
  };
}

export function sourcePrivacyBinding(entries) {
  const ordered = entries.slice().sort((a, b) => a.ref.localeCompare(b.ref));
  return {
    sourceRefs:ordered.map((entry) => entry.ref),
    sourceContentHashes:ordered.map((entry) => entry.contentHash),
  };
}
