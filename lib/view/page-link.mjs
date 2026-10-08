// lib/view/page-link.mjs: which page, query and step a one-time address from `view` may open
// (issue 198), so an agent or a person can hand someone a link straight to a session or a step.
//
// Only view's own pages are accepted, never a path: nothing here joins a path from the request,
// and the server serves a fixed list of files anyway. The query is parsed and written back
// encoded, with plain keys only. The part after `#` is the replay page's thread and step, so it
// takes ids only: letters, digits and `_ . ~ : -`, which also keeps out an `&c=` that would
// pose as the one-time code key.js reads from that same part of the address.

/** The pages a link may open. Setup has its own flow, and the self-test its own address. Search
 *  isn't one: it keeps its search where a link can't carry it, so a link would open it empty. */
export const LINK_PAGES = Object.freeze(['problems.html', 'replay.html', 'goal.html', 'settings.html']);

const KEY = /^[A-Za-z]{1,24}$/;
const FRAGMENT = /^[A-Za-z0-9_.~:-]{1,300}$/;

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

/** A goal's page, 'goal.html#<key>', or null. */
export const goalPage = (key) => (isId('goal', key) ? `goal.html#${key}` : null);

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
  if (fragment && !FRAGMENT.test(fragment)) return { error: 'the part after # can hold only ids (letters, digits, and _ . ~ : -).' };
  const query = params.toString();
  return { page: `${name}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}` };
}
