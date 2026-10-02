// The prompt-privacy audit shares the redactor's path patterns, so it must keep an escaped
// quote intact the same way: a path inside JSON-encoded text leaves valid JSON behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactWithAudit } from '../lib/prompt-privacy.mjs';

test('a home path inside an escaped quote is redacted and the JSON still parses', () => {
  const raw = JSON.stringify({ cmd: 'git -C "C:\\Users\\user\\repo" status' });
  assert.ok(raw.includes('\\"C:\\\\Users'), 'the fixture really holds an escaped quote before the path');
  const out = redactWithAudit(raw).text;
  assert.doesNotMatch(out, /\\\\user\\\\/);
  assert.match(out, /\[redacted:path\]/);
  assert.doesNotThrow(() => JSON.parse(out));
});
