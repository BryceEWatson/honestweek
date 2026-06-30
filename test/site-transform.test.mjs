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
import { deriveProjectStats } from '../lib/site/derive.mjs';

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

test('a consuming transform surfaces the session-aware daysActive without inventing a number (issue #43, criterion 5 adapter leg)', () => {
  // Derive projectStats the way augmentSiteModel does — deriveProjectStats WITH a sessions bundle —
  // for a display/session-only project (no commits). The engine credits its session-active days...
  const chart = { days: [{ date: '2024-06-10', byRepo: {} }, { date: '2024-06-11', byRepo: {} }] };
  const sessions = {
    total: 2,
    projectTotals: { client: 2 },
    days: [
      { date: '2024-06-10', byProject: { client: 1 } },
      { date: '2024-06-11', byProject: { client: 1 } },
    ],
  };
  const richItems = [{ project: 'client', repo: 'client', status: 'shipped', date: '2024-06-10' }];
  const projectStats = deriveProjectStats(richItems, chart, '2024-06-10', '2024-06-16', sessions);
  assert.equal(projectStats.client.daysActive, 2, 'engine derives the non-zero session-active day count');

  const b = {
    meta: { windowDays: 7, weekStart: '2024-06-10' },
    provenance: { itemsTotal: 1, commitsVerified: 0, redactions: 0 },
    chart,
    sessions,
    projectStats,
    content: { headline: 'shipped' },
  };
  // ...and a consuming adapter that reads projectStats[...].daysActive surfaces the CORRECTED value,
  // and it survives the numeric fact-fence (daysActive is a verified number under the trusted
  // projectStats root) — i.e. the adapter sees a fence-valid, session-aware count, not 0.
  const artifact = renderSiteViaTransform(
    (m) => ({
      headline: m.content.headline,
      groups: [{ name: 'client', activeDays: m.projectStats.client.daysActive, sessions: m.sessions.projectTotals.client }],
    }),
    b
  );
  assert.equal(artifact.groups[0].activeDays, 2, 'the consuming adapter surfaces the corrected daysActive');
  // No issue-#43 contradiction: sessions > 0 alongside daysActive > 0 for the active week.
  assert.ok(artifact.groups[0].sessions > 0 && artifact.groups[0].activeDays > 0);
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
