# OpenScale ESP32 firmware — v0.2.0

ESP-IDF C++ firmware scaffold for an ESP32 multi-sensor node. This revision establishes the v0.2 version source and WebUI asset build pipeline. The full WebUI source is maintained separately and is not included in this archive.

## Version sources

- `VERSION` is the single firmware semantic-version source (`0.2.0`).
- `WebUI/VERSION` identifies the compatible WebUI release (`0.17`).
- C++ code includes `main/version.hpp`, which exposes `app::version::firmware`, `app::version::webui`, `app::version::build_id` and `app::version::git_commit`.
- `GET /api/device` includes `firmwareVersion` and `webuiVersion`, plus `buildId`, `gitCommit` and `espIdfVersion`. The WebUI can read both release versions from this endpoint.

The git commit/build ID are obtained during CMake configuration. A source archive without `.git` reports `unknown` / `local`.

## Repository layout

```text
VERSION                 Firmware version
WebUI/                  Separately maintained WebUI source (v0.17)
  VERSION               WebUI version metadata; not served as an asset
www/                    Firmware-owned static/recovery assets
main/                   ESP-IDF application component
config/                 Example configuration files
tools/                  Host-side build helpers and tests
```

`main/www/` has been moved to the repository-root `www/` directory. The build combines the relative contents of `www/` and `WebUI/` into one virtual web root. Paths are retained, so `WebUI/assets/app.js` is available to the firmware as `/assets/app.js`.

The build does not rewrite, minify, rename or otherwise modify source assets. It only creates gzip representations. A duplicate relative path in `www/` and `WebUI/` is a build error rather than an implicit overwrite. Hidden files/directories are ignored. `WebUI/VERSION` is build metadata and is not copied to the virtual web root. The firmware-reserved `/api`, `/data` and `/stream` paths cannot be supplied as static assets; root-level `default.*` recovery assets belong to `www/`.

## Gzip asset prebuild

`tools/pack_web_assets.py` runs during CMake configuration. It creates deterministic gzip files and an embedded asset pack under the hidden ESP-IDF build directory:

```text
build/main/.prebuild/gzip/<virtual-path>.gz
build/main/.prebuild/web_assets.pack
build/main/.prebuild/web_assets.S
```

No generated `.gz` files are written into `www/` or `WebUI/`. The pack is embedded into the firmware. On filesystem startup, assets missing from `/data/www/` are seeded as `/data/www/<virtual-path>.gz`; existing files are preserved as user-managed overrides. Nested paths are supported by firmware serving, listing, upload and rename handling. Static GET responses use `Content-Encoding: gzip`.

Run the host-side packer tests without ESP-IDF:

```sh
python -m unittest discover -s tools -p 'test_*.py' -v
```

## Toolchain and build

Target ESP-IDF **6.1.x** and its native CMake/toolchain; no Arduino framework is used. Select the board/chip before building:

```sh
idf.py set-target esp32
idf.py build
idf.py -p PORT flash monitor
```

Replace `esp32` with the actual target. GPIO/peripheral availability remains board-specific. The checked-in `sdkconfig.defaults` and partition table are still starter settings and must be reviewed against the selected board's flash size and hardware.

## Current implementation boundary

This code is a v0.2 migration checkpoint, not a claim that the complete v0.5 requirements contract is implemented. The original v0.1.0 sensor/network/configuration implementation remains in place behind its existing API and JSON schema. In particular, the v0.5 endpoint split (`/api/device` vs `/api/status`), configuration resource paths/schemas, CSRF handling, global boot-scoped SSE IDs, binary history format, Wi-Fi network-list model and full device log still require their own implementation work. Do not treat this scaffold as v0.5 protocol-compatible yet.

The current `/api/device` payload remains the earlier mixed metadata/runtime payload; v0.2 adds the firmware and WebUI version/build fields to it. This is an intentional transitional compatibility step.

## Storage safety note

FATFS is mounted over ESP-IDF wear levelling. Automatic formatting on a mount failure is disabled in this revision to avoid destroying settings or user assets. A new or damaged storage partition must therefore be provisioned through an explicit service procedure; the serial-only format/recovery command is not yet implemented. Do not enable automatic formatting as a workaround.

## License

AGPL-3.0-or-later. See `LICENSE`.
