# OpenScale ESP32 — HTTP, SSE and Data Protocol

**Document purpose:** Firmware/WebUI communication contract baseline  
**Version:** 0.2

## 1. Protocol status and conventions

The communication contract is maintained as an implementation baseline. Items marked **Open** must not be treated as a frozen API contract.

Acceptance-status words:

- **Explicit** — directly confirmed by the user.
- **Implicit** — proposed in the requirements and not rejected, or included in a general agreement.
- **Open** — exact route, parameter, field or behaviour was not settled.

General conventions:

- HTTP is used for finite requests, configuration, history, status and actions.
- One SSE endpoint carries live sensor samples and important state-change events.
- JSON request/response bodies use `application/json`.
- Binary history uses `application/octet-stream`.
- SSE uses `text/event-stream`.
- All sample timestamps are unsigned 64-bit monotonic microseconds since boot, not UTC/wall-clock time. The `raw` history/sample field is unsigned 64-bit.
- Static WebUI asset content is gzip-compressed and served with `Content-Encoding: gzip` in every build type.

## 2. Endpoint summary

### 2.1 Device, status, history and stream

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET` | `/` | Serve the selected index asset from `settings.json.http_indexpath` (default `/default.html`) | Explicit |
| `GET` | `/api/device` | Relatively static product/build/chip/capability metadata, including the random boot ID | Implicit |
| `GET` | `/api/status` | Frequently changing runtime, memory, Wi-Fi, sensor and buffer status; also the intended initial source for the per-boot CSRF token | Implicit |
| `GET` | `/api/device-log` | Retrieve device network-log entries, including startup configuration fallback notices | Explicit |
| `GET` | `/api/history` | Retrieve historical samples independently of the live SSE stream | Explicit for separate endpoint; query contract Open |
| `GET` | `/stream` | Single multiplexed live SSE stream for all enabled sensors and device events | Explicit |
| `POST` | `/api/restart` | Explicitly request a device restart | Implicit |

`/api/device` and `/api/status` were proposed as separate resources following the initial combined device/runtime endpoint design under `/api/device`. The later separation is the intended direction: metadata in `/api/device`, live status in `/api/status`.

### 2.2 Configuration resources

The file namespace is `/data/settings/`. The data API exposes these direct GET paths, and the requirements specify that configuration PUT paths should end in `.json` and that the complete filename `webui-settings.json` must be used.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET` | `/data/settings/settings.json` | Read system settings | Implicit |
| `GET` | `/data/settings/wifi.json` | Read Wi-Fi settings (additional configuration resource) | Implicit |
| `GET` | `/data/settings/sensors.json` | Read sensor configuration | Implicit |
| `GET` | `/data/settings/units.json` | Read unit definitions | Explicit |
| `GET` | `/data/settings/webui-settings.json` | Read WebUI-owned settings | Explicit |
| `PUT` | `/api/config/settings.json` | Validate and replace system settings | Open route prefix; `.json` suffix Explicit |
| `PUT` | `/api/config/wifi.json` | Validate and replace Wi-Fi settings | Open route prefix; file separation Implicit |
| `PUT` | `/api/config/sensors.json` | Validate and replace sensor configuration | Open route prefix; `.json` suffix Explicit |
| `PUT` | `/api/config/units.json` | Validate and replace unit definitions | Open route prefix; `.json` suffix Explicit |
| `PUT` | `/api/config/webui-settings.json` | Replace WebUI-owned settings | Open route prefix; full filename Explicit |

The `/api/config/` PUT prefix is provisional. The exact config PUT route prefix and whether config GET and PUT use identical URLs remain open. Password protection applies to `settings.json` and `wifi.json` for both GET and PUT; to `sensors.json` and `units.json` for PUT only; and to calibration JSON for PUT only.

Configuration writes must not automatically restart the ESP. Their response should identify whether the change was applied immediately, requires sensor reconfiguration, requires a full restart, or could not be applied. The WebUI decides whether and when to call `POST /api/restart`.

### 2.3 Calibration resources

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET` | `/data/calibration/<name>.json` | Read a calibration document | Explicit |
| `PUT` | `/data/calibration/<name>.json` | Create or replace the same calibration resource | Explicit |
| `DELETE` | `/data/calibration/<name>.json` | Delete a calibration document | Implicit |

There may be any number of calibration JSON files. The file itself identifies the sensor it belongs to; the URL is not `/api/sensor/<id>/...`. Do not require one calibration file per sensor. Calibration files are non-essential: save and serve submitted content even if validation fails, and report the failed check to the WebUI. A calibration-list endpoint and the exact calibration JSON schema were not finalised.

### 2.4 Static assets and file index

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET` | `/<web-path>` | Serve a static asset | Explicit |
| `PUT` | `/<web-path>` | Upload or replace an asset at the same path | Explicit |
| `DELETE` | `/<web-path>` | Delete an uploaded asset | Explicit |
| `GET` | `/api/files` | List static assets, all settings files, calibration files and API paths as JSON | Explicit |

Paths may contain `/` so users can create their own web directory structure. Physical directories may be used, or the firmware may map logical paths; the URL structure is what matters. Prevent path traversal and reject reserved/protected paths. `default.*` files are immutable through the ordinary file API. `/data` is protected and must never be accepted by generic asset handling.

Static asset GET paths are direct root paths (`/<static-asset-path>`). PUT and DELETE are permitted on the same resource path except for protected files/paths. If an administrator password is configured, PUT and DELETE require password authentication; GET is not password-protected by this rule. Static asset uploads contain gzip bytes and use `Content-Encoding: gzip`. The server stores those compressed bytes and serves them with `Content-Encoding: gzip`. Gzip is mandatory in development and production builds. JSON files are permitted as generic static assets, except where their paths are reserved/protected for data/configuration resources.

The former `POST /api/files/index` endpoint is not part of the accepted design: the selected index is `http_indexpath` in `settings.json`. The `/api/files` endpoint is required as an index of static assets, all settings files, calibration files and API paths. The `/api/files/rename` endpoint is not part of this API; files are addressed directly by their resource paths.

## 3. History API

### 3.1 Purpose and usage

History is separate from live SSE. The WebUI usually retrieves the ring-buffer snapshot at initialisation and may request additional ranges when the user navigates history. A sample ID is the cursor; timestamps are included for plotting and ordering.

`GET /api/history` is the history endpoint. The WebUI-side description initially used a per-sensor `historyUrl` with `sensor`, `from_id` and `to_id`; the initial implementation scaffold used `sensor_id` and `limit`; alternative candidate names include `sensorId`, `fromId`, `toId`, `limit`, `fromTimestamp` and `toTimestamp`. The final query-key spellings were **not** settled.

Candidate request shape (query names are provisional):

```http
GET /api/history?sensor_id=0&from_id=1000&to_id=6000
```

The chat also proposed a `limit` parameter and optional timestamp bounds. It did not settle whether one request returns one sensor or multiple sensors. The JSON example is per-sensor; the user raised the possibility of an aggregate response for multiple sensors but did not close that decision.

### 3.2 JSON response

```json
{
  "sensorId": 0,
  "samples": [
    {
      "n": 1001,
      "t": 123456789012,
      "raw": 123456
    },
    {
      "n": 1002,
      "t": 123469289012,
      "raw": 123457
    }
  ],
  "latestId": 1200
}
```

| Field | Meaning |
|---|---|
| `sensorId` | Numerical sensor ID |
| `samples[].n` | Per-sensor sample ID, unsigned 64-bit in the common design |
| `samples[].t` | Monotonic timestamp, microseconds since boot |
| `samples[].raw` | Unsigned 64-bit raw sensor value |
| `latestId` | Latest sample ID currently known for that sensor; useful for pagination/truncation detection |

`latestId` is not required in SSE. Warning/quality state is intended to be preserved in history too, but the precise JSON representation (`warnings` array, flag field or both) remains open.

### 3.3 Binary response

The proposed binary format is little-endian. `HIST` is a four-byte ASCII magic signature (`48 49 53 54`) used to identify the payload. `sample count` is the number of records in this response, not a sensor ID or a cumulative sample ID.

| Header field | Size | Meaning |
|---|---:|---|
| Magic `HIST` | 4 bytes | Format identifier |
| Version | 2 bytes | Unsigned format version; value `1` |
| Header flags | 2 bytes | Unsigned; future format options, bit assignments open |
| Sample count | 4 bytes | Unsigned count of following records |

| Record field | Size | Meaning |
|---|---:|---|
| `n` | 8 bytes | Unsigned per-sensor sample ID |
| `t` | 8 bytes | Unsigned monotonic timestamp in microseconds since boot |
| `raw` | 8 bytes | Unsigned raw value |
| Sample flags | 4 bytes | Sensor quality/status flags; bit assignments open |

The record size is 28 bytes. The header fields total 12 bytes. The actual payload length is:

```text
12 + (sampleCount × 28)
```

For 5,000 records this is 140,012 bytes (about 136.7 KiB). No additional header bytes are present.

The format version is `1`. Header flags are reserved for future use and are distinct from per-sample flags.

### 3.4 Chunk and truncation behaviour

- The WebUI's proposed initial chunk size is 5,000 samples.
- The ESP should support larger chunks where hardware and configured limits permit.
- Each sensor's ring-buffer capacity is configurable and should be discoverable through metadata/status.
- The HTTP history response has a separate bounded maximum response size. Do not vary the limit unpredictably with current free RAM for each request.
- The WebUI must accept fewer samples than requested.
- If the requested range cannot be fully returned, the response must clearly identify the actual returned range and indicate truncation. A missing ID range must not silently look like a complete response.

The following response headers were suggested, but their names were explicitly described as not yet final:

```http
X-History-Returned: 5000
X-History-Latest-Id: 12000
X-History-First-Id: 7001
X-History-Truncated: false
X-History-Max-Chunk: 5000
```

Equivalent information may be included in the JSON body/metadata. The exact header names, semantics and whether JSON must duplicate them remain open.

## 4. SSE live stream

### 4.1 Endpoint and connection behaviour

`GET /stream` is the one SSE endpoint for all sensors. It carries live samples and important state-change events. Ordinary runtime status is polled over HTTP; a second dedicated status SSE endpoint is not wanted for the initial design.

The stream does not replay historical data and does not implement server-side `Last-Event-ID` replay. A new connection starts at the current live edge. The WebUI handles reconnection gaps and retrieves missing history separately.

### 4.2 Initialization and history overlap

Recommended client sequence:

1. Open `/stream` first and temporarily buffer incoming events.
2. Request history for the required sensor(s).
3. Initialise the graph/history from the HTTP response.
4. Merge buffered SSE samples, deduplicating by `sensorId` plus per-sensor `n`.
5. Continue processing live SSE samples.

This avoids a gap between the history snapshot and starting the stream. The WebUI can use `latestId` from history as a per-sensor boundary.

### 4.3 Global event ID and boot identity

Keep two independent identifiers:

| Identifier | Scope | Purpose |
|---|---|---|
| Sample ID `n` | Per sensor | Identifies/orders samples from that sensor |
| SSE `id:` | Entire device stream | Identifies/orders every SSE event, including non-sample events |

Generate a random boot/session ID once per device startup. Do not write a boot counter to flash. The SSE event ID is:

```text
<bootId>-<eventCounter>
```

Example:

```text
id: a83f21c9-1042
event: sample
data: {"sensorId":0,"n":501,"t":123456789,"raw":12345}
```

The Global Event ID is a monotonically increasing 64-bit counter within the boot session. It advances for every SSE event sent on `/stream`, regardless of event type. A new random `bootId` distinguishes a later boot even though the event counter starts again.

### 4.4 Sample event

Proposed event name and payload:

```text
event: sample
data: {"sensorId":0,"n":501,"t":123456789,"raw":12345}
```

Use `sensorId`, not the WebUI's earlier `id` field. `t` is microseconds since boot, not milliseconds. `n` is the per-sensor sample ID. The separate SSE `id:` line is device-global.

The initial implementation scaffold used a batched `event: samples` with `sensor_id`, `seq` and `timestamp_us`. Later discussion moved toward the compact `sample` payload and global boot-scoped event ID. Whether dispatch is one `sample` event per sample or batched events remains open; the WebUI and firmware must agree before implementation is frozen.

### 4.5 Other event types

Important state changes share the same stream:

| Event | Purpose | Status |
|---|---|---|
| `warning` | Overload/underload threshold activation or clear transition | Implicit |
| `device` | Important device state changes, including restart-related/session information where detectable | Explicit |
| `sensor_error` | Sensor error/connection state changes | Implicit |
| Device network-log event | New device network-log entry, including startup fallback to defaults; exact SSE event name Open | Explicit for event delivery; event name Open |

Warning event example:

```text
event: warning
data: {"sensorId":0,"type":"overload","active":true,"threshold":8388607,"raw":9000000,"n":501,"t":123456789}
```

Emit a warning event when the warning state changes, not on each sample. Threshold-derived warning flags are generated on-the-fly and are not stored in ring buffers. Sensor quality/status flags include at least disconnection, sensor error, overload, underload, invalid measurement and future quality indicators; exact bit assignments and persistence policy remain open.

A device-network-log SSE event carries a network-log entry; the exact event name and JSON property schema remain open. The event is emitted for startup fallback when `settings.json` or `wifi.json` cannot be loaded: in-memory defaults are used, the saved file is left unchanged, and the event is also retrievable through `GET /api/device-log`. Device and sensor-error event payload schemas were not fully defined. Routine device statistics remain available through `/api/status` polling.

## 5. Device metadata and status APIs

### 5.1 `GET /api/device`

Returns relatively static metadata:

- Product and firmware semantic version.
- Firmware build identifier and Git commit.
- ESP-IDF version.
- Chip model, revision and core count.
- Flash size/type and partition/filesystem information.
- PSRAM presence, size/type and supported memory information.
- Supported capabilities and protocol versions.
- Network capabilities.

The example metadata fields shown in the JSON document are candidates, not a fixed schema. Include as much reliable hardware information as the chip/IDF exposes.

### 5.2 `GET /api/status`

Returns dynamic state:

- Uptime. The random `bootId` is supplied in `/api/device` metadata.
- Free/minimum-ever heap, largest free block and internal RAM availability.
- PSRAM total/free/largest block.
- Physical flash size separately from filesystem/partition total, used and free space.
- Ring-buffer capacity/usage/retention for each sensor.
- Queue usage/allocation, queue drops, read errors and sensor states.
- Wi-Fi connection state, RSSI and IP address.
- The per-boot CSRF token for use in subsequent mutating requests (intended; exact field name open).

Suggested polling rates from the requirements: 2–5 seconds for uptime/memory/buffers/Wi-Fi/sensor status; 10–60 seconds for flash/filesystem statistics. The WebUI may tune these rates.

## 6. Authentication, CSRF and CORS

### 6.1 HTTP Basic authentication

When an administrator password has been set, apply these resource-specific rules:

- `settings.json` and `wifi.json`: protect both GET and PUT.
- `sensors.json` and `units.json`: protect PUT only; GET remains available without password authentication.
- Calibration JSON files: protect PUT only; GET and DELETE remain available without password authentication.
- Static assets: protect PUT and DELETE; GET remains available without password authentication.
- Protect other mutating operations, including static-asset PUT/DELETE and restart, unless a resource-specific rule above states otherwise.
- Do not return Wi-Fi passwords in ordinary GET responses.

Before an administrator password exists, the original design only required authentication once one has been configured. This makes initial provisioning/recovery important; set an administrator password before using the device on an untrusted network.

Basic Auth credentials are Base64-encoded, not encrypted. Plain HTTP therefore does not protect credentials against network observation. HTTPS/TLS is deferred; use only on a trusted network until TLS is implemented.

### 6.2 CSRF

Use a random per-boot CSRF token. Require it on every mutating HTTP request. The WebUI obtains it through an authenticated device/status request, which it needs to make at startup anyway. The exact JSON field name and HTTP request-header name were not chosen in the requirements and remain open.

### 6.3 CORS

Do not enable permissive cross-origin access by default. A future configurable policy may be considered if required. Loading a JavaScript dependency from a CDN does not by itself require the ESP32 API to permit cross-origin requests; the browser loads that script from the CDN origin.

## 7. Hostname and HTTP/HTTPS behaviour

A hostname is generated once if not configured, using `openscale_` and the final three bytes of the base MAC in hexadecimal, e.g. `openscale_a1b2c3`. Save it in `settings.json`, expose it through mDNS, and allow the user to change it.

With `redirectToHostname` enabled, redirect IP-address requests to the hostname. Preserve path and query. Do not redirect when the request already uses the hostname, when mDNS/hostname availability is not established, or in AP mode unless that name is known to resolve there. The toggle can be disabled, including through serial recovery.

## 8. Configuration update and restart workflow

A configuration write must validate the proposed JSON before replacing critical settings. Its response should report one of:

- Applied immediately.
- Saved but requires sensor reconfiguration.
- Saved but requires full device restart.
- Not applied / rejected.

The firmware must not restart itself automatically after a settings write. The WebUI decides whether to request a restart using `POST /api/restart`. The device should report active versus saved/pending settings so the WebUI can present the state accurately.

History buffer capacity changes should be handled at runtime without a full device restart. Threshold-derived warning flags are generated on-the-fly and must not be stored in the ring buffers if doing so would increase per-sample RAM usage. The API should accept `preserve` or `clear` semantics, but the exact JSON request property is open.

## 9. Error handling and unresolved contract points

A common HTTP status-code policy, error JSON schema, config PUT route prefix, all history query names, history all-sensors/per-sensor semantics, response negotiation for JSON versus binary, CSRF header/field names, or exact event batching. These must be agreed between firmware and WebUI before the protocol is frozen.

The initial implementation snapshot's initial endpoint list is not the final API: it includes routes later removed or changed (`/api/files/index`, `/api/files/rename`, `/api/calibration/...`, and automatic restart after config PUT). Use the later direct calibration/static paths and `http_indexpath` setting recorded above.
