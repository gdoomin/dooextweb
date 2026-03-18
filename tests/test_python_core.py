import unittest

from shared.python_core.core import build_web_map_payload, dd_to_dms, format_text


class DmsFormattingTests(unittest.TestCase):
    def test_rounds_up_to_next_minute(self):
        self.assertEqual(dd_to_dms(127.1, is_lat=False), '127\u00B006\'00.00"E')
        self.assertEqual(dd_to_dms(37.8, is_lat=True), '37\u00B048\'00.00"N')

    def test_rounds_up_to_next_degree(self):
        self.assertEqual(dd_to_dms(127.999999, is_lat=False), '128\u00B000\'00.00"E')

    def test_preserves_direction(self):
        self.assertEqual(dd_to_dms(-37.8, is_lat=True), '37\u00B048\'00.00"S')
        self.assertEqual(dd_to_dms(-127.1, is_lat=False), '127\u00B006\'00.00"W')

    def test_format_text_uses_normalized_dms_output(self):
        output = format_text(
            [
                {
                    "num": "1",
                    "s_lat": 37.5,
                    "s_lon": 127.1,
                    "e_lat": 37.8,
                    "e_lon": 127.999999,
                }
            ],
            project_name="sample",
            mode="linestring",
        )

        self.assertNotIn("60.00", output)
        self.assertIn('127\u00B006\'00.00"E', output)
        self.assertIn('37\u00B048\'00.00"N', output)
        self.assertIn('128\u00B000\'00.00"E', output)

    def test_build_web_map_payload_includes_total_length_and_capture_time(self):
        payload = build_web_map_payload(
            [
                {"num": "1", "s_lat": 0.0, "s_lon": 0.0, "e_lat": 0.0, "e_lon": 1.0},
                {"num": "2", "s_lat": 0.0, "s_lon": 1.0, "e_lat": 0.0, "e_lon": 2.0},
            ],
            "demo",
            "linestring",
        )

        self.assertEqual(
            payload["meta_text"],
            "\u0032\uac1c \ub77c\uc778 \u00b7 \ucd1d\uae38\uc774 222.4km \u00b7 \ucd1d\ucd2c\uc601\uc2dc\uac04 : \ub300\ub7b5 1.0\uc2dc\uac04",
        )


if __name__ == "__main__":
    unittest.main()
