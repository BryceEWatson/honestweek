// Settings' "Suggest words from my sessions" (issue 165): name-shaped words in my own prompts and
// session titles, from the redacted build, in my configured repositories only. Every name and
// word here is made up.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { MAX_SUGGESTIONS, suggestWords } from '../lib/view/suggest-words.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { privateWordsNote } from '../lib/private-words.mjs';
import { buildViewWeek, PRIVATE_WORDS, WEEK } from './fixtures/view/week.mjs';
import { makeTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const prompt = (session, text) => ({ kind: 'prompt', session, facts: { text } });
const words = (r) => r.map((x) => x.word);

test('suggests capitalized words used mid-sentence, CamelCase and all-capitals words, seen twice or more', () => {
  const sessions = [{ key: 'a', title: 'Fix the LarkBoard export', mine: true }];
  const events = [
    prompt('a', 'Send the summary to Priya before the ACME call.'),
    prompt('a', 'Ask Priya whether ACME wants the LarkBoard numbers.'),
    // A capitalized word that only starts a sentence is just a sentence start.
    prompt('a', 'Check the dates. Check the totals.\nCheck again.'),
    // Seen once: not suggested.
    prompt('a', 'Mention Oskar once.'),
  ];
  const r = suggestWords({ sessions, events, include: (s) => s.mine });
  assert.deepEqual(r, [{ word: 'ACME', count: 2 }, { word: 'LarkBoard', count: 2 }, { word: 'Priya', count: 2 }]);
});

test('leaves out code: code spans and blocks, identifiers with an underscore, and names starting lowercase', () => {
  const sessions = [{ key: 'a', title: 'x', mine: true }];
  const text = 'Set GITHUB_TOKEN, call filterSince in `LarkBoard.render()`, then\n```\nconst Quill = new QuillEditor();\n```\nask Priya.';
  const events = [prompt('a', text), prompt('a', text)];
  assert.deepEqual(words(suggestWords({ sessions, events, include: (s) => s.mine })), ['Priya']);
});

test('leaves out tool names and words already listed, in any case', () => {
  const sessions = [{ key: 'a', title: 'x', mine: true }];
  const text = 'Push to GitHub and ask Claude about Priya, the Zephyr app and the README for Quill.';
  const events = [prompt('a', text), prompt('a', text)];
  const r = suggestWords({ sessions, events, include: (s) => s.mine, exclude: ['priya', 'Zephyr'] });
  assert.deepEqual(words(r), ['Quill'], JSON.stringify(r));
});

test('a first name alone is still suggested when only the whole name is listed, since the redactor hides only the whole name', () => {
  const sessions = [{ key: 'a', title: 'x', mine: true }];
  const events = [prompt('a', 'ask Priya about it'), prompt('a', 'and Priya again')];
  assert.deepEqual(words(suggestWords({ sessions, events, include: (s) => s.mine, exclude: ['Priya Raman'] })), ['Priya']);
});

test('names in any alphabet come back whole, and list items and quotes count as sentence starts', () => {
  const sessions = [{ key: 'a', title: 'x', mine: true }];
  const text = 'ask José and Łukasz.\nDo this:\n- Check the totals\n2. Update the docs\nDone. "Remove it" now.';
  const events = [prompt('a', text), prompt('a', text)];
  assert.deepEqual(words(suggestWords({ sessions, events, include: (s) => s.mine })), ['José', 'Łukasz']);
});

test('failing-path partner: a display-only or outside session adds nothing, and the list stops at the cap', () => {
  const sessions = [{ key: 'mine', title: 'Notes', mine: true }, { key: 'theirs', title: 'Orchid Orchid', mine: false }];
  const many = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, i) => `Word${String.fromCharCode(65 + i)}x`).join(' and ');
  const events = [prompt('mine', `see ${many}`), prompt('mine', `see ${many}`), prompt('theirs', 'about Orchid and Orchid')];
  const r = suggestWords({ sessions, events, include: (s) => s.mine });
  assert.equal(r.length, MAX_SUGGESTIONS);
  assert.ok(!words(r).includes('Orchid'), 'a session left out contributes nothing');
});

test('the route answers from the redacted build, so no private word or repository label comes back', async () => {
  const scratch = makeTempDir('hw-suggest-');
  after(() => removeTempDir(scratch));
  const w = buildViewWeek(join(scratch, 'week'));
  const data = createViewData({ config: w.config, roots: w.roots, from: WEEK.from, to: WEEK.to, timezone: 'UTC', goalRecord: w.goalRecord });
  try {
    data.start();
    let r;
    for (let i = 0; i < 400; i++) {
      r = await data.route('/api/suggest-words', new URLSearchParams());
      if (r.status !== 503) break;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.words) && r.body.words.length <= MAX_SUGGESTIONS);
    const said = JSON.stringify(r.body.words).toLowerCase();
    for (const p of PRIVATE_WORDS) assert.ok(!said.includes(p.toLowerCase()), `${p} isn't suggested`);
    for (const label of w.config.repos.map((x) => x.label)) assert.ok(!r.body.words.some((x) => x.word.toLowerCase() === label.toLowerCase()), `${label} isn't suggested`);
    // Asking for the private version changes nothing: suggestions always come from the redacted build.
    const priv = await data.route('/api/suggest-words', new URLSearchParams({ private: '1' }));
    assert.deepEqual(priv.body.words, r.body.words);
  } finally {
    data.stop?.();
  }
});

test('the no-private-words note points to Suggest words only where Settings can change the config', () => {
  assert.match(privateWordsNote('honestweek'), /Suggest words from my sessions/);
  const elsewhere = privateWordsNote('honestweek', { settings: false });
  assert.ok(!elsewhere.includes('Settings'), elsewhere);
  assert.match(elsewhere, /run honestweek discover, then honestweek harvest/);
});
