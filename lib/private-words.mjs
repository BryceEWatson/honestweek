// lib/private-words.mjs: whether a config lists any private words, and the note that says
// what to do when it lists none. `init` prints the note when it writes such a config, and
// `view` prints it in the terminal and shows it on every page.
//
// Redaction can only hide the names and client words a person lists, so a first run with
// none shows them as written. The note gives the simplest working fix (an edit to the config,
// with an example) and the commands that propose candidates, which work from a fresh setup:
// discover writes a redacted draft of last week, and harvest lists the capitalised words
// that survived in it, most frequent first.
//
// Zero runtime dependencies.

/** Whether a listed word is one the redactor uses: a blank one hides nothing. */
export const isUsedWord = (t) => typeof t === 'string' && t.trim() !== '';

const used = (list) => (Array.isArray(list) ? list.filter(isUsedWord).length : 0);

/** How many private words a config lists: its redaction names, terms and codenames, counting
 *  only the entries the redactor uses (a blank one hides nothing). */
export function privateWordCount(config) {
  const r = config?.redaction ?? {};
  return ['names', 'terms', 'codenames'].reduce((n, k) => n + used(r[k]), 0);
}

/** How many words a config keeps out of public renditions only (neverPublicTerms). They're
 *  left out of privateWordCount, since the private view shows them as written, but `init`
 *  counts them with the others when it keeps them from an old config and when it says how
 *  many words the new config lists. */
export function neverPublicWordCount(config) {
  return used(config?.privacy?.publicRenditions?.neverPublicTerms);
}

/**
 * The note for a config with no private words. `command` is how the person runs honestweek;
 * `restart` adds that view must be started again to pick the words up. `publicOnly`, the
 * count of words the config keeps out of public renditions only, says those don't hide
 * anything either, so the note doesn't read as if the config listed none.
 */
export function privateWordsNote(command = 'honestweek', { restart = true, publicOnly = 0 } = {}) {
  const opening = publicOnly
    ? `Your config keeps ${publicOnly === 1 ? '1 word' : `${publicOnly} words`} out of public versions only, so names and client words in your logs, ${publicOnly === 1 ? 'that one' : 'those'} included, show as written in your own pages, even with Show private text off. `
    : 'No private words are set up, so names and client words in your logs show as written, even with Show private text off. ';
  return (
    opening +
    `To hide them, list them under "redaction" in honestweek.config.json, like this: "names": ["Jane Doe"], "terms": ["Acme"]${restart ? `, then start ${command} view again` : ''}. ` +
    `For a list of candidates from last week's sessions, run ${command} discover, then ${command} harvest, and read honestweek.harvest.json.`
  );
}
