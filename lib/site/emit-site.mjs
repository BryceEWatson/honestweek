// lib/site/emit-site.mjs — resolve a target's adapter against the verified model.
//
// This is the deterministic heart of the site integration: given the verified,
// redacted, derived-augmented report model and the (human-reviewed, committed)
// adapter, it walks the adapter tree and fills each field by resolving its closed
// source kind (resolve-or-throw). The model never originates a number — `derived`
// pulls re-derived values, `model` pulls already-verified strings, `const` is
// non-numeric, `freetext` is prose the fact-fence scans. The fact-fence then
// re-checks the final bytes before the artifact is returned.
//
// Pure given (siteModel, adapter): no I/O. The dispatcher owns the file write.
// Zero runtime dependencies: Node built-ins only.

import { validateAdapter, isDirective } from './adapter.mjs';
import { buildValueContext } from './values.mjs';
import { factFence, FactFenceError } from './fact-fence.mjs';

/** A field whose directive is `omit` renders to this sentinel; objects drop it. */
const OMIT = Symbol('omit');

function renderNode(node, ctx, scope, path, proseLeaves) {
  if (isDirective(node)) {
    switch (node.source) {
      case 'const':
        // A const STRING is authored copy: scan its numerals like freetext, so an
        // authored quantity in the wrong source kind can't dodge the fence. (A
        // const number is forbidden by validation; booleans/null carry no claim.)
        if (typeof node.value === 'string') proseLeaves.push({ path, value: node.value });
        return node.value;
      case 'omit':
        return OMIT;
      case 'derived': {
        const v = ctx.resolveDerived(node.key, scope);
        // A derived STRING could be a trusted date/label OR — via a key path into
        // model substructure — model-distilled prose. Scan it (date/sha tokens are
        // exempted in numbersInProse), so a number can't reach the artifact through
        // `derived` unchecked. Numbers/booleans are walked by the fence directly.
        if (typeof v === 'string') proseLeaves.push({ path, value: v });
        return v;
      }
      case 'derivedTree':
        // A trusted derived NUMERIC sub-structure (a map/array). The fact-fence
        // re-walks its numbers; string leaves are forbidden by resolveDerivedTree.
        return ctx.resolveDerivedTree(node.key, scope);
      case 'model': {
        const s = ctx.resolveModel(node.key, scope);
        proseLeaves.push({ path, value: s });
        return s;
      }
      case 'freetext':
        proseLeaves.push({ path, value: node.value });
        return node.value;
      default:
        throw new Error(`site: unknown source kind ${JSON.stringify(node.source)} at ${path || '<root>'}.`);
    }
  }
  if (node.type === 'object') {
    const out = {};
    for (const key of Object.keys(node.props)) {
      const childPath = path ? `${path}.${key}` : key;
      const v = renderNode(node.props[key], ctx, scope, childPath, proseLeaves);
      if (v !== OMIT) out[key] = v;
    }
    return out;
  }
  if (node.type === 'array') {
    const arr = ctx.collection(node.over, scope);
    return arr.map((el, i) => renderNode(node.item, ctx, el, `${path}[${i}]`, proseLeaves));
  }
  throw new Error(`site: malformed adapter node at ${path || '<root>'}.`);
}

/**
 * renderSite(siteModel, adapter) -> artifact object
 *
 * Validates the adapter grammar, resolves the tree against the verified model,
 * then runs the fact-fence. Throws FactFenceError on an unverifiable number (the
 * build maps that to exit 2). `siteModel` must already carry the derived sections
 * the adapter references (provenance/chart/sessions/group metrics).
 */
export function renderSite(siteModel, adapter) {
  const { ok, problems } = validateAdapter(adapter);
  if (!ok) {
    const p = problems[0];
    throw new Error(`site: invalid adapter (${problems.length} problem(s)); first at ${p.path || '<root>'}: ${p.reason}`);
  }
  const ctx = buildValueContext(siteModel);
  const proseLeaves = [];
  const artifact = renderNode(adapter.tree, ctx, undefined, '', proseLeaves);
  factFence(artifact, ctx.verifiedNumbers, proseLeaves);
  return artifact;
}

export { FactFenceError };
