// Shared pattern authority for the canonical scrubber and replayable prompt audit.
export const REDACTION_SOURCES=Object.freeze({
  uuid:String.raw`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`,
  email:String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
  api:[String.raw`\bsk-[A-Za-z0-9_-]{16,}\b`,String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}\b`,String.raw`\bAKIA[0-9A-Z]{12,}\b`,String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,String.raw`\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}`],
  keyValue:String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)`,
  sensitiveKey:String.raw`(?<![A-Za-z])(?:API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|AUTHORIZATION|SECRET|TOKEN|AUTH)(?![A-Za-z])`,
  currency:[String.raw`\$\s?\d[\d,]*(?:\.\d+)?`,String.raw`\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s?\$?\s?\d[\d,]*(?:\.\d+)?`,String.raw`\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|euros?|pounds?|cents?|USD|EUR|GBP)\b`],
  // Home / user paths. The trailing `~/…` form is as revealing as an absolute
  // one: session logs are full of it, and the segment after it routinely names
  // a client or a private project. Keep it LAST so the `i===1` git-bash flag
  // mapping in redact.mjs stays put.
  //
  // The absolute forms tolerate a space because the USERNAME segment can hold
  // one (Windows "Alex Jordan"). `~` is already the home dir, so there is no
  // username to span and the tilde form must NOT consume spaces: paths are
  // redacted at step 5, before SHAs are protected at step 7, so a space-greedy
  // `~/` would swallow the rest of the line and take the git SHAs and counts
  // the module promises to spare with it.
  paths:[String.raw`[A-Za-z]:[\\/]Users[\\/](?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`/[a-z]/Users/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`/home/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`/Users/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`~[\\/][^\s"'\n]+`],
  sha:String.raw`\b[0-9a-f]{7,40}\b`,account:String.raw`(?<!\.)\b\d{9,}\b(?![%.])`,opaque:String.raw`\b[A-Za-z0-9_+/=-]{32,}\b`,
});
export const regex=(source,flags='g')=>new RegExp(source,flags);
export const escapeRegex=(s)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function termMatchers(terms){return terms.filter((t)=>typeof t==='string'&&t.trim()).map((t)=>new RegExp(`(?<![A-Za-z0-9_])${t.trim().split(/\s+/).map(escapeRegex).join('\\s+')}(?![A-Za-z0-9_])`,'gi'));}
