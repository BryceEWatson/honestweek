#!/usr/bin/env node
// tools/synthetic-week.mjs: a large made-up week of logs, for measuring how long `honestweek view`
// takes to load a week and how much memory it needs.
//
//   node tools/synthetic-week.mjs <out-dir> <copies> [--to YYYY-MM-DD] [--pad <n>]
//
// It writes the demo week (lib/demo/week.mjs) into <out-dir>, then copies its Claude Code and
// Codex logs <copies> times into the 7 days ending on --to (default today, in UTC), each copy
// with its own session ids, so every copy is a separate set of sessions. --pad n repeats each
// tool result's text n more times, for logs whose size is mostly tool output. Every file's last
// write is set to its last record's time, as the logs' own files would be. It prints the roots,
// the config, the window and the total size as JSON. Developer use only: nothing reads it.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { buildDemoWeek, WEEK } from '../lib/demo/week.mjs';

const args = process.argv.slice(2);
const out = args[0];
const copies = Number(args[1]);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const to = opt('--to', new Date().toISOString().slice(0, 10));
const pad = Number(opt('--pad', '0'));
if (!out || !Number.isInteger(copies) || copies < 1) {
  process.stderr.write('Usage: node tools/synthetic-week.mjs <out-dir> <copies> [--to YYYY-MM-DD] [--pad <n>]\n');
  process.exit(1);
}

const DAY = 86400000;
const shiftDays = Math.round((Date.parse(`${to}T00:00:00Z`) - 6 * DAY - Date.parse(`${WEEK.from}T00:00:00Z`)) / DAY);
const dayShift = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + shiftDays * DAY).toISOString().slice(0, 10);
const hex = (s, n) => createHash('sha256').update(s).digest('hex').slice(0, n);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const AGENT = /\ba[0-9a-f]{15}\b/g;
const DATE = /(?<!\d)2025-(\d\d)-(\d\d)(?!\d)/g;
const DATE_PATH = /(^|[\\/])2025([\\/])(\d\d)([\\/])(\d\d)([\\/])/g;

// The folder the logs name as their working folder can itself hold an id-shaped name; it's set
// aside while the ids are renamed, so every copy still points at the demo's repositories.
const ROOTS = [...new Set([resolve(out), out, resolve(out).split('\\').join('/')].flatMap((p) => [JSON.stringify(p).slice(1, -1), p]))].sort((a, b) => b.length - a.length);
function renamed(text, k) {
  let t = text;
  ROOTS.forEach((r, i) => (t = t.split(r).join(`<<root${i}>>`)));
  return keepRoots(renameIds(t, k));
}
const keepRoots = (t) => t.replace(/<<root([0-9]+)>>/g, (_, i) => ROOTS[Number(i)]);
function renameIds(text, k) {
  return text
    .replace(UUID, (u) => { const h = hex(`${u}:${k}`, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; })
    .replace(AGENT, (a) => `a${hex(`${a}:${k}`, 15)}`)
    .replace(DATE, (_, m, d) => dayShift(`2025-${m}-${d}`));
}

function padded(line) {
  if (!pad || !line.includes('tool_result') && !line.includes('function_call_output')) return line;
  try {
    const rec = JSON.parse(line);
    const grow = (s) => (typeof s === 'string' && s.length > 40 ? `${s}\n${Array(pad).fill(s).join('\n')}` : s);
    const content = rec.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_result') b.content = Array.isArray(b.content) ? b.content.map((c) => (typeof c?.text === 'string' ? { ...c, text: grow(c.text) } : c)) : grow(b.content);
    if (rec.payload?.type === 'function_call_output') rec.payload.output = grow(rec.payload.output);
    return JSON.stringify(rec);
  } catch {
    return line;
  }
}

const demo = buildDemoWeek({ root: out });
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
};
for (const r of [...demo.roots.claude, ...demo.roots.codex]) walk(r);
const originals = files.map((f) => ({ f, text: readFileSync(f, 'utf8') }));
let total = 0;
for (let k = 0; k < copies; k++) {
  for (const { f, text } of originals) {
    const root = [...demo.roots.claude, ...demo.roots.codex].find((r) => f.startsWith(r));
    const rel = relative(root, f).replace(DATE_PATH, (_, a, b, m, c, d, e) => { const day = dayShift(`2025-${m}-${d}`); return `${a}${day.slice(0, 4)}${b}${day.slice(5, 7)}${c}${day.slice(8, 10)}${e}`; });
    const target = join(root, renamed(rel, k));
    const body = text.split('\n').map((l) => padded(renamed(l, k))).join('\n');
    // A session index is appended to, never replaced, so every copy's thread names stay.
    const index = f.endsWith('session_index.jsonl');
    mkdirSync(dirname(target), { recursive: true });
    if (index) writeFileSync(target, body, { flag: k === 0 ? 'w' : 'a' });
    else writeFileSync(target, body);
    if (!index || k === copies - 1) {
      const times = [...body.matchAll(/"(?:timestamp)":"(\d{4}-\d\d-\d\dT[^"]+)"/g)].map((m) => Date.parse(m[1])).filter(Number.isFinite);
      const last = times.length ? Math.max(...times) : Date.parse(`${to}T12:00:00Z`);
      utimesSync(target, new Date(last), new Date(last));
    }
  }
}
for (const r of [...demo.roots.claude, ...demo.roots.codex]) {
  const all = [];
  const w = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.jsonl')) all.push(p); } };
  w(r);
  total += all.reduce((n, p) => n + statSync(p).size, 0);
}
process.stdout.write(`${JSON.stringify({ root: out, roots: demo.roots, config: join(out, 'honestweek.config.json'), from: dayShift(WEEK.from), to, copies, pad, bytes: total, mb: Math.round(total / 1048576) }, null, 2)}\n`);
