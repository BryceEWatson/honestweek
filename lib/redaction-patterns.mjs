// Shared pattern authority for the canonical scrubber, the secrets-only scrubber, and the
// replayable prompt audit.
export const REDACTION_SOURCES=Object.freeze({
  uuid:String.raw`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`,
  // Searched with emailSpans() below, which finds what a global search finds in linear time.
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

// A sensitive key, tested after camelCase, "-" and "." become "_" (dbPassword, x-api-key,
// api.key, _authToken, authtoken, PGPASSWORD, MYSQL_PWD, ENCRYPTION_KEY, clientsecret,
// secretkey, X-Amz-Signature, ?sig=).
// A key merely ending in "Key" isn't one: the engine's own fileKey and sessionKey hold ids.
const SECRET_KEY_RE = /(?:(?<![A-Za-z])(?:API_?KEYS?|ACCESS_?KEY|PRIVATE_?KEY|PASSPHRASE|PASS|AUTHORIZATION|AUTH|COOKIE|CREDENTIALS?|SIGNATURE|SIG)|PASSWORD|PASSWD|TOKEN|SECRET(?:_?KEY)?|(?<=_)PWD|(?:ENCRYPTION|SIGNING|MASTER|CLIENT|LICENSE|SERVICE|DEPLOY|SESSION_SECRET|SSH|GPG|PGP|HMAC|JWT|AES|APP)_?KEY)(?![A-Za-z])/i;
export const normalKey = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_');
export const keyIsSecret = (key) => SECRET_KEY_RE.test(normalKey(key));
const SECRET_KEY_ALL_RE = new RegExp(SECRET_KEY_RE.source, 'gi');
/** True when a dotted word that isn't an option is read whole as a key (`api.key`,
 *  `secret.key`, `aws.secret.access.key`): a secret's name runs across its last dot, so its
 *  last part alone doesn't name one. `password.length` and `auth.ts` are a property and a file
 *  name: they keep the reading they had, each part on its own, and a last part that names a
 *  secret by itself (`db.password`) is still read by itself. Only the last two parts are read:
 *  a three-word name across the dots (`session.secret.key`) ends in a two-word one (`secret.key`). */
function secretAcrossDot(name) {
  const cut = name.lastIndexOf('.');
  const last = name.slice(cut + 1);
  if (keyIsSecret(last)) return false;
  const head = normalKey(name.slice(name.lastIndexOf('.', cut - 1) + 1, cut));
  const joined = `${head}_${normalKey(last)}`;
  SECRET_KEY_ALL_RE.lastIndex = 0;
  for (let m = SECRET_KEY_ALL_RE.exec(joined); m; m = SECRET_KEY_ALL_RE.exec(joined)) {
    if (m.index + m[0].length > head.length + 1) return true;
  }
  return false;
}
// The last part of a dotted record key that makes it a file of code or the length of a value.
const CODE_PART_RE = /^(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|scala|cs|php|swift|c|cc|cpp|h|hpp|lua|dart|vue|svelte|length|size|count)$/i;
/** Whether a record's own key names a secret, for deepRedact and the view's leak count:
 *  keyIsSecret, except that a dotted key ending in a code file's extension or a length
 *  (`auth.ts`, `token.js`, `password.length`) is read the way text reads a dotted word, so it
 *  names a secret only when a secret's name runs across its last dot. A data file named for a
 *  secret (`password.txt`, `token.json`) and a value of one (`token.value`) still name one: what
 *  they hold may be the secret itself. */
export function recordKeyIsSecret(key) {
  const cut = key.lastIndexOf('.');
  return cut >= 0 && CODE_PART_RE.test(key.slice(cut + 1)) ? secretAcrossDot(key) : keyIsSecret(key);
}
// Keys whose value may hold spaces, so a "key: value" runs to the end of the line.
const PASSWORD_KEY_RE = /(?:PASSWORD|PASSWD|PASSPHRASE|(?<=_)PASS|(?<=_)PWD)(?![A-Za-z])/i;
const TYPE_AHEAD_RE = /^(?:string|str|String|number|boolean|bytes|SecretStr|SecureString|Option<|Optional\[|any)\b/;
// A value read after ":" that is a type and nothing else (`string`, `str[]`, `Option<String>`).
const TYPE_ONLY_RE = /^(?:(?:string|str|String|number|boolean|bytes|SecretStr|SecureString|any)(?:\[\])*|Option<[\w<>]*>|Optional\[[\w[\]]*\])$/;
const WHOLE_LINE_KEY_RE = /(?:^|_)(?:AUTHORIZATION|COOKIE)$/i;
// Each identifier is read once from its front; its value is read only when the key is
// sensitive, so an ordinary key never swallows the next one and matching stays linear.
const IDENTIFIER_RE = /(?<![A-Za-z0-9_])[A-Za-z0-9_][A-Za-z0-9_-]*/g;
// The rest of a dotted name after its first part (`.token` in `--docs.token`, `.key` in
// `api.key`). Each part starts with a letter, digit or "_", so a sentence's closing dot isn't one.
const DOTTED_NAME_RE = /(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)+/y;
const NAME_START_RE = /[A-Za-z0-9_][A-Za-z0-9_-]*/y;

/** The field or option name that starts with identifier `id` at `at` in `s`: `name` to read,
 *  where it ends, `wholeEnd` (where its dotted word ends), and whether it names a secret.
 *  - An option's name (after "-") may hold dots (`--docs.token`, `-Docs.Token`): it's read whole,
 *    each dot standing for "_", as `--docs-token` is.
 *  - A Java system property or a Gradle project property (`-Dapi.key=…`, `-Psigning.password=…`:
 *    one "-", then D or P, the name, and "=") is read by its own name, the part after the D or P.
 *  - Any other dotted word is read whole only when a secret's name runs across its last dot
 *    (secretAcrossDot); otherwise its first part is read alone, as before, and its later parts
 *    are read on their own.
 *  `dotted` marks a property or a name read across its dots: a name that used to be read part
 *  by part, when the words inside its value were read as fields of their own.
 *  `scan` false reads `id` alone: it sits inside a dotted word already read, so matching stays
 *  linear on a long run of dotted parts. */
function fieldName(s, at, id, scan) {
  const end = at + id.length;
  let rest = '';
  if (scan) {
    DOTTED_NAME_RE.lastIndex = end;
    rest = DOTTED_NAME_RE.exec(s)?.[0] ?? '';
  }
  const whole = id + rest;
  const wholeEnd = end + rest.length;
  if (s[at - 1] === '-') {
    if (keyIsSecret(whole)) return { name: whole, end: wholeEnd, wholeEnd, secret: true };
    const property = s[at - 2] !== '-' && /^[DP][A-Za-z0-9_]/.test(whole) && s[wholeEnd] === '=';
    return { name: property ? whole.slice(1) : whole, end: wholeEnd, wholeEnd, secret: property && keyIsSecret(whole.slice(1)), dotted: true };
  }
  if (rest && secretAcrossDot(whole)) return { name: whole, end: wholeEnd, wholeEnd, secret: true, dotted: true };
  return { name: id, end, wholeEnd, secret: keyIsSecret(id) };
}
const HSPACE = String.raw`[^\S\r\n]*`;
// After the key: its closing quote (escaped or not), a Go type (`var password string =`),
// an optional `?` (`password?: string`), the separator, and a type name between ":" and
// "=" when there is one (`password: string = "…"`).
const TYPE_NAME = String.raw`(?:string|str|String|bytes|\[\]byte|SecretStr|SecureString|any|&str|char\s?\*)`;
const FIELD_SEP_RE = new RegExp(String.raw`\\*["']?(?:[^\S\r\n]+${TYPE_NAME}(?=${HSPACE}=))?${HSPACE}\??(===|:=|\?=|==|=|:)${HSPACE}(?:${TYPE_NAME}${HSPACE}=${HSPACE})?`, 'y');
// The next `key: ` on a joined line: a colon followed by a space or a quote, so a credential
// like `AWS id:signature`, a web address or a time doesn't count.
const NEXT_KEY_RE = /[A-Za-z_][A-Za-z0-9_-]*["']?[ \t]*:(?=[ \t"'])/y;
// A quoted value whose would-be closing quote opens a sensitive key's own value instead
// (`token: "Ab3d, api_key: "Xk9…"`) was left unclosed: it ends before that key.
const KEY_BEFORE_QUOTE_RE = /([A-Za-z_][A-Za-z0-9_-]*)\\*["']?[ \t]*(?::=|\?=|===|==|=|:)[ \t]*\\*$/;
const WORD_CHAR_RE = /[A-Za-z0-9_]/;
/** When the would-be closing quote at `q` opens a sensitive key's own value instead, where
 *  that key starts, which is where the unclosed value before it ends; else -1. `from` is where
 *  the quoted value's text starts. */
function keyBeforeQuote(s, from, q) {
  const base = Math.max(from, q - 96);
  const km = KEY_BEFORE_QUOTE_RE.exec(s.slice(base, q));
  return km && keyIsSecret(km[1]) && !/[A-Za-z0-9_-]/.test(s[base + km.index - 1] ?? '') ? base + km.index : -1;
}
// After a --flag or -Parameter: spaces, then a value that isn't another flag.
const FLAG_SEP_RE = new RegExp(String.raw`[^\S\r\n]+(?=[^\s-])`, 'y');
/** Where the value of the field or option `field` (from fieldName, its name starting at `at`
 *  in `s`) starts on its line (`p`), and the separator read before it (`sep`, empty for an
 *  option's spaces); null when no separator follows the name. */
function valueStart(s, at, field) {
  FIELD_SEP_RE.lastIndex = field.end;
  const sep = FIELD_SEP_RE.exec(s);
  if (sep) return { p: FIELD_SEP_RE.lastIndex, sep: sep[1] };
  if (s[at - 1] !== '-') return null;
  FLAG_SEP_RE.lastIndex = field.end;
  return FLAG_SEP_RE.exec(s) ? { p: FLAG_SEP_RE.lastIndex, sep: '' } : null;
}
/** The value of the sensitive field or option `field`, read from `from` (valueStart), or null. */
function fieldValue(s, field, from, lineEnd) {
  if (from.sep === '') return readValue(s, from.p, 'word', lineEnd, false);
  const key = normalKey(field.name);
  // A password line runs to its end unless what follows is a type (`password: string)`).
  // A type annotation has no value (`login(password: string, remember: boolean)`); one with
  // a value after it (`password: string = "…"`) was read past by the separator. Hidden as a
  // value, it made a second pass read the field another way (a placeholder isn't a type).
  // Anything glued to the type word is read as a value, the way it would be without it. A
  // header (Authorization, Cookie) always runs to the end of its line.
  if (from.sep === ':' && TYPE_AHEAD_RE.test(s.slice(from.p, from.p + 24)) && !WHOLE_LINE_KEY_RE.test(key)) {
    const t = readValue(s, from.p, 'tight', lineEnd, true);
    if (t && TYPE_ONLY_RE.test(s.slice(t.start, t.end))) return null;
  }
  return readValue(s, from.p, WHOLE_LINE_KEY_RE.test(key) || (from.sep === ':' && PASSWORD_KEY_RE.test(key)) ? 'line' : from.sep === ':' ? 'tight' : 'word', lineEnd, from.sep === ':');
}
const SCHEME_RE = /(?:bearer|basic|token|digest)[^\S\r\n]+/iy;
/** Bearer and Basic credentials: groups are the scheme, the gap, then the credential. The
 *  scheme and one credential character are exported for a scrubber that reads the
 *  credential across its own placeholders. */
export const BEARER_SCHEME = 'bearer|basic';
export const BEARER_CHAR = '[A-Za-z0-9._~+/=-]';
export const BEARER_RE = new RegExp(String.raw`\b(${BEARER_SCHEME})([ \t]+)${BEARER_CHAR}{8,}`, 'gi');
const BEARER_AT_RE = new RegExp(String.raw`(?:${BEARER_SCHEME})[ \t]+${BEARER_CHAR}{8,}`, 'iy');
/** Where the credential ends when a value from `from` to `end` in `s` ends on a Bearer or Basic
 *  scheme word (`x:basic` before ` dXNlcjpw…`), or -1: the credential goes with the value, as
 *  the credential rule would have read it had the value not taken its scheme. */
function credentialAfter(s, from, end) {
  const m = /(?:bearer|basic)$/i.exec(s.slice(Math.max(from, end - 6), end));
  if (!m) return -1;
  const at = end - m[0].length;
  if (WORD_CHAR_RE.test(s[at - 1] ?? '')) return -1;
  BEARER_AT_RE.lastIndex = at;
  return BEARER_AT_RE.test(s) ? BEARER_AT_RE.lastIndex : -1;
}
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
/** A PowerShell SecureString literal: groups are the command, the quote, then the value. */
export const SECURE_STRING_RE = /(ConvertTo-SecureString[ \t]+(?:-String[ \t]+)?)(["'])([^"'\n]*)\2/gi;

/** Where a value starting at `p` ends, and the part of it to hide. A double-quoted string
 *  opened by a quote escaped with `n` backslashes (n = 0 in plain JSON, 1 in JSON inside a
 *  JSON string, 3 a level deeper) closes at the next quote whose backslash count is n, or n
 *  plus a multiple of 2(n + 1): an escaped backslash right before the closing quote doesn't
 *  hide it, and an escaped quote inside the value doesn't end it. A double-quoted value cut off
 *  before its close runs to the end of the line; a single-quoted one is read from after its
 *  quote as an unquoted value (after "=", with its quote). `mode` sets where an unquoted value ends:
 *  'line' at the end of the line (a password line, a header), 'word' at the next space
 *  (after "="), 'tight' also at , ; and at ) } ] that close the value (after ":", where JSON
 *  and code go on). `lineEnd(p)` gives the end of the line holding p.
 *  Returns the part to hide (`start` to `end`), where the value begins with its opening quote
 *  (`open`) and ends with its closing one (`after`), whether both quotes are there (`closed`),
 *  where what ended it ends (`edge`: its closing quote, the quote that opens the next key's
 *  value, the quote an unquoted value stopped at, or the first letter of the next key a line
 *  stopped before; `end` when it ran to a space or the line's end; `edgeAt` gives it after a grow),
 *  and `grow(x)`: where the value ends when it is read on from `x` the way an unquoted one is.
 *  A quoted word is always a value, whatever follows its closing quote. */
function readValue(s, p, mode, lineEnd, colon) {
  // A quote with a letter, digit or "_" on both sides is part of the value (`xk9'mp2qrz`), not
  // the end of the text around it.
  const quoteEnds = (i) => !(/\w/.test(s[i - 1] ?? '') && /\w/.test(s[i + 1] ?? ''));
  const closes = (i) => mode === 'tight' && ')}]'.includes(s[i]) && (i + 1 >= s.length || /[\s"',;:)}\].?!]/.test(s[i + 1]));
  const stops = mode === 'tight' ? (i) => /[\s,;]/.test(s[i]) || ('"\''.includes(s[i]) && quoteEnds(i)) : (i) => /\s/.test(s[i]);
  let from = p;
  // Where what ended a 'line' value starts (the next `key:`, or a quote), or -1.
  let keyAt = -1;
  // Where the value, read on from `x`, ends.
  const readFrom = (x) => {
    let e = x;
    keyAt = -1;
    if (mode === 'line') {
      // The line ends at a newline, a quote, or the next `key:`, since the engine joins an
      // excerpt's lines into one and a later key must be read on its own.
      const nl = lineEnd(x);
      while (e < nl && s[e] !== '\r' && !('"\''.includes(s[e]) && quoteEnds(e))) {
        if (e > from && /\s/.test(s[e - 1]) && /[A-Za-z_]/.test(s[e])) {
          NEXT_KEY_RE.lastIndex = e;
          if (NEXT_KEY_RE.test(s)) {
            keyAt = e;
            break;
          }
        }
        e += 1;
      }
      // A quote it stopped at counts the same way, with the spaces before it trimmed off.
      if (keyAt < 0 && e < nl && '"\''.includes(s[e])) keyAt = e;
      while (e > x && /\s/.test(s[e - 1])) e -= 1;
    } else {
      while (e < s.length && !stops(e) && !closes(e)) e += 1;
    }
    return e;
  };
  // A value that ends on a Bearer or Basic scheme word takes the credential after it
  // (credentialAfter), then reads on from there. Each step only moves forward.
  const grow = (x) => {
    let end = readFrom(x);
    for (let c = credentialAfter(s, from, end); c > end; c = credentialAfter(s, from, end)) end = Math.max(c, readFrom(c));
    return end;
  };
  // Past what ended a value read on to `end`: the quote it stopped at or the first letter of
  // the next key, or `end` when it ran to a space or the line's end.
  const edgeAt = (end) => (keyAt >= end ? keyAt + 1 : '"\''.includes(s[end] ?? ' ') ? end + 1 : end);
  const open = /\\*"/y;
  open.lastIndex = p;
  const o = open.exec(s);
  if (o) {
    const nl = lineEnd(p);
    const n = o[0].length - 1;
    const step = ((n + 1) & n) === 0 ? 2 * (n + 1) : 0;
    const start = p + o[0].length;
    for (let i = start; i < nl; ) {
      const q = s.indexOf('"', i);
      if (q < 0 || q > nl) break;
      let k = 0;
      while (k < q - i && s[q - 1 - k] === '\\') k += 1;
      if (k === n || (step && k > n && (k - n) % step === 0)) {
        let end = keyBeforeQuote(s, start, q);
        if (end >= 0) {
          while (end > start && /\s/.test(s[end - 1])) end -= 1;
          if (end > start) return { open: p, start, end, after: end, edge: q + 1, closed: false, grow, edgeAt };
          // Nothing before the key: this quote opens that key's value, so read on to the next close.
          i = q + 1;
          continue;
        }
        return { open: p, start, end: q - n, after: q + 1, edge: q + 1, closed: true, grow, edgeAt };
      }
      i = q + 1;
    }
    let end = nl;
    while (end > p && /\s/.test(s[end - 1])) end -= 1;
    return end > start ? { open: p, start, end, after: end, edge: end, closed: false, grow, edgeAt } : null;
  }
  if (s[p] === "'") {
    const nl1 = lineEnd(p);
    const first = s.indexOf("'", p + 1);
    for (let q = first; q > p && q < nl1; q = s.indexOf("'", q + 1)) {
      let end = keyBeforeQuote(s, p + 1, q);
      if (end >= 0) {
        while (end > p + 1 && /\s/.test(s[end - 1])) end -= 1;
        if (end > p + 1) return { open: p, start: p + 1, end, after: end, edge: q + 1, closed: false, grow, edgeAt };
        continue;
      }
      return { open: p, start: p + 1, end: q, after: q + 1, edge: q + 1, closed: true, grow, edgeAt };
    }
    if (first > p && first < nl1) return { open: p, start: p + 1, end: first, after: first + 1, edge: first + 1, closed: true, grow, edgeAt };
    // A single-quoted value whose closing quote is missing from its line is read on from after
    // the quote, the way it would be read without the quote, when it follows ":" (`colon`). After
    // "=" it is read as before (the quote goes with the value to the next space, and a header's
    // line opens no value), and the KEY=VALUE rule reads it whole. A quote followed by a space, the end, or
    // , ; ) ] } . + closes the text the key sits in (`'Password:',`), and opens no value.
    if (colon && /[^\s,;)\]}.+]/.test(s[p + 1] ?? ' ')) from = p + 1;
  }
  let start = from;
  if (mode !== 'line') {
    SCHEME_RE.lastIndex = from;
    if (SCHEME_RE.exec(s)) start = SCHEME_RE.lastIndex;
  }
  const end = grow(start);
  return end > from ? { open: p, start: from, end, after: end, edge: edgeAt(end), closed: false, grow, edgeAt } : null;
}

/** A sensitive key's value that isn't a secret: a flag value (`requiresAuth: true`) or a
 *  test count (`pass: 793`). */
export const notASecret = (key, value) => /^(?:true|false|null|undefined|none|nil)$/i.test(value) || (/^pass$/i.test(key) && /^\d+$/.test(value));

/** `lineEnd(p)` for `s`: the end of the line holding p, and with `text`, where that line's
 *  text ends (only spaces are left from there to its end). Asked with rising p, each line is
 *  found and trimmed once. */
function lineEnds(s) {
  let nlAt = -1;
  let textAt = -1;
  return (p, text = false) => {
    if (nlAt < p) {
      nlAt = s.indexOf('\n', p);
      if (nlAt < 0) nlAt = s.length;
      textAt = -1;
    }
    if (text && textAt < 0) {
      textAt = nlAt;
      while (textAt > p && /\s/.test(s[textAt - 1])) textAt -= 1;
    }
    return text ? textAt : nlAt;
  };
}

// The KEY=VALUE rule's key, where a name ends on one (after the last "-"), and what it reads
// after the key: "=" with any space around it, line breaks too (and the rest of an == or ===
// comparison, whose operand is the value), then a quoted or unspaced value.
const ASSIGN_KEY_RE = /(?:^|-)([A-Za-z_][A-Za-z0-9_]*)$/;
const ASSIGN_SEP_RE = /\s*=\s*=*/y;
const ASSIGN_QUOTED_RE = /"[^"]*"|'[^']*'/y;
const SENSITIVE_KV_KEY = new RegExp(REDACTION_SOURCES.sensitiveKey, 'i');
// How many values secretFields reads for names inside one hidden value before it hides the
// rest of that line instead: each read may run to the line's end, so a cap keeps the whole linear.
const NESTED_READS = 32;

/** Hide the value of every sensitive field and flag in `s`. `hide(text, start, end)` gets
 *  one value and where it sits in `s` (UTF-16 indexes, `end` exclusive), and returns its
 *  replacement, or null to leave it.
 *
 *  The rule, shared with the KEY=VALUE rule the scrubbers run around this one: every name is
 *  read, wherever it sits, also inside a value that is being hidden, and each sensitive name
 *  hides its own value. So hiding one value never stops another name from being read, and
 *  nothing is left shown because it looks like a key: a quoted word after a key is hidden as
 *  that key's value, and when a separator follows it, it is read as a key as well, and what it
 *  names is hidden too (`api_key: "token": "…"` hides both quoted parts).
 *  - A name's value is what follows its separator on its line (readValue), or an option's
 *    spaces. A name the KEY=VALUE rule reads also hides what follows its "=" across a line
 *    break, and, when the name itself sits in a hidden value, on its own line too: that rule
 *    runs on the text as it reads afterwards, and would no longer see the name.
 *  - Values that don't touch are hidden one by one, and the text between them stays. A value
 *    that starts inside a closed quoted value ends with it. One that overlaps the value being
 *    hidden, or takes the quote that ended it (its closing quote, or the one it stopped at), is
 *    hidden with it as one, quotes and all, and that value is read on from there the way it
 *    was being read: a second pass no longer has that quote to stop at, and reading the
 *    placeholder, reads the same span.
 *  - After NESTED_READS values read for names inside one hidden value, the rest of that line
 *    is hidden with it. */
export function secretFields(s, hide) {
  let out = '';
  let at = 0;
  const ids = new RegExp(IDENTIFIER_RE.source, 'g');
  const lineEnd = lineEnds(s);
  // The value being hidden (readValue's result, and how many values were read inside it). It is
  // handed to `hide` once the next value starts clear of it, when its end is settled.
  let run = null;
  // Past what ended the value before it, which that one keeps: the quote isn't hidden with this one.
  let floor = 0;
  const settle = () => {
    if (run === null) return;
    floor = run.edge;
    const hidden = hide(s.slice(run.start, run.end), run.start, run.end);
    if (hidden === null) return;
    out += s.slice(at, run.start) + hidden;
    at = run.end;
  };
  // The value being hidden runs on to `end` at least: from its opening quote, as one.
  const join = (end) => {
    run.start = Math.max(floor, run.open);
    run.closed = false;
    run.end = run.grow(Math.max(run.after, end));
    run.after = run.end;
    run.edge = run.edgeAt(run.end);
  };
  const add = (v, name = null, dotted = false) => {
    if (!v || (name !== null && notASecret(name, s.slice(v.start, v.end)))) return;
    if (run && (v.open < run.end || v.start < run.edge)) {
      // A value that starts inside closed quotes ends with them. Under a dotted key, whose
      // value used to be read as text of its own, it is hidden to its own end as before.
      const within = run.closed && v.open < run.end;
      if (within ? run.dotted && v.end > run.after : v.after > run.end) join(v.after);
      return;
    }
    settle();
    run = { ...v, reads: 0, dotted };
  };
  // Whether a value starting at `p`, for a name inside the value being hidden, is left unread:
  // it would end inside that value, or the cap is reached.
  const unread = (p) => {
    if (run.closed && !run.dotted ? p < run.end : run.end >= lineEnd(p, true)) return true;
    if (run.reads < NESTED_READS) {
      run.reads += 1;
      return false;
    }
    join(lineEnd(p, true));
    return true;
  };
  // The next space at or after `x`. The last stretch scanned is kept, so many names in one
  // unspaced stretch scan it once.
  let spaceFrom = 0;
  let spaceAt = -1;
  const toSpace = (x) => {
    if (x >= spaceFrom && x <= spaceAt) return spaceAt;
    spaceFrom = x;
    while (x < s.length && !/\s/.test(s[x])) x += 1;
    spaceAt = x;
    return x;
  };
  // Where the last dotted word read ends: an identifier before it is one of its later parts.
  let dottedEnd = 0;
  for (let m = ids.exec(s); m; m = ids.exec(s)) {
    // A name may hold dots, or be a Java or Gradle property (fieldName). A name that isn't
    // sensitive is left, and its later parts are read on their own as before.
    const field = fieldName(s, m.index, m[0], s[m.index - 1] === '-' || m.index >= dottedEnd);
    if (field.wholeEnd > dottedEnd) dottedEnd = field.wholeEnd;
    const inside = run !== null && m.index >= run.start && m.index < run.end;
    if (field.secret) {
      const from = valueStart(s, m.index, field);
      if (from && !(inside && unread(from.p))) add(fieldValue(s, field, from, lineEnd), field.name, field.dotted === true);
    }
    const key = ASSIGN_KEY_RE.exec(m[0]);
    if (!key || !SENSITIVE_KV_KEY.test(key[1])) continue;
    ASSIGN_SEP_RE.lastIndex = m.index + m[0].length;
    const sep = ASSIGN_SEP_RE.exec(s);
    if (!sep) continue;
    const open = ASSIGN_SEP_RE.lastIndex;
    let close = -1;
    if ('"\''.includes(s[open] ?? ' ')) {
      ASSIGN_QUOTED_RE.lastIndex = open;
      if (ASSIGN_QUOTED_RE.test(s)) close = ASSIGN_QUOTED_RE.lastIndex;
    }
    // The value goes with what is glued to it, to the next space, as that rule hides it when
    // it runs again (KV_AGAIN): a second pass reads the placeholder and that tail as one value.
    const end = toSpace(close < 0 ? open : close);
    // On the name's own line that rule still reads the name afterwards, unless the name sits in
    // a hidden value. It is read here too when its value would take what ended the value being
    // hidden (the quote it stopped at), so the two are hidden as one.
    if (end > open && (/[\r\n]/.test(sep[0]) || inside || (run !== null && open >= run.end && open < run.edge))) add({ open, start: open, end, after: end, edge: end, closed: false, grow: toSpace, edgeAt: (x) => x });
  }
  settle();
  return out + s.slice(at);
}

/** A value with the same quote at both ends: group 2 is what is between them. */
export const QUOTES_AROUND_RE = /^(["'])(.*)\1$/s;
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
  // A quoted placeholder after "=" on the next line is read with its quotes, as the KEY=VALUE rule reads it.
  out = secretFields(out, (value) => (held(value.replace(QUOTES_AROUND_RE, '$2')) || markupOnly(value) ? null : hide(value)));
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
  let result = '';
  let at = 0;
  for (let m = re.exec(out); m !== null; m = re.exec(out)) {
    const [whole, key, value, tail] = m;
    if (!SENSITIVE_KV_KEY.test(key)) continue;
    const operand = value.replace(/^=+/, '');
    if (operand === '' || settled(operand)) continue;
    result += out.slice(at, m.index) + whole.slice(0, whole.length - operand.length) + hide(operand + tail);
    at = m.index + whole.length + tail.length;
    re.lastIndex = at;
  }
  return result + out.slice(at);
}
const KV_AGAIN = new RegExp(REDACTION_SOURCES.keyValue + String.raw`(?=(\S*))`, 'g');

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
/** The lowercased words the scrubber looks for before it runs a term's patterns, or null for
 *  a term with any character outside plain ASCII, which always runs. It's safe because
 *  anyCase spells each plain English letter as a class of its two cases, so no other
 *  character can match one. */
export const skipWords=(t)=>/^[\x00-\x7f]*$/.test(t)?termWords(t).map((w)=>w.toLowerCase()):null;
/** termMatchers(terms, names = []): `names` are the person names among `terms`. */
export function termMatchers(terms,names=[]){const people=new Set(names.filter((t)=>typeof t==='string').map((t)=>t.trim().toLowerCase()));return terms.filter((t)=>typeof t==='string'&&t.trim()).sort((x,y)=>y.trim().length-x.trim().length).flatMap((t)=>{const words=termWords(t);const cs=[...t.trim()];const word=new RegExp(`${edge(cs[0],'start')}${words.map(anyCase).join('(?:\\s+|[-_.]?)')}${edge(cs.at(-1),'end')}`,'gu');if(t.includes('.')||(t.match(/\p{L}/gu)??[]).length<4)return [word];const glued=words.map(anyCase).join('[-_]?');const part=`(?<!${PART})(?=${PART}*?${START_EDGE}${glued})(?=(${PART}+))\\1`;const dotless=across(new RegExp(`${AFTER_SCHEME}${part}(?!\\.[\\p{L}\\p{N}])`,'gu'));if(people.has(t.trim().toLowerCase()))return [across(new RegExp(`(?:${AFTER_SCHEME}|(?<=@)|(?<=(?<![\\p{L}\\p{N}_-])www\\.))${part}(?=(?:\\.${PIECE}){0,8}${ENDING})`,'gu')),across(new RegExp(`${part}(?=(?:\\.${PIECE}){0,8}${WEB_ENDING})`,'gu')),dotless,word];return [across(new RegExp(`${part}(?=(?:\\.${PIECE}){0,8}${ENDING})`,'gu')),dotless,word];});}
