#!/usr/bin/env python3
"""Host-side contract checks for shipped JSON factory files and C++ defaults."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ConfigSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.configs = {
            name: json.loads((ROOT / "config" / f"{name}.json").read_text(encoding="utf-8"))
            for name in ("settings", "wifi", "sensors", "units", "webui-settings")
        }
        cls.cpp = (ROOT / "main" / "config_store.cpp").read_text(encoding="utf-8")
        cls.http = (ROOT / "main" / "http_server.cpp").read_text(encoding="utf-8")

    def test_all_structured_factory_files_use_schema_version_one(self) -> None:
        for name, document in self.configs.items():
            with self.subTest(name=name):
                self.assertIsInstance(document, dict)
                self.assertEqual(document.get("schemaVersion"), 1)

    def test_settings_uses_v05_names_and_does_not_embed_wifi(self) -> None:
        settings = self.configs["settings"]
        self.assertEqual(settings["http_indexpath"], "/default.html")
        self.assertIn("redirectToHostname", settings)
        self.assertEqual(set(settings["buffer"]), {"ringbuffer_max_total_size_bytes", "queue_capacity"})
        self.assertNotIn("wifi", settings)
        self.assertNotIn("http_index_path", settings)
        self.assertNotIn("ringbuffer_max_bytes", settings)
        self.assertEqual(settings["security"], {})

    def test_wifi_is_separate_and_uses_v05_structure(self) -> None:
        wifi = self.configs["wifi"]
        self.assertEqual(wifi["networks"], [])
        self.assertEqual(wifi["ap"]["ssidPrefix"], "OpenScale")
        self.assertEqual(wifi["ap"]["keepApWhenConnected"], False)
        self.assertNotIn("passwordSet", wifi["ap"])

    def test_sensor_units_and_webui_factory_documents(self) -> None:
        self.assertEqual(self.configs["sensors"], {"schemaVersion": 1, "sensors": []})
        units = self.configs["units"]
        self.assertEqual((units["baseUnit"], units["defaultUnit"]), ("mg", "g"))
        self.assertEqual([item["id"] for item in units["units"]],
                         ["ug", "mg", "g", "kg", "oz_av", "lb_av", "oz_troy", "st", "raw"])
        self.assertEqual(self.configs["webui-settings"], {"schemaVersion": 1})

    def test_cpp_factory_defaults_match_shipped_files(self) -> None:
        mapping = {
            "settings": "kDefaultSettings",
            "wifi": "kDefaultWifi",
            "sensors": "kDefaultSensors",
            "units": "kDefaultUnits",
            "webui-settings": "kDefaultWebUiSettings",
        }
        for filename, symbol in mapping.items():
            with self.subTest(filename=filename):
                match = re.search(
                    rf"constexpr char {symbol}\[\] = R\"json\((.*?)\)json\";",
                    self.cpp,
                    re.DOTALL,
                )
                self.assertIsNotNone(match, f"missing C++ default {symbol}")
                embedded = json.loads(match.group(1))
                self.assertEqual(embedded, self.configs[filename])

    def test_http_uses_v05_resource_urls_not_legacy_config_routes(self) -> None:
        for path in (
            "/data/settings/settings.json",
            "/data/settings/wifi.json",
            "/data/settings/sensors.json",
            "/data/settings/units.json",
            "/data/settings/webui-settings.json",
            "/data/calibration/*",
            "/api/device",
            "/api/status",
            "/api/device-log",
            "/api/history",
            "/api/files",
            "/stream",
            "/api/restart",
        ):
            with self.subTest(path=path):
                self.assertIn(path, self.http)
        self.assertNotIn("/api/config/", self.http)

    def test_history_uses_protocol_v1_layout_and_exact_uint64_tokens(self) -> None:
        for token in (
            '"sensor_id"', '"from_id"', '"to_id"', '"X-History-Returned"',
            '"X-History-First-Id"', '"X-History-Last-Id"', '"X-History-Latest-Id"',
            '"X-History-Oldest-Id"', '"X-History-Truncated"', '"X-History-Max-Chunk"',
            r"payload[0] = 'H'", r'\"raw\"', r'\"flags\"', 'cJSON_CreateRaw(token)',
        ):
            with self.subTest(token=token):
                self.assertIn(token, self.http)

    def test_configured_index_is_not_required_to_exist_before_settings_put(self) -> None:
        self.assertNotIn("asset_exists", self.http)
        self.assertIn('"http_indexpath"', self.cpp)

    def test_versions_are_consistent(self) -> None:
        firmware = (ROOT / "VERSION").read_text(encoding="ascii").strip()
        webui = (ROOT / "WebUI" / "VERSION").read_text(encoding="ascii").strip()
        version_header = (ROOT / "main" / "version.hpp").read_text(encoding="utf-8")
        self.assertEqual(firmware, "0.2.0")
        self.assertEqual(webui, "0.17")
        self.assertIn(f'#define APP_FIRMWARE_VERSION "{firmware}"', version_header)
        self.assertIn(f'#define APP_WEBUI_VERSION "{webui}"', version_header)


if __name__ == "__main__":
    unittest.main()
