# OpenScale: ESP32 — Firmware Handover

**Document status:** Working handover / architecture baseline  
**Version:** Draft 0.1  
**Purpose:** Give a new development session the context needed to continue firmware work without relying on the original ChatGPT conversation.

> This document records agreed direction and proposals. It does not imply that the described functionality has already been implemented or tested. Items marked **TBD** still need a decision or implementation.

## 1. Project overview

OpenScale is an ESP32-based, Wi-Fi sensor node. Its initial use case is load-cell measurement using HX711 devices, with room for additional sensor types such as temperature sensors.

The firmware is responsible for:
- Acquiring sensor measurements.
- Managing per-sensor history buffers.
- Exposing live samples and historical data to a separate WebUI.
- Serving the WebUI's static assets.
- Managing device, Wi-Fi, sensor and calibration configuration.
- Exposing device status and metadata.
- Providing authenticated file/configuration management.

The WebUI is a separate component in the same Git repository. It is not embedded as a separate application server; the ESP32 serves its built static assets.

## 2. Repository direction

Use one monorepo, with clear component boundaries. Suggested structure:

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
│   ├── protocol/
│   └── settings/
├── tools/
├── CMakeLists.txt
├── Makefile
└── README.md
```

The WebUI has its own build process. Firmware packaging consumes its generated assets. Identify WebUI changes in commit titles, as desired by the project owner.

## 3. Technology and supported hardware direction

- Implement firmware in C++ using ESP-IDF-native APIs.
- Do not use Arduino as the firmware framework.
- Avoid third-party libraries unless they provide a clear benefit.
- Wi-Fi is the current networking focus. Ethernet is not an initial requirement.
- PSRAM is optional, never a requirement.
- Use PSRAM when present to extend history capacity, while preserving sufficient internal RAM for task stacks, networking and system operation.
- Aim for broad compatibility across Wi-Fi-capable ESP32 families, but establish and test a practical initial chip matrix before claiming support.
- HTTPS and OTA are postponed.

**ESP-IDF version:** The project is new and should target a current stable ESP-IDF release selected at implementation time. Verify the current stable release and chip support against Espressif's official documentation before pinning it. Earlier discussion considered the 6.x line; this is not a final pinned dependency.

## 4. Sensor architecture

Use a generic sensor manager and driver abstraction.

Each configured sensor has:
- A unique numerical `sensorId`.
- A driver implementation supported by the firmware.
- Its own acquisition configuration and status.
- Its own monotonically increasing sample ID.
- Its own history ring buffer and memory accounting.
- Optional raw-value thresholds and warning state.

All drivers feed a common thread-safe FreeRTOS queue. A collector task consumes samples and updates the corresponding sensor history buffer. Sensor drivers may use interrupts, polling, timers or other acquisition mechanisms appropriate to the hardware.

Illustrative sample model:

```cpp
struct SensorSample {
    uint32_t sensorId;
    uint64_t sampleId;
    uint64_t timestampUs;  // monotonic microseconds since boot
    int64_t raw;
    uint32_t flags;
};
```

This is an architectural illustration, not a finalized ABI or packed wire structure. Avoid assuming C++ struct layout is a portable binary protocol.

A driver interface may resemble:

```cpp
class ISensorDriver {
public:
    virtual esp_err_t init() = 0;
    virtual esp_err_t start() = 0;
    virtual void stop() = 0;
    virtual SensorStatus getStatus() const = 0;
    virtual ~ISensorDriver() = default;
};
```

The firmware must know how to operate each sensor type; generic configuration does not magically add support for an unknown physical sensor.

Raw values are sensor-defined. Metadata/configuration should identify the sensor type, unit and raw-value interpretation. The firmware should not dictate graph styles or other presentation choices to the WebUI.

### Initial sensor

HX711 load cells are the first supported sensor family. Earlier scaffold assumptions used GPIO16 for DOUT and GPIO4 for SCK, but pin assignments must remain configurable and be verified against the actual board.

## 5. Sampling, timestamps and identifiers

- Sample IDs are monotonically increasing **per sensor**.
- Timestamps are monotonic microseconds since the current boot, not wall-clock time.
- Use an ESP monotonic timer source such as `esp_timer_get_time()`.
- Wall-clock synchronization or time changes must never alter already-acquired sample timestamps.
- The device may expose a current wall-clock/time anchor paired with the current monotonic uptime timestamp. The WebUI can use that mapping for display.
- Use wide integer types in the protocol. Be mindful that JavaScript `Number` cannot exactly represent every 64-bit integer; constrain values to the safe range or encode larger integers as decimal strings where necessary.

## 6. History buffers and memory policy

Each sensor has an independent bounded ring buffer. Memory use is budgeted globally, with internal RAM reserved for system operation and PSRAM used opportunistically.

Buffer capacity should be dynamically adjustable at runtime, without restarting acquisition where possible.

Two resize behaviours are intended:
- **Preserve:** allocate a replacement buffer, copy the newest samples that fit, then switch to it. If allocation fails, retain the old buffer.
- **Clear:** release the old buffer before allocating the new one, allowing memory to be reused without needing simultaneous old and new allocations. This clears that sensor's history. If allocation fails, report the failure and attempt a sensible recovery, such as restoring the previous capacity if possible.

The exact API representation of these modes is **TBD**.

Report actual configured/allocated capacity, used entries, memory location where known, and allocation failures. Do not promise that any requested size will succeed: fragmentation and concurrent allocations matter, not just total free memory.

Prefer allocation at startup for predictable operation, but support runtime changes. Avoid silently discarding history or reporting a successful resize when it failed.

## 7. Warning detection

Implement a simple reusable raw-value threshold subsystem:
- Optional upper/overload and lower/underload thresholds per sensor.
- Hysteresis to prevent rapid warning-state chatter.
- Warning flags attached to samples and retained in history.
- A separate SSE warning event when a warning state changes.
- Do not emit repeated transition events while the state remains unchanged.

The WebUI may provide richer interpretation and visualization. Firmware detection is a basic, consistent source of warning state, not a replacement for advanced UI logic or hardware safety protection.

Exact threshold field names and hysteresis semantics remain part of the settings specification/API negotiation.

## 8. Networking and Wi-Fi

- Wi-Fi is the initial network transport.
- Support a prioritized list of saved SSIDs.
- Retry/reconnect according to configurable policy.
- Provide a fallback access point.
- AP+STA operation is desired where supported: the device can connect to an upstream Wi-Fi network while hosting its own AP. Both modes share one radio/channel; this is not an internet bridge.
- Credentials must not be returned in plaintext by ordinary settings/status reads.
- Wi-Fi configuration belongs in its own settings file.

A generated hostname may be derived partly from the device MAC address on first initialization, then persisted and user-changeable. mDNS resolution and HTTP redirection are separate features. HTTP redirect to the hostname should be configurable and should avoid redirect loops or situations where the hostname cannot resolve.

## 9. HTTP server, static assets and security

The ESP32 serves static WebUI assets and the device API.

- Static asset paths may be user-selected and may contain slash-separated path components.
- Normal directory-style paths are preferable; if a flat filesystem representation is used, logical path handling must still be safe and consistent.
- Prevent path traversal and protect reserved paths/files.
- Default firmware assets are protected from normal user replacement/deletion.
- Configuration and calibration data are protected from arbitrary static-asset operations.
- Static assets are served gzip-compressed in every build type, with correct `Content-Encoding: gzip`.
- Build must fail if required asset compression fails; no silent uncompressed fallback.
- A setting such as `http_indexpath` selects the file served for `/`, allowing a user-provided WebUI entry page.
- No general-purpose static-file index API is currently required.

Authentication:
- HTTP Basic authentication is used when an admin password is configured.
- Mutating operations require authentication when a password is configured.
- Add a per-boot CSRF token. The WebUI obtains it through an authenticated device/status-related request and sends it with mutating requests.
- Do not enable permissive CORS by default. Loading a third-party CDN script from a page does not itself require the ESP32 API to allow cross-origin requests.
- A configurable CORS policy can be considered later if an actual cross-origin API use case arises.

## 10. Restart and configuration application policy

Avoid full-device restarts whenever sensible. Classify setting changes as:
1. Applied immediately.
2. Requires reconfiguration/restart of an individual sensor driver.
3. Requires a full device restart.
4. Rejected/not applied.

The firmware should report the application requirement and result. The WebUI decides when to request a full restart. The firmware must not reboot automatically merely because a setting was changed.

The firmware should distinguish saved settings from currently active settings where changes are pending. The WebUI can show pending changes and offer a restart.

A device that loses power cannot announce its own shutdown. The WebUI can detect a new boot ID and use timestamp gaps as supporting evidence.

## 11. Boot/session identity and SSE

Generate a random boot/session ID at startup using ESP-IDF random facilities. Do not write a boot counter to flash on every boot.

SSE event IDs combine the boot ID with a global event counter, for example:

```text
id: a83f21c9-1042
event: sample
data: {"sensorId":0,"n":501,"t":123456789,"raw":12345}
```

The global event ID orders events across sensors and event types. The per-sensor sample ID remains the identity/order of samples for that sensor. No server-side SSE replay is currently planned.

## 12. HTTP data responsibilities

The intended separation is:
- History: HTTP request/response.
- Live samples and important state transitions: SSE.
- Device status: polled HTTP endpoint.
- Device metadata: HTTP endpoint, with static/build details and supported capabilities.

Exact routes, request parameters and response schemas are being negotiated with the separate WebUI project. See `communication-protocol.md`.

## 13. Device metadata and status

Expose as much useful hardware/runtime information as the chip and ESP-IDF can provide.

Metadata/build information should include, where available:
- Product and firmware version (Semantic Versioning, e.g. `0.1.0`).
- Build ID, Git commit and ESP-IDF version.
- Chip model, revision and core count.
- Flash total size/type.
- PSRAM presence, total size/type.
- Capabilities and protocol versions.

Runtime status should include, where available:
- Current/minimum-ever free heap and largest free block.
- Internal RAM and PSRAM free/largest blocks.
- Flash physical size and filesystem/partition total, used and free space.
- Per-sensor status, errors, uptime, buffer capacity and usage.
- Wi-Fi state, RSSI and IP information.
- Device uptime and current wall-clock/monotonic anchor.
- CSRF token as required by the WebUI flow (do not log or expose it unnecessarily).

## 14. Calibration

Allow multiple calibration JSON files. A calibration file contains the sensor identity/type information it applies to; the URL itself does not bind the file to a sensor.

The firmware should not impose a one-file-per-sensor restriction. How a calibration is selected/activated is **TBD**; do not assume a fixed active filename or a URL such as `/api/sensor/0/...`.

## 15. WebUI assets and build

- Use uPlot from the upstream project, pinned to the agreed version/commit: version 1.6.32, commit `e995b061e9fc5476a6d862cd2fb2ebc7452ca012`.
- Preserve required distribution structure and include the MIT license notice.
- Pin dependencies; avoid unpinned `latest` downloads.
- Always gzip assets, including development builds.
- Development/production may differ in minification and source maps, not in whether gzip is produced.
- Optional JS/CSS minifiers may be used, with predictable fallback behaviour if optional tools are unavailable. Required gzip generation is not optional.
- ESP-IDF uses CMake. A root Makefile may provide convenience targets such as build, production build, dependency download, clean and release.

## 16. Versioning and release

Use Semantic Versioning (`MAJOR.MINOR.PATCH`), e.g. `0.1.0`, not `0.01.0`.

Keep distinct:
- Firmware version.
- Build identifier / Git commit.
- API/protocol version.
- Binary history format version.

## 17. Implementation status and cautions

The earlier conversation referred to an initial scaffold and a ZIP archive, but this handover does not independently verify that those files are present, current, buildable or tested. Inspect the actual repository before relying on prior scaffold claims.

Before a release:
- Build with the pinned ESP-IDF toolchain.
- Test on each claimed chip/board configuration.
- Test with and without PSRAM.
- Test allocation failure and runtime buffer resizing.
- Test power loss/reboot detection from the WebUI perspective.
- Test authentication and CSRF on all mutating routes.
- Test path traversal and protected-file handling.
- Verify every served WebUI asset is gzip-compressed and served with correct headers.
- Validate JSON and binary history interoperability with the WebUI.

## 18. Open decisions

- Final API routes, methods, parameters and exact response schemas.
- Final settings-file schemas and names beyond those already agreed.
- Exact history pagination/chunking and truncation semantics.
- Exact binary history version/flags semantics.
- CSRF token endpoint/header name and lifecycle.
- Calibration activation/selection model.
- Exact warning threshold/hysteresis field names and semantics.
- Exact hostname redirect behaviour, especially in AP mode.
- Initial chip support/test matrix and pinned ESP-IDF release.
- Exact filesystem and partition layout.
