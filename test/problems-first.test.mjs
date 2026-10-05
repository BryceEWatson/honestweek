// "honestweek view" opens on Problems: the landing address, the order the page ranks patterns in
// (claims not backed first, then the stated rule, with "My priority" overriding either), the
// test-case prompts in the catalog, the text the Copy buttons copy, and what each of the page's
// three views draws for an answer: the landing, one problem (#<pattern id>) and what was checked
// (#checked).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import '../lib/view/assets/prefs.js';
import { ASSETS_DIR, startViewServer } from '../lib/view/server.mjs';
import { CLAIM_PATTERNS, loadCatalog, PATTERN_CHECKS } from '../lib/problems/index.mjs';
import { secretShapes } from '../lib/problems/classify.mjs';
import { DRAFTS } from '../lib/problems/drafts.mjs';
import { blocks, drawProblems, words } from './helpers/problems-page.mjs';

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
  assert.match(js, /const copySource = \(p, what\) => \(what === 'fix' \? p\.draft\?\.text : what === 'codex' \? codexText\(p\) : p\.testPrompt\) \?\? null;/);
  // The click copies copySource's text, never the page's markup.
  assert.match(js, /const text = p \? copySource\(p, cb\.dataset\.copy\) : null;\s+if \(text\) copyText\(text, cb,/);
  // Clipboard first (no permission prompt for a click on this page), then the copy command, then selecting the text.
  const copy = js.match(/async function copyText\(text, btn, shown\) \{[^]*?\n  \}/)[0];
  assert.ok(copy.indexOf('navigator.clipboard.writeText') < copy.indexOf("execCommand('copy')") && copy.indexOf("execCommand('copy')") < copy.indexOf('selectNodeContents'));
  // Text with a redaction marker isn't offered for copying: it wouldn't be the fix.
  assert.match(js, /if \(HIDDEN\.test\(t\)\) return `<span class="muted"/);
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest/, 'no request of its own');
});

test("Check the fix works names Codex only where the pattern's check runs on Codex's logs", () => {
  const js = readFileSync(join(ASSETS_DIR, 'problems.js'), 'utf8');
  // The one place the page tells you to paste into Codex is the branch for a check that runs there.
  assert.equal(js.split('Claude Code or Codex').length - 1, 1, 'one "Claude Code or Codex" in the page');
  assert.match(js, /const tryWhere = onCodex\?\.status === 'runs'\s+\? '<p>Paste it into Claude Code or Codex /);
  assert.match(js, /: `<p>Paste it into Claude Code after adding the fix/);
});

test('"Copy for Codex" copies the catalog\'s Codex text, or an instruction\'s own text, never a hook written for Claude Code', () => {
  const js = readFileSync(join(ASSETS_DIR, 'problems.js'), 'utf8');
  const src = js.match(/const SHARED_KINDS = [^\n]+\n[^]*?const codexText = \(p\) => \{[^]*?\n {2}\};/)[0];
  const box = {};
  runInNewContext(`${src}\nthis.codexText = codexText;`, box);
  let shared = 0;
  for (const [id, d] of Object.entries(DRAFTS)) {
    const offered = box.codexText({ draft: d });
    if (d.codex.text) assert.equal(offered, d.codex.text, `${id}: the catalog's own Codex text`);
    else if (['instruction', 'workflow'].includes(d.kind) && d.codex.where.startsWith('In Codex: ')) {
      assert.equal(offered, d.text, `${id}: an instruction goes into AGENTS.md as it is`);
      // The shared text names no Claude Code file or setting.
      assert.doesNotMatch(offered, /settings\.json|CLAUDE\.md|\.claude\b|user settings/, id);
      shared += 1;
    } else assert.equal(offered, null, `${id}: a ${d.kind} written for Claude Code isn't offered for Codex`);
  }
  assert.ok(shared > 10, 'most instructions are offered for both agents');
  assert.equal(box.codexText({ draft: null }), null);
});

// ---- the page, drawn from an answer ----------------------------------------------------------
// A small made-up answer: one session on each agent, a pattern found in the log on both, a low
// one whose check is partial on Codex, one that doesn't run on Codex yet, five possible ones, and
// patterns checked and not found, not checked, and that a log can't show.
const S = { cc: 'cc-aaaaaaaaaaaa', cx: 'cx-bbbbbbbbbbbb', unknown: 'cc-cccccccccccc' };
const TH = { cc: 'th-aaaaaaaaaa', cx: 'th-bbbbbbbbbb', unknown: 'th-cccccccccc' };
let keyN = 0;
const KEYS = 'abcdefghijklmnop';
const nextKey = () => `pf-${String(keyN++).padStart(12, '0').replace(/\d/g, (d) => KEYS[Number(d)])}`;
const F = (pattern, who, { ev = 'derived', severity = 'look', note = 'A note. Then more.', text = null, basis = null, at = '2025-03-12T10:00:00.000Z', kind = null } = {}) => {
  const key = nextKey();
  const event = `${S[who]}.${keyN}.0`;
  return { key, pattern, check: 'c', checkTitle: 'A check', severity, verdictEvidence: ev, basis, rule: 'problems.rule', session: S[who], thread: TH[who], event, related: null, relatedLabel: null, at, lastAt: null, kind, note, text, events: [], steps: null, estimate: null, stillRunning: false, goals: [], zoom: { events: [event], total: null, lanes: [{ thread: TH[who], session: S[who], agent: `${S[who]}:main`, events: [event] }] } };
};
const RUNS = { claudeCode: { status: 'runs' }, codex: { status: 'runs' } };
const draft = (kind, extra = {}) => ({ kind, where: 'Global instructions', title: `Fix for ${kind}`, text: `Do the ${kind} thing.`, codex: { where: 'In Codex: paste it into .codex/AGENTS.md in your home folder.' }, ...extra });
function pattern(id, { status = 'found', tier = 'medium', findings = [], coverage = RUNS, measures = [{ check: 'c', title: 'A check', evidence: 'derived', relation: 'r', ran: true, count: 1, look: 1 }], tokens = null, claim = false, d = draft('instruction'), testPrompt = 'In a new empty folder, try the thing.' } = {}) {
  const sure = findings.filter((f) => f.verdictEvidence === 'recorded' || f.verdictEvidence === 'derived');
  const poss = findings.filter((f) => !sure.includes(f));
  const look = (l) => l.filter((f) => f.severity === 'look').length;
  return {
    id, name: `Catalog name of ${id}`, headline: `Plain words for ${id}`, group: 'process', looksLike: 'What it looks like.', whyItMatters: 'Why it matters.', strength: 'reported', strengthReason: 'Reported.', sourceKinds: { docs: 1 },
    sources: [{ title: 'A published page', link: ['https://example.com', '/a'], date: '2025-01-01', kind: 'docs', says: 'It says so.' }],
    detection: { level: 'derived', summary: 'A signal.', signals: [], falsePositives: [] }, coverage, mitigation: [{ kind: 'instruction', action: 'Another way.' }], related: [],
    status, notRun: null, measures, count: findings.length, look: look(findings), notesFound: findings.length - look(findings), claim,
    sure: { count: sure.length, look: look(sure) }, possible: { count: poss.length, look: look(poss) }, testPrompt, tokens, countEvidence: findings.length ? 'derived' : null,
    priority: status === 'found' ? { tier, reason: `the rule's reason for ${id}` } : null, draft: d, findings, findingsListed: findings.length,
  };
}
const SAID = 'message to the person "Done. All tests pass."';
const answer = () => {
  keyN = 0;
  const patterns = [
    pattern('context-bloat', { tier: 'high', tokens: { tokens: 500, lookTokens: 500, waste: true, label: 'Estimated', evidence: 'inferred' }, findings: [F('context-bloat', 'cx', { note: 'Codex went long. It kept going.' }), F('context-bloat', 'cc', { note: 'Claude Code went long.' }), F('context-bloat', 'unknown', { note: 'An agent the answer does not name.' })], d: draft('hook', { codex: { where: 'In Codex: .codex/hooks.json in your home folder.', text: 'The Codex hook.' } }) }),
    pattern('needless-check-in', { tier: 'low', coverage: { claudeCode: { status: 'runs' }, codex: { status: 'partial', why: 'not seen on Codex yet' } }, findings: [F('needless-check-in', 'cx')] }),
    pattern('busy-polling', { tier: 'low', coverage: { claudeCode: { status: 'partial', why: 'only some waits' }, codex: { status: 'not yet', why: 'no reader yet' } }, findings: [F('busy-polling', 'cc'), F('busy-polling', 'cc', { severity: 'note' })], d: draft('hook', { codex: { where: 'No Codex equivalent yet: nothing to hook.' } }) }),
    pattern('claim-contradicts-evidence', { tier: 'high', claim: true, findings: [F('claim-contradicts-evidence', 'cx', { ev: 'inferred', text: SAID, note: 'The last run failed. The message says tests pass.', basis: [{ part: 'The failed run', level: 'derived', how: 'Its result is an error.' }, { part: 'Nothing after it', level: 'inferred', how: 'A rule reads no later step as a check.' }] })] }),
    ...['test-tampering', 'scope-creep', 'destructive-command', 'secret-exposure'].map((id) => pattern(id, { findings: [F(id, 'cc', { ev: 'inferred', text: 'Bash (shell) git reset --hard origin/main -> ok', note: 'A command that reads as a hard reset ran.' })] })),
    pattern('special-casing-tests', { status: 'clear', findings: [] }),
    pattern('hallucinated-reference', { status: 'unchecked', measures: [], coverage: { claudeCode: { status: 'not yet', why: 'no check' }, codex: { status: 'not yet', why: 'no check' } } }),
    pattern('sycophancy', { status: 'undetectable', measures: [], coverage: { claudeCode: { status: 'not yet', why: 'no check' }, codex: { status: 'not yet', why: 'no check' } } }),
  ];
  const statusCounts = { found: 0, clear: 0, unchecked: 0, undetectable: 0 };
  for (const p of patterns) statusCounts[p.status] += 1;
  return {
    window: { from: '2025-03-10', to: '2025-03-16', timezone: 'UTC' }, catalog: { about: 'A made-up catalog.', sources: 9, checkedOn: ['2025-01-01'] },
    groups: [{ id: 'process', name: 'Process', description: 'How the work goes.' }], priorityRule: null, statusCounts,
    coverage: { sessions: { value: 3, evidence: 'derived' }, tokens: { value: 1000, evidence: 'recorded' }, usageRecorded: true, toolCalls: { value: 9 }, modelCalls: { value: 9 } },
    rules: [], checks: [], patterns, focus: null,
    sessions: { [S.cc]: { title: 'Fix the parser', thread: TH.cc, tool: 'claude-code', repo: 'your-project' }, [S.cx]: { title: 'Widen the table', thread: TH.cx, tool: 'codex', repo: 'a-shared-repo' }, [S.unknown]: { title: 'Something else', thread: TH.unknown, tool: null } },
  };
};
const TREND = { earlier: { from: '2025-03-03', to: '2025-03-09', days: 7, sessions: 0 }, trend: [] };
const AGENT_NAME = { 'claude-code': 'Claude Code', codex: 'Codex' };

test('the headline counts what the page lists, and the line under it says when there is nothing before to compare', async () => {
  const { el } = await drawProblems(answer(), { trend: TREND });
  // One High or Medium pattern found in the log, two Low ones, five possible.
  assert.equal(el('headline').textContent, '1 problem to fix, 2 smaller, 5 to check');
  assert.match(words(el('lead').innerHTML), /^3 sessions derived , 1\.0k tokens recorded checked\. Worst first\./);
  assert.equal(el('trendNote').textContent, 'No logs in the 7 days before, so no trend yet.');
  // Low priority sits behind one control, closed; routine notes behind a quiet switch.
  const cards = el('cards').innerHTML;
  assert.match(cards, /<button type="button" class="pmorebtn" data-low aria-expanded="false" aria-controls="tier-low"><span>2 smaller things found, each low priority<\/span>/);
  assert.match(cards, /<div class="pcards" data-tier="t-low" id="tier-low" hidden>/);
  assert.match(cards, /<input type="checkbox" data-routine-all autocomplete="off"> Show routine notes \(1 found\)/);
  // Possible is open: three cards, then the rest behind one control.
  const poss = el('possible').innerHTML;
  assert.equal(el('possSec').hidden, false);
  assert.equal(blocks(poss.split('data-possmore')[0], 'article', 'pc-poss').length, 3);
  assert.match(poss, /<span>2 more possible problems<\/span>/);
  assert.match(poss, /<div class="pcards" id="possRest" hidden>/);
  // The quiet link to what was checked, with one line of counts.
  assert.equal(words(el('checkedLine').innerHTML), 'What was checked 11 known problems: 8 found, 1 not found, 2 not checked');
  assert.match(el('checkedLine').innerHTML, /<a href="#checked">What was checked<\/a>/);
});

test('each finding row names its agent from its session, its time, its session, a short note, and the steps to see', async () => {
  const D = answer();
  const { el } = await drawProblems(D);
  const rows = blocks(el('cards').innerHTML, 'li', 'frow');
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    const session = r.match(/data-session="([^"]+)"/)[1];
    const tool = D.sessions[session].tool;
    const agents = [...r.matchAll(/<span class="agent">([^<]+)<\/span>/g)].map((m) => m[1]);
    // The agent's name comes only from the session the answer names; an unknown one gets none.
    assert.deepEqual(agents, tool ? [AGENT_NAME[tool]] : [], session);
    // So does the repository it worked in; a session the answer gives none for shows none.
    const repos = [...r.matchAll(/<span class="repotag"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(repos, D.sessions[session].repo ? [D.sessions[session].repo] : [], session);
    assert.match(r, /<time datetime="[^"]+">/);
    assert.ok(r.includes(D.sessions[session].title), 'the session');
    assert.match(r, /<a class="see" href="replay\.html\?session=[^"]+~zoom~pf-[a-p]{12}" data-zoomlink[^>]*>See the steps/);
    // The note's first sentence shows; the whole note is behind "more".
    assert.match(r, /<details class="fmore"><summary>more<\/summary>/);
    assert.ok(r.indexOf('<svg class="evsym"') > 0, 'the row says how it is known');
  }
  const first = rows.find((r) => r.includes(S.cx));
  assert.ok(words(first.split('<details')[0]).includes('Codex went long.') && !words(first.split('<details')[0]).includes('It kept going.'));
  assert.ok(words(first).includes('It kept going.'));
  // A possible card names its agent too, beside what the agent said and what the log shows.
  const card = blocks(el('possible').innerHTML, 'article', 'pc-poss').find((c) => c.includes('claim-contradicts-evidence'));
  assert.match(card, /<span class="agent">Codex<\/span>/);
  assert.match(words(card), /The agent said “Done\. All tests pass\.” The log shows The last run failed\./);
  const ran = blocks(el('possible').innerHTML, 'article', 'pc-poss').find((c) => c.includes('test-tampering'));
  assert.match(words(ran), /The agent ran git reset --hard origin\/main The log shows/);
  assert.match(ran, /<a class="see" href="#test-tampering" data-pick="pf-[a-p]{12}">See the moment/);
});

test('the coverage badge shows only where a check runs in part or not at all on an agent, and says which', async () => {
  const D = answer();
  const { el } = await drawProblems(D);
  const card = (id) => blocks(`${el('cards').innerHTML}${el('possible').innerHTML}`, 'article', 'pc').find((c) => c.includes(`data-pattern="${id}"`));
  const badges = (html) => [...html.matchAll(/<span class="cov" data-cov="[^"]+" title="[^"]*">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(badges(card('context-bloat')), [], 'runs on both: no badge');
  assert.deepEqual(badges(card('needless-check-in')), ['Partial on Codex']);
  assert.deepEqual(badges(card('busy-polling')), ['Partial on Claude Code', 'Not on Codex yet']);
  assert.match(card('needless-check-in'), /title="Partial on Codex: not seen on Codex yet\."/, 'the reason on hover');
  for (const p of D.patterns.filter((x) => x.status === 'found' && x.coverage.codex.status === 'runs' && x.coverage.claudeCode.status === 'runs')) assert.deepEqual(badges(card(p.id)), [], p.id);
  // A pattern with no check gets no badge: "not checked" already says it.
  const { el: c } = await drawProblems(D, { hash: '#checked' });
  const rest = c('restLists').innerHTML;
  // A pattern not found keeps the catalog's name: the past-tense headline would say it happened.
  assert.match(rest, /Catalog name of hallucinated-reference/);
  assert.doesNotMatch(rest, /Plain words for/);
  assert.doesNotMatch(rest, /class="cov"/);
});

test('cards and the opened problem use the plain headline; the catalog name shows in "About this problem"', async () => {
  const D = answer();
  const { el } = await drawProblems(D);
  const cards = `${el('cards').innerHTML}${el('possible').innerHTML}`;
  for (const p of D.patterns.filter((x) => x.status === 'found')) assert.match(cards, new RegExp(`<a class="ptitle" href="#${p.id}">Plain words for ${p.id}</a>`));
  assert.doesNotMatch(cards, /Catalog name of/);
  const { el: d } = await drawProblems(D, { hash: '#context-bloat' });
  const html = d('detail').innerHTML;
  assert.match(html, /<h1 id="detailH" tabindex="-1">Plain words for context-bloat<\/h1>/);
  const about = blocks(html, 'details', 'pmore')[0];
  assert.match(about, /^<details class="pmore" data-about="context-bloat"><summary>Why it matters, and the published sources<\/summary>/, 'closed');
  assert.match(about, /<h3>About this problem<\/h3><p>The catalog names it “<span class="pname">Catalog name of context-bloat<\/span>”/);
  assert.match(about, /<a href="https:\/\/example\.com\/a" rel="noreferrer noopener" target="_blank">A published page<\/a>/);
});

test('#<pattern id> opens one problem: when, what happened in order, Replay, the fix for either agent, a prompt to check it, and my priority', async () => {
  const D = answer();
  const { el, doc } = await drawProblems(D, { hash: '#claim-contradicts-evidence' });
  assert.equal(el('landing').hidden, true);
  assert.equal(el('detail').hidden, false);
  assert.equal(el('checkedView').hidden, true);
  assert.equal(doc.body.dataset.view, 'problem');
  const html = el('detail').innerHTML;
  // Back to the list, the tier and how the finding is known, the count.
  assert.match(html, /^<a class="backlink" href="problems\.html" data-home><span aria-hidden="true">←<\/span> All problems<\/a>/);
  assert.match(html, /<span class="prio t-high">High<\/span> <span class="muted">Possible: check it yourself<\/span> <span class="chip inferred"/);
  assert.match(html, /data-trend="claim-contradicts-evidence" data-kind="possible"/);
  // When: each moment a button naming its agent, the one shown pressed.
  const moments = blocks(html, 'button', 'moment');
  assert.equal(moments.length, 1);
  assert.match(moments[0], /aria-pressed="true"/);
  assert.match(moments[0], /<span class="agent">Codex<\/span>/);
  // What happened: the basis parts in order, each with how it's known, then the agent's words.
  const steps = blocks(html, 'ol', 'pd-steps')[0];
  assert.deepEqual([...steps.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]), ['The failed run', 'Nothing after it', 'The agent said']);
  assert.deepEqual([...steps.matchAll(/<span class="steplvl"><span class="chip (\w+)"/g)].map((m) => m[1]), ['derived', 'inferred', 'recorded']);
  assert.match(steps, /<blockquote class="words">Done\. All tests pass\.<\/blockquote>/);
  assert.match(html, /<a class="see" href="replay\.html\?session=cx-bbbbbbbbbbbb#th-bbbbbbbbbb~zoom~pf-[a-p]{12}" data-zoomlink[^>]*>Open in Replay/);
  // The fix: an agent switch, the text for the agent picked (this moment's, Codex), one Copy.
  const fix = blocks(html, 'section', 'pd-fix')[0];
  assert.deepEqual([...fix.matchAll(/data-fixagent="(\w+)" aria-pressed="(\w+)"/g)].map((m) => [m[1], m[2]]), [['claude', 'false'], ['codex', 'true']]);
  assert.equal([...fix.matchAll(/data-copy="/g)].length, 1);
  assert.match(fix, /data-copy="codex"[^>]*>Copy for Codex<\/button>/);
  assert.match(fix, /<pre class="fixtext" data-copytext="codex">Do the instruction thing\.<\/pre>/);
  assert.match(fix, /<summary>1 other way<\/summary>/);
  // Check the fix works, and My priority (moved here from the cards).
  assert.match(html, /<h2 id="tryH">Check the fix works<\/h2>[^]*data-copytext="try">In a new empty folder, try the thing\.<\/code><button type="button" class="copybtn" data-copy="try" data-for="claim-contradicts-evidence">Copy prompt<\/button>/);
  assert.match(html, /<h2 id="priH">My priority<\/h2><label class="pmine"><span class="sr">My priority<\/span><select data-pri="claim-contradicts-evidence">/);
  assert.match(html, /A claim not backed, so it comes first\./);
  // The landing's cards carry no priority control of their own.
  const { el: home } = await drawProblems(D);
  assert.doesNotMatch(`${home('cards').innerHTML}${home('possible').innerHTML}`, /data-pri=/);
  // A pattern not found opens too, saying so, with its fix and no "When".
  const { el: clear } = await drawProblems(D, { hash: '#special-casing-tests' });
  assert.match(clear('detail').innerHTML, /Checked; nothing found in this window\./);
  assert.doesNotMatch(clear('detail').innerHTML, /class="pd-when"|data-pri=/);
  assert.match(clear('detail').innerHTML, /Stop it happening again/);
});

test('#checked opens "What was checked"; the controls that left the first screen are all there', async () => {
  const html = readFileSync(join(ASSETS_DIR, 'problems.html'), 'utf8');
  const landing = html.slice(html.indexOf('id="landing"'), html.indexOf('id="detail"'));
  const checked = html.slice(html.indexOf('id="checkedView"'), html.indexOf('</main>'));
  for (const id of ['insights', 'facts', 'priRule', 'checksBox', 'foot', 'restLists']) {
    assert.ok(checked.includes(`id="${id}"`), `${id} is in What was checked`);
    assert.ok(!landing.includes(`id="${id}"`), `${id} left the landing`);
  }
  // The /insights toggle, Run /insights and Run with Codex are drawn into #insights, unchanged.
  const insights = readFileSync(join(ASSETS_DIR, 'insights.js'), 'utf8');
  for (const s of ['data-ins-on', 'data-ins-run', 'data-cx-run', "getElementById('insights')"]) assert.ok(insights.includes(s), s);
  const { el, doc } = await drawProblems(answer(), { hash: '#checked' });
  assert.equal(doc.body.dataset.view, 'checked');
  assert.equal(el('checkedView').hidden, false);
  assert.equal(el('landing').hidden, true);
  const rest = el('restLists').innerHTML;
  assert.deepEqual([...rest.matchAll(/<details class="restlist" data-list="(\w+)"><summary>([^<]+)<span class="hcount">(\d+)/g)].map((m) => [m[1], words(m[2]), m[3]]),[['clear', 'Not found in this window', '1'], ['unchecked', 'Not checked', '1'], ['undetectable', "Can't be checked from logs", '1']]);
  assert.match(el('priRule').innerHTML, /<summary>How priority is set<\/summary>/);
  assert.match(el('foot').innerHTML, /<summary><h2 class="sh">About this page<\/h2><\/summary>/);
  assert.equal(el('checkedLead').textContent, '11 known problems: 8 found, 1 not found, 2 not checked.');
});

test('every string from a log is escaped, and a cut never splits a redaction placeholder', async () => {
  const D = answer();
  const f = D.patterns[0].findings[0];
  f.note = `It read <b>${'x'.repeat(100)}</b> and [redacted:term] near the end of this long first sentence here. Then more.`;
  D.sessions[S.cx].title = '<i>tag</i> [redacted:term]';
  const { el } = await drawProblems(D);
  const row = blocks(el('cards').innerHTML, 'li', 'frow').find((r) => r.includes(S.cx));
  assert.doesNotMatch(row, /<b>x|<i>tag/);
  assert.ok(row.includes('&lt;b&gt;'));
  assert.ok(row.includes('“&lt;i&gt;tag&lt;/i&gt; [redacted:term]”'));
  // The short note is cut before the placeholder rather than inside it.
  const shown = row.split('<details')[0];
  assert.doesNotMatch(shown, /\[redacted(?!:term\])/);
});

test('"Show all" counts only the rows in view: routine notes join the count once the switch is on', async () => {
  const D = answer();
  const note = (n) => F('context-bloat', 'cc', { severity: 'note', note: `Routine note ${n}.` });
  const p = D.patterns.find((x) => x.id === 'context-bloat');
  p.findings = [p.findings[0], ...[1, 2, 3, 4].map(note)];
  const { el } = await drawProblems(D);
  const card = () => blocks(el('cards').innerHTML, 'article', 'pc').find((c) => c.includes('data-pattern="context-bloat"'));
  assert.doesNotMatch(card(), /Show all/, 'one row worth a look, and no button promising five');
  assert.doesNotMatch(card(), /s-note/);
  el('content').fire('change', { target: { checked: true, matches: (s) => s === '[data-routine-all]' } });
  assert.match(card(), /Show all 5 listed/);
  assert.equal(el('cards').classList.contains('show-routine'), true);
});
