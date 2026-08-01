import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import { localDateInTimezone, localDateRangeInstants, resolveWeek } from './resolve-week.mjs';
import { resolvePromptRoots, scanPromptSources } from './prompt-adapters.mjs';
import { mergePromptStore, PROMPT_GITIGNORE, readPromptStore, writePromptStore } from './prompt-store.mjs';
import { scanDigestEvidence } from './digest-evidence.mjs';
import { curateDigest } from './digest-curation.mjs';
import { DIGEST_CATEGORIES, DIGEST_DECISIONS } from './digest-schema.mjs';
import {
  DIGEST_GITIGNORE, assertDigestPendingGeneration, assertRecoverableDigestPending, currentDigestHashes,
  assertNoDigestPending, makeDigestPending, readDigestPending, removeDigestPending,
  readDigestReview, validateDigestLane, validateDigestReview,
  writeDigestLane, writeDigestPending, writeDigestReview,
} from './digest-store.mjs';
import { preflightPromptOutput, loadValidatedPromptLane } from './prompt-lane.mjs';
import { withPromptLock } from './prompt-lock.mjs';
import { ensureGitignore } from './init.mjs';
import { digestItemIdentity, sha256 } from './prompt-identity.mjs';

function defaultIo() {
  return { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), exit: (code) => process.exit(code) };
}
function flag(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
function weekFor(config, argv, now) {
  const today = localDateInTimezone(now, config.week.timezone);
  const value = resolveWeek({ today, weekArg: flag(argv, '--week') });
  const start = value.weekStart.toISOString().slice(0, 10);
  const end = value.weekEnd.toISOString().slice(0, 10);
  const range = localDateRangeInstants(start, end, config.week.timezone);
  return { start, end, weekStart: range.start, weekEndExclusive: range.endExclusive };
}
function jsonHash(value) { return sha256(`${JSON.stringify(value, null, 2)}\n`); }
function readPriorControlReview(cwd) {
  const path = join(cwd, 'honestweek.curated.json');
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`honestweek.curated.json is not valid JSON (${error.message}).`); }
  if (![1,2].includes(value?.version) || !value.week || !/^\d{4}-\d{2}-\d{2}$/.test(value.week.start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.week.end) || !Array.isArray(value.candidates) ||
      (value.version === 2 && !Array.isArray(value.tombstones))) throw new Error('digest review control state is invalid.');
  for (const candidate of value.candidates) {
    if (!/^[0-9a-f]{64}$/.test(candidate?.itemRef) || !DIGEST_CATEGORIES.includes(candidate.category) ||
        !['inbox','kept','hidden'].includes(candidate.state) || !Array.isArray(candidate.evidenceRefs) ||
        candidate.evidenceRefs.length === 0 || candidate.evidenceRefs.some((ref) => !/^[0-9a-f]{64}$/.test(ref)) ||
        !/^[0-9a-f]{64}$/.test(candidate.sourceHash) || !/^[0-9a-f]{64}$/.test(candidate.contentHash) ||
        digestItemIdentity(candidate.category, candidate.evidenceRefs, candidate.discriminator) !== candidate.itemRef) {
      throw new Error('digest review control state is invalid.');
    }
  }
  for (const tombstone of value.tombstones ?? []) {
    if (!tombstone || JSON.stringify(Object.keys(tombstone).sort()) !== JSON.stringify(['category','deletedAt','evidenceRefs','itemRef']) ||
        !/^[0-9a-f]{64}$/.test(tombstone.itemRef) || !DIGEST_CATEGORIES.includes(tombstone.category) ||
        !Array.isArray(tombstone.evidenceRefs) || tombstone.evidenceRefs.length === 0 ||
        tombstone.evidenceRefs.some((ref) => !/^[0-9a-f]{64}$/.test(ref)) ||
        Number.isNaN(new Date(tombstone.deletedAt).getTime())) throw new Error('digest review tombstone state is invalid.');
  }
  return value;
}
function prefixMap(values) {
  const unique = [...new Set(values)];
  return new Map(unique.map((value) => {
    let size = 12;
    while (size < 64 && unique.some((other) => other !== value && other.slice(0, size) === value.slice(0, size))) size += 1;
    return [value, value.slice(0, size)];
  }));
}
function nextPage(args, offset) {
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--offset') { i += 1; continue; }
    kept.push(args[i]);
  }
  return `honestweek digest candidates${kept.length ? ` ${kept.join(' ')}` : ''} --offset ${offset}`;
}

function positionalArgs(args, optionsWithValues) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (optionsWithValues.has(args[i])) { i += 1; continue; }
    if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

async function prepare({ cwd, config, args, now, roots, io, transactionFs = {}, priorReviewOverride, quiet = false }) {
  const pending = readDigestPending(cwd, { optional: true });
  if (pending) assertRecoverableDigestPending(cwd, pending);
  const outputBinding = await preflightPromptOutput({ cwd, config, hasGoals: existsSync(join(cwd, 'honestweek.objectives.json')) });
  if (pending) assertDigestPendingGeneration(pending, outputBinding);
  const week = weekFor(config, args, now);
  const scanned = await scanPromptSources({
    config, weekStart: week.weekStart, weekEnd: week.weekEndExclusive, roots, now,
  });
  if (Object.values(scanned.sourceStatus).every((status) => status.state === 'absent')) {
    throw new Error('no Claude Code or Codex digest source is available; no private or public digest file was changed.');
  }
  const oldStore = readPromptStore(cwd, { optional: true });
  const promptStore = mergePromptStore(oldStore, scanned, now);
  const evidence = await scanDigestEvidence({ config, promptStore, roots, sourceStatus: scanned.sourceStatus });
  const priorReview = priorReviewOverride === undefined && existsSync(join(cwd, 'honestweek.curated.json'))
    ? readPriorControlReview(cwd)
    : priorReviewOverride ?? null;
  const { review, lane } = curateDigest(promptStore, evidence, config, { start: week.start, end: week.end }, now, {
    outputBinding, priorReview,
  });
  validateDigestReview(review, config);
  validateDigestLane(lane, config);
  for (const entry of [...PROMPT_GITIGNORE, ...DIGEST_GITIGNORE]) ensureGitignore(cwd, entry);
  const prior = currentDigestHashes(cwd);
  const next = {
    promptStoreHash: jsonHash(promptStore), curatedHash: jsonHash(review), laneHash: jsonHash(lane),
  };
  const marker = makeDigestPending({ week: { start: week.start, end: week.end }, outputBinding, prior, next });
  try {
    writeDigestPending(cwd, marker, transactionFs.pending);
  } catch (error) {
    throw new Error(`digest transaction did not start because the pending marker write failed (${error.message}); no digest state was changed.`);
  }
  let phase = 'prompt store';
  try {
    writePromptStore(cwd, promptStore, transactionFs.promptStore);
    phase = 'private review';
    writeDigestReview(cwd, review, config, transactionFs.review);
    phase = 'public lane';
    writeDigestLane(cwd, lane, config, transactionFs.lane);
    phase = 'pending removal';
    removeDigestPending(cwd, transactionFs.remove);
  } catch (error) {
    throw new Error(`digest transaction remains pending after the ${phase} write failed (${error.message}); that state may have changed, so rerun honestweek digest prepare.`);
  }
  const omitted = DIGEST_CATEGORIES.map((category) => {
    const counts = lane.withheld.byCategory[category];
    return `${category}=${counts['category-capacity'] + counts['overall-capacity']}`;
  }).join(', ');
  const privacy = ['private-source','high-risk','needs-approval','public-renditions-disabled']
    .map((decision) => `${decision}=${lane.withheld.total[decision]}`).join(', ');
  if (!quiet) io.out(`digest prepare: selected ${lane.items.length}/${lane.policy.maxItems}; automatic floor ${lane.policy.automaticMinScore}; caps ${JSON.stringify(lane.policy.categoryCaps)}. Eligible omissions: ${omitted}. Privacy withheld: ${privacy}. Claude Code ${lane.sourceStatus['claude-code'].state}; Codex ${lane.sourceStatus.codex.state}. Selection favors explicit decisions, reversals, recurrence, and observed verification, not universal importance. Project handoffs are not mined in Slice 2.\n`);
  return 0;
}

async function loadCanonical({ cwd, config, args, now, roots }) {
  const week = weekFor(config, args, now);
  const loaded = await loadValidatedPromptLane({
    cwd, config, week: { start: week.start, end: week.end }, now, roots,
    hasGoals: existsSync(join(cwd, 'honestweek.objectives.json')),
  });
  if (loaded.lane?.version !== 2) throw new Error('balanced digest is not prepared; run honestweek digest prepare.');
  return { review: loaded.review, lane: loaded.lane, week };
}

function normalizeCategory(value) {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'next-steps') return 'nextSteps';
  if (!DIGEST_CATEGORIES.includes(value)) throw new Error(`category must be all or one of ${DIGEST_CATEGORIES.join(', ')}.`);
  return value;
}

async function candidates({ cwd, config, args, now, roots, io }) {
  const { review } = await loadCanonical({ cwd, config, args, now, roots });
  const category = normalizeCategory(flag(args, '--category'));
  const decision = flag(args, '--decision') ?? 'all';
  if (decision !== 'all' && !DIGEST_DECISIONS.includes(decision)) throw new Error(`decision must be all or one of ${DIGEST_DECISIONS.join(', ')}.`);
  const limit = Number(flag(args, '--limit') ?? 50); const offset = Number(flag(args, '--offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new Error('limit must be 1..200 and offset must be nonnegative.');
  const rows = review.candidates.filter((candidate) =>
    (category === 'all' || candidate.category === category) && (decision === 'all' || candidate.decision === decision));
  const itemPrefixes = prefixMap(review.candidates.map((candidate) => candidate.itemRef));
  const sessionPrefixes = prefixMap(review.candidates.flatMap((candidate) => candidate.receipts.map((value) => value.sessionKey)));
  const refPrefixes = prefixMap(review.candidates.flatMap((candidate) => candidate.receipts.map((value) => value.ref)));
  for (const candidate of rows.slice(offset, offset + limit)) {
    const receipts = candidate.receipts.map((value) =>
      `${value.source} session ${sessionPrefixes.get(value.sessionKey)} turn ${value.turn} ref ${refPrefixes.get(value.ref)}`).join('; ');
    const preview = candidate.privacy.decision === 'automatic-safe'
      ? [...candidate.text].slice(0, 120).join('')
      : '[preview withheld by privacy gate]';
    io.out(`${itemPrefixes.get(candidate.itemRef)}  ${candidate.category}  decision=${candidate.decision} score=${candidate.score} reason=${candidate.selectionReason}  ${preview} [${receipts}]\n`);
  }
  const shown = Math.min(limit, Math.max(0, rows.length - offset));
  const remaining = Math.max(0, rows.length - offset - shown);
  io.out(`digest candidates: showing ${shown ? offset + 1 : 0}-${shown ? offset + shown : 0} of ${rows.length}; remaining ${remaining}.${remaining ? ` Next: ${nextPage(args, offset + shown)}.` : ''}\n`);
  return 0;
}

async function explain({ cwd, config, args, now, roots, io }) {
  const { review } = await loadCanonical({ cwd, config, args, now, roots });
  const positions = positionalArgs(args, new Set(['--week']));
  if (positions.length !== 1) throw new Error('explain requires exactly one item ref prefix.');
  const [prefix] = positions;
  if (typeof prefix !== 'string' || prefix.length < 12 || !/^[0-9a-f]+$/.test(prefix)) throw new Error('item ref prefix must be at least 12 lowercase hex characters.');
  const found = review.candidates.filter((candidate) => candidate.itemRef.startsWith(prefix));
  if (found.length !== 1) throw new Error(found.length ? 'item ref prefix is ambiguous.' : 'no current digest candidate matches that ref prefix.');
  const candidate = found[0];
  const sessionPrefixes = prefixMap(review.candidates.flatMap((value) => value.receipts.map((receiptValue) => receiptValue.sessionKey)));
  const refPrefixes = prefixMap(review.candidates.flatMap((value) => value.receipts.map((receiptValue) => receiptValue.ref)));
  io.out(`digest explain: ${candidate.itemRef}\ncategory: ${candidate.category}\ndecision: ${candidate.decision}\nscore: ${candidate.score}\nreason: ${candidate.selectionReason}\n`);
  for (const signal of candidate.signals) io.out(`signal: ${signal} (${review.policy.weights[signal]})\n`);
  io.out(`privacy: raw ${candidate.privacy.rawRisk}; residual ${candidate.privacy.residualRisk}; transform ${candidate.privacy.transform}; changed ${candidate.privacy.changedPercent}%; decision ${candidate.privacy.decision}\n`);
  for (const value of candidate.receipts) io.out(`receipt: ${value.source} session ${sessionPrefixes.get(value.sessionKey)} turn ${value.turn} ref ${refPrefixes.get(value.ref)} (${value.kind})\n`);
  return 0;
}

function controlledReview(review, candidate, command, now) {
  const next = JSON.parse(JSON.stringify(review));
  const index = next.candidates.findIndex((value) => value.itemRef === candidate.itemRef);
  if (index < 0) throw new Error('digest candidate changed during control mutation.');
  if (command === 'delete') {
    if (digestItemIdentity(candidate.category, candidate.evidenceRefs, candidate.discriminator) !== candidate.itemRef) {
      throw new Error('digest candidate identity changed before deletion.');
    }
    const tombstone = {
      itemRef: candidate.itemRef, category: candidate.category,
      evidenceRefs: [...candidate.evidenceRefs], deletedAt: now.toISOString(),
    };
    next.version = 2;
    next.candidates.splice(index, 1);
    next.tombstones = [...(next.tombstones ?? []), tombstone]
      .sort((a, b) => a.itemRef.localeCompare(b.itemRef));
  } else {
    next.candidates[index].state = command === 'keep' ? 'kept' : 'hidden';
  }
  return next;
}

async function control({ cwd, config, command, args, now, roots, io, transactionFs }) {
  const positions = positionalArgs(args, new Set(['--week']));
  if (positions.length !== 1) throw new Error(`${command} requires exactly one item ref prefix.`);
  if (command === 'delete' && !args.includes('--yes')) throw new Error('delete requires --yes.');
  const { review } = await loadCanonical({ cwd, config, args, now, roots });
  const [prefix] = positions;
  if (typeof prefix !== 'string' || prefix.length < 12 || !/^[0-9a-f]+$/.test(prefix)) {
    throw new Error('item ref prefix must be at least 12 lowercase hex characters.');
  }
  const found = review.candidates.filter((candidate) => candidate.itemRef.startsWith(prefix));
  if (found.length !== 1) throw new Error(found.length ? 'item ref prefix is ambiguous.' : 'no current digest candidate matches that ref prefix.');
  const candidate = found[0];
  const override = controlledReview(review, candidate, command, now);
  await prepare({ cwd, config, args, now, roots, io, transactionFs, priorReviewOverride: override, quiet: true });
  if (command === 'delete') {
    io.out(`digest delete: removed private ${candidate.category} item ${candidate.itemRef.slice(0, 12)} and left a no-text tombstone. This cannot recall honestweek.prompt-items.json or the built page. Run honestweek validate, then honestweek build; remove the local output now if needed.\n`);
  } else {
    const next = readDigestReview(cwd, config).candidates.find((value) => value.itemRef === candidate.itemRef);
    io.out(`digest ${command}: ${candidate.itemRef.slice(0, 12)} is ${command === 'keep' ? 'kept' : 'hidden'}; decision ${next.decision}. ${command === 'keep' ? 'Keep cannot override receipt or privacy gates. ' : ''}Run honestweek validate, then honestweek build.\n`);
  }
  return 0;
}

export async function runDigest({ cwd = process.cwd(), argv = [], now = new Date(), io = defaultIo(), roots, transactionFs } = {}) {
  const [command, ...args] = argv;
  if (!command || ['-h','--help'].includes(command)) {
    io.out('Usage: honestweek digest <prepare|candidates|explain|keep|hide|delete> [options]\n');
    return 0;
  }
  let config;
  try { config = loadConfig(join(cwd, 'honestweek.config.json')); }
  catch (error) { io.err(`digest: ${error.message}\n`); return io.exit(1) ?? 1; }
  const selectedRoots = roots ?? resolvePromptRoots();
  try {
    if (command === 'candidates' || command === 'explain') assertNoDigestPending(cwd);
    return await withPromptLock(cwd, async () => {
      if (command === 'prepare') return prepare({ cwd, config, args, now, roots: selectedRoots, io, transactionFs });
      if (command === 'candidates') return candidates({ cwd, config, args, now, roots: selectedRoots, io });
      if (command === 'explain') return explain({ cwd, config, args, now, roots: selectedRoots, io });
      if (command === 'keep' || command === 'hide' || command === 'delete') {
        return control({ cwd, config, command, args, now, roots: selectedRoots, io, transactionFs });
      }
      throw new Error(`unknown digest command ${JSON.stringify(command)}.`);
    }, { ensureIgnored: command === 'prepare' });
  } catch (error) {
    io.err(`digest: ${error.message}\n`);
    const code = error?.promptPreflight ? 1 : 2;
    return io.exit(code) ?? code;
  }
}

export default function run(argv) { return runDigest({ argv }); }
