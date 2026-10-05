// lib/problems/scope.mjs: what each problem finding looks like on a timeline, worked out from
// the finding and the history it was found in. It never changes what a check detects: it reads
// a finding's check, its recorded steps, its kind and times, and the history's own records
// (prompts, agents, token counts), and says how Replay should frame it.
//
// Every check's findings are one kind of thing on a timeline (SCOPE_KINDS):
//   moment    a step or a few: the evidence steps, first to last, and your prompt before them,
//             so you can see whether you asked for it
//   stretch   a stretch of work: from where it started to where it ended, shaded, the start marked
//   repeat    the same thing again and again: first to last repetition, each numbered
//   hand-off  a helper's work handed back: from the helper starting to its parent carrying on,
//             with the gap where no hand-back is recorded
//   turn-end  how a turn ended: its last message (or last record) and your next prompt
// A check with no kind here keeps the plain zoom (its recorded steps with a small margin), and
// scopeOf answers null for it.
//
// A scope: { kind, steps, from, to, stretch, gap, anchor, prompt, next, message, helper, parent,
// caption, level }
//   steps    the finding's own recorded steps, in time order: the ones Replay rings
//   from, to the frame, as times in milliseconds
//   stretch  { from, to, agent }, the shaded stretch, or null
//   gap      { from, to }: where no hand-back is recorded (hand-off) or the wait for your next
//            prompt (turn-end), or null
//   anchor   the key step
//   prompt   your prompt before the steps (moment); next, your next prompt (turn-end); message,
//            the turn's last message when it isn't the step itself (turn-end); helper, the
//            helper's last record, and parent, the parent's next record (hand-off). Each is an
//            event id or null, and none of them is a step the check matched.
//   caption  one plain line built from fixed words and numbers the finding or the log records
//   level    how the caption is known: the finding's own level, never stronger than derived,
//            since the caption counts or measures what it says

import { fmt, fmtDur, plural } from './checks.mjs';
import { isExecInstruction, isPersonPrompt, THRESHOLDS } from './context.mjs';

/** Each check's kind, and why: the table docs/local-page.md shows. */
export const SCOPE_KINDS = Object.freeze({
  'unverified-done-claim': { kind: 'moment', why: 'The edits and the claim are a few steps in one turn; the prompt that opened the turn shows whether a check was asked for.' },
  'pr-landed-without-tests': { kind: 'moment', why: "One record, the pull request landing; the prompt before it shows what the session was asked to do." },
  'claim-contradicts-evidence': { kind: 'moment', why: 'The failed check and the claim after it are two steps in one turn, read with the prompt that opened it.' },
  'commit-after-failed-test': { kind: 'moment', why: 'The failed run and the commit or merge after it are a few steps, read with the prompt before them.' },
  'test-tampering': { kind: 'moment', why: 'The test edits are a few steps in one turn; the prompt before them shows whether the change was asked for.' },
  'action-loop': { kind: 'repeat', why: 'The same call again and again: each repetition is numbered.' },
  'repeated-tool-error': { kind: 'repeat', why: 'The same error again and again: each failed call is numbered.' },
  'subagent-overuse': { kind: 'repeat', why: 'Several small or near-identical helpers started: each start is numbered.' },
  'subagent-no-report': { kind: 'hand-off', why: 'A helper started and no hand-back is recorded: from the start to the parent carrying on, with the gap marked.' },
  'long-sessions': { kind: 'stretch', why: 'The problem is everything after the context passed the threshold, not the one step where it did.' },
  're-reads': { kind: 'repeat', why: 'The same file and range read again and again: each read is numbered.' },
  polling: { kind: 'repeat', why: 'The same status call again and again: each call is numbered.' },
  'context-additions': { kind: 'moment', why: 'One step whose result was large; the prompt before it shows what was asked for.' },
  'scope-creep': { kind: 'moment', why: 'A question and the edits after it are a few steps in one turn; the question is the prompt before them.' },
  'outside-edits': { kind: 'moment', why: 'A few edits; the prompt before them shows whether the place was asked for.' },
  'plan-mode-edit': { kind: 'moment', why: 'A few edits made in plan mode; the prompt before them shows what was asked for.' },
  'session-ended-mid-step': { kind: 'turn-end', why: "How the session's last turn ended: its last message (or the prompt that opened it, when the agent wrote none) to its last record, with nothing after." },
  'needless-check-in': { kind: 'turn-end', why: 'A turn that ended on a question, and the next prompt answering it, with the wait between.' },
  'risky-command': { kind: 'moment', why: 'One command; the prompt before it shows whether it was asked for.' },
  'secret-in-log': { kind: 'repeat', why: 'Secret-shaped text on several steps of one kind: each step is numbered.' },
});

const LEVEL_RANK = { recorded: 0, derived: 1, inferred: 2, missing: 3 };
/** The weaker of a finding's level and derived: a caption counts or measures, so it's never recorded. */
const captionLevel = (level) => (LEVEL_RANK[level] > LEVEL_RANK.derived ? level : 'derived');
const HOUSEKEEPING = new Set(['link', 'mode', 'quiet', 'queue', 'hook']);
const isOpener = (e) => isPersonPrompt(e) || isExecInstruction(e);
const ms = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);
/** When step `e` ends: its recorded result, never past its session's last record (a result a
 *  resumed copy recorded days later, in another session's file, doesn't stretch a frame). */
const endIn = (idx, e) => {
  const end = Number.isFinite(e?.end?.t) ? Math.max(e.t, e.end.t) : e.t;
  const last = ms(idx.sessions.get(e.session)?.lastAt);
  return Number.isFinite(last) ? Math.min(end, Math.max(e.t, last)) : end;
};

/** How a session's last work record reads, in the same words as its check's note. */
const END_WORDS = {
  'last-record-is-an-interruption': 'an interruption',
  'last-record-is-error': 'an error',
  'last-record-is-a-call-without-result': 'a tool call with no recorded result',
  'last-record-is-an-unanswered-prompt': 'a prompt with no reply after it',
  'last-record-is-action': 'a step with a result, and no turn end after it',
  'last-record-is-message': 'an agent message, and no turn end after it',
};
/** Where secret-shaped text was, one and many, for the places its check names. */
const SECRET_PLACES = {
  'your prompt': ['your prompt', 'your prompts'],
  'tool-call input': ['a tool-call input', 'tool-call inputs'],
  'agent message': ['an agent message', 'agent messages'],
  'codex exec instruction': ['a codex exec instruction', 'codex exec instructions'],
};
/** What a risky command reads as, in the same words as its check's note. */
const RISKY_WORDS = {
  'force-push': 'a force-push',
  'force-with-lease': 'a force-push with lease',
  'skip-checks': 'skipping git hooks',
  'hard-reset': 'a hard reset',
  revert: 'discarding or reversing work',
  'git-clean': 'git clean',
  'branch-delete': 'force-deleting a branch',
  'recursive-delete': 'a recursive delete',
};

/**
 * historyIndex(h) -> what scopeOf reads from an engine history, built once per history: every
 * event by id and its place in the engine's order, the events of each session and each agent in
 * that order, each helper by the call that started it, each session, the window, and the model
 * calls the history recorded. An empty or partial history gives an empty index.
 */
export function historyIndex(h) {
  const events = Array.isArray(h?.events) ? h.events : [];
  const byId = new Map();
  const seq = new Map();
  const bySession = new Map();
  const byAgent = new Map();
  const push = (m, k, e) => (m.get(k) ?? m.set(k, []).get(k)).push(e);
  events.forEach((e, i) => {
    if (!e || typeof e.id !== 'string' || !Number.isFinite(e.t)) return;
    byId.set(e.id, e);
    seq.set(e.id, i);
    push(bySession, e.session, e);
    if (e.agent) push(byAgent, e.agent, e);
  });
  const bySpawn = new Map((Array.isArray(h?.agents) ? h.agents : []).filter((a) => a?.spawnedBy).map((a) => [a.spawnedBy, a]));
  const sessions = new Map((Array.isArray(h?.sessions) ? h.sessions : []).map((s) => [s.key, s]));
  return { byId, seq, bySession, byAgent, bySpawn, sessions, window: h?.window ?? {}, calls: Array.isArray(h?.usage?.calls) ? h.usage.calls : [], callsByAgent: null };
}

/** An agent's model calls in the window, in the order the token checks read them (context.mjs
 *  joinUsage): by source file, then line. Each is { t, ctx }. */
function windowCalls(idx, agent) {
  if (!idx.callsByAgent) {
    idx.callsByAgent = new Map();
    for (const c of idx.calls) (idx.callsByAgent.get(c.agent) ?? idx.callsByAgent.set(c.agent, []).get(c.agent)).push(c);
    for (const list of idx.callsByAgent.values()) list.sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : (x.lines?.[0] ?? 0) - (y.lines?.[0] ?? 0)));
  }
  const { startT, endT } = idx.window;
  const inWin = (t) => Number.isFinite(t) && t >= startT && t < endT;
  return (idx.callsByAgent.get(agent) ?? []).filter((c) => inWin(c.t)).map((c) => ({ t: c.t, ctx: (c.input ?? 0) + (c.cacheWrite ?? 0) + (c.cacheRead ?? 0) }));
}

/** The finding's own recorded steps the history holds (its `events`, `event` and `related`), in
 *  time order, then the engine's order. */
function evidenceOf(f, idx) {
  const ids = [...new Set([...(Array.isArray(f.events) ? f.events : []), f.event, f.related].filter((x) => typeof x === 'string'))];
  return ids.map((id) => idx.byId.get(id)).filter(Boolean).sort((a, b) => a.t - b.t || idx.seq.get(a.id) - idx.seq.get(b.id));
}

/** Where event `e` sits in its session's list, in the engine's order. */
function placeIn(idx, e) {
  const list = idx.bySession.get(e.session) ?? [];
  return { list, i: list.indexOf(e) };
}

/** The prompt that opened the work before `e` in its session: a prompt you typed, or a codex exec
 *  run's instruction. `e` itself when it is one. */
function promptBefore(idx, e) {
  if (isOpener(e)) return e;
  const { list, i } = placeIn(idx, e);
  for (let j = i - 1; j >= 0; j--) if (isOpener(list[j])) return list[j];
  return null;
}

/** Your next prompt after `e` in its session. */
function promptAfter(idx, e) {
  const { list, i } = placeIn(idx, e);
  if (i < 0) return null;
  for (let j = i + 1; j < list.length; j++) if (isPersonPrompt(list[j])) return list[j];
  return null;
}

/** The main agent's last message at or before `e`, inside the turn `e` is in. */
function turnMessage(idx, e) {
  const main = `${e.session}:main`;
  const { list, i } = placeIn(idx, e);
  for (let j = i; j >= 0; j--) {
    const x = list[j];
    if (j < i && isOpener(x)) return null;
    if (x.kind === 'message' && x.agent === main) return x;
  }
  return null;
}

const blank = { stretch: null, gap: null, prompt: null, next: null, message: null, helper: null, parent: null };

/** A step-count word from the finding: how many it matched, else how many it recorded. */
const countOf = (f, steps) => (Number.isFinite(f.steps) ? f.steps : steps.length);

/** The caption for a finding of `check`, from fixed words and the numbers the finding or the log
 *  records. */
function captionFor(f, steps, idx, extra = {}) {
  const n = countOf(f, steps);
  switch (f.check) {
    case 'unverified-done-claim': {
      const edits = Math.max(0, n - 1);
      return `${plural(edits, 'successful edit')}, then a completion claim, with no check after the last edit`;
    }
    case 'pr-landed-without-tests':
      return 'A pull request landed here, and none of its sessions in this window recorded a test run';
    case 'claim-contradicts-evidence': {
      const run = f.related ? idx.byId.get(f.related) : null;
      const t = run?.derived?.tests;
      const counts = t && Number.isFinite(t.fail) ? ` (${t.fail} failed, ${t.pass ?? 0} passed)` : '';
      return f.kind === 'calls the failure pre-existing'
        ? `A test run failed${counts}, then the last message calls the failure pre-existing or unrelated`
        : `A check failed${counts}, then the last message claims success`;
    }
    case 'commit-after-failed-test': {
      const run = f.related ? idx.byId.get(f.related) : null;
      const t = run?.derived?.tests;
      const counts = t && Number.isFinite(t.fail) ? ` (${t.fail} failed, ${t.pass ?? 0} passed)` : '';
      const more = Number.isFinite(f.steps) ? f.steps - 2 : 0;
      return `A test run failed${counts}, then a commit or merge with no passing run between${more > 0 ? `, and ${plural(more, 'more commit or merge step')} before any run passed` : ''}`;
    }
    case 'test-tampering':
      return n === 1 ? 'A step that weakens, skips or excludes tests' : `${n} steps in one turn that weaken, skip or exclude tests`;
    case 'action-loop':
      if (f.kind === 'edit undone and redone') return 'An edit made, undone with the exact reverse, and made again';
      if (f.kind === 'failed command run again unchanged') return `The same failing command ran ${n} times, with no edit between`;
      return `The same call ran ${n} times, with nothing changed between`;
    case 'repeated-tool-error':
      return f.kind === 'failed edits' ? `${n} failed edits to one file in a row` : `The same error ${n} times in a row`;
    case 'subagent-overuse':
      if (f.kind === 'near-identical briefs') return `${n} helpers started in one turn with near-identical briefs`;
      return n === 1 ? `A helper with ${THRESHOLDS.smallSubagentCalls} or fewer tool calls` : `${n} helpers with ${THRESHOLDS.smallSubagentCalls} or fewer tool calls each`;
    case 'subagent-no-report': {
      const { spawn, last } = extra;
      const later = spawn && last ? `; its last record came ${fmtDur(last.t - spawn.t)} later` : '';
      return `A helper started here${later}, and no hand-back is recorded`;
    }
    case 'long-sessions':
      return extra.after != null ? `Passed ${fmt(THRESHOLDS.longCtx)} tokens of context here, then ${plural(extra.after, 'more model call')}` : `Passed ${fmt(THRESHOLDS.longCtx)} tokens of context here`;
    case 're-reads':
      return `The same file and range read ${n} times, with no change between`;
    case 'polling': {
      const span = ms(f.lastAt) - ms(f.at);
      return `The same status call ${n} times${Number.isFinite(span) && span > 0 ? ` over ${fmtDur(span)}` : ''}, with nothing changed between`;
    }
    case 'context-additions':
      return Number.isFinite(f.estimate) && f.estimate > 0 ? `This result was re-read by later model calls: about ${fmt(f.estimate)} tokens in all` : 'This result was re-read by later model calls';
    case 'scope-creep':
      return `Your prompt read as a question, and ${plural(n, 'edit')} followed`;
    case 'outside-edits':
      return `${plural(n, 'edit')} outside the folder the session started in`;
    case 'plan-mode-edit':
      return `${plural(n, 'edit')} while plan mode was on`;
    case 'session-ended-mid-step':
      return `The session's last work record is ${END_WORDS[f.kind] ?? 'not a turn end'}`;
    case 'needless-check-in': {
      const { msg, next } = extra;
      return msg && next ? `The turn ended on a question, and your go-ahead came ${fmtDur(next.t - endIn(idx, msg))} later` : 'The turn ended on a question, answered by a bare go-ahead';
    }
    case 'risky-command': {
      const words = String(f.kind ?? '').split(' ').map((k) => RISKY_WORDS[k]).filter(Boolean);
      return `A command that reads as ${words.length ? words.join(' and ') : 'a risky command'} ran`;
    }
    case 'secret-in-log': {
      const [one, many] = SECRET_PLACES[f.kind] ?? ['a step', 'steps'];
      return n === 1 ? `Secret-shaped text in ${one}` : `Secret-shaped text in ${many}, on ${n} steps`;
    }
    default:
      return null;
  }
}

function moment(f, steps, idx) {
  const first = steps[0];
  const prompt = promptBefore(idx, first);
  return {
    ...blank,
    from: Math.min(prompt?.t ?? first.t, first.t),
    to: Math.max(...steps.map((e) => endIn(idx, e))),
    anchor: steps.some((e) => e.id === f.event) ? f.event : first.id,
    prompt: prompt?.id ?? null,
    caption: captionFor(f, steps, idx),
  };
}

function repeat(f, steps, idx) {
  return { ...blank, from: steps[0].t, to: Math.max(...steps.map((e) => endIn(idx, e))), anchor: steps[0].id, caption: captionFor(f, steps, idx) };
}

function stretch(f, steps, idx) {
  const anchor = idx.byId.get(f.event) ?? steps[0];
  const start = ms(f.at);
  const end = ms(f.lastAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  let after = null;
  if (f.check === 'long-sessions') {
    const calls = windowCalls(idx, anchor.agent);
    const cross = calls.findIndex((c) => c.ctx >= THRESHOLDS.longCtx);
    if (cross >= 0) after = calls.length - cross - 1;
  }
  return {
    ...blank,
    from: Math.min(anchor.t, start),
    to: Math.max(end, endIn(idx, anchor)),
    stretch: { from: start, to: end, agent: anchor.agent ?? null },
    anchor: anchor.id,
    caption: captionFor(f, steps, idx, { after }),
  };
}

function handOff(f, steps, idx) {
  const spawn = idx.byId.get(f.event) ?? steps[0];
  const helper = idx.bySpawn.get(spawn.id) ?? null;
  const last = helper ? (idx.byAgent.get(helper.key) ?? []).filter((e) => !HOUSEKEEPING.has(e.kind)).at(-1) ?? null : null;
  const after = Math.max(endIn(idx, spawn), last ? endIn(idx, last) : -Infinity);
  // The parent carrying on: its first own record after the helper's last one.
  const parent = (idx.byAgent.get(spawn.agent) ?? []).find((e) => e.t > after && !HOUSEKEEPING.has(e.kind)) ?? null;
  const sessionEnd = ms(idx.sessions.get(spawn.session)?.lastAt);
  const gapTo = parent ? parent.t : Number.isFinite(sessionEnd) ? sessionEnd : after;
  return {
    ...blank,
    from: spawn.t,
    to: Math.max(after, gapTo),
    gap: gapTo > after ? { from: after, to: gapTo } : null,
    anchor: spawn.id,
    helper: last?.id ?? null,
    parent: parent?.id ?? null,
    caption: captionFor(f, steps, idx, { spawn, last }),
  };
}

function turnEnd(f, steps, idx) {
  const anchor = idx.byId.get(f.event) ?? steps[0];
  if (f.check === 'needless-check-in') {
    const msg = anchor;
    const next = (f.related && idx.byId.get(f.related)) || promptAfter(idx, msg);
    return {
      ...blank,
      from: msg.t,
      to: next ? endIn(idx, next) : endIn(idx, msg),
      gap: next && next.t > endIn(idx, msg) ? { from: endIn(idx, msg), to: next.t } : null,
      anchor: msg.id,
      next: next?.id ?? null,
      caption: captionFor(f, steps, idx, { msg, next }),
    };
  }
  // The session's last turn: from its last message, or the prompt that opened it when the agent
  // wrote none, to the session's last record. A result recorded later in another session's file
  // (a resumed copy) doesn't stretch it.
  const message = turnMessage(idx, anchor);
  const opener = message ? null : promptBefore(idx, anchor);
  const next = promptAfter(idx, anchor);
  return {
    ...blank,
    from: Math.min((message ?? opener ?? anchor).t, anchor.t),
    to: Math.max(endIn(idx, anchor), next ? endIn(idx, next) : -Infinity),
    anchor: anchor.id,
    message: message && message.id !== anchor.id ? message.id : null,
    prompt: opener && opener.id !== anchor.id ? opener.id : null,
    next: next?.id ?? null,
    caption: captionFor(f, steps, idx),
  };
}

const BUILD = { moment, stretch, repeat, 'hand-off': handOff, 'turn-end': turnEnd };

/**
 * scopeOf(f, idx) -> the finding's scope (see the top of this file), or null: for a check with
 * no kind, a finding with no recorded step the history holds, or a shape its kind can't frame.
 * `idx` is historyIndex() of the history the finding was found in.
 */
export function scopeOf(f, idx) {
  const kind = SCOPE_KINDS[f?.check]?.kind;
  if (!kind || !idx) return null;
  const steps = evidenceOf(f, idx);
  if (!steps.length) return null;
  const built = BUILD[kind](f, steps, idx);
  if (!built || !Number.isFinite(built.from) || !Number.isFinite(built.to) || built.to < built.from) return null;
  return { kind, steps: steps.map((e) => e.id), ...built, level: captionLevel(f.verdictEvidence) };
}

/**
 * scopeHeld(scope, has) -> the scope with only the steps a build holds (`has(id)`), and each
 * named step dropped to null when that build lacks it. Null when none of its steps is held.
 */
export function scopeHeld(scope, has) {
  if (!scope) return null;
  const steps = scope.steps.filter((id) => has(id));
  if (!steps.length) return null;
  const keep = (id) => (typeof id === 'string' && has(id) ? id : null);
  return { ...scope, steps, anchor: keep(scope.anchor) ?? steps[0], prompt: keep(scope.prompt), next: keep(scope.next), message: keep(scope.message), helper: keep(scope.helper), parent: keep(scope.parent) };
}
