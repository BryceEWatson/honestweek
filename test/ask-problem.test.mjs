// problems --pattern and --finding (issue 206): one problem's cause, fix, certainty and timeline,
// on the made-up demo week. The catalog's general text is labelled as general and kept apart from
// what the log shows; every finding of the pattern is listed in time order with its steps and how
// each is known; certainty never gives a confidence number; and plain `problems` is unchanged.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { GENERAL_NOTE, NO_MOTIVE_NOTE, parseAskArgs, patternOf, PRECISION_NOTE, runAsk, TEXT_NOTE } from '../lib/ask.mjs';
import { pageLink } from '../lib/view/page-link.mjs';
import { buildDemoWeek } from '../lib/demo/week.mjs';
import { loadCatalog } from '../lib/problems/index.mjs';
import { DEMO_TERM } from '../lib/view.mjs';

const d = buildDemoWeek();
after(() => rmSync(d.root, { recursive: true, force: true }));
const redaction = d.config.redaction ?? {};
const WEEK = { config: { ...d.config, redaction: { ...redaction, terms: [...(redaction.terms ?? []), DEMO_TERM] } }, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, demo: true };

async function asked(argv) {
  const out = [];
  const err = [];
  const code = await runAsk({ command: 'problems', argv, week: WEEK, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, out: out.join(''), err: err.join('') };
}
async function json(argv) {
  const r = await asked([...argv, '--json']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}
const EVIDENCE = new Set(['recorded', 'derived', 'inferred', 'missing']);

test('a pattern is named by its id, its name, or a piece only it has; more than one match asks which', () => {
  assert.equal(patternOf('cache-miss'), 'cache-miss');
  const name = loadCatalog().patterns.find((p) => p.id === 'cache-miss').name;
  assert.equal(patternOf(name.toUpperCase()), 'cache-miss');
  assert.equal(patternOf('  cache-mis '), 'cache-miss');
  assert.throws(() => patternOf('session'), /patterns match that: .*context-bloat.*Give its id/);
  assert.throws(() => patternOf('nothing-like-this'), /no pattern's id or name has that in it/);
  assert.throws(() => patternOf(' '), /needs a pattern id or name/);
  assert.throws(() => parseAskArgs('find', ['--pattern', 'x']), /unknown option "--pattern"/, "--pattern is problems' alone");
  assert.throws(() => parseAskArgs('replay', ['--finding', 'x']), /unknown option "--finding"/);
});

test('--pattern answers cause, fix, certainty and timeline for every finding of the pattern', async () => {
  const all = await json([]);
  assert.ok(all.patterns.length > 5);
  for (const listed of all.patterns) {
    const o = await json(['--pattern', listed.id]);
    assert.equal(o.general, GENERAL_NOTE);
    assert.equal(o.pattern.id, listed.id);
    assert.equal(o.pattern.status, 'found');
    assert.equal(o.finding, null);
    // Every finding, not just the ones the list shows, and the same ones.
    assert.equal(o.findings.length, listed.count, listed.id);
    assert.deepEqual(new Set(o.findings.map((f) => f.key)), new Set(listed.findings.map((f) => f.key)));
    const times = o.findings.map((f) => f.at);
    assert.deepEqual(times, [...times].sort(), `${listed.id}: in time order`);
    // Cause: the catalog's words as general, the log's as quoted, and no motive.
    const cat = loadCatalog().patterns.find((p) => p.id === listed.id);
    assert.equal(o.cause.general.looksLike, cat.looksLike);
    assert.equal(o.cause.general.whyItMatters, cat.whyItMatters);
    assert.equal(o.cause.note, NO_MOTIVE_NOTE);
    for (const f of o.findings) {
      assert.ok(EVIDENCE.has(f.evidence), `${f.key}: ${f.evidence}`);
      for (const b of f.basis) assert.ok(EVIDENCE.has(b.evidence), `${f.key}: ${b.part}`);
      assert.equal(typeof f.title.quoted, 'string');
      for (const e of f.recordedSteps) {
        assert.ok(EVIDENCE.has(e.evidence), `${f.key} ${e.id}: ${e.evidence}`);
        assert.equal(typeof e.text.quoted, 'string', `${f.key} ${e.id}: log text is quoted`);
        assert.deepEqual(pageLink(e.page), { page: e.page });
      }
      assert.ok(f.recordedSteps.length > 0, `${f.key} has the steps its check recorded`);
      assert.equal(f.zoomPage, `replay.html?session=${f.session}#${f.thread}~zoom~${f.key}`);
      assert.deepEqual(pageLink(f.zoomPage), { page: f.zoomPage });
    }
    // Fix: the catalog's mitigations and ready-made fix, as they are.
    assert.deepEqual(o.fix.mitigation.map((m) => m.action), cat.mitigation.map((m) => m.action));
    assert.equal(o.fix.general, true);
    // Certainty: how it's known, and no confidence number anywhere.
    assert.equal(o.certainty.strength, cat.strength);
    assert.deepEqual(o.certainty.detection.falsePositives, cat.detection.falsePositives);
    assert.equal(o.certainty.sources.length, cat.sources.length);
    for (const s of o.certainty.sources) assert.match(s.url, /^https?:\/\//);
    assert.deepEqual(o.certainty.precision, { measured: false, note: PRECISION_NOTE });
    assert.equal(Object.values(o.certainty.findings).reduce((a, b) => a + b, 0), o.findings.length);
    assert.doesNotMatch(JSON.stringify(o), /"confidence"/i);
    // Timeline: each day of the window once, adding up to the findings.
    assert.deepEqual(o.timeline.byDay.map((x) => x.day), ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15', '2025-03-16']);
    assert.equal(o.timeline.byDay.reduce((a, x) => a + x.findings, 0), o.findings.length);
    assert.equal(o.timeline.byDay.reduce((a, x) => a + x.worthALook, 0), o.findings.filter((f) => f.severity === 'look').length);
    assert.equal(o.timeline.first, o.findings[0]?.at ?? null);
    // Redacted as the page shows it: the demo's private word never shows.
    assert.doesNotMatch(JSON.stringify(o), new RegExp(DEMO_TERM, 'i'));
  }
});

test('the fix carries the ready-made fix and how to test it; a rule a finding names comes with its words', async () => {
  const o = await json(['--pattern', 'claim-contradicts-evidence']);
  assert.equal(o.fix.draft.title, 'Block a success claim after a failing check');
  assert.equal(typeof o.fix.draft.text, 'string');
  assert.equal(typeof o.fix.draft.codex.where, 'string');
  assert.equal(typeof o.fix.test.prompt, 'string');
  assert.equal(typeof o.fix.test.expect.works, 'string');
  assert.deepEqual(o.fix.fixTests, []);
  assert.ok(Object.keys(o.rules).length > 0, 'rules named by its findings');
  for (const [id, text] of Object.entries(o.rules)) assert.ok(typeof text === 'string' && text.length > 0, id);
});

test('--finding answers one finding, the same as it reads in its pattern', async () => {
  const p = await json(['--pattern', 'cache-miss']);
  const want = p.findings.at(-1);
  const o = await json(['--finding', want.key]);
  assert.equal(o.finding, want.key);
  assert.equal(o.pattern.id, 'cache-miss');
  assert.deepEqual(o.findings, [want]);
  assert.equal(o.timeline.byDay.reduce((a, x) => a + x.findings, 0), 1);
  const t = await asked(['--finding', want.key]);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, new RegExp(`^honestweek problems: finding ${want.key}, of the pattern`));
  assert.ok(t.out.includes(`page ${want.zoomPage}`));
  assert.ok(t.out.includes(`--page "${want.zoomPage}"`), 'opens on the finding, zoomed');
});

test('--pattern and --finding refuse each other, --session, a malformed key, and a key the window has not', async () => {
  for (const [argv, re] of [
    [['--pattern', 'cache-miss', '--finding', 'pf-aaaaaaaaaaaa'], /--pattern and --finding can't be combined/],
    [['--pattern', 'cache-miss', '--session', 'cc-aaaaaaaaaaaa'], /--session can't be combined with --pattern/],
    [['--finding', 'pf-aaaaaaaaaaaa', '--session', 'cc-aaaaaaaaaaaa'], /--session can't be combined with --finding/],
    [['--finding', 'pf-1'], /a finding's key looks like pf- and 12 letters/],
    [['--finding', 'pf-aaaaaaaaaaaa'], /No finding in this window has that key..* saved session outside these dates .* problems --session <session>/],
    [['--pattern', 'session'], /patterns match that/],
  ]) {
    const r = await asked(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, re);
    assert.equal(r.out, '');
  }
});

test('a pattern no check looks for still answers its cause, fix and certainty, with no count rather than a zero', async () => {
  const none = loadCatalog().patterns.find((p) => p.id === 'sycophancy');
  const o = await json(['--pattern', none.id]);
  assert.equal(o.pattern.status, 'unchecked');
  assert.deepEqual(o.findings, []);
  assert.equal(o.cause.general.looksLike, none.looksLike);
  assert.equal(o.pattern.count, null, 'not looked for is no count, not a zero');
  assert.equal(o.pattern.workedOut, null);
  assert.equal(o.pattern.possible, null);
  assert.equal(o.timeline.byDay, null);
  const t = await asked(['--pattern', none.id]);
  assert.match(t.out, /This pattern is not looked for: there's no check for it yet\./);
  assert.match(t.out, /What the log shows: nothing, since no check looks for it\./);
  assert.match(t.out, /No check looks for this pattern, so there's no count to show\./);
  assert.doesNotMatch(t.out, /Per day:|No finding in this window/);
});

test('a pattern checked with nothing found counts zero on every day, and says so', async () => {
  const o = await json(['--pattern', 'busy-polling']);
  assert.equal(o.pattern.status, 'clear');
  assert.equal(o.pattern.count, 0);
  assert.deepEqual(o.pattern.workedOut, { count: 0, worthALook: 0 });
  assert.ok(o.timeline.byDay.length === 7 && o.timeline.byDay.every((x) => x.findings === 0));
  const t = await asked(['--pattern', 'busy-polling']);
  assert.match(t.out, /This pattern is checked, with nothing found in this window\./);
  assert.match(t.out, /What the log shows: nothing in this window\./);
  assert.match(t.out, /\n {2}Per day: 03-10 0, /);
  assert.match(t.out, /\n {2}No finding in this window\.\n/);
});

test('the header names the findings worth a look, the ones the priority rests on', async () => {
  const o = await json(['--pattern', 'premature-stop']);
  const look = o.pattern.workedOut.worthALook + o.pattern.possible.worthALook;
  assert.equal(look, o.findings.filter((f) => f.severity === 'look').length);
  const t = await asked(['--pattern', 'premature-stop']);
  assert.ok(t.out.includes(`; ${look} worth a look. `), 'the count beside the priority');
  assert.match(t.out, / priority, from the findings worth a look, /);
});

test('the text answer has its four parts, labels general text, and says check precision is unmeasured', async () => {
  const r = await asked(['--pattern', 'claim-contradicts-evidence']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[1], TEXT_NOTE);
  assert.equal(lines[2], GENERAL_NOTE);
  for (const part of ['Cause', "Fix (general, from honestweek's catalog; nothing is applied for you)", 'How sure', 'Timeline (UTC)']) assert.ok(lines.includes(part), part);
  assert.ok(lines.some((l) => l.startsWith('  General, what it looks like: ')));
  assert.ok(lines.some((l) => l.startsWith('  General, what can set it off wrongly:')));
  assert.ok(r.out.includes(PRECISION_NOTE));
  assert.ok(r.out.includes(NO_MOTIVE_NOTE));
  assert.match(r.out, /\n {2}Per day: 03-10 0, 03-11 \d/);
  // Log text sits on a line of its own that starts with ">", or in double quotes.
  assert.ok(lines.some((l) => /^ {8}> /.test(l)), 'a recorded step quoted');
  assert.doesNotMatch(r.out, / +$/m, 'no line ends in a space');
  assert.doesNotMatch(r.out, new RegExp(DEMO_TERM, 'i'));
  assert.match(r.out, /\nOpen it on the page: .* view --demo --page "replay\.html\?session=[a-z]{2}-[a-p]+#th-[a-p]+~zoom~pf-[a-p]{12}"\n/);
  assert.match(r.out, /\nNext: .* replay [a-z]{2}-[a-p]+ --at \S+\n$/);
});

test('/api/problems?pattern= answers an id the catalog has, and refuses one it has not', async () => {
  const r = await asked(['--pattern', 'not-a-real-pattern-id-at-all']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no pattern's id or name has that in it/);
});
