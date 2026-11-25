import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class PopupAdminTests(unittest.TestCase):
    def test_korean_password_and_readable_rejection(self):
        from backend.app import main
        with patch.dict(os.environ, {"DOO_ADMIN_POPUP_PASSWORD": "관리자-test-password"}):
            main._require_popup_admin_password("관리자-test-password")
            with self.assertRaises(main.HTTPException) as caught:
                main._require_popup_admin_password("wrong")
            self.assertEqual(caught.exception.status_code, 401)
            self.assertIn("일치하지 않습니다", caught.exception.detail)

    def test_notice_save_and_reload_preserves_korean_and_enabled_state(self):
        from backend.app import main
        with tempfile.TemporaryDirectory() as directory, patch.object(main, "POPUP_NOTICE_PATH", Path(directory) / "notice.json"), patch.dict(os.environ, {"DOO_ADMIN_POPUP_PASSWORD": "test-only"}):
            result = main.update_popup_notice(main.PopupNoticeUpdatePayload(password="test-only", message="공지 확인\n새로운 안내입니다.", enabled=True))
            self.assertTrue(json.loads(result.body)["ok"])
            notice = json.loads(main.get_popup_notice().body)
            self.assertTrue(notice["enabled"])
            self.assertEqual(notice["message"], "공지 확인\n새로운 안내입니다.")

    def test_usage_rows_include_recorded_access_and_effective_legacy_plan(self):
        from backend.app import main
        from starlette.requests import Request
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folders = {name: root / name for name in ("USER_BILLING_DIR", "USER_ACTIVITY_DIR", "PAYMENT_USAGE_DIR", "JOBS_DIR")}
            for folder in folders.values(): folder.mkdir()
            with patch.multiple(main, **folders), patch.object(main, "_user_activity_path", side_effect=lambda user: folders["USER_ACTIVITY_DIR"] / f"{user}.json"), patch.object(main, "_user_email_activity_path", side_effect=lambda email: folders["USER_ACTIVITY_DIR"] / "email.json"):
                main._save_json(folders["USER_BILLING_DIR"] / "legacy.json", {"user_id": "legacy", "user_email": "test@example.invalid", "plan_code": "free", "legacy_full_access": True})
                request = Request({"type": "http", "scheme": "https", "server": ("example.invalid", 443), "path": "/api/billing/status", "query_string": b"", "method": "GET", "headers": []})
                main._record_user_activity(request, "legacy", "test@example.invalid")
                _, rows = main._collect_popup_admin_usage_rows()
                row = next(row for row in rows if row["user_id"] == "legacy")
                self.assertEqual(row["plan_code"], "legacy")
                self.assertTrue(row["last_accessed_at"])
                self.assertEqual(row["last_access_path"], "/api/billing/status")
