import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.mjs';
import { runDigest } from '../lib/digest.mjs';
import { runPrompts } from '../lib/prompts.mjs';
import { runValidate } from '../lib/validate.mjs';
import { CARRY_GITIGNORE, CARRY_PENDING, carryTombstonesForWeek, validateCarry } from '../lib/digest-carry.mjs';
import { DIGEST_PENDING } from '../lib/digest-store.mjs';
import { retiredRow, subjectFingerprint, validateLifecycleWeek, validateRetired } from '../lib/digest-lifecycle.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { sha256 } from '../lib/prompt-identity.mjs';
import { ensureGitignore } from '../lib/init.mjs';

const REPRESENTATIVE_PROOF = JSON.parse(readFileSync(
  new URL('./fixtures/representative-proof.expected.json', import.meta.url), 'utf8',
));

const nativeAtomicFs = { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync };
function failAtomic(method) {
  let failed = false;
  return {
    ...nativeAtomicFs,
    [method]: (...args) => {
      if (!failed) { failed = true; throw new Error(`injected ${method} fault`); }
      return nativeAtomicFs[method](...args);
    },
  };
}

function capture() {
  let stdout = ''; let stderr = '';
  return {
    out: (value) => { stdout += value; }, err: (value) => { stderr += value; }, exit: (code) => code,
    get stdout() { return stdout; }, get stderr() { return stderr; },
  };
}

function jsonl(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function claudeWeek({ session, project, at, human, final }) {
  const base = new Date(at).getTime();
  return [
    { type: 'user', sessionId: session, timestamp: new Date(base).toISOString(), cwd: project, message: { content: human } },
    { type: 'assistant', sessionId: session, timestamp: new Date(base + 1000).toISOString(), cwd: project, message: { content: [{ type: 'tool_use', name: 'Bash', id: `${session}-verify` }] } },
    { type: 'user', sessionId: session, timestamp: new Date(base + 2000).toISOString(), cwd: project, message: { content: [{ type: 'tool_result', tool_use_id: `${session}-verify`, content: 'tests passed' }] } },
    { type: 'assistant', sessionId: session, timestamp: new Date(base + 3000).toISOString(), cwd: project, message: { content: [{ type: 'text', text: final }] } },
  ];
}

function codexWeek({ session, project, at, human, final }) {
  return [
    { type: 'session_meta', payload: { id: session, cwd: project } },
    { type: 'turn_context', payload: { cwd: project } },
    { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: human } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: `${session}-verify` } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: `${session}-verify`, output: '# pass 4\n# fail 0' } },
    { type: 'event_msg', timestamp: new Date(new Date(at).getTime() + 3000).toISOString(), payload: { type: 'agent_message', message: final } },
  ];
}

function writeWeekSources(fixture, index, humanA, finalA, humanB, finalB) {
  const start = new Date('2024-06-10T10:00:00.000Z');
  start.setUTCDate(start.getUTCDate() + index * 7);
  const year = start.getUTCFullYear();
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const day = String(start.getUTCDate() + 1).padStart(2, '0');
  const at = `${year}-${month}-${day}T10:00:00.000Z`;
  jsonl(join(fixture.claude, 'projects', 'your-project', `week-${index}.jsonl`), claudeWeek({
    session: `claude-week-${index}`, project: fixture.project, at, human: humanA, final: finalA,
  }));
  jsonl(join(fixture.codex, 'sessions', '2024', `week-${index}.jsonl`), codexWeek({
    session: `codex-week-${index}`, project: fixture.project, at, human: humanB, final: finalB,
  }));
}

function lifecycleFixture() {
  const root = mkdtempSync(join(tmpdir(), 'honestweek-lifecycle-'));
  const project = join(root, 'your-project');
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  mkdirSync(project, { recursive: true });
  const adapter = join(root, 'honestweek.site.mjs');
  writeFileSync(adapter, "export const artifact='site-data.json'; export function transform(model){return {items:model.items.map((item)=>({id:item.id,status:item.status===''?null:item.status,project:item.project,title:item.title,summary:item.summary,snippets:item.snippets}))};}\n");
  writeFileSync(join(root, 'honestweek.config.json'), JSON.stringify({
    identity: { authorEmails: ['you@example.com'] },
    week: { startsOn: 'monday', timezone: 'UTC' },
    repos: [{ path: project, label: 'your-project', role: 'featured' }],
    redaction: { codenames: [], names: [], terms: [] },
    curation: {
      maxItems: 12, automaticMinScore: 2, automaticCarryWeeks: 2, retentionWeeks: 12,
      categoryCaps: { prompts: 2, ideas: 2, techniques: 3, decisions: 2, reversals: 1, nextSteps: 2 },
    },
    output: { mode: 'site', adapter },
  }));
  return { root, project, claude, codex, roots: { 'claude-code': join(claude, 'projects'), codex } };
}

function setItemsWeek(root, start, end) {
  writeFileSync(join(root, 'honestweek.items.json'), JSON.stringify({ week: { start, end }, items: [] }));
}

function publicLaneProof(root) {
  const lane = JSON.parse(readFileSync(join(root, 'honestweek.prompt-items.json'), 'utf8'));
  return lane.items.map((item) => [
    item.category, item.curationState, item.selection.score, item.selection.primaryReasonCode,
    item.receipts.map((receipt) => `${receipt.source}:${receipt.kind}:${receipt.turn}`).join(','),
  ].join('|'));
}

function publicLaneIdentityHash(root) {
  const lane = JSON.parse(readFileSync(join(root, 'honestweek.prompt-items.json'), 'utf8'));
  return sha256(JSON.stringify(lane.items.map((item) => ({
    itemRef:item.itemRef,
    receipts:item.receipts.map(({ source, sessionKey, kind, turn, ref }) => ({ source, sessionKey, kind, turn, ref })),
  }))));
}

test('carry tombstones block a matching receipt until explicit reset regardless of reporting week', () => {
  const tombstone = {
    itemRef: 'a'.repeat(64), category: 'ideas', evidenceRefs: ['b'.repeat(64)],
    deletedAt: '2024-06-17T12:00:00.000Z', week: { start: '2024-06-10', end: '2024-06-16' },
  };
  assert.deepEqual(carryTombstonesForWeek(
    { version: 1, weeks: [], tombstones: [tombstone] },
    { start: '2024-07-01', end: '2024-07-07' },
  ), [tombstone]);
});

test('lifecycle weeks reject impossible dates and non-seven-day spans', () => {
  assert.throws(() => validateLifecycleWeek({ start:'2024-02-30', end:'2024-03-06' }), /invalid/);
  assert.throws(() => validateLifecycleWeek({ start:'2024-06-10', end:'2024-06-15' }), /invalid/);
  assert.deepEqual(validateLifecycleWeek({ start:'2024-06-10', end:'2024-06-16' }), {
    start:'2024-06-10', end:'2024-06-16',
  });
});

test('historical retirement audits stay readable after a stricter privacy configuration', () => {
  const subject = 'bounded historical privacy marker';
  const config = normalizeConfig({
    identity: { authorEmails: ['you@example.com'] },
    repos: [{ path: '.', label: 'your-project', role: 'featured' }],
    redaction: { terms: ['historical privacy marker'] },
  });
  const retired = {
    lineageRef: 'a'.repeat(64), itemRef: 'b'.repeat(64), category: 'ideas',
    subject, subjectFingerprint: subjectFingerprint(subject), reason: 'automatic-limit', terminalRef: null,
  };
  assert.throws(() => validateRetired(retired, config), /subject fingerprint/);
  assert.equal(validateRetired(retired, config, { historical: true }), retired);

  const hidden = retiredRow({
    entry: {
      lineageRef:'c'.repeat(64), itemRef:'c'.repeat(64), category:'ideas',
      candidate:{ text:'safe hidden subject with ordinary lowercase words', isPrivate:false, state:'hidden',
        truncated:false, changedPercent:0, rawDetectors:[] },
    },
    reason:'hidden', config:normalizeConfig({
      identity:{ authorEmails:['you@example.com'] },
      repos:[{ path:'.', label:'your-project', role:'featured' }],
    }),
  });
  assert.equal(hidden.subject, 'safe hidden subject with ordinary lowercase words');
  assert.equal(hidden.subjectFingerprint, subjectFingerprint(hidden.subject));
});

test('carry gitignore updates are atomic at every file boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'honestweek-gitignore-'));
  const path = join(root, '.gitignore');
  try {
    for (const boundary of ['openSync','writeFileSync','fsyncSync','renameSync']) {
      writeFileSync(path, 'prior-rule\n');
      assert.throws(() => ensureGitignore(root, CARRY_PENDING, failAtomic(boundary)), /injected/);
      assert.equal(readFileSync(path, 'utf8'), 'prior-rule\n', boundary);
    }
  } finally {
    rmSync(root, { recursive:true, force:true });
  }
});

test('digest and carry pending markers cannot be recovered as a mixed state', async () => {
  const f = lifecycleFixture();
  try {
    const digestPendingPath = join(f.root, DIGEST_PENDING);
    const carryPendingPath = join(f.root, CARRY_PENDING);
    writeFileSync(digestPendingPath, '{"version":1}\n');
    writeFileSync(carryPendingPath, '{"version":1}\n');
    const beforeDigest = readFileSync(digestPendingPath);
    const beforeCarry = readFileSync(carryPendingPath);
    const output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['recover'], now:new Date('2024-06-17T12:00:00.000Z'), io:output }), 2);
    assert.match(output.stderr, /digest\.pending/);
    assert.deepEqual(readFileSync(digestPendingPath), beforeDigest);
    assert.deepEqual(readFileSync(carryPendingPath), beforeCarry);
  } finally {
    rmSync(f.root, { recursive:true, force:true });
  }
});

async function runCycle(fixture, weekArg, start, end, now) {
  setItemsWeek(fixture.root, start, end);
  let output = capture();
  assert.equal(await runDigest({ cwd: fixture.root, argv: ['prepare', '--week', weekArg], now, roots: fixture.roots, io: output }), 0, output.stderr);
  output = capture();
  assert.equal(await runValidate({ cwd: fixture.root, argv: ['--week', weekArg], now, io: output }), 0, output.stderr);
  output = capture();
  assert.equal(await runBuild({ cwd: fixture.root, argv: ['--week', weekArg], now, io: output }), 0, output.stderr);
}

test('thirteen dual-source weeks prove bounded carry, renewal, retirement, site output, and history pruning', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const idea = 'retain the bounded lifecycle receipt across consecutive weekly reviews';
  const next = 'finish the deterministic recovery proof with local atomic fault checks';
  const proof = {};
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      `review the first bounded week with receipt evidence and local verification\nunresolved idea: ${idea}`,
      'Decision: use the closed lifecycle transition table for weekly state',
      'review the first recovery week with receipt evidence and local verification',
      `Next step: ${next}`,
    );
    jsonl(join(f.claude, 'projects', 'your-project', 'representative-safe.jsonl'), claudeWeek({
      session:'representative-safe', project:f.project, at:'2024-06-12T10:00:00.000Z',
      human:'review the all-category representative week with exact local verification',
      final:'Technique: reconstruct exact receipts before selecting a bounded weekly row\nReversal: replace broad lifecycle guesses with the closed transition table\nContinue with routine handoff boilerplate that must not surface',
    }));
    jsonl(join(f.claude, 'projects', 'your-project', 'representative-edited.jsonl'), claudeWeek({
      session:'representative-edited', project:f.project, at:'2024-06-13T10:00:00.000Z',
      human:'review person@example.com only after the deterministic privacy edit has been verified locally with enough ordinary lowercase context for the bounded weekly public rendition',
      final:'Idea: retain person@example.com only through the deterministic public-safe placeholder while preserving enough ordinary lowercase context for the bounded weekly public rendition',
    }));
    jsonl(join(f.claude, 'projects', 'your-project', 'representative-ambiguous.jsonl'), claudeWeek({
      session:'representative-ambiguous', project:f.project, at:'2024-06-14T10:00:00.000Z',
      human:'review Nimbus as an intentionally ambiguous capitalized token in this local fixture',
      final:'Decision: keep Nimbus private unless the deterministic privacy table resolves it',
    }));
    jsonl(join(f.claude, 'projects', 'your-project', 'representative-private.jsonl'), claudeWeek({
      session:'representative-private', project:join(f.root, 'unmatched'), at:'2024-06-15T10:00:00.000Z',
      human:'review this unmatched project prompt only inside the private inbox',
      final:'Reversal: keep unmatched project material out of the public digest',
    }));
    jsonl(join(f.codex, 'sessions', '2024', 'representative-wrapper.jsonl'), [
      { type:'session_meta', payload:{ id:'representative-wrapper', cwd:f.project } },
      { type:'event_msg', timestamp:'2024-06-15T11:00:00.000Z', payload:{ type:'user_message', message:'<codex_delegation>Idea: wrapper sentinel must stay excluded</codex_delegation>' } },
      { type:'event_msg', timestamp:'2024-06-15T11:03:00.000Z', payload:{ type:'agent_message', message:'Idea: orphaned wrapper response must stay excluded' } },
    ]);
    setItemsWeek(f.root, '2024-06-10', '2024-06-16');
    let output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    const representativeReview = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const hideRef = representativeReview.candidates.find((item) => item.category === 'techniques' && item.privacy.decision === 'automatic-safe').itemRef;
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['hide',hideRef.slice(0,12),'--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    let controlled = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const deleteRef = controlled.candidates.find((item) => item.category === 'reversals' && item.privacy.decision === 'automatic-safe').itemRef;
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['delete',deleteRef.slice(0,12),'--yes','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    const individualDeleted = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['reset-tombstones',deleteRef.slice(0,12),'--yes'], now:new Date('2024-06-17T12:00:00.000Z'), io:output }), 0, output.stderr);
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['delete','--all','--yes','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    const bulkDeleted = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['reset-tombstones','--all','--yes'], now:new Date('2024-06-17T12:00:00.000Z'), io:output }), 0, output.stderr);
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    output = capture();
    assert.equal(await runValidate({ cwd:f.root, argv:['--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), io:output }), 0, output.stderr);
    output = capture();
    assert.equal(await runBuild({ cwd:f.root, argv:['--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), io:output }), 0, output.stderr);
    let carry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8'));
    assert.equal(carry.weeks.length, 1);
    assert.equal(carry.weeks[0].entries.length, 2);
    proof.week1 = {
      publicOrder: publicLaneProof(f.root),
      identityOrderHash: publicLaneIdentityHash(f.root),
      representative: {
        categories:[...new Set(representativeReview.candidates.map((item) => item.category))].sort(),
        automaticSafe:representativeReview.candidates.filter((item) => item.privacy.decision === 'automatic-safe').length,
        editedAutomaticSafe:representativeReview.candidates.filter((item) =>
          item.privacy.decision === 'automatic-safe' && item.transform === 'redaction').length,
        needsApproval:representativeReview.candidates.filter((item) => item.privacy.decision === 'needs-approval').length,
        privateSource:representativeReview.candidates.filter((item) => item.privacy.decision === 'private-source').length,
        wrapperSuppressed:!JSON.stringify(representativeReview).includes('wrapper sentinel'),
        boilerplateSuppressed:!JSON.stringify(representativeReview).includes('routine handoff boilerplate'),
        hiddenState:controlled.candidates.find((item) => item.itemRef === hideRef).state,
        individualTombstoneNoText:!Object.hasOwn(individualDeleted.tombstones.find((item) => item.itemRef === deleteRef), 'text'),
        bulkRemaining:bulkDeleted.candidates.length,
        bulkTombstones:bulkDeleted.tombstones.length,
        bulkTombstonesContainText:bulkDeleted.tombstones.some((item) => Object.hasOwn(item, 'text')),
      },
      carry: carry.weeks[0].entries.map((entry) => ({
        category: entry.category, strength: entry.strength,
        firstSeenWeek: entry.firstSeenWeek, lastShownWeek: entry.lastShownWeek,
        automaticThroughWeek: entry.automaticThroughWeek, manualTargetWeek: entry.manualTargetWeek,
      })),
    };

    writeWeekSources(f, 1,
      `review the second bounded week with distinct receipt evidence and verification\nunresolved idea: ${idea}`,
      'Decision: retain one explicit manual renewal route for this digest',
      'review the second recovery week with distinct receipt evidence and verification',
      'Technique: verify the canonical sidecars before the configured site transform',
    );
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    let lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    assert.equal(lane.items.filter((item) => item.curationState === 'carried').length, 2);
    assert.equal(lane.items.filter((item) => item.curationState === 'carried')
      .every((item) => item.summary.endsWith('First seen 2024-06-10; as of 2024-06-17.')), true);
    const keptCarryRef = lane.items.find((item) => item.curationState === 'carried').itemRef;
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['keep', keptCarryRef.slice(0, 12), '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    const keptCarry = lane.items.find((item) => item.itemRef === keptCarryRef);
    assert.equal(keptCarry.curationState, 'kept');
    assert.equal(keptCarry.selection.primaryReasonCode, 'explicit-keep');
    const decision = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8')).candidates
      .find((candidate) => candidate.category === 'decisions' && candidate.decision === 'automatic-safe');
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['carry-forward', decision.itemRef.slice(0, 12), '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    output = capture();
    assert.equal(await runValidate({ cwd: f.root, argv: ['--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), io: output }), 0, output.stderr);
    output = capture();
    assert.equal(await runBuild({ cwd: f.root, argv: ['--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), io: output }), 0, output.stderr);
    const week2Review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    carry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8'));
    const currentIdea = lane.items.find((item) => item.category === 'ideas');
    const ideaLifecycle = week2Review.lifecycle.entries.find((entry) => entry.itemRef === currentIdea.itemRef);
    const ideaCarry = carry.weeks.at(-1).entries.find((entry) => entry.lineageRef === ideaLifecycle.lineageRef);
    proof.week2 = {
      publicOrder: publicLaneProof(f.root), identityOrderHash: publicLaneIdentityHash(f.root),
      duplicateSuppression: {
        visibleIdeaCount:lane.items.filter((item) => item.category === 'ideas').length,
        superseded:week2Review.lifecycle.retired.filter((item) => item.reason === 'superseded').length,
        newItemRef:currentIdea.itemRef,
        receiptIdentityHash:sha256(JSON.stringify(currentIdea.receipts)),
        lineageRef:ideaLifecycle.lineageRef,
        firstSeenWeek:ideaLifecycle.firstSeenWeek,
        automaticThroughWeek:ideaCarry.automaticThroughWeek,
      },
    };

    writeWeekSources(f, 2,
      'review the third bounded week with distinct receipt evidence and verification',
      'Reversal: replace the broad recovery guess with exact output and carry hashes',
      'review the third recovery week with distinct receipt evidence and verification',
      'Technique: keep the pending generation bound to the configured output path',
    );
    await runCycle(f, '2024-W26', '2024-06-24', '2024-06-30', new Date('2024-07-01T12:00:00.000Z'));
    lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    assert.equal(lane.items.filter((item) => item.curationState === 'carried').length, 2);
    assert.equal(lane.items.filter((item) => item.curationState === 'renewed').length, 1);
    proof.week3 = { publicOrder: publicLaneProof(f.root), identityOrderHash: publicLaneIdentityHash(f.root) };

    writeWeekSources(f, 3,
      `review the fourth bounded week with terminal receipt evidence and verification\npicked up: ${idea}`,
      'Decision: retire terminal work before applying ordinary selection rules',
      'review the fourth recovery week with distinct receipt evidence and verification',
      'Technique: preserve retained history only within the configured hard bound',
    );
    await runCycle(f, '2024-W27', '2024-07-01', '2024-07-07', new Date('2024-07-08T12:00:00.000Z'));
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    assert.equal(review.lifecycle.retired.some((row) => row.reason === 'terminal-picked-up' && row.terminalRef), true);
    assert.equal(review.lifecycle.retired.some((row) => row.reason === 'automatic-limit'), true);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'site-data.json'), 'utf8')).items.length > 0, true);
    carry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8'));
    assert.equal(carry.weeks.length, 4);
    assert.equal(carry.weeks.every((record) => record.entries.every((entry) => entry.candidate.state === 'inbox')), true);
    proof.week4 = {
      publicOrder: publicLaneProof(f.root),
      identityOrderHash: publicLaneIdentityHash(f.root),
      retired: review.lifecycle.retired.map((row) => ({
        category: row.category, reason: row.reason, terminalRef: row.terminalRef,
      })),
    };

    for (let index = 4; index < 13; index += 1) {
      writeWeekSources(f, index,
        `review bounded history week ${index + 1} with distinct receipt evidence and verification`,
        `Decision: retain only the latest twelve canonical history records for cycle ${index + 1}`,
        `review recovery history week ${index + 1} with distinct receipt evidence and verification`,
        `Technique: verify the local history pruning boundary for cycle ${index + 1}`,
      );
      const start = new Date('2024-06-10T00:00:00.000Z');
      start.setUTCDate(start.getUTCDate() + index * 7);
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
      const now = new Date(start); now.setUTCDate(now.getUTCDate() + 7); now.setUTCHours(12);
      await runCycle(
        f, `2024-W${24 + index}`,
        start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), now,
      );
    }
    carry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8'));
    assert.equal(carry.weeks.length, 12);
    assert.equal(carry.weeks[0].week.start, '2024-06-17');
    assert.equal(carry.weeks.at(-1).week.start, '2024-09-02');
    proof.history = {
      count: carry.weeks.length,
      oldest: carry.weeks[0].week.start,
      newest: carry.weeks.at(-1).week.start,
      activeEntryCounts: carry.weeks.map((record) => record.entries.length),
    };
    const configPath = join(f.root, 'honestweek.config.json');
    const reducedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    reducedConfig.curation.retentionWeeks = 1;
    writeFileSync(configPath, JSON.stringify(reducedConfig));
    writeWeekSources(f, 13,
      'review configured history reduction with distinct receipt evidence and verification',
      'Decision: prune valid prior history only when writing the next canonical carry record',
      'review configured reduction recovery with distinct receipt evidence and verification',
      'Technique: accept the bounded prior state before applying the stricter current retention',
    );
    await runCycle(f, '2024-W37', '2024-09-09', '2024-09-15', new Date('2024-09-16T12:00:00.000Z'));
    carry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8'));
    proof.history.afterConfiguredReduction = {
      count:carry.weeks.length, oldest:carry.weeks[0].week.start, newest:carry.weeks.at(-1).week.start,
    };
    assert.deepEqual(proof, REPRESENTATIVE_PROOF.lifecycle);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('carry transaction faults preserve or recover every documented atomic prefix', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const artifact = join(f.root, 'site-data.json');
  const carryPath = join(f.root, 'honestweek.carry.json');
  const pendingPath = join(f.root, CARRY_PENDING);
  const observedBoundaries = [];
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      'review the fault boundary with exact receipt evidence\nunresolved idea: preserve the prior output across every atomic write failure',
      'Decision: install the exact configured primary bytes before carry promotion',
      'review the recovery boundary with exact receipt evidence',
      'Next step: exercise the complete pending output carry recovery matrix',
    );
    setItemsWeek(f.root, '2024-06-10', '2024-06-16');
    let output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W24'], now: new Date('2024-06-17T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    rmSync(join(f.root, '.gitignore'), { force: true });

    for (const boundary of ['openSync','writeFileSync','fsyncSync','renameSync']) {
      writeFileSync(artifact, 'prior artifact\n');
      rmSync(carryPath, { force: true }); rmSync(pendingPath, { force: true });
      output = capture();
      assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: output,
        transactionFs: { pending: failAtomic(boundary) } }), 2, `pending ${boundary}`);
      assert.equal(readFileSync(artifact, 'utf8'), 'prior artifact\n', `pending ${boundary}`);
      assert.equal(existsSync(carryPath), false, `pending ${boundary}`);
      assert.equal(existsSync(pendingPath), false, `pending ${boundary}`);
      observedBoundaries.push(`pending:${boundary}`);
      const ignored = readFileSync(join(f.root, '.gitignore'), 'utf8').trim().split(/\r?\n/);
      assert.equal(CARRY_GITIGNORE.every((entry) => ignored.includes(entry)), true, 'private carry state is ignored before its first write');
    }

    for (const boundary of ['openSync','writeFileSync','fsyncSync','renameSync']) {
      writeFileSync(artifact, 'prior artifact\n');
      rmSync(carryPath, { force: true }); rmSync(pendingPath, { force: true });
      output = capture();
      assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: output,
        transactionFs: { output: failAtomic(boundary) } }), 2, `primary ${boundary}`);
      assert.equal(readFileSync(artifact, 'utf8'), 'prior artifact\n', `primary ${boundary}`);
      assert.equal(existsSync(carryPath), false, `primary ${boundary}`);
      assert.equal(existsSync(pendingPath), false, `primary ${boundary}`);
      observedBoundaries.push(`primary:${boundary}`);
    }

    for (const [phase, fsKey] of [['phase','phase'], ['carry','carry']]) {
      for (const boundary of ['openSync','writeFileSync','fsyncSync','renameSync']) {
        writeFileSync(artifact, 'prior artifact\n');
        rmSync(carryPath, { force: true }); rmSync(pendingPath, { force: true });
        output = capture();
        assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: output,
          transactionFs: { [fsKey]: failAtomic(boundary) } }), 2, `${phase} ${boundary}`);
        assert.notEqual(readFileSync(artifact, 'utf8'), 'prior artifact\n', `${phase} ${boundary}`);
        assert.equal(existsSync(pendingPath), true, `${phase} ${boundary}`);
        output = capture();
        assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
        assert.equal(existsSync(carryPath), true, `${phase} ${boundary}`);
        assert.equal(existsSync(pendingPath), false, `${phase} ${boundary}`);
        observedBoundaries.push(`${phase}:${boundary}`);
      }
    }

    writeFileSync(artifact, 'prior artifact\n');
    rmSync(carryPath, { force: true }); rmSync(pendingPath, { force: true });
    output = capture();
    assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: output,
      transactionFs: { remove: failAtomic('unlinkSync') } }), 2, 'final pending removal');
    assert.equal(existsSync(carryPath), true);
    assert.equal(existsSync(pendingPath), true);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    assert.equal(existsSync(pendingPath), false);
    observedBoundaries.push('remove:unlinkSync');

    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    assert.match(output.stdout, /no carry transaction is pending/);
    assert.deepEqual(observedBoundaries, REPRESENTATIVE_PROOF.recoveryBoundaries);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('carry recovery accepts only recognized hashes and explicit discard preserves output and carry', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const artifact = join(f.root, 'site-data.json');
  const carryPath = join(f.root, 'honestweek.carry.json');
  const pendingPath = join(f.root, CARRY_PENDING);
  const adapterPath = join(f.root, 'honestweek.site.mjs');
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      'review unknown recovery states with exact receipt evidence\nunresolved idea: reject every hash combination outside the closed recovery table',
      'Decision: require explicit discard only while carry remains at the prior hash',
      'review recovery discard with exact receipt evidence',
      'Next step: prove binding changes cannot recover an earlier pending generation',
    );
    setItemsWeek(f.root, '2024-06-10', '2024-06-16');
    let output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W24'], now: new Date('2024-06-17T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);

    const leavePrepared = async () => {
      rmSync(carryPath, { force: true }); rmSync(pendingPath, { force: true });
      writeFileSync(artifact, 'prior artifact\n');
      const failed = capture();
      assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: failed,
        transactionFs: { phase: failAtomic('renameSync') } }), 2, failed.stderr);
      assert.equal(existsSync(pendingPath), true);
    };

    await leavePrepared();
    const pendingBytes = readFileSync(pendingPath);
    writeFileSync(artifact, 'operator restored prior bytes\n');
    rmSync(join(f.root, '.gitignore'), { force:true });
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    assert.match(output.stderr, /--discard-pending/);
    assert.deepEqual(readFileSync(pendingPath), pendingBytes);
    assert.equal(existsSync(carryPath), false);
    const recoveredIgnore = readFileSync(join(f.root, '.gitignore'), 'utf8').trim().split(/\r?\n/);
    assert.equal(CARRY_GITIGNORE.every((entry) => recoveredIgnore.includes(entry)), true);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover', '--discard-pending'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    assert.equal(readFileSync(artifact, 'utf8'), 'operator restored prior bytes\n');
    assert.equal(existsSync(carryPath), false);
    assert.equal(existsSync(pendingPath), false);

    await leavePrepared();
    const targetBytes = readFileSync(artifact);
    const preparedBytes = readFileSync(pendingPath);
    writeFileSync(carryPath, `${JSON.stringify({ version: 1, weeks: [], tombstones: [] }, null, 2)}\n`);
    const unknownCarryBytes = readFileSync(carryPath);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    assert.match(output.stderr, /unknown state/);
    assert.deepEqual(readFileSync(artifact), targetBytes);
    assert.deepEqual(readFileSync(carryPath), unknownCarryBytes);
    assert.deepEqual(readFileSync(pendingPath), preparedBytes);

    rmSync(carryPath, { force: true }); rmSync(pendingPath, { force: true });
    await leavePrepared();
    const originalAdapter = readFileSync(adapterPath, 'utf8');
    const bindingPending = readFileSync(pendingPath);
    writeFileSync(adapterPath, originalAdapter.replace("site-data.json", "other-site-data.json"));
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    assert.match(output.stderr, /generation does not match/);
    assert.deepEqual(readFileSync(pendingPath), bindingPending);
    assert.equal(existsSync(carryPath), false);
    writeFileSync(adapterPath, originalAdapter);

    writeFileSync(pendingPath, '{"version":1}\n');
    const malformed = readFileSync(pendingPath);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    assert.deepEqual(readFileSync(pendingPath), malformed);
    assert.equal(existsSync(carryPath), false);

    await leavePrepared();
    const validPending = JSON.parse(readFileSync(pendingPath, 'utf8'));
    writeFileSync(pendingPath, JSON.stringify(validPending));
    const noncanonical = readFileSync(pendingPath);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    assert.match(output.stderr, /canonical JSON/);
    assert.deepEqual(readFileSync(pendingPath), noncanonical);
    assert.equal(existsSync(carryPath), false);

    writeFileSync(pendingPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    assert.match(output.stderr, /exceeds the 8 MiB cap/);
    assert.equal(existsSync(carryPath), false);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('bulk deletion and explicit reset keep tombstone regeneration fail-closed', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      'review deletion controls with exact receipt evidence\nunresolved idea: require a confirmed reset before deleted evidence can regenerate',
      'Decision: keep tombstones text free across every private state file',
      'review bulk deletion with exact receipt evidence',
      'Next step: prove partial reset leaves at least one regeneration blocker',
    );
    setItemsWeek(f.root, '2024-06-10', '2024-06-16');
    let output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W24'], now: new Date('2024-06-17T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    const before = readFileSync(join(f.root, 'honestweek.curated.json'));
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['delete', '--all', '--week', '2024-W24'], now: new Date('2024-06-17T12:00:00.000Z'), roots: f.roots, io: output }), 2);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.curated.json')), before);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['delete', '--all', '--yes', '--week', '2024-W24'], now: new Date('2024-06-17T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    let review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    assert.equal(review.candidates.length, 0);
    assert.equal(review.tombstones.length > 0, true);
    assert.equal(review.tombstones.every((row) => !Object.hasOwn(row, 'text')), true);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['reset-tombstones', '--week', '2024-W24', '--yes'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    assert.equal(review.tombstones.length, 0);
    output = capture();
    assert.equal(await runValidate({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W24'], now: new Date('2024-06-17T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);

    output = capture();
    assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    writeWeekSources(f, 1,
      'review partial reset week with distinct receipt evidence and verification',
      'Decision: preserve a review tombstone when carry reset succeeds first',
      'review partial reset recovery with distinct receipt evidence',
      'Technique: retry monotonic reset until every private blocker is removed',
    );
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    const carried = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8')).candidates
      .find((candidate) => candidate.decision === 'automatic-safe' && ['ideas','nextSteps'].includes(candidate.category));
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['delete', carried.itemRef.slice(0, 12), '--yes', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    output = capture();
    assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-24T12:00:00.000Z'), io: output }), 0, output.stderr);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['reset-tombstones', carried.itemRef.slice(0, 12), '--yes'], now: new Date('2024-06-24T12:00:00.000Z'), io: output,
      transactionFs: { resetReview: failAtomic('renameSync') } }), 2);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8')).tombstones.length, 0);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8')).tombstones.length, 1);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8')).items
      .some((item) => item.itemRef === carried.itemRef), false);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['reset-tombstones', carried.itemRef.slice(0, 12), '--yes'], now: new Date('2024-06-24T12:00:00.000Z'), io: output }), 0, output.stderr);

    const prompt = JSON.parse(readFileSync(join(f.root, 'honestweek.prompts.json'), 'utf8')).prompts[0];
    output = capture();
    assert.equal(await runPrompts({ cwd: f.root, argv: ['delete', prompt.ref.slice(0, 12), '--yes'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    let promptStore = JSON.parse(readFileSync(join(f.root, 'honestweek.prompts.json'), 'utf8'));
    assert.equal(promptStore.version, 2);
    assert.deepEqual(promptStore.tombstones[0].week, { start: '2024-06-17', end: '2024-06-23' });
    assert.equal(Object.hasOwn(promptStore.tombstones[0], 'text'), false);
    const promptTombstoneBytes = readFileSync(join(f.root, 'honestweek.prompts.json'));
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['reset-tombstones', '--week', '2024-W25', '--yes'], now: new Date('2024-06-24T12:00:00.000Z'), io: output }), 2);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.prompts.json')), promptTombstoneBytes);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['reset-tombstones', '--all', '--yes'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    promptStore = JSON.parse(readFileSync(join(f.root, 'honestweek.prompts.json'), 'utf8'));
    assert.equal(promptStore.tombstones.length, 0);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('historical carry is re-evaluated under current privacy rules and rejects out-of-bound state', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const subject = 'retain the lifecycle quarantine marker until the bounded review is complete';
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      `review current privacy controls with receipt evidence\nunresolved idea: ${subject}`,
      'Decision: re-evaluate historical carry under the current privacy configuration',
      'review current carry bounds with distinct receipt evidence',
      'Next step: keep the historical audit bytes while applying current privacy rules',
    );
    await runCycle(f, '2024-W24', '2024-06-10', '2024-06-16', new Date('2024-06-17T12:00:00.000Z'));
    writeWeekSources(f, 1,
      'review the following privacy week with distinct receipt evidence',
      'Decision: withhold newly configured private terms before public curation',
      'review the following recovery week with distinct receipt evidence',
      'Technique: preserve the historical candidate audit while retiring its public lineage',
    );
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');

    const carryPath = join(f.root, 'honestweek.carry.json');
    const validCarryBytes = readFileSync(carryPath);
    const tampered = JSON.parse(validCarryBytes);
    tampered.weeks[0].entries[0].automaticThroughWeek = '2025-06-30';
    writeFileSync(carryPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const tamperedBytes = readFileSync(carryPath);
    const reviewBytes = readFileSync(join(f.root, 'honestweek.curated.json'));
    const laneBytes = readFileSync(join(f.root, 'honestweek.prompt-items.json'));
    let output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 2);
    assert.match(output.stderr, /owner-approved bound/);
    assert.deepEqual(readFileSync(carryPath), tamperedBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.curated.json')), reviewBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.prompt-items.json')), laneBytes);
    writeFileSync(carryPath, validCarryBytes);

    const receiptTamper = JSON.parse(validCarryBytes);
    const changedCandidate = receiptTamper.weeks[0].entries[0].candidate;
    changedCandidate.text = 'retain a different but superficially valid bounded lifecycle subject';
    changedCandidate.contentHash = sha256(changedCandidate.text);
    changedCandidate.sourceLength = [...changedCandidate.text].length;
    changedCandidate.privacy.renditionHash = changedCandidate.contentHash;
    changedCandidate.privacy.sourceContentHashes = changedCandidate.evidenceRefs.map(() => changedCandidate.contentHash);
    writeFileSync(carryPath, `${JSON.stringify(receiptTamper, null, 2)}\n`);
    const receiptTamperBytes = readFileSync(carryPath);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 2);
    assert.match(output.stderr, /local receipts/);
    assert.deepEqual(readFileSync(carryPath), receiptTamperBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.curated.json')), reviewBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.prompt-items.json')), laneBytes);
    writeFileSync(carryPath, validCarryBytes);

    const signalTamper = JSON.parse(validCarryBytes);
    signalTamper.weeks[0].entries.find((entry) => entry.category === 'ideas').candidate.signals = [
      'observed-verification', 'recurs',
    ];
    writeFileSync(carryPath, `${JSON.stringify(signalTamper, null, 2)}\n`);
    const signalTamperBytes = readFileSync(carryPath);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 2);
    assert.match(output.stderr, /eligibility signals/);
    assert.deepEqual(readFileSync(carryPath), signalTamperBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.curated.json')), reviewBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.prompt-items.json')), laneBytes);
    writeFileSync(carryPath, validCarryBytes);

    const manualTamper = JSON.parse(validCarryBytes);
    manualTamper.weeks[0].entries[0].automaticThroughWeek = null;
    manualTamper.weeks[0].entries[0].manualTargetWeek = '2024-06-20';
    writeFileSync(carryPath, `${JSON.stringify(manualTamper, null, 2)}\n`);
    const manualTamperBytes = readFileSync(carryPath);
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 2);
    assert.match(output.stderr, /carry entry is invalid|canonical week record/);
    assert.deepEqual(readFileSync(carryPath), manualTamperBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.curated.json')), reviewBytes);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.prompt-items.json')), laneBytes);
    writeFileSync(carryPath, validCarryBytes);

    const configPath = join(f.root, 'honestweek.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.redaction.terms.push('lifecycle quarantine marker');
    writeFileSync(configPath, JSON.stringify(config));
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 0, output.stderr);
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const retired = review.lifecycle.retired.find((row) => row.reason === 'privacy-withheld');
    assert.deepEqual({ subject: retired?.subject, subjectFingerprint: retired?.subjectFingerprint }, {
      subject: null, subjectFingerprint: null,
    });
    assert.equal(JSON.stringify(JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'))).includes(subject), false);
    output = capture();
    assert.equal(await runValidate({ cwd: f.root, argv: ['--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), io: output }), 0, output.stderr);
    output = capture();
    assert.equal(await runBuild({ cwd: f.root, argv: ['--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), io: output }), 0, output.stderr);
    assert.equal(readFileSync(carryPath, 'utf8').includes('lifecycle quarantine marker'), false);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('carry lineage validation rejects a self-consistent recurrence-window reset', () => {
  const f = lifecycleFixture();
  try {
    const config = normalizeConfig(JSON.parse(readFileSync(join(f.root, 'honestweek.config.json'), 'utf8')), f.root);
    const candidate = {
      itemRef:'1'.repeat(64), category:'ideas', discriminator:'unresolved-idea:1', evidenceRefs:['2'.repeat(64)],
      receipts:[{ source:'claude-code', sessionKey:'3'.repeat(64), turn:1, kind:'human-cue', ref:'2'.repeat(64) }],
      timestamp:'2024-06-10T10:00:00.000Z', project:'your-project', isPrivate:false, state:'inbox',
      text:'retain the bounded recurrence window', sourceHash:'4'.repeat(64),
      contentHash:sha256('retain the bounded recurrence window'), sourceLength:36, redactionCount:0,
      changedPercent:0, rawRisk:'low', rawDetectors:[], redactionOps:[], transform:'none', truncated:false,
      signals:['observed-verification'], score:2, selectionReasonCode:'observed-verification',
      selectionReason:'connected to observed verification', decision:'automatic-safe',
      privacy:{ sourceRefs:['2'.repeat(64)], sourceContentHashes:[sha256('retain the bounded recurrence window')],
        renditionHash:sha256('retain the bounded recurrence window'), transform:'none', changedPercent:0,
        rawRisk:'low', residualRisk:'low', decision:'automatic-safe', policyVersion:1 },
    };
    candidate.itemRef = sha256(`ideas\0${candidate.evidenceRefs[0]}\0${candidate.discriminator}`);
    const entry = {
      lineageRef:candidate.itemRef, itemRef:candidate.itemRef, category:'ideas', firstSeenWeek:'2024-06-10',
      lastShownWeek:'2024-06-10', automaticThroughWeek:'2024-06-24', manualTargetWeek:null,
      strength:'automatic', candidate,
    };
    const carry = { version:1, weeks:[
      { week:{ start:'2024-06-10', end:'2024-06-16' }, entries:[entry], retired:[] },
      { week:{ start:'2024-06-17', end:'2024-06-23' }, entries:[{
        ...structuredClone(entry), firstSeenWeek:'2024-06-17', lastShownWeek:'2024-06-17',
      }], retired:[] },
    ], tombstones:[] };
    assert.throws(() => validateCarry(carry, config), /lineage continuity/);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('week reset preserves an older authoritative carry tombstone', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      'review historical reset scope with verification\nunresolved idea: preserve the original deletion week identity',
      'Decision: carry tombstone weeks remain authoritative',
      'review historical reset recovery with verification',
      'Next step: reject a reset aimed at the wrong reporting week');
    setItemsWeek(f.root, '2024-06-10', '2024-06-16');
    let output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    const deletedRef = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8')).candidates
      .find((candidate) => candidate.category === 'ideas').itemRef;
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['delete',deletedRef.slice(0,12),'--yes','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    output = capture();
    assert.equal(await runBuild({ cwd:f.root, argv:['--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), io:output }), 0, output.stderr);
    writeWeekSources(f, 1, 'review the following reset week with verification',
      'Decision: do not relabel historical blockers', 'review the following reset recovery with verification',
      'Technique: compare reset week and item identity together');
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W25'], now:new Date('2024-06-24T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    const carryPath = join(f.root, 'honestweek.carry.json');
    const reviewPath = join(f.root, 'honestweek.curated.json');
    const carryBefore = readFileSync(carryPath);
    const reviewBefore = readFileSync(reviewPath);
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['reset-tombstones','--week','2024-W25','--yes'], now:new Date('2024-06-24T12:00:00.000Z'), io:output }), 2);
    assert.match(output.stderr, /matched no removable tombstone/);
    assert.deepEqual(readFileSync(carryPath), carryBefore);
    assert.deepEqual(readFileSync(reviewPath), reviewBefore);
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['reset-tombstones','--week','2024-W24','--yes'], now:new Date('2024-06-24T12:00:00.000Z'), io:output }), 0, output.stderr);
    assert.equal(JSON.parse(readFileSync(carryPath, 'utf8')).tombstones.some((row) => row.itemRef === deletedRef), false);
    assert.equal(JSON.parse(readFileSync(reviewPath, 'utf8')).tombstones.some((row) => row.itemRef === deletedRef), false);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('multiple current duplicates of one carried lineage abort without changing state', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const subject = 'retain the duplicate suppression lineage through bounded weekly review';
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0, `review the first duplicate week with verification\nunresolved idea: ${subject}`,
      'Decision: establish one carried lineage', 'review the first duplicate recovery week with verification',
      'Technique: bind duplicate suppression to exact receipts');
    await runCycle(f, '2024-W24', '2024-06-10', '2024-06-16', new Date('2024-06-17T12:00:00.000Z'));
    writeWeekSources(f, 1,
      `review the ambiguous duplicate week with verification\nunresolved idea: ${subject}\nunresolved idea: ${subject} again`,
      'Decision: abort ambiguous duplicate replacement', 'review the second duplicate recovery week with verification',
      'Technique: preserve prior state on duplicate ambiguity');
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    const before = ['honestweek.curated.json','honestweek.prompt-items.json','honestweek.carry.json']
      .map((name) => [name, readFileSync(join(f.root, name))]);
    const output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W25'], now:new Date('2024-06-24T12:00:00.000Z'), roots:f.roots, io:output }), 2);
    assert.match(output.stderr, /multiple current candidates match a carried lineage/);
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(f.root, name)), bytes);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('validate and build re-resolve carried receipts after prepare', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const subject = 'retain the authenticated carry receipt through the next weekly build';
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0, `review carried receipt reconstruction with verification\nunresolved idea: ${subject}`,
      'Decision: reconstruct carry receipts before emission', 'review carried receipt recovery with verification',
      'Next step: reject stale carried source bytes');
    await runCycle(f, '2024-W24', '2024-06-10', '2024-06-16', new Date('2024-06-17T12:00:00.000Z'));
    writeWeekSources(f, 1, 'review the next receipt week with verification',
      'Decision: keep the prior output unchanged on stale carry', 'review the next receipt recovery week with verification',
      'Technique: bind validate and build to local carried sources');
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    let output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W25'], now:new Date('2024-06-24T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    const outputPath = join(f.root, 'site-data.json');
    const outputBefore = readFileSync(outputPath);
    const sourcePath = join(f.claude, 'projects', 'your-project', 'week-0.jsonl');
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace(subject, 'changed source text that invalidates the carried receipt'));
    output = capture();
    assert.equal(await runValidate({ cwd:f.root, argv:['--week','2024-W25'], now:new Date('2024-06-24T12:00:00.000Z'), io:output }), 2);
    assert.match(output.stderr, /carried receipt|digest source changed/);
    assert.deepEqual(readFileSync(outputPath), outputBefore);
    output = capture();
    assert.equal(await runBuild({ cwd:f.root, argv:['--week','2024-W25'], now:new Date('2024-06-24T12:00:00.000Z'), io:output }), 2);
    assert.match(output.stderr, /carried receipt|digest source changed/);
    assert.deepEqual(readFileSync(outputPath), outputBefore);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('carry validation requires auditable replacement and retirement transitions', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const subject = 'retain one auditable replacement lineage across the bounded weekly digest';
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0, `review replacement transitions with verification\nunresolved idea: ${subject}`,
      'Decision: require one superseded receipt', 'review replacement recovery with verification',
      'Technique: validate carry transitions across adjacent records');
    await runCycle(f, '2024-W24', '2024-06-10', '2024-06-16', new Date('2024-06-17T12:00:00.000Z'));
    writeWeekSources(f, 1, `review replacement transitions again with verification\nunresolved idea: ${subject}`,
      'Decision: preserve the original lineage identity', 'review replacement recovery again with verification',
      'Technique: pair the new receipt with a superseded audit row');
    await runCycle(f, '2024-W25', '2024-06-17', '2024-06-23', new Date('2024-06-24T12:00:00.000Z'));
    const config = normalizeConfig(JSON.parse(readFileSync(join(f.root, 'honestweek.config.json'), 'utf8')), f.root);
    const carry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8'));
    const latest = carry.weeks.at(-1);
    const replacement = latest.entries.find((entry) => entry.category === 'ideas');
    const superseded = latest.retired.find((row) =>
      row.lineageRef === replacement.lineageRef && row.reason === 'superseded');
    assert.ok(superseded);

    const missingAudit = structuredClone(carry);
    const removedIndex = missingAudit.weeks.at(-1).retired.findIndex((row) =>
      row.lineageRef === replacement.lineageRef && row.reason === 'superseded');
    missingAudit.weeks.at(-1).retired.splice(removedIndex, 1);
    assert.throws(() => validateCarry(missingAudit, config), /lacks its superseded retirement/);

    const contradictory = structuredClone(carry);
    contradictory.weeks.at(-1).retired.push({
      ...structuredClone(superseded), itemRef:replacement.itemRef, reason:'automatic-limit', terminalRef:null,
    });
    contradictory.weeks.at(-1).retired.sort((a, b) =>
      a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    assert.throws(() => validateCarry(contradictory, config), /active and terminally retired/);

    const changedStrength = structuredClone(carry);
    changedStrength.weeks.at(-1).entries.find((entry) => entry.lineageRef === replacement.lineageRef).strength = 'explicit';
    assert.throws(() => validateCarry(changedStrength, config), /lineage continuity/);

    const retainedBase = structuredClone(carry);
    retainedBase.weeks = [retainedBase.weeks.at(-1)];
    const baseWithoutReplacement = structuredClone(retainedBase);
    baseWithoutReplacement.weeks[0].entries = baseWithoutReplacement.weeks[0].entries.filter((entry) =>
      entry.lineageRef !== replacement.lineageRef);
    assert.throws(() => validateCarry(baseWithoutReplacement, config), /lacks one distinct active replacement/);

    const baseSelfReplacement = structuredClone(retainedBase);
    baseSelfReplacement.weeks[0].retired.find((row) =>
      row.lineageRef === replacement.lineageRef && row.reason === 'superseded').itemRef = replacement.itemRef;
    baseSelfReplacement.weeks[0].retired.sort((a, b) =>
      a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    assert.throws(() => validateCarry(baseSelfReplacement, config), /lacks one distinct active replacement/);

    const baseMultipleSuperseded = structuredClone(retainedBase);
    baseMultipleSuperseded.weeks[0].retired.push({
      ...structuredClone(superseded), itemRef:'f'.repeat(64),
    });
    baseMultipleSuperseded.weeks[0].retired.sort((a, b) =>
      a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    assert.throws(() => validateCarry(baseMultipleSuperseded, config), /multiple superseded retirements/);

    const orphanPrivacy = structuredClone(carry);
    const orphanSubject = 'fabricated but superficially safe retirement subject';
    orphanPrivacy.weeks.at(-1).retired.push({
      lineageRef:'a'.repeat(64), itemRef:'b'.repeat(64), category:'ideas', subject:orphanSubject,
      subjectFingerprint:subjectFingerprint(orphanSubject), reason:'privacy-withheld', terminalRef:null,
    });
    orphanPrivacy.weeks.at(-1).retired.sort((a, b) =>
      a.lineageRef.localeCompare(b.lineageRef) || a.itemRef.localeCompare(b.itemRef));
    assert.throws(() => validateCarry(orphanPrivacy, config), /no safe immediately prior active lineage/);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('manual renewal admits a public-safe capacity omission for one digest', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    const configPath = join(f.root, 'honestweek.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.curation.maxItems = 1;
    writeFileSync(configPath, JSON.stringify(config));
    writeWeekSources(f, 0, 'review the capacity renewal week with verification',
      'Decision: select the highest scored current row', 'review the capacity renewal recovery with verification',
      'Technique: renew one safe capacity omission explicitly');
    setItemsWeek(f.root, '2024-06-10', '2024-06-16');
    let output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    let review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const omitted = review.candidates.find((candidate) =>
      ['category-capacity','overall-capacity'].includes(candidate.decision) &&
      candidate.privacy.decision === 'automatic-safe');
    assert.ok(omitted);
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['carry-forward',omitted.itemRef.slice(0,12),'--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    assert.equal(review.renewals.some((renewal) => renewal.itemRef === omitted.itemRef), true);
    output = capture();
    assert.equal(await runBuild({ cwd:f.root, argv:['--week','2024-W24'], now:new Date('2024-06-17T12:00:00.000Z'), io:output }), 0, output.stderr);
    const firstCarry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8')).weeks[0].entries
      .find((entry) => entry.itemRef === omitted.itemRef);
    assert.deepEqual({ strength:firstCarry.strength, manualTargetWeek:firstCarry.manualTargetWeek },
      { strength:'explicit', manualTargetWeek:'2024-06-17' });
    writeWeekSources(f, 1, 'review the renewed capacity week with verification',
      'Decision: preserve automatic capacity for ordinary rows', 'review the renewed capacity recovery with verification',
      'Technique: show the explicit renewal outside automatic caps');
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    output = capture();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare','--week','2024-W25'], now:new Date('2024-06-24T12:00:00.000Z'), roots:f.roots, io:output }), 0, output.stderr);
    const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    assert.equal(lane.items.some((item) => item.itemRef === omitted.itemRef && item.curationState === 'renewed'), true);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('one terminal receipt cannot retire multiple carried lineages', async () => {
  const f = lifecycleFixture();
  const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  const priorCodex = process.env.CODEX_HOME;
  const subject = 'resolve the shared bounded recovery subject with exact local evidence';
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      `review ambiguous terminal matching with receipt evidence\nunresolved idea: ${subject}`,
      'Decision: require one terminal receipt to identify one lineage',
      'review ambiguous terminal matching with distinct receipt evidence',
      `Next step: ${subject}`,
    );
    await runCycle(f, '2024-W24', '2024-06-10', '2024-06-16', new Date('2024-06-17T12:00:00.000Z'));
    writeWeekSources(f, 1,
      `review the terminal ambiguity with exact receipt evidence\npicked up: ${subject}`,
      'Decision: abort an ambiguous terminal transition before state changes',
      'review the next terminal week with distinct receipt evidence',
      'Technique: retain both prior lineages when terminal evidence is ambiguous',
    );
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    const paths = ['honestweek.prompts.json', 'honestweek.curated.json', 'honestweek.prompt-items.json', 'honestweek.carry.json'];
    const before = new Map(paths.map((name) => [name, readFileSync(join(f.root, name))]));
    const output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['prepare', '--week', '2024-W25'], now: new Date('2024-06-24T12:00:00.000Z'), roots: f.roots, io: output }), 2);
    assert.match(output.stderr, /matches multiple carried lineages/);
    for (const name of paths) assert.deepEqual(readFileSync(join(f.root, name)), before.get(name), name);
  } finally {
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    rmSync(f.root, { recursive: true, force: true });
  }
});
