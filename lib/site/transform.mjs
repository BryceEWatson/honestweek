// lib/site/transform.mjs — the TRANSFORM adapter style for complex sites.
//
// A static JSON adapter (adapter.mjs) maps fields one-for-one; it cannot GROUP,
// gate, sort, or join — shaping a real site's artifact often needs all four. The
// transform style covers that: the target commits a `honestweek.site.mjs` that
// exports `artifact` (the write path) and `transform(model, ctx)` — a pure
// function from honestweek's VERIFIED, REDACTED bundle to the site artifact.
//
// The honesty guarantee is preserved, not weakened. honestweek still:
//   - verifies every cited commit (verify-or-abort) and re-derives every number
//     in the bundle (chart, sessions, provenance, per-project stats, archive);
//   - redacts the bundle before the transform sees it;
//   - re-walks EVERY numeric leaf of the transform's output and aborts unless it
//     traces to a verified derived value (factFenceNumbers, below).
// So the committed transform may SHAPE and may place human-curated STRINGS, but it
// cannot put an unverified NUMBER on the page — the same structural guarantee the
// static grammar gives, enforced at the bytes instead of the field map.
//
// Zero runtime dependencies: Node built-ins only.

import { pathToFileURL } from 'node:url';

import { walkNumbers, FactFenceError } from './fact-fence.mjs';
import { seedVerifiedNumbers } from './values.mjs';

/**
 * factFenceNumbers(artifact, verifiedNumbers) -> void (throws FactFenceError).
 * Every numeric leaf must be finite AND a verified derived value. Strings are NOT
 * scanned here: in transform mode the strings are human-curated passthrough (the
 * site's authored content), trusted + redacted but not honestweek's to verify. The
 * load-bearing guarantee — no unverified NUMBER reaches the page — is enforced.
 */
export function factFenceNumbers(artifact, verifiedNumbers) {
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
 * Runs the (redacted) bundle through the committed transform, then fact-fences
 * every number against the bundle's verified derived values. Throws FactFenceError
 * on any unverifiable number (the build maps it to exit 2).
 */
export function renderSiteViaTransform(transform, bundle, ctx = {}) {
  const artifact = transform(bundle, ctx);
  if (artifact === null || typeof artifact !== 'object') {
    throw new Error('site: the transform must return an artifact object.');
  }
  factFenceNumbers(artifact, seedVerifiedNumbers(bundle));
  return artifact;
}
