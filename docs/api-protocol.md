# OpenScale: HTTP, SSE and Data Protocol (v0.3, merged WebUI + ESP proposal)

**Purpose:** merge of `api-protocol_v0_2.md` (ESP side) with what the WebUI implements and needs.
**For:** ESP AI worker (check, re-discuss, incorporate into the working documents).
**Companion:** `json-file-formats_v0_3.md` (file schemas, `rawFormat`, conversions).

Status tags: **[Agreed]** settled between user and WebUI side. **[Proposal]** WebUI requirement, ESP to confirm. **[ESP]** ESP decides. **[Open]** unresolved.

---

## 1. Conventions

- **[Agreed]** IDs: sensors are numeric (`sensorId`). Field names are `sensorId`, `n`, `t`, `raw`.
- **[Agreed]** `t` = unsigned 64-bit **microseconds since boot** (one clock for all sensors and events). The WebUI divides by 1000 internally; no per-device or per-sensor time origin is needed.
- **[Agreed]** `raw` = unsigned 64-bit on the wire, always. Its meaning comes from `rawFormat` in `sensors.json` (see file-format doc §5.2). The WebUI converts. The history binary layout does not depend on the sensor type.
- **[Agreed]** Config files: GET, PUT and DELETE on the same URL `/data/settings/<name>.json`. No `/api/config/` prefix.
- **[Agreed]** `DELETE` on a settings file resets it to its factory default; a following GET returns the default (200).
- **[Agreed]** No `PATCH`. Whole-file PUT; the ESP works out the effect itself.
- **[Agreed]** Same origin: the WebUI is served by the ESP. No CORS needed.
- **[Agreed]** Static WebUI assets are gzip (ESP v0.2). The WebUI's uPlot library is served by the ESP as an asset (`/vendor/uPlot.iife.min.js`, `/vendor/uPlot.min.css`, version 1.6.32); no CDN dependency in production.

## 2. Endpoints

| Method | Path | Purpose | Protected (if password set) |
|---|---|---|---|
| GET | `/` | Index asset from `settings.json.http_indexpath` | no |
| GET | `/api/device` | Static metadata, capabilities, protocol versions | no |
| GET | `/api/status` | Runtime status, `bootId`, CSRF token | no |
| GET | `/api/device-log` | General-purpose device log | no |
| GET | `/api/history` | History range of **one** sensor | no |
| GET | `/stream` | Live SSE stream | no |
| POST | `/api/restart` | Restart request | yes |
| GET/PUT/DELETE | `/data/settings/settings.json`, `wifi.json` | System / Wi-Fi settings | GET, PUT, DELETE |
| GET/PUT/DELETE | `/data/settings/sensors.json`, `units.json`, `webui-settings.json` | Sensors, units, WebUI defaults | PUT, DELETE |
| GET/PUT/DELETE | `/data/calibration/<name>.json` | Calibration files (gzip) | PUT (DELETE: open point 1) |
| GET/PUT/DELETE | `/<web-path>` | Static assets | PUT, DELETE |
| GET | `/api/files` | Index of assets, settings, calibration files, API paths | no |

Removed from v0.2: `/api/config/*`.

## 3. Start-up sequence of the WebUI [Agreed]

1. `GET /api/status` (gets `bootId`, `csrfToken`) and `GET /api/device`.
2. `GET` `sensors.json`, `units.json`, `webui-settings.json` (embedded defaults if unavailable); `GET /api/files` for calibration files.
3. Open `/stream`, buffer events.
4. For each enabled sensor, request history backwards in chunks (initially 5,000 samples), merge with buffered SSE samples (deduplicate by `sensorId` + `n`).
5. Poll `/api/status` every 2 to 5 s (flash/filesystem figures every 10 to 60 s).

**Reboot detection:** the WebUI compares `bootId` of every status poll and every SSE (re)connect with the stored one. A different `bootId` starts a new epoch: old samples are kept as an earlier session, timestamps restart. As a backstop, an `n` or `t` that goes backwards also counts as a new boot. The SSE `id:` line is **not** parsed by the WebUI; `/api/status` is the only source of `bootId` (no duplication elsewhere).

## 4. History API

### 4.1 Request [Proposal, ESP to confirm]

```http
GET /api/history?sensor_id=0&from_id=1000&to_id=5999&limit=5000&format=bin
```

| Parameter | Meaning |
|---|---|
| `sensor_id` | Numeric sensor ID. **One sensor per request.** |
| `from_id`, `to_id` | Inclusive per-sensor sample-ID range; response ascending by `n` |
| `limit` | Optional maximum number of samples |
| `format` | `json` (default) or `bin` (`application/octet-stream`) |

The WebUI prefers binary. It accepts **fewer** samples than requested and never assumes completeness without the range information below. Query keys are snake_case (replaces the WebUI's earlier `sensor`; the per-sensor `historyUrl` is dropped).

### 4.2 Range information [Proposal]

Both formats must tell the WebUI the actual range. Headers (names not final) and, for JSON, the same values in the body:

```http
X-History-Returned: 5000
X-History-First-Id: 7001
X-History-Latest-Id: 12000
X-History-Oldest-Id: 1500
X-History-Truncated: false
X-History-Max-Chunk: 5000
```

`X-History-Oldest-Id` (oldest sample ID still retained in the ring buffer) is **new**: the WebUI uses it to know when it has reached the beginning, instead of probing with empty chunks.

### 4.3 JSON response

```json
{
  "sensorId": 0,
  "samples": [ { "n": 1001, "t": 123456789012, "raw": 123456, "flags": 0 } ],
  "firstId": 1001,
  "latestId": 1200,
  "oldestId": 801,
  "truncated": false
}
```

`flags` is optional (absent = 0).

### 4.4 Binary response (ESP v0.2 layout, version 1, unchanged)

Little endian. Header 12 bytes: magic `HIST`, u16 version `1`, u16 header flags (reserved), u32 sample count. Records of 28 bytes: u64 `n`, u64 `t`, u64 `raw`, u32 sample flags. The WebUI drops its own earlier layouts (12-byte and 16-byte records); this layout is the only one.

### 4.5 Sample flags [Agreed]

- Per-sample flags are **not stored** in the ring buffer (RAM). The only flags are **computed on the fly** while generating a response: overload and underload from the raw thresholds. Other bits (disconnection, sensor error, invalid measurement) are reserved and may be 0.
- **[ESP]** Define the bit assignments (WebUI proposal: bit 0 overload, bit 1 underload, other bits reserved).
- Past events beyond that are available through `/api/device-log` (§6).

### 4.6 Gap filling

When live `n` jumps (dropped frames, reconnect) the WebUI requests the missing `from_id`..`to_id` range. IDs the device no longer has simply stay a gap; the response must say so via the range information.

## 5. SSE `/stream`

- **[Agreed]** One endpoint for all sensors. No replay, no `Last-Event-ID` handling; a new connection starts at the live edge. The browser reconnects itself; the WebUI fills gaps via history.
- **[Agreed]** `id:` line `<bootId>-<eventCounter>` as in v0.2 (informational for the WebUI).
- **[Agreed]** Events: `sample`, `warning`, `device`, `sensor_error`, plus a device-log event (name **[ESP]**).
- **[Agreed]** **One `sample` event per sample**; the WebUI also accepts a JSON array of samples in one event (handles both). Open questions on the ESP side are not a WebUI problem.

```text
id: a83f21c9-1042
event: sample
data: {"sensorId":0,"n":501,"t":123456789,"raw":12345}
```

- **[Agreed]** SSE samples carry **no flags**. Overload/underload reach the WebUI through `warning` events:

```text
event: warning
data: {"sensorId":0,"type":"overload","active":true,"threshold":8388607,"raw":9000000,"n":501,"t":123456789}
```

Sent on state change only (also `active:false` on clear). The WebUI shows these in addition to its own weight-based monitor. `device` and `sensor_error` payloads: **[ESP]** to define (the WebUI needs at least `sensorId`, `state`/`message`, `t`).

## 6. `/api/device`, `/api/status`, `/api/device-log`

### 6.1 `/api/device` (static)

As v0.2 (product, firmware, build, git commit, IDF, chip, revision, cores, flash, PSRAM, network capabilities, `capabilities`). **[Proposal]** add `protocolVersion` and `fileFormatVersions` (e.g. `{"sensors":1,"units":1}`). `bootId` is **not** here.

### 6.2 `/api/status` (dynamic)

As v0.2, with these WebUI needs:

```json
{
  "bootId": "a83f21c9",
  "uptimeUs": 123456789012,
  "csrfToken": "…",
  "pendingChanges": ["sensors.json"],
  "memory": { "heapFree": 120000, "heapMinFree": 80000, "heapLargestBlock": 64000, "psramTotal": 8388608, "psramFree": 7000000, "psramLargestBlock": 4000000 },
  "flash": { "physicalTotal": 4194304, "filesystemTotal": 1900000, "filesystemUsed": 400000, "filesystemFree": 1500000 },
  "wifi": { "connected": true, "rssi": -55, "ip": "192.168.1.50" },
  "sensors": [
    { "sensorId": 0, "state": "ok", "rate_hz": 80, "configRevision": 3,
      "ringBufferCapacity": 1600, "ringBufferUsed": 1200, "oldestId": 801, "latestId": 2000,
      "queueDrops": 0, "readErrors": 0 }
  ]
}
```

- **[Agreed]** `bootId` is only here; the WebUI polls status regularly anyway.
- **[Proposal]** `csrfToken` (field name), `pendingChanges` (files saved but not yet active), per sensor the **effective** `rate_hz`, a `configRevision` counter that increments when anything changes the meaning of the samples (rate, type, `rawFormat`, buffer cleared), plus `oldestId`/`latestId`. The WebUI starts a new buffer when `configRevision` changes.
- **[Agreed]** `flash.filesystemFree` (remaining capacity) is needed so the WebUI can show free space; **[ESP]** may add a maximum file size if known in advance.

### 6.3 `/api/device-log` [Agreed layout, ESP to specify content]

General purpose log. Each entry:

```json
{
  "logEntryId": 17,
  "t": 123456789012,
  "type": "sensor_error",
  "message": "HX711 sensor 0: read timeout",
  "details": { "sensorId": 0, "fromN": 1200, "toN": 1260 }
}
```

- `logEntryId`: increasing ID; `t`: µs since boot (**[ESP]** may add wall-clock/boot reference); `type`: string; `message`: human-readable; `details`: object whose content depends on `type`.
- For sample-related types `details` should carry `sensorId` and a sample range (`fromN`, `toN`) so the WebUI can mark affected samples later.
- **Todo for the ESP worker:** define the log types, the `details` per type, retention and the SSE event name for new entries. Startup fallback notices (v0.2) stay.

## 7. Configuration writes

### 7.1 Response of a PUT/DELETE to a config file [Proposal]

```json
{ "status": "applied", "saved": true, "errors": [], "warnings": [] }
```

`status`: `applied` | `needs-sensor-reconfig` | `needs-restart` | `rejected`. The ESP classifies per changed key: WebUI-owned keys, `name`, `notes`, `calibrationFile`, `conversion`, `loadLimits` etc. are `applied` without touching sensors. `rate_hz`, `type`, `rawFormat`, driver blocks and `ringbuffer_size_samples` need sensor reconfiguration. No automatic restart. The WebUI decides whether to call `POST /api/restart` and then polls `/api/status` until `bootId` changes.

Ring-buffer resize mode: query parameter on the `sensors.json` PUT, `?buffer=preserve|clear` (default `preserve`).

### 7.2 HTTP status codes and error bodies [Proposal]

| Code | Use |
|---|---|
| 200 | Success (also "saved, restart needed"; see `status`) |
| 400 | Malformed JSON or validation failure (`rejected`) |
| 401 | Password needed or wrong |
| 403 | Missing/wrong CSRF token |
| 404 | Unknown path |
| 413 | Body larger than the ESP's limit (**[ESP]** decides limits) |
| 507 | Not enough flash space to store the file |

**[Agreed]** The ESP may put a detailed message into the body of any HTTP error. The WebUI displays it (JSON `{"error":{"code","message","details"}}` preferred; plain text also shown). Calibration PUTs are stored whenever flash allows; failures are only flash errors for now.

## 8. Authentication and CSRF

### 8.1 Password

- **[Agreed]** The WebUI first sends requests **without** credentials. Only if the server answers **401** does it ask the user, then retries once with `Authorization: Basic …`. If no password is set it never asks. This applies to protected **GET** requests too (`settings.json`, `wifi.json`).
- **[Proposal]** The 401 response should **not** carry `WWW-Authenticate: Basic …` (or use a scheme the browser does not prompt for), otherwise the browser shows its own password dialog for `fetch` requests, which the WebUI cannot control or forget. ESP to confirm that this is acceptable.
- Read-only access (GET of unprotected resources, SSE, history) never needs a password. Plain HTTP exposes Basic credentials; use on trusted networks until TLS exists.

### 8.2 CSRF [Proposal]

- Token: field `csrfToken` in `/api/status` (random per boot).
- The WebUI sends it in the request header **`X-CSRF-Token`** on **every** `PUT`, `POST`, `DELETE`.
- On `403` the WebUI re-reads `/api/status` once and retries (token changes after a reboot).

## 9. Static assets

As v0.2: gzip upload with `Content-Encoding: gzip`, served as stored; PUT/DELETE protected; `default.*` immutable; `/data` not reachable through the generic asset API.

The WebUI consists of one HTML file, one JavaScript file and the uPlot files under `/vendor/`. The user selects the page via `http_indexpath`.

## 10. Calibration files over HTTP

- Upload: `PUT /data/calibration/calibration_<sensorId>_<profileId>.json`, body gzip, headers `Content-Type: application/json`, `Content-Encoding: gzip`, plus `X-CSRF-Token` (and `Authorization` if required).
- The ESP stores the bytes unchanged and serves them with `Content-Encoding: gzip`.
- `GET /api/files` must list each file with its **stored (compressed) size** so the WebUI can show sizes and free space. **[Proposal]** entry shape: `{ "path", "kind": "asset|settings|calibration|api", "size", "modified" }` (`modified` optional).
- The sensor assignment comes from the filename (see file-format doc §8).

## 11. Notes for the ESP worker

1. Define the device-log entry types and the log SSE event name (§6.3).
2. Define sample-flag bits (§4.5) and `device` / `sensor_error` payloads (§5).
3. Decide max file sizes and report 507/413 with a clear body (§7.2).
4. Do not auto-restart; report `pendingChanges` (§6.2).
5. No `PATCH`: compare the new whole file with the active configuration yourself (e.g. GPIOs).
6. `wifi.json`: atomic replacement via `.tmp`; stable network IDs (file-format doc §4).
7. Check whether the 401 can omit `WWW-Authenticate` (§8.1).

## 12. Maybe-TBD / future reminders

- **ETag / `If-Match`** on config files to prevent two browsers overwriting each other. Omitted for now (unlikely, complicates code).
- ESP-side validation of calibration files (needs decompression).
- Further compressed WebUI data files (e.g. `checkweighings.json`).
- ESP using calibration files, e.g. weight-based warnings on the device.
- Aggregate (multi-sensor) history responses.
- HTTPS/TLS.

## 13. Open points

1. Calibration `DELETE` protection (v0.2 says unprotected; WebUI assumes protected).
2. History query/response names in §4 (proposal) and `format` negotiation.
3. `device` and `sensor_error` event payloads; device-log content.
4. Sample-flag bit assignments.
5. Whether `/api/status` can carry `configRevision`, `pendingChanges`, `oldestId` per sensor.
