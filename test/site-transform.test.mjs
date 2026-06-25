// The TRANSFORM adapter style: a committed transform(model, ctx) shapes honestweek's
// verified bundle into the site artifact, and honestweek re-walks every NUMBER of
// the output against the verified set. A transform may shape freely and place
// human-curated STRINGS (even with numbers in them — trusted, redacted passthrough),
// but it cannot put an UNVERIFIED NUMBER on the page. Synthetic bundle only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { factFenceNumbers, renderSiteViaTransform } from '../lib/site/transform.mjs';
import { FactFenceError } from '../lib/site/fact-fence.mjs';
import { seedVerifiedNumbers } from '../lib/site/values.mjs';

/** A toy verified bundle: chart/sessions/provenance/projectStats/meta + curated content. */
function bundle() {
  return {
    meta: { windowDays: 7, weekStart: '2024-06-10' },
    provenance: { itemsTotal: 2, commitsVerified: 3, redactions: 0 },
    chart: { max: 4, repoTotals: { a: 4 }, days: [{ date: '2024-06-10', total: 4, byRepo: { a: 4 } }] },
    sessions: { total: 5, projectTotals: { a: 5 } },
    projectStats: { a: { entries: 2, statusCounts: { shipped: 2 }, daysActive: 1 } },
    content: { headline: 'We shipped 2 things and verified 3 commits' }, // curated prose w/ numbers
  };
}

test('seedVerifiedNumbers gathers the bundle’s derived numbers', () => {
  const v = seedVerifiedNumbers(bundle());
  for (const n of [7, 2, 3, 0, 4, 5, 1]) assert.ok(v.has(n), `expected ${n} verified`);
});

test('a faithful transform passes the numeric fence', () => {
  const artifact = renderSiteViaTransform(
    (m) => ({
      headline: m.content.headline, // curated string, passes through
      weekCommits: m.chart.repoTotals.a, // 4 — verified
      sessions: m.sessions.total, // 5 — verified
      groups: [{ name: 'A', entries: m.projectStats.a.entries, statusCounts: m.projectStats.a.statusCounts }],
    }),
    bundle()
  );
  assert.equal(artifact.weekCommits, 4);
  assert.equal(artifact.groups[0].entries, 2);
  assert.equal(artifact.headline, 'We shipped 2 things and verified 3 commits');
});

test('a transform that INVENTS a number is aborted by the fence', () => {
  assert.throws(
    () => renderSiteViaTransform((m) => ({ headline: m.content.headline, fake: 999 }), bundle()),
    FactFenceError
  );
});

test('curated STRINGS with numbers pass (trusted human content, not honestweek’s to verify)', () => {
  // 2 and 3 here are inside an authored string, not numeric leaves -> not fenced.
  assert.doesNotThrow(() =>
    renderSiteViaTransform((m) => ({ blurb: 'shipped 2 of 3 — and 8 of 13 claims drifted' }), bundle())
  );
});

test('factFenceNumbers rejects a non-finite leaf', () => {
  assert.throws(() => factFenceNumbers({ x: Infinity }, new Set([1])), FactFenceError);
});

test('factFenceNumbers FAILS CLOSED on a Date/BigInt/boxed leaf (would dodge walkNumbers)', () => {
  assert.throws(() => factFenceNumbers({ when: new Date('2024-06-10T00:00:00Z') }, new Set([1])), FactFenceError);
  assert.throws(() => factFenceNumbers({ big: 9007199254740993n }, new Set([1])), FactFenceError);
  assert.throws(() => factFenceNumbers({ boxed: new Number(777) }, new Set([1])), FactFenceError);
  // undefined is fine — JSON.stringify omits it.
  assert.doesNotThrow(() => factFenceNumbers({ a: undefined, b: 'ok', c: null }, new Set([1])));
});

test('a transform aborts if it INVENTS a number as a string is NOT scanned (curated trust), but a real numeric leaf is', () => {
  // strings (curated) pass even with numerals; a numeric leaf must be verified.
  assert.doesNotThrow(() => renderSiteViaTransform((m) => ({ blurb: 'shipped 9999 things' }), bundle()));
  assert.throws(() => renderSiteViaTransform((m) => ({ n: 9999 }), bundle()), FactFenceError);
});

test('a transform may declare a derived number via { artifact, verifiedExtra }', () => {
  // 4242 is not in the bundle; declaring it lets the fence trace it (a committed
  // transform vouching for a count it computed, e.g. its own redaction count).
  const artifact = renderSiteViaTransform(
    (m) => ({ artifact: { redactions: 4242 }, verifiedExtra: [4242] }),
    bundle()
  );
  assert.equal(artifact.redactions, 4242);
  // ...but an UNDECLARED out-of-bundle number still aborts.
  assert.throws(() => renderSiteViaTransform((m) => ({ artifact: { x: 4242 }, verifiedExtra: [] }), bundle()), FactFenceError);
});
