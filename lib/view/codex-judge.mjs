// lib/view/codex-judge.mjs: the Problems page's "Run with Codex" button, which gives Codex
// sessions the AI-written half of what Claude Code's /insights gives Claude Code sessions.
//
// After a confirm, and only while Include /insights is on, it runs the local `codex exec` once
// per Codex session in the window that hasn't been judged yet, up to MAX_PER_RUN a run, one
// session at a time, with a fixed prompt
// asking for exactly the /insights facet fields as one JSON object. What Codex reads is the
// session as honestweek already holds it, every string through the full redactor, sent on
// codex's standard input: the session's own log file is never named, and Codex is told not to
// run anything. codex runs in a read-only sandbox, from an empty folder, with --ephemeral so
// it keeps no session log of its own.
//
// The answer is parsed; one that isn't a JSON object with every field of the right type is
// skipped and counted. A good one is redacted again, cut, and written to honestweek's own
// folder beside the config (honestweek.codex-judgments/, git-ignored), one file per session,
// never under ~/.codex or ~/.claude. Nothing from the request reaches the command line or the
// environment: the arguments are fixed, the codex file is found on the PATH (absolute folders
// only), and the only path passed is that folder's own empty work folder. honestweek makes no
// network call itself; codex does, on the person's own plan.
//
// What's read back is the model's words, so the caller shows it as its own group, labelled
// "from Codex, AI-written", tied to whole sessions, and never mixes it into honestweek's
// counts, levels or order.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWriteJson } from '../atomic-json.mjs';
import { ensureGitignore } from '../init.mjs';
import { cutRedacted } from '../replay/word-index.mjs';
import { findOnPath, keepEnv, stopTree, SYSTEM_ENV } from './insights.mjs';
import { systemProgram } from '../windows-root.mjs';

/** The folder, beside the config, that holds the judgments. */
export const JUDGE_DIR = 'honestweek.codex-judgments';
/** The most sessions one run judges; the rest wait for the next run. */
export const MAX_PER_RUN = 10;
/** How long one whole run may take before it, and everything it started, is stopped. */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
/** How long one session may take before its codex is stopped and it counts as failed. */
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
/** The most of a session's text sent to codex. */
export const MAX_TRANSCRIPT = 60_000;
/** The most of codex's answer read; a longer answer is malformed. */
export const MAX_ANSWER = 64 * 1024;
/** The longest text kept from one field, after redaction. */
export const JUDGMENT_TEXT = 1000;
const MAX_FILE = 256 * 1024;
const MAX_KEYS = 30;

/** The fields asked for: the facet fields /insights writes. */
export const FACET_TEXT = Object.freeze(['underlying_goal', 'outcome', 'claude_helpfulness', 'session_type', 'friction_detail', 'primary_success', 'brief_summary']);
export const FACET_COUNTS = Object.freeze(['goal_categories', 'user_satisfaction_counts', 'friction_counts']);
export const FACET_FIELDS = Object.freeze(['underlying_goal', 'goal_categories', 'outcome', 'user_satisfaction_counts', 'claude_helpfulness', 'session_type', 'friction_counts', 'friction_detail', 'primary_success', 'brief_summary']);

/** The fixed arguments. The session reaches codex on standard input, never here. */
// Shell commands codex might run inherit no environment variables at all.
export const CODEX_ARGS = Object.freeze(['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-c', 'shell_environment_policy.inherit=none', '--cd']);

/**
 * The environment codex gets: only what it needs to start, find its own sign-in and reach its
 * service. Everything else this process holds (other tools' tokens, honestweek's own settings)
 * is left out, so a session that talks codex into printing its environment finds little there.
 */
const CODEX_ENV = new Set([...SYSTEM_ENV, 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY']);
export function codexEnv(env) {
  return keepEnv(env, CODEX_ENV);
}

/** The values the prompt allows for the two enumerated fields; any other answer is malformed. */
export const OUTCOMES = Object.freeze(['fully_achieved', 'mostly_achieved', 'partially_achieved', 'not_achieved', 'unclear_from_transcript']);
export const HELPFULNESS = Object.freeze(['unhelpful', 'slightly_helpful', 'moderately_helpful', 'very_helpful', 'essential']);

/** The fixed prompt. The session text follows it between the markers. */
export const JUDGE_PROMPT = [
  'You are reading one recorded Codex coding session, given below between the markers. Private words in it are already replaced with [redacted:...] markers.',
  'Do not run any command or tool and do not read any file. Answer from the text below only.',
  'Reply with one JSON object and nothing else, with exactly these keys:',
  '- underlying_goal: string, what the person was trying to get done',
  '- goal_categories: object mapping a short goal category to a count',
  '- outcome: one of "fully_achieved", "mostly_achieved", "partially_achieved", "not_achieved", "unclear_from_transcript"',
  '- user_satisfaction_counts: object mapping a satisfaction level the person showed to a count',
  '- claude_helpfulness: how helpful the agent was, one of "unhelpful", "slightly_helpful", "moderately_helpful", "very_helpful", "essential"',
  '- session_type: string, a short kind of session',
  '- friction_counts: object mapping a short friction category to a count',
  '- friction_detail: string, what got in the way, or "" if nothing did',
  '- primary_success: string, the main thing that went well, or "" if nothing did',
  '- brief_summary: string, one or two sentences',
  'Counts are whole numbers of 0 or more.',
].join('\n');

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const SESSION_ID = /^[0-9a-z][0-9a-z-]{7,63}$/;

/** One line per step the session recorded, in time order. */
function stepLine(e) {
  const f = e.facts ?? {};
  const clip = (s, n = 600) => (typeof s === 'string' ? (s.length > n ? `${cutRedacted(s, n)}…` : s) : '');
  switch (e.kind) {
    case 'prompt':
      return `Person: ${clip(f.text, 2000)}`;
    case 'message':
      return `Agent: ${clip(f.text, 1200)}`;
    case 'delegation-received':
      return f.from === 'program' ? `Instruction from a program: ${clip(f.text)}` : `Instruction to a helper: ${clip(f.text)}`;
    case 'agent-message':
      return `Between agents: ${clip(f.text)}`;
    case 'action':
      return `Step: ${f.tool ?? 'tool'} (${f.result || 'no result recorded'}) ${clip(f.command ?? f.file ?? f.pattern ?? f.description ?? '', 300)}`.trimEnd();
    case 'interrupt':
      return 'Interrupted.';
    case 'error':
      return 'An error was recorded.';
    default:
      return null;
  }
}

/**
 * sessionText(events, redact) -> string
 * What codex is sent for one session: its steps as lines, every string through `redact`, cut
 * to MAX_TRANSCRIPT by keeping the start and the end.
 */
export function sessionText(events, redact) {
  const lines = events
    .slice()
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1))
    .map(stepLine)
    .filter(Boolean)
    .map((l) => redact(l).replace(/\s*\n\s*/g, ' '));
  let text = lines.join('\n');
  if (text.length > MAX_TRANSCRIPT) {
    const head = cutRedacted(text, Math.floor(MAX_TRANSCRIPT * 0.6));
    const tailStart = text.length - Math.floor(MAX_TRANSCRIPT * 0.35);
    const nl = text.indexOf('\n', tailStart);
    text = `${head}\n[... part of the session left out ...]\n${text.slice(nl < 0 ? tailStart : nl + 1)}`;
  }
  return text;
}

/** The prompt codex is sent for one session. */
export const judgeInput = (text) => `${JUDGE_PROMPT}\n\n--- session start ---\n${text}\n--- session end ---\n`;

/** A count map, or null when it isn't one: whole counts of 0 or more under short keys. */
function countsOf(v) {
  if (!isObject(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > MAX_KEYS) return null;
  for (const [k, n] of entries) if (!k.trim() || k.length > 100 || !Number.isInteger(n) || n < 0) return null;
  return v;
}

/** The facet fields of one answer, or null when any is missing or the wrong type. Other keys are dropped. */
export function facetsOf(v) {
  if (!isObject(v)) return null;
  const out = {};
  for (const k of FACET_TEXT) {
    if (typeof v[k] !== 'string') return null;
    if (k === 'outcome' && !OUTCOMES.includes(v[k])) return null;
    if (k === 'claude_helpfulness' && !HELPFULNESS.includes(v[k])) return null;
    out[k] = v[k];
  }
  for (const k of FACET_COUNTS) {
    const c = countsOf(v[k]);
    if (!c) return null;
    out[k] = c;
  }
  return out;
}

/** codex's answer as facets, or null: one JSON object, alone or in a ```json fence. */
export function parseAnswer(stdout) {
  if (typeof stdout !== 'string' || stdout.length > MAX_ANSWER) return null;
  let s = stdout.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try {
    return facetsOf(JSON.parse(s));
  } catch {
    return null;
  }
}

/** Facets with every string, keys included, through `redact`, then cut. */
export function redactFacets(facets, redact) {
  const text = (s) => {
    const whole = redact(String(s));
    const cut = cutRedacted(whole, JUDGMENT_TEXT);
    return cut.length < whole.length ? `${cut}…` : cut;
  };
  const out = {};
  for (const k of FACET_TEXT) out[k] = text(facets[k]);
  for (const k of FACET_COUNTS) {
    out[k] = {};
    for (const [name, n] of Object.entries(facets[k])) {
      const key = cutRedacted(redact(name), 100);
      out[k][key] = (out[k][key] ?? 0) + n;
    }
  }
  return out;
}

/** Make the folder, git-ignored twice over: its own "*" file, and a line in the config folder's .gitignore. */
function ensureDir(dir, configDir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const own = join(dir, '.gitignore');
  if (!existsSync(own)) writeFileSync(own, '*\n');
  mkdirSync(join(dir, 'work'), { recursive: true });
  if (configDir) ensureGitignore(configDir, `${JUDGE_DIR}/`);
}

/** One stored judgment: { state: 'absent' | 'skipped' } or { state: 'ok', value }. */
function readOne(dir, id) {
  const file = join(dir, `${id}.json`);
  let st;
  try {
    st = statSync(file);
  } catch {
    return { state: 'absent' };
  }
  if (!st.isFile() || st.size > MAX_FILE) return { state: 'skipped' };
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    const facets = isObject(v) && v.session_id === id ? facetsOf(v.facets) : null;
    return facets ? { state: 'ok', value: { facets, judgedAt: typeof v.judgedAt === 'string' ? v.judgedAt : null } } : { state: 'skipped' };
  } catch {
    return { state: 'skipped' };
  }
}

/**
 * readJudgments(dir, sessions) -> { sessions, judged, skipped, items }
 * `sessions` are [{ key, id }]: Codex sessions and their thread ids. Only their files are read.
 */
export function readJudgments(dir, sessions) {
  const out = { sessions: 0, judged: 0, skipped: 0, items: [] };
  const seen = new Set();
  for (const s of sessions ?? []) {
    const id = typeof s?.id === 'string' ? s.id.toLowerCase() : '';
    if (!SESSION_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.sessions++;
    if (!dir) continue;
    const r = readOne(dir, id);
    if (r.state === 'skipped') out.skipped++;
    if (r.state !== 'ok') continue;
    out.judged++;
    out.items.push({ session: s.key, ...r.value });
  }
  return out;
}

/** Start `file exec ... --cd <work> -`. A .cmd or .bat file runs through cmd.exe, quoted, with fixed arguments. */
function startCodex(file, work, { env, platform, spawnFn }) {
  const args = [...CODEX_ARGS, work, '-'];
  const opts = { cwd: work, env: codexEnv(env), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = [`"${file}"`, ...args.map((a) => (a === work ? `"${a}"` : a))].join(' ');
    return spawnFn(opts.env.ComSpec || opts.env.COMSPEC || systemProgram('cmd.exe', env), ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawnFn(file, args, { ...opts, detached: platform !== 'win32' });
}

const json = (status, body) => ({ status, body });

/**
 * createCodexJudge({ configDir, isOn, demo, env, platform, timeoutMs, sessionTimeoutMs, cap, now, spawnFn })
 *   -> { info, read, run, stop }
 * `configDir` is the config's folder, or a function answering it (null before setup); the
 * judgments sit in JUDGE_DIR inside it. `isOn()` answers whether Include /insights is on; a run
 * starts only while it is, and without one, never. `run(work)` takes
 * the window's work, { sessions: [{ key, id, text }], redact }, or null while it's still loading.
 */
export function createCodexJudge({ configDir = null, isOn = () => false, demo = false, env = process.env, platform = process.platform, timeoutMs = RUN_TIMEOUT_MS, sessionTimeoutMs = SESSION_TIMEOUT_MS, cap = MAX_PER_RUN, now = () => Date.now(), spawnFn = spawn } = {}) {
  const folderOf = () => {
    const c = typeof configDir === 'function' ? configDir() : configDir;
    return typeof c === 'string' && c ? c : null;
  };
  const dirOf = () => (folderOf() ? join(folderOf(), JUDGE_DIR) : null);
  let child = null;
  let timer = null;
  let generation = 0;
  const run = { state: 'idle', runs: 0, startedAt: null, endedAt: null, queued: 0, judged: 0, malformed: 0, failed: 0, left: 0 };

  function runState() {
    const end = run.endedAt ?? now();
    const { state, runs, queued, judged, malformed, failed, left } = run;
    return { state, runs, queued, judged, malformed, failed, left, cap, elapsedMs: run.startedAt == null ? null : end - run.startedAt, timeoutMs };
  }
  const info = () => ({ demo, codex: demo ? null : !!findOnPath('codex', env, platform), run: runState() });

  function finish(state) {
    if (run.state !== 'running') return;
    clearTimeout(timer);
    timer = null;
    run.state = state;
    run.endedAt = now();
    const was = child;
    child = null;
    generation++;
    if (was) stopTree(was, { platform, env, spawnFn });
  }

  /** Judge one session: resolves 'judged', 'malformed' or 'failed'. */
  function judgeOne(file, dir, s, redact, gen) {
    return new Promise((done) => {
      let c;
      try {
        c = startCodex(file, join(dir, 'work'), { env, platform, spawnFn });
      } catch {
        done('failed');
        return;
      }
      child = c;
      let out = '';
      let over = false;
      let settled = false;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(own);
        if (child === c) child = null;
        done(v);
      };
      const own = setTimeout(() => {
        stopTree(c, { platform, env, spawnFn });
        settle('failed');
      }, sessionTimeoutMs);
      own.unref?.();
      c.stdout?.setEncoding?.('utf8');
      c.stdout?.on('data', (d) => {
        if (over) return;
        out += d;
        if (out.length > MAX_ANSWER) over = true;
      });
      c.stdin?.on('error', () => {});
      c.once('error', () => settle('failed'));
      c.once('close', (code) => {
        if (gen !== generation) return settle('stopped');
        if (code !== 0) return settle('failed');
        const facets = over ? null : parseAnswer(out);
        if (!facets) return settle('malformed');
        try {
          ensureDir(dir, dirname(dir));
          atomicWriteJson(join(dir, `${s.id}.json`), { session_id: s.id, agent: 'codex', judgedAt: new Date(now()).toISOString(), facets: redactFacets(facets, redact) });
          settle('judged');
        } catch {
          settle('failed');
        }
      });
      try {
        c.stdin?.end(judgeInput(s.text));
      } catch {
        /* a codex that closed its input early still exits */
      }
    });
  }

  async function loop(file, dir, queue, redact, gen) {
    for (const s of queue) {
      if (gen !== generation || run.state !== 'running') return;
      const r = await judgeOne(file, dir, s, redact, gen);
      if (gen !== generation) return;
      if (r === 'judged') run.judged++;
      else if (r === 'malformed') run.malformed++;
      else if (r === 'failed') run.failed++;
    }
    finish('done');
  }

  return {
    info,
    /** The stored judgments of these Codex sessions. */
    read: (sessions) => readJudgments(dirOf(), sessions),
    /** POST: judge the window's Codex sessions not judged yet, up to `cap`. */
    async run(work) {
      // The page shows the button only while Include /insights is on; the server holds to that too.
      if (isOn() !== true) return json(409, { error: 'off', message: "Include /insights is off, so Codex didn't run. Turn it on first.", ...info() });
      if (demo) return json(409, { error: 'demo', message: 'Not in the demo: this reads your own Codex sessions, not the made-up ones.', ...info() });
      if (run.state === 'running') return json(409, { error: 'running', message: 'Codex is already running.', ...info() });
      const dir = dirOf();
      if (!dir) return json(409, { error: 'no-config', message: 'Finish setup first: the results are kept beside your config.', ...info() });
      if (!work) return json(503, { error: 'building', message: 'The week is still loading. Try again in a moment.', ...info() });
      const file = findOnPath('codex', env, platform);
      if (!file) return json(409, { error: 'no-codex', message: "codex isn't on your PATH.", ...info() });
      if (/["%]/.test(file) || /["%]/.test(dir)) return json(409, { error: 'no-codex', message: "A path has a character this page won't pass to a shell.", ...info() });
      const all = (work.sessions ?? []).filter((s) => typeof s?.id === 'string' && SESSION_ID.test(s.id) && typeof s.text === 'string' && s.text);
      const waiting = all.filter((s) => readOne(dir, s.id).state !== 'ok');
      if (!waiting.length) return json(409, { error: 'nothing', message: all.length ? 'Every Codex session here is judged already.' : 'No Codex session to judge in this window.', ...info() });
      try {
        ensureDir(dir, dirname(dir));
      } catch (err) {
        return json(500, { error: 'not-started', message: `The results folder couldn't be made (${String(err?.code ?? err?.message ?? err)}).`, ...info() });
      }
      const queue = waiting.slice(0, cap);
      generation++;
      const gen = generation;
      Object.assign(run, { state: 'running', runs: run.runs + 1, startedAt: now(), endedAt: null, queued: queue.length, judged: 0, malformed: 0, failed: 0, left: waiting.length - queue.length });
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      timer.unref?.();
      loop(file, dir, queue, typeof work.redact === 'function' ? work.redact : (s) => s, gen).catch(() => finish('failed'));
      return json(200, info());
    },
    /** Stop a run in progress (honestweek view is stopping). */
    stop() {
      finish('stopped');
    },
  };
}
