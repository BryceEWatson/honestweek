// The long-input speed check two redactor test files share: does the time a function takes grow
// in step with its input's length, rather than with the square of it?
//
// An input is built at a quarter of its length and at full length. Time in step with length makes
// the full run about 4 times the quarter one; time that grows with the square of the length, as
// in the slowdowns fixed before (`x='a='x='a='…`), makes it about 16 times.
//
// GitHub's runners are shared and have two cores, and `node --test` runs test files side by side,
// so a run can be slowed by whatever else is running at that moment. So each full run is timed
// between two quarter runs and compared with the faster of them, and the check uses the round
// with the lowest ratio. A busy stretch that slows a full run slows the quarter runs on either
// side of it too, so it shouldn't make the ratio look like a slowdown (it can, if the load slows
// long inputs more than short ones; three CI runs in a row passed on 6 October); and one slow quarter run
// can't hide a real slowdown, because the faster neighbour is the one compared. It stops as soon
// as the check passes, after at most ROUNDS rounds.
//
// - MAX_GROWTH: 12 sits between 4 and 16. On 6 October 2026 eight CI runs on GitHub's Linux
//   runners (Node 18 and 20) failed the old limit of 10, measuring 10.0 to 12.2, when every
//   quarter run was timed before any full run. The same cases measure 4.4 to 7.6 on a developer
//   machine, on Node 18 and 22 alike. In the 12.2 run the full runs took about four times as
//   long as there and the quarter runs about one and a half times: the runner was busy, not the
//   redactor slower. 12 adds room on top, while time that grows with the square still fails.
// - FLOOR_MS: under 50 ms the ratio is mostly noise, and nothing that fast is a real slowdown.
// - The ceiling (each caller's own): the growth check can't see a change that stays linear but
//   costs more per character, so the fastest full run must also finish within it.
import assert from 'node:assert/strict';

export const MAX_GROWTH = 12;
export const FLOOR_MS = 50;
export const ROUNDS = 5;

/**
 * Asserts that `run` on `build(1)` takes time in step with its length, against `build(0.25)`
 * timed on either side of it, and that its fastest full run finishes within `ceilingMs`. Returns
 * what the last full run returned.
 */
export function assertGrowsInStep(label, build, run, { ceilingMs }) {
  const timed = (input) => {
    const started = performance.now();
    const out = run(input);
    return [performance.now() - started, out];
  };
  const quarter = build(0.25);
  const full = build(1);
  // Two quarter runs first warm the code up, so the first round doesn't time compilation.
  for (let i = 0; i < 2; i += 1) timed(quarter);
  let [before] = timed(quarter);
  let fullMs = Infinity;
  let best = { ratio: Infinity, quarterMs: Infinity, fullMs: Infinity };
  let out;
  const passes = () => fullMs < ceilingMs && (best.fullMs < FLOOR_MS || best.ratio < MAX_GROWTH);
  for (let round = 0; round < ROUNDS; round += 1) {
    const [ms, result] = timed(full);
    const [after] = timed(quarter);
    const quarterMs = Math.min(before, after);
    before = after;
    out = result;
    fullMs = Math.min(fullMs, ms);
    if (ms / quarterMs < best.ratio) best = { ratio: ms / quarterMs, quarterMs, fullMs: ms };
    if (passes()) break;
  }
  const said = `${label}: ${best.fullMs.toFixed(1)} ms at full length against ${best.quarterMs.toFixed(1)} ms at a quarter in its best round, fastest full run ${fullMs.toFixed(1)} ms`;
  assert.ok(fullMs < ceilingMs, `${said}, over the ${ceilingMs} ms limit`);
  assert.ok(best.fullMs < FLOOR_MS || best.ratio < MAX_GROWTH, `${said}, ${best.ratio.toFixed(1)} times as long`);
  return out;
}
