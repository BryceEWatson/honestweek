// Load either the established JSON site adapter or a target-owned transform adapter.

import { readFileSync } from 'node:fs';

import { loadTransformAdapter } from './transform.mjs';
import { validateAdapter } from './adapter.mjs';

export async function loadSiteAdapter(path) {
  if (/\.(?:mjs|cjs|js)$/.test(path)) {
    const loaded = await loadTransformAdapter(path);
    return { kind: 'transform', ...loaded };
  }

  let adapter;
  try {
    adapter = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read site adapter at ${path} (${err?.message ?? err}).`);
  }

  if (typeof adapter?.artifact !== 'string' || !adapter.artifact) {
    throw new Error(`site adapter at ${path} has no artifact path.`);
  }
  const checked = validateAdapter(adapter);
  if (!checked.ok) {
    throw new Error(`site adapter at ${path} is invalid (${checked.problems[0].path}: ${checked.problems[0].reason}).`);
  }

  return { kind: 'static', adapter, artifact: adapter.artifact };
}
