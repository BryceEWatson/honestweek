// lib/view/progressive.mjs: a window of more than one day, loaded newest day first.
//
// `honestweek view` reads a window of logs into memory before a page can answer. A busy week can
// be a gigabyte of logs, so this loads the newest day on its own first, and the pages answer from
// it while the whole window loads behind it. Until the whole window is in, every answer says it
// covers only that day (lib/view/data.mjs, `partial`): the window in the header, a quiet line
// with how far the rest has got, every "nothing found", and the trend, which waits. When the
// whole window is ready it takes over, and the first day's data is let go.
//
// The whole window is one build, read once, rather than seven days built apart and merged: a
// session that runs past midnight, a link between two days and a goal's members all need the
// whole window at once, and on a measured 1.2 GB week the build's peak was only a quarter above
// what it keeps (docs/local-page.md). What must fit is checked first: when the whole window needs
// more memory than this process has left, it loads the newest days that fit and says which.
//
// Zero runtime dependencies.

import { bytesIn, fitsInMemory, HEAP_PER_MB, logFiles, memoryRoom, sizeText } from './window.mjs';

const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * The days of [from, to] that fit in `room` bytes of memory, newest first: { from, cut, note }.
 * `cut` is true when older days are left out; `files` are { day, size } as logFiles lists them.
 */
export function fitWindow({ from, to, files, room }) {
  const all = bytesIn({ files, from, to });
  if (fitsInMemory(all, room)) return { from, cut: false, note: null, bytes: all };
  let start = to;
  for (let day = to; day >= from; day = shift(day, -1)) {
    if (!fitsInMemory(bytesIn({ files, from: day, to }), room)) break;
    start = day;
  }
  const bytes = bytesIn({ files, from: start, to });
  const note = `Loaded ${start === to ? to : `${start} to ${to}`}: all of ${from} to ${to} (${sizeText(all)} of logs) needs more memory than this process has left (${sizeText(room / HEAP_PER_MB)}). Start it with more, such as node --max-old-space-size=8192, to load the rest.`;
  return { from: start, cut: start > from, note, bytes };
}

/**
 * createProgressiveData({ from, to, timezone, roots, make, room, files }) -> the same shape as
 * createViewData: { start, stop, status, route, leakCheck, codexWork, routes }.
 *   make(options)  createViewData with the run's other options, given { from, to } and `queries`
 *                  (shared by both); for the first day, `partial`; for the whole window, `onProgress`.
 *   room()         memory left, in bytes (tests pass a fixed number).
 *   files          the log files, { day, size }, when the caller has listed them already.
 * A window of one day is just that day, loaded once.
 */
export function createProgressiveData({ from, to, timezone, roots, make, room = memoryRoom, files = null }) {
  if (from >= to) return make({ from, to });
  let progress = null;
  let failed = null;
  const partial = { from, to, progress: () => progress, failed: () => failed };
  // What was typed while the first day showed, kept for the whole window: a page's address names
  // a search by its id, and the page reloads when every day is in.
  const queries = { byId: new Map(), byText: new Map() };
  let first = make({ from: to, to, partial, queries });
  let whole = null;
  let current = first;
  let stopped = false;
  let wantPrivate = false;
  // Fires once, when the first day's redacted build has settled either way.
  let loading = null;

  function loadWhole() {
    if (loading || stopped) return loading;
    const list = files ?? logFiles(roots, timezone);
    const fit = fitWindow({ from, to, files: list, room: room() });
    loading = Promise.resolve().then(() => {
      if (stopped) return;
      whole = make({ from: fit.from, to, ...(fit.note ? { windowNote: fit.note } : {}), onProgress: (p) => (progress = p), queries });
      return whole.start();
    }).then(() => {
      if (stopped || !whole) return;
      const s = whole.status();
      if (s.state !== 'ready') {
        failed = s.failed ?? 'the build stopped';
        whole.stop?.();
        whole = null;
        return;
      }
      // The whole window takes over; the first day's data goes, and with it its memory.
      current = whole;
      if (wantPrivate) whole.start('private');
      first.stop?.();
      first = null;
    }, (err) => {
      failed = String(err?.message ?? err).split('\n')[0];
    });
    return loading;
  }

  return {
    start(mode = 'redacted') {
      if (mode === 'private') wantPrivate = true;
      const p = current.start(mode);
      if (mode === 'redacted' && current === first) Promise.resolve(p).then(loadWhole, loadWhole);
      return p;
    },
    stop() {
      stopped = true;
      first?.stop?.();
      whole?.stop?.();
    },
    status: () => current.status(),
    route(path, params) {
      if (params?.get?.('private') === '1') wantPrivate = true;
      return current.route(path, params);
    },
    leakCheck: (text, params) => current.leakCheck(text, params),
    codexWork: () => current.codexWork?.() ?? null,
    get routes() {
      return current.routes;
    },
    /** For tests: whether the whole window has taken over, and its load. */
    loaded: () => (current === whole ? 'whole' : 'first'),
    whenWhole: () => loading ?? Promise.resolve(),
  };
}

