// The long-input speed check two redactor test files share: does the time a function takes grow
// in step with its input's length, rather than with the square of it?
//
// An input is built at a quarter of its length and at full length. Time in step with length makes
// the full run about 4 times the quarter one; time that grows with the square of the length, as
// in the slowdowns fixed before (`x='a='x='a='…`), makes it about 16 times.
//
// GitHub's runners are shared and have two cores, and `node --test` runs test files side by side,
// so a run can be slowed by whatever else is running at that moment. The quarter and full runs
// therefore alternate, round after round, and the check compares the fastest of each: a busy
// moment that slows one full run can't make the ratio look like a slowdown, because the next
// round measures both again. It stops as soon as the check passes, after at most ROUNDS rounds.
//
// - MAX_GROWTH: 12 sits between 4 and 16. On 6 October 2026 three cases on GitHub's Linux
//   runners (Node 18 and 20) measured 10.2 to 10.7 when the full runs were tried only after the
//   quarter ones, against 4.4 to 7.6 on a developer machine; 12 keeps those passing while time
//   that grows with the square still fails.
// - FLOOR_MS: under 50 ms the ratio is mostly noise, and nothing that fast is a real slowdown.
// - The ceiling (each caller's own): the growth check can't see a change that stays linear but
//   costs more per character, so the fastest full run must also finish within it.
import assert from 'node:assert/strict';

export const MAX_GROWTH = 12;
export const FLOOR_MS = 50;
export const ROUNDS = 5;

/**
 * Asserts that `run` on `build(1)` takes time in step with its length, against `build(0.25)`,
 * and that its fastest full run finishes within `ceilingMs`. Returns what the last full run
 * returned.
 */
export function assertGrowsInStep(label, build, run, { ceilingMs }) {
  const timed = (input) => {
    const started = performance.now();
    const out = run(input);
    return [performance.now() - started, out];
  };
  const quarter = build(0.25);
  const full = build(1);
  let quarterMs = Infinity;
  let fullMs = Infinity;
  let out;
  const passes = () => fullMs < ceilingMs && (fullMs < FLOOR_MS || fullMs / quarterMs < MAX_GROWTH);
  // Two quarter runs first, then one more before each full run: the quarter time is the best of
  // three or more, so a pause in it can't hide a slowdown, and a healthy case costs one full run.
  for (let i = 0; i < 2; i += 1) quarterMs = Math.min(quarterMs, timed(quarter)[0]);
  for (let round = 0; round < ROUNDS; round += 1) {
    quarterMs = Math.min(quarterMs, timed(quarter)[0]);
    const [ms, result] = timed(full);
    fullMs = Math.min(fullMs, ms);
    out = result;
    if (passes()) break;
  }
  const said = `${label}: ${fullMs.toFixed(1)} ms at full length, ${quarterMs.toFixed(1)} ms at a quarter`;
  assert.ok(fullMs < ceilingMs, `${said}, over the ${ceilingMs} ms limit`);
  assert.ok(fullMs < FLOOR_MS || fullMs / quarterMs < MAX_GROWTH, `${said}, ${(fullMs / quarterMs).toFixed(1)} times as long`);
  return out;
}
