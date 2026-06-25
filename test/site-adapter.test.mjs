// The site-integration adapter GRAMMAR validator: it accepts a well-formed spec
// and rejects every way the model could try to smuggle a fact onto the value path
// (a literal number, a literal in a derived slot, an unknown source kind). Uses a
// SYNTHETIC toy schema only — no target-site field names (clean-room).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAdapter, isDirective, SOURCE_KINDS } from '../lib/site/adapter.mjs';

/** A valid, representative adapter over a synthetic toy artifact. */
function validSpec() {
  return {
    artifact: 'data/toy.json',
    clockFields: ['meta.generatedAt'],
    volatileFields: ['rows[].isToday'],
    tree: {
      type: 'object',
      props: {
        title: { source: 'const', value: 'Toy report' },
        active: { source: 'const', value: true },
        note: { source: 'const', value: null },
        total: { source: 'derived', key: 'provenance.itemsTotal' },
        headline: { source: 'freetext', value: 'a quiet week' },
        skip: { source: 'omit' },
        rows: {
          type: 'array',
          over: 'chart.days',
          item: {
            type: 'object',
            props: {
              count: { source: 'derived', key: 'total' },
              label: { source: 'model', key: 'text' },
            },
          },
        },
      },
    },
  };
}

test('a well-formed adapter passes with no problems', () => {
  const { ok, problems } = validateAdapter(validSpec());
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(problems.length, 0);
});

test('isDirective distinguishes leaves from containers', () => {
  assert.equal(isDirective({ source: 'omit' }), true);
  assert.equal(isDirective({ type: 'object', props: {} }), false);
  assert.equal(isDirective(null), false);
});

test('a numeric const is rejected (a number is a claim, never a literal)', () => {
  const spec = validSpec();
  spec.tree.props.total = { source: 'const', value: 42 };
  const { ok, problems } = validateAdapter(spec);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.path === 'tree.total' && /must not be numeric/.test(p.reason)));
});

test('a literal value in a derived slot is rejected', () => {
  const spec = validSpec();
  spec.tree.props.total = { source: 'derived', key: 'provenance.itemsTotal', value: 7 };
  const { ok, problems } = validateAdapter(spec);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.path === 'tree.total' && /must NOT carry a literal/.test(p.reason)));
});

test('an unknown source kind is rejected', () => {
  const spec = validSpec();
  spec.tree.props.total = { source: 'compute' };
  const { ok, problems } = validateAdapter(spec);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /unknown source kind/.test(p.reason)));
});

test('derived/model require a non-empty key', () => {
  const spec = validSpec();
  spec.tree.props.total = { source: 'derived', key: '' };
  const { ok, problems } = validateAdapter(spec);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /must carry a non-empty "key"/.test(p.reason)));
});

test('freetext requires a string value', () => {
  const spec = validSpec();
  spec.tree.props.headline = { source: 'freetext', value: 3 };
  const { ok, problems } = validateAdapter(spec);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /freetext directive must carry a string/.test(p.reason)));
});

test('an array node missing over/item is rejected', () => {
  const spec = validSpec();
  spec.tree.props.rows = { type: 'array' };
  const { ok, problems } = validateAdapter(spec);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /non-empty "over"/.test(p.reason)));
  assert.ok(problems.some((p) => /must carry an "item"/.test(p.reason)));
});

test('a container with an unknown type is rejected', () => {
  const spec = validSpec();
  spec.tree.props.rows = { type: 'list', over: 'x', item: { source: 'omit' } };
  const { ok, problems } = validateAdapter(spec);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /container node must declare type/.test(p.reason)));
});

test('missing artifact and missing tree are reported', () => {
  const r1 = validateAdapter({ tree: { type: 'object', props: {} } });
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some((p) => p.path === 'artifact'));

  const r2 = validateAdapter({ artifact: 'x.json' });
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => p.path === 'tree'));
});

test('a non-object spec is rejected cleanly', () => {
  assert.equal(validateAdapter(null).ok, false);
  assert.equal(validateAdapter('nope').ok, false);
});

test('SOURCE_KINDS is the closed set', () => {
  assert.deepEqual(SOURCE_KINDS, ['const', 'derived', 'derivedTree', 'model', 'freetext', 'omit']);
});

test('derivedTree requires a non-empty key and forbids a literal value', () => {
  const spec = validSpec();
  spec.tree.props.byRepo = { source: 'derivedTree', key: 'chart.days' };
  assert.equal(validateAdapter(spec).ok, true, 'a well-formed derivedTree leaf is accepted');

  const noKey = validSpec();
  noKey.tree.props.byRepo = { source: 'derivedTree', key: '' };
  assert.ok(validateAdapter(noKey).problems.some((p) => /must carry a non-empty "key"/.test(p.reason)));

  const literal = validSpec();
  literal.tree.props.byRepo = { source: 'derivedTree', key: 'chart.days', value: { x: 1 } };
  assert.ok(validateAdapter(literal).problems.some((p) => /must NOT carry a literal/.test(p.reason)));
});
