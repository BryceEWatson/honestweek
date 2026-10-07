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

/** How many private words a config lists: its redaction names, terms and codenames, counting
 *  only the entries the redactor uses (a blank one hides nothing). */
export function privateWordCount(config) {
  const r = config?.redaction ?? {};
  const used = (list) => (Array.isArray(list) ? list.filter((t) => typeof t === 'string' && t.trim()).length : 0);
  return ['names', 'terms', 'codenames'].reduce((n, k) => n + used(r[k]), 0);
}

/**
 * The note for a config with no private words. `command` is how the person runs honestweek;
 * `restart` adds that view must be started again to pick the words up. `settings` is false where
 * Settings can't change this config (one named with --config outside the folder view started
 * in), so the note doesn't send the person there.
 */
export function privateWordsNote(command = 'honestweek', { restart = true, settings = true } = {}) {
  const suggest = settings ? `open Settings in ${command} view and press "Suggest words from my sessions", or ` : '';
  return (
    'No private words are set up, so names and client words in your logs show as written, even with Show private text off. ' +
    `To hide them, list them under "redaction" in honestweek.config.json, like this: "names": ["Jane Doe"], "terms": ["Acme"]${restart ? `, then start ${command} view again` : ''}. ` +
    `For likely ones, ${suggest}run ${command} discover, then ${command} harvest, and read honestweek.harvest.json.`
  );
}
