// lib/ask-brief.mjs: `honestweek brief`, a brief for whoever reviews one pull request, as text or
// the honestweek.brief/1 JSON. lib/ask.mjs runs it like find and replay: the same redacted
// build, through the view data layer's /api/brief route (lib/review/make.mjs). This file holds
// its help, the window it reads by default, and its text, which stays near 80 lines whatever the
// pull request's size: every capped list ends "N more; --json lists them", and no step is
// printed whole.

import { loadConfig } from './config.mjs';
import { isCommitId, isRefName, landedPr, commitRange, defaultBranchRefs, mergeBase, originSlug } from './git.mjs';
import { localDateInTimezone } from './resolve-week.mjs';
import { validTimezone } from './view/own-week.mjs';
import { parseLookup, repoSlug } from './replay/lookup.mjs';
import { replayPage } from './view/page-link.mjs';
import { endLines, minute, quotedLine, said, TEXT_NOTE, windowLine } from './ask-shape.mjs';
import { NOT_A_VERDICT } from './review/make.mjs';

/** The options only brief takes: valued, then bare. */
export const BRIEF_VALUED = ['--head', '--base', '--issue', '--repo'];
export const BRIEF_BARE = ['--evidence-only'];
/** Rows a capped text list shows. */
const SHOW = { prompts: 2, issues: 3, sessions: 6, checks: 5, claims: 5, problems: 3, steppedIn: 3, files: 4, commits: 3 };

export function briefHelp(cmd, windowOptions, aboutOutput) {
  return `honestweek brief: how one pull request was made, for whoever reviews it.

Usage:
  ${cmd} brief <#N | your-repo#N | owner/repo#N | its address | branch:NAME> [options]

It reads your session logs and local git, keeps only the steps that were this
pull request's own work, and lists what was asked, the sessions behind it, the
checks they ran and whether each still holds at its latest commit, each claim
the agent made next to the check behind it (or the gap), weakened tests and
skipped hooks, where you stepped in, changes no session explains, and what it
can't know. It isn't a review and gives no verdict. It runs nothing and reads
nothing over the network, so give it what GitHub knows:

  gh pr view N --json headRefOid,baseRefOid,closingIssuesReferences

By default it reads the pull request's own dates: from 3 days before its first
commit to 2 days after it landed.

${aboutOutput}

Options:
      --head <sha>         The pull request's latest commit, as GitHub has it.
      --base <sha>         The commit it starts from, as GitHub has it.
      --issue <n>          The issue it closes.
      --repo <repo>        The configured repository it's in, by its label or
                           owner/name, when more than one could hold it.
      --evidence-only      Leave the author agent's own words out: no claims.
${windowOptions}
`;
}

const dayOf = (t, tz) => localDateInTimezone(new Date(t), tz).toISOString().slice(0, 10);
const DAY = 86400000;

/**
 * The window a pull request's brief reads when no --days, --from or --to is given: 3 days before
 * its first commit to 2 days after it landed (or today), in the config's timezone. It reads
 * git only for a configured repository that isn't display-only and that the query or --repo
 * names, or the only one configured. null when it can't tell: the usual window applies then.
 */
export function prWindow({ configFile, query, values, now = Date.now() }) {
  let config;
  try {
    config = loadConfig(configFile);
  } catch {
    return null;
  }
  const tz = values['--timezone'] ?? config.week?.timezone ?? 'UTC';
  // A timezone this machine doesn't know: the usual window, whose own check says so.
  if (!validTimezone(tz)) return null;
  const q = parseLookup(query);
  if (q.kind !== 'pr') return null;
  const readable = (config.repos ?? []).filter((r) => r.role !== 'display');
  const pathOf = (r) => r.resolvedPath ?? r.path;
  let repo = null;
  const want = values['--repo'] ? String(values['--repo']).toLowerCase() : null;
  if (want) repo = readable.find((r) => r.label.toLowerCase() === want) ?? readable.find((r) => { const s = repoSlug(originSlug(pathOf(r))); return s && (`${s.owner}/${s.name}` === want || s.name === want); }) ?? null;
  else if (q.repo) repo = readable.find((r) => { const s = repoSlug(originSlug(pathOf(r))); return (s && s.name === q.repo && (!q.owner || s.owner === q.owner)) || r.label.toLowerCase() === q.repo; }) ?? null;
  else if ((config.repos ?? []).length === 1 && readable.length === 1) repo = readable[0];
  let landed = null;
  let byLanding = false;
  if (!repo && !want && !q.repo) {
    // Nothing names the repository: the dates come from the one readable repository where that
    // number landed, if there's exactly one. Any other case reads the usual window.
    const hits = readable.map((r) => ({ r, l: landedPr(pathOf(r), q.number, config.identity?.authorEmails ?? []) })).filter((x) => x.l && !x.l.unreadable);
    if (hits.length === 1) [repo, landed, byLanding] = [hits[0].r, hits[0].l, true];
  }
  if (!repo) return null;
  const path = pathOf(repo);
  landed ??= landedPr(path, q.number, config.identity?.authorEmails ?? []);
  const head = values['--head'] && (isCommitId(values['--head']) || isRefName(values['--head'])) ? values['--head'] : null;
  let first = null;
  let last = null;
  let startUnknown = false;
  if (landed && !landed.unreadable) {
    last = Date.parse(landed.landedISO);
    const range = landed.isMerge ? commitRange(path, landed.parents[0], landed.parents[1]) : null;
    first = Math.min(...[Date.parse(landed.dateISO), ...(range?.commits ?? []).map((c) => Date.parse(c.dateISO))].filter(Number.isFinite));
    // A squash (or a merge whose range git can't read) keeps no trace of when its work started:
    // the window starts from its landing, and runAsk reads further back if no log names its commits.
    startUnknown = !range?.commits?.length;
  } else if (head) {
    const refs = (() => {
      try {
        return defaultBranchRefs(path);
      } catch {
        return [];
      }
    })();
    const base = refs.length ? mergeBase(path, head, refs[0]) : null;
    const range = base ? commitRange(path, base, head) : null;
    const times = (range?.commits ?? []).map((c) => Date.parse(c.dateISO)).filter(Number.isFinite);
    if (times.length) first = Math.min(...times);
    last = now;
  }
  if (!Number.isFinite(first)) return null;
  return { from: dayOf(first - 3 * DAY, tz), to: dayOf(Math.min(now, (last ?? now) + 2 * DAY), tz), ...(byLanding ? { landedIn: repo.label } : {}), ...(startUnknown ? { startUnknown: true, landedAt: last } : {}) };
}

// ---- text -----------------------------------------------------------------------------------

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : null);
const how = (x) => [x?.evidence, x?.rule].filter(Boolean).join(', ');
/** A commit or file list git couldn't read: its count is unknown, not zero. */
const unknownList = (l) => l.evidence === 'missing' && !l.total;
const more = (lines, total, shown, indent = '  ') => {
  if (total > shown) lines.push(`${indent}${total - shown} more; --json lists them.`);
};
const VIA = { given: 'you gave it', 'merge-parent': "the merge commit's second parent", 'same-tree': 'the logged commit with exactly the files that landed', 'last-push': 'the last commit pushed before it landed', 'local-branch': "this machine's copy of its branch", printed: 'the head gh printed in a session', 'squash-parent': "the squash commit's parent", 'merge-first-parent': "the merge commit's first parent", 'merge-base': 'where its branch left the default branch' };
const CURRENCY = { edit: 'stale: an edit to its files came after it', commit: 'stale: a commit nobody tested came after it', 'none-seen': 'current as far as the logs show' };
const FOLDER = { 'on-branch': 'on its branch', 'default-branch': 'in a folder on the default branch', 'other-branch': 'in a folder on another branch', unknown: 'in a folder the logs don\'t place' };
const GAP = { quiet: 'no check after the last edit', 'hooks-unlogged': 'no check after the last edit that the log can show', 'other-steps': 'no check after the last edit', 'other-folder': 'its only check ran in another folder', ambiguous: "on the edge of another pull request's work", 'no-ci-read': 'no step read CI before it', 'not-in-scope': "the step that opened it isn't in scope", 'commit-not-logged': 'no logged step made this commit', 'ambiguous-edit': "its last edit sits on the edge of another pull request's work, and no check came after it", 'ci-read-stale': 'a step read CI before it, but an edit, commit or push came after that read' };
const KIND = { done: 'done', 'tests-pass': 'tests pass', 'ci-green': 'CI is green' };

function backingText(b) {
  if (b.status === 'checked') return `${b.failed === true ? 'a check before it failed' : `backed by a check (${b.result ?? 'no result recorded'})`}${b.folder === 'unknown' ? ', run in a folder the logs don\'t place' : ''}`;
  if (b.status === 'delegated') return 'a sub-agent ran after the last edit and may have checked';
  if (b.status === 'ci-read') return b.failed ? 'the last CI read before it ended in an error or was stopped' : 'a step read CI before it; what it printed is not checked here';
  return GAP[b.gap] ?? 'no check';
}

/** The brief as text. `o` is the command's JSON answer. */
export function briefText(o, cmd) {
  const tz = o.window.timezone;
  const lines = [];
  const c = o.change;
  const repo = c.repo.slug ?? c.repo.label;
  lines.push(`honestweek brief: pull request #${o.pr.number ?? '?'} in ${repo}, ${windowLine(o.window, o.demo)}.`, NOT_A_VERDICT, TEXT_NOTE);
  if (o.pr.display) {
    lines.push('', `${c.repo.label} is display-only, so honestweek never reads it with git or reads its sessions. There's nothing to brief.`);
    lines.push('', "What this brief can't know", ...o.cantKnow.items.map((x) => `  - ${x.text}`));
    return `${lines.join('\n')}\n`;
  }

  lines.push('', 'The change');
  const head = c.head.sha ? `${short(c.head.sha)} (${how(c.head)}: ${VIA[c.head.via] ?? c.head.via})` : `unknown (${c.head.evidence}${c.head.hint ? `; run ${c.head.hint}` : ''})`;
  const base = c.base.sha ? `${short(c.base.sha)} (${how(c.base)}: ${VIA[c.base.via] ?? c.base.via})` : `unknown (${c.base.evidence})`;
  lines.push(`  Latest commit ${head}. Starts from ${base}.`);
  if (c.landed) lines.push(`  Landed ${minute(c.landed.at, tz)} as a ${c.landed.kind}, ${short(c.landed.sha)} (${how(c.landed)}).`);
  const branch = c.branch.name ? `${said({ quoted: c.branch.name })} (${c.branch.evidence}, ${c.branch.sources.length} source(s) agree)` : c.branch.ambiguous ? `ambiguous: ${c.branch.sources.map((s) => said({ quoted: s.name })).join(', ')} (none picked)` : 'unknown (missing)';
  lines.push(`  Branch ${branch}.`);
  // A list git couldn't read is an unknown count, never zero.
  const count = (l, noun) => (unknownList(l) ?`${noun}s unknown (missing)` : `${l.total} ${noun}(s) (${l.evidence})`);
  lines.push(`  ${count(c.commits, 'commit')}${c.commits.truncated ? ', cut at 500' : ''}, ${count(c.files, 'file')}.`);
  if (o.pr.repo?.chosenBy === 'landed') lines.push(`  ${repo} is the only readable repository where git shows #${o.pr.number} landed, so it's the one read (inferred). Name another with --repo.`);
  for (const n of o.notes.items) lines.push(`  ${n.text}`);

  lines.push('', 'What was asked');
  if (!o.asked.issues.total) lines.push(o.notes.items.some((n) => n.kind === 'messages-cut') ? '  No issue it closes is named in its pull-request body, its landing commit or the commit messages read, and not all of them were read.' : '  No issue it closes is named in its pull-request body, commits or landing commit.');
  for (const i of o.asked.issues.items.slice(0, SHOW.issues)) {
    lines.push(`  Issue #${i.number}, which it closes (${how(i)}). ${i.text ? `Its text, as a session printed it (${i.textEvidence}, ${i.textRule}):` : 'No session printed its text (missing).'}`);
    if (i.text) lines.push(quotedLine(i.text, '    '));
  }
  more(lines, o.asked.issues.total, Math.min(SHOW.issues, o.asked.issues.total));
  if (o.asked.related.total) lines.push(`  Named but not closed, so only related: ${o.asked.related.items.map((x) => `#${x.number}`).join(', ')} (inferred, brief.issue-mentioned).`);
  lines.push(`  Your prompts in its steps: ${o.asked.prompts.total} (inferred, from which steps are its own).`);
  for (const p of o.asked.prompts.items.slice(0, SHOW.prompts)) lines.push(quotedLine(p.text, '    '));
  more(lines, o.asked.prompts.total, Math.min(SHOW.prompts, o.asked.prompts.total), '    ');

  lines.push('', 'Sessions behind it');
  for (const s of o.sessions.items.slice(0, SHOW.sessions)) {
    const others = s.otherPrs.length ? `; the rest were ${s.otherPrs.map((n) => `#${n}`).join(', ')}${s.lanes.some((l) => !/^pull request #/.test(l.lane)) ? ' and other work' : ''}` : '';
    lines.push(`  ${s.session}  ${s.role} (${s.roleEvidence}, ${s.roleRule})  ${said(s.title) ?? '(untitled)'}: ${s.steps} steps, ${s.inScope} this pull request's, ${s.ambiguous} ambiguous${others}.`);
  }
  more(lines, o.sessions.total, Math.min(SHOW.sessions, o.sessions.total));
  if (!o.sessions.total) lines.push('  No session in this window worked on it.');

  lines.push('', `Checks its steps ran: ${o.checks.total}`);
  for (const k of o.checks.items.slice(-SHOW.checks)) lines.push(`  ${minute(k.at, tz)}  ${k.kind}, ${k.result ?? 'no result'} (${how(k) || 'recorded'}), ${FOLDER[k.folder]}, ${CURRENCY[k.currency.why] ?? k.currency.state} (${k.currency.evidence})  step ${k.event}`);
  if (o.checks.total > SHOW.checks) lines.push(`  ${o.checks.total - SHOW.checks} earlier; --json lists them.`);
  lines.push(`  Run these yourself, at its latest commit: ${o.rerun.total ? o.rerun.items.map((r) => said(r.command)).join(', ') : 'none of its checks is a plain command'}.`);
  if (o.readFirst.total) lines.push(`  Read before running: ${o.readFirst.total} other check command(s) chain, redirect or run code; --json lists them.`);

  if (o.claims) {
    // Backed only by a check that ran and didn't fail: a CI read, a sub-agent or a failed check isn't.
    const gaps = o.claims.items.filter((x) => !(x.backing.status === 'checked' && x.backing.failed !== true)).length;
    lines.push('', `Claims to check, unbacked first: ${o.claims.total} (${gaps} with no check behind them that didn't fail)`);
    for (const x of o.claims.items.slice(0, SHOW.claims)) {
      lines.push(`  ${minute(x.at, tz)}  ${x.source}, "${KIND[x.kind]}" (${x.strength}, ${x.rule}): ${backingText(x.backing)} (${x.backing.level})${x.event ? `  step ${x.event}` : x.sha ? `  commit ${short(x.sha)}` : ''}`);
      lines.push(quotedLine(x.text, '    ', 160));
    }
    more(lines, o.claims.total, Math.min(SHOW.claims, o.claims.total));
  } else lines.push('', "Claims to check: left out (--evidence-only). The author's words aren't shown.");

  const t = o.tests;
  lines.push('', 'Tests and hooks');
  lines.push(`  Test files changed: ${t.files.total}${t.files.total ? ` (${t.files.items.slice(0, SHOW.files).map((f) => `${f.path} ${f.status}`).join(', ')}${t.files.total > SHOW.files ? `, ${t.files.total - SHOW.files} more; --json lists them` : ''})` : ''}.${t.assertions ? ` Changed lines in their diff (${[t.diffEvidence, t.diffRule].filter(Boolean).join(', ')}${t.diffCut ? ', cut' : ''}): assertion lines +${t.assertions.added} -${t.assertions.removed}, skip lines +${t.skips.added} -${t.skips.removed}.` : ''}`);
  lines.push(`  Tests weakened, skipped or excluded (findings): ${t.tampering.total}. Commits that skipped hooks (--no-verify): ${t.noVerify.total}. Force-pushes: ${t.forcePush.total}.`);

  const p = o.problems;
  lines.push('', `Other problems in its steps: ${p.ran ? `${p.listed.total} worth a look` : "the Problems checks couldn't run"}`);
  for (const f of p.listed.items.slice(0, SHOW.problems)) lines.push(`  ${minute(f.at, tz)}  ${f.name} (${f.evidence})${f.related && !f.related.inScope ? `; its other step is ${f.related.lane ?? 'outside these steps'}` : ''}  step ${f.event}`);
  more(lines, p.listed.total, Math.min(SHOW.problems, p.listed.total));
  if (p.ran) lines.push(`  Left out: ${p.leftOut.otherWork} in other pull requests' or other work, ${p.leftOut.cost} cost, ${p.leftOut.notes} routine notes, ${p.leftOut.otherPatterns} other patterns (--json lists them).`);

  lines.push('', `Where you stepped in: ${o.steppedIn.total}`);
  for (const s of o.steppedIn.items.slice(0, SHOW.steppedIn)) lines.push(`  ${minute(s.at, tz)}  ${s.kind} (${how(s)})  step ${s.event}`);
  more(lines, o.steppedIn.total, Math.min(SHOW.steppedIn, o.steppedIn.total));

  const u = o.unexplained;
  lines.push('', 'Changes no session explains (missing)');
  lines.push(`  Commits no session made or printed: ${unknownList(c.commits) ? "unknown, since its commits aren't known" : u.commits.total ? u.commits.items.slice(0, SHOW.commits).map((x) => short(x.sha)).join(', ') + (u.commits.total > SHOW.commits ? `, ${u.commits.total - SHOW.commits} more; --json lists them` : '') : 'none'}.`);
  lines.push(`  Files no edit in its steps touched: ${unknownList(c.files) ? "unknown, since its files aren't known" : `${u.files.total}${u.files.total ? ` (${u.files.items.slice(0, SHOW.files).map((f) => f.path).join(', ')}${u.files.total > SHOW.files ? `, ${u.files.total - SHOW.files} more; --json lists them` : ''})` : ''}`}. ${u.note}`);

  lines.push('', "What this brief can't know");
  for (const x of o.cantKnow.items) lines.push(`  - ${x.text}`);

  const lead = o.sessions.items.find((s) => s.role === 'author') ?? o.sessions.items[0];
  const firstClaim = o.claims?.items.find((x) => x.session === lead?.session && x.at);
  endLines(lines, o, cmd, lead ? replayPage({ session: lead.session, thread: lead.thread ?? undefined }) : null, lead ? `${cmd} replay ${lead.session}${firstClaim ? ` --at ${firstClaim.at}` : ''}` : null);
  return `${lines.join('\n')}\n`;
}
