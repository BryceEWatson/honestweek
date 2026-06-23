// lib/badges.mjs — the status-badge taxonomy, the single source of truth.
//
// Every narrative item in the final summary carries exactly one public status
// badge. The mapping from an item's internal tag to that badge lives ONLY here,
// so the honesty guarantee — verified/measured work reads as `shipped`, while
// assumed/unverified work reads as `designed, not proven` — is enforced in one
// place rather than re-implemented per call site.
//
// Pure, no I/O, deterministic. Zero runtime dependencies.

/** The three public status badges, in the canonical order (exact strings). */
export const STATUSES = ['shipped', 'in progress', 'designed, not proven'];

// Internal tag -> badge. Anything not listed falls back to the most honest
// (weakest) badge; see statusForTag.
const TAG_TO_STATUS = new Map([
  ['verified', 'shipped'],
  ['measured', 'shipped'],
  ['in-progress', 'in progress'],
  ['in progress', 'in progress'],
  ['wip', 'in progress'],
  ['assumed', 'designed, not proven'],
  ['unverified', 'designed, not proven'],
  ['handoff-claimed', 'designed, not proven'],
  ['designed', 'designed, not proven'],
]);

/**
 * statusForTag(tag) -> one of STATUSES.
 *
 *   verified | measured                       -> 'shipped'
 *   in-progress | 'in progress' | wip          -> 'in progress'
 *   assumed | unverified | handoff-claimed     -> 'designed, not proven'
 *
 * Honesty bias is to UNDER-claim: any unknown, empty, or undefined tag falls
 * back to 'designed, not proven' and NEVER to 'shipped'. `shipped` is reachable
 * only via an explicit verified/measured tag.
 */
export function statusForTag(tag) {
  if (typeof tag !== 'string') return 'designed, not proven';
  const key = tag.trim().toLowerCase();
  return TAG_TO_STATUS.get(key) ?? 'designed, not proven';
}
