#!/usr/bin/env python3
"""Build an immutable virtual web root from /WebUI and /www, as gzip files."""
from __future__ import annotations
import argparse
import gzip
import json
import os
import shutil
import sys
from pathlib import Path

from fetch_uplot import COMMIT, fetch


def read_webui_version(project_root: Path) -> str:
    override = os.environ.get("OPEN_SCALE_WEBUI_VERSION")
    if override:
        return override.strip()
    version_file = project_root / "WebUI" / "version.txt"
    if version_file.is_file():
        value = version_file.read_text(encoding="utf-8").strip()
        if value:
            return value
    package_file = project_root / "WebUI" / "package.json"
    if package_file.is_file():
        try:
            data = json.loads(package_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("version"), str) and data["version"].strip():
                return data["version"].strip()
        except (OSError, json.JSONDecodeError):
            pass
    return "not-provided"


def copy_source_files(
    source_roots: list[tuple[Path, str]],
    staged_plain: Path,
    excluded_files: set[Path] | None = None,
) -> None:
    # Exclusions are exact source paths, so a same-named file in /www is unaffected.
    excluded = {path.resolve() for path in (excluded_files or set())}
    seen: dict[str, bytes] = {}
    for root, prefix in source_roots:
        if not root.is_dir():
            continue
        for file in sorted(root.rglob("*")):
            if not file.is_file() or file.resolve() in excluded:
                continue
            rel = file.relative_to(root)
            if ".git" in rel.parts or file.name in {".gitkeep", ".gitignore", ".DS_Store"}:
                continue
            virtual = (Path(prefix) / rel).as_posix().lstrip("/")
            payload = file.read_bytes()
            if virtual in seen:
                if seen[virtual] != payload:
                    raise RuntimeError(f"Conflicting virtual asset path: /{virtual}")
                continue
            seen[virtual] = payload
    for relative, payload in seen.items():
        target = staged_plain / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)


def add_uplot(source_root: Path, staged_plain: Path) -> None:
    # Only ship the pinned production JS and CSS distribution assets. The upstream
    # source tree and its MIT license remain in the hidden .prebuild cache.
    destination = staged_plain / "www" / "libs"
    assets = ("uPlot.iife.min.js", "uPlot.min.css")
    for filename in assets:
        source = source_root / "dist" / filename
        if not source.is_file():
            raise RuntimeError(f"uPlot distribution file is missing: dist/{filename}")
        target = destination / filename
        if target.is_file():
            if target.read_bytes() != source.read_bytes():
                raise RuntimeError(f"Conflicting uPlot virtual asset path: /www/libs/{filename}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def gzip_tree(staged_plain: Path, gzip_root: Path) -> int:
    shutil.rmtree(gzip_root, ignore_errors=True)
    gzip_root.mkdir(parents=True, exist_ok=True)
    count = 0
    for source in sorted(p for p in staged_plain.rglob("*") if p.is_file()):
        relative = source.relative_to(staged_plain)
        target = gzip_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as f_in, target.open("wb") as f_out:
            with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=f_out, mtime=0) as gz:
                shutil.copyfileobj(f_in, gz)
        count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--virtual-root", type=Path, required=True)
    parser.add_argument("--generated-header", type=Path, required=True)
    args = parser.parse_args()
    root = args.project_root.resolve()
    prebuild = root / ".prebuild"
    plain = prebuild / "plain_webroot"
    gzipped = prebuild / "gzip_webroot"
    virtual_root = args.virtual_root.resolve()
    generated_header = args.generated_header.resolve()

    try:
        uplot_root = fetch(root, force=False)
        shutil.rmtree(plain, ignore_errors=True)
        plain.mkdir(parents=True, exist_ok=True)
        copy_source_files(
            [(root / "WebUI", ""), (root / "www", "")],
            plain,
            excluded_files={root / "WebUI" / "audit_harness.js"},
        )

        # Built-in recovery assets are firmware-owned and cannot be overridden by WebUI files.
        #for reserved in ("default.html", "default.js"):
        #    if (plain / reserved).exists():
        #        raise RuntimeError(f"/{reserved} is reserved by firmware and cannot be supplied by WebUI/www")
        #copy_source_files([(root / "assets" / "default", "")], plain)
        add_uplot(uplot_root, plain)

        shutil.rmtree(virtual_root, ignore_errors=True)
        count = gzip_tree(plain, gzipped)
        shutil.copytree(gzipped, virtual_root, dirs_exist_ok=True)

        version = read_webui_version(root)
        generated_header.parent.mkdir(parents=True, exist_ok=True)
        def c_string(value: str) -> str:
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r") + '"'

        generated_header.write_text(
            "#pragma once\n"
            f"#define OPEN_SCALE_WEBUI_VERSION {c_string(version)}\n"
            f'#define OPEN_SCALE_UPLOT_COMMIT "{COMMIT}"\n',
            encoding="utf-8",
        )
        print(f"Web assets: {count} gzip files -> {virtual_root}")
        print(f"WebUI version: {version}; uPlot: {COMMIT}")
        return 0
    except Exception as exc:
        print(f"ERROR: web asset preparation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
