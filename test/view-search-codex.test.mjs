// Find's search reads only what a person typed into Codex. Codex sends its own context
// (the AGENTS.md text, an environment block, instruction blocks) through the same user
// message slot as a prompt; a child thread's user messages are its parent agent's
// hand-off, and a `codex exec` run's are the instruction whatever started it wrote.
// None of those is a prompt, so none is indexed. All sessions here are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers/temp-dir.mjs';
import { buildWordIndex, createWordSearch } from '../lib/replay/word-index.mjs';

const at = (mm, ss = 0) => `2025-03-12T10:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;
const cx = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
const user = (ts, ...texts) => cx(ts, 'response_item', { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) });
const said = (ts, text) => cx(ts, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

const IDS = { main: '0195aaaa-0000-7000-8000-000000000001', child: '0195aaaa-0000-7000-8000-000000000002', exec: '0195aaaa-0000-7000-8000-000000000003' };

function codexRoot() {
  const root = makeTempDir('hw-cxsearch-');
  const day = join(root, '2025', '03', '12');
  mkdirSync(day, { recursive: true });
  const write = (id, lines) => writeFileSync(join(day, `rollout-2025-03-12T10-00-00-${id}.jsonl`), `${lines.join('\n')}\n`);
  write(IDS.main, [
    cx(at(0), 'session_meta', { id: IDS.main, timestamp: at(0), cwd: '/path/to/your/repo', originator: 'codex_cli_rs', cli_version: '0.1.0', source: 'cli' }),
    user(at(0, 1), '# AGENTS.md instructions for /path/to/your/repo\n\n<INSTRUCTIONS>\nAlways run the quokkarules suite before you say done.\n</INSTRUCTIONS>'),
    user(at(0, 2), '<environment_context>\n  <cwd>/path/to/your/repo</cwd>\n  <shell>bash</shell>\n  <note>wallabyenv</note>\n</environment_context>'),
    user(at(0, 3), '<user_instructions>\nPrefer small diffs, numbatinstr.\n</user_instructions>'),
    user(at(1), '<environment_context>\n  <cwd>/path/to/your/repo</cwd>\n</environment_context>', 'Fix the bilbytyped date parser in the report.'),
    cx(at(1, 1), 'event_msg', { type: 'user_message', message: 'Fix the bilbytyped date parser in the report.' }),
    said(at(2), 'Fixed it.'),
    user(at(3), '# Context from my IDE setup:\n\n## Open tabs:\n- dingotab.js\n\n## My request for Codex:\nNow add a test for the echidnaide case.'),
  ]);
  write(IDS.child, [
    cx(at(4), 'session_meta', { id: IDS.child, timestamp: at(4), cwd: '/path/to/your/repo', originator: 'codex_cli_rs', cli_version: '0.1.0', source: { subagent: { thread_spawn: { parent_thread_id: IDS.main, depth: 1, agent_path: '/root/fixtures', agent_nickname: 'Fixtures' } } } }),
    user(at(4, 1), 'Write the possumhandoff fixtures and report back.'),
    said(at(5), 'Done.'),
  ]);
  write(IDS.exec, [
    cx(at(6), 'session_meta', { id: IDS.exec, timestamp: at(6), cwd: '/path/to/your/repo', originator: 'codex_exec', cli_version: '0.1.0', source: 'exec' }),
    user(at(6, 1), 'Summarise the emuexec changes for the notes.'),
    said(at(7), 'Summarised.'),
  ]);
  return root;
}

test("Find indexes only what a person typed into Codex: no AGENTS.md text, injected blocks, child-thread hand-offs or codex exec instructions", async () => {
  const root = codexRoot();
  const index = await buildWordIndex({ roots: { claude: [], codex: [root] }, startT: Date.parse('2025-03-12T00:00:00Z'), endT: Date.parse('2025-03-13T00:00:00Z') });
  assert.equal(index.sessions.length, 1, 'only the person-started session is listed');
  const [s] = index.sessions;
  assert.equal(s.tool, 'codex');
  assert.deepEqual(s.prompts.map((p) => p.text), ['Fix the bilbytyped date parser in the report.', 'Now add a test for the echidnaide case.'], 'the typed request kept, the dual-written copy counted once, the IDE wrapper dropped');

  const search = createWordSearch(index);
  const find = (q) => search(q, { redact: (x) => x });
  for (const word of ['quokkarules', 'AGENTS.md', 'wallabyenv', 'numbatinstr', 'dingotab', 'possumhandoff', 'emuexec']) {
    assert.equal(find(word).results.length, 0, `${word} is not something the person typed`);
  }
  const hit = find('bilbytyped');
  assert.equal(hit.results.length, 1);
  assert.equal(hit.total.value, 1, 'one match, not one per written copy');
  assert.equal(hit.results[0].name.startsWith('Fix the bilbytyped'), true, "the session is named by the person's first prompt, not the AGENTS.md text");
  assert.equal(find('echidnaide').results.length, 1);
});
