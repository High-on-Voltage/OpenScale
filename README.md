# OpenScale ESP32 firmware — v0.2.0

ESP-IDF C++ firmware for an ESP32 multi-sensor node. This is a v0.2 migration checkpoint toward the v0.5 project, JSON-file and HTTP/SSE specifications; it is not a claim that every v0.5 feature has been completed or hardware-validated.

## Version sources

- `VERSION`: firmware semantic version (`0.2.0`).
- `WebUI/VERSION`: compatible WebUI release (`0.17`).
- `main/version.hpp`: compile-time access to both versions, build ID and Git commit.
- `GET /api/device`: exposes `firmwareVersion`, `webuiVersion`, `buildId`, `gitCommit` and `espIdfVersion`.

A source archive without Git metadata reports `unknown` for the commit and `local` for the build ID.

## Repository and virtual WebUI root

```text
VERSION
WebUI/                  WebUI source (v0.17)
  VERSION               build metadata; not served as an asset
www/                    firmware-owned recovery/static assets
main/                   ESP-IDF application component
config/                 factory/example JSON resources
 tools/                 host-side asset packer and tests
```

The former `main/www/` tree is now `/www`. The WebUI source lives in `/WebUI`. CMake maps both folders into one virtual web root using their relative paths. For example, `WebUI/assets/app.js` is served as `/assets/app.js`. The build does not rewrite, rename, minify or otherwise mutate either source tree. A path collision is an error; firmware-reserved namespaces cannot be supplied as assets; root `default.*` recovery assets are owned by `/www`.

## Gzip prebuild

`tools/pack_web_assets.py` runs during CMake configuration. It creates deterministic gzip files and an embedded asset pack under the hidden build prebuild directory:

```text
build/main/.prebuild/gzip/<virtual-path>.gz
build/main/.prebuild/web_assets.pack
build/main/.prebuild/web_assets.S
```

Generated files never go into `/www` or `/WebUI`. The embedded pack seeds missing files into `/data/www/` as gzip bytes; existing on-device files are preserved as user-managed overrides. Static GET responses use `Content-Encoding: gzip`.

## Configuration migration

Factory files under `config/` now follow the v0.5 JSON formats:

- `settings.json`: `schemaVersion`, `http_indexpath`, `redirectToHostname`, `buffer.ringbuffer_max_total_size_bytes`, `buffer.queue_capacity`, `https.enabled`, and security state.
- `wifi.json`: independent `networks[]` with stable numeric IDs and priorities, plus the `ap` object.
- `sensors.json`: `schemaVersion` and one `sensors[]` collection using `rate_hz`, `ringbuffer_size_samples`, `rawFormat`, driver blocks and raw warning thresholds.
- `units.json`: WebUI-owned unit table.
- `webui-settings.json`: WebUI-owned preferences; factory document is `{"schemaVersion":1}`.

The API exposes the same-resource GET/PUT/DELETE paths under `/data/settings/`. Passwords are redacted from GET responses; administrator passwords use the write-only `security.password` API field, and Wi-Fi passwords are preserved by network ID when omitted. Unknown JSON keys are retained by raw resource PUTs and by serial-side settings/Wi-Fi updates. Calibration resources use `/data/calibration/calibration_<sensorId>_<profileId>.json`; assets/calibration uploads are gzip data.

## Implemented protocol subset

The firmware currently includes `/api/device`, `/api/status`, `/api/device-log`, `/api/history`, `/api/files`, `/stream`, `/api/restart`, the five settings resources, calibration resources and generic static asset routes. Mutating requests require the per-boot `X-CSRF-Token`; Basic authentication is enforced where the v0.5 table requires it. History supports JSON and version-1 binary records, 64-bit integer tokens, requested ID ranges and `X-History-*` metadata. SSE currently emits individual `sample` and `device_log` events with boot-scoped global event IDs.

## Remaining v0.5 work / validation limits

- Warning-state, device-state and sensor-error SSE events are not yet implemented.
- `configRevision` and `warningRevision` are currently reported as their initial value; live driver reconfiguration, preserving/clearing buffer resize and revision increments are not implemented.
- The full Wi-Fi reconnect policy (retrying the complete network list every 30 seconds), mDNS/hostname redirects, full `/api/device` hardware/partition/capability metadata, and complete status observability still need implementation/target validation.
- The Wi-Fi PUT response does not yet include the canonical redacted configuration with newly assigned network IDs. A follow-up GET returns the canonical file.
- Static-asset uploads currently check the gzip signature, not full DEFLATE-stream integrity. Calibration uploads intentionally remain opaque gzip bytes as specified.
- Warning-state, device-state and sensor-error SSE events, live `configRevision`/`warningRevision` increments, sensor runtime reconfiguration, and preserving/clearing buffer resize are not yet implemented.
- PSRAM-aware ring-buffer allocation and validation across ESP32, S2, S3, C3 and C6 are not yet complete.
- No ESP-IDF build or hardware test is claimed for this archive. The ESP-IDF 6.1.x toolchain must be installed and the target/partition table selected and validated before flashing.

Host-side tests (no ESP-IDF required):

```sh
python -m unittest discover -s tools -p 'test_*.py' -v
```

## Storage safety

FATFS is mounted over ESP-IDF flash wear levelling. Automatic formatting is disabled on mount failure so settings and user assets are not silently destroyed. Provisioning/recovery of a blank or damaged partition must be an explicit service action.

## License

AGPL-3.0-or-later. See `LICENSE`.
