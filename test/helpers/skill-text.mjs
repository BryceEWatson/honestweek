// The weekly skill's whole text: SKILL.md, then each flow file its table points to, in the
// table's order. Since issue 182 the flow detail lives in flows/, so tests that check what the
// skill tells Claude read this, and tests about the front matter or the order of SKILL.md read
// SKILL_MD alone.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL_MD = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8');
/** The flow files SKILL.md's table names, in order, as repository-relative paths. */
export const FLOW_FILES = [...SKILL_MD.matchAll(/\]\((flows\/[a-z-]+\.md)\)/g)].map((m) => m[1]);
export const SKILL_TEXT = [SKILL_MD, ...FLOW_FILES.map((f) => readFileSync(join(SKILL_ROOT, f), 'utf8'))].join('\n');
