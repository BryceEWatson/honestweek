import { resolve } from 'node:path';

import { CARRY_GITIGNORE, readCarryPending, recoverCarryPending } from './digest-carry.mjs';
import { resolvePrimaryOutputPath } from './emit/index.mjs';
import { preflightPromptOutput } from './prompt-lane.mjs';
import { ensureGitignore } from './init.mjs';

export async function recoverConfiguredCarry({ cwd, config, hasGoals = false, discard = false, fs } = {}) {
  const pending = readCarryPending(cwd, config, { optional: true });
  if (!pending) return { recovered: false, action: 'none' };
  for (const entry of CARRY_GITIGNORE) ensureGitignore(cwd, entry, fs?.gitignore);
  const outputBinding = await preflightPromptOutput({ cwd, config, hasGoals });
  const outputPath = await resolvePrimaryOutputPath(config, { cwd });
  return recoverCarryPending({
    cwd, config, outputPath,
    outputBinding: { ...outputBinding, outputPath: resolve(outputPath) },
    pending, discard, fs,
  });
}
