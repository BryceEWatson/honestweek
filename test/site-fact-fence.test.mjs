// The fact-fence is honestweek's deterministic backstop: no number reaches the
// artifact unless it is traceable to a verified value. These tests pin the
// hardenings the review-loop surfaced — comma-grouped and spelled-out compound
// numerals, and non-finite leaves — each of which would slip the pre-fix code.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { factFence, FactFenceError, numbersInProse } from '../lib/site/fact-fence.mjs';

test('a numeric leaf must be a verified value', () => {
  assert.doesNotThrow(() => factFence({ count: 4 }, new Set([4, 1])));
  assert.throws(() => factFence({ count: 999 }, new Set([4, 1])), FactFenceError);
});

test('a non-finite numeric leaf is always rejected (never serialized to null silently)', () => {
  // Assert the DISTINGUISHING message so the Number.isFinite guard is actually
  // pinned — without it the non-finite value would still throw via the "not
  // traceable" branch, leaving the guard untested (a green-over-deleted-logic test).
  assert.throws(() => factFence({ x: Infinity }, new Set([1])), /non-finite/);
  assert.throws(() => factFence({ x: NaN }, new Set([1])), /non-finite/);
  assert.throws(() => factFence({ x: -Infinity }, new Set([1])), /non-finite/);
});

test('comma-grouped numerals are checked as ONE quantity, not split', () => {
  // 1 and 200 verified, but the stated quantity 1200 is NOT -> must abort.
  assert.throws(
    () => factFence({}, new Set([1, 200]), [{ path: 'h', value: 'shipped 1,200 commits' }]),
    FactFenceError
  );
  // The composite IS verified -> passes (and does not falsely abort on "1").
  assert.doesNotThrow(() => factFence({}, new Set([1200]), [{ path: 'h', value: 'shipped 1,200 commits' }]));
});

test('spelled-out compounds are composed, not checked token-by-token', () => {
  // "two hundred" is 200, not {2,100}.
  assert.throws(() => factFence({}, new Set([2, 100]), [{ path: 'h', value: 'two hundred commits' }]), FactFenceError);
  assert.doesNotThrow(() => factFence({}, new Set([200]), [{ path: 'h', value: 'two hundred commits' }]));
  // "twenty three" is 23, not {20,3}.
  assert.throws(() => factFence({}, new Set([20, 3]), [{ path: 'h', value: 'twenty three projects' }]), FactFenceError);
  assert.doesNotThrow(() => factFence({}, new Set([23]), [{ path: 'h', value: 'twenty three projects' }]));
});

test('numbersInProse composes representative quantities', () => {
  assert.deepEqual([...numbersInProse('1,200')], [1200]);
  assert.deepEqual([...numbersInProse('two hundred')], [200]);
  assert.deepEqual([...numbersInProse('twenty three')], [23]);
  assert.deepEqual([...numbersInProse('one thousand two hundred')], [1200]);
  assert.deepEqual([...numbersInProse('a quiet week')], []);
});

test('numbersInProse exempts ISO date/datetime and hex-sha tokens (not work-claims)', () => {
  assert.deepEqual([...numbersInProse('2024-06-10')], [], 'an ISO date is not a stated quantity');
  assert.deepEqual([...numbersInProse('2024-06-10T13:45:00Z')], [], 'an ISO datetime is not a quantity');
  assert.deepEqual([...numbersInProse('see a1b2c3d4e5')], [], 'a hex sha is not a quantity');
  // A real quantity beside an exempt token is still caught.
  assert.deepEqual([...numbersInProse('on 2024-06-10 shipped 50 commits')], [50]);
  // A bare year is NOT a date token and remains checked (deliberately strict).
  assert.deepEqual([...numbersInProse('over 2024 commits')], [2024]);
});

test('plain verified counts and prose without quantities pass', () => {
  assert.doesNotThrow(() => factFence({ n: 3 }, new Set([3]), [{ path: 'h', value: 'a calm week' }]));
});
