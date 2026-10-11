// Markdown viewer for every plugin: a rendered Preview and the Code view, with one remembered choice.
//
// renderMarkdown(text, {highlight})  → <div class="md"> built with h() (never innerHTML, so file content is inert).
//    highlight(lang, code) → Node | null, optional, for fenced blocks (Scenario passes its tokenizer).
// mdViewSwitch()                     → "Preview | Code" segmented switch. Clicking it stores the choice for this
//                                      browser and tells every Markdown viewer on the page to follow.
// mdView()                           → the stored choice: "preview" (default) or "code".
// onMdView(node, fn)                 → calls fn(view) whenever the choice changes while node is in the page.
// markdownViewer({text | preview, code, highlight}) → Node that shows the Preview (renderMarkdown(text), or preview()
//                                      when the caller builds its own) or code(), by the stored choice, and follows it.
import { h } from "./ui.js";
import { parseMarkdown, plain } from "./md-parse.js";

const KEY = "avg.md.view";
const EVENT = "avg:md-view";

export function mdView() {
  try { return localStorage.getItem(KEY) === "code" ? "code" : "preview"; } catch { return "preview"; }
}

function setMdView(view) {
  try { localStorage.setItem(KEY, view); } catch { /* private window: the choice lasts until reload */ }
  memo = view;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: view }));
}

let memo = null;
const current = () => memo ?? (memo = mdView());

export function onMdView(node, fn) {
  const listener = (e) => {
    if (!node.isConnected) { window.removeEventListener(EVENT, listener); return; }
    fn(e.detail);
  };
  window.addEventListener(EVENT, listener);
}

export function mdViewSwitch() {
  const opts = [["preview", "Preview", "Rendered Markdown"], ["code", "Code", "Markdown source"]];
  const el = h("div", { class: "md-switch", role: "group", "aria-label": "Markdown view" });
  const draw = (view) => el.replaceChildren(...opts.map(([id, label, title]) => h("button", {
    type: "button", "aria-pressed": String(view === id), title,
    onclick: () => { if (current() !== id) setMdView(id); },
  }, label)));
  draw(current());
  onMdView(el, draw);
  return el;
}

export function markdownViewer({ text, preview: build, code, highlight } = {}) {
  const box = h("div", { class: "md-viewer" });
  let preview = null;
  let source = null;
  const draw = (view) => {
    if (view === "code") box.replaceChildren(source ??= code());
    else box.replaceChildren(preview ??= (build ? build() : renderMarkdown(text, { highlight })));
  };
  draw(current());
  onMdView(box, draw);
  return box;
}

const SAFE_HREF = /^(https?:|mailto:)/i;

export function renderMarkdown(text, { highlight } = {}) {
  return h("div", { class: "md" }, blocks(parseMarkdown(text), highlight));
}

function blocks(list, hl) {
  return list.map((b) => {
    switch (b.t) {
      case "h": return h(`h${b.level}`, {}, inline(b.c));
      case "p": return h("p", {}, inline(b.c));
      case "hr": return h("hr");
      case "quote": return h("blockquote", {}, blocks(b.c, hl));
      case "code": {
        const lit = hl && b.lang ? hl(b.lang, b.text) : null;
        return h("pre", { class: "md-code", "data-lang": b.lang || null }, h("code", {}, lit || b.text));
      }
      case "list": {
        const task = b.items.some((it) => it.task !== null);
        const items = b.items.map((it) => h("li", { class: it.task !== null ? "md-task" : null },
          it.task !== null ? h("input", { type: "checkbox", checked: it.task, disabled: true, "aria-label": it.task ? "done" : "not done" }) : null,
          blocks(it.c, hl)));
        return b.ordered
          ? h("ol", { start: b.start !== 1 ? b.start : null, class: task ? "md-tasks" : null }, items)
          : h("ul", { class: task ? "md-tasks" : null }, items);
      }
      case "table": {
        // short one-word cells (IDs like ARCH-1) never wrap at their hyphen
        const nw = (c) => { const s = plain(c); return s.length <= 16 && !/\s/.test(s) ? "md-nw" : null; };
        const cell = (tag, c, k) => h(tag, { class: nw(c), style: b.align[k] ? { textAlign: b.align[k] } : null }, inline(c));
        return h("div", { class: "md-table" }, h("table", {},
          h("thead", {}, h("tr", {}, b.head.map((c, k) => cell("th", c, k)))),
          h("tbody", {}, b.rows.map((r) => h("tr", {}, r.map((c, k) => cell("td", c, k)))))));
      }
      default: return null;
    }
  });
}

function inline(nodes) {
  return nodes.map((n) => {
    if (typeof n === "string") return n;
    switch (n.t) {
      case "br": return h("br");
      case "code": return h("code", {}, n.text);
      case "strong": return h("strong", {}, inline(n.c));
      case "em": return h("em", {}, inline(n.c));
      case "del": return h("del", {}, inline(n.c));
      case "img": return h("span", { class: "md-img", title: n.src }, `[image: ${n.alt || n.src}]`);
      case "link":
        // External links open in a new tab; repo-relative links are shown, not followed (they are paths, not routes).
        return SAFE_HREF.test(n.href)
          ? h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer" }, inline(n.c))
          : h("span", { class: "md-xref", title: n.href }, inline(n.c));
      default: return null;
    }
  });
}
