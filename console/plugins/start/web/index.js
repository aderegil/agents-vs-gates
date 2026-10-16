// Start here: the first page after sign-in. Five short blocks in simple English, all in words (no experiment codes):
// what we tested, what each page does, how to watch one run in three clicks, where the results are, words first.
// Text: GET /api/start (api.py). The page list shows only the plugins the user's role can open (GET /api/plugins), in
// rail order, each one a link; pages that only Expert view shows carry an "Expert" badge.
import { h, panel, button, badge, iconEl } from "/web/lib/ui.js";

let alive = false;

export async function mount(el, shell) {
  alive = true;
  shell.setHeader({ title: "Start here", subtitle: "What this console shows, in five short parts.", actions: [] });
  const body = h("div", { class: "stack start" }, h("p", { class: "loading" }, "Loading…"));
  el.replaceChildren(body);
  try {
    const [d, p] = await Promise.all([shell.api.get("start"), shell.api.get("plugins")]);
    if (!alive) return;
    shell.setHeader({ title: d.title, subtitle: d.subtitle });
    body.replaceChildren(...d.blocks.map((b) => block(b, d.pages, p.plugins, shell)));
  } catch (e) {
    if (alive) body.replaceChildren(h("div", { class: "notice fail" }, iconEl("circle-alert", 16), e.error || String(e)));
  }
}

export function unmount() {
  alive = false;
}

function block(b, pages, plugins, shell) {
  const kids = [];
  (b.text || []).forEach((t) => kids.push(h("p", {}, t)));
  if (b.list) kids.push(h("ul", { class: "start-list" }, b.list.map((t) => h("li", {}, t))));
  (b.after || []).forEach((t) => kids.push(h("p", {}, t)));
  if (b.steps) kids.push(h("ol", { class: "start-steps" }, b.steps.map((t) => h("li", {}, t))));
  if (b.id === "pages") kids.push(pageList(pages, plugins));
  if (b.link && plugins.some((x) => x.id === b.link.plugin)) {
    kids.push(h("div", { class: "start-go" }, button({ label: b.link.label, icon: b.link.icon, primary: b.id === "watch",
      onClick: () => shell.navigate(b.link.plugin) })));
  }
  return panel({ title: b.title, body: h("div", { class: "start-block" }, kids) });
}

function pageList(pages, plugins) {
  const shown = plugins.filter((p) => pages[p.id]);
  return h("ul", { class: "start-pages" }, shown.map((p) => h("li", {},
    h("a", { href: `#/${p.id}`, class: "start-page-name" }, iconEl(p.icon, 16), h("span", {}, p.name)),
    h("span", { class: "start-page-line" }, pages[p.id]),
    p.simple ? null : badge("Expert", "neutral"))));
}
