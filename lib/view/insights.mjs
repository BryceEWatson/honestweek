// lib/view/insights.mjs: the optional "Include /insights" group on the Problems page, and the
// "Run /insights" button.
//
// Claude Code's own /insights command has the model on the person's account read their sessions
// and writes what it concluded to <claude folder>/usage-data/: facets/<session id>.json (the
// model's reading of one session: its friction, a summary) and session-meta/<session id>.json
// (counts about it). Their shapes aren't documented and may change, so they're read defensively:
// only files for sessions this window already loaded, by id, never a folder listing beyond
// whether any facets file exists; a file that's too large, doesn't parse, isn't an object or
// whose session_id isn't its own id counts as skipped; unknown fields are ignored. Nothing here
// runs git, and nothing is written.
//
// What /insights wrote is the model's words, so it's never mixed into honestweek's own counts,
// levels or ranking: the caller shows it as its own group, labelled AI-written, each item tied
// to a whole session rather than to steps, and every string passes the redactor first.
//
// The button runs the local `claude -p /insights`, found on the PATH (absolute folders only, so
// a claude file sitting in the current folder is never picked), one run at a time, only while
// the toggle is on, stopped after RUN_TIMEOUT_MS. claude gets only the environment variables on
// CLAUDE_ENV (claudeEnv below), not other tools' tokens. Its output is discarded: the page reads
// only the files it leaves behind. honestweek makes no network call itself; claude does, on the
// person's own plan.

import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** The largest /insights file read; a bigger one is skipped. */
export const MAX_INSIGHTS_FILE = 1024 * 1024;
/** How long one run may take before it's stopped. */
export const RUN_TIMEOUT_MS = 15 * 60 * 1000;
/** The longest text kept from one /insights field, after redaction. */
export const INSIGHTS_TEXT = 400;
/** The most friction categories kept per session. */
const MAX_CATEGORIES = 20;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The environment variables any program the page starts keeps: what it needs to start, find its
 * home, config and temporary folders, and reach its service through a proxy or a company
 * certificate. Each program adds its own sign-in variables.
 */
export const SYSTEM_ENV = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);

/** `env` with only the string variables named in `names` (a Set of capitals) or starting with one of `prefixes`, matched in capitals. */
export function keepEnv(env, names, prefixes = []) {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([k, v]) => {
      const up = k.toUpperCase();
      return typeof v === 'string' && (names.has(up) || prefixes.some((p) => up.startsWith(p)));
    }),
  );
}

/**
 * What claude keeps besides SYSTEM_ENV. CLAUDE_CONFIG_DIR and the home folder find its sign-in
 * file (on macOS, the login keychain, which needs no variable); ANTHROPIC_ and CLAUDE_CODE_ hold an
 * API key, a sign-in token, a gateway address and its own settings; AWS_ and the Google Cloud names
 * sign in through Amazon Bedrock or Google Vertex AI; DISABLE_ and DO_NOT_TRACK keep the person's
 * opt-outs; the version managers' homes let a claude installed with npm find its node. Everything
 * else this process holds (GitHub, npm or OpenAI tokens, honestweek's own settings) is left out,
 * so a session that talks claude into printing its environment finds little there.
 */
const CLAUDE_ENV = new Set([...SYSTEM_ENV, 'CLAUDE_CONFIG_DIR', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'CLOUD_ML_REGION', 'CLOUDSDK_CONFIG', 'DO_NOT_TRACK', 'NVM_DIR', 'VOLTA_HOME', 'ASDF_DIR', 'ASDF_DATA_DIR']);
const CLAUDE_PREFIXES = Object.freeze(['ANTHROPIC_', 'CLAUDE_CODE_', 'AWS_', 'VERTEX_REGION_', 'DISABLE_']);
export const claudeEnv = (env) => keepEnv(env, CLAUDE_ENV, CLAUDE_PREFIXES);

/** Where /insights writes, beside Claude Code's projects folder: <claude folder>/usage-data. */
export function insightsDir(roots) {
  const projects = roots?.claude?.[0];
  return typeof projects === 'string' && projects ? join(dirname(projects), 'usage-data') : null;
}

/** Whether any facets file exists. Only names are listed; no file is read. */
export function hasInsightsData(dir) {
  if (!dir) return false;
  try {
    return readdirSync(join(dir, 'facets')).some((n) => n.toLowerCase().endsWith('.json'));
  } catch {
    return false;
  }
}

/** One /insights file for one session: { state: 'absent' } | { state: 'skipped' } | { state: 'ok', value }. */
function readOne(dir, folder, id) {
  const file = join(dir, folder, `${id}.json`);
  let st;
  try {
    st = statSync(file);
  } catch {
    return { state: 'absent' };
  }
  if (!st.isFile() || st.size > MAX_INSIGHTS_FILE) return { state: 'skipped' };
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { state: 'skipped' };
  }
  if (!isObject(value) || typeof value.session_id !== 'string' || value.session_id.toLowerCase() !== id) return { state: 'skipped' };
  return { state: 'ok', value };
}

/** A text field as one string: a string, or a list of strings joined; anything else is null. */
function textOf(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) {
    const parts = v.filter((x) => typeof x === 'string' && x.trim());
    return parts.length ? parts.join(' ') : null;
  }
  return null;
}

/** friction_counts as [{ category, count }]: whole counts of 1 or more, largest first. */
function frictionsOf(v) {
  if (!isObject(v)) return [];
  return Object.entries(v)
    .filter(([k, n]) => k.trim() && k.length <= 200 && Number.isInteger(n) && n >= 1)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1))
    .slice(0, MAX_CATEGORIES);
}

/**
 * readInsights({ dir, sessions }) -> { exists, sessions, matched, skipped, items }
 * `sessions` are [{ key, id }]: an engine session key and its Claude Code session id. Only
 * those sessions' files are read. `matched` counts sessions with a readable facets file,
 * `skipped` the files left out, and `items` one entry per matched session with friction.
 * The strings aren't redacted yet.
 */
export function readInsights({ dir, sessions }) {
  const out = { exists: hasInsightsData(dir), sessions: 0, matched: 0, skipped: 0, items: [] };
  if (!dir) return out;
  const seen = new Set();
  for (const s of sessions ?? []) {
    const id = typeof s?.id === 'string' ? s.id.toLowerCase() : '';
    if (!SESSION_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.sessions++;
    const facets = readOne(dir, 'facets', id);
    const meta = readOne(dir, 'session-meta', id);
    if (facets.state === 'skipped') out.skipped++;
    if (meta.state === 'skipped') out.skipped++;
    if (facets.state !== 'ok') continue;
    out.matched++;
    const f = facets.value;
    const frictions = frictionsOf(f.friction_counts);
    if (!frictions.length) continue;
    const minutes = meta.state === 'ok' && Number.isFinite(meta.value.duration_minutes) && meta.value.duration_minutes >= 0 ? Math.round(meta.value.duration_minutes) : null;
    out.items.push({ session: s.key, frictions, detail: textOf(f.friction_detail), summary: textOf(f.brief_summary), outcome: textOf(f.outcome), minutes });
  }
  return out;
}

/**
 * The absolute path of `name` on the PATH, or null. Relative PATH entries are passed over, so a
 * file in the current folder is never run. On Windows it tries each PATHEXT extension.
 */
export function findOnPath(name, env = process.env, platform = process.platform) {
  const get = (k) => {
    const hit = Object.keys(env ?? {}).find((x) => x.toUpperCase() === k);
    return hit ? env[hit] : undefined;
  };
  const win = platform === 'win32';
  const dirs = String(get('PATH') ?? '').split(win ? ';' : ':').filter((d) => d && isAbsolute(d));
  const exts = win ? String(get('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => /^\.[A-Za-z0-9]+$/.test(e)) : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const file = join(d, `${name}${ext}`);
      try {
        if (!statSync(file).isFile()) continue;
        if (!win) accessSync(file, constants.X_OK);
        return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Start `file -p /insights` with claudeEnv. A .cmd or .bat file runs through cmd.exe, quoted, with fixed arguments. */
function startClaude(file, { env, cwd, platform, spawnFn }) {
  const opts = { cwd, env: claudeEnv(env), stdio: 'ignore', windowsHide: true };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return spawnFn(opts.env.ComSpec || opts.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `""${file}" -p /insights"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawnFn(file, ['-p', '/insights'], { ...opts, detached: platform !== 'win32' });
}

/** Stop a run and everything it started. On Windows that's taskkill, from the system folder. */
export function stopTree(child, { platform, env, spawnFn }) {
  if (!child?.pid) return;
  try {
    if (platform === 'win32') {
      const root = env.SystemRoot || env.SYSTEMROOT || process.env.SystemRoot;
      spawnFn(root ? join(root, 'System32', 'taskkill.exe') : 'taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    } else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

const json = (status, body) => ({ status, body });

/**
 * createInsights({ dir, on, demo, persist, env, platform, cwd, timeoutMs, now, spawnFn })
 *   -> { info, read, toggle, run, stop, setOn, isOn }
 * `persist(on)` remembers the toggle in the config; it answers { remembered: true } or
 * { remembered: false, note } and throws with a plain message when the write fails.
 */
export function createInsights({ dir = null, on = false, demo = false, persist = async () => ({ remembered: false }), env = process.env, platform = process.platform, cwd = process.cwd(), timeoutMs = RUN_TIMEOUT_MS, now = () => Date.now(), spawnFn = spawn } = {}) {
  let isOn = on === true;
  let remembered = null; // null until a toggle answers; then whether it reached the config
  let child = null;
  let timer = null;
  const run = { state: 'idle', startedAt: null, endedAt: null, code: null, runs: 0 };

  function runState() {
    const end = run.endedAt ?? now();
    return { state: run.state, runs: run.runs, elapsedMs: run.startedAt == null ? null : end - run.startedAt, code: run.code, timeoutMs };
  }

  function info() {
    return { on: isOn, remembered, demo, hasData: hasInsightsData(dir), claude: demo ? null : !!findOnPath('claude', env, platform), run: runState() };
  }

  function finish(state, code = null) {
    if (run.state !== 'running') return;
    clearTimeout(timer);
    timer = null;
    run.state = state;
    run.code = code;
    run.endedAt = now();
    child = null;
  }

  return {
    info,
    isOn: () => isOn,
    setOn(v) {
      isOn = v === true;
    },
    /** The window's /insights, or null while the toggle is off. */
    read(sessions) {
      return isOn ? readInsights({ dir, sessions }) : null;
    },
    /** POST body { "on": true | false }. */
    async toggle(body) {
      let raw;
      try {
        raw = JSON.parse(String(body));
      } catch {
        raw = null;
      }
      if (!isObject(raw) || typeof raw.on !== 'boolean' || Object.keys(raw).length !== 1) return json(400, { error: 'bad-body', message: 'Send { "on": true } or { "on": false }.' });
      let saved;
      try {
        saved = await persist(raw.on);
      } catch (err) {
        return json(500, { error: 'not-saved', message: `The setting couldn't be saved, so it wasn't changed (${String(err?.message ?? err).split('\n')[0]}).` });
      }
      isOn = raw.on;
      remembered = saved?.remembered === true;
      return json(200, { ...info(), note: saved?.note ?? null });
    },
    /** POST: start `claude -p /insights`, unless the toggle is off, it's the demo, one is running, or claude isn't found. */
    async run() {
      // The page shows the button only while the toggle is on; the server holds to that too.
      if (!isOn) return json(409, { error: 'off', message: "Include /insights is off, so /insights didn't run. Turn it on first.", ...info() });
      if (demo) return json(409, { error: 'demo', message: "Not in the demo: /insights reads your own sessions, not the made-up ones.", ...info() });
      if (run.state === 'running') return json(409, { error: 'running', message: '/insights is already running.', ...info() });
      const file = findOnPath('claude', env, platform);
      if (!file) return json(409, { error: 'no-claude', message: "claude isn't on your PATH.", ...info() });
      if (/["%]/.test(file)) return json(409, { error: 'no-claude', message: "claude's path has a character this page won't pass to a shell.", ...info() });
      let c;
      try {
        c = startClaude(file, { env, cwd, platform, spawnFn });
      } catch (err) {
        return json(500, { error: 'not-started', message: `claude couldn't be started (${String(err?.code ?? err?.message ?? err)}).`, ...info() });
      }
      child = c;
      Object.assign(run, { state: 'running', startedAt: now(), endedAt: null, code: null, runs: run.runs + 1 });
      // An earlier run stopped for time can still exit later; only this run's own end counts.
      c.once('error', () => child === c && finish('failed'));
      c.once('exit', (code) => child === c && finish(code === 0 ? 'done' : 'failed', Number.isInteger(code) ? code : null));
      timer = setTimeout(() => {
        const was = child;
        finish('timeout');
        stopTree(was, { platform, env, spawnFn });
      }, timeoutMs);
      timer.unref?.();
      return json(200, info());
    },
    /** Stop a run in progress (honestweek view is stopping). */
    stop() {
      if (run.state !== 'running') return;
      const was = child;
      finish('stopped');
      stopTree(was, { platform, env, spawnFn });
    },
  };
}
