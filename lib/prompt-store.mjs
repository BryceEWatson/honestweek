import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomic-json.mjs';
import { sha256 } from './prompt-identity.mjs';
import { DETECTOR_ORDER, REPLACEABLE_DETECTORS } from './prompt-privacy.mjs';

export const PROMPT_STORE = 'honestweek.prompts.json';
export const PROMPT_LANE = 'honestweek.prompt-items.json';
export const PROMPT_LOCK = `${PROMPT_STORE}.lock`;
export const PROMPT_GITIGNORE = Object.freeze([
  PROMPT_STORE,
  `${PROMPT_STORE}.tmp-*`,
  PROMPT_LOCK,
  PROMPT_LANE,
  `${PROMPT_LANE}.tmp-*`,
]);
const HEX = /^[0-9a-f]{64}$/;
const PROMPT_KEYS = ['ref','refCanonical','source','sessionKey','turn','timestamp','repoKey','project','isPrivate','state','sourceHash','contentHash','text','redactionCount','sourceLength','changedPercent','rawRisk','rawDetectors','redactionOps','truncated','followOnCorrection','observedVerification'];
const TOMBSTONE_V1_KEYS = ['ref','refCanonical','source','sessionKey','turn','deletedAt'];
const TOMBSTONE_V2_KEYS = [...TOMBSTONE_V1_KEYS, 'week'];
const SOURCE_KEYS = ['state','weekStart','weekEnd','syncedAt','records','malformedLines'];
const OP_KEYS = ['detector','start','end','placeholder'];
const PLACEHOLDERS = new Set(['[redacted:term]','[redacted:email]','[redacted:path]','[redacted:secret]','[redacted:account]']);

function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const got = Object.keys(value).sort(); const want = [...keys].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name} has unknown or missing keys.`);
}

export function validatePromptIdentity(p, name = 'prompt') {
  if (!HEX.test(p.ref) || !HEX.test(p.sessionKey)) throw new Error(`${name} has an invalid hash.`);
  if (!['claude-code','codex'].includes(p.source) || !Number.isInteger(p.turn) || p.turn < 1) throw new Error(`${name} has invalid source identity.`);
  const canonical = `${p.source}\0${p.sessionKey}\0${p.turn}`;
  if (p.refCanonical !== canonical || sha256(canonical) !== p.ref) throw new Error(`${name} has a canonical identity mismatch.`);
}

export function validatePromptStore(store) {
  exact(store, ['version','generatedAt','sourceStatus','prompts','tombstones'], 'prompt store');
  if (![1,2].includes(store.version) || !Array.isArray(store.prompts) || !Array.isArray(store.tombstones)) throw new Error('prompt store has an unsupported schema.');
  exact(store.sourceStatus, ['claude-code','codex'], 'prompt store sourceStatus');
  for (const source of ['claude-code','codex']) {
    const s=store.sourceStatus[source];exact(s,SOURCE_KEYS,`sourceStatus.${source}`);
    if(!['present','absent','unreadable'].includes(s.state)||!Number.isInteger(s.records)||s.records<0||!Number.isInteger(s.malformedLines)||s.malformedLines<0)throw new Error(`sourceStatus.${source} is invalid.`);
  }
  const seen = new Set();
  for (const p of store.prompts) {
    exact(p,PROMPT_KEYS,'prompt');
    validatePromptIdentity(p); if (seen.has(p.ref)) throw new Error('prompt store has a duplicate ref.'); seen.add(p.ref);
    if (!['inbox','kept','hidden'].includes(p.state) || typeof p.text !== 'string' || !p.text.trim() || sha256(p.text) !== p.contentHash || !HEX.test(p.sourceHash)) throw new Error('prompt store has invalid prompt content/state.');
    if (!['low','medium','high'].includes(p.rawRisk)||!Array.isArray(p.rawDetectors)||!Array.isArray(p.redactionOps)||p.redactionCount!==p.redactionOps.length) throw new Error('prompt store has invalid privacy audit.');
    if(new Date(p.timestamp).toISOString()!==p.timestamp||[...p.text].length>4000||typeof p.isPrivate!=='boolean'||(p.isPrivate&&(p.repoKey!==null||p.project!==null))||(!p.isPrivate&&(!HEX.test(p.repoKey)||typeof p.project!=='string')))throw new Error('prompt store has invalid timestamp/project classification.');
    if(JSON.stringify(p.rawDetectors)!==JSON.stringify([...new Set(p.rawDetectors)].sort((a,b)=>DETECTOR_ORDER.indexOf(a)-DETECTOR_ORDER.indexOf(b)))||p.rawDetectors.some((x)=>!DETECTOR_ORDER.includes(x)))throw new Error('prompt store has invalid detector ordering.');
    let prior=0;for(const op of p.redactionOps){exact(op,OP_KEYS,'redaction operation');if(!REPLACEABLE_DETECTORS.includes(op.detector)||!Number.isInteger(op.start)||!Number.isInteger(op.end)||op.start<prior||op.end<=op.start||!PLACEHOLDERS.has(op.placeholder))throw new Error('prompt store has invalid redaction operation.');prior=op.end;}
  }
  for (const t of store.tombstones) {
    const hasWeek = Object.hasOwn(t, 'week');
    if (store.version === 1 && hasWeek) throw new Error('prompt store version 1 cannot contain a week-bound tombstone.');
    exact(t, hasWeek ? TOMBSTONE_V2_KEYS : TOMBSTONE_V1_KEYS, 'tombstone');
    validatePromptIdentity(t, 'tombstone');
    if (seen.has(t.ref)) throw new Error('prompt store ref appears live and deleted.');
    if(new Date(t.deletedAt).toISOString()!==t.deletedAt)throw new Error('tombstone has invalid deletedAt.');
    if (hasWeek && (!t.week || JSON.stringify(Object.keys(t.week).sort()) !== JSON.stringify(['end','start']) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(t.week.start) || !/^\d{4}-\d{2}-\d{2}$/.test(t.week.end) ||
        t.week.start > t.week.end)) throw new Error('tombstone has invalid source week.');
    seen.add(t.ref);
  }
  return store;
}

export function readPromptStore(cwd, { optional = false } = {}) {
  const path = join(cwd, PROMPT_STORE);
  if (!existsSync(path)) { if (optional) return null; throw new Error(`${PROMPT_STORE} not found; run honestweek prompts sync.`); }
  let value; try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${PROMPT_STORE} is not valid JSON (${e.message}).`); }
  return validatePromptStore(value);
}

export function mergePromptStore(oldStore, scanned, now = new Date()) {
  for(const source of ['claude-code','codex'])if(scanned.sourceStatus[source].state==='unreadable')throw new Error(`${source} source is unreadable; old store preserved.`);
  for(const source of ['claude-code','codex'])if(oldStore?.sourceStatus?.[source]?.state==='present'&&scanned.sourceStatus[source].state==='absent')throw new Error(`${source} source disappeared; old store preserved.`);
  const controls = new Map((oldStore?.prompts ?? []).map((p) => [p.ref, p]));
  const tombstones = [...(oldStore?.tombstones ?? [])]; const deleted = new Set(tombstones.map((x) => x.ref));
  const prompts = scanned.prompts.filter((p) => !deleted.has(p.ref)).map((p) => {
    const old = controls.get(p.ref);
    if (old && old.sourceHash !== p.sourceHash) throw new Error(`source changed for prompt ${p.ref.slice(0,12)}; old store preserved.`);
    const { _residualRisk, ...persisted } = p;
    return { ...persisted, state: old?.state ?? 'inbox' };
  });
  prompts.sort((a,b) => `${a.timestamp}|${a.source}|${a.sessionKey}|${a.turn}|${a.ref}`.localeCompare(`${b.timestamp}|${b.source}|${b.sessionKey}|${b.turn}|${b.ref}`));
  return validatePromptStore({ version: oldStore?.version ?? 1, generatedAt: now.toISOString(), sourceStatus: scanned.sourceStatus, prompts, tombstones: tombstones.sort((a,b) => a.ref.localeCompare(b.ref)) });
}

export function writePromptStore(cwd, store, fs) {
  const text = `${JSON.stringify(validatePromptStore(store), null, 2)}\n`;
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('prompt store exceeds the 8 MiB cap; no text was dropped.');
  atomicWriteJson(join(cwd, PROMPT_STORE), store, fs);
}

export function uniquePrompt(store, prefix) {
  if (typeof prefix !== 'string' || prefix.length < 12 || !/^[0-9a-f]+$/.test(prefix)) throw new Error('ref prefix must be at least 12 lowercase hex characters.');
  const found = store.prompts.filter((p) => p.ref.startsWith(prefix));
  if (found.length !== 1) throw new Error(found.length ? 'ref prefix is ambiguous.' : 'no live prompt matches that ref prefix.');
  return found[0];
}
