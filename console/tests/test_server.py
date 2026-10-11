"""HTTP behaviour of the core: setup, login, CSRF, roles, read-only, namespace, sanitization, audit, static files."""
import json
import unittest

from console.tests.helpers import PW, ConsoleFixture, write_plugin

API = '''
from console.core.plugin_api import ApiError, Response

def register(router, ctx):
    router.get("/ping", lambda req: {"ns": req.ns, "user": req.user, "can_write": ctx.can_write(req)})
    router.get("/leak", lambda req: {"path": "C:\\\\Users\\\\someone\\\\secret.txt", "fwd": "C:/Users/someone/x"})
    router.get("/svg", lambda req: Response(body="<svg>C:\\\\Users\\\\bob\\\\a</svg>", content_type="image/svg+xml"))
    router.get("/owner-only", lambda req: {"ok": True}, roles=["owner"])
    router.post("/write", lambda req: {"got": req.json})
    router.post("/operator-write", lambda req: {"ok": True}, roles=["owner", "operator"])
    router.get("/{item}/detail", lambda req: {"item": req.params["item"]})
    def boom(req):
        raise RuntimeError("kaboom")
    router.get("/boom", boom)
    def conflict(req):
        raise ApiError(409, "nope")
    router.get("/conflict", conflict)
    def audit(req):
        ctx.audit("demo.action", {"x": 1}, req.user)
        return {"ok": True}
    router.post("/audit", audit)
'''


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = ConsoleFixture().__enter__()
        write_plugin(cls.fx.plugins_dir, "demo", {"readonly_roles": ["operator"]}, api=API, order=3)
        write_plugin(cls.fx.plugins_dir, "broken-api", api="raise ImportError('missing dependency')", order=4)
        write_plugin(cls.fx.plugins_dir, "bad", {"kind": "widget"})
        cls.fx.app.load_plugins()

    @classmethod
    def tearDownClass(cls):
        cls.fx.__exit__(None, None, None)

    def test_setup_only_once(self):
        c = self.fx.client()
        r = c.setup("intruder", "another-Password-1")
        self.assertEqual(r.status, 409)
        s = c.session()
        self.assertFalse(s["authenticated"])
        self.assertFalse(s["setup_required"])

    def test_cookie_attributes(self):
        c = self.fx.client()
        c.session()
        r = c.post("/api/login", {"username": "owner1", "password": PW})
        cookie = [x for x in r.headers_all("Set-Cookie") if x.startswith("avg_session=")][0]
        for attr in ("HttpOnly", "SameSite=Strict", "Max-Age=43200", "Path=/"):
            self.assertIn(attr, cookie)

    def test_login_requires_pre_session_csrf(self):
        c = self.fx.client()
        c.session()
        r = c.post("/api/login", {"username": "owner1", "password": PW}, csrf=False)
        self.assertEqual(r.status, 403)

    def test_unauthenticated(self):
        c = self.fx.client()
        self.assertEqual(c.get("/api/plugins").status, 401)
        self.assertEqual(c.get("/api/demo/ping").status, 401)
        self.assertEqual(c.get("/api/events").status, 401)

    def test_csrf_required_on_post(self):
        o = self.fx.owner
        self.assertEqual(o.post("/api/demo/write", {"a": 1}, csrf=False).status, 403)
        self.assertEqual(o.post("/api/demo/write", {"a": 1}, headers={"X-CSRF-Token": "x"}, csrf=False).status, 403)
        r = o.post("/api/demo/write", {"a": 1})
        self.assertEqual((r.status, r.json), (200, {"got": {"a": 1}}))

    def test_cross_origin_post_refused(self):
        r = self.fx.owner.post("/api/demo/write", {}, headers={"Origin": "http://evil.example"})
        self.assertEqual(r.status, 403)

    def test_bad_host_refused(self):
        r = self.fx.owner.get("/api/health", headers={"Host": "evil.example"})
        self.assertEqual(r.status, 421)

    def test_role_filtering_of_plugins(self):
        v = self.fx.client("vic", "viewer")
        ids = [p["id"] for p in v.get("/api/plugins").json["plugins"]]
        self.assertNotIn("demo", ids)
        self.assertEqual(v.get("/api/demo/ping").status, 403)
        o_ids = [p["id"] for p in self.fx.owner.get("/api/plugins").json["plugins"]]
        self.assertEqual(o_ids, ["demo", "broken-api"])  # sorted by order; invalid "bad" skipped

    def test_route_roles_and_readonly(self):
        op = self.fx.client("opal", "operator")
        r = op.get("/api/demo/ping")
        self.assertEqual(r.status, 200)
        self.assertFalse(r.json["can_write"])
        self.assertEqual(op.get("/api/demo/owner-only").status, 403)
        self.assertEqual(op.post("/api/demo/write", {}).status, 403)            # read-only role, default deny
        self.assertEqual(op.post("/api/demo/operator-write", {}).status, 200)   # route lists the role explicitly
        self.assertTrue(self.fx.owner.get("/api/demo/ping").json["can_write"])
        self.assertEqual(self.fx.owner.get("/api/demo/owner-only").status, 200)

    def test_errors(self):
        o = self.fx.owner
        r = o.get("/api/demo/boom")
        self.assertEqual(r.status, 500)
        self.assertNotIn("kaboom", r.text)
        self.assertEqual(o.get("/api/demo/conflict").json, {"error": "nope"})
        self.assertEqual(o.get("/api/demo/conflict").status, 409)
        self.assertEqual(o.get("/api/demo/nothing/here/x").status, 404)
        self.assertEqual(o.get("/api/broken-api/x").status, 503)
        self.assertEqual(o.get("/api/nope").status, 404)
        self.assertEqual(o.get("/api/demo/x1/detail").json, {"item": "x1"})

    def test_sanitization(self):
        r = self.fx.owner.get("/api/demo/leak")
        self.assertNotIn("Users", r.text)
        self.assertEqual(r.json["path"], "~\\secret.txt")
        self.assertEqual(r.json["fwd"], "~/x")
        self.assertNotIn("Users", self.fx.owner.get("/api/demo/svg").text)

    def test_namespace_resolution(self):
        o = self.fx.client("nora", "owner")
        self.assertEqual(o.get("/api/demo/ping").json["ns"], "mock")  # no real runs → mock
        self.assertEqual(o.get("/api/demo/ping?ns=real").json["ns"], "real")
        self.assertEqual(o.get("/api/demo/ping?ns=bogus").status, 400)
        self.assertEqual(o.post("/api/session/ns", {"ns": "real"}).status, 200)
        self.assertEqual(o.get("/api/demo/ping").json["ns"], "real")
        self.assertEqual(o.session()["ns"], "real")

    def test_audit_from_plugin_and_filters_and_csv(self):
        o = self.fx.owner
        o.post("/api/demo/audit", {})
        rows = o.get("/api/audit?action=demo.").json["entries"]
        self.assertTrue(rows and rows[0]["action"] == "demo.action" and rows[0]["plugin"] == "demo")
        self.assertEqual(o.get("/api/audit?user=nobody").json["entries"], [])
        self.assertEqual(o.get("/api/audit?from=2999-01-01").json["entries"], [])
        csv = o.get("/api/audit?format=csv")
        self.assertTrue(csv.header("Content-Type").startswith("text/csv"))
        self.assertIn("attachment", csv.header("Content-Disposition"))
        self.assertTrue(csv.text.startswith("ts,user,role,action,plugin,detail"))
        self.assertEqual(self.fx.client("vera", "viewer").get("/api/audit").status, 403)
        invalid = [r for r in o.get("/api/audit?action=plugin.invalid").json["entries"]]
        self.assertTrue(any(r["detail"].get("folder") == "bad" for r in invalid))

    def test_login_rate_limit(self):
        self.fx.app.users.create("rita", PW, "viewer", by="test")
        c = self.fx.client()
        statuses = [c.login("rita", "wrong-password-x").status for _ in range(6)]
        self.assertEqual(statuses[:5], [401] * 5)
        self.assertEqual(statuses[5], 429)
        self.assertEqual(c.login("rita", PW).status, 429)  # still blocked even with the right password
        self.fx.app.limiter.fail.clear()

    def test_disabled_user_loses_session(self):
        c = self.fx.client("dina", "viewer")
        self.assertEqual(c.get("/api/plugins").status, 200)
        self.fx.app.users.set_active("dina", False)
        self.assertEqual(c.get("/api/plugins").status, 401)

    def test_logout(self):
        c = self.fx.client("lou", "viewer")
        self.assertEqual(c.post("/api/logout").status, 200)
        self.assertEqual(c.get("/api/plugins").status, 401)

    def test_static(self):
        c = self.fx.client()
        r = c.get("/")
        self.assertEqual(r.status, 200)
        self.assertIn("text/html", r.header("Content-Type"))
        self.assertIn("default-src 'self'", r.header("Content-Security-Policy"))
        self.assertEqual(c.get("/web/app.js").status, 200)
        self.assertEqual(c.get("/web/fonts/ibm-plex-sans-latin-400-normal.woff2").header("Content-Type"), "font/woff2")
        self.assertEqual(c.get("/plugins/demo/web/index.js").status, 200)
        self.assertEqual(c.get("/plugins/demo/api.py").status, 404)          # only web/ is served
        self.assertEqual(c.get("/plugins/demo/plugin.json").status, 404)
        self.assertEqual(c.get("/web/%2e%2e/core/auth.py").status, 404)
        self.assertEqual(c.get("/plugins/demo/web/../api.py").status, 404)

    def test_status_and_health(self):
        o = self.fx.owner
        s = o.get("/api/status").json
        self.assertEqual(set(s["runner"]), {"real", "mock"})
        self.assertEqual(s["runner"]["mock"]["status"], "idle")
        h = o.get("/api/health").json
        self.assertTrue(h["ok"])
        self.assertIn("broken-api", h["api_errors"])
        anon = self.fx.client().get("/api/health").json
        self.assertNotIn("api_errors", anon)


if __name__ == "__main__":
    unittest.main()
