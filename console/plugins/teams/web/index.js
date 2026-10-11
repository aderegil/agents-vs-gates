// Teams & Avatars (spec 22.6). kind: module — mount(el, shell) / unmount().
// Avatars are drawn by ./avatar.js, compiled from the Replay Theater's avatar code (console/plugins/replay/app/
// src/avatar-lib.ts), so a role's character is pixel-identical here and in the theater for the same seed.
import { renderAvatar } from "./avatar.js";

const PHASE_LABEL = {
  discovery: "Discovery", planning: "Planning", implementation: "Implementation", review: "Review",
  testing: "Testing", deployment: "Deployment", maintenance: "Maintenance",
};
const TYPE_LABEL = { human: "Human", agent: "AI agent", system: "System" };

let root = null;
let link = null;
let state = null;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function avatar(spec, size, label) {
  const c = h("canvas", { class: "tm-avatar", role: "img", "aria-label": label });
  try {
    renderAvatar(c, spec, size);
  } catch (e) {
    console.error("avatar", e);
  }
  return c;
}

function cite(c) {
  if (!c) return "";
  return `${c.file}${c.section ? ` — ${c.section}` : ""}`;
}

function typeTag(t) {
  return h("span", { class: `tm-type tm-type--${t}` }, TYPE_LABEL[t] || t);
}

export async function mount(el, shell) {
  root = h("div", { class: "tm-root" });
  // The shell loads web/style.css for us; add it only when mounted elsewhere (e.g. a preview harness).
  const css = new URL("./style.css", import.meta.url).href;
  link = [...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.href === css)
    ? null : h("link", { rel: "stylesheet", href: css });
  el.append(...(link ? [link, root] : [root]));
  state = { shell, models: [], phases: [], model: null, data: null, view: "board", avatars: null };
  shell.setHeader?.({
    title: "Teams & Avatars",
    subtitle: "How each AI-SDLC model staffs a team — public sources only; teams are not measured in the experiment",
    actions: [],
  });
  root.append(h("p", { class: "tm-muted" }, "Loading…"));
  try {
    const list = await shell.api.get("teams");
    state.models = list.models;
    state.phases = list.phases;
    const wanted = shell.params?.model;
    const first = state.models.find((m) => m.id === wanted) || state.models[0];
    if (first) await selectModel(first.id);
    else render();
  } catch (e) {
    root.replaceChildren(h("p", { class: "tm-error" }, `Cannot load teams: ${e?.error || e?.message || e}`));
  }
}

export function unmount() {
  root?.remove();
  link?.remove();
  root = null;
  link = null;
  state = null;
}

async function selectModel(id) {
  const data = await state.shell.api.get(`teams/${encodeURIComponent(id)}`);
  if (!state) return;
  state.model = id;
  state.data = data;
  render();
}

async function showGallery() {
  if (!state.avatars) state.avatars = (await state.shell.api.get("teams/avatars")).avatars;
  if (!state) return;
  state.view = "gallery";
  render();
}

function render() {
  if (!root || !state) return;
  const tabs = h("div", { class: "tm-tabs", role: "tablist", "aria-label": "Model" },
    state.models.map((m) => h("button", {
      type: "button", role: "tab", class: "tm-tab", "aria-selected": String(state.view !== "gallery" && m.id === state.model),
      onclick: () => {
        state.view = state.view === "gallery" ? "board" : state.view;
        selectModel(m.id);
      },
    }, m.short, h("span", { class: "tm-count" }, m.members))),
    h("span", { class: "tm-tabs__sep" }),
    h("button", {
      type: "button", role: "tab", class: "tm-tab", "aria-selected": String(state.view === "gallery"),
      onclick: () => showGallery(),
    }, "Avatar gallery"),
  );
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const btns = [...tabs.querySelectorAll("button")];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const j = (i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length;
    btns[j].focus();
    e.preventDefault();
  });
  const body = state.view === "gallery" ? gallery() : modelView();
  root.replaceChildren(tabs, body);
}

function modelView() {
  const d = state.data;
  if (!d) return h("p", { class: "tm-muted" }, "No model selected.");
  const views = h("div", { class: "tm-seg", role: "group", "aria-label": "View" },
    [["board", "Board by phase"], ["table", "Equivalence with v2.1 roles"]].map(([id, label]) =>
      h("button", { type: "button", class: "tm-seg__btn", "aria-pressed": String(state.view === id),
        onclick: () => { state.view = id; render(); } }, label)));
  const counts = { human: 0, agent: 0, system: 0 };
  d.members.forEach((m) => { counts[m.actor_type] = (counts[m.actor_type] || 0) + 1; });

  const head = h("section", { class: "tm-model" },
    h("div", { class: "tm-model__title" },
      h("h2", {}, d.name),
      d.label ? h("span", { class: "tm-label" }, d.label) : null),
    h("p", { class: "tm-model__meta" },
      [d.publisher, d.date || d.date_note || "undated"].filter(Boolean).join(" · "),
      d.url ? [" · ", h("a", { href: d.url, target: "_blank", rel: "noopener noreferrer" }, d.url.replace(/^https?:\/\//, ""))] : null),
    h("p", { class: "tm-model__summary" }, d.summary),
    h("dl", { class: "tm-facts" },
      h("div", {}, h("dt", {}, "Phases in the source"), h("dd", {}, d.source_phases || "—")),
      h("div", {}, h("dt", {}, "Members"), h("dd", { class: "tm-num" },
        `${d.members.length} · ${counts.human} human · ${counts.agent} AI agent · ${counts.system} system`))),
  );

  const gaps = (d.gaps || []).length ? h("section", { class: "tm-gaps", "aria-label": "What this model doesn't have" },
    h("h3", {}, "What this model doesn't have"),
    h("ul", {}, d.gaps.map((g) => h("li", {},
      h("span", { class: "tm-gaps__text" }, g.text),
      h("span", { class: "tm-cite" }, cite(g.citation)))))) : null;

  return h("div", { class: "tm-view" }, head, gaps, views, state.view === "table" ? table(d) : board(d));
}

function board(d) {
  const phases = d.phases || state.phases;
  return h("div", { class: "tm-board", style: `--cols:${phases.length}` },
    phases.map((p) => {
      const members = d.members.filter((m) => m.phase === p);
      return h("section", { class: "tm-col", "aria-label": PHASE_LABEL[p] || p },
        h("header", { class: "tm-col__head" }, h("span", {}, PHASE_LABEL[p] || p), h("span", { class: "tm-num tm-muted" }, members.length)),
        members.length ? members.map((m) => card(m, d)) : h("p", { class: "tm-empty" }, "No role in this phase"));
    }));
}

function card(m, d) {
  const spec = { style: m.actor_type, seed: m.seed, role: m.v21_role || m.role, family: d.id,
    badge: m.actor_type === "agent" ? d.badge || null : null };
  const details = h("div", { class: "tm-card__more", hidden: true },
    h("dl", {},
      h("div", {}, h("dt", {}, "Role in source"), h("dd", {}, m.role)),
      h("div", {}, h("dt", {}, "v2.1 role"), h("dd", {}, m.v21_role ? h("code", {}, m.v21_role) : "none", m.v21_note ? ` — ${m.v21_note}` : "")),
      h("div", {}, h("dt", {}, "Source"), h("dd", {}, cite(m.citation)))));
  const btn = h("button", { type: "button", class: "tm-card__toggle", "aria-expanded": "false",
    onclick: () => {
      const open = details.hidden;
      details.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Less" : "Source";
    } }, "Source");
  return h("article", { class: `tm-card tm-card--${m.actor_type}` },
    h("div", { class: "tm-card__top" },
      avatar(spec, 48, m.display_name),
      h("div", { class: "tm-card__id" },
        h("strong", {}, m.display_name),
        h("span", { class: "tm-card__role" }, m.role),
        typeTag(m.actor_type))),
    h("p", { class: "tm-card__resp" }, m.responsibility),
    h("div", { class: "tm-card__foot" },
      m.v21_role ? h("code", { class: "tm-v21" }, m.v21_role) : h("span", { class: "tm-muted" }, "no v2.1 role"),
      btn),
    details);
}

function table(d) {
  const rows = [...d.members].sort((a, b) =>
    (d.phases || state.phases).indexOf(a.phase) - (d.phases || state.phases).indexOf(b.phase));
  return h("div", { class: "tm-table-wrap" },
    h("table", { class: "tm-table" },
      h("thead", {}, h("tr", {}, ["", "Role (as in the source)", "v2.1 role", "Type", "Phase", "Responsibility", "Source"]
        .map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, rows.map((m) => h("tr", {},
        h("td", {}, avatar({ style: m.actor_type, seed: m.seed, role: m.v21_role || m.role, family: d.id,
          badge: null }, 40, m.display_name)),
        h("td", {}, h("strong", {}, m.role), h("div", { class: "tm-muted tm-small" }, m.display_name)),
        h("td", {}, m.v21_role ? h("code", {}, m.v21_role) : h("span", { class: "tm-muted" }, "—"),
          m.v21_note ? h("div", { class: "tm-muted tm-small" }, m.v21_note) : null),
        h("td", {}, typeTag(m.actor_type)),
        h("td", {}, PHASE_LABEL[m.phase] || m.phase),
        h("td", {}, m.responsibility),
        h("td", { class: "tm-cite" }, cite(m.citation)))))));
}

function gallery() {
  const all = state.avatars || [];
  const models = Object.fromEntries(state.models.map((m) => [m.id, m.short]));
  const groups = [["human", "Humans", "Pixel portraits by seed: face, hair, features and clothes that follow the role. Always fictional."],
    ["agent", "AI agents", "Machines with a screen face: head and colours by model family, chest emblem by role, AI badge."],
    ["system", "Systems", "Objects, not people: they light up, they never walk."]];
  return h("div", { class: "tm-view" },
    h("p", { class: "tm-model__summary" },
      "Every role of every model, drawn by the same code and the same seeds as the Replay Theater. ",
      h("span", { class: "tm-muted" }, `${all.length} avatars.`)),
    groups.map(([type, title, note]) => {
      const items = all.filter((a) => a.actor_type === type);
      return h("section", { class: "tm-gallery" },
        h("header", { class: "tm-gallery__head" }, h("h3", {}, title), h("span", { class: "tm-num tm-muted" }, items.length),
          h("span", { class: "tm-muted tm-small" }, note)),
        h("div", { class: "tm-gallery__grid" }, items.map((a) => h("figure", { class: "tm-tile" },
          avatar({ ...a.avatar, family: a.model }, 80, a.display_name),
          h("figcaption", {}, h("strong", {}, a.display_name), h("span", { class: "tm-muted" }, `${models[a.model] || a.model} · ${a.role}`))))));
    }));
}
