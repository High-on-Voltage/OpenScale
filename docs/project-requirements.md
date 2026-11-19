# OpenScale ESP32 — Project Requirements and Architecture

**Version:** 3.4  
**Purpose:** Firmware requirements and architecture baseline  
**Companion documents:** `json-file-formats_v3.4.md`, `api-protocol_v3.4.md`

## 1. Status terminology

- **Explicit** — directly confirmed requirement or decision.
- **Implicit** — accepted direction that was not separately confirmed in detail.
- **ESP decision** — a concrete decision made in this revision to close a previously open point.
- **Deferred** — intentionally postponed; not part of the current implementation contract.
- **Open** — genuinely unresolved and requiring further agreement.

## 2. Product scope

OpenScale is an ESP32-based multi-sensor node. Firmware acquires measurements, maintains bounded per-sensor history, exposes historical and live data, manages configuration and files, and serves the separately developed WebUI. The firmware provides HTTP APIs and one multiplexed Server-Sent Events (SSE) stream. The WebUI owns presentation, graphing, user interaction, unit conversion and user-facing load monitoring.

The initial networking target is Wi-Fi. Ethernet-capable variants are not excluded architecturally, but are not part of the initial implementation focus.

## 3. Platform, implementation and repository

| Item | Requirement | Status |
|---|---|---|
| Language/framework | C++ with ESP-IDF-native components; no Arduino framework | Explicit |
| ESP-IDF | Target the 6.1.x line; validate the selected patch release and target | Implicit |
| Initial chip validation | ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and ESP32-C6 | Implicit |
| Later targets | Consider other Wi-Fi-capable ESP32 variants after initial targets stabilise | Implicit |
| PSRAM | Optional; use it to extend history capacity when available | Explicit |
| Repository | One monorepo for firmware, WebUI, docs and tools | Explicit |
| Licence | AGPL-3.0-or-later | Implicit |
| Versioning | Semantic firmware versioning; initial proposed version `0.1.0` | Implicit |

Use ESP-IDF CMake, native HTTP server/Wi-Fi/timer/FreeRTOS facilities, cJSON and FATFS with flash wear levelling. A root `Makefile` may wrap common build operations. A suitable monorepo layout separates `firmware/`, `webui/`, `docs/` and `tools/`. Validate GPIO availability and peripheral support on each target; ESP-IDF build support alone does not mean that a board configuration has been tested.

## 4. Sensor acquisition architecture

### 4.1 Pipeline

```text
Sensor manager
  └─ Sensor driver / acquisition task(s)
       └─ Shared bounded, thread-safe sample queue
            └─ Collector
                 └─ Per-sensor ring buffer
                      ├─ GET /api/history
                      └─ GET /stream (SSE)
```

Drivers may use GPIO interrupts, polling or timed acquisition. The sensor manager owns configuration, registration and lifecycle. Each enabled sensor has a driver instance. HX711 is the initial driver; temperature, humidity, voltage, current and other sensor types may be added through the same generic model.

The acquisition queue is bounded and non-blocking for producers. When full, the new sample is dropped, the sensor's queue-drop counter increments, and the per-sensor sample counter still advances. Sequence gaps are therefore observable. Read failures and sensor disconnection are separately counted and logged.

### 4.2 Common sample model

Every sensor has a numeric ID, independent monotonically increasing sample ID, and a common monotonic timestamp. Common names are `sensorId`, `n`, `t`, `raw` and optional/computed `flags`.

| Field | Type | Meaning |
|---|---|---|
| `sensorId` | unsigned integer | Numeric sensor ID |
| `n` | unsigned 64-bit | Per-sensor sample sequence |
| `t` | unsigned 64-bit | Microseconds since boot, from one ESP-wide monotonic clock |
| `raw` | unsigned 64-bit | Zero-extended native value bit pattern; interpretation is defined by `rawFormat` |
| `flags` | unsigned 32-bit | Quality/threshold flags; computed as specified in the protocol document |

`t` must never be wall-clock time. Wall-clock correction or time synchronisation must not alter sample timestamps. A future `unixtimestamp` status field may report current UTC time independently.

`raw` is always unsigned on the wire. `rawFormat` describes how the WebUI decodes its bit pattern: `uint32`, `uint64`, `int24`, `int32`, `int64`, `float32` or `float64`. Signed values and floating-point values are zero-extended bit patterns, not numerically converted to unsigned. A lossless JSON parser is required for 64-bit JSON integer tokens because JavaScript `Number` cannot represent all uint64 values exactly.

### 4.3 HX711 baseline

The initial HX711 example uses sensor ID `0`, DOUT GPIO 16 and SCK GPIO 4. These are board-specific example pins, not universal defaults. `rate_hz` is 10 or 80. If `rate_gpio` is configured, the firmware drives it low for 10 Hz and high for 80 Hz; if null, the physical RATE pin must be strapped appropriately. `gain` accepts `A128`, `A64`, `B32` or `null` (driver/default selection).

The HX711's native value is signed 24-bit; it is carried as the low 24-bit two's-complement pattern in the uint64 `raw` field (`rawFormat: "int24"`). No offset, scale conversion, filtering or calibration is applied by the HX711 driver unless a later firmware feature explicitly adds it.

### 4.4 Sensor ownership and WebUI fields

`sensors.json` is one document for all sensors. The ESP interprets driver/runtime keys; the WebUI owns and edits presentation/analysis keys. The ESP must preserve unknown keys when it rewrites or normalises the file.

- ESP keys include `id`, `name`, `type`, `enabled`, `unit`, `rawFormat`, `rate_hz`, `ringbuffer_size_samples`, driver blocks and raw `warnings`.
- WebUI-owned keys include `notes`, `kind`, `attachedTo`, `conversion`, `loadLimits` and the UI use of `calibrationFile` / `primaryTemperatureSensorId`.
- `name` is stored by the ESP and may be edited by the WebUI.
- `rate_hz` is required for every sensor.

The WebUI performs conversion from raw values to physical values. The ESP stores `conversion` as opaque JSON and does not interpret it in this version. The WebUI owns the calibrated-mass `loadLimits` monitor; these are distinct from firmware raw-value warning thresholds.

## 5. History buffers and memory

Each sensor owns a bounded ring buffer sized by `ringbuffer_size_samples`. The aggregate allocation is constrained by `settings.json.storage.ringbuffer_max_total_size_bytes`, leaving sufficient internal RAM for stacks, tasks, networking and essential services. PSRAM is optional and may be used to enlarge buffers.

Buffer sizing is per sensor; `queue_capacity` separately configures the shared acquisition queue. The configured buffer capacities, current usage, oldest retained sample ID and latest sample ID are exposed through status.

### 5.1 Runtime resize

Resizing does not require a full device restart. The `sensors.json` PUT accepts `?buffer=preserve|clear`; default is `preserve`.

- `preserve`: allocate a replacement, copy the newest samples that fit, then switch and release the old buffer. On allocation failure, retain the old buffer.
- `clear`: release the old buffer first, then allocate the requested capacity, maximising memory availability. The old history is lost. If allocation fails, report it and attempt to restore the previous capacity where possible.

Do not reserve enough memory for both buffers when executing `clear` mode.

### 5.2 Sample flags and threshold handling

Per-sample flags are **not stored in ring-buffer entries**. This avoids increasing RAM usage per sample. Firmware overload/underload flags are calculated on demand from each raw value and the current sensor thresholds when producing history or live sample responses. Consequently, historical overload/underload flags reflect the currently configured thresholds, not necessarily the thresholds that were active when the sample was acquired.

The 32-bit flag layout is defined in `api-protocol_v3.4.md`: bit 0 overload, bit 1 underload, bit 2 sensor disconnection, bit 3 sensor error, bit 4 invalid measurement, bits 5–31 reserved. Since flags are not stored historically, disconnection/error events and sample ranges are represented in the device log; historical bit 2–4 values may be zero unless a future implementation adds retained quality metadata.

### 5.3 Warning hysteresis

Each sensor may configure overload and underload raw-value thresholds. Each enabled threshold has a non-negative `hysteresis` in the same native raw-value units:

- Overload activates at `value >= threshold`; clears at `value <= threshold - hysteresis`.
- Underload activates at `value <= threshold`; clears at `value >= threshold + hysteresis`.

Warning events are emitted only on state transitions, including an `active:false` clear event. The WebUI may additionally implement its independent calibrated-weight `loadLimits` monitor. Firmware warnings are not safety-rated protection and do not replace hardware protection.

## 6. Configuration files and persistence

Structured JSON API resources have top-level integer `schemaVersion: 1`. Additive keys retain version 1; a non-additive/incompatible schema change requires a version increment. Sensor IDs are numeric everywhere. Settings and other configuration JSON are stored uncompressed. Static WebUI assets and calibration/WebUI data blobs are stored gzip-compressed.

| Resource | Path | Owner / firmware behaviour |
|---|---|---|
| System settings | `/data/settings/settings.json` | ESP-owned; validate and apply |
| Wi-Fi | `/data/settings/wifi.json` | ESP-owned; validate and apply; stable network IDs |
| Sensors | `/data/settings/sensors.json` | ESP driver keys + preserved WebUI keys |
| Units | `/data/settings/units.json` | WebUI-owned; ESP validates structure only |
| WebUI defaults | `/data/settings/webui-settings.json` | WebUI-owned; ESP stores/serves without interpretation |
| Calibration | `/data/calibration/calibration_<sensorId>_<profileId>.json` | WebUI-owned gzip blob; ESP stores/serves without decompression |

`settings.json`, `wifi.json`, `sensors.json`, `units.json` and `webui-settings.json` use the same resource URL for GET, PUT and DELETE. DELETE resets a settings resource to its factory default; GET after reset returns the default with HTTP 200. PUT replaces the whole submitted document; the ESP compares it with active state and decides what must be reconfigured. There is no PATCH endpoint.

Unknown keys must survive ESP-side reserialization. For password fields, omission on PUT means retain the existing secret; an explicit string sets/replaces it; null removes it. GET never returns secret material and instead reports `passwordSet`.

Critical ESP-owned configuration is validated before replacement. A failed check does not replace the working file/configuration. WebUI-owned and calibration files are non-essential; calibration bytes are opaque and stored as gzip without firmware-side JSON validation in this version.

## 7. Network behaviour and startup recovery

### 7.1 Wi-Fi

Support multiple saved station networks with stable numeric IDs and user-defined priority. Try highest priority first; preserve array order to break ties. New network entries without an ID receive one from the ESP; entries omitted from a complete PUT are deleted. Credentials are stored in recoverable form for reconnect but never returned by GET.

ESP decision: attempt each candidate for 15 seconds, then proceed to the next; retry a full pass every 30 seconds when no station is connected. Start a WPA2 fallback AP when no station network connects. Its SSID is `<ap_ssid_prefix>-<last-two-MAC-bytes>`; the default prefix is `OpenScale`. The AP defaults to a generated device-specific password printed to the serial console. `keepApWhenConnected` defaults false: stop the fallback AP after STA successfully connects unless configured otherwise. AP+STA is supported where the chip/driver permits it; both interfaces share one radio/channel.

### 7.2 Startup file failures

If `settings.json` or `wifi.json` cannot be loaded or parsed, use the corresponding in-memory factory defaults for this boot. **Do not overwrite or repair the saved file automatically.** Add a `config_fallback` entry to the device network log, retrievable by `GET /api/device-log` and emitted through SSE as `device_log` after the stream is available.

Security note: defaults may not contain an administrator password. In fallback mode, use the fallback AP with a generated WPA2 password and report the condition clearly in the log/serial output. Set an administrator password after recovery. The device must not silently rewrite the corrupt file.

### 7.3 Hostname and HTTP/HTTPS

If `hostname` is empty on first initialisation, generate `openscale_` plus the final three base-MAC bytes in hexadecimal, save it and advertise it via mDNS (`<hostname>.local`). `redirectToHostname` optionally redirects IP-address HTTP requests to the hostname while preserving path/query; avoid loops and redirect only when the hostname is resolvable. Users can disable this hostname redirect.

HTTP itself cannot be disabled. If HTTPS is enabled, configured and fully operational, HTTP redirects to HTTPS while preserving path/query. Until HTTPS is functional, HTTP remains available. HTTPS/TLS and OTA are deferred; the firmware must reject an HTTPS-enabled configuration that it cannot actually serve.

## 8. HTTP, SSE and device observability

The definitive method/path, payload, authentication, history and SSE contract is in `api-protocol_v3.4.md`. In summary:

- HTTP handles finite history, metadata, status, logs, configuration, file operations and restart.
- One `/stream` SSE endpoint multiplexes `sample`, `warning`, `device`, `sensor_error` and `device_log` events.
- History is requested separately per sensor; no SSE replay or `Last-Event-ID` support.
- A random boot ID is generated once at boot and exposed only through `/api/status`. The SSE `id:` line has the form `<bootId>-<eventCounter>`; the 64-bit counter increments for every application event sent through SSE.
- `GET /api/device` reports relatively static hardware/build metadata and protocol/file-format versions. `GET /api/status` reports changing runtime state and CSRF token.
- `GET /api/device-log` returns bounded per-boot diagnostic/network log entries. Each new entry is also emitted as a `device_log` SSE event. A new SSE connection receives the retained current-boot device-log snapshot (not sample history), allowing startup fallback notices to be delivered even if they occurred before the WebUI connected; the WebUI deduplicates by `logEntryId`.

### 8.1 Runtime application and restart policy

Do not automatically restart after configuration writes. Responses classify changes as `applied`, `needs-sensor-reconfig`, `needs-restart` or `rejected`. `pendingChanges` in `/api/status` lists files saved but not yet fully active. The WebUI decides whether/when to call `POST /api/restart` and polls `/api/status` until `bootId` changes.

Per-sensor `configRevision` increments when a change becomes active and affects sample interpretation/stream continuity (sensor type, `rawFormat`, driver measurement configuration, sample rate, warning-threshold configuration, or a buffer clear). It resets to its initial value for a new boot. The WebUI starts a new logical sample segment when it changes.

### 8.2 Device metadata and runtime status

Static metadata should report product/firmware version, build ID, Git commit, ESP-IDF version, chip model/revision/core count, flash type/capacity, filesystem/partition information, PSRAM presence/type/capacity, capabilities, protocol version, file-format versions and upload limit.

Runtime status should report boot ID, uptime, CSRF token, pending changes, memory (free/minimum-ever heap, largest block, internal RAM and PSRAM), physical flash and filesystem capacity/used/free, Wi-Fi state/RSSI/IP/client count where available, open SSE connection count, optional wall-clock Unix time, and per-sensor state/effective rate/config revision/uptime/ring-buffer capacity/usage/oldest/latest IDs/queue drops/read errors.

## 9. Security and file serving

When an administrator password is set, authentication is resource-specific:

- `settings.json`, `wifi.json`: GET, PUT and DELETE.
- `sensors.json`, `units.json`, `webui-settings.json`: PUT and DELETE only.
- Calibration files: PUT and DELETE; GET remains public.
- Static assets: PUT and DELETE; GET remains public.
- `/api/restart`: POST protected.
- `/api/device`, `/api/status`, `/api/device-log`, `/api/history`, `/api/files`, `/stream` and static GET: public.

Use HTTP Basic authentication. Do not send a `WWW-Authenticate: Basic` challenge; the WebUI handles a 401, prompts, and retries with `Authorization: Basic …`. Basic credentials are not encrypted on plain HTTP. Do not expose the device to untrusted networks until HTTPS is functional.

Require a random per-boot CSRF token on every PUT, POST and DELETE, sent in `X-CSRF-Token`. The token is available as `csrfToken` in `/api/status`, which is public. A 403 causes the WebUI to refresh status once and retry. Same-origin deployment is the default; permissive CORS is not required and must not be enabled by default.

The built-in `default.html` and `default.js` are reserved diagnostic/recovery assets and cannot be overwritten or deleted through the generic asset API. Static web assets are stored as gzip and served with `Content-Encoding: gzip` in all build types. Uploads carry `Content-Encoding: gzip`. Nested paths are allowed. JSON is allowed as a generic static asset unless it occupies a reserved path. Protect `default.*`, `/data`, `/api` and other registered/protected paths against generic asset writes and path traversal.

Calibration files are also gzip blobs but live under the explicit `/data/calibration/` resource path. Generic static-file handling must never access `/data`.

## 10. Storage, serial recovery and build requirements

Use FATFS over ESP-IDF flash wear levelling for data storage. A 4 MB starter layout used a 2 MB factory-app partition and approximately 1.94 MB for FATFS; this is a board-specific example, not a requirement for every chip. Select partitions according to actual flash size and firmware image size. Do not automatically format a mounted storage partition merely because mounting failed: formatting may destroy settings and user files. Recovery/formatting must be an explicit serial/service action.



Serial commands use verb-first names, including `wifi_set`, `wifi_clear`, `password_set`, `password_clear`, `hostname_set` and `debug_set`. The serial console remains available when networking/configuration fails and provides recovery for Wi-Fi and administrator credentials.

The firmware build must gzip all required static WebUI assets in development and production builds; fail the build if required compression fails. Development/production may differ in minification/source maps. Fetch and pin uPlot 1.6.32 (commit `e995b061e9fc5476a6d862cd2fb2ebc7452ca012`) under `/lib/uPlot/`, preserve its directory structure initially, and include its MIT notice.

## 11. Explicit ESP decisions closing prior open points

| Topic | Decision |
|---|---|
| Calibration DELETE authentication | Protected when an admin password exists, same as PUT |
| Wi-Fi network list PUT | Full list; IDs match existing networks; missing ID means new; omitted existing ID means delete; ESP assigns IDs to new entries |
| Warning hysteresis keys | `warnings.overload.hysteresis` and `warnings.underload.hysteresis`, non-negative in the same native raw units |
| Admin password key | Write-only `security.password`; GET returns `security.passwordSet` |
| Beta `rSeries` | Subtract series resistance from measured total resistance before thermistor beta calculation |
| Sample flags | Bit 0 overload, bit 1 underload, bit 2 disconnection, bit 3 sensor error, bit 4 invalid measurement; bits 5–31 reserved |
| Device-log event | SSE name `device_log`; per-boot RAM ring, 128 entries, no flash persistence |
| Device-log IDs | Independent per-boot `logEntryId`; `t` is monotonic microseconds since boot |
| History headers | Adopt the `X-History-*` names in the API document and define their semantics there |
| HTTP 401 challenge | Omit `WWW-Authenticate`; WebUI owns the credential prompt/retry |
| Upload limit | Initial maximum single request body 512 KiB, exposed as `maxUploadBytes`; 413 for request limit, 507 for flash capacity |
| Binary history | Version 1, 12-byte header, 28-byte records; no extra header bytes |
| Boot ID | Only in `/api/status` JSON; random per boot and not persisted |
| Global SSE event ID | `<bootId>-<eventCounter>` in SSE `id:`; counter increments for every application event |
| WebUI settings factory default | `{"schemaVersion":1}`; `{}` without schemaVersion is not a valid persisted file |

## 12. Implementation baseline and target distinction

The initial starter scaffold described an HX711-only implementation with one acquisition task per enabled HX711, a shared FreeRTOS queue, per-sensor ring buffers, a total buffer budget, asynchronous multiplexed SSE, per-sensor history, Wi-Fi STA/fallback AP, JSON settings management, calibration upload, gzip static assets and serial recovery. It explicitly lacked a successful ESP-IDF build/hardware test in its original environment.

That scaffold is not the v3.4 contract: its endpoint names, single combined device/status endpoint, old configuration routes, flat-only asset paths, HTTP-disable command and older file schemas are superseded by the current companion API/JSON documents. Do not describe a v3.4 requirement as implemented unless it has separately passed build and hardware validation.

## 13. Deferred items and remaining open points

- HTTPS/TLS, OTA firmware updates, NTP and ESP-side calibration application are deferred.
- ETag/`If-Match` concurrency control is deferred; whole-file GET-modify-PUT is the current model.
- Future opaque WebUI data files (e.g. `/data/user/checkweighings.json`) may be gzip-compressed; no generic `/data/user` API is enabled until a concrete resource is specified.
- **Open:** exact hardware-specific GPIO/driver support and resource budget for each target chip.
- **Open:** wall-clock source/synchronisation; `unixtimestamp` remains null when unavailable.
