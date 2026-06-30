// The voice-fence is honestweek's opt-in AUTHORED-PROSE honesty lint: the prose
// analogue of the numeric fact-fence. These tests pin the contract from issue #44 —
// the seven real brycewatson.com phrasings fail (each named), clean prose passes, a
// paraphrase generalizes, legitimate trigger-word prose is NOT flagged, evidence
// snippets/receipts are NEVER scanned, and the allowPhrases off-ramp is surgical.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkVoice,
  collectAuthoredProse,
  DEFAULT_DENY_PHRASES,
  ITEM_PROSE_FIELDS,
  EVIDENCE_KEYS,
} from '../lib/voice-fence.mjs';

/** A fixture model carrying the SEVEN real bw failures: 3 item summaries, 1 item
 *  text, 3 project missions — each embodying a distinct seeded voice rule. */
function sevenFailingModel() {
  return {
    items: [
      { id: 's1', summary: 'Built the core; keeping the specifics sealed for now.' },
      { id: 's2', summary: 'Shipped a client tool, kept generic here.' },
      { id: 's3', summary: 'Internal work, not public-facing.' },
      { id: 's4', text: 'The details are folded away for privacy.' },
    ],
    projects: {
      alpha: { mission: 'We show the work honestly, receipts and retractions included.' },
      beta: { mission: 'This belongs in an honest log.' },
      gamma: { mission: 'Recording only the kind of work worth surfacing here.' },
    },
  };
}

/** The same seven fields, rewritten to honest non-meta prose. */
function sevenCleanModel() {
  return {
    items: [
      { id: 's1', summary: 'Built the core authentication flow.' },
      { id: 's2', summary: 'Shipped a scheduling tool for a client.' },
      { id: 's3', summary: 'Refactored the internal billing pipeline.' },
      { id: 's4', text: 'Cut the cold-start latency in half.' },
    ],
    projects: {
      alpha: { mission: 'Make verification cheap enough to run on every build.' },
      beta: { mission: 'A fast, local-first weekly report generator.' },
      gamma: { mission: 'Tooling that turns sessions into git-checked summaries.' },
    },
  };
}

test('the seven real bw phrasings each fail, named by item/path + field + rule', () => {
  const v = checkVoice(sevenFailingModel());
  // Every one of the seven authored fields is flagged at least once.
  const flagged = new Set(v.map((x) => x.path));
  for (const path of [
    's1.summary', 's2.summary', 's3.summary', 's4.text',
    'projects.alpha.mission', 'projects.beta.mission', 'projects.gamma.mission',
  ]) {
    assert.ok(flagged.has(path), `expected a voice violation at ${path}`);
  }
  // Each violation names a human-identifiable ref, a field, the matched phrase, and a rule.
  for (const x of v) {
    assert.ok(x.ref && x.field && x.phrase && x.rule, `violation is fully named: ${JSON.stringify(x)}`);
  }
  // The two rule classes both fire (withholding-narration + page-honesty meta).
  const rules = new Set(v.map((x) => x.rule));
  assert.ok([...rules].some((r) => r.startsWith('withholding:')), 'a withholding rule fired');
  assert.ok([...rules].some((r) => r.startsWith('meta:')), 'a page-honesty rule fired');
  // Spot-check that the right rule attaches to the right field.
  assert.ok(v.some((x) => x.path === 's3.summary' && x.rule === 'withholding:not-public-facing'));
  assert.ok(v.some((x) => x.path === 'projects.beta.mission' && x.rule === 'meta:honest-log'));
});

test('the rewritten clean model passes', () => {
  assert.deepEqual(checkVoice(sevenCleanModel()), []);
});

test('legitimate prose with innocuous trigger words is NOT flagged (regexes are contextual)', () => {
  const model = {
    items: [
      { id: 'n1', summary: 'We ran a sealed-bid auction integration this week.' },
      { id: 'n2', summary: 'It was an honest mistake; fixed the off-by-one.' },
      { id: 'n3', summary: 'Refactored a generic helper into a shared util.' },
      { id: 'n4', text: 'Surfaced and fixed a long-standing race condition.' },
    ],
    projects: { p: { mission: 'Keep the build honest and the feedback fast.' } },
  };
  assert.deepEqual(checkVoice(model), [], 'innocuous "sealed"/"honest"/"generic"/"surfaced" must pass');
});

test('contextual paraphrases (non-seed wording) are caught across multiple rules', () => {
  // Each uses wording absent from the 7 seed fixtures but within a regex's intent —
  // proving the contextual regexes generalize, not just match the literal seeds.
  const cases = [
    ['Design notes remain sealed until launch.', 'withholding:sealed'],   // "remain" vs the seed's "keeping"
    ['The roadmap stays under wraps.', 'withholding:under-wraps'],         // paraphrase variant
    ['Held private for the client.', 'withholding:kept-generic'],          // "held ... private" vs "kept generic"
  ];
  for (const [text, rule] of cases) {
    const v = checkVoice({ items: [{ id: 'p', summary: text }] });
    assert.ok(v.some((x) => x.rule === rule), `expected ${rule} for: ${text}`);
  }
});

test('item evidence is never scanned — the prose-field ALLOWLIST, independent of EVIDENCE_KEYS', () => {
  // A denylisted phrase in NON-allowed item fields (note + real evidence shapes)
  // passes because only title/summary/text are read. (Mutation: removing the
  // allowlist and walking all item fields would flip this to several violations.)
  const m = {
    items: [{
      id: 'e1',
      summary: 'Shipped the verifier.',
      note: 'keeping the specifics sealed',
      receipt: { ref: 'kept the specifics sealed in the vault' },
      commits: ['keeping the specifics sealed'],
      candidateCommits: [{ sha: 'a1b2c3d', note: 'kept generic here' }],
    }],
  };
  assert.deepEqual(checkVoice(m), [], 'phrases outside title/summary/text are never read');
  // The SAME phrase in an item summary DOES fail.
  assert.ok(checkVoice({ items: [{ id: 'e2', summary: 'we kept the specifics sealed' }] })
    .some((x) => x.path === 'e2.summary' && x.rule === 'withholding:sealed'));
});

test('content/projects EVIDENCE_KEYS subtrees are skipped, while mission prose IS scanned', () => {
  // Mutation-distinguishing: removing the EVIDENCE_KEYS skip makes the snippet +
  // commits scan, so this asserts the skip itself (not the allowlist).
  const m = {
    projects: {
      alpha: {
        mission: 'Build verified tooling.',
        receipt: { snippet: 'this belongs in an honest log' },
        commits: ['not public-facing'],
      },
    },
  };
  assert.deepEqual(checkVoice(m), [], 'a banned word inside an evidence subtree is not scanned');
  assert.ok(checkVoice({ projects: { alpha: { mission: 'belongs in an honest log' } } })
    .some((x) => x.rule === 'meta:honest-log'), 'mission prose itself IS scanned');
});

test('a prose field is scanned AS IT RENDERS: array-valued is linted, object-valued is not', () => {
  // Regression for the array bypass: page.mjs renders esc(String(value)); an
  // array renders comma-joined, so a phrase inside it — or split across its
  // elements — is caught (per-element recursion would miss the split case).
  assert.ok(checkVoice({ items: [{ id: 'a1', summary: ['keeping the specifics sealed'] }] })
    .some((x) => x.rule === 'withholding:sealed'), 'array-valued summary is caught');
  assert.ok(checkVoice({ items: [{ id: 'a2', text: ['kept the', 'specifics sealed'] }] })
    .some((x) => x.rule === 'withholding:sealed'), 'a phrase split across array elements (renders "kept the,specifics sealed") is caught');
  // An object renders as "[object Object]" — its nested text never appears, so
  // scanning its internals would false-abort over prose that is never emitted.
  assert.deepEqual(checkVoice({ items: [{ id: 'a3', summary: { lead: 'belongs in an honest log' } }] }), [],
    'object-valued prose field renders "[object Object]" and is not spuriously scanned');
});

test('allowPhrases is a surgical off-ramp — it suppresses only the covered match', () => {
  const model = {
    items: [
      { id: 'a1', summary: 'keeping the specifics sealed' },
      { id: 'a2', summary: 'keeping the details sealed' },
    ],
  };
  // Without an allowance, both fail.
  assert.ok(checkVoice(model).some((x) => x.ref === 'a1'));
  assert.ok(checkVoice(model).some((x) => x.ref === 'a2'));
  // An allowance covering a1's exact phrase suppresses a1 but not a2.
  const v = checkVoice(model, { allowPhrases: ['keeping the specifics sealed'] });
  assert.equal(v.some((x) => x.ref === 'a1'), false, 'a1 carved out');
  assert.equal(v.some((x) => x.ref === 'a2'), true, 'a2 still flagged');
});

test('consumer denyPhrases merge with the built-in list (literal, case-insensitive)', () => {
  const model = { items: [{ id: 'd1', summary: 'This is our SECRET sauce, internally.' }] };
  assert.deepEqual(checkVoice(model), [], 'not in the default denylist');
  const v = checkVoice(model, { denyPhrases: ['secret sauce'] });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'custom');
  assert.equal(v[0].path, 'd1.summary');
});

test('collectAuthoredProse: item fields are an allowlist; content/projects prose is walked, evidence skipped', () => {
  const leaves = collectAuthoredProse({
    items: [{ id: 'x', title: 'T', summary: 'S', text: 'X', repo: 'r', status: 'shipped', receipt: { snippet: 'EV' } }],
    content: { headline: 'H', intro: { note: 'N' } },
    projects: { p: { mission: 'M', frontier: 'F', commits: ['EV2'], receipt: { snippet: 'EV3' } } },
  });
  const got = new Map(leaves.map((l) => [l.path, l.value]));
  // Item: only the three authored prose fields — never repo/status/receipt.
  assert.equal(got.get('x.title'), 'T');
  assert.equal(got.get('x.summary'), 'S');
  assert.equal(got.get('x.text'), 'X');
  assert.equal([...got.keys()].some((k) => k.startsWith('x.') && !['x.title', 'x.summary', 'x.text'].includes(k)), false);
  // Content: all prose leaves walked.
  assert.equal(got.get('content.headline'), 'H');
  assert.equal(got.get('content.intro.note'), 'N');
  // Projects: prose walked; evidence (commits, receipt) skipped entirely.
  assert.equal(got.get('projects.p.mission'), 'M');
  assert.equal(got.get('projects.p.frontier'), 'F');
  assert.equal([...got.values()].includes('EV'), false);
  assert.equal([...got.values()].includes('EV2'), false);
  assert.equal([...got.values()].includes('EV3'), false);
});

test('exported constants document the contract', () => {
  assert.deepEqual(ITEM_PROSE_FIELDS, ['title', 'summary', 'text']);
  assert.ok(EVIDENCE_KEYS.includes('snippet') && EVIDENCE_KEYS.includes('receipt') && EVIDENCE_KEYS.includes('candidateCommits'));
  // The default denylist is a maintainable regex list with rule labels (not bare strings).
  assert.ok(DEFAULT_DENY_PHRASES.length >= 10);
  for (const e of DEFAULT_DENY_PHRASES) {
    assert.ok(e.re instanceof RegExp && typeof e.rule === 'string' && e.rule.length > 0);
  }
});

test('absent/empty sources are inert (never throws)', () => {
  assert.deepEqual(checkVoice({}), []);
  assert.deepEqual(checkVoice({ items: [], content: null, projects: null }), []);
  assert.deepEqual(checkVoice({ items: [null, 'nope', 42] }), []);
});
