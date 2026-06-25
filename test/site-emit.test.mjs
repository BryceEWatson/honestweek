// emit-site resolves a target adapter against a verified model, and the fact-fence
// refuses any number not traceable to a verified value (numeric leaf OR a numeral
// inside authored prose). Synthetic toy model/adapter only — no target field names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSite, FactFenceError } from '../lib/site/emit-site.mjs';
import { factFence } from '../lib/site/fact-fence.mjs';
import { buildValueContext } from '../lib/site/values.mjs';

/** A toy verified, derived-augmented model. Its numbers: 2,2,3,0,4,1. */
function toyModel() {
  return {
    week: { start: '2024-06-10', end: '2024-06-16' },
    provenance: { itemsTotal: 2, itemsVerified: 2, commitsVerified: 3, redactions: 0 },
    chart: {
      max: 4,
      days: [
        { date: '2024-06-10', total: 4, label: 'big day' },
        { date: '2024-06-11', total: 1, label: 'quiet' },
      ],
    },
  };
}

function toyAdapter() {
  return {
    artifact: 'data/toy.json',
    tree: {
      type: 'object',
      props: {
        title: { source: 'const', value: 'Toy' },
        total: { source: 'derived', key: 'provenance.itemsTotal' },
        commits: { source: 'derived', key: 'provenance.commitsVerified' },
        headline: { source: 'freetext', value: 'a quiet week' },
        skip: { source: 'omit' },
        days: {
          type: 'array',
          over: 'chart.days',
          item: {
            type: 'object',
            props: {
              n: { source: 'derived', key: 'total' },
              note: { source: 'model', key: 'label' },
            },
          },
        },
      },
    },
  };
}

test('renderSite resolves every source kind into the expected artifact', () => {
  const artifact = renderSite(toyModel(), toyAdapter());
  assert.deepEqual(artifact, {
    title: 'Toy',
    total: 2,
    commits: 3,
    headline: 'a quiet week',
    // skip is omitted
    days: [
      { n: 4, note: 'big day' },
      { n: 1, note: 'quiet' },
    ],
  });
});

test('renderSite aborts when authored prose states an unverified number', () => {
  const adapter = toyAdapter();
  adapter.tree.props.headline = { source: 'freetext', value: 'we shipped 99 things' };
  assert.throws(() => renderSite(toyModel(), adapter), FactFenceError);
});

test('renderSite allows a prose number that IS verified', () => {
  const adapter = toyAdapter();
  // 3 is verified (provenance.commitsVerified)
  adapter.tree.props.headline = { source: 'freetext', value: 'shipped across 3 projects' };
  assert.doesNotThrow(() => renderSite(toyModel(), adapter));
});

test('renderSite throws on an unresolvable derived key (resolve-or-throw)', () => {
  const adapter = toyAdapter();
  adapter.tree.props.total = { source: 'derived', key: 'provenance.doesNotExist' };
  assert.throws(() => renderSite(toyModel(), adapter), /did not resolve/);
});

test('renderSite throws when a model key does not resolve to a string', () => {
  const adapter = toyAdapter();
  // provenance.itemsTotal is a number, not a model-distilled string.
  adapter.tree.props.headline = { source: 'model', key: 'provenance.itemsTotal' };
  assert.throws(() => renderSite(toyModel(), adapter), /did not resolve to a string/);
});

test('factFence rejects an unverified numeric leaf', () => {
  const { verifiedNumbers } = buildValueContext(toyModel());
  assert.throws(() => factFence({ count: 999 }, verifiedNumbers), FactFenceError);
  assert.doesNotThrow(() => factFence({ count: 4 }, verifiedNumbers));
});

test('factFence scans spelled-out quantities in prose', () => {
  const verified = new Set([3]);
  assert.throws(() => factFence({}, verified, [{ path: 'h', value: 'forty commits' }]), FactFenceError);
  assert.doesNotThrow(() => factFence({}, verified, [{ path: 'h', value: 'three commits' }]));
});

test('factFence ignores numerals in non-prose (derived) strings', () => {
  // A date string is a derived leaf, never passed as a prose leaf, so its digits
  // (2024, 06, 10) are not required to be verified numbers.
  const verified = new Set([2, 3]);
  assert.doesNotThrow(() => factFence({ start: '2024-06-10' }, verified, []));
});

// --- derivedTree: a trusted derived sub-structure embedded wholesale ---------

/** A toy model whose chart days carry a dynamic-keyed numeric map (byRepo). */
function toyTreeModel() {
  return {
    provenance: { itemsTotal: 2, commitsVerified: 3 },
    chart: {
      max: 4,
      days: [
        { date: '2024-06-10', total: 4, byRepo: { a: 3, b: 1 } },
        { date: '2024-06-11', total: 1, byRepo: { a: 1 } },
      ],
    },
  };
}

test('derivedTree embeds a derived map; the fact-fence still checks its numbers', () => {
  const adapter = {
    artifact: 'x.json',
    tree: {
      type: 'object',
      props: {
        peak: { source: 'derived', key: 'chart.max' },
        days: {
          type: 'array',
          over: 'chart.days',
          item: {
            type: 'object',
            props: {
              n: { source: 'derived', key: 'total' },
              repos: { source: 'derivedTree', key: 'byRepo' },
            },
          },
        },
      },
    },
  };
  const artifact = renderSite(toyTreeModel(), adapter);
  assert.deepEqual(artifact, {
    peak: 4,
    days: [
      { n: 4, repos: { a: 3, b: 1 } },
      { n: 1, repos: { a: 1 } },
    ],
  });
});

test('derivedTree cannot launder an UNTRUSTED number (outside the trusted roots)', () => {
  const model = { ...toyTreeModel(), extra: { sneaky: 777 } }; // `extra` is not a trusted root
  const adapter = {
    artifact: 'x.json',
    tree: { type: 'object', props: { x: { source: 'derivedTree', key: 'extra' } } },
  };
  // 777 is reachable via derivedTree but is NOT a verified number -> fence aborts.
  assert.throws(() => renderSite(model, adapter), FactFenceError);
});

test('derivedTree with a STRING leaf is rejected (prose must not bypass the fence)', () => {
  // A map carrying a model-prose string would dodge the numbers-in-prose check.
  const model = { ...toyTreeModel(), labels: { a: 'shipped twenty things', b: 'ok' } };
  const adapter = {
    artifact: 'x.json',
    tree: { type: 'object', props: { x: { source: 'derivedTree', key: 'labels' } } },
  };
  assert.throws(() => renderSite(model, adapter), /string leaf|numeric\/flag maps only/);
});

test('derivedTree on a scalar key throws (use derived for a single value)', () => {
  const adapter = {
    artifact: 'x.json',
    tree: { type: 'object', props: { x: { source: 'derivedTree', key: 'chart.max' } } },
  };
  assert.throws(() => renderSite(toyTreeModel(), adapter), /resolved to a scalar/);
});

// --- the fence covers EVERY source kind that can emit a string (no bypass) ----

test('derived resolving to MODEL prose is fact-fenced (no bypass via derived)', () => {
  // item.text is model-distilled prose, addressable by a key path. Routing it
  // through `derived` must NOT dodge the prose-number scan.
  const model = { ...toyTreeModel(), groups: [{ items: [{ text: 'Refactored the planner; shipped 4242 commits' }] }] };
  const adapter = {
    artifact: 'x.json',
    tree: { type: 'object', props: { lead: { source: 'derived', key: 'groups.0.items.0.text' } } },
  };
  assert.throws(() => renderSite(model, adapter), FactFenceError); // 4242 not verified
});

test('const string with an embedded quantity is fact-fenced (symmetric with freetext)', () => {
  const adapter = {
    artifact: 'x.json',
    tree: { type: 'object', props: { headline: { source: 'const', value: 'We shipped 1200 commits and 42 PRs' } } },
  };
  assert.throws(() => renderSite(toyTreeModel(), adapter), FactFenceError); // 1200/42 not verified
});

test('a derived DATE string passes (its digits are not a stated quantity)', () => {
  const model = { ...toyTreeModel(), week: { start: '2024-06-10' } };
  const adapter = {
    artifact: 'x.json',
    tree: { type: 'object', props: { when: { source: 'derived', key: 'week.start' } } },
  };
  assert.doesNotThrow(() => renderSite(model, adapter));
});

test('a const non-numeric label passes; a const number is rejected at validation', () => {
  const ok = { artifact: 'x.json', tree: { type: 'object', props: { t: { source: 'const', value: 'Weekly Report' } } } };
  assert.doesNotThrow(() => renderSite(toyTreeModel(), ok));
});

test('derivedTree fails closed on a Date/exotic leaf (not just strings)', () => {
  const model = { ...toyTreeModel(), weird: { when: new Date('2024-06-10T00:00:00Z') } };
  const adapter = { artifact: 'x.json', tree: { type: 'object', props: { x: { source: 'derivedTree', key: 'weird' } } } };
  assert.throws(() => renderSite(model, adapter), /cannot inspect|numeric\/flag maps only/);
});

test('verifiedNumbers is seeded ONLY from trusted derived roots (provenance discipline)', () => {
  const model = {
    provenance: { commitsVerified: 5 }, // trusted
    chart: { max: 9, days: [] }, // trusted
    groups: [{ label: 'g', metrics: { commits: 6 }, items: [{ text: 'x', n: 777 }] }],
  };
  const { verifiedNumbers } = buildValueContext(model);
  assert.ok(verifiedNumbers.has(5) && verifiedNumbers.has(9), 'trusted provenance/chart numbers are verified');
  assert.ok(verifiedNumbers.has(6), 'a git-derived group metric is verified');
  assert.ok(!verifiedNumbers.has(777), 'a stray number on a model item is NOT verified');
});
