// lib/replay/record-output.mjs: the text a tool call's result record holds, read back from a
// re-read record (history.record), for the page's step detail and the review brief.

/** The text a tool call's result record holds, from either harness's record shape. */
export function outputOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const textOf = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : '')).filter(Boolean).join('\n');
    if (v && typeof v === 'object' && typeof v.output === 'string') return v.output;
    return null;
  };
  const content = rec.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) if (b && b.type === 'tool_result') return textOf(b.content);
  }
  const p = rec.payload;
  if (p && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
    let o = p.output;
    if (typeof o === 'string' && o.startsWith('{')) {
      try {
        const parsed = JSON.parse(o);
        if (typeof parsed?.output === 'string') o = parsed.output;
      } catch {
        /* a cut or non-JSON output is shown as it is */
      }
    }
    return textOf(o);
  }
  return null;
}
