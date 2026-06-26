// lib/preview.mjs — the `preview` subcommand: render the built Markdown output as
// HTML and serve it on a loopback (127.0.0.1) server, then open your browser.
//
// preview is a local VIEWER, not a producer. It reads the already-built
// output.file (what `build` wrote, and what you would publish), converts its
// Markdown to a self-contained HTML page (inline CSS, ZERO external resources),
// and serves it on 127.0.0.1 only. Nothing leaves your machine and nothing is
// published. It never re-runs build, never calls git, and never writes a file.
//
// Zero runtime dependencies: Node built-ins only (node:http, node:fs, node:path,
// node:child_process). The browser is opened with the OS-native opener
// (start / open / xdg-open), the same "system command" posture as the git CLI.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';

import { loadConfig, DEFAULT_OUTPUT_FILES } from './config.mjs';

const CONFIG_FILE = 'honestweek.config.json';
const LOOPBACK = '127.0.0.1';

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
}

// ---------------------------------------------------------------------------
// Markdown -> HTML (zero-dep, scoped to exactly what honestweek's emitters emit)
//
// The emit layer produces a tiny, fully-enumerable subset: `#`/`##` headings,
// single-level `- ` bullets, `**bold**`, `_italic_`, single-backtick `code`, a
// `> ` blockquote, em/en-dash separators (content, not syntax), and the
// changelog's `<!-- ... -->` marker lines. We escape FIRST so user-derived item
// text can never inject markup, then parse blocks, then inline spans. A fenced
// code block is handled defensively (emit never produces one, but a hand-edited
// changelog might).
// ---------------------------------------------------------------------------

/** HTML-escape text. Runs BEFORE any markdown interpretation, so the only tags
 *  in the output are ones this converter inserts — never user text. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Bold + italic on a run of ALREADY-ESCAPED, non-code text. */
function emphasize(text) {
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    // `_italic_`: the `_` must be flanked by a boundary so intraword underscores
    // (e.g. some_snake_case in item text) are left literal.
    .replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
}

/** Inline spans on ALREADY-ESCAPED text. Code spans are split out first and held
 *  literal, so a `**` or `_` inside a backticked receipt is never mis-emphasized. */
function renderInline(escaped) {
  return escaped
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.length >= 2 && part.startsWith('`') && part.endsWith('`')
        ? `<code>${part.slice(1, -1)}</code>`
        : emphasize(part)
    )
    .join('');
}

/** Convert honestweek's emitted Markdown to an HTML body fragment. Pure. */
export function mdToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let listOpen = false;
  let quoteOpen = false;
  let paraBuf = [];
  let inCode = false;
  let codeBuf = [];

  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  const closeQuote = () => {
    if (quoteOpen) {
      out.push('</blockquote>');
      quoteOpen = false;
    }
  };
  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${paraBuf.map((l) => renderInline(escapeHtml(l))).join('<br>\n')}</p>`);
      paraBuf = [];
    }
  };
  const closeBlocks = () => {
    flushPara();
    closeList();
    closeQuote();
  };

  for (const line of lines) {
    // Fenced code block (defensive — emit never produces one). Passthrough
    // verbatim, escaped, with NO inline parsing of its contents.
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.map(escapeHtml).join('\n')}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeBlocks();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // A pure HTML-comment line (the changelog week markers) renders as nothing.
    if (/^\s*<!--[\s\S]*?-->\s*$/.test(line)) continue;

    // Blank line: close whatever block is open.
    if (line.trim() === '') {
      closeBlocks();
      continue;
    }

    // ATX heading (# .. ######).
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeBlocks();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(h[2].trim()))}</h${level}>`);
      continue;
    }

    // Blockquote line(s) — coalesce consecutive ones.
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara();
      closeList();
      if (!quoteOpen) {
        out.push('<blockquote>');
        quoteOpen = true;
      }
      out.push(`<p>${renderInline(escapeHtml(bq[1]))}</p>`);
      continue;
    }

    // Unordered list item — coalesce consecutive ones into one <ul>.
    const li = line.match(/^[-*+]\s+(.*)$/);
    if (li) {
      flushPara();
      closeQuote();
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${renderInline(escapeHtml(li[1]))}</li>`);
      continue;
    }

    // Anything else: accumulate into a paragraph.
    closeList();
    closeQuote();
    paraBuf.push(line);
  }
  if (inCode) {
    // Unterminated fence — flush what we have rather than drop it.
    out.push(`<pre><code>${codeBuf.map(escapeHtml).join('\n')}</code></pre>`);
  }
  closeBlocks();
  return out.join('\n');
}

/** A human title for the page: the first H1, else the week range, else a default. */
export function titleFromMarkdown(markdown) {
  const h1 = String(markdown).match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const range = String(markdown).match(/\((\d{4}-\d{2}-\d{2})\s*[–-]\s*(\d{4}-\d{2}-\d{2})\)/);
  if (range) return `honestweek: ${range[1]} to ${range[2]}`;
  return 'honestweek preview';
}

/** Wrap an HTML body fragment in a self-contained document. No external
 *  resources: inline <style> only, system fonts, dark/light via media query. */
export function renderPage(bodyHtml, { title } = {}) {
  const safeTitle = escapeHtml(title || 'honestweek preview');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root { --bg:#ffffff; --fg:#1b1b1f; --muted:#5b5b66; --code-bg:#f1f1f4; --border:#e3e3e9; --quote:#6a6a76; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16161a; --fg:#e7e7ec; --muted:#a1a1ae; --code-bg:#262630; --border:#33333e; --quote:#9b9ba8; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); line-height:1.6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:46rem; margin:0 auto; padding:2.5rem 1.25rem 4rem; }
h1 { font-size:1.7rem; line-height:1.25; margin:0 0 .5rem; }
h2 { font-size:1.2rem; margin:2rem 0 .5rem; padding-bottom:.2rem; border-bottom:1px solid var(--border); }
h3 { font-size:1.05rem; margin:1.5rem 0 .4rem; }
ul { padding-left:1.25rem; }
li { margin:.3rem 0; }
p { margin:.6rem 0; }
strong { font-weight:650; }
em { color:var(--muted); font-style:italic; }
code { background:var(--code-bg); padding:.1rem .35rem; border-radius:.3rem; font-size:.9em;
  font-family:ui-monospace,"Cascadia Code",Consolas,"Liberation Mono",monospace; }
pre { background:var(--code-bg); padding:1rem; border-radius:.5rem; overflow:auto; }
pre code { background:none; padding:0; }
blockquote { margin:1rem 0; padding:.4rem 1rem; border-left:3px solid var(--border); color:var(--quote); }
.hw-footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--border); color:var(--muted); font-size:.85rem; }
</style>
</head>
<body>
<main>
${bodyHtml}
<p class="hw-footer">Local preview served by honestweek on 127.0.0.1. Nothing here is published or sent anywhere.</p>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Loopback server + cross-platform browser open (zero-dep)
// ---------------------------------------------------------------------------

/** The OS-native browser-open command. Pure, so it is unit-testable per platform.
 *  The win32/WSL `start` form needs an empty "" title placeholder, else a URL
 *  with `&` (a query string) is mis-parsed as the window title. */
export function browserOpenCommand(platform, url, { isWsl = false } = {}) {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (isWsl) return { cmd: 'cmd.exe', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

function isWslEnv(env) {
  return Boolean(env && (env.WSL_DISTRO_NAME || env.WSL_INTEROP));
}

/** Open `url` in the default browser. Fails SOFT: a missing opener (headless box,
 *  no xdg-open) surfaces asynchronously as a child 'error' event, which we
 *  swallow — preview keeps serving and the URL was already printed. */
export function defaultOpener(url, { platform = process.platform, env = process.env } = {}) {
  const { cmd, args } = browserOpenCommand(platform, url, { isWsl: isWslEnv(env) });
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* never crash on an open failure */
  }
}

/**
 * startServer({ host, port, html }) -> Promise<{ server, url, port, host, close }>
 * Binds loopback ONLY (host defaults to 127.0.0.1), serves `html` at `/` with a
 * strict CSP that ENFORCES the "no external resources" promise, and 404s the
 * rest. Resolves once listening (port 0 yields an OS-assigned free port).
 */
export function startServer({ host = LOOPBACK, port = 0, html = '', csp = "default-src 'none'; style-src 'unsafe-inline'" } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const method = req.method || 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
        res.end('405 method not allowed\n');
        return;
      }
      const path = (req.url || '/').split('?')[0];
      if (path !== '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 not found\n');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // default-src 'none' blocks every external fetch; only inline CSS (and, for
        // the interactive standalone page, inline JS) is allowed. This turns "no
        // egress from the page" into a guarantee the browser enforces, not just a
        // code-review promise — the page's interactivity is inline, never fetched.
        'Content-Security-Policy': csp,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(method === 'HEAD' ? undefined : html);
    });
    server.on('error', reject);
    server.listen({ host, port }, () => {
      const addr = server.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : port;
      resolve({
        server,
        url: `http://${host}:${boundPort}/`,
        port: boundPort,
        host,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Subcommand handler
// ---------------------------------------------------------------------------

function parseValued(argv, name) {
  const eq = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(eq)) return argv[i].slice(eq.length);
  }
  return undefined;
}

const HELP = `honestweek preview: serve the built output as HTML on a local-only server.

Usage:
  honestweek preview [--file <path>] [--port <n>] [--no-open]

Reads what build wrote (config.output.file, or --file <path>). A Markdown output
is converted to a self-contained HTML page; the standalone "page" mode already
wrote complete HTML, so it is served verbatim (with its inline interactivity).
Either way it is served on 127.0.0.1 (loopback only) under a no-external-egress
CSP. Nothing is published and nothing leaves your machine.

Options:
  --file <path>  Preview this Markdown file instead of the configured output.file.
  --port <n>     Bind this port (default: an OS-assigned free port).
  --no-open      Do not launch a browser; just print the URL.
  -h, --help     Show this help.
`;

/**
 * runPreview({ cwd, argv, io, opener, platform, env, block, onServe }) -> exit code.
 *
 * 0 on success; 1 on a setup error (no config + no --file, output file absent,
 * bad --port, port in use). It NEVER returns 2 — preview renders, it never
 * judges. When `block` is true (the CLI default) it serves until Ctrl-C. Tests
 * pass `block: false` (and read the live handle via `onServe`) so they never
 * enter the blocking serve loop.
 */
export async function runPreview({
  cwd = process.cwd(),
  argv = [],
  io = defaultIo(),
  opener = defaultOpener,
  platform = process.platform,
  env = process.env,
  block = true,
  onServe,
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(HELP);
    return 0;
  }
  const noOpen = argv.includes('--no-open');

  // Resolve the Markdown source: --file wins; otherwise the configured output.
  const fileArg = parseValued(argv, '--file');
  let mdPath;
  if (fileArg) {
    mdPath = isAbsolute(fileArg) ? fileArg : join(cwd, fileArg);
  } else {
    let config;
    try {
      config = loadConfig(join(cwd, CONFIG_FILE));
    } catch (err) {
      io.err(`preview: ${err.message}\n`);
      io.err(`preview: no ${CONFIG_FILE} to read output.file from. Run init, or pass --file <path>.\n`);
      return io.exit(1) ?? 1;
    }
    const mode = config.output?.mode ?? 'digest';
    const file = config.output?.file || DEFAULT_OUTPUT_FILES[mode];
    mdPath = isAbsolute(file) ? file : join(cwd, file);
  }

  if (!existsSync(mdPath)) {
    io.err(`preview: output file not found at ${mdPath}. Run \`honestweek build\` first (or pass --file <path>).\n`);
    return io.exit(1) ?? 1;
  }

  let port = 0;
  const portArg = parseValued(argv, '--port');
  if (portArg !== undefined) {
    const n = Number(portArg);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      io.err(`preview: --port must be an integer 1..65535 (got ${JSON.stringify(portArg)}).\n`);
      return io.exit(1) ?? 1;
    }
    port = n;
  }

  let source;
  try {
    source = readFileSync(mdPath, 'utf8');
  } catch (err) {
    io.err(`preview: could not read ${mdPath} (${err.message}).\n`);
    return io.exit(1) ?? 1;
  }

  // The `page` mode (standalone site) already wrote a COMPLETE, self-contained HTML
  // document — serve it verbatim, with a CSP that also permits its inline <script>
  // (still zero external egress). Every other mode wrote Markdown, which we convert
  // to a locked-down (no-script) HTML page.
  const isHtml = /\.html?$/i.test(mdPath);
  const html = isHtml ? source : renderPage(mdToHtml(source), { title: titleFromMarkdown(source) });
  const csp = isHtml
    ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    : "default-src 'none'; style-src 'unsafe-inline'";

  let handle;
  try {
    handle = await startServer({ host: LOOPBACK, port, html, csp });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      io.err(`preview: port ${port} is already in use. Omit --port to pick a free one, or choose another.\n`);
    } else {
      io.err(`preview: could not start the preview server (${err.message}).\n`);
    }
    return io.exit(1) ?? 1;
  }

  io.out(`honestweek preview: serving ${mdPath} at ${handle.url} (press Ctrl+C to stop).\n`);
  if (typeof onServe === 'function') onServe(handle);
  if (!noOpen) opener(handle.url, { platform, env });

  if (!block) return 0;

  await new Promise((resolve) => {
    process.once('SIGINT', () => {
      handle.close().then(() => {
        io.out('\nhonestweek preview: stopped.\n');
        resolve();
      });
    });
  });
  return 0;
}

export default function run(argv) {
  return runPreview({ argv });
}
