# OpenScale firmware v0.3.0

ESP-IDF-native C++ firmware rewrite. Target line: ESP-IDF 6.1.x. No Arduino framework.

## Build and asset pipeline

```sh
. "$IDF_PATH/export.sh"
make build
make flash       # first provisioning only: also writes the factory FATFS image
make monitor
```

`/WebUI` and `/www` are immutable source inputs. Their contents are merged into a **virtual web root** at build/configure time; conflicting relative paths fail the build. The build does not write to either source directory. `make flash` is for first provisioning: it flashes the factory FATFS image and therefore replaces the contents of the storage partition. For routine firmware updates, use `make flash-app` to flash only the application and preserve stored settings/assets.

All firmware-served static files are stored as gzip streams while retaining their original URL path and filename. The intermediate plain and gzip trees, the virtual web root, and downloaded dependencies live under the ignored hidden `.prebuild/` directory. ESP-IDF's FATFS generator builds the initial `storage` partition image from that virtual web root. At runtime the filesystem is mounted through flash wear levelling; mount failure never triggers an automatic format.

uPlot is pinned to commit `e995b061e9fc5476a6d862cd2fb2ebc7452ca012` (1.6.32). The first build fetches it into `.prebuild/uplot/`; subsequent builds use the cache without network access. To deliberately fetch it again:

```sh
make fetch-uplot
```

Only `dist/uPlot.iife.min.js` and `dist/uPlot.min.css` are added to the virtual `/www/libs/` directory. They are stored as gzip streams while retaining their original filenames and URL paths. The downloaded upstream source and its MIT license remain in the hidden `.prebuild/uplot/` cache; no other uPlot repository files are copied into the virtual web root. The WebUI version is taken from the `OPEN_SCALE_WEBUI_VERSION` environment override, then `WebUI/version.txt`, then `WebUI/package.json`, with `not-provided` as the current fallback. It is compiled into `GET /api/device` through `webui_build_info.h`. Firmware version, build ID, Git commit and protocol/file-format versions are exposed from the generated firmware build metadata.

Built-in `/default.html` and `/default.js` are reserved diagnostic assets and cannot be overridden by `/WebUI` or `/www`.

## Project documents

The v0.5.1 contract documents are preserved in `docs/`: `Project Requirements.md`, `JSON File Formats.md` and `API Protocol.md`. The v0.3 implementation boundary and known gaps are tracked in `docs/v0.3-implementation-status.md`.

## Layout

- `main/` — firmware components
- `WebUI/` — separately developed WebUI (currently empty)
- `www/` — additional static assets (currently empty)
- `assets/default/` — firmware-owned diagnostic/recovery page
- `tools/` — hidden prebuild and gzip generation
- `.prebuild/` — generated, ignored cache (never edit manually)

## Configuration and hardware

Factory `sensors.json` is empty. No GPIO defaults are assumed. The JSON format example documents a fixed AP password and a two-byte MAC suffix, while the project requirements specify a generated device password and a three-byte suffix. This implementation follows the project requirements (device-derived secret printed to serial; final three MAC bytes). Add a sensor entry with the HX711 fields from `JSON File Formats.md`; the driver only accepts `rawFormat: "int24"` and `rate_hz` 10 or 80. A `rate_gpio` is optional; when omitted, the physical HX711 RATE pin must be strapped to the desired rate.

`partitions.csv` is only a 4 MiB ESP32 starter table and is not a universal partition map for ESP32-S2/S3/C3/C6 or larger flash sizes. Select a target-appropriate partition table before hardware deployment.

## Current implementation boundary

Wi-Fi PUT responses include a `configuration` member containing the canonical, redacted document (including ESP-assigned IDs); the v0.5.1 text requires this canonical result but does not prescribe the member name.

This is the v0.3 rewrite foundation, not a claim that every v0.5.1 protocol item has passed implementation or hardware validation. The acquisition/ring-buffer path, HX711, device log/event fan-out, basic metadata/status/history/SSE, FATFS storage, build-time asset packaging, serial recovery commands and configuration resource handlers are present. Wi-Fi static-IP application, hostname/mDNS redirects, full config-diff classification/live sensor reconfiguration, file listing completeness, all history edge cases, and full multi-target build/hardware validation remain to be completed and tested.
