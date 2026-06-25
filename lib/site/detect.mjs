// lib/site/detect.mjs — framework-agnostic detection of a website in a directory.
//
// Before honestweek can integrate with a target site, it has to recognize that
// the directory IS a site and find where a page imports its data. This is a
// DETERMINISTIC probe (no model call): it reads a directory's manifest +
// conventional config/data locations and reports generic signals. It hardcodes
// no single site — only the public conventions of common frameworks — so it stays
// clean-room. The intelligent step (authoring the adapter) consumes these signals;
// it never depends on this module knowing any one site's field names.
//
// Zero runtime dependencies: Node built-ins only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Public dependency names that identify a static-site / app framework. Generic
// conventions, not any one site. A match is a SIGNAL, never a requirement.
const FRAMEWORK_DEPS = {
  astro: 'astro',
  next: 'next',
  gatsby: 'gatsby',
  '@11ty/eleventy': 'eleventy',
  '@sveltejs/kit': 'sveltekit',
  nuxt: 'nuxt',
  '@docusaurus/core': 'docusaurus',
  'react-scripts': 'cra',
  vite: 'vite',
  remix: 'remix',
  '@remix-run/dev': 'remix',
};

// Conventional framework config files (existence is a framework signal).
const CONFIG_GLOBS = [
  ['astro', /^astro\.config\.(mjs|cjs|js|ts)$/],
  ['next', /^next\.config\.(mjs|cjs|js|ts)$/],
  ['gatsby', /^gatsby-config\.(mjs|cjs|js|ts)$/],
  ['nuxt', /^nuxt\.config\.(mjs|cjs|js|ts)$/],
  ['svelte', /^svelte\.config\.(mjs|cjs|js|ts)$/],
  ['eleventy', /^\.eleventy\.(c?js)$/],
  ['vite', /^vite\.config\.(mjs|cjs|js|ts)$/],
];

// Conventional directories a framework imports JSON data from.
const DATA_DIRS = ['src/data', 'data', '_data', 'src/_data', 'site/data'];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The framework keys implied by a package.json's declared dependencies. */
function frameworksFromPackage(pkg) {
  const found = new Set();
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const dep of Object.keys(deps)) {
    if (FRAMEWORK_DEPS[dep]) found.add(FRAMEWORK_DEPS[dep]);
  }
  return found;
}

/** The framework keys implied by config files present at the root. */
function frameworksFromConfigs(rootDir, names) {
  const found = new Set();
  for (const [fw, re] of CONFIG_GLOBS) {
    if (names.some((n) => re.test(n))) found.add(fw);
  }
  return found;
}

/** Top-level JSON data artifacts under the conventional data directories. */
function dataArtifacts(rootDir) {
  const out = [];
  for (const rel of DATA_DIRS) {
    const dir = join(rootDir, rel);
    let entries;
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json')) out.push(`${rel}/${e.name}`);
    }
  }
  out.sort();
  return out;
}

/**
 * detectSite(rootDir) -> { isSite, frameworks, signals, dataArtifacts, packageName }
 *
 * Deterministic. `isSite` is true when a framework is detected (by dependency or
 * config file). `frameworks` is a sorted list of detected framework keys;
 * `signals` enumerates WHY (which evidence fired); `dataArtifacts` lists the JSON
 * files a page could import (adapter `artifact` candidates). Never throws.
 */
export function detectSite(rootDir) {
  let names = [];
  try {
    names = readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return { isSite: false, frameworks: [], signals: [], dataArtifacts: [], packageName: null };
  }

  const pkgPath = join(rootDir, 'package.json');
  const pkg = existsSync(pkgPath) ? readJson(pkgPath) : null;

  const signals = [];
  const frameworks = new Set();

  if (pkg) {
    for (const fw of frameworksFromPackage(pkg)) {
      frameworks.add(fw);
      signals.push(`dependency:${fw}`);
    }
  }
  for (const fw of frameworksFromConfigs(rootDir, names)) {
    frameworks.add(fw);
    signals.push(`config:${fw}`);
  }

  const artifacts = dataArtifacts(rootDir);
  for (const a of artifacts) signals.push(`data:${a}`);

  return {
    isSite: frameworks.size > 0,
    frameworks: [...frameworks].sort(),
    signals,
    dataArtifacts: artifacts,
    packageName: typeof pkg?.name === 'string' ? pkg.name : null,
  };
}
