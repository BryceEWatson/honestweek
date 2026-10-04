// Text whose redaction is "unsettled": the published redactor changes the audit's rendition of it
// (what a scan stores) when it runs over it again. The digest holds such text back, and its
// tests need a real sample.
//
// A sample is a quirk of the redactor, so it goes stale: each time the redactor learns to read
// one of these shapes on the first pass, that shape settles. So the tests don't name one sample.
// They take the first shape here that is still unsettled, and fail with instructions only when
// none is left. Made-up values.
//
// The published redactor now runs over its own output until it settles (issue 80), and the audit
// takes on what that adds wherever it lines up with its rendition, so the shapes left are ones
// where it doesn't: the KEY=VALUE rule writes its own "=" right after a key split from it by a
// line break, which a rendition made only of placeholders can't spell.
//
// To find a new one when they have all settled: join two to five pieces picked at random from
// secret names (`token`, `pass`, `api_key`, `api.key`, `x.pwd`, `client_secret`, `cookie`),
// separators (`=`, `: `, `:=`, `="`, `=\"`, `==`, a line break before or after `=`), short values
// and quote characters, put the result in a plain sentence, and keep it when
//   const scanned = redactWithAudit(text, config).text;
//   createRedactor(config).redact(scanned) !== scanned
// About 5 in 100,000 such tries turned one up on the redactor these were written for. If a long
// search finds none, the audit no longer leaves unsettled text, and these tests need a way to
// hand the digest a redactor of their own.

import { createRedactor, redactWithAudit } from '../../lib/redact.mjs';

export const UNSETTLED_SHAPES = Object.freeze([
  // A key on the line after a hidden value, its "=" on the next: the rule joins them.
  { name: 'key across lines', core: '.secret.key:=":x.pwd\n=api_key\r\n=xk9mp2qrz7cookie=\\"', leak: 'secret.key:=' },
  // The same split after a run of dotted keys, ending on an escaped quote.
  { name: 'dotted keys across lines', core: 'client.key = secret.key: api.key="-dapi.key\r\n=client_secret\r\n=\\"client_secret\n', leak: 'client.key = ' },
]);
// Every shape is lowercase on purpose: a capital word in the middle of a sentence raises the
// audit's risk for the text around it, which the carry test's cue would inherit.

/** The first shape whose text, `frame(core)`, is still unsettled under `config`: the audit's
 *  rendition of it (what a scan stores) changes when the published redactor runs over it.
 *  Returns { name, core, raw, scanned, leak }: the text, that rendition, and a pattern for what
 *  must never be written. Throws, saying what to do, when every shape has settled. */
export function unsettledSample(config = {}, frame = (core) => core) {
  const redact = (text) => createRedactor(config).redact(text);
  for (const shape of UNSETTLED_SHAPES) {
    const raw = frame(shape.core);
    const scanned = redactWithAudit(raw, config).text;
    if (redact(scanned) !== scanned) return { ...shape, raw, scanned, leak: new RegExp(shape.leak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) };
  }
  throw new Error('Every sample in test/helpers/unsettled-text.mjs has settled: the redactor no longer changes any of them on a second pass. '
    + 'That is the redactor getting better, not the digest breaking. Add a shape that is still unsettled; the header of that file says how to find one.');
}

/** The message for a test's own check that its sample is still unsettled where the test uses it. */
export const SETTLED_HINT = 'the sample has settled (a second pass no longer changes it here): add or pick another unsettled shape in test/helpers/unsettled-text.mjs, whose header says how to find one';
