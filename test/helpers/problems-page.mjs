// Runs the Problems page's script (lib/view/assets/problems.js) in a sandbox with a stand-in
// page: every element is a plain object that keeps the markup the script gives it, so a test
// reads what each view draws for a given /api/problems answer and address. The real evidence.js
// and prefs.js load with it; the shared page code (common.js) is stood in by the few helpers
// problems.js uses, with its real clip() and clipHtml(), so a cut never lands inside a
// placeholder.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ASSETS = fileURLToPath(new URL('../../lib/view/assets/', import.meta.url));
const read = (f) => readFileSync(join(ASSETS, f), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** common.js's own clip() and clipHtml(), taken from its source. */
function clipFns() {
  const common = read('common.js');
  const tokenChar = common.match(/const TOKEN_CHAR = [^\n]+;/)[0];
  const clip = common.match(/function clip\(s, n\) \{[^]*?\n {2}\}/)[0];
  const clipHtml = common.match(/const clipHtml = \(s, n\) => \{[^]*?\n {2}\};/)[0];
  const box = { esc };
  runInNewContext(`${tokenChar}\n${clip}\n${clipHtml}\nthis.clip = clip; this.clipHtml = clipHtml;`, box);
  return { clip: box.clip, clipHtml: box.clipHtml };
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function fakeEl(id) {
  const classes = new Set();
  const heard = {};
  return {
    id,
    innerHTML: '',
    textContent: '',
    hidden: false,
    title: '',
    dataset: {},
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => (heard[type] ??= []).push(fn),
    /** Hand the page's own listeners an event, as a click or a change on this element would. */
    fire: (type, ev) => (heard[type] ?? []).forEach((fn) => fn(ev)),
    setAttribute: () => {},
    focus: () => {},
    closest: () => null,
  };
}

const ID = {
  thread: /^th-[a-p]{4,64}$/,
  session: /^[a-z]{2,4}-[a-p]{4,64}$/,
  event: /^[a-z]{2,4}-[a-p]{4,64}(?:[.:][A-Za-z0-9_-]{1,80}){0,6}$/,
  goal: /^(?:[a-z]{1,4}-)?[a-p]{4,64}$/,
};

/**
 * Draw the page for one answer. `hash` and `search` are the address's parts ("#checked",
 * "?session=…"); `trend` is the /api/problems?trend=1 answer, or null for one that fails.
 * Answers { el, doc, sandbox }: el(id) is the element with that id, holding what was drawn.
 */
export async function drawProblems(D, { hash = '', search = '', trend = null, storage = memStorage() } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, fakeEl(id));
    return els.get(id);
  };
  const doc = { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, readyState: 'complete', body: { dataset: {} }, title: '', activeElement: null };
  const sandbox = {
    document: doc,
    location: { hash, search, pathname: '/problems.html', href: `http://127.0.0.1:1/problems.html${search}${hash}` },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
    URLSearchParams,
    CSS: { escape: (s) => String(s) },
    localStorage: storage,
    scrollY: 0,
    scrollTo: () => {},
    addEventListener: () => {},
    setTimeout: () => 0,
    console,
  };
  sandbox.window = sandbox;
  runInNewContext(read('evidence.js'), sandbox);
  let run = null;
  const { clip, clipHtml } = clipFns();
  sandbox.HW = {
    esc,
    chip: sandbox.HWE.chip,
    sym: sandbox.HWE.sym,
    isId: (kind, v) => typeof v === 'string' && v.length <= 300 && ID[kind].test(v),
    pct: (x) => `${Math.floor(x * 100)}%`,
    time: (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' '),
    clip,
    clipHtml,
    shell: { window: null },
    start: (fn) => {
      run = fn;
    },
    load: async (route, q = {}) => {
      if (q.trend) {
        if (!trend) throw new Error('no trend here');
        return trend;
      }
      return D;
    },
    navCount: () => {},
    fatal: (html) => {
      throw new Error(`fatal: ${html}`);
    },
  };
  runInNewContext(read('prefs.js'), sandbox);
  runInNewContext(read('problems.js'), sandbox);
  await run();
  // Let the trend's answer settle.
  await new Promise((r) => setImmediate(r));
  return { el, doc, sandbox };
}

/** The markup of each element of a class in an HTML string, by its opening tag's class list. */
export function blocks(html, tag, cls) {
  const out = [];
  const open = new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'g');
  for (const m of html.matchAll(open)) {
    // The block runs to its own closing tag, counting nested ones of the same name.
    let depth = 0;
    const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
    re.lastIndex = m.index;
    let end = html.length;
    for (let t = re.exec(html); t; t = re.exec(html)) {
      depth += t[0] === `</${tag}>` ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    out.push(html.slice(m.index, end));
  }
  return out;
}

/** The words a reader sees in some markup: tags gone, entities read, spaces collapsed. */
export const words = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
