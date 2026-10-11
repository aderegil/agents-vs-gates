// Runner output: the stdout/stderr of the last runner launched from the console, as a terminal view beside Run Control.
// Data: GET /api/run-control/log?offset=<bytes shown> (incremental; the core sanitizes it). Polls every 1.5 s while the
// runner is alive, every 10 s otherwise. Lines for blinded stages carry no agent activity (the runner prints it only
// for visible stages), so the panel is as blind as the rest of the page.
import { h, button, iconEl } from "/web/lib/ui.js";
import { lineKind } from "./model.js";

const KEY = "avg.rc.output";
const MAX_LINES = 3000;

function stored() { try { return localStorage.getItem(KEY) !== "closed"; } catch { return true; } }
function store(open) { try { localStorage.setItem(KEY, open ? "open" : "closed"); } catch { /* no memory */ } }

export function outputPanel(shell, { isAlive, onToggle }) {
  let open = stored();
  let offset = 0;
  let follow = true;
  let timer = null;
  let stopped = false;
  let lines = [];
  let carry = "";
  let meta = { log: null, alive: false, launched_at: null };

  const pre = h("pre", { class: "rc-term", tabindex: "0", "aria-label": "Runner output", "aria-live": "off" });
  const status = h("span", { class: "rc-term-status small" });
  const file = h("span", { class: "rc-term-file small muted mono" });
  const followBtn = h("button", { type: "button", class: "rc-term-follow small", "aria-pressed": "true",
    title: "Keep the newest line in view", onclick: () => setFollow(!follow) }, "Follow");
  const hideBtn = button({ label: "Hide", icon: "chevron-right", small: true, subtle: true, title: "Hide the runner output", onClick: () => setOpen(false) });
  const showBtn = h("button", { type: "button", class: "rc-term-tab", title: "Show the runner output", onclick: () => setOpen(true) },
    iconEl("chevron-left", 14), h("span", {}, "Runner output"));
  const panelEl = h("section", { class: "rc-term-panel", "aria-label": "Runner output" },
    h("div", { class: "rc-term-head" },
      h("div", { class: "rc-term-title" }, h("h2", {}, "Runner output"), status),
      h("div", { class: "rc-term-actions" }, followBtn, hideBtn)),
    file, pre);
  const el = h("aside", { class: "rc-term-box" });

  pre.addEventListener("scroll", () => {
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    if (follow !== atEnd) setFollow(atEnd, false);
  });

  function setFollow(on, scroll = true) {
    follow = on;
    followBtn.setAttribute("aria-pressed", String(on));
    if (on && scroll) pre.scrollTop = pre.scrollHeight;
  }

  function setOpen(v) {
    open = v;
    store(v);
    draw();
    onToggle && onToggle(v);
    if (v) { pre.scrollTop = pre.scrollHeight; schedule(0); }
  }

  function draw() {
    el.replaceChildren(open ? panelEl : showBtn);
    el.classList.toggle("is-closed", !open);
  }

  function paintMeta() {
    const live = meta.alive;
    status.replaceChildren(h("span", { class: ["rc-term-dot", live && "is-live"] }),
      live ? "Live" : meta.log ? "Runner stopped" : "No runner launched yet");
    file.textContent = meta.log ? `${meta.log}${meta.args ? "  ·  " + meta.args.join(" ") : ""}` : "";
  }

  function appendText(text, reset) {
    if (reset) { lines = []; carry = ""; pre.replaceChildren(); }
    if (!text) return;
    const add = (carry + text).replace(/\r\n?/g, "\n").split("\n");
    carry = add.pop();  // "" when the text ends with a newline; otherwise the rest of the line comes in the next read
    const frag = document.createDocumentFragment();
    for (const ln of add) {
      const kind = lineKind(ln);
      const node = h("span", { class: ["rc-term-line", kind && `is-${kind}`] }, ln || " ");
      lines.push(node);
      frag.append(node, "\n");
    }
    pre.append(frag);
    while (lines.length > MAX_LINES) {
      const n = lines.shift();
      if (n.nextSibling && n.nextSibling.nodeType === 3) n.nextSibling.remove();
      n.remove();
    }
    if (follow) pre.scrollTop = pre.scrollHeight;
  }

  async function poll() {
    timer = null;
    if (stopped) return;
    if (open) {
      try {
        const d = await shell.api.get("run-control/log", { query: { offset } });
        if (stopped) return;
        const relaunched = d.log !== meta.log || (d.launched_at && d.launched_at !== meta.launched_at);
        meta = d;
        appendText(d.text, d.reset || relaunched);
        offset = d.offset;
        paintMeta();
      } catch (e) {
        status.textContent = e.error || "Could not read the runner output";
      }
    }
    schedule((meta.alive || isAlive()) ? 1500 : 10000);
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  draw();
  paintMeta();
  schedule(0);
  return {
    el,
    isOpen: () => open,
    /** Run Control calls this when its status says the runner started or stopped. */
    nudge: () => schedule(200),
    stop: () => { stopped = true; if (timer) clearTimeout(timer); },
  };
}
