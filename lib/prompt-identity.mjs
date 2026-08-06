import { createHash } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function promptIdentity(source, rawSessionId, turn) {
  const sessionKey = sha256(`${source}\0${rawSessionId}`);
  const refCanonical = `${source}\0${sessionKey}\0${turn}`;
  return { sessionKey, refCanonical, ref: sha256(refCanonical) };
}

export function promptItemIdentity(evidenceRef) {
  return sha256(`prompts\0${evidenceRef}\0prompt`);
}

export function digestItemIdentity(category, evidenceRefs, discriminator) {
  const refs = [...evidenceRefs].sort();
  return sha256(`${category}\0${refs.join('\0')}\0${discriminator}`);
}
