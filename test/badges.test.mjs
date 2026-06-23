import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STATUSES, statusForTag } from '../lib/badges.mjs';

test('STATUSES is exactly the three badges in canonical order', () => {
  assert.deepEqual(STATUSES, ['shipped', 'in progress', 'designed, not proven']);
});

test('verified and measured map to shipped', () => {
  assert.equal(statusForTag('verified'), 'shipped');
  assert.equal(statusForTag('measured'), 'shipped');
});

test('assumed / unverified / handoff-claimed map to "designed, not proven"', () => {
  assert.equal(statusForTag('assumed'), 'designed, not proven');
  assert.equal(statusForTag('unverified'), 'designed, not proven');
  assert.equal(statusForTag('handoff-claimed'), 'designed, not proven');
});

test('in-progress markers map to "in progress"', () => {
  assert.equal(statusForTag('in-progress'), 'in progress');
  assert.equal(statusForTag('in progress'), 'in progress');
  assert.equal(statusForTag('wip'), 'in progress');
});

test('every result is a member of STATUSES', () => {
  for (const tag of ['verified', 'measured', 'assumed', 'unverified', 'wip', 'in-progress', 'whatever', '', null, undefined]) {
    assert.ok(STATUSES.includes(statusForTag(tag)), `statusForTag(${String(tag)}) not in STATUSES`);
  }
});

test('unknown / empty / undefined tags fall back to "designed, not proven", never "shipped"', () => {
  for (const tag of ['xyz', '', '   ', null, undefined, 42, {}]) {
    const s = statusForTag(tag);
    assert.equal(s, 'designed, not proven', `unknown tag ${String(tag)} should under-claim`);
    assert.notEqual(s, 'shipped');
  }
});

test('tag matching is case- and whitespace-insensitive', () => {
  assert.equal(statusForTag('  VERIFIED '), 'shipped');
  assert.equal(statusForTag('WiP'), 'in progress');
});
