// lib/ask-waiting.mjs: `honestweek waiting`, what's waiting on you, as the find, replay and
// problems commands answer (lib/ask.mjs): from the page's redacted build, as JSON or text.
//
// The JSON is the stable shape `honestweek.waiting/1`, for anything that wants to show the list
// elsewhere (a status page, a morning summary): one row per thing waiting, each with its kind,
// rule, evidence word, session, title, age, the words it asked for and its page. Text copied from
// the logs is marked `{ "quoted": ... }`, as every ask command marks it.
//
// Zero runtime dependencies: Node built-ins only.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { appSessionsRoot, readAppSessions } from './app-sessions.mjs';
import { quote, said, quotedLine, TEXT_NOTE, windowLine, endLines } from './ask-shape.mjs';
import { KIND_ORDER, readPrsFile, STALE_HOURS, WAITING_LIMITS, WAITING_RULES, WAITING_SCHEMA } from './waiting.mjs';

export { WAITING_SCHEMA };
/** The window waiting reads when none is given. */
export const WAITING_DAYS = 7;
/** How many rows the text answer shows, so it stays under 60 lines; --json lists them all. */
export const WAITING_TEXT_ROWS = 12;

const KIND_WORDS = { ask: 'Asks', stalled: 'Stalled', pr: 'Pull requests', unpushed: 'Unpushed commits' };
const NOTE_WORDS = {
  'archived-sessions-left-out': (n) => `${n.count} session(s) you archived in the desktop app left out.`,
  'sessions-not-in-sidebar-left-out': (n) => `${n.count} Claude Code session(s) the desktop app doesn't list (background or terminal ones) left out; --all keeps them.`,
  'prs-not-checked': (n) => `${n.count} pull request(s) in a display-only repository, a folder outside your config or one git couldn't read weren't checked: git can't read their repository, and no --prs file lists them.`,
  'git-unreadable': (n) => `git couldn't say which branches hold commit ${n.sha} in ${n.repo}.`,
};

/**
 * answerWaiting(data, values, flags, { cwd, env, demo, now, windowTo, fail }) -> the answer's own fields
 * `fail(message)` makes the error the command prints.
 */
export function answerWaiting(data, values, flags, { cwd = process.cwd(), env = process.env, demo = false, now = Date.now(), windowTo = null, fail }) {
  let quietHours = STALE_HOURS;
  if (values['--quiet-hours'] !== undefined) {
    const v = values['--quiet-hours'];
    if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(v) || Number(v) <= 0 || Number(v) > 8760) throw fail(`--quiet-hours must be a number of hours above 0, up to 8760 (got ${JSON.stringify(v)}).`);
    quietHours = Number(v);
  }
  let prs = null;
  if (values['--prs'] !== undefined) {
    const path = isAbsolute(values['--prs']) ? values['--prs'] : resolve(cwd, values['--prs']);
    let text;
    let at;
    try {
      text = readFileSync(path, 'utf8');
      at = statSync(path).mtime.toISOString();
    } catch {
      throw fail(`the --prs file couldn't be read: ${values['--prs']}.`);
    }
    try {
      prs = readPrsFile(text, at);
    } catch (err) {
      throw fail(err.message);
    }
  }
  // The made-up week has no desktop app: only its own logs, never this machine's app files.
  const app = demo ? new Map() : readAppSessions(appSessionsRoot(env));
  // The made-up week is long past: its ages count from the end of its last day.
  const at = demo && windowTo ? Date.parse(`${windowTo}T23:59:59.999Z`) : now;
  const w = data.waiting({ now: at, staleMs: quietHours * 3600000, promises: flags.has('--promises'), all: flags.has('--all'), prs, app });
  if (!w) throw fail("the logs weren't read, so there's nothing to list.");
  const used = [...new Set(w.rows.map((r) => r.rule))];
  return {
    schema: WAITING_SCHEMA,
    quietHours,
    promises: flags.has('--promises'),
    prsFile: prs ? { at: prs.at, rows: prs.rows.length } : null,
    counts: w.counts,
    rows: w.rows.map(rowOut),
    notes: w.notes,
    rules: Object.fromEntries(used.map((k) => [k, WAITING_RULES[k]])),
    limits: WAITING_LIMITS,
  };
}

function rowOut(r) {
  return {
    kind: r.kind,
    rule: r.rule,
    evidence: r.evidence,
    session: r.session,
    thread: r.thread,
    tool: r.tool,
    repo: r.repo,
    group: r.group,
    title: quote(r.title),
    titleFrom: r.titleFrom,
    sidebar: r.sidebar,
    at: r.at,
    ageHours: r.ageHours,
    form: r.form ?? null,
    asked: r.asked.map((w) => quote(w)),
    quote: quote(r.quote),
    page: r.page,
    ...(r.settled ? { settled: r.settled } : {}),
    ...(r.pr ? { pr: r.pr } : {}),
    ...(r.commit ? { commit: { ...r.commit, subject: quote(r.commit.subject), branches: r.commit.branches.map((b) => quote(b)) } } : {}),
  };
}

const age = (h) => (h == null ? 'age unknown' : h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const where = (r) => r.repo ?? (r.group === 'outside' ? 'outside your config' : r.group);

function headOf(r) {
  const title = said(r.title) ?? '(untitled)';
  const what = r.kind === 'ask'
    ? r.asked.length ? `asks for ${r.asked.map((w) => `\`${w.quoted}\``).join(', ')}` : r.form === 'question' ? 'asks a question' : r.rule === 'waiting.question-tool' ? 'asked through its question tool' : 'says something is waiting on you'
    : r.kind === 'stalled' ? r.rule === 'waiting.unanswered-prompt' ? 'never answered your last message' : r.rule === 'waiting.cut-off' ? 'stopped mid-step' : 'said what it would do next, then went quiet'
    : r.kind === 'pr' ? `pull request ${r.pr.repo}#${r.pr.number} ${r.pr.state === 'open' ? 'open' : 'last seen open'}, no session since`
    : `commit ${r.commit.sha} on ${r.commit.branches.map((b) => b.quoted).join(', ')} not pushed`;
  const settled = r.settled ? `; it names pull request ${r.settled.pr.repo}#${r.settled.pr.number}, ${r.settled.pr.state === 'CLOSED' ? 'closed' : 'merged'} since (${r.settled.pr.from === 'git' ? 'git' : 'the --prs file'}), so it may be answered` : '';
  return `  ${age(r.ageHours).padStart(4)}  ${title}  (${where(r)}, ${r.evidence}): ${what}${settled}`;
}

/** The text form: a count line, then each kind's rows, worst first, under 60 lines. */
export function waitingText(o, cmd) {
  const total = o.rows.length;
  const lines = [`honestweek waiting: ${total ? `${total} thing(s) waiting on you` : 'nothing found waiting on you'} (${KIND_ORDER.map((k) => `${o.counts[k]} ${k}`).join(', ')}); ${windowLine(o.window, o.demo)}.`, TEXT_NOTE];
  let shown = 0;
  let kind = null;
  for (const r of o.rows) {
    if (shown >= WAITING_TEXT_ROWS) break;
    if (r.kind !== kind) {
      kind = r.kind;
      lines.push('', `${KIND_WORDS[kind]}:`);
    }
    lines.push(headOf(r));
    const q = quotedLine(r.quote, '        ', 160);
    if (q) lines.push(q);
    if (r.page) lines.push(`        page ${r.page}`);
    shown += 1;
  }
  if (total > shown) lines.push('', `${total - shown} more; --json lists them.`);
  const notes = o.notes.map((n) => NOTE_WORDS[n.kind]?.(n)).filter(Boolean);
  if (o.prsFile) notes.push(`Pull request states from the --prs file written ${o.prsFile.at}.`);
  else if (o.counts.pr) notes.push('No --prs file, so a pull request is "last seen open": it may have closed since.');
  if (!o.promises) notes.push('Sessions that promised a next step and went quiet aren\'t listed; --promises adds them.');
  if (notes.length) lines.push('', ...notes);
  const first = o.rows[0];
  endLines(lines, o, cmd, first?.page ?? null, first ? `${cmd} replay ${first.session}${first.at ? ` --at ${first.at}` : ''}` : null);
  return `${lines.join('\n')}\n`;
}
