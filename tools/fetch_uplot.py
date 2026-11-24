#!/usr/bin/env python3
"""Fetch the exact uPlot commit into the ignored .prebuild cache."""
from __future__ import annotations
import argparse
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

COMMIT = "e995b061e9fc5476a6d862cd2fb2ebc7452ca012"
REPO = "https://github.com/leeoniya/uPlot"
ARCHIVE_URL = f"{REPO}/archive/{COMMIT}.tar.gz"


def safe_extract(archive: tarfile.TarFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.getmembers():
        target = (destination / member.name).resolve()
        if target != root and root not in target.parents:
            raise RuntimeError(f"Unsafe archive path: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise RuntimeError(f"Unsupported archive entry: {member.name}")
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise RuntimeError(f"Could not read archive entry: {member.name}")
        with source, target.open("wb") as output:
            shutil.copyfileobj(source, output)


def fetch(project_root: Path, force: bool = False) -> Path:
    cache_root = project_root / ".prebuild" / "uplot"
    source_root = cache_root / COMMIT / "source"
    marker = cache_root / COMMIT / ".complete"
    archive_path = cache_root / f"uplot-{COMMIT}.tar.gz"
    if marker.is_file() and all((source_root / path).is_file() for path in ("dist/uPlot.iife.min.js", "dist/uPlot.min.css", "LICENSE")) and not force:
        print(f"uPlot cache valid: {source_root}")
        return source_root

    cache_root.mkdir(parents=True, exist_ok=True)
    if force:
        shutil.rmtree(cache_root / COMMIT, ignore_errors=True)
        archive_path.unlink(missing_ok=True)

    if not archive_path.is_file():
        print(f"Downloading uPlot commit {COMMIT} ...")
        request = urllib.request.Request(
            ARCHIVE_URL,
            headers={"User-Agent": "OpenScale-build/0.3", "Accept": "application/vnd.github+json"},
        )
        temporary_archive = archive_path.with_suffix(archive_path.suffix + ".part")
        temporary_archive.unlink(missing_ok=True)
        try:
            with urllib.request.urlopen(request, timeout=60) as response, temporary_archive.open("wb") as out:
                shutil.copyfileobj(response, out)
            temporary_archive.replace(archive_path)
        except Exception:
            temporary_archive.unlink(missing_ok=True)
            raise

    extract_root = cache_root / COMMIT / "extract"
    shutil.rmtree(extract_root, ignore_errors=True)
    extract_root.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            safe_extract(archive, extract_root)
        roots = [p for p in extract_root.iterdir() if p.is_dir()]
        if len(roots) != 1:
            raise RuntimeError("Unexpected uPlot source archive layout")
        extracted = roots[0]
        required = [extracted / "dist" / "uPlot.iife.min.js", extracted / "dist" / "uPlot.min.css", extracted / "LICENSE"]
        missing = [str(p.relative_to(extracted)) for p in required if not p.is_file()]
        if missing:
            raise RuntimeError("uPlot archive is missing: " + ", ".join(missing))
        source_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(source_root, ignore_errors=True)
        shutil.move(str(extracted), str(source_root))
        marker.write_text(f"commit={COMMIT}\nurl={ARCHIVE_URL}\n", encoding="utf-8")
    except Exception:
        shutil.rmtree(cache_root / COMMIT, ignore_errors=True)
        # A corrupt archive must not poison every subsequent first-build attempt.
        try:
            with tarfile.open(archive_path, "r:gz") as archive:
                archive.getmembers()
        except Exception:
            archive_path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(extract_root, ignore_errors=True)

    print(f"uPlot ready: {source_root}")
    return source_root


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--force", action="store_true", help="force a fresh download")
    args = parser.parse_args()
    try:
        fetch(args.project_root.resolve(), args.force)
        return 0
    except Exception as exc:
        print(f"ERROR: uPlot fetch failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
