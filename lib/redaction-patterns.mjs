// Shared pattern authority for the canonical scrubber, the secrets-only scrubber, and the
// replayable prompt audit.
export const REDACTION_SOURCES=Object.freeze({
  uuid:String.raw`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`,
  // Searched with emailSpans() below, which finds what a global search finds in linear time.
  email:String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
  api:[String.raw`\bsk-[A-Za-z0-9_-]{16,}\b`,String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}\b`,String.raw`\bAKIA[0-9A-Z]{12,}\b`,String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,String.raw`\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}`,String.raw`\bglpat-[A-Za-z0-9_-]{20,}`],
  keyValue:String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s*=(?!>)\s*("[^"]*"|'[^']*'|\S+)`,
  sensitiveKey:String.raw`(?<![A-Za-z])(?:API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|AUTHORIZATION|SECRET|TOKEN|AUTH)(?![A-Za-z])`,
  currency:[String.raw`\$\s?\d[\d,]*(?:\.\d+)?`,String.raw`\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s?\$?\s?\d[\d,]*(?:\.\d+)?`,String.raw`(?<![\d,])\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|euros?|pounds?|cents?|USD|EUR|GBP)\b`],
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
  paths:[String.raw`[A-Za-z]:(?!///)[\\/]+(?:Users|users|USERS)[\\/]+(?:[^/\\\n"]+[\\/][^\s"'\n]*|[^\s/\\"'\n]+(?: [^\s/\\"'\n]+){1,2}(?=")|[^\s/\\"'\n]+)`,String.raw`/[a-z]/Users/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`/home/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`/Users/(?:[^/\\\n]+[\\/][^\s"'\n]*(?:[\\/][^\s"'\n]*)*|[^\s/\\"'\n]+)`,String.raw`(?<![\w-])(?:[A-Za-z]-)?-(?:Users|users|home)-[^\s"'/\\-][^\s"'/\\]*`,String.raw`(?:[A-Za-z]%3[Aa])?(?<!%(?:5[Cc]|2[Ff]))(?:%(?:5[Cc]|2[Ff]))+(?:Users|users|USERS|home)(?:%(?:5[Cc]|2[Ff]))+[^\s"'&?#<>%][^\s"'&?#<>]*`,String.raw`~[\\/][^\s"'\n]+`],
  sha:String.raw`\b[0-9a-f]{7,40}\b`,account:String.raw`(?<!\.)\b\d{9,}\b(?![%.])`,opaque:String.raw`\b[A-Za-z0-9_+/=-]{32,}\b`,
});
export const regex=(source,flags='g')=>new RegExp(source,flags);
/** `/root/…`, the root account's home folder (in a container, say). Like `~/…` it has no
 *  username to span. It's read only where it starts a path, so `/var/root/x`, `./root/x` and
 *  `example.com/root/x` stay, and a bare `/root` stays: Codex names its root agent that. It's
 *  hidden over a scrubber's finished text (finishedSpans), so it only ever hides more. */
export const ROOT_PATH_SOURCE=String.raw`(?<![\w.~-])/root/[^\s"'\n]+`;
/** A Codex agent address, the whole of a value: the root agent `/root`, and a spawned one
 *  under it (`/root/wide_fixtures`). Shown as written where it comes from Codex's own agent
 *  fields (lib/replay/codex.mjs), never found by its shape in other text. */
export const AGENT_ADDRESS_RE=/^\/root(?:\/[A-Za-z0-9_-]+)*$/;
/** Where a home-path match should end: backslashes that end it right before a double quote
 *  belong to an escaped quote in JSON text (`…\\repo\"`), so they stay. A backward loop, so
 *  a long run of backslashes costs linear time. `end` is exclusive, in UTF-16 units. */
export function pathMatchEnd(text,start,end){let n=0;while(end-n>start&&text[end-1-n]==='\\')n+=1;return n&&text[end]==='"'?end-n:end;}
export const escapeRegex=(s)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const EMAIL_CHAR=/[A-Za-z0-9._%+-]/;
const WORD_CHAR=/[A-Za-z0-9_]/;
/** Where the email pattern matches in `text`, as [start, end) pairs in UTF-16 units: exactly
 *  what a global search with it finds, in linear time. The pattern is tried only where a
 *  word boundary meets an address character, and when it fails there the rest of that run
 *  of address characters is skipped: "@" isn't one of them, so every later start in the run
 *  reaches the same "@" (or none) and the same domain, and fails too. A global search tries
 *  each of those starts, which made a long run with no address (`x-x-x-…`) quadratic. */
export function emailSpans(text){
  const re=new RegExp(REDACTION_SOURCES.email,'y');
  const spans=[];
  for(let p=0;p<text.length;){
    if(!EMAIL_CHAR.test(text[p])||WORD_CHAR.test(text[p-1]??'')===WORD_CHAR.test(text[p])){p+=1;continue;}
    re.lastIndex=p;
    const m=re.exec(text);
    if(m){spans.push([p,p+m[0].length]);p+=m[0].length;continue;}
    while(p<text.length&&EMAIL_CHAR.test(text[p]))p+=1;
  }
  return spans;
}
/** Where an email address with an encoded "@" sits in `text` (`name%40example.com`,
 *  `name@example.com`, `name&#64;example.com`), as [start, end) pairs in UTF-16 units.
 *  Found from each encoded "@" outward, the name capped at 64 characters and the domain at
 *  255, so a long run costs linear time. */
const ENCODED_AT_RE = /%40|\\u0040|\\x40|&#0*64;|&#x0*40;/gi;
const DOMAIN_RE = /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9])/y;
export function encodedEmailSpans(text) {
  const spans = [];
  let last = 0;
  for (const m of text.matchAll(ENCODED_AT_RE)) {
    if (m.index < last) continue;
    let from = m.index;
    while (from > Math.max(last, m.index - 64) && /[A-Za-z0-9._+-]/.test(text[from - 1])) from -= 1;
    if (from === m.index) continue;
    const at = m.index + m[0].length;
    DOMAIN_RE.lastIndex = at;
    const d = DOMAIN_RE.exec(text.slice(0, Math.min(text.length, at + 255)));
    if (!d) continue;
    spans.push([from, at + d[0].length]);
    last = at + d[0].length;
  }
  return spans;
}
/** Each configured term as patterns, used by the canonical scrubber and the prompt audit.
 *  1. A web-address or file-name part that starts with the term, or has it at a sub-word
 *     start (after "-", "_", a digit, or a camel-case boundary), is replaced whole:
 *     `www.acmehq.com`, `acmereport.pdf`, `api.my-acmecloud.io`, `http://acmehq:3000`. Only a
 *     term of four or more letters with no "." of its own is matched this way, so a short
 *     name like "Ion" never takes `session.ts` or `window.location.href` with it. A person's
 *     name (`names`) is matched this way only in a web address (after `://`, `@` or `www.`,
 *     or before a common ending like `.com`), so "Bill" or "Mark" don't take `billing.ts`
 *     or `markdown.ts` with them.
 *  2. The term as a word. Only a letter next to it hides it, so `name_report`, `name2` and
 *     `report-name` match, and so does a camel-case part (`NameReport`, `myName`,
 *     `NAMEReport`, `XMLNameThing`); `names` and `Namesake` don't. Letters are spelled in
 *     both cases instead of using the i flag, so the edges can tell a capital from a small
 *     letter. The scrubber relies on that too: it skips a plain English term when the
 *     lowercased text lacks one of its words, which is safe only while each of the term's
 *     letters matches just its own two cases.
 *  A multi-word term matches its words split by spaces, by "-", "_" or ".", or run together
 *  (`Jane Doe`, `jane_doe`, `JaneDoe`); in a web-address part, by "-", "_" or nothing.
 *  The web-address patterns are marked `acrossPlaceholders`: the scrubber runs them over its
 *  whole text, placeholders included, so a later dotted piece may be one
 *  (`acmelogo.<hash>.png`); they never match inside a placeholder. The scrubber and the
 *  audit both take every pattern's matches together and replace the widest, so they agree
 *  when terms overlap. Each start is tried once from the front of a word or part, so
 *  matching stays linear. */
const anyCase=(s)=>[...s].map((c)=>{const lo=c.toLowerCase();const up=c.toUpperCase();return lo!==up&&[...lo].length===1&&[...up].length===1?`[${c===lo||c===up?'':c}${lo}${up}]`:escapeRegex(c);}).join('');
const START_EDGE='(?:(?<!\\p{L})|(?<=\\p{Ll})(?=\\p{Lu})|(?<=\\p{Lu})(?=\\p{Lu}\\p{Ll}))';
const edge=(c,side)=>/\p{L}/u.test(c)?(side==='start'?START_EDGE:'(?:(?!\\p{L})|(?<=\\p{Ll})(?=\\p{Lu})|(?<=\\p{Lu})(?=\\p{Lu}\\p{Ll}))'):/\p{N}/u.test(c)?(side==='start'?'(?<![\\p{L}\\p{N}])':'(?![\\p{L}\\p{N}])'):(side==='start'?'(?<![\\p{L}\\p{N}_])':'(?![\\p{L}\\p{N}_])');
const PART='[\\p{L}\\p{N}_-]';
// A later dotted piece: an ordinary one, or a placeholder the scrubber set aside (a token
// made of a Private-Use-Area delimiter, see freshDelimiter).
const PIECE=`(?:${PART}{1,63}|[\\uE000-\\uF8FF]+\\d+[\\uE000-\\uF8FF]+)`;
const ENDING='\\.\\p{L}[\\p{L}\\p{N}]{1,23}(?![\\p{L}\\p{N}])';
const WEB_ENDING='\\.(?:com|org|net|io|dev|app|co|ai|me|us|uk|de|fr|ca|au|nz|edu|gov|info|biz|xyz|tech|cloud|site|online|page|blog|gg|tv|fm|nl|ch|eu|es|it|se|no|dk|fi|jp|br)(?![\\p{L}\\p{N}])';
const AFTER_SCHEME='(?<=:\\/\\/(?:[^\\s/@]{1,256}@)?)';
const across=(re)=>Object.assign(re,{acrossPlaceholders:true});
// --- secret fields, shared by both scrubbers and the prompt audit -------------------
//
// The value of a sensitive field (KEY=VALUE, key: value to the end of the line, "key":
// "value" with escaped quotes, :=, ?=, ==, a typed `password: string = …`), a sensitive
// --flag or -Parameter value, Authorization and Cookie headers, Bearer/Basic credentials,
// the password in a web address or after curl's -u, and a PowerShell SecureString literal.

// A sensitive key, tested after camelCase and "-" become "_" (dbPassword, x-api-key,
// _authToken, authtoken, PGPASSWORD, MYSQL_PWD, ENCRYPTION_KEY, clientsecret, secretkey,
// X-Amz-Signature, ?sig=).
// A key merely ending in "Key" isn't one: the engine's own fileKey and sessionKey hold ids.
const SECRET_KEY_RE = /(?:(?<![A-Za-z])(?:API_?KEYS?|ACCESS_?KEY|PRIVATE_?KEY|PASSPHRASE|PASS|AUTHORIZATION|AUTH|COOKIE|CREDENTIALS?|SIGNATURE|SIG)|PASSWORD|PASSWD|TOKEN|SECRET(?:_?KEY)?|(?<=_)PWD|(?:ENCRYPTION|SIGNING|MASTER|CLIENT|LICENSE|SERVICE|DEPLOY|SESSION_SECRET|SSH|GPG|PGP|HMAC|JWT|AES|APP)_?KEY)(?![A-Za-z])/i;
export const normalKey = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_');
// ODBC's `PWD=…;` (any case) counts only as the whole key, so `pwd-…` in a token isn't one.
export const keyIsSecret = (key) => SECRET_KEY_RE.test(normalKey(key)) || /(?:^|\.)pwd$/i.test(key);
// Keys whose value may hold spaces, so a "key: value" runs to the end of the line.
const PASSWORD_KEY_RE = /(?:PASSWORD|PASSWD|PASSPHRASE|(?<=_)PASS|(?<=_)PWD)(?![A-Za-z])/i;
const TYPE_AHEAD_RE = /^(?:string|str|String|number|boolean|bytes|SecretStr|SecureString|Option<|Optional\[|any)\b/;
// A value read after ":" that is a type and nothing else (`string`, `str[]`, `Option<String>`).
const TYPE_ONLY_RE = /^(?:(?:string|str|String|number|boolean|bytes|SecretStr|SecureString|any)(?:\[\])*|Option<[\w<>]*>|Optional\[[\w[\]]*\])$/;
const WHOLE_LINE_KEY_RE = /(?:^|_)(?:AUTHORIZATION|COOKIE)$/i;
// Each identifier is read once from its front; its value is read only when the key is
// sensitive, so an ordinary key never swallows the next one and matching stays linear.
const IDENTIFIER_RE = /(?<![A-Za-z0-9_])[A-Za-z0-9_][A-Za-z0-9_-]*/g;
// The rest of a dotted flag name after its first part (`.token` in `--docs.token`). Each part
// starts with a letter, digit or "_", so a sentence's closing dot isn't one.
const DOTTED_NAME_RE = /(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)+/y;
const HSPACE = String.raw`[^\S\r\n]*`;
// After the key: its closing quote (escaped or not), a Go type (`var password string =`),
// an optional `?` (`password?: string`), the separator, and a type name between ":" and
// "=" when there is one (`password: string = "…"`).
const TYPE_NAME = String.raw`(?:string|str|String|bytes|\[\]byte|SecretStr|SecureString|any|&str|char\s?\*)`;
const FIELD_SEP_RE = new RegExp(String.raw`\\*["']?(?:[^\S\r\n]+${TYPE_NAME}(?=${HSPACE}=))?${HSPACE}\??(===|=>|:=|\?=|==|=|:)${HSPACE}(?:${TYPE_NAME}${HSPACE}=${HSPACE})?`, 'y');
// The next `key: ` on a joined line: a colon followed by a space or a quote, so a credential
// like `AWS id:signature`, a web address or a time doesn't count.
const NEXT_KEY_RE = /[A-Za-z_][A-Za-z0-9_-]*["']?[ \t]*:(?=[ \t"'])/y;
// A quoted value whose would-be closing quote opens a sensitive key's own value instead
// (`token: "Ab3d, api_key: "Xk9…"`) was left unclosed: it ends before that key.
const KEY_BEFORE_QUOTE_RE = /([A-Za-z_][A-Za-z0-9_-]*)\\*["']?[ \t]*(?::=|\?=|===|=>|==|=|:)[ \t]*\\*$/;
// After a --flag or -Parameter: spaces, then a value that isn't another flag.
const FLAG_SEP_RE = new RegExp(String.raw`[^\S\r\n]+(?=[^\s-])`, 'y');
const SCHEME_RE = /(?:bearer|basic|token|digest)[^\S\r\n]+/iy;
/** Bearer and Basic credentials: groups are the scheme, the gap, then the credential. The
 *  scheme and one credential character are exported for a scrubber that reads the
 *  credential across its own placeholders. */
export const BEARER_SCHEME = 'bearer|basic';
export const BEARER_CHAR = '[A-Za-z0-9._~+/=-]';
export const BEARER_RE = new RegExp(String.raw`\b(${BEARER_SCHEME})([ \t]+)${BEARER_CHAR}{8,}`, 'gi');
/** True when what BEARER_RE took for a credential is a plain word (`basic validation`,
 *  `Bearer authentication`, `basic end-to-end`): lowercase, Capitalized or all-caps parts
 *  joined by "-", maybe ending a sentence. The published scrubber and the prompt audit
 *  leave those; a real credential mixes cases inside a part, or holds a digit or a symbol. */
export function plainWords(credential) {
  let end = credential.length;
  while (end > 0 && credential[end - 1] === '.') end -= 1;
  return credential.slice(0, end).split('-').every((p) => /^(?:[a-z]+|[A-Z][a-z]*|[A-Z]+)$/.test(p));
}
/** scheme://user:password@host. Group 1 runs through the ":" before the password. The user
 *  may be empty (redis://:password@host); the password may hold an "@" itself and ends at
 *  the last one. */
export const URL_PASSWORD_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@"']*:)[^\s/"']+(?=@)/g;
/** curl and wget basic auth: -u user:password, --user user:password, --user=user:password.
 *  Groups are the flag, the user through its ":", then the password. The user part is
 *  capped, so a long run with no ":" is scanned once per flag (linear). */
export const USER_PASSWORD_RE = /(?<![\w-])(-u|--user)([ \t=]+["']?[^\s:"']{1,256}:)([^\s"']+)/g;
/** A PowerShell SecureString literal: groups are the command (with its -String,
 *  -AsPlainText and -Force switches), the quote, then the value. */
export const SECURE_STRING_RE = /(ConvertTo-SecureString(?:[ \t]+-(?:String|AsPlainText|Force)(?![\w-]))*[ \t]+)(["'])([^"'\n]*)\2/gi;
/** A literal piped into ConvertTo-SecureString (`"…" | ConvertTo-SecureString`): groups are
 *  the quote, the value, then the pipe and the command. */
export const SECURE_PIPE_RE = /(["'])([^"'\n]*)\1([ \t]*\|[ \t]*ConvertTo-SecureString\b)/gi;
/** An XML element whose tag names a secret (`<password>…</password>`): groups are the opening
 *  tag, its name, the value, then the closing tag. Names and values are capped, so a long run
 *  is scanned once per "<". */
export const XML_FIELD_RE = /(<((?:[A-Za-z_][\w.-]{0,63}:)?[A-Za-z_][\w.-]{0,63})(?:[ \t][^<>\n]{0,256})?>)([^<\n]{1,4096})(<\/\2>)/g;
/** True when an XML tag's name (without a namespace prefix) names a secret. */
export const xmlTagIsSecret = (name) => keyIsSecret(name.replace(/^.*:/, ''));

/** Where a value starting at `p` ends, and the part of it to hide. A double-quoted string
 *  opened by a quote escaped with `n` backslashes (n = 0 in plain JSON, 1 in JSON inside a
 *  JSON string, 3 a level deeper) closes at the next quote whose backslash count is n, or n
 *  plus a multiple of 2(n + 1): an escaped backslash right before the closing quote doesn't
 *  hide it, and an escaped quote inside the value doesn't end it. A quoted value cut off
 *  before its close runs to the end of the line. `mode` sets where an unquoted value ends:
 *  'line' at the end of the line (a password line, a header), 'word' at the next space
 *  (after "="), 'tight' also at , ; and at ) } ] that close the value (after ":", where JSON
 *  and code go on). `lineEnd(p)` gives the end of the line holding p. */
function readValue(s, p, mode, lineEnd) {
  const open = /\\*"/y;
  open.lastIndex = p;
  const o = open.exec(s);
  if (o) {
    const nl = lineEnd(p);
    const n = o[0].length - 1;
    const step = ((n + 1) & n) === 0 ? 2 * (n + 1) : 0;
    for (let i = p + o[0].length; i < nl; ) {
      const q = s.indexOf('"', i);
      if (q < 0 || q > nl) break;
      let k = 0;
      while (k < q - i && s[q - 1 - k] === '\\') k += 1;
      if (k === n || (step && k > n && (k - n) % step === 0)) {
        const lead = s.slice(Math.max(p + o[0].length, q - 96), q);
        const km = KEY_BEFORE_QUOTE_RE.exec(lead);
        if (km && keyIsSecret(km[1]) && !/[A-Za-z0-9_-]/.test(lead[km.index - 1] ?? s[q - lead.length - 1] ?? '')) {
          let end = q - lead.length + km.index;
          while (end > p + o[0].length && /\s/.test(s[end - 1])) end -= 1;
          if (end > p + o[0].length) return { start: p + o[0].length, end, after: q - lead.length + km.index };
          // Nothing before the key: this quote opens that key's value, so read on to the next close.
          i = q + 1;
          continue;
        }
        return { start: p + o[0].length, end: q - n, after: q + 1 };
      }
      i = q + 1;
    }
    let end = nl;
    while (end > p && /\s/.test(s[end - 1])) end -= 1;
    return end > p + o[0].length ? { start: p + o[0].length, end, after: end } : null;
  }
  if (s[p] === "'") {
    const nl1 = lineEnd(p);
    const first = s.indexOf("'", p + 1);
    for (let q = first; q > p && q < nl1; q = s.indexOf("'", q + 1)) {
      const lead = s.slice(Math.max(p + 1, q - 96), q);
      const km = KEY_BEFORE_QUOTE_RE.exec(lead);
      if (km && keyIsSecret(km[1]) && !/[A-Za-z0-9_-]/.test(lead[km.index - 1] ?? s[q - lead.length - 1] ?? '')) {
        let end = q - lead.length + km.index;
        while (end > p + 1 && /\s/.test(s[end - 1])) end -= 1;
        if (end > p + 1) return { start: p + 1, end, after: q - lead.length + km.index };
        continue;
      }
      return { start: p + 1, end: q, after: q + 1 };
    }
    if (first > p && first < nl1) return { start: p + 1, end: first, after: first + 1 };
  }
  let end = p;
  // A quote with a letter, digit or "_" on both sides is part of the value (`xk9'mp2qrz`), not
  // the end of the text around it.
  const quoteEnds = (i) => !(/\w/.test(s[i - 1] ?? '') && /\w/.test(s[i + 1] ?? ''));
  if (mode === 'line') {
    // The line ends at a newline, a quote, or the next `key:`, since the engine joins an
    // excerpt's lines into one and a later key must be read on its own.
    const nl = lineEnd(p);
    while (end < nl && s[end] !== '\r' && !('"\''.includes(s[end]) && quoteEnds(end))) {
      if (end > p && /\s/.test(s[end - 1]) && /[A-Za-z_]/.test(s[end])) {
        NEXT_KEY_RE.lastIndex = end;
        if (NEXT_KEY_RE.test(s)) break;
      }
      end += 1;
    }
    while (end > p && /\s/.test(s[end - 1])) end -= 1;
  } else {
    SCHEME_RE.lastIndex = p;
    if (SCHEME_RE.exec(s)) end = SCHEME_RE.lastIndex;
    const closes = (i) => mode === 'tight' && ')}]'.includes(s[i]) && (i + 1 >= s.length || /[\s"',;:)}\].?!]/.test(s[i + 1]));
    const stops = mode === 'tight' ? (i) => /[\s,;]/.test(s[i]) || ('"\''.includes(s[i]) && quoteEnds(i)) : (i) => /\s/.test(s[i]);
    while (end < s.length && !stops(end) && !closes(end)) end += 1;
  }
  return end > p ? { start: p, end, after: end } : null;
}

/** A sensitive key's value that isn't a secret: a flag value (`requiresAuth: true`) or a
 *  test count (`pass: 793`). */
export const notASecret = (key, value) => /^(?:true|false|null|undefined|none|nil)$/i.test(value) || (/^pass$/i.test(key) && /^\d+$/.test(value));

/** Hide the value of every sensitive field and flag in `s`. `hide(text, start, end)` gets
 *  one value and where it sits in `s` (UTF-16 indexes, `end` exclusive), and returns its
 *  replacement, or null to leave it. */
export function secretFields(s, hide) {
  let out = '';
  let at = 0;
  const ids = new RegExp(IDENTIFIER_RE.source, 'g');
  let nlAt = -1;
  const lineEnd = (p) => {
    if (nlAt < p) {
      nlAt = s.indexOf('\n', p);
      if (nlAt < 0) nlAt = s.length;
    }
    return nlAt;
  };
  for (let m = ids.exec(s); m; m = ids.exec(s)) {
    // A flag's name may hold dots (`--docs.token`, `-Docs.Token`): it's read whole, each dot
    // standing for "_", as `--docs-token` is. A name that isn't sensitive whole is left, and
    // its later parts are read on their own as before.
    let name = m[0];
    let end = m.index + m[0].length;
    if (s[m.index - 1] === '-') {
      DOTTED_NAME_RE.lastIndex = end;
      const dotted = DOTTED_NAME_RE.exec(s);
      if (dotted) {
        name = (m[0] + dotted[0]).replace(/\./g, '_');
        end += dotted[0].length;
      }
    }
    if (!keyIsSecret(name)) continue;
    let v = null;
    FIELD_SEP_RE.lastIndex = end;
    const sep = FIELD_SEP_RE.exec(s);
    const key = normalKey(name);
    // A password line runs to its end unless what follows is a type (`password: string)`).
    const typed = TYPE_AHEAD_RE.test(s.slice(FIELD_SEP_RE.lastIndex, FIELD_SEP_RE.lastIndex + 24));
    // A type annotation has no value (`login(password: string, remember: boolean)`); one with
    // a value after it (`password: string = "…"`) was read past by the separator. Hidden as a
    // value, it made a second pass read the field another way (a placeholder isn't a type).
    // Anything glued to the type word is read as a value, the way it would be without it. A
    // header (Authorization, Cookie) always runs to the end of its line.
    if (sep && sep[1] === ':' && typed && !WHOLE_LINE_KEY_RE.test(key)) {
      const t = readValue(s, FIELD_SEP_RE.lastIndex, 'tight', lineEnd);
      if (t && TYPE_ONLY_RE.test(s.slice(t.start, t.end))) continue;
    }
    if (sep) v = readValue(s, FIELD_SEP_RE.lastIndex, WHOLE_LINE_KEY_RE.test(key) || (sep[1] === ':' && PASSWORD_KEY_RE.test(key)) ? 'line' : sep[1] === ':' ? 'tight' : 'word', lineEnd);
    else if (s[m.index - 1] === '-') {
      FLAG_SEP_RE.lastIndex = end;
      if (FLAG_SEP_RE.exec(s)) v = readValue(s, FLAG_SEP_RE.lastIndex, 'word', lineEnd);
    }
    if (!v) continue;
    const text = s.slice(v.start, v.end);
    if (notASecret(name, text)) continue;
    const hidden = hide(text, v.start, v.end);
    if (hidden === null) continue;
    out += s.slice(at, v.start) + hidden;
    at = v.end;
    ids.lastIndex = Math.max(v.after, v.end);
  }
  return out + s.slice(at);
}

/** True when a field's value is only `*` and `_`: the close of a Markdown bold label
 *  (`**Auth:** …`) or a value already masked (`password: ****`), never a secret. */
export const markupOnly = (value) => /^[*_]+$/.test(value);

// Set-aside parts are written as tokens: a delimiter of Private-Use-Area characters that the
// text doesn't hold, a number, the delimiter again.
const SENTINEL = String.fromCharCode(0xe000);
/** A delimiter as a pattern: a run of one character as a counted repeat, so a long run (the
 *  text held a long run of U+E000) doesn't make a pattern too large to build. */
const delimiterSource = (d) => (d.length > 1 && [...d].every((c) => c === d[0]) ? `${d[0]}{${d.length}}` : d);
/** U+E000, repeated once more than its longest run in `text` (found in one pass). */
function sentinelFor(text) {
  let longest = 0;
  for (let i = 0, run = 0; i < text.length; i += 1) {
    run = text.charCodeAt(i) === 0xe000 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return SENTINEL.repeat(longest + 1);
}
/** The delimiter for the tokens the scrubbers and the audit set parts aside as: one
 *  Private-Use-Area character `text` doesn't hold (U+E000 unless the text has it), found in
 *  one pass, so authored text can never impersonate a token. When the text holds every one of
 *  them, a run of U+E000 longer than any in the text. */
export function freshDelimiter(text) {
  const seen = new Uint8Array(0xf900 - 0xe000);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xe000 && c < 0xf900) seen[c - 0xe000] = 1;
  }
  const free = seen.indexOf(0);
  return free >= 0 ? String.fromCharCode(0xe000 + free) : sentinelFor(text);
}
/** The pattern for one token, `delimiter digits delimiter`, with the digits as group 1. */
export const tokenSource = (delimiter) => `${delimiterSource(delimiter)}(\\d+)${delimiterSource(delimiter)}`;

/** The published scrubber's secret-field step, shared with the prompt audit: the password in
 *  a web address and after curl's -u, a SecureString literal, the value of every sensitive
 *  field and flag, and a Bearer or Basic credential that isn't a plain word. It reads `s`, a
 *  text in which the caller set its placeholders aside as tokens (`delimiter`, a number,
 *  `delimiter`); a value made only of those is left as it is. `partText(n)` gives token n's
 *  text. `hide(value)` returns the token to put in place of one value, which later rules here
 *  read as a placeholder. Returns the new text. */
export function hideSecretFields(s, { delimiter, partText, hide }) {
  const d = delimiterSource(delimiter);
  const tokens = new RegExp(tokenSource(delimiter), 'g');
  const held = (v) => v.replace(tokens, '').trim() === '';
  const restore = (v) => v.replace(tokens, (m, n) => partText(Number(n)) ?? m);
  let out = s.replace(URL_PASSWORD_RE, (m, head) => (held(m.slice(head.length)) ? m : head + hide(m.slice(head.length))));
  out = out.replace(USER_PASSWORD_RE, (m, flag, user, value) => (held(value) ? m : flag + user + hide(value)));
  out = out.replace(SECURE_STRING_RE, (m, head, q, value) => (value && !held(value) ? `${head}${q}${hide(value)}${q}` : m));
  out = out.replace(SECURE_PIPE_RE, (m, q, value, tail) => (value && !held(value) ? `${q}${hide(value)}${q}${tail}` : m));
  out = out.replace(XML_FIELD_RE, (m, open, name, value, close) => (xmlTagIsSecret(name) && value.trim() && !held(value) && !markupOnly(value.trim()) && !notASecret(name.replace(/^.*:/, ''), value.trim()) ? `${open}${hide(value)}${close}` : m));
  out = secretFields(out, (value) => (held(value) || markupOnly(value) ? null : hide(value)));
  // A credential may run into a placeholder (`Bearer abc[redacted:term]def`); it's hidden whole.
  const bearer = new RegExp(String.raw`\b(${BEARER_SCHEME})([ \t]+)((?:${BEARER_CHAR}|${d}\d+${d})+)`, 'gi');
  out = out.replace(bearer, (m, scheme, gap, credential) => {
    const text = restore(credential);
    return held(credential) || text.length < 8 || plainWords(text) ? m : `${scheme}${gap}${hide(credential)}`;
  });
  // KEY=VALUE once more, on the text as it now reads. A sensitive key the scrubber's step 2 read
  // as part of another key's value (`x = --token=**`, until `x` was hidden here) is read for
  // itself now, as a second pass would read it. Only the value (or a comparison's operand)
  // goes; one that is already a placeholder, maybe quoted, stays.
  const leadToken = new RegExp(`^${tokenSource(delimiter)}`);
  const settled = (v) => {
    const w = v.replace(/^["']/, '');
    if (w.trim() === '') return w !== '';
    const t = leadToken.exec(w);
    return t !== null && (w.length === t[0].length || w[t[0].length] === '"' || w[t[0].length] === "'");
  };
  const re = new RegExp(KV_AGAIN.source, 'g');
  const rest = /\S*/y;
  let result = '';
  let at = 0;
  for (let m = re.exec(out); m !== null; m = re.exec(out)) {
    const [whole, key, value] = m;
    if (!SENSITIVE_KV_KEY.test(key)) continue;
    const operand = value.replace(/^=+/, '');
    if (operand === '' || settled(operand)) continue;
    // What is glued after the value, read only for a value that is hidden: read at every
    // KEY=VALUE, it made a long run with no space in it (`x='a='x='a='…`) quadratic.
    rest.lastIndex = m.index + whole.length;
    const tail = rest.exec(out)[0];
    result += out.slice(at, m.index) + whole.slice(0, whole.length - operand.length) + hide(operand + tail);
    at = m.index + whole.length + tail.length;
    re.lastIndex = at;
  }
  return result + out.slice(at);
}
const KV_AGAIN = new RegExp(REDACTION_SOURCES.keyValue, 'g');
const SENSITIVE_KV_KEY = new RegExp(REDACTION_SOURCES.sensitiveKey, 'i');

// A record read back as JSON loses the text around its values, so a value is hidden when
// its own key is sensitive ({"password": "…"}, {"x-api-key": "…"}). Only a key shaped like
// an identifier counts: an answer keyed by a question's text keeps its value.
export const IDENTIFIER_KEY = /^[A-Za-z_$][\w$.-]{0,63}$/;
// A long number under a password-like key ({"password": 12345678}) is hidden too.
export const NUMERIC_SECRET_KEY_RE = /(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|(?<![A-Za-z])PIN)(?![A-Za-z])/i;
const ANY_PLACEHOLDER_RE = /\[redacted:\w+\]/g;
/** True when `value` holds a placeholder and nothing else but whitespace. Checked by removing
 *  them, not by one pattern with nested repeats, which backtracks exponentially when
 *  whitespace between many placeholders is followed by other text. */
export function onlyPlaceholders(value) {
  const rest = value.replace(ANY_PLACEHOLDER_RE, '');
  return rest.length < value.length && rest.trim() === '';
}

/** A term's words, split the way termMatchers splits them: each word is matched whole and in
 *  order, with only separators or nothing between them, so a text that matches a term holds
 *  every one of its words. The scrubber reads the same words to skip a term whose words
 *  aren't all in a text. */
export const termWords=(t)=>t.trim().split(/\s+/);
/** The characters that lowercase onto a plain English letter, or match one when a pattern
 *  ignores case (/iu): dotted capital I, long s and the Kelvin sign. A text holding one runs
 *  every term's patterns, whatever its words. */
export const FOLDS_ONTO_ASCII=/[\u0130\u017F\u212A]/;
/** `text` lowercased for the term check, with those three characters folded onto the letter
 *  they could stand for (i, s, k), so the check still finds every word a pattern could match
 *  and the fast path stays on. */
export const lowerForTerms=(text)=>(FOLDS_ONTO_ASCII.test(text)?text.replace(/\u0130/g,'i').replace(/\u017F/g,'s').replace(/\u212A/g,'k'):text).toLowerCase();
/** A term in each Unicode spelling it may be written in (as configured, composed NFC and
 *  decomposed NFD), so `café` listed one way still matches text written the other way. */
export const termSpellings=(t)=>[...new Set([t,t.normalize('NFC'),t.normalize('NFD')])];
/** The lowercased words the scrubber looks for before it runs a term's patterns, or null for
 *  a term with any character outside plain ASCII, which always runs. It's safe because
 *  anyCase spells each plain English letter as a class of its two cases, so no other
 *  character can match one. */
export const skipWords=(t)=>/^[\x00-\x7f]*$/.test(t)?termWords(t).map((w)=>w.toLowerCase()):null;
/** termMatchers(terms, names = []): `names` are the person names among `terms`. */
export function termMatchers(terms,names=[]){const people=new Set(names.filter((t)=>typeof t==='string').flatMap(termSpellings).map((t)=>t.trim().toLowerCase()));return terms.filter((t)=>typeof t==='string'&&t.trim()).flatMap(termSpellings).sort((x,y)=>y.trim().length-x.trim().length).flatMap((t)=>{const words=termWords(t);const cs=[...t.trim()];const word=new RegExp(`${edge(cs[0],'start')}${words.map(anyCase).join('(?:\\s+|[-_.]?)')}${edge(cs.at(-1),'end')}`,'gu');if(t.includes('.')||(t.match(/\p{L}/gu)??[]).length<4)return [word];const glued=words.map(anyCase).join('[-_]?');const part=`(?<!${PART})(?=${PART}*?${START_EDGE}${glued})(?=(${PART}+))\\1`;const dotless=across(new RegExp(`${AFTER_SCHEME}${part}(?!\\.[\\p{L}\\p{N}])`,'gu'));if(people.has(t.trim().toLowerCase()))return [across(new RegExp(`(?:${AFTER_SCHEME}|(?<=@)|(?<=(?<![\\p{L}\\p{N}_-])www\\.))${part}(?=(?:\\.${PIECE}){0,8}${ENDING})`,'gu')),across(new RegExp(`${part}(?=(?:\\.${PIECE}){0,8}${WEB_ENDING})`,'gu')),dotless,word];return [across(new RegExp(`${part}(?=(?:\\.${PIECE}){0,8}${ENDING})`,'gu')),dotless,word];});}

// --- fields read after the scrubbers' own rules ---------------------------------------
//
// Three more spellings of a secret field: a Java or Gradle property (`-Dapi.key=…`,
// `-Psigning.password=…`), a dotted key whose secret name runs across its last dot
// (`api.key=…`, `secret.key: …`), and a value after ":" whose opening single quote never
// closes on its line (`password: '…`).
//
// They are read in a pass of their own, over the text a scrubber has finished with, and never
// inside its rules. The pass can only put more placeholders down: a placeholder already there
// is opaque to it (never read as a name, never removed, split or moved), and no character
// outside the spans it hides changes. So whatever the rules above hide stays hidden, whatever
// this pass reads, and nothing it does can change what those rules saw.

const LATER_MASK = String.fromCharCode(0xe000);
const DOT_KEY_ALL_RE = new RegExp(SECRET_KEY_RE.source, 'gi');
/** True when a secret's name runs across the last dot of a dotted word (`api.key`,
 *  `secret.key`, `aws.secret.access.key`, `x.pwd`) and its last part alone doesn't name one
 *  (`db.password`, which the rules above read by its last part). `password.length` and
 *  `auth.ts` are a property and a file name. Only the last two parts are read. */
function secretAcrossDot(name) {
  const cut = name.lastIndexOf('.');
  const last = name.slice(cut + 1);
  if (cut < 0 || keyIsSecret(last)) return false;
  const head = normalKey(name.slice(name.lastIndexOf('.', cut - 1) + 1, cut));
  const joined = `${head}_${normalKey(last)}`;
  DOT_KEY_ALL_RE.lastIndex = 0;
  for (let m = DOT_KEY_ALL_RE.exec(joined); m; m = DOT_KEY_ALL_RE.exec(joined)) {
    if (m.index + m[0].length > head.length + 1) return true;
  }
  return false;
}
/** Whether a record's own key names a secret, for deepRedact and the view's leak count: a key
 *  the rules above call sensitive, or a dotted one whose secret name runs across its last dot
 *  (`api.key`). */
export const recordKeyIsSecret = (key) => keyIsSecret(key) || secretAcrossDot(key);

/** The spans of `s` the later pass hides, as [start, end) pairs in UTF-16 units, in order and
 *  apart. `s` is a scrubber's finished text. Each identifier is read once from its front and a
 *  value read is skipped past, as in secretFields, so the pass is linear. A value is read the
 *  way secretFields reads one (readValue), over a copy of the text with every placeholder
 *  masked, and the placeholders inside it are left out of what is hidden. */
export function laterFieldSpans(s) {
  const marks = [];
  const masked = s.replace(ANY_PLACEHOLDER_RE, (m, at) => {
    marks.push([at, at + m.length]);
    return LATER_MASK.repeat(m.length);
  });
  const spans = [];
  let mark = 0;
  // The parts of a value from `start` to `end` that aren't placeholders, trimmed of spaces.
  const keep = (start, end) => {
    while (mark < marks.length && marks[mark][1] <= start) mark += 1;
    let from = start;
    for (let k = mark; from < end; k += 1) {
      const to = k < marks.length && marks[k][0] < end ? marks[k][0] : end;
      let a = from;
      let b = to;
      while (a < b && /\s/.test(s[a])) a += 1;
      while (b > a && /\s/.test(s[b - 1])) b -= 1;
      if (b > a) spans.push([a, b]);
      if (to === end) break;
      from = Math.min(end, marks[k][1]);
    }
  };
  const ids = new RegExp(IDENTIFIER_RE.source, 'g');
  let nlAt = -1;
  const lineEnd = (p) => {
    if (nlAt < p) {
      nlAt = masked.indexOf('\n', p);
      if (nlAt < 0) nlAt = masked.length;
    }
    return nlAt;
  };
  // Where the last dotted word read ends: an identifier before it is one of its later parts.
  let dottedEnd = 0;
  for (let m = ids.exec(masked); m; m = ids.exec(masked)) {
    const flag = masked[m.index - 1] === '-';
    let rest = '';
    if (flag || m.index >= dottedEnd) {
      DOTTED_NAME_RE.lastIndex = m.index + m[0].length;
      rest = DOTTED_NAME_RE.exec(masked)?.[0] ?? '';
    }
    const whole = m[0] + rest;
    const wholeEnd = m.index + whole.length;
    if (wholeEnd > dottedEnd) dottedEnd = wholeEnd;
    // A name only this pass reads (`added`), or one the rules above read too: for that one,
    // only a value they left because its single quote never closes is read here.
    let name = m[0];
    let end = m.index + m[0].length;
    let added = false;
    if (flag) {
      const dotted = whole.replace(/\./g, '_');
      const property = masked[m.index - 2] !== '-' && /^[DP][A-Za-z0-9_]/.test(whole) && masked[wholeEnd] === '=';
      if (keyIsSecret(dotted)) [name, end] = [dotted, wholeEnd];
      else if (property && keyIsSecret(dotted.slice(1))) [name, end, added] = [dotted.slice(1), wholeEnd, true];
      else continue;
    } else if (rest && secretAcrossDot(whole)) [name, end, added] = [whole.replace(/\./g, '_'), wholeEnd, true];
    else if (!keyIsSecret(name)) continue;
    FIELD_SEP_RE.lastIndex = end;
    const sep = FIELD_SEP_RE.exec(masked);
    if (!sep) continue;
    const p = FIELD_SEP_RE.lastIndex;
    const key = normalKey(name);
    if (sep[1] === ':' && TYPE_AHEAD_RE.test(masked.slice(p, p + 24)) && !WHOLE_LINE_KEY_RE.test(key)) {
      const t = readValue(masked, p, 'tight', lineEnd);
      if (t && TYPE_ONLY_RE.test(masked.slice(t.start, t.end))) continue;
    }
    const mode = WHOLE_LINE_KEY_RE.test(key) || (sep[1] === ':' && PASSWORD_KEY_RE.test(key)) ? 'line' : sep[1] === ':' ? 'tight' : 'word';
    let v = readValue(masked, p, mode, lineEnd);
    // The rules above read this value themselves, and hid it or left it for a reason.
    if (v && !added) continue;
    // After ":", a single quote that opens no closed value: read on from after it, the way the
    // value would be read without it. A quote followed by a space, the end, or , ; ) ] } . +
    // closes the text the key sits in (`'Password:',`), and opens no value.
    if (!v && sep[1] === ':' && masked[p] === "'" && /[^\s,;)\]}.+]/.test(masked[p + 1] ?? ' ')) v = readValue(masked, p + 1, mode, lineEnd);
    if (!v) continue;
    const text = s.slice(v.start, v.end);
    if (!notASecret(name, text) && !markupOnly(text)) keep(v.start, v.end);
    ids.lastIndex = Math.max(v.after, v.end, ids.lastIndex);
  }
  return spans;
}

/** `s` with the later pass's spans replaced by `placeholder`; `counted()` is called once per span. */
export function hideLaterFields(s, placeholder, counted = () => {}) {
  const spans = laterFieldSpans(s);
  if (!spans.length) return s;
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    counted();
    out += s.slice(at, start) + placeholder;
    at = end;
  }
  return out + s.slice(at);
}

// --- fields read from the text as it was written ---------------------------------------
//
// The rules above read a field's value and move on past it. When that value is itself a name
// (`api_key=token: …`, `password="token": "…"`, `token: "Ab3d, api.key: "…"`), they hide the
// name and the real value after it is left. And the KEY=VALUE rule reads a key only where an
// earlier `name=` hasn't taken it for a value (`x=` on one line, `apiKey` on the next, `=…`
// on the third).
//
// Those values are found here, in the text as it was written: by then the scrubbers have put a
// placeholder where the inner name was, so their finished text no longer says there was one.
// What is found is hidden in addition to everything the scrubbers hide. hideSourceFields takes
// a scrubber's finished text and only swaps more of its shown characters for a placeholder,
// and the audit only adds spans between the ones it has. So nothing the rules above hide can
// show again, whatever is read here.

// What the KEY=VALUE rule reads after its key, from a fixed start.
const KV_REST_RE = /\s*=\s*("[^"]*"|'[^']*'|\S+)/y;
// A word every sensitive key holds: each name SECRET_KEY_RE matches has one of these in it, and
// normalKey only adds "_" to a name, so a text with none of them has no sensitive key at all.
const SECRET_NAME_HINT_RE = /KEY|PASS|AUTH|COOKIE|CREDENTIAL|SIG|TOKEN|SECRET|PWD/i;
const TAIL_SEP_CHAR = /[\\"' \t:=?]/;
const NAME_CHAR = /[A-Za-z0-9_.-]/;
// What is trimmed from each end of a piece hidden here: spaces, and quotes with their escapes.
const EDGE_CHAR = /[\s\\"']/;

/** The spans of `s`, a text as it was written, that hold a value the rules above leave shown
 *  because of what sits before it, as [start, end) pairs in UTF-16 units, in order and apart:
 *  - the value after a name that ends a secret field's own value, or is all of it in quotes
 *    (`api_key=token: …`, `password="token": "…"`, `token: "see api.key: "…"`), any number of
 *    names deep. The inner name must name a secret itself, or be one quoted word;
 *  - the value of a KEY=VALUE key split from its "=" or its value by a line break, which the
 *    rule misses when an earlier `name=` took the key for its value.
 *  Placeholders already in `s` are masked and left out, as in laterFieldSpans. A field is read
 *  the way secretFields reads it and is skipped past, and each inner value starts at or after
 *  the end of the one before it, so the pass is linear. */
export function sourceFieldSpans(s) {
  // Every span here follows a sensitive key. A text that names none is done in one search,
  // so the audit, which reads its source and then its rendition, pays for neither.
  if (!SECRET_NAME_HINT_RE.test(s)) return [];
  const marks = [];
  const masked = s.replace(ANY_PLACEHOLDER_RE, (m, at) => {
    marks.push([at, at + m.length]);
    return LATER_MASK.repeat(m.length);
  });
  const spans = [];
  let mark = 0;
  // The parts of a value from `start` to `end` that aren't placeholders, trimmed of spaces and of
  // quotes: a quote is where the rules stop reading a line, and one left in place stops a second
  // pass where it stopped the first. What is left of a value next to a placeholder inside it is
  // kept only when it holds a letter or a digit (`":` between two placeholders isn't a value).
  const keep = (start, end) => {
    while (mark < marks.length && marks[mark][1] <= start) mark += 1;
    let from = start;
    for (let k = mark; from < end; k += 1) {
      const to = k < marks.length && marks[k][0] < end ? marks[k][0] : end;
      let a = from;
      let b = to;
      while (a < b && EDGE_CHAR.test(s[a])) a += 1;
      while (b > a && EDGE_CHAR.test(s[b - 1])) b -= 1;
      if (b > a && ((from === start && to === end) || /[\p{L}\p{N}]/u.test(s.slice(a, b)))) spans.push([a, b]);
      if (to === end) break;
      from = Math.min(end, marks[k][1]);
    }
  };
  let nlAt = -1;
  const lineEnd = (p) => {
    if (nlAt < p) {
      nlAt = masked.indexOf('\n', p);
      if (nlAt < 0) nlAt = masked.length;
    }
    return nlAt;
  };
  // The value of the field whose name ends at `end`, read as secretFields reads it.
  const valueOf = (name, end, flag) => {
    const key = normalKey(name);
    FIELD_SEP_RE.lastIndex = end;
    const sep = FIELD_SEP_RE.exec(masked);
    if (!sep) {
      if (!flag) return null;
      FLAG_SEP_RE.lastIndex = end;
      return FLAG_SEP_RE.exec(masked) ? readValue(masked, FLAG_SEP_RE.lastIndex, 'word', lineEnd) : null;
    }
    const p = FIELD_SEP_RE.lastIndex;
    const wholeLine = WHOLE_LINE_KEY_RE.test(key);
    if (sep[1] === ':' && !wholeLine && TYPE_AHEAD_RE.test(masked.slice(p, p + 24))) {
      const t = readValue(masked, p, 'tight', lineEnd);
      if (t && TYPE_ONLY_RE.test(masked.slice(t.start, t.end))) return null;
    }
    const mode = wholeLine || (sep[1] === ':' && PASSWORD_KEY_RE.test(key)) ? 'line' : sep[1] === ':' ? 'tight' : 'word';
    let v = readValue(masked, p, mode, lineEnd);
    // A single quote that never closes, read the way laterFieldSpans reads it.
    if (!v && sep[1] === ':' && masked[p] === "'" && /[^\s,;)\]}.+]/.test(masked[p + 1] ?? ' ')) v = readValue(masked, p + 1, mode, lineEnd);
    return v && { ...v, line: mode === 'line' };
  };
  // The name a value ends with, when its separator runs to the value's end or past it: the
  // value was a name, and the real one comes next. Null when there is none.
  const innerName = (v) => {
    let ne = v.end;
    while (ne > v.start && TAIL_SEP_CHAR.test(masked[ne - 1])) ne -= 1;
    let ns = ne;
    while (ns > v.start && ne - ns <= 96 && NAME_CHAR.test(masked[ns - 1])) ns -= 1;
    if (ne - ns > 96) return null;
    while (ns < ne && /[.-]/.test(masked[ns])) ns += 1;
    if (ns === ne) return null;
    FIELD_SEP_RE.lastIndex = ne;
    if (!FIELD_SEP_RE.exec(masked) || FIELD_SEP_RE.lastIndex < v.end) return null;
    const name = masked.slice(ns, ne);
    const quotedWord = ns === v.start && ne === v.end && /["']/.test(masked[ns - 1] ?? '') && /["'\\]/.test(masked[ne] ?? '');
    const secret = keyIsSecret(name.slice(name.lastIndexOf('.') + 1)) || secretAcrossDot(name) || (masked[ns - 1] === '-' && keyIsSecret(name.replace(/\./g, '_')));
    return secret || quotedWord ? { name: name.replace(/\./g, '_'), end: ne } : null;
  };
  const ids = new RegExp(IDENTIFIER_RE.source, 'g');
  // Where the last dotted word read ends: an identifier before it is one of its later parts.
  let dottedEnd = 0;
  // Where the last field's own value ends.
  let ownEnd = 0;
  for (let m = ids.exec(masked); m; m = ids.exec(masked)) {
    const flag = masked[m.index - 1] === '-';
    let rest = '';
    if (flag || m.index >= dottedEnd) {
      DOTTED_NAME_RE.lastIndex = m.index + m[0].length;
      rest = DOTTED_NAME_RE.exec(masked)?.[0] ?? '';
    }
    const whole = m[0] + rest;
    const wholeEnd = m.index + whole.length;
    if (wholeEnd > dottedEnd) dottedEnd = wholeEnd;
    let name = m[0];
    let end = m.index + m[0].length;
    if (flag) {
      const dotted = whole.replace(/\./g, '_');
      const property = masked[m.index - 2] !== '-' && /^[DP][A-Za-z0-9_]/.test(whole) && masked[wholeEnd] === '=';
      if (keyIsSecret(dotted)) [name, end] = [dotted, wholeEnd];
      else if (property && keyIsSecret(dotted.slice(1))) [name, end] = [dotted.slice(1), wholeEnd];
      else continue;
    } else if (rest && secretAcrossDot(whole)) [name, end] = [whole.replace(/\./g, '_'), wholeEnd];
    else if (!keyIsSecret(name)) continue;
    // The field's own value is the rules' to hide; only what follows a name in it is read here.
    // A name inside the value of the field before it isn't read as a field again (that would
    // read a long value once per name in it); only a key split from its "=" is read there.
    let v = m.index < ownEnd ? null : valueOf(name, end, flag);
    const own = v;
    if (own) ownEnd = Math.max(ownEnd, own.end);
    if (!v) {
      // No value on the key's own line: the KEY=VALUE rule's reading, across the line break.
      const kvKey = m[0].slice(m[0].lastIndexOf('-') + 1);
      if (!/^[A-Za-z_]/.test(kvKey) || !SENSITIVE_KV_KEY.test(kvKey)) continue;
      KV_REST_RE.lastIndex = m.index + m[0].length;
      const kv = KV_REST_RE.exec(masked);
      if (!kv) continue;
      const after = KV_REST_RE.lastIndex;
      let from = after - kv[1].length;
      let to = after;
      // The rest of an == or === comparison: its operand.
      while (from < to && masked[from] === '=') from += 1;
      if (to - from >= 2 && '"\''.includes(masked[from]) && masked[to - 1] === masked[from]) [from, to] = [from + 1, to - 1];
      if (to <= from) continue;
      keep(from, to);
      v = { start: from, end: to, after };
    }
    let hidden = 0;
    for (let inner = innerName(v); ; inner = innerName(v)) {
      // A value hidden here is skipped past; the field's own is read on through.
      if (v !== own) ids.lastIndex = Math.max(v.after, v.end, ids.lastIndex);
      if (!inner) break;
      const next = valueOf(inner.name, inner.end, false);
      if (!next) break;
      v = next;
      const text = s.slice(v.start, v.end);
      if (notASecret(inner.name, text) || markupOnly(text)) continue;
      keep(v.start, v.end);
      hidden += 1;
    }
    // A password line or a header hides to the end of its line, or to the next `name:` on it.
    // With that name's value now hidden, the rest of the line is the field's own, as a second
    // pass would read it.
    if (own?.line && hidden && !/["'\\]/.test(masked[v.end] ?? '"')) {
      const more = readValue(masked, v.end, 'line', lineEnd);
      if (more) {
        keep(more.start, more.end);
        ids.lastIndex = Math.max(more.after, more.end, ids.lastIndex);
      }
    }
  }
  return spans;
}

/** Where each run of text between the placeholders of `redacted` sits in `original`, the text
 *  it was made from: { at, length } in `redacted`, and the earliest and latest place it can
 *  start in `original` (`lo`, `hi`), found from the front and from the back. A scrubber's
 *  finished text is its input with spans swapped for placeholders, so the runs appear in the
 *  input in order, the first at its start and the last at its end. A run whose `lo` and `hi`
 *  agree sits exactly there. The KEY=VALUE rule writes its own "=" before its placeholder
 *  whatever spacing the input had, so a run's "=" right before a placeholder isn't matched
 *  (`equals` marks a run that has one).
 *  Null when the runs don't fit `original` that way. */
export function alignRedacted(original, redacted) {
  const chunks = [];
  let at = 0;
  for (const m of redacted.matchAll(ANY_PLACEHOLDER_RE)) {
    const equals = m.index > at && redacted[m.index - 1] === '=';
    chunks.push({ at, length: m.index - at - (equals ? 1 : 0), equals, lo: 0, hi: 0 });
    at = m.index + m[0].length;
  }
  chunks.push({ at, length: redacted.length - at, equals: false, lo: 0, hi: 0 });
  const text = (c) => redacted.slice(c.at, c.at + c.length);
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (!original.startsWith(text(first))) return null;
  if (chunks.length === 1) return original.length === first.length ? chunks : null;
  last.lo = original.length - last.length;
  last.hi = last.lo;
  if (last.lo < first.length || !original.endsWith(text(last))) return null;
  let pos = first.length;
  for (let i = 1; i < chunks.length - 1; i += 1) {
    const c = chunks[i];
    c.lo = original.indexOf(text(c), pos);
    if (c.lo < 0 || c.lo + c.length > last.lo) return null;
    pos = c.lo + c.length;
  }
  let limit = last.lo;
  for (let i = chunks.length - 2; i > 0; i -= 1) {
    const c = chunks[i];
    c.hi = original.lastIndexOf(text(c), limit - c.length);
    limit = c.hi;
  }
  return chunks;
}

/** `redacted`, a scrubber's finished text for `original`, with what sourceFieldSpans finds in
 *  `original` hidden too. Only characters `redacted` still shows are replaced, each run by
 *  `placeholder`; no placeholder in it is touched. A run of text that could sit in more than one
 *  place in `original` is hidden whole when a span reaches any of those places, and so is every
 *  run when the two texts don't line up, so a value found is never left for want of its place.
 *  `counted()` is called once per run hidden. */
export function hideSourceFields(original, redacted, placeholder, counted = () => {}) {
  const spans = sourceFieldSpans(original);
  if (!spans.length) return redacted;
  const chunks = alignRedacted(original, redacted);
  const cuts = [];
  if (!chunks) {
    let at = 0;
    for (const m of redacted.matchAll(ANY_PLACEHOLDER_RE)) {
      cuts.push([at, m.index]);
      at = m.index + m[0].length;
    }
    cuts.push([at, redacted.length]);
  } else {
    let k = 0;
    for (const [a, b] of spans) {
      while (k < chunks.length && chunks[k].hi + chunks[k].length <= a) k += 1;
      for (let j = k; j < chunks.length && chunks[j].lo < b; j += 1) {
        const c = chunks[j];
        if (c.lo === c.hi) {
          const from = Math.max(a, c.lo);
          const to = Math.min(b, c.lo + c.length);
          if (to <= from) continue;
          // The run's own "=" goes too when the span runs on over the "=" in `original`.
          let q = to;
          if (c.equals && to === c.lo + c.length) while (q < b && /\s/.test(original[q])) q += 1;
          const equals = c.equals && to === c.lo + c.length && q < b && original[q] === '=';
          cuts.push([c.at + from - c.lo, c.at + to - c.lo + (equals ? 1 : 0)]);
        } else if (c.length && a < c.hi + c.length) cuts.push([c.at, c.at + c.length]);
      }
    }
  }
  let out = '';
  let at = 0;
  for (const cut of cuts) {
    let start = Math.max(cut[0], at);
    let end = cut[1];
    while (start < end && /\s/.test(redacted[start])) start += 1;
    while (end > start && /\s/.test(redacted[end - 1])) end -= 1;
    if (end <= start) continue;
    counted();
    out += redacted.slice(at, start) + placeholder;
    at = end;
  }
  return out + redacted.slice(at);
}

// --- last, over the finished text ------------------------------------------------------
//
// Two things the rules above leave, read once a scrubber is otherwise done, so they can only
// ever hide more: no character outside the spans they hide changes, and no placeholder moves.
//  - A header (Authorization, Cookie) whose value is only placeholders and stops at a quote
//    with text glued after it (`Authorization=[redacted:secret]'xk9…`, issue 80): the rest of
//    the line, from the quote, is the header's too.
//  - A `/root/…` home path (ROOT_PATH_SOURCE, issue 85), each part between placeholders.

const ROOT_PATH_RE = new RegExp(ROOT_PATH_SOURCE, 'g');
const onlyMasks = (text) => text.includes(LATER_MASK) && text.replace(/\s/g, '').split(LATER_MASK).join('') === '';

/** The spans of `s` hidden last, as [start, end, kind) triples in UTF-16 units, in order and
 *  apart: kind is 'secret' for a header's glued text and 'path' for a `/root/…` path, left out
 *  when `paths` is false. `s` is a scrubber's finished text; spans hold no placeholder. */
export function finishedSpans(s, { paths = true } = {}) {
  if (!s.includes('/root/') && !SECRET_NAME_HINT_RE.test(s)) return [];
  const marks = [];
  const masked = s.replace(ANY_PLACEHOLDER_RE, (m, at) => {
    marks.push([at, at + m.length]);
    return LATER_MASK.repeat(m.length);
  });
  // The parts of [start, end) between placeholders, trimmed of spaces, as spans of `kind`.
  const pieces = (start, end, kind, out) => {
    let k = 0;
    while (k < marks.length && marks[k][1] <= start) k += 1;
    for (let from = start; from < end; k += 1) {
      const to = k < marks.length && marks[k][0] < end ? marks[k][0] : end;
      let a = from;
      let b = to;
      while (a < b && /\s/.test(s[a])) a += 1;
      while (b > a && /\s/.test(s[b - 1])) b -= 1;
      if (b > a) out.push([a, b, kind]);
      if (to === end) break;
      from = Math.min(end, marks[k][1]);
    }
  };
  const headers = [];
  let nlAt = -1;
  const lineEnd = (p) => {
    if (nlAt < p) {
      nlAt = masked.indexOf('\n', p);
      if (nlAt < 0) nlAt = masked.length;
    }
    return nlAt;
  };
  const ids = new RegExp(IDENTIFIER_RE.source, 'g');
  for (let m = ids.exec(masked); m; m = ids.exec(masked)) {
    if (!WHOLE_LINE_KEY_RE.test(normalKey(m[0])) || !keyIsSecret(m[0])) continue;
    FIELD_SEP_RE.lastIndex = m.index + m[0].length;
    if (!FIELD_SEP_RE.exec(masked)) continue;
    const v = readValue(masked, FIELD_SEP_RE.lastIndex, 'line', lineEnd);
    if (!v || !onlyMasks(masked.slice(v.start, v.end))) continue;
    // What it hides can end at another quote with text glued after it: that's the header's too.
    let end = v.end;
    for (let more; `"'`.includes(masked[end] ?? '') && /\w/.test(masked[end + 1] ?? '') && (more = readValue(masked, end + 1, 'line', lineEnd)); end = more.end) {
      pieces(end, more.end, 'secret', headers);
      ids.lastIndex = Math.max(more.after, more.end);
    }
  }
  const rootPaths = [];
  if (paths) {
    for (const r of masked.matchAll(ROOT_PATH_RE)) pieces(r.index, pathMatchEnd(masked, r.index, r.index + r[0].length), 'path', rootPaths);
  }
  // Spans that overlap become one, a path only when both were.
  const out = [];
  for (const span of [...headers, ...rootPaths].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && span[0] < last[1]) {
      last[1] = Math.max(last[1], span[1]);
      if (span[2] !== 'path') last[2] = 'secret';
    } else out.push([...span]);
  }
  return out;
}

/** `s` with its finishedSpans replaced: a header's glued text by `placeholder`, a path by
 *  `pathPlaceholder`, or left shown when that's null. `counted()` is called once per span. */
export function hideFinishedSpans(s, placeholder, counted = () => {}, pathPlaceholder = '[redacted:path]') {
  if (typeof s !== 'string' || s.length === 0) return s;
  const spans = finishedSpans(s, { paths: pathPlaceholder != null });
  if (!spans.length) return s;
  let out = '';
  let at = 0;
  for (const [start, end, kind] of spans) {
    counted();
    out += s.slice(at, start) + (kind === 'path' ? pathPlaceholder : placeholder);
    at = end;
  }
  return out + s.slice(at);
}
