// lib/view/page-link.mjs: which page, query and step a one-time address from `view` may open
// (issue 198), so an agent or a person can hand someone a link straight to a session or a step.
//
// Only view's own pages are accepted, never a path: nothing here joins a path from the request,
// and the server serves a fixed list of files anyway. The query is parsed and written back
// encoded, with plain keys only. The part after `#` is the replay page's thread and step, so it
// takes ids only: letters, digits and `_ . ~ : -`, which also keeps out an `&c=` that would
// pose as the one-time code key.js reads from that same part of the address. Search is the one
// page with a part of its own: the id of a search this run keeps in memory (#q=<id>~l or ~w,
// as search.js writes it), and no query, since its address never holds what was typed.

/** The pages a link may open. Setup has its own flow, and the self-test its own address. */
export const LINK_PAGES = Object.freeze(['problems.html', 'replay.html', 'search.html', 'goal.html', 'settings.html']);

const KEY = /^[A-Za-z]{1,24}$/;
const FRAGMENT = /^[A-Za-z0-9_.~:-]{1,300}$/;
/** Search's own part after `#`: a search id this run gave out (QUERY_ID_RE in data.mjs). */
const SEARCH_FRAGMENT = /^q=q[a-p]{16}(?:~[lw])?$/;

/** The page's own ids, as `ID` in lib/view/assets/common.js has them (a test keeps the two the same). */
export const PAGE_IDS = Object.freeze({
  thread: /^th-[a-p]{4,64}$/,
  session: /^[a-z]{2,4}-[a-p]{4,64}$/,
  event: /^[a-z]{2,4}-[a-p]{4,64}(?:[.:][A-Za-z0-9_-]{1,80}){0,6}$/,
  goal: /^(?:[a-z]{1,4}-)?[a-p]{4,64}$/,
});
const isId = (kind, v) => typeof v === 'string' && v.length <= 300 && PAGE_IDS[kind].test(v);

/**
 * replayPage({ session, thread, event }) -> 'replay.html?session=<id>#<thread>~<step>' | null
 * A session's replay, or one step of it, built the way the Problems page builds its own links:
 * ids only, so null for anything that isn't one of the page's ids.
 */
export function replayPage({ session, thread = null, event = null } = {}) {
  if (!isId('session', session)) return null;
  const t = isId('thread', thread) ? thread : '';
  const e = isId('event', event) ? `~${event}` : '';
  return `replay.html?session=${encodeURIComponent(session)}${t || e ? `#${t}${e}` : ''}`;
}

/**
 * zoomPage(finding) -> 'replay.html?session=<id>#<thread>~zoom~<finding key>' | null
 * The replay zoomed to the steps a finding's check recorded, in its own thread's lane when it has
 * one, else its first: the same link the Problems page builds (zoomHref in assets/problems.js).
 */
export function zoomPage(f) {
  const lanes = f?.zoom?.lanes;
  if (!/^pf-[a-p]{12}$/.test(f?.key ?? '') || !Array.isArray(lanes) || !lanes.length) return null;
  const lane = lanes.find((l) => l.thread === f.thread) ?? lanes[0];
  if (!isId('session', lane?.session) || !isId('thread', lane?.thread)) return null;
  return `replay.html?session=${encodeURIComponent(lane.session)}#${lane.thread}~zoom~${f.key}`;
}

/** A goal's page, 'goal.html#<key>', or null. */
export const goalPage = (key) => (isId('goal', key) ? `goal.html#${key}` : null);

/** The Problems page narrowed to one session's findings, 'problems.html?session=<key>', or null. */
export const problemsPage = (session) => (isId('session', session) ? `problems.html?session=${encodeURIComponent(session)}` : null);

/**
 * pageLink(text) -> { page } | { error }
 * `page` is what follows the server's address: a page name, an optional `?query` and an
 * optional `#fragment`, or '' for the Problems page. `error` is one plain line.
 */
export function pageLink(text) {
  const raw = String(text ?? '').trim().replace(/^\/+/, '');
  if (!raw) return { page: '' };
  const hashAt = raw.indexOf('#');
  const head = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : raw.slice(hashAt + 1);
  const queryAt = head.indexOf('?');
  const name = queryAt < 0 ? head : head.slice(0, queryAt);
  if (!LINK_PAGES.includes(name)) return { error: `${JSON.stringify(name.slice(0, 80))} isn't one of view's pages: ${LINK_PAGES.join(', ')}.` };
  const params = new URLSearchParams(queryAt < 0 ? '' : head.slice(queryAt + 1));
  for (const key of params.keys()) {
    if (!KEY.test(key)) return { error: `${JSON.stringify(key.slice(0, 40))} isn't a key view's pages read.` };
  }
  const query = params.toString();
  if (name === 'search.html') {
    if (query) return { error: "Search takes no query: its address never holds what was typed. Copy a search's address from the page, #q= and all." };
    if (fragment && !SEARCH_FRAGMENT.test(fragment)) return { error: "Search's part after # can only be a search's own id, as the page's address shows it (#q=<id>~w)." };
  } else if (fragment && !FRAGMENT.test(fragment)) return { error: 'the part after # can hold only ids (letters, digits, and _ . ~ : -).' };
  return { page: `${name}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}` };
}
