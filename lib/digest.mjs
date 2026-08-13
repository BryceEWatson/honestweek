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
  DIGEST_GITIGNORE, DIGEST_PENDING, assertDigestPendingGeneration, assertRecoverableDigestPending, currentDigestHashes,
  assertNoDigestPending, makeDigestPending, readDigestPending, removeDigestPending,
  readDigestReview, validateDigestLane, validateDigestReview,
  writeDigestLane, writeDigestPending, writeDigestReview,
} from './digest-store.mjs';
import { preflightPromptOutput, loadValidatedPromptLane } from './prompt-lane.mjs';
import { withPromptLock } from './prompt-lock.mjs';
import { ensureGitignore } from './init.mjs';
import { digestItemIdentity, sha256 } from './prompt-identity.mjs';
import {
  CARRY_GITIGNORE, assertNoCarryPending, readCarry, writeCarry,
} from './digest-carry.mjs';
import { addWeeks } from './digest-lifecycle.mjs';
import { recoverConfiguredCarry } from './carry-recovery.mjs';
import { verifyCarryReceipts } from './carry-receipts.mjs';

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
function readPriorControlReview(cwd, config) {
  try { return readDigestReview(cwd, config, { historical: true }); }
  catch (error) {
    const state = error.message.includes('tombstone') ? 'tombstone' : 'control';
    throw new Error(`digest review ${state} state is invalid (${error.message}).`);
  }
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
  const priorCarry = readCarry(cwd, config, { optional: true });
  await verifyCarryReceipts({
    carry: priorCarry.value, week: { start: week.start, end: week.end }, config, roots, now,
  });
  const priorReview = priorReviewOverride === undefined && existsSync(join(cwd, 'honestweek.curated.json'))
    ? readPriorControlReview(cwd, config)
    : priorReviewOverride ?? null;
  const { review, lane } = curateDigest(promptStore, evidence, config, { start: week.start, end: week.end }, now, {
    outputBinding, priorReview, carry: priorCarry.value, carryHash: priorCarry.hash,
  });
  validateDigestReview(review, config);
  validateDigestLane(lane, config);
  for (const entry of [...PROMPT_GITIGNORE, ...DIGEST_GITIGNORE, ...CARRY_GITIGNORE]) ensureGitignore(cwd, entry);
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

function bulkDeletedReview(review, now) {
  if (!review.candidates.length) throw new Error('delete --all requires at least one current digest candidate.');
  const next = structuredClone(review);
  const additions = next.candidates.map((candidate) => ({
    itemRef: candidate.itemRef, category: candidate.category,
    evidenceRefs: [...candidate.evidenceRefs], deletedAt: now.toISOString(),
  }));
  next.version = Math.max(2, next.version);
  next.candidates = [];
  next.tombstones = [...(next.tombstones ?? []), ...additions]
    .filter((value, index, values) => values.findIndex((other) => other.itemRef === value.itemRef) === index)
    .sort((a, b) => a.itemRef.localeCompare(b.itemRef));
  if (next.version === 3) {
    next.renewals = [];
    next.lifecycle.entries = [];
  }
  return next;
}

function renewedReview(review, candidate, now) {
  if (candidate.state === 'hidden' || candidate.privacy.decision !== 'automatic-safe') {
    throw new Error('carry-forward requires a live public-safe candidate.');
  }
  const next = structuredClone(review);
  const targetWeek = addWeeks(review.week.start, 1);
  const existing = next.version === 3
    ? next.renewals.find((renewal) => renewal.itemRef === candidate.itemRef && renewal.targetWeek === targetWeek)
    : null;
  if (next.version !== 3) {
    next.version = 3;
    next.tombstones = next.tombstones ?? [];
    next.renewals = [];
    next.lifecycle = { carryHash: null, entries: [], retired: [] };
  }
  if (!existing) next.renewals.push({ itemRef: candidate.itemRef, requestedAt: now.toISOString(), targetWeek });
  next.renewals.sort((a, b) => a.itemRef.localeCompare(b.itemRef));
  return next;
}

async function control({ cwd, config, command, args, now, roots, io, transactionFs }) {
  const positions = positionalArgs(args, new Set(['--week']));
  const all = args.includes('--all');
  if (all && (command !== 'delete' || positions.length)) throw new Error(`${command} cannot mix --all with an item ref.`);
  if (!all && positions.length !== 1) throw new Error(`${command} requires exactly one item ref prefix.`);
  if (command === 'delete' && !args.includes('--yes')) throw new Error('delete requires --yes.');
  const { review } = await loadCanonical({ cwd, config, args, now, roots });
  if (all) {
    const count = review.candidates.length;
    await prepare({ cwd, config, args, now, roots, io, transactionFs,
      priorReviewOverride: bulkDeletedReview(review, now), quiet: true });
    io.out(`digest delete: removed ${count} private digest item(s) and left no-text tombstones. This cannot recall honestweek.prompt-items.json or the built page. Run honestweek validate, then honestweek build; remove the local output now if needed.\n`);
    return 0;
  }
  const [prefix] = positions;
  if (typeof prefix !== 'string' || prefix.length < 12 || !/^[0-9a-f]+$/.test(prefix)) {
    throw new Error('item ref prefix must be at least 12 lowercase hex characters.');
  }
  const found = review.candidates.filter((candidate) => candidate.itemRef.startsWith(prefix));
  if (found.length !== 1) throw new Error(found.length ? 'item ref prefix is ambiguous.' : 'no current digest candidate matches that ref prefix.');
  const candidate = found[0];
  const override = command === 'carry-forward'
    ? renewedReview(review, candidate, now)
    : controlledReview(review, candidate, command, now);
  await prepare({ cwd, config, args, now, roots, io, transactionFs, priorReviewOverride: override, quiet: true });
  if (command === 'carry-forward') {
    io.out(`digest carry-forward: ${candidate.itemRef.slice(0, 12)} is renewed for ${addWeeks(review.week.start, 1)} only. Renewal cannot override receipts or privacy. Run honestweek validate, then honestweek build.\n`);
  } else if (command === 'delete') {
    io.out(`digest delete: removed private ${candidate.category} item ${candidate.itemRef.slice(0, 12)} and left a no-text tombstone. This cannot recall honestweek.prompt-items.json or the built page. Run honestweek validate, then honestweek build; remove the local output now if needed.\n`);
  } else {
    const next = readDigestReview(cwd, config).candidates.find((value) => value.itemRef === candidate.itemRef);
    io.out(`digest ${command}: ${candidate.itemRef.slice(0, 12)} is ${command === 'keep' ? 'kept' : 'hidden'}; decision ${next.decision}. ${command === 'keep' ? 'Keep cannot override receipt or privacy gates. ' : ''}Run honestweek validate, then honestweek build.\n`);
  }
  return 0;
}

function prefixValue(value) {
  if (typeof value !== 'string' || value.length < 12 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error('item ref prefix must be at least 12 lowercase hex characters.');
  }
  return value;
}

async function resetTombstones({ cwd, config, args, now, io, transactionFs = {} }) {
  assertNoDigestPending(cwd);
  if (!args.includes('--yes')) throw new Error('reset-tombstones requires --yes.');
  const all = args.includes('--all');
  const weekArg = flag(args, '--week');
  const positions = positionalArgs(args, new Set(['--week']));
  const modes = Number(all) + Number(weekArg !== undefined) + Number(positions.length > 0);
  if (modes !== 1 || positions.length > 1) {
    throw new Error('reset-tombstones requires exactly one item ref, --week <YYYY-Www>, or --all.');
  }
  const carryLoaded = readCarry(cwd, config, { optional: true });
  const review = existsSync(join(cwd, 'honestweek.curated.json')) ? readDigestReview(cwd, config) : null;
  const promptStore = readPromptStore(cwd, { optional: true });
  const carryRows = carryLoaded.value?.tombstones ?? [];
  const carryItemRefs = new Set(carryRows.map((row) => row.itemRef));
  const nativeReviewRows = (review?.tombstones ?? []).filter((row) => !carryItemRefs.has(row.itemRef));
  const digestRows = [
    ...carryRows.map((row) => ({ source: 'carry', row, week: row.week })),
    ...nativeReviewRows.map((row) => ({ source: 'review', row, week: review.week })),
  ];
  const promptRows = promptStore?.tombstones ?? [];
  const carryKeys = new Set();
  const nativeReviewRefs = new Set();
  const promptRefs = new Set();
  const carryKey = (row) => `${row.week.start}\0${row.week.end}\0${row.itemRef}`;
  const selectDigest = (value) => {
    if (value.source === 'carry') carryKeys.add(carryKey(value.row));
    else nativeReviewRefs.add(value.row.itemRef);
    for (const ref of value.row.evidenceRefs) promptRefs.add(ref);
  };
  if (all) {
    for (const value of digestRows) selectDigest(value);
    for (const value of promptRows) promptRefs.add(value.ref);
  } else if (weekArg !== undefined) {
    const target = weekFor(config, args, now);
    for (const value of digestRows) {
      if (value.week.start === target.start && value.week.end === target.end) selectDigest(value);
    }
  } else {
    const prefix = prefixValue(positions[0]);
    const identities = [...new Set([
      ...digestRows.map((value) => value.row.itemRef),
      ...promptRows.map((value) => value.ref),
    ])].filter((value) => value.startsWith(prefix));
    if (identities.length !== 1) {
      throw new Error(identities.length ? 'tombstone ref prefix is ambiguous.' : 'no tombstone matches that ref prefix.');
    }
    const [identity] = identities;
    for (const value of digestRows) {
      if (value.row.itemRef === identity || value.row.evidenceRefs.includes(identity)) selectDigest(value);
    }
    promptRefs.add(identity);
  }
  const remainingCarryRows = carryRows.filter((row) => !carryKeys.has(carryKey(row)));
  const removedDigestRefs = new Set([
    ...carryRows.filter((row) => carryKeys.has(carryKey(row))).map((row) => row.itemRef),
    ...nativeReviewRefs,
  ]);
  const reviewRemovalRefs = new Set(nativeReviewRefs);
  for (const itemRef of removedDigestRefs) {
    if (!remainingCarryRows.some((row) => row.itemRef === itemRef)) reviewRemovalRefs.add(itemRef);
  }
  const carryRemoved = carryRows.length - remainingCarryRows.length;
  const reviewRemoved = (review?.tombstones ?? []).filter((row) => reviewRemovalRefs.has(row.itemRef)).length;
  const promptRemoved = promptRows.filter((row) => promptRefs.has(row.ref)).length;
  if (carryRemoved + reviewRemoved + promptRemoved === 0) throw new Error('reset-tombstones matched no removable tombstone.');
  if (carryRemoved) {
    const next = structuredClone(carryLoaded.value);
    next.tombstones = remainingCarryRows;
    writeCarry(cwd, next, config, transactionFs.resetCarry);
  }
  if (reviewRemoved) {
    const next = structuredClone(review);
    next.tombstones = next.tombstones.filter((row) => !reviewRemovalRefs.has(row.itemRef));
    writeDigestReview(cwd, next, config, transactionFs.resetReview);
  }
  if (promptRemoved) {
    const next = structuredClone(promptStore);
    next.tombstones = next.tombstones.filter((row) => !promptRefs.has(row.ref));
    next.generatedAt = now.toISOString();
    writePromptStore(cwd, next, transactionFs.resetPromptStore);
  }
  io.out(`digest reset-tombstones: removed ${carryRemoved + reviewRemoved} digest blocker(s) and ${promptRemoved} prompt blocker(s). No live text, public lane, or output was changed. Reset cannot recall or repair an already built, copied, or published artifact. Run honestweek digest prepare, honestweek validate, then honestweek build.\n`);
  return 0;
}

async function recover({ cwd, config, args, io, transactionFs = {}, quiet = false }) {
  const result = await recoverConfiguredCarry({
    cwd, config, hasGoals: existsSync(join(cwd, 'honestweek.objectives.json')),
    discard: args.includes('--discard-pending'), fs: transactionFs.recovery,
  });
  if (!quiet) io.out(result.action === 'none'
    ? 'digest recover: no carry transaction is pending.\n'
    : `digest recover: ${result.action} the hash-bound carry transaction.\n`);
  return 0;
}

export async function runDigest({ cwd = process.cwd(), argv = [], now = new Date(), io = defaultIo(), roots, transactionFs } = {}) {
  const [command, ...args] = argv;
  // Help anywhere in argv, not just first: `digest prepare --help` used to run
  // a real prepare (loading config, taking the lock, scanning transcripts).
  if (!command || argv.some((a) => a === '-h' || a === '--help')) {
    io.out('Usage: honestweek digest <prepare|candidates|explain|keep|hide|delete|carry-forward|recover|reset-tombstones> [options]\n');
    return 0;
  }
  let config;
  try { config = loadConfig(join(cwd, 'honestweek.config.json')); }
  catch (error) { io.err(`digest: ${error.message}\n`); return io.exit(1) ?? 1; }
  const selectedRoots = roots ?? resolvePromptRoots();
  try {
    if (command === 'candidates' || command === 'explain') assertNoDigestPending(cwd);
    return await withPromptLock(cwd, async () => {
      if (command === 'recover') {
        assertNoDigestPending(cwd);
        return recover({ cwd, config, args, io, transactionFs });
      }
      if (command !== 'prepare' || !existsSync(join(cwd, DIGEST_PENDING))) {
        assertNoDigestPending(cwd);
        await recover({ cwd, config, args: [], io, transactionFs, quiet: true });
      } else {
        assertNoCarryPending(cwd);
      }
      if (command === 'prepare') return prepare({ cwd, config, args, now, roots: selectedRoots, io, transactionFs });
      if (command === 'candidates') return candidates({ cwd, config, args, now, roots: selectedRoots, io });
      if (command === 'explain') return explain({ cwd, config, args, now, roots: selectedRoots, io });
      if (command === 'reset-tombstones') return resetTombstones({ cwd, config, args, now, io, transactionFs });
      if (command === 'keep' || command === 'hide' || command === 'delete' || command === 'carry-forward') {
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
