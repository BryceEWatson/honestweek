// The engine hides private words in the whole text before it cuts an excerpt, so a word
// across the cut can't lose its end, slip past the redactor, and show its start. Text is
// collapsed to one line first (the redactor's field rules read one line at a time), the
// cut steps back before any [redacted:...] placeholder it would split, and an excerpt with
// nothing hidden across the cut reads exactly as it did when the engine cut first.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRedactor, createSecretsOnlyRedactor } from '../lib/redact.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { LIMITS, placeholderSafeEnd, redactClip, redactClipFirstLine, redactThenCut } from '../lib/replay/parse-common.mjs';
import { claudeSessionKey } from '../lib/replay/sources.mjs';
import { sourceKey } from '../lib/replay/ids.mjs';
import { buildCorpus, at } from './fixtures/replay/corpus.mjs';
import { buildDemoWeek } from '../tools/demo-week.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every length the engine cuts shown text to. The source check below keeps this list in
// step with the adapters, the goal reader and record().
const CUT_LENGTHS = [600, 400, 300, 160, 120, 80, 60, 40, 30, 20, 2000];
const EXCERPT_LENGTHS = CUT_LENGTHS.filter((n) => n !== 2000);
const RECORD_ENDING = (n) => `… [${n} more characters]`;

// Made-up private words. Nothing else in the fixtures holds the letters "qy", so any "qy"
// in the output is a piece of one of them.
const TERM = 'Qyxolotrand';
const PAIR = 'Qyxo Lotrand';
const full = () => createRedactor({ redaction: { codenames: [], names: [], terms: [TERM, PAIR] } });
// A made-up token the secrets-only scrubber hides only whole (its known prefix and length).
const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Made-up secrets on the line after their key.
const SECRETS = ['tulip-Mango-42', 'orchid-Pebble-77', 'maple-Ember-19'];
const MULTILINE = `Deploy steps.\npassword:\n${SECRETS[0]}\nclient_secret:\n\t${SECRETS[1]}\nCookie:\nsession=${SECRETS[2]}\nthen go.`;

// The engine's cut before this change, kept here to show each case would have leaked.
function oldClip(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}
const cutThenRedact = (s, max, redact) => {
  const c = oldClip(s, max);
  return c == null ? null : redact(c);
};

/** `n` characters of ordinary words, one space apart, ending in a space; no q or y. */
function fill(n) {
  const words = ['the', 'build', 'ran', 'and', 'tests', 'passed', 'on', 'main', 'after', 'the', 'fix'];
  let s = '';
  for (let i = 0; s.length < n - 1; i += 1) s += (s ? ' ' : '') + words[i % words.length];
  s = s.slice(0, n - 1);
  if (s.endsWith(' ')) s = `${s.slice(0, -1)}x`;
  return `${s} `;
}
/** Text whose collapsed form has `word` starting `before` characters ahead of the cut at `max`. */
const straddling = (max, word = TERM, before = 4) => `${fill(max - before)}${word} and the rest of the line.`;

const leaks = (out) => typeof out === 'string' && out.toLowerCase().includes('qy');
/** True when `out`, without its ending, finishes with any start of `word`. */
function endsWithStartOf(out, word) {
  const t = out.replace(/(?:…(?: \[\d+ more characters\])?)$/, '').trimEnd().toLowerCase();
  for (let i = 1; i < word.length; i += 1) if (t.endsWith(word.slice(0, i).toLowerCase())) return true;
  return false;
}

// ---- the helper -----------------------------------------------------------------------

test('placeholderSafeEnd steps a cut back to before a placeholder it would split', () => {
  const s = 'abc [redacted:term] def';
  assert.equal(placeholderSafeEnd(s, 100), s.length);
  assert.equal(placeholderSafeEnd(s, 4), 4);
  for (let max = 5; max < 19; max += 1) assert.equal(placeholderSafeEnd(s, max), 4, `max ${max}`);
  assert.equal(placeholderSafeEnd(s, 19), 19);
  assert.equal(placeholderSafeEnd('[redacted:email][redacted:path]', 20), 16);
});

test('a private word across any cut, at any split, leaves no start of itself (full redactor)', () => {
  const r = full();
  let oldLeaks = 0;
  for (const word of [TERM, PAIR]) {
    for (const max of EXCERPT_LENGTHS) {
      for (let before = 1; before < word.length; before += 1) {
        const text = straddling(max, word, before);
        if (leaks(cutThenRedact(text, max, r.redact))) oldLeaks += 1;
        const out = redactClip(text, max, r.redact);
        assert.ok(!leaks(out), `${max}/${before}: ${out.slice(-40)}`);
        assert.ok(!endsWithStartOf(out, word), `${max}/${before}: ${out.slice(-40)}`);
        assert.ok(out.endsWith('…'));
      }
    }
    for (let before = 1; before < word.length; before += 1) {
      const text = `${fill(2000 - before)}${word}${' and more'.repeat(40)}`;
      const out = redactThenCut(text, 2000, r.redact, { ending: RECORD_ENDING });
      assert.ok(!leaks(out), `2000/${before}`);
      assert.match(out, /… \[\d+ more characters\]$/);
    }
  }
  // Failing-path partner: cutting first leaked the word's start almost every time.
  assert.ok(oldLeaks > EXCERPT_LENGTHS.length * 10, `the old cut leaked ${oldLeaks} times`);
});

test('a token across a cut stays hidden whole (secrets-only scrubber)', () => {
  const r = createSecretsOnlyRedactor();
  let oldLeaks = 0;
  for (const max of EXCERPT_LENGTHS) {
    for (const before of [4, 8, 20, 30]) {
      const text = straddling(max, TOKEN, before);
      if (cutThenRedact(text, max, r.redact).includes(TOKEN.slice(0, before))) oldLeaks += 1;
      const out = redactClip(text, max, r.redact);
      assert.ok(!out.includes('ghp_'), `${max}/${before}: ${out.slice(-50)}`);
    }
  }
  assert.ok(oldLeaks > 0, 'cutting first showed the start of the token');
});

test('a cut leaving a piece the redactor hides on its own stays hidden, as cutting first hid it', () => {
  const r = createRedactor({ redaction: { codenames: ['Quillon'], names: ['Pat'], terms: [] } });
  // `word` starts `at` characters in, so the cut at 160 keeps `kept` of it.
  const text = (at, word) => `${'x'.repeat(at - 1)} ${word} and the rest of the text.`;
  const cases = [
    ['a codename, plural', text(153, 'Quillons'), 'Quillon'],
    ['a name inside a longer word', text(157, 'patterns'), 'pat'],
    ['a key id with a letter glued on', text(140, 'AKIAIOSFODNN7EXAMPLEx'), 'AKIAIOSFODNN7EXAMPLE'],
    ['account digits glued to letters', text(150, '1234567890ab'), '1234567890'],
  ];
  for (const [name, s, kept] of cases) {
    // The whole text spares the longer form; the piece the cut leaves is hidden.
    assert.ok(r.redact(s).includes(kept), `${name}: the whole redaction spares it`);
    const was = cutThenRedact(s, 160, r.redact);
    assert.ok(!was.includes(kept), `${name}: cutting first hid it`);
    assert.equal(redactClip(s, 160, r.redact), was, name);
  }
});

test('a first-line excerpt reads as when the engine cut first, with something hidden earlier in the line', () => {
  const r = full();
  const body = `Refused by ${TERM} policy: ${fill(300)}\nsecond line`;
  const out = redactClipFirstLine(body, 160, r.redact);
  assert.equal(out, cutThenRedact(body.split('\n')[0], 160, r.redact));
  assert.ok(out.startsWith('Refused by [redacted:term] policy: the build') && out.endsWith('…'), out);
  // The goal list's words citation is a first-line excerpt too.
  const ref = redactClipFirstLine(`session:${TERM} ${fill(120)}\nnext`, 80, r.redact);
  assert.equal(ref, cutThenRedact(`session:${TERM} ${fill(120)}`, 80, r.redact));
});

test('whatever it cuts is a start of the whole redaction and never splits a placeholder', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pieces = [TERM, PAIR, 'pat@example.net', '/home/alex/notes', TOKEN, '123456789012', 'abc', 'the build', 'Qyxo', 'Lotrand', '  ', '\n'];
  for (const [name, r] of [['full', full()], ['secrets-only', createSecretsOnlyRedactor()]]) {
    for (let i = 0; i < 400; i += 1) {
      let text = '';
      while (text.length < 700) text += `${pieces[rand(pieces.length)]}${rand(3) ? ' ' : ''}`;
      const max = [20, 30, 40, 60, 80, 160, 300][rand(7)];
      const out = redactClip(text, max, r.redact);
      const whole = r.redact(text.replace(/\s+/g, ' ').trim());
      const body = out.endsWith('…') ? out.slice(0, -1) : out;
      // A cut of the whole redaction is read again, which can hide the piece it ends on, or
      // something the first reading spared, such as digits glued to a hidden word: so it's
      // a start of the whole redaction, or of that redaction read again.
      const start = body.replace(/\[redacted:[a-z]+\]$/, '');
      assert.ok(whole.startsWith(start) || r.redact(whole).startsWith(start), `${name}: ${JSON.stringify(out)} isn't a start of ${JSON.stringify(whole.slice(0, max + 20))}`);
      assert.ok(!/\[redacted:[a-z]*$/.test(body), `${name}: a split placeholder in ${JSON.stringify(out)}`);
    }
  }
});

test('a name broken across the first line break is still hidden in a first-line excerpt', () => {
  const r = full();
  const body = `PreToolUse:Bash hook error: Refused by ${PAIR.replace(' ', '\n')} policy`;
  assert.ok(leaks(cutThenRedact(body.split('\n')[0], 160, r.redact)), 'the first line alone shows it');
  const out = redactClipFirstLine(body, 160, r.redact);
  assert.equal(out, 'PreToolUse:Bash hook error: Refused by [redacted:term]');
});

test('a first-line excerpt shows nothing of the next line but the placeholder that took the break', () => {
  const r = full();
  for (const max of [160, 80]) {
    // A short first line: the next line's words don't run on into it.
    const body = `Refused by ${PAIR.replace(' ', '\n')} ${fill(400)}\nthird line`;
    assert.equal(redactClipFirstLine(body, max, r.redact), 'Refused by [redacted:term]');
    // Failing-path partner: the redacted first line runs on past the cut.
    assert.ok(r.redact(body).split('\n')[0].length > max);
    // A long first line is cut at `max` as any other, before the placeholder.
    const long = redactClipFirstLine(`${fill(max - 4)}${PAIR.replace(' ', '\n')} more`, max, r.redact);
    assert.ok(long.length <= max + 1 && long.endsWith('…') && !leaks(long), long);
  }
  // A key that ends the first line, with its value a line or more on, shows only the key
  // or its placeholder, as cutting first did: nothing of the next lines.
  assert.equal(redactClipFirstLine('token= \nhunter2-Zq9 then other words\n', 60, r.redact), 'token=');
  for (const body of ['Refused: Bearer api_key=\nsecret-value then words', 'Refused: Bearer api_key=\n\nsecret-value then words from the third line']) {
    assert.equal(redactClipFirstLine(body, 160, createRedactor({}).redact), 'Refused: Bearer [redacted:secret]');
  }
  // Lines read together that hide the first line's end differently, with no placeholder
  // across the break: only what both readings share shows.
  assert.equal(redactClipFirstLine('/home/Acme\rsuser:pass-p\ttoken=\r\ncurl -u https://u:pw@host\n', 30, createRedactor({}).redact), '[redacted:path]');
});

test('a first-line excerpt reads as when the engine cut first when nothing hidden takes the break', () => {
  const r = createRedactor({ redaction: { codenames: ['Quillon'], names: ['Pat'], terms: ['Acme Rocket'] } });
  const secrets = createSecretsOnlyRedactor();
  const cases = [
    // Placeholders make a short line's redaction longer than the cut.
    [r, `x ${'Quillon '.repeat(4)}`.trim(), 40],
    // Read twice, the redactor would hide the digits glued to a placeholder.
    [r, 'Pat client_secret: token=  AcmeCookie:Authorization: 1234567890Quillon', 80],
    // A field's key and value apart by a lone carriage return and tabs, then a line break:
    // the collapsed line reads them together, as cutting first did.
    [r, 'Rocket  x  Bearer\t-ppassword: \t Basic \t Rocket\rAKIAIOSFODNN7EXAMPLEhunter2Zq9 \nnext', 80],
    [secrets, 'Refused: Basic password:\rtulip-Mango-42 x\nnext', 160],
  ];
  for (const [red, body, max] of cases) {
    const first = body.split('\n')[0];
    const out = redactClipFirstLine(body, max, red.redact);
    assert.equal(out, cutThenRedact(first, max, red.redact), JSON.stringify(body));
    assert.ok(!/hunter2|tulip/.test(out), out);
  }
});

test('a secret on the line after its key stays hidden in an excerpt, under both scrubbers', () => {
  for (const r of [full(), createSecretsOnlyRedactor()]) {
    for (const max of EXCERPT_LENGTHS) {
      const out = redactClip(MULTILINE, max, r.redact) ?? '';
      for (const s of SECRETS) assert.ok(!out.includes(s.slice(0, Math.min(s.length, 6))), `${max}: ${out}`);
    }
  }
});

// ---- the excerpts the fixtures hold read as before -------------------------------------

const scratch = [];
let fx;
let demo;
let fixtureStrings;
before(() => {
  fx = buildCorpus();
  scratch.push(fx.root);
  const dir = mkdtempSync(join(tmpdir(), 'hw-redact-before-cut-'));
  scratch.push(dir);
  demo = buildDemoWeek({ root: join(dir, 'week') });
  // Read before the sessions below are added to the corpus.
  fixtureStrings = logStrings([fx.claudeRoot, fx.codexRoot, ...demo.roots.claude, ...demo.roots.codex]);
});
after(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold a lock on .git briefly */
    }
  }
});

/** Every string (and object key) in every log line under `dirs`. */
function logStrings(dirs) {
  const out = new Set();
  const walk = (v, depth = 0) => {
    if (depth > 30 || v == null) return;
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === 'object') {
      for (const [key, x] of Object.entries(v)) {
        out.add(key);
        walk(x, depth + 1);
      }
    }
  };
  const visit = (p) => {
    for (const name of readdirSync(p)) {
      const q = join(p, name);
      if (statSync(q).isDirectory()) visit(q);
      else if (name.endsWith('.jsonl')) {
        for (const line of readFileSync(q, 'utf8').split('\n')) {
          try {
            walk(JSON.parse(line));
          } catch {
            /* a cut-off last line */
          }
        }
      }
    }
  };
  for (const d of dirs) visit(d);
  return [...out];
}

/** A redactor that redacts each distinct text once. */
function cached(redact) {
  const seen = new Map();
  return (s) => {
    if (!seen.has(s)) seen.set(s, redact(s));
    return seen.get(s);
  };
}

test('every excerpt of the fixture logs, at every cut length, reads as when the engine cut first, unless something hidden crossed the cut', () => {
  const strings = fixtureStrings;
  assert.ok(strings.length > 500, `${strings.length} strings`);
  // The fixtures' own configured words, and "lantern", which the demo week's text uses
  // everywhere, so many excerpts have something hidden before their cut.
  const redactors = [
    ['corpus', createRedactor(fx.config)],
    ['demo with lantern hidden', createRedactor({ redaction: { codenames: [], names: [], terms: ['lantern'] } })],
    ['secrets-only', createSecretsOnlyRedactor()],
  ];
  let cutAndHidden = 0;
  let compared = 0;
  const crossed = [];
  for (const [name, r] of redactors) {
    const redact = cached(r.redact);
    for (const s of strings) {
      const whole = redact(s.replace(/\s+/g, ' ').trim());
      for (const max of EXCERPT_LENGTHS) {
        const was = cutThenRedact(s, max, redact);
        const now = redactClip(s, max, redact);
        compared += 1;
        if (was === null || whole.startsWith(was.replace(/…$/, ''))) {
          // Nothing hidden crosses the cut: the excerpt reads exactly as before.
          assert.equal(now, was, `${name}, ${max}: ${JSON.stringify(s.slice(0, 80))}`);
          // Counted only for words and secrets: a temp folder is a home path on some systems.
          if (was && was.endsWith('…') && /\[redacted:(term|secret)\]/.test(was)) cutAndHidden += 1;
        } else {
          // Something hidden crosses it, and cutting first showed part of it: now it's hidden.
          crossed.push(`${name} ${max}`);
          assert.ok(whole.startsWith(now.replace(/…$/, '')), `${name}, ${max}: ${now}`);
          assert.notEqual(now, was);
        }
      }
    }
  }
  // The logs hold such crossings: a session id cut at 30 of its 36 characters, an address
  // cut after its @, "lantern" cut after "lante". Cutting first showed each part.
  assert.ok(crossed.some((c) => c.startsWith('corpus ')) && crossed.some((c) => c.startsWith('demo with lantern hidden ')), `${crossed.length} of ${compared} crossed a cut`);
  assert.ok(cutAndHidden > 50, `only ${cutAndHidden} cut excerpts had something hidden before the cut (of ${compared})`);});

// ---- the engine ------------------------------------------------------------------------

const SESSION = '5e5e5e5e-1111-4222-8333-444444444444';
const THREAD = '01900000-0000-7000-8000-0000000000cc';

/** One Claude Code session and one Codex thread in the featured repo, with a made-up name
 *  across every cut the engine makes. Returns each site and the raw text behind it. */
function writeStraddlingSessions() {
  const cwd = fx.repo.dir;
  let n = 0;
  const rec = (type, extra) => JSON.stringify({ type, sessionId: SESSION, cwd, version: '2.1.0', gitBranch: 'main', uuid: `${SESSION.slice(0, 24)}${String(++n).padStart(12, '0')}`, timestamp: at(500, n * 100), ...extra });
  const say = (blocks) => rec('assistant', { message: { id: `msg-cut-${n}`, model: 'model-a', role: 'assistant', content: blocks } });
  const result = (id, content, extra = {}) => rec('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(extra.isError ? { is_error: true } : {}) }] }, ...(extra.tur ? { toolUseResult: extra.tur } : {}) });
  const s = (max) => straddling(max);
  const sites = {
    prompt: [600, s(600)],
    midTurnPrompt: [600, s(600)],
    // Its own text: a queued prompt the mid-turn one repeats is folded into it.
    absorbedPrompt: [600, straddling(600, TERM, 5)],
    message: [400, s(400)],
    command: [300, s(300)],
    description: [160, s(160)],
    answer: [160, s(160)],
    summary: [160, s(160)],
    query: [120, s(120)],
    pattern: [80, s(80)],
    skill: [60, s(60)],
    hookName: [60, s(60)],
    mode: [40, s(40)],
    status: [40, s(40)],
    queueReason: [40, s(40)],
    errorKind: [40, s(40)],
    hookEvent: [30, s(30)],
    handback: [30, s(30)],
    trigger: [20, s(20)],
    level: [20, s(20)],
    taskId: [20, s(20)],
    taskStatus: [20, s(20)],
    record: [2000, `${fill(1996)}${TERM}${' and more'.repeat(40)}`],
  };
  const v = (k) => sites[k][1];
  const lines = [
    rec('user', { message: { role: 'user', content: v('prompt') }, origin: { kind: 'human' } }),
    rec('user', { message: { role: 'user', content: v('record') }, origin: { kind: 'human' } }),
    rec('user', { message: { role: 'user', content: MULTILINE }, origin: { kind: 'human' } }),
    say([{ type: 'text', text: v('message') }, { type: 'tool_use', id: 'tu-cut-cmd', name: 'Bash', input: { command: v('command'), description: v('description') } }]),
    result('tu-cut-cmd', 'ok', { tur: { stdout: 'ok', stderr: '', interrupted: false } }),
    say([{ type: 'text', text: MULTILINE }, { type: 'tool_use', id: 'tu-cut-ml', name: 'Bash', input: { command: `echo "${MULTILINE}"` } }]),
    result('tu-cut-ml', 'ok', { tur: { stdout: 'ok', stderr: '', interrupted: false } }),
    say([{ type: 'tool_use', id: 'tu-cut-guard', name: 'Bash', input: { command: 'npm publish' } }]),
    result('tu-cut-guard', `PreToolUse:Bash hook error: Refused by ${PAIR.replace(' ', '\n')} policy`, { isError: true }),
    say([{ type: 'tool_use', id: 'tu-cut-ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?' }] } }]),
    result('tu-cut-ask', 'answered', { tur: { answers: { 'Which one?': v('answer') } } }),
    say([{ type: 'tool_use', id: 'tu-cut-web', name: 'WebSearch', input: { query: v('query') } }]),
    result('tu-cut-web', 'ok'),
    say([{ type: 'tool_use', id: 'tu-cut-grep', name: 'Grep', input: { pattern: v('pattern') } }]),
    result('tu-cut-grep', 'ok'),
    say([{ type: 'tool_use', id: 'tu-cut-skill', name: 'Skill', input: { skill: v('skill') } }]),
    result('tu-cut-skill', 'ok'),
    say([{ type: 'tool_use', id: 'tu-cut-task', name: 'TaskUpdate', input: { taskId: v('taskId'), status: v('taskStatus') } }]),
    result('tu-cut-task', 'ok'),
    say([{ type: 'tool_use', id: 'tu-cut-agent', name: 'Agent', input: { description: 'Look around', subagent_type: 'general-purpose', prompt: 'Look.' } }]),
    result('tu-cut-agent', 'done', { tur: { status: v('handback'), agentId: 'cutagent1' } }),
    rec('permission-mode', { permissionMode: v('mode') }),
    rec('attachment', { attachment: { type: 'hook_success', hookName: v('hookName'), hookEvent: v('hookEvent'), exitCode: 0, durationMs: 5 } }),
    rec('attachment', { attachment: { type: 'queued_command', prompt: v('midTurnPrompt'), origin: { kind: 'human' }, commandMode: 'prompt' } }),
    rec('queue-operation', { operation: 'enqueue', content: v('absorbedPrompt') }),
    rec('queue-operation', { operation: 'remove', reason: 'absorbed_mid_turn', content: v('absorbedPrompt') }),
    rec('queue-operation', { operation: 'enqueue', content: 'later' }),
    rec('queue-operation', { operation: 'remove', reason: v('queueReason') }),
    rec('user', { message: { role: 'user', content: `<task-notification>\n<task-id>t-cut</task-id>\n<status>${v('status')}</status>\n<summary>${v('summary')}</summary>\n</task-notification>` }, origin: { kind: 'task-notification' } }),
    rec('system', { subtype: 'compact_boundary', compactMetadata: { trigger: v('trigger'), preTokens: 10, postTokens: 5 } }),
    rec('system', { subtype: v('errorKind'), level: v('level') }),
  ];
  writeFileSync(join(fx.claudeRoot, 'proj-a', `${SESSION}.jsonl`), `${lines.join('\n')}\n`);

  const cx = (ts, type, payload) => JSON.stringify({ timestamp: at(520, ts), type, payload });
  const codex = {
    codexPrompt: [600, s(600)],
    codexMessage: [400, s(400)],
    codexCommand: [300, s(300)],
    codexReason: [40, s(40)],
    codexSurface: [40, s(40)],
    codexVersion: [20, s(20)],
  };
  const cv = (k) => codex[k][1];
  const thread = [
    cx(0, 'session_meta', { id: THREAD, timestamp: at(520), cwd, cli_version: cv('codexVersion'), source: cv('codexSurface') }),
    cx(10, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: cv('codexPrompt') }] }),
    cx(20, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: cv('codexCommand') }), call_id: 'call-cut' }),
    cx(30, 'response_item', { type: 'function_call_output', call_id: 'call-cut', output: 'Exit code: 0' }),
    cx(40, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: cv('codexMessage') }] }),
    cx(50, 'event_msg', { type: 'turn_aborted', turn_id: 't9', reason: cv('codexReason'), duration_ms: 5 }),
  ];
  writeFileSync(join(fx.codexRoot, '2024', '06', '11', `rollout-2024-06-11T23-40-00-${THREAD}.jsonl`), `${thread.join('\n')}\n`);
  return { ...sites, ...codex };
}

const GOALS = () => ({
  goals: [{
    id: 'g-cut',
    title: 'Check the cuts',
    observations: [
      { text: `Picked up in session:${fill(80 - 'session:'.length - 4)}${TERM} and onwards` },
      { text: `Also in session:the ${PAIR.replace(' ', '\n')} thread` },
    ],
  }],
  events: [],
});

let sites;
let builds;
before(async () => {
  sites = writeStraddlingSessions();
  const config = { ...fx.config, redaction: { ...fx.config.redaction, terms: [TERM, PAIR] } };
  const opts = { config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, goals: GOALS() };
  builds = { full: await buildWorkHistory(opts), local: await buildWorkHistory({ ...opts, privateText: true }) };
});

test('every site the engine cuts would have leaked the name when it cut first', () => {
  const r = full();
  for (const [site, [max, raw]] of Object.entries(sites)) {
    const was = max === 2000 ? r.redact(`${raw.slice(0, 2000)}${RECORD_ENDING(raw.length - 2000)}`) : cutThenRedact(raw, max, r.redact);
    assert.ok(leaks(was), `${site} at ${max} would not have leaked: ${was.slice(-30)}`);
  }
  // The goal list's words citation, cut at 80 the old way.
  const words = GOALS().goals[0].observations[0].text.split('session:')[1];
  assert.ok(leaks(r.redact(`${`session:${words}`.slice(0, 80).trimEnd()}…`)));
  assert.deepEqual([...new Set(Object.values(sites).map(([max]) => max))].sort((a, b) => a - b), [...CUT_LENGTHS].sort((a, b) => a - b), 'every cut length has a site');
});

test('no start of the name reaches the history, its records, or its goal list', () => {
  const h = builds.full;
  const session = claudeSessionKey('proj-a', SESSION);
  const thread = sourceKey('cx', THREAD);
  const mine = h.events.filter((e) => e.session === session || e.session === thread);
  assert.ok(mine.length >= 25, `${mine.length} events from the two sessions`);
  const json = JSON.stringify(h);
  assert.ok(!leaks(json), `the history shows "${json.slice(json.toLowerCase().indexOf('qy') - 40, json.toLowerCase().indexOf('qy') + 10)}"`);
  for (const e of mine) assert.ok(!leaks(JSON.stringify(h.record(e.id))), `record ${e.id}`);
  assert.ok(!leaks(JSON.stringify(h.goal('g-cut'))));
  // Each site's excerpt is there, cut, and doesn't end in a start of the name.
  const texts = mine.flatMap((e) => Object.values(e.facts).flatMap((v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).filter((x) => typeof x === 'string') : [])));
  const cutTexts = texts.filter((t) => t.endsWith('…'));
  assert.ok(cutTexts.length >= Object.keys(sites).length - 1, `${cutTexts.length} cut excerpts`);
  for (const t of cutTexts) assert.ok(!endsWithStartOf(t, TERM), t.slice(-30));
  const queued = mine.find((e) => e.kind === 'prompt' && e.facts.evidencedBy === 'queue-record');
  assert.ok(queued?.facts.text.endsWith('…'), 'the absorbed queued prompt is its own cut excerpt');
  const records = mine.map((e) => JSON.stringify(h.record(e.id)));
  assert.ok(records.some((r) => /the build[^"]*… \[\d+ more characters\]/.test(r)), 'a record string was cut at 2,000');
  const unmatched = h.goals[0].unmatched.map((u) => u.ref);
  assert.equal(unmatched.length, 2);
  assert.ok(unmatched[0].endsWith('…') && unmatched[0].startsWith('session:the build'), unmatched[0]);
  assert.equal(unmatched[1], 'session:the [redacted:term]');
  const guard = mine.find((e) => e.kind === 'guard');
  assert.equal(guard.facts.reason, 'PreToolUse:Bash hook error: Refused by [redacted:term]');
});

test('a secret on the line after its key stays hidden in every excerpt and in record(), under both scrubbers', () => {
  const session = claudeSessionKey('proj-a', SESSION);
  for (const [name, h] of Object.entries(builds)) {
    const mine = h.events.filter((e) => e.session === session);
    const shown = (v) => SECRETS.filter((s) => v.includes(s));
    for (const e of mine) {
      assert.deepEqual(shown(JSON.stringify(e.facts)), [], `${name}: ${e.kind} ${e.id}`);
      assert.deepEqual(shown(JSON.stringify(h.record(e.id))), [], `${name}: record ${e.id}`);
    }
    // The excerpts are there: the prompt, the message and the command hold the steps.
    assert.ok(mine.filter((e) => /Deploy steps/.test(JSON.stringify(e.facts))).length >= 3, name);
  }
  // Failing-path partner: read as it's written, line by line, the redactor leaves them.
  for (const r of [full(), createSecretsOnlyRedactor()]) assert.ok(SECRETS.some((s) => r.redact(MULTILINE).includes(s)));
});

// ---- the source: one helper cuts shown text, at the lengths above -----------------------

/** The arguments of a call starting at `open` (the index of its "("), split at top-level commas. */
function callArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = open + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += src[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  return args;
}

test('the list of cut lengths is exactly the lengths the engine cuts to', () => {
  const named = { PROMPT_MAX: LIMITS.prompt, TEXT_MAX: LIMITS.text, CMD_MAX: LIMITS.command, SHORT: LIMITS.short, LONG: 2000 };
  const found = new Map();
  for (const file of ['claude.mjs', 'codex.mjs', 'goals.mjs', 'index.mjs']) {
    const src = readFileSync(join(ROOT, 'lib', 'replay', file), 'utf8');
    for (const m of src.matchAll(/\b(text|cut|redactClip|redactClipFirstLine|redactThenCut)\(/g)) {
      if (src.slice(Math.max(0, m.index - 9), m.index).includes('function')) continue;
      const arg = callArgs(src, m.index + m[0].length - 1)[1];
      if (arg === undefined || arg === 'max') continue;
      // `'branch-'.length + 20` cuts the action word after `branch-` to 20.
      const n = /^\d+$/.test(arg) ? Number(arg) : named[arg] ?? Number(arg.match(/\+\s*(\d+)$/)?.[1]);
      assert.ok(Number.isInteger(n), `${file}: can't read the length "${arg}"`);
      found.set(n, [...(found.get(n) ?? []), file]);
    }
  }
  assert.equal(/const LONG = (\d+);/.exec(readFileSync(join(ROOT, 'lib', 'replay', 'index.mjs'), 'utf8'))?.[1], '2000');
  assert.deepEqual([...found.keys()].sort((a, b) => a - b), [...CUT_LENGTHS].sort((a, b) => a - b), 'a cut length was added or dropped: test it above');
});

// Places in lib/replay that cut or take the first line of a string without the helper,
// each with why it isn't text the engine shows. Anything else fails the scan.
const ALLOWED = [
  ['classify.mjs', 'chain.slice(0, at)', 'a list of command parts, read by a rule'],
  ['classify.mjs', "t.slice(0, t.indexOf('='))", "an environment variable's name, read by a rule"],
  ['classify.mjs', "t.split('=')[0]", "an environment variable's name, read by a rule"],
  ['goals.mjs', 'rest.split(/\\r?\\n/)[0]', 'the raw first line ids are matched on, never shown'],
  ['lookup.mjs', ".split(/[\\\\/]/).pop()", "a repository's name, matched on, never shown"],
  ['outcomes.mjs', 'found.sha.slice(0, 12)', 'a commit id'],
  ['outcomes.mjs', 'sha: landed.sha.slice(0, 12)', 'a commit id'],
  ['outcomes.mjs', 'value: landed.sha.slice(0, 12)', 'a commit id'],
  ['parse-common.mjs', 's.slice(0, n).trimEnd() : s.slice(0, n)', 'the helper itself'],
  ['parse-common.mjs', 'piece.slice(0, piece.length - end.length)', 'the helper itself'],
  ['parse-common.mjs', "redact(lines.join('\\n')).split('\\n')[0]", 'the helper itself: the first line of the redacted lines'],
  ['parse-common.mjs', 'first.slice(0, took ? took.index + took[0].length : at)', 'the helper itself: the first line up to the placeholder that took its break, or to where the readings part'],
  ['parse-common.mjs', 'whole.slice(0, placeholderSafeEnd(whole, max)).trimEnd()', 'the helper itself: a cut before any placeholder'],
  ['timeline.mjs', "k.split('|')[0]", 'an internal map key'],
  ['views.mjs', 'toISOString().slice(0, 10)', 'a date'],
];

// The ways a line of the engine cuts a string or takes a piece of it: the old helpers, a
// slice from the start or the end, substring and substr, and the first or last part of a
// split (by index, shift or pop, a limit of 1, or destructuring).
const CUT_FORMS = [
  /\bclip\(/, /\bclipRef\(/, /\.slice\(\s*0\s*,/, /\.slice\(\s*-/, /\.substring\(/, /\.substr\(/,
  /\.split\([^)]*\)\[0\]/, /\.split\([^)]*\)\.(shift|pop)\(/, /\.split\([^)]*,\s*1\s*\)/, /\[\s*\w+\s*\]\s*=\s*[^;]*\.split\(/,
];

/** Every line of the modules in `dir` that cuts a string or takes its first line, and
 *  the ones of those the allowed list doesn't explain. */
function cutsIn(dir) {
  const hits = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
    readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (CUT_FORMS.some((re) => re.test(line))) hits.push({ file, line: i + 1, text: line.trim() });
    });
  }
  const unexplained = hits.filter((h) => !ALLOWED.some(([file, part]) => file === h.file && h.text.includes(part)));
  return { hits, unexplained: unexplained.map((h) => `${h.file}:${h.line} ${h.text}`) };
}

test('shown text is cut only by the helper: no other cut or first line in lib/replay', () => {
  const { hits, unexplained } = cutsIn(join(ROOT, 'lib', 'replay'));
  assert.deepEqual(unexplained, [], 'cut shown text with redactClip, redactClipFirstLine or redactThenCut, or name why it is safe');
  const unused = ALLOWED.filter(([file, part]) => !hits.some((h) => h.file === file && h.text.includes(part)));
  assert.deepEqual(unused, [], 'an allowed entry no longer matches anything: drop it');
});

test('the scan finds a cut, a first line and the old helpers outside the allowed list (failing-path partner)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-scan-'));
  scratch.push(dir);
  const bad = ['const t = text.slice(0, 80);', "const first = body.split('\\n')[0];", 'const c = clip(s, 40);', 'const r = clipRef(s);', 'const end = text.slice(-80);', "const top = body.split('\\n').shift();", "const [line] = body.split('\\n');", "const one = body.split('\\n', 1);", '// text.slice(0, 80) in a comment is fine'];
  writeFileSync(join(dir, 'views.mjs'), `${bad.join('\n')}\n`);
  assert.deepEqual(cutsIn(dir).unexplained, bad.slice(0, -1).map((l, i) => `views.mjs:${i + 1} ${l}`));
});
