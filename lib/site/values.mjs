// lib/site/values.mjs — the generic derived-value context for site emit + fence.
//
// honestweek defines a GENERIC value vocabulary over the verified, redacted report
// model; a target's adapter maps its own field names onto these keys. The context
// resolves keys (resolve-or-throw, the same loud-fail posture as _shared.mjs) and
// computes `verifiedNumbers`: the set of numbers that may legitimately appear in
// the emitted artifact. Nothing here knows any target site's field names.
//
// Zero runtime dependencies: Node built-ins only.

import { walkNumbers } from './fact-fence.mjs';

/** Walk a dotted key path into an object; return the value or undefined. */
export function dottedGet(obj, key) {
  if (obj == null) return undefined;
  let cur = obj;
  for (const part of String(key).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Verified-number provenance (load-bearing — see docs/site-integration.md):
// verifiedNumbers is seeded ONLY from the explicitly TRUSTED derived sections
// (chart, sessions, provenance, and each group's git-derived metrics), NEVER from
// the whole model. The model's other substructure (item text, receipts) is string
// data that carries no numeric leaf to launder — but seeding from named trusted
// roots makes that guarantee STRUCTURAL rather than incidental, so a future
// model-authored numeric field could never silently become a "verified" number.
const TRUSTED_ROOTS = ['chart', 'sessions', 'provenance'];

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * The path + reason of the first INVALID leaf in a derivedTree value, or null if
 * the whole tree is valid. A derivedTree may contain ONLY finite numbers,
 * booleans, null, and (nested) plain objects/arrays of those. Anything else —
 * a string (prose could hide a number), a non-finite number, a BigInt, a Date or
 * other boxed/exotic object — is rejected (fail-closed), so no digit-bearing leaf
 * the fact-fence's numeric walk can't see (it only fires on `typeof 'number'`) can
 * be laundered through a wholesale-embedded tree. Object KEYS are not leaves.
 */
function firstInvalidTreeLeaf(value, path = '') {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : { path, reason: `a non-finite number (${String(value)})` };
  }
  if (typeof value === 'string') {
    return { path, reason: 'a string leaf — emit text via model/const/freetext so its numerals are fact-checked' };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = firstInvalidTreeLeaf(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      const hit = firstInvalidTreeLeaf(value[k], path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
    return null;
  }
  // BigInt, Date / boxed Number / other exotic object, function, symbol, undefined.
  return { path, reason: `a ${typeof value} leaf the fact-fence cannot inspect` };
}

/** Collect every finite number reachable from the trusted derived roots. */
function seedVerifiedNumbers(siteModel) {
  const verifiedNumbers = new Set();
  const add = (root) =>
    walkNumbers(root, (n) => {
      if (Number.isFinite(n)) verifiedNumbers.add(n);
    });
  for (const key of TRUSTED_ROOTS) add(siteModel?.[key]);
  // Per-group git-derived metrics are the only trusted numbers under `groups`.
  for (const g of Array.isArray(siteModel?.groups) ? siteModel.groups : []) add(g?.metrics);
  return verifiedNumbers;
}

/**
 * buildValueContext(siteModel) -> { resolveDerived, resolveDerivedTree, resolveModel, collection, verifiedNumbers }
 *
 * `siteModel` is the verified, redacted report model AUGMENTED with the derived
 * sections an artifact needs (provenance, chart, sessions, group metrics). Each
 * resolver takes an optional `scope` object (the current array element when
 * resolving inside an array template); when absent it resolves against the whole
 * model. Resolvers THROW on a miss — the emitter never invents a value.
 */
export function buildValueContext(siteModel) {
  const verifiedNumbers = seedVerifiedNumbers(siteModel);

  function resolveDerived(key, scope) {
    const v = dottedGet(scope ?? siteModel, key);
    if (v === undefined) {
      throw new Error(`site: derived key ${JSON.stringify(key)} did not resolve against the verified model.`);
    }
    if (v !== null && typeof v === 'object') {
      throw new Error(`site: derived key ${JSON.stringify(key)} resolved to a non-scalar — use derivedTree for a map/array, or an array node for a collection.`);
    }
    return v;
  }

  function resolveDerivedTree(key, scope) {
    const v = dottedGet(scope ?? siteModel, key);
    if (v === undefined) {
      throw new Error(`site: derivedTree key ${JSON.stringify(key)} did not resolve against the verified model.`);
    }
    if (v === null || typeof v !== 'object') {
      throw new Error(`site: derivedTree key ${JSON.stringify(key)} resolved to a scalar — use derived for a single value.`);
    }
    // derivedTree exists for dynamic-keyed NUMERIC maps the scalar grammar can't
    // express (e.g. a per-category count map). It embeds the sub-structure
    // wholesale and the fact-fence re-walks its numbers. Any leaf the fence's
    // numeric walk cannot inspect — a string (prose could hide a number), a
    // non-finite number, a BigInt/Date/boxed object — is forbidden (fail-closed):
    // route labelled/prose data through `model`/`const`/`freetext`, which the fence
    // scans. (Object KEYS may be string labels — trusted names, not claim leaves.)
    const offending = firstInvalidTreeLeaf(v);
    if (offending) {
      throw new Error(
        `site: derivedTree key ${JSON.stringify(key)} contains ${offending.reason} at ${offending.path || '<root>'} — ` +
          `derivedTree is for numeric/flag maps only.`
      );
    }
    return v;
  }

  function resolveModel(key, scope) {
    const v = dottedGet(scope ?? siteModel, key);
    if (typeof v !== 'string') {
      throw new Error(`site: model key ${JSON.stringify(key)} did not resolve to a string in the verified model.`);
    }
    return v;
  }

  function collection(key, scope) {
    const v = dottedGet(scope ?? siteModel, key);
    if (!Array.isArray(v)) {
      throw new Error(`site: collection key ${JSON.stringify(key)} did not resolve to an array.`);
    }
    return v;
  }

  return { resolveDerived, resolveDerivedTree, resolveModel, collection, verifiedNumbers };
}
