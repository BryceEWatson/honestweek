// lib/replay/codex-program.mjs — what a Codex `exec` program does, and what its records say.
//
// Since August 2026 every Codex build runs each step as a small JavaScript program through a
// tool named `exec`: the program calls `tools.exec_command`, `tools.apply_patch` and other
// tools, and prints what it wants the model to see. Two kinds of record describe that work:
//
//   - the harness's own records: an `item_completed` record for each command the program ran
//     (a CommandExecution item, with the command line, exit code and output) and for each file
//     change (a FileChange item, with each file's diff). Codex 0.154 and later write them. These
//     are recorded evidence, read by codex.mjs.
//   - the program's text, which names each tool call it makes. Reading the literal arguments out
//     of it (a command string, a patch) is derived evidence: computed only from the recorded
//     text, with no interpretation, and only where the text leaves no doubt.
//
// This module holds the pure readers for both: a tokenizer and literal reader for program text,
// the program's printed outcome, and the item shapes. Nothing here builds events.

/** Longer programs are shown, not read. */
export const PROGRAM_MAX = 256 * 1024;

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const KEYWORD_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'await', 'yield']);

/**
 * tokenize(src) -> [{ t, v, dyn? }] | null
 * Strings ('', "", and template literals; `dyn` marks a template with ${...}), identifiers,
 * numbers, and punctuation, with comments dropped. Null when the text can't be tokenized
 * (an unclosed string or comment): such a program is shown, never read.
 */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const prevAllowsRegex = () => {
    const p = out.at(-1);
    if (!p) return true;
    if (p.t === 'p') return ![')', ']', '}'].includes(p.v);
    if (p.t === 'id') return KEYWORD_BEFORE_REGEX.has(p.v);
    return false;
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      for (; j < n && src[j] !== c; j++) {
        if (src[j] === '\n') return null;
        if (src[j] === '\\') {
          const e = unescape(src, j);
          if (!e) return null;
          v += e.v;
          j = e.end - 1;
        } else v += src[j];
      }
      if (j >= n) return null;
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let v = '';
      let dyn = false;
      let depth = 0;
      for (; j < n; j++) {
        const d = src[j];
        if (depth === 0 && d === '`') break;
        if (d === '\\') {
          const e = unescape(src, j);
          if (!e) return null;
          if (depth === 0) v += e.v;
          j = e.end - 1;
          continue;
        }
        if (depth === 0 && d === '$' && src[j + 1] === '{') {
          dyn = true;
          depth = 1;
          j++;
          continue;
        }
        if (depth > 0) {
          if (d === '{') depth++;
          else if (d === '}') depth--;
          continue;
        }
        v += d;
      }
      if (j >= n) return null;
      out.push({ t: 'str', v, tpl: true, dyn });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/.exec(src.slice(i, i + 64));
      out.push({ t: 'num', v: Number(m[0].replace(/_/g, '').replace(/n$/, '')) });
      i += m[0].length;
      continue;
    }
    if (c === '/' && prevAllowsRegex()) {
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const d = src[j];
        if (d === '\n') return null;
        if (d === '\\') {
          j++;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      if (j >= n) return null;
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      out.push({ t: 're' });
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i)) ?? c;
    out.push({ t: 'p', v: p });
    i += p.length;
  }
  return out;
}

function unescape(src, j) {
  const d = src[j + 1];
  if (d === undefined) return null;
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  if (d in simple && !(d === '0' && /\d/.test(src[j + 2] ?? ''))) return { v: simple[d], end: j + 2 };
  if (d === 'x') {
    const h = src.slice(j + 2, j + 4);
    return /^[\da-fA-F]{2}$/.test(h) ? { v: String.fromCharCode(parseInt(h, 16)), end: j + 4 } : null;
  }
  if (d === 'u') {
    if (src[j + 2] === '{') {
      const close = src.indexOf('}', j + 3);
      const h = close > 0 ? src.slice(j + 3, close) : '';
      return /^[\da-fA-F]{1,6}$/.test(h) && parseInt(h, 16) <= 0x10ffff ? { v: String.fromCodePoint(parseInt(h, 16)), end: close + 1 } : null;
    }
    const h = src.slice(j + 2, j + 6);
    return /^[\da-fA-F]{4}$/.test(h) ? { v: String.fromCharCode(parseInt(h, 16)), end: j + 6 } : null;
  }
  if (d === '\r' && src[j + 2] === '\n') return { v: '', end: j + 3 };
  if (d === '\n' || d === '\r') return { v: '', end: j + 2 };
  return { v: d, end: j + 2 };
}

const UNREAD = Symbol('unread');

/** A literal value at toks[i]: a string (a template only without ${}), a number, true, false,
 *  null, an array or object of literals, or a name bound once to one. UNREAD otherwise. */
function literalAt(toks, i, bindings, depth = 0) {
  const tk = toks[i];
  if (!tk || depth > 20) return { v: UNREAD, end: i };
  if (tk.t === 'str') return tk.dyn ? { v: UNREAD, end: i + 1 } : { v: tk.v, end: i + 1 };
  if (tk.t === 'num') return { v: tk.v, end: i + 1 };
  if (tk.t === 'p' && tk.v === '-' && toks[i + 1]?.t === 'num') return { v: -toks[i + 1].v, end: i + 2 };
  if (tk.t === 'id') {
    if (tk.v === 'true') return { v: true, end: i + 1 };
    if (tk.v === 'false') return { v: false, end: i + 1 };
    if (tk.v === 'null') return { v: null, end: i + 1 };
    if (bindings?.has(tk.v)) return { v: bindings.get(tk.v), end: i + 1 };
    return { v: UNREAD, end: i + 1 };
  }
  if (tk.t === 'p' && tk.v === '[') {
    const arr = [];
    let j = i + 1;
    while (toks[j] && !(toks[j].t === 'p' && toks[j].v === ']')) {
      const x = literalAt(toks, j, bindings, depth + 1);
      if (x.v === UNREAD) return { v: UNREAD, end: j };
      arr.push(x.v);
      j = x.end;
      if (toks[j]?.t === 'p' && toks[j].v === ',') j++;
      else if (!(toks[j]?.t === 'p' && toks[j].v === ']')) return { v: UNREAD, end: j };
    }
    return toks[j] ? { v: arr, end: j + 1 } : { v: UNREAD, end: j };
  }
  if (tk.t === 'p' && tk.v === '{') {
    const obj = {};
    let j = i + 1;
    while (toks[j] && !(toks[j].t === 'p' && toks[j].v === '}')) {
      const k = toks[j];
      if (!(k.t === 'id' || (k.t === 'str' && !k.dyn) || k.t === 'num') || !(toks[j + 1]?.t === 'p' && toks[j + 1].v === ':')) return { v: UNREAD, end: j };
      const key = String(k.v);
      // JavaScript keeps the last of two equal keys; a program that relies on that is not read.
      if (Object.prototype.hasOwnProperty.call(obj, key)) return { v: UNREAD, end: j };
      const x = literalAt(toks, j + 2, bindings, depth + 1);
      if (x.v === UNREAD) return { v: UNREAD, end: j };
      obj[key] = x.v;
      j = x.end;
      if (toks[j]?.t === 'p' && toks[j].v === ',') j++;
      else if (!(toks[j]?.t === 'p' && toks[j].v === '}')) return { v: UNREAD, end: j };
    }
    return toks[j] ? { v: obj, end: j + 1 } : { v: UNREAD, end: j };
  }
  return { v: UNREAD, end: i + 1 };
}

/** Names declared once with const, let or var to a literal, and never assigned again. */
function literalBindings(toks) {
  const declared = new Map();
  const assigned = new Map();
  toks.forEach((tk, i) => {
    if (tk.t !== 'id') return;
    const next = toks[i + 1];
    if (next?.t === 'p' && (next.v === '=' || /^(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)=$/.test(next.v) || next.v === '++' || next.v === '--')) assigned.set(tk.v, (assigned.get(tk.v) ?? 0) + 1);
    if (toks[i - 1]?.t === 'p' && (toks[i - 1].v === '++' || toks[i - 1].v === '--')) assigned.set(tk.v, (assigned.get(tk.v) ?? 0) + 2);
    if (['const', 'let', 'var'].includes(toks[i - 1]?.v) && toks[i - 1].t === 'id' && next?.t === 'p' && next.v === '=') declared.set(tk.v, i);
  });
  const out = new Map();
  for (const [name, i] of declared) {
    if (assigned.get(name) !== 1) continue;
    const x = literalAt(toks, i + 2, out);
    if (x.v !== UNREAD) out.set(name, x.v);
  }
  return out;
}

// Anything that can run a call more than once, not at all, out of order, or without waiting
// for it makes the program's calls something other than one straight run.
const NOT_STRAIGHT_IDS = new Set(['for', 'while', 'do', 'if', 'else', 'switch', 'case', 'try', 'catch', 'finally', 'function', 'class', 'return', 'throw', 'Promise', 'setTimeout', 'setInterval', 'eval', 'Function']);
const NOT_STRAIGHT_METHODS = new Set(['map', 'forEach', 'flatMap', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'then', 'catch', 'finally', 'call', 'apply', 'bind']);
const NOT_STRAIGHT_PUNCT = new Set(['=>', '?', '&&', '||', '??', '&&=', '||=', '??=']);

/**
 * readExecProgram(src) -> { calls, straight } | null
 *
 * Each `tools.NAME(...)` call the program text makes, in order: its tool name, its first
 * argument as a literal (or null when it isn't one), and whether it's awaited. `straight` is
 * true when every call runs once, in order, each awaited before the next: no loops, branches,
 * functions, error handling or parallel calls anywhere in the program. Null for text with no
 * `tools.` call, or one that can't be tokenized or is too long to read.
 */
export function readExecProgram(src) {
  if (typeof src !== 'string' || !/\btools\s*(?:\.|\[)/.test(src) || src.length > PROGRAM_MAX) return null;
  const toks = tokenize(src);
  if (!toks) return null;
  const bindings = literalBindings(toks);
  const calls = [];
  let straight = true;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const isProp = toks[i - 1]?.t === 'p' && (toks[i - 1].v === '.' || toks[i - 1].v === '?.');
    if (tk.t === 'id' && (isProp ? NOT_STRAIGHT_METHODS.has(tk.v) : NOT_STRAIGHT_IDS.has(tk.v))) straight = false;
    if (tk.t === 'p' && NOT_STRAIGHT_PUNCT.has(tk.v)) straight = false;
    if (tk.t === 'id' && tk.v === 'tools' && !isProp) {
      const dot = toks[i + 1];
      if (dot?.t === 'p' && dot.v === '[') straight = false; // a tool chosen at run time
      if (!(dot?.t === 'p' && dot.v === '.' && toks[i + 2]?.t === 'id' && toks[i + 3]?.t === 'p' && toks[i + 3].v === '(')) continue;
      const name = toks[i + 2].v;
      const awaited = toks[i - 1]?.t === 'id' && toks[i - 1].v === 'await';
      if (!awaited) straight = false;
      const arg = toks[i + 4]?.t === 'p' && toks[i + 4].v === ')' ? { v: undefined, end: i + 4 } : literalAt(toks, i + 4, bindings);
      const closes = toks[arg.end]?.t === 'p' && toks[arg.end].v === ')';
      calls.push({ tool: name, arg: arg.v === UNREAD || !closes ? null : arg.v ?? null, index: calls.length });
      i += 3;
    }
  }
  if (!calls.length) return null;
  return { calls, straight };
}

/** The shell command line a call's literal argument names, or null. */
export function commandOfCall(call) {
  const a = call?.arg;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const cmd = a.cmd ?? a.command;
  if (('cmd' in a) && ('command' in a)) return null;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd) && cmd.every((x) => typeof x === 'string')) return cmd.join(' ');
  return null;
}

/** The patch text an apply_patch call's literal argument holds, or null. */
export function patchOfCall(call) {
  const a = call?.arg;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && typeof (a.input ?? a.patch) === 'string') return a.input ?? a.patch;
  return null;
}

/** The tool kinds a program's calls stand for. */
export const COMMAND_TOOLS = new Set(['exec_command', 'shell_command', 'shell', 'local_shell']);
export const PATCH_TOOLS = new Set(['apply_patch']);
/** Categories for tools only seen inside programs, by the names programs call them by. */
const IN_PROGRAM_CATEGORY = new Map([['web__run', 'web'], ['write_stdin', 'wait'], ['clock__curr_time', 'meta']]);
export const inProgramCategory = (name) => IN_PROGRAM_CATEGORY.get(name) ?? null;

// ---------------------------------------------------------------------------
// What the program's output record says
// ---------------------------------------------------------------------------

/** The text blocks of an output: an array of blocks, or one string. */
export function outputBlocks(output) {
  if (typeof output === 'string') return [output];
  if (Array.isArray(output)) return output.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : null)).filter((x) => x != null);
  if (output && typeof output === 'object' && typeof output.content === 'string') return [output.content];
  return [];
}

const HEADER = /^Script (completed|failed|running with cell ID (\S+))\s*(?:\r?\n|$)/;

/**
 * programOutcome(output) -> { status, cellId, error, printed, results }
 *
 * status: 'completed', 'failed' or 'running' as the output's first line says, or null when it
 * says none of them. error: a failed program's error text (after "Script error:"). printed:
 * the text blocks after the header. results: every command result the printed blocks hold as
 * JSON (an object with a numeric exit_code), with the command line when the same object or its
 * parent names one.
 */
export function programOutcome(output) {
  const blocks = outputBlocks(output);
  const head = blocks.length ? HEADER.exec(blocks[0]) : null;
  const status = head ? (head[1] === 'completed' ? 'completed' : head[1] === 'failed' ? 'failed' : 'running') : null;
  const printed = head ? [blocks[0].replace(/^[^\n]*\n(?:Wall time[^\n]*\n)?(?:Output:\n?)?/, ''), ...blocks.slice(1)].filter((s) => s !== '') : blocks;
  let error = null;
  if (status === 'failed') {
    const e = printed.find((s) => /^Script error:/.test(s));
    error = e ? e.replace(/^Script error:\s*/, '') : null;
  }
  const results = [];
  const walk = (v, parentCmd, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, parentCmd, depth + 1);
      return;
    }
    const cmd = typeof v.cmd === 'string' ? v.cmd : typeof v.command === 'string' ? v.command : parentCmd;
    if (Number.isInteger(v.exit_code)) {
      results.push({ exit: v.exit_code, cmd: cmd ?? null, output: typeof v.output === 'string' ? v.output : null });
      return;
    }
    for (const x of Object.values(v)) walk(x, cmd, depth + 1);
  };
  for (const s of printed) {
    const t = s.trim();
    if (!/^[[{]/.test(t)) continue;
    let v = null;
    try {
      v = JSON.parse(t);
    } catch {
      continue;
    }
    walk(v, null, 0);
  }
  return { status, cellId: head?.[2] ?? null, error, printed, results };
}

/** Which tool a failed program's error names, and whether the harness refused it. */
export function failureOf(error) {
  if (typeof error !== 'string') return null;
  const m = /^([A-Za-z_][\w]*) (?:verification )?failed\b/.exec(error);
  if (!m) return null;
  return { tool: m[1], refused: /\bRejected\(|\brejected due to\b/.test(error) };
}

// ---------------------------------------------------------------------------
// The harness's own records of a command and a file change
// ---------------------------------------------------------------------------

const SHELL_FLAG = /^(?:-Command|-c|-lc|\/c|\/C)$/;

/** The command line a CommandExecution item ran: the shell's own parse when it holds one
 *  command, else the text after a shell's command flag, else the whole argument list. */
export function itemCommand(item) {
  const pc = Array.isArray(item?.parsed_cmd) ? item.parsed_cmd : [];
  if (pc.length === 1 && typeof pc[0]?.cmd === 'string') return pc[0].cmd;
  const argv = Array.isArray(item?.command) ? item.command.filter((x) => typeof x === 'string') : typeof item?.command === 'string' ? [item.command] : [];
  if (!argv.length) return null;
  const f = argv.findIndex((x) => SHELL_FLAG.test(x));
  if (f >= 0 && f === argv.length - 2) return argv.at(-1);
  return argv.join(' ');
}

/** Milliseconds from a time field, or null. */
export const msOf = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/**
 * fileChangePatch(changes) -> { patch, files: [{ path, op }], added, removed } | null
 * A FileChange item's changes as apply_patch text (so the edit readers see one shape), and the
 * lines its diffs add and remove. An update's unified diff keeps its hunks; an added file's
 * content is all added lines, a deleted one's all removed.
 */
export function fileChangePatch(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const lines = ['*** Begin Patch'];
  const files = [];
  let added = 0;
  let removed = 0;
  for (const [path, c] of Object.entries(changes)) {
    if (!c || typeof c !== 'object' || !path) continue;
    const op = c.type === 'add' ? 'add' : c.type === 'delete' ? 'delete' : 'update';
    files.push({ path, op });
    if (op === 'add') {
      lines.push(`*** Add File: ${path}`);
      const body = typeof c.content === 'string' ? c.content.replace(/\n$/, '') : '';
      for (const l of body ? body.split('\n') : []) {
        lines.push(`+${l}`);
        added++;
      }
    } else if (op === 'delete') {
      lines.push(`*** Delete File: ${path}`);
      const body = typeof c.content === 'string' ? c.content.replace(/\n$/, '') : '';
      removed += body ? body.split('\n').length : 0;
    } else {
      lines.push(`*** Update File: ${path}`);
      if (typeof c.move_path === 'string' && c.move_path) lines.push(`*** Move to: ${c.move_path}`);
      for (const l of typeof c.unified_diff === 'string' ? c.unified_diff.replace(/\n$/, '').split('\n') : []) {
        if (/^(?:---|\+\+\+) /.test(l)) continue;
        if (l.startsWith('@@')) lines.push('@@');
        else if (l.startsWith('+')) {
          lines.push(l);
          added++;
        } else if (l.startsWith('-')) {
          lines.push(l);
          removed++;
        } else if (l.startsWith(' ') || l === '') lines.push(l.startsWith(' ') ? l : ' ');
      }
    }
  }
  if (!files.length) return null;
  lines.push('*** End Patch');
  return { patch: lines.join('\n'), files, added, removed };
}
