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
 *  where it doesn't: mid-sentence. CamelCase and all-capitals words count anywhere. */
const startsSentence = (text, at) => /(^|[.!?:;]\s+|\n\s*|^\s*[-*>#]+\s*)$/.test(text.slice(Math.max(0, at - 8), at));

/**
 * suggestWords({ sessions, events, include, exclude }) -> [{ word, count }]
 * Name-shaped words (a capitalized word mid-sentence, CamelCase starting with a capital, or all
 * capitals), outside code, in the titles
 * and prompts of the sessions `include` keeps, seen at least twice, most frequent first, at most
 * MAX_SUGGESTIONS. `exclude` holds words already listed (any case) and repository labels.
 */
export function suggestWords({ sessions, events, include, exclude = [] }) {
  const skip = new Set([...TOOL_WORDS, ...exclude.flatMap((w) => String(w).toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean)]);
  const counts = new Map();
  const add = (raw) => {
    // Code isn't a name: leave out code blocks and `code`, an identifier with an underscore
    // (GITHUB_TOKEN), and a name starting lowercase (filterSince).
    const text = String(raw).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]+/g)) {
      const w = m[0];
      if (w.includes('_') || /^[a-z]/.test(w)) continue;
      if (!isNameShaped(w) || skip.has(w.toLowerCase())) continue;
      if (/^[A-Z][a-z]+$/.test(w) && startsSentence(text, m.index)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  };
  const kept = sessions.filter(include);
  const keys = new Set(kept.map((s) => s.key));
  for (const s of kept) if (typeof s.title === 'string') add(s.title);
  for (const e of events) if (e.kind === 'prompt' && keys.has(e.session) && typeof e.facts?.text === 'string') add(e.facts.text);
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUGGESTIONS)
    .map(([word, count]) => ({ word, count }));
}
