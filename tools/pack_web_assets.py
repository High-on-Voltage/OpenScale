#!/usr/bin/env python3
"""Build a deterministic gzip asset tree and an ESP32-readable asset pack.

The source folders are never modified. Files from www/ and WebUI/ are mapped
into one virtual root using their relative paths. A path collision is fatal.
WebUI/VERSION is build metadata and is deliberately not served as an asset.
"""
from __future__ import annotations

import argparse
import gzip
import re
import shutil
import struct
import sys
from pathlib import Path, PurePosixPath

MAGIC = b"OSWA"
PACK_VERSION = 1
HEADER = struct.Struct("<4sHHI")  # magic, format version, entry count, total bytes
ENTRY = struct.Struct("<HHI")     # path bytes, reserved flags, gzip bytes
MAX_PATH_BYTES = 120


def _asset_files(source: Path, *, skip_version: bool = False) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    if not source.exists():
        return result
    if not source.is_dir():
        raise ValueError(f"Asset source is not a directory: {source}")

    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(source).as_posix()
        # Ignore editor/OS metadata and hidden build artifacts.
        if any(part.startswith(".") for part in PurePosixPath(rel).parts):
            continue
        if skip_version and rel == "VERSION":
            continue
        encoded = rel.encode("utf-8")
        if not encoded or len(encoded) > MAX_PATH_BYTES:
            raise ValueError(f"Asset path must be 1..{MAX_PATH_BYTES} UTF-8 bytes: {rel}")
        pure = PurePosixPath(rel)
        if (rel.startswith("/") or "\\" in rel or ".." in pure.parts or
                not re.fullmatch(r"[A-Za-z0-9._/-]+", rel) or
                any(part.startswith(".") for part in pure.parts)):
            raise ValueError(f"Unsafe asset path: {rel}")
        if "//" in rel or any(part in {"", ".", ".."} for part in pure.parts):
            raise ValueError(f"Unsafe asset path: {rel}")
        if pure.parts[0] in {"api", "data"} or (len(pure.parts) == 1 and pure.parts[0] == "stream"):
            raise ValueError(f"Asset path is reserved by firmware: {rel}")
        result[rel] = path.read_bytes()
    return result


def _gzip_bytes(data: bytes) -> bytes:
    # mtime=0 makes identical inputs reproducible. Normalize the OS marker too.
    blob = bytearray(gzip.compress(data, compresslevel=9, mtime=0))
    if len(blob) >= 10:
        blob[9] = 255
    return bytes(blob)


def build(www: Path, webui: Path, gzip_dir: Path, output: Path, asm: Path) -> list[str]:
    assets = _asset_files(www)  # firmware recovery assets are added first
    webui_assets = _asset_files(webui, skip_version=True)
    for rel in webui_assets:
        if len(PurePosixPath(rel).parts) == 1 and rel.lower().startswith("default."):
            raise ValueError(f"Reserved firmware recovery asset must live in www/: {rel}")
    if len(assets) + len(webui_assets) > 0xFFFF:
        raise ValueError("Too many virtual assets (maximum 65535)")
    collisions = sorted(set(assets).intersection(webui_assets))
    if collisions:
        joined = ", ".join(collisions)
        raise ValueError(f"Virtual asset path collision between www/ and WebUI/: {joined}")
    assets.update(webui_assets)

    if gzip_dir.exists():
        shutil.rmtree(gzip_dir)
    gzip_dir.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    asm.parent.mkdir(parents=True, exist_ok=True)

    records: list[tuple[bytes, bytes]] = []
    for rel in sorted(assets):
        rel_bytes = rel.encode("utf-8")
        compressed = _gzip_bytes(assets[rel])
        if len(compressed) > 0xFFFFFFFF:
            raise ValueError(f"Compressed asset is too large for the pack format: {rel}")
        gzip_path = gzip_dir.joinpath(*PurePosixPath(rel).parts)
        gzip_path = gzip_path.with_name(gzip_path.name + ".gz")
        gzip_path.parent.mkdir(parents=True, exist_ok=True)
        gzip_path.write_bytes(compressed)
        records.append((rel_bytes, compressed))

    body = bytearray(HEADER.size)
    for rel_bytes, compressed in records:
        body += ENTRY.pack(len(rel_bytes), 0, len(compressed))
        body += rel_bytes
        body += compressed
    HEADER.pack_into(body, 0, MAGIC, PACK_VERSION, len(records), len(body))
    output.write_bytes(body)

    # The generated assembler embeds one pack, independent of the number and
    # names of the source assets. C++ refers to stable web_assets_start/end IDs.
    incbin_path = str(output.resolve()).replace("\\", "\\\\").replace('"', '\\"')
    asm.write_text(
        ".section .rodata\n"
        ".balign 4\n"
        ".global web_assets_start\n"
        "web_assets_start:\n"
        f'.incbin "{incbin_path}"\n'
        ".global web_assets_end\n"
        "web_assets_end:\n",
        encoding="ascii",
    )
    return sorted(assets)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--www", type=Path, required=True)
    parser.add_argument("--webui", type=Path, required=True)
    parser.add_argument("--gzip-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--asm", type=Path, required=True)
    args = parser.parse_args()

    try:
        names = build(args.www, args.webui, args.gzip_dir, args.output, args.asm)
    except (OSError, ValueError) as exc:
        print(f"asset prebuild failed: {exc}", file=sys.stderr)
        return 1
    total = args.output.stat().st_size
    print(f"Prepared {len(names)} virtual web asset(s), {total} packed bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
