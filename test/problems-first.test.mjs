// "honestweek view" opens on Problems: the landing address, the order the page ranks patterns in
// (claims not backed first, then the stated rule, with "My priority" overriding either), the
// test-case prompts in the catalog, and the text the Copy buttons copy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

import '../lib/view/assets/prefs.js';
import { ASSETS_DIR, startViewServer } from '../lib/view/server.mjs';
import { CLAIM_PATTERNS, loadCatalog, PATTERN_CHECKS } from '../lib/problems/index.mjs';
import { secretShapes } from '../lib/problems/classify.mjs';

const { createPrefs, order } = globalThis.HWPrefs;

const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});
const get = (port, path) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

test('the bare address opens the Problems page; Find, Goals and Replay keep their own addresses', async () => {
  const s = await startViewServer({ data: { route: async () => ({ status: 200, body: {} }), leakCheck: () => ({}) } });
  servers.push(s);
  const page = (f) => readFileSync(join(ASSETS_DIR, f), 'utf8');
  const home = await get(s.port, '/');
  assert.equal(home.status, 200);
  assert.equal(home.body, page('problems.html'));
  // An old bookmark to Find, and the other pages, still answer with themselves.
  for (const f of ['search.html', 'goal.html', 'replay.html', 'problems.html']) {
    const r = await get(s.port, `/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.body, page(f), f);
  }
  // The address the command prints and opens is the bare one, so it lands on Problems.
  assert.match(s.address('printed'), /^http:\/\/127\.0\.0\.1:\d+\/#c=[0-9a-f]+$/);
  // Every page's header names Find, Goals and Replay, one click away, and the brand goes home.
  for (const f of ['search.html', 'goal.html', 'replay.html', 'problems.html']) {
    const t = page(f);
    for (const link of ['search.html', 'goal.html', 'replay.html']) assert.match(t, new RegExp(`<nav[^]*href="${link}"[^]*</nav>`), `${f}: ${link}`);
    assert.match(t, /<a class="brand" href="problems\.html">honestweek<\/a>/, f);
  }
});

// ---- the order -------------------------------------------------------------------------------
function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const P = (id, tier, { claim = false, tokens = 0, look = 1, strength = 0 } = {}) => ({ id, claim, priority: { tier, tokens, look, strength } });
const ids = (list) => list.map((p) => p.id);

test('claims not backed come first, then the stated rule; "My priority" overrides either', () => {
  const prefs = createPrefs({ localStorage: storage(), noEvents: true });
  const patterns = [
    P('context-bloat', 'high', { tokens: 900 }),
    P('action-loop', 'low', { look: 9 }),
    P('unverified-done-claim', 'medium', { claim: true }),
    P('secret-exposure', 'high', { look: 4 }),
    P('claim-contradicts-evidence', 'high', { claim: true }),
    P('scope-creep', 'medium', { look: 2 }),
  ];
  prefs.setKnown(patterns.map((p) => p.id));
  // By default: the two claim patterns (High before Medium), then High by tokens, Medium, Low.
  assert.deepEqual(ids(order(prefs, patterns)), ['claim-contradicts-evidence', 'unverified-done-claim', 'context-bloat', 'secret-exposure', 'scope-creep', 'action-loop']);
  // My priority on a claim pattern takes it out of first place and puts it where its tier says.
  prefs.setTier('unverified-done-claim', 'low', 'medium');
  assert.deepEqual(ids(order(prefs, patterns)), ['claim-contradicts-evidence', 'context-bloat', 'secret-exposure', 'scope-creep', 'action-loop', 'unverified-done-claim']);
  // Raised to High by hand, it ranks among the High patterns by the rule, not ahead of them all.
  prefs.setTier('unverified-done-claim', 'high', 'medium');
  assert.deepEqual(ids(order(prefs, patterns)), ['claim-contradicts-evidence', 'context-bloat', 'secret-exposure', 'unverified-done-claim', 'scope-creep', 'action-loop']);
  // My priority on any other pattern moves it by tier; the claims not backed stay first.
  prefs.setTier('unverified-done-claim', 'medium', 'medium');
  prefs.setTier('action-loop', 'high', 'low');
  assert.deepEqual(ids(order(prefs, patterns)), ['claim-contradicts-evidence', 'unverified-done-claim', 'context-bloat', 'action-loop', 'secret-exposure', 'scope-creep']);
  // The claim patterns are the two the brief names, and the server marks only those.
  assert.deepEqual([...CLAIM_PATTERNS], ['unverified-done-claim', 'claim-contradicts-evidence']);
});

// ---- the catalog's test prompts -----------------------------------------------------------------
test('every pattern with a check has a short, safe test prompt; patterns without one have none', () => {
  const catalog = loadCatalog();
  for (const p of catalog.patterns) {
    if (!PATTERN_CHECKS[p.id]) {
      assert.equal(p.testPrompt, undefined, `${p.id}: no check, so no prompt to watch it get caught`);
      continue;
    }
    const t = p.testPrompt;
    assert.equal(typeof t, 'string', `${p.id}: a test prompt`);
    assert.ok(t.length >= 30 && t.length <= 300, `${p.id}: short (${t.length} characters)`);
    // Nothing that reaches the network, pushes, or deletes outside a folder it made.
    assert.doesNotMatch(t, /https?:|\bcurl\b|\bwget\b|git push|--force|\brm\b|Remove-Item|DROP|sudo|npm (?:install|publish)/i, p.id);
    // No secret, or anything shaped like one.
    assert.deepEqual(secretShapes(t), {}, `${p.id}: nothing secret-shaped`);
    assert.doesNotMatch(t, /—/, `${p.id}: no em dash`);
  }
  // A prompt that writes anything does it in a new empty folder it makes, never the folder you're in.
  for (const p of catalog.patterns.filter((x) => x.testPrompt && /\b(?:write|create|add|commit|change|edit)\b/i.test(x.testPrompt))) assert.match(p.testPrompt, /in a new empty folder/i, p.id);
  // A hard reset or a skipped hook happens only in a folder the prompt has just made.
  for (const id of ['destructive-command', 'bypassing-safeguards']) assert.match(catalog.patterns.find((p) => p.id === id).testPrompt, /^In a new empty folder/, id);
});

// ---- Copy ------------------------------------------------------------------------------------
test('Copy copies the fix and the prompt exactly as the server sent them, and never a redacted one', () => {
  const js = readFileSync(join(ASSETS_DIR, 'problems.js'), 'utf8');
  assert.match(js, /const copySource = \(p, what\) => \(what === 'fix' \? p\.draft\?\.text : what === 'codex' \? p\.draft\?\.codex\?\.text : p\.testPrompt\) \?\? null;/);
  // The click copies copySource's text, never the page's markup.
  assert.match(js, /const text = p \? copySource\(p, cb\.dataset\.copy\) : null;\s+if \(text\) copyText\(text, cb,/);
  // Clipboard first (no permission prompt for a click on this page), then the copy command, then selecting the text.
  const copy = js.match(/async function copyText\(text, btn, shown\) \{[^]*?\n  \}/)[0];
  assert.ok(copy.indexOf('navigator.clipboard.writeText') < copy.indexOf("execCommand('copy')") && copy.indexOf("execCommand('copy')") < copy.indexOf('selectNodeContents'));
  // Text with a redaction marker isn't offered for copying: it wouldn't be the fix.
  assert.match(js, /if \(HIDDEN\.test\(t\)\) return `<span class="muted"/);
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest/, 'no request of its own');
});

test("Try it names Codex only where the pattern's check runs on Codex's logs", () => {
  const js = readFileSync(join(ASSETS_DIR, 'problems.js'), 'utf8');
  // The one place the page tells you to paste into Codex is the branch for a check that runs there.
  assert.equal(js.split('Claude Code or Codex').length - 1, 1, 'one "Claude Code or Codex" in the page');
  assert.match(js, /const tryWhere = onCodex\?\.status === 'runs'\s+\? '<p>Paste it into Claude Code or Codex /);
  assert.match(js, /: `<p>Paste it into Claude Code after adding the fix/);
});
