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
import { CARRY_PENDING } from '../lib/digest-carry.mjs';

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
      maxItems: 50, automaticMinScore: 2, automaticCarryWeeks: 2, retentionWeeks: 12,
      categoryCaps: { prompts: 10, ideas: 10, techniques: 10, decisions: 10, reversals: 10, nextSteps: 10 },
    },
    output: { mode: 'site', adapter },
  }));
  return { root, project, claude, codex, roots: { 'claude-code': join(claude, 'projects'), codex } };
}

function setItemsWeek(root, start, end) {
  writeFileSync(join(root, 'honestweek.items.json'), JSON.stringify({ week: { start, end }, items: [] }));
}

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
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude;
    process.env.CODEX_HOME = f.codex;
    writeWeekSources(f, 0,
      `review the first bounded week with receipt evidence and local verification\nunresolved idea: ${idea}`,
      'Decision: use the closed lifecycle transition table for weekly state',
      'review the first recovery week with receipt evidence and local verification',
      `Next step: ${next}`,
    );
    await runCycle(f, '2024-W24', '2024-06-10', '2024-06-16', new Date('2024-06-17T12:00:00.000Z'));
    let carry = JSON.parse(readFileSync(join(f.root, 'honestweek.carry.json'), 'utf8'));
    assert.equal(carry.weeks.length, 1);
    assert.equal(carry.weeks[0].entries.length, 2);

    writeWeekSources(f, 1,
      'review the second bounded week with distinct receipt evidence and verification',
      'Decision: retain one explicit manual renewal route for this digest',
      'review the second recovery week with distinct receipt evidence and verification',
      'Technique: verify the canonical sidecars before the configured site transform',
    );
    setItemsWeek(f.root, '2024-06-17', '2024-06-23');
    let output = capture();
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

    for (const boundary of ['openSync','writeFileSync','fsyncSync','renameSync']) {
      writeFileSync(artifact, 'prior artifact\n');
      rmSync(carryPath, { force: true }); rmSync(pendingPath, { force: true });
      output = capture();
      assert.equal(await runBuild({ cwd: f.root, now: new Date('2024-06-17T12:00:00.000Z'), io: output,
        transactionFs: { pending: failAtomic(boundary) } }), 2, `pending ${boundary}`);
      assert.equal(readFileSync(artifact, 'utf8'), 'prior artifact\n', `pending ${boundary}`);
      assert.equal(existsSync(carryPath), false, `pending ${boundary}`);
      assert.equal(existsSync(pendingPath), false, `pending ${boundary}`);
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

    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 0, output.stderr);
    assert.match(output.stdout, /no carry transaction is pending/);
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
    output = capture();
    assert.equal(await runDigest({ cwd: f.root, argv: ['recover'], now: new Date('2024-06-17T12:00:00.000Z'), io: output }), 2);
    assert.match(output.stderr, /--discard-pending/);
    assert.deepEqual(readFileSync(pendingPath), pendingBytes);
    assert.equal(existsSync(carryPath), false);
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
