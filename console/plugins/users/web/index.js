// Users & Audit (spec §22.9): local accounts and the audit log (owner only).
import { h, table, tabs, badge, panel, button, fmtDate, formDialog, iconEl, notice } from "/web/lib/ui.js";

let alive = false;
let timer = null;

export function mount(el, shell) {
  alive = true;
  shell.setHeader({ title: "Users & Audit", subtitle: "Local accounts, roles and every recorded action" });
  const t = tabs({
    items: [
      { id: "users", label: "Users", icon: "users", render: () => usersView(shell) },
      { id: "audit", label: "Audit log", icon: "history", render: () => auditView(shell) },
    ],
    active: shell.params.tab || "users",
    onChange: (id) => history.replaceState(null, "", `#/users?tab=${id}`),
  });
  el.replaceChildren(t);
}

export function unmount() {
  alive = false;
  clearTimeout(timer);
}

const ROLE_HELP = {
  owner: "everything: users, freeze, unblind, smoke test",
  operator: "Run Control, Run Explorer, Results; Readiness read-only",
  presenter: "Replay, Results, Run Explorer read-only, Scenario, Teams",
  viewer: "read-only Results, Replay, Scenario, Teams",
};

const pwCheck = (v) => (v.password || "").length < 10 ? "Password: at least 10 characters"
  : v.password !== v.confirm ? "Passwords do not match" : null;

// ------------------------------------------------------------------ users

function usersView(shell) {
  const box = h("div", { class: "stack" }, h("p", { class: "loading" }, "Loading…"));
  const act = async (fn, okMsg) => {
    try { await fn(); shell.toast(okMsg, "ok"); load(); } catch (e) { shell.toast(e.error || "Failed", "error"); }
  };

  async function load() {
    let d;
    try { d = await shell.api.get("users"); } catch (e) { box.replaceChildren(notice(e.error || String(e), "fail", "circle-alert")); return; }
    if (!alive) return;
    const owners = d.users.filter((u) => u.role === "owner" && u.active).length;
    const roleOpts = d.roles.map((r) => ({ value: r, label: `${r} — ${ROLE_HELP[r]}` }));

    const create = button({ label: "New user", icon: "user-plus", primary: true, onClick: async () => {
      const v = await formDialog({ title: "New user", submitLabel: "Create user",
        fields: [
          { name: "username", label: "Username", hint: "2–32 characters: a–z, 0–9, '.', '_' or '-'" },
          { name: "role", label: "Role", type: "select", options: roleOpts, value: "viewer" },
          { name: "password", label: "Initial password", type: "password", autocomplete: "new-password" },
          { name: "confirm", label: "Repeat password", type: "password", autocomplete: "new-password" },
        ], validate: (v) => !v.username.trim() ? "Username is required" : pwCheck(v) });
      if (v) act(() => shell.api.post("users", { username: v.username.trim().toLowerCase(), role: v.role, password: v.password }), `Created ${v.username.trim().toLowerCase()}`);
    } });

    const rowActions = (u) => {
      const me = u.username === d.me;
      const lastOwner = u.role === "owner" && u.active && owners <= 1;
      return h("div", { class: "row", style: { gap: "4px", justifyContent: "flex-end" } },
        button({ label: "Role", icon: "user-cog", small: true, subtle: true, disabled: me || lastOwner,
          reason: me ? "You cannot change your own role" : "At least one active owner must remain",
          onClick: async () => {
            const v = await formDialog({ title: `Change role of ${u.username}`, submitLabel: "Change role",
              fields: [{ name: "role", label: "Role", type: "select", options: roleOpts, value: u.role }] });
            if (v && v.role !== u.role) act(() => shell.api.post(`users/${encodeURIComponent(u.username)}/role`, { role: v.role }), `${u.username} is now ${v.role}`);
          } }),
        button({ label: "Reset password", icon: "key-round", small: true, subtle: true, onClick: async () => {
          const v = await formDialog({ title: `Reset password of ${u.username}`, submitLabel: "Reset password",
            intro: me ? null : "Their open sessions end immediately.",
            fields: [{ name: "password", label: "New password", type: "password", autocomplete: "new-password" },
              { name: "confirm", label: "Repeat password", type: "password", autocomplete: "new-password" }], validate: pwCheck });
          if (v) act(() => shell.api.post(`users/${encodeURIComponent(u.username)}/password`, { password: v.password }), `Password reset for ${u.username}`);
        } }),
        u.active
          ? button({ label: "Disable", icon: "ban", small: true, subtle: true, disabled: me || lastOwner,
            reason: me ? "You cannot disable yourself" : "At least one active owner must remain",
            onClick: async () => {
              if (await shell.confirm({ title: `Disable ${u.username}?`, message: "They are signed out now and cannot sign in until enabled again. Their audit history stays.", confirmLabel: "Disable" }))
                act(() => shell.api.post(`users/${encodeURIComponent(u.username)}/disable`, {}), `${u.username} disabled`);
            } })
          : button({ label: "Enable", icon: "check", small: true, subtle: true,
            onClick: () => act(() => shell.api.post(`users/${encodeURIComponent(u.username)}/enable`, {}), `${u.username} enabled`) }));
    };

    const tbl = table({
      columns: [
        { key: "username", label: "User", sort: true, render: (u) => h("span", { class: "row", style: { gap: "8px" } },
          h("span", { class: "strong" }, u.username), u.username === d.me ? badge("you", "accent") : null) },
        { key: "role", label: "Role", sort: true, render: (u) => h("span", {}, u.role, h("span", { class: "small muted" }, ` · ${ROLE_HELP[u.role]}`)) },
        { key: "active", label: "Status", sort: (u) => (u.active ? 0 : 1), render: (u) => u.active ? badge("Active", "pass") : badge("Disabled", "neutral") },
        { key: "last_login_at", label: "Last sign-in", sort: true, render: (u) => h("span", { class: "tabular" }, u.last_login_at ? fmtDate(u.last_login_at) : "never") },
        { key: "created_at", label: "Created", sort: true, render: (u) => h("span", { class: "tabular" }, fmtDate(u.created_at, { time: false }), u.created_by ? h("span", { class: "muted" }, ` by ${u.created_by}`) : null) },
        { key: "actions", label: h("span", { class: "sr-only" }, "Actions"), render: rowActions },
      ],
      rows: d.users, keyboard: false, sort: { key: "username", dir: 1 },
    });
    box.replaceChildren(
      panel({ title: `Users (${d.users.length})`, actions: create, body: tbl, flush: true }),
      h("p", { class: "small muted" }, "Accounts are never deleted: disabling keeps the audit trail readable. Passwords are stored as PBKDF2-HMAC-SHA256 (310,000 iterations, per-user salt) in console/data/users.json."));
  }
  load();
  return box;
}

// ------------------------------------------------------------------ audit

function auditView(shell) {
  const f = { user: "", action: "", from: "", to: "" };
  const box = h("div", { class: "stack" });
  const listBox = h("div", {}, h("p", { class: "loading" }, "Loading…"));
  const userSel = h("select", { class: "select select-sm", "aria-label": "User", onchange: (e) => { f.user = e.target.value; load(); } });
  const actionSel = h("select", { class: "select select-sm", "aria-label": "Action", onchange: (e) => { f.action = e.target.value; load(); } });
  const fromIn = h("input", { class: "input input-sm", type: "date", "aria-label": "From date", onchange: (e) => { f.from = e.target.value; load(); } });
  const toIn = h("input", { class: "input input-sm", type: "date", "aria-label": "To date", onchange: (e) => { f.to = e.target.value; load(); } });
  const csv = h("a", { class: "btn btn-sm", href: "#", download: "" }, iconEl("download", 15), "Export CSV");
  const reset = button({ label: "Clear filters", small: true, subtle: true, onClick: () => {
    Object.keys(f).forEach((k) => (f[k] = ""));
    [userSel, actionSel, fromIn, toIn].forEach((x) => (x.value = ""));
    load();
  } });
  const filters = h("div", { class: "row", style: { gap: "8px" } },
    h("span", { class: "small muted" }, "User"), userSel, h("span", { class: "small muted" }, "Action"), actionSel,
    h("span", { class: "small muted" }, "From"), fromIn, h("span", { class: "small muted" }, "To"), toIn, reset);
  const head = h("div", { class: "row-between", style: { width: "100%" } }, filters, csv);
  box.append(panel({ title: head, body: listBox, flush: true }));

  const options = (sel, values, all) => {
    const cur = sel.value;
    sel.replaceChildren(h("option", { value: "" }, all), ...values.map((v) => h("option", { value: v, selected: v === cur }, v)));
  };

  async function load() {
    const q = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
    csv.href = shell.api.url("audit", { query: { ...q, format: "csv" } });
    let d;
    try { d = await shell.api.get("audit", { query: { ...q, limit: 1000 } }); } catch (e) { listBox.replaceChildren(notice(e.error || String(e), "fail", "circle-alert")); return; }
    if (!alive) return;
    options(userSel, d.users, "All users");
    options(actionSel, d.actions, "All actions");
    listBox.replaceChildren(table({
      columns: [
        { key: "ts", label: "Time", width: "170px", render: (r) => h("span", { class: "tabular nowrap" }, fmtDate(r.ts)) },
        { key: "user", label: "User", render: (r) => h("span", { class: r.user === "system" ? "muted" : "strong" }, r.user) },
        { key: "action", label: "Action", render: (r) => h("span", { class: "mono" }, r.action) },
        { key: "plugin", label: "Plugin", render: (r) => h("span", { class: "muted" }, r.plugin || "") },
        { key: "detail", label: "Detail", render: (r) => h("span", { class: "mono small", style: { overflowWrap: "anywhere" } }, detailText(r.detail)) },
      ],
      rows: d.entries, keyboard: false, empty: "No audit entries match these filters.",
    }), ...(d.total >= 1000 ? [h("p", { class: "small muted", style: { padding: "8px 16px" } }, "Showing the newest 1,000 entries; export CSV for all of them.")] : []));
  }
  shell.subscribe("audit.new", () => { clearTimeout(timer); timer = setTimeout(() => box.isConnected && load(), 800); });
  load();
  return box;
}

function detailText(d) {
  if (!d || typeof d !== "object") return "";
  const parts = Object.entries(d).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  return parts.join("  ");
}
