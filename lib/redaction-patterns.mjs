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
  //
  // The Windows form accepts runs of separators: a path inside JSON-encoded text
  // (a Codex tool call's arguments, for one) arrives as `C:\\Users\\name\\…`, and
  // a single-separator pattern let the username through. Three forward slashes
  // after the colon are a URL scheme (`file:///Users/…`), left to the POSIX form.
  // The username never crosses a double quote (so a match can't run into the next
  // JSON field), and a bare home folder whose username holds a space is taken
  // whole when a double quote closes it. Every quantified piece is disjoint from
  // its neighbour, so matching stays linear on long runs of separators; redact.mjs
  // hands back backslashes that end a match right before a quote (`\"`).
  paths:[String.raw`[A-Za-z]:(?!///)[\\/]+(?:Users|users|USERS)[\\/]+(?:[^/\\\n"]+[\\/][^\s"'\n]*|[^\s/\\"'\n]+(?: [^\s/\\"'\n]+){1,2}(?=")|[^\s/\\"'\n]+)`,String.raw`/[a-z]/Users/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`/home/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`/Users/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`~[\\/][^\s"'\n]+`],
  sha:String.raw`\b[0-9a-f]{7,40}\b`,account:String.raw`(?<!\.)\b\d{9,}\b(?![%.])`,opaque:String.raw`\b[A-Za-z0-9_+/=-]{32,}\b`,
});
export const regex=(source,flags='g')=>new RegExp(source,flags);
/** Where a home-path match should end: backslashes that end it right before a double quote
 *  belong to an escaped quote in JSON text (`…\\repo\"`), so they stay. A backward loop, so
 *  a long run of backslashes costs linear time. `end` is exclusive, in UTF-16 units. */
export function pathMatchEnd(text,start,end){let n=0;while(end-n>start&&text[end-1-n]==='\\')n+=1;return n&&text[end]==='"'?end-n:end;}
export const escapeRegex=(s)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Each configured term as patterns, used by the canonical scrubber and the prompt audit.
 *  1. A web-address or file-name part that starts with the term, or has it at a sub-word
 *     start (after "-", "_", a digit, or a camel-case boundary), is replaced whole:
 *     `www.acmehq.com`, `acmereport.pdf`, `api.my-acmecloud.io`, `http://acmehq:3000`. Only a
 *     term of four or more letters with no "." of its own is matched this way, so a short
 *     name like "Ion" never takes `session.ts` or `window.location.href` with it.
 *  2. The term as a word. Only a letter next to it hides it, so `name_report`, `name2` and
 *     `report-name` match, and so does a camel-case part (`NameReport`, `myName`,
 *     `NAMEReport`, `XMLNameThing`); `names` and `Namesake` don't. Letters are spelled in
 *     both cases instead of using the i flag, so the edges can tell a capital from a small
 *     letter.
 *  A multi-word term matches its words split by spaces, by "-", "_" or ".", or run together
 *  (`Jane Doe`, `jane_doe`, `JaneDoe`); in a web-address part, by "-", "_" or nothing.
 *  Longer terms come first, and the web-address patterns before the word, so the scrubber
 *  (which applies them in turn) and the audit (which takes the widest match) agree. The
 *  web-address patterns are marked `acrossPlaceholders`: the scrubber runs them over its
 *  whole text, placeholders included, so a later dotted piece may be one
 *  (`acmelogo.<hash>.png`); they never match inside a placeholder. Each start is tried once
 *  from the front of a word or part, so matching stays linear. */
const anyCase=(s)=>[...s].map((c)=>{const lo=c.toLowerCase();const up=c.toUpperCase();return lo!==up&&[...lo].length===1&&[...up].length===1?`[${c===lo||c===up?'':c}${lo}${up}]`:escapeRegex(c);}).join('');
const START_EDGE='(?:(?<!\\p{L})|(?<=\\p{Ll})(?=\\p{Lu})|(?<=\\p{Lu})(?=\\p{Lu}\\p{Ll}))';
const edge=(c,side)=>/\p{L}/u.test(c)?(side==='start'?START_EDGE:'(?:(?!\\p{L})|(?<=\\p{Ll})(?=\\p{Lu})|(?<=\\p{Lu})(?=\\p{Lu}\\p{Ll}))'):/\p{N}/u.test(c)?(side==='start'?'(?<![\\p{L}\\p{N}])':'(?![\\p{L}\\p{N}])'):(side==='start'?'(?<![\\p{L}\\p{N}_])':'(?![\\p{L}\\p{N}_])');
const PART='[\\p{L}\\p{N}_-]';
// A later dotted piece: an ordinary one, or a placeholder the scrubber set aside.
const PIECE=`(?:${PART}{1,63}|\\uE000+\\d+\\uE000+)`;
const ENDING='\\.\\p{L}[\\p{L}\\p{N}]{1,23}(?![\\p{L}\\p{N}])';
const across=(re)=>Object.assign(re,{acrossPlaceholders:true});
export function termMatchers(terms){return terms.filter((t)=>typeof t==='string'&&t.trim()).sort((x,y)=>y.trim().length-x.trim().length).flatMap((t)=>{const words=t.trim().split(/\s+/);const cs=[...t.trim()];const word=new RegExp(`${edge(cs[0],'start')}${words.map(anyCase).join('(?:\\s+|[-_.]?)')}${edge(cs.at(-1),'end')}`,'gu');if(t.includes('.')||(t.match(/\p{L}/gu)??[]).length<4)return [word];const glued=words.map(anyCase).join('[-_]?');const part=`(?<!${PART})(?=${PART}*?${START_EDGE}${glued})(?=(${PART}+))\\1`;return [across(new RegExp(`${part}(?=(?:\\.${PIECE}){0,8}${ENDING})`,'gu')),across(new RegExp(`(?<=:\\/\\/(?:[^\\s/@]{1,256}@)?)${part}(?=[:/?#]|\\s|$)`,'gu')),word];});}
