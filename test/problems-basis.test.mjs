// Where each number and rule behind a check comes from: honestweek's own choice, or a published
// source in the catalog. Every threshold, every number a check card states and every rule a card
// shows is marked one way or the other, so a new one can't ship unmarked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKS } from '../lib/problems/checks.mjs';
import { RULE_SOURCES, RULES } from '../lib/problems/classify.mjs';
import { NUMBERS, THRESHOLDS } from '../lib/problems/context.mjs';
import { loadCatalog } from '../lib/problems/index.mjs';
import { LOOKUP_RULES, RULE_SOURCES as ENGINE_RULE_SOURCES, RULES as ENGINE_RULES, UPDATE_RULES } from '../lib/replay/classify.mjs';
import { LAUNCH_RULE_SOURCES, LAUNCH_RULES } from '../lib/replay/launch.mjs';

const catalogUrls = new Set(loadCatalog().patterns.flatMap((p) => p.sources.map((s) => s.url)));
/** Marked: null (honestweek's own) or the address of a source the catalog holds. */
const marked = (source) => source === null || (typeof source === 'string' && catalogUrls.has(source));
const engineRuleIds = [...ENGINE_RULES.keys(), ...LOOKUP_RULES.keys(), ...UPDATE_RULES.keys()];

test('every threshold is marked, and says its own value', () => {
  assert.deepEqual(Object.keys(THRESHOLDS).filter((k) => !(k in NUMBERS)), [], 'a threshold with no NUMBERS entry');
  for (const [key, n] of Object.entries(NUMBERS)) {
    assert.equal(typeof n.says, 'string', key);
    assert.ok(n.says.length > 0 && n.says.length <= 140, `${key} says it briefly`);
    assert.ok(marked(n.source), `${key}: ${n.source}`);
  }
  // What a card says matches the number the code applies, in one of the ways the cards write it.
  for (const [key, v] of Object.entries(THRESHOLDS)) {
    const forms = [String(v), v.toLocaleString('en-US'), `${v / 1000}k`, `${v / 60e3} minutes`, `${Math.round(v * 100)}%`, ...(v === 0.5 ? ['half'] : []), ...(v === 2 ? ['twice'] : [])];
    assert.ok(forms.some((f) => new RegExp(`(^|[^\\d.,])${f.replace(/[.%]/g, '\\$&')}(?![\\d,])`).test(NUMBERS[key].says)), `${key} (${v}): "${NUMBERS[key].says}"`);
  }
});

test("every number a check's description states is one its card marks", () => {
  for (const c of CHECKS) {
    assert.ok(Array.isArray(c.numbers), `${c.id} lists its numbers`);
    for (const k of c.numbers) assert.ok(k in NUMBERS, `${c.id}: ${k}`);
    const says = c.numbers.map((k) => NUMBERS[k].says);
    // Each number in the description ("3 or more", "20k", "10 minutes", "2,000") is in what one
    // of its marked numbers says.
    for (const m of c.how.matchAll(/(?<![\w.])\d[\d,]*(k\b)?/g)) {
      const n = m[0].replace(/,$/, '');
      assert.ok(says.some((s) => new RegExp(`(^|[^\\d,])${n}(?![\\d,]|k)`).test(s)), `${c.id} states ${n} ("${c.how.slice(Math.max(0, m.index - 40), m.index + 30)}"), and no number it lists says so`);
    }
    for (const word of ['half', 'twice']) if (new RegExp(`\\b${word}\\b`).test(c.how)) assert.ok(says.some((s) => s.includes(word)), `${c.id} states "${word}"`);
  }
  // A check whose findings in a still-running session's last turn drop to notes lists that number.
  for (const c of CHECKS.filter((x) => x.liveSensitive)) assert.ok(c.numbers.includes('stillRunningMs'), c.id);
});

test('every rule is marked, the engine\'s included, and every rule a card shows', () => {
  assert.deepEqual(Object.keys(RULES).filter((id) => !Object.hasOwn(RULE_SOURCES, id)), [], 'a problems rule with no basis');
  assert.deepEqual(Object.keys(RULE_SOURCES).filter((id) => !Object.hasOwn(RULES, id)), [], 'a basis for no rule');
  for (const [id, s] of Object.entries(RULE_SOURCES)) assert.ok(marked(s), `${id}: ${s}`);
  assert.deepEqual(engineRuleIds.filter((id) => !ENGINE_RULE_SOURCES.has(id)), [], 'an engine rule with no basis');
  for (const [id, s] of ENGINE_RULE_SOURCES) assert.ok(marked(s), `${id}: ${s}`);
  assert.deepEqual([...LAUNCH_RULES.keys()].filter((id) => !LAUNCH_RULE_SOURCES.has(id)), [], 'a launch rule with no basis');
  for (const [id, s] of LAUNCH_RULE_SOURCES) assert.ok(marked(s), `${id}: ${s}`);
  // The page shows the rules a check's description names, as the cards do (problems.js, checksHtml).
  const all = [...Object.keys(RULES), ...engineRuleIds];
  for (const c of CHECKS) {
    for (const id of all.filter((r) => c.how.includes(r))) assert.ok(Object.hasOwn(RULE_SOURCES, id) || ENGINE_RULE_SOURCES.has(id), `${c.id} shows ${id}`);
  }
});

test('the numbers and rules that rest on a published source name the one they use', () => {
  const from = Object.entries(NUMBERS).filter(([, n]) => n.source).map(([k, n]) => [k, n.source]);
  assert.deepEqual(from, [['cacheLifetime', 'https://code.claude.com/docs/en/prompt-caching']]);
  assert.deepEqual(Object.entries(RULE_SOURCES).filter(([, s]) => s), [['usage.call', 'https://code.claude.com/docs/en/statusline']]);
  assert.deepEqual([...ENGINE_RULE_SOURCES].filter(([, s]) => s), [['updates.position', 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5']]);
  // The cache-miss check uses the lifetimes; the long-session limit's default isn't on any card.
  assert.ok(CHECKS.find((c) => c.id === 'cache-misses').numbers.includes('cacheLifetime'));
  assert.ok(!CHECKS.some((c) => c.numbers.includes('longCtx')));
});
