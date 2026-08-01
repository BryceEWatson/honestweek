import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractDigestCues, scanDigestEvidence } from '../lib/digest-evidence.mjs';
import { runDigest } from '../lib/digest.mjs';
import { runPrompts } from '../lib/prompts.mjs';
import { runValidate } from '../lib/validate.mjs';
import { runBuild } from '../lib/build.mjs';
import { curateDigest, DIGEST_CATEGORIES } from '../lib/digest-curation.mjs';
import { DIGEST_PENDING, makeDigestPending } from '../lib/digest-store.mjs';
import { promptIdentity, sha256 } from '../lib/prompt-identity.mjs';
import { scanPromptSources } from '../lib/prompt-adapters.mjs';
import { mergePromptStore } from '../lib/prompt-store.mjs';
import { curatePrompts } from '../lib/prompt-curation.mjs';
import { hasRecurringText } from '../lib/curation-similarity.mjs';
import { loadConfig, OUTPUT_MODES } from '../lib/config.mjs';
import { isReservedDigestItem } from '../lib/digest-schema.mjs';
import { buildPageModel, render as renderPage } from '../lib/emit/page.mjs';

const REPRESENTATIVE_PROOF = JSON.parse(readFileSync(
  new URL('./fixtures/representative-proof.expected.json', import.meta.url), 'utf8',
));

function io() {
  let stdout = ''; let stderr = ''; let exitCode = null;
  return {
    out: (value) => { stdout += value; }, err: (value) => { stderr += value; },
    exit: (value) => { exitCode = value; return value; },
    get stdout() { return stdout; }, get stderr() { return stderr; }, get exitCode() { return exitCode; },
  };
}
function jsonl(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

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
function digestBytes(root) {
  return Object.fromEntries([
    ['promptStoreHash', 'honestweek.prompts.json'],
    ['curatedHash', 'honestweek.curated.json'],
    ['laneHash', 'honestweek.prompt-items.json'],
  ].map(([key, name]) => [key, readFileSync(join(root, name))]));
}
function digestHashes(bytes) {
  return Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, sha256(value)]));
}
function writeDigestBytes(root, bytes) {
  writeFileSync(join(root, 'honestweek.prompts.json'), bytes.promptStoreHash);
  writeFileSync(join(root, 'honestweek.curated.json'), bytes.curatedHash);
  writeFileSync(join(root, 'honestweek.prompt-items.json'), bytes.laneHash);
}

let commitCounter = 0;
function git(dir, args, env = process.env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding:'utf8', env, stdio:['ignore','pipe','pipe'] }).trim();
}
function verifiedCommit(dir, message = 'verify the ordinary work item') {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'you@example.com']);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  commitCounter += 1;
  writeFileSync(join(dir, `verified-${commitCounter}.txt`), 'verified\n');
  const env = {
    ...process.env, GIT_AUTHOR_EMAIL:'you@example.com', GIT_COMMITTER_EMAIL:'you@example.com',
    GIT_AUTHOR_NAME:'Dev', GIT_COMMITTER_NAME:'Dev',
    GIT_AUTHOR_DATE:'2024-06-13T09:00:00Z', GIT_COMMITTER_DATE:'2024-06-13T09:00:00Z',
  };
  git(dir, ['add', '-A'], env); git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']);
}

function claudeVerifiedTurn({ sessionId, cwd, prompt, final, at = '2024-06-13T10:00:00.000Z' }) {
  const base = new Date(at).getTime();
  return [
    { type:'user', sessionId, timestamp:new Date(base).toISOString(), cwd, message:{ content:prompt } },
    { type:'assistant', sessionId, timestamp:new Date(base + 1000).toISOString(), cwd, message:{ content:[{ type:'tool_use', name:'Bash', id:`${sessionId}-verify` }] } },
    { type:'user', sessionId, timestamp:new Date(base + 2000).toISOString(), cwd, message:{ content:[{ type:'tool_result', tool_use_id:`${sessionId}-verify`, content:'tests passed' }] } },
    { type:'assistant', sessionId, timestamp:new Date(base + 3000).toISOString(), cwd, message:{ content:[{ type:'text', text:final }] } },
  ];
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'honestweek-digest-'));
  const project = join(root, 'project'); const claude = join(root, 'claude'); const codex = join(root, 'codex');
  mkdirSync(project, { recursive: true });
  const suffix = 'while removing person@example.com from this deliberately detailed local weekly summary before any public-safe artifact is written';
  const commonPrompt = `please verify this balanced weekly digest with enough neutral words and exact source receipts ${suffix}`;
  const idea = `keep evidence boundaries deterministic ${suffix}`;
  const nextStep = `document the release gate after local verification ${suffix}`;
  jsonl(join(claude, 'projects', 'p', 'session.jsonl'), [
    { type:'user', sessionId:'claude-session', timestamp:'2024-06-11T10:00:00.000Z', cwd:project, message:{ content:`${commonPrompt}\nidea: ${idea}` } },
    { type:'assistant', sessionId:'claude-session', timestamp:'2024-06-11T10:01:00.000Z', cwd:project, message:{ content:[{ type:'tool_use', name:'Bash', id:'verify-1' }] } },
    { type:'user', sessionId:'claude-session', timestamp:'2024-06-11T10:02:00.000Z', cwd:project, message:{ content:[{ type:'tool_result', tool_use_id:'verify-1', content:'4 tests passed' }] } },
    { type:'assistant', sessionId:'claude-session', timestamp:'2024-06-11T10:03:00.000Z', cwd:project, message:{ content:[{ type:'text', text:`Decision: use one validated digest lane ${suffix}\nTechnique: reconstruct the lane before every build ${suffix}\nNext step: ${nextStep}` }] } },
  ]);
  jsonl(join(codex, 'sessions', '2024', 'session.jsonl'), [
    { type:'session_meta', payload:{ id:'codex-session', cwd:project } },
    { type:'turn_context', payload:{ cwd:project } },
    { type:'event_msg', timestamp:'2024-06-12T10:00:00.000Z', payload:{ type:'user_message', message:commonPrompt } },
    { type:'response_item', payload:{ type:'function_call', name:'shell_command', call_id:'verify-2' } },
    { type:'response_item', payload:{ type:'function_call_output', call_id:'verify-2', output:'# pass 5\n# fail 0' } },
    { type:'event_msg', timestamp:'2024-06-12T10:03:00.000Z', payload:{ type:'agent_message', message:`Ideas:\n- ${idea}\n\nReversal: replace the inferred category with an explicit cue ${suffix}\nNext steps:\n- ${nextStep}` } },
  ]);
  const config = {
    identity:{ authorEmails:['you@example.com'] },
    week:{ startsOn:'monday', timezone:'UTC' },
    repos:[{ path:project, label:'your-project', role:'featured' }],
    redaction:{ codenames:[], names:[], terms:[] },
    output:{ mode:'page', file:join(root, 'report.html') },
  };
  writeFileSync(join(root, 'honestweek.config.json'), JSON.stringify(config));
  writeFileSync(join(root, 'honestweek.items.json'), JSON.stringify({ week:{ start:'2024-06-10', end:'2024-06-16' }, items:[] }));
  return {
    root, project, claude, codex, config,
    roots:{ 'claude-code':join(claude, 'projects'), codex },
    now:new Date('2024-06-17T12:00:00.000Z'),
    expected:{ idea, nextStep, suffix, commonPrompt },
  };
}

async function scanFixture(f) {
  const config = loadConfig(join(f.root, 'honestweek.config.json'));
  const scanned = await scanPromptSources({
    config,
    weekStart:new Date('2024-06-10T00:00:00.000Z'),
    weekEnd:new Date('2024-06-17T00:00:00.000Z'),
    roots:f.roots,
    now:f.now,
  });
  const promptStore = mergePromptStore(null, scanned, f.now);
  const digest = await scanDigestEvidence({ config, promptStore, roots:f.roots, sourceStatus:scanned.sourceStatus });
  return { config, scanned, promptStore, digest };
}

test('closed digest grammar accepts labelled and heading-scoped cues only', () => {
  const got = extractDigestCues('Idea: one useful idea\n## Decisions\n- choose the strict path\n\nordinary prose\nNext step: later', {
    envelopeKind:'assistant-final', observedVerification:true,
  });
  assert.deepEqual(got.cues.map((cue) => [cue.category, cue.raw, cue.ordinal]), [
    ['ideas','one useful idea',1], ['decisions','choose the strict path',2], ['nextSteps','later',3],
  ]);
  const human = extractDigestCues('Next step: must not mine this\nTechnique: verified shape', {
    envelopeKind:'human-cue', observedVerification:false,
  });
  assert.equal(human.cues.length, 0);
  const ordinal = extractDigestCues('Next step: not eligible here\nIdea: still second in source order', {
    envelopeKind:'human-cue', observedVerification:true,
  });
  assert.equal(ordinal.cues[0].ordinal, 2);
  const oversized = extractDigestCues(`Idea: ${'x'.repeat(1001)}`, { envelopeKind:'assistant-final' });
  assert.equal(oversized.unsupported.ideas, 1);
  const forms = extractDigestCues('+ Decided: choose the bounded path\n* Reversed: drop the broader path\n## Techniques:\n1) run the local gate\n\n# Ideas\n2. retain the receipt', {
    envelopeKind:'assistant-final', observedVerification:true,
  });
  assert.deepEqual(forms.cues.map((cue) => [cue.category, cue.ordinal]), [
    ['decisions',1], ['reversals',2], ['techniques',3], ['ideas',4],
  ]);
  assert.equal(isReservedDigestItem({ kind:'idea' }), false);
  assert.equal(isReservedDigestItem({ publicDisposition:'automatic-safe' }), false);
  assert.equal(isReservedDigestItem({ kind:'idea', publicDisposition:'automatic-safe' }), true);
});

test('lexical recurrence pins the four-token and overlap boundaries used by ideas and next steps', () => {
  assert.equal(hasRecurringText('alpha beta gamma', 'alpha beta gamma'), false, 'three tokens');
  assert.equal(hasRecurringText('alpha beta gamma delta', 'alpha beta gamma delta'), true, 'four identical tokens');
  assert.equal(hasRecurringText('alpha beta gamma delta', 'alpha beta gamma epsilon'), false, 'three of five is below 0.75');
  assert.equal(hasRecurringText('alpha beta gamma delta', 'alpha beta gamma delta epsilon'), true, 'four of five meets 0.75');
});

test('version 1 prompt page grouping retains Slice 1 order while version 2 uses digest order', () => {
  const config = { repos:[{ label:'your-project', role:'featured' }] };
  const v1 = [
    { id:'prompt-old', kind:'prompt', publicDisposition:'automatic-safe', status:'', project:'Prompt highlights', date:'2024-06-10', summary:'old prompt', receipt:{ sessionId:'a' }, snippets:[] },
    { id:'prompt-new', kind:'prompt', publicDisposition:'automatic-safe', status:'', project:'Prompt highlights', date:'2024-06-12', summary:'new prompt', receipt:{ sessionId:'b' }, snippets:[] },
    { id:'work', repo:'your-project', status:'shipped', date:'2024-06-15', summary:'ordinary work' },
  ];
  const v1Model = buildPageModel({ items:v1, config, week:{ start:'2024-06-10', end:'2024-06-16' } });
  assert.deepEqual(v1Model.groups.map((group) => group.label), ['your-project','Prompt highlights']);
  assert.deepEqual(v1Model.groups[1].items.map((item) => item.id), ['prompt-new','prompt-old']);
  assert.equal(v1Model.groups[1].items.every((item) => item.kind === 'prompt'), true);

  const v2 = [
    v1[2],
    { id:'next', kind:'next-step', category:'nextSteps', receipts:[{}], publicDisposition:'automatic-safe', status:'', project:'Next steps', date:'2024-06-16', summary:'next', receipt:{ sessionId:'c' }, snippets:[] },
    { id:'idea', kind:'idea', category:'ideas', receipts:[{}], publicDisposition:'automatic-safe', status:'', project:'Ideas', date:'2024-06-11', summary:'idea', receipt:{ sessionId:'d' }, snippets:[] },
  ];
  const v2Model = buildPageModel({ items:v2, config, week:{ start:'2024-06-10', end:'2024-06-16' } });
  assert.deepEqual(v2Model.groups.map((group) => group.label), ['your-project','Ideas','Next steps']);
  assert.equal(v2Model.groups.slice(1).every((group) => group.items[0].kind === 'session'), true);

  const promptCollision = buildPageModel({
    items:[v1[0], { id:'same-label-work', repo:'Prompt highlights', status:'shipped', date:'2024-06-14', summary:'same label' }],
    config:{ repos:[{ label:'Prompt highlights', role:'featured' }] },
    week:{ start:'2024-06-10', end:'2024-06-16' },
  });
  assert.equal(promptCollision.groups.length, 1);
  assert.deepEqual(promptCollision.groups[0].items.map((item) => item.id), ['same-label-work','prompt-old']);

  const otherCollision = buildPageModel({
    items:[
      { id:'configured-other', repo:'other', status:'shipped', date:'2024-06-14', summary:'configured other' },
      { id:'loose-other', status:'shipped', date:'2024-06-15', summary:'loose other' },
    ],
    config:{ repos:[{ label:'other', role:'featured' }] },
    week:{ start:'2024-06-10', end:'2024-06-16' },
  });
  assert.deepEqual(otherCollision.groups.flatMap((group) => group.items.map((item) => item.id)), ['loose-other']);

  const ordinaryIdeas = buildPageModel({
    items:[{ id:'work-idea', repo:'Ideas', status:'shipped', date:'2024-06-14', summary:'ordinary work' }],
    config:{ repos:[{ label:'Ideas', role:'featured' }] },
    week:{ start:'2024-06-10', end:'2024-06-16' },
  });
  const ordinaryHtml = renderPage(ordinaryIdeas);
  assert.match(ordinaryHtml, /Every line carries a status badge and a git receipt/);
  assert.doesNotMatch(ordinaryHtml, /work claims retain their git verification/);
});

test('prompt-only curation deliberately replaces a balanced lane and deletion names the active regeneration path', async () => {
  const f = fixture();
  try {
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const prompt = JSON.parse(readFileSync(join(f.root, 'honestweek.prompts.json'), 'utf8')).prompts[0];
    output = io();
    assert.equal(await runPrompts({ cwd:f.root, argv:['delete',prompt.ref.slice(0, 12),'--yes'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    assert.match(output.stdout, /Run honestweek digest prepare, honestweek validate/);

    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    output = io();
    assert.equal(await runPrompts({ cwd:f.root, argv:['curate'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    assert.match(output.stdout, /Replaced the balanced version 2 lane with a prompt-only version 1 lane/);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8')).version, 1);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('a missing lane and a canonical empty version 1 lane produce identical bytes in every existing output mode', async () => {
  const f = fixture();
  const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude; process.env.CODEX_HOME = f.codex;
    verifiedCommit(f.project);
    for (const mode of OUTPUT_MODES) {
      const outputFile = join(f.root, `without-lane-${mode}.${mode === 'page' ? 'html' : 'md'}`);
      const siteArtifact = join(f.root, `without-lane-${mode}.json`);
      let outputConfig;
      if (mode === 'site') {
        const adapter = join(f.root, `adapter-${mode}.mjs`);
        writeFileSync(adapter, `export const artifact=${JSON.stringify(siteArtifact)}; export function transform(model){return {items:model.items};}\n`);
        outputConfig = { mode, adapter };
      } else outputConfig = { mode, file:outputFile };
      writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({ ...f.config, output:outputConfig }));
      const target = mode === 'site' ? siteArtifact : outputFile;

      let output = io();
      assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 0, `${mode} missing: ${output.stderr}`);
      const absentBytes = readFileSync(target);

      const { config, promptStore } = await scanFixture(f);
      for (const prompt of promptStore.prompts) prompt.state = 'hidden';
      writeFileSync(join(f.root, 'honestweek.prompts.json'), `${JSON.stringify(promptStore, null, 2)}\n`);
      const lane = curatePrompts(promptStore, config, { start:'2024-06-10', end:'2024-06-16' }, f.now, {
        outputBinding:{ mode, adapterHash:null, objectives:false },
      });
      assert.equal(lane.items.length, 0, mode);
      writeFileSync(join(f.root, 'honestweek.prompt-items.json'), `${JSON.stringify(lane, null, 2)}\n`);

      output = io();
      assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 0, `${mode} empty: ${output.stderr}`);
      assert.deepEqual(readFileSync(target), absentBytes, mode);
      unlinkSync(join(f.root, 'honestweek.prompt-items.json'));
      unlinkSync(join(f.root, 'honestweek.prompts.json'));
    }
  } finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('digest source scan pins exact receipts, boundaries, exclusions, and both tools', async () => {
  const f = fixture();
  try {
    const boundary = join(f.claude, 'projects', 'p', 'boundary.jsonl');
    jsonl(boundary, [
      { type:'user', sessionId:'boundary-session', timestamp:'2024-06-09T10:00:00.000Z', cwd:f.project, message:{ content:'outside before' } },
      { type:'assistant', sessionId:'boundary-session', timestamp:'2024-06-09T10:01:00.000Z', cwd:f.project, message:{ content:'Idea: before-week cue must stay excluded' } },
      { type:'user', sessionId:'boundary-session', timestamp:'2024-06-13T10:00:00.000Z', cwd:f.project, message:{ content:'inside boundary prompt' } },
      { type:'assistant', sessionId:'boundary-session', timestamp:'2024-06-13T10:01:00.000Z', cwd:f.project, message:{ content:`Idea: inside boundary cue\nIdea: ${'x'.repeat(1001)}` } },
      { type:'user', sessionId:'boundary-session', timestamp:'2024-06-17T10:00:00.000Z', cwd:f.project, message:{ content:'outside after' } },
      { type:'assistant', sessionId:'boundary-session', timestamp:'2024-06-17T10:01:00.000Z', cwd:f.project, message:{ content:'Idea: after-week cue must stay excluded' } },
    ]);
    jsonl(join(f.claude, 'projects', 'p', 'subagents', 'agent.jsonl'), claudeVerifiedTurn({
      sessionId:'subagent-session', cwd:f.project, prompt:'subagent prompt must stay excluded',
      final:'Idea: subagent cue must stay excluded',
    }));
    jsonl(join(f.claude, 'projects', 'p', 'control.jsonl'), [
      { type:'user', sessionId:'control-session', timestamp:'2024-06-13T11:00:00.000Z', cwd:f.project, message:{ content:'<command-message>Idea: control cue must stay excluded</command-message>' } },
      { type:'assistant', sessionId:'control-session', timestamp:'2024-06-13T11:01:00.000Z', cwd:f.project, message:{ content:'Idea: orphaned control response must stay excluded' } },
    ]);
    jsonl(join(f.codex, 'sessions', '2024', 'noise.jsonl'), [
      { type:'session_meta', payload:{ id:'noise-session', cwd:f.project } },
      { type:'event_msg', timestamp:'2024-06-14T10:00:00.000Z', payload:{ type:'user_message', message:'ordinary accepted Codex prompt' } },
      { type:'response_item', payload:{ type:'reasoning', summary:[{ type:'summary_text', text:'Idea: reasoning cue must stay excluded' }] } },
      { type:'response_item', payload:{ type:'function_call', name:'shell_command', call_id:'noise-call' } },
      { type:'response_item', payload:{ type:'function_call_output', call_id:'noise-call', output:'Idea: tool output cue must stay excluded' } },
      { type:'event_msg', timestamp:'2024-06-14T10:03:00.000Z', payload:{ type:'agent_message', message:'Decision: accepted final envelope cue' } },
    ]);
    jsonl(join(f.codex, 'sessions', '2024', 'subagents', 'agent.jsonl'), [
      { type:'session_meta', payload:{ id:'codex-subagent-session', cwd:f.project } },
      { type:'event_msg', timestamp:'2024-06-14T11:00:00.000Z', payload:{ type:'user_message', message:'Codex subagent prompt must stay excluded' } },
      { type:'event_msg', timestamp:'2024-06-14T11:03:00.000Z', payload:{ type:'agent_message', message:'Idea: Codex subagent cue must stay excluded' } },
    ]);

    const { promptStore, digest } = await scanFixture(f);
    const claudeIdentity = promptIdentity('claude-code', 'claude-session', 1);
    const ideaHash = sha256(f.expected.idea);
    const ideaCanonical = `claude-code\0${claudeIdentity.sessionKey}\0${1}\0human-cue\0${1}\0${ideaHash}`;
    const claudeIdea = digest.evidence.find((value) => value.source === 'claude-code' && value.kind === 'human-cue');
    assert.deepEqual({
      ref:claudeIdea.evidenceRef, canonical:claudeIdea.evidenceCanonical,
      category:claudeIdea.category, turn:claudeIdea.turn, ordinal:claudeIdea.ordinal,
      promptRef:claudeIdea.promptRef, sourceHash:claudeIdea.sourceHash,
    }, {
      ref:sha256(ideaCanonical), canonical:ideaCanonical,
      category:'ideas', turn:1, ordinal:1,
      promptRef:claudeIdentity.ref, sourceHash:ideaHash,
    });

    const codexIdentity = promptIdentity('codex', 'codex-session', 1);
    const reversalRaw = `replace the inferred category with an explicit cue ${f.expected.suffix}`;
    const reversalHash = sha256(reversalRaw);
    const reversalCanonical = `codex\0${codexIdentity.sessionKey}\0${1}\0assistant-final\0${2}\0${reversalHash}`;
    const reversal = digest.evidence.find((value) => value.category === 'reversals');
    assert.equal(reversal.evidenceCanonical, reversalCanonical);
    assert.equal(reversal.evidenceRef, sha256(reversalCanonical));
    assert.equal(reversal.promptRef, codexIdentity.ref);

    const boundaryCue = digest.evidence.find((value) => value.text === 'inside boundary cue');
    assert.deepEqual([boundaryCue?.source, boundaryCue?.turn, boundaryCue?.ordinal], ['claude-code', 2, 1]);
    assert.deepEqual([...new Set(digest.evidence.map((value) => value.source))].sort(), ['claude-code','codex']);
    assert.equal(digest.scanExcluded.ideas['assistant-final'], 1);
    assert.deepEqual(digest.accounting, {
      scannedPromptCount:promptStore.prompts.length,
      acceptedPromptCount:promptStore.prompts.length,
      scannedCueCount:digest.evidence.length + 1,
      acceptedCueCount:digest.evidence.length,
    });
    const writtenEvidence = JSON.stringify(digest.evidence);
    const suppressed = [
      'before-week cue', 'after-week cue', 'subagent cue', 'Codex subagent cue', 'control cue',
      'orphaned control response', 'reasoning cue', 'tool output cue',
    ];
    for (const excluded of suppressed) assert.doesNotMatch(writtenEvidence, new RegExp(excluded));
    assert.deepEqual({
      acceptedSources:[...new Set(digest.evidence.map((value) => value.source))].sort(),
      ideaAssistantFinalExcluded:digest.scanExcluded.ideas['assistant-final'], suppressed,
    }, REPRESENTATIVE_PROOF.closedCueSuppression);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('digest second scan rejects deletion, malformed input, and new in-week turns without leaking paths', async () => {
  const cases = [
    {
      name:'deleted source',
      mutate:(f, file) => unlinkSync(file),
    },
    {
      name:'malformed source',
      mutate:(f, file) => writeFileSync(file, `${readFileSync(file, 'utf8')}{malformed\n`),
    },
    {
      name:'new in-week turn',
      mutate:(f, file) => writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({
        type:'user', sessionId:'claude-session', timestamp:'2024-06-14T12:00:00.000Z', cwd:f.project,
        message:{ content:'new prompt after the first scan' },
      })}\n`),
    },
  ];
  for (const scenario of cases) {
    const f = fixture();
    try {
      const config = loadConfig(join(f.root, 'honestweek.config.json'));
      const scanned = await scanPromptSources({
        config, weekStart:new Date('2024-06-10T00:00:00.000Z'),
        weekEnd:new Date('2024-06-17T00:00:00.000Z'), roots:f.roots, now:f.now,
      });
      const promptStore = mergePromptStore(null, scanned, f.now);
      const file = join(f.claude, 'projects', 'p', 'session.jsonl');
      scenario.mutate(f, file);
      await assert.rejects(
        scanDigestEvidence({ config, promptStore, roots:f.roots, sourceStatus:scanned.sourceStatus }),
        (error) => {
          assert.equal(error.message.includes(f.root), false, scenario.name);
          assert.equal(error.message.includes('session.jsonl'), false, scenario.name);
          assert.match(error.message, /digest source|malformed JSONL/, scenario.name);
          return true;
        },
      );
    } finally { rmSync(f.root, { recursive:true, force:true }); }
  }
});

test('persistent high-risk residuals in every category are withheld before public item creation', async () => {
  const f = fixture();
  try {
    const { config, promptStore, digest } = await scanFixture(f);
    const unsafeStore = structuredClone(promptStore);
    for (const prompt of unsafeStore.prompts) {
      prompt.text = `person@example.com residual ${prompt.source}`;
      prompt.contentHash = sha256(prompt.text); prompt.sourceLength = [...prompt.text].length;
      prompt.redactionCount = 0; prompt.changedPercent = 0; prompt.rawRisk = 'high';
      prompt.rawDetectors = ['email']; prompt.redactionOps = []; prompt.truncated = false;
    }
    const unsafeDigest = structuredClone(digest);
    for (const value of unsafeDigest.evidence) {
      value.text = `person@example.com residual ${value.category}`;
      value.contentHash = sha256(value.text); value.sourceLength = [...value.text].length;
      value.redactionCount = 0; value.changedPercent = 0; value.rawRisk = 'high';
      value.rawDetectors = ['email']; value.redactionOps = []; value.truncated = false;
      value.residualRisk = 'high';
    }
    const result = curateDigest(
      unsafeStore, unsafeDigest, config, { start:'2024-06-10', end:'2024-06-16' }, f.now,
      { outputBinding:{ mode:'page', adapterHash:null, objectives:false } },
    );
    for (const category of DIGEST_CATEGORIES) {
      assert.equal(result.review.candidates.some((value) => value.category === category && value.decision === 'high-risk'), true, category);
    }
    assert.equal(result.review.withheld.total['high-risk'], result.review.candidates.length);
    assert.equal(result.lane.items.length, 0);
    assert.doesNotMatch(JSON.stringify(result.lane), /person@example\.com/);
    assert.deepEqual({
      injectionPoint:'post-scan-integrity-fault',
      canonicalScannerResidualHigh:digest.evidence.filter((value) => value.residualRisk === 'high').length,
      byCategory:Object.fromEntries(DIGEST_CATEGORIES.map((category) => [category,
        result.review.candidates.filter((value) => value.category === category && value.decision === 'high-risk').length])),
      total:result.review.withheld.total['high-risk'], publicItems:result.lane.items.length,
    }, REPRESENTATIVE_PROOF.persistentHighRisk);

    const keptReview = structuredClone(result.review);
    for (const candidate of keptReview.candidates) candidate.state = 'kept';
    const keptResult = curateDigest(
      unsafeStore, unsafeDigest, config, { start:'2024-06-10', end:'2024-06-16' }, f.now,
      { outputBinding:{ mode:'page', adapterHash:null, objectives:false }, priorReview:keptReview },
    );
    for (const category of DIGEST_CATEGORIES) {
      assert.equal(keptResult.review.candidates.some((value) =>
        value.category === category && value.state === 'kept' && value.decision === 'high-risk'), true, `${category}: keep cannot bypass privacy`);
    }
    assert.equal(keptResult.lane.items.length, 0);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('digest keep, hide, and delete control every category through re-prepare, validate, and build', async () => {
  for (const command of ['keep','hide','delete']) {
    const f = fixture();
    const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
    try {
      process.env.CLAUDE_CONFIG_DIR = f.claude; process.env.CODEX_HOME = f.codex;
      verifiedCommit(f.project);
      let output = io();
      assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
      const initial = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
      const controlled = Object.fromEntries(DIGEST_CATEGORIES.map((category) => [
        category, initial.candidates.find((candidate) => candidate.category === category && candidate.decision === 'automatic-safe'),
      ]));
      assert.equal(Object.values(controlled).every(Boolean), true, `${command}: clean candidate per category`);

      for (const category of DIGEST_CATEGORIES) {
        const candidate = controlled[category];
        output = io();
        const argv = [command, candidate.itemRef.slice(0, 12), ...(command === 'delete' ? ['--yes'] : [])];
        assert.equal(await runDigest({ cwd:f.root, argv, now:f.now, roots:f.roots, io:output }), 0, `${category}: ${output.stderr}`);
        assert.doesNotMatch(output.stdout, new RegExp(candidate.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }

      if (command === 'delete') {
        output = io();
        assert.equal(await runPrompts({
          cwd:f.root, argv:['delete',controlled.prompts.receipts[0].ref.slice(0, 12),'--yes'],
          now:f.now, roots:f.roots, io:output,
        }), 0, output.stderr);
      }

      output = io();
      assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
      const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
      const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
      assert.equal(lane.version, 2, `${command}: public schema compatibility`);
      for (const category of DIGEST_CATEGORIES) {
        const candidate = controlled[category];
        const current = review.candidates.find((value) => value.itemRef === candidate.itemRef);
        const publicItem = lane.items.find((value) => value.itemRef === candidate.itemRef);
        if (command === 'keep') {
          assert.equal(current?.state, 'kept', category);
          assert.equal(publicItem?.curationState, 'kept', category);
          assert.equal(publicItem?.selection.primaryReasonCode, 'explicit-keep', category);
          assert.equal(publicItem?.selection.reason, category === 'prompts' ? 'you kept this prompt' : 'you kept this item', category);
          assert.deepEqual(publicItem?.receipts, candidate.receipts, category);
        } else if (command === 'hide') {
          assert.equal(current?.state, 'hidden', category);
          assert.equal(current?.decision, 'hidden', category);
          assert.equal(publicItem, undefined, category);
        } else {
          assert.equal(current, undefined, category);
          const tombstone = review.tombstones.find((value) => value.itemRef === candidate.itemRef);
          assert.deepEqual(tombstone, {
            itemRef:candidate.itemRef, category, evidenceRefs:candidate.evidenceRefs, deletedAt:f.now.toISOString(),
          }, category);
          assert.equal(publicItem, undefined, category);
        }
      }
      if (command === 'delete') {
        assert.equal(review.version, 2);
        assert.equal(review.tombstones.length, DIGEST_CATEGORIES.length);
        const tombstoneText = JSON.stringify(review.tombstones);
        for (const candidate of Object.values(controlled)) assert.doesNotMatch(tombstoneText, new RegExp(candidate.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      } else {
        assert.equal(review.version, 1);
      }

      output = io(); assert.equal(await runValidate({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
      output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
      const html = readFileSync(join(f.root, 'report.html'), 'utf8');
      if (command === 'keep') {
        for (const category of DIGEST_CATEGORIES) {
          const item = lane.items.find((value) => value.itemRef === controlled[category].itemRef);
          assert.match(html, new RegExp(item.snippets[1].text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${category}: receipt rendered`);
        }
      }
    } finally {
      if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
      if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
      rmSync(f.root, { recursive:true, force:true });
    }
  }
});

test('digest delete requires confirmation and tombstone schema failures write nothing', async () => {
  const f = fixture();
  try {
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const reviewPath = join(f.root, 'honestweek.curated.json');
    const lanePath = join(f.root, 'honestweek.prompt-items.json');
    const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
    const candidate = review.candidates.find((value) => value.category === 'ideas');
    const before = { review:readFileSync(reviewPath), lane:readFileSync(lanePath) };

    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['delete',candidate.itemRef.slice(0, 12)], now:f.now, roots:f.roots, io:output }), 2);
    assert.match(output.stderr, /requires --yes/);
    assert.deepEqual(readFileSync(reviewPath), before.review);
    assert.deepEqual(readFileSync(lanePath), before.lane);

    const invalid = structuredClone(review);
    invalid.version = 2;
    invalid.tombstones = [{ itemRef:candidate.itemRef, category:'ideas', evidenceRefs:candidate.evidenceRefs, deletedAt:'not-a-date' }];
    writeFileSync(reviewPath, JSON.stringify(invalid));
    const tampered = readFileSync(reviewPath);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 2);
    assert.match(output.stderr, /tombstone state is invalid/);
    assert.deepEqual(readFileSync(reviewPath), tampered);
    assert.deepEqual(readFileSync(lanePath), before.lane);
    assert.equal(existsSync(join(f.root, DIGEST_PENDING)), false);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('a lifecycle control fault leaves an existing recoverable digest prefix', async () => {
  const f = fixture();
  try {
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const priorLane = readFileSync(join(f.root, 'honestweek.prompt-items.json'));
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const candidate = review.candidates.find((value) => value.category === 'decisions');

    output = io();
    assert.equal(await runDigest({
      cwd:f.root, argv:['keep',candidate.itemRef.slice(0, 12)], now:f.now, roots:f.roots, io:output,
      transactionFs:{ lane:failAtomic('renameSync') },
    }), 2);
    assert.match(output.stderr, /transaction remains pending/);
    assert.equal(existsSync(join(f.root, DIGEST_PENDING)), true);
    assert.deepEqual(readFileSync(join(f.root, 'honestweek.prompt-items.json')), priorLane);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8')).candidates
      .find((value) => value.itemRef === candidate.itemRef).state, 'kept');

    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['candidates'], now:f.now, roots:f.roots, io:output }), 2);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    assert.equal(existsSync(join(f.root, DIGEST_PENDING)), false);
    const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    assert.equal(lane.items.find((value) => value.itemRef === candidate.itemRef).curationState, 'kept');
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('digest prepare renders all six categories through the existing page', async () => {
  const f = fixture();
  const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude; process.env.CODEX_HOME = f.codex;
    const workSha = verifiedCommit(f.project);
    writeFileSync(join(f.root, 'honestweek.items.json'), JSON.stringify({
      week:{ start:'2024-06-10', end:'2024-06-16' },
      items:[{
        id:'ordinary-work', repo:'your-project', project:'your-project', tag:'verified', status:'shipped',
        primaryCommit:workSha, title:'Verified ordinary work',
        summary:'Verified ordinary work remains alongside the balanced digest.',
      }],
    }));
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    assert.equal(existsSync(join(f.root, DIGEST_PENDING)), false);
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    assert.equal(lane.version, 2);
    assert.deepEqual([...new Set(review.candidates.map((candidate) => candidate.category))], DIGEST_CATEGORIES);
    assert.deepEqual([...new Set(lane.items.map((item) => item.category))], DIGEST_CATEGORIES);
    assert.equal(lane.items.every((item) => item.status === '' && item.receipts.length >= 1 && item.snippets.length === item.receipts.length + 1), true);
    assert.equal(lane.items.every((item) => item.summary.includes('not universal importance')), true);
    assert.equal(lane.items.every((item) => item.privacy.transform === 'redaction' && item.summary.includes('Privacy edited.')), true);
    const expectedSelection = {
      prompts:[4,'recurs'], ideas:[4,'observed-verification'], techniques:[2,'observed-verification'],
      decisions:[5,'decision-or-reversal'], reversals:[5,'decision-or-reversal'], nextSteps:[5,'recurs'],
    };
    for (const [category, [score, reason]] of Object.entries(expectedSelection)) {
      const visible = lane.items.filter((item) => item.category === category);
      assert.equal(visible.every((item) => item.selection.score === score && item.selection.primaryReasonCode === reason), true, category);
    }
    for (const category of ['ideas','nextSteps']) {
      assert.equal(lane.items.filter((item) => item.category === category).every((item) =>
        item.selection.primaryReasonCode !== 'recurs' || item.selection.reason === 'matched lexical overlap across sessions'), true, category);
    }
    assert.deepEqual(lane.items.filter((item) => item.category === 'prompts').map((item) => item.receipts[0].source), ['claude-code','codex']);
    assert.equal(review.candidates.length, lane.items.length);
    assert.equal(Object.values(lane.withheld.total).reduce((sum, value) => sum + value, 0), 0);
    assert.doesNotMatch(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'), /person@example\.com/);
    assert.doesNotMatch(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'), /person@example\.com/);
    assert.equal(lane.items.find((item) => item.category === 'techniques').receipts.length, 2);
    assert.match(output.stdout, /selected \d+\/12/);

    output = io(); assert.equal(await runValidate({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
    const html = readFileSync(join(f.root, 'report.html'), 'utf8');
    for (const label of ['Prompt highlights','Ideas','Techniques','Decisions','Reversals','Next steps']) assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /designed, not proven/);
    assert.match(html, /Verified ordinary work/); assert.match(html, new RegExp(workSha.slice(0, 7)));
    assert.match(html, /source receipt/); assert.match(html, /not universal importance/);

    const adapter = join(f.root, 'honestweek.site.mjs');
    writeFileSync(adapter, "export const artifact='site-data.json'; export function transform(model){return {items:model.items.map((item)=>({id:item.id,status:item.status===''?null:item.status,project:item.project,title:item.title,summary:item.summary,snippets:item.snippets}))};}\n");
    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({ ...f.config, output:{ mode:'site', adapter } }));
    output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
    const site = JSON.parse(readFileSync(join(f.root, 'site-data.json'), 'utf8'));
    assert.deepEqual([...new Set(site.items.map((item) => item.project))], ['your-project','Prompt highlights','Ideas','Techniques','Decisions','Reversals','Next steps']);
    assert.equal(site.items.find((item) => item.id === 'ordinary-work').status, 'shipped');
    assert.equal(site.items.filter((item) => item.id !== 'ordinary-work').every((item) => item.status === null && item.snippets.length >= 2), true);

    output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['candidates','--limit','2'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    assert.match(output.stdout, /showing 1-2/); assert.match(output.stdout, /Next: honestweek digest candidates --limit 2 --offset 2/);
    const ref = review.candidates[0].itemRef;
    output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['explain',ref.slice(0,12)], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    assert.match(output.stdout, /privacy: raw/); assert.match(output.stdout, /receipt:/); assert.doesNotMatch(output.stdout, new RegExp(review.candidates[0].text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const siteBytes = readFileSync(join(f.root, 'site-data.json'));
    writeFileSync(adapter, `${readFileSync(adapter, 'utf8')}\n// adapter drift\n`);
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2);
    assert.match(output.stderr, /ABORTED/); assert.deepEqual(readFileSync(join(f.root, 'site-data.json')), siteBytes);
  } finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('site build rejects a configured repository label that collides with a visible digest group', async () => {
  const f = fixture();
  const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude; process.env.CODEX_HOME = f.codex;
    verifiedCommit(f.project);
    const artifact = join(f.root, 'site-data.json');
    const adapter = join(f.root, 'honestweek.site.mjs');
    writeFileSync(adapter, `export const artifact=${JSON.stringify(artifact)}; export function transform(model){return {items:model.items};}\n`);
    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({
      ...f.config,
      repos:[{ path:f.project, label:'Ideas', role:'featured' }],
      output:{ mode:'site', adapter },
    }));
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    writeFileSync(artifact, 'unchanged\n');
    output = io();
    assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2);
    assert.match(output.stderr, /configured repository label collides with a reserved digest group/);
    assert.equal(readFileSync(artifact, 'utf8'), 'unchanged\n');
  } finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('pending digest transaction blocks every other state reader and writer', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, DIGEST_PENDING), JSON.stringify({ version:1 }));
    let output = io();
    assert.equal(await runPrompts({ cwd:f.root, argv:['sync'], now:f.now, roots:f.roots, io:output }), 2);
    assert.match(output.stderr, /digest\.pending/);
    output = io(); assert.equal(await runValidate({ cwd:f.root, now:f.now, io:output }), 2);
    assert.match(output.stderr, /digest\.pending/);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('version 2 schema, drift, reserved fields, and group collisions fail before page output changes', async () => {
  const f = fixture();
  const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude; process.env.CODEX_HOME = f.codex;
    let output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
    const page = readFileSync(join(f.root, 'report.html'), 'utf8');
    const lanePath = join(f.root, 'honestweek.prompt-items.json');
    const laneBytes = readFileSync(lanePath, 'utf8');
    const mutations = [
      ['score', (lane) => { lane.items[0].selection.score += 1; }],
      ['unknown key', (lane) => { lane.items[0].unexpected = true; }],
      ['receipt order', (lane) => { lane.items.find((item) => item.receipts.length > 1).receipts.reverse(); }],
      ['evidence order', (lane) => { lane.items.find((item) => item.evidenceRefs.length > 1).evidenceRefs.reverse(); }],
      ['withheld accounting', (lane) => { lane.withheld.total['overall-capacity'] += 1; }],
      ['duplicate identity', (lane) => { lane.items[1].itemRef = lane.items[0].itemRef; }],
    ];
    for (const [name, mutate] of mutations) {
      const lane = JSON.parse(laneBytes); mutate(lane);
      writeFileSync(lanePath, `${JSON.stringify(lane, null, 2)}\n`);
      output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, name);
      assert.match(output.stderr, /ABORTED/, name);
      assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page, name);
    }
    writeFileSync(lanePath, laneBytes);

    const reviewPath = join(f.root, 'honestweek.curated.json');
    const reviewBytes = readFileSync(reviewPath, 'utf8');
    const tamperedReview = JSON.parse(reviewBytes); tamperedReview.candidates[0].score += 1;
    writeFileSync(reviewPath, `${JSON.stringify(tamperedReview, null, 2)}\n`);
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, 'private review tampering');
    assert.match(output.stderr, /ABORTED/, 'private review tampering');
    assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page, 'private review tampering');
    writeFileSync(reviewPath, reviewBytes);

    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({ ...f.config, curation:{ maxItems:13 } }));
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, 'config drift');
    assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page);
    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify(f.config));

    const itemsPath = join(f.root, 'honestweek.items.json'); const itemsBytes = readFileSync(itemsPath, 'utf8');
    writeFileSync(itemsPath, JSON.stringify({ week:{ start:'2024-06-03', end:'2024-06-09' }, items:[] }));
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, 'week drift');
    assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page);
    writeFileSync(itemsPath, itemsBytes);

    const storePath = join(f.root, 'honestweek.prompts.json'); const storeBytes = readFileSync(storePath, 'utf8');
    const store = JSON.parse(storeBytes); store.prompts[0].state = 'hidden';
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, 'prompt control drift');
    assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page);
    writeFileSync(storePath, storeBytes);

    writeFileSync(itemsPath, JSON.stringify({
      week:{ start:'2024-06-10', end:'2024-06-16' },
      items:[{ id:'forged', kind:'idea', publicDisposition:'automatic-safe' }],
    }));
    output = io(); assert.equal(await runValidate({ cwd:f.root, now:f.now, io:output }), 2, 'reserved item validate');
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, 'reserved item build');
    assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page);

    writeFileSync(itemsPath, JSON.stringify({
      week:{ start:'2024-06-10', end:'2024-06-16' },
      items:[{ id:'collision', project:'Ideas', summary:'An authored work label collides with a digest group.' }],
    }));
    output = io(); assert.equal(await runValidate({ cwd:f.root, now:f.now, io:output }), 2, 'group collision validate');
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, 'group collision build');
    assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page);

    writeFileSync(itemsPath, JSON.stringify({
      week:{ start:'2024-06-10', end:'2024-06-16' }, items:[], projects:{ Ideas:{ mission:'A colliding project.' } },
    }));
    output = io(); assert.equal(await runValidate({ cwd:f.root, now:f.now, io:output }), 2, 'metadata collision validate');
    output = io(); assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 2, 'metadata collision build');
    assert.equal(readFileSync(join(f.root, 'report.html'), 'utf8'), page);
    writeFileSync(itemsPath, itemsBytes);
  } finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('global target and category caps never drop an explicit prompt keep', async () => {
  const f = fixture();
  try {
    let output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const prompt = JSON.parse(readFileSync(join(f.root, 'honestweek.prompts.json'), 'utf8')).prompts[0];
    output = io(); assert.equal(await runPrompts({ cwd:f.root, argv:['keep',prompt.ref.slice(0,12)], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({
      ...f.config,
      curation:{ maxItems:1, categoryCaps:{ prompts:0, ideas:0, techniques:0, decisions:0, reversals:0, nextSteps:0 } },
    }));
    output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    assert.equal(lane.items.length, 1); assert.equal(lane.items[0].curationState, 'kept');
    assert.equal(lane.items[0].selection.primaryReasonCode, 'explicit-keep');
    assert.equal(lane.items.filter((item) => item.curationState === 'automatic').length, 0);
    assert.equal(lane.withheld.total['category-capacity'], review.candidates.length - 1);
    assert.equal(lane.withheld.total['overall-capacity'], 0);
    assert.match(lane.items[0].summary, /overall target 1/);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('overall capacity uses score, category, timestamp, then item-ref tie order', async () => {
  const f = fixture();
  try {
    const tiedAt = '2024-06-10T09:00:00.000Z';
    jsonl(join(f.claude, 'projects', 'p', 'decision-a.jsonl'), claudeVerifiedTurn({
      sessionId:'decision-a', cwd:f.project, at:tiedAt,
      prompt:'please verify the first bounded choice with ordinary lowercase evidence words',
      final:'Decision: choose the first bounded choice with ordinary lowercase evidence words',
    }));
    jsonl(join(f.claude, 'projects', 'p', 'decision-b.jsonl'), claudeVerifiedTurn({
      sessionId:'decision-b', cwd:f.project, at:tiedAt,
      prompt:'please verify the second bounded choice with ordinary lowercase evidence words',
      final:'Decision: choose the second bounded choice with ordinary lowercase evidence words',
    }));
    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({
      ...f.config,
      curation:{ maxItems:1, categoryCaps:Object.fromEntries(DIGEST_CATEGORIES.map((category) => [category, 10])) },
    }));
    const output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    const tied = review.candidates.filter((candidate) =>
      candidate.category === 'decisions' && candidate.timestamp === new Date(new Date(tiedAt).getTime() + 3000).toISOString());
    assert.equal(tied.length, 2);
    const expected = tied.map((candidate) => candidate.itemRef).sort()[0];
    assert.equal(lane.items.length, 1);
    assert.equal(lane.items[0].category, 'decisions', 'category order breaks equal top scores');
    assert.equal(lane.items[0].itemRef, expected, 'item ref breaks equal score, category, and timestamp');
    assert.equal(lane.withheld.total['category-capacity'], 0);
    assert.equal(lane.withheld.total['overall-capacity'], review.candidates.length - 1);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('digest prepare recovers every ordered transaction prefix and rejects a mixed prefix', async () => {
  const f = fixture();
  const later = new Date(f.now.getTime() + 1000);
  try {
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const priorBytes = digestBytes(f.root);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:later, roots:f.roots, io:output }), 0, output.stderr);
    const nextBytes = digestBytes(f.root);
    const lane = JSON.parse(nextBytes.laneHash.toString('utf8'));
    const marker = makeDigestPending({
      week: lane.week, outputBinding: lane.outputBinding,
      prior: digestHashes(priorBytes), next: digestHashes(nextBytes),
    });
    const prefixes = [
      priorBytes,
      { ...priorBytes, promptStoreHash:nextBytes.promptStoreHash },
      { ...priorBytes, promptStoreHash:nextBytes.promptStoreHash, curatedHash:nextBytes.curatedHash },
      nextBytes,
    ];
    for (const prefix of prefixes) {
      writeDigestBytes(f.root, prefix);
      writeFileSync(join(f.root, DIGEST_PENDING), `${JSON.stringify(marker, null, 2)}\n`);
      output = io();
      assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:later, roots:f.roots, io:output }), 0, output.stderr);
      assert.equal(existsSync(join(f.root, DIGEST_PENDING)), false);
      const recovered = digestBytes(f.root);
      for (const key of Object.keys(nextBytes)) assert.deepEqual(recovered[key], nextBytes[key]);
    }
    const mixed = { ...priorBytes, curatedHash:nextBytes.curatedHash };
    writeDigestBytes(f.root, mixed);
    writeFileSync(join(f.root, DIGEST_PENDING), `${JSON.stringify(marker, null, 2)}\n`);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:later, roots:f.roots, io:output }), 2);
    assert.match(output.stderr, /recoverable ordered write prefix/);
    const unchanged = digestBytes(f.root);
    for (const key of Object.keys(mixed)) assert.deepEqual(unchanged[key], mixed[key]);
    assert.equal(existsSync(join(f.root, DIGEST_PENDING)), true);
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('digest transaction faults leave only documented recoverable prefixes', async () => {
  const f = fixture();
  const later = new Date(f.now.getTime() + 1000);
  try {
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const priorBytes = digestBytes(f.root);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:later, roots:f.roots, io:output }), 0, output.stderr);
    const nextBytes = digestBytes(f.root);
    const phases = [
      { name:'pending', key:'pending', expected:priorBytes, pending:false },
      { name:'prompt store', key:'promptStore', expected:priorBytes, pending:true },
      { name:'private review', key:'review', expected:{ ...priorBytes, promptStoreHash:nextBytes.promptStoreHash }, pending:true },
      { name:'public lane', key:'lane', expected:{ ...priorBytes, promptStoreHash:nextBytes.promptStoreHash, curatedHash:nextBytes.curatedHash }, pending:true },
    ];
    const cases = ['openSync','writeFileSync','fsyncSync','closeSync','renameSync'].flatMap((method) =>
      phases.map((phase) => ({ ...phase, name:`${phase.name} ${method}`, fs:{ [phase.key]:failAtomic(method) } })),
    );
    cases.push(
      { name:'pending removal', fs:{ remove:{ unlinkSync:() => { throw new Error('injected remove fault'); } } }, expected:nextBytes, pending:true },
    );
    for (const fault of cases) {
      writeDigestBytes(f.root, priorBytes);
      if (existsSync(join(f.root, DIGEST_PENDING))) unlinkSync(join(f.root, DIGEST_PENDING));
      output = io();
      assert.equal(await runDigest({
        cwd:f.root, argv:['prepare'], now:later, roots:f.roots, io:output, transactionFs:fault.fs,
      }), 2, fault.name);
      if (fault.pending) assert.match(output.stderr, new RegExp(fault.name.replace(/ (?:openSync|writeFileSync|fsyncSync|closeSync|renameSync)$/, '')));
      else assert.match(output.stderr, /did not start/);
      const current = digestBytes(f.root);
      for (const key of Object.keys(fault.expected)) assert.deepEqual(current[key], fault.expected[key], `${fault.name}: ${key}`);
      assert.equal(existsSync(join(f.root, DIGEST_PENDING)), fault.pending, fault.name);
      if (fault.pending) {
        output = io();
        assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:later, roots:f.roots, io:output }), 0, `${fault.name}: ${output.stderr}`);
        assert.equal(existsSync(join(f.root, DIGEST_PENDING)), false);
      }
    }
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});

test('all six categories apply unchanged, edited, private, and ambiguous privacy outcomes', async () => {
  const f = fixture();
  const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claude; process.env.CODEX_HOME = f.codex;
    const safe = 'use deterministic evidence boundaries with enough ordinary lowercase words for this weekly review';
    jsonl(join(f.claude, 'projects', 'p', 'safe.jsonl'), claudeVerifiedTurn({
      sessionId:'safe-session', cwd:f.project,
      prompt:`please verify ${safe}`,
      final:`Idea: ${safe}\nTechnique: ${safe}\nDecision: ${safe}\nReversal: ${safe}\nNext step: ${safe}`,
    }));
    const privateText = 'keep this unmatched source confined to its local private review record';
    jsonl(join(f.claude, 'projects', 'p', 'private.jsonl'), claudeVerifiedTurn({
      sessionId:'private-session', cwd:join(f.root, 'unmatched'),
      prompt:`please verify ${privateText}\nIdea: ${privateText}\nTechnique: ${privateText}\nDecision: ${privateText}\nReversal: ${privateText}`,
      final:`Next step: ${privateText}`,
    }));
    const ambiguous = 'use Nimbus only as an explicitly ambiguous capitalized token in this review';
    jsonl(join(f.claude, 'projects', 'p', 'ambiguous.jsonl'), claudeVerifiedTurn({
      sessionId:'ambiguous-session', cwd:f.project,
      prompt:`please verify and ${ambiguous}\nIdea: ${ambiguous}\nTechnique: ${ambiguous}\nDecision: ${ambiguous}\nReversal: ${ambiguous}`,
      final:`Next step: ${ambiguous}`,
    }));
    const cueScopedTechnique = 'reconstruct the exact receipt before rendering the bounded weekly item';
    jsonl(join(f.claude, 'projects', 'p', 'cue-scoped-technique.jsonl'), claudeVerifiedTurn({
      sessionId:'cue-scoped-technique', cwd:f.project,
      prompt:'please verify Nimbus remains confined to this unrelated ambiguous prompt text',
      final:`Technique: ${cueScopedTechnique}`,
      at:'2024-06-13T15:00:00.000Z',
    }));
    const email = 'person@example.com';
    jsonl(join(f.claude, 'projects', 'p', 'twenty.jsonl'), claudeVerifiedTurn({
      sessionId:'twenty-session', cwd:f.project,
      prompt:`please verify the exact threshold\nIdea: ${email} ${'x'.repeat(72)}`,
      final:'verification completed', at:'2024-06-14T10:00:00.000Z',
    }));
    jsonl(join(f.claude, 'projects', 'p', 'twenty-one.jsonl'), claudeVerifiedTurn({
      sessionId:'twenty-one-session', cwd:f.project,
      prompt:`please verify the exact threshold\nIdea: ${email} ${'x'.repeat(68)}`,
      final:'verification completed', at:'2024-06-15T10:00:00.000Z',
    }));
    const adapter = join(f.root, 'honestweek.site.mjs');
    writeFileSync(adapter, "export const artifact='site-data.json'; export function transform(model){return {items:model.items.map((item)=>({id:item.id,category:item.category,summary:item.summary,receipts:item.receipts}))};}\n");
    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({
      ...f.config,
      output:{ mode:'site', adapter },
    }));
    let output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    for (const category of DIGEST_CATEGORIES) {
      const automaticSafe = review.candidates.filter((item) => item.category === category && item.privacy.decision === 'automatic-safe');
      assert.equal(automaticSafe.some((item) => item.privacy.transform === 'none'), true, `${category}: unchanged`);
      assert.equal(automaticSafe.some((item) => item.privacy.transform === 'redaction'), true, `${category}: edited`);
      assert.equal(review.candidates.some((item) => item.category === category && item.decision === 'private-source'), true, `${category}: private`);
      assert.equal(review.candidates.some((item) => item.category === category && item.decision === 'needs-approval'), true, `${category}: ambiguous`);
    }
    const techniqueAudit = review.candidates.find((item) => item.text === cueScopedTechnique);
    assert.equal(techniqueAudit?.decision, 'automatic-safe');
    assert.equal(techniqueAudit?.privacy.transform, 'none');
    assert.equal(techniqueAudit?.privacy.changedPercent, 0);
    assert.equal(techniqueAudit?.privacy.sourceRefs.length, 2, 'supporting prompt remains an exact receipt without contaminating cue privacy');
    const thresholdIdeas = review.candidates.filter((item) => item.category === 'ideas' && [20,21].includes(item.changedPercent));
    assert.equal(thresholdIdeas.find((item) => item.changedPercent === 20)?.privacy.decision, 'automatic-safe');
    assert.equal(thresholdIdeas.find((item) => item.changedPercent === 21)?.privacy.decision, 'needs-approval');
    for (const candidate of review.candidates) {
      assert.equal(candidate.contentHash, sha256(candidate.text), `${candidate.itemRef}: content hash`);
      assert.equal(candidate.privacy.renditionHash, sha256(candidate.text), `${candidate.itemRef}: rendition hash`);
      assert.deepEqual(candidate.evidenceRefs, candidate.evidenceRefs.slice().sort(), `${candidate.itemRef}: evidence order`);
      assert.deepEqual(candidate.privacy.sourceRefs, candidate.evidenceRefs, `${candidate.itemRef}: privacy linkage`);
      assert.deepEqual(candidate.receipts.map((value) => value.ref).sort(), candidate.evidenceRefs, `${candidate.itemRef}: receipt linkage`);
      assert.equal(candidate.privacy.sourceContentHashes.every((value) => /^[0-9a-f]{64}$/.test(value)), true, `${candidate.itemRef}: source hashes`);
    }
    for (const item of lane.items) {
      assert.equal(item.privacy.renditionHash, sha256(item.snippets[0].text), `${item.itemRef}: public rendition hash`);
      assert.deepEqual(item.privacy.sourceRefs, item.evidenceRefs, `${item.itemRef}: public privacy linkage`);
      assert.deepEqual(item.receipts.map((value) => value.ref).sort(), item.evidenceRefs, `${item.itemRef}: public receipt linkage`);
      assert.deepEqual(item.receipt, {
        sessionId:item.receipts[0].sessionKey, ref:item.receipts[0].ref, turn:item.receipts[0].turn,
      });
    }
    const publicText = JSON.stringify(lane);
    assert.doesNotMatch(publicText, /Nimbus|unmatched source confined/);
    assert.equal(review.candidates.length, lane.items.length + Object.values(review.withheld.total).reduce((sum, value) => sum + value, 0));
    const proof = {
      categories: Object.fromEntries(DIGEST_CATEGORIES.map((category) => [category, {
        unchanged: review.candidates.filter((item) => item.category === category &&
          item.privacy.decision === 'automatic-safe' && item.privacy.transform === 'none').length,
        edited: review.candidates.filter((item) => item.category === category &&
          item.privacy.decision === 'automatic-safe' && item.privacy.transform === 'redaction').length,
        private: review.candidates.filter((item) => item.category === category && item.decision === 'private-source').length,
        ambiguous: review.candidates.filter((item) => item.category === category && item.decision === 'needs-approval').length,
        highRisk: review.candidates.filter((item) => item.category === category && item.decision === 'high-risk').length,
      }])),
      publicOrder: lane.items.map((item) => [
        item.category, item.curationState, item.selection.score, item.selection.primaryReasonCode,
        item.receipts.map((receipt) => `${receipt.source}:${receipt.kind}:${receipt.turn}`).join(','),
      ].join('|')),
      identityOrderHash:sha256(JSON.stringify(lane.items.map((item) => ({
        itemRef:item.itemRef,
        receipts:item.receipts.map(({ source, sessionKey, kind, turn, ref }) => ({ source, sessionKey, kind, turn, ref })),
      })))),
      excludedIdentity: (() => {
        const excluded = review.candidates.filter((item) => item.decision !== 'automatic-safe');
        return {
          count:excluded.length,
          hash:sha256(JSON.stringify(excluded.map((item) => ({
            itemRef:item.itemRef, category:item.category, decision:item.decision, score:item.score,
            reasonCode:item.selectionReasonCode,
            receipts:item.receipts.map(({ source, sessionKey, kind, turn, ref }) => ({ source, sessionKey, kind, turn, ref })),
          })))),
        };
      })(),
      withheld: review.withheld.total,
      scanExcluded: review.withheld.scanExcluded,
      editBoundary: thresholdIdeas.map((item) => ({ changedPercent: item.changedPercent, decision: item.privacy.decision })),
      calibration: (() => {
        const strong = review.candidates.filter((item) => item.state === 'kept' || item.score >= review.policy.automaticMinScore);
        const automaticSafe = strong.filter((item) => item.privacy.decision === 'automatic-safe');
        return {
          strongCandidatesEnteringTriage:strong.length,
          automaticSafeStrongCandidates:automaticSafe.length,
          reducedShare:`${automaticSafe.length}/${strong.length}`,
        };
      })(),
    };
    assert.deepEqual(proof, REPRESENTATIVE_PROOF.privacy);

    output = io();
    assert.equal(await runDigest({
      cwd:f.root, argv:['candidates','--category','ideas','--decision','needs-approval','--limit','2'],
      now:f.now, roots:f.roots, io:output,
    }), 0, output.stderr);
    assert.match(output.stdout, /ideas  decision=needs-approval/);
    assert.match(output.stdout, /preview withheld by privacy gate/);
    assert.doesNotMatch(output.stdout, /Nimbus|person@example\.com|ambiguous-session|[A-Za-z]:\\|honestweek-digest-/);

    output = io();
    assert.equal(await runDigest({
      cwd:f.root, argv:['candidates','--decision','private-source','--limit','2'],
      now:f.now, roots:f.roots, io:output,
    }), 0, output.stderr);
    assert.match(output.stdout, /decision=private-source/);
    assert.doesNotMatch(output.stdout, /unmatched source confined|private-session|[A-Za-z]:\\|honestweek-digest-/);

    const ambiguousRef = review.candidates.find((value) => value.decision === 'needs-approval').itemRef;
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['explain',ambiguousRef.slice(0, 12)], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    assert.match(output.stdout, /decision: needs-approval/); assert.match(output.stdout, /privacy:/);
    assert.doesNotMatch(output.stdout, /Nimbus|person@example\.com|ambiguous-session|[A-Za-z]:\\|honestweek-digest-/);
    output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['explain','abc'], now:f.now, roots:f.roots, io:output }), 2);
    output = io(); assert.equal(await runDigest({ cwd:f.root, argv:['explain','000000000000'], now:f.now, roots:f.roots, io:output }), 2);

    const hideRef = review.candidates.find((item) => item.category === 'techniques' && item.privacy.decision === 'automatic-safe').itemRef;
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['hide',hideRef.slice(0,12)], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    let controlledReview = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const hidden = controlledReview.candidates.find((item) => item.itemRef === hideRef);

    const deleteRef = controlledReview.candidates.find((item) =>
      item.category === 'decisions' && item.itemRef !== hideRef && item.privacy.decision === 'automatic-safe').itemRef;
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['delete',deleteRef.slice(0,12),'--yes'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    controlledReview = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const deleted = controlledReview.tombstones.find((item) => item.itemRef === deleteRef);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['reset-tombstones',deleteRef.slice(0,12),'--yes'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);

    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['delete','--all','--yes'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const bulkDeleted = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['reset-tombstones','--all','--yes'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    controlledReview = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const keepRefs = controlledReview.candidates.filter((item) => item.privacy.decision === 'automatic-safe').slice(0, 13).map((item) => item.itemRef);
    assert.equal(keepRefs.length, 13);
    for (const itemRef of keepRefs) {
      output = io();
      assert.equal(await runDigest({ cwd:f.root, argv:['keep',itemRef.slice(0,12)], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    }
    const controlledLane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    controlledReview = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const controlProof = {
      individual: {
        hiddenState:hidden.state, hiddenDecision:hidden.decision,
        deletedTombstoneHasText:Object.hasOwn(deleted, 'text'),
        deletedTombstoneReceiptCount:deleted.evidenceRefs.length,
      },
      bulk: {
        remainingCandidates:bulkDeleted.candidates.length,
        tombstones:bulkDeleted.tombstones.length,
        tombstonesContainText:bulkDeleted.tombstones.some((item) => Object.hasOwn(item, 'text')),
      },
      readerLoad: {
        maxItems:controlledLane.policy.maxItems,
        categoryCaps:controlledLane.policy.categoryCaps,
        visible:controlledLane.items.length,
        kept:controlledLane.items.filter((item) => item.curationState === 'kept').length,
        automatic:controlledLane.items.filter((item) => item.curationState === 'automatic').length,
        byCategory:Object.fromEntries(DIGEST_CATEGORIES.map((category) => [category,
          controlledLane.items.filter((item) => item.category === category).length])),
        categoryOmissions:controlledReview.withheld.total['category-capacity'],
        overallOmissions:controlledReview.withheld.total['overall-capacity'],
        disclosed:controlledLane.items.every((item) => item.summary.includes('overall target 12')),
      },
      identityOrderHash:sha256(JSON.stringify(controlledLane.items.map((item) => ({
        itemRef:item.itemRef, receipts:item.receipts,
      })))),
    };
    assert.deepEqual(controlProof, REPRESENTATIVE_PROOF.controls);
    output = io();
    assert.equal(await runValidate({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
    output = io();
    assert.equal(await runBuild({ cwd:f.root, now:f.now, io:output }), 0, output.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'site-data.json'), 'utf8')).items.length, controlledLane.items.length);
  } finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    rmSync(f.root, { recursive:true, force:true });
  }
});

test('disabled public renditions withhold every otherwise visible category', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'honestweek.config.json'), JSON.stringify({
      ...f.config,
      privacy:{ publicRenditions:{ enabled:false } },
    }));
    const output = io();
    assert.equal(await runDigest({ cwd:f.root, argv:['prepare'], now:f.now, roots:f.roots, io:output }), 0, output.stderr);
    const review = JSON.parse(readFileSync(join(f.root, 'honestweek.curated.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(f.root, 'honestweek.prompt-items.json'), 'utf8'));
    assert.equal(lane.items.length, 0);
    for (const category of DIGEST_CATEGORIES) {
      assert.equal(review.candidates.some((item) => item.category === category && item.decision === 'public-renditions-disabled'), true, category);
    }
  } finally { rmSync(f.root, { recursive:true, force:true }); }
});
