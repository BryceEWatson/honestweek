// test/helpers/grows-in-step.mjs, the redactor tests' speed check: it must pass time that grows
// in step with the input and fail time that grows with its square, or the speed tests prove nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertGrowsInStep } from './helpers/grows-in-step.mjs';

/** Busy work in proportion to `steps`, which the engine can't skip. */
function spin(steps) {
  let x = 0;
  for (let i = 0; i < steps; i += 1) x = (x * 31 + i) % 1000003;
  return x;
}

test('time in step with the input passes', () => {
  assertGrowsInStep('linear', (scale) => Math.round(8e7 * scale), (n) => spin(n), { ceilingMs: 60_000 });
});

test('time that grows with the square of the input fails, however the rounds fall', () => {
  // At full length 14,000 squared is about 2e8 steps, well past the 50 ms floor; a quarter is 1/16 of that.
  assert.throws(() => assertGrowsInStep('square', (scale) => Math.round(14_000 * scale), (n) => spin(n * n), { ceilingMs: 60_000 }), /times as long/);
});

test('a full run over the ceiling fails even when it grows in step', () => {
  assert.throws(() => assertGrowsInStep('slow', (scale) => Math.round(4e7 * scale), (n) => spin(n), { ceilingMs: 1 }), /over the 1 ms limit/);
});
