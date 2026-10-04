// Text whose redaction is "unsettled": the published redactor changes its own first-pass output
// when it runs over it again. The digest holds such text back, and its tests need a real sample.
//
// A sample is a quirk of the redactor, so it goes stale: each time the redactor learns to read
// one of these shapes on the first pass, that shape settles. So the tests don't name one sample.
// They take the first shape here that is still unsettled, and fail with instructions only when
// none is left. Each shape is unsettled for a different reason. Made-up values.
//
// To find a new one when they have all settled: join two to five pieces picked at random from
// secret names (`token`, `pass`, `api_key`, `Authorization`, `Cookie`), separators (`=`, `: `,
// `='`, `=\"`, `==`, a line break before or after `=`), short values and quote characters, put
// the result in a plain sentence, and keep it when
//   const once = createRedactor(config).redact(text);
//   createRedactor(config).redact(once) !== once
// A few hundred thousand tries turned up hundreds on the redactor these were written for. If a
// long search finds none, the redactor no longer has unsettled text, and these tests need a
// way to hand the digest a redactor of their own.

import { createRedactor, redactWithAudit } from '../../lib/redact.mjs';

export const UNSETTLED_SHAPES = Object.freeze([
  // A header's value stops at a quote on the first pass; the second reads on to the line's end.
  { name: 'header line', core: "authorization='api_key=  y8znote:", leak: 'authorization=' },
  // An escaped quote is left before a placeholder; the second pass takes it into the value.
  { name: 'escaped quote', core: 'token: \'name=\\"auth=\\";', leak: 'auth=' },
  // Three values hidden side by side behind an opening quote; the second pass hides them as one.
  { name: 'quoted run', core: "pass='token==auth='abc", leak: "pass='" },
  // A key on the line after its name's "=": the comparison under it is read on the second pass.
  { name: 'key across lines', core: "x='authorization\n=x=\napi_key==true", leak: 'api_key==' },
]);
// Every shape is lowercase on purpose: a capital word in the middle of a sentence raises the
// audit's risk for the text around it, which the carry test's cue would inherit.

/** The first shape whose text, `frame(core)`, is still unsettled under `config`: both the
 *  audit's rendition of it (what a scan stores) and the redactor's own first pass change on a
 *  second pass. Returns { name, core, raw, once, leak }: the text, its first-pass redaction, and
 *  a pattern for what must never be written. Throws, saying what to do, when every shape has
 *  settled. */
export function unsettledSample(config = {}, frame = (core) => core) {
  const redact = (text) => createRedactor(config).redact(text);
  for (const shape of UNSETTLED_SHAPES) {
    const raw = frame(shape.core);
    const once = redact(raw);
    const scanned = redactWithAudit(raw, config).text;
    if (redact(once) !== once && redact(scanned) !== scanned) return { ...shape, raw, once, leak: new RegExp(shape.leak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) };
  }
  throw new Error('Every sample in test/helpers/unsettled-text.mjs has settled: the redactor no longer changes any of them on a second pass. '
    + 'That is the redactor getting better, not the digest breaking. Add a shape that is still unsettled; the header of that file says how to find one.');
}

/** The message for a test's own check that its sample is still unsettled where the test uses it. */
export const SETTLED_HINT = 'the sample has settled (a second pass no longer changes it here): add or pick another unsettled shape in test/helpers/unsettled-text.mjs, whose header says how to find one';
