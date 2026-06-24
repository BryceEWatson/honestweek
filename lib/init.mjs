// lib/init.mjs — the `init` subcommand: two-confirmation, low-friction setup.
//
// `init` infers and proposes everything (identity, repo allowlist + roles, sane
// defaults), shows the full proposed config, and writes NOTHING until the user
// confirms twice. All discovery is read-only — it never runs a mutating git
// command. Accepting every default (pressing through both confirmations) yields
// a valid, buildable config.
//
// Zero runtime dependencies: Node built-ins + the system `git` CLI only.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';

import { hostTimezone, DEFAULT_OUTPUT_FILES, ROLES } from './config.mjs';

const CONFIG_FILE = 'honestweek.config.json';
const EXAMPLE_FILE = 'honestweek.config.example.json';
const GITIGNORE_FILE = '.gitignore';
const DRAFT_SIDECAR = 'honestweek.draft.json';

// The clean-room template init writes when no example exists: empty term-lists,
// placeholder-only values, NO real paths/names/repos/emails.
const EXAMPLE_CONFIG = {
  identity: { authorEmails: ['you@example.com'] },
  week: { startsOn: 'monday', timezone: 'UTC' },
  repos: [
    { path: '/path/to/your/repo', label: 'your-project', role: 'featured' },
    { path: '~/code/a-shared-repo', label: 'a-shared-repo', role: 'reference' },
    { path: '~/code/a-client-repo', label: 'a-private-project', role: 'display' },
  ],
  redaction: { codenames: [], names: [], terms: [] },
  output: { mode: 'digest', file: DEFAULT_OUTPUT_FILES.digest },
};

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** git config user.email in `cwd`, or null if unavailable. Read-only. */
export function inferAuthorEmail(cwd) {
  try {
    const email = git(cwd, ['config', 'user.email']).trim();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/** True iff `email` has authored at least one commit in `repoPath`. Read-only. */
function authorHasCommits(repoPath, email) {
  if (!email) return false;
  try {
    return git(repoPath, ['log', `--author=${email}`, '-1', '--format=%H']).trim().length > 0;
  } catch {
    return false;
  }
}

function isGitRepo(dir) {
  return existsSync(join(dir, '.git'));
}

/**
 * discoverRepos(cwd, authorEmail) -> [{ path, label, role }]
 * Scans the immediate children of cwd's parent, plus cwd itself, for git repos
 * (no recursion). The current dir defaults to "featured"; other repos default
 * to "featured" if the author has committed in them, else "reference".
 */
export function discoverRepos(cwd, authorEmail) {
  const cwdAbs = resolve(cwd);
  const parent = dirname(cwdAbs);
  const seen = new Set();
  const candidates = [cwdAbs];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(resolve(parent, entry.name));
    }
  } catch {
    /* parent unreadable — fall back to just cwd */
  }

  const repos = [];
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (!isGitRepo(p)) continue;
    const isCwd = p === cwdAbs;
    const role = isCwd || authorHasCommits(p, authorEmail) ? 'featured' : 'reference';
    repos.push({ path: p, label: basename(p), role });
  }
  // cwd first, then the rest in stable (already-sorted by readdir) order.
  repos.sort((a, b) => (a.path === cwdAbs ? -1 : b.path === cwdAbs ? 1 : 0));
  return repos;
}

/** Assemble the config object from the inferred pieces. */
export function buildConfig({ authorEmail, repos, timezone }) {
  return {
    identity: { authorEmails: authorEmail ? [authorEmail] : [] },
    week: { startsOn: 'monday', timezone: timezone || 'UTC' },
    repos: repos.map((r) => ({ path: r.path, label: r.label, role: r.role })),
    redaction: { codenames: [], names: [], terms: [] },
    output: { mode: 'digest', file: DEFAULT_OUTPUT_FILES.digest },
  };
}

/** Append `entry` to `.gitignore` idempotently (create if absent). Returns true
 *  if a line was added. */
export function ensureGitignore(cwd, entry) {
  const file = join(cwd, GITIGNORE_FILE);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = existing.split(/\r?\n/).some((l) => l.trim() === entry);
  if (present) return false;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(file, `${prefix}${entry}\n`);
  return true;
}

/**
 * writeInitFiles(cwd, config, { force }) -> { wrote, skipped }
 * Writes honestweek.config.json (overwriting only when force), the generic
 * example if absent, and the .gitignore draft entry. The ONLY disk writes.
 */
export function writeInitFiles(cwd, config, { force = false } = {}) {
  const wrote = [];
  const skipped = [];
  const configPath = join(cwd, CONFIG_FILE);

  if (existsSync(configPath) && !force) {
    skipped.push(`${CONFIG_FILE} (already exists; pass --force to overwrite)`);
  } else {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    wrote.push(CONFIG_FILE);
  }

  const examplePath = join(cwd, EXAMPLE_FILE);
  if (existsSync(examplePath)) {
    skipped.push(`${EXAMPLE_FILE} (already exists)`);
  } else {
    writeFileSync(examplePath, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
    wrote.push(EXAMPLE_FILE);
  }

  if (ensureGitignore(cwd, DRAFT_SIDECAR)) wrote.push(`${GITIGNORE_FILE} (+${DRAFT_SIDECAR})`);
  else skipped.push(`${GITIGNORE_FILE} (${DRAFT_SIDECAR} already ignored)`);

  return { wrote, skipped };
}

function parseFlags(argv) {
  const flags = { yes: false, force: false };
  for (const a of argv ?? []) {
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--force') flags.force = true;
  }
  return flags;
}

const isYes = (s, dflt) => {
  const t = String(s ?? '').trim().toLowerCase();
  if (t === '') return dflt;
  return t === 'y' || t === 'yes';
};

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    async prompt(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise((res) => rl.question(question, res));
      } finally {
        rl.close();
      }
    },
  };
}

function renderAllowlist(repos) {
  return repos
    .map((r, i) => `  [${i + 1}] ${r.label}  (${r.role})\n        ${r.path}`)
    .join('\n');
}

/** Interactive allowlist editing: drop entries / change roles before confirming. */
async function editAllowlist(io, repos) {
  let working = repos.slice();
  for (;;) {
    io.out(`\nProposed repo allowlist:\n${renderAllowlist(working)}\n`);
    const cmd = (
      await io.prompt(
        "Edit and press Enter to accept — 'role N <featured|reference|display>' or 'drop N': "
      )
    )
      .trim()
      .toLowerCase();
    if (cmd === '') break;
    const roleM = /^role\s+(\d+)\s+(featured|reference|display)$/.exec(cmd);
    const dropM = /^drop\s+(\d+)$/.exec(cmd);
    if (roleM) {
      const idx = Number(roleM[1]) - 1;
      if (working[idx] && ROLES.includes(roleM[2])) working[idx].role = roleM[2];
      else io.err('  (no such entry)\n');
    } else if (dropM) {
      const idx = Number(dropM[1]) - 1;
      if (working[idx]) working.splice(idx, 1);
      else io.err('  (no such entry)\n');
    } else {
      io.err("  (unrecognized; use 'role N <role>', 'drop N', or Enter)\n");
    }
  }
  return working;
}

function reportWrite(io, result) {
  for (const w of result.wrote) io.out(`  wrote ${w}\n`);
  for (const s of result.skipped) io.out(`  skipped ${s}\n`);
  io.out('\nNext: fill in honestweek.config.json, then run `honestweek discover`.\n');
}

/** Core init flow with injectable cwd/argv/io (for testability). */
export async function runInit({ cwd = process.cwd(), argv = [], io = defaultIo() } = {}) {
  const flags = parseFlags(argv);
  const authorEmail = inferAuthorEmail(cwd);
  if (!authorEmail) {
    io.err(
      'Warning: could not infer your git user.email. identity.authorEmails will be empty — fill it in before running `build`, or the authorship check cannot pass.\n'
    );
  }
  const repos = discoverRepos(cwd, authorEmail);
  const timezone = hostTimezone();
  const configExists = existsSync(join(cwd, CONFIG_FILE));

  // Non-interactive escape hatch.
  if (flags.yes) {
    if (configExists && !flags.force) {
      io.out(`${CONFIG_FILE} already exists; leaving it unchanged (pass --force to overwrite).\n`);
      return 0;
    }
    const config = buildConfig({ authorEmail, repos, timezone });
    reportWrite(io, writeInitFiles(cwd, config, { force: true }));
    return 0;
  }

  if (configExists) {
    io.out(`Note: ${CONFIG_FILE} already exists and will be overwritten only if you confirm.\n`);
  }

  // First confirmation: the allowlist (after any edits).
  const finalRepos = await editAllowlist(io, repos);
  const ok1 = await io.prompt(`\nUse this allowlist of ${finalRepos.length} repo(s)? [Y/n] `);
  if (!isYes(ok1, true)) {
    io.out('Aborted; nothing was written.\n');
    return 1;
  }

  // Second confirmation: the full proposed config before writing.
  const config = buildConfig({ authorEmail, repos: finalRepos, timezone });
  io.out(`\nProposed ${CONFIG_FILE}:\n${JSON.stringify(config, null, 2)}\n`);
  const writeDefault = !configExists; // default-yes for fresh setup, default-no to overwrite
  const ok2 = await io.prompt(
    `\nWrite ${CONFIG_FILE} now? [${writeDefault ? 'Y/n' : 'y/N'}] `
  );
  if (!isYes(ok2, writeDefault)) {
    io.out('Aborted; nothing was written.\n');
    return 1;
  }

  reportWrite(io, writeInitFiles(cwd, config, { force: true }));
  return 0;
}

export default function run(argv) {
  return runInit({ argv });
}
