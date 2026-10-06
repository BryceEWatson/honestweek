// What a build of the launch fixture's logs reads as: the history's sessions, links, rules and
// events, and the local page's answers that name what started a session. The before-reading
// test compares the build with no launch steps against the reading kept from before the launch
// join existed (test/fixtures/program-launch-before.json).

import { buildWorkHistory } from '../../../lib/replay/index.mjs';
import { createViewData } from '../../../lib/view/data.mjs';
import { WINDOW } from './program-launch.mjs';

/** Byte offsets, record digests and file keys depend on the folder's path, so they're left
 *  out, and the folder itself becomes <root>. */
function normalize(x, root) {
  const drop = new Set(['off', 'len', 'digest', 'fileKey', 'fileKeys']);
  const s = JSON.stringify(x, (k, v) => (drop.has(k) ? undefined : v));
  return JSON.parse([root, root.replace(/\\/g, '/'), JSON.stringify(root).slice(1, -1)].reduce((out, r) => out.split(r).join('<root>'), s));
}

export async function readLaunchWeek(w) {
  const h = await buildWorkHistory({ config: w.config, from: WINDOW.from, to: WINDOW.to, roots: w.roots, git: false });
  const data = createViewData({ config: w.config, roots: w.roots, from: WINDOW.from, to: WINDOW.to, timezone: WINDOW.timezone });
  await data.start();
  const ask = async (path, q = {}) => (await data.route(path, new URLSearchParams(q))).body;
  const list = await ask('/api/sessions');
  const days = [];
  for (const d of list.days) {
    const more = d.more.value ? await ask('/api/sessions', { day: d.day, offset: String(d.rows.length) }) : null;
    days.push({ ...d, rows: [...d.rows, ...(more?.rows ?? [])] });
  }
  const home = await ask('/api/home');
  const replays = {};
  for (const k of [w.key.launcher, w.key.byId, w.key.codexPlain, w.key.legacyChild]) replays[k] = await ask('/api/replay', { session: k });
  data.stop();
  return normalize({ sessions: h.sessions, links: h.links, rules: h.rules, threads: h.threads, events: h.events, api: { sessions: { ...list, days }, home, replays } }, w.root);
}
