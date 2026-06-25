// lib/site/transform.mjs — the TRANSFORM adapter style for complex sites.
//
// A static JSON adapter (adapter.mjs) maps fields one-for-one; it cannot GROUP,
// gate, sort, or join — shaping a real site's artifact often needs all four. The
// transform style covers that: the target commits a `honestweek.site.mjs` that
// exports `artifact` (the write path) and `transform(model, ctx)` — a pure
// function from honestweek's VERIFIED, REDACTED bundle to the site artifact.
//
// The NUMBER-honesty guarantee is preserved. honestweek still:
//   - verifies every cited commit (verify-or-abort) and re-derives every number
//     in the bundle (chart, sessions, provenance, per-project stats, archive);
//   - re-walks the transform's output and aborts unless every NUMBER traces to a
//     verified derived value, AND fails CLOSED on any leaf its numeric walk can't
//     inspect (a Date / BigInt / boxed primitive that would serialize to digits).
//
// This is NARROWER than the static grammar's guarantee, by design: STRINGS are NOT
// prose-scanned here. In transform mode the site's strings are HUMAN-CURATED
// content (the author's own claims, redacted), which is trusted and not
// honestweek's to number-check — so a quantity a human wrote in prose ("8 of 13
// claims drifted") passes, exactly as it did before honestweek. The guarantee is:
// no unverified NUMBER (numeric leaf) reaches the page; authored prose is trusted.
//
// Zero runtime dependencies: Node built-ins only.

import { pathToFileURL } from 'node:url';

import { walkNumbers, FactFenceError } from './fact-fence.mjs';
import { seedVerifiedNumbers } from './values.mjs';

/** Throw on any leaf the numeric walk cannot inspect — a Date, BigInt, boxed
 *  Number, function, or symbol — which would serialize to digit-bearing bytes
 *  having bypassed verification. Allowed leaves: finite numbers (checked
 *  separately), strings (trusted curated content), booleans, null. */
function assertNoBlindLeaf(value, path = '') {
  if (value === null || value === undefined) return; // undefined is omitted by JSON.stringify
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoBlindLeaf(v, `${path}[${i}]`));
    return;
  }
  if (t === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const k of Object.keys(value)) assertNoBlindLeaf(value[k], path ? `${path}.${k}` : k);
    return;
  }
  throw new FactFenceError(
    `site: ABORTED — a ${t === 'object' ? Object.prototype.toString.call(value) : t} leaf at ${path || '<root>'} cannot be fact-checked (only numbers/strings/booleans/null/plain containers may reach the artifact). Nothing written.`
  );
}

/**
 * factFenceNumbers(artifact, verifiedNumbers) -> void (throws FactFenceError).
 * Every numeric leaf must be finite AND a verified derived value, and no leaf may
 * be a type the numeric walk can't see (fail-closed). Strings are NOT scanned: in
 * transform mode they are trusted, redacted, human-curated passthrough.
 */
export function factFenceNumbers(artifact, verifiedNumbers) {
  assertNoBlindLeaf(artifact);
  walkNumbers(artifact, (n, path) => {
    if (!Number.isFinite(n)) {
      throw new FactFenceError(`site: ABORTED — non-finite number (${String(n)}) at ${path || '<root>'} cannot be a verified value. Nothing written.`);
    }
    if (!verifiedNumbers.has(n)) {
      throw new FactFenceError(`site: ABORTED — number ${n} at ${path || '<root>'} is not traceable to a verified value. Nothing written.`);
    }
  });
}

/** Dynamically import a committed transform adapter; validate its exports. */
export async function loadTransformAdapter(adapterPath) {
  let mod;
  try {
    mod = await import(pathToFileURL(adapterPath).href);
  } catch (err) {
    throw new Error(`site: cannot load transform adapter at ${adapterPath} (${err?.message ?? err}).`);
  }
  const transform = mod.transform ?? mod.default;
  if (typeof transform !== 'function') {
    throw new Error(`site: transform adapter ${adapterPath} must export a "transform(model, ctx)" function (or a default function).`);
  }
  if (typeof mod.artifact !== 'string' || mod.artifact.trim() === '') {
    throw new Error(`site: transform adapter ${adapterPath} must export an "artifact" path string (where to write, relative to the target root).`);
  }
  return { transform, artifact: mod.artifact };
}

/**
 * renderSiteViaTransform(transform, bundle, ctx) -> artifact object.
 * Runs the (possibly raw, in redact:false mode) bundle through the committed
 * transform, then fact-fences every number against the bundle's verified derived
 * values. Throws FactFenceError on any unverifiable number (build -> exit 2).
 *
 * A transform that DERIVES a number not in the bundle — e.g. its own redaction
 * count when it owns redaction (redact:false) — may declare it by returning
 * `{ artifact, verifiedExtra: [n, ...] }` instead of the bare artifact. Those
 * numbers join the verified set: this is the committed, reviewable transform
 * vouching for a deterministic count it computed, not a way to wave through a
 * fabricated work fact (which would still have to BE one of these declared values).
 */
export function renderSiteViaTransform(transform, bundle, ctx = {}) {
  const ret = transform(bundle, ctx);
  if (ret === null || typeof ret !== 'object') {
    throw new Error('site: the transform must return an artifact object (or { artifact, verifiedExtra }).');
  }
  const isWrapped = 'artifact' in ret && typeof ret.artifact === 'object' && Array.isArray(ret.verifiedExtra);
  const artifact = isWrapped ? ret.artifact : ret;
  if (artifact === null || typeof artifact !== 'object') {
    throw new Error('site: the transform must return an artifact object.');
  }
  const verifiedNumbers = seedVerifiedNumbers(bundle);
  if (isWrapped) for (const n of ret.verifiedExtra) if (Number.isFinite(n)) verifiedNumbers.add(n);
  factFenceNumbers(artifact, verifiedNumbers);
  return artifact;
}
