// lib/view.mjs: the `view` subcommand. A page on your own machine to find, check and
// replay your agent work.
//
// It reads the config and a window of Claude Code and Codex logs, starts a loopback
// server (lib/view/server.mjs) over the data (lib/view/data.mjs), and opens the browser.
// The browser is opened on a small redirect file in a private temporary folder, never on
// an address in a process argument, because the address carries a one-time code. The
// file is deleted once the page has traded its code for the run's key, after
// OPENER_TTL_MS when it hasn't (its code stops working then too), and on exit.
//
// Nothing is published, and it keeps only what the user chooses to save (the config, Run with
// Codex's answers). With --demo it builds
// the made-up demo week in a temporary folder, serves only that, and deletes it on exit.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import { hostTimezone } from './config.mjs';
import { findConfig, lookupUserConfig, noteConfig } from './config-lookup.mjs';
import { currentCommand, pageCommand } from './invocation.mjs';
import { buildDemoWeek, markDemoOwner, sweepStaleDemoDirs } from './demo/week.mjs';
import { defaultOpener } from './preview.mjs';
import { defaultRoots } from './replay/sources.mjs';
import { createViewData, privateWordCount, privateWordsNote } from './view/data.mjs';
import { CODE_TTL_MS, startViewServer } from './view/server.mjs';
import { createSetup } from './view/setup.mjs';
import { createInsights, insightsDir } from './view/insights.mjs';
import { pageLink } from './view/page-link.mjs';
import { createCodexJudge } from './view/codex-judge.mjs';
import { createSettings, saveInsightsFlag } from './view/settings.mjs';
import { bytesIn, fitsInMemory, historyInfo, logFiles, memoryRoom, paramsOfHistory, sizeText, WHOLE_DAYS, windowAnswer } from './view/window.mjs';
import { createProgressiveData, fitWindow } from './view/progressive.mjs';
import { createSaver } from './saved/saver.mjs';
import { absolute, limitOf, ownWeek, readGoalList, resolveViewWindow, setup, SetupError, spanDays, validTimezone } from './view/own-week.mjs';
import { DEMO_TERM } from './demo/week.mjs';

export { DEMO_TERM, ownWeek, readGoalList, resolveViewWindow };

const CONFIG_FILE = 'honestweek.config.json';
/** Where --self-test serves its click-through page. */
export const SELF_TEST_PAGE = 'selftest/clickthrough.html';
/** The page a folder with no config opens on. */
export const SETUP_PAGE = 'setup.html';
/** How long the redirect file and its code last when the browser doesn't use them. On
 *  Windows the file takes its temporary folder's access list, so this bounds how long a
 *  code another account could read stays good. */
export const OPENER_TTL_MS = 2 * 60 * 1000;

export const HELP = `honestweek view: find, check and replay your agent work in your browser.

Usage:
  ${currentCommand()} view [--days <n> | --from <YYYY-MM-DD> --to <YYYY-MM-DD>]
                  [--goals <file>] [--config <file>] [--timezone <zone>]
                  [--port <n>] [--no-open] [--self-test]
  ${currentCommand()} view --demo [--port <n>] [--no-open] [--self-test]

Reads your config and the last 7 days of your Claude Code and Codex logs, then
serves a page on 127.0.0.1 and opens your browser. The config is the
honestweek.config.json in this folder, else the file HONESTWEEK_CONFIG names,
else ~/.honestweek/honestweek.config.json. With none of those, the page that
opens is Setup: it finds your repositories, email and timezone, asks which
names and client words to keep private, shows the config, and saves it, in
this folder or for every folder, then goes on to your week. For
scripts and CI, ${currentCommand()} init asks the same questions in a terminal. With
no --days, --from or --to, it reads as far back as the config's "history"
says (Setup and the Settings page set it), or the last 7 days. Type a pull request, a commit,
a file, a branch or some words to find the sessions and goals behind it, and
replay any session step by step. Every step and link says how it's known:
recorded, derived, inferred, missing, or ambiguous. Nothing is published, nothing
leaves your machine, and you have full control over what it keeps.

The page shows redacted text. Its Show private text switch shows names, client
words and folders on your own screen; keys, tokens and passwords stay hidden.
Redaction hides the names and client words listed under "redaction" in your
config, so until you list some, they show as written, and view says so.

Each run makes a fresh key. The address it opens and prints carries a one-time
code instead, which the page trades for that key, so only a page you opened can
read your data. A printed address works once, within ${CODE_TTL_MS / 60_000} minutes. Press Enter
here to print a fresh address, or type link and a page, such as
link replay.html?session=<id>, for a fresh one-time address to that page. Ctrl+C stops it.

Options:
      --days <n>           Look at the last n days (default 7).
      --from <YYYY-MM-DD>  The first day to look at. Use it with --to.
      --to <YYYY-MM-DD>    The last day to look at, inclusive. Use it with --from.
      --timezone <zone>    Read those dates in this IANA timezone (default: the
                           config's week.timezone).
      --goals <file>       Your goal list: a JSON file of goals and their changes.
                           You can set "goalsFile" in the config instead.
      --config <file>      Read this config instead of the one honestweek finds.
      --port <n>           Serve on this port (default: a free one).
      --no-open            Don't open a browser; just print the address.
      --page <page>        Open on this page instead of Problems, for example
                           "replay.html?session=<id>" or one step of it,
                           "replay.html?session=<id>#<thread>~<step>". Only view's
                           own pages are accepted.
      --demo               Look around a made-up week instead of your own logs. It
                           uses its own logs, config, goal list and week, so it
                           can't be combined with --config, --goals, --days,
                           --from, --to or --timezone.
      --self-test          Also serve a test page that clicks through every page
                           in your browser and reports each step as pass, fail
                           or skip. A step's note can quote what a page showed.
                           Its address is printed beside the page's.
  -h, --help               Show this help.
`;

const VALUED = new Set(['--config', '--days', '--from', '--to', '--timezone', '--goals', '--port', '--page']);
const BARE = new Set(['--no-open', '--demo', '--self-test', '--help', '-h']);
const DEMO_REFUSES = ['--config', '--goals', '--days', '--from', '--to', '--timezone'];

function defaultIo() {
  return { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };
}


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
    if (!VALUED.has(name)) throw setup(`view: unknown option ${JSON.stringify(a)}. Run ${currentCommand()} view --help to see the options.`);
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
  // A browser leaves port 80 out of the Host header, which the server checks.
  if (Number(value) === 80) throw setup('view: --port 80 won\'t work, because a browser leaves that port out of the address the server checks. Choose another, or leave it out to pick a free port.');
  return Number(value);
}

/** What the data routes answer while setup isn't done: every page but Setup is sent there.
 *  `appeared()` answers the week's data once a config turns up in the folder, whoever wrote it
 *  (Setup, or init in another terminal), and null until then. */
function setupPendingData(command, appeared = async () => null) {
  const note = `There's no ${CONFIG_FILE} here yet, so finish setup first.`;
  return {
    start() {},
    route: async (path, params) => {
      const week = await appeared();
      if (week) return week.route(path, params);
      return path === '/api/status' ? { status: 200, body: { setup: true, state: 'setup', command, note } } : { status: 409, body: { error: 'setup', note } };
    },
    leakCheck: () => ({ error: "Setup isn't finished, so there's no data to check yet." }),
  };
}

/** What the data routes answer when a saved config couldn't be loaded: the pages say why. */
function haltedData(command, message) {
  const failed = `${message} The config is saved; stop honestweek view with Ctrl+C and start it again.`;
  return {
    start() {},
    route: async (path) => (path === '/api/status' ? { status: 200, body: { state: 'failed', failed, builds: { redacted: { state: 'failed', failed }, private: { state: 'failed', failed } }, command } } : { status: 503, body: { error: 'failed', note: failed } }),
    leakCheck: () => ({ error: failed }),
  };
}

/** A code's lifetime in words: whole minutes, or seconds when it's shorter than one. */
function lifetime(ms) {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** A page that sends the browser on to the address, so the address (and its one-time
 *  code) never sits in a process argument. */
function redirectPage(address) {
  const a = address.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${a}"><title>honestweek view</title></head>\n<body><p>Opening <a href="${a}">your honestweek page</a>.</p></body></html>\n`;
}

/**
 * runView({ argv, cwd, env, io, opener, platform, input, block, onServe, now, openerTtlMs, printedTtlMs, codeClock }) -> exit code
 * `codeClock`, for tests, is the clock the server's codes expire by (real time by default).
 * 0 when stopped with Ctrl+C, 1 for a setup error. With `block: false` (tests) it
 * returns once serving, after handing `onServe` the live handle.
 */
export async function runView({ argv = [], cwd = process.cwd(), env = process.env, io = defaultIo(), opener = defaultOpener, platform = process.platform, input = process.stdin, block = true, onServe, now = () => Date.now(), buildHistory, openerTtlMs = OPENER_TTL_MS, printedTtlMs = CODE_TTL_MS, codeClock, inferEmail } = {}) {
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
  // --page: the page the opened and printed addresses go to, checked before anything is read.
  const startAt = values['--page'] === undefined ? null : pageLink(values['--page']);
  if (startAt?.error) {
    io.err(`view: --page: ${startAt.error}\n`);
    return 1;
  }

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
      // Clear demo folders a hard-killed earlier run left behind (older than a day).
      sweepStaleDemoDirs();
      let d;
      try {
        d = buildDemoWeek();
      } catch (err) {
        throw setup(`view: the demo week couldn't be built (${String(err?.message ?? err).trim().split('\n').pop()}). It needs git on your PATH.`);
      }
      demoRoot = d.root;
      cleanups.push(() => rmSync(d.root, { recursive: true, force: true }));
      // Mark the folder as this run's, so another demo's cleanup leaves it however long this one runs.
      markDemoOwner(d.root);
      const redaction = d.config.redaction ?? {};
      setupData = {
        config: { ...d.config, redaction: { ...redaction, terms: [...(redaction.terms ?? []), DEMO_TERM] } },
        roots: d.roots,
        from: d.week.from,
        to: d.week.to,
        timezone: d.week.timezone,
        goalRecord: d.goalRecord,
      };
    } else if (findConfig({ cwd, flag: values['--config'] }).source === 'none') {
      // No config here: the Setup page writes one. The options that don't need a config are
      // checked now, so a typo shows before setup rather than after it.
      if ('--timezone' in values && !validTimezone(values['--timezone'])) throw setup(`view: ${JSON.stringify(values['--timezone'])} isn't a timezone this machine knows. Use an IANA name such as Europe/Paris or UTC.`);
      resolveViewWindow(values, values['--timezone'] ?? 'UTC', now());
      if (values['--goals']) readGoalList(absolute(cwd, values['--goals']));
    } else {
      noteConfig(io.err, 'view', findConfig({ cwd, flag: values['--config'] }), { cwd, writes: true });
      setupData = ownWeek({ values, cwd, env, now });
    }
  } catch (err) {
    cleanup();
    if (err instanceof SetupError) {
      io.err(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const command = pageCommand(currentCommand());
  // Settings changes the config this run reads, in its own folder, which may not be this one
  // (--config, HONESTWEEK_CONFIG, the user-level file). It writes only a file called
  // honestweek.config.json, so a config named with --config under another name stays as it is;
  // the /insights toggle follows the same rule, and is kept for this run only when it can't be saved.
  const configDir = () => (setupData?.configPath ? dirname(setupData.configPath) : cwd);
  const fileName = (p) => (process.platform === 'win32' ? basename(p).toLowerCase() : basename(p));
  const elsewhere = () => !!setupData?.configPath && fileName(setupData.configPath) !== CONFIG_FILE;
  // The Problems page's optional /insights group and its Run button: one for the whole run, so
  // a run still going survives a Settings save.
  const insights = createInsights({
    dir: insightsDir(setupData?.roots ?? defaultRoots(env)),
    on: setupData?.config?.insights === true,
    demo,
    env,
    cwd,
    persist: async (on) => {
      if (demo) return { remembered: false, note: 'For this run only: the demo has no config to save.' };
      if (elsewhere()) return { remembered: false, note: `For this run only: the config named with --config isn't called ${CONFIG_FILE}, so it can't be changed here.` };
      if (!existsSync(join(configDir(), CONFIG_FILE))) throw new Error('finish setup first');
      return saveInsightsFlag(configDir(), on);
    },
  });
  cleanups.push(() => insights.stop());
  // Run with Codex, beside it: its results sit in a git-ignored folder next to the config, so
  // there's none in the demo or before setup.
  // It runs only while Include /insights is on, the switch the page shows its button under.
  const codexJudge = createCodexJudge({ configDir: () => (setupData?.configPath ? dirname(setupData.configPath) : null), demo, env, isOn: () => insights.isOn() });
  cleanups.push(() => codexJudge.stop());
  // Saved results (lib/saved/): only with "saveResults" on, in a folder beside the config view read.
  const saver = createSaver({ configDir: () => (setupData?.configPath ? dirname(setupData.configPath) : null), config: () => setupData?.config ?? null, demo, now });
  // Checks that keep a large window from running the process out of memory, and Show private
  // text's second copy only when it fits beside the first. The window before (for the Problems
  // page's trend) follows the window's own rule: for a week or less, all of it, newest day first,
  // or the newest days memory holds; for a longer window, only within the log limit.
  const guards = (d) => ({
    earlierProgressive: spanDays(d.from, d.to) <= WHOLE_DAYS,
    earlierCheck: (w) => {
      const files = logFiles(d.roots, d.timezone);
      const bytes = bytesIn({ files, from: w.from, to: w.to });
      const limit = limitOf(d.config);
      if (spanDays(d.from, d.to) > WHOLE_DAYS && bytes > limit * 1024 * 1024) return { why: 'limit', note: `The ${w.days} days before hold ${sizeText(bytes)} of logs, past the ${limit} MB limit, so they aren't compared.` };
      if (fitsInMemory(bytes)) return null;
      if (!fitsInMemory(bytesIn({ files, from: w.to, to: w.to }))) return { why: 'memory', note: `The ${w.days} days before need more memory than this process has left, so they aren't compared.` };
      const fit = fitWindow({ from: w.from, to: w.to, files, room: memoryRoom() });
      return { from: fit.from, note: `Compared with ${fit.from === w.to ? w.to : `${fit.from} to ${w.to}`} only: all ${w.days} days before need more memory than this process has left.` };
    },
    privateCheck: () => {
      const bytes = bytesIn({ roots: d.roots, timezone: d.timezone, from: d.from, to: d.to });
      return fitsInMemory(bytes) ? null : `Show private text needs a second copy of these ${sizeText(bytes)} of logs in memory, more than this process has left.`;
    },
  });
  const weekData = (d) => {
    const base = { ...d, demo, selfTest, now, command, insights, codexJudge, settingsOpen: !elsewhere(), ...(buildHistory ? { buildHistory } : {}), ...(d.config?.saveResults?.on === true ? { onChecked: saver.onChecked } : {}) };
    // The demo week is small and fixed, so it loads at once, as it always has.
    const made = demo
      ? createViewData(base)
      : createProgressiveData({ from: d.from, to: d.to, timezone: d.timezone, roots: d.roots, make: (o) => createViewData({ ...base, ...o, ...guards({ ...d, from: o.from, to: o.to }) }) });
    made.start();
    return made;
  };
  // A config that turns up while Setup is open, from Setup or from init elsewhere, is loaded
  // once; the pages then reach the week instead of being sent back to Setup.
  let adopting = null;
  const adopt = () => (adopting ??= reload());
  let data = setupData
    ? weekData(setupData)
    : setupPendingData(command, async () => {
        if (findConfig({ cwd, flag: values['--config'] }).source === 'none') return null;
        await adopt().catch(() => {});
        return data;
      });
  let handle;
  const roots = defaultRoots(env);
  const zone = () => setupData?.timezone ?? hostTimezone();
  const logs = () => historyInfo({ roots, timezone: zone(), now: now(), maxBytes: limitOf(setupData?.config) * 1024 * 1024 });
  // Which days a choice on Setup or Settings would load, sized from file sizes alone.
  const planner = (params) => windowAnswer(params, { roots, timezone: zone(), now: now(), limitMB: limitOf(setupData?.config), zoneOk: validTimezone });
  // After Setup or Settings saves: the old data stops first (a build still reading runs no more
  // git), then the week loads from the file on disk and the same server, with the same key,
  // answers from it. Nothing it held, private text or cached replays, carries over.
  const reload = async () => {
    data.stop?.();
    let fresh;
    try {
      fresh = ownWeek({ values, cwd, env, now });
    } catch (err) {
      data = haltedData(command, String(err?.message ?? err).replace(/^view: /, ''));
      handle.setData(data);
      throw err;
    }
    setupData = fresh;
    insights.setOn(fresh.config.insights === true);
    data = weekData(fresh);
    handle.setData(data);
    io.out(`honestweek view: saved ${CONFIG_FILE}; now serving ${fresh.from} to ${fresh.to}.\n`);
    if (fresh.windowNote) io.out(`${fresh.windowNote}\n`);
    if (privateWordCount(fresh.config) === 0) io.out(`${privateWordsNote(currentCommand())}\n`);
    return { next: 'problems.html' };
  };
  // Setup mode: the Setup page writes the config with init's functions, then the week loads.
  // It can save for every folder when this run would read the user-level file.
  const setupFlow = setupData ? null : createSetup({ cwd, command, inferEmail, checkGoals: readGoalList, history: logs, onSaved: adopt, userConfig: lookupUserConfig(), configFound: () => findConfig({ cwd, flag: values['--config'] }).source !== 'none' });
  // Settings changes the config later. It's closed for the demo, during setup, and for a config
  // named with --config under another name.
  const settingsFlow = demo
    ? null
    : createSettings({
        cwd,
        configDir,
        checkGoals: readGoalList,
        history: logs,
        windowFor: (h, limit) => planner(paramsOfHistory(h, limit)).body,
        onSaved: reload,
        saved: () => saver.info(),
        editable: () => {
          if (setupFlow?.pending()) return 'Finish setup first.';
          if (elsewhere()) return `This run reads a config named with --config that isn't called ${CONFIG_FILE}, so Settings can't change it here.`;
          return null;
        },
      });
  const homePage = () => (setupFlow?.pending() ? SETUP_PAGE : (startAt?.page ?? ''));

  let openerDir = null;
  const removeOpener = () => {
    if (openerDir) rmSync(openerDir, { recursive: true, force: true });
    openerDir = null;
  };
  try {
    const actions = new Map([
      ['/api/insights/toggle', (body) => insights.toggle(body)],
      ['/api/insights/run', () => insights.run()],
      ['/api/insights/codex-run', () => codexJudge.run(data.codexWork?.() ?? null)],
      ['/api/saved/forget', () => saver.forget()],
    ]);
    handle = await startViewServer({ data, setup: setupFlow, settings: settingsFlow, planner: demo ? null : planner, actions, port, selfTest, onClaim: (purpose) => purpose === 'opener' && removeOpener(), ...(codeClock ? { now: codeClock } : {}) });
  } catch (err) {
    // The week's build has already started: it stops too, so a run that ends here reads no git.
    data.stop?.();
    cleanup();
    io.err(err?.code === 'EADDRINUSE' ? `view: port ${port} is already in use. Leave --port out to pick a free one, or choose another.\n` : `view: couldn't start the page server (${err?.message ?? err}).\n`);
    return 1;
  }
  cleanups.push(removeOpener);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // A build still reading stops too, so a stopped page runs no more git.
    data.stop?.();
    await handle.close();
    cleanup();
  };
  // Ctrl+C is caught from here on, before any line says it stops the page. Installed any later, a
  // Ctrl+C pressed as soon as the address printed would find no handler and end the process at
  // once: no cleanup, no exit code. A signal that arrives while the rest prints is handled when
  // this function first waits, after everything below has run.
  let stopRequested = null;
  if (block) {
    stopRequested = new Promise((resolveStop) => {
      // Closing the terminal sends SIGHUP (on Windows too); Ctrl+Break sends SIGBREAK there.
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
      const onSignal = () => {
        for (const sig of signals) process.off(sig, onSignal);
        stop().then(() => {
          io.out('\nhonestweek view: stopped.\n');
          resolveStop();
        });
      };
      for (const sig of signals) process.on(sig, onSignal);
    });
  }

  if (setupFlow) io.out(`honestweek view: there's no ${CONFIG_FILE} in ${cwd}, so setup is open in your browser at ${handle.url} (Ctrl+C stops it). For scripts and CI, ${currentCommand()} init still works.\n`);
  else io.out(`honestweek view: serving ${demo ? 'the made-up demo week' : `${setupData.from} to ${setupData.to}`} at ${handle.url} (Ctrl+C stops it).\n`);
  if (setupData?.windowNote) io.out(`${setupData.windowNote}\n`);
  if (!demo && setupData && privateWordCount(setupData.config) === 0) io.out(`${privateWordsNote(currentCommand(), { settings: !elsewhere() })}\n`);
  if (!noOpen) {
    try {
      openerDir = mkdtempSync(join(tmpdir(), 'honestweek-view-'));
      const file = join(openerDir, 'open.html');
      writeFileSync(file, redirectPage(handle.address('opener', homePage(), { ttlMs: openerTtlMs })), { mode: 0o600 });
      const expire = setTimeout(() => {
        try {
          removeOpener();
        } catch {
          /* the code has expired anyway; stopping tries the folder again */
        }
      }, openerTtlMs);
      expire.unref?.();
      cleanups.push(() => clearTimeout(expire));
      opener(file, { platform, env });
      io.out("Opening your browser. If it doesn't open, use the address below.\n");
    } catch {
      removeOpener();
      io.out("Couldn't open your browser.\n");
    }
  }
  // A printed address can sit in terminal scrollback, so its code lasts printedTtlMs, not until used.
  const printed = (page) => handle.address('printed', page, { ttlMs: printedTtlMs });
  io.out(`Open this address in your browser: ${printed(homePage())}\n`);
  // --page waits for Setup, which goes to Problems once saved, so say how to reach the page after it.
  if (startAt?.page && setupFlow?.pending()) io.out(`Setup comes first. Once it's saved, type link ${startAt.page} here for an address to that page.\n`);
  if (selfTest) io.out(`The click-through test: ${printed(SELF_TEST_PAGE)}\n`);
  io.out(`Each address works once, within ${lifetime(printedTtlMs)}. Press Enter here to print a fresh one.\n`);

  let rl = null;
  if (input && typeof input.on === 'function') {
    rl = createInterface({ input, terminal: false });
    rl.on('line', (line) => {
      // "link <page>": a fresh one-time address to that page (issue 198). Anything else, Enter
      // included, prints a fresh address as before.
      const asked = /^\s*link\s+(\S.*)$/.exec(String(line ?? ''));
      if (asked) {
        const target = pageLink(asked[1]);
        if (target.error) io.out(`No link: ${target.error}\n`);
        else if (setupFlow?.pending()) io.out('No link yet: finish Setup first, then ask again.\n');
        else io.out(`Link: ${printed(target.page)}\n`);
        return;
      }
      io.out(`Fresh address: ${printed(homePage())}\n`);
      if (selfTest) io.out(`Fresh click-through test: ${printed(SELF_TEST_PAGE)}\n`);
    });
    rl.on('error', () => {});
    cleanups.push(() => rl.close());
  }

  const onExit = () => cleanup();
  process.once('exit', onExit);
  cleanups.push(() => process.off('exit', onExit));

  if (typeof onServe === 'function') onServe({ ...handle, data, currentData: () => data, setup: setupFlow, insights, stop, openerFile: () => (openerDir ? join(openerDir, 'open.html') : null), demo, demoRoot, window: setupData ? { from: setupData.from, to: setupData.to, timezone: setupData.timezone } : null });
  if (!block) return 0;

  await stopRequested;
  return 0;
}

export default function run(argv, io) {
  return runView({ argv, ...(io ? { io } : {}) });
}
