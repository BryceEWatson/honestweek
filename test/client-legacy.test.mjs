import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBuild } from '../lib/build.mjs';
import { buildLegacyFixture } from './fixtures/client-legacy-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Invariant 6: new output is additive. A client report with no reader profile, no
// unfinished work and nothing new in its items renders exactly the bytes the client
// report produced before reader profiles existed (captured from that code).
test('without reader inputs the client report is byte-identical to the report before profiles', async () => {
  const f = buildLegacyFixture();
  try {
    let err = '';
    const code = await runBuild({ cwd: f.work, now: f.now, io: { out() {}, err(s) { err += s; }, exit(c) { return c; } } });
    assert.equal(code, 0, err);
    assert.deepEqual(readFileSync(f.out), readFileSync(join(HERE, 'fixtures', 'client-legacy.html')));
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    rmSync(f.work, { recursive: true, force: true });
  }
});
