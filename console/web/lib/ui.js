// Shared UI helpers for the shell and every module plugin (contract console-api.md §4).
// Import from plugins as:  import { h, table, badge } from "/web/lib/ui.js";
//
// h(tag, attrs, ...children)   attrs: class, style (string|object), on<event>: fn, html: "<svg…>" (trusted markup only),
//                              boolean true → empty attribute, false/null → omitted; value/checked/disabled set as properties.
//                              children: strings/numbers become text (never HTML), Nodes, arrays, null/false skipped.
// fmtInt, fmtDuration(ms), fmtDate(iso, {time}), fmtTime(iso), fmtAgo(iso)
// table({columns, rows, onRowClick, keyboard: true, empty, rowKey, selected, sort})
//    columns: [{key, label, num, align, render(row) → Node|string, sort: true|fn, width, title}]
// tabs({items: [{id, label, icon, count, render() → Node}], active, onChange})  (alias: tabs: [...])
// badge(text, tone)   tone: neutral | accent | pass | fail | warn
// empty(msg), bar(k, n, {running}), button({label, icon, primary, subtle, small, disabled, reason, onClick, title}),
// panel({title, actions, body, flush}), facts([{label, value, sub}]), field(label, control), notice(msg, tone, icon),
// iconEl(name, size), unitTag(unit, {model, compact}) (glyph + label, see ./units.js), unitInfo(unit), unitText(unit),
// unitSeg({units, value, onChange, allLabel, label}) (segmented unit filter)
// modal(build(close) → {title, body, footer, focus, cancelValue}, {wide}) → Promise (focus-trapped dialog)
// formDialog({title, fields: [{name, label, type, options, value, hint}], submitLabel, validate, intro}) → Promise<values|null>
// (shell.confirm({title, message, confirmLabel, requireText}) is built on modal.)
import { iconEl } from "../icons.js";
import { unitInfo, unitGlyph, unitText } from "./units.js";
import { LEGEND } from "./labels.js";

export { iconEl, unitInfo, unitGlyph, unitText };

const PROPS = new Set(["value", "checked", "disabled", "selected", "indeterminate", "readOnly", "multiple"]);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class" || k === "className") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const NF = new Intl.NumberFormat("en-US");
export const fmtInt = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : NF.format(Math.round(Number(n))));

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return "—";
  const s = Math.round(Number(ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m} min ${String(r).padStart(2, "0")} s`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return `${hh} h ${String(mm).padStart(2, "0")} min`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

export function fmtDate(iso, { time = true } = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return time ? `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtAgo(iso) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return String(iso);
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso, { time: false });
}

export function badge(text, tone = "neutral") {
  return h("span", { class: `badge tone-${tone}` }, text);
}

/**
 * "What the codes mean": every code family of the experiment (tickets X-…, V0–V2, S0–S2, W1–W2, stages P0–P8 and C8,
 * the pilots, H2/HS-V2) with its plain words and meaning, from labels.js LEGEND. A native <details> (keyboard and
 * screen-reader friendly), collapsed by default; a <dl> per family.
 */
export function codeLegend({ open = false, families = null } = {}) {
  const groups = families ? LEGEND.filter((g) => families.some((f) => g.codes.includes(f))) : LEGEND;
  return h("details", { class: "code-legend", open },
    h("summary", {}, iconEl("info", 14), " What the codes mean"),
    h("div", { class: "code-legend-body" }, groups.map((g) => h("section", { class: "code-legend-group", "aria-label": g.title },
      h("h4", {}, g.title),
      h("dl", {}, g.items.map((i) => h("div", { class: "code-legend-item" },
        h("dt", {}, h("span", { class: "code-legend-words" }, i.short), " ", h("code", { class: "mono" }, i.code)),
        h("dd", {}, i.long))))))));
}

export function empty(msg) {
  return h("p", { class: "empty" }, msg);
}

export function notice(msg, tone = "", icon = "info") {
  return h("div", { class: `notice ${tone}` }, iconEl(icon, 16), h("div", {}, msg));
}

export function bar(k, n, { running = 0, label } = {}) {
  const pct = n > 0 ? Math.min(100, (100 * k) / n) : 0;
  const rpct = n > 0 ? Math.min(100 - pct, (100 * running) / n) : 0;
  return h("div", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": n || 0, "aria-valuenow": k || 0,
    "aria-label": label || `${k} of ${n}` },
    rpct ? h("span", { class: "running", style: { left: `${pct}%`, width: `${rpct}%` } }) : null,
    h("span", { style: { width: `${pct}%` } }));
}

/** A button. disabled + reason → aria-disabled (still focusable) with the reason as tooltip and visible text. */
export function button({ label, icon, primary, subtle, small, disabled, reason, onClick, title, type = "button", showReason = false } = {}) {
  const cls = ["btn", primary && "btn-primary", subtle && "btn-subtle", small && "btn-sm"];
  const b = h("button", { type, class: cls, title: (disabled && reason) || title || null,
    "aria-disabled": disabled ? "true" : null,
    onclick: (e) => { if (disabled) { e.preventDefault(); return; } onClick && onClick(e); } },
    icon ? iconEl(icon, 15) : null, label);
  if (disabled && reason && showReason) return h("span", { class: "with-reason" }, b, h("span", { class: "reason" }, reason));
  return b;
}

export function panel({ title, actions, body, flush = false, id } = {}) {
  return h("section", { class: "panel", id: id || null, "aria-label": typeof title === "string" ? title : null },
    title != null ? h("header", { class: "panel-head" }, typeof title === "string" ? h("h2", {}, title) : title,
      actions ? h("div", { class: "panel-actions" }, actions) : null) : null,
    h("div", { class: flush ? "panel-body flush" : "panel-body" }, body));
}

export function facts(items) {
  return h("dl", { class: "facts" }, items.map((it) =>
    h("div", { class: "fact" }, h("dt", {}, it.label), h("dd", { title: it.title || null }, it.value, it.sub ? h("span", { class: "sub" }, it.sub) : null))));
}

export function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", {}, label), control, hint ? h("span", { class: "small muted" }, hint) : null);
}

/** Dense table. keyboard: rows are focusable, ArrowUp/Down/Home/End move, Enter/Space open the row. */
export function table({ columns, rows, onRowClick, keyboard = true, empty: emptyMsg = "Nothing to show.", rowKey, selected, sort, caption } = {}) {
  const wrap = h("div", { class: "table-wrap" });
  let sortState = sort || null; // {key, dir: 1|-1}

  function cellValue(col, row) {
    return typeof col.sort === "function" ? col.sort(row) : row[col.key];
  }

  function render() {
    let data = rows.slice();
    if (sortState) {
      const col = columns.find((c) => c.key === sortState.key);
      if (col) data.sort((a, b) => {
        const x = cellValue(col, a), y = cellValue(col, b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * sortState.dir;
      });
    }
    const thead = h("thead", {}, h("tr", {}, columns.map((c) => {
      const cls = c.num || c.align === "right" ? "num" : null;
      const label = c.label ?? c.key;
      if (!c.sort) return h("th", { class: cls, scope: "col", style: c.width ? { width: c.width } : null, title: c.title || null }, label);
      const active = sortState && sortState.key === c.key;
      return h("th", { class: cls, scope: "col", "aria-sort": active ? (sortState.dir > 0 ? "ascending" : "descending") : "none",
        style: c.width ? { width: c.width } : null },
        h("button", { class: "sort", type: "button", onclick: () => {
          sortState = active ? { key: c.key, dir: -sortState.dir } : { key: c.key, dir: 1 };
          render();
        } }, label, active ? iconEl(sortState.dir > 0 ? "chevron-up" : "chevron-down", 12) : null));
    })));
    const tbody = h("tbody");
    data.forEach((row, i) => {
      const key = rowKey ? rowKey(row) : i;
      const tr = h("tr", {
        class: onRowClick ? "clickable" : null,
        tabindex: keyboard && onRowClick ? (i === 0 ? "0" : "-1") : null,
        "aria-selected": selected != null ? String(selected === key) : null,
        onclick: onRowClick ? () => onRowClick(row, i) : null,
      }, columns.map((c) => {
        const v = c.render ? c.render(row, i) : row[c.key];
        return h("td", { class: [c.num || c.align === "right" ? "num" : null, c.mono ? "mono" : null] },
          v == null || v === "" ? (c.num ? "—" : "") : v);
      }));
      tbody.append(tr);
    });
    if (keyboard && onRowClick) {
      tbody.addEventListener("keydown", (e) => {
        const tr = e.target.closest("tr");
        if (!tr) return;
        const all = [...tbody.rows];
        const idx = all.indexOf(tr);
        let next = null;
        if (e.key === "ArrowDown") next = all[idx + 1];
        else if (e.key === "ArrowUp") next = all[idx - 1];
        else if (e.key === "Home") next = all[0];
        else if (e.key === "End") next = all[all.length - 1];
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tr.click(); return; }
        if (next) {
          e.preventDefault();
          all.forEach((r) => r.setAttribute("tabindex", "-1"));
          next.setAttribute("tabindex", "0");
          next.focus();
        }
      });
    }
    const t = h("table", { class: "tbl" }, caption ? h("caption", { class: "sr-only" }, caption) : null, thead, tbody);
    wrap.replaceChildren(rows.length ? t : empty(emptyMsg));
  }
  render();
  wrap.update = (newRows) => { rows = newRows; render(); };
  return wrap;
}

/** Tabs with arrow-key navigation. Returns the element; el.select(id) switches programmatically. */
export function tabs({ items, tabs: alias, active, onChange } = {}) {
  const list = items || alias || [];
  let current = active && list.some((t) => t.id === active) ? active : list[0]?.id;
  const bar = h("div", { class: "tabs", role: "tablist" });
  const body = h("div", { role: "tabpanel" });
  const root = h("div", {}, bar, body);
  function draw() {
    bar.replaceChildren(...list.map((t) => h("button", {
      type: "button", class: "tab", role: "tab", id: `tab-${t.id}`, "aria-selected": String(t.id === current),
      tabindex: t.id === current ? "0" : "-1",
      onclick: () => select(t.id),
      onkeydown: (e) => {
        const i = list.findIndex((x) => x.id === t.id);
        let j = null;
        if (e.key === "ArrowRight") j = (i + 1) % list.length;
        if (e.key === "ArrowLeft") j = (i - 1 + list.length) % list.length;
        if (j != null) { e.preventDefault(); select(list[j].id); bar.querySelector(`#tab-${list[j].id}`)?.focus(); }
      },
    }, t.icon ? iconEl(t.icon, 15) : null, t.label, t.count != null ? h("span", { class: "count" }, t.count) : null)));
    body.setAttribute("aria-labelledby", `tab-${current}`);
    const t = list.find((x) => x.id === current);
    body.replaceChildren();
    if (t && t.render) {
      const r = t.render();
      if (r instanceof Promise) r.then((n) => n && body.replaceChildren(n));
      else if (r) body.replaceChildren(r);
    }
  }
  function select(id) {
    if (id === current) return;
    current = id;
    draw();
    onChange && onChange(id);
  }
  root.select = select;
  root.refresh = draw;
  draw();
  return root;
}

// ------------------------------------------------------------------ dialogs

let openCount = 0;
export const modalOpen = () => openCount > 0;

/** Modal with focus trap. build(close) → {title, body, footer}. Resolves with whatever close() receives. */
export function modal(build, { wide = false, label } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      openCount--;
      backdrop.remove();
      if (prev && prev.isConnected) prev.focus();
      resolve(v);
    };
    const parts = build(close);
    const titleId = "dlg-" + Math.random().toString(36).slice(2);
    const dialog = h("div", { class: wide ? "dialog wide" : "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-label": label || null },
      h("header", {}, h("h2", { id: titleId }, parts.title),
        h("button", { type: "button", class: "btn-icon", "aria-label": "Close", onclick: () => close(parts.cancelValue) }, iconEl("x", 16))),
      h("div", { class: "dialog-body" }, parts.body),
      parts.footer ? h("footer", {}, parts.footer) : null);
    const backdrop = h("div", { class: "backdrop", onmousedown: (e) => { if (e.target === backdrop) close(parts.cancelValue); } }, dialog);
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(parts.cancelValue); }
      if (e.key === "Tab") {
        const f = [...dialog.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")]
          .filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    document.body.append(backdrop);
    openCount++;
    (parts.focus || dialog.querySelector("input, .btn-primary, button"))?.focus();
  });
}


/** Form dialog. fields: [{name, label, type: "text"|"password"|"select", options: [v|{value,label}], value, hint, autocomplete}]
 *  validate(values) → error string or null. Resolves with the values object, or null when cancelled. */
export function formDialog({ title, fields, submitLabel = "Save", validate, intro } = {}) {
  return modal((close) => {
    const err = h("div", { class: "form-error", hidden: true, role: "alert" });
    const controls = {};
    const body = fields.map((f) => {
      let c;
      if (f.type === "select") {
        c = h("select", { class: "select", name: f.name },
          (f.options || []).map((o) => {
            const v = typeof o === "object" ? o.value : o;
            return h("option", { value: v, selected: v === f.value }, typeof o === "object" ? o.label : o);
          }));
      } else {
        c = h("input", { class: "input", name: f.name, type: f.type || "text", value: f.value ?? "", autocomplete: f.autocomplete || "off",
          spellcheck: "false", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } } });
      }
      controls[f.name] = c;
      return field(f.label, c, f.hint);
    });
    function submit() {
      const values = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.value]));
      const msg = validate ? validate(values) : null;
      if (msg) { err.replaceChildren(iconEl("circle-alert", 16), h("span", {}, msg)); err.hidden = false; return; }
      close(values);
    }
    return {
      title, cancelValue: null,
      body: [intro ? h("p", { class: "muted" }, intro) : null, ...body, err],
      footer: [h("button", { type: "button", class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "button", class: "btn btn-primary", onclick: submit }, submitLabel)],
    };
  });
}

/** A unit's glyph and its label, always together ("CC" glyph + "Claude Code · Sonnet"). The unit id is the tooltip.
 *  model: shown after the product when the unit has no model of its own (Codex: the reported model id). */
export function unitTag(unit, { model, compact = false } = {}) {
  const i = unitInfo(unit);
  const label = !i.model && model ? `${i.product} · ${model}` : i.label;
  return h("span", { class: ["unit-tag", i.mock ? "is-mock" : "", compact ? "compact" : ""], title: i.unit || null,
    "data-unit": i.unit }, h("span", { class: "unit-glyph-box", html: unitGlyph(unit, 16) }), h("span", { class: "unit-label" }, label));
}

/** Segmented unit picker ("All" + one button per unit, glyph and label): a <select> option cannot hold the glyph. */
export function unitSeg({ units, value = "", onChange, allLabel = "All", label = "Unit" } = {}) {
  const btn = (v, content, title) => h("button", { type: "button", "aria-pressed": String(value === v), title: title || null,
    onclick: () => { if (value !== v) onChange?.(v); } }, content);
  return h("div", { class: "unit-seg", role: "group", "aria-label": label },
    btn("", allLabel), (units || []).map((u) => btn(u, unitTag(u, { compact: true }), u)));
}
