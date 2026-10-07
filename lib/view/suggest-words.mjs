// lib/view/suggest-words.mjs: words in my own prompts and session titles that look like names,
// for Settings to offer as private words (issue 165).
//
// It reads the redacted build, so a word honestweek already hides never shows, and only the
// sessions in my configured repositories, the ones every lookup and goal uses. It writes nothing:
// the page shows the words, and nothing changes until I add some and press Save.

import { isNameShaped } from '../harvest.mjs';

/** Words common in coding sessions that look like names but aren't private. */
const TOOL_WORDS = new Set(
  (
    'claude codex github gitlab bitbucket readme changelog license api cli sdk mcp npm pnpm npx yarn node deno bun ' +
    'json yaml toml html css url urls http https ssh tls jwt oauth sql csv pdf png svg ui ux ci cd pr prs ' +
    'windows linux macos ubuntu debian chrome firefox safari vscode cursor typescript javascript python rust golang java ' +
    'markdown docker kubernetes aws gcp azure honestweek ok todo fixme'
  ).split(/\s+/)
);

/** At most this many suggestions, so the list stays short. */
export const MAX_SUGGESTIONS = 20;

/** A capitalized word that only ever starts a sentence is usually just that, so it counts only
 *  where it doesn't: mid-sentence. A sentence also starts a line, a list item ("- Check",
 *  "2. Update"), and a quote or bracket opening one. CamelCase and all-capitals words count
 *  anywhere. */
const startsSentence = (text, at) =>
  /(?:^|[.!?:;]["'”’)\]]*\s+|\n)\s*(?:(?:[-*+>#]+|\d+[.)])\s+)?["'“‘([]*$/u.test(text.slice(Math.max(0, at - 16), at));

/**
 * suggestWords({ sessions, events, include, exclude }) -> [{ word, count }]
 * Name-shaped words in any alphabet (a capitalized word mid-sentence, CamelCase starting with a
 * capital, or all capitals), outside code, in the titles and prompts of the sessions `include`
 * keeps, seen at least twice, most frequent first, at most MAX_SUGGESTIONS. `exclude` holds
 * whole words to leave out, any case: listed private words and the parts of repository labels.
 * A listed name of two words leaves its parts in, since the redactor hides only the whole name
 * and a first name alone still shows.
 */
export function suggestWords({ sessions, events, include, exclude = [], promptText = (e) => e.facts?.text }) {
  const skip = new Set([...TOOL_WORDS, ...exclude.map((w) => String(w).trim().toLowerCase()).filter(Boolean)]);
  const counts = new Map();
  const add = (raw) => {
    // Code isn't a name: leave out code blocks and `code`, an identifier with an underscore
    // (GITHUB_TOKEN), and a name starting lowercase (filterSince).
    const text = String(raw).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
    for (const m of text.matchAll(/\p{L}[\p{L}\p{N}_]+/gu)) {
      const w = m[0];
      if (w.includes('_') || /^\p{Ll}/u.test(w)) continue;
      if (!isNameShaped(w) || skip.has(w.toLowerCase())) continue;
      if (/^\p{Lu}\p{Ll}+$/u.test(w) && startsSentence(text, m.index)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  };
  const kept = sessions.filter(include);
  const keys = new Set(kept.map((s) => s.key));
  for (const s of kept) if (typeof s.title === 'string') add(s.title);
  for (const e of events) {
    if (e.kind !== 'prompt' || !keys.has(e.session)) continue;
    const text = promptText(e);
    if (typeof text === 'string') add(text);
  }
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUGGESTIONS)
    .map(([word, count]) => ({ word, count }));
}
