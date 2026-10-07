// An environment for a spawned honestweek that can't reach a config set up for the whole machine:
// its home folder is an empty one of the test's own, so there's no ~/.honestweek, and
// HONESTWEEK_CONFIG is gone. A machine where someone ran `honestweek init --user` then runs these
// tests the same way CI does, and a test never reads (or writes beside) that person's config.

import { makeTempDir } from './temp-dir.mjs';

let home = null;

/** `env` with HOME and USERPROFILE pointed at an empty folder, and no HONESTWEEK_CONFIG. */
export function withoutUserConfig(env = process.env) {
  home ??= makeTempDir('hw-no-user-config-');
  const out = { ...env, HOME: home, USERPROFILE: home };
  delete out.HONESTWEEK_CONFIG;
  return out;
}
