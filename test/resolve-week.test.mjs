import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveWeek, localDateInTimezone, WeekResolutionError } from '../lib/resolve-week.mjs';

const DAY_MS = 86400000;

/** Inclusive count of distinct UTC calendar dates from start..end. */
function inclusiveDayCount(start, end) {
  const s = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.round((e - s) / DAY_MS) + 1;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

test('mid-week today -> last completed Monday-Sunday window', () => {
  // 2024-06-19 is a Wednesday; current week Monday is 2024-06-17.
  const today = new Date('2024-06-19T12:00:00Z');
  const { weekStart, weekEnd } = resolveWeek({ today });
  assert.equal(ymd(weekStart), '2024-06-10');
  assert.equal(ymd(weekEnd), '2024-06-16');
  assert.equal(weekStart.getUTCDay(), 1, 'weekStart is a Monday');
  assert.equal(weekEnd.getUTCDay(), 0, 'weekEnd is a Sunday');
  assert.ok(weekStart < weekEnd);
  assert.equal(inclusiveDayCount(weekStart, weekEnd), 7, 'spans exactly 7 days');
  // strictly before the start of today's current week
  assert.ok(weekEnd.getTime() < new Date('2024-06-17T00:00:00Z').getTime());
});

test('Monday today -> still the previous completed week', () => {
  const today = new Date('2024-06-17T08:00:00Z'); // a Monday
  const { weekStart, weekEnd } = resolveWeek({ today });
  assert.equal(ymd(weekStart), '2024-06-10');
  assert.equal(ymd(weekEnd), '2024-06-16');
});

test('output shape and types are { weekStart: Date, weekEnd: Date } at documented bounds', () => {
  const { weekStart, weekEnd } = resolveWeek({ today: new Date('2024-06-19T12:00:00Z') });
  assert.ok(weekStart instanceof Date && weekEnd instanceof Date);
  assert.equal(weekStart.getUTCHours(), 0);
  assert.equal(weekStart.getUTCMinutes(), 0);
  assert.equal(weekEnd.getUTCHours(), 23);
  assert.equal(weekEnd.getUTCMinutes(), 59);
  assert.equal(weekEnd.getUTCSeconds(), 59);
  assert.equal(weekEnd.getUTCMilliseconds(), 999);
});

test('timezone-correctness: same instant near midnight yields different windows per zone', () => {
  // Monday 01:30 UTC. In Los Angeles it is still Sunday; in Tokyo it is Monday.
  const instant = new Date('2024-06-17T01:30:00Z');
  const todayLA = localDateInTimezone(instant, 'America/Los_Angeles'); // -> 2024-06-16 (Sun)
  const todayTokyo = localDateInTimezone(instant, 'Asia/Tokyo'); // -> 2024-06-17 (Mon)

  const la = resolveWeek({ today: todayLA });
  const tokyo = resolveWeek({ today: todayTokyo });

  // LA's "current week" is the week of 2024-06-10, so its last completed week is 06-03..06-09.
  assert.equal(ymd(la.weekStart), '2024-06-03');
  assert.equal(ymd(la.weekEnd), '2024-06-09');
  // Tokyo's current week is 2024-06-17, so its last completed week is 06-10..06-16.
  assert.equal(ymd(tokyo.weekStart), '2024-06-10');
  assert.equal(ymd(tokyo.weekEnd), '2024-06-16');
  assert.notEqual(ymd(la.weekStart), ymd(tokyo.weekStart));
});

test('weekArg selects a specific earlier completed week', () => {
  const today = new Date('2024-06-19T12:00:00Z');
  const { weekStart, weekEnd } = resolveWeek({ today, weekArg: '2024-W20' });
  assert.equal(ymd(weekStart), '2024-05-13');
  assert.equal(ymd(weekEnd), '2024-05-19');
});

test('weekArg naming the current in-progress week is rejected', () => {
  const today = new Date('2024-06-19T12:00:00Z'); // current ISO week is 2024-W25
  assert.throws(() => resolveWeek({ today, weekArg: '2024-W25' }), WeekResolutionError);
});

test('weekArg naming a future week is rejected', () => {
  const today = new Date('2024-06-19T12:00:00Z');
  assert.throws(() => resolveWeek({ today, weekArg: '2024-W30' }), /future|in-progress/);
});

test('malformed weekArg throws a clear error', () => {
  const today = new Date('2024-06-19T12:00:00Z');
  for (const bad of ['2024W05', 'garbage', '2024-W99', '24-W05', 5, {}]) {
    assert.throws(() => resolveWeek({ today, weekArg: bad }), WeekResolutionError, `should reject ${String(bad)}`);
  }
});

test('an invalid today throws rather than reading the clock', () => {
  assert.throws(() => resolveWeek({}), WeekResolutionError);
  assert.throws(() => resolveWeek({ today: 'nope' }), WeekResolutionError);
  assert.throws(() => resolveWeek({ today: new Date('invalid') }), WeekResolutionError);
});

test('localDateInTimezone is deterministic and returns a UTC-midnight Date', () => {
  const d = localDateInTimezone(new Date('2024-06-17T01:30:00Z'), 'Asia/Tokyo');
  assert.equal(ymd(d), '2024-06-17');
  assert.equal(d.getUTCHours(), 0);
});
