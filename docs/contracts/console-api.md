# Console contract (§19–§24)

`python -m console` → `http://127.0.0.1:8765` (stdlib `ThreadingHTTPServer`, binds 127.0.0.1 only).
`python -m console --check` → the headless end-to-end check of §24 (prints `CHECK OK` / `CHECK FAILED`).
`python -m console --port N --data-dir D` for tests.

## 1. Plugin folder
```
console/plugins/<id>/
  plugin.json        docs/contracts/plugin.schema.json
  api.py             optional: def register(router, ctx) -> None
  web/index.js       kind=module: export function mount(el, shell) / export function unmount()
  web/dist/index.html  kind=iframe (Replay Theater)
  web/*.css          optional, loaded by the shell when the plugin mounts if listed as web/style.css
```
Plugin ids and order (fixed): 1 `overview`, 2 `run-control`, 3 `results`, 4 `runs` (Run Explorer), 5 `replay`
(Replay Theater), 6 `teams` (Teams & Avatars), 7 `scenario`, 8 `readiness`, 9 `users` (Users & Audit). Roles per §19.

## 2. Python side (implemented by WP3 in `console/core/`; plugins import from `console.core.plugin_api`)
```python
from console.core.plugin_api import ApiError, Response

def register(router, ctx):
    router.get("/stages", list_stages)                        # → GET  /api/<plugin-id>/stages
    router.post("/start", start, roles=["owner", "operator"]) # roles narrows the plugin's manifest roles
    router.get("/{run_id}/diff", get_diff)                    # path params in braces; "" = the plugin root

def list_stages(req):        # req: Request
    req.method, req.path, req.params["run_id"], req.query.get("x"), req.json, req.body, req.user, req.ns
    return {"stages": [...]}           # dict/list → 200 JSON
    return Response(body=b"...", content_type="image/svg+xml", headers={"Content-Disposition": "attachment; filename=x.svg"})
    raise ApiError(409, "Pre-registration lock missing")   # → {"error": "..."} with that status
```
- `req.user` = `{"username", "role"}`; `req.ns` = `"real"|"mock"` (from `?ns=`, else the session's global switch).
- Readonly enforcement: `ctx.can_write(req)` is false for roles listed in the plugin's `readonly_roles`.
- `ctx`: `ctx.repo` (Path), `ctx.results_dir(ns)` (Path), `ctx.data_dir` (console data dir), `ctx.python`
  (venv interpreter path), `ctx.audit(action: str, detail: dict, user: dict|None)`, `ctx.publish(topic, data, ns=None)`,
  `ctx.spawn(argv: list[str], log_name: str) -> int pid` (detached process, survives console restarts).
- Core routes (WP3): `GET /api/session`, `POST /api/login`, `POST /api/logout`, `POST /api/setup` (only when no users
  and from 127.0.0.1), `POST /api/session/ns` `{"ns"}`, `GET /api/plugins`, `GET /api/events` (SSE),
  `GET /api/audit` (owner; filters `user`, `action`, `from`, `to`; `?format=csv`), `GET /api/health`.
- Plugin routes (owners): `overview` → `/api/overview`; `run-control` → `/api/run-control/{stages,status,dry-run,start,stop,workers,resume-at}`;
  `results` → `/api/results/{rq,mutation,reviewer,excluded,export}`; `runs` → `/api/runs`, `/api/runs/{id}`,
  `/api/runs/{id}/{diff,ci,oracle,detectors,transcript,trace,replay}`; `replay` → `/api/replay/list` (runs of the ns that have an `events.jsonl`, with meta) and
  `/api/replay/run/{run_id}` (the run's `replay.json`, built on demand with `replay.export.build_replay` and cached
  in the run folder; `/api/runs/{id}/replay` delegates to the same function);
  `teams` → `/api/teams`, `/api/teams/{model}`, `/api/teams/avatars` (stands in for §23's `/api/avatars`);
  `scenario` → `/api/scenario/{repos,file,rules,catalog,tickets,contexts,broker}`;
  `readiness` → `/api/readiness/{doctor,smoke,lock,freeze,units,token,checklist}`; `users` → `/api/users…`.
- No route ever returns the OAuth token, `.env` content, or a path containing `C:\Users\<name>` (sanitize to `~`).
- Session cookie `avg_session` (HttpOnly, SameSite=Strict, 12 h). Every POST needs header `X-CSRF-Token`
  (value from `GET /api/session`).

## 3. Server-Sent Events
`GET /api/events` streams `event: <topic>\ndata: <json>\n\n` with `data = {"ns": "real"|"mock", ...}`. Topics:
`runner.progress` (the whole `state.runner` + `state.workers` + counts, at most 1/s), `runner.run_started`
(`run_id, worker, ticket, cell`), `runner.run_finished` (`run_id, turns, duration_ms, tokens` — and `outcome` only
when the stage is visible), `runner.stopped`, `runner.rate_limited` (`until`), `audit.new`. The core watcher reads
`state.json` and `runner.log.jsonl` of both namespaces every second.

## 4. Browser side (`shell` object given to `mount(el, shell)`)
```js
shell.api.get(path, {ns})        // path relative to /api, e.g. "run-control/stages"; resolves JSON; rejects {status, error}
shell.api.post(path, body, {ns}) // adds X-CSRF-Token
shell.api.url(path, {ns})        // absolute URL (for downloads / <img>)
shell.user                       // {username, role}
shell.ns                         // "real" | "mock" (current global switch)
shell.canWrite                   // false if the user's role is in readonly_roles
shell.navigate(pluginId, params) // e.g. navigate("replay", {run: "p1-0007", ns: "mock"})
shell.params                     // params passed by navigate (also mirrored in location.hash)
shell.toast(msg, kind)           // kind: "info" | "ok" | "error"
shell.subscribe(topic, fn)       // returns an unsubscribe function
shell.confirm({title, message, confirmLabel, requireText}) // Promise<boolean>; requireText e.g. "RUN SMOKE"
shell.setHeader({title, subtitle, actions: [{id, label, icon, primary, disabled, reason, onClick}]})
shell.icon(name, size)           // SVG string for a Lucide icon
```
Shared UI helpers: `/web/lib/ui.js` (WP3): `h(tag, attrs, ...children)`, `fmtInt`, `fmtDuration`, `fmtDate`,
`table({columns, rows, onRowClick, keyboard: true})`, `tabs`, `badge(text, tone)`, `empty(msg)`.
Tones: `neutral`, `accent`, `pass` (cyan #00BCD4), `fail` (pink #E91E63), `warn` (amber, only for TODO/attention).

`kind: iframe` plugins receive `postMessage({type: "avg:hello", apiBase: "/api", csrf, user, ns, params})` after load
and may post `{type: "avg:navigate", plugin, params}` back.

## 5. Visual tokens (from the Iniciativas app, §20) — defined once in `/web/styles.css`
`--fondo #f6f7f9; --superficie #fff; --linea #e3e6eb; --tinta #111827; --tinta-2 #5b6474; --acento #2563eb;
--trazo 1.5px; --radio 6px; --pass #00BCD4; --fail #E91E63;` IBM Plex Sans 400/500/600 from `/web/fonts/`.
Tabular figures (`font-variant-numeric: tabular-nums`) on every number column. No gradients, no glass, no large soft
shadows, no emoji, no sparkle icons, no filler copy. Interface text in English.
