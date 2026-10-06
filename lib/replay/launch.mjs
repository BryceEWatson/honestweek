// lib/replay/launch.mjs: which step in another session started a session a program opened.
//
// A Claude Code session whose first turn a program sent (`turnOrigin: "sdk"`), or a Codex
// session `codex exec` started, was launched by something. When that something is another
// session's step, that session's log can say so: a shell call that ran `claude -p` (or
// `codex exec`), or a Stop hook's own record. This module matches each such session to at most
// one step, and says how the match is known:
//
//   recorded  the step names the session's id (`--session-id`, `--resume`, a hook's output)
//   derived   the step's command holds the session's opening instruction, word for word
//   inferred  the only matching launch in the same folder in the 2 minutes before the session's
//             first record, that no other session is tied to by its id or its text
//
// When two or more steps in different sessions fit, or one launch is the only fit for two
// sessions, none is linked, and the session says how many fit. A step counts only when it ran
// before the session's first record. A hook counts only by naming the session, never by its
// timing, and timing never links across folders. Every function here is pure.

/** The rules behind a launch link or an ambiguity, as the rules table prints them. */
export const LAUNCH_RULES = new Map([
  ['launch.session-id', "A session a program started (its first turn's record says turnOrigin sdk, or its Codex session record says codex exec started it) is linked to the step in another session that names its id: a shell call that runs claude -p or codex exec, or a Stop hook's record. When several steps named it before (or within 5 seconds of) its first record, the latest one is linked; when they're in different sessions, none is."],
  ['launch.opening-text', "A session a program started is linked to the claude -p or codex exec call in another session whose command holds the first 120 characters of the session's opening instruction (spaces collapsed, at least 40 characters), or a Stop hook's record that holds them, before (or within 5 seconds of) the session's first record. A match on the whole instruction is preferred; when steps in different sessions still fit, or one step holds the same opening as two sessions, none is linked, and a step that names a session's id is never matched by text."],
  ['launch.same-folder', "A session a program started is linked to the claude -p (or, for a Codex session, codex exec) call in another session that ran in the same folder in the 2 minutes before the session's first record (or within 5 seconds after it), when it is the only such call and no other session started in that time could be its run. A call that names another session's id or holds another session's opening isn't counted. Timing is never read across folders or from a hook."],
]);

/** Where each launch rule comes from, as lib/replay/classify.mjs marks the others: null when
 *  it's honestweek's own rule, not taken from a published source. Each is listed by hand, so a
 *  new rule can't pass unmarked (test/problems-basis.test.mjs). */
export const LAUNCH_RULE_SOURCES = new Map([
  ['launch.session-id', null],
  ['launch.opening-text', null],
  ['launch.same-folder', null],
]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEAD = 120;
const MIN_OPENING = 40;
const WINDOW_MS = 2 * 60 * 1000;
const SLACK_MS = 5000;

/** Whitespace collapsed, ends trimmed: the form a command and an opening are compared in. */
export const flatText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The session ids (UUIDs) a text names, lowercased. */
export const idsIn = (s) => [...new Set((String(s ?? '').match(UUID_RE) ?? []).map((x) => x.toLowerCase()))];

/** A command with quoted text replaced by Q, except a quoted program path (".../claude.exe"),
 *  which keeps its last part so `& "C:/tools/claude.exe" -p` still reads as a launch. */
function unquoted(command) {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c !== '"' && c !== "'") {
      out += c;
      continue;
    }
    let j = i + 1;
    while (j < command.length && command[j] !== c) j += c === '"' && command[j] === '\\' ? 2 : 1;
    const inner = command.slice(i + 1, j);
    const prog = inner.match(/(?:^|[\\/])(claude|codex)(?:\.(?:cmd|exe|ps1))?$/i);
    out += prog ? ` ${prog[1]} ` : ' Q ';
    i = j;
  }
  return out;
}

/**
 * launchKind(command) -> 'claude' | 'codex' | null
 * 'claude' when a command runs `claude` with -p or --print (a headless run), 'codex' when it runs
 * `codex exec`, read outside quoted text, one piece of a command line at a time.
 */
export function launchKind(command) {
  if (typeof command !== 'string' || !/claude|codex/i.test(command)) return null;
  for (const piece of unquoted(command).split(/&&|\|\||[;|\n]/)) {
    const m = piece.match(/(?:^|[\s(&/\\])(claude|codex)(?:\.(?:cmd|exe|ps1))?(?=\s|$)/i);
    if (!m) continue;
    const rest = piece.slice(m.index + m[0].length);
    if (m[1].toLowerCase() === 'claude' && /(?:^|\s)(?:-p|--print)(?=\s|$|=)/.test(rest)) return 'claude';
    if (m[1].toLowerCase() === 'codex' && /(?:^|\s)exec(?=\s|$)/.test(rest)) return 'codex';
  }
  return null;
}

/**
 * matchLaunches({ launches, children, knownIds }) -> Map(child session -> launchedBy)
 *
 * launches: [{ event, session, ownId, kind: 'claude' | 'codex' | 'hook', text, cwd, t }], where
 *   `text` is the step's full command (or a hook's own strings), `cwd` its normalized folder and
 *   `ownId` its own session's id, lowercase (a call that names only its own session, say to pass
 *   it to the run as context, still counts by timing).
 * children: [{ session, kind: 'claude' | 'codex', id, opening, cwd, startT }], `id` the
 *   session's own id (lowercase), `opening` its opening instruction's full text, or null.
 * knownIds: every session id in the history, lowercase.
 *
 * launchedBy is { event, session, evidence, rule } for a link, or { ambiguous: true, evidence,
 * rule, launches, sessions? } when more than one step fits (or one step fits several sessions).
 */
export function matchLaunches({ launches, children, knownIds = new Set() }) {
  const steps = launches.map((l) => ({ ...l, ids: new Set(idsIn(l.text)), flat: flatText(l.text) }));
  const out = new Map();
  const claimed = new Set();
  const latest = (list) => list.reduce((a, b) => (b.t > a.t || (b.t === a.t && b.event.id > a.event.id) ? b : a));
  const decide = (c, list, evidence, rule) => {
    for (const l of list) claimed.add(l.event);
    const sessions = new Set(list.map((l) => l.session));
    if (sessions.size > 1) return out.set(c.session, { ambiguous: true, evidence, rule, launches: list.length });
    const l = latest(list);
    return out.set(c.session, { event: l.event.id, session: l.session, evidence, rule });
  };
  const fits = (c, l) => l.session !== c.session && (l.kind === 'hook' || l.kind === c.kind) && l.t <= c.startT + SLACK_MS;
  // Ids first, for every run, so a step that names one run is never matched to another by text.
  const byId = new Set();
  const unnamed = [];
  for (const c of children) {
    const named = steps.filter((l) => fits(c, l) && l.ids.has(c.id));
    if (!named.length) {
      unnamed.push(c);
      continue;
    }
    decide(c, named, 'recorded', 'launch.session-id');
    for (const l of named) byId.add(l.event);
  }
  const timed = [];
  const byText = new Map(); // launch -> [{ session, head }] it was linked to by text
  for (const c of unnamed) {
    const whole = flatText(c.opening);
    const head = whole.slice(0, HEAD);
    if (head.length >= MIN_OPENING) {
      let held = steps.filter((l) => fits(c, l) && !byId.has(l.event) && l.flat.includes(head));
      if (held.length > 1 && held.some((l) => l.flat.includes(whole))) held = held.filter((l) => l.flat.includes(whole));
      if (held.length) {
        decide(c, held, 'derived', 'launch.opening-text');
        const by = out.get(c.session);
        if (by.event) byText.set(by.event, [...(byText.get(by.event) ?? []), { session: c.session, head }]);
        continue;
      }
    }
    timed.push(c);
  }
  // One step linked by the same opening to two runs (a prompt run again later by something the
  // logs don't show, say) can't say which run it started, so it links neither. One command that
  // holds several different openings, a loop, still links each.
  for (const runs of byText.values()) {
    for (const r of runs) {
      const same = runs.filter((x) => x.head === r.head).length;
      if (same > 1) out.set(r.session, { ambiguous: true, evidence: 'derived', rule: 'launch.opening-text', launches: 1, sessions: same });
    }
  }
  // Timing last, so a launch already tied to a session by its id or its text is never counted.
  const tentative = new Map();
  for (const c of timed) {
    if (!c.cwd) continue;
    const near = steps.filter((l) => l.kind === c.kind && l.session !== c.session && l.cwd === c.cwd && l.t >= c.startT - WINDOW_MS && l.t <= c.startT + SLACK_MS && !claimed.has(l.event) && ![...l.ids].some((id) => id !== l.ownId && knownIds.has(id)));
    if (near.length > 1) out.set(c.session, { ambiguous: true, evidence: 'inferred', rule: 'launch.same-folder', launches: near.length });
    else if (near.length === 1) tentative.set(c.session, near[0]);
  }
  const fitsMany = new Map();
  for (const l of tentative.values()) fitsMany.set(l.event, (fitsMany.get(l.event) ?? 0) + 1);
  for (const [session, l] of tentative) {
    const n = fitsMany.get(l.event);
    out.set(session, n > 1 ? { ambiguous: true, evidence: 'inferred', rule: 'launch.same-folder', launches: 1, sessions: n } : { event: l.event.id, session: l.session, evidence: 'inferred', rule: 'launch.same-folder' });
  }
  return out;
}
