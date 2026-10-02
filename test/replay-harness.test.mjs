// The developer inspection harness (tools/replay-inspect.mjs) proves the full
// drill-down, and the engine stays clean-room and network-free.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../tools/replay-inspect.mjs';
import { buildCorpus, CODENAME, ME, SECRET_REASONING } from './fixtures/replay/corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let fx;

async function run(...args) {
  let out = '';
  let err = '';
  const io = { out: (s) => (out += s), err: (s) => (err += s) };
  const code = await main(['--config', fx.configFile, '--from', '2024-06-10', '--to', '2024-06-16', '--claude-root', fx.claudeRoot, '--codex-root', fx.codexRoot, ...args], io);
  return { code, out, err };
}

before(() => {
  fx = buildCorpus();
});
after(() => {
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('walk proves overview -> thread -> session -> turn -> event -> record, then scrubs time', async () => {
  const { code, out } = await run('walk', '--json');
  const report = JSON.parse(out);
  assert.equal(code, 0, report.checks.filter((c) => !c.ok).map((c) => c.name).join('; '));
  assert.ok(report.checks.length >= 15);
  const kinds = report.samples.map((s) => s.kind);
  for (const k of ['prompt', 'action', 'delegation-received', 'notification', 'decision', 'guard', 'interrupt', 'queue', 'outcome']) assert.ok(kinds.includes(k), `walk sampled a ${k}`);
  for (const s of report.samples) for (const r of s.records) assert.notEqual(r.verified, false, `${s.kind} record verified`);
  assert.equal(report.scrub.length, 5);
});

// Structure is checked through --json; the text layout is a developer view that is
// expected to change, so text output is only checked for answering and not leaking.
test('each drill-down command answers, in text and JSON, without leaking', async () => {
  const ovJson = JSON.parse((await run('overview', '--json')).out);
  assert.ok(ovJson.days.some((d) => d.date === '2024-06-11'));
  const thread = ovJson.threads.find((t) => t.sessions.value === 3);
  const thJson = JSON.parse((await run('thread', thread.id, '--json')).out);
  assert.ok(thJson.agentTree.some((a) => a.children.length > 0), 'the agent tree has a recorded child');
  assert.ok(thJson.outcomes.some((o) => /pull request 7 landed/.test(o.text)));
  const session = thJson.sessions.find((s) => s.turns > 3).key;
  const seJson = JSON.parse((await run('session', session, '--json')).out);
  assert.ok(seJson.turns.length > 3);
  const turnJson = JSON.parse((await run('turn', seJson.turns[0].id, '--json')).out);
  assert.ok(turnJson.events.length > 0);
  const ev = JSON.parse((await run('event', turnJson.events[0].id)).out);
  assert.ok(ev.refs.length);
  const rec = await run('record', turnJson.events[0].id);
  assert.equal(rec.code, 0);
  assert.equal(JSON.parse(rec.out)[0].verified, true);
  const at = JSON.parse((await run('at', '2024-06-11T15:07:30.000Z')).out);
  assert.equal(at.agentsWithOpenRecordedSpan.length, 1);
  const step = JSON.parse((await run('step', '2024-06-11T15:07:30.000Z', '-2')).out);
  assert.equal(step.cursor, step.from - 2);
  const covJson = JSON.parse((await run('coverage', '--json')).out);
  assert.ok(covJson['claude-code']['assistant:thinking'].handling.startsWith('excluded'));

  const texts = [];
  for (const args of [['overview'], ['thread', thread.id], ['session', session], ['turn', seJson.turns[0].id], ['coverage']]) {
    const r = await run(...args);
    assert.equal(r.code, 0, args.join(' '));
    assert.ok(r.out.trim().length > 0, args.join(' '));
    texts.push(r.out);
  }
  for (const text of [...texts, rec.out]) {
    for (const banned of [SECRET_REASONING, ME, CODENAME]) assert.ok(!text.includes(banned), `output leaks ${banned}`);
  }
});

test('bad input exits non-zero with usage, and --help exits zero', async () => {
  assert.equal((await run('thread', 'th-nope')).code, 1);
  assert.equal((await run('nonsense')).code, 1);
  let out = '';
  assert.equal(await main(['--help'], { out: (s) => (out += s), err: () => {} }), 0);
  assert.match(out, /Commands:/);
});

// The clean-room fence for this subsystem lives with the others, in
// test/site-cleanroom.test.mjs, so there is one list of forbidden tokens.
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

test('the engine makes no network calls and adds no dependency', () => {
  for (const f of [...files(join(ROOT, 'lib', 'replay')), join(ROOT, 'tools', 'replay-inspect.mjs')]) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/\b(fetch\(|node:https?|node:net|node:dgram|node:tls|XMLHttpRequest|WebSocket)\b/.test(text), `network use in ${f}`);
    for (const m of text.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('node:') || m[1].startsWith('.'), `non-built-in import ${m[1]} in ${f}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.ok(!pkg.files.includes('tools/'), 'the harness is a developer tool and does not ship');
});
