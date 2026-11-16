// parse.js — a dependency-free CommonMark 0.31.2 + GFM 0.29 renderer written
// from scratch, byte-compatible with marked 18.1.3's default options
// (gfm on, breaks off, pedantic off, async off).
//
// Layout: small string helpers, an inline scanner that builds a node list
// and resolves emphasis with a delimiter stack, then a line-based block
// parser (blockquotes and list items recurse on stripped line ranges).
// No imports, no vendor code, no state kept between parse() calls.

// ---------------------------------------------------------------- helpers

const PUNCT_RE = /[\p{P}\p{S}]/u;            // Unicode punctuation / symbol
const PUNCT_NOTILDE_RE = /(?!~)[\p{P}\p{S}]/u; // same, with '~' not punctuation
const PUNCT_EM_RE = /(?![*_])[\p{P}\p{S}]/u;  // marked's emphasis punctuation: P+S, '~' included, '*'/'_' excluded
const WS_RE = /\s/;
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function isPunct(ch) { return PUNCT_RE.test(ch); }
// Single-char punctuation test with an ASCII fast path: most escaped
// punctuation in practice is ASCII, and the Unicode regex is slow.
function isPunctCh(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT.indexOf(ch) !== -1;
  return PUNCT_RE.test(ch);
}
function isPunctNoTilde(ch) { return PUNCT_NOTILDE_RE.test(ch); }
function isPunctEm(ch) { return PUNCT_EM_RE.test(ch); }
function isWs(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || WS_RE.test(ch); }
function isAlnum(ch) { return /[\p{L}\p{N}]/u.test(ch); }

// Escape text for HTML. encodeAll escapes every & < > " '; otherwise & is
// only escaped when it does not start a character reference.
const ESC_ALL = /[&<>"']/g;
const ESC_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s, encodeAll) {
  if (encodeAll) return ESC_ALL.test(s) ? s.replace(ESC_ALL, c => ESC_MAP[c]) : s;
  return ESC_NOENC.test(s) ? s.replace(ESC_NOENC, c => ESC_MAP[c]) : s;
}

// marked's text-token unescape: only numeric character references are
// decoded (named entities pass through verbatim). A bare & that does not
// start a valid reference becomes &amp; — but only when the string holds a
// numeric reference at all; otherwise the renderer escape handles it.
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericRefs(s) {
  if (s.indexOf('&') === -1 || !NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// encodeURI, with %25 collapsed back to %; null when it throws.
function encodeHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// Remove a backslash before any ASCII punctuation character.
function unescapePunct(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.includes(s[i + 1])) { out += s[i + 1]; i++; }
    else out += c;
  }
  return out;
}

// Link-label normalisation: trim, collapse whitespace, case-fold.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing blank lines the way marked's `ge` does: at most one
// trailing newline is kept; two or more trailing blank lines are dropped.
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// ---------------------------------------------------------------- tab help

// Columns of leading whitespace (a tab advances to the next multiple of 4).
const FENCE_CLOSE_RES = new Map();
function fenceCloseRe(ch, len) {
  const key = ch + len;
  let re = FENCE_CLOSE_RES.get(key);
  if (!re) {
    re = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}[ \\t]*$`);
    FENCE_CLOSE_RES.set(key, re);
  }
  return re;
}
function indentCols(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 32) c++;
    else if (ch === 9) c += 4 - (c % 4);
    else break;
  }
  return c;
}

// Remove n columns of leading indent; a tab straddling the boundary leaves
// spaces behind.
function stripCols(s, n) {
  let col = 0, i = 0, pend = '';
  while (i < s.length && col < n) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { i++; col++; }
    else if (ch === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) { i++; col += w; }
      else { pend = ' '.repeat(col + w - n); i++; col = n; }
    } else break;
  }
  return pend + s.slice(i);
}

// Expand leading tabs/spaces to spaces, starting at column baseCol.
function expandLeadingWs(s, baseCol) {
  let col = baseCol, i = 0, out = '';
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { out += ' '; i++; col++; }
    else if (ch === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); i++; col += w; }
    else break;
  }
  return out + s.slice(i);
}

function isBlank(s) { return /^[ \t]*$/.test(s); }

// ---------------------------------------------------------------- inline

const EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// Sticky form of EMAIL_RE: test for an email starting exactly at `i`
// without slicing the string.
const EMAIL_RE_Y = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
// Positions that can start an inline token: structural chars, a double
// space (possible hard break), and the extended-autolink triggers.
// (Emails are handled separately: a jump must not pass an '@', since an
// email autolink starts at the local part before it.)
const INLINE_JUMP_RE = /\\|`|\[|!|<|\*|_|~|  |www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:/gi;
function emailAt(s, i) { EMAIL_RE_Y.lastIndex = i; return EMAIL_RE_Y.test(s); }
const EMAIL_RE_NOLOOK = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/;
const EMAIL_LOCAL = /^[A-Za-z0-9._+-]+@/;
const AUTOLINK_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*/;
const AUTOLINK_EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const TAG_COMMENT = /^<!--(?:-?>|[\s\S]*?-->)/;
const TAG_CLOSE = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/;
const TAG_OPEN = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/;
const TAG_PI = /^<\?[\s\S]*?\?>/;
const TAG_DECL = /^<![a-zA-Z][\s\S]*?>/;
const TAG_CDATA = /^<!\[CDATA\[[\s\S]*?\]\]>/;

function tryTag(s) {
  let m = TAG_COMMENT.exec(s); if (m) return m[0];
  m = TAG_CLOSE.exec(s); if (m) return m[0];
  m = TAG_OPEN.exec(s); if (m) return m[0];
  m = TAG_PI.exec(s); if (m) return m[0];
  m = TAG_DECL.exec(s); if (m) return m[0];
  m = TAG_CDATA.exec(s); if (m) return m[0];
  return null;
}

// Extended autolink (GFM) at position i of s. Returns {raw, href, text} or null.
function tryUrl(s, i) {
  const rest = s.slice(i);
  let kind = 0; // 1 = mailto/xmpp + email, 2 = protocol/www, 3 = email
  let raw = null;
  let m = /^(?:mailto:|xmpp:)/i.exec(rest);
  if (m) {
    const em = EMAIL_RE.exec(rest.slice(m[0].length));
    if (em) {
      raw = m[0] + em[0]; kind = 1;
      if (/^xmpp:/i.test(m[0])) {
        const p = /^\/[A-Za-z0-9@.]+/.exec(rest.slice(raw.length));
        if (p) raw += p[0];
      }
    }
  }
  if (!raw) {
    m = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.exec(rest) || /^www\./.exec(rest);
    if (m) {
      const tail = /^(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/.exec(rest.slice(m[0].length));
      if (tail) { raw = m[0] + tail[0]; kind = 2; }
    }
  }
  if (!raw) {
    const em = EMAIL_RE.exec(rest);
    if (em) { raw = em[0]; kind = 3; }
  }
  if (!raw) return null;
  // Backpedal: repeatedly trim to the longest well-formed prefix.
  let prev = '';
  while (raw !== prev) {
    prev = raw;
    const b = BACKPEDAL.exec(raw);
    raw = b ? b[0] : '';
    if (!raw) return null;
  }
  let href;
  if (kind === 1) href = raw;
  else if (kind === 2) href = raw.startsWith('www.') ? 'http://' + raw : raw;
  else href = 'mailto:' + raw;
  return { raw, href, text: raw };
}

// Scan a link label starting at s[i] === '['. Returns {text, end} where end
function scanLabel(s, i) {
  // i points at '['
  let j = i + 1, depth = 0, start = j;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      // Marked's label regex code-span alternative: an opening run,
      // content with no backticks, then a closing run. If the content
      // contains a backtick (or a bracket / blank line is hit first),
      // the backticks cannot be consumed and the label is invalid.
      // A run of 2+ backticks immediately before ']' is also allowed.
      let n = 0;
      while (j + n < s.length && s[j + n] === '`') n++;
      let r = j + n, cl = -1;
      while (r < s.length && s[r] !== '`') {
        if (s[r] === ']' || s[r] === '[' || s[r] === '\n') break;
        r++;
      }
      if (r < s.length && s[r] === '`') {
        let e2 = r;
        while (e2 < s.length && s[e2] === '`') e2++;
        cl = e2;
      }
      if (cl !== -1) { j = cl; continue; }
      if (n >= 2 && s[j + n] === ']') { j = j + n; continue; }
      return null;
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth === 0) {
        const text = s.slice(start, j);
        if (text.length > 999) return null;
        return { text, end: j + 1 };
      }
      depth--; j++; continue;
    }
    if (c === '\n') {
      // newline allowed unless the next line is blank
      let k = j + 1;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= s.length || s[k] === '\n') return null;
      j++; continue;
    }
    j++;
  }
  return null;
}

// Parse an inline link destination + optional title starting at s[i] === '('.
// Returns {href, title, end} (end just past ')') or null.
function parseInlineDest(s, i) {
  let j = i + 1;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let href = '';
  if (s[j] === '<') {
    let k = j + 1, ok = false;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '>') { ok = true; break; }
      if (c === '\n' || c === '<') break;
      k++;
    }
    if (!ok) return null;
    href = s.slice(j + 1, k);
    j = k + 1;
  } else {
    // Bare destination: balanced parens, no spaces/control chars.
    let depth = 0, k = j;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\') { k += 2; continue; }
      if (c === ' ') { break; }
      if (c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (depth > 0) return null;
    href = s.slice(j, k);
    j = k;
  }
  // Optional title, preceded by spaces/newlines.
  let title = null;
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  if (k < s.length && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const q = s[k];
    const close = q === '(' ? ')' : q;
    let t = k + 1, ok = false;
    while (t < s.length) {
      const c = s[t];
      if (c === '\\') { t += 2; continue; }
      if (c === close) { ok = true; break; }
      if (q === "'" && c === '\n') {
        // single-quoted title: newline ok unless followed by a blank line
        let u = t + 1;
        while (u < s.length && (s[u] === ' ' || s[u] === '\t')) u++;
        if (u >= s.length || s[u] === '\n') break;
      }
      if (q === '(' && c === '\n') break;
      t++;
    }
    if (ok) {
      title = s.slice(k + 1, t);
      j = t + 1;
      k = j;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    }
  }
  if (s[k] !== ')') return null;
  return { href: unescapePunct(href), title: title === null ? null : unescapePunct(title), end: k + 1 };
}

// ------------------------------------------------------------ inline parse

// Node kinds: t=text, code, br, html, link, image, em, strong, del,
// delim (an emphasis/strikethrough delimiter run, resolved later).
// Text nodes carry raw=false (normal) or raw=true (inside <pre>/<script>/...:
// emitted verbatim, no entity decoding, no escaping).

// ---- marked's emStrong / del forward scan (faithful reimplementation) ----
// The LDelim / RDelim patterns from marked 18.1.3, with the placeholder
// classes replaced exactly as marked does (notPunctSpace, then
// punctSpace, then punct). The CommonMark delimiter-stack algorithm
// cannot reproduce marked here: marked scans forward from each opener,
// and an intermediate opener run ADDS to the opener length while a
// closer blocked by the rule of three ADDS to a separate accumulator,
// so an outer opener can fail to close even though an inner pair
// matched (e.g. `*a **b** c*` leaves the outer `*` literal).
function emRe(src, flags) {
  return new RegExp(
    src.replace(/notPunctSpace/g, '[^\\s\\p{P}\\p{S}]')
       .replace(/punctSpace/g, '[\\s\\p{P}\\p{S}]')
       .replace(/punct/g, '[\\p{P}\\p{S}]'),
    flags);
}
// EM_PUNCT_NOT_STAR on one char: not '*'/'_', and whitespace or
// punctuation/symbol. ASCII fast path, Unicode regex only past ASCII.
function isEmPunct(ch) {
  if (ch === '' || ch === '*' || ch === '_') return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ASCII_PUNCT.indexOf(ch) !== -1;
  return isWs(ch) || PUNCT_RE.test(ch);
}
// UNICODE_ALNUM on one char, ASCII fast path.
function isAlnumCh(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return UNICODE_ALNUM.test(ch);
}
function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    i += cp > 0xFFFF ? 2 : 1;
    n++;
  }
  return n;
}

// UTF-16 length of the first code point of s (1, or 2 for astral).
function firstCpLen(s) { return s.codePointAt(0) > 0xFFFF ? 2 : 1; }

const EM_STRONG_LDELIM_STICKY = emRe('(?:\\*+(?:((?!\\*)(?!~)punct)|([^\\s*]))?|_+(?:((?!_)(?!~)punct)|([^\\s_]))?)', 'yu');
const DEL_LDELIM_STICKY = emRe('~~?(?:((?!~)punct)|[^\\s~])', 'yu');
// RDelim first alternatives (the ^-anchored region skips) as sticky
// regexes, tried once at Q: in the sliced original they could only
// match at the slice start, never later. The remaining alternatives
// keep their group numbering (the first alternative has no groups).
const EM_STRONG_RDELIM_AST_FIRST = emRe('[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)', 'yu');
const EM_STRONG_RDELIM_AST_MAIN = emRe('[^*]+(?=[^*])|(?!\\*)(?!~)punct(\\*+)(?=[\\s]|$)|(?:notPunctSpace|~)(\\*+)(?!\\*)(?=(?!~)punctSpace|$)|(?!\\*)(?!~)punctSpace(\\*+)(?=(?:notPunctSpace|~))|[\\s](\\*+)(?!\\*)(?=(?!~)punct)|(?!\\*)(?!~)punct(\\*+)(?!\\*)(?=(?!~)punct)|(?:notPunctSpace|~)(\\*+)(?=(?:notPunctSpace|~))', 'gu');
const EM_STRONG_RDELIM_UND_FIRST = emRe('[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)', 'yu');
const EM_STRONG_RDELIM_UND_MAIN = emRe('[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)', 'gu');
const DEL_RDELIM_FIRST = emRe('[^~]+(?=[^~])', 'yu');
const DEL_RDELIM_MAIN = emRe('(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)', 'gu');
const EM_PUNCT_NOT_STAR = /^((?![*_])[\s\p{P}\p{S}])/u; // marked's inline.punctuation
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// marked's fe(): for each of '*', '_' and '~', the start index of the
// last delimiter run whose preceding char is not whitespace.
const DELIM_RUN_RE = /([*_~])\1*/g;
function lastPossibleClosers(s) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const re = DELIM_RUN_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const c = m[0][0];
    const o = m.index === 0 ? '\n' : s[m.index - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') out[c] = m.index;
  }
  return out;
}

// Does a link label contain a backtick run that is not part of a valid
// code span (a closing run of the same length, not followed by a backtick,
// with at least one non-backtick char in between)? Marked's blockSkip
// link pattern only allows backticks inside such a code span, so a label
// with an invalid backtick run is not maskable as a link at all.
function labelHasInvalidBacktick(text, strict) {
  // strict: marked's blockSkip link label (step 3, inline links) uses a
  // backreference (\k<a>), so a code span's closing run must EQUAL its
  // opening run. !strict: reflinkSearch's label (step 1, reference
  // links) allows any closing run length (`` `+ `` ... `` `+ ``).
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i; while (j < text.length && text[j] === '`') j++;
      const run = j - i;
      let k = j, close = -1, closeEnd = -1;
      while (k < text.length) {
        if (text[k] === '`') {
          let e = k; while (e < text.length && text[e] === '`') e++;
          if (strict ? (e - k === run && (e >= text.length || text[e] !== '`') && k > j) : (k > j)) { close = k; closeEnd = e; break; }
          k = e;
        } else k++;
      }
      if (closeEnd === -1) return true;
      i = strict ? close + run : closeEnd; continue;
    }
    i++;
  }
  return false;
}

// Does `text` (a link label) contain a nested link that marked's #n
// step-1 recursion would find (linkInText)? Used only for reference
// links: reflinkSearch's label allows nested brackets, and #n masks
// the whole outer link unless the label contains a link (in which
// case it recurses and only the inner links are masked). A nested
// '[' counts only if it starts a link blockSkip can match (label
// with equal-run code spans, followed by '(' + dest) or a reflink
// with a defined ref. A nested inline link whose label holds a
// mismatched code span is not blockSkip-matchable, so it does not
// stop the outer link from being masked.
function labelHasNestedLink(text, ctx) {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      // Skip a code span (lax: any closing run length, like Lt).
      let j = i; while (j < text.length && text[j] === '`') j++;
      let k = j, closeEnd = -1;
      while (k < text.length) {
        if (text[k] === '`') {
          let e = k; while (e < text.length && text[e] === '`') e++;
          if (k > j) { closeEnd = e; break; }
          k = e;
        } else k++;
      }
      if (closeEnd === -1) { i = j; continue; }
      i = closeEnd; continue;
    }
    if (c === '[') {
      const lab = scanLabel(text, i);
      if (lab) {
        const after = lab.end;
        if (after < text.length && text[after] === '(' && !labelHasInvalidBacktick(lab.text, true)) {
          if (parseInlineDest(text, after)) return true;
        }
        if (after < text.length && text[after] === '[') {
          if (after + 1 < text.length && text[after + 1] === ']') {
            // Collapsed [a][]: marked's linkInText extracts the ref
            // via lastIndexOf('[') + slice(r+1,-1), which yields an
            // empty string for the collapsed form, so it does NOT
            // count as a nested link and the outer link is masked
            // whole. Skip past it without returning true.
            i = after + 2; continue;
          } else {
            const ref = scanLabel(text, after);
            if (ref && ctx.refs.get(normalizeLabel(ref.text))) return true;
          }
        }
        if (ctx.refs.get(normalizeLabel(lab.text))) return true;
        i = lab.end; continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

// Does a link label contain a nested '[' or ']' outside a code span?
// (Marked's blockSkip link pattern cannot match such a label.)
function labelHasNestedBracket(text) {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i; while (j < text.length && text[j] === '`') j++;
      const run = j - i;
      let k = j, close = -1;
      while (k < text.length) {
        if (text[k] === '`') {
          let e = k; while (e < text.length && text[e] === '`') e++;
          if (e - k === run) { close = k; break; }
          k = e;
        } else k++;
      }
      if (close === -1) { i = j; continue; }
      i = close + run; continue;
    }
    if (c === '[' || c === ']') return true;
    i++;
  }
  return false;
}

// Mask code spans, links, tags and escaped punctuation so their
// `*`/`_`/`~` are invisible to the emStrong / del forward scans
// (marked's #n). Length is preserved, so indices still line up with
// the raw text. Delimiters (`[`, `]`, backticks, `<`, `>`) are kept,
// so the flanking of a delimiter next to a masked region is unchanged.
// Step 2 of marked's #n (anyPunctuationOutsideCode): in each code span,
// inner backticks become '+'; an escaped punctuation becomes '++'.
// Length-preserving, so the masked text stays aligned with the raw text.
// This must run before the link masking: after this step a label whose
// code span contained a stray backtick has backtick-free content, so the
// blockSkip link pattern can match it and hide its emphasis delimiters.
const OT_JUMP_RE = /\\|`/g;
function otTransform(s) {
  if (!s.includes('\\') && !s.includes('`')) return s;
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    OT_JUMP_RE.lastIndex = i;
    const jm = OT_JUMP_RE.exec(s);
    if (!jm) { out += s.slice(i); break; }
    const j = jm.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && isPunctCh(s[j + 1])) { out += s.slice(i, j) + '++'; i = j + 2; continue; }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    // backtick run: find a closing run of the same length
    let k = j; while (k < n && s[k] === '`') k++;
    const run = k - j;
    let close = -1, p = k;
    while (p < n) {
      p = s.indexOf('`', p);
      if (p === -1) break;
      let e = p; while (e < n && s[e] === '`') e++;
      if (e - p === run && (e >= n || s[e] !== '`')) { close = p; break; }
      p = e;
    }
    if (close === -1) { out += s.slice(i, k); i = k; continue; }
    out += s.slice(i, k) + s.slice(k, close).replace(/`/g, '+') + s.slice(close, close + run);
    i = close + run;
  }
  return out;
}

const MASK_JUMP_RE = /[\\`\[!<]/g;
function maskInline(s, ctx) {
  // Marked's #n masks reflinks on the RAW text (step 1), before the
  // backtick transform (step 2): a label whose code span holds a stray
  // backtick is not maskable as a link, even though the transform
  // would make it look valid. otTransform is length-preserving, so
  // indices from the raw text line up with the transformed text.
  const raw = s;
  s = otTransform(s);
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    // Jump over plain text in one C-level scan; only the special chars
    // below can start a masked region.
    MASK_JUMP_RE.lastIndex = i;
    const jm = MASK_JUMP_RE.exec(s);
    if (!jm) { out += s.slice(i); break; }
    const j = jm.index;
    if (j > i) out += s.slice(i, j);
    i = j;
    const c = s[i];
    if (c === '\\' && i + 1 < n && isPunctCh(s[i + 1])) { out += '++'; i += 2; continue; }
    if (c === '\\') { out += c; i++; continue; }
    if (c === '`') {
      let k = i; while (k < n && s[k] === '`') k++;
      const run = k - i;
      let close = -1, p = k;
      while (p < n) {
        p = s.indexOf('`', p);
        if (p === -1) break;
        let e = p; while (e < n && s[e] === '`') e++;
        if (e - p === run && (e >= n || s[e] !== '`')) { close = p; break; }
        p = e;
      }
      if (close === -1) { out += s.slice(i, k); i = k; continue; }
      out += s.slice(i, k) + 'a'.repeat(close - k) + s.slice(close, close + run);
      i = close + run; continue;
    }
    if (c === '[' || (c === '!' && i + 1 < n && s[i + 1] === '[')) {
      const isImage = c === '!';
      const start = isImage ? i + 1 : i;
      // The label scan runs on the transformed text (step 3, blockSkip)
      // — but a reference link is masked in step 1, on the RAW text,
      // and the transform can destroy its label: otTransform pairs the
      // label's opening run with a later run of the same length and
      // turns the label's closing backtick into '+', so the transformed
      // scan fails and the link is never masked. Fall back to the raw
      // scan for reference paths only (inline masking is step 3).
      let lab = scanLabel(s, start);
      let rawOnly = false;
      if (!lab) {
        lab = scanLabel(raw, start);
        rawOnly = !!lab;
      }
      if (lab) {
        let end = -1, endKind = null;
        const after = lab.end;
        if (!rawOnly && after < n && s[after] === '(') {
          const d = parseInlineDest(s, after);
          if (d) { end = d.end; endKind = 'inline'; }
        }
        if (end === -1 && after < n && s[after] === '[') {
          if (after + 1 < n && s[after + 1] === ']') {
            if (ctx.refs.get(normalizeLabel(lab.text))) { end = after + 2; endKind = 'ref'; }
          } else {
            const ref = scanLabel(rawOnly ? raw : s, after);
            if (ref && ctx.refs.get(normalizeLabel(ref.text))) { end = ref.end; endKind = 'ref'; }
          }
        }
        if (end === -1 && ctx.refs.get(normalizeLabel(lab.text))) { end = after; endKind = 'shortcut'; }
        // Reference links are masked by marked's #n step 1, on the RAW
        // text (before the backtick transform): a label valid only
        // after the transform — e.g. a code span holding a stray
        // backtick, which the label pattern cannot consume — is not a
        // maskable reflink, so its emphasis delimiters stay visible.
        // Inline links are masked in step 3, on the transformed text,
        // so they keep the transformed label. Re-validate only the
        // reference paths, on the raw text.
        let guardText = lab.text;
        if (end !== -1 && endKind !== 'inline') {
          const rawLab = scanLabel(raw, start);
          if (!rawLab || rawLab.end !== after) end = -1;
          else guardText = rawLab.text;
        }
        // Marked's blockSkip link pattern cannot match a label with
        // nested brackets, and its reflink masking is recursive: only
        // the inner links are masked, so an emphasis delimiter in the
        // outer label stays visible. Mask only leaf links (no nested
        // bracket outside a code span); otherwise leave the '[' and
        // let the inner links be masked on their own. For reference
        // links, reflinkSearch's label allows nested brackets and #n
        // masks the whole outer link unless the label contains a link
        // (linkInText), so use labelHasNestedLink there instead.
        const nestedOk = endKind === 'inline'
          ? !labelHasNestedBracket(guardText)
          : !labelHasNestedLink(guardText, ctx);
        if (end !== -1 && nestedOk && !labelHasInvalidBacktick(guardText, endKind === 'inline')) {
          if (isImage) out += '!';
          out += '[' + 'a'.repeat(end - start - 2) + ']';
          i = end; continue;
        }
      }
      out += c; i++; continue;
    }
    if (c === '<') {
      const sub = s.slice(i);
      const body = sub.slice(1);
      const m = AUTOLINK_SCHEME.exec(body) || AUTOLINK_EMAIL.exec(body);
      if (m && body[m[0].length] === '>') { out += '<' + 'a'.repeat(m[0].length) + '>'; i += m[0].length + 2; continue; }
      const tag = tryTag(sub);
      if (tag) { out += '<' + 'a'.repeat(tag.length - 2) + '>'; i += tag.length; continue; }
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// Marked's emStrong tokenizer. raw is the full inline text, masked the
// masked copy (same length); i the index of the delimiter run, r the
// char before the run ('' when the previous token was not text),
// lastCloser the last possible closer index for the delimiter char in
// the MASKED text. Returns {type, raw, text} or null.
function tryEmStrong(raw, masked, i, r, lastCloser) {
  EM_STRONG_LDELIM_STICKY.lastIndex = i;
  const L = EM_STRONG_LDELIM_STICKY.exec(raw);
  if (!L || (!L[1] && !L[2] && !L[3] && !L[4])) return null;
  const ch = L[0][0];
  const o = r === ch;
  let l = i;
  while (l > 0 && masked[l - 1] === ch) l--;
  // p: the code point ending just before the run (masked[l-1], or the
  // surrogate pair ending at l).
  let p = '';
  if (l > 0) {
    const lo = masked.charCodeAt(l - 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF && l >= 2) {
      const hi = masked.charCodeAt(l - 2);
      if (hi >= 0xD800 && hi <= 0xDBFF) p = masked.slice(l - 2, l);
      else p = masked[l - 1];
    } else p = masked[l - 1];
  }
  const h = p === '*' || p === '_' || isEmPunct(p);
  let n = r;
  if (l < i) n = p;
  const u = l < i ? h : isEmPunct(n);
  if (L[4] && isAlnumCh(n)) return null;
  const d = L[1] || L[3] || '';
  if (!d || !n || u) {
    const k = cpLen(L[0]) - 1;
    let m = k, f = 0;
    const y = i - l + k;
    const R = p !== '' && !isWs(p) && (!!d || (ch === '*' && !h));
    if (ch !== '*' && ch !== '_') return null;
    const A = ch === '*' ? EM_STRONG_RDELIM_AST_MAIN : EM_STRONG_RDELIM_UND_MAIN;
    const AF = ch === '*' ? EM_STRONG_RDELIM_AST_FIRST : EM_STRONG_RDELIM_UND_FIRST;
    const Q = i + k;
    if (lastCloser < Q) return null;
    // The ^-anchored region skip can only match at Q (the slice start
    // in the original); try it once, then scan with the main regex.
    AF.lastIndex = Q;
    const fm = AF.exec(masked);
    A.lastIndex = fm ? Q + fm[0].length : Q;
    let m2;
    while ((m2 = A.exec(masked)) !== null && !(m2.index > lastCloser)) {
      const rel = m2.index - Q;
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      let b = g.length; // g is a run of '*', '_' or '~': ASCII only
      if (m2[3] || m2[4]) { m += b; continue; }
      else if (m2[5] || m2[6] || R) {
        if (o && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = firstCpLen(m2[0]);
      const M = raw.slice(i, i + k + rel + te + b);
      if (Math.min(k, b) % 2) return { type: 'em', raw: M, text: M.slice(1, -1) };
      return { type: 'strong', raw: M, text: M.slice(2, -2) };
    }
  }
  return null;
}

// Marked's del tokenizer. Same shape as tryEmStrong; the closer run
// must have exactly the opener's length and there is no rule of three.
function tryDel(raw, masked, i, r, lastDelCloser) {
  DEL_LDELIM_STICKY.lastIndex = i;
  const L = DEL_LDELIM_STICKY.exec(raw);
  if (!L) return null;
  if (!(L[1] || '') || !r || isEmPunct(r)) {
    const o = cpLen(L[0]) - 1;
    let p = o;
    const d = i + o;
    if (lastDelCloser < d) return null;
    DEL_RDELIM_FIRST.lastIndex = d;
    const fm = DEL_RDELIM_FIRST.exec(masked);
    DEL_RDELIM_MAIN.lastIndex = fm ? d + fm[0].length : d;
    let m2;
    while ((m2 = DEL_RDELIM_MAIN.exec(masked)) !== null && !(m2.index > lastDelCloser)) {
      const rel = m2.index - d;
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      let l = g.length; // g is a run of '~': ASCII only
      if (l !== o) continue;
      if (m2[3] || m2[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const te = firstCpLen(m2[0]);
      const b = raw.slice(i, i + o + rel + te + l);
      return { type: 'del', raw: b, text: b.slice(o, -o) };
    }
  }
  return null;
}

// Flanking computation for a delimiter run of `ch` starting at i with
// length len in string s. punctFn decides what counts as punctuation.
function flank(s, i, len, punctFn) {
  const before = i > 0 ? s[i - 1] : '\n';
  const after = i + len < s.length ? s[i + len] : '\n';
  const beforeWs = isWs(before), afterWs = isWs(after);
  const beforePunct = !beforeWs && punctFn(before);
  const afterPunct = !afterWs && punctFn(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right, before, after };
}

// Scan s into nodes. st holds the document-wide inline state
// ({inLink, inRawBlock}) and ctx.refs for reference links.
// Returns {nodes, emittedLink}.
function scanInline(s, ctx, st) {
  const nodes = [];
  let i = 0, n = s.length;
  let textStart = 0;
  // The masked copy (code spans, links, tags, escaped punctuation
  // hidden) and the last possible closer indexes in it, used to bound
  // the emStrong / del forward scans. Only needed when the text has a
  // delimiter run at all; otherwise the scans never run. And when the
  // text has no backtick, '[', '<' or backslash, nothing can hide a
  // delimiter, so the raw text IS the masked text (skip both passes).
  const hasDelim = s.includes('*') || s.includes('_') || s.includes('~');
  const needsMask = hasDelim && (s.includes('`') || s.includes('[') || s.includes('<') || s.includes('\\'));
  const masked = needsMask ? maskInline(s, ctx) : s;
  const lastCloser = hasDelim ? lastPossibleClosers(masked) : { '*': -1, '_': -1, '~': -1 };
  // The char before the current position, per marked's inline lexer:
  // the last char of the immediately preceding text run, or '' when
  // the previous token was not text. A text run ending in '_' does
  // NOT update it (marked leaves it at its earlier value, which here
  // is always '' since a text run follows a non-text token).
  const prevChar = () => (i > textStart && s[i - 1] !== '_') ? s[i - 1] : '';
  const flushText = (end) => {
    if (end > textStart) {
      const raw = s.slice(textStart, end);
      nodes.push({ k: 't', s: st.inRawBlock ? raw : decodeNumericRefs(raw), raw: st.inRawBlock });
    }
  };
  // Email-local-part char [A-Za-z0-9._+-], as a char-code test (the
  // regex version cost ~5% of total time on the 40 docs).
  const isEmailChar = (c) => {
    const code = c.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 46 || code === 95 || code === 43 || code === 45;
  };

  while (i < n) {
    const c = s[i];
    // Backslash escape / hard break
    if (c === '\\') {
      if (i + 1 < n && ASCII_PUNCT.includes(s[i + 1])) {
        flushText(i); nodes.push({ k: 't', s: s[i + 1], raw: st.inRawBlock }); i += 2; textStart = i; continue;
      }
      if (i + 1 < n && s[i + 1] === '\n') {
        // backslash hard break, unless only whitespace follows to the end
        let k = i + 2, has = false;
        while (k < n) { if (!isWs(s[k])) { has = true; break; } k++; }
        if (has) {
          flushText(i); nodes.push({ k: 'br' });
          // the break eats the leading whitespace of the next line
          let m2 = i + 2;
          while (m2 < n && (s[m2] === ' ' || s[m2] === '\t')) m2++;
          i = m2; textStart = i; continue;
        }
      }
      i++; continue;
    }
    // Code span
    if (c === '`') {
      let j = i; while (j < n && s[j] === '`') j++;
      const run = j - i;
      // find a closing run of exactly `run` backticks not followed by one
      let k = j, close = -1;
      while (k < n) {
        k = s.indexOf('`', k);
        if (k === -1) break;
        let e = k; while (e < n && s[e] === '`') e++;
        if (e - k === run && (e >= n || s[e] !== '`')) { close = k; break; }
        k = e;
      }
      if (close === -1) { i = j; continue; }
      let content = s.slice(j, close);
      // content must not start and end with a backtick (regex enforces this
      // via its content pattern); re-check cheaply:
      if (content.length > 0 && (content[0] === '`' || content[content.length - 1] === '`')) {
        // fall back: the regex would not have matched this span; treat the
        // opening run as literal text.
        i = j; continue;
      }
      flushText(i);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', s: content });
      i = close + run; textStart = i; continue;
    }
    // Link / image
    if (c === '[' || (c === '!' && i + 1 < n && s[i + 1] === '[')) {
      const isImage = c === '!';
      const start = isImage ? i + 1 : i;
      const lab = scanLabel(s, start);
      if (lab) {
        // The Be() check: a '<' inside the label that opens a tag/autolink
        // extending past the label invalidates the link.
        let bad = false;
        if (lab.text.includes('<')) {
          for (let p = 0; p < lab.text.length && !bad; p++) {
            const ch = lab.text[p];
            if (ch === '\\') { p++; continue; }
            if (ch === '`') {
              let q = p; while (q < lab.text.length && lab.text[q] === '`') q++;
              const run = q - p; let r = q, cl = -1;
              while (r < lab.text.length) {
                if (lab.text[r] === '`') { let e2 = r; while (e2 < lab.text.length && lab.text[e2] === '`') e2++; if (e2 - r === run) { cl = r; break; } r = e2; } else r++;
              }
              if (cl !== -1) p = cl + run - 1; continue;
            }
            if (ch === '<') {
              const sub = s.slice(start + 1 + p);
              let tlen = 0;
              const tag = tryTag(sub);
              if (tag) tlen = tag.length;
              else {
                // An autolink <scheme:...> or <email> starting here.
                const body = sub.slice(1);
                const am = AUTOLINK_SCHEME.exec(body) || AUTOLINK_EMAIL.exec(body);
                if (am && body[am[0].length] === '>') tlen = am[0].length + 2;
              }
              if (tlen > 0 && tlen > lab.text.length - p) bad = true;
              else if (tlen > 0) p += tlen - 1;
            }
          }
        }
        if (!bad) {
          // Fallback chain (marked's link, reflink, nolink tokenizers):
          // inline destination, then full reference, then collapsed,
          // then shortcut. A failed inline destination falls back to
          // the shortcut reference.
          let href = null, title = null, end = -1;
          const after = lab.end;
          let triedRef = false;
          if (after < n && s[after] === '(') {
            const d = parseInlineDest(s, after);
            if (d) { href = d.href; title = d.title; end = d.end; }
          }
          if (href === null && after < n && s[after] === '[') {
            // A syntactically valid full/collapsed reference that does
            // not resolve emits '[' as text; it does NOT fall back to
            // the shortcut (marked's reflink tokenizer returns a text
            // token for the bare '[').
            triedRef = true;
            if (after + 1 < n && s[after + 1] === ']') {
              const r = ctx.refs.get(normalizeLabel(lab.text));
              if (r) { href = r.href; title = r.title; end = after + 2; }
            } else {
              const ref = scanLabel(s, after);
              if (ref) {
                const r = ctx.refs.get(normalizeLabel(ref.text));
                if (r) { href = r.href; title = r.title; end = ref.end; }
              }
            }
          }
          if (href === null && !triedRef) {
            const r = ctx.refs.get(normalizeLabel(lab.text));
            if (r) { href = r.href; title = r.title; end = after; }
          }
          if (href !== null) {
            flushText(i);
            const wasInLink = st.inLink;
            st.inLink = true;
            const inner = scanInline(lab.text.replace(/\\([\[\]])/g, '$1'), ctx, st);
            st.inLink = wasInLink;
            if (!isImage && inner.emittedLink) {
              // A link inside link text invalidates the outer link: emit
              // the '[' as text and rescan from just after it.
              nodes.push({ k: 't', s: isImage ? '!' : '[', raw: st.inRawBlock });
              i = start + 1; textStart = i; continue;
            }
            nodes.push({ k: isImage ? 'image' : 'link', href, title, children: inner.nodes, autolink: false });
            i = end; textStart = i;
            continue;
          }
        }
      }
      // not a link: '[' (or '!') is plain text; move past it
      i = start + 1; continue;
    }
    // Autolink / HTML tag
    if (c === '<') {
      const sub = s.slice(i);
      const body = sub.slice(1);
      let m = AUTOLINK_SCHEME.exec(body) || AUTOLINK_EMAIL.exec(body);
      if (m && body[m[0].length] === '>') {
        const isEmail = m[0].includes('@') && !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(m[0]);
        flushText(i);
        const raw = m[0];
        nodes.push({ k: 'link', href: isEmail ? 'mailto:' + raw : raw, title: null, children: [{ k: 't', s: raw, raw: false }], autolink: true });
        i += m[0].length + 2; textStart = i; continue;
      }
      const tag = tryTag(sub);
      if (tag) {
        flushText(i);
        nodes.push({ k: 'html', s: tag });
        // Marked's startATag is /^<a /i: a bare <a> (no attributes)
        // does NOT set inLink, so a bare URL after it still autolinks.
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)[\s>]/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)[\s>]/i.test(tag)) st.inRawBlock = false;
        i += tag.length; textStart = i; continue;
      }
      i++; continue;
    }
    // Emphasis delimiters (marked's emStrong forward scan). The opener
    // is resolved now, from the raw text; if it does not match, the run
    // is literal text and stays in the text run.
    if (c === '*' || c === '_') {
      const hit = tryEmStrong(s, masked, i, prevChar(), lastCloser[c]);
      if (hit) {
        flushText(i);
        const inner = scanInline(hit.text, ctx, st);
        nodes.push({ k: hit.type, children: inner.nodes });
        i += hit.raw.length; textStart = i; continue;
      }
      i++; continue;
    }
    // Strikethrough delimiters (marked's del forward scan). A run of
    // 3+ tildes never matches (delLDelim needs a non-tilde after the
    // run) and is literal text, skipped whole by the i++ fall-through
    // below once the first tilde fails to match.
    if (c === '~') {
      const hit = tryDel(s, masked, i, prevChar(), lastCloser['~']);
      if (hit) {
        flushText(i);
        const inner = scanInline(hit.text, ctx, st);
        nodes.push({ k: 'del', children: inner.nodes });
        i += hit.raw.length; textStart = i; continue;
      }
      i++; continue;
    }
    // Hard break: two or more spaces before a newline (not at string end)
    if (c === ' ' && s[i + 1] === ' ') {
      let j = i; while (j < n && s[j] === ' ') j++;
      if (j < n && s[j] === '\n') {
        let k = j + 1, has = false;
        while (k < n) { if (!isWs(s[k])) { has = true; break; } k++; }
        if (has) {
          flushText(i); nodes.push({ k: 'br' });
          // the break eats the leading whitespace of the next line
          let m2 = j + 1;
          while (m2 < n && (s[m2] === ' ' || s[m2] === '\t')) m2++;
          i = m2; textStart = i; continue;
        }
      }
      i = j; continue;
    }
    // Extended autolinks (www. / http(s):// / ftp:// / email / mailto:)
    // No s.slice(i) here: the gate runs on every candidate char, so all
    // checks are position-based (startsWith with an offset, sticky
    // regexes, or a short lower-cased prefix).
    if (!st.inLink && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'm' || c === 'M' || c === 'x' || c === 'X' || isEmailChar(c))) {
      let tryIt = false;
      if (c === 'w' && s.startsWith('www.', i)) tryIt = true;
      else if (c === 'h' || c === 'H') {
        const p = s.slice(i, i + 8).toLowerCase();
        if (p.startsWith('http://') || p.startsWith('https://')) tryIt = true;
      } else if (c === 'f' || c === 'F') {
        if (s.slice(i, i + 6).toLowerCase().startsWith('ftp://')) tryIt = true;
      }
      if ((c === 'w' && s.startsWith('www.', i))) {
        const prev = i === 0 ? '' : s[i - 1];
        if (i !== 0 && !(prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '[')) tryIt = false;
      }
      if (!tryIt && (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i))) tryIt = true;
      if (!tryIt && isEmailChar(c) && (i === 0 || !isEmailChar(s[i - 1])) && emailAt(s, i)) tryIt = true;
      if (tryIt) {
        const u = tryUrl(s, i);
        if (u) {
          flushText(i);
          nodes.push({ k: 'link', href: u.href, title: null, children: [{ k: 't', s: u.text, raw: false }], autolink: true });
          i += u.raw.length; textStart = i; continue;
        }
      }
    }
    // Fast path: jump to the next position that can start a token, in
    // one C-level regex scan, instead of iterating char by char. The
    // current char is already known not to start a token (every branch
    // above failed it), so search strictly past it: a trigger AT i (e.g.
    // a 'www.' that tryUrl rejected) would otherwise match at i and the
    // jump would not advance. An '@' blocks the jump: an email autolink
    // starts at the local part before it, and the regex cannot see that.
    INLINE_JUMP_RE.lastIndex = i + 1;
    const jm = INLINE_JUMP_RE.exec(s);
    const j = jm ? jm.index : n;
    const at = s.indexOf('@', i);
    if (at !== -1 && at < j) { i++; continue; }
    i = j;
  }
  flushText(n);
  let emittedLink = false;
  // A link inside link text invalidates the outer link — but an
  // autolink (<...>) inside link text does not: marked keeps both.
  const hasLink = (nds) => {
    for (const nd of nds) {
      if (nd.k === 'link' && !nd.autolink) return true;
      if (nd.children && hasLink(nd.children)) return true;
    }
    return false;
  };
  emittedLink = hasLink(nodes);
  return { nodes, emittedLink };
}

// ------------------------------------------------- delimiter resolution

// CommonMark-style delimiter-stack processing over the node list.
// A delimiter node is replaced by an em/strong/del node wrapping the
// nodes between it and its matching closer.
function resolveDelims(nodes, delims) {
  const stack = delims.slice(); // node indexes of live delimiter nodes
  let di = 0;
  while (di < stack.length) {
    const cIdx = stack[di];
    const closer = nodes[cIdx];
    if (!closer || closer.k !== 'delim' || !closer.active || !closer.canClose) { di++; continue; }
    let openerPos = -1, use = 0;
    for (let oj = di - 1; oj >= 0; oj--) {
      const o = nodes[stack[oj]];
      if (!o || o.k !== 'delim' || !o.active || o.ch !== closer.ch || !o.canOpen) continue;
      if (closer.ch === '~') {
        if (o.len !== closer.len) continue;
      } else if ((o.canOpen && o.canClose) || (closer.canOpen && closer.canClose)) {
        // Rule of three: blocked only when the sum is a multiple of 3
        // and neither run is itself a multiple of 3.
        if ((o.len + closer.len) % 3 === 0 && (o.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      }
      openerPos = oj;
      use = (o.len >= 2 && closer.len >= 2) ? 2 : 1;
      break;
    }
    if (openerPos === -1) { di++; continue; }
    const oIdx = stack[openerPos];
    const opener = nodes[oIdx];
    const kind = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const children = nodes.slice(oIdx + 1, cIdx);
    const wrap = { k: kind, children };
    opener.len -= use;
    closer.len -= use;
    const repl = [];
    if (opener.len > 0) repl.push(opener);
    repl.push(wrap);
    if (closer.len > 0) repl.push(closer);
    nodes.splice(oIdx, cIdx - oIdx + 1, ...repl);
    stack.length = 0;
    for (let q = 0; q < nodes.length; q++) if (nodes[q].k === 'delim' && nodes[q].active) stack.push(q);
    if (closer.len > 0) {
      di = stack.indexOf(nodes.indexOf(closer));
    } else {
      const wp = nodes.indexOf(wrap);
      di = stack.findIndex(idx => idx > wp);
      if (di === -1) di = stack.length;
    }
  }
  // Leftover delimiters render as literal text, including ones nested
  // inside an already-created em/strong/del node.
  const toText = (nodes) => {
    for (const nd of nodes) {
      if (nd.k === 'delim') { nd.k = 't'; nd.s = nd.ch.repeat(nd.len); }
      else if (nd.children) toText(nd.children);
    }
  };
  toText(nodes);
}

// ------------------------------------------------------------ rendering

function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) out += renderInlineNode(nd);
  return out;
}

function renderInlineNode(nd) {
  switch (nd.k) {
    case 't': return nd.raw ? nd.s : escapeHtml(nd.s, false);
    case 'code': return '<code>' + escapeHtml(nd.s, true) + '</code>';
    case 'br': return '<br>';
    case 'html': return nd.s;
    case 'em': return '<em>' + renderInlineNodes(nd.children) + '</em>';
    case 'strong': return '<strong>' + renderInlineNodes(nd.children) + '</strong>';
    case 'del': return '<del>' + renderInlineNodes(nd.children) + '</del>';
    case 'link': {
      const enc = encodeHref(nd.href);
      if (enc === null) return nd.autolink ? escapeHtml(nd.children[0].s, true) : renderInlineNodes(nd.children);
      const href = escapeHtml(enc, nd.autolink);
      const text = nd.autolink ? escapeHtml(nd.children[0].s, true) : renderInlineNodes(nd.children);
      let s = '<a href="' + href + '"';
      if (nd.title) s += ' title="' + escapeHtml(nd.title, false) + '"';
      return s + '>' + text + '</a>';
    }
    case 'image': {
      const alt = renderPlain(nd.children);
      const enc = encodeHref(nd.href);
      if (enc === null) return escapeHtml(alt, false);
      let s = '<img src="' + escapeHtml(enc, false) + '" alt="' + escapeHtml(alt, false) + '"';
      if (nd.title) s += ' title="' + escapeHtml(nd.title, false) + '"';
      return s + '>';
    }
    default: return '';
  }
}

// Plain-text rendering (image alt text): no tags, no escaping.
function renderPlain(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 't': case 'code': case 'html': out += nd.s; break;
      case 'br': break;
      case 'em': case 'strong': case 'del': case 'link': case 'image': out += renderPlain(nd.children); break;
      default: break;
    }
  }
  return out;
}

// Parse inline markdown to HTML. ctx: {refs}. st: {inLink, inRawBlock}
// (inRawBlock is reset per call; inLink persists across calls).
function inlineToHtml(text, ctx, st) {
  st.inRawBlock = false;
  const { nodes } = scanInline(text, ctx, st);
  return renderInlineNodes(nodes);
}

// ------------------------------------------------------------ block parse

const BLOCK_TAG_ALT = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML16_START = new RegExp(`^ {0,3}(?:</?(?:${BLOCK_TAG_ALT})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LAZY_LIST_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const HR_RE = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:\s|$)(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const DEF_RE = /^ {0,3}\[(?!\s*\])((?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)))? *(?:\n+|$)/;
const TABLE_DELIM_RE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

// Reconstruct the exact source text of lines [i, k).
function rangeText(lines, i, k) {
  return lines.slice(i, k).join('\n') + (k < lines.length ? '\n' : '');
}

// Split a table row/header into cells (marked's de()).
function splitCells(s, count) {
  let t = '';
  for (let idx = 0; idx < s.length; idx++) {
    if (s[idx] === '|') {
      let bs = 0, p = idx - 1;
      while (p >= 0 && s[p] === '\\') { bs++; p--; }
      t += (bs % 2 === 1) ? '|' : ' |';
    } else t += s[idx];
  }
  const cells = t.split(' |');
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim().replace(/\\\|/g, '|');
  return cells;
}

function alignOf(cell) {
  if (/^ *-+: *$/.test(cell)) return 'right';
  if (/^ *:-+: *$/.test(cell)) return 'center';
  if (/^ *:-+ *$/.test(cell)) return 'left';
  return null;
}

// Is lines[j] the header of a table (lines[j+1] its delimiter row)?
// Returns the parsed table info or null.
function tableStart(lines, j) {
  if (j + 1 >= lines.length) return null;
  const headerLine = lines[j];
  const hm = /^ *([^\n ].*)$/.exec(headerLine);
  if (!hm) return null;
  const dm = TABLE_DELIM_RE.exec(lines[j + 1]);
  if (!dm) return null;
  if (!/[:|]/.test(dm[1])) return null;
  const header = splitCells(hm[1]);
  const delimCells = dm[1].replace(/^[|]|[|] *$/g, '').split('|');
  if (header.length !== delimCells.length) return null;
  return { header, align: delimCells.map(alignOf) };
}

// Regex-level table start (marked's table regex xe, as used in the
// top-level paragraph regex's lookahead): a header line plus a
// delimiter line, WITHOUT the cell-count check. The paragraph stops
// here even when the table tokenizer then rejects the table for a
// cell-count mismatch — the lines become a new paragraph instead.
// (A 7-cell header followed by a 2-cell delimiter splits the
// paragraph; requiring equal counts here swallowed the delimiter
// lines into the first paragraph.)
function tableStartLoose(lines, j) {
  if (j + 1 >= lines.length) return null;
  const hm = /^ *([^\n ].*)$/.exec(lines[j]);
  if (!hm) return null;
  const dm = TABLE_DELIM_RE.exec(lines[j + 1]);
  if (!dm) return null;
  if (!/[:|]/.test(dm[1])) return null;
  return true;
}

const ROW_STOP = new RegExp(`^(?: {0,3}(?:#{1,6}(?:\\s|$)|(?:\`{3,}(?=[^\`]*$)|~~~)|>|</?(?:${BLOCK_TAG_ALT})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:-[ \\t]*){3,}[ \\t]*$| {0,3}(?:_[ \\t]*){3,}[ \\t]*$| {0,3}(?:\\*[ \\t]*){3,}[ \\t]*$)`);
const HTML7_START = /^ {0,3}(?:<[a-z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|<\/[a-z][a-zA-Z0-9-]*\s*>)[ \t]*$/i;

// Does `line` start a block that can interrupt a paragraph? (GFM rules:
// ATX, fence, hr, blockquote, HTML types 1-6, list bullet / ordered "1".)
function isInterruptingStart(line, anyNum) {
  const ind = indentCols(line);
  if (ind >= 4) return false;
  const rest = stripCols(line, ind);
  // Dispatch on the first content char: each branch runs only the
  // tests that can match a line starting with it, instead of all 7.
  const c = rest[0];
  if (c === '#') return /^#{1,6}(?:\s|$)/.test(rest);
  if (c === '`') {
    const fm2 = /^(`{3,})/.exec(rest);
    return !!fm2 && !rest.slice(fm2[1].length).includes('`');
  }
  if (c === '~') return /^~{3,}/.test(rest);
  if (c === '-') return /^(?:-[ \t]*){3,}$/.test(rest) || (anyNum ? /^(?:[*+-]|\d{1,9}[.)])[ \t]+[^ \t\n]/.test(rest) : /^(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(rest));
  if (c === '_') return /^(?:_[ \t]*){3,}$/.test(rest);
  if (c === '*') return /^(?:\*[ \t]*){3,}$/.test(rest) || (anyNum ? /^(?:[*+-]|\d{1,9}[.)])[ \t]+[^ \t\n]/.test(rest) : /^(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(rest));
  if (c === '+') return anyNum ? /^(?:[*+-]|\d{1,9}[.)])[ \t]+[^ \t\n]/.test(rest) : /^(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(rest);
  if (c === '>') return true;
  if (c === '<') return HTML16_START.test(line);
  if (c >= '0' && c <= '9') return anyNum ? /^(?:[*+-]|\d{1,9}[.)])[ \t]+[^ \t\n]/.test(rest) : /^(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(rest);
  return false;
}

// Does `line` look like the start of any block (for blockquote lazy
// tracking and the setext-pair test)? Broader than interrupting: also
// indented code, defs, tables.
function startsAnyBlock(line) {
  if (isBlank(line)) return true;
  const ind = indentCols(line);
  if (ind >= 4) return true;
  if (isInterruptingStart(line)) return true;
  if (/^ {0,3}\[(?!\s*\])/.test(line)) return true;
  return false;
}

// Is `line` paragraph-like: non-blank and not the start of a block whose
// first child is not a paragraph (a list item whose content starts with
// paragraph text counts as paragraph-like).
function lineIsParaLike(line) {
  if (isBlank(line)) return false;
  const ind = indentCols(line);
  if (ind >= 4) return false;
  if (isInterruptingStart(line, true)) {
    // A list marker line is para-like when the item's first content is.
    const lm = /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
    if (!lm) return false;
    const content = lm[1];
    if (content === '') return true;
    return lineIsParaLike(content);
  }
  if (/^ {0,3}\[(?!\s*\])/.test(line)) return false;
  return true;
}

function stripBlockquotePrefix(line) {
  let i = 0, col = 0;
  while (i < line.length && col < 3 && line[i] === ' ') { i++; col++; }
  if (line[i] !== '>') return null;
  i++; col++;
  let j = i, out = '';
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { out += ' '; j++; col++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); j++; col += w; }
  }
  if (out.length > 0) out = out.slice(1);
  return out + line.slice(j);
}

// Block node kinds:
//  html: {k, s}            raw HTML text (already final)
//  para: {k, text}         paragraph (inline-parsed at render)
//  text: {k, text}         list-item text block (inline-parsed at render)
//  heading: {k, depth, text}
//  code: {k, lang, content}  content already renderer-normalised
//  hr: {k}
//  blockquote: {k, blocks}
//  list: {k, ordered, start, loose, items:[{task, checked, blocks}]}
//  table: {k, header:[{text,align}], rows:[[{text,align}]]}

// Parse blocks over lines[i, end) in `mode` ('top' | 'item').
// Returns {blocks, next, blankBetween} (blankBetween: a blank line fell
// between two blocks).
// Deepest text/para block reachable by following the last child of a
// blockquote or the last block of the last list item. Marked's
// blockquote tokenizer re-parses a trailing blockquote/list with the
// following lazy lines appended, so a lazy line merges into the
// innermost paragraph rather than becoming a sibling paragraph.
function deepestPara(b) {
  if (!b) return null;
  if (b.k === 'text' || b.k === 'para') return b;
  if (b.k === 'blockquote' && b.blocks.length) return deepestPara(b.blocks[b.blocks.length - 1]);
  if (b.k === 'list' && b.items.length) {
    const it = b.items[b.items.length - 1];
    if (it.blocks.length) return deepestPara(it.blocks[it.blocks.length - 1]);
  }
  return null;
}

// Innermost blockquote containing the deepest text/para (null when the
// deepest para is not inside a blockquote, e.g. inside a list item's
// plain paragraph). Used to continue a nested blockquote across groups.
function deepestQuote(b) {
  if (!b) return null;
  if (b.k === 'text' || b.k === 'para') return null;
  if (b.k === 'blockquote' && b.blocks.length) {
    const inner = deepestQuote(b.blocks[b.blocks.length - 1]);
    return inner || (deepestPara(b.blocks[b.blocks.length - 1]) ? b : null);
  }
  if (b.k === 'list' && b.items.length) {
    const it = b.items[b.items.length - 1];
    if (it.blocks.length) return deepestQuote(it.blocks[it.blocks.length - 1]);
  }
  return null;
}

// Deepest last block: descend through a trailing blockquote/list to
// the last block inside it. Used for the "group ends the quote"
// check: a group whose last token is a code block (etc.) ends the
// quote even when that token sits inside a nested blockquote — the
// top-level last block is then the quote itself, not the code block.
function deepestLast(b) {
  if (!b) return null;
  if (b.k === 'blockquote' && b.blocks.length) return deepestLast(b.blocks[b.blocks.length - 1]);
  if (b.k === 'list' && b.items.length) {
    const it = b.items[b.items.length - 1];
    if (it.blocks.length) return deepestLast(it.blocks[it.blocks.length - 1]);
  }
  return b;
}

function parseBlocks(ctx, st, lines, i, end, mode, carry) {
  // `mode` is only the STARTING value of marked's state.top: it is
  // mutable. Marked's Lexer.blockTokens always returns with state.top
  // true, and its list tokenizer sets it false only while parsing one
  // item's content — so after a nested list inside an item, the rest of
  // that item parses as top-level (multi-line paragraph, no indent
  // break, tables interrupt). A blockquote instead saves and restores
  // it, so a blockquote never flips the caller's top.
  let top = (mode === 'top');
  const blocks = [];
  let blankBetween = false;
  let prevWasBlank = true;
  let prevBlock = null;
  // mergeValid: the previous token is a text/paragraph block that a
  // following def, indented-code or text block merges into (marked's
  // blockTokens merges those into the last paragraph/text token; a blank
  // line, any other block, or a *registered* def ends the merge window).
  let mergeValid = false;
  // mergeQuote: innermost blockquote (from the previous group) that a
  // blockquote parsed in this call continues, instead of starting a
  // new one. Consumed on first use.
  let carryQuote = carry ? carry.mergeQuote : null;
  if (carry) {
    prevBlock = carry.prevBlock || null;
    prevWasBlank = carry.prevWasBlank;
    mergeValid = !!carry.mergeValid;
  }
  const push = (b) => { blocks.push(b); prevBlock = b; mergeValid = (b.k === 'text' || b.k === 'para'); };

  while (i < end) {
    if (isBlank(lines[i])) { if (blocks.length) prevWasBlank = true; mergeValid = false; i++; continue; }
    if (prevWasBlank && blocks.length) blankBetween = true;
    const line = lines[i];
    const ind = indentCols(line);
    let handled = false;

    // --- fenced code
    if (ind <= 3) {
      const fm = FENCE_RE.exec(line);
      if (fm) {
        const fence = fm[1], ch = fence[0], info = fm[2];
        if (ch === '`' && info.includes('`')) { /* not a fence */ }
        else {
          let j = i + 1, close = -1;
          const closeRe = fenceCloseRe(ch, fence.length);
          while (j < end) {
            if (closeRe.test(lines[j])) { close = j; break; }
            j++;
          }
          const contentLines = close === -1 ? lines.slice(i + 1, end) : lines.slice(i + 1, close);
          let content = contentLines.join('\n');
          if (ch === '`' && ind > 0) {
            const wsRun = /^[ \t]+/.exec(line);
            const s = wsRun ? wsRun[0].length : 0;
            content = contentLines.map(l => {
              const m = /^[ \t]+/.exec(l);
              if (!m) return l;
              return l.slice(Math.min(m[0].length, s));
            }).join('\n');
          }
          const langRaw = unescapePunct(info.trim());
          const lang = langRaw ? (/^\S*/.exec(langRaw)[0]) : '';
          const text = content ? content.replace(/\n$/, '') + '\n' : '';
          push({ k: 'code', lang, content: text });
          i = close === -1 ? end : close + 1;
          prevWasBlank = false;
          handled = true;
        }
      }
    }

    // --- indented code
    if (!handled && ind >= 4) {
      let k = i;
      while (k < end) {
        if (isBlank(lines[k])) {
          // include only if a later indented line follows
          let q = k + 1, ok = false;
          while (q < end) {
            if (isBlank(lines[q])) { q++; continue; }
            if (indentCols(lines[q]) >= 4) ok = true;
            break;
          }
          if (!ok) break;
          k++;
        } else if (indentCols(lines[k]) >= 4) k++;
        else break;
      }
      const raw = rangeText(lines, i, k);
      // Marked's code regex also consumes the blank lines after the
      // code (its trailing group is just a newline when a non-blank
      // line follows, and blank lines after that); ge() strips them
      // exactly when they are there. Include them in `raw` so ge()
      // trims the same way: a code block followed by a blank line
      // merges without a trailing newline, one followed by a
      // non-blank line keeps it. `i` still advances only to k — the
      // blank lines are processed by the loop (space handling).
      let k2 = k;
      while (k2 < end && isBlank(lines[k2])) k2++;
      const rawGe = k2 > k ? rangeText(lines, i, k2) : raw;
      const ge = trimTrailingBlanks(rawGe);
      const content = ge.replace(/^(?: {0,3}\t| {1,4})/gm, '');
      const text = content ? content.replace(/\n$/, '') + '\n' : '';
      const codeBlock = { k: 'code', lang: '', content: text, tokenText: content };
      if (mergeValid && prevBlock && (prevBlock.k === 'text' || prevBlock.k === 'para')) {
        prevBlock.text += '\n' + content;
      } else {
        push(codeBlock);
      }
      i = k;
      prevWasBlank = false;
      handled = true;
    }

    // --- ATX heading
    if (!handled && ind <= 3) {
      const hm = ATX_RE.exec(line);
      if (hm) {
        let text = hm[2].trim();
        if (/#$/.test(text)) {
          const stripped = text.replace(/#+$/, '');
          if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
        }
        push({ k: 'heading', depth: hm[1].length, text });
        i++;
        prevWasBlank = false;
        handled = true;
      }
    }

    // --- thematic break
    if (!handled && ind <= 3 && HR_RE.test(line)) {
      push({ k: 'hr' });
      i++;
      prevWasBlank = false;
      handled = true;
    }

    // --- blockquote
    if (!handled && ind <= 3 && stripBlockquotePrefix(line) !== null) {
      // Marked's blockquote tokenizer, interleaved: collect one group
      // (lazy lines, then `>` lines), parse it, and only then decide
      // whether the quote continues. A group whose last token is a
      // code block, heading, hr, HTML block or table ENDS the quote:
      // the following lazy line is a paragraph outside it and the
      // next `>` line starts a new quote. A group ending in a
      // paragraph/text continues into the next group.
      let innerBlocks = [];
      let gcarry = (carry && carryQuote && blocks.length === 0) ? { prevBlock: carry.prevBlock, prevWasBlank: carry.prevWasBlank, mergeValid: carry.mergeValid, mergeQuote: null } : null;
      let j = i;
      let inPara = false; // persists across groups: a lazy line at the
      // start of a group continues the previous group's paragraph.
      let hitBlank = false;
      while (j < end && !hitBlank) {
        const g = [];
        let seenQuote = false, groupEnded = false;
        while (j < end) {
          const stripped = stripBlockquotePrefix(lines[j]);
          if (stripped !== null) {
            g.push(stripped);
            seenQuote = true;
            inPara = stripped.trim() !== '';
            j++;
            continue;
          }
          if (isBlank(lines[j])) { hitBlank = true; groupEnded = true; break; }
          // A lazy line must not start a list: marked's blockquote-rule
          // paragraph excludes ANY list marker from its continuation
          // (any start number, either delimiter, even a bare marker at
          // end of line) — unlike the normal paragraph regex, which
          // only lets `1.` interrupt. A list-starting lazy line ends
          // the quote instead of continuing it.
          if (inPara && !isInterruptingStart(lines[j]) && !LAZY_LIST_RE.test(lines[j])) {
            if (lines[j].trim() === '' && !(j === end - 1 && indentCols(lines[j]) < 4)) { groupEnded = true; break; }
            if (seenQuote) { groupEnded = true; break; }
            // A lazy line at the start of this group continues the
            // previous group's paragraph. It is kept as-is: a line
            // indented 4+ is parsed as an indented code block and
            // merged into the paragraph (which strips the indent).
            const lazy = lines[j];
            // A setext underline inside a group (not its first line)
            // is converted to indented text instead of a heading.
            if (SETEXT_RE.test(lines[j]) && g.length > 0) g.push('    ' + lines[j].replace(/^ {0,3}/, ''));
            else g.push(lazy);
            inPara = true;
            j++;
            continue;
          }
          groupEnded = true;
          break;
        }
        if (g.length === 0) break;
        const inner = parseBlocks(ctx, st, g, 0, g.length, 'top', gcarry);
        innerBlocks = innerBlocks.concat(inner.blocks);
        // The next group's lazy lines merge into the deepest paragraph
        // of the last block (a trailing blockquote/list), if it has one.
        const deep = deepestPara(inner.prevBlock);
        gcarry = { prevBlock: deep || inner.prevBlock, prevWasBlank: false, mergeValid: !!deep, mergeQuote: deepestQuote(inner.prevBlock) };
        if (hitBlank) break;
        const last = deepestLast(innerBlocks[innerBlocks.length - 1]);
        if (last && (last.k === 'code' || last.k === 'heading' || last.k === 'hr' || last.k === 'html' || last.k === 'table')) break;
        if (!groupEnded) break;
      }
      if (carryQuote && blocks.length === 0) {
        // Continue the previous group's nested blockquote instead of
        // starting a new one (marked's blockquote re-parse).
        carryQuote.blocks = carryQuote.blocks.concat(innerBlocks);
        prevBlock = carryQuote;
        mergeValid = false;
        carryQuote = null;
      } else {
        push({ k: 'blockquote', blocks: innerBlocks });
      }
      i = j;
      prevWasBlank = false;
      handled = true;
    }

    // --- list
    if (!handled && ind <= 3) {
      const lst = parseList(ctx, st, lines, i, end);
      if (lst) {
        push(lst.node);
        i = lst.next;
        // A list whose last consumed line is blank leaves a blank line
        // between it and the next block (looseness signal).
        prevWasBlank = (i < end && i > 0 && isBlank(lines[i - 1]));
        // Marked's blockTokens returns with state.top true, so a list
        // flips the caller's top back on for the blocks that follow.
        top = true;
        handled = true;
      }
    }

    // --- HTML block
    if (!handled && ind <= 3 && (HTML16_START.test(line) || HTML7_START.test(line))) {
      const hb = parseHtmlBlock(lines, i, end);
      if (hb) {
        push({ k: 'html', s: hb.text });
        i = hb.next;
        prevWasBlank = false;
        handled = true;
      }
    }

    // --- link reference definition (only when the line can start one:
    // up to 3 spaces then '['; parseDef joins the remaining lines, so
    // this guard keeps it off the hot path for ordinary lines)
    if (!handled && ind <= 3) {
      let p = 0; while (p < line.length && line[p] === ' ') p++;
      if (p <= 3 && line[p] === '[') {
      const def = parseDef(ctx, lines, i);
      if (def) {
        if (mergeValid && prevBlock && (prevBlock.k === 'text' || prevBlock.k === 'para')) {
          prevBlock.text += '\n' + def.raw;
        } else {
          mergeValid = false;
        }
        i = def.next;
        // A def whose regex consumed trailing blank lines leaves them
        // between the previous block and the next one.
        prevWasBlank = (i < end && i > 0 && isBlank(lines[i - 1]));
        handled = true;
      }
      }
    }

    // --- table
    if (!handled) {
      const ts = tableStart(lines, i);
      if (ts) {
        const rows = [];
        let j = i + 2;
        while (j < end) {
          // A table row ends at a blank line — but only a line of
          // spaces (or empty). A line containing a tab is a row of
          // empty cells (marked's table regex excludes only ` *\n`).
          if (/^ *$/.test(lines[j])) break;
          if (ROW_STOP.test(lines[j])) break;
          rows.push(splitCells(lines[j], ts.header.length));
          j++;
        }
        push({
          k: 'table',
          header: ts.header.map((t, x) => ({ text: t, align: ts.align[x] })),
          rows: rows.map(r => r.map((t, x) => ({ text: t, align: ts.align[x] }))),
        });
        i = j;
        prevWasBlank = false;
        handled = true;
      }
    }

    // --- paragraph / text block
    if (!handled) {
      let text = line;
      let j = i + 1;
      let heading = null;
      while (j < end) {
        const ln = lines[j];
        // A whitespace-only line ends the paragraph, unless it is the
        // last line of the chunk (marked's paragraph regex keeps a
        // trailing whitespace-only line: `[ \t]+\n` excludes it only
        // when a newline follows it) and indented under 4. In item
        // mode marked uses the single-line `text` tokenizer instead,
        // so a trailing whitespace-only line is a separate space
        // token and never joins the text block.
        if (isBlank(ln)) {
          if (top && ln !== '' && j === end - 1 && indentCols(ln) < 4) { text += '\n' + ln; j++; }
          break;
        }
        if (SETEXT_RE.test(ln)) {
          heading = { k: 'heading', depth: ln.trim()[0] === '=' ? 1 : 2, text: text.trim() };
          j++;
          break;
        }
        if (isInterruptingStart(ln, !top)) break;
        // A table interrupts a paragraph in item mode too: marked's
        // top-level paragraph regex excludes `table` unconditionally,
        // and inside a list the table tokenizer is tried before the
        // single-line text tokenizer on every line. (Was `top &&` —
        // tables inside list items were swallowed by the paragraph.)
        // Use the loose (regex-level) test: the paragraph stops even
        // when the table is then rejected for a cell-count mismatch.
        if (tableStartLoose(lines, j)) break;
        if (!top && indentCols(ln) >= 4) break;
        text += '\n' + ln;
        j++;
      }
      if (heading) {
        push(heading);
      } else if (mergeValid && prevBlock && (prevBlock.k === 'text' || (prevBlock.k === 'para' && blocks.length === 0))) {
        // A paragraph/text block that directly follows another one
        // merges into it (marked's blockTokens paragraph merge, which
        // is how lazy blockquote lines join the previous paragraph).
        // But a top-level paragraph never merges into a paragraph
        // pushed in this same call: marked merges consecutive
        // paragraphs only when `n` (an extension truncated the input),
        // which is false by default — two paragraphs separated only by
        // a rejected table stay two paragraphs. The blocks.length===0
        // case is the carry: a lazy blockquote line continuing the
        // previous group's paragraph across parseBlocks calls.
        prevBlock.text += '\n' + text;
      } else {
        push(!top ? { k: 'text', text } : { k: 'para', text });
      }
      i = j;
      prevWasBlank = false;
    }
  }
  return { blocks, next: i, blankBetween, prevBlock, prevWasBlank, mergeValid };
}

// ------------------------------------------------------- html block / def

// Cache of </tag> enders for script/pre/style/textarea HTML blocks.
const HTML_END_RES = {};
// Parse an HTML block starting at lines[i]. Returns {text, next} or null.
function parseHtmlBlock(lines, i, end) {
  const line = lines[i];
  const m1 = /^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(line);
  const m2 = /^ {0,3}<!--/.exec(line);
  const m3 = /^ {0,3}<\?/.exec(line);
  const m4 = /^ {0,3}<![A-Za-z]/.exec(line);
  const m5 = /^ {0,3}<!\[CDATA\[/.exec(line);
  let k = i + 1, ender = null;
  if (m1) ender = HTML_END_RES[m1[1].toLowerCase()] || (HTML_END_RES[m1[1].toLowerCase()] = new RegExp(`</${m1[1]}>`, 'i'));
  else if (m2) ender = /-->/;
  else if (m3) ender = /\?>/;
  else if (m4) ender = />/;
  else if (m5) ender = /\]\]>/;
  if (ender) {
    if (ender.test(line)) { k = i + 1; }
    else {
      while (k < end && !ender.test(lines[k])) k++;
      if (k < end) k++; // include the terminator line
    }
  } else {
    // Types 6 and 7: run until a blank line.
    while (k < end && !isBlank(lines[k])) k++;
  }
  // Include following empty lines in the raw, then trim them back.
  // Marked's html regex ends the block with `(\n+|$)`: only truly
  // empty lines belong to the raw. A line of spaces/tabs is not part
  // of the block (it is a separate blank line after it).
  let e = k;
  if (ender) {
    while (e < end && lines[e] === '') e++;
  } else {
    while (e < end && isBlank(lines[e])) e++;
  }
  const raw = rangeText(lines, i, e);
  // Marked's html tokenizer returns ge(t[0]) as the raw, so blockTokens
  // advances only past the ge-stripped length: the trailing blank lines
  // are NOT consumed by the html block — they become a space token,
  // which is the list-looseness signal (a blank line after an html
  // block inside an item makes the list loose). Return next: k, not e.
  return { text: trimTrailingBlanks(raw), next: k };
}

// Parse a link reference definition at lines[i]. Returns {raw, next} or null.
// A definition's content spans at most 3 lines in the practice set
// (label, destination, title) and the generator emits one-line defs,
// so try a 16-line window first; if the match runs to the window's end
// it may continue past it, and the full join decides instead.
function parseDef(ctx, lines, i) {
  const W = 16;
  const last = Math.min(lines.length, i + W);
  let rest = lines.slice(i, last).join('\n');
  let m = DEF_RE.exec(rest);
  if (m && m[0].length >= rest.length && last < lines.length) {
    rest = lines.slice(i).join('\n');
    m = DEF_RE.exec(rest);
  }
  if (!m) return null;
  const dest = m[2];
  if (!dest.startsWith('<')) {
    // ke(): balanced parens required, no unmatched ')'.
    let depth = 0, ok = true;
    for (let p = 0; p < dest.length; p++) {
      const c = dest[p];
      if (c === '\\') { p++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth < 0) { ok = false; break; } }
    }
    if (!ok || depth > 0) return null;
  }
  const href = dest.startsWith('<') ? unescapePunct(dest.slice(1, -1)) : unescapePunct(dest);
  let title = null;
  if (m[3] !== undefined) {
    const t = m[3];
    title = unescapePunct(t.slice(1, -1));
  }
  const label = normalizeLabel(m[1]);
  if (!ctx.refs.has(label)) ctx.refs.set(label, { href, title });
  const nl = (m[0].match(/\n/g) || []).length;
  const next = m[0].endsWith('\n') ? i + nl : i + nl + 1;
  return { raw: m[0], next: Math.min(next, lines.length) };
}

// ------------------------------------------------------------------ list

function clampIndent(r) { return Math.max(0, Math.min(3, r - 1)); }

// Memoized: clampIndent maps R to 0..3, so only four sets exist.
const LIST_BREAK_TESTS_CACHE = [null, null, null, null];
function listBreakTests(R) {
  const a = clampIndent(R);
  const cached = LIST_BREAK_TESTS_CACHE[a];
  if (cached) return cached;
  const fenceSrc = '(?:```|~~~)';
  const headingSrc = '#{1,6}(?:\\s|$)';
  const htmlSrc = `(?:</?(?:${BLOCK_TAG_ALT})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
  const bqSrc = '>';
  const bulletSrc = '(?:[*+-]|\\d{1,9}[.)])(?:[ \\t][^\\n]*)?$';
  const hrSrc = '((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})[ \\t]*$';
  const t = {
    fence: new RegExp(`^ {0,${a}}${fenceSrc}`),
    heading: new RegExp(`^ {0,${a}}${headingSrc}`),
    html: new RegExp(`^ {0,${a}}${htmlSrc}`, 'i'),
    blockquote: new RegExp(`^ {0,${a}}${bqSrc}`),
    bullet: new RegExp(`^ {0,${a}}${bulletSrc}`),
    hr: new RegExp(`^ {0,${a}}${hrSrc}`),
    // One test instead of six per line (the 'i' flag is harmless: the
    // non-HTML branches hold no letters).
    any: new RegExp(`^ {0,${a}}(?:${fenceSrc}|${headingSrc}|${htmlSrc}|${bqSrc}|${bulletSrc}|${hrSrc})`, 'i'),
    // Same, without blockquote/bullet (for the mCur continuation test).
    anyShort: new RegExp(`^ {0,${a}}(?:${fenceSrc}|${headingSrc}|${htmlSrc}|${hrSrc})`, 'i'),
  };
  LIST_BREAK_TESTS_CACHE[a] = t;
  return t;
}

// Parse a list starting at lines[i]. Returns {node, next} or null.
function parseList(ctx, st, lines, i, end) {
  const first = lines[i];
  const mm = /^ {0,3}((?:[*+-]|\d{1,9}[.)]))/.exec(first);
  if (!mm) return null;
  const marker = mm[1];
  const after = first.slice(mm[0].length);
  if (after !== '' && after[0] !== ' ' && after[0] !== '\t') return null;
  const ordered = marker.length > 1;
  const bulletChar = ordered ? null : marker.trim();
  const delimChar = ordered ? marker[marker.length - 1] : null;
  const startNum = ordered ? parseInt(marker.trim().slice(0, -1), 10) : 0;
  const itemRe = ordered
    ? new RegExp(`^( {0,3}\\d{1,9}\\${delimChar})((?:[ \\t][^\\n]*)?)$`)
    : new RegExp(`^( {0,3}\\${bulletChar})((?:[ \\t][^\\n]*)?)$`);
  const items = [];
  let j = i;
  let loose = false;
  let prevEndsBlank = false;
  while (j < end) {
    const t = itemRe.exec(lines[j]);
    if (!t) break;
    if (HR_RE.test(lines[j])) break;
    const itemStart = j;
    const b = t[1].length;
    const g = t[2];
    const mExp = expandLeadingWs(g, b);
    let y = !mExp.trim();
    let R, d;
    if (y) { R = b + 1; d = ''; }
    else {
      R = mExp.search(/[^ ]/);
      if (R === -1) R = mExp.length;
      if (R > 4) R = 1;
      d = mExp.slice(R);
      R += b;
    }
    j++;
    let emptyItem = false;
    if (y && j < end && isBlank(lines[j])) { j++; emptyItem = true; }
    let mCur = mExp;
    if (!emptyItem) {
      const tests = listBreakTests(R);
      while (j < end) {
        const U = lines[j];
        const Z = expandLeadingWs(U, 0);
        const isUBlank = U.trim() === '';
        if (tests.any.test(U)) break;
        if (Z.search(/[^ ]/) >= R || isUBlank) {
          d += '\n' + Z.slice(R);
        } else {
          const mNoTab = mCur.includes('\t') ? mCur.replace(/\t/g, '    ') : mCur;
          if (y || mNoTab.search(/[^ ]/) >= 4 ||
              tests.anyShort.test(mCur)) break;
          let qe = U;
          if (/^ {0,3}(?:=+|-+) *$/.test(U)) {
            // setext-pair check: previous content line + this line form a
            // setext heading (single-line text, no block start)
            const prev = mCur;
            if (prev.trim() !== '' && !startsAnyBlock(prev)) {
              qe = '    ' + Z.replace(/^ {0,3}/, '');
            }
          }
          d += '\n' + qe;
        }
        const wasBlank = isUBlank;
        mCur = Z.slice(R);
        j++;
        if (wasBlank) { /* y for next iteration */ }
        y = wasBlank;
      }
    }
    // Item text: trim trailing whitespace (last item only in marked).
    const isLast = j >= end || !itemRe.test(lines[j]);
    const text = isLast ? d.replace(/[ \t\n]+$/, '') : d;
    // The item's raw ends with a blank line when its last consumed line
    // is blank (the looseness signal for the following item).
    const endsBlank = j > itemStart && isBlank(lines[j - 1]);
    items.push({ text, endsBlank, startLine: itemStart });
    if (prevEndsBlank) loose = true;
    prevEndsBlank = endsBlank && !isLast;
    if (isLast) break;
  }
  if (items.length === 0) return null;
  // Parse each item's content blocks (item mode) and detect looseness.
  const parsed = items.map(it => {
    const sub = it.text === '' ? [] : it.text.split('\n');
    const res = parseBlocks(ctx, st, sub, 0, sub.length, 'item');
    return { ...it, blocks: res.blocks, blankBetween: res.blankBetween };
  });
  for (const it of parsed) if (it.blankBetween) loose = true;
  // Task checkboxes and loose conversion.
  const outItems = parsed.map(it => {
    let task = false, checked = false;
    if (/^\[[ xX]\][ \t]+\S/.test(it.text)) {
      task = true;
      checked = it.text[1] !== ' ';
    }
    return { task, checked, blocks: it.blocks, text: it.text };
  });
  for (const it of outItems) {
    if (it.task) {
      const firstBlock = it.blocks[0];
      if (firstBlock && (firstBlock.k === 'text' || firstBlock.k === 'para')) {
        firstBlock.text = firstBlock.text.replace(/^\[[ xX]\][ \t]+/, '');
        it.checkbox = { checked: it.checked };
      } else {
        it.task = false;
        it.checkbox = null;
      }
    }
  }
  if (loose) for (const it of outItems) for (const b of it.blocks) if (b.k === 'text') b.k = 'para';
  return {
    node: { k: 'list', ordered, start: startNum, loose, items: outItems },
    next: j,
  };
}

// ----------------------------------------------------------------- render

function renderBlocks(blocks, ctx, st) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, ctx, st);
  return out;
}

function renderBlock(b, ctx, st) {
  switch (b.k) {
    case 'html': return b.s;
    case 'hr': return '<hr>\n';
    case 'para': return '<p>' + inlineToHtml(b.text, ctx, st) + '</p>\n';
    case 'text': return inlineToHtml(b.text, ctx, st);
    case 'heading': return `<h${b.depth}>` + inlineToHtml(b.text, ctx, st) + `</h${b.depth}>\n`;
    case 'code': {
      const body = escapeHtml(b.content, true);
      return b.lang
        ? `<pre><code class="language-${escapeHtml(b.lang, false)}">${body}</code></pre>\n`
        : `<pre><code>${body}</code></pre>\n`;
    }
    case 'blockquote': return '<blockquote>\n' + renderBlocks(b.blocks, ctx, st) + '</blockquote>\n';
    case 'table': {
      let head = '';
      for (const c of b.header) {
        head += c.align ? `<th align="${c.align}">` : '<th>';
        head += inlineToHtml(c.text, ctx, st) + '</th>\n';
      }
      let out = '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
      if (b.rows.length) {
        let rows = '';
        for (const row of b.rows) {
          let cells = '';
          for (const c of row) {
            cells += c.align ? `<td align="${c.align}">` : '<td>';
            cells += inlineToHtml(c.text, ctx, st) + '</td>\n';
          }
          rows += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<tbody>' + rows + '</tbody>';
      }
      return out + '</table>\n';
    }
    case 'list': {
      let items = '';
      for (const it of b.items) {
        let inner;
        const box = it.checkbox
          ? '<input ' + (it.checkbox.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
          : '';
        if (box && b.loose && it.blocks[0] && it.blocks[0].k === 'para') {
          // Loose list: the checkbox lives inside the first paragraph.
          inner = '<p>' + box + inlineToHtml(it.blocks[0].text, ctx, st) + '</p>\n' +
            renderBlocks(it.blocks.slice(1), ctx, st);
        } else {
          inner = box + renderBlocks(it.blocks, ctx, st);
        }
        items += '<li>' + inner + '</li>\n';
      }
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      return `<${tag}${start}>\n` + items + `</${tag}>\n`;
    }
    default: return '';
  }
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const ctx = { refs: new Map() };
  const st = { inLink: false, inRawBlock: false };
  const { blocks } = parseBlocks(ctx, st, lines, 0, lines.length, 'top');
  return renderBlocks(blocks, ctx, st);
}
