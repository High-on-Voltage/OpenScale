#!/usr/bin/env python3
"""Small host-side tests for the static-asset prebuild format."""
from __future__ import annotations

import gzip
import struct
import tempfile
import unittest
from pathlib import Path

from pack_web_assets import ENTRY, HEADER, MAGIC, build


class AssetPackTests(unittest.TestCase):
    def test_merge_compress_and_keep_sources_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            www = root / "www"
            webui = root / "WebUI"
            www.mkdir()
            (www / "default.html").write_bytes(b"recovery page")
            (webui / "assets").mkdir(parents=True)
            (webui / "assets" / "app.js").write_bytes(b"const x = 1;\n")
            (webui / "VERSION").write_text("0.17\n", encoding="ascii")
            (webui / "LICENSE").write_text("asset license", encoding="ascii")
            gzip_dir = root / "build" / ".prebuild" / "gzip"
            pack = root / "build" / ".prebuild" / "assets.pack"
            asm = root / "build" / "assets.S"

            source_before = (webui / "assets" / "app.js").read_bytes()
            names = build(www, webui, gzip_dir, pack, asm)
            self.assertEqual(names, ["LICENSE", "assets/app.js", "default.html"])
            self.assertEqual((webui / "assets" / "app.js").read_bytes(), source_before)
            self.assertEqual(gzip.decompress((gzip_dir / "assets" / "app.js.gz").read_bytes()), source_before)
            self.assertIn(b".incbin", asm.read_bytes())

            blob = pack.read_bytes()
            build(www, webui, gzip_dir, pack, asm)
            self.assertEqual(pack.read_bytes(), blob, "asset pack should be reproducible")
            magic, version, count, total = HEADER.unpack_from(blob)
            self.assertEqual((magic, version, count, total), (MAGIC, 1, 3, len(blob)))
            offset = HEADER.size
            seen = {}
            for _ in range(count):
                path_len, flags, data_len = ENTRY.unpack_from(blob, offset)
                offset += ENTRY.size
                path = blob[offset:offset + path_len].decode("utf-8")
                offset += path_len
                payload = blob[offset:offset + data_len]
                offset += data_len
                self.assertEqual(flags, 0)
                seen[path] = gzip.decompress(payload)
            self.assertEqual(offset, len(blob))
            self.assertEqual(seen["assets/app.js"], source_before)

    def test_duplicate_virtual_paths_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            www = root / "www"
            webui = root / "WebUI"
            www.mkdir()
            webui.mkdir()
            (www / "index.html").write_text("a", encoding="ascii")
            (webui / "index.html").write_text("b", encoding="ascii")
            with self.assertRaisesRegex(ValueError, "collision"):
                build(www, webui, root / ".prebuild" / "gzip", root / ".prebuild" / "pack", root / ".prebuild" / "embed.S")

    def test_reserved_firmware_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            www = root / "www"
            webui = root / "WebUI"
            www.mkdir()
            webui.mkdir()
            (webui / "api").mkdir()
            (webui / "api" / "device.json").write_text("{}", encoding="ascii")
            with self.assertRaisesRegex(ValueError, "reserved by firmware"):
                build(www, webui, root / ".prebuild" / "gzip", root / ".prebuild" / "pack", root / ".prebuild" / "embed.S")

    def test_default_namespace_is_owned_by_www(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            www = root / "www"
            webui = root / "WebUI"
            www.mkdir()
            webui.mkdir()
            (webui / "Default.html").write_text("not a recovery file", encoding="ascii")
            with self.assertRaisesRegex(ValueError, "Reserved firmware recovery"):
                build(www, webui, root / ".prebuild" / "gzip", root / ".prebuild" / "pack", root / ".prebuild" / "embed.S")


if __name__ == "__main__":
    unittest.main()
