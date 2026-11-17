# OpenScale ESP32 — Project Requirements and Architecture

**Document purpose:** Firmware-project handover and requirements baseline  
**Version:** 0.2

## 1. Product scope

OpenScale is an ESP32-based sensor node. It acquires measurements from multiple sensors, maintains per-sensor history, and exposes live data, historical data, device information, configuration and file management through HTTP and Server-Sent Events (SSE). The device also serves the separately developed WebUI.

The firmware owns sensor acquisition, data retention, device management, networking and the HTTP/SSE interface. The HTTP server should use asynchronous handling for long-lived SSE requests so they do not occupy the ordinary HTTP request-processing task. The WebUI is a separate component: its visualisation, interaction and presentation logic are outside the firmware specification. The firmware serves the built WebUI assets, initially including protected `default.html` and `default.js` assets.

**Initial network focus:** Wi-Fi through ESP-IDF. Ethernet-capable variants are not excluded as a general concept, but Ethernet support is not part of the initial implementation focus.

## 2. Requirements and accepted direction

The status word records how clearly the item was accepted in the requirements:

- **Explicit** — directly confirmed by the user.
- **Implicit** — proposed in the requirements and not rejected, or covered by the user's general agreement.
- **Open** — the requirements did not settle the detail.

| Requirement / decision | Status |
|---|---|
| Firmware in C++ using ESP-IDF-native facilities; avoid Arduino and external libraries unless needed | Explicit |
| Target ESP-IDF 6.1.x, using the latest suitable patch release on that branch at implementation time | Implicit |
| Broad support for Wi-Fi-capable ESP32-family targets; validate the chosen chip and peripherals | Explicit |
| Initial targets to test first: ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and ESP32-C6 | Implicit |
| ESP32-C2, C5 and C61 can follow after the initial targets are stable | Implicit |
| ESP32-H2/H4 are not standalone targets for this Wi-Fi device; ESP32-P4 would need a Wi-Fi companion | Implicit |
| PSRAM is optional and should be used to extend history capacity when available | Explicit |
| One monorepo for firmware, WebUI, documentation and tools | Explicit |
| AGPL-3.0-or-later is the intended project licence | Implicit |
| Semantic firmware versioning; initial proposed version is `0.1.0` | Implicit |

### 2.1 Hardware compatibility

Network connectivity is the functional requirement, but the initial implementation is to concentrate on Wi-Fi and ESP-IDF. The intended broad target is the Wi-Fi-capable ESP32 family, subject to actual peripheral, GPIO, memory and framework support. The first validation set proposed in the requirements is the original ESP32, S2, S3, C3 and C6. More constrained or newer targets are to be added after the initial implementation stabilises.

Do not interpret ESP-IDF chip support as proof that the application has been tested on that chip. GPIO availability, peripheral drivers, memory budgets, Wi-Fi behaviour and build compatibility must be checked per target.

### 2.2 Repository organisation

Keep one repository, with distinct component boundaries. A proposed layout is:

```text
OpenScale/
├── firmware/
│   ├── main/
│   ├── components/
│   └── CMakeLists.txt
├── webui/
│   ├── src/
│   ├── public/
│   └── package.json
├── docs/
│   ├── architecture/
│   └── protocol/
├── tools/
├── CMakeLists.txt
├── Makefile
└── README.md
```

WebUI changes should be identifiable in commit titles. The WebUI keeps its own build process; the firmware consumes the resulting assets.

## 3. Sensor acquisition and sample pipeline

### 3.1 Generic sensor architecture

The acquisition system is sensor-generic, not load-cell-specific. A sensor manager owns configuration, registration, lifecycle and status. Each enabled sensor has a driver implementation. HX711 is the initial driver; temperature, humidity, voltage, current and other driver types may be added as supported implementations become available.

All drivers publish into a common sample pipeline:

```text
Sensor manager
  └─ Sensor driver / acquisition task(s)
       └─ Shared bounded, thread-safe sample queue
            └─ Collector
                 └─ Per-sensor ring buffer
                      ├─ HTTP history
                      └─ Shared SSE stream
```

Drivers may use different acquisition mechanisms, including GPIO interrupts, polling or periodic measurements. The common interface should expose initialization, start/stop and status operations. The WebUI decides how a sensor is represented; the firmware provides typed identity, unit and measurement data, not graph or colour information.

### 3.2 Per-sensor identity and sample fields

Each sensor has:

- A unique numerical sensor ID.
- A type and driver-specific configuration.
- Its own monotonically increasing sample ID.
- Its own monotonic timestamp per sample.
- An unsigned 64-bit raw measurement value.
- Its own ring buffer and retention state.
- Its own status, error counters and optional warning thresholds.

The common sample representation proposed in the requirements is:

| Field | Meaning |
|---|---|
| `sensorId` | Numerical sensor ID |
| `n` | Per-sensor monotonically increasing sample ID (64-bit) |
| `t` | Monotonic timestamp in microseconds since boot (64-bit) |
| `raw` | Unsigned 64-bit raw measurement value |
| sample flags | Quality/warning bit field; exact bit assignments remain open |

`raw` is an unsigned 64-bit sensor-specific value. For the HX711, the source reading is signed 24-bit; its encoding into the unsigned 64-bit transport field must be consistent, with the exact conversion rule still open. Another driver may publish a scaled integer such as millidegrees Celsius or millivolts. The sensor definition must describe its unit and raw representation. No universal physical conversion is imposed by the firmware.

### 3.3 Timing and sequence behaviour

All sensor timestamps must remain monotonic microseconds since boot. They must never switch to wall-clock time, because time-of-day can change while acquisition is running. A future metadata field may correlate current ESP time-of-day with the current monotonic timestamp; that mapping is not part of the initial timing contract.

Each sensor's sample counter is independent. A dropped queue item must remain detectable as a gap in the sequence; the initial implementation scaffold already advances the sequence even when a queue insertion fails. Queue overflow and sensor-read errors must be counted and exposed in status.

### 3.4 HX711 baseline

The initial implementation snapshot's initial example configures sensor ID `0` as an HX711 using DOUT GPIO 16 and SCK GPIO 4. `rate_hz` is 10 or 80. If `rate_gpio` is configured, the firmware drives it low for 10 Hz and high for 80 Hz; if unset, the module's physical RATE pin must be strapped accordingly. Gain values in the scaffold are `A128`, `A64` and `B32`.

The HX711 driver returns signed 24-bit raw ADC values. Their representation in the unsigned 64-bit protocol field must be defined consistently. No offset, scale conversion, filtering or calibration is applied to those readings. The example's GPIO assignment is a starting-board assumption, not a universal ESP32 pin requirement.

## 4. History buffers and memory

Each sensor owns a bounded ring buffer. Buffer allocation is constrained by an aggregate memory budget and must leave sufficient internal RAM for tasks, stacks, networking and other essential operations. PSRAM is optional and preferred for large allocations where available. The goal is to make buffers as large as the hardware can reasonably support, not to exhaust all RAM.

The user may change capacities at runtime. This should not require a full device restart. Two resize behaviours were proposed:

- **`preserve`** — allocate a replacement, copy the newest samples that fit, switch to it, then release the old buffer. If allocation fails, retain the old buffer.
- **`clear`** — release the old buffer first and then allocate the new capacity. This makes a larger allocation possible when both old and new buffers cannot coexist, but history is lost. If allocation fails, report the failure; attempting to recover the old capacity was proposed.

The API must expose the selected resize mode. The exact request field name and failure response are open.

The per-request history response size is separately bounded. It should not change unpredictably with free RAM on every request. The WebUI's proposed initial chunk is 5,000 samples; the firmware may support larger chunks on more capable hardware. The actual per-sensor retention capacity and maximum supported response chunk should be discoverable.

## 5. Warning detection

A generic warning subsystem evaluates configured raw-value thresholds for any sensor. Overload and underload are the initial warning types; warnings are not restricted to HX711/load cells. The subsystem maintains state and hysteresis so a condition does not repeatedly activate/deactivate near a threshold.

When a warning is active:

- Threshold-derived warning flags are evaluated/generated on-the-fly and are not stored in ring buffers, avoiding additional per-sample RAM use. Sensor quality/status flags are defined separately; exact persistence policy for non-threshold quality flags remains open.
- The firmware emits a separate SSE `warning` event when the warning state changes, not on every sample.
- Clearing a condition emits the corresponding inactive transition.

Hysteresis was accepted for the firmware's basic detection. The WebUI may implement more sophisticated interpretation. Firmware warnings are measurement-threshold warnings only; they are not safety-rated overload protection and must not replace hardware protection.

## 6. Networking, hostname and discovery

### 6.1 Wi-Fi

Store multiple Wi-Fi networks in user-defined priority order. Try available saved networks by priority and reconnect after connection loss. If no saved network can be reached, start a fallback access point. AP+STA operation was accepted as a capability: the ESP can connect to a router as a station while providing its own AP, but both interfaces share one radio/channel. AP+STA does not by itself provide internet routing or bridging to AP clients.

The proposed default sequence is to try saved networks first, enable the fallback AP if none work, and optionally keep the AP active after a station connection. Retry intervals, connection timeouts and the default AP-retention policy remain to be specified.

### 6.2 Hostname and mDNS

On first initialisation, generate a hostname if `hostname` is empty, using the `openscale_` prefix and the last three bytes of the base MAC address in hexadecimal (example: `openscale_a1b2c3`). Save it in `settings.json`; users may change it later.

Advertise the host with mDNS, normally as `openscale_a1b2c3.local`. mDNS resolution is not guaranteed on every client/network.

When enabled, HTTP requests addressed to the device's IP should redirect to the hostname. Preserve the original path and query. Do not redirect requests already addressed to the hostname; do not redirect if the hostname cannot be resolved/advertised; avoid AP-mode redirects unless the hostname is known to work there. The hostname redirect setting is user-disableable, and a serial recovery command to disable that redirect was proposed. This is separate from HTTPS redirect behaviour.

## 7. HTTP server, assets and storage

The ESP serves the separately developed WebUI and supports configuration, history, status, calibration, asset management and explicit device actions.

### 7.1 Static WebUI assets

- Static assets are stored compressed as gzip on flash and served with `Content-Encoding: gzip`.
- Gzip is mandatory for every build type, including development and production. A build must fail if a required asset was not compressed successfully.
- Asset uploads send gzip-compressed bytes and identify them with `Content-Encoding: gzip`.
- Support user-selected nested web paths, not only flat filenames. Paths may contain `/`; prevent path traversal and reserve protected namespaces.
- `default.*` assets are protected from ordinary overwrite, deletion or rename.
- JSON files are allowed as generic static assets, except for protected/reserved files and paths used by the data API.
- `/data` is a protected data namespace and is not part of generic static-asset handling.
- A single `http_indexpath` setting in `settings.json` selects the file served for `/`; default: `/default.html`. No separate index-management endpoint is needed.

### 7.2 JSON and calibration storage

System settings, Wi-Fi settings, sensor configuration, units, WebUI settings and calibration files are stored as ordinary, uncompressed JSON on flash. This supports validation and safe replacement. Static web assets alone are gzip-compressed.

The proposed settings files are:

- `settings.json` — system-wide settings, security, memory budget, hostname/redirect and HTTP index path.
- `wifi.json` — multiple saved networks and AP configuration.
- `sensors.json` — sensor definitions, driver settings, ring-buffer capacities and warning settings.
- `webui-settings.json` — WebUI-owned configuration; the firmware stores/serves it but does not interpret it.
- `/data/calibration/*.json` — any number of calibration files. The calibration document itself identifies the sensor it belongs to; the URL is not sensor-scoped.

Essential configuration is validated before acceptance. A failed settings/sensor configuration check must not replace the working critical configuration. Calibration files are non-essential: save and serve them even when a check fails, and report the failed check to the WebUI. The exact calibration schema and active-calibration selection mechanism were not finalised.

## 8. Runtime settings and restart policy

The device should avoid unnecessary full restarts. Configuration changes are classified as:

1. Applied immediately.
2. Require an individual sensor reconfiguration.
3. Require a full device restart.
4. Could not be applied.

The firmware must report the category and distinguish saved settings from settings currently active. A successful configuration update must not silently restart the device. The WebUI decides whether/when to offer and issue a restart. `POST /api/restart` was the proposed explicit restart action.

A random boot/session ID is generated exactly once at each startup using the ESP-IDF random source. It is not persisted to flash and is exposed through device metadata (`GET /api/device`). A changed boot ID tells the WebUI that a new firmware session has begun. A device that loses power cannot announce its own shutdown; the WebUI can detect the new session on reconnection and use timestamps/gaps as additional evidence.

## 9. Device metadata and status

Separate relatively static device/build metadata from frequently changing runtime status.

**Device metadata** should include, where available:

- Product name and firmware semantic version.
- Build ID, Git commit and ESP-IDF version.
- Chip model, revision and core count.
- Flash size/type and partition/filesystem information.
- PSRAM presence, type and total size.
- API/protocol versions and feature capabilities.
- Network capabilities.

**Runtime status** should include, where available:

- Uptime and boot/session ID.
- Free and minimum-ever free heap; largest free block.
- Internal RAM availability.
- PSRAM free space and largest free block.
- Physical flash size plus filesystem/partition used and free space.
- Per-sensor ring-buffer capacity, used entries and retention information.
- Per-sensor uptime, queue allocation/usage, queue drops, sensor read errors and sensor status.
- Wi-Fi state, RSSI and IP address.
- Current time information if a wall-clock source is added later.

A device network log is available through `GET /api/device-log` and is also published as an SSE event. If `settings.json` or `wifi.json` fails to load at startup, the firmware uses in-memory defaults without modifying the saved file and records this fallback in the device network log. Polling is used for ordinary device information. The discussed frequencies were 2–5 seconds for runtime, heap, ring-buffer, Wi-Fi and sensor status, and 10–60 seconds for flash statistics. Exact polling periods are WebUI policy, not protocol guarantees.

## 10. Security and transport

- Use HTTP Basic authentication when an administrator password has been configured. Protect all mutating operations and sensitive settings reads.
- The administrator password should be stored as a salted PBKDF2-HMAC-SHA256 verifier, not plaintext. Wi-Fi credentials must remain recoverable for reconnection and therefore require protected storage/access; ordinary GET responses must not disclose them in plaintext.
- Basic Auth over plain HTTP is not encrypted. Do not expose the device to untrusted networks or the public internet until HTTPS/TLS is implemented.
- HTTPS/TLS and OTA firmware updates are deferred until a complete HTTPS implementation is available. HTTP cannot be disabled; when HTTPS is enabled and fully operational, the HTTP service redirects requests to HTTPS.
- Use a per-boot CSRF token for every mutating HTTP request. The WebUI obtains it through an authenticated device/status request. Token field and request-header names remain open.
- Do not enable permissive CORS by default. Loading a CDN script in the WebUI does not itself require the ESP API to enable cross-origin access.
- Keep serial access for emergency Wi-Fi, administrator-password and HTTP configuration/recovery.

## 11. Serial recovery interface

Use the verb ordering requested by the user, e.g.:

```text
wifi_set
wifi_clear
password_set
password_clear
hostname_set
debug_set
```

Serial control may configure HTTPS/redirect behaviour; HTTP itself remains available and cannot be disabled. Exact command syntax/arguments for every command were not finalised. The serial console should remain usable when network services are unavailable or essential settings cannot be parsed.

## 12. Build and third-party WebUI assets

- Use ESP-IDF's native components (including its HTTP server, Wi-Fi, cJSON and FATFS/wear-levelling facilities) and CMake build system, with a root `Makefile` as a convenience wrapper.
- Provide development/production build options. Terser and a CSS minifier are optional; without them, use unminified sources.
- Gzip compression is mandatory regardless of build target.
- Fetch and pin uPlot to version `1.6.32`, commit `e995b061e9fc5476a6d862cd2fb2ebc7452ca012`; serve it under `/lib/uPlot/` and preserve its directory structure initially.
- Include uPlot's MIT licence notice in the distribution.
- Firmware versioning follows SemVer; initial proposed version: `0.1.0`.

## 13. Implementation baseline versus target architecture

The initial implementation snapshot reports the following as implemented: HX711 acquisition tasks, a bounded shared FreeRTOS queue, per-sensor ring buffers, a memory budget, a multiplexed SSE endpoint, per-sensor history queries, Wi-Fi STA with fallback AP, JSON validation/storage, calibration uploads, gzip static assets, HTTP Basic Auth and basic serial recovery.

The initial implementation snapshot's implementation baseline has since been superseded in several respects:

| Initial implementation snapshot | Current target direction |
|---|---|
| ESP-IDF 5.5.6 branch | Target ESP-IDF 6.1.x |
| Only HX711 driver | Generic driver architecture, auxiliary sensors prepared |
| `/api/device` combines runtime information | Separate device metadata and polled runtime status (`/api/device`, `/api/status`) |
| History query limit 1–512, no cursor pagination | 5,000-sample WebUI default proposed; larger bounded chunks and range pagination planned |
| SSE `samples` batch with `sensor_id`, `seq`, `timestamp_us` | Global per-event SSE ID/boot ID, `sensorId`, `n`, `t`, `raw`, plus device/warning events; exact event batching still open |
| Configuration PUTs restart the device | No silent restart; WebUI chooses when to request restart |
| `/api/calibration/...` and `/api/files/...` APIs | Calibration and static assets use direct GET/PUT resource paths |
| Index path in `webui-settings.json`, `/api/files/index` | `http_indexpath` in `settings.json`; no index endpoint |
| Flat static asset paths | Nested paths accepted, subject to reserved-path/path-traversal protection |
| No mDNS or CSRF | mDNS hostname/redirect and per-boot CSRF token accepted |
| No additional drivers/warning engine | Generic sensors and hysteresis warning engine are part of the target |

The initial implementation snapshot states that no genuine ESP-IDF build or hardware test was performed. No later successful build/test evidence is recorded here. Therefore, do not describe ESP-IDF 6.1.x, the generic drivers, warning engine, new protocol or revised file APIs as implemented merely because they are accepted design requirements.

## 14. Open items

The following must be settled before treating the design as an implementation-ready specification:

1. Exact JSON property names and complete schemas, especially warning hysteresis and calibration data.
2. Exact config PUT URL prefix and whether config GET/PUT use identical resource paths.
3. History query names, all-sensor versus per-sensor request semantics, response negotiation and pagination guarantees.
4. Exact response headers/metadata used to report truncated history and maximum chunk size.
5. Exact bit assignments and persistence policy for non-threshold sensor quality flags in history.
6. Exact SSE event names/payload schemas and whether live samples are dispatched one by one or batched.
7. CSRF token field name, request header name and exact source endpoint.
8. HTTP error-status conventions and common JSON error-body schema.
9. Exact serial command syntax, AP-retention defaults and Wi-Fi retry policy.
10. Calibration-file schema and active-calibration selection, if firmware-side calibration application is introduced.
