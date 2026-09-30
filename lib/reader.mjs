// lib/reader.mjs — reader profiles for the client report (docs/reader-profiles.md).
//
// A reader profile decides, for one reader, which parts of a report are shown, in
// what order, and what extra sections gather items for them. It never touches an
// item: every view of a report is built from the same verified items, with the same
// badges and numbers. Profiles stack: the shipped default, then any shipped reader
// types a profile `extends` (lib/readers/*.json), then the personal file
// honestweek.reader.json kept beside the report.
//
// Profiles are data, not code: a strict JSON shape, validated here, with no
// executable content. Anything this module can't vouch for fails closed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const READER_FILE = 'honestweek.reader.json';
const SHIPPED_DIR = fileURLToPath(new URL('./readers/', import.meta.url));

/** Sections every report knows how to render. `record` and `how` can never be left
 *  out: every view keeps the full record and says how it was made. */
export const BUILTIN_SECTIONS = ['highlights', 'needs-you', 'activity', 'done', 'not-finished', 'next', 'record', 'how'];
const REQUIRED_SECTIONS = ['record', 'how'];
/** Where a line of a profile came from. `shipped` is reserved for honestweek's own add-ons. */
export const SOURCE_KINDS = ['their-words', 'your-notes', 'guess'];
const TOP_KEYS = new Set(['name', 'about', 'reader', 'extends', 'order', 'sections', 'exclude', 'format', 'guidance']);

export class ReaderProfileError extends Error {}

function fail(where, msg) {
  throw new ReaderProfileError(`${where}: ${msg}`);
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkSource(src, where, { shipped }) {
  if (!isObj(src)) fail(where, 'needs a "source": { "kind": ..., "ref": ... } saying where it came from.');
  const kinds = shipped ? ['shipped'] : SOURCE_KINDS;
  if (!kinds.includes(src.kind)) fail(where, `"source.kind" must be one of ${JSON.stringify(kinds)}.`);
  if (src.kind !== 'guess' && src.kind !== 'shipped' && (typeof src.ref !== 'string' || !src.ref.trim())) {
    fail(where, `a "${src.kind}" source needs a "ref" (where it was said or written down).`);
  }
  return { kind: src.kind, ...(src.ref ? { ref: String(src.ref) } : {}) };
}

/** Validate one profile layer and return its normalized form. */
export function normalizeLayer(raw, where, { shipped = false } = {}) {
  if (!isObj(raw)) fail(where, 'must be a JSON object.');
  for (const key of Object.keys(raw)) {
    if (key === 'done') fail(where, '"done" can\'t be redefined: honestweek can only see what reached the main branch, so "done" means merged.');
    if (!TOP_KEYS.has(key)) fail(where, `unknown key ${JSON.stringify(key)}. A profile is data; allowed keys are ${[...TOP_KEYS].join(', ')}.`);
  }
  const layer = { where, extends: [], order: null, sections: [], exclude: { themes: [] }, format: {}, guidance: [] };
  if (raw.extends !== undefined) {
    if (!Array.isArray(raw.extends) || raw.extends.some((n) => typeof n !== 'string' || !/^[a-z][a-z0-9-]*$/.test(n))) fail(where, '"extends" must be a list of shipped reader types, like ["client"].');
    layer.extends = raw.extends.slice();
  }
  const sectionIds = new Set();
  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections)) fail(where, '"sections" must be a list.');
    for (const [i, s] of raw.sections.entries()) {
      const at = `${where} sections[${i}]`;
      if (!isObj(s)) fail(at, 'must be an object.');
      if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(s.id)) fail(at, '"id" must be lowercase letters, digits and dashes.');
      if (BUILTIN_SECTIONS.includes(s.id)) fail(at, `"${s.id}" is a built-in section; give an extra section its own id.`);
      if (typeof s.title !== 'string' || !s.title.trim()) fail(at, 'needs a "title".');
      const sel = s.select;
      const byIssues = isObj(sel) && Array.isArray(sel.issues) && sel.issues.length && sel.issues.every((n) => Number.isInteger(n) && n > 0);
      const byTags = isObj(sel) && Array.isArray(sel.tags) && sel.tags.length && sel.tags.every((t) => typeof t === 'string' && t.trim());
      if (!isObj(sel) || byIssues === byTags) fail(at, '"select" must be exactly one of { "issues": [numbers] } (picked by git) or { "tags": [names] } (picked by hand).');
      sectionIds.add(s.id);
      layer.sections.push({
        id: s.id,
        title: s.title.trim(),
        summary: typeof s.summary === 'string' ? s.summary : '',
        select: byIssues ? { issues: sel.issues.slice() } : { tags: sel.tags.map(String) },
        source: checkSource(s.source, at, { shipped }),
      });
    }
  }
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order) || raw.order.some((id) => typeof id !== 'string')) fail(where, '"order" must be a list of section ids.');
    layer.order = raw.order.slice();
  }
  if (raw.exclude !== undefined) {
    if (!isObj(raw.exclude) || Object.keys(raw.exclude).some((k) => k !== 'themes')) fail(where, '"exclude" may only name { "themes": [...] }.');
    const themes = raw.exclude.themes ?? [];
    if (!Array.isArray(themes) || themes.some((t) => typeof t !== 'string')) fail(where, '"exclude.themes" must be a list of theme ids.');
    layer.exclude.themes = themes.slice();
  }
  if (raw.format !== undefined) {
    if (!isObj(raw.format) || Object.keys(raw.format).some((k) => k !== 'note')) fail(where, '"format" may only set { "note": true } for now.');
    if (raw.format.note !== undefined && typeof raw.format.note !== 'boolean') fail(where, '"format.note" must be true or false.');
    layer.format = { ...raw.format };
  }
  if (raw.guidance !== undefined) {
    if (!Array.isArray(raw.guidance)) fail(where, '"guidance" must be a list.');
    for (const [i, g] of raw.guidance.entries()) {
      const at = `${where} guidance[${i}]`;
      if (!isObj(g) || typeof g.text !== 'string' || !g.text.trim()) fail(at, 'needs a "text".');
      layer.guidance.push({ text: g.text.trim(), source: checkSource(g.source, at, { shipped }) });
    }
  }
  return layer;
}

function loadShipped(name, where) {
  const file = join(SHIPPED_DIR, `${name}.json`);
  if (!existsSync(file)) fail(where, `extends ${JSON.stringify(name)}, which isn't a reader type honestweek ships.`);
  return normalizeLayer(JSON.parse(readFileSync(file, 'utf8')), `reader type "${name}"`, { shipped: true });
}

/**
 * resolveProfile(layers) -> the effective profile.
 * Later layers win on order and format; sections with the same id are replaced;
 * exclusions and guidance add up. `record` and `how` are always kept, at the end if
 * a layer's order leaves them out.
 */
export function resolveProfile(layers) {
  const sections = new Map();
  let order = null;
  const exclude = new Set();
  const format = {};
  const guidance = [];
  for (const layer of layers) {
    for (const s of layer.sections) sections.set(s.id, s);
    if (layer.order) order = layer.order;
    for (const t of layer.exclude.themes) exclude.add(t);
    Object.assign(format, layer.format);
    guidance.push(...layer.guidance);
  }
  const known = new Set([...BUILTIN_SECTIONS, ...sections.keys()]);
  const finalOrder = [];
  for (const id of order ?? BUILTIN_SECTIONS) {
    if (!known.has(id)) throw new ReaderProfileError(`reader profile: "order" names ${JSON.stringify(id)}, which is neither a built-in section nor one the profile defines.`);
    if (!finalOrder.includes(id)) finalOrder.push(id);
  }
  for (const id of sections.keys()) if (!finalOrder.includes(id)) finalOrder.unshift(id);
  for (const id of REQUIRED_SECTIONS) if (!finalOrder.includes(id)) finalOrder.push(id);
  const personal = layers.filter((l) => !l.shipped);
  const personalSources = personal.flatMap((l) => [...l.sections.map((s) => s.source), ...l.guidance.map((g) => g.source)]);
  return {
    layers: layers.map((l) => l.where),
    order: finalOrder,
    sections: [...sections.values()],
    exclude: { themes: [...exclude] },
    format: { note: format.note === true },
    guidance,
    // A personal profile with something in it, all of it guessed, is unconfirmed.
    unconfirmed: personalSources.length > 0 && personalSources.every((s) => s.kind === 'guess'),
  };
}

/**
 * loadReaderProfile(cwd, { mode }) -> the effective profile for a client report.
 * Without a honestweek.reader.json the client report uses default + client: the
 * layout the client report always had, plus a "needs you" section when the items
 * file lists needs and a "not finished" list when some work isn't merged.
 */
export function loadReaderProfile(cwd) {
  const layers = [{ ...loadShipped('default', 'reader type "default"'), shipped: true }];
  const file = join(cwd, READER_FILE);
  let personal = null;
  if (existsSync(file)) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ReaderProfileError(`${READER_FILE} is not valid JSON (${err.message}).`);
    }
    personal = normalizeLayer(raw, READER_FILE);
  }
  const types = personal ? personal.extends : ['client'];
  for (const name of types) {
    if (name === 'default') continue;
    layers.push({ ...loadShipped(name, personal ? READER_FILE : 'client report'), shipped: true });
  }
  if (personal) layers.push({ ...personal, shipped: false });
  return resolveProfile(layers);
}
