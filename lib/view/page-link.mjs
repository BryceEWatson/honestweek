// lib/view/page-link.mjs: which page, query and step a one-time address from `view` may open
// (issue 198), so an agent or a person can hand someone a link straight to a session or a step.
//
// Only view's own pages are accepted, never a path: nothing here joins a path from the request,
// and the server serves a fixed list of files anyway. The query is parsed and written back
// encoded, with plain keys only. The part after `#` is the replay page's thread and step, so it
// takes ids only: letters, digits and `_ . ~ : -`, which also keeps out an `&c=` that would
// pose as the one-time code key.js reads from that same part of the address.

/** The pages a link may open. Setup has its own flow, and the self-test its own address. */
export const LINK_PAGES = Object.freeze(['problems.html', 'replay.html', 'search.html', 'goal.html', 'settings.html']);

const KEY = /^[A-Za-z]{1,24}$/;
const FRAGMENT = /^[A-Za-z0-9_.~:-]{1,300}$/;

/**
 * pageLink(text) -> { page } | { error }
 * `page` is what follows the server's address: a page name, an optional `?query` and an
 * optional `#fragment`, or '' for the Problems page. `error` is one plain line.
 */
export function pageLink(text, { pages = LINK_PAGES } = {}) {
  const raw = String(text ?? '').trim().replace(/^\/+/, '');
  if (!raw) return { page: '' };
  const hashAt = raw.indexOf('#');
  const head = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : raw.slice(hashAt + 1);
  const queryAt = head.indexOf('?');
  const name = queryAt < 0 ? head : head.slice(0, queryAt);
  if (!pages.includes(name)) return { error: `${JSON.stringify(name.slice(0, 80))} isn't one of view's pages: ${pages.join(', ')}.` };
  const params = new URLSearchParams(queryAt < 0 ? '' : head.slice(queryAt + 1));
  for (const key of params.keys()) {
    if (!KEY.test(key)) return { error: `${JSON.stringify(key.slice(0, 40))} isn't a key view's pages read.` };
  }
  if (fragment && !FRAGMENT.test(fragment)) return { error: 'the part after # can hold only ids (letters, digits, and _ . ~ : -).' };
  const query = params.toString();
  return { page: `${name}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}` };
}
