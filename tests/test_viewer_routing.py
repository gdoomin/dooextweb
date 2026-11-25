import os
import tempfile
import unittest

from starlette.routing import Match


class ViewerRoutingTests(unittest.TestCase):
    def test_korean_download_filename_uses_utf8_header(self):
        from unittest.mock import patch
        from urllib.parse import unquote
        from backend.app import main

        job = {"project_name": "한글검증", "filename": "한글검증.kml", "text_output": "한글 내용", "results": [], "mode": "linestring"}
        with patch.object(main, "_load_job", return_value=job), patch.object(main, "_job_owner_billing_status", return_value={}), patch.object(main, "_has_feature_access", return_value=True):
            for download in (main.download_txt, main.download_xlsx):
                response = download("sample-job")
                header = response.headers["content-disposition"]
                header.encode("ascii")
                self.assertIn("filename*=UTF-8''", header)
                self.assertIn("한글검증", unquote(header))

    def test_default_viewer_is_not_treated_as_a_saved_job(self):
        with tempfile.TemporaryDirectory() as runtime:
            from unittest.mock import patch

            with patch.dict(os.environ, {"DOO_DATA_DIR": runtime}):
                from backend.app.main import app, get_default_viewer, get_viewer

            for path, endpoint in (
                ("/api/viewer/default", get_default_viewer),
                ("/api/viewer/sample-job", get_viewer),
            ):
                scope = {"type": "http", "method": "GET", "path": path, "root_path": ""}
                matched = next(route for route in app.routes if route.matches(scope)[0] == Match.FULL)
                self.assertIs(matched.endpoint, endpoint)


if __name__ == "__main__":
    unittest.main()
