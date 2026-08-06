// Dependency-neutral constants for the balanced digest's closed public and
// private schemas. Curation, validation, and rendering derive from one table.

export const DIGEST_CATEGORY_DEFINITIONS = Object.freeze([
  Object.freeze({ category: 'prompts', kind: 'prompt', group: 'Prompt highlights' }),
  Object.freeze({ category: 'ideas', kind: 'idea', group: 'Ideas' }),
  Object.freeze({ category: 'techniques', kind: 'technique', group: 'Techniques' }),
  Object.freeze({ category: 'decisions', kind: 'decision', group: 'Decisions' }),
  Object.freeze({ category: 'reversals', kind: 'reversal', group: 'Reversals' }),
  Object.freeze({ category: 'nextSteps', kind: 'next-step', group: 'Next steps' }),
]);

export const DIGEST_CATEGORIES = Object.freeze(DIGEST_CATEGORY_DEFINITIONS.map((value) => value.category));
export const DIGEST_KINDS = Object.freeze(DIGEST_CATEGORY_DEFINITIONS.map((value) => value.kind));
export const DIGEST_GROUPS = Object.freeze(DIGEST_CATEGORY_DEFINITIONS.map((value) => value.group));
export const DIGEST_CATEGORY_KIND = Object.freeze(Object.fromEntries(
  DIGEST_CATEGORY_DEFINITIONS.map((value) => [value.category, value.kind]),
));
export const DIGEST_CATEGORY_GROUP = Object.freeze(Object.fromEntries(
  DIGEST_CATEGORY_DEFINITIONS.map((value) => [value.category, value.group]),
));

export const DIGEST_DECISIONS = Object.freeze([
  'automatic-safe', 'hidden', 'private-source', 'high-risk', 'needs-approval',
  'public-renditions-disabled', 'missing-eligibility-signal',
  'below-automatic-floor', 'category-capacity', 'overall-capacity',
]);

export const DIGEST_SIGNALS = Object.freeze([
  'decision-or-reversal', 'observed-verification', 'recurs',
  'unresolved-next-step', 'follow-on-correction', 'positive-feedback',
  'negative-feedback', 'decision-request', 'reversal-request', 'next-step-request',
]);

export function isReservedDigestItem(item) {
  return DIGEST_KINDS.includes(item?.kind) && item?.publicDisposition === 'automatic-safe';
}

export function assertNoDigestGroupCollision(authoredItems, lane, projectMetadata = [], configuredRepos = []) {
  if (lane?.version !== 2 || !Array.isArray(lane.items)) return;
  const visibleGroups = new Set(lane.items.map((item) => item.project).filter((value) => DIGEST_GROUPS.includes(value)));
  for (const item of authoredItems) {
    if ([item?.project, item?.repo].some((value) => visibleGroups.has(value))) {
      throw new Error('an authored work label collides with a reserved digest group; rename the work label before building.');
    }
  }
  const metadataNames = Array.isArray(projectMetadata)
    ? projectMetadata.map((value) => value?.name)
    : projectMetadata && typeof projectMetadata === 'object'
      ? [...Object.keys(projectMetadata), ...Object.values(projectMetadata).map((value) => value?.name)]
      : [];
  if (metadataNames.some((value) => visibleGroups.has(value))) {
    throw new Error('authored project metadata collides with a reserved digest group; rename the project before building.');
  }
  if ((Array.isArray(configuredRepos) ? configuredRepos : []).some((value) => visibleGroups.has(value?.label))) {
    throw new Error('a configured repository label collides with a reserved digest group; rename the repository label before building.');
  }
}
