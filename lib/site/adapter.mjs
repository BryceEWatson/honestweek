// lib/site/adapter.mjs — the site-integration ADAPTER spec: grammar + validator.
//
// The adapter is how a target website tells honestweek how to shape its verified
// report model into that site's own data artifact (the JSON a page imports). It
// is authored by the intelligent integration step (the skill, by inspecting the
// site) and COMMITTED IN THE TARGET REPO, human-reviewed. honestweek's code stays
// clean-room: it knows the generic GRAMMAR below, never any one site's field names.
//
// The grammar's whole job is to keep the model OFF the value path. Each field is
// filled by one of a CLOSED set of source kinds, and none lets the model author a
// number into a claim:
//   const       — a literal NON-numeric constant (labels, colours, static copy). A
//                 const numeric VALUE is rejected here; a const STRING is allowed
//                 but its numerals are prose-scanned by the fence at emit (so an
//                 authored quantity can't slip in via the wrong source kind).
//   derived     — a SCALAR value from honestweek's generic derived registry
//                 (a count, date, or metric) — re-derived from git/sessions. A
//                 derived STRING (a date/label, or model text reached by key path)
//                 is also prose-scanned at emit; date/sha tokens are exempted.
//   derivedTree — a whole derived NUMERIC sub-structure embedded wholesale (a
//                 dynamic-keyed count map or number array the scalar grammar can't
//                 express, e.g. a per-category count map whose keys vary by data).
//                 The model only NAMES the derived key; it cannot supply the
//                 contents, and the fact-fence re-walks every number inside. STRING
//                 leaves are forbidden (they would dodge the prose-number check) —
//                 emit any text via `model`/`const`/`freetext` instead. Object KEYS
//                 may be trusted string labels (they are not claim leaves).
//   model       — a model-distilled STRING already in the verified model (item text).
//   freetext    — authored prose; every numeral in it must trace to a derived value
//                 (enforced by the fact-fence at emit, not here).
//   omit        — the field is intentionally absent.
// A numeric literal is illegal everywhere (const forbids it; the fact-fence is the
// backstop). There is no source kind by which a raw number becomes a claim value:
// even derivedTree resolves a key into the TRUSTED derived registry, never a literal.
//
// validateAdapter is PURE: it collects problems and NEVER throws or exits, mirroring
// validateItems. The emitter owns resolve-or-throw at render time.
//
// Zero runtime dependencies: Node built-ins only.

/** The closed set of leaf source kinds. */
export const SOURCE_KINDS = ['const', 'derived', 'derivedTree', 'model', 'freetext', 'omit'];

/** The non-leaf node types. */
export const NODE_TYPES = ['object', 'array'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True iff `node` is a leaf directive (carries a `source`) rather than a container. */
export function isDirective(node) {
  return isPlainObject(node) && typeof node.source === 'string';
}

/** Validate one leaf directive at `path`; push any problems. */
function validateDirective(node, path, problems) {
  const at = (reason) => problems.push({ path, reason });

  if (!SOURCE_KINDS.includes(node.source)) {
    at(`unknown source kind ${JSON.stringify(node.source)} (must be one of ${JSON.stringify(SOURCE_KINDS)}).`);
    return;
  }

  switch (node.source) {
    case 'const': {
      if (!('value' in node)) {
        at('const directive must carry a "value".');
        break;
      }
      const t = typeof node.value;
      if (t === 'number') {
        at('const "value" must not be numeric — a number is a claim and must come from a derived source (the fact-fence rejects literal numbers).');
      } else if (!(t === 'string' || t === 'boolean' || node.value === null)) {
        at('const "value" must be a string, boolean, or null (no numbers, objects, or arrays).');
      }
      break;
    }
    case 'freetext': {
      if (typeof node.value !== 'string') {
        at('freetext directive must carry a string "value".');
      }
      // Numerals inside freetext are checked by the fact-fence at emit, not here.
      break;
    }
    case 'derived':
    case 'derivedTree':
    case 'model': {
      if (typeof node.key !== 'string' || node.key.trim() === '') {
        at(`${node.source} directive must carry a non-empty "key".`);
      }
      if ('value' in node) {
        at(`${node.source} directive must NOT carry a literal "value" — it resolves "key" against the verified model.`);
      }
      break;
    }
    case 'omit':
    default:
      break;
  }
}

/** Recursively validate a tree node at `path`; push any problems. */
function validateNode(node, path, problems) {
  if (isDirective(node)) {
    validateDirective(node, path, problems);
    return;
  }
  if (!isPlainObject(node)) {
    problems.push({ path, reason: 'node must be a directive (with "source") or a container (type "object"|"array").' });
    return;
  }
  if (!NODE_TYPES.includes(node.type)) {
    problems.push({ path, reason: `container node must declare type ${JSON.stringify(NODE_TYPES)} (got ${JSON.stringify(node.type)}).` });
    return;
  }
  if (node.type === 'object') {
    if (!isPlainObject(node.props)) {
      problems.push({ path, reason: 'object node must carry a "props" object.' });
      return;
    }
    for (const key of Object.keys(node.props)) {
      validateNode(node.props[key], path ? `${path}.${key}` : key, problems);
    }
    return;
  }
  // array
  if (typeof node.over !== 'string' || node.over.trim() === '') {
    problems.push({ path, reason: 'array node must carry a non-empty "over" (the derived collection key).' });
  }
  if (!('item' in node)) {
    problems.push({ path, reason: 'array node must carry an "item" node template.' });
    return;
  }
  validateNode(node.item, `${path}[]`, problems);
}

/**
 * validateAdapter(spec) -> { ok, problems }
 *
 * Pure structural + grammar validation of an adapter spec. NEVER throws or exits;
 * collects { path, reason } problems. It validates the GRAMMAR only — it does not
 * (and must not) know any target site's field names.
 */
export function validateAdapter(spec) {
  const problems = [];

  if (!isPlainObject(spec)) {
    return { ok: false, problems: [{ path: '', reason: 'adapter spec must be a JSON object.' }] };
  }
  if (typeof spec.artifact !== 'string' || spec.artifact.trim() === '') {
    problems.push({ path: 'artifact', reason: 'required: the artifact path (a non-empty string) relative to the target root.' });
  }
  for (const listField of ['clockFields', 'volatileFields']) {
    if (spec[listField] !== undefined) {
      if (!Array.isArray(spec[listField]) || spec[listField].some((f) => typeof f !== 'string')) {
        problems.push({ path: listField, reason: `must be an array of field-path strings when present.` });
      }
    }
  }
  if (!('tree' in spec)) {
    problems.push({ path: 'tree', reason: 'required: the artifact tree (a node).' });
  } else {
    validateNode(spec.tree, 'tree', problems);
  }

  return { ok: problems.length === 0, problems };
}
