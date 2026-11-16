# OpenScale — Communication Protocol

**Document status:** Draft for firmware/WebUI negotiation  
**Version:** Protocol draft 0.1  
**Purpose:** Independent interface contract for the firmware and WebUI projects.

> This document records agreed principles and illustrative payloads. Exact endpoint names, parameters and several response details remain **TBD** and must be agreed by both projects before implementation is treated as compatible.

## 1. General principles

- HTTP is used for configuration, files, history, metadata and status.
- Server-Sent Events (SSE) are used for live samples and important state-change events.
- Device status is polled over HTTP; it does not need a separate high-rate SSE stream.
- History is retrieved separately over HTTP. The server does not replay missed SSE events.
- All sample timestamps are monotonic microseconds since boot.
- Sample IDs are monotonically increasing per sensor.
- JSON field names and binary field meanings must remain consistent across firmware and WebUI versions.
- API/protocol versioning is distinct from firmware versioning.

## 2. Timestamp and identity model

### Sample fields

| Field | Type | Meaning |
|---|---|---|
| `sensorId` | unsigned integer | Numerical sensor identifier |
| `n` | unsigned 64-bit integer | Per-sensor sample ID |
| `t` | unsigned 64-bit integer | Monotonic microseconds since boot |
| `raw` | signed integer | Sensor-specific raw value |
| `flags` | unsigned integer | Sample quality/warning bit flags; exact bit assignments TBD |

Do not interpret `t` as Unix time. Wall-clock time can be set or adjusted while sampling continues. The device may expose a current wall-clock timestamp paired with a monotonic uptime timestamp; the WebUI can use that as a conversion anchor.

JavaScript precision warning: integers above `2^53 - 1` cannot be represented exactly by a JavaScript `Number`. Implementations must constrain values to the safe range or use decimal strings/BigInt-compatible handling where necessary.

## 3. Live stream (SSE)

One SSE endpoint carries sensor samples and important state-change events. Exact URL is **TBD**.

### Global SSE event ID

Each event receives a global event ID formed from:
- A random boot/session ID generated at startup (no flash write per boot).
- A monotonically increasing event counter within that boot.

Illustrative format:

```text
id: a83f21c9-1042
```

This global ID orders events across sensors and event types. It is not the same as the per-sensor sample ID `n`. The server does not currently provide replay based on `Last-Event-ID`.

A changed boot ID tells the WebUI that a new device session has begun.

### Sample event

```text
id: a83f21c9-1042
event: sample
data: {"sensorId":0,"n":501,"t":123456789,"raw":12345,"flags":0}

```

### Warning event

Emit when a warning state changes, not continuously while it remains active. Illustrative payload:

```text
event: warning
data: {"sensorId":0,"type":"overload","active":true,"threshold":8388607,"raw":9000000,"n":502}

```

The exact warning names, threshold representation and whether transition sample ID is always present are **TBD**. Warning/quality flags should also be stored with samples so history can show warning periods.

### Device/state event

The same stream may carry important device or sensor state transitions. Exact event names and payload schemas are **TBD**. Routine device status remains polled over HTTP.

## 4. History retrieval

History uses a separate HTTP endpoint. Exact URL, query parameters, pagination/cursor rules and chunk limits are **TBD**.

The WebUI should establish the live SSE connection and buffer incoming samples before requesting history. After history arrives, it can merge/deduplicate by `sensorId` and per-sensor sample ID `n`. This avoids a gap between the history snapshot and the start of live reception.

No server-side SSE replay is currently planned.

### JSON representation (illustrative)

```json
{
  "sensorId": 0,
  "samples": [
    {"n": 1001, "t": 123456789012, "raw": 123456, "flags": 0},
    {"n": 1002, "t": 123469289012, "raw": 123457, "flags": 0}
  ],
  "latestId": 1200
}
```

`latestId` is the snapshot boundary/latest sample ID for the response, if retained in the final design. Exact semantics and pagination are **TBD**.

### Binary representation (proposed)

All multi-byte fields are little-endian.

| Offset | Field | Size | Meaning |
|---:|---|---:|---|
| 0 | Magic | 4 bytes | ASCII `HIST` (`48 49 53 54`) |
| 4 | Version | 2 bytes | Binary format version |
| 6 | Flags | 2 bytes | Format flags; assignments TBD |
| 8 | Sample count | 4 bytes | Number of sample records following |
| 16 | Sample ID | 8 bytes | Unsigned per-sensor ID |
| 24 | Timestamp | 8 bytes | Unsigned microseconds since boot |
| 32 | Raw value | 8 bytes | Signed 64-bit raw value |
| 40 | Sample flags | 4 bytes | Warning/quality bit flags |

Header size: 16 bytes. Record size: 28 bytes. Expected response size:

```text
16 + (sampleCount * 28)
```

The receiver should validate magic, supported version, count and actual payload length before accepting the records.

The binary version is independent of the HTTP API version. Any change to record layout or field meaning requires an explicit binary format version change.

### Buffer sizing and resize behaviour

Per-sensor history capacity is dynamically adjustable where memory permits. Two resize modes are intended:
- `preserve`: copy the newest samples that fit into a replacement buffer.
- `clear`: release old allocation before allocating the new capacity; history is cleared.

Exact HTTP representation is **TBD**. Allocation failure must be reported; never claim a resize succeeded when it did not. The device should report actual capacity and usage.

## 5. Status and metadata

The WebUI polls device status. Suggested cadence is approximately every 2–5 seconds for dynamic status, with slower polling for less dynamic storage details as appropriate. Exact endpoint paths are **TBD**.

Status should expose available information such as:
- Device uptime.
- Sensor state, errors and sensor uptime.
- Per-sensor buffer capacity and usage.
- Heap/internal RAM/PSRAM availability and largest free blocks.
- Wi-Fi connection state, RSSI and IP address.
- Flash physical capacity and filesystem/partition total, used and free space.
- Current wall-clock timestamp and corresponding monotonic timestamp, when wall clock is valid.
- CSRF token needed for mutating requests, if the agreed flow returns it here.

Metadata should expose:
- Firmware Semantic Version, build ID and Git commit.
- ESP-IDF version, chip model/revision and core count.
- Flash and PSRAM size/type where available.
- Supported capabilities and protocol versions.

Do not confuse physical flash size with free filesystem space.

## 6. File operations

The intended model is to use the same resource path for retrieval and replacement.

Examples:

| Operation | Method | Path |
|---|---|---|
| Retrieve static asset | GET | `/another.html` |
| Upload/replace static asset | PUT | `/another.html` |
| Retrieve calibration file | GET | `/data/calibration/example.json` |
| Upload/replace calibration file | PUT | `/data/calibration/example.json` |
| Delete calibration file | DELETE | `/data/calibration/example.json` |

These are examples of the path/method convention, not a complete route allowlist.

Static asset paths may contain slash-separated components. The firmware must prevent path traversal and protect reserved/default assets and protected data paths.

Calibration files are not bound to a sensor by their URL. The calibration JSON itself identifies the sensor/type it belongs to. Multiple calibration JSON files are allowed; the firmware must not enforce one file per sensor. How a calibration is selected/activated remains **TBD**.

Configuration JSON resources should use `.json` paths and full filenames such as `webui-settings.json`. Exact configuration routes are **TBD**.

## 7. Authentication and CSRF

- HTTP Basic authentication is used when an admin password is configured.
- All mutating operations require authentication when a password is configured.
- A per-boot CSRF token is agreed in principle.
- The WebUI obtains the token through an authenticated status/device-information flow and includes it with mutating requests.
- Exact token response field, request header name, error response and token lifecycle are **TBD**.
- Do not enable permissive CORS by default. Loading a CDN-hosted JavaScript library as a script resource does not require the ESP32 API to allow cross-origin API requests.
- If cross-origin API access is needed later, define a restrictive configurable policy. CORS is not a substitute for CSRF protection.

## 8. HTTP index selection and static assets

A single setting in `settings.json`, tentatively named `http_indexpath`, selects the file served for `/`. This lets a user upload a custom WebUI and select its entry page instead of the firmware default.

No general-purpose `/api/files/index` endpoint is currently required. The WebUI's own settings file is for the UI and is not interpreted by the ESP32.

All WebUI assets must be gzip-compressed in development and production builds and served with the correct `Content-Encoding: gzip` header.

## 9. Configuration application and restart reporting

The firmware reports whether a configuration change:
- Was applied immediately.
- Requires sensor-driver reconfiguration.
- Requires a full device restart.
- Failed validation or could not be applied.

The WebUI decides when to request a restart. The firmware must not automatically reboot just because a setting was changed. The protocol should distinguish saved settings from currently active settings where changes are pending.

A power loss cannot be announced by the device. The WebUI detects a new session through the boot ID and may use timestamp gaps as additional evidence.

## 10. Error handling and compatibility — TBD

Both projects still need to agree:
- Common JSON error envelope and error codes.
- HTTP status codes for validation, authentication, allocation failure, protected paths and unsupported operations.
- Exact history pagination and truncation indicators.
- Maximum response sizes and partial-history behaviour.
- Exact CSRF token field/header names.
- API version negotiation and backward-compatibility policy.
- Exact SSE event names and schemas beyond the illustrative sample/warning events.

## 11. Protocol negotiation checklist

Before calling this protocol stable, firmware and WebUI owners should agree on:
1. Exact endpoint paths and methods.
2. Query parameters and pagination semantics.
3. JSON response schemas.
4. Binary version 1 layout and flag assignments.
5. SSE event names, payloads and boot/session ID format.
6. Status/metadata fields and CSRF token exchange.
7. Authentication/error behaviour.
8. Runtime buffer-resize request and response.
9. Configuration application/restart reporting.
10. Compatibility/version negotiation.
