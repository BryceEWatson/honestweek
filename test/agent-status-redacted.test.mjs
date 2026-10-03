// A sub-agent's finishing status comes from the <status> tag of a task notification,
// which is text in the log like any other. It must reach the history redacted, the
// same as the notification's own facts, not copied raw onto the agent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkHistory } from '../lib/replay/index.mjs';
import { buildCorpus, CODENAME } from './fixtures/replay/corpus.mjs';

let fx;
before(() => {
  fx = buildCorpus();
  const file = join(fx.claudeRoot, fx.dirs.A, `${fx.ids.A}.jsonl`);
  const text = readFileSync(file, 'utf8');
  const marked = text.replace('<tool-use-id>tu-agent1</tool-use-id>\\n<status>completed</status>', `<tool-use-id>tu-agent1</tool-use-id>\\n<status>completed for ${CODENAME}</status>`);
  assert.notEqual(marked, text, 'the corpus still has the reviewer notification this test edits');
  writeFileSync(file, marked);
});
after(() => {
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    /* Windows can hold a lock on .git briefly */
  }
});

for (const mode of [{}, { hiddenSessions: 'redacted' }, { privateText: true }]) {
  test(`a sub-agent's finishing status is redacted (${JSON.stringify(mode)})`, async () => {
    const h = await buildWorkHistory({ config: fx.config, from: '2024-06-10', to: '2024-06-16', roots: { claude: [fx.claudeRoot], codex: [fx.codexRoot] }, ...mode });
    const reviewer = h.agents.find((a) => a.description === 'Review the widget parser');
    assert.ok(reviewer?.completion, 'the reviewer is finished by its notification');
    assert.equal(reviewer.completion.via, 'notification');
    // A codename is hidden by the full redactor; with private text on, codenames show.
    if (mode.privateText) assert.match(reviewer.completion.status, new RegExp(CODENAME));
    else {
      assert.doesNotMatch(reviewer.completion.status, new RegExp(CODENAME));
      assert.doesNotMatch(JSON.stringify(h.agents), new RegExp(CODENAME));
    }
  });
}
