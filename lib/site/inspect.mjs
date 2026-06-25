// lib/site/inspect.mjs — infer an artifact's SCHEMA from its real sample bytes.
//
// To author an adapter for a target site, the intelligent step needs the artifact's
// ACTUAL shape — every key the live JSON carries. A hand-written TypeScript type is
// the wrong source: it drifts, and routinely omits keys the real data has. So this
// module infers the schema from the SAMPLE BYTES of the real artifact instead.
//
// Privacy: the schema is STRUCTURE ONLY — types, key names, array element shapes,
// and coarse string-format hints. It NEVER echoes a scalar VALUE (a count, a date,
// a prose string), so inspecting an artifact cannot leak its contents. Across an
// array it MERGES element shapes (union of keys) so an optional key is not missed,
// and flags a "dynamic-keyed" object (a map whose keys are data, like a
// per-category count) so the adapter author reaches for `derivedTree`, not fixed
// `props`.
//
// Zero runtime dependencies: Node built-ins only.

const MAX_DEPTH = 12;

/** Coarse, value-free format hint for a string (never the string itself). */
function stringFormat(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return 'datetime';
  if (/^[0-9a-f]{7,40}$/i.test(s)) return 'hex';
  if (/^https?:\/\//.test(s)) return 'url';
  return 'text';
}

/** Merge two inferred schemas describing different samples of the same slot. */
function mergeSchema(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type !== b.type) return { type: 'union', of: dedupeTypes([a, b]) };
  if (a.type === 'object') {
    const keys = {};
    const allKeys = new Set([...Object.keys(a.keys), ...Object.keys(b.keys)]);
    for (const k of allKeys) keys[k] = mergeSchema(a.keys[k], b.keys[k]);
    const optional = new Set([
      ...(a.optional || []),
      ...(b.optional || []),
      ...[...allKeys].filter((k) => !(k in a.keys) || !(k in b.keys)),
    ]);
    return { type: 'object', keys, optional: [...optional].sort(), dynamicKeyed: a.dynamicKeyed || b.dynamicKeyed };
  }
  if (a.type === 'array') return { type: 'array', items: mergeSchema(a.items, b.items) };
  if (a.type === 'string') return { type: 'string', format: a.format === b.format ? a.format : 'text' };
  return a;
}

function dedupeTypes(list) {
  const seen = new Map();
  for (const s of list) if (!seen.has(s.type)) seen.set(s.type, s);
  return [...seen.values()];
}

/** Is an object a "dynamic-keyed" map — many keys, all values the same primitive
 *  type? Those are the maps the adapter must emit via derivedTree, not fixed props. */
function looksDynamicKeyed(obj) {
  const keys = Object.keys(obj);
  if (keys.length < 2) return false;
  const types = new Set(keys.map((k) => (obj[k] === null ? 'null' : typeof obj[k])));
  return types.size === 1 && (types.has('number') || types.has('string') || types.has('boolean'));
}

function inferValue(value, depth) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    let items = null;
    if (depth < MAX_DEPTH) for (const el of value) items = mergeSchema(items, inferValue(el, depth + 1));
    return { type: 'array', length: value.length, items: items || { type: 'unknown' } };
  }
  const t = typeof value;
  if (t === 'object') {
    const keys = {};
    if (depth < MAX_DEPTH) for (const k of Object.keys(value)) keys[k] = inferValue(value[k], depth + 1);
    const schema = { type: 'object', keys, optional: [] };
    if (looksDynamicKeyed(value)) schema.dynamicKeyed = true;
    return schema;
  }
  if (t === 'string') return { type: 'string', format: stringFormat(value) };
  if (t === 'number') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  return { type: 'unknown' };
}

/**
 * inferSchema(sampleBytes) -> schema
 *
 * `sampleBytes` is a string (or Buffer) of the real artifact's JSON. Returns a
 * value-free structural schema: { type, keys, items, length, format, optional,
 * dynamicKeyed }. Throws on non-JSON input (a clear, value-free message).
 */
export function inferSchema(sampleBytes) {
  const text = Buffer.isBuffer(sampleBytes) ? sampleBytes.toString('utf8') : String(sampleBytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`site: cannot infer schema — sample is not valid JSON (${err.message}).`);
  }
  return inferValue(parsed, 0);
}
