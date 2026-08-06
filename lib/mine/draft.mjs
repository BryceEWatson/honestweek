// lib/mine/draft.mjs — turn a finding into a real draft a human can accept or reject.
//
// A ranked list is not an actuator. If the output of this pipeline were "here are 6
// things you could write about", the human still has to choose one, remember the
// details, and start from an empty file — three chances to drop it, on top of the
// one act that genuinely needs them. So the drafter emits a POST, and the human's
// remaining job is to check it and say yes or no.
//
// WHAT THIS MODULE REFUSES TO DO
// ----------------------------------------------------------------------------
// It will not assert that the fix still works. The session log proves what happened
// on one machine on one day against one build. Whether the fix holds today is a fact
// about the CURRENT world, and no amount of reading old logs can establish it.
//
// So the draft carries, structurally rather than as a note:
//   - a `verification` block listing every claim that must be re-run before publish,
//     each starting UNVERIFIED;
//   - a "What I could not check" section, pre-filled with the things that are
//     genuinely uncheckable from a log;
//   - a last-verified field left EMPTY, because filling it in would be a lie until
//     someone re-runs the checks.
// A draft that shipped with those pre-filled would be worse than no draft: it would
// launder an old observation into a present-tense claim.
//
// STAYING GENERIC
// ----------------------------------------------------------------------------
// honestweek is a generic generator; it must not know any particular site's schema.
// The destination supplies its own frontmatter shape via `config.mine.draft`, and
// this module fills the keys it recognises and leaves the rest empty. No field name
// here is anyone's convention — `lastVerified` appears only if a config asks for it.
//
// Zero runtime dependencies: Node built-ins only.

/** Frontmatter keys the drafter knows how to fill. Anything else a destination lists
 *  is emitted empty for the human, rather than guessed at. */
const KNOWN_KEYS = new Set(['title', 'description', 'date', 'tags', 'draft']);

/** Keys whose meaning is "when was this last confirmed true". Emitted EMPTY always —
 *  see the module header.
 *
 *  Matched by PATTERN, not by an exact list. An exact list of four spellings let the
 *  near-misses through with their configured values intact: a destination whose schema
 *  says `lastVerifiedAt: "2026-01-01"` got that date copied into a document whose whole
 *  premise is that nothing in it has been checked. */
const VERIFIED_KEY_RE = /verif|checked|validated|confirmed/i;

/** Keys that decide whether a document is live. Forced to the unpublished value
 *  whatever the config says, because a mined draft is by definition not ready. */
const PUBLISH_STATE_KEYS = new Set(['draft', 'published', 'public', 'live']);

function yamlScalar(v) {
  if (v === null || v === undefined) return '""';
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(String(v));
}

/** A URL-safe slug from an error string. Deterministic, so re-drafting the same
 *  finding overwrites its own file rather than littering new ones. */
export function slugFor(finding) {
  const words = (finding.primaryError || finding.products?.[0]?.name || 'finding')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ') // drop <home>/<drive>/<project> markers, keep the boundary
    .replace(/\[redacted[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    // A slug becomes the published URL and enters git history, so any token that only
    // survived because a redaction marker was stripped around it must not reach it.
    .filter((w) => !['redacted', 'home', 'drive', 'project', 'user', 'share'].includes(w))
    .slice(0, 8);
  return words.join('-') || 'finding';
}

/** A headline that describes the failure, not the session. */
export function titleFor(finding) {
  const product = finding.products?.[0]?.name;
  const err = (finding.primaryError || '').replace(/\s+/g, ' ').trim();
  const short = err.length > 70 ? `${err.slice(0, 67).trimEnd()}…` : err;
  if (product && short) return `Fixing "${short}" in ${product}`;
  if (short) return `Fixing "${short}"`;
  return 'An environment failure and its fix';
}

/**
 * The checks a human must re-run before this can be published. Each is derived from
 * something the log actually contains, so the list is concrete rather than a generic
 * "please verify". Every item starts UNVERIFIED — that is the whole mechanism.
 */
export function verificationPlan(finding) {
  const plan = [];
  if (finding.primaryError) {
    plan.push({
      claim: 'the error text still matches what the product prints today',
      how: 'reproduce the failure, or find the string in the installed build',
      status: 'UNVERIFIED',
    });
  }
  for (const p of finding.products ?? []) {
    plan.push({ claim: `${p.name} is still the product that fails`, how: `check the installed version of ${p.name}`, status: 'UNVERIFIED' });
  }
  if (finding.versions?.length) {
    plan.push({
      claim: `the observed version(s) ${finding.versions.slice(0, 3).join(', ')} are worth naming`,
      how: 'record the version installed now; say which one you tested',
      status: 'UNVERIFIED',
    });
  }
  for (const cmd of finding.evidence?.probeCommands?.slice(0, 4) ?? []) {
    plan.push({ claim: 'this diagnostic command still works and still helps', how: `re-run: ${cmd}`, status: 'UNVERIFIED' });
  }
  for (const issue of finding.evidence?.externalIssues?.slice(0, 4) ?? []) {
    plan.push({ claim: `${issue} is still open and still relevant`, how: `re-read ${issue}`, status: 'UNVERIFIED' });
  }
  plan.push({
    claim: 'the fix still resolves the failure',
    how: 'the only real test is running it; if you cannot, say so in the post',
    status: 'UNVERIFIED',
  });
  return plan;
}

/** The things a session log can never establish. Pre-filled so the honest section is
 *  never an empty heading the writer has to invent content for. */
export function cannotCheckFromLog(finding) {
  const out = [
    'Whether anyone actually searches for this error. The logs record that it happened, not that anyone else hit it.',
    'Whether the fix still works on the current build. What follows is what worked on the day it was recorded.',
  ];
  if (finding.truncated) {
    out.push('The full session. The transcript was longer than the read limit, so the tail of the work is not represented here.');
  }
  if (!finding.resolution?.some((r) => r.strength === 'strong')) {
    out.push('Whether this was truly resolved. The evidence is a fail-then-pass arc, not anyone saying so.');
  }
  if (finding.evidence?.searchAttempts === 0) {
    out.push('Whether this is already documented elsewhere. No searches were run during the session, so nothing rules that out.');
  }
  return out;
}

/**
 * renderDraft(finding, { config, now, redactor }) -> { path, slug, title, body }
 *
 * The body is Markdown with YAML frontmatter. Everything that came out of a session
 * log is labelled `session-derived`; nothing is presented as verified.
 */
export function renderDraft(finding, { config = {}, now = new Date(), redactor } = {}) {
  const cfg = config.mine?.draft ?? {};
  const dir = cfg.dir ?? 'honestweek.drafts';
  const scrub = (s) => (redactor ? redactor.redact(String(s)) : String(s));

  // The slug is derived from the SCRUBBED error, not the raw one. Scrubbing only the
  // title left the filename carrying a term the denylist exists to hide — and the
  // filename is what becomes the published URL.
  const slug = slugFor({ ...finding, primaryError: scrub(finding.primaryError ?? ''), products: (finding.products ?? []).map((p) => ({ ...p, name: scrub(p.name) })) });
  const title = titleFor(finding);
  const plan = verificationPlan(finding);
  const caveats = cannotCheckFromLog(finding);

  // --- frontmatter ----------------------------------------------------------
  const shape = cfg.frontmatter && typeof cfg.frontmatter === 'object' ? cfg.frontmatter : { title: '', description: '', date: '', tags: [] };
  const lines = ['---'];
  for (const key of Object.keys(shape)) {
    if (VERIFIED_KEY_RE.test(key)) {
      lines.push(`${key}: "" # fill in ONLY after the verification checklist below is complete`);
      continue;
    }
    if (PUBLISH_STATE_KEYS.has(key)) {
      lines.push(`${key}: ${key === 'draft' ? 'true' : 'false'} # a mined draft is never live`);
      continue;
    }
    if (!KNOWN_KEYS.has(key)) {
      // Emitted EMPTY, never with the configured value. The config's frontmatter block
      // is a SCHEMA — a statement of which fields this destination has — and copying
      // its placeholder values into a draft would put unexamined assertions in a
      // document whose premise is that nothing in it has been checked.
      lines.push(`${key}: ${yamlScalar(Array.isArray(shape[key]) ? [] : '')} # yours to fill in`);
      continue;
    }
    if (key === 'title') lines.push(`title: ${yamlScalar(scrub(title))}`);
    else if (key === 'description') lines.push(`description: ${yamlScalar('')} # one sentence, written after you verify`);
    else if (key === 'date') lines.push(`date: ${yamlScalar('')} # set on the day you publish, not the day it was mined`);
    else if (key === 'tags') lines.push(`tags: ${yamlScalar(Array.isArray(shape.tags) && shape.tags.length ? shape.tags : ['bug-fix'])}`);
  }
  // A destination whose schema lists no draft/published field still gets an explicit
  // marker, so a mined file dropped into a content directory cannot read as publishable.
  if (!Object.keys(shape).some((k) => PUBLISH_STATE_KEYS.has(k))) lines.push('draft: true # a mined draft is never live');
  lines.push('---', '');

  // --- body -----------------------------------------------------------------
  const b = [];
  b.push('> **This is an unpublished draft generated from session logs.**');
  b.push('> Nothing below has been re-checked against the software as it is today.');
  b.push('> Work the verification checklist at the bottom, then delete this banner.');
  b.push('');

  if (finding.primaryError) {
    b.push('## The error', '', '```text', scrub(finding.primaryError), '```', '');
    if (finding.alternateErrors?.length) {
      b.push('Related lines from the same session:', '');
      for (const e of finding.alternateErrors.slice(0, 4)) b.push(`- \`${scrub(e)}\``);
      b.push('');
    }
  }

  const productNames = (finding.products ?? []).map((p) => scrub(p.name)).join(', ');
  b.push('## What was involved', '');
  b.push(`- **Software:** ${productNames || '_not identified from the logs — fill this in_'}`);
  b.push(`- **Version(s) seen in the logs:** ${finding.versions?.length ? finding.versions.map(scrub).join(', ') : '_none recorded_'}`);
  b.push(`- **When:** ${finding.startedAt?.slice(0, 10) ?? 'unknown'} _(session-derived)_`);
  b.push(`- **Sessions that hit it:** ${finding.sessionCount ?? 1}`);
  b.push('');

  if (finding.evidence?.probeCommands?.length) {
    b.push('## How it was diagnosed', '');
    b.push('These commands ran during the session. Re-run them before publishing — they are what a reader will copy.', '');
    b.push('```text');
    for (const c of finding.evidence.probeCommands.slice(0, 8)) b.push(scrub(c));
    b.push('```', '');
  }

  // A path the redactor had to scrub is one whose useful part is gone. Listing it
  // gives a reader a `[redacted:secret]` they cannot act on and cannot interpret.
  const usefulPaths = (finding.evidence?.foreignPaths ?? []).map(scrub).filter((p) => !p.includes('[redacted'));
  if (usefulPaths.length) {
    b.push('Files and directories that mattered:', '');
    for (const p of usefulPaths.slice(0, 8)) b.push(`- \`${p}\``);
    b.push('');
  }

  b.push('## The fix', '');
  b.push('_The detector found evidence this was resolved, but a log cannot say what the fix WAS in a form worth publishing. Write it here._', '');
  for (const r of finding.resolution ?? []) {
    b.push(`- Evidence of resolution — **${r.kind}** (${r.strength}): ${scrub(String(r.detail).slice(0, 200))}`);
  }
  b.push('');

  if (finding.evidence?.externalIssues?.length) {
    b.push('## Related bug reports', '');
    for (const i of finding.evidence.externalIssues.slice(0, 8)) b.push(`- ${scrub(i)} — _re-check state before citing_`);
    b.push('');
  }

  b.push('## What I could not check', '');
  for (const c of caveats) b.push(`- ${c}`);
  b.push('');

  b.push('## Verification checklist', '');
  b.push('Every line starts UNVERIFIED on purpose. Publishing with any left unverified means publishing a claim you have not checked.', '');
  // Both halves are scrubbed: a claim line names the product and the issue slug, so
  // redacting only the "how" would leak the very term the denylist exists to hide.
  for (const p of plan) b.push(`- [ ] **${p.status}** — ${scrub(p.claim)}. _How:_ ${scrub(p.how)}`);
  b.push('');

  b.push('---', '');
  b.push(`_Mined from ${finding.corpus ?? 'session'} logs. Score ${finding.score}`);
  b.push(`(${finding.measuredScore} of it from measured signals; the rest from proxies — see the finding record).`);
  b.push('All content above is `session-derived`, not git-verified and not re-tested._');

  return { path: `${dir}/${slug}.md`, slug, title, body: `${lines.join('\n')}${b.join('\n')}\n` };
}
