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
 *     letter.
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
// A later dotted piece: an ordinary one, or a placeholder the scrubber set aside.
const PIECE=`(?:${PART}{1,63}|\\uE000+\\d+\\uE000+)`;
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
export const keyIsSecret = (key) => SECRET_KEY_RE.test(normalKey(key));
// Keys whose value may hold spaces, so a "key: value" runs to the end of the line.
const PASSWORD_KEY_RE = /(?:PASSWORD|PASSWD|PASSPHRASE|(?<=_)PASS|(?<=_)PWD)(?![A-Za-z])/i;
const TYPE_AHEAD_RE = /^(?:string|str|String|number|boolean|bytes|SecretStr|SecureString|Option<|Optional\[|any)\b/;
const WHOLE_LINE_KEY_RE = /(?:^|_)(?:AUTHORIZATION|COOKIE)$/i;
// Each identifier is read once from its front; its value is read only when the key is
// sensitive, so an ordinary key never swallows the next one and matching stays linear.
const IDENTIFIER_RE = /(?<![A-Za-z0-9_])[A-Za-z0-9_][A-Za-z0-9_-]*/g;
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
/** A PowerShell SecureString literal: groups are the command, the quote, then the value. */
export const SECURE_STRING_RE = /(ConvertTo-SecureString[ \t]+(?:-String[ \t]+)?)(["'])([^"'\n]*)\2/gi;

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
  if (mode === 'line') {
    // The line ends at a newline, a quote, or the next `key:`, since the engine joins an
    // excerpt's lines into one and a later key must be read on its own.
    const nl = lineEnd(p);
    while (end < nl && !'\r"\''.includes(s[end])) {
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
    const stop = mode === 'tight' ? /[\s"',;]/ : /\s/;
    while (end < s.length && !stop.test(s[end]) && !closes(end)) end += 1;
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
    if (!keyIsSecret(m[0])) continue;
    const end = m.index + m[0].length;
    let v = null;
    FIELD_SEP_RE.lastIndex = end;
    const sep = FIELD_SEP_RE.exec(s);
    const key = normalKey(m[0]);
    // A password line runs to its end unless what follows is a type (`password: string)`).
    const typed = TYPE_AHEAD_RE.test(s.slice(FIELD_SEP_RE.lastIndex, FIELD_SEP_RE.lastIndex + 24));
    if (sep) v = readValue(s, FIELD_SEP_RE.lastIndex, WHOLE_LINE_KEY_RE.test(key) || (sep[1] === ':' && PASSWORD_KEY_RE.test(key) && !typed) ? 'line' : sep[1] === ':' ? 'tight' : 'word', lineEnd);
    else if (s[m.index - 1] === '-') {
      FLAG_SEP_RE.lastIndex = end;
      if (FLAG_SEP_RE.exec(s)) v = readValue(s, FLAG_SEP_RE.lastIndex, 'word', lineEnd);
    }
    if (!v) continue;
    const text = s.slice(v.start, v.end);
    if (notASecret(m[0], text)) continue;
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

/** The published scrubber's secret-field step, shared with the prompt audit: the password in
 *  a web address and after curl's -u, a SecureString literal, the value of every sensitive
 *  field and flag, and a Bearer or Basic credential that isn't a plain word. It reads `s`, a
 *  text in which the caller set parts aside as tokens (`delimiter`, a number, `delimiter`):
 *  `isPlaceholder(n)` says whether part n is a placeholder, so a value made only of those is
 *  left as it is, or content set aside (a commit id, which still counts as a value), and
 *  `partText(n)` gives part n's text. `hide(value)` returns the token to put in place of one
 *  value, which later rules here read as a placeholder. Returns the new text. */
export function hideSecretFields(s, { delimiter, isPlaceholder, partText, hide }) {
  const tokens = new RegExp(`${delimiter}(\\d+)${delimiter}`, 'g');
  const held = (v) => v.replace(tokens, (m, n) => (isPlaceholder(Number(n)) ? '' : m)).trim() === '';
  const restore = (v) => v.replace(tokens, (m, n) => partText(Number(n)) ?? m);
  let out = s.replace(URL_PASSWORD_RE, (m, head) => (held(m.slice(head.length)) ? m : head + hide(m.slice(head.length))));
  out = out.replace(USER_PASSWORD_RE, (m, flag, user, value) => (held(value) ? m : flag + user + hide(value)));
  out = out.replace(SECURE_STRING_RE, (m, head, q, value) => (value && !held(value) ? `${head}${q}${hide(value)}${q}` : m));
  out = secretFields(out, (value) => (held(value) || markupOnly(value) ? null : hide(value)));
  // A credential may run through content set aside (a hex run read as a commit id).
  const bearer = new RegExp(String.raw`\b(${BEARER_SCHEME})([ \t]+)((?:${BEARER_CHAR}|${delimiter}\d+${delimiter})+)`, 'gi');
  return out.replace(bearer, (m, scheme, gap, credential) => {
    const text = restore(credential);
    return held(credential) || text.length < 8 || plainWords(text) ? m : `${scheme}${gap}${hide(credential)}`;
  });
}

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

/** termMatchers(terms, names = []): `names` are the person names among `terms`. */
export function termMatchers(terms,names=[]){const people=new Set(names.filter((t)=>typeof t==='string').map((t)=>t.trim().toLowerCase()));return terms.filter((t)=>typeof t==='string'&&t.trim()).sort((x,y)=>y.trim().length-x.trim().length).flatMap((t)=>{const words=t.trim().split(/\s+/);const cs=[...t.trim()];const word=new RegExp(`${edge(cs[0],'start')}${words.map(anyCase).join('(?:\\s+|[-_.]?)')}${edge(cs.at(-1),'end')}`,'gu');if(t.includes('.')||(t.match(/\p{L}/gu)??[]).length<4)return [word];const glued=words.map(anyCase).join('[-_]?');const part=`(?<!${PART})(?=${PART}*?${START_EDGE}${glued})(?=(${PART}+))\\1`;const dotless=across(new RegExp(`${AFTER_SCHEME}${part}(?!\\.[\\p{L}\\p{N}])`,'gu'));if(people.has(t.trim().toLowerCase()))return [across(new RegExp(`(?:${AFTER_SCHEME}|(?<=@)|(?<=(?<![\\p{L}\\p{N}_-])www\\.))${part}(?=(?:\\.${PIECE}){0,8}${ENDING})`,'gu')),across(new RegExp(`${part}(?=(?:\\.${PIECE}){0,8}${WEB_ENDING})`,'gu')),dotless,word];return [across(new RegExp(`${part}(?=(?:\\.${PIECE}){0,8}${ENDING})`,'gu')),dotless,word];});}
