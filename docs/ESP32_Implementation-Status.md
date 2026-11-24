# OpenScale v0.3.0 — implementation status

This is the first clean firmware rewrite based on the v0.5.1 project, JSON-format and API-protocol documents. It is a working source foundation, not a claim of full v0.5.1 conformance.

## Implemented in this revision

- ESP-IDF C++ application structure; HX711 component dependency pinned through the IDF component manager.
- Firmware version, build ID, Git revision, WebUI version, protocol version and file-format versions compiled into the firmware and exposed by `/api/device`.
- Human-readable factory JSON source files under `assets/default/`; build-time validation and generation into immutable `const` application-image data. These JSON files are not published into `/www` and are not runtime-editable.
- Runtime JSON configuration kept separately under `/data/settings/`; missing files are initialized from embedded defaults, DELETE restores from those defaults, and corrupt/unreadable files use in-memory defaults without automatic overwrite.
- API response generation primarily uses fixed templates, JSON string escaping and exact decimal formatting for uint64 values. cJSON remains for parsing and controlled modification of configuration documents, including unknown-key preservation.
- Hidden `.prebuild/` staging for immutable `/WebUI` + `/www` inputs, gzip outputs, virtual root and downloaded uPlot source.
- uPlot source pinned to commit `e995b061e9fc5476a6d862cd2fb2ebc7452ca012`; first configure/build downloads it, following builds reuse the cache. `make fetch-uplot` forces a fresh fetch.
- Only `dist/uPlot.iife.min.js` and `dist/uPlot.min.css` are copied to virtual `/www/libs/` and gzip-compressed without changing their filenames or URL paths. All other downloaded uPlot files, including its MIT license, remain in the hidden `.prebuild/uplot/` cache.
- FATFS partition image generation and runtime FATFS mounting through flash wear levelling. Failed mounts do not trigger automatic formatting.
- HX711 acquisition tasks, shared non-blocking FreeRTOS queue, per-sensor RAM ring buffers, per-sensor sample IDs, monotonic timestamps, queue-drop counters and threshold-warning transitions.
- Basic JSON/binary history, SSE sample/event transport, bounded per-boot device log, metadata/status endpoints, config/calibration/static-resource handlers and serial recovery commands.
- Wi-Fi event callbacks now perform only state updates and non-blocking enqueueing; a dedicated worker records Wi-Fi diagnostics.
- Fallback AP captive portal support: DHCP DNS/captive-portal hints, DNS A-record redirection to the AP, and root-page redirects for unknown HTTP paths from AP clients.
- Startup configuration loads and static asset responses are identified in serial logs; generic storage reads are additionally available at DEBUG level.
- Routine firmware development updates use `make flash-app`, which leaves the separate FATFS data partition untouched; `make flash` remains the provisioning path that also flashes the filesystem image.

## Known implementation gaps

- Only HX711 acquisition is implemented. Other sensor types, disconnection detection and a live sensor-manager/reconfiguration lifecycle are not implemented.
- Sensor config changes and system/Wi-Fi settings are currently saved as `needs-restart`; the full config-diff classification and live `needs-sensor-reconfig` path are not implemented. `configRevision` and `warningRevision` are initialised to 1 each boot and are not advanced by live changes.
- `?buffer=preserve|clear` runtime resize semantics are not implemented. History is RAM-only and is lost on a full restart.
- Wi-Fi static `ip`/`subnet` application, generated first-boot hostname, mDNS advertisement, `redirectToHostname` and HTTPS redirects are not implemented. HTTPS remains rejected while unavailable.
- The device metadata response is a baseline and does not yet report every hardware/partition detail required by the protocol (for example full flash/partition/filesystem type and PSRAM type). `unixtimestamp` remains `null`.
- `/api/files` is an initial listing implementation; full path indexing, all error/permission edge cases and recovery behaviour need validation.
- History range/truncation handling is implemented at a basic level but needs exhaustive testing for evicted boundaries, sparse IDs and all pagination cases. `maxHistoryChunk` is currently fixed at 5000.
- Firmware warning flags 0–1 are generated from current HX711 thresholds. Historical disconnection/error/invalid-measurement flags (bits 2–4) are not reconstructed; the HX711 path does not yet emit all such quality states.
- Static gzip upload currently checks the gzip signature; full stream integrity validation is not implemented. Calibration upload remains intentionally opaque and is stored unchanged as required.
- Password storage uses PBKDF2-HMAC-SHA256 through PSA Crypto for the ESP-IDF 6 / Mbed TLS 4 API surface. The iteration/cost choice and recovery workflow require target-hardware benchmarking and security review. Plain HTTP Basic authentication is not encrypted; use only on a trusted network.
- The starter partition table is for a 4 MiB ESP32 build only. Other targets/flash layouts require a matching partition table and target-specific GPIO/peripheral checks.

## Source-document conflict recorded for this build

The project requirements specify a generated per-device fallback-AP password printed to the serial console and an SSID suffix using the final three MAC bytes. The JSON example/default description specifies a fixed `OpenScale0123` password and a two-byte suffix. This implementation follows the project requirements: generated per-device password and final three MAC bytes. An explicit `ap.password: null` is interpreted as an intentionally open AP; this is security-sensitive and should be used only when deliberately configured.

The API protocol requires the Wi-Fi PUT response to return the canonical redacted configuration including ESP-assigned IDs, but does not name the response property. This implementation uses `configuration`.

## Validation status

- The user-provided ESP-IDF 6.1.1 compile logs were reviewed. The configure/dependency stage completed; the listed source failures were addressed: Mbed TLS PBKDF2 API migration, raw-string collision removed with external defaults, fixed-array URI checks, format argument types, bounded Wi-Fi SSID copy and device-log output sizing.
- Python build-tool syntax, factory-default generation, generated C++ compilation with a host compiler, and staged gzip/virtual-root content can be tested locally without ESP-IDF.
- The Wi-Fi event-stack/captive-portal and serial file-diagnostic changes are source-level updates only. No ESP-IDF installation is available in the current build environment; no firmware compile, flash, runtime, or hardware test is claimed. Rebuild and verify on the user's ESP-IDF 6.1.1 target before treating these changes as validated.
- The supplied WebUI folder is empty, so the compiled WebUI version fallback is `not-provided` until a version override, `WebUI/version.txt`, or `WebUI/package.json` is supplied.
