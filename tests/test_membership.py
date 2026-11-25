import base64
import json
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from backend.app.auth_identity_cache import VerifiedIdentityCache


def token(exp=None):
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp or time.time() + 600}).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


class IdentityCacheTests(unittest.TestCase):
    def test_cache_expires_without_extending_the_token_lifetime(self):
        cache = VerifiedIdentityCache(ttl=30)
        access_token = token(1010)
        with patch("backend.app.auth_identity_cache.time.time", return_value=1000), patch("backend.app.auth_identity_cache.time.monotonic", return_value=10):
            self.assertEqual(cache.get(access_token, lambda: "verified"), "verified")
        with patch("backend.app.auth_identity_cache.time.time", return_value=1011), patch("backend.app.auth_identity_cache.time.monotonic", return_value=21):
            self.assertEqual(cache.get(access_token, lambda: "reverified"), "reverified")

    def test_concurrent_requests_share_one_verified_lookup(self):
        cache = VerifiedIdentityCache()
        calls = []
        started, release = threading.Event(), threading.Event()
        def load():
            calls.append(1)
            started.set()
            release.wait(2)
            return ("legacy-id", "test@example.invalid", "2026-01-01T00:00:00Z")
        access_token = token()
        with ThreadPoolExecutor(max_workers=8) as pool:
            first = pool.submit(cache.get, access_token, load)
            self.assertTrue(started.wait(1))
            rest = [pool.submit(cache.get, access_token, load) for _ in range(7)]
            release.set()
            self.assertEqual([first.result()] + [r.result() for r in rest], [first.result()] * 8)
        self.assertEqual(len(calls), 1)

    def test_failures_are_not_cached_and_sensitive_actions_verify_fresh(self):
        cache = VerifiedIdentityCache()
        access_token = token()
        with self.assertRaises(ValueError):
            cache.get(access_token, lambda: (_ for _ in ()).throw(ValueError("offline")))
        self.assertEqual(cache.get(access_token, lambda: "verified"), "verified")
        self.assertEqual(cache.get(access_token, lambda: "fresh", fresh=True), "fresh")

    def test_expired_and_unparseable_tokens_always_reach_verifier(self):
        cache = VerifiedIdentityCache()
        for value in (token(time.time() - 1), "invalid"):
            self.assertEqual(cache.get(value, lambda: "one"), "one")
            self.assertEqual(cache.get(value, lambda: "two"), "two")


class MembershipTests(unittest.TestCase):
    def setUp(self):
        self.runtime = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"DOO_DATA_DIR": self.runtime.name, "DOO_BILLING_ENABLED": "true", "DOO_BILLING_CUTOVER_AT": "2026-03-19T00:00:00+09:00"})
        self.env.start()
        from backend.app import main
        self.main = main

    def tearDown(self):
        self.env.stop()
        self.runtime.cleanup()

    def test_verified_join_date_avoids_admin_lookup_for_both_membership_types(self):
        m = self.main
        with patch.object(m, "_load_user_billing_record", return_value={}), patch.object(m, "_save_user_billing_record", side_effect=lambda record: record), patch.object(m, "_try_mark_legacy_from_admin_profile") as lookup:
            legacy = m._ensure_billing_record("legacy", "", "2026-01-01T00:00:00Z")
            new = m._ensure_billing_record("new", "", "2026-11-01T00:00:00Z")
            self.assertTrue(legacy["legacy_full_access"])
            self.assertEqual(m._effective_plan_code(legacy), "legacy")
            self.assertTrue(new["legacy_checked"])
            self.assertFalse(new["legacy_full_access"])
            lookup.assert_not_called()

    def test_missing_profile_does_not_complete_new_member_classification(self):
        m = self.main
        with patch.object(m, "_supabase_admin_config", return_value=("https://example.invalid", "test")), patch.object(m, "_supabase_lookup_user_profile", return_value={}):
            record = m._default_billing_record("legacy", "")
            self.assertEqual(m._try_mark_legacy_from_admin_profile(record, "legacy", ""), (False, False))
            self.assertFalse(record["legacy_checked"])

    def test_previous_free_classification_is_upgraded_for_verified_legacy_member(self):
        m = self.main
        previous = m._default_billing_record("legacy", "")
        previous["legacy_checked"] = True
        with patch.object(m, "_load_user_billing_record", return_value=previous), patch.object(m, "_save_user_billing_record", side_effect=lambda value: value):
            record = m._ensure_billing_record("legacy", "", "2026-01-01T00:00:00Z")
            self.assertTrue(record["legacy_full_access"])
            payload = m._viewer_billing_payload({"plan_code": m._effective_plan_code(record), "features": m._plan_policy("legacy")["features"]})
            self.assertEqual(payload["plan_code"], "legacy")
            self.assertTrue(all(payload["flags"].values()))

    def test_unresolved_member_returns_retryable_status_instead_of_free_plan(self):
        m = self.main
        with patch.object(m, "_ensure_billing_record", return_value=m._default_billing_record("legacy", "")):
            with self.assertRaises(m.HTTPException) as caught:
                m._billing_status_for_user("legacy", "")
            self.assertEqual(caught.exception.status_code, 503)

    def test_supplied_invalid_bearer_never_falls_back_to_user_headers(self):
        m = self.main
        from starlette.requests import Request
        request = Request({"type": "http", "headers": [(b"authorization", b"Bearer invalid"), (b"x-doo-user-id", b"legacy")]})
        with patch.object(m, "_supabase_auth_config", side_effect=m.HTTPException(status_code=503)):
            with self.assertRaises(m.HTTPException):
                m._request_identity_with_created_at(request)

