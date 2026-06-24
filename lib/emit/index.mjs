// lib/emit/index.mjs — the emitter dispatcher.
//
// emit(reportModel, config) selects an emitter by config.output.mode, renders
// the artifact, and writes it to config.output.file (or the mode's documented
// default). Returns a small result describing what was written. It performs the
// SINGLE local file write; it does NOT print to stdout and NEVER performs any
// network, git-push, gist, or publish action. All output is local — the user
// publishes it themselves.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

import { OUTPUT_MODES, DEFAULT_OUTPUT_FILES } from '../config.mjs';
import * as post from './post.mjs';
import * as changelog from './changelog.mjs';
import * as digest from './digest.mjs';
import * as report from './report.mjs';

const EMITTERS = { post, changelog, digest, report };

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
 * emit(reportModel, config) -> { path, mode, bytes, items }
 * Dispatches strictly by config.output.mode and writes one local file.
 */
export function emit(reportModel, config) {
  const mode = config?.output?.mode ?? 'digest';
  if (!OUTPUT_MODES.includes(mode)) {
    throw new Error(`emit: unknown output mode ${JSON.stringify(mode)}; valid modes are ${JSON.stringify(OUTPUT_MODES)}.`);
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
