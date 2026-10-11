// Minimal syntax highlighting for the Scenario code viewer: TS (also js/cjs/mjs), JSON, YAML and Markdown.
// Pure functions, no DOM: tokenize(lang, text) → one array per line of [type, text] pairs. Types:
//   kw  keyword / literal      str  string      com  comment     num  number     key  object/YAML key
//   type  capitalised identifier   head  markdown heading   code  code span / fenced code   link  link   strong  bold
// An empty type ("") is plain text. Adjacent tokens of one type are merged. Concatenating a line's tokens always
// gives back the original line (the tests check it).

const TS_KW = new Set(("abstract as async await break case catch class const continue debugger declare default delete do else enum " +
  "export extends false finally for from function get if implements import in instanceof interface is keyof let namespace new " +
  "null of override private protected public readonly return satisfies set static super switch this throw true try type typeof " +
  "undefined var void while with yield").split(" "));
const TS_BUILTIN = new Set("string number boolean unknown never any object symbol bigint".split(" "));

function push(out, type, text) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last[0] === type) last[1] += text;
  else out.push([type, text]);
}

// ------------------------------------------------------------------ TypeScript / JavaScript

function tsLine(line, st) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (st.block) {
      const j = line.indexOf("*/", i);
      if (j < 0) { push(out, "com", line.slice(i)); return out; }
      push(out, "com", line.slice(i, j + 2)); i = j + 2; st.block = false; continue;
    }
    if (st.tmpl) {
      let j = i;
      while (j < n && line[j] !== "`") j += line[j] === "\\" ? 2 : 1;
      if (j >= n) { push(out, "str", line.slice(i)); return out; }
      push(out, "str", line.slice(i, j + 1)); i = j + 1; st.tmpl = false; continue;
    }
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") { push(out, "com", line.slice(i)); return out; }
    if (c === "/" && line[i + 1] === "*") { st.block = true; push(out, "com", "/*"); i += 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      push(out, "str", line.slice(i, Math.min(j + 1, n))); i = Math.min(j + 1, n); continue;
    }
    if (c === "`") { st.tmpl = true; push(out, "str", "`"); i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(line[i + 1] || ""))) {
      const m = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?|\.[0-9_]+)n?/.exec(line.slice(i));
      push(out, "num", m[0]); i += m[0].length; continue;
    }
    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^@?[A-Za-z_$][\w$]*/.exec(line.slice(i));
      if (!m) { push(out, "", c); i++; continue; }
      const w = m[0];
      const prev = out.length ? out[out.length - 1][1].trimEnd().slice(-1) : "";
      let t = "";
      if (TS_KW.has(w) && prev !== ".") t = "kw";
      else if (TS_BUILTIN.has(w)) t = "type";
      else if (/^[A-Z]/.test(w)) t = "type";
      push(out, t, w); i += w.length; continue;
    }
    push(out, "", c); i++;
  }
  return out;
}

// ------------------------------------------------------------------ JSON

function jsonLine(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, n);
      const isKey = /^\s*:/.test(line.slice(end));
      push(out, isKey ? "key" : "str", line.slice(i, end)); i = end; continue;
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line.slice(i));
    if (m && !/[\w]/.test(line[i - 1] || "")) { push(out, "num", m[0]); i += m[0].length; continue; }
    const w = /^(true|false|null)\b/.exec(line.slice(i));
    if (w) { push(out, "kw", w[0]); i += w[0].length; continue; }
    push(out, "", c); i++;
  }
  return out;
}

// ------------------------------------------------------------------ YAML (the subset used by the catalog)

function yamlValue(s, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) { push(out, "com", s.slice(i)); return; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && s[j] !== c) j += s[j] === "\\" && c === '"' ? 2 : 1;
      const end = Math.min(j + 1, n);
      // a quoted flow-mapping key (`{ "a": 1 }`) is a key too
      push(out, /^\s*:(\s|$)/.test(s.slice(end)) ? "key" : "str", s.slice(i, end)); i = end; continue;
    }
    const kv = /^([A-Za-z_][\w.-]*)(\s*:)(?=\s|$)/.exec(s.slice(i));
    if (kv && /[\s{[,]/.test(s[i - 1] || " ")) { push(out, "key", kv[1]); push(out, "", kv[2]); i += kv[0].length; continue; }
    const w = /^(true|false|null|~)(?=[\s,\]}]|$)/.exec(s.slice(i));
    if (w && /[\s{[,:]/.test(s[i - 1] || " ")) { push(out, "kw", w[0]); i += w[0].length; continue; }
    const num = /^-?\d+(?:\.\d+)?(?=[\s,\]}]|$)/.exec(s.slice(i));
    if (num && /[\s{[,:]/.test(s[i - 1] || " ")) { push(out, "num", num[0]); i += num[0].length; continue; }
    push(out, "", c); i++;
  }
}

function yamlLine(line) {
  const out = [];
  const m = /^(\s*(?:-\s+)*)(.*)$/.exec(line);
  push(out, "", m[1]);
  const rest = m[2];
  const k = /^([^\s:#'"{[][^:#]*?)(\s*:)(?=\s|$)(.*)$/.exec(rest);
  if (k) {
    push(out, "key", k[1]); push(out, "", k[2]); yamlValue(k[3], out);
  } else yamlValue(rest, out);
  return out;
}

// ------------------------------------------------------------------ Markdown

function mdInline(s, out) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]*\))|(<!--.*?-->)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    push(out, "", s.slice(last, m.index));
    push(out, m[1] ? "code" : m[2] ? "strong" : m[3] ? "link" : "com", m[0]);
    last = m.index + m[0].length;
  }
  push(out, "", s.slice(last));
}

function mdLine(line, st) {
  const out = [];
  if (/^\s*```/.test(line)) { st.fence = !st.fence; push(out, "com", line); return out; }
  if (st.fence) { push(out, "code", line); return out; }
  if (/^<!--/.test(line.trim()) && /-->\s*$/.test(line)) { push(out, "com", line); return out; }
  if (/^#{1,6}\s/.test(line)) { push(out, "head", line); return out; }
  const bullet = /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/.exec(line);
  if (bullet) { push(out, "kw", bullet[1]); mdInline(bullet[2], out); return out; }
  if (/^\s*\|/.test(line)) {
    line.split(/(\|)/).forEach((part) => (part === "|" ? push(out, "kw", part) : mdInline(part, out)));
    return out;
  }
  mdInline(line, out);
  return out;
}

// ------------------------------------------------------------------ entry point

export function tokenize(lang, text) {
  const lines = String(text).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const st = { block: false, tmpl: false, fence: false };
  return lines.map((line) => {
    if (lang === "ts") return tsLine(line, st);
    if (lang === "json") return jsonLine(line);
    if (lang === "yaml") return yamlLine(line);
    if (lang === "md") return mdLine(line, st);
    return line ? [["", line]] : [];
  });
}
