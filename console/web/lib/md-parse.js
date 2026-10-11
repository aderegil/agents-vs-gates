// Markdown → plain tree. Pure functions, no DOM (rendering is in markdown.js), so node --test can cover it.
// CommonMark/GFM subset that the repo's files use: ATX and setext headings, paragraphs, fenced code, block quotes,
// nested bullet/ordered/task lists, GFM tables, thematic breaks; inline code, **strong**, *em*, ~~del~~, links,
// images (kept as their alt text), autolinks and bare URLs, hard breaks. HTML comment blocks are dropped; any other raw
// HTML is never interpreted: it stays text.
//
// Blocks:  {t:"h", level, c} {t:"p", c} {t:"code", lang, text} {t:"quote", c:[blocks]} {t:"hr"}
//          {t:"list", ordered, start, items:[{task: null|true|false, c:[blocks]}]} {t:"table", align, head:[c], rows:[[c]]}
// Inline:  string | {t:"code", text} | {t:"strong"|"em"|"del", c} | {t:"link", href, c} | {t:"img", alt, src} | {t:"br"}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

const detab = (line) => line.replace(/^\t+/, (m) => "    ".repeat(m.length));
const indentOf = (line) => line.match(/^ */)[0].length;
const blank = (line) => !line.trim();

export function parseMarkdown(text) {
  return parseBlocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map(detab));
}

function isTableStart(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes("-")
    && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || isTableStart(lines, i);
}

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    let m;
    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const ind = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence) && /^[`~]+$/.test(lines[i].trim())
        && lines[i].trim()[0] === fence[0] && lines[i].trim().length >= fence.length)) {
        body.push(lines[i].slice(Math.min(ind, indentOf(lines[i]))));
        i++;
      }
      i++; // closing fence (or end of text)
      out.push({ t: "code", lang: m[2].toLowerCase(), text: body.join("\n") });
      continue;
    }
    if ((m = line.match(HEADING))) {
      out.push({ t: "h", level: m[1].length, c: parseInline(m[2] || "") });
      i++;
      continue;
    }
    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (isTableStart(lines, i)) {
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const head = splitRow(lines[i]).map(parseInline);
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(align.map((_, k) => parseInline(cells[k] ?? "")));
        i++;
      }
      out.push({ t: "table", align, head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(lines[i].replace(QUOTE, "")); i++; }
      out.push({ t: "quote", c: parseBlocks(body) });
      continue;
    }
    if (ITEM.test(line)) {
      i = parseList(lines, i, out);
      continue;
    }
    if (/^ {0,3}<!--/.test(line)) { // HTML comments are invisible, as on GitHub (the repo's canary lines are comments)
      while (i < lines.length && !lines[i].includes("-->")) i++;
      i++;
      continue;
    }
    // paragraph (setext heading when underlined)
    const para = [line.trim()];
    i++;
    let level = 0;
    while (i < lines.length && !blank(lines[i])) {
      const s = lines[i].match(SETEXT);
      if (s) { level = s[1][0] === "=" ? 1 : 2; i++; break; }
      if (startsBlock(lines, i)) break;
      para.push(lines[i].replace(/^ +/, ""));
      i++;
    }
    const c = parseInline(para.join("\n"));
    out.push(level ? { t: "h", level, c } : { t: "p", c });
  }
  return out;
}

function parseList(lines, i, out) {
  const first = lines[i].match(ITEM);
  const ind = first[1].length;
  const ordered = /\d/.test(first[2]);
  const delim = first[2].slice(-1);
  const list = { t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    if (!m || m[1].length !== ind || /\d/.test(m[2]) !== ordered || m[2].slice(-1) !== delim) break;
    const contentCol = ind + m[2].length + Math.min(Math.max(m[3].length, 1), 4);
    const body = [m[4]];
    i++;
    let prevBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) { body.push(""); prevBlank = true; i++; continue; }
      const li = indentOf(l);
      const sub = l.match(ITEM);
      if (li >= contentCol || (sub && li > ind)) { body.push(l.slice(Math.min(li, contentCol))); prevBlank = false; i++; continue; }
      if (!prevBlank && !sub && !startsBlock(lines, i)) { body.push(l.trim()); i++; continue; } // lazy continuation
      break;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    let task = null;
    const tm = body[0].match(/^\[([ xX])\][ \t]+/);
    if (tm) { task = tm[1] !== " "; body[0] = body[0].slice(tm[0].length); }
    list.items.push({ task, c: parseBlocks(body) });
    // a blank line followed by something that is not the next item ends the list
    if (i < lines.length && blank(lines[i - 1] ?? "x")) {
      const nm = lines[i].match(ITEM);
      if (!nm || nm[1].length !== ind) break;
    }
  }
  out.push(list);
  return i;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let code = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (ch === "`") code ^= 1;
    if (ch === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// ------------------------------------------------------------------ inline

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const URL_RE = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/;

export function parseInline(src) {
  const out = [];
  let text = "";
  const flush = () => { if (text) { out.push(text); text = ""; } };
  const push = (node) => { flush(); out.push(node); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      if (src[i + 1] === "\n") { push({ t: "br" }); i += 2; continue; }
      if (PUNCT.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    }
    if (ch === "\n") {
      if (/ {2,}$/.test(text)) { text = text.replace(/ +$/, ""); push({ t: "br" }); } else { text = text.replace(/ +$/, ""); text += "\n"; }
      i++;
      continue;
    }
    if (ch === "`") {
      const run = src.slice(i).match(/^`+/)[0];
      let j = i + run.length;
      let end = -1;
      while ((j = src.indexOf(run, j)) !== -1) {
        if (src[j + run.length] !== "`" && src[j - 1] !== "`") { end = j; break; }
        j += run.length;
      }
      if (end !== -1) {
        let code = src.slice(i + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        push({ t: "code", text: code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === "<") {
      const m = src.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i);
      if (m) { push({ t: "link", href: m[1], c: [m[1].replace(/^mailto:/i, "")] }); i += m[0].length; continue; }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(*_~]/.test(src[i - 1]))) {
      const m = src.slice(i).match(URL_RE);
      if (m) { push({ t: "link", href: m[0], c: [m[0]] }); i += m[0].length; continue; }
    }
    if (ch === "!" && src[i + 1] === "[") {
      const l = linkAt(src, i + 1);
      if (l) { push({ t: "img", alt: plain(parseInline(l.label)), src: l.href }); i = l.end; continue; }
    }
    if (ch === "[") {
      const l = linkAt(src, i);
      if (l) { push({ t: "link", href: l.href, c: parseInline(l.label) }); i = l.end; continue; }
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const em = emphasisAt(src, i);
      if (em) { push(em.node); i = em.end; continue; }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function linkAt(src, i) {
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "`") { const k = src.indexOf("`", j + 1); if (k !== -1) j = k; continue; }
    if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) break;
  }
  if (j >= src.length || src[j + 1] !== "(") return null;
  let k = j + 2;
  let par = 1;
  for (; k < src.length; k++) {
    if (src[k] === "\\") { k++; continue; }
    if (src[k] === "(") par++;
    else if (src[k] === ")" && --par === 0) break;
  }
  if (k >= src.length) return null;
  const inner = src.slice(j + 2, k).trim();
  const m = inner.match(/^<([^>]*)>|^(\S*)/);
  const href = (m[1] ?? m[2] ?? "").trim();
  return { label: src.slice(i + 1, j), href, end: k + 1 };
}

function emphasisAt(src, i) {
  const ch = src[i];
  const run = src.slice(i).match(ch === "*" ? /^\*+/ : ch === "_" ? /^_+/ : /^~+/)[0];
  if (ch === "~" && run.length !== 2) return null;
  const n = ch === "~" ? 2 : Math.min(run.length, 3);
  const after = src[i + n];
  if (!after || /\s/.test(after)) return null;
  if (ch === "_" && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1])) return null; // intraword underscore
  const delim = ch.repeat(n);
  let j = i + n;
  while ((j = src.indexOf(delim, j)) !== -1) {
    const before = src[j - 1];
    const next = src[j + n];
    const okClose = before && !/\s/.test(before) && j > i + n
      && !(ch === "_" && next && /[\p{L}\p{N}]/u.test(next))
      && !(n === 1 && (next === ch || before === ch)); // a lone * must not close on half of a **
    if (okClose && !insideCode(src, i + n, j)) break;
    j += 1;
  }
  if (j === -1) return null;
  const inner = parseInline(src.slice(i + n, j));
  let node;
  if (ch === "~") node = { t: "del", c: inner };
  else if (n === 3) node = { t: "strong", c: [{ t: "em", c: inner }] };
  else node = { t: n === 2 ? "strong" : "em", c: inner };
  return { node, end: j + n };
}

function insideCode(src, from, to) {
  return (src.slice(from, to).match(/`/g) || []).length % 2 === 1;
}

/** Inline tree → plain text (alt text, titles). */
export function plain(nodes) {
  return nodes.map((n) => (typeof n === "string" ? n : n.t === "br" ? "\n" : n.text ?? n.alt ?? plain(n.c || []))).join("");
}
