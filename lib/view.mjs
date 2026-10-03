// lib/view.mjs: the `view` subcommand. A page on your own machine to find, check and
// replay your agent work.
//
// It reads the config and a window of Claude Code and Codex logs, starts a loopback
// server (lib/view/server.mjs) over the data (lib/view/data.mjs), and opens the browser.
// The browser is opened on a small redirect file in a private temporary folder, never on
// an address in a process argument, because the address carries a one-time code. The
// file is deleted once the page has traded its code for the run's key, and on exit.
//
// Nothing is published and nothing it reads is written to disk. With --demo it builds
// the made-up demo week in a temporary folder, serves only that, and deletes it on exit.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { loadConfig } from './config.mjs';
import { buildDemoWeek } from './demo/week.mjs';
import { defaultOpener } from './preview.mjs';
import { normalizeGoalRecord } from './replay/goals.mjs';
import { defaultRoots } from './replay/sources.mjs';
import { localDateInTimezone } from './resolve-week.mjs';
import { createViewData } from './view/data.mjs';
import { startViewServer } from './view/server.mjs';

const CONFIG_FILE = 'honestweek.config.json';
const DEFAULT_DAYS = 7;
/** The made-up project name the demo hides as a private word, so the switch shows something. */
export const DEMO_TERM = 'lantern';
/** Where --self-test serves its click-through page. */
export const SELF_TEST_PAGE = 'selftest/clickthrough.html';

export const HELP = `honestweek view: find, check and replay your agent work in your browser.

Usage:
  honestweek view [--days <n> | --from <YYYY-MM-DD> --to <YYYY-MM-DD>]
                  [--goals <file>] [--config <file>] [--timezone <zone>]
                  [--port <n>] [--no-open] [--self-test]
  honestweek view --demo [--port <n>] [--no-open] [--self-test]

Reads your config and the last 7 days of your Claude Code and Codex logs, then
serves a page on 127.0.0.1 and opens your browser. Type a pull request, a commit,
a file, a branch or some words to find the sessions and goals behind it, and
replay any session step by step. Every step and link says how it's known:
recorded, derived, inferred, missing, or ambiguous. Nothing is published, nothing
leaves your machine, and nothing it reads is written to disk.

The page shows redacted text. Its Show private text switch shows names, client
words and folders on your own screen; keys, tokens and passwords stay hidden.

Each run makes a fresh key. The address it opens and prints carries a one-time
code instead, which the page trades for that key, so only a page you opened can
read your data. Press Enter here to print a fresh address. Ctrl+C stops it.

Options:
      --days <n>           Look at the last n days (default 7).
      --from <YYYY-MM-DD>  The first day to look at. Use it with --to.
      --to <YYYY-MM-DD>    The last day to look at, inclusive. Use it with --from.
      --timezone <zone>    Read those dates in this IANA timezone (default: the
                           config's week.timezone).
      --goals <file>       Your goal list: a JSON file of goals and their changes.
                           You can set "goalsFile" in the config instead.
      --config <file>      Read this config instead of ./honestweek.config.json.
      --port <n>           Serve on this port (default: a free one).
      --no-open            Don't open a browser; just print the address.
      --demo               Look around a made-up week instead of your own logs. It
                           uses its own logs, config, goal list and week, so it
                           can't be combined with --config, --goals, --days,
                           --from, --to or --timezone.
      --self-test          Also serve a test page that clicks through every page
                           in your browser and reports counts, never your text.
  -h, --help               Show this help.
`;

const VALUED = new Set(['--config', '--days', '--from', '--to', '--timezone', '--goals', '--port']);
const BARE = new Set(['--no-open', '--demo', '--self-test', '--help', '-h']);
const DEMO_REFUSES = ['--config', '--goals', '--days', '--from', '--to', '--timezone'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function defaultIo() {
  return { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };
}

class SetupError extends Error {}
const setup = (message) => new SetupError(message);

/** Parse argv into { flags, values }; an unknown option or a missing value throws. */
export function parseViewArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 2 ? a.slice(0, eq) : a;
    if (BARE.has(name) && name === a) {
      flags.add(name);
      continue;
    }
    if (!VALUED.has(name)) throw setup(`view: unknown option ${JSON.stringify(a)}. Run honestweek view --help to see the options.`);
    const value = name === a ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || (name === a && value.startsWith('--'))) throw setup(`view: ${name} needs a value.`);
    if (name in values) throw setup(`view: ${name} is given twice.`);
    values[name] = value;
  }
  return { flags, values };
}

/** The port to bind: a whole number from 0 to 65535, where 0 (the default) picks a free one. */
export function parseViewPort(value) {
  if (value === undefined) return 0;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw setup(`view: --port must be a whole number from 0 to 65535 (got ${JSON.stringify(value)}). Leave it out to pick a free port.`);
  return Number(value);
}

const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The window to read: --from/--to, or the last --days days (default 7) ending today. */
export function resolveViewWindow(values, timezone, now = Date.now()) {
  const hasRange = '--from' in values || '--to' in values;
  if (hasRange && '--days' in values) throw setup('view: use --days, or --from with --to, not both.');
  if (hasRange) {
    const from = values['--from'];
    const to = values['--to'];
    if (from === undefined || to === undefined) throw setup('view: --from and --to go together. Give both, or use --days.');
    for (const [name, v] of [['--from', from], ['--to', to]]) if (!validDate(v)) throw setup(`view: ${name} must be a date written YYYY-MM-DD (got ${JSON.stringify(v)}).`);
    if (from > to) throw setup(`view: --from (${from}) is after --to (${to}).`);
    return { from, to };
  }
  let days = DEFAULT_DAYS;
  if ('--days' in values) {
    const v = values['--days'];
    if (!/^\d{1,4}$/.test(v) || Number(v) < 1 || Number(v) > 3660) throw setup(`view: --days must be a whole number from 1 to 3660 (got ${JSON.stringify(v)}).`);
    days = Number(v);
  }
  const today = localDateInTimezone(new Date(now), timezone).toISOString().slice(0, 10);
  return { from: shiftDay(today, -(days - 1)), to: today };
}

/**
 * readGoalList(path) -> the parsed goal list. Throws a setup error with a plain message
 * when the file is missing, isn't JSON, is the goals page's registry, or doesn't fit.
 */
export function readGoalList(path) {
  if (!existsSync(path)) throw setup(`view: no goal list at ${path}. Fix the path, or leave the goal list out; search and replay work without one.`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw setup(`view: ${path} isn't valid JSON (${err?.message ?? err}).`);
  }
  const looksLikeRegistry = parsed && typeof parsed === 'object' && !Array.isArray(parsed.goals) && (parsed.objectives !== undefined || parsed.projectToObjective !== undefined);
  if (looksLikeRegistry) {
    throw setup(`view: ${path} looks like the goals page's list (its "objectives"), which honestweek build reads. view reads a different file, a goal list: { "goals": [{ "id": "g-1", "title": "Ship the parser" }], "events": [] }. The README's goal list section shows the format.`);
  }
  try {
    normalizeGoalRecord(parsed);
  } catch (err) {
    throw setup(`view: ${path} isn't a goal list: ${String(err?.message ?? err).replace(/^replay: /, '')}`);
  }
  return parsed;
}

/** A page that sends the browser on to the address, so the address (and its one-time
 *  code) never sits in a process argument. */
function redirectPage(address) {
  const a = address.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${a}"><title>honestweek view</title></head>\n<body><p>Opening <a href="${a}">your honestweek page</a>.</p></body></html>\n`;
}

/**
 * runView({ argv, cwd, env, io, opener, platform, input, block, onServe, now }) -> exit code
 * 0 when stopped with Ctrl+C, 1 for a setup error. With `block: false` (tests) it
 * returns once serving, after handing `onServe` the live handle.
 */
export async function runView({ argv = [], cwd = process.cwd(), env = process.env, io = defaultIo(), opener = defaultOpener, platform = process.platform, input = process.stdin, block = true, onServe, now = () => Date.now(), buildHistory } = {}) {
  let parsed;
  try {
    parsed = parseViewArgs(argv);
  } catch (err) {
    if (err instanceof SetupError) {
      io.err(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const { flags, values } = parsed;
  if (flags.has('--help') || flags.has('-h')) {
    io.out(HELP);
    return 0;
  }
  const demo = flags.has('--demo');
  const selfTest = flags.has('--self-test');
  const noOpen = flags.has('--no-open');

  const cleanups = [];
  const cleanup = () => {
    while (cleanups.length) {
      try {
        cleanups.pop()();
      } catch {
        /* keep cleaning the rest */
      }
    }
  };

  let setupData;
  let port;
  let demoRoot = null;
  try {
    port = parseViewPort(values['--port']);
    if (demo) {
      const clash = DEMO_REFUSES.filter((f) => f in values);
      if (clash.length) throw setup(`view: --demo uses its own made-up logs, config, goal list and week, so it can't be combined with ${clash.join(', ')}.`);
      let d;
      try {
        d = buildDemoWeek();
      } catch (err) {
        throw setup(`view: the demo week couldn't be built (${String(err?.message ?? err).trim().split('\n').pop()}). It needs git on your PATH.`);
      }
      demoRoot = d.root;
      cleanups.push(() => rmSync(d.root, { recursive: true, force: true }));
      const redaction = d.config.redaction ?? {};
      setupData = {
        config: { ...d.config, redaction: { ...redaction, terms: [...(redaction.terms ?? []), DEMO_TERM] } },
        roots: d.roots,
        from: d.week.from,
        to: d.week.to,
        timezone: d.week.timezone,
        goalRecord: d.goalRecord,
      };
    } else {
      const configPath = values['--config'] ? (isAbsolute(values['--config']) ? values['--config'] : resolve(cwd, values['--config'])) : join(cwd, CONFIG_FILE);
      if (!existsSync(configPath)) {
        throw setup(values['--config']
          ? `view: no config at ${configPath}. Run honestweek init to set one up, or honestweek view --demo to look around a made-up week first.`
          : `view: no ${CONFIG_FILE} in ${cwd}. Run honestweek init to set one up, or honestweek view --demo to look around a made-up week first.`);
      }
      let config;
      try {
        config = loadConfig(configPath);
      } catch (err) {
        throw setup(`view: ${err.message}`);
      }
      const timezone = values['--timezone'] ?? config.week?.timezone;
      if (!validTimezone(timezone)) throw setup(`view: ${JSON.stringify(timezone)} isn't a timezone this machine knows. Use an IANA name such as Europe/Paris or UTC.`);
      const { from, to } = resolveViewWindow(values, timezone, now());
      const goalsPath = values['--goals'] ? (isAbsolute(values['--goals']) ? values['--goals'] : resolve(cwd, values['--goals'])) : config.goalsFile ?? null;
      const goalRecord = goalsPath ? readGoalList(goalsPath) : null;
      setupData = { config, roots: defaultRoots(env), from, to, timezone, goalRecord };
    }
  } catch (err) {
    cleanup();
    if (err instanceof SetupError) {
      io.err(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const data = createViewData({ ...setupData, demo, selfTest, now, ...(buildHistory ? { buildHistory } : {}) });
  data.start();

  let openerDir = null;
  const removeOpener = () => {
    if (openerDir) rmSync(openerDir, { recursive: true, force: true });
    openerDir = null;
  };
  let handle;
  try {
    handle = await startViewServer({ data, port, selfTest, onClaim: (purpose) => purpose === 'opener' && removeOpener() });
  } catch (err) {
    cleanup();
    io.err(err?.code === 'EADDRINUSE' ? `view: port ${port} is already in use. Leave --port out to pick a free one, or choose another.\n` : `view: couldn't start the page server (${err?.message ?? err}).\n`);
    return 1;
  }
  cleanups.push(removeOpener);

  io.out(`honestweek view: serving ${demo ? 'the made-up demo week' : `${setupData.from} to ${setupData.to}`} at ${handle.url} (Ctrl+C stops it).\n`);
  if (!noOpen) {
    try {
      openerDir = mkdtempSync(join(tmpdir(), 'honestweek-view-'));
      const file = join(openerDir, 'open.html');
      writeFileSync(file, redirectPage(handle.address('opener')), { mode: 0o600 });
      opener(file, { platform, env });
      io.out('Opening your browser.\n');
    } catch {
      removeOpener();
      io.out("Couldn't open your browser.\n");
    }
  }
  io.out(`Open this address in your browser: ${handle.address('printed')}\n`);
  if (selfTest) io.out(`The click-through test: ${handle.address('printed', SELF_TEST_PAGE)}\n`);
  io.out('Each address works once. Press Enter here to print a fresh one.\n');

  let rl = null;
  if (input && typeof input.on === 'function') {
    rl = createInterface({ input, terminal: false });
    rl.on('line', () => {
      io.out(`Fresh address: ${handle.address('printed')}\n`);
      if (selfTest) io.out(`Fresh click-through test: ${handle.address('printed', SELF_TEST_PAGE)}\n`);
    });
    rl.on('error', () => {});
    cleanups.push(() => rl.close());
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await handle.close();
    cleanup();
  };
  const onExit = () => cleanup();
  process.once('exit', onExit);
  cleanups.push(() => process.off('exit', onExit));

  if (typeof onServe === 'function') onServe({ ...handle, data, stop, openerFile: () => (openerDir ? join(openerDir, 'open.html') : null), demo, demoRoot, window: { from: setupData.from, to: setupData.to, timezone: setupData.timezone } });
  if (!block) return 0;

  await new Promise((resolveStop) => {
    const onSignal = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      stop().then(() => {
        io.out('\nhonestweek view: stopped.\n');
        resolveStop();
      });
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
  return 0;
}

export default function run(argv, io) {
  return runView({ argv, ...(io ? { io } : {}) });
}
