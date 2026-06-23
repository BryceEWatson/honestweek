// lib/config.mjs — load, validate, and normalize honestweek.config.json.
//
// This is the foundation every other module receives its config from. It is
// deliberately strict and fails LOUD: every validation failure throws an Error
// whose message names the offending field and says what was wrong, never a
// best-effort coercion past a bad config. That mirrors the build-time abort
// discipline (an unverifiable claim aborts the build) at the config layer.
//
// Zero runtime dependencies: Node built-ins only (node:fs, node:path, node:os).
// Error messages never dump the whole config (which could echo private
// redaction terms) — they name the offending field/value-type only.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

/** The valid repo trust levels. featured = git-read + git-verified + headlined;
 *  reference = git-read but not headlined; display = summarized generically,
 *  NEVER git-read. Strictly validated here so downstream can trust the tag. */
export const ROLES = ['featured', 'reference', 'display'];

/** The supported output modes. digest is the default and the trust anchor. */
export const OUTPUT_MODES = ['post', 'changelog', 'digest'];

/** v0.1 only supports weeks that start on Monday. */
export const WEEK_STARTS = ['monday'];

/** Default local output file per mode — the single source of truth shared with
 *  the emitters. A loaded config always carries a concrete output.file. */
export const DEFAULT_OUTPUT_FILES = Object.freeze({
  post: 'honestweek.post.md',
  changelog: 'CHANGELOG.md',
  digest: 'honestweek.digest.md',
});

/**
 * Email-shape rule (no regex library, no personal data): valid iff the value is
 * a string with exactly one "@", a non-empty local part, and a non-empty domain
 * that contains a "." (and no surrounding whitespace).
 */
export function isEmailShaped(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() !== value || value.length === 0) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (/\s/.test(value)) return false;
  return true;
}

/** Expand a leading ~ / ~/ to the user's home dir; resolve relatives against
 *  the config file's directory; pass absolutes through unchanged. */
export function resolveRepoPath(rawPath, configDir) {
  if (rawPath === '~' || rawPath === '~/' || rawPath === '~\\') {
    return homedir();
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return resolve(homedir(), rawPath.slice(2));
  }
  if (isAbsolute(rawPath)) {
    return rawPath;
  }
  return resolve(configDir, rawPath);
}

function fail(message) {
  throw new Error(`honestweek config: ${message}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate + normalize a parsed config object. Returns a NEW object; never
 * mutates the input. `configDir` is the directory used to resolve relative repo
 * paths (defaults to the current working directory).
 */
export function normalizeConfig(raw, { configDir = process.cwd() } = {}) {
  if (!isPlainObject(raw)) {
    fail('top-level value must be a JSON object.');
  }

  // --- identity.authorEmails (required, non-empty, all email-shaped) ---
  if (!isPlainObject(raw.identity)) {
    fail('"identity" is required and must be an object with an "authorEmails" array.');
  }
  const authorEmails = raw.identity.authorEmails;
  if (!Array.isArray(authorEmails) || authorEmails.length === 0) {
    fail('"identity.authorEmails" is required and must be a non-empty array.');
  }
  authorEmails.forEach((email, i) => {
    if (!isEmailShaped(email)) {
      fail(`"identity.authorEmails[${i}]" is not an email-shaped string.`);
    }
  });

  // --- repos (required, non-empty; each has path, label, valid role) ---
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    fail('"repos" is required and must be a non-empty array.');
  }
  const repos = raw.repos.map((repo, i) => {
    if (!isPlainObject(repo)) {
      fail(`"repos[${i}]" must be an object with "path", "label", and "role".`);
    }
    if (typeof repo.path !== 'string' || repo.path.length === 0) {
      fail(`"repos[${i}].path" is required and must be a non-empty string.`);
    }
    if (typeof repo.label !== 'string' || repo.label.length === 0) {
      fail(`"repos[${i}].label" is required and must be a non-empty string.`);
    }
    if (!ROLES.includes(repo.role)) {
      fail(`"repos[${i}].role" must be one of ${JSON.stringify(ROLES)} (got ${JSON.stringify(repo.role)}).`);
    }
    return {
      path: repo.path,
      label: repo.label,
      role: repo.role,
      resolvedPath: resolveRepoPath(repo.path, configDir),
    };
  });

  // --- week (optional; defaults applied) ---
  const rawWeek = raw.week;
  if (rawWeek !== undefined && !isPlainObject(rawWeek)) {
    fail('"week" must be an object when present.');
  }
  const startsOn = rawWeek?.startsOn ?? 'monday';
  if (!WEEK_STARTS.includes(startsOn)) {
    fail(`"week.startsOn" must be "monday" for v0.1 (got ${JSON.stringify(startsOn)}).`);
  }
  let timezone = rawWeek?.timezone;
  if (timezone !== undefined && (typeof timezone !== 'string' || timezone.length === 0)) {
    fail('"week.timezone" must be a non-empty string when present.');
  }
  if (timezone === undefined) {
    timezone = hostTimezone();
  }

  // --- redaction (optional; default empty arrays) ---
  const rawRedaction = raw.redaction;
  if (rawRedaction !== undefined && !isPlainObject(rawRedaction)) {
    fail('"redaction" must be an object when present.');
  }
  const redaction = {
    codenames: normalizeStringArray(rawRedaction?.codenames, 'redaction.codenames'),
    names: normalizeStringArray(rawRedaction?.names, 'redaction.names'),
    terms: normalizeStringArray(rawRedaction?.terms, 'redaction.terms'),
  };

  // --- output (optional; mode defaults to digest; file derived if absent) ---
  const rawOutput = raw.output;
  if (rawOutput !== undefined && !isPlainObject(rawOutput)) {
    fail('"output" must be an object when present.');
  }
  const mode = rawOutput?.mode ?? 'digest';
  if (!OUTPUT_MODES.includes(mode)) {
    fail(`"output.mode" must be one of ${JSON.stringify(OUTPUT_MODES)} (got ${JSON.stringify(mode)}).`);
  }
  let file = rawOutput?.file;
  if (file !== undefined && (typeof file !== 'string' || file.length === 0)) {
    fail('"output.file" must be a non-empty string when present.');
  }
  if (file === undefined) {
    file = DEFAULT_OUTPUT_FILES[mode];
    if (!file) {
      fail(`"output.file" is required for mode ${JSON.stringify(mode)} and could not be derived.`);
    }
  }

  return {
    identity: { authorEmails: authorEmails.map(String) },
    week: { startsOn, timezone },
    repos,
    redaction,
    output: { mode, file },
  };
}

function normalizeStringArray(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`"${fieldName}" must be an array of strings when present.`);
  }
  value.forEach((entry, i) => {
    if (typeof entry !== 'string') {
      fail(`"${fieldName}[${i}]" must be a string.`);
    }
  });
  return value.slice();
}

/** Resolve the host IANA timezone deterministically; fall back to "UTC". */
export function hostTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * loadConfig(path) — read, parse, validate, normalize honestweek.config.json.
 * Throws a clear Error naming the offending file/field on any failure. Repo
 * paths are resolved relative to the directory containing the config file.
 */
export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`honestweek config: file not found at ${path}`);
    }
    throw new Error(`honestweek config: could not read ${path}: ${err?.message ?? err}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`honestweek config: ${path} is not valid JSON (${err?.message ?? err}).`);
  }

  return normalizeConfig(parsed, { configDir: dirname(resolve(path)) });
}
