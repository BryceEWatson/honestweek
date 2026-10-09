// backingCheck (lib/problems/backing.mjs) decides which check backs a claim the same way the
// Problems checks do. On every turn the done-claim and claim-against-evidence checks look at,
// in the replay corpus and the demo week, the two give the same answer. Then the cases the
// brief adds on top: a check in another folder, a claim's place, and no edit to start from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildDemoWeek } from '../lib/demo/week.mjs';
import { buildWorkHistory } from '../lib/replay/index.mjs';
import { CHECKS, runnableEdit } from '../lib/problems/checks.mjs';
import { createContext } from '../lib/problems/context.mjs';
import { classifyAgentText } from '../lib/problems/classify.mjs';
import { backingCheck, isClearCheck, lastEditBefore } from '../lib/problems/backing.mjs';
import { buildCorpus } from './fixtures/replay/corpus.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const rawText = (e) => (typeof e?._raw?.text === 'string' ? e._raw.text : null);
const run = (c, id) => CHECKS.find((d) => d.id === id).run(c);

async function contexts() {
  const fx = buildCorpus();
  const corpus = await buildWorkHistory({ config: fx.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, keepRaw: true, usage: true });
  const demo = buildDemoWeek({ root: join(makeTempDir('hw-backing-'), 'week') });
  const week = await buildWorkHistory({ config: demo.config, from: demo.week.from, to: demo.week.to, timezone: demo.week.timezone, roots: demo.roots, usage: true, keepRaw: true, hiddenSessions: 'redacted' });
  return [
    ['corpus', createContext(corpus, { builtT: Date.parse('2024-07-01T00:00:00Z') })],
    ['demo week', createContext(week, { builtT: Date.parse('2025-04-01T00:00:00Z') })],
  ];
}
const all = await contexts();

test('backingCheck agrees with the done-claim check on every turn it looks at', () => {
  let looked = 0;
  let flagged = 0;
  let backed = 0;
  for (const [name, c] of all) {
    const { findings } = run(c, 'unverified-done-claim');
    const byEdit = new Map(findings.map((f) => [`${f.session}|${f.related}`, f]));
    for (const s of c.sessions) {
      for (const turn of c.turnsOf(s.key)) {
        if (!c.inWin(turn.prompt.t)) continue;
        const edits = turn.steps.filter(runnableEdit);
        if (!edits.length) continue;
        looked++;
        const last = edits.at(-1);
        assert.equal(lastEditBefore(turn.steps), last);
        const b = backingCheck(c, { steps: turn.steps, events: turn.events, session: s.key, after: last });
        const f = byEdit.get(`${s.key}|${last.ev}`);
        if (f) {
          flagged++;
          assert.equal(b.status, 'gap', `${name}: a flagged turn has a gap`);
          // The gap's wording and level are the finding's "No check after it", word for word.
          assert.equal(b.how, f.basis[1].how, `${name}: gap wording`);
          assert.equal(b.level, f.basis[1].level, `${name}: gap level`);
          continue;
        }
        if (b.status !== 'gap') {
          backed++;
          continue;
        }
        // Not flagged with a gap: nothing after the edit was a check or a sub-agent start, and the
        // turn's last message is no claim, admits no check, or isn't readable.
        const rest = turn.steps.slice(turn.steps.indexOf(last) + 1);
        assert.ok(!rest.some((x) => x.check && x.result !== 'refused') && !rest.some((x) => x.cat === 'delegate'), `${name}: a gap turn ran no check`);
        const text = rawText(c.finalMessage(turn));
        const fl = text == null ? null : classifyAgentText(text);
        assert.ok(text == null || fl.admitsNoCheck || (!fl.flat && !fl.hedged), `${name}: an unflagged gap turn made no claim`);
      }
    }
  }
  assert.ok(looked >= 20, `turns looked at: ${looked}`);
  assert.ok(flagged >= 2 && backed >= 5, `flagged ${flagged}, backed ${backed} (the test can fail both ways)`);
});

test('backingCheck agrees with the claim-against-evidence check on every turn it looks at', () => {
  let looked = 0;
  let failedTurns = 0;
  let flagged = 0;
  let withEdit = 0;
  for (const [name, c] of all) {
    const { findings } = run(c, 'claim-contradicts-evidence');
    const byCheck = new Map(findings.filter((f) => f.kind === 'claims success').map((f) => [`${f.session}|${f.related}`, f]));
    for (const s of c.sessions) {
      for (const turn of c.turnsOf(s.key)) {
        if (!c.inWin(turn.prompt.t)) continue;
        const clear = turn.steps.filter(isClearCheck);
        if (!clear.length) continue;
        looked++;
        const b = backingCheck(c, { steps: turn.steps, events: turn.events, session: s.key });
        assert.equal(b.clear, clear.at(-1), `${name}: the last clear check`);
        const failed = clear.at(-1).test ? clear.at(-1).test === 'failed' : clear.at(-1).result === 'error';
        assert.equal(b.failed, failed, `${name}: its verdict`);
        // The brief's call, from the last edit to the turn's last message, reads the same check.
        const fin = c.finalMessage(turn);
        const before = fin ? c.seqOf.get(fin.id) : null;
        const edit = lastEditBefore(turn.steps, before);
        if (edit) {
          const e = backingCheck(c, { steps: turn.steps, events: turn.events, session: s.key, after: edit, before });
          assert.equal(e.clear, clear.filter((x) => before == null || x.seq < before).at(-1) ?? null, `${name}: the last clear check, after an edit`);
          if (e.clear === b.clear) {
            withEdit++;
            assert.equal(e.failed, b.failed, `${name}: its verdict, after an edit`);
          }
        }
        if (b.failed) failedTurns++;
        const f = byCheck.get(`${s.key}|${b.clear.ev}`);
        if (f) {
          flagged++;
          assert.equal(b.failed, true, `${name}: a flagged turn's last clear check failed`);
          continue;
        }
        if (!b.failed) continue;
        const text = rawText(c.finalMessage(turn));
        const fl = text == null ? null : classifyAgentText(text);
        assert.ok(text == null || (!fl.flat && !fl.testsPass), `${name}: an unflagged failed turn claimed no success`);
      }
    }
  }
  assert.ok(looked >= 10, `turns looked at: ${looked}`);
  assert.ok(failedTurns >= 2 && flagged >= 1 && failedTurns - flagged >= 1, `failed ${failedTurns}, flagged ${flagged} (the test can fail both ways)`);
  assert.ok(withEdit >= 5, `turns read from the last edit too: ${withEdit}`);
});

// ---- the brief's own cases, on steps written by hand ------------------------------------------

const ctx = (tool = 'claude-code') => ({ sessionsByKey: new Map([['s1', { key: 's1', tool }]]) });
let seq = 0;
const step = (cat, extra = {}) => ({ ev: `s1.${++seq}.0`, seq, cat, result: 'ok', ...extra });
const edit = () => step('edit', { edit: { kind: 'code', key: 'k' } });
const testRun = (outcome) => step('shell', { check: 'test run', test: outcome, result: outcome === 'passed' ? 'ok' : 'error' });

test('a check in another folder is a named gap, never backing', () => {
  const e = edit();
  const t = testRun('passed');
  const elsewhere = new Set([t.ev]);
  const b = backingCheck(ctx(), { steps: [e, t], events: [], session: 's1', after: e, folderOk: (s) => !elsewhere.has(s.ev) });
  assert.equal(b.status, 'gap');
  assert.equal(b.gap, 'other-folder');
  assert.equal(b.check, t);
  assert.equal(b.clear, null, 'a check in another folder is never the clear check');
  // Failing-path partner: in the right folder it backs the claim.
  const ok = backingCheck(ctx(), { steps: [e, t], events: [], session: 's1', after: e, folderOk: () => true });
  assert.deepEqual([ok.status, ok.result, ok.failed], ['checked', 'passed', false]);
});

test('a check after the claim doesn\'t back it, and the latest clear check wins', () => {
  const e = edit();
  const bad = testRun('failed');
  const review = step('skill', { check: 'review skill' });
  const later = testRun('passed');
  const b = backingCheck(ctx(), { steps: [e, bad, review, later], events: [], session: 's1', after: e, before: later.seq });
  assert.equal(b.status, 'checked');
  assert.equal(b.check, review, 'the latest check before the claim');
  assert.equal(b.result, 'ok', "a review skill has its call's result, not a pass or fail");
  assert.equal(b.failed, true, 'the latest clear check before the claim failed');
  assert.equal(b.clear, bad);
  assert.equal(lastEditBefore([e, bad], e.seq), null, 'no edit before the first');
});

test('with no edit to start from, the gap still splits quiet from other steps', () => {
  const r = step('read');
  assert.equal(backingCheck(ctx(), { steps: [r], events: [{ id: r.ev, kind: 'action' }], session: 's1' }).gap, 'quiet');
  assert.equal(backingCheck(ctx(), { steps: [r], events: [{ id: r.ev, kind: 'action' }, { id: 'h', kind: 'hook' }], session: 's1' }).gap, 'other-steps');
  assert.equal(backingCheck(ctx('codex'), { steps: [r], events: [], session: 's1' }).gap, 'hooks-unlogged');
  assert.equal(backingCheck(ctx(), { steps: [step('shell')], events: [], session: 's1' }).gap, 'other-steps');
  const d = backingCheck(ctx(), { steps: [edit(), step('delegate'), testRun('passed')], events: [], session: 's1' });
  assert.equal(d.status, 'delegated');
  assert.equal(d.failed, false, 'a delegated answer still says what the last clear check did');
});

test('the gap and check wording never names an edit there wasn\'t, and a check is a rule\'s reading', () => {
  const r = step('read');
  for (const steps of [[r], [step('shell')], [testRun('passed')], [step('delegate')]]) {
    const b = backingCheck(ctx(), { steps, events: [{ id: steps[0].ev, kind: 'action' }], session: 's1' });
    assert.doesNotMatch(b.how, /edit/, b.how);
  }
  const e = edit();
  const t = testRun('passed');
  const b = backingCheck(ctx(), { steps: [e, t], events: [], session: 's1', after: e });
  assert.deepEqual([b.status, b.level], ['checked', 'inferred']);
  assert.match(b.how, /problems\.check-step/);
});

test('left without events, a gap is never worked out as quiet', () => {
  const r = step('read');
  assert.equal(backingCheck(ctx(), { steps: [r], session: 's1' }).gap, 'other-steps');
  const e = edit();
  assert.equal(backingCheck(ctx(), { steps: [e, step('read')], session: 's1', after: e }).gap, 'other-steps');
});

test('an edit that isn\'t in the steps, or comes after the claim, is refused rather than read from the start', () => {
  const t = testRun('passed');
  const r = step('read');
  assert.throws(() => backingCheck(ctx(), { steps: [t, r], events: [], session: 's1', after: edit() }), /not one of/);
  const e = edit();
  assert.throws(() => backingCheck(ctx(), { steps: [t, e], events: [], session: 's1', after: e, before: t.seq }), /after the claim/);
});
