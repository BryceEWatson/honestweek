// lib/emit/index.mjs — the emitter dispatcher.
//
// emit(reportModel, config) selects an emitter by config.output.mode, renders
// the artifact, and writes it to config.output.file (or the mode's documented
// default). Returns a small result describing what was written. It performs the
// SINGLE local file write; it does NOT print to stdout and NEVER performs any
// network, git-push, gist, or publish action. All output is local — the user
// publishes it themselves.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';

import { OUTPUT_MODES, DEFAULT_OUTPUT_FILES } from '../config.mjs';
import { renderSite } from '../site/emit-site.mjs';
import { loadTransformAdapter, renderSiteViaTransform } from '../site/transform.mjs';
import * as post from './post.mjs';
import * as changelog from './changelog.mjs';
import * as digest from './digest.mjs';
import * as report from './report.mjs';

const EMITTERS = { post, changelog, digest, report };

/** The number of items rendered by a report model (loose + grouped). */
function countItems(reportModel) {
  return (
    (Array.isArray(reportModel?.items) ? reportModel.items.length : 0) +
    (Array.isArray(reportModel?.groups)
      ? reportModel.groups.reduce((n, g) => n + (Array.isArray(g.items) ? g.items.length : 0), 0)
      : 0)
  );
}

/**
 * emitSite(reportModel, config, { cwd }, ctx) -> { path, mode, bytes, items }  (async)
 *
 * Resolves the committed site adapter against the verified, redacted, derived
 * bundle and writes the JSON artifact. Two adapter styles, by file extension:
 *   - `.json` (static): renderSite maps the closed grammar + runs the full
 *     fact-fence (numeric leaves + prose).
 *   - `.mjs`/`.js`/`.cjs` (transform): a committed `transform(model, ctx)` shapes
 *     the bundle; renderSiteViaTransform re-walks every NUMBER against the verified
 *     set. (`ctx` carries `now` for clock fields.)
 * Either way an unverifiable number throws FactFenceError (build -> exit 2). Local
 * write only — the target's existing PR flow is the publish gate.
 */
export async function emitSite(reportModel, config, { cwd = process.cwd() } = {}, ctx = {}) {
  const adapterPath = config?.output?.adapter;
  if (!adapterPath) {
    throw new Error('emit: site mode requires output.adapter (path to the committed site adapter).');
  }

  let artifact;
  let outRel;
  if (/\.(mjs|cjs|js)$/.test(adapterPath)) {
    const { transform, artifact: rel } = await loadTransformAdapter(adapterPath);
    artifact = renderSiteViaTransform(transform, reportModel, ctx);
    outRel = rel;
  } else {
    let adapter;
    try {
      adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
    } catch (err) {
      throw new Error(`emit: cannot read site adapter at ${adapterPath} (${err?.message ?? err}).`);
    }
    artifact = renderSite(reportModel, adapter); // validates + fact-fences (may throw)
    outRel = adapter.artifact;
  }

  const outPath = isAbsolute(outRel) ? outRel : join(cwd, outRel);
  const content = JSON.stringify(artifact, null, 2) + '\n';
  // The artifact may live in a not-yet-created data dir (e.g. "src/data/x.json" on
  // a fresh checkout). Create its parent like archive.mjs does, so the write never
  // ENOENTs after the model already passed the fence.
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
  return { path: outPath, mode: 'site', bytes: Buffer.byteLength(content, 'utf8'), items: countItems(artifact) };
}

/** Pure render for a given mode — returns the artifact (or, for changelog, the
 *  managed block). Exposed for testing without touching the filesystem. */
export function renderFor(mode, reportModel, config) {
  const emitter = EMITTERS[mode];
  if (!emitter) {
    throw new Error(`emit: unknown output mode ${JSON.stringify(mode)}; valid modes are ${JSON.stringify(OUTPUT_MODES)}.`);
  }
  return emitter.render(reportModel, config);
}

/**
 * emit(reportModel, config, { cwd }) -> { path, mode, bytes, items }
 * Dispatches strictly by config.output.mode and writes one local file. `cwd` (the
 * target root) is used only by the site mode to resolve the adapter's artifact path.
 */
export function emit(reportModel, config, { cwd = process.cwd() } = {}) {
  const mode = config?.output?.mode ?? 'digest';
  if (!OUTPUT_MODES.includes(mode)) {
    throw new Error(`emit: unknown output mode ${JSON.stringify(mode)}; valid modes are ${JSON.stringify(OUTPUT_MODES)}.`);
  }
  if (mode === 'site') {
    // site emit is async (a transform adapter is dynamically imported); the build
    // calls emitSite directly. Guard so a stray emit('site') fails loud, not silent.
    throw new Error('emit: site mode must be emitted via emitSite (async), not emit.');
  }

  const file = config?.output?.file || DEFAULT_OUTPUT_FILES[mode];
  if (!file) {
    throw new Error(`emit: no output file configured for mode ${JSON.stringify(mode)} and no default available.`);
  }

  let content;
  if (mode === 'changelog') {
    const block = changelog.render(reportModel, config);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    content = changelog.mergeIntoChangelog(existing, block, reportModel.week);
  } else {
    content = renderFor(mode, reportModel, config);
  }

  writeFileSync(file, content);

  const itemCount =
    (Array.isArray(reportModel?.items) ? reportModel.items.length : 0) +
    (Array.isArray(reportModel?.groups)
      ? reportModel.groups.reduce((n, g) => n + (Array.isArray(g.items) ? g.items.length : 0), 0)
      : 0);

  return { path: file, mode, bytes: Buffer.byteLength(content, 'utf8'), items: itemCount };
}
