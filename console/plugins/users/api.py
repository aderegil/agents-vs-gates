"""Users & Audit plugin API (spec §22.9). Owner only (manifest roles). The audit log itself is the core route
GET /api/audit (filters user, action, from, to; ?format=csv).

GET  /api/users                       list (never hashes)
POST /api/users                       {username, role, password}
POST /api/users/{username}/role       {role}
POST /api/users/{username}/password   {password}
POST /api/users/{username}/disable    —
POST /api/users/{username}/enable     —
There is no delete: disabling keeps the audit trail readable. Nobody can disable or demote themselves, and at least
one active owner always remains.
"""
from __future__ import annotations

from console.core.auth import public_user
from console.core.plugin_api import ApiError, ROLES


def register(router, ctx):
    users = ctx.users

    def body(req) -> dict:
        b = req.json
        if not isinstance(b, dict):
            raise ApiError(400, "Request body must be a JSON object")
        return b

    def not_self(req, username: str, what: str) -> None:
        if username == req.user["username"]:
            raise ApiError(409, f"You cannot {what} your own account")

    def list_users(req):
        return {"users": [public_user(u) for u in users.all()], "roles": list(ROLES), "me": req.user["username"]}

    def create(req):
        b = body(req)
        u = users.create(str(b.get("username") or "").strip().lower(), b.get("password"), b.get("role"),
                         by=req.user["username"])
        ctx.audit("users.create", {"username": u["username"], "role": u["role"]}, req.user)
        return {"ok": True, "user": u}

    def set_role(req):
        name = req.params["username"]
        role = body(req).get("role")
        not_self(req, name, "change the role of")
        before = users.get(name)
        u = users.set_role(name, role)
        ctx.audit("users.role", {"username": name, "from": (before or {}).get("role"), "to": role}, req.user)
        return {"ok": True, "user": u}

    def reset_password(req):
        name = req.params["username"]
        u = users.set_password(name, body(req).get("password"))
        ended = 0 if name == req.user["username"] else ctx.sessions.delete_user(name)
        ctx.audit("users.password_reset", {"username": name, "sessions_ended": ended}, req.user)
        return {"ok": True, "user": u}

    def disable(req):
        name = req.params["username"]
        not_self(req, name, "disable")
        u = users.set_active(name, False)
        ended = ctx.sessions.delete_user(name)
        ctx.audit("users.disable", {"username": name, "sessions_ended": ended}, req.user)
        return {"ok": True, "user": u}

    def enable(req):
        name = req.params["username"]
        u = users.set_active(name, True)
        ctx.audit("users.enable", {"username": name}, req.user)
        return {"ok": True, "user": u}

    router.get("", list_users)
    router.post("", create)
    router.post("/{username}/role", set_role)
    router.post("/{username}/password", reset_password)
    router.post("/{username}/disable", disable)
    router.post("/{username}/enable", enable)
