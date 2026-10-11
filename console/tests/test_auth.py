"""Auth: hashing, users, sessions, CSRF comparison, rate limiting."""
import tempfile
import time
import unittest
from pathlib import Path

from console.core import auth
from console.core.plugin_api import ApiError


class HashingTest(unittest.TestCase):
    def test_default_parameters(self):
        self.assertEqual(auth.ITERATIONS, 310_000)
        rec = auth.hash_password("correct horse battery", iterations=1000)
        self.assertEqual(rec["algo"], "pbkdf2-sha256")
        self.assertEqual(len(bytes.fromhex(rec["salt"])), 16)
        self.assertTrue(auth.verify_password("correct horse battery", rec))
        self.assertFalse(auth.verify_password("correct horse batterY", rec))

    def test_salt_is_random_per_user(self):
        a = auth.hash_password("same password!", iterations=1000)
        b = auth.hash_password("same password!", iterations=1000)
        self.assertNotEqual(a["salt"], b["salt"])
        self.assertNotEqual(a["hash"], b["hash"])

    def test_full_iterations_are_used_by_default(self):
        rec = auth.hash_password("x" * 12)
        self.assertEqual(rec["iterations"], 310_000)
        self.assertTrue(auth.verify_password("x" * 12, rec))

    def test_malformed_record_never_verifies(self):
        self.assertFalse(auth.verify_password("x", {"salt": "zz", "hash": "00"}))
        self.assertFalse(auth.verify_password("x", {}))


class UserStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = auth.UserStore(Path(self.tmp.name) / "users.json", iterations=1000)

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_and_authenticate(self):
        self.assertTrue(self.store.empty())
        u = self.store.create("alice", "0123456789ab", "owner")
        self.assertNotIn("hash", u)
        self.assertIsNotNone(self.store.authenticate("alice", "0123456789ab"))
        self.assertIsNone(self.store.authenticate("alice", "wrong-password"))
        self.assertIsNone(self.store.authenticate("nobody", "0123456789ab"))

    def test_validation(self):
        with self.assertRaises(ApiError):
            self.store.create("Bad Name", "0123456789ab", "viewer")
        with self.assertRaises(ApiError):
            self.store.create("bob", "short", "viewer")
        with self.assertRaises(ApiError):
            self.store.create("bob", "0123456789ab", "admin")
        self.store.create("bob", "0123456789ab", "viewer")
        with self.assertRaises(ApiError) as cm:
            self.store.create("bob", "0123456789ab", "viewer")
        self.assertEqual(cm.exception.status, 409)

    def test_last_active_owner_is_protected(self):
        self.store.create("alice", "0123456789ab", "owner")
        with self.assertRaises(ApiError):
            self.store.set_role("alice", "viewer")
        with self.assertRaises(ApiError):
            self.store.set_active("alice", False)
        self.store.create("carol", "0123456789ab", "owner")
        self.store.set_active("alice", False)
        self.assertIsNone(self.store.authenticate("alice", "0123456789ab"))  # disabled
        with self.assertRaises(ApiError):
            self.store.set_role("carol", "operator")

    def test_password_reset(self):
        self.store.create("dave", "0123456789ab", "operator")
        self.store.set_password("dave", "another-pass-1")
        self.assertIsNone(self.store.authenticate("dave", "0123456789ab"))
        self.assertIsNotNone(self.store.authenticate("dave", "another-pass-1"))


class SessionStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "sessions.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_get_delete(self):
        s = auth.SessionStore(self.path)
        token, sess = s.create("alice")
        self.assertEqual(s.get(token)["username"], "alice")
        self.assertTrue(sess["csrf"])
        self.assertIsNone(s.get("not-a-token"))
        s.delete(token)
        self.assertIsNone(s.get(token))

    def test_token_not_stored_in_clear_and_survives_restart(self):
        s = auth.SessionStore(self.path)
        token, _ = s.create("alice")
        self.assertNotIn(token, self.path.read_text(encoding="utf-8"))
        again = auth.SessionStore(self.path)
        self.assertEqual(again.get(token)["username"], "alice")

    def test_expiry(self):
        s = auth.SessionStore(self.path, ttl_s=1)
        token, _ = s.create("alice")
        s.sessions[next(iter(s.sessions))]["expires_ts"] = time.time() - 1
        self.assertIsNone(s.get(token))

    def test_twelve_hours_default(self):
        self.assertEqual(auth.SESSION_TTL_S, 12 * 3600)

    def test_delete_user_ends_all_sessions(self):
        s = auth.SessionStore(self.path)
        t1, _ = s.create("alice")
        t2, _ = s.create("alice")
        t3, _ = s.create("bob")
        self.assertEqual(s.delete_user("alice"), 2)
        self.assertIsNone(s.get(t1))
        self.assertIsNone(s.get(t2))
        self.assertIsNotNone(s.get(t3))


class CsrfAndLimiterTest(unittest.TestCase):
    def test_csrf_ok(self):
        self.assertTrue(auth.csrf_ok("abc", "abc"))
        self.assertFalse(auth.csrf_ok("abc", "abd"))
        self.assertFalse(auth.csrf_ok("abc", None))
        self.assertFalse(auth.csrf_ok(None, None))
        self.assertFalse(auth.csrf_ok("", ""))

    def test_rate_limiter(self):
        rl = auth.RateLimiter(max_failures=3, window_s=60)
        for _ in range(3):
            self.assertEqual(rl.blocked_for("ip:x"), 0)
            rl.failure("ip:x")
        self.assertGreater(rl.blocked_for("ip:x"), 0)
        self.assertEqual(rl.blocked_for("ip:y"), 0)
        rl.success("ip:x")
        self.assertEqual(rl.blocked_for("ip:x"), 0)


if __name__ == "__main__":
    unittest.main()
